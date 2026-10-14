/**
 * ET-4 Phase C — Session policy helpers.
 *
 * Stores per-org session limits and offers a pure expiry check that
 * middleware and token refresh flows can use.
 */

// TRUST-GATE-1.14 — a value of 0 for idleTimeoutSec / maxSessionSec means
// "disabled" / no limit for that dimension. isSessionExpired() already
// treats 0 as falsy and skips the corresponding check; getInstanceSessionPolicy
// / getSessionPolicy / setSessionPolicy below must not clamp or reject 0 —
// only "unset" (no config row / no org override) falls back to these defaults.
export const DEFAULT_SESSION_POLICY = Object.freeze({
    idleTimeoutSec: 30 * 60,        // 30 min
    maxSessionSec:  12 * 60 * 60,   // 12 h
    rememberMeEnabled: true,        // orgs opt OUT, not in
});

// AUTH-REMEMBER-ME: max_session_sec ceiling applied to sessions created
// with "remember me" opted in, when the org allows it. Idle timeout is
// untouched by remember-me — it always applies per the org's
// idleTimeoutSec (or is explicitly disabled via idleTimeoutSec: 0).
export const REMEMBER_ME_MAX_SESSION_SEC = 30 * 24 * 60 * 60; // 30 days

// CLI session class: sign-ins from the quox CLI / TUI (login body `client: 'cli'`, stored in sessions.client)
// last much longer than browser sessions. These replace the DEFAULT idle / absolute limits for CLI sessions
// only; an explicit admin value (org policy row or instance_config, including 0 = disabled) always wins.
export const CLI_SESSION_IDLE_SEC = 30 * 24 * 60 * 60; // 30 days idle
export const CLI_SESSION_MAX_SEC  = 30 * 24 * 60 * 60; // 30 days absolute
export const SESSION_CLIENT_CLI = 'cli';
export const SESSION_CLIENT_WEB = 'web';

// Caps applied to instance-level admin-configured values (in minutes).
// Defence in depth: even if the admin config row holds a value outside
// these bounds (manual SQL edit, schema drift), getSessionPolicy clamps
// at read time so the runtime never honours a nonsensical timeout.
export const INSTANCE_SESSION_POLICY_BOUNDS = Object.freeze({
    idleMinutesMin: 1,
    idleMinutesMax: 30 * 24 * 60,     // 30 days
    maxMinutesMin:  1,
    maxMinutesMax:  90 * 24 * 60,     // 90 days
});

export const INSTANCE_CONFIG_KEYS = Object.freeze({
    idleMinutes: 'auth.session_idle_minutes',
    maxMinutes:  'auth.session_max_minutes',
});

function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

// Returns: null (key absent / invalid — caller should fall back to default),
// or a non-negative integer, where 0 is the explicit "disabled" sentinel.
function readInstanceMinutes(db, key) {
    try {
        const row = db.prepare(`SELECT value FROM instance_config WHERE key = ?`).get(key);
        if (!row) return null;
        const n = parseInt(row.value, 10);
        return Number.isFinite(n) && n >= 0 ? n : null;
    } catch {
        // instance_config table absent (legacy schema / unit-test in-memory DB)
        return null;
    }
}

/**
 * Read the instance-wide session policy from instance_config, with caps.
 * Falls back to DEFAULT_SESSION_POLICY for any unset/invalid value.
 * An explicit 0 (idle or max) bypasses the clamp and is returned as 0
 * ("disabled") — see TRUST-GATE-1.14 note on DEFAULT_SESSION_POLICY above.
 */
export function getInstanceSessionPolicy(db) {
    const idleMin = readInstanceMinutes(db, INSTANCE_CONFIG_KEYS.idleMinutes);
    const maxMin  = readInstanceMinutes(db, INSTANCE_CONFIG_KEYS.maxMinutes);
    const b = INSTANCE_SESSION_POLICY_BOUNDS;
    return {
        idleTimeoutSec: idleMin === null
            ? DEFAULT_SESSION_POLICY.idleTimeoutSec
            : (idleMin === 0 ? 0 : clamp(idleMin, b.idleMinutesMin, b.idleMinutesMax) * 60),
        maxSessionSec: maxMin === null
            ? DEFAULT_SESSION_POLICY.maxSessionSec
            : (maxMin === 0 ? 0 : clamp(maxMin, b.maxMinutesMin, b.maxMinutesMax) * 60),
        // AUTH-REMEMBER-ME: no instance-level config key for this yet —
        // instance-wide fallback always allows remember-me; orgs opt out
        // via setSessionPolicy.
        rememberMeEnabled: DEFAULT_SESSION_POLICY.rememberMeEnabled,
    };
}

/**
 * Which limits did an admin set explicitly? { idle, max } booleans. An org policy row counts as explicit for
 * both; otherwise an instance_config key present (even 0) is explicit for its dimension. Used so the CLI class
 * only replaces DEFAULTS, never an admin's choice.
 */
export function getExplicitSessionOverrides(db, orgId) {
    try {
        if (orgId && db.prepare(`SELECT 1 FROM session_policies WHERE org_id = ?`).get(orgId)) return { idle: true, max: true };
    } catch { /* table absent: fall through to instance */ }
    return {
        idle: isAdminInstanceValue(db, INSTANCE_CONFIG_KEYS.idleMinutes, SEEDED_INSTANCE_MINUTES.idle),
        max:  isAdminInstanceValue(db, INSTANCE_CONFIG_KEYS.maxMinutes, SEEDED_INSTANCE_MINUTES.max),
    };
}

// Z2H-R4: migrations/000-baseline.sql seeds these rows on every install (updated_by NULL) so the admin
// PUT /admin/config/:key has a row to update. A seeded default is not an admin choice: it must not stop
// CLI sessions getting their longer class defaults (a fresh owner was signed out after 36 minutes).
export const SEEDED_INSTANCE_MINUTES = Object.freeze({ idle: 30, max: 720 });

/** True when an instance session value was set by an admin (updated_by) or differs from the seeded default. */
function isAdminInstanceValue(db, key, seeded) {
    const n = readInstanceMinutes(db, key);
    if (n === null) return false;
    if (n !== seeded) return true;
    try {
        return Boolean(db.prepare(`SELECT updated_by FROM instance_config WHERE key = ?`).get(key)?.updated_by);
    } catch {
        return false; // no updated_by column (legacy / fixture schema): the seeded value is a default
    }
}

/** The effective policy for a session of the given client class. Web (or unknown) = the policy unchanged. */
export function applyClientClass(db, policy, orgId, client) {
    if (client !== SESSION_CLIENT_CLI) return policy;
    const ex = getExplicitSessionOverrides(db, orgId);
    return {
        ...policy,
        idleTimeoutSec: ex.idle ? policy.idleTimeoutSec : CLI_SESSION_IDLE_SEC,
        maxSessionSec:  ex.max  ? policy.maxSessionSec  : CLI_SESSION_MAX_SEC,
    };
}

export function ensureSessionPolicySchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS session_policies (
            org_id              TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
            idle_timeout_sec    INTEGER NOT NULL,
            max_session_sec     INTEGER NOT NULL,
            remember_me_enabled INTEGER NOT NULL DEFAULT 1,
            updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
        );
    `);
}

export function getSessionPolicy(db, orgId) {
    if (orgId) {
        const row = db.prepare(`
            SELECT idle_timeout_sec, max_session_sec, remember_me_enabled
            FROM session_policies WHERE org_id = ?
        `).get(orgId);
        if (row) {
            return {
                idleTimeoutSec: row.idle_timeout_sec,
                maxSessionSec:  row.max_session_sec,
                rememberMeEnabled: !!row.remember_me_enabled,
            };
        }
    }
    // No per-org override → instance-wide policy from instance_config,
    // falling back to DEFAULT_SESSION_POLICY when unset.
    return getInstanceSessionPolicy(db);
}

// TRUST-GATE-1.14 — 0 is a valid, explicit "disabled" value for either
// dimension (distinct from an unset override, which never reaches this
// validator because getSessionPolicy already fell back to the default).
// Only negative / non-integer input is rejected.
export function setSessionPolicy(db, orgId, patch = {}) {
    const current = getSessionPolicy(db, orgId);
    const next = {
        idleTimeoutSec: patch.idleTimeoutSec ?? current.idleTimeoutSec,
        maxSessionSec:  patch.maxSessionSec  ?? current.maxSessionSec,
        rememberMeEnabled: patch.rememberMeEnabled ?? current.rememberMeEnabled,
    };
    if (!Number.isInteger(next.idleTimeoutSec) || next.idleTimeoutSec < 0) {
        throw new Error('invalid idle_timeout_sec');
    }
    if (!Number.isInteger(next.maxSessionSec) || next.maxSessionSec < 0) {
        throw new Error('invalid max_session_sec');
    }
    if (typeof next.rememberMeEnabled !== 'boolean') {
        throw new Error('invalid remember_me_enabled');
    }
    db.prepare(`
        INSERT INTO session_policies
            (org_id, idle_timeout_sec, max_session_sec, remember_me_enabled, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(org_id) DO UPDATE SET
            idle_timeout_sec    = excluded.idle_timeout_sec,
            max_session_sec     = excluded.max_session_sec,
            remember_me_enabled = excluded.remember_me_enabled,
            updated_at          = excluded.updated_at
    `).run(orgId, next.idleTimeoutSec, next.maxSessionSec, next.rememberMeEnabled ? 1 : 0);
    return next;
}

export function isSessionExpired({ issuedAt, lastActiveAt, now = Date.now(), policy, returnReason = false }) {
    const idleMs = (lastActiveAt != null ? now - lastActiveAt : 0);
    const liveMs = (issuedAt     != null ? now - issuedAt     : 0);
    let expired = false;
    let reason = null;
    if (policy.idleTimeoutSec && idleMs > policy.idleTimeoutSec * 1000) {
        expired = true;
        reason = 'idle_timeout';
    } else if (policy.maxSessionSec && liveMs > policy.maxSessionSec * 1000) {
        expired = true;
        reason = 'max_session';
    }
    return returnReason ? { expired, reason } : expired;
}
