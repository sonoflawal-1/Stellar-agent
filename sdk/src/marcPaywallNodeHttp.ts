/**
 * Node.js native `http`/`https` adapter for MARC x402 payment protocol.
 *
 * Provides payment verification for raw Node.js `http.Server` or `https.Server`.
 * Compatible with any framework built on top of Node.js `http.Server`
 * (Koa, hapi, Restify, etc.) by working directly with `IncomingMessage` and
 * `ServerResponse` objects.
 *
 * @module marcPaywallNodeHttp
 */

import type { MarcPaywallCoreOptions } from "./marcPaywallCore.js";
import type { IncomingMessage, ServerResponse } from "http";

/**
 * Configuration options for the MARC x402 Node.js http paywall handler.
 *
 * Inherits all fields from {@link MarcPaywallCoreOptions} without modification.
 * Provided as a named alias so Node-http-specific code can import a clearly named type.
 */
export type MarcPaywallNodeHttpOptions = MarcPaywallCoreOptions;

/**
 * Class-based payment verification handler for Node.js native `http`/`https`.
 *
 * Wraps `@x402/express` `paymentMiddleware` and applies it directly to
 * `IncomingMessage` and `ServerResponse` objects. Middleware is initialized
 * lazily on the first call to {@link check} to avoid loading Express in
 * environments that don't use it.
 *
 * Prefer the functional {@link marcPaywallNodeHttp} helper for simple use cases.
 * Use this class directly when you need to reuse the initialized middleware
 * across multiple request handlers or when subclassing is needed.
 *
 * @example
 * ```typescript
 * import { MarcPaywallNodeHttpHandler } from "marc-stellar-sdk";
 * import http from "http";
 *
 * const handler = new MarcPaywallNodeHttpHandler({
 *   payTo: "GABC...",
 *   price: "$0.01",
 * });
 *
 * http.createServer(async (req, res) => {
 *   const authorized = await handler.check(req, res);
 *   if (!authorized) return; // 402 already sent by check()
 *   res.writeHead(200, { "Content-Type": "application/json" });
 *   res.end(JSON.stringify({ data: "protected" }));
 * }).listen(3000);
 * ```
 *
 * @example With Koa:
 * ```typescript
 * const handler = new MarcPaywallNodeHttpHandler({ payTo: "GABC...", price: "$0.01" });
 * app.use(async (ctx) => {
 *   const authorized = await handler.check(ctx.req, ctx.res);
 *   if (!authorized) return; // 402 already sent
 *   ctx.body = { data: "protected" };
 * });
 * ```
 */
export class MarcPaywallNodeHttpHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private middleware: any = null;

  /**
   * @param opts - Payment configuration including payee address, price, and network.
   */
  constructor(private opts: MarcPaywallNodeHttpOptions) {}

  /**
   * Verify payment authorization for an incoming HTTP request.
   *
   * On first call, lazily initializes the underlying x402 payment middleware.
   * Subsequent calls reuse the cached middleware instance for efficiency.
   *
   * When a request does **not** carry valid payment proof:
   * - Writes an HTTP 402 response with `X-Payment-Requirements` headers.
   * - Returns `false` — the caller must **not** send another response.
   *
   * When a request carries valid payment proof:
   * - Does not write any response.
   * - Returns `true` — the caller should proceed with normal handling.
   *
   * @param req - The Node.js `IncomingMessage` (raw request from `http.createServer`).
   * @param res - The Node.js `ServerResponse` (raw response object).
   * @returns `true` if payment is authorized and the request should continue,
   *          `false` if a 402 response was already sent and the caller should stop.
   * @throws {Error} On middleware initialization failure or unexpected errors.
   *
   * @example
   * ```typescript
   * const authorized = await handler.check(req, res);
   * if (!authorized) return; // response already sent
   * // ... handle the authorized request
   * ```
   */
  async check(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    // Lazily initialize middleware on first use (to avoid loading Express if not needed)
    if (!this.middleware) {
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
      } = this.opts;

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

      this.middleware = paymentMiddleware(routeConfig, resourceServer);
    }

    return new Promise<boolean>((resolve) => {
      // Track if the middleware sent a response
      let responded = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resAny = res as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const originalEnd = resAny.end?.bind(resAny);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const originalWrite = resAny.write?.bind(resAny);

      resAny.write = (chunk: unknown, ...args: unknown[]) => {
        responded = true;
        return originalWrite?.(chunk, ...args);
      };

      resAny.end = (...args: unknown[]) => {
        responded = true;
        return originalEnd?.(...args);
      };

      // Call the middleware
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const next = (err?: Error | null) => {
        // If middleware sent a response (402), return false
        if (responded) {
          resolve(false);
        } else {
          // No response sent, authorization passed
          resolve(true);
        }
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.middleware as any)(req, res, next);
    });
  }
}

/**
 * Create a Node.js `http` request handler that enforces x402 v2 payment requirements.
 *
 * A thin functional wrapper around {@link MarcPaywallNodeHttpHandler}. Creates a
 * new handler instance and returns a pre-bound `check` function for ergonomic use
 * directly inside `http.createServer` callbacks.
 *
 * When a request arrives without valid payment proof, the returned function:
 * 1. Writes an HTTP 402 response with `X-Payment-Requirements` headers.
 * 2. Returns `false` so callers know the response is already sent.
 *
 * When payment is verified, it returns `true` without writing any response.
 *
 * @param opts - Payment configuration including payee address, price, and network.
 * @returns An async function `(req, res) => Promise<boolean>` suitable for use
 *          inside any Node.js `http.createServer` callback or framework adapter.
 *
 * @example
 * ```typescript
 * import { marcPaywallNodeHttp } from "marc-stellar-sdk";
 * import http from "http";
 *
 * const paywall = marcPaywallNodeHttp({ payTo: "GABC...", price: "$0.01" });
 *
 * http.createServer(async (req, res) => {
 *   if (!await paywall(req, res)) return; // 402 already sent
 *   res.writeHead(200, { "Content-Type": "application/json" });
 *   res.end(JSON.stringify({ data: "protected content" }));
 * }).listen(3000);
 * ```
 */
export function marcPaywallNodeHttp(
  opts: MarcPaywallNodeHttpOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const h = new MarcPaywallNodeHttpHandler(opts);
  return (req, res) => h.check(req, res);
}
