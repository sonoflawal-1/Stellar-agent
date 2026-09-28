#![no_std]
use soroban_sdk::{contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token, Address, Env, String, Vec};

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
    pub funded_at: u64,
    pub created_at: u64,
    pub updated_at: u64,
    /// #23 — fee_bps snapshotted at job creation so admin changes to the
    /// global fee rate do not retroactively affect already-funded jobs.
    pub fee_bps: u32,
}

/// Evaluator quorum stored separately from `Job` to preserve existing job XDR.
#[contracttype]
#[derive(Clone)]
pub struct JobEvaluators {
    pub evaluators: Vec<Address>,
    pub threshold: u32,
    pub approvals: soroban_sdk::Map<Address, bool>,
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
}

const DEFAULT_FEE_BPS: u32 = 100; // 1%
const MAX_FEE_BPS: u32 = 500; // 5% hard cap
const BPS_DENOM: i128 = 10_000;
const REFUND_TIMEOUT_SECS: u64 = 7 * 24 * 3600; // 7 days
/// #25 — minimum budget to prevent zero/dust jobs that waste storage and spam events.
const MIN_BUDGET: i128 = 1;
/// #619 — maximum deliverable URI length to prevent storage griefing.
const MAX_DELIVERABLE_LEN: u32 = 1024;
const MAX_EVALUATORS: u32 = 5;
const DEFAULT_MULTI_EVAL_THRESHOLD: i128 = i128::MAX;
const CHANNEL_DISPUTE_WINDOW_SECS: u64 = 24 * 60 * 60;

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

/// Emitted when the provider submits a deliverable.
#[contractevent]
pub struct JobSubmitted {
    #[topic]
    pub provider: Address,
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

/// #22 — Emitted when a client opens a dispute on a submitted deliverable.
#[contractevent]
pub struct JobDisputed {
    #[topic]
    pub client: Address,
    pub job_id: u64,
    pub timestamp: u64,
}

/// Emitted when a provider claims payment after the evaluator timeout has passed (#18).
#[contractevent]
pub struct JobExpired {
    #[topic]
    pub provider: Address,
    pub job_id: u64,
    pub payout: i128,
    pub fee: i128,
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

/// Emitted when admin/treasury are updated via `re_init`.
#[contractevent]
pub struct ReInitialized {
    #[topic]
    pub admin: Address,
    pub new_admin: Address,
    pub new_treasury: Address,
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
            funded_at: now,
            created_at: now,
            updated_at: now,
            fee_bps: snapshotted_fee_bps, // #23
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

    /// Create and fund a high-value job with an explicit evaluator quorum.
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
            funded_at: now,
            created_at: now,
            updated_at: now,
            fee_bps,
        };
        env.storage().persistent().set(&DataKey::Job(next), &job);
        env.storage().persistent().set(
            &DataKey::Evaluators(next),
            &JobEvaluators {
                evaluators,
                threshold,
                approvals: soroban_sdk::Map::new(&env),
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

    /// Provider submits the deliverable. Flips status Funded → Submitted.
    pub fn submit(env: Env, caller: Address, id: u64, deliverable: String) {
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
        job.status = JobStatus::Submitted;
        job.deliverable = deliverable;
        job.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Job(id), &job);

        JobSubmitted {
            provider: caller,
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
    pub fn complete(env: Env, caller: Address, id: u64) {
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
            panic!("multi-evaluator job requires approvals");
        }
        // #22 — evaluator may resolve a job in either Submitted or Disputed state.
        if job.status != JobStatus::Submitted && job.status != JobStatus::Disputed {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        // #23 — use the fee_bps snapshotted at job creation time so admin
        // changes to the global rate don't retroactively alter this job.
        let fee: i128 = Self::compute_fee(job.budget, job.fee_bps);
        let payout: i128 = job.budget - fee;

        job.status = JobStatus::Completed;
        job.released = job.budget; // full budget has been paid out
        job.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Job(id), &job);

        let token_client = token::TokenClient::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
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

    /// Record an evaluator approval and release escrow when quorum is reached.
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
        if quorum.approvals.get(evaluator.clone()).unwrap_or(false) {
            panic!("evaluator already approved");
        }
        quorum.approvals.set(evaluator.clone(), true);
        let mut approval_count = 0u32;
        for address in quorum.evaluators.iter() {
            if quorum.approvals.get(address).unwrap_or(false) {
                approval_count += 1;
            }
        }
        env.storage()
            .persistent()
            .set(&DataKey::Evaluators(job_id), &quorum);
        JobApproved {
            evaluator: evaluator.clone(),
            job_id,
            approvals: approval_count,
            threshold: quorum.threshold,
        }
        .publish(&env);
        if approval_count >= quorum.threshold {
            Self::settle_job(&env, &mut job, job_id, evaluator);
        }
        approval_count
    }

    fn settle_job(env: &Env, job: &mut Job, id: u64, evaluator: Address) {
        let fee = Self::compute_fee(job.budget, job.fee_bps);
        let payout = job.budget - fee;
        job.status = JobStatus::Completed;
        job.released = job.budget;
        job.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Job(id), job);
        let token_client = token::TokenClient::new(env, &job.token);
        let contract_addr = env.current_contract_address();
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

    /// Read the evaluator list, quorum, and approval count for a multi-eval job.
    pub fn get_evaluator_progress(env: Env, id: u64) -> Option<(Vec<Address>, u32, u32)> {
        let quorum: Option<JobEvaluators> = env
            .storage()
            .persistent()
            .get(&DataKey::Evaluators(id));
        quorum.map(|quorum| {
            let mut approvals = 0u32;
            for evaluator in quorum.evaluators.iter() {
                if quorum.approvals.get(evaluator).unwrap_or(false) {
                    approvals += 1;
                }
            }
            (quorum.evaluators, quorum.threshold, approvals)
        })
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
        // #28 — overflow-safe fee: divide first, then multiply.
        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap();
        let fee: i128 = Self::compute_fee(job.budget, fee_bps);
        let payout: i128 = job.budget - fee;

        job.status = JobStatus::Completed;
        job.released = job.budget;
        job.updated_at = now;
        env.storage().persistent().set(&DataKey::Job(id), &job);

        let token_client = token::TokenClient::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
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
}

#[cfg(test)]
mod test;
