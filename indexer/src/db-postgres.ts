// indexer/src/db-postgres.ts
import { Pool, PoolClient, QueryResult } from 'pg';

/**
 * DatabaseAdapter interface abstracting the storage operations used by the indexer.
 * Both SQLite (indexer/src/db.ts) and PostgreSQL (this file) implement this interface
 * so the indexer can function identically regardless of the backing store.
 */
export interface IndexerEvent {
  id?: number;
  provider: string;
  client: string;
  eventType: string;
  contract: string;
  jobId: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  data: string;
  createdAt?: string;
}

export interface EventQuery {
  provider?: string;
  client?: string;
  eventType?: string;
  contract?: string;
  jobId?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
  count?: boolean;
  /**
   * Cursor for keyset pagination. Only events strictly after the cursor
   * (ordered by block_number, log_index, id) are returned.
   */
  after?: EventCursor;
}

/** Keyset pagination cursor for the events table. */
export interface EventCursor {
  blockNumber: number;
  logIndex: number;
  id: number;
}

/** A page of events plus the cursor to fetch the next page (null when exhausted). */
export interface EventPage {
  events: IndexerEvent[];
  nextCursor: EventCursor | null;
}

export interface IndexerState {
  key: string;
  value: string;
  updatedAt?: string;
}

export interface DatabaseAdapter {
  insertEvent(event: IndexerEvent): Promise<IndexerEvent>;
  insertMany(events: IndexerEvent[]): Promise<number>;
  getEvents(query?: EventQuery): Promise<IndexerEvent[] | number>;
  /** Cursor-paginated event listing. Never unbounded: limit is clamped. */
  getEventsPage(query?: EventQuery): Promise<EventPage>;
  /** Fetch a single event by its unique (ledger, tx, op, event index) key. */
  getEventByKey(
    blockNumber: number,
    transactionHash: string,
    logIndex: number,
  ): Promise<IndexerEvent | null>;
  /** Fetch the most recent events for a job, bounded by `limit`. */
  getEventsByJob(jobId: string, limit?: number): Promise<IndexerEvent[]>;
  getIndexerState(key: string): Promise<IndexerState | null>;
  setIndexerState(key: string, value: string): Promise<void>;
  close(): Promise<void>;
}

/** Default and maximum page sizes for cursor pagination. */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/** Clamps a requested page limit into [1, MAX_PAGE_LIMIT]. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit)) {
    return DEFAULT_PAGE_LIMIT;
  }
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_PAGE_LIMIT) return MAX_PAGE_LIMIT;
  return n;
}

export interface PostgresAdapterOptions {
  connectionString?: string;
  /** Maximum number of clients in the pool. Defaults to 20 (env: PG_POOL_MAX). */
  max?: number;
  /** Minimum number of idle clients kept in the pool. Defaults to 2 (env: PG_POOL_MIN). */
  min?: number;
  /** Milliseconds a client may sit idle before being closed. Defaults to 30000. */
  idleTimeoutMillis?: number;
  /** Milliseconds to wait for a connection before failing. Defaults to 10000. */
  connectionTimeoutMillis?: number;
  /** Run migrations on initialization. Defaults to true. */
  runMigrations?: boolean;
  /** Optional logger. */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

const DEFAULT_MAX = 20;
const DEFAULT_MIN = 2;
const DEFAULT_IDLE_TIMEOUT = 30_000;
const DEFAULT_CONNECTION_TIMEOUT = 10_000;

/**
 * Idempotent migration scripts. Each statement is safe to run multiple times.
 * Kept inline so the adapter is self-contained; the same SQL is mirrored under
 * indexer/migrations/postgres/ for tooling that prefers external files.
 */
export const POSTGRES_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    provider TEXT NOT NULL,
    client TEXT NOT NULL,
    event_type TEXT NOT NULL,
    contract TEXT NOT NULL,
    job_id TEXT NOT NULL,
    block_number BIGINT NOT NULL,
    transaction_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    data TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique_log
    ON events (block_number, transaction_hash, log_index);`,
  // Migration for existing data: drop the old (tx, log_index) uniqueness so the
  // new (ledger, tx, op, event index) key can be enforced. Safe to re-run.
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname = 'idx_events_unique_log'
         AND indexdef NOT LIKE '%block_number%'
     ) THEN
       DROP INDEX idx_events_unique_log;
       CREATE UNIQUE INDEX idx_events_unique_log
         ON events (block_number, transaction_hash, log_index);
     END IF;
   END $$;`,
  `CREATE INDEX IF NOT EXISTS idx_events_provider ON events (provider);`,
  `CREATE INDEX IF NOT EXISTS idx_events_client ON events (client);`,
  `CREATE INDEX IF NOT EXISTS idx_events_event_type ON events (event_type);`,
  `CREATE INDEX IF NOT EXISTS idx_events_contract ON events (contract);`,
  `CREATE INDEX IF NOT EXISTS idx_events_job_id ON events (job_id);`,
  `CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_events_block_number ON events (block_number);`,
  `CREATE TABLE IF NOT EXISTS indexer_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
];

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}

function mapRow(row: Record<string, unknown>): IndexerEvent {
  return {
    id: row.id !== undefined && row.id !== null ? toNumber(row.id) : undefined,
    provider: String(row.provider),
    client: String(row.client),
    eventType: String(row.event_type),
    contract: String(row.contract),
    jobId: String(row.job_id),
    blockNumber: toNumber(row.block_number),
    transactionHash: String(row.transaction_hash),
    logIndex: toNumber(row.log_index),
    data: String(row.data),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at !== undefined && row.created_at !== null
          ? String(row.created_at)
          : undefined,
  };
}

/**
 * PostgreSQL-backed DatabaseAdapter using the `pg` connection pool.
 *
 * The pool is sized to comfortably support 500 concurrent read queries without
 * exhausting connections: reads are short-lived and the pool queues requests
 * beyond `max` rather than failing them. Configure via PG_POOL_MAX / PG_POOL_MIN.
 */
export class PostgresAdapter implements DatabaseAdapter {
  private readonly pool: Pool;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly runMigrations: boolean;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(options: PostgresAdapterOptions = {}) {
    const connectionString =
      options.connectionString ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

    if (!connectionString) {
      throw new Error(
        'PostgresAdapter requires a connection string (DATABASE_URL or POSTGRES_URL)',
      );
    }

    const max = options.max ?? Number(process.env.PG_POOL_MAX ?? DEFAULT_MAX);
    const min = options.min ?? Number(process.env.PG_POOL_MIN ?? DEFAULT_MIN);

    this.logger = options.logger ?? console;
    this.runMigrations = options.runMigrations ?? true;

    this.pool = new Pool({
      connectionString,
      max: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX,
      min: Number.isFinite(min) && min >= 0 ? min : DEFAULT_MIN,
      idleTimeoutMillis: options.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT,
      allowExitOnIdle: false,
    });

    this.pool.on('error', (err) => {
      this.logger.error('[db-postgres] idle client error:', err);
    });
  }

  /**
   * Ensures migrations have been applied. Safe to call concurrently; the
   * underlying promise is memoized.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      if (this.runMigrations) {
        await this.migrate();
      }
      this.initialized = true;
    })();

    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = null;
      throw err;
    }
  }

  /**
   * Applies idempotent migration scripts. Uses a transaction and an advisory
   * lock so concurrent replicas don't race on DDL.
   */
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Advisory lock keyed on a constant to serialize migrations across replicas.
      await client.query('SELECT pg_advisory_xact_lock($1)', [731_000_001]);
      for (const statement of POSTGRES_MIGRATIONS) {
        await client.query(statement);
      }
      await client.query('COMMIT');
      this.logger.info('[db-postgres] migrations applied');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async insertEvent(event: IndexerEvent): Promise<IndexerEvent> {
    await this.init();
    const sql = `
      INSERT INTO events
        (provider, client, event_type, contract, job_id, block_number, transaction_hash, log_index, data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (block_number, transaction_hash, log_index) DO NOTHING
      RETURNING id, provider, client, event_type, contract, job_id, block_number,
                transaction_hash, log_index, data, created_at
    `;
    const params = [
      event.provider,
      event.client,
      event.eventType,
      event.contract,
      event.jobId,
      event.blockNumber,
      event.transactionHash,
      event.logIndex,
      event.data,
    ];

    const result: QueryResult = await this.pool.query(sql, params);
    if (result.rows.length > 0) {
      return mapRow(result.rows[0]);
    }
    // Conflict: return the existing row.
    const existing = await this.pool.query(
      `SELECT id, provider, client, event_type, contract, job_id, block_number,
              transaction_hash, log_index, data, created_at
       FROM events
       WHERE block_number = $1 AND transaction_hash = $2 AND log_index = $3`,
      [event.blockNumber, event.transactionHash, event.logIndex],
    );
    if (existing.rows.length > 0) {
      return mapRow(existing.rows[0]);
    }
    // Should not happen, but return the input as a fallback.
    return event;
  }

  async insertMany(events: IndexerEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    await this.init();

    const client: PoolClient = await this.pool.connect();
    let inserted = 0;
    try {
      await client.query('BEGIN');
      // Chunk to keep parameter counts within PostgreSQL limits (65535 params / 9 cols).
      const CHUNK = 1000;
      for (let i = 0; i < events.length; i += CHUNK) {
        const chunk = events.slice(i, i + CHUNK);
        const values: unknown[] = [];
        const placeholders: string[] = [];
        chunk.forEach((event, idx) => {
          const base = idx * 9;
          placeholders.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
              `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`,
          );
          values.push(
            event.provider,
            event.client,
            event.eventType,
            event.contract,
            event.jobId,
            event.blockNumber,
            event.transactionHash,
            event.logIndex,
            event.data,
          );
        });

        const sql = `
          INSERT INTO events
            (provider, client, event_type, contract, job_id, block_number, transaction_hash, log_index, data)
          VALUES ${placeholders.join(', ')}
          ON CONFLICT (block_number, transaction_hash, log_index) DO NOTHING
        `;
        const result = await client.query(sql, values);
        inserted += result.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw err;
    } finally {
      client.release();
    }
    return inserted;
  }

  async getEvents(query: EventQuery = {}): Promise<IndexerEvent[] | number> {
    await this.init();

    const conditions: string[] = [];
    const params: unknown[] = [];

    const addEq = (column: string, value?: string) => {
      if (value !== undefined && value !== null && value !== '') {
        params.push(value);
        conditions.push(`${column} = $${params.length}`);
      }
    };

    addEq('provider', query.provider);
    addEq('client', query.client);
    addEq('event_type', query.eventType);
    addEq('contract', query.contract);
    addEq('job_id', query.jobId);

    if (query.fromDate) {
      params.push(query.fromDate);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (query.toDate) {
      params.push(query.toDate);
      conditions.push(`created_at <= $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    if (query.count) {
      const countResult = await this.pool.query(
        `SELECT COUNT(*)::bigint AS count FROM events ${where}`,
        params,
      );
      return toNumber(countResult.rows[0]?.count ?? 0);
    }

    let sql = `
      SELECT id, provider, client, event_type, contract, job_id, block_number,
             transaction_hash, log_index, data, created_at
      FROM events
      ${where}
      ORDER BY block_number ASC, log_index ASC, id ASC
    `;

    if (query.limit !== undefined && query.limit !== null) {
      params.push(query.limit);
      sql += ` LIMIT $${params.length}`;
    }
    if (query.offset !== undefined && query.offset !== null) {
      params.push(query.offset);
      sql += ` OFFSET $${params.length}`;
    }

    const result = await this.pool.query(sql, params);
    return result.rows.map(mapRow);
  }

  /**
   * Cursor-paginated event listing using keyset pagination on
   * (block_number, log_index, id). Always bounded by clampLimit().
   */
  async getEventsPage(query: EventQuery = {}): Promise<EventPage> {
    await this.init();

    const limit = clampLimit(query.limit);
    const conditions: string[] = [];
    const params: unknown[] = [];

    const addEq = (column: string, value?: string) => {
      if (value !== undefined && value !== null && value !== '') {
        params.push(value);
        conditions.push(`${column} = $${params.length}`);
      }
    };

    addEq('provider', query.provider);
    addEq('client', query.client);
    addEq('event_type', query.eventType);
    addEq('contract', query.contract);
    addEq('job_id', query.jobId);

    if (query.fromDate) {
      params.push(query.fromDate);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (query.toDate) {
      params.push(query.toDate);
      conditions.push(`created_at <= $${params.length}`);
    }

    if (query.after) {
      const { blockNumber, logIndex, id } = query.after;
      params.push(blockNumber);
      const b = params.length;
      params.push(logIndex);
      const l = params.length;
      params.push(id);
      const i = params.length;
      conditions.push(
        `(block_number, log_index, id) > ($${b}, $${l}, $${i})`,
      );
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // Fetch one extra row to determine whether another page exists.
    params.push(limit + 1);
    const sql = `
      SELECT id, provider, client, event_type, contract, job_id, block_number,
             transaction_hash, log_index, data, created_at
      FROM events
      ${where}
      ORDER BY block_number ASC, log_index ASC, id ASC
      LIMIT $${params.length}
    `;

    const result = await this.pool.query(sql, params);
    const rows = result.rows.map(mapRow);
    const hasMore = rows.length > limit;
    const events = hasMore ? rows.slice(0, limit) : rows;
    const last = events[events.length - 1];
    const nextCursor: EventCursor | null =
      hasMore && last && last.id !== undefined
        ? { blockNumber: last.blockNumber, logIndex: last.logIndex, id: last.id }
        : null;

    return { events, nextCursor };
  }

  async getEventByKey(
    blockNumber: number,
    transactionHash: string,
    logIndex: number,
  ): Promise<IndexerEvent | null> {
    await this.init();
    const result = await this.pool.query(
      `SELECT id, provider, client, event_type, contract, job_id, block_number,
              transaction_hash, log_index, data, created_at
       FROM events
       WHERE block_number = $1 AND transaction_hash = $2 AND log_index = $3
       LIMIT 1`,
      [blockNumber, transactionHash, logIndex],
    );
    return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
  }

  async getEventsByJob(jobId: string, limit?: number): Promise<IndexerEvent[]> {
    await this.init();
    const bounded = clampLimit(limit);
    const result = await this.pool.query(
      `SELECT id, provider, client, event_type, contract, job_id, block_number,
              transaction_hash, log_index, data, created_at
       FROM events
       WHERE job_id = $1
       ORDER BY block_number DESC, log_index DESC, id DESC
       LIMIT $2`,
      [jobId, bounded],
    );
    return result.rows.map(mapRow);
  }

  async getIndexerState(key: string): Promise<IndexerState | null> {
    await this.init();
    const result = await this.pool.query(
      `SELECT key, value, updated_at FROM indexer_state WHERE key = $1`,
      [key],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      key: String(row.key),
      value: String(row.value),
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : row.updated_at !== undefined && row.updated_at !== null
            ? String(row.updated_at)
            : undefined,
    };
  }

  async setIndexerState(key: string, value: string): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO indexer_state (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value],
    );
  }

  /** Exposes the underlying pool for advanced use cases / health checks. */
  getPool(): Pool {
    return this.pool;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Factory that selects the backing store based on the DATABASE_URL environment
 * variable. If DATABASE_URL starts with `postgres://` or `postgresql://`, a
 * PostgresAdapter is returned; otherwise the caller should fall back to SQLite.
 */
export function isPostgresUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^postgres(ql)?:\/\//i.test(url.trim());
}

export function createPostgresAdapter(
  options: PostgresAdapterOptions = {},
): PostgresAdapter {
  return new PostgresAdapter(options);
}

export default PostgresAdapter;
```

```sql
-- indexer/migrations/postgres/001_init.sql
-- Idempotent migration: events table with indexes and indexer_state table.

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  client TEXT NOT NULL,
  event_type TEXT NOT NULL,
  contract TEXT NOT NULL,
  job_id TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique_log
  ON events (block_number, transaction_hash, log_index);

-- Migration for existing data: replace the legacy (tx, log_index) uniqueness
-- with the (ledger, tx, op, event index) key. Safe to re-run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'idx_events_unique_log'
      AND indexdef NOT LIKE '%block_number%'
  ) THEN
    DROP INDEX idx_events_unique_log;
    CREATE UNIQUE INDEX idx_events_unique_log
      ON events (block_number, transaction_hash, log_index);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_provider ON events (provider);
CREATE INDEX IF NOT EXISTS idx_events_client ON events (client);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events (event_type);
CREATE INDEX IF NOT EXISTS idx_events_contract ON events (contract);
CREATE INDEX IF NOT EXISTS idx_events_job_id ON events (job_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at);
CREATE INDEX IF NOT EXISTS idx_events_block_number ON events (block_number);

CREATE TABLE IF NOT EXISTS indexer_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);