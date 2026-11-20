/**
 * Format an atomic Soroban token amount into a human-readable decimal string.
 *
 * Soroban tokens (SAC / Stellar Asset Contracts) track balances in atomic
 * units: `amount / 10^decimals` is the human-scale value. USDC (and most
 * Stellar classic assets) use 7 decimals, which is the default.
 *
 * All math is done with `bigint` — no floating point — so arbitrarily large
 * balances format exactly (e.g. `10^30` atomic units won't lose precision).
 *
 * @example
 * formatAmount(12_500_000n)                        // "1.25"
 * formatAmount(1n)                                 // "0.0000001"
 * formatAmount(1_234_567_890n, { group: true })    // "123.456789"
 * formatAmount(9_999_999_999n, { precision: 2 })   // "999.99"
 * formatAmount(5_000_000_000_000n, { group: true, precision: 2 }) // "500,000"
 */
/** Matches a Stellar secret seed (starts with `S`, 56 base32 chars) anywhere in a string. */
const SECRET_KEY_PATTERN = /S[A-Z2-7]{55}/g;

export function decodeBase64(value: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "base64").toString("utf8");
  }

  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Redact any Stellar secret key found in a string, keeping only the first
 * and last 4 characters (e.g. `SABC...WXYZ`).
 *
 * Used to sanitize log lines and error messages before they're printed, so
 * a secret seed accidentally captured in a stack trace or debug dump is
 * never shown in plaintext.
 */
export function maskSecret(str: string): string {
  return str.replace(SECRET_KEY_PATTERN, (match) => `${match.slice(0, 4)}...${match.slice(-4)}`);
}

export function formatAmount(
  amount: bigint,
  options: {
    /** Token decimals. Stellar assets default to 7. */
    decimals?: number;
    /** Max fractional digits to show (defaults to `decimals`, trailing zeros trimmed). */
    precision?: number;
    /** Insert thousands separators in the integer part. */
    group?: boolean;
  } = {},
): string {
  const decimals = options.decimals ?? 7;
  const precision = options.precision ?? decimals;
  if (decimals < 0 || precision < 0) {
    throw new RangeError("formatAmount: decimals and precision must be >= 0");
  }

  const factor = 10n ** BigInt(decimals);
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  const whole = abs / factor;
  const frac = abs % factor;

  // Truncate to the requested precision, then strip trailing zeros.
  let fracStr = frac.toString().padStart(decimals, "0");
  if (precision < decimals) {
    fracStr = fracStr.slice(0, precision);
  }
  fracStr = fracStr.replace(/0+$/, "");

  let wholeStr = whole.toString();
  if (options.group) {
    wholeStr = wholeStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  return fracStr.length > 0 ? `${sign}${wholeStr}.${fracStr}` : `${sign}${wholeStr}`;
}

/**
 * Parse a human-readable decimal string back into atomic bigint units.
 *
 * This is the inverse of `formatAmount`. It converts a user-supplied string
 * such as `"10.5"` (USDC) into its atomic representation `105_000_000n` using
 * integer arithmetic only — no floating-point rounding errors.
 *
 * @param input    Human-readable amount, e.g. `"10.5"`, `"0.0000001"`, `"1000"`.
 * @param decimals Token decimal places (defaults to 7, matching Stellar assets).
 * @returns        Atomic bigint amount.
 *
 * @throws {RangeError}  if `decimals < 0`.
 * @throws {TypeError}   if `input` contains invalid characters, more than one
 *                       decimal point, is empty, or is negative.
 * @throws {RangeError}  if the fractional part has more digits than `decimals`
 *                       (precision beyond the token's resolution is rejected to
 *                       avoid silent truncation; callers should round first).
 *
 * @example
 * parseAmount("10.5", 7)       // 105_000_000n
 * parseAmount("1", 7)          // 10_000_000n
 * parseAmount("0.0000001", 7)  // 1n
 * parseAmount("0", 7)          // 0n
 * parseAmount("1000", 6)       // 1_000_000_000n  (6-decimal token)
 */
export function parseAmount(input: string, decimals = 7): bigint {
  if (decimals < 0) {
    throw new RangeError("parseAmount: decimals must be >= 0");
  }

  const trimmed = input.trim();

  if (trimmed.length === 0) {
    throw new TypeError("parseAmount: input must not be empty");
  }

  // Reject negative values
  if (trimmed.startsWith("-")) {
    throw new TypeError("parseAmount: negative amounts are not supported");
  }

  // Validate characters: only digits and at most one decimal point
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(
      `parseAmount: invalid characters in input "${input}". Only digits and a single decimal point are allowed.`,
    );
  }

  const dotIndex = trimmed.indexOf(".");
  let intPart: string;
  let fracPart: string;

  if (dotIndex === -1) {
    intPart = trimmed;
    fracPart = "";
  } else {
    intPart = trimmed.slice(0, dotIndex);
    fracPart = trimmed.slice(dotIndex + 1);
  }

  if (fracPart.length > decimals) {
    throw new RangeError(
      `parseAmount: fractional part "${fracPart}" has ${fracPart.length} digits but token only supports ${decimals} decimal places`,
    );
  }

  // Pad fractional part with trailing zeros to reach full `decimals` precision
  const fracPadded = fracPart.padEnd(decimals, "0");

  const factor = 10n ** BigInt(decimals);
  const wholeBig = BigInt(intPart || "0") * factor;
  const fracBig = BigInt(fracPadded || "0");

  return wholeBig + fracBig;
}

/** Maximum token decimals supported by the multi-token helpers. */
const MAX_DECIMALS = 18;

function assertDecimals(decimals: number, fn: string): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(`${fn}: decimals must be an integer between 0 and ${MAX_DECIMALS}`);
  }
}

/**
 * Convert a human-readable decimal string into atomic base units for a token
 * with the given `decimals`, using only string/BigInt arithmetic.
 *
 * Unlike `parseAmount`, this helper is token-aware: pass the `decimals` from
 * the token allowlist (`TokenInfo.decimals`) so each token converts correctly.
 * No floating-point math is used anywhere, so large amounts stay exact.
 *
 * @param amount   Human-readable amount, e.g. `"10.5"`, `"0.0000001"`, `"1000"`.
 * @param decimals Token decimal places (0-18).
 * @returns        Atomic bigint amount.
 *
 * @throws {RangeError} if `decimals` is not an integer in `[0, 18]`, or if the
 *                      fractional part has more digits than `decimals`.
 * @throws {TypeError}  if `amount` is empty, negative, or contains invalid
 *                      characters (only digits and a single decimal point).
 *
 * @example
 * toBaseUnits("10.5", 7)   // 105_000_000n
 * toBaseUnits("1", 0)      // 1n
 * toBaseUnits("0.5", 18)   // 500_000_000_000_000_000n
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
  assertDecimals(decimals, "toBaseUnits");

  if (typeof amount !== "string") {
    throw new TypeError("toBaseUnits: amount must be a string");
  }

  const trimmed = amount.trim();
  if (trimmed.length === 0) {
    throw new TypeError("toBaseUnits: amount must not be empty");
  }
  if (trimmed.startsWith("-")) {
    throw new TypeError("toBaseUnits: negative amounts are not supported");
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(
      `toBaseUnits: invalid characters in amount "${amount}". Only digits and a single decimal point are allowed.`,
    );
  }

  const dotIndex = trimmed.indexOf(".");
  const intPart = dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex);
  const fracPart = dotIndex === -1 ? "" : trimmed.slice(dotIndex + 1);

  if (fracPart.length > decimals) {
    throw new RangeError(
      `toBaseUnits: fractional part "${fracPart}" has ${fracPart.length} digits but token only supports ${decimals} decimal places`,
    );
  }

  const factor = 10n ** BigInt(decimals);
  const wholeBig = BigInt(intPart || "0") * factor;
  const fracBig = BigInt(fracPart.padEnd(decimals, "0") || "0");

  return wholeBig + fracBig;
}

/**
 * Convert an atomic bigint amount into a human-readable decimal string for a
 * token with the given `decimals`. Inverse of `toBaseUnits`.
 *
 * Trailing fractional zeros are trimmed; a whole-number result has no decimal
 * point. All math is BigInt — no floating point.
 *
 * @param amount   Atomic amount in base units.
 * @param decimals Token decimal places (0-18).
 * @returns        Human-readable decimal string.
 *
 * @throws {RangeError} if `decimals` is not an integer in `[0, 18]`.
 * @throws {TypeError}  if `amount` is not a bigint.
 *
 * @example
 * fromBaseUnits(105_000_000n, 7)  // "10.5"
 * fromBaseUnits(1n, 0)            // "1"
 * fromBaseUnits(500_000_000_000_000_000n, 18) // "0.5"
 */
export function fromBaseUnits(amount: bigint, decimals: number): string {
  assertDecimals(decimals, "fromBaseUnits");

  if (typeof amount !== "bigint") {
    throw new TypeError("fromBaseUnits: amount must be a bigint");
  }

  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;

  if (decimals === 0) {
    return `${sign}${abs.toString()}`;
  }

  const factor = 10n ** BigInt(decimals);
  const whole = abs / factor;
  const frac = abs % factor;

  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${sign}${whole.toString()}.${fracStr}` : `${sign}${whole.toString()}`;
}

/** Minimal token info shape needed by `TokenRegistry`. */
export interface TokenInfoLike {
  decimals: number;
}

/**
 * Caches per-token `decimals` (from `get_token_info`) so callers can convert
 * amounts for any allowlisted token without re-fetching metadata.
 *
 * The fetcher is an async callback, e.g.
 * `(token) => contract.get_token_info({ token })`. Results are cached by token
 * address; concurrent lookups for the same token share one in-flight request.
 *
 * @example
 * const registry = new TokenRegistry(async (token) => {
 *   const info = await contract.get_token_info({ token });
 *   return { decimals: info.decimals };
 * });
 * await registry.toBaseUnitsFor(usdc, "10.5");
 */
export class TokenRegistry {
  private readonly cache = new Map<string, Promise<number>>();

  constructor(private readonly fetcher: (token: string) => Promise<TokenInfoLike>) {}

  /**
   * Resolve the token's decimals, fetching and caching `get_token_info` on
   * first use. Rejects if the fetcher fails or returns invalid decimals.
   */
  async getDecimals(token: string): Promise<number> {
    if (typeof token !== "string" || token.length === 0) {
      throw new TypeError("TokenRegistry.getDecimals: token must be a non-empty string");
    }

    let pending = this.cache.get(token);
    if (!pending) {
      pending = (async () => {
        const info = await this.fetcher(token);
        if (!info || typeof info.decimals !== "number") {
          throw new TypeError(`TokenRegistry: get_token_info for ${token} returned no decimals`);
        }
        assertDecimals(info.decimals, "TokenRegistry.getDecimals");
        return info.decimals;
      })();
      this.cache.set(token, pending);
      // Drop failed lookups so a later call can retry.
      pending.catch(() => {
        if (this.cache.get(token) === pending) {
          this.cache.delete(token);
        }
      });
    }

    return pending;
  }

  /** Convert a human-readable amount to base units using the token's decimals. */
  async toBaseUnitsFor(token: string, amount: string): Promise<bigint> {
    const decimals = await this.getDecimals(token);
    return toBaseUnits(amount, decimals);
  }

  /** Convert a base-unit amount to a human-readable string using the token's decimals. */
  async fromBaseUnitsFor(token: string, amount: bigint): Promise<string> {
    const decimals = await this.getDecimals(token);
    return fromBaseUnits(amount, decimals);
  }

  /** Seed the cache with known decimals (e.g. from an allowlist). */
  setDecimals(token: string, decimals: number): void {
    assertDecimals(decimals, "TokenRegistry.setDecimals");
    this.cache.set(token, Promise.resolve(decimals));
  }

  /** Clear all cached decimals. */
  clear(): void {
    this.cache.clear();
  }
}

/**
 * Validate an agent metadata URI to prevent SSRF and script-injection when
 * clients later fetch it.
 *
 * Only `https://` and `ipfs://` schemes are accepted (`ipfs://` is
 * content-addressed and has no network host to resolve, so it skips the IP
 * checks below). Everything else — including `javascript:`, `data:`, and
 * `file:` — is rejected.
 *
 * For `https://` URIs, the hostname is also rejected if it is a loopback or
 * private IPv4 literal: `127.0.0.0/8`, `10.0.0.0/8`, or `169.254.0.0/16`
 * (the latter covers cloud metadata endpoints such as `169.254.169.254`).
 *
 * @example
 * isValidMetadataUri("https://ipfs.example/metadata.json") // true
 * isValidMetadataUri("ipfs://Qm...")                        // true
 * isValidMetadataUri("javascript:alert(1)")                 // false
 * isValidMetadataUri("http://169.254.169.254/latest/meta-data/") // false
 */
export function isValidMetadataUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  if (parsed.protocol === "ipfs:") {
    return true;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  const ipv4 = parsed.hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return false;
    const [a, b] = octets;
    if (a === 127) return false; // 127.0.0.0/8 (loopback)
    if (a === 10) return false; // 10.0.0.0/8 (private)
    if (a === 169 && b === 254) return false; // 169.254.0.0/16 (link-local / cloud metadata)
  }

  return true;
}
