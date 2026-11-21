import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import {
  marcFetch,
  parsePaymentRequiredHeader,
  InsufficientFundsError,
  MarcPaymentTimeoutError,
  PaymentRejectedError,
  HeaderSizeLimitError,
  BudgetExceededError,
} from "./marcFetch.js";

test("parsePaymentRequiredHeader extracts amount and asset from a 402 header", () => {
  const headerValue = Buffer.from(
    JSON.stringify({
      accepts: [{ amount: "1000", asset: "USDC" }],
    }),
  ).toString("base64");

  const parsed = parsePaymentRequiredHeader(headerValue);
  assert.equal(parsed.amount, "1000");
  assert.equal(parsed.asset, "USDC");
});

test("parsePaymentRequiredHeader returns empty fields for malformed input", () => {
  assert.deepEqual(parsePaymentRequiredHeader("not base64"), { amount: "", asset: "" });
  assert.deepEqual(parsePaymentRequiredHeader(Buffer.from("not json").toString("base64")), {
    amount: "",
    asset: "",
  });
});

test("marcFetch aborts after the configured timeout", async () => {
  const signer = Keypair.random();
  const fetchImpl = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return new Response("slow", { status: 200 });
  };

  const fetcher = marcFetch({
    signer,
    timeoutMs: 5,
    fetchImpl,
  });

  await assert.rejects(fetcher("https://example.com"), /timeout after 5ms/);
});

test("marcFetch performs one payment retry and resolves on success", async () => {
  const signer = Keypair.random();
  let requests = 0;
  const fetchImpl = async (_input: RequestInfo | URL, _init?: RequestInit) => {
    requests += 1;
    if (requests === 1) {
      return new Response("", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": Buffer.from(
            JSON.stringify({ accepts: [{ amount: "1", asset: "USDC" }] }),
          ).toString("base64"),
        },
      });
    }
    return new Response("ok", { status: 200 });
  };

  const originalCreatePayload = x402Client.prototype.createPaymentPayload;
  const originalGetPaymentRequiredResponse = x402HTTPClient.prototype.getPaymentRequiredResponse;
  const originalEncode = x402HTTPClient.prototype.encodePaymentSignatureHeader;
  const originalProcess = (
    x402HTTPClient.prototype as unknown as { processPaymentResult?: () => Promise<unknown> }
  ).processPaymentResult;

  x402Client.prototype.createPaymentPayload = async () => ({ type: "payload" }) as never;
  x402HTTPClient.prototype.getPaymentRequiredResponse = () => ({}) as never;
  x402HTTPClient.prototype.encodePaymentSignatureHeader = () => ({}) as never;
  (
    x402HTTPClient.prototype as unknown as { processPaymentResult: () => Promise<unknown> }
  ).processPaymentResult = async () => ({ recovered: false }) as never;

  try {
    const fetcher = marcFetch({
      signer,
      maxPaymentAttempts: 2,
      fetchImpl,
    });

    const response = await fetcher("https://example.com");
    assert.equal(response.status, 200);
    assert.equal(requests, 2);
  } finally {
    x402Client.prototype.createPaymentPayload = originalCreatePayload;
    x402HTTPClient.prototype.getPaymentRequiredResponse = originalGetPaymentRequiredResponse;
    x402HTTPClient.prototype.encodePaymentSignatureHeader = originalEncode;
    if (originalProcess) {
      (
        x402HTTPClient.prototype as unknown as { processPaymentResult: () => Promise<unknown> }
      ).processPaymentResult = originalProcess;
    }
  }
});

type Mock402Options = {
  /** Number of 402 challenges to serve before returning 200. */
  challenges?: number;
  /** Amount advertised in the 402 challenge. */
  amount?: string;
  /** Asset advertised in the 402 challenge. */
  asset?: string;
  /** Optional payTo advertised in the 402 challenge. */
  payTo?: string;
  /** Optional ledger advertised in the 402 challenge. */
  ledger?: number;
  /** When set, the mock rejects the payment proof with this status. */
  rejectProofWith?: number;
  /** When set, the mock never settles the payment (pending forever). */
  pendingForever?: boolean;
  /** When set, the mock returns an oversized PAYMENT-REQUIRED header. */
  oversizedHeader?: boolean;
};

type Mock402Server = {
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Number of requests that carried a payment signature header. */
  paymentsSubmitted: () => number;
  /** Number of total requests served. */
  requests: () => number;
};

function buildPaymentRequiredHeader(opts: Mock402Options): string {
  const accepts = [
    {
      scheme: "exact",
      network: "stellar:testnet",
      amount: opts.amount ?? "1000",
      asset: opts.asset ?? "USDC",
      payTo: opts.payTo ?? "GPAYTO",
      maxTimeoutSeconds: 60,
      extra: { ledger: opts.ledger ?? 1234 },
    },
  ];
  return Buffer.from(JSON.stringify({ x402Version: 1, accepts })).toString("base64");
}

function createMock402Server(opts: Mock402Options = {}): Mock402Server {
  const challenges = opts.challenges ?? 1;
  let served = 0;
  let payments = 0;
  let requests = 0;

  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests += 1;
    const headers = new Headers(init?.headers ?? {});
    const hasPayment =
      headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT") || headers.has("payment-signature");
    if (hasPayment) {
      payments += 1;
    }

    if (opts.oversizedHeader) {
      return new Response("", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": "A".repeat(64 * 1024) },
      });
    }

    if (served < challenges) {
      served += 1;
      return new Response("", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": buildPaymentRequiredHeader(opts) },
      });
    }

    if (hasPayment) {
      if (opts.pendingForever) {
        // Simulate a payment that never settles: hang until the caller aborts.
        await new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (opts.rejectProofWith) {
        return new Response("payment rejected", { status: opts.rejectProofWith });
      }
    }

    return new Response("ok", { status: 200 });
  };

  return {
    fetchImpl,
    paymentsSubmitted: () => payments,
    requests: () => requests,
  };
}

function stubX402(overrides: {
  createPaymentPayload?: () => Promise<unknown>;
  processPaymentResult?: () => Promise<unknown>;
} = {}) {
  const originalCreatePayload = x402Client.prototype.createPaymentPayload;
  const originalGetPaymentRequiredResponse = x402HTTPClient.prototype.getPaymentRequiredResponse;
  const originalEncode = x402HTTPClient.prototype.encodePaymentSignatureHeader;
  const originalProcess = (
    x402HTTPClient.prototype as unknown as { processPaymentResult?: () => Promise<unknown> }
  ).processPaymentResult;

  x402Client.prototype.createPaymentPayload =
    (overrides.createPaymentPayload as never) ?? (async () => ({ type: "payload" }) as never);
  x402HTTPClient.prototype.getPaymentRequiredResponse = () => ({}) as never;
  x402HTTPClient.prototype.encodePaymentSignatureHeader = () =>
    ({ "PAYMENT-SIGNATURE": "stub" }) as never;
  (
    x402HTTPClient.prototype as unknown as { processPaymentResult: () => Promise<unknown> }
  ).processPaymentResult =
    (overrides.processPaymentResult as never) ?? (async () => ({ recovered: false }) as never);

  return () => {
    x402Client.prototype.createPaymentPayload = originalCreatePayload;
    x402HTTPClient.prototype.getPaymentRequiredResponse = originalGetPaymentRequiredResponse;
    x402HTTPClient.prototype.encodePaymentSignatureHeader = originalEncode;
    if (originalProcess) {
      (
        x402HTTPClient.prototype as unknown as { processPaymentResult: () => Promise<unknown> }
      ).processPaymentResult = originalProcess;
    }
  };
}

test("marcFetch success flow: 402 -> pay -> retry -> 200", async () => {
  const signer = Keypair.random();
  const server = createMock402Server({ challenges: 1, amount: "1000" });
  const restore = stubX402();

  try {
    const fetcher = marcFetch({ signer, maxPaymentAttempts: 2, fetchImpl: server.fetchImpl });
    const response = await fetcher("https://example.com");
    assert.equal(response.status, 200);
    assert.equal(server.requests(), 2);
    assert.equal(server.paymentsSubmitted(), 1);
  } finally {
    restore();
  }
});

test("marcFetch maps insufficient balance to InsufficientFundsError and sends no funds", async () => {
  const signer = Keypair.random();
  const server = createMock402Server({ challenges: 1, amount: "1000" });
  const restore = stubX402({
    createPaymentPayload: async () => {
      throw new InsufficientFundsError("insufficient balance", { required: "1000", available: "0" });
    },
  });

  try {
    const fetcher = marcFetch({ signer, maxPaymentAttempts: 2, fetchImpl: server.fetchImpl });
    await assert.rejects(fetcher("https://example.com"), (err: unknown) => {
      assert.ok(err instanceof InsufficientFundsError);
      return true;
    });
    assert.equal(server.paymentsSubmitted(), 0);
  } finally {
    restore();
  }
});

test("marcFetch maps tx pending timeout to MarcPaymentTimeoutError", async () => {
  const signer = Keypair.random();
  const server = createMock402Server({ challenges: 1, pendingForever: true });
  const restore = stubX402({
    processPaymentResult: async () => {
      throw new MarcPaymentTimeoutError("payment pending timed out", { txHash: "deadbeef" });
    },
  });

  try {
    const fetcher = marcFetch({
      signer,
      maxPaymentAttempts: 2,
      timeoutMs: 50,
      fetchImpl: server.fetchImpl,
    });
    await assert.rejects(fetcher("https://example.com"), (err: unknown) => {
      assert.ok(err instanceof MarcPaymentTimeoutError);
      return true;
    });
  } finally {
    restore();
  }
});

test("marcFetch maps server proof rejection to PaymentRejectedError with no funds sent", async () => {
  const signer = Keypair.random();
  const server = createMock402Server({ challenges: 1, rejectProofWith: 402 });
  const restore = stubX402({
    processPaymentResult: async () => {
      throw new PaymentRejectedError("server rejected payment proof", { status: 402 });
    },
  });

  try {
    const fetcher = marcFetch({ signer, maxPaymentAttempts: 2, fetchImpl: server.fetchImpl });
    await assert.rejects(fetcher("https://example.com"), (err: unknown) => {
      assert.ok(err instanceof PaymentRejectedError);
      return true;
    });
    // The mock never observed a settled payment; the proof was rejected.
    assert.equal(server.paymentsSubmitted(), 0);
  } finally {
    restore();
  }
});

test("marcFetch maps oversized PAYMENT-REQUIRED header to HeaderSizeLimitError", async () => {
  const signer = Keypair.random();
  const server = createMock402Server({ oversizedHeader: true });
  const restore = stubX402();

  try {
    const fetcher = marcFetch({ signer, maxPaymentAttempts: 2, fetchImpl: server.fetchImpl });
    await assert.rejects(fetcher("https://example.com"), (err: unknown) => {
      assert.ok(err instanceof HeaderSizeLimitError);
      return true;
    });
    assert.equal(server.paymentsSubmitted(), 0);
  } finally {
    restore();
  }
});

test("marcFetch returns a typed receipt when returnReceipt is true", async () => {
  const signer = Keypair.random();
  const server = createMock402Server({
    challenges: 1,
    amount: "1000",
    asset: "USDC",
    payTo: "GPAYTO",
    ledger: 4242,
  });
  const restore = stubX402({
    processPaymentResult: async () => ({
      recovered: false,
      txHash: "abc123",
      ledger: 4242,
    }),
  });

  try {
    const fetcher = marcFetch({
      signer,
      maxPaymentAttempts: 2,
      returnReceipt: true,
      fetchImpl: server.fetchImpl,
    });
    const result = await fetcher("https://example.com");
    assert.ok("response" in result && "receipt" in result);
    const { response, receipt } = result as {
      response: Response;
      receipt: { txHash: string; amount: string; token: string; payTo: string; ledger: number };
    };
    assert.equal(response.status, 200);
    assert.equal(receipt.txHash, "abc123");
    assert.equal(receipt.amount, "1000");
    assert.equal(receipt.token, "USDC");
    assert.equal(receipt.payTo, "GPAYTO");
    assert.equal(receipt.ledger, 4242);
  } finally {
    restore();
  }
});

test("marcFetch budget guard: maxPerRequest throws BudgetExceededError and fires hook", async () => {
  const signer = Keypair.random();
  const server = createMock402Server({ challenges: 1, amount: "5000" });
  const restore = stubX402();
  const exceeded: BudgetExceededError[] = [];

  try {
    const fetcher = marcFetch({
      signer,
      maxPaymentAttempts: 2,
      maxPerRequest: "1000",
      onBudgetExceeded: (err) => {
        exceeded.push(err);
      },
      fetchImpl: server.fetchImpl,
    });
    await assert.rejects(fetcher("https://example.com"), (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      return true;
    });
    assert.equal(exceeded.length, 1);
    assert.ok(exceeded[0] instanceof BudgetExceededError);
    assert.equal(server.paymentsSubmitted(), 0);
  } finally {
    restore();
  }
});

test("marcFetch budget guard: maxPerWindow enforced across concurrent requests", async () => {
  const signer = Keypair.random();
  const server = createMock402Server({ challenges: 10, amount: "1000" });
  const restore = stubX402();

  try {
    const fetcher = marcFetch({
      signer,
      maxPaymentAttempts: 2,
      maxPerWindow: "2000",
      windowMs: 60_000,
      fetchImpl: server.fetchImpl,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => fetcher("https://example.com")),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult =>
        r.status === "rejected" && r.reason instanceof BudgetExceededError,
    );

    // Only two payments of 1000 fit within the 2000 window budget.
    assert.equal(fulfilled.length, 2);
    assert.equal(rejected.length, 3);
    assert.equal(server.paymentsSubmitted(), 2);
  } finally {
    restore();
  }
});

test("marcFetch stops retrying after the configured payment-attempt limit", async () => {
  const signer = Keypair.random();
  let requests = 0;
  const fetchImpl = async (_input: RequestInfo | URL, _init?: RequestInit) => {
    requests += 1;
    if (requests <= 2) {
      return new Response("", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": Buffer.from(
            JSON.stringify({ accepts: [{ amount: "1", asset: "USDC" }] }),
          ).toString("base64"),
        },
      });
    }
    return new Response("ok", { status: 200 });
  };

  const originalCreatePayload = x402Client.prototype.createPaymentPayload;
  const originalGetPaymentRequiredResponse = x402HTTPClient.prototype.getPaymentRequiredResponse;
  const originalEncode = x402HTTPClient.prototype.encodePaymentSignatureHeader;
  const originalProcess = (
    x402HTTPClient.prototype as unknown as { processPaymentResult?: () => Promise<unknown> }
  ).processPaymentResult;

  x402Client.prototype.createPaymentPayload = async () => ({ type: "payload" }) as never;
  x402HTTPClient.prototype.getPaymentRequiredResponse = () => ({}) as never;
  x402HTTPClient.prototype.encodePaymentSignatureHeader = () => ({}) as never;
  (
    x402HTTPClient.prototype as unknown as { processPaymentResult: () => Promise<unknown> }
  ).processPaymentResult = async () => ({ recovered: false }) as never;

  try {
    const fetcher = marcFetch({
      signer,
      maxPaymentAttempts: 1,
      fetchImpl,
    });

    await assert.rejects(fetcher("https://example.com"), /max payment attempts reached/);
  } finally {
    x402Client.prototype.createPaymentPayload = originalCreatePayload;
    x402HTTPClient.prototype.getPaymentRequiredResponse = originalGetPaymentRequiredResponse;
    x402HTTPClient.prototype.encodePaymentSignatureHeader = originalEncode;
    if (originalProcess) {
      (
        x402HTTPClient.prototype as unknown as { processPaymentResult: () => Promise<unknown> }
      ).processPaymentResult = originalProcess;
    }
  }
});
