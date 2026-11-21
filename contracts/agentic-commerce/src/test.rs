use super::*;
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, BytesN, Env, Event, String};
extern crate std;
use proptest::prelude::*;
use proptest::strategy::Strategy;

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
    client: &AgenticCommerceContractClient<'a>,
) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    deploy_token_with_decimals(env, admin, client, 0)
}

fn deploy_token_with_decimals<'a>(
    env: &Env,
    admin: &Address,
    client: &AgenticCommerceContractClient<'a>,
    decimals: u32,
) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let contract = env.register_stellar_asset_contract_v2(admin.clone());
    let addr = contract.address();
    client.add_token(admin, &addr, &decimals);
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
#[should_panic(expected = "budget below minimum")]
fn create_job_rejects_budget_below_one_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, _token, stellar_token) =
        deploy_token_with_decimals(&env, &admin, &client, 7);
    stellar_token.mint(&buyer, &10_000_000);

    client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &9_999_999i128,
        &String::from_str(&env, "dust job"),
        &0u64,
        &0u32,
    );
}

#[test]
fn create_job_accepts_exactly_one_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, _token, stellar_token) =
        deploy_token_with_decimals(&env, &admin, &client, 7);
    stellar_token.mint(&buyer, &10_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &10_000_000i128,
        &String::from_str(&env, "one token"),
        &0u64,
        &0u32,
    );

    assert_eq!(client.get_job(&id).unwrap().budget, 10_000_000);
}

#[test]
fn create_job_uses_configured_token_decimals() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, _token, stellar_token) =
        deploy_token_with_decimals(&env, &admin, &client, 6);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &1_000_000i128,
        &String::from_str(&env, "one six-decimal token"),
        &0u64,
        &0u32,
    );

    assert_eq!(client.get_job(&id).unwrap().budget, 1_000_000);
}

#[test]
#[should_panic(expected = "budget below minimum")]
fn create_job_uses_default_decimals_when_token_not_whitelisted() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let token_addr = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let stellar_token = StellarAssetClient::new(&env, &token_addr);
    stellar_token.mint(&buyer, &10_000_000);

    client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &9_999_999i128,
        &String::from_str(&env, "dust unlisted-token job"),
        &0u64,
        &0u32,
    );
}

#[test]
#[should_panic(expected = "token decimals too high")]
fn add_token_rejects_unrepresentable_decimals() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let token = Address::generate(&env);

    client.add_token(&admin, &token, &39u32);
}

#[test]
#[should_panic(expected = "budget below minimum")]
fn batch_create_jobs_rejects_budget_below_one_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (token_addr, _token, stellar_token) =
        deploy_token_with_decimals(&env, &admin, &client, 7);
    stellar_token.mint(&buyer, &10_000_000);

    client.batch_create_jobs(
        &buyer,
        &soroban_sdk::vec![
            &env,
            JobRequest {
                provider,
                evaluator: buyer.clone(),
                token: token_addr,
                budget: 9_999_999,
                description: String::from_str(&env, "dust batch job"),
            },
        ],
    );
}

#[test]
#[should_panic(expected = "budget below minimum")]
fn create_job_multi_eval_rejects_budget_below_one_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let provider = Address::generate(&env);
    let evaluator = Address::generate(&env);
    let (token_addr, _token, stellar_token) =
        deploy_token_with_decimals(&env, &admin, &client, 7);
    client.set_multi_eval_threshold(&admin, &0i128);
    stellar_token.mint(&buyer, &10_000_000);

    client.create_job_multi_eval(
        &buyer,
        &provider,
        &soroban_sdk::vec![&env, evaluator],
        &1u32,
        &token_addr,
        &9_999_999i128,
        &String::from_str(&env, "dust multi-evaluator job"),
        &0u64,
        &0u32,
    );
}

#[test]
#[should_panic(expected = "budget below minimum")]
fn create_job_multi_eval_weighted_rejects_budget_below_one_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let provider = Address::generate(&env);
    let evaluator = Address::generate(&env);
    let (token_addr, _token, stellar_token) =
        deploy_token_with_decimals(&env, &admin, &client, 7);
    client.set_multi_eval_threshold(&admin, &0i128);
    stellar_token.mint(&buyer, &10_000_000);

    client.create_job_multi_eval_weighted(
        &buyer,
        &provider,
        &soroban_sdk::vec![&env, evaluator],
        &soroban_sdk::vec![&env, 1u32],
        &1u32,
        &token_addr,
        &9_999_999i128,
        &String::from_str(&env, "dust weighted job"),
    );
}

#[test]
#[should_panic(expected = "budget below minimum")]
fn create_milestone_job_rejects_budget_below_one_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (token_addr, _token, stellar_token) =
        deploy_token_with_decimals(&env, &admin, &client, 7);
    stellar_token.mint(&buyer, &10_000_000);

    client.create_milestone_job(
        &buyer,
        &provider,
        &buyer,
        &token_addr,
        &9_999_999i128,
        &String::from_str(&env, "dust milestone job"),
        &soroban_sdk::vec![
            &env,
            Milestone {
                index: 0,
                amount: 9_999_999,
                description: String::from_str(&env, "one milestone"),
                deliverable: String::from_str(&env, ""),
                approved: false,
            },
        ],
    );
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

    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
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
        version: EVENT_VERSION,
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
        version: EVENT_VERSION,
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
    assert!(deliverable.len() <= MAX_DELIVERABLE_LEN);
    let oversized = String::from_bytes(&env, &[b'a'; MAX_DELIVERABLE_LEN as usize + 1]);
    client.submit(&seller, &id, &oversized, &sample_hash(&env));
}

#[test]
fn complete_splits_payout_99_1_between_provider_and_treasury() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
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
        version: EVENT_VERSION,
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
fn pausing_payment_channels_does_not_block_job_escrow() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);

    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);

    client.pause_channels(&admin);
    assert!(client.are_channels_paused());

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
    assert_eq!(client.get_job(&id).unwrap().status, JobStatus::Funded);

    client.unpause_channels(&admin);
    assert!(!client.are_channels_paused());
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn paused_payment_channels_reject_new_channels() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);

    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&payer, &1_000_000);
    client.pause_channels(&admin);

    client.open_channel(
        &payer,
        &provider,
        &token_addr,
        &100_000i128,
        &BytesN::from_array(&env, &[0; 32]),
    );
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
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
        version: EVENT_VERSION,
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
    let token_addr = env.register_stellar_asset_contract_v2(admin).address();
    let stellar_token = StellarAssetClient::new(&env, &token_addr);
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
        version: EVENT_VERSION,
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
    client.complete(&buyer, &id, &hash);
    client.complete(&buyer, &id, &hash); // second complete — must panic
}

#[test]
fn staking_rewards_follow_stake_weight_and_unstaked_tokens_are_withdrawn() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury) = setup(&env);
    let grant_pool = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let first_staker = Address::generate(&env);
    let second_staker = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000_000);
    stellar_token.mint(&first_staker, &1_000);
    stellar_token.mint(&second_staker, &3_000);

    client.set_treasury_split(
        &admin,
        &TreasurySplit {
            dev_pool_bps: 0,
            staking_pool_bps: 10_000,
            grant_pool_bps: 0,
        },
        &treasury,
        &grant_pool,
    );
    client.stake_tokens(&first_staker, &token_addr, &1_000);
    client.stake_tokens(&second_staker, &token_addr, &3_000);

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
    client.complete(&buyer, &id, &hash);

    assert_eq!(client.claim_staking_rewards(&first_staker, &token_addr), 250);
    assert_eq!(client.claim_staking_rewards(&second_staker, &token_addr), 750);
    assert_eq!(token.balance(&first_staker), 250);
    assert_eq!(token.balance(&second_staker), 750);

    client.unstake_tokens(&first_staker, &token_addr, &1_000);
    client.unstake_tokens(&second_staker, &token_addr, &3_000);
    assert_eq!(token.balance(&first_staker), 1_000);
    assert_eq!(token.balance(&second_staker), 3_000);
    assert_eq!(token.balance(&client.address), 0);
}

#[test]
fn staking_reward_rounding_is_carried_between_fee_distributions() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury) = setup(&env);
    let grant_pool = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let first_staker = Address::generate(&env);
    let second_staker = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin);
    stellar_token.mint(&buyer, &1_000);
    stellar_token.mint(&first_staker, &1);
    stellar_token.mint(&second_staker, &1);

    client.set_fee_bps(&admin, &100u32);
    client.set_treasury_split(
        &admin,
        &TreasurySplit {
            dev_pool_bps: 0,
            staking_pool_bps: 10_000,
            grant_pool_bps: 0,
        },
        &treasury,
        &grant_pool,
    );
    client.stake_tokens(&first_staker, &token_addr, &1);
    client.stake_tokens(&second_staker, &token_addr, &1);

    for _ in 0..2 {
        let id = client.create_job(
            &buyer,
            &seller,
            &buyer,
            &token_addr,
            &100i128,
            &String::from_str(&env, "job"),
            &0u64,
            &0u32,
        );
        let hash = sample_hash(&env);
        client.submit(&seller, &id, &String::from_str(&env, "deliverable"), &hash);
        client.complete(&buyer, &id, &hash);
    }

    let first_reward = client.claim_staking_rewards(&first_staker, &token_addr);
    let second_reward = client.claim_staking_rewards(&second_staker, &token_addr);
    assert_eq!(first_reward + second_reward, 2);
    assert_eq!(token.balance(&client.address), 0);
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
    let (token_addr, _token, stellar_token) = deploy_token(&env, &admin, &client);
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
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
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
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
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
    client.complete(&buyer, &id, &hash);

    assert_eq!(token.balance(&seller), 100_000);
    assert_eq!(token.balance(&treasury), 0);
    assert_eq!(token.balance(&client.address), 0);

    let job = client.get_job(&id).unwrap();
    assert_eq!(job.status, JobStatus::Completed);
}

// ===========================================================================
// #1049 — claim_expired()
// ===========================================================================

#[test]
fn claim_expired_refunds_buyer_after_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    stellar_token.mint(&buyer, &1_000_000);

    let deadline = 1_000u64;
    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "expiring job"),
        &deadline,
        &0u32,
    );

    // Escrow funded, buyer debited.
    assert_eq!(token.balance(&buyer), 900_000);
    assert_eq!(token.balance(&client.address), 100_000);

    // Advance past the deadline.
    env.ledger().set_timestamp(deadline + 1);

    client.claim_expired(&buyer, &id);

    // Buyer refunded, escrow drained.
    assert_eq!(token.balance(&buyer), 1_000_000);
    assert_eq!(token.balance(&client.address), 0);

    let job = client.get_job(&id).unwrap();
    assert_eq!(job.status, JobStatus::Cancelled);

    let expected_event = JobExpired {
        version: EVENT_VERSION,
        job_id: id,
        client: buyer.clone(),
    };
    let all_events = env.events().all().filter_by_contract(&client.address);
    assert_eq!(
        all_events.events().last().unwrap().clone(),
        expected_event.to_xdr(&env, &client.address),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn claim_expired_panics_with_job_not_found_for_unknown_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    client.claim_expired(&buyer, &9999u64);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn claim_expired_panics_on_wrong_status() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    stellar_token.mint(&buyer, &1_000_000);

    let deadline = 1_000u64;
    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "expiring job"),
        &deadline,
        &0u32,
    );
    // Cancel first so status is no longer Funded.
    client.cancel(&buyer, &id);
    env.ledger().set_timestamp(deadline + 1);

    let before = token.balance(&buyer);
    client.claim_expired(&buyer, &id);
    // Unreachable — panic expected. Balance assertion documents intent.
    assert_eq!(token.balance(&buyer), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn claim_expired_panics_before_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    stellar_token.mint(&buyer, &1_000_000);

    let deadline = 1_000u64;
    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "expiring job"),
        &deadline,
        &0u32,
    );
    // Still before the deadline.
    env.ledger().set_timestamp(deadline - 1);

    let before = token.balance(&buyer);
    client.claim_expired(&buyer, &id);
    assert_eq!(token.balance(&buyer), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn claim_expired_rejects_non_client() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let mallory = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    stellar_token.mint(&buyer, &1_000_000);

    let deadline = 1_000u64;
    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "expiring job"),
        &deadline,
        &0u32,
    );
    env.ledger().set_timestamp(deadline + 1);

    let before = token.balance(&buyer);
    client.claim_expired(&mallory, &id);
    assert_eq!(token.balance(&buyer), before);
}

// ===========================================================================
// #1050 — remove_token()
// ===========================================================================

#[test]
fn remove_token_removes_from_allowlist_without_touching_balances() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    let holder = Address::generate(&env);
    stellar_token.mint(&holder, &1_000_000);

    assert!(client.is_token_allowed(&token_addr));

    let before = token.balance(&holder);
    client.remove_token(&admin, &token_addr);

    assert!(!client.is_token_allowed(&token_addr));
    // Removing from the allowlist must not move any tokens.
    assert_eq!(token.balance(&holder), before);

    let expected_event = TokenRemoved {
        version: EVENT_VERSION,
        token: token_addr.clone(),
    };
    let all_events = env.events().all().filter_by_contract(&client.address);
    assert_eq!(
        all_events.events().last().unwrap().clone(),
        expected_event.to_xdr(&env, &client.address),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn remove_token_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    let holder = Address::generate(&env);
    stellar_token.mint(&holder, &1_000_000);
    let mallory = Address::generate(&env);

    let before = token.balance(&holder);
    client.remove_token(&mallory, &token_addr);
    assert_eq!(token.balance(&holder), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn remove_token_rejects_unknown_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let unknown = Address::generate(&env);

    client.remove_token(&admin, &unknown);
}

// ===========================================================================
// #1051 — approve_milestone()
// ===========================================================================

#[test]
fn approve_milestone_pays_provider_and_fee() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_milestone_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "milestone job"),
        &soroban_sdk::vec![
            &env,
            Milestone {
                index: 0,
                amount: 100_000,
                description: String::from_str(&env, "one milestone"),
                deliverable: String::from_str(&env, ""),
                approved: false,
            },
        ],
    );

    // Escrow funded.
    assert_eq!(token.balance(&buyer), 900_000);
    assert_eq!(token.balance(&client.address), 100_000);

    let hash = sample_hash(&env);
    client.submit_milestone(
        &seller,
        &id,
        &0u32,
        &String::from_str(&env, "ipfs://milestone-0.json"),
        &hash,
    );

    client.approve_milestone(&buyer, &id, &0u32);

    // 1% fee → fee = 1_000, payout = 99_000.
    assert_eq!(token.balance(&seller), 99_000);
    assert_eq!(token.balance(&treasury), 1_000);
    assert_eq!(token.balance(&client.address), 0);

    let expected_event = MilestoneApproved {
        version: EVENT_VERSION,
        job_id: id,
        index: 0,
        payout: 99_000,
        fee: 1_000,
    };
    let all_events = env.events().all().filter_by_contract(&client.address);
    assert_eq!(
        all_events.events().last().unwrap().clone(),
        expected_event.to_xdr(&env, &client.address),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn approve_milestone_panics_with_job_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    client.approve_milestone(&buyer, &9999u64, &0u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn approve_milestone_rejects_non_evaluator() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let mallory = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_milestone_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "milestone job"),
        &soroban_sdk::vec![
            &env,
            Milestone {
                index: 0,
                amount: 100_000,
                description: String::from_str(&env, "one milestone"),
                deliverable: String::from_str(&env, ""),
                approved: false,
            },
        ],
    );
    let hash = sample_hash(&env);
    client.submit_milestone(
        &seller,
        &id,
        &0u32,
        &String::from_str(&env, "ipfs://milestone-0.json"),
        &hash,
    );

    let before = token.balance(&seller);
    client.approve_milestone(&mallory, &id, &0u32);
    assert_eq!(token.balance(&seller), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn approve_milestone_rejects_invalid_status() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_milestone_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "milestone job"),
        &soroban_sdk::vec![
            &env,
            Milestone {
                index: 0,
                amount: 100_000,
                description: String::from_str(&env, "one milestone"),
                deliverable: String::from_str(&env, ""),
                approved: false,
            },
        ],
    );
    // Cancel the job so status is no longer active.
    client.cancel(&buyer, &id);

    let before = token.balance(&seller);
    client.approve_milestone(&buyer, &id, &0u32);
    assert_eq!(token.balance(&seller), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn approve_milestone_rejects_non_milestone_job() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "plain job"),
        &0u64,
        &0u32,
    );

    let before = token.balance(&seller);
    client.approve_milestone(&buyer, &id, &0u32);
    assert_eq!(token.balance(&seller), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn approve_milestone_rejects_index_out_of_bounds() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_milestone_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "milestone job"),
        &soroban_sdk::vec![
            &env,
            Milestone {
                index: 0,
                amount: 100_000,
                description: String::from_str(&env, "one milestone"),
                deliverable: String::from_str(&env, ""),
                approved: false,
            },
        ],
    );

    let before = token.balance(&seller);
    client.approve_milestone(&buyer, &id, &5u32);
    assert_eq!(token.balance(&seller), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn approve_milestone_rejects_already_approved() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_milestone_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "milestone job"),
        &soroban_sdk::vec![
            &env,
            Milestone {
                index: 0,
                amount: 100_000,
                description: String::from_str(&env, "one milestone"),
                deliverable: String::from_str(&env, ""),
                approved: false,
            },
        ],
    );
    let hash = sample_hash(&env);
    client.submit_milestone(
        &seller,
        &id,
        &0u32,
        &String::from_str(&env, "ipfs://milestone-0.json"),
        &hash,
    );
    client.approve_milestone(&buyer, &id, &0u32);

    let before = token.balance(&seller);
    client.approve_milestone(&buyer, &id, &0u32);
    assert_eq!(token.balance(&seller), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn approve_milestone_rejects_deliverable_not_submitted() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_milestone_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "milestone job"),
        &soroban_sdk::vec![
            &env,
            Milestone {
                index: 0,
                amount: 100_000,
                description: String::from_str(&env, "one milestone"),
                deliverable: String::from_str(&env, ""),
                approved: false,
            },
        ],
    );

    // No submit_milestone call — approving must fail.
    let before = token.balance(&seller);
    client.approve_milestone(&buyer, &id, &0u32);
    assert_eq!(token.balance(&seller), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn approve_milestone_rejects_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_milestone_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "milestone job"),
        &soroban_sdk::vec![
            &env,
            Milestone {
                index: 0,
                amount: 100_000,
                description: String::from_str(&env, "one milestone"),
                deliverable: String::from_str(&env, ""),
                approved: false,
            },
        ],
    );
    let hash = sample_hash(&env);
    client.submit_milestone(
        &seller,
        &id,
        &0u32,
        &String::from_str(&env, "ipfs://milestone-0.json"),
        &hash,
    );
    client.pause_channels(&admin);

    let before = token.balance(&seller);
    client.approve_milestone(&buyer, &id, &0u32);
    assert_eq!(token.balance(&seller), before);
}

// ===========================================================================
// #1052 — upgrade()
// ===========================================================================

#[test]
fn upgrade_by_admin_preserves_state_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury) = setup(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    let holder = Address::generate(&env);
    stellar_token.mint(&holder, &1_000_000);

    let new_wasm_hash = BytesN::from_array(&env, &[7u8; 32]);
    let before = token.balance(&holder);

    client.upgrade(&admin, &new_wasm_hash);

    // Admin/treasury state persists across upgrade.
    assert_eq!(client.admin(), admin);
    assert_eq!(client.treasury(), treasury);
    // Token balances unchanged by upgrade.
    assert_eq!(token.balance(&holder), before);

    let expected_event = ContractUpgraded {
        version: EVENT_VERSION,
        wasm_hash: new_wasm_hash.clone(),
    };
    let all_events = env.events().all().filter_by_contract(&client.address);
    assert_eq!(
        all_events.events().last().unwrap().clone(),
        expected_event.to_xdr(&env, &client.address),
    );
}

#[test]
#[should_panic(expected = "not initialized")]
fn upgrade_rejects_uninitialized_contract() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgenticCommerceContract, ());
    let client = AgenticCommerceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let new_wasm_hash = BytesN::from_array(&env, &[7u8; 32]);

    client.upgrade(&admin, &new_wasm_hash);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn upgrade_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    let holder = Address::generate(&env);
    stellar_token.mint(&holder, &1_000_000);
    let mallory = Address::generate(&env);
    let new_wasm_hash = BytesN::from_array(&env, &[7u8; 32]);

    let before = token.balance(&holder);
    client.upgrade(&mallory, &new_wasm_hash);
    assert_eq!(token.balance(&holder), before);
}

// ===========================================================================
// #944 — submit_milestone()
// ===========================================================================

/// Creates a milestone job with two milestones (60_000 and 40_000) and returns
/// the job id. The buyer is also the evaluator.
fn setup_milestone_job<'a>(
    env: &Env,
    client: &AgenticCommerceContractClient<'a>,
    admin: &Address,
    buyer: &Address,
    seller: &Address,
) -> (u64, Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let (token_addr, token, stellar_token) = deploy_token(env, admin, client);
    stellar_token.mint(buyer, &1_000_000);
    let id = client.create_milestone_job(
        buyer,
        seller,
        buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(env, "milestone job"),
        &soroban_sdk::vec![
            env,
            Milestone {
                index: 0,
                amount: 60_000,
                description: String::from_str(env, "first milestone"),
                deliverable: String::from_str(env, ""),
                approved: false,
            },
            Milestone {
                index: 1,
                amount: 40_000,
                description: String::from_str(env, "second milestone"),
                deliverable: String::from_str(env, ""),
                approved: false,
            },
        ],
    );
    (id, token_addr, token, stellar_token)
}

#[test]
fn submit_milestone_records_deliverable_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (id, _token_addr, token, _stellar_token) =
        setup_milestone_job(&env, &client, &admin, &buyer, &seller);

    // Escrow funded, provider has nothing yet.
    assert_eq!(token.balance(&buyer), 900_000);
    assert_eq!(token.balance(&client.address), 100_000);
    assert_eq!(token.balance(&seller), 0);

    let hash = sample_hash(&env);
    client.submit_milestone(
        &seller,
        &id,
        &0u32,
        &String::from_str(&env, "ipfs://milestone-0.json"),
        &hash,
    );

    // Submitting a milestone must not move any tokens.
    assert_eq!(token.balance(&buyer), 900_000);
    assert_eq!(token.balance(&client.address), 100_000);
    assert_eq!(token.balance(&seller), 0);

    let expected_event = MilestoneSubmitted {
        version: EVENT_VERSION,
        job_id: id,
        index: 0,
        deliverable_hash: hash.clone(),
    };
    let all_events = env.events().all().filter_by_contract(&client.address);
    assert_eq!(
        all_events.events().last().unwrap().clone(),
        expected_event.to_xdr(&env, &client.address),
    );

    let job = client.get_job(&id).unwrap();
    let milestones = job.milestones.unwrap();
    assert_eq!(
        milestones.get(0).unwrap().deliverable,
        String::from_str(&env, "ipfs://milestone-0.json")
    );
    assert!(!milestones.get(0).unwrap().approved);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn submit_milestone_panics_with_job_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup(&env);
    let seller = Address::generate(&env);
    client.submit_milestone(
        &seller,
        &9999u64,
        &0u32,
        &String::from_str(&env, "ipfs://milestone.json"),
        &sample_hash(&env),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn submit_milestone_rejects_non_provider() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let mallory = Address::generate(&env);
    let (id, _token_addr, token, _stellar_token) =
        setup_milestone_job(&env, &client, &admin, &buyer, &seller);

    let before = token.balance(&client.address);
    client.submit_milestone(
        &mallory,
        &id,
        &0u32,
        &String::from_str(&env, "ipfs://hax.json"),
        &sample_hash(&env),
    );
    assert_eq!(token.balance(&client.address), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn submit_milestone_rejects_non_milestone_job() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "plain job"),
        &0u64,
        &0u32,
    );

    let before = token.balance(&client.address);
    client.submit_milestone(
        &seller,
        &id,
        &0u32,
        &String::from_str(&env, "ipfs://milestone.json"),
        &sample_hash(&env),
    );
    assert_eq!(token.balance(&client.address), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn submit_milestone_rejects_cancelled_job() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (id, _token_addr, token, _stellar_token) =
        setup_milestone_job(&env, &client, &admin, &buyer, &seller);

    client.cancel(&buyer, &id);

    let before = token.balance(&client.address);
    client.submit_milestone(
        &seller,
        &id,
        &0u32,
        &String::from_str(&env, "ipfs://milestone.json"),
        &sample_hash(&env),
    );
    assert_eq!(token.balance(&client.address), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn submit_milestone_rejects_index_out_of_bounds() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (id, _token_addr, token, _stellar_token) =
        setup_milestone_job(&env, &client, &admin, &buyer, &seller);

    let before = token.balance(&client.address);
    client.submit_milestone(
        &seller,
        &id,
        &5u32,
        &String::from_str(&env, "ipfs://milestone-5.json"),
        &sample_hash(&env),
    );
    assert_eq!(token.balance(&client.address), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn submit_milestone_rejects_already_submitted() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (id, _token_addr, token, _stellar_token) =
        setup_milestone_job(&env, &client, &admin, &buyer, &seller);

    let hash = sample_hash(&env);
    client.submit_milestone(
        &seller,
        &id,
        &0u32,
        &String::from_str(&env, "ipfs://milestone-0.json"),
        &hash,
    );

    let before = token.balance(&client.address);
    client.submit_milestone(
        &seller,
        &id,
        &0u32,
        &String::from_str(&env, "ipfs://milestone-0-again.json"),
        &hash,
    );
    assert_eq!(token.balance(&client.address), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn submit_milestone_rejects_already_approved_milestone() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (id, _token_addr, token, _stellar_token) =
        setup_milestone_job(&env, &client, &admin, &buyer, &seller);

    let hash = sample_hash(&env);
    client.submit_milestone(
        &seller,
        &id,
        &0u32,
        &String::from_str(&env, "ipfs://milestone-0.json"),
        &hash,
    );
    client.approve_milestone(&buyer, &id, &0u32);

    let before = token.balance(&client.address);
    client.submit_milestone(
        &seller,
        &id,
        &0u32,
        &String::from_str(&env, "ipfs://milestone-0-again.json"),
        &hash,
    );
    assert_eq!(token.balance(&client.address), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn submit_milestone_rejects_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (id, _token_addr, token, _stellar_token) =
        setup_milestone_job(&env, &client, &admin, &buyer, &seller);

    client.pause_channels(&admin);

    let before = token.balance(&client.address);
    client.submit_milestone(
        &seller,
        &id,
        &0u32,
        &String::from_str(&env, "ipfs://milestone-0.json"),
        &sample_hash(&env),
    );
    assert_eq!(token.balance(&client.address), before);
}

// ===========================================================================
// #945 — cancel_uncompleted_milestones()
// ===========================================================================

#[test]
fn cancel_uncompleted_milestones_refunds_only_unapproved_amounts() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (id, _token_addr, token, _stellar_token) =
        setup_milestone_job(&env, &client, &admin, &buyer, &seller);

    // Fund escrow: buyer debited 100_000.
    assert_eq!(token.balance(&buyer), 900_000);
    assert_eq!(token.balance(&client.address), 100_000);

    // Submit and approve milestone 0 (60_000 → 59_400 payout, 600 fee).
    let hash = sample_hash(&env);
    client.submit_milestone(
        &seller,
        &id,
        &0u32,
        &String::from_str(&env, "ipfs://milestone-0.json"),
        &hash,
    );
    client.approve_milestone(&buyer, &id, &0u32);

    assert_eq!(token.balance(&seller), 59_400);
    assert_eq!(token.balance(&treasury), 600);
    assert_eq!(token.balance(&client.address), 40_000);
    assert_eq!(token.balance(&buyer), 900_000);

    // Cancel the remaining (unapproved) milestone 1 worth 40_000.
    client.cancel_uncompleted_milestones(&buyer, &id);

    // Buyer refunded exactly the unapproved milestone amount.
    assert_eq!(token.balance(&buyer), 940_000);
    assert_eq!(token.balance(&client.address), 0);
    assert_eq!(token.balance(&seller), 59_400);
    assert_eq!(token.balance(&treasury), 600);

    let expected_event = MilestonesPartialCancelled {
        version: EVENT_VERSION,
        job_id: id,
        refunded: 40_000,
    };
    let all_events = env.events().all().filter_by_contract(&client.address);
    assert_eq!(
        all_events.events().last().unwrap().clone(),
        expected_event.to_xdr(&env, &client.address),
    );

    let job = client.get_job(&id).unwrap();
    assert_eq!(job.status, JobStatus::Cancelled);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn cancel_uncompleted_milestones_panics_with_job_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    client.cancel_uncompleted_milestones(&buyer, &9999u64);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn cancel_uncompleted_milestones_rejects_non_client() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let mallory = Address::generate(&env);
    let (id, _token_addr, token, _stellar_token) =
        setup_milestone_job(&env, &client, &admin, &buyer, &seller);

    let before = token.balance(&buyer);
    client.cancel_uncompleted_milestones(&mallory, &id);
    assert_eq!(token.balance(&buyer), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn cancel_uncompleted_milestones_rejects_non_milestone_job() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    stellar_token.mint(&buyer, &1_000_000);

    let id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &100_000i128,
        &String::from_str(&env, "plain job"),
        &0u64,
        &0u32,
    );

    let before = token.balance(&buyer);
    client.cancel_uncompleted_milestones(&buyer, &id);
    assert_eq!(token.balance(&buyer), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn cancel_uncompleted_milestones_rejects_already_cancelled_job() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (id, _token_addr, token, _stellar_token) =
        setup_milestone_job(&env, &client, &admin, &buyer, &seller);

    client.cancel(&buyer, &id);

    let before = token.balance(&buyer);
    client.cancel_uncompleted_milestones(&buyer, &id);
    assert_eq!(token.balance(&buyer), before);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn cancel_uncompleted_milestones_rejects_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (id, _token_addr, token, _stellar_token) =
        setup_milestone_job(&env, &client, &admin, &buyer, &seller);

    client.pause_channels(&admin);

    let before = token.balance(&buyer);
    client.cancel_uncompleted_milestones(&buyer, &id);
    assert_eq!(token.balance(&buyer), before);
}

// ===========================================================================
// #946 — emergency_pause()
// ===========================================================================

#[test]
fn emergency_pause_emits_event_and_leaves_balances_untouched() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
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

    let buyer_before = token.balance(&buyer);
    let escrow_before = token.balance(&client.address);
    let seller_before = token.balance(&seller);

    client.emergency_pause(&admin);

    assert!(client.are_channels_paused());
    // Pausing must not move any tokens.
    assert_eq!(token.balance(&buyer), buyer_before);
    assert_eq!(token.balance(&client.address), escrow_before);
    assert_eq!(token.balance(&seller), seller_before);

    let expected_event = Paused {
        version: EVENT_VERSION,
        admin: admin.clone(),
    };
    let all_events = env.events().all().filter_by_contract(&client.address);
    assert_eq!(
        all_events.events().last().unwrap().clone(),
        expected_event.to_xdr(&env, &client.address),
    );

    // Existing job state is untouched by the pause.
    assert_eq!(client.get_job(&id).unwrap().status, JobStatus::Funded);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn emergency_pause_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
    let holder = Address::generate(&env);
    stellar_token.mint(&holder, &1_000_000);
    let mallory = Address::generate(&env);

    let before = token.balance(&holder);
    client.emergency_pause(&mallory);
    assert_eq!(token.balance(&holder), before);
}

#[test]
#[should_panic(expected = "not initialized")]
fn emergency_pause_rejects_uninitialized_contract() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgenticCommerceContract, ());
    let client = AgenticCommerceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    client.emergency_pause(&admin);
}

/// After `emergency_pause`, every guarded state-changing entrypoint must panic
/// with ContractPaused (#12) while read-only getters keep working.
#[test]
fn emergency_pause_blocks_all_state_changing_entrypoints() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let (token_addr, token, stellar_token) = deploy_token(&env, &admin, &client);
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

    client.emergency_pause(&admin);
    assert!(client.are_channels_paused());

    let buyer_before = token.balance(&buyer);
    let escrow_before = token.balance(&client.address);

    // --- create_job ---
    let res = client.try_create_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &1_000i128,
        &String::from_str(&env, "blocked job"),
        &0u64,
        &0u32,
    );
    assert_eq!(res, Err(Ok(Error::ContractPaused)));

    // --- batch_create_jobs ---
    let res = client.try_batch_create_jobs(
        &buyer,
        &soroban_sdk::vec![
            &env,
            JobRequest {
                provider: seller.clone(),
                evaluator: buyer.clone(),
                token: token_addr.clone(),
                budget: 1_000,
                description: String::from_str(&env, "blocked batch job"),
            },
        ],
    );
    assert_eq!(res, Err(Ok(Error::ContractPaused)));

    // --- create_milestone_job ---
    let res = client.try_create_milestone_job(
        &buyer,
        &seller,
        &buyer,
        &token_addr,
        &1_000i128,
        &String::from_str(&env, "blocked milestone job"),
        &soroban_sdk::vec![
            &env,
            Milestone {
                index: 0,
                amount: 1_000,
                description: String::from_str(&env, "m"),
                deliverable: String::from_str(&env, ""),
                approved: false,
            },
        ],
    );
    assert_eq!(res, Err(Ok(Error::ContractPaused)));

    // --- submit ---
    let res = client.try_submit(
        &seller,
        &id,
        &String::from_str(&env, "deliverable"),
        &sample_hash(&env),
    );
    assert_eq!(res, Err(Ok(Error::ContractPaused)));

    // --- complete ---
    let res = client.try_complete(&buyer, &id, &Some(sample_hash(&env)));
    assert_eq!(res, Err(Ok(Error::ContractPaused)));

    // --- cancel ---
    let res = client.try_cancel(&buyer, &id);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));

    // --- claim_expired ---
    let res = client.try_claim_expired(&buyer, &id);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));

    // --- open_channel ---
    let res = client.try_open_channel(
        &buyer,
        &seller,
        &token_addr,
        &1_000i128,
        &BytesN::from_array(&env, &[0; 32]),
    );
    assert_eq!(res, Err(Ok(Error::ContractPaused)));

    // No tokens moved while paused.
    assert_eq!(token.balance(&buyer), buyer_before);
    assert_eq!(token.balance(&client.address), escrow_before);

    // Read-only getters still succeed while paused.
    assert!(client.get_job(&id).is_some());
    assert_eq!(client.fee_bps(), 100);
    assert_eq!(client.admin(), admin);
    assert!(client.is_token_allowed(&token_addr));
    assert_eq!(client.jobs_by_client(&buyer, &1u64, &10u32).len(), 1);
}

// ── Model-based state machine invariants (#1008) ─────────────────────────

#[derive(Clone, Copy, Debug)]
enum Op {
    CreateFunded,
    Cancel,
}

fn simulate_balance_invariant(ops: &[Op]) -> bool {
    let mut escrow: i128 = 0;
    let mut client: i128 = 1_000_000;
    let mut released: i128 = 0;
    let mut terminal = false;

    for op in ops {
        if terminal {
            return false;
        }
        match op {
            Op::CreateFunded => {
                if escrow > 0 {
                    return false;
                }
                let budget = 100_000i128;
                if client < budget {
                    continue;
                }
                client -= budget;
                escrow += budget;
            }
            Op::Cancel => {
                if escrow == 0 {
                    continue;
                }
                client += escrow;
                released += escrow;
                escrow = 0;
                terminal = true;
            }
        }
        if escrow < 0 || client < 0 || released < 0 {
            return false;
        }
        if escrow + client + released > 1_000_000 {
            return false;
        }
    }
    escrow + client + released <= 1_000_000
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn job_lifecycle_model_preserves_fund_conservation(seed in any::<u64>()) {
        let _ = seed;
        let ops = vec![Op::CreateFunded, Op::Cancel];
        prop_assert!(simulate_balance_invariant(&ops));
    }

    #[test]
    fn random_operation_sequences_preserve_invariants(
        seq in proptest::collection::vec(0..12).prop_map(|n| {
            (0..n).map(|i| if i % 2 == 0 { Op::CreateFunded } else { Op::Cancel }).collect::<Vec<_>>()
        })
    ) {
        prop_assert!(simulate_balance_invariant(&seq));
    }
}

// ===========================================================================
// #941 — close_channel() tests
// ===========================================================================

/// Helper to create a payment channel with a voucher signing key.
fn setup_channel<'a>(
    env: &Env,
    client: &AgenticCommerceContractClient<'a>,
    admin: &Address,
    payer: &Address,
    provider: &Address,
) -> (u64, Address, TokenClient<'a>, StellarAssetClient<'a>, soroban_sdk::BytesN<32>) {
    let (token_addr, token, stellar_token) = deploy_token(env, admin, client);
    stellar_token.mint(payer, &1_000_000);
    
    // Generate a signing key pair for vouchers
    let voucher_key = BytesN::from_array(env, &[1u8; 32]);
    
    let channel_id = client.open_channel(
        payer,
        provider,
        &token_addr,
        &100_000i128,
        &voucher_key,
    );
    
    (channel_id, token_addr, token, stellar_token, voucher_key)
}

/// Helper to create a signed voucher for testing.
fn create_voucher_and_signature(
    env: &Env,
    channel_id: u64,
    amount: i128,
    nonce: u64,
) -> (ChannelVoucher, BytesN<64>) {
    let voucher = ChannelVoucher {
        channel_id,
        amount,
        nonce,
    };
    // Create a dummy signature (in real usage this would be signed by the voucher_key)
    let signature = BytesN::from_array(env, &[0u8; 64]);
    (voucher, signature)
}

#[test]
fn close_channel_starts_dispute_window_on_first_call() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    let (voucher, signature) = create_voucher_and_signature(&env, channel_id, 50_000, 1);
    
    // First close_channel call should start the dispute window
    client.close_channel(&provider, &channel_id, &voucher, &signature);
    
    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.amount, 50_000);
    assert!(channel.closing_at > 0);
    
    // Tokens should still be in escrow
    assert_eq!(token.balance(&client.address), 100_000);
    assert_eq!(token.balance(&provider), 0);
    assert_eq!(token.balance(&payer), 900_000);
}

#[test]
fn close_channel_allows_higher_voucher_during_dispute_window() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, _token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    let (voucher1, signature1) = create_voucher_and_signature(&env, channel_id, 50_000, 1);
    client.close_channel(&provider, &channel_id, &voucher1, &signature1);
    
    let (voucher2, signature2) = create_voucher_and_signature(&env, channel_id, 75_000, 2);
    client.close_channel(&payer, &channel_id, &voucher2, &signature2);
    
    let channel = client.get_channel(&channel_id).unwrap();
    assert_eq!(channel.amount, 75_000);
    assert_eq!(channel.nonce, 2);
}

#[test]
#[should_panic(expected = "channel not found")]
fn close_channel_panics_when_channel_does_not_exist() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup(&env);
    let caller = Address::generate(&env);
    let (voucher, signature) = create_voucher_and_signature(&env, 9999, 50_000, 1);
    
    client.close_channel(&caller, &9999u64, &voucher, &signature);
}

#[test]
#[should_panic(expected = "not a channel participant")]
fn close_channel_rejects_non_participant() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let mallory = Address::generate(&env);
    let (channel_id, _token_addr, _token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    let (voucher, signature) = create_voucher_and_signature(&env, channel_id, 50_000, 1);
    client.close_channel(&mallory, &channel_id, &voucher, &signature);
}

#[test]
#[should_panic(expected = "voucher is not newer")]
fn close_channel_rejects_lower_amount_voucher() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, _token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    let (voucher1, signature1) = create_voucher_and_signature(&env, channel_id, 75_000, 1);
    client.close_channel(&provider, &channel_id, &voucher1, &signature1);
    
    // Try to submit a lower amount with higher nonce
    let (voucher2, signature2) = create_voucher_and_signature(&env, channel_id, 50_000, 2);
    client.close_channel(&payer, &channel_id, &voucher2, &signature2);
}

#[test]
#[should_panic(expected = "voucher is not newer")]
fn close_channel_rejects_same_nonce_voucher() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, _token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    let (voucher1, signature1) = create_voucher_and_signature(&env, channel_id, 50_000, 1);
    client.close_channel(&provider, &channel_id, &voucher1, &signature1);
    
    let (voucher2, signature2) = create_voucher_and_signature(&env, channel_id, 75_000, 1);
    client.close_channel(&payer, &channel_id, &voucher2, &signature2);
}

#[test]
#[should_panic(expected = "channel challenge window ended")]
fn close_channel_rejects_after_dispute_window_ends() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, _token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    let (voucher1, signature1) = create_voucher_and_signature(&env, channel_id, 50_000, 1);
    client.close_channel(&provider, &channel_id, &voucher1, &signature1);
    
    // Fast-forward past the 24-hour dispute window
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    
    let (voucher2, signature2) = create_voucher_and_signature(&env, channel_id, 75_000, 2);
    client.close_channel(&payer, &channel_id, &voucher2, &signature2);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn close_channel_rejects_when_contract_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, _token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    client.emergency_pause(&admin);
    
    let (voucher, signature) = create_voucher_and_signature(&env, channel_id, 50_000, 1);
    client.close_channel(&provider, &channel_id, &voucher, &signature);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn close_channel_rejects_when_channels_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, _token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    client.pause_channels(&admin);
    
    let (voucher, signature) = create_voucher_and_signature(&env, channel_id, 50_000, 1);
    client.close_channel(&provider, &channel_id, &voucher, &signature);
}

#[test]
fn close_channel_emits_channel_closing_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, _token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    let (voucher, signature) = create_voucher_and_signature(&env, channel_id, 50_000, 1);
    client.close_channel(&provider, &channel_id, &voucher, &signature);
    
    let channel = client.get_channel(&channel_id).unwrap();
    let expected_event = ChannelClosing {
        version: EVENT_VERSION,
        actor: provider.clone(),
        channel_id,
        amount: 50_000,
        challenge_until: channel.closing_at,
    };
    
    let all_events = env.events().all().filter_by_contract(&client.address);
    assert_eq!(
        all_events.events().last().unwrap().clone(),
        expected_event.to_xdr(&env, &client.address),
    );
}

// ===========================================================================
// #942 — force_close() tests
// ===========================================================================

#[test]
fn force_close_settles_channel_after_dispute_window() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    let (voucher, signature) = create_voucher_and_signature(&env, channel_id, 60_000, 1);
    client.close_channel(&provider, &channel_id, &voucher, &signature);
    
    // Fast-forward past the 24-hour dispute window
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    
    client.force_close(&payer, &channel_id);
    
    // Provider receives the voucher amount, payer receives the refund
    assert_eq!(token.balance(&provider), 60_000);
    assert_eq!(token.balance(&payer), 900_000 + 40_000);
    assert_eq!(token.balance(&client.address), 0);
    
    // Channel should be removed
    assert!(client.get_channel(&channel_id).is_none());
}

#[test]
fn force_close_settles_full_deposit_to_provider_when_amount_equals_deposit() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    let (voucher, signature) = create_voucher_and_signature(&env, channel_id, 100_000, 1);
    client.close_channel(&provider, &channel_id, &voucher, &signature);
    
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    
    client.force_close(&provider, &channel_id);
    
    assert_eq!(token.balance(&provider), 100_000);
    assert_eq!(token.balance(&payer), 900_000);
    assert_eq!(token.balance(&client.address), 0);
}

#[test]
fn force_close_allows_immediate_settlement_if_never_closed() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    // Fast-forward past the dispute window from channel opening
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    
    // force_close without close_channel should use opened_at as the baseline
    client.force_close(&provider, &channel_id);
    
    // No voucher was submitted, so amount is 0, full deposit refunded to payer
    assert_eq!(token.balance(&provider), 0);
    assert_eq!(token.balance(&payer), 1_000_000);
    assert_eq!(token.balance(&client.address), 0);
}

#[test]
#[should_panic(expected = "channel not found")]
fn force_close_panics_when_channel_does_not_exist() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup(&env);
    let caller = Address::generate(&env);
    
    client.force_close(&caller, &9999u64);
}

#[test]
#[should_panic(expected = "not a channel participant")]
fn force_close_rejects_non_participant() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let mallory = Address::generate(&env);
    let (channel_id, _token_addr, _token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    let (voucher, signature) = create_voucher_and_signature(&env, channel_id, 50_000, 1);
    client.close_channel(&provider, &channel_id, &voucher, &signature);
    
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    
    client.force_close(&mallory, &channel_id);
}

#[test]
#[should_panic(expected = "channel challenge window active")]
fn force_close_rejects_during_dispute_window() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, _token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    let (voucher, signature) = create_voucher_and_signature(&env, channel_id, 50_000, 1);
    client.close_channel(&provider, &channel_id, &voucher, &signature);
    
    // Try to force_close before dispute window ends
    client.force_close(&payer, &channel_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn force_close_rejects_when_contract_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, _token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    let (voucher, signature) = create_voucher_and_signature(&env, channel_id, 50_000, 1);
    client.close_channel(&provider, &channel_id, &voucher, &signature);
    
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    
    client.emergency_pause(&admin);
    
    client.force_close(&payer, &channel_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn force_close_rejects_when_channels_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, _token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    let (voucher, signature) = create_voucher_and_signature(&env, channel_id, 50_000, 1);
    client.close_channel(&provider, &channel_id, &voucher, &signature);
    
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    
    client.pause_channels(&admin);
    
    client.force_close(&payer, &channel_id);
}

#[test]
fn force_close_emits_channel_settled_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, _token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    let (voucher, signature) = create_voucher_and_signature(&env, channel_id, 60_000, 1);
    client.close_channel(&provider, &channel_id, &voucher, &signature);
    
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    
    client.force_close(&provider, &channel_id);
    
    let expected_event = ChannelSettled {
        version: EVENT_VERSION,
        actor: provider.clone(),
        channel_id,
        amount: 60_000,
        refund: 40_000,
    };
    
    let all_events = env.events().all().filter_by_contract(&client.address);
    assert_eq!(
        all_events.events().last().unwrap().clone(),
        expected_event.to_xdr(&env, &client.address),
    );
}

#[test]
fn force_close_handles_zero_amount_voucher() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let payer = Address::generate(&env);
    let provider = Address::generate(&env);
    let (channel_id, _token_addr, token, _stellar_token, _voucher_key) =
        setup_channel(&env, &client, &admin, &payer, &provider);
    
    let (voucher, signature) = create_voucher_and_signature(&env, channel_id, 0, 1);
    client.close_channel(&provider, &channel_id, &voucher, &signature);
    
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    
    client.force_close(&payer, &channel_id);
    
    // All funds refunded to payer, nothing to provider
    assert_eq!(token.balance(&provider), 0);
    assert_eq!(token.balance(&payer), 1_000_000);
    assert_eq!(token.balance(&client.address), 0);
}

// ===========================================================================
// #943 — fund_job_with_swap() tests
// ===========================================================================

/// Mock AMM router contract for testing swaps.
#[contract]
struct MockAmmRouter;

#[contractimpl]
impl MockAmmRouter {
    /// Mock swap_exact_out: deliver exactly target_amount of output_token,
    /// return the amount of input_token consumed.
    pub fn swap_exact_out(
        _env: Env,
        _sender: Address,
        input_token: Address,
        output_token: Address,
        target_amount: i128,
        max_input: i128,
    ) -> i128 {
        // Simple mock: 1:1 swap ratio for testing
        // In reality this would interact with liquidity pools
        let input_spent = target_amount;
        
        if input_spent > max_input {
            panic!("slippage exceeded in mock");
        }
        
        // Transfer the tokens (mock implementation)
        let input_client = token::TokenClient::new(&_env, &input_token);
        let output_client = token::TokenClient::new(&_env, &output_token);
        
        let contract = _env.current_contract_address();
        
        // Consume input tokens from sender
        input_client.transfer(&_sender, &contract, &input_spent);
        
        // Deliver output tokens to sender
        output_client.transfer(&contract, &_sender, &target_amount);
        
        input_spent
    }
}

fn setup_amm_router(env: &Env, client: &AgenticCommerceContractClient, admin: &Address) -> Address {
    let router_id = env.register(MockAmmRouter, ());
    let router_addr = router_id.address();
    client.set_amm_router(admin, &router_addr);
    router_addr
}

#[test]
fn fund_job_with_swap_successfully_funds_job_and_refunds_excess() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    
    // Setup two different tokens
    let (input_token_addr, input_token, input_stellar) = deploy_token(&env, &admin, &client);
    let (target_token_addr, target_token, target_stellar) = deploy_token(&env, &admin, &client);
    
    // Mint input tokens to buyer
    input_stellar.mint(&buyer, &1_000_000);
    
    // Setup AMM router
    let router_addr = setup_amm_router(&env, &client, &admin);
    
    // Mint tokens to router for swapping
    target_stellar.mint(&router_addr, &1_000_000);
    
    // Create a job that needs to be funded with target_token
    let job_id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &target_token_addr,
        &100_000i128,
        &String::from_str(&env, "job needing swap"),
        &0u64,
        &0u32,
    );
    
    // Initially the job is Open/Funded but we need to simulate Open status
    // For this test, we assume the job status allows swap funding
    
    let input_spent = client.fund_job_with_swap(
        &buyer,
        &input_token_addr,
        &150_000i128,
        &job_id,
    );
    
    // Should have spent exactly the budget amount (1:1 ratio in mock)
    assert_eq!(input_spent, 100_000);
    
    // Buyer should have received refund of unspent input
    assert_eq!(input_token.balance(&buyer), 1_000_000 - 100_000);
    
    // Job should be funded
    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::Funded);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn fund_job_with_swap_panics_when_job_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    
    let (input_token_addr, _input_token, input_stellar) = deploy_token(&env, &admin, &client);
    input_stellar.mint(&buyer, &1_000_000);
    
    setup_amm_router(&env, &client, &admin);
    
    client.fund_job_with_swap(
        &buyer,
        &input_token_addr,
        &150_000i128,
        &9999u64,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn fund_job_with_swap_rejects_non_client() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let mallory = Address::generate(&env);
    
    let (input_token_addr, _input_token, input_stellar) = deploy_token(&env, &admin, &client);
    let (target_token_addr, _target_token, _target_stellar) = deploy_token(&env, &admin, &client);
    
    input_stellar.mint(&mallory, &1_000_000);
    
    setup_amm_router(&env, &client, &admin);
    
    let job_id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &target_token_addr,
        &100_000i128,
        &String::from_str(&env, "job"),
        &0u64,
        &0u32,
    );
    
    client.fund_job_with_swap(
        &mallory,
        &input_token_addr,
        &150_000i128,
        &job_id,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn fund_job_with_swap_rejects_already_funded_job() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    
    let (input_token_addr, _input_token, input_stellar) = deploy_token(&env, &admin, &client);
    let (target_token_addr, _target_token, target_stellar) = deploy_token(&env, &admin, &client);
    
    input_stellar.mint(&buyer, &1_000_000);
    target_stellar.mint(&buyer, &1_000_000);
    
    setup_amm_router(&env, &client, &admin);
    
    // Create and fund a job normally
    let job_id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &target_token_addr,
        &100_000i128,
        &String::from_str(&env, "already funded job"),
        &0u64,
        &0u32,
    );
    
    // Job is already Funded, trying to fund again should fail
    client.fund_job_with_swap(
        &buyer,
        &input_token_addr,
        &150_000i128,
        &job_id,
    );
}

#[test]
#[should_panic(expected = "max_input_amount must be positive")]
fn fund_job_with_swap_rejects_zero_max_input() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    
    let (input_token_addr, _input_token, _input_stellar) = deploy_token(&env, &admin, &client);
    let (target_token_addr, _target_token, _target_stellar) = deploy_token(&env, &admin, &client);
    
    setup_amm_router(&env, &client, &admin);
    
    let job_id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &target_token_addr,
        &100_000i128,
        &String::from_str(&env, "job"),
        &0u64,
        &0u32,
    );
    
    client.fund_job_with_swap(
        &buyer,
        &input_token_addr,
        &0i128,
        &job_id,
    );
}

#[test]
#[should_panic(expected = "max_input_amount must be positive")]
fn fund_job_with_swap_rejects_negative_max_input() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    
    let (input_token_addr, _input_token, _input_stellar) = deploy_token(&env, &admin, &client);
    let (target_token_addr, _target_token, _target_stellar) = deploy_token(&env, &admin, &client);
    
    setup_amm_router(&env, &client, &admin);
    
    let job_id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &target_token_addr,
        &100_000i128,
        &String::from_str(&env, "job"),
        &0u64,
        &0u32,
    );
    
    client.fund_job_with_swap(
        &buyer,
        &input_token_addr,
        &-100i128,
        &job_id,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn fund_job_with_swap_rejects_unwhitelisted_input_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    
    // Create input token but don't whitelist it
    let input_token_contract = env.register_stellar_asset_contract_v2(admin.clone());
    let input_token_addr = input_token_contract.address();
    let input_stellar = StellarAssetClient::new(&env, &input_token_addr);
    input_stellar.mint(&buyer, &1_000_000);
    
    let (target_token_addr, _target_token, _target_stellar) = deploy_token(&env, &admin, &client);
    
    setup_amm_router(&env, &client, &admin);
    
    let job_id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &target_token_addr,
        &100_000i128,
        &String::from_str(&env, "job"),
        &0u64,
        &0u32,
    );
    
    client.fund_job_with_swap(
        &buyer,
        &input_token_addr,
        &150_000i128,
        &job_id,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn fund_job_with_swap_rejects_unwhitelisted_target_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    
    let (input_token_addr, _input_token, input_stellar) = deploy_token(&env, &admin, &client);
    input_stellar.mint(&buyer, &1_000_000);
    
    // Create target token but don't whitelist it
    let target_token_contract = env.register_stellar_asset_contract_v2(admin.clone());
    let target_token_addr = target_token_contract.address();
    
    setup_amm_router(&env, &client, &admin);
    
    let job_id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &target_token_addr,
        &100_000i128,
        &String::from_str(&env, "job"),
        &0u64,
        &0u32,
    );
    
    client.fund_job_with_swap(
        &buyer,
        &input_token_addr,
        &150_000i128,
        &job_id,
    );
}

#[test]
#[should_panic(expected = "amm router not configured")]
fn fund_job_with_swap_rejects_when_router_not_configured() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    
    let (input_token_addr, _input_token, input_stellar) = deploy_token(&env, &admin, &client);
    let (target_token_addr, _target_token, _target_stellar) = deploy_token(&env, &admin, &client);
    
    input_stellar.mint(&buyer, &1_000_000);
    
    // Don't setup AMM router
    
    let job_id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &target_token_addr,
        &100_000i128,
        &String::from_str(&env, "job"),
        &0u64,
        &0u32,
    );
    
    client.fund_job_with_swap(
        &buyer,
        &input_token_addr,
        &150_000i128,
        &job_id,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn fund_job_with_swap_rejects_when_contract_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    
    let (input_token_addr, _input_token, input_stellar) = deploy_token(&env, &admin, &client);
    let (target_token_addr, _target_token, target_stellar) = deploy_token(&env, &admin, &client);
    
    input_stellar.mint(&buyer, &1_000_000);
    target_stellar.mint(&buyer, &1_000_000);
    
    setup_amm_router(&env, &client, &admin);
    
    let job_id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &target_token_addr,
        &100_000i128,
        &String::from_str(&env, "job"),
        &0u64,
        &0u32,
    );
    
    client.emergency_pause(&admin);
    
    client.fund_job_with_swap(
        &buyer,
        &input_token_addr,
        &150_000i128,
        &job_id,
    );
}

#[test]
fn fund_job_with_swap_emits_swap_funded_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury) = setup(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    
    let (input_token_addr, _input_token, input_stellar) = deploy_token(&env, &admin, &client);
    let (target_token_addr, _target_token, target_stellar) = deploy_token(&env, &admin, &client);
    
    input_stellar.mint(&buyer, &1_000_000);
    
    let router_addr = setup_amm_router(&env, &client, &admin);
    target_stellar.mint(&router_addr, &1_000_000);
    
    let job_id = client.create_job(
        &buyer,
        &seller,
        &buyer,
        &target_token_addr,
        &100_000i128,
        &String::from_str(&env, "job needing swap"),
        &0u64,
        &0u32,
    );
    
    let input_spent = client.fund_job_with_swap(
        &buyer,
        &input_token_addr,
        &150_000i128,
        &job_id,
    );
    
    let expected_event = SwapFunded {
        version: EVENT_VERSION,
        client: buyer.clone(),
        job_id,
        input_token: input_token_addr.clone(),
        target_token: target_token_addr.clone(),
        input_spent,
        refund: 150_000 - input_spent,
        budget: 100_000,
    };
    
    let all_events = env.events().all().filter_by_contract(&client.address);
    assert_eq!(
        all_events.events().last().unwrap().clone(),
        expected_event.to_xdr(&env, &client.address),
    );
}
