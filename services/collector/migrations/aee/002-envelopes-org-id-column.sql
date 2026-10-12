-- 002-envelopes-org-id-column.sql — collector AEE database (aee.db)
--
-- Adds org_id to envelopes for per-org compliance posture scoping. Nullable
-- — background/fleet writers (heartbeats, service-key callers with no
-- tenant context) legitimately have no org and must NOT have one fabricated.
-- Precedent: noc_tool_outcomes.org_id in 000-baseline.sql (nullable + indexed,
-- same DB).
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS" — on an already-migrated DB this
-- throws "duplicate column name", which runMigrations.js tolerates as a
-- no-op (see TOLERATED_ERROR in lib/runMigrations.js).

ALTER TABLE envelopes ADD COLUMN org_id TEXT;
CREATE INDEX IF NOT EXISTS idx_envelopes_org ON envelopes(org_id);
