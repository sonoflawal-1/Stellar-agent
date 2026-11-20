import test from "node:test";
import assert from "node:assert/strict";
import {
  diffDeploymentManifests,
  exceedsGasRegressionThreshold,
  extractReadmeContractAddresses,
  formatVerificationCheck,
} from "./script-helpers.ts";

test("exceedsGasRegressionThreshold", () => {
  assert.equal(exceedsGasRegressionThreshold(110, 100, 5), true);
  assert.equal(exceedsGasRegressionThreshold(104, 100, 5), false);
});

test("formatVerificationCheck", () => {
  assert.match(formatVerificationCheck("fee", true, "ok"), /PASS/);
});

test("extractReadmeContractAddresses", () => {
  const md = `| Agent Identity | \`CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5\` |`;
  const addrs = extractReadmeContractAddresses(md);
  assert.equal(addrs.agent_identity, "CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5");
});

test("diffDeploymentManifests detects mismatch", () => {
  const mismatches = diffDeploymentManifests(
    { agent_identity: "CAAAA" },
    { agent_identity: "CBBBB" },
  );
  assert.equal(mismatches.length, 1);
});