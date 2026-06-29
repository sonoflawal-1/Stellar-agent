#![no_std]
use soroban_sdk::{contract, contractevent, contractimpl, contracttype, token, Address, Env, String};

/// Lifecycle states for a job escrow.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum JobStatus {
    Open,
    Funded,
    Submitted,
    Completed,
    Rejected,
    Cancelled,
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
    pub status: JobStatus,
    pub description: String,
    pub deliverable: String,
    pub funded_at: u64,
    pub created_at: u64,
    pub updated_at: u64,
}

#[contracttype]
enum DataKey {
    NextId,
    Job(u64),
    Treasury,
    Admin,
    FeeBps,
}

const DEFAULT_FEE_BPS: u32 = 100; // 1%
const MAX_FEE_BPS: u32 = 500; // 5% hard cap
const BPS_DENOM: i128 = 10_000;
const REFUND_TIMEOUT_SECS: u64 = 7 * 24 * 3600; // 7 days

// --- Events ---

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
#[contractevent]
pub struct JobCompleted {
    #[topic]
    pub evaluator: Address,
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

#[contract]
pub struct AgenticCommerceContract;

#[contractimpl]
impl AgenticCommerceContract {
    /// Initializer. Sets admin, treasury, default fee (1%), and job id counter.
    /// Can be re-called by the existing admin to update treasury/fee params.
    /// Panics if already initialized and caller is not the admin.
    pub fn init(env: Env, admin: Address, treasury: Address) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            let current_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
            if admin != current_admin {
                panic!("not admin");
            }
        } else {
            env.storage().instance().set(&DataKey::NextId, &1u64);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::FeeBps, &DEFAULT_FEE_BPS);
    }

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
        client_addr.require_auth();
        if budget <= 0 {
            panic!("budget must be positive");
        }

        let next: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u64);

        // Pull funds into contract escrow.
        let token_client = token::TokenClient::new(&env, &token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&client_addr, &contract_addr, &budget);

        let now = env.ledger().timestamp();
        let job = Job {
            id: next,
            client: client_addr.clone(),
            provider,
            evaluator,
            token,
            budget,
            status: JobStatus::Funded,
            description,
            deliverable: String::from_str(&env, ""),
            funded_at: now,
            created_at: now,
            updated_at: now,
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

    /// Evaluator approves the deliverable. Splits budget 99/1 between provider and treasury.
    pub fn complete(env: Env, caller: Address, id: u64) {
        caller.require_auth();
        let mut job: Job = env
            .storage()
            .persistent()
            .get(&DataKey::Job(id))
            .unwrap_or_else(|| panic!("job not found"));
        if caller != job.evaluator {
            panic!("not evaluator");
        }
        if job.status != JobStatus::Submitted {
            panic!("invalid status");
        }
        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap();
        let fee: i128 = (job.budget * (fee_bps as i128)) / BPS_DENOM;
        let payout: i128 = job.budget - fee;

        let token_client = token::TokenClient::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&contract_addr, &job.provider, &payout);
        if fee > 0 {
            let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
            token_client.transfer(&contract_addr, &treasury, &fee);
        }

        job.status = JobStatus::Completed;
        job.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Job(id), &job);

        JobCompleted {
            evaluator: caller,
            job_id: id,
            payout,
            fee,
            timestamp: env.ledger().timestamp(),
        }
        .publish(&env);
    }

    /// Client cancels a funded (not-yet-submitted) job and reclaims the full budget.
    pub fn cancel(env: Env, caller: Address, id: u64) {
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
        let token_client = token::TokenClient::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&contract_addr, &job.client, &job.budget);
        job.status = JobStatus::Cancelled;
        job.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Job(id), &job);

        JobCancelled {
            client: caller,
            job_id: id,
        }
        .publish(&env);
    }

    /// Admin updates the treasury address.
    pub fn set_treasury(env: Env, caller: Address, new_treasury: Address) {
        caller.require_auth();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic!("not admin");
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
    /// Returns `budget * fee_bps / 10_000`. No state is read or written.
    /// Intended for frontends that want to display the estimated fee before
    /// calling `create_job`.
    pub fn simulate_job_fee(_env: Env, budget: i128, fee_bps: u32) -> i128 {
        (budget * (fee_bps as i128)) / BPS_DENOM
    }

    /// Fetch a job by id.
    pub fn get_job(env: Env, id: u64) -> Option<Job> {
        env.storage().persistent().get(&DataKey::Job(id))
    }

    /// Contract version. Bump on ABI changes.
    pub fn version(_env: Env) -> u32 {
        1
    }

    /// Total number of jobs ever created (for dashboard stats).
    pub fn job_count(env: Env) -> u64 {
        let next: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1u64);
        next - 1
    }

    /// Buyer claims a full refund if provider never submitted and the timeout has passed.
    pub fn claim_refund(env: Env, caller: Address, id: u64) {
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
        let token_client = token::TokenClient::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&contract_addr, &job.client, &job.budget);
        job.status = JobStatus::Cancelled;
        job.updated_at = now;
        env.storage().persistent().set(&DataKey::Job(id), &job);

        JobRefunded {
            client: caller,
            job_id: id,
        }
        .publish(&env);
    }
}

#[cfg(test)]
mod test;
