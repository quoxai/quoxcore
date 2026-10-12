/**
 * AgentDetailView - Full-page Agent Configuration
 *
 * Configuration-first detail view for agents at /agents/:agentId
 * Tabs: Overview, Tools, Prompt, Workflows
 *
 * Resolves agent data from TWO sources:
 * 1. Core registry — agentRegistry.agents[agentId] for base definition
 * 2. API — /api/orgs/:orgId/agents/:agentId for user agents or core overrides
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { PageHeader } from '../../components/layout';
import { AgentToolsPanel } from '../../components/agents';
import Button from '../../components/ui/Button';
import ModelSelector from '../../components/chat/ModelSelector';
import { agentRegistry } from '../../config/agentRegistry';
import { generateIdentityCard, updateAssistant, resetAssistant } from '../../services/entityRegistry';
import { DEFAULT_LLM_CONFIG } from '../../services/llmService';
import { DEFAULT_LLM_POLICY, getLlmPolicyDescription, getLlmPolicyLabel, isLlmPolicyHardLocked, normalizeLlmPolicy } from '../../services/llmPolicy';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import {
    useAgents,
    AgentProvider,
    AGENT_LEVELS,
    TOOL_LIMITS
} from '../../contexts/AgentContext';
import VisualizationStudioEditor from '../../components/visualizations-v2/settings/VisualizationStudioEditor';
import { useVoiceSelector } from '../../hooks/useVoiceSettings';
import { VOICE_LIBRARY } from '../../services/voiceSettings';
import { listWorkflows, listExecutions } from '../../services/workflowEngine';
import { listCrystals } from '../../services/quoxflowClient';
import { listScheduleTriggers } from '../../services/triggersClient';
import './views.css';
import LLMAuthBanner from '../../components/ui/LLMAuthBanner'
import { AgentProfileBadges } from '../../components/agents/AgentProfileBadges.jsx'
import AgentStandingWidget from '../../components/agents/AgentStandingWidget.jsx'
import { HonestyLeaderboardTab } from '../../components/agents/HonestyLeaderboardTab'

// Icons
const BackIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="15 18 9 12 15 6"/>
    </svg>
);

const ChatIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
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

const ResetIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="1 4 1 10 7 10"/>
        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
    </svg>
);

// DEFCON level colors
const DEFCON_COLORS = {
    GREEN: { bg: 'rgba(74, 222, 128, 0.15)', color: '#4ade80', label: 'GREEN' },
    BLUE: { bg: 'rgba(96, 165, 250, 0.15)', color: '#60a5fa', label: 'BLUE' },
    AMBER: { bg: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24', label: 'AMBER' },
    ORANGE: { bg: 'rgba(251, 146, 60, 0.15)', color: '#fb923c', label: 'ORANGE' },
    RED: { bg: 'rgba(248, 113, 113, 0.15)', color: '#f87171', label: 'RED' },
};

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

const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'honesty', label: 'Honesty' },
    { id: 'llm', label: 'LLM' },
    { id: 'visualiser', label: 'Visualiser' },
    { id: 'voice', label: 'Voice' },
    { id: 'tools', label: 'Tools' },
    { id: 'prompt', label: 'Prompt' },
    { id: 'workflows', label: 'Workflows' },
    { id: 'crystals', label: 'Crystals' },
    { id: 'runs', label: 'Runs' },
    { id: 'schedules', label: 'Schedules' },
];

// Helper: format relative time without external deps
function relativeTime(isoString) {
    if (!isoString) return '—';
    const diff = Date.now() - new Date(isoString).getTime();
    if (isNaN(diff)) return isoString;
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
}

// Helper: format duration from two ISO strings
function formatDuration(startIso, endIso) {
    if (!startIso || !endIso) return '—';
    const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
    if (isNaN(ms) || ms < 0) return '—';
    if (ms < 1000) return `${ms}ms`;
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    return `${mins}m ${secs % 60}s`;
}

function normalizeAgentLlm(agent) {
    return {
        ...DEFAULT_LLM_CONFIG,
        ...(agent?.config?.llm || {})
    };
}

function normalizeAgentLlmPolicy(agent, agentId) {
    return normalizeLlmPolicy(agent?.config?.llmPolicy || agent?.llmPolicy || null, { entityId: agentId });
}

/**
 * Merge registry base definition with API overrides.
 * Registry provides the "base"; API provides user overrides/additions.
 */
function mergeAgent(registryAgent, apiAgent) {
    if (!registryAgent && !apiAgent) return null;
    if (!registryAgent) return apiAgent;
    if (!apiAgent) {
        return {
            ...registryAgent,
            _isCore: true,
            _hasOverride: false,
        };
    }
    return {
        ...registryAgent,
        ...apiAgent,
        // Merge tools: base + assigned
        tools: registryAgent.tools || [],
        assignedTools: apiAgent.tools || apiAgent.assignedTools || [],
        // Merge prompt additions
        system_prompt_additions: apiAgent.system_prompt_additions || '',
        _isCore: true,
        _hasOverride: true,
    };
}

function AgentDetailContent() {
    const { agentId } = useParams();
    const navigate = useNavigate();
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();
    const {
        selectedAgent,
        selectedAgentTools,
        selectedAgentToolStatus,
        selectAgent,
        assignTool,
        updateToolAssignment,
        revokeTool,
        getAgent: getAgentFromApi,
        saveCoreOverride,
        resetCoreOverride,
        getMergedAgent,
    } = useAgents();

    const [activeTab, setActiveTab] = useState('overview');
    const [agent, setAgent] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [promptAdditions, setPromptAdditions] = useState('');
    const [savingPrompt, setSavingPrompt] = useState(false);
    const [promptSaved, setPromptSaved] = useState(false);
    const [llmSettings, setLlmSettings] = useState({ ...DEFAULT_LLM_CONFIG });
    const [llmPolicy, setLlmPolicy] = useState({ ...DEFAULT_LLM_POLICY });
    const [savingLlm, setSavingLlm] = useState(false);
    const [llmSaved, setLlmSaved] = useState(false);
    const [voicePreviewing, setVoicePreviewing] = useState(false);

    // Workflows (fetched from API — replaces registry stub)
    const [fetchedWorkflows, setFetchedWorkflows] = useState([]);
    const [workflowsLoading, setWorkflowsLoading] = useState(false);
    const [workflowsError, setWorkflowsError] = useState(null);
    const [workflowsFetched, setWorkflowsFetched] = useState(false);

    // Crystals
    const [crystals, setCrystals] = useState([]);
    const [crystalsLoading, setCrystalsLoading] = useState(false);
    const [crystalsError, setCrystalsError] = useState(null);

    // Runs
    const [runs, setRuns] = useState([]);
    const [runsLoading, setRunsLoading] = useState(false);
    const [runsError, setRunsError] = useState(null);

    // Schedules
    const [schedules, setSchedules] = useState([]);
    const [schedulesLoading, setSchedulesLoading] = useState(false);
    const [schedulesError, setSchedulesError] = useState(null);

    // Voice settings — must be called before any early return (React hooks rule)
    const { voicesByCategory, agents: voiceAgents, setAgentVoice, VOICE_CATEGORIES } = useVoiceSelector();
    const currentVoiceAgent = voiceAgents.find(a => a.agentId === agentId);
    const currentVoiceKey = currentVoiceAgent?.voiceKey || 'american_female_1';
    const currentVoice = VOICE_LIBRARY[currentVoiceKey];

    // Resolve agent from registry + API
    const registryAgent = useMemo(() => {
        const agentsObj = agentRegistry?.agents || {};
        return agentsObj[agentId] ? { id: agentId, ...agentsObj[agentId] } : null;
    }, [agentId]);

    const buildCoreOverridePayload = useCallback((extra = {}) => ({
        name: registryAgent?.name || agent?.name || agentId.toUpperCase(),
        description: registryAgent?.description || agent?.description || '',
        icon: registryAgent?.icon || agent?.icon || null,
        level: registryAgent?.level ?? agent?.level ?? 1,
        domains: registryAgent?.domains || agent?.domains || [],
        capabilities: registryAgent?.capabilities || agent?.capabilities || [],
        ...extra,
    }), [agent, agentId, registryAgent]);

    // Get entity identity color
    const entityColor = useMemo(() => {
        const card = generateIdentityCard(agentId);
        return card?.color || '#8b5cf6';
    }, [agentId]);

    const loadAgent = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            if (registryAgent) {
                const merged = getMergedAgent(agentId, registryAgent);
                if (!merged) {
                    setError('Agent not found');
                } else {
                    setAgent(merged);
                    setPromptAdditions(merged.system_prompt_additions || '');
                    setLlmSettings(normalizeAgentLlm(merged));
                    setLlmPolicy(normalizeAgentLlmPolicy(merged, agentId));
                }
                return;
            }

            let apiAgent = null;
            if (currentOrg?.id) {
                apiAgent = await getAgentFromApi(agentId);
            }
            const merged = mergeAgent(registryAgent, apiAgent);
            if (!merged) {
                setError('Agent not found');
            } else {
                setAgent(merged);
                setPromptAdditions(merged.system_prompt_additions || '');
                setLlmSettings(normalizeAgentLlm(merged));
                setLlmPolicy(normalizeAgentLlmPolicy(merged, agentId));
                // Select agent to load tools
                if (currentOrg?.id && (apiAgent || !registryAgent)) {
                    await selectAgent(apiAgent || merged);
                }
            }
        } catch (err) {
            console.error('Failed to load agent:', err);
            // If API fails but we have registry data, show that
            if (registryAgent) {
                const mergedFallback = mergeAgent(registryAgent, null);
                setAgent(mergedFallback);
                setPromptAdditions('');
                setLlmSettings(normalizeAgentLlm(mergedFallback));
                setLlmPolicy(normalizeAgentLlmPolicy(mergedFallback, agentId));
            } else {
                setError('Failed to load agent');
            }
        } finally {
            setLoading(false);
        }
    }, [agentId, currentOrg?.id, registryAgent, getAgentFromApi, selectAgent, getMergedAgent]);

    useEffect(() => {
        loadAgent();
    }, [loadAgent]);

    // Fetch real workflows from the API. Eager so Runs/Schedules tabs can reuse.
    useEffect(() => {
        if (loading || workflowsFetched) return;
        setWorkflowsFetched(true);
        setWorkflowsLoading(true);
        setWorkflowsError(null);
        listWorkflows()
            .then(({ workflows }) => {
                const agentWfs = workflows.filter(wf => {
                    const meta = wf.metadata || wf.definition?.metadata || {};
                    return meta.agent === agentId || wf.definition?.metadata?.agent === agentId;
                });
                setFetchedWorkflows(agentWfs);
            })
            .catch(err => {
                console.error('[AgentDetail] Failed to fetch workflows:', err);
                setWorkflowsError(err.message || 'Failed to load workflows');
            })
            .finally(() => setWorkflowsLoading(false));
    }, [agentId, loading, workflowsFetched]);

    // Crystals — lazy: fetch when tab is opened
    useEffect(() => {
        if (activeTab !== 'crystals') return;
        setCrystalsLoading(true);
        setCrystalsError(null);
        const orgId = (() => { try { return localStorage.getItem('current_org_id') || undefined; } catch { return undefined; } })();
        listCrystals({ orgId })
            .then(rows => {
                const wfIds = new Set(fetchedWorkflows.map(w => w.id));
                const filtered = (rows || []).filter(row => {
                    // /quoxflow/api/skills returns camelCase. Earlier snake_case
                    // checks silently matched zero rows, so the tab read empty
                    // even when the agent had earned canonicals.
                    const swid = row.sourceWorkflowId || row.source_workflow_id;
                    if (swid && swid.includes(`::${agentId}::`)) return true;
                    const wfId = row.workflowId || row.workflow_id;
                    if (wfId && wfIds.has(wfId)) return true;
                    return false;
                });
                setCrystals(filtered);
            })
            .catch(err => {
                console.error('[AgentDetail] Failed to fetch crystals:', err);
                setCrystalsError(err.message || 'Failed to load crystals');
            })
            .finally(() => setCrystalsLoading(false));
    }, [activeTab, agentId, fetchedWorkflows]);

    // Runs — lazy: fetch when tab is opened
    useEffect(() => {
        if (activeTab !== 'runs') return;
        if (fetchedWorkflows.length === 0) {
            setRuns([]);
            return;
        }
        setRunsLoading(true);
        setRunsError(null);
        const perWf = fetchedWorkflows.map(wf =>
            listExecutions({ workflowId: wf.id, limit: 25 })
                .then(r => r.executions || [])
                .catch(() => [])
        );
        Promise.all(perWf)
            .then(results => {
                const merged = results.flat()
                    .sort((a, b) => new Date(b.startedAt || b.started_at || 0) - new Date(a.startedAt || a.started_at || 0))
                    .slice(0, 50);
                setRuns(merged);
            })
            .catch(err => {
                console.error('[AgentDetail] Failed to fetch runs:', err);
                setRunsError(err.message || 'Failed to load runs');
            })
            .finally(() => setRunsLoading(false));
    }, [activeTab, fetchedWorkflows]);

    // Schedules — lazy: fetch when tab is opened
    useEffect(() => {
        if (activeTab !== 'schedules') return;
        setSchedulesLoading(true);
        setSchedulesError(null);
        const wfIds = new Set(fetchedWorkflows.map(w => w.id));
        listScheduleTriggers({ authFetch })
            .then(data => {
                const rows = data?.schedules || data || [];
                const filtered = rows.filter(row => wfIds.has(row.workflowId));
                setSchedules(filtered);
            })
            .catch(err => {
                console.error('[AgentDetail] Failed to fetch schedules:', err);
                setSchedulesError(err.message || 'Failed to load schedules');
            })
            .finally(() => setSchedulesLoading(false));
    }, [activeTab, fetchedWorkflows, authFetch]);

    // Tool handlers
    const handleAssignTool = async (toolInstallationId, options) => {
        if (!agent) return;
        const targetId = agent._isCore ? agentId : agent.id;
        await assignTool(targetId, toolInstallationId, options);
    };

    const handleUpdateToolMode = async (assignmentId, updates) => {
        if (!agent) return;
        const targetId = agent._isCore ? agentId : agent.id;
        await updateToolAssignment(targetId, assignmentId, updates);
    };

    const handleRevokeTool = async (assignmentId) => {
        if (!agent) return;
        const targetId = agent._isCore ? agentId : agent.id;
        await revokeTool(targetId, assignmentId);
    };

    // Prompt save handler
    const handleSavePrompt = async () => {
        if (!currentOrg?.id) return;
        setSavingPrompt(true);
        try {
            if (agent._isCore) {
                await saveCoreOverride(agentId, buildCoreOverridePayload({
                    system_prompt_additions: promptAdditions,
                    config: agent.config || {},
                }));
                const merged = getMergedAgent(agentId, registryAgent) || mergeAgent(registryAgent, null);
                setAgent(merged);
                setPromptAdditions(merged?.system_prompt_additions || promptAdditions);
            } else {
                await authFetch(`/api/orgs/${currentOrg.id}/agents/${agent.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ system_prompt_additions: promptAdditions }),
                });
            }
            setPromptSaved(true);
            setTimeout(() => setPromptSaved(false), 2000);
        } catch (err) {
            console.error('Failed to save prompt additions:', err);
        } finally {
            setSavingPrompt(false);
        }
    };

    // Chat navigation
    const handleChat = () => {
        navigate('/', { state: { assistant: agentId } });
    };

    const handleSaveLlm = async () => {
        if (!currentOrg?.id) return;
        setSavingLlm(true);
        try {
            const nextConfig = {
                ...(agent.config || {}),
                llm: {
                    ...DEFAULT_LLM_CONFIG,
                    ...llmSettings
                },
                llmPolicy: {
                    ...llmPolicy
                },
            };

            if (agent._isCore) {
                await saveCoreOverride(agentId, buildCoreOverridePayload({
                    system_prompt_additions: promptAdditions || '',
                    config: nextConfig,
                }));
                updateAssistant(agentId, { llm: nextConfig.llm });
                updateAssistant(agentId, { llmPolicy: nextConfig.llmPolicy });
                const merged = getMergedAgent(agentId, registryAgent) || {
                    ...mergeAgent(registryAgent, null),
                    config: nextConfig,
                };
                setAgent(merged);
                setLlmSettings(normalizeAgentLlm(merged));
                setLlmPolicy(normalizeAgentLlmPolicy(merged, agentId));
            } else {
                const response = await authFetch(`/api/orgs/${currentOrg.id}/agents/${agent.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ config: nextConfig }),
                });
                if (!response.ok) {
                    throw new Error('Failed to save agent LLM settings');
                }
                const data = await response.json();
                setAgent(data.agent);
                setLlmSettings(normalizeAgentLlm(data.agent));
                setLlmPolicy(normalizeAgentLlmPolicy(data.agent, agentId));
            }
            setLlmSaved(true);
            setTimeout(() => setLlmSaved(false), 2000);
        } catch (err) {
            console.error('Failed to save agent llm settings:', err);
        } finally {
            setSavingLlm(false);
        }
    };

    const handleResetLlm = async () => {
        if (!agent?._isCore) return;
        setSavingLlm(true);
        try {
            await resetCoreOverride(agentId);
            resetAssistant(agentId);
            const merged = getMergedAgent(agentId, registryAgent) || mergeAgent(registryAgent, null);
            setAgent(merged);
            setLlmSettings(normalizeAgentLlm(merged));
            setLlmPolicy(normalizeAgentLlmPolicy(merged, agentId));
            setLlmSaved(false);
        } catch (err) {
            console.error('Failed to reset core LLM override:', err);
        } finally {
            setSavingLlm(false);
        }
    };

    // Voice preview — speaks a sample sentence using the selected voice
    const handleVoicePreview = async () => {
        if (voicePreviewing) return;
        setVoicePreviewing(true);
        try {
            const name = agent?.name || agentId.toUpperCase();
            const desc = agent?.description || 'I help with various tasks';
            const previewText = `I am ${name}. ${desc}.`;
            const voice = VOICE_LIBRARY[currentVoiceKey];
            if (!voice?.voiceId) { setVoicePreviewing(false); return; }

            const resp = await fetch('/webhook/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: previewText,
                    voice_id: voice.voiceId,
                    model_id: 'eleven_multilingual_v2'
                })
            });
            if (resp.ok) {
                const blob = await resp.blob();
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                audio.onended = () => { URL.revokeObjectURL(url); setVoicePreviewing(false); };
                audio.onerror = () => { URL.revokeObjectURL(url); setVoicePreviewing(false); };
                await audio.play();
            } else {
                setVoicePreviewing(false);
            }
        } catch {
            setVoicePreviewing(false);
        }
    };

    if (loading) {
        return (
            <div className="agent-detail view-page">
                <div className="agent-detail__loading">
                    <div className="loading-spinner loading-spinner--small" />
                    <span>Loading agent configuration...</span>
                </div>
            </div>
        );
    }

    if (error || !agent) {
        return (
            <div className="agent-detail view-page">
                <div className="agent-detail__error">
                    <span>{error || 'Agent not found'}</span>
                    <Button variant="secondary" size="sm" onClick={() => navigate('/agents')}>
                        <BackIcon /> Back to Agents
                    </Button>
                </div>
            </div>
        );
    }

    const isCore = !!registryAgent;
    const agentName = agent.name || agentId.toUpperCase();
    const levelLabel = AGENT_LEVELS.find(l => l.value === agent.level)?.label || 'Agent';
    const defcon = DEFCON_COLORS[agent.defconLevel] || DEFCON_COLORS.GREEN;
    const baseToolCount = (agent.tools || []).length;
    const assignedToolCount = selectedAgentTools?.length || 0;
    const totalToolCount = baseToolCount + assignedToolCount;
    const workflowCount = fetchedWorkflows.length;
    const source = agent.source || (isCore ? 'core' : 'user');
    const isPlugin = source === 'plugin';
    const llmPolicyLabel = getLlmPolicyLabel(llmPolicy);
    const llmPolicyDescription = getLlmPolicyDescription(llmPolicy);
    const llmPolicyHardLocked = isLlmPolicyHardLocked(llmPolicy);

    return (
        <div className="agent-detail view-page">
            <LLMAuthBanner />
            {/* Header */}
            <div className="agent-detail__header">
                <div className="agent-detail__header-top">
                    <button className="agent-detail__back" onClick={() => navigate('/agents')}>
                        <BackIcon /> Back to Agents
                    </button>
                    <div className="agent-detail__header-actions">
                        <Button variant="secondary" size="sm" onClick={handleChat}>
                            <ChatIcon />
                            <span style={{ marginLeft: '6px' }}>Chat</span>
                        </Button>
                    </div>
                </div>
                <div className="agent-detail__title-row">
                    <div
                        className="agent-detail__avatar"
                        style={{
                            background: `${entityColor}18`,
                            color: entityColor,
                            borderColor: `${entityColor}30`,
                        }}
                    >
                        {agent.icon || agentName[0] || 'A'}
                    </div>
                    <div className="agent-detail__title-info">
                        <h1 className="agent-detail__name">
                            {agentName}
                            <span className="agent-detail__level">L{agent.level ?? 1}: {levelLabel}</span>
                            {isCore && (
                                <span className="agent-detail__badge agent-detail__badge--core">CORE</span>
                            )}
                            {isPlugin && (
                                <span className="agent-detail__badge agent-detail__badge--plugin">PLUGIN</span>
                            )}
                            {!isCore && (
                                <span className="agent-detail__badge agent-detail__badge--custom">CUSTOM</span>
                            )}
                        </h1>
                        <AgentProfileBadges agentId={agentId} variant="detail" />
                        <AgentStandingWidget agentId={agentId} />
                        <p className="agent-detail__description">{agent.description}</p>
                    </div>
                </div>
                {/* Link to unified editor in Settings */}
                <button
                    onClick={() => navigate('/settings', { state: { section: 'assistants', editAgent: agentId } })}
                    style={{
                        padding: '6px 14px', fontSize: 11, fontWeight: 600,
                        background: 'rgba(168, 85, 247, 0.08)', border: '1px solid rgba(168, 85, 247, 0.2)',
                        borderRadius: 8, cursor: 'pointer', color: '#a855f7', fontFamily: 'inherit',
                        marginLeft: 'auto', flexShrink: 0,
                    }}
                >
                    Full Configuration
                </button>
            </div>

            {/* Tabs */}
            <div className="agent-detail__tabs" role="tablist">
                {TABS.map(tab => (
                    <button
                        key={tab.id}
                        className={`agent-detail__tab ${activeTab === tab.id ? 'agent-detail__tab--active' : ''}`}
                        onClick={() => setActiveTab(tab.id)}
                        role="tab"
                        aria-selected={activeTab === tab.id}
                    >
                        {tab.label}
                        {tab.id === 'tools' && <span className="agent-detail__tab-count">{totalToolCount}</span>}
                        {tab.id === 'workflows' && workflowCount > 0 && <span className="agent-detail__tab-count">{workflowCount}</span>}
                        {tab.id === 'crystals' && crystals.length > 0 && <span className="agent-detail__tab-count">{crystals.length}</span>}
                        {tab.id === 'runs' && runs.length > 0 && <span className="agent-detail__tab-count">{runs.length}</span>}
                        {tab.id === 'schedules' && schedules.length > 0 && <span className="agent-detail__tab-count">{schedules.length}</span>}
                    </button>
                ))}
            </div>

            {/* Tab Content */}
            <div className="agent-detail__content">
                {/* Honesty Tab */}
                {activeTab === 'honesty' && (
                    <HonestyLeaderboardTab agentId={agentId} />
                )}

                {/* Overview Tab */}
                {activeTab === 'overview' && (
                    <div className="agent-detail__overview">
                        <div className="agent-detail__overview-grid">
                            {/* Left column */}
                            <div className="agent-detail__overview-left">
                                {/* Capabilities */}
                                {agent.capabilities?.length > 0 && (
                                    <div className="agent-detail__section">
                                        <h3 className="agent-detail__section-title">Capabilities</h3>
                                        <div className="agent-detail__capability-list">
                                            {agent.capabilities.map((cap, i) => (
                                                <span key={i} className="agent-detail__capability-tag">
                                                    {cap.replace(/_/g, ' ')}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Domains */}
                                {agent.domains?.length > 0 && (
                                    <div className="agent-detail__section">
                                        <h3 className="agent-detail__section-title">Domains</h3>
                                        <div className="agent-detail__domain-list">
                                            {agent.domains.map((domain, i) => (
                                                <span
                                                    key={i}
                                                    className="agent-detail__domain-tag"
                                                    style={{
                                                        background: `${DOMAIN_COLORS[domain] || '#888'}20`,
                                                        color: DOMAIN_COLORS[domain] || '#888',
                                                        borderColor: `${DOMAIN_COLORS[domain] || '#888'}40`,
                                                    }}
                                                >
                                                    {domain}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Personality */}
                                {agent.personality && (
                                    <div className="agent-detail__section">
                                        <h3 className="agent-detail__section-title">Personality</h3>
                                        <div className="agent-detail__personality">
                                            {agent.personality.tone && (
                                                <div className="agent-detail__personality-item">
                                                    <span className="agent-detail__label">Tone:</span> {agent.personality.tone}
                                                </div>
                                            )}
                                            {agent.personality.verbosity && (
                                                <div className="agent-detail__personality-item">
                                                    <span className="agent-detail__label">Verbosity:</span> {agent.personality.verbosity}
                                                </div>
                                            )}
                                            {agent.personality.formality && (
                                                <div className="agent-detail__personality-item">
                                                    <span className="agent-detail__label">Formality:</span> {agent.personality.formality}
                                                </div>
                                            )}
                                            {agent.personality.traits?.length > 0 && (
                                                <div className="agent-detail__personality-item">
                                                    <span className="agent-detail__label">Traits:</span>
                                                    <div className="agent-detail__trait-list">
                                                        {agent.personality.traits.map((t, i) => (
                                                            <span key={i} className="agent-detail__trait-tag">{t}</span>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Right column */}
                            <div className="agent-detail__overview-right">
                                {/* DEFCON Level */}
                                <div className="agent-detail__section">
                                    <h3 className="agent-detail__section-title">DEFCON Level</h3>
                                    <div
                                        className="agent-detail__defcon"
                                        style={{ background: defcon.bg, color: defcon.color }}
                                    >
                                        {defcon.label}
                                    </div>
                                </div>

                                {/* Hierarchy */}
                                <div className="agent-detail__section">
                                    <h3 className="agent-detail__section-title">Hierarchy</h3>
                                    <div className="agent-detail__hierarchy">
                                        {agent.reportsTo && (
                                            <div className="agent-detail__hierarchy-item">
                                                <span className="agent-detail__label">Reports to:</span>{' '}
                                                <button
                                                    className="agent-detail__link"
                                                    onClick={() => navigate(`/agents/${agent.reportsTo}`)}
                                                >
                                                    {agent.reportsTo.toUpperCase()}
                                                </button>
                                            </div>
                                        )}
                                        {agent.role && (
                                            <div className="agent-detail__hierarchy-item">
                                                <span className="agent-detail__label">Role:</span> {agent.role}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Collaborators */}
                                {agent.collaboratesWith?.length > 0 && (
                                    <div className="agent-detail__section">
                                        <h3 className="agent-detail__section-title">Collaborators</h3>
                                        <div className="agent-detail__collaborator-list">
                                            {agent.collaboratesWith.map((collab, i) => (
                                                <button
                                                    key={i}
                                                    className="agent-detail__collaborator"
                                                    onClick={() => navigate(`/agents/${collab}`)}
                                                >
                                                    {collab.toUpperCase()}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Suggestions */}
                                {agent.suggestions?.length > 0 && (
                                    <div className="agent-detail__section">
                                        <h3 className="agent-detail__section-title">Suggestions</h3>
                                        <div className="agent-detail__suggestion-list">
                                            {agent.suggestions.map((sug, i) => (
                                                <span key={i} className="agent-detail__suggestion">{sug}</span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* LLM Tab */}
                {activeTab === 'llm' && (
                    <div className="agent-detail__llm">
                        <div className="agent-detail__section">
                            <h3 className="agent-detail__section-title">LLM Configuration</h3>
                            <p className="agent-detail__section-desc">
                                {isCore
                                    ? 'Set an org-level override for this core agent. The saved LLM choice is also mirrored into the runtime assistant override path so it takes effect immediately.'
                                    : 'Set the default provider and model for this custom agent. Live chat and credential overrides can still supersede it at runtime.'
                                }
                            </p>
                            <div className="agent-detail__llm-policy-note">
                                <strong>Runtime policy:</strong> {llmPolicyLabel}. {llmPolicyDescription}
                            </div>
                            <div className="agent-config-grid">
                                <div className="agent-config-section">
                                    {!llmPolicyHardLocked && (
                                        <div className="agent-config-field">
                                            <label className="agent-config-field__label" htmlFor="agent-detail-llm-policy">
                                                Runtime Policy
                                            </label>
                                            <select
                                                id="agent-detail-llm-policy"
                                                className="agent-config-select"
                                                value={llmPolicy.mode}
                                                onChange={(e) => {
                                                    setLlmSaved(false);
                                                    setLlmPolicy(normalizeLlmPolicy({
                                                        ...llmPolicy,
                                                        mode: e.target.value,
                                                        lockScope: e.target.value === 'locked' ? 'soft' : 'none',
                                                        reason: e.target.value === 'locked' ? 'manual_specialist_lock' : null,
                                                        note: e.target.value === 'locked'
                                                            ? 'This agent will keep its configured provider/model unless the policy is changed.'
                                                            : null,
                                                    }, { entityId: agentId }));
                                                }}
                                            >
                                                <option value="recommendation">Recommendation</option>
                                                <option value="locked">Specialist lock</option>
                                            </select>
                                        </div>
                                    )}
                                    <div className="agent-config-field">
                                        <div className="agent-config-help">
                                            Runtime policy: <strong>{getLlmPolicyLabel(llmPolicy)}</strong>. {getLlmPolicyDescription(llmPolicy)}
                                        </div>
                                        <div className="agent-config-help">
                                            {llmPolicyHardLocked
                                                ? 'This agent is specialist-locked. Provider and model controls stay fixed until the lock changes.'
                                                : 'This agent only recommends a provider and model. Live user choice, selected credentials, and execution policy can still change what runs.'}
                                        </div>
                                    </div>
                                    <div className="agent-config-field">
                                        <label className="agent-config-field__label">
                                            Provider & Model
                                        </label>
                                        <ModelSelector
                                            provider={llmSettings.provider}
                                            model={llmSettings.model}
                                            disabled={llmPolicyHardLocked}
                                            onChange={(provider, model) => {
                                                setLlmSaved(false);
                                                setLlmSettings(prev => ({ ...prev, provider, model }));
                                            }}
                                            defaultProvider={DEFAULT_LLM_CONFIG.provider}
                                            defaultModel={DEFAULT_LLM_CONFIG.model}
                                        />
                                        {llmPolicyHardLocked && (
                                            <div className="agent-config-help">
                                                Provider and model selection is disabled while this agent is specialist-locked.
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="agent-config-section">
                                    <div className="agent-config-field">
                                        <label className="agent-config-field__label" htmlFor="agent-detail-llm-temperature">
                                            Temperature
                                        </label>
                                        <input
                                            id="agent-detail-llm-temperature"
                                            className="agent-config-select"
                                            type="number"
                                            min="0"
                                            max="2"
                                            step="0.1"
                                            value={llmSettings.temperature}
                                            disabled={llmPolicyHardLocked}
                                            onChange={(e) => {
                                                setLlmSaved(false);
                                                setLlmSettings(prev => ({ ...prev, temperature: parseFloat(e.target.value || DEFAULT_LLM_CONFIG.temperature) }));
                                            }}
                                        />
                                    </div>
                                    <div className="agent-config-field">
                                        <label className="agent-config-field__label" htmlFor="agent-detail-llm-max-tokens">
                                            Max Tokens
                                        </label>
                                        <input
                                            id="agent-detail-llm-max-tokens"
                                            className="agent-config-select"
                                            type="number"
                                            min="1"
                                            step="1"
                                            value={llmSettings.maxTokens}
                                            disabled={llmPolicyHardLocked}
                                            onChange={(e) => {
                                                setLlmSaved(false);
                                                setLlmSettings(prev => ({ ...prev, maxTokens: parseInt(e.target.value || DEFAULT_LLM_CONFIG.maxTokens, 10) }));
                                            }}
                                        />
                                    </div>
                                </div>
                            </div>
                            <div className="agent-detail__prompt-actions">
                                {isCore && agent._hasOverride && (
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={handleResetLlm}
                                        disabled={!currentOrg?.id || savingLlm}
                                    >
                                        Reset to Core Default
                                    </Button>
                                )}
                                <Button
                                    variant="primary"
                                    size="sm"
                                    onClick={handleSaveLlm}
                                    loading={savingLlm}
                                    disabled={!currentOrg?.id}
                                >
                                    {llmSaved ? 'Saved' : 'Save'}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Visualiser Tab */}
                {activeTab === 'visualiser' && (
                    <div className="agent-detail__visualiser">
                        <VisualizationStudioEditor assistantId={agentId} />
                    </div>
                )}

                {/* Voice Tab */}
                {activeTab === 'voice' && (
                    <div className="agent-detail__voice">
                        <div className="agent-detail__section">
                            <h3 className="agent-detail__section-title">Voice Assignment</h3>
                            <p className="agent-detail__section-desc">
                                Select the voice for this agent. Changes sync across the app.
                            </p>
                            <div className="agent-detail__voice-current">
                                <div className="agent-detail__voice-badge">
                                    {currentVoice?.displayName || 'Default Voice'}
                                </div>
                                {currentVoice && (
                                    <span className="agent-detail__voice-meta">
                                        {currentVoice.accent} &middot; {currentVoice.tone}
                                    </span>
                                )}
                            </div>
                            <select
                                className="agent-detail__voice-select"
                                value={currentVoiceKey}
                                onChange={(e) => setAgentVoice(agentId, e.target.value)}
                            >
                                {VOICE_CATEGORIES.map(category => {
                                    const categoryVoices = voicesByCategory[category.key]?.voices || [];
                                    if (categoryVoices.length === 0) return null;
                                    return (
                                        <optgroup key={category.key} label={category.label}>
                                            {categoryVoices.map((voice) => (
                                                <option key={voice.key} value={voice.key}>
                                                    {voice.displayName}
                                                </option>
                                            ))}
                                        </optgroup>
                                    );
                                })}
                            </select>

                            <div className="agent-detail__voice-preview-row">
                                <button
                                    className={`agent-detail__voice-preview-btn ${voicePreviewing ? 'agent-detail__voice-preview-btn--playing' : ''}`}
                                    onClick={handleVoicePreview}
                                    disabled={voicePreviewing}
                                >
                                    <span>{voicePreviewing ? '◼' : '▶'}</span>
                                    {voicePreviewing ? 'Playing...' : 'Preview Voice'}
                                </button>
                                <span className="agent-detail__voice-preview-text">
                                    "I am {agentName}. {agent?.description || '...'}"
                                </span>
                            </div>
                        </div>
                        <div className="agent-detail__section" style={{ marginTop: '16px' }}>
                            <div className="agent-detail__voice-info">
                                <h4>About Voice Settings</h4>
                                <p>Voice assignments are shared across the app. Changing the voice here will also update it in Settings &gt; Voice.</p>
                                <p>Voices require an ElevenLabs API key configured in Settings &gt; Core Integrations.</p>
                            </div>
                        </div>
                    </div>
                )}

                {/* Tools Tab */}
                {activeTab === 'tools' && (
                    <div className="agent-detail__tools">
                        {/* Base tools (read-only from registry) */}
                        {isCore && agent.tools?.length > 0 && (
                            <div className="agent-detail__section">
                                <h3 className="agent-detail__section-title">
                                    Base Tools
                                    <span className="agent-detail__section-badge">{baseToolCount} built-in</span>
                                </h3>
                                <div className="agent-detail__base-tools">
                                    {agent.tools.map((tool, i) => (
                                        <span key={i} className="agent-detail__base-tool">
                                            <ToolIcon /> {tool}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Assigned tools (editable) */}
                        <div className="agent-detail__section">
                            <h3 className="agent-detail__section-title">
                                Assigned Tools
                                {baseToolCount > 0 && (
                                    <span className="agent-detail__section-badge">
                                        {assignedToolCount} of {TOOL_LIMITS.HARD - baseToolCount} available slots
                                    </span>
                                )}
                            </h3>
                            {currentOrg?.id ? (
                                <AgentToolsPanel
                                    agentId={agent._isCore ? agentId : agent.id}
                                    agentName={agentName}
                                    assignments={selectedAgentTools || []}
                                    toolStatus={selectedAgentToolStatus}
                                    onAssign={handleAssignTool}
                                    onUpdateMode={handleUpdateToolMode}
                                    onRevoke={handleRevokeTool}
                                    baseTools={isCore ? agent.tools : undefined}
                                />
                            ) : (
                                <div className="agent-detail__no-org">
                                    Select an organization to manage tool assignments.
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Prompt Tab */}
                {activeTab === 'prompt' && (
                    <div className="agent-detail__prompt">
                        {/* Base system prompt (read-only for core) */}
                        {isCore && agent.systemPrompt && (
                            <div className="agent-detail__section">
                                <h3 className="agent-detail__section-title">Base System Prompt</h3>
                                <pre className="agent-detail__prompt-readonly">
                                    {agent.systemPrompt}
                                </pre>
                            </div>
                        )}

                        {/* Prompt additions (editable) */}
                        <div className="agent-detail__section">
                            <h3 className="agent-detail__section-title">
                                {isCore ? 'Prompt Additions' : 'System Prompt'}
                            </h3>
                            <p className="agent-detail__section-desc">
                                {isCore
                                    ? 'Custom instructions appended to the base system prompt. These additions are merged with the base prompt at runtime.'
                                    : 'The full system prompt for this agent. Define its behavior, constraints, and operational guidelines.'
                                }
                            </p>
                            <textarea
                                className="agent-detail__prompt-editor"
                                value={promptAdditions}
                                onChange={(e) => {
                                    setPromptAdditions(e.target.value);
                                    setPromptSaved(false);
                                }}
                                placeholder={isCore
                                    ? 'Add custom instructions for this agent...'
                                    : 'Define the system prompt for this agent...'
                                }
                                rows={12}
                            />
                            <div className="agent-detail__prompt-actions">
                                <Button
                                    variant="primary"
                                    size="sm"
                                    onClick={handleSavePrompt}
                                    loading={savingPrompt}
                                    disabled={!currentOrg?.id}
                                >
                                    {promptSaved ? 'Saved' : 'Save'}
                                </Button>
                                {isCore && promptAdditions && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => { setPromptAdditions(''); setPromptSaved(false); }}
                                    >
                                        <ResetIcon /> Reset
                                    </Button>
                                )}
                            </div>
                        </div>

                        {/* Live preview */}
                        {isCore && promptAdditions && (
                            <div className="agent-detail__section">
                                <h3 className="agent-detail__section-title">Merged Preview</h3>
                                <pre className="agent-detail__prompt-preview">
                                    {agent.systemPrompt}{'\n\n--- Custom Additions ---\n\n'}{promptAdditions}
                                </pre>
                            </div>
                        )}
                    </div>
                )}

                {/* Workflows Tab — real data from the engine */}
                {activeTab === 'workflows' && (
                    <div className="agent-detail__workflows">
                        {workflowsLoading && (
                            <div className="qx-row qx-row--center" style={{ padding: '24px 0' }}>
                                <span className="qx-spinner qx-spinner--sm" />
                            </div>
                        )}
                        {workflowsError && (
                            <div className="qx-banner qx-banner--error" style={{ marginBottom: 12 }}>
                                {workflowsError}
                            </div>
                        )}
                        {!workflowsLoading && fetchedWorkflows.length > 0 && (
                            <div className="agent-detail__workflow-list">
                                {fetchedWorkflows.map((wf) => {
                                    const wfName = wf.name || wf.id;
                                    const wfMeta = wf.metadata || wf.definition?.metadata || {};
                                    const wfType = wfMeta.type || (wf.active !== false ? 'scheduled' : 'manual');
                                    const isActive = wf.active !== false;
                                    return (
                                        <div key={wf.id} className="agent-detail__workflow-item">
                                            <div className="agent-detail__workflow-icon">
                                                <WorkflowIcon />
                                            </div>
                                            <div className="agent-detail__workflow-info">
                                                <div className="agent-detail__workflow-name">{wfName}</div>
                                                <div className="agent-detail__workflow-type">{wfType}</div>
                                            </div>
                                            <span
                                                className="qx-pill qx-pill--sm"
                                                style={{
                                                    background: isActive ? 'rgba(74,222,128,0.12)' : 'rgba(148,163,184,0.12)',
                                                    color: isActive ? '#4ade80' : '#94a3b8',
                                                    border: `1px solid ${isActive ? 'rgba(74,222,128,0.25)' : 'rgba(148,163,184,0.2)'}`,
                                                }}
                                            >
                                                {isActive ? 'Active' : 'Inactive'}
                                            </span>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => navigate(`/workflow-builder?id=${wf.id}`)}
                                            >
                                                Open
                                            </Button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        {!workflowsLoading && fetchedWorkflows.length === 0 && (
                            <div className="agent-detail__empty">
                                <WorkflowIcon />
                                <p>No workflows assigned to this agent.</p>
                            </div>
                        )}
                    </div>
                )}

                {/* Crystals Tab */}
                {activeTab === 'crystals' && (
                    <div className="agent-detail__crystals">
                        {crystalsLoading && (
                            <div className="qx-row qx-row--center" style={{ padding: '24px 0' }}>
                                <span className="qx-spinner qx-spinner--sm" />
                            </div>
                        )}
                        {crystalsError && (
                            <div className="qx-banner qx-banner--error" style={{ marginBottom: 12 }}>
                                {crystalsError}
                            </div>
                        )}
                        {!crystalsLoading && crystals.length > 0 && (
                            <div className="agent-detail__workflow-list">
                                {/* TODO: deep link to individual crystal when /crystals/:id is available */}
                                {crystals.map((crystal) => {
                                    const stage = crystal.stage || crystal.metadata?.stage;
                                    const source = crystal.source || crystal.metadata?.source;
                                    const swid = crystal.sourceWorkflowId || crystal.source_workflow_id || '';
                                    const isCanonical = stage === 'canonical' || crystal.is_canonical;
                                    const isTaskTime = source === 'task-time' || swid.startsWith('task-time::');
                                    const createdAt = crystal.createdAt || crystal.created_at;
                                    const execCount = crystal.executionCount ?? crystal.execution_count;
                                    return (
                                        <div
                                            key={crystal.id || swid}
                                            className="agent-detail__workflow-item"
                                            style={{ cursor: 'pointer' }}
                                            onClick={() => navigate('/crystals')}
                                            role="button"
                                            tabIndex={0}
                                            onKeyDown={e => e.key === 'Enter' && navigate('/crystals')}
                                        >
                                            <div className="agent-detail__workflow-info" style={{ flex: 1 }}>
                                                <div className="agent-detail__workflow-name">{crystal.name || crystal.id}</div>
                                                <div className="agent-detail__workflow-type" style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                                                    Created {relativeTime(createdAt)}
                                                    {execCount != null && ` · ${execCount} executions`}
                                                </div>
                                            </div>
                                            <span
                                                className="qx-pill qx-pill--sm"
                                                style={{
                                                    background: isCanonical ? 'rgba(168,85,247,0.12)' : 'rgba(251,191,36,0.12)',
                                                    color: isCanonical ? '#a855f7' : '#fbbf24',
                                                    border: `1px solid ${isCanonical ? 'rgba(168,85,247,0.25)' : 'rgba(251,191,36,0.25)'}`,
                                                }}
                                            >
                                                {isCanonical ? 'canonical' : 'draft'}
                                            </span>
                                            <span
                                                className="qx-pill qx-pill--sm"
                                                style={{
                                                    background: isTaskTime ? 'rgba(96,165,250,0.12)' : 'rgba(52,211,153,0.12)',
                                                    color: isTaskTime ? '#60a5fa' : '#34d399',
                                                    border: `1px solid ${isTaskTime ? 'rgba(96,165,250,0.25)' : 'rgba(52,211,153,0.25)'}`,
                                                }}
                                            >
                                                {isTaskTime ? 'task-time' : 'seed'}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        {!crystalsLoading && crystals.length === 0 && (
                            <div className="agent-detail__empty">
                                <p>No Crystals yet — {agentName} will earn one after it observes 3 successful runs of a stable pattern.</p>
                            </div>
                        )}
                    </div>
                )}

                {/* Runs Tab */}
                {activeTab === 'runs' && (
                    <div className="agent-detail__runs">
                        {runsLoading && (
                            <div className="qx-row qx-row--center" style={{ padding: '24px 0' }}>
                                <span className="qx-spinner qx-spinner--sm" />
                            </div>
                        )}
                        {runsError && (
                            <div className="qx-banner qx-banner--error" style={{ marginBottom: 12 }}>
                                {runsError}
                            </div>
                        )}
                        {!runsLoading && fetchedWorkflows.length === 0 && (
                            <div className="agent-detail__empty">
                                <p>No runs yet — this agent has no assigned workflows.</p>
                            </div>
                        )}
                        {!runsLoading && fetchedWorkflows.length > 0 && runs.length === 0 && !runsError && (
                            <div className="agent-detail__empty">
                                <p>No runs yet.</p>
                            </div>
                        )}
                        {!runsLoading && runs.length > 0 && (
                            <div className="agent-detail__workflow-list">
                                {runs.map((run) => {
                                    const runStatus = run.status || 'unknown';
                                    const statusColor =
                                        runStatus === 'success' || runStatus === 'completed' ? '#4ade80' :
                                        runStatus === 'running' ? '#60a5fa' :
                                        runStatus === 'failed' || runStatus === 'error' ? '#f87171' :
                                        '#94a3b8';
                                    const statusBg = `${statusColor}18`;
                                    const wfMatch = fetchedWorkflows.find(w => w.id === run.workflowId);
                                    const wfLabel = wfMatch ? (wfMatch.name || wfMatch.id) : (run.workflowId || '—');
                                    const startedAt = run.startedAt || run.started_at;
                                    const stoppedAt = run.stoppedAt || run.stopped_at || run.completedAt;
                                    return (
                                        <div
                                            key={run.id}
                                            className="agent-detail__workflow-item"
                                            style={{ cursor: 'pointer' }}
                                            onClick={() => navigate(`/executions/${run.id}`)}
                                            role="button"
                                            tabIndex={0}
                                            onKeyDown={e => e.key === 'Enter' && navigate(`/executions/${run.id}`)}
                                        >
                                            <span
                                                className="qx-pill qx-pill--sm"
                                                style={{
                                                    background: statusBg,
                                                    color: statusColor,
                                                    border: `1px solid ${statusColor}40`,
                                                    minWidth: 72,
                                                    textAlign: 'center',
                                                }}
                                            >
                                                {runStatus}
                                            </span>
                                            <div className="agent-detail__workflow-info" style={{ flex: 1, minWidth: 0 }}>
                                                <div className="agent-detail__workflow-name" style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                    {wfLabel}
                                                </div>
                                                <div className="agent-detail__workflow-type" style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                                                    {relativeTime(startedAt)}
                                                    {stoppedAt && ` · ${formatDuration(startedAt, stoppedAt)}`}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

                {/* Schedules Tab */}
                {activeTab === 'schedules' && (
                    <div className="agent-detail__schedules">
                        {/* TODO: add edit controls when trigger editing is in scope */}
                        {schedulesLoading && (
                            <div className="qx-row qx-row--center" style={{ padding: '24px 0' }}>
                                <span className="qx-spinner qx-spinner--sm" />
                            </div>
                        )}
                        {schedulesError && (
                            <div className="qx-banner qx-banner--error" style={{ marginBottom: 12 }}>
                                {schedulesError}
                            </div>
                        )}
                        {!schedulesLoading && schedules.length > 0 && (
                            <div className="agent-detail__workflow-list">
                                {schedules.map((sched, i) => {
                                    const wfMatch = fetchedWorkflows.find(w => w.id === sched.workflowId);
                                    const wfLabel = wfMatch ? (wfMatch.name || wfMatch.id) : (sched.workflowId || '—');
                                    const isActive = sched.active !== false && !sched.paused;
                                    return (
                                        <div key={sched.id || i} className="agent-detail__workflow-item">
                                            <div className="agent-detail__workflow-info" style={{ flex: 1 }}>
                                                <div className="agent-detail__workflow-name">{wfLabel}</div>
                                                <div className="agent-detail__workflow-type" style={{ fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
                                                    {sched.cron || sched.expression || '—'}
                                                </div>
                                            </div>
                                            {sched.nextFireAt && (
                                                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}>
                                                    next: {relativeTime(sched.nextFireAt)}
                                                </div>
                                            )}
                                            <span
                                                className="qx-pill qx-pill--sm"
                                                style={{
                                                    background: isActive ? 'rgba(74,222,128,0.12)' : 'rgba(148,163,184,0.12)',
                                                    color: isActive ? '#4ade80' : '#94a3b8',
                                                    border: `1px solid ${isActive ? 'rgba(74,222,128,0.25)' : 'rgba(148,163,184,0.2)'}`,
                                                }}
                                            >
                                                {isActive ? 'Active' : 'Paused'}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        {!schedulesLoading && schedules.length === 0 && (
                            <div className="agent-detail__empty">
                                <p>This agent has no scheduled triggers.</p>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

// Wrapper with AgentProvider
function AgentDetailView() {
    return (
        <AgentProvider>
            <AgentDetailContent />
        </AgentProvider>
    );
}

export default AgentDetailView;
