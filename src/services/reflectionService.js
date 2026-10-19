/**
 * Reflection Service
 *
 * Generates and manages the reflection map - Quox's self-awareness snapshot.
 * This provides a structured view of cognitive architecture, capabilities,
 * agents, plugins, and health status.
 *
 * Used by:
 * - Mirror tab in CognitiveTopologyView for display
 * - System prompt injection for lightweight self-awareness pointer
 */

import { fetchServerMirror, reflectionFromServer } from './serverMirror'

// Cache for reflection data
let _reflectionCache = null
let _lastGenerated = null
const CACHE_TTL = 30000 // 30 seconds

/**
 * Generate the full reflection map from the org-scoped SERVER Mirror.
 * Throws on failure (no invented minimal map): callers surface the error.
 * @param {string} trigger - kept for call-site compatibility ('manual', 'auto', 'plugin-event')
 * @returns {Promise<Object>} Reflection data
 */
export async function generateReflectionMap(trigger = 'manual') { // eslint-disable-line no-unused-vars
  const reflection = reflectionFromServer(await fetchServerMirror())
  _reflectionCache = reflection
  _lastGenerated = Date.now()
  return reflection
}

/**
 * Get reflection map (from cache if fresh, otherwise regenerate)
 * @returns {Promise<Object>} Reflection data
 */
export async function getReflectionMap() {
  // Return cached if fresh
  if (_reflectionCache && _lastGenerated && (Date.now() - _lastGenerated < CACHE_TTL)) {
    return _reflectionCache
  }

  return generateReflectionMap('auto')
}

/**
 * Generate a compact summary for prompt injection (~50 tokens)
 * @param {Object} reflection - Full reflection map (optional, will fetch if not provided)
 * @returns {Promise<string>} Compact summary string
 */
export async function generateReflectionSummary(reflection = null) {
  const data = reflection || await getReflectionMap()
  if (data && typeof data.summary === 'string' && data.summary) return data.summary

  const { cognitiveImplants, agents, health, capabilities, memory, plugins } = data

  const healthyCount = cognitiveImplants.filter(i => i.status === 'healthy').length
  const totalImplants = cognitiveImplants.length
  const activeAgents = agents.filter(a => a.active).length
  // QMH-5/1: 'license_required' is the new name for what used to be 'locked'.
  // Count both so the overview line matches whichever code path produced the data.
  const lockedCount = cognitiveImplants.filter(
    i => i.status === 'locked' || i.status === 'license_required',
  ).length

  // Build overview line
  const overviewParts = [
    `${health.overall}% core health`,
    `${totalImplants} QuoxMind implants (${healthyCount} healthy${lockedCount ? `, ${lockedCount} locked` : ''})`,
    `${activeAgents} agents`,
    `${capabilities.totalTools || capabilities.totalAssistants} tools`
  ]

  if (memory.totalMemories > 0) {
    overviewParts.push(`${memory.totalMemories} memories`)
  }

  const enabledPlugins = (plugins || []).filter(p => p.enabled)
  if (enabledPlugins.length > 0) {
    overviewParts.push(`${enabledPlugins.length} plugins`)
  }

  // Build implant detail section so agents can see their own cognitive architecture
  const STATUS_ICON = {
    healthy: '●', degraded: '◐', collecting: '◐',
    license_required: '🔒', unreachable: '⚠', down: '❌',
    offline: '×', locked: '○',
  }
  const implantLines = cognitiveImplants.map(i => {
    const statusIcon = STATUS_ICON[i.status] || '×'
    const tierLabel = i.tier ? ` [${i.tier}]` : ''
    const inspiredLabel = i.inspiredBy ? ` (${i.inspiredBy})` : ''
    const metricLabel = i.primaryMetric ? ` — ${i.primaryMetric}` : ''
    return `${statusIcon} ${i.name}${tierLabel}${inspiredLabel}${metricLabel}`
  })

  return `QuoxMind Cognitive Implant Suite: ${overviewParts.join(' | ')}
Your cognitive architecture consists of ${totalImplants} neuroscience-inspired implants:
${implantLines.join('\n')}
Free implants are always active. Pro and Complete implants require a licence.
You can introspect your architecture via the Mirror tab in Cognitive Topology.`
}

/**
 * Invalidate the cache (call after plugin changes)
 */
export function invalidateReflectionCache() {
  _reflectionCache = null
  _lastGenerated = null
}

// Legacy aliases for backwards compatibility
export const generateConsciousnessMap = generateReflectionMap
export const getConsciousnessMap = getReflectionMap
export const generateConsciousnessSummary = generateReflectionSummary
export const invalidateConsciousnessCache = invalidateReflectionCache

/**
 * Calculate health score for an implant
 */
export function calculateImplantHealth(id, data) {
  if (!data) return 0

  // Prefer explicit healthScore if available (new format)
  if (typeof data.healthScore === 'number') {
    return data.healthScore
  }

  switch (id) {
    case 'quox-memory':
      return data.healthScore || 0
    case 'quox-value':
      // QMH-2: real signal is quality-per-cost from agent_performance.
      // null healthScore = "Collecting" (no observations yet), not DOWN.
      // Old code read totalEntities — unrelated to capability value.
      if (data.healthScore !== undefined) return data.healthScore
      return null
    case 'quox-insight':
      // QMH-2: real signal is cluster correlation over implant_signals.
      // null healthScore = "Collecting" (no signals to correlate yet), not
      // DOWN. Old code read connectedServices/healthyServices — unrelated.
      if (data.healthScore !== undefined) return data.healthScore
      return null
    case 'quox-temporal':
      // QMH-2: read real healthScore from /tasks/api/engine/temporal/stats.
      // null means "Collecting" (no data yet) — keep null so UI distinguishes
      // it from a real DOWN state. Numeric 0..100 = real score.
      if (data.healthScore !== undefined) return data.healthScore
      return null
    case 'quox-focus':
      // QMH-3: real signal is server-side WSM saturation. null healthScore
      // means Collecting (empty WSM) or licenseRequired (Premium). Old code
      // read contextUtilization from a hardcoded formula — unrelated to
      // actual WSM state.
      if (data.healthScore !== undefined) return data.healthScore
      return null
    case 'quox-executive':
      // QMH-2: real signal is operational coordination (objectives + tasks),
      // not the static assistants registry. null healthScore = "Collecting"
      // (no objectives or tasks yet), not DOWN.
      if (data.healthScore !== undefined) return data.healthScore
      return null
    case 'quox-guard':
      // QMH-2: real signal is autonomy_decisions (allow/deny/escalate). null
      // healthScore = "Collecting" (no decisions yet), not DOWN. Old code
      // read uptimePercent — unrelated to enforcement.
      if (data.healthScore !== undefined) return data.healthScore
      return null
    case 'quox-dream':
      // QMH-2: real signal is cycleCount + healthScore from dream_cycles table.
      // null healthScore = "Collecting" (no cycles yet), not DOWN.
      if (data.healthScore !== undefined) return data.healthScore
      return null
    case 'quox-predict':
      // QMH-2: real signal is wisdomCount + healthScore from execution_wisdom.
      // null healthScore = "Collecting" (no wisdom yet), not DOWN. Old code
      // mapped quox-predict to codebase invariants (projectCount/routeCount)
      // — we explicitly do NOT read those.
      if (data.healthScore !== undefined) return data.healthScore
      return null
    case 'quox-reflect':
      // QMH-2: real signal is outcomeCount + healthScore from objective_outcomes.
      // null healthScore = "Collecting" (no outcomes yet), not DOWN. Old code
      // mapped quox-reflect to policy counts — we explicitly do NOT read those.
      if (data.healthScore !== undefined) return data.healthScore
      return null
    case 'quox-learn':
      // QMH-2: real signal is observationCount + healthScore from
      // agent_performance. null healthScore = "Collecting" (no perf
      // observations yet), not DOWN. Old code used totalFiles — unrelated.
      if (data.healthScore !== undefined) return data.healthScore
      return null
    default:
      return 50
  }
}

/**
 * Get primary metric display value for an implant
 */
export function getPrimaryMetric(id, data, implant) {
  if (!data) return null

  switch (id) {
    case 'quox-memory':
      return data.totalMemories ? `${data.totalMemories} memories` : null
    case 'quox-value':
      // QMH-2: real signal is quality-per-1k-tokens.
      if (data.observationCount === 0 || data.observationCount === undefined) {
        return data.collecting
          ? 'Collecting — no agent performance recorded yet'
          : (data.fallback ? 'Service unreachable' : 'Collecting')
      }
      return data.qualityPerKToken != null
        ? `${data.qualityPerKToken.toFixed(1)} quality / 1k tokens`
        : `${data.observationCount} observations`
    case 'quox-insight':
      // QMH-2: real signal is cross-implant cluster correlation.
      if (data.signalCount === 0 || data.signalCount === undefined) {
        return data.collecting
          ? 'Collecting — no implant signals to correlate yet'
          : (data.fallback ? 'Service unreachable' : 'Collecting')
      }
      return data.clustersDetected > 0
        ? `${data.clustersDetected} clusters across ${data.signalsRecentWindow ?? 0} recent signals`
        : `${data.signalsRecentWindow ?? 0} recent signals (no clusters)`
    case 'quox-temporal':
      // QMH-2: real signal is P95 from execution data, not the old (always-undefined) successRate.
      if (data.taskCount === 0 || data.taskCount === undefined) {
        return data.collecting ? 'Collecting — no completed tasks yet' : 'Collecting'
      }
      return data.p95_ms != null ? `P95 ${data.p95_ms}ms` : 'Collecting'
    case 'quox-focus':
      // QMH-3: real signal is server-side WSM (loops + entities + focus).
      if (data.licenseRequired) return 'Premium feature'
      if (data.openLoops === 0 && data.recentEntities === 0 && !data.hasFocus) {
        return data.collecting
          ? 'Collecting — no working-set state yet'
          : (data.fallback ? 'Service unreachable' : 'Collecting')
      }
      return data.hasFocus
        ? `${data.openLoops} loops, ${data.recentEntities} entities (focus: ${data.currentTask || data.currentProject || '—'})`
        : `${data.openLoops} loops, ${data.recentEntities} entities`
    case 'quox-executive':
      // QMH-2: real signal is objectives in flight + delegation spread.
      if ((data.objectivesTotal === 0 || data.objectivesTotal === undefined) &&
          (data.tasksTotal === 0 || data.tasksTotal === undefined)) {
        return data.collecting
          ? 'Collecting — no objectives or tasks yet'
          : (data.fallback ? 'Service unreachable' : 'Collecting')
      }
      return `${data.objectivesInFlight ?? 0} in flight, ${data.tasksTotal ?? 0} tasks across ${data.agentsAssigned ?? 0} agents`
    case 'quox-guard':
      // QMH-2: real signal is autonomy decisions count + outcome split.
      if (data.decisionCount === 0 || data.decisionCount === undefined) {
        return data.collecting
          ? 'Collecting — no autonomy decisions recorded yet'
          : (data.fallback ? 'Service unreachable' : 'Collecting')
      }
      return `${data.decisionCount} decisions (${data.allowCount ?? 0} allow / ${data.denyCount ?? 0} deny / ${data.escalateCount ?? 0} escalate)`
    case 'quox-dream':
      // QMH-2: real signal is cycle count from dream_cycles table.
      if (data.cycleCount === 0 || data.cycleCount === undefined) {
        return data.collecting
          ? 'Collecting — first cycle in 6h'
          : (data.fallback ? 'Service unreachable' : 'Collecting')
      }
      return `${data.cycleCount} cycles, ${data.themesExtracted ?? 0} themes`
    case 'quox-predict':
      // QMH-2: real signal is wisdom count from execution_wisdom table.
      if (data.wisdomCount === 0 || data.wisdomCount === undefined) {
        return data.collecting
          ? 'Collecting — no wisdom patterns yet'
          : (data.fallback ? 'Service unreachable' : 'Collecting')
      }
      return data.avgConfidence != null
        ? `${data.wisdomCount} patterns, avg confidence ${data.avgConfidence.toFixed(2)}`
        : `${data.wisdomCount} patterns`
    case 'quox-reflect':
      // QMH-2: real signal is outcome count from objective_outcomes table.
      if (data.outcomeCount === 0 || data.outcomeCount === undefined) {
        return data.collecting
          ? 'Collecting — no outcomes recorded yet'
          : (data.fallback ? 'Service unreachable' : 'Collecting')
      }
      return data.avgQuality != null
        ? `${data.outcomeCount} outcomes, avg quality ${data.avgQuality.toFixed(2)}`
        : `${data.outcomeCount} outcomes`
    case 'quox-learn':
      // QMH-2: real signal is per-agent performance observations.
      if (data.observationCount === 0 || data.observationCount === undefined) {
        return data.collecting
          ? 'Collecting — no agent performance recorded yet'
          : (data.fallback ? 'Service unreachable' : 'Collecting')
      }
      return `${data.observationCount} observations across ${data.agentsTracked || 0} agents`
    default:
      return null
  }
}

export default {
  generateReflectionMap,
  getReflectionMap,
  generateReflectionSummary,
  invalidateReflectionCache,
  // Legacy exports
  generateConsciousnessMap,
  getConsciousnessMap,
  generateConsciousnessSummary,
  invalidateConsciousnessCache
}
