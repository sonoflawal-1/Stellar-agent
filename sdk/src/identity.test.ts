import assert from "node:assert/strict";
import test from "node:test";
import { IdentityClient } from "./identity.js";
import { TESTNET } from "./types.js";

test("IdentityClient exposes the expected method signatures", () => {
  const client = new IdentityClient({
    ...TESTNET,
    rpcUrl: "https://example.invalid",
  });

  assert.equal(typeof client.register, "function");
  assert.equal(typeof client.getAgent, "function");
  assert.equal(typeof client.agentOf, "function");
  assert.equal(typeof client.updateUri, "function");
  assert.equal(typeof client.updateOwner, "function");
  assert.equal(typeof client.deregister, "function");
  assert.equal(typeof client.disconnect, "function");

  client.disconnect();
});
