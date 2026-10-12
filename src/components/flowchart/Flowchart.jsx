/**
 * Flowchart - Simple wrapper for embedding flowcharts in chat messages
 *
 * This component provides a simple API for agents to generate visual flowcharts.
 * It wraps FlowchartViewer with sensible defaults for chat embedding.
 *
 * @module components/flowchart/Flowchart
 *
 * @example
 * // Basic usage
 * <Flowchart data={{
 *   nodes: [
 *     { id: '1', type: 'input', label: 'Start' },
 *     { id: '2', label: 'Process' },
 *     { id: '3', type: 'output', label: 'End' }
 *   ],
 *   edges: [
 *     { source: '1', target: '2' },
 *     { source: '2', target: '3' }
 *   ]
 * }} />
 *
 * @example
 * // With title and animation
 * <Flowchart
 *   data={flowchartData}
 *   title="User Authentication Flow"
 *   animated
 * />
 */

import { useMemo } from 'react'
import FlowchartViewer from './FlowchartViewer'

/**
 * JSON Schema Documentation for Agents
 * =====================================
 *
 * The Flowchart component accepts a `data` prop with the following structure:
 *
 * ```json
 * {
 *   "nodes": [
 *     {
 *       "id": "unique-id",           // Required: Unique identifier
 *       "label": "Node Label",       // Required: Display text
 *       "type": "default",           // Optional: "input" | "output" | "decision" | "action" | "default"
 *       "description": "Details",    // Optional: Secondary text below label
 *       "position": { "x": 0, "y": 0 } // Optional: Auto-calculated if omitted
 *     }
 *   ],
 *   "edges": [
 *     {
 *       "source": "node-id-1",       // Required: Source node ID
 *       "target": "node-id-2",       // Required: Target node ID
 *       "label": "Edge Label",       // Optional: Label on the edge
 *       "animated": false,           // Optional: Animate this specific edge
 *       "sourceHandle": "right",     // Optional: For decision nodes: "bottom" | "right" | "left"
 *       "targetHandle": "top"        // Optional: Target handle position
 *     }
 *   ]
 * }
 * ```
 *
 * Node Types:
 * - "input"    : Green start node with play icon
 * - "output"   : Red end node with stop icon
 * - "decision" : Yellow diamond for conditional branching
 * - "action"   : Red highlighted action step
 * - "default"  : Standard process step (default)
 *
 * Auto-Layout:
 * - If positions are omitted, nodes are automatically arranged top-to-bottom
 * - The algorithm uses graph topology (edges) to determine levels
 * - Nodes at the same level are spread horizontally
 *
 * Example Flowcharts:
 *
 * 1. Simple Linear Flow:
 * ```json
 * {
 *   "nodes": [
 *     { "id": "1", "type": "input", "label": "Start" },
 *     { "id": "2", "label": "Step 1" },
 *     { "id": "3", "label": "Step 2" },
 *     { "id": "4", "type": "output", "label": "End" }
 *   ],
 *   "edges": [
 *     { "source": "1", "target": "2" },
 *     { "source": "2", "target": "3" },
 *     { "source": "3", "target": "4" }
 *   ]
 * }
 * ```
 *
 * 2. Decision Flow:
 * ```json
 * {
 *   "nodes": [
 *     { "id": "1", "type": "input", "label": "Start" },
 *     { "id": "2", "type": "decision", "label": "Valid?" },
 *     { "id": "3", "type": "action", "label": "Process" },
 *     { "id": "4", "label": "Handle Error" },
 *     { "id": "5", "type": "output", "label": "End" }
 *   ],
 *   "edges": [
 *     { "source": "1", "target": "2" },
 *     { "source": "2", "target": "3", "label": "Yes", "sourceHandle": "bottom" },
 *     { "source": "2", "target": "4", "label": "No", "sourceHandle": "right" },
 *     { "source": "3", "target": "5" },
 *     { "source": "4", "target": "5" }
 *   ]
 * }
 * ```
 */

/**
 * Available Themes:
 * - "color"  : Full colors for each node type (green start, red end, yellow decision)
 * - "mono"   : Clean white on black, single color, minimal
 * - "accent" : White on black with red accent for actions/hover
 */
export const THEMES = {
  COLOR: 'color',
  MONO: 'mono',
  ACCENT: 'accent'
}

/**
 * Flowchart Component - Simple API wrapper
 *
 * @param {Object} props
 * @param {Object} props.data - Flowchart JSON data (see schema above)
 * @param {string} [props.title] - Optional title displayed above the flowchart
 * @param {boolean} [props.animated=false] - Enable animated edges
 * @param {string} [props.height='350px'] - Container height
 * @param {boolean} [props.compact=false] - Use smaller height for inline display
 * @param {string} [props.theme='color'] - Theme: 'mono' | 'color' | 'accent'
 * @param {string} [props.className] - Additional CSS classes
 *
 * @returns {JSX.Element}
 */
export function Flowchart({
  data,
  title,
  animated = false,
  height,
  compact = false,
  theme = 'color',
  className = '',
}) {
  // Determine height based on props
  const containerHeight = useMemo(() => {
    if (height) return height
    if (compact) return '280px'
    return '350px'
  }, [height, compact])

  // Parse data if it's a string (for agent convenience)
  const parsedData = useMemo(() => {
    if (!data) return null
    if (typeof data === 'string') {
      try {
        return JSON.parse(data)
      } catch (e) {
        console.error('Flowchart: Failed to parse data JSON:', e)
        return null
      }
    }
    return data
  }, [data])

  // Build theme class
  const themeClass = theme && theme !== 'color' ? `flowchart-viewer--${theme}` : ''

  return (
    <FlowchartViewer
      data={parsedData}
      title={title}
      animated={animated}
      height={containerHeight}
      className={`flowchart-embed ${themeClass} ${className}`.trim()}
      showControls={true}
      showBackground={true}
      fitView={true}
    />
  )
}

export default Flowchart
