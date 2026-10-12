/**
 * AgentsView - Agent Configuration Management
 *
 * Configuration-first agent listing with:
 * - Filter tabs: All | Core | Plugin | Custom
 * - Search filtering by name/domain
 * - Card click navigates to /agents/:agentId detail page
 * - Create Agent modal for new custom agents
 *
 * Excludes CommanderQ (QUOX) — it's an Assistant, not an Agent.
 * Plugin tab shows plugin agents (ARCHIVIST, NETWATCH, QUOXCODE) + installed Chief Team agents.
 */

import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { PageGrid } from '../../components/layout';
import { AgentConfigModal } from '../../components/agents';
import Button from '../../components/ui/Button';
import { agentRegistry } from '../../config/agentRegistry';
import { chiefs } from '../../config/chiefs';
import { generateIdentityCard } from '../../services/entityRegistry';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import {
    useAgents,
    AgentProvider,
    AGENT_LEVELS,
} from '../../contexts/AgentContext';
import './views.css';
import LLMAuthBanner from '../../components/ui/LLMAuthBanner'

// Icons
const PlusIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
);

const ToolIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
    </svg>
);

const WorkflowIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="6" y1="3" x2="6" y2="15"/>
        <circle cx="18" cy="6" r="3"/>
        <circle cx="6" cy="18" r="3"/>
        <path d="M18 9a9 9 0 0 1-9 9"/>
    </svg>
);

const SearchIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
);

const ArrowRightIcon = () => (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="9 18 15 12 9 6"/>
    </svg>
);

const PluginIcon = () => (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
);

const EditIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
);

const TrashIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>
);

const ChatIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
);

// Domain color map
const DOMAIN_COLORS = {
    security: '#f87171',
    infrastructure: '#60a5fa',
    development: '#4ade80',
    operations: '#fbbf24',
    data: '#a78bfa',
    communication: '#f472b6',
    monitoring: '#34d399',
    automation: '#fb923c',
    analysis: '#818cf8',
    integration: '#38bdf8',
    compliance: '#e879f9',
    support: '#94a3b8',
};

const FILTER_TABS = [
    { id: 'all', label: 'All' },
    { id: 'core', label: 'Core' },
    { id: 'plugin', label: 'Plugin' },
    { id: 'custom', label: 'Custom' },
];

export function flattenAgentScopeOptions(scopeTree) {
    if (!scopeTree) return [];

    const flattened = [];
    const walk = (node, depth = 0) => {
        if (!node) return;
        const scopeType = node.scope_type || node.type;
        if (scopeType !== 'team') {
            flattened.push({
                id: node.id,
                path: `${'  '.repeat(depth)}${node.name_cache || node.name || node.id}`,
                scope_type: scopeType,
            });
        }
        for (const child of node.children || []) walk(child, depth + 1);
    };

    const roots = Array.isArray(scopeTree) ? scopeTree : [scopeTree];
    roots.forEach((node) => walk(node));
    return flattened;
}

// Agent card — redesigned for configuration focus with entity identity colors
function AgentCard({ agent, isCore, isPlugin, entityColor, onNavigate, onEdit, onDelete, onChat, canEdit }) {
    const name = agent?.name || 'Unknown Agent';
    const role = agent?.role || AGENT_LEVELS.find(l => l.value === agent?.level)?.label || 'Agent';
    const description = agent?.description || 'No description available';
    const domains = agent?.domains || [];
    const toolCount = (agent?.tools || []).length + (agent?.tool_count ?? 0);
    const workflowCount = (agent?.workflows || []).length;
    const color = entityColor || '#8b5cf6';

    const handleClick = (e) => {
        if (e.target.closest('.agent-card__actions')) return;
        onNavigate(agent);
    };

    return (
        <div
            className={`agent-card ${isCore ? 'agent-card--core' : ''}`}
            onClick={handleClick}
            style={{
                cursor: 'pointer',
                '--agent-color': color,
                borderLeft: `3px solid ${color}40`,
            }}
        >
            <div className="agent-card__header">
                <div
                    className="agent-card__avatar"
                    style={{
                        background: `${color}18`,
                        color: color,
                    }}
                >
                    {agent?.icon || name[0] || 'A'}
                </div>
                <div className="agent-card__info">
                    <div className="agent-card__name">
                        {name}
                        {isCore && !isPlugin && (
                            <span className="agent-card__badge agent-card__badge--core">CORE</span>
                        )}
                        {isPlugin && (
                            <span className="agent-card__badge agent-card__badge--plugin" title="Plugin agent">
                                <PluginIcon /> PLUGIN
                            </span>
                        )}
                        {!isCore && !isPlugin && (agent?.capabilities || []).includes('mcp_invoke') && (
                            <span className="agent-card__badge agent-card__badge--power" title="Deployed via DeployPowerWizard (external repo or MCP endpoint)">POWER</span>
                        )}
                        {!isCore && !isPlugin && !(agent?.capabilities || []).includes('mcp_invoke') && (
                            <span className="agent-card__badge agent-card__badge--custom">CUSTOM</span>
                        )}
                    </div>
                    <div className="agent-card__role">
                        L{agent?.level ?? 2}: {role}
                    </div>
                </div>
            </div>
            <div className="agent-card__description">
                {description}
            </div>
            <div className="agent-card__meta">
                {domains.length > 0 && (
                    <div className="agent-card__domains">
                        {domains.slice(0, 3).map((domain, i) => (
                            <span
                                key={i}
                                className="domain-tag"
                                style={{
                                    background: `${DOMAIN_COLORS[domain] || '#888'}15`,
                                    color: DOMAIN_COLORS[domain] || '#888',
                                }}
                            >
                                {domain}
                            </span>
                        ))}
                        {domains.length > 3 && (
                            <span className="domain-tag domain-tag--more">+{domains.length - 3}</span>
                        )}
                    </div>
                )}
            </div>
            <div className="agent-card__footer">
                <div className="agent-card__stats">
                    <span className="agent-card__stat" title={`${toolCount} tools`}>
                        <ToolIcon />
                        <span className="agent-card__stat-value">{toolCount}</span>
                        <span className="agent-card__stat-label">tools</span>
                    </span>
                    {workflowCount > 0 && (
                        <span className="agent-card__stat" title={`${workflowCount} workflows`}>
                            <WorkflowIcon />
                            <span className="agent-card__stat-value">{workflowCount}</span>
                            <span className="agent-card__stat-label">workflows</span>
                        </span>
                    )}
                </div>
                {!isCore && canEdit ? (
                    <div className="agent-card__actions">
                        <button
                            className="agent-card__action"
                            onClick={() => onEdit?.(agent)}
                            title="Edit agent"
                        >
                            <EditIcon />
                        </button>
                        <button
                            className="agent-card__action agent-card__action--danger"
                            onClick={() => onDelete?.(agent)}
                            title="Delete agent"
                        >
                            <TrashIcon />
                        </button>
                    </div>
                ) : (
                    <div className="agent-card__actions">
                        <button
                            className="agent-card__action"
                            onClick={() => onChat?.(agent)}
                            title="Chat with agent"
                        >
                            <ChatIcon />
                        </button>
                        <button className="agent-card__configure" onClick={() => onNavigate(agent)}>
                            Configure <ArrowRightIcon />
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

// Main view content
function AgentsViewContent() {
    const navigate = useNavigate();
    const { isOrgAdmin, currentOrg, scopeTree } = useWorkspace();
    const {
        agents: userAgents,
        loading,
        error,
        loadAgents,
        createAgent,
        updateAgent,
        deleteAgent,
    } = useAgents();

    const [activeFilter, setActiveFilter] = useState('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [savingAgent, setSavingAgent] = useState(false);
    const { setPageActions } = useOutletContext() || {};

    // Load core + plugin agents from registry (excludes QUOX — it's an Assistant)
    // Also includes installed Chief Team agents as plugin agents
    const { coreAgents, pluginAgents } = useMemo(() => {
        const core = [];
        const plugin = [];
        try {
            const agentsObj = agentRegistry?.agents || {};
            Object.entries(agentsObj)
                .filter(([id, agent]) => agent && typeof agent === 'object' && id !== 'quox')
                .forEach(([id, agent]) => {
                    const card = generateIdentityCard(id);
                    const entry = {
                        id,
                        ...agent,
                        isCore: true,
                        _source: agent.source || (agent.requiresPlugin ? 'plugin' : 'core'),
                        _color: card?.color || '#8b5cf6',
                    };
                    if (entry._source === 'plugin') {
                        plugin.push(entry);
                    } else {
                        core.push(entry);
                    }
                });

            // Add Chief Team agents (from chiefs registry) as plugin agents
            Object.values(chiefs).forEach(chief => {
                plugin.push({
                    id: `chief-${chief.id}`,
                    name: chief.name,
                    role: chief.role || 'specialist',
                    level: chief.level ?? 1,
                    description: chief.description,
                    domains: [chief.specialty?.split(' ')[0]?.toLowerCase() || 'strategy'],
                    tools: [],
                    workflows: [],
                    isCore: false,
                    _source: 'plugin',
                    _isChief: true,
                    _chiefId: chief.id,
                    _color: chief.color || '#1e293b',
                    tier: chief.tier,
                });
            });
        } catch { /* */ }
        return { coreAgents: core, pluginAgents: plugin };
    }, []);

    // Build combined + filtered list
    const filteredAgents = useMemo(() => {
        let combined = [];

        if (activeFilter === 'all' || activeFilter === 'core') {
            combined = [...combined, ...coreAgents.map(a => ({ ...a, _type: 'core' }))];
        }
        if (activeFilter === 'all' || activeFilter === 'plugin') {
            combined = [...combined, ...pluginAgents.map(a => ({ ...a, _type: 'plugin' }))];
        }
        if (activeFilter === 'all' || activeFilter === 'custom') {
            combined = [...combined, ...userAgents.map(a => ({ ...a, _type: 'custom' }))];
        }

        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            combined = combined.filter(agent => {
                const name = (agent.name || '').toLowerCase();
                const id = (agent.id || '').toLowerCase();
                const domains = (agent.domains || []).join(' ').toLowerCase();
                const desc = (agent.description || '').toLowerCase();
                return name.includes(q) || id.includes(q) || domains.includes(q) || desc.includes(q);
            });
        }

        return combined;
    }, [activeFilter, searchQuery, coreAgents, pluginAgents, userAgents]);

    const canManageAgents = isOrgAdmin || currentOrg?.membership?.role === 'builder';
    const scopeOptions = useMemo(() => flattenAgentScopeOptions(scopeTree), [scopeTree]);

    useEffect(() => {
        setPageActions?.(canManageAgents && currentOrg ? (
            <Button variant="primary" onClick={() => setShowCreateModal(true)}>
                <PlusIcon />
                <span style={{ marginLeft: '6px' }}>Create Agent</span>
            </Button>
        ) : null);
        return () => setPageActions?.(null);
    }, [setPageActions, canManageAgents, currentOrg]);

    // Handlers
    const handleNavigate = (agent) => {
        navigate(`/agents/${agent.id}`);
    };

    const handleChat = (agent) => {
        // For chiefs, use the chief ID directly; for regular agents, use agent.id
        const assistantId = agent._chiefId || agent.id;
        navigate('/', { state: { assistant: assistantId } });
    };

    const handleCreateAgent = async (data) => {
        setSavingAgent(true);
        try {
            await createAgent(data);
            setShowCreateModal(false);
        } catch (err) {
            throw err;
        } finally {
            setSavingAgent(false);
        }
    };

    const handleEditAgent = (agent) => {
        // Navigate to unified editor in Settings (AUX: single editor, not separate modal)
        navigate('/settings', { state: { section: 'assistants', editAgent: agent.id } });
    };

    // handleUpdateAgent removed — edit goes to Settings > Assistants (unified editor)

    const handleDeleteAgent = async (agent) => {
        if (!confirm(`Delete agent "${agent.name}"? This cannot be undone.`)) return;
        try {
            await deleteAgent(agent.id);
        } catch (err) {
            alert('Failed to delete agent: ' + err.message);
        }
    };

    const totalCount = coreAgents.length + pluginAgents.length + userAgents.length;

    return (
        <div className="agents-view view-page" role="main" aria-label="Agents">
            <LLMAuthBanner />
            {/* Filter tabs + search */}
            <div className="agents-view__filters">
                <div className="agents-view__filter-tabs">
                    {FILTER_TABS.map(tab => (
                        <button
                            key={tab.id}
                            className={`agents-view__filter-tab ${activeFilter === tab.id ? 'agents-view__filter-tab--active' : ''}`}
                            onClick={() => setActiveFilter(tab.id)}
                        >
                            {tab.label}
                            {tab.id === 'core' && <span style={{ marginLeft: 4, opacity: 0.6 }}>({coreAgents.length})</span>}
                            {tab.id === 'plugin' && <span style={{ marginLeft: 4, opacity: 0.6 }}>({pluginAgents.length})</span>}
                            {tab.id === 'custom' && <span style={{ marginLeft: 4, opacity: 0.6 }}>({userAgents.length})</span>}
                        </button>
                    ))}
                </div>
                <input
                    type="text"
                    className="agents-view__search"
                    placeholder="Search agents..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                />
            </div>

            {/* Agent grid */}
            {loading && activeFilter !== 'core' ? (
                <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                    Loading agents...
                </div>
            ) : error && activeFilter === 'custom' ? (
                <div style={{ padding: '48px', textAlign: 'center', color: '#ff3b30' }}>
                    {error}
                    <Button variant="secondary" size="sm" onClick={loadAgents} style={{ marginLeft: '12px' }}>
                        Retry
                    </Button>
                </div>
            ) : filteredAgents.length === 0 ? (
                <div className="empty-state">
                    <div className="empty-state__title">
                        {searchQuery ? 'No Matching Agents' : 'No Custom Agents'}
                    </div>
                    <div className="empty-state__description">
                        {searchQuery
                            ? `No agents match "${searchQuery}". Try a different search term.`
                            : 'Create custom agents for your organization to extend capabilities.'
                        }
                    </div>
                    {!searchQuery && canManageAgents && (
                        <Button variant="primary" onClick={() => setShowCreateModal(true)}>
                            Create First Agent
                        </Button>
                    )}
                </div>
            ) : (
                <PageGrid columns={3}>
                    {filteredAgents.map(agent => (
                        <AgentCard
                            key={agent.id}
                            agent={agent}
                            isCore={agent._type === 'core'}
                            isPlugin={agent._source === 'plugin' || agent._type === 'plugin'}
                            entityColor={agent._color}
                            onNavigate={handleNavigate}
                            onChat={handleChat}
                            onEdit={handleEditAgent}
                            onDelete={handleDeleteAgent}
                            canEdit={canManageAgents}
                        />
                    ))}
                </PageGrid>
            )}

            {/* Create Agent Modal */}
            <AgentConfigModal
                isOpen={showCreateModal}
                onClose={() => setShowCreateModal(false)}
                onSubmit={handleCreateAgent}
                agents={userAgents}
                scopes={scopeOptions}
                loading={savingAgent}
            />

            {/* Edit Agent — redirects to Settings > Assistants (unified editor) */}
        </div>
    );
}

// Wrapper with AgentProvider
function AgentsView() {
    return (
        <AgentProvider>
            <AgentsViewContent />
        </AgentProvider>
    );
}

export default AgentsView;
