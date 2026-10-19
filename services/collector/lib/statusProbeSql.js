'use strict';

// INCIDENT quox#700: SQL for the footer status-bar probes. Kept in one module so
// server.js and test/statusProbeQueryPlans.test.js run the SAME text (the test
// asserts EXPLAIN QUERY PLAN has no full-table SCAN for each).

// INCIDENT 2026-10-14 (QUOXON-AEE): GET /aee/query?corr=X blocked the loop 781 s.
// The generic `($corr IS NULL OR corr = $corr)` shape hides the predicate from
// the planner (it cannot use idx_corr), so it walked idx_envelopes_org_ts over
// the org's whole history. These builders splice ONLY the active filters into
// the SQL so the planner sees them (org_id+corr -> idx_envelopes_org_corr_ts).
function orgScopedWhere(f) {
  const where = ['org_id = $orgId'];
  const params = { orgId: f.orgId };
  if (f.type) { where.push('type = $type'); params.type = f.type; }
  if (f.intent) { where.push("intent LIKE $intent ESCAPE '\\'"); params.intent = f.intent; }
  if (f.from) { where.push('"from" = $from'); params.from = f.from; }
  if (f.to) { where.push('"to" = $to'); params.to = f.to; }
  if (f.after) { where.push('ts >= $after'); params.after = f.after; }
  if (f.before) { where.push('ts < $before'); params.before = f.before; }
  if (f.corr) { where.push('corr = $corr'); params.corr = f.corr; }
  return { where: where.join(' AND '), params };
}
function buildQueryOrgScoped(f) {
  const { where, params } = orgScopedWhere(f);
  params.limit = f.limit;
  return { sql: `SELECT * FROM envelopes WHERE ${where} ORDER BY ts DESC LIMIT $limit`, params };
}
function buildCountOrgScoped(f) {
  const { where, params } = orgScopedWhere(f);
  return { sql: `SELECT COUNT(*) as total FROM envelopes WHERE ${where}`, params };
}

// quox#1047: an intent PREFIX plus any other filter ran queryOrgScopedPrefix, whose
// `($after IS NULL OR ts >= $after)` shape hides every predicate from the planner, so
// ?intent=aocl.&after=<date> (aee_query_envelopes / aocl_get_decisions with `since`) walked
// the org's whole aocl history and hit the probe timeout (503). Splice only the active
// predicates; when the extra filters are only ts bounds, take the newest rowids from the
// COVERING idx_envelopes_org_intent_ts (org_id, intent, ts) first, as the footer probe does.
function orgPrefixWhere(f) {
  const where = ['org_id = $orgId', 'intent >= $intentLo', 'intent < $intentHi'];
  const params = { orgId: f.orgId, intentLo: f.intentLo, intentHi: f.intentHi };
  if (f.type) { where.push('type = $type'); params.type = f.type; }
  if (f.from) { where.push('"from" = $from'); params.from = f.from; }
  if (f.to) { where.push('"to" = $to'); params.to = f.to; }
  if (f.after) { where.push('ts >= $after'); params.after = f.after; }
  if (f.before) { where.push('ts < $before'); params.before = f.before; }
  if (f.corr) { where.push('corr = $corr'); params.corr = f.corr; }
  return { where: where.join(' AND '), params, tsOnly: !f.type && !f.from && !f.to && !f.corr };
}
function buildQueryOrgPrefix(f) {
  const { where, params, tsOnly } = orgPrefixWhere(f);
  params.limit = f.limit;
  if (tsOnly) {
    return {
      // Pinned: with a ts bound the planner prefers idx_envelopes_org_ts (org_id, ts>?) and
      // fetches every row in the window to test intent, which is the read that timed out.
      sql: `SELECT * FROM envelopes WHERE rowid IN (SELECT rowid FROM envelopes INDEXED BY idx_envelopes_org_intent_ts WHERE ${where} ORDER BY ts DESC LIMIT $limit) ORDER BY ts DESC`,
      params,
    };
  }
  return { sql: `SELECT * FROM envelopes WHERE ${where} ORDER BY ts DESC LIMIT $limit`, params };
}
function buildCountOrgPrefix(f) {
  const { where, params, tsOnly } = orgPrefixWhere(f);
  const pin = tsOnly ? ' INDEXED BY idx_envelopes_org_intent_ts' : '';
  return { sql: `SELECT COUNT(*) as total FROM envelopes${pin} WHERE ${where}`, params };
}

// #923: one agent's envelopes since a window start (the `quox reach unused` least-privilege read).
// The planner prefers idx_envelopes_org_ts even with every predicate spliced in, which walks the org's
// whole window (34.5 s on dev, 4.4M envelopes); pinned to ("from", ts) the same read is ~18 ms.
const queryAgentEnvelopesSince = `
    SELECT * FROM envelopes INDEXED BY idx_envelopes_from_ts
    WHERE "from" = $from AND ts >= $after AND org_id = $orgId
    ORDER BY ts DESC
    LIMIT $limit
  `;

module.exports = {
  buildQueryOrgScoped,
  buildQueryOrgPrefix,
  buildCountOrgPrefix,
  queryAgentEnvelopesSince,
  buildCountOrgScoped,
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
