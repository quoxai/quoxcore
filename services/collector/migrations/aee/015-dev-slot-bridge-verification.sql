-- 015-dev-slot-bridge-verification.sql — DEVSUITE-SLOTS phase 10 (POLISH P0,
-- trust). The bundle audit (QuoxPlan DEVSUITE note #2840, theme S5) found that
-- `quox slot bridge set discord <room>` returned 200 for ANY room id, whether
-- or not that room was a bridged Discord portal, so a mistyped or simply wrong
-- room looked like success and then rendered to nobody. A green check that
-- lies is worse than a red one.
--
-- Setting a bridge room now probes the live room first (appservice
-- /internal/bridge-probe: join a relay puppet, read the m.bridge state) and
-- records the verdict here, so every surface can show WHY a bridge is trusted
-- or not instead of just echoing back the room id it was handed.
--
-- Columns are nullable on purpose: rows written before this migration, and
-- rows written with an explicit --force override, have no verdict, and a NULL
-- verified_at must read as "never verified", never as "verified false".

ALTER TABLE dev_slot_bridges ADD COLUMN verified_at TEXT;
ALTER TABLE dev_slot_bridges ADD COLUMN verified_ok INTEGER;
ALTER TABLE dev_slot_bridges ADD COLUMN verified_reason TEXT;
ALTER TABLE dev_slot_bridges ADD COLUMN channel_label TEXT;
