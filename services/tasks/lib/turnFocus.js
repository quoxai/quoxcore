// QUOXMIND #1110: the per-turn working set that makes QuoxFocus fire and feeds
// QuoxExecutive, QuoxTemporal and QuoxSense into the chat turn instead of
// display only ("wire things up so they get used and provide a benefit").
//
// Called once per HUMAN chat turn (collector -> POST /api/internal/focus/turn).
// One synchronous pass over this service's own DB, all queries org-scoped:
//
//   focus      records the ask in wsm_recent_entities (entity_type 'ask'),
//              bounded to MAX_STORED_ASKS per user+org, and returns the user's
//              previous asks plus open loops (Pro only: the route decides).
//   executive  in-flight objectives (dag and loop) and in-flight task count.
//   temporal   tasks in 24h / 7d, busiest UTC hour, last activity.
//   sense      perceives trouble ONCE into implant_signals (quox-sense):
//              fleet concerns the collector hands in (already org-filtered)
//              and objectives that failed in the last hour. "Notable now" is
//              read back from implant_signals, newest first, max 3.
//
// Insight is deliberately NOT wired here: it is a Pro faculty that correlates
// sense signals (insightStats.js); now that sense records real signals it has
// input, but feeding its clusters into a turn waits on a Pro-gated consumer.

import { createHash } from 'node:crypto'

export const MAX_STORED_ASKS = 20
// Asks are personal: kept at most 20 per user+org AND at most this many days.
// Erased with the user via eraseUserWorkingSet (GDPR cascade, POST /internal/erase-user).
export const ASK_RETENTION_DAYS = 30
export const MAX_CONCERNS_PER_TURN = 5
const ASK_CHARS = 160
const RETURNED_ASKS = 3
const IN_FLIGHT = ['pending', 'running', 'in_progress', 'queued']
const NOTABLE_WINDOW = '-60 minutes'
const CONCERN_DEDUPE = '-60 minutes'
const FAILURE_DEDUPE = '-2 days'

// SQLite datetime() format with milliseconds: sorts correctly beside plain
// datetime('now') values and keeps turns in the same second ordered.
const NOW_MS = "strftime('%Y-%m-%d %H:%M:%f','now')"

function toIso(v) {
  if (!v) return null
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) return `${s.replace(' ', 'T')}Z`
  return s
}

function askKey(text) {
  return createHash('sha1').update(text.toLowerCase()).digest('hex').slice(0, 16)
}

function recordAsk(db, { orgId, userId, text }) {
  const key = askKey(text)
  db.prepare(`
    INSERT INTO wsm_recent_entities (org_id, user_id, entity_type, entity_id, name, last_mentioned_at, mention_count)
    VALUES (?, ?, 'ask', ?, ?, ${NOW_MS}, 1)
    ON CONFLICT(org_id, user_id, entity_type, entity_id) DO UPDATE SET
      name = excluded.name, last_mentioned_at = excluded.last_mentioned_at,
      mention_count = wsm_recent_entities.mention_count + 1
  `).run(orgId, userId, key, text)
  db.prepare(`
    DELETE FROM wsm_recent_entities
    WHERE org_id = ? AND user_id = ? AND entity_type = 'ask' AND entity_id NOT IN (
      SELECT entity_id FROM wsm_recent_entities
      WHERE org_id = ? AND user_id = ? AND entity_type = 'ask'
      ORDER BY last_mentioned_at DESC LIMIT ?)
  `).run(orgId, userId, orgId, userId, MAX_STORED_ASKS)
  return key
}

function ageOutAsks(db, { orgId, userId }) {
  db.prepare(`
    DELETE FROM wsm_recent_entities
    WHERE org_id = ? AND user_id = ? AND entity_type = 'ask'
      AND julianday(last_mentioned_at) < julianday('now', ?)
  `).run(orgId, userId, `-${ASK_RETENTION_DAYS} days`)
}

function readAsks(db, { orgId, userId, excludeKey }) {
  return db.prepare(`
    SELECT entity_id, name, last_mentioned_at FROM wsm_recent_entities
    WHERE org_id = ? AND user_id = ? AND entity_type = 'ask' AND entity_id != ?
    ORDER BY last_mentioned_at DESC LIMIT ?
  `).all(orgId, userId, excludeKey || '', RETURNED_ASKS)
    .map((r) => ({ text: r.name, at: toIso(r.last_mentioned_at) }))
}

function readOpenLoops(db, { orgId, userId }) {
  return db.prepare(`
    SELECT description, priority, due_by FROM wsm_open_loops
    WHERE org_id = ? AND user_id = ? AND status = 'open'
    ORDER BY last_touched_at DESC LIMIT 3
  `).all(orgId, userId).map((r) => ({ description: r.description, priority: r.priority, dueBy: r.due_by }))
}

function readExecutive(db, { orgId }) {
  const ph = IN_FLIGHT.map(() => '?').join(',')
  const inFlight = db.prepare(`SELECT COUNT(*) AS n FROM objectives WHERE org_id = ? AND status IN (${ph})`).get(orgId, ...IN_FLIGHT).n
  const top = db.prepare(`
    SELECT id, title, status, execution_mode, COALESCE(started_at, created_at) AS since FROM objectives
    WHERE org_id = ? AND status IN (${ph})
    ORDER BY COALESCE(started_at, created_at) DESC LIMIT 3
  `).all(orgId, ...IN_FLIGHT).map((o) => ({ id: o.id, title: o.title, status: o.status, mode: o.execution_mode || 'dag', since: toIso(o.since) }))
  const tasksInFlight = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND status IN (${ph})`).get(orgId, ...IN_FLIGHT).n
  return { objectives: { inFlight, top }, tasks: { inFlight: tasksInFlight } }
}

function readTemporal(db, { orgId }) {
  const row = db.prepare(`
    SELECT SUM(CASE WHEN julianday(created_at) >= julianday('now','-1 day') THEN 1 ELSE 0 END) AS n24,
           COUNT(*) AS n7, MAX(created_at) AS last_at
    FROM tasks WHERE org_id = ? AND julianday(created_at) >= julianday('now','-7 days')
  `).get(orgId)
  let peakHourUtc = null
  if (row.n7 > 0) {
    const peak = db.prepare(`
      SELECT CAST(strftime('%H', created_at) AS INTEGER) AS h, COUNT(*) AS n FROM tasks
      WHERE org_id = ? AND julianday(created_at) >= julianday('now','-7 days')
      GROUP BY h ORDER BY n DESC, h ASC LIMIT 1
    `).get(orgId)
    peakHourUtc = peak ? peak.h : null
  }
  return { tasks24h: row.n24 || 0, tasks7d: row.n7 || 0, peakHourUtc, lastActivityAt: toIso(row.last_at) }
}

function perceive(db, { orgId, type, key, summary, window }) {
  const seen = db.prepare(`
    SELECT 1 FROM implant_signals
    WHERE org_id = ? AND implant_id = 'quox-sense' AND signal_type = ?
      AND json_extract(payload, '$.key') = ? AND julianday(created_at) >= julianday('now', ?)
    LIMIT 1
  `).get(orgId, type, key, window)
  if (seen) return 0
  db.prepare(`
    INSERT INTO implant_signals (id, org_id, implant_id, signal_type, payload, created_at)
    VALUES (?, ?, 'quox-sense', ?, ?, ${NOW_MS})
  `).run(createHash('sha1').update(`${orgId}:${type}:${key}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 26), orgId, type, JSON.stringify({ key, summary }))
  return 1
}

function senseTrouble(db, { orgId, concerns }) {
  let n = 0
  const valid = (Array.isArray(concerns) ? concerns : [])
    .filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && c.id && typeof c.description === 'string' && c.description)
    .slice(0, MAX_CONCERNS_PER_TURN)
  for (const c of valid) {
    n += perceive(db, { orgId, type: 'fleet_concern', key: c.id.slice(0, 120), summary: c.description.slice(0, 160), window: CONCERN_DEDUPE })
  }
  const failed = db.prepare(`
    SELECT id, title, error_message FROM objectives
    WHERE org_id = ? AND status = 'failed' AND completed_at IS NOT NULL
      AND julianday(completed_at) >= julianday('now', ?)
    ORDER BY completed_at DESC LIMIT 3
  `).all(orgId, NOTABLE_WINDOW)
  for (const o of failed) {
    const why = o.error_message ? `: ${String(o.error_message).slice(0, 80)}` : ''
    n += perceive(db, { orgId, type: 'objective_failed', key: o.id, summary: `objective "${String(o.title).slice(0, 80)}" failed${why}`, window: FAILURE_DEDUPE })
  }
  return n
}

function readNotable(db, { orgId }) {
  const rows = db.prepare(`
    SELECT signal_type, payload, created_at FROM implant_signals
    WHERE org_id = ? AND implant_id = 'quox-sense' AND julianday(created_at) >= julianday('now', ?)
    ORDER BY created_at DESC
  `).all(orgId, NOTABLE_WINDOW)
  const byKey = new Map()
  for (const r of rows) {
    let p = {}
    try { p = JSON.parse(r.payload) || {} } catch { p = {} }
    const k = `${r.signal_type}:${p.key || r.created_at}`
    if (!byKey.has(k)) byKey.set(k, { type: r.signal_type, summary: p.summary || r.signal_type, at: toIso(r.created_at) })
  }
  const all = [...byKey.values()]
  return { count: all.length, items: all.slice(0, 3) }
}

/**
 * @param {object} db better-sqlite3 handle
 * @param {{orgId: string, userId: string, prompt?: string, includeOpenLoops?: boolean, concerns?: Array}} opts
 */
export function recordTurnAndReadFocus(db, { orgId, userId, prompt = '', includeOpenLoops = false, concerns = [] } = {}) {
  if (!orgId || !userId) throw new Error('recordTurnAndReadFocus: orgId and userId required')
  const text = String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, ASK_CHARS)
  const run = db.transaction(() => {
    ageOutAsks(db, { orgId, userId })
    const key = text.length >= 2 ? recordAsk(db, { orgId, userId, text }) : null
    const signals = senseTrouble(db, { orgId, concerns })
    return { key, signals }
  })
  const { key, signals } = run()
  return {
    now: new Date().toISOString(),
    asks: readAsks(db, { orgId, userId, excludeKey: key }),
    openLoops: includeOpenLoops ? readOpenLoops(db, { orgId, userId }) : null,
    ...readExecutive(db, { orgId }),
    temporal: readTemporal(db, { orgId }),
    notable: readNotable(db, { orgId }),
    recorded: { ask: !!key, signals },
  }
}

/**
 * GDPR erasure: delete everything the working set holds about one user, in
 * every org (asks and other recent entities, current focus, open loops).
 * implant_signals hold org-level observations, not user data, so they stay.
 */
export function eraseUserWorkingSet(db, { userId } = {}) {
  if (!userId) throw new Error('eraseUserWorkingSet: userId required')
  return db.transaction(() => {
    let n = 0
    for (const t of ['wsm_recent_entities', 'wsm_focus', 'wsm_open_loops']) {
      n += db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId).changes
    }
    return { n }
  })()
}
