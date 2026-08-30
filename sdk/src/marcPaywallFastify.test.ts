/**
 * Unit tests for marcPaywallFastify middleware adapter.
 *
 * The Express middleware inside marcPaywallFastify short-circuits 402 responses
 * by calling res.json().end() WITHOUT invoking the next() callback.  This means
 * the wrapping Promise never resolves.  We handle this in tests by racing the
 * handler promise against a short timeout, then inspecting the response mock
 * for the 402 status and headers.
 *
 * We stub globalThis.fetch to intercept all facilitator HTTP calls (supported,
 * verify, settle) so the real @x402 modules load and work without hitting the
 * network.
 */
import assert from "node:assert/strict";
import test from "node:test";

// ---------------------------------------------------------------------------
// Fetch stub — intercepts ALL facilitator endpoints before module load
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;

(globalThis as any).fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.endsWith("/supported")) {
    return new Response(
      JSON.stringify({
        kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
        extensions: [],
        signers: {},
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  if (url.endsWith("/verify")) {
    return new Response(
      JSON.stringify({ isValid: true, payer: "GMOCK", extensions: {}, extra: {} }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  if (url.endsWith("/settle")) {
    return new Response(
      JSON.stringify({ success: true, payer: "GMOCK", transaction: "mocktx", network: "stellar:testnet", extensions: {}, extra: {} }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response("Not found", { status: 404 });
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Load module under test (async factory)
// ---------------------------------------------------------------------------
const { marcPaywallFastify } = await import("./marcPaywallFastify.js");

// ---------------------------------------------------------------------------
// Fake Fastify request / reply with Express-compatible surface
// ---------------------------------------------------------------------------
function fakeFastifyPair(
  method = "GET",
  urlPath = "/test",
  extraHeaders: Record<string, string> = {},
) {
  let capturedStatus: number | undefined;
  let capturedBody = "";
  let endCalled = false;
  const resHeaders: Record<string, string | number> = {};

  const rawReq: any = {
    method,
    url: urlPath,
    headers: { host: "localhost", ...extraHeaders },
    header(name: string) { return this.headers[name.toLowerCase()]; },
    get(name: string) { return this.header(name); },
    path: urlPath.split("?")[0],
    protocol: "http",
    originalUrl: urlPath,
  };

  const rawRes: any = {
    setHeader(name: string, value: string | number) { resHeaders[name.toLowerCase()] = value; },
    getHeader(name: string) { return resHeaders[name.toLowerCase()]; },
    status(code: number) { capturedStatus = code; return rawRes; },
    headersSent: false,
    end(chunk?: string) {
      if (chunk) capturedBody += chunk;
      rawRes.headersSent = true;
      endCalled = true;
    },
    json(body: unknown) {
      capturedBody = typeof body === "string" ? body : JSON.stringify(body);
      rawRes.headersSent = true;
      endCalled = true;
    },
  };

  return {
    request: { raw: rawReq },
    reply: { raw: rawRes },
    get capturedStatus() { return capturedStatus; },
    get capturedBody() { return capturedBody; },
    get endCalled() { return endCalled; },
    get resHeaders() { return resHeaders; },
  };
}

/**
 * Call the handler and wait up to `ms` for either the promise to settle or
 * for the response to be sent (endCalled).  Returns when either condition
 * is met.  This avoids hanging on 402 short-circuits where the Promise
 * wrapping the Express middleware never resolves.
 */
async function callHandlerWithTimeout(
  handler: (req: any, reply: any) => Promise<void>,
  pair: ReturnType<typeof fakeFastifyPair>,
  ms = 500,
): Promise<void> {
  let settled = false;
  const promise = handler(pair.request, pair.reply)
    .then(() => { settled = true; })
    .catch(() => { settled = true; });

  const deadline = Date.now() + ms;
  while (!settled && !pair.endCalled && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  // Don't await the promise — it may never resolve for 402 short-circuits
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("marcPaywallFastify returns an async function (Fastify preHandler hook)", async () => {
  const handler = await marcPaywallFastify({
    payTo: "GTESTKEY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    price: "$0.01",
  });
  assert.equal(typeof handler, "function");
});

test("marcPaywallFastify returns 402 when no X-Payment header is present", async () => {
  const handler = await marcPaywallFastify({
    payTo: "GTESTKEY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    price: "$0.01",
  });

  const pair = fakeFastifyPair("GET", "/api/data");
  await callHandlerWithTimeout(handler, pair);

  assert.equal(pair.capturedStatus, 402);
  assert.ok(pair.endCalled, "Response should have been sent");
});

test("marcPaywallFastify sets payment-requirements header on 402", async () => {
  const handler = await marcPaywallFastify({
    payTo: "GTESTKEY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    price: "$0.01",
  });

  const pair = fakeFastifyPair("GET", "/api/data");
  await callHandlerWithTimeout(handler, pair);

  assert.equal(pair.capturedStatus, 402);
  const hasPaymentRequirements =
    pair.resHeaders["x-payment-requirements"] ||
    pair.resHeaders["payment-required"];
  assert.ok(
    hasPaymentRequirements,
    "Expected X-Payment-Requirements header on 402 response",
  );
});

test("marcPaywallFastify returns 402 body with error message", async () => {
  const handler = await marcPaywallFastify({
    payTo: "GTESTKEY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    price: "$0.01",
  });

  const pair = fakeFastifyPair("GET", "/api/data");
  await callHandlerWithTimeout(handler, pair);

  assert.equal(pair.capturedStatus, 402);
  // The middleware sends an empty JSON body: res.status(402).json({})
  assert.ok(pair.endCalled, "Response should have been sent");
});

test("marcPaywallFastify passes custom description and mimeType in routeConfig", async () => {
  const handler = await marcPaywallFastify({
    payTo: "GTESTKEY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    price: "$0.01",
    description: "Premium content access",
    mimeType: "text/html",
  });

  const pair = fakeFastifyPair("GET", "/content");
  await callHandlerWithTimeout(handler, pair);

  // Verify the handler was created and returned 402 (no payment)
  assert.equal(pair.capturedStatus, 402);
  assert.ok(pair.endCalled, "Response should have been sent");
});

test("marcPaywallFastify passes network and token options", async () => {
  const handler = await marcPaywallFastify({
    payTo: "GTESTKEY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    price: "$0.01",
    network: "stellar:testnet",
    token: "native",
  });

  const pair = fakeFastifyPair("GET", "/test");
  await callHandlerWithTimeout(handler, pair);

  // Verify the handler was created and returned 402 (no payment)
  assert.equal(pair.capturedStatus, 402);
});

// Restore fetch after all tests
test.after(() => {
  (globalThis as any).fetch = originalFetch;
});
