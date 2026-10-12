/**
 * quox#503 — kill switch / DEFCON REST API.
 *
 * Mounted at /api/v1/safety (server.js), behind requireServiceOrUserAuth()
 * — this router is NOT in collectorAuthGate's ALLOWLIST, so every caller
 * (human or service) must authenticate; the deny-by-default gate covers it
 * automatically (see utils/collectorAuthGate.js). Reads (status/gate/history)
 * are open to any authenticated org member or service caller — agentScheduler
 * and loopDispatch poll /gate before every dispatch decision. Mutations
 * (kill-switch activate/release, defcon set) require requireHumanAdmin —
 * the same governance-critical posture as platform-settings writes: a
 * service key or an autonomous agent must never flip its own kill switch.
 *
 * Handlers are exported individually (not just the router) so
 * test/killSwitchApi.test.js calls the SAME functions the server runs,
 * rather than re-implementing the logic as a "mirror" (that duplication
 * pattern is how platformSettingsApi.test.js does it; this module avoids
 * it because the handlers are cheap to import directly).
 */

'use strict';

const { Router } = require('express');
const killSwitchStore = require('../lib/killSwitchStore.js');
const { requireHumanAdmin, requireAdminRole } = require('../utils/httpAuth.js');

const router = Router();

// Injected by server.js via init() once voltDb is available, mirroring
// routes/agentContracts.js's DI seam. resolveRequestOrgId/auditOp are
// server.js-local functions (JWT org-lock + AEE audit trail helpers) that
// this route file has no business re-implementing.
let deps = { voltDb: null, resolveRequestOrgId: null, auditOp: null };

function init(injected) {
  deps = { ...deps, ...injected };
}

function getDb() {
  return deps.voltDb;
}

function resolveOrgId(req) {
  return deps.resolveRequestOrgId ? deps.resolveRequestOrgId(req) : (req.user?.org_id || null);
}

function actorOf(req) {
  return { actorId: req.user?.id, actorLabel: req.user?.email || req.user?.id };
}

function emit(intent, payload, actorId) {
  if (typeof deps.auditOp === 'function') {
    deps.auditOp(intent, payload, { from: `human.${actorId || 'unknown'}` });
  }
}

function getStatus(req, res) {
  try {
    const orgId = resolveOrgId(req);
    if (!orgId || orgId === 'default') return res.status(403).json({ error: 'org_id required' });
    return res.json(killSwitchStore.getSafetyStatus(getDb(), orgId));
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

/** The enforcement chokepoint every dispatch path (agentScheduler, loopDispatch, chat/invoke) calls before acting. */
function getGate(req, res) {
  try {
    const orgId = resolveOrgId(req);
    const agentId = req.query.agent_id;
    if (!orgId || orgId === 'default') return res.status(403).json({ error: 'org_id required' });
    if (!agentId) return res.status(400).json({ error: 'agent_id is required' });
    return res.json(killSwitchStore.checkSafetyGate(getDb(), orgId, agentId));
  } catch (e) {
    // Fail closed even on this read: a caller that cannot parse this
    // response should treat a 500 as "unreadable", not "no halt".
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

function postKillSwitch(req, res) {
  if (!requireHumanAdmin(req, res)) return;
  try {
    const orgId = resolveOrgId(req);
    if (!orgId || orgId === 'default') return res.status(403).json({ error: 'org_id required' });
    const { agentId } = req.params;
    const reason = req.body?.reason || null;
    const result = killSwitchStore.setAgentKillSwitch(getDb(), orgId, agentId, true, actorOf(req), reason);
    emit('safety.kill_switch.activated', { org_id: orgId, agent_id: agentId, reason, actor_id: req.user?.id }, req.user?.id);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
}

function deleteKillSwitch(req, res) {
  if (!requireHumanAdmin(req, res)) return;
  try {
    const orgId = resolveOrgId(req);
    if (!orgId || orgId === 'default') return res.status(403).json({ error: 'org_id required' });
    const { agentId } = req.params;
    const result = killSwitchStore.setAgentKillSwitch(getDb(), orgId, agentId, false, actorOf(req));
    emit('safety.kill_switch.released', { org_id: orgId, agent_id: agentId, actor_id: req.user?.id }, req.user?.id);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
}

function postDefcon(req, res) {
  if (!requireHumanAdmin(req, res)) return;
  try {
    const orgId = resolveOrgId(req);
    if (!orgId || orgId === 'default') return res.status(403).json({ error: 'org_id required' });
    const { level, reason } = req.body || {};
    const result = killSwitchStore.setDefconLevel(getDb(), orgId, level, actorOf(req), reason || null);
    emit('safety.defcon.level_set', { org_id: orgId, old_level: result.old_level, new_level: result.new_level, actor_id: req.user?.id }, req.user?.id);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
}

function getHistory(req, res) {
  if (!requireAdminRole(req, res)) return;
  try {
    const orgId = resolveOrgId(req);
    if (!orgId || orgId === 'default') return res.status(403).json({ error: 'org_id required' });
    const history = killSwitchStore.getSafetyHistory(getDb(), {
      org_id: orgId,
      agent_id: req.query.agent_id || undefined,
      limit: Math.min(parseInt(req.query.limit) || 50, 200),
    });
    return res.json({ history });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

router.get('/status', getStatus);
router.get('/gate', getGate);
router.post('/kill-switch/:agentId', postKillSwitch);
router.delete('/kill-switch/:agentId', deleteKillSwitch);
router.post('/defcon', postDefcon);
router.get('/history', getHistory);

module.exports = {
  router,
  init,
  // Exported individually for direct unit testing (see module docstring).
  getStatus,
  getGate,
  postKillSwitch,
  deleteKillSwitch,
  postDefcon,
  getHistory,
};
