// Budget enforcement for objectives — token, tool-call, and time limits
import { getDatabase } from '../db/index.js'
import { ulid } from 'ulid'
import { emitProgress } from './progress.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const QUOXFLOW_URL = process.env.QUOXFLOW_URL || 'http://quoxflow:3200'
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

/**
 * Check if an objective has budget remaining.
 * Returns { ok, warnings[], reason? }
 */
export function checkBudget(objective) {
  const warnings = []

  // Token budget
  if (objective.max_tokens > 0 && objective.tokens_used >= objective.max_tokens) {
    return { ok: false, warnings, reason: 'Token budget exhausted' }
  }
  if (objective.max_tokens > 0) {
    const pct = objective.tokens_used / objective.max_tokens
    if (pct >= 0.8) {
      warnings.push(`Token usage at ${Math.round(pct * 100)}% (${objective.tokens_used}/${objective.max_tokens})`)
    }
  }

  // Tool call budget
  if (objective.max_tool_calls > 0 && objective.tool_calls_used >= objective.max_tool_calls) {
    return { ok: false, warnings, reason: 'Tool call budget exhausted' }
  }
  if (objective.max_tool_calls > 0) {
    const pct = objective.tool_calls_used / objective.max_tool_calls
    if (pct >= 0.8) {
      warnings.push(`Tool calls at ${Math.round(pct * 100)}% (${objective.tool_calls_used}/${objective.max_tool_calls})`)
    }
  }

  // Duration budget
  if (objective.max_duration_ms > 0 && objective.started_at) {
    const elapsed = Date.now() - new Date(objective.started_at).getTime()
    if (elapsed >= objective.max_duration_ms) {
      return { ok: false, warnings, reason: 'Time budget exhausted' }
    }
    const pct = elapsed / objective.max_duration_ms
    if (pct >= 0.8) {
      warnings.push(`Duration at ${Math.round(pct * 100)}%`)
    }
  }

  return { ok: true, warnings }
}

/**
 * Record token/tool usage for an objective after a task completes.
 */
export function recordUsage(objectiveId, { tokens = 0, toolCalls = 0 }) {
  const db = getDatabase()
  db.prepare(`
    UPDATE objectives
    SET tokens_used = tokens_used + ?,
        tool_calls_used = tool_calls_used + ?
    WHERE id = ?
  `).run(tokens, toolCalls, objectiveId)
}

/**
 * Handle budget warnings — emit SSE events and create checkpoints if needed.
 */
export function handleBudgetWarnings(objective, warnings) {
  if (warnings.length === 0) return

  const db = getDatabase()
  for (const warning of warnings) {
    // Log the warning
    db.prepare(`
      INSERT INTO task_logs (id, objective_id, level, event, message, created_at)
      VALUES (?, ?, 'warn', 'budget_warning', ?, datetime('now'))
    `).run(ulid(), objective.id, warning)

    emitProgress(objective.id, {
      type: 'budget_warning',
      message: warning
    })
  }
}

/**
 * Handle budget exhaustion — mark objective as failed, emit event.
 */
export function handleBudgetExhaustion(objective, reason) {
  const db = getDatabase()
  db.prepare(`
    UPDATE objectives
    SET status = 'failed', completed_at = datetime('now'), error_message = ?
    WHERE id = ?
  `).run(`Budget exhausted: ${reason}`, objective.id)

  db.prepare(`
    INSERT INTO task_logs (id, objective_id, level, event, message, created_at)
    VALUES (?, ?, 'error', 'budget_exhausted', ?, datetime('now'))
  `).run(ulid(), objective.id, reason)

  emitProgress(objective.id, {
    type: 'objective_failed',
    reason
  })
}

// ─── USD cost check via QuoxFlow rolling usage (P8.B) ─────────────────────────

/**
 * Async extension of checkBudget that additionally reads rolling USD cost
 * from the QuoxFlow budget engine when objective.budget_id is set.
 *
 * When objective.budget_id is null/undefined, delegates entirely to the
 * synchronous checkBudget() — behaviour is unchanged from existing callers.
 *
 * When budget_id is set:
 *   1. Run the synchronous token/tool/duration checks first (fast, local).
 *   2. Fetch rolling usage from QuoxFlow GET /api/budgets/:id/usage.
 *   3. If objective.max_cost_usd_micro is set, compare rolling cost to cap.
 *
 * @param {object} objective — objective row from DB
 * @param {object} [opts]
 * @param {string} [opts.orgId] — org_id for the usage fetch; falls back to objective.org_id
 * @returns {Promise<{ ok: boolean, warnings: string[], reason?: string }>}
 */
export async function checkBudgetWithCostUsd(objective, opts = {}) {
  // Fast path: no budget_id → delegate to sync check, back-compat
  if (!objective.budget_id) {
    return checkBudget(objective)
  }

  // Run local sync checks first
  const syncResult = checkBudget(objective)
  if (!syncResult.ok) return syncResult

  const warnings = [...syncResult.warnings]

  // Fetch rolling USD cost from QuoxFlow
  const orgId = opts.orgId || objective.org_id || ''
  if (!orgId) {
    // Cannot check without org_id — allow (log only)
    console.warn('[budget] checkBudgetWithCostUsd: no org_id available, skipping USD cost check')
    return { ok: true, warnings }
  }

  let rollingCostUsdMicro = 0
  try {
    const url = `${QUOXFLOW_URL}/api/budgets/${encodeURIComponent(objective.budget_id)}/usage?org_id=${encodeURIComponent(orgId)}`
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-service-key': INTERNAL_SERVICE_KEY },
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const data = await res.json()
      rollingCostUsdMicro = data?.data?.usage?.totalCostUsdMicro ?? 0
    }
  } catch (err) {
    // Non-blocking: if QuoxFlow is unreachable, skip the USD check
    console.warn(`[budget] USD cost fetch from QuoxFlow failed (non-blocking): ${err.message}`)
    return { ok: true, warnings }
  }

  // Check USD cap if objective has one
  if (objective.max_cost_usd_micro > 0) {
    if (rollingCostUsdMicro >= objective.max_cost_usd_micro) {
      return { ok: false, warnings, reason: 'USD cost budget exhausted' }
    }
    const pct = rollingCostUsdMicro / objective.max_cost_usd_micro
    if (pct >= 0.8) {
      warnings.push(`USD cost at ${Math.round(pct * 100)}% ($${(rollingCostUsdMicro / 1e6).toFixed(4)} of $${(objective.max_cost_usd_micro / 1e6).toFixed(4)})`)
    }
  }

  return { ok: true, warnings }
}
