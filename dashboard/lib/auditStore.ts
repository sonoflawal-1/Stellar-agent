import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface AuditEntry {
  id?: number;
  timestamp: string;
  actor: string;
  action: string;
  payload: string;
}

export interface AuditStoreOptions {
  dbPath: string;
  jsonlDir?: string;
  retentionDays?: number;
  retentionIntervalMs?: number;
}

export interface AuditQueryOptions {
  actor?: string;
  action?: string;
  /** Inclusive lower bound on timestamp (ISO 8601). */
  from?: string;
  /** Inclusive upper bound on timestamp (ISO 8601). */
  to?: string;
  /** @deprecated use `from` */
  since?: string;
  /** @deprecated use `to` */
  until?: string;
  limit?: number;
  offset?: number;
  /** Cursor for keyset pagination: return rows strictly older than this id. */
  cursor?: number;
}

export interface AuditQueryResult {
  entries: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
  /** Cursor to pass as `cursor` for the next page, or null if exhausted. */
  nextCursor: number | null;
}

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_RETENTION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class AuditStore {
  private db: Database.Database;
  private jsonlDir: string;
  private retentionDays: number;
  private retentionIntervalMs: number;
  private retentionTimer: NodeJS.Timeout | null = null;

  constructor(options: AuditStoreOptions) {
    this.jsonlDir = options.jsonlDir ?? path.dirname(options.dbPath);
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.retentionIntervalMs =
      options.retentionIntervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;

    const dir = path.dirname(options.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
    this.migrateJsonl();
    this.startRetentionJob();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_payload ON audit_log(payload);
      CREATE INDEX IF NOT EXISTS idx_audit_actor_timestamp ON audit_log(actor, timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_action_timestamp ON audit_log(action, timestamp);
      CREATE TABLE IF NOT EXISTS audit_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private getMeta(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM audit_meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO audit_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value);
  }

  /**
   * One-time idempotent migration of existing JSONL audit files.
   * Tracks migrated files in audit_meta so re-runs skip already-ingested files.
   */
  migrateJsonl(): number {
    if (!fs.existsSync(this.jsonlDir)) {
      return 0;
    }

    let files: string[];
    try {
      files = fs
        .readdirSync(this.jsonlDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(this.jsonlDir, f));
    } catch {
      return 0;
    }

    let totalInserted = 0;
    const insert = this.db.prepare(
      'INSERT INTO audit_log (timestamp, actor, action, payload) VALUES (?, ?, ?, ?)'
    );

    const migrateFile = this.db.transaction((file: string) => {
      const content = fs.readFileSync(file, 'utf-8');
      let inserted = 0;
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: Partial<AuditEntry>;
        try {
          entry = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (!entry || typeof entry !== 'object') continue;
        const timestamp =
          typeof entry.timestamp === 'string'
            ? entry.timestamp
            : new Date().toISOString();
        const actor = typeof entry.actor === 'string' ? entry.actor : 'unknown';
        const action =
          typeof entry.action === 'string' ? entry.action : 'unknown';
        const payload =
          typeof entry.payload === 'string'
            ? entry.payload
            : JSON.stringify(entry.payload ?? {});
        insert.run(timestamp, actor, action, payload);
        inserted++;
      }
      return inserted;
    });

    for (const file of files) {
      const key = `migrated:${path.basename(file)}`;
      if (this.getMeta(key) !== null) {
        continue;
      }
      try {
        const inserted = migrateFile(file);
        this.setMeta(key, new Date().toISOString());
        totalInserted += inserted;
      } catch {
        // Skip files that fail to migrate; they will be retried next run.
      }
    }

    return totalInserted;
  }

  append(entry: Omit<AuditEntry, 'id'>): number {
    const result = this.db
      .prepare(
        'INSERT INTO audit_log (timestamp, actor, action, payload) VALUES (?, ?, ?, ?)'
      )
      .run(entry.timestamp, entry.actor, entry.action, entry.payload);
    return Number(result.lastInsertRowid);
  }

  private buildFilter(options: AuditQueryOptions): {
    where: string;
    params: unknown[];
  } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.actor) {
      clauses.push('actor = ?');
      params.push(options.actor);
    }
    if (options.action) {
      clauses.push('action = ?');
      params.push(options.action);
    }
    const from = options.from ?? options.since;
    const to = options.to ?? options.until;
    if (from) {
      clauses.push('timestamp >= ?');
      params.push(from);
    }
    if (to) {
      clauses.push('timestamp <= ?');
      params.push(to);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return { where, params };
  }

  query(options: AuditQueryOptions = {}): AuditEntry[] {
    const { where, params } = this.buildFilter(options);
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    if (typeof options.cursor === 'number') {
      // Keyset pagination: rows strictly older than the cursor id.
      const cursorClause = where ? `${where} AND id < ?` : 'WHERE id < ?';
      return this.db
        .prepare(
          `SELECT id, timestamp, actor, action, payload FROM audit_log ${cursorClause} ORDER BY id DESC LIMIT ?`
        )
        .all(...params, options.cursor, limit) as AuditEntry[];
    }

    return this.db
      .prepare(
        `SELECT id, timestamp, actor, action, payload FROM audit_log ${where} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as AuditEntry[];
  }

  /**
   * Filtered, paginated query returning entries plus total count and a
   * next-page cursor. Backed by the actor/action/timestamp indexes so it
   * stays fast over large (100k+) tables.
   */
  queryPage(options: AuditQueryOptions = {}): AuditQueryResult {
    const { where, params } = this.buildFilter(options);
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM audit_log ${where}`)
        .get(...params) as { c: number }
    ).c;

    const entries = this.query(options);
    const nextCursor =
      entries.length === limit && entries.length > 0
        ? entries[entries.length - 1].id ?? null
        : null;

    return { entries, total, limit, offset, nextCursor };
  }

  /**
   * Delete rows older than the retention window. Returns number of rows deleted.
   */
  runRetention(now: Date = new Date()): number {
    const cutoff = new Date(
      now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const result = this.db
      .prepare('DELETE FROM audit_log WHERE timestamp < ?')
      .run(cutoff);
    return result.changes;
  }

  private startRetentionJob(): void {
    if (this.retentionTimer) return;
    this.retentionTimer = setInterval(() => {
      try {
        this.runRetention();
      } catch {
        // Ignore retention errors; will retry on next interval.
      }
    }, this.retentionIntervalMs);
    if (typeof this.retentionTimer.unref === 'function') {
      this.retentionTimer.unref();
    }
  }

  stopRetentionJob(): void {
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
  }

  /**
   * Export audit log rows to a JSONL file for backward compatibility.
   * Returns the path of the written file.
   */
  exportJsonl(outputPath: string, options: { since?: string } = {}): string {
    const rows = options.since
      ? (this.db
          .prepare(
            'SELECT id, timestamp, actor, action, payload FROM audit_log WHERE timestamp >= ? ORDER BY timestamp ASC, id ASC'
          )
          .all(options.since) as AuditEntry[])
      : (this.db
          .prepare(
            'SELECT id, timestamp, actor, action, payload FROM audit_log ORDER BY timestamp ASC, id ASC'
          )
          .all() as AuditEntry[]);

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const lines = rows.map((row) =>
      JSON.stringify({
        timestamp: row.timestamp,
        actor: row.actor,
        action: row.action,
        payload: row.payload,
      })
    );
    fs.writeFileSync(outputPath, lines.join('\n') + (lines.length ? '\n' : ''));
    return outputPath;
  }

  close(): void {
    this.stopRetentionJob();
    this.db.close();
  }
}

export interface AuditSaltOptions {
  /** Explicit salt value (e.g. from process.env.AUDIT_SALT). */
  salt?: string;
  /** File used to persist a generated salt when no explicit salt is given. */
  saltFilePath: string;
  /** When true, refuse to fall back to an ephemeral salt. */
  production?: boolean;
  /** Logger used for warnings; defaults to console. */
  logger?: { warn: (message: string) => void };
}

export interface AuditSaltResult {
  salt: Buffer;
  /** True when the salt is not persisted and changes on each process start. */
  ephemeral: boolean;
}

/**
 * Resolve the salt used for hashing IP addresses in audit entries.
 *
 * - If an explicit salt is provided it is used as-is.
 * - Otherwise a salt is read from `saltFilePath`, or generated and persisted
 *   with 0600 permissions on first run so hashes stay stable across restarts.
 * - In production, a missing salt is a hard error instead of an ephemeral one.
 * - When an ephemeral salt is unavoidable, a warning is logged.
 */
export function resolveAuditSalt(options: AuditSaltOptions): AuditSaltResult {
  const logger = options.logger ?? console;

  if (options.salt) {
    return { salt: Buffer.from(options.salt, 'utf-8'), ephemeral: false };
  }

  try {
    if (fs.existsSync(options.saltFilePath)) {
      const stored = fs.readFileSync(options.saltFilePath, 'utf-8').trim();
      if (stored) {
        return { salt: Buffer.from(stored, 'utf-8'), ephemeral: false };
      }
    }
  } catch {
    // Fall through to generation / error handling below.
  }

  if (options.production) {
    throw new Error(
      'AUDIT_SALT is not set and no persisted salt file was found; refusing to start in production with an ephemeral salt'
    );
  }

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    const dir = path.dirname(options.saltFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(options.saltFilePath, generated, { mode: 0o600 });
    try {
      fs.chmodSync(options.saltFilePath, 0o600);
    } catch {
      // Best effort; some filesystems do not support chmod.
    }
    return { salt: Buffer.from(generated, 'utf-8'), ephemeral: false };
  } catch {
    logger.warn(
      'AUDIT_SALT is not set and the salt file could not be written; using an ephemeral salt. IP hashes will not be comparable across restarts.'
    );
    return { salt: crypto.randomBytes(32), ephemeral: true };
  }
}

let defaultStore: AuditStore | null = null;

export function getAuditStore(options?: AuditStoreOptions): AuditStore {
  if (!defaultStore) {
    if (!options) {
      throw new Error('AuditStore not initialized; provide options on first call');
    }
    defaultStore = new AuditStore(options);
  }
  return defaultStore;
}

export function initAuditStore(options: AuditStoreOptions): AuditStore {
  if (defaultStore) {
    defaultStore.close();
  }
  defaultStore = new AuditStore(options);
  return defaultStore;
}

export default AuditStore;