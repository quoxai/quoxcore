/**
 * VAULT-P5.F — Org-scoped lease enforcement mode (STREAM_VAULT_AUDIT_PLAN_v2.md
 * §4 "AI-native dynamic leasing", STREAM_VAULT_AUDIT_PLAN.md §4.4 F4).
 *
 * A 3-state flag `vault.lease_enforcement` = off | advisory | enforced,
 * stored inside the org's existing `settings_json` blob (the same
 * generic-JSON org-settings pattern routes/orgs.js PATCH /:orgId already
 * uses — no new table). DEFAULT is always `advisory` for any org that has
 * never set the flag, or set it to something unrecognised: a missing or
 * malformed value must NEVER be interpreted as `enforced` (fail-safe, not
 * fail-open-to-enforcement) and the platform never auto-flips an org to
 * `enforced` — that is always an explicit, deliberate call.
 *
 *   off       — lease system fully bypassed for this org, no gating, no audit.
 *   advisory  — release proceeds even without an active lease, but a
 *               `secret.access.lease_missing` audit event is written.
 *   enforced  — release is refused (403 `lease_required`) without an active
 *               lease, and a `secret.access.lease_denied` audit event is written.
 */

import { getDb } from '../db/index.js';

export const LEASE_ENFORCEMENT_MODES = Object.freeze(['off', 'advisory', 'enforced']);
export const DEFAULT_LEASE_ENFORCEMENT_MODE = 'advisory';

/**
 * @param {string|null|undefined} orgId
 * @returns {'off'|'advisory'|'enforced'}
 */
export function getLeaseEnforcementMode(orgId) {
    if (!orgId) return DEFAULT_LEASE_ENFORCEMENT_MODE;
    try {
        const row = getDb().prepare('SELECT settings_json FROM orgs WHERE id = ?').get(orgId);
        if (!row?.settings_json) return DEFAULT_LEASE_ENFORCEMENT_MODE;
        const settings = JSON.parse(row.settings_json);
        const mode = settings?.vault?.lease_enforcement;
        return LEASE_ENFORCEMENT_MODES.includes(mode) ? mode : DEFAULT_LEASE_ENFORCEMENT_MODE;
    } catch {
        // Malformed settings_json or DB error — fail safe to the default,
        // never fail open into 'enforced' (which would surprise-403 callers)
        // and never silently drop to 'off' (which would surprise-bypass audit).
        return DEFAULT_LEASE_ENFORCEMENT_MODE;
    }
}

/**
 * @param {string} orgId
 * @param {'off'|'advisory'|'enforced'} mode
 * @returns {'off'|'advisory'|'enforced'}
 */
export function setLeaseEnforcementMode(orgId, mode) {
    if (!orgId) throw new Error('orgId is required');
    if (!LEASE_ENFORCEMENT_MODES.includes(mode)) {
        throw new Error(`invalid lease_enforcement mode: ${mode} (must be one of ${LEASE_ENFORCEMENT_MODES.join('|')})`);
    }
    const db = getDb();
    const row = db.prepare('SELECT settings_json FROM orgs WHERE id = ?').get(orgId);
    if (!row) throw new Error('org not found');
    let settings = {};
    try {
        settings = row.settings_json ? JSON.parse(row.settings_json) : {};
    } catch {
        settings = {};
    }
    settings.vault = { ...(settings.vault || {}), lease_enforcement: mode };
    db.prepare('UPDATE orgs SET settings_json = ? WHERE id = ?').run(JSON.stringify(settings), orgId);
    return mode;
}

export default {
    LEASE_ENFORCEMENT_MODES,
    DEFAULT_LEASE_ENFORCEMENT_MODE,
    getLeaseEnforcementMode,
    setLeaseEnforcementMode,
};
