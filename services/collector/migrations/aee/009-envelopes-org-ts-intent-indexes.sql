-- 009-envelopes-org-ts-intent-indexes.sql — fleet #393/#409 incident fix.
--
-- /aee/query (queryOrgScoped/countOrgScoped) filtered with
-- (org_id = ? OR org_id IS NULL) then ORDER BY ts DESC. On this box
-- 1,588,712 of 1,630,826 envelopes are legacy NULL-org rows, so every
-- org's every query dragged ~1.6M rows through a temp b-tree sort,
-- synchronously, on the event loop. The footer AOCLStatusBadge polls the
-- route from every open dashboard tab: measured 100-148% CPU at ~75%
-- duty with /health timing out behind it.
--
-- These two composite indexes support the rewritten UNION ALL form of
-- both statements (each branch walks (org_id, ts) in order and stops at
-- LIMIT; the badge's intent-prefix COUNT becomes an index range scan).
-- Built online on the live 5GB DB 2026-08-11 before this migration
-- shipped, so boot-time application is a no-op there.
CREATE INDEX IF NOT EXISTS idx_envelopes_org_ts ON envelopes(org_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_envelopes_org_intent ON envelopes(org_id, intent);
