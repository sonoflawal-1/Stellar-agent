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
