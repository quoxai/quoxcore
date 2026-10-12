/**
 * ScopeOrgChart — React Flow org chart for scope hierarchy.
 *
 * Renders owner → org → divisions → departments as an interactive
 * top-down tree with member leaf nodes. Click a node to navigate,
 * current scope highlighted. Reuses @xyflow/react (already installed for WireMap).
 */

import { useMemo, useCallback, useEffect } from 'react';
import {
    ReactFlow,
    Background,
    Controls,
    useNodesState,
    useEdgesState,
    MarkerType,
    Handle,
    Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './ScopeOrgChart.css';

// =============================================================================
// SCOPE NODE COLOURS & ICONS
// =============================================================================

const SCOPE_CONFIG = {
    organization: { colour: '#38bdf8', icon: '[]', label: 'Organisation' },
    org:          { colour: '#38bdf8', icon: '[]', label: 'Organisation' },
    division:     { colour: '#a78bfa', icon: '||', label: 'Division' },
    department:   { colour: '#3b82f6', icon: '#',  label: 'Department' },
    team:         { colour: '#22c55e', icon: '@',  label: 'Team' },
};

// =============================================================================
// CUSTOM NODE COMPONENTS
// =============================================================================

function ScopeNode({ data, selected }) {
    const config = SCOPE_CONFIG[data.scopeType] || SCOPE_CONFIG.team;
    const isActive = data.isActive;

    return (
        <div
            className={`scope-org-node ${isActive ? 'scope-org-node--active' : ''} ${selected ? 'scope-org-node--selected' : ''}`}
            style={{ '--node-colour': config.colour }}
        >
            <Handle type="target" position={Position.Top} className="scope-org-node__handle" />

            <div className="scope-org-node__header">
                {data.logoUrl ? (
                    <img src={data.logoUrl} className="scope-org-node__logo" alt="" />
                ) : (
                    <span className="scope-org-node__icon">{config.icon}</span>
                )}
                <span className="scope-org-node__type">{config.label}</span>
            </div>

            <div className="scope-org-node__name" title={data.name}>
                {data.name.length > 24 ? data.name.slice(0, 22) + '…' : data.name}
            </div>

            {data.stats && (
                <div className="scope-org-node__stats">
                    {data.stats}
                </div>
            )}

            {/* Action icon — navigate to entity page */}
            {data.refId && (
                <button
                    className="scope-org-node__action"
                    onClick={(e) => { e.stopPropagation(); data.onManage?.(data.scopeType, data.refId); }}
                    title={`Open ${data.name}`}
                >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                </button>
            )}

            {data.hasAssistant && (
                <div className="scope-org-node__assistant" title="Has scope assistant">
                    <span className="scope-org-node__hal-dot" />
                </div>
            )}

            <Handle type="source" position={Position.Bottom} className="scope-org-node__handle" />
        </div>
    );
}

function OwnerNode({ data }) {
    return (
        <div className="scope-owner-node">
            <div className="scope-owner-node__avatar">
                {data.avatar_url ? (
                    <img src={data.avatar_url} alt={data.name} />
                ) : (
                    <span>{data.name?.[0]?.toUpperCase() || '?'}</span>
                )}
            </div>
            <div className="scope-owner-node__name" title={data.name}>
                {data.name.length > 16 ? data.name.slice(0, 14) + '…' : data.name}
            </div>
            <div className="scope-owner-node__role">Owner</div>
            <Handle type="source" position={Position.Bottom} className="scope-org-node__handle" />
        </div>
    );
}

function MemberNode({ data }) {
    return (
        <div className={`scope-member-node ${data.isOverflow ? 'scope-member-node--overflow' : ''}`}>
            <Handle type="target" position={Position.Top} className="scope-org-node__handle" />
            <div className="scope-member-node__avatar">
                {data.avatar_url ? (
                    <img src={data.avatar_url} alt={data.name} />
                ) : (
                    <span>{data.name?.[0]?.toUpperCase() || '?'}</span>
                )}
            </div>
            <div className="scope-member-node__info">
                <div className="scope-member-node__name" title={data.name}>
                    {data.name.length > 18 ? data.name.slice(0, 16) + '…' : data.name}
                </div>
                {data.role && (
                    <div className="scope-member-node__role">{data.role}</div>
                )}
            </div>
        </div>
    );
}

const nodeTypes = { scopeNode: ScopeNode, ownerNode: OwnerNode, memberNode: MemberNode };

// =============================================================================
// LAYOUT ALGORITHM — BFS tree layout with mixed node sizes
// =============================================================================

const SCOPE_WIDTH = 220;
const SCOPE_HEIGHT = 90;
const OWNER_WIDTH = 120;
const OWNER_HEIGHT = 90;
const MEMBER_WIDTH = 160;
const MEMBER_HEIGHT = 50;
const H_GAP = 40;
const V_GAP = 120;
const MEMBER_H_GAP = 20;

function getNodeWidth(id) {
    if (id.startsWith('owner-')) return OWNER_WIDTH;
    if (id.startsWith('member-')) return MEMBER_WIDTH;
    return SCOPE_WIDTH;
}

function getNodeHGap(id) {
    if (id.startsWith('member-')) return MEMBER_H_GAP;
    return H_GAP;
}

function layoutTree(flatNodes, flatEdges) {
    if (flatNodes.length === 0) return { nodes: [], edges: [] };

    // Build adjacency for children
    const childrenMap = new Map();
    const nodeById = new Map(flatNodes.map(n => [n.id, n]));

    for (const edge of flatEdges) {
        if (!childrenMap.has(edge.source)) childrenMap.set(edge.source, []);
        childrenMap.get(edge.source).push(edge.target);
    }

    // BFS to assign levels
    const levels = new Map();
    const roots = flatNodes.filter(n => !flatEdges.some(e => e.target === n.id));

    const queue = roots.map(r => ({ id: r.id, level: 0 }));
    while (queue.length > 0) {
        const { id, level } = queue.shift();
        if (levels.has(id)) continue;
        levels.set(id, level);
        const children = childrenMap.get(id) || [];
        for (const childId of children) {
            if (!levels.has(childId)) {
                queue.push({ id: childId, level: level + 1 });
            }
        }
    }

    // Group by level
    const byLevel = new Map();
    for (const [id, level] of levels) {
        if (!byLevel.has(level)) byLevel.set(level, []);
        byLevel.get(level).push(id);
    }

    // Position nodes: center children under parent
    const positions = new Map();
    const maxLevel = Math.max(...byLevel.keys(), 0);

    // First pass: assign x positions level by level (bottom-up)
    for (let lvl = maxLevel; lvl >= 0; lvl--) {
        const ids = byLevel.get(lvl) || [];
        ids.forEach((id, i) => {
            const children = childrenMap.get(id) || [];
            if (children.length > 0 && children.every(c => positions.has(c))) {
                // Center over children
                const childXs = children.map(c => positions.get(c).x + getNodeWidth(c) / 2);
                const avgX = childXs.reduce((a, b) => a + b, 0) / childXs.length;
                positions.set(id, { x: avgX - getNodeWidth(id) / 2, y: lvl * (SCOPE_HEIGHT + V_GAP) });
            } else {
                // Leaf or no positioned children yet
                const w = getNodeWidth(id);
                const gap = getNodeHGap(id);
                positions.set(id, { x: i * (w + gap), y: lvl * (SCOPE_HEIGHT + V_GAP) });
            }
        });
    }

    // Second pass: ensure no overlaps within each level
    for (let lvl = 0; lvl <= maxLevel; lvl++) {
        const ids = byLevel.get(lvl) || [];
        ids.sort((a, b) => (positions.get(a)?.x || 0) - (positions.get(b)?.x || 0));

        for (let i = 1; i < ids.length; i++) {
            const prev = positions.get(ids[i - 1]);
            const curr = positions.get(ids[i]);
            const prevW = getNodeWidth(ids[i - 1]);
            const gap = getNodeHGap(ids[i]);
            const minX = prev.x + prevW + gap;
            if (curr.x < minX) {
                const shift = minX - curr.x;
                curr.x = minX;
                shiftDescendants(ids[i], shift, positions, childrenMap);
            }
        }
    }

    // Center the entire layout
    const allX = [...positions.values()].map(p => p.x);
    const minX = Math.min(...allX);
    if (minX < 0) {
        const offset = -minX + 40;
        for (const p of positions.values()) p.x += offset;
    }

    // Build final positioned nodes
    const positionedNodes = flatNodes.map(n => ({
        ...n,
        position: positions.get(n.id) || { x: 0, y: 0 },
        style: { width: getNodeWidth(n.id) },
    }));

    return { nodes: positionedNodes, edges: flatEdges };
}

function shiftDescendants(nodeId, dx, positions, childrenMap) {
    const children = childrenMap.get(nodeId) || [];
    for (const childId of children) {
        const pos = positions.get(childId);
        if (pos) {
            pos.x += dx;
            shiftDescendants(childId, dx, positions, childrenMap);
        }
    }
}

// =============================================================================
// DATA TRANSFORM — scope tree → React Flow nodes + edges
// =============================================================================

const MAX_MEMBER_NODES = 12;

function pluralise(count, singular, plural) {
    return count === 1 ? singular : plural;
}

function scopeTreeToFlow(scopeTree, activeEntityId, teams, members, onManage, logoUrl) {
    const nodes = [];
    const edges = [];

    if (!scopeTree) return { nodes, edges };

    // Build a team lookup by attach_scope_id
    const teamByScopeId = new Map();
    if (teams) {
        for (const t of teams) {
            if (t.attach_scope_id) teamByScopeId.set(t.attach_scope_id, t);
        }
    }

    // Separate owner from regular members
    const owner = members?.find(m => m.role === 'owner');
    const nonOwnerMembers = members?.filter(m => m.role !== 'owner') || [];

    // normalise: may be a single root object or array of roots
    const roots = Array.isArray(scopeTree) ? scopeTree : [scopeTree];

    function walk(node, isRoot = false) {
        if (!node) return;

        const scopeType = node.scope_type || node.type || 'org';
        const refId = node.ref_id || node.refId;
        const isActive = refId === activeEntityId;
        const team = teamByScopeId.get(node.id);

        // Build stats text (exclude team children from count)
        const nonTeamChildren = (node.children || []).filter(c => (c.scope_type || c.type) !== 'team');
        const childCount = nonTeamChildren.length;
        let stats = '';
        if (childCount > 0) {
            const childType = scopeType === 'org' || scopeType === 'organization'
                ? pluralise(childCount, 'division', 'divisions')
                : scopeType === 'division'
                ? pluralise(childCount, 'department', 'departments')
                : pluralise(childCount, 'sub-unit', 'sub-units');
            stats = `${childCount} ${childType}`;
        }

        // Root node shows total member count; others show team member count
        if (isRoot && members && members.length > 0) {
            const label = pluralise(members.length, 'member', 'members');
            stats += stats ? ` · ${members.length} ${label}` : `${members.length} ${label}`;
        } else if (team?.member_count) {
            stats += stats ? ` · ${team.member_count} members` : `${team.member_count} members`;
        }

        nodes.push({
            id: node.id,
            type: 'scopeNode',
            data: {
                name: node.name_cache || node.name || 'Unnamed',
                scopeType,
                refId,
                isActive,
                childCount,
                stats: stats || null,
                hasAssistant: true,
                onManage,
                logoUrl: isRoot && (scopeType === 'org' || scopeType === 'organization') ? logoUrl : null,
            },
            position: { x: 0, y: 0 },
        });

        for (const child of (node.children || [])) {
            const childType = child.scope_type || child.type || '';
            if (childType === 'team') continue; // teams aren't separate nodes — parent scope IS the team
            edges.push({
                id: `${node.id}-${child.id}`,
                source: node.id,
                target: child.id,
                type: 'smoothstep',
                style: {
                    stroke: (SCOPE_CONFIG[childType] || SCOPE_CONFIG.department).colour,
                    strokeWidth: 2,
                    opacity: 0.5,
                },
                markerEnd: {
                    type: MarkerType.ArrowClosed,
                    color: 'rgba(255,255,255,0.3)',
                    width: 16,
                    height: 16,
                },
            });
            walk(child);
        }

        // Add owner node above the root
        if (isRoot && owner) {
            const ownerId = `owner-${owner.id}`;
            nodes.push({
                id: ownerId,
                type: 'ownerNode',
                data: {
                    name: owner.name || owner.email || 'Owner',
                    avatar_url: owner.avatar_url,
                },
                position: { x: 0, y: 0 },
            });
            // Owner → root org edge (owner is source, layout places it above)
            edges.push({
                id: `${ownerId}-${node.id}`,
                source: ownerId,
                target: node.id,
                type: 'smoothstep',
                style: { stroke: '#f59e0b', strokeWidth: 1.5, opacity: 0.5 },
                markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(245,158,11,0.4)', width: 14, height: 14 },
            });
        }

        // Add non-owner member nodes under the root scope node
        if (isRoot && nonOwnerMembers.length > 0) {
            const visible = nonOwnerMembers.slice(0, MAX_MEMBER_NODES);

            for (const member of visible) {
                const memberId = `member-${member.id}`;
                nodes.push({
                    id: memberId,
                    type: 'memberNode',
                    data: {
                        name: member.name || member.email || 'Unknown',
                        role: member.role || 'member',
                        avatar_url: member.avatar_url,
                        memberId: member.id,
                    },
                    position: { x: 0, y: 0 },
                });
                edges.push({
                    id: `${node.id}-${memberId}`,
                    source: node.id,
                    target: memberId,
                    type: 'smoothstep',
                    style: { stroke: '#64748b', strokeWidth: 1, opacity: 0.3, strokeDasharray: '4 2' },
                    markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(255,255,255,0.15)', width: 12, height: 12 },
                });
            }

            if (nonOwnerMembers.length > MAX_MEMBER_NODES) {
                const overflowId = 'member-overflow';
                nodes.push({
                    id: overflowId,
                    type: 'memberNode',
                    data: {
                        name: `+${nonOwnerMembers.length - MAX_MEMBER_NODES} more`,
                        role: '',
                        isOverflow: true,
                    },
                    position: { x: 0, y: 0 },
                });
                edges.push({
                    id: `${node.id}-${overflowId}`,
                    source: node.id,
                    target: overflowId,
                    type: 'smoothstep',
                    style: { stroke: '#64748b', strokeWidth: 1, opacity: 0.2 },
                });
            }
        }
    }

    for (const root of roots) walk(root, true);

    return layoutTree(nodes, edges);
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function ScopeOrgChart({
    scopeTree,
    teams = [],
    members = [],
    activeEntityId,
    accentColour,
    logoUrl,
    onNodeClick,
}) {
    const { initialNodes, initialEdges } = useMemo(() => {
        const { nodes, edges } = scopeTreeToFlow(scopeTree, activeEntityId, teams, members, onNodeClick, logoUrl);
        return { initialNodes: nodes, initialEdges: edges };
    }, [scopeTree, activeEntityId, teams, members, onNodeClick, logoUrl]);

    const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

    // Update nodes when data changes
    useEffect(() => {
        setNodes(initialNodes);
        setEdges(initialEdges);
    }, [initialNodes, initialEdges, setNodes, setEdges]);

    const handleNodeClick = useCallback((event, node) => {
        // Don't navigate for member or owner nodes
        if (node.type === 'memberNode' || node.type === 'ownerNode') return;
        if (onNodeClick && node.data.refId) {
            const type = node.data.scopeType;
            const routeType = type === 'organization' ? 'org' : type;
            onNodeClick(routeType, node.data.refId);
        }
    }, [onNodeClick]);

    if (!scopeTree || initialNodes.length === 0) {
        return (
            <div className="scope-org-chart scope-org-chart--empty">
                <span>No hierarchy data available</span>
            </div>
        );
    }

    // Calculate dynamic height based on number of levels
    const levels = new Set(nodes.map(n => n.position?.y || 0));
    const chartHeight = Math.max(300, levels.size * 210 + 80);

    return (
        <div className="scope-org-chart" style={{ height: chartHeight, '--scope-accent': accentColour }}>
            <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={handleNodeClick}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.3 }}
                minZoom={0.4}
                maxZoom={1.5}
                panOnScroll
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable
                proOptions={{ hideAttribution: true }}
            >
                <Background color="rgba(255,255,255,0.03)" gap={20} />
                <Controls
                    showInteractive={false}
                    position="bottom-right"
                    style={{ background: 'rgba(0,0,0,0.6)', borderRadius: 8 }}
                />
            </ReactFlow>
        </div>
    );
}
