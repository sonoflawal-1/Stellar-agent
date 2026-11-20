import assert from "node:assert/strict";
import test from "node:test";
import { SlidingWindowRateLimiter } from "./rateLimiter.js";

test("prunes expired IP buckets without changing active-client limits", () => {
  let now = 0;
  const limiter = new SlidingWindowRateLimiter({
    limit: 2,
    windowMs: 60_000,
    now: () => now,
  });

  test("allows ten challenge requests per IP per minute and rejects the eleventh", () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 10, windowMs: 60_000 });
    try {
      for (let i = 0; i < 10; i += 1) {
        assert.equal(limiter.check("challenge-client").allowed, true);
      }
      assert.equal(limiter.check("challenge-client").allowed, false);
    } finally {
      limiter.stop();
    }
  });

  try {
    for (let i = 0; i < 10_000; i += 1) {
      assert.equal(limiter.check(`ip-${i}`).allowed, true);
    }
    limiter.check("active-client");
    assert.equal(limiter.check("active-client").allowed, true);
    assert.equal(limiter.check("active-client").allowed, false);
    assert.equal(limiter.size(), 10_001);

    now += 60_001;
    limiter.prune();

    assert.equal(limiter.size(), 0);
    assert.equal(limiter.check("active-client").allowed, true);
  } finally {
    limiter.stop();
  }
});

test("separate wallet and token buckets are independent", () => {
  let now = 0;
  const limiter = new SlidingWindowRateLimiter({
    limit: 2,
    windowMs: 60_000,
    now: () => now,
  });

  try {
    // Wallet bucket: exhaust it.
    assert.equal(limiter.check("wallet:0xabc").allowed, true);
    assert.equal(limiter.check("wallet:0xabc").allowed, true);
    assert.equal(limiter.check("wallet:0xabc").allowed, false);

    // A different wallet bucket is unaffected.
    assert.equal(limiter.check("wallet:0xdef").allowed, true);
    assert.equal(limiter.check("wallet:0xdef").allowed, true);

    // Token bucket keyed by token is independent of wallet buckets.
    assert.equal(limiter.check("token:tok-1").allowed, true);
    assert.equal(limiter.check("token:tok-1").allowed, true);
    assert.equal(limiter.check("token:tok-1").allowed, false);

    // IP bucket is independent of wallet/token buckets.
    assert.equal(limiter.check("ip:1.2.3.4").allowed, true);
    assert.equal(limiter.check("ip:1.2.3.4").allowed, true);
    assert.equal(limiter.check("ip:1.2.3.4").allowed, false);

    // After the window elapses, all buckets reset.
    now += 60_001;
    assert.equal(limiter.check("wallet:0xabc").allowed, true);
    assert.equal(limiter.check("token:tok-1").allowed, true);
    assert.equal(limiter.check("ip:1.2.3.4").allowed, true);
  } finally {
    limiter.stop();
  }
});

test("cost-weighted limits reject embedding-heavy requests sooner", () => {
  let now = 0;
  const limiter = new SlidingWindowRateLimiter({
    limit: 10,
    windowMs: 60_000,
    now: () => now,
  });

  try {
    // Cheap requests consume 1 unit each; ten of them exhaust the bucket.
    for (let i = 0; i < 9; i += 1) {
      assert.equal(limiter.check("embed:cheap", 1).allowed, true);
    }
    // A cost-5 request would exceed the remaining budget of 1.
    assert.equal(limiter.check("embed:cheap", 5).allowed, false);
    // A cost-1 request still fits.
    assert.equal(limiter.check("embed:cheap", 1).allowed, true);
    // Bucket is now exhausted.
    assert.equal(limiter.check("embed:cheap", 1).allowed, false);

    // A fresh bucket with heavy cost rejects after fewer requests than a
    // cheap-cost bucket would.
    assert.equal(limiter.check("embed:heavy", 5).allowed, true);
    assert.equal(limiter.check("embed:heavy", 5).allowed, true);
    assert.equal(limiter.check("embed:heavy", 5).allowed, false);

    // A single request whose cost exceeds the limit is rejected outright.
    assert.equal(limiter.check("embed:oversized", 11).allowed, false);
  } finally {
    limiter.stop();
  }
});

test("rejected checks return retryAfterSeconds > 0 for Retry-After", () => {
  let now = 0;
  const limiter = new SlidingWindowRateLimiter({
    limit: 1,
    windowMs: 60_000,
    now: () => now,
  });

  try {
    const first = limiter.check("retry-client");
    assert.equal(first.allowed, true);
    assert.equal(first.retryAfterSeconds, 0);

    const rejected = limiter.check("retry-client");
    assert.equal(rejected.allowed, false);
    assert.ok(
      rejected.retryAfterSeconds > 0,
      "rejected check must expose retryAfterSeconds > 0",
    );
    assert.ok(rejected.retryAfterSeconds <= 60);

    // Advancing partway through the window reduces the retry hint.
    now += 30_000;
    const partial = limiter.check("retry-client");
    assert.equal(partial.allowed, false);
    assert.ok(partial.retryAfterSeconds > 0);
    assert.ok(partial.retryAfterSeconds <= 30);

    // Once the window fully elapses, the client is allowed again.
    now += 30_001;
    const recovered = limiter.check("retry-client");
    assert.equal(recovered.allowed, true);
    assert.equal(recovered.retryAfterSeconds, 0);
  } finally {
    limiter.stop();
  }
});