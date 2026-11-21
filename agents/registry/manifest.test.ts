import assert from "node:assert/strict";
import test from "node:test";
import { validateManifest, calculateReputation } from "./server.js";
import { AgentStore } from "./store.js";

const STORE_MANIFEST = {
  id: "seller-store",
  name: "Store Test Agent",
  description: "Agent used to exercise registry persistence",
  url: "https://store.example.com",
  price_usdc: 2,
  wallet: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5K",
  tags: ["test"],
};

const VALID_MANIFEST = {
  id: "seller-test",
  name: "Test Seller Agent",
  description: "Automated test agent for validation suites",
  url: "https://agent.example.com",
  price_usdc: 1.5,
  wallet: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5K",
  tags: ["test", "ai", "soroban"],
};

test("validateManifest - accepts a valid complete manifest", () => {
  const result = validateManifest(VALID_MANIFEST);
  assert.equal(result, null);
});

test("validateManifest - accepts a valid manifest without optional tags", () => {
  const { tags, ...withoutTags } = VALID_MANIFEST;
  const result = validateManifest(withoutTags);
  assert.equal(result, null);
});

test("validateManifest - accepts a valid manifest with empty tags array", () => {
  const result = validateManifest({ ...VALID_MANIFEST, tags: [] });
  assert.equal(result, null);
});

test("validateManifest - rejects non-object or null input", () => {
  assert.equal(validateManifest(null), "manifest must be a JSON object");
  assert.equal(validateManifest(undefined), "manifest must be a JSON object");
  assert.equal(validateManifest("string"), "manifest must be a JSON object");
  assert.equal(validateManifest(123), "manifest must be a JSON object");
  assert.equal(validateManifest(true), "manifest must be a JSON object");
  assert.equal(validateManifest([]), "manifest must be a JSON object");
});

test("validateManifest - rejects missing or empty required string fields", () => {
  const requiredFields = ["id", "name", "description", "url"] as const;

  for (const field of requiredFields) {
    // Missing field
    const missing = { ...VALID_MANIFEST };
    delete (missing as Record<string, unknown>)[field];
    assert.equal(
      validateManifest(missing),
      `field "${field}" must be a non-empty string`,
      `Should reject missing ${field}`,
    );

    // Empty string
    const empty = { ...VALID_MANIFEST, [field]: "" };
    assert.equal(
      validateManifest(empty),
      `field "${field}" must be a non-empty string`,
      `Should reject empty ${field}`,
    );

    // Whitespace only
    const whitespace = { ...VALID_MANIFEST, [field]: "   " };
    assert.equal(
      validateManifest(whitespace),
      `field "${field}" must be a non-empty string`,
      `Should reject whitespace-only ${field}`,
    );

    // Non-string type
    const nonString = { ...VALID_MANIFEST, [field]: 12345 };
    assert.equal(
      validateManifest(nonString),
      `field "${field}" must be a non-empty string`,
      `Should reject non-string ${field}`,
    );
  }
});

test("validateManifest - rejects invalid URL formats", () => {
  const invalidUrls = [
    "ftp://example.com",
    "file:///path/to/agent",
    "not-a-url",
    "htp://misspelled.com",
    "http:/missing-slash.com",
    "https:",
  ];

  for (const url of invalidUrls) {
    const result = validateManifest({ ...VALID_MANIFEST, url });
    assert.equal(result, 'field "url" must be a valid HTTP/HTTPS URL', `Should reject url: ${url}`);
  }

  // Valid URLs should pass
  assert.equal(validateManifest({ ...VALID_MANIFEST, url: "http://localhost:4501" }), null);
  assert.equal(validateManifest({ ...VALID_MANIFEST, url: "https://seller.example.com/api" }), null);
});

test("validateManifest - rejects negative, zero, or non-numeric price_usdc", () => {
  const invalidPrices = [
    0,
    -1,
    -0.001,
    "1.5",
    null,
    undefined,
    NaN,
    {},
    [],
  ];

  for (const price of invalidPrices) {
    const result = validateManifest({ ...VALID_MANIFEST, price_usdc: price });
    assert.equal(
      result,
      'field "price_usdc" must be a positive number',
      `Should reject price_usdc: ${price}`,
    );
  }

  // Valid positive prices should pass
  assert.equal(validateManifest({ ...VALID_MANIFEST, price_usdc: 0.01 }), null);
  assert.equal(validateManifest({ ...VALID_MANIFEST, price_usdc: 100 }), null);
});

test("validateManifest - rejects invalid Stellar public key format", () => {
  // Missing or non-string wallet
  assert.equal(
    validateManifest({ ...VALID_MANIFEST, wallet: "" }),
    'field "wallet" must be a non-empty string',
  );
  assert.equal(
    validateManifest({ ...VALID_MANIFEST, wallet: "   " }),
    'field "wallet" must be a non-empty string',
  );
  assert.equal(
    validateManifest({ ...VALID_MANIFEST, wallet: 12345 }),
    'field "wallet" must be a non-empty string',
  );

  // Invalid key formats: starts with S (secret key)
  const secretKey = "SB42EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE";
  assert.equal(
    validateManifest({ ...VALID_MANIFEST, wallet: secretKey }),
    'field "wallet" must be a valid Stellar public key (starts with G, 56 chars)',
  );

  // Starts with C (contract id)
  const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(
    validateManifest({ ...VALID_MANIFEST, wallet: contractId }),
    'field "wallet" must be a valid Stellar public key (starts with G, 56 chars)',
  );

  // Too short
  assert.equal(
    validateManifest({ ...VALID_MANIFEST, wallet: "GBUQWP3BOUZX34ULNQG23RQ6F4" }),
    'field "wallet" must be a valid Stellar public key (starts with G, 56 chars)',
  );

  // Too long
  assert.equal(
    validateManifest({
      ...VALID_MANIFEST,
      wallet: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5KEXTRA",
    }),
    'field "wallet" must be a valid Stellar public key (starts with G, 56 chars)',
  );

  // Invalid Base32 characters (0, 1, 8, 9 are not in RFC 4648 Base32)
  const invalidBase32Wallet = "G0189P3BOUZX34ULNQG23RQ6F4YUSXHTBVDJ42LPBK4EK4YLYL2QQ5K8";
  assert.equal(
    validateManifest({ ...VALID_MANIFEST, wallet: invalidBase32Wallet }),
    'field "wallet" must be a valid Stellar public key (starts with G, 56 chars)',
  );
});

test("validateManifest - rejects malformed tags array", () => {
  const invalidTags = [
    "not-an-array",
    123,
    { tag: "test" },
    ["valid", 123],
    [null],
    ["valid", undefined],
    ["valid", {}],
  ];

  for (const tags of invalidTags) {
    const result = validateManifest({ ...VALID_MANIFEST, tags });
    assert.equal(
      result,
      'field "tags" must be an array of strings',
      `Should reject tags: ${JSON.stringify(tags)}`,
    );
  }
});

test("calculateReputation - handles new agents with 0 jobs gracefully (displays N/A)", () => {
  const reputation = calculateReputation([]);
  assert.deepEqual(reputation, {
    total_jobs: 0,
    completed_jobs: 0,
    disputed_jobs: 0,
    success_rate: "N/A",
  });
});

test("calculateReputation - correctly computes total, completed, disputed, and success_rate", () => {
  const jobs = [
    { status: "Completed" },
    { status: "Completed" },
    { status: "Completed" },
    { status: "Disputed" },
  ];
  const reputation = calculateReputation(jobs);
  assert.equal(reputation.total_jobs, 4);
  assert.equal(reputation.completed_jobs, 3);
  assert.equal(reputation.disputed_jobs, 1);
  assert.equal(reputation.success_rate, "75%");
});

test("calculateReputation - supports numeric enum status values (3=Completed, 6=Disputed)", () => {
  const jobs = [
    { status: 3 }, // Completed
    { status: 3 }, // Completed
    { status: 5 }, // Cancelled
    { status: 6 }, // Disputed
    { status: 1 }, // Funded
  ];
  const reputation = calculateReputation(jobs);
  assert.equal(reputation.total_jobs, 5);
  assert.equal(reputation.completed_jobs, 2);
  assert.equal(reputation.disputed_jobs, 1);
  assert.equal(reputation.success_rate, "40%");
});

test("calculateReputation - handles 100% success rate correctly", () => {
  const jobs = [{ status: "Completed" }, { status: "Completed" }];
  const reputation = calculateReputation(jobs);
  assert.equal(reputation.total_jobs, 2);
  assert.equal(reputation.completed_jobs, 2);
  assert.equal(reputation.disputed_jobs, 0);
  assert.equal(reputation.success_rate, "100%");
});

test("AgentStore - registrations survive a store reload (restart persistence)", () => {
  const path = ":memory:";
  const first = new AgentStore(path);
  first.register(STORE_MANIFEST);
  first.close();

  // Simulate a process restart by opening a fresh store over the same data.
  const second = new AgentStore(path);
  const stored = second.get(STORE_MANIFEST.id);
  assert.ok(stored, "registration should be present after reload");
  assert.equal(stored?.manifest.name, STORE_MANIFEST.name);
  assert.equal(stored?.manifest.url, STORE_MANIFEST.url);
  second.close();
});

test("AgentStore - hides agents whose heartbeat exceeds the TTL from discovery", () => {
  const store = new AgentStore(":memory:", { ttlMs: 1000 });
  store.register(STORE_MANIFEST);

  const fresh = store.discover();
  assert.equal(fresh.length, 1, "fresh agent should be discoverable");

  // Advance the clock past the TTL without sending a heartbeat.
  const stale = store.discover(Date.now() + 5000);
  assert.equal(stale.length, 0, "stale agent should be hidden from discovery");
  assert.equal(store.get(STORE_MANIFEST.id)?.status, "offline");

  // A heartbeat brings the agent back online.
  store.heartbeat(STORE_MANIFEST.id);
  assert.equal(store.discover().length, 1, "agent should reappear after heartbeat");
  store.close();
});
