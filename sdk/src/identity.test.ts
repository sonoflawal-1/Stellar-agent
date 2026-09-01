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

test('IdentityClient exposes getAgentByOwner method', () => {
  const client = new IdentityClient({
    ...TESTNET,
    rpcUrl: 'https://example.invalid',
  });

  assert.equal(typeof client.getAgentByOwner, 'function');

  client.disconnect();
});

test('getAgentByOwner returns null when agentOf returns null', async () => {
  const client = new IdentityClient({
    ...TESTNET,
    rpcUrl: 'https://example.invalid',
  });

  // Mock agentOf to return null (owner not registered)
  (client as any).agentOf = async (_addr: string) => null;

  const result = await client.getAgentByOwner('GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5K');
  assert.equal(result, null);

  client.disconnect();
});

test('getAgentByOwner returns Agent when agentOf returns an id', async () => {
  const client = new IdentityClient({
    ...TESTNET,
    rpcUrl: 'https://example.invalid',
  });

  const mockAgent = { id: 42n, owner: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5K', uri: 'https://ipfs.example/agent.json' };

  // Mock both methods
  (client as any).agentOf = async (_addr: string) => 42n;
  (client as any).getAgent = async (_id: bigint) => mockAgent;

  const result = await client.getAgentByOwner('GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5K');
  assert.deepEqual(result, mockAgent);

  client.disconnect();
});
