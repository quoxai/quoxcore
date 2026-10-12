/**
 * L8 Response Verifier - Output Validation Layer
 *
 * Validates AI responses before delivery:
 * - Length and format validation
 * - Content safety screening
 * - Consistency checks
 * - Hallucination detection (basic)
 *
 * Part of AOCL (Agent Orchestration Control Layers)
 */

import { createLayerEvent, storeEnvelope } from '../../lib/aee/index.js'

// Verification configuration
const VERIFY_CONFIG = {
  // Length limits
  maxResponseLength: 50000,
  minResponseLength: 1,
  warnLongResponse: 10000,

  // Content safety patterns in responses
  blockedOutputPatterns: [
    /\b(password|secret|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9+/=]{8,}/i,  // Credential leaks
    /<script[^>]*>.*?<\/script>/is,  // Script injection
    /\beval\s*\([^)]*\)/i,  // Eval injection
  ],

  // Warning patterns
  warnOutputPatterns: [
    /\b(I don't know|I'm not sure|I cannot|I can't)\b/i,  // Uncertainty markers
    /\b(as an AI|as a language model|I am an AI)\b/i,   // AI self-reference
    /\b(sudo|chmod|rm -rf|format)\b/i,  // Dangerous commands in output
  ],

  // Consistency markers
  inconsistencyPatterns: [
    { pattern: /\b(yes|correct|right)\b.*\b(no|incorrect|wrong)\b/i, flag: 'contradictory' },
    { pattern: /\b(always|never)\b.*\b(sometimes|occasionally)\b/i, flag: 'hedging' },
  ],

  // Format validation
  expectedFormats: {
    json: /^\s*[\[{]/,
    markdown: /^#|^\*\*|^-\s/m,
    code: /```[\s\S]*```/
  }
}

/**
 * Check response length
 * @param {string} response - AI response
 * @returns {{ valid: boolean, warnings: string[] }}
 */
function checkLength(response) {
  const warnings = []
  const length = response?.length || 0

  if (length < VERIFY_CONFIG.minResponseLength) {
    return {
      valid: false,
      reason: 'Response too short or empty'
    }
  }

  if (length > VERIFY_CONFIG.maxResponseLength) {
    return {
      valid: false,
      reason: `Response exceeds maximum length (${length} > ${VERIFY_CONFIG.maxResponseLength})`
    }
  }

  if (length > VERIFY_CONFIG.warnLongResponse) {
    warnings.push(`Long response: ${length} characters`)
  }

  return { valid: true, warnings, length }
}

/**
 * Check response for blocked content
 * @param {string} response - AI response
 * @returns {{ safe: boolean, warnings: string[] }}
 */
function checkContentSafety(response) {
  const warnings = []

  // Check blocked patterns
  for (const pattern of VERIFY_CONFIG.blockedOutputPatterns) {
    if (pattern.test(response)) {
      return {
        safe: false,
        reason: 'Response contains potentially unsafe content',
        pattern: pattern.toString()
      }
    }
  }

  // Check warning patterns
  for (const pattern of VERIFY_CONFIG.warnOutputPatterns) {
    if (pattern.test(response)) {
      warnings.push(`Flagged content: ${pattern.source.slice(0, 30)}...`)
    }
  }

  return { safe: true, warnings }
}

/**
 * Check response consistency
 * @param {string} response - AI response
 * @returns {{ consistent: boolean, warnings: string[] }}
 */
function checkConsistency(response) {
  const warnings = []

  for (const { pattern, flag } of VERIFY_CONFIG.inconsistencyPatterns) {
    if (pattern.test(response)) {
      warnings.push(`Potential ${flag} statement detected`)
    }
  }

  return {
    consistent: true, // Inconsistencies are warnings, not failures
    warnings
  }
}

/**
 * Basic hallucination detection
 * Checks for common hallucination indicators
 *
 * @param {string} response - AI response
 * @param {Object} context - Request context
 * @returns {{ warnings: string[] }}
 */
function checkHallucination(response, context = {}) {
  const warnings = []

  // Check for made-up URLs
  const urlPattern = /https?:\/\/[^\s]+/g
  const urls = response.match(urlPattern) || []
  if (urls.length > 5) {
    warnings.push(`Many URLs in response (${urls.length}) - verify validity`)
  }

  // Check for specific date claims that might be fabricated
  const datePattern = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/g
  const dates = response.match(datePattern) || []
  if (dates.length > 3) {
    warnings.push(`Multiple specific dates mentioned (${dates.length}) - verify accuracy`)
  }

  // Check for citation-style references that might be fake
  const citationPattern = /\[[0-9]+\]|\(et al\.,?\s*\d{4}\)/g
  const citations = response.match(citationPattern) || []
  if (citations.length > 0 && !context.hasRAG) {
    warnings.push(`Citations present without RAG context - may be fabricated`)
  }

  // Check for overly confident claims about the future
  const futurePattern = /\b(will definitely|guaranteed to|certain to|100% will)\b/i
  if (futurePattern.test(response)) {
    warnings.push('Overly confident future prediction detected')
  }

  return { warnings }
}

/**
 * Detect response format
 * @param {string} response - AI response
 * @returns {string[]} Detected formats
 */
function detectFormats(response) {
  const formats = []

  for (const [format, pattern] of Object.entries(VERIFY_CONFIG.expectedFormats)) {
    if (pattern.test(response)) {
      formats.push(format)
    }
  }

  return formats
}

/**
 * Main response verification
 * Runs all verification checks and returns combined result
 *
 * @param {string} response - AI response to verify
 * @param {Object} context - Request context
 * @param {string} context.query - Original query
 * @param {string} context.agent - Current agent
 * @param {string} context.corr - Correlation ID for AOCL tracking
 * @param {boolean} context.hasRAG - Whether RAG was used
 * @returns {Promise<Object>} Verification result
 */
export async function verifyResponse(response, context = {}) {
  const { query, agent, corr, hasRAG } = context
  const startTime = Date.now()
  const checks = []
  const warnings = []

  // Emit L8 start event
  if (corr) {
    storeEnvelope(createLayerEvent('L8', 'start', {
      responseLength: response?.length || 0,
      agent
    }, corr)).catch(err => console.warn('[AOCL] L8 start:', err))
  }

  try {
    // Handle null/undefined response
    if (!response) {
      const result = {
        valid: false,
        reason: 'Empty response',
        checks: [{ name: 'length', passed: false }],
        warnings: []
      }

      if (corr) {
        storeEnvelope(createLayerEvent('L8', 'reject', {
          reason: 'Empty response',
          duration_ms: Date.now() - startTime
        }, corr)).catch(err => console.warn('[AOCL] L8 reject:', err))
      }

      return result
    }

    // 1. Length check
    const lengthResult = checkLength(response)
    checks.push({ name: 'length', passed: lengthResult.valid })

    if (!lengthResult.valid) {
      const result = {
        valid: false,
        reason: lengthResult.reason,
        checks,
        warnings: []
      }

      if (corr) {
        storeEnvelope(createLayerEvent('L8', 'reject', {
          reason: lengthResult.reason,
          check: 'length',
          duration_ms: Date.now() - startTime
        }, corr)).catch(err => console.warn('[AOCL] L8 reject:', err))
      }

      return result
    }

    if (lengthResult.warnings?.length > 0) {
      warnings.push(...lengthResult.warnings)
    }

    // 2. Content safety check
    const safetyResult = checkContentSafety(response)
    checks.push({ name: 'content-safety', passed: safetyResult.safe })

    if (!safetyResult.safe) {
      const result = {
        valid: false,
        reason: safetyResult.reason,
        checks,
        warnings: []
      }

      if (corr) {
        storeEnvelope(createLayerEvent('L8', 'reject', {
          reason: safetyResult.reason,
          check: 'content-safety',
          duration_ms: Date.now() - startTime
        }, corr)).catch(err => console.warn('[AOCL] L8 reject:', err))
      }

      return result
    }

    if (safetyResult.warnings?.length > 0) {
      warnings.push(...safetyResult.warnings)
    }

    // 3. Consistency check
    const consistencyResult = checkConsistency(response)
    checks.push({ name: 'consistency', passed: consistencyResult.consistent })

    if (consistencyResult.warnings?.length > 0) {
      warnings.push(...consistencyResult.warnings)
    }

    // 4. Hallucination check
    const hallucinationResult = checkHallucination(response, { hasRAG })
    checks.push({ name: 'hallucination', passed: true }) // Always passes, just warns

    if (hallucinationResult.warnings?.length > 0) {
      warnings.push(...hallucinationResult.warnings)
    }

    // 5. Format detection
    const formats = detectFormats(response)
    checks.push({ name: 'format-detection', passed: true, formats })

    // All checks passed
    const result = {
      valid: true,
      checks,
      warnings,
      formats,
      stats: {
        length: response.length,
        wordCount: response.split(/\s+/).length,
        lineCount: response.split('\n').length
      },
      duration_ms: Date.now() - startTime
    }

    // Emit L8 complete event
    if (corr) {
      storeEnvelope(createLayerEvent('L8', 'complete', {
        valid: true,
        checksRun: checks.length,
        warningCount: warnings.length,
        responseLength: response.length,
        formats,
        duration_ms: result.duration_ms
      }, corr)).catch(err => console.warn('[AOCL] L8 complete:', err))
    }

    return result

  } catch (error) {
    console.error('[ResponseVerifier] Error:', error)

    // On error, pass through but log
    const result = {
      valid: true,
      checks,
      warnings: [...warnings, `Verification error: ${error.message}`],
      error: error.message
    }

    if (corr) {
      storeEnvelope(createLayerEvent('L8', 'complete', {
        valid: true,
        error: error.message,
        duration_ms: Date.now() - startTime
      }, corr)).catch(err => console.warn('[AOCL] L8 complete:', err))
    }

    return result
  }
}

/**
 * Quick validation for streaming responses
 * Lighter-weight check for real-time validation
 *
 * @param {string} chunk - Response chunk
 * @returns {{ ok: boolean, warning?: string }}
 */
export function validateChunk(chunk) {
  if (!chunk) return { ok: true }

  // Check for blocked patterns in chunk
  for (const pattern of VERIFY_CONFIG.blockedOutputPatterns) {
    if (pattern.test(chunk)) {
      return {
        ok: false,
        warning: 'Potentially unsafe content detected in stream'
      }
    }
  }

  return { ok: true }
}

export default verifyResponse
