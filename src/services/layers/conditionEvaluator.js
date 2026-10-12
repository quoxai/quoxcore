/**
 * GOV-2: Condition Evaluator
 *
 * Evaluates policy condition trees against a flat request context.
 * Used by policyGate.js to match fetched policies against incoming requests.
 *
 * Supports:
 * - Group nodes: AND, OR (with nesting)
 * - Leaf operators: ==, !=, >, <, >=, <=, matches, contains, in, not_in
 */

/**
 * Evaluate a condition node (group or leaf) against a flat context object.
 * @param {Object} condition - Condition node (group with operator+conditions, or leaf with field+operator+value)
 * @param {Object} ctx - Flat context object (e.g. { 'query.text': '...', 'agent.id': 'sentinel' })
 * @returns {boolean}
 */
export function evaluateCondition(condition, ctx) {
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

  // Missing field — only == null / != null could match, but we treat missing as "no match"
  if (actual === undefined || actual === null) {
    return false
  }

  switch (operator) {
    case '==':
      return actual === value
    case '!=':
      return actual !== value
    case '>':
      return typeof actual === 'number' && actual > value
    case '<':
      return typeof actual === 'number' && actual < value
    case '>=':
      return typeof actual === 'number' && actual >= value
    case '<=':
      return typeof actual === 'number' && actual <= value
    case 'matches':
      try {
        return new RegExp(value, 'i').test(String(actual))
      } catch {
        return false
      }
    case 'contains':
      return String(actual).includes(String(value))
    case 'in':
      return Array.isArray(value) && value.includes(actual)
    case 'not_in':
      return Array.isArray(value) && !value.includes(actual)
    default:
      return false
  }
}

/**
 * Build a flat request context from query + context object.
 * This is the bridge between ChatTab's (query, {agent, corr}) call signature
 * and the policy condition evaluator's flat key-value context.
 *
 * @param {string} query - The user's query text
 * @param {Object} context - { agent, corr, rateContext, ... }
 * @returns {Object} Flat context for evaluateCondition
 */
// GOV-6: Lightweight PII detection for frontend context enrichment
const PII_PATTERNS = {
  ssn: /\b\d{3}-\d{2}-\d{4}\b/,
  email: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}\b/,
  phone: /(?:\(\d{3}\)\s?|\b\d{3}[-.])\d{3}[-.]?\d{4}\b/,
  credit_card: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/,
  ip_address: /\b(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/,
  api_key: /\b(?:sk-[a-zA-Z0-9_-]{20,}|sk-ant-[a-zA-Z0-9_-]{10,}|Bearer\s+[a-zA-Z0-9_-]{20,})\b/,
}

function detectPIIQuick(text) {
  if (!text) return { hasPII: false, types: [] }
  const types = []
  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    if (pattern.test(text)) types.push(type)
  }
  return { hasPII: types.length > 0, types }
}

export function buildRequestContext(query, context = {}) {
  // GOV-6: Detect PII in query for compliance policies
  const pii = detectPIIQuick(query)

  const ctx = {
    'query.text': query || '',
    'agent.id': context.agent || 'quox',
    'correlation.id': context.corr || '',
    'data.hasPII': pii.hasPII,
    'data.piiTypes': pii.types,
  }

  // Rate context (injected by rate limiter)
  if (context.rateContext) {
    if (context.rateContext.queries_per_minute !== undefined) {
      ctx['rate.queries_per_minute'] = context.rateContext.queries_per_minute
    }
    if (context.rateContext.queries_per_hour !== undefined) {
      ctx['rate.queries_per_hour'] = context.rateContext.queries_per_hour
    }
  }

  // Action type (if provided)
  if (context.actionType) {
    ctx['action.type'] = context.actionType
  }

  return ctx
}
