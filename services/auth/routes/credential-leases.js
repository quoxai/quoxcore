/**
 * Credential Lease Routes — JIT Agent Access
 *
 * POST   /orgs/:orgId/integrations/leases/request  — Agent requests a lease
 * GET    /orgs/:orgId/integrations/leases           — List leases
 * GET    /orgs/:orgId/integrations/leases/:id       — Get lease detail
 * POST   /orgs/:orgId/integrations/leases/:id/approve — Approve (with TTL)
 * POST   /orgs/:orgId/integrations/leases/:id/deny    — Deny
 * POST   /orgs/:orgId/integrations/leases/:id/revoke  — Revoke active lease
 */

import { Router } from 'express';
import { authenticate, requireOrg } from '../middleware/authenticate.js';
import { requireOrgScope, requireCapability } from '../middleware/authorize.js';
import { Capabilities } from '../utils/policy.js';
import { requireHumanDecider } from '../utils/principal.js';
import { logIntegrationEvent, AuditActions } from '../utils/audit.js';
import { clearCache as clearResolverCache } from '../services/credentialResolver.js';
import { prepare, transaction } from '../db/index.js';
import { ulid } from '../utils/helpers.js';
import { getLeaseEnforcementMode } from '../utils/leaseEnforcement.js';
import {
    createLease,
    getLeaseById,
    approveLease,
    setLeaseInboxItem,
    denyLease,
    revokeLease,
    listLeases,
    countPendingLeases,
    getCredentialById
} from '../db/integrations.js';

const router = Router();

/**
 * VAULT-P5.I (F4) — HITL inbox wiring for lease requests. Mirrors
 * routes/bastion-approvals.js's ensurePersonalInbox(): route to the
 * requester's own personal inbox for now (same "should be routed to admins
 * in production" caveat bastion-approvals.js carries — not fixed here,
 * out of this finding's scope).
 */
function ensurePersonalInbox(orgId, userId) {
    const existing = prepare(`
        SELECT id FROM inboxes
        WHERE org_id = ? AND owner_id = ? AND inbox_type = 'personal'
    `).get(orgId, userId);

    if (existing) return existing.id;

    const inboxId = ulid();
    prepare(`
        INSERT INTO inboxes (id, org_id, inbox_type, name, owner_id)
        VALUES (?, ?, 'personal', 'Personal Inbox', ?)
    `).run(inboxId, orgId, userId);

    return inboxId;
}

/**
 * Create the inbox_items approval row for a just-created lease and link it
 * back via setLeaseInboxItem — this is the fix for F4's stubbed
 * inbox_item_id (always null), which is why every pending lease used to
 * auto-cancel after 15 minutes (cancelStalePendingLeases() already excludes
 * `inbox_item_id IS NOT NULL` rows — it just never had any to exclude).
 * The payload's `type: 'credential_lease'` + `lease_id` is read back by
 * routes/inbox.js's generic /respond endpoint to grant/deny the lease when
 * the SAME inbox item is approved/denied from the general Inbox surface.
 */
function createLeaseInboxItem({ orgId, userId, lease, credential, agentId, justification }) {
    const targetInboxId = ensurePersonalInbox(orgId, userId);
    const inboxItemId = ulid();
    const title = `Credential Lease Request: ${credential.label || credential.integration_type}`;
    const body = `**Agent:** ${agentId}\n` +
        `**Credential:** ${credential.label || credential.integration_type} (${credential.integration_type})\n` +
        (justification ? `\n**Justification:**\n${justification}\n` : '');

    transaction(() => {
        prepare(`
            INSERT INTO inbox_items (
                id, org_id, inbox_id, kind, priority, title, body_md,
                payload_json, created_by
            ) VALUES (?, ?, ?, 'approval', 'high', ?, ?, ?, ?)
        `).run(
            inboxItemId, orgId, targetInboxId, title, body,
            JSON.stringify({ type: 'credential_lease', lease_id: lease.id, credential_id: credential.id, agent_id: agentId }),
            userId
        );

        prepare(`
            INSERT INTO inbox_item_assignees (id, inbox_item_id, assignee_type, assignee_id, mode)
            VALUES (?, ?, 'user', ?, 'anyone')
        `).run(ulid(), inboxItemId, userId);
    });

    setLeaseInboxItem(lease.id, inboxItemId);
    return inboxItemId;
}

/**
 * Resolve the inbox_item linked to a lease (bastion-approvals.js parity —
 * its approve/deny handlers also resolve the linked inbox_items row in the
 * same request instead of leaving the two out of sync).
 */
function resolveLeaseInboxItem(lease, { action, userId, comment }) {
    if (!lease?.inbox_item_id) return;
    try {
        prepare(`
            UPDATE inbox_items
            SET status = 'resolved', response_json = ?, resolved_by = ?, resolved_at = datetime('now')
            WHERE id = ? AND status != 'resolved'
        `).run(JSON.stringify({ action, comment: comment || null, responded_by: userId, responded_at: new Date().toISOString() }), userId, lease.inbox_item_id);
    } catch (err) {
        console.error('[Leases] Failed to resolve linked inbox item (non-fatal):', err.message);
    }
}

// Max pending lease requests per agent per hour
const MAX_PENDING_PER_HOUR = 5;

/**
 * POST /orgs/:orgId/integrations/leases/request
 * Agent requests a credential lease
 */
router.post('/orgs/:orgId/integrations/leases/request', authenticate(), requireOrg(), requireOrgScope(), (req, res) => {
    try {
        const { orgId } = req.params;
        const { credential_id, agent_id, task_id, justification, context } = req.body;

        if (!credential_id || !agent_id) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'credential_id and agent_id are required'
            });
        }

        // Verify credential exists and has lease_required
        const cred = getCredentialById(credential_id);
        if (!cred || cred.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Credential not found' });
        }

        // Rate limit: max pending per agent per hour
        const pendingCount = countPendingLeases(orgId, agent_id);
        if (pendingCount >= MAX_PENDING_PER_HOUR) {
            return res.status(429).json({
                error: 'rate_limited',
                message: `Agent ${agent_id} has too many pending lease requests (max ${MAX_PENDING_PER_HOUR}/hour)`
            });
        }

        // Sanitize justification (plaintext only, max 500 chars)
        const safeJustification = justification
            ? justification.replace(/<[^>]*>/g, '').slice(0, 500)
            : null;

        // Validate context size (max 10KB)
        const contextStr = context ? JSON.stringify(context) : '{}';
        if (contextStr.length > 10240) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Lease context must be 10KB or smaller'
            });
        }

        let lease = createLease({
            org_id: orgId,
            credential_id,
            requested_by_agent_id: agent_id,
            requested_by_task_id: task_id || null,
            justification: safeJustification,
            context_json: contextStr,
            max_uses: cred.lease_max_uses || null
        });

        // VAULT-P5.I (F4): create the HITL inbox approval item and link it
        // back onto the lease — without this, cancelStalePendingLeases()
        // auto-cancels every pending lease at 15 minutes because nothing
        // ever approves them.
        try {
            createLeaseInboxItem({
                orgId, userId: req.user.id, lease, credential: cred,
                agentId: agent_id, justification: safeJustification,
            });
            lease = getLeaseById(lease.id);
        } catch (err) {
            console.error('[Leases] Failed to create HITL inbox item (non-fatal — lease still created):', err.message);
        }

        logIntegrationEvent(
            AuditActions.INTEGRATION_ACCESS,
            { type: 'agent', id: agent_id },
            orgId,
            credential_id,
            req,
            { action: 'lease_request', lease_id: lease.id, inbox_item_id: lease.inbox_item_id || null }
        );

        res.status(201).json(lease);
    } catch (err) {
        console.error('Failed to create lease request:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to create lease request' });
    }
});

/**
 * GET /orgs/:orgId/integrations/leases
 * List leases with optional filters
 *
 * VAULT-P5.M — also returns the org's `enforcement_mode` (off | advisory |
 * enforced, see utils/leaseEnforcement.js) so the Leases UI can show a
 * banner reflecting what the backend is actually doing — never claim
 * enforcement the backend doesn't perform (no-governance-theater rule).
 */
router.get('/orgs/:orgId/integrations/leases', authenticate(), requireOrg(), requireOrgScope(), (req, res) => {
    try {
        const { status, agent_id, credential_id, limit } = req.query;
        const leases = listLeases(req.params.orgId, {
            status,
            agent_id,
            credential_id,
            limit: limit ? parseInt(limit, 10) : 50
        });
        res.json({ leases, enforcement_mode: getLeaseEnforcementMode(req.params.orgId) });
    } catch (err) {
        console.error('Failed to list leases:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to list leases' });
    }
});

/**
 * GET /orgs/:orgId/integrations/leases/:leaseId
 * Get lease details
 */
router.get('/orgs/:orgId/integrations/leases/:leaseId', authenticate(), requireOrg(), requireOrgScope(), (req, res) => {
    try {
        const lease = getLeaseById(req.params.leaseId);
        if (!lease || lease.org_id !== req.params.orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Lease not found' });
        }
        res.json(lease);
    } catch (err) {
        console.error('Failed to get lease:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to get lease' });
    }
});

/**
 * POST /orgs/:orgId/integrations/leases/:leaseId/approve
 * Approve a pending lease with a duration
 */
router.post('/orgs/:orgId/integrations/leases/:leaseId/approve', authenticate(), requireOrg(), requireOrgScope(), requireCapability(Capabilities.SECRETS_WRITE), (req, res) => {
    try {
        if (!requireHumanDecider(req, res)) return;
        const { duration_minutes } = req.body;

        if (!duration_minutes || duration_minutes < 1) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'duration_minutes must be at least 1'
            });
        }

        const lease = getLeaseById(req.params.leaseId);
        if (!lease || lease.org_id !== req.params.orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Lease not found' });
        }

        if (lease.status !== 'pending') {
            return res.status(400).json({
                error: 'invalid_state',
                message: `Cannot approve a lease with status '${lease.status}'`
            });
        }

        // Check against max duration
        const cred = getCredentialById(lease.credential_id);
        if (cred?.lease_max_duration_minutes && duration_minutes > cred.lease_max_duration_minutes) {
            return res.status(400).json({
                error: 'validation_error',
                message: `Duration exceeds maximum of ${cred.lease_max_duration_minutes} minutes`
            });
        }

        const approved = approveLease(req.params.leaseId, req.user.id, duration_minutes);

        // VAULT-P5.I: keep the linked HITL inbox item in sync (bastion-approvals.js parity).
        resolveLeaseInboxItem(lease, { action: 'approve', userId: req.user.id });

        logIntegrationEvent(
            AuditActions.INTEGRATION_ACCESS,
            { type: 'user', id: req.user.id },
            req.params.orgId,
            lease.credential_id,
            req,
            { action: 'lease_approve', lease_id: lease.id, duration_minutes }
        );

        res.json(approved);
    } catch (err) {
        console.error('Failed to approve lease:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to approve lease' });
    }
});

/**
 * POST /orgs/:orgId/integrations/leases/:leaseId/deny
 * Deny a pending lease
 */
router.post('/orgs/:orgId/integrations/leases/:leaseId/deny', authenticate(), requireOrg(), requireOrgScope(), requireCapability(Capabilities.SECRETS_WRITE), (req, res) => {
    try {
        if (!requireHumanDecider(req, res)) return;
        const lease = getLeaseById(req.params.leaseId);
        if (!lease || lease.org_id !== req.params.orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Lease not found' });
        }

        if (lease.status !== 'pending') {
            return res.status(400).json({
                error: 'invalid_state',
                message: `Cannot deny a lease with status '${lease.status}'`
            });
        }

        const denied = denyLease(req.params.leaseId, req.user.id);

        // VAULT-P5.I: keep the linked HITL inbox item in sync (bastion-approvals.js parity).
        resolveLeaseInboxItem(lease, { action: 'deny', userId: req.user.id });

        logIntegrationEvent(
            AuditActions.INTEGRATION_ACCESS,
            { type: 'user', id: req.user.id },
            req.params.orgId,
            lease.credential_id,
            req,
            { action: 'lease_deny', lease_id: lease.id }
        );

        res.json(denied);
    } catch (err) {
        console.error('Failed to deny lease:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to deny lease' });
    }
});

/**
 * POST /orgs/:orgId/integrations/leases/:leaseId/revoke
 * Revoke an active lease immediately
 */
router.post('/orgs/:orgId/integrations/leases/:leaseId/revoke', authenticate(), requireOrg(), requireOrgScope(), requireCapability(Capabilities.SECRETS_WRITE), (req, res) => {
    try {
        const lease = getLeaseById(req.params.leaseId);
        if (!lease || lease.org_id !== req.params.orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Lease not found' });
        }

        if (lease.status !== 'active') {
            return res.status(400).json({
                error: 'invalid_state',
                message: `Cannot revoke a lease with status '${lease.status}'`
            });
        }

        const revoked = revokeLease(req.params.leaseId);

        logIntegrationEvent(
            AuditActions.INTEGRATION_ACCESS,
            { type: 'user', id: req.user.id },
            req.params.orgId,
            lease.credential_id,
            req,
            { action: 'lease_revoke', lease_id: lease.id }
        );

        // F10: invalidate the 30s resolver cache so an agent can't keep
        // reading the revoked lease's plaintext for up to 30s after revoke.
        clearResolverCache();

        res.json({ revoked });
    } catch (err) {
        console.error('Failed to revoke lease:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to revoke lease' });
    }
});

export default router;
