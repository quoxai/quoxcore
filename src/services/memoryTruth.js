/**
 * Quox Memory Truth Service
 *
 * Handles truth strategy, conflict resolution, and memory verification.
 * Part of Wave 1 Memory Overhaul - "giggly-seeking-beacon"
 * Enhanced with semantic embeddings in Wave 2.
 *
 * TIERED: Contradiction Detection is a Premium feature
 */

import {
  getMemoryManager,
  TRUTH_PRIORITY,
  STABILITY_LEVELS,
  calculateDecayedConfidence,
  createProvenance,
  createConfidence
} from './memoryManager.js'

import {
  getEmbedding,
  getEmbeddings,
  cosineSimilarity,
  isAvailable as embeddingsAvailable
} from './embeddingService.js'

import { hasFeature, createUpgradePrompt } from './memoryTier.js'

// ============================================================================
// TIER GATING
// ============================================================================

/**
 * Check if Contradiction Detection is available (Premium only)
 * @returns {{ available: boolean, upgrade?: object }}
 */
export function isContradictionDetectionAvailable() {
  const available = hasFeature('hasContradictionDetection')
  if (!available) {
    return {
      available: false,
      upgrade: createUpgradePrompt('contradictionDetection')
    }
  }
  return { available: true }
}

// ============================================================================
// TRUTH STRATEGY
// ============================================================================

/**
 * Compare two memories and determine which is more trustworthy
 * @returns {Object} { winner: memory, reason: string }
 */
export function compareTruth(memory1, memory2) {
  const score1 = calculateTruthScore(memory1)
  const score2 = calculateTruthScore(memory2)

  if (score1 > score2) {
    return {
      winner: memory1,
      loser: memory2,
      reason: explainTruthWinner(memory1, memory2, score1, score2)
    }
  } else if (score2 > score1) {
    return {
      winner: memory2,
      loser: memory1,
      reason: explainTruthWinner(memory2, memory1, score2, score1)
    }
  }

  // Equal scores - prefer more recent
  const time1 = new Date(memory1.provenance?.createdAt || memory1.learnedAt || 0)
  const time2 = new Date(memory2.provenance?.createdAt || memory2.learnedAt || 0)

  return {
    winner: time1 > time2 ? memory1 : memory2,
    loser: time1 > time2 ? memory2 : memory1,
    reason: 'Equal trust scores, preferring more recent'
  }
}

/**
 * Calculate overall truth score for a memory
 */
export function calculateTruthScore(memory) {
  const provenance = memory.provenance || {}
  const confidence = memory.confidence || {}

  // Source priority (40% weight)
  const sourcePriority = TRUTH_PRIORITY[provenance.source] || 0.5

  // Decayed confidence (30% weight)
  const decayedConfidence = calculateDecayedConfidence(confidence)

  // Verification boost (20% weight)
  const verificationScore = Math.min(1.0, (confidence.verificationCount || 0) * 0.2)

  // Stability bonus (10% weight)
  const stabilityBonus = {
    permanent: 1.0,
    stable: 0.7,
    volatile: 0.3
  }[confidence.stability] || 0.5

  return (
    0.4 * sourcePriority +
    0.3 * decayedConfidence +
    0.2 * verificationScore +
    0.1 * stabilityBonus
  )
}

/**
 * Explain why one memory won over another
 */
function explainTruthWinner(winner, loser, winnerScore, loserScore) {
  const reasons = []

  const wp = winner.provenance || {}
  const lp = loser.provenance || {}
  const wc = winner.confidence || {}
  const lc = loser.confidence || {}

  // Source comparison
  if ((TRUTH_PRIORITY[wp.source] || 0) > (TRUTH_PRIORITY[lp.source] || 0)) {
    reasons.push(`higher source priority (${wp.source} > ${lp.source})`)
  }

  // Confidence comparison
  if ((wc.score || 0) > (lc.score || 0)) {
    reasons.push(`higher confidence (${(wc.score || 0).toFixed(2)} > ${(lc.score || 0).toFixed(2)})`)
  }

  // Verification comparison
  if ((wc.verificationCount || 0) > (lc.verificationCount || 0)) {
    reasons.push(`more verifications (${wc.verificationCount || 0} > ${lc.verificationCount || 0})`)
  }

  // Stability comparison
  const stabilityOrder = { permanent: 3, stable: 2, volatile: 1 }
  if ((stabilityOrder[wc.stability] || 0) > (stabilityOrder[lc.stability] || 0)) {
    reasons.push(`more stable (${wc.stability} > ${lc.stability})`)
  }

  return reasons.length > 0
    ? `Winner due to: ${reasons.join(', ')}`
    : `Higher overall score (${winnerScore.toFixed(2)} > ${loserScore.toFixed(2)})`
}

// ============================================================================
// CONFLICT DETECTION
// ============================================================================

/**
 * Detect semantic conflicts between memories using simple heuristics
 * (Will be enhanced with embeddings in Phase 8)
 * TIERED: Requires Advanced Memory Plugin
 */
export function detectConflicts(memories) {
  // TIER CHECK: Conflict detection requires Advanced Memory Plugin
  if (!hasFeature('hasContradictionDetection')) {
    return [] // Return empty array for free version
  }

  const conflicts = []

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const conflict = checkForConflict(memories[i], memories[j])
      if (conflict) {
        conflicts.push(conflict)
      }
    }
  }

  return conflicts
}

/**
 * Check if two memories conflict
 */
export function checkForConflict(mem1, mem2) {
  const content1 = (mem1.content || '').toLowerCase()
  const content2 = (mem2.content || '').toLowerCase()

  // Skip if not enough content
  if (content1.length < 10 || content2.length < 10) return null

  // Check topic similarity (word overlap)
  const words1 = new Set(content1.split(/\s+/).filter(w => w.length > 3))
  const words2 = new Set(content2.split(/\s+/).filter(w => w.length > 3))
  const intersection = [...words1].filter(w => words2.has(w))
  const union = new Set([...words1, ...words2])
  const similarity = intersection.length / union.size

  // Not related enough to conflict
  if (similarity < 0.15) return null

  // Check for opposing patterns
  const opposites = [
    { pos: /\balways\b/, neg: /\bnever\b/, type: 'frequency' },
    { pos: /\bprefer\b/, neg: /\bavoid\b/, type: 'preference' },
    { pos: /\buse\b/, neg: /\bdon't use\b/, type: 'usage' },
    { pos: /\benable\b/, neg: /\bdisable\b/, type: 'state' },
    { pos: /\ballow\b/, neg: /\bblock\b/, type: 'permission' },
    { pos: /\blike\b/, neg: /\bdon't like\b/, type: 'preference' },
    { pos: /\bwant\b/, neg: /\bdon't want\b/, type: 'desire' },
    { pos: /\bis\s/, neg: /\bisn't\b|\bis not\b/, type: 'state' },
    { pos: /\bcan\b/, neg: /\bcan't\b|\bcannot\b/, type: 'capability' },
    { pos: /\bshould\b/, neg: /\bshouldn't\b/, type: 'recommendation' }
  ]

  for (const { pos, neg, type } of opposites) {
    const mem1Pos = pos.test(content1)
    const mem1Neg = neg.test(content1)
    const mem2Pos = pos.test(content2)
    const mem2Neg = neg.test(content2)

    // One positive, one negative = conflict
    if ((mem1Pos && mem2Neg) || (mem1Neg && mem2Pos)) {
      return {
        type: 'semantic_opposition',
        conflictType: type,
        memory1: mem1,
        memory2: mem2,
        similarity,
        sharedTopics: intersection.slice(0, 5),
        detectedAt: new Date().toISOString()
      }
    }
  }

  // Check for value conflicts (same attribute, different value)
  const valuePatterns = [
    /(\w+)\s+is\s+(\w+)/gi,      // "X is Y"
    /(\w+)\s*:\s*(\w+)/gi,       // "X: Y"
    /(\w+)\s*=\s*(\w+)/gi        // "X = Y"
  ]

  for (const pattern of valuePatterns) {
    const matches1 = [...content1.matchAll(pattern)]
    const matches2 = [...content2.matchAll(pattern)]

    for (const m1 of matches1) {
      for (const m2 of matches2) {
        // Same key, different value
        if (m1[1].toLowerCase() === m2[1].toLowerCase() &&
            m1[2].toLowerCase() !== m2[2].toLowerCase()) {
          return {
            type: 'value_conflict',
            attribute: m1[1],
            value1: m1[2],
            value2: m2[2],
            memory1: mem1,
            memory2: mem2,
            similarity,
            detectedAt: new Date().toISOString()
          }
        }
      }
    }
  }

  return null
}

// ============================================================================
// SEMANTIC CONFLICT DETECTION (Wave 2)
// ============================================================================

/**
 * Sentiment/polarity indicators for semantic opposition
 */
const SENTIMENT_PATTERNS = {
  positive: [
    /\b(good|great|excellent|love|prefer|like|enjoy|want|yes|always|do|use|enable|allow|should)\b/i,
    /\b(recommend|approve|accept|agree|confirm)\b/i
  ],
  negative: [
    /\b(bad|terrible|hate|avoid|dislike|never|don't|no|disable|block|shouldn't)\b/i,
    /\b(reject|refuse|deny|disagree|decline)\b/i
  ]
}

/**
 * Detect sentiment polarity of text
 */
function detectSentiment(text) {
  const lower = text.toLowerCase()

  let positiveScore = 0
  let negativeScore = 0

  for (const pattern of SENTIMENT_PATTERNS.positive) {
    const matches = lower.match(pattern)
    if (matches) positiveScore += matches.length
  }

  for (const pattern of SENTIMENT_PATTERNS.negative) {
    const matches = lower.match(pattern)
    if (matches) negativeScore += matches.length
  }

  if (positiveScore > negativeScore) return 'positive'
  if (negativeScore > positiveScore) return 'negative'
  return 'neutral'
}

/**
 * Check for semantic conflict using embeddings
 * High similarity + opposing sentiment = conflict
 *
 * @param {Object} mem1 - First memory
 * @param {Object} mem2 - Second memory
 * @param {Object} options - Detection options
 * @returns {Promise<Object|null>} - Conflict details or null
 */
export async function checkSemanticConflict(mem1, mem2, options = {}) {
  const {
    similarityThreshold = 0.75,  // High similarity needed for potential conflict
    useEmbeddings = true
  } = options

  const content1 = mem1.content || ''
  const content2 = mem2.content || ''

  // Skip if not enough content
  if (content1.length < 15 || content2.length < 15) return null

  // Check if embeddings available
  let similarity = 0
  let embeddingUsed = false

  if (useEmbeddings && embeddingsAvailable()) {
    try {
      const [emb1, emb2] = await getEmbeddings([content1, content2])

      if (emb1 && emb2) {
        similarity = cosineSimilarity(emb1, emb2)
        embeddingUsed = true
      }
    } catch (e) {
      console.warn('[SemanticConflict] Embedding error:', e.message)
    }
  }

  // Fallback to keyword similarity if embeddings unavailable
  if (!embeddingUsed) {
    const words1 = new Set(content1.toLowerCase().split(/\s+/).filter(w => w.length > 3))
    const words2 = new Set(content2.toLowerCase().split(/\s+/).filter(w => w.length > 3))
    const intersection = [...words1].filter(w => words2.has(w))
    const union = new Set([...words1, ...words2])
    similarity = union.size > 0 ? intersection.length / union.size : 0
  }

  // Not similar enough to potentially conflict
  if (similarity < similarityThreshold) return null

  // Check for opposing sentiment
  const sentiment1 = detectSentiment(content1)
  const sentiment2 = detectSentiment(content2)

  const hasOpposingSentiment =
    (sentiment1 === 'positive' && sentiment2 === 'negative') ||
    (sentiment1 === 'negative' && sentiment2 === 'positive')

  if (!hasOpposingSentiment) return null

  // We have high similarity + opposing sentiment = conflict
  return {
    type: 'semantic_conflict',
    similarity,
    embeddingUsed,
    sentiment1,
    sentiment2,
    memory1: mem1,
    memory2: mem2,
    confidence: similarity * 0.8,  // Confidence in conflict detection
    detectedAt: new Date().toISOString()
  }
}

/**
 * Detect all semantic conflicts in a set of memories
 * Uses embeddings for similarity and sentiment analysis for opposition
 * TIERED: Premium only
 *
 * @param {Array} memories - Array of memory objects
 * @param {Object} options - Detection options
 * @returns {Promise<Array>} - Array of conflicts
 */
export async function detectSemanticConflicts(memories, options = {}) {
  // TIER CHECK: Semantic conflict detection requires Advanced Memory Plugin
  if (!hasFeature('hasContradictionDetection')) {
    return [] // Return empty array for free version
  }

  const {
    maxComparisons = 1000,  // Limit for performance
    batchSize = 20
  } = options

  if (!memories || memories.length < 2) return []

  const conflicts = []
  let comparisons = 0

  // Process in batches for large memory sets
  for (let i = 0; i < memories.length && comparisons < maxComparisons; i++) {
    for (let j = i + 1; j < memories.length && comparisons < maxComparisons; j++) {
      comparisons++

      const conflict = await checkSemanticConflict(memories[i], memories[j], options)
      if (conflict) {
        conflicts.push(conflict)
      }
    }
  }

  // Sort by confidence (highest first)
  conflicts.sort((a, b) => b.confidence - a.confidence)

  return conflicts
}

/**
 * Find memories that potentially conflict with a new memory
 * Useful for pre-commit validation
 *
 * @param {Object} newMemory - The new memory to check
 * @param {Array} existingMemories - Existing memories to check against
 * @param {Object} options - Detection options
 * @returns {Promise<Array>} - Array of potential conflicts
 */
export async function findConflictingMemories(newMemory, existingMemories, options = {}) {
  const {
    limit = 5,
    similarityThreshold = 0.7
  } = options

  if (!existingMemories || existingMemories.length === 0) return []

  const conflicts = []

  for (const existing of existingMemories) {
    // First check with pattern-based detection (fast)
    const patternConflict = checkForConflict(newMemory, existing)
    if (patternConflict) {
      conflicts.push({
        ...patternConflict,
        detectionMethod: 'pattern'
      })
      continue
    }

    // Then check with semantic detection if embeddings available
    if (embeddingsAvailable()) {
      const semanticConflict = await checkSemanticConflict(newMemory, existing, {
        similarityThreshold
      })

      if (semanticConflict) {
        conflicts.push({
          ...semanticConflict,
          detectionMethod: 'semantic'
        })
      }
    }
  }

  // Sort by confidence and limit
  return conflicts
    .sort((a, b) => (b.confidence || b.similarity) - (a.confidence || a.similarity))
    .slice(0, limit)
}

/**
 * Enhanced conflict detection combining pattern and semantic methods
 */
export async function detectConflictsEnhanced(memories, options = {}) {
  const { useSemanticDetection = true } = options

  // Fast pattern-based detection
  const patternConflicts = detectConflicts(memories)

  // Enhanced semantic detection if enabled
  if (useSemanticDetection && embeddingsAvailable()) {
    const semanticConflicts = await detectSemanticConflicts(memories, options)

    // Merge and deduplicate
    const allConflicts = [...patternConflicts]

    for (const semantic of semanticConflicts) {
      // Check if already detected by pattern
      const isDuplicate = patternConflicts.some(p =>
        (p.memory1.id === semantic.memory1.id && p.memory2.id === semantic.memory2.id) ||
        (p.memory1.id === semantic.memory2.id && p.memory2.id === semantic.memory1.id)
      )

      if (!isDuplicate) {
        allConflicts.push(semantic)
      }
    }

    return allConflicts
  }

  return patternConflicts
}

// ============================================================================
// CONFLICT RESOLUTION
// ============================================================================

/**
 * Automatically resolve a conflict using truth strategy
 */
export function autoResolveConflict(conflict) {
  const { winner, loser, reason } = compareTruth(conflict.memory1, conflict.memory2)
  const mm = getMemoryManager()

  // Mark loser as superseded
  if (loser.id && winner.id) {
    mm.supersededBy(loser.type || 'fact', loser.id, winner.id)
  }

  return {
    resolution: 'auto_resolved',
    kept: winner,
    discarded: loser,
    reason,
    resolvedAt: new Date().toISOString()
  }
}

/**
 * Get suggested resolution for a conflict (for user review)
 */
export function suggestResolution(conflict) {
  const { winner, loser, reason } = compareTruth(conflict.memory1, conflict.memory2)

  return {
    suggestion: 'keep_winner',
    recommended: winner,
    alternative: loser,
    reason,
    confidence: calculateTruthScore(winner) - calculateTruthScore(loser),
    actions: [
      {
        action: 'keep_recommended',
        label: `Keep: "${truncate(winner.content, 50)}"`,
        description: reason
      },
      {
        action: 'keep_alternative',
        label: `Keep: "${truncate(loser.content, 50)}"`,
        description: 'Override recommendation'
      },
      {
        action: 'keep_both',
        label: 'Keep both (mark as compatible)',
        description: 'These memories don\'t actually conflict'
      },
      {
        action: 'discard_both',
        label: 'Discard both',
        description: 'Neither is accurate'
      },
      {
        action: 'merge',
        label: 'Merge into new memory',
        description: 'Combine information from both'
      }
    ]
  }
}

/**
 * Execute a user's resolution decision
 */
export function executeResolution(conflict, action, options = {}) {
  const mm = getMemoryManager()
  const mem1 = conflict.memory1
  const mem2 = conflict.memory2
  const type = mem1.type || mem2.type || 'fact'

  switch (action) {
    case 'keep_recommended': {
      const { winner, loser } = compareTruth(mem1, mem2)
      mm.supersededBy(type, loser.id, winner.id)
      mm.resolveConflict(type, winner.id, 'user_resolved', winner.id)
      return { kept: winner.id, discarded: loser.id }
    }

    case 'keep_alternative': {
      const { winner, loser } = compareTruth(mem1, mem2)
      mm.supersededBy(type, winner.id, loser.id)
      mm.resolveConflict(type, loser.id, 'user_resolved', loser.id)
      return { kept: loser.id, discarded: winner.id }
    }

    case 'keep_both': {
      // Clear conflict markers from both
      mm.updateLearnedItem(type, mem1.id, {
        conflicts: { resolution: 'user_resolved', resolvedAt: new Date().toISOString() }
      })
      mm.updateLearnedItem(type, mem2.id, {
        conflicts: { resolution: 'user_resolved', resolvedAt: new Date().toISOString() }
      })
      return { kept: [mem1.id, mem2.id], merged: false }
    }

    case 'discard_both': {
      mm.deleteLearnedItem(type, mem1.id)
      mm.deleteLearnedItem(type, mem2.id)
      return { discarded: [mem1.id, mem2.id] }
    }

    case 'merge': {
      const mergedContent = options.mergedContent || `${mem1.content} [merged with] ${mem2.content}`
      const newMemory = mm.addLearnedItem(type, {
        content: mergedContent,
        mergedFrom: [mem1.id, mem2.id]
      }, {
        source: 'user_stated',
        createdBy: 'human.user',
        stability: mem1.confidence?.stability || mem2.confidence?.stability || 'stable'
      })

      mm.supersededBy(type, mem1.id, newMemory.id)
      mm.supersededBy(type, mem2.id, newMemory.id)

      return { created: newMemory.id, discarded: [mem1.id, mem2.id] }
    }

    default:
      throw new Error(`Unknown resolution action: ${action}`)
  }
}

// ============================================================================
// MEMORY VERIFICATION
// ============================================================================

/**
 * Verify a memory (confirm it's still true)
 */
export function verifyMemory(type, itemId, verifiedBy = 'user') {
  const mm = getMemoryManager()
  return mm.verifyMemory(type, itemId, verifiedBy)
}

/**
 * Get memories that need verification (old, low confidence)
 */
export function getMemoriesNeedingVerification(options = {}) {
  const {
    maxAge = 30 * 24 * 60 * 60 * 1000, // 30 days
    minConfidence = 0.5,
    limit = 10
  } = options

  const mm = getMemoryManager()
  const needsVerification = []

  for (const type of ['preference', 'fact', 'decision', 'constraint']) {
    const items = mm.getLearnedItemsByType(type)

    for (const item of items) {
      const decayed = calculateDecayedConfidence(item.confidence)
      const age = Date.now() - new Date(item.confidence?.lastVerified || item.learnedAt || 0).getTime()

      // Need verification if old or low confidence
      if (age > maxAge || decayed < minConfidence) {
        needsVerification.push({
          ...item,
          type,
          currentConfidence: decayed,
          daysSinceVerified: Math.floor(age / (24 * 60 * 60 * 1000)),
          urgency: decayed < 0.3 ? 'high' : decayed < 0.5 ? 'medium' : 'low'
        })
      }
    }
  }

  // Sort by urgency and age
  needsVerification.sort((a, b) => {
    const urgencyOrder = { high: 0, medium: 1, low: 2 }
    if (urgencyOrder[a.urgency] !== urgencyOrder[b.urgency]) {
      return urgencyOrder[a.urgency] - urgencyOrder[b.urgency]
    }
    return b.daysSinceVerified - a.daysSinceVerified
  })

  return needsVerification.slice(0, limit)
}

// ============================================================================
// TRUTH AUDIT
// ============================================================================

/**
 * Get a truth audit report for all memories
 */
export function getTruthAudit() {
  const mm = getMemoryManager()
  const audit = {
    totalMemories: 0,
    bySource: {},
    byStability: {},
    byConfidence: { high: 0, medium: 0, low: 0 },
    conflicts: [],
    needsVerification: [],
    superseded: 0
  }

  for (const type of ['preference', 'fact', 'decision', 'constraint', 'error', 'reflection']) {
    const items = mm.getLearnedItemsByType(type)

    for (const item of items) {
      audit.totalMemories++

      // Source distribution
      const source = item.provenance?.source || 'unknown'
      audit.bySource[source] = (audit.bySource[source] || 0) + 1

      // Stability distribution
      const stability = item.confidence?.stability || 'unknown'
      audit.byStability[stability] = (audit.byStability[stability] || 0) + 1

      // Confidence distribution
      const conf = calculateDecayedConfidence(item.confidence)
      if (conf >= 0.7) audit.byConfidence.high++
      else if (conf >= 0.4) audit.byConfidence.medium++
      else audit.byConfidence.low++

      // Track conflicts
      if (item.conflicts?.conflictsWith?.length > 0 && item.conflicts.resolution === 'pending') {
        audit.conflicts.push({
          id: item.id,
          type,
          conflictsWith: item.conflicts.conflictsWith
        })
      }

      // Track superseded
      if (item.provenance?.supersededBy) {
        audit.superseded++
      }
    }
  }

  // Get verification needs
  audit.needsVerification = getMemoriesNeedingVerification({ limit: 5 })

  return audit
}

// ============================================================================
// UTILITIES
// ============================================================================

function truncate(str, maxLen) {
  if (!str) return ''
  return str.length > maxLen ? str.substring(0, maxLen) + '...' : str
}

export default {
  // Tier Gating
  isContradictionDetectionAvailable,

  // Truth Comparison (available to all)
  compareTruth,
  calculateTruthScore,

  // Conflict Detection (Premium)
  detectConflicts,
  checkForConflict,
  checkSemanticConflict,
  detectSemanticConflicts,
  findConflictingMemories,
  detectConflictsEnhanced,

  // Resolution (Premium)
  autoResolveConflict,
  suggestResolution,
  executeResolution,

  // Verification
  verifyMemory,
  getMemoriesNeedingVerification,
  getTruthAudit
}
