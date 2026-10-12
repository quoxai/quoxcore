-- HV2-1: workflow resume bridge
ALTER TABLE inbox_items ADD COLUMN quoxflow_execution_id TEXT;
CREATE INDEX IF NOT EXISTS idx_inbox_items_qf_exec ON inbox_items(quoxflow_execution_id);
