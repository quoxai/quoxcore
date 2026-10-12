/**
 * useCogCore3DState — Central data hook for Cognitive Core 3D.
 *
 * DOES NOT use useOpsDeckState or useAuth — those crash R3F views.
 * Instead calls APIs directly with plain fetch().
 *
 * HONESTY RULE: mock data is NEVER shown as if it were live. It is only
 * ever returned when demo mode is explicitly enabled (see isDemoModeEnabled
 * below — `?demo=true` query param or `VITE_COGCORE_DEMO=true` env var).
 * Outside demo mode, an empty/errored data source renders an honest empty
 * result, never a fabricated one.
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { agentRegistry } from '../../../config/agentRegistry'
import { assistants } from '../../../config/assistants'
import { fetchAllImplantData, getLockedImplants } from '../../../services/cognitiveTopologyService'
import { MOCK_AGENTS, MOCK_IMPLANTS, MOCK_OBJECTIVES, MOCK_MEMORIES } from '../lib/mock-data'
import { queryEnvelopes } from '../../../lib/aee/store'

/**
 * Demo mode is OFF by default. It must be explicitly requested via
 * `?demo=true` in the URL or the `VITE_COGCORE_DEMO=true` build env var.
 * When on, empty/errored live data sources fall back to mock data so the
 * view can be demoed without a live backend. When off (the default),
 * empty/errored sources render honest empty results instead.
 */
export function isDemoModeEnabled(search, env) {
  try {
    const params = new URLSearchParams(search || '')
    if (params.get('demo') === 'true') return true
  } catch { /* no URLSearchParams support / malformed search */ }
  try {
    if (env?.VITE_COGCORE_DEMO === 'true') return true
  } catch { /* env not available */ }
  return false
}

// VOLT store — optional, may not be initialized
let queryVoltRuns
try {
  const voltStore = require('../../../lib/volt/volt-store')
  queryVoltRuns = voltStore.queryRuns
} catch { /* optional */ }

// AOCL analytics — loaded on first poll, not at module init
let getAoclLayerStats = null
let aoclLoaded = false

// Memory functions — these read from localStorage, no auth needed
let getWorkingSet, getRecentEntities, getOpenLoops
try {
  const wsm = require('../../../services/workingSetMemory')
  getWorkingSet = wsm.getWorkingSet
  getRecentEntities = wsm.getRecentEntities
  getOpenLoops = wsm.getOpenLoops
} catch { /* optional */ }

const QUOXMIND_NAMES = {
  'quox-sense': 'QuoxSense', 'quox-memory': 'QuoxMemory',
  'quox-temporal': 'QuoxTemporal', 'quox-focus': 'QuoxFocus',
  'quox-value': 'QuoxValue', 'quox-guard': 'QuoxGuard',
  'quox-insight': 'QuoxInsight', 'quox-executive': 'QuoxExecutive',
  'quox-predict': 'QuoxPredict', 'quox-reflect': 'QuoxReflect',
  'quox-dream': 'QuoxDream', 'quox-learn': 'QuoxLearn',
}

const IMPLANT_COLORS = {
  'quox-sense': '#a78bfa', 'quox-memory': '#ec4899', 'quox-temporal': '#22c55e',
  'quox-focus': '#06b6d4', 'quox-value': '#3b82f6', 'quox-guard': '#818cf8',
  'quox-insight': '#f59e0b', 'quox-executive': '#22c55e', 'quox-predict': '#818cf8',
  'quox-reflect': '#a78bfa', 'quox-dream': '#06b6d4', 'quox-learn': '#3b82f6',
}

const IMPLANT_LAYERS = {
  'quox-sense': 'sensory', 'quox-memory': 'sensory', 'quox-temporal': 'sensory', 'quox-guard': 'sensory',
  'quox-focus': 'cortical', 'quox-value': 'cortical', 'quox-insight': 'cortical',
  'quox-executive': 'cortical', 'quox-predict': 'cortical',
  'quox-reflect': 'consolidative', 'quox-dream': 'consolidative', 'quox-learn': 'consolidative',
}

const CLUSTER_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#ef4444', '#10b981']

export default function useCogCore3DState() {
  const [implantData, setImplantData] = useState(null)
  const [lockedImplants, setLockedImplants] = useState([])
  const [memoryData, setMemoryData] = useState(null)
  const [objectives, setObjectives] = useState(null)
  const [engineHealth, setEngineHealth] = useState(null)
  const [collectorHealth, setCollectorHealth] = useState(null)
  const [aeeEnvelopes, setAeeEnvelopes] = useState([])
  const [voltRuns, setVoltRuns] = useState([])
  const [aoclStats, setAoclStats] = useState([])
  const [currentOrgId, setCurrentOrgId] = useState(null)
  // Track fetch failures per data source so we can surface a real degraded
  // state instead of silently showing an empty/stale view.
  const [implantsError, setImplantsError] = useState(false)
  const [objectivesError, setObjectivesError] = useState(false)

  const isDemoMode = useMemo(
    () => isDemoModeEnabled(
      typeof window !== 'undefined' ? window.location.search : '',
      typeof import.meta !== 'undefined' ? import.meta.env : undefined,
    ),
    [],
  )

  // ── Fetch current org from auth service (no context hooks) ──
  useEffect(() => {
    let mounted = true
    const fetchOrg = async () => {
      try {
        const res = await fetch('/api/orgs', { credentials: 'include', signal: AbortSignal.timeout(5000) })
        if (res.ok) {
          const orgs = await res.json()
          if (mounted && Array.isArray(orgs) && orgs.length > 0) {
            setCurrentOrgId(orgs[0].id || orgs[0].slug)
          }
        }
      } catch { /* auth service not reachable */ }
    }
    fetchOrg()
    return () => { mounted = false }
  }, [])

  // ── Poll real system health (no auth needed) ──
  useEffect(() => {
    let mounted = true
    const poll = async () => {
      try {
        const opts = { credentials: 'include' }
        const [engRes, colRes, taskRes] = await Promise.all([
          fetch('/tasks/api/engine/health', opts).catch(() => null),
          fetch('/collector/health', opts).catch(() => null),
          fetch('/tasks/health', opts).catch(() => null),
        ])
        if (mounted) {
          if (engRes?.ok) setEngineHealth(await engRes.json())
          if (colRes?.ok) setCollectorHealth(await colRes.json())
          // Tasks health has active_objectives count
          if (taskRes?.ok) {
            const th = await taskRes.json()
            if (th.active_objectives > 0) {
              // If there are active objectives, try to fetch them
              // (this will fail without auth but worth trying)
            }
          }
        }
      } catch { /* API unavailable */ }
    }
    poll()
    const id = setInterval(poll, 8000)
    return () => { mounted = false; clearInterval(id) }
  }, [])

  // ── Poll AEE envelopes from IndexedDB (real protocol data) ──
  useEffect(() => {
    let mounted = true
    const poll = async () => {
      try {
        const envelopes = await queryEnvelopes({ limit: 50, sortOrder: 'desc' })
        if (mounted && envelopes?.length > 0) setAeeEnvelopes(envelopes)
      } catch { /* IndexedDB not available */ }
    }
    poll()
    const id = setInterval(poll, 10000)
    return () => { mounted = false; clearInterval(id) }
  }, [])

  // ── Poll VOLT runs from IndexedDB (real protocol evidence chain) ──
  useEffect(() => {
    if (!queryVoltRuns) return
    let mounted = true
    const poll = async () => {
      try {
        const runs = await queryVoltRuns({ limit: 30 })
        if (mounted && runs?.length > 0) setVoltRuns(runs)
      } catch { /* VOLT store not initialized */ }
    }
    poll()
    const id = setInterval(poll, 15000)
    return () => { mounted = false; clearInterval(id) }
  }, [])

  // ── Poll AOCL layer stats (lazy-loaded to avoid circular init) ──
  useEffect(() => {
    let mounted = true
    const poll = async () => {
      try {
        if (!aoclLoaded) {
          const mod = await import('../../../services/aoclAnalytics')
          getAoclLayerStats = mod.getLayerStats
          aoclLoaded = true
        }
        if (!getAoclLayerStats) return
        const stats = await getAoclLayerStats({ timeRange: 86400000 })
        if (mounted && stats && Object.keys(stats).length > 0) {
          setAoclStats(Object.values(stats))
        }
      } catch { /* AOCL analytics not available */ }
    }
    poll()
    const id = setInterval(poll, 30000)
    return () => { mounted = false; clearInterval(id) }
  }, [])

  // ── Agents from registry — state derived from real system data ──
  const agents = useMemo(() => {
    try {
      const hasAlerts = engineHealth?.alerts_24h > 0

      return Object.entries(agentRegistry.agents).map(([id, agent]) => {
        // Derive state from real system signals — no fabricated activity.
        let state = 'idle'
        if (id === 'quox') state = 'active' // orchestrator always active
        else if (hasAlerts && (id === 'sentinel' || id === 'cipher')) state = 'thinking' // security agents active on alerts

        return {
          id,
          name: assistants[id]?.name || agent.name || id.toUpperCase(),
          role: agent.role || 'specialist',
          source: agent.ownership?.source || 'core',
          color: assistants[id]?.color || '#6366f1',
          state,
          description: agent.description || '',
          tools: agent.tools || [],
          capabilities: agent.capabilities || [],
        }
      })
    } catch {
      // Agent registry itself failed to build — an honest empty list is
      // preferable to fabricated agents standing in for a real error.
      return isDemoMode ? MOCK_AGENTS : []
    }
  }, [engineHealth, collectorHealth, isDemoMode])

  // ── Poll implant health every 5s ──
  useEffect(() => {
    let mounted = true
    const poll = async () => {
      try {
        const data = await fetchAllImplantData()
        if (mounted && data) { setImplantData(data); setImplantsError(false) }
        const locked = typeof getLockedImplants === 'function' ? getLockedImplants() : []
        if (mounted) setLockedImplants(locked)
      } catch {
        // API unavailable — surface as a real degraded state, not silence.
        if (mounted) setImplantsError(true)
      }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => { mounted = false; clearInterval(id) }
  }, [])

  // ── Poll memory every 5s (reads localStorage, no auth) ──
  useEffect(() => {
    let mounted = true
    const poll = () => {
      try {
        const wsm = getWorkingSet?.()
        const entities = getRecentEntities?.(null, 15) || []
        const loops = getOpenLoops?.({ status: 'open' }) || []
        if (mounted) setMemoryData({ wsm, entities, loops })
      } catch { /* optional */ }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => { mounted = false; clearInterval(id) }
  }, [])

  // ── Poll objectives every 10s (direct fetch, org-scoped if available) ──
  useEffect(() => {
    let mounted = true
    const poll = async () => {
      try {
        const orgParam = currentOrgId ? `&org_id=${currentOrgId}` : ''
        const res = await fetch(`/tasks/api/objectives?status=running&limit=20${orgParam}`, { credentials: 'include' })
        if (res.ok) {
          const data = await res.json()
          if (mounted) {
            setObjectives(data.objectives || [])
            setObjectivesError(false)
          }
        } else if (mounted) {
          setObjectivesError(true)
        }
      } catch {
        // API unavailable — surface as a real degraded state, not silence.
        if (mounted) setObjectivesError(true)
      }
    }
    poll()
    const id = setInterval(poll, 10000)
    return () => { mounted = false; clearInterval(id) }
  }, [currentOrgId])

  // ── Build implants ──
  const implants = useMemo(() => {
    if (!implantData) return isDemoMode ? MOCK_IMPLANTS : []
    try {
      const result = Object.entries(implantData)
        .filter(([, data]) => data !== null)
        .map(([id, data]) => ({
          id,
          name: QUOXMIND_NAMES[id] || id,
          health: data?.healthScore ?? data?.overallHealth ?? data?.health ?? 50,
          color: IMPLANT_COLORS[id] || '#8b5cf6',
          layer: IMPLANT_LAYERS[id] || 'cortical',
          locked: lockedImplants.includes(id),
        }))
      // An empty result here is honest (no implant data reported) — it is
      // NOT the same as "the API failed", which is tracked via implantsError.
      return result.length > 0 ? result : (isDemoMode ? MOCK_IMPLANTS : [])
    } catch {
      return isDemoMode ? MOCK_IMPLANTS : []
    }
  }, [implantData, lockedImplants, isDemoMode])

  // ── Build objectives ──
  const objectivesList = useMemo(() => {
    if (!objectives || objectives.length === 0) return isDemoMode ? MOCK_OBJECTIVES : []
    try {
      return objectives.map((obj, i) => ({
        id: obj.id,
        title: obj.title || 'Objective',
        status: obj.status || 'running',
        accentColor: CLUSTER_COLORS[i % CLUSTER_COLORS.length],
        tasks: (obj.tasks || []).map(t => ({
          id: t.id,
          title: t.title || t.description || 'Task',
          status: t.status || 'pending',
          agentId: t.agent_id || null,
        })),
      }))
    } catch {
      return isDemoMode ? MOCK_OBJECTIVES : []
    }
  }, [objectives, isDemoMode])

  // ── Build memories ──
  const memories = useMemo(() => {
    if (!memoryData) return isDemoMode ? MOCK_MEMORIES : []
    try {
      const items = []
      const now = Date.now()
      const ageFromTs = (ts) => ts ? Math.min(1, (now - new Date(ts).getTime()) / (7 * 86400000)) : 0.5

      if (memoryData.entities?.length > 0) {
        memoryData.entities.slice(0, 8).forEach((e, i) => {
          items.push({ id: `entity-${e.id || i}`, type: 'entity', content: `${e.name || e.id}`, age: ageFromTs(e.lastMentioned) })
        })
      }
      if (memoryData.loops?.length > 0) {
        memoryData.loops.slice(0, 5).forEach((l, i) => {
          items.push({ id: `loop-${l.id || i}`, type: 'openLoop', content: l.description || 'Open loop', age: ageFromTs(l.firstMentioned) })
        })
      }
      if (memoryData.wsm?.activeProjects?.length > 0) {
        memoryData.wsm.activeProjects.slice(0, 3).forEach((p, i) => {
          items.push({ id: `project-${p.id || i}`, type: 'fact', content: p.name || 'Project', age: ageFromTs(p.lastWorkedOn) })
        })
      }
      // An empty result here is honest (no memory records yet) — NOT the
      // same as a fetch/parse failure.
      return items.length > 0 ? items : (isDemoMode ? MOCK_MEMORIES : [])
    } catch {
      return isDemoMode ? MOCK_MEMORIES : []
    }
  }, [memoryData, isDemoMode])

  // isLive = at least one real API responded
  const isLive = collectorHealth !== null || engineHealth !== null || implantData !== null || memoryData !== null

  // hasError = a known data source failed to fetch — a real degraded state,
  // distinct from "isLive === false" (which can also mean "nothing polled
  // successfully yet" on first mount).
  const hasError = implantsError || objectivesError

  // Derive system state from real health signals
  const systemState = useMemo(() => {
    if (!engineHealth && !collectorHealth) return 'idle'
    if (engineHealth?.alerts_24h > 0) return 'alert'
    const cbOpen = engineHealth?.circuit_breakers?.some(cb => cb.state === 'open')
    if (cbOpen) return 'error'
    if (engineHealth?.objectives_monitored > 0) return 'active'
    if (collectorHealth?.agents_connected > 0) return 'active'
    return 'idle'
  }, [engineHealth, collectorHealth])

  const activeAgentCount = agents.filter(a => a.state !== 'idle').length

  return {
    agents,
    objectives: objectivesList,
    implants,
    memories,
    delegations: [],
    events: aeeEnvelopes,
    aeeEnvelopes,
    voltRuns,
    aoclStats,
    systemState,
    connectionState: hasError ? 'error' : (isLive ? 'connected' : 'disconnected'),
    activeAgents: activeAgentCount,
    totalAgents: agents.length,
    workingSet: memoryData?.wsm || null,
    currentFocus: memoryData?.wsm?.currentFocus || null,
    activeImplantCount: implants.filter(i => !i.locked && i.health > 0).length,
    isLive,
    hasError,
    isDemoMode,
    currentOrgId,
  }
}
