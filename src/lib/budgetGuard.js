/**
 * budgetGuard — STUDY-REV-2 P8.B.3
 *
 * Pre-execution budget evaluation helper.
 *
 * Usage (in workflow execute handler):
 *
 *   const guard = await evaluateBudgetForExecution({ authFetch, orgId, workflowId })
 *   if (guard.willHardStop) {
 *     // open HardStopDialog with guard.exceeded, guard.current, guard.projected
 *     return
 *   }
 *   // proceed with executeWorkflow(...)
 *
 * The function fetches org-scope and execution-scope budgets, computes
 * remaining headroom against current usage, and returns whether the next
 * run would hit a hard stop.
 *
 * NOTE: projected values are estimates — we don't know actual token/cost
 * for a run before it starts. We use the budget's configured max as the
 * "projected at worst case" to give a conservative guard.
 */

import { listBudgets, getUsage } from '../services/budgetClient'

/**
 * @typedef {object} BudgetGuardResult
 * @property {boolean}  willHardStop — true if any hard-stop budget would be exceeded
 * @property {string[]} exceeded     — dimension labels that are already at or over cap
 * @property {object}   current      — current usage snapshot (best effort)
 * @property {object}   projected    — projected usage (current + estimated next run)
 */

/**
 * Evaluate whether executing a workflow would trigger a hard stop.
 *
 * @param {object}   opts
 * @param {Function} opts.authFetch   — authenticated fetch
 * @param {string}   [opts.orgId]     — org ID (reads localStorage if omitted)
 * @param {string}   [opts.workflowId] — workflow ID (checks execution-scope budget too)
 * @returns {Promise<BudgetGuardResult>}
 */
export async function evaluateBudgetForExecution({ authFetch, orgId, workflowId } = {}) {
    const result = {
        willHardStop: false,
        exceeded: [],
        current: {},
        projected: {},
    }

    try {
        // Fetch org-scope budget for current period
        const orgBudgets = await listBudgets({ authFetch, orgId, scope: 'org' })
        const now = Date.now()
        const orgBudget = Array.isArray(orgBudgets)
            ? orgBudgets.find(b => {
                const s = new Date(b.period_start || 0).getTime()
                const e = new Date(b.period_end || Infinity).getTime()
                return s <= now && now < e && b.hard_stop !== false
            })
            : null

        if (orgBudget) {
            const usageData = await getUsage({ authFetch, orgId, id: orgBudget.id }).catch(() => null)
            const usage = usageData?.usage || {}
            const tokens = (usage.tokens_in || 0) + (usage.tokens_out || 0)
            const cost = usage.cost_usd_micro || 0

            if (orgBudget.max_tokens && tokens >= orgBudget.max_tokens) {
                result.exceeded.push('tokens')
            }
            if (orgBudget.max_cost_usd_micro && cost >= orgBudget.max_cost_usd_micro) {
                result.exceeded.push('cost')
            }

            result.current = { ...result.current, tokens, cost_usd_micro: cost }
            result.projected = {
                ...result.projected,
                tokens: orgBudget.max_tokens || tokens,
                cost_usd_micro: orgBudget.max_cost_usd_micro || cost,
            }
        }

        // Check execution-scope budget for this workflow
        if (workflowId) {
            const execBudgets = await listBudgets({
                authFetch, orgId, scope: 'execution', scopeId: workflowId,
            }).catch(() => [])

            const execBudget = Array.isArray(execBudgets) ? execBudgets[0] : null
            if (execBudget && execBudget.hard_stop !== false) {
                const usageData = await getUsage({ authFetch, orgId, id: execBudget.id }).catch(() => null)
                const usage = usageData?.usage || {}
                const tokens = (usage.tokens_in || 0) + (usage.tokens_out || 0)
                const cost = usage.cost_usd_micro || 0

                if (execBudget.max_tokens && tokens >= execBudget.max_tokens && !result.exceeded.includes('tokens')) {
                    result.exceeded.push('tokens')
                }
                if (execBudget.max_cost_usd_micro && cost >= execBudget.max_cost_usd_micro && !result.exceeded.includes('cost')) {
                    result.exceeded.push('cost')
                }
            }
        }

        result.willHardStop = result.exceeded.length > 0
    } catch {
        // Network/auth failure — don't block execution, let the server enforce
        result.willHardStop = false
    }

    return result
}
