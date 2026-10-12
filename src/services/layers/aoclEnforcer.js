/**
 * AOCL Enforcement Service
 *
 * Coordinates enforcement across AOCL layers.
 * Wraps L1 (identity), L3 (policy gate), L8 (response verification)
 * into a simple API for chat pipeline integration.
 *
 * Enforcement modes:
 * - 'enforce': reject requests/responses that fail checks
 * - 'observe': emit events but never reject (current default for L1/L8)
 *
 * All enforcement is fail-open: if the enforcer itself errors,
 * the request/response proceeds and the error is logged.
 */

import { createLayerEvent, storeEnvelope } from '../../lib/aee/index.js'
import { checkPolicy } from './policyGate.js'
import { verifyResponse } from './responseVerifier.js'

// ─── Configuration ───────────────────────────────────────────────────

const ENFORCEMENT_CONFIG = {
  L1: {
    enabled: false,  // Enable when auth system is fully wired
    mode: 'observe', // 'enforce' | 'observe'
  },
  L3: {
    enabled: true,   // Already enforcing in ChatTab
    mode: 'enforce',
  },
  L8: {
    enabled: true,
    mode: 'enforce', // Now enforces — rejects unsafe/empty responses
    allowWarnings: true, // Warnings pass through, only hard failures reject
  },
}

// ─── L1: Identity / Scope ────────────────────────────────────────────

/**
 * Check identity and scope authorization.
 * Returns { allowed, reason } — if not allowed, caller should reject.
 *
 * @param {Object} user - User context (from useAuth or similar)
 * @param {string} user.id - User ID
 * @param {string} user.orgId - Active org ID
 * @param {string} user.role - User role
 * @param {string} corr - Correlation ID
 * @returns {Promise<{ allowed: boolean, reason?: string }>}
 */
export async function enforceL1Identity(user, corr) {
  if (!ENFORCEMENT_CONFIG.L1.enabled) {
    return { allowed: true, skipped: true }
  }

  const startTime = Date.now()

  try {
    // Emit L1 start
    if (corr) {
      storeEnvelope(createLayerEvent('L1', 'start', {
        userId: user?.id,
        orgId: user?.orgId,
      }, corr)).catch(() => {})
    }

    // Check 1: User must exist
    if (!user || !user.id) {
      const result = { allowed: false, reason: 'No authenticated user' }
      emitL1Result(corr, result, startTime)
      return result
    }

    // Check 2: User must have an active org
    if (!user.orgId) {
      const result = { allowed: false, reason: 'No active organization' }
      emitL1Result(corr, result, startTime)
      return result
    }

    // All checks passed
    const result = { allowed: true }
    emitL1Result(corr, result, startTime)
    return result

  } catch (err) {
    console.warn('[AOCL] L1 enforcer error (fail-open):', err.message)
    if (corr) {
      storeEnvelope(createLayerEvent('L1', 'complete', {
        allowed: true,
        error: err.message,
        failedOpen: true,
        duration_ms: Date.now() - startTime,
      }, corr)).catch(() => {})
    }
    return { allowed: true, error: err.message }
  }
}

function emitL1Result(corr, result, startTime) {
  if (!corr) return
  const eventType = result.allowed ? 'complete' : 'reject'
  storeEnvelope(createLayerEvent('L1', eventType, {
    allowed: result.allowed,
    reason: result.reason,
    duration_ms: Date.now() - startTime,
  }, corr)).catch(() => {})
}

// ─── L3: Policy Gate (delegation) ───────────────────────────────────

/**
 * Run L3 policy gate.
 * Delegates to the existing checkPolicy() implementation.
 * This is a convenience wrapper for consistent API.
 */
export async function enforceL3Policy(query, context) {
  if (!ENFORCEMENT_CONFIG.L3.enabled) {
    return { allowed: true, skipped: true }
  }
  return checkPolicy(query, context)
}

// ─── L8: Response Verification ───────────────────────────────────────

/**
 * Verify response and optionally enforce rejection.
 * Returns { valid, reason, warnings, sanitized } — if not valid
 * and mode is 'enforce', caller should replace response with error message.
 *
 * @param {string} response - AI response text
 * @param {Object} context - { query, agent, corr, hasRAG }
 * @returns {Promise<{ valid: boolean, reason?: string, warnings: string[], response: string }>}
 */
export async function enforceL8Response(response, context = {}) {
  if (!ENFORCEMENT_CONFIG.L8.enabled) {
    return { valid: true, skipped: true, warnings: [], response }
  }

  const result = await verifyResponse(response, context)

  if (!result.valid && ENFORCEMENT_CONFIG.L8.mode === 'enforce') {
    return {
      valid: false,
      reason: result.reason,
      warnings: result.warnings || [],
      response: `[Response blocked by safety check: ${result.reason}]`,
    }
  }

  // Valid or observe-only mode — pass through
  return {
    valid: true,
    warnings: result.warnings || [],
    response,
  }
}

// ─── Getters ─────────────────────────────────────────────────────────

export function getEnforcementConfig() {
  return { ...ENFORCEMENT_CONFIG }
}
