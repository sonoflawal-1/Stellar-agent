import assert from "node:assert/strict";
import test from "node:test";
import { IssuedChallengeStore } from "./authChallenges.js";

test("issued challenges expire and can only be consumed once", () => {
  let now = 0;
  const challenges = new IssuedChallengeStore({ ttlMs: 300_000, now: () => now });
  try {
    challenges.issue("challenge-hash");
    assert.equal(challenges.has("challenge-hash"), true);
    assert.equal(challenges.consume("challenge-hash"), true);
    assert.equal(challenges.consume("challenge-hash"), false);

    challenges.issue("expired-hash");
    now = 300_000;
    assert.equal(challenges.has("expired-hash"), false);
    assert.equal(challenges.consume("expired-hash"), false);
  } finally {
    challenges.stop();
  }
});
