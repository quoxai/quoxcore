/**
 * Tool Catalog Client - API client for the Tool Library
 *
 * Architecture: Agent-Centric Tool Access
 * - Tools are assigned to AGENTS, not users/orgs directly
 * - Assistants delegate to agents with specific toolsets
 * - No agent should have access to ALL tools
 *
 * Provides functions to:
 * - Browse the global tool catalog
 * - Manage org tool installations
 * - Manage agents and their tool assignments
 * - Get agent tool context for prompt injection
 */

import { csrfFetch } from '../utils/csrfFetch';
import { buildAuthApiUrl } from './authApiUrl';
import {
  logToolInstalled, logToolUpdated, logToolUninstalled,
  logAgentCreated, logAgentUpdated, logAgentDeleted,
  logToolAssigned, logAssignmentUpdated, logToolRevoked,
} from './toolCatalogAudit';

// Helper for making authenticated requests (with CSRF token)
async function authFetch(endpoint, options = {}) {
    const url = buildAuthApiUrl(endpoint);
    const res = await csrfFetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        }
    });
    return res;
}

// ============================================================================
// TOOL CATALOG (Global)
// ============================================================================

/**
 * Browse the global tool catalog
 * @param {Object} params - Filter parameters
 * @param {string} [params.category] - Filter by category
 * @param {string} [params.subcategory] - Filter by subcategory
 * @param {string} [params.risk_level] - Filter by risk level
 * @param {string} [params.sandbox_profile] - Filter by sandbox profile
 * @param {string} [params.search] - Search query
 * @param {string} [params.status] - Filter by status
 * @param {boolean} [params.featured] - Show featured tools only
 * @param {number} [params.page] - Page number
 * @param {number} [params.limit] - Items per page
 * @returns {Promise<{tools: Array, pagination: Object}>}
 */
export async function browseCatalog(params = {}) {
    try {
        const query = new URLSearchParams();
        Object.entries(params).forEach(([k, v]) => {
            if (v !== undefined && v !== null && v !== '') {
                query.append(k, v);
            }
        });

        const res = await authFetch(`/tools/catalog?${query}`);

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `Failed to browse catalog: ${res.status}`);
        }

        return await res.json();
    } catch (err) {
        console.error('[ToolCatalog] Failed to browse catalog:', err);
        return { tools: [], pagination: { page: 1, limit: 50, total: 0 } };
    }
}

/**
 * Get a single tool from the catalog
 * @param {string} toolId - Tool definition ID or canonical tool_id
 * @returns {Promise<Object|null>}
 */
export async function getTool(toolId) {
    try {
        const res = await authFetch(`/tools/catalog/${encodeURIComponent(toolId)}`);

        if (!res.ok) {
            if (res.status === 404) return null;
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `Failed to get tool: ${res.status}`);
        }

        return await res.json();
    } catch (err) {
        console.error(`[ToolCatalog] Failed to get tool ${toolId}:`, err);
        return null;
    }
}

/**
 * Get available tool categories
 * @returns {Promise<Array>}
 */
export async function getCategories() {
    try {
        const res = await authFetch('/tools/catalog/categories');

        if (!res.ok) {
            return [];
        }

        const data = await res.json();
        return data.categories || [];
    } catch (err) {
        console.error('[ToolCatalog] Failed to get categories:', err);
        return [];
    }
}

/**
 * Search tools in the catalog
 * @param {string} query - Search query
 * @param {Object} [filters] - Additional filters
 * @returns {Promise<{tools: Array, total: number}>}
 */
export async function searchCatalog(query, filters = {}) {
    return browseCatalog({ search: query, ...filters });
}

// ============================================================================
// TOOL INSTALLATIONS (Per-Org)
// ============================================================================

/**
 * List installed tools for an org
 * @param {string} orgId - Organization ID
 * @param {Object} [params] - Filter parameters
 * @returns {Promise<{installations: Array, total: number}>}
 */
export async function listInstallations(orgId, params = {}) {
    try {
        const query = new URLSearchParams();
        Object.entries(params).forEach(([k, v]) => {
            if (v !== undefined && v !== null) {
                query.append(k, v);
            }
        });

        const res = await authFetch(`/orgs/${orgId}/tool-library?${query}`);

        if (!res.ok) {
            if (res.status === 401 || res.status === 404) {
                return { installations: [], total: 0 };
            }
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `Failed to list installations: ${res.status}`);
        }

        return await res.json();
    } catch (err) {
        console.error('[ToolCatalog] Failed to list installations:', err);
        return { installations: [], total: 0, error: err.message };
    }
}

/**
 * Install a tool from the catalog
 * @param {string} orgId - Organization ID
 * @param {Object} data - Installation data
 * @param {string} data.tool_definition_id - Tool definition ID
 * @param {Object} [data.config] - Optional configuration overrides
 * @returns {Promise<{success: boolean, id?: string, error?: string}>}
 */
export async function installTool(orgId, data) {
    try {
        const res = await authFetch(`/orgs/${orgId}/tool-library`, {
            method: 'POST',
            body: JSON.stringify(data)
        });

        const result = await res.json();

        if (!res.ok) {
            return { success: false, error: result.message || 'Failed to install tool' };
        }

        logToolInstalled(orgId, result);
        return { success: true, ...result };
    } catch (err) {
        console.error('[ToolCatalog] Failed to install tool:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Update a tool installation
 * @param {string} orgId - Organization ID
 * @param {string} installationId - Installation ID
 * @param {Object} data - Update data
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function updateInstallation(orgId, installationId, data) {
    try {
        const res = await authFetch(`/orgs/${orgId}/tool-library/${installationId}`, {
            method: 'PATCH',
            body: JSON.stringify(data)
        });

        const result = await res.json();

        if (!res.ok) {
            return { success: false, error: result.message || 'Failed to update installation' };
        }

        logToolUpdated(orgId, installationId);
        return { success: true, ...result };
    } catch (err) {
        console.error(`[ToolCatalog] Failed to update installation ${installationId}:`, err);
        return { success: false, error: err.message };
    }
}

/**
 * Uninstall a tool
 * @param {string} orgId - Organization ID
 * @param {string} installationId - Installation ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function uninstallTool(orgId, installationId) {
    try {
        const res = await authFetch(`/orgs/${orgId}/tool-library/${installationId}`, {
            method: 'DELETE'
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { success: false, error: err.message || 'Failed to uninstall tool' };
        }

        logToolUninstalled(orgId, installationId);
        return { success: true };
    } catch (err) {
        console.error(`[ToolCatalog] Failed to uninstall ${installationId}:`, err);
        return { success: false, error: err.message };
    }
}

// ============================================================================
// AGENTS (Org-Specific)
// ============================================================================

/**
 * List agents for an org
 * @param {string} orgId - Organization ID
 * @param {Object} [params] - Filter parameters
 * @returns {Promise<{agents: Array, total: number}>}
 */
export async function listAgents(orgId, params = {}) {
    try {
        const query = new URLSearchParams();
        Object.entries(params).forEach(([k, v]) => {
            if (v !== undefined && v !== null) {
                query.append(k, v);
            }
        });

        const res = await authFetch(`/orgs/${orgId}/agents?${query}`);

        if (!res.ok) {
            if (res.status === 401 || res.status === 404) {
                return { agents: [], total: 0 };
            }
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `Failed to list agents: ${res.status}`);
        }

        return await res.json();
    } catch (err) {
        console.error('[ToolCatalog] Failed to list agents:', err);
        return { agents: [], total: 0, error: err.message };
    }
}

/**
 * Get a single agent
 * @param {string} orgId - Organization ID
 * @param {string} agentDbId - Agent database ID
 * @returns {Promise<Object|null>}
 */
export async function getAgent(orgId, agentDbId) {
    try {
        const res = await authFetch(`/orgs/${orgId}/agents/${agentDbId}`);

        if (!res.ok) {
            if (res.status === 404) return null;
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `Failed to get agent: ${res.status}`);
        }

        return await res.json();
    } catch (err) {
        console.error(`[ToolCatalog] Failed to get agent ${agentDbId}:`, err);
        return null;
    }
}

/**
 * Create a new agent
 * @param {string} orgId - Organization ID
 * @param {Object} data - Agent data
 * @param {string} data.agent_id - Manifest ID
 * @param {string} data.name - Display name
 * @param {string} [data.description] - Description
 * @param {number} [data.level] - Hierarchy level (0-4)
 * @param {Array} [data.domains] - Domain tags
 * @param {Array} [data.capabilities] - Capability tags
 * @returns {Promise<{success: boolean, id?: string, error?: string}>}
 */
export async function createAgent(orgId, data) {
    try {
        const res = await authFetch(`/orgs/${orgId}/agents`, {
            method: 'POST',
            body: JSON.stringify(data)
        });

        const result = await res.json();

        if (!res.ok) {
            return { success: false, error: result.message || 'Failed to create agent' };
        }

        logAgentCreated(orgId, result);
        return { success: true, ...result };
    } catch (err) {
        console.error('[ToolCatalog] Failed to create agent:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Update an agent
 * @param {string} orgId - Organization ID
 * @param {string} agentDbId - Agent database ID
 * @param {Object} data - Update data
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function updateAgent(orgId, agentDbId, data) {
    try {
        const res = await authFetch(`/orgs/${orgId}/agents/${agentDbId}`, {
            method: 'PATCH',
            body: JSON.stringify(data)
        });

        const result = await res.json();

        if (!res.ok) {
            return { success: false, error: result.message || 'Failed to update agent' };
        }

        logAgentUpdated(orgId, agentDbId);
        return { success: true, ...result };
    } catch (err) {
        console.error(`[ToolCatalog] Failed to update agent ${agentDbId}:`, err);
        return { success: false, error: err.message };
    }
}

/**
 * Delete an agent
 * @param {string} orgId - Organization ID
 * @param {string} agentDbId - Agent database ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function deleteAgent(orgId, agentDbId) {
    try {
        const res = await authFetch(`/orgs/${orgId}/agents/${agentDbId}`, {
            method: 'DELETE'
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { success: false, error: err.message || 'Failed to delete agent' };
        }

        logAgentDeleted(orgId, agentDbId);
        return { success: true };
    } catch (err) {
        console.error(`[ToolCatalog] Failed to delete agent ${agentDbId}:`, err);
        return { success: false, error: err.message };
    }
}

// ============================================================================
// AGENT TOOL ASSIGNMENTS
// ============================================================================

/**
 * List tools assigned to an agent
 * @param {string} orgId - Organization ID
 * @param {string} agentDbId - Agent database ID
 * @returns {Promise<{tools: Array, total: number, tool_count: Object}>}
 */
export async function getAgentTools(orgId, agentDbId) {
    try {
        const res = await authFetch(`/orgs/${orgId}/agents/${agentDbId}/tools`);

        if (!res.ok) {
            if (res.status === 404) {
                return { tools: [], total: 0, tool_count: { count: 0, status: 'ok' } };
            }
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `Failed to get agent tools: ${res.status}`);
        }

        return await res.json();
    } catch (err) {
        console.error(`[ToolCatalog] Failed to get tools for agent ${agentDbId}:`, err);
        return { tools: [], total: 0, error: err.message };
    }
}

/**
 * Assign a tool to an agent
 * @param {string} orgId - Organization ID
 * @param {string} agentDbId - Agent database ID
 * @param {Object} data - Assignment data
 * @param {string} data.tool_installation_id - Tool installation ID
 * @param {string} [data.access_mode] - Access mode (full, read_only, with_approval)
 * @param {number} [data.max_daily_invocations] - Rate limit
 * @param {Array} [data.allowed_operations] - Subset of operations
 * @returns {Promise<{success: boolean, id?: string, warning?: string, error?: string}>}
 */
export async function assignToolToAgent(orgId, agentDbId, data) {
    try {
        const res = await authFetch(`/orgs/${orgId}/agents/${agentDbId}/tools`, {
            method: 'POST',
            body: JSON.stringify(data)
        });

        const result = await res.json();

        if (!res.ok) {
            return { success: false, error: result.message || 'Failed to assign tool' };
        }

        logToolAssigned(orgId, agentDbId, result);
        return { success: true, ...result };
    } catch (err) {
        console.error('[ToolCatalog] Failed to assign tool:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Update a tool assignment
 * @param {string} orgId - Organization ID
 * @param {string} agentDbId - Agent database ID
 * @param {string} assignmentId - Assignment ID
 * @param {Object} data - Update data
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function updateToolAssignment(orgId, agentDbId, assignmentId, data) {
    try {
        const res = await authFetch(`/orgs/${orgId}/agents/${agentDbId}/tools/${assignmentId}`, {
            method: 'PATCH',
            body: JSON.stringify(data)
        });

        const result = await res.json();

        if (!res.ok) {
            return { success: false, error: result.message || 'Failed to update assignment' };
        }

        logAssignmentUpdated(orgId, agentDbId, assignmentId);
        return { success: true, ...result };
    } catch (err) {
        console.error(`[ToolCatalog] Failed to update assignment ${assignmentId}:`, err);
        return { success: false, error: err.message };
    }
}

/**
 * Revoke a tool assignment
 * @param {string} orgId - Organization ID
 * @param {string} agentDbId - Agent database ID
 * @param {string} assignmentId - Assignment ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function revokeToolAssignment(orgId, agentDbId, assignmentId) {
    try {
        const res = await authFetch(`/orgs/${orgId}/agents/${agentDbId}/tools/${assignmentId}`, {
            method: 'DELETE'
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { success: false, error: err.message || 'Failed to revoke assignment' };
        }

        logToolRevoked(orgId, agentDbId, assignmentId);
        return { success: true };
    } catch (err) {
        console.error(`[ToolCatalog] Failed to revoke assignment ${assignmentId}:`, err);
        return { success: false, error: err.message };
    }
}

// ============================================================================
// AGENT CONTEXT (For Prompt Injection)
// ============================================================================

/**
 * Get pre-computed tool context for an agent
 * This is used for injecting available tools into agent prompts
 * @param {string} orgId - Organization ID
 * @param {string} agentDbId - Agent database ID
 * @param {boolean} [regenerate=false] - Force regeneration
 * @returns {Promise<Object|null>}
 */
export async function getAgentContext(orgId, agentDbId, regenerate = false) {
    try {
        const query = regenerate ? '?regenerate=true' : '';
        const res = await authFetch(`/orgs/${orgId}/agents/${agentDbId}/context${query}`);

        if (!res.ok) {
            if (res.status === 404) return null;
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `Failed to get agent context: ${res.status}`);
        }

        return await res.json();
    } catch (err) {
        console.error(`[ToolCatalog] Failed to get context for agent ${agentDbId}:`, err);
        return null;
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const toolCatalogClient = {
    // Catalog
    browseCatalog,
    getTool,
    getCategories,
    searchCatalog,

    // Installations
    listInstallations,
    installTool,
    updateInstallation,
    uninstallTool,

    // Agents
    listAgents,
    getAgent,
    createAgent,
    updateAgent,
    deleteAgent,

    // Agent Tools
    getAgentTools,
    assignToolToAgent,
    updateToolAssignment,
    revokeToolAssignment,

    // Context
    getAgentContext
};

export default toolCatalogClient;
