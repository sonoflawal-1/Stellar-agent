import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { marcPaywallHono } from '@marc/sdk/hono';
import { submitDeliverable } from '@marc/sdk/agents';

/**
 * Hono seller agent template.
 *
 * This template demonstrates how to build a high-throughput seller agent
 * using the Hono web framework. It is compatible with both Node.js
 * (via @hono/node-server) and Cloudflare Workers.
 *
 * The `marcPaywallHono` middleware issues HTTP 402 challenges for unpaid
 * requests and validates Stellar payments before granting access to the
 * protected endpoint.
 */

export interface Env {
  /** Stellar public key (G...) that receives payments. */
  SELLER_STELLAR_ADDRESS: string;
  /** Optional network override: 'testnet' | 'mainnet'. Defaults to 'testnet'. */
  STELLAR_NETWORK?: string;
  /** Optional price in XLM for the paid endpoint. Defaults to '0.01'. */
  PRICE_XLM?: string;
}

const DEFAULT_PRICE_XLM = '0.01';

/**
 * Creates the Hono application. Exported so it can be reused by the
 * Node.js entrypoint, Cloudflare Workers entrypoint, and the test suite.
 */
export function createApp(env: Env) {
  const app = new Hono();

  app.use('*', logger());
  app.use('*', cors());

  // Health check endpoint (free).
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      framework: 'hono',
      timestamp: new Date().toISOString(),
    }),
  );

  // Free sample endpoint.
  app.get('/', (c) =>
    c.json({
      name: 'hono-seller-agent',
      description: 'A high-throughput seller agent built with Hono and x402 paywalls.',
      endpoints: {
        'GET /health': 'Free health check',
        'GET /': 'Free metadata',
        'GET /api/paid': 'Paid endpoint (x402)',
        'POST /api/deliverables/:jobId': 'Submit a deliverable (hashed via submitDeliverable)',
      },
    }),
  );

  // Paid endpoint protected by the x402 paywall middleware.
  app.get(
    '/api/paid',
    marcPaywallHono({
      stellarAddress: env.SELLER_STELLAR_ADDRESS,
      network: env.STELLAR_NETWORK ?? 'testnet',
      price: env.PRICE_XLM ?? DEFAULT_PRICE_XLM,
      asset: 'XLM',
      description: 'Access to the premium seller agent endpoint',
    }),
    (c) =>
      c.json({
        success: true,
        message: 'Payment verified. Here is your premium content.',
        data: {
          generatedAt: new Date().toISOString(),
          payload: 'Hello from the Hono seller agent!',
        },
      }),
  );

  // Deliverable submission endpoint.
  //
  // Sellers should always submit deliverables through the shared
  // `submitDeliverable(job, bytes)` helper so that the deliverable hash is
  // computed reproducibly (identical on the client and the seller) and the
  // content is stored before the contract call is made.
  app.post('/api/deliverables/:jobId', async (c) => {
    const jobId = c.req.param('jobId');
    const bytes = new Uint8Array(await c.req.arrayBuffer());

    try {
      const result = await submitDeliverable(
        { id: jobId, stellarAddress: env.SELLER_STELLAR_ADDRESS },
        bytes,
      );

      return c.json({
        success: true,
        jobId,
        hash: result.hash,
        uri: result.uri,
        txHash: result.txHash,
      });
    } catch (err) {
      console.error('[hono-seller] Deliverable submission failed:', err);
      return c.json({ error: 'Deliverable submission failed' }, 500);
    }
  });

  // 404 fallback.
  app.notFound((c) =>
    c.json({ error: 'Not Found', path: c.req.path }, 404),
  );

  // Error handler.
  app.onError((err, c) => {
    console.error('[hono-seller] Unhandled error:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  return app;
}

/**
 * Reads environment configuration from the runtime.
 * Works under Node.js (process.env) and Cloudflare Workers (env bindings).
 */
export function readEnv(source?: Record<string, string | undefined>): Env {
  const get = (key: string): string | undefined => {
    if (source && source[key] !== undefined) return source[key];
    if (typeof process !== 'undefined' && process.env) return process.env[key];
    return undefined;
  };

  const stellarAddress = get('SELLER_STELLAR_ADDRESS');
  if (!stellarAddress) {
    throw new Error(
      'SELLER_STELLAR_ADDRESS is required. Set it to your Stellar public key (G...).',
    );
  }

  return {
    SELLER_STELLAR_ADDRESS: stellarAddress,
    STELLAR_NETWORK: get('STELLAR_NETWORK') ?? 'testnet',
    PRICE_XLM: get('PRICE_XLM') ?? DEFAULT_PRICE_XLM,
  };
}

// ---------------------------------------------------------------------------
// Cloudflare Workers entrypoint
// ---------------------------------------------------------------------------
// When deployed to Cloudflare Workers, the default export is used as the
// fetch handler. The env bindings are passed in per-request.
export default {
  fetch(request: Request, env: Env, ctx: unknown): Response | Promise<Response> {
    const app = createApp(env);
    return app.fetch(request, env, ctx as ExecutionContext);
  },
};

// ---------------------------------------------------------------------------
// Node.js entrypoint
// ---------------------------------------------------------------------------
// When run under Node.js (npm run dev / npm start), start an HTTP server.
// We detect Node by checking for the presence of `process.versions.node`.
if (
  typeof process !== 'undefined' &&
  process.versions &&
  process.versions.node &&
  // Avoid starting the server when imported by the test suite.
  process.env.NODE_ENV !== 'test' &&
  process.env.HONO_SKIP_SERVER !== '1'
) {
  // Dynamic import so Cloudflare Workers bundlers don't try to resolve it.
  void (async () => {
    try {
      const { serve } = await import('@hono/node-server');
      const env = readEnv();
      const app = createApp(env);
      const port = Number(process.env.PORT ?? 3000);

      serve({ fetch: app.fetch, port }, (info) => {
        console.log(
          `[hono-seller] Listening on http://localhost:${info.port} (network: ${env.STELLAR_NETWORK})`,
        );
      });
    } catch (err) {
      console.error('[hono-seller] Failed to start server:', err);
      process.exit(1);
    }
  })();
}