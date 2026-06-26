#![no_std]
use soroban_sdk::{contract, contractevent, contractimpl, contracttype, contracterror, Address, Env, String};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    AgentNotFound = 1,
    AlreadyRegistered = 2,
}

/// A registered agent in the MARC agent-identity registry.
#[derive(Clone)]
#[contracttype]
pub struct Agent {
    pub id: u64,
    pub owner: Address,
    pub uri: String,
}

#[contracttype]
enum DataKey {
    NextId,
    Agent(u64),
    OwnerToId(Address),
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
pub struct Deregistered {
    #[topic]
    pub owner: Address,
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
            .set(&DataKey::OwnerToId(owner.clone()), &next);
        env.storage().instance().set(&DataKey::NextId, &(next + 1));

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
        env.storage()
            .persistent()
            .remove(&DataKey::OwnerToId(agent.owner.clone()));

        Deregistered {
            owner: agent.owner,
            agent_id: id,
        }
        .publish(&env);
    }

    /// Fetch an agent by id.
    pub fn get_agent(env: Env, id: u64) -> Agent {
        env.storage()
            .persistent()
            .get(&DataKey::Agent(id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::AgentNotFound))
    }

    /// Look up the agent id owned by `owner`, if any.
    pub fn agent_of(env: Env, owner: Address) -> Option<u64> {
        env.storage().persistent().get(&DataKey::OwnerToId(owner))
    }

    /// Contract version. Bump on ABI changes.
    pub fn version(_env: Env) -> u32 {
        1
    }
}

#[cfg(test)]
mod test;
