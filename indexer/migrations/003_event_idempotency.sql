-- 003_event_idempotency.sql
-- Idempotent event ingestion keyed by (ledger, tx_hash, op_index, event_index).
--
-- Restarts or overlapping polling windows can re-insert the same event rows.
-- This migration:
--   1. Removes duplicate rows that already exist, keeping the earliest row
--      (lowest rowid) for each (ledger, tx_hash, op_index, event_index) key.
--   2. Enforces uniqueness going forward with a UNIQUE index so that
--      `INSERT ... ON CONFLICT DO NOTHING` becomes a no-op for re-ingested rows.

-- ---------------------------------------------------------------------------
-- UP
-- ---------------------------------------------------------------------------

-- Step 1: Deduplicate existing data.
-- Keep the first-inserted row (minimum rowid) per logical event key and delete
-- the rest. This must run before the UNIQUE index is created, otherwise index
-- creation would fail on pre-existing duplicates.
DELETE FROM events
WHERE rowid NOT IN (
    SELECT MIN(rowid)
    FROM events
    GROUP BY ledger, tx_hash, op_index, event_index
);

-- Step 2: Enforce uniqueness for future inserts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency
    ON events (ledger, tx_hash, op_index, event_index);

-- ---------------------------------------------------------------------------
-- DOWN
-- ---------------------------------------------------------------------------
-- To roll back, execute the following statements:
--
-- DROP INDEX IF EXISTS idx_events_idempotency;
--
-- Note: the deduplication performed in the UP section is destructive and is
-- not reversed by the DOWN section. Restore from a backup if the removed
-- duplicate rows are required.