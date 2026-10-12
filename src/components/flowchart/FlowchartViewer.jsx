/**
 * FlowchartViewer - A reusable React Flow-based flowchart component
 *
 * This component renders flowcharts from JSON schema, using QuoxCORE's
 * design system and supporting multiple node types.
 *
 * @module components/flowchart/FlowchartViewer
 */

import { useCallback, useMemo, useEffect, useState } from 'react'
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  MarkerType,
  Handle,
  Position,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './flowchart.css'

// ============================================
// CONSTANTS & DEFAULTS
// ============================================

const NODE_DEFAULTS = {
  width: 180,
  height: 50,
  verticalGap: 100,
  horizontalGap: 200,
}

const EDGE_DEFAULTS = {
  type: 'smoothstep',
  animated: false,
  style: {
    stroke: 'rgba(255, 255, 255, 0.25)',
    strokeWidth: 2,
  },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    color: 'rgba(255, 255, 255, 0.4)',
    width: 20,
    height: 20,
  },
}

// ============================================
// CUSTOM NODE COMPONENTS
// ============================================

/**
 * Default node - standard process step
 */
const DefaultNode = ({ data }) => (
  <div className="flowchart-node flowchart-node--default">
    <Handle type="target" position={Position.Top} />
    <div className="flowchart-node__content">
      <span className="flowchart-node__label">{data.label}</span>
      {data.description && (
        <span className="flowchart-node__description">{data.description}</span>
      )}
    </div>
    <Handle type="source" position={Position.Bottom} />
  </div>
)

/**
 * Input node - starting point
 */
const InputNode = ({ data }) => (
  <div className="flowchart-node flowchart-node--input">
    <div className="flowchart-node__content">
      <span className="flowchart-node__icon">&#9654;</span>
      <span className="flowchart-node__label">{data.label}</span>
      {data.description && (
        <span className="flowchart-node__description">{data.description}</span>
      )}
    </div>
    <Handle type="source" position={Position.Bottom} />
  </div>
)

/**
 * Output node - ending point
 */
const OutputNode = ({ data }) => (
  <div className="flowchart-node flowchart-node--output">
    <Handle type="target" position={Position.Top} />
    <div className="flowchart-node__content">
      <span className="flowchart-node__icon">&#9632;</span>
      <span className="flowchart-node__label">{data.label}</span>
      {data.description && (
        <span className="flowchart-node__description">{data.description}</span>
      )}
    </div>
  </div>
)

/**
 * Decision node - diamond shape for conditional logic
 */
const DecisionNode = ({ data }) => (
  <div className="flowchart-node flowchart-node--decision">
    <Handle type="target" position={Position.Top} />
    <div className="flowchart-node__diamond">
      <div className="flowchart-node__content">
        <span className="flowchart-node__label">{data.label}</span>
      </div>
    </div>
    <Handle type="source" position={Position.Bottom} id="bottom" />
    <Handle type="source" position={Position.Right} id="right" />
    <Handle type="source" position={Position.Left} id="left" />
  </div>
)

/**
 * Action node - highlighted action step
 */
const ActionNode = ({ data }) => (
  <div className="flowchart-node flowchart-node--action">
    <Handle type="target" position={Position.Top} />
    <div className="flowchart-node__content">
      <span className="flowchart-node__label">{data.label}</span>
      {data.description && (
        <span className="flowchart-node__description">{data.description}</span>
      )}
    </div>
    <Handle type="source" position={Position.Bottom} />
  </div>
)

// Node type mapping
const nodeTypes = {
  default: DefaultNode,
  input: InputNode,
  output: OutputNode,
  decision: DecisionNode,
  action: ActionNode,
}

// ============================================
// AUTO-LAYOUT ALGORITHM
// ============================================

/**
 * Simple auto-layout algorithm for nodes without positions
 * Uses a basic top-down layout approach
 *
 * @param {Array} nodes - Array of node objects
 * @param {Array} edges - Array of edge objects
 * @returns {Array} Nodes with computed positions
 */
function autoLayoutNodes(nodes, edges) {
  if (!nodes || nodes.length === 0) return []

  // Check if positions are already provided
  const hasPositions = nodes.every(node =>
    node.position && typeof node.position.x === 'number' && typeof node.position.y === 'number'
  )

  if (hasPositions) return nodes

  // Build adjacency list
  const adjacency = new Map()
  const inDegree = new Map()

  nodes.forEach(node => {
    adjacency.set(node.id, [])
    inDegree.set(node.id, 0)
  })

  edges.forEach(edge => {
    const sourceList = adjacency.get(edge.source) || []
    sourceList.push(edge.target)
    adjacency.set(edge.source, sourceList)
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1)
  })

  // Find root nodes (no incoming edges)
  const roots = nodes.filter(node => (inDegree.get(node.id) || 0) === 0)

  // If no roots found, use first node
  if (roots.length === 0 && nodes.length > 0) {
    roots.push(nodes[0])
  }

  // BFS to assign levels
  const levels = new Map()
  const queue = roots.map(node => ({ id: node.id, level: 0 }))

  while (queue.length > 0) {
    const { id, level } = queue.shift()

    if (levels.has(id)) continue
    levels.set(id, level)

    const children = adjacency.get(id) || []
    children.forEach(childId => {
      if (!levels.has(childId)) {
        queue.push({ id: childId, level: level + 1 })
      }
    })
  }

  // Handle disconnected nodes
  nodes.forEach(node => {
    if (!levels.has(node.id)) {
      levels.set(node.id, 0)
    }
  })

  // Group nodes by level
  const levelGroups = new Map()
  nodes.forEach(node => {
    const level = levels.get(node.id) || 0
    const group = levelGroups.get(level) || []
    group.push(node)
    levelGroups.set(level, group)
  })

  // Assign positions
  const positionedNodes = nodes.map(node => {
    const level = levels.get(node.id) || 0
    const group = levelGroups.get(level) || [node]
    const indexInGroup = group.indexOf(node)
    const groupWidth = group.length * NODE_DEFAULTS.horizontalGap
    const startX = -groupWidth / 2 + NODE_DEFAULTS.horizontalGap / 2

    return {
      ...node,
      position: node.position || {
        x: startX + indexInGroup * NODE_DEFAULTS.horizontalGap,
        y: level * NODE_DEFAULTS.verticalGap,
      },
    }
  })

  return positionedNodes
}

// ============================================
// MAIN COMPONENT
// ============================================

/**
 * FlowchartViewer Component
 *
 * Renders an interactive flowchart from JSON data.
 *
 * @param {Object} props
 * @param {Object} props.data - Flowchart data with nodes and edges arrays
 * @param {string} [props.title] - Optional title for the flowchart
 * @param {boolean} [props.animated=false] - Enable edge animations
 * @param {boolean} [props.showControls=true] - Show zoom/pan controls
 * @param {boolean} [props.showBackground=true] - Show grid background
 * @param {string} [props.height='400px'] - Container height
 * @param {string} [props.className] - Additional CSS class
 * @param {boolean} [props.fitView=true] - Fit view to nodes on load
 * @param {Function} [props.onNodeClick] - Callback when node is clicked
 *
 * @example
 * const data = {
 *   nodes: [
 *     { id: '1', type: 'input', label: 'Start' },
 *     { id: '2', label: 'Process' },
 *     { id: '3', type: 'output', label: 'End' }
 *   ],
 *   edges: [
 *     { source: '1', target: '2' },
 *     { source: '2', target: '3' }
 *   ]
 * }
 *
 * <FlowchartViewer data={data} />
 */
export function FlowchartViewer({
  data,
  title,
  animated = false,
  showControls = true,
  showBackground = true,
  height = '400px',
  className = '',
  fitView = true,
  onNodeClick,
}) {
  // Validate and transform data
  const { processedNodes, processedEdges } = useMemo(() => {
    if (!data || !data.nodes) {
      return { processedNodes: [], processedEdges: [] }
    }

    // Transform nodes to React Flow format
    const rawNodes = data.nodes.map(node => ({
      id: String(node.id),
      type: node.type || 'default',
      position: node.position || { x: 0, y: 0 },
      data: {
        label: node.label || node.id,
        description: node.description,
        ...node.data,
      },
      style: node.style,
    }))

    // Apply auto-layout if needed
    const layoutedNodes = autoLayoutNodes(rawNodes, data.edges || [])

    // Transform edges to React Flow format
    const rawEdges = (data.edges || []).map((edge, index) => ({
      id: edge.id || `edge-${edge.source}-${edge.target}-${index}`,
      source: String(edge.source),
      target: String(edge.target),
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      type: edge.type || EDGE_DEFAULTS.type,
      animated: edge.animated ?? animated,
      label: edge.label,
      style: {
        ...EDGE_DEFAULTS.style,
        ...edge.style,
      },
      markerEnd: edge.markerEnd || EDGE_DEFAULTS.markerEnd,
    }))

    return {
      processedNodes: layoutedNodes,
      processedEdges: rawEdges,
    }
  }, [data, animated])

  // State for nodes and edges
  const [nodes, setNodes, onNodesChange] = useNodesState(processedNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(processedEdges)

  // Update when data changes
  useEffect(() => {
    setNodes(processedNodes)
    setEdges(processedEdges)
  }, [processedNodes, processedEdges, setNodes, setEdges])

  // Node click handler
  const handleNodeClick = useCallback((event, node) => {
    if (onNodeClick) {
      onNodeClick(node)
    }
  }, [onNodeClick])

  // Empty state
  if (!data || !data.nodes || data.nodes.length === 0) {
    return (
      <div className={`flowchart-viewer flowchart-viewer--empty ${className}`} style={{ height }}>
        <div className="flowchart-viewer__empty">
          <span className="flowchart-viewer__empty-icon">&#9783;</span>
          <span className="flowchart-viewer__empty-text">No flowchart data provided</span>
        </div>
      </div>
    )
  }

  return (
    <div className={`flowchart-viewer ${className}`} style={{ height }}>
      {title && (
        <div className="flowchart-viewer__header">
          <h3 className="flowchart-viewer__title">{title}</h3>
        </div>
      )}
      <div className="flowchart-viewer__canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          nodeTypes={nodeTypes}
          fitView={fitView}
          fitViewOptions={{
            padding: 0.2,
            maxZoom: 1.5,
          }}
          minZoom={0.25}
          maxZoom={2}
          defaultEdgeOptions={EDGE_DEFAULTS}
          proOptions={{ hideAttribution: true }}
        >
          {showBackground && (
            <Background
              variant="dots"
              gap={16}
              size={1}
              color="rgba(255, 255, 255, 0.05)"
            />
          )}
          {showControls && (
            <Controls
              showZoom={true}
              showFitView={true}
              showInteractive={false}
            />
          )}
        </ReactFlow>
      </div>
    </div>
  )
}

export default FlowchartViewer
