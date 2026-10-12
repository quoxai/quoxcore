/**
 * User Preferences — Server-Persistent Sync Layer
 *
 * Two-tier write-through cache:
 * 1. GLOBAL (users.preferences_json) — user-level, same across all orgs
 *    Theme, extensions, assistant, layout, activity filters
 * 2. ORG-SCOPED (org_memberships.preferences_json) — per-org user prefs
 *    Plugin configs, bastion, custom tools, alerts, WSM, style, actions
 *
 * On login, hydrateFromServer() populates localStorage from both tiers.
 * On change, syncPreferenceToServer() / syncOrgPreferenceToServer() queue appropriately.
 *
 * This module uses direct fetch (not AuthContext) to avoid circular imports.
 * Auth cookies (httpOnly) are sent automatically via credentials: 'include'.
 */

import { queueSync, queueOrgSync } from './serverSyncQueue';

const AUTH_API = '/api/auth';

// GLOBAL namespace map: localStorage key <-> server preferences key
// These are user-level preferences, same across all orgs
const NAMESPACE_MAP = {
    'quox-extensions-state': 'extensions',
    'quox-settings': 'settings',
    'quox-voice-settings': 'voiceSettings',
    'quox-ui-settings': 'uiSettings',
    'quox-chat-workspace': 'chatWorkspace',
    'quox-assistant': 'defaultAssistant',
    'quox-terminal-workspaces': 'terminalWorkspaces',
    'quox-layout-state': 'layoutState',
    'quox_activity_filters': 'activityFilters',
    'quox-router-config': 'routerConfig',
    'quox-custom-prompts': 'customPrompts',
    'quox-use-streaming': 'useStreaming',
    'quox-prompt-drafts': 'promptDrafts',
    'quox-prompt-history': 'promptHistory',
    'quox-workflow-drafts': 'workflowDrafts',
    'quox-viz-config': 'vizConfig',
    'quox-viz-studio-config': 'vizStudioConfig',
    'quox-request-patterns': 'requestPatterns',
    // 'quox-belief-memory' removed (QMH2-CONSOLIDATION) — beliefMemory.js now
    // write-throughs to the memory service's identity_blobs store (namespace
    // 'beliefs', org+user scoped) instead of this global, non-org-scoped
    // auth-prefs duplication. See beliefMemory.js for the cross-org key fix.
    //
    // D2-PROMOTION-PIPELINE: memoryPromotion.js now write-throughs to the
    // memory service's identity_blobs store (namespace 'promotion', org+user
    // scoped) instead of this global auth-prefs duplication. Writes here
    // have been retired (memoryPromotion.js no longer calls queueSync). This
    // entry is kept for ONE release as HYDRATE-ONLY backfill: a fresh
    // browser whose sole surviving copy of promotion data lives in
    // users.preferences_json still gets the legacy global key written on
    // login, which memoryPromotion.js's getConsolidated() then migrates
    // into the org-scoped cache and write-throughs onward to identity_blobs.
    // Remove this entry in the next release.
    'quox-memory-promotion': 'memoryPromotion',
    'quox-entity-overrides': 'entityOverrides',
    'aocl_layer_plugins': 'aoclLayerPlugins',
    'aocl-signature-state': 'aoclSignatureState',
    'quox_incident_log': 'incidentLog',
    'quox-safety-state': 'safetyState',
    // 'quox-license' removed — licensing is now server-only via instance_config (Stream LIC)
    'quox-router-education': 'routerEducation',
    'quox-router-feedback': 'routerFeedback',
    'quox-terminal-chat-models': 'terminalChatModels',
    'topology-visualizer-settings': 'topologySettings',
    'quox-terminal-modes': 'terminalModes',
    // QUOXPERTICUS-REVISIT N1: "Meet your resident" home-view card dismissal.
    // Server-side is the source of truth (zero-tolerance persistence rule);
    // localStorage is only the fast-read cache hydrateFromServer() below
    // writes into on login, same as every other namespace in this map.
    'quox-quoxperticus-card-dismissed': 'quoxperticusCardDismissed',
    // QUOXSOUND-P1: per-user Sound Profile (profile, volume, layer toggles).
    // Server is the source of truth; quoxSound.js reads this cache key.
    'quox-sound-profile': 'soundProfile',
    'quox-desktop-notify': 'desktopNotify',
};

// ORG-SCOPED namespace map: orgScopedStorage keys <-> server org preferences key
// These are per-org user preferences, stored in org_memberships.preferences_json
// localStorage keys are dynamic: quox_${orgId}_${suffix} or quox_${orgId}_${userId}_${suffix}
const ORG_NAMESPACE_MAP = {
    'plugin-configs': 'pluginConfigs',
    'bastion-config': 'bastionConfig',
    'custom-tools': 'customTools',
    'alert-rules': 'alertRules',
    'alert-state': 'alertState',
    'custom-services': 'customServices',
    // 'wsm'/'style'/'behavior'/'failure-mem' removed (QMH2-CONSOLIDATION) —
    // these now write through to the memory service's identity_blobs store
    // (namespaces 'working_set', 'style' (combined profile+behavior), and
    // 'failures') instead of this auth-prefs duplication. See
    // workingSetMemory.js / styleEngine.js / failureMemory.js.
    'assistant-overrides': 'assistantOverrides',
    'actions': 'actions',
    'files-settings': 'fileSettings',
    'files-meta': 'fileMeta',
    'files-folders': 'fileFolders',
    'compliance-reports': 'complianceReports',
    'compliance-jobs': 'complianceJobs',
    'installed-tools': 'installedTools',
};

// Reverse maps
const REVERSE_MAP = Object.fromEntries(
    Object.entries(NAMESPACE_MAP).map(([lsKey, nsKey]) => [nsKey, lsKey])
);

const ORG_REVERSE_MAP = Object.fromEntries(
    Object.entries(ORG_NAMESPACE_MAP).map(([suffix, nsKey]) => [nsKey, suffix])
);

/**
 * Read CSRF token from cookie (mirrors AuthContext.getCsrfToken)
 */
function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
    return match ? match[1] : null;
}

/**
 * Authenticated GET (uses httpOnly cookies + CSRF)
 */
async function authGet(url) {
    const headers = {};
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;

    const response = await fetch(url, {
        credentials: 'include',
        headers,
    });
    if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
    return response.json();
}

/**
 * Authenticated PATCH (uses httpOnly cookies + CSRF)
 */
async function authPatch(url, body) {
    const headers = { 'Content-Type': 'application/json' };
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;

    const response = await fetch(url, {
        method: 'PATCH',
        credentials: 'include',
        headers,
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`PATCH ${url} returned ${response.status}`);
    return response.json();
}

/**
 * Hydrate localStorage from GLOBAL server preferences.
 * Called once on login/page-load when user.preferences is available.
 *
 * @param {Object} serverPreferences - The preferences object from GET /api/auth/me
 */
export function hydrateFromServer(serverPreferences) {
    if (!serverPreferences || typeof serverPreferences !== 'object') return;

    let hydrated = false;

    for (const [namespace, localStorageKey] of Object.entries(REVERSE_MAP)) {
        const serverValue = serverPreferences[namespace];
        const isEmpty = serverValue === undefined || serverValue === null ||
            (typeof serverValue === 'object' && Object.keys(serverValue).length === 0);

        try {
            // Safety state: server wins always — clear local if server is empty
            if (localStorageKey === 'quox-safety-state') {
                if (!isEmpty && typeof serverValue === 'object') {
                    localStorage.setItem(localStorageKey, JSON.stringify(serverValue));
                    hydrated = true;
                } else if (namespace in serverPreferences) {
                    const hadLocalSafety = localStorage.getItem(localStorageKey) !== null;
                    localStorage.removeItem(localStorageKey);
                    hydrated = hadLocalSafety || hydrated;
                }
                continue;
            }

            // Skip empty values for all other namespaces
            if (isEmpty) continue;

            // Extensions state: merge server + local so we never lose local activations
            if (localStorageKey === 'quox-extensions-state' && typeof serverValue === 'object') {
                const localRaw = localStorage.getItem(localStorageKey);
                const localState = localRaw ? JSON.parse(localRaw) : {};
                const merged = { ...localState, ...serverValue };
                localStorage.setItem(localStorageKey, JSON.stringify(merged));
            }
            // Default: server wins (standard overwrite)
            else if (typeof serverValue === 'string') {
                localStorage.setItem(localStorageKey, serverValue);
            } else {
                localStorage.setItem(localStorageKey, JSON.stringify(serverValue));
            }
            hydrated = true;
        } catch (err) {
            console.warn(`[UserPrefs] Failed to hydrate ${localStorageKey}:`, err.message);
        }
    }

    // Hydrate layout state (stored as individual keys, not a single blob)
    if (serverPreferences.layoutState && typeof serverPreferences.layoutState === 'object') {
        try {
            const { hydrateLayoutFromServer } = require('./layoutPersistence');
            hydrateLayoutFromServer(serverPreferences.layoutState);
            hydrated = true;
        } catch (err) {
            console.warn('[UserPrefs] Failed to hydrate layout:', err.message);
        }
    }

    if (hydrated) {
        window.dispatchEvent(new CustomEvent('quox-settings-change'));
        window.dispatchEvent(new Event('storage'));
        console.log('[UserPrefs] Hydrated localStorage from server preferences');
    }
}

/**
 * Hydrate localStorage from ORG-SCOPED server preferences.
 * Called when org context is loaded (after login or on org switch).
 *
 * @param {Object} orgPreferences - The org membership preferences object
 * @param {string} orgId - Current org ID
 * @param {string} userId - Current user ID
 */
export function hydrateOrgPreferences(orgPreferences, orgId, userId) {
    if (!orgPreferences || typeof orgPreferences !== 'object') return;
    if (!orgId) return;

    let hydrated = false;

    for (const [namespace, suffix] of Object.entries(ORG_REVERSE_MAP)) {
        const serverValue = orgPreferences[namespace];
        if (serverValue === undefined || serverValue === null) continue;
        if (typeof serverValue === 'object' && Object.keys(serverValue).length === 0) continue;

        try {
            // Determine if this is personal-scoped (needs userId) or org-scoped
            // ('wsm'/'style'/'behavior'/'failure-mem' removed — QMH2-CONSOLIDATION,
            // no longer in ORG_NAMESPACE_MAP/ORG_REVERSE_MAP so this loop never
            // reaches them, but kept the list free of dead entries)
            const personalSuffixes = ['assistant-overrides', 'actions', 'files-settings', 'files-meta', 'files-folders'];
            const key = personalSuffixes.includes(suffix)
                ? `quox_${orgId}_${userId}_${suffix}`
                : `quox_${orgId}_${suffix}`;

            const value = typeof serverValue === 'string' ? serverValue : JSON.stringify(serverValue);
            localStorage.setItem(key, value);
            hydrated = true;
        } catch (err) {
            console.warn(`[UserPrefs] Failed to hydrate org pref ${namespace}:`, err.message);
        }
    }

    if (hydrated) {
        window.dispatchEvent(new CustomEvent('quox-settings-change'));
        console.log(`[UserPrefs] Hydrated ${Object.keys(orgPreferences).length} org-scoped preference(s)`);
    }
}

/**
 * Save a GLOBAL preference namespace to the server via the sync queue.
 * @param {string} namespace - Server namespace key (e.g., 'extensions', 'settings')
 * @param {*} value - The value to store for this namespace
 */
export function syncPreferenceToServer(namespace, value) {
    queueSync(namespace, value);
}

/**
 * Save an ORG-SCOPED preference to the server via the org sync queue.
 * @param {string} namespace - Server namespace key (e.g., 'pluginConfigs', 'bastionConfig')
 * @param {*} value - The value to store
 */
export function syncOrgPreferenceToServer(namespace, value) {
    queueOrgSync(namespace, value);
}

/**
 * Resolve a localStorage key to its server namespace.
 * @param {string} localStorageKey
 * @returns {string|null} server namespace or null if not mapped
 */
export function getServerNamespace(localStorageKey) {
    return NAMESPACE_MAP[localStorageKey] || null;
}

/**
 * Get the full namespace map (for hydration registration).
 * @returns {Object} { localStorageKey: serverNamespace }
 */
export function getNamespaceMap() {
    return { ...NAMESPACE_MAP };
}

/**
 * Get the org namespace map.
 * @returns {Object} { orgScopedSuffix: serverNamespace }
 */
export function getOrgNamespaceMap() {
    return { ...ORG_NAMESPACE_MAP };
}

/**
 * Fetch server preferences directly (for manual refresh).
 *
 * @returns {Promise<Object|null>} preferences object or null on failure
 */
export async function fetchServerPreferences() {
    try {
        const data = await authGet(`${AUTH_API}/me`);
        return data?.user?.preferences || null;
    } catch (err) {
        console.warn('[UserPrefs] Failed to fetch server preferences:', err.message);
        return null;
    }
}
