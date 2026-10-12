/**
 * Internal Matrix Provisioning, M-ROOMS: service-key gated endpoint for
 * provisioning/deprovisioning org-tree node rooms (currently the primary
 * caller is the tasks service, requesting agentic_team rooms for a team it
 * just created, since auth cannot read the tasks service's team_definitions
 * manifest directly, per resolveTeamRoster's doc comment in matrixProvisioner.js).
 *
 * Uses service-key auth (no JWT required), same pattern as
 * routes/teamAssistants.js.
 */

import { Router } from 'express';
import { safeCompare } from '../utils/crypto.js';
import {
    provisionRoomForNode,
    deprovisionRoomForNode,
    migrateRoomsToOrgIdentities,
    perOrgIdentityEnabled,
    PROVISIONABLE_NODE_TYPES,
} from '../lib/matrixProvisioner.js';

const router = Router();

/**
 * Internal service key auth middleware.
 * When INTERNAL_SERVICE_KEY is not set, fails closed (denies request).
 */
function requireInternalAuth(req, res, next) {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured, denying request');
        return res.status(401).json({ error: 'Service key not configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
    return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

router.use(requireInternalAuth);

function isNonEmptyString(v) {
    return typeof v === 'string' && v.length > 0;
}

/**
 * POST /api/internal/matrix/provision-node
 *
 * Provisions (or adopts) the default room for one org-tree node. See
 * provisionRoomForNode in lib/matrixProvisioner.js for the full contract.
 */
router.post('/matrix/provision-node', async (req, res) => {
    try {
        const { org_id, node_type, node_id, label, roster, actor_id } = req.body || {};

        if (!org_id || !node_type || !node_id) {
            return res.status(400).json({ error: 'Missing required fields: org_id, node_type, node_id' });
        }
        if (!PROVISIONABLE_NODE_TYPES.includes(node_type)) {
            return res.status(400).json({ error: `Unsupported node_type: ${node_type}` });
        }
        if (roster !== undefined) {
            if (!roster || !isNonEmptyString(roster.orchestratorAgentId)) {
                return res.status(400).json({ error: 'roster.orchestratorAgentId must be a non-empty string' });
            }
            if (!Array.isArray(roster.memberAgentIds) || !roster.memberAgentIds.every(isNonEmptyString)) {
                return res.status(400).json({ error: 'roster.memberAgentIds must be an array of strings' });
            }
        }

        const result = await provisionRoomForNode({
            orgId: org_id,
            nodeType: node_type,
            nodeId: node_id,
            actorId: actor_id,
            label,
            roster,
        });
        res.json(result);
    } catch (error) {
        console.error('[InternalMatrixProvision] provision-node error:', error.message);
        res.status(500).json({ error: 'Failed to provision room' });
    }
});

/**
 * POST /api/internal/matrix/deprovision-node
 *
 * Retires the room for one org-tree node. See deprovisionRoomForNode in
 * lib/matrixProvisioner.js for the full contract.
 */
router.post('/matrix/deprovision-node', async (req, res) => {
    try {
        const { org_id, node_type, node_id, actor_id } = req.body || {};

        if (!org_id || !node_type || !node_id) {
            return res.status(400).json({ error: 'Missing required fields: org_id, node_type, node_id' });
        }
        if (!PROVISIONABLE_NODE_TYPES.includes(node_type)) {
            return res.status(400).json({ error: `Unsupported node_type: ${node_type}` });
        }

        const result = await deprovisionRoomForNode({
            orgId: org_id,
            nodeType: node_type,
            nodeId: node_id,
            actorId: actor_id,
        });
        res.json(result);
    } catch (error) {
        console.error('[InternalMatrixProvision] deprovision-node error:', error.message);
        res.status(500).json({ error: 'Failed to deprovision room' });
    }
});

/**
 * POST /api/internal/matrix/migrate-org-identities
 *
 * M-ISO #209 one-shot migration: move every active room's human membership
 * from legacy shared identities to per-org identities. Body: { org_id? } to
 * restrict to one org. Gated on the MATRIX_PER_ORG_IDENTITY flag: running
 * it while the flag is off would kick the identities everyone is actively
 * logged in with, so that case is a 409. See migrateRoomsToOrgIdentities in
 * lib/matrixProvisioner.js for the per-room contract (sequential,
 * fail-soft, safe to re-run).
 */
router.post('/matrix/migrate-org-identities', async (req, res) => {
    try {
        if (!perOrgIdentityEnabled()) {
            return res.status(409).json({
                error: 'per_org_identity_disabled',
                message: 'MATRIX_PER_ORG_IDENTITY is off: migrating now would kick every active legacy identity. Enable the flag first.',
            });
        }

        const { org_id } = req.body || {};
        if (org_id !== undefined && (typeof org_id !== 'string' || org_id.length === 0)) {
            return res.status(400).json({ error: 'org_id must be a non-empty string when provided' });
        }

        const result = await migrateRoomsToOrgIdentities({ orgId: org_id });
        res.json(result);
    } catch (error) {
        console.error('[InternalMatrixProvision] migrate-org-identities error:', error.message);
        res.status(500).json({ error: 'Failed to migrate org identities' });
    }
});

export default router;
