/**
 * Learning Pass (QLOOP-ENGINE P3 step b, the dark trigger).
 *
 * Reads recent completed + witnessed runs from the EXISTING records (the
 * objectives table + their tasks, no new store), derives learning candidates
 * with the SAME mapping the live hooks use (buildLearningRun -> observer),
 * detects recurring shapes, and submits DRAFT skill proposals through the
 * existing chokepoint. Read-only except for the human-review drafts it queues;
 * nothing is promoted, ever.
 *
 * Gating:
 *   - Invoked explicitly (a human running the command) IS the authorization:
 *     the pass runs its sub-stages with flagOn:true. The proposer can still only
 *     queue human-review drafts, so a manual run can never auto-approve a skill.
 *   - A SCHEDULED invocation must be gated on LEARNING_PASS_SCHEDULE (default
 *     off); passScheduleOn() is for the scheduler to check before calling.
 *   - dryRun:true detects but submits NOTHING (preview the drafts first).
 *
 * Not wired to a CLI/route/scheduler yet: the surface is the next thin step.
 */
import { buildLearningRun, emitLearningCandidate } from './learningSink.js'
import { observeCompletedRun } from './learningObserver.js'
import { detectSkillDrafts } from './learningDetector.js'
import { proposeDrafts } from './learningProposer.js'

const DEFAULT_LIMIT = 500

export function passScheduleOn(env = process.env) {
  return env.LEARNING_PASS_SCHEDULE === '1'
}

/** completed + witnessed runs only (mirrors the observer's own gate). */
function selectRuns(db, { orgId, sinceTs, limit }) {
  const where = ["status = 'completed'", 'volt_bundle_id IS NOT NULL']
  const params = []
  if (orgId) { where.push('org_id = ?'); params.push(orgId) }
  if (sinceTs) { where.push('completed_at >= ?'); params.push(sinceTs) }
  const sql = `SELECT * FROM objectives WHERE ${where.join(' AND ')} ORDER BY completed_at DESC LIMIT ?`
  params.push(Number(limit) || DEFAULT_LIMIT)
  return db.prepare(sql).all(...params)
}

/**
 * @param {object} db  tasks DB handle (better-sqlite3)
 * @param {object} [opts]
 * @param {string|null} [opts.orgId]  scope to one org (recommended; null = all)
 * @param {string|null} [opts.sinceTs]  only runs completed at/after this ts
 * @param {number} [opts.limit=500]
 * @param {number} [opts.threshold]  passed to the detector
 * @param {boolean} [opts.dryRun=false]  detect only, submit nothing
 * @param {Function} [opts.submitFn]  injected chokepoint submit (tests/real)
 * @param {Set|Array} [opts.knownShapes]  shapes already covered, skipped
 * @param {Set|Array} [opts.alreadyProposed]  shapes already proposed, skipped
 * @returns {Promise<object>} summary
 */
export async function runLearningPass(db, {
  orgId = null, sinceTs = null, limit = DEFAULT_LIMIT, threshold,
  dryRun = false, submitFn, knownShapes, alreadyProposed,
} = {}) {
  const summary = { scanned: 0, candidates: 0, patterns: 0, dryRun: !!dryRun, submitted: 0, proposed: [], skipped: [], would_propose: [] }
  if (!db) return summary

  const rows = selectRuns(db, { orgId, sinceTs, limit })
  summary.scanned = rows.length

  const candidates = []
  for (const o of rows) {
    const tasks = db.prepare('SELECT * FROM tasks WHERE objective_id = ?').all(o.id)
    const kind = o.execution_mode === 'loop' ? 'loop' : 'objective'
    const run = buildLearningRun({ kind, objective: o, tasks, status: o.status, witnessedRef: o.volt_bundle_id })
    const c = observeCompletedRun(run, { flagOn: true, emit: emitLearningCandidate })
    if (c) candidates.push(c)
  }
  summary.candidates = candidates.length

  const drafts = detectSkillDrafts(candidates, { flagOn: true, threshold, knownShapes })
  summary.patterns = drafts.length

  if (dryRun) {
    summary.would_propose = drafts.map((d) => ({ shape: d.shape, org_id: d.org_id, kind: d.kind, occurrences: d.occurrences }))
    return summary
  }

  const prop = await proposeDrafts(drafts, { flagOn: true, submitFn, alreadyProposed, orgId })
  summary.submitted = prop.submitted
  summary.proposed = prop.proposed
  summary.skipped = prop.skipped
  return summary
}
