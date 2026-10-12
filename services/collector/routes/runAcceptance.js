/**
 * SEO-MOAT — acceptance verdict REST API (lib/acceptanceStore.js).
 *
 * Mounted at /volt/runs/:runId/acceptance (server.js), behind
 * requireServiceOrUserAuth() — NOT in collectorAuthGate's ALLOWLIST, so
 * every caller authenticates. Unlike the kill switch this is deliberately
 * NOT human-admin gated: the owner ruling says a human OR a calling system
 * may attest an outcome. The honesty boundary is the record, not the gate —
 * actor_type is derived from the CREDENTIAL CLASS (deriveActorType, never
 * self-asserted), so an agent that marks its own work "pass" is visible as
 * exactly that in the verdict, its AEE envelope, and its witnessed VOLT run.
 *
 * Same DI seam as routes/safetyGate.js; handlers exported individually so
 * test/runAcceptance.test.js calls the same functions the server runs.
 */

'use strict';

const { Router } = require('express');
const { recordAcceptanceVerdict, getAcceptanceVerdicts } = require('../lib/acceptanceStore.js');
const { deriveActorType } = require('../utils/httpAuth.js');

const router = Router({ mergeParams: true });

let deps = { voltDb: null, voltStatements: null, voltEmitter: null, resolveRequestOrgId: null, auditOp: null };

function init(injected) {
  deps = { ...deps, ...injected };
}

function resolveOrgId(req) {
  return deps.resolveRequestOrgId ? deps.resolveRequestOrgId(req) : (req.user?.org_id || null);
}

function actorOf(req) {
  const actorType = deriveActorType(req) || 'unknown';
  const actorId = req.user?.id || (req.service ? 'service' : 'unknown');
  return { actorId, actorType, actorLabel: req.user?.email || actorId };
}

function postAcceptance(req, res) {
  try {
    const orgId = resolveOrgId(req);
    if (!orgId || orgId === 'default') return res.status(403).json({ error: 'org_id required' });
    const { runId } = req.params;
    const { verdict, reason } = req.body || {};
    const actor = actorOf(req);

    let record;
    try {
      record = recordAcceptanceVerdict(deps.voltDb, deps.voltStatements, deps.voltEmitter, {
        orgId, runId, verdict, reason: reason || null, actor,
      });
    } catch (e) {
      const msg = String(e?.message || e);
      if (/not found/.test(msg)) return res.status(404).json({ error: msg });
      return res.status(400).json({ error: msg });
    }

    // AEE envelope on the TARGET run's corr, so the attestation appears in
    // the same correlation trail as the action it judges.
    if (typeof deps.auditOp === 'function') {
      const target = deps.voltDb.prepare('SELECT corr FROM volt_runs WHERE run_id = ?').get(runId);
      deps.auditOp('evidence.acceptance.recorded', {
        org_id: orgId,
        run_id: runId,
        verdict: record.verdict,
        reason: record.reason,
        actor_id: record.actor_id,
        actor_type: record.actor_type,
        target_head_hash: record.target_head_hash,
        evidence_run_id: record.evidence_run_id,
      }, { from: `${record.actor_type}.${record.actor_id}`, corr: target?.corr || undefined });
    }

    return res.json({ ok: true, verdict: record });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

function getAcceptance(req, res) {
  try {
    const orgId = resolveOrgId(req);
    if (!orgId || orgId === 'default') return res.status(403).json({ error: 'org_id required' });
    const { runId } = req.params;
    const history = getAcceptanceVerdicts(deps.voltDb, orgId, runId);
    if (!history.length) return res.status(404).json({ error: `no acceptance verdicts for run ${runId}` });
    return res.json({ run_id: runId, latest: history[0], history });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

router.post('/', postAcceptance);
router.get('/', getAcceptance);

module.exports = {
  router,
  init,
  postAcceptance,
  getAcceptance,
};
