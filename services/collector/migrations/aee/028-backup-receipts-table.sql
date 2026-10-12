-- 028-backup-receipts-table.sql — collector AEE database (aee.db)
--
-- G2d slice 2 ("backup control plane"): scripts/backup-quox.sh and its new
-- sibling scripts/restore-quox.sh currently leave their outcome in a log line
-- and a manifest on the box that ran them — no durable cross-host history, no
-- WARD witnessing, and no way to answer "when did this host last restore, and
-- was it a dry run?" from anywhere but that host. This table is the durable
-- home for those receipts, mirroring 006-build-receipts-table.sql exactly:
-- INSERT-only (every backup/restore action is its own row, same append-only
-- discipline as the envelopes table), org-stamped, host-stamped. See
-- lib/backupReceiptsStore.js.
--
-- `kind` IS constrained, unlike 006's `result` — there are exactly two
-- engines and a third value would mean a receipt nobody can interpret, so a
-- typo should fail at the write rather than land a silently unreadable row.
-- `result` stays unconstrained for the same reason 006 gives: the engines own
-- their outcome vocabulary ("ok"/"FAIL"/"partial" today) and a future
-- addition must never need a migration to be accepted.
--
-- dry_run is INTEGER (SQLite has no boolean) and NULLABLE on purpose: NULL
-- means the receipt did not state a dry-run posture, which is NOT the same as
-- "it was a real restore". A restore receipt that never asserted dry_run must
-- never be read as having asserted false.

CREATE TABLE IF NOT EXISTS backup_receipts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                TEXT NOT NULL CHECK (kind IN ('backup', 'restore')),
  mode                TEXT,
  archive_id          TEXT,
  archive_sha256      TEXT,
  archive_size_bytes  INTEGER,
  dry_run             INTEGER,
  result              TEXT NOT NULL,
  terminal            TEXT,
  stream              TEXT,
  phase               TEXT,
  message             TEXT,
  duration_seconds    INTEGER,
  host                TEXT NOT NULL DEFAULT 'unknown',
  org_id              TEXT NOT NULL DEFAULT 'default',
  created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_receipts_kind ON backup_receipts(kind);
CREATE INDEX IF NOT EXISTS idx_backup_receipts_created ON backup_receipts(created_at);
CREATE INDEX IF NOT EXISTS idx_backup_receipts_result ON backup_receipts(result);
CREATE INDEX IF NOT EXISTS idx_backup_receipts_host ON backup_receipts(host);
