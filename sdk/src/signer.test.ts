import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { createKeypairFromSecret, generateRandomKeypair, isValidSecretKey } from "./signer.js";

test("isValidSecretKey returns true for a valid secret seed", () => {
  const kp = Keypair.random();
  assert.equal(isValidSecretKey(kp.secret()), true);
});

test("isValidSecretKey returns false for a malformed string", () => {
  assert.equal(isValidSecretKey("not-a-secret-key"), false);
});

test("isValidSecretKey returns false for an empty string", () => {
  assert.equal(isValidSecretKey(""), false);
});

test("isValidSecretKey returns false for a public key (wrong prefix)", () => {
  const kp = Keypair.random();
  assert.equal(isValidSecretKey(kp.publicKey()), false);
});

test("createKeypairFromSecret returns a matching Keypair for a valid secret", () => {
  const kp = Keypair.random();
  const rebuilt = createKeypairFromSecret(kp.secret());
  assert.equal(rebuilt.publicKey(), kp.publicKey());
  assert.equal(rebuilt.secret(), kp.secret());
});

test("createKeypairFromSecret throws a descriptive error for invalid input", () => {
  assert.throws(() => createKeypairFromSecret("bogus"), /Invalid Stellar secret key format/);
});

test("createKeypairFromSecret throws for an empty string", () => {
  assert.throws(() => createKeypairFromSecret(""), /Invalid Stellar secret key format/);
});

test("generateRandomKeypair returns a valid, usable Keypair", () => {
  const kp = generateRandomKeypair();
  assert.equal(isValidSecretKey(kp.secret()), true);
  assert.equal(typeof kp.publicKey(), "string");
  assert.equal(kp.publicKey().startsWith("G"), true);
});

test("generateRandomKeypair returns distinct keypairs on each call", () => {
  const a = generateRandomKeypair();
  const b = generateRandomKeypair();
  assert.notEqual(a.publicKey(), b.publicKey());
});
