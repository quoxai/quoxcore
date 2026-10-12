/**
 * Quox Memory Tier Service
 *
 * Implements feature gating for the memory system:
 * - Free: Basic memory functionality (default)
 * - Premium: Advanced Memory Plugin ($99 one-time purchase)
 *
 * This is NOT a subscription model. Each plugin is a one-time purchase
 * that unlocks features permanently for that license.
 *
 * This service determines what memory features are available
 * based on the user's license status (validated locally).
 */

import { isPluginLicensed, hasTier, getLicenseStatus as getLocalLicenseStatus } from './licenseValidator'
import { getLicenseStatus as getApiLicenseStatus } from './pluginClient'

// Plugin name for advanced memory
const PREMIUM_PLUGIN_NAME = 'advanced-memory'

// Required tier for advanced memory
const PREMIUM_TIER = 'tier_b'

// Cache for tier status
let tierCache = null
let tierCacheTime = 0
const CACHE_TTL = 60000 // 1 minute cache

// ============================================================================
// TIER LIMITS CONFIGURATION
// ============================================================================

export const TIER_LIMITS = {
  free: {
    // Storage limits — raised 2026-09-21 (memory-quota audit): the old
    // 10/20/3 caps crippled memory for every user (all default to 'free', and
    // the promote path was never wired). Kept in sync with services/memory/lib/
    // quotaStore.js TIER_LIMITS. Feature flags below are a separate 'memory as
    // core' decision (QuoxPlan #4098) — not flipped here.
    maxLearnedItems: 2000,
    maxEpisodicItems: 2000,
    maxPreferences: 200,
    maxContextTokens: 2000,

    // Feature flags — memory-as-core flip, 2026-09-21 (quox#571 part 1).
    // Every flag below was audited feature-by-feature before flipping
    // (verdicts with file:line evidence in quox#571): WSM, style engine,
    // belief/failure memory, promotion, visualization and the importers all
    // write through to the org-scoped memory service, so gating them off was
    // pure feature-gutting. hasIntentMemory / hasContradictionDetection /
    // hasUnlimitedHistory gate NOTHING (dead flags: the real features run
    // unconditionally or are governed by the numeric limits above), so false
    // here only misrepresented the product.
    // hasSemanticSearch stays OFF everywhere it matters: the browser
    // embedding-key path is a dead stub and the qdrant call has no visible
    // per-org filter — enabling it would advertise a feature that cannot
    // work (follow-up filed on quox#571).
    hasSemanticSearch: false,
    hasStyleEngine: true,
    hasBeliefMemory: true,
    hasIntentMemory: true,
    hasMemoryPromotion: true,
    hasChatGPTImport: true,
    hasContradictionDetection: true,
    hasFailureMemory: true,
    hasWSM: true,
    hasMemoryVisualization: true,
    hasUnlimitedHistory: true,

    // Display info
    displayName: 'Free',
    description: 'Core memory features with generous limits',
    color: '#30ff90'
  },

  premium: {
    // Storage limits
    maxLearnedItems: Infinity,
    maxEpisodicItems: Infinity,
    maxPreferences: Infinity,
    maxContextTokens: 4000,

    // Feature flags
    // hasSemanticSearch RETIRED to false (quox#571 Part 4). It was the only
    // tier flag that silently enabled a broken + cross-tenant-leaky path: the
    // browser embedding key path is a dead stub (deterministic pseudo-vectors,
    // not semantic) and the qdrant search had no per-org filter, so a premium
    // user flipping this on would search one global untenanted collection.
    // Retired pending server-side embedding + per-org qdrant filter, see #571.
    hasSemanticSearch: false,
    hasStyleEngine: true,
    hasBeliefMemory: true,
    hasIntentMemory: true,
    hasMemoryPromotion: true,
    hasChatGPTImport: true,
    hasContradictionDetection: true,
    hasFailureMemory: true,
    hasWSM: true,
    hasMemoryVisualization: true,
    hasUnlimitedHistory: true,

    // Display info
    displayName: 'Premium',
    description: 'Advanced Memory Plugin - Unlimited features',
    color: '#9d4edd'
  }
}

// ============================================================================
// TIER DETECTION
// ============================================================================

/**
 * Get current memory tier (uses local license validation)
 * No network call required - checks localStorage license
 * @returns {Promise<'free'|'premium'>}
 */
export async function getMemoryTier() {
  const now = Date.now()

  // Return cached value if fresh
  if (tierCache && (now - tierCacheTime) < CACHE_TTL) {
    return tierCache
  }

  // Check local license for advanced-memory tier (tier_b)
  // This is synchronous - no network call needed
  const isPremium = isPluginLicensed(PREMIUM_PLUGIN_NAME)

  tierCache = isPremium ? 'premium' : 'free'
  tierCacheTime = now

  return tierCache
}

/**
 * Get memory tier synchronously (uses cached value)
 * Returns 'free' if cache is empty - call getMemoryTier() to initialize
 * @returns {'free'|'premium'}
 */
export function getMemoryTierSync() {
  return tierCache || 'free'
}

/**
 * Force refresh of tier cache
 * @returns {Promise<'free'|'premium'>}
 */
export async function refreshMemoryTier() {
  tierCache = null
  tierCacheTime = 0
  return getMemoryTier()
}

/**
 * Initialize tier cache on app startup
 * Call this early in the app lifecycle
 */
export async function initializeMemoryTier() {
  return getMemoryTier()
}

// ============================================================================
// TIER LIMITS HELPERS
// ============================================================================

/**
 * Get limits for a specific tier
 * @param {'free'|'premium'} tier
 * @returns {object} Tier limits object
 */
export function getTierLimits(tier = 'free') {
  return TIER_LIMITS[tier] || TIER_LIMITS.free
}

/**
 * Get current tier limits based on cached tier
 * @returns {object} Current tier limits
 */
export function getCurrentLimits() {
  return getTierLimits(getMemoryTierSync())
}

/**
 * Check if a specific feature is available in current tier
 * @param {string} featureName - Feature flag name (e.g., 'hasSemanticSearch')
 * @returns {boolean}
 */
export function hasFeature(featureName) {
  const limits = getCurrentLimits()
  return !!limits[featureName]
}

/**
 * Get limit value for a specific limit type
 * @param {string} limitName - Limit name (e.g., 'maxLearnedItems')
 * @returns {number}
 */
export function getLimit(limitName) {
  const limits = getCurrentLimits()
  return limits[limitName] ?? 0
}

// ============================================================================
// USAGE TRACKING
// ============================================================================

/**
 * Check if adding an item would exceed tier limits
 * @param {'learned'|'episodic'|'preferences'} type - Item type
 * @param {number} currentCount - Current item count
 * @returns {{ allowed: boolean, limit: number, remaining: number, upgradeRequired: boolean }}
 */
export function checkLimit(type, currentCount) {
  const limits = getCurrentLimits()
  const tier = getMemoryTierSync()

  let limit
  switch (type) {
    case 'learned':
      limit = limits.maxLearnedItems
      break
    case 'episodic':
      limit = limits.maxEpisodicItems
      break
    case 'preferences':
      limit = limits.maxPreferences
      break
    default:
      limit = Infinity
  }

  const allowed = currentCount < limit
  const remaining = Math.max(0, limit - currentCount)

  return {
    allowed,
    limit,
    remaining,
    current: currentCount,
    tier,
    upgradeRequired: !allowed && tier === 'free'
  }
}

/**
 * Create an upgrade prompt message
 * @param {string} feature - Feature that triggered the prompt
 * @returns {object} Upgrade prompt info
 */
export function createUpgradePrompt(feature) {
  const prompts = {
    learnedItems: {
      title: 'Memory Limit Reached',
      message: 'You have reached the free limit of 10 learned memories.',
      benefit: 'Purchase the Advanced Memory Plugin for unlimited storage (one-time $99).'
    },
    semanticSearch: {
      title: 'Semantic Search',
      message: 'Semantic search requires the Advanced Memory Plugin.',
      benefit: 'Find memories by meaning, not just keywords (one-time purchase).'
    },
    styleEngine: {
      title: 'Style Engine',
      message: 'Style learning requires the Advanced Memory Plugin.',
      benefit: 'Quox adapts to your communication style (one-time purchase).'
    },
    beliefMemory: {
      title: 'Belief Memory',
      message: 'Belief tracking requires the Advanced Memory Plugin.',
      benefit: 'Track facts, assumptions, and hypotheses with confidence levels (one-time purchase).'
    },
    chatgptImport: {
      title: 'ChatGPT Import',
      message: 'Conversation import requires the Advanced Memory Plugin.',
      benefit: 'Import your ChatGPT history and extract memories (one-time purchase).'
    },
    contradictionDetection: {
      title: 'Contradiction Detection',
      message: 'Conflict detection requires the Advanced Memory Plugin.',
      benefit: 'Automatically detect and resolve conflicting memories (one-time purchase).'
    },
    failureMemory: {
      title: 'Failure Memory',
      message: 'Failure tracking requires the Advanced Memory Plugin.',
      benefit: 'Remember what didn\'t work to avoid repeated mistakes (one-time purchase).'
    },
    wsm: {
      title: 'Working Set Memory',
      message: 'Full WSM features require the Advanced Memory Plugin.',
      benefit: 'Track open loops, active decisions, and context (one-time purchase).'
    },
    terminalMemory: {
      title: 'Terminal Memory',
      message: 'Terminal memory integration requires the Advanced Memory Plugin.',
      benefit: 'Error resolution memory, command patterns, and working set tracking from terminal sessions (one-time purchase).'
    },
    preferences: {
      title: 'Preference Limit Reached',
      message: 'You have reached the free limit of 3 preferences.',
      benefit: 'Purchase the Advanced Memory Plugin for unlimited preferences (one-time $99).'
    },
    contextTokens: {
      title: 'Context Budget Limited',
      message: 'Free version is limited to 500 tokens of context.',
      benefit: 'Purchase the Advanced Memory Plugin for 4000+ token context (one-time $99).'
    }
  }

  return {
    ...prompts[feature] || {
      title: 'Plugin Required',
      message: 'This feature requires the Advanced Memory Plugin.',
      benefit: 'Unlock unlimited memory and advanced features (one-time purchase).'
    },
    feature,
    price: '$99 one-time',
    pluginName: 'Advanced Memory',
    purchaseUrl: '/plugins'
  }
}

// ============================================================================
// TIER GATING DECORATORS
// ============================================================================

/**
 * Create a tier-gated function that returns purchase prompt for free version
 * @param {Function} fn - The function to gate
 * @param {string} featureFlag - Feature flag to check
 * @param {string} featureName - Feature name for purchase prompt
 * @returns {Function} Gated function
 */
export function requirePremium(fn, featureFlag, featureName) {
  return async function gated(...args) {
    if (!hasFeature(featureFlag)) {
      return {
        success: false,
        blocked: true,
        reason: 'premium_required',
        upgrade: createUpgradePrompt(featureName)
      }
    }
    return fn.apply(this, args)
  }
}

/**
 * Synchronous version for non-async functions
 */
export function requirePremiumSync(fn, featureFlag, featureName) {
  return function gated(...args) {
    if (!hasFeature(featureFlag)) {
      return {
        success: false,
        blocked: true,
        reason: 'premium_required',
        upgrade: createUpgradePrompt(featureName)
      }
    }
    return fn.apply(this, args)
  }
}

// ============================================================================
// TIER STATUS INFO
// ============================================================================

/**
 * Get comprehensive tier status for UI display
 * Uses local license validation (no network call required)
 * @returns {Promise<object>} Tier status info
 */
export async function getTierStatus() {
  const tier = await getMemoryTier()
  const limits = getTierLimits(tier)

  // Get license info from local storage
  const licenseInfo = getLocalLicenseStatus()

  return {
    tier,
    limits,
    isPremium: tier === 'premium',
    displayName: limits.displayName,
    description: limits.description,
    color: limits.color,
    license: licenseInfo,
    features: {
      semanticSearch: limits.hasSemanticSearch,
      styleEngine: limits.hasStyleEngine,
      beliefMemory: limits.hasBeliefMemory,
      intentMemory: limits.hasIntentMemory,
      memoryPromotion: limits.hasMemoryPromotion,
      chatgptImport: limits.hasChatGPTImport,
      contradictionDetection: limits.hasContradictionDetection,
      failureMemory: limits.hasFailureMemory,
      wsm: limits.hasWSM,
      visualization: limits.hasMemoryVisualization,
      unlimitedHistory: limits.hasUnlimitedHistory
    }
  }
}

/**
 * Get usage summary for current tier
 * @param {object} memoryManager - Memory manager instance
 * @returns {object} Usage summary
 */
export function getUsageSummary(memoryManager) {
  if (!memoryManager) return null

  const tier = getMemoryTierSync()
  const limits = getTierLimits(tier)

  // Count current items
  let learnedCount = 0
  let preferencesCount = 0

  try {
    const facts = memoryManager.getLearnedItemsByType?.('fact') || []
    const prefs = memoryManager.getLearnedItemsByType?.('preference') || []
    const decisions = memoryManager.getLearnedItemsByType?.('decision') || []
    const constraints = memoryManager.getLearnedItemsByType?.('constraint') || []

    learnedCount = facts.length + decisions.length + constraints.length
    preferencesCount = prefs.length
  } catch (err) {
    console.warn('[MemoryTier] Error counting items:', err)
  }

  return {
    tier,
    learned: {
      current: learnedCount,
      limit: limits.maxLearnedItems,
      percentage: limits.maxLearnedItems === Infinity
        ? 0
        : Math.round((learnedCount / limits.maxLearnedItems) * 100),
      atLimit: learnedCount >= limits.maxLearnedItems
    },
    preferences: {
      current: preferencesCount,
      limit: limits.maxPreferences,
      percentage: limits.maxPreferences === Infinity
        ? 0
        : Math.round((preferencesCount / limits.maxPreferences) * 100),
      atLimit: preferencesCount >= limits.maxPreferences
    },
    contextTokens: {
      limit: limits.maxContextTokens
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  // Tier detection
  getMemoryTier,
  getMemoryTierSync,
  refreshMemoryTier,
  initializeMemoryTier,

  // Limits
  getTierLimits,
  getCurrentLimits,
  hasFeature,
  getLimit,

  // Usage tracking
  checkLimit,
  createUpgradePrompt,

  // Decorators
  requirePremium,
  requirePremiumSync,

  // Status
  getTierStatus,
  getUsageSummary,

  // Constants
  TIER_LIMITS,
  PREMIUM_PLUGIN_NAME
}
