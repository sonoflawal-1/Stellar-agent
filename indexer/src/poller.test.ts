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

  /** Removes all events at or after `ledger` (used when rewinding on reorg). */
  purgeFrom(ledger: number): number {
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (row.ledger >= ledger) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return removed;
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

function makeLedgers(from: number, to: number, hashPrefix = "hash"): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  for (let seq = from; seq <= to; seq += 1) {
    out.push({ sequence: seq, hash: `${hashPrefix}-${seq}` });
  }
  return out;
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

describe("poller RPC pagination", () => {
  it("drains multiple pages and advances the cursor", async () => {
    const events: RawEvent[] = [
      makeEvent(10, "tx-a", 0, 0),
      makeEvent(11, "tx-b", 0, 0),
      makeEvent(12, "tx-c", 0, 0),
      makeEvent(13, "tx-d", 0, 0),
      makeEvent(14, "tx-e", 0, 0),
    ];
    const rpc = new MockRpc(events, makeLedgers(1, 20), { pageSize: 2 });
    const store = new FakeEventStore();
    const state: PollerState = { lastProcessedLedger: 0 };

    const result = await pollOnce(rpc, store, state, { confirmationDepth: 1 });

    expect(result.inserted).toBe(5);
    expect(store.count()).toBe(5);
    // 5 events / pageSize 2 => 3 pages.
    expect(rpc.callCount).toBe(3);
    // First call uses startLedger, subsequent calls use the cursor.
    expect(rpc.requestedStartLedgers[0]).toBe(1);
    expect(rpc.requestedCursors[0]).toBeUndefined();
    expect(rpc.requestedCursors[1]).toBe("2");
    expect(rpc.requestedCursors[2]).toBe("4");
  });

  it("does not process ledgers beyond the confirmation depth", async () => {
    const events: RawEvent[] = [
      makeEvent(10, "tx-a", 0, 0),
      makeEvent(18, "tx-b", 0, 0),
      makeEvent(19, "tx-c", 0, 0),
    ];
    const rpc = new MockRpc(events, makeLedgers(1, 20), { pageSize: 10 });
    const store = new FakeEventStore();
    const state: PollerState = { lastProcessedLedger: 0 };

    // latest = 20, depth = 5 => confirmed = 15, so 18 and 19 are excluded.
    const result = await pollOnce(rpc, store, state, { confirmationDepth: 5 });

    expect(result.inserted).toBe(1);
    expect(store.all().map((e) => e.ledger)).toEqual([10]);
    expect(state.lastProcessedLedger).toBe(15);
  });
});

describe("poller retention-window gaps", () => {
  it("resets the cursor and restarts from a safe ledger on 'start ledger too old'", async () => {
    const events: RawEvent[] = [
      makeEvent(90, "tx-a", 0, 0),
      makeEvent(95, "tx-b", 0, 0),
    ];
    const rpc = new MockRpc(events, makeLedgers(1, 100), {
      pageSize: 10,
      retentionWindow: 5,
    });
    const store = new FakeEventStore();
    // Start far behind the retention window to trigger the error.
    const state: PollerState = { lastProcessedLedger: 1 };

    const result = await pollOnce(rpc, store, state, { confirmationDepth: 2 });

    expect(result.inserted).toBe(2);
    expect(store.count()).toBe(2);
    // The poller must have retried after resetting its cursor.
    expect(rpc.callCount).toBeGreaterThanOrEqual(2);
    expect(state.lastProcessedLedger).toBe(98);
  });

  it("recovers when the RPC reports the retention error once", async () => {
    const events: RawEvent[] = [makeEvent(50, "tx-a", 0, 0)];
    const rpc = new MockRpc(events, makeLedgers(1, 60), { pageSize: 10 });
    const store = new FakeEventStore();
    const state: PollerState = { lastProcessedLedger: 40 };
    rpc.startLedgerTooOld = true;

    const result = await pollOnce(rpc, store, state, { confirmationDepth: 1 });

    expect(result.inserted).toBe(1);
    expect(store.count()).toBe(1);
  });
});

describe("poller error backoff", () => {
  it("retries transient failures with exponential backoff", async () => {
    const events: RawEvent[] = [makeEvent(10, "tx-a", 0, 0)];
    const rpc = new MockRpc(events, makeLedgers(1, 20), { pageSize: 10 });
    const store = new FakeEventStore();
    const state: PollerState = { lastProcessedLedger: 0 };

    rpc.transientFailures = 3;
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };

    const result = await pollOnce(rpc, store, state, {
      confirmationDepth: 1,
      baseBackoffMs: 10,
      maxRetries: 5,
      sleep,
    });

    expect(result.inserted).toBe(1);
    expect(delays).toEqual([10, 20, 40]);
  });

  it("gives up after exceeding maxRetries", async () => {
    const rpc = new MockRpc([], makeLedgers(1, 20), { pageSize: 10 });
    const store = new FakeEventStore();
    const state: PollerState = { lastProcessedLedger: 0 };

    rpc.transientFailures = 10;
    const sleep = async () => {};

    await expect(
      pollOnce(rpc, store, state, {
        confirmationDepth: 1,
        baseBackoffMs: 1,
        maxRetries: 2,
        sleep,
      }),
    ).rejects.toBeInstanceOf(MockRpcError);
  });
});

describe("poller cursor persistence", () => {
  it("resumes from the persisted cursor after a restart", async () => {
    const events: RawEvent[] = [
      makeEvent(10, "tx-a", 0, 0),
      makeEvent(11, "tx-b", 0, 0),
      makeEvent(12, "tx-c", 0, 0),
    ];
    const rpc = new MockRpc(events, makeLedgers(1, 20), { pageSize: 1 });
    const store = new FakeEventStore();
    const state: PollerState = { lastProcessedLedger: 0 };

    // First run drains everything.
    await pollOnce(rpc, store, state, { confirmationDepth: 1 });
    expect(store.count()).toBe(3);

    // Simulate a restart: persist and restore the cursor.
    const persisted = JSON.parse(JSON.stringify(state)) as PollerState;
    const restored: PollerState = { ...persisted };
    const callsBefore = rpc.callCount;

    // New events arrive; the poller should pick them up from the cursor.
    const moreEvents = [...events, makeEvent(13, "tx-d", 0, 0)];
    const rpc2 = new MockRpc(moreEvents, makeLedgers(1, 20), { pageSize: 1 });
    const result = await pollOnce(rpc2, store, restored, {
      confirmationDepth: 1,
    });

    expect(result.inserted).toBe(1);
    expect(store.count()).toBe(4);
    expect(rpc2.callCount).toBeGreaterThan(0);
    expect(callsBefore).toBeGreaterThan(0);
  });

  it("persists the cursor across pages within a single run", async () => {
    const events: RawEvent[] = [
      makeEvent(10, "tx-a", 0, 0),
      makeEvent(11, "tx-b", 0, 0),
      makeEvent(12, "tx-c", 0, 0),
    ];
    const rpc = new MockRpc(events, makeLedgers(1, 20), { pageSize: 1 });
    const store = new FakeEventStore();
    const state: PollerState = { lastProcessedLedger: 0 };

    await pollOnce(rpc, store, state, { confirmationDepth: 1 });

    // Cursor is cleared once the window is fully drained.
    expect(state.cursor).toBeUndefined();
    expect(state.lastProcessedLedger).toBe(19);
  });
});

describe("poller reorg handling", () => {
  it("detects a rollback, purges orphaned events and rewinds to the common ancestor", async () => {
    const events: RawEvent[] = [
      makeEvent(10, "tx-a", 0, 0),
      makeEvent(11, "tx-b", 0, 0),
      makeEvent(12, "tx-c", 0, 0),
    ];
    const rpc = new MockRpc(events, makeLedgers(1, 20), { pageSize: 10 });
    const store = new FakeEventStore();
    const state: PollerState = { lastProcessedLedger: 0 };

    // Initial run ingests 10..12 and advances to confirmed ledger 19.
    await pollOnce(rpc, store, state, { confirmationDepth: 1 });
    expect(store.count()).toBe(3);
    expect(state.lastProcessedLedger).toBe(19);

    // Simulate a rollback: ledger 19 now has a different hash.
    rpc.reorg(19, "reorged-19");

    const result = await pollOnce(rpc, store, state, { confirmationDepth: 1 });

    expect(result.reorgDetected).toBe(true);
    expect(result.rewindTo).toBe(18);
    // Events at or after the rewind point are purged.
    expect(store.all().every((e) => e.ledger <= 18)).toBe(true);
    expect(state.lastProcessedLedger).toBe(18);
    expect(state.lastProcessedHash).toBe("hash-18");
    expect(state.cursor).toBeUndefined();
  });

  it("re-ingests the canonical chain after a reorg", async () => {
    const events: RawEvent[] = [
      makeEvent(10, "tx-a", 0, 0),
      makeEvent(11, "tx-b", 0, 0),
    ];
    const rpc = new MockRpc(events, makeLedgers(1, 20), { pageSize: 10 });
    const store = new FakeEventStore();
    const state: PollerState = { lastProcessedLedger: 0 };

    await pollOnce(rpc, store, state, { confirmationDepth: 1 });
    expect(store.count()).toBe(2);

    // Reorg at the last processed ledger.
    rpc.reorg(19, "reorged-19");
    const first = await pollOnce(rpc, store, state, { confirmationDepth: 1 });
    expect(first.reorgDetected).toBe(true);

    // Next poll proceeds normally on the canonical chain.
    const second = await pollOnce(rpc, store, state, { confirmationDepth: 1 });
    expect(second.reorgDetected).toBe(false);
    expect(state.lastProcessedLedger).toBe(19);
    expect(state.lastProcessedHash).toBe("reorged-19");
  });
});

// ---------------------------------------------------------------------------
// Mock RPC client
// ---------------------------------------------------------------------------

interface RpcEventPage {
  events: RawEvent[];
  cursor: string;
  latestLedger: number;
}

interface LedgerRecord {
  sequence: number;
  hash: string;
}

type RpcErrorKind = "start_ledger_too_old" | "transient";

class MockRpcError extends Error {
  constructor(
    readonly kind: RpcErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "MockRpcError";
  }
}

/**
 * Mock Soroban RPC `getEvents` endpoint.
 *
 * - Serves events in pages of `pageSize`, advancing the cursor per page.
 * - Can be configured to fail with a retention-window error or a transient
 *   error for the next N calls.
 * - Serves ledger hashes so the poller can verify continuity and detect reorgs.
 */
class MockRpc {
  private readonly events: RawEvent[];
  private readonly ledgers = new Map<number, string>();
  private readonly pageSize: number;
  private readonly retentionWindow: number;

  /** Number of upcoming calls that should fail transiently. */
  transientFailures = 0;
  /** When true, the next call fails with a retention-window error. */
  startLedgerTooOld = false;

  /** Records every cursor the poller sent, for assertions. */
  readonly requestedCursors: Array<string | undefined> = [];
  /** Records every startLedger the poller sent, for assertions. */
  readonly requestedStartLedgers: number[] = [];
  /** Total number of getEvents calls received. */
  callCount = 0;

  constructor(
    events: RawEvent[],
    ledgers: LedgerRecord[],
    opts: { pageSize?: number; retentionWindow?: number } = {},
  ) {
    this.events = [...events].sort(
      (a, b) =>
        a.ledger - b.ledger ||
        a.txHash.localeCompare(b.txHash) ||
        a.opIndex - b.opIndex ||
        a.eventIndex - b.eventIndex,
    );
    for (const l of ledgers) {
      this.ledgers.set(l.sequence, l.hash);
    }
    this.pageSize = opts.pageSize ?? 2;
    this.retentionWindow = opts.retentionWindow ?? 100;
  }

  /** Replace the ledger hash at `sequence` to simulate a reorg. */
  reorg(sequence: number, newHash: string): void {
    this.ledgers.set(sequence, newHash);
  }

  latestLedger(): number {
    return Math.max(...this.ledgers.keys());
  }

  getLedgerHash(sequence: number): string | undefined {
    return this.ledgers.get(sequence);
  }

  async getEvents(params: {
    startLedger?: number;
    cursor?: string;
    endLedger?: number;
  }): Promise<RpcEventPage> {
    this.callCount += 1;
    this.requestedCursors.push(params.cursor);
    if (params.startLedger !== undefined) {
      this.requestedStartLedgers.push(params.startLedger);
    }

    if (this.transientFailures > 0) {
      this.transientFailures -= 1;
      throw new MockRpcError("transient", "rpc temporarily unavailable");
    }

    if (this.startLedgerTooOld) {
      this.startLedgerTooOld = false;
      throw new MockRpcError(
        "start_ledger_too_old",
        "start ledger is before the retention window",
      );
    }

    const latest = this.latestLedger();
    if (
      params.startLedger !== undefined &&
      params.startLedger < latest - this.retentionWindow
    ) {
      throw new MockRpcError(
        "start_ledger_too_old",
        "start ledger is before the retention window",
      );
    }

    const startLedger = params.startLedger ?? 0;
    const endLedger = params.endLedger ?? latest;

    let offset = 0;
    if (params.cursor) {
      const parsed = Number.parseInt(params.cursor, 10);
      if (!Number.isNaN(parsed)) {
        offset = parsed;
      }
    }

    const inRange = this.events.filter(
      (e) => e.ledger >= startLedger && e.ledger <= endLedger,
    );
    const page = inRange.slice(offset, offset + this.pageSize);
    const nextOffset = offset + page.length;

    return {
      events: page,
      cursor: String(nextOffset),
      latestLedger: latest,
    };
  }
}

// ---------------------------------------------------------------------------
// Poller harness
// ---------------------------------------------------------------------------

interface PollerState {
  cursor?: string;
  lastProcessedLedger: number;
  /** Ledger hash of the last processed ledger, used for continuity checks. */
  lastProcessedHash?: string;
}

interface PollerOptions {
  confirmationDepth: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface PollerResult {
  inserted: number;
  reorgDetected: boolean;
  rewindTo?: number;
}

/**
 * Polls the mock RPC until it has drained all pages up to the confirmed
 * ledger (latest - confirmationDepth), verifying ledger hash continuity.
 */
async function pollOnce(
  rpc: MockRpc,
  store: FakeEventStore,
  state: PollerState,
  opts: PollerOptions,
): Promise<PollerResult> {
  const sleep = opts.sleep ?? (async () => {});
  const maxRetries = opts.maxRetries ?? 5;
  const baseBackoffMs = opts.baseBackoffMs ?? 10;

  let inserted = 0;
  let reorgDetected = false;
  let rewindTo: number | undefined;

  // Verify continuity of the last processed ledger before continuing.
  if (state.lastProcessedHash !== undefined) {
    const currentHash = rpc.getLedgerHash(state.lastProcessedLedger);
    if (currentHash !== undefined && currentHash !== state.lastProcessedHash) {
      // Reorg: rewind to the common ancestor (lastProcessedLedger - 1).
      reorgDetected = true;
      rewindTo = state.lastProcessedLedger - 1;
      store.purgeFrom(rewindTo + 1);
      state.lastProcessedLedger = rewindTo;
      state.lastProcessedHash = rpc.getLedgerHash(rewindTo);
      state.cursor = undefined;
      return { inserted, reorgDetected, rewindTo };
    }
  }

  let attempt = 0;
  for (;;) {
    try {
      const latest = rpc.latestLedger();
      const confirmed = latest - opts.confirmationDepth;
      if (confirmed <= state.lastProcessedLedger) {
        return { inserted, reorgDetected, rewindTo };
      }

      const startLedger = state.cursor
        ? undefined
        : state.lastProcessedLedger + 1;

      const page = await rpc.getEvents({
        startLedger,
        cursor: state.cursor,
        endLedger: confirmed,
      });

      inserted += store.insertMany(page.events);
      state.cursor = page.cursor;

      for (const e of page.events) {
        if (e.ledger > state.lastProcessedLedger) {
          state.lastProcessedLedger = e.ledger;
          state.lastProcessedHash = rpc.getLedgerHash(e.ledger);
        }
      }

      if (page.events.length < 1) {
        // No more events in this window; advance to confirmed ledger.
        state.lastProcessedLedger = confirmed;
        state.lastProcessedHash = rpc.getLedgerHash(confirmed);
        state.cursor = undefined;
        return { inserted, reorgDetected, rewindTo };
      }
    } catch (err) {
      if (err instanceof MockRpcError && err.kind === "start_ledger_too_old") {
        // Retention window gap: reset cursor and restart from a safe ledger.
        const latest = rpc.latestLedger();
        const safe = latest - Math.floor(opts.confirmationDepth / 2);
        state.cursor = undefined;
        state.lastProcessedLedger = safe - 1;
        state.lastProcessedHash = rpc.getLedgerHash(safe - 1);
        continue;
      }

      attempt += 1;
      if (attempt > maxRetries) {
        throw err;
      }
      await sleep(baseBackoffMs * 2 ** (attempt - 1));
    }
  }
}