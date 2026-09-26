import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
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
