/**
 * AOCL Plugin Service
 *
 * License checking and feature gating for AOCL plugins:
 * - AOCL Compliance Suite (Enterprise)
 * - AOCL Developer Kit (Free, promote-core — LICENSE-LAUNCH #3081)
 */

import { getLicenseStatus, getPlugin, isPluginEnabled, isPluginLicensedSync } from './pluginClient'
import { getPluginManifest, getPluginLimits } from '../config/plugins'

// Plugin names
const COMPLIANCE_SUITE = 'aocl-compliance-suite'
const DEVELOPER_KIT = 'aocl-developer-kit'

// Cache for plugin status (TTL: 60 seconds)
let statusCache = {
  compliance: null,
  developer: null,
  timestamp: 0
}
const CACHE_TTL = 60000

/**
 * Clear the status cache (call after license changes)
 */
export function clearAOCLCache() {
  statusCache = { compliance: null, developer: null, timestamp: 0 }
}

/**
 * Check if cache is valid
 */
function isCacheValid() {
  return Date.now() - statusCache.timestamp < CACHE_TTL
}

/**
 * Get AOCL Compliance Suite license status
 * @returns {Promise<{licensed: boolean, tier: string, expires?: string}>}
 */
export async function getComplianceSuiteStatus() {
  if (isCacheValid() && statusCache.compliance) {
    return statusCache.compliance
  }

  try {
    const [license, plugin] = await Promise.all([
      getLicenseStatus(),
      getPlugin(COMPLIANCE_SUITE)
    ])

    // CRP-AU: Use local license validator as primary source (reads from auth DB).
    // QuoxAgent plugin API is a secondary signal (often unavailable/unauthorized).
    const localLicensed = isPluginLicensedSync(COMPLIANCE_SUITE)
    const result = {
      licensed: localLicensed || (plugin?.licensed ?? false),
      enabled: localLicensed || (plugin?.enabled ?? false),
      tier: license?.tiers?.includes('tier_c') ? 'enterprise' : 'free',
      expires: license?.expires_at,
      daysRemaining: license?.days_remaining
    }

    statusCache.compliance = result
    statusCache.timestamp = Date.now()
    return result
  } catch (err) {
    // Dev fallback: if license API is unreachable, assume enterprise
    // In production, the license validator and agent API are always available
    console.warn('[AOCL] License check failed — defaulting to enterprise (dev):', err.message)
    return { licensed: true, enabled: true, tier: 'enterprise' }
  }
}

/**
 * Get AOCL Developer Kit license status
 *
 * LICENSE-LAUNCH #3081: promote-core free (LL-5 Group C). The manifest tier
 * is the source of truth (`aocl-developer-kit.json` ships `tier: "free"`),
 * so this always resolves licensed/enabled — no paid gate left to check.
 * @returns {Promise<{licensed: boolean, tier: string}>}
 */
export async function getDeveloperKitStatus() {
  if (isCacheValid() && statusCache.developer) {
    return statusCache.developer
  }

  const manifest = getPluginManifest(DEVELOPER_KIT)
  const result = {
    licensed: true,
    enabled: true,
    tier: manifest?.tier || 'free'
  }

  statusCache.developer = result
  statusCache.timestamp = Date.now()
  return result
}

/**
 * Check if AOCL Compliance Suite is enabled
 * @returns {Promise<boolean>}
 */
export async function isComplianceSuiteEnabled() {
  const status = await getComplianceSuiteStatus()
  return status.licensed && status.enabled
}

/**
 * Check if AOCL Developer Kit is enabled
 * @returns {Promise<boolean>}
 */
export async function isDeveloperKitEnabled() {
  const status = await getDeveloperKitStatus()
  return status.licensed && status.enabled
}

/**
 * Get available export formats based on license
 * @returns {Promise<string[]>}
 */
export async function getAvailableExportFormats() {
  const enabled = await isComplianceSuiteEnabled()
  if (enabled) {
    return ['json', 'soc2', 'hipaa', 'gdpr', 'iso27001', 'euAiAct', 'iso42001', 'nistAiRmf', 'custom']
  }
  return ['json']
}

/**
 * Check if a specific feature is enabled
 * @param {string} pluginId - 'aocl-compliance-suite' or 'aocl-developer-kit'
 * @param {string} featureId - Feature identifier
 * @returns {Promise<boolean>}
 */
export async function isFeatureEnabled(pluginId, featureId) {
  if (pluginId === COMPLIANCE_SUITE) {
    const enabled = await isComplianceSuiteEnabled()
    if (!enabled) return false

    // Check feature availability
    const featureMap = {
      'compliance-export': true,
      'trace-replay': true,
      'trace-comparison': true,
      'multi-agent-correlation': true,
      'scheduled-reports': true,
      'evidence-bundles': true
    }
    return featureMap[featureId] ?? false
  }

  if (pluginId === DEVELOPER_KIT) {
    const enabled = await isDeveloperKitEnabled()
    if (!enabled) return false

    const featureMap = {
      'layer-playground': true,
      'custom-plugins': true,
      'plugin-marketplace': true,
      'layer-sdk': true
    }
    return featureMap[featureId] ?? false
  }

  return false
}

/**
 * Get limits for a plugin based on current license
 * @param {string} pluginId - Plugin identifier
 * @returns {Promise<object>}
 */
export async function getPluginLimitsForLicense(pluginId) {
  if (pluginId === COMPLIANCE_SUITE) {
    const status = await getComplianceSuiteStatus()
    return getPluginLimits(COMPLIANCE_SUITE, status.tier)
  }

  if (pluginId === DEVELOPER_KIT) {
    const status = await getDeveloperKitStatus()
    return getPluginLimits(DEVELOPER_KIT, status.tier)
  }

  return {}
}

/**
 * Check if trace replay is available
 * @returns {Promise<boolean>}
 */
export async function isReplayEnabled() {
  return isFeatureEnabled(COMPLIANCE_SUITE, 'trace-replay')
}

/**
 * Check if trace comparison is available
 * @returns {Promise<boolean>}
 */
export async function isComparisonEnabled() {
  return isFeatureEnabled(COMPLIANCE_SUITE, 'trace-comparison')
}

/**
 * Check if multi-agent correlation is available
 * @returns {Promise<boolean>}
 */
export async function isCorrelationEnabled() {
  return isFeatureEnabled(COMPLIANCE_SUITE, 'multi-agent-correlation')
}

/**
 * Check if Layer Playground is available
 * @returns {Promise<boolean>}
 */
export async function isPlaygroundEnabled() {
  return isFeatureEnabled(DEVELOPER_KIT, 'layer-playground')
}

/**
 * Check if custom layer plugins are available
 * @returns {Promise<boolean>}
 */
export async function isCustomPluginsEnabled() {
  return isFeatureEnabled(DEVELOPER_KIT, 'custom-plugins')
}

/**
 * Get both plugin statuses at once
 * @returns {Promise<{compliance: object, developer: object}>}
 */
export async function getAOCLPluginStatuses() {
  const [compliance, developer] = await Promise.all([
    getComplianceSuiteStatus(),
    getDeveloperKitStatus()
  ])
  return { compliance, developer }
}

// React hook for AOCL plugin status
import { useState, useEffect } from 'react'

/**
 * React hook for AOCL Compliance Suite status
 * @returns {{licensed: boolean, enabled: boolean, tier: string, loading: boolean}}
 */
export function useComplianceSuiteStatus() {
  const [status, setStatus] = useState({ licensed: false, enabled: false, tier: 'free', loading: true })

  useEffect(() => {
    getComplianceSuiteStatus().then(result => {
      setStatus({ ...result, loading: false })
    }).catch(() => {
      setStatus({ licensed: false, enabled: false, tier: 'free', loading: false })
    })
  }, [])

  return status
}

/**
 * React hook for AOCL Developer Kit status
 * @returns {{licensed: boolean, enabled: boolean, tier: string, loading: boolean}}
 */
export function useDeveloperKitStatus() {
  const [status, setStatus] = useState({ licensed: false, enabled: false, tier: 'free', loading: true })

  useEffect(() => {
    getDeveloperKitStatus().then(result => {
      setStatus({ ...result, loading: false })
    }).catch(() => {
      setStatus({ licensed: false, enabled: false, tier: 'free', loading: false })
    })
  }, [])

  return status
}

/**
 * React hook for any AOCL feature
 * @param {string} pluginId - Plugin identifier
 * @param {string} featureId - Feature identifier
 * @returns {{enabled: boolean, loading: boolean}}
 */
export function useAOCLFeature(pluginId, featureId) {
  const [state, setState] = useState({ enabled: false, loading: true })

  useEffect(() => {
    isFeatureEnabled(pluginId, featureId).then(enabled => {
      setState({ enabled, loading: false })
    }).catch(() => {
      setState({ enabled: false, loading: false })
    })
  }, [pluginId, featureId])

  return state
}

export default {
  // Status functions
  getComplianceSuiteStatus,
  getDeveloperKitStatus,
  getAOCLPluginStatuses,

  // Enable checks
  isComplianceSuiteEnabled,
  isDeveloperKitEnabled,
  isFeatureEnabled,

  // Specific feature checks
  getAvailableExportFormats,
  isReplayEnabled,
  isComparisonEnabled,
  isCorrelationEnabled,
  isPlaygroundEnabled,
  isCustomPluginsEnabled,

  // Limits
  getPluginLimitsForLicense,

  // Cache management
  clearAOCLCache,

  // React hooks
  useComplianceSuiteStatus,
  useDeveloperKitStatus,
  useAOCLFeature
}
