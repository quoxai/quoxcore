// services/shared/envProjection.cjs — SETEC S2.
//
// Pure projection of the env registry against a process env, for the
// "Instance settings" admin page. SECURITY: this is an ALLOWLIST. A value is
// emitted only when every check below passes; everything else is reported as
// set / not set and the value is never copied into the row, not even a
// prefix. Never log values from here.
'use strict';

// Names that must never have their value shown, whatever the classification.
const SENSITIVE_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|PRIVATE|AUTH|COOKIE|SALT|DSN/i;
const SHOWN_CLASSIFICATIONS = new Set(['instance', 'infra']);
const MAX_SHOWN_LENGTH = 300;

// URL userinfo anywhere in the value: scheme://[user[:pass]]@host. Scans every
// "://" occurrence so nested creds (a URL inside a query string, comma lists)
// are caught. A bare "@" with no scheme is also rejected when it sits before a
// host-ish tail, which catches "user:pass@host:5432" style strings.
const URL_USERINFO_RE = /:\/\/[^\s/?#]*@/;
const BARE_USERINFO_RE = /(^|[\s,;])[^\s/@:,;]+:[^\s/@,;]+@[^\s/@,;]+/;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(\.[A-Za-z0-9_-]*)?/;
const BLOB_RE = /[A-Za-z0-9+/_=-]{41,}/;
const PEM_RE = /-----BEGIN [A-Z ]+-----/;

function valueLooksSafe(value) {
    if (typeof value !== 'string') return false;
    if (value.length > MAX_SHOWN_LENGTH) return false;
    // Decode once so percent-encoded "@" / "://" cannot sneak creds past us.
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { /* keep raw */ }
    for (const v of [value, decoded]) {
        if (URL_USERINFO_RE.test(v)) return false;
        if (BARE_USERINFO_RE.test(v)) return false;
        if (JWT_RE.test(v)) return false;
        if (PEM_RE.test(v)) return false;
    }
    // A single long unbroken base64-ish run (>40 chars) is treated as a blob.
    // Filesystem paths are split on "/" first so long absolute paths pass.
    for (const seg of value.split(/[\s/:,;]+/)) {
        if (seg.length > 40 && BLOB_RE.test(seg)) return false;
    }
    return true;
}

function mayShowValue(entry, value) {
    if (!entry || !SHOWN_CLASSIFICATIONS.has(entry.classification)) return false;
    if (SENSITIVE_NAME_RE.test(String(entry.name || ''))) return false;
    return valueLooksSafe(value);
}

/**
 * @param {Array} registry   ENV_REGISTRY entries
 * @param {object} env       process env (or a fixture)
 * @param {{service?: string}} [opts] service = the service whose env this is.
 *   Only entries that list that service in `services` are projected; others are
 *   handled by the caller (honest "read by X, not reported yet").
 */
function projectEnv(registry, env, opts = {}) {
    const service = opts.service || null;
    const rows = [];
    for (const entry of registry || []) {
        if (!entry || !entry.name) continue;
        const services = Array.isArray(entry.services) ? entry.services : [];
        if (service && !services.includes(service)) continue;
        const raw = env ? env[entry.name] : undefined;
        const isSet = raw !== undefined && raw !== null && raw !== '';
        const row = {
            name: entry.name,
            classification: entry.classification,
            services,
            surface: entry.surface || null,
            note: entry.note || '',
            isSet,
            shown: 'set-only',
            source: isSet ? 'env' : 'unset',
        };
        if (isSet && mayShowValue(entry, String(raw))) {
            row.shown = 'value';
            row.value = String(raw);
        }
        rows.push(row);
    }
    return rows;
}

// Registry entries the Instance settings page renders: non-secret, non-user.
function surfaceEntries(registry) {
    return (registry || []).filter((e) => e && SHOWN_CLASSIFICATIONS.has(e.classification));
}

module.exports = {
    SENSITIVE_NAME_RE,
    valueLooksSafe,
    mayShowValue,
    projectEnv,
    surfaceEntries,
};
