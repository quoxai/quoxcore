-- Multi-tenancy Phase 2, Tier 2 — polymorphic tagging, backfill deliberately
-- omitted (matches original: "For now, just add the column - backfill is
-- complex due to polymorphic tagging")
ALTER TABLE asset_tags ADD COLUMN org_id TEXT;
CREATE INDEX IF NOT EXISTS idx_asset_tags_org ON asset_tags(org_id);
