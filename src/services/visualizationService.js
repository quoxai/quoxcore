// Visualization Service
// Manages assistant visualization settings and slot system
// Ported from ai-visualizer/js/app.js (lines 204-268)

import { DEFAULT_CONFIG, createStateColorsFromHue, hexToHue } from '../components/visualizations/core/BaseVisualizer'
import { getPlugin, getLicenseStatus, isPluginEnabled } from './pluginClient'
import { queueSync } from './serverSyncQueue'

/**
 * Storage keys for visualization settings
 */
const STORAGE_KEYS = {
  meta: 'quox-viz-slots-meta',
  slotPrefix: 'quox-viz-slot-',
  licenseToken: 'quox-viz-license-token'
}

const CONSOLIDATED_KEY = 'quox-viz-config'
let _vizConfig = null

function getVizConfig() {
  if (_vizConfig) return _vizConfig
  try {
    const raw = localStorage.getItem(CONSOLIDATED_KEY)
    if (raw) {
      _vizConfig = JSON.parse(raw)
      return _vizConfig
    }
  } catch { /* fall through */ }

  // Migrate from old per-slot keys
  _vizConfig = { meta: null, slots: {} }
  let migrated = false
  try {
    const metaRaw = localStorage.getItem(STORAGE_KEYS.meta)
    if (metaRaw) {
      _vizConfig.meta = JSON.parse(metaRaw)
      localStorage.removeItem(STORAGE_KEYS.meta)
      migrated = true
    }
  } catch { /* skip */ }

  // Scan for slot keys
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith(STORAGE_KEYS.slotPrefix)) {
      const assistantId = key.slice(STORAGE_KEYS.slotPrefix.length)
      try {
        _vizConfig.slots[assistantId] = JSON.parse(localStorage.getItem(key))
        migrated = true
      } catch { /* skip */ }
    }
  }
  if (migrated) {
    // Clean up old keys
    const toRemove = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(STORAGE_KEYS.slotPrefix)) toRemove.push(key)
    }
    toRemove.forEach(k => localStorage.removeItem(k))
    saveVizConfig()
    console.log('[Viz] Migrated from per-slot to consolidated storage')
  }
  return _vizConfig
}

function saveVizConfig() {
  try {
    localStorage.setItem(CONSOLIDATED_KEY, JSON.stringify(_vizConfig))
    queueSync('vizConfig', _vizConfig)
  } catch { /* quota */ }
}

/**
 * Plugin state cache to avoid constant API calls
 */
let pluginStateCache = null
let pluginStateCacheTime = 0
const CACHE_TTL = 30000 // 30 seconds

/**
 * Server-side license validation cache
 */
let serverLicenseCache = null
let serverLicenseCacheTime = 0
const SERVER_CACHE_TTL = 60000 // 60 seconds for server validation

/**
 * Check if we're in dev/preview mode where premium features should be unlocked
 * This allows testing visualizers without a running QuoxAgent license server
 * @returns {boolean}
 */
function isDevOrPreviewMode() {
  // Check Vite dev mode
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
    return true
  }
  // Check preview URL parameter
  if (typeof window !== 'undefined' && window.location?.search?.includes('preview=1')) {
    return true
  }
  // Check localStorage flag for testing
  if (typeof localStorage !== 'undefined') {
    try {
      if (localStorage.getItem('quox-viz-dev-mode') === 'true') {
        return true
      }
    } catch (e) { /* ignore */ }
  }
  return false
}

/**
 * Available visualizer types
 */
export const VISUALIZER_TYPES = {
  HAL: 'hal',
  COMMANDER_SIGIL: 'commander-sigil',  // Core default: branded Q sigil
  KITT: 'kitt',
  RIPPLE: 'ripple',
  ATOM: 'atom',
  DNA: 'dna',
  BRAIN: 'brain',
  SPHERE: 'sphere',
  HOLO: 'holo',
  FLUID: 'fluid',
  NEXUS: 'nexus',  // 3D particle network (was PARTICULATE)
  IRIS: 'iris',
  CODEX: 'codex',  // ARCHIVIST-specific: scrolling document/manuscript visualization
  CORE: 'core'    // COREY-specific: 5-layer CORE system with 10 cognitive implants
}

/** Visualisers that are always free (no license check) */
export const FREE_VISUALIZERS = [VISUALIZER_TYPES.HAL, VISUALIZER_TYPES.COMMANDER_SIGIL]

/**
 * Default visualization assignments for each assistant
 * Based on ai-visualizer slot system
 */
/**
 * Helper to create agent config without stateSettings from DEFAULT_CONFIG
 * (stateSettings takes priority over stateColors in getStateConfig, so we remove it)
 */
function createAgentConfig(scale, stateColors) {
  // Don't spread stateSettings from DEFAULT_CONFIG - it overrides stateColors
  const { stateSettings, ...baseConfig } = DEFAULT_CONFIG
  return {
    ...baseConfig,
    scale,
    stateColors
  }
}

export const DEFAULT_ASSIGNMENTS = {
  quox: {
    visualizer: VISUALIZER_TYPES.COMMANDER_SIGIL,
    config: createAgentConfig(1.2, {
      idle: 190,       // Cyan (Quox brand)
      listening: 190,
      speaking: 260,   // Violet accent
      thinking: 220,   // Blue-violet
      error: 0         // Red for error
    })
  },
  sentinel: {
    visualizer: VISUALIZER_TYPES.SPHERE,
    config: createAgentConfig(1.1, createStateColorsFromHue(210))  // Blue
  },
  cipher: {
    visualizer: VISUALIZER_TYPES.DNA,
    config: createAgentConfig(1.0, createStateColorsFromHue(280))  // Purple
  },
  nova: {
    visualizer: VISUALIZER_TYPES.ATOM,
    config: createAgentConfig(0.9, createStateColorsFromHue(150))  // Green
  },
  prism: {
    visualizer: VISUALIZER_TYPES.BRAIN,
    config: createAgentConfig(1.3, createStateColorsFromHue(220))  // Blue
  },
  atlas: {
    visualizer: VISUALIZER_TYPES.SPHERE,
    config: createAgentConfig(1.5, createStateColorsFromHue(30))   // Orange
  },
  metrics: {
    visualizer: VISUALIZER_TYPES.KITT,
    config: createAgentConfig(1.0, createStateColorsFromHue(15))   // Red-orange
  },
  insight: {
    visualizer: VISUALIZER_TYPES.RIPPLE,
    config: createAgentConfig(1.0, createStateColorsFromHue(25))   // Orange
  },
  scholar: {
    visualizer: VISUALIZER_TYPES.HOLO,
    config: createAgentConfig(1.1, createStateColorsFromHue(175))  // Cyan
  },
  beacon: {
    visualizer: VISUALIZER_TYPES.RIPPLE,
    config: createAgentConfig(1.2, createStateColorsFromHue(140))  // Green
  },
  forge: {
    visualizer: VISUALIZER_TYPES.NEXUS,
    config: createAgentConfig(1.0, createStateColorsFromHue(160))  // Teal
  },
  archivist: {
    visualizer: VISUALIZER_TYPES.CODEX,  // Special ARCHIVIST visualizer (scrolling code/text)
    config: createAgentConfig(1.0, createStateColorsFromHue(270))  // Purple (file/document theme)
  },
  corey: {
    visualizer: VISUALIZER_TYPES.CORE,  // COREY-specific: 5 CORE layers + 10 implants
    config: createAgentConfig(1.0, createStateColorsFromHue(170))  // Teal (core introspection theme)
  }
}

/**
 * Check if visualizations plugin is enabled and licensed (async)
 * Uses QuoxAgent plugin system for actual license verification
 * In dev/preview mode, always returns true to allow testing
 * @returns {Promise<boolean>} Whether the visualizations plugin is licensed
 */
export async function isVisualizationsPluginEnabled() {
  // Dev/preview mode bypass - allow premium features for testing
  if (isDevOrPreviewMode()) {
    console.log('[Viz] Dev/preview mode - premium features unlocked')
    pluginStateCache = true
    return true
  }

  const now = Date.now()

  // Return cached value if still valid
  if (pluginStateCache !== null && (now - pluginStateCacheTime) < CACHE_TTL) {
    console.log('[Viz] Using cached plugin state:', pluginStateCache)
    return pluginStateCache
  }

  try {
    // Local license + extensions state is the primary source of truth.
    // The agent API is helpful when available, but activation must work even
    // before the agent reflects the new plugin record.
    const [enabledLocally, plugin] = await Promise.all([
      isPluginEnabled('visualizations'),
      getPlugin('visualizations').catch(() => null)
    ])

    console.log('[Viz] Plugin local/API state:', {
      enabledLocally,
      apiEnabled: plugin?.enabled,
      apiLicensed: plugin?.licensed
    })

    pluginStateCache = enabledLocally

    pluginStateCacheTime = now
    return pluginStateCache
  } catch (err) {
    console.warn('[Viz] Failed to check plugin status:', err)
    // Fail closed - no premium features without license
    return false
  }
}

/**
 * Synchronous version for immediate checks (uses cache)
 * Will return false if cache is not populated yet
 * In dev/preview mode, always returns true
 * @returns {boolean} Whether the visualizations plugin is licensed (cached)
 */
export function isPluginLicensed() {
  // Dev/preview mode bypass
  if (isDevOrPreviewMode()) {
    return true
  }
  return pluginStateCache === true
}

/**
 * Initialize plugin state cache
 * Call this on app startup to pre-populate the cache
 */
export async function initPluginState() {
  await isVisualizationsPluginEnabled()
}

/**
 * Clear plugin state cache
 * Useful when plugin state changes (enable/disable)
 */
export function clearPluginCache() {
  console.log('[Viz] Clearing plugin cache')
  pluginStateCache = null
  pluginStateCacheTime = 0
  serverLicenseCache = null
  serverLicenseCacheTime = 0
}

/**
 * Force refresh plugin state (clear cache and re-check)
 * Call this after plugin enable/disable or license activation
 * @returns {Promise<boolean>} Updated license status
 */
export async function refreshPluginState() {
  console.log('[Viz] Force refreshing plugin state...')
  clearPluginCache()
  return await isVisualizationsPluginEnabled()
}

/**
 * Validate visualization license via QuoxAgent server API
 * This provides server-side enforcement to prevent localStorage tampering
 * In dev/preview mode, all visualizers are allowed
 *
 * @param {string} visualizerType - The visualizer type being requested
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function validateVisualizerLicense(visualizerType) {
  // Core visualisers are always free - no server check needed
  if (FREE_VISUALIZERS.includes(visualizerType)) {
    return { valid: true, reason: 'free_tier' }
  }

  // Dev/preview mode bypass - allow all visualizers for testing
  if (isDevOrPreviewMode()) {
    return { valid: true, reason: 'dev_mode' }
  }

  const now = Date.now()

  // Check server cache first
  if (serverLicenseCache !== null && (now - serverLicenseCacheTime) < SERVER_CACHE_TTL) {
    return serverLicenseCache.valid
      ? { valid: true, reason: 'cached_valid' }
      : { valid: false, reason: serverLicenseCache.reason || 'cached_invalid' }
  }

  try {
    // Get license status from QuoxAgent server
    const licenseStatus = await getLicenseStatus()

    // Check if we have a valid license with the visualizations tier
    // Visualizations plugin requires tier_a or higher
    const isValidLicense = licenseStatus.valid &&
                          licenseStatus.licensed &&
                          (licenseStatus.tiers?.includes('tier_a') ||
                           licenseStatus.tiers?.includes('tier_b') ||
                           licenseStatus.tiers?.includes('tier_c') ||
                           licenseStatus.tiers?.includes('visualizations'))

    // Also verify plugin is enabled
    const pluginEnabled = await isVisualizationsPluginEnabled()

    const valid = isValidLicense && pluginEnabled

    // Cache the result
    serverLicenseCache = {
      valid,
      reason: valid ? 'server_validated' : 'no_valid_license',
      tiers: licenseStatus.tiers,
      expiresAt: licenseStatus.expires_at
    }
    serverLicenseCacheTime = now

    if (!valid) {
      console.warn('[Viz] Server license validation failed:', {
        licenseValid: licenseStatus.valid,
        licensed: licenseStatus.licensed,
        tiers: licenseStatus.tiers,
        pluginEnabled
      })
    }

    return { valid, reason: serverLicenseCache.reason }
  } catch (err) {
    console.error('[Viz] Server license validation error:', err)
    // Fail closed - no premium features without verified license
    serverLicenseCache = { valid: false, reason: 'validation_error' }
    serverLicenseCacheTime = now
    return { valid: false, reason: 'validation_error' }
  }
}

/**
 * Get validated visualization settings for an assistant
 * Performs server-side license check before returning premium visualizers
 *
 * @param {string} assistantId - The assistant ID
 * @returns {Promise<Object>} Validated visualization settings { visualizer, config, licensed }
 */
export async function getValidatedVisualizationSettings(assistantId) {
  const settings = getVisualizationSettings(assistantId)

  // Core visualisers are always allowed
  if (FREE_VISUALIZERS.includes(settings.visualizer)) {
    return { ...settings, licensed: true }
  }

  // Validate license for premium visualizers
  const validation = await validateVisualizerLicense(settings.visualizer)

  if (!validation.valid) {
    // Downgrade to Commander Sigil if license invalid (HAL is never auto-applied as a default)
    console.warn(`[Viz] Downgrading ${assistantId} from ${settings.visualizer} to Commander Sigil (${validation.reason})`)
    return {
      visualizer: VISUALIZER_TYPES.COMMANDER_SIGIL,
      config: settings.config,
      licensed: false,
      requestedVisualizer: settings.visualizer,
      downgradeReason: validation.reason
    }
  }

  return { ...settings, licensed: true }
}

/**
 * Check if settings appear tampered (basic integrity check)
 * @param {string} assistantId - The assistant ID
 * @returns {boolean} Whether settings may have been tampered with
 */
export function checkSettingsIntegrity(assistantId) {
  const config = getVizConfig()
  const parsed = config.slots?.[assistantId]

  if (!parsed) return true // No settings = no tampering

  try {

    // Check for suspicious patterns
    // 1. Missing updatedAt timestamp (manual edit)
    if (!parsed.updatedAt) {
      console.warn(`[Viz] Settings for ${assistantId} missing timestamp`)
      return false
    }

    // 2. Future timestamp (manipulation)
    if (parsed.updatedAt > Date.now() + 60000) { // 1 minute tolerance
      console.warn(`[Viz] Settings for ${assistantId} have future timestamp`)
      return false
    }

    // 3. Invalid visualizer type
    if (parsed.visualizer && !Object.values(VISUALIZER_TYPES).includes(parsed.visualizer)) {
      console.warn(`[Viz] Settings for ${assistantId} have invalid visualizer type`)
      return false
    }

    return true
  } catch (e) {
    console.warn(`[Viz] Settings for ${assistantId} failed parsing`)
    return false
  }
}

/**
 * Get visualization settings for an assistant
 * Loads from localStorage or returns defaults
 *
 * @param {string} assistantId - The assistant ID
 * @returns {Object} Visualization settings { visualizer, config }
 */
export function getVisualizationSettings(assistantId) {
  const config = getVizConfig()
  const parsed = config.slots?.[assistantId]

  if (parsed) {
    // Merge with defaults to ensure all config fields exist
    return {
      visualizer: parsed.visualizer || DEFAULT_ASSIGNMENTS[assistantId]?.visualizer || VISUALIZER_TYPES.COMMANDER_SIGIL,
      config: {
        ...DEFAULT_CONFIG,
        ...parsed.config,
        stateColors: {
          ...DEFAULT_CONFIG.stateColors,
          ...(parsed.config?.stateColors || {})
        }
      }
    }
  }

  // Return defaults for this assistant
  if (DEFAULT_ASSIGNMENTS[assistantId]) {
    return DEFAULT_ASSIGNMENTS[assistantId]
  }

  // Ultimate fallback
  return {
    visualizer: VISUALIZER_TYPES.COMMANDER_SIGIL,
    config: DEFAULT_CONFIG
  }
}

/**
 * Save visualization settings for an assistant
 *
 * @param {string} assistantId - The assistant ID
 * @param {Object} settings - Settings to save { visualizer, config }
 */
export function saveVisualizationSettings(assistantId, settings) {
  const config = getVizConfig()
  config.slots[assistantId] = {
    visualizer: settings.visualizer,
    config: settings.config,
    updatedAt: Date.now()
  }
  _vizConfig = config
  saveVizConfig()
  // Notify listeners that legacy visualization settings changed
  window.dispatchEvent(new CustomEvent('quox-viz-settings-changed', {
    detail: { assistantId }
  }))
}

/**
 * Get all visualization slot metadata
 * @returns {Array} Array of slot metadata objects
 */
export function getAllSlotsMeta() {
  const config = getVizConfig()
  if (config.meta) return config.meta
  // Return default slots based on assistants
  return Object.keys(DEFAULT_ASSIGNMENTS).map((id, index) => ({
    id: id,
    name: id.toUpperCase(),
    index: index + 1
  }))
}

/**
 * Save slots metadata
 * @param {Array} slots - Array of slot metadata
 */
export function saveSlotsMeta(slots) {
  const config = getVizConfig()
  config.meta = slots
  _vizConfig = config
  saveVizConfig()
}

/**
 * Create visualization settings from assistant color
 * @param {string} color - Hex color from assistant config
 * @param {string} visualizer - Visualizer type
 * @returns {Object} Visualization settings
 */
export function createSettingsFromColor(color, visualizer = VISUALIZER_TYPES.COMMANDER_SIGIL) {
  const hue = hexToHue(color)
  return {
    visualizer,
    config: {
      ...DEFAULT_CONFIG,
      stateColors: createStateColorsFromHue(hue)
    }
  }
}

/**
 * Export visualization settings for backup
 * @param {string} assistantId - Optional specific assistant, or export all
 * @returns {Object} Export data object
 */
export function exportSettings(assistantId = null) {
  if (assistantId) {
    const settings = getVisualizationSettings(assistantId)
    return {
      version: '1.0',
      timestamp: Date.now(),
      type: 'single',
      assistantId,
      settings
    }
  }

  // Export all
  const allSettings = {}
  Object.keys(DEFAULT_ASSIGNMENTS).forEach(id => {
    allSettings[id] = getVisualizationSettings(id)
  })

  return {
    version: '1.0',
    timestamp: Date.now(),
    type: 'full',
    meta: getAllSlotsMeta(),
    settings: allSettings
  }
}

/**
 * Import visualization settings from backup
 * @param {Object} data - Import data object
 * @returns {boolean} Success status
 */
export function importSettings(data) {
  try {
    if (data.type === 'single' && data.assistantId && data.settings) {
      saveVisualizationSettings(data.assistantId, data.settings)
      return true
    }

    if (data.type === 'full' && data.settings) {
      Object.entries(data.settings).forEach(([id, settings]) => {
        saveVisualizationSettings(id, settings)
      })
      if (data.meta) {
        saveSlotsMeta(data.meta)
      }
      return true
    }

    return false
  } catch (e) {
    console.error('Failed to import settings:', e)
    return false
  }
}

/**
 * Reset visualization settings to defaults
 * @param {string} assistantId - Optional specific assistant, or reset all
 */
export function resetSettings(assistantId = null) {
  const config = getVizConfig()
  if (assistantId) {
    delete config.slots[assistantId]
  } else {
    config.slots = {}
    config.meta = null
  }
  _vizConfig = config
  saveVizConfig()
}

export default {
  VISUALIZER_TYPES,
  DEFAULT_ASSIGNMENTS,
  isPluginLicensed,
  isVisualizationsPluginEnabled,
  initPluginState,
  clearPluginCache,
  refreshPluginState,
  getVisualizationSettings,
  saveVisualizationSettings,
  getAllSlotsMeta,
  saveSlotsMeta,
  createSettingsFromColor,
  exportSettings,
  importSettings,
  resetSettings
}
