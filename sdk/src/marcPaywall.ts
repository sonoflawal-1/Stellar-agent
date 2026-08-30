import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import type { RequestHandler } from "express";
import type { MarcPaywallCoreOptions } from "./marcPaywallCore.js";

/**
 * Configuration options for the MARC x402 Express paywall middleware.
 *
 * Inherits all fields from {@link MarcPaywallCoreOptions} without modification.
 * Provided as a named alias so Express-specific code can import a clearly named type.
 */
export type MarcPaywallOptions = MarcPaywallCoreOptions;

/**
 * Create an Express middleware that protects routes with x402 v2 payment requirements.
 *
 * Intercepts incoming requests and enforces payment via the x402 protocol.
 * When a request lacks valid payment proof:
 * 1. Returns HTTP 402 with payment requirements in response headers.
 * 2. The client (e.g. {@link marcFetch}) builds and signs a Stellar payment transaction.
 * 3. The client retries the request with payment proof headers attached.
 * 4. Middleware verifies the payment via the configured facilitator and allows the request through.
 *
 * Also handles CORS preflight (`OPTIONS`) requests automatically so browser-based
 * agents can make cross-origin requests without CORS errors blocking the 402 flow.
 *
 * For other frameworks, see {@link marcPaywallFastify} or {@link marcPaywallNodeHttp}.
 *
 * @param opts - Configuration including payee address, price, network, and token.
 * @returns An Express `RequestHandler` middleware function.
 *
 * @example
 * ```typescript
 * import express from "express";
 * import { marcPaywall } from "marc-stellar-sdk";
 *
 * const app = express();
 * app.use("/api/summarize", marcPaywall({
 *   payTo: "GABC...",
 *   price: "$0.01",
 *   facilitatorApiKey: process.env.FACILITATOR_KEY,
 * }));
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

  // Handle CORS preflight OPTIONS requests before any payment check.
  // Browsers send OPTIONS when the request uses a non-simple Content-Type
  // (e.g. application/json) or custom headers. Without this, the browser
  // never gets to send the actual request and the user sees a CORS error
  // rather than a 402. We respond 204 No Content with permissive CORS
  // headers so the browser can proceed with the real request.
  const corsPreflightHandler: RequestHandler = (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Payment, X-Payment-Response, Payment-Signature, Payment-Response",
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, PAYMENT-REQUIRED, X-PAYMENT-REQUIREMENTS",
    );
    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };

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

  const paywall = paymentMiddleware(routeConfig, resourceServer) as RequestHandler;

  // Compose: run CORS preflight first, then the x402 payment check.
  // OPTIONS requests are short-circuited in corsPreflightHandler (never reach paywall).
  // All other requests pass through to paywall after CORS headers are set.
  return (req, res, next) => {
    corsPreflightHandler(req, res, (err?: unknown) => {
      if (err) return next(err);

      const originalSetHeader = res.setHeader;
      res.setHeader = function (name: string, value: string | number | readonly string[]) {
        const lower = name.toLowerCase();
        if (lower === "payment-response" && !res.getHeader("X-PAYMENT-RESPONSE")) {
          originalSetHeader.call(this, "X-PAYMENT-RESPONSE", value);
        } else if (lower === "x-payment-response" && !res.getHeader("PAYMENT-RESPONSE")) {
          originalSetHeader.call(this, "PAYMENT-RESPONSE", value);
        }
        return originalSetHeader.call(this, name, value);
      };

      try {
        paywall(req, res, (paywallErr?: unknown) => {
          if (paywallErr) {
            // Malformed payment headers or verification errors should return generic 402
            // to avoid leaking internal details like facilitator URLs
            if (!res.headersSent) {
              res.status(402).setHeader("Content-Type", "application/json");
              res.setHeader(
                "Access-Control-Expose-Headers",
                "PAYMENT-REQUIRED, X-PAYMENT-REQUIREMENTS",
              );
              res.setHeader("PAYMENT-REQUIRED", JSON.stringify(routeConfig["*"]));
              return res.end(JSON.stringify({ error: "Payment required" }));
            }
            return next(paywallErr);
          }

          const paymentResp =
            res.getHeader("PAYMENT-RESPONSE") ?? res.getHeader("payment-response");
          if (paymentResp && !res.getHeader("X-PAYMENT-RESPONSE")) {
            res.setHeader("X-PAYMENT-RESPONSE", paymentResp as string);
          }
          next();
        });
      } catch (err) {
        // Catch synchronous errors from paymentMiddleware (e.g., header parsing errors)
        if (!res.headersSent) {
          res.status(402).setHeader("Content-Type", "application/json");
          res.setHeader(
            "Access-Control-Expose-Headers",
            "PAYMENT-REQUIRED, X-PAYMENT-REQUIREMENTS",
          );
          res.setHeader("PAYMENT-REQUIRED", JSON.stringify(routeConfig["*"]));
          return res.end(JSON.stringify({ error: "Payment required" }));
        }
        next(err);
      }
    });
  };
}
