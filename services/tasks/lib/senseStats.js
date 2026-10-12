// Stream QMH (QuoxMind Honest), QMH-2 QuoxSense commit.
//
// Sense's signal source must be the implant_signals table — durable
// observations across services. The frontend senseService kept signals in an
// in-memory buffer that vanished on every page reload, claiming to be a
// perceptual core but functionally telling the user nothing it didn't already
// know in the same session.
//
// Public API:
//   persistImplantSignal(db, { orgId, implantId, signalType, payload })
//   computeSenseStats(db, { orgId })
//
// Producers (other implants emitting signals) wire up via persistImplantSignal.
// QMH-2 lays the foundation — broader producer wiring follows in QMH-3.

import { ulid } from 'ulid'

/**
 * Record one observation. payload is JSON-serialised. Signals are queryable
 * by (org_id, implant_id, created_at DESC) and (implant_id, signal_type, created_at DESC).
 */
export function persistImplantSignal(db, { orgId, implantId, signalType, payload = {} }) {
  if (!orgId) throw new Error('persistImplantSignal: orgId required')
  if (!implantId) throw new Error('persistImplantSignal: implantId required')
  if (!signalType) throw new Error('persistImplantSignal: signalType required')

  const id = ulid()
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload || {})
  db.prepare(`
    INSERT INTO implant_signals (id, org_id, implant_id, signal_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(id, orgId, implantId, signalType, json)
  return { id }
}

/**
 * Aggregate observations for an org. Returns 24h count, recent-rate, unique
 * reporting implants, breakdown by type, healthScore.
 */
export function computeSenseStats(db, { orgId } = {}) {
  if (!orgId) throw new Error('computeSenseStats: orgId required')

  const totals = db.prepare(`
    SELECT
      COUNT(*)                                                        AS count_total,
      COUNT(DISTINCT implant_id)                                      AS unique_implants,
      MAX(created_at)                                                 AS last_signal_at
    FROM implant_signals
    WHERE org_id = ?
  `).get(orgId)

  const window24h = db.prepare(`
    SELECT COUNT(*) AS count
    FROM implant_signals
    WHERE org_id = ?
      AND created_at >= datetime('now', '-1 day')
  `).get(orgId)

  const window60s = db.prepare(`
    SELECT COUNT(*) AS count
    FROM implant_signals
    WHERE org_id = ?
      AND created_at >= datetime('now', '-1 minute')
  `).get(orgId)

  const breakdownRows = db.prepare(`
    SELECT signal_type AS type, COUNT(*) AS count
    FROM implant_signals
    WHERE org_id = ?
    GROUP BY signal_type
  `).all(orgId)

  const breakdown = {}
  for (const row of breakdownRows) breakdown[row.type] = row.count

  const signalCount = totals?.count_total || 0
  const uniqueImplants = totals?.unique_implants || 0

  return {
    signalCount,
    signals24h: window24h?.count || 0,
    signalRatePerMin: window60s?.count || 0,
    uniqueImplants,
    breakdown,
    lastSignalAt: totals?.last_signal_at || null,
    healthScore: senseHealthScore({ signalCount, uniqueImplants }),
  }
}

function senseHealthScore({ signalCount, uniqueImplants }) {
  if (signalCount === 0) return null
  let score = 100
  // Only one implant ever reported = perception isn't actually multi-source.
  if (signalCount >= 5 && uniqueImplants <= 1) score -= 20
  return Math.max(0, Math.min(100, score))
}
