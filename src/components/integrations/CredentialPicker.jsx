/**
 * CredentialPicker — Reusable dropdown for selecting vault credentials
 *
 * Features:
 * - Filter by integration type
 * - Search within dropdown
 * - Health status indicator
 * - Visibility badge (org/team/personal)
 * - Last-used timestamp
 * - "Add new" inline option
 * - Compact mode for toolbar embedding
 *
 * @param {string} type - Integration type to filter (e.g., 'smtp', 'openai')
 * @param {string} [orgId] - Org scope
 * @param {string} [scopeId] - Team/project scope
 * @param {string} [value] - Currently selected credential ID
 * @param {Function} onSelect - Callback with { id, label, type, keyPreview }
 * @param {boolean} [allowCreate=true] - Show "Add new" option
 * @param {boolean} [showHealth=true] - Show health status badges
 * @param {boolean} [compact=false] - Compact mode
 * @param {string} [placeholder] - Placeholder text
 * @param {Function} [onAddNew] - Callback when "Add new" is clicked
 * @param {Function} [onBrowseAll] - Callback to open expanded modal
 */

import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useVaultCredentials, useMultiOrgVaultCredentials } from '../../hooks/useVaultCredentials';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import './integrations.css';

// Status colors
const STATUS_COLORS = {
    success: '#4ade80',
    failed: '#f87171',
    untested: '#a1a1aa',
    testing: '#fbbf24'
};

const STATUS_LABELS = {
    success: 'Healthy',
    failed: 'Failed',
    untested: 'Untested'
};

// Icons
const LockIcon = ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
);

const ChevronIcon = ({ open }) => (
    <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
        style={{ flexShrink: 0, opacity: 0.5, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
        <path d="M2 3.5l3 3 3-3" />
    </svg>
);

const SearchIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
);

const PlusIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
);

const ExternalIcon = () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
);

function timeAgo(dateStr) {
    if (!dateStr) return null;
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return `${Math.floor(seconds / 604800)}w ago`;
}

export default function CredentialPicker({
    type,
    orgId,
    scopeId,
    value,
    onSelect,
    allowCreate = true,
    showHealth = true,
    compact = false,
    placeholder = 'Select credential...',
    onAddNew,
    onBrowseAll
}) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [highlightIndex, setHighlightIndex] = useState(-1);
    const dropdownRef = useRef(null);
    const searchRef = useRef(null);
    const triggerRef = useRef(null);
    const menuRef = useRef(null);
    // The menu is portaled to document.body (so no overflow:hidden ancestor can
    // clip it); menuStyle holds its computed fixed position.
    const [menuStyle, setMenuStyle] = useState(null);

    const { orgs, currentOrg } = useWorkspace();
    const allOrgIds = useMemo(() => (orgs || []).map(o => o.id), [orgs]);
    const hasMultiOrg = allOrgIds.length > 1;
    // Pass org ID from context as fallback when localStorage doesn't have it
    const contextOrgId = currentOrg?.id || allOrgIds[0];

    // Both hooks must be called unconditionally (React rules).
    // When multi-org, single-org result is discarded and vice versa.
    const singleOrg = useVaultCredentials({ type, orgId: contextOrgId });
    const multiOrg = useMultiOrgVaultCredentials(hasMultiOrg ? { orgIds: allOrgIds, type } : { orgIds: [] });
    const { credentials, loading } = hasMultiOrg ? multiOrg : singleOrg;

    // Filter by search
    const filtered = useMemo(() => {
        if (!search.trim()) return credentials;
        const q = search.toLowerCase();
        return credentials.filter(c =>
            (c.label || '').toLowerCase().includes(q) ||
            (c.key_preview || '').toLowerCase().includes(q) ||
            (c.description || '').toLowerCase().includes(q)
        );
    }, [credentials, search]);

    const selected = credentials.find(c => c.id === value);
    const hasCredentials = credentials.length > 0;

    // Close dropdown on outside click
    useEffect(() => {
        function handleClickOutside(e) {
            // The menu lives in a portal outside dropdownRef, so a click inside
            // it must NOT be treated as "outside".
            const inTrigger = dropdownRef.current && dropdownRef.current.contains(e.target);
            const inMenu = menuRef.current && menuRef.current.contains(e.target);
            if (!inTrigger && !inMenu) {
                setOpen(false);
                setSearch('');
                setHighlightIndex(-1);
            }
        }
        if (open) {
            document.addEventListener('mousedown', handleClickOutside);
            return () => document.removeEventListener('mousedown', handleClickOutside);
        }
    }, [open]);

    // Focus search on open
    useEffect(() => {
        if (open && searchRef.current) {
            searchRef.current.focus();
        }
    }, [open]);

    // Position the portaled menu under (or above) the trigger, fixed to the
    // viewport, recomputed on open/scroll/resize. Flips up when there is more
    // room above than below so a long list is never cut off by the viewport.
    useLayoutEffect(() => {
        if (!open) { setMenuStyle(null); return; }
        const reposition = () => {
            const t = triggerRef.current;
            if (!t) return;
            const r = t.getBoundingClientRect();
            const spaceBelow = window.innerHeight - r.bottom;
            const spaceAbove = r.top;
            const flipUp = spaceBelow < 220 && spaceAbove > spaceBelow;
            const maxHeight = Math.max(160, (flipUp ? spaceAbove : spaceBelow) - 16);
            setMenuStyle({
                position: 'fixed',
                left: Math.round(r.left),
                width: Math.round(r.width),
                right: 'auto',
                marginTop: 0,
                maxHeight,
                overflowY: 'auto',
                zIndex: 4000,
                ...(flipUp
                    ? { bottom: Math.round(window.innerHeight - r.top + 6), top: 'auto' }
                    : { top: Math.round(r.bottom + 6), bottom: 'auto' }),
            });
        };
        reposition();
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        return () => {
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
        };
    }, [open, filtered.length, hasMultiOrg]);

    const handleSelect = useCallback((cred) => {
        onSelect({
            id: cred.id,
            label: cred.label,
            type: cred.integration_type,
            provider: cred.integration_type,
            keyPreview: cred.key_preview,
            org_id: cred.org_id || undefined
        });
        setOpen(false);
        setSearch('');
        setHighlightIndex(-1);
    }, [onSelect]);

    const handleKeyDown = useCallback((e) => {
        if (!open) return;
        const count = filtered.length;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlightIndex(i => (i + 1) % (count + (allowCreate ? 1 : 0)));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlightIndex(i => (i - 1 + count + (allowCreate ? 1 : 0)) % (count + (allowCreate ? 1 : 0)));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (highlightIndex >= 0 && highlightIndex < count) {
                handleSelect(filtered[highlightIndex]);
            } else if (highlightIndex === count && allowCreate && onAddNew) {
                onAddNew();
                setOpen(false);
            }
        } else if (e.key === 'Escape') {
            setOpen(false);
            setSearch('');
        }
    }, [open, filtered, highlightIndex, allowCreate, onAddNew, handleSelect]);

    const toggleOpen = useCallback(() => {
        if (hasCredentials || allowCreate) {
            setOpen(prev => !prev);
        }
    }, [hasCredentials, allowCreate]);

    // Empty state — no credentials and can't create
    if (!loading && !hasCredentials && !allowCreate) {
        return (
            <div className="cred-picker" ref={dropdownRef}>
                <button className="cred-picker__trigger cred-picker__trigger--disabled" disabled>
                    <LockIcon size={compact ? 12 : 14} />
                    <span className="cred-picker__label">No credentials</span>
                </button>
            </div>
        );
    }

    return (
        <div className={`cred-picker ${compact ? 'cred-picker--compact' : ''}`} ref={dropdownRef}>
            {/* Trigger button */}
            <button
                ref={triggerRef}
                className={`cred-picker__trigger ${open ? 'cred-picker__trigger--open' : ''}`}
                onClick={toggleOpen}
                onKeyDown={handleKeyDown}
                title={selected ? `${selected.label} (${selected.key_preview})` : placeholder}
            >
                {selected && showHealth && (
                    <span
                        className="cred-picker__status-dot"
                        style={{ background: STATUS_COLORS[selected.test_status || selected.last_test_status] || STATUS_COLORS.untested }}
                        title={STATUS_LABELS[selected.test_status || selected.last_test_status] || 'Untested'}
                    />
                )}

                <LockIcon size={compact ? 12 : 14} />

                <span className="cred-picker__label">
                    {loading ? 'Loading...' : (selected ? selected.label : placeholder)}
                </span>

                {selected && selected.key_preview && (
                    <span className="cred-picker__preview">{selected.key_preview}</span>
                )}

                <ChevronIcon open={open} />
            </button>

            {/* Dropdown — portaled to body so no overflow:hidden ancestor clips it */}
            {open && menuStyle && createPortal(
                <div className="cred-picker__dropdown" ref={menuRef} style={menuStyle}>
                    {/* Search */}
                    {credentials.length > 3 && (
                        <div className="cred-picker__search">
                            <SearchIcon />
                            <input
                                ref={searchRef}
                                type="text"
                                className="cred-picker__search-input"
                                placeholder="Search credentials..."
                                value={search}
                                onChange={(e) => { setSearch(e.target.value); setHighlightIndex(-1); }}
                                onKeyDown={handleKeyDown}
                            />
                        </div>
                    )}

                    {/* Credential list */}
                    <div className="cred-picker__list">
                        {filtered.length === 0 && (
                            <div className="cred-picker__empty">
                                {search ? 'No matches' : 'No credentials'}
                            </div>
                        )}

                        {(() => {
                            // Group by org when multi-org
                            if (hasMultiOrg && !search.trim()) {
                                const byOrg = {};
                                for (const cred of filtered) {
                                    const orgId = cred.org_id || 'unknown';
                                    if (!byOrg[orgId]) byOrg[orgId] = [];
                                    byOrg[orgId].push(cred);
                                }
                                let flatIdx = 0;
                                return Object.entries(byOrg).map(([oid, creds]) => {
                                    const orgObj = orgs?.find(o => o.id === oid);
                                    const orgLabel = orgObj?.name || oid.slice(0, 8);
                                    return (
                                        <div key={oid}>
                                            <div className="cred-picker__org-group-label">{orgLabel}</div>
                                            {creds.map((cred) => {
                                                const idx = flatIdx++;
                                                return (
                                                    <button
                                                        key={cred.id}
                                                        className={`cred-picker__item ${cred.id === value ? 'cred-picker__item--selected' : ''} ${idx === highlightIndex ? 'cred-picker__item--highlight' : ''}`}
                                                        onClick={() => handleSelect(cred)}
                                                        onMouseEnter={() => setHighlightIndex(idx)}
                                                    >
                                                        {showHealth && (
                                                            <span className="cred-picker__status-dot" style={{ background: STATUS_COLORS[cred.test_status || cred.last_test_status] || STATUS_COLORS.untested }} />
                                                        )}
                                                        <div className="cred-picker__item-info">
                                                            <span className="cred-picker__item-label">
                                                                {cred.label}
                                                                {cred.is_default && <span className="cred-picker__badge cred-picker__badge--default">Default</span>}
                                                                {cred.visibility === 'personal' && <span className="cred-picker__badge cred-picker__badge--personal">Personal</span>}
                                                                {cred.visibility === 'team' && <span className="cred-picker__badge cred-picker__badge--team">Team</span>}
                                                            </span>
                                                            <span className="cred-picker__item-meta">
                                                                <span className="cred-picker__preview">{cred.key_preview}</span>
                                                                {cred.last_used_at && (
                                                                    <span className="cred-picker__last-used">Used {timeAgo(cred.last_used_at)}</span>
                                                                )}
                                                            </span>
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    );
                                });
                            }

                            // Default flat list (single org or searching)
                            return filtered.map((cred, idx) => (
                                <button
                                    key={cred.id}
                                    className={`cred-picker__item ${cred.id === value ? 'cred-picker__item--selected' : ''} ${idx === highlightIndex ? 'cred-picker__item--highlight' : ''}`}
                                    onClick={() => handleSelect(cred)}
                                    onMouseEnter={() => setHighlightIndex(idx)}
                                >
                                    {showHealth && (
                                        <span className="cred-picker__status-dot" style={{ background: STATUS_COLORS[cred.test_status || cred.last_test_status] || STATUS_COLORS.untested }} />
                                    )}
                                    <div className="cred-picker__item-info">
                                        <span className="cred-picker__item-label">
                                            {hasMultiOrg && cred.org_id && (
                                                <span className="cred-picker__org-prefix">{orgs?.find(o => o.id === cred.org_id)?.name || ''} &rsaquo; </span>
                                            )}
                                            {cred.label}
                                            {cred.is_default && <span className="cred-picker__badge cred-picker__badge--default">Default</span>}
                                            {cred.visibility === 'personal' && <span className="cred-picker__badge cred-picker__badge--personal">Personal</span>}
                                            {cred.visibility === 'team' && <span className="cred-picker__badge cred-picker__badge--team">Team</span>}
                                        </span>
                                        <span className="cred-picker__item-meta">
                                            <span className="cred-picker__preview">{cred.key_preview}</span>
                                            {cred.last_used_at && (
                                                <span className="cred-picker__last-used">Used {timeAgo(cred.last_used_at)}</span>
                                            )}
                                        </span>
                                    </div>
                                </button>
                            ));
                        })()}
                    </div>

                    {/* Footer actions */}
                    <div className="cred-picker__footer">
                        {allowCreate && onAddNew && (
                            <button
                                className={`cred-picker__action ${highlightIndex === filtered.length ? 'cred-picker__action--highlight' : ''}`}
                                onClick={() => { onAddNew(); setOpen(false); }}
                                onMouseEnter={() => setHighlightIndex(filtered.length)}
                            >
                                <PlusIcon /> Add new credential
                            </button>
                        )}
                        {onBrowseAll && (
                            <button
                                className="cred-picker__action"
                                onClick={() => { onBrowseAll(); setOpen(false); }}
                            >
                                <ExternalIcon /> Browse all
                            </button>
                        )}
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
