import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { marcFetch, parsePaymentRequiredHeader } from "./marcFetch.js";

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
