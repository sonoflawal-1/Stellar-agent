use super::*;
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, BytesN, Env, Event, String};

fn setup<'a>(env: &Env) -> (AgenticCommerceContractClient<'a>, Address, Address) {
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    let contract_id = env.register(AgenticCommerceContract, ());
    let client = AgenticCommerceContractClient::new(env, &contract_id);
    client.init(&admin, &treasury);
    (client, admin, treasury)
}

fn deploy_token<'a>(
    env: &Env,
    admin: &Address,
) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let contract = env.register_stellar_asset_contract_v2(admin.clone());
    let addr = contract.address();
    (
        addr.clone(),
        TokenClient::new(env, &addr),
        StellarAssetClient::new(env, &addr),
    )
}

/// Deterministic 32-byte content hash used across the hash-flow tests.
fn sample_hash(env: &Env) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = i as u8;
    }
    BytesN::from_array(env, &bytes)
}

/// create_job() must persist the description field so dashboards can display
/// human-readable job details without a separate metadata lookup.
#[test]
fn create_job_stores_and_returns_description() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);

    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let description = String::from_str(&env, "Generate a product description for SKU-42");
    let job_id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &description,
        &0u64,
        &0u32,
    );

    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.description, description);
}

#[test]
fn init_sets_admin_and_treasury() {
    let env = Env::default();
    env.mock_all_auths();
    let (_client, _admin, _treasury) = setup(&env);
}

#[test]
#[should_panic(expected = "already initialized")]
fn init_panics_on_double_init() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury) = setup(&env);
    // Second init() call should panic
    client.init(&admin, &treasury);
}

#[test]
fn re_init_updates_admin_and_treasury() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let new_admin = Address::generate(&env);
    let new_treasury = Address::generate(&env);
    client.re_init(&admin, &new_admin, &new_treasury);
    // Verify new admin can call admin-only functions
    let newest_treasury = Address::generate(&env);
    client.set_treasury(&new_admin, &newest_treasury);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn re_init_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, treasury) = setup(&env);
    let mallory = Address::generate(&env);
    client.re_init(&mallory, &mallory, &treasury);
}

#[test]
fn create_job_transfers_budget_into_escrow() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);

    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let evaluator = buyer.clone();

    let (token_addr, token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let contract_id = client.address.clone();
    let budget: i128 = 100_000;

    let job_id = client.create_job(
        &buyer,
        &seller,
        &evaluator,
        &token_addr,
        &budget,
        &String::from_str(&env, "ipfs://job.json"),
        &0u64,
        &0u32,
    );

    assert_eq!(job_id, 1);

    let expected_event = JobCreated {
        client: buyer.clone(),
        job_id,
        budget,
    };
    // `init()` now emits `Initialized` first, so we check the *last* event
    // for this contract rather than asserting the entire list length.
    let all_events = env.events().all().filter_by_contract(&contract_id);
    assert_eq!(
        all_events.events().last().unwrap().clone(),
        expected_event.to_xdr(&env, &contract_id),
    );

    assert_eq!(token.balance(&contract_id), 100_000);
    assert_eq!(token.balance(&buyer), 900_000);

    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::Funded);
    assert_eq!(job.budget, budget);
    assert_eq!(job.client, buyer);
    assert_eq!(job.provider, seller);
}

#[test]
fn submit_flips_status_and_records_deliverable() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "ipfs://job.json"),
        &0u64,
        &0u32,
    );

    let hash = sample_hash(&env);
    client.submit(
        &seller,
        &id,
        &String::from_str(&env, "ipfs://work.json"),
        &hash,
    );

    let expected_event = JobSubmitted {
        provider: seller,
        job_id: id,
        deliverable_hash: hash.clone(),
    };
    // `init()` emits `Initialized` so we verify the last event only.
    let all_events = env.events().all().filter_by_contract(&client.address);
    assert_eq!(
        all_events.events().last().unwrap().clone(),
        expected_event.to_xdr(&env, &client.address),
    );

    let job = client.get_job(&id).unwrap();
    assert_eq!(job.status, JobStatus::Submitted);
    assert_eq!(job.deliverable, String::from_str(&env, "ipfs://work.json"));
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn submit_rejects_non_provider() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let mallory = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "ipfs://job.json"),
        &0u64,
        &0u32,
    );
    client.submit(
        &mallory,
        &id,
        &String::from_str(&env, "ipfs://hax.json"),
        &sample_hash(&env),
    );
}

#[test]
#[should_panic(expected = "deliverable too long")]
fn submit_rejects_deliverable_longer_than_1024_chars() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "ipfs://job.json"),
        &0u64,
        &0u32,
    );

    let deliverable = String::from_str(&env, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    client.submit(&seller, &id, &deliverable, &sample_hash(&env));
}

#[test]
fn complete_splits_payout_99_1_between_provider_and_treasury() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "ipfs://job.json"),
        &0u64,
        &0u32,
    );
    let hash = sample_hash(&env);
    client.submit(
        &seller,
        &id,
        &String::from_str(&env, "ipfs://work.json"),
        &hash,
    );
    client.complete(&buyer, &id, &Some(hash));

    let expected_event = JobCompleted {
        evaluator: buyer.clone(),
        job_id: id,
        provider: seller.clone(),
        payout: 99_000,
        fee: 1_000,
        timestamp: env.ledger().timestamp(),
    };
    // `init()` emits `Initialized` so we verify the last event only.
    let all_events = env.events().all().filter_by_contract(&client.address);
    assert_eq!(
        all_events.events().last().unwrap().clone(),
        expected_event.to_xdr(&env, &client.address),
    );

    assert_eq!(token.balance(&seller), 99_000);
    assert_eq!(token.balance(&treasury), 1_000);
    assert_eq!(token.balance(&client.address), 0);
    let job = client.get_job(&id).unwrap();
    assert_eq!(job.status, JobStatus::Completed);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn complete_rejects_non_evaluator() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let mallory = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "ipfs://job.json"),
        &0u64,
        &0u32,
    );
    let hash = sample_hash(&env);
    client.submit(
        &seller,
        &id,
        &String::from_str(&env, "ipfs://work.json"),
        &hash,
    );
    client.complete(&mallory, &id, &Some(hash));
}

#[test]
fn cancel_refunds_buyer_when_not_yet_submitted() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "ipfs://job.json"),
        &0u64,
        &0u32,
    );
    assert_eq!(token.balance(&buyer), 900_000);

    client.cancel(&buyer, &id);

    let expected_event = JobCancelled {
        client: buyer.clone(),
        job_id: id,
    };
    // `init()` emits `Initialized` so we verify the last event only.
    let all_events = env.events().all().filter_by_contract(&client.address);
    assert_eq!(
        all_events.events().last().unwrap().clone(),
        expected_event.to_xdr(&env, &client.address),
    );

    assert_eq!(token.balance(&buyer), 1_000_000);
    assert_eq!(token.balance(&client.address), 0);
    let job = client.get_job(&id).unwrap();
    assert_eq!(job.status, JobStatus::Cancelled);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn cancel_rejects_non_client() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let mallory = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "ipfs://job.json"),
        &0u64,
        &0u32,
    );
    client.cancel(&mallory, &id);
}

#[test]
fn admin_can_update_treasury_and_fee_within_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let new_treasury = Address::generate(&env);
    client.set_treasury(&admin, &new_treasury);
    client.set_fee_bps(&admin, &200u32);
    assert_eq!(client.fee_bps(), 200);
}

#[test]
#[should_panic(expected = "fee too high")]
fn set_fee_bps_rejects_over_max() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    client.set_fee_bps(&admin, &501u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn set_treasury_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup(&env);
    let mallory = Address::generate(&env);
    let new_treasury = Address::generate(&env);
    client.set_treasury(&mallory, &new_treasury);
}

#[test]
#[should_panic(expected = "not initialized")]
fn create_job_rejects_call_before_init() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgenticCommerceContract, ());
    let client = AgenticCommerceContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    // init() was never called on this contract instance.
    client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "job before init"),
        &0u64,
        &0u32,
    );
}

// ---------------------------------------------------------------------------
// Issue #323 — party validation tests
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn create_job_rejects_client_as_provider() {
    // client == provider → SelfEscrow (error code 1)
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);

    let buyer = Address::generate(&env);
    let evaluator = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    // buyer is both client and provider — must be rejected.
    client.create_job(
        &buyer,
        &buyer,
        &evaluator,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "self-escrow attempt"),
        &0u64,
        &0u32,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn create_job_rejects_provider_as_evaluator() {
    // provider == evaluator → InvalidParties (error code 2)
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);

    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    // seller is both provider and evaluator — must be rejected.
    client.create_job(
        &buyer,
        &seller,
        &seller,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "provider-as-evaluator attempt"),
        &0u64,
        &0u32,
    );
}

#[test]
fn create_job_allows_client_as_evaluator() {
    // client == evaluator is explicitly permitted — this is the common pattern
    // used throughout the existing test suite (buyer self-approves).
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);

    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let job_id = client.create_job(
        &buyer,
        &seller,
        &buyer, // client == evaluator — allowed
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "buyer self-evaluates"),
        &0u64,
        &0u32,
    );

    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.client, buyer);
    assert_eq!(job.evaluator, buyer);
    assert_eq!(job.status, JobStatus::Funded);
}

// ===========================================================================
// #31 — Initialized event
// ===========================================================================

/// init() must emit an `Initialized` event so off-chain indexers can detect
/// when and by whom the contract was set up.
#[test]
fn init_emits_initialized_event() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let contract_id = env.register(AgenticCommerceContract, ());
    let client = AgenticCommerceContractClient::new(&env, &contract_id);

    client.init(&admin, &treasury);

    let expected = Initialized {
        admin: admin.clone(),
        treasury: treasury.clone(),
    };
    let all_events = env.events().all().filter_by_contract(&contract_id);
    assert_eq!(
        all_events.events().last().unwrap().clone(),
        expected.to_xdr(&env, &contract_id),
    );
}

// ===========================================================================
// #30 — Missing edge-case tests
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. Double-complete panics with InvalidStatus (#4)
// ---------------------------------------------------------------------------
#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn complete_panics_on_double_complete() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "job"),
        &0u64,
        &0u32,
    );
    let hash = sample_hash(&env);
    client.submit(&seller, &id, &String::from_str(&env, "deliverable"), &hash);
    client.complete(&buyer, &id, &Some(hash.clone())); // first complete — OK
    client.complete(&buyer, &id, &Some(hash)); // second complete — must panic
}

// ---------------------------------------------------------------------------
// 2. Complete by a non-evaluator panics with "not evaluator"
// ---------------------------------------------------------------------------
#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn complete_panics_when_called_by_non_evaluator() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let impostor = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer, // buyer is evaluator
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "job"),
        &0u64,
        &0u32,
    );
    let hash = sample_hash(&env);
    client.submit(&seller, &id, &String::from_str(&env, "deliverable"), &hash);
    // impostor is neither buyer nor seller — must be rejected
    client.complete(&impostor, &id, &Some(hash));
}

// ---------------------------------------------------------------------------
// 3. Submit by a non-provider panics with "not provider"
//    (also exercises the "non-provider" path with a distinct third address)
// ---------------------------------------------------------------------------
#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn submit_panics_when_called_by_non_provider() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let interloper = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "job"),
        &0u64,
        &0u32,
    );
    // interloper tries to submit on seller's behalf
    client.submit(
        &interloper,
        &id,
        &String::from_str(&env, "deliverable"),
        &sample_hash(&env),
    );
}

// ---------------------------------------------------------------------------
// 4. Fetching a non-existent job returns None
// ---------------------------------------------------------------------------
#[test]
fn get_job_returns_none_for_nonexistent_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup(&env);

    // No jobs have ever been created; id 9999 does not exist.
    assert!(client.get_job(&9999u64).is_none());
}

// ---------------------------------------------------------------------------
// JobNotFound (#5) — explicit error code tests
// ---------------------------------------------------------------------------

/// submit() on a non-existent job id must panic with JobNotFound (#5).
#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn submit_panics_with_job_not_found_for_unknown_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup(&env);
    let seller = Address::generate(&env);
    client.submit(
        &seller,
        &9999u64,
        &String::from_str(&env, "deliverable"),
        &sample_hash(&env),
    );
}

/// complete() on a non-existent job id must panic with JobNotFound (#5).
#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn complete_panics_with_job_not_found_for_unknown_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    client.complete(&buyer, &9999u64, &Some(sample_hash(&env)));
}

/// cancel() on a non-existent job id must panic with JobNotFound (#5).
#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn cancel_panics_with_job_not_found_for_unknown_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    client.cancel(&buyer, &9999u64);
}

// ---------------------------------------------------------------------------
// #21 — jobs_by_provider / jobs_by_client
// ---------------------------------------------------------------------------
#[test]
fn jobs_by_provider_returns_only_that_providers_jobs() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);

    let buyer = Address::generate(&env);
    let seller_a = Address::generate(&env);
    let seller_b = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let desc = String::from_str(&env, "job");
    let id_a1 = client.create_job(
        &buyer,
        &seller_a,
        &buyer,
        &token_addr,
        &1_000i128,
        &desc,
        &0u64,
        &0u32,
    );
    client.create_job(
        &buyer,
        &seller_b,
        &buyer,
        &token_addr,
        &1_000i128,
        &desc,
        &0u64,
        &0u32,
    );
    let id_a2 = client.create_job(
        &buyer,
        &seller_a,
        &buyer,
        &token_addr,
        &1_000i128,
        &desc,
        &0u64,
        &0u32,
    );

    let seller_a_jobs = client.jobs_by_provider(&seller_a, &1u64, &10u32);
    assert_eq!(seller_a_jobs.len(), 2);
    assert_eq!(seller_a_jobs.get(0).unwrap().id, id_a1);
    assert_eq!(seller_a_jobs.get(1).unwrap().id, id_a2);
}

#[test]
fn jobs_by_client_returns_only_that_clients_jobs() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);

    let buyer_a = Address::generate(&env);
    let buyer_b = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer_a, &1_000_000);
    stellar_token.mint(&buyer_b, &1_000_000);

    let desc = String::from_str(&env, "job");
    client.create_job(
        &buyer_a,
        &seller,
        &buyer_a,
        &token_addr,
        &1_000i128,
        &desc,
        &0u64,
        &0u32,
    );
    let id_b = client.create_job(
        &buyer_b,
        &seller,
        &buyer_b,
        &token_addr,
        &1_000i128,
        &desc,
        &0u64,
        &0u32,
    );

    let buyer_b_jobs = client.jobs_by_client(&buyer_b, &1u64, &10u32);
    assert_eq!(buyer_b_jobs.len(), 1);
    assert_eq!(buyer_b_jobs.get(0).unwrap().id, id_b);
}

#[test]
fn jobs_by_provider_respects_limit_and_start_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);

    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let desc = String::from_str(&env, "job");
    client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &1_000i128,
        &desc,
        &0u64,
        &0u32,
    );
    let id2 = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &1_000i128,
        &desc,
        &0u64,
        &0u32,
    );
    client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &1_000i128,
        &desc,
        &0u64,
        &0u32,
    );

    // limit=1 from the start returns only the first match.
    let first_page = client.jobs_by_provider(&seller, &1u64, &1u32);
    assert_eq!(first_page.len(), 1);

    // starting after job 1 skips it.
    let from_id2 = client.jobs_by_provider(&seller, &2u64, &10u32);
    assert_eq!(from_id2.len(), 2);
    assert_eq!(from_id2.get(0).unwrap().id, id2);
}

#[test]
fn jobs_by_provider_returns_empty_for_unknown_provider() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup(&env);

    let stranger = Address::generate(&env);
    let jobs = client.jobs_by_provider(&stranger, &1u64, &10u32);
    assert_eq!(jobs.len(), 0);
}

// ---------------------------------------------------------------------------
// 5. Cancelling an already-cancelled job panics with InvalidStatus (#4)
// ---------------------------------------------------------------------------
#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn cancel_panics_on_already_cancelled_job() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "job"),
        &0u64,
        &0u32,
    );
    client.cancel(&buyer, &id); // first cancel — OK
    client.cancel(&buyer, &id); // second cancel — must panic
}

// ---------------------------------------------------------------------------
// 6. set_treasury to the same value is a no-op that succeeds
// ---------------------------------------------------------------------------
#[test]
fn set_treasury_to_same_value_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury) = setup(&env);

    // Setting treasury to its current address must not panic.
    client.set_treasury(&admin, &treasury);
}

// ---------------------------------------------------------------------------
// 7. Fee at maximum (500 bps / 5%) computes correctly and completes
// ---------------------------------------------------------------------------
#[test]
fn complete_with_max_fee_bps_500_splits_correctly() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury) = setup(&env);

    // Set fee to the hard cap: 500 bps = 5%
    client.set_fee_bps(&admin, &500u32);
    assert_eq!(client.fee_bps(), 500);

    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let budget: i128 = 100_000;
    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &budget,
        &String::from_str(&env, "job"),
        &0u64,
        &0u32,
    );
    let hash = sample_hash(&env);
    client.submit(&seller, &id, &String::from_str(&env, "deliverable"), &hash);
    client.complete(&buyer, &id, &Some(hash));

    // 5% fee → fee = 5_000, payout = 95_000
    assert_eq!(token.balance(&seller), 95_000);
    assert_eq!(token.balance(&treasury), 5_000);
    assert_eq!(token.balance(&client.address), 0);

    let job = client.get_job(&id).unwrap();
    assert_eq!(job.status, JobStatus::Completed);
}

// ---------------------------------------------------------------------------
// 8. Fee at 0 bps: provider receives the full budget, treasury receives nothing
// ---------------------------------------------------------------------------
#[test]
fn complete_with_zero_fee_bps_sends_full_budget_to_provider() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury) = setup(&env);

    // Set fee to zero — should be accepted (0 is within [0, 500]).
    client.set_fee_bps(&admin, &0u32);
    assert_eq!(client.fee_bps(), 0);

    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    let budget: i128 = 100_000;
    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &budget,
        &String::from_str(&env, "job"),
        &0u64,
        &0u32,
    );
    let hash = sample_hash(&env);
    client.submit(&seller, &id, &String::from_str(&env, "deliverable"), &hash);
    client.complete(&buyer, &id, &Some(hash));

    assert_eq!(token.balance(&seller), budget);
    assert_eq!(token.balance(&treasury), 0);
    assert_eq!(token.balance(&client.address), 0);
}
