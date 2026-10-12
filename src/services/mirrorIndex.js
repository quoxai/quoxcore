/**
 * Mirror Index — The Cognitive Index for QuoxMind
 *
 * Stream MR Phase MR-1.
 *
 * Single cached index of everything the system knows about itself.
 * Consumed by: agent system prompts, execution_intelligence tool,
 * frontend widgets, smart router, agent delegator, decomposer.
 *
 * Design: index, not encyclopedia. Compact injection tells agents what
 * exists. Full index available via tool call for depth on demand.
 *
 * Cache: 30s TTL, refreshed lazily on access (no background timer). Stale
 * data preferred over no data.
 */

import { COGNITIVE_IMPLANTS } from '../config/cognitiveImplants.js'
import { getRegisteredPlugins } from './layers/pluginRegistry.js'

// QMH-5/1 — implants are required to surface a multi-axis status so the UI
// can stop rendering "DOWN" for every non-healthy state. The four honest
// non-healthy states are license-required, service-unreachable, collecting
// (insufficient data), and a real failure.
//
// Tier → required plugin map. Implants with tier 'pro' or 'complete' need
// the matching QuoxMind plugin licensed; otherwise they render as
// `license_required` rather than `down`. Free-tier implants never use this
// fallback (a free implant that refuses to compute is a real bug).
const TIER_REQUIRED_PLUGIN = {
  pro: 'quoxmind-pro',
  complete: 'quoxmind-complete',
}

/**
 * Derive a multi-axis implant status from fetcher output.
 *
 * Inputs:
 *   data           the fetcher result (or null when the fetcher itself returned nothing)
 *   isLocked       client-side license check (plugin not installed)
 *   requiredPlugin from cognitiveImplants tier config (e.g. 'quoxmind-pro')
 *
 * Output:
 *   { status, healthScore, statusReason }
 *
 * Status enum (kept stable for system-prompt injection):
 *   healthy            score >= 80 with real data
 *   degraded           50 <= score < 80
 *   down               real failure: score < 50 with real data
 *   license_required   license missing — UI shows "🔒 Premium feature"
 *   unreachable        backend service down — UI shows "⚠ Service unreachable: <name>"
 *   collecting         endpoint reachable but score is null — UI shows "◐ Collecting"
 *   offline            no data and no failureReason (legacy fallback)
 */
export function deriveImplantStatus(data, { isLocked = false, requiredPlugin = null } = {}) {
  // 1. License gate — server sentinel OR client-side license check both win
  //    over numeric health, so we never label a license-blocked implant
  //    "DOWN" or "degraded".
  const serverLicense = data?.failureReason?.code === 'LICENSE_REQUIRED'
  const clientLicense = isLocked && requiredPlugin
  if (serverLicense || clientLicense) {
    return {
      status: 'license_required',
      healthScore: null,
      statusReason: {
        code: 'LICENSE_REQUIRED',
        requiredPlugin: data?.failureReason?.requiredPlugin || requiredPlugin || null,
      },
    }
  }

  // 2. No data at all → offline (the fetcher returned null entirely)
  if (!data) {
    return { status: 'offline', healthScore: 0, statusReason: { code: 'NO_DATA' } }
  }

  // 3. Service unreachable — explicit sentinel from the fetcher OR the
  //    legacy `fallback: true` boolean used by every fetcher's catch block.
  const unreachable =
    data.failureReason?.code === 'SERVICE_UNREACHABLE' || data.fallback === true
  if (unreachable) {
    return {
      status: 'unreachable',
      healthScore: null,
      statusReason: {
        code: 'SERVICE_UNREACHABLE',
        service: data.failureReason?.service || null,
        message: data.failureReason?.message || null,
      },
    }
  }

  // 4. Collecting — the endpoint is reachable but does not yet have enough
  //    signal to compute a health score. Surfaces as "◐ Collecting" not "DOWN".
  const score = data.healthScore ?? null
  if (score === null) {
    return {
      status: 'collecting',
      healthScore: null,
      statusReason: {
        code: 'COLLECTING',
        message: data.primaryMetric?.label || 'Collecting',
      },
    }
  }

  // 5. Real numeric thresholds. score < 50 with real data is the only path
  //    that legitimately maps to "DOWN".
  if (score >= 80) return { status: 'healthy',  healthScore: Math.round(score), statusReason: null }
  if (score >= 50) return { status: 'degraded', healthScore: Math.round(score), statusReason: null }
  return { status: 'down', healthScore: Math.round(score), statusReason: { code: 'LOW_HEALTH' } }
}

/**
 * Map tier → required plugin, used by buildIndex to decide whether a
 * locked implant is `license_required` (tier > free) versus a true bug.
 */
export function requiredPluginForTier(tier) {
  return TIER_REQUIRED_PLUGIN[tier] || null
}

// ── Lazy imports (avoid circular deps, work in test env) ──────────

let _fetchAllImplantData = null
let _getLockedImplants = null
let _getAssistants = null
let _getIndexStats = null

async function loadDeps() {
  if (_fetchAllImplantData) return
  try {
    const topo = await import('./cognitiveTopologyService.js')
    _fetchAllImplantData = topo.fetchAllImplantData
    _getLockedImplants = topo.getLockedImplants
  } catch { _fetchAllImplantData = async () => ({}); _getLockedImplants = () => [] }

  try {
    const reg = await import('./entityRegistry.js')
    _getAssistants = reg.getAssistants
  } catch { _getAssistants = () => ({}) }

  try {
    const cap = await import('./capabilityIndex.js')
    _getIndexStats = cap.getIndexStats
  } catch { _getIndexStats = () => ({}) }
}

// ── Cache ──────────────────────────────────────────────────────────

let _cache = null
let _cacheTimestamp = 0
const CACHE_TTL = 30000  // 30 seconds

// ── Core: Build the index ─────────────────────────────────────────

async function buildIndex() {
  await loadDeps()

  const timestamp = new Date().toISOString()

  // Fetch implant data (parallel, with timeouts already in cognitiveTopologyService)
  let implantData = {}
  let lockedImplants = []
  try {
    implantData = await _fetchAllImplantData() || {}
    lockedImplants = _getLockedImplants() || []
  } catch { /* fallback to empty */ }

  // Build implant index
  const implants = {}
  for (const [id, config] of Object.entries(COGNITIVE_IMPLANTS)) {
    const data = implantData[id]
    const primaryMetric = config.metrics?.find(m => m.primary)
    const primaryValue = data ? data[primaryMetric?.key] : null
    const isLocked = lockedImplants.includes(id)
    const requiredPlugin = requiredPluginForTier(config.tier)

    // QMH-5/1: derive a multi-axis status. The legacy single-axis output
    // ("DOWN" for everything that isn't healthy/degraded) is gone — the
    // helper distinguishes license-required, unreachable, collecting,
    // and a real failure ("down").
    const derived = deriveImplantStatus(data, { isLocked, requiredPlugin })

    // Numeric health stays available for legacy widgets (HealthBar etc.).
    // For non-numeric statuses (license/unreachable/collecting) we expose 0
    // rather than 50 so progress bars don't lie.
    let health = derived.healthScore ?? 0
    if (derived.status === 'healthy' || derived.status === 'degraded' || derived.status === 'down') {
      // Real numeric health.
    } else if (data && derived.statusReason?.code === 'NO_DATA') {
      // Legacy fields some fetchers expose (uptimePercent etc.) — only used
      // when the helper had nothing to score against.
      health = data.overallHealth ?? data.health ?? data.uptimePercent ?? data.successRate ?? data.contextUtilization ?? 0
    }

    implants[id] = {
      name: config.name,
      health: Math.round(health),
      status: derived.status,
      statusReason: derived.statusReason,
      requiredPlugin: derived.statusReason?.requiredPlugin || (isLocked ? requiredPlugin : null),
      tier: config.tier,
      inspiredBy: config.inspiredBy,
      primaryMetric: primaryMetric?.label,
      primaryValue: primaryValue != null ? primaryValue : null,
      locked: isLocked,
    }
  }

  // Agent roster
  let agents = { count: 0, active: 0, roster: [] }
  try {
    const assistants = _getAssistants()
    const list = Object.entries(assistants)
    agents = {
      count: list.length,
      active: list.filter(([, a]) => a.active !== false).length,
      roster: list.map(([id, a]) => a.identity?.name || a.name || id.toUpperCase()),
    }
  } catch { /* fallback */ }

  // Capabilities
  let capabilities = { tools: 0, workflows: 0, assistants: 0, intents: 0 }
  try {
    const stats = _getIndexStats()
    capabilities = {
      tools: stats?.tools || 0,
      workflows: stats?.workflows || 0,
      assistants: stats?.assistants || 0,
      intents: stats?.uniqueIntents || 0,
    }
  } catch { /* fallback */ }

  // Memory (from implant data — quox-memory already fetched)
  const memData = implantData['quox-memory'] || {}
  const memory = {
    total: memData.totalMemories || 0,
    episodic: memData.episodic || 0,
    semantic: memData.semantic || 0,
    entities: memData.entities || 0,
    learned: memData.learned || 0,
  }

  // Guardian (from implant data — quox-guard maps to reliability)
  const guardData = implantData['quox-guard'] || {}
  const guardian = {
    uptimePercent: guardData.uptimePercent || 0,
    servicesUp: guardData.servicesUp || '0/0',
    alertsActive: guardData.alertsActive || 0,
  }

  // Core health (from quox-sense implant)
  const senseData = implantData['quox-sense'] || {}
  const core = {
    health: senseData.overallHealth || 0,
    status: senseData.status || 'unknown',
    activeServices: senseData.activeServices || 0,
    totalServices: senseData.totalServices || 0,
  }

  // Codebase awareness (from quox-nucleus implant)
  const nucleusData = implantData['quox-nucleus'] || {}
  const codebase = {
    repoCount: nucleusData.repoCount || 0,
    indexedFiles: nucleusData.indexedFiles || 0,
    connections: nucleusData.connections || 0,
    status: nucleusData.status || 'offline',
    avgQueryMs: nucleusData.avgQueryMs || 0,
    cacheHitRate: nucleusData.cacheHitRate || 0,
  }

  // Implant summary counts. After QMH-5/1 the status enum has more values;
  // `lockedCount` now counts both legacy 'locked' (no longer emitted) and
  // 'license_required' so existing dashboards keep their gauge.
  const isLockedStatus = (s) => s === 'locked' || s === 'license_required'
  const isFailureStatus = (s) => s === 'offline' || s === 'unreachable' || s === 'down'
  const healthyCount = Object.values(implants).filter(i => i.status === 'healthy').length
  const degradedCount = Object.values(implants).filter(i => i.status === 'degraded').length
  const collectingCount = Object.values(implants).filter(i => i.status === 'collecting').length
  const lockedCount = Object.values(implants).filter(i => isLockedStatus(i.status)).length
  const unreachableCount = Object.values(implants).filter(i => i.status === 'unreachable').length
  const offlineCount = Object.values(implants).filter(i => isFailureStatus(i.status)).length

  return {
    timestamp,
    core,
    implants,
    implantSummary: {
      total: 13,
      healthy: healthyCount,
      degraded: degradedCount,
      collecting: collectingCount,
      locked: lockedCount,
      unreachable: unreachableCount,
      offline: offlineCount,
    },
    agents,
    capabilities,
    memory,
    guardian,
    codebase,
    plugins: buildPluginList(),
    concerns: await fetchConcerns(),
  }
}

async function fetchConcerns() {
  try {
    const resp = await fetch('/collector/api/internal/concerns', { signal: AbortSignal.timeout(3000) })
    if (!resp.ok) return { active: 0, top: null, signals: null }
    const data = await resp.json()
    return {
      active: data.concerns?.length || 0,
      top: data.concerns?.[0]?.description || null,
      hostsWithWarnings: data.signals?.hostsWithWarnings || 0,
      cascades: data.signals?.cascadesDetected || 0,
    }
  } catch {
    return { active: 0, top: null, hostsWithWarnings: 0, cascades: 0 }
  }
}

function buildPluginList() {
  try {
    const plugins = getRegisteredPlugins()
    const enabled = Array.isArray(plugins) ? plugins.filter(p => p.enabled) : []
    return {
      installed: enabled.length,
      list: enabled.map(p => p.name || p.id).slice(0, 20),
    }
  } catch {
    return { installed: 0, list: [] }
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Refresh the mirror cache. Invoked lazily by getIndex() whenever the
 * cached copy is older than CACHE_TTL. Can also be called directly to
 * force an immediate refresh.
 */
export async function refreshMirror() {
  try {
    _cache = await buildIndex()
    _cacheTimestamp = Date.now()
  } catch (err) {
    console.error('[Mirror] Refresh failed:', err.message)
    // Keep stale cache — better than nothing
  }
}

/**
 * Get the cached index, refreshing if stale.
 */
async function getIndex() {
  if (!_cache || (Date.now() - _cacheTimestamp) > CACHE_TTL) {
    await refreshMirror()
  }
  return _cache || { timestamp: new Date().toISOString(), implants: {}, agents: { count: 0, active: 0, roster: [] }, capabilities: {}, memory: { total: 0 }, guardian: {}, core: { health: 0 }, codebase: { status: 'offline' }, implantSummary: { total: 13, healthy: 0 } }
}

/**
 * Get the full Mirror index as JSON.
 * Used by: execution_intelligence tool, COREY context, detailed queries.
 */
export async function getFullIndex() {
  return getIndex()
}

/**
 * Get a compact injection string for system prompts (~150-200 tokens).
 * Used by: quoxContext.js → collector system prompt injection.
 */
export async function getCompactInjection() {
  const idx = await getIndex()

  // Build implant status line. QMH-5/1: icons mirror the multi-axis status
  // so agents can see at a glance which implants are blocked by license vs
  // genuinely failing vs still warming up.
  const STATUS_ICON = {
    healthy: '●',
    degraded: '◐',
    collecting: '◐',
    license_required: '🔒',
    unreachable: '⚠',
    down: '❌',
    offline: '×',
    locked: '○',         // legacy fallback
  }
  const implantLine = Object.entries(idx.implants).map(([, i]) => {
    const icon = STATUS_ICON[i.status] || '×'
    const value = i.primaryValue != null
      ? (typeof i.primaryValue === 'number' && i.primaryMetric?.includes('%')
        ? `(${Math.round(i.primaryValue)}%)`
        : `(${i.primaryValue})`)
      : ''
    return `${icon}${i.name.replace('Quox', '')}${value}`
  }).join(' ')

  const pluginLine = idx.plugins?.list?.length > 0
    ? `Plugins: ${idx.plugins.installed} installed (${idx.plugins.list.slice(0, 8).join(', ')}${idx.plugins.list.length > 8 ? '...' : ''})`
    : ''

  const concernLine = idx.concerns?.active > 0
    ? `Concerns: ${idx.concerns.active} active${idx.concerns.top ? ` (top: ${idx.concerns.top.substring(0, 60)})` : ''}${idx.concerns.cascades > 0 ? ` | ${idx.concerns.cascades} cascades` : ''}`
    : ''

  const codebaseLine = idx.codebase?.status !== 'offline'
    ? `Codebase: ${idx.codebase.repoCount} repos | ${idx.codebase.indexedFiles.toLocaleString()} files | ${idx.codebase.connections.toLocaleString()} connections | query: \`repobrain query "..."\``
    : ''

  return `## QuoxMind Mirror
Core: ${idx.core.health}% | ${idx.core.activeServices}/${idx.core.totalServices} services | ${idx.implantSummary.healthy}/${idx.implantSummary.total} implants healthy
${implantLine}
Agents: ${idx.agents.count} (${idx.agents.active} active) | Tools: ${idx.capabilities.tools} | Workflows: ${idx.capabilities.workflows}
Memory: ${idx.memory.total} items (${idx.memory.episodic} episodic, ${idx.memory.entities} entities, ${idx.memory.learned} learned)
Guardian: ${idx.guardian.servicesUp} services up | ${idx.guardian.alertsActive} alerts | ${idx.guardian.uptimePercent}% uptime
${codebaseLine}
${pluginLine}
${concernLine}
For details use execution_intelligence tool with action: mirror_index, implant_detail, or engine_health.`
}

/**
 * Get cache age in milliseconds.
 */
export function getMirrorAge() {
  return _cacheTimestamp > 0 ? Date.now() - _cacheTimestamp : Infinity
}
