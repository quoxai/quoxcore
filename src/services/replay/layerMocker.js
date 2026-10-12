/**
 * Layer Mocker Service
 *
 * Provides mock responses for AOCL layers during replay testing.
 * Allows isolated testing of layer behavior without full pipeline execution.
 *
 * Part of AOCL Compliance Suite (Enterprise plugin).
 */

import { AOCL_LAYERS } from '../../lib/aee/envelope'

// ============================================================================
// Mock Storage (in-memory, session-scoped)
// ============================================================================

const layerMocks = new Map()

// ============================================================================
// Mock Management
// ============================================================================

/**
 * Sets a mock response for a specific layer
 *
 * @param {string} layerId - Layer ID (L0-L10)
 * @param {Object|string|Function} response - Mock response or generator function
 * @param {Object} [options] - Additional options
 * @param {boolean} [options.persist] - Whether to persist across replays
 * @param {number} [options.delay] - Artificial delay in ms
 * @returns {boolean} Whether mock was set successfully
 *
 * @example
 * // Static mock
 * setLayerMock('L7', { response: 'Mocked response text' })
 *
 * // Function mock (receives context)
 * setLayerMock('L2', (input) => ({
 *   handled: true,
 *   pattern: 'test_pattern',
 *   confidence: 0.9
 * }))
 */
export function setLayerMock(layerId, response, options = {}) {
  if (!AOCL_LAYERS[layerId]) {
    console.warn(`[LayerMocker] Unknown layer: ${layerId}`)
    return false
  }

  layerMocks.set(layerId, {
    response,
    options,
    setAt: new Date().toISOString()
  })

  console.debug(`[LayerMocker] Mock set for ${layerId}`)
  return true
}

/**
 * Clears a mock for a specific layer
 *
 * @param {string} layerId - Layer ID to clear
 * @returns {boolean} Whether a mock was cleared
 */
export function clearLayerMock(layerId) {
  const existed = layerMocks.has(layerId)
  layerMocks.delete(layerId)

  if (existed) {
    console.debug(`[LayerMocker] Mock cleared for ${layerId}`)
  }

  return existed
}

/**
 * Clears all layer mocks
 */
export function clearAllMocks() {
  const count = layerMocks.size
  layerMocks.clear()
  console.debug(`[LayerMocker] Cleared ${count} mocks`)
}

/**
 * Gets all current layer mocks
 *
 * @returns {Object} Map of layer ID to mock response
 */
export function getLayerMocks() {
  const mocks = {}
  for (const [layerId, mockData] of layerMocks) {
    mocks[layerId] = mockData.response
  }
  return mocks
}

/**
 * Gets mock data for a specific layer
 *
 * @param {string} layerId - Layer ID
 * @returns {Object|null} Mock data or null
 */
export function getLayerMock(layerId) {
  return layerMocks.get(layerId) || null
}

/**
 * Checks if a layer has a mock set
 *
 * @param {string} layerId - Layer ID
 * @returns {boolean} Whether mock exists
 */
export function hasLayerMock(layerId) {
  return layerMocks.has(layerId)
}

/**
 * Executes a mock for a layer, handling function mocks
 *
 * @param {string} layerId - Layer ID
 * @param {Object} input - Input to pass to function mocks
 * @returns {Promise<Object|null>} Mock result or null if no mock
 */
export async function executeMock(layerId, input = {}) {
  const mockData = layerMocks.get(layerId)

  if (!mockData) {
    return null
  }

  const { response, options } = mockData

  // Apply artificial delay if specified
  if (options.delay && options.delay > 0) {
    await new Promise(resolve => setTimeout(resolve, options.delay))
  }

  // If response is a function, execute it
  if (typeof response === 'function') {
    try {
      const result = await response(input)
      return result
    } catch (err) {
      console.error(`[LayerMocker] Mock function error for ${layerId}:`, err)
      return { error: err.message }
    }
  }

  // Return static response
  return response
}

// ============================================================================
// Preset Mocks
// ============================================================================

/**
 * Common mock presets for testing
 */
export const MOCK_PRESETS = {
  // L2 Smart Router - bypass to LLM
  L2_BYPASS: {
    handled: false,
    reason: 'no_pattern_match',
    confidence: 0
  },

  // L2 Smart Router - handled
  L2_HANDLED: {
    handled: true,
    pattern: 'test_pattern',
    confidence: 0.95,
    response: 'Handled by Smart Router'
  },

  // L3 Policy Gate - allow
  L3_ALLOW: {
    allowed: true,
    reason: 'passed_all_checks',
    checks: ['rate-limit', 'content-safety', 'scope']
  },

  // L3 Policy Gate - reject
  L3_REJECT: {
    allowed: false,
    reason: 'content_safety_violation',
    checks: ['content-safety'],
    violation: 'Detected potentially harmful content'
  },

  // L7 Execute - success
  L7_SUCCESS: {
    response: '[Mocked Response] This is a simulated LLM response for testing.',
    model: 'mock-model',
    usage: { input_tokens: 100, output_tokens: 50 }
  },

  // L7 Execute - error
  L7_ERROR: {
    error: true,
    message: 'Simulated LLM error',
    code: 'MOCK_ERROR'
  },

  // L8 Verify - pass
  L8_PASS: {
    valid: true,
    warnings: [],
    checks: ['length', 'safety', 'consistency']
  },

  // L8 Verify - warning
  L8_WARNING: {
    valid: true,
    warnings: ['Response may contain unverified claims'],
    checks: ['length', 'safety', 'consistency']
  },

  // L8 Verify - fail
  L8_FAIL: {
    valid: false,
    errors: ['Response failed safety check'],
    checks: ['length', 'safety', 'consistency']
  }
}

/**
 * Applies a preset mock to a layer
 *
 * @param {string} layerId - Layer ID
 * @param {string} presetName - Preset name from MOCK_PRESETS
 * @param {Object} [options] - Additional options
 * @returns {boolean} Whether preset was applied
 */
export function applyPreset(layerId, presetName, options = {}) {
  const preset = MOCK_PRESETS[presetName]

  if (!preset) {
    console.warn(`[LayerMocker] Unknown preset: ${presetName}`)
    return false
  }

  return setLayerMock(layerId, preset, options)
}

/**
 * Creates a custom mock builder for a layer
 *
 * @param {string} layerId - Layer ID
 * @returns {Object} Mock builder with fluent API
 *
 * @example
 * mockBuilder('L7')
 *   .withDelay(100)
 *   .returns({ response: 'Custom response' })
 *   .apply()
 */
export function mockBuilder(layerId) {
  const config = {
    layerId,
    response: null,
    options: {}
  }

  return {
    /**
     * Sets artificial delay
     */
    withDelay(ms) {
      config.options.delay = ms
      return this
    },

    /**
     * Sets persistence across replays
     */
    persist() {
      config.options.persist = true
      return this
    },

    /**
     * Sets static response
     */
    returns(response) {
      config.response = response
      return this
    },

    /**
     * Sets function response
     */
    returnsFn(fn) {
      config.response = fn
      return this
    },

    /**
     * Uses a preset
     */
    usePreset(presetName) {
      const preset = MOCK_PRESETS[presetName]
      if (preset) {
        config.response = preset
      }
      return this
    },

    /**
     * Applies the mock
     */
    apply() {
      if (config.response === null) {
        console.warn(`[LayerMocker] No response set for ${config.layerId}`)
        return false
      }
      return setLayerMock(config.layerId, config.response, config.options)
    }
  }
}

// ============================================================================
// Debug Utilities
// ============================================================================

/**
 * Gets a summary of all active mocks
 *
 * @returns {Object} Mock summary
 */
export function getMockSummary() {
  const summary = {
    count: layerMocks.size,
    layers: []
  }

  for (const [layerId, mockData] of layerMocks) {
    summary.layers.push({
      layer: layerId,
      type: typeof mockData.response === 'function' ? 'function' : 'static',
      setAt: mockData.setAt,
      hasDelay: !!mockData.options?.delay
    })
  }

  return summary
}

/**
 * Logs current mock state for debugging
 */
export function debugMocks() {
  console.group('[LayerMocker] Active Mocks')
  for (const [layerId, mockData] of layerMocks) {
    console.log(`${layerId}:`, {
      type: typeof mockData.response,
      options: mockData.options,
      setAt: mockData.setAt
    })
  }
  console.groupEnd()
}
