-- 016-qlarity-org-allowlist.sql — NO-ENV-ONLY-CONFIG for QLarity's egress
-- allowlist (bundle audit themes S4 + S10; house hard rule: no feature ships
-- with only an environment switch).
--
-- QLARITY_ALLOWLIST is an install-wide env var read once at service boot. That
-- made the ONE setup step a new customer must perform impossible for them to
-- perform: they buy QLarity, open it, are told "no origins declared, so
-- nothing can be inspected", and cannot declare one without shell access to
-- the host. A paid product its own buyer cannot use.
--
-- This is the governed replacement: origins are per-org rows, added by an org
-- admin through the collector, and injected into each QLarity session at
-- create time. The env var stays as the install-wide default and is UNIONED
-- with the org's own entries, because the operator set those for every tenant
-- deliberately.
--
-- SCOPE NOTE, deliberately narrow: this list only governs WHICH PUBLIC ORIGINS
-- may be inspected. It cannot reach internal targets. QLarity's egress guard
-- resolves DNS and refuses non-routable, private and metadata addresses
-- independently of this list, and the separate operator-only
-- QLARITY_EGRESS_ALLOWLIST remains the sole escape hatch for legitimately
-- internal targets. Making THAT per-org would be an egress hole; making this
-- one per-org is just letting a customer name their own site.

CREATE TABLE IF NOT EXISTS qlarity_org_allowlist (
  org_id     TEXT NOT NULL,
  origin     TEXT NOT NULL,
  added_at   TEXT NOT NULL,
  added_by   TEXT,
  note       TEXT,
  PRIMARY KEY (org_id, origin)
);

CREATE INDEX IF NOT EXISTS idx_qlarity_org_allowlist_org
  ON qlarity_org_allowlist (org_id);
