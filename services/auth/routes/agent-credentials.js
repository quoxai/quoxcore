/**
 * Agent Credential Assignment Routes — Phase 14
 *
 * Extracted from integrations.js — agent credential assignments
 * are an agent-system concern, not a vault concern.
 *
 * GET    /orgs/:orgId/agent-credential-assignments
 * POST   /orgs/:orgId/agent-credential-assignments
 * DELETE /orgs/:orgId/agent-credential-assignments/:id
 *
 * Legacy aliases (backward compatibility):
 * GET    /orgs/:orgId/integrations/agent-assignments
 * POST   /orgs/:orgId/integrations/agent-assignments
 * DELETE /orgs/:orgId/integrations/agent-assignments/:id
 */

import { Router } from 'express';
import { authenticate, requireOrg } from '../middleware/authenticate.js';
import { requireCapability, requireOrgScope } from '../middleware/authorize.js';
import { Capabilities } from '../utils/policy.js';
import { logIntegrationEvent, AuditActions } from '../utils/audit.js';
import { safeCompare } from '../utils/crypto.js';
import { getDb } from '../db/index.js';
import {
    getAgentAssignments,
    assignCredentialToAgent,
    removeAgentAssignment,
    getCredentialById
} from '../db/integrations.js';
import { humanGrantorOnly } from '../utils/principal.js';
import { clearCache as clearResolverCache } from '../services/credentialResolver.js';

const router = Router();

/**
 * List agent credential assignments
 */
function listAssignments(req, res) {
    try {
        const { agent_id, tool_type } = req.query;
        const assignments = getAgentAssignments(req.params.orgId, agent_id, tool_type);
        res.json({ assignments });
    } catch (err) {
        console.error('Failed to list agent assignments:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to list agent assignments' });
    }
}

/**
 * Assign a credential to an agent for a tool type
 */
function createAssignment(req, res) {
    try {
        const { agent_id, credential_id, tool_type, priority } = req.body;

        if (!agent_id || !credential_id || !tool_type) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'agent_id, credential_id, and tool_type are required'
            });
        }

        // Verify credential exists and belongs to this org
        const cred = getCredentialById(credential_id);
        if (!cred || cred.org_id !== req.params.orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Credential not found' });
        }

        const assignment = assignCredentialToAgent({
            org_id: req.params.orgId,
            agent_id,
            credential_id,
            tool_type,
            priority: priority || 0,
            created_by: req.user.id
        });

        logIntegrationEvent(
            AuditActions.INTEGRATION_UPDATE,
            { type: 'user', id: req.user.id },
            req.params.orgId,
            credential_id,
            req,
            { action: 'agent_assign', agent_id, tool_type }
        );
        // A new assignment must be visible to resolve-for-agent now, not after the 30s cache TTL.
        clearResolverCache();

        res.status(201).json(assignment);
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'conflict', message: 'This assignment already exists' });
        }
        console.error('Failed to create agent assignment:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to create agent assignment' });
    }
}

/**
 * Remove an agent credential assignment
 */
function deleteAssignment(req, res) {
    try {
        // Verify assignment belongs to this org before deleting
        const assignments = getAgentAssignments(req.params.orgId);
        const assignment = assignments.find(a => a.id === req.params.id);
        if (!assignment) {
            return res.status(404).json({ error: 'not_found', message: 'Assignment not found' });
        }

        const deleted = removeAgentAssignment(req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: 'not_found', message: 'Assignment not found' });
        }
        clearResolverCache();
        res.json({ deleted: true });
    } catch (err) {
        console.error('Failed to delete agent assignment:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to delete agent assignment' });
    }
}

// New routes
router.get('/orgs/:orgId/agent-credential-assignments', authenticate(), requireOrg(), requireOrgScope(), listAssignments);
router.post('/orgs/:orgId/agent-credential-assignments', authenticate(), requireOrg(), requireOrgScope(), requireCapability(Capabilities.SECRETS_WRITE), humanGrantorOnly, createAssignment);
router.delete('/orgs/:orgId/agent-credential-assignments/:id', authenticate(), requireOrg(), requireOrgScope(), requireCapability(Capabilities.SECRETS_WRITE), deleteAssignment);

// Legacy aliases (backward compatibility)
router.get('/orgs/:orgId/integrations/agent-assignments', authenticate(), requireOrg(), requireOrgScope(), listAssignments);
router.post('/orgs/:orgId/integrations/agent-assignments', authenticate(), requireOrg(), requireOrgScope(), requireCapability(Capabilities.SECRETS_WRITE), humanGrantorOnly, createAssignment);
router.delete('/orgs/:orgId/integrations/agent-assignments/:id', authenticate(), requireOrg(), requireOrgScope(), requireCapability(Capabilities.SECRETS_WRITE), deleteAssignment);

// ============================================================================
// Internal (service-to-service) passthrough — BLAST-RADIUS-P0
// ============================================================================
// GET /orgs/:orgId/agent-credential-assignments above is user-JWT gated
// (authenticate() + requireOrgScope()), which a server-side caller like the
// collector's reach resolver cannot present. Same pattern as agents.js's
// internalRouter: X-Service-Key auth, mounted at /internal by server.js.

const internalRouter = Router();

function requireInternalAuth(req, res, next) {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
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
 * GET /internal/orgs/:orgId/agent-credential-assignments
 * Same projection as listAssignments (id, integration_type, label,
 * key_preview, test_status — never a secret value or ciphertext).
 */
internalRouter.get('/orgs/:orgId/agent-credential-assignments', listAssignments);

/**
 * GET /internal/orgs/:orgId/agents/:agentId/credential-usage?days=30
 * BLAST-RADIUS-P4 deliverable 2 — distinct-credential usage counts for an
 * agent, read from the SAME audit_events rows writeCredentialReleaseAudit()
 * (services/auth/lib/credentialReleaseAudit.js) writes on every real
 * decrypt/release: actor_type='service', actor_id='agent:<agentId>'
 * (credentialResolver.js:566-569's callerService: `agent:${agentId}`),
 * action=AuditActions.SECRET_ACCESS ('secret.access'), target_type=
 * 'integration_credential', target_id=<credentialId>. Never returns a secret
 * value or ciphertext — a usage COUNT only.
 *
 * Honest limitation (surfaced by the reach least-privilege report as
 * `coverage: 'partial (30s resolver cache undercounts repeats)'`, not hidden
 * here): credentialResolver.js's resolveForAgent() caches a resolved
 * credential for 30s per (org, agent, toolType), so repeated logical uses
 * inside that window collapse into ONE audit row.
 */
function getCredentialUsage(req, res) {
    try {
        const { orgId, agentId } = req.params;
        const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
        const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const db = getDb();
        const rows = db.prepare(`
            SELECT target_id AS credential_id, COUNT(*) AS count, MAX(created_at) AS last_used
            FROM audit_events
            WHERE org_id = ?
              AND actor_type = 'service'
              AND actor_id = ?
              AND action = ?
              AND target_type = 'integration_credential'
              AND created_at >= ?
            GROUP BY target_id
            ORDER BY count DESC
        `).all(orgId, `agent:${agentId}`, AuditActions.SECRET_ACCESS, sinceIso);
        res.json({
            credentials: rows.map((r) => ({
                credential_id: r.credential_id,
                count: r.count,
                last_used: r.last_used,
            })),
        });
    } catch (err) {
        console.error(`[Internal] Failed to fetch credential usage for agent ${req.params.agentId}:`, err.message);
        res.status(500).json({ error: 'Failed to fetch credential usage' });
    }
}

internalRouter.get('/orgs/:orgId/agents/:agentId/credential-usage', getCredentialUsage);

export default router;
export { internalRouter };
