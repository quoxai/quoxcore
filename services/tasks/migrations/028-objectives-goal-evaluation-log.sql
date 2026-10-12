-- 028-objectives-goal-evaluation-log.sql — TRUST-GATE Phase 3a
--
-- Folded AS-IS from the flat migrations[] array previously in
-- db/index.js (each array element was applied + caught individually via
-- `for (const sql of migrations) { try { db.exec(sql) } catch {} }`,
-- so one ALTER per migration file exactly preserves that granularity).
--
-- Original comment: STUDY-REV R3: re-observe loop (goal_evaluation_log)
ALTER TABLE objectives ADD COLUMN goal_evaluation_log TEXT;
