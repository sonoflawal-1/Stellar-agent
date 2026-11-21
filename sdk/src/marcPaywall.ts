import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import type { RequestHandler } from "express";
import type { MarcPaywallCoreOptions } from "./marcPaywallCore.js";

/**
 * Status of a tracked payment transaction in the idempotency cache.
 *
 * - `PROCESSING`: the transaction hash has been claimed by an in-flight request
 *   and is currently being verified/settled with the facilitator.
 * - `SETTLED`: the payment has been verified and the API response payload has
 *   been cached for idempotent re-delivery on retries.
 */
export type PaymentTxStatus = "PROCESSING" | "SETTLED";

/**
 * A single entry in the payment idempotency cache.
 */
export interface PaymentTxEntry {
  /** Current lifecycle status of the transaction. */
  status: PaymentTxStatus;
  /** Epoch milliseconds at which the entry was created. */
  createdAt: number;
  /** Epoch milliseconds at which a SETTLED entry should be evicted. */
  expiresAt: number;
  /** Cached API response payload, populated once the transaction is SETTLED. */
  response?: CachedPaymentResponse;
}

/**
 * Cached API response payload used for idempotent re-delivery.
 */
export interface CachedPaymentResponse {
  /** HTTP status code of the original response. */
  statusCode: number;
  /** Response headers of the original response. */
  headers: Record<string, string>;
  /** Response body of the original response. */
  body: string;
}

/**
 * OpenZeppelin-hosted x402 facilitator URLs, keyed by Stellar network.
 * `marcPaywall` picks one from its `network` option unless an explicit
 * `facilitatorUrl` is supplied (e.g. for self-hosted facilitators).
 */
export const FACILITATOR_URLS = {
  testnet: "https://channels.openzeppelin.com/x402/testnet",
  mainnet: "https://channels.openzeppelin.com/x402/mainnet",
} as const satisfies Record<"testnet" | "mainnet", string>;

/**
 * Default time-to-live for SETTLED entries in the idempotency cache (1 hour).
 */
export const DEFAULT_PAYMENT_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * In-memory, process-local cache used to deduplicate x402 payments by
 * transaction hash. Provides atomic compare-and-swap semantics so that
 * concurrent requests presenting the same signed payment cannot both
 * proceed to settlement.
 */
export class PaymentIdempotencyCache {
  private readonly entries = new Map<string, PaymentTxEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_PAYMENT_CACHE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Atomically claim a transaction hash for processing.
   *
   * Returns `{ claimed: true }` if the caller now owns the PROCESSING slot,
   * or `{ claimed: false, entry }` with the existing entry if the hash is
   * already tracked (either in-flight or settled).
   */
  public tryClaim(
    txHash: string,
    now: number = Date.now(),
  ): { claimed: true } | { claimed: false; entry: PaymentTxEntry } {
    this.evictExpired(now);
    const existing = this.entries.get(txHash);
    if (existing) {
      return { claimed: false, entry: existing };
    }
    this.entries.set(txHash, {
      status: "PROCESSING",
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });
    return { claimed: true };
  }

  /**
   * Mark a previously claimed transaction as SETTLED and cache the response
   * payload for idempotent re-delivery. Refreshes the expiry window.
   */
  public markSettled(
    txHash: string,
    response: CachedPaymentResponse,
    now: number = Date.now(),
  ): void {
    const existing = this.entries.get(txHash);
    if (!existing) return;
    existing.status = "SETTLED";
    existing.response = response;
    existing.expiresAt = now + this.ttlMs;
  }

  /**
   * Release a PROCESSING claim (e.g. when verification fails) so the client
   * can retry with the same transaction hash.
   */
  public release(txHash: string): void {
    const existing = this.entries.get(txHash);
    if (existing && existing.status === "PROCESSING") {
      this.entries.delete(txHash);
    }
  }

  /**
   * Retrieve an entry, if present and not expired.
   */
  public get(txHash: string, now: number = Date.now()): PaymentTxEntry | undefined {
    this.evictExpired(now);
    return this.entries.get(txHash);
  }

  /**
   * Remove all expired entries. Called opportunistically on every access.
   */
  public evictExpired(now: number = Date.now()): void {
    for (const [hash, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(hash);
      }
    }
  }

  /** Current number of tracked entries (primarily for tests). */
  public size(): number {
    return this.entries.size;
  }

  /** Remove all entries (primarily for tests). */
  public clear(): void {
    this.entries.clear();
  }
}

/**
 * Extract the transaction hash from a signed Stellar transaction XDR.
 *
 * The X-Payment header carries a base64-encoded JSON payload containing the
 * signed transaction envelope. We decode it, locate the base64 XDR, and
 * compute the SHA-256 hash of the transaction body (the standard Stellar
 * transaction hash). If the payload cannot be parsed we fall back to hashing
 * the raw header value so that deduplication still applies.
 *
 * @param paymentHeader - Raw value of the X-Payment header.
 * @returns A stable hex-encoded transaction hash.
 */
export function extractTransactionHash(paymentHeader: string): string {
  // Lazily import crypto to avoid pulling it into non-Node bundles unnecessarily.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("node:crypto") as typeof import("node:crypto");

  const hashOf = (input: Buffer | string): string =>
    createHash("sha256").update(input).digest("hex");

  let decoded: string;
  try {
    decoded = Buffer.from(paymentHeader, "base64").toString("utf8");
  } catch {
    return hashOf(paymentHeader);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return hashOf(paymentHeader);
  }

  // The x402 Stellar payload nests the signed XDR under `payload.transaction`
  // (or `payload.xdr` / `transaction` depending on scheme version).
  const candidates: unknown[] = [];
  const collect = (obj: unknown): void => {
    if (!obj || typeof obj !== "object") return;
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (
        typeof value === "string" &&
        (key === "transaction" || key === "xdr" || key === "signedTxXdr" || key === "txXdr")
      ) {
        candidates.push(value);
      } else if (value && typeof value === "object") {
        collect(value);
      }
    }
  };
  collect(parsed);

  const xdr = candidates.find((c): c is string => typeof c === "string" && c.length > 0);
  if (!xdr) {
    return hashOf(paymentHeader);
  }

  // Hash the decoded XDR bytes. This is deterministic for a given signed
  // transaction and stable across replicas, which is what we need for
  // deduplication (we do not need the canonical Stellar tx hash here).
  try {
    return hashOf(Buffer.from(xdr, "base64"));
  } catch {
    return hashOf(xdr);
  }
}

/**
 * Read the X-Payment header from an Express request in a case-insensitive way.
 */
function readPaymentHeader(headers: Record<string, unknown>): string | undefined {
  const raw = headers["x-payment"] ?? headers["X-Payment"];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return undefined;
}

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
    facilitatorUrl = FACILITATOR_URLS[network === "stellar:pubnet" ? "mainnet" : "testnet"],
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

  // Process-local idempotency cache shared across all requests handled by this
  // middleware instance. Prevents replay / double-spend of the same signed
  // payment across concurrent requests and provides idempotent re-delivery.
  const paymentCache = new PaymentIdempotencyCache();

  // Compose: run CORS preflight first, then the x402 payment check.
  // OPTIONS requests are short-circuited in corsPreflightHandler (never reach paywall).
  // All other requests pass through to paywall after CORS headers are set.
  return (req, res, next) => {
    corsPreflightHandler(req, res, (err?: unknown) => {
      if (err) return next(err);

      // --- Idempotency / replay guard -------------------------------------
      const paymentHeader = readPaymentHeader(req.headers as Record<string, unknown>);
      let claimedTxHash: string | undefined;

      if (paymentHeader) {
        const txHash = extractTransactionHash(paymentHeader);
        const claim = paymentCache.tryClaim(txHash);

        if (!claim.claimed) {
          if (claim.entry.status === "SETTLED" && claim.entry.response) {
            // Idempotent re-delivery: replay the cached response without
            // re-charging the client.
            const cached = claim.entry.response;
            for (const [name, value] of Object.entries(cached.headers)) {
              res.setHeader(name, value);
            }
            res.status(cached.statusCode);
            res.end(cached.body);
            return;
          }
          // Duplicate in-flight request presenting the same txHash.
          res.status(409).setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: "Payment already in progress",
              code: "PAYMENT_IN_FLIGHT",
            }),
          );
          return;
        }

        claimedTxHash = txHash;
      }

      const originalSetHeader = res.setHeader;
      res.setHeader = function (name: string, value: string | number | readonly string[]) {
        const lower = name.toLowerCase();
        if (lower === "payment-response" && !res.getHeader("X-PAYMENT-RESPONSE")) {
          originalSetHeader.call(this, "X-PAYMENT-RESPONSE", value);
        } else if (lower === "x-payment-response" && !res.getHeader("PAYMENT-RESPONSE")) {
          originalSetHeader.call(this, "PAYMENT-RESPONSE", value);
        } else if (lower === "payment-required" && !res.getHeader("X-PAYMENT-REQUIREMENTS")) {
          const valStr = typeof value === "string" ? value : JSON.stringify(value);
          const base64 = Buffer.from(valStr).toString("base64");
          originalSetHeader.call(this, "X-PAYMENT-REQUIREMENTS", base64);
        } else if (lower === "x-payment-requirements" && !res.getHeader("PAYMENT-REQUIRED")) {
          originalSetHeader.call(this, "PAYMENT-REQUIRED", value);
        }
        return originalSetHeader.call(this, name, value);
      };

      // When a payment is claimed, capture the response so it can be cached
      // for idempotent re-delivery once the request settles successfully.
      let capturedBody: string | undefined;
      let capturedHeaders: Record<string, string> | undefined;
      let capturedStatus: number | undefined;

      if (claimedTxHash) {
        const originalEnd = res.end.bind(res);
        const originalWrite = res.write.bind(res);
        const chunks: Buffer[] = [];

        res.write = function (chunk: unknown, ...args: unknown[]): boolean {
          if (chunk) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (originalWrite as any)(chunk, ...args);
        } as typeof res.write;

        res.end = function (chunk?: unknown, ...args: unknown[]): typeof res {
          if (chunk) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
          capturedBody = Buffer.concat(chunks).toString("utf8");
          capturedStatus = res.statusCode;
          const headerObj: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.getHeaders())) {
            if (value !== undefined) {
              headerObj[name] = Array.isArray(value) ? value.join(", ") : String(value);
            }
          }
          capturedHeaders = headerObj;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (originalEnd as any)(chunk, ...args);
        } as typeof res.end;
      }

      const finalizeClaim = (): void => {
        if (!claimedTxHash) return;
        if (
          capturedStatus !== undefined &&
          capturedStatus >= 200 &&
          capturedStatus < 300 &&
          capturedBody !== undefined
        ) {
          paymentCache.markSettled(claimedTxHash, {
            statusCode: capturedStatus,
            headers: capturedHeaders ?? {},
            body: capturedBody,
          });
        } else {
          // Verification failed or non-success response: release the claim so
          // the client may retry with the same transaction hash.
          paymentCache.release(claimedTxHash);
        }
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
                "PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, PAYMENT-REQUIRED, X-PAYMENT-REQUIREMENTS",
              );
              const payload = JSON.stringify(routeConfig["*"]);
              res.setHeader("PAYMENT-REQUIRED", payload);
              res.setHeader("X-PAYMENT-REQUIREMENTS", Buffer.from(payload).toString("base64"));
              paymentCache.release(claimedTxHash ?? "");
              return res.end(JSON.stringify({ error: "Payment required" }));
            }
            paymentCache.release(claimedTxHash ?? "");
            return next(paywallErr);
          }

          const paymentResp =
            res.getHeader("PAYMENT-RESPONSE") ?? res.getHeader("payment-response");
          if (paymentResp && !res.getHeader("X-PAYMENT-RESPONSE")) {
            res.setHeader("X-PAYMENT-RESPONSE", paymentResp as string);
          }

          // Cache the response once the downstream handler finishes writing it.
          if (claimedTxHash) {
            res.once("finish", finalizeClaim);
            res.once("close", finalizeClaim);
          }

          next();
        });
      } catch (err) {
        // Catch synchronous errors from paymentMiddleware (e.g., header parsing errors)
        paymentCache.release(claimedTxHash ?? "");
        if (!res.headersSent) {
          res.status(402).setHeader("Content-Type", "application/json");
          res.setHeader(
            "Access-Control-Expose-Headers",
            "PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, PAYMENT-REQUIRED, X-PAYMENT-REQUIREMENTS",
          );
          const payload = JSON.stringify(routeConfig["*"]);
          res.setHeader("PAYMENT-REQUIRED", payload);
          res.setHeader("X-PAYMENT-REQUIREMENTS", Buffer.from(payload).toString("base64"));
          return res.end(JSON.stringify({ error: "Payment required" }));
        }
        next(err);
      }
    });
  };
}
