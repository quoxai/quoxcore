/**
 * serverMirror.js — client for the org-scoped server Mirror.
 *
 * The Mirror is built SERVER-SIDE (GET /collector/api/v1/mind/mirror). The
 * browser no longer assembles it from localStorage or frontend registries.
 * Sections the server could not measure arrive as { unknown: {code,service,
 * message} }; the mappers below keep numeric fields null for those (never 0)
 * and attach `<section>.unknown` so the UI can say why.
 */

export const MIRROR_URL = '/collector/api/v1/mind/mirror'

export async function fetchServerMirror({ fetchFn = fetch } = {}) {
  const res = await fetchFn(MIRROR_URL, { credentials: 'include' })
  if (!res.ok) {
    let body = null
    try { body = await res.json() } catch { /* non-JSON error body */ }
    const err = new Error(body?.error || `Mirror request failed (HTTP ${res.status})`)
    err.status = res.status
    err.code = body?.code
    throw err
  }
  return res.json()
}

const STATUS_MAP = {
  'license-required': 'license_required',
  weak: 'degraded',
  'not-reported': 'collecting',
}
const mapStatus = (s) => STATUS_MAP[s] || s

const isUnknown = (x) => !!x && typeof x === 'object' && !Array.isArray(x) && 'unknown' in x && x.unknown != null
const num = (v) => (typeof v === 'number' ? v : null)

export function reflectionFromServer(body) {
  const m = body?.mirror || {}
  const caps = m.capabilities || {}
  const agentsSec = caps.agents
  const toolsSec = caps.tools
  const wfSec = caps.workflows

  const capabilities = {
    totalTools: isUnknown(toolsSec) ? null : num(toolsSec?.total),
    totalWorkflows: isUnknown(wfSec) ? null : num(wfSec),
    totalAssistants: isUnknown(agentsSec) ? null : num(agentsSec?.count),
  }
  if (isUnknown(toolsSec)) capabilities.toolsUnknown = toolsSec.unknown
  if (isUnknown(wfSec)) capabilities.workflowsUnknown = wfSec.unknown
  if (isUnknown(agentsSec)) capabilities.agentsUnknown = agentsSec.unknown

  const h = m.health
  const health = isUnknown(h)
    ? { overall: null, status: 'unknown', activeServices: null, totalServices: null, lastHealthCheck: m.generatedAt || null, unknown: h.unknown }
    : {
        overall: num(h?.score),
        status: h?.status || 'unknown',
        activeServices: num(h?.activeServices),
        totalServices: num(h?.totalServices),
        lastHealthCheck: m.generatedAt || null,
        down: h?.down || [],
        degraded: h?.degraded || [],
      }

  const mem = m.memory
  const memory = isUnknown(mem)
    ? { totalMemories: null, entities: null, relations: null, users: null, byType: null, unknown: mem.unknown }
    : {
        totalMemories: num(mem?.total),
        entities: num(mem?.entities),
        relations: num(mem?.relations),
        users: num(mem?.users),
        byType: mem?.by_type || {},
      }

  const imp = m.implants
  const cognitiveImplants = Array.isArray(imp)
    ? imp.map(i => ({
        id: i.id,
        name: i.name,
        health: i.health ?? null,
        status: mapStatus(i.status),
        statusReason: i.reason || null,
        primaryMetric: i.metric ?? null,
        requiresPlugin: i.status === 'license-required' ? (i.reason?.service || null) : null,
        tier: i.tier,
      }))
    : []

  const list = agentsSec && Array.isArray(agentsSec.list) ? agentsSec.list : []
  const agents = list
    .map(a => ({ id: a.id, name: a.name, level: a.level ?? 1, role: a.role || 'specialist', active: a.entitled !== false }))
    .sort((a, b) => a.level - b.level)

  const pl = m.plugins
  const plugins = pl && Array.isArray(pl.list)
    ? pl.list.map(p => ({ id: p.id, name: p.name, version: p.version, enabled: p.enabled !== false, tier: p.tier }))
    : []

  const cf = m.codebaseFabric
  const codebaseFabric = cf == null ? null : { ...cf }

  const out = {
    version: m.version,
    generatedAt: m.generatedAt,
    generatedBy: m.generatedBy,
    identity: {
      name: m.identity?.name,
      role: m.identity?.role,
      version: m.version,
      description: m.identity?.description,
    },
    cognitiveImplants,
    capabilities,
    agents,
    plugins,
    health,
    memory,
    codebaseFabric,
    implantSummary: m.implantSummary || null,
    unknowns: m.unknowns || [],
    summary: body?.summary || '',
    ageMs: body?.age_ms ?? null,
    fresh: body?.fresh ?? null,
  }
  if (isUnknown(imp)) out.implantsUnknown = imp.unknown
  if (isUnknown(pl)) out.pluginsUnknown = pl.unknown
  if (isUnknown(agentsSec)) out.agentsUnknown = agentsSec.unknown
  return out
}

export function indexFromServer(body) {
  const r = reflectionFromServer(body)
  const m = body?.mirror || {}

  const implants = {}
  for (const i of r.cognitiveImplants) {
    implants[i.id] = {
      name: i.name,
      health: i.health,
      status: i.status,
      statusReason: i.statusReason,
      tier: i.tier,
      primaryMetric: i.primaryMetric,
    }
  }
  const all = r.cognitiveImplants
  const count = (...ss) => all.filter(i => ss.includes(i.status)).length

  const cf = m.codebaseFabric
  const cfKnown = cf && !isUnknown(cf)

  return {
    timestamp: r.generatedAt,
    core: {
      health: r.health.overall,
      status: r.health.status,
      activeServices: r.health.activeServices,
      totalServices: r.health.totalServices,
    },
    implants,
    implantSummary: {
      total: m.implantSummary?.total ?? all.length,
      healthy: count('healthy'),
      degraded: count('degraded'),
      collecting: count('collecting'),
      locked: count('license_required', 'locked'),
      unreachable: count('unreachable'),
      offline: count('down', 'offline'),
    },
    agents: {
      count: r.capabilities.totalAssistants,
      active: r.agents.filter(a => a.active).length,
      roster: r.agents.map(a => a.name),
    },
    capabilities: {
      tools: r.capabilities.totalTools,
      workflows: r.capabilities.totalWorkflows,
      assistants: r.capabilities.totalAssistants,
    },
    memory: { total: r.memory.totalMemories, entities: r.memory.entities },
    codebase: {
      repoCount: cfKnown ? cf.repos ?? null : null,
      indexedFiles: cfKnown ? cf.indexedFiles ?? null : null,
      status: cfKnown ? cf.invariantStatus ?? 'unknown' : 'unknown',
    },
    plugins: {
      installed: m.plugins && !isUnknown(m.plugins) ? m.plugins.installed ?? null : null,
      list: r.plugins.map(p => p.id),
    },
    summary: r.summary,
  }
}
