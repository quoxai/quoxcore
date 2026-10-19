'use strict';
/**
 * QUOXON-STEPUP: verify a human step-up token (minted by auth POST /api/me/step-up) inside any
 * service that shares JWT_SECRET (tasks, collector). Pure JWT check: signature, type, expiry,
 * and binding to the CURRENT request's user, session, org and scope. The PIN itself is only ever
 * verified by the auth service.
 */
const jwt = require('jsonwebtoken');

const STEP_UP_HEADER = 'x-step-up-token';

/**
 * @param {{headers:object}} req
 * @param {{userId:string, sessionId?:string|null, orgId?:string|null, scope?:string, secret:string}} want
 * @returns {{ok:true, jti:string}|{ok:false, reason:string}}
 */
function verifyStepUpHeader(req, { userId, sessionId = null, orgId = null, scope = 'approve', secret }) {
  const raw = req && req.headers && req.headers[STEP_UP_HEADER];
  if (!raw || typeof raw !== 'string') return { ok: false, reason: 'missing' };
  let p;
  try { p = jwt.verify(raw, secret, { algorithms: ['HS256'] }); } catch (_e) { return { ok: false, reason: 'invalid_or_expired' }; }
  if (!p || p.type !== 'step_up') return { ok: false, reason: 'invalid_or_expired' };
  if (!userId || p.sub !== userId) return { ok: false, reason: 'wrong_user' };
  if ((p.session_id || null) !== (sessionId || null)) return { ok: false, reason: 'wrong_session' };
  if (orgId && p.org_id !== orgId) return { ok: false, reason: 'wrong_org' };
  if (!Array.isArray(p.scopes) || !p.scopes.includes(scope)) return { ok: false, reason: 'wrong_scope' };
  return { ok: true, jti: p.jti };
}

/** Rollout switch: default ON; '0' | 'false' | 'off' ships the approval gate dark (log only). */
function stepUpEnforced(env = process.env) {
  return !/^(0|false|off)$/i.test(String(env.QUOX_STEP_UP_ENFORCE || '').trim());
}

module.exports = { STEP_UP_HEADER, verifyStepUpHeader, stepUpEnforced };
