-- Multi-tenancy Phase 2, Tier 2
ALTER TABLE run_events ADD COLUMN org_id TEXT;
UPDATE run_events
SET org_id = (SELECT org_id FROM runs WHERE runs.id = run_events.run_id)
WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_run_events_org ON run_events(org_id);
