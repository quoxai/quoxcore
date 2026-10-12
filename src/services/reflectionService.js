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

import { fetchAllImplantData, getLockedImplants } from './cognitiveTopologyService'
import { getAssistants } from './entityRegistry'
import { getIndexStats } from './capabilityIndex'
import { getRegisteredPlugins } from './layers/pluginRegistry'
import { COGNITIVE_IMPLANTS } from '../config/cognitiveImplants'
import { deriveImplantStatus, requiredPluginForTier } from './mirrorIndex'

// Cache for reflection data
let _reflectionCache = null
let _lastGenerated = null
const CACHE_TTL = 30000 // 30 seconds

/**
 * Count memories directly from localStorage
 * More accurate than relying on service calls
 */
function countLocalStorageMemories() {
  if (typeof localStorage === 'undefined') {
    return { episodic: 0, semantic: 0, entities: 0, learned: 0, total: 0 }
  }

  try {
    // Count episodic memories (chat history)
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

    // Count all quox_ keys for total storage audit
    let totalKeys = 0
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith('quox_')) {
        totalKeys++
      }
    }

    return {
      episodic: episodicCount,
      semantic: semanticCount,
      entities: entityCount,
      learned: learnedCount,
      total: episodicCount + semanticCount + entityCount + learnedCount,
      storageKeys: totalKeys
    }
  } catch (error) {
    console.error('[ReflectionService] Failed to count localStorage memories:', error)
    return { episodic: 0, semantic: 0, entities: 0, learned: 0, total: 0, storageKeys: 0 }
  }
}

/**
 * Generate the full reflection map
 * @param {string} trigger - What triggered generation ('manual', 'auto', 'plugin-event')
 * @returns {Promise<Object>} Reflection data
 */
export async function generateReflectionMap(trigger = 'manual') {
  const timestamp = new Date().toISOString()

  try {
    // Fetch all data in parallel
    const [implantData, capabilities, plugins] = await Promise.all([
      fetchAllImplantData(),
      Promise.resolve(getIndexStats()),
      Promise.resolve(getRegisteredPlugins())
    ])

    // Get assistants synchronously
    const assistants = getAssistants()
    const lockedImplants = getLockedImplants()

    // Get accurate memory counts from localStorage
    const memoryCount = countLocalStorageMemories()

    // Transform implant data — QuoxMind 12-implant architecture.
    // QMH-5/1: status comes from the shared deriveImplantStatus helper so
    // both the system-prompt injection (mirrorIndex) and the topology UI
    // (MirrorTab via this service) use the same multi-axis state machine.
    const cognitiveImplants = Object.entries(COGNITIVE_IMPLANTS)
      .filter(([id]) => id !== 'quox-sense') // QuoxSense is the core, shown separately
      .map(([id, implant]) => {
        const data = implantData[id]
        // QuoxMemory has its own localStorage-derived health; everything
        // else trusts the fetcher's healthScore (or the failureReason).
        const memoryHealth = id === 'quox-memory' ? calculateMemoryHealth(memoryCount) : null
        const isLocked = lockedImplants.includes(id)
        const requiredPlugin = requiredPluginForTier(implant.tier)

        const derived = deriveImplantStatus(
          id === 'quox-memory'
            ? { ...(data || {}), healthScore: memoryHealth, failureReason: data?.failureReason || null }
            : data,
          { isLocked, requiredPlugin },
        )

        const numericHealth = derived.healthScore ?? (id === 'quox-memory' ? memoryHealth : 0)

        return {
          id,
          name: implant.name,
          health: numericHealth ?? 0,
          status: derived.status,
          statusReason: derived.statusReason,
          primaryMetric: id === 'quox-memory'
            ? `${memoryCount.total} memories`
            : getPrimaryMetric(id, data, implant),
          requiresPlugin: requiredPlugin,
          tier: implant.tier,
          inspiredBy: implant.inspiredBy,
          color: implant.color
        }
      })

    // Transform agents
    const agentList = Object.entries(assistants).map(([id, a]) => ({
      id,
      name: a.identity?.name || a.name || id.toUpperCase(),
      level: a.hierarchy?.level ?? a.level ?? 1,
      role: a.hierarchy?.role || a.role || 'specialist',
      color: a.identity?.color?.primary || a.color || '#888',
      active: a.active !== false
    }))

    // Core health from implant data (QuoxSense is the perceptual core).
    // QMH-2: senseStats now exposes healthScore (null when no signals yet).
    // Fall back to legacy overallHealth field for backward compatibility while
    // older fetchers may still be cached.
    const coreData = implantData['quox-sense'] || {}
    const coreHealth = coreData.healthScore ?? coreData.overallHealth ?? 0
    const memoryHealth = calculateMemoryHealth(memoryCount)
    const adjustedHealth = memoryCount.total > 0
      ? Math.round((coreHealth + memoryHealth) / 2)
      : coreHealth

    // Build reflection map
    const reflection = {
      version: '1.0.0',
      generatedAt: timestamp,
      generatedBy: trigger,

      identity: {
        name: 'CommanderQ',
        role: 'Multi-Agent Executive System',
        version: '2.0.0',
        description: 'AI-powered infrastructure command center'
      },

      cognitiveImplants,

      capabilities: {
        totalTools: capabilities?.tools || 0,
        totalWorkflows: capabilities?.workflows || 0,
        totalIntents: capabilities?.uniqueIntents || 0,
        totalAssistants: capabilities?.assistants || agentList.length,
        enabledIntegrations: capabilities?.uniqueIntegrations || []
      },

      agents: agentList.sort((a, b) => a.level - b.level),

      plugins: (plugins || []).map(p => ({
        id: p.id,
        name: p.name,
        version: p.version || '1.0.0',
        enabled: p.enabled !== false,
        tier: p.tier || 'custom'
      })),

      health: {
        overall: adjustedHealth || coreHealth,
        status: getHealthStatus(adjustedHealth || coreHealth),
        activeServices: coreData.activeServices || 0,
        totalServices: coreData.totalServices || 0,
        lastHealthCheck: timestamp
      },

      memory: {
        totalMemories: memoryCount.total,
        episodic: memoryCount.episodic,
        semantic: memoryCount.semantic,
        entities: memoryCount.entities,
        learned: memoryCount.learned,
        storageKeys: memoryCount.storageKeys,
        openLoops: implantData['quox-focus']?.openLoops || 0,
        healthScore: memoryHealth
      },
      codebaseFabric: implantData['quox-predict'] ? {
        projectCount: implantData['quox-predict'].projectCount || 0,
        totalRoutes: implantData['quox-predict'].routeCount || 0,
        totalServices: implantData['quox-predict'].serviceCount || 0,
        invariantStatus: (implantData['quox-predict'].driftAlerts || 0) > 0 ? 'fail' : 'pass',
        lastScan: implantData['quox-predict'].lastScan || null,
      } : null,
    }

    // Cache the result
    _reflectionCache = reflection
    _lastGenerated = Date.now()

    return reflection
  } catch (error) {
    console.error('[ReflectionService] Failed to generate reflection map:', error)
    // Return cached data if available, or minimal fallback
    return _reflectionCache || getMinimalReflection(timestamp, trigger)
  }
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
 * Calculate memory health based on counts
 */
function calculateMemoryHealth(memoryCount) {
  if (memoryCount.total === 0) return 0

  // Score based on variety and quantity
  let score = 0

  // Episodic memories (chat history)
  if (memoryCount.episodic > 0) score += 25
  if (memoryCount.episodic > 10) score += 10
  if (memoryCount.episodic > 50) score += 10

  // Learned facts
  if (memoryCount.learned > 0) score += 25
  if (memoryCount.learned > 5) score += 10

  // Entities
  if (memoryCount.entities > 0) score += 10

  // Semantic knowledge
  if (memoryCount.semantic > 0) score += 10

  return Math.min(100, score)
}

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

/**
 * Get required plugin for an implant
 */
function getRequiredPlugin(id) {
  const pluginMap = {
    'quox-memory': 'advanced-memory',
    'quox-focus': 'advanced-memory',
    'quox-reflect': 'governance',
    'quox-learn': 'files'
  }
  return pluginMap[id] || null
}

/**
 * Get health status string from percentage
 */
function getHealthStatus(health) {
  if (health >= 80) return 'operational'
  if (health >= 50) return 'degraded'
  if (health > 0) return 'critical'
  return 'unknown'
}

/**
 * Get minimal reflection map for error fallback
 */
function getMinimalReflection(timestamp, trigger) {
  return {
    version: '1.0.0',
    generatedAt: timestamp,
    generatedBy: trigger,
    identity: {
      name: 'CommanderQ',
      role: 'Multi-Agent Executive System',
      version: '2.0.0'
    },
    cognitiveImplants: [],
    capabilities: { totalTools: 0, totalWorkflows: 0, totalIntents: 0, enabledIntegrations: [] },
    agents: [],
    plugins: [],
    health: { overall: 0, status: 'unknown', activeServices: 0, totalServices: 0, lastHealthCheck: timestamp },
    memory: { totalMemories: 0, episodic: 0, semantic: 0, entities: 0, learned: 0, openLoops: 0, healthScore: 0 }
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
