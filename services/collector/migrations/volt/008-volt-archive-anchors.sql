-- VOLT-RETENTION P4: durable pointer from a pruned run to its signed cold
-- bundle. scripts/volt-archive-prune.js writes a row here in the same
-- transaction that deletes the run's volt_events, so a pruned run is never
-- silently empty: the read routes answer {archived: true, anchor}.
CREATE TABLE IF NOT EXISTS volt_archive_anchors (
  run_id TEXT PRIMARY KEY,
  org_id TEXT,
  bundle_id TEXT,
  location TEXT,
  file_sha256 TEXT,
  file_bytes INTEGER,
  raw_bytes INTEGER,
  event_count INTEGER,
  first_event_hash TEXT,
  last_event_hash TEXT,
  signer_key_id TEXT,
  archived_at TEXT,
  pruned_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_volt_archive_anchors_org ON volt_archive_anchors(org_id);
