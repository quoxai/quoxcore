/**
 * OpsDeckCanvas V2.1 — Zoomable React Flow node graph
 *
 * Shows ALL active objectives as clusters on one zoomable canvas.
 * Each cluster: orchestrator node at center, agent nodes radially around it.
 * Click a node to focus its cluster; click background to unfocus.
 * Mini-map for overview. Click node for detail panel.
 */

import { useMemo, useCallback, useState, useEffect, useRef } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import OpsDeckNode from './OpsDeckNode'
import OpsDeckDetailPanel from './OpsDeckDetailPanel'
import EventTimeline from './EventTimeline'
import ParticleField from './ParticleField'

const CLUSTER_COLORS = [
  '#6366f1', '#22c55e', '#f59e0b', '#ec4899',
  '#06b6d4', '#8b5cf6', '#ef4444', '#10b981',
]

const NODE_TYPES = { opsdeck: OpsDeckNode }

/** Format agent name: "cfo" -> "CFO", "cpo-people" -> "CPO People" */
function formatAgentName(name) {
  if (!name) return '?'
  if (name !== name.toLowerCase() && name !== name.toUpperCase()) return name
  return name.split('-').map(part => {
    if (part.length <= 4) return part.toUpperCase()
    return part.charAt(0).toUpperCase() + part.slice(1)
  }).join(' ')
}

/**
 * Build React Flow nodes + edges from objective groups.
 * Includes a hidden "cluster label" node above each orchestrator.
 */
function buildGraph(groups, zoom, focusedCluster, onNodeClick, onDetailOpen, delegations = []) {
  const nodes = []
  const edges = []

  // Minimum arc spacing between nodes (px) to prevent overlap
  const MIN_ARC_GAP = 70

  /**
   * Split agents into concentric rings so nodes never overlap.
   * Each ring holds at most floor(2*PI*radius / MIN_ARC_GAP) agents.
   * Returns [{agents, radius}, ...]
   */
  function computeRings(agentList) {
    const rings = []
    let remaining = [...agentList]
    let radius = 140

    while (remaining.length > 0) {
      const capacity = Math.max(4, Math.floor((2 * Math.PI * radius) / MIN_ARC_GAP))
      const batch = remaining.slice(0, capacity)
      remaining = remaining.slice(capacity)
      rings.push({ agents: batch, radius })
      radius += 100 // next ring 100px further out
    }
    return rings
  }

  // Cluster spacing scales with largest team
  const maxRings = Math.max(1, ...groups.map(g => {
    const count = g.agents?.size || 0
    if (count <= 8) return 1
    if (count <= 20) return 2
    return 3
  }))
  const CLUSTER_SPACING = 300 + maxRings * 150
  const startX = groups.length > 1 ? -(groups.length - 1) * CLUSTER_SPACING / 2 : 0

  groups.forEach((group, gi) => {
    const clusterX = startX + gi * CLUSTER_SPACING
    const clusterY = 0
    const color = CLUSTER_COLORS[gi % CLUSTER_COLORS.length]
    const orchId = `orch-${group.objective.id}`
    const clusterId = group.objective.id
    const isCompleted = group.objective.status === 'completed' || group.objective.status === 'failed'
    const isDimmed = isCompleted || (focusedCluster && focusedCluster !== clusterId)
    const isHighlighted = focusedCluster === clusterId

    // Task progress for orchestrator ring
    const taskCount = group.objective.taskCount || 0
    const completedCount = group.objective.completedCount || 0
    const progress = taskCount > 0 ? completedCount / taskCount : 0

    // Orchestrator
    nodes.push({
      id: orchId,
      type: 'opsdeck',
      position: { x: clusterX, y: clusterY },
      data: {
        label: formatAgentName(group.orchestrator?.name || 'Orchestrator'),
        state: group.orchestratorState || 'idle',
        isOrchestrator: true,
        objectiveId: group.objective.id,
        objectiveTitle: group.objective.title,
        objectiveStatus: group.objective.status,
        accentColor: color,
        zoom,
        dimmed: isDimmed,
        highlighted: isHighlighted,
        onNodeClick,
        onDetailOpen,
        clusterId,
        progress,
        taskCount,
        completedCount,
      },
      draggable: true,
    })

    // Agent nodes — distributed across concentric rings
    const agentList = [...(group.agents?.values?.() || [])]
    const rings = computeRings(agentList)

    rings.forEach((ring, ri) => {
      const offsetAngle = ri % 2 === 0 ? 0 : Math.PI / ring.agents.length // stagger alternate rings
      ring.agents.forEach((agent, ai) => {
        const angle = (ai / ring.agents.length) * 2 * Math.PI - Math.PI / 2 + offsetAngle
        const x = clusterX + ring.radius * Math.cos(angle)
        const y = clusterY + ring.radius * Math.sin(angle)
        const agentNodeId = `agent-${group.objective.id}-${agent.id}`

        nodes.push({
          id: agentNodeId,
          type: 'opsdeck',
          position: { x, y },
          data: {
            label: formatAgentName(agent.name),
            state: agent.state,
            isOrchestrator: false,
            currentTask: agent.currentTask,
            completedTasks: agent.completedTasks,
            failedTasks: agent.failedTasks,
            stale: agent.stale,
            accentColor: color,
            zoom,
            dimmed: isDimmed,
            highlighted: isHighlighted,
            onNodeClick,
            onDetailOpen,
            clusterId,
            agentId: agent.id,
            role: agent.role,
            description: agent.description,
            taskHistory: agent.taskHistory || [],
          },
          draggable: true,
        })

        edges.push({
          id: `e-${orchId}-${agentNodeId}`,
          source: orchId,
          target: agentNodeId,
          type: 'smoothstep',
          style: {
            stroke: isDimmed
              ? 'rgba(255,255,255,0.03)'
              : agent.state === 'idle'
                ? 'rgba(255,255,255,0.06)'
                : color,
            strokeWidth: agent.state === 'idle' || isDimmed ? 1 : 1.5,
            opacity: isDimmed ? 0.3 : agent.state === 'idle' ? 0.5 : 0.8,
          },
          animated: !isDimmed && (agent.state === 'thinking' || agent.state === 'executing'),
        })
      })
    })
  })

  // Delegation flow lines
  for (const deleg of delegations) {
    const sourceId = `agent-${deleg.objectiveId}-${deleg.from}`
    const targetId = `agent-${deleg.objectiveId}-${deleg.to}`
    const sourceExists = nodes.some(n => n.id === sourceId)
    const targetExists = nodes.some(n => n.id === targetId)
    if (sourceExists && targetExists) {
      const gi = groups.findIndex(g => g.objective.id === deleg.objectiveId)
      const color = gi >= 0 ? CLUSTER_COLORS[gi % CLUSTER_COLORS.length] : '#6366f1'
      edges.push({
        id: `deleg-${deleg.id}`,
        source: sourceId,
        target: targetId,
        type: 'default',
        animated: true,
        style: { stroke: color, strokeWidth: 2, opacity: 0.9 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color },
        className: 'opsdeck-delegation-edge',
      })
    }
  }

  return { nodes, edges }
}

/** MiniMap node color based on state */
function miniMapNodeColor(node) {
  const state = node.data?.state
  if (state === 'thinking') return '#6366f1'
  if (state === 'executing') return '#22c55e'
  if (state === 'blocked') return '#ef4444'
  if (state === 'done') return '#10b981'
  if (node.data?.isOrchestrator) return 'rgba(255,255,255,0.3)'
  return 'rgba(255,255,255,0.12)'
}

function OpsDeckFlowInner({ groups, systemState, initialFocusId, events = [], delegations = [], onToggleWallboard }) {
  const [zoom, setZoom] = useState(1)
  const [focusedCluster, setFocusedCluster] = useState(initialFocusId || null)
  const [selectedNode, setSelectedNode] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [teamFilter, setTeamFilter] = useState('all')
  const [showGrid, setShowGrid] = useState(true)
  const { fitView, setCenter, getNodes } = useReactFlow()
  const canvasRef = useRef(null)

  const onNodeClick = useCallback((clusterId) => {
    setFocusedCluster(prev => prev === clusterId ? null : clusterId)
  }, [])

  const onDetailOpen = useCallback((nodeData) => {
    setSelectedNode(prev => prev?.label === nodeData.label ? null : nodeData)
  }, [])

  const onPaneClick = useCallback(() => {
    setFocusedCluster(null)
    setSelectedNode(null)
  }, [])

  const handleHighlight = useCallback((agentId) => {
    // Find the node element and flash it
    const nodeEl = document.querySelector(`[data-id*="-${agentId}"].react-flow__node`)
    if (nodeEl) {
      const inner = nodeEl.querySelector('.opsdeck-node')
      if (inner) {
        inner.classList.add('opsdeck-node--flash')
        setTimeout(() => inner.classList.remove('opsdeck-node--flash'), 1500)
      }
    }
  }, [])

  // Filter groups by status and team
  const filteredGroups = useMemo(() => {
    let result = groups
    if (statusFilter !== 'all') {
      result = result.filter(g => g.objective.status === statusFilter)
    }
    if (teamFilter !== 'all') {
      result = result.filter(g => g.objective.teamId === teamFilter)
    }
    return result
  }, [groups, statusFilter, teamFilter])

  // Unique teams for filter dropdown
  const teamOptions = useMemo(() => {
    const teams = new Set(groups.map(g => g.objective.teamId).filter(Boolean))
    return [...teams]
  }, [groups])

  // Keyboard shortcuts — only fire when canvas has focus (not inside inputs)
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const handleKeyDown = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return

      // F — fit view
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        fitView({ padding: 0.4, duration: 400 })
        return
      }

      // 1-9 — focus cluster N
      if (e.key >= '1' && e.key <= '9' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const idx = parseInt(e.key, 10) - 1
        if (idx < filteredGroups.length) {
          e.preventDefault()
          const clusterId = filteredGroups[idx].objective.id
          setFocusedCluster(prev => prev === clusterId ? null : clusterId)
          // Zoom to cluster center
          const allNodes = getNodes()
          const orchNode = allNodes.find(n => n.id === `orch-${clusterId}`)
          if (orchNode) {
            setCenter(orchNode.position.x, orchNode.position.y, { zoom: 1.2, duration: 400 })
          }
        }
        return
      }

      // Escape — unfocus
      if (e.key === 'Escape') {
        if (selectedNode) {
          setSelectedNode(null)
        } else if (focusedCluster) {
          setFocusedCluster(null)
          fitView({ padding: 0.4, duration: 400 })
        }
        return
      }

      // G — toggle grid
      if ((e.key === 'g' || e.key === 'G') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        setShowGrid(prev => !prev)
        return
      }

      // W — toggle wallboard
      if ((e.key === 'w' || e.key === 'W') && !e.metaKey && !e.ctrlKey && onToggleWallboard) {
        e.preventDefault()
        onToggleWallboard()
        return
      }
    }
    el.addEventListener('keydown', handleKeyDown)
    return () => el.removeEventListener('keydown', handleKeyDown)
  }, [fitView, setCenter, getNodes, filteredGroups, focusedCluster, selectedNode, onToggleWallboard])

  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => buildGraph(filteredGroups, zoom, focusedCluster, onNodeClick, onDetailOpen, delegations),
    [filteredGroups, zoom, focusedCluster, onNodeClick, onDetailOpen, delegations]
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // Sync when groups or focus change
  useMemo(() => {
    const { nodes: next, edges: nextEdges } = buildGraph(filteredGroups, zoom, focusedCluster, onNodeClick, onDetailOpen, delegations)
    setNodes(prev => {
      const posMap = new Map(prev.map(n => [n.id, n.position]))
      return next.map(n => {
        const existing = posMap.get(n.id)
        return existing ? { ...n, position: existing } : n
      })
    })
    setEdges(nextEdges)
  }, [filteredGroups, focusedCluster]) // eslint-disable-line react-hooks/exhaustive-deps

  useMemo(() => {
    setNodes(prev => prev.map(n => ({
      ...n,
      data: { ...n.data, zoom },
    })))
  }, [zoom]) // eslint-disable-line react-hooks/exhaustive-deps

  const onMoveEnd = useCallback((_, viewport) => {
    setZoom(viewport.zoom)
  }, [])

  useMemo(() => {
    if (filteredGroups.length > 0) {
      setTimeout(() => fitView({ padding: 0.4, duration: 400 }), 100)
    }
  }, [filteredGroups.length]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="opsdeck-canvas" data-system-state={systemState} ref={canvasRef} tabIndex={-1}>
      <ParticleField />
      {/* Filter pills */}
      {groups.length > 1 && (
        <div className="opsdeck-filter-bar">
          {['all', 'running', 'completed', 'failed'].map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`opsdeck-filter-pill ${statusFilter === s ? 'opsdeck-filter-active' : ''}`}>
              {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
          {teamOptions.length > 1 && (
            <select value={teamFilter} onChange={e => setTeamFilter(e.target.value)}
              className="opsdeck-team-filter">
              <option value="all">All Teams</option>
              {teamOptions.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onMoveEnd={onMoveEnd}
        onPaneClick={onPaneClick}
        nodeTypes={NODE_TYPES}
        minZoom={0.2}
        maxZoom={2.5}
        fitView
        fitViewOptions={{ padding: 0.4 }}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          type: 'default',
          style: { stroke: 'rgba(255,255,255,0.06)', strokeWidth: 1 },
        }}
      >
        {showGrid && <Background color="rgba(255,255,255,0.015)" gap={40} size={1} />}
        <Controls showInteractive={false} className="opsdeck-controls" />
        <button
          onClick={() => fitView({ padding: 0.4, duration: 400 })}
          className="opsdeck-fit-all-btn"
          title="Fit all clusters"
        >
          ⊞
        </button>
        <MiniMap
          className="opsdeck-minimap"
          nodeColor={miniMapNodeColor}
          maskColor="rgba(5, 5, 16, 0.85)"
          pannable
          zoomable
        />
      </ReactFlow>

      <EventTimeline events={events} onHighlightAgent={handleHighlight} />

      {selectedNode && (
        <OpsDeckDetailPanel
          node={selectedNode}
          events={events}
          objectiveId={selectedNode.objectiveId || focusedCluster}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  )
}

export default function OpsDeckCanvas({ onToggleWallboard, ...props }) {
  return (
    <ReactFlowProvider>
      <OpsDeckFlowInner {...props} onToggleWallboard={onToggleWallboard} />
    </ReactFlowProvider>
  )
}
