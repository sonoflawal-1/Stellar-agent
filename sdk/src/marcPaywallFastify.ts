/**
 * Fastify adapter for MARC x402 payment protocol.
 *
 * Provides a Fastify hook that implements x402 v2 payment verification.
 * Similar structure to Express but uses Fastify's request/reply patterns.
 */

import { createRequire } from "node:module";
import type { MarcPaywallCoreOptions } from "./marcPaywallCore.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyRequest = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyReply = any;

// This package compiles to ESM ("type": "module" in package.json), where the
// CommonJS `require` global does not exist. The dynamic requires below
// (needed to avoid pulling @x402/express into non-Fastify consumers) need a
// working `require` — build one from this module's own URL.
const require = createRequire(import.meta.url);

/**
 * Configuration options for the MARC x402 Fastify paywall hook.
 *
 * Inherits all fields from {@link MarcPaywallCoreOptions} without modification.
 * Provided as a named alias so Fastify-specific code can import a Fastify-named type.
 */
export type MarcPaywallFastifyOptions = MarcPaywallCoreOptions;

/**
 * Create a Fastify `preHandler` hook that enforces x402 v2 payment requirements.
 *
 * When a request arrives without valid payment proof:
 * 1. Returns HTTP 402 Payment Required.
 * 2. Sets `X-Payment-Requirements` header with payment details for the client.
 * 3. The client (e.g. {@link marcFetch}) builds, signs, and retries with an `X-Payment` header.
 * 4. The hook verifies the payment via the configured facilitator and allows the request through.
 *
 * Uses the same x402-express primitives as {@link marcPaywall} internally, adapting
 * the Express middleware to Fastify's raw Node.js `req`/`res` objects.
 *
 *   const app = Fastify();
 *   const paywall = await marcPaywallFastify({
 *     payTo: "G...",
 *     price: "$0.01",
 *     facilitatorApiKey: process.env.KEY,
 *   });
 *
 * @example
 * ```typescript
 * import Fastify from "fastify";
 * import { marcPaywallFastify } from "marc-stellar-sdk";
 *
 * const app = Fastify();
 * const paywall = marcPaywallFastify({
 *   payTo: "GABC...",
 *   price: "$0.01",
 *   facilitatorApiKey: process.env.FACILITATOR_KEY,
 * });
 *
 * app.addHook("preHandler", paywall);
 * app.get("/api/data", async (req, reply) => {
 *   reply.send({ data: "protected content" });
 * });
 * ```
 */
export async function marcPaywallFastify(
  opts: MarcPaywallFastifyOptions,
): Promise<(request: FastifyRequest, reply: FastifyReply) => Promise<void>> {
  // Lazy-load x402 modules to avoid requiring @x402/express in Node.js
  // environments that only use marcPaywall without Fastify.  Using dynamic
  // import() instead of require() for ESM compatibility.
  const { paymentMiddleware, x402ResourceServer } = await import("@x402/express");
  const { HTTPFacilitatorClient } = await import("@x402/core/server");
  const { ExactStellarScheme } = await import("@x402/stellar/exact/server");

  const {
    payTo,
    price,
    network = "stellar:testnet",
    token,
    description = "MARC-protected API call",
    mimeType = "application/json",
    facilitatorUrl = "https://channels.openzeppelin.com/x402/testnet",
    facilitatorApiKey,
  } = opts;

  const facilitatorClient = new HTTPFacilitatorClient({
    url: facilitatorUrl,
    ...(facilitatorApiKey && {
      createAuthHeaders: async () => {
        const headers = { Authorization: `Bearer ${facilitatorApiKey}` };
        return { verify: headers, settle: headers, supported: headers };
      },
    }),
  });

  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    network,
    new ExactStellarScheme(),
  );

  const routeConfig = {
    "*": {
      accepts: [
        {
          scheme: "exact" as const,
          price,
          network,
          payTo,
          ...(token && { token }),
        },
      ],
      description,
      mimeType,
    },
  };

  // Wrap Express middleware for Fastify
  const expressMiddleware = paymentMiddleware(routeConfig, resourceServer);

  return async (request: FastifyRequest, reply: FastifyReply) => {
    // Convert Fastify request/reply to Node.js req/res
    const nodeReq = request.raw;
    const nodeRes = reply.raw;

    await new Promise<void>((resolve, reject) => {
      // The wrapped Express middleware only calls its `next` callback when
      // access is granted (no payment required, or payment verified) — for
      // the 402/error paths it writes straight to the response and returns
      // without ever calling `next`. Without also settling on `res.end()`,
      // this promise (and the Fastify preHandler hook awaiting it) would
      // hang forever whenever a request is rejected for missing/invalid
      // payment, which is the paywall's primary job.
      let settled = false;
      const settle = (err?: unknown) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      const originalEnd = nodeRes.end.bind(nodeRes);
      nodeRes.end = (...args: unknown[]) => {
        const result = originalEnd(...args);
        settle();
        return result;
      };

      expressMiddleware(nodeReq, nodeRes, (err?: unknown) => settle(err));
    });
  };
}
