/**
 * Regex-based Intent Classifier
 *
 * Extends the base IntentClassifier with regex pattern matching
 * and confidence scoring based on pattern specificity.
 */

import { IntentClassifier, createResult, noMatch } from './intentClassifier.js'
import { getIntentThreshold, getIntentRiskLevel, RISK_LEVELS } from './routerConfig.js'

/**
 * Pattern definition with metadata for confidence scoring
 * @typedef {Object} PatternDefinition
 * @property {string} name - Intent name
 * @property {RegExp} regex - The regex pattern
 * @property {string} description - Human-readable description
 * @property {number} [specificity] - Manual specificity override (0-1)
 * @property {string[]} [requiredWords] - Words that must be present
 * @property {string[]} [excludeWords] - Words that indicate false positive
 * @property {boolean} [anchoredStart] - Pattern must match start of query
 * @property {boolean} [anchoredEnd] - Pattern must match end of query
 */

/**
 * Common words that reduce confidence when matched as "hostnames" or entities
 */
const COMMON_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
  'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'also',
  'now', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'any', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her',
  'its', 'our', 'their', 'what', 'which', 'who', 'whom', 'whose',
  'me', 'you', 'him', 'her', 'it', 'us', 'them', 'i', 'we', 'they',
  'if', 'then', 'else', 'because', 'although', 'unless', 'until', 'while'
])

/**
 * Phrases that indicate a query is conversational, not a command
 * These reduce confidence for pattern matches
 */
const CONVERSATIONAL_PHRASES = [
  // Polite requests that usually need Claude's understanding
  /^can you\s+/i,
  /^could you\s+/i,
  /^would you\s+/i,
  /^will you\s+/i,
  /^please\s+/i,
  /^i want to\s+/i,
  /^i need to\s+/i,
  /^i('m| am)\s+/i,
  /^i would like\s+/i,
  /^i'd like\s+/i,
  // Help requests
  /^help me\s+/i,
  /^help with\s+/i,
  /^assist me\s+/i,
  /^show me how\s+/i,
  /^teach me\s+/i,
  /^explain\s+/i,
  // Questions (these need Claude's reasoning)
  /\?$/,
  /^how\s+(do|can|should|would|does)\s+/i,
  /^what\s+(is|are|does|should|would|can)\s+/i,
  /^why\s+(is|are|does|do|should|would)\s+/i,
  /^when\s+(should|do|does|is|are)\s+/i,
  /^where\s+(is|are|do|does|should)\s+/i,
  /^who\s+(is|are|should|can|does)\s+/i,
  // Thinking/reasoning indicators
  /^i think\s+/i,
  /^i believe\s+/i,
  /^i wonder\s+/i,
  /^do you think\s+/i,
  /^is it possible\s+/i,
  /^is there a way\s+/i,
  // Comparison/analysis
  /^compare\s+/i,
  /^analyze\s+/i,
  /^evaluate\s+/i,
  /^what('s| is) the difference\s+/i,
  /^should i\s+/i,
]

/**
 * Regex-based classifier with confidence scoring
 */
export class RegexClassifier extends IntentClassifier {
  constructor(options = {}) {
    super('regex', options)
    this.patterns = []
    this.patternSpecificities = new Map()
  }

  /**
   * Add a pattern with metadata
   * @param {PatternDefinition} pattern
   */
  addPattern(pattern) {
    this.patterns.push(pattern)

    // Calculate and cache specificity
    const specificity = pattern.specificity ?? this._calculateSpecificity(pattern)
    this.patternSpecificities.set(pattern.name, specificity)

    // Also register as intent
    this.registerIntent({
      name: pattern.name,
      description: pattern.description,
      riskLevel: getIntentRiskLevel(pattern.name)
    })
  }

  /**
   * Add multiple patterns
   * @param {PatternDefinition[]} patterns
   */
  addPatterns(patterns) {
    for (const pattern of patterns) {
      this.addPattern(pattern)
    }
  }

  /**
   * Calculate pattern specificity (0-1)
   * More specific patterns = higher confidence when matched
   */
  _calculateSpecificity(pattern) {
    const regex = pattern.regex
    const source = regex.source

    let score = 0.5 // Base score

    // Anchored patterns are more specific
    if (source.startsWith('^') || pattern.anchoredStart) score += 0.1
    if (source.endsWith('$') || pattern.anchoredEnd) score += 0.1

    // Longer patterns are generally more specific
    const nonMetaLength = source.replace(/[\\()[\]{}|*+?.^$]/g, '').length
    score += Math.min(0.15, nonMetaLength / 100)

    // Word boundaries increase specificity
    const wordBoundaries = (source.match(/\\b/g) || []).length
    score += Math.min(0.1, wordBoundaries * 0.02)

    // Literal strings (not just wildcards) increase specificity
    const literals = source.match(/[a-z]{3,}/gi) || []
    score += Math.min(0.1, literals.length * 0.02)

    // Required words increase specificity
    if (pattern.requiredWords?.length > 0) {
      score += Math.min(0.1, pattern.requiredWords.length * 0.03)
    }

    // Capture groups can reduce specificity (more flexible matching)
    const captureGroups = (source.match(/\([^?]/g) || []).length
    score -= Math.min(0.1, captureGroups * 0.02)

    // Wildcards reduce specificity
    const wildcards = (source.match(/\.\*|\.\+|\[^\\]\]\+/g) || []).length
    score -= Math.min(0.15, wildcards * 0.05)

    return Math.max(0.2, Math.min(1.0, score))
  }

  /**
   * Calculate match confidence
   * @param {string} query
   * @param {PatternDefinition} pattern
   * @param {RegExpMatchArray} match
   * @returns {number}
   */
  _calculateMatchConfidence(query, pattern, match) {
    const baseSpecificity = this.patternSpecificities.get(pattern.name) || 0.5
    let confidence = baseSpecificity

    // Match coverage: what percentage of the query was matched?
    const matchLength = match[0].length
    const queryLength = query.trim().length
    const coverage = matchLength / queryLength

    // Full match = higher confidence
    if (coverage > 0.9) {
      confidence += 0.15
    } else if (coverage > 0.7) {
      confidence += 0.1
    } else if (coverage < 0.3) {
      confidence -= 0.1
    }

    // Check for required words
    if (pattern.requiredWords) {
      const queryLower = query.toLowerCase()
      const hasAllRequired = pattern.requiredWords.every(w =>
        queryLower.includes(w.toLowerCase())
      )
      if (!hasAllRequired) {
        confidence -= 0.2
      }
    }

    // Check for exclude words (false positive indicators)
    if (pattern.excludeWords) {
      const queryLower = query.toLowerCase()
      const hasExcluded = pattern.excludeWords.some(w =>
        queryLower.includes(w.toLowerCase())
      )
      if (hasExcluded) {
        confidence -= 0.3
      }
    }

    // Penalty for conversational phrases
    for (const phrase of CONVERSATIONAL_PHRASES) {
      if (phrase.test(query)) {
        confidence -= 0.15
        break
      }
    }

    // Check captured groups for common words (false positive indicator)
    for (let i = 1; i < match.length; i++) {
      const captured = match[i]?.toLowerCase()
      if (captured && COMMON_WORDS.has(captured)) {
        confidence -= 0.2
        break
      }
    }

    // Boost for exact known patterns
    const queryLower = query.toLowerCase().trim()
    const exactMatches = {
      'quoxagent status': 'fleet_status',
      'fleet status': 'fleet_status',
      'agent status': 'fleet_status',
      'list hosts': 'list_hosts',
      'show hosts': 'list_hosts',
      'list agents': 'list_agents',
      'show agents': 'list_agents',
      'what is quox': 'what_is_quox',
      'who are you': 'who_are_you',
      'what can you do': 'capabilities',
      'help': 'help_query',
      'hello': 'greeting',
      'hi': 'greeting',
      'good morning': 'greeting',
      'good afternoon': 'greeting',
      'good evening': 'greeting'
    }

    if (exactMatches[queryLower] === pattern.name) {
      confidence = Math.max(confidence, 0.95)
    }

    return Math.max(0, Math.min(1, confidence))
  }

  /**
   * Classify a query using regex patterns
   * @param {string} query
   * @param {Object} context
   * @returns {Promise<ClassificationResult>}
   */
  async classify(query, context = {}) {
    const trimmedQuery = query.trim()

    if (!trimmedQuery) {
      return noMatch('regex')
    }

    const matches = []

    // Test all patterns
    for (const pattern of this.patterns) {
      const match = trimmedQuery.match(pattern.regex)
      if (match) {
        const confidence = this._calculateMatchConfidence(trimmedQuery, pattern, match)
        matches.push({
          pattern,
          match,
          confidence
        })
      }
    }

    if (matches.length === 0) {
      return noMatch('regex')
    }

    // Sort by confidence descending
    matches.sort((a, b) => b.confidence - a.confidence)

    const best = matches[0]

    // If multiple patterns matched, might indicate ambiguity
    if (matches.length > 1) {
      // Reduce confidence if top two are close
      const gap = best.confidence - matches[1].confidence
      if (gap < 0.1) {
        best.confidence -= 0.1
      }
    }

    // Build alternatives from other matches
    const alternatives = matches.slice(1, 4).map(m => ({
      intent: m.pattern.name,
      confidence: m.confidence
    }))

    return createResult(
      best.pattern.name,
      best.confidence,
      'regex',
      {
        matchedText: best.match[0],
        captureGroups: best.match.slice(1),
        patternSpecificity: this.patternSpecificities.get(best.pattern.name),
        matchCount: matches.length
      },
      alternatives
    )
  }

  /**
   * Get all patterns
   * @returns {PatternDefinition[]}
   */
  getPatterns() {
    return [...this.patterns]
  }

  /**
   * Get pattern by name
   * @param {string} name
   * @returns {PatternDefinition|undefined}
   */
  getPattern(name) {
    return this.patterns.find(p => p.name === name)
  }
}

/**
 * Create a regex classifier from existing ROUTER_PATTERNS array
 * @param {Array} routerPatterns - Array of { name, regex, description, handler }
 * @returns {RegexClassifier}
 */
export function createFromRouterPatterns(routerPatterns) {
  const classifier = new RegexClassifier()

  for (const rp of routerPatterns) {
    classifier.addPattern({
      name: rp.name,
      regex: rp.regex,
      description: rp.description,
      // Add exclude words for known problematic patterns
      excludeWords: getExcludeWordsForPattern(rp.name),
      requiredWords: getRequiredWordsForPattern(rp.name)
    })
  }

  return classifier
}

/**
 * Get exclude words for known problematic patterns
 * These words, when present in the query, indicate a false positive
 */
function getExcludeWordsForPattern(patternName) {
  const excludeMap = {
    // health_check pattern is very greedy - "check X" matches almost anything
    // Exclude common conversational and non-host-check uses
    health_check: [
      // Conversational uses of "check"
      'email', 'understanding', 'documentation', 'updates',
      'progress', 'out', 'double', 'logs', 'time', 'spelling',
      'grammar', 'work', 'code', 'syntax', 'logic', 'math',
      'calculation', 'answer', 'solution', 'homework', 'assignment',
      // Phrases that use "check" but aren't health checks
      'check if', 'check whether', 'check that', 'check my',
      'check this', 'check the', 'check for', 'check on the',
      'double check', 'fact check', 'sanity check', 'reality check',
      // Other false positive triggers
      'please check', 'can you check', 'could you check',
      'i want to check', 'need to check', 'trying to check',
      'weather', 'inbox', 'schedule', 'calendar', 'meeting',
      'balance', 'account', 'password', 'settings', 'configuration',
      // Question patterns
      'how to check', 'what to check', 'when to check', 'why check'
    ],
    // host_details should only match actual host queries
    host_details: [
      'weather', 'status of my', 'meaning of', 'definition of',
      'tell me about the', 'what does', 'how does', 'why does',
      'explain', 'describe', 'discuss'
    ],
    // memory_search shouldn't match destructive operations
    memory_search: [
      'erase', 'delete', 'remove', 'clear', 'forget', 'wipe'
    ],
    // what_is_quox should only match Quox-specific queries
    what_is_quox: [
      'docker', 'kubernetes', 'linux', 'windows', 'python',
      'javascript', 'programming', 'the meaning', 'the definition'
    ],
    // who_are_you should be more specific
    who_are_you: [
      'built', 'made', 'created', 'designed', 'developed',
      'company', 'founder', 'ceo', 'team'
    ],
    // install_quoxagent needs to be careful
    install_quoxagent: [
      'how to', 'tutorial', 'guide', 'documentation', 'docs',
      'learn', 'understand', 'explain'
    ]
  }
  return excludeMap[patternName] || []
}

/**
 * Get required words for patterns
 * At least one of these words must be present for a match
 */
function getRequiredWordsForPattern(patternName) {
  const requiredMap = {
    // Must mention quoxagent specifically
    install_quoxagent: ['quoxagent', 'mha'],
    // Must mention status
    fleet_status: ['status'],
    // Must mention quox in some form
    what_is_quox: ['quox'],
    // Memory searches should have memory-related terms
    memory_search: ['remember', 'memory', 'recall', 'stored', 'saved', 'know']
  }
  return requiredMap[patternName] || []
}

export default {
  RegexClassifier,
  createFromRouterPatterns
}
