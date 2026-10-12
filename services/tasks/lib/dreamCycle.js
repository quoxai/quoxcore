/**
 * QuoxDream Consolidation Cycle — QMD-E
 *
 * Periodic job that reviews recent session journals from memory service
 * and extracts recurring themes into wisdom entries.
 *
 * Like sleep consolidation in the brain: scattered daily experiences
 * are compressed into durable patterns.
 *
 * Runs every 6 hours (configurable). Each cycle:
 * 1. Fetches session_journal memories from last 24 hours
 * 2. Groups by topic and agent patterns
 * 3. If a pattern appears 3+ times, creates a wisdom entry
 * 4. Records the consolidation cycle itself as a journal entry
 */

import { recordWisdom, searchWisdom } from './wisdomStore.js'
import { persistDreamCycle, computeDreamStats } from './dreamStats.js'
import { getDatabase } from '../db/index.js'
import { isPluginLicensed } from './licenseGate.js'
import { analyseObjective } from './analyser.js'

const MEMORY_URL = `http://${process.env.MEMORY_HOST || 'memory'}:${process.env.MEMORY_PORT || '3103'}`
const AUTH_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''
const CYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000  // 6 hours
const MIN_PATTERN_OCCURRENCES = 1
const LOOKBACK_HOURS = 24
// TRUST-GATE-MT: bound per-tick org fan-out (reflection-bloat lesson —
// see collector/lib/reflectionMiningScheduler.js TRUST-GATE-1.25 header).
const MAX_ORGS_PER_CYCLE = 25

let cycleTimer = null
let lastCycleAt = null
let cycleCount = 0
let themesExtracted = 0

/**
 * Run one dream consolidation cycle.
 *
 * QMH-4d: gated to quoxmind-complete. Free + Pro orgs skip the cycle —
 * no journals fetched, no wisdom written. The scheduler still runs once
 * per process but each org's cycle is no-op'd if its license is below
 * Complete tier.
 *
 * @param {Object} [opts]
 * @param {string} [opts.orgId='default']
 */
export async function runDreamCycle({ orgId = 'default' } = {}) {
  if (!(await isPluginLicensed(orgId, 'quoxmind-complete'))) {
    console.log(`[QuoxDream] org ${orgId} not licensed for dream consolidation — skipping`)
    return { skipped: true, reason: 'license_required', requiredPlugin: 'quoxmind-complete' }
  }

  console.log('[QuoxDream] Consolidation cycle starting...')
  const cycleStart = Date.now()
  const startedAt = new Date(cycleStart).toISOString()

  try {
    // 1. Fetch recent session journals from memory service
    // TRUST-GATE-MT: journals are stored under the REAL org_id — fetching
    // 'default' meant real-org journals were never consolidated.
    const journals = await fetchSessionJournals(orgId)
    if (journals.length < MIN_PATTERN_OCCURRENCES) {
      console.log(`[QuoxDream] Only ${journals.length} journals found — need ${MIN_PATTERN_OCCURRENCES}+ for consolidation. Skipping.`)
      lastCycleAt = new Date().toISOString()
      cycleCount++
      persistCycleSafely({
        orgId,
        journalsProcessed: journals.length,
        patternsFound: 0,
        wisdomCreated: 0,
        durationMs: Date.now() - cycleStart,
        skipped: true,
        startedAt,
      })
      return { consolidated: 0, journals: journals.length, skipped: true }
    }

    // 2. Extract patterns from journals
    const patterns = extractPatterns(journals)

    // 3. Create wisdom entries for recurring patterns
    let wisdomCreated = 0
    for (const pattern of patterns) {
      if (pattern.occurrences >= MIN_PATTERN_OCCURRENCES) {
        // Check if wisdom already exists for this pattern (per-org — this
        // exists-check is also the dedup that keeps repeat cycles no-op)
        const existing = searchWisdom(orgId, pattern.name, { minConfidence: 0, limit: 1 })
        if (existing.length > 0) {
          console.log(`[QuoxDream] Pattern "${pattern.name}" already in wisdom store (conf ${existing[0].confidence})`)
          continue
        }

        recordWisdom(orgId, {
          patternName: `dream_${pattern.name}`,
          category: 'observation',
          lesson: pattern.lesson,
          directive: null,
          severity: 'low',
          tags: ['dream-cycle', 'session-pattern', ...pattern.tags],
          sourceObjectiveId: null,
        })
        wisdomCreated++
        themesExtracted++
        console.log(`[QuoxDream] New wisdom: "${pattern.name}" (${pattern.occurrences} occurrences)`)
      }
    }

    const duration = Date.now() - cycleStart
    lastCycleAt = new Date().toISOString()
    cycleCount++

    persistCycleSafely({
      orgId,
      journalsProcessed: journals.length,
      patternsFound: patterns.length,
      wisdomCreated,
      durationMs: duration,
      skipped: false,
      startedAt,
    })

    console.log(`[QuoxDream] Cycle complete: ${journals.length} journals → ${patterns.length} patterns → ${wisdomCreated} new wisdom (${duration}ms)`)

    return {
      consolidated: wisdomCreated,
      journals: journals.length,
      patterns: patterns.length,
      duration_ms: duration,
    }
  } catch (err) {
    console.error('[QuoxDream] Consolidation cycle failed:', err.message)
    lastCycleAt = new Date().toISOString()
    cycleCount++
    persistCycleSafely({
      orgId,
      journalsProcessed: 0,
      patternsFound: 0,
      wisdomCreated: 0,
      durationMs: Date.now() - cycleStart,
      skipped: false,
      error: err.message,
      startedAt,
    })
    return { consolidated: 0, error: err.message }
  }
}

// Persistence is best-effort: a cycle that ran successfully should not be
// wiped out if the DB write fails for some unrelated reason.
function persistCycleSafely(args) {
  try {
    persistDreamCycle(getDatabase(), args)
  } catch (err) {
    console.error('[QuoxDream] persistDreamCycle failed (non-fatal):', err.message)
  }
}

/**
 * Fetch session journal entries from the memory service for one org.
 */
async function fetchSessionJournals(orgId = 'default') {
  try {
    const resp = await fetch(`${MEMORY_URL}/api/memories/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': SERVICE_KEY,
      },
      body: JSON.stringify({
        org_id: orgId,
        query: 'session_journal',
        tags: ['session_journal'],
        limit: 50,
      }),
      signal: AbortSignal.timeout(10000),
    })

    if (!resp.ok) return []
    const data = await resp.json()
    return data.memories || data.results || []
  } catch {
    return []
  }
}

/**
 * TRUST-GATE-MT: enumerate live org ids from the auth service — same
 * internal endpoint + service-key path the reflection mining scheduler uses
 * (GET /api/internal/orgs/list, services/auth/routes/internal-orgs.js).
 * Falls back to ['default'] when auth is unreachable so a single-tenant/dev
 * box keeps its historical behavior.
 */
async function fetchLiveOrgIds() {
  try {
    const resp = await fetch(`${AUTH_URL}/api/internal/orgs/list`, {
      headers: { 'X-Service-Key': SERVICE_KEY },
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return ['default']
    const data = await resp.json()
    const ids = (data.orgIds || data.orgs || data.organizations || [])
      .map(o => (typeof o === 'string' ? o : o.id))
      .filter(Boolean)
    return ids.length > 0 ? ids : ['default']
  } catch {
    return ['default']
  }
}

/**
 * Extract recurring patterns from journal entries.
 */
function extractPatterns(journals) {
  const agentCounts = {}
  const topicCounts = {}
  const qualityIssues = []

  for (const journal of journals) {
    // Parse metadata if available
    let meta = {}
    try {
      meta = typeof journal.metadata === 'string' ? JSON.parse(journal.metadata) : (journal.metadata || {})
    } catch { /* ignore */ }

    // Count agent usage
    const agents = meta.agents_used || []
    for (const agent of agents) {
      agentCounts[agent] = (agentCounts[agent] || 0) + 1
    }

    // Count topics
    const topics = meta.topics || []
    for (const topic of topics) {
      const normalised = topic.toLowerCase().trim()
      if (normalised.length > 3) {
        topicCounts[normalised] = (topicCounts[normalised] || 0) + 1
      }
    }

    // Track quality issues
    if (meta.avg_quality != null && meta.avg_quality < 50) {
      qualityIssues.push({ session: meta.session_id, quality: meta.avg_quality, agents })
    }
  }

  const patterns = []

  // Agent usage patterns
  for (const [agent, count] of Object.entries(agentCounts)) {
    if (count >= MIN_PATTERN_OCCURRENCES) {
      patterns.push({
        name: `frequent_agent_${agent}`,
        occurrences: count,
        lesson: `Agent ${agent.toUpperCase()} was used in ${count} of the last ${journals.length} sessions. This is a frequently relied-upon specialist.`,
        tags: ['agent-usage', agent],
      })
    }
  }

  // Topic patterns
  for (const [topic, count] of Object.entries(topicCounts)) {
    if (count >= MIN_PATTERN_OCCURRENCES) {
      patterns.push({
        name: `recurring_topic_${topic.replace(/\s+/g, '_').substring(0, 30)}`,
        occurrences: count,
        lesson: `Topic "${topic}" appeared in ${count} sessions. This is a recurring area of interest or operational concern.`,
        tags: ['recurring-topic'],
      })
    }
  }

  // Quality concern patterns
  if (qualityIssues.length >= MIN_PATTERN_OCCURRENCES) {
    patterns.push({
      name: 'recurring_quality_issues',
      occurrences: qualityIssues.length,
      lesson: `${qualityIssues.length} sessions had quality scores below 50%. This may indicate tool availability issues, prompt quality problems, or agent capability gaps.`,
      tags: ['quality', 'concern'],
    })
  }

  return patterns
}

/**
 * Get dream cycle stats for the Mirror.
 *
 * QMH-2: prefers durable signal from dream_cycles table for the requested
 * org. Falls back to module-level counters (legacy callers without an orgId
 * in scope, or DB unavailable) so existing /api/engine/dream callers keep
 * working without breakage during the transition.
 */
export function getDreamStats(orgId = 'default') {
  try {
    const stats = computeDreamStats(getDatabase(), { orgId })
    return {
      cycleCount: stats.cycleCount,
      lastCycleAt: stats.lastCycleAt,
      themesExtracted: stats.themesExtracted,
      cycles24h: stats.cycles24h,
      journalsProcessed24h: stats.journalsProcessed24h,
      wisdomCreated24h: stats.wisdomCreated24h,
      skippedRatio: stats.skippedRatio,
      healthScore: stats.healthScore,
      intervalHours: CYCLE_INTERVAL_MS / 3600000,
    }
  } catch (err) {
    console.warn('[QuoxDream] computeDreamStats failed, falling back to in-memory:', err.message)
    return {
      cycleCount,
      lastCycleAt,
      themesExtracted,
      intervalHours: CYCLE_INTERVAL_MS / 3600000,
      fallback: true,
    }
  }
}

/**
 * TRUST-GATE-MT: run one cycle per live org (was a single hardcoded
 * 'default' cycle — real-org journals never consolidated). Sequential, not
 * parallel, and capped at MAX_ORGS_PER_CYCLE per tick; the per-org license
 * gate inside runDreamCycle no-ops unlicensed orgs cheaply.
 */
let orgRotationOffset = 0

async function runDreamCycleAllOrgs() {
  const orgIds = await fetchLiveOrgIds()
  // Rotate the starting point each tick so a cap below the live-org count
  // never starves the tail (60 live orgs on this box; fixed first-25 would
  // process the same 25 forever).
  const start = orgIds.length > 0 ? orgRotationOffset % orgIds.length : 0
  const rotated = orgIds.slice(start).concat(orgIds.slice(0, start))
  const capped = rotated.slice(0, MAX_ORGS_PER_CYCLE)
  orgRotationOffset = (start + capped.length) % Math.max(orgIds.length, 1)
  if (orgIds.length > capped.length) {
    console.warn(`[QuoxDream] ${orgIds.length} live orgs — processing ${capped.length} this tick from offset ${start} (MAX_ORGS_PER_CYCLE)`)
  }
  for (const orgId of capped) {
    try {
      await runDreamCycle({ orgId })
    } catch (err) {
      console.error(`[QuoxDream] cycle failed for org ${orgId} (continuing):`, err.message)
    }
  }
}

/**
 * Start the dream cycle timer.
 */
export function startDreamCycle() {
  if (cycleTimer) return
  console.log(`[QuoxDream] Consolidation cycle scheduled every ${CYCLE_INTERVAL_MS / 3600000}h (per live org)`)
  // Run first cycle after 5 minutes (let system warm up)
  setTimeout(() => {
    runDreamCycleAllOrgs()
    cycleTimer = setInterval(runDreamCycleAllOrgs, CYCLE_INTERVAL_MS)
  }, 5 * 60 * 1000)
}

/**
 * Stop the dream cycle timer.
 */
export function stopDreamCycle() {
  if (cycleTimer) {
    clearInterval(cycleTimer)
    cycleTimer = null
  }
}

/**
 * QMH-4d — reflection license gate.
 *
 * Wraps analyseObjective() with a license check:
 *   - quality_score < 0.9 (post-mortem): always runs for every tier.
 *   - quality_score ≥ 0.9 (success):     runs only for quoxmind-complete.
 *
 * The objective-completion path in dagUtils calls this instead of
 * analyseObjective directly. Returns { ran, skipped, reason } for
 * visibility; failures inside analyseObjective are logged but not
 * rethrown so the completion path doesn't break.
 */
export async function reflectOnOutcome(orgId, objectiveId, outcome) {
  if (!outcome) return { ran: false, skipped: true, reason: 'no_outcome' }

  const isPostMortem = (outcome.quality_score ?? 1) < 0.9
  if (!isPostMortem) {
    const licensed = await isPluginLicensed(orgId, 'quoxmind-complete')
    if (!licensed) {
      return { ran: false, skipped: true, reason: 'license_required', requiredPlugin: 'quoxmind-complete' }
    }
  }

  try {
    analyseObjective(objectiveId, outcome)
    return { ran: true }
  } catch (err) {
    console.warn('[QuoxMind] reflectOnOutcome failed (non-fatal):', err.message)
    return { ran: false, error: err.message }
  }
}
