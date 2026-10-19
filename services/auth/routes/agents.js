/**
 * Agent Routes for Quox Auth Service
 * Phase B.2: Agent Management (Enterprise Entity Model)
 *
 * Agents are the ONLY entities that can access tools.
 * Assistants discover and delegate to specialized agents.
 *
 * AOCL Integration:
 * - All CRUD operations emit audit events
 * - Tool assignments are logged with AOCL layer tracking
 * - Correlation IDs thread through the audit trail
 *
 * Hierarchy:
 * - Level 0: Orchestrator (QuoxCORE)
 * - Level 1: Manager (WARDEN, DAEDALUS)
 * - Level 2: Specialist (CIPHER, VAULT, ORACLE)
 * - Level 3: Worker (task-specific)
 * - Level 4: Observer (monitoring only)
 */

import { resolveResidentAssignmentKey } from '../lib/residentAssignmentKey.js';
import { Router } from 'express';
import { getDb, prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership, requireOrgRole } from '../middleware/org.js';
import { Capabilities } from '../utils/policy.js';
import { checkInstanceAdmin } from '../middleware/instanceAdmin.js';
import { resolveCap } from '../utils/resolveCap.js';
import { createAuditEvent, ulid } from '../utils/helpers.js';
import { safeCompare } from '../utils/crypto.js';
import { unfoldAvailableTools } from '../lib/mcpToolNaming.js';
import { prefixDeprecatedDescription } from '../lib/powersAvailableToolsDrift.js';
import { humanGrantorOnly } from '../utils/principal.js';
import { isValidAgentId } from '../lib/agentIdentity.js';
import { builtinAgentIdRefusal, builtinAgentPatchRefusal } from '../lib/builtinAgentId.js';
import { toolNotInCatalogMessage } from '../lib/toolNotInCatalogHint.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * Wrapper input_schema for MCP-backed tools (mcp_endpoint + mcp_hosted).
 * The collector's _buildMcpHostedExecute / _buildMcpEndpointExecute accept
 * { tool_name, arguments } — this schema tells the LLM what to pass.
 * The LLM heuristically guesses tool_name; if wrong, the MCP wrapper relays
 * the MCP's error and the LLM retries with a corrected name.
 */
const MCP_WRAPPER_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        tool_name: {
            type: 'string',
            description: 'Name of the MCP tool to invoke (e.g. list_schemas, query, list_objects, get_schema_info)',
        },
        arguments: {
            type: 'object',
            description: 'Arguments to pass to the MCP tool. Schema depends on the specific MCP tool. Often {} for list-style queries.',
            additionalProperties: true,
        },
    },
    required: ['tool_name', 'arguments'],
};

// ============================================================================
// TOOL LIMITS CONFIGURATION
// ============================================================================

// Same shape as getOrgToolLimits() returns from tool_config. The old
// WARN_THRESHOLD/SOFT_LIMIT/HARD_LIMIT keys left limits.hard undefined for
// every org without a tool_config row: single assign always 409'd and
// bulk-assign never enforced the limit.
const TOOL_LIMITS = {
    warn: 5,      // Warn when adding 5th+ tool
    soft: 8,      // Strong warning at 8+
    hard: 15      // Requires admin override
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Resolve the `:agentId` route param to the agent's internal `id` (the ULID
 * every other table's foreign keys actually point at). Callers only ever
 * know the human-facing `agent_id` slug they picked at `agent create
 * --agent-id <slug>` — `list` shows both fields, but `agent_id` is the one
 * that means anything to them. Accepting either avoids fleet #365: GET/DELETE
 * queried `WHERE a.id = ?` directly against the URL param, so the documented
 * `--agent-id` slug 404'd on every lookup after creation.
 * @returns {string|null} the internal id, or null if nothing matches
 */
function resolveAgentInternalId(orgId, agentIdOrSlug) {
    const ref = resolveAgentRef(orgId, agentIdOrSlug);
    return ref ? ref.id : null;
}

/**
 * quox#1072: a built-in (registry) agent is seeded into the `__system__` org
 * with is_core = 1 and takes its tools from its registry grant (AGENT_TOOLS)
 * and its hat, never from an org assignment: the collector's DB overlay
 * (/internal/agents/:agentId/tools) resolves a slug across orgs, so there is
 * no org-scoped place for a tenant's assignment to a built-in to live. When an
 * assign target is not one of the caller org's agents but IS a built-in, say
 * so instead of claiming the agent does not exist.
 * @returns {{agentSlug: string, name: string}|null}
 */
function resolveBuiltinAgent(agentIdOrSlug) {
    const row = prepare(`
        SELECT agent_id, name FROM agents
        WHERE is_core = 1 AND (id = ? OR agent_id = ?) AND status != 'retired'
        LIMIT 1
    `).get(agentIdOrSlug, agentIdOrSlug);
    return row ? { agentSlug: row.agent_id, name: row.name } : null;
}

function builtinAgentAssignRefusal(builtin) {
    const slug = builtin.agentSlug;
    const message = `${slug} is a built-in agent: its tools come from its registry grant and hat, not from assign. ` +
        'Use a hat, or assign to a custom agent (quox agent create).';
    return {
        error: message,
        message,
        code: 'BUILTIN_AGENT_TOOLS_FROM_GRANT',
        agent_id: slug,
        hint: `See what ${slug} holds: quox agent tool list ${slug}`,
    };
}

/**
 * Same lookup as resolveAgentInternalId, but returns BOTH identifiers.
 *
 * fleet #380: these two columns are not interchangeable and the difference
 * is load-bearing. `agents.id` is the internal ULID that
 * `assistant_agent_routing.agent_db_id` and `agent_tool_context.agent_db_id`
 * point at, but `agent_tool_assignments` keys off `agent_id` — the manifest
 * SLUG ('sentinel'), per its own schema comment. Callers touching tool
 * assignments need the slug; callers touching routing need the ULID.
 * `name` is carried too so callers that need it for audit metadata don't
 * have to re-fetch (fleet #382).
 * @returns {{id: string, agentSlug: string, name: string}|null}
 */
function resolveAgentRef(orgId, agentIdOrSlug) {
    const row = prepare(`
        SELECT id, agent_id, name FROM agents
        WHERE org_id = ? AND (id = ? OR agent_id = ?) AND status != 'retired'
    `).get(orgId, agentIdOrSlug, agentIdOrSlug);
    return row ? { id: row.id, agentSlug: row.agent_id, name: row.name } : null;
}

/**
 * Get tool count for an agent
 * @param {string} agentManifestId - The agent manifest ID (e.g., 'sentinel', 'cipher')
 */
function getAgentToolCount(agentManifestId, orgId) {
    const result = prepare(`
        SELECT COUNT(*) as count
        FROM agent_tool_assignments
        WHERE agent_id = ?
          AND org_id = ?
          AND enabled = 1
          AND revoked_at IS NULL
    `).get(agentManifestId, orgId);
    return result?.count || 0;
}

/**
 * Get org tool limits (from config or defaults)
 */
function getOrgToolLimits(orgId) {
    const config = prepare(`
        SELECT agent_tools_warn_threshold, agent_tools_soft_limit, agent_tools_hard_limit
        FROM tool_config
        WHERE org_id = ?
    `).get(orgId);

    if (config) {
        return {
            warn: config.agent_tools_warn_threshold,
            soft: config.agent_tools_soft_limit,
            hard: config.agent_tools_hard_limit
        };
    }

    return TOOL_LIMITS;
}

/**
 * Check tool limit status for an agent
 * @param {string} agentManifestId - The agent manifest ID (e.g., 'sentinel', 'cipher')
 * @param {string} orgId - The organization ID
 */
function checkToolLimitStatus(agentManifestId, orgId) {
    const count = getAgentToolCount(agentManifestId, orgId);
    const limits = getOrgToolLimits(orgId);

    return {
        count,
        limits,
        status: count >= limits.hard ? 'hard_limit' :
                count >= limits.soft ? 'soft_limit' :
                count >= limits.warn ? 'warning' : 'ok',
        canAdd: count < limits.hard
    };
}

// ============================================================================
// AGENT CRUD ROUTES
// ============================================================================

/**
 * GET /orgs/:orgId/agents
 * List all agents in an org (excludes retired agents by default)
 */
router.get('/orgs/:orgId/agents', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { includeRetired = 'false', includeTools = 'false' } = req.query;

        let query = `
            SELECT a.*, u.display_name as created_by_name,
                   s.path as home_scope_path
            FROM agents a
            LEFT JOIN users u ON a.created_by = u.id
            LEFT JOIN scopes s ON a.home_scope_id = s.id
            WHERE a.org_id = ?
        `;

        if (includeRetired !== 'true') {
            query += " AND a.status != 'retired'";
        }

        query += ' ORDER BY a.level, a.name';

        let agents = prepare(query).all(orgId);

        // Optionally include tool counts
        if (includeTools === 'true') {
            agents = agents.map(agent => {
                const toolStatus = checkToolLimitStatus(agent.agent_id, orgId);
                return {
                    ...agent,
                    tool_count: toolStatus.count,
                    tool_limit_status: toolStatus.status,
                    domains: JSON.parse(agent.domains_json || '[]'),
                    capabilities: JSON.parse(agent.capabilities_json || '[]')
                };
            });
        } else {
            agents = agents.map(agent => ({
                ...agent,
                domains: JSON.parse(agent.domains_json || '[]'),
                capabilities: JSON.parse(agent.capabilities_json || '[]')
            }));
        }

        res.json({ agents });
    } catch (error) {
        console.error('Error listing agents:', error);
        res.status(500).json({ error: 'Failed to list agents' });
    }
});

/**
 * GET /orgs/:orgId/agents/:agentId
 * Get a single agent with full details including tools
 */
router.get('/orgs/:orgId/agents/:agentId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const agentId = resolveAgentInternalId(orgId, req.params.agentId);
        if (!agentId) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        const agent = prepare(`
            SELECT a.*, u.display_name as created_by_name,
                   s.path as home_scope_path,
                   s.name_cache as home_scope_name
            FROM agents a
            LEFT JOIN users u ON a.created_by = u.id
            LEFT JOIN scopes s ON a.home_scope_id = s.id
            WHERE a.id = ? AND a.org_id = ?
        `).get(agentId, orgId);

        if (!agent) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        // Get assigned tools
        const tools = prepare(`
            SELECT ata.id as assignment_id, ata.access_mode, ata.enabled,
                   ata.max_daily_invocations, ata.assigned_at,
                   ti.id as installation_id, ti.config_json as installation_config,
                   td.tool_id, td.name as tool_name, td.description as tool_description,
                   td.category, td.risk_level, td.icon
            FROM agent_tool_assignments ata
            JOIN tool_installations ti ON ata.tool_installation_id = ti.id
            JOIN tool_definitions td ON ti.tool_definition_id = td.id
            WHERE ata.agent_id = ?
              AND ata.revoked_at IS NULL
              AND ata.enabled = 1
            ORDER BY td.category, td.name
        `).all(agent.agent_id);

        // Get routing info (which assistants route to this agent)
        const routing = prepare(`
            SELECT aar.assistant_id, aar.priority, aar.enabled,
                   aar.route_for_domains_json, aar.route_for_intents_json
            FROM assistant_agent_routing aar
            WHERE aar.agent_db_id = ?
              AND aar.enabled = 1
            ORDER BY aar.priority
        `).all(agentId);

        // Get parent agent if exists
        let parentAgent = null;
        if (agent.parent_agent_id) {
            parentAgent = prepare(`
                SELECT id, agent_id, name, level FROM agents WHERE id = ?
            `).get(agent.parent_agent_id);
        }

        // Get child agents
        const childAgents = prepare(`
            SELECT id, agent_id, name, level, status
            FROM agents
            WHERE parent_agent_id = ? AND status != 'retired'
            ORDER BY level, name
        `).all(agentId);

        // Tool limit status
        const toolStatus = checkToolLimitStatus(agent.agent_id, orgId);

        res.json({
            agent: {
                ...agent,
                domains: JSON.parse(agent.domains_json || '[]'),
                capabilities: JSON.parse(agent.capabilities_json || '[]'),
                config: JSON.parse(agent.config_json || '{}'),
                tools,
                routing,
                parentAgent,
                childAgents,
                toolStatus
            }
        });
    } catch (error) {
        console.error('Error getting agent:', error);
        res.status(500).json({ error: 'Failed to get agent' });
    }
});

/**
 * POST /orgs/:orgId/agents
 * Create a new agent
 */
router.post('/orgs/:orgId/agents',
    requireOrgMembership,
    requireOrgRole('builder'),
    async (req, res) => {
        try {
            const { orgId } = req.params;
            const {
                agent_id,
                name,
                description,
                icon,
                level = 2,
                parent_agent_id,
                manager_assistant_id,
                home_scope_id,
                config = {},
                system_prompt_additions,
                domains = [],
                capabilities = []
            } = req.body;
            const userId = req.user.id;

            // Check capability
            if (!resolveCap(req, Capabilities.AGENTS_MANAGE)) {
                return res.status(403).json({ error: 'Insufficient permissions to manage agents' });
            }

            // Validate required fields
            if (!agent_id || !name) {
                return res.status(400).json({ error: 'agent_id and name are required' });
            }

            // quox#1025: the shared agent-id rule (lib/agentIdentity.js), the same one attach applies
            if (!isValidAgentId(agent_id)) {
                return res.status(400).json({
                    error: 'agent_id must be lowercase letters, digits, hyphens and underscores, starting with a letter or digit (at most 64)'
                });
            }

            // ASSAY audit: ids are unique per org only, so a tenant agent could wear a built-in's id
            const builtinRefusal = builtinAgentIdRefusal(agent_id);
            if (builtinRefusal) return res.status(builtinRefusal.status).json(builtinRefusal.body);

            // Check for duplicate agent_id in org
            const existing = prepare(`
                SELECT id FROM agents WHERE org_id = ? AND agent_id = ? AND status != 'retired'
            `).get(orgId, agent_id);

            if (existing) {
                return res.status(409).json({ error: 'An agent with this ID already exists' });
            }

            // Validate level
            if (level < 0 || level > 4) {
                return res.status(400).json({ error: 'Level must be between 0 and 4' });
            }

            // Validate parent agent if provided
            if (parent_agent_id) {
                const parent = prepare(`
                    SELECT id, level FROM agents WHERE id = ? AND org_id = ? AND status != 'retired'
                `).get(parent_agent_id, orgId);

                if (!parent) {
                    return res.status(400).json({ error: 'Parent agent not found' });
                }

                // Child must be higher level (lower authority) than parent
                if (level <= parent.level) {
                    return res.status(400).json({
                        error: `Agent level (${level}) must be higher than parent level (${parent.level})`
                    });
                }
            }

            // Validate home scope if provided
            if (home_scope_id) {
                const scope = prepare(`
                    SELECT id FROM scopes WHERE id = ? AND org_id = ?
                `).get(home_scope_id, orgId);

                if (!scope) {
                    return res.status(400).json({ error: 'Home scope not found' });
                }
            }

            const db = getDb();
            const id = ulid();

            db.transaction(() => {
                prepare(`
                    INSERT INTO agents (
                        id, org_id, agent_id, name, description, icon,
                        level, parent_agent_id, manager_assistant_id,
                        home_scope_id, config_json, system_prompt_additions,
                        domains_json, capabilities_json, status, created_by
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
                `).run(
                    id, orgId, agent_id, name, description || null, icon || null,
                    level, parent_agent_id || null, manager_assistant_id || null,
                    home_scope_id || null, JSON.stringify(config),
                    system_prompt_additions || null,
                    JSON.stringify(domains), JSON.stringify(capabilities),
                    userId
                );
            })();

            // Audit log with AOCL layer tracking
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'directory.agent.create',
                targetType: 'agent',
                targetId: id,
                metadata: {
                    agent_id,
                    name,
                    level,
                    domains,
                    capabilities,
                    aocl_layers: ['L7_SEMANTIC', 'L8_DECISION', 'L9_EXECUTION']
                }
            });

            const agent = prepare('SELECT * FROM agents WHERE id = ?').get(id);

            res.status(201).json({
                agent: {
                    ...agent,
                    domains: JSON.parse(agent.domains_json || '[]'),
                    capabilities: JSON.parse(agent.capabilities_json || '[]'),
                    config: JSON.parse(agent.config_json || '{}')
                }
            });
        } catch (error) {
            console.error('Error creating agent:', error);
            res.status(500).json({ error: 'Failed to create agent' });
        }
    }
);

/**
 * PATCH /orgs/:orgId/agents/:agentId
 * Update an agent
 */
router.patch('/orgs/:orgId/agents/:agentId',
    requireOrgMembership,
    requireOrgRole('builder'),
    async (req, res) => {
        try {
            const { orgId } = req.params;
            const {
                name,
                description,
                icon,
                level,
                parent_agent_id,
                manager_assistant_id,
                home_scope_id,
                config,
                system_prompt_additions,
                domains,
                capabilities,
                status
            } = req.body;
            const userId = req.user.id;

            // Check capability
            if (!resolveCap(req, Capabilities.AGENTS_MANAGE)) {
                return res.status(403).json({ error: 'Insufficient permissions to manage agents' });
            }

            // Check agent exists (also resolves :agentId, either the internal
            // id or the agent_id slug, to the internal id — fleet #365)
            const agentId = resolveAgentInternalId(orgId, req.params.agentId);
            const existing = agentId ? prepare(`
                SELECT * FROM agents WHERE id = ? AND org_id = ? AND status != 'retired'
            `).get(agentId, orgId) : null;

            if (!existing) {
                return res.status(404).json({ error: 'Agent not found' });
            }

            // A built-in's identity, prompt, tools and model ship with the product: refuse, write nothing.
            const builtinRefusal = builtinAgentPatchRefusal(existing, req.body);
            if (builtinRefusal) return res.status(builtinRefusal.status).json(builtinRefusal.body);

            // Build update
            const updates = [];
            const values = [];
            const changedFields = [];

            if (name !== undefined) {
                updates.push('name = ?');
                values.push(name);
                changedFields.push('name');
            }
            if (description !== undefined) {
                updates.push('description = ?');
                values.push(description);
                changedFields.push('description');
            }
            if (icon !== undefined) {
                updates.push('icon = ?');
                values.push(icon);
                changedFields.push('icon');
            }
            if (level !== undefined) {
                if (level < 0 || level > 4) {
                    return res.status(400).json({ error: 'Level must be between 0 and 4' });
                }
                updates.push('level = ?');
                values.push(level);
                changedFields.push('level');
            }
            if (parent_agent_id !== undefined) {
                if (parent_agent_id) {
                    const parent = prepare(`
                        SELECT level FROM agents WHERE id = ? AND org_id = ? AND status != 'retired'
                    `).get(parent_agent_id, orgId);
                    if (!parent) {
                        return res.status(400).json({ error: 'Parent agent not found' });
                    }
                }
                updates.push('parent_agent_id = ?');
                values.push(parent_agent_id || null);
                changedFields.push('parent_agent_id');
            }
            if (manager_assistant_id !== undefined) {
                updates.push('manager_assistant_id = ?');
                values.push(manager_assistant_id || null);
                changedFields.push('manager_assistant_id');
            }
            if (home_scope_id !== undefined) {
                if (home_scope_id) {
                    const scope = prepare('SELECT id FROM scopes WHERE id = ? AND org_id = ?').get(home_scope_id, orgId);
                    if (!scope) {
                        return res.status(400).json({ error: 'Home scope not found' });
                    }
                }
                updates.push('home_scope_id = ?');
                values.push(home_scope_id || null);
                changedFields.push('home_scope_id');
            }
            if (config !== undefined) {
                updates.push('config_json = ?');
                values.push(JSON.stringify(config));
                changedFields.push('config');
            }
            if (system_prompt_additions !== undefined) {
                updates.push('system_prompt_additions = ?');
                values.push(system_prompt_additions || null);
                changedFields.push('system_prompt_additions');
            }
            if (domains !== undefined) {
                updates.push('domains_json = ?');
                values.push(JSON.stringify(domains));
                changedFields.push('domains');
            }
            if (capabilities !== undefined) {
                updates.push('capabilities_json = ?');
                values.push(JSON.stringify(capabilities));
                changedFields.push('capabilities');
            }
            if (status !== undefined) {
                if (!['draft', 'active', 'paused', 'retired'].includes(status)) {
                    return res.status(400).json({ error: 'Invalid status' });
                }
                updates.push('status = ?');
                values.push(status);
                changedFields.push('status');
            }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            updates.push("updated_at = datetime('now')");
            values.push(agentId);

            prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...values);

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'directory.agent.update',
                targetType: 'agent',
                targetId: agentId,
                metadata: {
                    agent_id: existing.agent_id,
                    updated_fields: changedFields,
                    aocl_layers: ['L7_SEMANTIC', 'L8_DECISION']
                }
            });

            const agent = prepare('SELECT * FROM agents WHERE id = ?').get(agentId);

            res.json({
                agent: {
                    ...agent,
                    domains: JSON.parse(agent.domains_json || '[]'),
                    capabilities: JSON.parse(agent.capabilities_json || '[]'),
                    config: JSON.parse(agent.config_json || '{}')
                }
            });
        } catch (error) {
            console.error('Error updating agent:', error);
            res.status(500).json({ error: 'Failed to update agent' });
        }
    }
);

/**
 * DELETE /orgs/:orgId/agents/:agentId
 * Soft delete (retire) an agent
 */
router.delete('/orgs/:orgId/agents/:agentId',
    requireOrgMembership,
    requireOrgRole('builder'),
    async (req, res) => {
        try {
            const { orgId } = req.params;
            const userId = req.user.id;

            // Check capability
            if (!resolveCap(req, Capabilities.AGENTS_MANAGE)) {
                return res.status(403).json({ error: 'Insufficient permissions to manage agents' });
            }

            // Check agent exists (also resolves the URL's agentId, which may be
            // either the internal id or the human-facing agent_id slug, to the
            // internal id every downstream query here expects — fleet #365)
            const agentRef = resolveAgentRef(orgId, req.params.agentId);

            if (!agentRef) {
                return res.status(404).json({ error: 'Agent not found' });
            }
            const agentId = agentRef.id;

            // Check for child agents
            const childCount = prepare(`
                SELECT COUNT(*) as count FROM agents
                WHERE parent_agent_id = ? AND status != 'retired'
            `).get(agentId);

            if (childCount.count > 0) {
                return res.status(409).json({
                    error: `Cannot retire agent with ${childCount.count} active child agent(s). Retire or reassign children first.`
                });
            }

            const db = getDb();

            db.transaction(() => {
                // Retire the agent
                prepare(`
                    UPDATE agents
                    SET status = 'retired', updated_at = datetime('now')
                    WHERE id = ?
                `).run(agentId);

                // Revoke all tool assignments
                // fleet #380: agent_tool_assignments keys off the manifest
                // slug (agent_id), not the internal ULID — unlike
                // assistant_agent_routing below, which does use agent_db_id.
                prepare(`
                    UPDATE agent_tool_assignments
                    SET revoked_at = datetime('now'), revoked_by = ?
                    WHERE agent_id = ? AND revoked_at IS NULL
                `).run(userId, agentRef.agentSlug);

                // Disable routing
                prepare(`
                    UPDATE assistant_agent_routing
                    SET enabled = 0, updated_at = datetime('now')
                    WHERE agent_db_id = ?
                `).run(agentId);

                // fleet #382: emit the audit record INSIDE the transaction.
                // It used to run after commit, so anything that threw in
                // between (in this case a stale `existing` reference left by
                // the #380 refactor) let a destructive, governance-relevant
                // mutation land with no audit row while the caller was told
                // it failed. Retire and its audit record now commit or roll
                // back together. createAuditEvent is synchronous and uses the
                // same connection, so it is safe to enlist here.
                createAuditEvent({
                    orgId,
                    actorType: 'user',
                    actorId: userId,
                    action: 'directory.agent.delete',
                    targetType: 'agent',
                    targetId: agentId,
                    metadata: {
                        agent_id: agentRef.agentSlug,
                        name: agentRef.name,
                        aocl_layers: ['L7_SEMANTIC', 'L8_DECISION', 'L9_EXECUTION']
                    }
                });
            })();

            res.json({ success: true, message: 'Agent retired' });
        } catch (error) {
            console.error('Error retiring agent:', error);
            res.status(500).json({ error: 'Failed to retire agent' });
        }
    }
);

// ============================================================================
// TOOL ASSIGNMENT ROUTES
// ============================================================================

/**
 * GET /orgs/:orgId/agents/:agentId/tools
 * List tools assigned to an agent
 */
router.get('/orgs/:orgId/agents/:agentId/tools', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const agentId = resolveAgentInternalId(orgId, req.params.agentId);
        if (!agentId) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        // Check agent exists
        const agent = prepare(`
            SELECT id, agent_id, name FROM agents WHERE id = ? AND org_id = ?
        `).get(agentId, orgId);

        if (!agent) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        const assignments = prepare(`
            SELECT ata.*, ti.config_json as installation_config,
                   td.tool_id, td.name as tool_name, td.description as tool_description,
                   td.category, td.subcategory, td.risk_level, td.sandbox_profile,
                   td.icon, td.capabilities_json as tool_capabilities,
                   u.display_name as assigned_by_name
            FROM agent_tool_assignments ata
            JOIN tool_installations ti ON ata.tool_installation_id = ti.id
            JOIN tool_definitions td ON ti.tool_definition_id = td.id
            LEFT JOIN users u ON ata.assigned_by = u.id
            WHERE ata.agent_id = ?
              AND ata.revoked_at IS NULL
            ORDER BY td.category, td.name
        `).all(agent.agent_id);

        const toolStatus = checkToolLimitStatus(agent.agent_id, orgId);

        res.json({
            agent: { id: agent.id, agent_id: agent.agent_id, name: agent.name },
            assignments: assignments.map(a => ({
                ...a,
                tool_capabilities: JSON.parse(a.tool_capabilities || '[]'),
                allowed_operations: JSON.parse(a.allowed_operations_json || 'null')
            })),
            toolStatus
        });
    } catch (error) {
        console.error('Error listing agent tools:', error);
        res.status(500).json({ error: 'Failed to list agent tools' });
    }
});

/**
 * Grant ceiling (ASSAY audit 2026-10-16): a granter cannot give an agent more than they hold. A
 * high- or critical-risk tool runs behind an approval card; someone without hitl.approve could not
 * approve that card, so they may grant such a tool only as 'with_approval' (the card stays). Applies
 * to every write path: assign, PATCH and bulk-assign. Returns a plain refusal string, or null.
 *
 * Scope note: auth has no per-user tool permission model, so this ceiling is RISK-based (risk_level +
 * hitl.approve), not per-tool. A finer per-tool model is a later product decision (SITE-CLI 2026-10-16).
 */
const HIGH_RISK_LEVELS = new Set(['high', 'critical']);

/**
 * Operator-only tools (quox#1171/#1180, SITE-CLI 2026-10-16): proof.status reads the INSTANCE
 * operator's proof board, so it may be given to an agent only in the operator's org
 * (instance_config fleet.operator_org_id) or by an instance admin (admin/superadmin). No operator
 * org configured = only an instance admin (fail closed). Returns a refusal string, or null.
 */
const OPERATOR_ONLY_TOOL_IDS = new Set(['proof.status']);
function operatorOnlyRefusal(req, orgId, toolId, toolName) {
    if (!OPERATOR_ONLY_TOOL_IDS.has(toolId)) return null;
    const ia = req.user && req.user.id ? checkInstanceAdmin(req.user.id) : { isAdmin: false };
    if (ia.isAdmin && (ia.role === 'admin' || ia.role === 'superadmin')) return null;
    const row = getDb().prepare("SELECT value FROM instance_config WHERE key = 'fleet.operator_org_id'").get();
    const operatorOrg = row && row.value ? String(row.value) : null;
    if (operatorOrg && operatorOrg === orgId) return null;
    return `${toolName || toolId} reads the instance operator's data, so it can only be given to an agent in the operator's org, or by an instance admin. Nothing was changed.`;
}
function grantCeilingRefusal(req, riskLevel, accessMode, toolName) {
    if (!HIGH_RISK_LEVELS.has(String(riskLevel || '').toLowerCase())) return null;
    if (accessMode === 'with_approval') return null;
    if (resolveCap(req, Capabilities.HITL_APPROVE)) return null;
    return `You cannot give an agent ${toolName || 'this tool'} at access mode '${accessMode}': it is ${riskLevel}-risk, and you cannot approve its approval card yourself (no hitl.approve). Grant it with access_mode with_approval, or ask an org admin.`;
}

/**
 * POST /orgs/:orgId/agents/:agentId/tools
 * Assign a tool to an agent
 */
router.post('/orgs/:orgId/agents/:agentId/tools',
    requireOrgMembership,
    requireOrgRole('builder'),
    humanGrantorOnly,
    async (req, res) => {
        try {
            const { orgId } = req.params;
            const {
                tool_id,
                access_mode = 'full',
                scope_id,
                max_daily_invocations,
                allowed_operations
            } = req.body;
            const userId = req.user.id;

            // Check capability
            if (!resolveCap(req, Capabilities.TOOLS_ASSIGN)) {
                return res.status(403).json({ error: 'Insufficient permissions to assign tools' });
            }

            // Check agent exists — or an ACTIVE resident identity (QUOXTRUST
            // WP3.4b: residents are assignable principals; they get tools ONLY
            // by explicit assignment, never by fallback — lib/residentAssignmentKey.js).
            const agentId = resolveAgentInternalId(orgId, req.params.agentId);
            const agent = agentId ? prepare(`
                SELECT * FROM agents WHERE id = ? AND org_id = ? AND status != 'retired'
            `).get(agentId, orgId) : null;

            let assignmentKey = agent ? agent.agent_id : null;
            if (!agent) {
                const resident = resolveResidentAssignmentKey(getDb(), orgId, req.params.agentId);
                if (resident) assignmentKey = resident.assignmentKey;
            }
            if (!assignmentKey) {
                const builtin = resolveBuiltinAgent(req.params.agentId);
                if (builtin) return res.status(409).json(builtinAgentAssignRefusal(builtin));
                return res.status(404).json({ error: 'Agent not found' });
            }

            // Resolve THIS org's enabled installation. The CLI sends
            // { tool_id } (a definition id or tool slug, what `quox tool list`
            // shows); the UI sends { tool_installation_id }. Every lookup is
            // pinned to ti.org_id = the verified :orgId.
            const requested = req.body.tool_installation_id || tool_id;
            if (!requested) {
                return res.status(400).json({ error: 'tool_installation_id or tool_id is required' });
            }
            const installation = prepare(`
                SELECT ti.*, td.name as tool_name, td.tool_id, td.risk_level as tool_risk_level
                FROM tool_installations ti
                JOIN tool_definitions td ON ti.tool_definition_id = td.id
                WHERE ti.org_id = ? AND ti.enabled = 1
                  AND (ti.id = ? OR td.id = ? OR td.tool_id = ?)
                ORDER BY (ti.id = ?) DESC
                LIMIT 1
            `).get(orgId, requested, requested, requested, requested);

            if (!installation) {
                // quox#1045: only point at `quox tool install` when the id is in
                // the catalog; otherwise that hint can never be followed.
                const inCatalog = prepare('SELECT tool_id FROM tool_definitions WHERE id = ? OR tool_id = ? LIMIT 1')
                    .get(requested, requested);
                return res.status(404).json({
                    error: inCatalog
                        ? `Tool ${requested} is not installed (or is disabled) in this org. Install it first: quox tool install ${inCatalog.tool_id}`
                        : toolNotInCatalogMessage(getDb(), orgId, requested)
                });
            }
            const tool_installation_id = installation.id;

            // Check tool limit
            const toolStatus = checkToolLimitStatus(assignmentKey, orgId);
            if (!toolStatus.canAdd) {
                return res.status(409).json({
                    error: `Agent has reached the hard limit of ${toolStatus.limits.hard} tools. Cannot add more.`,
                    toolStatus
                });
            }

            // Validate access mode
            if (!['full', 'read_only', 'with_approval'].includes(access_mode)) {
                return res.status(400).json({ error: 'Invalid access_mode' });
            }
            const ceiling = grantCeilingRefusal(req, installation.tool_risk_level, access_mode, installation.tool_name);
            if (ceiling) {
                return res.status(403).json({ error: ceiling, code: 'GRANT_EXCEEDS_GRANTER' });
            }
            const operatorOnly = operatorOnlyRefusal(req, orgId, installation.tool_id, installation.tool_name);
            if (operatorOnly) {
                return res.status(403).json({ error: operatorOnly, code: 'OPERATOR_ONLY_TOOL' });
            }

            // Check for existing assignment
            const existingAssignment = prepare(`
                SELECT id FROM agent_tool_assignments
                WHERE agent_id = ? AND tool_installation_id = ? AND revoked_at IS NULL
            `).get(assignmentKey, tool_installation_id);

            if (existingAssignment) {
                return res.status(409).json({ error: 'Tool is already assigned to this agent' });
            }

            // Validate scope if provided
            if (scope_id) {
                const scope = prepare('SELECT id FROM scopes WHERE id = ? AND org_id = ?').get(scope_id, orgId);
                if (!scope) {
                    return res.status(400).json({ error: 'Scope not found' });
                }
            }

            const id = ulid();

            prepare(`
                INSERT INTO agent_tool_assignments (
                    id, org_id, tool_installation_id, agent_id,
                    scope_id, access_mode, max_daily_invocations, allowed_operations_json,
                    assigned_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                id, orgId, tool_installation_id, assignmentKey,
                scope_id || null, access_mode, max_daily_invocations || null,
                allowed_operations ? JSON.stringify(allowed_operations) : null,
                userId
            );

            // Audit log with AOCL layer tracking
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'directory.agent.tool_assign',
                targetType: 'agent',
                targetId: agentId,
                metadata: {
                    agent_id: assignmentKey,
                    tool_id: installation.tool_id,
                    tool_name: installation.tool_name,
                    access_mode,
                    assignment_id: id,
                    new_tool_count: toolStatus.count + 1,
                    aocl_layers: ['L6_POLICY', 'L7_SEMANTIC', 'L8_DECISION', 'L9_EXECUTION']
                }
            });

            // Check if we need to warn about tool count
            const newToolStatus = checkToolLimitStatus(assignmentKey, orgId);

            res.status(201).json({
                assignment: {
                    id,
                    tool_id: installation.tool_id,
                    tool_name: installation.tool_name,
                    access_mode,
                    scope_id,
                    max_daily_invocations
                },
                toolStatus: newToolStatus,
                warning: newToolStatus.status !== 'ok' ?
                    `Agent now has ${newToolStatus.count} tools. ${
                        newToolStatus.status === 'soft_limit' ?
                            'Consider splitting into multiple specialized agents.' :
                            'Consider keeping toolsets focused.'
                    }` : null
            });
        } catch (error) {
            console.error('Error assigning tool to agent:', error);
            res.status(500).json({ error: 'Failed to assign tool' });
        }
    }
);

/**
 * PATCH /orgs/:orgId/agents/:agentId/tools/:assignmentId
 * Update a tool assignment
 */
router.patch('/orgs/:orgId/agents/:agentId/tools/:assignmentId',
    requireOrgMembership,
    requireOrgRole('builder'),
    humanGrantorOnly,
    async (req, res) => {
        try {
            const { orgId, assignmentId } = req.params;
            const { access_mode, enabled, max_daily_invocations, allowed_operations } = req.body;
            const userId = req.user.id;

            // Check capability
            if (!resolveCap(req, Capabilities.TOOLS_ASSIGN)) {
                return res.status(403).json({ error: 'Insufficient permissions to manage tool assignments' });
            }

            // Get the agent to get its manifest ID. Was previously broken for
            // every caller: this lookup treated :agentId as the internal id
            // while the assignment lookup below treated it as the agent_id
            // slug (agent_tool_assignments.agent_id is denormalized), so no
            // single value passed in the URL could ever satisfy both (fleet
            // #365 bug family).
            const resolvedAgentId = resolveAgentInternalId(orgId, req.params.agentId);
            const agent = resolvedAgentId ? prepare(`
                SELECT agent_id FROM agents WHERE id = ? AND org_id = ?
            `).get(resolvedAgentId, orgId) : null;

            if (!agent) {
                return res.status(404).json({ error: 'Agent not found' });
            }

            // Check assignment exists
            const assignment = prepare(`
                SELECT ata.*, td.tool_id, td.name as tool_name, td.risk_level as tool_risk_level
                FROM agent_tool_assignments ata
                JOIN tool_installations ti ON ata.tool_installation_id = ti.id
                JOIN tool_definitions td ON ti.tool_definition_id = td.id
                WHERE ata.id = ? AND ata.agent_id = ? AND ata.org_id = ? AND ata.revoked_at IS NULL
            `).get(assignmentId, agent.agent_id, orgId);

            if (!assignment) {
                return res.status(404).json({ error: 'Tool assignment not found' });
            }

            // Build update
            const updates = [];
            const values = [];
            const changedFields = [];

            if (access_mode !== undefined) {
                if (!['full', 'read_only', 'with_approval'].includes(access_mode)) {
                    return res.status(400).json({ error: 'Invalid access_mode' });
                }
                const ceiling = grantCeilingRefusal(req, assignment.tool_risk_level, access_mode, assignment.tool_name);
                if (ceiling) {
                    return res.status(403).json({ error: ceiling, code: 'GRANT_EXCEEDS_GRANTER' });
                }
                updates.push('access_mode = ?');
                values.push(access_mode);
                changedFields.push('access_mode');
            }
            if (enabled !== undefined) {
                updates.push('enabled = ?');
                values.push(enabled ? 1 : 0);
                changedFields.push('enabled');
            }
            if (max_daily_invocations !== undefined) {
                updates.push('max_daily_invocations = ?');
                values.push(max_daily_invocations);
                changedFields.push('max_daily_invocations');
            }
            if (allowed_operations !== undefined) {
                updates.push('allowed_operations_json = ?');
                values.push(allowed_operations ? JSON.stringify(allowed_operations) : null);
                changedFields.push('allowed_operations');
            }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            updates.push("updated_at = datetime('now')");
            values.push(assignmentId);

            prepare(`UPDATE agent_tool_assignments SET ${updates.join(', ')} WHERE id = ?`).run(...values);

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'directory.agent.tool_update',
                targetType: 'agent',
                targetId: agent.agent_id,
                metadata: {
                    tool_id: assignment.tool_id,
                    assignment_id: assignmentId,
                    updated_fields: changedFields,
                    aocl_layers: ['L6_POLICY', 'L8_DECISION']
                }
            });

            res.json({ success: true, updated_fields: changedFields });
        } catch (error) {
            console.error('Error updating tool assignment:', error);
            res.status(500).json({ error: 'Failed to update tool assignment' });
        }
    }
);

/**
 * DELETE /orgs/:orgId/agents/:agentId/tools/:assignmentId
 * Revoke a tool assignment
 */
router.delete('/orgs/:orgId/agents/:agentId/tools/:assignmentId',
    requireOrgMembership,
    requireOrgRole('builder'),
    async (req, res) => {
        try {
            const { orgId, agentId, assignmentId } = req.params;
            const userId = req.user.id;

            // Check capability
            if (!resolveCap(req, Capabilities.TOOLS_ASSIGN)) {
                return res.status(403).json({ error: 'Insufficient permissions to manage tool assignments' });
            }

            // Check assignment exists
            const assignment = prepare(`
                SELECT ata.*, td.tool_id, td.name as tool_name
                FROM agent_tool_assignments ata
                JOIN tool_installations ti ON ata.tool_installation_id = ti.id
                JOIN tool_definitions td ON ti.tool_definition_id = td.id
                WHERE ata.id = ? AND ata.agent_id = ? AND ata.org_id = ? AND ata.revoked_at IS NULL
            `).get(assignmentId, agentId, orgId);

            if (!assignment) {
                return res.status(404).json({ error: 'Tool assignment not found' });
            }

            prepare(`
                UPDATE agent_tool_assignments
                SET revoked_at = datetime('now'), revoked_by = ?
                WHERE id = ?
            `).run(userId, assignmentId);

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'directory.agent.tool_revoke',
                targetType: 'agent',
                targetId: agentId,
                metadata: {
                    tool_id: assignment.tool_id,
                    tool_name: assignment.tool_name,
                    assignment_id: assignmentId,
                    aocl_layers: ['L6_POLICY', 'L8_DECISION', 'L9_EXECUTION']
                }
            });

            const newToolStatus = checkToolLimitStatus(agentId, orgId);

            res.json({
                success: true,
                message: 'Tool assignment revoked',
                toolStatus: newToolStatus
            });
        } catch (error) {
            console.error('Error revoking tool assignment:', error);
            res.status(500).json({ error: 'Failed to revoke tool assignment' });
        }
    }
);

// ============================================================================
// BULK TOOL ASSIGNMENT (P4.C)
// ============================================================================

/**
 * POST /orgs/:orgId/agents/:agentId/tools/bulk-assign
 *
 * Diff-based replacement of the tool assignment set for one agent.
 * Body: { tool_installation_ids: ["instId1", "instId2", ...] }
 *
 * Algorithm:
 *   1. Fetch current active assignments for (org_id, agent_id).
 *   2. Compute diff: rows to insert (in body, not in DB), rows to revoke (in DB, not in body).
 *   3. Apply both in a transaction.
 *   4. Fire cache-invalidation request to collector (best-effort, non-blocking).
 *
 * Returns: { assignments: [...], added: N, removed: M }
 */
router.post('/orgs/:orgId/agents/:agentId/tools/bulk-assign',
    requireOrgMembership,
    requireOrgRole('builder'),
    humanGrantorOnly,
    async (req, res) => {
        try {
            const { orgId } = req.params;
            const { tool_installation_ids = [] } = req.body;
            const userId = req.user.id;

            // Capability check
            if (!resolveCap(req, Capabilities.TOOLS_ASSIGN)) {
                return res.status(403).json({ error: 'Insufficient permissions to assign tools' });
            }

            // Validate input
            if (!Array.isArray(tool_installation_ids)) {
                return res.status(400).json({ error: 'tool_installation_ids must be an array' });
            }

            // Check agent exists in this org (also resolves :agentId, either
            // the internal id or the agent_id slug — fleet #365)
            const agentId = resolveAgentInternalId(orgId, req.params.agentId);
            const agent = agentId ? prepare(`
                SELECT id, agent_id, name FROM agents WHERE id = ? AND org_id = ? AND status != 'retired'
            `).get(agentId, orgId) : null;

            if (!agent) {
                const builtin = resolveBuiltinAgent(req.params.agentId);
                if (builtin) return res.status(409).json(builtinAgentAssignRefusal(builtin));
                return res.status(404).json({ error: 'Agent not found' });
            }

            // Validate all tool_installation_ids belong to this org and are enabled
            const validInstallations = new Map();
            if (tool_installation_ids.length > 0) {
                const placeholders = tool_installation_ids.map(() => '?').join(',');
                const installations = prepare(`
                    SELECT ti.id, td.tool_id, td.name as tool_name
                    FROM tool_installations ti
                    JOIN tool_definitions td ON ti.tool_definition_id = td.id
                    WHERE ti.id IN (${placeholders}) AND ti.org_id = ? AND ti.enabled = 1
                `).all(...tool_installation_ids, orgId);

                for (const inst of installations) {
                    validInstallations.set(inst.id, inst);
                }

                // Check for invalid IDs
                const unknownIds = tool_installation_ids.filter(id => !validInstallations.has(id));
                if (unknownIds.length > 0) {
                    return res.status(400).json({
                        error: 'Some tool_installation_ids are invalid or not installed in this org',
                        unknown_ids: unknownIds
                    });
                }
            }

            // Fetch current active assignments
            const currentAssignments = prepare(`
                SELECT id, tool_installation_id
                FROM agent_tool_assignments
                WHERE agent_id = ? AND org_id = ? AND revoked_at IS NULL
            `).all(agent.agent_id, orgId);

            const currentSet = new Map(currentAssignments.map(r => [r.tool_installation_id, r.id]));
            const desiredSet = new Set(tool_installation_ids);

            // Compute diff
            const toRevoke = currentAssignments.filter(r => !desiredSet.has(r.tool_installation_id));
            const toInsert = tool_installation_ids.filter(id => !currentSet.has(id));

            // Check hard tool limit (existing active minus revoked plus inserts)
            const netCount = currentSet.size - toRevoke.length + toInsert.length;
            const toolStatus = checkToolLimitStatus(agent.agent_id, orgId);
            if (netCount > toolStatus.limits.hard) {
                return res.status(409).json({
                    error: `Assignment would exceed hard limit of ${toolStatus.limits.hard} tools per agent`,
                    current: currentSet.size,
                    requested: tool_installation_ids.length,
                    limit: toolStatus.limits.hard
                });
            }

            // Grant ceiling: bulk-assign writes access_mode 'full', so a high/critical-risk tool the
            // granter could not approve is refused (nothing is written). Use the single assign route
            // with access_mode with_approval for those.
            for (const instId of toInsert) {
                const t = prepare(`
                    SELECT td.name, td.risk_level, td.tool_id FROM tool_installations ti
                    JOIN tool_definitions td ON ti.tool_definition_id = td.id
                    WHERE ti.id = ? AND ti.org_id = ?
                `).get(instId, orgId);
                const ceiling = t && grantCeilingRefusal(req, t.risk_level, 'full', t.name);
                if (ceiling) {
                    return res.status(403).json({ error: `${ceiling} Bulk assign always grants full, so assign it on its own.`, code: 'GRANT_EXCEEDS_GRANTER' });
                }
                const operatorOnly = t && operatorOnlyRefusal(req, orgId, t.tool_id, t.name);
                if (operatorOnly) {
                    return res.status(403).json({ error: operatorOnly, code: 'OPERATOR_ONLY_TOOL' });
                }
            }

            // Apply diff in a transaction
            const db = getDb();
            const applyDiff = db.transaction(() => {
                // Revoke removed tools
                for (const row of toRevoke) {
                    prepare(`
                        UPDATE agent_tool_assignments
                        SET revoked_at = datetime('now'), revoked_by = ?
                        WHERE id = ?
                    `).run(userId, row.id);
                }

                // Insert new assignments
                const insertedIds = [];
                for (const instId of toInsert) {
                    const id = ulid();
                    prepare(`
                        INSERT INTO agent_tool_assignments (
                            id, org_id, tool_installation_id, agent_id,
                            access_mode, assigned_by
                        ) VALUES (?, ?, ?, ?, 'full', ?)
                    `).run(id, orgId, instId, agent.agent_id, userId);
                    insertedIds.push(id);
                }

                return insertedIds;
            });

            applyDiff();

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'directory.agent.tool_bulk_assign',
                targetType: 'agent',
                targetId: agentId,
                metadata: {
                    agent_id: agent.agent_id,
                    added: toInsert.length,
                    removed: toRevoke.length,
                    total: tool_installation_ids.length,
                    aocl_layers: ['L6_POLICY', 'L8_DECISION', 'L9_EXECUTION']
                }
            });

            // Fire cache invalidation to collector (best-effort, non-blocking)
            const collectorUrl = process.env.COLLECTOR_URL
                || process.env.QUOX_COLLECTOR_URL
                || 'http://collector:9848';
            const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
            fetch(`${collectorUrl}/api/internal/agent-tools/invalidate-cache`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(serviceKey ? { 'X-Service-Key': serviceKey } : {})
                },
                body: JSON.stringify({ agent_id: agent.agent_id }),
                signal: AbortSignal.timeout(3000)
            }).catch(err => {
                // Non-blocking — cache will expire naturally after 60s
                console.warn(`[BulkAssign] Cache invalidation failed for agent '${agent.agent_id}': ${err.message}`);
            });

            // Fetch updated assignments for response
            const updatedAssignments = prepare(`
                SELECT ata.id, ata.tool_installation_id, ata.access_mode, ata.assigned_at,
                       td.tool_id, td.name as tool_name, td.category
                FROM agent_tool_assignments ata
                JOIN tool_installations ti ON ata.tool_installation_id = ti.id
                JOIN tool_definitions td ON ti.tool_definition_id = td.id
                WHERE ata.agent_id = ? AND ata.org_id = ? AND ata.revoked_at IS NULL
                ORDER BY td.category, td.name
            `).all(agent.agent_id, orgId);

            const newToolStatus = checkToolLimitStatus(agent.agent_id, orgId);

            res.json({
                assignments: updatedAssignments,
                added: toInsert.length,
                removed: toRevoke.length,
                toolStatus: newToolStatus
            });
        } catch (error) {
            console.error('Error in bulk tool assignment:', error);
            res.status(500).json({ error: 'Failed to bulk assign tools' });
        }
    }
);

// ============================================================================
// AGENT HIERARCHY ROUTES
// ============================================================================

/**
 * GET /orgs/:orgId/agents/tree
 * Get agent hierarchy tree for family tree visualization
 */
router.get('/orgs/:orgId/agents/tree', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;

        const agents = prepare(`
            SELECT a.id, a.agent_id, a.name, a.description, a.icon,
                   a.level, a.parent_agent_id, a.manager_assistant_id,
                   a.status, a.domains_json, a.capabilities_json,
                   COUNT(DISTINCT ata.id) as tool_count
            FROM agents a
            LEFT JOIN agent_tool_assignments ata ON ata.agent_id = a.agent_id
                AND ata.revoked_at IS NULL AND ata.enabled = 1
            WHERE a.org_id = ? AND a.status != 'retired'
            GROUP BY a.id
            ORDER BY a.level, a.name
        `).all(orgId);

        // Build tree structure
        const agentMap = new Map();
        const roots = [];

        // First pass: create map
        agents.forEach(agent => {
            agentMap.set(agent.id, {
                ...agent,
                domains: JSON.parse(agent.domains_json || '[]'),
                capabilities: JSON.parse(agent.capabilities_json || '[]'),
                children: []
            });
        });

        // Second pass: build hierarchy
        agents.forEach(agent => {
            const node = agentMap.get(agent.id);
            if (agent.parent_agent_id && agentMap.has(agent.parent_agent_id)) {
                agentMap.get(agent.parent_agent_id).children.push(node);
            } else {
                roots.push(node);
            }
        });

        res.json({ tree: roots });
    } catch (error) {
        console.error('Error getting agent tree:', error);
        res.status(500).json({ error: 'Failed to get agent tree' });
    }
});

// ============================================================================
// INTERNAL ENDPOINTS (service-to-service, no JWT required)
// Used by the collector to resolve custom agent tools and prompts
// Auth: X-Service-Key header matching INTERNAL_SERVICE_KEY env var
// ============================================================================

const internalRouter = Router();

/**
 * Internal service key auth middleware.
 * When INTERNAL_SERVICE_KEY is not set, fails closed (denies request).
 */
function requireInternalAuth(req, res, next) {
    const expectedKey = globalThis.process?.env?.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying request');
        return res.status(401).json({ error: 'Service key not configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey && safeCompare(serviceKey, expectedKey)) {
        return next();
    }
    return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

internalRouter.use(requireInternalAuth);

/**
 * SECURITY (ASSAY audit 2026-10-16): agent slugs are unique per org only, so the
 * internal lookups must never pick a custom agent from another org. The caller names
 * its org (?org_id= or X-Org-Id): a custom agent resolves only inside that org, a
 * built-in (is_core) agent for any org. With no org named, only a built-in resolves.
 */
function internalCallerOrg(req) {
    const org = req.query.org_id || req.headers['x-org-id'];
    return typeof org === 'string' && org.trim() ? org.trim() : null;
}

function findInternalAgentRow(db, columns, agentId, orgId) {
    if (orgId) {
        return db.prepare(`
            SELECT ${columns} FROM agents
            WHERE agent_id = ? AND status = 'active' AND (org_id = ? OR is_core = 1)
            ORDER BY is_core DESC  -- a built-in is never shadowed by a tenant row of the same slug
            LIMIT 1
        `).get(agentId, orgId);
    }
    return db.prepare(`
        SELECT ${columns} FROM agents
        WHERE agent_id = ? AND status = 'active' AND is_core = 1
        LIMIT 1
    `).get(agentId);
}

/**
 * GET /internal/agents/:agentId/tools
 * Returns tool names (TOOL_DEFS keys) assigned to a custom agent.
 *
 * The collector needs TOOL_DEFS key names (e.g., "system_services") not entity IDs
 * (e.g., "system.services"), so we convert dots to underscores.
 */
internalRouter.get('/agents/:agentId/tools', (req, res) => {
    try {
        const db = getDb();
        const { agentId } = req.params;

        // Org-scoped: a custom agent only inside the caller's org, a built-in for any org.
        const agent = findInternalAgentRow(db, 'id, org_id', agentId, internalCallerOrg(req));

        // QUOXTRUST WP3.4b: an ACTIVE resident identity is also a valid
        // assignment principal (keyed by its lowercased user_id — the same
        // normalization the collector's RBAC lookup uses). A resident with no
        // assignments returns an EMPTY toolset with 200 — a definitive
        // "asked, nothing assigned" the collector's fail-closed RBAC can act
        // on, instead of the 404 that read as "could not ask".
        let chainAgentId = agent ? agentId : null;
        let chainOrgId = agent ? agent.org_id : null;
        if (!agent) {
            const resident = resolveResidentAssignmentKey(db, internalCallerOrg(req), agentId);
            if (resident) {
                chainAgentId = resident.assignmentKey;
                chainOrgId = resident.orgId;
            }
        }
        if (!chainAgentId) {
            return res.status(404).json({ error: `Agent '${agentId}' not found` });
        }

        // Get tool names + full spec via assignment chain:
        // agent_tool_assignments → tool_installations → tool_definitions
        // #556: ata.access_mode is selected here so the collector can gate
        // 'with_approval' tools; it previously stopped at CRUD/display only.
        const tools = db.prepare(`
            SELECT td.id, td.tool_id, td.name, td.description, td.spec_json, td.provider,
                   td.trust_tier,
                   ti.config_json AS install_config_json,
                   ata.access_mode
            FROM agent_tool_assignments ata
            JOIN tool_installations ti ON ti.id = ata.tool_installation_id
            JOIN tool_definitions td ON td.id = ti.tool_definition_id
            WHERE ata.agent_id = ?
              AND ata.org_id = ?
              AND ata.enabled = 1
              AND ata.revoked_at IS NULL
              AND ti.enabled = 1
        `).all(chainAgentId, chainOrgId);

        // Build Anthropic-shaped descriptors from spec_json; source: 'db' for observability.
        //
        // POWERS-INTROSPECT-P2: For mcp_endpoint / mcp_hosted tools with populated
        // available_tools, UNFOLD into N discrete LLM-facing tool entries.
        // If available_tools is empty (probe failed / legacy MCP), fall back to the
        // single-wrapper-schema path (MVP state — LLM guesses tool names).
        const toolDescriptors = [];
        // toolNames tracks normalized names for RBAC lookups (flat list of all emitted names)
        const emittedToolNames = [];

        for (const t of tools) {
            const spec = JSON.parse(t.spec_json || '{}');
            const isMcp = spec.executor_type === 'mcp_endpoint' || spec.executor_type === 'mcp_hosted';

            if (isMcp) {
                // Resolve available_tools from multiple sources (priority order):
                //   1. tool_installations.config_json.available_tools (set by P1 probe — most current)
                //   2. spec_json.executor_config.available_tools (deploy-time snapshot)
                //   3. spec_json.available_tools (legacy location)
                let availableTools;
                try {
                    const instConfig = JSON.parse(t.install_config_json || '{}');
                    if (Array.isArray(instConfig.available_tools) && instConfig.available_tools.length > 0) {
                        availableTools = instConfig.available_tools;
                    }
                } catch (_) {}
                if (!Array.isArray(availableTools) || availableTools.length === 0) {
                    availableTools = spec.executor_config?.available_tools || spec.available_tools;
                }

                // LIFECYCLE-P1-D1: For deprecated entries, prefix the description with a warning
                // so the LLM knows the tool was removed from the upstream MCP server.
                // We still include them — in-flight LLM references need to surface cleanly.
                const availableToolsForUnfold = Array.isArray(availableTools)
                    ? availableTools.map(inner =>
                        inner.deprecated_at
                            ? { ...inner, description: prefixDeprecatedDescription(inner.description || '') }
                            : inner
                      )
                    : availableTools;

                const unfolded = unfoldAvailableTools(t.tool_id, t.description || '', availableToolsForUnfold);

                if (unfolded) {
                    // UNFOLD PATH — emit N discrete tool entries
                    if (unfolded.length > 40) {
                        console.warn(
                            '[INTROSPECT-P2] tool %s has %d available_tools; emitting %d + synthetic',
                            t.tool_id, availableTools.length, 40
                        );
                    }
                    for (const entry of unfolded) {
                        toolDescriptors.push({
                            name: entry.name,
                            description: entry.description,
                            input_schema: entry.input_schema,
                            provider: t.provider || spec.provider || null,
                            source: 'db',
                            // Dispatcher metadata — tells collector how to route this call
                            _canonical_id: entry._canonical_id,
                            _inner_name: entry._inner_name,
                            _executor_type: spec.executor_type,
                            _synthetic: entry._synthetic || false,
                            // LIFECYCLE-P4-D1: pass trust_tier through so dispatch layer can read it
                            _trust_tier: t.trust_tier || 'community',
                            // #556: per-agent access_mode from agent_tool_assignments
                            // ('full' | 'read_only' | 'with_approval')
                            access_mode: t.access_mode || 'full',
                        });
                        emittedToolNames.push(entry.name);
                    }
                } else {
                    // FALLBACK PATH — wrapper schema (legacy MCP or probe not yet run)
                    const shortName = t.tool_id.split('.').pop() || t.tool_id;
                    const baseDescription = t.description || spec.description || `MCP server: ${shortName}`;
                    const description = [
                        baseDescription,
                        'Invoke by passing tool_name and arguments. Common MCP tool name patterns: list_*, get_*, query, search, create_*, update_*, delete_*.',
                        'Try a name that fits this server\'s domain (postgres, github, slack, etc.). The wrapper will return the MCP\'s error if the tool name is invalid, so retry with a different name based on the error.',
                    ].join(' ');

                    const emittedName = t.tool_id.replace(/\./g, '_');
                    toolDescriptors.push({
                        name: emittedName,
                        description,
                        input_schema: MCP_WRAPPER_INPUT_SCHEMA,
                        provider: t.provider || spec.provider || null,
                        source: 'db',
                        _canonical_id: t.tool_id,
                        _inner_name: null, // legacy wrapper — inner_name comes from LLM input.tool_name
                        _executor_type: spec.executor_type,
                        // LIFECYCLE-P4-D1
                        _trust_tier: t.trust_tier || 'community',
                        // #556: per-agent access_mode from agent_tool_assignments
                        access_mode: t.access_mode || 'full',
                    });
                    emittedToolNames.push(emittedName);
                }
            } else {
                // Non-MCP tool — use spec.input_schema directly
                const input_schema = spec.input_schema || { type: 'object', properties: {}, required: [] };
                const emittedName = t.tool_id.replace(/\./g, '_');
                toolDescriptors.push({
                    name: emittedName,
                    description: t.description || spec.description || '',
                    input_schema,
                    provider: t.provider || spec.provider || null,
                    source: 'db',
                    // LIFECYCLE-P4-D1
                    _trust_tier: t.trust_tier || 'community',
                    // #556: per-agent access_mode from agent_tool_assignments
                    access_mode: t.access_mode || 'full',
                });
                emittedToolNames.push(emittedName);
            }
        }

        // toolNames: for RBAC checks (all emitted names the agent is authorized for)
        const toolNames = emittedToolNames;

        res.json({ agentId, toolNames, toolDescriptors });
    } catch (error) {
        console.error(`[Internal] Error fetching tools for agent ${req.params.agentId}:`, error.message);
        res.status(500).json({ error: 'Failed to fetch agent tools' });
    }
});

/**
 * GET /internal/agents/:agentId/prompt
 * Returns agent metadata and system prompt for building the LLM system prompt.
 */
internalRouter.get('/agents/:agentId/prompt', (req, res) => {
    try {
        const db = getDb();
        const { agentId } = req.params;

        const agent = findInternalAgentRow(db, `agent_id, name, description, system_prompt_additions,
                   domains_json, capabilities_json, level, icon, config_json`, agentId, internalCallerOrg(req));

        if (!agent) {
            return res.status(404).json({ error: `Agent '${agentId}' not found` });
        }

        const config = JSON.parse(agent.config_json || '{}');
        res.json({
            agentId: agent.agent_id,
            name: agent.name,
            description: agent.description || '',
            system_prompt_additions: agent.system_prompt_additions || '',
            domains: JSON.parse(agent.domains_json || '[]'),
            capabilities: JSON.parse(agent.capabilities_json || '[]'),
            level: agent.level,
            icon: agent.icon,
            llm: config.llm || null
        });
    } catch (error) {
        console.error(`[Internal] Error fetching prompt for agent ${req.params.agentId}:`, error.message);
        res.status(500).json({ error: 'Failed to fetch agent prompt' });
    }
});

/**
 * GET /internal/assistants
 * M-ROOMS: all active assistants (id, slug, name, org), INCLUDING the ~100+
 * scope assistants that have no agents-table row. The Matrix appservice
 * merges these into its persona map so a "Start chat" with any assistant
 * puppet (@_quoxagent_a_<id>) auto-joins and responds; reading only
 * /internal/agents left every agents-row-less assistant as a dead room.
 */
internalRouter.get('/assistants', (req, res) => {
    try {
        const db = getDb();
        const rows = db.prepare(`
            SELECT id, org_id, name, slug, description
            FROM assistants
            WHERE status = 'active'
            ORDER BY name
        `).all();
        res.json({
            assistants: rows.map((a) => ({
                id: a.id,
                agentId: a.id,
                org_id: a.org_id,
                name: a.name,
                slug: a.slug,
                description: a.description || '',
            })),
        });
    } catch (error) {
        console.error('[Internal] Error fetching assistants:', error.message);
        res.status(500).json({ error: 'Failed to fetch assistants' });
    }
});

/**
 * GET /internal/agents
 * Returns all active custom agents with their domains/capabilities.
 * Used by the collector delegator to score custom agents for delegation.
 */
internalRouter.get('/agents', (req, res) => {
    try {
        const db = getDb();

        // OPGOV inventory (quox#573): optional org scoping so the collector
        // can enumerate ONE org's agents instead of the whole table. Without
        // the param the pre-existing all-orgs behaviour is unchanged (the
        // delegator depends on it).
        const orgFilter = typeof req.query.org_id === 'string' && req.query.org_id !== '' ? req.query.org_id : null;
        // QUOXON-PROOF #843: include_inactive=1 returns the set `quox agent list` shows (every
        // status except 'retired', as GET /orgs/:orgId/agents does), for ONE org only.
        const includeInactive = ['1', 'true'].includes(String(req.query.include_inactive || '').toLowerCase());
        if (includeInactive && !orgFilter) {
            return res.status(400).json({ error: 'include_inactive requires org_id' });
        }
        const statusSql = includeInactive ? "status != 'retired'" : "status = 'active'";
        const agents = db.prepare(`
            SELECT agent_id, org_id, name, description, domains_json, capabilities_json, level, config_json, status
            FROM agents
            WHERE ${statusSql}${orgFilter ? ' AND org_id = ?' : ''}
            ORDER BY level, name
        `).all(...(orgFilter ? [orgFilter] : []));

        const result = agents.map(a => {
            const config = JSON.parse(a.config_json || '{}');
            return {
                agentId: a.agent_id,
                org_id: a.org_id || null,
                name: a.name,
                description: a.description || '',
                domains: JSON.parse(a.domains_json || '[]'),
                capabilities: JSON.parse(a.capabilities_json || '[]'),
                level: a.level,
                status: a.status,
                llm: config.llm || null,
                // BLAST-RADIUS-P0: expose the delegation graph so the
                // collector's reach resolver can walk canDelegateTo without
                // re-reading the static agentRegistry.js.
                delegation: config.delegation || { canDelegateTo: [] },
            };
        });

        res.json({ agents: result });
    } catch (error) {
        console.error('[Internal] Error fetching agents:', error.message);
        res.status(500).json({ error: 'Failed to fetch agents' });
    }
});

export default router;
export { internalRouter };
