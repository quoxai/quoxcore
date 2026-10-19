-- #1081: the ward_witness_outbox (126) also carries approval_events witnesses. kind = auth_audit | approval_event;
-- audit_id holds the source row id for either kind (both are ULIDs from different tables).
ALTER TABLE ward_witness_outbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'auth_audit';
