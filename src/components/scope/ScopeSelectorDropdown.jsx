/**
 * ScopeSelectorDropdown — Compact scope picker for the Command sidebar.
 *
 * Lets users choose an org → division → department scope context so the
 * chat assistant has awareness of which scope the user is operating in.
 * Uses WorkspaceContext to enumerate available scopes.
 */

import { useState, useEffect, useCallback } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';

const CloseIcon = () => (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
);

const ScopeIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="6" />
        <circle cx="12" cy="12" r="2" />
    </svg>
);

/**
 * @param {Object} props
 * @param {Function} props.onScopeChange - Callback with { orgId, divisionId, departmentId, label }
 * @param {Object} props.selectedScope - Currently selected scope { orgId, divisionId, departmentId }
 */
export default function ScopeSelectorDropdown({ onScopeChange, selectedScope }) {
    const { orgs, getDivisions, currentOrg } = useWorkspace();
    const { authFetch } = useAuth();

    const [divisions, setDivisions] = useState([]);
    const [departments, setDepartments] = useState([]);
    const [loadingDivs, setLoadingDivs] = useState(false);
    const [loadingDepts, setLoadingDepts] = useState(false);

    // Selected values
    const [selOrg, setSelOrg] = useState(selectedScope?.orgId || '');
    const [selDiv, setSelDiv] = useState(selectedScope?.divisionId || '');
    const [selDept, setSelDept] = useState(selectedScope?.departmentId || '');

    // Load divisions when org changes
    useEffect(() => {
        if (!selOrg) {
            setDivisions([]);
            setSelDiv('');
            setDepartments([]);
            setSelDept('');
            return;
        }
        let cancelled = false;
        setLoadingDivs(true);
        (async () => {
            try {
                const divs = getDivisions ? await getDivisions(selOrg) : [];
                if (!cancelled) setDivisions(divs || []);
            } catch {
                if (!cancelled) setDivisions([]);
            }
            if (!cancelled) setLoadingDivs(false);
        })();
        return () => { cancelled = true; };
    }, [selOrg, getDivisions]);

    // Load departments when division changes
    useEffect(() => {
        if (!selOrg || !selDiv) {
            setDepartments([]);
            setSelDept('');
            return;
        }
        let cancelled = false;
        setLoadingDepts(true);
        (async () => {
            try {
                const res = await authFetch(`/api/orgs/${selOrg}/divisions/${selDiv}/departments?includeStats=true`);
                if (res.ok) {
                    const data = await res.json();
                    if (!cancelled) setDepartments(data.departments || []);
                } else {
                    if (!cancelled) setDepartments([]);
                }
            } catch {
                if (!cancelled) setDepartments([]);
            }
            if (!cancelled) setLoadingDepts(false);
        })();
        return () => { cancelled = true; };
    }, [selOrg, selDiv, authFetch]);

    // Build label and notify parent on change
    const emitChange = useCallback((orgId, divId, deptId) => {
        if (!onScopeChange) return;

        const org = orgs.find(o => o.id === orgId);
        const div = divisions.find(d => d.id === divId);
        const dept = departments.find(d => d.id === deptId);

        const parts = [org?.name, div?.name, dept?.name].filter(Boolean);
        const label = parts.join(' > ') || null;

        onScopeChange({
            orgId: orgId || null,
            divisionId: divId || null,
            departmentId: deptId || null,
            orgName: org?.name || null,
            divisionName: div?.name || null,
            departmentName: dept?.name || null,
            label,
        });
    }, [onScopeChange, orgs, divisions, departments]);

    const handleOrgChange = (e) => {
        const val = e.target.value;
        setSelOrg(val);
        setSelDiv('');
        setSelDept('');
        emitChange(val, '', '');
    };

    const handleDivChange = (e) => {
        const val = e.target.value;
        setSelDiv(val);
        setSelDept('');
        emitChange(selOrg, val, '');
    };

    const handleDeptChange = (e) => {
        const val = e.target.value;
        setSelDept(val);
        emitChange(selOrg, selDiv, val);
    };

    const handleClear = () => {
        setSelOrg('');
        setSelDiv('');
        setSelDept('');
        emitChange('', '', '');
    };

    const hasSelection = selOrg || selDiv || selDept;

    return (
        <div className="scope-selector">
            <div className="scope-selector__header">
                <span className="scope-selector__icon"><ScopeIcon /></span>
                <span className="scope-selector__label">Scope Context</span>
                {hasSelection && (
                    <button
                        className="scope-selector__clear"
                        onClick={handleClear}
                        title="Clear scope"
                    >
                        <CloseIcon />
                    </button>
                )}
            </div>

            <div className="scope-selector__dropdowns">
                {/* Org selector */}
                <select
                    className="scope-selector__select"
                    value={selOrg}
                    onChange={handleOrgChange}
                >
                    <option value="">No org scope</option>
                    {orgs.map(org => (
                        <option key={org.id} value={org.id}>{org.name}</option>
                    ))}
                </select>

                {/* Division selector (only if org selected) */}
                {selOrg && (
                    <select
                        className="scope-selector__select"
                        value={selDiv}
                        onChange={handleDivChange}
                        disabled={loadingDivs}
                    >
                        <option value="">
                            {loadingDivs ? 'Loading...' : 'All divisions'}
                        </option>
                        {divisions.map(div => (
                            <option key={div.id} value={div.id}>{div.name}</option>
                        ))}
                    </select>
                )}

                {/* Department selector (only if division selected) */}
                {selDiv && (
                    <select
                        className="scope-selector__select"
                        value={selDept}
                        onChange={handleDeptChange}
                        disabled={loadingDepts}
                    >
                        <option value="">
                            {loadingDepts ? 'Loading...' : 'All departments'}
                        </option>
                        {departments.map(dept => (
                            <option key={dept.id} value={dept.id}>{dept.name}</option>
                        ))}
                    </select>
                )}
            </div>
        </div>
    );
}
