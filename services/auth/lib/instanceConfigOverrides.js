/**
 * VAULT-INTEG P17 — instance_config-first reads for the class-B deploy
 * settings the setup wizard now writes (routes/setup.js `/config`
 * `appBaseUrl` / `corsOrigins` / `cookieSecure` / `matrixServerName`).
 *
 * NO-ENV-ONLY-CONFIG: these were env-only (COOKIE_SECURE, CORS_ORIGINS,
 * MATRIX_SERVER_NAME, APP_BASE_URL) until the wizard grew a surface for
 * them. Every consumer below reads instance_config first; an instance that
 * has never touched the wizard (or an existing instance mid-upgrade) falls
 * back to its pre-P17 env-derived value unchanged.
 *
 * Each call site keeps its own env-fallback formula (they were not
 * identical before this file existed — see server.js's `isHttps` vs
 * accessTokenCookie.js's COOKIE_SECURE default — and reconciling that is
 * out of scope here), so this module only ever answers "is there an
 * instance_config override for this key, and if so what is it".
 */

import { getDb } from '../db/index.js';

/**
 * @param {string} key instance_config row key
 * @returns {string|null} the stored string value, or null if unset/unreadable
 */
export function readInstanceConfigValue(key) {
    try {
        const db = getDb();
        const row = db.prepare('SELECT value FROM instance_config WHERE key = ?').get(key);
        return row?.value ?? null;
    } catch {
        // DB not ready (e.g. very early boot) — caller falls back to env.
        return null;
    }
}

/**
 * @param {string} key instance_config row key expected to hold 'true'/'false'
 * @returns {boolean|null} the override, or null if unset/not a boolean string
 */
export function readInstanceConfigBoolean(key) {
    const value = readInstanceConfigValue(key);
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
}

/**
 * VAULT-INTEG P17: appBaseUrl written by the wizard ('app_base_url') wins
 * over APP_BASE_URL for email links (verify-email, invite, org-switch).
 * Same env-fallback formula every call site already used.
 */
export function resolveAppBaseUrl() {
    return readInstanceConfigValue('app_base_url') || process.env.APP_BASE_URL || 'http://localhost:3000';
}

export default { readInstanceConfigValue, readInstanceConfigBoolean, resolveAppBaseUrl };
