import assert from "node:assert/strict";
import test from "node:test";
import { MAINNET, TESTNET, loadConfig } from "./types.js";

test("loadConfig resolves the testnet deployment preset", () => {
  const cfg = loadConfig("testnet");

  assert.equal(cfg.rpcUrl, "https://soroban-testnet.stellar.org");
  assert.equal(cfg.networkPassphrase, "Test SDF Network ; September 2015");
  assert.equal(cfg.identityContract, TESTNET.identityContract);
  assert.equal(cfg.commerceContract, TESTNET.commerceContract);
  assert.equal(cfg.usdcToken, TESTNET.usdcToken);
});

test("MAINNET exposes a production preset", () => {
  const cfg = loadConfig("mainnet");

  assert.equal(cfg.rpcUrl, MAINNET.rpcUrl);
  assert.equal(cfg.networkPassphrase, MAINNET.networkPassphrase);
  assert.equal(cfg.usdcToken, MAINNET.usdcToken);
});
