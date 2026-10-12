/**
 * Widget Security Layer (CW-6)
 *
 * Defence-in-depth for public-facing widget traffic.
 * Pure functions — used by both collector (enforcement) and dashboard (configuration UI).
 *
 * Layers:
 *   L1: Rate limiting (config only — enforcement in collector middleware)
 *   L2: Input validation + injection detection
 *   L3: Output filtering (canary, PII, credentials, prompt echo)
 *   L4: Domain allowlist
 */

// ── Rate Limit Configuration ────────────────────────────────────────────────

export const RATE_LIMIT_TIERS = {
  perIp: { windowMs: 60_000, max: 10, key: 'ip+widget_id', description: 'Messages per minute per IP per widget' },
  perSession: { windowMs: 60_000, max: 8, key: 'session_token', description: 'Messages per minute per session' },
  perWidget: { windowMs: 3_600_000, max: 500, key: 'widget_id', description: 'Messages per hour per widget' },
  perOrg: { windowMs: 3_600_000, max: 2000, key: 'org_id', description: 'Messages per hour per org' },
  sessionCreate: { windowMs: 3_600_000, max: 5, key: 'ip', description: 'New sessions per hour per IP' },
  toolCall: { windowMs: 60_000, max: 5, key: 'session+tool', description: 'Tool calls per minute per session' },
}


// ── Injection Detection ─────────────────────────────────────────────────────

export const INJECTION_PATTERNS = [
  // Direct override
  { name: 'ignore_instructions', regex: /ignore\s+(all\s+)?previous\s+instructions/i, severity: 'high' },
  { name: 'override_instructions', regex: /override\s+(your|the|all)\s+(instructions|rules|prompt)/i, severity: 'high' },
  { name: 'forget_instructions', regex: /forget\s+(your|all|previous)\s+(instructions|rules|training)/i, severity: 'high' },

  // Identity manipulation
  { name: 'dan_jailbreak', regex: /\bDAN\b.*\b(do|anything|now)\b/i, severity: 'high' },
  { name: 'you_are_now', regex: /you\s+are\s+now\s+/i, severity: 'medium' },
  { name: 'act_as', regex: /act\s+as\s+(if\s+)?(you\s+)?(are|were)\s+/i, severity: 'medium' },
  { name: 'pretend_to_be', regex: /pretend\s+(to\s+be|you'?re)\s+/i, severity: 'medium' },
  { name: 'developer_mode', regex: /developer\s+mode|maintenance\s+mode|debug\s+mode/i, severity: 'high' },

  // System prompt extraction
  { name: 'reveal_prompt', regex: /reveal\s+(your|the)\s+(instructions|prompt|rules|system)/i, severity: 'high' },
  { name: 'repeat_above', regex: /repeat\s+(everything|all|the\s+text)\s+(above|before|preceding)/i, severity: 'high' },
  { name: 'system_prompt', regex: /system\s*prompt/i, severity: 'medium' },
  { name: 'translate_prompt', regex: /translate\s+(your|the)\s+(system|instructions|prompt)/i, severity: 'medium' },

  // Encoding attacks
  { name: 'base64_decode', regex: /base64\s*(decode|decrypt|decipher)/i, severity: 'medium' },

  // Authority escalation
  { name: 'im_admin', regex: /i'?m\s+(the\s+)?(admin|administrator|developer|owner|root)/i, severity: 'medium' },
  { name: 'emergency_override', regex: /emergency\s+(override|access)|urgent\s+system/i, severity: 'high' },

  // Jailbreak keywords
  { name: 'jailbreak', regex: /\bjailbreak\b/i, severity: 'low' },
]

/**
 * Detect potential injection attempts in visitor input.
 * Returns flagged status, matched patterns, and aggregate score.
 *
 * @param {string} input
 * @returns {{ flagged: boolean, matches: Array<{name, severity}>, score: number }}
 */
export function detectInjection(input) {
  if (!input) return { flagged: false, matches: [], score: 0 }

  const severityWeights = { low: 1, medium: 3, high: 5 }
  const matches = []
  let score = 0

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.regex.test(input)) {
      matches.push({ name: pattern.name, severity: pattern.severity })
      score += severityWeights[pattern.severity] || 1
    }
  }

  return {
    flagged: matches.length > 0,
    matches,
    score,
  }
}


// ── Output Filtering ────────────────────────────────────────────────────────

const CREDENTIAL_PATTERNS = [
  { name: 'api_key', regex: /sk-[a-zA-Z0-9\-_]{20,}/ },
  { name: 'api_key', regex: /\b(password|secret|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9+\/=]{8,}/i },
  { name: 'private_key', regex: /-----BEGIN\s+(RSA\s+|EC\s+)?PRIVATE\s+KEY-----/ },
  { name: 'bearer_token', regex: /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/ },
  { name: 'connection_string', regex: /(?:postgres|mysql|mongodb):\/\/[^\s]+/ },
]

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

/**
 * Filter LLM output for sensitive content before delivering to visitor.
 *
 * @param {string} output — LLM response text
 * @param {object} opts — { canaryToken, visitorInput, systemPromptText }
 * @returns {{ blocked: boolean, filtered: boolean, reason?: string, detections: string[] }}
 */
export function filterOutput(output, { canaryToken, visitorInput, systemPromptText } = {}) {
  if (!output) return { blocked: false, filtered: false, detections: [] }

  const detections = []

  // 1. Canary token detection (prompt extraction confirmed)
  if (canaryToken && output.includes(canaryToken)) {
    return { blocked: true, filtered: true, reason: 'canary token detected — prompt extraction attempt', detections: ['canary'] }
  }

  // 2. Credential patterns
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.regex.test(output)) {
      detections.push(pattern.name)
    }
  }

  // 3. Email addresses NOT from visitor's own input
  const outputEmails = output.match(EMAIL_REGEX) || []
  const visitorEmails = (visitorInput || '').match(EMAIL_REGEX) || []
  const visitorEmailSet = new Set(visitorEmails.map(e => e.toLowerCase()))
  const leakedEmails = outputEmails.filter(e => !visitorEmailSet.has(e.toLowerCase()))
  if (leakedEmails.length > 0) {
    detections.push('email')
  }

  return {
    blocked: false,
    filtered: detections.length > 0,
    detections,
  }
}


// ── Input Validation ────────────────────────────────────────────────────────

/**
 * Validate and sanitise visitor input.
 *
 * @param {string} input
 * @param {object} opts — { maxLength: 2000 }
 * @returns {{ valid: boolean, sanitised: string, error?: string }}
 */
export function validateInput(input, { maxLength = 2000 } = {}) {
  if (!input || typeof input !== 'string') {
    return { valid: false, sanitised: '', error: 'Message is required' }
  }

  // Strip HTML tags
  let sanitised = input.replace(/<[^>]*>/g, '').trim()

  if (sanitised.length === 0) {
    return { valid: false, sanitised: '', error: 'Message is required' }
  }

  if (sanitised.length > maxLength) {
    return { valid: false, sanitised, error: `Message exceeds maximum length of ${maxLength} characters` }
  }

  return { valid: true, sanitised }
}


// ── Domain Allowlist ────────────────────────────────────────────────────────

/**
 * Check if a domain is allowed by the widget's allowlist.
 * Supports wildcards: *.acme.com matches any subdomain.
 * Localhost is always allowed (for development).
 *
 * @param {string} domain — the Origin header's hostname
 * @param {string[]} allowedDomains — configured allowlist
 * @returns {boolean}
 */
export function validateDomain(domain, allowedDomains = []) {
  if (!domain) return false

  // Localhost always allowed (development)
  if (domain === 'localhost' || domain === '127.0.0.1' || domain === '::1') {
    return true
  }

  const normalised = domain.toLowerCase()

  for (const allowed of allowedDomains) {
    const pattern = allowed.toLowerCase()

    // Exact match
    if (pattern === normalised) return true

    // Wildcard match: *.acme.com
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1) // .acme.com
      if (normalised.endsWith(suffix) || normalised === pattern.slice(2)) {
        return true
      }
    }
  }

  return false
}
