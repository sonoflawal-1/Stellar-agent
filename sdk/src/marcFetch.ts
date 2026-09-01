import { Keypair } from "@stellar/stellar-sdk";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer, STELLAR_TESTNET_CAIP2, STELLAR_PUBNET_CAIP2 } from "@x402/stellar";

/**
 * Payment lifecycle status passed to the {@link MarcFetchOptions.onPayment} callback.
 *
 * - `"signing"` — transaction is being built and signed locally
 * - `"pending"` — signed transaction has been submitted to the network
 * - `"settled"` — server confirmed successful payment and returned 2xx
 * - `"failed"` — payment failed (signing error, RPC error, etc.)
 */
export type PaymentStatus = "signing" | "pending" | "settled" | "failed";

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
  /** Optional custom fetch implementation. Defaults to the global `fetch`. Used by tests and adapters. */
  fetchImpl?: typeof fetch;
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
  const decoded = Buffer.from(headerValue, "base64").toString("utf8");
  const parsed = JSON.parse(decoded) as { accepts?: Array<{ amount?: string; asset?: string }> };
  const firstAccept = parsed.accepts?.[0];
  return {
    amount: firstAccept?.amount ?? "",
    asset: firstAccept?.asset ?? "",
  };
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
    fetchImpl,
  } = opts;

  const caip2 = network === "pubnet" ? STELLAR_PUBNET_CAIP2 : STELLAR_TESTNET_CAIP2;

  const stellarSigner = createEd25519Signer(signer.secret(), caip2);

  const rpcConfig = rpcUrl ? { url: rpcUrl } : undefined;
  const stellarScheme = new ExactStellarScheme(stellarSigner, rpcConfig);

  const client = new x402Client();
  client.register(caip2, stellarScheme);

  const baseFetch: typeof fetch = (input, init) => {
    const headers = customHeaders
      ? { ...customHeaders, ...(init?.headers as Record<string, string> | undefined) }
      : init?.headers;

    const requestInit = {
      ...init,
      headers,
    } as RequestInit;

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      requestInit.signal = controller.signal;
      return (fetchImpl ?? fetch)(input, requestInit).finally(() => clearTimeout(timeoutHandle));
    }

    return (fetchImpl ?? fetch)(input, requestInit);
  };

  if (onPayment) {
    const originalBuildAndPay = (
      stellarScheme as unknown as { pay?: (...args: unknown[]) => Promise<unknown> }
    ).pay?.bind(stellarScheme);
    if (originalBuildAndPay) {
      (stellarScheme as unknown as { pay: typeof originalBuildAndPay }).pay = async (
        ...args: Parameters<typeof originalBuildAndPay>
      ) => {
        onPayment("signing");
        try {
          const result = await originalBuildAndPay(...args);
          onPayment("pending");
          return result;
        } catch (err) {
          onPayment("failed");
          throw err;
        }
      };
    }
  }

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    let attempts = 0;
    let paymentTriggered = false;
    while (attempts < maxPaymentAttempts) {
      attempts += 1;
      try {
        const response = await baseFetch(input, init);
        if (response.status !== 402 || attempts >= maxPaymentAttempts) {
          if (paymentTriggered && onPayment && response.ok) {
            onPayment("settled");
          }
          return response;
        }
        paymentTriggered = true;
      } catch (err) {
        if (timeoutMs && err instanceof DOMException && err.name === "AbortError") {
          throw new Error(`timeout after ${timeoutMs}ms`);
        }
        throw err;
      }
    }

    throw new Error(`max payment attempts reached: ${maxPaymentAttempts}`);
  };
}
