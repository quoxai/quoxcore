/**
 * lib/breakGlass.js — LICENSE-LAUNCH LL-6b piece 4.
 *
 * PROBLEM. Several security postures are switched by an environment variable
 * alone, and two of them are OFF by default:
 *
 *   COLLECTOR_AUTH_ENFORCE      default 'shadow' — the collector's default-deny
 *                               gate LOGS would-deny and lets the request
 *                               through. Unset on a production box means the
 *                               whole gate is decorative.
 *   AEE_ENDPOINT_AUTH_ENFORCE   default off — AEE endpoint auth is log-only.
 *   QUOXCHAT_LICENSE_ENFORCE    default on, but the literal 'off' disables the
 *                               revenue gate on every live widget.
 *
 * A single line in a compose file, or a var silently substituted as empty,
 * therefore turns enforcement off in production with nothing to show for it
 * but a log line nobody reads. That is exactly the failure the no-env-only-
 * config house rule exists to stop.
 *
 * SHAPE. Enforcement-off in production now requires a server-side, expiring
 * BREAK-GLASS record: { flag, reason, expires_at (<= 72h), created_by }, held
 * in instance_config, created and cleared by an instance admin through the
 * dashboard (Settings → Security → Enforcement) or the API. With
 * NODE_ENV=production and a flag switched off but NO unexpired break-glass,
 * the service logs loudly and treats enforcement as ON. Fail closed: the
 * default posture of an unattended production box is enforcement, and turning
 * it off is a deliberate, attributed, self-expiring act.
 *
 * Outside production the env flag is obeyed as before — dev boxes and CI must
 * stay switchable without ceremony.
 *
 * MIRRORED IN THE COLLECTOR. services/collector/lib/enforcementPosture.js
 * carries the same registry and the same resolver in CommonJS (the collector
 * cannot import this ESM module), and polls this service for the active
 * records. tests/enforcement-break-glass.test.js asserts the two registries
 * have not drifted apart.
 */

import { ulid } from '../utils/helpers.js';

/** Hard ceiling on a break-glass window. Not configurable, deliberately. */
export const MAX_BREAK_GLASS_MS = 72 * 60 * 60 * 1000;

/** A reason shorter than this is not a reason. */
export const MIN_REASON_LENGTH = 8;

const CONFIG_PREFIX = 'security.enforcement.breakglass.';

/**
 * The enforcement flags a break-glass can cover.
 *
 * `enforcedWhen` answers "does the ENVIRONMENT currently ask for enforcement?"
 * — each flag words that differently, and the difference matters:
 *   COLLECTOR_AUTH_ENFORCE     opt IN  ('enforce' and nothing else)
 *   AEE_ENDPOINT_AUTH_ENFORCE  opt IN  ('true' and nothing else)
 *   QUOXCHAT_LICENSE_ENFORCE   opt OUT (anything except 'off')
 */
export const ENFORCEMENT_FLAGS = [
    {
        key: 'COLLECTOR_AUTH_ENFORCE',
        name: 'Collector default-deny auth gate',
        service: 'collector',
        description: 'Rejects unauthenticated requests to non-allowlisted collector routes. Defaults to shadow (log-only).',
        defaultsOff: true,
        enforcedWhen: (env) => env.COLLECTOR_AUTH_ENFORCE === 'enforce',
    },
    {
        key: 'AEE_ENDPOINT_AUTH_ENFORCE',
        name: 'AEE endpoint authentication',
        service: 'collector',
        description: 'Rejects AEE envelope posts that carry no valid credential. Defaults to log-only.',
        defaultsOff: true,
        enforcedWhen: (env) => env.AEE_ENDPOINT_AUTH_ENFORCE === 'true',
    },
    {
        key: 'QUOXCHAT_LICENSE_ENFORCE',
        name: 'QuoxChat widget licence gate',
        service: 'collector',
        description: 'Requires a verified quoxchat entitlement before a widget serves. Enforced unless set to the literal "off".',
        defaultsOff: false,
        enforcedWhen: (env) => String(env.QUOXCHAT_LICENSE_ENFORCE || 'on').toLowerCase() !== 'off',
    },
];

export const ENFORCEMENT_FLAG_KEYS = ENFORCEMENT_FLAGS.map(f => f.key);

export function getFlag(key) {
    return ENFORCEMENT_FLAGS.find(f => f.key === key) || null;
}

// ──────────────────────────────────────────────────────────────────────
// The pure resolver — no DB, no env reads of its own, so it is trivially
// testable and identical to the collector's copy.
// ──────────────────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {object} args.flag        an ENFORCEMENT_FLAGS entry
 * @param {object} args.env         the environment to judge (process.env)
 * @param {object|null} args.breakGlass  the ACTIVE record for this flag, or null
 * @param {string} [args.nodeEnv]   defaults to env.NODE_ENV
 * @returns {{ enforced: boolean, envEnforced: boolean, breakGlassActive: boolean,
 *             forced: boolean, reason: string }}
 *   forced=true means the environment asked for enforcement-off and we
 *   overrode it. That is the case that must be logged loudly.
 */
export function resolveEnforcement({ flag, env = {}, breakGlass = null, nodeEnv = undefined }) {
    if (!flag || typeof flag.enforcedWhen !== 'function') {
        throw new Error('resolveEnforcement: a flag registry entry is required');
    }
    const effectiveNodeEnv = nodeEnv === undefined ? env.NODE_ENV : nodeEnv;
    const envEnforced = !!flag.enforcedWhen(env);
    const breakGlassActive = isActive(breakGlass);

    if (envEnforced) {
        return { enforced: true, envEnforced, breakGlassActive, forced: false, reason: 'env_enforced' };
    }
    if (effectiveNodeEnv !== 'production') {
        return { enforced: false, envEnforced, breakGlassActive, forced: false, reason: 'env_off_non_production' };
    }
    if (breakGlassActive) {
        return { enforced: false, envEnforced, breakGlassActive, forced: false, reason: 'break_glass' };
    }
    return { enforced: true, envEnforced, breakGlassActive, forced: true, reason: 'production_no_break_glass' };
}

/** A record counts only while it has not expired. */
export function isActive(record, now = Date.now()) {
    if (!record || !record.expires_at) return false;
    const t = Date.parse(record.expires_at);
    return Number.isFinite(t) && t > now;
}

// ──────────────────────────────────────────────────────────────────────
// Storage — instance_config, one JSON row per flag
// ──────────────────────────────────────────────────────────────────────

function configKey(flagKey) {
    return `${CONFIG_PREFIX}${flagKey}`;
}

function readRecord(db, flagKey) {
    const row = db.prepare('SELECT value FROM instance_config WHERE key = ?').get(configKey(flagKey));
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
}

/**
 * Create (or replace) a break-glass window for one flag.
 * Throws on any validation failure — the caller maps that to a 400.
 */
export function createBreakGlass(db, flagKey, { reason, expiresAt, createdBy, now = Date.now() } = {}) {
    const flag = getFlag(flagKey);
    if (!flag) throw new Error(`unknown enforcement flag: ${flagKey}`);
    if (typeof reason !== 'string' || reason.trim().length < MIN_REASON_LENGTH) {
        throw new Error(`reason must be at least ${MIN_REASON_LENGTH} characters`);
    }
    if (!createdBy) throw new Error('createdBy required');

    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs)) throw new Error('expires_at must be an ISO timestamp');
    if (expiresMs <= now) throw new Error('expires_at must be in the future');
    if (expiresMs - now > MAX_BREAK_GLASS_MS) {
        throw new Error('expires_at may be at most 72 hours from now');
    }

    const record = {
        id: ulid(),
        flag: flagKey,
        reason: reason.trim(),
        expires_at: new Date(expiresMs).toISOString(),
        created_by: createdBy,
        created_at: new Date(now).toISOString(),
    };
    db.prepare(`
        INSERT INTO instance_config (key, value, value_type, description, updated_at)
        VALUES (?, ?, 'json', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(configKey(flagKey), JSON.stringify(record), `Break-glass: enforcement off for ${flagKey}`);
    return record;
}

/** The ACTIVE record for a flag, or null. Expired rows are swept on read. */
export function getBreakGlass(db, flagKey, now = Date.now()) {
    const record = readRecord(db, flagKey);
    if (!record) return null;
    if (!isActive(record, now)) {
        // Self-healing: an expired window is indistinguishable from no window,
        // so drop the row rather than leave a misleading one in the store.
        try { db.prepare('DELETE FROM instance_config WHERE key = ?').run(configKey(flagKey)); } catch { /* noop */ }
        return null;
    }
    return record;
}

/** Every ACTIVE record, keyed by flag. */
export function listBreakGlass(db, now = Date.now()) {
    const out = {};
    for (const key of ENFORCEMENT_FLAG_KEYS) {
        const record = getBreakGlass(db, key, now);
        if (record) out[key] = record;
    }
    return out;
}

/** Remove a break-glass window. Returns the record that was cleared, or null. */
export function clearBreakGlass(db, flagKey) {
    const existing = readRecord(db, flagKey);
    db.prepare('DELETE FROM instance_config WHERE key = ?').run(configKey(flagKey));
    return existing;
}

/**
 * The full posture of every flag, for the admin surface: what the environment
 * asks for, what is actually enforced, and any break-glass in force.
 */
export function enforcementStatus(db, { env = process.env, now = Date.now() } = {}) {
    return ENFORCEMENT_FLAGS.map((flag) => {
        const breakGlass = getBreakGlass(db, flag.key, now);
        const verdict = resolveEnforcement({ flag, env, breakGlass });
        return {
            key: flag.key,
            name: flag.name,
            service: flag.service,
            description: flag.description,
            defaults_off: !!flag.defaultsOff,
            env_enforced: verdict.envEnforced,
            enforced: verdict.enforced,
            forced_on: verdict.forced,
            reason: verdict.reason,
            break_glass: breakGlass,
        };
    });
}
