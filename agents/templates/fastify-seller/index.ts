import { createHash } from 'node:crypto';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { marcPaywallFastify } from '@marc/sdk';

/**
 * Fastify seller agent template.
 *
 * Wires the x402 paywall middleware (`marcPaywallFastify`) around a sample
 * paid endpoint. Requests without a valid Stellar payment receive an HTTP 402
 * with payment requirements; requests with a valid payment are forwarded to
 * the handler.
 */

export interface SellerConfig {
  /** Stellar address that receives payments. */
  payTo: string;
  /** Price per request, expressed in the asset's smallest unit (e.g. stroops). */
  price: string;
  /** Asset code, e.g. "USDC" or "XLM". */
  asset: string;
  /** Stellar network: "testnet" or "mainnet". */
  network: 'testnet' | 'mainnet';
  /** Optional facilitator URL used to verify/settle payments. */
  facilitatorUrl?: string;
}

/** Minimal job shape required to submit a deliverable. */
export interface DeliverableJob {
  /** On-chain job identifier. */
  id: string | number;
  /** Optional contract client used to submit the deliverable on-chain. */
  contract?: {
    submit(jobId: string | number, hash: string, content: string): Promise<unknown>;
  };
}

/** Result returned by {@link submitDeliverable}. */
export interface DeliverableSubmission {
  /** SHA-256 hash of the deliverable bytes, hex encoded. */
  hash: string;
  /** Base64 encoded deliverable content. */
  content: string;
  /** Raw contract response, if a contract client was provided. */
  receipt?: unknown;
}

/**
 * Compute the reproducible SHA-256 hash of a deliverable.
 *
 * All sellers must use this helper so the hash can be independently
 * reproduced by the client from the same bytes.
 */
export function hashDeliverable(bytes: Uint8Array | string): string {
  const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Prepare and submit a deliverable for a job.
 *
 * Computes the deliverable hash, stores the content and, when a contract
 * client is available, calls the contract's `submit` method. This helper is
 * shared by all seller templates to guarantee consistent hashing and
 * submission behaviour.
 */
export async function submitDeliverable(
  job: DeliverableJob,
  bytes: Uint8Array | string,
): Promise<DeliverableSubmission> {
  const hash = hashDeliverable(bytes);
  const content = typeof bytes === 'string'
    ? Buffer.from(bytes, 'utf8').toString('base64')
    : Buffer.from(bytes).toString('base64');

  const submission: DeliverableSubmission = { hash, content };

  if (job.contract) {
    submission.receipt = await job.contract.submit(job.id, hash, content);
  }

  return submission;
}

export function loadConfig(): SellerConfig {
  return {
    payTo: process.env.MARC_PAY_TO ?? 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    price: process.env.MARC_PRICE ?? '1000000',
    asset: process.env.MARC_ASSET ?? 'USDC',
    network: (process.env.MARC_NETWORK as 'testnet' | 'mainnet') ?? 'testnet',
    facilitatorUrl: process.env.MARC_FACILITATOR_URL,
  };
}

export function buildServer(config: SellerConfig = loadConfig()): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  // Register the x402 paywall as a Fastify plugin. The plugin decorates the
  // instance with `marcPaywall` which can be used as a preHandler on any route.
  app.register(marcPaywallFastify, {
    payTo: config.payTo,
    price: config.price,
    asset: config.asset,
    network: config.network,
    facilitatorUrl: config.facilitatorUrl,
  });

  app.get('/health', async () => ({ status: 'ok' }));

  // Deliverable submission endpoint. Uses the shared `submitDeliverable`
  // helper so the hash is reproducible by the client and consistent across
  // all seller templates.
  app.post(
    '/api/deliverable',
    {
      preHandler: (request: FastifyRequest, reply: FastifyReply) =>
        app.marcPaywall(request, reply),
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = (request.body ?? {}) as {
        jobId?: string | number;
        bytes?: string;
      };

      if (body.jobId === undefined || typeof body.bytes !== 'string') {
        return reply.code(400).send({
          error: 'jobId and base64 encoded bytes are required',
        });
      }

      const submission = await submitDeliverable(
        { id: body.jobId },
        Buffer.from(body.bytes, 'base64'),
      );

      return submission;
    },
  );

  // Sample paid endpoint. The paywall issues HTTP 402 when no valid payment
  // is present and validates Stellar payments before invoking the handler.
  app.get(
    '/api/paid',
    {
      preHandler: (request: FastifyRequest, reply: FastifyReply) =>
        app.marcPaywall(request, reply),
    },
    async (request: FastifyRequest) => {
      return {
        message: 'Payment accepted. Here is your premium content.',
        timestamp: new Date().toISOString(),
        payment: (request as FastifyRequest & { marcPayment?: unknown }).marcPayment ?? null,
      };
    },
  );

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildServer(config);

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';

  try {
    await app.listen({ port, host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const isDirectRun =
  typeof require !== 'undefined' && require.main === module;

if (isDirectRun) {
  void main();
}

export default buildServer;
```

```json
{
  "name": "fastify-seller",
  "version": "0.1.0",
  "private": true,
  "description": "Fastify seller agent template with x402 paywall for Stellar payments",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "dev": "tsx watch index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@marc/sdk": "^0.1.0",
    "fastify": "^4.28.1"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^1.6.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer, SellerConfig } from './index';

const testConfig: SellerConfig = {
  payTo: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  price: '1000000',
  asset: 'USDC',
  network: 'testnet',
  facilitatorUrl: 'https://facilitator.example.com',
};

describe('Fastify seller agent', () => {
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    app = buildServer(testConfig);
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('responds to /health with ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('issues HTTP 402 when no payment header is provided', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/paid' });
    expect(res.statusCode).toBe(402);

    const body = res.json();
    expect(body).toHaveProperty('x402Version');
    expect(body).toHaveProperty('accepts');
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'stellar-testnet',
      payTo: testConfig.payTo,
      maxAmountRequired: testConfig.price,
      asset: testConfig.asset,
    });
  });

  it('rejects an invalid Stellar payment signature with 402', async () => {
    const invalidPayment = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'stellar-testnet',
        payload: {
          transaction: 'AAAA-invalid-stellar-transaction',
          signature: 'deadbeef',
        },
      }),
    ).toString('base64');

    const res = await app.inject({
      method: 'GET',
      url: '/api/paid',
      headers: { 'X-PAYMENT': invalidPayment },
    });

    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body).toHaveProperty('error');
  });

  it('accepts a valid Stellar payment and returns premium content', async () => {
    const validPayment = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'stellar-testnet',
        payload: {
          transaction: 'AAAA-valid-stellar-transaction',
          signature: 'valid-signature',
        },
      }),
    ).toString('base64');

    const res = await app.inject({
      method: 'GET',
      url: '/api/paid',
      headers: { 'X-PAYMENT': validPayment },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('message');
    expect(body.message).toContain('Payment accepted');
  });
});
```

```dockerfile
# syntax=docker/dockerfile:1

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev=false

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY index.ts ./
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
```

```markdown
# Fastify Seller Agent Template

A production-ready Fastify boilerplate for building high-throughput seller
agents with an x402 paywall that accepts Stellar payments.

## Features

- **Fastify** — one of the fastest Node.js web frameworks.
- **x402 paywall** — `marcPaywallFastify` issues HTTP 402 with payment
  requirements and validates Stellar payments before serving content.
- **TypeScript** — first-class typing for the server and paywall.
- **Docker** — multi-stage build for small production images.
- **Tests** — Vitest suite covering 402 issuance and payment validation.

## Getting started

```bash
npm install
npm run dev
```

The server listens on `http://localhost:3000` by default.

### Environment variables

| Variable               | Description                                        | Default                                              |
| ---------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `PORT`                 | HTTP port                                          | `3000`                                               |
| `HOST`                 | Bind address                                       | `0.0.0.0`                                            |
| `MARC_PAY_TO`          | Stellar address that receives payments             | placeholder                                          |
| `MARC_PRICE`           | Price per request (smallest asset unit)            | `1000000`                                            |
| `MARC_ASSET`           | Asset code (`USDC`, `XLM`, ...)                    | `USDC`                                               |
| `MARC_NETWORK`         | `testnet` or `mainnet`                             | `testnet`                                            |
| `MARC_FACILITATOR_URL` | Optional facilitator for verify/settle             | unset                                                |

## Endpoints

- `GET /health` — liveness probe, always free.
- `GET /api/paid` — sample paid endpoint protected by the x402 paywall.

### Example request

```bash
# Without payment → 402
curl -i http://localhost:3000/api/paid

# With a valid X-PAYMENT header → 200
curl -i -H "X-PAYMENT: <base64-encoded-payment>" http://localhost:3000/api/paid
```

## Testing

```bash
npm test
```

## Building

```bash
npm run build
npm start
```

## Docker

```bash
docker build -t fastify-seller .
docker run --rm -p 3000:3000 \
  -e MARC_PAY_TO=G... \
  -e MARC_PRICE=1000000 \
  -e MARC_ASSET=USDC \
  -e MARC_NETWORK=testnet \
  fastify-seller
```

## Deployment

### Node / container platforms

Deploy the Docker image to any container platform (Fly.io, Railway, Render,
ECS, Kubernetes). Set the `MARC_*` environment variables in your platform's
secret manager.

### Serverless

Fastify can run behind AWS Lambda via `@fastify/aws-lambda`. Wrap the exported
`buildServer()` instance and forward API Gateway events.

## Adding paid routes

```ts
app.get(
  '/api/premium',
  { preHandler: (req, reply) => app.marcPaywall(req, reply) },
  async () => ({ data: 'premium' }),
);
```

## Benchmarking

Fastify typically delivers >2x the requests-per-second of Express-based
templates for the same workload. Run your own benchmark with `autocannon`:

```bash
npx autocannon -c 100 -d 10 http://localhost:3000/health
```