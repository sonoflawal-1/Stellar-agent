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
