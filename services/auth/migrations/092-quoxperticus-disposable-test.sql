-- QUOXPERTICUS P0b (DEC-1): disposable_test instance property.
--
-- When 'true', this ENTIRE instance is a throwaway sandbox that holds no real
-- data (its own DB / KEK / namespace, no path to prod). Only a disposable_test
-- instance may grant the QUOXPERTICUS approval relaxation (an agent-driven
-- synthetic approver); on every real instance this stays 'false' and the
-- approval endpoints deny actor_type=agent unconditionally.
--
-- Writable ONLY via the human-admin config path (PATCH /admin/config/:key behind
-- requireInstanceAdmin — no service-key bypass). Seeded 'false' so it exists (the
-- admin PATCH 404s unknown keys) and every instance defaults OFF. INSERT OR
-- IGNORE keeps this idempotent and never overwrites an operator-set value.
INSERT OR IGNORE INTO instance_config (key, value, value_type, description) VALUES
    ('instance.disposable_test', 'false', 'boolean', 'This entire instance is a disposable test sandbox (no real data). Only a disposable_test instance may grant the QUOXPERTICUS agent-approval relaxation. Human-admin-writable only.');
