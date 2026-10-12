/**
 * Quox Memory Confirmation Service
 *
 * Two-stage commit system for memory writes.
 * Prevents "memory graffiti" - don't write unless confident or confirmed.
 * Part of Wave 2 Memory Overhaul - "giggly-seeking-beacon"
 */

import { getMemoryManager, TRUTH_PRIORITY } from './memoryManager.js'
import { getEmbedding, cosineSimilarity } from './embeddingService.js'

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Promotion criteria - when to auto-promote vs require confirmation
 */
export const PROMOTION_CRITERIA = {
  // Auto-promote conditions (any = promote immediately)
  autoPromote: {
    explicitCommand: true,      // "Remember this", "Always do X"
    toolVerified: true,         // Confirmed by tool output (QuoxAgent, API, etc.)
    highConfidence: 0.9,        // Confidence >= 0.9
    repeatedMention: 3          // Mentioned 3+ times across sessions
  },

  // Require confirmation conditions (any = needs user approval)
  requiresConfirmation: {
    // Sensitive content patterns
    sensitivePatterns: [
      /\b(password|passwd|pwd)\b/i,
      /\b(api[_-]?key|apikey)\b/i,
      /\b(secret|token|credential)\b/i,
      /\b(ssh[_-]?key|private[_-]?key)\b/i,
      /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,  // IP addresses
      /\b[A-Za-z0-9+/]{20,}={0,2}\b/  // Base64 strings (potential secrets)
    ],

    // Stability-critical memory types
    stabilityCritical: ['constraint', 'identity', 'core_preference'],

    // Infrastructure changes
    infrastructurePatterns: [
      /\b(server|host|node)\s+\w+\s+(is|has|runs)\b/i,
      /\b(config|configuration|setting)\b/i,
      /\b(deploy|deployment|rollout)\b/i,
      /\b(production|prod)\b/i
    ],

    // Low confidence threshold
    lowConfidenceThreshold: 0.5
  },

  // Buffer only (don't promote at all without explicit request)
  bufferOnly: {
    veryLowConfidence: 0.3,
    ephemeralPatterns: [
      /\b(maybe|perhaps|might|could be)\b/i,
      /\b(i think|i guess|probably)\b/i,
      /\b(not sure|uncertain)\b/i
    ]
  }
}

/**
 * Explicit command patterns that trigger auto-promotion
 */
export const EXPLICIT_COMMAND_PATTERNS = [
  /\b(remember|memorize|save|store|record)\s+(this|that)\b/i,
  /\b(always|never)\s+(do|use|prefer|avoid)\b/i,
  /\b(my\s+)?(preference|rule|constraint)\s+(is|:)\b/i,
  /\b(don't\s+forget|keep\s+in\s+mind)\b/i,
  /\b(note\s+that|important\s*:)\b/i,
  /\b(i\s+)?(want|need|require)\s+you\s+to\b/i
]

// ============================================================================
// CONFIRMATION QUEUE
// ============================================================================

// In-memory queue for pending confirmations
let confirmationQueue = []
let candidateBuffer = []

// Event listeners
const listeners = new Set()

/**
 * Get current confirmation queue
 */
export function getConfirmationQueue() {
  return [...confirmationQueue]
}

/**
 * Get candidate buffer (items not promoted)
 */
export function getCandidateBuffer() {
  return [...candidateBuffer]
}

/**
 * Add listener for queue changes
 */
export function onQueueChange(callback) {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

/**
 * Notify listeners of queue change
 */
function notifyListeners() {
  for (const listener of listeners) {
    try {
      listener({
        queue: confirmationQueue,
        buffer: candidateBuffer
      })
    } catch (e) {
      console.error('Queue listener error:', e)
    }
  }
}

/**
 * Load queue from localStorage
 */
export function loadQueue() {
  try {
    const stored = localStorage.getItem('quox_confirmation_queue')
    if (stored) {
      confirmationQueue = JSON.parse(stored)
    }
    const buffered = localStorage.getItem('quox_candidate_buffer')
    if (buffered) {
      candidateBuffer = JSON.parse(buffered)
    }
  } catch (e) {
    console.error('Failed to load confirmation queue:', e)
  }
}

/**
 * Save queue to localStorage
 */
function saveQueue() {
  try {
    localStorage.setItem('quox_confirmation_queue', JSON.stringify(confirmationQueue))
    localStorage.setItem('quox_candidate_buffer', JSON.stringify(candidateBuffer))
  } catch (e) {
    console.error('Failed to save confirmation queue:', e)
  }
}

// ============================================================================
// CANDIDATE EVALUATION
// ============================================================================

/**
 * Evaluate a memory candidate for promotion
 *
 * @param {Object} candidate - Memory candidate
 * @returns {Object} - Decision with action and reasons
 */
export function evaluateForPromotion(candidate) {
  const content = candidate.content || ''
  const provenance = candidate.provenance || {}
  const confidence = candidate.confidence?.score || 0.7
  const type = candidate.type || 'fact'

  const reasons = []

  // Check auto-promote conditions
  // 1. Explicit command
  if (isExplicitCommand(content)) {
    return {
      action: 'auto_promote',
      reasons: ['Explicit memory command detected'],
      confidence: 0.95
    }
  }

  // 2. Tool verified
  if (provenance.source === 'tool_output') {
    return {
      action: 'auto_promote',
      reasons: ['Verified by tool output'],
      confidence: 0.95
    }
  }

  // 3. High confidence
  if (confidence >= PROMOTION_CRITERIA.autoPromote.highConfidence) {
    return {
      action: 'auto_promote',
      reasons: [`High confidence (${(confidence * 100).toFixed(0)}%)`],
      confidence
    }
  }

  // Check buffer-only conditions (very low confidence)
  if (confidence < PROMOTION_CRITERIA.bufferOnly.veryLowConfidence) {
    return {
      action: 'buffer_only',
      reasons: [`Very low confidence (${(confidence * 100).toFixed(0)}%)`],
      confidence
    }
  }

  // Check ephemeral patterns
  for (const pattern of PROMOTION_CRITERIA.bufferOnly.ephemeralPatterns) {
    if (pattern.test(content)) {
      reasons.push('Contains uncertainty markers')
      return {
        action: 'buffer_only',
        reasons,
        confidence
      }
    }
  }

  // Check requires confirmation conditions
  // 1. Sensitive patterns
  for (const pattern of PROMOTION_CRITERIA.requiresConfirmation.sensitivePatterns) {
    if (pattern.test(content)) {
      reasons.push('Contains sensitive information')
      return {
        action: 'requires_confirmation',
        reasons,
        sensitivity: 'high',
        confidence
      }
    }
  }

  // 2. Stability-critical types
  if (PROMOTION_CRITERIA.requiresConfirmation.stabilityCritical.includes(type)) {
    reasons.push(`Stability-critical type: ${type}`)
    return {
      action: 'requires_confirmation',
      reasons,
      sensitivity: 'medium',
      confidence
    }
  }

  // 3. Infrastructure patterns
  for (const pattern of PROMOTION_CRITERIA.requiresConfirmation.infrastructurePatterns) {
    if (pattern.test(content)) {
      reasons.push('Infrastructure-related change')
      return {
        action: 'requires_confirmation',
        reasons,
        sensitivity: 'medium',
        confidence
      }
    }
  }

  // 4. Low confidence
  if (confidence < PROMOTION_CRITERIA.requiresConfirmation.lowConfidenceThreshold) {
    reasons.push(`Low confidence (${(confidence * 100).toFixed(0)}%)`)
    return {
      action: 'requires_confirmation',
      reasons,
      sensitivity: 'low',
      confidence
    }
  }

  // Default: auto-promote if no concerns found
  return {
    action: 'auto_promote',
    reasons: ['No concerns detected'],
    confidence
  }
}

/**
 * Check if text contains explicit memory command
 */
export function isExplicitCommand(text) {
  for (const pattern of EXPLICIT_COMMAND_PATTERNS) {
    if (pattern.test(text)) {
      return true
    }
  }
  return false
}

// ============================================================================
// TWO-STAGE COMMIT PIPELINE
// ============================================================================

/**
 * Process a memory candidate through the two-stage pipeline
 *
 * @param {Object} candidate - Memory candidate from extraction
 * @returns {Object} - Processing result
 */
export async function processCandidate(candidate) {
  const decision = evaluateForPromotion(candidate)

  const enrichedCandidate = {
    ...candidate,
    id: candidate.id || `candidate_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    evaluatedAt: new Date().toISOString(),
    decision
  }

  switch (decision.action) {
    case 'auto_promote':
      return await commitMemory(enrichedCandidate)

    case 'requires_confirmation':
      await queueForConfirmation(enrichedCandidate)
      return {
        status: 'queued',
        candidate: enrichedCandidate,
        message: 'Queued for user confirmation'
      }

    case 'buffer_only':
      bufferCandidate(enrichedCandidate)
      return {
        status: 'buffered',
        candidate: enrichedCandidate,
        message: 'Stored in candidate buffer (not promoted)'
      }

    default:
      return {
        status: 'unknown',
        candidate: enrichedCandidate,
        message: 'Unknown decision action'
      }
  }
}

/**
 * Commit a memory directly (auto-promote or approved)
 */
export async function commitMemory(candidate) {
  const mm = getMemoryManager()
  const type = candidate.type || 'fact'

  // Build provenance
  const provenance = {
    source: candidate.decision?.action === 'auto_promote'
      ? (isExplicitCommand(candidate.content) ? 'explicit_command' : candidate.provenance?.source || 'model_inference')
      : 'user_stated',  // Approved by user
    createdBy: candidate.provenance?.createdBy || 'system',
    ...(candidate.provenance || {})
  }

  // Add to memory
  const result = mm.addLearnedItem(type, {
    content: candidate.content,
    ...candidate.metadata
  }, {
    source: provenance.source,
    createdBy: provenance.createdBy,
    stability: candidate.stability || 'stable'
  })

  if (result) {
    // Remove from queue if it was there
    removeFromQueue(candidate.id)
    removeFromBuffer(candidate.id)

    return {
      status: 'committed',
      memory: result,
      candidate
    }
  }

  return {
    status: 'failed',
    error: 'Failed to commit memory',
    candidate
  }
}

/**
 * Queue a candidate for user confirmation
 */
export async function queueForConfirmation(candidate) {
  // Check for duplicates
  const existing = confirmationQueue.find(c => c.id === candidate.id)
  if (existing) {
    return existing
  }

  confirmationQueue.push({
    ...candidate,
    queuedAt: new Date().toISOString()
  })

  saveQueue()
  notifyListeners()

  return candidate
}

/**
 * Buffer a candidate (keep but don't promote)
 */
export function bufferCandidate(candidate) {
  // Keep buffer size manageable
  if (candidateBuffer.length >= 100) {
    candidateBuffer.shift()  // Remove oldest
  }

  candidateBuffer.push({
    ...candidate,
    bufferedAt: new Date().toISOString()
  })

  saveQueue()
  notifyListeners()

  return candidate
}

/**
 * Remove from confirmation queue
 */
export function removeFromQueue(candidateId) {
  const index = confirmationQueue.findIndex(c => c.id === candidateId)
  if (index >= 0) {
    confirmationQueue.splice(index, 1)
    saveQueue()
    notifyListeners()
    return true
  }
  return false
}

/**
 * Remove from candidate buffer
 */
export function removeFromBuffer(candidateId) {
  const index = candidateBuffer.findIndex(c => c.id === candidateId)
  if (index >= 0) {
    candidateBuffer.splice(index, 1)
    saveQueue()
    notifyListeners()
    return true
  }
  return false
}

// ============================================================================
// USER ACTIONS
// ============================================================================

/**
 * Approve a queued candidate
 */
export async function approveCandidate(candidateId, options = {}) {
  const candidate = confirmationQueue.find(c => c.id === candidateId)
  if (!candidate) {
    return { success: false, error: 'Candidate not found in queue' }
  }

  // Apply any edits
  if (options.editedContent) {
    candidate.content = options.editedContent
  }

  // Override type if specified
  if (options.type) {
    candidate.type = options.type
  }

  // Set provenance to user_stated since user approved
  candidate.provenance = {
    ...candidate.provenance,
    source: 'user_stated',
    approvedBy: 'human.user',
    approvedAt: new Date().toISOString()
  }

  const result = await commitMemory(candidate)

  return {
    success: result.status === 'committed',
    result
  }
}

/**
 * Reject a queued candidate
 */
export function rejectCandidate(candidateId, reason = null) {
  const removed = removeFromQueue(candidateId)

  if (removed) {
    // Log rejection for learning
    console.log(`[MemoryConfirmation] Rejected: ${candidateId}`, reason)
  }

  return { success: removed, reason }
}

/**
 * Promote a buffered candidate (user explicitly requests)
 */
export async function promoteFromBuffer(candidateId) {
  const candidate = candidateBuffer.find(c => c.id === candidateId)
  if (!candidate) {
    return { success: false, error: 'Candidate not found in buffer' }
  }

  // User explicitly promoting = high confidence
  candidate.provenance = {
    ...candidate.provenance,
    source: 'user_stated',
    promotedBy: 'human.user',
    promotedAt: new Date().toISOString()
  }

  const result = await commitMemory(candidate)

  return {
    success: result.status === 'committed',
    result
  }
}

/**
 * Clear entire queue
 */
export function clearQueue() {
  confirmationQueue = []
  saveQueue()
  notifyListeners()
}

/**
 * Clear candidate buffer
 */
export function clearBuffer() {
  candidateBuffer = []
  saveQueue()
  notifyListeners()
}

// ============================================================================
// BATCH OPERATIONS
// ============================================================================

/**
 * Process multiple candidates
 */
export async function processCandidates(candidates) {
  const results = {
    committed: [],
    queued: [],
    buffered: [],
    failed: []
  }

  for (const candidate of candidates) {
    const result = await processCandidate(candidate)

    switch (result.status) {
      case 'committed':
        results.committed.push(result)
        break
      case 'queued':
        results.queued.push(result)
        break
      case 'buffered':
        results.buffered.push(result)
        break
      default:
        results.failed.push(result)
    }
  }

  return results
}

/**
 * Approve all queued candidates
 */
export async function approveAll() {
  const results = []

  for (const candidate of [...confirmationQueue]) {
    const result = await approveCandidate(candidate.id)
    results.push(result)
  }

  return results
}

/**
 * Reject all queued candidates
 */
export function rejectAll(reason = 'Bulk rejection') {
  const count = confirmationQueue.length
  confirmationQueue = []
  saveQueue()
  notifyListeners()

  return { rejected: count, reason }
}

// ============================================================================
// STATS AND REPORTING
// ============================================================================

/**
 * Get confirmation stats
 */
export function getConfirmationStats() {
  const now = Date.now()
  const oneDay = 24 * 60 * 60 * 1000

  return {
    queueLength: confirmationQueue.length,
    bufferLength: candidateBuffer.length,
    oldestQueued: confirmationQueue.length > 0
      ? confirmationQueue[0].queuedAt
      : null,
    recentQueued: confirmationQueue.filter(c =>
      now - new Date(c.queuedAt).getTime() < oneDay
    ).length,
    bySensitivity: {
      high: confirmationQueue.filter(c => c.decision?.sensitivity === 'high').length,
      medium: confirmationQueue.filter(c => c.decision?.sensitivity === 'medium').length,
      low: confirmationQueue.filter(c => c.decision?.sensitivity === 'low').length
    },
    byType: confirmationQueue.reduce((acc, c) => {
      const type = c.type || 'unknown'
      acc[type] = (acc[type] || 0) + 1
      return acc
    }, {})
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

// Load queue on module load
loadQueue()

export default {
  PROMOTION_CRITERIA,
  EXPLICIT_COMMAND_PATTERNS,
  getConfirmationQueue,
  getCandidateBuffer,
  onQueueChange,
  evaluateForPromotion,
  isExplicitCommand,
  processCandidate,
  processCandidates,
  commitMemory,
  queueForConfirmation,
  bufferCandidate,
  approveCandidate,
  rejectCandidate,
  promoteFromBuffer,
  approveAll,
  rejectAll,
  clearQueue,
  clearBuffer,
  getConfirmationStats
}
