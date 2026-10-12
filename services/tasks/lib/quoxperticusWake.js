/**
 * QUOXPERTICUS wake seam (P3)
 *
 * The persistence supervisor on the resident box TRIGGERS a wake and chooses
 * NOTHING (DEC-5): mode, capability scope, org binding and the standing goal
 * all resolve server-side here. Every wake creates a PRE-START-GATED loop
 * objective: on a real instance a human approves each patrol from the inbox;
 * on a leased disposable sandbox the platform's own gates let the exercise
 * resolve end to end. The wake itself never dispatches anything.
 */

import { ulid } from 'ulid'
import { getQuoxperticusMode, getQuoxperticusOrgId } from './disposableTestInstance.js'
import { scopeForQuoxperticusMode } from './quoxperticusModeScope.js'
import { createTaskEnvelope, TASK_INTENTS } from './envelopes.js'

/**
 * F5: the live org ids, from auth's keyed internal enumeration endpoint
 * (services/auth/routes/internal-orgs.js). Null on any failure: the caller
 * treats an unverifiable list as an invalid binding and refuses.
 */
async function fetchKnownOrgIds() {
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101'
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || ''
  const res = await fetch(`${authUrl}/api/internal/orgs/list`, {
    headers: { ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}) },
    signal: AbortSignal.timeout(5000),
  })
  if (!res || !res.ok) return null
  const body = await res.json()
  return Array.isArray(body?.orgIds) ? body.orgIds : null
}

/** Non-terminal statuses that count as "a patrol already exists". */
const ACTIVE_STATUSES = ['pending', 'decomposing', 'decomposed', 'running']

export const QUOXPERTICUS_USER_ID = 'quoxperticus'

const STANDING_GOAL = [
  'You are QUOXPERTICUS, the resident governed agent on this Quox server.',
  'Patrol the platform as a first-time power user would: exercise surfaces',
  'through your granted tools, run read-only canaries, and compare what you',
  'find against what the product claims. File every defect, gap, or surprise',
  'as an inbox finding (create_inbox_item) with concrete evidence: what you',
  'drove, what you expected, what actually happened. Prefer filing a finding',
  'over acting when uncertain. Never attempt to resolve a HITL approval in a',
  'real context; your approve/deny calls file proposals for a human.',
  '',
  'THIS PATROL IS BOUNDED. Pick a SMALL number of surfaces (roughly two to',
  'four) to examine this run rather than trying to survey everything. When you',
  'have filed your findings for those surfaces, or when you sense you are',
  'nearing your turn budget, STOP: commit a continuity self-delta with the',
  'continuity tool (action commit) as your closing act, recording what you',
  'learned about who you are, the loops you opened or closed, and one message',
  'to your next self, then end your turn cleanly. Do not patrol indefinitely;',
  'a short, complete, witnessed patrol that ends on its own is the goal, and',
  'the next wake will continue where you left off.',
].join(' ')

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts] test seams: { modeFn, orgFn, nowFn }
 * @returns {Promise<{woke: boolean, reason?: string, objective_id?: string, checkpoint_id?: string, mode?: string}>}
 */
export async function wakeQuoxperticus(db, opts = {}) {
  const modeFn = opts.modeFn || getQuoxperticusMode
  const orgFn = opts.orgFn || getQuoxperticusOrgId

  let mode = 'OFF'
  try { mode = await modeFn() } catch { mode = 'OFF' }
  if (mode === 'OFF') {
    return { woke: false, reason: 'mode_off', mode }
  }

  let orgId = null
  try { orgId = await orgFn() } catch { orgId = null }
  if (!orgId) {
    return { woke: false, reason: 'no_org_binding', mode }
  }

  // F5 (first .131 drive): the binding key silently accepted an org SLUG
  // ('default') and the wake then created the patrol in a phantom org with
  // zero members, where every membership-scoped surface fails. Validate the
  // binding against auth's real org list; unknown or unverifiable refuses
  // (fail-safe: a patrol in a phantom org is worse than no patrol).
  const validateFn = opts.orgListFn || fetchKnownOrgIds
  let knownOrgIds = null
  try { knownOrgIds = await validateFn() } catch { knownOrgIds = null }
  if (!Array.isArray(knownOrgIds) || !knownOrgIds.includes(orgId)) {
    return { woke: false, reason: 'invalid_org_binding', mode, org_id: orgId }
  }

  const scope = scopeForQuoxperticusMode(mode)
  if (!Array.isArray(scope) || scope.length === 0) {
    // Defense in depth: a non-OFF mode always maps to a scope; if it ever
    // does not, refuse rather than create a DEC-6-undispatchable objective.
    return { woke: false, reason: 'no_scope_for_mode', mode }
  }

  // One patrol at a time: an existing non-terminal QUOXPERTICUS objective in
  // this org means this wake is a no-op (the supervisor fires on schedule
  // AND on events; overlapping patrols would just contend).
  const active = db.prepare(`
    SELECT id, status FROM objectives
    WHERE org_id = ? AND user_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
    LIMIT 1
  `).get(orgId, QUOXPERTICUS_USER_ID, ...ACTIVE_STATUSES)
  if (active) {
    return { woke: false, reason: 'patrol_already_active', objective_id: active.id, mode }
  }

  const objectiveId = ulid()
  db.prepare(`
    INSERT INTO objectives (
      id, org_id, user_id, title, description, status, execution_mode,
      capability_scope, loop_backend, require_approval_before_start,
      max_tokens, max_tool_calls, max_duration_ms, max_iterations, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 'loop', ?, 'claude', 1, ?, ?, ?, ?, datetime('now'))
  `).run(
    objectiveId,
    orgId,
    QUOXPERTICUS_USER_ID,
    `QUOXPERTICUS patrol (${mode})`,
    STANDING_GOAL,
    JSON.stringify(scope),
    150000,   // max_tokens: a patrol is a bounded sweep, not a marathon
    60,       // max_tool_calls
    1200000,  // max_duration_ms: 20 minutes
    40        // max_iterations
  )

  // Pre-start human gate, same shape the /start route mints. The wake NEVER
  // skips it: on a real instance a human approves each patrol; on a leased
  // disposable sandbox the platform's approval substrate can exercise the
  // resolution end to end (that is the sandbox's whole purpose).
  const checkpointId = ulid()
  db.prepare(`
    INSERT INTO checkpoints (id, objective_id, checkpoint_type, status, title, description, created_at)
    VALUES (?, ?, 'before_start', 'pending', 'QUOXPERTICUS patrol approval', ?, datetime('now'))
  `).run(
    checkpointId,
    objectiveId,
    `Approve to let QUOXPERTICUS run a ${mode} patrol under its ${scope.length}-tool scope. Deny to skip this wake.`
  )

  // AEE-CHECKPOINT-EVIDENCE (quox#480): the wake's pre-start gate is the same
  // human act the /start route mints, and owes the same envelope.
  createTaskEnvelope({
    type: 'event', from: 'service.tasks', to: 'human.user',
    intent: TASK_INTENTS.CHECKPOINT_CREATED,
    payload: {
      checkpoint_id: checkpointId,
      checkpoint_type: 'before_start',
      task_id: null,
      objective_title: `QUOXPERTICUS patrol (${mode})`,
      message: `Approve to let QUOXPERTICUS run a ${mode} patrol under its ${scope.length}-tool scope.`,
      patrol_mode: mode,
    },
    objectiveId,
  })

  return { woke: true, objective_id: objectiveId, checkpoint_id: checkpointId, mode }
}
