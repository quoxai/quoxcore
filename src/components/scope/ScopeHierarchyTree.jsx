/**
 * ScopeHierarchyTree — CSS-based clickable org hierarchy tree.
 *
 * Recursive tree rendering with connectors. Active node highlighted.
 * Click any node to navigate to its management page.
 */

import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import './ScopeDashboard.css';

// Scope type → route prefix mapping
const SCOPE_ROUTES = {
    organization: '/orgs',
    division:     '/divisions',
    department:   '/departments',
    team:         '/teams',
};

// Scope type → accent colour
const SCOPE_NODE_COLOURS = {
    organization: '#38bdf8',
    division:     '#a78bfa',
    department:   '#3b82f6',
    team:         '#22c55e',
};

// Icons per scope type
const SCOPE_NODE_ICONS = {
    organization: '[]',
    division:     '||',
    department:   '#',
    team:         '@',
};

/**
 * Build a tree structure from a flat scopes array.
 * Each scope has: { id, ref_id, scope_type, name_cache, parent_scope_id }
 */
function buildTree(scopes) {
    if (!scopes || !Array.isArray(scopes)) return [];

    const byId = new Map();
    const roots = [];

    // First pass: create map
    for (const s of scopes) {
        byId.set(s.id, {
            id: s.id,
            refId: s.ref_id,
            type: s.scope_type,
            name: s.name_cache || s.name || 'Unnamed',
            parentId: s.parent_scope_id,
            children: [],
        });
    }

    // Second pass: wire children
    for (const node of byId.values()) {
        if (node.parentId && byId.has(node.parentId)) {
            byId.get(node.parentId).children.push(node);
        } else {
            roots.push(node);
        }
    }

    return roots;
}

/**
 * If scopeTree is already a nested object (tree.children format),
 * flatten it for our TreeNode renderer.
 */
function normaliseTree(scopeTree) {
    if (!scopeTree) return [];

    // If it's an array of flat scopes
    if (Array.isArray(scopeTree)) {
        return buildTree(scopeTree);
    }

    // If it's already a tree object with children
    if (scopeTree.id) {
        return [normaliseNode(scopeTree)];
    }

    return [];
}

function normaliseNode(node) {
    return {
        id: node.id,
        refId: node.ref_id,
        type: node.scope_type || node.type,
        name: node.name_cache || node.name || 'Unnamed',
        parentId: node.parent_scope_id,
        children: (node.children || []).map(normaliseNode),
    };
}

function TreeNode({ node, activeRefId, depth = 0, collapsed, onToggle }) {
    const navigate = useNavigate();
    const isActive = node.refId === activeRefId;
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed[node.id];
    const colour = SCOPE_NODE_COLOURS[node.type] || '#888';
    const icon = SCOPE_NODE_ICONS[node.type] || '';
    const route = SCOPE_ROUTES[node.type];

    const handleClick = (e) => {
        e.stopPropagation();
        if (route && node.refId) {
            navigate(`${route}/${node.refId}`);
        }
    };

    const handleToggle = (e) => {
        e.stopPropagation();
        onToggle(node.id);
    };

    return (
        <li className="scope-tree__item">
            <div
                className={`scope-tree__node ${isActive ? 'scope-tree__node--active' : ''}`}
                style={{ '--node-colour': colour }}
                onClick={handleClick}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && handleClick(e)}
            >
                <span className="scope-tree__node-icon">{icon}</span>
                <span className="scope-tree__node-name">{node.name}</span>
                {isActive && <span className="scope-tree__node-marker" title="You are here" />}
                {hasChildren && (
                    <button
                        className={`scope-tree__toggle ${isCollapsed ? 'scope-tree__toggle--collapsed' : ''}`}
                        onClick={handleToggle}
                        aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                    >
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 2L7 5L3 8"/>
                        </svg>
                    </button>
                )}
            </div>
            {hasChildren && !isCollapsed && (
                <ul className="scope-tree__children">
                    {node.children.map(child => (
                        <TreeNode
                            key={child.id}
                            node={child}
                            activeRefId={activeRefId}
                            depth={depth + 1}
                            collapsed={collapsed}
                            onToggle={onToggle}
                        />
                    ))}
                </ul>
            )}
        </li>
    );
}

export default function ScopeHierarchyTree({ scopeTree, activeEntityId }) {
    const [collapsed, setCollapsed] = useState({});

    const roots = useMemo(() => normaliseTree(scopeTree), [scopeTree]);

    const handleToggle = (nodeId) => {
        setCollapsed(prev => ({ ...prev, [nodeId]: !prev[nodeId] }));
    };

    if (roots.length === 0) {
        return (
            <div className="scope-tree scope-tree--empty">
                <span className="scope-tree__empty-text">No hierarchy data available</span>
            </div>
        );
    }

    return (
        <div className="scope-tree">
            <ul className="scope-tree__root">
                {roots.map(root => (
                    <TreeNode
                        key={root.id}
                        node={root}
                        activeRefId={activeEntityId}
                        collapsed={collapsed}
                        onToggle={handleToggle}
                    />
                ))}
            </ul>
        </div>
    );
}
