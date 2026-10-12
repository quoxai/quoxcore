-- 039-envelopes-org-intent-ts-index.sql — INCIDENT quox#700 (2026-10-06).
--
-- The footer status probe (GET /aee/query?intent=aocl.) now matches namespace
-- intents as a PREFIX RANGE (org_id = ? AND intent >= ? AND intent < ?) instead
-- of intent LIKE '%x%'. Adding ts as the third key column makes the
-- "newest N matching" lookup a covering index range read (no table lookups,
-- no row-wide temp b-tree), so cost tracks matches, not table size.
CREATE INDEX IF NOT EXISTS idx_envelopes_org_intent_ts ON envelopes(org_id, intent, ts);
