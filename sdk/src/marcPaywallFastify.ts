/**
 * Fastify adapter for MARC x402 payment protocol.
 *
 * Provides a Fastify hook that implements x402 v2 payment verification.
 * Similar structure to Express but uses Fastify's request/reply patterns.
 */

import type { MarcPaywallCoreOptions } from "./marcPaywallCore.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyRequest = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyReply = any;

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
      expressMiddleware(nodeReq, nodeRes, (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };
}
