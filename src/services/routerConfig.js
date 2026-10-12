/**
 * Smart Router Configuration
 *
 * Centralized configuration for confidence thresholds, routing modes,
 * and per-intent settings.
 */

/**
 * Router operating modes
 * - standard: Regex patterns only, conservative routing
 * - enhanced: Use LLM classifier for uncertain queries (requires credential)
 * - conservative: Higher thresholds, skip routing when uncertain
 */
export const ROUTER_MODES = {
  STANDARD: 'standard',
  ENHANCED: 'enhanced',
  CONSERVATIVE: 'conservative'
}

/**
 * Risk levels for intents
 * Higher risk = higher confidence threshold required
 */
export const RISK_LEVELS = {
  LOW: 'low',           // Informational queries, greetings
  MEDIUM: 'medium',     // Status checks, listing
  HIGH: 'high',         // Configuration changes
  CRITICAL: 'critical'  // Destructive actions
}

/**
 * Default confidence thresholds by risk level
 */
export const DEFAULT_THRESHOLDS_BY_RISK = {
  [RISK_LEVELS.LOW]: 0.5,
  [RISK_LEVELS.MEDIUM]: 0.65,
  [RISK_LEVELS.HIGH]: 0.8,
  [RISK_LEVELS.CRITICAL]: 0.95
}

/**
 * Default router configuration
 */
export const DEFAULT_ROUTER_CONFIG = {
  // Operating mode
  mode: ROUTER_MODES.STANDARD,

  // Global thresholds
  thresholds: {
    // Minimum confidence to route (default for medium risk)
    confidence: 0.65,

    // Maximum ambiguity allowed (gap between top two intents)
    ambiguity: 0.3,

    // Confidence required for immediate routing (skip ambiguity check)
    highConfidence: 0.9,

    // Below this, don't even try to route
    minimumConfidence: 0.4
  },

  // Per-intent threshold overrides
  intentThresholds: {
    // Low risk - informational
    greeting: 0.5,
    time_query: 0.5,
    help_query: 0.5,
    what_is_quox: 0.5,
    capabilities: 0.5,

    // Medium risk - status/listing
    fleet_status: 0.65,
    list_agents: 0.65,
    list_hosts: 0.65,
    list_assistants: 0.65,
    health_check: 0.65,
    router_stats: 0.65,
    host_details: 0.65,
    agent_info: 0.65,
    memory_search: 0.65,
    preference_get: 0.65,
    preference_list: 0.65,

    // High risk - actions
    install_quoxagent: 0.85
  },

  // Intent risk level mapping
  intentRiskLevels: {
    greeting: RISK_LEVELS.LOW,
    time_query: RISK_LEVELS.LOW,
    help_query: RISK_LEVELS.LOW,
    what_is_quox: RISK_LEVELS.LOW,
    who_are_you: RISK_LEVELS.LOW,
    capabilities: RISK_LEVELS.LOW,

    fleet_status: RISK_LEVELS.MEDIUM,
    list_agents: RISK_LEVELS.MEDIUM,
    list_hosts: RISK_LEVELS.MEDIUM,
    list_assistants: RISK_LEVELS.MEDIUM,
    health_check: RISK_LEVELS.MEDIUM,
    router_stats: RISK_LEVELS.MEDIUM,
    host_details: RISK_LEVELS.MEDIUM,
    agent_info: RISK_LEVELS.MEDIUM,
    memory_search: RISK_LEVELS.MEDIUM,
    preference_get: RISK_LEVELS.MEDIUM,
    preference_list: RISK_LEVELS.MEDIUM,

    install_quoxagent: RISK_LEVELS.HIGH
  },

  // Clarification settings
  clarification: {
    // Enable clarifying questions when ambiguous
    enabled: true,

    // Show clarification when confidence is in this range
    minConfidence: 0.4,
    maxConfidence: 0.7,

    // Maximum number of options to show
    maxOptions: 3
  },

  // LLM classifier settings (for enhanced mode)
  llmClassifier: {
    enabled: false,
    credentialId: null,
    model: 'gpt-5.4-mini',
    confidenceThreshold: 0.7,
    maxLatency: 500,
    cacheResults: true,
    cacheTTL: 3600000 // 1 hour
  },

  // Telemetry settings
  telemetry: {
    trackClassifications: true,
    trackReformulations: true,
    trackEscalations: true,
    trackCosts: true
  },

  // Agent Delegation settings
  // When no pattern matches, try to delegate to a specialized agent
  agentDelegation: {
    // Enable agent delegation feature
    enabled: true,

    // Minimum score to delegate (vs staying with Quox)
    minimumScore: 5,

    // Prefer delegation when pattern confidence is low
    preferDelegationOnLowConfidence: true,

    // Prefix responses with [AGENT_NAME]
    attributeResponses: true,

    // Log delegation decisions to console
    logDelegations: true
  }
}

// Current configuration (can be modified at runtime)
let currentConfig = { ...DEFAULT_ROUTER_CONFIG }

/**
 * Get current router configuration
 * @returns {Object}
 */
export function getRouterConfig() {
  return { ...currentConfig }
}

/**
 * Update router configuration
 * @param {Object} updates - Partial config to merge
 */
export function updateRouterConfig(updates) {
  currentConfig = deepMerge(currentConfig, updates)
  console.log('[RouterConfig] Configuration updated:', Object.keys(updates))
}

/**
 * Reset to default configuration
 */
export function resetRouterConfig() {
  currentConfig = { ...DEFAULT_ROUTER_CONFIG }
  console.log('[RouterConfig] Reset to defaults')
}

/**
 * Get confidence threshold for a specific intent
 * @param {string} intentName
 * @returns {number}
 */
export function getIntentThreshold(intentName) {
  // Check for specific override
  if (currentConfig.intentThresholds[intentName] !== undefined) {
    return currentConfig.intentThresholds[intentName]
  }

  // Check for risk-level based threshold
  const riskLevel = currentConfig.intentRiskLevels[intentName]
  if (riskLevel && DEFAULT_THRESHOLDS_BY_RISK[riskLevel]) {
    return DEFAULT_THRESHOLDS_BY_RISK[riskLevel]
  }

  // Fall back to global threshold
  return currentConfig.thresholds.confidence
}

/**
 * Get risk level for an intent
 * @param {string} intentName
 * @returns {string}
 */
export function getIntentRiskLevel(intentName) {
  return currentConfig.intentRiskLevels[intentName] || RISK_LEVELS.MEDIUM
}

/**
 * Check if clarification should be shown for a result
 * @param {number} confidence
 * @param {number} ambiguity
 * @returns {boolean}
 */
export function shouldShowClarification(confidence, ambiguity) {
  if (!currentConfig.clarification.enabled) return false

  const { minConfidence, maxConfidence } = currentConfig.clarification

  // Confidence in the "uncertain" range
  if (confidence < minConfidence || confidence > maxConfidence) return false

  // Ambiguity check - if ambiguity is high, definitely clarify
  if (ambiguity > currentConfig.thresholds.ambiguity) return true

  return true
}

/**
 * Check if a confidence score should be trusted for routing
 * @param {number} confidence
 * @param {string} intentName
 * @returns {{ trusted: boolean, reason: string }}
 */
export function shouldRouteIntent(confidence, intentName) {
  const threshold = getIntentThreshold(intentName)

  if (confidence >= currentConfig.thresholds.highConfidence) {
    return { trusted: true, reason: 'high-confidence' }
  }

  if (confidence < currentConfig.thresholds.minimumConfidence) {
    return { trusted: false, reason: 'below-minimum' }
  }

  if (confidence >= threshold) {
    return { trusted: true, reason: 'above-threshold' }
  }

  return { trusted: false, reason: 'below-threshold' }
}

/**
 * Forbidden keys that could enable prototype pollution attacks
 */
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype']

/**
 * Check if a key is safe (not a prototype pollution vector)
 * @param {string} key
 * @returns {boolean}
 */
function isSafeKey(key) {
  return !FORBIDDEN_KEYS.includes(key)
}

/**
 * Deep merge utility with prototype pollution protection
 */
function deepMerge(target, source) {
  const result = { ...target }

  for (const key of Object.keys(source)) {
    // Skip dangerous keys to prevent prototype pollution
    if (!isSafeKey(key)) continue

    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key])
    } else {
      result[key] = source[key]
    }
  }

  return result
}

/**
 * Load configuration from localStorage (for persistence)
 */
export function loadPersistedConfig() {
  try {
    const stored = localStorage.getItem('quox-router-config')
    if (stored) {
      const parsed = JSON.parse(stored)
      currentConfig = deepMerge(DEFAULT_ROUTER_CONFIG, parsed)
      console.log('[RouterConfig] Loaded persisted configuration')
    }
  } catch (err) {
    console.warn('[RouterConfig] Failed to load persisted config:', err.message)
  }
}

// Apply any persisted overrides at module init. persistConfig() has always
// SAVED to localStorage, but nothing ever loaded it back — saved router
// settings silently reverted to defaults on every reload.
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  loadPersistedConfig()
}

/**
 * Save current configuration to localStorage + server
 */
export function persistConfig() {
  try {
    localStorage.setItem('quox-router-config', JSON.stringify(currentConfig))
    // Sync to server for cross-device persistence
    import('./userPreferences.js').then(({ syncPreferenceToServer }) => {
      syncPreferenceToServer('routerConfig', currentConfig)
    }).catch(() => { /* fire-and-forget */ })
  } catch (err) {
    console.warn('[RouterConfig] Failed to persist config:', err.message)
  }
}

export default {
  ROUTER_MODES,
  RISK_LEVELS,
  DEFAULT_THRESHOLDS_BY_RISK,
  DEFAULT_ROUTER_CONFIG,
  getRouterConfig,
  updateRouterConfig,
  resetRouterConfig,
  getIntentThreshold,
  getIntentRiskLevel,
  shouldShowClarification,
  shouldRouteIntent,
  loadPersistedConfig,
  persistConfig
}
