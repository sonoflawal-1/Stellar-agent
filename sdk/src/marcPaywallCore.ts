/**
 * Framework-agnostic configuration for MARC x402 payment verification.
 *
 * This module defines the common options and types shared across all
 * framework adapters:
 * - {@link marcPaywall} — Express middleware
 * - {@link marcPaywallFastify} — Fastify `preHandler` hook
 * - {@link MarcPaywallNodeHttpHandler} / {@link marcPaywallNodeHttp} — raw Node.js `http` handler
 *
 * Import this module directly when building custom adapters or when you need
 * the type definitions without pulling in a specific framework adapter.
 *
 * @module marcPaywallCore
 */

/**
 * Framework-agnostic configuration options for MARC x402 payment middleware.
 *
 * Shared by all framework adapters (Express, Fastify, Node http). Each adapter
 * accepts these options verbatim via its own type alias.
 *
 * @example
 * ```typescript
 * const opts: MarcPaywallCoreOptions = {
 *   payTo: "GABC...",
 *   price: "$0.01",
 *   network: "stellar:testnet",
 * };
 * ```
 */
export interface MarcPaywallCoreOptions {
  /** Stellar address to receive payment (starts with `G`). Required. */
  payTo: string;
  /**
   * Human-readable price string understood by the x402 facilitator.
   * Examples: `"$0.01"`, `"0.10"`, `"1000000"` (raw stroops).
   */
  price: string;
  /**
   * CAIP-2 network identifier. Defaults to `"stellar:testnet"`.
   * Use `"stellar:pubnet"` for mainnet deployments.
   */
  network?: "stellar:testnet" | "stellar:pubnet";
  /**
   * Token contract address or well-known alias for the payment asset.
   * - Omit (or pass `undefined`) to default to USDC on testnet.
   * - Use `"native"` for XLM payments.
   * - Use a Soroban contract address (C...) for any SAC or custom token.
   */
  token?: string;
  /**
   * Human-readable description shown to the payer in wallet UIs.
   * Defaults to `"MARC-protected API call"`.
   */
  description?: string;
  /**
   * MIME type of the protected resource's response body.
   * Defaults to `"application/json"`.
   */
  mimeType?: string;
  /**
   * URL of the x402 facilitator service used to verify and settle payments.
   * Defaults to the OpenZeppelin testnet facilitator.
   */
  facilitatorUrl?: string;
  /**
   * API key for authenticating requests to the facilitator service.
   * Sent as a `Bearer` token in the `Authorization` header.
   */
  facilitatorApiKey?: string;
}

/**
 * Normalized inbound request data passed to the payment-check logic.
 *
 * Adapters (Express, Fastify, Node http) extract these fields from their
 * framework-specific request objects before calling the shared verifier.
 */
export interface PaymentCheckRequest {
  /** HTTP method in uppercase (e.g. `"GET"`, `"POST"`). */
  method: string;
  /** Full request URL including path and query string (e.g. `"/api/summarize?v=1"`). */
  url: string;
  /** HTTP request headers as a plain key/value map. Header names are lower-cased. */
  headers: Record<string, string>;
}

/**
 * Result returned by the payment-check logic to the framework adapter.
 *
 * When `authorized` is `false`, the adapter must send an HTTP 402 response
 * using the provided `responseHeaders` and `responseBody` before the request
 * can proceed.
 */
export interface PaymentCheckResponse {
  /**
   * Whether the incoming request carries valid payment proof.
   * - `true` — payment verified; the request may proceed to the handler.
   * - `false` — no valid payment; send a 402 response using the fields below.
   */
  authorized: boolean;
  /**
   * HTTP headers to include in the 402 response (e.g. `X-Payment-Requirements`).
   * Only present when `authorized` is `false`.
   */
  responseHeaders?: Record<string, string>;
  /**
   * JSON body for the 402 response describing payment requirements.
   * Only present when `authorized` is `false`.
   */
  responseBody?: string;
}
