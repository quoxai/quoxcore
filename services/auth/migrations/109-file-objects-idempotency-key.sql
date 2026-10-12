-- F10 (cross-plugin defect sweep, 2026-10-03): file_objects creates had no
-- retry-idempotency mechanism. SHA-256 dedup only collapses the on-disk
-- blob; a client retrying a create after a lost response (network blip,
-- timeout, proxy retry) still got a second distinct file_objects row for the
-- same logical operation, with its own quota/billing consequences.
-- Callers that want retry-safety now pass an `idempotency_key` scoped to the
-- submitting org; a second create with the same (org_id, idempotency_key)
-- returns the original row instead of inserting a new one.
ALTER TABLE file_objects ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_objects_org_idempotency_key
    ON file_objects(org_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
