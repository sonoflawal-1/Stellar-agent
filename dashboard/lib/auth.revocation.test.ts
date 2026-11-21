import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-secret-for-revocation-tests";

import { Keypair } from "@stellar/stellar-sdk";

const { createSession, verifySession, invalidateSession, refreshSession } =
  await import("./auth.js");

const PUBLIC = Keypair.random().publicKey();

test("logout adds jti to denylist", () => {
  const token = createSession(PUBLIC);
  assert.ok(verifySession(token));
  invalidateSession(token);
  assert.equal(verifySession(token), null);
});

test("refresh rotation invalidates previous token", () => {
  const first = createSession(PUBLIC);
  const second = refreshSession(first);
  assert.ok(second);
  assert.equal(verifySession(first), null);
  assert.ok(verifySession(second!));
});

test("refresh reuse revokes token family", () => {
  const a = createSession(PUBLIC);
  const b = refreshSession(a);
  assert.ok(b);
  const reused = refreshSession(a);
  assert.equal(reused, null);
  assert.equal(verifySession(b!), null);
});