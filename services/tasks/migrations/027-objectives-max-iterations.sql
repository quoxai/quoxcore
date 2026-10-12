-- 027-objectives-max-iterations.sql — TRUST-GATE Phase 3a
--
-- Folded AS-IS from the flat migrations[] array previously in
-- db/index.js (each array element was applied + caught individually via
-- `for (const sql of migrations) { try { db.exec(sql) } catch {} }`,
-- so one ALTER per migration file exactly preserves that granularity).
--
-- Original comment: STUDY-REV R3: re-observe loop (max_iterations)
ALTER TABLE objectives ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT 5;
