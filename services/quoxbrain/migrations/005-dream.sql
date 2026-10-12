-- 005-dream.sql — QUOXBRAIN P3 WP1 DREAM WATERMARK
-- (docs/STREAM_QUOXBRAIN_P3_DREAM_CONTRACT.md §WP1, roadmap QUOXBRAIN #163)
--
-- Additive only — nothing dropped, nothing in 000-baseline.sql /
-- 001-chunks.sql / 002-vault-roots.sql / 003-scope.sql / 004-language.sql
-- touched.
--
-- The idempotency backbone for the QuoxDream consolidation engine (P3):
--   - dream_cursor — the high-water mark per tenant slice (org_id, scope,
--     owner_user_id). lib/vaultStore.js's getNotesSinceCursor reads notes
--     strictly AFTER this cursor (keyset pagination on occurred_at, id) so a
--     consolidation pass never re-processes a note nor skips one.
--   - dream_runs — run stats / observability for each consolidation pass
--     (WP2's consolidateOrg). Not read by anything yet.
--
-- owner_user_id sentinel: owner_user_id is part of dream_cursor's PRIMARY
-- KEY alongside org_id/scope, but SQLite treats NULL as DISTINCT in a
-- PRIMARY KEY — two rows with the same (org_id, scope) and a NULL
-- owner_user_id would NOT collide, which would silently break the "one
-- cursor per tenant slice" invariant for 'org'/'shared' scope (neither of
-- which has an owning user). To keep the PK stable, callers pass the
-- sentinel empty string '' for "no owner" instead of NULL — enforced by
-- lib/vaultStore.js's getDreamCursor/setDreamCursor helpers (which map
-- '' <-> null at the boundary), not by this schema.

CREATE TABLE IF NOT EXISTS dream_cursor (
  org_id           TEXT NOT NULL,
  scope            TEXT NOT NULL,
  owner_user_id    TEXT,
  last_occurred_at TEXT,
  last_note_id     TEXT,
  updated_at       TEXT,
  PRIMARY KEY (org_id, scope, owner_user_id)
);

CREATE TABLE IF NOT EXISTS dream_runs (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  notes_read      INTEGER DEFAULT 0,
  beliefs_written INTEGER DEFAULT 0,
  beliefs_deduped INTEGER DEFAULT 0,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_dream_runs_org ON dream_runs(org_id);
