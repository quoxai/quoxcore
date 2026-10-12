-- 006-objectives-volt-bundle-id.sql — TRUST-GATE Phase 3a
--
-- Folded AS-IS from the flat migrations[] array previously in
-- db/index.js (each array element was applied + caught individually via
-- `for (const sql of migrations) { try { db.exec(sql) } catch {} }`,
-- so one ALTER per migration file exactly preserves that granularity).
--
-- Original comment: Stream E: Agentic Teams
ALTER TABLE objectives ADD COLUMN volt_bundle_id TEXT;
