/**
 * Automated integration test verifying full x402 payment flow between
 * buyer agent (marcFetch) and mock seller agent (marcPaywall in Express).
 *
 * Issue #596:
 * - Spins up an ephemeral Express app with marcPaywall.
 * - Confirms first request receives 402 with X-Payment-Requirements.
 * - Issues request using marcFetch with a test keypair.
 * - Asserts marcFetch intercepts 402, constructs signed payment, and retries.
 * - Asserts server validates payment and returns 200 with resource body.
 * - Closes server after test completes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import express from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { marcPaywall } from "./marcPaywall.js";
import { marcFetch } from "./marcFetch.js";

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
      return new Response(
        JSON.stringify({
          isValid: true,
          payer: "GBUYERMOCKTESTKEYPAIR1234567890",
          extensions: {},
          extra: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/settle")) {
      return new Response(
        JSON.stringify({
          success: true,
          payer: "GBUYERMOCKTESTKEYPAIR1234567890",
          transaction: "mock_stellar_tx_hash",
          network: "stellar:testnet",
          extensions: {},
          extra: {},
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

test("x402 integration: verifies complete payment roundtrip between buyer and mock seller", async () => {
  stubFacilitatorFetch();

  const sellerKeypair = Keypair.random();
  const buyerKeypair = Keypair.random();

  const app = express();
  app.use(express.json());

  let totalRequestsReceived = 0;
  const paywall = marcPaywall({
    payTo: sellerKeypair.publicKey(),
    price: "$0.01",
    network: "stellar:testnet",
  });

  app.get(
    "/api/resource",
    (req, res, next) => {
      totalRequestsReceived += 1;
      paywall(req, res, next);
    },
    (_req, res) => {
      res.status(200).json({
        status: "ok",
        resource: "premium-agent-output",
        access: "granted",
      });
    },
  );

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  const address = server.address() as { port: number };
  const resourceUrl = `http://127.0.0.1:${address.port}/api/resource`;

  try {
    // 1. Assert raw initial request receives 402 with X-Payment-Requirements
    const rawRes = await fetch(resourceUrl);
    assert.equal(rawRes.status, 402, "Initial request must receive HTTP 402 Payment Required");

    const paymentReqHeader =
      rawRes.headers.get("x-payment-requirements") ||
      rawRes.headers.get("X-Payment-Requirements") ||
      rawRes.headers.get("payment-required");

    assert.ok(
      paymentReqHeader,
      "Response must include X-Payment-Requirements or PAYMENT-REQUIRED header",
    );

    // 2. Issue request using marcFetch with buyer test keypair
    const paymentStages: string[] = [];
    const clientFetch = marcFetch({
      signer: buyerKeypair,
      network: "testnet",
      maxPaymentAttempts: 2,
      onPayment: (status) => {
        paymentStages.push(status);
      },
    });

    const paidRes = await clientFetch(resourceUrl);

    // 3. Assert server validates payment and returns 200 with resource body
    assert.equal(paidRes.status, 200, "Authenticated request must return HTTP 200 OK");
    const data = (await paidRes.json()) as { status: string; resource: string; access: string };

    assert.equal(data.status, "ok");
    assert.equal(data.resource, "premium-agent-output");
    assert.equal(data.access, "granted");

    // 4. Assert payment lifecycle callbacks
    assert.ok(
      paymentStages.includes("signing"),
      "Payment lifecycle must transition through 'signing'",
    );
    assert.ok(
      paymentStages.includes("pending"),
      "Payment lifecycle must transition through 'pending'",
    );
    assert.ok(
      paymentStages.includes("settled"),
      "Payment lifecycle must transition through 'settled'",
    );

    // Total requests received by the Express app must be at least 2 (initial 402 + retried 200)
    assert.ok(totalRequestsReceived >= 2, "Server must receive initial request and payment retry");
  } finally {
    restoreFetch();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test("x402 integration: returnReceipt returns a receipt matching ledger data", async () => {
  // Ledger stub: record what the facilitator settles so we can compare.
  const settledLedger: Array<{
    txHash: string;
    amount: string;
    token: string;
    payTo: string;
    ledger: number;
  }> = [];

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
      return new Response(
        JSON.stringify({
          isValid: true,
          payer: "GBUYERMOCKTESTKEYPAIR1234567890",
          extensions: {},
          extra: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/settle")) {
      const txHash = "mock_stellar_tx_hash_receipt";
      const amount = "1000000";
      const token = "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
      const payTo = "GSELLERMOCKTESTKEYPAIR1234567890";
      const ledger = 1234567;
      settledLedger.push({ txHash, amount, token, payTo, ledger });
      return new Response(
        JSON.stringify({
          success: true,
          payer: "GBUYERMOCKTESTKEYPAIR1234567890",
          transaction: txHash,
          network: "stellar:testnet",
          amount,
          asset: token,
          payTo,
          ledger,
          extensions: {},
          extra: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const sellerKeypair = Keypair.random();
  const buyerKeypair = Keypair.random();

  const app = express();
  app.use(express.json());

  const paywall = marcPaywall({
    payTo: sellerKeypair.publicKey(),
    price: "$0.01",
    network: "stellar:testnet",
  });

  app.get(
    "/api/resource",
    (req, res, next) => {
      paywall(req, res, next);
    },
    (_req, res) => {
      res.status(200).json({
        status: "ok",
        resource: "premium-agent-output",
        access: "granted",
      });
    },
  );

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  const address = server.address() as { port: number };
  const resourceUrl = `http://127.0.0.1:${address.port}/api/resource`;

  try {
    const clientFetch = marcFetch({
      signer: buyerKeypair,
      network: "testnet",
      maxPaymentAttempts: 2,
      returnReceipt: true,
    });

    const result = await clientFetch(resourceUrl);

    // With returnReceipt: true, marcFetch returns { response, receipt }.
    assert.ok(
      result && typeof result === "object" && "response" in result && "receipt" in result,
      "marcFetch with returnReceipt must return { response, receipt }",
    );

    const { response, receipt } = result as {
      response: Response;
      receipt: {
        txHash: string;
        amount: string;
        token: string;
        payTo: string;
        ledger: number;
      };
    };

    assert.equal(response.status, 200, "Paid request must return HTTP 200 OK");
    const data = (await response.json()) as { status: string; resource: string; access: string };
    assert.equal(data.status, "ok");
    assert.equal(data.resource, "premium-agent-output");
    assert.equal(data.access, "granted");

    // Receipt must be present and typed.
    assert.ok(receipt, "Receipt must be returned");
    assert.equal(typeof receipt.txHash, "string");
    assert.equal(typeof receipt.amount, "string");
    assert.equal(typeof receipt.token, "string");
    assert.equal(typeof receipt.payTo, "string");
    assert.equal(typeof receipt.ledger, "number");

    // Receipt must match the ledger data recorded by the facilitator stub.
    assert.equal(settledLedger.length, 1, "Facilitator must settle exactly once");
    const ledgerEntry = settledLedger[0];
    assert.equal(receipt.txHash, ledgerEntry.txHash, "Receipt txHash must match ledger");
    assert.equal(receipt.amount, ledgerEntry.amount, "Receipt amount must match ledger");
    assert.equal(receipt.token, ledgerEntry.token, "Receipt token must match ledger");
    assert.equal(receipt.payTo, ledgerEntry.payTo, "Receipt payTo must match ledger");
    assert.equal(receipt.ledger, ledgerEntry.ledger, "Receipt ledger must match ledger");
  } finally {
    restoreFetch();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test("x402 integration: concurrent replay attack with same X-Payment header is prevented", async () => {
  // Count facilitator calls so we can assert single settlement.
  let verifyCalls = 0;
  let settleCalls = 0;

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
      verifyCalls += 1;
      // Simulate facilitator latency so parallel requests overlap in-flight.
      await new Promise((r) => setTimeout(r, 150));
      return new Response(
        JSON.stringify({
          isValid: true,
          payer: "GBUYERMOCKTESTKEYPAIR1234567890",
          extensions: {},
          extra: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/settle")) {
      settleCalls += 1;
      await new Promise((r) => setTimeout(r, 150));
      return new Response(
        JSON.stringify({
          success: true,
          payer: "GBUYERMOCKTESTKEYPAIR1234567890",
          transaction: "mock_stellar_tx_hash",
          network: "stellar:testnet",
          extensions: {},
          extra: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const sellerKeypair = Keypair.random();
  const buyerKeypair = Keypair.random();

  const app = express();
  app.use(express.json());

  let handlerExecutions = 0;
  const paywall = marcPaywall({
    payTo: sellerKeypair.publicKey(),
    price: "$0.01",
    network: "stellar:testnet",
  });

  app.get(
    "/api/resource",
    (req, res, next) => {
      paywall(req, res, next);
    },
    (_req, res) => {
      handlerExecutions += 1;
      res.status(200).json({
        status: "ok",
        resource: "premium-agent-output",
        access: "granted",
      });
    },
  );

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  const address = server.address() as { port: number };
  const resourceUrl = `http://127.0.0.1:${address.port}/api/resource`;

  try {
    // 1. Obtain the 402 challenge.
    const rawRes = await fetch(resourceUrl);
    assert.equal(rawRes.status, 402, "Initial request must receive HTTP 402 Payment Required");

    const paymentReqHeader =
      rawRes.headers.get("x-payment-requirements") ||
      rawRes.headers.get("X-Payment-Requirements") ||
      rawRes.headers.get("payment-required");
    assert.ok(paymentReqHeader, "Response must include payment requirements header");

    // 2. Build a single signed X-Payment header via marcFetch, capturing it.
    let signedPaymentHeader: string | undefined;
    const captureFetch = marcFetch({
      signer: buyerKeypair,
      network: "testnet",
      maxPaymentAttempts: 1,
      onPayment: () => {},
    });

    // Intercept the outgoing request to capture the X-Payment header value.
    const originalCaptureFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === resourceUrl && init?.headers) {
        const headers = new Headers(init.headers as HeadersInit);
        const xp = headers.get("x-payment") || headers.get("X-Payment");
        if (xp) signedPaymentHeader = xp;
      }
      return originalCaptureFetch(input, init);
    }) as typeof fetch;

    try {
      await captureFetch(resourceUrl);
    } finally {
      globalThis.fetch = originalCaptureFetch;
    }

    assert.ok(signedPaymentHeader, "marcFetch must produce a signed X-Payment header");

    // Reset counters after the priming request so we measure only the replay burst.
    verifyCalls = 0;
    settleCalls = 0;
    handlerExecutions = 0;

    // 3. Fire N parallel requests reusing the SAME signed X-Payment header.
    const PARALLEL = 8;
    const replayResponses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        fetch(resourceUrl, {
          headers: { "X-Payment": signedPaymentHeader as string },
        }),
      ),
    );

    const statuses = replayResponses.map((r) => r.status);

    // 4. Assert no double execution: at most one request reaches the handler.
    assert.ok(
      handlerExecutions <= 1,
      `Handler must execute at most once, executed ${handlerExecutions} times`,
    );

    // 5. Assert facilitator settles at most once.
    assert.ok(
      settleCalls <= 1,
      `Facilitator /settle must be called at most once, called ${settleCalls} times`,
    );

    // 6. Every response must be either a success (200), a 409 Conflict, or a cached replay (200).
    for (const status of statuses) {
      assert.ok(
        status === 200 || status === 409,
        `Replay response must be 200 (cached/settled) or 409 (in-flight conflict), got ${status}`,
      );
    }

    // 7. At least one request must succeed.
    assert.ok(
      statuses.includes(200),
      `At least one replay request must succeed, got statuses: ${statuses.join(",")}`,
    );

    // 8. If any request was rejected as in-flight, it must be a 409.
    const conflictCount = statuses.filter((s) => s === 409).length;
    const successCount = statuses.filter((s) => s === 200).length;
    assert.equal(
      conflictCount + successCount,
      PARALLEL,
      "All replay responses must be accounted for as 200 or 409",
    );
  } finally {
    restoreFetch();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
