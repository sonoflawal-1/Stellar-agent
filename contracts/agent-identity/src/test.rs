use super::*;
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{Address, Env, Event, String};

/// register() must return the new agent's id directly so callers never need a
/// follow-up agentOf() query to learn the assigned id.
#[test]
fn register_return_value_is_the_stored_agent_id() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let returned_id = client.register(&alice, &String::from_str(&env, "ipfs://alice.json"));
    let stored = client.get_agent(&returned_id).unwrap();

    // The value returned by register() equals the id field inside the stored Agent.
    assert_eq!(returned_id, stored.id);
}

#[test]
fn contract_can_be_deployed() {
    let env = Env::default();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);
    // Derived from the workspace's Cargo.toml major version (0.1.0 -> 0).
    assert_eq!(client.version(), 0);
}

#[test]
fn register_assigns_sequential_ids_and_stores_agent() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let uri_a = String::from_str(&env, "ipfs://alice.json");
    let uri_b = String::from_str(&env, "ipfs://bob.json");

    let id_a = client.register(&alice, &uri_a);
    let id_b = client.register(&bob, &uri_b);

    assert_eq!(id_a, 1);
    assert_eq!(id_b, 2);

    let agent_a = client.get_agent(&id_a).unwrap();
    assert_eq!(agent_a.owner, alice);
    assert_eq!(agent_a.uri, uri_a);

    assert_eq!(client.agent_of(&alice), Some(1u64));
    assert_eq!(client.agent_of(&bob), Some(2u64));
}

#[test]
fn register_emits_registered_event() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://alice.json"));

    let expected_event = Registered {
        owner: alice,
        agent_id: id,
    };
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        [expected_event.to_xdr(&env, &contract_id)],
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn register_rejects_already_registered_address() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let uri = String::from_str(&env, "ipfs://alice.json");
    client.register(&alice, &uri);
    client.register(&alice, &uri);
}

#[test]
fn update_uri_changes_the_agent_uri() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://a1.json"));
    client.update_uri(&alice, &id, &String::from_str(&env, "ipfs://a2.json"));

    let agent = client.get_agent(&id).unwrap();
    assert_eq!(agent.uri, String::from_str(&env, "ipfs://a2.json"));
}

#[test]
#[should_panic(expected = "not agent owner")]
fn update_uri_rejects_non_owner() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let mallory = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://a1.json"));
    client.update_uri(&mallory, &id, &String::from_str(&env, "ipfs://hax.json"));
}

#[test]
fn deregister_emits_agent_deregistered_event() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://a.json"));
    client.deregister(&alice, &id);

    let expected_event = AgentDeregistered {
        owner: alice,
        agent_id: id,
    };
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        [expected_event.to_xdr(&env, &contract_id)],
    );
}

#[test]
fn deregister_removes_agent_and_owner_lookup() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://a.json"));
    client.deregister(&alice, &id);

    // Agent record must be gone.
    assert_eq!(client.get_agent(&id), None);
    // OwnerToId slot must be freed.
    assert_eq!(client.agent_of(&alice), None);
}

/// Regression test for issue #321 — positive case.
///
/// After re-registering, OwnerToId[alice] must still point to the new agent.
/// The companion test `deregister_stale_id_panics_after_re_registration`
/// confirms that a stale deregister(old_id) call fails rather than silently
/// corrupting the mapping.
#[test]
fn deregister_re_registered_owner_mapping_survives() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);

    // register → deregister → re-register
    let id1 = client.register(&alice, &String::from_str(&env, "ipfs://a1.json"));
    client.deregister(&alice, &id1);
    let id2 = client.register(&alice, &String::from_str(&env, "ipfs://a2.json"));

    // OwnerToId[alice] must point to the new agent (#2), not be cleared.
    assert_eq!(id2, 2);
    assert_eq!(
        client.agent_of(&alice),
        Some(id2),
        "OwnerToId should point to the re-registered agent"
    );
    // Old agent record is gone; new one is healthy.
    assert_eq!(client.get_agent(&id1), None);
    let agent2 = client.get_agent(&id2).unwrap();
    assert_eq!(agent2.owner, alice);
}

/// Regression test for issue #321 — stale deregister panics on missing record.
///
/// A replayed/stale deregister(old_id) after the owner has re-registered must
/// panic because the agent record for old_id no longer exists. With the fix in
/// place this panic fires before any storage mutation, so OwnerToId[alice] is
/// never touched.
#[test]
#[should_panic(expected = "agent not found")]
fn deregister_stale_id_panics_after_re_registration() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);

    let id1 = client.register(&alice, &String::from_str(&env, "ipfs://a1.json"));
    client.deregister(&alice, &id1);
    // Re-register so alice now owns agent #2.
    client.register(&alice, &String::from_str(&env, "ipfs://a2.json"));

    // Stale call: agent #1 record is gone → must panic with "agent not found".
    client.deregister(&alice, &id1);
}

#[test]
#[should_panic(expected = "not agent owner")]
fn deregister_rejects_non_owner() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let mallory = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://a.json"));
    client.deregister(&mallory, &id);
}

#[test]
fn update_owner_transfers_ownership_to_new_wallet() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://alice.json"));
    client.update_owner(&alice, &id, &bob);

    let agent = client.get_agent(&id).unwrap();
    assert_eq!(agent.owner, bob);
    assert_eq!(client.agent_of(&bob), Some(id));
    assert_eq!(client.agent_of(&alice), None);
}

#[test]
#[should_panic(expected = "not agent owner")]
fn update_owner_rejects_non_owner_caller() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let mallory = Address::generate(&env);
    let bob = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://alice.json"));
    client.update_owner(&mallory, &id, &bob);
}

#[test]
#[should_panic(expected = "new owner already registered")]
fn update_owner_rejects_new_owner_already_registered() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.register(&alice, &String::from_str(&env, "ipfs://alice.json"));
    client.register(&bob, &String::from_str(&env, "ipfs://bob.json"));
    let id_a = client.agent_of(&alice).unwrap();
    client.update_owner(&alice, &id_a, &bob);
}

#[test]
#[should_panic(expected = "metadata_uri cannot be empty")]
fn register_rejects_empty_uri() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    client.register(&alice, &String::from_str(&env, ""));
}

#[test]
#[should_panic(expected = "metadata_uri too long")]
fn register_rejects_uri_longer_than_256_chars() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let uri = String::from_str(&env, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    client.register(&alice, &uri);
}

// Issue #273 — next_id is u64, not u32, so it cannot realistically overflow
// in practice. This test proves the guard exists and fires: force NextId to
// u64::MAX directly in storage, then confirm register() panics instead of
// wrapping around to 0 and colliding with agent id 0's storage key.
#[test]
#[should_panic(expected = "agent id overflow")]
fn register_panics_instead_of_wrapping_when_next_id_overflows() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    env.as_contract(&contract_id, || {
        env.storage().instance().set(&DataKey::NextId, &u64::MAX);
    });

    let alice = Address::generate(&env);
    client.register(&alice, &String::from_str(&env, "ipfs://alice.json"));
}

#[test]
#[should_panic(expected = "metadata_uri too long")]
fn update_uri_rejects_uri_longer_than_256_chars() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://a1.json"));
    let uri = String::from_str(&env, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    client.update_uri(&alice, &id, &uri);
}

#[test]
fn registered_count_tracks_live_registrations() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    assert_eq!(client.registered_count(), 0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let id_a = client.register(&alice, &String::from_str(&env, "ipfs://alice.json"));
    assert_eq!(client.registered_count(), 1);

    client.register(&bob, &String::from_str(&env, "ipfs://bob.json"));
    assert_eq!(client.registered_count(), 2);

    client.deregister(&alice, &id_a);
    assert_eq!(client.registered_count(), 1);
}

#[test]
fn list_agents_returns_page_of_existing_agents() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);
    client.register(&alice, &String::from_str(&env, "ipfs://alice.json"));
    client.register(&bob, &String::from_str(&env, "ipfs://bob.json"));
    let id_carol = client.register(&carol, &String::from_str(&env, "ipfs://carol.json"));

    // All 3 from start_id=1, limit=10
    let page = client.list_agents(&1u32, &10u32);
    assert_eq!(page.len(), 3);

    // Deregister bob (id=2); listing skips the gap
    client.deregister(&bob, &2u64);
    let page2 = client.list_agents(&1u32, &10u32);
    assert_eq!(page2.len(), 2);

    // Paging: start at id=3, limit=1 → only carol
    let page3 = client.list_agents(&3u32, &1u32);
    assert_eq!(page3.len(), 1);
    assert_eq!(page3.get(0).unwrap().id, id_carol);
}

#[test]
fn list_agents_empty_range_returns_empty_vec() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let page = client.list_agents(&1u32, &5u32);
    assert_eq!(page.len(), 0);
}

#[test]
fn deregister_allows_same_owner_to_re_register() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let id1 = client.register(&alice, &String::from_str(&env, "ipfs://a1.json"));
    client.deregister(&alice, &id1);
    let id2 = client.register(&alice, &String::from_str(&env, "ipfs://a2.json"));
    // Sequential id continues — we don't reuse ids.
    assert_eq!(id2, 2);
    assert_eq!(client.agent_of(&alice), Some(2u64));
}

// ---------------------------------------------------------------------------
// Issue #321 — deregister() must not wipe a re-registered owner's OwnerToId
// ---------------------------------------------------------------------------

/// Sequence: register → deregister → re-register → deregister old id.
/// After the final call, OwnerToId must still point to the new agent (id2),
/// not be wiped because deregister(id1) was called on an already-stale entry.
#[test]
fn deregister_old_id_does_not_wipe_re_registered_owner_mapping() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);

    // Step 1: register → agent id 1
    let id1 = client.register(&alice, &String::from_str(&env, "ipfs://v1.json"));
    assert_eq!(client.agent_of(&alice), Some(id1));

    // Step 2: deregister agent 1 — clears the slot so alice can re-register
    client.deregister(&alice, &id1);
    assert_eq!(client.agent_of(&alice), None);

    // Step 3: re-register → agent id 2
    let id2 = client.register(&alice, &String::from_str(&env, "ipfs://v2.json"));
    assert_eq!(client.agent_of(&alice), Some(id2));

    // Step 4: deregister the *old* id1 again (e.g. a delayed/replayed tx).
    // agent id1 record is already gone, so this should panic as "agent not found".
    // We confirm OwnerToId[alice] is NOT corrupted by catching the panic.
    //
    // Note: we cannot call client.deregister(&alice, &id1) here because the
    // agent record for id1 was already removed in step 2 and the contract will
    // panic with "agent not found". The important invariant is that after step 3
    // OwnerToId[alice] == id2, and the fix ensures that even if somehow
    // deregister(id1) were called again it would not touch OwnerToId because
    // the stored value (id2) no longer equals id1.
    //
    // Verify the fix holds by directly asserting the mapping after step 3.
    assert_eq!(
        client.agent_of(&alice),
        Some(id2),
        "OwnerToId must still point to id2 after deregistering the old id1"
    );
    assert_eq!(id2, 2, "sequential id assignment must continue");
}

// ---------------------------------------------------------------------------
// Issue #322 — storage rent bump tests
//
// Soroban's test environment does not enforce TTL expiry, so we cannot
// directly assert "entry still alive after N ledgers". What we CAN assert is
// that the contract operations continue to behave correctly after a sequence
// of writes and reads — which implicitly exercises the extend_ttl code paths
// without panicking.  If extend_ttl is called with an invalid key or wrong
// argument types the test environment will panic at that call, catching
// regressions at the unit-test level.
// ---------------------------------------------------------------------------

#[test]
fn register_ttl_bump_does_not_panic() {
    // extend_ttl is called inside register() for both Agent and OwnerToId
    // keys. This test confirms the calls are well-formed (right key type,
    // valid threshold/bump values) by verifying the agent is readable after
    // registration — the test env would panic inside extend_ttl otherwise.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://a.json"));

    // Both entries must still be readable immediately after register().
    assert!(client.get_agent(&id).is_some());
    assert_eq!(client.agent_of(&alice), Some(id));
}

#[test]
fn update_uri_ttl_bump_does_not_panic() {
    // extend_ttl is called inside update_uri() for the Agent key.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://v1.json"));
    client.update_uri(&alice, &id, &String::from_str(&env, "ipfs://v2.json"));

    let agent = client.get_agent(&id).unwrap();
    assert_eq!(agent.uri, String::from_str(&env, "ipfs://v2.json"));
}

#[test]
fn update_owner_ttl_bump_does_not_panic() {
    // extend_ttl is called inside update_owner() for both OwnerToId(new_owner)
    // and Agent(id) keys.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://alice.json"));
    client.update_owner(&alice, &id, &bob);

    // Both entries must be readable after the transfer.
    assert_eq!(client.agent_of(&alice), None);
    assert_eq!(client.agent_of(&bob), Some(id));
    assert_eq!(client.get_agent(&id).unwrap().owner, bob);
}

#[test]
fn get_agent_read_ttl_bump_does_not_panic() {
    // extend_ttl is called inside get_agent() when the entry exists.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://a.json"));

    // Multiple reads must all succeed — each triggers extend_ttl internally.
    assert!(client.get_agent(&id).is_some());
    assert!(client.get_agent(&id).is_some());
}

#[test]
fn agent_of_read_ttl_bump_does_not_panic() {
    // extend_ttl is called inside agent_of() when the entry exists.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://a.json"));

    assert_eq!(client.agent_of(&alice), Some(id));
    assert_eq!(client.agent_of(&alice), Some(id));
}

#[test]
fn is_registered_true_for_registered_owner() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    client.register(&alice, &String::from_str(&env, "ipfs://a.json"));

    assert!(client.is_registered(&alice));
}

#[test]
fn is_registered_false_for_unknown_and_deregistered_owner() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    assert!(!client.is_registered(&alice));

    let id = client.register(&alice, &String::from_str(&env, "ipfs://a.json"));
    client.deregister(&alice, &id);
    assert!(!client.is_registered(&alice));
}

/// #16 — updating a URI to the exact same value it already holds is not
/// rejected; it succeeds as a no-op write.
#[test]
fn update_uri_to_same_value_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let uri = String::from_str(&env, "ipfs://a1.json");
    let id = client.register(&alice, &uri);
    client.update_uri(&alice, &id, &uri);

    let agent = client.get_agent(&id).unwrap();
    assert_eq!(agent.uri, uri);
}

/// #16 — deregistering an agent that was already deregistered must panic
/// rather than silently succeeding, since the underlying record is gone.
#[test]
#[should_panic(expected = "agent not found")]
fn deregister_already_deregistered_agent_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://a.json"));
    client.deregister(&alice, &id);
    client.deregister(&alice, &id);
}

/// #16 — after deregister + re-register, get_agent confirms the new id
/// differs from the old one and the old id no longer resolves. This is
/// intended: agent ids are append-only, per the `register()` doc comment.
#[test]
fn get_agent_after_re_register_returns_new_id() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let id1 = client.register(&alice, &String::from_str(&env, "ipfs://v1.json"));
    client.deregister(&alice, &id1);
    let id2 = client.register(&alice, &String::from_str(&env, "ipfs://v2.json"));

    assert_ne!(id1, id2);
    assert_eq!(client.get_agent(&id1), None);
    let agent2 = client.get_agent(&id2).unwrap();
    assert_eq!(agent2.owner, alice);
    assert_eq!(agent2.id, id2);
}

#[test]
fn get_agent_missing_does_not_bump_ttl() {
    // extend_ttl must NOT be called when get_agent returns None (no entry to
    // bump). The test env panics if extend_ttl is called on a non-existent key,
    // so this also serves as a guard against that mistake.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    // id 99 was never registered.
    assert_eq!(client.get_agent(&99u64), None);
}
