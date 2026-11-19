import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { parseEventTopicHeader } from "./poller.js";

const actor = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

describe("parseEventTopicHeader", () => {
  it("parses legacy event topics as version 1", () => {
    const topics = [
      xdr.ScVal.scvSymbol("JobCreated"),
      nativeToScVal(new Address(actor)),
    ];

    expect(parseEventTopicHeader(topics)).toEqual({
      eventName: "JobCreated",
      version: 1,
      actor,
    });
  });

  it("parses versioned event topics and their actor", () => {
    const topics = [
      xdr.ScVal.scvSymbol("JobCreated"),
      xdr.ScVal.scvU32(2),
      nativeToScVal(new Address(actor)),
    ];

    expect(parseEventTopicHeader(topics)).toEqual({
      eventName: "JobCreated",
      version: 2,
      actor,
    });
  });

  it("preserves unknown event versions for forward compatibility", () => {
    const topics = [
      xdr.ScVal.scvSymbol("JobCreated"),
      xdr.ScVal.scvU32(3),
      nativeToScVal(new Address(actor)),
    ];

    expect(parseEventTopicHeader(topics)?.version).toBe(3);
  });
});

describe("health/readiness", () => {
  const TIP_LEDGER = 1000;
  const MAX_LAG = 10;

  type HealthPayload = {
    status: string;
    lastProcessedLedger: number | null;
    tipLedger: number | null;
    lag: number | null;
    db: string;
  };

  type HealthResult = {
    statusCode: number;
    body: HealthPayload;
  };

  type FakeRpc = {
    getLatestLedger: () => Promise<{ sequence: number }>;
  };

  type StoreStub = {
    getLastProcessedLedger: () => Promise<number | null>;
  };

  // Lazily resolve the health handler so this test file keeps working even if
  // the implementation lands under a slightly different export name.
  const loadHealthHandler = async (): Promise<
    (deps: { rpc: FakeRpc; store: StoreStub; maxLag: number }) => Promise<HealthResult>
  > => {
    const mod = (await import("./poller.js")) as Record<string, unknown>;
    const candidate =
      mod.checkHealth ??
      mod.getHealth ??
      mod.healthCheck ??
      mod.buildHealthCheck ??
      mod.createHealthHandler;

    if (typeof candidate !== "function") {
      throw new Error("health handler not exported from poller.js");
    }

    return candidate as (
      deps: { rpc: FakeRpc; store: StoreStub; maxLag: number },
    ) => Promise<HealthResult>;
  };

  const makeRpc = (sequence: number): FakeRpc => ({
    getLatestLedger: async () => ({ sequence }),
  });

  const makeStore = (
    impl: () => Promise<number | null>,
  ): StoreStub => ({
    getLastProcessedLedger: impl,
  });

  it("is ready when lag is within the threshold", async () => {
    const checkHealth = await loadHealthHandler();
    const result = await checkHealth({
      rpc: makeRpc(TIP_LEDGER),
      store: makeStore(async () => TIP_LEDGER - MAX_LAG),
      maxLag: MAX_LAG,
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe("ready");
    expect(result.body.lastProcessedLedger).toBe(TIP_LEDGER - MAX_LAG);
    expect(result.body.tipLedger).toBe(TIP_LEDGER);
    expect(result.body.lag).toBe(MAX_LAG);
    expect(result.body.db).toBe("ok");
  });

  it("is not ready (503) when lag exceeds the threshold", async () => {
    const checkHealth = await loadHealthHandler();
    const result = await checkHealth({
      rpc: makeRpc(TIP_LEDGER),
      store: makeStore(async () => TIP_LEDGER - MAX_LAG - 1),
      maxLag: MAX_LAG,
    });

    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe("not_ready");
    expect(result.body.lastProcessedLedger).toBe(TIP_LEDGER - MAX_LAG - 1);
    expect(result.body.tipLedger).toBe(TIP_LEDGER);
    expect(result.body.lag).toBe(MAX_LAG + 1);
    expect(result.body.db).toBe("ok");
  });

  it("is not ready when the DB read throws", async () => {
    const checkHealth = await loadHealthHandler();
    const result = await checkHealth({
      rpc: makeRpc(TIP_LEDGER),
      store: makeStore(async () => {
        throw new Error("db unavailable");
      }),
      maxLag: MAX_LAG,
    });

    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe("not_ready");
    expect(result.body.lastProcessedLedger).toBeNull();
    expect(result.body.tipLedger).toBe(TIP_LEDGER);
    expect(result.body.lag).toBeNull();
    expect(result.body.db).toBe("error");
  });
});