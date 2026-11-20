import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { CommerceClient } from "./commerce.js";
import { TESTNET } from "./types.js";
import {
  ContractError,
  SimulationError,
  TransactionTimeoutError,
  KnownContractErrorCode,
} from "./errors.js";

test("CommerceClient exposes the expected method signatures", () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  assert.equal(typeof client.createJob, "function");
  assert.equal(typeof client.submit, "function");
  assert.equal(typeof client.complete, "function");
  assert.equal(typeof client.cancel, "function");
  assert.equal(typeof client.createJobAndWait, "function");
  assert.equal(typeof client.allowance, "function");
  assert.equal(typeof client.approve, "function");
  assert.equal(typeof client.approveAndCreateJob, "function");
  assert.equal(typeof client.createJobWithApproval, "function");
  assert.equal(typeof client.createJobMultiEval, "function");
  assert.equal(typeof client.approveJob, "function");
  assert.equal(typeof client.getEvaluatorProgress, "function");
  assert.equal(typeof client.setMultiEvalThreshold, "function");
  assert.equal(typeof client.openChannel, "function");
  assert.equal(typeof client.closeChannel, "function");
  assert.equal(typeof client.forceClose, "function");
  assert.equal(typeof client.getJob, "function");
  assert.equal(typeof client.feeBps, "function");
  assert.equal(typeof client.setTreasury, "function");
  assert.equal(typeof client.setFeeBps, "function");
  assert.equal(typeof client.getBalance, "function");
  assert.equal(typeof client.disconnect, "function");
  // #542
  assert.equal(typeof client.listJobs, "function");
  // #543
  assert.equal(typeof client.getJobsByProvider, "function");
  assert.equal(typeof client.getJobsByClient, "function");

  client.disconnect();
});

test("createJob rejects a non-positive budget before touching the network", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  await assert.rejects(
    client.createJob(
      Keypair.random(),
      Keypair.random().publicKey(),
      Keypair.random().publicKey(),
      TESTNET.usdcToken,
      0n,
      "test job",
    ),
    /budget must be greater than 0/,
  );

  await assert.rejects(
    client.createJob(
      Keypair.random(),
      Keypair.random().publicKey(),
      Keypair.random().publicKey(),
      TESTNET.usdcToken,
      -1n,
      "test job",
    ),
    /budget must be greater than 0/,
  );
});

test("approveAndCreateJob rejects non-positive budget before touching the network", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  await assert.rejects(
    client.approveAndCreateJob(
      Keypair.random(),
      Keypair.random().publicKey(),
      Keypair.random().publicKey(),
      TESTNET.usdcToken,
      0n,
      "test job",
    ),
    /budget must be greater than 0/,
  );

  await assert.rejects(
    client.createJobWithApproval(
      Keypair.random(),
      Keypair.random().publicKey(),
      Keypair.random().publicKey(),
      TESTNET.usdcToken,
      -5n,
      "test job",
    ),
    /budget must be greater than 0/,
  );
});

test("custom error classes correctly instantiate and preserve metadata", () => {
  const contractErr = new ContractError(
    KnownContractErrorCode.SelfEscrow,
    "CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE",
  );
  assert.ok(contractErr instanceof Error);
  assert.ok(contractErr instanceof ContractError);
  assert.equal(contractErr.code, 1);
  assert.match(contractErr.explanation, /SelfEscrow/);

  const simErr = new SimulationError("tx simulation failed", { error: "HostError" }, "AAAA...");
  assert.ok(simErr instanceof Error);
  assert.ok(simErr instanceof SimulationError);
  assert.equal(simErr.xdr, "AAAA...");

  const timeoutErr = new TransactionTimeoutError("0123456789abcdef", 30000);
  assert.ok(timeoutErr instanceof Error);
  assert.ok(timeoutErr instanceof TransactionTimeoutError);
  assert.equal(timeoutErr.txHash, "0123456789abcdef");
  assert.equal(timeoutErr.durationMs, 30000);
});

// ---------------------------------------------------------------------------
// #543 — getJobsByProvider / getJobsByClient method signatures
// ---------------------------------------------------------------------------

test("CommerceClient exposes getJobsByProvider and getJobsByClient", () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  assert.equal(typeof client.getJobsByProvider, "function");
  assert.equal(typeof client.getJobsByClient, "function");

  client.disconnect();
});

test("getJobsByProvider has correct arity (provider, startId?, limit?)", () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  // getJobsByProvider(provider, startId?, limit?) has 1 required param.
  // JavaScript function.length counts params up to (but not including) the
  // first parameter with a default value.
  assert.equal(client.getJobsByProvider.length, 1);
  assert.equal(client.getJobsByClient.length, 1);

  client.disconnect();
});

// ---------------------------------------------------------------------------
// #542 — listJobs method signature and validation
// ---------------------------------------------------------------------------

test("CommerceClient exposes listJobs", () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  assert.equal(typeof client.listJobs, "function");

  client.disconnect();
});

test("listJobs returns empty array when jobCount RPC fails", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  // jobCount() will throw because the RPC URL is invalid; listJobs should
  // catch that and return [] rather than propagating the error.
  const result = await client.listJobs();
  assert.deepEqual(result, []);

  client.disconnect();
});

test("listJobs with startId beyond totalCount returns empty array immediately (mocked jobCount=0)", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  // Override jobCount to return 0 so we can exercise the early-exit path
  // without a real network call.
  (client as any).jobCount = async () => 0n;

  const result = await client.listJobs({ startId: 5n, limit: 10 });
  assert.deepEqual(result, []);

  client.disconnect();
});

test("listJobs default options: startId=1n, limit=20", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  const fetched: bigint[] = [];

  // Simulate 5 jobs total.
  (client as any).jobCount = async () => 5n;
  (client as any).getJob = async (id: bigint) => {
    fetched.push(id);
    return {
      id,
      client: "GABC",
      provider: "GDEF",
      evaluator: "GHIJ",
      token: "CTOKEN",
      budget: 1_000n,
      status: "Funded",
      description: "test",
      deliverable: "",
      funded_at: 0n,
      created_at: 0n,
      updated_at: 0n,
    };
  };

  const result = await client.listJobs();
  // Default limit 20, but only 5 exist — should fetch IDs 1..5.
  assert.equal(result.length, 5);
  assert.deepEqual(fetched, [1n, 2n, 3n, 4n, 5n]);

  client.disconnect();
});

test("listJobs pagination: startId=3n, limit=2 fetches IDs 3 and 4", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  const fetched: bigint[] = [];

  (client as any).jobCount = async () => 10n;
  (client as any).getJob = async (id: bigint) => {
    fetched.push(id);
    return {
      id,
      client: "GABC",
      provider: "GDEF",
      evaluator: "GHIJ",
      token: "CTOKEN",
      budget: 1_000n,
      status: "Funded",
      description: "test",
      deliverable: "",
      funded_at: 0n,
      created_at: 0n,
      updated_at: 0n,
    };
  };

  const result = await client.listJobs({ startId: 3n, limit: 2 });
  assert.equal(result.length, 2);
  assert.deepEqual(fetched, [3n, 4n]);
  assert.equal(result[0].id, 3n);
  assert.equal(result[1].id, 4n);

  client.disconnect();
});

test("listJobs filters out null jobs (gaps in ID space)", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  (client as any).jobCount = async () => 4n;
  // Simulate job ID 2 being missing (returns null).
  (client as any).getJob = async (id: bigint) => {
    if (id === 2n) return null;
    return {
      id,
      client: "GABC",
      provider: "GDEF",
      evaluator: "GHIJ",
      token: "CTOKEN",
      budget: 1_000n,
      status: "Funded",
      description: "test",
      deliverable: "",
      funded_at: 0n,
      created_at: 0n,
      updated_at: 0n,
    };
  };

  const result = await client.listJobs({ startId: 1n, limit: 4 });
  // IDs 1, 3, 4 are valid; ID 2 is null and should be filtered.
  assert.equal(result.length, 3);
  assert.deepEqual(
    result.map((j) => j.id),
    [1n, 3n, 4n],
  );

  client.disconnect();
});

// ---------------------------------------------------------------------------
// #543 — getJobsByProvider / getJobsByClient ScVal encoding (smoke tests)
// ---------------------------------------------------------------------------

test("getJobsByProvider rejects invalid provider address synchronously", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  // An invalid Stellar address should throw before any network call.
  await assert.rejects(
    () => client.getJobsByProvider("not-a-valid-address"),
    /unsupported address type/i,
  );

  client.disconnect();
});

test("getJobsByClient rejects invalid client address synchronously", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  await assert.rejects(
    () => client.getJobsByClient("not-a-valid-address"),
    /unsupported address type/i,
  );

  client.disconnect();
});

// ---------------------------------------------------------------------------
// #706 — SHA-256 deliverable content hash verification
// ---------------------------------------------------------------------------

test("computeDeliverableHash produces the correct 32-byte SHA-256 digest", () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  assert.equal(typeof client.computeDeliverableHash, "function");

  // Known SHA-256 test vectors.
  const empty = client.computeDeliverableHash(Buffer.alloc(0));
  assert.equal(empty.length, 32);
  assert.equal(
    Buffer.from(empty).toString("hex"),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );

  const abc = client.computeDeliverableHash(Buffer.from("abc"));
  assert.equal(abc.length, 32);
  assert.equal(
    Buffer.from(abc).toString("hex"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );

  client.disconnect();
});

test("computeDeliverableHash handles large buffers deterministically", () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  const large = Buffer.alloc(1024 * 1024, 0x61); // 1 MiB of 'a'
  const digest = client.computeDeliverableHash(large);
  assert.equal(digest.length, 32);

  // Deterministic: hashing the same buffer twice yields the same digest.
  const again = client.computeDeliverableHash(Buffer.from(large));
  assert.deepEqual(Buffer.from(digest), Buffer.from(again));

  // Different content yields a different digest.
  const other = client.computeDeliverableHash(Buffer.alloc(1024 * 1024, 0x62));
  assert.notDeepEqual(Buffer.from(digest), Buffer.from(other));

  client.disconnect();
});

test("submit encodes the deliverable hash argument in the correct position", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  const captured: any[] = [];
  (client as any).invoke = async (...args: any[]) => {
    captured.push(args);
    return { ok: true };
  };

  const provider = Keypair.random();
  const hash = client.computeDeliverableHash(Buffer.from("deliverable"));

  await client.submit(provider, 1n, "https://example.com/deliverable", hash);

  assert.equal(captured.length, 1);
  const [, method, params] = captured[0];
  assert.equal(method, "submit");
  // submit(job_id, deliverable, deliverable_hash)
  assert.equal(params.length, 3);
  assert.equal(params[0].value(), 1n);
  assert.equal(params[1].value(), "https://example.com/deliverable");
  assert.equal(params[2].value().length, 32);
  assert.deepEqual(
    Buffer.from(params[2].value()),
    Buffer.from(hash),
  );

  client.disconnect();
});

test("submit rejects a deliverable hash that is not 32 bytes", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  await assert.rejects(
    client.submit(
      Keypair.random(),
      1n,
      "https://example.com/deliverable",
      new Uint8Array(16) as any,
    ),
    /32 bytes/i,
  );

  client.disconnect();
});

test("complete encodes the optional deliverable hash assertion in the correct position", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  const captured: any[] = [];
  (client as any).invoke = async (...args: any[]) => {
    captured.push(args);
    return { ok: true };
  };

  const evaluator = Keypair.random();
  const hash = client.computeDeliverableHash(Buffer.from("deliverable"));

  await client.complete(evaluator, 1n, hash);

  assert.equal(captured.length, 1);
  const [, method, params] = captured[0];
  assert.equal(method, "complete");
  // complete(job_id, deliverable_hash?)
  assert.equal(params.length, 2);
  assert.equal(params[0].value(), 1n);
  assert.equal(params[1].value().length, 32);
  assert.deepEqual(
    Buffer.from(params[1].value()),
    Buffer.from(hash),
  );

  client.disconnect();
});

// ---------------------------------------------------------------------------
// #835 — getJob returns status as a plain JobStatus string
// ---------------------------------------------------------------------------

function jobScVal(status: xdr.ScVal): xdr.ScVal {
  return nativeToScVal(
    {
      id: nativeToScVal(7n, { type: "u64" }),
      client: nativeToScVal(Keypair.random().publicKey(), { type: "address" }),
      provider: nativeToScVal(Keypair.random().publicKey(), { type: "address" }),
      evaluator: nativeToScVal(Keypair.random().publicKey(), { type: "address" }),
      token: nativeToScVal(TESTNET.usdcToken, { type: "address" }),
      budget: nativeToScVal(1_000n, { type: "i128" }),
      status,
      description: nativeToScVal("test", { type: "string" }),
      deliverable: nativeToScVal("", { type: "string" }),
    },
    { type: "map" },
  );
}

test("getJob unwraps a Soroban enum variant status into a plain string", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  (client as any).simulateOption = async (_op: unknown, decode: (v: xdr.ScVal) => unknown) =>
    decode(jobScVal(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Funded")])));

  const job = await client.getJob(7n);
  assert.equal(job?.status, "Funded");
  assert.equal(typeof job?.status, "string");
  assert.ok(job?.status === "Funded");

  client.disconnect();
});

test("getJob maps a numeric status to its JobStatus string", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  (client as any).simulateOption = async (_op: unknown, decode: (v: xdr.ScVal) => unknown) =>
    decode(jobScVal(nativeToScVal(2, { type: "u32" })));

  const job = await client.getJob(7n);
  assert.equal(job?.status, "Submitted");

  client.disconnect();
});

// ---------------------------------------------------------------------------
// #833 — createJob forwards sla_deadline and penalty_bps_per_hour
// ---------------------------------------------------------------------------

function captureCreateJobArgs(client: CommerceClient): xdr.ScVal[][] {
  const captured: xdr.ScVal[][] = [];
  (client as any).invoke = async (_signer: unknown, op: xdr.Operation) => {
    captured.push(op.body().invokeHostFunctionOp().hostFunction().invokeContract().args());
    return 1n;
  };
  return captured;
}

test("createJob defaults sla_deadline and penalty_bps_per_hour to zero", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });
  const captured = captureCreateJobArgs(client);

  await client.createJob(
    Keypair.random(),
    Keypair.random().publicKey(),
    Keypair.random().publicKey(),
    TESTNET.usdcToken,
    1_000n,
    "test job",
  );

  const args = captured[0];
  assert.equal(args.length, 8);
  assert.equal(args[6].switch().name, "scvU64");
  assert.equal(scValToNative(args[6]), 0n);
  assert.equal(args[7].switch().name, "scvU32");
  assert.equal(scValToNative(args[7]), 0);

  client.disconnect();
});

test("createJob encodes SLA parameters as u64 and u32", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });
  const captured = captureCreateJobArgs(client);

  await client.createJob(
    Keypair.random(),
    Keypair.random().publicKey(),
    Keypair.random().publicKey(),
    TESTNET.usdcToken,
    1_000n,
    "test job",
    { slaDeadline: 1_700_000_000n, penaltyBpsPerHour: 25 },
  );

  const args = captured[0];
  assert.equal(scValToNative(args[6]), 1_700_000_000n);
  assert.equal(scValToNative(args[7]), 25);

  client.disconnect();
});

test("createJobAndWait and approveAndCreateJob forward SLA parameters", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });
  const captured = captureCreateJobArgs(client);
  (client as any).allowance = async () => 1_000n;

  const sla = { slaDeadline: 1_800_000_000n, penaltyBpsPerHour: 50 };
  const provider = Keypair.random().publicKey();
  const evaluator = Keypair.random().publicKey();

  await client.createJobAndWait(Keypair.random(), provider, evaluator, TESTNET.usdcToken, 1_000n, "a", sla);
  await client.approveAndCreateJob(Keypair.random(), provider, evaluator, TESTNET.usdcToken, 1_000n, "b", sla);

  assert.equal(captured.length, 2);
  for (const args of captured) {
    assert.equal(scValToNative(args[6]), 1_800_000_000n);
    assert.equal(scValToNative(args[7]), 50);
  }

  client.disconnect();
});

// ---------------------------------------------------------------------------
// #951 — simulation-only dry-run methods for every write
// ---------------------------------------------------------------------------

test("CommerceClient exposes the simulate namespace with a method per write", () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  assert.ok(client.simulate);
  assert.equal(typeof client.simulate.createJob, "function");
  assert.equal(typeof client.simulate.submit, "function");
  assert.equal(typeof client.simulate.complete, "function");
  assert.equal(typeof client.simulate.cancel, "function");
  assert.equal(typeof client.simulate.approve, "function");
  assert.equal(typeof client.simulate.openChannel, "function");
  assert.equal(typeof client.simulate.closeChannel, "function");
  assert.equal(typeof client.simulate.forceClose, "function");
  assert.equal(typeof client.simulate.setTreasury, "function");
  assert.equal(typeof client.simulate.setFeeBps, "function");

  client.disconnect();
});

test("simulate.createJob works without a funded signer and never submits", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  // A random keypair is unfunded on testnet; simulation must not require it.
  const unfunded = Keypair.random();
  let submitted = false;
  (client as any).invoke = async () => {
    submitted = true;
    throw new Error("simulate must not submit");
  };

  const result = await client.simulate.createJob(
    unfunded,
    Keypair.random().publicKey(),
    Keypair.random().publicKey(),
    TESTNET.usdcToken,
    1_000n,
    "dry run",
  );

  assert.equal(submitted, false);
  assert.ok(result);
  assert.equal(typeof result.minResourceFee, "string");
  assert.ok(Array.isArray(result.events));
  assert.equal(result.error, undefined);

  client.disconnect();
});

test("simulate.createJob returns resource fees and expected events on success", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  const expectedEvent = {
    type: "contract",
    contractId: TESTNET.contractId,
    topics: [nativeToScVal("job_created", { type: "symbol" })],
    data: nativeToScVal(1n, { type: "u64" }),
  };

  (client as any).simulateDryRun = async () => ({
    minResourceFee: "12345",
    transactionData: {} as any,
    result: { retval: nativeToScVal(1n, { type: "u64" }) },
    events: [expectedEvent],
  });

  const result = await client.simulate.createJob(
    Keypair.random(),
    Keypair.random().publicKey(),
    Keypair.random().publicKey(),
    TESTNET.usdcToken,
    1_000n,
    "dry run",
  );

  assert.equal(result.minResourceFee, "12345");
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0], expectedEvent);
  assert.equal(result.error, undefined);

  client.disconnect();
});

test("simulate.createJob throws a typed ContractError with decoded code and name on contract failure", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  (client as any).simulateDryRun = async () => {
    throw new ContractError(
      KnownContractErrorCode.SelfEscrow,
      TESTNET.contractId,
    );
  };

  await assert.rejects(
    client.simulate.createJob(
      Keypair.random(),
      Keypair.random().publicKey(),
      Keypair.random().publicKey(),
      TESTNET.usdcToken,
      1_000n,
      "dry run",
    ),
    (err: unknown) => {
      assert.ok(err instanceof ContractError);
      assert.equal(err.code, KnownContractErrorCode.SelfEscrow);
      assert.equal(err.name, "ContractError");
      assert.match(err.explanation, /SelfEscrow/);
      return true;
    },
  );

  client.disconnect();
});

test("simulate.submit and simulate.complete validate arguments before simulating", async () => {
  const client = new CommerceClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  await assert.rejects(
    client.simulate.submit(
      Keypair.random(),
      1n,
      "https://example.com/deliverable",
      new Uint8Array(16) as any,
    ),
    /32 bytes/i,
  );

  await assert.rejects(
    client.simulate.createJob(
      Keypair.random(),
      Keypair.random().publicKey(),
      Keypair.random().publicKey(),
      TESTNET.usdcToken,
      0n,
      "dry run",
    ),
    /budget must be greater than 0/,
  );

  client.disconnect();
});
