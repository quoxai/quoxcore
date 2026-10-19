-- 042-wisdom-retirement.sql — QUOXMIND #1112 (2026-10-16)
--
-- Durable retirement and consumption for execution_wisdom. Retirement never
-- deletes: a retired row keeps its history with active = 0, retired_at and a
-- reason (stale_singleton, duplicate, decayed). injected_count and
-- last_injected_at record when the decomposer advisory actually put a row in
-- a prompt, so /mind can tell used wisdom from shelf wisdom.
ALTER TABLE execution_wisdom ADD COLUMN retired_at TEXT;
ALTER TABLE execution_wisdom ADD COLUMN retired_reason TEXT;
ALTER TABLE execution_wisdom ADD COLUMN injected_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE execution_wisdom ADD COLUMN last_injected_at TEXT;
CREATE INDEX IF NOT EXISTS idx_wisdom_org_pattern_active ON execution_wisdom(org_id, pattern_name, active);
