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
