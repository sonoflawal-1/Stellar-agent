import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseClient } from './baseClient';

/**
 * Flaky mock RPC server.
 * Each endpoint can be configured to fail a number of times (with a given
 * status code) before succeeding. Records all calls for assertions.
 */
interface EndpointBehavior {
  url: string;
  failuresRemaining: number;
  statusCode: number;
  calls: number;
}

class FlakyMockRpcServer {
  endpoints: EndpointBehavior[];

  constructor(endpoints: Array<{ url: string; failures?: number; statusCode?: number }>) {
    this.endpoints = endpoints.map((e) => ({
      url: e.url,
      failuresRemaining: e.failures ?? 0,
      statusCode: e.statusCode ?? 429,
      calls: 0,
    }));
  }

  getEndpoint(url: string): EndpointBehavior | undefined {
    return this.endpoints.find((e) => e.url === url);
  }

  /**
   * Simulates an RPC call against the given URL.
   * Throws an error with a `status` property when the endpoint is configured
   * to fail, otherwise returns a successful response.
   */
  async call(url: string, method: string, params: unknown[]): Promise<unknown> {
    const endpoint = this.getEndpoint(url);
    if (!endpoint) {
      const err = new Error(`Unknown endpoint: ${url}`) as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    endpoint.calls += 1;
    if (endpoint.failuresRemaining > 0) {
      endpoint.failuresRemaining -= 1;
      const err = new Error(`RPC error ${endpoint.statusCode} from ${url}`) as Error & {
        status?: number;
      };
      err.status = endpoint.statusCode;
      throw err;
    }
    return { jsonrpc: '2.0', id: 1, result: { method, params, url } };
  }

  totalCalls(): number {
    return this.endpoints.reduce((sum, e) => sum + e.calls, 0);
  }
}

describe('BaseClient retry and failover', () => {
  let server: FlakyMockRpcServer;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setupServer(
    endpoints: Array<{ url: string; failures?: number; statusCode?: number }>,
  ): void {
    server = new FlakyMockRpcServer(endpoints);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = init?.body ? JSON.parse(init.body) : {};
      try {
        const result = await server.call(url, body.method, body.params ?? []);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err: any) {
        const status = err.status ?? 500;
        return new Response(JSON.stringify({ error: { message: err.message } }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
    });
  }

  it('rotates to the next rpcUrl when an endpoint fails', async () => {
    setupServer([
      { url: 'https://rpc-a.example.com', failures: 1, statusCode: 429 },
      { url: 'https://rpc-b.example.com', failures: 0 },
    ]);

    const client = new BaseClient({
      rpcUrls: ['https://rpc-a.example.com', 'https://rpc-b.example.com'],
      maxRetries: 3,
      retryDelayMs: 100,
    });

    const promise = client.request('eth_blockNumber', []);
    // Advance past any backoff timers.
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeDefined();
    // First endpoint was tried once and failed.
    expect(server.getEndpoint('https://rpc-a.example.com')!.calls).toBe(1);
    // Second endpoint succeeded.
    expect(server.getEndpoint('https://rpc-b.example.com')!.calls).toBe(1);
  });

  it('respects the configured maxRetries', async () => {
    setupServer([
      { url: 'https://rpc-a.example.com', failures: 100, statusCode: 503 },
      { url: 'https://rpc-b.example.com', failures: 100, statusCode: 503 },
    ]);

    const maxRetries = 2;
    const client = new BaseClient({
      rpcUrls: ['https://rpc-a.example.com', 'https://rpc-b.example.com'],
      maxRetries,
      retryDelayMs: 100,
    });

    const promise = client.request('eth_blockNumber', []);
    // Prevent unhandled rejection while timers advance.
    const settled = promise.catch((e) => e);
    await vi.runAllTimersAsync();
    const error = await settled;

    expect(error).toBeInstanceOf(Error);
    // With maxRetries=2 and 2 endpoints, we expect at most (maxRetries + 1) * endpoints attempts.
    // The exact count depends on implementation, but it must not exceed the retry budget.
    const totalAttempts = server.totalCalls();
    expect(totalAttempts).toBeLessThanOrEqual((maxRetries + 1) * 2);
    expect(totalAttempts).toBeGreaterThanOrEqual(1);
  });

  it('applies backoff between retries', async () => {
    setupServer([
      { url: 'https://rpc-a.example.com', failures: 1, statusCode: 429 },
      { url: 'https://rpc-b.example.com', failures: 0 },
    ]);

    const retryDelayMs = 500;
    const client = new BaseClient({
      rpcUrls: ['https://rpc-a.example.com', 'https://rpc-b.example.com'],
      maxRetries: 3,
      retryDelayMs,
    });

    const promise = client.request('eth_blockNumber', []);
    const settled = promise.catch((e) => e);

    // Immediately after the call, only the first endpoint should have been hit.
    await Promise.resolve();
    expect(server.getEndpoint('https://rpc-a.example.com')!.calls).toBe(1);
    expect(server.getEndpoint('https://rpc-b.example.com')!.calls).toBe(0);

    // Advance less than the backoff delay: no new attempt yet.
    await vi.advanceTimersByTimeAsync(retryDelayMs / 2);
    expect(server.getEndpoint('https://rpc-b.example.com')!.calls).toBe(0);

    // Advance past the backoff delay: the retry should now occur.
    await vi.advanceTimersByTimeAsync(retryDelayMs);
    await vi.runAllTimersAsync();
    await settled;

    expect(server.getEndpoint('https://rpc-b.example.com')!.calls).toBe(1);
  });

  it('throws an informative error when all endpoints and retries are exhausted', async () => {
    setupServer([
      { url: 'https://rpc-a.example.com', failures: 100, statusCode: 429 },
      { url: 'https://rpc-b.example.com', failures: 100, statusCode: 503 },
    ]);

    const client = new BaseClient({
      rpcUrls: ['https://rpc-a.example.com', 'https://rpc-b.example.com'],
      maxRetries: 1,
      retryDelayMs: 50,
    });

    const promise = client.request('eth_blockNumber', []);
    const settled = promise.catch((e) => e);
    await vi.runAllTimersAsync();
    const error = await settled;

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // Error should mention the failure and ideally the endpoints involved.
    expect(message.toLowerCase()).toMatch(/fail|exhaust|retr|rpc/);
    expect(message).toContain('https://rpc-a.example.com');
    expect(message).toContain('https://rpc-b.example.com');
  });
});