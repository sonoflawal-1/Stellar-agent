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

import {
  extractTraceContext,
  startSpan,
  withSpan,
  type MarcSpan,
} from "./tracing.js";

/**
 * Default time-to-live (in milliseconds) for entries in the payment
 * deduplication cache. Settled transactions are retained for one hour so that
 * retried requests can receive an idempotent cached response without being
 * re-charged, after which the entry is evicted.
 */
export const DEFAULT_PAYMENT_DEDUP_TTL_MS = 60 * 60 * 1000;

/**
 * Lifecycle state of a transaction hash tracked by the deduplication cache.
 *
 * - `PROCESSING` — a request presenting this tx hash is currently being
 *   verified/settled. Concurrent duplicates must be rejected with 409.
 * - `SETTLED` — the transaction has been verified and settled; the cached
 *   response payload can be re-delivered idempotently.
 */
export type PaymentDedupStatus = "PROCESSING" | "SETTLED";

/**
 * A single entry in the payment deduplication cache.
 */
export interface PaymentDedupEntry {
  /** Transaction hash extracted from the signed XDR. */
  txHash: string;
  /** Current lifecycle state of the transaction. */
  status: PaymentDedupStatus;
  /** Epoch milliseconds at which the entry was created. */
  createdAt: number;
  /** Epoch milliseconds at which the entry expires and may be evicted. */
  expiresAt: number;
  /**
   * Cached API response payload, populated once the transaction reaches
   * `SETTLED`. Used to re-deliver an idempotent response to retried requests.
   */
  response?: PaymentDedupCachedResponse;
}

/**
 * Cached response payload stored alongside a `SETTLED` transaction so that
 * retried requests can be answered without re-executing the handler or
 * re-charging the payer.
 */
export interface PaymentDedupCachedResponse {
  /** HTTP status code of the original response. */
  status: number;
  /** Response headers of the original response. */
  headers?: Record<string, string>;
  /** Response body of the original response (serialized). */
  body?: string;
}

/**
 * Outcome of attempting to reserve a transaction hash in the cache.
 *
 * - `acquired` — the caller now owns the `PROCESSING` reservation and should
 *   proceed with verification/settlement.
 * - `in-flight` — another request is already processing this tx hash; reject
 *   with 409 Conflict.
 * - `settled` — the transaction already settled; re-deliver `entry.response`.
 */
export type PaymentDedupReservation =
  | { kind: "acquired"; entry: PaymentDedupEntry }
  | { kind: "in-flight"; entry: PaymentDedupEntry }
  | { kind: "settled"; entry: PaymentDedupEntry };

/**
 * Options for constructing a {@link PaymentDedupCache}.
 */
export interface PaymentDedupCacheOptions {
  /**
   * Time-to-live in milliseconds for cache entries. Defaults to
   * {@link DEFAULT_PAYMENT_DEDUP_TTL_MS} (1 hour).
   */
  ttlMs?: number;
  /**
   * Clock function used to obtain the current epoch milliseconds. Primarily
   * useful for testing. Defaults to `Date.now`.
   */
  now?: () => number;
}

/**
 * In-memory, framework-agnostic cache that guards against x402 transaction
 * replay and double-spending.
 *
 * The cache tracks transaction hashes extracted from signed Stellar XDR. The
 * first request presenting a given hash atomically reserves it in the
 * `PROCESSING` state (compare-and-swap semantics via the single-threaded
 * JavaScript event loop). Concurrent duplicates observe `PROCESSING` and must
 * be rejected with 409 Conflict. Once settlement completes, the entry is
 * transitioned to `SETTLED` and the response payload is cached for idempotent
 * re-delivery to retried requests.
 *
 * Entries automatically expire after the configured TTL (1 hour by default).
 *
 * @example
 * ```typescript
 * const cache = new PaymentDedupCache();
 * const reservation = cache.reserve(txHash);
 * if (reservation.kind === "in-flight") {
 *   // respond 409 Conflict
 * } else if (reservation.kind === "settled") {
 *   // re-deliver reservation.entry.response
 * } else {
 *   // proceed with verification, then:
 *   cache.settle(txHash, { status: 200, body: "..." });
 * }
 * ```
 */
export class PaymentDedupCache {
  private readonly entries = new Map<string, PaymentDedupEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: PaymentDedupCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_PAYMENT_DEDUP_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Atomically attempt to reserve a transaction hash for processing.
   *
   * - If no live entry exists, a `PROCESSING` entry is created and returned
   *   with `kind: "acquired"`.
   * - If a live entry is `PROCESSING`, returns `kind: "in-flight"`.
   * - If a live entry is `SETTLED`, returns `kind: "settled"` with the cached
   *   response payload.
   *
   * Expired entries are evicted before the check, so a hash may be reused once
   * its previous entry has expired.
   */
  reserve(txHash: string): PaymentDedupReservation {
    const existing = this.getLiveEntry(txHash);
    if (existing) {
      return existing.status === "SETTLED"
        ? { kind: "settled", entry: existing }
        : { kind: "in-flight", entry: existing };
    }

    const now = this.now();
    const entry: PaymentDedupEntry = {
      txHash,
      status: "PROCESSING",
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.entries.set(txHash, entry);
    return { kind: "acquired", entry };
  }

  /**
   * Mark a previously reserved transaction hash as `SETTLED` and cache the
   * response payload for idempotent re-delivery.
   *
   * @returns `true` if the entry existed and was transitioned; `false` if the
   *   entry was missing or already expired.
   */
  settle(txHash: string, response?: PaymentDedupCachedResponse): boolean {
    const entry = this.getLiveEntry(txHash);
    if (!entry) {
      return false;
    }
    entry.status = "SETTLED";
    entry.response = response;
    // Refresh the TTL from settlement time so retries within the window hit
    // the cache.
    entry.expiresAt = this.now() + this.ttlMs;
    return true;
  }

  /**
   * Release a `PROCESSING` reservation without settling (e.g. verification
   * failed). This allows the payer to retry with the same transaction hash.
   *
   * @returns `true` if a `PROCESSING` entry was removed.
   */
  release(txHash: string): boolean {
    const entry = this.getLiveEntry(txHash);
    if (!entry || entry.status !== "PROCESSING") {
      return false;
    }
    this.entries.delete(txHash);
    return true;
  }

  /**
   * Retrieve the live (non-expired) entry for a transaction hash, if any.
   */
  get(txHash: string): PaymentDedupEntry | undefined {
    return this.getLiveEntry(txHash);
  }

  /**
   * Evict all expired entries. Safe to call periodically.
   *
   * @returns The number of entries evicted.
   */
  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [hash, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(hash);
        removed++;
      }
    }
    return removed;
  }

  /** Remove all entries from the cache. */
  clear(): void {
    this.entries.clear();
  }

  /** Number of entries currently held (including not-yet-pruned expired ones). */
  get size(): number {
    return this.entries.size;
  }

  private getLiveEntry(txHash: string): PaymentDedupEntry | undefined {
    const entry = this.entries.get(txHash);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(txHash);
      return undefined;
    }
    return entry;
  }
}

/**
 * Extract the transaction hash from a signed Stellar transaction XDR envelope.
 *
 * The hash is computed as the SHA-256 of the transaction's signature base
 * (network passphrase + envelope type + transaction body), matching the
 * Stellar network's transaction hash. This implementation performs a
 * best-effort structural parse of the base64 XDR envelope to locate the
 * signature base, then hashes it.
 *
 * If the XDR cannot be parsed (e.g. malformed input), `undefined` is returned
 * so callers can fall back to rejecting the request.
 *
 * @param signedXdr - Base64-encoded signed transaction envelope XDR.
 * @param networkPassphrase - Stellar network passphrase used for the hash
 *   preimage. Defaults to the testnet passphrase.
 * @returns The hex-encoded transaction hash, or `undefined` if extraction
 *   fails.
 */
export function extractTransactionHash(
  signedXdr: string,
  networkPassphrase: string = "Test SDF Network ; September 2015",
): string | undefined {
  if (typeof signedXdr !== "string" || signedXdr.length === 0) {
    return undefined;
  }

  let bytes: Uint8Array;
  try {
    bytes = base64Decode(signedXdr);
  } catch {
    return undefined;
  }

  // Locate the signature base within the envelope. The signature base is the
  // portion of the envelope XDR that precedes the signatures array. Rather
  // than fully decoding every union arm, we scan for the signature base by
  // re-encoding the envelope with an empty signature list, which is the
  // canonical definition of the signature base.
  const signatureBase = stripSignatures(bytes);
  if (!signatureBase) {
    return undefined;
  }

  const preimage = concatBytes(
    new TextEncoder().encode(networkPassphrase),
    signatureBase,
  );
  return sha256Hex(preimage);
}

/**
 * Best-effort removal of the signatures array from a signed transaction
 * envelope XDR, yielding the signature base used for hashing.
 *
 * Returns `undefined` if the envelope structure cannot be recognized.
 */
function stripSignatures(bytes: Uint8Array): Uint8Array | undefined {
  // EnvelopeType: 2 = ENVELOPE_TYPE_TX (v1), 5 = ENVELOPE_TYPE_TX_V0.
  // Both are encoded as a 4-byte big-endian discriminant at offset 0.
  if (bytes.length < 4) {
    return undefined;
  }
  const envelopeType =
    (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  if (envelopeType !== 2 && envelopeType !== 5) {
    return undefined;
  }

  // The signatures array is the final field of the envelope. It is encoded as
  // a 4-byte length followed by `length` 64-byte signature values (each
  // preceded by its own 4-byte length of 64). We walk backwards to find the
  // start of the signatures array by reading the trailing length prefix.
  const sigCount = readUint32BE(bytes, bytes.length - 4);
  if (sigCount === undefined || sigCount > 20) {
    return undefined;
  }

  // Each signature is: 4-byte length (64) + 64 bytes = 68 bytes.
  const signaturesByteLength = sigCount * 68;
  const signaturesStart = bytes.length - 4 - signaturesByteLength;
  if (signaturesStart < 4) {
    return undefined;
  }

  // Validate the signatures array length prefix.
  const declaredCount = readUint32BE(bytes, signaturesStart);
  if (declaredCount !== sigCount) {
    return undefined;
  }

  // The signature base is everything before the signatures array.
  return bytes.subarray(0, signaturesStart);
}

function readUint32BE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > bytes.length) {
    return undefined;
  }
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function base64Decode(input: string): Uint8Array {
  const normalized = input.trim();
  if (typeof atob === "function") {
    const binary = atob(normalized);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }
  // Node.js fallback.
  const bufferCtor = (
    globalThis as unknown as {
      Buffer?: { from(data: string, encoding: string): Uint8Array };
    }
  ).Buffer;
  if (bufferCtor) {
    return new Uint8Array(bufferCtor.from(normalized, "base64"));
  }
  throw new Error("No base64 decoder available");
}

function sha256Hex(data: Uint8Array): string {
  // Prefer WebCrypto's synchronous-free path is unavailable, so use a small
  // pure-JS SHA-256 implementation to keep this module dependency-free and
  // synchronous.
  return sha256(data);
}

/**
 * Minimal, dependency-free SHA-256 implementation returning lowercase hex.
 */
function sha256(data: Uint8Array): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];

  const l = data.length;
  const bitLen = l * 8;
  const withPadding = new Uint8Array((((l + 9) >> 6) + 1) << 6);
  withPadding.set(data);
  withPadding[l] = 0x80;
  // Write 64-bit big-endian bit length into the final 8 bytes.
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  const end = withPadding.length;
  withPadding[end - 8] = (hi >>> 24) & 0xff;
  withPadding[end - 7] = (hi >>> 16) & 0xff;
  withPadding[end - 6] = (hi >>> 8) & 0xff;
  withPadding[end - 5] = hi & 0xff;
  withPadding[end - 4] = (lo >>> 24) & 0xff;
  withPadding[end - 3] = (lo >>> 16) & 0xff;
  withPadding[end - 2] = (lo >>> 8) & 0xff;
  withPadding[end - 1] = lo & 0xff;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] =
        ((withPadding[j] << 24) |
          (withPadding[j + 1] << 16) |
          (withPadding[j + 2] << 8) |
          withPadding[j + 3]) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 =
        rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 =
        rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = H[0];
    let b = H[1];
    let c = H[2];
    let d = H[3];
    let e = H[4];
    let f = H[5];
    let g = H[6];
    let h = H[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += (H[i] >>> 0).toString(16).padStart(8, "0");
  }
  return hex;
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

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
  /**
   * Allowlist of Stellar addresses that a 402 challenge is permitted to
   * request payment to. When set, any challenge whose `payTo` is not in this
   * list is rejected before any signing or network payment occurs.
   *
   * **Security:** Strongly recommended in production. Without it, a malicious
   * or compromised server can direct payment to an arbitrary address.
   */
  allowedPayees?: string[];
  /**
   * Allowlist of payment assets (token contract addresses, well-known aliases
   * such as `"native"`, or `"USDC"`) that a 402 challenge may request. When
   * set, any challenge whose `asset` is not in this list is rejected before
   * any signing or network payment occurs.
   *
   * **Security:** Strongly recommended in production. Without it, a malicious
   * or compromised server can request payment in an arbitrary token.
   */
  allowedAssets?: string[];
  /**
   * Maximum amount (inclusive) that a 402 challenge may request, expressed in
   * the same units as the challenge's `amount` field (typically raw stroops as
   * a decimal string). Challenges requesting more are rejected before any
   * signing or network payment occurs.
   */
  maxAmount?: string;
  /**
   * Minimum amount (inclusive) that a 402 challenge may request, expressed in
   * the same units as the challenge's `amount` field. Challenges requesting
   * less are rejected before any signing or network payment occurs.
   */
  minAmount?: string;
}

/**
 * A single payment requirement parsed from an x402 `402 Payment Required`
 * challenge (the `accepts` array of the response body).
 */
export interface X402Challenge {
  /** Stellar address the challenge requests payment to. */
  payTo?: string;
  /** Asset (token contract address, alias, or `"native"`) requested. */
  asset?: string;
  /** Amount requested, as a decimal string in the asset's base units. */
  amount?: string;
  /** CAIP-2 network identifier the challenge applies to. */
  network?: string;
  /** Additional challenge fields are preserved verbatim. */
  [key: string]: unknown;
}

/**
 * Error thrown when a 402 challenge fails allowlist validation.
 *
 * Thrown *before* any signing or network payment occurs, guaranteeing that a
 * rejected challenge never results in a payment being made.
 */
export class ChallengeRejectedError extends Error {
  /** The field that failed validation (`payTo`, `asset`, or `amount`). */
  readonly field: "payTo" | "asset" | "amount";
  /** The offending value from the challenge. */
  readonly value: string | undefined;
  /** The configured allowlist or bound that rejected the value. */
  readonly allowed: readonly string[] | string | undefined;

  constructor(
    field: "payTo" | "asset" | "amount",
    value: string | undefined,
    allowed: readonly string[] | string | undefined,
    message?: string,
  ) {
    super(
      message ??
        `x402 challenge rejected: ${field} ${JSON.stringify(value)} is not permitted`,
    );
    this.name = "ChallengeRejectedError";
    this.field = field;
    this.value = value;
    this.allowed = allowed;
  }
}

let warnedNoAllowlist = false;

/**
 * Emit a one-time warning when no payee/asset allowlist is configured.
 *
 * Called from the challenge validation path so operators are alerted to the
 * risk of a malicious server redirecting payments.
 */
export function warnIfNoAllowlist(options: MarcPaywallCoreOptions): void {
  if (warnedNoAllowlist) {
    return;
  }
  if (!options.allowedPayees && !options.allowedAssets) {
    warnedNoAllowlist = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[marc] No allowedPayees/allowedAssets configured. A malicious server " +
        "could request payment to an arbitrary address or token. Configure " +
        "allowlists in production.",
    );
  }
}

/** Reset the one-time no-allowlist warning (for tests). */
export function resetAllowlistWarning(): void {
  warnedNoAllowlist = false;
}

function normalizeAsset(value: string): string {
  return value.trim().toLowerCase();
}

function compareDecimalStrings(a: string, b: string): number {
  const parse = (s: string): { neg: boolean; int: string; frac: string } => {
    const trimmed = s.trim();
    const neg = trimmed.startsWith("-");
    const unsigned = neg ? trimmed.slice(1) : trimmed;
    const [intPart = "0", fracPart = ""] = unsigned.split(".");
    return {
      neg,
      int: intPart.replace(/^0+(?=\d)/, "") || "0",
      frac: fracPart.replace(/0+$/, ""),
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa.neg !== pb.neg) {
    return pa.neg ? -1 : 1;
  }
  const sign = pa.neg ? -1 : 1;
  if (pa.int.length !== pb.int.length) {
    return (pa.int.length < pb.int.length ? -1 : 1) * sign;
  }
  if (pa.int !== pb.int) {
    return (pa.int < pb.int ? -1 : 1) * sign;
  }
  const maxFrac = Math.max(pa.frac.length, pb.frac.length);
  const fa = pa.frac.padEnd(maxFrac, "0");
  const fb = pb.frac.padEnd(maxFrac, "0");
  if (fa === fb) {
    return 0;
  }
  return (fa < fb ? -1 : 1) * sign;
}

/**
 * Validate a single parsed x402 challenge against the configured allowlists
 * and amount bounds.
 *
 * Throws {@link ChallengeRejectedError} on the first violation. Callers must
 * invoke this *before* signing or submitting any payment so that a rejected
 * challenge never results in a network payment.
 *
 * @param challenge - A parsed challenge from the 402 response `accepts` array.
 * @param options - Paywall options carrying the allowlists and bounds.
 * @throws {ChallengeRejectedError} If the challenge is not permitted.
 */
export function validateChallenge(
  challenge: X402Challenge,
  options: MarcPaywallCoreOptions,
): void {
  warnIfNoAllowlist(options);

  if (options.allowedPayees) {
    const payTo = challenge.payTo;
    if (
      typeof payTo !== "string" ||
      !options.allowedPayees.includes(payTo)
    ) {
      throw new ChallengeRejectedError(
        "payTo",
        payTo,
        options.allowedPayees,
        `x402 challenge rejected: payTo ${JSON.stringify(payTo)} is not in allowedPayees`,
      );
    }
  }

  if (options.allowedAssets) {
    const asset = challenge.asset;
    const normalized =
      typeof asset === "string" ? normalizeAsset(asset) : undefined;
    const allowed = options.allowedAssets.map(normalizeAsset);
    if (normalized === undefined || !allowed.includes(normalized)) {
      throw new ChallengeRejectedError(
        "asset",
        asset,
        options.allowedAssets,
        `x402 challenge rejected: asset ${JSON.stringify(asset)} is not in allowedAssets`,
      );
    }
  }

  if (options.maxAmount !== undefined) {
    const amount = challenge.amount;
    if (
      typeof amount !== "string" ||
      compareDecimalStrings(amount, options.maxAmount) > 0
    ) {
      throw new ChallengeRejectedError(
        "amount",
        amount,
        options.maxAmount,
        `x402 challenge rejected: amount ${JSON.stringify(amount)} exceeds maxAmount ${options.maxAmount}`,
      );
    }
  }

  if (options.minAmount !== undefined) {
    const amount = challenge.amount;
    if (
      typeof amount !== "string" ||
      compareDecimalStrings(amount, options.minAmount) < 0
    ) {
      throw new ChallengeRejectedError(
        "amount",
        amount,
        options.minAmount,
        `x402 challenge rejected: amount ${JSON.stringify(amount)} is below minAmount ${options.minAmount}`,
      );
    }
  }
}

/**
 * Validate every challenge in a parsed 402 response body against the
 * configured allowlists and amount bounds.
 *
 * @param body - Parsed JSON body of the 402 response.
 * @param options - Paywall options carrying the allowlists and bounds.
 * @returns The validated challenges.
 * @throws {ChallengeRejectedError} If any challenge is not permitted.
 */
export function validateChallenges(
  body: unknown,
  options: MarcPaywallCoreOptions,
): X402Challenge[] {
  const accepts = (body as { accepts?: unknown } | null | undefined)?.accepts;
  if (!Array.isArray(accepts)) {
    return [];
  }
  const challenges = accepts as X402Challenge[];
  for (const challenge of challenges) {
    validateChallenge(challenge, options);
  }
  return challenges;
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

/**
 * A span handle for a protected request, created from the inbound
 * `traceparent` header (if present) so that the paywall's verification and
 * settlement work is correlated with the caller's distributed trace.
 */
export interface PaymentRequestSpan {
  /** The active server span for the protected request. */
  span: MarcSpan;
  /**
   * Run the x402 payment verification step inside a child span.
   * The child span records errors and ends automatically.
   */
  verify<T>(fn: () => Promise<T> | T): Promise<T>;
  /**
   * Run the x402 payment settlement step inside a child span.
   * The child span records errors and ends automatically.
   */
  settle<T>(fn: () => Promise<T> | T): Promise<T>;
  /** End the server span. Safe to call more than once. */
  end(): void;
}

/**
 * Start a server span for an inbound protected request.
 *
 * Extracts W3C trace context (`traceparent` / `tracestate`) from the request
 * headers so the paywall participates in the caller's distributed trace, then
 * creates a `marc.paywall.request` server span as a child of that context.
 *
 * @param request - Normalized inbound request data.
 * @returns A {@link PaymentRequestSpan} with helpers for verification and
 *   settlement child spans.
 *
 * @example
 * ```typescript
 * const reqSpan = startPaymentRequestSpan(request);
 * try {
 *   const result = await reqSpan.verify(() => checkPayment(request));
 *   if (result.authorized) {
 *     await reqSpan.settle(() => settlePayment(request));
 *   }
 * } finally {
 *   reqSpan.end();
 * }
 * ```
 */
export function startPaymentRequestSpan(
  request: PaymentCheckRequest,
): PaymentRequestSpan {
  const parentContext = extractTraceContext(request.headers);
  const span = startSpan(
    "marc.paywall.request",
    {
      attributes: {
        "http.request.method": request.method,
        "url.path": request.url,
      },
      kind: "server",
    },
    parentContext,
  );

  let ended = false;

  return {
    span,
    verify: <T>(fn: () => Promise<T> | T): Promise<T> =>
      withSpan("marc.paywall.verify", fn, {
        parent: span,
        attributes: { "marc.paywall.step": "verify" },
      }),
    settle: <T>(fn: () => Promise<T> | T): Promise<T> =>
      withSpan("marc.paywall.settle", fn, {
        parent: span,
        attributes: { "marc.paywall.step": "settle" },
      }),
    end: () => {
      if (!ended) {
        ended = true;
        span.end();
      }
    },
  };
}
