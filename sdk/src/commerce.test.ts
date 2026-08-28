import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { CommerceClient } from "./commerce.js";
import { TESTNET } from "./types.js";

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
