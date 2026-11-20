import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore, openDatabase } from "./db.js";

describe("EventStore discovery cache", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("persists cached values across database connections and supports invalidation", () => {
    directory = mkdtempSync(path.join(tmpdir(), "marc-discovery-cache-"));
    const dbPath = path.join(directory, "events.db");
    const firstDb = openDatabase(dbPath);
    const firstStore = new EventStore(firstDb);

    firstStore.setCache("agents", '[{"id":"1"}]', 123);
    firstDb.close();

    const secondDb = openDatabase(dbPath);
    const secondStore = new EventStore(secondDb);
    expect(secondStore.getCache("agents")).toEqual({
      value: '[{"id":"1"}]',
      updatedAt: 123,
    });

    secondStore.deleteCache("agents");
    expect(secondStore.getCache("agents")).toBeNull();
    secondDb.close();
  });
});

describe("EventStore idempotent event ingestion", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function makeStore(): { store: EventStore; close: () => void } {
    directory = mkdtempSync(path.join(tmpdir(), "marc-idempotent-"));
    const dbPath = path.join(directory, "events.db");
    const db = openDatabase(dbPath);
    const store = new EventStore(db);
    return { store, close: () => db.close() };
  }

  function sampleEvents(ledger: number) {
    return [
      {
        ledger,
        txHash: "0xabc",
        opIndex: 0,
        eventIndex: 0,
        contractId: "C1",
        topic: "transfer",
        value: '{"amount":"1"}',
        timestamp: 1000,
      },
      {
        ledger,
        txHash: "0xabc",
        opIndex: 0,
        eventIndex: 1,
        contractId: "C1",
        topic: "mint",
        value: '{"amount":"2"}',
        timestamp: 1000,
      },
      {
        ledger,
        txHash: "0xdef",
        opIndex: 1,
        eventIndex: 0,
        contractId: "C2",
        topic: "transfer",
        value: '{"amount":"3"}',
        timestamp: 1001,
      },
    ];
  }

  it("re-ingesting the same ledger range produces zero new rows", () => {
    const { store, close } = makeStore();
    try {
      const events = sampleEvents(42);
      const firstInserted = store.insertEvents(events);
      expect(firstInserted).toBe(3);
      expect(store.countEvents()).toBe(3);

      const secondInserted = store.insertEvents(events);
      expect(secondInserted).toBe(0);
      expect(store.countEvents()).toBe(3);

      const thirdInserted = store.insertEvents(events);
      expect(thirdInserted).toBe(0);
      expect(store.countEvents()).toBe(3);
    } finally {
      close();
    }
  });

  it("re-ingesting a range with overlapping and new events only inserts new rows", () => {
    const { store, close } = makeStore();
    try {
      const firstBatch = sampleEvents(42);
      expect(store.insertEvents(firstBatch)).toBe(3);

      const overlapping = [
        ...firstBatch,
        {
          ledger: 43,
          txHash: "0x123",
          opIndex: 0,
          eventIndex: 0,
          contractId: "C3",
          topic: "transfer",
          value: '{"amount":"4"}',
          timestamp: 1002,
        },
      ];
      expect(store.insertEvents(overlapping)).toBe(1);
      expect(store.countEvents()).toBe(4);
    } finally {
      close();
    }
  });

  it("treats events differing only by event index as distinct rows", () => {
    const { store, close } = makeStore();
    try {
      const events = sampleEvents(42);
      expect(store.insertEvents(events)).toBe(3);

      const sameTxDifferentIndex = [
        {
          ledger: 42,
          txHash: "0xabc",
          opIndex: 0,
          eventIndex: 2,
          contractId: "C1",
          topic: "burn",
          value: '{"amount":"5"}',
          timestamp: 1000,
        },
      ];
      expect(store.insertEvents(sameTxDifferentIndex)).toBe(1);
      expect(store.countEvents()).toBe(4);
    } finally {
      close();
    }
  });

  it("persists idempotency across database connections", () => {
    directory = mkdtempSync(path.join(tmpdir(), "marc-idempotent-persist-"));
    const dbPath = path.join(directory, "events.db");
    const firstDb = openDatabase(dbPath);
    const firstStore = new EventStore(firstDb);
    const events = sampleEvents(7);
    expect(firstStore.insertEvents(events)).toBe(3);
    firstDb.close();

    const secondDb = openDatabase(dbPath);
    const secondStore = new EventStore(secondDb);
    expect(secondStore.insertEvents(events)).toBe(0);
    expect(secondStore.countEvents()).toBe(3);
    secondDb.close();
  });
});

describe("EventStore cursor-paginated queries", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function makeStore(): { store: EventStore; close: () => void } {
    directory = mkdtempSync(path.join(tmpdir(), "marc-pagination-"));
    const dbPath = path.join(directory, "events.db");
    const db = openDatabase(dbPath);
    const store = new EventStore(db);
    return { store, close: () => db.close() };
  }

  function seedEvents(store: EventStore, count: number) {
    const events = [];
    for (let i = 0; i < count; i += 1) {
      events.push({
        ledger: 100 + i,
        txHash: `0x${i.toString(16).padStart(4, "0")}`,
        opIndex: 0,
        eventIndex: 0,
        contractId: "C1",
        topic: "transfer",
        value: `{"i":${i}}`,
        timestamp: 2000 + i,
      });
    }
    store.insertEvents(events);
  }

  it("returns a bounded page of events with a next cursor", () => {
    const { store, close } = makeStore();
    try {
      seedEvents(store, 10);
      const page = store.listEvents({ limit: 3 });
      expect(page.items).toHaveLength(3);
      expect(page.nextCursor).not.toBeNull();

      const secondPage = store.listEvents({ limit: 3, cursor: page.nextCursor ?? undefined });
      expect(secondPage.items).toHaveLength(3);
      const firstIds = new Set(page.items.map((e) => e.id));
      for (const item of secondPage.items) {
        expect(firstIds.has(item.id)).toBe(false);
      }
    } finally {
      close();
    }
  });

  it("walks all events via cursors without duplicates or gaps", () => {
    const { store, close } = makeStore();
    try {
      seedEvents(store, 7);
      const seen: number[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i += 1) {
        const page = store.listEvents({ limit: 2, cursor });
        for (const item of page.items) seen.push(item.id);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
    } finally {
      close();
    }
  });

  it("returns a null cursor on the final page", () => {
    const { store, close } = makeStore();
    try {
      seedEvents(store, 2);
      const page = store.listEvents({ limit: 5 });
      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBeNull();
    } finally {
      close();
    }
  });

  it("clamps the limit to a maximum bound", () => {
    const { store, close } = makeStore();
    try {
      seedEvents(store, 5);
      const page = store.listEvents({ limit: 10_000 });
      expect(page.items.length).toBeLessThanOrEqual(store.maxPageSize);
    } finally {
      close();
    }
  });

  it("returns an empty page for an empty store", () => {
    const { store, close } = makeStore();
    try {
      const page = store.listEvents({ limit: 10 });
      expect(page.items).toHaveLength(0);
      expect(page.nextCursor).toBeNull();
    } finally {
      close();
    }
  });

  it("returns reputation for an agent with cursor pagination", () => {
    const { store, close } = makeStore();
    try {
      for (let i = 0; i < 5; i += 1) {
        store.insertReputation({
          agentId: "agent-1",
          jobId: `job-${i}`,
          score: 100 - i,
          timestamp: 3000 + i,
        });
      }
      store.insertReputation({
        agentId: "agent-2",
        jobId: "job-x",
        score: 50,
        timestamp: 3001,
      });

      const page = store.listReputation("agent-1", { limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).not.toBeNull();
      for (const item of page.items) {
        expect(item.agentId).toBe("agent-1");
      }

      const secondPage = store.listReputation("agent-1", {
        limit: 2,
        cursor: page.nextCursor ?? undefined,
      });
      expect(secondPage.items).toHaveLength(2);
      for (const item of secondPage.items) {
        expect(item.agentId).toBe("agent-1");
      }
    } finally {
      close();
    }
  });

  it("returns an empty reputation page for an unknown agent", () => {
    const { store, close } = makeStore();
    try {
      const page = store.listReputation("missing-agent", { limit: 10 });
      expect(page.items).toHaveLength(0);
      expect(page.nextCursor).toBeNull();
    } finally {
      close();
    }
  });

  it("returns a job by id and null for unknown jobs", () => {
    const { store, close } = makeStore();
    try {
      store.insertJob({
        jobId: "job-1",
        agentId: "agent-1",
        status: "completed",
        createdAt: 4000,
        updatedAt: 4001,
      });

      const job = store.getJob("job-1");
      expect(job).not.toBeNull();
      expect(job?.jobId).toBe("job-1");
      expect(job?.status).toBe("completed");

      expect(store.getJob("does-not-exist")).toBeNull();
    } finally {
      close();
    }
  });
});