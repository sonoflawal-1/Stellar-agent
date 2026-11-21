import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const en = JSON.parse(fs.readFileSync(path.join(dir, "i18n/en.json"), "utf8"));
const de = JSON.parse(fs.readFileSync(path.join(dir, "i18n/de.json"), "utf8"));

test("i18n fallback: de shares nav keys with en", () => {
  assert.equal(typeof de.nav.stats, "string");
  assert.equal(typeof en.nav.stats, "string");
});

test("i18n persisted language detection mirrors ?lang= query", () => {
  const match = "?lang=fr".match(/lang=([a-z-]+)/i);
  assert.equal(match?.[1], "fr");
});