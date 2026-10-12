// agentStanding.js — Agent Standing (per org+agent+task_class trust score)
//
// Sits below the per-decision Autonomy Decision framework
// (autonomyDecision.js's makeDecision()). Where makeDecision() gates a
// single decision on budget/tool-risk/failure-history, Standing gates on
// an agent's TRACK RECORD in a given task class:
//
//   - clean_completion  → small positive nudge, and (while supervised)
//                          counts toward redemption.
//   - correction /
//     override /
//     rollback          → an immediate, dated drop event. A score below
//                          SUPERVISED_THRESHOLD flips status to
//                          'supervised', which forces ESCALATE in
//                          makeDecision() regardless of the other checks
//                          (metadata.standing_gated = true).
//   - redemption_run    → written automatically once 3 consecutive clean
//                          supervised completions land whose MINIMUM risk
//                          tier is >= the tier of the task that triggered
//                          the drop. Flips status back to 'autonomous'.
//
// Cold start mirrors agentScorer.js's neutral prior: standing_score = 50,
// status = 'autonomous' — a never-seen agent+class starts trusted, not
// penalised.
//
// task_class = agent_performance.domain (see agentScorer.js) — the same
// per-task domain tag the AT-3 learning router scores agents on.
// agent_performance is populated by agentScorer.recordPerformance(), keyed
// per task_id; resolveTaskClass() below reads it that way. NOTE: as of
// this writing recordPerformance() has no production call site anywhere
// in this repo (only services/tasks/test/agentScorer.test.js calls it) —
// agent_performance is not actually populated by any live code path yet.
// That is a pre-existing gap in a different stream, not fixed by this
// pass; resolveTaskClass() falls back to 'general' (agentScorer.js's own
// default for an unset domain) whenever no row exists, so Standing degrades
// gracefully (single shared 'general' bucket per agent) rather than
// throwing, but the gate is effectively dormant on real task_class
// granularity until that recording gap is closed elsewhere.

import { ulid } from 'ulid'
import { getDatabase } from '../db/index.js'
import { HIGH_RISK_TOOLS } from './riskTools.js'

export const STANDING_STATUS = Object.freeze({
  AUTONOMOUS: 'autonomous',
  SUPERVISED: 'supervised',
})

export const EVENT_TYPES = Object.freeze({
  CLEAN_COMPLETION: 'clean_completion',
  CORRECTION: 'correction',
  ROLLBACK: 'rollback',
  OVERRIDE: 'override',
  REDEMPTION_RUN: 'redemption_run',
})

const COLD_START_SCORE = 50 // mirrors agentScorer.js's coldStartScore() prior
const SUPERVISED_THRESHOLD = 40
const REDEMPTION_RUN_COUNT = 3

// Score deltas per event type. The design brief specifies the thresholds
// (cold start 50, supervised below 40, redemption at 3 runs) but not exact
// per-event deltas beyond "an immediate dated drop event" for
// correction/override — chosen so a single override/rollback can plausibly
// cross the supervised threshold on its own from a mid-range score, while
// a lone correction is a smaller nudge. Documented here, not hidden.
const DELTAS = Object.freeze({
  [EVENT_TYPES.CLEAN_COMPLETION]: 2,
  [EVENT_TYPES.CORRECTION]: -15,
  [EVENT_TYPES.ROLLBACK]: -25,
  [EVENT_TYPES.OVERRIDE]: -20,
  [EVENT_TYPES.REDEMPTION_RUN]: 0, // status flip only, no independent delta
})

const DROP_EVENT_TYPES = new Set([EVENT_TYPES.CORRECTION, EVENT_TYPES.ROLLBACK, EVENT_TYPES.OVERRIDE])

const RISK_TIER_RANK = Object.freeze({ normal: 0, high: 1 })

// Exported so the read endpoint (server.js's GET /api/agent-standing/:agentId)
// can replay agent_standing_events into a running-score history using the
// exact same clamping this module uses at write time, rather than
// duplicating the 0-100 clamp logic.
export function clampScore(n) {
  return Math.max(0, Math.min(100, n))
}

/**
 * Binary risk tier for a task, joined against the same HIGH_RISK_TOOLS set
 * makeDecision()'s tool-risk check uses. Checks both `tools_required`
 * (decision-time shape referenced by autonomyDecision.js's makeDecision —
 * not an actual tasks column as of this writing) and `tools_used` (the
 * real post-completion tasks column) so this works whichever the caller
 * has on hand.
 */
export function taskRiskTier(task) {
  if (!task) return 'normal'
  let tools = []
  try { if (task.tools_required) tools = tools.concat(JSON.parse(task.tools_required)) } catch { /* malformed */ }
  try { if (task.tools_used) tools = tools.concat(JSON.parse(task.tools_used)) } catch { /* malformed */ }
  return tools.some((t) => HIGH_RISK_TOOLS.has(t)) ? 'high' : 'normal'
}

/**
 * task_class = agent_performance.domain for the given task_id. Falls back
 * to 'general' (agentScorer.js's own default) if no agent_performance row
 * exists yet for this task — see module doc comment above for why that's
 * the common case today.
 */
export function resolveTaskClass(db, taskId) {
  if (!taskId) return 'general'
  const row = db.prepare(`
    SELECT domain FROM agent_performance WHERE task_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(taskId)
  return row?.domain || 'general'
}

function ensureStanding(db, orgId, agentId, taskClass) {
  let row = db.prepare(`
    SELECT * FROM agent_standing WHERE org_id = ? AND agent_id = ? AND task_class = ?
  `).get(orgId, agentId, taskClass)

  if (!row) {
    const id = ulid()
    db.prepare(`
      INSERT INTO agent_standing (id, org_id, agent_id, task_class, standing_score, status, consecutive_clean_supervised, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
    `).run(id, orgId, agentId, taskClass, COLD_START_SCORE, STANDING_STATUS.AUTONOMOUS)
    row = db.prepare('SELECT * FROM agent_standing WHERE id = ?').get(id)
  }
  return row
}

/**
 * Read-only standing lookup — never creates a row. Callers that only need
 * to check gating status (makeDecision()) use this, not ensureStanding, so
 * an ordinary decision check never writes to the DB for an agent+class
 * that has never had an event.
 *
 * @returns {{ status: string, standing_score: number, consecutive_clean_supervised: number, last_change_at: string|null, last_change_reason: string|null }}
 */
export function getStanding(orgId, agentId, taskClass) {
  const db = getDatabase()
  const row = db.prepare(`
    SELECT * FROM agent_standing WHERE org_id = ? AND agent_id = ? AND task_class = ?
  `).get(orgId, agentId, taskClass)
  if (row) return row
  return {
    id: null,
    org_id: orgId,
    agent_id: agentId,
    task_class: taskClass,
    standing_score: COLD_START_SCORE,
    status: STANDING_STATUS.AUTONOMOUS,
    consecutive_clean_supervised: 0,
    last_change_at: null,
    last_change_reason: null,
  }
}

function defaultEventSummary(eventType) {
  switch (eventType) {
    case EVENT_TYPES.CLEAN_COMPLETION: return 'Clean completion'
    case EVENT_TYPES.CORRECTION: return 'Correction requested'
    case EVENT_TYPES.ROLLBACK: return 'Task rolled back'
    case EVENT_TYPES.OVERRIDE: return 'Human override'
    case EVENT_TYPES.REDEMPTION_RUN: return 'Redemption run'
    default: return eventType
  }
}

/**
 * Read-side shape for the frontend StandingBadge component: current
 * score/status plus a reconstructed running-score history and a recent
 * events list. There is no stored per-event running-score column, so
 * history is rebuilt by replaying agent_standing_events chronologically
 * from COLD_START_SCORE, applying each event's already-recorded delta and
 * clamping with the same clampScore() used at write time — this reproduces
 * the real score sequence exactly, since recordStandingEvent() clamps in
 * the same order when it originally wrote each delta.
 *
 * Never-seen agent+task_class (no agent_standing row) returns the cold
 * start default with empty history/events, matching getStanding()'s own
 * read-only semantics rather than a 404.
 *
 * @returns {{ score: number, status: string, history: number[], events: Array }}
 */
export function getStandingWithHistory(orgId, agentId, taskClass, { limit = 20 } = {}) {
  const standing = getStanding(orgId, agentId, taskClass)

  if (!standing.id) {
    return { score: standing.standing_score, status: standing.status, history: [], events: [] }
  }

  const db = getDatabase()
  const allEvents = db.prepare(`
    SELECT event_type, delta, task_id, objective_id, actor, reason, created_at
    FROM agent_standing_events
    WHERE standing_id = ?
    ORDER BY rowid ASC
  `).all(standing.id)

  let running = COLD_START_SCORE
  const runningScores = allEvents.map((ev) => {
    running = clampScore(running + (ev.delta || 0))
    return running
  })

  const history = runningScores.slice(-limit)
  const events = allEvents
    .slice(-limit)
    .reverse()
    .map((ev) => ({
      ts: ev.created_at,
      kind: ev.event_type,
      summary: ev.reason || defaultEventSummary(ev.event_type),
      delta: ev.delta || 0,
    }))

  return {
    score: standing.standing_score,
    status: standing.status,
    history,
    events,
  }
}

/**
 * Checks whether 3 consecutive clean_completion events (since the standing
 * row's last_change_at, i.e. since the last drop) have landed whose
 * MINIMUM risk tier is at least the risk tier of the task that triggered
 * that drop. If eligible, writes a redemption_run event and flips status
 * back to 'autonomous'. No-op (returns null) if not eligible or not
 * currently supervised.
 */
function maybeRedeem(db, standing) {
  if (standing.status !== STANDING_STATUS.SUPERVISED) return null

  // Uses rowid (SQLite's implicit insertion-order column — this table has
  // no WITHOUT ROWID clause) rather than comparing created_at strings
  // against standing.last_change_at: created_at comes from SQL
  // datetime('now') ("YYYY-MM-DD HH:MM:SS"), while last_change_at was
  // being written as a JS Date#toISOString() ("...T...Z") — different
  // lexical formats that don't compare correctly against each other, and
  // even same-format strings only have 1-second resolution, too coarse
  // for tests/back-to-back events. rowid ordering sidesteps both issues.
  const dropEvent = db.prepare(`
    SELECT rowid, task_id FROM agent_standing_events
    WHERE standing_id = ? AND event_type IN ('correction', 'override', 'rollback')
    ORDER BY rowid DESC LIMIT 1
  `).get(standing.id)

  const recentClean = db.prepare(`
    SELECT task_id FROM agent_standing_events
    WHERE standing_id = ? AND event_type = 'clean_completion'
      AND (? IS NULL OR rowid > ?)
    ORDER BY rowid DESC LIMIT ?
  `).all(standing.id, dropEvent?.rowid ?? null, dropEvent?.rowid ?? null, REDEMPTION_RUN_COUNT)

  if (recentClean.length < REDEMPTION_RUN_COUNT) return null

  const getTask = (taskId) => (taskId ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) : null)

  const dropTier = dropEvent ? taskRiskTier(getTask(dropEvent.task_id)) : 'normal'
  const runTiers = recentClean.map((r) => taskRiskTier(getTask(r.task_id)))
  const minRunTierRank = Math.min(...runTiers.map((t) => RISK_TIER_RANK[t] ?? 0))

  if (minRunTierRank < RISK_TIER_RANK[dropTier]) return null

  const reason = `redemption: ${REDEMPTION_RUN_COUNT} consecutive clean supervised runs at >= ${dropTier} risk tier`

  db.prepare(`
    INSERT INTO agent_standing_events (id, standing_id, org_id, agent_id, task_class, event_type, delta, task_id, objective_id, actor, reason, created_at)
    VALUES (?, ?, ?, ?, ?, 'redemption_run', 0, NULL, NULL, 'system:agent_standing', ?, datetime('now'))
  `).run(ulid(), standing.id, standing.org_id, standing.agent_id, standing.task_class, reason)

  // last_change_at uses SQL datetime('now') (same "YYYY-MM-DD HH:MM:SS"
  // format agent_standing_events.created_at uses) rather than a JS
  // Date#toISOString() string, so any future consumer that compares the
  // two textually gets consistent lexical ordering.
  db.prepare(`
    UPDATE agent_standing
    SET status = 'autonomous', consecutive_clean_supervised = 0, last_change_at = datetime('now'), last_change_reason = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(reason, standing.id)

  return { redeemed: true, dropTier }
}

/**
 * Record a standing event and update the (org, agent, task_class)
 * standing row accordingly. Creates the standing row (cold start 50,
 * autonomous) on first event for a never-seen agent+class.
 *
 * @param {string} orgId
 * @param {string} agentId
 * @param {string} taskClass
 * @param {Object} opts
 * @param {string} opts.eventType — one of EVENT_TYPES
 * @param {string} [opts.taskId]
 * @param {string} [opts.objectiveId]
 * @param {string} [opts.actor] — who/what caused this (user id, 'system:...')
 * @param {string} [opts.reason]
 * @returns {{ standing: Object, redemption: Object|null }}
 */
export function recordStandingEvent(orgId, agentId, taskClass, { eventType, taskId = null, objectiveId = null, actor = null, reason = null } = {}) {
  if (!Object.values(EVENT_TYPES).includes(eventType)) {
    throw new Error(`[AgentStanding] Unknown event_type: ${eventType}`)
  }
  if (!orgId || !agentId || !taskClass) {
    throw new Error('[AgentStanding] orgId, agentId and taskClass are required')
  }

  const db = getDatabase()
  const standing = ensureStanding(db, orgId, agentId, taskClass)
  const delta = DELTAS[eventType] ?? 0
  const newScore = clampScore(standing.standing_score + delta)

  db.prepare(`
    INSERT INTO agent_standing_events (id, standing_id, org_id, agent_id, task_class, event_type, delta, task_id, objective_id, actor, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(ulid(), standing.id, orgId, agentId, taskClass, eventType, delta, taskId, objectiveId, actor, reason)

  let nextStatus = standing.status
  let nextConsecutive = standing.consecutive_clean_supervised
  let lastChangeAt = standing.last_change_at
  let lastChangeReason = standing.last_change_reason

  if (DROP_EVENT_TYPES.has(eventType)) {
    nextConsecutive = 0
    if (newScore < SUPERVISED_THRESHOLD && standing.status === STANDING_STATUS.AUTONOMOUS) {
      nextStatus = STANDING_STATUS.SUPERVISED
      // SQL-generated timestamp (same "YYYY-MM-DD HH:MM:SS" format as
      // agent_standing_events.created_at), not JS Date#toISOString() —
      // see maybeRedeem()'s comment on why format consistency matters here.
      lastChangeAt = db.prepare("SELECT datetime('now') AS ts").get().ts
      lastChangeReason = reason || `${eventType} dropped standing to ${newScore}`
    }
  } else if (eventType === EVENT_TYPES.CLEAN_COMPLETION && standing.status === STANDING_STATUS.SUPERVISED) {
    nextConsecutive = standing.consecutive_clean_supervised + 1
  }

  db.prepare(`
    UPDATE agent_standing
    SET standing_score = ?, status = ?, consecutive_clean_supervised = ?, last_change_at = ?, last_change_reason = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(newScore, nextStatus, nextConsecutive, lastChangeAt, lastChangeReason, standing.id)

  let updated = db.prepare('SELECT * FROM agent_standing WHERE id = ?').get(standing.id)

  let redemption = null
  if (eventType === EVENT_TYPES.CLEAN_COMPLETION && updated.status === STANDING_STATUS.SUPERVISED) {
    redemption = maybeRedeem(db, updated)
    if (redemption) {
      updated = db.prepare('SELECT * FROM agent_standing WHERE id = ?').get(standing.id)
    }
  }

  return { standing: updated, redemption }
}

export function recordCleanCompletion(orgId, agentId, taskClass, meta = {}) {
  return recordStandingEvent(orgId, agentId, taskClass, { ...meta, eventType: EVENT_TYPES.CLEAN_COMPLETION })
}

export function recordCorrection(orgId, agentId, taskClass, meta = {}) {
  return recordStandingEvent(orgId, agentId, taskClass, { ...meta, eventType: EVENT_TYPES.CORRECTION })
}

export function recordOverride(orgId, agentId, taskClass, meta = {}) {
  return recordStandingEvent(orgId, agentId, taskClass, { ...meta, eventType: EVENT_TYPES.OVERRIDE })
}

export function recordRollback(orgId, agentId, taskClass, meta = {}) {
  return recordStandingEvent(orgId, agentId, taskClass, { ...meta, eventType: EVENT_TYPES.ROLLBACK })
}

export function isSupervised(orgId, agentId, taskClass) {
  return getStanding(orgId, agentId, taskClass).status === STANDING_STATUS.SUPERVISED
}
