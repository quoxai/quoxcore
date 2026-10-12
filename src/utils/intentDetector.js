/**
 * Intent Detector
 * Distinguishes between informational queries and action requests
 * to reduce false positives in safety guardrails
 */

// Informational query patterns - questions asking for information
const INFORMATIONAL_PATTERNS = [
  // Direct questions
  /^(what|how|why|when|where|which|who|can|does|is|are|will|would|could|should)\b/i,
  // Explain/describe requests
  /\b(explain|describe|tell me|show me|list|display|view|see|look at)\b.*\??\s*$/i,
  // Documentation/help requests
  /\b(help|docs?|documentation|manual|guide|tutorial|example)\b/i,
  // Comparison/analysis
  /\b(difference|compare|versus|vs\.?|between)\b/i,
  // Status inquiries (without action verbs)
  /\b(status|state|health|info|information|details?|stats?|statistics?)\b.*\??\s*$/i
]

// Question word patterns that indicate informational intent
const QUESTION_INDICATORS = [
  /\?$/,                          // Ends with question mark
  /^(what|how|why|when|where|which|who)\s/i,
  /\b(mean|means|meaning)\b/i,    // Asking about meaning
  /\bwhat\s+(is|are|does|do)\b/i,
  /\bhow\s+(do|does|can|to)\b/i
]

// Action patterns - commands requesting execution
const ACTION_PATTERNS = [
  // Imperative verbs at start
  /^(run|execute|start|stop|restart|reboot|shutdown|kill|delete|remove|destroy|create|deploy|install|uninstall|update|upgrade|patch|migrate|backup|restore)\b/i,
  // Action requests
  /\b(please|can you|could you|would you)\s+(run|execute|start|stop|restart|delete|remove|create|deploy|install)\b/i,
  // Direct commands
  /^(sudo|ssh|curl|wget|apt|yum|dnf|docker|kubectl|systemctl|qm|pct|pvesh)\s/i,
  // Explicit action indicators
  /\b(do it|go ahead|proceed|confirm|yes,?\s*(do|run|execute))\b/i
]

// Read-only operation patterns - safe even on multiple hosts
const READ_ONLY_PATTERNS = [
  /\b(status|health|check|info|list|show|display|view|get|fetch|read|query|search|find|ls|cat|head|tail|grep|df|du|free|top|ps|uptime|hostname|whoami|id|pwd|echo|ping|dig|nslookup|traceroute)\b/i,
  /\b(describe|explain|monitor|watch|observe|inspect)\b/i
]

// Destructive operation patterns - always require caution
const DESTRUCTIVE_PATTERNS = [
  /\b(delete|destroy|remove|drop|truncate|purge|wipe|erase|format|rm\s+-rf?|kill\s+-9)\b/i,
  /\b(shutdown|poweroff|halt|reboot)\b/i
]

// Modification patterns - require confirmation but not as severe
const MODIFICATION_PATTERNS = [
  /\b(create|add|insert|write|modify|change|edit|update|patch|upgrade|install|deploy|configure|set|enable|disable)\b/i,
  /\b(start|stop|restart|reload|refresh)\b/i
]

/**
 * Detect the intent of a query
 * @param {string} query - User's input
 * @returns {object} Intent analysis
 */
export function detectIntent(query) {
  if (!query || typeof query !== 'string') {
    return { type: 'unknown', confidence: 0 }
  }

  const q = query.trim()

  // Score each intent type
  let informationalScore = 0
  let actionScore = 0
  let readOnlyScore = 0
  let destructiveScore = 0
  let modificationScore = 0

  // Check informational patterns
  for (const pattern of INFORMATIONAL_PATTERNS) {
    if (pattern.test(q)) informationalScore += 2
  }
  for (const pattern of QUESTION_INDICATORS) {
    if (pattern.test(q)) informationalScore += 1
  }

  // Check action patterns
  for (const pattern of ACTION_PATTERNS) {
    if (pattern.test(q)) actionScore += 2
  }

  // Check read-only patterns
  for (const pattern of READ_ONLY_PATTERNS) {
    if (pattern.test(q)) readOnlyScore += 1
  }

  // Check destructive patterns
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(q)) destructiveScore += 3
  }

  // Check modification patterns
  for (const pattern of MODIFICATION_PATTERNS) {
    if (pattern.test(q)) modificationScore += 1
  }

  // Determine primary intent
  const scores = {
    informational: informationalScore,
    action: actionScore,
    readOnly: readOnlyScore,
    destructive: destructiveScore,
    modification: modificationScore
  }

  const maxScore = Math.max(...Object.values(scores))
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0) || 1

  // Determine type and confidence
  let type = 'unknown'
  let confidence = 0

  if (destructiveScore >= 3) {
    type = 'destructive'
    confidence = Math.min(1, destructiveScore / 6)
  } else if (informationalScore > actionScore && informationalScore > modificationScore) {
    type = 'informational'
    confidence = Math.min(1, informationalScore / totalScore)
  } else if (actionScore > informationalScore) {
    type = 'action'
    confidence = Math.min(1, actionScore / totalScore)
  } else if (readOnlyScore > modificationScore) {
    type = 'readOnly'
    confidence = Math.min(1, readOnlyScore / totalScore)
  } else if (modificationScore > 0) {
    type = 'modification'
    confidence = Math.min(1, modificationScore / totalScore)
  }

  return {
    type,
    confidence,
    scores,
    isInformational: type === 'informational' || (informationalScore > 0 && actionScore === 0),
    isReadOnly: readOnlyScore > 0 && destructiveScore === 0 && modificationScore === 0,
    isDestructive: destructiveScore > 0,
    requiresConfirmation: destructiveScore > 0 || (modificationScore > 0 && informationalScore === 0)
  }
}

/**
 * Check if a query is asking for information (not requesting action)
 * @param {string} query - User's input
 * @returns {boolean}
 */
export function isInformationalQuery(query) {
  const intent = detectIntent(query)
  return intent.isInformational && !intent.isDestructive
}

/**
 * Check if a query is a read-only operation
 * @param {string} query - User's input
 * @returns {boolean}
 */
export function isReadOnlyOperation(query) {
  const intent = detectIntent(query)
  return intent.isReadOnly
}

/**
 * Check if a query contains destructive operations
 * @param {string} query - User's input
 * @returns {boolean}
 */
export function isDestructiveOperation(query) {
  const intent = detectIntent(query)
  return intent.isDestructive
}

/**
 * Get safety recommendation based on intent
 * @param {string} query - User's input
 * @returns {object} Safety recommendation
 */
export function getSafetyRecommendation(query) {
  const intent = detectIntent(query)

  if (intent.isInformational) {
    return {
      level: 'GREEN',
      bypass: true,
      reason: 'Informational query - no action required'
    }
  }

  if (intent.isReadOnly) {
    return {
      level: 'BLUE',
      bypass: true,
      reason: 'Read-only operation - safe to execute'
    }
  }

  if (intent.isDestructive) {
    return {
      level: 'RED',
      bypass: false,
      reason: 'Destructive operation - requires confirmation'
    }
  }

  if (intent.requiresConfirmation) {
    return {
      level: 'AMBER',
      bypass: false,
      reason: 'Modification operation - may require confirmation'
    }
  }

  return {
    level: 'GREEN',
    bypass: true,
    reason: 'No dangerous patterns detected'
  }
}

export default {
  detectIntent,
  isInformationalQuery,
  isReadOnlyOperation,
  isDestructiveOperation,
  getSafetyRecommendation
}
