/**
 * Node.js native http/https adapter for MARC x402 payment protocol.
 *
 * Provides payment verification for raw Node.js http.Server or https.Server.
 * Works with any framework built on http.Server (native, Koa, hapi, etc).
 */

import type { MarcPaywallCoreOptions } from "./marcPaywallCore.js";
import type { IncomingMessage, ServerResponse } from "http";

/**
 * Options for the MARC paywall Node http adapter.
 * (Inherits from core options, adds nothing Node-specific.)
 */
export type MarcPaywallNodeHttpOptions = MarcPaywallCoreOptions;

/**
 * Class-based handler for Node.js http payment verification.
 *
 * Leverages the @x402/express middleware but applies it directly to
 * Node.js native IncomingMessage and ServerResponse objects.
 *
 * Usage with raw Node.js:
 *   ```typescript
 *   import { MarcPaywallNodeHttpHandler } from "marc-stellar-sdk";
 *   import http from "http";
 *
 *   const handler = new MarcPaywallNodeHttpHandler({
 *     payTo: "G...",
 *     price: "$0.01",
 *   });
 *
 *   http.createServer(async (req, res) => {
 *     const authorized = await handler.check(req, res);
 *     if (!authorized) return; // 402 was sent
 *     // ... your handler logic
 *   }).listen(3000);
 *   ```
 *
 * Usage with Koa:
 *   ```typescript
 *   const handler = new MarcPaywallNodeHttpHandler({ payTo: "G...", price: "$0.01" });
 *   app.use(async (ctx) => {
 *     const authorized = await handler.check(ctx.req, ctx.res);
 *     if (!authorized) return; // 402 was sent
 *     // ... your handler logic
 *   });
 *   ```
 */
export class MarcPaywallNodeHttpHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private middleware: any = null;

  constructor(private opts: MarcPaywallNodeHttpOptions) {}

  /**
   * Check payment authorization for a request.
   *
   * Returns true if payment is authorized (request should continue),
   * false if 402 was sent (request is complete).
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
 * Creates a Node.js http request handler middleware.
 *
 * Returns a function that can be used directly with http.createServer:
 *   ```typescript
 *   import { marcPaywallNodeHttp } from "marc-stellar-sdk";
 *   import http from "http";
 *
 *   const handler = marcPaywallNodeHttp({ payTo: "G...", price: "$0.01" });
 *   http.createServer(async (req, res) => {
 *     if (!await handler(req, res)) return; // 402 was sent
 *     // ... your handler logic
 *   }).listen(3000);
 *   ```
 */
export function marcPaywallNodeHttp(
  opts: MarcPaywallNodeHttpOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const h = new MarcPaywallNodeHttpHandler(opts);
  return (req, res) => h.check(req, res);
}
