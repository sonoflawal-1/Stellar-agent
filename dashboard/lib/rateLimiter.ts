export type SlidingWindowResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

/**
 * Bucket kinds used by the dashboard rate limiter.
 *
 * - `ip`: per-client-IP bucket, applied to every request.
 * - `wallet`: per-wallet bucket, applied to authenticated requests so a single
 *   wallet cannot fan out across many IPs.
 * - `token`: per-API-token bucket, applied to token-authenticated requests.
 * - `cost`: cost-weighted bucket for embedding-heavy routes (e.g.
 *   `/api/agents/match`, embeddings), where each request consumes a number of
 *   slots proportional to its cost.
 *
 * Each kind is kept in its own `SlidingWindowRateLimiter` instance so limits
 * and windows can be tuned independently.
 */
export type RateLimitBucketKind = "ip" | "wallet" | "token" | "cost";

export type RateLimitBuckets = Record<
  RateLimitBucketKind,
  SlidingWindowRateLimiter
>;

export type RateLimitBucketOptions = {
  limit: number;
  windowMs: number;
  pruneIntervalMs?: number;
  now?: () => number;
};

/**
 * Build a set of independent limiters, one per bucket kind.
 *
 * Callers may omit any kind; omitted kinds are not created and therefore not
 * enforced. This keeps the helper usable for routes that only need a subset of
 * the buckets.
 */
export function createRateLimitBuckets(
  options: Partial<Record<RateLimitBucketKind, RateLimitBucketOptions>>,
): Partial<RateLimitBuckets> {
  const buckets: Partial<RateLimitBuckets> = {};
  for (const kind of Object.keys(options) as RateLimitBucketKind[]) {
    const opts = options[kind];
    if (!opts) continue;
    buckets[kind] = new SlidingWindowRateLimiter(opts);
  }
  return buckets;
}

/**
 * Build the `Retry-After` header value (in seconds) for a rejected result.
 * Returns an empty object when the request was allowed.
 */
export function retryAfterHeaders(
  result: SlidingWindowResult,
): Record<string, string> {
  if (result.allowed) return {};
  return { "Retry-After": String(Math.max(1, result.retryAfterSeconds)) };
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly pruneIntervalMs: number;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(options: {
    limit: number;
    windowMs: number;
    pruneIntervalMs?: number;
    now?: () => number;
  }) {
    this.limit = Math.max(1, Math.floor(options.limit));
    this.windowMs = Math.max(1, Math.floor(options.windowMs));
    this.pruneIntervalMs = Math.max(
      1,
      Math.floor(options.pruneIntervalMs ?? this.windowMs),
    );
    this.now = options.now ?? Date.now;
    this.startPruning();
  }

  /**
   * Record a request for `key` and report whether it is allowed.
   *
   * `cost` (default 1) is the number of slots the request consumes. When the
   * remaining capacity is insufficient the request is rejected and nothing is
   * recorded, so a rejected request does not further deplete the bucket.
   */
  check(key: string, cost: number = 1): SlidingWindowResult {
    const weight = Math.max(1, Math.floor(cost));
    const now = this.now();
    const windowStart = now - this.windowMs;
    let timestamps = this.buckets.get(key);
    if (!timestamps) {
      timestamps = [];
      this.buckets.set(key, timestamps);
    }
    let expired = 0;
    while (expired < timestamps.length && timestamps[expired] <= windowStart) {
      expired += 1;
    }
    if (expired > 0) timestamps.splice(0, expired);

    if (timestamps.length + weight > this.limit) {
      // Retry-After is driven by the oldest entry that must expire before
      // `weight` slots become available again.
      const needed = timestamps.length + weight - this.limit;
      const oldest = timestamps[Math.max(0, needed - 1)];
      const retryAfterMs =
        oldest === undefined ? 0 : Math.max(0, oldest + this.windowMs - now);
      return {
        allowed: false,
        limit: this.limit,
        remaining: Math.max(0, this.limit - timestamps.length),
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    for (let i = 0; i < weight; i += 1) timestamps.push(now);
    return {
      allowed: true,
      limit: this.limit,
      remaining: Math.max(0, this.limit - timestamps.length),
      retryAfterSeconds: 0,
    };
  }

  /**
   * Return the `Retry-After` header for a result, or an empty object when the
   * request was allowed. Convenience wrapper around `retryAfterHeaders`.
   */
  retryAfterHeaders(result: SlidingWindowResult): Record<string, string> {
    return retryAfterHeaders(result);
  }

  /** Remove all keys whose timestamps have fully expired. */
  prune(): void {
    const windowStart = this.now() - this.windowMs;
    for (const [key, timestamps] of this.buckets) {
      let expired = 0;
      while (expired < timestamps.length && timestamps[expired] <= windowStart) {
        expired += 1;
      }
      if (expired > 0) timestamps.splice(0, expired);
      if (timestamps.length === 0) this.buckets.delete(key);
    }
  }

  /** Number of tracked keys (exposed for tests / metrics). */
  size(): number {
    return this.buckets.size;
  }

  /** Stop the background pruning timer. */
  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  private startPruning(): void {
    this.pruneTimer = setInterval(() => this.prune(), this.pruneIntervalMs);
    this.pruneTimer.unref?.();
  }
}
