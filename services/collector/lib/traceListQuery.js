/**
 * SQL builder for GET /traces (quox#806).
 *
 * The old query used `e.intent LIKE 'aocl.run.%'`. SQLite cannot use a BINARY
 * index for LIKE by default, so idx_envelopes_org_intent_ts degraded to
 * idx_envelopes_org and scanned every row for the org (measured 17s on dev for
 * COUNT(DISTINCT corr), 105k matching of 2.6M rows), then a second pass for the
 * list. An explicit range (intent >= 'aocl.run.' AND intent < 'aocl.run/',
 * '/' being the char after '.') is index-searchable. The per-request
 * COUNT(DISTINCT corr) is dropped by default (has_more via a limit+1 probe).
 */
function buildTraceListQuery({ orgId, after, before, sort, limit, offset, withCount = false }) {
  let whereSql = "e.intent >= 'aocl.run.' AND e.intent < 'aocl.run/' AND e.org_id = ?";
  const whereParams = [orgId];
  if (after) { whereSql += ' AND e.ts >= ?'; whereParams.push(after); }
  if (before) { whereSql += ' AND e.ts < ?'; whereParams.push(before); }

  let listSql = `
      SELECT e.corr, MIN(e.ts) as first_ts, MAX(e.ts) as last_ts
      FROM envelopes e WHERE ${whereSql}
      GROUP BY e.corr
    `;
  listSql += sort === 'oldest' ? ' ORDER BY first_ts ASC' : ' ORDER BY last_ts DESC';
  listSql += ' LIMIT ? OFFSET ?';

  return {
    listSql,
    listParams: [...whereParams, limit + 1, offset],
    countSql: withCount
      ? `SELECT COUNT(DISTINCT e.corr) as total FROM envelopes e WHERE ${whereSql}`
      : null,
    countParams: whereParams,
  };
}

module.exports = { buildTraceListQuery };
