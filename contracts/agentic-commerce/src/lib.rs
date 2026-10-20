#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, Env, IntoVal, String, Vec,
};

/// Contract-level error codes for agentic-commerce (#323, #541).
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    /// client == provider: a client cannot escrow funds to themselves.
    SelfEscrow = 1,
    /// provider == evaluator: the party delivering work cannot also approve it.
    InvalidParties = 2,
    /// The contract is paused; no state-changing operations are allowed.
    ContractPaused = 3,
    /// The job's current status does not permit the requested operation.
    InvalidStatus = 4,
    /// No job exists for the given id.
    JobNotFound = 5,
    /// Caller is not the job's client.
    NotClient = 6,
    /// Caller is not the job's provider.
    NotProvider = 7,
    /// Caller is not the job's evaluator.
    NotEvaluator = 8,
    /// Caller is not the contract admin.
    NotAdmin = 9,
    /// The token address is not on the approved whitelist.
    UnsupportedToken = 10,
    /// #706 — the evaluator-asserted deliverable content hash does not match
    /// the hash committed by the provider at submission time.
    HashMismatch = 11,
    /// The requested batch is empty or exceeds the supported size.
    BatchTooLarge = 12,
    /// A path-payment router exceeded the client's maximum input amount.
    SlippageExceeded = 13,
}

/// Lifecycle states for a job escrow.
///
/// Soroban encodes enum variants as sequential `u32` discriminants in XDR and
/// in the value returned by `get_job()`. The mapping is:
///
/// | Variant     | u32 |
/// |-------------|-----|
/// | Open        | 0   |
/// | Funded      | 1   |
/// | Submitted   | 2   |
/// | Completed   | 3   |
/// | Rejected    | 4   |
/// | Cancelled   | 5   |
/// | Disputed    | 6   |
///
/// SDK consumers that receive the raw XDR integer should use this table to
/// map the value to a human-readable status string. Future variants will be
/// appended at the end and will receive the next sequential u32.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum JobStatus {
    /// 0 — created but not yet funded (reserved for future use; jobs currently
    /// start directly in `Funded` after `create_job` pulls the escrow deposit).
    Open,
    /// 1 — escrow deposit received; waiting for provider to submit deliverable.
    Funded,
    /// 2 — provider has submitted a deliverable URI; waiting for evaluator approval.
    Submitted,
    /// 3 — evaluator approved; provider and treasury have been paid out.
    Completed,
    /// 4 — evaluator rejected the deliverable (reserved; not yet used in current state machine).
    Rejected,
    /// 5 — job was cancelled by the client or timed out; budget refunded.
    Cancelled,
    /// 6 — client has opened a dispute on the submitted deliverable (#22).
    /// Evaluator must still call complete() or client can call cancel() to resolve.
    Disputed,
}

/// A job escrowed in the commerce contract.
#[derive(Clone)]
#[contracttype]
pub struct Job {
    pub id: u64,
    pub client: Address,
    pub provider: Address,
    pub evaluator: Address,
    pub token: Address,
    pub budget: i128,
    /// Cumulative amount already paid out from the escrow (e.g. partial
    /// settlements if the state machine is extended in a future version).
    /// `cancel()` refunds `budget - released` so it never over-refunds.
    pub released: i128,
    pub status: JobStatus,
    pub description: String,
    pub deliverable: String,
    /// #706 — SHA-256 content hash of the deliverable payload, committed by
    /// the provider at `submit()` time. Immutable once set: `complete()` can
    /// only assert equality against it, never overwrite it.
    pub deliverable_hash: soroban_sdk::BytesN<32>,
    pub funded_at: u64,
    pub created_at: u64,
    pub updated_at: u64,
    /// #23 — fee_bps snapshotted at job creation so admin changes to the
    /// global fee rate do not retroactively affect already-funded jobs.
    pub fee_bps: u32,
    /// #716 — SLA deadline (ledger timestamp). 0 means no SLA is configured.
    pub sla_deadline: u64,
    /// #716 — penalty in basis points charged per full hour of overdue
    /// submission. 0 means no penalty is configured.
    pub penalty_bps_per_hour: u32,
    /// #716 — ledger timestamp recorded when the provider submitted the
    /// deliverable. 0 until `submit()` is called.
    pub submitted_at: u64,
}

/// Evaluator quorum stored separately from `Job` to preserve existing job XDR.
///
/// #704 — Supports weighted voting: each evaluator may carry a distinct
/// weight (`evaluator_weights`), and completion is triggered once the sum of
/// the weights of approving evaluators (`accumulated_weight`) reaches
/// `threshold`. For unweighted jobs created via `create_job_multi_eval`, every
/// evaluator is assigned weight 1 and `total_weight == evaluators.len()`, so
/// the weighted logic degenerates to the original 1-evaluator-1-vote quorum.
#[contracttype]
#[derive(Clone)]
pub struct JobEvaluators {
    pub evaluators: Vec<Address>,
    pub threshold: u32,
    pub approvals: soroban_sdk::Map<Address, bool>,
    /// #704 — per-evaluator voting weight. Absent entries are treated as 0.
    pub evaluator_weights: soroban_sdk::Map<Address, u32>,
    /// #704 — sum of all evaluator weights, validated at job creation.
    pub total_weight: u32,
    /// #704 — running sum of weights of evaluators that have approved.
    pub accumulated_weight: u32,
}

/// Monotonic payment commitment signed by the payer's channel key.
#[contracttype]
#[derive(Clone)]
pub struct ChannelVoucher {
    pub channel_id: u64,
    pub amount: i128,
    pub nonce: u64,
}

/// Escrowed one-way payment channel with a payer-selected voucher key.
#[contracttype]
#[derive(Clone)]
pub struct PaymentChannel {
    pub id: u64,
    pub payer: Address,
    pub provider: Address,
    pub token: Address,
    pub deposit: i128,
    pub amount: i128,
    pub nonce: u64,
    pub opened_at: u64,
    pub closing_at: u64,
    pub voucher_key: soroban_sdk::BytesN<32>,
}

/// Metadata stored for each whitelisted token.
#[contracttype]
#[derive(Clone)]
pub struct TokenInfo {
    pub token: Address,
    /// Number of decimal places for this token (e.g. 7 for XLM/USDC on Stellar).
    pub decimals: u32,
    /// Normalization factor relative to 7-decimal base: 10^(7 - decimals).
    /// For 7-decimal tokens this is 1; for 6-decimal tokens this is 10.
    pub normalization_factor: i128,
}

/// A single job request within a batch (#698).
///
/// Mirrors the per-job arguments of `create_job` so an agent orchestrator can
/// escrow funds for multiple specialized worker agents in one atomic call.
#[contracttype]
#[derive(Clone)]
pub struct JobRequest {
    pub provider: Address,
    pub evaluator: Address,
    pub token: Address,
    pub budget: i128,
    pub description: String,
}

/// A single milestone within a milestone-based escrow job.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Milestone {
    /// Zero-based index within the job's milestone list.
    pub index: u32,
    /// Amount allocated for this milestone in token smallest units.
    pub amount: i128,
    /// Human-readable description of this milestone's deliverable.
    pub description: String,
    /// Submitted deliverable URI (empty until provider calls submit_milestone).
    pub deliverable: String,
    /// True once the evaluator has approved and payment has been released.
    pub approved: bool,
}

#[contracttype]
enum DataKey {
    NextId,
    Job(u64),
    Treasury,
    Admin,
    FeeBps,
    Version,
    /// #29 — emergency pause flag. Stored as bool; absent == not paused.
    Paused,
    NextChannelId,
    Evaluators(u64),
    Channel(u64),
    MultiEvalThreshold,
    /// Persistent milestone list for a milestone-based job.
    Milestones(u64),
    /// Stores TokenInfo for each whitelisted token address.
    AllowedToken(Address),
    /// Ordered list of whitelisted token addresses for enumeration.
    AllowedTokenList,
    /// #713 — address of the AMM/DEX router contract used for path payments.
    AmmRouter,
}

const DEFAULT_FEE_BPS: u32 = 100; // 1%
const MAX_FEE_BPS: u32 = 500; // 5% hard cap
const BPS_DENOM: i128 = 10_000;
const REFUND_TIMEOUT_SECS: u64 = 7 * 24 * 3600; // 7 days
/// #25 — minimum budget to prevent zero/dust jobs that waste storage and spam events.
const MIN_BUDGET: i128 = 1;
/// #619 — maximum deliverable URI length to prevent storage griefing.
const MAX_DELIVERABLE_LEN: u32 = 1024;
/// #706 — maximum metadata URI length accepted alongside a content hash.
const MAX_METADATA_URI_LEN: u32 = 1024;
const MAX_EVALUATORS: u32 = 5;
const DEFAULT_MULTI_EVAL_THRESHOLD: i128 = i128::MAX;
const CHANNEL_DISPUTE_WINDOW_SECS: u64 = 24 * 60 * 60;
const SECS_PER_HOUR: u64 = 60 * 60;
const MAX_SLA_PENALTY_BPS: u32 = 5_000;
/// #698 — maximum number of jobs that may be created in a single atomic batch.
const MAX_BATCH_SIZE: u32 = 10;

// --- Events ---

/// Emitted when the contract is successfully initialized.
#[contractevent]
pub struct Initialized {
    #[topic]
    pub admin: Address,
    pub treasury: Address,
}

/// Emitted when a job is created and funded.
#[contractevent]
pub struct JobCreated {
    #[topic]
    pub client: Address,
    pub job_id: u64,
    pub budget: i128,
}

/// #698 — Emitted when a batch of jobs is created and funded atomically.
#[contractevent]
pub struct BatchJobsCreated {
    #[topic]
    pub client: Address,
    pub job_ids: Vec<u64>,
}

/// Emitted when the provider submits a deliverable.
///
/// #706 — `deliverable_hash` is emitted as a topic so off-chain indexers can
/// independently verify that the content they fetched matches the on-chain
/// commitment, and detect any post-approval mutation of the deliverable.
#[contractevent]
pub struct JobSubmitted {
    #[topic]
    pub provider: Address,
    #[topic]
    pub deliverable_hash: soroban_sdk::BytesN<32>,
    pub job_id: u64,
}

/// Emitted when a job completes and funds are released.
///
/// `provider` is included so off-chain indexers and analytics can attribute
/// the payout to the correct recipient without a separate `get_job` lookup
/// (#27).
#[contractevent]
pub struct JobCompleted {
    #[topic]
    pub evaluator: Address,
    pub job_id: u64,
    /// The provider address that received the payout.
    pub provider: Address,
    pub payout: i128,
    pub fee: i128,
    pub timestamp: u64,
}

/// Emitted when a provider claims payout after evaluator timeout (claim_expired).
#[contractevent]
pub struct JobExpired {
    #[topic]
    pub provider: Address,
    pub job_id: u64,
    pub payout: i128,
    pub fee: i128,
    pub timestamp: u64,
}

/// Emitted when a buyer claims a refund after provider timeout.
#[contractevent]
pub struct JobRefunded {
    #[topic]
    pub client: Address,
    pub job_id: u64,
}

/// Emitted when a job is cancelled and refunded.
#[contractevent]
pub struct JobCancelled {
    #[topic]
    pub client: Address,
    pub job_id: u64,
}

/// #716 — Emitted when an SLA breach penalty is deducted from the provider
/// payout and returned to the client.
#[contractevent]
pub struct SlaPenaltyApplied {
    #[topic]
    pub job_id: u64,
    pub overdue_hours: u64,
    pub penalty_bps: u32,
    pub penalty: i128,
}

/// #22 — Emitted when a client opens a dispute on a submitted deliverable.
#[contractevent]
pub struct JobDisputed {
    #[topic]
    pub client: Address,
    pub job_id: u64,
    pub timestamp: u64,
}

/// Emitted when the contract is emergency-paused.
#[contractevent]
pub struct Paused {
    #[topic]
    pub admin: Address,
    pub timestamp: u64,
}

/// Emitted when the contract is unpaused.
#[contractevent]
pub struct Unpaused {
    #[topic]
    pub admin: Address,
    pub timestamp: u64,
}

/// Emitted when an admin adds a token to the whitelist.
#[contractevent]
pub struct TokenWhitelisted {
    #[topic]
    pub admin: Address,
    pub token: Address,
    pub decimals: u32,
}

/// Emitted when an admin removes a token from the whitelist.
#[contractevent]
pub struct TokenRemoved {
    #[topic]
    pub admin: Address,
    pub token: Address,
}

/// Emitted when admin/treasury are updated via `re_init`.
#[contractevent]
pub struct ReInitialized {
    #[topic]
    pub admin: Address,
    pub new_admin: Address,
    pub new_treasury: Address,
}

/// Emitted when a milestone-based job is created.
#[contractevent]
pub struct MilestoneJobCreated {
    #[topic]
    pub client: Address,
    pub job_id: u64,
    pub budget: i128,
    pub milestone_count: u32,
}

/// Emitted when a provider submits a milestone deliverable.
#[contractevent]
pub struct MilestoneSubmitted {
    #[topic]
    pub provider: Address,
    pub job_id: u64,
    pub milestone_index: u32,
}

/// Emitted when an evaluator approves a milestone and releases partial funds.
#[contractevent]
pub struct MilestoneApproved {
    #[topic]
    pub evaluator: Address,
    pub job_id: u64,
    pub milestone_index: u32,
    pub payout: i128,
    pub fee: i128,
}

/// Emitted when a client cancels remaining uncompleted milestones and gets a refund.
#[contractevent]
pub struct MilestonesPartialCancelled {
    #[topic]
    pub client: Address,
    pub job_id: u64,
    pub refund: i128,
}

/// #713 — Emitted when a job is funded via a cross-currency path payment swap.
#[contractevent]
pub struct SwapFunded {
    #[topic]
    pub client: Address,
    pub job_id: u64,
    /// The token the client paid with (e.g. XLM).
    pub input_token: Address,
    /// The token the escrow was funded in (e.g. USDC).
    pub target_token: Address,
    /// Amount of `input_token` actually consumed by the swap.
    pub input_spent: i128,
    /// Amount of `input_token` refunded to the client (unspent remainder).
    pub refund: i128,
    /// The full target budget locked into escrow.
    pub budget: i128,
}

#[contractevent]
pub struct ChannelOpened {
    #[topic]
    pub payer: Address,
    pub channel_id: u64,
    pub provider: Address,
    pub deposit: i128,
}

#[contractevent]
pub struct ChannelClosing {
    #[topic]
    pub actor: Address,
    pub channel_id: u64,
    pub amount: i128,
    pub challenge_until: u64,
}

#[contractevent]
pub struct ChannelSettled {
    #[topic]
    pub channel_id: u64,
    pub amount: i128,
    pub refund: i128,
}

#[contractevent]
pub struct JobApproved {
    #[topic]
    pub evaluator: Address,
    pub job_id: u64,
    pub approvals: u32,
    pub threshold: u32,
}

#[contract]
pub struct AgenticCommerceContract;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

impl AgenticCommerceContract {
    /// Panics with `ContractPaused` if the `Paused` flag is set. Call this at
    /// the top of every state-changing entry point (#29).
    fn require_not_paused(env: &Env) {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            panic_with_error!(env, Error::ContractPaused);
        }
    }

    /// Compute the platform fee for a given budget using safe arithmetic (#28, #539).
    ///
    /// We multiply first (`budget * fee_bps`) before dividing by `BPS_DENOM`
    /// so that micro-budgets smaller than 10,000 atomic units still produce a
    /// non-zero fee when one is due.  For example, a budget of 5,000 with
    /// `fee_bps = 100` (1%) gives `5_000 * 100 / 10_000 = 50`, whereas the
    /// old divide-first approach returned 0.
    ///
    /// Overflow safety: `budget * fee_bps` uses `checked_mul`.  The maximum
    /// safe budget before overflow is `i128::MAX / MAX_FEE_BPS (500)` ≈
    /// 6.8 × 10^35, which is far beyond any realistic token amount on Stellar
    /// (total XLM supply is ~50 × 10^9 with 7 decimal places, i.e. ~5 × 10^16
    /// stroops). `checked_mul` panics with "fee overflow" if this is ever hit.
    ///
    /// Minimum fee floor: if `budget > 0` and `fee_bps > 0` but the integer
    /// division still rounds down to 0 (i.e. `budget * fee_bps < BPS_DENOM`),
    /// we return 1 so micro-jobs never get a completely free ride.
    fn compute_fee(budget: i128, fee_bps: u32) -> i128 {
        if budget <= 0 || fee_bps == 0 {
            return 0;
        }
        let numerator = budget
            .checked_mul(fee_bps as i128)
            .expect("fee overflow");
        let fee = numerator / BPS_DENOM;
        // Minimum 1-unit floor: if the proportional fee rounded to zero,
        // charge at least 1 atomic unit so there is no unintentional free ride.
        if fee == 0 { 1 } else { fee }
    }

    /// #716 — Compute the SLA penalty for a job given its submission time.
    ///
    /// Returns `(overdue_hours, penalty_bps, penalty_amount)`. When there is no
    /// SLA configured, the submission was on time, or no penalty rate is set,
    /// all values are zero. Any partial hour overdue rounds up to a full hour.
    /// The accumulated penalty is capped at `MAX_SLA_PENALTY_BPS` (50%).
    fn compute_sla_penalty(job: &Job) -> (u64, u32, i128) {
        if job.sla_deadline == 0
            || job.penalty_bps_per_hour == 0
            || job.submitted_at <= job.sla_deadline
        {
            return (0, 0, 0);
        }
        let overdue_secs = job.submitted_at - job.sla_deadline;
        // Round up to at least one full hour for any partial hour overdue.
        let overdue_hours = (overdue_secs + SECS_PER_HOUR - 1) / SECS_PER_HOUR;
        let raw_bps = overdue_hours
            .checked_mul(job.penalty_bps_per_hour as u64)
            .unwrap_or(u64::MAX);
        let penalty_bps = if raw_bps > MAX_SLA_PENALTY_BPS as u64 {
            MAX_SLA_PENALTY_BPS
        } else {
            raw_bps as u32
        };
        let penalty = job
            .budget
            .checked_mul(penalty_bps as i128)
            .expect("sla penalty overflow")
            / BPS_DENOM;
        (overdue_hours, penalty_bps, penalty)
    }

    fn voucher_message(env: &Env, voucher: &ChannelVoucher) -> soroban_sdk::Bytes {
        let mut message = soroban_sdk::Bytes::from_slice(env, b"BEAR_CHANNEL_V1");
        message.extend_from_array(&voucher.channel_id.to_be_bytes());
        message.extend_from_array(&voucher.amount.to_be_bytes());
        message.extend_from_array(&voucher.nonce.to_be_bytes());
        message
    }

    fn verify_voucher(
        env: &Env,
        channel: &PaymentChannel,
        voucher: &ChannelVoucher,
        signature: &soroban_sdk::BytesN<64>,
    ) {
        if voucher.channel_id != channel.id || voucher.amount < 0 || voucher.amount > channel.deposit {
            panic!("invalid channel voucher");
        }
        env.crypto().ed25519_verify(
            &channel.voucher_key,
            &Self::voucher_message(env, voucher),
            signature,
        );
    }
}

#[contractimpl]
impl AgenticCommerceContract {
    /// Initializer. Sets admin, treasury, default fee (1%), and job id counter.
    /// Panics if the contract has already been initialized — use `re_init` to
    /// update admin or treasury after the first init.
    ///
    /// Emits an `Initialized` event (#31) so off-chain indexers can detect
    /// when and by whom the contract was set up.
    pub fn init(env: Env, admin: Address, treasury: Address) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        // #24 — reject zero/default treasury at init time.
        let zero_address = Address::from_str(&env, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
        if treasury == zero_address {
            panic!("treasury cannot be zero address");
        }
        env.storage().instance().set(&DataKey::NextId, &1u64);
        env.storage().instance().set(&DataKey::NextChannelId, &1u64);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::FeeBps, &DEFAULT_FEE_BPS);
        env.storage()
            .instance()
            .set(&DataKey::MultiEvalThreshold, &DEFAULT_MULTI_EVAL_THRESHOLD);

        // #31 — emit Initialized event so indexers can track contract setup.
        Initialized {
            admin,
            treasury,
        }
        .publish(&env);
    }

    /// Re-initialize admin and treasury. Only the current admin may call this.
    /// Preserves existing `fee_bps` and `next_id` so in-flight jobs are not
    /// disrupted. Emits a `ReInitialized` event.
    pub fn re_init(env: Env, caller: Address, new_admin: Address, new_treasury: Address) {
        caller.require_auth();
        let current_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != current_admin {
            panic_with_error!(&env, Error::NotAdmin);
        }
        // #24 — reject zero/default treasury on re-init as well.
        let zero_address = Address::from_str(&env, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
        if new_treasury == zero_address {
            panic!("treasury cannot be zero address");
        }
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().set(&DataKey::Treasury, &new_treasury);

        ReInitialized {
            admin: caller,
            new_admin,
            new_treasury,
        }
        .publish(&env);
    }

    // -----------------------------------------------------------------------
    // #536 — contract upgrade entry point
    // -----------------------------------------------------------------------

    /// Upgrade the contract's WASM executable to a new hash.
    ///
    /// Only the current admin may call this. All persistent storage (jobs,
    /// balances, etc.) is preserved across an upgrade; only the executable
    /// code is replaced. The new WASM takes effect for all future invocations.
    ///
    /// # Panics
    /// - `"not initialized"` if `init()` has never been called.
    /// - `"not admin"` if `admin` does not match the stored admin.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: soroban_sdk::BytesN<32>) {
        admin.require_auth();
        let current_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != current_admin {
            panic_with_error!(&env, Error::NotAdmin);
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    // -----------------------------------------------------------------------
    // #29 — Emergency pause / unpause
    // -----------------------------------------------------------------------

    /// Admin-only: halt all state-changing entry points immediately.
    /// Emits a `Paused` event. Idempotent (pausing an already-paused contract
    /// is a no-op that still succeeds and still emits the event).
    pub fn emergency_pause(env: Env, caller: Address) {
        caller.require_auth();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic_with_error!(&env, Error::NotAdmin);
        }
        env.storage().instance().set(&DataKey::Paused, &true);
        Paused {
            admin: caller,
            timestamp: env.ledger().timestamp(),
        }
        .publish(&env);
    }

    /// Admin-only: resume normal contract operation.
    /// Emits an `Unpaused` event. Idempotent.
    pub fn emergency_unpause(env: Env, caller: Address) {
        caller.require_auth();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic_with_error!(&env, Error::NotAdmin);
        }
        env.storage().instance().set(&DataKey::Paused, &false);
        Unpaused {
            admin: caller,
            timestamp: env.ledger().timestamp(),
        }
        .publish(&env);
    }

    // -----------------------------------------------------------------------
    // Core state-changing entry points (all guarded by require_not_paused)
    // -----------------------------------------------------------------------

    /// Create a job and escrow `budget` from the `client_addr` into the contract.
    /// Returns the assigned sequential job id.
    ///
    /// # Pre-approval required
    ///
    /// This function pulls `budget` tokens from `client_addr` into the contract
    /// using a direct `transfer` call on the Stellar Asset Contract (SAC).
    /// Because SAC's `transfer` requires the sender to authorise the call,
    /// **the client must invoke `token.approve(contract_address, budget)`
    /// (or `increaseAllowance`) before calling `create_job`**.
    ///
    /// SDK callers should use `CommerceClient.approveAndCreateJob(...)`, which
    /// handles the two-step approve + create_job flow automatically in a single
    /// RPC round-trip.  If you call `create_job` directly without a prior
    /// approval the transaction will fail with an auth error from the token
    /// contract.
    pub fn create_job(
        env: Env,
        client_addr: Address,
        provider: Address,
        evaluator: Address,
        token: Address,
        budget: i128,
        description: String,
        sla_deadline: u64,
        penalty_bps_per_hour: u32,
    ) -> u64 {
        Self::require_not_paused(&env); // #29
        client_addr.require_auth();
        if !env.storage().instance().has(&DataKey::Admin) {
            panic!("not initialized");
        }
        // #25 — reject zero/dust budgets that waste storage and emit spam events.
        if budget < MIN_BUDGET {
            panic!("budget below minimum");
        }
        let multi_eval_threshold: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MultiEvalThreshold)
            .unwrap_or(DEFAULT_MULTI_EVAL_THRESHOLD);
        if budget > multi_eval_threshold {
            panic!("high-value job requires multiple evaluators");
        }
        // Party validation (#323): prevent self-escrow and invalid party
        // combinations before any storage reads or token transfers.
        if client_addr == provider {
            panic_with_error!(&env, Error::SelfEscrow);
        }
        if provider == evaluator {
            panic_with_error!(&env, Error::InvalidParties);
        }
        // #694 — reject tokens not on the approved whitelist.
        // If no tokens have been whitelisted yet (e.g. fresh deploy), the check
        // is skipped so the contract can still be used before whitelist setup.
        if env.storage().instance().has(&DataKey::AllowedToken(token.clone())) == false {
            let list: Vec<Address> = env
                .storage()
                .instance()
                .get(&DataKey::AllowedTokenList)
                .unwrap_or_else(|| Vec::new(&env));
            if !list.is_empty() {
                panic_with_error!(&env, Error::UnsupportedToken);
            }
        }

        let next: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u64);

        // #23 — snapshot the current fee_bps so future admin changes don't
        // retroactively affect this job when complete() runs.
        let snapshotted_fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FeeBps)
            .unwrap_or(DEFAULT_FEE_BPS);

        // Pull funds into contract escrow.
        let token_client = token::TokenClient::new(&env, &token);
        let contract_addr = env.current_contract_address();
        // Sanity check (#17): `balance()` panics if `token` isn't a real SAC,
        // failing fast here instead of with a confusing error later.
        token_client.balance(&contract_addr);
        token_client.transfer(&client_addr, &contract_addr, &budget);

        let now = env.ledger().timestamp();
        let job = Job {
            id: next,
            client: client_addr.clone(),
            provider,
            evaluator,
            token,
            budget,
            released: 0,
            status: JobStatus::Funded,
            description,
            deliverable: String::from_str(&env, ""),
            // #706 — zero hash until the provider commits a real content hash.
            deliverable_hash: soroban_sdk::BytesN::from_array(&env, &[0u8; 32]),
            funded_at: now,
            created_at: now,
            updated_at: now,
            fee_bps: snapshotted_fee_bps, // #23
            sla_deadline,                 // #716
            penalty_bps_per_hour,         // #716
            submitted_at: 0,              // #716
        };
        env.storage().persistent().set(&DataKey::Job(next), &job);
        env.storage().instance().set(&DataKey::NextId, &(next + 1));

        JobCreated {
            client: client_addr,
            job_id: next,
            budget,
        }
        .publish(&env);

        next
    }

    /// Create and fund multiple jobs in a single atomic transaction (#698).
    ///
    /// Agent orchestrators frequently dispatch tasks to a swarm of sub-agents
    /// (e.g. namer, researcher, copywriter). This entry point lets them escrow
    /// funds for all of those workers in one call, avoiding N base fees,
    /// sequential ledger waits, and partial-failure states.
    ///
    /// # Atomicity
    ///
    /// The whole invocation is a single Soroban transaction: if any individual
    /// request fails validation, or any token transfer fails (e.g. insufficient
    /// allowance), the entire batch reverts and no job is created.
    ///
    /// # Bulk funding
    ///
    /// Budgets are aggregated per token contract and a single `transfer` is
    /// performed per distinct token, pulling the summed budget from `client`
    /// into the contract escrow. The client must pre-approve the contract for
    /// at least the aggregated amount of each token used.
    ///
    /// # Panics
    /// - `BatchTooLarge` if `requests` is empty or longer than `MAX_BATCH_SIZE`.
    /// - `SelfEscrow` / `InvalidParties` / `UnsupportedToken` for invalid requests.
    /// - `"budget below minimum"` if any request's budget is below `MIN_BUDGET`.
    pub fn batch_create_jobs(
        env: Env,
        client: Address,
        requests: Vec<JobRequest>,
    ) -> Vec<u64> {
        Self::require_not_paused(&env); // #29
        client.require_auth();
        if !env.storage().instance().has(&DataKey::Admin) {
            panic!("not initialized");
        }
        // (2) Reject empty batches and batches larger than the cap.
        if requests.is_empty() || requests.len() > MAX_BATCH_SIZE {
            panic_with_error!(&env, Error::BatchTooLarge);
        }

        let multi_eval_threshold: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MultiEvalThreshold)
            .unwrap_or(DEFAULT_MULTI_EVAL_THRESHOLD);
        let snapshotted_fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FeeBps)
            .unwrap_or(DEFAULT_FEE_BPS);
        let next_start: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u64);

        // (3) Validate every request before any state change or transfer so a
        // bad request reverts the whole batch.
        // (4) Aggregate budgets per token for a single bulk transfer each.
        let mut tokens: Vec<Address> = Vec::new(&env);
        let mut totals: Vec<i128> = Vec::new(&env);
        let mut index = 0u32;
        while index < requests.len() {
            let req = requests.get(index).unwrap();
            if req.budget < MIN_BUDGET {
                panic!("budget below minimum");
            }
            if req.budget > multi_eval_threshold {
                panic!("high-value job requires multiple evaluators");
            }
            if client == req.provider {
                panic_with_error!(&env, Error::SelfEscrow);
            }
            if req.provider == req.evaluator {
                panic_with_error!(&env, Error::InvalidParties);
            }
            // #694 — reject tokens not on the approved whitelist. If no tokens
            // have been whitelisted yet the check is skipped, matching create_job.
            if env.storage().instance().has(&DataKey::AllowedToken(req.token.clone())) == false {
                let list: Vec<Address> = env
                    .storage()
                    .instance()
                    .get(&DataKey::AllowedTokenList)
                    .unwrap_or_else(|| Vec::new(&env));
                if !list.is_empty() {
                    panic_with_error!(&env, Error::UnsupportedToken);
                }
            }
            // Accumulate the per-token total.
            let mut found = false;
            let mut t = 0u32;
            while t < tokens.len() {
                if tokens.get(t).unwrap() == req.token {
                    let updated = totals
                        .get(t)
                        .unwrap()
                        .checked_add(req.budget)
                        .expect("batch budget overflow");
                    totals.set(t, updated);
                    found = true;
                    break;
                }
                t += 1;
            }
            if !found {
                tokens.push_back(req.token.clone());
                totals.push_back(req.budget);
            }
            index += 1;
        }

        // (4) One bulk transfer per distinct token, client -> contract escrow.
        let contract_addr = env.current_contract_address();
        let mut t = 0u32;
        while t < tokens.len() {
            let token_addr = tokens.get(t).unwrap();
            let total = totals.get(t).unwrap();
            let token_client = token::TokenClient::new(&env, &token_addr);
            // Sanity check (#17): `balance()` panics if `token` isn't a real SAC.
            token_client.balance(&contract_addr);
            token_client.transfer(&client, &contract_addr, &total);
            t += 1;
        }

        // (5) Store each job with a fresh sequential id and Funded status.
        let now = env.ledger().timestamp();
        let mut job_ids: Vec<u64> = Vec::new(&env);
        let mut offset = 0u64;
        let mut index = 0u32;
        while index < requests.len() {
            let req = requests.get(index).unwrap();
            let id = next_start + offset;
            let job = Job {
                id,
                client: client.clone(),
                provider: req.provider,
                evaluator: req.evaluator,
                token: req.token,
                budget: req.budget,
                released: 0,
                status: JobStatus::Funded,
                description: req.description,
                deliverable: String::from_str(&env, ""),
                deliverable_hash: soroban_sdk::BytesN::from_array(&env, &[0u8; 32]),
                funded_at: now,
                created_at: now,
                updated_at: now,
                fee_bps: snapshotted_fee_bps, // #23
                sla_deadline: 0,
                penalty_bps_per_hour: 0,
                submitted_at: 0,
            };
            env.storage().persistent().set(&DataKey::Job(id), &job);
            job_ids.push_back(id);
            offset += 1;
            index += 1;
        }
        env.storage()
            .instance()
            .set(&DataKey::NextId, &(next_start + offset));

        // (6) Emit the batch event with the assigned job ids.
        BatchJobsCreated {
            client,
            job_ids: job_ids.clone(),
        }
        .publish(&env);

        job_ids
    }

    /// Create and fund a high-value job with an explicit evaluator quorum.
    ///
    /// #704 — Backward-compatible unweighted path: every evaluator is assigned
    /// weight 1, so `total_weight == evaluators.len()` and the weighted
    /// threshold check degenerates to the original raw-count quorum.
    #[allow(clippy::too_many_arguments)]
    pub fn create_job_multi_eval(
        env: Env,
        client_addr: Address,
        provider: Address,
        evaluators: Vec<Address>,
        threshold: u32,
        token: Address,
        budget: i128,
        description: String,
        sla_deadline: u64,
        penalty_bps_per_hour: u32,
    ) -> u64 {
        Self::require_not_paused(&env);
        client_addr.require_auth();
        if !env.storage().instance().has(&DataKey::Admin) {
            panic!("not initialized");
        }
        if budget < MIN_BUDGET {
            panic!("budget below minimum");
        }
        let multi_eval_threshold: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MultiEvalThreshold)
            .unwrap_or(DEFAULT_MULTI_EVAL_THRESHOLD);
        if budget <= multi_eval_threshold {
            panic!("job does not meet multi-evaluator threshold");
        }
        if evaluators.is_empty()
            || evaluators.len() > MAX_EVALUATORS
            || threshold == 0
            || threshold > evaluators.len()
        {
            panic!("invalid evaluator quorum");
        }
        if provider == client_addr {
            panic_with_error!(&env, Error::SelfEscrow);
        }
        let mut index = 0u32;
        while index < evaluators.len() {
            let evaluator = evaluators.get(index).unwrap();
            if evaluator == provider {
                panic_with_error!(&env, Error::InvalidParties);
            }
            let mut previous = 0;
            while previous < index {
                if evaluators.get(previous).unwrap() == evaluator {
                    panic!("duplicate evaluator");
                }
                previous += 1;
            }
            index += 1;
        }

        // #694 — reject tokens not on the approved whitelist.
        // If no tokens have been whitelisted yet (e.g. fresh deploy), the check
        // is skipped so the contract can still be used before whitelist setup.
        if env.storage().instance().has(&DataKey::AllowedToken(token.clone())) == false {
            let list: Vec<Address> = env
                .storage()
                .instance()
                .get(&DataKey::AllowedTokenList)
                .unwrap_or_else(|| Vec::new(&env));
            if !list.is_empty() {
                panic_with_error!(&env, Error::UnsupportedToken);
            }
        }

        let next: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u64);
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FeeBps)
            .unwrap_or(DEFAULT_FEE_BPS);
        let token_client = token::TokenClient::new(&env, &token);
        let contract_addr = env.current_contract_address();
        token_client.balance(&contract_addr);
        token_client.transfer(&client_addr, &contract_addr, &budget);

        let now = env.ledger().timestamp();
        let primary_evaluator = evaluators.get(0).unwrap();
        let job = Job {
            id: next,
            client: client_addr.clone(),
            provider,
            evaluator: primary_evaluator,
            token,
            budget,
            released: 0,
            status: JobStatus::Funded,
            description,
            deliverable: String::from_str(&env, ""),
            // #706 — zero hash until the provider commits a real content hash.
            deliverable_hash: soroban_sdk::BytesN::from_array(&env, &[0u8; 32]),
            funded_at: now,
            created_at: now,
            updated_at: now,
            fee_bps,
            sla_deadline,         // #716
            penalty_bps_per_hour, // #716
            submitted_at: 0,      // #716
        };
        env.storage().persistent().set(&DataKey::Job(next), &job);
        // #704 — assign weight 1 to every evaluator for the unweighted path.
        let mut weights: soroban_sdk::Map<Address, u32> = soroban_sdk::Map::new(&env);
        let mut widx = 0u32;
        while widx < evaluators.len() {
            weights.set(evaluators.get(widx).unwrap(), 1u32);
            widx += 1;
        }
        let total_weight = evaluators.len();
        env.storage().persistent().set(
            &DataKey::Evaluators(next),
            &JobEvaluators {
                evaluators,
                threshold,
                approvals: soroban_sdk::Map::new(&env),
                evaluator_weights: weights,
                total_weight,
                accumulated_weight: 0,
            },
        );
        env.storage().instance().set(&DataKey::NextId, &(next + 1));
        JobCreated {
            client: client_addr,
            job_id: next,
            budget,
        }
        .publish(&env);
        next
    }

    /// #704 — Create and fund a job with a weighted evaluator quorum.
    ///
    /// `weights[i]` is the voting weight of `evaluators[i]`. Each weight must
    /// be strictly positive, and the sum of all weights (`total_weight`) must
    /// be at least `weight_threshold` so the quorum is actually reachable.
    /// Completion is triggered once the accumulated weight of approving
    /// evaluators reaches `weight_threshold`.
    #[allow(clippy::too_many_arguments)]
    pub fn create_job_multi_eval_weighted(
        env: Env,
        client_addr: Address,
        provider: Address,
        evaluators: Vec<Address>,
        weights: Vec<u32>,
        weight_threshold: u32,
        token: Address,
        budget: i128,
        description: String,
    ) -> u64 {
        Self::require_not_paused(&env);
        client_addr.require_auth();
        if !env.storage().instance().has(&DataKey::Admin) {
            panic!("not initialized");
        }
        if budget < MIN_BUDGET {
            panic!("budget below minimum");
        }
        let multi_eval_threshold: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MultiEvalThreshold)
            .unwrap_or(DEFAULT_MULTI_EVAL_THRESHOLD);
        if budget <= multi_eval_threshold {
            panic!("job does not meet multi-evaluator threshold");
        }
        if evaluators.is_empty()
            || evaluators.len() > MAX_EVALUATORS
            || weights.len() != evaluators.len()
            || weight_threshold == 0
        {
            panic!("invalid evaluator quorum");
        }
        if provider == client_addr {
            panic_with_error!(&env, Error::SelfEscrow);
        }
        // Validate evaluators: no provider, no duplicates, and build the
        // weight map while summing total weight.
        let mut weight_map: soroban_sdk::Map<Address, u32> = soroban_sdk::Map::new(&env);
        let mut total_weight: u32 = 0;
        let mut index = 0u32;
        while index < evaluators.len() {
            let evaluator = evaluators.get(index).unwrap();
            if evaluator == provider {
                panic_with_error!(&env, Error::InvalidParties);
            }
            let weight = weights.get(index).unwrap();
            if weight == 0 {
                panic!("evaluator weight must be positive");
            }
            let mut previous = 0;
            while previous < index {
                if evaluators.get(previous).unwrap() == evaluator {
                    panic!("duplicate evaluator");
                }
                previous += 1;
            }
            weight_map.set(evaluator, weight);
            total_weight = total_weight
                .checked_add(weight)
                .expect("total weight overflow");
            index += 1;
        }
        // Acceptance criteria: sum of weights must be >= weight_threshold.
        if total_weight < weight_threshold {
            panic!("total weight below threshold");
        }

        // #694 — reject tokens not on the approved whitelist.
        // If no tokens have been whitelisted yet (e.g. fresh deploy), the check
        // is skipped so the contract can still be used before whitelist setup.
        if env.storage().instance().has(&DataKey::AllowedToken(token.clone())) == false {
            let list: Vec<Address> = env
                .storage()
                .instance()
                .get(&DataKey::AllowedTokenList)
                .unwrap_or_else(|| Vec::new(&env));
            if !list.is_empty() {
                panic_with_error!(&env, Error::UnsupportedToken);
            }
        }

        let next: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u64);
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FeeBps)
            .unwrap_or(DEFAULT_FEE_BPS);
        let token_client = token::TokenClient::new(&env, &token);
        let contract_addr = env.current_contract_address();
        token_client.balance(&contract_addr);
        token_client.transfer(&client_addr, &contract_addr, &budget);

        let now = env.ledger().timestamp();
        let primary_evaluator = evaluators.get(0).unwrap();
        let job = Job {
            id: next,
            client: client_addr.clone(),
            provider,
            evaluator: primary_evaluator,
            token,
            budget,
            released: 0,
            status: JobStatus::Funded,
            description,
            deliverable: String::from_str(&env, ""),
            deliverable_hash: soroban_sdk::BytesN::from_array(&env, &[0u8; 32]),
            funded_at: now,
            created_at: now,
            updated_at: now,
            fee_bps,
            sla_deadline: 0,
            penalty_bps_per_hour: 0,
            submitted_at: 0,
        };
        env.storage().persistent().set(&DataKey::Job(next), &job);
        env.storage().persistent().set(
            &DataKey::Evaluators(next),
            &JobEvaluators {
                evaluators,
                threshold: weight_threshold,
                approvals: soroban_sdk::Map::new(&env),
                evaluator_weights: weight_map,
                total_weight,
                accumulated_weight: 0,
            },
        );
        env.storage().instance().set(&DataKey::NextId, &(next + 1));
        JobCreated {
            client: client_addr,
            job_id: next,
            budget,
        }
        .publish(&env);
        next
    }

    /// Provider submits the deliverable together with its SHA-256 content hash.
    /// Flips status Funded → Submitted.
    ///
    /// #706 — `deliverable_hash` is the SHA-256 digest of the deliverable
    /// payload (32 bytes). It is stored immutably on the job: once submitted,
    /// neither the provider nor the evaluator can change it. The evaluator can
    /// later assert the hash in `complete()` to prove the content they reviewed
    /// is exactly what was committed on-chain.
    pub fn submit(
        env: Env,
        caller: Address,
        id: u64,
        deliverable: String,
        deliverable_hash: soroban_sdk::BytesN<32>,
    ) {
        Self::require_not_paused(&env); // #29
        caller.require_auth();
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&DataKey::Job(id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::JobNotFound));
        if caller != job.provider {
            panic_with_error!(&env, Error::NotProvider);
        }
        if job.status != JobStatus::Funded {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        // #20 — reject empty or whitespace-only deliverables; a blank URI
        // would defeat the purpose of the escrow.
        let is_blank = deliverable
            .to_bytes()
            .iter()
            .all(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r'));
        if is_blank {
            panic!("deliverable cannot be empty");
        }
        // #619 — cap deliverable length to prevent storage griefing.
        if deliverable.len() > MAX_DELIVERABLE_LEN {
            panic!("deliverable too long");
        }
        // #706 — reject the all-zero digest: it is the sentinel used for
        // "no hash committed yet" and must never be accepted as a real
        // SHA-256 commitment.
        let zero_hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
        if deliverable_hash == zero_hash {
            panic!("deliverable hash cannot be zero");
        }
        job.status = JobStatus::Submitted;
        job.deliverable = deliverable;
        job.deliverable_hash = deliverable_hash.clone();
        job.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Job(id), &job);

        JobSubmitted {
            provider: caller,
            deliverable_hash,
            job_id: id,
        }
        .publish(&env);
    }

    /// Evaluator approves the deliverable. Splits budget between provider and
    /// treasury according to the current `fee_bps` setting.
    ///
    /// Fee is computed with a multiply-first approach (`budget * fee_bps /
    /// BPS_DENOM`) so that micro-budgets smaller than 10,000 atomic units
    /// still produce a non-zero fee. A minimum 1-unit floor is applied when
    /// the proportional fee rounds to zero but both `budget` and `fee_bps`
    /// are positive (#539).
    ///
    /// #706 — the evaluator may pass `expected_hash` to attest that the
    /// content they reviewed matches the hash committed at submission time.
    /// If provided and it differs from the stored `deliverable_hash`, the call
    /// panics with `Error::HashMismatch` and no funds move.
    pub fn complete(
        env: Env,
        caller: Address,
        id: u64,
        expected_hash: Option<soroban_sdk::BytesN<32>>,
    ) {
        Self::require_not_paused(&env); // #29
        caller.require_auth();
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&DataKey::Job(id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::JobNotFound));
        if caller != job.evaluator {
            panic_with_error!(&env, Error::NotEvaluator);
        }
        if env.storage().persistent().has(&DataKey::Evaluators(id)) {
            // #704 — for weighted jobs, require the accumulated weight to meet
            // the threshold rather than a raw evaluator count.
            let quorum: JobEvaluators = env
                .storage()
                .persistent()
                .get(&DataKey::Evaluators(id))
                .unwrap();
            if quorum.accumulated_weight < quorum.threshold {
                panic!("multi-evaluator job requires approvals");
            }
        }
        // #22 — evaluator may resolve a job in either Submitted or Disputed state.
        if job.status != JobStatus::Submitted && job.status != JobStatus::Disputed {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        // #706 — optional content-hash attestation. Reject any assertion that
        // does not match the immutable hash committed by the provider.
        if let Some(expected) = expected_hash {
            if expected != job.deliverable_hash {
                panic_with_error!(&env, Error::HashMismatch);
            }
        }
        let (overdue_hours, penalty_bps, penalty) = Self::compute_sla_penalty(&job);
        let penalized_budget = job.budget - penalty;
        // #23 — use the fee_bps snapshotted at job creation time so admin
        // changes to the global rate don't retroactively alter this job.
        let fee: i128 = Self::compute_fee(penalized_budget, job.fee_bps);
        let payout: i128 = penalized_budget - fee;

        job.status = JobStatus::Completed;
        job.released = job.budget; // full budget has been paid out
        job.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Job(id), &job);

        let token_client = token::TokenClient::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
        if penalty > 0 {
            token_client.transfer(&contract_addr, &job.client, &penalty);
            SlaPenaltyApplied {
                job_id: id,
                overdue_hours,
                penalty_bps,
                penalty,
            }
            .publish(&env);
        }
        token_client.transfer(&contract_addr, &job.provider, &payout);
        if fee > 0 {
            let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
            token_client.transfer(&contract_addr, &treasury, &fee);
        }

        JobCompleted {
            evaluator: caller,
            job_id: id,
            provider: job.provider.clone(),
            payout,
            fee,
            timestamp: env.ledger().timestamp(),
        }
        .publish(&env);
    }

    /// Record an evaluator approval and release escrow when the weighted
    /// quorum is reached.
    ///
    /// #704 — The caller's weight is looked up from `evaluator_weights` and
    /// added to `accumulated_weight`. Duplicate approvals are rejected via the
    /// `approvals` map so the same evaluator can never double-count weight.
    /// Completion/payout is triggered once `accumulated_weight >= threshold`.
    /// Returns the accumulated weight so far.
    pub fn approve_job(env: Env, evaluator: Address, job_id: u64) -> u32 {
        Self::require_not_paused(&env);
        evaluator.require_auth();
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&DataKey::Job(job_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::JobNotFound));
        if job.status != JobStatus::Submitted && job.status != JobStatus::Disputed {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        let mut quorum: JobEvaluators = env
            .storage()
            .persistent()
            .get(&DataKey::Evaluators(job_id))
            .unwrap_or_else(|| panic!("job does not require multi-evaluator approval"));
        let mut member = false;
        for address in quorum.evaluators.iter() {
            if address == evaluator {
                member = true;
                break;
            }
        }
        if !member {
            panic!("not an assigned evaluator");
        }
        // Prevent double counting: an evaluator may only approve once.
        if quorum.approvals.get(evaluator.clone()).unwrap_or(false) {
            panic!("evaluator already approved");
        }
        // #704 — look up this evaluator's weight and accumulate it.
        let weight = quorum.evaluator_weights.get(evaluator.clone()).unwrap_or(0);
        quorum.approvals.set(evaluator.clone(), true);
        quorum.accumulated_weight = quorum
            .accumulated_weight
            .checked_add(weight)
            .expect("accumulated weight overflow");
        let accumulated_weight = quorum.accumulated_weight;
        env.storage()
            .persistent()
            .set(&DataKey::Evaluators(job_id), &quorum);
        JobApproved {
            evaluator: evaluator.clone(),
            job_id,
            approvals: accumulated_weight,
            threshold: quorum.threshold,
        }
        .publish(&env);
        if accumulated_weight >= quorum.threshold {
            Self::settle_job(&env, &mut job, job_id, evaluator);
        }
        accumulated_weight
    }

    fn settle_job(env: &Env, job: &mut Job, id: u64, evaluator: Address) {
        // #716 — apply SLA penalty (if any) before computing the fee.
        let (overdue_hours, penalty_bps, penalty) = Self::compute_sla_penalty(job);
        let penalized_budget = job.budget - penalty;
        let fee = Self::compute_fee(penalized_budget, job.fee_bps);
        let payout = penalized_budget - fee;
        job.status = JobStatus::Completed;
        job.released = job.budget;
        job.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Job(id), job);
        let token_client = token::TokenClient::new(env, &job.token);
        let contract_addr = env.current_contract_address();
        if penalty > 0 {
            token_client.transfer(&contract_addr, &job.client, &penalty);
            SlaPenaltyApplied {
                job_id: id,
                overdue_hours,
                penalty_bps,
                penalty,
            }
            .publish(env);
        }
        token_client.transfer(&contract_addr, &job.provider, &payout);
        if fee > 0 {
            let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
            token_client.transfer(&contract_addr, &treasury, &fee);
        }
        JobCompleted {
            evaluator,
            job_id: id,
            provider: job.provider.clone(),
            payout,
            fee,
            timestamp: env.ledger().timestamp(),
        }
        .publish(env);
    }

    /// Client cancels a funded (not-yet-submitted) job and reclaims the unreleased budget.
    /// Refunds `budget - released` so it correctly handles any future partial-settlement
    /// extensions without over-refunding.
    ///
    /// #22 — also allowed in Submitted state, giving the client recourse when
    /// a provider submits garbage. In that case the client loses nothing but
    /// the gas since the full escrow is returned. For a structured dispute
    /// workflow use `dispute()` instead.
    pub fn cancel(env: Env, caller: Address, id: u64) {
        Self::require_not_paused(&env); // #29
        caller.require_auth();
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&DataKey::Job(id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::JobNotFound));
        if caller != job.client {
            panic_with_error!(&env, Error::NotClient);
        }
        // #22 — allow cancel from Funded, Submitted, or Disputed.
        if job.status != JobStatus::Funded && job.status != JobStatus::Submitted && job.status != JobStatus::Disputed {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        // Refund only the net (unreleased) portion of the budget so the
        // contract never transfers more than it actually holds for this job.
        let net_budget = job.budget - job.released;
        if net_budget > 0 {
            let token_client = token::TokenClient::new(&env, &job.token);
            let contract_addr = env.current_contract_address();
            token_client.transfer(&contract_addr, &job.client, &net_budget);
        }
        job.released = job.budget; // mark everything as settled
        job.status = JobStatus::Cancelled;
        job.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Job(id), &job);
        env.storage().persistent().remove(&DataKey::Evaluators(id));

        JobCancelled {
            client: caller,
            job_id: id,
        }
        .publish(&env);
    }

    /// Client opens a dispute after a provider has submitted a deliverable
    /// the client considers unacceptable (#22).
    ///
    /// This entry point is a lightweight on-chain signal: it transitions the
    /// job to `Disputed` state and emits a `JobDisputed` event so off-chain
    /// evaluators/arbiters can detect and act on it.  The actual resolution
    /// happens through the normal `complete()` / `cancel()` flow once the
    /// evaluator has reviewed the deliverable and the dispute.
    ///
    /// Only the client may open a dispute, and only while the job is in the
    /// `Submitted` state.
    pub fn dispute(env: Env, caller: Address, id: u64) {
        Self::require_not_paused(&env); // #29
        caller.require_auth();
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&DataKey::Job(id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::JobNotFound));
        if caller != job.client {
            panic_with_error!(&env, Error::NotClient);
        }
        if job.status != JobStatus::Submitted {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        job.status = JobStatus::Disputed;
        job.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Job(id), &job);

        JobDisputed {
            client: caller,
            job_id: id,
            timestamp: env.ledger().timestamp(),
        }
        .publish(&env);
    }

    /// Admin updates the treasury address.
    ///
    /// #24 — rejects the zero/default address so platform fees are never
    /// silently burned. The treasury must be a distinct, explicitly-set
    /// address before any fee transfer can occur.
    pub fn set_treasury(env: Env, caller: Address, new_treasury: Address) {
        caller.require_auth();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic_with_error!(&env, Error::NotAdmin);
        }
        // #24 — prevent accidentally burning fees by setting treasury to the
        // zero/default Address (32 zero bytes). Callers must pass a real address.
        let zero_address = Address::from_str(&env, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
        if new_treasury == zero_address {
            panic!("treasury cannot be zero address");
        }
        env.storage()
            .instance()
            .set(&DataKey::Treasury, &new_treasury);
    }

    /// Admin updates the platform fee (in basis points). Capped at MAX_FEE_BPS.
    pub fn set_fee_bps(env: Env, caller: Address, new_bps: u32) {
        caller.require_auth();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic_with_error!(&env, Error::NotAdmin);
        }
        if new_bps > MAX_FEE_BPS {
            panic!("fee too high");
        }
        env.storage().instance().set(&DataKey::FeeBps, &new_bps);
    }

    /// Admin updates the smallest-unit budget threshold above which jobs must
    /// use `create_job_multi_eval`. Set to i128::MAX to disable the requirement.
    pub fn set_multi_eval_threshold(env: Env, caller: Address, threshold: i128) {
        caller.require_auth();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic_with_error!(&env, Error::NotAdmin);
        }
        if threshold < 0 {
            panic!("threshold cannot be negative");
        }
        env.storage()
            .instance()
            .set(&DataKey::MultiEvalThreshold, &threshold);
    }

    // -----------------------------------------------------------------------
    // #694 — Multi-token whitelist management
    // -----------------------------------------------------------------------

    /// Admin-only: add a token to the approved whitelist.
    /// `decimals` is the token's decimal precision (e.g. 7 for USDC/XLM on Stellar).
    /// Stores normalization factor = 10^(7 - decimals) for fee calculations.
    pub fn add_token(env: Env, admin: Address, token: Address, decimals: u32) {
        admin.require_auth();
        let current_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if admin != current_admin {
            panic_with_error!(&env, Error::NotAdmin);
        }
        // Normalization factor: if decimals <= 7, factor = 10^(7 - decimals); else 1.
        let normalization_factor: i128 = if decimals <= 7 {
            let exp = 7u32 - decimals;
            let mut factor: i128 = 1;
            let mut i = 0u32;
            while i < exp {
                factor *= 10;
                i += 1;
            }
            factor
        } else {
            1
        };
        let info = TokenInfo {
            token: token.clone(),
            decimals,
            normalization_factor,
        };
        env.storage().instance().set(&DataKey::AllowedToken(token.clone()), &info);
        // Maintain ordered list for enumeration
        let mut list: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedTokenList)
            .unwrap_or_else(|| Vec::new(&env));
        // Only add if not already present
        let mut found = false;
        for existing in list.iter() {
            if existing == token {
                found = true;
                break;
            }
        }
        if !found {
            list.push_back(token.clone());
            env.storage().instance().set(&DataKey::AllowedTokenList, &list);
        }
        TokenWhitelisted {
            admin,
            token,
            decimals,
        }
        .publish(&env);
    }

    /// Admin-only: remove a token from the approved whitelist.
    pub fn remove_token(env: Env, admin: Address, token: Address) {
        admin.require_auth();
        let current_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if admin != current_admin {
            panic_with_error!(&env, Error::NotAdmin);
        }
        env.storage().instance().remove(&DataKey::AllowedToken(token.clone()));
        // Remove from ordered list
        let list: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedTokenList)
            .unwrap_or_else(|| Vec::new(&env));
        let mut new_list: Vec<Address> = Vec::new(&env);
        for existing in list.iter() {
            if existing != token {
                new_list.push_back(existing);
            }
        }
        env.storage().instance().set(&DataKey::AllowedTokenList, &new_list);
        TokenRemoved {
            admin,
            token,
        }
        .publish(&env);
    }

    /// Read-only: list all whitelisted token addresses and their info.
    pub fn list_allowed_tokens(env: Env) -> Vec<TokenInfo> {
        let list: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedTokenList)
            .unwrap_or_else(|| Vec::new(&env));
        let mut result: Vec<TokenInfo> = Vec::new(&env);
        for token in list.iter() {
            if let Some(info) = env
                .storage()
                .instance()
                .get::<DataKey, TokenInfo>(&DataKey::AllowedToken(token.clone()))
            {
                result.push_back(info);
            }
        }
        result
    }

    /// Read-only: check if a token is whitelisted and return its info.
    pub fn get_token_info(env: Env, token: Address) -> Option<TokenInfo> {
        env.storage().instance().get(&DataKey::AllowedToken(token))
    }

    // -----------------------------------------------------------------------
    // #713 — Cross-currency escrow settlements via Stellar Path Payments
    // -----------------------------------------------------------------------

    /// Admin-only: set the AMM/DEX router contract used for cross-currency swaps.
    ///
    /// The router is expected to expose a `swap_exact_out`-style entry point
    /// that pulls `input_token` from the caller and delivers exactly
    /// `target_amount` of `target_token` to the caller, returning the amount of
    /// `input_token` consumed. This mirrors a Stellar DEX path payment
    /// (`PathPaymentStrictReceive`) routed through a Soroban AMM pool.
    pub fn set_amm_router(env: Env, admin: Address, router: Address) {
        admin.require_auth();
        let current_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if admin != current_admin {
            panic_with_error!(&env, Error::NotAdmin);
        }
        env.storage().instance().set(&DataKey::AmmRouter, &router);
    }

    /// Read-only: return the configured AMM/DEX router address, if any.
    pub fn get_amm_router(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::AmmRouter)
    }

    /// #713 — Fund an existing job's escrow using a cross-currency swap.
    ///
    /// The client pays in `input_token` (e.g. XLM or EURC) and the escrow is
    /// credited with exactly the job's `budget` denominated in the job's target
    /// token (e.g. USDC). The swap is executed atomically against the configured
    /// AMM/DEX router; if the required input exceeds `max_input_amount` the call
    /// reverts with `Error::SlippageExceeded`, protecting the client from
    /// adverse market movement.
    ///
    /// Any `input_token` not consumed by the swap is refunded to the client in
    /// the same transaction, so the client never overpays.
    ///
    /// # Panics
    /// - `ContractPaused` if the contract is paused.
    /// - `JobNotFound` if no job exists for `job_id`.
    /// - `NotClient` if `client` is not the job's client.
    /// - `InvalidStatus` if the job is not in a fundable state.
    /// - `UnsupportedToken` if either token is not whitelisted.
    /// - `SlippageExceeded` if the required input exceeds `max_input_amount`.
    pub fn fund_job_with_swap(
        env: Env,
        client: Address,
        input_token: Address,
        max_input_amount: i128,
        job_id: u64,
    ) -> i128 {
        Self::require_not_paused(&env);
        client.require_auth();
        if !env.storage().instance().has(&DataKey::Admin) {
            panic!("not initialized");
        }
        if max_input_amount <= 0 {
            panic!("max_input_amount must be positive");
        }

        let mut job: Job = env
            .storage()
            .persistent()
            .get(&DataKey::Job(job_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::JobNotFound));
        if client != job.client {
            panic_with_error!(&env, Error::NotClient);
        }
        // The job must be fundable: either freshly created (Open) or awaiting
        // its escrow deposit. Jobs already Funded/Submitted/Completed cannot be
        // re-funded through this path.
        if job.status != JobStatus::Open && job.status != JobStatus::Funded {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        // Guard against double-funding an already-escrowed job.
        if job.released != 0 || job.status == JobStatus::Funded {
            panic_with_error!(&env, Error::InvalidStatus);
        }

        // Both the input token and the job's target token must be whitelisted.
        // As with create_job, the check is skipped when no tokens have been
        // whitelisted yet (fresh deploy) so the contract remains usable.
        let list: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedTokenList)
            .unwrap_or_else(|| Vec::new(&env));
        if !list.is_empty() {
            if !env.storage().instance().has(&DataKey::AllowedToken(input_token.clone())) {
                panic_with_error!(&env, Error::UnsupportedToken);
            }
            if !env.storage().instance().has(&DataKey::AllowedToken(job.token.clone())) {
                panic_with_error!(&env, Error::UnsupportedToken);
            }
        }

        let router: Address = env
            .storage()
            .instance()
            .get(&DataKey::AmmRouter)
            .unwrap_or_else(|| panic!("amm router not configured"));

        let contract_addr = env.current_contract_address();
        let input_client = token::TokenClient::new(&env, &input_token);
        let target_client = token::TokenClient::new(&env, &job.token);

        // Pull the maximum the client is willing to spend into the contract so
        // the router can draw from it. Any unspent remainder is refunded below.
        input_client.balance(&contract_addr);
        input_client.transfer(&client, &contract_addr, &max_input_amount);

        // Ask the router to deliver exactly `job.budget` of the target token to
        // the escrow, spending at most `max_input_amount` of the input token.
        // The router returns the amount of input actually consumed.
        let input_spent: i128 = env.invoke_contract(
            &router,
            &soroban_sdk::Symbol::new(&env, "swap_exact_out"),
            soroban_sdk::vec![
                &env,
                contract_addr.clone().into_val(&env),
                input_token.clone().into_val(&env),
                job.token.clone().into_val(&env),
                job.budget.into_val(&env),
                max_input_amount.into_val(&env),
            ],
        );

        // Slippage guard: the router must not have consumed more than the
        // client authorised, and must have consumed a sane positive amount.
        if input_spent <= 0 || input_spent > max_input_amount {
            panic_with_error!(&env, Error::SlippageExceeded);
        }

        // Verify the escrow actually received the full target budget. If the
        // router under-delivered we revert rather than silently under-funding.
        let escrow_balance = target_client.balance(&contract_addr);
        if escrow_balance < job.budget {
            panic_with_error!(&env, Error::SlippageExceeded);
        }

        // Refund any unspent input remainder back to the client.
        let refund = max_input_amount - input_spent;
        if refund > 0 {
            input_client.transfer(&contract_addr, &client, &refund);
        }

        // Transition the job to Funded and stamp the funding time.
        let now = env.ledger().timestamp();
        job.status = JobStatus::Funded;
        job.funded_at = now;
        job.updated_at = now;
        env.storage().persistent().set(&DataKey::Job(job_id), &job);

        SwapFunded {
            client,
            job_id,
            input_token,
            target_token: job.token.clone(),
            input_spent,
            refund,
            budget: job.budget,
        }
        .publish(&env);

        input_spent
    }

    /// Read the configured high-value threshold in token smallest units.
    pub fn multi_eval_threshold(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::MultiEvalThreshold)
            .unwrap_or(DEFAULT_MULTI_EVAL_THRESHOLD)
    }

    /// Current fee in basis points.
    pub fn fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::FeeBps).unwrap()
    }

    /// Read-only helper: estimate the platform fee for a given budget and fee rate.
    ///
    /// Uses the same multiply-first logic as `compute_fee` (#539) so that
    /// micro-budgets below 10,000 atomic units return an accurate non-zero
    /// estimate instead of the misleading 0 that the old divide-first formula
    /// produced. No state is read or written; intended for frontends that want
    /// to display the estimated fee before calling `create_job`.
    pub fn simulate_job_fee(_env: Env, budget: i128, fee_bps: u32) -> i128 {
        Self::compute_fee(budget, fee_bps)
    }

    /// Fetch a job by id.
    pub fn get_job(env: Env, id: u64) -> Option<Job> {
        env.storage().persistent().get(&DataKey::Job(id))
    }

    /// Read the evaluator list, quorum, and accumulated approval weight for a
    /// multi-eval job.
    ///
    /// #704 — The third tuple element is now the accumulated weight of
    /// approving evaluators (which equals the raw approval count for
    /// unweighted jobs where every evaluator has weight 1).
    pub fn get_evaluator_progress(env: Env, id: u64) -> Option<(Vec<Address>, u32, u32)> {
        let quorum: Option<JobEvaluators> = env
            .storage()
            .persistent()
            .get(&DataKey::Evaluators(id));
        quorum.map(|quorum| {
            (quorum.evaluators, quorum.threshold, quorum.accumulated_weight)
        })
    }

    /// #704 — Read the full weighted quorum state for a job, including the
    /// per-evaluator weights, total weight, and accumulated approval weight.
    pub fn get_evaluator_weights(env: Env, id: u64) -> Option<JobEvaluators> {
        env.storage().persistent().get(&DataKey::Evaluators(id))
    }

    /// Open a one-way channel by escrowing a fixed token deposit.
    pub fn open_channel(
        env: Env,
        payer: Address,
        provider: Address,
        token: Address,
        deposit: i128,
        voucher_key: soroban_sdk::BytesN<32>,
    ) -> u64 {
        Self::require_not_paused(&env);
        payer.require_auth();
        if !env.storage().instance().has(&DataKey::Admin) {
            panic!("not initialized");
        }
        if deposit < MIN_BUDGET {
            panic!("deposit below minimum");
        }
        if payer == provider {
            panic_with_error!(&env, Error::SelfEscrow);
        }
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextChannelId)
            .unwrap_or(1u64);
        let token_client = token::TokenClient::new(&env, &token);
        let contract_addr = env.current_contract_address();
        token_client.balance(&contract_addr);
        token_client.transfer(&payer, &contract_addr, &deposit);
        let channel = PaymentChannel {
            id,
            payer: payer.clone(),
            provider: provider.clone(),
            token,
            deposit,
            amount: 0,
            nonce: 0,
            opened_at: env.ledger().timestamp(),
            closing_at: 0,
            voucher_key,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Channel(id), &channel);
        env.storage()
            .instance()
            .set(&DataKey::NextChannelId, &(id + 1));
        ChannelOpened {
            payer,
            channel_id: id,
            provider,
            deposit,
        }
        .publish(&env);
        id
    }

    /// Start the 24-hour challenge window or replace the current voucher with
    /// a higher-value payer-signed voucher while that window remains open.
    pub fn close_channel(
        env: Env,
        caller: Address,
        channel_id: u64,
        voucher: ChannelVoucher,
        signature: soroban_sdk::BytesN<64>,
    ) {
        Self::require_not_paused(&env);
        caller.require_auth();
        let mut channel: PaymentChannel = env
            .storage()
            .persistent()
            .get(&DataKey::Channel(channel_id))
            .unwrap_or_else(|| panic!("channel not found"));
        if caller != channel.provider && caller != channel.payer {
            panic!("not a channel participant");
        }
        let now = env.ledger().timestamp();
        if channel.closing_at != 0 && now >= channel.closing_at {
            panic!("channel challenge window ended");
        }
        Self::verify_voucher(&env, &channel, &voucher, &signature);
        if voucher.amount < channel.amount || voucher.nonce <= channel.nonce {
            panic!("voucher is not newer");
        }
        channel.amount = voucher.amount;
        channel.nonce = voucher.nonce;
        if channel.closing_at == 0 {
            channel.closing_at = now + CHANNEL_DISPUTE_WINDOW_SECS;
        }
        env.storage()
            .persistent()
            .set(&DataKey::Channel(channel_id), &channel);
        ChannelClosing {
            actor: caller,
            channel_id,
            amount: channel.amount,
            challenge_until: channel.closing_at,
        }
        .publish(&env);
    }

    /// Settle the latest signed voucher after the 24-hour challenge period.
    /// Either channel participant may submit settlement once the period ends.
    pub fn force_close(env: Env, caller: Address, channel_id: u64) {
        Self::require_not_paused(&env);
        caller.require_auth();
        let channel: PaymentChannel = env
            .storage()
            .persistent()
            .get(&DataKey::Channel(channel_id))
            .unwrap_or_else(|| panic!("channel not found"));
        if caller != channel.payer && caller != channel.provider {
            panic!("not a channel participant");
        }
        let challenge_until = if channel.closing_at == 0 {
            channel.opened_at + CHANNEL_DISPUTE_WINDOW_SECS
        } else {
            channel.closing_at
        };
        if env.ledger().timestamp() < challenge_until {
            panic!("channel challenge window active");
        }
        env.storage()
            .persistent()
            .remove(&DataKey::Channel(channel_id));
        let refund = channel.deposit - channel.amount;
        let token_client = token::TokenClient::new(&env, &channel.token);
        let contract_addr = env.current_contract_address();
        if channel.amount > 0 {
            token_client.transfer(&contract_addr, &channel.provider, &channel.amount);
        }
        if refund > 0 {
            token_client.transfer(&contract_addr, &channel.payer, &refund);
        }
        ChannelSettled {
            channel_id,
            amount: channel.amount,
            refund,
        }
        .publish(&env);
    }

    /// Read an active payment channel (including its latest accepted voucher).
    pub fn get_channel(env: Env, channel_id: u64) -> Option<PaymentChannel> {
        env.storage().persistent().get(&DataKey::Channel(channel_id))
    }

    /// Returns up to `limit` jobs where `provider` is the job's provider,
    /// scanning forward from `start_id` (#21). There is no secondary index by
    /// provider address, so this scans the job id range; callers should page
    /// through with `start_id` to bound the work done per call.
    pub fn jobs_by_provider(env: Env, provider: Address, start_id: u64, limit: u32) -> Vec<Job> {
        let mut result = Vec::new(&env);
        let next_id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1u64);

        let mut id = start_id;
        while result.len() < limit && id < next_id {
            let job: Option<Job> = env.storage().persistent().get(&DataKey::Job(id));
            if let Some(job) = job {
                if job.provider == provider {
                    result.push_back(job);
                }
            }
            id += 1;
        }
        result
    }

    /// Returns up to `limit` jobs where `client` is the job's client,
    /// scanning forward from `start_id` (#21). Mirrors `jobs_by_provider`.
    pub fn jobs_by_client(env: Env, client: Address, start_id: u64, limit: u32) -> Vec<Job> {
        let mut result = Vec::new(&env);
        let next_id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1u64);

        let mut id = start_id;
        while result.len() < limit && id < next_id {
            let job: Option<Job> = env.storage().persistent().get(&DataKey::Job(id));
            if let Some(job) = job {
                if job.client == client {
                    result.push_back(job);
                }
            }
            id += 1;
        }
        result
    }

    /// Contract version. Bump on ABI changes.
    pub fn version(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Version).unwrap_or(1u32)
    }

    /// Total number of jobs ever created (for dashboard stats).
    pub fn job_count(env: Env) -> u64 {
        let next: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1u64);
        next - 1
    }

    /// Read-only: returns the number of jobs currently in the given `status`.
    ///
    /// Scans all persisted jobs (O(n) in the number of jobs ever created) and
    /// counts matches. Off-chain indexers and dashboards can call this to get
    /// lightweight per-status statistics without fetching and deserializing
    /// every full Job struct. (#471)
    pub fn get_jobs_count_by_status(env: Env, status: JobStatus) -> u32 {
        let next_id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1u64);
        let mut count: u32 = 0;
        let mut id: u64 = 1;
        while id < next_id {
            if let Some(job) = env.storage().persistent().get::<DataKey, Job>(&DataKey::Job(id)) {
                if job.status == status {
                    count += 1;
                }
            }
            id += 1;
        }
        count
    }

    /// Buyer claims a full refund if provider never submitted and the timeout has passed.
    pub fn claim_refund(env: Env, caller: Address, id: u64) {
        Self::require_not_paused(&env); // #29
        caller.require_auth();
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&DataKey::Job(id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::JobNotFound));
        if caller != job.client {
            panic_with_error!(&env, Error::NotClient);
        }
        if job.status != JobStatus::Funded {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        let now = env.ledger().timestamp();
        if now < job.funded_at + REFUND_TIMEOUT_SECS {
            panic!("timeout not reached");
        }
        // Refund only the net (unreleased) portion to avoid over-transfer.
        let net_budget = job.budget - job.released;
        if net_budget > 0 {
            let token_client = token::TokenClient::new(&env, &job.token);
            let contract_addr = env.current_contract_address();
            token_client.transfer(&contract_addr, &job.client, &net_budget);
        }
        job.released = job.budget;
        job.status = JobStatus::Cancelled;
        job.updated_at = now;
        env.storage().persistent().set(&DataKey::Job(id), &job);
        env.storage().persistent().remove(&DataKey::Evaluators(id));

        JobRefunded {
            client: caller,
            job_id: id,
        }
        .publish(&env);
    }

    /// Provider claims payout if the evaluator never completed the job and the
    /// timeout has passed. Mirrors `claim_refund`'s timeout pattern for the
    /// `Submitted` state, preventing a non-responsive evaluator from locking
    /// the provider's payment forever (#18).
    pub fn claim_expired(env: Env, caller: Address, id: u64) {
        Self::require_not_paused(&env); // #29
        caller.require_auth();
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&DataKey::Job(id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::JobNotFound));
        if caller != job.provider {
            panic_with_error!(&env, Error::NotProvider);
        }
        if job.status != JobStatus::Submitted {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        if env.storage().persistent().has(&DataKey::Evaluators(id)) {
            panic!("multi-evaluator job cannot use provider timeout payout");
        }
        let now = env.ledger().timestamp();
        // `updated_at` is set to the submission time by `submit()` and does
        // not change again while status remains `Submitted`.
        if now < job.updated_at + REFUND_TIMEOUT_SECS {
            panic!("timeout not reached");
        }
        // #716 — apply SLA penalty (if any) before computing the fee.
        let (overdue_hours, penalty_bps, penalty) = Self::compute_sla_penalty(&job);
        let penalized_budget = job.budget - penalty;
        // #28 — overflow-safe fee: divide first, then multiply.
        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap();
        let fee: i128 = Self::compute_fee(penalized_budget, fee_bps);
        let payout: i128 = penalized_budget - fee;

        job.status = JobStatus::Completed;
        job.released = job.budget;
        job.updated_at = now;
        env.storage().persistent().set(&DataKey::Job(id), &job);

        let token_client = token::TokenClient::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
        if penalty > 0 {
            token_client.transfer(&contract_addr, &job.client, &penalty);
            SlaPenaltyApplied {
                job_id: id,
                overdue_hours,
                penalty_bps,
                penalty,
            }
            .publish(&env);
        }
        token_client.transfer(&contract_addr, &job.provider, &payout);
        if fee > 0 {
            let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
            token_client.transfer(&contract_addr, &treasury, &fee);
        }

        JobExpired {
            provider: caller,
            job_id: id,
            payout,
            fee,
            timestamp: now,
        }
        .publish(&env);
    }

    /// Read-only: returns true if the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    // -----------------------------------------------------------------------
    // #693 — Milestone-based progressive escrow releases
    // -----------------------------------------------------------------------

    /// Create a job with multiple sequential milestones.
    ///
    /// The total budget is the sum of all milestone amounts. Funds are locked
    /// in escrow and released milestone-by-milestone as the evaluator approves.
    /// The job stays in `Funded` status until all milestones are approved (released == budget).
    ///
    /// # Panics
    /// - If any milestone amount is <= 0.
    /// - If the sum of milestone amounts does not equal `budget`.
    /// - If fewer than 1 or more than 20 milestones are provided.
    #[allow(clippy::too_many_arguments)]
    pub fn create_milestone_job(
        env: Env,
        client_addr: Address,
        provider: Address,
        evaluator: Address,
        token: Address,
        budget: i128,
        description: String,
        milestones: Vec<Milestone>,
    ) -> u64 {
        Self::require_not_paused(&env);
        client_addr.require_auth();
        if !env.storage().instance().has(&DataKey::Admin) {
            panic!("not initialized");
        }
        if budget < MIN_BUDGET {
            panic!("budget below minimum");
        }
        if milestones.is_empty() || milestones.len() > 20 {
            panic!("milestones must contain between 1 and 20 entries");
        }
        if client_addr == provider {
            panic_with_error!(&env, Error::SelfEscrow);
        }
        if provider == evaluator {
            panic_with_error!(&env, Error::InvalidParties);
        }
        // Invariant: sum of milestone amounts must equal budget exactly.
        let mut total: i128 = 0;
        let mut idx = 0u32;
        while idx < milestones.len() {
            let m = milestones.get(idx).unwrap();
            if m.amount <= 0 {
                panic!("milestone amount must be positive");
            }
            total = total.checked_add(m.amount).expect("milestone sum overflow");
            idx += 1;
        }
        if total != budget {
            panic!("sum of milestone amounts must equal budget");
        }

        let snapshotted_fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FeeBps)
            .unwrap_or(DEFAULT_FEE_BPS);

        let token_client = token::TokenClient::new(&env, &token);
        let contract_addr = env.current_contract_address();
        token_client.balance(&contract_addr);
        token_client.transfer(&client_addr, &contract_addr, &budget);

        let next: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u64);
        let now = env.ledger().timestamp();
        let job = Job {
            id: next,
            client: client_addr.clone(),
            provider,
            evaluator,
            token,
            budget,
            released: 0,
            status: JobStatus::Funded,
            description,
            deliverable: String::from_str(&env, ""),
            // #706 — zero hash until the provider commits a real content hash.
            deliverable_hash: soroban_sdk::BytesN::from_array(&env, &[0u8; 32]),
            funded_at: now,
            created_at: now,
            updated_at: now,
            fee_bps: snapshotted_fee_bps,
            sla_deadline: 0,         // #716 — milestone jobs have no SLA by default
            penalty_bps_per_hour: 0, // #716
            submitted_at: 0,         // #716
        };
        env.storage().persistent().set(&DataKey::Job(next), &job);
        // Normalise milestone indices to match their position in the Vec.
        let mut normalised: Vec<Milestone> = Vec::new(&env);
        let mut midx = 0u32;
        while midx < milestones.len() {
            let mut m = milestones.get(midx).unwrap();
            m.index = midx;
            normalised.push_back(m);
            midx += 1;
        }
        env.storage().persistent().set(&DataKey::Milestones(next), &normalised);
        env.storage().instance().set(&DataKey::NextId, &(next + 1));

        let milestone_count = normalised.len();
        MilestoneJobCreated {
            client: client_addr,
            job_id: next,
            budget,
            milestone_count,
        }
        .publish(&env);
        next
    }

    /// Provider submits a deliverable for a specific milestone.
    ///
    /// Milestones must be submitted in order (index 0 before index 1, etc.).
    /// The milestone must not already be approved.
    pub fn submit_milestone(
        env: Env,
        caller: Address,
        job_id: u64,
        milestone_idx: u32,
        deliverable: String,
    ) {
        Self::require_not_paused(&env);
        caller.require_auth();
        let job: Job = env
            .storage()
            .persistent()
            .get(&DataKey::Job(job_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::JobNotFound));
        if caller != job.provider {
            panic_with_error!(&env, Error::NotProvider);
        }
        if job.status != JobStatus::Funded && job.status != JobStatus::Submitted {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        let is_blank = deliverable
            .to_bytes()
            .iter()
            .all(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r'));
        if is_blank {
            panic!("deliverable cannot be empty");
        }
        if deliverable.len() > MAX_METADATA_URI_LEN {
            panic!("deliverable too long");
        }
        let mut milestones: Vec<Milestone> = env
            .storage()
            .persistent()
            .get(&DataKey::Milestones(job_id))
            .unwrap_or_else(|| panic!("not a milestone job"));
        if milestone_idx >= milestones.len() {
            panic!("milestone index out of bounds");
        }
        // Enforce sequential submission: all prior milestones must be approved.
        if milestone_idx > 0 {
            let prev = milestones.get(milestone_idx - 1).unwrap();
            if !prev.approved {
                panic!("previous milestone not yet approved");
            }
        }
        let mut m = milestones.get(milestone_idx).unwrap();
        if m.approved {
            panic!("milestone already approved");
        }
        if !m.deliverable.to_bytes().is_empty() {
            // Already submitted but not yet approved — allow resubmission
        }
        m.deliverable = deliverable;
        milestones.set(milestone_idx, m);
        env.storage().persistent().set(&DataKey::Milestones(job_id), &milestones);

        MilestoneSubmitted {
            provider: caller,
            job_id,
            milestone_index: milestone_idx,
        }
        .publish(&env);
    }

    /// Evaluator approves a milestone, releasing its proportional funds to the provider.
    ///
    /// Computes fee using the job's snapshotted `fee_bps`. When the last milestone
    /// is approved (`job.released == job.budget`), the job transitions to `Completed`.
    pub fn approve_milestone(
        env: Env,
        caller: Address,
        job_id: u64,
        milestone_idx: u32,
    ) {
        Self::require_not_paused(&env);
        caller.require_auth();
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&DataKey::Job(job_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::JobNotFound));
        if caller != job.evaluator {
            panic_with_error!(&env, Error::NotEvaluator);
        }
        if job.status != JobStatus::Funded && job.status != JobStatus::Submitted {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        let mut milestones: Vec<Milestone> = env
            .storage()
            .persistent()
            .get(&DataKey::Milestones(job_id))
            .unwrap_or_else(|| panic!("not a milestone job"));
        if milestone_idx >= milestones.len() {
            panic!("milestone index out of bounds");
        }
        let mut m = milestones.get(milestone_idx).unwrap();
        if m.approved {
            panic!("milestone already approved");
        }
        // Deliverable must have been submitted before approval.
        let blank = m.deliverable.to_bytes().iter().all(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r'));
        if blank {
            panic!("milestone deliverable not yet submitted");
        }
        let fee = Self::compute_fee(m.amount, job.fee_bps);
        let payout = m.amount - fee;
        m.approved = true;
        milestones.set(milestone_idx, m.clone());
        job.released = job.released.checked_add(m.amount).expect("released overflow");
        job.updated_at = env.ledger().timestamp();
        // Transition to Completed only when all funds have been released.
        if job.released >= job.budget {
            job.status = JobStatus::Completed;
        }
        env.storage().persistent().set(&DataKey::Job(job_id), &job);
        env.storage().persistent().set(&DataKey::Milestones(job_id), &milestones);

        let token_client = token::TokenClient::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&contract_addr, &job.provider, &payout);
        if fee > 0 {
            let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
            token_client.transfer(&contract_addr, &treasury, &fee);
        }

        MilestoneApproved {
            evaluator: caller,
            job_id,
            milestone_index: milestone_idx,
            payout,
            fee,
        }
        .publish(&env);
    }

    /// Client cancels all uncompleted milestones, getting a refund of unreleased funds.
    ///
    /// Already-approved milestones are preserved — the provider keeps their earned payouts.
    /// The job is transitioned to `Cancelled`.
    pub fn cancel_uncompleted_milestones(env: Env, caller: Address, job_id: u64) {
        Self::require_not_paused(&env);
        caller.require_auth();
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&DataKey::Job(job_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::JobNotFound));
        if caller != job.client {
            panic_with_error!(&env, Error::NotClient);
        }
        if job.status == JobStatus::Completed || job.status == JobStatus::Cancelled {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        env.storage().persistent().has(&DataKey::Milestones(job_id));
        // Verify this is actually a milestone job.
        if !env.storage().persistent().has(&DataKey::Milestones(job_id)) {
            panic!("not a milestone job");
        }
        let net_budget = job.budget - job.released;
        if net_budget > 0 {
            let token_client = token::TokenClient::new(&env, &job.token);
            let contract_addr = env.current_contract_address();
            token_client.transfer(&contract_addr, &job.client, &net_budget);
        }
        let refund = net_budget;
        job.released = job.budget;
        job.status = JobStatus::Cancelled;
        job.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Job(job_id), &job);

        MilestonesPartialCancelled {
            client: caller,
            job_id,
            refund,
        }
        .publish(&env);
    }

    /// Read-only: fetch the milestone list for a job.
    pub fn get_milestones(env: Env, job_id: u64) -> Option<Vec<Milestone>> {
        env.storage().persistent().get(&DataKey::Milestones(job_id))
    }
}

#[cfg(test)]
mod test;
