import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import type { RequestHandler } from "express";

/**
 * Configuration options for the marcPaywall Express middleware.
 *
 * Defines payment requirements, price, token, and facilitator details
 * for protecting API routes with the x402 v2 payment protocol.
 */
export interface MarcPaywallOptions {
  /** Stellar address to receive payment (G...). */
  payTo: string;
  /** Human-readable price string (e.g. "$0.01"). */
  price: string;
  /** Network identifier. */
  network?: "stellar:testnet" | "stellar:pubnet";
  /**
   * Token contract address or well-known alias.
   * Use `"native"` for XLM, a Soroban contract address for custom SAC/tokens,
   * or omit to default to USDC on testnet.
   */
  token?: string;
  /** Human-readable description of what's being purchased. */
  description?: string;
  /** MIME type of the response. */
  mimeType?: string;
  /** Facilitator service URL. */
  facilitatorUrl?: string;
  /** API key for the facilitator (Bearer auth). */
  facilitatorApiKey?: string;
}

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
 * @example
 * ```typescript
 * const paywall = marcPaywall({
 *   payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5K",
 *   price: "$0.01",
 *   network: "stellar:testnet",
 *   facilitatorUrl: "https://channels.openzeppelin.com/x402/testnet",
 * });
 * app.get("/api/protected", paywall, (req, res) => {
 *   res.json({ data: "This costs money" });
 * });
 * ```
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
