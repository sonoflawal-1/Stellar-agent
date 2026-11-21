import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeBase64,
  formatAmount,
  fromBaseUnits,
  isValidMetadataUri,
  parseAmount,
  toBaseUnits,
  TokenRegistry,
} from "./format.js";

test("decodeBase64 decodes ASCII and UTF-8 strings", () => {
  assert.equal(decodeBase64(Buffer.from("payment").toString("base64")), "payment");
  assert.equal(decodeBase64(Buffer.from("café").toString("base64")), "café");
});

// ===========================================================================
// isValidMetadataUri (existing tests preserved)
// ===========================================================================

test("isValidMetadataUri accepts https and ipfs URIs", () => {
  assert.equal(isValidMetadataUri("https://ipfs.example/metadata.json"), true);
  assert.equal(isValidMetadataUri("https://example.com/agent.json"), true);
  assert.equal(isValidMetadataUri("ipfs://QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o"), true);
});

test("isValidMetadataUri rejects dangerous schemes", () => {
  assert.equal(isValidMetadataUri("javascript:alert(1)"), false);
  assert.equal(isValidMetadataUri("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(isValidMetadataUri("file:///etc/passwd"), false);
  assert.equal(isValidMetadataUri("http://example.com/agent.json"), false);
});

test("isValidMetadataUri rejects loopback and private IP literals", () => {
  assert.equal(isValidMetadataUri("http://169.254.169.254/latest/meta-data/"), false);
  assert.equal(isValidMetadataUri("https://169.254.169.254/latest/meta-data/"), false);
  assert.equal(isValidMetadataUri("https://127.0.0.1/metadata.json"), false);
  assert.equal(isValidMetadataUri("https://10.0.0.5/metadata.json"), false);
});

test("isValidMetadataUri rejects malformed input", () => {
  assert.equal(isValidMetadataUri("not a uri"), false);
  assert.equal(isValidMetadataUri(""), false);
});

// ===========================================================================
// formatAmount — basic cases
// ===========================================================================

test("formatAmount(0n) returns '0'", () => {
  assert.equal(formatAmount(0n), "0");
});

test("formatAmount(1n) returns '0.0000001' with 7 decimals", () => {
  assert.equal(formatAmount(1n), "0.0000001");
});

test("formatAmount(10_000_000n) returns '1' (1 USDC, 7 decimals)", () => {
  assert.equal(formatAmount(10_000_000n), "1");
});

test("formatAmount(12_500_000n) returns '1.25'", () => {
  assert.equal(formatAmount(12_500_000n), "1.25");
});

test("formatAmount(1_000_000_000n) returns '100'", () => {
  assert.equal(formatAmount(1_000_000_000n), "100");
});

test("formatAmount(9_999_999n) returns '0.9999999'", () => {
  assert.equal(formatAmount(9_999_999n), "0.9999999");
});

// ===========================================================================
// formatAmount — very large amounts (no floating-point loss)
// ===========================================================================

test("formatAmount handles 1_000_000_000_000_000_000n exactly", () => {
  // 10^18 atomic units with 7 decimals = 100_000_000_000 (100 billion)
  assert.equal(formatAmount(1_000_000_000_000_000_000n), "100000000000");
});

test("formatAmount handles amounts close to Number.MAX_SAFE_INTEGER without precision loss", () => {
  // 2^53 = 9_007_199_254_740_992 — would lose precision as a JS number,
  // but bigint handles it exactly.
  const bigAmount = 9_007_199_254_740_992n;
  const result = formatAmount(bigAmount);
  // Should not produce NaN, Infinity, or exponential notation
  assert.equal(result.includes("e"), false);
  assert.equal(result.includes("N"), false);
});

// ===========================================================================
// formatAmount — custom decimals
// ===========================================================================

test("formatAmount with 6 decimals (EVM-style USDC)", () => {
  assert.equal(formatAmount(1_000_000n, { decimals: 6 }), "1");
  assert.equal(formatAmount(1_500_000n, { decimals: 6 }), "1.5");
  assert.equal(formatAmount(1n, { decimals: 6 }), "0.000001");
});

test("formatAmount with 18 decimals (ERC-20 style)", () => {
  assert.equal(
    formatAmount(1_000_000_000_000_000_000n, { decimals: 18 }),
    "1",
  );
  assert.equal(
    formatAmount(1_500_000_000_000_000_000n, { decimals: 18 }),
    "1.5",
  );
});

test("formatAmount with 0 decimals returns integer string", () => {
  assert.equal(formatAmount(42n, { decimals: 0 }), "42");
  assert.equal(formatAmount(0n, { decimals: 0 }), "0");
});

// ===========================================================================
// formatAmount — precision option
// ===========================================================================

test("formatAmount precision=2 truncates fractional digits", () => {
  // 9_999_999_999n / 10^7 = 999.9999999; with precision=2 → "999.99"
  assert.equal(formatAmount(9_999_999_999n, { precision: 2 }), "999.99");
});

test("formatAmount precision=0 returns integer part only", () => {
  assert.equal(formatAmount(15_000_000n, { precision: 0 }), "1");
  assert.equal(formatAmount(19_999_999n, { precision: 0 }), "1");
});

test("formatAmount precision equal to decimals shows full fractional part", () => {
  assert.equal(formatAmount(12_345_678n, { decimals: 7, precision: 7 }), "1.2345678");
});

test("formatAmount precision greater than decimals behaves same as precision=decimals", () => {
  // precision > decimals: fracStr is already as long as decimals, not padded further
  assert.equal(
    formatAmount(12_500_000n, { decimals: 7, precision: 10 }),
    "1.25",
  );
});

test("formatAmount trailing zeros are stripped after precision truncation", () => {
  // 1.2300000 → after truncation to 7 and stripping → "1.23"
  assert.equal(formatAmount(12_300_000n), "1.23");
});

// ===========================================================================
// formatAmount — thousands grouping
// ===========================================================================

test("formatAmount group:true adds commas to integer part", () => {
  assert.equal(
    formatAmount(5_000_000_000_000n, { group: true, precision: 2 }),
    "500,000",
  );
});

test("formatAmount group:true on sub-thousand value adds no commas", () => {
  assert.equal(formatAmount(9_990_000n, { group: true }), "0.999");
});

test("formatAmount group:true on large integer", () => {
  assert.equal(
    formatAmount(1_000_000_000_000_000n, { group: true }),
    "100,000,000",
  );
});

// ===========================================================================
// formatAmount — negative amounts
// ===========================================================================

test("formatAmount negative amount prefixes with minus sign", () => {
  assert.equal(formatAmount(-10_000_000n), "-1");
  assert.equal(formatAmount(-1n), "-0.0000001");
});

// ===========================================================================
// formatAmount — error cases
// ===========================================================================

test("formatAmount throws RangeError for negative decimals", () => {
  assert.throws(
    () => formatAmount(1n, { decimals: -1 }),
    (err) => err instanceof RangeError,
  );
});

test("formatAmount throws RangeError for negative precision", () => {
  assert.throws(
    () => formatAmount(1n, { precision: -1 }),
    (err) => err instanceof RangeError,
  );
});

// ===========================================================================
// parseAmount — basic cases
// ===========================================================================

test("parseAmount('0') returns 0n", () => {
  assert.equal(parseAmount("0"), 0n);
});

test("parseAmount('1') returns 10_000_000n (7 decimals)", () => {
  assert.equal(parseAmount("1"), 10_000_000n);
});

test("parseAmount('0.0000001') returns 1n", () => {
  assert.equal(parseAmount("0.0000001"), 1n);
});

test("parseAmount('10.5', 7) returns 105_000_000n", () => {
  assert.equal(parseAmount("10.5", 7), 105_000_000n);
});

test("parseAmount('1000') returns 10_000_000_000n", () => {
  assert.equal(parseAmount("1000"), 10_000_000_000n);
});

test("parseAmount('1.2345678') returns 12_345_678n", () => {
  assert.equal(parseAmount("1.2345678"), 12_345_678n);
});

// ===========================================================================
// parseAmount — custom decimals
// ===========================================================================

test("parseAmount with 6 decimals: '1.5' → 1_500_000n", () => {
  assert.equal(parseAmount("1.5", 6), 1_500_000n);
});

test("parseAmount with 6 decimals: '1' → 1_000_000n", () => {
  assert.equal(parseAmount("1", 6), 1_000_000n);
});

test("parseAmount with 18 decimals: '1' → 1_000_000_000_000_000_000n", () => {
  assert.equal(parseAmount("1", 18), 1_000_000_000_000_000_000n);
});

test("parseAmount with 0 decimals: '42' → 42n", () => {
  assert.equal(parseAmount("42", 0), 42n);
});

// ===========================================================================
// parseAmount — integer-only inputs (no decimal point)
// ===========================================================================

test("parseAmount integer-only '500' with 7 decimals → 5_000_000_000n", () => {
  assert.equal(parseAmount("500"), 5_000_000_000n);
});

// ===========================================================================
// parseAmount — fractional inputs shorter than decimals (padded)
// ===========================================================================

test("parseAmount '0.1' with 7 decimals pads to '1000000n'", () => {
  assert.equal(parseAmount("0.1"), 1_000_000n);
});

test("parseAmount '0.01' with 7 decimals → 100_000n", () => {
  assert.equal(parseAmount("0.01"), 100_000n);
});

// ===========================================================================
// parseAmount — round-trip with formatAmount
// ===========================================================================

test("parseAmount(formatAmount(x)) round-trips correctly", () => {
  const amounts = [0n, 1n, 10_000_000n, 12_345_678n, 9_999_999_999n];
  for (const amt of amounts) {
    const formatted = formatAmount(amt);
    const parsed = parseAmount(formatted);
    assert.equal(parsed, amt, `round-trip failed for ${amt}: "${formatted}"`);
  }
});

// ===========================================================================
// parseAmount — error cases
// ===========================================================================

test("parseAmount throws TypeError for empty string", () => {
  assert.throws(
    () => parseAmount(""),
    (err) => err instanceof TypeError,
  );
});

test("parseAmount throws TypeError for whitespace-only string", () => {
  assert.throws(
    () => parseAmount("   "),
    (err) => err instanceof TypeError,
  );
});

test("parseAmount throws TypeError for negative input", () => {
  assert.throws(
    () => parseAmount("-1"),
    (err) => err instanceof TypeError,
  );
  assert.throws(
    () => parseAmount("-0.5"),
    (err) => err instanceof TypeError,
  );
});

test("parseAmount throws TypeError for invalid characters", () => {
  assert.throws(
    () => parseAmount("1abc"),
    (err) => err instanceof TypeError,
  );
  assert.throws(
    () => parseAmount("1,000"),
    (err) => err instanceof TypeError,
  );
  assert.throws(
    () => parseAmount("1e7"),
    (err) => err instanceof TypeError,
  );
});

test("parseAmount throws TypeError for multiple decimal points", () => {
  assert.throws(
    () => parseAmount("1.2.3"),
    (err) => err instanceof TypeError,
  );
});

test("parseAmount throws RangeError for fractional digits exceeding decimals", () => {
  // '0.12345678' has 8 fractional digits but 7 decimals
  assert.throws(
    () => parseAmount("0.12345678", 7),
    (err) => err instanceof RangeError,
  );
});

test("parseAmount throws RangeError for negative decimals", () => {
  assert.throws(
    () => parseAmount("1", -1),
    (err) => err instanceof RangeError,
  );
});

// ===========================================================================
// toBaseUnits / fromBaseUnits — round-trip for decimals 0-18
// ===========================================================================

test("toBaseUnits/fromBaseUnits round-trip for decimals 0 through 18", () => {
  for (let decimals = 0; decimals <= 18; decimals++) {
    const scale = 10n ** BigInt(decimals);
    const samples = [0n, 1n, scale, scale * 3n + 1n, scale * 123_456_789n];
    for (const base of samples) {
      const human = fromBaseUnits(base, decimals);
      const back = toBaseUnits(human, decimals);
      assert.equal(
        back,
        base,
        `round-trip failed for decimals=${decimals}, base=${base}, human="${human}"`,
      );
    }
  }
});

test("toBaseUnits uses exact BigInt math (no floating-point drift)", () => {
  // 10^30 with 18 decimals should be exactly 10^48 base units.
  const huge = 10n ** 30n;
  const base = toBaseUnits("1000000000000000000000000000000", 18);
  assert.equal(base, huge * 10n ** 18n);
  assert.equal(fromBaseUnits(base, 18), "1000000000000000000000000000000");
});

test("toBaseUnits handles fractional inputs exactly", () => {
  assert.equal(toBaseUnits("1.5", 6), 1_500_000n);
  assert.equal(toBaseUnits("0.0000001", 7), 1n);
  assert.equal(toBaseUnits("1.234567890123456789", 18), 1_234_567_890_123_456_789n);
  assert.equal(toBaseUnits("42", 0), 42n);
});

test("fromBaseUnits strips trailing zeros and handles zero decimals", () => {
  assert.equal(fromBaseUnits(0n, 7), "0");
  assert.equal(fromBaseUnits(1_500_000n, 6), "1.5");
  assert.equal(fromBaseUnits(42n, 0), "42");
  assert.equal(fromBaseUnits(1_000_000_000_000_000_000n, 18), "1");
});

test("toBaseUnits throws RangeError for invalid decimals", () => {
  assert.throws(
    () => toBaseUnits("1", -1),
    (err) => err instanceof RangeError,
  );
  assert.throws(
    () => toBaseUnits("1", 1.5),
    (err) => err instanceof RangeError,
  );
});

test("fromBaseUnits throws RangeError for invalid decimals", () => {
  assert.throws(
    () => fromBaseUnits(1n, -1),
    (err) => err instanceof RangeError,
  );
  assert.throws(
    () => fromBaseUnits(1n, 2.5),
    (err) => err instanceof RangeError,
  );
});

test("toBaseUnits throws TypeError for malformed input", () => {
  for (const bad of ["", "   ", "-1", "1abc", "1,000", "1e7", "1.2.3"]) {
    assert.throws(
      () => toBaseUnits(bad, 7),
      (err) => err instanceof TypeError,
      `expected TypeError for "${bad}"`,
    );
  }
});

test("toBaseUnits throws RangeError when fractional digits exceed decimals", () => {
  assert.throws(
    () => toBaseUnits("0.12345678", 7),
    (err) => err instanceof RangeError,
  );
});

// ===========================================================================
// TokenRegistry — caching of get_token_info
// ===========================================================================

test("TokenRegistry caches decimals per token address", async () => {
  const calls: string[] = [];
  const registry = new TokenRegistry(async (address: string) => {
    calls.push(address);
    return { address, decimals: 6 };
  });

  const first = await registry.toBaseUnits("1.5", "TOKEN_A");
  const second = await registry.toBaseUnits("2", "TOKEN_A");
  const third = await registry.fromBaseUnits(1_500_000n, "TOKEN_A");

  assert.equal(first, 1_500_000n);
  assert.equal(second, 2_000_000n);
  assert.equal(third, "1.5");
  assert.equal(calls.length, 1, "fetcher should be called once per address");
  assert.deepEqual(calls, ["TOKEN_A"]);
});

test("TokenRegistry fetches decimals separately for distinct tokens", async () => {
  const calls: string[] = [];
  const decimalsByAddress: Record<string, number> = {
    TOKEN_A: 6,
    TOKEN_B: 18,
  };
  const registry = new TokenRegistry(async (address: string) => {
    calls.push(address);
    return { address, decimals: decimalsByAddress[address] };
  });

  assert.equal(await registry.toBaseUnits("1", "TOKEN_A"), 1_000_000n);
  assert.equal(await registry.toBaseUnits("1", "TOKEN_B"), 1_000_000_000_000_000_000n);
  // Repeat to confirm cache reuse.
  assert.equal(await registry.toBaseUnits("1", "TOKEN_A"), 1_000_000n);
  assert.equal(await registry.toBaseUnits("1", "TOKEN_B"), 1_000_000_000_000_000_000n);

  assert.deepEqual(calls, ["TOKEN_A", "TOKEN_B"]);
});

test("TokenRegistry deduplicates concurrent fetches for the same token", async () => {
  let calls = 0;
  const registry = new TokenRegistry(async (address: string) => {
    calls++;
    return { address, decimals: 7 };
  });

  const results = await Promise.all([
    registry.toBaseUnits("1", "TOKEN_A"),
    registry.toBaseUnits("1", "TOKEN_A"),
    registry.toBaseUnits("1", "TOKEN_A"),
  ]);

  assert.deepEqual(results, [10_000_000n, 10_000_000n, 10_000_000n]);
  assert.equal(calls, 1);
});

test("TokenRegistry propagates fetcher errors and does not cache failures", async () => {
  let calls = 0;
  const registry = new TokenRegistry(async (address: string) => {
    calls++;
    if (calls === 1) {
      throw new Error("rpc unavailable");
    }
    return { address, decimals: 6 };
  });

  await assert.rejects(() => registry.toBaseUnits("1", "TOKEN_A"), /rpc unavailable/);
  assert.equal(await registry.toBaseUnits("1", "TOKEN_A"), 1_000_000n);
  assert.equal(calls, 2);
});

test("TokenRegistry rejects tokens with invalid decimals", async () => {
  const registry = new TokenRegistry(async (address: string) => ({
    address,
    decimals: -1,
  }));

  await assert.rejects(
    () => registry.toBaseUnits("1", "TOKEN_A"),
    (err) => err instanceof RangeError,
  );
});
