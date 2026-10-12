// Stream QMH (QuoxMind Honest), QMH-2 QuoxTemporal commit.
// Real temporal cognition derived from durable execution data (tasks.duration_ms),
// replacing the in-memory event buffer the previous QuoxTemporal implant read from.

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null
  if (sortedAsc.length === 1) return sortedAsc[0]
  // Linear-interpolated percentile (NIST type 7).
  const rank = (p / 100) * (sortedAsc.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sortedAsc[lo]
  const weight = rank - lo
  return Math.round(sortedAsc[lo] + weight * (sortedAsc[hi] - sortedAsc[lo]))
}

function emptyHourlyHistogram() {
  const out = {}
  for (let h = 0; h < 24; h++) out[String(h).padStart(2, '0')] = 0
  return out
}

/**
 * Compute QuoxTemporal stats from the tasks table.
 *
 * @param {Database} db        better-sqlite3 handle
 * @param {Object}   opts
 * @param {string}   opts.orgId       required — multi-tenant filter
 * @param {string=}  opts.sinceIso    ISO timestamp; defaults to 24h ago
 * @param {string=}  opts.agentId     optional agent filter
 * @returns {{taskCount, p50_ms, p95_ms, p99_ms, hourly_histogram, anomalies_24h, healthScore, windowSinceIso}}
 */
export function computeTemporalStats(db, { orgId, sinceIso, agentId } = {}) {
  if (!orgId) throw new Error('computeTemporalStats: orgId required')

  const since = sinceIso || new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString()

  const params = [orgId, since]
  let sql = `
    SELECT duration_ms, completed_at
    FROM tasks
    WHERE status = 'completed'
      AND duration_ms > 0
      AND org_id = ?
      AND completed_at IS NOT NULL
      AND completed_at >= ?
  `
  if (agentId) {
    sql += ' AND agent_id = ?'
    params.push(agentId)
  }
  sql += ' ORDER BY duration_ms ASC'

  const rows = db.prepare(sql).all(...params)
  const durations = rows.map(r => r.duration_ms)
  const taskCount = durations.length

  const histogram = emptyHourlyHistogram()
  for (const r of rows) {
    if (!r.completed_at) continue
    // completed_at is ISO; parse the hour.
    const hour = String(new Date(r.completed_at).getUTCHours()).padStart(2, '0')
    if (histogram[hour] !== undefined) histogram[hour]++
  }

  const p50_ms = percentile(durations, 50)
  const p95_ms = percentile(durations, 95)
  const p99_ms = percentile(durations, 99)

  let anomalies_24h = 0
  if (p95_ms !== null) {
    const threshold = p95_ms * 2
    anomalies_24h = durations.filter(d => d > threshold).length
  }

  const healthScore = computeHealthScore({ taskCount, p95_ms, anomalies_24h })

  return {
    taskCount,
    p50_ms,
    p95_ms,
    p99_ms,
    hourly_histogram: histogram,
    anomalies_24h,
    healthScore,
    windowSinceIso: since,
  }
}

/**
 * Health score for QuoxTemporal:
 *   - null when there is no data (UI renders "Collecting", not "DOWN")
 *   - 100 baseline when there is data
 *   - −5 per anomaly above 0 (capped at −40)
 *   - −10 if p95 > 60s (slow)
 *   - −20 if p95 > 300s (very slow)
 */
function computeHealthScore({ taskCount, p95_ms, anomalies_24h }) {
  if (taskCount === 0) return null
  let score = 100
  if (p95_ms !== null) {
    if (p95_ms > 300_000) score -= 20
    else if (p95_ms > 60_000) score -= 10
  }
  if (anomalies_24h > 0) {
    score -= Math.min(40, anomalies_24h * 5)
  }
  return Math.max(0, Math.min(100, score))
}
