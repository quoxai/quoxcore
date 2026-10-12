-- 008-citation-events.sql — BRAIN2-V2 phase V2-1: the citation ledger
-- (the other half of the usage question: not just "is the brain read?"
-- — migrations/006-usage-events.sql — but "does what it returned actually
-- END UP IN THE ANSWER?").
--
-- Additive only — nothing dropped, nothing in 000-baseline.sql /
-- 001-chunks.sql / 002-vault-roots.sql / 003-scope.sql / 004-language.sql /
-- 005-dream.sql / 006-usage-events.sql touched.
--
-- One row per agent answer that followed a quoxbrain_search: the collector
-- detects which of the retrieved notes the final answer actually cited and
-- POSTs it to /brain/citations (see server.js + lib/vaultStore.js
-- recordCitationEvent, same best-effort contract as the usage ledger —
-- a write failure here is logged and swallowed, never propagated).
--
-- retrieved_count / cited_count are the raw numerator+denominator the
-- citation RATE is derived from at read time (lib/vaultStore.js getUsage's
-- `citations` key); storing the counts rather than a precomputed rate keeps
-- the week/lifetime windows honest. cited_note_ids is a JSON array of the
-- note ids that made it into the answer.
CREATE TABLE IF NOT EXISTS citation_events (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  user_id         TEXT,
  agent_id        TEXT,
  corr            TEXT,
  retrieved_count INTEGER NOT NULL,
  cited_count     INTEGER NOT NULL,
  cited_note_ids  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every read in lib/vaultStore.js's getUsage() is `WHERE org_id = ? AND
-- created_at >= ?` (the rolling week window) or `WHERE org_id = ?` (the
-- lifetime total) — this composite index covers both, exactly as
-- idx_usage_events_org_created does for the usage ledger.
CREATE INDEX IF NOT EXISTS idx_citation_events_org_created ON citation_events(org_id, created_at);
