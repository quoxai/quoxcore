/**
 * Scope Picker Component
 * Dropdown for selecting the current scope/lens
 */

import { useState, useRef, useEffect } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import './workspace.css';

function ScopeIcon({ type }) {
    const icons = {
        org: '[]',
        division: '||',
        department: '#',
        team: '@'
    };
    return <span className="scope-icon">{icons[type] || '?'}</span>;
}

function ScopeTreeItem({ scope, level = 0, onSelect, currentScopeId }) {
    const [expanded, setExpanded] = useState(level < 2);
    const hasChildren = scope.children?.length > 0;
    const isSelected = scope.id === currentScopeId;

    return (
        <div className="scope-tree-item">
            <div
                className={`scope-tree-row ${isSelected ? 'selected' : ''}`}
                style={{ paddingLeft: `${level * 16 + 8}px` }}
                onClick={() => onSelect(scope)}
            >
                {hasChildren && (
                    <button
                        className="scope-expand-btn"
                        onClick={(e) => {
                            e.stopPropagation();
                            setExpanded(!expanded);
                        }}
                    >
                        {expanded ? '-' : '+'}
                    </button>
                )}
                <ScopeIcon type={scope.scope_type} />
                <span className="scope-name">{scope.name_cache}</span>
            </div>
            {hasChildren && expanded && (
                <div className="scope-tree-children">
                    {scope.children.map(child => (
                        <ScopeTreeItem
                            key={child.id}
                            scope={child}
                            level={level + 1}
                            onSelect={onSelect}
                            currentScopeId={currentScopeId}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export default function ScopePicker() {
    const { currentScope, scopeTree, selectScope, currentOrg } = useWorkspace();
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef(null);

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleSelect = (scope) => {
        selectScope(scope);
        setIsOpen(false);
    };

    const handleClear = () => {
        // Reset to org root — views treat scope_type 'org' as "show all"
        if (scopeTree) {
            selectScope(scopeTree);
        } else {
            selectScope(null);
        }
        setIsOpen(false);
    };

    if (!currentOrg) {
        return (
            <div className="scope-picker disabled">
                <span className="scope-picker-label">Select an organization first</span>
            </div>
        );
    }

    return (
        <div className="scope-picker" ref={dropdownRef}>
            <button
                className="scope-picker-trigger"
                onClick={() => setIsOpen(!isOpen)}
            >
                <div className="scope-picker-current">
                    {currentScope ? (
                        <>
                            <ScopeIcon type={currentScope.scope_type} />
                            <span className="scope-name">{currentScope.name_cache || currentScope.name}</span>
                        </>
                    ) : (
                        <span className="scope-placeholder">All (entire org)</span>
                    )}
                </div>
                {currentScope && currentScope.scope_type !== 'org' && (
                    <button
                        className="scope-picker-clear"
                        onClick={(e) => { e.stopPropagation(); handleClear(); }}
                        title="Clear scope filter"
                        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0 4px', fontSize: '0.9rem' }}
                    >
                        &times;
                    </button>
                )}
                <span className="scope-picker-arrow">{isOpen ? '^' : 'v'}</span>
            </button>

            {isOpen && (
                <div className="scope-picker-dropdown">
                    <div className="scope-picker-header">
                        <span>SCOPE LENS</span>
                    </div>
                    <div className="scope-picker-tree">
                        {scopeTree ? (
                            <ScopeTreeItem
                                scope={scopeTree}
                                onSelect={handleSelect}
                                currentScopeId={currentScope?.id}
                            />
                        ) : (
                            <div className="scope-picker-empty">No scopes available</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
