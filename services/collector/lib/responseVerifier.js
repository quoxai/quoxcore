/**
 * GOV-E-4: Server-side L8 Response Verifier (CJS)
 *
 * Port of src/services/layers/responseVerifier.js — pure logic, no browser
 * dependencies. Validates AI responses before delivery:
 *   - Length and format validation
 *   - Content safety screening (credential leaks, script injection)
 *   - Consistency checks
 *   - Basic hallucination markers
 *
 * The caller is responsible for emitting AEE envelopes and VOLT events based
 * on the result. This module is pure — it just returns { valid, reason, checks,
 * warnings, formats, stats, duration_ms }.
 */

const VERIFY_CONFIG = {
  // Length limits
  maxResponseLength: 50000,
  minResponseLength: 1,
  warnLongResponse: 10000,

  // Content safety patterns — these BLOCK the response
  blockedOutputPatterns: [
    /\b(password|secret|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{8,}/i,
    /<script[^>]*>[\s\S]*?<\/script>/i,
    /\beval\s*\([^)]*\)/i,
  ],

  // Warning patterns — flag but don't block
  warnOutputPatterns: [
    /\b(I don't know|I'm not sure|I cannot|I can't)\b/i,
    /\b(as an AI|as a language model|I am an AI)\b/i,
    /\b(sudo|chmod|rm -rf|format)\b/i,
  ],

  // Consistency patterns — warnings only
  inconsistencyPatterns: [
    { pattern: /\b(yes|correct|right)\b.*\b(no|incorrect|wrong)\b/i, flag: 'contradictory' },
    { pattern: /\b(always|never)\b.*\b(sometimes|occasionally)\b/i, flag: 'hedging' },
  ],

  // Format detection
  expectedFormats: {
    json: /^\s*[\[{]/,
    markdown: /^#|^\*\*|^-\s/m,
    code: /```[\s\S]*```/,
  },
};

function checkLength(response) {
  const length = response?.length || 0;

  if (length < VERIFY_CONFIG.minResponseLength) {
    return { valid: false, reason: 'Response too short or empty' };
  }
  if (length > VERIFY_CONFIG.maxResponseLength) {
    return {
      valid: false,
      reason: `Response exceeds maximum length (${length} > ${VERIFY_CONFIG.maxResponseLength})`,
    };
  }

  const warnings = [];
  if (length > VERIFY_CONFIG.warnLongResponse) {
    warnings.push(`Long response: ${length} characters`);
  }
  return { valid: true, warnings, length };
}

function checkContentSafety(response) {
  for (const pattern of VERIFY_CONFIG.blockedOutputPatterns) {
    if (pattern.test(response)) {
      return {
        safe: false,
        reason: 'Response contains potentially unsafe content',
        pattern: pattern.toString(),
      };
    }
  }

  const warnings = [];
  for (const pattern of VERIFY_CONFIG.warnOutputPatterns) {
    if (pattern.test(response)) {
      warnings.push(`Flagged content: ${pattern.source.slice(0, 30)}...`);
    }
  }
  return { safe: true, warnings };
}

function checkConsistency(response) {
  const warnings = [];
  for (const { pattern, flag } of VERIFY_CONFIG.inconsistencyPatterns) {
    if (pattern.test(response)) {
      warnings.push(`Potential ${flag} statement detected`);
    }
  }
  return { consistent: true, warnings };
}

function checkHallucination(response, context = {}) {
  const warnings = [];

  const urls = response.match(/https?:\/\/[^\s]+/g) || [];
  if (urls.length > 5) {
    warnings.push(`Many URLs in response (${urls.length}) - verify validity`);
  }

  const datePattern = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/g;
  const dates = response.match(datePattern) || [];
  if (dates.length > 3) {
    warnings.push(`Multiple specific dates mentioned (${dates.length}) - verify accuracy`);
  }

  const citations = response.match(/\[[0-9]+\]|\(et al\.,?\s*\d{4}\)/g) || [];
  if (citations.length > 0 && !context.hasRAG) {
    warnings.push('Citations present without RAG context - may be fabricated');
  }

  if (/\b(will definitely|guaranteed to|certain to|100% will)\b/i.test(response)) {
    warnings.push('Overly confident future prediction detected');
  }

  return { warnings };
}

function detectFormats(response) {
  const formats = [];
  for (const [format, pattern] of Object.entries(VERIFY_CONFIG.expectedFormats)) {
    if (pattern.test(response)) formats.push(format);
  }
  return formats;
}

/**
 * Main response verification.
 *
 * @param {string} response - AI response to verify
 * @param {object} context - { query, agent, corr, hasRAG }
 * @returns {Promise<{
 *   valid: boolean,
 *   reason?: string,
 *   checks: Array<{ name: string, passed: boolean }>,
 *   warnings: string[],
 *   formats?: string[],
 *   stats?: { length, wordCount, lineCount },
 *   duration_ms: number,
 *   error?: string
 * }>}
 */
async function verifyResponse(response, context = {}) {
  const startTime = Date.now();
  const checks = [];
  const warnings = [];

  try {
    // Handle null/undefined/empty
    if (!response) {
      return {
        valid: false,
        reason: 'Empty response',
        checks: [{ name: 'length', passed: false }],
        warnings: [],
        duration_ms: Date.now() - startTime,
      };
    }

    // 1. Length
    const lengthResult = checkLength(response);
    checks.push({ name: 'length', passed: lengthResult.valid });
    if (!lengthResult.valid) {
      return {
        valid: false,
        reason: lengthResult.reason,
        checks,
        warnings: [],
        duration_ms: Date.now() - startTime,
      };
    }
    if (lengthResult.warnings?.length) warnings.push(...lengthResult.warnings);

    // 2. Content safety
    const safetyResult = checkContentSafety(response);
    checks.push({ name: 'content-safety', passed: safetyResult.safe });
    if (!safetyResult.safe) {
      return {
        valid: false,
        reason: safetyResult.reason,
        checks,
        warnings: [],
        duration_ms: Date.now() - startTime,
      };
    }
    if (safetyResult.warnings?.length) warnings.push(...safetyResult.warnings);

    // 3. Consistency (warnings only)
    const consistencyResult = checkConsistency(response);
    checks.push({ name: 'consistency', passed: consistencyResult.consistent });
    if (consistencyResult.warnings?.length) warnings.push(...consistencyResult.warnings);

    // 4. Hallucination (warnings only)
    const hallucinationResult = checkHallucination(response, { hasRAG: context.hasRAG });
    checks.push({ name: 'hallucination', passed: true });
    if (hallucinationResult.warnings?.length) warnings.push(...hallucinationResult.warnings);

    // 5. Format detection
    const formats = detectFormats(response);
    checks.push({ name: 'format-detection', passed: true, formats });

    return {
      valid: true,
      checks,
      warnings,
      formats,
      stats: {
        length: response.length,
        wordCount: response.split(/\s+/).filter(Boolean).length,
        lineCount: response.split('\n').length,
      },
      duration_ms: Date.now() - startTime,
    };
  } catch (error) {
    console.error('[ResponseVerifier] Error:', error.message);
    // Fail-open for verifier errors (matches frontend behavior) — log and pass through.
    // Block-level failures (credential leaks) already handled above before we reach catch.
    return {
      valid: true,
      checks,
      warnings: [...warnings, `Verification error: ${error.message}`],
      error: error.message,
      duration_ms: Date.now() - startTime,
    };
  }
}

/**
 * Lightweight validation for streaming chunks.
 *
 * @param {string} chunk
 * @returns {{ ok: boolean, warning?: string }}
 */
function validateChunk(chunk) {
  if (!chunk) return { ok: true };
  for (const pattern of VERIFY_CONFIG.blockedOutputPatterns) {
    if (pattern.test(chunk)) {
      return { ok: false, warning: 'Potentially unsafe content detected in stream' };
    }
  }
  return { ok: true };
}

module.exports = {
  verifyResponse,
  validateChunk,
  VERIFY_CONFIG,
};
