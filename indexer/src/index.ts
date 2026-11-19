import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import {
  openDatabase,
  openReadOnlyDatabase,
  EventStore,
  runMigrations,
  type QueryOptions,
  type ParsedEventRow,
  type MigrationOptions,
  type MigrationResult,
} from "./db.js";
import { SorobanEventPoller, type PollerOptions } from "./poller.js";
import { EventHub, type EventFilter } from "./events.js";
import {
  initTracing,
  shutdownTracing,
  withSpan,
  type TracingConfig,
} from "./tracing.js";
import {
  ReputationEngine,
  type AgentReputation,
  type ReputationBreakdown,
} from "./reputation.js";
import {
  createRestHandler,
  type RestHandlerDeps,
} from "./rest.js";

export type { QueryOptions, ParsedEventRow, MigrationOptions, MigrationResult };

export type BearEventIndexerConfig = {
  /** Soroban RPC URL */
  rpcUrl: string;
  /** Identity contract address */
  identityContract: string;
  /** Commerce contract address */
  commerceContract: string;
  /** Path to the SQLite database file. Default: "./data/events.db" */
  dbPath?: string;
  /** Port for the reputation/events HTTP API. 0 disables the API. */
  apiPort?: number;
  /** Host for the HTTP API. Default: "127.0.0.1" */
  apiHost?: string;
  /** OpenTelemetry tracing configuration. */
  tracing?: TracingConfig;
  /** Ledger to start indexing from on first run. Default: 0 (chain origin) */
  startLedger?: number;
  /** Polling options */
  polling?: PollerOptions;
  /**
   * Migration options applied at startup. `openDatabase` runs pending
   * migrations by default; set `dryRun` to preview without applying, or
   * `rollbackTo` to revert to a previous schema version.
   */
  migrations?: MigrationOptions;
};

/**
 * High-level facade for the Bear Protocol event indexer.
 *
 * @example
 * ```typescript
 * import { BearEventIndexer } from "bear-event-indexer";
 *
 * const indexer = new BearEventIndexer({
 *   rpcUrl: "https://soroban-testnet.stellar.org",
 *   identityContract: "CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5",
 *   commerceContract: "CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE",
 *   dbPath: "./data/events.db",
 *   startLedger: 1_000_000,
 * });
 *
 * await indexer.start();
 * const jobs = await indexer.getJobsByProvider(providerAddress, { limit: 20 });
 * ```
 */
export class BearEventIndexer {
  private readonly store: EventStore;
  private readonly readStore: EventStore;
  private readonly poller: SorobanEventPoller;
  private readonly migrationResult: MigrationResult;
  private readonly reputation: ReputationEngine;
  private readonly hub: EventHub;
  private readonly apiPort: number;
  private readonly apiHost: string;
  private server: Server | null = null;

  constructor(config: BearEventIndexerConfig) {
    // Initialize OpenTelemetry before any instrumented work begins.
    initTracing(config.tracing);

    const dbPath = config.dbPath ?? "./data/events.db";
    const startLedger = config.startLedger ?? 0;

    // openDatabase runs pending migrations (unless disabled) and throws if a
    // migration fails, halting startup before any indexing begins.
    const db = openDatabase(dbPath, config.migrations);
    this.migrationResult = runMigrations(db, config.migrations);
    this.store = new EventStore(db);
    // Dashboard-facing reads go through a dedicated read-only handle to avoid
    // contending with the poller's write lock.
    const readDb = openReadOnlyDatabase(dbPath);
    this.readStore = new EventStore(readDb);
    this.reputation = new ReputationEngine(readDb);
    this.apiPort = config.apiPort ?? 0;
    this.apiHost = config.apiHost ?? "127.0.0.1";
    this.hub = new EventHub();

    const rpcServer = new StellarRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });

    const contracts = [config.identityContract, config.commerceContract].filter(
      (c) => c && c.trim() !== "",
    );

    this.poller = new SorobanEventPoller(rpcServer, this.store, contracts, startLedger, {
      ...config.polling,
      onEvents: (events) => this.hub.publish(events),
    });
  }

  /** Start continuous indexing. Resolves once the first poll completes. */
  async start(): Promise<void> {
    await withSpan("indexer.start", async () => {
      await this.poller.start();
    });
    if (this.apiPort > 0) {
      await this.startApi();
    }
  }

  /** Returns the outcome of the migrations applied during construction. */
  getMigrationResult(): MigrationResult {
    return this.migrationResult;
  }

  /** Stop the indexer gracefully. */
  stop(): void {
    this.poller.stop();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    void shutdownTracing();
  }

  // ── Reputation API ─────────────────────────────────────────────────────────

  /** Start the reputation/events HTTP API on the configured port. */
  async startApi(): Promise<void> {
    if (this.server) return;
    const restDeps: RestHandlerDeps = {
      store: this.readStore,
      reputation: this.reputation,
    };
    const restHandler = createRestHandler(restDeps);
    const reputationHandler = createReputationHandler(this.reputation);
    const server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/api/events/stream") {
        handleEventsStream(req, res, this.hub, this.readStore);
        return;
      }
      // REST routes (/api/events, /api/agents/:id/reputation, /api/jobs/:id)
      // take precedence; fall back to the legacy reputation handler.
      if (restHandler(req, res)) return;
      reputationHandler(req, res);
    });
    this.server = server;
    this.hub.attachWebSocket(server, "/events");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.apiPort, this.apiHost, () => resolve());
    });
  }

  /** Returns the reputation score and breakdown for an agent. */
  getReputation(agentId: string): AgentReputation {
    return this.reputation.getReputation(agentId);
  }

  /** Release any resources held by the storage adapter (e.g. DB pool). */
  async close(): Promise<void> {
    await this.store.close?.();
  }

  // ── Query API ──────────────────────────────────────────────────────────────

  /**
   * Retrieve events where the `provider` field in the payload matches the
   * given address. Matches JobCreated, JobCompleted, etc.
   */
  getJobsByProvider(provider: string, opts?: QueryOptions): ParsedEventRow[] {
    return this.readStore.getByProvider(provider, opts);
  }

  /**
   * Retrieve events where the `client` field in the payload matches the
   * given address.
   */
  getJobsByClient(client: string, opts?: QueryOptions): ParsedEventRow[] {
    return this.readStore.getByClient(client, opts);
  }

  /**
   * Retrieve events filtered by a specific event type, e.g. "JobCreated".
   */
  getEventsByType(eventType: string, opts?: QueryOptions): ParsedEventRow[] {
    return this.readStore.getByEventType(eventType, opts);
  }

  /**
   * Retrieve all events within a Unix timestamp range (seconds, inclusive).
   */
  getEventsByDateRange(from: number, to: number, opts?: QueryOptions): ParsedEventRow[] {
    return this.readStore.getByDateRange(from, to, opts);
  }

  /** Returns the last indexed ledger sequence number, or null if none yet. */
  getLastIndexedLedger(): number | null {
    return this.readStore.getLastIndexedLedger();
  }

  /** Returns the total number of indexed events. */
  totalEvents(): number {
    return this.readStore.count();
  }
}

// ── SSE events stream ────────────────────────────────────────────────────────

const SSE_HEARTBEAT_MS = 30_000;

function parseEventFilter(url: string): EventFilter {
  const params = new URL(url, "http://localhost").searchParams;
  const filter: EventFilter = {};
  const contract = params.get("contract");
  const eventType = params.get("event_type");
  const address = params.get("address");
  if (contract) filter.contract = contract;
  if (eventType) filter.eventType = eventType;
  if (address) filter.address = address;
  return filter;
}

/**
 * Handles `GET /api/events/stream` (SSE). Supports `contract`, `event_type`
 * and `address` query filters, `Last-Event-ID` resume via DB replay, and a
 * 30s heartbeat comment to keep proxies from closing the connection.
 */
export function handleEventsStream(
  req: IncomingMessage,
  res: ServerResponse,
  hub: EventHub,
  store: EventStore,
): void {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const filter = parseEventFilter(req.url ?? "/");

  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders?.();

  // Resume from Last-Event-ID by replaying persisted events after that id.
  const lastEventId = req.headers["last-event-id"];
  if (typeof lastEventId === "string" && lastEventId.trim() !== "") {
    const sinceId = Number(lastEventId);
    if (Number.isFinite(sinceId)) {
      try {
        for (const row of store.getAfterId(sinceId, filter)) {
          res.write(formatSseMessage(row));
        }
      } catch {
        // Replay is best-effort; live streaming continues regardless.
      }
    }
  }

  const unsubscribe = hub.subscribe(filter, (event) => {
    res.write(formatSseMessage(event));
  });

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

function formatSseMessage(event: ParsedEventRow): string {
  return `id: ${event.id}\nevent: soroban_event\ndata: ${JSON.stringify(event)}\n\n`;
}

// ── Reputation HTTP handler ──────────────────────────────────────────────────

/**
 * Creates a Node HTTP request handler exposing:
 *   GET /api/agents/:id/reputation
 *
 * Returns the score breakdown and percentile rank from the reputation engine.
 */
export function createReputationHandler(
  reputation: ReputationEngine,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void withSpan("indexer.api.request", async (span) => {
      span.setAttribute("http.method", req.method ?? "");
      span.setAttribute("http.url", req.url ?? "");

      const url = req.url ?? "/";
      const match = /^\/api\/agents\/([^/]+)\/reputation\/?$/.exec(url.split("?")[0]);

      if (!match) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      if (req.method !== "GET") {
        res.statusCode = 405;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }

      const agentId = decodeURIComponent(match[1]);
      span.setAttribute("agent.id", agentId);

      try {
        const result = reputation.getReputation(agentId);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      } catch (err) {
        span.recordException(err as Error);
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    });
  };
}

// Re-export lower-level primitives for advanced use-cases
export { openDatabase, openReadOnlyDatabase, EventStore, runMigrations } from "./db.js";
export { SorobanEventPoller } from "./poller.js";
export { EventHub } from "./events.js";
export { ReputationEngine } from "./reputation.js";
export { initTracing, shutdownTracing, withSpan } from "./tracing.js";
export {
  createRestHandler,
  encodeCursor,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type RestHandlerDeps,
  type CursorPage,
} from "./rest.js";
