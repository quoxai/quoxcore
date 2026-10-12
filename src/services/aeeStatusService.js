/**
 * AEE Status Service
 *
 * Tracks the health of AEE envelope storage and provides
 * status feedback to the UI. Replaces silent error handling
 * with observable status tracking.
 *
 * @fileoverview Monitors IndexedDB health for AEE envelope storage
 */

import { getStats, storeEnvelope as rawStoreEnvelope } from '../lib/aee'
import { onEnvelopeStored as voltOnEnvelopeStored } from '../lib/volt'

// Status state
let status = {
  initialized: false,
  healthy: null,        // null = unknown, true = working, false = failed
  lastError: null,
  lastErrorTime: null,
  lastSuccessTime: null,
  writeCount: 0,
  errorCount: 0,
  consecutiveErrors: 0
}

// Listeners for status changes
const listeners = new Set()

/**
 * Notify all listeners of status change
 */
function notifyListeners() {
  const statusCopy = { ...status }
  listeners.forEach(fn => {
    try {
      fn(statusCopy)
    } catch (err) {
      console.error('[AEE Status] Listener error:', err)
    }
  })
}

/**
 * Record a successful write
 */
function recordSuccess() {
  status.healthy = true
  status.lastSuccessTime = Date.now()
  status.writeCount++
  status.consecutiveErrors = 0

  // Clear last error after 5 successful writes
  if (status.writeCount % 5 === 0) {
    status.lastError = null
    status.lastErrorTime = null
  }

  notifyListeners()
}

/**
 * Record a failed write
 * @param {Error|string} error - The error that occurred
 */
function recordError(error) {
  const errorMessage = error?.message || String(error)

  status.healthy = false
  status.lastError = errorMessage
  status.lastErrorTime = Date.now()
  status.errorCount++
  status.consecutiveErrors++

  // Log prominently on first error or every 5th consecutive error
  if (status.consecutiveErrors === 1 || status.consecutiveErrors % 5 === 0) {
    console.error(`[AEE Status] Storage failed (${status.consecutiveErrors}x consecutive):`, errorMessage)
  }

  notifyListeners()
}

/**
 * Initialize the status service by testing IndexedDB
 * @returns {Promise<boolean>} Whether initialization succeeded
 */
export async function initAEEStatus() {
  if (status.initialized) {
    return status.healthy
  }

  console.log('[AEE Status] Initializing...')

  try {
    // Test IndexedDB by getting stats
    const stats = await getStats()
    status.initialized = true
    status.healthy = true
    console.log('[AEE Status] IndexedDB healthy -', stats.totalEnvelopes, 'envelopes,', stats.conversations, 'conversations')
    notifyListeners()
    return true
  } catch (err) {
    status.initialized = true
    status.healthy = false
    status.lastError = err.message
    status.lastErrorTime = Date.now()
    console.error('[AEE Status] IndexedDB initialization failed:', err.message)
    notifyListeners()
    return false
  }
}

/**
 * Wrapped storeEnvelope that tracks status
 * @param {Object} envelope - AEE envelope to store
 * @returns {Promise<void>}
 */
export async function storeEnvelopeWithStatus(envelope) {
  try {
    await rawStoreEnvelope(envelope)
    recordSuccess()
  } catch (err) {
    recordError(err)
    // Re-throw so callers can handle if needed
    throw err
  }
}

/**
 * Store envelope with status tracking but don't throw on error
 * This is a drop-in replacement for the old silent catch pattern
 * @param {Object} envelope - AEE envelope to store
 * @param {string} [context] - Optional context for logging
 * @returns {Promise<boolean>} Whether storage succeeded
 */
export async function storeEnvelopeSafe(envelope, context = '') {
  console.log('[AEE Status] storeEnvelopeSafe called:', context, envelope?.id)
  try {
    await rawStoreEnvelope(envelope)
    console.log('[AEE Status] Store SUCCESS:', envelope?.id)
    recordSuccess()
    // T1: Wire VOLT — record every stored envelope as a VOLT trace event
    voltOnEnvelopeStored(envelope).catch(() => {})
    return true
  } catch (err) {
    console.error('[AEE Status] Store FAILED:', envelope?.id, err.message)
    recordError(err)
    if (context) {
      console.warn(`[AEE] ${context}:`, err.message)
    }
    return false
  }
}

/**
 * Get current AEE status
 * @returns {Object} Current status
 */
export function getAEEStatus() {
  return { ...status }
}

/**
 * Subscribe to status changes
 * @param {Function} callback - Called with status object on changes
 * @returns {Function} Unsubscribe function
 */
export function subscribeToAEEStatus(callback) {
  listeners.add(callback)

  // Immediately call with current status
  callback({ ...status })

  return () => {
    listeners.delete(callback)
  }
}

/**
 * Check if AEE storage is currently healthy
 * @returns {boolean|null} true if healthy, false if failed, null if unknown
 */
export function isAEEHealthy() {
  return status.healthy
}

/**
 * Get diagnostic information for troubleshooting
 * @returns {Promise<Object>} Diagnostic info
 */
export async function getAEEDiagnostics() {
  const diagnostics = {
    status: { ...status },
    indexedDBAvailable: typeof indexedDB !== 'undefined',
    storageEstimate: null,
    dbStats: null,
    recommendations: []
  }

  // Check storage estimate if available
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate()
      diagnostics.storageEstimate = {
        usage: estimate.usage,
        quota: estimate.quota,
        usagePercent: ((estimate.usage / estimate.quota) * 100).toFixed(2) + '%'
      }

      // Warn if storage is nearly full
      if (estimate.usage / estimate.quota > 0.9) {
        diagnostics.recommendations.push('Storage is nearly full (>90%). Consider clearing old data.')
      }
    } catch (err) {
      diagnostics.storageEstimate = { error: err.message }
    }
  }

  // Get DB stats
  try {
    diagnostics.dbStats = await getStats()
  } catch (err) {
    diagnostics.dbStats = { error: err.message }
    diagnostics.recommendations.push('IndexedDB is not accessible. Check if private browsing mode is enabled.')
  }

  // Add recommendations based on status
  if (!diagnostics.indexedDBAvailable) {
    diagnostics.recommendations.push('IndexedDB is not available in this browser.')
  }

  if (status.consecutiveErrors > 0) {
    diagnostics.recommendations.push(`${status.consecutiveErrors} consecutive write failures. Last error: ${status.lastError}`)
  }

  return diagnostics
}

/**
 * Reset error state (for testing/recovery)
 */
export function resetAEEStatus() {
  status.lastError = null
  status.lastErrorTime = null
  status.consecutiveErrors = 0
  notifyListeners()
}

// Auto-initialize on import
if (typeof window !== 'undefined') {
  // Delay init slightly to not block page load
  setTimeout(() => {
    initAEEStatus().catch(err => {
      console.error('[AEE Status] Auto-init failed:', err)
    })
  }, 100)
}

export default {
  initAEEStatus,
  storeEnvelopeWithStatus,
  storeEnvelopeSafe,
  getAEEStatus,
  subscribeToAEEStatus,
  isAEEHealthy,
  getAEEDiagnostics,
  resetAEEStatus
}
