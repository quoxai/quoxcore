/**
 * Decision Evidence Plugin Service
 *
 * License checking, configuration access, and feature gating for the
 * Decision Evidence enterprise plugin.
 *
 * Pattern based on aoclPluginService.js.
 */

import { useState, useEffect } from 'react'
import { getLicenseStatus, getPlugin, isPluginEnabled } from './pluginClient'
import { getPluginManifest, getPluginLimits } from '../config/plugins'
import { getPluginConfig } from './pluginConfigStorage'
import { getOverrides } from './entityRegistry'

const PLUGIN_ID = 'decision-evidence'

// Cache for plugin status (TTL: 60 seconds)
let statusCache = {
  status: null,
  timestamp: 0
}
const CACHE_TTL = 60000

/**
 * Clear the status cache (call after license changes)
 */
export function clearDecisionEvidenceCache() {
  statusCache = { status: null, timestamp: 0 }
}

/**
 * Check if cache is valid
 */
function isCacheValid() {
  return Date.now() - statusCache.timestamp < CACHE_TTL
}

/**
 * Get Decision Evidence plugin license status
 * @returns {Promise<{licensed: boolean, enabled: boolean, tier: string}>}
 */
export async function getDecisionEvidenceStatus() {
  if (isCacheValid() && statusCache.status) {
    return statusCache.status
  }

  try {
    const [license, plugin] = await Promise.all([
      getLicenseStatus(),
      getPlugin(PLUGIN_ID)
    ])

    const result = {
      licensed: plugin?.licensed ?? false,
      enabled: plugin?.enabled ?? false,
      tier: license?.tiers?.includes('tier_c') ? 'enterprise' : 'free',
      expires: license?.expires_at,
      daysRemaining: license?.days_remaining
    }

    statusCache.status = result
    statusCache.timestamp = Date.now()
    return result
  } catch (err) {
    console.error('[DecisionEvidence] Failed to get status:', err)
    return { licensed: false, enabled: false, tier: 'free' }
  }
}

/**
 * Check if Decision Evidence plugin is fully enabled (licensed + enabled)
 * @returns {Promise<boolean>}
 */
export async function isDecisionEvidenceEnabled() {
  const status = await getDecisionEvidenceStatus()
  return status.licensed && status.enabled
}

/**
 * Get the configured evidence level for the current org
 * @returns {string} 'none' | 'minimal' | 'standard' | 'full'
 */
export function getEvidenceLevel() {
  try {
    const config = getPluginConfig(PLUGIN_ID)
    return config.evidenceLevel || 'standard'
  } catch {
    return 'none'
  }
}

/**
 * Check if evidence is enforced for all agents
 * @returns {boolean}
 */
export function isEnforcedForAllAgents() {
  try {
    const config = getPluginConfig(PLUGIN_ID)
    return config.enforceForAllAgents ?? true
  } catch {
    return false
  }
}

/**
 * Check if auto VOLT recording is enabled
 * @returns {boolean}
 */
export function isAutoVoltRecordEnabled() {
  try {
    const config = getPluginConfig(PLUGIN_ID)
    return config.autoVoltRecord ?? true
  } catch {
    return false
  }
}

/**
 * Get the per-agent evidence level override, if set.
 * Falls back to the org-level plugin config.
 * @param {string} agentId - Agent identifier
 * @returns {string|null} Evidence level or null if no override
 */
export function getAgentEvidenceLevel(agentId) {
  if (!agentId) return null
  try {
    const overrides = getOverrides(agentId)
    return overrides?.decisionEvidenceLevel || null
  } catch {
    return null
  }
}

/**
 * Get the effective evidence level for a chat request.
 * Checks per-agent override first, then org-level config.
 * Returns 'none' if plugin is not enabled.
 * @param {string} [agentId] - Optional agent ID for per-agent override
 * @returns {Promise<string>}
 */
export async function getEffectiveEvidenceLevel(agentId) {
  const enabled = await isDecisionEvidenceEnabled()
  if (!enabled) return 'none'

  // Check per-agent override first
  if (agentId) {
    const agentLevel = getAgentEvidenceLevel(agentId)
    if (agentLevel) return agentLevel
  }

  // Check if enforced for all agents
  if (!isEnforcedForAllAgents() && !agentId) return 'none'

  return getEvidenceLevel()
}

/**
 * Get limits for the current license tier
 * @returns {Promise<object>}
 */
export async function getDecisionEvidenceLimits() {
  const status = await getDecisionEvidenceStatus()
  return getPluginLimits(PLUGIN_ID, status.tier)
}

/**
 * Check if a specific feature is enabled
 * @param {string} featureId - Feature identifier
 * @returns {Promise<boolean>}
 */
export async function isFeatureEnabled(featureId) {
  const enabled = await isDecisionEvidenceEnabled()
  if (!enabled) return false

  const featureMap = {
    'evidence-capture': true,
    'evidence-timeline': true,
    'evidence-search': true,
    'evidence-export': true,
    'token-analytics': true
  }
  return featureMap[featureId] ?? false
}

/**
 * React hook for Decision Evidence plugin status
 * @returns {{licensed: boolean, enabled: boolean, tier: string, loading: boolean}}
 */
export function useDecisionEvidenceStatus() {
  const [status, setStatus] = useState({ licensed: false, enabled: false, tier: 'free', loading: true })

  useEffect(() => {
    getDecisionEvidenceStatus().then(result => {
      setStatus({ ...result, loading: false })
    }).catch(() => {
      setStatus({ licensed: false, enabled: false, tier: 'free', loading: false })
    })
  }, [])

  return status
}

/**
 * React hook for effective evidence level
 * @returns {{level: string, loading: boolean}}
 */
export function useEvidenceLevel() {
  const [state, setState] = useState({ level: 'none', loading: true })

  useEffect(() => {
    getEffectiveEvidenceLevel().then(level => {
      setState({ level, loading: false })
    }).catch(() => {
      setState({ level: 'none', loading: false })
    })
  }, [])

  return state
}

export default {
  getDecisionEvidenceStatus,
  isDecisionEvidenceEnabled,
  getEvidenceLevel,
  getAgentEvidenceLevel,
  isEnforcedForAllAgents,
  isAutoVoltRecordEnabled,
  getEffectiveEvidenceLevel,
  getDecisionEvidenceLimits,
  isFeatureEnabled,
  clearDecisionEvidenceCache,
  useDecisionEvidenceStatus,
  useEvidenceLevel
}
