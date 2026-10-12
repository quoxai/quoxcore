-- Links inbox items to the AEE conversation chain
ALTER TABLE inbox_items ADD COLUMN aee_correlation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_inbox_items_corr ON inbox_items(aee_correlation_id);
