-- 006-usage-events.sql — BRAIN2-PRODUCT P3a: the usage ledger
-- (docs/STREAM_QUOXBRAIN2_COCKPIT_DESIGN.md — "is it used?" as a visible
-- number, not an inference).
--
-- Additive only — nothing dropped, nothing in 000-baseline.sql /
-- 001-chunks.sql / 002-vault-roots.sql / 003-scope.sql / 004-language.sql /
-- 005-dream.sql touched.
--
-- One row per read-surface hit (POST /brain/search, POST /brain/context,
-- GET /notes/:id, GET /brain/graph) — see lib/vaultStore.js recordUsageEvent
-- (self-contained best-effort: a write failure here is logged and swallowed,
-- never propagated to the caller's actual request). `source` distinguishes
-- WHO called (dashboard UI vs. an agent vs. cli/mcp/another service),
-- separately from `surface` (WHAT was called) — see server.js's
-- X-Quox-Source header handling.
CREATE TABLE IF NOT EXISTS usage_events (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  user_id    TEXT,
  surface    TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Every read in lib/vaultStore.js's getUsage() is `WHERE org_id = ? AND
-- created_at >= ?` (the rolling week window) or `WHERE org_id = ?` (the
-- lifetime total) — this composite index covers both.
CREATE INDEX IF NOT EXISTS idx_usage_events_org_created ON usage_events(org_id, created_at);
