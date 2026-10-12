/**
 * Team Assistants — Internal-only route for auto-creating team orchestrator assistants + agents.
 *
 * Called from the task service when a custom team is created (POST /api/teams/create).
 * Uses service-key auth (no JWT required).
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { ulid } from '../utils/helpers.js';
import { safeCompare } from '../utils/crypto.js';
import { generateTeamAssistantPersona } from '../utils/scopeAssistantTemplates.js';

const router = Router();

/**
 * Internal service key auth middleware.
 * When INTERNAL_SERVICE_KEY is not set, fails closed (denies request).
 */
function requireInternalAuth(req, res, next) {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying request');
        return res.status(401).json({ error: 'Service key not configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
    return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

router.use(requireInternalAuth);

/**
 * POST /api/internal/teams/:teamId/assistant
 *
 * Creates an assistant and agent DB row for a team orchestrator.
 * Idempotent — skips creation if agent_id already exists.
 */
router.post('/teams/:teamId/assistant', (req, res) => {
    try {
        const db = getDb();
        const { teamId } = req.params;
        const { org_id, user_id, teamName, orchestratorId, members, description } = req.body;

        if (!org_id || !teamName || !orchestratorId) {
            return res.status(400).json({ error: 'Missing required fields: org_id, teamName, orchestratorId' });
        }

        const agentId = `team-${teamId}`;

        // Check idempotency — skip if agent already exists
        const existingAgent = db.prepare(
            "SELECT id FROM agents WHERE agent_id = ? AND org_id = ? AND status = 'active'"
        ).get(agentId, org_id);

        if (existingAgent) {
            return res.json({ action: 'exists', agent_id: agentId });
        }

        // Generate persona
        const persona = generateTeamAssistantPersona(teamName, orchestratorId, members, description);

        // Create assistant row
        const assistantId = ulid();
        const slug = `team-${teamId}`;
        db.prepare(`
            INSERT INTO assistants (id, org_id, name, slug, description, persona_json, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            assistantId,
            org_id,
            `${teamName} Orchestrator`,
            slug,
            `Auto-created orchestrator assistant for the ${teamName} team`,
            JSON.stringify(persona),
            user_id || 'system'
        );

        // Build domains from all team members
        const allDomains = [...new Set((members || []).flatMap(m => m.domains || []))];

        // Create agent row
        const agentDbId = ulid();
        db.prepare(`
            INSERT INTO agents (id, org_id, agent_id, name, description, level, status,
                               domains_json, capabilities_json, icon, created_by)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
        `).run(
            agentDbId,
            org_id,
            agentId,
            `${teamName} Orchestrator`,
            `Team orchestrator for ${teamName}. Coordinates: ${(members || []).map(m => m.agentId).join(', ')}`,
            1, // Level 1 = Manager
            JSON.stringify(allDomains),
            JSON.stringify(['team-orchestration', 'task-delegation', 'objective-decomposition']),
            'cpu',
            user_id || 'system'
        );

        console.log(`[TeamAssistants] Created assistant ${assistantId} + agent ${agentId} for team ${teamId}`);

        res.status(201).json({
            action: 'created',
            assistant_id: assistantId,
            agent_db_id: agentDbId,
            agent_id: agentId,
        });
    } catch (error) {
        console.error('[TeamAssistants] Error:', error.message);
        res.status(500).json({ error: 'Failed to create team assistant' });
    }
});

export default router;
