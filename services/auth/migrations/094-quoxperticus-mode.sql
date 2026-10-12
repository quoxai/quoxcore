-- QUOXPERTICUS P1: per-instance resident-agent MODE substrate.
--
-- instance.mode.quoxperticus holds the operating level the resident agent runs
-- at on this instance: OFF | OBSERVE | PARTIAL | FULL.
--   OFF      = agent absent.
--   OBSERVE  = read-only exercising + filing findings.
--   PARTIAL  = scoped low-risk actions.
--   FULL     = autopilot, only honored on a disposable_test instance (real
--              instances cap a stored FULL at PARTIAL — a cap, not an error).
-- Any absent/unknown/garbage value resolves to OFF (fail-safe).
--
-- Writable ONLY via the human-admin config path (PATCH /admin/config/:key
-- behind requireInstanceAdmin — no service-key bypass). Seeded 'OFF' so it
-- exists (the admin PATCH 404s unknown keys) and every instance defaults to
-- the agent being absent. INSERT OR IGNORE keeps this idempotent and never
-- overwrites an operator-set value.
INSERT OR IGNORE INTO instance_config (key, value, value_type, description) VALUES
    ('instance.mode.quoxperticus', 'OFF', 'string', 'QUOXPERTICUS resident-agent mode for this instance (OFF|OBSERVE|PARTIAL|FULL). OFF = agent absent; OBSERVE = read-only exercising + filing findings; PARTIAL = scoped low-risk actions; FULL = autopilot, only honored on a disposable_test instance (real instances cap at PARTIAL). Human-admin-writable only.');
