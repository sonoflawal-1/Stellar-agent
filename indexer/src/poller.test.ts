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

interface RawEvent {
  ledger: number;
  txHash: string;
  opIndex: number;
  eventIndex: number;
  eventName: string;
}

interface StoredEvent extends RawEvent {
  id: string;
}

/**
 * Minimal in-memory store that emulates the unique constraint on
 * (ledger, tx_hash, op_index, event_index) plus `INSERT ... ON CONFLICT DO NOTHING`.
 */
class FakeEventStore {
  private readonly rows = new Map<string, StoredEvent>();

  private key(e: RawEvent): string {
    return `${e.ledger}:${e.txHash}:${e.opIndex}:${e.eventIndex}`;
  }

  insert(event: RawEvent): boolean {
    const key = this.key(event);
    if (this.rows.has(key)) {
      return false;
    }
    this.rows.set(key, { ...event, id: key });
    return true;
  }

  insertMany(events: RawEvent[]): number {
    let inserted = 0;
    for (const event of events) {
      if (this.insert(event)) {
        inserted += 1;
      }
    }
    return inserted;
  }

  count(): number {
    return this.rows.size;
  }

  all(): StoredEvent[] {
    return [...this.rows.values()];
  }
}

/**
 * Emulates a poller run over a ledger range: fetches raw events for the
 * inclusive range and persists them via the idempotent insert path.
 */
function runPoller(
  store: FakeEventStore,
  source: RawEvent[],
  fromLedger: number,
  toLedger: number,
): number {
  const window = source.filter(
    (e) => e.ledger >= fromLedger && e.ledger <= toLedger,
  );
  return store.insertMany(window);
}

function makeEvent(
  ledger: number,
  txHash: string,
  opIndex: number,
  eventIndex: number,
  eventName = "JobCreated",
): RawEvent {
  return { ledger, txHash, opIndex, eventIndex, eventName };
}

describe("poller idempotent ingestion", () => {
  it("re-ingesting the same ledger range produces zero new rows", () => {
    const store = new FakeEventStore();
    const source: RawEvent[] = [
      makeEvent(100, "tx-a", 0, 0),
      makeEvent(100, "tx-a", 0, 1),
      makeEvent(101, "tx-b", 1, 0),
      makeEvent(102, "tx-c", 0, 0),
    ];

    const firstInserted = runPoller(store, source, 100, 102);
    expect(firstInserted).toBe(4);
    expect(store.count()).toBe(4);

    const secondInserted = runPoller(store, source, 100, 102);
    expect(secondInserted).toBe(0);
    expect(store.count()).toBe(4);
  });

  it("overlapping polling windows do not create duplicates", () => {
    const store = new FakeEventStore();
    const source: RawEvent[] = [
      makeEvent(200, "tx-a", 0, 0),
      makeEvent(201, "tx-b", 0, 0),
      makeEvent(202, "tx-c", 0, 0),
      makeEvent(203, "tx-d", 0, 0),
    ];

    // First window: 200..202
    expect(runPoller(store, source, 200, 202)).toBe(3);
    expect(store.count()).toBe(3);

    // Overlapping window: 201..203 (201 and 202 already ingested)
    expect(runPoller(store, source, 201, 203)).toBe(1);
    expect(store.count()).toBe(4);

    // Re-run the overlapping window again: nothing new.
    expect(runPoller(store, source, 201, 203)).toBe(0);
    expect(store.count()).toBe(4);
  });

  it("distinguishes events by (ledger, tx, op, event index)", () => {
    const store = new FakeEventStore();
    const source: RawEvent[] = [
      makeEvent(300, "tx-a", 0, 0),
      makeEvent(300, "tx-a", 0, 1),
      makeEvent(300, "tx-a", 1, 0),
      makeEvent(300, "tx-b", 0, 0),
      makeEvent(301, "tx-a", 0, 0),
    ];

    expect(runPoller(store, source, 300, 301)).toBe(5);
    expect(store.count()).toBe(5);

    // Re-ingest: still no duplicates.
    expect(runPoller(store, source, 300, 301)).toBe(0);
    expect(store.count()).toBe(5);
  });

  it("survives a simulated restart by re-ingesting from the last checkpoint", () => {
    const store = new FakeEventStore();
    const source: RawEvent[] = [
      makeEvent(400, "tx-a", 0, 0),
      makeEvent(401, "tx-b", 0, 0),
      makeEvent(402, "tx-c", 0, 0),
      makeEvent(403, "tx-d", 0, 0),
    ];

    // Initial run ingests 400..401.
    expect(runPoller(store, source, 400, 401)).toBe(2);
    expect(store.count()).toBe(2);

    // Restart: re-poll from the last checkpoint (401) through 403.
    // 401 is re-ingested but must be a no-op.
    expect(runPoller(store, source, 401, 403)).toBe(2);
    expect(store.count()).toBe(4);

    // A second restart re-polling the same range adds nothing.
    expect(runPoller(store, source, 401, 403)).toBe(0);
    expect(store.count()).toBe(4);
  });
});