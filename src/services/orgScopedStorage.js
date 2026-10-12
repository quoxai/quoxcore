/**
 * Org-Scoped localStorage Wrapper
 *
 * Provides org-isolated and user-isolated localStorage keys.
 * Prevents cross-org data leakage for multi-org users.
 *
 * Two scoping levels:
 * - Org-scoped: shared within an org (plugin configs, files, alerts, tools)
 * - Personal: per-user within an org (WSM, style, voice, UI settings)
 *
 * Call setStorageContext(orgId, userId) when org loads or switches.
 * Services use orgGet/orgSet or personalGet/personalSet instead of
 * raw localStorage.
 */

import { syncOrgPreferenceToServer, getOrgNamespaceMap } from './userPreferences';

let _orgId = null;
let _userId = null;

/**
 * Called by WorkspaceContext on org load/switch.
 * Fires 'quox-org-switch' exactly once per REAL org change — never on the
 * initial null/undefined → orgId set (that's a first load, not a switch),
 * and never twice for the same transition. quox#353: this guard is the
 * production fix, not the tests — React 19 strict mode can invoke effects
 * (and therefore this function) twice with the same arguments, and the
 * event must stay idempotent under that regardless of test assertions.
 * AuthGatedBackgroundServices (App.jsx) already hydrates org-scoped state
 * directly once on auth, so listeners never needed the initial-load fire —
 * they only care about `event.detail.previousOrgId` being a real prior org.
 */
export function setStorageContext(orgId, userId) {
    const previousOrgId = _orgId;
    _orgId = orgId;
    _userId = userId;
    const isRealSwitch = previousOrgId != null && previousOrgId !== orgId;
    if (isRealSwitch) {
        window.dispatchEvent(new CustomEvent('quox-org-switch', {
            detail: { previousOrgId, newOrgId: orgId }
        }));
    }
}

export function getStorageOrgId() { return _orgId; }
export function getStorageUserId() { return _userId; }

// ============================================================================
// Key Builders
// ============================================================================

/**
 * Org-scoped key: shared within an org
 * Falls back to raw baseKey if no org context (pre-auth)
 */
export function getOrgKey(baseKey) {
    if (!_orgId) return baseKey;
    return `quox_${_orgId}_${baseKey}`;
}

/**
 * Personal key: per-user within an org
 * Falls back to raw baseKey if no context
 */
export function getPersonalKey(baseKey) {
    if (!_orgId || !_userId) return baseKey;
    return `quox_${_orgId}_${_userId}_${baseKey}`;
}

// ============================================================================
// Org-Scoped Convenience Wrappers
// ============================================================================

export function orgGet(baseKey) {
    return localStorage.getItem(getOrgKey(baseKey));
}

export function orgSet(baseKey, value) {
    localStorage.setItem(getOrgKey(baseKey), value);
    // Auto-sync to server if this key is in the org namespace map
    const orgMap = getOrgNamespaceMap();
    if (orgMap[baseKey]) {
        try {
            const parsed = typeof value === 'string' ? JSON.parse(value) : value;
            syncOrgPreferenceToServer(orgMap[baseKey], parsed);
        } catch { /* fire-and-forget */ }
    }
}

export function orgRemove(baseKey) {
    localStorage.removeItem(getOrgKey(baseKey));
}

// ============================================================================
// Personal-Scoped Convenience Wrappers
// ============================================================================

export function personalGet(baseKey) {
    return localStorage.getItem(getPersonalKey(baseKey));
}

export function personalSet(baseKey, value) {
    localStorage.setItem(getPersonalKey(baseKey), value);
    // Auto-sync to server if this key is in the org namespace map
    const orgMap = getOrgNamespaceMap();
    if (orgMap[baseKey]) {
        try {
            const parsed = typeof value === 'string' ? JSON.parse(value) : value;
            syncOrgPreferenceToServer(orgMap[baseKey], parsed);
        } catch { /* fire-and-forget */ }
    }
}

export function personalRemove(baseKey) {
    localStorage.removeItem(getPersonalKey(baseKey));
}

// ============================================================================
// JSON Helpers (most services store JSON)
// ============================================================================

export function orgGetJSON(baseKey, fallback = null) {
    try {
        const raw = orgGet(baseKey);
        return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
}

export function orgSetJSON(baseKey, value) {
    orgSet(baseKey, JSON.stringify(value));
}

export function personalGetJSON(baseKey, fallback = null) {
    try {
        const raw = personalGet(baseKey);
        return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
}

export function personalSetJSON(baseKey, value) {
    personalSet(baseKey, JSON.stringify(value));
}
