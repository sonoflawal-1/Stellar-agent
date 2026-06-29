use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String};

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
    assert_eq!(client.version(), 1);
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

    let agent_a = client.get_agent(&id_a);
    assert_eq!(agent_a.owner, alice);
    assert_eq!(agent_a.uri, uri_a);

    assert_eq!(client.agent_of(&alice), Some(1u64));
    assert_eq!(client.agent_of(&bob), Some(2u64));
}

#[test]
#[should_panic(expected = "AlreadyRegistered")]
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

    let agent = client.get_agent(&id);
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
#[should_panic(expected = "AgentNotFound")]
fn deregister_removes_agent_and_owner_lookup() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentIdentityContract, ());
    let client = AgentIdentityContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let id = client.register(&alice, &String::from_str(&env, "ipfs://a.json"));
    client.deregister(&alice, &id);

    client.get_agent(&id);
    assert_eq!(client.agent_of(&alice), None);
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
