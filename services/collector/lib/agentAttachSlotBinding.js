/**
 * QuoxIdentity P3 (territory F, collector) — slot binding CRUD.
 *
 * PUT + DELETE + GET /api/v1/agent-attach/:agentId/slot-binding. See
 * docs/QUOXIDENTITY_P3_CONTRACT.md for the binding contract; this module
 * implements the "Territory F: collector" route section. Same
 * dependency-injected handler factory pattern as lib/agentAttachKit.js /
 * lib/agentAttachHandoff.js — server.js passes in the real
 * requireHumanAdmin/storeAuditEnvelope/store instances; tests inject stubs.
 *
 * PUT/DELETE are a human-org-admin act (binding an address is an admin
 * act, not something an attach token may do to itself) — gated with
 * requireHumanAdmin (utils/httpAuth.js), the SAME gate server.js already
 * uses for the analogous "curate the slot pool" actions (slot create/
 * retire, bridge set). GET is open to any authenticated org member OR an
 * attach-lease-bearing agent token (no extra role gate beyond the route's
 * requireServiceOrUserAuth() + requireLicence('quoxslots') mount, mirroring
 * the read-only slots routes).
 */

'use strict';

const { requireHumanAdmin } = require('../utils/httpAuth.js');

// Same tenant-isolation posture as server.js's resolveSlotOrgId: a JWT
// caller (human or agent-scoped attach token, both carry org_id on the
// verified token) is LOCKED to their own org; only a trusted service-key
// caller may name an org explicitly via query/body/header.
function resolveBindingOrgId(req) {
  if (req.user?.org_id) return req.user.org_id;
  if (req.service) return req.query?.org_id || req.body?.org_id || req.headers['x-org-id'] || null;
  return null;
}

function actorLabel(req) {
  if (req.user) return `human.${req.user.id || req.user.sub || 'unknown'}`;
  return 'system.tasks';
}

/**
 * Express handler factory for PUT /api/v1/agent-attach/:agentId/slot-binding.
 * @param {object} deps
 * @param {object} deps.agentSlotBindings - lib/agentSlotBindings.js store instance
 * @param {object} deps.devSlots - lib/devSlotsStore.js store instance (existence check only)
 * @param {(envelope: object) => void} [deps.audit] - storeAuditEnvelope
 */
function createSetSlotBindingHandler({ agentSlotBindings, devSlots, audit } = {}) {
  const emit = audit || (() => {});

  return function setSlotBindingHandler(req, res) {
    if (!requireHumanAdmin(req, res, 'Binding an agent to a slot address requires a human org admin')) return;

    const orgId = resolveBindingOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'org could not be resolved' });

    const agentId = String(req.params.agentId || '').toLowerCase();
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });

    const slotName = req.body?.slot_name;
    if (!slotName || typeof slotName !== 'string') {
      return res.status(400).json({ error: 'slot_name is required' });
    }

    try {
      // Binding does NOT create the slot; it references an existing
      // dev_slots row (contract). 404 if the named slot does not exist in
      // this org.
      const slot = devSlots.getSlot({ orgId, name: slotName });
      if (!slot) {
        return res.status(404).json({ error: 'unknown_slot', message: `No slot named '${slotName}' in this organisation` });
      }

      const result = agentSlotBindings.setBinding({ orgId, agentId, slotName, createdBy: actorLabel(req) });
      if (!result.ok) {
        if (result.code === 'agent_already_bound') {
          return res.status(409).json({ error: 'agent_already_bound', message: `Agent '${agentId}' is already bound to a slot; unbind it first` });
        }
        if (result.code === 'slot_already_bound') {
          return res.status(409).json({ error: 'slot_already_bound', message: `Slot '${slotName}' is already bound to a different agent` });
        }
        return res.status(500).json({ error: 'bind_failed' });
      }

      try {
        emit({
          type: 'event',
          from: actorLabel(req),
          to: 'audit.system',
          intent: 'quox.identity.slot_bind',
          corr: result.binding.id,
          org_id: orgId,
          payload: { org_id: orgId, agent_id: agentId, slot_name: slotName, binding_id: result.binding.id },
        });
      } catch (err) {
        console.warn('[AgentAttachSlotBinding] audit envelope emit failed (non-fatal):', err.message);
      }

      return res.status(201).json({ binding: result.binding });
    } catch (err) {
      console.error('[AgentAttachSlotBinding] set binding failed:', err.message);
      return res.status(500).json({ error: 'bind_failed' });
    }
  };
}

/**
 * Express handler factory for DELETE /api/v1/agent-attach/:agentId/slot-binding.
 * @param {object} deps
 * @param {object} deps.agentSlotBindings - lib/agentSlotBindings.js store instance
 * @param {(envelope: object) => void} [deps.audit] - storeAuditEnvelope
 */
function createDeleteSlotBindingHandler({ agentSlotBindings, audit } = {}) {
  const emit = audit || (() => {});

  return function deleteSlotBindingHandler(req, res) {
    if (!requireHumanAdmin(req, res, 'Unbinding an agent from a slot address requires a human org admin')) return;

    const orgId = resolveBindingOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'org could not be resolved' });

    const agentId = String(req.params.agentId || '').toLowerCase();
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });

    try {
      // Same "release a not-held slot is a no-op success" idempotency as
      // devSlotsStore.releaseSlot: a retry of a delete that already landed
      // must not error. Only a REAL deletion is witnessed — an audit trail
      // of no-op DELETE retries would be noise, not evidence.
      const existing = agentSlotBindings.getBinding({ orgId, agentId });
      const result = agentSlotBindings.deleteBinding({ orgId, agentId });

      if (result.deleted && existing) {
        try {
          emit({
            type: 'event',
            from: actorLabel(req),
            to: 'audit.system',
            intent: 'quox.identity.slot_unbind',
            corr: existing.id,
            org_id: orgId,
            payload: { org_id: orgId, agent_id: agentId, slot_name: existing.slot_name, binding_id: existing.id },
          });
        } catch (err) {
          console.warn('[AgentAttachSlotBinding] audit envelope emit failed (non-fatal):', err.message);
        }
      }

      return res.json({ ok: true, deleted: !!result.deleted });
    } catch (err) {
      console.error('[AgentAttachSlotBinding] delete binding failed:', err.message);
      return res.status(500).json({ error: 'unbind_failed' });
    }
  };
}

/**
 * Express handler factory for GET /api/v1/agent-attach/:agentId/slot-binding.
 * Open to any authenticated org member or attach token (no admin gate) —
 * reading an address is not the admin act that setting/clearing it is.
 * @param {object} deps
 * @param {object} deps.agentSlotBindings - lib/agentSlotBindings.js store instance
 */
function createGetSlotBindingHandler({ agentSlotBindings } = {}) {
  return function getSlotBindingHandler(req, res) {
    const orgId = resolveBindingOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'org could not be resolved' });

    const agentId = String(req.params.agentId || '').toLowerCase();
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });

    try {
      const binding = agentSlotBindings.getBinding({ orgId, agentId });
      if (!binding) return res.status(404).json({ error: 'no_binding', message: `Agent '${agentId}' has no slot binding` });
      return res.json({ binding });
    } catch (err) {
      console.error('[AgentAttachSlotBinding] get binding failed:', err.message);
      return res.status(500).json({ error: 'get_failed' });
    }
  };
}

module.exports = {
  createSetSlotBindingHandler,
  createDeleteSlotBindingHandler,
  createGetSlotBindingHandler,
  resolveBindingOrgId,
};
