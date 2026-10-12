-- 023-dev-server-skill-pack-rights.sql — collector AEE database (aee.db)
--
-- SKILLRIGHTS #478 Phase 9 (rights-aware skill distribution). The durable
-- collector-side record of WHAT each host received UNDER WHICH RIGHTS: a
-- JSON array of { ref, license } captured at confirmed sync, matching the
-- .pack-rights.json manifest written onto the host itself by
-- skillPackInstaller.js. NULL means "installed before rights tracking
-- existed, or rights not captured" — the status endpoint recomputes live
-- rights from disk regardless, this column is the historical receipt.
--
-- runMigrations.js tolerates "duplicate column name" so this is safe on a
-- DB that somehow already carries the column.

ALTER TABLE dev_server_skill_packs ADD COLUMN installed_rights_json TEXT;
