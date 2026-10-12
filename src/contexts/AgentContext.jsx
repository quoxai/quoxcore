/**
 * Agent Context
 * Manages agent state and operations for the enterprise entity model
 *
 * Features:
 * - Agent CRUD operations
 * - Tool assignment management
 * - Tool limit enforcement (5 warn, 8 soft, 15 hard)
 * - Loading and error states
 * - Integration with WorkspaceContext for org scope
 */

import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useAuth } from './AuthContext';
import { useWorkspace } from './WorkspaceContext';
import { agentRegistry } from '../config/agentRegistry';

const AgentContext = createContext(null);

// Agent level labels
export const AGENT_LEVELS = [
    { value: 0, label: 'Orchestrator', description: 'Top-level coordinator (QuoxCORE)' },
    { value: 1, label: 'Manager', description: 'Domain managers (WARDEN, DAEDALUS)' },
    { value: 2, label: 'Specialist', description: 'Task specialists (CIPHER, VAULT)' },
    { value: 3, label: 'Worker', description: 'Task execution agents' },
    { value: 4, label: 'Observer', description: 'Monitoring and logging only' }
];

// Tool limit thresholds
export const TOOL_LIMITS = {
    WARN: 5,
    SOFT: 8,
    HARD: 15
};

// Common agent domains
export const AGENT_DOMAINS = [
    'security', 'infrastructure', 'development', 'operations',
    'data', 'communication', 'monitoring', 'automation',
    'analysis', 'integration', 'compliance', 'support'
];

// Common agent capabilities
export const AGENT_CAPABILITIES = [
    'execute_commands', 'read_files', 'write_files', 'network_access',
    'database_access', 'api_calls', 'llm_inference', 'tool_use',
    'spawn_agents', 'manage_secrets', 'audit_logging', 'hitl_request'
];

export function AgentProvider({ children }) {
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();

    // State
    const [agents, setAgents] = useState([]);
    const [agentTree, setAgentTree] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    // Selected agent for detail view/editing
    const [selectedAgent, setSelectedAgent] = useState(null);
    const [selectedAgentTools, setSelectedAgentTools] = useState([]);
    const [selectedAgentToolStatus, setSelectedAgentToolStatus] = useState(null);

    // Core agent overrides (customizations to registry agents)
    const [coreOverrides, setCoreOverrides] = useState({});

    // Epoch bump: incrementing this triggers a fresh loadAgents() fetch.
    // Incremented when a 'powers:deployed' event fires on window.
    const [refreshEpoch, setRefreshEpoch] = useState(0);

    // Load agents when org changes or after a deploy event bumps refreshEpoch
    useEffect(() => {
        if (currentOrg?.id) {
            loadAgents();
        } else {
            setAgents([]);
            setAgentTree([]);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentOrg?.id, refreshEpoch]);

    // Listen for 'powers:deployed' events dispatched by DeployPowerWizard on success.
    // Bumping refreshEpoch triggers the useEffect above to re-fetch agents so the
    // newly deployed agent appears without requiring an F5.
    useEffect(() => {
        function handlePowersDeployed() {
            setRefreshEpoch(prev => prev + 1);
        }
        window.addEventListener('powers:deployed', handlePowersDeployed);
        return () => window.removeEventListener('powers:deployed', handlePowersDeployed);
    }, []);

    // Load all agents for current org
    const loadAgents = useCallback(async () => {
        if (!currentOrg?.id) return;

        setLoading(true);
        setError(null);

        try {
            const response = await authFetch(`/api/orgs/${currentOrg.id}/agents?includeTools=true`);
            if (response.ok) {
                const data = await response.json();
                setAgents(data.agents || []);
            } else {
                throw new Error('Failed to load agents');
            }
        } catch (err) {
            console.error('Failed to load agents:', err);
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [currentOrg?.id, authFetch]);

    // Load agent tree (hierarchy)
    const loadAgentTree = useCallback(async () => {
        if (!currentOrg?.id) return;

        try {
            const response = await authFetch(`/api/orgs/${currentOrg.id}/agents/tree`);
            if (response.ok) {
                const data = await response.json();
                setAgentTree(data.tree || []);
            }
        } catch (err) {
            console.error('Failed to load agent tree:', err);
        }
    }, [currentOrg?.id, authFetch]);

    // Get single agent with full details
    const getAgent = useCallback(async (agentId) => {
        if (!currentOrg?.id) return null;

        try {
            const response = await authFetch(`/api/orgs/${currentOrg.id}/agents/${agentId}`);
            if (response.ok) {
                const data = await response.json();
                return data.agent;
            }
        } catch (err) {
            console.error('Failed to get agent:', err);
        }
        return null;
    }, [currentOrg?.id, authFetch]);

    // Create new agent
    const createAgent = useCallback(async (agentData) => {
        if (!currentOrg?.id) throw new Error('No organization selected');

        const response = await authFetch(`/api/orgs/${currentOrg.id}/agents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(agentData)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || error.error || 'Failed to create agent');
        }

        const data = await response.json();
        setAgents(prev => [...prev, data.agent]);
        return data.agent;
    }, [currentOrg?.id, authFetch]);

    // Update agent
    const updateAgent = useCallback(async (agentId, updates) => {
        if (!currentOrg?.id) throw new Error('No organization selected');

        const response = await authFetch(`/api/orgs/${currentOrg.id}/agents/${agentId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || error.error || 'Failed to update agent');
        }

        const data = await response.json();
        setAgents(prev => prev.map(a => a.id === agentId ? data.agent : a));

        // Update selected agent if it's the one being edited
        if (selectedAgent?.id === agentId) {
            setSelectedAgent(data.agent);
        }

        return data.agent;
    }, [currentOrg?.id, authFetch, selectedAgent]);

    // Delete (retire) agent
    const deleteAgent = useCallback(async (agentId) => {
        if (!currentOrg?.id) throw new Error('No organization selected');

        const response = await authFetch(`/api/orgs/${currentOrg.id}/agents/${agentId}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || error.error || 'Failed to delete agent');
        }

        setAgents(prev => prev.filter(a => a.id !== agentId));

        // Clear selection if deleted agent was selected
        if (selectedAgent?.id === agentId) {
            setSelectedAgent(null);
            setSelectedAgentTools([]);
            setSelectedAgentToolStatus(null);
        }

        return true;
    }, [currentOrg?.id, authFetch, selectedAgent]);

    // Select agent and load its tools
    const selectAgent = useCallback(async (agent) => {
        if (!agent) {
            setSelectedAgent(null);
            setSelectedAgentTools([]);
            setSelectedAgentToolStatus(null);
            return;
        }

        setSelectedAgent(agent);

        // Load tools for this agent
        if (currentOrg?.id) {
            try {
                const response = await authFetch(`/api/orgs/${currentOrg.id}/agents/${agent.id}/tools`);
                if (response.ok) {
                    const data = await response.json();
                    setSelectedAgentTools(data.assignments || []);
                    setSelectedAgentToolStatus(data.toolStatus);
                }
            } catch (err) {
                console.error('Failed to load agent tools:', err);
            }
        }
    }, [currentOrg?.id, authFetch]);

    // Assign tool to agent
    const assignTool = useCallback(async (agentId, toolInstallationId, options = {}) => {
        if (!currentOrg?.id) throw new Error('No organization selected');

        const response = await authFetch(`/api/orgs/${currentOrg.id}/agents/${agentId}/tools`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tool_installation_id: toolInstallationId,
                access_mode: options.accessMode || 'full',
                scope_id: options.scopeId,
                max_daily_invocations: options.maxDailyInvocations
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || error.error || 'Failed to assign tool');
        }

        const data = await response.json();

        // Refresh agent tools if this is the selected agent
        if (selectedAgent?.id === agentId) {
            await selectAgent(selectedAgent);
        }

        return data;
    }, [currentOrg?.id, authFetch, selectedAgent, selectAgent]);

    // Update tool assignment
    const updateToolAssignment = useCallback(async (agentId, assignmentId, updates) => {
        if (!currentOrg?.id) throw new Error('No organization selected');

        const response = await authFetch(`/api/orgs/${currentOrg.id}/agents/${agentId}/tools/${assignmentId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || error.error || 'Failed to update tool assignment');
        }

        // Refresh agent tools if this is the selected agent
        if (selectedAgent?.id === agentId) {
            await selectAgent(selectedAgent);
        }

        return true;
    }, [currentOrg?.id, authFetch, selectedAgent, selectAgent]);

    // Revoke tool assignment
    const revokeTool = useCallback(async (agentId, assignmentId) => {
        if (!currentOrg?.id) throw new Error('No organization selected');

        const response = await authFetch(`/api/orgs/${currentOrg.id}/agents/${agentId}/tools/${assignmentId}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || error.error || 'Failed to revoke tool');
        }

        // Refresh agent tools if this is the selected agent
        if (selectedAgent?.id === agentId) {
            await selectAgent(selectedAgent);
        }

        return true;
    }, [currentOrg?.id, authFetch, selectedAgent, selectAgent]);

    // Load core overrides for this org
    const loadCoreOverrides = useCallback(async () => {
        if (!currentOrg?.id) return;
        try {
            const response = await authFetch(`/api/orgs/${currentOrg.id}/agents`);
            if (response.ok) {
                const data = await response.json();
                const coreAgentIds = new Set(Object.keys(agentRegistry?.agents || {}));
                const overrides = {};
                (data.agents || []).forEach(a => {
                    if (a.agent_id && coreAgentIds.has(a.agent_id)) overrides[a.agent_id] = a;
                });
                setCoreOverrides(overrides);
            }
        } catch (err) {
            console.error('Failed to load core overrides:', err);
        }
    }, [currentOrg?.id, authFetch]);

    useEffect(() => {
        if (currentOrg?.id) {
            loadCoreOverrides();
        } else {
            setCoreOverrides({});
        }
    }, [currentOrg?.id, loadCoreOverrides]);

    // Save override for a core agent
    const saveCoreOverride = useCallback(async (agentId, overrideData) => {
        if (!currentOrg?.id) throw new Error('No organization selected');

        const existing = coreOverrides[agentId];
        const method = existing ? 'PATCH' : 'POST';
        const endpoint = existing
            ? `/api/orgs/${currentOrg.id}/agents/${existing.id}`
            : `/api/orgs/${currentOrg.id}/agents`;
        const body = existing
            ? overrideData
            : { agent_id: agentId, source: 'core_override', ...overrideData };

        const response = await authFetch(endpoint, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.message || err.error || 'Failed to save override');
        }

        const data = await response.json();
        setCoreOverrides(prev => ({ ...prev, [agentId]: data.agent }));
        return data.agent;
    }, [currentOrg?.id, authFetch, coreOverrides]);

    // Delete override (reset to default)
    const resetCoreOverride = useCallback(async (agentId) => {
        if (!currentOrg?.id) throw new Error('No organization selected');
        const existing = coreOverrides[agentId];
        if (!existing) return;

        const response = await authFetch(`/api/orgs/${currentOrg.id}/agents/${existing.id}`, {
            method: 'DELETE',
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.message || err.error || 'Failed to reset override');
        }

        setCoreOverrides(prev => {
            const next = { ...prev };
            delete next[agentId];
            return next;
        });
    }, [currentOrg?.id, authFetch, coreOverrides]);

    // Get merged agent (registry base + API override)
    const getMergedAgent = useCallback((agentId, registryAgent) => {
        const override = coreOverrides[agentId];
        if (!registryAgent && !override) return null;
        if (!override) return { ...registryAgent, _isCore: true, _hasOverride: false };
        const mergedConfig = {
            ...(registryAgent?.config || {}),
            ...(override.config || {}),
        };

        if (registryAgent?.config?.llm || override?.config?.llm) {
            mergedConfig.llm = {
                ...(registryAgent?.config?.llm || {}),
                ...(override?.config?.llm || {}),
            };
        }

        if (registryAgent?.config?.llmPolicy || override?.config?.llmPolicy) {
            mergedConfig.llmPolicy = {
                ...(registryAgent?.config?.llmPolicy || {}),
                ...(override?.config?.llmPolicy || {}),
            };
        }

        return {
            ...registryAgent,
            ...override,
            config: mergedConfig,
            tools: registryAgent?.tools || [],
            system_prompt_additions: override.system_prompt_additions || '',
            _isCore: true,
            _hasOverride: true,
        };
    }, [coreOverrides]);

    // Get tool limit status string
    const getToolLimitStatus = (count) => {
        if (count >= TOOL_LIMITS.HARD) return 'hard';
        if (count >= TOOL_LIMITS.SOFT) return 'soft';
        if (count >= TOOL_LIMITS.WARN) return 'warn';
        return 'ok';
    };

    const value = {
        // State
        agents,
        agentTree,
        loading,
        error,
        selectedAgent,
        selectedAgentTools,
        selectedAgentToolStatus,

        // Actions
        loadAgents,
        loadAgentTree,
        getAgent,
        createAgent,
        updateAgent,
        deleteAgent,
        selectAgent,

        // Tool management
        assignTool,
        updateToolAssignment,
        revokeTool,

        // Core overrides
        coreOverrides,
        loadCoreOverrides,
        saveCoreOverride,
        resetCoreOverride,
        getMergedAgent,

        // Utilities
        getToolLimitStatus,

        // Constants
        AGENT_LEVELS,
        AGENT_DOMAINS,
        AGENT_CAPABILITIES,
        TOOL_LIMITS
    };

    return (
        <AgentContext.Provider value={value}>
            {children}
        </AgentContext.Provider>
    );
}

export function useAgents() {
    const context = useContext(AgentContext);
    if (!context) {
        throw new Error('useAgents must be used within an AgentProvider');
    }
    return context;
}

export default AgentContext;
