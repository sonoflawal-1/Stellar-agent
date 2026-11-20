import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONTRACT_ERRORS, BearContractError } from "./errors";

/**
 * Parse the `Error` enum from a Rust contract source file.
 *
 * The enum is expected to look like:
 *
 * ```rust
 * #[contracterror]
 * #[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
 * #[repr(u32)]
 * pub enum Error {
 *     AlreadyInitialized = 1,
 *     NotAuthorized = 2,
 *     ...
 * }
 * ```
 *
 * Returns a map of variant name -> numeric code.
 */
function parseErrorEnum(source: string): Map<string, number> {
  const enumMatch = source.match(/enum\s+Error\s*\{([\s\S]*?)\}/);
  if (!enumMatch) {
    throw new Error("Could not locate `enum Error` in contract source");
  }

  const body = enumMatch[1];
  const variants = new Map<string, number>();

  // Match `Name = <number>` entries, ignoring comments.
  const variantRegex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*,?\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = variantRegex.exec(body)) !== null) {
    const name = match[1];
    const code = Number(match[2]);
    variants.set(name, code);
  }

  return variants;
}

function readContractErrorEnum(relativePath: string): Map<string, number> {
  const absolutePath = resolve(__dirname, "..", "..", relativePath);
  const source = readFileSync(absolutePath, "utf8");
  return parseErrorEnum(source);
}

describe("CONTRACT_ERRORS drift test", () => {
  const contractPaths = [
    "contracts/agentic-commerce/src/lib.rs",
    "contracts/agent-identity/src/lib.rs",
  ];

  it.each(contractPaths)(
    "matches the Error enum in %s",
    (relativePath) => {
      const variants = readContractErrorEnum(relativePath);

      // Sanity check: the parser should have found at least one variant.
      expect(variants.size).toBeGreaterThan(0);

      // Every variant in the contract must appear in CONTRACT_ERRORS with the
      // matching numeric code and name.
      for (const [name, code] of variants.entries()) {
        const entry = CONTRACT_ERRORS[code];
        expect(entry, `Missing CONTRACT_ERRORS entry for ${name} = ${code}`).toBeDefined();
        expect(entry.code).toBe(code);
        expect(entry.name).toBe(name);
      }

      // The map must not contain extra entries beyond what the contract defines.
      const contractCodes = new Set(variants.values());
      for (const key of Object.keys(CONTRACT_ERRORS)) {
        const numericKey = Number(key);
        expect(
          contractCodes.has(numericKey),
          `CONTRACT_ERRORS has extra entry ${key} not present in ${relativePath}`,
        ).toBe(true);
      }
    },
  );
});

describe("BearContractError", () => {
  it("parses `Error(Contract, #n)` strings and attaches .code/.name", () => {
    const err = new BearContractError("Error(Contract, #2)");

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BearContractError);
    expect(err.code).toBe(2);
    expect(err.name).toBe(CONTRACT_ERRORS[2].name);
    expect(err.message).toContain("Error(Contract, #2)");
  });

  it("parses codes with surrounding text", () => {
    const err = new BearContractError(
      "HostError: Error(Contract, #5) occurred during simulation",
    );

    expect(err.code).toBe(5);
    expect(err.name).toBe(CONTRACT_ERRORS[5].name);
  });

  it("falls back gracefully for unknown codes", () => {
    const err = new BearContractError("Error(Contract, #9999)");

    expect(err.code).toBe(9999);
    expect(err.name).toBe("UnknownContractError");
  });

  it("falls back gracefully when no code is present", () => {
    const err = new BearContractError("some unrelated failure");

    expect(err.code).toBeUndefined();
    expect(err.name).toBe("BearContractError");
    expect(err.message).toBe("some unrelated failure");
  });

  it("wraps a raw error and preserves the original as cause", () => {
    const raw = new Error("Error(Contract, #3)");
    const err = BearContractError.from(raw);

    expect(err).toBeInstanceOf(BearContractError);
    expect(err.code).toBe(3);
    expect(err.name).toBe(CONTRACT_ERRORS[3].name);
    expect(err.cause).toBe(raw);
    expect(err.message).toContain("Error(Contract, #3)");
  });

  it("wraps a raw error without a contract code", () => {
    const raw = new Error("network timeout");
    const err = BearContractError.from(raw);

    expect(err).toBeInstanceOf(BearContractError);
    expect(err.code).toBeUndefined();
    expect(err.name).toBe("BearContractError");
    expect(err.cause).toBe(raw);
    expect(err.message).toContain("network timeout");
  });

  it("returns the same instance when wrapping an existing BearContractError", () => {
    const original = new BearContractError("Error(Contract, #1)");
    const wrapped = BearContractError.from(original);

    expect(wrapped).toBe(original);
  });
});