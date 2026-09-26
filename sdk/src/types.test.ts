import assert from "node:assert/strict";
import test from "node:test";
import { MAINNET, TESTNET, loadConfig } from "./types.js";
import { JobStatus, JobStatusFromNumber, isJobTerminal, isJobActive } from "./types.js";

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

test('isJobTerminal returns true for terminal states', () => {
  assert.equal(isJobTerminal(JobStatus.Completed), true);
  assert.equal(isJobTerminal(JobStatus.Cancelled), true);
  assert.equal(isJobTerminal(JobStatus.Rejected), true);
});

test('isJobTerminal returns false for non-terminal states', () => {
  assert.equal(isJobTerminal(JobStatus.Open), false);
  assert.equal(isJobTerminal(JobStatus.Funded), false);
  assert.equal(isJobTerminal(JobStatus.Submitted), false);
});

test('isJobActive returns true for active states', () => {
  assert.equal(isJobActive(JobStatus.Open), true);
  assert.equal(isJobActive(JobStatus.Funded), true);
  assert.equal(isJobActive(JobStatus.Submitted), true);
});

test('isJobActive returns false for terminal states', () => {
  assert.equal(isJobActive(JobStatus.Completed), false);
  assert.equal(isJobActive(JobStatus.Cancelled), false);
  assert.equal(isJobActive(JobStatus.Rejected), false);
});

test('isJobTerminal and isJobActive are mutually exclusive for all JobStatus values', () => {
  for (const status of Object.values(JobStatus)) {
    assert.notEqual(isJobTerminal(status), isJobActive(status),
      `Status ${status} should be either terminal or active, not both`);
  }
});

test('JobStatusFromNumber decodes status variant 6 as Disputed', () => {
  assert.equal(JobStatusFromNumber[6], JobStatus.Disputed);
});

test('JobStatusFromNumber decodes every on-chain status variant', () => {
  assert.equal(JobStatusFromNumber[0], JobStatus.Open);
  assert.equal(JobStatusFromNumber[1], JobStatus.Funded);
  assert.equal(JobStatusFromNumber[2], JobStatus.Submitted);
  assert.equal(JobStatusFromNumber[3], JobStatus.Completed);
  assert.equal(JobStatusFromNumber[4], JobStatus.Cancelled);
  assert.equal(JobStatusFromNumber[5], JobStatus.Rejected);
  assert.equal(JobStatusFromNumber[6], JobStatus.Disputed);
});
