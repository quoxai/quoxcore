/**
 * Learning Observer (QLOOP-ENGINE P3 step a).
 *
 * Read-only observer of finished runs. For a run that is BOTH successful AND
 * witnessed it derives a learning-candidate signal and hands it to `emit`.
 * It authors, crystallises and writes NOTHING: the only side effect it can
 * have is whatever the injected `emit` sink does. Deny-by-default: flag off,
 * failed, cancelled, or unwitnessed runs yield null.
 *
 * NOT wired into any execution path yet (see docs/QLOOP_P3_LEARNING_OBSERVER.md).
 */
import { createHash } from 'node:crypto'

const SUCCESS = new Set(['completed', 'success', 'succeeded'])

function toolName(t) {
  if (typeof t === 'string') return t
  return t && (t.name || t.tool || t.tool_name) || null
}

function toolSequence(run) {
  const raw = Array.isArray(run.tool_sequence) ? run.tool_sequence
    : Array.isArray(run.tools) ? run.tools
    : Array.isArray(run.tool_calls) ? run.tool_calls
    : []
  return raw.map(toolName).filter(Boolean)
}

function witnessRef(run) {
  return run.witnessed_ref || run.witness_ref || run.evidence_ref || run.ward_ref || null
}

/** Stable fingerprint of goal + ordered tool-name sequence. */
export function fingerprintShape(goal, tools) {
  const g = String(goal || '').trim().toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha256').update(JSON.stringify([g, tools])).digest('hex').slice(0, 16)
}

export function observeCompletedRun(run, { flagOn, emit } = {}) {
  const on = flagOn === undefined ? process.env.LEARNING_OBSERVER === '1' : flagOn === true
  if (!on || !run || typeof run !== 'object') return null
  if (!SUCCESS.has(String(run.status || '').toLowerCase())) return null
  const ref = witnessRef(run)
  if (!ref) return null

  const seq = toolSequence(run)
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
  const candidate = {
    run_id: run.id ?? run.run_id ?? null,
    org_id: run.org_id ?? null,
    kind: run.kind === 'loop' ? 'loop' : 'objective',
    shape: fingerprintShape(run.goal || run.title, seq),
    tools: [...new Set(seq)],
    cost: {
      tokens: num(run.tokens_used),
      tool_calls: num(run.tool_calls_used) ?? (seq.length || null),
    },
    outcome: String(run.status).toLowerCase(),
    witnessed_ref: ref,
    ts: new Date().toISOString(),
  }
  const sink = typeof emit === 'function' ? emit : (c) => c
  sink(candidate)
  return candidate
}
