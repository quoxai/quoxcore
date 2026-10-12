/**
 * useOpsDeckState V2 — Multi-objective state management
 *
 * Loads ALL running objectives and builds agent groups for each.
 * Each group has its own orchestrator, agents, and SSE connection.
 * Returns groups[] for the React Flow canvas to render as clusters.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { getBuiltInTeam } from '../../config/teams/index'
import { useAuth } from '../../contexts/AuthContext'
import { listObjectives, getObjective } from '../../services/objectivesClient'

const STALE_THRESHOLD_MS = 45_000
const TASKS_BASE = '/tasks'
const POLL_INTERVAL = 30_000

const SSE_EVENTS = [
  'connected', 'task_started', 'task_completed', 'task_failed',
  'task_heartbeat', 'task_skipped', 'decomposition_completed',
  'objective_completed', 'objective_failed', 'objective_paused',
  'objective_resumed', 'objective_cancelled', 'objective_started',
]

function safeJsonParse(data) {
  try { return JSON.parse(data) }
  catch { return null }
}

/**
 * Build agent map from a team config.
 */
function buildAgentsFromTeam(teamConfig) {
  const agents = new Map()
  if (!teamConfig) return agents
  for (const member of teamConfig.members || []) {
    agents.set(member.agentId, {
      id: member.agentId,
      name: member.agentId,
      description: member.domains?.join(', ') || '',
      role: member.role || 'specialist',
      state: 'idle',
      currentTask: null,
      completedTasks: 0,
      failedTasks: 0,
      lastActivityTs: null,
      stale: false,
      taskHistory: [],
    })
  }
  return agents
}

function resolveNames(agents) {
  try {
    const { agentRegistry } = require('../../config/agentRegistry')
    const next = new Map(agents)
    for (const [id, agent] of next) {
      const reg = agentRegistry?.agents?.[id]
      if (reg?.name && agent.name === id) {
        next.set(id, { ...agent, name: reg.name })
      } else if (agent.name === id) {
        next.set(id, { ...agent, name: id.toUpperCase() })
      }
    }
    return next
  } catch {
    return agents
  }
}

/**
 * Manage a single SSE connection for one objective.
 */
class ObjectiveStream {
  constructor(objectiveId, onEvent, onConnectionError) {
    this.objectiveId = objectiveId
    this.onEvent = onEvent
    this.onConnectionError = onConnectionError
    this.eventSource = null
    this.reconnectTimer = null
    this.attempt = 0
  }

  connect() {
    this.close()
    try {
      const url = `${TASKS_BASE}/api/objectives/${this.objectiveId}/stream`
      this.eventSource = new EventSource(url, { withCredentials: true })
      this.eventSource.onopen = () => { this.attempt = 0 }
      this.eventSource.onerror = () => {
        this.eventSource?.close()
        this.eventSource = null
        // Surface the connection loss instead of leaving the UI's
        // connection dot stuck on a stale/misleading state while we
        // silently retry in the background.
        this.onConnectionError?.()
        const delay = Math.min(1000 * Math.pow(2, this.attempt), 60000)
        this.attempt++
        this.reconnectTimer = setTimeout(() => this.connect(), delay)
      }
      for (const type of SSE_EVENTS) {
        this.eventSource.addEventListener(type, (e) => {
          const data = safeJsonParse(e.data)
          if (data) this.onEvent(this.objectiveId, type, data)
        })
      }
    } catch {
      // EventSource construction itself failed (e.g. malformed URL, CSP) —
      // this is a real inability to connect, not "endpoint doesn't exist
      // yet". Surface it rather than silently doing nothing.
      this.onConnectionError?.()
    }
  }

  close() {
    if (this.eventSource) { this.eventSource.close(); this.eventSource = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
  }
}

export default function useOpsDeckState() {
  const { authFetch } = useAuth()
  const [groups, setGroups] = useState([])
  const [objectives, setObjectives] = useState([])
  const [systemState, setSystemState] = useState('idle')
  const [connectionState, setConnectionState] = useState('disconnected')

  const streamsRef = useRef(new Map()) // objectiveId → ObjectiveStream
  const groupsRef = useRef(groups)
  const eventsRef = useRef([]) // last 50 events, newest first
  // Persist dismissed IDs in localStorage so they survive refresh
  const dismissedRef = useRef((() => {
    try {
      const stored = JSON.parse(localStorage.getItem('opsdeck_dismissed') || '[]')
      return new Set(stored.slice(-50))
    } catch { return new Set() }
  })())
  const [events, setEvents] = useState([])
  const [delegations, setDelegations] = useState([])
  const lastCompletedAgentRef = useRef({}) // objectiveId → { agentId, ts }

  // Hydrate agent states from current task data
  const hydrateGroup = useCallback(async (group) => {
    if (!authFetch) return group
    try {
      const detail = await getObjective(authFetch, group.objective.id)
      const tasks = detail.tasks || []
      const nextAgents = new Map(group.agents)

      for (const task of tasks) {
        const agentId = task.agent_id
        if (!agentId) continue
        // Auto-create agent entry if not in team manifest (no-team objectives)
        if (!nextAgents.has(agentId) && agentId !== group.orchestrator?.id) {
          nextAgents.set(agentId, {
            id: agentId, name: agentId.toUpperCase(), description: '', role: 'specialist',
            state: 'idle', currentTask: null, completedTasks: 0, failedTasks: 0,
            lastActivityTs: null, stale: false, taskHistory: [],
          })
        }
        const agent = nextAgents.get(agentId)
        if (!agent) continue

        if (task.status === 'running' || task.status === 'in_progress') {
          nextAgents.set(agentId, {
            ...agent,
            state: 'thinking',
            currentTask: { id: task.id, title: task.title, startedAt: task.started_at ? new Date(task.started_at).getTime() : Date.now() },
            lastActivityTs: Date.now(),
          })
        } else if (task.status === 'completed') {
          nextAgents.set(agentId, { ...agent, completedTasks: agent.completedTasks + 1 })
        } else if (task.status === 'failed') {
          nextAgents.set(agentId, { ...agent, failedTasks: agent.failedTasks + 1 })
        }
      }

      const completedCount = tasks.filter(t => t.status === 'completed').length
      const states = [...nextAgents.values()].map(a => a.state)
      let orchState = 'idle'
      if (states.some(s => s === 'blocked')) orchState = 'blocked'
      else if (states.some(s => s === 'thinking' || s === 'executing')) orchState = 'thinking'
      else if (states.some(s => s === 'done')) orchState = 'done'

      return {
        ...group,
        agents: resolveNames(nextAgents),
        orchestratorState: orchState,
        objective: { ...group.objective, taskCount: detail.task_count || tasks.length, completedCount },
      }
    } catch {
      return group
    }
  }, [authFetch])

  // Build a group for a single objective
  const buildGroup = useCallback((obj) => {
    const teamId = obj.team_id || obj.team_config_id
    const team = teamId ? getBuiltInTeam(teamId) : null
    const agents = team ? resolveNames(buildAgentsFromTeam(team)) : new Map()
    const orchestrator = team ? {
      id: team.orchestrator.agentId,
      name: team.orchestrator.agentId.toUpperCase(),
      displayName: team.displayName,
    } : {
      // No team — use QUOX as default orchestrator
      id: 'quox',
      name: 'QUOX',
      displayName: 'Direct Objective',
    }

    // For no-team objectives, build agents from task agent_ids if available
    if (!team && obj.tasks && Array.isArray(obj.tasks)) {
      for (const task of obj.tasks) {
        if (task.agent_id && task.agent_id !== 'quox' && !agents.has(task.agent_id)) {
          agents.set(task.agent_id, {
            id: task.agent_id,
            name: task.agent_id.toUpperCase(),
            description: '',
            role: 'specialist',
            state: task.status === 'running' ? 'thinking' : task.status === 'completed' ? 'idle' : 'idle',
            currentTask: task.status === 'running' ? { id: task.id, title: task.title, startedAt: task.started_at ? new Date(task.started_at).getTime() : Date.now() } : null,
            completedTasks: task.status === 'completed' ? 1 : 0,
            failedTasks: task.status === 'failed' ? 1 : 0,
            lastActivityTs: null,
            stale: false,
            taskHistory: [],
          })
        }
      }
    }

    return {
      objective: {
        id: obj.id,
        title: obj.title,
        status: obj.status,
        taskCount: obj.task_count || 0,
        completedCount: obj.completed_count || obj.tasks_completed || 0,
        teamId,
      },
      orchestrator,
      orchestratorState: 'idle',
      agents: agents.size > 0 ? resolveNames(agents) : agents,
    }
  }, [])

  // Handle SSE event for a specific objective
  const handleEvent = useCallback((objectiveId, type, data) => {
    const agentIdForEvent = data.agent_id || data.agentId
    const TRACKED_EVENTS = ['task_started', 'task_completed', 'task_failed', 'task_skipped', 'decomposition_completed', 'objective_completed', 'objective_failed']
    if (TRACKED_EVENTS.includes(type)) {
      const agent = agentIdForEvent ? (() => {
        const g = groupsRef.current.find(g => g.objective.id === objectiveId)
        return g?.agents?.get(agentIdForEvent)
      })() : null
      const evt = {
        id: crypto.randomUUID(),
        type,
        agentId: agentIdForEvent,
        agentName: agent?.name || agentIdForEvent,
        title: data.title || data.task_title,
        ts: Date.now(),
        objectiveId,
      }
      eventsRef.current = [evt, ...eventsRef.current].slice(0, 50)
      setEvents([...eventsRef.current])
    }

    // Delegation detection: task_completed sets last agent, task_started checks for hand-off
    if (type === 'task_completed' && agentIdForEvent) {
      lastCompletedAgentRef.current[objectiveId] = { agentId: agentIdForEvent, ts: Date.now() }
    }
    if (type === 'task_started' && agentIdForEvent) {
      const last = lastCompletedAgentRef.current[objectiveId]
      if (last && last.agentId !== agentIdForEvent && (Date.now() - last.ts) < 5000) {
        setDelegations(prev => [...prev, {
          id: crypto.randomUUID(),
          from: last.agentId,
          to: agentIdForEvent,
          taskTitle: data.title || data.task_title,
          ts: Date.now(),
          objectiveId,
        }])
      }
    }

    setGroups(prev => prev.map(g => {
      if (g.objective.id !== objectiveId) return g

      const agentId = data.agent_id || data.agentId
      if (!agentId && type !== 'decomposition_completed' && type !== 'objective_completed' && type !== 'objective_failed') return g

      const nextAgents = new Map(g.agents)

      switch (type) {
        case 'task_started': {
          const existing = nextAgents.get(agentId) || {
            id: agentId, name: agentId.toUpperCase(), description: '', role: 'specialist',
            state: 'idle', currentTask: null, completedTasks: 0, failedTasks: 0,
            lastActivityTs: null, stale: false, taskHistory: [],
          }
          nextAgents.set(agentId, {
            ...existing,
            state: 'thinking',
            currentTask: {
              id: data.task_id || data.taskId,
              title: data.title || data.task_title || 'Working...',
              startedAt: Date.now(),
            },
            lastActivityTs: Date.now(),
            stale: false,
          })
          break
        }
        case 'task_heartbeat': {
          const a = nextAgents.get(agentId)
          if (a) nextAgents.set(agentId, { ...a, lastActivityTs: Date.now(), stale: false })
          break
        }
        case 'task_completed': {
          const a = nextAgents.get(agentId)
          if (a) {
            const hist = [...(a.taskHistory || []), { id: data.task_id || data.taskId, title: data.title || data.task_title, status: 'completed', ts: Date.now() }].slice(-20)
            nextAgents.set(agentId, {
              ...a, state: 'done', currentTask: null,
              completedTasks: a.completedTasks + 1,
              lastActivityTs: Date.now(), stale: false,
              taskHistory: hist,
            })
            // Reset to idle after 3s
            setTimeout(() => {
              setGroups(p => p.map(gg => {
                if (gg.objective.id !== objectiveId) return gg
                const na = new Map(gg.agents)
                const cur = na.get(agentId)
                if (cur?.state === 'done') na.set(agentId, { ...cur, state: 'idle' })
                return { ...gg, agents: na }
              }))
            }, 3000)
          }
          const statesC = [...nextAgents.values()].map(a => a.state)
          let orchStateC = 'idle'
          if (statesC.some(s => s === 'blocked')) orchStateC = 'blocked'
          else if (statesC.some(s => s === 'thinking' || s === 'executing')) orchStateC = 'thinking'
          else if (statesC.some(s => s === 'done')) orchStateC = 'done'
          return {
            ...g,
            agents: nextAgents,
            orchestratorState: orchStateC,
            objective: { ...g.objective, completedCount: (g.objective.completedCount || 0) + 1 },
          }
        }
        case 'task_failed': {
          const a = nextAgents.get(agentId)
          if (a) {
            const hist = [...(a.taskHistory || []), { id: data.task_id || data.taskId, title: data.title || data.task_title, status: 'failed', ts: Date.now() }].slice(-20)
            nextAgents.set(agentId, {
              ...a, state: 'blocked', currentTask: null,
              failedTasks: a.failedTasks + 1,
              lastActivityTs: Date.now(), stale: false,
              taskHistory: hist,
            })
          }
          break
        }
        case 'decomposition_completed':
          return {
            ...g,
            objective: { ...g.objective, taskCount: data.tasks?.length || data.task_count || g.objective.taskCount },
          }
        case 'objective_completed':
          // Reset all agents to idle
          for (const [id, a] of nextAgents) {
            nextAgents.set(id, { ...a, state: 'idle', currentTask: null })
          }
          return { ...g, agents: nextAgents, orchestratorState: 'idle', objective: { ...g.objective, status: 'completed' } }
        case 'objective_failed':
          return { ...g, objective: { ...g.objective, status: 'failed' } }
        default:
          return g
      }

      // Derive orchestrator state
      const states = [...nextAgents.values()].map(a => a.state)
      let orchState = 'idle'
      if (states.some(s => s === 'blocked')) orchState = 'blocked'
      else if (states.some(s => s === 'thinking' || s === 'executing')) orchState = 'thinking'
      else if (states.some(s => s === 'done')) orchState = 'done'

      return { ...g, agents: nextAgents, orchestratorState: orchState }
    }))
    setConnectionState('connected')
  }, [])

  // Load objectives and build groups
  useEffect(() => {
    if (!authFetch) return

    const load = () => {
      listObjectives(authFetch, { limit: 50 })
        .then(data => {
          const list = data.objectives || data || []
          setObjectives(list)

          // Show all objectives that are relevant — executing, planned, or recently finished
          // Re-show dismissed objectives if they become active again (e.g. rerun)
          const recentCutoff = new Date(Date.now() - 7200_000).toISOString() // 2 hours
          const active = list.filter(o => {
            // Currently executing — always show (un-dismiss if needed)
            if (o.status === 'running' || o.status === 'in_progress') {
              dismissedRef.current.delete(o.id)
              return true
            }
            // Dismissed by user — hide until status changes
            if (dismissedRef.current.has(o.id)) return false
            // Planned / awaiting action
            if (o.status === 'decomposing' || o.status === 'decomposed') return true
            // Pending with tasks (submitted but not started)
            if (o.status === 'pending' && o.task_count > 0) return true
            // Recently finished (within 24h)
            if ((o.status === 'completed' || o.status === 'completed_with_errors' || o.status === 'failed') && o.completed_at && o.completed_at > recentCutoff) return true
            return false
          })

          setGroups(prev => {
            // Preserve existing agent state for objectives we're already tracking
            const existingMap = new Map(prev.map(g => [g.objective.id, g]))
            return active.map(obj => {
              const existing = existingMap.get(obj.id)
              if (existing) {
                return { ...existing, objective: { ...existing.objective, status: obj.status, title: obj.title } }
              }
              return buildGroup(obj)
            })
          })

          // Hydrate new groups with current task state from API
          const existingIds = new Set(groups.map(g => g.objective.id))
          const newObjs = active.filter(o => !existingIds.has(o.id))
          if (newObjs.length > 0 || groups.length === 0) {
            // Hydrate all groups on first load, or just new ones
            const toHydrate = groups.length === 0 ? active : newObjs
            Promise.all(toHydrate.map(obj => hydrateGroup(buildGroup(obj)))).then(hydrated => {
              setGroups(prev => {
                const map = new Map(prev.map(g => [g.objective.id, g]))
                for (const h of hydrated) map.set(h.objective.id, h)
                return [...map.values()]
              })
            })
          }

          // Manage SSE streams — connect to active, disconnect stale
          const activeIds = new Set(active.map(o => o.id))
          // Close streams for objectives no longer active
          for (const [id, stream] of streamsRef.current) {
            if (!activeIds.has(id)) { stream.close(); streamsRef.current.delete(id) }
          }
          // Open streams for new objectives
          for (const obj of active) {
            if (!streamsRef.current.has(obj.id)) {
              const stream = new ObjectiveStream(obj.id, handleEvent, () => setConnectionState('error'))
              streamsRef.current.set(obj.id, stream)
              stream.connect()
            }
          }

          // Objectives loaded successfully — reflect a real state rather
          // than leaving a stale 'connecting'/'error' dot from a previous
          // failed poll or dropped SSE connection.
          setConnectionState(active.length > 0 ? 'connecting' : 'disconnected')
        })
        .catch((err) => {
          // Objectives service unreachable — surface this as a visible
          // error state instead of leaving the connection dot stuck on
          // whatever it last happened to show.
          console.warn('[OpsDeck] Failed to load objectives:', err?.message || err)
          setConnectionState('error')
        })
    }

    load()
    const id = setInterval(load, POLL_INTERVAL)
    return () => {
      clearInterval(id)
      for (const stream of streamsRef.current.values()) stream.close()
      streamsRef.current.clear()
    }
  }, [authFetch, buildGroup, handleEvent])

  // Stale detection
  useEffect(() => {
    const id = setInterval(() => {
      setGroups(prev => {
        const now = Date.now()
        let changed = false
        const next = prev.map(g => {
          const nextAgents = new Map(g.agents)
          for (const [aid, agent] of nextAgents) {
            if (agent.state !== 'idle' && agent.lastActivityTs &&
                (now - agent.lastActivityTs > STALE_THRESHOLD_MS) && !agent.stale) {
              nextAgents.set(aid, { ...agent, stale: true })
              changed = true
            }
          }
          return changed ? { ...g, agents: nextAgents } : g
        })
        return changed ? next : prev
      })
    }, 10_000)
    return () => clearInterval(id)
  }, [])

  // Auto-expire delegations older than 30s
  useEffect(() => {
    const id = setInterval(() => {
      setDelegations(prev => {
        const now = Date.now()
        const next = prev.filter(d => now - d.ts < 30000)
        return next.length === prev.length ? prev : next
      })
    }, 5000)
    return () => clearInterval(id)
  }, [])

  // Keep groupsRef in sync
  useEffect(() => { groupsRef.current = groups }, [groups])

  // Derive system state
  useEffect(() => {
    const allAgents = groups.flatMap(g => [...g.agents.values()])
    const states = allAgents.map(a => a.state)
    if (states.some(s => s === 'blocked')) setSystemState('error')
    else if (states.some(s => s === 'thinking' || s === 'executing' || s === 'done')) setSystemState('active')
    else setSystemState('idle')
  }, [groups])

  // Compute totals for the pulse bar
  const totalAgents = groups.reduce((n, g) => n + g.agents.size, 0)
  const activeAgents = groups.reduce((n, g) => {
    return n + [...g.agents.values()].filter(a => a.state !== 'idle').length
  }, 0)

  // Clear completed/failed/cancelled objectives from the live view
  const clearCompleted = useCallback(() => {
    // Clear everything that's not actively running
    const keepStatuses = new Set(['running', 'in_progress', 'decomposing'])
    // Add to dismissed set so the poll filter skips them
    for (const g of groups) {
      if (!keepStatuses.has(g.objective.status)) {
        dismissedRef.current.add(g.objective.id)
      }
    }
    // Persist to localStorage
    try {
      localStorage.setItem('opsdeck_dismissed', JSON.stringify([...dismissedRef.current]))
    } catch { /* storage full — non-fatal */ }
    setGroups(prev => prev.filter(g => keepStatuses.has(g.objective.status)))
    // Close SSE streams for cleared objectives
    for (const [id, stream] of streamsRef.current) {
      if (dismissedRef.current.has(id)) {
        stream.close()
        streamsRef.current.delete(id)
      }
    }
  }, [groups])

  return {
    groups,
    objectives,
    connectionState,
    systemState,
    totalAgents,
    activeAgents,
    events,
    delegations,
    clearCompleted,
  }
}
