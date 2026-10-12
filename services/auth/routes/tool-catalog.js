/**
 * Tool Catalog Routes for Quox Auth Service
 * Phase B.2: Tool Library with Agent-Centric Access
 *
 * Architecture:
 * - Tools are installed at org level (tool_installations)
 * - Tools are assigned to AGENTS, not users (agent_tool_assignments)
 * - Assistants delegate to agents with specific toolsets
 * - No agent should have access to ALL tools
 *
 * Routes:
 * - /catalog/* - Global tool catalog (browse, search)
 * - /orgs/:orgId/tool-library/* - Org installations and config
 * - /orgs/:orgId/agents/:agentDbId/context - Agent tool context (unique to this file)
 *
 * NOTE: Agent CRUD routes are in routes/agents.js (authoritative source).
 * Agent tool assignment routes are also in routes/agents.js.
 */

import { Router } from 'express';
import { getDb, prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership, requireOrgRole } from '../middleware/org.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { createAuditEvent, ulid, getPagination, formatPaginatedResponse } from '../utils/helpers.js';
import { resolveEffectivePlan, meetsPlan } from '../utils/planTiers.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// ============================================================================
// TOOL CATALOG (Global - Browse Available Tools)
// ============================================================================

/**
 * GET /catalog
 * Browse the global tool catalog
 */
router.get('/catalog', async (req, res) => {
    try {
        const { category, subcategory, risk_level, sandbox_profile, search, status, featured } = req.query;
        const pagination = getPagination(req.query);

        let whereClause = 'WHERE 1=1';
        const params = [];

        // Default to available tools
        if (status) {
            whereClause += ' AND td.status = ?';
            params.push(status);
        } else {
            whereClause += ' AND td.status IN (?, ?)';
            params.push('available', 'beta');
        }

        if (category) {
            whereClause += ' AND td.category = ?';
            params.push(category);
        }

        if (subcategory) {
            whereClause += ' AND td.subcategory = ?';
            params.push(subcategory);
        }

        if (risk_level) {
            whereClause += ' AND td.risk_level = ?';
            params.push(risk_level);
        }

        if (sandbox_profile) {
            whereClause += ' AND td.sandbox_profile = ?';
            params.push(sandbox_profile);
        }

        if (featured === 'true') {
            whereClause += ' AND td.is_featured = 1';
        }

        if (search) {
            whereClause += ' AND (td.name LIKE ? OR td.description LIKE ? OR td.tool_id LIKE ?)';
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        // Get total count
        const countResult = prepare(`SELECT COUNT(*) as count FROM tool_definitions td ${whereClause}`).get(...params);
        const total = countResult?.count || 0;

        // Get tools
        const tools = prepare(`
            SELECT
                td.id, td.tool_id, td.name, td.description,
                td.category, td.subcategory, td.provider, td.version,
                td.risk_level, td.sandbox_profile,
                td.min_access_level, td.requires_license, td.requires_config,
                td.status, td.is_core, td.is_featured,
                td.icon, td.documentation_url,
                td.trust_tier,
                td.created_at, td.updated_at
            FROM tool_definitions td
            ${whereClause}
            ORDER BY td.is_featured DESC, td.is_core DESC, td.name
            LIMIT ? OFFSET ?
        `).all(...params, pagination.limit, pagination.offset);

        res.json(formatPaginatedResponse(tools, total, pagination));
    } catch (error) {
        console.error('Error listing catalog:', error);
        res.status(500).json({ error: 'Failed to list tool catalog' });
    }
});

/**
 * GET /catalog/categories
 * List all categories with counts.
 * Optional ?org_id=X — returns global (NULL) + org-scoped rows.
 */
router.get('/catalog/categories', async (req, res) => {
    try {
        const { org_id } = req.query;
        let categories;
        if (org_id) {
            categories = prepare(`
                SELECT
                    tc.id, tc.name, tc.description, tc.icon, tc.sort_order,
                    tc.org_id,
                    COUNT(td.id) as tool_count
                FROM tool_categories tc
                LEFT JOIN tool_definitions td ON td.category = tc.id
                    AND td.status IN ('available', 'beta')
                WHERE tc.org_id IS NULL OR tc.org_id = ?
                GROUP BY tc.id
                ORDER BY tc.org_id IS NOT NULL, tc.sort_order
            `).all(org_id);
        } else {
            categories = prepare(`
                SELECT
                    tc.id, tc.name, tc.description, tc.icon, tc.sort_order,
                    tc.org_id,
                    COUNT(td.id) as tool_count
                FROM tool_categories tc
                LEFT JOIN tool_definitions td ON td.category = tc.id
                    AND td.status IN ('available', 'beta')
                WHERE tc.org_id IS NULL
                GROUP BY tc.id
                ORDER BY tc.sort_order
            `).all();
        }

        res.json({ categories });
    } catch (error) {
        console.error('Error listing categories:', error);
        res.status(500).json({ error: 'Failed to list categories' });
    }
});

/**
 * POST /catalog/categories
 * Create an org-scoped category ("create new on the fly" flow).
 * Body: { name, icon?, description? }
 */
router.post('/catalog/categories', async (req, res) => {
    try {
        const { name, icon, description } = req.body || {};
        if (!name || typeof name !== 'string' || name.trim().length < 2) {
            return res.status(400).json({ error: 'invalid_name', message: 'Name must be at least 2 characters' });
        }
        const orgId = req.user?.org_id;
        if (!orgId) return res.status(401).json({ error: 'unauthorized' });

        // Generate slug-based ID with org suffix to avoid collisions
        const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
        const id = `${slug}_${orgId.slice(0, 8)}`;
        const sortOrder = 1000; // user-created sorts after seeded system categories

        prepare(`
            INSERT INTO tool_categories (id, name, description, icon, sort_order, org_id)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, name.trim(), description || null, icon || '🏷️', sortOrder, orgId);

        res.status(201).json({
            category: {
                id,
                name: name.trim(),
                icon: icon || '🏷️',
                description: description || null,
                sort_order: sortOrder,
                org_id: orgId,
            }
        });
    } catch (err) {
        if (err.message?.includes('UNIQUE')) {
            return res.status(409).json({ error: 'duplicate', message: 'Category already exists' });
        }
        console.error('Error creating category:', err);
        res.status(500).json({ error: 'Failed to create category' });
    }
});

/**
 * GET /catalog/:toolId
 * Get full tool definition with instructions.
 * LIFECYCLE-P4-D4: also returns available_tools from the first tool_installation
 * so the Quartermaster UI can show inner-tool listings.
 */
router.get('/catalog/:toolId', async (req, res) => {
    try {
        const { toolId } = req.params;

        const tool = prepare(`
            SELECT td.*
            FROM tool_definitions td
            WHERE td.tool_id = ? OR td.id = ?
        `).get(toolId, toolId);

        if (!tool) {
            return res.status(404).json({ error: 'Tool not found in catalog' });
        }

        // Parse JSON fields
        const spec = JSON.parse(tool.spec_json || '{}');
        const capabilities = JSON.parse(tool.capabilities_json || '[]');

        // LIFECYCLE-P4-D4: pull available_tools from tool_installations.config_json
        // (first installation row — most recently updated takes priority).
        // Falls back to spec_json.executor_config.available_tools (deploy-time snapshot).
        let availableTools = null;
        try {
            const instRow = prepare(`
                SELECT config_json FROM tool_installations
                WHERE tool_definition_id = ?
                ORDER BY updated_at DESC
                LIMIT 1
            `).get(tool.id);
            if (instRow) {
                const instCfg = JSON.parse(instRow.config_json || '{}');
                if (Array.isArray(instCfg.available_tools) && instCfg.available_tools.length > 0) {
                    availableTools = instCfg.available_tools;
                }
            }
            if (!availableTools) {
                const fallback = spec.executor_config?.available_tools || spec.available_tools;
                if (Array.isArray(fallback) && fallback.length > 0) {
                    availableTools = fallback;
                }
            }
        } catch (_) {
            // Non-fatal — available_tools is supplementary display data
        }

        res.json({
            tool: {
                ...tool,
                spec,
                capabilities,
                available_tools: availableTools || [],
                spec_json: undefined,
                capabilities_json: undefined
            }
        });
    } catch (error) {
        console.error('Error getting tool:', error);
        res.status(500).json({ error: 'Failed to get tool' });
    }
});

// ============================================================================
// TOOL INSTALLATIONS (Per-Org - Makes Tools Available)
// ============================================================================

/**
 * GET /orgs/:orgId/tool-library
 * List installed tools in an org
 */
router.get('/orgs/:orgId/tool-library', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { enabled, category } = req.query;
        const pagination = getPagination(req.query);

        let whereClause = 'WHERE ti.org_id = ?';
        const params = [orgId];

        if (enabled !== undefined) {
            whereClause += ' AND ti.enabled = ?';
            params.push(enabled === 'true' ? 1 : 0);
        }

        if (category) {
            whereClause += ' AND td.category = ?';
            params.push(category);
        }

        const countResult = prepare(`
            SELECT COUNT(*) as count
            FROM tool_installations ti
            JOIN tool_definitions td ON ti.tool_definition_id = td.id
            ${whereClause}
        `).get(...params);
        const total = countResult?.count || 0;

        const installations = prepare(`
            SELECT
                ti.id, ti.org_id, ti.tool_definition_id,
                ti.config_json, ti.enabled, ti.pinned_version,
                ti.installed_by, ti.installed_at, ti.updated_at,
                td.tool_id, td.name, td.description, td.category, td.subcategory,
                td.provider, td.version as catalog_version,
                td.risk_level, td.sandbox_profile, td.icon,
                u.display_name as installed_by_name,
                (SELECT COUNT(*) FROM agent_tool_assignments ata
                 WHERE ata.tool_installation_id = ti.id AND ata.enabled = 1 AND ata.revoked_at IS NULL
                ) as assigned_agent_count
            FROM tool_installations ti
            JOIN tool_definitions td ON ti.tool_definition_id = td.id
            LEFT JOIN users u ON ti.installed_by = u.id
            ${whereClause}
            ORDER BY td.name
            LIMIT ? OFFSET ?
        `).all(...params, pagination.limit, pagination.offset);

        // Parse config JSON
        for (const inst of installations) {
            inst.config = JSON.parse(inst.config_json || '{}');
            delete inst.config_json;
        }

        res.json(formatPaginatedResponse(installations, total, pagination));
    } catch (error) {
        console.error('Error listing tool library:', error);
        res.status(500).json({ error: 'Failed to list tool library' });
    }
});

/**
 * POST /orgs/:orgId/tool-library
 * Install a tool from catalog into org
 */
router.post('/orgs/:orgId/tool-library', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { tool_definition_id, config } = req.body;
        const userId = req.user.id;

        // Check capability
        if (!resolveCap(req, Capabilities.DIRECTORY_CREATE_TOOL)) {
            return res.status(403).json({ error: 'Insufficient permissions to install tools' });
        }

        // Validate tool exists in catalog
        const toolDef = prepare('SELECT * FROM tool_definitions WHERE id = ?').get(tool_definition_id);
        if (!toolDef) {
            return res.status(404).json({ error: 'Tool not found in catalog' });
        }

        // Check not already installed
        const existing = prepare('SELECT id FROM tool_installations WHERE org_id = ? AND tool_definition_id = ?')
            .get(orgId, tool_definition_id);
        if (existing) {
            return res.status(409).json({ error: 'Tool already installed in this organization' });
        }

        // Check license if required — instance license (planTiers.js) is the
        // single source of truth for what an org/instance can do. Unknown or
        // missing tiers fail SAFE (meetsPlan returns false for unrecognized
        // tier names), so a malformed/legacy requires_license value blocks
        // install rather than silently allowing it.
        if (toolDef.requires_license) {
            const effective = resolveEffectivePlan(req.org, { db: getDb() });
            if (!meetsPlan(effective.plan, toolDef.requires_license)) {
                return res.status(403).json({
                    error: 'insufficient_license',
                    message: `This tool requires the '${toolDef.requires_license}' plan or higher (current: ${effective.plan}).`,
                    required_license: toolDef.requires_license,
                    current_plan: effective.plan
                });
            }
        }

        const id = ulid();

        prepare(`
            INSERT INTO tool_installations (id, org_id, tool_definition_id, config_json, enabled, installed_by)
            VALUES (?, ?, ?, ?, 1, ?)
        `).run(id, orgId, tool_definition_id, JSON.stringify(config || {}), userId);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'tool_library.install',
            targetType: 'tool_installation',
            targetId: id,
            metadata: { tool_id: toolDef.tool_id, tool_name: toolDef.name }
        });

        const installation = prepare(`
            SELECT ti.*, td.tool_id, td.name, td.description, td.category
            FROM tool_installations ti
            JOIN tool_definitions td ON ti.tool_definition_id = td.id
            WHERE ti.id = ?
        `).get(id);

        res.status(201).json({
            installation: {
                ...installation,
                config: JSON.parse(installation.config_json || '{}'),
                config_json: undefined
            },
            message: 'Tool installed. Assign it to agents to enable usage.'
        });
    } catch (error) {
        console.error('Error installing tool:', error);
        res.status(500).json({ error: 'Failed to install tool' });
    }
});

/**
 * PATCH /orgs/:orgId/tool-library/:installationId
 * Update tool installation (config, enabled status)
 */
router.patch('/orgs/:orgId/tool-library/:installationId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, installationId } = req.params;
        const { config, enabled, pinned_version } = req.body;
        const userId = req.user.id;

        // Check capability
        if (!resolveCap(req, Capabilities.DIRECTORY_CREATE_TOOL)) {
            return res.status(403).json({ error: 'Insufficient permissions to configure tools' });
        }

        const existing = prepare('SELECT * FROM tool_installations WHERE id = ? AND org_id = ?')
            .get(installationId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Tool installation not found' });
        }

        const updates = [];
        const values = [];

        if (config !== undefined) {
            updates.push('config_json = ?');
            values.push(JSON.stringify(config));
        }

        if (enabled !== undefined) {
            updates.push('enabled = ?');
            values.push(enabled ? 1 : 0);
            if (!enabled) {
                updates.push("disabled_at = datetime('now')");
                updates.push('disabled_by = ?');
                values.push(userId);
            }
        }

        if (pinned_version !== undefined) {
            updates.push('pinned_version = ?');
            values.push(pinned_version);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No updates provided' });
        }

        updates.push("updated_at = datetime('now')");
        values.push(installationId);

        prepare(`UPDATE tool_installations SET ${updates.join(', ')} WHERE id = ?`).run(...values);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'tool_library.update',
            targetType: 'tool_installation',
            targetId: installationId,
            metadata: { updated_fields: Object.keys(req.body) }
        });

        const installation = prepare('SELECT * FROM tool_installations WHERE id = ?').get(installationId);

        res.json({
            installation: {
                ...installation,
                config: JSON.parse(installation.config_json || '{}'),
                config_json: undefined
            }
        });
    } catch (error) {
        console.error('Error updating tool installation:', error);
        res.status(500).json({ error: 'Failed to update tool installation' });
    }
});

/**
 * DELETE /orgs/:orgId/tool-library/:installationId
 * Uninstall a tool from org
 */
router.delete('/orgs/:orgId/tool-library/:installationId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, installationId } = req.params;
        const userId = req.user.id;

        // Check capability
        if (!resolveCap(req, Capabilities.DIRECTORY_CREATE_TOOL)) {
            return res.status(403).json({ error: 'Insufficient permissions to uninstall tools' });
        }

        const existing = prepare(`
            SELECT ti.*, td.tool_id, td.name, td.is_core
            FROM tool_installations ti
            JOIN tool_definitions td ON ti.tool_definition_id = td.id
            WHERE ti.id = ? AND ti.org_id = ?
        `).get(installationId, orgId);

        if (!existing) {
            return res.status(404).json({ error: 'Tool installation not found' });
        }

        if (existing.is_core) {
            return res.status(400).json({ error: 'Core tools cannot be uninstalled' });
        }

        // Check for active assignments
        const activeAssignments = prepare(`
            SELECT COUNT(*) as count FROM agent_tool_assignments
            WHERE tool_installation_id = ? AND enabled = 1 AND revoked_at IS NULL
        `).get(installationId);

        if (activeAssignments.count > 0) {
            return res.status(400).json({
                error: 'Tool has active agent assignments. Remove assignments first.',
                active_assignments: activeAssignments.count
            });
        }

        const db = getDb();
        db.transaction(() => {
            // Delete any revoked assignments
            prepare('DELETE FROM agent_tool_assignments WHERE tool_installation_id = ?').run(installationId);
            // Delete installation
            prepare('DELETE FROM tool_installations WHERE id = ?').run(installationId);
        })();

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'tool_library.uninstall',
            targetType: 'tool_installation',
            targetId: installationId,
            metadata: { tool_id: existing.tool_id, tool_name: existing.name }
        });

        res.json({ success: true, message: 'Tool uninstalled' });
    } catch (error) {
        console.error('Error uninstalling tool:', error);
        res.status(500).json({ error: 'Failed to uninstall tool' });
    }
});

// ============================================================================
// AGENT TOOL CONTEXT (For Prompt Injection) — unique to this file
// Agent CRUD and tool assignment routes are in routes/agents.js
// ============================================================================

/**
 * GET /orgs/:orgId/agents/:agentDbId/context
 * Get pre-computed tool context for an agent (for prompt injection)
 */
router.get('/orgs/:orgId/agents/:agentDbId/context', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, agentDbId } = req.params;
        const { regenerate } = req.query;

        const agent = prepare('SELECT * FROM agents WHERE id = ? AND org_id = ?').get(agentDbId, orgId);
        if (!agent) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        // Check for cached context
        let context = prepare('SELECT * FROM agent_tool_context WHERE agent_db_id = ?').get(agentDbId);

        // Regenerate if stale or requested
        if (!context || context.stale || regenerate === 'true') {
            context = await regenerateAgentContext(orgId, agentDbId, agent.agent_id);
        }

        res.json({
            agent_id: agent.agent_id,
            agent_name: agent.name,
            tools_count: context.tools_count,
            context_tokens: context.context_tokens,
            tools: JSON.parse(context.tools_summary_json || '[]'),
            computed_at: context.computed_at
        });
    } catch (error) {
        console.error('Error getting agent context:', error);
        res.status(500).json({ error: 'Failed to get agent context' });
    }
});

/**
 * Helper: Regenerate agent tool context
 */
async function regenerateAgentContext(orgId, agentDbId, agentId) {
    // Get all enabled tool assignments
    const tools = prepare(`
        SELECT
            td.tool_id, td.name, td.description, td.risk_level, td.sandbox_profile,
            td.spec_json,
            ata.access_mode
        FROM agent_tool_assignments ata
        JOIN tool_installations ti ON ata.tool_installation_id = ti.id
        JOIN tool_definitions td ON ti.tool_definition_id = td.id
        WHERE ata.agent_id = ? AND ata.org_id = ?
        AND ata.enabled = 1 AND ata.revoked_at IS NULL
        AND ti.enabled = 1
        ORDER BY td.name
    `).all(agentId, orgId);

    // Build compact summary
    const toolsSummary = tools.map(t => {
        const spec = JSON.parse(t.spec_json || '{}');
        return {
            id: t.tool_id,
            name: t.name,
            summary: spec.instructions?.summary || t.description,
            when_to_use: spec.instructions?.when_to_use || [],
            risk: t.risk_level,
            access_mode: t.access_mode
        };
    });

    // Estimate tokens (rough: ~50 tokens per tool summary)
    const contextTokens = toolsSummary.length * 50;

    const agent = prepare('SELECT name FROM agents WHERE id = ?').get(agentDbId);

    // Upsert context
    const existingContext = prepare('SELECT id FROM agent_tool_context WHERE agent_db_id = ?').get(agentDbId);

    if (existingContext) {
        prepare(`
            UPDATE agent_tool_context SET
                agent_id = ?, agent_name = ?,
                tools_count = ?, context_tokens = ?,
                tools_summary_json = ?,
                computed_at = datetime('now'), stale = 0
            WHERE agent_db_id = ?
        `).run(
            agentId, agent?.name,
            toolsSummary.length, contextTokens,
            JSON.stringify(toolsSummary),
            agentDbId
        );
    } else {
        prepare(`
            INSERT INTO agent_tool_context (
                id, org_id, agent_db_id, agent_id, agent_name,
                tools_count, context_tokens, tools_summary_json,
                computed_at, stale
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 0)
        `).run(
            ulid(), orgId, agentDbId, agentId, agent?.name,
            toolsSummary.length, contextTokens,
            JSON.stringify(toolsSummary)
        );
    }

    return prepare('SELECT * FROM agent_tool_context WHERE agent_db_id = ?').get(agentDbId);
}

export default router;
