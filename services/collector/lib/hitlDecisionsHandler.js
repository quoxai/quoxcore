/**
 * HITL-VOLT-WITNESS (QuoxPlan #2202) — query surface for VOLT-witnessed
 * approval decisions.
 *
 * Testable, dependency-injected handler behind GET /volt/hitl/decisions.
 * Route wiring (auth + mount) lives in server.js — mirrors
 * lib/feedApiHandlers.js's split (createXHandler({ deps }) factory,
 * requireServiceOrUserAuth() mounted by the caller, never bypassed here).
 *
 * Org isolation: a JWT/service caller only ever sees decisions for their
 * own org_id. A VOLT run tagged with a DIFFERENT org's id returns an empty
 * list rather than the other org's data — same posture as
 * voltStatements.getRunsByOrg elsewhere in server.js.
 */

'use strict';

// The three terminal decisions witnessed by
// auth/jobs/volt-witness-reaper.js's emitApprovalVoltWitness(), plus the
// original HITL-requested event the spec-aligned bridge already emits.
const HITL_DECISION_EVENT_TYPES = new Set([
  'hitl.requested',
  'hitl.approved',
  'hitl.denied',
  'hitl.cancelled',
]);

function resolveOrgId(req) {
  if (req.user && req.user.org_id) return req.user.org_id;
  if (req.service) return req.query?.org_id || null;
  return null;
}

/**
 * Parses a raw volt_events row (data = JSON-stringified VOLT event object,
 * see voltEmitter.js) into the flat decision shape the API returns.
 */
function parseHitlEvent(row) {
  let data = {};
  try { data = JSON.parse(row.data); } catch { /* leave {} — surfaced as nulls below */ }

  const payload = data.payload || {};
  return {
    event_id: row.event_id || data.event_id,
    run_id: row.run_id,
    event_type: row.event_type || data.event_type,
    ts: row.ts || data.ts,
    item_id: payload.item_id || data.context?.correlation_id || null,
    action: payload.action || null,
    actor: data.actor || null,
    comment: payload.comment,
  };
}

/**
 * Factory: builds the GET /volt/hitl/decisions handler.
 * @param {object} deps - { voltStatements } (getRunByCorr, getRunEvents)
 */
function createGetHitlDecisionsHandler({ voltStatements }) {
  return function getHitlDecisions(req, res) {
    try {
      const orgId = resolveOrgId(req);
      if (!orgId) return res.status(403).json({ error: 'org_id required' });

      const corr = req.query.corr || req.query.item_id;
      if (!corr) return res.status(400).json({ error: 'corr or item_id query parameter required' });

      if (!voltStatements || !voltStatements.getRunByCorr || !voltStatements.getRunEvents) {
        return res.status(503).json({ error: 'VOLT storage not available' });
      }

      const run = voltStatements.getRunByCorr.get(corr);
      // No run at all, OR a run tagged with a DIFFERENT org — honest empty
      // list either way, never a cross-tenant leak and never a fabricated 404.
      if (!run || (run.org_id && run.org_id !== orgId)) {
        return res.json({ decisions: [], item_id: corr });
      }

      const events = voltStatements.getRunEvents.all(run.run_id) || [];
      const decisions = events
        .filter((e) => HITL_DECISION_EVENT_TYPES.has(e.event_type))
        .map(parseHitlEvent);

      return res.json({ decisions, item_id: corr, run_id: run.run_id });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  };
}

module.exports = { createGetHitlDecisionsHandler, parseHitlEvent, HITL_DECISION_EVENT_TYPES };
