/**
 * Framework-agnostic configuration for MARC x402 payment verification.
 *
 * This module defines the common options and types used across different
 * framework adapters (Express, Fastify, Node http). Each adapter uses these
 * options to configure the x402 v2 payment protocol.
 *
 * Adapters handle framework-specific request/response patterns:
 * - marcPaywall: Express middleware
 * - marcPaywallFastify: Fastify hook
 * - MarcPaywallNodeHttpHandler: Node.js http handler (class-based)
 */

export interface MarcPaywallCoreOptions {
  /** Stellar address to receive payment (G...). */
  payTo: string;
  /** Human-readable price string (e.g. "$0.01"). */
  price: string;
  /** Network identifier. */
  network?: "stellar:testnet" | "stellar:pubnet";
  /**
   * Token contract address or well-known alias.
   * Use `"native"` for XLM, a Soroban contract address for custom SAC/tokens,
   * or omit to default to USDC on testnet.
   */
  token?: string;
  /** Human-readable description of what's being purchased. */
  description?: string;
  /** MIME type of the response. */
  mimeType?: string;
  /** Facilitator service URL. */
  facilitatorUrl?: string;
  /** API key for the facilitator (Bearer auth). */
  facilitatorApiKey?: string;
}

export interface PaymentCheckRequest {
  /** HTTP method (GET, POST, etc). */
  method: string;
  /** Request URL path and query. */
  url: string;
  /** HTTP headers from the request. */
  headers: Record<string, string>;
}

export interface PaymentCheckResponse {
  /** Whether payment is valid (true = allow, false = 402 response needed). */
  authorized: boolean;
  /** 402 response headers to send if not authorized. */
  responseHeaders?: Record<string, string>;
  /** 402 response body if not authorized. */
  responseBody?: string;
}
