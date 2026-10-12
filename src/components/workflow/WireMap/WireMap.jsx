/**
 * WireMap - Visual n8n Workflow Viewer (Redesigned)
 *
 * A clean, readable workflow diagram with:
 * - Top-to-bottom layout (vertical flow)
 * - Larger, labeled nodes with category colors
 * - Visible curved connections with arrows
 * - Right-side detail panel on selection
 * - Hover highlighting of connected paths
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import {
    ReactFlow,
    Background,
    Controls,
    useNodesState,
    useEdgesState,
    MarkerType,
    Position,
    Handle
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { parseWorkflow } from './wireMapParser';
import './WireMap.css';

// =============================================================================
// EXECUTION OVERLAY STATUS CONFIG (STUDY-REV-2 P5.B)
// =============================================================================

// Maps status → { className, badge icon character }
const STATUS_DECORATION = {
  running:   { cls: 'qx-node--running',   badge: '•' },
  completed: { cls: 'qx-node--completed', badge: '✓' },
  failed:    { cls: 'qx-node--failed',    badge: '✗' },
  queued:    { cls: 'qx-node--queued',    badge: '◦' },
  skipped:   { cls: 'qx-node--skipped',   badge: '—' },
}

// =============================================================================
// CATEGORY CONFIGURATION
// =============================================================================

const CATEGORIES = {
    trigger: { color: '#10b981', icon: '⚡', label: 'Trigger' },
    logic: { color: '#f59e0b', icon: '🔀', label: 'Logic' },
    io: { color: '#6366f1', icon: '🔗', label: 'HTTP/API' },
    storage: { color: '#8b5cf6', icon: '💾', label: 'Storage' },
    notify: { color: '#ef4444', icon: '📬', label: 'Notify' },
    ai: { color: '#ec4899', icon: '🧠', label: 'AI' },
    transform: { color: '#06b6d4', icon: '⚙️', label: 'Transform' },
    other: { color: '#6b7280', icon: '📦', label: 'Other' }
};

// =============================================================================
// WORKFLOW NODE COMPONENT
// =============================================================================

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s }

function getNodeSubtitle(type, config = {}) {
    if (!config) return ''
    switch (type) {
        case 'trigger:schedule': return config.cron || ''
        case 'trigger:webhook': return `${config.method || 'POST'} ${config.path || '/webhook'}`
        case 'trigger:event': return config.event || ''
        case 'agent:agentic': return config.agent ? `${config.agent}${config.maxIterations ? ` · ${config.maxIterations}×` : ''}` : ''
        case 'call': return `${config.method || 'GET'} ${truncate(config.url || '', 28)}`
        case 'data:transform': return truncate(config.expression || '', 28)
        case 'data:set': return config.field ? `${config.field} =` : ''
        case 'data:aggregate': return config.operation ? `${config.operation} ${config.field || ''}`.trim() : ''
        case 'flow:condition': return truncate(config.expression || '', 28)
        case 'flow:loop': return config.collection ? `for each ${config.collection}` : ''
        case 'flow:parallel': return config.maxConcurrency ? `≤${config.maxConcurrency} concurrent` : ''
        case 'util:wait': return config.duration ? `${config.duration}ms` : ''
        case 'util:log': return config.level || ''
        case 'util:subworkflow': return config.workflowId || ''
        case 'error:try': return config.retries ? `retry ×${config.retries}` : ''
        case 'error:throw': return config.code || config.message || ''
        default: return ''
    }
}

function WorkflowNode({ data, selected }) {
    const category = CATEGORIES[data.category] || CATEGORIES.other;
    const subtitle = getNodeSubtitle(data.type, data.config);
    const typeLabel = data.shortType || data.type;

    // Execution overlay decoration from nodeStatus Map passed via data
    const execStatus = data.execStatus || null;
    const decoration = execStatus ? STATUS_DECORATION[execStatus] : null;

    return (
        <div
            className={`qx-node ${selected ? 'qx-node--selected' : ''} ${decoration ? decoration.cls : ''}`}
            style={{ '--qx-node-color': category.color }}
        >
            <Handle type="target" position={Position.Top} className="qx-node-handle" style={{ '--qx-handle-color': category.color }} />

            {decoration && (
                <span
                    className="qx-node__status-badge"
                    aria-label={`Node status: ${execStatus}`}
                    role="img"
                >
                    {decoration.badge}
                </span>
            )}

            <div className="qx-node__head">
                <span aria-hidden="true">{category.icon}</span>
                <span>{typeLabel}</span>
            </div>
            <div className="qx-node__title" title={data.name}>
                {data.name}
            </div>
            {subtitle && (
                <div className="qx-node__sub" title={subtitle}>{subtitle}</div>
            )}

            <Handle type="source" position={Position.Bottom} className="qx-node-handle" style={{ '--qx-handle-color': category.color }} />
        </div>
    );
}

const nodeTypes = {
    workflowNode: WorkflowNode
};

// =============================================================================
// NODE PROPERTY EDITOR COMPONENT
// =============================================================================

function NodePropertyEditor({ nodeId, config, onUpdateNode }) {
    if (!config || typeof config !== 'object') return null;

    const entries = Object.entries(config);
    if (entries.length === 0) return null;

    const handleChange = (key, rawValue, type) => {
        let value = rawValue;
        if (type === 'number') value = rawValue === '' ? '' : Number(rawValue);
        if (type === 'boolean') value = rawValue;

        onUpdateNode(nodeId, { config: { ...config, [key]: value } });
    };

    return (
        <div className="wiremap-detail__props">
            {entries.map(([key, value]) => {
                const valueType = typeof value;

                if (valueType === 'boolean') {
                    return (
                        <div key={key} className="wiremap-detail__prop">
                            <label className="wiremap-detail__prop-label">{key}</label>
                            <label className="wiremap-detail__checkbox">
                                <input
                                    type="checkbox"
                                    checked={value}
                                    onChange={(e) => handleChange(key, e.target.checked, 'boolean')}
                                />
                                <span>{value ? 'true' : 'false'}</span>
                            </label>
                        </div>
                    );
                }

                if (valueType === 'number') {
                    return (
                        <div key={key} className="wiremap-detail__prop">
                            <label className="wiremap-detail__prop-label">{key}</label>
                            <input
                                type="number"
                                className="wiremap-detail__input"
                                value={value}
                                onChange={(e) => handleChange(key, e.target.value, 'number')}
                            />
                        </div>
                    );
                }

                if (valueType === 'string') {
                    return (
                        <div key={key} className="wiremap-detail__prop">
                            <label className="wiremap-detail__prop-label">{key}</label>
                            <input
                                type="text"
                                className="wiremap-detail__input"
                                value={value}
                                onChange={(e) => handleChange(key, e.target.value, 'string')}
                            />
                        </div>
                    );
                }

                // Non-editable for objects/arrays — show as JSON
                return (
                    <div key={key} className="wiremap-detail__prop">
                        <label className="wiremap-detail__prop-label">{key}</label>
                        <pre className="wiremap-detail__params">
                            {JSON.stringify(value, null, 2)}
                        </pre>
                    </div>
                );
            })}
        </div>
    );
}

// =============================================================================
// DETAIL PANEL COMPONENT
// =============================================================================

function DetailPanel({ node, graph, onClose, onUpdateNode }) {
    if (!node) return null;

    const graphNode = graph?.nodes?.find(n => n.id === node.id);
    if (!graphNode) return null;

    const category = CATEGORIES[graphNode.category] || CATEGORIES.other;
    const editable = typeof onUpdateNode === 'function';

    // Find connected nodes
    const inputNodes = graphNode.inputs.map(id =>
        graph.nodes.find(n => n.id === id)
    ).filter(Boolean);

    const outputNodes = graphNode.outputs.map(id =>
        graph.nodes.find(n => n.id === id)
    ).filter(Boolean);

    const handleNameChange = (e) => {
        onUpdateNode(graphNode.id, { name: e.target.value });
    };

    return (
        <div className="wiremap-detail">
            <div className="wiremap-detail__header">
                <div className="wiremap-detail__title">
                    <span className="wiremap-detail__icon" style={{ background: category.color }}>
                        {category.icon}
                    </span>
                    <div>
                        {editable ? (
                            <input
                                type="text"
                                className="wiremap-detail__name-input"
                                value={graphNode.name}
                                onChange={handleNameChange}
                                placeholder="Node name"
                            />
                        ) : (
                            <h3>{graphNode.name}</h3>
                        )}
                        <span className="wiremap-detail__category">{category.label}</span>
                    </div>
                </div>
                <button className="wiremap-detail__close" onClick={onClose}>×</button>
            </div>

            <div className="wiremap-detail__body">
                <div className="wiremap-detail__section">
                    <label>Type</label>
                    <p className="wiremap-detail__value">{graphNode.shortType}</p>
                </div>

                <div className="wiremap-detail__section">
                    <label>Summary</label>
                    <p className="wiremap-detail__summary">{graphNode.summary}</p>
                </div>

                {inputNodes.length > 0 && (
                    <div className="wiremap-detail__section">
                        <label>Inputs ({inputNodes.length})</label>
                        <div className="wiremap-detail__connections">
                            {inputNodes.map(n => (
                                <span key={n.id} className="wiremap-detail__tag">
                                    {n.name}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {outputNodes.length > 0 && (
                    <div className="wiremap-detail__section">
                        <label>Outputs ({outputNodes.length})</label>
                        <div className="wiremap-detail__connections">
                            {outputNodes.map(n => (
                                <span key={n.id} className="wiremap-detail__tag">
                                    {n.name}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {editable && graphNode.config && Object.keys(graphNode.config).length > 0 && (
                    <div className="wiremap-detail__section">
                        <label>Properties</label>
                        <NodePropertyEditor
                            nodeId={graphNode.id}
                            config={graphNode.config}
                            onUpdateNode={onUpdateNode}
                        />
                    </div>
                )}

                {graphNode.sanitizedParams && Object.keys(graphNode.sanitizedParams).length > 0 && (
                    <div className="wiremap-detail__section">
                        <label>Parameters</label>
                        <pre className="wiremap-detail__params">
                            {JSON.stringify(graphNode.sanitizedParams, null, 2)}
                        </pre>
                    </div>
                )}
            </div>
        </div>
    );
}

// =============================================================================
// VERTICAL LAYOUT ALGORITHM
// =============================================================================

function layoutVertical(graph, options = {}) {
    const {
        nodeWidth = 180,
        nodeHeight = 60,
        horizontalSpacing = 60,
        verticalSpacing = 80,
        startX = 100,
        startY = 50
    } = options;

    const { nodes, edges, metadata } = graph;

    // Calculate depths using BFS from trigger nodes
    const depths = new Map();
    const nodeById = new Map(nodes.map(n => [n.id, n]));

    // Initialize trigger nodes at depth 0
    metadata.triggerNodes.forEach(id => depths.set(id, 0));

    // BFS to calculate depths
    let changed = true;
    let iterations = 0;
    const maxIterations = nodes.length * 2;

    while (changed && iterations < maxIterations) {
        changed = false;
        iterations++;

        edges.forEach(edge => {
            const sourceDepth = depths.get(edge.source);
            if (sourceDepth !== undefined) {
                const currentTargetDepth = depths.get(edge.target);
                const newDepth = sourceDepth + 1;

                if (currentTargetDepth === undefined || newDepth > currentTargetDepth) {
                    depths.set(edge.target, newDepth);
                    changed = true;
                }
            }
        });
    }

    // Handle disconnected nodes
    const maxDepth = Math.max(0, ...depths.values());
    nodes.forEach(node => {
        if (!depths.has(node.id)) {
            depths.set(node.id, maxDepth + 1);
        }
    });

    // Group nodes by depth (row)
    const rows = new Map();
    nodes.forEach(node => {
        const depth = depths.get(node.id) || 0;
        if (!rows.has(depth)) rows.set(depth, []);
        rows.get(depth).push(node);
    });

    // Sort rows by depth
    const sortedRows = [...rows.entries()].sort((a, b) => a[0] - b[0]);

    // Find max row width for centering
    const maxRowWidth = Math.max(...sortedRows.map(([_, rowNodes]) =>
        rowNodes.length * (nodeWidth + horizontalSpacing)
    ));

    // Position nodes - TOP TO BOTTOM layout
    const positions = new Map();
    sortedRows.forEach(([depth, rowNodes]) => {
        const rowWidth = rowNodes.length * (nodeWidth + horizontalSpacing) - horizontalSpacing;
        const rowStartX = startX + (maxRowWidth - rowWidth) / 2;

        rowNodes.forEach((node, index) => {
            positions.set(node.id, {
                x: rowStartX + index * (nodeWidth + horizontalSpacing),
                y: startY + depth * (nodeHeight + verticalSpacing)
            });
        });
    });

    return {
        ...graph,
        positions,
        depths,
        layout: {
            width: maxRowWidth + startX * 2,
            height: (sortedRows.length) * (nodeHeight + verticalSpacing) + startY
        }
    };
}

// =============================================================================
// MAIN WIREMAP COMPONENT
// =============================================================================

// =============================================================================
// LAYOUT PERSISTENCE (localStorage)
// =============================================================================

const LAYOUT_STORAGE_PREFIX = 'quox_wiremap_layout_';

function loadSavedLayout(workflowName) {
    if (!workflowName) return new Map();
    try {
        const raw = localStorage.getItem(LAYOUT_STORAGE_PREFIX + workflowName);
        if (!raw) return new Map();
        const obj = JSON.parse(raw);
        return new Map(Object.entries(obj));
    } catch {
        return new Map();
    }
}

function saveLayout(workflowName, positions) {
    if (!workflowName || positions.size === 0) return;
    try {
        const obj = {};
        positions.forEach((pos, id) => { obj[id] = pos; });
        localStorage.setItem(LAYOUT_STORAGE_PREFIX + workflowName, JSON.stringify(obj));
    } catch {
        // Storage full — non-critical
    }
}

export function WireMap({
    workflowJson,
    onNodeSelect,
    onNodeDrop,
    onUpdateNode,
    onConnect: onConnectProp,
    onEdgeDelete,
    disableDetailPanel = false,
    className = '',
    nodeStatus = null,  // Map<nodeId, 'queued'|'running'|'completed'|'failed'|'skipped'>
}) {
    // Parse and layout the workflow
    const [graph, layoutedGraph] = useMemo(() => {
        if (!workflowJson) return [null, null];
        try {
            const parsed = parseWorkflow(workflowJson);
            const layouted = layoutVertical(parsed);
            return [parsed, layouted];
        } catch (err) {
            console.error('Failed to parse workflow:', err);
            return [null, null];
        }
    }, [workflowJson]);

    // Workflow name for persistence
    const workflowName = workflowJson?.name || workflowJson?.id || null;

    // React Flow state
    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);

    // UI state
    const [selectedNode, setSelectedNode] = useState(null);
    const [hoveredNodeId, setHoveredNodeId] = useState(null);
    // Manual position overrides from drag — load from localStorage
    const [manualPositions, setManualPositions] = useState(() => loadSavedLayout(workflowName));

    // Ref for ReactFlow instance (needed for drag-to-canvas)
    const reactFlowRef = useCallback(node => {
        if (node) reactFlowRef._node = node;
    }, []);

    // Convert graph to React Flow format. Split into TWO effects so hovering
    // doesn't reset every node/edge in the canvas:
    //
    // Effect A (structure) — runs only when the workflow shape or positions
    // change. Builds the base node + edge arrays.
    // Effect B (hover overlay) — runs when hoveredNodeId changes. Patches
    // data.isHovered / isConnected on the affected nodes and the highlight
    // styles on the affected edges, returning the same object reference for
    // unchanged items so ReactFlow can skip them.
    //
    // Without this split, every mouse-enter triggers a full setNodes(newArr)
    // and ReactFlow re-renders all nodes — visible as a flicker / seize on
    // hover, edge-create, etc.
    useEffect(() => {
        if (!layoutedGraph) {
            setNodes([]);
            setEdges([]);
            return;
        }

        const flowNodes = layoutedGraph.nodes.map(node => {
            // Position priority (highest → lowest):
            //   1. manualPositions — user dragged this node, lock it.
            //   2. node.position    — set by useWorkflowBuilder.addNode (drop
            //                         coords or cascading default), preserved
            //                         by parseQuoxFlowWorkflow.
            //   3. layoutPos        — fallback for nodes that have no
            //                         explicit position (legacy templates).
            const layoutPos = layoutedGraph.positions.get(node.id) || { x: 0, y: 0 };
            const explicitPos = node.position;
            const position = manualPositions.get(node.id) || explicitPos || layoutPos;

            return {
                id: node.id,
                type: 'workflowNode',
                position,
                sourcePosition: Position.Bottom,
                targetPosition: Position.Top,
                data: {
                    ...node,
                    isHovered: false,
                    isConnected: false,
                    execStatus: nodeStatus?.get(node.id) || null,
                },
                draggable: true,
            };
        });

        // Derive edge status from source node's execution state.
        // 'flowing'  — source is running → animated cyan dash
        // 'done'     — source just completed → brief green tint (CSS handles settle)
        // 'failed'   — source failed → red tint
        // 'idle'     — default
        const getEdgeStatus = (sourceId) => {
            const s = nodeStatus?.get(sourceId);
            if (s === 'running')   return 'flowing';
            if (s === 'completed') return 'done';
            if (s === 'failed')    return 'failed';
            return 'idle';
        };

        const flowEdges = layoutedGraph.edges.map(edge => {
            const edgeSt = getEdgeStatus(edge.source);
            const isFlowing = edgeSt === 'flowing';
            return {
                id: edge.id,
                source: edge.source,
                target: edge.target,
                type: 'smoothstep',
                animated: false,
                className: edgeSt !== 'idle' ? `wm-edge--${edgeSt}` : undefined,
                style: {
                    stroke: isFlowing
                        ? 'rgba(56, 189, 248, 0.8)'
                        : edgeSt === 'done'
                            ? 'rgba(74, 222, 128, 0.7)'
                            : edgeSt === 'failed'
                                ? 'rgba(248, 113, 113, 0.7)'
                                : 'rgba(255, 255, 255, 0.3)',
                    strokeWidth: edgeSt !== 'idle' ? 2.5 : 2,
                },
                markerEnd: {
                    type: MarkerType.ArrowClosed,
                    width: 15,
                    height: 15,
                    color: isFlowing
                        ? 'rgba(56, 189, 248, 0.9)'
                        : edgeSt === 'done'
                            ? 'rgba(74, 222, 128, 0.8)'
                            : edgeSt === 'failed'
                                ? 'rgba(248, 113, 113, 0.8)'
                                : 'rgba(255, 255, 255, 0.4)',
                },
            };
        });

        setNodes(flowNodes);
        setEdges(flowEdges);
    }, [layoutedGraph, manualPositions, nodeStatus, setNodes, setEdges]);

    // Hover overlay — only the hovered node + its neighbours change. Anything
    // else returns the same reference so React/ReactFlow bail out of re-render.
    useEffect(() => {
        if (!layoutedGraph) return;

        const connectedIds = new Set();
        if (hoveredNodeId) {
            connectedIds.add(hoveredNodeId);
            const hoveredNode = layoutedGraph.nodes.find(n => n.id === hoveredNodeId);
            if (hoveredNode) {
                hoveredNode.inputs.forEach(id => connectedIds.add(id));
                hoveredNode.outputs.forEach(id => connectedIds.add(id));
            }
        }

        setNodes(prev => prev.map(n => {
            const isHovered = n.id === hoveredNodeId;
            const isConnected = connectedIds.has(n.id) && !isHovered;
            if (n.data?.isHovered === isHovered && n.data?.isConnected === isConnected) {
                return n;
            }
            return { ...n, data: { ...n.data, isHovered, isConnected } };
        }));

        setEdges(prev => prev.map(e => {
            const highlight = connectedIds.has(e.source) && connectedIds.has(e.target);
            if (e.animated === highlight) return e;
            return {
                ...e,
                animated: highlight,
                style: {
                    stroke: highlight ? '#4f9eff' : 'rgba(255, 255, 255, 0.3)',
                    strokeWidth: highlight ? 3 : 2,
                },
                markerEnd: {
                    type: MarkerType.ArrowClosed,
                    width: 15,
                    height: 15,
                    color: highlight ? '#4f9eff' : 'rgba(255, 255, 255, 0.4)',
                },
            };
        }));
    }, [hoveredNodeId, layoutedGraph, setNodes, setEdges]);

    // Handle node click
    const onNodeClick = useCallback((event, node) => {
        setSelectedNode(node);
        onNodeSelect?.(node);
    }, [onNodeSelect]);

    // Handle node hover
    const onNodeMouseEnter = useCallback((event, node) => {
        setHoveredNodeId(node.id);
    }, []);

    const onNodeMouseLeave = useCallback(() => {
        setHoveredNodeId(null);
    }, []);

    // Handle node drag end — persist position to state + localStorage
    const onNodeDragStop = useCallback((event, node) => {
        setManualPositions(prev => {
            const next = new Map(prev);
            next.set(node.id, { x: node.position.x, y: node.position.y });
            saveLayout(workflowName, next);
            return next;
        });
    }, [workflowName]);

    // Handle pane click (deselect)
    const onPaneClick = useCallback(() => {
        setSelectedNode(null);
    }, []);

    // Connect handles: ReactFlow fires this when a user drags from a source
    // handle onto a target handle. Forward to the builder; the resulting edge
    // round-trips back through workflowJson on the next render.
    const onConnect = useCallback((connection) => {
        if (!onConnectProp || !connection?.source || !connection?.target) return;
        onConnectProp(connection.source, connection.target, connection.sourceHandle, connection.targetHandle);
    }, [onConnectProp]);

    // Edge delete (Backspace on a selected edge). Forward each removed edge id
    // to the builder so the source-of-truth state drops it.
    const onEdgesDelete = useCallback((deletedEdges) => {
        if (!onEdgeDelete) return;
        for (const edge of deletedEdges) {
            if (edge?.id) onEdgeDelete(edge.id);
        }
    }, [onEdgeDelete]);

    // Drag-to-canvas: accept dragged node types from NodePalette
    const onDragOver = useCallback((event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    }, []);

    const onDrop = useCallback((event) => {
        event.preventDefault();
        if (!onNodeDrop) return;

        // Prefer the structured payload (carries kind + agent metadata for
        // agent items); fall back to the legacy nodeType-only MIME for any
        // pre-existing producers we haven't migrated.
        let payload = null;
        const structured = event.dataTransfer.getData('application/quoxflow-drop-item');
        if (structured) {
            try {
                payload = JSON.parse(structured);
            } catch (_) {
                payload = null;
            }
        }
        if (!payload) {
            const legacyType = event.dataTransfer.getData('application/quoxflow-node');
            if (legacyType) payload = { kind: 'node', nodeType: legacyType };
        }
        if (!payload || !payload.nodeType) return;

        const bounds = event.currentTarget.getBoundingClientRect();
        const position = {
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top
        };

        onNodeDrop(payload, position);
    }, [onNodeDrop]);

    // Close detail panel
    const closeDetail = useCallback(() => {
        setSelectedNode(null);
    }, []);

    if (!workflowJson) {
        return (
            <div className={`wiremap wiremap--empty ${className}`}>
                <div className="wiremap__placeholder">
                    <span className="wiremap__placeholder-icon">📊</span>
                    <p>No workflow to display</p>
                </div>
            </div>
        );
    }

    if (!graph?.metadata?.valid) {
        return (
            <div className={`wiremap wiremap--error ${className}`}>
                <div className="wiremap__placeholder">
                    <span className="wiremap__placeholder-icon">⚠️</span>
                    <p>Failed to parse workflow</p>
                    <small>{graph?.metadata?.error}</small>
                </div>
            </div>
        );
    }

    return (
        <div className={`wiremap ${className}`}>
            <div className="wiremap__main">
                <div className="qx-canvas wiremap__canvas">
                    <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onNodeClick={onNodeClick}
                        onNodeDragStop={onNodeDragStop}
                        onNodeMouseEnter={onNodeMouseEnter}
                        onNodeMouseLeave={onNodeMouseLeave}
                        onPaneClick={onPaneClick}
                        onDragOver={onDragOver}
                        onDrop={onDrop}
                        onConnect={onConnect}
                        onEdgesDelete={onEdgesDelete}
                        nodesConnectable={!!onConnectProp}
                        deleteKeyCode={onEdgeDelete ? 'Backspace' : null}
                        nodeTypes={nodeTypes}
                        fitView
                        fitViewOptions={{ padding: 0.3 }}
                        minZoom={0.3}
                        maxZoom={1.5}
                        attributionPosition="bottom-left"
                        proOptions={{ hideAttribution: true }}
                        defaultEdgeOptions={{
                            type: 'smoothstep',
                            animated: false
                        }}
                    >
                        <Background color="rgba(255,255,255,0.03)" gap={24} />
                        <Controls showInteractive={false} />
                    </ReactFlow>
                </div>

                {/* Stats bar */}
                <div className="wiremap__stats">
                    <span>{graph.metadata.nodeCount} nodes</span>
                    <span className="wiremap__stats-divider">•</span>
                    <span>{graph.metadata.edgeCount} connections</span>
                    {graph.metadata.hasDisconnected && (
                        <>
                            <span className="wiremap__stats-divider">•</span>
                            <span className="wiremap__stats-warning">
                                {graph.metadata.subgraphCount} separate flows
                            </span>
                        </>
                    )}
                </div>
            </div>

            {/* Detail Panel — suppressed when an external drawer (NodeConfigDrawer)
                is mounted by the parent view. */}
            {!disableDetailPanel && selectedNode && (
                <DetailPanel
                    node={selectedNode}
                    graph={graph}
                    onClose={closeDetail}
                    onUpdateNode={onUpdateNode}
                />
            )}
        </div>
    );
}

export default WireMap;
