#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, String, Vec,
};

const MAX_METADATA_URI_LEN: u32 = 256; // prevents storage-griefing via oversized URI (#320)

// Soroban rent constants (#322).
// LEDGER_BUMP  — target TTL after every write/read (~30 days at ~5 s/ledger).
// LEDGER_THRESHOLD — minimum TTL before we bother bumping on a read (1 ledger
//                    means "always bump", keeping read-path behaviour simple).
const LEDGER_BUMP: u32 = 518_400; // 30 * 24 * 3_600 / 5
const LEDGER_THRESHOLD: u32 = 1;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    AgentNotFound = 1,
    AlreadyRegistered = 2,
}

/// A registered agent in the MARC agent-identity registry.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Agent {
    pub id: u64,
    pub owner: Address,
    pub uri: String,
}

#[contracttype]
enum DataKey {
    NextId,
    RegisteredCount,
    Agent(u64),
    OwnerToId(Address),
    Version,
}

// --- Events ---

/// Emitted when a new agent is registered.
#[contractevent]
pub struct Registered {
    #[topic]
    pub owner: Address,
    pub agent_id: u64,
}

/// Emitted when an agent owner updates their metadata URI.
#[contractevent]
pub struct UriUpdated {
    #[topic]
    pub owner: Address,
    pub agent_id: u64,
}

/// Emitted when an agent is removed from the registry.
#[contractevent]
pub struct AgentDeregistered {
    #[topic]
    pub owner: Address,
    pub agent_id: u64,
}

/// Emitted when an agent's owner address is transferred to a new wallet.
#[contractevent]
pub struct OwnerTransferred {
    #[topic]
    pub old_owner: Address,
    pub new_owner: Address,
    pub agent_id: u64,
}

#[contract]
pub struct AgentIdentityContract;

#[contractimpl]
impl AgentIdentityContract {
    /// Register a new agent owned by `owner`. Caller must sign for `owner`.
    /// Returns the newly-assigned sequential agent id (starts at 1).
    ///
    /// # ID Semantics
    ///
    /// Agent IDs are **append-only**. Once assigned, an ID is never reused,
    /// even if the corresponding agent is later deregistered. `next_id`
    /// therefore represents the total number of registrations ever performed,
    /// not the current number of active agents.
    pub fn register(env: Env, owner: Address, uri: String) -> u64 {
        owner.require_auth();

        if uri.len() == 0 {
            panic!("metadata_uri cannot be empty");
        }
        if uri.len() > MAX_METADATA_URI_LEN {
            panic!("metadata_uri too long");
        }

        if env
            .storage()
            .persistent()
            .has(&DataKey::OwnerToId(owner.clone()))
        {
            panic_with_error!(&env, Error::AlreadyRegistered);
        }

        let next: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u64);

        let agent = Agent {
            id: next,
            owner: owner.clone(),
            uri,
        };
        env.storage().persistent().set(&DataKey::Agent(next), &agent);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Agent(next), LEDGER_THRESHOLD, LEDGER_BUMP);
        env.storage()
            .persistent()
            .set(&DataKey::OwnerToId(owner.clone()), &next);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::OwnerToId(owner.clone()), LEDGER_THRESHOLD, LEDGER_BUMP);
        env.storage()
            .instance()
            .set(&DataKey::NextId, &next.checked_add(1).expect("agent id overflow"));

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RegisteredCount)
            .unwrap_or(0u32);
        env.storage()
            .instance()
            .set(&DataKey::RegisteredCount, &count.checked_add(1).expect("count overflow"));

        Registered {
            owner,
            agent_id: next,
        }
        .publish(&env);

        next
    }

    /// Update the metadata URI of an agent. Caller must be the current owner.
    pub fn update_uri(env: Env, caller: Address, id: u64, new_uri: String) {
        caller.require_auth();
        if new_uri.len() == 0 {
            panic!("metadata_uri cannot be empty");
        }
        if new_uri.len() > MAX_METADATA_URI_LEN {
            panic!("metadata_uri too long");
        }
        let mut agent: Agent = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(id))
            .unwrap_or_else(|| panic!("agent not found"));
        if agent.owner != caller {
            panic!("not agent owner");
        }
        agent.uri = new_uri;
        env.storage().persistent().set(&DataKey::Agent(id), &agent);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Agent(id), LEDGER_THRESHOLD, LEDGER_BUMP);

        UriUpdated {
            owner: caller,
            agent_id: id,
        }
        .publish(&env);
    }

    /// Remove an agent from the registry. Caller must be the current owner.
    /// Frees the OwnerToId slot so the same address can re-register later.
    pub fn deregister(env: Env, caller: Address, id: u64) {
        caller.require_auth();
        let agent: Agent = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(id))
            .unwrap_or_else(|| panic!("agent not found"));
        if agent.owner != caller {
            panic!("not agent owner");
        }
        env.storage().persistent().remove(&DataKey::Agent(id));
        // Only remove the OwnerToId mapping if it still points to this agent.
        // If the owner has since re-registered (getting a new agent id), the
        // mapping now points to the newer agent and must NOT be wiped. This
        // prevents a stale or replayed deregister call from corrupting the
        // registry. (Fixes issue #321.)
        let current_id: Option<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::OwnerToId(agent.owner.clone()));
        if current_id == Some(id) {
            env.storage()
                .persistent()
                .remove(&DataKey::OwnerToId(agent.owner.clone()));
        }

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RegisteredCount)
            .unwrap_or(0u32);
        env.storage()
            .instance()
            .set(&DataKey::RegisteredCount, &count.saturating_sub(1));

        AgentDeregistered {
            owner: agent.owner,
            agent_id: id,
        }
        .publish(&env);
    }

    /// Fetch an agent by id.
    ///
    /// Panics with `Error::AgentNotFound` if the agent does not exist or has
    /// been deregistered. Callers that need a fallback-safe lookup should call
    /// `is_registered` first, or use `list_agents` for batch queries.
    pub fn get_agent(env: Env, id: u64) -> Agent {
        let key = DataKey::Agent(id);
        let result: Option<Agent> = env.storage().persistent().get(&key);
        match result {
            Some(agent) => {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);
                agent
            }
            None => panic_with_error!(&env, Error::AgentNotFound),
        }
    }

    /// Returns true if `owner` currently has a registered agent. Equivalent
    /// to `agent_of(owner).is_some()` without needing to unwrap the id (#15).
    pub fn is_registered(env: Env, owner: Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::OwnerToId(owner))
    }

    /// Look up the agent id owned by `owner`, if any.
    pub fn agent_of(env: Env, owner: Address) -> Option<u64> {
        let key = DataKey::OwnerToId(owner);
        let result: Option<u64> = env.storage().persistent().get(&key);
        if result.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);
        }
        result
    }

    /// Transfer ownership of an agent to `new_owner`. Requires auth from both
    /// the current owner (`caller`) and the incoming `new_owner`.
    pub fn update_owner(env: Env, caller: Address, id: u64, new_owner: Address) {
        caller.require_auth();
        new_owner.require_auth();

        let mut agent: Agent = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(id))
            .unwrap_or_else(|| panic!("agent not found"));
        if agent.owner != caller {
            panic!("not agent owner");
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::OwnerToId(new_owner.clone()))
        {
            panic!("new owner already registered");
        }

        env.storage()
            .persistent()
            .remove(&DataKey::OwnerToId(agent.owner.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::OwnerToId(new_owner.clone()), &id);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::OwnerToId(new_owner.clone()), LEDGER_THRESHOLD, LEDGER_BUMP);

        let old_owner = agent.owner.clone();
        agent.owner = new_owner.clone();
        env.storage().persistent().set(&DataKey::Agent(id), &agent);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Agent(id), LEDGER_THRESHOLD, LEDGER_BUMP);

        OwnerTransferred {
            old_owner,
            new_owner,
            agent_id: id,
        }
        .publish(&env);
    }

    /// Returns up to `limit` agents starting from `start_id`, skipping gaps left
    /// by deregistered agents. Useful for paginated dashboard queries.
    pub fn list_agents(env: Env, start_id: u32, limit: u32) -> Vec<Agent> {
        let mut result = Vec::new(&env);
        let next_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u64);

        let mut id = start_id as u64;
        while result.len() < limit && id < next_id {
            if let Some(agent) = env.storage().persistent().get(&DataKey::Agent(id)) {
                result.push_back(agent);
            }
            id += 1;
        }
        result
    }

    /// Returns the number of currently-registered (non-deregistered) agents.
    pub fn registered_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::RegisteredCount)
            .unwrap_or(0u32)
    }

    /// Contract version. Read from instance storage if set, otherwise derived
    /// at compile time from the crate's Cargo.toml major version (#14), so it
    /// no longer needs a manual bump on every release.
    pub fn version(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Version).unwrap_or_else(|| {
            env!("CARGO_PKG_VERSION_MAJOR")
                .parse()
                .expect("invalid CARGO_PKG_VERSION_MAJOR")
        })
    }
}

#[cfg(test)]
mod test;
