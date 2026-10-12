-- 003-envelopes-org-corr-ts-index.sql — collector AEE database (aee.db)
--
-- PERF (2026-07-19): GET /aee/stats runs COUNT(DISTINCT corr)+MIN/MAX(ts) scoped
-- to an org over the envelopes table (~1.2M rows / 3.4GB). With only idx_corr and
-- idx_envelopes_org(org_id) available, that aggregate needed a temp b-tree over a
-- full org partition + main-table lookups for ts — a synchronous ~6.4s
-- better-sqlite3 query that blocked the event loop and wedged the collector under
-- polling load (root-caused via CPU profile).
--
-- This composite COVERING index (org_id, corr, ts) lets the query satisfy the
-- distinct-corr count AND the min/max(ts) entirely from the index (no main-table
-- lookups) — measured 7.75s -> 1.46s (5.3x) on the live 1.2M-row copy. Paired
-- with the per-org response cache on /aee/stats, cold queries are now rare AND
-- cheap. NOTE: building this index on an already-large table is a one-time
-- ~12s cost at the boot that first applies it.

CREATE INDEX IF NOT EXISTS idx_envelopes_org_corr_ts ON envelopes(org_id, corr, ts);
