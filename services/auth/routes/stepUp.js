/**
 * QUOXON-STEPUP routes: per-user step-up PIN + step-up token mint.
 *
 *   GET    /me/step-up-pin          status only (set? when? locked?). Never the hash.
 *   PUT    /me/step-up-pin          set/change. HUMAN WEB SESSION ONLY + fresh password in the body.
 *   DELETE /me/step-up-pin          clear own PIN. Same gate.
 *   POST   /me/step-up              verify PIN, mint a 10 min token. Human principals only.
 *   DELETE /orgs/:orgId/members/:userId/step-up-pin   admin reset: CLEARS only, never sets.
 *
 * There is deliberately no CLI verb or service path that sets a PIN.
 */
import { Router } from 'express';
import { queries, getDb } from '../db/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireOrgMembership } from '../middleware/org.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { verifyPassword } from '../utils/crypto.js';
import { createAuditEvent } from '../utils/helpers.js';
import { isNonHumanPrincipal } from '../utils/principal.js';
import { sendEmail } from '../utils/emailService.js';
import { getPinStatus, setPin, clearPin, verifyPin, mintStepUpToken, isValidPinFormat, STEP_UP_SCOPES } from '../lib/stepUp.js';

const router = Router();

function humanOnly(req, res) {
    if (isNonHumanPrincipal(req)) {
        res.status(403).json({ error: 'step_up_human_only', message: 'Agent logins, service keys and MCP tokens cannot use the step-up PIN' });
        return false;
    }
    return true;
}

/** Set/change/clear: a browser session (cookie transport, 'web' session row), never a Bearer/CLI token. */
function requireHumanWebSession(req, res) {
    if (!humanOnly(req, res)) return false;
    const fail = (why) => { res.status(403).json({ error: 'web_session_required', message: 'Set or change the PIN in the dashboard (Settings > Account > Approval PIN), signed in with a browser', reason: why }); return false; };
    if (req.headers.authorization) return fail('bearer_transport');
    if (!req.cookies?.access_token) return fail('no_cookie_session');
    const sid = req.user?.sessionId;
    if (!sid) return fail('no_session');
    const row = getDb().prepare('SELECT client, revoked_at FROM sessions WHERE id = ? AND user_id = ?').get(sid, req.user.id);
    if (!row || row.revoked_at || row.client !== 'web') return fail('not_a_web_session');
    return true;
}

async function freshPasswordOk(req, res) {
    const pw = req.body?.current_password;
    if (typeof pw !== 'string' || !pw) {
        res.status(403).json({ error: 'reauth_required', message: 'Re-enter your password to continue' });
        return false;
    }
    const ident = queries.getPasswordIdentity(req.user.id);
    const ok = ident ? await verifyPassword(ident.password_hash, pw) : false;
    if (!ok) {
        res.status(403).json({ error: 'reauth_required', message: 'Password incorrect' });
        return false;
    }
    return true;
}

async function notifyChange(req, what) {
    try {
        await sendEmail({
            to: req.user.email,
            subject: `Your Quox step-up PIN was ${what}`,
            text: `Your approval step-up PIN was ${what} just now. If this was not you, reset it and change your password.`,
            html: `<p>Your approval step-up PIN was ${what} just now.</p><p>If this was not you, reset it and change your password.</p>`,
        });
    } catch (err) { console.error('[StepUp] change notification failed:', err.message); }
}

router.get('/me/step-up-pin', authenticate(), (req, res) => {
    res.json(getPinStatus(req.user.id));
});

router.put('/me/step-up-pin', authenticate(), authLimiter, async (req, res) => {
    if (!requireHumanWebSession(req, res)) return;
    if (!(await freshPasswordOk(req, res))) return;
    const { pin } = req.body || {};
    if (!isValidPinFormat(pin)) return res.status(400).json({ error: 'bad_pin_format', message: 'PIN must be exactly 6 digits' });
    const had = getPinStatus(req.user.id).set;
    await setPin(req.user.id, pin);
    createAuditEvent({ orgId: req.user.orgId || null, actorType: 'user', actorId: req.user.id, action: had ? 'stepup.pin_changed' : 'stepup.pin_set', targetType: 'user', targetId: req.user.id, metadata: { via: 'web' } });
    await notifyChange(req, had ? 'changed' : 'set');
    res.json({ ok: true, ...getPinStatus(req.user.id) });
});

router.delete('/me/step-up-pin', authenticate(), authLimiter, async (req, res) => {
    if (!requireHumanWebSession(req, res)) return;
    if (!(await freshPasswordOk(req, res))) return;
    clearPin(req.user.id);
    createAuditEvent({ orgId: null, actorType: 'user', actorId: req.user.id, action: 'stepup.pin_cleared', targetType: 'user', targetId: req.user.id, metadata: { via: 'web' } });
    await notifyChange(req, 'removed');
    res.json({ ok: true, set: false });
});

router.post('/me/step-up', authenticate(), async (req, res) => {
    if (!humanOnly(req, res)) return;
    const { pin, org_id: orgId, scopes } = req.body || {};
    // Audit FND_01M4ZH8MCD2G9M6HY79H2G9M6H: the token's VERIFIED org (req.org); req.user.orgId is only set
    // for service accounts. The membership check below still applies to whichever org is used.
    const org = orgId || req.org?.id || req.user.orgId;
    if (!org) return res.status(400).json({ error: 'org_id_required' });
    const m = queries.getOrgMembership(org, req.user.id);
    if (!m || m.status !== 'active') return res.status(403).json({ error: 'not_org_member' });
    const bad = Array.isArray(scopes) ? scopes.filter((s) => !STEP_UP_SCOPES.includes(s)) : [];
    if (bad.length) return res.status(400).json({ error: 'bad_scope', allowed: STEP_UP_SCOPES });
    const v = await verifyPin(req.user.id, pin);
    if (!v.ok) {
        createAuditEvent({ orgId: org, actorType: 'user', actorId: req.user.id, action: 'stepup.verify_failed', targetType: 'user', targetId: req.user.id, status: 'failure', metadata: { reason: v.reason } });
        if (v.reason === 'no_pin') return res.status(409).json({ error: 'no_pin_set', message: 'Set a PIN in the dashboard: Settings > Account > Approval PIN' });
        if (v.reason === 'locked') return res.status(423).json({ error: 'pin_locked', locked_until: v.locked_until });
        return res.status(401).json({ error: 'wrong_pin', tries_left: v.tries_left });
    }
    const minted = mintStepUpToken({ userId: req.user.id, orgId: org, sessionId: req.user.sessionId, scopes });
    createAuditEvent({ orgId: org, actorType: 'user', actorId: req.user.id, action: 'stepup.minted', targetType: 'user', targetId: req.user.id, metadata: { scopes: minted.scopes, expires_at: minted.expires_at } });
    res.json({ step_up_token: minted.token, scopes: minted.scopes, expires_at: minted.expires_at });
});

router.delete('/orgs/:orgId/members/:userId/step-up-pin', authenticate(), requireOrgMembership, (req, res) => {
    if (!humanOnly(req, res)) return;
    if (!['owner', 'admin'].includes(req.orgMembership?.role)) return res.status(403).json({ error: 'forbidden' });
    clearPin(req.params.userId);
    createAuditEvent({ orgId: req.params.orgId, actorType: 'user', actorId: req.user.id, action: 'stepup.pin_reset_by_admin', targetType: 'user', targetId: req.params.userId, metadata: {} });
    res.json({ ok: true });
});

export default router;
