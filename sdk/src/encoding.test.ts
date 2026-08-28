import assert from "node:assert/strict";
import test from "node:test";
import { Address, Keypair, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";

test("nativeToScVal and scValToNative round-trip strings and bigints", () => {
  const value = "ipfs://agent.json";
  const scVal = nativeToScVal(value, { type: "string" });
  assert.equal(scValToNative(scVal), value);

  const bigintVal = 42n;
  const bigintScVal = nativeToScVal(bigintVal, { type: "u64" });
  assert.equal(scValToNative(bigintScVal), 42n);
});

test("Address toScVal preserves Stellar address format", () => {
  const address = new Address(Keypair.random().publicKey());
  const scVal = address.toScVal();
  assert.equal(typeof scVal, "object");
});
