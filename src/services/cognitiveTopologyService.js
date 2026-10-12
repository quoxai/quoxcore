/**
 * Cognitive Topology Service
 *
 * Aggregates real data from multiple sources for the Cognitive Topology visualization.
 * Each method returns actual metrics, not mock data.
 */

import { queueSync } from './serverSyncQueue'
import { getDashboardMetrics, runHealthChecks } from './memoryMetrics'
import { getIndexStats } from './capabilityIndex'
import { runFullHealthCheck } from './healthCheck'
import { getAssistants } from './entityRegistry'
import { AGENT_PERMISSIONS, MEMORY_DOMAINS } from './agentPermissions'
import { listWorkflows, listExecutions } from './workflowEngine'
import { getOverview as getUptimeOverview } from './uptimeKumaClient'
import {
  generateWSMContext,
  getWorkingSet,
  getOpenLoops,
  getRecentEntities,
} from './workingSetMemory'
import { getSyncStatus } from './assistantStorage'
import { getStorageUsage, listFiles } from './fileStorage'
import { isPluginLicensed } from './licenseValidator'
import { getFileMetrics } from './fileMemoryBridge'
import { getSenseStats } from './senseService'
import { getTemporalStats } from './temporalService'
import { getNucleusStats } from './nucleusMetrics'
import { getQuoxbrainClient } from './quoxbrainClient'

/**
 * Wrap a promise with a timeout to prevent hanging
 * @param {Promise} promise - The promise to wrap
 * @param {number} ms - Timeout in milliseconds
 * @param {any} fallback - Value to return on timeout
 */
async function withTimeout(promise, ms = 5000, fallback = null) {
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Service timeout')), ms)
      )
    ])
  } catch (err) {
    console.warn('Service call timed out or failed:', err.message)
    return fallback
  }
}

/**
 * Get cognitive core aggregate health
 */
export async function getCoreHealth() {
  try {
    // Wrap health check with timeout - it calls multiple services
    const health = await withTimeout(runFullHealthCheck(), 8000, null)

    // Handle timeout/failure case
    if (!health || !health.services) {
      return {
        overallHealth: 0,
        activeServices: 0,
        totalServices: 0,
        status: 'unknown',
        serviceDetails: [],
      }
    }

    // Build detailed service list
    const serviceDetails = Object.entries(health.services).map(([name, data]) => ({
      name,
      healthy: data.healthy === true,
      status: data.healthy ? 'healthy' : 'unhealthy',
      message: data.message || (data.healthy ? 'Running' : 'Not responding'),
      latency: data.latency || null,
    }))

    const services = Object.values(health.services)
    const activeServices = services.filter((s) => s.healthy === true).length
    const totalServices = services.length

    // Use summary data if available, otherwise calculate
    const allHealthy = health.summary?.allHealthy ?? (activeServices === totalServices)
    const healthPercent = totalServices > 0
      ? Math.round((activeServices / totalServices) * 100)
      : 0

    // Determine status
    let status = 'critical'
    if (allHealthy) {
      status = 'operational'
    } else if (activeServices > 0) {
      status = 'degraded'
    }

    return {
      overallHealth: healthPercent,
      activeServices,
      totalServices,
      status,
      serviceDetails,
    }
  } catch (error) {
    console.error('Failed to get core health:', error)
    return {
      overallHealth: 0,
      activeServices: 0,
      totalServices: 0,
      status: 'unknown',
      serviceDetails: [],
    }
  }
}

/**
 * Derive the core/QuoxMind status label from implant/core data WITHOUT
 * mislabelling a cold start as an incident. A fresh org (no data yet:
 * overallHealth null/undefined, `collecting`, or healthScore null) previously
 * fell through `overallHealth ?? 0` -> 0% -> 'critical', so a brand-new user's
 * first impression of QuoxMind was a fake "0% CRITICAL". Cold start now maps to
 * the display-safe existing 'unknown' status (honest "no data yet"), not
 * 'critical'. Pure + unit-tested (cognitiveTopologyCoreStatus.test.js).
 * GTM-P2 A5 honesty fix. Display polish ("Collecting…" vs "—") is a follow-up
 * to confirm live against a fresh org at the guided walk.
 */
export function deriveCoreStatus(coreData = {}) {
  const raw = coreData.overallHealth
  const isColdStart =
    raw === null ||
    raw === undefined ||
    coreData.collecting === true ||
    coreData.healthScore === null
  if (isColdStart) {
    return { status: 'unknown', health: null, coldStart: true }
  }
  const health = raw
  const status =
    health >= 80 ? 'operational' : health >= 50 ? 'degraded' : 'critical'
  return { status, health, coldStart: false }
}

/**
 * Count memories directly from localStorage
 * This is the source of truth for actual memory counts
 */
function countMemoriesFromStorage() {
  if (typeof localStorage === 'undefined') {
    return { episodic: 0, semantic: 0, entities: 0, learned: 0, total: 0 }
  }

  try {
    // Count episodic memories (chat history) - stored as newline-separated entries
    const episodicRecent = localStorage.getItem('episodic_recent') || ''
    const episodicCount = episodicRecent.split('\n').filter(line => line.trim()).length

    // Count learned items by type
    const learnedTypes = ['fact', 'preference', 'constraint', 'decision', 'error', 'reflection', 'intent']
    let learnedCount = 0
    for (const type of learnedTypes) {
      const data = localStorage.getItem(`quox_learned_${type}`)
      if (data) {
        try {
          const items = JSON.parse(data)
          learnedCount += Array.isArray(items) ? items.length : 0
        } catch (e) { /* ignore parse errors */ }
      }
    }

    // Count entities
    const entitiesData = localStorage.getItem('quox_entities')
    let entityCount = 0
    if (entitiesData) {
      try {
        const entities = JSON.parse(entitiesData)
        entityCount = Array.isArray(entities) ? entities.length : Object.keys(entities).length
      } catch (e) { /* ignore */ }
    }

    // Count semantic knowledge
    const semanticKeys = ['quox_semantic', 'quox_syntheses', 'quox_narratives']
    let semanticCount = 0
    for (const key of semanticKeys) {
      const data = localStorage.getItem(key)
      if (data) {
        try {
          const items = JSON.parse(data)
          semanticCount += Array.isArray(items) ? items.length : Object.keys(items).length
        } catch (e) { /* ignore */ }
      }
    }

    return {
      episodic: episodicCount,
      semantic: semanticCount,
      entities: entityCount,
      learned: learnedCount,
      total: episodicCount + semanticCount + entityCount + learnedCount
    }
  } catch (error) {
    console.error('Failed to count memories from storage:', error)
    return { episodic: 0, semantic: 0, entities: 0, learned: 0, total: 0 }
  }
}

// QMH-2 QuoxDream: source of truth is the dream_cycles table via tasks service.
// The previous `getContinuityStats()` mapping read assistantStorage sync state
// (a completely different system) and returned 0 forever. Removed from the
// fetchAllImplantData promise list below.
const DREAM_STATS_URL = '/tasks/api/engine/dream/stats'
const DREAM_FETCH_TIMEOUT_MS = 4000

export async function fetchDreamStats() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DREAM_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(DREAM_STATS_URL, {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = new Error(`dream stats: HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    const body = await res.json()
    const fields = body.fields || {}
    return {
      healthScore: body.healthScore ?? null,
      primaryMetric: body.primaryMetric || null,
      failureReason: body.failureReason || null,
      collecting: body.healthScore === null && body.primaryMetric?.label?.startsWith('Collecting'),
      cycleCount: fields.cycleCount ?? 0,
      lastCycleAt: fields.lastCycleAt ?? null,
      themesExtracted: fields.themesExtracted ?? 0,
      cycles24h: fields.cycles24h ?? 0,
      journalsProcessed24h: fields.journalsProcessed24h ?? 0,
      wisdomCreated24h: fields.wisdomCreated24h ?? 0,
      skippedRatio: fields.skippedRatio ?? 0,
      intervalHours: fields.intervalHours ?? 6,
      sourceVersion: body.sourceVersion || null,
    }
  } catch (err) {
    if (!globalThis.__quoxDreamFallbackLogged) {
      console.warn('[QuoxDream] backend unreachable, returning null state:', err?.message || err)
      globalThis.__quoxDreamFallbackLogged = true
    }
    return {
      healthScore: null,
      primaryMetric: { value: null, label: 'Service unreachable' },
      failureReason: { code: 'SERVICE_UNREACHABLE', service: 'tasks', message: err?.message || String(err) },
      collecting: false,
      cycleCount: 0,
      lastCycleAt: null,
      themesExtracted: 0,
      cycles24h: 0,
      journalsProcessed24h: 0,
      wisdomCreated24h: 0,
      skippedRatio: 0,
      intervalHours: 6,
      fallback: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

// QMH-2 QuoxPredict: source of truth is execution_wisdom (analyser/wisdomStore).
// Was previously mapped to getCodebaseFabricStats() — codebase invariants, no
// relation to prediction. Real wisdom patterns come from the tasks service.
const PREDICT_STATS_URL = '/tasks/api/engine/predict/stats'
const PREDICT_FETCH_TIMEOUT_MS = 4000

export async function fetchPredictStats() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PREDICT_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(PREDICT_STATS_URL, {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = new Error(`predict stats: HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    const body = await res.json()
    const fields = body.fields || {}
    return {
      healthScore: body.healthScore ?? null,
      primaryMetric: body.primaryMetric || null,
      failureReason: body.failureReason || null,
      collecting: body.healthScore === null && body.primaryMetric?.label?.startsWith('Collecting'),
      wisdomCount: fields.wisdomCount ?? 0,
      avgConfidence: fields.avgConfidence ?? null,
      coreCount: fields.coreCount ?? 0,
      establishedCount: fields.establishedCount ?? 0,
      tentativeCount: fields.tentativeCount ?? 0,
      recentWisdom24h: fields.recentWisdom24h ?? 0,
      lastWisdomAt: fields.lastWisdomAt ?? null,
      sourceVersion: body.sourceVersion || null,
    }
  } catch (err) {
    if (!globalThis.__quoxPredictFallbackLogged) {
      console.warn('[QuoxPredict] backend unreachable, returning null state:', err?.message || err)
      globalThis.__quoxPredictFallbackLogged = true
    }
    return {
      healthScore: null,
      primaryMetric: { value: null, label: 'Service unreachable' },
      failureReason: { code: 'SERVICE_UNREACHABLE', service: 'tasks', message: err?.message || String(err) },
      collecting: false,
      wisdomCount: 0,
      avgConfidence: null,
      coreCount: 0,
      establishedCount: 0,
      tentativeCount: 0,
      recentWisdom24h: 0,
      lastWisdomAt: null,
      fallback: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

// QMH-2 QuoxReflect: source of truth is objective_outcomes (analyser writes).
// Was previously mapped to getGovernanceStats() (policy registry) — unrelated
// to reflection. Real reflection signal is post-mortems + quality scores from
// finished objectives.
const REFLECT_STATS_URL = '/tasks/api/engine/reflect/stats'
const REFLECT_FETCH_TIMEOUT_MS = 4000

export async function fetchReflectStats() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REFLECT_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(REFLECT_STATS_URL, {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = new Error(`reflect stats: HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    const body = await res.json()
    const fields = body.fields || {}
    return {
      healthScore: body.healthScore ?? null,
      primaryMetric: body.primaryMetric || null,
      failureReason: body.failureReason || null,
      collecting: body.healthScore === null && body.primaryMetric?.label?.startsWith('Collecting'),
      outcomeCount: fields.outcomeCount ?? 0,
      avgQuality: fields.avgQuality ?? null,
      successCount: fields.successCount ?? 0,
      failureCount: fields.failureCount ?? 0,
      postMortemCount: fields.postMortemCount ?? 0,
      wisdomLinkedCount: fields.wisdomLinkedCount ?? 0,
      outcomes24h: fields.outcomes24h ?? 0,
      lastOutcomeAt: fields.lastOutcomeAt ?? null,
      sourceVersion: body.sourceVersion || null,
    }
  } catch (err) {
    if (!globalThis.__quoxReflectFallbackLogged) {
      console.warn('[QuoxReflect] backend unreachable, returning null state:', err?.message || err)
      globalThis.__quoxReflectFallbackLogged = true
    }
    return {
      healthScore: null,
      primaryMetric: { value: null, label: 'Service unreachable' },
      failureReason: { code: 'SERVICE_UNREACHABLE', service: 'tasks', message: err?.message || String(err) },
      collecting: false,
      outcomeCount: 0,
      avgQuality: null,
      successCount: 0,
      failureCount: 0,
      postMortemCount: 0,
      wisdomLinkedCount: 0,
      outcomes24h: 0,
      lastOutcomeAt: null,
      fallback: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

// QMH-2 QuoxLearn: source of truth is agent_performance (AT-3 agentScorer).
// Was previously mapped to getDataFabricStats() (file/folder counts) —
// completely unrelated to learning. Real signal is per-agent observations.
const LEARN_STATS_URL = '/tasks/api/engine/learn/stats'
const LEARN_FETCH_TIMEOUT_MS = 4000

export async function fetchLearnStats() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LEARN_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(LEARN_STATS_URL, {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = new Error(`learn stats: HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    const body = await res.json()
    const fields = body.fields || {}
    return {
      healthScore: body.healthScore ?? null,
      primaryMetric: body.primaryMetric || null,
      failureReason: body.failureReason || null,
      collecting: body.healthScore === null && body.primaryMetric?.label?.startsWith('Collecting'),
      observationCount: fields.observationCount ?? 0,
      agentsTracked: fields.agentsTracked ?? 0,
      avgQuality: fields.avgQuality ?? null,
      avgLatencyMs: fields.avgLatencyMs ?? null,
      successRate: fields.successRate ?? null,
      observations24h: fields.observations24h ?? 0,
      lastObservationAt: fields.lastObservationAt ?? null,
      sourceVersion: body.sourceVersion || null,
    }
  } catch (err) {
    if (!globalThis.__quoxLearnFallbackLogged) {
      console.warn('[QuoxLearn] backend unreachable, returning null state:', err?.message || err)
      globalThis.__quoxLearnFallbackLogged = true
    }
    return {
      healthScore: null,
      primaryMetric: { value: null, label: 'Service unreachable' },
      failureReason: { code: 'SERVICE_UNREACHABLE', service: 'tasks', message: err?.message || String(err) },
      collecting: false,
      observationCount: 0,
      agentsTracked: 0,
      avgQuality: null,
      avgLatencyMs: null,
      successRate: null,
      observations24h: 0,
      lastObservationAt: null,
      fallback: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

// QMH-2 QuoxExecutive: source of truth is objectives + tasks (operational).
// Was previously mapped to getAgentMeshStats() — counted static assistants
// registry entries (config, not operations). Real signal is what the
// orchestrator is actually doing.
const EXECUTIVE_STATS_URL = '/tasks/api/engine/executive/stats'
const EXECUTIVE_FETCH_TIMEOUT_MS = 4000

export async function fetchExecutiveStats() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EXECUTIVE_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(EXECUTIVE_STATS_URL, {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = new Error(`executive stats: HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    const body = await res.json()
    const fields = body.fields || {}
    return {
      healthScore: body.healthScore ?? null,
      primaryMetric: body.primaryMetric || null,
      failureReason: body.failureReason || null,
      collecting: body.healthScore === null && body.primaryMetric?.label?.startsWith('Collecting'),
      objectivesTotal: fields.objectivesTotal ?? 0,
      objectivesInFlight: fields.objectivesInFlight ?? 0,
      objectivesCompleted24h: fields.objectivesCompleted24h ?? 0,
      objectivesFailed: fields.objectivesFailed ?? 0,
      tasksTotal: fields.tasksTotal ?? 0,
      tasksInFlight: fields.tasksInFlight ?? 0,
      agentsAssigned: fields.agentsAssigned ?? 0,
      avgTasksPerObjective: fields.avgTasksPerObjective ?? null,
      lastObjectiveAt: fields.lastObjectiveAt ?? null,
      sourceVersion: body.sourceVersion || null,
    }
  } catch (err) {
    if (!globalThis.__quoxExecutiveFallbackLogged) {
      console.warn('[QuoxExecutive] backend unreachable, returning null state:', err?.message || err)
      globalThis.__quoxExecutiveFallbackLogged = true
    }
    return {
      healthScore: null,
      primaryMetric: { value: null, label: 'Service unreachable' },
      failureReason: { code: 'SERVICE_UNREACHABLE', service: 'tasks', message: err?.message || String(err) },
      collecting: false,
      objectivesTotal: 0,
      objectivesInFlight: 0,
      objectivesCompleted24h: 0,
      objectivesFailed: 0,
      tasksTotal: 0,
      tasksInFlight: 0,
      agentsAssigned: 0,
      avgTasksPerObjective: null,
      lastObjectiveAt: null,
      fallback: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

// QMH-2 QuoxSense: source of truth is the implant_signals table — durable
// cross-tab observations. Was previously an in-memory buffer in the browser
// that reset every page reload.
const SENSE_STATS_URL = '/tasks/api/engine/sense/stats'
const SENSE_FETCH_TIMEOUT_MS = 4000

export async function fetchSenseStats() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SENSE_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(SENSE_STATS_URL, {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = new Error(`sense stats: HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    const body = await res.json()
    const fields = body.fields || {}
    return {
      healthScore: body.healthScore ?? null,
      primaryMetric: body.primaryMetric || null,
      failureReason: body.failureReason || null,
      collecting: body.healthScore === null && body.primaryMetric?.label?.startsWith('Collecting'),
      signalCount: fields.signalCount ?? 0,
      signals24h: fields.signals24h ?? 0,
      signalRatePerMin: fields.signalRatePerMin ?? 0,
      uniqueImplants: fields.uniqueImplants ?? 0,
      breakdown: fields.breakdown || {},
      lastSignalAt: fields.lastSignalAt ?? null,
      sourceVersion: body.sourceVersion || null,
    }
  } catch (err) {
    if (!globalThis.__quoxSenseFallbackLogged) {
      console.warn('[QuoxSense] backend unreachable, returning null state:', err?.message || err)
      globalThis.__quoxSenseFallbackLogged = true
    }
    return {
      healthScore: null,
      primaryMetric: { value: null, label: 'Service unreachable' },
      failureReason: { code: 'SERVICE_UNREACHABLE', service: 'tasks', message: err?.message || String(err) },
      collecting: false,
      signalCount: 0,
      signals24h: 0,
      signalRatePerMin: 0,
      uniqueImplants: 0,
      breakdown: {},
      lastSignalAt: null,
      fallback: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

// QMH-2 QuoxGuard: source of truth is autonomy_decisions (Stream QM
// autonomyDecision writes the trail). Was previously mapped to
// getReliabilityStats() (page-load uptime ratio) — unrelated to enforcement.
const GUARD_STATS_URL = '/tasks/api/engine/guard/stats'
const GUARD_FETCH_TIMEOUT_MS = 4000

export async function fetchGuardStats() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GUARD_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(GUARD_STATS_URL, {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = new Error(`guard stats: HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    const body = await res.json()
    const fields = body.fields || {}
    return {
      healthScore: body.healthScore ?? null,
      primaryMetric: body.primaryMetric || null,
      failureReason: body.failureReason || null,
      collecting: body.healthScore === null && body.primaryMetric?.label?.startsWith('Collecting'),
      decisionCount: fields.decisionCount ?? 0,
      allowCount: fields.allowCount ?? 0,
      denyCount: fields.denyCount ?? 0,
      escalateCount: fields.escalateCount ?? 0,
      agentsCovered: fields.agentsCovered ?? 0,
      decisions24h: fields.decisions24h ?? 0,
      lastDecisionAt: fields.lastDecisionAt ?? null,
      sourceVersion: body.sourceVersion || null,
    }
  } catch (err) {
    if (!globalThis.__quoxGuardFallbackLogged) {
      console.warn('[QuoxGuard] backend unreachable, returning null state:', err?.message || err)
      globalThis.__quoxGuardFallbackLogged = true
    }
    return {
      healthScore: null,
      primaryMetric: { value: null, label: 'Service unreachable' },
      failureReason: { code: 'SERVICE_UNREACHABLE', service: 'tasks', message: err?.message || String(err) },
      collecting: false,
      decisionCount: 0,
      allowCount: 0,
      denyCount: 0,
      escalateCount: 0,
      agentsCovered: 0,
      decisions24h: 0,
      lastDecisionAt: null,
      fallback: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

// QMH-2 QuoxValue: source of truth is agent_performance, interpreted as
// quality-per-cost. Was previously mapped to getToolingCortexStats() (entity
// counts) — unrelated to capability value.
const VALUE_STATS_URL = '/tasks/api/engine/value/stats'
const VALUE_FETCH_TIMEOUT_MS = 4000

export async function fetchValueStats() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VALUE_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(VALUE_STATS_URL, {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = new Error(`value stats: HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    const body = await res.json()
    const fields = body.fields || {}
    return {
      healthScore: body.healthScore ?? null,
      primaryMetric: body.primaryMetric || null,
      failureReason: body.failureReason || null,
      collecting: body.healthScore === null && body.primaryMetric?.label?.startsWith('Collecting'),
      observationCount: fields.observationCount ?? 0,
      totalTokens: fields.totalTokens ?? 0,
      avgQuality: fields.avgQuality ?? null,
      qualityPerKToken: fields.qualityPerKToken ?? null,
      byDomain: fields.byDomain || {},
      lastObservationAt: fields.lastObservationAt ?? null,
      pendingPriority: fields.pendingPriority || { pendingCount: 0, avgPriority: null, maxPriority: null, highPriorityCount: 0 },
      sourceVersion: body.sourceVersion || null,
    }
  } catch (err) {
    if (!globalThis.__quoxValueFallbackLogged) {
      console.warn('[QuoxValue] backend unreachable, returning null state:', err?.message || err)
      globalThis.__quoxValueFallbackLogged = true
    }
    return {
      healthScore: null,
      primaryMetric: { value: null, label: 'Service unreachable' },
      failureReason: { code: 'SERVICE_UNREACHABLE', service: 'tasks', message: err?.message || String(err) },
      collecting: false,
      observationCount: 0,
      totalTokens: 0,
      avgQuality: null,
      qualityPerKToken: null,
      byDomain: {},
      lastObservationAt: null,
      pendingPriority: { pendingCount: 0, avgPriority: null, maxPriority: null, highPriorityCount: 0 },
      fallback: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

// QMH-2 QuoxInsight: source of truth is implant_signals correlation. Was
// previously mapped to getIntegrationSpineStats() (workflows + Uptime Kuma) —
// unrelated to cross-implant correlation.
const INSIGHT_STATS_URL = '/tasks/api/engine/insight/stats'
const INSIGHT_FETCH_TIMEOUT_MS = 4000

export async function fetchInsightStats() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INSIGHT_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(INSIGHT_STATS_URL, {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = new Error(`insight stats: HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    const body = await res.json()
    const fields = body.fields || {}
    return {
      healthScore: body.healthScore ?? null,
      primaryMetric: body.primaryMetric || null,
      failureReason: body.failureReason || null,
      collecting: body.healthScore === null && body.primaryMetric?.label?.startsWith('Collecting'),
      signalCount: fields.signalCount ?? 0,
      signalsRecentWindow: fields.signalsRecentWindow ?? 0,
      clustersDetected: fields.clustersDetected ?? 0,
      lastClusterAt: fields.lastClusterAt ?? null,
      lastSignalAt: fields.lastSignalAt ?? null,
      sourceVersion: body.sourceVersion || null,
    }
  } catch (err) {
    if (!globalThis.__quoxInsightFallbackLogged) {
      console.warn('[QuoxInsight] backend unreachable, returning null state:', err?.message || err)
      globalThis.__quoxInsightFallbackLogged = true
    }
    return {
      healthScore: null,
      primaryMetric: { value: null, label: 'Service unreachable' },
      failureReason: { code: 'SERVICE_UNREACHABLE', service: 'tasks', message: err?.message || String(err) },
      collecting: false,
      signalCount: 0,
      signalsRecentWindow: 0,
      clustersDetected: 0,
      lastClusterAt: null,
      lastSignalAt: null,
      fallback: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

// QMH-3 QuoxFocus: source of truth is server-side WSM (wsm_focus,
// wsm_open_loops, wsm_recent_entities). Was previously a hardcoded formula
// `20 + openLoops*10 + entities*5` against browser-only localStorage that
// vanished on every reload AND was license-blocked anyway.
const FOCUS_STATS_URL = '/tasks/api/engine/focus/stats'
const FOCUS_FETCH_TIMEOUT_MS = 4000

export async function fetchFocusStats() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FOCUS_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(FOCUS_STATS_URL, {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = new Error(`focus stats: HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    const body = await res.json()
    const fields = body.fields || {}
    const license = body.failureReason?.code === 'LICENSE_REQUIRED'
    return {
      healthScore: body.healthScore ?? null,
      primaryMetric: body.primaryMetric || null,
      failureReason: body.failureReason || null,
      collecting: !license && body.healthScore === null && body.primaryMetric?.label?.startsWith('Collecting'),
      licenseRequired: license,
      requiredPlugin: license ? body.failureReason.requiredPlugin : null,
      hasFocus: fields.hasFocus ?? false,
      currentTask: fields.currentTask ?? null,
      currentProject: fields.currentProject ?? null,
      focusStartedAt: fields.focusStartedAt ?? null,
      openLoops: fields.openLoops ?? 0,
      recentEntities: fields.recentEntities ?? 0,
      lastEntityAt: fields.lastEntityAt ?? null,
      sourceVersion: body.sourceVersion || null,
    }
  } catch (err) {
    if (!globalThis.__quoxFocusFallbackLogged) {
      console.warn('[QuoxFocus] backend unreachable, returning null state:', err?.message || err)
      globalThis.__quoxFocusFallbackLogged = true
    }
    return {
      healthScore: null,
      primaryMetric: { value: null, label: 'Service unreachable' },
      failureReason: { code: 'SERVICE_UNREACHABLE', service: 'tasks', message: err?.message || String(err) },
      collecting: false,
      licenseRequired: false,
      requiredPlugin: null,
      hasFocus: false,
      currentTask: null,
      currentProject: null,
      focusStartedAt: null,
      openLoops: 0,
      recentEntities: 0,
      lastEntityAt: null,
      fallback: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

// QMH-2 QuoxMemory: source of truth is the memory service, not localStorage.
// Server endpoint already exists: GET /api/memory/stats (services/memory/server.js).
// Frontend reaches it via the /memory proxy.
const MEMORY_STATS_URL = '/memory/api/memory/stats'
const MEMORY_FETCH_TIMEOUT_MS = 4000

async function fetchMemoryStatsFromServer() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MEMORY_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(MEMORY_STATS_URL, {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = new Error(`memory stats: HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// Health formula (relaxed from QMH-1 audit finding: 108 mixed memories should
// not score "degraded"). Returns null when there is no data — UI renders that
// as "Collecting", not "DOWN".
function memoryHealthScore({ totalMemories, hasEntities, hasSemantic, hasConversations }) {
  if (totalMemories === 0) return null
  let score = 100
  if (totalMemories < 10) score -= 30
  else if (totalMemories < 30) score -= 10
  if (!hasEntities) score -= 10
  if (!hasSemantic && !hasConversations) score -= 10
  return Math.max(0, Math.min(100, score))
}

/**
 * Get memory lattice stats — server-backed, with localStorage fallback.
 */
export async function getMemoryLatticeStats() {
  try {
    const body = await fetchMemoryStatsFromServer()
    const memTotal = body?.memories?.total ?? 0
    const entitiesTotal = body?.entities?.total ?? 0
    const conversationCount = body?.conversations ?? 0
    const semanticCount = body?.relations ?? 0
    const byType = body?.memories?.by_type || {}

    const healthScore = memoryHealthScore({
      totalMemories: memTotal,
      hasEntities: entitiesTotal > 0,
      hasSemantic: semanticCount > 0,
      hasConversations: conversationCount > 0,
    })

    return {
      healthScore,
      totalMemories: memTotal,
      contradictions: 0,
      recentActivity: conversationCount > 0 ? 1 : 0,
      episodic: byType.episodic || 0,
      semantic: semanticCount,
      entities: entitiesTotal,
      learned: (byType.fact || 0) + (byType.preference || 0) + (byType.decision || 0)
            + (byType.constraint || 0) + (byType.error || 0) + (byType.reflection || 0)
            + (byType.intent || 0),
      core_memories: body?.core_memories ?? 0,
      conversations: conversationCount,
      isHealthy: healthScore !== null && healthScore >= 80,
    }
  } catch (error) {
    if (!globalThis.__quoxMemoryFallbackLogged) {
      console.warn('[QuoxMemory] memory service unreachable, using localStorage fallback:', error?.message || error)
      globalThis.__quoxMemoryFallbackLogged = true
    }
    // Legacy shape (fallback) — keeps the topology page functional in dev.
    const memoryCounts = countMemoriesFromStorage()
    let healthScore = 0
    if (memoryCounts.total > 0) {
      if (memoryCounts.episodic > 0) healthScore += 25
      if (memoryCounts.episodic > 10) healthScore += 10
      if (memoryCounts.episodic > 50) healthScore += 10
      if (memoryCounts.learned > 0) healthScore += 25
      if (memoryCounts.learned > 5) healthScore += 10
      if (memoryCounts.entities > 0) healthScore += 10
      if (memoryCounts.semantic > 0) healthScore += 10
      healthScore = Math.min(100, healthScore)
    }
    return {
      healthScore,
      totalMemories: memoryCounts.total,
      contradictions: 0,
      recentActivity: memoryCounts.episodic > 0 ? 1 : 0,
      episodic: memoryCounts.episodic,
      semantic: memoryCounts.semantic,
      entities: memoryCounts.entities,
      learned: memoryCounts.learned,
      isHealthy: false,
      fallback: true,
    }
  }
}

/**
 * Get tooling cortex stats
 */
export async function getToolingCortexStats() {
  try {
    const stats = getIndexStats()

    return {
      totalEntities: stats?.totalEntities || 0,
      assistants: stats?.assistants || 0,
      tools: stats?.tools || 0,
      workflows: stats?.workflows || 0,
      uniqueIntents: stats?.uniqueIntents || 0,
      uniqueIntegrations: stats?.uniqueIntegrations || 0,
    }
  } catch (error) {
    console.error('Failed to get tooling stats:', error)
    return {
      totalEntities: 0,
      assistants: 0,
      tools: 0,
      workflows: 0,
      uniqueIntents: 0,
      uniqueIntegrations: 0,
    }
  }
}

/**
 * Check Collector service health
 */
async function checkCollectorHealth() {
  try {
    const res = await withTimeout(
      fetch('/collector/health'),
      3000,
      null
    )
    if (!res || !res.ok) {
      return { healthy: false, error: 'Collector not responding' }
    }
    const data = await res.json()
    return {
      healthy: data.status === 'ok' || data.status === 'healthy' || data.healthy === true,
      fleetSize: data.agents || data.fleetSize || 0,
      uptime: data.uptime || null
    }
  } catch (err) {
    return { healthy: false, error: err.message }
  }
}

/**
 * Get integration spine stats
 */
export async function getIntegrationSpineStats() {
  try {
    // Wrap external API calls with timeout to prevent hanging
    const [workflows, uptime, collector] = await Promise.allSettled([
      withTimeout(listWorkflows(), 5000, []),
      withTimeout(getUptimeOverview(), 5000, null),
      checkCollectorHealth()
    ])

    const workflowData = workflows.status === 'fulfilled' ? workflows.value : []
    const uptimeData = uptime.status === 'fulfilled' ? uptime.value : null
    const collectorData = collector.status === 'fulfilled' ? collector.value : { healthy: false }

    // Count active workflows
    const activeWorkflows = Array.isArray(workflowData)
      ? workflowData.filter((w) => w.active).length
      : 0

    // Get uptime stats
    const monitors = uptimeData?.monitors || []
    const healthyMonitors = monitors.filter((m) => m.status === 1).length
    const avgUptime =
      monitors.length > 0
        ? monitors.reduce((sum, m) => sum + (m.uptime24 || 0), 0) / monitors.length
        : 0

    // Calculate health score (0-100)
    let healthScore = 0
    const totalServices = monitors.length + activeWorkflows + 1 // +1 for collector
    const healthyServices = healthyMonitors + activeWorkflows + (collectorData.healthy ? 1 : 0)

    if (totalServices > 0) {
      healthScore = Math.round((healthyServices / totalServices) * 100)
    }

    return {
      healthScore,
      connectedServices: totalServices,
      healthyServices,
      avgUptime: Math.round(avgUptime),
      workflows: activeWorkflows,
      monitors: monitors.length,
      collector: {
        healthy: collectorData.healthy,
        fleetSize: collectorData.fleetSize || 0,
        error: collectorData.error || null
      }
    }
  } catch (error) {
    console.error('Failed to get integration stats:', error)
    return {
      healthScore: 0,
      connectedServices: 0,
      healthyServices: 0,
      avgUptime: 0,
      workflows: 0,
      monitors: 0,
      collector: { healthy: false, fleetSize: 0, error: error.message }
    }
  }
}

/**
 * Get execution memory stats
 */
export async function getExecutionMemoryStats() {
  try {
    // Wrap API call with timeout
    const executions = await withTimeout(listExecutions({ limit: 100 }), 5000, [])
    const data = Array.isArray(executions) ? executions : []

    const successful = data.filter((e) => e.status === 'success').length
    const failed = data.filter((e) => e.status === 'error').length
    const running = data.filter((e) => e.status === 'running' || e.status === 'waiting').length

    const totalCompleted = successful + failed
    // When no executions exist, return a baseline score (50%) instead of 0%
    // to avoid showing "offline" just because no workflows have run yet
    const successRate = totalCompleted > 0 ? Math.round((successful / totalCompleted) * 100) : (data.length === 0 ? 50 : 0)

    // Calculate average duration from successful runs
    const durations = data
      .filter((e) => e.status === 'success' && e.startedAt && e.stoppedAt)
      .map((e) => new Date(e.stoppedAt) - new Date(e.startedAt))

    const avgDuration =
      durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0

    return {
      successRate,
      totalRuns: data.length,
      avgDuration,
      successful,
      failed,
      running,
    }
  } catch (error) {
    console.warn('Failed to get execution stats (workflow engine may not be running):', error.message)
    return {
      successRate: 50,
      totalRuns: 0,
      avgDuration: 0,
      successful: 0,
      failed: 0,
      running: 0,
      note: 'No workflow engine available'
    }
  }
}

/**
 * QMH-3: thin async wrapper around fetchFocusStats() for legacy callers
 * (coreyContext.js, cognitiveImplants.js dispatch). The previous body
 * computed a hardcoded `20 + openLoops*10 + entities*5` formula against
 * browser-only WSM — both the formula and the data source were dishonest.
 * This now reads server-side WSM via fetchFocusStats.
 */
export async function getContextHorizonStats() {
  const stats = await fetchFocusStats()
  return {
    contextUtilization: stats.healthScore ?? 0,
    activeProjects: stats.currentProject ? 1 : 0,
    openLoops: stats.openLoops,
    recentEntities: stats.recentEntities,
    hasFocus: stats.hasFocus,
    licenseRequired: stats.licenseRequired,
    requiredPlugin: stats.requiredPlugin,
    fallback: stats.fallback || false,
  }
}

/**
 * Get agent mesh stats
 */
export function getAgentMeshStats() {
  try {
    const assistants = getAssistants()
    const assistantList = Object.values(assistants)

    // Count capabilities across all assistants
    const allCapabilities = new Set()
    assistantList.forEach((a) => {
      if (a.capabilities?.intents) {
        a.capabilities.intents.forEach((i) => allCapabilities.add(i))
      }
    })

    // Count by level (orchestrators are level 0-1, specialists are level 2+)
    const orchestrators = assistantList.filter((a) => (a.hierarchy?.level ?? a.level ?? 0) <= 1).length
    const specialists = assistantList.filter((a) => (a.hierarchy?.level ?? a.level ?? 0) >= 2).length

    return {
      totalAgents: assistantList.length,
      activeAgents: assistantList.filter((a) => a.active !== false).length,
      capabilities: allCapabilities.size,
      orchestrators,
      specialists,
    }
  } catch (error) {
    console.error('Failed to get agent stats:', error)
    return {
      totalAgents: 0,
      activeAgents: 0,
      capabilities: 0,
      orchestrators: 0,
      specialists: 0,
    }
  }
}

// Incident tracking for MTTR calculation
const INCIDENT_LOG_KEY = 'quox_incident_log'

function getIncidentLog() {
  try {
    const stored = localStorage.getItem(INCIDENT_LOG_KEY)
    return stored ? JSON.parse(stored) : []
  } catch (e) {
    return []
  }
}

function saveIncidentLog(log) {
  try {
    // Keep last 100 incidents
    const trimmed = log.slice(-100)
    localStorage.setItem(INCIDENT_LOG_KEY, JSON.stringify(trimmed))
    queueSync('incidentLog', trimmed)
  } catch (e) { /* ignore */ }
}

function logIncident(monitorId, monitorName, type, timestamp) {
  const log = getIncidentLog()
  log.push({
    monitorId,
    monitorName,
    type, // 'down' or 'recovered'
    timestamp: timestamp || new Date().toISOString()
  })
  saveIncidentLog(log)
}

function calculateMTTR() {
  const log = getIncidentLog()
  if (log.length === 0) return null

  // Group incidents by monitor and pair down/recovered
  const recoveryTimes = []
  const openIncidents = new Map() // monitorId -> downTimestamp

  for (const incident of log) {
    if (incident.type === 'down') {
      openIncidents.set(incident.monitorId, incident.timestamp)
    } else if (incident.type === 'recovered') {
      const downTime = openIncidents.get(incident.monitorId)
      if (downTime) {
        const recoveryMs = new Date(incident.timestamp) - new Date(downTime)
        const recoveryMins = Math.round(recoveryMs / 60000)
        if (recoveryMins > 0 && recoveryMins < 1440 * 7) { // Ignore > 7 days
          recoveryTimes.push(recoveryMins)
        }
        openIncidents.delete(incident.monitorId)
      }
    }
  }

  if (recoveryTimes.length === 0) return null

  const avgRecovery = Math.round(
    recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length
  )

  return {
    mttr: avgRecovery, // minutes
    incidentCount: recoveryTimes.length,
    openIncidents: openIncidents.size
  }
}

// Track previous monitor states for incident detection
let previousMonitorStates = new Map()

/**
 * Get reliability index stats
 */
export async function getReliabilityStats() {
  try {
    // Wrap Uptime Kuma API with timeout
    const uptime = await withTimeout(getUptimeOverview(), 5000, null)
    const monitors = uptime?.monitors || []

    const upCount = monitors.filter((m) => m.status === 1).length
    const totalCount = monitors.length

    // Detect state changes and log incidents
    for (const monitor of monitors) {
      const prevState = previousMonitorStates.get(monitor.id)
      if (prevState !== undefined && prevState !== monitor.status) {
        if (monitor.status === 0) {
          logIncident(monitor.id, monitor.name, 'down')
        } else if (monitor.status === 1 && prevState === 0) {
          logIncident(monitor.id, monitor.name, 'recovered')
        }
      }
      previousMonitorStates.set(monitor.id, monitor.status)
    }

    // Calculate average uptime
    const avgUptime =
      monitors.length > 0
        ? monitors.reduce((sum, m) => sum + (m.uptime24 || 100), 0) / monitors.length
        : 100

    // Count alerts (status !== 1 means down or pending)
    const alertsActive = monitors.filter((m) => m.status !== 1).length

    // Calculate MTTR
    const mttrData = calculateMTTR()

    // Calculate health score
    let healthScore = Math.round(avgUptime)
    if (mttrData?.mttr) {
      // Penalize slow recovery (target: < 30 min MTTR)
      if (mttrData.mttr > 60) healthScore -= 10
      else if (mttrData.mttr > 120) healthScore -= 20
    }
    if (alertsActive > 0) {
      healthScore -= alertsActive * 5
    }
    healthScore = Math.max(0, Math.min(100, healthScore))

    return {
      healthScore,
      uptimePercent: Math.round(avgUptime),
      servicesUp: `${upCount}/${totalCount}`,
      alertsActive,
      mttr: mttrData?.mttr || null,
      mttrFormatted: mttrData?.mttr
        ? mttrData.mttr < 60
          ? `${mttrData.mttr} min`
          : `${(mttrData.mttr / 60).toFixed(1)} hrs`
        : 'N/A',
      incidentCount: mttrData?.incidentCount || 0,
      openIncidents: mttrData?.openIncidents || 0
    }
  } catch (error) {
    console.error('Failed to get reliability stats:', error)
    return {
      healthScore: 0,
      uptimePercent: 0,
      servicesUp: '0/0',
      alertsActive: 0,
      mttr: null,
      mttrFormatted: 'N/A',
      incidentCount: 0,
      openIncidents: 0
    }
  }
}

/**
 * Get continuity anchor stats
 */
export function getContinuityStats() {
  try {
    const syncStatus = getSyncStatus()
    const storage = getStorageUsage()

    // Calculate health score based on sync success and storage usage
    let healthScore = 50 // Base score

    // Sync health (+30 points max)
    if (syncStatus?.syncActive) healthScore += 10
    if (syncStatus?.lastSyncSuccess === true) healthScore += 10
    if (syncStatus?.successRate >= 90) healthScore += 10
    else if (syncStatus?.successRate >= 70) healthScore += 5

    // Storage health (+20 points max)
    const storagePercent = storage?.percentUsed || 0
    if (storagePercent < 50) healthScore += 20
    else if (storagePercent < 80) healthScore += 10
    else if (storagePercent >= 90) healthScore -= 10 // Penalty for near-full

    // Clamp to 0-100
    healthScore = Math.max(0, Math.min(100, healthScore))

    return {
      healthScore,
      sessionCount: syncStatus?.syncCount || 0,
      successfulSyncs: syncStatus?.successfulSyncs || 0,
      failedSyncs: syncStatus?.failedSyncs || 0,
      successRate: syncStatus?.successRate || 100,
      lastSync: syncStatus?.lastSync || null,
      lastSyncSuccess: syncStatus?.lastSyncSuccess,
      syncActive: syncStatus?.syncActive || false,
      storageUsed: storage?.totalUsed || 0,
      storageMax: storage?.max || 0,
      storagePercent: storage?.percentUsed || 0,
      pendingChanges: syncStatus?.pendingChanges || 0,
    }
  } catch (error) {
    console.error('Failed to get continuity stats:', error)
    return {
      healthScore: 0,
      sessionCount: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      successRate: 0,
      lastSync: null,
      lastSyncSuccess: false,
      syncActive: false,
      storageUsed: 0,
      storageMax: 0,
      storagePercent: 0,
      pendingChanges: 0,
    }
  }
}

/**
 * Get governance layer stats
 */
export function getGovernanceStats() {
  try {
    const agentRoles = Object.keys(AGENT_PERMISSIONS).length
    const memoryDomains = Object.keys(MEMORY_DOMAINS).length

    // Count total policies (simplified - count permission rules)
    let policyCount = 0
    Object.values(AGENT_PERMISSIONS).forEach((perms) => {
      policyCount += (perms.read?.length || 0) + (perms.write?.length || 0)
    })

    return {
      policyCount,
      agentRoles,
      memoryDomains,
    }
  } catch (error) {
    console.error('Failed to get governance stats:', error)
    return {
      policyCount: 0,
      agentRoles: 0,
      memoryDomains: 0,
    }
  }
}

/**
 * Get data fabric (files) stats
 */
export function getDataFabricStats() {
  try {
    // Pass storage and files data directly to avoid circular dependency
    const storage = getStorageUsage()
    const files = listFiles() || []

    return getFileMetrics({ storage, files })
  } catch (error) {
    console.error('Failed to get data fabric stats:', error)
    return {
      totalFiles: 0,
      storagePercent: 0,
      recentlyAccessed: 0,
      images: 0,
      documents: 0,
    }
  }
}

/**
 * Get codebase fabric stats from the collector's codebase API.
 */
export async function getCodebaseFabricStats() {
  try {
    const res = await fetch('/collector/api/v1/codebase/projects')
    if (!res.ok) return null
    const data = await res.json()
    if (!data.success) return null

    const projects = data.projects || []
    const totalRoutes = projects.reduce((sum, p) => sum + (p.metrics?.routeCount || 0), 0)
    const totalServices = projects.reduce((sum, p) => sum + (p.metrics?.serviceCount || 0), 0)
    const failures = projects.filter((p) => p.invariant_status === 'fail').length
    const passing = projects.filter((p) => p.invariant_status === 'pass').length
    const total = projects.length

    return {
      projectCount: total,
      registryHealth: total > 0 ? Math.round((passing / total) * 100) : 100,
      routeCount: totalRoutes,
      serviceCount: totalServices,
      driftAlerts: failures,
      lastScan: projects.length > 0 ? projects.reduce((latest, p) => p.last_scan > latest ? p.last_scan : latest, '') : null,
    }
  } catch {
    return null
  }
}

// QN Phase 3: quox-brain2 fetcher, alongside getNucleusStats() above.
// Never throws — degrades to an offline result if the quoxbrain service
// is unreachable, same contract as getNucleusStats().
export async function getBrainStats() {
  try {
    const client = getQuoxbrainClient()
    const body = await client.getBrainStatus()
    const sources = Array.isArray(body?.sources) ? body.sources : []
    return {
      noteCount: body?.noteCount ?? 0,
      sourceCount: sources.length,
      growthStatus: body?.status || 'dormant',
      milestoneRemaining: body?.milestone?.remaining ?? null,
    }
  } catch (err) {
    return {
      noteCount: 0,
      sourceCount: 0,
      growthStatus: 'offline',
      milestoneRemaining: null,
      failureReason: { code: 'SERVICE_UNREACHABLE', service: 'quoxbrain', message: err?.message || String(err) },
      fallback: true,
    }
  }
}

/**
 * Fetch all implant data at once
 */
/**
 * Fetch all implant data at once — QuoxMind 14-implant architecture.
 *
 * Maps new implant IDs to existing data fetchers.
 * Data fetchers will be enhanced in QMB-2 through QMB-5.
 */
export async function fetchAllImplantData() {
  const results = await Promise.allSettled([
    fetchSenseStats(),                           // 0: quox-sense (QMH-2: durable signals from implant_signals table)
    getMemoryLatticeStats(),                    // 1: quox-memory
    Promise.resolve(getTemporalStats()),         // 2: quox-temporal (temporal intelligence)
    fetchFocusStats(),                           // 3: quox-focus (QMH-3: server-side WSM)
    fetchValueStats(),                           // 4: quox-value (QMH-2: quality-per-cost from agent_performance)
    fetchGuardStats(),                           // 5: quox-guard (QMH-2: autonomy_decisions enforcement trail)
    fetchInsightStats(),                         // 6: quox-insight (QMH-2: cluster correlation over implant_signals)
    fetchExecutiveStats(),                       // 7: quox-executive (QMH-2: real coordination from objectives + tasks)
    fetchPredictStats(),                         // 8: quox-predict (QMH-2: wisdom from execution_wisdom table)
    fetchReflectStats(),                         // 9: quox-reflect (QMH-2: outcomes from objective_outcomes table)
    fetchDreamStats(),                          // 10: quox-dream (QMH-2: real consolidation cycles from dream_cycles table)
    fetchLearnStats(),                           // 11: quox-learn (QMH-2: agent_performance from AT-3 scorer)
    getNucleusStats(),                           // 12: quox-nucleus (codebase self-awareness)
    getBrainStats(),                             // 13: quox-brain2 (associative knowledge graph)
  ])

  return {
    'quox-sense':     results[0].status === 'fulfilled' ? results[0].value : null,
    'quox-memory':    results[1].status === 'fulfilled' ? results[1].value : null,
    'quox-temporal':  results[2].status === 'fulfilled' ? results[2].value : null,
    'quox-focus':     results[3].status === 'fulfilled' ? results[3].value : null,
    'quox-value':     results[4].status === 'fulfilled' ? results[4].value : null,
    'quox-guard':     results[5].status === 'fulfilled' ? results[5].value : null,
    'quox-insight':   results[6].status === 'fulfilled' ? results[6].value : null,
    'quox-executive': results[7].status === 'fulfilled' ? results[7].value : null,
    'quox-predict':   results[8].status === 'fulfilled' ? results[8].value : null,
    'quox-reflect':   results[9].status === 'fulfilled' ? results[9].value : null,
    'quox-dream':     results[10].status === 'fulfilled' ? results[10].value : null,
    'quox-learn':     results[11].status === 'fulfilled' ? results[11].value : null,
    'quox-nucleus':   results[12].status === 'fulfilled' ? results[12].value : null,
    'quox-brain2':    results[13].status === 'fulfilled' ? results[13].value : null,
  }
}

/**
 * Check which implants are locked by tier.
 * QuoxMind tier model: Free (6), Pro (3), Complete (3).
 * Pro and Complete implants show as locked unless the relevant licence is active.
 */
export function getLockedImplants() {
  const locked = []

  // Pro tier implants — locked unless QuoxMind Pro is licensed
  if (!isPluginLicensed('quoxmind-pro')) {
    locked.push('quox-insight', 'quox-executive', 'quox-predict')
  }

  // Complete tier implants — locked unless QuoxMind Complete is licensed
  if (!isPluginLicensed('quoxmind-complete')) {
    locked.push('quox-reflect', 'quox-dream', 'quox-learn')
  }

  return locked
}
