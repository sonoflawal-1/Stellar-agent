#![no_std]
use soroban_sdk::{contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token, Address, Env, String, Vec};

/// Contract-level error codes for agentic-commerce (#323).
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    /// client == provider: a client cannot escrow funds to themselves.
    SelfEscrow = 1,
    /// provider == evaluator: the party delivering work cannot also approve it.
    InvalidParties = 2,
    /// The contract is paused; no state-changing operations are allowed.
    ContractPaused = 3,
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
}

const DEFAULT_FEE_BPS: u32 = 100; // 1%
const MAX_FEE_BPS: u32 = 500; // 5% hard cap
const BPS_DENOM: i128 = 10_000;
const REFUND_TIMEOUT_SECS: u64 = 7 * 24 * 3600; // 7 days
/// #25 — minimum budget to prevent zero/dust jobs that waste storage and spam events.
const MIN_BUDGET: i128 = 1;

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

    /// Compute the platform fee for a given budget using safe arithmetic (#28).
    ///
    /// The naive `budget * fee_bps / BPS_DENOM` risks overflowing i128 for
    /// very large budgets (e.g. 10^30 atomic units × 500 bps). We divide
    /// first to keep the intermediate value small, then multiply.  A small
    /// amount of precision is lost (at most `fee_bps - 1` stroops, i.e. < 500)
    /// which is acceptable for a platform fee calculation.
    ///
    /// We still use `checked_mul` after the division as a defence-in-depth
    /// guard — in practice the result of `budget / BPS_DENOM` is at most
    /// i128::MAX / BPS_DENOM which multiplied by MAX_FEE_BPS (500) is still
    /// well within i128 range.
    fn compute_fee(budget: i128, fee_bps: u32) -> i128 {
        (budget / BPS_DENOM)
            .checked_mul(fee_bps as i128)
            .expect("fee overflow")
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
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::FeeBps, &DEFAULT_FEE_BPS);

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
            panic!("not admin");
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
    // #29 — Emergency pause / unpause
    // -----------------------------------------------------------------------

    /// Admin-only: halt all state-changing entry points immediately.
    /// Emits a `Paused` event. Idempotent (pausing an already-paused contract
    /// is a no-op that still succeeds and still emits the event).
    pub fn emergency_pause(env: Env, caller: Address) {
        caller.require_auth();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic!("not admin");
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
            panic!("not admin");
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

    /// Provider submits the deliverable. Flips status Funded → Submitted.
    pub fn submit(env: Env, caller: Address, id: u64, deliverable: String) {
        Self::require_not_paused(&env); // #29
        caller.require_auth();
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&DataKey::Job(id))
            .unwrap_or_else(|| panic!("job not found"));
        if caller != job.provider {
            panic!("not provider");
        }
        if job.status != JobStatus::Funded {
            panic!("invalid status");
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
    /// Fee is computed as `(budget / BPS_DENOM) * fee_bps` (divide-first order)
    /// to avoid i128 overflow for extremely large budgets (#28).
    pub fn complete(env: Env, caller: Address, id: u64) {
        Self::require_not_paused(&env); // #29
        caller.require_auth();
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&DataKey::Job(id))
            .unwrap_or_else(|| panic!("job not found"));
        if caller != job.evaluator {
            panic!("not evaluator");
        }
        // #22 — evaluator may resolve a job in either Submitted or Disputed state.
        if job.status != JobStatus::Submitted && job.status != JobStatus::Disputed {
            panic!("invalid status");
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
            .unwrap_or_else(|| panic!("job not found"));
        if caller != job.client {
            panic!("not client");
        }
        // #22 — allow cancel from Funded, Submitted, or Disputed.
        if job.status != JobStatus::Funded && job.status != JobStatus::Submitted && job.status != JobStatus::Disputed {
            panic!("invalid status");
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
            .unwrap_or_else(|| panic!("job not found"));
        if caller != job.client {
            panic!("not client");
        }
        if job.status != JobStatus::Submitted {
            panic!("invalid status");
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
            panic!("not admin");
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
            panic!("not admin");
        }
        if new_bps > MAX_FEE_BPS {
            panic!("fee too high");
        }
        env.storage().instance().set(&DataKey::FeeBps, &new_bps);
    }

    /// Current fee in basis points.
    pub fn fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::FeeBps).unwrap()
    }

    /// Read-only helper: estimate the platform fee for a given budget and fee rate.
    ///
    /// Returns `(budget / 10_000) * fee_bps`. No state is read or written.
    /// Intended for frontends that want to display the estimated fee before
    /// calling `create_job`.
    pub fn simulate_job_fee(_env: Env, budget: i128, fee_bps: u32) -> i128 {
        // #28 — divide-first to avoid overflow on very large budgets.
        (budget / BPS_DENOM)
            .checked_mul(fee_bps as i128)
            .unwrap_or(0)
    }

    /// Fetch a job by id.
    pub fn get_job(env: Env, id: u64) -> Option<Job> {
        env.storage().persistent().get(&DataKey::Job(id))
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

    /// Buyer claims a full refund if provider never submitted and the timeout has passed.
    pub fn claim_refund(env: Env, caller: Address, id: u64) {
        Self::require_not_paused(&env); // #29
        caller.require_auth();
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&DataKey::Job(id))
            .unwrap_or_else(|| panic!("job not found"));
        if caller != job.client {
            panic!("not client");
        }
        if job.status != JobStatus::Funded {
            panic!("invalid status");
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
            .unwrap_or_else(|| panic!("job not found"));
        if caller != job.provider {
            panic!("not provider");
        }
        if job.status != JobStatus::Submitted {
            panic!("invalid status");
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
