import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { marcPaywall } from "./marcPaywall.js";

// marcPaywall() eagerly kicks off a background request to the facilitator's
// /supported endpoint (x402ResourceServer's syncFacilitatorOnStart default).
// Stub fetch so that call resolves locally instead of hitting the real
// network and leaking an unhandled rejection once the test has finished.
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
    return originalFetch(input, init);
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function fakeResponse() {
  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  let ended = false;
  const res = {
    headers,
    get statusCode() {
      return statusCode;
    },
    get ended() {
      return ended;
    },
    setHeader(key: string, value: string) {
      headers[key] = value;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    end() {
      ended = true;
    },
  };
  return res;
}

// Give the stubbed background facilitator fetch a turn to settle before the
// test (and its fetch stub) tears down.
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

test("marcPaywall returns an Express-style request handler", async () => {
  stubFacilitatorFetch();
  try {
    const handler = marcPaywall({ payTo: Keypair.random().publicKey(), price: "$0.01" });
    assert.equal(typeof handler, "function");
    await flush();
  } finally {
    restoreFetch();
  }
});

test("marcPaywall short-circuits CORS preflight requests without invoking the payment check", async () => {
  stubFacilitatorFetch();
  try {
    const handler = marcPaywall({ payTo: Keypair.random().publicKey(), price: "$0.01" });
    const req = { method: "OPTIONS", headers: { origin: "https://buyer.example" } };
    const res = fakeResponse();
    let nextCalled = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (handler as any)(req, res, () => {
      nextCalled = true;
    });

    assert.equal(res.statusCode, 204);
    assert.equal(res.ended, true);
    assert.equal(nextCalled, false);
    assert.equal(res.headers["Access-Control-Allow-Origin"], "https://buyer.example");
    assert.equal(
      res.headers["Access-Control-Allow-Methods"],
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    assert.equal(
      res.headers["Access-Control-Allow-Headers"],
      "Content-Type, Authorization, X-Payment, X-Payment-Response",
    );
    await flush();
  } finally {
    restoreFetch();
  }
});

test("marcPaywall falls back to a wildcard CORS origin when none is sent", async () => {
  stubFacilitatorFetch();
  try {
    const handler = marcPaywall({ payTo: Keypair.random().publicKey(), price: "$0.01" });
    const req = { method: "OPTIONS", headers: {} };
    const res = fakeResponse();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (handler as any)(req, res, () => {});

    assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
    await flush();
  } finally {
    restoreFetch();
  }
});
