'use strict';
/**
 * QUOXON-STEPUP part B: POST /api/v1/overrides
 *
 * A human with a live step-up token (scope `override`) overrides ONE blocked action. Refused for agents,
 * service keys and MCP tokens; refused without a step-up token (403 step_up_required); requires a reason.
 * Records who/what/block/reason in policy_overrides and witnesses it as an AEE envelope
 * (quox.policy.override.granted). Responds with whether any gate actually honours this block type.
 */
const { Router } = require('express');
const store = require('../lib/policyOverrides.js');
const { deriveActorType } = require('../utils/actorType.js');
const { requireStepUp } = require('../utils/stepUp.js');

const router = Router();
let deps = { voltDb: null, resolveRequestOrgId: null, auditOp: null };
function init(injected) { deps = { ...deps, ...injected }; if (deps.voltDb) store.ensure(deps.voltDb); }

function postOverride(req, res) {
  if (deriveActorType(req) !== 'human') {
    return res.status(403).json({ error: 'overrides_human_only', message: 'Only a person can override a policy block' });
  }
  if (!deps.voltDb) return res.status(503).json({ error: 'override store unavailable' });
  if (!requireStepUp(req, res, { scope: 'override', alwaysEnforce: true })) return;
  const orgId = deps.resolveRequestOrgId ? deps.resolveRequestOrgId(req) : (req.user && req.user.org_id);
  if (!orgId || orgId === 'default') return res.status(403).json({ error: 'org_id required' });
  const b = req.body || {};
  try {
    const rec = store.record(deps.voltDb, {
      orgId, userId: req.user.id, blockId: b.block_id, blockType: b.block_type, agentId: b.agent_id || null,
      actionSummary: b.action, reason: b.reason,
      stepUpJti: null,
    });
    if (typeof deps.auditOp === 'function') {
      deps.auditOp('quox.policy.override.granted', {
        org_id: orgId, override_id: rec.id, block_id: b.block_id, block_type: b.block_type,
        agent_id: b.agent_id || null, action: b.action || null, reason: b.reason, user_id: req.user.id, enforced: rec.enforced,
      }, { from: `human.${req.user.id}` });
    }
    return res.json({
      ok: true, override_id: rec.id, expires_at: new Date(rec.expires_at).toISOString(), enforced: rec.enforced,
      note: rec.enforced ? 'Single use, 5 minutes. Retry the action carrying this override id.'
        : `Recorded and witnessed, but no gate honours ${b.block_type} overrides yet: the action stays blocked.`,
    });
  } catch (e) {
    if (e && e.code && /^(block_id_required|bad_block_type|reason_required|org_and_user_required)$/.test(e.code)) {
      return res.status(400).json({ error: e.code, message: e.message });
    }
    console.error('[Override] record failed:', e && e.message);
    return res.status(500).json({ error: 'override failed' });
  }
}

router.post('/', postOverride);
module.exports = { router, init, postOverride };
