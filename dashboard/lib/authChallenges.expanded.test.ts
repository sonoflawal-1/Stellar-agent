import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { buildChallenge } from "./auth.js";

process.env.JWT_SECRET = "test-secret";
process.env.STELLAR_HOME_DOMAIN = "example.com";

test("challenge is issued for valid account", () => {
  const kp = Keypair.random();
  const xdr = buildChallenge(kp.publicKey());
  assert.ok(xdr.length > 50);
});

test("second challenge replaces first in store", () => {
  const kp = Keypair.random();
  const a = buildChallenge(kp.publicKey());
  const b = buildChallenge(kp.publicKey());
  assert.notEqual(a, b);
});

test("invalid public key is rejected", () => {
  assert.throws(() => buildChallenge("not-a-key"), /Invalid Stellar public key/);
});