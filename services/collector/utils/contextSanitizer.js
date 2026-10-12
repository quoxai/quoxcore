/**
 * Context Sanitizer for Backend (Node.js)
 * Security fix for issue #71 - Indirect Prompt Injection Prevention
 *
 * Backend version of context sanitization to provide defense-in-depth.
 * This complements the frontend sanitization in src/services/contextSanitizer.js
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Maximum lengths (characters) for different context sections
  maxLengths: {
    memoryContext: 8000,
    dynamicContext: 6000,
    systemPrompt: 10000,
    totalContext: 20000
  },

  // Injection pattern detection
  injectionPatterns: [
    // Direct instruction attempts
    /\b(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior|earlier)\s+(instructions?|context|rules?|constraints?)/gi,
    /\b(new|updated|revised)\s+(instructions?|rules?|directives?|commands?)\b/gi,
    /\b(system|admin|root)\s*(:|prompt|message|instruction)/gi,

    // Role/identity manipulation
    /\byou\s+are\s+(now|actually|really)\b/gi,
    /\b(pretend|act|behave)\s+(like|as\s+if)\s+you('re|are)/gi,
    /\bassume\s+(the\s+)?role\s+of\b/gi,
    /\b(override|bypass|disable)\s+(safety|security|filter|restriction)/gi,

    // Delimiter manipulation
    /```(system|admin|root|instruction)/gi,
    /\[\/?(system|admin|instruction)\]/gi,
    /<\/?(system|instruction|admin)>/gi,
    /={3,}\s*(system|end|start|begin)/gi,

    // Jailbreak patterns
    /\bDAN\s*(mode|prompt)?\b/gi,
    /\bdeveloper\s+mode\b/gi,
    /\bjailbreak\b/gi,
    /\bunlock\s+(full|all)\s+(capabilities|features|access)/gi,

    // Hidden instruction markers
    /\[INST\]/gi,
    /<<SYS>>/gi,
    /\[\/INST\]/gi,
    /<<\/SYS>>/gi,
    /###\s*(Human|Assistant|System|User):/gi
  ],

  // Suspicious Unicode patterns
  suspiciousUnicode: [
    /[\u200B-\u200F\u2028-\u202F\uFEFF]/g  // Zero-width and invisible chars
  ]
};

// ============================================================================
// SANITIZATION FUNCTIONS
// ============================================================================

/**
 * Sanitize a content string
 * @param {string} content - Content to sanitize
 * @param {object} options - Sanitization options
 * @returns {{ sanitized: string, warnings: string[], suspicious: boolean }}
 */
function sanitizeContent(content, options = {}) {
  const {
    maxLength = CONFIG.maxLengths.memoryContext,
    context = 'unknown'
  } = options;

  if (!content || typeof content !== 'string') {
    return { sanitized: '', warnings: [], suspicious: false };
  }

  const warnings = [];
  let sanitized = content;
  let suspicious = false;

  // 1. Remove invisible/zero-width characters
  for (const pattern of CONFIG.suspiciousUnicode) {
    if (pattern.test(sanitized)) {
      warnings.push(`Removed suspicious Unicode characters (${context})`);
      sanitized = sanitized.replace(pattern, '');
      suspicious = true;
    }
    pattern.lastIndex = 0;
  }

  // 2. Detect and escape injection patterns
  for (const pattern of CONFIG.injectionPatterns) {
    if (pattern.test(sanitized)) {
      warnings.push(`Detected potential injection pattern in ${context}`);
      sanitized = sanitized.replace(pattern, (match) => `[FILTERED: ${match.substring(0, 20)}...]`);
      suspicious = true;
    }
    pattern.lastIndex = 0;
  }

  // 3. Escape delimiter-like patterns
  sanitized = sanitized.replace(/={3,}/g, '---');
  sanitized = sanitized.replace(/```(system|admin|root|instruction)/gi, '```code');

  // 4. Normalize excessive whitespace
  sanitized = sanitized.replace(/\n{4,}/g, '\n\n\n');
  sanitized = sanitized.replace(/\s{10,}/g, '    ');

  // 5. Truncate if exceeding length limit
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength - 50) + '\n...[content truncated for safety]';
    warnings.push(`Content truncated from ${content.length} to ${maxLength} chars (${context})`);
  }

  return { sanitized, warnings, suspicious };
}

/**
 * Detect anomalies in content
 * @param {string} content - Content to analyze
 * @returns {{ anomalies: object, score: number, suspicious: boolean }}
 */
function detectAnomalies(content) {
  if (!content || typeof content !== 'string') {
    return { anomalies: {}, score: 0, suspicious: false };
  }

  const anomalies = {};
  let score = 0;

  // Count injection patterns
  let injectionPatternCount = 0;
  for (const pattern of CONFIG.injectionPatterns) {
    const matches = content.match(pattern);
    if (matches) {
      injectionPatternCount += matches.length;
    }
    pattern.lastIndex = 0;
  }
  if (injectionPatternCount >= 2) {
    anomalies.injectionPatterns = injectionPatternCount;
    score += injectionPatternCount * 10;
  }

  // Check for excessive repetition
  const words = content.toLowerCase().split(/\s+/);
  if (words.length > 50) {
    const uniqueWords = new Set(words);
    const repetitionRatio = 1 - (uniqueWords.size / words.length);
    if (repetitionRatio > 0.3) {
      anomalies.repetition = { ratio: repetitionRatio };
      score += 15;
    }
  }

  // Check URL density
  const urlPattern = /https?:\/\/[^\s]+/gi;
  const urls = content.match(urlPattern) || [];
  const urlDensity = urls.join('').length / content.length;
  if (urlDensity > 0.1) {
    anomalies.urlDensity = { count: urls.length, density: urlDensity };
    score += 10;
  }

  // Check for base64-encoded content
  const base64Pattern = /[A-Za-z0-9+/]{50,}={0,2}/g;
  const base64Matches = content.match(base64Pattern) || [];
  if (base64Matches.length > 0) {
    anomalies.base64Content = { count: base64Matches.length };
    score += 15;
  }

  return {
    anomalies,
    score,
    suspicious: score >= 20 || Object.keys(anomalies).length >= 2
  };
}

/**
 * Sanitize a chat context object
 * @param {object} contextData - Context data from request
 * @returns {{ sanitized: object, warnings: string[], suspicious: boolean }}
 */
function sanitizeChatContext(contextData) {
  const warnings = [];
  let suspicious = false;
  const sanitized = { ...contextData };

  // Sanitize memory_context
  if (contextData.memory_context) {
    const result = sanitizeContent(contextData.memory_context, {
      maxLength: CONFIG.maxLengths.memoryContext,
      context: 'memory_context'
    });
    sanitized.memory_context = result.sanitized;
    warnings.push(...result.warnings);
    suspicious = suspicious || result.suspicious;
  }

  // Sanitize quox_context
  if (contextData.quox_context) {
    const result = sanitizeContent(contextData.quox_context, {
      maxLength: CONFIG.maxLengths.dynamicContext,
      context: 'quox_context'
    });
    sanitized.quox_context = result.sanitized;
    warnings.push(...result.warnings);
    suspicious = suspicious || result.suspicious;
  }

  // Sanitize system_prompt
  if (contextData.system_prompt) {
    const result = sanitizeContent(contextData.system_prompt, {
      maxLength: CONFIG.maxLengths.systemPrompt,
      context: 'system_prompt'
    });
    sanitized.system_prompt = result.sanitized;
    warnings.push(...result.warnings);
    suspicious = suspicious || result.suspicious;
  }

  // Run anomaly detection on combined context
  const combinedContext = [
    contextData.memory_context,
    contextData.quox_context,
    contextData.system_prompt
  ].filter(Boolean).join('\n');

  const anomalyResult = detectAnomalies(combinedContext);
  if (anomalyResult.suspicious) {
    suspicious = true;
    warnings.push(`Anomaly detection flagged context: score=${anomalyResult.score}`);
  }

  return { sanitized, warnings, suspicious, anomalies: anomalyResult.anomalies };
}

/**
 * Log context sanitization for audit
 * @param {object} result - Sanitization result
 * @param {string} queryId - Query ID for correlation
 */
function logSanitizationAudit(result, queryId) {
  if (result.suspicious || result.warnings.length > 0) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      queryId,
      suspicious: result.suspicious,
      warningsCount: result.warnings.length,
      warnings: result.warnings.slice(0, 5), // Limit logged warnings
      anomalies: result.anomalies || {}
    };

    if (result.suspicious) {
      console.warn('[ContextSanitizer] Suspicious context detected:', JSON.stringify(logEntry));
    } else {
      console.log('[ContextSanitizer] Context sanitized:', JSON.stringify(logEntry));
    }
  }
}

module.exports = {
  sanitizeContent,
  detectAnomalies,
  sanitizeChatContext,
  logSanitizationAudit,
  CONFIG
};
