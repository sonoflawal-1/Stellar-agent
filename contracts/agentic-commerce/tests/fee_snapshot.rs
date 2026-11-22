use agentic_commerce::{AgenticCommerceContract, AgenticCommerceContractClient, JobStatus};
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, String,
};

#[test]
fn timeout_payout_uses_each_jobs_creation_fee() {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let contract = env.register(AgenticCommerceContract, ());
    let client = AgenticCommerceContractClient::new(&env, &contract);
    client.init(&admin, &treasury);

    let token_address = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    client.add_token(&admin, &token_address, &0);
    StellarAssetClient::new(&env, &token_address).mint(&buyer, &200_000);
    let token = TokenClient::new(&env, &token_address);
    let create_job = || {
        let id = client.create_job(
            &buyer,
            &seller,
            &buyer,
            &token_address,
            &100_000,
            &String::from_str(&env, "job"),
            &0,
            &0,
        );
        client.submit(
            &seller,
            &id,
            &String::from_str(&env, "deliverable"),
            &BytesN::from_array(&env, &[1; 32]),
        );
        id
    };

    client.set_fee_bps(&admin, &100);
    let first = create_job();
    client.set_fee_bps(&admin, &500);
    let second = create_job();
    env.ledger()
        .set_timestamp(env.ledger().timestamp() + 7 * 24 * 3600);

    client.claim_expired(&seller, &first);
    assert_eq!(token.balance(&seller), 99_000);
    assert_eq!(token.balance(&treasury), 1_000);
    assert_eq!(client.get_job(&first).unwrap().status, JobStatus::Completed);

    client.claim_expired(&seller, &second);
    assert_eq!(token.balance(&seller), 194_000);
    assert_eq!(token.balance(&treasury), 6_000);
    assert_eq!(token.balance(&contract), 0);
}
