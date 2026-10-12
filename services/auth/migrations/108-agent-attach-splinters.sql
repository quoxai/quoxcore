-- 108-agent-attach-splinters.sql
-- QUOXIDENTITY P9 (#487): splintering. One agent, one identity, many
-- temporary minds. Several leases may now be active for one (org, agent):
-- exactly ONE root (parent_lease_id IS NULL) plus any number of child
-- "splinter" leases (parent_lease_id = root id), each with its own ordinal
-- (S1 = root, S2.. = children). See docs/QUOXIDENTITY_SPLINTER_CONTRACT.md.
--
-- SQLite cannot alter a partial index in place: drop it, then create the
-- replacements. The ADD COLUMNs run first so the new index can reference them.
ALTER TABLE agent_attach_leases ADD COLUMN parent_lease_id TEXT NULL;
ALTER TABLE agent_attach_leases ADD COLUMN splinter_ordinal INTEGER NOT NULL DEFAULT 1;

DROP INDEX IF EXISTS idx_agent_attach_leases_single_active;

-- One ROOT per agent (the old single-active rule, narrowed to roots).
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_attach_leases_single_active
  ON agent_attach_leases(org_id, agent_id)
  WHERE state = 'active' AND parent_lease_id IS NULL;

-- One active lease per ordinal per agent (S2 can only be held once).
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_attach_leases_active_ordinal
  ON agent_attach_leases(org_id, agent_id, splinter_ordinal)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_agent_attach_leases_parent
  ON agent_attach_leases(parent_lease_id);
