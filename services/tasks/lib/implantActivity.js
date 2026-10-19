/**
 * QuoxMind implant activity: when each implant last FIRED and how often in the
 * last 7 days, read from the table that implant itself writes. Served at
 * GET /api/engine/activity (org-scoped) and merged into the collector's
 * /api/v1/mind/implants, so `quox mind` and the TUI's /mind show real firing
 * evidence instead of a static status (QUOXMIND-PROOF, owner 2026-10-15:
 * "i want proof these implants are doing things... not just dormant").
 *
 * Honesty rules:
 *   - An implant with no record of its own reports source null, not a
 *     neighbour's table (insight only correlates sense's signals).
 *   - A dream cycle that skipped did no work, so it is an idle run, not a
 *     firing.
 *   - A source that errors reports the error with fired_7d null, never 0.
 *
 * Timestamps differ by writer (SQLite datetime vs ISO strings), so the window
 * compares through julianday() and output is normalised to ISO-8601 UTC.
 */

// implant id -> where its own firings are recorded.
//   table: the implant's own output table; ts: the firing timestamp column;
//   where: extra filter (constant SQL, no user input).
export const ACTIVITY_SOURCES = {
  'quox-sense': { table: 'implant_signals', ts: 'created_at' },
  'quox-temporal': { table: 'tasks', ts: 'completed_at', where: "status = 'completed' AND duration_ms > 0" },
  'quox-focus': { table: 'wsm_recent_entities', ts: 'last_mentioned_at' },
  'quox-value': { table: 'agent_performance', ts: 'created_at' },
  'quox-guard': { table: 'autonomy_decisions', ts: 'created_at' },
  'quox-insight': null, // correlates quox-sense signals; records nothing of its own
  'quox-executive': { table: 'objectives', ts: 'created_at' },
  'quox-predict': { table: 'execution_wisdom', ts: 'last_seen_at' },
  'quox-reflect': { table: 'objective_outcomes', ts: 'created_at' },
  'quox-dream': { table: 'dream_cycles', ts: 'completed_at', where: 'skipped = 0', idleWhere: 'skipped = 1' },
  'quox-learn': { table: 'agent_performance', ts: 'created_at' },
}

function toIso(v) {
  if (!v) return null
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) return `${s.replace(' ', 'T')}Z`
  return s
}

function readSource(db, orgId, src) {
  const filter = src.where ? ` AND ${src.where}` : ''
  const row = db.prepare(`
    SELECT MAX(${src.ts}) AS last_at,
           SUM(CASE WHEN julianday(${src.ts}) >= julianday('now', '-7 days') THEN 1 ELSE 0 END) AS n7
    FROM ${src.table}
    WHERE org_id = ? AND ${src.ts} IS NOT NULL${filter}
  `).get(orgId)
  const out = { source: src.table, last_fired_at: toIso(row?.last_at), fired_7d: row?.n7 || 0, error: null }
  if (src.idleWhere) {
    const idle = db.prepare(`
      SELECT COUNT(*) AS n FROM ${src.table}
      WHERE org_id = ? AND ${src.idleWhere} AND julianday(${src.ts}) >= julianday('now', '-7 days')
    `).get(orgId)
    out.idle_runs_7d = idle?.n || 0
  }
  return out
}

/**
 * @param {object} db better-sqlite3 handle
 * @param {{orgId: string}} opts
 * @returns {Record<string, {source: string|null, last_fired_at: string|null, fired_7d: number|null, error: string|null, idle_runs_7d?: number}>}
 */
export function computeImplantActivity(db, { orgId } = {}) {
  if (!orgId) throw new Error('computeImplantActivity: orgId required')
  const out = {}
  for (const [id, src] of Object.entries(ACTIVITY_SOURCES)) {
    if (!src) {
      out[id] = { source: null, last_fired_at: null, fired_7d: null, error: null }
      continue
    }
    try {
      out[id] = readSource(db, orgId, src)
    } catch (err) {
      out[id] = { source: src.table, last_fired_at: null, fired_7d: null, error: `${src.table}: ${err.message}` }
    }
  }
  return out
}
