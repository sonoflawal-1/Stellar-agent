import assert from "node:assert/strict";
import test from "node:test";
import { parseAllowedOrigins } from "./origins.js";

test("warns for empty trailing and malformed origin entries", () => {
  const warnings: string[] = [];
  const origins = parseAllowedOrigins(
    {
      ALLOWED_ORIGINS: "https://app.example.com, ,https://app.example.com/path,",
      ALLOWED_ORIGIN: "",
    },
    (message) => warnings.push(message),
  );

  assert.ok(origins.includes("https://app.example.com"));
  assert.equal(warnings.length, 4);
});

test("fails in production when an origin entry is empty or malformed", () => {
  assert.throws(
    () =>
      parseAllowedOrigins(
        { NODE_ENV: "production", ALLOWED_ORIGINS: "https://app.example.com," },
        () => {},
      ),
    /Invalid CORS origin configuration/,
  );
});
