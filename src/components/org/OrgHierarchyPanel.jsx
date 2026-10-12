/**
 * OrgHierarchyPanel — navigable scope tree (org → div → dept → team).
 *
 * Consumes `scopeTree` from useScopeData (nested nodes with
 * scope_type, ref_id, name_cache, children[]). Click any node to
 * navigate to its scope page. Current entity is highlighted.
 *
 * Inspired by the glass-concept OrgFullPage tree column.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const TYPE_COLOURS = {
    org:          '#a78bfa',
    organization: '#a78bfa',
    division:     '#3b82f6',
    department:   '#06b6d4',
    team:         '#22c55e',
};

const TYPE_ROUTES = {
    org:          'orgs',
    organization: 'orgs',
    division:     'divisions',
    department:   'departments',
    team:         'teams',
};

const Chevron = () => (
    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.25">
        <polyline points="9 18 15 12 9 6" />
    </svg>
);

// Build a stable id for expand/collapse state.
function nodeKey(node) {
    return node?.id || node?.ref_id || node?.name_cache || String(Math.random());
}

// Find path from root to node with matching ref_id, returning array of keys
function findPath(node, targetRefId, trail = []) {
    if (!node) return null;
    const key = nodeKey(node);
    const here = [...trail, key];
    if (node.ref_id === targetRefId) return here;
    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            const hit = findPath(child, targetRefId, here);
            if (hit) return hit;
        }
    }
    return null;
}

export default function OrgHierarchyPanel({ scopeTree, activeEntityId }) {
    const navigate = useNavigate();

    // Expand every node by default so the user sees the whole tree
    // on first render. They can collapse nodes if they want. Re-runs
    // whenever the tree changes so new divisions/teams show up
    // already expanded.
    const [expanded, setExpanded] = useState({});

    useEffect(() => {
        if (!scopeTree) return;
        const map = {};
        const walk = (node) => {
            if (!node) return;
            map[nodeKey(node)] = true;
            if (Array.isArray(node.children)) node.children.forEach(walk);
        };
        walk(scopeTree);
        setExpanded(map);
    }, [scopeTree]);

    if (!scopeTree) {
        return (
            <section className="org-hierarchy-panel">
                <HierarchyHead />
                <div className="org-hierarchy-panel__empty">Loading hierarchy…</div>
            </section>
        );
    }

    // getScopeTree returns EITHER a single root node (org) OR a synthetic
    // wrapper `{ children: [...] }` when multiple scopes have no parent.
    // Detect both and render whichever roots we have.
    const isSyntheticRoot = !scopeTree.scope_type && !scopeTree.name_cache;
    const roots = isSyntheticRoot
        ? (Array.isArray(scopeTree.children) ? scopeTree.children : [])
        : [scopeTree];

    const toggle = (key) => {
        setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const handleClick = (node) => {
        const type = (node.scope_type || node.type || '').toLowerCase();
        const path = TYPE_ROUTES[type];
        const ref = node.ref_id || node.id;
        if (path && ref) navigate(`/${path}/${ref}`);
    };

    return (
        <section className="org-hierarchy-panel">
            <HierarchyHead />
            <div className="org-hierarchy-panel__tree" role="tree">
                {roots.length > 0 ? (
                    roots.map(root => (
                        <TreeNode
                            key={nodeKey(root)}
                            node={root}
                            depth={0}
                            expanded={expanded}
                            toggle={toggle}
                            activeEntityId={activeEntityId}
                            onClick={handleClick}
                        />
                    ))
                ) : (
                    <div className="org-hierarchy-panel__empty">No scope data available.</div>
                )}
            </div>
        </section>
    );
}

function HierarchyHead() {
    return (
        <div className="org-hierarchy-panel__head">
            <h4 className="org-hierarchy-panel__title">Hierarchy</h4>
            <HierarchyLegend />
        </div>
    );
}

function HierarchyLegend() {
    return (
        <div className="org-hierarchy-panel__legend" aria-hidden="true">
            {['org', 'division', 'department', 'team'].map(t => (
                <span key={t} className="org-hierarchy-panel__legend-item">
                    <span className="org-hierarchy-panel__dot" style={{ background: TYPE_COLOURS[t] }} />
                    <span>{t[0].toUpperCase() + t.slice(1)}</span>
                </span>
            ))}
        </div>
    );
}

function TreeNode({ node, depth, expanded, toggle, activeEntityId, onClick }) {
    const key = nodeKey(node);
    const type = (node.scope_type || node.type || 'org').toLowerCase();
    const colour = TYPE_COLOURS[type] || '#fff';
    const children = Array.isArray(node.children) ? node.children : [];
    const hasChildren = children.length > 0;
    const isOpen = !!expanded[key];
    const isActive = node.ref_id === activeEntityId;
    const name = node.name_cache || node.name || '(unnamed)';

    const handleRowClick = (e) => {
        if (e.target.closest('.org-hierarchy-panel__chev')) return;
        onClick(node);
    };

    return (
        <div className="org-hierarchy-panel__node" role="treeitem" aria-expanded={hasChildren ? isOpen : undefined}>
            <div
                className={`org-hierarchy-panel__row${isActive ? ' org-hierarchy-panel__row--active' : ''}`}
                style={{
                    paddingLeft: 8 + depth * 14,
                    '--node-colour': colour,
                }}
                onClick={handleRowClick}
            >
                {hasChildren ? (
                    <button
                        type="button"
                        className={`org-hierarchy-panel__chev${isOpen ? ' org-hierarchy-panel__chev--open' : ''}`}
                        onClick={(e) => { e.stopPropagation(); toggle(key); }}
                        aria-label={isOpen ? 'Collapse' : 'Expand'}
                    >
                        <Chevron />
                    </button>
                ) : (
                    <span className="org-hierarchy-panel__chev org-hierarchy-panel__chev--spacer" aria-hidden="true" />
                )}
                <span className="org-hierarchy-panel__dot" style={{ background: colour }} />
                <span className="org-hierarchy-panel__name" title={name}>{name}</span>
                {hasChildren && (
                    <span className="org-hierarchy-panel__count">{children.length}</span>
                )}
            </div>
            {isOpen && hasChildren && (
                <div className="org-hierarchy-panel__children" role="group">
                    {children.map(child => (
                        <TreeNode
                            key={nodeKey(child)}
                            node={child}
                            depth={depth + 1}
                            expanded={expanded}
                            toggle={toggle}
                            activeEntityId={activeEntityId}
                            onClick={onClick}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
