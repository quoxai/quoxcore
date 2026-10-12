/**
 * Auth-side face of the ONE principal classifier (services/shared/principal.cjs,
 * also used by the collector). TRUST-PROOF plugin-frame-c1, F13/F14.
 *
 * HARD INVARIANT #1: agents cannot resolve HITL inbox items; they file
 * proposals for a human. A direct authenticated HUMAN action is authorization.
 */
import { createRequire } from 'node:module';
import { getDb } from '../db/index.js';
import { isDisposableTestInstance, getTestApproverLeaseUntil } from '../lib/quoxperticusInstance.js';

const require = createRequire(import.meta.url);
const shared = require('../../shared/principal.cjs');

export const { isNonHumanClaims, isNonHumanPrincipal, pickAgentClaims } = shared;

export const AGENT_DECISION_REFUSAL =
    'Agents cannot resolve HITL inbox items (HARD INVARIANT #1); file a proposal for a human instead';

/** True while a disposable_test instance holds an unexpired test-approver lease. */
export function sandboxApproverLeaseActive(db = getDb()) {
    const leaseUntil = getTestApproverLeaseUntil(db);
    const leaseExpiry = leaseUntil ? Date.parse(leaseUntil) : NaN;
    return isDisposableTestInstance(db) && Number.isFinite(leaseExpiry) && leaseExpiry > Date.now();
}

/**
 * Gate for every approval/decision sink. Returns true when the caller may
 * proceed; otherwise writes the 403 and returns false. Non-human principals
 * are refused unless the disposable-test sandbox approver lease is active.
 */
export function requireHumanDecider(req, res) {
    if (!isNonHumanPrincipal(req)) return true;
    if (sandboxApproverLeaseActive()) return true;
    res.status(403).json({ error: AGENT_DECISION_REFUSAL });
    return false;
}

export const AGENT_GRANT_REFUSAL =
    'Agents cannot grant or widen capabilities; file a proposal for a human instead';

/**
 * Gate for every route that GRANTS or WIDENS capability (tool assignment,
 * attach grants, role/membership changes, credential assignment). Same
 * classifier and sandbox-lease exception as requireHumanDecider. Revocations
 * (DELETE) are de-escalation and are NOT gated. Call BEFORE any lookup so a
 * bogus-id probe by an agent gets 403, not 404.
 */
export function requireHumanGrantor(req, res) {
    if (!isNonHumanPrincipal(req)) return true;
    if (sandboxApproverLeaseActive()) return true;
    res.status(403).json({ error: AGENT_GRANT_REFUSAL });
    return false;
}

/** Express middleware form of requireHumanGrantor. */
export function humanGrantorOnly(req, res, next) {
    if (requireHumanGrantor(req, res)) next();
}

/** DB-row face of the same rule: a users row that is an agent / agent_ops account. */
export function userRowIsNonHuman(user) {
    if (!user) return false;
    if (user.actor_type === 'agent') return true;
    try { return !!JSON.parse(user.metadata_json || '{}').agent_ops; }
    catch { return false; }
}
