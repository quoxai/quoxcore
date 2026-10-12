-- 021-objective-outcomes-follow-up-actions.sql — TRUST-GATE Phase 3a
--
-- Folded AS-IS from the flat migrations[] array previously in
-- db/index.js (each array element was applied + caught individually via
-- `for (const sql of migrations) { try { db.exec(sql) } catch {} }`,
-- so one ALTER per migration file exactly preserves that granularity).
--
-- Original comment: Action-Q: Follow-up actions from objective analysis
ALTER TABLE objective_outcomes ADD COLUMN follow_up_actions TEXT;
