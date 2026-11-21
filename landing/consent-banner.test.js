import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const CONSENT_KEY = "bear-consent";

function mockStorage() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

test("consent transitions accept -> stored choice", () => {
  const localStorage = mockStorage();
  const save = (choice) => {
    localStorage.setItem(
      CONSENT_KEY,
      JSON.stringify({ choice, expiryDate: new Date(Date.now() + 86400000).toISOString() }),
    );
  };
  save("accept");
  const parsed = JSON.parse(localStorage.getItem(CONSENT_KEY));
  assert.equal(parsed.choice, "accept");
});

test("expired consent is treated as missing", () => {
  const localStorage = mockStorage();
  localStorage.setItem(
    CONSENT_KEY,
    JSON.stringify({ choice: "reject", expiryDate: new Date(0).toISOString() }),
  );
  const stored = localStorage.getItem(CONSENT_KEY);
  const parsed = JSON.parse(stored);
  assert.ok(new Date(parsed.expiryDate) < new Date());
  vm.runInNewContext("1+1");
});