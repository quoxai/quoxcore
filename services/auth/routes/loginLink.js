/**
 * QUOXON-C2c: one-time dashboard sign-in link.
 *
 *   POST /api/auth/login-link            signed-in human with an org in their token
 *        -> { path, expires_at, ttl_seconds }   (path is relative: the CLI joins it to
 *           the dashboard URL the installer printed, which is the one the browser reaches)
 *   GET  /api/auth/login-link/consume?t=<ticket>
 *        -> installs a normal browser session for the bound user + org, once, 302 / (or
 *           to &next=<plain same-site path> when given; anything else is ignored)
 *           every refusal: 302 /login?login_link=<reason>, no session
 *
 * Governance: 10 minute TTL, single-use, bound to user AND org (lib/loginLinkTicket.js),
 * issued only to a human principal, refused at consume time if the membership is no
 * longer active, the user has MFA, or the org requires it (a link is never a second
 * factor), and IP allowlists apply through issueSession. Every mint, consume and refusal
 * is audited; the ticket itself never is.
 *
 * Session issuance reuses app.locals.issueSession (the SSO path in server.js), so the
 * cookie, session row and IP allowlist logic live in one place.
 * Mounted in server.js behind authLimiter.
 */
import { Router } from 'express';
import { getDb as defaultGetDb, queries } from '../db/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { logAuthEvent } from '../utils/audit.js';
import { isNonHumanPrincipal } from '../utils/principal.js';
import { readInstanceConfigValue } from '../lib/instanceConfigOverrides.js';
import { mintLoginLinkTicket, consumeLoginLinkTicket, LOGIN_LINK_TTL_MS } from '../lib/loginLinkTicket.js';

export const LOGIN_LINK_ACTIONS = {
    ISSUED: 'auth.login_link.issued',
    CONSUMED: 'auth.login_link.consumed',
    REJECTED: 'auth.login_link.rejected',
};

function orgRequiresMfa(org) {
    try {
        const flags = typeof org?.security_flags_json === 'string' ? JSON.parse(org.security_flags_json) : org?.security_flags_json;
        return flags?.mfa?.mode === 'required';
    } catch { return false; }
}

/** `next` is honoured only as a plain same-site path ("/sessions", "/lucid?tab=x"); anything else lands on "/". */
export function safeNext(next) {
    if (typeof next !== 'string' || next.length > 200) return '/';
    return /^\/(?![/\\])[A-Za-z0-9._~\-/]*(\?[A-Za-z0-9._~\-=&%]*)?$/.test(next) ? next : '/';
}

const isLoopbackHost = (h) => /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i.test(String(h || '').replace(/:\d+$/, ''));

/**
 * The public origin a browser on another machine can reach: the wizard's app_base_url, else APP_BASE_URL,
 * else the request's own Host (X-Forwarded-* honoured via trust proxy) unless that is loopback. null = unknown.
 */
export function publicOrigin(req) {
    for (const v of [readInstanceConfigValue('app_base_url'), process.env.APP_BASE_URL]) {
        if (!v) continue;
        try { const u = new URL(v); if (/^https?:$/.test(u.protocol)) return u.origin; } catch { /* next */ }
    }
    // X-Forwarded-Host only counts when the app trusts its proxy (server.js sets trust proxy 1).
    const fwd = req.app?.get?.('trust proxy') ? String(req.get?.('x-forwarded-host') || '').split(',')[0].trim() : '';
    const host = fwd || req.get?.('host');
    if (host && !isLoopbackHost(host)) {
        const proto = req.protocol === 'https' ? 'https' : 'http';
        try { return new URL(`${proto}://${host}`).origin; } catch { /* none */ }
    }
    return null;
}

export function createLoginLinkRouter({ getDb = defaultGetDb } = {}) {
    const router = Router();

    router.post('/', authenticate(), (req, res) => {
        if (isNonHumanPrincipal(req)) {
            return res.status(403).json({ error: 'human_required', message: 'Only a signed-in person can create a sign-in link.' });
        }
        const orgId = req.org?.id;
        if (!orgId) {
            return res.status(400).json({ error: 'org_required', message: 'Sign in to an organisation first; the link is bound to it.' });
        }
        try {
            const { id, ticket, expiresAt } = mintLoginLinkTicket(getDb(), { userId: req.user.id, orgId, ip: req.ip });
            logAuthEvent(LOGIN_LINK_ACTIONS.ISSUED, req.user.id, req, { ticket_id: id, expires_at: expiresAt }, orgId);
            res.set('Cache-Control', 'no-store');
            const path = `${req.baseUrl}/consume?t=${ticket}`;
            const origin = publicOrigin(req);
            return res.json({
                path,
                url: origin ? `${origin}${path}` : null,
                expires_at: expiresAt,
                ttl_seconds: Math.round(LOGIN_LINK_TTL_MS / 1000),
            });
        } catch (err) {
            console.error('[login-link] mint failed:', err.message);
            return res.status(500).json({ error: 'login_link_failed', message: 'Could not create a sign-in link.' });
        }
    });

    router.get('/consume', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.set('Referrer-Policy', 'no-referrer');
        const refuse = (reason, userId = null, orgId = null, extra = {}) => {
            logAuthEvent(LOGIN_LINK_ACTIONS.REJECTED, userId, req, { reason, ...extra }, orgId);
            return res.redirect(302, `/login?login_link=${encodeURIComponent(reason)}`);
        };
        const t = typeof req.query.t === 'string' ? req.query.t : null;
        let spent;
        try {
            spent = consumeLoginLinkTicket(getDb(), t, { ip: req.ip });
        } catch (err) {
            console.error('[login-link] consume failed:', err.message);
            return refuse('error');
        }
        if (!spent.ok) return refuse(spent.reason);
        const { userId, orgId, id: ticketId } = spent;

        const user = queries.getUserById(userId);
        if (!user || user.status !== 'active') return refuse('user_inactive', userId, orgId, { ticket_id: ticketId });
        if (user.actor_type && user.actor_type !== 'human') return refuse('human_required', userId, orgId, { ticket_id: ticketId });
        const membership = queries.getOrgMembership(orgId, userId);
        if (!membership || membership.status !== 'active') return refuse('not_member', userId, orgId, { ticket_id: ticketId });
        const org = queries.getOrgById(orgId);
        if (!org) return refuse('not_member', userId, orgId, { ticket_id: ticketId });
        if (user.mfa_enabled || orgRequiresMfa(org)) return refuse('mfa_required', userId, orgId, { ticket_id: ticketId });

        const issue = req.app.locals?.issueSession;
        if (typeof issue !== 'function') return refuse('unavailable', userId, orgId, { ticket_id: ticketId });
        try {
            const out = await issue(res, { userId, orgId, email: user.primary_email, req });
            if (out === null || res.headersSent) return undefined; // issueSession refused (IP allowlist) and answered
        } catch (err) {
            console.error('[login-link] session issue failed:', err.message);
            return refuse('error', userId, orgId, { ticket_id: ticketId });
        }
        logAuthEvent(LOGIN_LINK_ACTIONS.CONSUMED, userId, req, { ticket_id: ticketId }, orgId);
        return res.redirect(302, safeNext(req.query.next));
    });

    return router;
}

export default createLoginLinkRouter();
