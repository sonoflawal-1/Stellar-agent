use agentic_commerce::{
    AgenticCommerceContract, AgenticCommerceContractClient, Error, JobStatus, Milestone,
};
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, BytesN, Env, IntoVal, String, Vec,
};

const BUDGET: i128 = 100_000;

struct Fixture {
    env: Env,
    contract: Address,
    buyer: Address,
    provider: Address,
    token: Address,
    description: String,
}

impl Fixture {
    fn new() -> Self {
        let env = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        let contract = match std::env::var_os("COMMERCE_TEST_WASM") {
            Some(path) => env.register(std::fs::read(path).unwrap().as_slice(), ()),
            None => env.register(AgenticCommerceContract, ()),
        };
        let client = AgenticCommerceContractClient::new(&env, &contract);
        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let provider = Address::generate(&env);
        client.init(&admin, &Address::generate(&env));
        client.set_multi_eval_threshold(&admin, &0);
        let token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        client.add_token(&admin, &token, &0);
        StellarAssetClient::new(&env, &token).mint(&buyer, &(4 * BUDGET));
        let description = String::from_str(&env, "job");
        Self {
            env,
            contract,
            buyer,
            provider,
            token,
            description,
        }
    }

    fn client(&self) -> AgenticCommerceContractClient<'_> {
        AgenticCommerceContractClient::new(&self.env, &self.contract)
    }

    fn submit(&self, id: u64) {
        self.client().submit(
            &self.provider,
            &id,
            &self.description,
            &BytesN::from_array(&self.env, &[1; 32]),
        );
    }

    fn report_cost(&self, entry_point: &str) {
        let cost = self.env.cost_estimate().resources();
        println!(
            "{entry_point}: {} CPU, {} bytes",
            cost.instructions, cost.mem_bytes
        );
    }
}

#[test]
fn weighted_creation_returns_typed_errors() {
    let f = Fixture::new();
    let first = Address::generate(&f.env);
    let second = Address::generate(&f.env);
    let evaluators = vec![&f.env, first.clone(), second];
    let duplicate = vec![&f.env, first.clone(), first];
    let client = f.client();
    for (members, weights, threshold, error) in [
        (
            &evaluators,
            vec![&f.env, 1],
            1,
            Error::InvalidEvaluatorQuorum,
        ),
        (
            &evaluators,
            vec![&f.env, 1, 1],
            0,
            Error::InvalidEvaluatorQuorum,
        ),
        (
            &evaluators,
            vec![&f.env, 0, 1],
            1,
            Error::InvalidEvaluatorWeight,
        ),
        (&duplicate, vec![&f.env, 1, 1], 1, Error::DuplicateEvaluator),
        (
            &evaluators,
            vec![&f.env, 1, 1],
            3,
            Error::InvalidEvaluatorQuorum,
        ),
        (
            &evaluators,
            vec![&f.env, u32::MAX, u32::MAX],
            u32::MAX,
            Error::EvaluatorWeightOverflow,
        ),
    ] {
        assert_eq!(
            client.try_create_job_multi_eval_weighted(
                &f.buyer,
                &f.provider,
                members,
                &weights,
                &threshold,
                &f.token,
                &BUDGET,
                &f.description,
            ),
            Err(Ok(error.into()))
        );
    }
    assert_eq!(TokenClient::new(&f.env, &f.token).balance(&f.contract), 0);
}

#[test]
fn replacement_requires_both_parties_and_preserves_the_weighted_quorum() {
    let f = Fixture::new();
    let current = Address::generate(&f.env);
    let remaining = Address::generate(&f.env);
    let replacement = Address::generate(&f.env);
    let client = f.client();
    let id = client.create_job_multi_eval_weighted(
        &f.buyer,
        &f.provider,
        &vec![&f.env, current.clone(), remaining.clone()],
        &vec![&f.env, 2, 1],
        &3,
        &f.token,
        &BUDGET,
        &f.description,
    );
    f.submit(id);
    assert_eq!(client.approve_job(&current, &id), 2);
    assert_eq!(
        client.try_replace_evaluator(&id, &current, &remaining),
        Err(Ok(Error::DuplicateEvaluator.into()))
    );
    assert_eq!(
        client.try_replace_evaluator(&id, &current, &f.provider),
        Err(Ok(Error::InvalidParties.into()))
    );

    let invocation = MockAuthInvoke {
        contract: &f.contract,
        fn_name: "replace_evaluator",
        args: (id, current.clone(), replacement.clone()).into_val(&f.env),
        sub_invokes: &[],
    };
    let buyer_auth = MockAuth {
        address: &f.buyer,
        invoke: &invocation,
    };
    let provider_auth = MockAuth {
        address: &f.provider,
        invoke: &invocation,
    };
    for auth in [buyer_auth.clone(), provider_auth.clone()] {
        assert!(client
            .mock_auths(&[auth])
            .try_replace_evaluator(&id, &current, &replacement)
            .is_err());
    }
    client
        .mock_auths(&[buyer_auth, provider_auth])
        .replace_evaluator(&id, &current, &replacement);
    f.env.mock_all_auths();

    let quorum = client.get_evaluator_weights(&id).unwrap();
    assert_eq!(
        quorum.evaluators,
        vec![&f.env, replacement.clone(), remaining.clone()]
    );
    assert_eq!(quorum.evaluator_weights.get(replacement.clone()), Some(2));
    assert!(!quorum.evaluator_weights.contains_key(current.clone()));
    assert!(!quorum.approvals.contains_key(current.clone()));
    assert_eq!(
        (
            quorum.threshold,
            quorum.total_weight,
            quorum.accumulated_weight
        ),
        (3, 3, 0)
    );
    assert_eq!(client.get_job(&id).unwrap().evaluator, replacement);
    assert!(client.try_approve_job(&current, &id).is_err());
    assert_eq!(client.approve_job(&remaining, &id), 1);
    assert_eq!(client.approve_job(&replacement, &id), 3);
    assert_eq!(client.get_job(&id).unwrap().status, JobStatus::Completed);
    assert_eq!(
        client.try_replace_evaluator(&id, &replacement, &current),
        Err(Ok(Error::InvalidStatus.into()))
    );
}

#[test]
fn creation_caps_and_gas_at_the_boundary() {
    let f = Fixture::new();
    let client = f.client();
    let mut evaluators = Vec::new(&f.env);
    let mut weights = Vec::new(&f.env);
    for _ in 0..5 {
        evaluators.push_back(Address::generate(&f.env));
        weights.push_back(1u32);
    }
    client.create_job_multi_eval(
        &f.buyer,
        &f.provider,
        &evaluators,
        &5,
        &f.token,
        &BUDGET,
        &f.description,
        &0,
        &0,
    );
    f.report_cost("create_job_multi_eval");
    let id = client.create_job_multi_eval_weighted(
        &f.buyer,
        &f.provider,
        &evaluators,
        &weights,
        &5,
        &f.token,
        &BUDGET,
        &f.description,
    );
    f.report_cost("create_job_multi_eval_weighted");
    f.submit(id);
    for evaluator in evaluators.iter() {
        client.approve_job(&evaluator, &id);
    }
    f.report_cost("approve_job");
    evaluators.push_back(Address::generate(&f.env));
    weights.push_back(1);
    assert!(client
        .try_create_job_multi_eval(
            &f.buyer,
            &f.provider,
            &evaluators,
            &5,
            &f.token,
            &BUDGET,
            &f.description,
            &0,
            &0,
        )
        .is_err());
    assert_eq!(
        client.try_create_job_multi_eval_weighted(
            &f.buyer,
            &f.provider,
            &evaluators,
            &weights,
            &5,
            &f.token,
            &BUDGET,
            &f.description,
        ),
        Err(Ok(Error::InvalidEvaluatorQuorum.into()))
    );

    let mut milestones = Vec::new(&f.env);
    assert!(client
        .try_create_milestone_job(
            &f.buyer,
            &f.provider,
            &f.buyer,
            &f.token,
            &BUDGET,
            &f.description,
            &milestones,
        )
        .is_err());
    for index in 0..20 {
        milestones.push_back(Milestone {
            index,
            amount: BUDGET / 20,
            description: f.description.clone(),
            deliverable: String::from_str(&f.env, ""),
            approved: false,
        });
    }
    let id = client.create_milestone_job(
        &f.buyer,
        &f.provider,
        &f.buyer,
        &f.token,
        &BUDGET,
        &f.description,
        &milestones,
    );
    f.report_cost("create_milestone_job");
    assert_eq!(client.get_milestones(&id).unwrap().len(), 20);
    client.cancel_uncompleted_milestones(&f.buyer, &id);
    f.report_cost("cancel_uncompleted_milestones");
    milestones.push_back(Milestone {
        index: 20,
        ..milestones.get(0).unwrap()
    });
    assert!(client
        .try_create_milestone_job(
            &f.buyer,
            &f.provider,
            &f.buyer,
            &f.token,
            &(BUDGET + BUDGET / 20),
            &f.description,
            &milestones,
        )
        .is_err());
}
