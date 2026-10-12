-- 002-tasks-retry-count.sql — TRUST-GATE Phase 3a
--
-- Folded AS-IS from the flat migrations[] array previously in
-- db/index.js (each array element was applied + caught individually via
-- `for (const sql of migrations) { try { db.exec(sql) } catch {} }`,
-- so one ALTER per migration file exactly preserves that granularity).
--
-- Original comment: (Phase 4.B + Stream E)
ALTER TABLE tasks ADD COLUMN retry_count INTEGER DEFAULT 0;
