/**
 * QuoxCORE Flowchart Components
 *
 * Reusable flowchart visualization tool for agents to generate visual diagrams.
 * Built on React Flow v12 with QuoxCORE design system styling.
 *
 * @module components/flowchart
 *
 * Usage:
 * ```jsx
 * import { Flowchart } from '@/components/flowchart'
 *
 * // Simple usage - auto-layout
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
 * ```
 *
 * JSON Schema for Agents:
 * =======================
 *
 * ```typescript
 * interface FlowchartData {
 *   nodes: Array<{
 *     id: string;                    // Unique node identifier
 *     label: string;                 // Display text
 *     type?: 'input' | 'output' | 'decision' | 'action' | 'default';
 *     description?: string;          // Secondary text
 *     position?: { x: number; y: number };  // Auto-calculated if omitted
 *   }>;
 *   edges: Array<{
 *     source: string;                // Source node ID
 *     target: string;                // Target node ID
 *     label?: string;                // Edge label
 *     animated?: boolean;            // Animate this edge
 *     sourceHandle?: 'bottom' | 'right' | 'left';  // For decision nodes
 *   }>;
 * }
 * ```
 *
 * Node Types:
 * - input: Green start node (use for flow entry points)
 * - output: Red end node (use for flow termination)
 * - decision: Yellow diamond (use for conditional branching)
 * - action: Red highlighted (use for important actions)
 * - default: Standard node (use for regular process steps)
 *
 * Themes:
 * - "color"  : Full colors (green/red/yellow) for node types - vibrant
 * - "mono"   : Clean white on black - minimal, single color, elegant
 * - "accent" : White on black with red (#ff3333) accent for actions/hover
 *
 * Example with theme:
 * ```jsx
 * <Flowchart data={data} theme="mono" />
 * ```
 *
 * Styling (default color theme):
 * - Background: #0a0a0f (QuoxCORE deep)
 * - Surface: #12121a (QuoxCORE elevated)
 * - Accent: #ff3333 (QuoxCORE HAL red)
 * - Controls in bottom-left corner
 * - Dot grid background
 */

// Main exports
export { Flowchart, THEMES, default as FlowchartDefault } from './Flowchart'
export { FlowchartViewer } from './FlowchartViewer'

// Default export is the simple Flowchart wrapper
export { default } from './Flowchart'
