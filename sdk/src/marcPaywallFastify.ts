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
 * Options for the MARC paywall Fastify hook.
 * (Inherits from core options, adds nothing Fastify-specific.)
 */
export type MarcPaywallFastifyOptions = MarcPaywallCoreOptions;

/**
 * Creates a Fastify hook implementing the x402 v2 payment protocol.
 *
 * Usage:
 *   ```typescript
 *   import { marcPaywallFastify } from "marc-stellar-sdk/browser";
 *   import Fastify from "fastify";
 *
 *   const app = Fastify();
 *   const paywall = marcPaywallFastify({
 *     payTo: "G...",
 *     price: "$0.01",
 *     facilitatorApiKey: process.env.FACILITATOR_KEY,
 *   });
 *
 *   app.addHook("preHandler", paywall);
 *   ```
 *
 * When a request arrives without valid payment:
 * - Returns 402 Payment Required
 * - Sets X-Payment-Requirements header with payment details
 * - Client retries with X-Payment header containing signed transaction
 *
 * NOTE: This adapter uses the same x402-express primitives as marcPaywall.
 * For full Fastify integration, you may want to implement a Fastify-specific
 * plugin that wraps the paymentMiddleware from @x402/express.
 */
export function marcPaywallFastify(
  opts: MarcPaywallFastifyOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  // Import x402 here to avoid requiring @x402/express in Node.js environments
  // that only use marcPaywall without Fastify
  const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
  const { HTTPFacilitatorClient } = require("@x402/core/server");
  const { ExactStellarScheme } = require("@x402/stellar/exact/server");

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
