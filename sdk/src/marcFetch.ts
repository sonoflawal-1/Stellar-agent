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
    const originalBuildAndPay = stellarScheme.pay?.bind(stellarScheme);
    if (originalBuildAndPay) {
      stellarScheme.pay = async (...args: Parameters<typeof originalBuildAndPay>) => {
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

  return wrapFetchWithPayment(baseFetch, client);
}
