/**
 * ScopeFilterCascade — Cascading scope filter dropdowns.
 *
 * Modes:
 *   filter — Full cascade: Org > Division > Department (for view pages)
 *   picker — No org selector, starts from Division (for modals where org is known)
 *
 * Data is sourced from the already-loaded myScopes array — no extra API calls.
 */

import { useState, useEffect, useMemo } from 'react';
import './scope.css';

// Scope type icons
const SCOPE_ICONS = { org: '[]', division: '||', department: '#', team: '@' };

function OrgMiniAvatar({ org, size = 18 }) {
    const [imgError, setImgError] = useState(false);
    const name = org?.name || '';
    const initials = name
        .split(' ')
        .filter(w => w.length > 0)
        .map(w => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase() || 'O';

    return (
        <span className="scope-cascade__org-avatar" style={{ width: size, height: size, minWidth: size }}>
            {org?.logo_url && !imgError ? (
                <img src={org.logo_url} alt={name} onError={() => setImgError(true)} />
            ) : (
                initials
            )}
        </span>
    );
}

export default function ScopeFilterCascade({
    // filter mode props
    orgs = [],
    currentOrg = null,
    onOrgChange,
    // shared props
    scopes = [],
    currentScope = null,
    onScopeChange,
    mode = 'filter',
    placeholder = 'Organisation-wide',
    showOrgLogos = true,
}) {
    // Track intermediate selections for cascade state
    const [selectedDivId, setSelectedDivId] = useState(null);
    const [selectedDeptId, setSelectedDeptId] = useState(null);

    // Derive division/department lists from scopes
    const divisions = useMemo(
        () => scopes
            .filter(s => s.scope_type === 'division')
            .sort((a, b) => (a.name_cache || '').localeCompare(b.name_cache || '')),
        [scopes]
    );

    const departments = useMemo(
        () => {
            if (!selectedDivId) return [];
            // Find the division scope
            const divScope = scopes.find(s => s.id === selectedDivId);
            if (!divScope) return [];
            // Get departments whose parent_scope_id matches the division scope
            return scopes
                .filter(s => s.scope_type === 'department' && s.parent_scope_id === divScope.id)
                .sort((a, b) => (a.name_cache || '').localeCompare(b.name_cache || ''));
        },
        [scopes, selectedDivId]
    );

    const teams = useMemo(
        () => {
            const parentId = selectedDeptId || selectedDivId;
            if (!parentId) return [];
            return scopes
                .filter(s => s.scope_type === 'team' && s.parent_scope_id === parentId)
                .sort((a, b) => (a.name_cache || '').localeCompare(b.name_cache || ''));
        },
        [scopes, selectedDivId, selectedDeptId]
    );

    // Sync cascade state from external currentScope
    useEffect(() => {
        if (!currentScope) {
            setSelectedDivId(null);
            setSelectedDeptId(null);
            return;
        }

        if (currentScope.scope_type === 'division') {
            setSelectedDivId(currentScope.id);
            setSelectedDeptId(null);
        } else if (currentScope.scope_type === 'department') {
            setSelectedDeptId(currentScope.id);
            // Find parent division
            const parentDiv = scopes.find(s => s.id === currentScope.parent_scope_id);
            setSelectedDivId(parentDiv?.id || null);
        } else if (currentScope.scope_type === 'team') {
            // Walk up
            const parentDept = scopes.find(s => s.id === currentScope.parent_scope_id);
            if (parentDept?.scope_type === 'department') {
                setSelectedDeptId(parentDept.id);
                const parentDiv = scopes.find(s => s.id === parentDept.parent_scope_id);
                setSelectedDivId(parentDiv?.id || null);
            } else if (parentDept?.scope_type === 'division') {
                setSelectedDivId(parentDept.id);
                setSelectedDeptId(null);
            }
        } else {
            // org-level or unknown
            setSelectedDivId(null);
            setSelectedDeptId(null);
        }
    }, [currentScope?.id, scopes]);

    const handleOrgChange = (e) => {
        const orgId = e.target.value;
        if (!orgId) return;
        const org = orgs.find(o => o.id === orgId);
        if (org && onOrgChange) {
            onOrgChange(org);
            // Reset cascade
            setSelectedDivId(null);
            setSelectedDeptId(null);
            if (onScopeChange) onScopeChange(null);
        }
    };

    const handleDivisionChange = (e) => {
        const scopeId = e.target.value;
        setSelectedDeptId(null);
        if (!scopeId) {
            setSelectedDivId(null);
            if (onScopeChange) onScopeChange(null);
        } else {
            setSelectedDivId(scopeId);
            const scope = scopes.find(s => s.id === scopeId);
            if (scope && onScopeChange) onScopeChange(scope);
        }
    };

    const handleDeptChange = (e) => {
        const scopeId = e.target.value;
        if (!scopeId) {
            setSelectedDeptId(null);
            // Revert to division level
            const divScope = scopes.find(s => s.id === selectedDivId);
            if (divScope && onScopeChange) onScopeChange(divScope);
        } else {
            setSelectedDeptId(scopeId);
            const scope = scopes.find(s => s.id === scopeId);
            if (scope && onScopeChange) onScopeChange(scope);
        }
    };

    const handleClear = () => {
        setSelectedDivId(null);
        setSelectedDeptId(null);
        if (onScopeChange) onScopeChange(null);
    };

    const hasSelection = selectedDivId || selectedDeptId;

    return (
        <div className="scope-cascade">
            {/* Level 1: Org (filter mode only) */}
            {mode === 'filter' && orgs.length > 0 && (
                <>
                    <div className="scope-cascade__level">
                        <span className="scope-cascade__label">Organisation:</span>
                        <select
                            className="scope-cascade__select"
                            value={currentOrg?.id || ''}
                            onChange={handleOrgChange}
                        >
                            {!currentOrg && <option value="">Select org...</option>}
                            {orgs.map(o => (
                                <option key={o.id} value={o.id}>
                                    {o.name}
                                </option>
                            ))}
                        </select>
                    </div>
                    {divisions.length > 0 && (
                        <span className="scope-cascade__sep">&rsaquo;</span>
                    )}
                </>
            )}

            {/* Level 2: Division */}
            {divisions.length > 0 && (
                <>
                    <div className={`scope-cascade__level ${currentOrg || mode === 'picker' ? '' : 'scope-cascade__level--hidden'}`}>
                        <span className="scope-cascade__label">Division:</span>
                        <select
                            className="scope-cascade__select"
                            value={selectedDivId || ''}
                            onChange={handleDivisionChange}
                        >
                            <option value="">
                                {mode === 'picker' ? placeholder : 'All Divisions'}
                            </option>
                            {divisions.map(s => (
                                <option key={s.id} value={s.id}>
                                    {SCOPE_ICONS.division} {s.name_cache || s.name}
                                </option>
                            ))}
                        </select>
                    </div>
                    {selectedDivId && departments.length > 0 && (
                        <span className="scope-cascade__sep">&rsaquo;</span>
                    )}
                </>
            )}

            {/* Level 3: Department */}
            {selectedDivId && departments.length > 0 && (
                <div className="scope-cascade__level">
                    <span className="scope-cascade__label">Department:</span>
                    <select
                        className="scope-cascade__select"
                        value={selectedDeptId || ''}
                        onChange={handleDeptChange}
                    >
                        <option value="">All Departments</option>
                        {departments.map(s => (
                            <option key={s.id} value={s.id}>
                                {SCOPE_ICONS.department} {s.name_cache || s.name}
                            </option>
                        ))}
                    </select>
                </div>
            )}

            {/* No divisions available — show simple message */}
            {divisions.length === 0 && mode === 'picker' && (
                <div className="scope-cascade__level">
                    <select className="scope-cascade__select" disabled>
                        <option>{placeholder}</option>
                    </select>
                </div>
            )}

            {/* Clear button */}
            {hasSelection && (
                <button
                    className="scope-cascade__clear"
                    onClick={handleClear}
                    title="Clear scope filter"
                    type="button"
                >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                </button>
            )}
        </div>
    );
}
