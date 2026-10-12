/**
 * AssistantPicker - Unified dropdown for core + scope/user assistants
 *
 * Shows all available assistants grouped by source:
 * - Core Assistants (from assistants.js config)
 * - My Assistants (scope + user from API)
 *
 * Unlike AgentPicker (which shows agentRegistry entries for delegation/workflow),
 * this picker shows all chat-capable assistants including scope-created ones.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { assistants } from '../../config/assistants';
import { chiefs } from '../../config/chiefs';
import { loadUserEntities } from '../../services/entityRegistry';
import { getLlmPolicyLabel, isLlmPolicyLocked, normalizeLlmPolicy } from '../../services/llmPolicy';
import './AssistantPicker.css';

export default function AssistantPicker({
    value,
    onChange,
    orgId,
    authFetch,
    placeholder = 'Select assistant...',
    disabled = false,
    size = 'medium',
}) {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [userAssistants, setUserAssistants] = useState([]);
    const [focusedIndex, setFocusedIndex] = useState(-1);
    const dropdownRef = useRef(null);
    const listRef = useRef(null);

    // Load core assistants (synchronous)
    const coreList = useMemo(() => {
        return Object.entries(assistants).map(([id, config]) => ({
            id,
            name: config.name || id,
            shortName: config.shortName || config.name?.[0] || '?',
            color: config.color?.primary || config.color || '#38bdf8',
            role: config.role || 'specialist',
            specialty: config.specialty || '',
            llmPolicy: normalizeLlmPolicy(config.llmPolicy, { entityId: id }),
            source: 'core',
        }));
    }, []);

    // Load user/scope assistants (async)
    useEffect(() => {
        if (!orgId || !authFetch) {
            setUserAssistants([]);
            return;
        }
        let cancelled = false;
        loadUserEntities(orgId, authFetch).then(entities => {
            if (cancelled) return;
            const mapped = entities.map(e => {
                const persona = e.persona || (e.persona_json ? JSON.parse(e.persona_json) : {});
                return {
                    id: e.id,
                    name: e.name || 'Unnamed',
                    shortName: persona.shortName || e.name?.[0] || 'A',
                    color: persona.color || '#8b5cf6',
                    role: persona.role || 'specialist',
                    specialty: persona.specialty || e.scope_name || '',
                    llmPolicy: normalizeLlmPolicy(e.llmPolicy, { entityId: e.id }),
                    source: e.ownership?.source || 'user',
                    scopeName: e.scope_name,
                    scopeType: e.scope_type,
                };
            });
            setUserAssistants(mapped);
        }).catch(() => {
            if (!cancelled) setUserAssistants([]);
        });
        return () => { cancelled = true; };
    }, [orgId, authFetch]);

    // Plugin assistants (chiefs from agentic team packs)
    const pluginList = useMemo(() => {
        return Object.values(chiefs).map(chief => ({
            id: `chief-${chief.id}`,
            name: chief.name,
            shortName: chief.shortName || chief.name.charAt(0),
            color: chief.color || '#1e293b',
            role: chief.role || 'specialist',
            specialty: chief.specialty || chief.description || '',
            llmPolicy: normalizeLlmPolicy(chief.llmPolicy, { entityId: chief.id }),
            source: 'plugin',
        }));
    }, []);

    // Combined list for searching
    const allAssistants = useMemo(() => [...coreList, ...pluginList, ...userAssistants], [coreList, pluginList, userAssistants]);

    // Filtered by search
    const filtered = useMemo(() => {
        if (!search.trim()) return { core: coreList, plugin: pluginList, user: userAssistants };
        const q = search.toLowerCase();
        return {
            core: coreList.filter(a => a.name.toLowerCase().includes(q) || a.specialty.toLowerCase().includes(q)),
            plugin: pluginList.filter(a => a.name.toLowerCase().includes(q) || a.specialty.toLowerCase().includes(q)),
            user: userAssistants.filter(a => a.name.toLowerCase().includes(q) || a.specialty.toLowerCase().includes(q)),
        };
    }, [search, coreList, pluginList, userAssistants]);

    // Flat list for keyboard navigation
    const flatFiltered = useMemo(() => [...filtered.core, ...filtered.plugin, ...filtered.user], [filtered]);

    // Selected assistant info
    const selected = allAssistants.find(a => a.id === value);

    const getPolicyBadge = useCallback((assistant) => {
        const policy = normalizeLlmPolicy(assistant?.llmPolicy, { entityId: assistant?.id });
        const locked = isLlmPolicyLocked(policy);
        return {
            label: locked ? getLlmPolicyLabel(policy).toUpperCase() : 'ADVISORY',
            className: locked
                ? 'astp-policy-badge astp-policy-badge--locked'
                : 'astp-policy-badge astp-policy-badge--advisory',
            title: locked
                ? 'Specialist-locked assistant: model choice is fixed unless the lock changes.'
                : 'Advisory assistant default: live user choice, credentials, or execution policy can still override it.',
        };
    }, []);

    // Close dropdown on outside click
    useEffect(() => {
        const handleClickOutside = (e) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
                setIsOpen(false);
                setFocusedIndex(-1);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Reset focus on open
    useEffect(() => {
        if (isOpen) { setFocusedIndex(-1); setSearch(''); }
    }, [isOpen]);

    // Scroll focused into view
    useEffect(() => {
        if (focusedIndex >= 0 && listRef.current) {
            const items = listRef.current.querySelectorAll('.astp-option');
            items[focusedIndex]?.scrollIntoView({ block: 'nearest' });
        }
    }, [focusedIndex]);

    const handleSelect = useCallback((assistantId) => {
        onChange?.(assistantId);
        setIsOpen(false);
        setFocusedIndex(-1);
    }, [onChange]);

    const handleKeyDown = useCallback((e) => {
        if (!isOpen) {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                e.preventDefault();
                setIsOpen(true);
            }
            return;
        }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setFocusedIndex(prev => Math.min(prev + 1, flatFiltered.length - 1));
                break;
            case 'ArrowUp':
                e.preventDefault();
                setFocusedIndex(prev => Math.max(prev - 1, 0));
                break;
            case 'Enter':
                e.preventDefault();
                if (focusedIndex >= 0 && flatFiltered[focusedIndex]) {
                    handleSelect(flatFiltered[focusedIndex].id);
                }
                break;
            case 'Escape':
                e.preventDefault();
                setIsOpen(false);
                break;
        }
    }, [isOpen, focusedIndex, flatFiltered, handleSelect]);

    const sizeClass = size === 'small' ? 'astp--small' : size === 'large' ? 'astp--large' : '';

    return (
        <div className={`assistant-picker ${sizeClass}`} ref={dropdownRef} onKeyDown={handleKeyDown}>
            <button
                className="astp-trigger"
                onClick={() => !disabled && setIsOpen(!isOpen)}
                disabled={disabled}
                type="button"
                aria-haspopup="listbox"
                aria-expanded={isOpen}
            >
                {selected ? (
                    <span className="astp-selected">
                        <span className="astp-dot" style={{ background: selected.color }} />
                        <span className="astp-name">{selected.name}</span>
                        <span
                            className={`${getPolicyBadge(selected).className} astp-policy-badge--inline`}
                            title={getPolicyBadge(selected).title}
                        >
                            {getPolicyBadge(selected).label}
                        </span>
                        {selected.source !== 'core' && (
                            <span className="astp-source-badge">{selected.source === 'plugin' ? 'PLUGIN' : selected.source === 'scope' ? 'SCOPE' : 'USER'}</span>
                        )}
                    </span>
                ) : (
                    <span className="astp-placeholder">{placeholder}</span>
                )}
                <svg className="astp-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 9 12 15 18 9" />
                </svg>
            </button>

            {isOpen && (
                <div className="astp-dropdown" role="listbox" ref={listRef}>
                    <div className="astp-search-wrapper">
                        <input
                            className="astp-search"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search assistants..."
                            autoFocus
                        />
                    </div>

                    <div className="astp-options">
                        {filtered.core.length > 0 && (
                            <>
                                <div className="astp-group-label">Core Assistants</div>
                                {filtered.core.map((a, idx) => (
                                    <div
                                        key={a.id}
                                        className={`astp-option ${value === a.id ? 'astp-option--selected' : ''} ${focusedIndex === idx ? 'astp-option--focused' : ''}`}
                                        onClick={() => handleSelect(a.id)}
                                        role="option"
                                        aria-selected={value === a.id}
                                    >
                                        <span className="astp-dot" style={{ background: a.color }} />
                                        <span className="astp-option-info">
                                            <span className="astp-option-name">{a.name}</span>
                                            <span className="astp-option-role">
                                                {a.specialty || a.role}
                                                <span
                                                    className={`${getPolicyBadge(a).className} astp-policy-badge--inline`}
                                                    title={getPolicyBadge(a).title}
                                                >
                                                    {getPolicyBadge(a).label}
                                                </span>
                                            </span>
                                        </span>
                                    </div>
                                ))}
                            </>
                        )}

                        {filtered.plugin.length > 0 && (
                            <>
                                <div className="astp-group-label">Plugin Agents</div>
                                {filtered.plugin.map((a, baseIdx) => {
                                    const idx = filtered.core.length + baseIdx;
                                    return (
                                        <div
                                            key={a.id}
                                            className={`astp-option ${value === a.id ? 'astp-option--selected' : ''} ${focusedIndex === idx ? 'astp-option--focused' : ''}`}
                                            onClick={() => handleSelect(a.id)}
                                            role="option"
                                            aria-selected={value === a.id}
                                        >
                                            <span className="astp-dot" style={{ background: a.color }} />
                                            <span className="astp-option-info">
                                                <span className="astp-option-name">
                                                    {a.name}
                                                    <span className="astp-source-badge astp-source-badge--inline" style={{ background: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24' }}>PLUGIN</span>
                                                </span>
                                                <span className="astp-option-role">{a.specialty || a.role}</span>
                                                <span
                                                    className={`${getPolicyBadge(a).className} astp-policy-badge--inline`}
                                                    title={getPolicyBadge(a).title}
                                                >
                                                    {getPolicyBadge(a).label}
                                                </span>
                                            </span>
                                        </div>
                                    );
                                })}
                            </>
                        )}

                        {filtered.user.length > 0 && (
                            <>
                                <div className="astp-group-label">My Assistants</div>
                                {filtered.user.map((a, baseIdx) => {
                                    const idx = filtered.core.length + filtered.plugin.length + baseIdx;
                                    return (
                                        <div
                                            key={a.id}
                                            className={`astp-option ${value === a.id ? 'astp-option--selected' : ''} ${focusedIndex === idx ? 'astp-option--focused' : ''}`}
                                            onClick={() => handleSelect(a.id)}
                                            role="option"
                                            aria-selected={value === a.id}
                                        >
                                            <span className="astp-dot" style={{ background: a.color }} />
                                            <span className="astp-option-info">
                                                <span className="astp-option-name">
                                                    {a.name}
                                                    <span className="astp-source-badge astp-source-badge--inline">
                                                        {a.source === 'scope' ? 'SCOPE' : 'USER'}
                                                    </span>
                                                </span>
                                                <span className="astp-option-role">
                                                    {a.scopeName ? `${a.scopeType ? a.scopeType.charAt(0).toUpperCase() + a.scopeType.slice(1) + ': ' : ''}${a.scopeName}` : a.specialty || a.role}
                                                    <span
                                                        className={`${getPolicyBadge(a).className} astp-policy-badge--inline`}
                                                        title={getPolicyBadge(a).title}
                                                    >
                                                        {getPolicyBadge(a).label}
                                                    </span>
                                                </span>
                                            </span>
                                        </div>
                                    );
                                })}
                            </>
                        )}

                        {flatFiltered.length === 0 && (
                            <div className="astp-empty">No assistants found</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
