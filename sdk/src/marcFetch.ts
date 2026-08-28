import { Keypair } from "@stellar/stellar-sdk";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer, STELLAR_TESTNET_CAIP2, STELLAR_PUBNET_CAIP2 } from "@x402/stellar";

/** Payment lifecycle status passed to the onPayment callback. */
export type PaymentStatus = "signing" | "pending" | "settled" | "failed";

/**
 * Configuration for the auto-paying fetch wrapper.
 */
export interface MarcFetchOptions {
  /** Keypair used to sign payment transactions. */
  signer: Keypair;
  /** Soroban RPC URL for submitting payments. */
  rpcUrl?: string;
  /** Network: testnet or pubnet. Default: testnet. */
  network?: "testnet" | "pubnet";
  /** Custom HTTP headers forwarded on every request (e.g. API keys, auth tokens). */
  headers?: Record<string, string>;
  /** Optional callback invoked with payment lifecycle status for progress UI. */
  onPayment?: (status: PaymentStatus) => void;
  /** Optional timeout for each request in milliseconds. */
  timeoutMs?: number;
  /** Maximum number of payment-retry attempts for 402 responses. */
  maxPaymentAttempts?: number;
  /** Optional custom fetch implementation (used by tests and adapters). */
  fetchImpl?: typeof fetch;
}

export interface ParsedPaymentRequirement {
  amount: string;
  asset: string;
}

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
 * Returns a `fetch`-compatible function that automatically handles HTTP 402
 * responses by building, signing, and submitting a Stellar payment, then
 * retrying the original request with the payment headers.
 *
 * Uses the x402 v2 protocol with @x402/fetch and @x402/stellar.
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
