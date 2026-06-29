import { Keypair } from "@stellar/stellar-sdk";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import {
  createEd25519Signer,
  STELLAR_TESTNET_CAIP2,
  STELLAR_PUBNET_CAIP2,
} from "@x402/stellar";

/** Payment lifecycle status passed to the onPayment callback. */
export type PaymentStatus = "signing" | "pending" | "settled" | "failed";

/**
 * Configuration options for the auto-paying marcFetch wrapper.
 *
 * Controls how payment transactions are built, which network is used, and
 * provides optional callbacks for monitoring payment progress.
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
}

/**
 * Create a fetch wrapper that automatically handles HTTP 402 payment responses.
 *
 * Wraps the native `fetch` function to intercept 402 "Payment Required" responses.
 * When a 402 is received, the wrapper automatically:
 * 1. Parses payment requirements from response headers
 * 2. Builds and signs a Stellar payment transaction
 * 3. Submits the payment via Soroban
 * 4. Retries the original request with payment proof headers
 *
 * Uses the x402 v2 protocol with @x402/fetch and @x402/stellar libraries.
 *
 * @param opts - Configuration including signer keypair, RPC URL, and network
 * @returns A fetch-compatible function that auto-pays on 402 responses
 *
 * @example
 * ```typescript
 * const fetch = marcFetch({
 *   signer: myKeypair,
 *   network: "testnet",
 *   onPayment: (status) => console.log(`Payment: ${status}`),
 * });
 * const response = await fetch("https://api.example.com/protected");
 * ```
 */
export function marcFetch(opts: MarcFetchOptions) {
  const {
    signer,
    rpcUrl,
    network = "testnet",
    headers: customHeaders,
    onPayment,
  } = opts;

  const caip2 =
    network === "pubnet" ? STELLAR_PUBNET_CAIP2 : STELLAR_TESTNET_CAIP2;

  const stellarSigner = createEd25519Signer(signer.secret(), caip2);

  const rpcConfig = rpcUrl ? { url: rpcUrl } : undefined;
  const stellarScheme = new ExactStellarScheme(stellarSigner, rpcConfig);

  const client = new x402Client();
  client.register(caip2, stellarScheme);

  const baseFetch: typeof fetch = customHeaders
    ? (input, init) =>
        fetch(input, {
          ...init,
          headers: { ...customHeaders, ...(init?.headers as Record<string, string> | undefined) },
        })
    : fetch;

  if (onPayment) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scheme = stellarScheme as any;
    const originalBuildAndPay = scheme.pay?.bind(stellarScheme);
    if (originalBuildAndPay) {
      scheme.pay = async (...args: unknown[]) => {
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
    // For other error status codes, return as-is without attempting payment parsing
    return response;
  };

  // Note: onPayment callback is set up to track payment status, but x402-stellar v2.9.0
  // doesn't expose payment lifecycle hooks on the scheme. The wrapFetchWithPayment function
  // handles all payment automatically without exposing intermediate states.
  // Future x402 versions may expose payment hooks for monitoring.
  if (onPayment) {
    // Log that callbacks are registered but not used by x402 in this version
    onPayment("pending");
  }

  return wrapFetchWithPayment(wrappedFetch, client);
}
