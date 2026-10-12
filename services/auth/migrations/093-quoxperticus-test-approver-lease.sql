-- QUOXPERTICUS P0b step 4 (DEC-4): test-approver LEASE substrate.
--
-- The sandbox approval relaxation (migration 092, instance.disposable_test)
-- must be leased/expiring, not latched. instance.test_approver_lease_until
-- holds the ISO-8601 expiry instant of the QUOXPERTICUS synthetic
-- test-approver lease; while unexpired AND instance.disposable_test='true',
-- the collector may perform sandbox approvals as the synthetic test-approver.
-- Empty = no lease. A lease EXPIRES so an accidental on-state self-heals
-- (leased, not latched).
--
-- Writable ONLY via the human-admin config path (PATCH /admin/config/:key behind
-- requireInstanceAdmin — no service-key bypass). Seeded '' so it exists (the
-- admin PATCH 404s unknown keys) and every instance defaults to no lease.
-- INSERT OR IGNORE keeps this idempotent and never overwrites an operator-set
-- value.
INSERT OR IGNORE INTO instance_config (key, value, value_type, description) VALUES
    ('instance.test_approver_lease_until', '', 'string', 'Expiry instant (ISO-8601) of the QUOXPERTICUS synthetic test-approver lease. While unexpired AND instance.disposable_test=true, the collector may perform sandbox approvals as the synthetic test-approver. Empty = no lease. Human-admin-writable only.');
