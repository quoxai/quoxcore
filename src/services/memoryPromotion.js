/**
 * Quox Memory Promotion Pipeline
 *
 * A two-stage system for safely importing external data (ChatGPT, etc.)
 * into the memory system.
 *
 * The problem: Importing thousands of memories from external sources
 * risks polluting the memory system with:
 * - Outdated information
 * - Context-specific facts that don't generalize
 * - Contradictions with current knowledge
 * - Low-quality or inaccurate data
 *
 * The solution: A staged promotion pipeline
 *
 * Stage 1: COLD STORAGE (Quarantine)
 * - All imports go here first
 * - Searchable but NOT injected into context
 * - Preserved for reference and manual review
 *
 * Stage 2: WARM STORAGE (Active Memory)
 * - Promoted memories that passed validation
 * - Actively used in context injection
 * - Subject to normal decay and truth arbitration
 *
 * Promotion criteria:
 * - Manual approval (user explicitly promotes)
 * - Auto-promotion rules (high confidence, verified by tool)
 * - Relevance threshold (accessed multiple times)
 * - Consistency check (doesn't contradict existing memories)
 */

import { ulid } from '../lib/aee/ulid'
import { getMemoryManager } from './memoryManager'
import { findConflictingMemories, calculateTruthScore } from './memoryTruth'
import { hasFailedBefore } from './failureMemory'

// ============================================================================
// CONSTANTS
// ============================================================================

export const STORAGE_TIER = {
  COLD: 'cold',     // Quarantine - not used in context
  WARM: 'warm',     // Active - used in context
  HOT: 'hot',       // Pinned - always included
  ARCHIVED: 'archived', // Manually archived
  REJECTED: 'rejected'  // Explicitly rejected
}

export const PROMOTION_REASON = {
  MANUAL: 'manual',           // User explicitly promoted
  AUTO_HIGH_QUALITY: 'auto_high_quality', // Passed quality checks
  AUTO_VERIFIED: 'auto_verified',     // Verified by tool output
  RELEVANCE: 'relevance',     // Accessed multiple times
  DECAY: 'decay',             // Demoted due to lack of use
  CONTRADICTION: 'contradiction', // Demoted due to conflict
  QUALITY: 'quality',         // Promoted/demoted based on quality
  BATCH: 'batch'              // Part of batch operation
}

export const IMPORT_SOURCE = {
  CHATGPT: 'chatgpt',
  CLAUDE: 'claude',
  GEMINI: 'gemini',
  PERPLEXITY: 'perplexity',
  MANUAL: 'manual',
  TOOL: 'tool',
  REFLECTION: 'reflection',
  MIGRATION: 'migration',
  OTHER: 'other'
}

// ============================================================================
// STORAGE (consolidated into single key for server sync)
//
// D2-PROMOTION-PIPELINE: this used to live under the raw global key
// 'quox-memory-promotion', which was NOT org-scoped, so every org a browser
// had ever visited shared the SAME promotion pipeline blob (the same
// cross-org leak QMH2-CONSOLIDATION fixed for beliefs/WSM/failures/style).
// It now lives under the org+user-scoped personal key ('memory-promotion',
// via personalGet/personalSet, quox_{org}_{user}_memory-promotion) and
// write-throughs to the memory service's identity_blobs store (namespace
// 'promotion'), which is org+user scoped server-side too. The old
// queueSync('memoryPromotion', ...) duplicate write to auth-service
// preferences JSON has been retired (kept as a one-release hydrate-only
// backfill in userPreferences.js).
// ============================================================================

import { personalGet, personalSet } from './orgScopedStorage'
import { getMemoryClient } from './memoryClient'

const PROMOTION_NAMESPACE = 'promotion'
const PROMOTION_MEM_KEY = 'memory-promotion' // -> quox_{org}_{user}_memory-promotion
const LEGACY_CONSOLIDATED_KEY = 'quox-memory-promotion' // pre-fix global key (migrated once, then removed)

const OLD_KEYS = {
  coldStorage: 'quox_cold_storage',
  promotionLog: 'quox_promotion_log',
  promotionRules: 'quox_promotion_rules',
  importStats: 'quox_import_stats'
}

const STORAGE_KEYS = OLD_KEYS

let _consolidated = null

// Debounce the write-through: batchPromote() can call promoteItem() (which
// calls saveStore -> saveConsolidated) up to `limit` (default 100) times in
// a single loop. Without debouncing, that would fire up to 100 sequential
// full-blob PUTs. Last-write-wins is correct here since the identity blob
// is always the full consolidated document.
const WRITE_THROUGH_DEBOUNCE_MS = 1500
let _writeThroughTimer = null

function getConsolidated() {
  if (_consolidated) return _consolidated
  try {
    const raw = personalGet(PROMOTION_MEM_KEY)
    if (raw) {
      _consolidated = JSON.parse(raw)
      return _consolidated
    }
  } catch { /* fall through to migration */ }

  _consolidated = {}
  let migrated = false

  // Migrate the legacy non-org-scoped consolidated blob (the cross-org leak)
  // into the org-scoped personal key.
  try {
    const legacy = localStorage.getItem(LEGACY_CONSOLIDATED_KEY)
    if (legacy) {
      _consolidated = JSON.parse(legacy)
      localStorage.removeItem(LEGACY_CONSOLIDATED_KEY)
      migrated = true
    }
  } catch { /* ignore corrupt legacy data */ }

  // Migrate from old per-key storage (pre-consolidation, also non-org-scoped)
  for (const [field, oldKey] of Object.entries(OLD_KEYS)) {
    if (_consolidated[field]) continue
    try {
      const old = localStorage.getItem(oldKey)
      if (old) {
        _consolidated[field] = JSON.parse(old)
        localStorage.removeItem(oldKey)
        migrated = true
      }
    } catch { /* skip */ }
  }
  if (migrated) {
    saveConsolidated()
    console.log('[MemoryPromotion] Migrated from legacy non-org-scoped storage to org-scoped storage')
  }
  return _consolidated
}

function saveConsolidated() {
  try {
    personalSet(PROMOTION_MEM_KEY, JSON.stringify(_consolidated))
    _promotionWriteThrough()
  } catch (e) {
    console.error('Error saving memory promotion:', e)
  }
}

function _promotionWriteThrough() {
  if (_writeThroughTimer) clearTimeout(_writeThroughTimer)
  _writeThroughTimer = setTimeout(() => {
    _writeThroughTimer = null
    const snapshot = _consolidated
    try {
      getMemoryClient().setIdentity(PROMOTION_NAMESPACE, snapshot).catch(err => {
        console.warn('[MemoryPromotion] Identity write-through failed:', err.message)
      })
    } catch (err) {
      console.warn('[MemoryPromotion] Identity write-through error:', err.message)
    }
  }, WRITE_THROUGH_DEBOUNCE_MS)
}

/**
 * Hydrate the org-scoped memory-promotion local cache from the memory
 * service.
 *
 * The promotion pipeline's local cache key is dynamic
 * (quox_{org}_{user}_memory-promotion) so it is NOT covered by
 * memoryManager.hydrateIdentityFromServer(). Must be called AFTER
 * setStorageContext(org, user) is set. Call once on auth and again on
 * every 'quox-org-switch' so switching orgs hydrates the newly-selected
 * org's blob. Never overwrites an existing local cache; best-effort.
 */
export async function hydratePromotionFromServer() {
  try {
    if (personalGet(PROMOTION_MEM_KEY)) return
    const result = await getMemoryClient().getIdentity(PROMOTION_NAMESPACE)
    if (result && result.data !== null && result.data !== undefined) {
      personalSet(PROMOTION_MEM_KEY, JSON.stringify(result.data))
      _consolidated = result.data
    }
  } catch (err) {
    console.warn('[MemoryPromotion] Identity hydration failed:', err.message)
  }
}

// Reset the in-memory cache on org switch so a previous org's promotion
// pipeline data never leaks into the newly-selected org's context
// (getConsolidated() will re-read the now-org-scoped personal key on next
// access). Also clear any pending debounced write so a stale blob is never
// written into the new org.
if (typeof window !== 'undefined') {
  window.addEventListener('quox-org-switch', () => {
    if (_writeThroughTimer) {
      clearTimeout(_writeThroughTimer)
      _writeThroughTimer = null
    }
    _consolidated = null
  })
}

function loadStore(key) {
  const consolidated = getConsolidated()
  const field = Object.entries(OLD_KEYS).find(([, v]) => v === key)?.[0]
  if (!field) return []
  if (consolidated[field] !== undefined) return consolidated[field]
  return key === STORAGE_KEYS.promotionRules ? getDefaultRules() : []
}

function saveStore(key, data) {
  const consolidated = getConsolidated()
  const field = Object.entries(OLD_KEYS).find(([, v]) => v === key)?.[0]
  if (field) {
    consolidated[field] = data
    _consolidated = consolidated
    saveConsolidated()
  }
}

function getDefaultRules() {
  return {
    autoPromote: {
      enabled: true,
      minConfidence: 0.85,
      requireNoConflicts: true,
      maxAge: 365 // days
    },
    autoReject: {
      enabled: true,
      minAge: 730, // 2 years - very old data
      lowQualityPatterns: [
        /^test$/i,
        /^placeholder$/i,
        /^todo$/i,
        /^fixme$/i
      ]
    },
    relevancePromotion: {
      enabled: true,
      accessCountThreshold: 3,
      timeWindowDays: 30
    }
  }
}

// ============================================================================
// COLD STORAGE MANAGEMENT
// ============================================================================

/**
 * Add items to cold storage (quarantine)
 */
export function addToColdStorage(items, options = {}) {
  const {
    source = IMPORT_SOURCE.OTHER,
    importId = ulid(),
    metadata = {}
  } = options

  const coldStorage = loadStore(STORAGE_KEYS.coldStorage)

  const processed = items.map(item => ({
    id: ulid(),
    content: item.content,
    type: item.type || 'fact',
    tier: STORAGE_TIER.COLD,

    // Source tracking
    source,
    importId,
    originalId: item.id || null,
    originalTimestamp: item.timestamp || null,

    // Quality signals
    confidence: item.confidence || 0.5,
    quality: item.quality || null,
    topics: item.topics || [],
    entities: item.entities || [],

    // Promotion tracking
    accessCount: 0,
    lastAccessed: null,
    promotionAttempts: 0,
    promotionBlocked: null,

    // Metadata
    metadata: {
      ...metadata,
      ...item.metadata
    },

    // Timestamps
    importedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }))

  coldStorage.push(...processed)
  saveStore(STORAGE_KEYS.coldStorage, coldStorage)

  // Update import stats
  updateImportStats(source, processed.length)

  return {
    added: processed.length,
    importId,
    items: processed
  }
}

/**
 * Search cold storage (for reference, not context injection)
 */
export function searchColdStorage(query, options = {}) {
  const { limit = 20, source = null, type = null, minConfidence = 0 } = options
  const coldStorage = loadStore(STORAGE_KEYS.coldStorage)
  const queryLower = query.toLowerCase()
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2)

  return coldStorage
    .filter(item => {
      if (item.tier !== STORAGE_TIER.COLD) return false
      if (source && item.source !== source) return false
      if (type && item.type !== type) return false
      if (item.confidence < minConfidence) return false
      return true
    })
    .map(item => {
      const contentLower = item.content.toLowerCase()
      let score = 0

      queryWords.forEach(word => {
        if (contentLower.includes(word)) score += 1
      })

      item.topics.forEach(topic => {
        if (queryLower.includes(topic.toLowerCase())) score += 2
      })

      item.entities.forEach(entity => {
        if (queryLower.includes(entity.toLowerCase())) score += 2
      })

      return { ...item, searchScore: score }
    })
    .filter(item => item.searchScore > 0)
    .sort((a, b) => b.searchScore - a.searchScore)
    .slice(0, limit)
}

/**
 * Record access to cold storage item (for relevance tracking)
 */
export function recordColdAccess(itemId) {
  const coldStorage = loadStore(STORAGE_KEYS.coldStorage)
  const idx = coldStorage.findIndex(i => i.id === itemId)

  if (idx === -1) return null

  coldStorage[idx].accessCount++
  coldStorage[idx].lastAccessed = new Date().toISOString()
  coldStorage[idx].updatedAt = new Date().toISOString()

  saveStore(STORAGE_KEYS.coldStorage, coldStorage)

  // Check if should auto-promote based on relevance
  const rules = loadStore(STORAGE_KEYS.promotionRules)
  if (rules.relevancePromotion.enabled) {
    if (coldStorage[idx].accessCount >= rules.relevancePromotion.accessCountThreshold) {
      // Check time window
      const firstAccess = coldStorage[idx].importedAt
      const daysSinceImport = (Date.now() - new Date(firstAccess).getTime()) / (1000 * 60 * 60 * 24)

      if (daysSinceImport <= rules.relevancePromotion.timeWindowDays) {
        // Auto-promote due to relevance
        return promoteItem(itemId, {
          reason: PROMOTION_REASON.RELEVANCE,
          notes: `Accessed ${coldStorage[idx].accessCount} times within ${Math.round(daysSinceImport)} days`
        })
      }
    }
  }

  return coldStorage[idx]
}

// ============================================================================
// PROMOTION OPERATIONS
// ============================================================================

/**
 * Validate an item for promotion
 */
export async function validateForPromotion(itemId) {
  const coldStorage = loadStore(STORAGE_KEYS.coldStorage)
  const item = coldStorage.find(i => i.id === itemId)

  if (!item) {
    return { valid: false, reason: 'Item not found' }
  }

  const issues = []
  const warnings = []

  // Check confidence
  const rules = loadStore(STORAGE_KEYS.promotionRules)
  if (item.confidence < rules.autoPromote.minConfidence) {
    warnings.push(`Low confidence: ${Math.round(item.confidence * 100)}%`)
  }

  // Check age
  const originalDate = item.originalTimestamp || item.importedAt
  const age = (Date.now() - new Date(originalDate).getTime()) / (1000 * 60 * 60 * 24)
  if (age > rules.autoPromote.maxAge) {
    warnings.push(`Old data: ${Math.round(age)} days old`)
  }

  if (age > rules.autoReject.minAge) {
    issues.push(`Very old data: ${Math.round(age)} days old (threshold: ${rules.autoReject.minAge})`)
  }

  // Check quality patterns
  for (const pattern of rules.autoReject.lowQualityPatterns) {
    if (pattern.test(item.content)) {
      issues.push(`Low quality pattern detected: ${pattern}`)
      break
    }
  }

  // Check for contradictions with existing memory
  try {
    const mm = getMemoryManager()
    const existingMemories = await mm.getLearnedMemories(item.content)

    if (existingMemories.length > 0) {
      const conflicts = await findConflictingMemories(
        { content: item.content, type: item.type },
        existingMemories
      )

      if (conflicts.length > 0) {
        if (rules.autoPromote.requireNoConflicts) {
          issues.push(`Conflicts with ${conflicts.length} existing memories`)
        } else {
          warnings.push(`May conflict with ${conflicts.length} existing memories`)
        }
      }
    }
  } catch (e) {
    warnings.push(`Could not check conflicts: ${e.message}`)
  }

  // Check failure memory
  const failureCheck = hasFailedBefore(item.content)
  if (failureCheck.hasFailedBefore) {
    warnings.push(`Similar content has failed before: ${failureCheck.previousFailure.description}`)
  }

  return {
    valid: issues.length === 0,
    canAutoPromote: issues.length === 0 && warnings.length === 0,
    issues,
    warnings,
    item
  }
}

/**
 * Promote an item from cold to warm storage
 */
export async function promoteItem(itemId, options = {}) {
  const {
    reason = PROMOTION_REASON.MANUAL,
    notes = null,
    skipValidation = false,
    targetTier = STORAGE_TIER.WARM
  } = options

  const coldStorage = loadStore(STORAGE_KEYS.coldStorage)
  const idx = coldStorage.findIndex(i => i.id === itemId)

  if (idx === -1) {
    return { success: false, error: 'Item not found' }
  }

  const item = coldStorage[idx]

  // Validate unless skipped
  if (!skipValidation) {
    const validation = await validateForPromotion(itemId)
    if (!validation.valid) {
      item.promotionAttempts++
      item.promotionBlocked = {
        timestamp: new Date().toISOString(),
        reason: validation.issues.join('; ')
      }
      item.updatedAt = new Date().toISOString()
      saveStore(STORAGE_KEYS.coldStorage, coldStorage)

      return {
        success: false,
        error: 'Validation failed',
        issues: validation.issues,
        warnings: validation.warnings
      }
    }
  }

  // Move to active memory system
  try {
    const mm = getMemoryManager()
    await mm.addLearnedItem(item.type, {
      content: item.content,
      provenance: {
        source: `imported:${item.source}`,
        createdBy: `import.${item.source}`,
        createdAt: item.originalTimestamp || item.importedAt,
        importId: item.importId
      },
      confidence: {
        score: item.confidence,
        stability: 'stable'
      },
      topics: item.topics,
      entities: item.entities,
      metadata: {
        ...item.metadata,
        promotedFrom: 'cold_storage',
        promotedAt: new Date().toISOString(),
        promotionReason: reason
      }
    })

    // Update cold storage record
    item.tier = targetTier
    item.promotedAt = new Date().toISOString()
    item.promotionReason = reason
    item.promotionNotes = notes
    item.updatedAt = new Date().toISOString()
    coldStorage[idx] = item
    saveStore(STORAGE_KEYS.coldStorage, coldStorage)

    // Log promotion
    logPromotion({
      itemId,
      fromTier: STORAGE_TIER.COLD,
      toTier: targetTier,
      reason,
      notes
    })

    return {
      success: true,
      item,
      promotedTo: targetTier
    }
  } catch (e) {
    return {
      success: false,
      error: `Failed to add to memory: ${e.message}`
    }
  }
}

/**
 * Reject an item (won't be promoted)
 */
export function rejectItem(itemId, reason = null) {
  const coldStorage = loadStore(STORAGE_KEYS.coldStorage)
  const idx = coldStorage.findIndex(i => i.id === itemId)

  if (idx === -1) return null

  coldStorage[idx].tier = STORAGE_TIER.REJECTED
  coldStorage[idx].rejectedAt = new Date().toISOString()
  coldStorage[idx].rejectionReason = reason
  coldStorage[idx].updatedAt = new Date().toISOString()

  saveStore(STORAGE_KEYS.coldStorage, coldStorage)

  logPromotion({
    itemId,
    fromTier: STORAGE_TIER.COLD,
    toTier: STORAGE_TIER.REJECTED,
    reason: PROMOTION_REASON.MANUAL,
    notes: reason
  })

  return coldStorage[idx]
}

/**
 * Archive an item (keep but don't promote)
 */
export function archiveItem(itemId, reason = null) {
  const coldStorage = loadStore(STORAGE_KEYS.coldStorage)
  const idx = coldStorage.findIndex(i => i.id === itemId)

  if (idx === -1) return null

  coldStorage[idx].tier = STORAGE_TIER.ARCHIVED
  coldStorage[idx].archivedAt = new Date().toISOString()
  coldStorage[idx].archiveReason = reason
  coldStorage[idx].updatedAt = new Date().toISOString()

  saveStore(STORAGE_KEYS.coldStorage, coldStorage)

  return coldStorage[idx]
}

/**
 * Batch promote items matching criteria
 */
export async function batchPromote(criteria = {}, options = {}) {
  const {
    source = null,
    type = null,
    minConfidence = 0.85,
    minAccessCount = 0,
    limit = 100,
    dryRun = false
  } = criteria

  const { skipValidation = false } = options

  const coldStorage = loadStore(STORAGE_KEYS.coldStorage)
  const candidates = coldStorage
    .filter(item => {
      if (item.tier !== STORAGE_TIER.COLD) return false
      if (source && item.source !== source) return false
      if (type && item.type !== type) return false
      if (item.confidence < minConfidence) return false
      if (item.accessCount < minAccessCount) return false
      return true
    })
    .slice(0, limit)

  if (dryRun) {
    return {
      dryRun: true,
      candidateCount: candidates.length,
      candidates: candidates.map(c => ({
        id: c.id,
        content: c.content.substring(0, 100),
        confidence: c.confidence,
        source: c.source
      }))
    }
  }

  const results = {
    promoted: 0,
    failed: 0,
    errors: []
  }

  for (const item of candidates) {
    const result = await promoteItem(item.id, {
      reason: PROMOTION_REASON.BATCH,
      skipValidation
    })

    if (result.success) {
      results.promoted++
    } else {
      results.failed++
      results.errors.push({
        id: item.id,
        error: result.error
      })
    }
  }

  return results
}

// ============================================================================
// PROMOTION RULES
// ============================================================================

/**
 * Get current promotion rules
 */
export function getPromotionRules() {
  return loadStore(STORAGE_KEYS.promotionRules)
}

/**
 * Update promotion rules
 */
export function updatePromotionRules(updates) {
  const rules = loadStore(STORAGE_KEYS.promotionRules)
  const updated = {
    ...rules,
    ...updates,
    autoPromote: { ...rules.autoPromote, ...updates.autoPromote },
    autoReject: { ...rules.autoReject, ...updates.autoReject },
    relevancePromotion: { ...rules.relevancePromotion, ...updates.relevancePromotion }
  }
  saveStore(STORAGE_KEYS.promotionRules, updated)
  return updated
}

// ============================================================================
// LOGGING & STATS
// ============================================================================

function logPromotion(entry) {
  const log = loadStore(STORAGE_KEYS.promotionLog)
  log.push({
    ...entry,
    timestamp: new Date().toISOString()
  })

  // Keep last 1000 entries
  if (log.length > 1000) {
    log.splice(0, log.length - 1000)
  }

  saveStore(STORAGE_KEYS.promotionLog, log)
}

/**
 * Get promotion log
 */
export function getPromotionLog(options = {}) {
  const { limit = 100, reason = null } = options
  let log = loadStore(STORAGE_KEYS.promotionLog)

  if (reason) {
    log = log.filter(e => e.reason === reason)
  }

  return log.slice(-limit).reverse()
}

function updateImportStats(source, count) {
  const stats = loadStore(STORAGE_KEYS.importStats)
  if (!stats[source]) {
    stats[source] = { total: 0, promoted: 0, rejected: 0, lastImport: null }
  }
  stats[source].total += count
  stats[source].lastImport = new Date().toISOString()
  saveStore(STORAGE_KEYS.importStats, stats)
}

/**
 * Get import statistics
 */
export function getImportStats() {
  return loadStore(STORAGE_KEYS.importStats)
}

/**
 * Get cold storage summary
 */
export function getColdStorageSummary() {
  const coldStorage = loadStore(STORAGE_KEYS.coldStorage)

  return {
    total: coldStorage.length,
    byTier: {
      cold: coldStorage.filter(i => i.tier === STORAGE_TIER.COLD).length,
      warm: coldStorage.filter(i => i.tier === STORAGE_TIER.WARM).length,
      hot: coldStorage.filter(i => i.tier === STORAGE_TIER.HOT).length,
      archived: coldStorage.filter(i => i.tier === STORAGE_TIER.ARCHIVED).length,
      rejected: coldStorage.filter(i => i.tier === STORAGE_TIER.REJECTED).length
    },
    bySource: Object.values(IMPORT_SOURCE).reduce((acc, src) => {
      acc[src] = coldStorage.filter(i => i.source === src).length
      return acc
    }, {}),
    byType: coldStorage.reduce((acc, i) => {
      acc[i.type] = (acc[i.type] || 0) + 1
      return acc
    }, {}),
    pendingPromotion: coldStorage.filter(i =>
      i.tier === STORAGE_TIER.COLD &&
      !i.promotionBlocked
    ).length,
    blockedPromotion: coldStorage.filter(i =>
      i.tier === STORAGE_TIER.COLD &&
      i.promotionBlocked
    ).length
  }
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Clean up old rejected/archived items
 */
export function cleanupColdStorage(options = {}) {
  const { maxAgeDays = 180, removeRejected = true, removeArchived = false } = options
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000)
  let coldStorage = loadStore(STORAGE_KEYS.coldStorage)
  const before = coldStorage.length

  coldStorage = coldStorage.filter(item => {
    const itemDate = new Date(item.updatedAt || item.importedAt).getTime()

    // Remove old rejected items
    if (removeRejected && item.tier === STORAGE_TIER.REJECTED && itemDate < cutoff) {
      return false
    }

    // Remove old archived items
    if (removeArchived && item.tier === STORAGE_TIER.ARCHIVED && itemDate < cutoff) {
      return false
    }

    return true
  })

  saveStore(STORAGE_KEYS.coldStorage, coldStorage)

  return {
    removed: before - coldStorage.length,
    remaining: coldStorage.length
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  // Cold storage
  addToColdStorage,
  searchColdStorage,
  recordColdAccess,

  // Promotion
  validateForPromotion,
  promoteItem,
  rejectItem,
  archiveItem,
  batchPromote,

  // Rules
  getPromotionRules,
  updatePromotionRules,

  // Stats & logs
  getPromotionLog,
  getImportStats,
  getColdStorageSummary,

  // Cleanup
  cleanupColdStorage,

  // Server hydration (D2-PROMOTION-PIPELINE)
  hydratePromotionFromServer,

  // Constants
  STORAGE_TIER,
  PROMOTION_REASON,
  IMPORT_SOURCE
}
