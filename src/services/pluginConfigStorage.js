/**
 * Plugin Configuration Storage Service
 *
 * Manages plugin-specific configuration settings with localStorage persistence.
 * Pattern based on assistantStorage.js for consistency.
 */

import { getPluginManifest } from '../config/plugins'
import { syncPreferenceToServer } from './userPreferences'
import { orgGet, orgSet, orgRemove } from './orgScopedStorage'

/**
 * Map plugin config field names to bastion storage field names
 */
const BASTION_FIELD_MAP = {
  apiToken: 'apiToken',
  backendUrl: 'backendUrl'
}

/**
 * Get bastion config from its dedicated localStorage key
 */
function getBastionConfig() {
  try {
    const stored = orgGet('bastion-config')
    if (!stored) return {}
    const parsed = JSON.parse(stored)
    // If vault credential_id is set, don't expose apiToken
    if (parsed.credential_id) {
      const { apiToken, ...rest } = parsed
      return rest
    }
    return parsed
  } catch {
    return {}
  }
}

/**
 * Save bastion config to its dedicated localStorage key
 */
function saveBastionConfig(config) {
  try {
    const existing = getBastionConfig()
    const updated = { ...existing, ...config }
    // Strip apiToken if credential_id is set (token lives in vault)
    if (updated.credential_id) {
      delete updated.apiToken
    }
    orgSet('bastion-config', JSON.stringify(updated))

    // Also notify bastionClient to reconfigure
    window.dispatchEvent(new CustomEvent('quox-bastion-config-change', {
      detail: updated
    }))

    return true
  } catch {
    return false
  }
}

/**
 * Get configuration for a plugin
 * @param {string} pluginName - Plugin identifier
 * @returns {object} Current config merged with schema defaults
 */
export function getPluginConfig(pluginName) {
  try {
    // Special handling for bastion-fleet - uses dedicated storage
    if (pluginName === 'bastion-fleet') {
      const bastionConfig = getBastionConfig()
      const manifest = getPluginManifest(pluginName)
      const schema = manifest?.configSchema || {}
      const defaults = Object.entries(schema).reduce((acc, [key, field]) => {
        acc[key] = field.default
        return acc
      }, {})
      return { ...defaults, ...bastionConfig }
    }

    const stored = orgGet('plugin-configs')
    const configs = stored ? JSON.parse(stored) : {}

    // Get schema defaults from manifest
    const manifest = getPluginManifest(pluginName)
    const schema = manifest?.configSchema || {}
    const defaults = Object.entries(schema).reduce((acc, [key, field]) => {
      acc[key] = field.default
      return acc
    }, {})

    // Merge defaults with stored config
    return { ...defaults, ...configs[pluginName] }
  } catch (err) {
    console.error(`[PluginConfig] Failed to get config for ${pluginName}:`, err)
    return {}
  }
}

/**
 * Get all plugin configurations
 * @returns {object} Map of pluginName -> config
 */
export function getAllPluginConfigs() {
  try {
    const stored = orgGet('plugin-configs')
    return stored ? JSON.parse(stored) : {}
  } catch (err) {
    console.error('[PluginConfig] Failed to get all configs:', err)
    return {}
  }
}

/**
 * Save configuration for a plugin
 * @param {string} pluginName - Plugin identifier
 * @param {object} config - Configuration values
 * @returns {boolean} Success
 */
export function savePluginConfig(pluginName, config) {
  try {
    // Special handling for bastion-fleet - uses dedicated storage
    if (pluginName === 'bastion-fleet') {
      return saveBastionConfig(config)
    }

    const stored = orgGet('plugin-configs')
    const configs = stored ? JSON.parse(stored) : {}

    configs[pluginName] = {
      ...configs[pluginName],
      ...config,
      _updatedAt: new Date().toISOString()
    }

    orgSet('plugin-configs', JSON.stringify(configs))

    // Emit event for real-time updates
    window.dispatchEvent(new CustomEvent('quox-plugin-config-change', {
      detail: { pluginName, config: configs[pluginName] }
    }))

    // Sync to server (excludes bastion-fleet, handled above)
    syncPreferenceToServer('pluginConfigs', configs)

    return true
  } catch (err) {
    console.error(`[PluginConfig] Failed to save config for ${pluginName}:`, err)
    return false
  }
}

/**
 * Validate config against schema
 * @param {string} pluginName - Plugin identifier
 * @param {object} config - Configuration to validate
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validatePluginConfig(pluginName, config) {
  const manifest = getPluginManifest(pluginName)
  const schema = manifest?.configSchema || {}
  const errors = []

  for (const [key, field] of Object.entries(schema)) {
    const value = config[key]

    // Skip undefined values (will use default)
    if (value === undefined) continue

    // Type check
    const expectedType = field.type === 'boolean' ? 'boolean' :
                         field.type === 'number' ? 'number' : 'string'
    if (typeof value !== expectedType) {
      errors.push(`${field.label || key}: Expected ${expectedType}, got ${typeof value}`)
      continue
    }

    // Range check for numbers
    if (field.type === 'number') {
      if (field.min !== undefined && value < field.min) {
        errors.push(`${field.label || key}: Must be at least ${field.min}`)
      }
      if (field.max !== undefined && value > field.max) {
        errors.push(`${field.label || key}: Must be at most ${field.max}`)
      }
    }

    // Enum check
    if (field.enum && !field.enum.includes(value)) {
      errors.push(`${field.label || key}: Invalid value`)
    }
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * Reset plugin config to schema defaults
 * @param {string} pluginName - Plugin identifier
 * @returns {boolean} Success
 */
export function resetPluginConfig(pluginName) {
  try {
    // Special handling for bastion-fleet
    if (pluginName === 'bastion-fleet') {
      orgRemove('bastion-config')
      window.dispatchEvent(new CustomEvent('quox-bastion-config-change', {
        detail: { reset: true }
      }))
      return true
    }

    const stored = orgGet('plugin-configs')
    const configs = stored ? JSON.parse(stored) : {}

    delete configs[pluginName]
    orgSet('plugin-configs', JSON.stringify(configs))
    syncPreferenceToServer('pluginConfigs', configs)

    window.dispatchEvent(new CustomEvent('quox-plugin-config-change', {
      detail: { pluginName, config: null, reset: true }
    }))

    return true
  } catch (err) {
    console.error(`[PluginConfig] Failed to reset config for ${pluginName}:`, err)
    return false
  }
}

/**
 * Check if a plugin has configurable settings
 * @param {string} pluginName - Plugin identifier
 * @returns {boolean}
 */
export function pluginHasSettings(pluginName) {
  const manifest = getPluginManifest(pluginName)
  return manifest?.configSchema && Object.keys(manifest.configSchema).length > 0
}

/**
 * Get the config schema for a plugin
 * @param {string} pluginName - Plugin identifier
 * @returns {object} Schema or empty object
 */
export function getPluginConfigSchema(pluginName) {
  const manifest = getPluginManifest(pluginName)
  return manifest?.configSchema || {}
}

/**
 * Export all plugin configs as JSON string
 * @returns {string}
 */
export function exportPluginConfigs() {
  return orgGet('plugin-configs') || '{}'
}

/**
 * Import plugin configs from JSON string
 * @param {string} json
 * @returns {boolean} Success
 */
export function importPluginConfigs(json) {
  try {
    const configs = JSON.parse(json)
    orgSet('plugin-configs', JSON.stringify(configs))
    syncPreferenceToServer('pluginConfigs', configs)

    window.dispatchEvent(new CustomEvent('quox-plugin-config-change', {
      detail: { imported: true }
    }))

    return true
  } catch (err) {
    console.error('[PluginConfig] Failed to import configs:', err)
    return false
  }
}
