import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import type { RequestHandler } from "express";
import type { MarcPaywallCoreOptions } from "./marcPaywallCore.js";

/**
 * Options for the MARC paywall Express middleware.
 * (Inherits from core options, adds nothing Express-specific.)
 */
export type MarcPaywallOptions = MarcPaywallCoreOptions;

/**
 * Create an Express middleware that protects routes with x402 payment requirements.
 *
 * Returns a middleware that intercepts incoming requests and enforces payment
 * via the x402 v2 protocol. When a request lacks valid payment proof:
 * 1. Returns HTTP 402 with payment requirements in headers
 * 2. Client builds and signs a Stellar payment transaction
 * 3. Client retries with payment proof headers
 * 4. Middleware verifies payment via facilitator and allows access
 *
 * Verified payments are settled with the configured facilitator service.
 *
 * @param opts - Configuration including payee address, price, network, and token
 * @returns An Express middleware function for route protection
 *
 * Returns a middleware that protects the given route pattern.
 * When a request arrives without payment, it returns 402 with payment requirements.
 * When payment is provided, it verifies and settles via the facilitator.
 *
 * For other frameworks, see marcPaywallFastify() or marcPaywallNodeHttp().
 */
export function marcPaywall(opts: MarcPaywallOptions): RequestHandler {
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

  // paymentMiddleware expects a route-config map like { "GET /path": { ... } }
  // We use a wildcard pattern that matches any method + path.
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

  return paymentMiddleware(routeConfig, resourceServer) as RequestHandler;
}
