/**
 * ET-ENFORCE Phase E — runtime policy enforcement helpers.
 *
 * Three stored-but-unenforced policies get wired at request time by
 * authenticate() / login, using these pure-ish helpers:
 *
 *   - enforceSessionPolicy(db, { sessionId, userId, now? })
 *       Looks up the session row, checks revoked_at, runs isSessionExpired
 *       against the org's session_policies (or defaults), revokes when
 *       expired, and stamps last_active_at on allow. Returns
 *       { allowed, reason, session? }.
 *
 *   - enforceIpAllowlist(db, { orgId, ip })
 *       Reads ip_allowlist rows for the org and checks isIpAllowed.
 *       Empty list = opt-out = allowed. No org context = allowed.
 *
 *   - enforceMfaGate({ mode, userHasMfa, mfaVerified, userRole?, breakGlass?, phase? })
 *       Thin wrapper around evaluateMfaPolicy that softens the login
 *       phase: if the user IS enrolled we allow through login even
 *       before mfaVerified flips to true, because the MFA challenge
 *       step is a separate follow-up call in the OAuth flow.
 *
 * Each helper takes explicit dependencies so tests can hit them
 * without the module-level `queries` singleton.
 */

import { getSessionPolicy, isSessionExpired, REMEMBER_ME_MAX_SESSION_SEC } from './sessionPolicy.js';
import { listIpAllowlist, isIpAllowed, normaliseIp, isIpv6 } from './ipAllowlist.js';
import { evaluateMfaPolicy, MFA_MODES } from './mfaPolicy.js';
import { ulid } from './helpers.js';

function tsMs(isoOrNull) {
    if (!isoOrNull) return null;
    // SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" UTC. Treat as UTC.
    const normalised = isoOrNull.includes('T') ? isoOrNull : isoOrNull.replace(' ', 'T') + 'Z';
    const t = Date.parse(normalised);
    return Number.isNaN(t) ? null : t;
}

export function enforceSessionPolicy(db, { sessionId, userId, now = Date.now() }) {
    if (!sessionId) return { allowed: true, reason: 'no_session_id' };
    const row = db.prepare(
        `SELECT id, user_id, org_id, created_at, last_active_at, revoked_at
         FROM sessions WHERE id = ?`,
    ).get(sessionId);
    if (!row) return { allowed: false, reason: 'session_not_found' };
    if (userId && row.user_id !== userId) {
        return { allowed: false, reason: 'session_user_mismatch' };
    }
    if (row.revoked_at) {
        return { allowed: false, reason: 'session_revoked' };
    }

    const policy = row.org_id ? getSessionPolicy(db, row.org_id) : getSessionPolicy(db, null);
    const issuedAt    = tsMs(row.created_at);
    // Treat missing last_active_at as "just touched" so idle=0, never
    // trips the idle timeout on the first touch after migration.
    const lastActive  = tsMs(row.last_active_at) || now;

    // AUTH-REMEMBER-ME: read remember_me defensively in its own query —
    // migration 072 added the column, but older schemas / test fixtures
    // that hand-build a `sessions` table without it must not crash the
    // whole enforcement check (same schema-drift tolerance pattern as
    // readInstanceMinutes() above). Missing column/table → treat as
    // "not remembered".
    let rememberMeFlag = false;
    try {
        const rmRow = db.prepare(`SELECT remember_me FROM sessions WHERE id = ?`).get(sessionId);
        rememberMeFlag = !!rmRow?.remember_me;
    } catch {
        rememberMeFlag = false;
    }

    // A session created with remember-me opted in (and still allowed by
    // the org's current policy) gets its max_session_sec ceiling
    // extended — idle timeout is untouched, it always applies from
    // `policy` as-is. A max_session_sec of 0 already means "no limit"
    // and stays that way regardless of remember-me.
    const rememberMeActive = rememberMeFlag && policy.rememberMeEnabled;
    let effectivePolicy = (rememberMeActive && policy.maxSessionSec > 0)
        ? { ...policy, maxSessionSec: Math.max(policy.maxSessionSec, REMEMBER_ME_MAX_SESSION_SEC) }
        : policy;

    // SVC-AUTH #447 bridge: agent-ops accounts (users.metadata_json.agent_ops)
    // are exempt from the IDLE timeout only — agents think in bursts and the
    // human-shaped idle reaper kept dropping their sessions mid-task (3x in
    // one night, 2026-08-11). Absolute max-session still applies unchanged.
    // Defensive read: schema drift or a malformed metadata_json must never
    // break enforcement for everyone else.
    try {
        const uRow = db.prepare('SELECT metadata_json FROM users WHERE id = ?').get(row.user_id);
        if (uRow && JSON.parse(uRow.metadata_json || '{}').agent_ops) {
            effectivePolicy = { ...effectivePolicy, idleTimeoutSec: 0 };
        }
    } catch { /* fail closed to the normal policy */ }

    const verdict = isSessionExpired({ issuedAt, lastActiveAt: lastActive, now, policy: effectivePolicy, returnReason: true });
    if (verdict.expired) {
        try {
            db.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?`).run(sessionId);
        } catch (err) {
            console.error('[enforcement] failed to revoke expired session:', err.message);
        }
        // ET-ENFORCE round-3: emit an audit row for the policy reap so
        // compliance evidence captures it. Best-effort — never let an
        // audit-insert failure mask the security verdict.
        try {
            db.prepare(`
                INSERT INTO audit_events
                    (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json)
                VALUES (?, ?, 'system', NULL, ?, 'session', ?, 'success', ?)
            `).run(
                ulid(),
                row.org_id || null,
                'auth.session.policy_revoked',
                sessionId,
                JSON.stringify({ reason: verdict.reason, user_id: row.user_id }),
            );
        } catch { /* swallow */ }
        return { allowed: false, reason: verdict.reason, session: row };
    }

    try {
        db.prepare(`UPDATE sessions SET last_active_at = datetime('now') WHERE id = ?`).run(sessionId);
    } catch (err) {
        console.error('[enforcement] failed to stamp last_active_at:', err.message);
    }
    return { allowed: true, reason: null, session: row };
}

export function enforceIpAllowlist(db, { orgId, ip }) {
    if (!orgId) return { allowed: true, reason: 'no_org_context' };
    let rules = [];
    try {
        rules = listIpAllowlist(db, orgId).map(r => r.cidr);
    } catch (err) {
        console.error('[enforcement] allowlist lookup failed:', err.message);
        // If the table doesn't exist (legacy schema), fall safe-open: the
        // feature is opt-in and not-wired is indistinguishable from empty.
        return { allowed: true, reason: 'no_allowlist_table' };
    }
    if (rules.length === 0) return { allowed: true, reason: 'no_allowlist' };
    if (!ip || typeof ip !== 'string') return { allowed: false, reason: 'ip_not_allowed' };
    // ET-ENFORCE round-3: normalise IPv4-mapped (::ffff:1.2.3.4) → v4 so
    // dual-stack proxies don't accidentally lock out v4 clients. True IPv6
    // (no v4-mapping) gets a distinct reason so the UI can explain it.
    const normalised = normaliseIp(ip);
    if (isIpv6(normalised)) {
        return { allowed: false, reason: 'ipv6_not_supported_by_allowlist' };
    }
    // isIpAllowed swallows parse errors for individual rules; if the
    // request IP itself isn't IPv4, none of the rules will match.
    return isIpAllowed(normalised, rules)
        ? { allowed: true, reason: 'ip_matched' }
        : { allowed: false, reason: 'ip_not_allowed' };
}

export function enforceMfaGate({ mode = MFA_MODES.OPTIONAL, userHasMfa = false, mfaVerified = false, userRole = null, breakGlass = false, phase = null } = {}) {
    const verdict = evaluateMfaPolicy({ mode, userHasMfa, mfaVerified, userRole, breakGlass });
    // At login we only block on enrollment gaps; the challenge is the
    // separate /mfa/verify call. evaluateMfaPolicy blocks with
    // 'mfa_challenge_required' for enrolled-but-not-yet-challenged users
    // — which is correct per-request but wrong at login. Soften here.
    if (phase === 'login' && verdict.allowed === false && verdict.reason === 'mfa_challenge_required') {
        return { allowed: true, required: true, reason: null };
    }
    return verdict;
}
