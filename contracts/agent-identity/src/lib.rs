#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, String, Symbol, Vec,
};

const MAX_METADATA_URI_LEN: u32 = 256; // prevents storage-griefing via oversized URI (#320)
const EVENT_VERSION: u32 = 2;

// Soroban rent constants (#322).
// LEDGER_BUMP  — target TTL after every write/read (~30 days at ~5 s/ledger).
// LEDGER_THRESHOLD — minimum TTL before we bother bumping on a read (1 ledger
//                    means "always bump", keeping read-path behaviour simple).
const LEDGER_BUMP: u32 = 518_400; // 30 * 24 * 3_600 / 5
const LEDGER_THRESHOLD: u32 = 1;

// ---------------------------------------------------------------------------
// #696 — Delegate / WebAuthn permission constants
// ---------------------------------------------------------------------------

/// Delegate may call `update_uri` on behalf of the agent owner.
pub const PERM_UPDATE_URI: u32 = 0b0001;
/// Delegate may call `deregister` on behalf of the agent owner.
pub const PERM_DEREGISTER: u32 = 0b0010;
/// Delegate may call `transfer_owner` on behalf of the agent owner.
pub const PERM_TRANSFER: u32 = 0b0100;
/// All permissions combined.
pub const PERM_ALL: u32 = PERM_UPDATE_URI | PERM_DEREGISTER | PERM_TRANSFER;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    AgentNotFound = 1,
    AlreadyRegistered = 2,
    /// The delegate key has passed its `valid_until` timestamp. (#696)
    DelegateExpired = 3,
    /// The caller is not authorized (neither owner nor valid delegate). (#696)
    Unauthorized = 4,
    /// The delegate does not have the required permission bit set. (#696)
    InsufficientPermissions = 5,
    /// The supplied metadata URI is empty. (#782)
    UriEmpty = 6,
    /// The supplied metadata URI exceeds `MAX_METADATA_URI_LEN`. (#782)
    UriTooLong = 7,
    /// The supplied metadata URI is malformed (e.g. invalid UTF-8). (#782)
    InvalidUri = 8,
}

/// A registered agent in the MARC agent-identity registry.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Agent {
    pub id: u64,
    pub owner: Address,
    pub uri: String,
}

// ---------------------------------------------------------------------------
// #696 — Delegate struct
// ---------------------------------------------------------------------------

/// A time-bounded delegate key that can act on behalf of an agent owner.
///
/// Designed for autonomous AI agents running on cloud workers that cannot
/// safely store master private keys. The owner grants a scoped `delegate_address`
/// (e.g. an ephemeral session key or a WebAuthn passkey-backed address) with
/// a specific `permissions` bitmask and an expiry timestamp.
///
/// Fields:
/// - `delegate_address` — the address authorised to act as a delegate.
/// - `valid_until`       — Unix timestamp (seconds) after which the delegate
///                         is considered expired and must not be accepted.
/// - `permissions`       — bitmask of allowed operations (see `PERM_*` constants).
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Delegate {
    pub delegate_address: Address,
    pub valid_until: u64,
    pub permissions: u32,
}

// ---------------------------------------------------------------------------
// #701 — Capability badge / verifiable credential
// ---------------------------------------------------------------------------

/// An on-chain capability attestation issued by an authorised issuer.
///
/// Badges certify an agent's specialisations (e.g. Code Auditing, Translation,
/// Market Making) with a benchmark `score` and an expiry. They are soulbound:
/// they are bound to the agent id and cannot be transferred independently of
/// the agent.
///
/// Fields:
/// - `issuer`     — the address that minted the badge; the only address
///                  allowed to revoke it.
/// - `tag`        — the capability symbol (e.g. `code_audit`).
/// - `score`      — issuer-attested benchmark score (0..=u32::MAX).
/// - `issued_at`  — Unix timestamp (seconds) at issuance.
/// - `expires_at` — Unix timestamp (seconds) after which the badge is inactive.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Badge {
    pub issuer: Address,
    pub tag: Symbol,
    pub score: u32,
    pub issued_at: u64,
    pub expires_at: u64,
}

#[contracttype]
enum DataKey {
    NextId,
    RegisteredCount,
    Agent(u64),
    OwnerToId(Address),
    Version,
    Admin,
    /// Storage key for a delegate record: (agent_id, delegate_address). (#696)
    Delegate(u64, Address),
    /// Ordered list of delegate addresses for an agent, so ownership changes
    /// can invalidate them all. (#1045)
    DelegateIndex(u64),
    /// Storage key for a capability badge: (agent_id, tag). (#701)
    Badges(u64, Symbol),
    /// Admin-managed allowlist of addresses permitted to mint badges. (#701)
    AuthorizedIssuer(Address),
    /// Ordered badge tags stored for an agent so deregistration can remove them.
    BadgeTags(u64),
}

// --- Events ---

/// Emitted when a new agent is registered.
#[contractevent]
pub struct Registered {
    #[topic]
    pub version: u32,
    #[topic]
    pub owner: Address,
    pub agent_id: u64,
}

/// Emitted when an agent owner updates their metadata URI.
#[contractevent]
pub struct UriUpdated {
    #[topic]
    pub version: u32,
    #[topic]
    pub owner: Address,
    pub agent_id: u64,
}

/// Emitted when an agent is removed from the registry.
#[contractevent]
pub struct AgentDeregistered {
    #[topic]
    pub version: u32,
    #[topic]
    pub owner: Address,
    pub agent_id: u64,
}

/// Emitted when an agent's owner address is transferred to a new wallet.
#[contractevent]
pub struct OwnerTransferred {
    #[topic]
    pub version: u32,
    #[topic]
    pub old_owner: Address,
    pub new_owner: Address,
    pub agent_id: u64,
}

// --- #696 Delegate events ---

/// Emitted when a delegate is granted by an agent owner.
#[contractevent]
pub struct DelegateGranted {
    #[topic]
    pub version: u32,
    #[topic]
    pub owner: Address,
    pub agent_id: u64,
    pub delegate: Address,
    pub valid_until: u64,
    pub permissions: u32,
}

/// Emitted when a delegate is explicitly revoked by an agent owner.
#[contractevent]
pub struct DelegateRevoked {
    #[topic]
    pub version: u32,
    #[topic]
    pub owner: Address,
    pub agent_id: u64,
    pub delegate: Address,
}

// --- #701 Badge events ---

/// Emitted when a capability badge is minted for an agent.
#[contractevent]
pub struct BadgeIssued {
    #[topic]
    pub version: u32,
    #[topic]
    pub issuer: Address,
    pub agent_id: u64,
    pub tag: Symbol,
    pub score: u32,
    pub expires_at: u64,
}

/// Emitted when a capability badge is revoked by its issuer.
#[contractevent]
pub struct BadgeRevoked {
    #[topic]
    pub version: u32,
    #[topic]
    pub issuer: Address,
    pub agent_id: u64,
    pub tag: Symbol,
}

#[contract]
pub struct AgentIdentityContract;

/// Validate a metadata URI against the contract's strict bounds. (#782)
///
/// Fuzz-resilience guard: every write path (`register`, `update_uri`) funnels
/// through this helper so oversized or malformed inputs are rejected with a
/// clean `Error` variant instead of an unhandled panic.
///
/// Checks, in order:
/// 1. Non-empty — `Error::UriEmpty`.
/// 2. Length within `MAX_METADATA_URI_LEN` — `Error::UriTooLong`.
/// 3. Valid UTF-8 — `Error::InvalidUri`.
fn validate_uri(env: &Env, uri: &String) {
    let len = uri.len();
    if len == 0 {
        panic_with_error!(env, Error::UriEmpty);
    }
    if len > MAX_METADATA_URI_LEN {
        panic_with_error!(env, Error::UriTooLong);
    }
    // `String::to_bytes` yields the raw byte buffer; `Bytes::to_array` is
    // bounded, so we validate UTF-8 by round-tripping through `str::from_utf8`.
    let bytes = uri.to_bytes();
    let mut buf = [0u8; MAX_METADATA_URI_LEN as usize];
    let n = bytes.len() as usize;
    bytes.copy_into_slice(&mut buf[..n]);
    if core::str::from_utf8(&buf[..n]).is_err() {
        panic_with_error!(env, Error::InvalidUri);
    }
}

#[contractimpl]
impl AgentIdentityContract {
    /// Initializer. Sets the contract admin address.
    /// Panics if the contract has already been initialized.
    ///
    /// The admin is the only address authorised to call `upgrade()` and to
    /// manage the badge issuer allowlist. This must be called once after
    /// deployment before any `upgrade` can be performed.
    pub fn init(env: Env, admin: Address) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Upgrade the contract's WASM executable to a new hash.
    ///
    /// Only the current admin (set via `init`) may call this. After the call
    /// the contract immediately executes the new WASM for all future
    /// invocations while all persistent storage (agents, owner mappings, etc.)
    /// is preserved unchanged.
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
            panic!("not admin");
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Register a new agent owned by `owner`. Caller must sign for `owner`.
    /// Returns the newly-assigned sequential agent id (starts at 1).
    ///
    /// # ID Semantics
    ///
    /// Agent IDs are **append-only**. Once assigned, an ID is never reused,
    /// even if the corresponding agent is later deregistered. `next_id`
    /// therefore represents the total number of registrations ever performed,
    /// not the current number of active agents.
    ///
    /// # URI Bounds (#782)
    ///
    /// The `uri` is validated via `validate_uri`: empty, oversized, or
    /// malformed (non-UTF-8) inputs are rejected with a clean contract error.
    pub fn register(env: Env, owner: Address, uri: String) -> u64 {
        owner.require_auth();

        validate_uri(&env, &uri);

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
            version: EVENT_VERSION,
            owner,
            agent_id: next,
        }
        .publish(&env);

        next
    }

    /// Update the metadata URI of an agent. Caller must be the current owner.
    ///
    /// # URI Bounds (#782)
    ///
    /// The `new_uri` is validated via `validate_uri`: empty, oversized, or
    /// malformed (non-UTF-8) inputs are rejected with a clean contract error.
    pub fn update_uri(env: Env, caller: Address, id: u64, new_uri: String) {
        caller.require_auth();

        validate_uri(&env, &new_uri);

        let mut agent: Agent = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::AgentNotFound));
        if agent.owner != caller {
            panic!("not agent owner");
        }
        agent.uri = new_uri;
        env.storage().persistent().set(&DataKey::Agent(id), &agent);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Agent(id), LEDGER_THRESHOLD, LEDGER_BUMP);

        UriUpdated {
            version: EVENT_VERSION,
            owner: caller,
            agent_id: id,
        }
        .publish(&env);
    }

    /// Remove an agent from the registry. Caller must be the current owner.
    /// Frees the OwnerToId slot so the same address can re-register later.
    ///
    /// Any capability badges associated with the agent are archived (removed)
    /// so that stale credentials cannot outlive the agent they attest to.
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

        // #701 — archive/remove all badges bound to this agent so that
        // credentials cannot be resolved for a deregistered agent.
        let tags: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&DataKey::BadgeTags(id))
            .unwrap_or_else(|| Vec::new(&env));
        for tag in tags.iter() {
            env.storage().persistent().remove(&DataKey::Badges(id, tag));
        }
        env.storage().persistent().remove(&DataKey::BadgeTags(id));

        // #1045 — Clear any delegates bound to the deregistered agent.
        let delegates: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::DelegateIndex(id))
            .unwrap_or_else(|| Vec::new(&env));
        for delegate in delegates.iter() {
            env.storage()
                .persistent()
                .remove(&DataKey::Delegate(id, delegate));
        }
        env.storage().persistent().remove(&DataKey::DelegateIndex(id));

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RegisteredCount)
            .unwrap_or(0u32);
        env.storage()
            .instance()
            .set(&DataKey::RegisteredCount, &count.saturating_sub(1));

        AgentDeregistered {
            version: EVENT_VERSION,
            owner: agent.owner,
            agent_id: id,
        }
        .publish(&env);
    }

    /// Transfer ownership of an agent to a new wallet. Both the current owner
    /// and the new owner must authorize the transfer.
    pub fn update_owner(env: Env, caller: Address, id: u64, new_owner: Address) {
        caller.require_auth();
        if new_owner != caller {
            new_owner.require_auth();
        }
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
            panic_with_error!(&env, Error::AlreadyRegistered);
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
        agent.owner = new_owner.clone();
        env.storage().persistent().set(&DataKey::Agent(id), &agent);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Agent(id), LEDGER_THRESHOLD, LEDGER_BUMP);

        // #1045 — Invalidate all delegates granted by the previous owner so a
        // stale delegate cannot act on the agent after ownership changes. The
        // new owner must re-grant any delegates they wish to use.
        let old_delegates: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::DelegateIndex(id))
            .unwrap_or_else(|| Vec::new(&env));
        for delegate in old_delegates.iter() {
            env.storage()
                .persistent()
                .remove(&DataKey::Delegate(id, delegate));
        }
        env.storage().persistent().remove(&DataKey::DelegateIndex(id));

        OwnerTransferred {
=======
            version: EVENT_VERSION,
            old_owner: caller,
            new_owner,
            agent_id: id,
        }
        .publish(&env);
    }

    /// Backward-compatible alias for `update_owner`.
    pub fn transfer_owner(env: Env, caller: Address, id: u64, new_owner: Address) {
        Self::update_owner(env, caller, id, new_owner);
    }

    // -----------------------------------------------------------------------
    // #696 — Delegate management (WebAuthn passkey / session key support)
    // -----------------------------------------------------------------------

    /// Grant a delegate key for an agent.
    ///
    /// The `owner` must sign the transaction. The delegate is stored under
    /// `DataKey::Delegate(agent_id, delegate_address)` with the supplied
    /// `valid_until` Unix timestamp and `permissions` bitmask.
    ///
    /// # Parameters
    /// - `owner`       — current agent owner; must authorize this call.
    /// - `agent_id`    — the agent the delegate will act for.
    /// - `delegate`    — address of the delegate key (ephemeral key or passkey address).
    /// - `ttl`         — seconds from the current ledger timestamp until expiry.
    /// - `permissions` — bitmask of `PERM_*` constants (e.g. `PERM_UPDATE_URI`).
    ///
    /// Emits a `DelegateGranted` event on success.
    pub fn add_delegate(
        env: Env,
        owner: Address,
        agent_id: u64,
        delegate: Address,
        ttl: u64,
        permissions: u32,
    ) {
        owner.require_auth();

        // Verify the agent exists and is owned by `owner`.
        let agent: Agent = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(agent_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::AgentNotFound));
        if agent.owner != owner {
            panic_with_error!(&env, Error::Unauthorized);
        }

        let now: u64 = env.ledger().timestamp();
        let valid_until: u64 = now.saturating_add(ttl);

        let record = Delegate {
            delegate_address: delegate.clone(),
            valid_until,
            permissions,
        };

        let key = DataKey::Delegate(agent_id, delegate.clone());
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);

        // #1045 — Track the delegate address so an ownership change can
        // invalidate every delegate granted by the previous owner.
        let index_key = DataKey::DelegateIndex(agent_id);
        let mut delegates: Vec<Address> = env
            .storage()
            .persistent()
            .get(&index_key)
            .unwrap_or_else(|| Vec::new(&env));
        let mut present = false;
        for existing in delegates.iter() {
            if existing == delegate {
                present = true;
                break;
            }
        }
        if !present {
            delegates.push_back(delegate.clone());
            env.storage().persistent().set(&index_key, &delegates);
            env.storage()
                .persistent()
                .extend_ttl(&index_key, LEDGER_THRESHOLD, LEDGER_BUMP);
        }

        DelegateGranted {
            version: EVENT_VERSION,
            owner,
            agent_id,
            delegate,
            valid_until,
            permissions,
        }
        .publish(&env);
    }

    /// Revoke a previously-granted delegate for an agent (owner-only).
    ///
    /// Removes the `DataKey::Delegate(agent_id, delegate)` entry from
    /// persistent storage. The delegate will no longer be accepted by
    /// `check_delegate`. Emits a `DelegateRevoked` event on success.
    pub fn revoke_delegate(env: Env, owner: Address, agent_id: u64, delegate: Address) {
        owner.require_auth();

        let agent: Agent = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(agent_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::AgentNotFound));
        if agent.owner != owner {
            panic_with_error!(&env, Error::Unauthorized);
        }

        let key = DataKey::Delegate(agent_id, delegate.clone());
        if env.storage().persistent().has(&key) {
            env.storage().persistent().remove(&key);
        }

        // #1045 — Drop the address from the delegate index as well.
        let index_key = DataKey::DelegateIndex(agent_id);
        let delegates: Vec<Address> = env
            .storage()
            .persistent()
            .get(&index_key)
            .unwrap_or_else(|| Vec::new(&env));
        let mut remaining: Vec<Address> = Vec::new(&env);
        for existing in delegates.iter() {
            if existing != delegate {
                remaining.push_back(existing);
            }
        }
        if remaining.is_empty() {
            env.storage().persistent().remove(&index_key);
        } else {
            env.storage().persistent().set(&index_key, &remaining);
            env.storage()
                .persistent()
                .extend_ttl(&index_key, LEDGER_THRESHOLD, LEDGER_BUMP);
        }

        DelegateRevoked {
            version: EVENT_VERSION,
            owner,
            agent_id,
            delegate,
        }
        .publish(&env);
    }

    /// Read a delegate record for a given (agent_id, delegate_address) pair.
    ///
    /// Returns `None` if no delegate is stored, or if the record has expired.
    /// Callers should use this for informational purposes; the contract itself
    /// enforces expiry inside `check_delegate`.
    pub fn get_delegate(env: Env, agent_id: u64, delegate: Address) -> Option<Delegate> {
        let key = DataKey::Delegate(agent_id, delegate);
        let record: Option<Delegate> = env.storage().persistent().get(&key);
        match record {
            Some(ref d) if d.valid_until > env.ledger().timestamp() => {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);
                record
            }
            _ => None,
        }
    }

    /// Verify that `caller` is either the agent owner OR a non-expired delegate
    /// with at least `required_permission` bits set.
    ///
    /// Returns `Ok(())` if authorised, otherwise panics with:
    /// - `Error::AgentNotFound`           — agent does not exist
    /// - `Error::DelegateExpired`         — delegate record past `valid_until`
    /// - `Error::InsufficientPermissions` — delegate lacks the required bit
    /// - `Error::Unauthorized`            — caller is neither owner nor delegate
    pub fn check_delegate(
        env: Env,
        agent_id: u64,
        caller: Address,
        required_permission: u32,
    ) {
        let agent: Agent = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(agent_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::AgentNotFound));

        // Owner passes unconditionally.
        if agent.owner == caller {
            return;
        }

        // Check delegate record.
        let key = DataKey::Delegate(agent_id, caller.clone());
        let record: Option<Delegate> = env.storage().persistent().get(&key);

        match record {
            None => panic_with_error!(&env, Error::Unauthorized),
            Some(d) => {
                let now = env.ledger().timestamp();
                // #1045 — Expired at the exact boundary: a delegate is valid
                // only while `now < valid_until`.
                if now >= d.valid_until {
                    panic_with_error!(&env, Error::DelegateExpired);
                }
                if d.permissions & required_permission == 0 {
                    panic_with_error!(&env, Error::InsufficientPermissions);
                }
                // Valid non-expired delegate with sufficient permissions — pass.
            }
        }
    }

    // -----------------------------------------------------------------------
    // #701 — Capability badges / verifiable credentials
    // -----------------------------------------------------------------------

    /// Fetch an agent by its id. Returns `None` if no such agent exists.
    pub fn get_agent(env: Env, id: u64) -> Option<Agent> {
        let key = DataKey::Agent(id);
        let agent: Option<Agent> = env.storage().persistent().get(&key);
        if agent.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);
        }
        agent
    }

    /// Fetch an agent directly by its owner address in a single call.
    ///
    /// Resolves the owner's agent id from the `OwnerToId` index and returns
    /// the full `Agent` record, or `None` if the owner has no registered
    /// agent. This avoids the two-call `agent_of` + `get_agent` round trip.
    pub fn get_agent_by_owner(env: Env, owner: Address) -> Option<Agent> {
        let key = DataKey::OwnerToId(owner);
        let agent_id: Option<u64> = env.storage().persistent().get(&key);
        match agent_id {
            Some(id) => Self::get_agent(env, id),
            None => None,
        }
    }

    /// Return the agent id owned by `owner`, or `None` if none is registered.
    pub fn agent_of(env: Env, owner: Address) -> Option<u64> {
        env.storage().persistent().get(&DataKey::OwnerToId(owner))
    }

    /// Return whether an owner currently has a registered agent.
    pub fn is_registered(env: Env, owner: Address) -> bool {
        env.storage().persistent().has(&DataKey::OwnerToId(owner))
    }

    /// Return a bounded page of agents, skipping deregistered IDs.
    pub fn list_agents(env: Env, start_id: u32, limit: u32) -> Vec<Agent> {
        if limit > MAX_AGENT_PAGE_SIZE {
            panic!("page limit exceeds maximum");
        }
        let next_id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        let mut agents = Vec::new(&env);
        let mut id = start_id as u64;
        let mut included = 0u32;
        while id < next_id && included < limit {
            if let Some(agent) = Self::get_agent(env.clone(), id) {
                agents.push_back(agent);
                included += 1;
            }
            id += 1;
        }
        agents
    }

    /// Return the total number of agents ever registered (append-only).
    pub fn registered_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::RegisteredCount)
            .unwrap_or(0u32)
    }

    /// Return the next agent id that will be assigned on the next `register`.
    pub fn next_id(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u64)
    }

    /// Return the contract version marker.
    pub fn version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(0u32)
    }
}

#[cfg(test)]
mod test;
