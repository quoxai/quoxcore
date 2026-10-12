/**
 * AssistantsView - AI Assistants Management
 *
 * Tabs: Mine & Scoped | Core | Plugin
 * Mine & Scoped tab includes scope selector to filter by org/division/department.
 * Plugin tab shows Chief Team agents from agentic team packs.
 */

import { useState, useEffect, useCallback } from 'react';
import { useOutletContext, useNavigate, useLocation } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { DEFAULT_LLM_CONFIG } from '../../services/llmService';
import { useAuth } from '../../contexts/AuthContext';
import { queueSync } from '../../services/serverSyncQueue';
import { PageSection, PageGrid } from '../../components/layout';
import { AssistantEditor } from '../../components/settings';
import {
    listAssistantsAsync,
    generateIdentityCardFromEntity,
    getSourceBadge,
    ENTITY_SOURCES,
    clearUserEntitiesCache
} from '../../services/entityRegistry';
import Button from '../../components/ui/Button';
import { chiefs } from '../../config/chiefs';
import { assistants as assistantsConfig, getAssistant } from '../../config/assistants';
import './views.css';
import LLMAuthBanner from '../../components/ui/LLMAuthBanner'
import { AgentProfileBadges } from '../../components/agents/AgentProfileBadges.jsx'
import { fetchProfileSummary } from '../../services/agentProfileClient.js'

function SourceBadge({ source }) {
    const badge = getSourceBadge({ ownership: { source } });
    return (
        <span
            className="source-badge"
            style={{
                background: `${badge.color}20`,
                color: badge.color,
                border: `1px solid ${badge.color}40`,
                padding: '2px 8px',
                borderRadius: '10px',
                fontSize: '11px',
                fontWeight: 600,
                letterSpacing: '0.05em'
            }}
            title={badge.description}
        >
            {badge.label}
        </span>
    );
}

function AssistantCard({ assistant, isActive, onSelect, onConfigure, onChat, profile }) {
    const card = generateIdentityCardFromEntity(assistant);
    const source = card?.source || ENTITY_SOURCES.CORE;

    return (
        <div
            className={`assistant-card ${isActive ? 'assistant-card--active' : ''}`}
            onClick={() => onSelect?.(assistant)}
        >
            <div className="assistant-card__header">
                <div
                    className="assistant-card__avatar"
                    style={{ background: card?.color || '#ff3b3b' }}
                >
                    {card?.shortName || card?.name?.[0] || 'A'}
                </div>
                <div className="assistant-card__info">
                    <div className="assistant-card__name">
                        {card?.name || assistant.name}
                        <SourceBadge source={source} />
                    </div>
                    <div className="assistant-card__tagline">
                        {card?.tagline || assistant.tagline}
                    </div>
                    {source === ENTITY_SOURCES.SCOPE && assistant.scope_name && (
                        <span
                            className="assistant-card__scope"
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                padding: '2px 8px',
                                marginTop: 4,
                                borderRadius: 999,
                                fontSize: 10,
                                fontWeight: 600,
                                letterSpacing: '0.04em',
                                background: 'rgba(245, 158, 11, 0.14)',
                                border: '1px solid rgba(245, 158, 11, 0.35)',
                                color: '#fbbf24',
                                fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
                                textTransform: 'uppercase',
                            }}
                            title={`Scoped to ${assistant.scope_type || 'scope'}: ${assistant.scope_name}`}
                        >
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                                <circle cx="12" cy="10" r="3" />
                            </svg>
                            {assistant.scope_type ? assistant.scope_type.toUpperCase() : 'SCOPE'} · {assistant.scope_name}
                        </span>
                    )}
                </div>
                {isActive && (
                    <div className="assistant-card__badge">Active</div>
                )}
            </div>
            <AgentProfileBadges agentId={assistant.id} variant="compact" profile={profile} />
            <div className="assistant-card__description">
                {card?.description || assistant.description}
            </div>
            <div className="assistant-card__meta">
                <span className="assistant-card__level">
                    L{card?.level ?? 2}
                </span>
                <span className="assistant-card__role">
                    {card?.role || 'specialist'}
                </span>
                {card?.domains?.slice(0, 3).map(domain => (
                    <span key={domain} className="assistant-card__domain">
                        {domain}
                    </span>
                ))}
            </div>
            <div className="assistant-card__actions">
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>}
                    onClick={(e) => { e.stopPropagation(); onChat?.(assistant); }}
                    aria-label={`Chat with ${card?.name || assistant.name}`}
                >
                    Chat
                </Button>
                <Button
                    size="sm"
                    variant="primary"
                    icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>}
                    onClick={(e) => { e.stopPropagation(); onConfigure?.(assistant); }}
                    aria-label={`Configure ${card?.name || assistant.name}`}
                >
                    Configure
                </Button>
            </div>
        </div>
    );
}

// Build flat list of scopes from tree for the scope selector dropdown
function flattenScopeTree(tree, depth = 0) {
    if (!tree) return [];
    const items = [];
    const nodes = Array.isArray(tree) ? tree : tree.children || [tree];
    for (const node of nodes) {
        if (node.scope_type === 'team') continue;
        items.push({ ...node, depth });
        if (node.children?.length) {
            items.push(...flattenScopeTree({ children: node.children }, depth + 1));
        }
    }
    return items;
}

export function buildDefaultCustomAssistantPersona(name) {
    const trimmed = name.trim();
    return {
        system_prompt: `You are ${trimmed}, a helpful AI assistant.`,
        provider: DEFAULT_LLM_CONFIG.provider,
        model: DEFAULT_LLM_CONFIG.model,
        temperature: DEFAULT_LLM_CONFIG.temperature,
        color: '#8b5cf6',
        role: 'specialist',
        level: 2,
        shortName: trimmed.charAt(0).toUpperCase(),
        specialty: trimmed,
    };
}

export function resolveCreatedAssistantId(payload) {
    return payload?.assistant?.id || payload?.id || null;
}

export function resolveAssistantRouteIntent(routeState, assistants = []) {
    if (!routeState?.configureAssistant || !routeState?.assistantId) return null;
    const assistant = assistants.find((item) => item.id === routeState.assistantId);
    if (!assistant) return null;
    return {
        assistantId: assistant.id,
        scopeFilter: assistant.ownership?.homeScopeId || assistant.home_scope_id || 'all',
    };
}

function AssistantsView() {
    const { halState, setPageActions } = useOutletContext() || {};
    const { currentOrg, scopeTree } = useWorkspace();
    const { authFetch } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();

    const [activeTab, setActiveTab] = useState('my');
    const [scopeFilter, setScopeFilter] = useState('all');
    const [assistantsList, setAssistantsList] = useState([]);
    const [activeAssistant, setActiveAssistant] = useState(() => {
        return localStorage.getItem('quox-assistant') || 'quox';
    });
    const [selectedAssistant, setSelectedAssistant] = useState(null);
    const [editingAssistantId, setEditingAssistantId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [profileMap, setProfileMap] = useState({});

    // Batch fetch all agent profiles once — avoids 16 individual HTTP calls
    useEffect(() => {
        fetchProfileSummary()
            .then(summary => {
                const map = {};
                for (const p of summary.per_agent || []) {
                    if (!p.error) map[p.agentId] = p;
                }
                setProfileMap(map);
            })
            .catch(() => { /* swallow — badges fall back to individual fetch */ });
    }, []);

    const loadAssistants = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const list = await listAssistantsAsync({
                orgId: currentOrg?.id,
                authFetch,
                includeUser: true,
                sortBy: 'level'
            });
            setAssistantsList(list);
        } catch (err) {
            console.error('Failed to load assistants:', err);
            setError('Failed to load assistants');
        } finally {
            setLoading(false);
        }
    }, [currentOrg?.id, authFetch]);

    useEffect(() => { loadAssistants(); }, [loadAssistants]);

    useEffect(() => {
        const intent = resolveAssistantRouteIntent(location.state, assistantsList);
        if (!intent) return;

        const assistant = assistantsList.find((item) => item.id === intent.assistantId);
        if (!assistant) return;

        setActiveTab('my');
        setScopeFilter(intent.scopeFilter);
        setSelectedAssistant(assistant);
        setEditingAssistantId(assistant.id);
        navigate('/assistants', { replace: true, state: null });
    }, [location.state, assistantsList, navigate]);

    // Derive filtered list from tab + scope
    // Core assistants tab: only orchestrators (CommanderQ). Agents go on /agents page.
    const coreList = assistantsList.filter(a => {
        const source = a.ownership?.source || ENTITY_SOURCES.CORE;
        if (source !== ENTITY_SOURCES.CORE) return false;
        const role = a.hierarchy?.role || a.role;
        return role === 'orchestrator';
    });
    const myList = assistantsList.filter(a => {
        const source = a.ownership?.source || ENTITY_SOURCES.CORE;
        return source === ENTITY_SOURCES.USER || source === ENTITY_SOURCES.SCOPE;
    });

    // Apply scope filter to My Assistants
    const filteredMyList = scopeFilter === 'all'
        ? myList
        : myList.filter(a => {
            const scopeId = a.ownership?.homeScopeId || a.home_scope_id;
            return scopeId === scopeFilter;
        });

    // Build plugin assistant list from chiefs registry
    const pluginList = Object.values(chiefs).map(chief => ({
        id: `chief-${chief.id}`,
        name: chief.name,
        identity: { name: chief.name, shortName: chief.shortName || chief.name.charAt(0) },
        hierarchy: { role: chief.role || 'specialist', level: chief.level ?? 1 },
        ownership: { source: 'plugin' },
        description: chief.description,
        specialty: chief.specialty,
        color: chief.color || '#1e293b',
        _isChief: true,
        _chiefId: chief.id,
        tier: chief.tier,
    }));

    // Also include plugin agents from the core assistants registry (archivist, netwatch, quoxcode)
    const pluginAssistants = assistantsList.filter(a => {
        const config = assistantsConfig[a.id];
        return config?.requiresPlugin;
    });

    const allPluginList = [...pluginAssistants, ...pluginList];

    const displayList = activeTab === 'core' ? coreList
        : activeTab === 'plugin' ? allPluginList
        : filteredMyList;

    // Flatten scope tree for dropdown
    const scopeOptions = flattenScopeTree(scopeTree);

    const activateAssistant = (assistant) => {
        setActiveAssistant(assistant.id);
        localStorage.setItem('quox-assistant', assistant.id);
        queueSync('defaultAssistant', assistant.id);
    };

    const handleChat = (assistant) => {
        navigate('/', { state: { assistant: assistant.id } });
    };

    const handleConfigure = (assistant) => {
        setEditingAssistantId(assistant.id);
    };

    const handleEditorClose = () => {
        setEditingAssistantId(null);
    };

    const handleEditorSave = () => {
        clearUserEntitiesCache(currentOrg?.id);
        loadAssistants();
        setEditingAssistantId(null);
    };

    const handleCreateCustom = useCallback(async () => {
        const name = prompt('Enter a name for your new assistant:');
        if (!name || !name.trim()) return;

        try {
            const res = await authFetch(`/api/orgs/${currentOrg?.id}/assistants`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name.trim(),
                    description: `Custom assistant: ${name.trim()}`,
                    persona: buildDefaultCustomAssistantPersona(name)
                })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `Failed to create assistant (${res.status})`);
            }
            const created = await res.json();
            const createdAssistantId = resolveCreatedAssistantId(created);
            clearUserEntitiesCache(currentOrg?.id);
            await loadAssistants();
            if (!createdAssistantId) {
                throw new Error('Assistant was created but no assistant ID was returned');
            }
            setEditingAssistantId(createdAssistantId);
        } catch (err) {
            console.error('Failed to create assistant:', err);
            setError(`Failed to create assistant: ${err.message}`);
        }
    }, [authFetch, currentOrg?.id, loadAssistants]);

    useEffect(() => {
        if (editingAssistantId) {
            setPageActions?.(null);
        } else {
            setPageActions?.(
                activeTab === 'my' ? <Button variant="primary" onClick={handleCreateCustom}>Create Custom</Button> : null
            );
        }
        return () => setPageActions?.(null);
    }, [setPageActions, activeTab, handleCreateCustom, editingAssistantId]);

    if (loading) {
        return <div className="loading-state">Loading assistants...</div>;
    }

    // Editor view
    if (editingAssistantId) {
        const editingAssistant = assistantsList.find(a => a.id === editingAssistantId);
        return (
            <div className="assistants-view view-page">
                <div className="assistant-editor-container" style={{ padding: '20px' }}>
                    <AssistantEditor
                        assistantId={editingAssistantId}
                        assistantSource={editingAssistant?.ownership?.source || 'core'}
                        orgId={currentOrg?.id}
                        authFetch={authFetch}
                        onClose={handleEditorClose}
                        onSave={handleEditorSave}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className="assistants-view view-page">
            <LLMAuthBanner />

            {error && (
                <div className="error-banner" style={{
                    padding: '12px 16px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: '8px',
                    color: '#ef4444',
                    marginBottom: '16px'
                }}>
                    {error}
                </div>
            )}

            {/* Tabs */}
            <div className="assistants-tabs" style={{
                display: 'flex',
                gap: '0',
                marginBottom: '20px',
                borderBottom: '1px solid var(--ui-border, rgba(255,255,255,0.08))',
            }}>
                <button
                    className={`assistants-tab ${activeTab === 'my' ? 'assistants-tab--active' : ''}`}
                    onClick={() => setActiveTab('my')}
                    style={{
                        padding: '10px 20px',
                        background: 'none',
                        border: 'none',
                        borderBottom: activeTab === 'my' ? '2px solid var(--hal-green, #30ff90)' : '2px solid transparent',
                        color: activeTab === 'my' ? 'var(--ui-text-primary, #fff)' : 'var(--ui-text-muted, #888)',
                        fontSize: '14px',
                        fontWeight: activeTab === 'my' ? 600 : 400,
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                    }}
                >
                    Mine &amp; Scoped
                    <span style={{
                        marginLeft: '8px',
                        padding: '1px 7px',
                        borderRadius: '10px',
                        fontSize: '11px',
                        background: activeTab === 'my' ? 'rgba(48, 255, 144, 0.15)' : 'rgba(255,255,255,0.06)',
                        color: activeTab === 'my' ? 'var(--hal-green, #30ff90)' : 'var(--ui-text-muted, #888)',
                    }}>
                        {myList.length}
                    </span>
                </button>
                <button
                    className={`assistants-tab ${activeTab === 'core' ? 'assistants-tab--active' : ''}`}
                    onClick={() => setActiveTab('core')}
                    style={{
                        padding: '10px 20px',
                        background: 'none',
                        border: 'none',
                        borderBottom: activeTab === 'core' ? '2px solid var(--hal-green, #30ff90)' : '2px solid transparent',
                        color: activeTab === 'core' ? 'var(--ui-text-primary, #fff)' : 'var(--ui-text-muted, #888)',
                        fontSize: '14px',
                        fontWeight: activeTab === 'core' ? 600 : 400,
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                    }}
                >
                    Core
                    <span style={{
                        marginLeft: '8px',
                        padding: '1px 7px',
                        borderRadius: '10px',
                        fontSize: '11px',
                        background: activeTab === 'core' ? 'rgba(48, 255, 144, 0.15)' : 'rgba(255,255,255,0.06)',
                        color: activeTab === 'core' ? 'var(--hal-green, #30ff90)' : 'var(--ui-text-muted, #888)',
                    }}>
                        {coreList.length}
                    </span>
                </button>
                <button
                    className={`assistants-tab ${activeTab === 'plugin' ? 'assistants-tab--active' : ''}`}
                    onClick={() => setActiveTab('plugin')}
                    style={{
                        padding: '10px 20px',
                        background: 'none',
                        border: 'none',
                        borderBottom: activeTab === 'plugin' ? '2px solid var(--hal-green, #30ff90)' : '2px solid transparent',
                        color: activeTab === 'plugin' ? 'var(--ui-text-primary, #fff)' : 'var(--ui-text-muted, #888)',
                        fontSize: '14px',
                        fontWeight: activeTab === 'plugin' ? 600 : 400,
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                    }}
                >
                    Plugin
                    <span style={{
                        marginLeft: '8px',
                        padding: '1px 7px',
                        borderRadius: '10px',
                        fontSize: '11px',
                        background: activeTab === 'plugin' ? 'rgba(48, 255, 144, 0.15)' : 'rgba(255,255,255,0.06)',
                        color: activeTab === 'plugin' ? 'var(--hal-green, #30ff90)' : 'var(--ui-text-muted, #888)',
                    }}>
                        {allPluginList.length}
                    </span>
                </button>
            </div>

            {/* Scope selector (My Assistants tab only) */}
            {activeTab === 'my' && scopeOptions.length > 0 && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    marginBottom: '16px',
                    padding: '8px 12px',
                    background: 'rgba(255,255,255,0.03)',
                    borderRadius: '8px',
                    border: '1px solid var(--ui-border, rgba(255,255,255,0.06))',
                }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ui-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                    </svg>
                    <span style={{ fontSize: '12px', color: 'var(--ui-text-muted)', whiteSpace: 'nowrap' }}>Scope:</span>
                    <select
                        value={scopeFilter}
                        onChange={(e) => setScopeFilter(e.target.value)}
                        style={{
                            background: 'rgba(255, 255, 255, 0.06)',
                            color: '#fff',
                            border: '1px solid rgba(255, 255, 255, 0.16)',
                            borderRadius: '6px',
                            padding: '5px 10px',
                            fontSize: '13px',
                            flex: 1,
                            maxWidth: '300px',
                            cursor: 'pointer',
                        }}
                    >
                        <option value="all">All Scopes</option>
                        {scopeOptions.map(scope => (
                            <option key={scope.id} value={scope.id}>
                                {'  '.repeat(scope.depth)}{scope.scope_type === 'org' ? '' : scope.scope_type === 'division' ? '  ' : '    '}{scope.name_cache || scope.name || scope.id}
                            </option>
                        ))}
                    </select>
                    {scopeFilter !== 'all' && (
                        <button
                            onClick={() => setScopeFilter('all')}
                            style={{
                                background: 'none',
                                border: 'none',
                                color: 'var(--ui-text-muted)',
                                cursor: 'pointer',
                                padding: '2px',
                                fontSize: '16px',
                                lineHeight: 1,
                            }}
                            title="Clear filter"
                        >
                            &times;
                        </button>
                    )}
                </div>
            )}

            {/* Assistants Grid */}
            <PageSection
                badge={`${displayList.length}`}
            >
                {displayList.length === 0 ? (
                    <div style={{
                        padding: '48px',
                        textAlign: 'center',
                        color: 'var(--ui-text-muted)'
                    }}>
                        {activeTab === 'my'
                            ? 'No custom or scope assistants yet. Create one or add a scope entity.'
                            : activeTab === 'plugin'
                            ? 'No plugin assistants installed. Install a Chief Team or plugin with agents.'
                            : 'No core assistants found.'}
                    </div>
                ) : (
                    <PageGrid columns={2}>
                        {displayList.map(assistant => (
                            <AssistantCard
                                key={assistant.id}
                                assistant={assistant}
                                isActive={assistant.id === activeAssistant}
                                onSelect={setSelectedAssistant}
                                onConfigure={handleConfigure}
                                onChat={handleChat}
                                profile={profileMap[assistant.id] || profileMap[assistant.id.replace(/^chief-/, '')]}
                            />
                        ))}
                    </PageGrid>
                )}
            </PageSection>

            {/* Selected Assistant Detail */}
            {selectedAssistant && (() => {
                const selectedCard = generateIdentityCardFromEntity(selectedAssistant);
                const selSource = selectedCard?.source || ENTITY_SOURCES.CORE;
                return (
                    <div className="assistant-detail-panel" style={{
                        marginTop: '16px',
                        padding: '20px',
                        background: 'rgba(255, 255, 255, 0.06)',
                        border: '1px solid rgba(255, 255, 255, 0.16)',
                        borderRadius: '12px',
                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(0,0,0,0.35)',
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                                {selectedCard?.name}
                                <SourceBadge source={selSource} />
                            </h3>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                <Button
                                    variant="primary"
                                    size="sm"
                                    onClick={() => activateAssistant(selectedAssistant)}
                                    disabled={selectedAssistant.id === activeAssistant}
                                >
                                    {selectedAssistant.id === activeAssistant ? 'Active' : 'Activate'}
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => setSelectedAssistant(null)}>
                                    Close
                                </Button>
                            </div>
                        </div>
                        <p style={{ color: 'var(--ui-text-muted)', margin: '0 0 12px' }}>
                            {selectedCard?.description || selectedAssistant.description}
                        </p>
                        <div style={{ display: 'flex', gap: '16px', fontSize: '13px', color: 'var(--ui-text-muted)' }}>
                            <span><strong>Role:</strong> {selectedCard?.role}</span>
                            <span><strong>Level:</strong> {selectedCard?.level}</span>
                            <span><strong>DEFCON:</strong> {selectedCard?.defcon}</span>
                        </div>
                        {selectedCard?.domains?.length > 0 && (
                            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' }}>
                                {selectedCard.domains.map(domain => (
                                    <span key={domain} style={{
                                        padding: '3px 10px',
                                        background: 'rgba(139, 92, 246, 0.15)',
                                        borderRadius: '12px',
                                        fontSize: '11px',
                                        color: '#8b5cf6'
                                    }}>
                                        {domain}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })()}
        </div>
    );
}

export default AssistantsView;
