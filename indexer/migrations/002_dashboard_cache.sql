CREATE TABLE IF NOT EXISTS dashboard_cache (
  cache_key  TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Indexes supporting the embedding cache (#965): lookups by key prefix
-- (e.g. "embedding:") and eviction by age.
CREATE INDEX IF NOT EXISTS idx_dashboard_cache_updated_at
  ON dashboard_cache (updated_at);

-- Audit log table backing /api/admin/audit filtering and pagination (#968).
-- Kept here so the SQLite-backed store can be created idempotently alongside
-- the cache; the JSONL importer populates it.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  INTEGER NOT NULL,
  actor      TEXT,
  action     TEXT,
  target     TEXT,
  details    TEXT,
  created_at INTEGER NOT NULL
);

-- Filter indexes for audit queries: actor, action, and time range.
CREATE INDEX IF NOT EXISTS idx_audit_log_actor
  ON audit_log (actor);

CREATE INDEX IF NOT EXISTS idx_audit_log_action
  ON audit_log (action);

CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp
  ON audit_log (timestamp);

-- Composite indexes for common combined filters (actor+time, action+time)
-- so range scans stay efficient at 100k+ entries.
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_timestamp
  ON audit_log (actor, timestamp);

CREATE INDEX IF NOT EXISTS idx_audit_log_action_timestamp
  ON audit_log (action, timestamp);

-- down
DROP INDEX IF EXISTS idx_audit_log_action_timestamp;
DROP INDEX IF EXISTS idx_audit_log_actor_timestamp;
DROP INDEX IF EXISTS idx_audit_log_timestamp;
DROP INDEX IF EXISTS idx_audit_log_action;
DROP INDEX IF EXISTS idx_audit_log_actor;
DROP TABLE IF EXISTS audit_log;
DROP INDEX IF EXISTS idx_dashboard_cache_updated_at;
DROP TABLE IF EXISTS dashboard_cache;