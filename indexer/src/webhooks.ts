import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Outbound webhook notification dispatcher for new escrow jobs.
 *
 * Seller agents can register a `webhook_url` and `webhook_secret` in their
 * agent metadata. Whenever the indexer processes a `JobCreated` event and the
 * job is assigned to a provider agent, we POST a signed notification to the
 * provider's webhook URL.
 *
 * The request body is signed with HMAC-SHA256 using the agent's secret and the
 * signature is sent in the `X-Bear-Signature` header so providers can verify
 * authenticity and prevent spoofing.
 */

export const SIGNATURE_HEADER = 'X-Bear-Signature';

/** Maximum number of delivery attempts (initial attempt + retries). */
export const MAX_ATTEMPTS = 3;

/** Base delay in milliseconds for exponential backoff. */
export const BASE_BACKOFF_MS = 250;

/** Per-request timeout in milliseconds. */
export const REQUEST_TIMEOUT_MS = 5000;

export interface AgentWebhookConfig {
  webhook_url?: string | null;
  webhook_secret?: string | null;
}

export interface JobCreatedPayload {
  event: 'JobCreated';
  jobId: string;
  budget: string | number;
  client: string;
  description: string;
}

export interface DispatchResult {
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

/** Number of consecutive failed deliveries before a failure alert fires. */
export const FAILURE_ALERT_THRESHOLD = MAX_ATTEMPTS;

/** Default grace window (ms) during which the previous secret is still accepted. */
export const SECRET_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WebhookSubscription {
  id: string;
  agentId: string;
  url: string;
  secret: string;
  /** Previous secret kept valid for verification during rotation grace window. */
  previousSecret?: string | null;
  /** Epoch ms after which `previousSecret` is no longer accepted. */
  previousSecretExpiresAt?: number | null;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryLogEntry {
  subscriptionId: string;
  jobId?: string;
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
  timestamp: number;
}

export interface FailureAlert {
  subscriptionId: string;
  agentId: string;
  url: string;
  attempts: number;
  status?: number;
  error?: string;
  timestamp: number;
}

export type FailureAlertHandler = (alert: FailureAlert) => void | Promise<void>;

export interface SubscriptionStore {
  create(input: {
    agentId: string;
    url: string;
    secret?: string;
  }): WebhookSubscription;
  list(agentId?: string): WebhookSubscription[];
  get(id: string): WebhookSubscription | null;
  update(
    id: string,
    patch: Partial<Pick<WebhookSubscription, 'url' | 'active'>>
  ): WebhookSubscription | null;
  delete(id: string): boolean;
  rotateSecret(id: string, graceWindowMs?: number): WebhookSubscription | null;
  recordDelivery(entry: DeliveryLogEntry): void;
  listDeliveries(subscriptionId: string): DeliveryLogEntry[];
}

/** Generate a cryptographically random hex secret suitable for HMAC signing. */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * In-memory subscription store with CRUD, secret rotation and delivery logs.
 *
 * The store is intentionally dependency-free so it can back the indexer's
 * HTTP endpoints and be swapped for a persistent implementation later.
 */
export function createSubscriptionStore(options: {
  onFailureAlert?: FailureAlertHandler;
  failureThreshold?: number;
  now?: () => number;
  idFactory?: () => string;
} = {}): SubscriptionStore {
  const now = options.now ?? (() => Date.now());
  const failureThreshold = options.failureThreshold ?? FAILURE_ALERT_THRESHOLD;
  const idFactory = options.idFactory ?? (() => randomBytes(16).toString('hex'));
  const subscriptions = new Map<string, WebhookSubscription>();
  const deliveries = new Map<string, DeliveryLogEntry[]>();

  return {
    create(input) {
      const ts = now();
      const sub: WebhookSubscription = {
        id: idFactory(),
        agentId: input.agentId,
        url: input.url.trim(),
        secret: input.secret && input.secret !== '' ? input.secret : generateSecret(),
        previousSecret: null,
        previousSecretExpiresAt: null,
        active: true,
        createdAt: ts,
        updatedAt: ts,
      };
      subscriptions.set(sub.id, sub);
      deliveries.set(sub.id, []);
      return { ...sub };
    },

    list(agentId) {
      const all = Array.from(subscriptions.values());
      const filtered = agentId ? all.filter((s) => s.agentId === agentId) : all;
      return filtered.map((s) => ({ ...s }));
    },

    get(id) {
      const sub = subscriptions.get(id);
      return sub ? { ...sub } : null;
    },

    update(id, patch) {
      const sub = subscriptions.get(id);
      if (!sub) return null;
      if (patch.url !== undefined) sub.url = patch.url.trim();
      if (patch.active !== undefined) sub.active = patch.active;
      sub.updatedAt = now();
      return { ...sub };
    },

    delete(id) {
      deliveries.delete(id);
      return subscriptions.delete(id);
    },

    rotateSecret(id, graceWindowMs = SECRET_GRACE_WINDOW_MS) {
      const sub = subscriptions.get(id);
      if (!sub) return null;
      const ts = now();
      sub.previousSecret = sub.secret;
      sub.previousSecretExpiresAt = ts + graceWindowMs;
      sub.secret = generateSecret();
      sub.updatedAt = ts;
      return { ...sub };
    },

    recordDelivery(entry) {
      const log = deliveries.get(entry.subscriptionId);
      if (!log) return;
      log.push({ ...entry });
      if (!entry.ok && entry.attempts >= failureThreshold && options.onFailureAlert) {
        const sub = subscriptions.get(entry.subscriptionId);
        if (sub) {
          const alert: FailureAlert = {
            subscriptionId: sub.id,
            agentId: sub.agentId,
            url: sub.url,
            attempts: entry.attempts,
            status: entry.status,
            error: entry.error,
            timestamp: entry.timestamp,
          };
          try {
            void options.onFailureAlert(alert);
          } catch {
            // Never let an alert handler break delivery recording.
          }
        }
      }
    },

    listDeliveries(subscriptionId) {
      const log = deliveries.get(subscriptionId);
      return log ? log.map((e) => ({ ...e })) : [];
    },
  };
}

/**
 * Verify a signature against a subscription, accepting either the current
 * secret or the previous secret while its grace window is still open.
 */
export function verifySubscriptionSignature(
  subscription: Pick<
    WebhookSubscription,
    'secret' | 'previousSecret' | 'previousSecretExpiresAt'
  >,
  rawBody: string,
  signature: string,
  nowMs: number = Date.now()
): boolean {
  if (verifySignature(rawBody, subscription.secret, signature)) return true;
  if (
    subscription.previousSecret &&
    subscription.previousSecretExpiresAt != null &&
    nowMs <= subscription.previousSecretExpiresAt
  ) {
    return verifySignature(rawBody, subscription.previousSecret, signature);
  }
  return false;
}

/**
 * Minimal fetch-like signature so the dispatcher can be unit tested without
 * pulling in a real HTTP stack.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{ ok: boolean; status: number }>;

/**
 * Compute the HMAC-SHA256 signature of a raw request body.
 *
 * Returns a lowercase hex-encoded digest. This is the exact value that is sent
 * in the `X-Bear-Signature` header.
 */
export function generateSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Constant-time verification helper for providers (and for our own tests).
 * Returns false for malformed signatures rather than throwing.
 */
export function verifySignature(
  rawBody: string,
  secret: string,
  signature: string
): boolean {
  if (!signature) return false;
  const expected = generateSignature(rawBody, secret);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  try {
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

/**
 * Extract webhook configuration from arbitrary agent metadata.
 * Returns null when the agent has not registered a usable webhook.
 */
export function getWebhookConfig(
  metadata: AgentWebhookConfig | null | undefined
): { url: string; secret: string } | null {
  if (!metadata) return null;
  const url = metadata.webhook_url;
  const secret = metadata.webhook_secret;
  if (typeof url !== 'string' || url.trim() === '') return null;
  if (typeof secret !== 'string' || secret === '') return null;
  return { url: url.trim(), secret };
}

/**
 * Build the JSON payload for a JobCreated notification.
 */
export function buildJobCreatedPayload(input: {
  jobId: string;
  budget: string | number;
  client: string;
  description: string;
}): JobCreatedPayload {
  return {
    event: 'JobCreated',
    jobId: input.jobId,
    budget: input.budget,
    client: input.client,
    description: input.description,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the backoff delay for a given (0-based) retry index.
 * Attempt 0 -> BASE_BACKOFF_MS, attempt 1 -> 2x, attempt 2 -> 4x, ...
 */
export function backoffDelay(attempt: number): number {
  return BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempt));
}

/**
 * Determine whether a failed response should be retried.
 * We retry on network errors (no status) and on 5xx responses.
 */
export function shouldRetry(status: number | undefined): boolean {
  if (status === undefined) return true; // network / timeout error
  return status >= 500 && status <= 599;
}

export interface DispatchOptions {
  fetchImpl?: FetchLike;
  /** Override the sleep function (useful in tests to avoid real delays). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Override max attempts (defaults to MAX_ATTEMPTS). */
  maxAttempts?: number;
  /** Override request timeout (defaults to REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * Deliver a signed webhook POST to the provider URL.
 *
 * Retries up to `maxAttempts` times with exponential backoff on 5xx responses
 * and network/timeout failures. This function NEVER throws; it always resolves
 * with a DispatchResult so the indexer poller cannot be crashed by a failing
 * webhook.
 */
export async function dispatchWebhook(
  config: { url: string; secret: string },
  payload: JobCreatedPayload,
  options: DispatchOptions = {}
): Promise<DispatchResult> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const sleepImpl = options.sleepImpl ?? sleep;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  if (typeof fetchImpl !== 'function') {
    return { ok: false, attempts: 0, error: 'fetch is not available' };
  }

  const rawBody = JSON.stringify(payload);
  const signature = generateSignature(rawBody, config.secret);

  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        timer = setTimeout(() => controller?.abort(), timeoutMs);
      }

      const response = await fetchImpl(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [SIGNATURE_HEADER]: signature,
        },
        body: rawBody,
        signal: controller?.signal,
      });

      lastStatus = response.status;
      lastError = undefined;

      if (response.ok) {
        return { ok: true, attempts: attempt + 1, status: response.status };
      }

      if (!shouldRetry(response.status)) {
        // Non-retryable (e.g. 4xx): stop immediately.
        return {
          ok: false,
          attempts: attempt + 1,
          status: response.status,
          error: `HTTP ${response.status}`,
        };
      }
    } catch (err) {
      lastStatus = undefined;
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    // Schedule backoff before the next attempt (skip after the final attempt).
    if (attempt < maxAttempts - 1) {
      try {
        await sleepImpl(backoffDelay(attempt));
      } catch {
        // Ignore sleep errors; never throw into the poller.
      }
    }
  }

  return {
    ok: false,
    attempts: maxAttempts,
    status: lastStatus,
    error: lastError ?? (lastStatus !== undefined ? `HTTP ${lastStatus}` : 'delivery failed'),
  };
}

/**
 * High-level helper: look up the provider's webhook config from agent metadata
 * and dispatch a JobCreated notification. Returns null when the agent has no
 * webhook configured (nothing to do). Never throws.
 */
export async function notifyJobCreated(
  metadata: AgentWebhookConfig | null | undefined,
  input: {
    jobId: string;
    budget: string | number;
    client: string;
    description: string;
  },
  options: DispatchOptions = {}
): Promise<DispatchResult | null> {
  const config = getWebhookConfig(metadata);
  if (!config) return null;

  try {
    const payload = buildJobCreatedPayload(input);
    return await dispatchWebhook(config, payload, options);
  } catch (err) {
    // Defensive: dispatchWebhook should never throw, but guarantee it here.
    return {
      ok: false,
      attempts: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

```typescript
// indexer/src/webhooks.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  generateSignature,
  verifySignature,
  getWebhookConfig,
  buildJobCreatedPayload,
  backoffDelay,
  shouldRetry,
  dispatchWebhook,
  notifyJobCreated,
  SIGNATURE_HEADER,
  MAX_ATTEMPTS,
  BASE_BACKOFF_MS,
  type FetchLike,
  type JobCreatedPayload,
} from './webhooks';

const payload: JobCreatedPayload = {
  event: 'JobCreated',
  jobId: 'job-123',
  budget: '1000',
  client: 'GCLIENT',
  description: 'Build a thing',
};

describe('generateSignature', () => {
  it('produces a deterministic HMAC-SHA256 hex digest', () => {
    const body = JSON.stringify(payload);
    const sig = generateSignature(body, 'secret');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSignature(body, 'secret')).toBe(sig);
  });

  it('changes when the body or secret changes', () => {
    const body = JSON.stringify(payload);
    const a = generateSignature(body, 'secret-a');
    const b = generateSignature(body, 'secret-b');
    const c = generateSignature(body + ' ', 'secret-a');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('matches a known HMAC-SHA256 vector', () => {
    // echo -n "hello" | openssl dgst -sha256 -hmac "key"
    expect(generateSignature('hello', 'key')).toBe(
      '5031fe3d989c6d1537a013fa6e739da23463fdaec3b70137d828e36ace221bd0'
    );
  });
});

describe('verifySignature', () => {
  it('accepts a valid signature and rejects invalid ones', () => {
    const body = JSON.stringify(payload);
    const sig = generateSignature(body, 'secret');
    expect(verifySignature(body, 'secret', sig)).toBe(true);
    expect(verifySignature(body, 'wrong', sig)).toBe(false);
    expect(verifySignature(body, 'secret', 'deadbeef')).toBe(false);
    expect(verifySignature(body, 'secret', '')).toBe(false);
  });
});

describe('getWebhookConfig', () => {
  it('returns null when metadata is missing or incomplete', () => {
    expect(getWebhookConfig(null)).toBeNull();
    expect(getWebhookConfig({})).toBeNull();
    expect(getWebhookConfig({ webhook_url: 'https://x' })).toBeNull();
    expect(getWebhookConfig({ webhook_secret: 's' })).toBeNull();
    expect(getWebhookConfig({ webhook_url: '   ', webhook_secret: 's' })).toBeNull();
  });

  it('returns trimmed url and secret when present', () => {
    expect(
      getWebhookConfig({ webhook_url: ' https://x ', webhook_secret: 's' })
    ).toEqual({ url: 'https://x', secret: 's' });
  });
});

describe('buildJobCreatedPayload', () => {
  it('builds the expected payload shape', () => {
    expect(
      buildJobCreatedPayload({
        jobId: 'j',
        budget: 5,
        client: 'c',
        description: 'd',
      })
    ).toEqual({ event: 'JobCreated', jobId: 'j', budget: 5, client: 'c', description: 'd' });
  });
});

describe('backoffDelay / shouldRetry', () => {
  it('grows exponentially', () => {
    expect(backoffDelay(0)).toBe(BASE_BACKOFF_MS);
    expect(backoffDelay(1)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffDelay(2)).toBe(BASE_BACKOFF_MS * 4);
  });

  it('retries on 5xx and network errors only', () => {
    expect(shouldRetry(undefined)).toBe(true);
    expect(shouldRetry(500)).toBe(true);
    expect(shouldRetry(503)).toBe(true);
    expect(shouldRetry(400)).toBe(false);
    expect(shouldRetry(404)).toBe(false);
    expect(shouldRetry(200)).toBe(false);
  });
});

describe('dispatchWebhook', () => {
  const config = { url: 'https://agent.example/hook', secret: 'topsecret' };
  const noSleep = () => Promise.resolve();

  it('sends a signed POST and succeeds on first try', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ({ ok: true, status: 200 }));
    const result = await dispatchWebhook(config, payload, {
      fetchImpl,
      sleepImpl: noSleep,
    });

    expect(result).toEqual({ ok: true, attempts: 1, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(config.url);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = init.body;
    expect(JSON.parse(body)).toEqual(payload);
    expect(init.headers[SIGNATURE_HEADER]).toBe(generateSignature(body, config.secret));
  });

  it('retries on 5xx with exponential backoff and eventually succeeds', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const sleepImpl = vi.fn(async () => {});

    const result = await dispatchWebhook(config, payload, { fetchImpl, sleepImpl });

    expect(result).toEqual({ ok: true, attempts: 3, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenNthCalledWith(1, backoffDelay(0));
    expect(sleepImpl).toHaveBeenNthCalledWith(2, backoffDelay(1));
  });

  it('gives up after MAX_ATTEMPTS on persistent 5xx without throwing', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ({ ok: false, status: 500 }));
    const sleepImpl = vi.fn(async () => {});

    const result = await dispatchWebhook(config, payload, { fetchImpl, sleepImpl });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(MAX_ATTEMPTS);
    expect(result.status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(sleepImpl).toHaveBeenCalledTimes(MAX_ATTEMPTS - 1);
  });

  it('does not retry on 4xx', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ({ ok: false, status: 400 }));
    const sleepImpl = vi.fn(async () => {});

    const result = await dispatchWebhook(config, payload, { fetchImpl, sleepImpl });

    expect(result).toEqual({ ok: false, attempts: 1, status: 400, error: 'HTTP 400' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('retries on network errors and never throws', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const sleepImpl = vi.fn(async () => {});

    const result = await dispatchWebhook(config, payload, { fetchImpl, sleepImpl });

    expect(result).toEqual({ ok: true, attempts: 3, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns a failure result (not a throw) when all attempts error', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new Error('boom');
    });
    const sleepImpl = vi.fn(async () => {});

    const result = await dispatchWebhook(config, payload, { fetchImpl, sleepImpl });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(MAX_ATTEMPTS);
    expect(result.error).toBe('boom');
  });
});

describe('notifyJobCreated', () => {
  it('returns null when no webhook is configured', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const result = await notifyJobCreated(null, {
      jobId: 'j',
      budget: 1,
      client: 'c',
      description: 'd',
    }, { fetchImpl });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('dispatches when a webhook is configured', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ({ ok: true, status: 200 }));
    const result = await notifyJobCreated(
      { webhook_url: 'https://agent.example/hook', webhook_secret: 's' },
      { jobId: 'j', budget: 1, client: 'c', description: 'd' },
      { fetchImpl, sleepImpl: () => Promise.resolve() }
    );
    expect(result?.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});