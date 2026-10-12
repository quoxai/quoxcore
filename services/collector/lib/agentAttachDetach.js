/**
 * QuoxIdentity P4 (Territory H, collector) — detach witnessing symmetry.
 *
 * See docs/QUOXIDENTITY_P4_CONTRACT.md §5. Lease grant/takeover/release/expire
 * is already witnessed on auth via audit_events -> wardAdapter (P1). Kit fetch
 * and handoff are already witnessed on the collector (P1/P2). This module
 * closes the loop: when the CLI posts a detach notice, the collector emits an
 * AEE envelope (intent quox.identity.detach) so the detach is visible in the
 * SAME AEE stream the kit fetch and handoff already write to.
 *
 * This endpoint does NOT release the lease itself (auth owns lease state via
 * agent_attach_leases, P1 territory A) — it is a witness-only notice, posted
 * by the CLI between the slot release and the lease release calls (P4 §5).
 *
 * Route logic lives here, not inline in server.js, mirroring
 * lib/agentAttachHandoff.js's dependency-injected handler factory pattern.
 */

'use strict';

const { deriveActorType } = require('../utils/httpAuth.js');

const VALID_REASONS = new Set(['detach', 'handoff_and_detach']);

/**
 * Express handler factory for POST /api/v1/agent-attach/detach.
 * @param {object} deps
 * @param {(envelope: object) => void} [deps.audit] - storeAuditEnvelope (server.js)
 */
function createAgentAttachDetachHandler(deps = {}) {
  const audit = deps.audit || (() => {});

  return function agentAttachDetachHandler(req, res) {
    // Same gate shape as GET /api/v1/agent-attach/kit and POST .../handoff
    // (P1/P2 contract): attach lease callers only.
    const actorType = deriveActorType(req);
    const tokenLeaseId = req.user?.attach_lease_id || null;
    if (actorType !== 'agent' || !tokenLeaseId) {
      return res.status(403).json({
        error: 'attach_required',
        message: 'This endpoint requires an active attach lease (an agent-scoped token carrying an attach_lease_id claim).',
      });
    }

    const agentId = String(req.user.agent_id || '').toLowerCase();
    if (!agentId) {
      return res.status(400).json({ error: 'missing_agent_id', message: 'attach token has no agent_id claim' });
    }

    const { lease_id: bodyLeaseId, reason } = req.body || {};
    if (!bodyLeaseId || typeof bodyLeaseId !== 'string') {
      return res.status(400).json({ error: 'lease_id_required', message: 'lease_id is required' });
    }
    // Fail closed: a caller can only witness detach for the lease its own
    // token is bound to, never an arbitrary lease id passed in the body.
    if (bodyLeaseId !== tokenLeaseId) {
      return res.status(403).json({
        error: 'lease_mismatch',
        message: 'lease_id does not match the attach token\'s attach_lease_id claim',
      });
    }
    if (!reason || !VALID_REASONS.has(reason)) {
      return res.status(400).json({
        error: 'invalid_reason',
        message: `reason must be one of: ${Array.from(VALID_REASONS).join(', ')}`,
      });
    }

    const orgId = req.user.org_id || null;

    try {
      audit({
        type: 'event',
        from: `agent.${agentId}`,
        to: 'audit.system',
        intent: 'quox.identity.detach',
        corr: tokenLeaseId,
        org_id: orgId,
        payload: {
          lease_id: tokenLeaseId,
          org_id: orgId,
          reason,
        },
      });
    } catch (err) {
      console.warn('[AgentAttachDetach] audit envelope emit failed (non-fatal):', err.message);
    }

    return res.status(200).json({ ok: true, lease_id: tokenLeaseId, reason });
  };
}

module.exports = {
  createAgentAttachDetachHandler,
  VALID_REASONS,
};
