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
 * @param opts - Payment configuration including the payee address, price, and network.
 * @returns An async Fastify `preHandler` function with signature
 *          `(request: FastifyRequest, reply: FastifyReply) => Promise<void>`.
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
