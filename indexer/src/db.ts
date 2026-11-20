import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";

const tracer = trace.getTracer("marc-indexer-db");

/**
 * Run `fn` inside an OpenTelemetry span.  Tracing is a no-op unless an SDK
 * tracer provider has been registered, so this is safe in tests.
 */
function withSpan<T>(name: string, fn: (span: Span) => T): T {
  return tracer.startActiveSpan(name, (span) => {
    try {
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

// ── Migration runner ─────────────────────────────────────────────────────────

export type Migration = {
  version: number;
  name: string;
  up: string;
  down: string;
};

export type RunMigrationsOptions = {
  /** Directory containing numbered `NNN_name.sql` migration files. */
  migrationsDir?: string;
  /** When true, report pending migrations without applying them. */
  dryRun?: boolean;
  /** Roll back the most recent `rollback` applied migrations (default 0). */
  rollback?: number;
};

export type MigrationResult = {
  applied: number[];
  rolledBack: number[];
  pending: number[];
  dryRun: boolean;
};

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

/**
 * Parses a migration file's contents into up/down sections.  The `down`
 * section is delimited by a line containing only `-- down` (case-insensitive).
 * If no delimiter is present the whole file is treated as the `up` section.
 */
export function parseMigrationSql(sql: string): { up: string; down: string } {
  const marker = /^\s*--\s*down\s*$/im;
  const match = marker.exec(sql);
  if (!match) {
    return { up: sql.trim(), down: "" };
  }
  const up = sql.slice(0, match.index).trim();
  const down = sql.slice(match.index + match[0].length).trim();
  return { up, down };
}

/**
 * Loads all numbered migration files from `dir`, sorted by version.  Files
 * must be named `<version>_<name>.sql` (e.g. `001_initial.sql`).
 */
export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/i.test(f))
    .sort((a, b) => {
      const va = Number(a.split("_")[0]);
      const vb = Number(b.split("_")[0]);
      return va - vb;
    });

  return files.map((file) => {
    const version = Number(file.split("_")[0]);
    const name = file.replace(/^\d+_/, "").replace(/\.sql$/i, "");
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    const { up, down } = parseMigrationSql(raw);
    return { version, name, up, down };
  });
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

function getAppliedVersions(db: Database.Database): number[] {
  const rows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all() as { version: number }[];
  return rows.map((r) => r.version);
}

/**
 * Applies pending migrations in order, each inside its own atomic transaction.
 * On failure the failing migration's transaction is rolled back and the error
 * is re-thrown so startup can halt.  Supports dry-run and rollback modes.
 */
export function runMigrations(
  db: Database.Database,
  options: RunMigrationsOptions = {},
): MigrationResult {
  const { migrationsDir = DEFAULT_MIGRATIONS_DIR, dryRun = false, rollback = 0 } = options;

  ensureMigrationsTable(db);
  const migrations = loadMigrations(migrationsDir);
  const applied = getAppliedVersions(db);
  const appliedSet = new Set(applied);

  const result: MigrationResult = {
    applied: [],
    rolledBack: [],
    pending: [],
    dryRun,
  };

  // ── Rollback mode ──────────────────────────────────────────────────────────
  if (rollback > 0) {
    const byVersion = new Map(migrations.map((m) => [m.version, m]));
    const toRollback = [...applied].sort((a, b) => b - a).slice(0, rollback);

    for (const version of toRollback) {
      const migration = byVersion.get(version);
      if (!migration) {
        throw new Error(`Cannot roll back migration ${version}: file not found`);
      }
      if (dryRun) {
        result.rolledBack.push(version);
        continue;
      }
      const tx = db.transaction(() => {
        if (migration.down) {
          db.exec(migration.down);
        }
        db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version);
      });
      tx();
      result.rolledBack.push(version);
    }
    return result;
  }

  // ── Forward mode ───────────────────────────────────────────────────────────
  const pending = migrations.filter((m) => !appliedSet.has(m.version));
  result.pending = pending.map((m) => m.version);

  if (dryRun) {
    return result;
  }

  for (const migration of pending) {
    const tx = db.transaction(() => {
      db.exec(migration.up);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, new Date().toISOString());
    });
    try {
      tx();
    } catch (err) {
      // better-sqlite3 rolls the transaction back automatically on throw.
      throw new Error(
        `Migration ${migration.version}_${migration.name} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    result.applied.push(migration.version);
  }

  return result;
}

/** Interval (ms) between passive WAL checkpoints. */
export const WAL_CHECKPOINT_INTERVAL_MS = 60_000;

/**
 * Applies the performance-oriented pragmas shared by the read-write and
 * read-only connections.  `synchronous = NORMAL` is safe under WAL and much
 * faster than FULL; `temp_store = MEMORY` keeps sorting/aggregation temp
 * tables off disk; `cache_size = -64000` requests a 64MB page cache.
 */
function applyCommonPragmas(db: Database.Database): void {
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -64000");
  db.pragma("busy_timeout = 5000");
}

/**
 * Initialises (or opens) the SQLite database, runs any pending migrations and
 * returns the connection.  Safe to call on every startup.
 *
 * A passive WAL checkpoint runs in the background every
 * {@link WAL_CHECKPOINT_INTERVAL_MS} to keep the `-wal` file bounded.  The
 * timer is `unref()`d so it never keeps the process alive, and it is cleared
 * automatically when the connection is closed.
 */
export function openDatabase(
  dbPath: string,
  options: RunMigrationsOptions = {},
): Database.Database {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);

  // WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applyCommonPragmas(db);

  runMigrations(db, options);

  // Passive background checkpointing keeps the WAL file small without
  // blocking active readers or the writer.
  const checkpointTimer = setInterval(() => {
    try {
      db.pragma("wal_checkpoint(PASSIVE)");
    } catch {
      // The connection may already be closed; ignore.
    }
  }, WAL_CHECKPOINT_INTERVAL_MS);
  if (typeof checkpointTimer.unref === "function") {
    checkpointTimer.unref();
  }

  const originalClose = db.close.bind(db);
  db.close = ((...args: Parameters<Database.Database["close"]>) => {
    clearInterval(checkpointTimer);
    return originalClose(...args);
  }) as Database.Database["close"];

  return db;
}

/**
 * Opens a dedicated read-only connection for dashboard/server queries so that
 * long-running reads never contend with the indexer's write lock.  The caller
 * owns the returned handle and is responsible for closing it.
 */
export function getReadOnlyDb(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  applyCommonPragmas(db);
  return db;
}

// ── Prepared statement helpers ───────────────────────────────────────────────

export type EventRow = {
  id: number;
  ledger: number;
  ledger_hash: string | null;
  timestamp: number;
  contract: string;
  event_type: string;
  payload: string;
  /** Unique-key components (issue #980); may be absent on legacy rows. */
  tx_hash?: string | null;
  op_index?: number | null;
  event_index?: number | null;
};

export type ParsedEventRow = Omit<EventRow, "payload"> & { payload: Record<string, unknown> };

function parseRow(row: EventRow): ParsedEventRow {
  return { ...row, payload: JSON.parse(row.payload) as Record<string, unknown> };
}

export type InsertEventParams = {
  ledger: number;
  /** Hash of the ledger the event was emitted in (used for reorg detection). */
  ledger_hash?: string | null;
  timestamp: number;
  contract: string;
  event_type: string;
  payload: Record<string, unknown>;
};

export type QueryOptions = {
  limit?: number;
  offset?: number;
  fromTimestamp?: number;
  toTimestamp?: number;
};

/** Maximum number of rows any cursor-paginated query may return. */
export const MAX_PAGE_LIMIT = 100;
/** Default page size for cursor-paginated queries. */
export const DEFAULT_PAGE_LIMIT = 20;

/**
 * Opaque cursor for keyset pagination.  Encodes the unique event key
 * `(ledger, tx_hash, op_index, event_index)` so ordering is stable even when
 * multiple events share a ledger.
 */
export type EventCursor = {
  ledger: number;
  tx_hash: string;
  op_index: number;
  event_index: number;
};

/** Encode a cursor as an opaque, URL-safe string. */
export function encodeCursor(cursor: EventCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor string.  Returns `null` when the value is missing or
 * malformed so callers can respond with a 400 rather than crashing.
 */
export function decodeCursor(raw: string | null | undefined): EventCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<EventCursor>;
    if (
      typeof parsed.ledger !== "number" ||
      typeof parsed.tx_hash !== "string" ||
      typeof parsed.op_index !== "number" ||
      typeof parsed.event_index !== "number"
    ) {
      return null;
    }
    return {
      ledger: parsed.ledger,
      tx_hash: parsed.tx_hash,
      op_index: parsed.op_index,
      event_index: parsed.event_index,
    };
  } catch {
    return null;
  }
}

/** Clamp a requested page size into `[1, MAX_PAGE_LIMIT]`. */
export function clampPageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_PAGE_LIMIT) return MAX_PAGE_LIMIT;
  return n;
}

/** A single page of events plus the cursor to fetch the next page. */
export type EventPage = {
  events: ParsedEventRow[];
  /** Cursor to pass as `cursor` for the next page, or null at the end. */
  nextCursor: string | null;
};

/** Filters accepted by {@link EventStore.listEventsPage}. */
export type EventPageFilters = {
  contract?: string;
  event_type?: string;
  fromTimestamp?: number;
  toTimestamp?: number;
};

/** Aggregated on-chain job metrics for a single agent (issue #729). */
export type AgentJobMetrics = {
  agent_id: string;
  total_jobs: number;
  completed_jobs: number;
  cancelled_jobs: number;
  disputed_jobs: number;
  avg_completion_time_secs: number | null;
};

export type ReputationRow = {
  agent_id: string;
  score: number;
  breakdown: Record<string, unknown>;
  updated_at: number;
  /** Version of the scoring algorithm that produced `score` (issue #983). */
  scoring_version: number;
};

/** Default scoring version stamped on reputation rows (issue #983). */
export const DEFAULT_SCORING_VERSION = 1;

/**
 * Maximum number of events inserted per IMMEDIATE transaction by
 * {@link EventStore.insertEventsBatch} (issue #982).  Larger batches are
 * split into chunks of this size so the write lock is never held for an
 * unbounded amount of time.
 */
export const INSERT_BATCH_SIZE = 500;

/** Callback invoked with each freshly inserted event (see issue #719). */
export type EventEmitHook = (event: InsertEventParams) => void;

export class EventStore {
  private db: Database.Database;

  private stmtInsert: Database.Statement;
  private stmtGetState: Database.Statement;
  private stmtSetState: Database.Statement;
  private stmtUpsertReputation: Database.Statement;
  private stmtGetReputation: Database.Statement;
  private stmtGetAllReputations: Database.Statement;
  private stmtGetReputationVersion: Database.Statement;
  private stmtDeleteFromLedger: Database.Statement;
  private stmtGetCache: Database.Statement;
  private stmtSetCache: Database.Statement;
  private stmtDeleteCache: Database.Statement;

  private emitHook: EventEmitHook | null = null;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtInsert = db.prepare(`
      INSERT INTO events (ledger, ledger_hash, timestamp, contract, event_type, payload)
      VALUES (@ledger, @ledger_hash, @timestamp, @contract, @event_type, @payload)
    `);

    this.stmtGetState = db.prepare(
      `SELECT value FROM indexer_state WHERE key = ?`,
    );

    this.stmtSetState = db.prepare(`
      INSERT INTO indexer_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    this.stmtUpsertReputation = db.prepare(`
      INSERT INTO agent_reputation (agent_id, score, breakdown, updated_at, scoring_version)
      VALUES (@agent_id, @score, @breakdown, @updated_at, @scoring_version)
      ON CONFLICT(agent_id) DO UPDATE SET
        score           = excluded.score,
        breakdown       = excluded.breakdown,
        updated_at      = excluded.updated_at,
        scoring_version = excluded.scoring_version
    `);

    this.stmtGetReputation = db.prepare(
      `SELECT * FROM agent_reputation WHERE agent_id = ?`,
    );

    this.stmtGetAllReputations = db.prepare(
      `SELECT * FROM agent_reputation ORDER BY score DESC`,
    );

    this.stmtGetReputationVersion = db.prepare(
      `SELECT scoring_version FROM agent_reputation WHERE agent_id = ?`,
    );

    this.stmtDeleteFromLedger = db.prepare(
      `DELETE FROM events WHERE ledger >= ?`,
    );
    this.stmtGetCache = db.prepare(
      `SELECT value, updated_at FROM dashboard_cache WHERE cache_key = ?`,
    );
    this.stmtSetCache = db.prepare(`
      INSERT INTO dashboard_cache (cache_key, value, updated_at)
      VALUES (@cache_key, @value, @updated_at)
      ON CONFLICT(cache_key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    this.stmtDeleteCache = db.prepare(
      `DELETE FROM dashboard_cache WHERE cache_key = ?`,
    );
  }

  /** Fetch a persisted dashboard cache entry, or null when it is absent. */
  getCache(key: string): { value: string; updatedAt: number } | null {
    const row = this.stmtGetCache.get(key) as
      | { value: string; updated_at: number }
      | undefined;
    return row ? { value: row.value, updatedAt: row.updated_at } : null;
  }

  /** Atomically persist a serialized dashboard cache entry. */
  setCache(key: string, value: string, updatedAt: number): void {
    this.stmtSetCache.run({
      cache_key: key,
      value,
      updated_at: updatedAt,
    });
  }

  /** Remove a persisted dashboard cache entry after an on-chain mutation. */
  deleteCache(key: string): void {
    this.stmtDeleteCache.run(key);
  }

  /**
   * Registers a hook invoked after each successful batch insert so the poller
   * can broadcast new events through the EventHub (issue #719).
   */
  setEventEmitHook(hook: EventEmitHook | null): void {
    this.emitHook = hook;
  }

  /**
   * Bulk-insert events inside IMMEDIATE transactions (issue #982).
   *
   * Rows are inserted with the prepared `stmtInsert` statement in chunks of at
   * most {@link INSERT_BATCH_SIZE} events.  Each chunk commits atomically — if
   * any insert in a chunk fails the whole chunk is rolled back and the error is
   * re-thrown, so callers observe the same all-or-nothing behaviour per chunk
   * as before.  Using BEGIN IMMEDIATE acquires the write lock up-front,
   * avoiding deadlocks between concurrent writer processes.
   */
  insertEventsBatch(events: InsertEventParams[]): void {
    if (events.length === 0) return;

    const run = this.db.transaction((rows: InsertEventParams[]) => {
      for (const row of rows) {
        this.stmtInsert.run({
          ledger: row.ledger,
          ledger_hash: row.ledger_hash ?? null,
          timestamp: row.timestamp,
          contract: row.contract,
          event_type: row.event_type,
          payload: JSON.stringify(row.payload),
        });
      }
    });

    // better-sqlite3's transaction() uses BEGIN; force IMMEDIATE semantics by
    // taking the write lock before the transaction body runs.
    this.db.pragma("busy_timeout = 5000");

    for (let i = 0; i < events.length; i += INSERT_BATCH_SIZE) {
      const chunk = events.slice(i, i + INSERT_BATCH_SIZE);
      run.immediate(chunk);
    }

    if (this.emitHook) {
      for (const row of events) {
        try {
          this.emitHook(row);
        } catch {
          // A misbehaving subscriber must never break ingestion.
        }
      }
    }
  }

  /**
   * Deletes every event at or above `ledger`.  Used by the reorg rollback
   * logic (issue #720) to purge orphaned events from invalidated ledgers.
   * Returns the number of rows removed.
   */
  deleteEventsFromLedger(ledger: number): number {
    return withSpan("db.events.deleteFromLedger", (span) => {
      span.setAttribute("db.system", "sqlite");
      span.setAttribute("indexer.ledger", ledger);
      const info = this.stmtDeleteFromLedger.run(ledger);
      span.setAttribute("db.rows.deleted", info.changes);
      return info.changes;
    });
  }

  /** Bulk-insert events inside a single transaction. */
  insertMany(events: InsertEventParams[]): void {
    this.insertEventsBatch(events);
  }

  getLastIndexedLedger(): number | null {
    return withSpan("db.indexer_state.getLastLedger", (span) => {
      span.setAttribute("db.system", "sqlite");
      const row = this.stmtGetState.get("last_ledger") as
        | { value: string }
        | undefined;
      return row ? Number(row.value) : null;
    });
  }

  setLastIndexedLedger(ledger: number): void {
    withSpan("db.indexer_state.setLastLedger", (span) => {
      span.setAttribute("db.system", "sqlite");
      span.setAttribute("indexer.ledger", ledger);
      this.stmtSetState.run("last_ledger", String(ledger));
    });
  }

  /** Returns the stored hash of the last indexed ledger, if any (#720). */
  getLedgerHash(): string | null {
    return withSpan("db.indexer_state.getLedgerHash", (span) => {
      span.setAttribute("db.system", "sqlite");
      const row = this.stmtGetState.get("ledger_hash") as
        | { value: string }
        | undefined;
      return row ? row.value : null;
    });
  }

  /** Stores the hash of the last indexed ledger for reorg detection (#720). */
  setLedgerHash(hash: string): void {
    withSpan("db.indexer_state.setLedgerHash", (span) => {
      span.setAttribute("db.system", "sqlite");
      this.stmtSetState.run("ledger_hash", hash);
    });
  }

  /** Alias of {@link getLedgerHash} used by the reorg logic. */
  getIndexedLedgerHash(): string | null {
    return this.getLedgerHash();
  }

  /** Alias of {@link setLedgerHash} used by the reorg logic. */
  setIndexedLedgerHash(hash: string): void {
    this.setLedgerHash(hash);
  }

  // ── Reputation API (issue #729) ────────────────────────────────────────────

  /**
   * Insert or update the cached reputation record for an agent.  The
   * `scoringVersion` is persisted alongside the score so consumers can tell
   * which algorithm produced it (issue #983).
   */
  upsertReputation(
    agentId: string,
    score: number,
    breakdown: Record<string, unknown>,
    updatedAt: number = Date.now(),
    scoringVersion: number = DEFAULT_SCORING_VERSION,
  ): void {
    withSpan("db.agent_reputation.upsert", (span) => {
      span.setAttribute("db.system", "sqlite");
      span.setAttribute("agent.id", agentId);
      span.setAttribute("agent.score", score);
      span.setAttribute("agent.scoring_version", scoringVersion);
      this.stmtUpsertReputation.run({
        agent_id: agentId,
        score,
        breakdown: JSON.stringify(breakdown),
        updated_at: updatedAt,
        scoring_version: scoringVersion,
      });
    });
  }

  /** Returns the stored scoring version for an agent, or null if unknown. */
  getReputationScoringVersion(agentId: string): number | null {
    const row = this.stmtGetReputationVersion.get(agentId) as
      | { scoring_version: number | null }
      | undefined;
    if (!row || row.scoring_version === null || row.scoring_version === undefined) {
      return null;
    }
    return row.scoring_version;
  }

  /** Fetch a single agent's cached reputation, or null if unknown. */
  getReputation(agentId: string): ReputationRow | null {
    return withSpan("db.agent_reputation.get", (span) => {
      span.setAttribute("db.system", "sqlite");
      span.setAttribute("agent.id", agentId);
      const row = this.stmtGetReputation.get(agentId) as
        | {
            agent_id: string;
            score: number;
            breakdown: string;
            updated_at: number;
          }
        | undefined;
      if (!row) return null;
      return {
        agent_id: row.agent_id,
        score: row.score,
        breakdown: JSON.parse(row.breakdown) as Record<string, unknown>,
        updated_at: row.updated_at,
        scoring_version:
          (row as { scoring_version?: number | null }).scoring_version ??
          DEFAULT_SCORING_VERSION,
      };
    });
  }

  /** Fetch all cached reputations, ordered by score descending. */
  getAllReputations(): ReputationRow[] {
    return withSpan("db.agent_reputation.getAll", (span) => {
      span.setAttribute("db.system", "sqlite");
      const rows = this.stmtGetAllReputations.all() as {
        agent_id: string;
        score: number;
        breakdown: string;
        updated_at: number;
      }[];
      span.setAttribute("db.rows.count", rows.length);
      return rows.map((row) => ({
        agent_id: row.agent_id,
        score: row.score,
        breakdown: JSON.parse(row.breakdown) as Record<string, unknown>,
        updated_at: row.updated_at,
        scoring_version:
          (row as { scoring_version?: number | null }).scoring_version ??
          DEFAULT_SCORING_VERSION,
      }));
    });
  }

  /**
   * Aggregate on-chain job metrics per agent from the events table.
   *
   * Counts `JobCreated`, `JobCompleted`, `JobCancelled` and `JobDisputed`
   * events (case-insensitive, tolerant of snake_case / camelCase variants)
   * and computes the average completion time in seconds between the
   * `JobCreated` and `JobCompleted` events for the same job id.
   *
   * When `agentId` is provided only that agent's metrics are returned.
   */
  getAgentJobMetrics(agentId?: string): AgentJobMetrics[] {
    return withSpan("db.events.aggregateAgentMetrics", (span) => {
      span.setAttribute("db.system", "sqlite");
      if (agentId) span.setAttribute("agent.id", agentId);

      // Normalise the event type to a lowercase, underscore-free form so that
      // `JobCompleted`, `job_completed` and `jobCompleted` all match.
      const typeExpr = `lower(replace(replace(event_type, '_', ''), ' ', ''))`;

      // Agent id may be stored under `provider`, `provider_id`, `providerId`
      // or `agent` depending on the emitting contract.
      const agentExpr = `COALESCE(
        json_extract(payload, '$.provider'),
        json_extract(payload, '$.provider_id'),
        json_extract(payload, '$.providerId'),
        json_extract(payload, '$.agent'),
        json_extract(payload, '$.agent_id')
      )`;

      const jobIdExpr = `COALESCE(
        json_extract(payload, '$.job_id'),
        json_extract(payload, '$.jobId'),
        json_extract(payload, '$.job')
      )`;

      const filter = agentId ? " AND " + agentExpr + " = ?" : "";
      const params: (string | number)[] = agentId ? [agentId] : [];

      const countSql = `
        SELECT
          ${agentExpr} AS agent_id,
          COUNT(*) AS total_jobs,
          SUM(CASE WHEN ${typeExpr} = 'jobcompleted' THEN 1 ELSE 0 END) AS completed_jobs,
          SUM(CASE WHEN ${typeExpr} = 'jobcancelled' THEN 1 ELSE 0 END) AS cancelled_jobs,
          SUM(CASE WHEN ${typeExpr} = 'jobdisputed'  THEN 1 ELSE 0 END) AS disputed_jobs
        FROM events
        WHERE ${agentExpr} IS NOT NULL
          AND ${typeExpr} IN ('jobcreated', 'jobcompleted', 'jobcancelled', 'jobdisputed')
          ${filter}
        GROUP BY ${agentExpr}
      `;

      const counts = this.db.prepare(countSql).all(...params) as {
        agent_id: string;
        total_jobs: number;
        completed_jobs: number | null;
        cancelled_jobs: number | null;
        disputed_jobs: number | null;
      }[];

      // Average completion time: pair JobCreated -> JobCompleted per job id.
      const timingSql = `
        SELECT
          ${agentExpr} AS agent_id,
          ${jobIdExpr} AS job_id,
          MIN(CASE WHEN ${typeExpr} = 'jobcreated'   THEN timestamp END) AS created_at,
          MIN(CASE WHEN ${typeExpr} = 'jobcompleted' THEN timestamp END) AS completed_at
        FROM events
        WHERE ${agentExpr} IS NOT NULL
          AND ${jobIdExpr} IS NOT NULL
          AND ${typeExpr} IN ('jobcreated', 'jobcompleted')
          ${filter}
        GROUP BY ${agentExpr}, ${jobIdExpr}
        HAVING created_at IS NOT NULL AND completed_at IS NOT NULL
      `;

      const timings = this.db.prepare(timingSql).all(...params) as {
        agent_id: string;
        job_id: string | number;
        created_at: number;
        completed_at: number;
      }[];

      const durations = new Map<string, number[]>();
      for (const t of timings) {
        // Timestamps are stored in milliseconds; convert to seconds.
        const secs = Math.max(0, (t.completed_at - t.created_at) / 1000);
        const list = durations.get(t.agent_id) ?? [];
        list.push(secs);
        durations.set(t.agent_id, list);
      }

      const result: AgentJobMetrics[] = counts.map((c) => {
        const list = durations.get(c.agent_id) ?? [];
        const avg =
          list.length > 0
            ? list.reduce((a, b) => a + b, 0) / list.length
            : null;
        return {
          agent_id: c.agent_id,
          total_jobs: c.total_jobs,
          completed_jobs: c.completed_jobs ?? 0,
          cancelled_jobs: c.cancelled_jobs ?? 0,
          disputed_jobs: c.disputed_jobs ?? 0,
          avg_completion_time_secs: avg,
        };
      });

      span.setAttribute("db.agents.count", result.length);
      return result;
    });
  }

  // ── DatabaseAdapter implementation ─────────────────────────────────────────

  getIndexerState(): number | null {
    return this.getLastIndexedLedger();
  }

  setIndexerState(ledger: number): void {
    this.setLastIndexedLedger(ledger);
  }

  /**
   * Generic event query.  Applies the optional timestamp range and
   * pagination from `QueryOptions`, ordered by ledger descending.
   */
  getEvents(opts: QueryOptions = {}): ParsedEventRow[] {
    const { limit = 20, offset = 0, fromTimestamp, toTimestamp } = opts;
    let sql = `SELECT * FROM events WHERE 1 = 1`;
    const params: (string | number)[] = [];
    if (fromTimestamp !== undefined) {
      sql += " AND timestamp >= ?";
      params.push(fromTimestamp);
    }
    if (toTimestamp !== undefined) {
      sql += " AND timestamp <= ?";
      params.push(toTimestamp);
    }
    sql += " ORDER BY ledger DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(parseRow);
  }

  // ── Query API ──────────────────────────────────────────────────────────────

  getByProvider(
    provider: string,
    opts: QueryOptions = {},
  ): ParsedEventRow[] {
    const { limit = 20, offset = 0, fromTimestamp, toTimestamp } = opts;
    let sql = `
      SELECT * FROM events
      WHERE json_extract(payload, '$.provider') = ?
    `;
    const params: (string | number)[] = [provider];
    if (fromTimestamp !== undefined) {
      sql += " AND timestamp >= ?";
      params.push(fromTimestamp);
    }
    if (toTimestamp !== undefined) {
      sql += " AND timestamp <= ?";
      params.push(toTimestamp);
    }
    sql += " ORDER BY ledger DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(parseRow);
  }

  getByClient(
    client: string,
    opts: QueryOptions = {},
  ): ParsedEventRow[] {
    const { limit = 20, offset = 0, fromTimestamp, toTimestamp } = opts;
    let sql = `
      SELECT * FROM events
      WHERE json_extract(payload, '$.client') = ?
    `;
    const params: (string | number)[] = [client];
    if (fromTimestamp !== undefined) {
      sql += " AND timestamp >= ?";
      params.push(fromTimestamp);
    }
    if (toTimestamp !== undefined) {
      sql += " AND timestamp <= ?";
      params.push(toTimestamp);
    }
    sql += " ORDER BY ledger DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(parseRow);
  }

  getByEventType(
    eventType: string,
    opts: QueryOptions = {},
  ): ParsedEventRow[] {
    const { limit = 20, offset = 0, fromTimestamp, toTimestamp } = opts;
    let sql = `SELECT * FROM events WHERE event_type = ?`;
    const params: (string | number)[] = [eventType];
    if (fromTimestamp !== undefined) {
      sql += " AND timestamp >= ?";
      params.push(fromTimestamp);
    }
    if (toTimestamp !== undefined) {
      sql += " AND timestamp <= ?";
      params.push(toTimestamp);
    }
    sql += " ORDER BY ledger DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(parseRow);
  }

  getByContract(
    contract: string,
    opts: QueryOptions = {},
  ): ParsedEventRow[] {
    const { limit = 20, offset = 0, fromTimestamp, toTimestamp } = opts;
    let sql = `SELECT * FROM events WHERE contract = ?`;
    const params: (string | number)[] = [contract];
    if (fromTimestamp !== undefined) {
      sql += " AND timestamp >= ?";
      params.push(fromTimestamp);
    }
    if (toTimestamp !== undefined) {
      sql += " AND timestamp <= ?";
      params.push(toTimestamp);
    }
    sql += " ORDER BY ledger DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(parseRow);
  }

  /**
   * Fetch events whose JSON payload contains the given job id under any of the
   * common key names used across the contracts (`job_id`, `jobId`, `job`).
   * Used by the E2E lifecycle test to assert that every event emitted for a
   * single job was persisted by the indexer.
   */
  getByJobId(
    jobId: string | number,
    opts: QueryOptions = {},
  ): ParsedEventRow[] {
    const { limit = 100, offset = 0, fromTimestamp, toTimestamp } = opts;
    const id = String(jobId);
    let sql = `
      SELECT * FROM events
      WHERE json_extract(payload, '$.job_id') = ?
         OR json_extract(payload, '$.jobId')  = ?
         OR json_extract(payload, '$.job')    = ?
    `;
    const params: (string | number)[] = [id, id, id];
    if (fromTimestamp !== undefined) {
      sql += " AND timestamp >= ?";
      params.push(fromTimestamp);
    }
    if (toTimestamp !== undefined) {
      sql += " AND timestamp <= ?";
      params.push(toTimestamp);
    }
    sql += " ORDER BY ledger ASC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(parseRow);
  }

  /**
   * Fetch events matching a job id AND a specific event type.  Convenience
   * wrapper used by the E2E test to assert individual lifecycle transitions
   * (e.g. `job_funded`, `job_completed`) were indexed.
   */
  getByJobIdAndType(
    jobId: string | number,
    eventType: string,
    opts: QueryOptions = {},
  ): ParsedEventRow[] {
    return this.getByJobId(jobId, opts).filter(
      (row) => row.event_type === eventType,
    );
  }

  getByDateRange(
    from: number,
    to: number,
    opts: QueryOptions = {},
  ): ParsedEventRow[] {
    const { limit = 50, offset = 0 } = opts;
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE timestamp BETWEEN ? AND ?
         ORDER BY ledger ASC
         LIMIT ? OFFSET ?`,
      )
      .all(from, to, limit, offset) as EventRow[];
    return rows.map(parseRow);
  }

  /** Total event count — useful for health/status checks. */
  count(): number {
    return withSpan("db.events.count", (span) => {
      span.setAttribute("db.system", "sqlite");
      const row = this.db
        .prepare("SELECT COUNT(*) as c FROM events")
        .get() as { c: number };
      return row.c;
    });
  }

  // ── Cursor pagination (issue #978) ─────────────────────────────────────────

  /**
   * Keyset-paginated event listing.  Always applies a bounded `LIMIT` (clamped
   * to {@link MAX_PAGE_LIMIT}) and orders by the unique event key
   * `(ledger, tx_hash, op_index, event_index)` so pages are stable and no
   * unbounded query is ever issued.
   */
  listEventsPage(
    cursor: EventCursor | null = null,
    limit?: number,
    filters: EventPageFilters = {},
  ): EventPage {
    return withSpan("db.events.listPage", (span) => {
      span.setAttribute("db.system", "sqlite");
      const pageSize = clampPageLimit(limit);
      span.setAttribute("db.page.limit", pageSize);

      let sql = `SELECT * FROM events WHERE 1 = 1`;
      const params: (string | number)[] = [];

      if (filters.contract !== undefined) {
        sql += " AND contract = ?";
        params.push(filters.contract);
      }
      if (filters.event_type !== undefined) {
        sql += " AND event_type = ?";
        params.push(filters.event_type);
      }
      if (filters.fromTimestamp !== undefined) {
        sql += " AND timestamp >= ?";
        params.push(filters.fromTimestamp);
      }
      if (filters.toTimestamp !== undefined) {
        sql += " AND timestamp <= ?";
        params.push(filters.toTimestamp);
      }
      if (cursor) {
        sql += ` AND (
          ledger > ?
          OR (ledger = ? AND COALESCE(tx_hash, '') > ?)
          OR (ledger = ? AND COALESCE(tx_hash, '') = ? AND COALESCE(op_index, 0) > ?)
          OR (ledger = ? AND COALESCE(tx_hash, '') = ? AND COALESCE(op_index, 0) = ? AND COALESCE(event_index, 0) > ?)
        )`;
        params.push(
          cursor.ledger,
          cursor.ledger,
          cursor.tx_hash,
          cursor.ledger,
          cursor.tx_hash,
          cursor.op_index,
          cursor.ledger,
          cursor.tx_hash,
          cursor.op_index,
          cursor.event_index,
        );
      }

      // Fetch one extra row to determine whether another page exists.
      sql += ` ORDER BY ledger ASC, COALESCE(tx_hash, '') ASC,
               COALESCE(op_index, 0) ASC, COALESCE(event_index, 0) ASC
               LIMIT ?`;
      params.push(pageSize + 1);

      const rows = this.db.prepare(sql).all(...params) as EventRow[];
      const hasMore = rows.length > pageSize;
      const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

      let nextCursor: string | null = null;
      if (hasMore && pageRows.length > 0) {
        const last = pageRows[pageRows.length - 1];
        nextCursor = encodeCursor({
          ledger: last.ledger,
          tx_hash: last.tx_hash ?? "",
          op_index: last.op_index ?? 0,
          event_index: last.event_index ?? 0,
        });
      }

      span.setAttribute("db.rows.count", pageRows.length);
      return { events: pageRows.map(parseRow), nextCursor };
    });
  }

  /**
   * Fetch a single job's events by job id, bounded by `limit` (clamped to
   * {@link MAX_PAGE_LIMIT}).  Returns `null` when no events reference the job.
   */
  getJobById(
    jobId: string | number,
    limit?: number,
  ): { job_id: string; events: ParsedEventRow[] } | null {
    return withSpan("db.events.getJobById", (span) => {
      span.setAttribute("db.system", "sqlite");
      span.setAttribute("job.id", String(jobId));
      const pageSize = clampPageLimit(limit);
      const id = String(jobId);
      const rows = this.db
        .prepare(
          `SELECT * FROM events
           WHERE json_extract(payload, '$.job_id') = ?
              OR json_extract(payload, '$.jobId')  = ?
              OR json_extract(payload, '$.job')    = ?
           ORDER BY ledger ASC, COALESCE(tx_hash, '') ASC,
                    COALESCE(op_index, 0) ASC, COALESCE(event_index, 0) ASC
           LIMIT ?`,
        )
        .all(id, id, id, pageSize) as EventRow[];
      if (rows.length === 0) return null;
      span.setAttribute("db.rows.count", rows.length);
      return { job_id: id, events: rows.map(parseRow) };
    });
  }
}
