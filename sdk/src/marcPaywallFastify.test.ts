import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { marcPaywallFastify } from "./marcPaywallFastify.js";

// marcPaywallFastify() wraps @x402/express's paymentMiddleware around the raw
// Node req/res objects Fastify exposes as request.raw/reply.raw. Build minimal
// Express-shaped stand-ins for those so the wrapped middleware (which expects
// req.header()/req.path/... and res.status()/res.json()/...) can run without a
// real Fastify server.
function fakeRawRequest(opts: { method?: string; headers?: Record<string, string> } = {}) {
  const headers = opts.headers ?? {};
  return {
    method: opts.method ?? "GET",
    protocol: "http",
    path: "/api/work",
    originalUrl: "/api/work",
    query: {},
    body: undefined,
    headers: { host: "localhost:4410", ...headers },
    header(name: string) {
      return headers[name] ?? headers[name.toLowerCase()];
    },
  };
}

function fakeRawResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let ended = false;
  let body: unknown;
  const res = {
    get statusCode() {
      return statusCode;
    },
    get ended() {
      return ended;
    },
    get body() {
      return body;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return res;
    },
    getHeader(name: string) {
      return headers[name];
    },
    getHeaders() {
      return { ...headers };
    },
    removeHeader(name: string) {
      delete headers[name];
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res.end(JSON.stringify(payload));
    },
    send(payload: unknown) {
      body = payload;
      return res.end(payload);
    },
    writeHead(code: number) {
      statusCode = code;
      return res;
    },
    write(chunk: unknown) {
      body = chunk;
      return true;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) body = chunk;
      ended = true;
      return res;
    },
    flushHeaders() {
      /* no-op */
    },
  };
  return { res, headers };
}

// marcPaywallFastify() (via x402ResourceServer) fetches the facilitator's
// /supported endpoint on first use, and hits /verify and /settle once a
// payment header is presented. Stub all three so tests run offline.
const originalFetch = globalThis.fetch;

function stubFacilitatorFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
      return new Response(JSON.stringify({ isValid: true, payer: Keypair.random().publicKey() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/settle")) {
      return new Response(
        JSON.stringify({ success: true, transaction: "deadbeef", network: "stellar:testnet" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

test("marcPaywallFastify returns a Fastify preHandler hook", async () => {
  stubFacilitatorFetch();
  try {
    const hook = marcPaywallFastify({ payTo: Keypair.random().publicKey(), price: "$0.01" });
    assert.equal(typeof hook, "function");
    await flush();
  } finally {
    restoreFetch();
  }
});

test("marcPaywallFastify sends a 402 with payment requirements when no payment header is present", async () => {
  stubFacilitatorFetch();
  try {
    const hook = marcPaywallFastify({ payTo: Keypair.random().publicKey(), price: "$0.01" });
    const { res } = fakeRawResponse();
    const request = { raw: fakeRawRequest() };
    const reply = { raw: res };

    await hook(request, reply);
    await flush();

    assert.equal(res.statusCode, 402);
    const paymentRequiredHeader = res.getHeader("PAYMENT-REQUIRED");
    assert.equal(typeof paymentRequiredHeader, "string");
    const decoded = decodePaymentRequiredHeader(paymentRequiredHeader as string) as {
      accepts: Array<{ scheme: string; network: string }>;
    };
    assert.equal(decoded.accepts[0]?.scheme, "exact");
    assert.equal(decoded.accepts[0]?.network, "stellar:testnet");
  } finally {
    restoreFetch();
  }
});

test("marcPaywallFastify passes the request through once a valid payment header is provided", async () => {
  stubFacilitatorFetch();
  try {
    const opts = { payTo: Keypair.random().publicKey(), price: "$0.01" };

    // First, an unpaid request to learn the exact payment requirements the
    // server will demand (mirrors how a real client discovers them).
    const challengeHook = marcPaywallFastify(opts);
    const { res: challengeRes } = fakeRawResponse();
    await challengeHook({ raw: fakeRawRequest() }, { raw: challengeRes });
    await flush();
    const accepted = (
      decodePaymentRequiredHeader(challengeRes.getHeader("PAYMENT-REQUIRED") as string) as {
        accepts: Array<Record<string, unknown>>;
      }
    ).accepts[0];

    // Build a syntactically valid PAYMENT-SIGNATURE header echoing those
    // requirements back (facilitator verification itself is stubbed above).
    const paymentPayload = {
      x402Version: 2,
      accepted,
      payload: { transaction: "stub-signed-xdr" },
    };
    const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

    const hook = marcPaywallFastify(opts);
    const { res } = fakeRawResponse();
    const request = { raw: fakeRawRequest({ headers: { "payment-signature": paymentHeader } }) };
    const reply = { raw: res };

    let downstreamReached = false;
    await hook(request, reply).then(() => {
      // Reaching here means the middleware called `next()` — i.e. the
      // request was let through rather than short-circuited with a 402.
      downstreamReached = true;
    });

    assert.equal(downstreamReached, true);
    assert.notEqual(res.statusCode, 402);

    // Simulate the downstream route handler completing the response; the
    // middleware buffers writes until settlement finishes.
    res.end(JSON.stringify({ ok: true }));
    await flush();

    assert.equal(res.ended, true);
  } finally {
    restoreFetch();
  }
});
