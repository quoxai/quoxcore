-- VOLT-RETENTION P3: the archive exporter selects completed runs older than
-- the hot window ordered by start time. With only idx_volt_runs_status, that
-- sorted all ~1.4M completed runs per call (42s for a 5-run dry run on the dev
-- box). A composite index serves the filter and the order directly.
CREATE INDEX IF NOT EXISTS idx_volt_runs_status_started ON volt_runs(status, started_at);
