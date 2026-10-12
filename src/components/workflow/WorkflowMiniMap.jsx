/**
 * WorkflowMiniMap — Pure SVG thumbnail of a workflow topology.
 *
 * Renders colored dots (by node category) connected by thin lines,
 * auto-scaled to fit the container. No React Flow, no canvas — just SVG.
 */

import { useMemo } from 'react';
import { parseN8nWorkflow, calculateDepths, getNodeCategory } from './WireMap/wireMapParser';

// Same category colors as WireMap
const CATEGORY_COLORS = {
    trigger: '#10b981',
    logic: '#f59e0b',
    io: '#6366f1',
    storage: '#8b5cf6',
    notify: '#ef4444',
    ai: '#ec4899',
    transform: '#06b6d4',
    other: '#6b7280'
};

/**
 * Compute a simple top-down layered layout for the mini-map.
 * Returns { nodes: [{id, x, y, color}], edges: [{x1,y1,x2,y2}], width, height }
 */
function computeMiniLayout(workflowJson) {
    const graph = parseN8nWorkflow(workflowJson);
    if (!graph.metadata.valid || graph.nodes.length === 0) return null;

    const depths = calculateDepths(graph);

    // Group nodes by depth (row)
    const layers = new Map();
    for (const node of graph.nodes) {
        const d = depths.get(node.id) ?? 0;
        if (!layers.has(d)) layers.set(d, []);
        layers.get(d).push(node);
    }

    const sortedLayers = [...layers.entries()].sort((a, b) => a[0] - b[0]);
    const maxLayerWidth = Math.max(...sortedLayers.map(([, nodes]) => nodes.length));
    const layerCount = sortedLayers.length;

    // Spacing in abstract units — we'll map to viewBox later
    const spacingX = 40;
    const spacingY = 30;
    const padding = 12;

    const positions = new Map();
    for (const [depth, layerNodes] of sortedLayers) {
        const layerWidth = layerNodes.length;
        const offsetX = (maxLayerWidth - layerWidth) * spacingX / 2;
        for (let i = 0; i < layerNodes.length; i++) {
            positions.set(layerNodes[i].id, {
                x: padding + offsetX + i * spacingX,
                y: padding + depth * spacingY
            });
        }
    }

    const layoutNodes = graph.nodes.map(n => ({
        id: n.id,
        ...positions.get(n.id),
        color: CATEGORY_COLORS[n.category] || CATEGORY_COLORS.other
    }));

    const layoutEdges = graph.edges.map(e => {
        const s = positions.get(e.source);
        const t = positions.get(e.target);
        if (!s || !t) return null;
        return { x1: s.x, y1: s.y, x2: t.x, y2: t.y };
    }).filter(Boolean);

    const width = (maxLayerWidth - 1) * spacingX + padding * 2;
    const height = (layerCount - 1) * spacingY + padding * 2;

    return { nodes: layoutNodes, edges: layoutEdges, width, height };
}

export function WorkflowMiniMap({ workflow, height = 56, className = '' }) {
    const layout = useMemo(() => {
        if (!workflow?.nodes?.length) return null;
        try {
            return computeMiniLayout(workflow);
        } catch {
            return null;
        }
    }, [workflow]);

    if (!layout) return null;

    const dotRadius = layout.nodes.length > 20 ? 3 : layout.nodes.length > 10 ? 4 : 5;

    return (
        <div
            className={`workflow-minimap ${className}`}
            style={{ height, width: '100%', overflow: 'hidden' }}
        >
            <svg
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                width="100%"
                height="100%"
                preserveAspectRatio="xMidYMid meet"
                style={{ display: 'block' }}
            >
                {/* Edges */}
                {layout.edges.map((e, i) => (
                    <line
                        key={`e${i}`}
                        x1={e.x1}
                        y1={e.y1}
                        x2={e.x2}
                        y2={e.y2}
                        stroke="rgba(255,255,255,0.15)"
                        strokeWidth={1}
                    />
                ))}
                {/* Nodes */}
                {layout.nodes.map(n => (
                    <circle
                        key={n.id}
                        cx={n.x}
                        cy={n.y}
                        r={dotRadius}
                        fill={n.color}
                        opacity={0.85}
                    />
                ))}
            </svg>
        </div>
    );
}

export default WorkflowMiniMap;
