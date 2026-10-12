/**
 * AOCL Stack Configuration
 *
 * Declarative stack definitions for layer behavior.
 * Provides utilities for querying and managing stacks.
 */

import { DEFAULT_STACK } from './default.js'

// Stack registry
const STACKS = {
  default: DEFAULT_STACK
}

// Active stack ID (can be changed per-session or per-agent)
let activeStackId = 'default'

/**
 * Get a stack configuration by ID
 * @param {string} id - Stack ID (default: 'default')
 * @returns {Object} Stack configuration
 */
export function getStack(id = 'default') {
  return STACKS[id] || STACKS.default
}

/**
 * Get the currently active stack
 * @returns {Object} Active stack configuration
 */
export function getActiveStack() {
  return getStack(activeStackId)
}

/**
 * Set the active stack
 * @param {string} id - Stack ID
 */
export function setActiveStack(id) {
  if (STACKS[id]) {
    activeStackId = id
  } else {
    console.warn(`[AOCL] Stack "${id}" not found, using default`)
    activeStackId = 'default'
  }
}

/**
 * Check if a layer is enabled in a stack
 * @param {string} stackId - Stack ID (or null for active)
 * @param {string} layerId - Layer ID (e.g., 'L2', 'L7')
 * @returns {boolean}
 */
export function isLayerEnabled(stackId, layerId) {
  const stack = stackId ? getStack(stackId) : getActiveStack()
  return stack.layers[layerId]?.enabled ?? false
}

/**
 * Check if a layer is required (cannot be skipped)
 * @param {string} stackId - Stack ID (or null for active)
 * @param {string} layerId - Layer ID
 * @returns {boolean}
 */
export function isLayerRequired(stackId, layerId) {
  const stack = stackId ? getStack(stackId) : getActiveStack()
  return stack.layers[layerId]?.required ?? false
}

/**
 * Get configuration for a specific layer
 * @param {string} stackId - Stack ID (or null for active)
 * @param {string} layerId - Layer ID
 * @returns {Object|null} Layer config or null
 */
export function getLayerConfig(stackId, layerId) {
  const stack = stackId ? getStack(stackId) : getActiveStack()
  return stack.layers[layerId]?.config || null
}

/**
 * Get all enabled layers in order
 * @param {string} stackId - Stack ID (or null for active)
 * @returns {string[]} Array of enabled layer IDs
 */
export function getEnabledLayers(stackId) {
  const stack = stackId ? getStack(stackId) : getActiveStack()
  const layerOrder = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10']

  return layerOrder.filter(id => stack.layers[id]?.enabled)
}

/**
 * Get stack settings
 * @param {string} stackId - Stack ID (or null for active)
 * @returns {Object} Stack settings
 */
export function getStackSettings(stackId) {
  const stack = stackId ? getStack(stackId) : getActiveStack()
  return stack.settings || {}
}

/**
 * Check if event emission is enabled for a stack
 * @param {string} stackId - Stack ID (or null for active)
 * @returns {boolean}
 */
export function shouldEmitEvents(stackId) {
  const settings = getStackSettings(stackId)
  return settings.emitEvents ?? true
}

/**
 * Register a custom stack
 * @param {string} id - Stack ID
 * @param {Object} stack - Stack configuration
 */
export function registerStack(id, stack) {
  if (!id || !stack) {
    console.warn('[AOCL] Invalid stack registration')
    return
  }
  STACKS[id] = { ...DEFAULT_STACK, ...stack, id }
}

/**
 * Get all registered stack IDs
 * @returns {string[]}
 */
export function getStackIds() {
  return Object.keys(STACKS)
}

/**
 * Get stack summary for UI display
 * @param {string} stackId - Stack ID (or null for active)
 * @returns {Object} Summary object
 */
export function getStackSummary(stackId) {
  const stack = stackId ? getStack(stackId) : getActiveStack()
  const enabledLayers = getEnabledLayers(stackId)

  return {
    id: stack.id,
    name: stack.name,
    description: stack.description,
    enabledLayerCount: enabledLayers.length,
    enabledLayers,
    settings: stack.settings
  }
}

// Export default stack for convenience
export { DEFAULT_STACK }
