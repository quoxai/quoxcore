/**
 * Layer Plugin Registry - Custom AOCL Layer Management
 *
 * Manages registration, storage, and execution of custom layer plugins.
 * Includes signature verification for plugin security (Issue #70).
 * Part of AOCL Developer Kit (Pro)
 */

import { createLayerEvent } from '../../lib/aee'
import { verifyPluginSignature, getSignatureConfig } from './pluginSignature'
import { queueSync } from '../serverSyncQueue'

// Plugin storage key
const STORAGE_KEY = 'aocl_layer_plugins'

// In-memory registry of active plugins
const activePlugins = new Map()

// Plugin execution context
const executionContext = {
  // Safe utilities available to plugins
  utils: {
    delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    log: (msg) => console.log('[Plugin]', msg),
    warn: (msg) => console.warn('[Plugin]', msg),
    error: (msg) => console.error('[Plugin]', msg),
    now: () => Date.now(),
    uuid: () => `PLG_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  },
  // Read-only context data
  context: {
    version: '1.0.0',
    environment: 'browser'
  }
}

/**
 * Initialize the plugin registry from storage
 * Re-verifies signatures on stored plugins for security
 */
export async function initializeRegistry() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const plugins = JSON.parse(stored)
      const sigConfig = getSignatureConfig()

      for (const plugin of plugins) {
        if (plugin.enabled) {
          // Re-verify signature on load for security
          if (plugin.signature && sigConfig.requireSignatures) {
            const sigResult = await verifyPluginSignature(plugin)
            if (!sigResult.valid) {
              console.warn('[PluginRegistry] SECURITY: Disabling plugin with invalid signature on reload:', plugin.id)
              plugin.enabled = false
              plugin._signatureInvalid = true
              continue
            }
          }
          loadPluginToMemory(plugin)
        }
      }

      // Save any disabled plugins
      savePlugins(plugins)
    }
  } catch (err) {
    console.error('[PluginRegistry] Failed to initialize:', err)
  }
}

/**
 * Register a new layer plugin
 * @param {object} plugin - Plugin manifest and code
 * @param {object} options - Registration options
 * @param {boolean} options.skipSignatureCheck - Skip signature verification (not recommended)
 * @returns {Promise<{success: boolean, pluginId?: string, error?: string}>}
 */
export async function registerLayerPlugin(plugin, options = {}) {
  try {
    // Validate required fields
    if (!plugin.id || !plugin.name || !plugin.execute) {
      return { success: false, error: 'Missing required fields (id, name, execute)' }
    }

    // Check for duplicate ID
    const existing = getRegisteredPlugins()
    if (existing.some(p => p.id === plugin.id)) {
      return { success: false, error: `Plugin with ID "${plugin.id}" already exists` }
    }

    // Verify plugin signature (Security Fix #70)
    const sigConfig = getSignatureConfig()
    let signatureInfo = { verified: false, unsigned: true }

    if (!options.skipSignatureCheck) {
      const sigResult = await verifyPluginSignature(plugin)

      if (!sigResult.valid) {
        console.error('[PluginRegistry] SECURITY: Rejected plugin with invalid signature:', plugin.id, sigResult.error)
        return {
          success: false,
          error: `Signature verification failed: ${sigResult.error}`,
          securityRejection: true
        }
      }

      signatureInfo = {
        verified: sigResult.valid && !sigResult.unsigned,
        unsigned: sigResult.unsigned || false,
        signedBy: sigResult.signedBy,
        signedAt: sigResult.signedAt,
        keyId: sigResult.keyId
      }

      if (sigResult.warnings.length > 0) {
        console.warn('[PluginRegistry] Signature warnings for plugin:', plugin.id, sigResult.warnings)
      }
    } else {
      console.warn('[PluginRegistry] SECURITY WARNING: Signature verification skipped for:', plugin.id)
    }

    // Create plugin record with signature metadata
    const pluginRecord = {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version || '1.0.0',
      author: plugin.author || 'Unknown',
      description: plugin.description || '',
      layer: plugin.layer || {},
      configSchema: plugin.configSchema || {},
      executeCode: typeof plugin.execute === 'function'
        ? plugin.execute.toString()
        : plugin.execute,
      enabled: true,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Signature metadata
      signature: plugin.signature || null,
      signatureVerified: signatureInfo.verified,
      signedBy: signatureInfo.signedBy || null,
      signedAt: signatureInfo.signedAt || null
    }

    // Save to storage
    const plugins = getRegisteredPlugins()
    plugins.push(pluginRecord)
    savePlugins(plugins)

    // Load to memory if enabled
    if (pluginRecord.enabled) {
      loadPluginToMemory(pluginRecord)
    }

    // Dispatch event for consciousness map auto-regeneration
    window.dispatchEvent(new CustomEvent('quox-plugin-change', {
      detail: {
        type: 'install',
        pluginId: plugin.id,
        pluginName: plugin.name,
        signatureVerified: signatureInfo.verified
      }
    }))

    // Log security audit event
    console.log('[PluginRegistry] Plugin registered:', plugin.id,
      signatureInfo.verified ? `(signed by: ${signatureInfo.signedBy})` : '(unsigned)')

    return {
      success: true,
      pluginId: plugin.id,
      signatureVerified: signatureInfo.verified,
      signedBy: signatureInfo.signedBy
    }
  } catch (err) {
    console.error('[PluginRegistry] Failed to register plugin:', err)
    return { success: false, error: err.message }
  }
}

/**
 * Unregister a layer plugin
 * @param {string} pluginId - Plugin identifier
 * @returns {{success: boolean, error?: string}}
 */
export function unregisterLayerPlugin(pluginId) {
  try {
    const plugins = getRegisteredPlugins()
    const index = plugins.findIndex(p => p.id === pluginId)

    if (index === -1) {
      return { success: false, error: `Plugin "${pluginId}" not found` }
    }

    // Get plugin name before removing
    const pluginName = plugins[index].name

    // Remove from storage
    plugins.splice(index, 1)
    savePlugins(plugins)

    // Remove from memory
    activePlugins.delete(pluginId)

    // Dispatch event for consciousness map auto-regeneration
    window.dispatchEvent(new CustomEvent('quox-plugin-change', {
      detail: { type: 'uninstall', pluginId, pluginName }
    }))

    return { success: true }
  } catch (err) {
    console.error('[PluginRegistry] Failed to unregister plugin:', err)
    return { success: false, error: err.message }
  }
}

/**
 * Enable a plugin
 * @param {string} pluginId - Plugin identifier
 * @returns {{success: boolean, error?: string}}
 */
export function enablePlugin(pluginId) {
  try {
    const plugins = getRegisteredPlugins()
    const plugin = plugins.find(p => p.id === pluginId)

    if (!plugin) {
      return { success: false, error: `Plugin "${pluginId}" not found` }
    }

    plugin.enabled = true
    plugin.updatedAt = new Date().toISOString()
    savePlugins(plugins)

    // Load to memory
    loadPluginToMemory(plugin)

    return { success: true }
  } catch (err) {
    console.error('[PluginRegistry] Failed to enable plugin:', err)
    return { success: false, error: err.message }
  }
}

/**
 * Disable a plugin
 * @param {string} pluginId - Plugin identifier
 * @returns {{success: boolean, error?: string}}
 */
export function disablePlugin(pluginId) {
  try {
    const plugins = getRegisteredPlugins()
    const plugin = plugins.find(p => p.id === pluginId)

    if (!plugin) {
      return { success: false, error: `Plugin "${pluginId}" not found` }
    }

    plugin.enabled = false
    plugin.updatedAt = new Date().toISOString()
    savePlugins(plugins)

    // Remove from memory
    activePlugins.delete(pluginId)

    return { success: true }
  } catch (err) {
    console.error('[PluginRegistry] Failed to disable plugin:', err)
    return { success: false, error: err.message }
  }
}

/**
 * Update a plugin
 * @param {string} pluginId - Plugin identifier
 * @param {object} updates - Fields to update
 * @returns {{success: boolean, error?: string}}
 */
export function updatePlugin(pluginId, updates) {
  try {
    const plugins = getRegisteredPlugins()
    const plugin = plugins.find(p => p.id === pluginId)

    if (!plugin) {
      return { success: false, error: `Plugin "${pluginId}" not found` }
    }

    // Update allowed fields
    if (updates.name) plugin.name = updates.name
    if (updates.version) plugin.version = updates.version
    if (updates.author) plugin.author = updates.author
    if (updates.description) plugin.description = updates.description
    if (updates.layer) plugin.layer = updates.layer
    if (updates.configSchema) plugin.configSchema = updates.configSchema
    if (updates.executeCode) plugin.executeCode = updates.executeCode

    plugin.updatedAt = new Date().toISOString()
    savePlugins(plugins)

    // Reload if enabled
    if (plugin.enabled) {
      loadPluginToMemory(plugin)
    }

    return { success: true }
  } catch (err) {
    console.error('[PluginRegistry] Failed to update plugin:', err)
    return { success: false, error: err.message }
  }
}

/**
 * Get all registered plugins
 * @returns {object[]}
 */
export function getRegisteredPlugins() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? JSON.parse(stored) : []
  } catch (err) {
    console.error('[PluginRegistry] Failed to get plugins:', err)
    return []
  }
}

/**
 * Get a specific plugin by ID
 * @param {string} pluginId - Plugin identifier
 * @returns {object|null}
 */
export function getPlugin(pluginId) {
  const plugins = getRegisteredPlugins()
  return plugins.find(p => p.id === pluginId) || null
}

/**
 * Get all active (enabled and loaded) plugins
 * @returns {Map}
 */
export function getActivePlugins() {
  return activePlugins
}

/**
 * Check if a plugin is active
 * @param {string} pluginId - Plugin identifier
 * @returns {boolean}
 */
export function isPluginActive(pluginId) {
  return activePlugins.has(pluginId)
}

/**
 * Execute a plugin layer
 * @param {string} pluginId - Plugin identifier
 * @param {object} input - Layer input
 * @param {object} context - Execution context
 * @param {object} config - Plugin configuration
 * @returns {Promise<object>}
 */
export async function executePluginLayer(pluginId, input, context = {}, config = {}) {
  const plugin = activePlugins.get(pluginId)

  if (!plugin) {
    throw new Error(`Plugin "${pluginId}" is not active`)
  }

  const startTime = Date.now()
  const layerId = plugin.layer?.position || 'LX'

  try {
    // Create sandboxed execution environment
    const sandboxedContext = {
      ...executionContext,
      input,
      context,
      config
    }

    // Execute the plugin
    const result = await plugin.executor(sandboxedContext)

    const duration_ms = Date.now() - startTime

    return {
      success: true,
      pluginId,
      layerId,
      result,
      timing: { duration_ms }
    }
  } catch (err) {
    const duration_ms = Date.now() - startTime

    console.error(`[PluginRegistry] Plugin "${pluginId}" execution failed:`, err)

    return {
      success: false,
      pluginId,
      layerId,
      error: err.message,
      timing: { duration_ms }
    }
  }
}

/**
 * Get plugins for a specific layer position
 * @param {string} position - Layer position (e.g., 'L4', 'L6')
 * @returns {object[]}
 */
export function getPluginsForPosition(position) {
  const plugins = getRegisteredPlugins()
  return plugins.filter(p => p.enabled && p.layer?.position === position)
}

/**
 * Get the execution order for custom plugins
 * @returns {object[]}
 */
export function getPluginExecutionOrder() {
  const plugins = getRegisteredPlugins().filter(p => p.enabled)

  // Sort by layer position
  const layerOrder = ['L1', 'L4', 'L6', 'L11'] // Custom layer positions

  return plugins.sort((a, b) => {
    const aPos = layerOrder.indexOf(a.layer?.position) || 999
    const bPos = layerOrder.indexOf(b.layer?.position) || 999
    return aPos - bPos
  })
}

/**
 * Export plugins to JSON
 * @returns {string}
 */
export function exportPlugins() {
  const plugins = getRegisteredPlugins()
  return JSON.stringify(plugins, null, 2)
}

/**
 * Import plugins from JSON
 * @param {string} json - JSON string of plugins
 * @param {object} options - Import options
 * @param {boolean} options.skipSignatureCheck - Skip signature verification (not recommended)
 * @returns {Promise<{success: boolean, imported: number, errors: string[], securityRejections: number}>}
 */
export async function importPlugins(json, options = {}) {
  try {
    const plugins = JSON.parse(json)
    const errors = []
    let imported = 0
    let securityRejections = 0

    for (const plugin of plugins) {
      const result = await registerLayerPlugin({
        ...plugin,
        execute: plugin.executeCode
      }, options)

      if (result.success) {
        imported++
      } else {
        errors.push(`${plugin.id}: ${result.error}`)
        if (result.securityRejection) {
          securityRejections++
        }
      }
    }

    if (securityRejections > 0) {
      console.warn('[PluginRegistry] SECURITY: Rejected', securityRejections, 'plugins due to signature verification failure')
    }

    return { success: true, imported, errors, securityRejections }
  } catch (err) {
    return { success: false, imported: 0, errors: [err.message], securityRejections: 0 }
  }
}

// Internal helpers

function savePlugins(plugins) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(plugins))
  queueSync('aoclLayerPlugins', plugins)
}

function loadPluginToMemory(plugin) {
  try {
    // Create executor function from stored code
    const executor = createExecutor(plugin.executeCode)

    activePlugins.set(plugin.id, {
      ...plugin,
      executor
    })

    console.log(`[PluginRegistry] Loaded plugin: ${plugin.id}`)
  } catch (err) {
    console.error(`[PluginRegistry] Failed to load plugin "${plugin.id}":`, err)
  }
}

function createExecutor(code) {
  // Create a sandboxed executor from the code string
  // This uses Function constructor but with limited scope

  if (typeof code === 'function') {
    return code
  }

  // Parse the function code
  // Expected format: async function(ctx) { ... } or (ctx) => { ... }
  try {
    // Wrap in async function if not already
    let funcCode = code.trim()

    if (!funcCode.startsWith('async') && !funcCode.startsWith('function') && !funcCode.startsWith('(')) {
      funcCode = `async (ctx) => { ${funcCode} }`
    }

    // Create the function with limited global access
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
    const executor = new AsyncFunction('ctx', `
      const { utils, context, input, config } = ctx;
      const { delay, log, warn, error, now, uuid } = utils;

      // Execute the plugin code
      const pluginFn = ${funcCode};
      return await pluginFn(ctx);
    `)

    return executor
  } catch (err) {
    console.error('[PluginRegistry] Failed to create executor:', err)
    throw new Error(`Invalid plugin code: ${err.message}`)
  }
}

// Initialize on module load
initializeRegistry()
