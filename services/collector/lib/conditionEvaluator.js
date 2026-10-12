/**
 * GOV-4: Server-side Condition Evaluator
 *
 * Evaluates policy condition trees against a flat context object.
 * CJS version for collector (mirrors src/services/layers/conditionEvaluator.js).
 */

function evaluateCondition(condition, ctx) {
  if (!condition || typeof condition !== 'object') return false

  // Group node
  if (condition.conditions && Array.isArray(condition.conditions)) {
    if (condition.operator === 'AND') {
      return condition.conditions.every(c => evaluateCondition(c, ctx))
    }
    if (condition.operator === 'OR') {
      return condition.conditions.some(c => evaluateCondition(c, ctx))
    }
    return false
  }

  // Leaf node
  const { field, operator, value } = condition
  if (!field || !operator) return false

  const actual = ctx[field]
  if (actual === undefined || actual === null) return false

  switch (operator) {
    case '==': return actual === value
    case '!=': return actual !== value
    case '>': return typeof actual === 'number' && actual > value
    case '<': return typeof actual === 'number' && actual < value
    case '>=': return typeof actual === 'number' && actual >= value
    case '<=': return typeof actual === 'number' && actual <= value
    case 'matches':
      try { return new RegExp(value, 'i').test(String(actual)) } catch { return false }
    case 'contains': return String(actual).includes(String(value))
    case 'in': return Array.isArray(value) && value.includes(actual)
    case 'not_in': return Array.isArray(value) && !value.includes(actual)
    default: return false
  }
}

/**
 * Build a flat context for tool execution policy evaluation.
 *
 * BLAST-RADIUS-P3: when the caller has attached `ctx._reach` (only done
 * lazily, by checkStorePolicies, when some policy actually references
 * `reach.*` — see approvalGate.js's policiesReferenceReach), expose a
 * numeric reach.* surface so a policy condition can gate on blast radius,
 * not just tool name. Three honest shapes:
 *  - ctx._reach absent entirely: no reach.* fields added (byte-identical to
 *    pre-P3 behaviour for every policy that never mentions reach).
 *  - ctx._reach = { available: false }: only reach.available=0 is exposed.
 *    A policy referencing any other reach.* field reads `undefined` from
 *    this context and evaluateCondition returns false for it — the
 *    fail-closed override for that case lives in approvalGate.js, which
 *    checks reach.available before trusting a false evaluation here.
 *  - ctx._reach = { available: true, ...staticReachResult }: the full
 *    numeric surface below, derived from the static reach result's `may`
 *    (never from `sources`, which can go stale relative to `may` on a
 *    partial-failure result).
 */
function buildToolContext(toolName, input, ctx = {}) {
  const base = {
    'tool.name': toolName,
    'tool.action': input?.action || '',
    'agent.id': ctx.agentId || 'quox',
    'input.action': input?.action || '',
    'input.vmid': input?.vmid || '',
    'input.node': input?.node || '',
    'input.command': input?.command || '',
    'input.host': input?.host || '',
    'org.id': ctx.orgId || '',
  }

  // QUOXTRUST T1/D1 unification: additively expose the canonical action's
  // effective fields (recipient/subject/bcc/repo/branch/command/...) under an
  // `action.*` namespace so an org policy can match on the SAME action the
  // human approves and the adapter executes. Before this, only the hardcoded
  // lossy subset above was matchable — the policy-evaluated action was provably
  // poorer than the executed one (an exfil-to-attacker send was structurally
  // invisible to policy). PURELY ADDITIVE: new `action.*` keys only; every key
  // above is untouched so existing policies match identically, and absent a
  // canonical action (ctx._canonicalAction unset) nothing is added at all.
  const ca = ctx._canonicalAction
  if (ca && ca.args && typeof ca.args === 'object') {
    base['action.tool'] = ca.tool || toolName
    if (ca.digest) base['action.digest'] = ca.digest
    for (const [k, v] of Object.entries(ca.args)) {
      if (v === null || v === undefined) continue
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        base['action.' + k] = String(v)
      } else if (Array.isArray(v) && v.every(x => typeof x === 'string' || typeof x === 'number')) {
        // recipients (to/cc/bcc) arrive as arrays — join so a policy can match
        base['action.' + k] = v.join(',')
      }
      // objects / mixed arrays are intentionally NOT flattened here (avoid
      // dumping large/nested values into the matching context); a policy that
      // needs one can gate on action.digest or a targeted projection later.
    }
  }

  if (ctx._reach && typeof ctx._reach === 'object') {
    if (ctx._reach.available === false) {
      base['reach.available'] = 0
    } else {
      const may = ctx._reach.may || {}
      const toolItems = Array.isArray(may.tools) ? may.tools : []
      const credentialItems = Array.isArray(may.credentials) ? may.credentials : []
      const hostItems = Array.isArray(may.hosts) ? may.hosts : []
      const egressItems = Array.isArray(may.egress) ? may.egress : []
      const delegateDirect = (may.delegates && Array.isArray(may.delegates.direct)) ? may.delegates.direct : []
      const unknownItems = Array.isArray(ctx._reach.unknown) ? ctx._reach.unknown : []
      const badgeLevelMatch = (ctx._reach.badge && typeof ctx._reach.badge.level === 'string')
        ? ctx._reach.badge.level.match(/^R(\d)$/)
        : null
      const badgeLevel = badgeLevelMatch ? Number(badgeLevelMatch[1]) : 0

      base['reach.available'] = 1
      base['reach.level'] = badgeLevel
      base['reach.tools'] = toolItems.length
      base['reach.credentials'] = credentialItems.length
      base['reach.hosts'] = hostItems.length
      base['reach.egress'] = egressItems.length
      base['reach.delegates'] = delegateDirect.length
      base['reach.unknown'] = unknownItems.length
      base['reach.intrusive_tools'] = toolItems.filter(
        (t) => t && (t.risk === 'intrusive' || t.risk === 'high')
      ).length
    }
  }

  return base
}

module.exports = { evaluateCondition, buildToolContext }
