-- 010-tasks-last-heartbeat-at.sql — TRUST-GATE Phase 3a
--
-- Folded AS-IS from the flat migrations[] array previously in
-- db/index.js (each array element was applied + caught individually via
-- `for (const sql of migrations) { try { db.exec(sql) } catch {} }`,
-- so one ALTER per migration file exactly preserves that granularity).
--
-- Original comment: OE-1: Heartbeat persistence for crash recovery
ALTER TABLE tasks ADD COLUMN last_heartbeat_at TEXT;
