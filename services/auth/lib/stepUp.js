/**
 * QUOXON-STEPUP: human step-up PIN + short-lived step-up tokens.
 *
 * Why: a human JWT (`quox -p moo`) proves a login, not a person at the keyboard. An agent
 * driving that terminal looks human to requireHumanDecider. A step-up token is minted only by
 * the PIN verify endpoint and is demanded by every approval sink for agent-raised / high-risk items.
 *
 * The PIN is stored ONLY as argon2id(HMAC-SHA256(pepper, pin)). The hash is never returned by any
 * endpoint and neither the PIN nor the hash is ever logged.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { getDb } from '../db/index.js';
import { hashPassword, verifyPassword, verifyToken } from '../utils/crypto.js';
import jwt from 'jsonwebtoken';
import { userRowIsNonHuman, isNonHumanPrincipal, sandboxApproverLeaseActive } from '../utils/principal.js';

export const STEP_UP_TTL_SECONDS = 10 * 60;
export const STEP_UP_SCOPES = ['approve', 'override'];
/** Rollout switch: default ON; '0' | 'false' | 'off' ships the approval gate dark (log only). */
export function stepUpEnforced(env = process.env) {
    return !/^(0|false|off)$/i.test(String(env.QUOX_STEP_UP_ENFORCE || '').trim());
}
export const STEP_UP_HEADER = 'x-step-up-token';
export const MAX_PIN_FAILURES = 5;
export const LOCK_MINUTES = 15;
const PIN_RE = /^\d{6}$/;

function pepper() {
    return process.env.MASTER_ENCRYPTION_KEY || process.env.JWT_SECRET || '';
}
function peppered(pin) {
    return createHmac('sha256', pepper()).update(String(pin)).digest('hex');
}

export function isValidPinFormat(pin) { return typeof pin === 'string' && PIN_RE.test(pin); }

export function getPinStatus(userId, db = getDb()) {
    const row = db.prepare('SELECT pin_set_at, locked_until FROM user_step_up_pins WHERE user_id = ?').get(userId);
    if (!row) return { set: false, pin_set_at: null, locked_until: null };
    const locked = row.locked_until && Date.parse(row.locked_until + 'Z') > Date.now();
    return { set: true, pin_set_at: row.pin_set_at, locked_until: locked ? row.locked_until : null };
}

export async function setPin(userId, pin, db = getDb()) {
    if (!isValidPinFormat(pin)) { const e = new Error('pin must be exactly 6 digits'); e.code = 'bad_pin_format'; throw e; }
    const hash = await hashPassword(peppered(pin));
    db.prepare(`
        INSERT INTO user_step_up_pins (user_id, pin_hash, pin_set_at, failed_count, locked_until, updated_at)
        VALUES (?, ?, datetime('now'), 0, NULL, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET pin_hash = excluded.pin_hash, pin_set_at = datetime('now'),
            failed_count = 0, locked_until = NULL, updated_at = datetime('now')
    `).run(userId, hash);
}

export function clearPin(userId, db = getDb()) {
    return db.prepare('DELETE FROM user_step_up_pins WHERE user_id = ?').run(userId).changes > 0;
}

/** @returns {Promise<{ok:true}|{ok:false, reason:'no_pin'|'locked'|'wrong', tries_left?:number, locked_until?:string}>} */
export async function verifyPin(userId, pin, db = getDb()) {
    const row = db.prepare('SELECT pin_hash, failed_count, locked_until FROM user_step_up_pins WHERE user_id = ?').get(userId);
    if (!row) return { ok: false, reason: 'no_pin' };
    if (row.locked_until && Date.parse(row.locked_until + 'Z') > Date.now()) {
        return { ok: false, reason: 'locked', tries_left: 0, locked_until: row.locked_until };
    }
    const good = isValidPinFormat(pin) && await verifyPassword(row.pin_hash, peppered(pin));
    if (good) {
        db.prepare(`UPDATE user_step_up_pins SET failed_count = 0, locked_until = NULL WHERE user_id = ?`).run(userId);
        return { ok: true };
    }
    const failed = (row.failed_count || 0) + 1;
    if (failed >= MAX_PIN_FAILURES) {
        const until = db.prepare(`SELECT datetime('now', '+${LOCK_MINUTES} minutes') AS t`).get().t;
        db.prepare(`UPDATE user_step_up_pins SET failed_count = 0, locked_until = ? WHERE user_id = ?`).run(until, userId);
        return { ok: false, reason: 'locked', tries_left: 0, locked_until: until };
    }
    db.prepare(`UPDATE user_step_up_pins SET failed_count = ? WHERE user_id = ?`).run(failed, userId);
    return { ok: false, reason: 'wrong', tries_left: MAX_PIN_FAILURES - failed };
}

export function mintStepUpToken({ userId, orgId, sessionId, scopes }) {
    const want = (Array.isArray(scopes) && scopes.length ? scopes : ['approve']).filter((s) => STEP_UP_SCOPES.includes(s));
    if (!want.length) { const e = new Error('invalid scopes'); e.code = 'bad_scope'; throw e; }
    const token = jwt.sign(
        { sub: userId, org_id: orgId, session_id: sessionId || null, scopes: want, type: 'step_up', jti: randomBytes(8).toString('hex') },
        process.env.JWT_SECRET,
        { expiresIn: STEP_UP_TTL_SECONDS, algorithm: 'HS256' },
    );
    return { token, scopes: want, expires_at: new Date(Date.now() + STEP_UP_TTL_SECONDS * 1000).toISOString() };
}

/** Validate a step-up token against the CURRENT request principal. */
export function checkStepUpToken(req, scope = 'approve', orgId = null) {
    const raw = req.headers?.[STEP_UP_HEADER];
    if (!raw || typeof raw !== 'string') return { ok: false, reason: 'missing' };
    const p = verifyToken(raw);
    if (!p || p.type !== 'step_up') return { ok: false, reason: 'invalid_or_expired' };
    if (isNonHumanPrincipal(req)) return { ok: false, reason: 'non_human' };
    if (p.sub !== req.user?.id) return { ok: false, reason: 'wrong_user' };
    if ((p.session_id || null) !== (req.user?.sessionId || null)) return { ok: false, reason: 'wrong_session' };
    if (orgId && p.org_id !== orgId) return { ok: false, reason: 'wrong_org' };
    if (!Array.isArray(p.scopes) || !p.scopes.includes(scope)) return { ok: false, reason: 'wrong_scope' };
    return { ok: true, jti: p.jti };
}

/** Raised by an agent/automation? (null creator = created through a service path.) */
export function isAgentRaised(item, db = getDb()) {
    if (!item.created_by) return true;
    const u = db.prepare('SELECT actor_type, metadata_json FROM users WHERE id = ?').get(item.created_by);
    if (!u) return true;
    return userRowIsNonHuman(u);
}

export function stepUpRequiredFor(item, db = getDb()) {
    if (!item || item.kind !== 'approval') return false;
    if (item.priority === 'high' || item.priority === 'urgent') return true;
    return isAgentRaised(item, db);
}

/**
 * Shared approve-decision gate for every human approval sink.
 * Returns true to proceed; otherwise writes the 403 and returns false.
 */
export function requireStepUpForApprove(req, res, item, { orgId, db = getDb(), scope = 'approve', sandboxExempt = false } = {}) {
    // Disposable-test instance with a live test-approver lease (human-admin-writable only) is the one exemption.
    if (sandboxExempt || sandboxApproverLeaseActive(db)) return true;
    if (item?.created_by && req.user?.id && item.created_by === req.user.id && stepUpEnforced()) {
        res.status(403).json({ error: 'self_approval_refused', message: 'You cannot approve an item you raised yourself' });
        return false;
    }
    if (!stepUpRequiredFor(item, db)) return true;
    const chk = checkStepUpToken(req, scope, orgId || item.org_id);
    if (chk.ok) return true;
    if (!stepUpEnforced()) { console.warn(`[StepUp] would require step-up (not enforced): ${scope}, reason=${chk.reason}`); return true; }
    res.status(403).json({
        error: 'step_up_required',
        reason: chk.reason,
        scope,
        pin_set: getPinStatus(req.user?.id, db).set,
        message: 'A person must confirm this approval with their step-up PIN',
    });
    return false;
}

/**
 * Approve sinks whose requester is always an agent/automation (bastion commands, credential leases):
 * a step-up token is mandatory, with no per-item classification. Same sandbox exemption and
 * self-approval refusal as requireStepUpForApprove.
 */
export function requireStepUpAlways(req, res, { orgId, requesterUserId = null, db = getDb(), scope = 'approve' } = {}) {
    if (sandboxApproverLeaseActive(db)) return true;
    if (requesterUserId && req.user?.id === requesterUserId && stepUpEnforced()) {
        res.status(403).json({ error: 'self_approval_refused', message: 'You cannot approve a request you raised yourself' });
        return false;
    }
    const chk = checkStepUpToken(req, scope, orgId);
    if (chk.ok) return true;
    if (!stepUpEnforced()) { console.warn(`[StepUp] would require step-up (not enforced): ${scope}, reason=${chk.reason}`); return true; }
    res.status(403).json({
        error: 'step_up_required', reason: chk.reason, scope,
        pin_set: getPinStatus(req.user?.id, db).set,
        message: 'A person must confirm this approval with their step-up PIN',
    });
    return false;
}
