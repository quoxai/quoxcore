/**
 * Quox Style Learning Engine (Phase 8)
 *
 * Learns HOW users communicate, not just WHAT they say.
 * Adapts responses based on learned communication style.
 *
 * Key capabilities:
 * - Analyze user message style (formality, verbosity, technicality)
 * - Track behavior patterns (timing, interaction, content)
 * - Build personalization profiles
 * - Adapt response formatting automatically
 *
 * TIERED: Style Engine is a Premium feature
 */

import { getMemoryManager } from './memoryManager'
import { hasFeature, createUpgradePrompt } from './memoryTier'

// ============================================================================
// TIER GATING
// ============================================================================

/**
 * Check if Style Engine is available (Premium only)
 * @returns {{ available: boolean, upgrade?: object }}
 */
export function isStyleEngineAvailable() {
  const available = hasFeature('hasStyleEngine')
  if (!available) {
    return {
      available: false,
      upgrade: createUpgradePrompt('styleEngine')
    }
  }
  return { available: true }
}

/**
 * Tier-gated wrapper - returns empty/default if plugin not purchased
 * @param {Function} fn - Function to wrap
 * @param {*} defaultReturn - Default return value for free version
 */
function tierGate(fn, defaultReturn) {
  return function gated(...args) {
    if (!hasFeature('hasStyleEngine')) {
      console.log('[StyleEngine] Feature requires Advanced Memory Plugin')
      return defaultReturn
    }
    return fn.apply(this, args)
  }
}

// ============================================================================
// 8.1 Style Dimensions
// ============================================================================

export const STYLE_DIMENSIONS = {
  formality: { range: [0, 1], default: 0.5, weight: 1.0 },      // casual to formal
  verbosity: { range: [0, 1], default: 0.5, weight: 1.0 },      // concise to detailed
  technicality: { range: [0, 1], default: 0.5, weight: 1.0 },   // simple to technical
  emotionality: { range: [0, 1], default: 0.3, weight: 0.8 },   // neutral to expressive
  directness: { range: [0, 1], default: 0.7, weight: 0.9 },     // indirect to direct
  questionStyle: { range: [0, 1], default: 0.5, weight: 0.7 }   // broad to specific
}

// Style signal patterns for detection
const STYLE_PATTERNS = {
  // Formality indicators
  informal: {
    patterns: [
      /\b(gonna|wanna|gotta|kinda|sorta|ya|yep|nope|dunno)\b/gi,
      /\b(lol|lmao|omg|btw|imo|imho|tbh|ngl)\b/gi,
      /[!]{2,}/g,
      /[\u{1F300}-\u{1F9FF}]/gu  // Emojis
    ],
    weight: -0.15
  },
  formal: {
    patterns: [
      /\b(please|kindly|would you|could you|I would appreciate)\b/gi,
      /\b(regarding|concerning|with respect to|pertaining to)\b/gi,
      /\b(therefore|furthermore|moreover|consequently)\b/gi,
      /^(Dear|Hello|Good morning|Good afternoon)/i
    ],
    weight: 0.15
  },

  // Verbosity indicators
  concise: {
    patterns: [
      /^[^.!?]{1,50}[.!?]?$/,  // Short messages
      /^\s*\S+\s*$/             // Single word
    ],
    weight: -0.2
  },
  detailed: {
    patterns: [
      /\b(specifically|in detail|comprehensive|thorough|explain)\b/gi,
      /\b(for example|such as|including|additionally)\b/gi
    ],
    weight: 0.15
  },

  // Technicality indicators
  technical: {
    patterns: [
      /```[\s\S]*?```/g,                          // Code blocks
      /`[^`]+`/g,                                  // Inline code
      /\b[A-Z]{2,}[0-9]*\b/g,                     // Acronyms
      /\b(API|HTTP|SSH|DNS|VM|CPU|RAM|SSD|YAML|JSON|CLI)\b/gi,
      /\b(docker|kubernetes|nginx|proxmox|prometheus|grafana)\b/gi,
      /\b(function|class|method|parameter|argument|variable)\b/gi
    ],
    weight: 0.12
  },
  nonTechnical: {
    patterns: [
      /\b(thing|stuff|thingy|whatchamacallit)\b/gi,
      /\b(make it work|fix it|help me)\b/gi
    ],
    weight: -0.1
  },

  // Emotionality indicators
  expressive: {
    patterns: [
      /[!]{1,}/g,
      /[?]{2,}/g,
      /\b(love|hate|amazing|terrible|awesome|awful|great|horrible)\b/gi,
      /\b(excited|frustrated|confused|happy|annoyed)\b/gi,
      /[\u{1F300}-\u{1F9FF}]/gu
    ],
    weight: 0.15
  },
  neutral: {
    patterns: [
      /^[^!?]*\.$/,  // Ends with period only
    ],
    weight: -0.05
  },

  // Directness indicators
  direct: {
    patterns: [
      /^(do|show|list|get|run|check|install|delete|stop|start)\b/i,
      /\b(now|immediately|asap|quickly)\b/gi
    ],
    weight: 0.15
  },
  indirect: {
    patterns: [
      /\b(maybe|perhaps|might|could|would|possibly|I think)\b/gi,
      /\b(if possible|when you get a chance|no rush)\b/gi
    ],
    weight: -0.12
  }
}

// Learning rate for profile updates
const LEARNING_RATE = 0.15
const MIN_OBSERVATIONS = 5
import { personalGet, personalSet } from './orgScopedStorage'
import { getMemoryClient } from './memoryClient'

// QMH2-CONSOLIDATION: style profile + behavior patterns used to also
// auto-sync to auth-service preferences JSON (org_memberships.preferences_json,
// via personalSet's ORG_NAMESPACE_MAP lookup for both 'style' and 'behavior')
// — the WRONG store, and as two separate round-trips. Both now write through
// as a single combined blob {profile, behavior} to the memory service's
// identity_blobs store (namespace 'style'); the auth-prefs duplication
// (ORG_NAMESPACE_MAP 'style'/'behavior' entries) is retired.
const memoryClient = getMemoryClient()
const STYLE_NAMESPACE = 'style'

// ============================================================================
// 8.1 Style Learning System
// ============================================================================

/**
 * Analyze message style and extract style signals
 * @param {string} text - User message
 * @returns {object} Style signals with confidence
 */
export function analyzeMessageStyle(text) {
  if (!text || typeof text !== 'string') {
    return { signals: {}, confidence: 0 }
  }

  const signals = {}
  let matchCount = 0

  // Initialize signals with defaults
  for (const dim of Object.keys(STYLE_DIMENSIONS)) {
    signals[dim] = STYLE_DIMENSIONS[dim].default
  }

  // Calculate message length-based verbosity
  const wordCount = text.split(/\s+/).length
  if (wordCount < 5) {
    signals.verbosity = Math.max(0, signals.verbosity - 0.3)
  } else if (wordCount < 15) {
    signals.verbosity = Math.max(0, signals.verbosity - 0.1)
  } else if (wordCount > 50) {
    signals.verbosity = Math.min(1, signals.verbosity + 0.2)
  } else if (wordCount > 100) {
    signals.verbosity = Math.min(1, signals.verbosity + 0.35)
  }

  // Analyze style patterns
  for (const [category, { patterns, weight }] of Object.entries(STYLE_PATTERNS)) {
    for (const pattern of patterns) {
      const matches = text.match(pattern)
      if (matches) {
        matchCount += matches.length

        // Apply weight to appropriate dimension
        if (category === 'informal' || category === 'formal') {
          signals.formality = clamp(signals.formality + weight * matches.length, 0, 1)
        } else if (category === 'concise' || category === 'detailed') {
          signals.verbosity = clamp(signals.verbosity + weight * Math.min(matches.length, 3), 0, 1)
        } else if (category === 'technical' || category === 'nonTechnical') {
          signals.technicality = clamp(signals.technicality + weight * Math.min(matches.length, 5), 0, 1)
        } else if (category === 'expressive' || category === 'neutral') {
          signals.emotionality = clamp(signals.emotionality + weight * Math.min(matches.length, 4), 0, 1)
        } else if (category === 'direct' || category === 'indirect') {
          signals.directness = clamp(signals.directness + weight * Math.min(matches.length, 3), 0, 1)
        }
      }
    }
  }

  // Question style: specific vs broad
  const hasSpecificTerms = /\b(exactly|specifically|precisely|how many|what is the)\b/i.test(text)
  const hasBroadTerms = /\b(generally|overall|about|roughly|explain|describe)\b/i.test(text)

  if (hasSpecificTerms) signals.questionStyle = Math.min(1, signals.questionStyle + 0.2)
  if (hasBroadTerms) signals.questionStyle = Math.max(0, signals.questionStyle - 0.15)

  // Calculate confidence based on signal strength
  const confidence = Math.min(1, matchCount / 10)

  return {
    signals,
    confidence,
    raw: {
      wordCount,
      matchCount,
      hasCode: /```|`[^`]+`/.test(text),
      hasEmoji: /[\u{1F300}-\u{1F9FF}]/u.test(text),
      sentenceCount: (text.match(/[.!?]+/g) || []).length
    }
  }
}

/**
 * Update style profile with new observations
 * TIERED: Requires Advanced Memory Plugin - free version returns unchanged profile
 * @param {object} styleSignals - Signals from analyzeMessageStyle
 * @param {object} currentProfile - Current profile (optional, will load if not provided)
 * @returns {object} Updated profile
 */
export function updateStyleProfile(styleSignals, currentProfile = null) {
  // TIER CHECK: Style learning requires Premium
  if (!hasFeature('hasStyleEngine')) {
    return currentProfile || loadStyleProfile() // Return unchanged
  }

  const profile = currentProfile || loadStyleProfile()

  // Update each dimension using exponential moving average
  for (const [dim, value] of Object.entries(styleSignals.signals || {})) {
    if (profile.style[dim] !== undefined) {
      // EMA: new_value = old_value * (1 - alpha) + observation * alpha
      const alpha = LEARNING_RATE * (styleSignals.confidence || 0.5)
      profile.style[dim] = profile.style[dim] * (1 - alpha) + value * alpha
    }
  }

  // Update metadata
  profile.observationCount = (profile.observationCount || 0) + 1
  profile.lastUpdated = new Date().toISOString()

  // Calculate overall confidence
  profile.confidenceScore = Math.min(1, profile.observationCount / 50)

  // Track recent observations for shift detection
  if (!profile.recentObservations) profile.recentObservations = []
  profile.recentObservations.push({
    timestamp: Date.now(),
    signals: styleSignals.signals
  })
  // Keep only last 20 observations
  if (profile.recentObservations.length > 20) {
    profile.recentObservations = profile.recentObservations.slice(-20)
  }

  // Save profile
  saveStyleProfile(profile)

  return profile
}

/**
 * Get current style profile
 * @returns {object} Style profile
 */
export function getStyleProfile() {
  return loadStyleProfile()
}

/**
 * Detect if user has shifted their communication style
 * @param {Array} recentMessages - Recent user messages
 * @returns {{ shifted: boolean, direction: object, magnitude: number }}
 */
export function detectStyleShift(recentMessages = []) {
  if (recentMessages.length < 3) {
    return { shifted: false, magnitude: 0 }
  }

  const profile = loadStyleProfile()
  const recent = recentMessages.slice(-5)

  // Analyze recent messages
  const recentSignals = recent.map(msg => analyzeMessageStyle(msg).signals)

  // Calculate average recent style
  const avgRecent = {}
  for (const dim of Object.keys(STYLE_DIMENSIONS)) {
    avgRecent[dim] = recentSignals.reduce((sum, s) => sum + (s[dim] || 0.5), 0) / recentSignals.length
  }

  // Compare with profile
  const deltas = {}
  let totalMagnitude = 0

  for (const dim of Object.keys(STYLE_DIMENSIONS)) {
    deltas[dim] = avgRecent[dim] - profile.style[dim]
    totalMagnitude += Math.abs(deltas[dim])
  }

  const avgMagnitude = totalMagnitude / Object.keys(STYLE_DIMENSIONS).length

  return {
    shifted: avgMagnitude > 0.15,
    direction: deltas,
    magnitude: avgMagnitude,
    suggestion: avgMagnitude > 0.15 ? 'User style has shifted, consider adapting' : null
  }
}

// ============================================================================
// 8.2 Behavior Pattern Detection
// ============================================================================

/**
 * Track user behavior for pattern detection
 * TIERED: Requires Advanced Memory Plugin - free version skips tracking
 * @param {object} interaction - Interaction data
 */
export function trackUserBehavior(interaction) {
  // TIER CHECK: Behavior tracking requires Advanced Memory Plugin
  if (!hasFeature('hasStyleEngine')) {
    return // Skip tracking for free version
  }

  const patterns = loadBehaviorPatterns()

  const now = Date.now()
  const hour = new Date().getHours()

  // Track timing
  if (!patterns.timing.activeHours[hour]) {
    patterns.timing.activeHours[hour] = 0
  }
  patterns.timing.activeHours[hour]++

  // Track session duration
  if (interaction.sessionStart) {
    const duration = now - interaction.sessionStart
    patterns.timing.sessionDurations.push(duration)
    if (patterns.timing.sessionDurations.length > 50) {
      patterns.timing.sessionDurations = patterns.timing.sessionDurations.slice(-50)
    }
  }

  // Track query lengths
  if (interaction.query) {
    const queryLength = interaction.query.split(/\s+/).length
    patterns.interaction.queryLengths.push(queryLength)
    if (patterns.interaction.queryLengths.length > 100) {
      patterns.interaction.queryLengths = patterns.interaction.queryLengths.slice(-100)
    }
  }

  // Track follow-up rate
  if (interaction.isFollowUp !== undefined) {
    const total = (patterns.interaction.followUpCount || 0) + 1
    const followUps = (patterns.interaction.followUpYes || 0) + (interaction.isFollowUp ? 1 : 0)
    patterns.interaction.followUpCount = total
    patterns.interaction.followUpYes = followUps
    patterns.interaction.followUpRate = followUps / total
  }

  // Track satisfaction signals
  if (interaction.satisfaction) {
    patterns.interaction.satisfactionSignals.push({
      timestamp: now,
      value: interaction.satisfaction,
      context: interaction.context
    })
    if (patterns.interaction.satisfactionSignals.length > 50) {
      patterns.interaction.satisfactionSignals = patterns.interaction.satisfactionSignals.slice(-50)
    }
  }

  // Track topic frequency
  if (interaction.topics) {
    for (const topic of interaction.topics) {
      patterns.content.topicFrequency[topic] = (patterns.content.topicFrequency[topic] || 0) + 1
    }
  }

  // Track tool usage
  if (interaction.toolUsed) {
    patterns.content.toolUsage[interaction.toolUsed] = (patterns.content.toolUsage[interaction.toolUsed] || 0) + 1
  }

  // Track entity interactions
  if (interaction.entities) {
    for (const entity of interaction.entities) {
      patterns.content.entityInteractions[entity] = (patterns.content.entityInteractions[entity] || 0) + 1
    }
  }

  patterns.lastUpdated = new Date().toISOString()
  saveBehaviorPatterns(patterns)
}

/**
 * Infer preferences from behavior patterns
 * @returns {object} Inferred preferences
 */
export function inferPreferencesFromBehavior() {
  const patterns = loadBehaviorPatterns()
  const inferred = {}

  // Infer preferred response length from query lengths
  const avgQueryLength = patterns.interaction.queryLengths.length > 0
    ? patterns.interaction.queryLengths.reduce((a, b) => a + b, 0) / patterns.interaction.queryLengths.length
    : 10

  if (avgQueryLength < 8) {
    inferred.preferredResponseLength = 'short'
  } else if (avgQueryLength < 20) {
    inferred.preferredResponseLength = 'medium'
  } else {
    inferred.preferredResponseLength = 'long'
  }

  // Infer code style from topic/tool usage
  const codeRelatedTools = ['code', 'script', 'debug', 'compile', 'lint']
  const codeToolUsage = codeRelatedTools.reduce((sum, tool) =>
    sum + (patterns.content.toolUsage[tool] || 0), 0)

  if (codeToolUsage > 10) {
    inferred.codeStyle = 'verbose'
  } else if (codeToolUsage > 3) {
    inferred.codeStyle = 'commented'
  } else {
    inferred.codeStyle = 'minimal'
  }

  // Infer explanation depth from follow-up rate
  if (patterns.interaction.followUpRate > 0.4) {
    inferred.explanationDepth = 'comprehensive'
  } else if (patterns.interaction.followUpRate > 0.2) {
    inferred.explanationDepth = 'detailed'
  } else {
    inferred.explanationDepth = 'surface'
  }

  // Infer example preference from satisfaction signals
  const exampleRelated = patterns.interaction.satisfactionSignals.filter(s =>
    s.context?.includes('example') && s.value > 0.6)
  inferred.examplesPreferred = exampleRelated.length > 2

  // Infer structured output preference
  const structuredTopics = ['list', 'table', 'summary', 'comparison']
  const structuredUsage = structuredTopics.reduce((sum, topic) =>
    sum + (patterns.content.topicFrequency[topic] || 0), 0)
  inferred.structuredOutputPreferred = structuredUsage > 5

  // Peak activity hours
  const hourlyActivity = patterns.timing.activeHours
  const peakHour = Object.entries(hourlyActivity)
    .sort((a, b) => b[1] - a[1])[0]
  inferred.peakActivityHour = peakHour ? parseInt(peakHour[0]) : null

  // Most used features
  const topTools = Object.entries(patterns.content.toolUsage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tool]) => tool)
  inferred.topFeatures = topTools

  // Most interacted entities
  const topEntities = Object.entries(patterns.content.entityInteractions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([entity]) => entity)
  inferred.frequentEntities = topEntities

  return inferred
}

/**
 * Get behavior patterns
 * @returns {object} Behavior patterns
 */
export function getBehaviorPatterns() {
  return loadBehaviorPatterns()
}

/**
 * Predict user intent based on patterns
 * @param {string} query - User query
 * @returns {object} Intent prediction
 */
export function predictUserIntent(query) {
  const patterns = loadBehaviorPatterns()
  const profile = loadStyleProfile()

  const prediction = {
    likelyTopics: [],
    suggestedFormat: 'standard',
    confidenceLevel: 0.5,
    anticipatedFollowUp: false
  }

  // Check for topic patterns in query
  const queryLower = query.toLowerCase()
  const topTopics = Object.entries(patterns.content.topicFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)

  for (const [topic] of topTopics) {
    if (queryLower.includes(topic.toLowerCase())) {
      prediction.likelyTopics.push(topic)
    }
  }

  // Suggest format based on profile
  if (profile.style.verbosity < 0.3) {
    prediction.suggestedFormat = 'concise'
  } else if (profile.style.verbosity > 0.7) {
    prediction.suggestedFormat = 'detailed'
  }

  if (profile.style.technicality > 0.7) {
    prediction.suggestedFormat += '_technical'
  }

  // Predict follow-up based on historical rate
  prediction.anticipatedFollowUp = patterns.interaction.followUpRate > 0.3

  // Confidence based on observation count
  prediction.confidenceLevel = Math.min(1, profile.observationCount / 30)

  return prediction
}

// ============================================================================
// 8.3 Personalization Profiles
// ============================================================================

/**
 * Create comprehensive personalization profile
 * @returns {object} Complete personalization profile
 */
export function createPersonalizationProfile() {
  const styleProfile = loadStyleProfile()
  const behaviorPatterns = loadBehaviorPatterns()
  const inferred = inferPreferencesFromBehavior()

  // Get explicit preferences from memory manager if available
  let explicit = {}
  try {
    const mm = getMemoryManager()
    explicit = mm.getAllPreferences() || {}
  } catch (e) {
    // Memory manager not available
  }

  return {
    userId: 'default',
    version: 1,

    style: { ...styleProfile.style },

    inferred: {
      preferredResponseLength: inferred.preferredResponseLength || 'medium',
      codeStyle: inferred.codeStyle || 'commented',
      explanationDepth: inferred.explanationDepth || 'detailed',
      examplesPreferred: inferred.examplesPreferred || false,
      structuredOutputPreferred: inferred.structuredOutputPreferred || false,
      peakActivityHour: inferred.peakActivityHour,
      topFeatures: inferred.topFeatures || [],
      frequentEntities: inferred.frequentEntities || []
    },

    explicit,

    observationCount: styleProfile.observationCount || 0,
    lastUpdated: new Date().toISOString(),
    confidenceScore: styleProfile.confidenceScore || 0
  }
}

/**
 * Get personalization context for prompt injection
 * TIERED: Requires Advanced Memory Plugin - free version returns empty string
 * @returns {string} Formatted context for LLM
 */
export function getPersonalizationContext() {
  // TIER CHECK: Style-based context requires Advanced Memory Plugin
  if (!hasFeature('hasStyleEngine')) {
    return '' // No style context for free version
  }

  const profile = createPersonalizationProfile()

  if (profile.observationCount < MIN_OBSERVATIONS) {
    return '' // Not enough data yet
  }

  let context = '\n### User Communication Preferences\n\n'

  // Style preferences
  const styleDescriptions = {
    formality: profile.style.formality > 0.6 ? 'formal' : profile.style.formality < 0.4 ? 'casual' : 'balanced',
    verbosity: profile.style.verbosity > 0.6 ? 'detailed explanations' : profile.style.verbosity < 0.4 ? 'concise responses' : 'moderate detail',
    technicality: profile.style.technicality > 0.6 ? 'technical language' : profile.style.technicality < 0.4 ? 'simple explanations' : 'standard technical level',
    directness: profile.style.directness > 0.6 ? 'direct answers' : 'contextual explanations'
  }

  context += `The user prefers ${styleDescriptions.formality} communication with ${styleDescriptions.verbosity}.\n`
  context += `Use ${styleDescriptions.technicality} and provide ${styleDescriptions.directness}.\n`

  // Inferred preferences
  if (profile.inferred.examplesPreferred) {
    context += 'Include examples when explaining concepts.\n'
  }
  if (profile.inferred.structuredOutputPreferred) {
    context += 'Use structured formats (lists, tables) when appropriate.\n'
  }
  if (profile.inferred.codeStyle === 'verbose') {
    context += 'Include detailed comments in code snippets.\n'
  }

  // Explicit preferences (from memory)
  if (Object.keys(profile.explicit).length > 0) {
    context += '\nExplicit user preferences:\n'
    for (const [category, prefs] of Object.entries(profile.explicit)) {
      for (const [key, value] of Object.entries(prefs)) {
        context += `- ${key}: ${value}\n`
      }
    }
  }

  context += `\n(Confidence: ${Math.round(profile.confidenceScore * 100)}% based on ${profile.observationCount} interactions)\n`

  return context
}

/**
 * Compare two profiles for similarity
 * @param {object} profile1 - First profile
 * @param {object} profile2 - Second profile
 * @returns {{ similarity: number, differences: object }}
 */
export function compareProfiles(profile1, profile2) {
  const differences = {}
  let totalDiff = 0

  for (const dim of Object.keys(STYLE_DIMENSIONS)) {
    const val1 = profile1.style?.[dim] ?? STYLE_DIMENSIONS[dim].default
    const val2 = profile2.style?.[dim] ?? STYLE_DIMENSIONS[dim].default
    const diff = Math.abs(val1 - val2)

    differences[dim] = {
      profile1: val1,
      profile2: val2,
      difference: diff
    }
    totalDiff += diff
  }

  const avgDiff = totalDiff / Object.keys(STYLE_DIMENSIONS).length
  const similarity = 1 - avgDiff

  return {
    similarity,
    differences,
    mostDifferent: Object.entries(differences)
      .sort((a, b) => b[1].difference - a[1].difference)[0]?.[0]
  }
}

/**
 * Export personalization profile for backup
 * @returns {object} Exportable profile
 */
export function exportPersonalizationProfile() {
  return {
    profile: createPersonalizationProfile(),
    behavior: loadBehaviorPatterns(),
    exportedAt: new Date().toISOString(),
    version: '1.0'
  }
}

/**
 * Import personalization profile
 * @param {object} data - Exported profile data
 */
export function importPersonalizationProfile(data) {
  if (data.profile) {
    saveStyleProfile(data.profile)
  }
  if (data.behavior) {
    saveBehaviorPatterns(data.behavior)
  }
}

// ============================================================================
// 8.4 Adaptive Response Formatting
// ============================================================================

const ADAPTATION_RULES = {
  verbosity: {
    low: 'Be concise. Limit to 2-3 sentences or bullet points. Skip examples unless essential.',
    medium: 'Use standard paragraphs with moderate detail. Include one example if helpful.',
    high: 'Provide thorough explanations with context, examples, and related information.'
  },
  technicality: {
    low: 'Avoid jargon. Explain technical concepts in simple terms. Use analogies.',
    medium: 'Use standard technical language. Define specialized terms briefly.',
    high: 'Assume technical expertise. Use precise terminology. Skip basic explanations.'
  },
  formality: {
    low: 'Use casual, conversational tone. Contractions are fine. Be friendly.',
    medium: 'Professional but approachable. Balance formality with friendliness.',
    high: 'Use formal language. Complete sentences. Professional tone throughout.'
  },
  directness: {
    low: 'Provide context before answers. Explain reasoning. Be thorough.',
    high: 'Lead with the answer. Be direct and action-oriented. Skip preamble.'
  }
}

/**
 * Adapt response based on user's style profile
 * @param {string} response - Original response
 * @param {object} profile - Style profile (optional, will load if not provided)
 * @returns {string} Adapted response
 */
export function adaptResponse(response, profile = null) {
  const p = profile || createPersonalizationProfile()

  if (p.observationCount < MIN_OBSERVATIONS) {
    return response // Not enough data to adapt
  }

  // This is a simplified adaptation - in production, you'd use the LLM
  // to rewrite the response based on the profile

  // For now, we add formatting hints
  let adapted = response

  // Add structure for users who prefer it
  if (p.inferred.structuredOutputPreferred && !response.includes('- ') && response.length > 200) {
    // Could convert paragraphs to bullet points here
  }

  return adapted
}

/**
 * Get formatting recommendations based on profile
 * @param {object} profile - Style profile (optional)
 * @returns {object} Formatting recommendations
 */
export function getFormattingRecommendations(profile = null) {
  const p = profile || createPersonalizationProfile()

  const recommendations = {
    lengthHint: '',
    toneHint: '',
    structureHint: '',
    contentHint: '',
    instructions: []
  }

  // Length recommendations
  if (p.style.verbosity < 0.35) {
    recommendations.lengthHint = 'Keep responses brief and focused'
    recommendations.instructions.push(ADAPTATION_RULES.verbosity.low)
  } else if (p.style.verbosity > 0.65) {
    recommendations.lengthHint = 'Provide comprehensive explanations'
    recommendations.instructions.push(ADAPTATION_RULES.verbosity.high)
  } else {
    recommendations.lengthHint = 'Use moderate detail level'
    recommendations.instructions.push(ADAPTATION_RULES.verbosity.medium)
  }

  // Tone recommendations
  if (p.style.formality < 0.35) {
    recommendations.toneHint = 'Casual and friendly'
    recommendations.instructions.push(ADAPTATION_RULES.formality.low)
  } else if (p.style.formality > 0.65) {
    recommendations.toneHint = 'Professional and formal'
    recommendations.instructions.push(ADAPTATION_RULES.formality.high)
  } else {
    recommendations.toneHint = 'Professional but approachable'
    recommendations.instructions.push(ADAPTATION_RULES.formality.medium)
  }

  // Technical level
  if (p.style.technicality < 0.35) {
    recommendations.contentHint = 'Simplify technical concepts'
    recommendations.instructions.push(ADAPTATION_RULES.technicality.low)
  } else if (p.style.technicality > 0.65) {
    recommendations.contentHint = 'Use technical precision'
    recommendations.instructions.push(ADAPTATION_RULES.technicality.high)
  } else {
    recommendations.contentHint = 'Balance technical and accessible'
    recommendations.instructions.push(ADAPTATION_RULES.technicality.medium)
  }

  // Structure preferences
  if (p.inferred.structuredOutputPreferred) {
    recommendations.structureHint = 'Use lists and structured formats'
    recommendations.instructions.push('Use bullet points, numbered lists, or tables when presenting multiple items.')
  }
  if (p.inferred.examplesPreferred) {
    recommendations.instructions.push('Include practical examples to illustrate concepts.')
  }

  // Directness
  if (p.style.directness > 0.65) {
    recommendations.instructions.push(ADAPTATION_RULES.directness.high)
  } else if (p.style.directness < 0.35) {
    recommendations.instructions.push(ADAPTATION_RULES.directness.low)
  }

  return recommendations
}

/**
 * Generate style instruction for LLM prompt injection
 * TIERED: Requires Advanced Memory Plugin - free version returns empty string
 * @returns {string} Style instruction for system prompt
 */
export function getStyleInstruction() {
  // TIER CHECK: Style instructions require Advanced Memory Plugin
  if (!hasFeature('hasStyleEngine')) {
    return '' // No style instructions for free version
  }

  const recommendations = getFormattingRecommendations()

  if (recommendations.instructions.length === 0) {
    return ''
  }

  return `\n### Response Style Guidelines\n${recommendations.instructions.join('\n')}\n`
}

// ============================================================================
// Storage Helpers
// ============================================================================

function loadStyleProfile() {
  try {
    const stored = personalGet('style')
    if (stored) {
      return JSON.parse(stored)
    }
  } catch (e) {
    console.warn('[StyleEngine] Failed to load profile:', e)
  }

  // Return default profile
  return {
    style: Object.fromEntries(
      Object.entries(STYLE_DIMENSIONS).map(([k, v]) => [k, v.default])
    ),
    observationCount: 0,
    confidenceScore: 0,
    lastUpdated: new Date().toISOString(),
    recentObservations: []
  }
}

function saveStyleProfile(profile) {
  try {
    personalSet('style', JSON.stringify(profile))
    _styleWriteThrough()
  } catch (e) {
    console.warn('[StyleEngine] Failed to save profile:', e)
  }
}

function loadBehaviorPatterns() {
  try {
    const stored = personalGet('behavior')
    if (stored) {
      return JSON.parse(stored)
    }
  } catch (e) {
    console.warn('[StyleEngine] Failed to load behavior patterns:', e)
  }

  // Return default patterns
  return {
    timing: {
      activeHours: {},
      sessionDurations: [],
      responseLatency: []
    },
    interaction: {
      queryLengths: [],
      followUpRate: 0,
      followUpCount: 0,
      followUpYes: 0,
      correctionRate: 0,
      satisfactionSignals: []
    },
    content: {
      topicFrequency: {},
      toolUsage: {},
      entityInteractions: {}
    },
    lastUpdated: new Date().toISOString()
  }
}

function saveBehaviorPatterns(patterns) {
  try {
    personalSet('behavior', JSON.stringify(patterns))
    _styleWriteThrough()
  } catch (e) {
    console.warn('[StyleEngine] Failed to save behavior patterns:', e)
  }
}

/**
 * Write-through the combined {profile, behavior} document to the memory
 * service's identity_blobs store — one blob, avoiding two round-trips.
 * Fire-and-forget; localStorage stays the fast synchronous read path.
 */
function _styleWriteThrough() {
  try {
    const profile = loadStyleProfile()
    const behavior = loadBehaviorPatterns()
    memoryClient.setIdentity(STYLE_NAMESPACE, { profile, behavior }).catch(err => {
      console.warn('[StyleEngine] Identity write-through failed:', err.message)
    })
  } catch (err) {
    console.warn('[StyleEngine] Identity write-through error:', err.message)
  }
}

/**
 * Hydrate the org-scoped style/behavior local caches from the memory
 * service, splitting the combined blob back into the two local keys.
 *
 * Style's local cache keys are dynamic (quox_{org}_{user}_style /
 * quox_{org}_{user}_behavior) so they are NOT covered by
 * memoryManager.hydrateIdentityFromServer(). Must be called AFTER
 * setStorageContext(org, user) is set — call once on auth and again on
 * every 'quox-org-switch' so switching orgs hydrates the newly-selected
 * org's blob. Never overwrites an existing local cache; best-effort.
 */
export async function hydrateStyleFromServer() {
  try {
    const hasProfile = Boolean(personalGet('style'))
    const hasBehavior = Boolean(personalGet('behavior'))
    if (hasProfile && hasBehavior) return

    const result = await memoryClient.getIdentity(STYLE_NAMESPACE)
    if (!result || !result.data) return

    if (!hasProfile && result.data.profile) {
      personalSet('style', JSON.stringify(result.data.profile))
    }
    if (!hasBehavior && result.data.behavior) {
      personalSet('behavior', JSON.stringify(result.data.behavior))
    }
  } catch (err) {
    console.warn('[StyleEngine] Identity hydration failed:', err.message)
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

// ============================================================================
// Exports
// ============================================================================

export default {
  // Tier Gating
  isStyleEngineAvailable,

  // Style Analysis
  analyzeMessageStyle,
  updateStyleProfile,
  getStyleProfile,
  detectStyleShift,

  // Behavior Tracking
  trackUserBehavior,
  inferPreferencesFromBehavior,
  getBehaviorPatterns,
  predictUserIntent,

  // Personalization
  createPersonalizationProfile,
  getPersonalizationContext,
  compareProfiles,
  exportPersonalizationProfile,
  importPersonalizationProfile,

  // Response Adaptation
  adaptResponse,
  getFormattingRecommendations,
  getStyleInstruction,

  // Server hydration (QMH2-CONSOLIDATION)
  hydrateStyleFromServer,

  // Constants
  STYLE_DIMENSIONS,
  ADAPTATION_RULES
}
