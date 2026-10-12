/**
 * Quox Belief & Rationale Memory
 *
 * Tracks the epistemic state of the relationship:
 * - What we KNOW vs what we BELIEVE vs what we're UNCERTAIN about
 * - WHY decisions were made (rationale capture)
 * - Assumptions that may need revisiting
 * - Hypotheses under active investigation
 *
 * This is NOT just memory storage - it's epistemic status tracking.
 * The key insight: Quox shouldn't treat all information equally.
 * Some things are verified facts, others are working hypotheses.
 *
 * Key concepts:
 * - Belief: Something we think is true, with confidence level
 * - Rationale: The reasoning behind a decision
 * - Assumption: Something taken as true without verification
 * - Hypothesis: A working theory under investigation
 *
 * TIERED: Belief Memory is a Premium feature
 */

import { ulid } from '../lib/aee/ulid'
import { hasFeature, createUpgradePrompt } from './memoryTier'

// ============================================================================
// TIER GATING
// ============================================================================

/**
 * Check if Belief Memory is available (Premium only)
 * @returns {{ available: boolean, upgrade?: object }}
 */
export function isBeliefMemoryAvailable() {
  const available = hasFeature('hasBeliefMemory')
  if (!available) {
    return {
      available: false,
      upgrade: createUpgradePrompt('beliefMemory')
    }
  }
  return { available: true }
}

/**
 * Tier-gated wrapper - returns blocked response if plugin not purchased
 * @param {*} defaultReturn - Default return value for free version
 */
function requirePremiumOr(defaultReturn) {
  if (!hasFeature('hasBeliefMemory')) {
    return { blocked: true, reason: 'plugin_required', upgrade: createUpgradePrompt('beliefMemory'), ...defaultReturn }
  }
  return null // No block, continue execution
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const BELIEF_STATUS = {
  FACT: 'fact',           // Verified, high confidence
  BELIEF: 'belief',       // Reasonable confidence, not verified
  ASSUMPTION: 'assumption', // Taken as true, may need verification
  HYPOTHESIS: 'hypothesis', // Under investigation
  UNCERTAIN: 'uncertain',   // Low confidence, conflicting evidence
  DISPROVEN: 'disproven'    // Was believed, now known false
}

export const EVIDENCE_TYPES = {
  USER_STATED: 'user_stated',     // User explicitly said this
  TOOL_OUTPUT: 'tool_output',     // System verified (e.g., command output)
  INFERENCE: 'inference',         // Inferred from context
  OBSERVATION: 'observation',     // Observed behavior pattern
  EXTERNAL: 'external',           // From external source
  CONTRADICTION: 'contradiction'  // Evidence that contradicts
}

export const RATIONALE_TYPES = {
  DECISION: 'decision',           // A choice between alternatives
  PREFERENCE: 'preference',       // A stated preference with reasoning
  CONSTRAINT: 'constraint',       // A limitation with reasoning
  TRADE_OFF: 'trade_off',         // Chose X over Y because Z
  DEFAULT: 'default',             // Using default because no preference
  EXPERIMENT: 'experiment'        // Trying something to see if it works
}

// ============================================================================
// STORAGE — consolidated into single key for server sync
//
// QMH2-CONSOLIDATION BUG FIX: this used to live under the raw global key
// 'quox-belief-memory' — NOT org-scoped, so every org a browser had ever
// visited shared the SAME beliefs blob (a real cross-org leak). It now lives
// under the org+user-scoped personal key ('belief-mem', via
// personalGet/personalSet — quox_{org}_{user}_belief-mem) and write-throughs
// to the memory service's identity_blobs store (namespace 'beliefs'), which
// is org+user scoped server-side too. The old queueSync('beliefMemory', ...)
// duplicate write to auth-service preferences JSON has been retired.
// ============================================================================

import { personalGet, personalSet } from './orgScopedStorage'
import { getMemoryClient } from './memoryClient'

const memoryClient = getMemoryClient()
const BELIEFS_NAMESPACE = 'beliefs'
const BELIEF_MEM_KEY = 'belief-mem' // -> quox_{org}_{user}_belief-mem
const LEGACY_CONSOLIDATED_KEY = 'quox-belief-memory' // pre-fix global key (migrated once, then removed)

// Old per-type keys (for migration)
const OLD_KEYS = {
  beliefs: 'quox_beliefs',
  rationales: 'quox_rationales',
  assumptions: 'quox_assumptions',
  hypotheses: 'quox_hypotheses'
}

// Reverse map for loadStore/saveStore compatibility
const STORAGE_KEYS = OLD_KEYS

let _consolidated = null

function getConsolidated() {
  if (_consolidated) return _consolidated
  try {
    const raw = personalGet(BELIEF_MEM_KEY)
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

  // Migrate from old per-type keys (pre-consolidation, also non-org-scoped)
  for (const [field, oldKey] of Object.entries(OLD_KEYS)) {
    if (_consolidated[field]) continue
    try {
      const old = localStorage.getItem(oldKey)
      if (old) {
        _consolidated[field] = JSON.parse(old)
        localStorage.removeItem(oldKey)
        migrated = true
      } else {
        _consolidated[field] = []
      }
    } catch {
      _consolidated[field] = []
    }
  }
  if (migrated) {
    saveConsolidated()
    console.log('[BeliefMemory] Migrated from legacy non-org-scoped storage to org-scoped storage')
  }
  return _consolidated
}

function saveConsolidated() {
  try {
    personalSet(BELIEF_MEM_KEY, JSON.stringify(_consolidated))
    _beliefsWriteThrough(_consolidated)
  } catch (e) {
    console.error('Error saving belief memory:', e)
  }
}

function _beliefsWriteThrough(data) {
  try {
    memoryClient.setIdentity(BELIEFS_NAMESPACE, data).catch(err => {
      console.warn('[BeliefMemory] Identity write-through failed:', err.message)
    })
  } catch (err) {
    console.warn('[BeliefMemory] Identity write-through error:', err.message)
  }
}

/**
 * Hydrate the org-scoped belief-mem local cache from the memory service.
 *
 * Beliefs' local cache key is dynamic (quox_{org}_{user}_belief-mem) so it
 * is NOT covered by memoryManager.hydrateIdentityFromServer(). Must be
 * called AFTER setStorageContext(org, user) is set — call once on auth and
 * again on every 'quox-org-switch' so switching orgs hydrates the newly-
 * selected org's blob. Never overwrites an existing local cache; best-effort.
 */
export async function hydrateBeliefsFromServer() {
  try {
    if (personalGet(BELIEF_MEM_KEY)) return
    const result = await memoryClient.getIdentity(BELIEFS_NAMESPACE)
    if (result && result.data !== null && result.data !== undefined) {
      personalSet(BELIEF_MEM_KEY, JSON.stringify(result.data))
      _consolidated = result.data
    }
  } catch (err) {
    console.warn('[BeliefMemory] Identity hydration failed:', err.message)
  }
}

// Reset the in-memory cache on org switch so a previous org's beliefs never
// leak into the newly-selected org's context (getConsolidated() will
// re-read the now-org-scoped personal key on next access).
if (typeof window !== 'undefined') {
  window.addEventListener('quox-org-switch', () => {
    _consolidated = null
  })
}

function loadStore(key) {
  const consolidated = getConsolidated()
  const field = Object.entries(OLD_KEYS).find(([, v]) => v === key)?.[0]
  return field ? (consolidated[field] || []) : []
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

// ============================================================================
// BELIEF MANAGEMENT
// ============================================================================

/**
 * Record a belief with its epistemic status and evidence
 * TIERED: Premium only
 */
export function recordBelief({
  content,
  status = BELIEF_STATUS.BELIEF,
  confidence = 0.7,
  evidence = [],
  domain = 'general',
  relatedTo = [],
  source = null,
  expiresAt = null,
  notes = null
}) {
  // TIER CHECK: Belief memory requires Premium
  const blocked = requirePremiumOr({ belief: null })
  if (blocked) return blocked

  const beliefs = loadStore(STORAGE_KEYS.beliefs)

  const belief = {
    id: ulid(),
    content,
    status,
    confidence,
    evidence: evidence.map(e => ({
      type: e.type || EVIDENCE_TYPES.USER_STATED,
      content: e.content,
      timestamp: e.timestamp || new Date().toISOString(),
      source: e.source || null,
      weight: e.weight || 0.5
    })),
    domain,
    relatedTo,
    source,
    expiresAt,
    notes,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    verifiedAt: status === BELIEF_STATUS.FACT ? new Date().toISOString() : null,
    revisitCount: 0,
    history: []
  }

  beliefs.push(belief)
  saveStore(STORAGE_KEYS.beliefs, beliefs)

  return belief
}

/**
 * Update a belief's status based on new evidence
 */
export function updateBeliefStatus(beliefId, {
  newStatus,
  newConfidence = null,
  newEvidence = null,
  reason = null
}) {
  const beliefs = loadStore(STORAGE_KEYS.beliefs)
  const idx = beliefs.findIndex(b => b.id === beliefId)

  if (idx === -1) return null

  const belief = beliefs[idx]

  // Record history
  belief.history.push({
    timestamp: new Date().toISOString(),
    previousStatus: belief.status,
    previousConfidence: belief.confidence,
    newStatus,
    newConfidence: newConfidence || belief.confidence,
    reason
  })

  // Update
  belief.status = newStatus
  if (newConfidence !== null) belief.confidence = newConfidence
  if (newEvidence) {
    belief.evidence.push({
      type: newEvidence.type || EVIDENCE_TYPES.USER_STATED,
      content: newEvidence.content,
      timestamp: new Date().toISOString(),
      source: newEvidence.source || null,
      weight: newEvidence.weight || 0.5
    })
  }
  belief.updatedAt = new Date().toISOString()
  if (newStatus === BELIEF_STATUS.FACT) {
    belief.verifiedAt = new Date().toISOString()
  }

  beliefs[idx] = belief
  saveStore(STORAGE_KEYS.beliefs, beliefs)

  return belief
}

/**
 * Add evidence to a belief
 */
export function addEvidenceToBelief(beliefId, evidence) {
  const beliefs = loadStore(STORAGE_KEYS.beliefs)
  const idx = beliefs.findIndex(b => b.id === beliefId)

  if (idx === -1) return null

  const belief = beliefs[idx]
  belief.evidence.push({
    type: evidence.type || EVIDENCE_TYPES.USER_STATED,
    content: evidence.content,
    timestamp: new Date().toISOString(),
    source: evidence.source || null,
    weight: evidence.weight || 0.5
  })

  // Recalculate confidence based on evidence
  const totalWeight = belief.evidence.reduce((sum, e) => sum + e.weight, 0)
  if (totalWeight > 0) {
    // Weighted average, but cap at 0.95 for beliefs (only tool output can hit 1.0)
    const maxConfidence = belief.evidence.some(e => e.type === EVIDENCE_TYPES.TOOL_OUTPUT) ? 1.0 : 0.95
    belief.confidence = Math.min(maxConfidence, 0.5 + (totalWeight * 0.1))
  }

  belief.updatedAt = new Date().toISOString()
  beliefs[idx] = belief
  saveStore(STORAGE_KEYS.beliefs, beliefs)

  return belief
}

/**
 * Get beliefs by status
 */
export function getBeliefsByStatus(status) {
  const beliefs = loadStore(STORAGE_KEYS.beliefs)
  return beliefs.filter(b => b.status === status)
}

/**
 * Get beliefs by domain
 */
export function getBeliefsByDomain(domain) {
  const beliefs = loadStore(STORAGE_KEYS.beliefs)
  return beliefs.filter(b => b.domain === domain)
}

/**
 * Find beliefs that might be relevant to a query
 */
export function findRelevantBeliefs(query, options = {}) {
  const { minConfidence = 0, includeDisproven = false, limit = 10 } = options
  const beliefs = loadStore(STORAGE_KEYS.beliefs)
  const queryLower = query.toLowerCase()
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2)

  return beliefs
    .filter(b => {
      if (b.confidence < minConfidence) return false
      if (!includeDisproven && b.status === BELIEF_STATUS.DISPROVEN) return false
      return true
    })
    .map(b => {
      const contentLower = b.content.toLowerCase()
      let score = 0

      // Keyword matching
      queryWords.forEach(word => {
        if (contentLower.includes(word)) score += 1
      })

      // Related entity matching
      b.relatedTo.forEach(entity => {
        if (queryLower.includes(entity.toLowerCase())) score += 2
      })

      // Confidence boost
      score *= (0.5 + b.confidence * 0.5)

      // Status boost (facts > beliefs > hypotheses)
      const statusBoost = {
        [BELIEF_STATUS.FACT]: 1.5,
        [BELIEF_STATUS.BELIEF]: 1.2,
        [BELIEF_STATUS.ASSUMPTION]: 1.0,
        [BELIEF_STATUS.HYPOTHESIS]: 0.8,
        [BELIEF_STATUS.UNCERTAIN]: 0.6
      }
      score *= (statusBoost[b.status] || 1.0)

      return { ...b, relevanceScore: score }
    })
    .filter(b => b.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, limit)
}

/**
 * Get beliefs that need verification (assumptions, low confidence)
 */
export function getBeliefsNeedingVerification() {
  const beliefs = loadStore(STORAGE_KEYS.beliefs)
  return beliefs.filter(b =>
    b.status === BELIEF_STATUS.ASSUMPTION ||
    b.status === BELIEF_STATUS.UNCERTAIN ||
    (b.status === BELIEF_STATUS.BELIEF && b.confidence < 0.6)
  )
}

// ============================================================================
// RATIONALE MANAGEMENT
// ============================================================================

/**
 * Record the rationale behind a decision
 * TIERED: Premium only
 */
export function recordRationale({
  decision,
  type = RATIONALE_TYPES.DECISION,
  reasoning,
  alternatives = [],
  factors = [],
  constraints = [],
  tradeOffs = [],
  confidence = 0.8,
  relatedTo = [],
  domain = 'general',
  outcome = null,
  revisitTriggers = []
}) {
  // TIER CHECK: Belief memory requires Premium
  const blocked = requirePremiumOr({ rationale: null })
  if (blocked) return blocked

  const rationales = loadStore(STORAGE_KEYS.rationales)

  const rationale = {
    id: ulid(),
    decision,
    type,
    reasoning,
    alternatives: alternatives.map(a => ({
      option: a.option,
      rejectedBecause: a.rejectedBecause || null
    })),
    factors: factors.map(f => ({
      factor: f.factor,
      weight: f.weight || 'medium',
      direction: f.direction || 'for' // 'for' or 'against'
    })),
    constraints,
    tradeOffs,
    confidence,
    relatedTo,
    domain,
    outcome,
    revisitTriggers,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revisitedAt: null,
    outcomeRecordedAt: outcome ? new Date().toISOString() : null,
    stillValid: true
  }

  rationales.push(rationale)
  saveStore(STORAGE_KEYS.rationales, rationales)

  return rationale
}

/**
 * Record the outcome of a decision
 */
export function recordDecisionOutcome(rationaleId, {
  outcome,
  success = null,
  lessonsLearned = [],
  wouldDecideDifferently = false,
  newRecommendation = null
}) {
  const rationales = loadStore(STORAGE_KEYS.rationales)
  const idx = rationales.findIndex(r => r.id === rationaleId)

  if (idx === -1) return null

  const rationale = rationales[idx]
  rationale.outcome = outcome
  rationale.outcomeRecordedAt = new Date().toISOString()
  rationale.success = success
  rationale.lessonsLearned = lessonsLearned
  rationale.wouldDecideDifferently = wouldDecideDifferently
  rationale.newRecommendation = newRecommendation
  rationale.updatedAt = new Date().toISOString()

  rationales[idx] = rationale
  saveStore(STORAGE_KEYS.rationales, rationales)

  return rationale
}

/**
 * Invalidate a rationale (the decision is no longer valid)
 */
export function invalidateRationale(rationaleId, reason) {
  const rationales = loadStore(STORAGE_KEYS.rationales)
  const idx = rationales.findIndex(r => r.id === rationaleId)

  if (idx === -1) return null

  const rationale = rationales[idx]
  rationale.stillValid = false
  rationale.invalidatedAt = new Date().toISOString()
  rationale.invalidationReason = reason
  rationale.updatedAt = new Date().toISOString()

  rationales[idx] = rationale
  saveStore(STORAGE_KEYS.rationales, rationales)

  return rationale
}

/**
 * Find rationales relevant to a query
 */
export function findRelevantRationales(query, options = {}) {
  const { includeInvalid = false, limit = 10 } = options
  const rationales = loadStore(STORAGE_KEYS.rationales)
  const queryLower = query.toLowerCase()
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2)

  return rationales
    .filter(r => includeInvalid || r.stillValid)
    .map(r => {
      const decisionLower = r.decision.toLowerCase()
      const reasoningLower = r.reasoning.toLowerCase()
      let score = 0

      queryWords.forEach(word => {
        if (decisionLower.includes(word)) score += 2
        if (reasoningLower.includes(word)) score += 1
      })

      r.relatedTo.forEach(entity => {
        if (queryLower.includes(entity.toLowerCase())) score += 2
      })

      return { ...r, relevanceScore: score }
    })
    .filter(r => r.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, limit)
}

/**
 * Get rationales by domain
 */
export function getRationalesByDomain(domain) {
  const rationales = loadStore(STORAGE_KEYS.rationales)
  return rationales.filter(r => r.domain === domain && r.stillValid)
}

/**
 * Check if any rationales have triggered revisit conditions
 */
export function checkRevisitTriggers(context) {
  const rationales = loadStore(STORAGE_KEYS.rationales)
  const triggered = []

  rationales.forEach(r => {
    if (!r.stillValid || !r.revisitTriggers.length) return

    r.revisitTriggers.forEach(trigger => {
      let shouldTrigger = false

      switch (trigger.type) {
        case 'time_elapsed':
          const elapsed = Date.now() - new Date(r.createdAt).getTime()
          const threshold = trigger.value * 24 * 60 * 60 * 1000 // days to ms
          shouldTrigger = elapsed > threshold
          break

        case 'keyword':
          shouldTrigger = trigger.value.some(kw =>
            context.toLowerCase().includes(kw.toLowerCase())
          )
          break

        case 'entity_mentioned':
          shouldTrigger = trigger.value.some(entity =>
            context.toLowerCase().includes(entity.toLowerCase())
          )
          break

        case 'condition_changed':
          // This would need external verification
          break
      }

      if (shouldTrigger) {
        triggered.push({
          rationale: r,
          trigger,
          reason: `Revisit trigger activated: ${trigger.type}`
        })
      }
    })
  })

  return triggered
}

// ============================================================================
// ASSUMPTION MANAGEMENT
// ============================================================================

/**
 * Record an assumption that we're treating as true
 * TIERED: Premium only
 */
export function recordAssumption({
  content,
  basis = null,
  validUntil = null,
  verificationMethod = null,
  domain = 'general',
  relatedTo = [],
  critical = false
}) {
  // TIER CHECK: Belief memory requires Premium
  const blocked = requirePremiumOr({ assumption: null })
  if (blocked) return blocked

  const assumptions = loadStore(STORAGE_KEYS.assumptions)

  const assumption = {
    id: ulid(),
    content,
    basis, // Why we're assuming this
    validUntil,
    verificationMethod, // How to verify this
    domain,
    relatedTo,
    critical, // If false, affects critical decisions
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    verifiedAt: null,
    invalidatedAt: null,
    invalidationReason: null
  }

  assumptions.push(assumption)
  saveStore(STORAGE_KEYS.assumptions, assumptions)

  return assumption
}

/**
 * Verify an assumption (promote to belief/fact)
 */
export function verifyAssumption(assumptionId, {
  verified = true,
  evidence = null,
  notes = null
}) {
  const assumptions = loadStore(STORAGE_KEYS.assumptions)
  const idx = assumptions.findIndex(a => a.id === assumptionId)

  if (idx === -1) return null

  const assumption = assumptions[idx]
  assumption.status = verified ? 'verified' : 'invalidated'
  assumption.verifiedAt = verified ? new Date().toISOString() : null
  assumption.invalidatedAt = !verified ? new Date().toISOString() : null
  assumption.verificationEvidence = evidence
  assumption.verificationNotes = notes
  assumption.updatedAt = new Date().toISOString()

  assumptions[idx] = assumption
  saveStore(STORAGE_KEYS.assumptions, assumptions)

  // If verified, create a belief
  if (verified) {
    recordBelief({
      content: assumption.content,
      status: BELIEF_STATUS.BELIEF,
      confidence: 0.85,
      evidence: evidence ? [{ type: EVIDENCE_TYPES.OBSERVATION, content: evidence }] : [],
      domain: assumption.domain,
      relatedTo: assumption.relatedTo,
      notes: `Promoted from assumption: ${assumption.id}`
    })
  }

  return assumption
}

/**
 * Get active assumptions
 */
export function getActiveAssumptions() {
  const assumptions = loadStore(STORAGE_KEYS.assumptions)
  return assumptions.filter(a => a.status === 'active')
}

/**
 * Get critical assumptions that affect important decisions
 */
export function getCriticalAssumptions() {
  const assumptions = loadStore(STORAGE_KEYS.assumptions)
  return assumptions.filter(a => a.critical && a.status === 'active')
}

// ============================================================================
// HYPOTHESIS MANAGEMENT
// ============================================================================

/**
 * Record a hypothesis under investigation
 * TIERED: Premium only
 */
export function recordHypothesis({
  statement,
  motivation,
  testPlan = [],
  expectedEvidence = [],
  domain = 'general',
  relatedTo = [],
  priority = 'medium'
}) {
  // TIER CHECK: Belief memory requires Premium
  const blocked = requirePremiumOr({ hypothesis: null })
  if (blocked) return blocked

  const hypotheses = loadStore(STORAGE_KEYS.hypotheses)

  const hypothesis = {
    id: ulid(),
    statement,
    motivation, // Why we care about this
    testPlan, // How to test it
    expectedEvidence, // What would confirm/refute
    evidenceCollected: [],
    domain,
    relatedTo,
    priority,
    status: 'investigating',
    conclusion: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resolvedAt: null
  }

  hypotheses.push(hypothesis)
  saveStore(STORAGE_KEYS.hypotheses, hypotheses)

  return hypothesis
}

/**
 * Add evidence to a hypothesis
 */
export function addHypothesisEvidence(hypothesisId, evidence) {
  const hypotheses = loadStore(STORAGE_KEYS.hypotheses)
  const idx = hypotheses.findIndex(h => h.id === hypothesisId)

  if (idx === -1) return null

  const hypothesis = hypotheses[idx]
  hypothesis.evidenceCollected.push({
    content: evidence.content,
    supports: evidence.supports, // true = supports hypothesis, false = refutes
    strength: evidence.strength || 'medium',
    source: evidence.source || null,
    timestamp: new Date().toISOString()
  })
  hypothesis.updatedAt = new Date().toISOString()

  hypotheses[idx] = hypothesis
  saveStore(STORAGE_KEYS.hypotheses, hypotheses)

  return hypothesis
}

/**
 * Resolve a hypothesis
 */
export function resolveHypothesis(hypothesisId, {
  confirmed,
  conclusion,
  confidence = 0.8
}) {
  const hypotheses = loadStore(STORAGE_KEYS.hypotheses)
  const idx = hypotheses.findIndex(h => h.id === hypothesisId)

  if (idx === -1) return null

  const hypothesis = hypotheses[idx]
  hypothesis.status = confirmed ? 'confirmed' : 'refuted'
  hypothesis.conclusion = conclusion
  hypothesis.resolvedAt = new Date().toISOString()
  hypothesis.updatedAt = new Date().toISOString()

  hypotheses[idx] = hypothesis
  saveStore(STORAGE_KEYS.hypotheses, hypotheses)

  // If confirmed, create a belief
  if (confirmed) {
    recordBelief({
      content: hypothesis.statement,
      status: BELIEF_STATUS.BELIEF,
      confidence,
      evidence: hypothesis.evidenceCollected.map(e => ({
        type: EVIDENCE_TYPES.OBSERVATION,
        content: e.content,
        weight: e.strength === 'strong' ? 0.8 : e.strength === 'medium' ? 0.5 : 0.3
      })),
      domain: hypothesis.domain,
      relatedTo: hypothesis.relatedTo,
      notes: `Confirmed from hypothesis: ${hypothesis.id}. ${conclusion}`
    })
  }

  return hypothesis
}

/**
 * Get active hypotheses
 */
export function getActiveHypotheses() {
  const hypotheses = loadStore(STORAGE_KEYS.hypotheses)
  return hypotheses.filter(h => h.status === 'investigating')
}

// ============================================================================
// CONTEXT GENERATION
// ============================================================================

/**
 * Generate epistemic context for prompt injection
 * TIERED: Requires Advanced Memory Plugin - returns empty context for free version
 */
export function generateBeliefContext(options = {}) {
  // TIER CHECK: Belief context requires Advanced Memory Plugin
  if (!hasFeature('hasBeliefMemory')) {
    return { context: '', estimatedTokens: 0, withinBudget: true }
  }

  const {
    maxTokens = 400,
    includeHypotheses = true,
    includeAssumptions = true,
    query = null
  } = options

  const lines = []
  let estimatedTokens = 0
  const tokensPerLine = 15 // rough estimate

  // Get relevant beliefs
  const beliefs = query
    ? findRelevantBeliefs(query, { limit: 5 })
    : getBeliefsByStatus(BELIEF_STATUS.FACT).slice(0, 5)

  if (beliefs.length > 0) {
    lines.push('### Known Facts & Beliefs')
    beliefs.forEach(b => {
      const status = b.status === BELIEF_STATUS.FACT ? '' : ` (${b.status}, ${Math.round(b.confidence * 100)}%)`
      lines.push(`- ${b.content}${status}`)
    })
    lines.push('')
  }

  estimatedTokens = lines.length * tokensPerLine
  if (estimatedTokens >= maxTokens) {
    return { context: lines.join('\n'), estimatedTokens, withinBudget: true }
  }

  // Active hypotheses
  if (includeHypotheses) {
    const hypotheses = getActiveHypotheses().slice(0, 3)
    if (hypotheses.length > 0) {
      lines.push('### Active Investigations')
      hypotheses.forEach(h => {
        lines.push(`- ${h.statement}`)
        if (h.evidenceCollected.length > 0) {
          const supporting = h.evidenceCollected.filter(e => e.supports).length
          const refuting = h.evidenceCollected.filter(e => !e.supports).length
          lines.push(`  Evidence: ${supporting} supporting, ${refuting} refuting`)
        }
      })
      lines.push('')
    }
  }

  estimatedTokens = lines.length * tokensPerLine
  if (estimatedTokens >= maxTokens) {
    return { context: lines.join('\n'), estimatedTokens, withinBudget: true }
  }

  // Critical assumptions
  if (includeAssumptions) {
    const assumptions = getCriticalAssumptions().slice(0, 3)
    if (assumptions.length > 0) {
      lines.push('### Working Assumptions')
      assumptions.forEach(a => {
        lines.push(`- ${a.content}`)
        if (a.basis) lines.push(`  (Basis: ${a.basis})`)
      })
      lines.push('')
    }
  }

  const context = lines.join('\n')
  estimatedTokens = lines.length * tokensPerLine

  return {
    context,
    estimatedTokens,
    withinBudget: estimatedTokens <= maxTokens
  }
}

/**
 * Get a summary of epistemic state
 */
export function getEpistemicSummary() {
  const beliefs = loadStore(STORAGE_KEYS.beliefs)
  const rationales = loadStore(STORAGE_KEYS.rationales)
  const assumptions = loadStore(STORAGE_KEYS.assumptions)
  const hypotheses = loadStore(STORAGE_KEYS.hypotheses)

  return {
    beliefs: {
      total: beliefs.length,
      byStatus: {
        facts: beliefs.filter(b => b.status === BELIEF_STATUS.FACT).length,
        beliefs: beliefs.filter(b => b.status === BELIEF_STATUS.BELIEF).length,
        uncertain: beliefs.filter(b => b.status === BELIEF_STATUS.UNCERTAIN).length,
        hypotheses: beliefs.filter(b => b.status === BELIEF_STATUS.HYPOTHESIS).length
      },
      needingVerification: getBeliefsNeedingVerification().length
    },
    rationales: {
      total: rationales.length,
      valid: rationales.filter(r => r.stillValid).length,
      withOutcome: rationales.filter(r => r.outcome).length
    },
    assumptions: {
      total: assumptions.length,
      active: assumptions.filter(a => a.status === 'active').length,
      critical: assumptions.filter(a => a.critical && a.status === 'active').length
    },
    hypotheses: {
      total: hypotheses.length,
      investigating: hypotheses.filter(h => h.status === 'investigating').length,
      confirmed: hypotheses.filter(h => h.status === 'confirmed').length,
      refuted: hypotheses.filter(h => h.status === 'refuted').length
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  // Tier Gating
  isBeliefMemoryAvailable,

  // Beliefs
  recordBelief,
  updateBeliefStatus,
  addEvidenceToBelief,
  getBeliefsByStatus,
  getBeliefsByDomain,
  findRelevantBeliefs,
  getBeliefsNeedingVerification,

  // Rationales
  recordRationale,
  recordDecisionOutcome,
  invalidateRationale,
  findRelevantRationales,
  getRationalesByDomain,
  checkRevisitTriggers,

  // Assumptions
  recordAssumption,
  verifyAssumption,
  getActiveAssumptions,
  getCriticalAssumptions,

  // Hypotheses
  recordHypothesis,
  addHypothesisEvidence,
  resolveHypothesis,
  getActiveHypotheses,

  // Context
  generateBeliefContext,
  getEpistemicSummary,

  // Server hydration (QMH2-CONSOLIDATION)
  hydrateBeliefsFromServer,

  // Constants
  BELIEF_STATUS,
  EVIDENCE_TYPES,
  RATIONALE_TYPES
}
