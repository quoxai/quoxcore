/**
 * HeaderScopeSelector — Netflix-profile-style org switcher for the app header.
 *
 * A chunky, frameless org logo is the trigger. Clicking it expands an inline
 * strip of every org's logo (staggered pop-in); clicking a logo switches org.
 * The active org's name renders as a bare title next to the logo. A light
 * text chip after the title opens the division/department scope menu.
 *
 * Writes through WorkspaceContext.selectScope / selectOrg so the rest of the
 * app sees the change, same contract as the previous pill implementation.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import './header-scope-selector.css';

const ChevronIcon = ({ size = 10 }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.5">
        <polyline points="6 9 12 15 18 9" />
    </svg>
);

const CheckIcon = ({ size = 10 }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="3">
        <polyline points="20 6 9 17 4 12" />
    </svg>
);

const ClearIcon = ({ size = 9 }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.5">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
);

const LayersIcon = ({ size = 11 }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
    </svg>
);

// Deterministic colour from the org id/name so initial-tiles are stable.
function orgHue(seed = '') {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
    return h;
}

/** Chunky square org tile: logo image when set, gradient initial otherwise. */
function OrgTile({ org, size = 34 }) {
    const label = org?.name || 'Org';
    const [imgFailed, setImgFailed] = useState(false);
    if (org?.logo_url && !imgFailed) {
        return (
            <span className="header-scope__tile" style={{ width: size, height: size }}>
                <img src={org.logo_url} alt="" onError={() => setImgFailed(true)} />
            </span>
        );
    }
    const hue = orgHue(org?.id || label);
    return (
        <span
            className="header-scope__tile header-scope__tile--initial"
            style={{
                width: size, height: size, fontSize: Math.round(size * 0.5),
                background: `linear-gradient(135deg, hsl(${hue} 70% 48%), hsl(${(hue + 45) % 360} 70% 36%))`,
            }}
        >
            {label.charAt(0).toUpperCase()}
        </span>
    );
}

export default function HeaderScopeSelector() {
    const { orgs, currentOrg, currentScope, selectScope, selectOrg, getDivisions } = useWorkspace();
    const { authFetch } = useAuth();

    const [stripOpen, setStripOpen] = useState(false);
    const [stripPos, setStripPos] = useState({ top: 0, left: 0 });
    const [hoverOrg, setHoverOrg] = useState(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

    const [divisions, setDivisions] = useState([]);
    const [loadingDivs, setLoadingDivs] = useState(false);
    const [expandedDiv, setExpandedDiv] = useState('');
    const [deptsByDiv, setDeptsByDiv] = useState({});
    const [loadingDeptsFor, setLoadingDeptsFor] = useState('');

    const rootRef = useRef(null);
    const chipRef = useRef(null);
    const orgBtnRef = useRef(null);

    const activeOrgId = currentScope?.org_id
        || (currentScope?.type === 'organization' ? currentScope?.id : '')
        || currentOrg?.id
        || '';
    const displayOrg = useMemo(
        () => orgs.find(o => o.id === activeOrgId) || currentOrg || null,
        [orgs, activeOrgId, currentOrg]
    );

    /* ── close-on-outside / Escape (covers strip + portal menu) ───────── */
    useEffect(() => {
        if (!stripOpen && !menuOpen) return;
        const onDown = (e) => {
            if (rootRef.current?.contains(e.target)) return;
            if (e.target.closest?.('.header-scope__menu')) return;
            if (e.target.closest?.('.header-scope__strip')) return;
            setStripOpen(false);
            setMenuOpen(false);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') {
                setStripOpen(false);
                setMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [stripOpen, menuOpen]);

    /* ── keep the portal menu glued to the chip on scroll/resize ──────── */
    useEffect(() => {
        if (!menuOpen) return;
        const recalc = () => {
            if (chipRef.current) {
                const rect = chipRef.current.getBoundingClientRect();
                setMenuPos({ top: rect.bottom + 10, left: rect.left });
            }
        };
        recalc();
        window.addEventListener('resize', recalc);
        window.addEventListener('scroll', recalc, true);
        return () => {
            window.removeEventListener('resize', recalc);
            window.removeEventListener('scroll', recalc, true);
        };
    }, [menuOpen]);

    /* ── keep the portal strip anchored over the trigger tile ─────────── */
    useEffect(() => {
        if (!stripOpen) return;
        const recalc = () => {
            if (orgBtnRef.current) {
                const rect = orgBtnRef.current.getBoundingClientRect();
                setStripPos({ top: rect.top + rect.height / 2, left: rect.left - 7 });
            }
        };
        recalc();
        window.addEventListener('resize', recalc);
        window.addEventListener('scroll', recalc, true);
        return () => {
            window.removeEventListener('resize', recalc);
            window.removeEventListener('scroll', recalc, true);
        };
    }, [stripOpen]);

    /* ── load divisions when the scope menu opens ─────────────────────── */
    useEffect(() => {
        if (!menuOpen || !activeOrgId || !getDivisions) return;
        let cancelled = false;
        setLoadingDivs(true);
        (async () => {
            try {
                const divs = await getDivisions(activeOrgId);
                if (!cancelled) setDivisions(divs || []);
            } catch {
                if (!cancelled) setDivisions([]);
            }
            if (!cancelled) setLoadingDivs(false);
        })();
        return () => { cancelled = true; };
    }, [menuOpen, activeOrgId, getDivisions]);

    /* ── lazy-load departments when a division row is expanded ────────── */
    const toggleDeptExpand = useCallback(async (divId) => {
        setExpandedDiv(prev => (prev === divId ? '' : divId));
        if (deptsByDiv[divId] || !activeOrgId) return;
        setLoadingDeptsFor(divId);
        try {
            const res = await authFetch(`/api/orgs/${activeOrgId}/divisions/${divId}/departments?includeStats=true`);
            if (res.ok) {
                const data = await res.json();
                setDeptsByDiv(prev => ({ ...prev, [divId]: data.departments || [] }));
            } else {
                setDeptsByDiv(prev => ({ ...prev, [divId]: [] }));
            }
        } catch {
            setDeptsByDiv(prev => ({ ...prev, [divId]: [] }));
        }
        setLoadingDeptsFor('');
    }, [deptsByDiv, activeOrgId, authFetch]);

    /* ── scope writers (org switch must land BEFORE the scope write — the
          rest of the app reads currentOrg.id directly; divergent state
          breaks views like QuoxChat) ────────────────────────────────────── */
    const switchOrgContext = useCallback(async (org) => {
        if (org && currentOrg && org.id !== currentOrg.id && typeof selectOrg === 'function') {
            try {
                await selectOrg(org);
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn('[HeaderScopeSelector] selectOrg failed; scope still applied', err);
            }
        }
    }, [currentOrg, selectOrg]);

    const pickOrg = useCallback(async (org) => {
        setStripOpen(false);
        setHoverOrg(null);
        if (!org) return;
        await switchOrgContext(org);
        selectScope({ id: org.id, name: org.name, type: 'organization', org_id: org.id });
    }, [switchOrgContext, selectScope]);

    const pickWholeOrg = useCallback(() => {
        setMenuOpen(false);
        if (!displayOrg) return;
        selectScope({ id: displayOrg.id, name: displayOrg.name, type: 'organization', org_id: displayOrg.id });
    }, [displayOrg, selectScope]);

    const pickDivision = useCallback((div) => {
        setMenuOpen(false);
        selectScope({ id: div.id, name: div.name, type: 'division', org_id: activeOrgId });
    }, [selectScope, activeOrgId]);

    const pickDepartment = useCallback((dept, divId) => {
        setMenuOpen(false);
        selectScope({ id: dept.id, name: dept.name, type: 'department', org_id: activeOrgId, division_id: divId });
    }, [selectScope, activeOrgId]);

    const clearScope = useCallback(() => {
        setMenuOpen(false);
        selectScope(null);
    }, [selectScope]);

    const openMenu = useCallback(() => {
        setStripOpen(false);
        setExpandedDiv('');
        setMenuOpen(v => !v);
    }, []);

    const toggleStrip = useCallback(() => {
        setMenuOpen(false);
        setHoverOrg(null);
        setStripOpen(v => !v);
    }, []);

    if (!orgs.length && !currentOrg) return null;

    const subScoped = currentScope?.type === 'division' || currentScope?.type === 'department';
    const chipLabel = subScoped
        ? currentScope.name
        : (currentScope ? 'All divisions' : 'Set scope');
    const titleText = displayOrg?.name || 'Select org';

    return (
        <div className={`header-scope${stripOpen ? ' header-scope--open' : ''}`} ref={rootRef}>
            {/* ── Trigger: bare chunky logo. Always mounted
                  so the header row NEVER reflows; the strip overlays it. ── */}
            <button
                ref={orgBtnRef}
                type="button"
                className="header-scope__org-btn"
                onClick={toggleStrip}
                aria-expanded={stripOpen}
                aria-haspopup="listbox"
                aria-label={displayOrg ? `Switch organisation (current: ${displayOrg.name})` : 'Choose organisation'}
                title={displayOrg ? `Organisation: ${displayOrg.name}` : 'Choose organisation'}
            >
                <OrgTile org={displayOrg} size={40} />
            </button>

            {/* ── Netflix strip: portal overlay anchored on the trigger, so
                  opening it shifts NOTHING in the header ─────────────────── */}
            {stripOpen && createPortal(
                <div
                    className="header-scope__strip"
                    role="listbox"
                    aria-label="Switch organisation"
                    style={{ top: stripPos.top, left: stripPos.left }}
                >
                    {orgs.map((org, i) => (
                        <button
                            key={org.id}
                            type="button"
                            role="option"
                            aria-selected={org.id === activeOrgId}
                            className={`header-scope__strip-item${org.id === activeOrgId ? ' is-current' : ''}`}
                            style={{ '--i': i }}
                            onClick={() => pickOrg(org)}
                            onMouseEnter={() => setHoverOrg(org)}
                            onMouseLeave={() => setHoverOrg(h => (h?.id === org.id ? null : h))}
                            onFocus={() => setHoverOrg(org)}
                            title={org.name}
                        >
                            <OrgTile org={org} size={34} />
                            {org.id === activeOrgId && (
                                <span className="header-scope__check" aria-hidden="true"><CheckIcon /></span>
                            )}
                        </button>
                    ))}
                    <span
                        className={`header-scope__strip-name${hoverOrg && hoverOrg.id !== activeOrgId ? ' is-preview' : ''}`}
                        key={hoverOrg?.name || titleText}
                    >
                        {hoverOrg?.name || titleText}
                    </span>
                </div>,
                document.body
            )}

            {/* ── Org name as a bare title (fades while the strip is open) ── */}
            <span key={titleText} className="header-scope__title">
                {titleText}
            </span>

            {/* ── Division / department scope chip ──────────────────────── */}
            {activeOrgId && (
                <button
                    ref={chipRef}
                    type="button"
                    className={`header-scope__chip${subScoped ? ' header-scope__chip--active' : ''}${menuOpen ? ' header-scope__chip--open' : ''}`}
                    onClick={openMenu}
                    aria-expanded={menuOpen}
                    aria-haspopup="true"
                    title={subScoped ? `Scope: ${currentScope.name}` : 'Filter by division or department'}
                >
                    <LayersIcon />
                    <span className="header-scope__chip-label">{chipLabel}</span>
                    {subScoped && (
                        <span
                            role="button"
                            tabIndex={-1}
                            className="header-scope__chip-x"
                            onClick={(e) => { e.stopPropagation(); pickWholeOrg(); }}
                            title="Back to whole organisation"
                            aria-label="Back to whole organisation"
                        >
                            <ClearIcon />
                        </span>
                    )}
                    <span className="header-scope__chip-chevron" aria-hidden="true"><ChevronIcon size={12} /></span>
                </button>
            )}

            {/* ── Scope menu (portal so the header's overflow can't clip it) ── */}
            {menuOpen && createPortal(
                <div
                    className="header-scope__menu"
                    role="dialog"
                    aria-label="Scope menu"
                    style={{ top: menuPos.top, left: menuPos.left }}
                >
                    <div className="header-scope__menu-head">
                        <span className="header-scope__menu-title">{displayOrg?.name || 'Scope'}</span>
                    </div>

                    <button
                        type="button"
                        className={`header-scope__item${currentScope?.type === 'organization' ? ' is-active' : ''}`}
                        onClick={pickWholeOrg}
                    >
                        <span className="header-scope__item-label">Entire organisation</span>
                        {currentScope?.type === 'organization' && (
                            <span className="header-scope__item-check"><CheckIcon /></span>
                        )}
                    </button>

                    <div className="header-scope__sect">Divisions</div>

                    {loadingDivs && <div className="header-scope__hint">Loading divisions…</div>}
                    {!loadingDivs && !divisions.length && (
                        <div className="header-scope__hint">No divisions in this organisation</div>
                    )}
                    {!loadingDivs && divisions.map(div => (
                        <div key={div.id} className="header-scope__div">
                            <div className={`header-scope__item${currentScope?.type === 'division' && currentScope.id === div.id ? ' is-active' : ''}`}>
                                <button
                                    type="button"
                                    className="header-scope__item-main"
                                    onClick={() => pickDivision(div)}
                                >
                                    <span className="header-scope__item-label">{div.name}</span>
                                </button>
                                {currentScope?.type === 'division' && currentScope.id === div.id && (
                                    <span className="header-scope__item-check"><CheckIcon /></span>
                                )}
                                <button
                                    type="button"
                                    className={`header-scope__expand${expandedDiv === div.id ? ' is-open' : ''}`}
                                    onClick={() => toggleDeptExpand(div.id)}
                                    aria-expanded={expandedDiv === div.id}
                                    aria-label={`Show departments in ${div.name}`}
                                >
                                    <ChevronIcon />
                                </button>
                            </div>
                            {expandedDiv === div.id && (
                                <div className="header-scope__depts">
                                    {loadingDeptsFor === div.id && (
                                        <div className="header-scope__hint">Loading departments…</div>
                                    )}
                                    {loadingDeptsFor !== div.id && !(deptsByDiv[div.id] || []).length && (
                                        <div className="header-scope__hint">No departments</div>
                                    )}
                                    {(deptsByDiv[div.id] || []).map(dept => (
                                        <button
                                            key={dept.id}
                                            type="button"
                                            className={`header-scope__item header-scope__item--dept${currentScope?.type === 'department' && currentScope.id === dept.id ? ' is-active' : ''}`}
                                            onClick={() => pickDepartment(dept, div.id)}
                                        >
                                            <span className="header-scope__item-label">{dept.name}</span>
                                            {currentScope?.type === 'department' && currentScope.id === dept.id && (
                                                <span className="header-scope__item-check"><CheckIcon /></span>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))}

                    {currentScope && (
                        <button type="button" className="header-scope__clear-item" onClick={clearScope}>
                            <ClearIcon size={10} />
                            <span>Clear scope filter</span>
                        </button>
                    )}
                </div>,
                document.body
            )}
        </div>
    );
}
