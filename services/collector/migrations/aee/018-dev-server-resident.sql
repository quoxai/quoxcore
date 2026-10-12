-- 018-dev-server-resident.sql — collector AEE database (aee.db)
--
-- quox#453 phase 15: `quox dev enable` now also provisions a host resident
-- identity (Ed25519 keypair generated on the host, registered with auth —
-- see lib/devResidentProvisioner.js, called from POST
-- /api/internal/dev-profiles/enable in server.js). Until now the outcome
-- only ever reached the enable response body; a collector restart, or
-- anyone not looking at that one response, had no way to see whether a
-- host's resident identity ever landed. These three columns are the durable
-- record, same additive-ALTER pattern as 013/017: no backfill, no default
-- state row rewrite.
--
-- resident_state vocabulary: 'provisioned' | 'failed'. A NULL column (never
-- set) means the host predates phase 15 or enable was never re-run since —
-- "never attempted", not a third named state. resident_detail is a short
-- human string (keyState on success, reason/error detail on failure), never
-- structured JSON. resident_updated_at is the ISO timestamp of the last
-- setResidentState() call, independent of last_seen_at (a heartbeat does
-- not touch these columns).

ALTER TABLE dev_servers ADD COLUMN resident_state TEXT;
ALTER TABLE dev_servers ADD COLUMN resident_detail TEXT;
ALTER TABLE dev_servers ADD COLUMN resident_updated_at TEXT;
