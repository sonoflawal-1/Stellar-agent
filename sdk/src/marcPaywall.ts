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
 * Creates Express middleware implementing the x402 v2 payment protocol.
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
