/**
 * useWorkflowBuilder — Central state management for the workflow builder.
 *
 * Manages nodes, edges, metadata, validation, undo/redo, and draft persistence.
 * Both WireMap and the AI chat read/write through this hook.
 */

import { useState, useCallback, useRef, useMemo } from 'react'

const MAX_UNDO = 40

// QuoxFlow node archetype metadata — includes defaultConfig for property panel
export const NODE_ARCHETYPES = {
  'trigger:webhook':  { label: 'Webhook',    category: 'trigger',   icon: '\u{1F310}', color: '#10b981', defaultConfig: { method: 'POST', path: '/webhook', authentication: 'none' } },
  'trigger:schedule': { label: 'Schedule',   category: 'trigger',   icon: '\u23F0',    color: '#10b981', defaultConfig: { cron: '0 * * * *', timezone: 'UTC', enabled: true } },
  'trigger:event':    { label: 'Event',      category: 'trigger',   icon: '\u26A1',    color: '#10b981', defaultConfig: { event: '', source: '', filter: '' } },
  'flow:condition':   { label: 'Condition',  category: 'logic',     icon: '\u{1F500}', color: '#f59e0b', defaultConfig: { expression: '', trueLabel: 'Yes', falseLabel: 'No' } },
  'flow:switch':      { label: 'Switch',     category: 'logic',     icon: '\u{1F500}', color: '#f59e0b', defaultConfig: { field: '', cases: '' } },
  'flow:loop':        { label: 'Loop',       category: 'logic',     icon: '\u{1F504}', color: '#f59e0b', defaultConfig: { collection: '', maxIterations: 100 } },
  'flow:parallel':    { label: 'Parallel',   category: 'logic',     icon: '\u{1F501}', color: '#f59e0b', defaultConfig: { maxConcurrency: 3 } },
  'flow:merge':       { label: 'Merge',      category: 'logic',     icon: '\u{1F500}', color: '#f59e0b', defaultConfig: { strategy: 'wait_all' } },
  'call':             { label: 'HTTP Call',   category: 'action',    icon: '\u{1F4E1}', color: '#6366f1', defaultConfig: { url: '', method: 'GET', timeout: 30000 } },
  'data:transform':   { label: 'Transform',  category: 'data',      icon: '\u2699\uFE0F',  color: '#06b6d4', defaultConfig: { expression: '', outputField: 'result' } },
  'data:set':         { label: 'Set Data',   category: 'data',      icon: '\u{1F4DD}', color: '#06b6d4', defaultConfig: { field: '', value: '' } },
  'data:aggregate':   { label: 'Aggregate',  category: 'data',      icon: '\u{1F4CA}', color: '#06b6d4', defaultConfig: { operation: 'collect', field: '' } },
  'error:try':        { label: 'Try',        category: 'error',     icon: '\u{1F6E1}\uFE0F', color: '#ef4444', defaultConfig: { retries: 0, retryDelay: 1000 } },
  'error:catch':      { label: 'Catch',      category: 'error',     icon: '\u{1F6E1}\uFE0F', color: '#ef4444', defaultConfig: { errorTypes: '' } },
  'error:throw':      { label: 'Throw',      category: 'error',     icon: '\u26A0\uFE0F',   color: '#ef4444', defaultConfig: { message: '', code: '' } },
  'util:wait':        { label: 'Wait',       category: 'utility',   icon: '\u23F3',    color: '#8b5cf6', defaultConfig: { duration: 1000 } },
  'util:log':         { label: 'Log',        category: 'utility',   icon: '\u{1F4CB}', color: '#8b5cf6', defaultConfig: { message: '', level: 'info' } },
  'util:subworkflow': { label: 'Subworkflow',category: 'utility',   icon: '\u{1F4E6}', color: '#8b5cf6', defaultConfig: { workflowId: '', passData: true } },
  'agent:agentic':    { label: 'AI Model',    category: 'action',  icon: '\u{1F9E0}', color: '#a78bfa', defaultConfig: { goal: '', maxIterations: 10, tools: [] } },
  'human:task':       { label: 'Human Task',  category: 'human',   icon: '\u{1F464}', color: '#f472b6', defaultConfig: { title: '', message: 'A workflow step needs human input.', assignTo: ['*'], priority: 'normal' } },
}

export const NODE_CATEGORIES = [
  { id: 'trigger', label: 'Triggers', types: ['trigger:webhook', 'trigger:schedule', 'trigger:event'] },
  { id: 'logic',   label: 'Logic',    types: ['flow:condition', 'flow:switch', 'flow:loop', 'flow:parallel', 'flow:merge'] },
  { id: 'action',  label: 'Actions',  types: ['call'] },
  { id: 'data',    label: 'Data',     types: ['data:transform', 'data:set', 'data:aggregate'] },
  { id: 'error',   label: 'Errors',   types: ['error:try', 'error:catch', 'error:throw'] },
  { id: 'utility', label: 'Utility',  types: ['util:wait', 'util:log', 'util:subworkflow'] },
  { id: 'human',   label: 'Human',    types: ['human:task'] },
]

let _nodeCounter = 0
function generateNodeId(type) {
  _nodeCounter++
  const short = type.replace(/[.:]/g, '-')
  return `${short}-${_nodeCounter}-${Date.now().toString(36).slice(-4)}`
}

function generateEdgeId(source, target) {
  return `e-${source}-${target}-${Date.now().toString(36).slice(-4)}`
}

export function useWorkflowBuilder() {
  const [nodes, setNodes] = useState([])
  const [edges, setEdges] = useState([])
  const [meta, setMeta] = useState({ name: '', description: '', tags: [] })
  const [selectedNodeId, setSelectedNodeId] = useState(null)

  // Undo/redo
  const undoStack = useRef([])
  const redoStack = useRef([])

  const pushUndo = useCallback(() => {
    undoStack.current.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) })
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift()
    redoStack.current = []
  }, [nodes, edges])

  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    redoStack.current.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) })
    setNodes(prev.nodes)
    setEdges(prev.edges)
  }, [nodes, edges])

  const redo = useCallback(() => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) })
    setNodes(next.nodes)
    setEdges(next.edges)
  }, [nodes, edges])

  // Node operations
  const addNode = useCallback((type, config = {}, position = null, explicitId = null) => {
    pushUndo()
    const archetype = NODE_ARCHETYPES[type]
    // Use the caller-supplied ID when provided, but fall back to generated ID
    // if there's a collision with an existing node (collision avoidance).
    const hasCollision = explicitId && nodes.some(n => n.id === explicitId)
    const id = (explicitId && !hasCollision) ? explicitId : generateNodeId(type)
    // Merge archetype defaults with any explicit config
    const mergedConfig = { ...(archetype?.defaultConfig || {}), ...config }
    const name = config.name || archetype?.label || type
    const newNode = {
      id,
      type,
      name,
      category: archetype?.category || 'other',
      config: mergedConfig,
      position: position || { x: 200 + Math.random() * 200, y: 100 + nodes.length * 100 },
    }
    setNodes(prev => [...prev, newNode])
    return newNode
  }, [pushUndo, nodes.length])

  const removeNode = useCallback((id) => {
    pushUndo()
    setNodes(prev => prev.filter(n => n.id !== id))
    setEdges(prev => prev.filter(e => e.source !== id && e.target !== id))
    if (selectedNodeId === id) setSelectedNodeId(null)
  }, [pushUndo, selectedNodeId])

  const updateNode = useCallback((id, changes) => {
    pushUndo()
    setNodes(prev => prev.map(n => n.id === id ? { ...n, ...changes } : n))
  }, [pushUndo])

  // Edge operations
  const connectNodes = useCallback((sourceId, targetId, sourceHandle, targetHandle) => {
    // Prevent duplicates
    const exists = edges.some(e => e.source === sourceId && e.target === targetId)
    if (exists || sourceId === targetId) return null
    pushUndo()
    const edge = {
      id: generateEdgeId(sourceId, targetId),
      source: sourceId,
      target: targetId,
      sourceHandle: sourceHandle || undefined,
      targetHandle: targetHandle || undefined,
    }
    setEdges(prev => [...prev, edge])
    return edge
  }, [edges, pushUndo])

  const disconnectEdge = useCallback((edgeId) => {
    pushUndo()
    setEdges(prev => prev.filter(e => e.id !== edgeId))
  }, [pushUndo])

  // Bulk operations
  const loadFromTemplate = useCallback((templateJson) => {
    pushUndo()
    setNodes(templateJson.nodes || [])
    setEdges(templateJson.edges || [])
    setMeta({
      name: templateJson.name || '',
      description: templateJson.description || '',
      tags: templateJson.tags || templateJson.metadata?.tags || [],
    })
    setSelectedNodeId(null)
  }, [pushUndo])

  const clear = useCallback(() => {
    pushUndo()
    setNodes([])
    setEdges([])
    setMeta({ name: '', description: '', tags: [] })
    setSelectedNodeId(null)
  }, [pushUndo])

  const updateMeta = useCallback((changes) => {
    setMeta(prev => ({ ...prev, ...changes }))
  }, [])

  // Apply many actions as a single state transition. Avoids the N-render flicker
  // that happens when WEAVER emits a multi-action canvas mutation and each action
  // hits its own setNodes/setEdges/pushUndo. One snapshot, one commit.
  const bulkApply = useCallback((actions) => {
    if (!Array.isArray(actions) || actions.length === 0) {
      return { applied: 0, errors: [] }
    }

    pushUndo()

    let nextNodes = nodes
    let nextEdges = edges
    let nextMeta = meta
    let metaChanged = false
    let clearSelected = false
    const errors = []
    let applied = 0

    for (const action of actions) {
      try {
        switch (action.type) {
          case 'add_node': {
            const archetype = NODE_ARCHETYPES[action.nodeType]
            const explicitId = action.id
            const hasCollision = explicitId && nextNodes.some(n => n.id === explicitId)
            const id = (explicitId && !hasCollision) ? explicitId : generateNodeId(action.nodeType)
            const config = action.config || {}
            const mergedConfig = { ...(archetype?.defaultConfig || {}), ...config }
            const name = config.name || archetype?.label || action.nodeType
            nextNodes = [...nextNodes, {
              id,
              type: action.nodeType,
              name,
              category: archetype?.category || 'other',
              config: mergedConfig,
              position: action.position || { x: 200 + Math.random() * 200, y: 100 + nextNodes.length * 100 },
            }]
            applied++
            break
          }
          case 'remove_node': {
            nextNodes = nextNodes.filter(n => n.id !== action.nodeId)
            nextEdges = nextEdges.filter(e => e.source !== action.nodeId && e.target !== action.nodeId)
            if (selectedNodeId === action.nodeId) clearSelected = true
            applied++
            break
          }
          case 'update_node': {
            nextNodes = nextNodes.map(n => n.id === action.nodeId ? { ...n, ...(action.changes || {}) } : n)
            applied++
            break
          }
          case 'connect': {
            const exists = nextEdges.some(e => e.source === action.source && e.target === action.target)
            if (exists || action.source === action.target) break
            nextEdges = [...nextEdges, {
              id: generateEdgeId(action.source, action.target),
              source: action.source,
              target: action.target,
              sourceHandle: action.sourceHandle || undefined,
              targetHandle: action.targetHandle || undefined,
            }]
            applied++
            break
          }
          case 'disconnect': {
            nextEdges = nextEdges.filter(e => e.id !== action.edgeId)
            applied++
            break
          }
          case 'set_meta': {
            nextMeta = { ...nextMeta, ...(action.meta || {}) }
            metaChanged = true
            applied++
            break
          }
          case 'load_template': {
            if (action.workflow) {
              nextNodes = action.workflow.nodes || []
              nextEdges = action.workflow.edges || []
              nextMeta = {
                name: action.workflow.name || '',
                description: action.workflow.description || '',
                tags: action.workflow.tags || action.workflow.metadata?.tags || [],
              }
              metaChanged = true
              clearSelected = true
              applied++
            }
            break
          }
          case 'clear': {
            nextNodes = []
            nextEdges = []
            nextMeta = { name: '', description: '', tags: [] }
            metaChanged = true
            clearSelected = true
            applied++
            break
          }
          default:
            // explain / validate / deploy / suggest are informational — no mutation
            break
        }
      } catch (e) {
        errors.push(`${action.type}: ${e.message}`)
      }
    }

    if (nextNodes !== nodes) setNodes(nextNodes)
    if (nextEdges !== edges) setEdges(nextEdges)
    if (metaChanged) setMeta(nextMeta)
    if (clearSelected) setSelectedNodeId(null)

    return { applied, errors }
  }, [nodes, edges, meta, selectedNodeId, pushUndo])

  // Export
  const exportToQuoxFlow = useCallback(() => {
    return {
      id: meta.name ? meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50) : `workflow-${Date.now()}`,
      name: meta.name || 'Untitled Workflow',
      description: meta.description,
      nodes,
      edges,
      metadata: {
        tags: meta.tags,
        createdAt: new Date().toISOString(),
      },
    }
  }, [nodes, edges, meta])

  // Validation
  const validation = useMemo(() => {
    const errors = []
    const warnings = []

    if (nodes.length === 0) {
      warnings.push({ message: 'Workflow is empty', nodeId: null })
      return { valid: true, errors, warnings }
    }

    // Check for trigger
    const triggers = nodes.filter(n => n.type?.startsWith('trigger:'))
    if (triggers.length === 0) {
      errors.push({ message: 'Workflow needs at least one trigger node', nodeId: null })
    }

    // Check for orphan nodes (not connected to anything)
    const connectedIds = new Set()
    edges.forEach(e => { connectedIds.add(e.source); connectedIds.add(e.target) })
    nodes.forEach(n => {
      if (!connectedIds.has(n.id) && nodes.length > 1) {
        warnings.push({ message: `"${n.name}" is not connected`, nodeId: n.id })
      }
    })

    return { valid: errors.length === 0, errors, warnings }
  }, [nodes, edges])

  // Serialise for draft saving
  const serialise = useCallback(() => ({
    nodes, edges, meta,
  }), [nodes, edges, meta])

  const deserialise = useCallback((state) => {
    if (state.nodes) setNodes(state.nodes)
    if (state.edges) setEdges(state.edges)
    if (state.meta) setMeta(state.meta)
  }, [])

  return {
    // State
    nodes, edges, meta, selectedNodeId, validation,
    // Node ops
    addNode, removeNode, updateNode, setSelectedNodeId,
    // Edge ops
    connectNodes, disconnectEdge,
    // Bulk ops
    loadFromTemplate, clear, updateMeta, bulkApply,
    // Export
    exportToQuoxFlow,
    // Undo
    undo, redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    // Serialise
    serialise, deserialise,
    // Direct setters for React Flow integration
    setNodes, setEdges,
  }
}

export default useWorkflowBuilder
