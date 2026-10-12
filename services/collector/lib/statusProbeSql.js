'use strict';

// INCIDENT quox#700: SQL for the footer status-bar probes. Kept in one module so
// server.js and test/statusProbeQueryPlans.test.js run the SAME text (the test
// asserts EXPLAIN QUERY PLAN has no full-table SCAN for each).

module.exports = {
  // General prefix query (extra filters present): range-served, sorted by ts.
  queryOrgScopedPrefix: `
    SELECT * FROM envelopes
    WHERE intent >= $intentLo AND intent < $intentHi
      AND ($type IS NULL OR type = $type)
      AND ($from IS NULL OR "from" = $from)
      AND ($to IS NULL OR "to" = $to)
      AND ($after IS NULL OR ts >= $after)
      AND ($before IS NULL OR ts < $before)
      AND ($corr IS NULL OR corr = $corr)
      AND org_id = $orgId
    ORDER BY ts DESC
    LIMIT $limit
  `,
  // Footer-badge shape (org + intent prefix only). Two-step: the newest N
  // rowids come from the COVERING index idx_envelopes_org_intent_ts (migration
  // 039, no table lookups), then only those rows are fetched.
  queryOrgIntentPrefixLatest: `
    SELECT * FROM envelopes
    WHERE rowid IN (
      SELECT rowid FROM envelopes
      WHERE org_id = $orgId AND intent >= $intentLo AND intent < $intentHi
      ORDER BY ts DESC
      LIMIT $limit
    )
    ORDER BY ts DESC
  `,

  countOrgScopedPrefix: `
    SELECT COUNT(*) as total FROM envelopes
    WHERE intent >= $intentLo AND intent < $intentHi
      AND ($type IS NULL OR type = $type)
      AND ($from IS NULL OR "from" = $from)
      AND ($to IS NULL OR "to" = $to)
      AND ($after IS NULL OR ts >= $after)
      AND ($before IS NULL OR ts < $before)
      AND ($corr IS NULL OR corr = $corr)
      AND org_id = $orgId
  `,
  countOrgIntentPrefix: `
    SELECT COUNT(*) as total FROM envelopes
    WHERE org_id = $orgId AND intent >= $intentLo AND intent < $intentHi
  `,
  voltStatsByOrg: `
    SELECT
      (SELECT COUNT(*) FROM volt_runs WHERE org_id = ?1) + (SELECT COUNT(*) FROM volt_runs WHERE org_id IS NULL) as runs,
      (SELECT COUNT(*) FROM volt_events WHERE run_id IN (SELECT run_id FROM volt_runs WHERE org_id = ?1))
        + (SELECT COUNT(*) FROM volt_events WHERE run_id IN (SELECT run_id FROM volt_runs WHERE org_id IS NULL)) as events,
      (SELECT COUNT(*) FROM volt_bundles WHERE run_id IN (SELECT run_id FROM volt_runs WHERE org_id = ?1))
        + (SELECT COUNT(*) FROM volt_bundles WHERE run_id IN (SELECT run_id FROM volt_runs WHERE org_id IS NULL)) as bundles
  `,
};
