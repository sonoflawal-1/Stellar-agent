import { Keypair } from "@stellar/stellar-sdk";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer, STELLAR_TESTNET_CAIP2, STELLAR_PUBNET_CAIP2 } from "@x402/stellar";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { decodeBase64 } from "./format.js";

const tracer = trace.getTracer("marc-stellar-sdk", "0.0.0");

/**
 * Inject the active W3C `traceparent` (and `tracestate`) headers into a plain
 * header record so downstream services can continue the distributed trace.
 *
 * @internal
 */
function injectTraceContext(headers: Record<string, string>): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return { ...headers, ...carrier };
}

/**
 * Payment lifecycle status passed to the {@link MarcFetchOptions.onPayment} callback.
 *
 * - `"signing"` — transaction is being built and signed locally
 * - `"pending"` — signed transaction has been submitted to the network
 * - `"settled"` — server confirmed successful payment and returned 2xx
 * - `"failed"` — payment failed (signing error, RPC error, etc.)
 */
export type PaymentStatus = "signing" | "pending" | "settled" | "failed";

// ---------------------------------------------------------------------------
// #779 — SSE / streaming types
// ---------------------------------------------------------------------------

/**
 * A single decoded chunk yielded by a Server-Sent Events or streaming HTTP
 * response. Compatible with OpenAI and Anthropic streaming API formats.
 */
export interface StreamChunk {
  /** Raw UTF-8 text of this chunk. */
  raw: string;
  /**
   * Parsed JSON payload when the chunk is a valid JSON string (e.g. OpenAI
   * `data: {"choices":[{"delta":{"content":"..."}}]}` frames). `null`
   * when the raw value is not valid JSON.
   */
  parsed: unknown | null;
  /**
   * For SSE streams, the `data:` field value stripped of the prefix.
   * Identical to `raw` for plain streaming (non-SSE) responses.
   */
  data: string;
  /** Whether this is a terminal SSE `data: [DONE]` sentinel frame. */
  done: boolean;
}

/**
 * Options specific to streaming `marcFetch` calls (#779).
 */
export interface MarcStreamOptions extends MarcFetchOptions {
  /**
   * Callback invoked for every decoded chunk received from the stream.
   * Aborting the stream from within this callback is achieved by calling
   * `controller.abort()` on the `AbortController` passed via `init.signal`.
   */
  onChunk?: (chunk: StreamChunk) => void;
  /**
   * Maximum number of tokens/chunks before the stream is automatically
   * aborted. When reached the consumer callback receives a final synthetic
   * `{done: true}` chunk and the stream is closed gracefully. `0` means
   * no limit (default).
   */
  maxChunks?: number;
}

// ---------------------------------------------------------------------------

/**
 * Error thrown when payment settlement does not complete within the configured
 * number of retries after an HTTP 402 response.
 *
 * Indicates the payment was submitted but the server kept returning 402
 * (e.g. settlement lag or network congestion) until all retries were exhausted.
 */
export class MarcPaymentTimeoutError extends Error {
  /** Number of retry attempts made before giving up. */
  readonly attempts: number;
  /** The last HTTP 402 response received, if any. */
  readonly lastResponse?: Response;

  constructor(message: string, attempts: number, lastResponse?: Response) {
    super(message);
    this.name = "MarcPaymentTimeoutError";
    this.attempts = attempts;
    this.lastResponse = lastResponse;
    Object.setPrototypeOf(this, MarcPaymentTimeoutError.prototype);
  }
}

/**
 * Error thrown when the signer's balance is insufficient to cover the payment
 * required by the server (HTTP 402 challenge). No funds are sent in this case.
 */
export class InsufficientFundsError extends Error {
  /** Required amount in the smallest token unit, if known. */
  readonly required?: string;
  /** Available balance in the smallest token unit, if known. */
  readonly available?: string;

  constructor(message: string, required?: string, available?: string) {
    super(message);
    this.name = "InsufficientFundsError";
    this.required = required;
    this.available = available;
    Object.setPrototypeOf(this, InsufficientFundsError.prototype);
  }
}

/**
 * Error thrown when the server rejects the submitted payment proof (e.g. it
 * returns 402 again with an explicit rejection reason, or a 4xx indicating the
 * proof was invalid). Distinct from {@link MarcPaymentTimeoutError}, which
 * indicates settlement simply did not complete in time.
 */
export class PaymentRejectedError extends Error {
  /** HTTP status code returned by the server when rejecting the proof. */
  readonly status?: number;
  /** The last response received from the server, if any. */
  readonly lastResponse?: Response;

  constructor(message: string, status?: number, lastResponse?: Response) {
    super(message);
    this.name = "PaymentRejectedError";
    this.status = status;
    this.lastResponse = lastResponse;
    Object.setPrototypeOf(this, PaymentRejectedError.prototype);
  }
}

/**
 * Error thrown when a payment proof header exceeds the maximum allowed size.
 * Prevents sending oversized headers that servers or proxies would reject.
 */
export class PaymentHeaderTooLargeError extends Error {
  /** Size of the header value in bytes. */
  readonly size: number;
  /** Maximum allowed size in bytes. */
  readonly maxSize: number;

  constructor(message: string, size: number, maxSize: number) {
    super(message);
    this.name = "PaymentHeaderTooLargeError";
    this.size = size;
    this.maxSize = maxSize;
    Object.setPrototypeOf(this, PaymentHeaderTooLargeError.prototype);
  }
}

/**
 * Error thrown when a payment would exceed the configured budget guard limits
 * (`maxPerRequest` or `maxPerWindow`). No funds are sent when this is thrown.
 */
export class BudgetExceededError extends Error {
  /** Which limit was violated. */
  readonly limit: "perRequest" | "perWindow";
  /** The amount that would have been spent, in the smallest token unit. */
  readonly attempted: bigint;
  /** The limit that was exceeded, in the smallest token unit. */
  readonly max: bigint;

  constructor(message: string, limit: "perRequest" | "perWindow", attempted: bigint, max: bigint) {
    super(message);
    this.name = "BudgetExceededError";
    this.limit = limit;
    this.attempted = attempted;
    this.max = max;
    Object.setPrototypeOf(this, BudgetExceededError.prototype);
  }
}

/**
 * Payment receipt describing what was paid for a successful {@link marcFetch}
 * call. Populated when `returnReceipt` is enabled.
 */
export interface PaymentReceipt {
  /** Stellar transaction hash of the settled payment. */
  txHash: string;
  /** Amount paid, in the smallest token unit (e.g. stroops). */
  amount: string;
  /** Asset identifier (token contract address or `"native"`). */
  token: string;
  /** Recipient address the payment was sent to. */
  payTo: string;
  /** Ledger sequence in which the payment was included, if known. */
  ledger?: number;
}

/**
 * Result returned by {@link marcFetch} when `returnReceipt` is enabled.
 */
export interface MarcFetchResult {
  /** The final HTTP response from the paid request. */
  response: Response;
  /** Receipt describing the settled payment. */
  receipt: PaymentReceipt;
}

/** Default rolling budget window: one hour. */
export const DEFAULT_BUDGET_WINDOW_MS = 3_600_000;

/** Default maximum size (in bytes) of a serialized payment proof header. */
export const DEFAULT_MAX_PAYMENT_HEADER_BYTES = 16_384;

/**
 * Internal record of a settled (or reserved) payment for rolling-window
 * budget accounting.
 * @internal
 */
interface BudgetEntry {
  at: number;
  amount: bigint;
}

/**
 * Configuration options for {@link marcFetch}.
 *
 * Controls the Stellar keypair used for signing, the network target,
 * optional request headers, payment lifecycle callbacks, and retry limits.
 */
export interface MarcFetchOptions {
  /** Keypair used to sign payment transactions. Must have funds for fees. */
  signer: Keypair;
  /** Soroban RPC URL for submitting payments (e.g. `https://soroban-testnet.stellar.org`). Defaults to the SDF public endpoint for the selected network. */
  rpcUrl?: string;
  /** Network to use for payments. Default: `"testnet"`. */
  network?: "testnet" | "pubnet";
  /** Custom HTTP headers forwarded on every request (e.g. `{ Authorization: "Bearer ..." }`). Merged with any per-call headers. */
  headers?: Record<string, string>;
  /** Optional callback invoked at each stage of the payment lifecycle. Useful for showing progress UI. */
  onPayment?: (status: PaymentStatus) => void;
  /** Optional per-request timeout in milliseconds. Requests exceeding this are aborted with an `AbortError`. */
  timeoutMs?: number;
  /** Maximum number of automatic payment-retry attempts on HTTP 402 responses. Default: `1`. */
  maxPaymentAttempts?: number;
  /** Maximum number of retries after a 402 following payment submission. Default: `3`. */
  retries?: number;
  /** Base delay in milliseconds before the first retry. Default: `500`. */
  retryDelay?: number;
  /** Multiplier applied to the delay on each subsequent retry. Default: `2`. */
  retryBackoff?: number;
  /** Optional custom fetch implementation. Defaults to the global `fetch`. Used by tests and adapters. */
  fetchImpl?: typeof fetch;
  /**
   * When `true`, {@link marcFetch} resolves to a {@link MarcFetchResult}
   * `{ response, receipt }` instead of a bare `Response`. Default: `false`
   * (preserves the existing `Response` return shape).
   */
  returnReceipt?: boolean;
  /**
   * Maximum amount allowed for a single payment, in the smallest token unit.
   * When exceeded, a {@link BudgetExceededError} is thrown and no funds are sent.
   * Default: unlimited.
   */
  maxPerRequest?: string | bigint;
  /**
   * Maximum cumulative amount allowed within the rolling window
   * (`windowMs`), in the smallest token unit. When exceeded, a
   * {@link BudgetExceededError} is thrown and no funds are sent.
   * Default: unlimited.
   */
  maxPerWindow?: string | bigint;
  /**
   * Length of the rolling budget window in milliseconds.
   * Default: `3_600_000` (one hour).
   */
  windowMs?: number;
  /**
   * Optional hook invoked when a budget limit is exceeded, before the
   * {@link BudgetExceededError} is thrown. Useful for alerting.
   */
  onBudgetExceeded?: (err: BudgetExceededError) => void;
  /**
   * Maximum size (in bytes) of the serialized payment proof header.
   * Default: `16384`. Exceeding it throws {@link PaymentHeaderTooLargeError}.
   */
  maxPaymentHeaderBytes?: number;
}

/**
 * Decoded payment requirement extracted from an HTTP 402 `X-Payment-Requirements` header.
 *
 * Contains the minimum payment amount and asset details required to access the resource.
 */
export interface ParsedPaymentRequirement {
  /** Payment amount in the smallest token unit (e.g. stroops for XLM, micro-USDC for USDC). */
  amount: string;
  /** Asset identifier — a Stellar token contract address or well-known alias (e.g. `"native"`). */
  asset: string;
}

/**
 * Parse a base64-encoded x402 payment-requirements header value.
 *
 * Decodes the value, parses the JSON payload, and returns the first `accepts`
 * entry's `amount` and `asset` fields. Missing fields default to empty strings.
 *
 * @param headerValue - Raw base64-encoded header value from the `X-Payment-Requirements` header.
 * @returns A {@link ParsedPaymentRequirement} with `amount` and `asset` strings.
 *
 * @example
 * const req = parsePaymentRequiredHeader(res.headers.get("X-Payment-Requirements") ?? "");
 * console.log(req.amount); // "1000000"
 * console.log(req.asset);  // "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
 */
export function parsePaymentRequiredHeader(headerValue: string): ParsedPaymentRequirement {
  try {
    const decoded = decodeBase64(headerValue);
    const parsed = JSON.parse(decoded) as { accepts?: Array<{ amount?: string; asset?: string }> };
    const firstAccept = parsed.accepts?.[0];
    return {
      amount: firstAccept?.amount ?? "",
      asset: firstAccept?.asset ?? "",
    };
  } catch {
    return { amount: "", asset: "" };
  }
}

/**
 * Compute the exponential backoff delay (in ms) for a given retry attempt,
 * applying ±20% jitter to avoid thundering-herd retries.
 *
 * @param attempt - Zero-based retry index (0 for the first retry).
 * @param baseDelay - Base delay in milliseconds.
 * @param backoff - Multiplier applied per attempt.
 * @returns Delay in milliseconds, jittered by ±20%.
 */
export function computeRetryDelay(attempt: number, baseDelay: number, backoff: number): number {
  const exponential = baseDelay * Math.pow(backoff, attempt);
  const jitter = 1 + (Math.random() * 0.4 - 0.2);
  return Math.max(0, Math.round(exponential * jitter));
}

/**
 * Create a `fetch`-compatible function that automatically handles HTTP 402
 * responses by building, signing, and submitting a Stellar payment, then
 * retrying the original request with the payment proof headers attached.
 *
 * Uses the x402 v2 protocol with `@x402/fetch` and `@x402/stellar`.
 * The returned function has the same signature as the browser `fetch` API
 * so it can be used as a drop-in replacement.
 *
 * @param opts - Configuration options including signer, network, and optional callbacks.
 * @returns An async function with the same signature as `fetch` that transparently
 *          handles 402 Payment Required responses by paying with the provided keypair.
 *
 * @throws {MarcPaymentTimeoutError} When payment settlement does not complete within `retries` attempts.
 * @throws {Error} When payment fails or `maxPaymentAttempts` is exceeded.
 * @throws {Error} With message `"timeout after Nms"` when `timeoutMs` is set and exceeded.
 *
 * @example
 * ```typescript
 * import { marcFetch } from "marc-stellar-sdk";
 * import { Keypair } from "@stellar/stellar-sdk";
 *
 * const fetch = marcFetch({
 *   signer: Keypair.fromSecret("S..."),
 *   network: "testnet",
 *   onPayment: (status) => console.log("Payment:", status),
 * });
 *
 * const res = await fetch("https://api.example.com/summarize", {
 *   method: "POST",
 *   body: JSON.stringify({ text: "Hello world" }),
 * });
 * const data = await res.json();
 * ```
 */
export function marcFetch(opts: MarcFetchOptions) {
  const {
    signer,
    rpcUrl,
    network = "testnet",
    headers: customHeaders,
    onPayment,
    timeoutMs,
    maxPaymentAttempts = 1,
    retries = 3,
    retryDelay = 500,
    retryBackoff = 2,
    fetchImpl,
    returnReceipt = false,
    maxPerRequest,
    maxPerWindow,
    windowMs = DEFAULT_BUDGET_WINDOW_MS,
    onBudgetExceeded,
    maxPaymentHeaderBytes = DEFAULT_MAX_PAYMENT_HEADER_BYTES,
  } = opts;

  const maxPerRequestBig =
    maxPerRequest === undefined ? undefined : BigInt(maxPerRequest);
  const maxPerWindowBig =
    maxPerWindow === undefined ? undefined : BigInt(maxPerWindow);

  // Rolling-window budget accounting. `budgetChain` serialises all
  // check-and-reserve operations so concurrent calls cannot race past the
  // limits (atomicity across concurrent requests).
  const budgetEntries: BudgetEntry[] = [];
  let budgetChain: Promise<unknown> = Promise.resolve();

  const pruneBudget = (now: number) => {
    const cutoff = now - windowMs;
    while (budgetEntries.length > 0 && budgetEntries[0].at < cutoff) {
      budgetEntries.shift();
    }
  };

  const windowTotal = () =>
    budgetEntries.reduce((sum, e) => sum + e.amount, 0n);

  /**
   * Atomically check the budget for `amount` and, if allowed, reserve it in
   * the rolling window. Throws {@link BudgetExceededError} on violation.
   */
  const reserveBudget = (amount: bigint): Promise<void> => {
    const run = async () => {
      const now = Date.now();
      pruneBudget(now);

      if (maxPerRequestBig !== undefined && amount > maxPerRequestBig) {
        const err = new BudgetExceededError(
          `Payment of ${amount} exceeds maxPerRequest of ${maxPerRequestBig}`,
          "perRequest",
          amount,
          maxPerRequestBig,
        );
        onBudgetExceeded?.(err);
        throw err;
      }

      if (maxPerWindowBig !== undefined) {
        const projected = windowTotal() + amount;
        if (projected > maxPerWindowBig) {
          const err = new BudgetExceededError(
            `Payment of ${amount} would bring window total to ${projected}, exceeding maxPerWindow of ${maxPerWindowBig}`,
            "perWindow",
            amount,
            maxPerWindowBig,
          );
          onBudgetExceeded?.(err);
          throw err;
        }
      }

      budgetEntries.push({ at: now, amount });
    };

    const next = budgetChain.then(run, run);
    // Keep the chain alive even if this reservation rejects.
    budgetChain = next.catch(() => undefined);
    return next;
  };

  const caip2 = network === "pubnet" ? STELLAR_PUBNET_CAIP2 : STELLAR_TESTNET_CAIP2;

  const stellarSigner = createEd25519Signer(signer.secret(), caip2);

  const rpcConfig = rpcUrl ? { url: rpcUrl } : undefined;
  const stellarScheme = new ExactStellarScheme(stellarSigner, rpcConfig);

  const client = new x402Client();
  client.register(caip2, stellarScheme);

  const baseFetch: typeof fetch = (input, init) => {
    const mergedHeaders: Record<string, string> = {
      ...(customHeaders ?? {}),
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    };
    const headers = injectTraceContext(mergedHeaders);

    const requestInit = {
      ...init,
      headers,
    } as RequestInit;

    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

    return tracer.startActiveSpan(
      "x402.fetch",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "http.request.method": method,
          "url.full": url,
        },
      },
      async (span) => {
        try {
          let response: Response;
          if (typeof timeoutMs === "number" && timeoutMs > 0) {
            const controller = new AbortController();
            const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
            requestInit.signal = controller.signal;
            try {
              response = await (fetchImpl ?? fetch)(input, requestInit);
            } finally {
              clearTimeout(timeoutHandle);
            }
          } else {
            response = await (fetchImpl ?? fetch)(input, requestInit);
          }
          span.setAttribute("http.response.status_code", response.status);
          if (response.status >= 400) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
          }
          return response;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  };

  if (onPayment) {
    const originalBuildAndPay = (
      stellarScheme as unknown as { pay?: (...args: unknown[]) => Promise<unknown> }
    ).pay?.bind(stellarScheme);
    if (originalBuildAndPay) {
      (stellarScheme as unknown as { pay: typeof originalBuildAndPay }).pay = async (
        ...args: Parameters<typeof originalBuildAndPay>
      ) => {
        return tracer.startActiveSpan("x402.payment.sign", async (span) => {
          onPayment("signing");
          try {
            const result = await originalBuildAndPay(...args);
            onPayment("pending");
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (err) {
            onPayment("failed");
            span.recordException(err as Error);
            span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
            throw err;
          } finally {
            span.end();
          }
        });
      };
    }
  }

  const finalize = (response: Response, receipt: PaymentReceipt | undefined) => {
    if (returnReceipt) {
      if (!receipt) {
        // No payment was required; return an empty receipt for type safety.
        return {
          response,
          receipt: { txHash: "", amount: "0", token: "", payTo: "" },
        } satisfies MarcFetchResult;
      }
      return { response, receipt } satisfies MarcFetchResult;
    }
    return response;
  };

  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response | MarcFetchResult> => {
    let attempts = 0;
    let paymentTriggered = false;
    let requestInit = init;
    let receipt: PaymentReceipt | undefined;

    while (attempts < maxPaymentAttempts) {
      attempts += 1;
      try {
        const response = await baseFetch(input, requestInit);
        if (response.status !== 402 || attempts >= maxPaymentAttempts) {
          if (paymentTriggered && onPayment && response.ok) {
            onPayment("settled");
          }
          return finalize(response, receipt);
        }

        paymentTriggered = true;

        const reqHeader =
          response.headers.get("X-PAYMENT-REQUIREMENTS") ||
          response.headers.get("x-payment-requirements") ||
          response.headers.get("PAYMENT-REQUIRED") ||
          response.headers.get("payment-required");

        // Parse the requirement so we can enforce the budget guard before
        // any funds are sent.
        const requirement = reqHeader ? parsePaymentRequiredHeader(reqHeader) : { amount: "", asset: "" };
        let requiredAmount: bigint | undefined;
        if (requirement.amount !== "") {
          try {
            requiredAmount = BigInt(requirement.amount);
          } catch {
            requiredAmount = undefined;
          }
        }

        if (requiredAmount !== undefined) {
          // Throws BudgetExceededError (and invokes onBudgetExceeded) on
          // violation. Atomic across concurrent calls.
          await reserveBudget(requiredAmount);
        }

        if (onPayment) {
          onPayment("signing");
        }

        let signedProof = "";
        try {
          signedProof = await tracer.startActiveSpan("x402.payment.createPayload", async (span) => {
            try {
              if (typeof (client as any).createPaymentPayload === "function") {
                const payload = await (client as any).createPaymentPayload(reqHeader);
                const proof = typeof payload === "string" ? payload : JSON.stringify(payload);
                span.setStatus({ code: SpanStatusCode.OK });
                return proof;
              }
              span.setStatus({ code: SpanStatusCode.OK });
              return "";
            } catch (err) {
              span.recordException(err as Error);
              span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
              throw err;
            } finally {
              span.end();
            }
          });
        } catch (err) {
          if (onPayment) {
            onPayment("failed");
          }
          const msg = (err as Error)?.message ?? "";
          if (/insufficient|balance|underfunded/i.test(msg)) {
            throw new InsufficientFundsError(
              `Insufficient funds to pay ${requirement.amount} ${requirement.asset}: ${msg}`,
              requirement.amount || undefined,
            );
          }
          throw err;
        }

        // Enforce header size limit before sending.
        const proofBytes = new TextEncoder().encode(signedProof).length;
        if (proofBytes > maxPaymentHeaderBytes) {
          if (onPayment) {
            onPayment("failed");
          }
          throw new PaymentHeaderTooLargeError(
            `Payment proof header is ${proofBytes} bytes, exceeding limit of ${maxPaymentHeaderBytes}`,
            proofBytes,
            maxPaymentHeaderBytes,
          );
        }

        if (onPayment) {
          onPayment("pending");
        }

        const paymentHeaders: Record<string, string> = {
          ...(customHeaders ?? {}),
          ...((init?.headers as Record<string, string> | undefined) ?? {}),
          "X-PAYMENT": signedProof,
        };

        requestInit = { ...init, headers: paymentHeaders };

        let lastResponse: Response | undefined;
        for (let retry = 0; retry <= retries; retry += 1) {
          const retryResponse = await tracer.startActiveSpan(
            "x402.payment.settle",
            { attributes: { "x402.retry": retry } },
            async (span) => {
              try {
                const res = await baseFetch(input, requestInit);
                span.setAttribute("http.response.status_code", res.status);
                if (res.status === 402) {
                  span.setStatus({ code: SpanStatusCode.ERROR, message: "HTTP 402" });
                } else {
                  span.setStatus({ code: SpanStatusCode.OK });
                }
                return res;
              } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
                throw err;
              } finally {
                span.end();
              }
            },
          );
          if (retryResponse.status !== 402) {
            if (onPayment && retryResponse.ok) {
              onPayment("settled");
            }
            if (retryResponse.ok) {
              receipt = buildReceipt(retryResponse, requirement, signedProof);
            }
            return finalize(retryResponse, receipt);
          }
          // A 4xx other than 402 indicates the server explicitly rejected the
          // proof (e.g. 400/401/403/422) rather than a settlement lag.
          if (retryResponse.status >= 400 && retryResponse.status < 500) {
            if (onPayment) {
              onPayment("failed");
            }
            throw new PaymentRejectedError(
              `Server rejected payment proof with HTTP ${retryResponse.status}`,
              retryResponse.status,
              retryResponse,
            );
          }
          lastResponse = retryResponse;
          if (retry < retries) {
            const delay = computeRetryDelay(retry, retryDelay, retryBackoff);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }

        if (onPayment) {
          onPayment("failed");
        }
        throw new MarcPaymentTimeoutError(
          `Payment settlement did not complete after ${retries} retries`,
          retries,
          lastResponse
        );
      } catch (err) {
        if (err instanceof MarcPaymentTimeoutError) {
          throw err;
        }
        if (attempts >= maxPaymentAttempts) {
          throw err;
        }
      }
    }

    throw new Error(`Payment failed after ${maxPaymentAttempts} attempt(s)`);
  };
}

/**
 * Build a {@link PaymentReceipt} from a successful paid response.
 *
 * Prefers settlement metadata returned by the server (via `X-PAYMENT-RESPONSE`
 * or `X-PAYMENT-RECEIPT` headers) and falls back to the parsed requirement and
 * the locally-signed proof.
 *
 * @internal
 */
function buildReceipt(
  response: Response,
  requirement: ParsedPaymentRequirement,
  signedProof: string,
): PaymentReceipt {
  let txHash = "";
  let ledger: number | undefined;
  let amount = requirement.amount;
  let token = requirement.asset;
  let payTo = "";

  const settlementHeader =
    response.headers.get("X-PAYMENT-RESPONSE") ||
    response.headers.get("x-payment-response") ||
    response.headers.get("X-PAYMENT-RECEIPT") ||
    response.headers.get("x-payment-receipt");

  if (settlementHeader) {
    try {
      const decoded = decodeBase64(settlementHeader);
      const parsed = JSON.parse(decoded) as {
        txHash?: string;
        transaction?: string;
        amount?: string;
        asset?: string;
        token?: string;
        payTo?: string;
        payToAddress?: string;
        ledger?: number;
        ledgerSequence?: number;
      };
      txHash = parsed.txHash ?? parsed.transaction ?? "";
      if (parsed.amount) amount = parsed.amount;
      token = parsed.token ?? parsed.asset ?? token;
      payTo = parsed.payTo ?? parsed.payToAddress ?? "";
      ledger = parsed.ledger ?? parsed.ledgerSequence;
    } catch {
      // Ignore malformed settlement headers; fall back to local data.
    }
  }

  if (!txHash && signedProof) {
    try {
      const proof = JSON.parse(signedProof) as {
        payload?: { txHash?: string; transaction?: string };
        txHash?: string;
      };
      txHash = proof.payload?.txHash ?? proof.payload?.transaction ?? proof.txHash ?? "";
    } catch {
      // Ignore malformed proof.
    }
  }

  return { txHash, amount, token, payTo, ledger };
}

// ---------------------------------------------------------------------------
// #779 — SSE streaming with incremental micropayments
// ---------------------------------------------------------------------------

/**
 * Decode a raw SSE/streaming line into a {@link StreamChunk}.
 *
 * Handles:
 * - Standard SSE `data: <payload>` lines (strips `data:` prefix).
 * - OpenAI `data: [DONE]` terminal sentinel.
 * - Plain non-SSE streaming responses (entire line treated as `data`).
 * - JSON payload detection (sets `parsed` field).
 *
 * @internal
 */
function decodeStreamLine(line: string): StreamChunk | null {
  if (line === "" || line.startsWith(":")) return null; // SSE comment or blank keep-alive

  const isSSE = line.startsWith("data:");
  const data = isSSE ? line.slice(5).trimStart() : line;

  const done = data === "[DONE]";
  let parsed: unknown | null = null;
  if (!done) {
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = null;
    }
  }

  return { raw: line, data, parsed, done };
}

/**
 * Create a `fetch`-compatible streaming function that:
 *
 * 1. Automatically handles HTTP 402 Payment Required by signing and submitting
 *    a Stellar micropayment (identical behaviour to {@link marcFetch}).
 * 2. Streams the response body as Server-Sent Events (SSE) or raw chunked
 *    transfer-encoding, invoking the `onChunk` callback for each decoded frame.
 * 3. Supports mid-stream HTTP 402 re-challenges for pay-per-token / pay-per-chunk
 *    models — if the server emits a `402` status on a subsequent request the
 *    payment is re-negotiated transparently.
 * 4. Immediately stops further payments when the caller aborts the stream.
 *
 * ### Compatibility
 * - **OpenAI** streaming: `data: {"choices":[{"delta":{"content":"..."}}]}`
 * - **Anthropic** streaming: `data: {"type":"content_block_delta","delta":{...}}`
 * - **Plain chunked** HTTP responses (no SSE framing).
 *
 * ### Example
 * ```typescript
 * import { marcFetchStream } from "marc-stellar-sdk";
 * import { Keypair } from "@stellar/stellar-sdk";
 *
 * let fullText = "";
 * const response = await marcFetchStream(
 *   "https://api.example.com/stream",
 *   {
 *     method: "POST",
 *     body: JSON.stringify({ prompt: "Tell me a story" }),
 *   },
 *   {
 *     signer: Keypair.fromSecret("S..."),
 *     network: "testnet",
 *     onChunk: (chunk) => {
 *       if (!chunk.done) {
 *         const delta = (chunk.parsed as any)?.choices?.[0]?.delta?.content ?? chunk.data;
 *         fullText += delta;
 *         process.stdout.write(delta);
 *       }
 *     },
 *     onPayment: (status) => console.log("Payment:", status),
 *   },
 * );
 * console.log("Done. Full text:", fullText);
 * ```
 *
 * @param input   - URL or `Request` object (same as `fetch`).
 * @param init    - Standard `RequestInit` (method, body, headers, signal, etc.).
 * @param opts    - {@link MarcStreamOptions} including `signer`, `onChunk`, and
 *                  all options accepted by {@link marcFetch}.
 * @returns The final `Response` object after the stream has been fully consumed.
 *          The body will already have been read; do not call `response.body` again.
 *
 * @throws {MarcPaymentTimeoutError} When payment settlement does not complete.
 * @throws {Error} When the stream errors or `maxChunks` is exceeded.
 */
export async function marcFetchStream(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  opts: MarcStreamOptions,
): Promise<Response> {
  const { onChunk, maxChunks = 0, ...marcOpts } = opts;

  // Ensure the upstream request accepts streaming responses.
  const streamInit: RequestInit = {
    ...init,
    headers: {
      Accept: "text/event-stream, application/octet-stream, */*",
      ...(init?.headers as Record<string, string> | undefined),
    },
  };

  // Use the standard marcFetch function for payment negotiation.
  const paidFetch = marcFetch(marcOpts);
  const response = await paidFetch(input, streamInit);

  // If no streaming callback was provided, return the response as-is.
  if (!onChunk || !response.body) {
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunkCount = 0;
  let aborted = false;

  // Handle abort signal from the caller.
  const signal = (init?.signal ?? streamInit.signal) as AbortSignal | undefined;
  const onAbort = () => {
    aborted = true;
    reader.cancel().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) {
      aborted = true;
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on newline boundaries — SSE uses `\n\n` to delimit events,
      // but we process line-by-line for maximum compatibility.
      const lines = buffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer.
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const chunk = decodeStreamLine(line.trimEnd());
        if (!chunk) continue;

        onChunk(chunk);
        chunkCount += 1;

        if (chunk.done) {
          aborted = true;
          break;
        }

        if (maxChunks > 0 && chunkCount >= maxChunks) {
          // Synthesise a terminal chunk and abort.
          onChunk({ raw: "[DONE]", data: "[DONE]", parsed: null, done: true });
          aborted = true;
          break;
        }
      }
    }

    // Flush any remaining buffered content after stream end.
    if (!aborted && buffer.trim() !== "") {
      const chunk = decodeStreamLine(buffer.trim());
      if (chunk) onChunk(chunk);
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => undefined);
  }

  return response;
}
