/**
 * Third-Party Plugin Host
 *
 * Manages the lifecycle of third-party (.quoxplugin) plugins:
 *   - Install: extract ZIP, validate manifest, verify signature, store in IndexedDB
 *   - Activate: inject ESM bundle + CSS, wire routes and sidebar items
 *   - Deactivate: remove injected scripts/styles, unregister routes/nav
 *   - Uninstall: deactivate + remove from IndexedDB + cleanup storage
 *
 * Plugins register themselves via window.__quoxPluginRegister() which is set up
 * by initPluginHost(). Shared deps (React, ReactDOM, ReactRouterDOM) are exposed
 * on window.__quoxSharedDeps.
 */

import React from 'react';
// SDK-DX: shared with plugins so their compiled JSX uses the HOST's runtime.
// A plugin that bundles its own react-jsx-runtime pins the React internals of
// whatever React IT was built against (18's ReactCurrentOwner is gone in 19)
// and crashes on activation. quox-plugin-vite ≥0.1.1 externalises
// react/jsx-runtime to window.__quoxSharedDeps.ReactJSXRuntime.
import * as ReactJSXRuntime from 'react/jsx-runtime';

// PSDK-2: Import shared components for plugin access
import { AgentChatSidebar } from '../components/chat/AgentChatSidebar';
import { AgentChatPanel } from '../components/chat/AgentChatPanel';
import { GlassPanel, GlassPill, GlassTabBar, SectionHeader, ProgressRing, Sparkline, GlassSkeleton, GlassError, COLORS, STATUS_COLORS, PROTOCOL_COLORS, M, F } from '../components/compliance/glass-primitives';
import MarkdownContent from '../components/ui/MarkdownContent';
import ReactDOM from 'react-dom/client';
import * as ReactRouterDOM from 'react-router-dom';
// LL-7: shared with bundles so a bundled view consumes the HOST's context
// instances. React context identity is per-module-instance, so a bundle that
// compiled its own copy of these modules would call useWorkspace()/useAuth()
// against a context the host's providers never fill, and throw inside the
// host's own provider tree. vite.plugin.config.mjs resolves every spelling of
// these two imports to a shim that reads these namespaces back off
// window.__quoxSharedDeps. Same one-host-one-instance rule as React itself.
import * as WorkspaceContextModule from '../contexts/WorkspaceContext';
import * as AuthContextModule from '../contexts/AuthContext';
import { registerPluginNavItems, unregisterPluginNavItems } from '../config/navRegistry';
import { registerPluginRoute, unregisterPluginRoutes } from '../config/routeRegistry';
import { registerCapabilityPanel, unregisterCapabilityPanel, getCapabilityPanel } from '../config/capabilityPanelRegistry';
import { installPluginApi, uninstallPluginApi } from './pluginApi';
// QUOXTRUST F2 — untrusted (non-official) plugins run ISOLATED in a sandboxed,
// opaque-origin iframe via the frame host, NEVER as a <script> in the parent document.
import { createElement } from 'react';
import { createPluginFrame, createHostMediator } from './pluginFrameHost';
import { registerFrame, getPluginFrame, frameHolder, removeFrame } from './pluginFrameRegistry';
import PluginFrameView from '../components/plugins/PluginFrameView.jsx';
// LL-7: root-route privilege is earned by a verified Quox signature over the
// manifest, never by the manifest's own `official` flag.
import { isOfficialInstall } from './officialPluginSignature';
import { isGovernedPlugin, isPluginLicensed } from './licenseValidator';
// LL-7 licenseValidator share: the full module namespace, so any bundled view
// spelling `import { isPluginLicensed } from '../services/licenseValidator'`
// resolves (via vite.plugin.config.mjs sharedHostContexts) to the HOST's single
// instance. licenseValidator keeps its entitlement cache in module-scope
// singletons filled only by the core app's setEntitlements(); a bundle that
// compiled its own copy would read an empty cache and fail closed on every
// governed plugin's page ("Activate plugin") while PluginSettings showed it
// licensed — same one-host-one-instance rule as WorkspaceContext/AuthContext.
import * as LicenseValidatorModule from './licenseValidator';
// LI-OVERHAUL P11: stateful storage/sync singletons shared with bundles —
// see vite.plugin.config.mjs SHARED_CONTEXT_MODULES for why (a bundle's own
// copy silently drops org-preference server writes).
import * as ServerSyncQueueModule from './serverSyncQueue';
import * as OrgScopedStorageModule from './orgScopedStorage';
import { deepFreeze, frozenCloneReader } from './licenseReadOnlySurface';
import { scopePluginCss } from './pluginCssScope';
import { fireLifecycleHook as _fireLifecycleHook } from './pluginLifecycle';
import { csrfFetch } from '../utils/csrfFetch';
// PSDK-3: Agent registration for plugin-declared agents
import { agentRegistry } from '../config/agentRegistry';
import { assistants } from '../config/assistants';
import { registerPluginKeywords, unregisterPluginKeywords } from '../services/agentDelegator';
import { getHostAuthContext } from './hostAuthContext';
import { registerFramePluginAgent } from './pluginAgentRegistration';

// ── Constants ─────────────────────────────────────────────────────────────

const DB_NAME = 'quox-third-party-plugins';
const DB_VERSION = 1;
const STORE_NAME = 'plugins';
const REGISTER_TIMEOUT_MS = 10000;
const PLUGINS_API = '/api/orgs';

// ── State ─────────────────────────────────────────────────────────────────

/** Map<pluginId, { manifest, exports, blobUrl, scriptEl, styleEl }> */
const loadedPlugins = new Map();
let hostInitialised = false;

// ROUTE-REFRESH fix: whether the initial boot-time hydration of third-party
// plugins (loadInstalledPlugins) has settled. Plugin routes register
// asynchronously AFTER React's first render, so on a hard refresh of a
// /plugins/* URL the router's catch-all would fire before the route exists and
// bounce the user to home. The catch-all in App.jsx waits on this flag (and the
// 'quox-plugins-loaded' event) before redirecting a /plugins/* path.
let pluginsHydrated = false;

// QC-W13: what the boot hydration actually learned about entitlement, so a
// premium route stub can tell "org does not own this" (paywall) from "the
// answer has not arrived / failed" (spinner / error + Retry). Never paywall on
// an unknown answer.
//   listStatus: 'idle' (never ran) | 'no-org' | 'ok' | 'error'
//   pendingActivations: enabled plugin ids whose bundle activation has not settled
//   failedActivations: enabled plugin ids whose activation threw
let listStatus = 'idle';
const pendingActivations = new Set();
const failedActivations = new Set();

function emitHydrationState() {
    try { window.dispatchEvent(new CustomEvent('quox-plugins-state')); } catch { /* non-browser env */ }
}

/**
 * Entitlement/activation answer for one plugin id:
 * 'loading' | 'error' | 'entitled-pending' | 'not-entitled'.
 */
export function getPluginEntitlementState(pluginId) {
    if (listStatus === 'idle' || listStatus === 'no-org') return 'loading';
    if (listStatus === 'error') return 'error';
    if (failedActivations.has(pluginId)) return 'error';
    if (pendingActivations.has(pluginId)) return 'entitled-pending';
    if (installedList.some(p => p.pluginId === pluginId && p.enabled)) return 'entitled-pending';
    return 'not-entitled';
}

/** True once loadInstalledPlugins() has settled (success or failure). */
export function arePluginsHydrated() {
    return pluginsHydrated;
}

/** Mark boot-time plugin hydration complete and notify the router. Idempotent. */
export function markPluginsHydrated() {
    if (pluginsHydrated) return;
    pluginsHydrated = true;
    try {
        window.dispatchEvent(new CustomEvent('quox-plugins-loaded'));
    } catch { /* non-browser env */ }
}

/**
 * In-memory mirror of the server-side install list. Populated by
 * loadInstalledPlugins() on boot and kept in sync by install/uninstall.
 * Replaces the old localStorage 'quox-tp-installed' source — that key was the
 * primary cause of the PD-stream "plugins vanish" pattern.
 */
let installedList = [];

// ── IndexedDB helpers ─────────────────────────────────────────────────────

function openDB() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error('IndexedDB not available (private browsing or restricted environment)'));
            return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'pluginId' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function dbPut(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(record);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function dbGet(pluginId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(pluginId);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

async function dbDelete(pluginId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(pluginId);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function dbGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => { db.close(); resolve(req.result || []); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

async function dbClear() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

/**
 * Recovery hatch: wipe the local IndexedDB bundle cache. The server install
 * list is untouched — the next boot re-fetches every enabled plugin's bytes
 * fresh. Fixes the "stale/corrupt cached bundle keeps crashing on activation"
 * trap that a plain reload can't clear. Caller should reload after this.
 */
export async function clearPluginCache() {
    await dbClear();
    console.log('[PluginHost] Local plugin bundle cache cleared — reload to re-fetch from server');
}

// ── Server registry (PD-1) ───────────────────────────────────────────────
//
// Server is the source of truth for the install list. Browser state
// (IndexedDB / installedList) is a SHA-256-validated cache.

function getActiveOrgId() {
    try { return localStorage.getItem('current_org_id') || null; }
    catch { return null; }
}

// UI-2: re-hydrate plugins whenever the active org becomes available or
// switches. Without this, a fresh device pre-login has no current_org_id,
// the boot-time loadInstalledPlugins() call returns empty, and no further
// load happens — third-party plugins look "missing" until the user clears
// browser data and logs in twice. With the orgScopedStorage event now
// firing on initial set too (null → orgId), this listener catches the
// post-login transition and refetches.
if (typeof window !== 'undefined') {
    window.addEventListener('quox-org-switch', (event) => {
        const newOrgId = event?.detail?.newOrgId;
        if (!newOrgId) {
            // Org cleared (logout) — drop the in-memory list so next login
            // starts fresh. LL-7 C5: also tear down every loaded plugin via
            // the normal deactivate path (routes, nav, panels, script/style
            // elements) so the next account cannot run the previous
            // account's in-memory bundles.
            for (const pluginId of [...loadedPlugins.keys()]) {
                try {
                    deactivateThirdPartyPlugin(pluginId);
                } catch (err) {
                    console.warn(`[PluginHost] Teardown of ${pluginId} on org clear failed:`, err.message);
                }
            }
            installedList = [];
            return;
        }
        loadInstalledPlugins().catch(err => {
            console.warn('[PluginHost] Re-hydration after org change failed:', err.message);
        });
    });

    // NOTE (LL-7): a 'quox-entitlements-changed' listener that bulk-deactivated
    // every governed-but-unlicensed loaded plugin lived here and was REMOVED —
    // it fired on the normal login-time setEntitlements() broadcast and stripped
    // enabled-but-unlicensed plugins out of the sidebar entirely, so a user
    // could not even navigate to a plugin's page to see its "Activate" gate
    // (regression 2026-09-02). The correct reactive gating is per-page:
    // usePluginLicensed() re-checks isPluginLicensed on this same event and the
    // view renders its own gate. The sidebar keeps showing enabled plugins, as
    // before. The revocation fail-open for routeless capability panels (a loaded
    // panel staying usable after a mid-session revoke) is a deferred edge case;
    // it must NOT be closed by a listener that also removes navigable plugins.
}

async function apiList(orgId) {
    // PD-7: hit /me/plugins so the response is already filtered by
    // plugin_assignments visibility for the calling user. Admins still get
    // the full list via the original /plugins endpoint from the admin UI.
    const res = await fetch(`${PLUGINS_API}/${orgId}/me/plugins`, { credentials: 'include' });
    if (!res.ok) throw new Error(`list_failed status=${res.status}`);
    const json = await res.json();
    return json.plugins || [];
}

async function apiGetBundle(orgId, pluginId) {
    const res = await fetch(`${PLUGINS_API}/${orgId}/plugins/${pluginId}/bundle`, { credentials: 'include' });
    if (!res.ok) throw new Error(`bundle_fetch_failed status=${res.status}`);
    const bundleCode = await res.text();
    const bundleSha256 = res.headers.get('x-bundle-sha256') || null;
    // PD-8: verify the SHA-256 the server claims actually matches the bytes
    // we received. Mismatch means tampering or proxy corruption — refuse the
    // bundle rather than load potentially-modified code.
    if (bundleSha256) {
        const actual = await sha256Hex(bundleCode);
        if (actual !== bundleSha256) {
            throw new Error(`bundle_integrity_failed expected=${bundleSha256} actual=${actual}`);
        }
    }
    return {
        bundleCode,
        bundleSha256,
        cssLength: Number(res.headers.get('x-css-length') || 0),
    };
}

async function sha256Hex(text) {
    const buf = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function apiGetCss(orgId, pluginId) {
    const res = await fetch(`${PLUGINS_API}/${orgId}/plugins/${pluginId}/css`, { credentials: 'include' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`css_fetch_failed status=${res.status}`);
    return res.text();
}

async function apiInstall(orgId, { manifest, bundleCode, cssCode, signatureData }) {
    const body = {
        manifest,
        bundle_b64: btoa(unescape(encodeURIComponent(bundleCode))),
        css_b64: cssCode ? btoa(unescape(encodeURIComponent(cssCode))) : null,
        signature: signatureData || null,
    };
    const res = await csrfFetch(`${PLUGINS_API}/${orgId}/plugins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(json?.message || json?.error || `install_failed status=${res.status}`);
        err.status = res.status;
        err.code = json?.error;
        throw err;
    }
    return json.plugin;
}

async function apiMigrate(orgId, { manifest, bundleCode, cssCode, signatureData }) {
    const body = {
        manifest,
        bundle_b64: btoa(unescape(encodeURIComponent(bundleCode))),
        css_b64: cssCode ? btoa(unescape(encodeURIComponent(cssCode))) : null,
        signature: signatureData || null,
    };
    const res = await csrfFetch(`${PLUGINS_API}/${orgId}/plugins/migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(json?.message || json?.error || `migrate_failed status=${res.status}`);
        err.status = res.status;
        err.code = json?.error;
        throw err;
    }
    return json; // { plugin, migrated, reason? }
}

async function apiUninstall(orgId, pluginId) {
    const res = await csrfFetch(`${PLUGINS_API}/${orgId}/plugins/${pluginId}`, {
        method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
        throw new Error(`uninstall_failed status=${res.status}`);
    }
}

/**
 * PD-1 fix (PERSIST-TRUTH): persist the org-wide enabled/disabled flag via the
 * admin-gated PATCH route. Previously the UI toggle only flipped local/session
 * state (DOM injection + in-memory installedList) — the server's is_enabled
 * column never changed, so a disable reverted the moment loadInstalledPlugins()
 * next ran (new tab, new device, or a plain reload), and a non-admin's local
 * "disable" was silently discarded server-side.
 */
async function apiSetEnabled(orgId, pluginId, enabled) {
    const res = await csrfFetch(`${PLUGINS_API}/${orgId}/plugins/${pluginId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_enabled: enabled }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(json?.message || json?.error || `set_enabled_failed status=${res.status}`);
        err.status = res.status;
        err.code = json?.error;
        throw err;
    }
    return json.plugin;
}

function recordInstalled(pluginId, manifest, { enabled = true, bundleSha256 = null } = {}) {
    installedList = installedList.filter(p => p.pluginId !== pluginId);
    installedList.push({
        pluginId,
        name: manifest.name,
        version: manifest.version,
        author: manifest.author,
        enabled,
        installedAt: new Date().toISOString(),
        bundleSha256,
    });
}

function recordUninstalled(pluginId) {
    installedList = installedList.filter(p => p.pluginId !== pluginId);
}

function setPluginEnabled(pluginId, enabled) {
    const entry = installedList.find(p => p.pluginId === pluginId);
    if (entry) entry.enabled = enabled;
}

// ── Capability-panel registration privilege (LL-6d) ─────────────────────────

/**
 * Owner id for a register() call that fires OUTSIDE any activation window (e.g.
 * a bundle registering at module-load, before/without onActivate). It is
 * non-official and owns nothing, so it can never claim a reserved core key.
 */
const UNBOUND_CAPABILITY_OWNER = '__unbound__';

/**
 * The CapabilityPanels surface a bundle actually gets — an owner-bound wrapper,
 * never the raw registry. It records WHO is registering and whether they are an
 * OFFICIAL install (the same verified signal resolveRootRoutePrivilege uses for
 * root routes), so the registry can gate reserved core keys to official bundles
 * and refuse cross-owner overwrite/unregister.
 *
 * @param {string} pluginId
 * @param {boolean} official — the VERIFIED official status, not manifest.official
 * @returns {{register: Function, unregister: Function, get: Function}}
 */
export function makeCapabilityPanelsForPlugin(pluginId, official) {
    const ownerId = pluginId || UNBOUND_CAPABILITY_OWNER;
    return {
        register: (capabilityName, Component) =>
            registerCapabilityPanel(capabilityName, Component, { ownerId, official: official === true }),
        unregister: (capabilityName) =>
            unregisterCapabilityPanel(capabilityName, { ownerId }),
        get: (capabilityName) => getCapabilityPanel(capabilityName),
    };
}

/**
 * Run `fn` with window.__quoxSharedDeps.CapabilityPanels temporarily swapped for
 * a wrapper bound to this plugin's identity + official status, then restore the
 * default. onActivate / onDeactivate hooks call register()/unregister()
 * synchronously through the global surface (the shipped bundles do exactly
 * this), so a synchronous swap around the hook is enough — there is no await
 * inside the window for another activation to interleave.
 */
function withBoundCapabilityPanels(pluginId, official, fn) {
    const deps = typeof window !== 'undefined' ? window.__quoxSharedDeps : null;
    if (!deps) return fn();
    const previous = deps.CapabilityPanels;
    deps.CapabilityPanels = makeCapabilityPanelsForPlugin(pluginId, official);
    try {
        return fn();
    } finally {
        deps.CapabilityPanels = previous;
    }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Initialise the plugin host. Called once from main.jsx before first render.
 * Exposes shared deps and sets up the registration callback.
 */
export function initPluginHost() {
    if (hostInitialised) return;
    hostInitialised = true;

    // Expose shared dependencies for plugin bundles
    window.__quoxSharedDeps = {
        React,
        ReactDOM,
        ReactRouterDOM,
        ReactJSXRuntime,
        // LICENSE-LAUNCH LL-7 quoxbuild strip: a plugin whose whole UI is a
        // dev-suite capability panel (no route, no sidebar) registers it here,
        // from its onActivate hook. It has to come through the HOST rather than
        // the bundle importing ../config/capabilityPanelRegistry directly:
        // that module holds a Map in module scope, and a bundle that imported
        // it would compile a SECOND copy and register into a registry the
        // dashboard never reads. Same reason React is shared here.
        // LL-6d: NOT the raw registry. A bundle must never reach the privileged
        // register(), or a validly-signed but non-official community plugin
        // could register a reserved core key ('settings.local-inference',
        // 'dev.build', ...) and render inside genuine core Settings / the
        // dev-servers hub to phish. The default here is an UNBOUND, non-official
        // wrapper: any register() fired outside an activation window (e.g. at
        // bundle module-load) cannot claim a reserved key. During onActivate /
        // onDeactivate the host swaps this for a wrapper bound to the activating
        // plugin's id and its VERIFIED official status (see
        // makeCapabilityPanelsForPlugin + withBoundCapabilityPanels below).
        CapabilityPanels: makeCapabilityPanelsForPlugin(UNBOUND_CAPABILITY_OWNER, false),
        // LL-7: the full module namespaces (hook + provider + the context
        // object as default), so any import spelling a bundled view uses
        // resolves to the running dashboard's instance. Bundles CONSUME these:
        // mounting the re-exported provider inside a bundle would create
        // separate state, which is the wrong fix for the same symptom.
        WorkspaceContext: WorkspaceContextModule,
        AuthContext: AuthContextModule,
        // LL-7 SECURITY: entitlement cache is module-scope state in
        // licenseValidator.js; sharing the ONE populated instance is what fixes
        // the empty-copy gate. But a loaded plugin bundle is ordinary
        // same-origin code (PluginSandbox is a React wrapper, not JS
        // isolation), so exposing the FULL namespace would let any signed
        // community plugin call setEntitlements()/clearEntitlements()/the
        // license mutators off window.__quoxSharedDeps to falsify client-side
        // auth state (e.g. unlock a gated nav item, poison the host cache).
        // So this surface is READ-ONLY: only the pure readers are forwarded.
        // The build shim (vite.plugin.config.mjs) resolves the write/mutation
        // exports to a THROWING stub, so a bundle that calls a writer fails
        // loudly rather than silently no-op'ing against `undefined`. Keep this
        // list in sync with SHARED_CONTEXT_MODULES[licenseValidator].exports
        // (the read set) in vite.plugin.config.mjs.
        LicenseValidator: {
            // Primitive-return readers pass through unchanged (booleans/strings/null).
            isPluginLicensed: LicenseValidatorModule.isPluginLicensed,
            isGovernedPlugin: LicenseValidatorModule.isGovernedPlugin,
            getPluginTier: LicenseValidatorModule.getPluginTier,
            getCallerOrgId: LicenseValidatorModule.getCallerOrgId,
            getFirstLicenseId: LicenseValidatorModule.getFirstLicenseId,
            hasTier: LicenseValidatorModule.hasTier,
            getActiveQuoxMindTier: LicenseValidatorModule.getActiveQuoxMindTier,
            isThirdPartyPluginLicensed: LicenseValidatorModule.isThirdPartyPluginLicensed,
            isLicenseValid: LicenseValidatorModule.isLicenseValid,
            // LL-7 D1: object/array returns are LIVE cache references — hand
            // bundles a frozen deep clone so a mutation cannot flip the gate.
            getPluginLicenseDiagnosis: frozenCloneReader(LicenseValidatorModule.getPluginLicenseDiagnosis),
            getOrgBand: frozenCloneReader(LicenseValidatorModule.getOrgBand),
            getStoredLicense: frozenCloneReader(LicenseValidatorModule.getStoredLicense),
            getLicenseTiers: frozenCloneReader(LicenseValidatorModule.getLicenseTiers),
            getLicenseStatus: frozenCloneReader(LicenseValidatorModule.getLicenseStatus),
            getStoredPluginLicenses: frozenCloneReader(LicenseValidatorModule.getStoredPluginLicenses),
            // LL-7 D2: read-only tier data. Frozen deep clones so a bundle
            // cannot mutate the config getPluginTier()/hasTier() read back.
            PLUGIN_TIERS: deepFreeze(structuredClone(LicenseValidatorModule.PLUGIN_TIERS)),
            TIER_HIERARCHY: deepFreeze(structuredClone(LicenseValidatorModule.TIER_HIERARCHY)),
        },
        // LI-OVERHAUL P11: full module namespaces, mirroring WorkspaceContext /
        // AuthContext above. Bundles CONSUME the host's single stateful
        // instances (sync org context, storage org/user context); a bundled
        // copy has null state and silently drops server-side preference writes.
        ServerSyncQueue: ServerSyncQueueModule,
        OrgScopedStorage: OrgScopedStorageModule,
    };

    // PSDK-2: Expose Quox components for plugin UI
    window.__quoxGlass = {
        // Chat patterns (3 tiers)
        AgentChatSidebar,   // Lightweight sidebar chat
        AgentChatPanel,     // Full-featured multi-tab chat panel
        // AgentChatPage — TODO: full-screen chat (PSDK future phase)

        // Glass design system
        GlassPanel, GlassPill, GlassTabBar, SectionHeader,
        ProgressRing, Sparkline, GlassSkeleton, GlassError,

        // Design tokens
        COLORS, STATUS_COLORS, PROTOCOL_COLORS, M, F,

        // Content rendering
        MarkdownContent,
    };

    // Registration callback — plugins call this from their ESM bundle
    window.__quoxPluginRegister = (pluginId, exports) => {
        const pending = loadedPlugins.get(pluginId);
        if (pending) {
            pending.exports = exports;
            pending._resolve?.();
        } else {
            // Plugin registered before we expected it (race condition safety)
            loadedPlugins.set(pluginId, { exports });
        }
    };

    console.log('[PluginHost] Initialised — shared deps exposed, registration callback ready');
}

/**
 * Install a third-party plugin from a .quoxplugin ZIP file.
 *
 * @param {File} file - The .quoxplugin ZIP file
 * @returns {Promise<{success: boolean, manifest?: Object, error?: string, signatureStatus?: string}>}
 */
export async function installThirdPartyPlugin(file) {
    try {
        // Dynamic import JSZip (bundled with dashboard)
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync(file);

        // 1. Parse manifest.json
        const manifestFile = zip.file('manifest.json');
        if (!manifestFile) {
            return { success: false, error: 'No manifest.json found in plugin package' };
        }
        const manifest = JSON.parse(await manifestFile.async('string'));

        // Basic manifest validation
        if (!manifest.id || !manifest.name || !manifest.version) {
            return { success: false, error: 'Invalid manifest: id, name, and version are required' };
        }

        // Validate plugin ID format
        if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(manifest.id)) {
            return { success: false, error: 'Invalid plugin ID: must be lowercase alphanumeric with dashes, 3-64 chars' };
        }

        // Block reserved prefixes
        const reserved = ['core-', 'system-', 'quox-', 'admin-'];
        if (reserved.some(p => manifest.id.startsWith(p))) {
            return { success: false, error: `Plugin ID cannot start with reserved prefix: ${reserved.join(', ')}` };
        }

        // Deactivate existing version if reinstalling/updating
        if (loadedPlugins.has(manifest.id)) {
            deactivateThirdPartyPlugin(manifest.id);
        }

        // 2. Check signature
        let signatureStatus = 'unsigned';
        const sigFile = zip.file('signature.json');
        if (sigFile) {
            try {
                const sigData = JSON.parse(await sigFile.async('string'));
                // Basic structure check — full verification happens via pluginSignature.js
                if (sigData.signature && sigData.digest && sigData.algorithm === 'Ed25519') {
                    signatureStatus = 'signed';
                } else {
                    signatureStatus = 'invalid';
                }
            } catch {
                signatureStatus = 'invalid';
            }
        }

        // 3. Read bundle
        const bundleFile = zip.file('plugin.esm.js');
        if (!bundleFile) {
            return { success: false, error: 'No plugin.esm.js found in plugin package' };
        }
        const bundleCode = await bundleFile.async('string');

        // Size guard — well below the server's 5 MB JSON-body cap (route-local).
        if (bundleCode.length > 5 * 1024 * 1024) {
            return { success: false, error: 'Plugin bundle exceeds 5MB limit' };
        }

        // 4. Read optional CSS
        const cssFile = zip.file('plugin.css');
        const cssCode = cssFile ? await cssFile.async('string') : null;

        // 5. Read signature data
        const signatureData = sigFile ? JSON.parse(await sigFile.async('string')) : null;

        // 6. PD-1: write-through to server registry. Server is source of truth.
        const orgId = getActiveOrgId();
        if (!orgId) {
            return { success: false, error: 'No active org — install requires an authenticated org context' };
        }
        let serverInstall;
        try {
            serverInstall = await apiInstall(orgId, { manifest, bundleCode, cssCode, signatureData });
        } catch (err) {
            const msg = err?.code === 'already_installed'
                ? 'Plugin already installed for this org. Uninstall first or upgrade via PATCH.'
                : err?.code === 'insufficient_role'
                    ? 'Only org admins can install plugins.'
                    : (err?.message || 'install failed');
            return { success: false, error: msg };
        }

        // 7. Cache locally for fast activation. Keyed by pluginId; SHA-256 used
        // to invalidate against the server on subsequent boots.
        await dbPut({
            pluginId: manifest.id,
            manifest,
            bundleCode,
            cssCode,
            signatureData,
            signatureStatus,
            bundleSha256: serverInstall.bundle_sha256,
            installedAt: serverInstall.installed_at,
            // LL-7: the server already holds this install (apiInstall above
            // succeeded), so the record is not a legacy IndexedDB-only one.
            // Same reasoning as ensureCachedAndActivate below: a record the
            // server knows about must never be re-POSTed to /plugins/migrate.
            migrated_at: new Date().toISOString(),
            migrated_reason: 'server_installed',
        });

        recordInstalled(manifest.id, manifest, {
            enabled: !!serverInstall.is_enabled,
            bundleSha256: serverInstall.bundle_sha256,
        });

        // 8. PD-5: fire onInstall lifecycle hook (one-shot, install-time setup).
        // Activation will fire onActivate later; onInstall runs only once per
        // org-install. Errors are caught and audited but do not abort the install.
        await fireLifecycleHook(manifest.id, 'onInstall', { manifestVersion: manifest.version });

        console.log(`[PluginHost] Installed ${manifest.name} v${manifest.version} (server id=${serverInstall.id})`);
        return { success: true, manifest, signatureStatus };

    } catch (err) {
        console.error('[PluginHost] Install failed:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Activate a third-party plugin (load bundle, inject into DOM, wire routes/nav).
 *
 * @param {string} pluginId
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function activateThirdPartyPlugin(pluginId) {
    // Already loaded?
    if (loadedPlugins.has(pluginId) && loadedPlugins.get(pluginId).exports) {
        return { success: true };
    }

    // Load from IndexedDB
    const record = await dbGet(pluginId);
    if (!record) {
        return { success: false, error: 'Plugin not installed' };
    }

    // LICENSE-LAUNCH LL-6d (C2 class-complete): the client cache-activation gate.
    // This function activates straight from the IndexedDB cache with NO server
    // round-trip, so even after the auth service has dropped every governed
    // install row a revoked org whose cache still holds the bytes could activate
    // the plugin here — the server-filtered /me/plugins list never gets a say on
    // this direct path (the enable toggle, the installer). Mirror the backend
    // hasPlugin(): refuse to activate a GOVERNED plugin the org is not entitled
    // to, using the login-fetched entitlement cache. Only fires when the governed
    // universe is KNOWN and names this plugin — a non-governed custom upload, or
    // an unknown governed set (older server / entitlements not loaded), keeps the
    // offline/perf cache activation untouched (isGovernedPlugin returns false).
    if (isGovernedPlugin(pluginId) && !isPluginLicensed(pluginId)) {
        console.warn(`[PluginHost] Refusing to activate governed plugin ${pluginId} from cache — org holds no entitlement`);
        return { success: false, error: 'not_entitled' };
    }

    const { manifest, bundleCode, cssCode } = record;

    // QUOXTRUST F2 (FND_01M3R1TS88AKXVYS36GDAKXVYS) — the trust-profile split. An
    // UNTRUSTED (non-official) plugin NEVER runs in the parent document: it is routed
    // to the isolated frame host (opaque origin, no parent DOM/cookies/network, mediated
    // RPC only). Only a signature-VERIFIED official first-party bundle keeps the trusted
    // in-parent <script> path below. The privilege is the SAME verified signal used for
    // root routes, computed from the signed manifest + signatureData (never manifest.official).
    const framePrivilege = await resolveRootRoutePrivilege(manifest, record.signatureData, { bundleCode, cssCode });
    if (!framePrivilege.official) {
        return activateViaFrame(pluginId, manifest, bundleCode, cssCode);
    }

    try {
        // 1. Inject CSS (if any) — SEC-CSS-SCOPE: every selector is rewritten
        // so it can only match elements inside this plugin's own mount
        // subtree ([data-plugin-root="<pluginId>"], see PluginSandbox). A
        // plugin has no business styling host chrome (.qx-view, body, etc.)
        // — see pluginCssScope.js for the scoping + blocklist mechanism.
        let styleEl = null;
        const scopedCss = scopePluginCss(cssCode, pluginId);
        if (scopedCss) {
            styleEl = document.createElement('style');
            styleEl.setAttribute('data-plugin', pluginId);
            styleEl.textContent = scopedCss;
            document.head.appendChild(styleEl);
        }

        // 2. Create blob URL for ESM bundle
        const blob = new Blob([bundleCode], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);

        // 3. Set up promise for registration callback
        const registrationPromise = new Promise((resolve, reject) => {
            // Pre-populate loadedPlugins so __quoxPluginRegister can find it
            loadedPlugins.set(pluginId, {
                manifest,
                exports: null,
                blobUrl,
                scriptEl: null,
                styleEl,
                _resolve: resolve,
            });

            setTimeout(() => {
                reject(new Error(`Plugin ${pluginId} did not register within ${REGISTER_TIMEOUT_MS}ms`));
            }, REGISTER_TIMEOUT_MS);
        });

        // 4. Inject script
        const scriptEl = document.createElement('script');
        scriptEl.type = 'module';
        scriptEl.src = blobUrl;
        scriptEl.setAttribute('data-plugin', pluginId);
        document.head.appendChild(scriptEl);

        const entry = loadedPlugins.get(pluginId);
        entry.scriptEl = scriptEl;

        // 5. Wait for plugin to call __quoxPluginRegister
        await registrationPromise;
        delete entry._resolve;

        const exports = entry.exports;

        // 6+7. LL-7: decide the root-route privilege from the VERIFIED
        // signature before any route is registered, then wire routes + nav.
        // The manifest's own `official: true` is an input to the check, never
        // the check itself — see officialPluginSignature.js.
        const privilege = await resolveRootRoutePrivilege(manifest, record.signatureData, { bundleCode, cssCode });
        // LL-6d: remember the VERIFIED official status on the entry so the later
        // onDeactivate hook (fired from deactivateThirdPartyPlugin, out of this
        // scope) can bind its unregister() calls to the same identity.
        if (loadedPlugins.has(pluginId)) loadedPlugins.get(pluginId).official = privilege.official;
        if (manifest.official === true && !privilege.official) {
            console.warn(
                `[PluginHost] ${pluginId} claims official but did not verify (${privilege.reason}) — `
                + `routes stay namespaced under /plugins/${pluginId}/`,
            );
        }
        wirePluginSurfaces(pluginId, manifest, exports, { rootRoutesAllowed: privilege.official });

        // 8. PSDK-3: Register plugin agent into live system
        if (manifest.agentDefinition) {
            const agentDef = manifest.agentDefinition;
            const agentId = agentDef.id || pluginId;
            agentRegistry.agents[agentId] = {
                ...agentDef,
                ownership: { source: 'plugin', plugin: pluginId },
            };
            // Add to hierarchy
            if (!agentRegistry.hierarchy.pluginAgents.includes(agentId)) {
                agentRegistry.hierarchy.pluginAgents.push(agentId);
            }
            // Add to CommanderQ delegation
            if (agentRegistry.agents.quox && !agentRegistry.agents.quox.canDelegateTo.includes(agentId)) {
                agentRegistry.agents.quox.canDelegateTo.push(agentId);
            }
            console.log(`[PluginHost] Registered agent: ${agentId}`);
        }
        if (manifest.agentPersona) {
            const persona = manifest.agentPersona;
            const agentId = persona.id || pluginId;
            assistants[agentId] = persona;
            console.log(`[PluginHost] Registered persona: ${agentId}`);
        }
        if (manifest.delegatorKeywords) {
            const agentId = manifest.agentDefinition?.id || pluginId;
            registerPluginKeywords(agentId, manifest.delegatorKeywords);
            console.log(`[PluginHost] Registered ${manifest.delegatorKeywords.length} delegator keywords for ${agentId}`);
        }

        // 9. PD-3 + PD-8: install runtime api object before invoking activation
        // hooks; pass manifest.permissions so the api object enforces the
        // declared permission set.
        const pluginApi = installPluginApi(pluginId, { permissions: manifest.permissions || null });

        // 10. Call onActivate hook. LL-6d: bind the shared CapabilityPanels
        // surface to THIS plugin's identity + verified official status for the
        // duration of the hook, so any capability-panel registration it makes is
        // attributed and reserved-key-gated.
        if (exports.hooks?.onActivate) {
            try {
                withBoundCapabilityPanels(pluginId, privilege.official, () => exports.hooks.onActivate(pluginApi));
            } catch (err) {
                console.warn(`[PluginHost] ${pluginId} onActivate hook error:`, err);
            }
        }

        setPluginEnabled(pluginId, true);
        console.log(`[PluginHost] Activated ${manifest.name}`);

        // RES.5 (plan/19): if the plugin declares a backend, ask the host to
        // start its container and register it with the gateway. Non-blocking —
        // container start + health can take up to a minute, and the plugin's
        // own polling picks up data the moment the gateway is live. The call is
        // idempotent server-side, so re-activating is safe.
        if (manifest.backend?.image) {
            ensurePluginBackend(pluginId, manifest.backend).catch((err) => {
                // A 401/403 here is PERMANENT, not "deferred": the backend
                // start endpoint is admin-only (collector requireAdminRole),
                // so a non-admin activating a backend-declaring plugin leaves
                // it enabled with a backend that will never start. Logging
                // that as a deferred warning asserts a falsehood, so name it
                // for what it is and say who can resolve it. Everything else
                // (container still booting, transient host error) genuinely is
                // deferred and stays a warning, since the call is idempotent
                // and the plugin's own polling picks the backend up later.
                const denied = /\b401\b|\b403\b|forbidden|unauthor/i.test(err.message || '');
                if (denied) {
                    const deniedMessage =
                        `${manifest.name || pluginId} is enabled, but its backend was not started: `
                        + `starting a plugin backend requires an org admin or owner. `
                        + `Ask an admin to activate this plugin, or it will run without its backend.`;
                    console.error(
                        `[PluginHost] ${pluginId} is enabled but its backend was NOT started: `
                        + `starting a plugin backend requires an org admin or owner. `
                        + `Ask an admin to activate this plugin, or it will run without its backend. (${err.message})`,
                    );
                    // GATE-INSTALL-UI: a console line is invisible to the person
                    // who just clicked "activate" — this is exactly the case the
                    // frontend gate above is meant to prevent (stale session,
                    // role change mid-session). Surface it as a real
                    // notification, not just a log line. Listened for in
                    // PluginSettings.jsx.
                    try {
                        window.dispatchEvent(new CustomEvent('quox-plugin-backend-denied', {
                            detail: { pluginId, name: manifest.name || pluginId, message: deniedMessage },
                        }));
                    } catch { /* non-browser env */ }
                } else {
                    console.warn(`[PluginHost] backend ensure for ${pluginId} deferred/failed:`, err.message);
                }
            });
        }

        return { success: true };

    } catch (err) {
        console.error(`[PluginHost] Activation failed for ${pluginId}:`, err);
        // Cleanup on failure
        deactivateThirdPartyPlugin(pluginId);
        return { success: false, error: err.message };
    }
}

/**
 * LL-7 — decide whether this install may claim ROOT routes.
 *
 * Two conditions, both required: the manifest declares `official: true`, and
 * the install carries an Ed25519 signature over that same manifest from a key
 * in src/config/officialSigningKeys.js. Never throws: any failure inside
 * verification is a refusal, so a broken/absent crypto primitive can never
 * become a privilege escalation.
 *
 * @param {object} manifest
 * @param {object|null} signatureData — signature.json as stored on the install
 * @param {{bundleCode?: string, cssCode?: string|null}} [bytes] — the exact bundle/css the install will run (F2: bound by manifest.integrity)
 * @returns {Promise<{official: boolean, reason: string}>}
 */
export async function resolveRootRoutePrivilege(manifest, signatureData, { bundleCode, cssCode } = {}) {
    try {
        return await isOfficialInstall(manifest, signatureData, { bundleCode, cssCode });
    } catch (err) {
        return { official: false, reason: 'verification_error', detail: err?.message };
    }
}

/**
 * QUOXTRUST F2 — bind a route path to the isolated frame's on-screen view. Returned as
 * the route `component`; App.jsx renders it (inside its PluginSandbox ErrorBoundary),
 * and PluginFrameView shows the plugin's iframe + posts the 'route' event to it.
 */
function makeFrameView(pluginId, framePath) {
    const Bound = () => createElement(PluginFrameView, { pluginId, path: framePath });
    Bound.displayName = `PluginFrameView(${pluginId}:${framePath})`;
    return Bound;
}

/**
 * QUOXTRUST F2 — wire an ISOLATED plugin's DECLARATIVE surfaces (from its frame
 * registration) into the host route/nav registries. No React component crosses the
 * boundary; each route renders the plugin's iframe. Non-official plugins never get root
 * routes (rootRoutesAllowed is always false here).
 *
 * @param {string} pluginId
 * @param {object} manifest
 * @param {{routes?: Array<{path:string,title?:string}>, nav?: Array}} surfaces
 */
export function wirePluginFrameSurfaces(pluginId, manifest, surfaces = {}) {
    const guards = manifest?.routeGuards || {};
    const rawRoutes = Array.isArray(surfaces.routes) ? surfaces.routes : [];
    const validRoutes = rawRoutes.filter(r => r && typeof r.path === 'string' && r.path);
    for (const r of validRoutes) {
        const guard = guards[r.path] || {};
        registerPluginRoute(
            pluginId,
            {
                path: r.path,
                component: makeFrameView(pluginId, r.path),
                minRole: guard.minRole,
                ...(guard.auditorAllowed === undefined ? {} : { auditorAllowed: guard.auditorAllowed }),
            },
            { allowRootRoutes: false }, // untrusted → never a root route
        );
    }
    // Sidebar: a non-official plugin lands in the community section (never 'official').
    // Fall back to the first VALID route only — never a malformed entry.
    const navItems = Array.isArray(surfaces.nav) && surfaces.nav.length
        ? surfaces.nav
        : (validRoutes.length ? [{ path: validRoutes[0].path, label: manifest.name || pluginId, icon: 'puzzle' }] : []);
    if (navItems.length) registerPluginNavItems(pluginId, navItems);
}

/**
 * QUOXTRUST F2 — activate an untrusted plugin in the ISOLATED frame host. The bundle
 * runs in a sandboxed opaque-origin iframe with no parent DOM/cookies/network; the host
 * mediates every capability over the RPC and attaches the authenticated org itself.
 *
 * @param {string} pluginId
 * @param {object} manifest
 * @param {string} bundleCode
 * @param {string} [cssCode]
 * @returns {Promise<{success:boolean, error?:string}>}
 */
async function activateViaFrame(pluginId, manifest, bundleCode, cssCode) {
    if (getPluginFrame(pluginId)) return { success: true }; // already running

    const mediator = createHostMediator({
        pluginId,
        collectorBase: (typeof window !== 'undefined' && window.__quoxCollectorUrl) || '/collector',
        // Org/user are resolved HOST-SIDE from the auth state the parent owns; the
        // plugin can never assert a different org (T7 at the RPC boundary).
        getAuthContext: () => getHostAuthContext(),
        // The admin-approved declarations from the installed manifest are the
        // boundary (FND_01M4SVA495ZMJ0K3BZM6ZMJ0K3); the mediator fails closed.
        permissions: manifest && manifest.permissions,
    });

    let frame;
    try {
        frame = createPluginFrame({ pluginId, bundleCode, cssCode, mountEl: frameHolder(), mediator });
    } catch (err) {
        return { success: false, error: `frame create failed: ${err.message}` };
    }

    let surfaces;
    try {
        surfaces = await frame.registration;
    } catch (err) {
        try { frame.destroy(); } catch { /* best-effort */ }
        return { success: false, error: `plugin ${pluginId} did not register: ${err.message}` };
    }

    registerFrame(pluginId, frame);
    loadedPlugins.set(pluginId, { manifest, exports: null, frame, isolated: true, official: false });
    wirePluginFrameSurfaces(pluginId, manifest, surfaces);

    // Agent identity from the manifest (parity with the script path, which also reads
    // manifest.agentDefinition). An isolated plugin's agent still runs its tools through
    // the collector's governed choke — the isolation is about the browser runtime.
    // Community persona is untrusted: no quox delegation, never replaces an existing agent id.
    registerFramePluginAgent(agentRegistry, pluginId, manifest, { official: false });

    console.log(`[PluginHost] ${pluginId} activated ISOLATED (frame host) — ${(surfaces.routes || []).length} route(s)`);
    return { success: true };
}

/**
 * LL-7 — turn a registered bundle's exports into routes + sidebar entries.
 *
 * Extracted from activateThirdPartyPlugin so the privilege decision and its
 * consequences are testable without executing a real bundle. Route guards
 * (minRole / auditorAllowed) come from `manifest.routeGuards`, NOT from the
 * bundle's exports: the manifest is the artefact the signature covers, so a
 * stripped core route like /quoxbox keeps a tamper-evident admin gate.
 *
 * @param {string} pluginId
 * @param {object} manifest
 * @param {{routes?: Object, sidebar?: Array}} exports
 * @param {{rootRoutesAllowed?: boolean}} [options]
 */
export function wirePluginSurfaces(pluginId, manifest, exports, options = {}) {
    const { rootRoutesAllowed = false } = options;
    const guards = manifest?.routeGuards || {};

    if (exports.routes) {
        for (const [routePath, component] of Object.entries(exports.routes)) {
            const guard = guards[routePath] || {};
            registerPluginRoute(
                pluginId,
                {
                    path: routePath,
                    component,
                    minRole: guard.minRole,
                    ...(guard.auditorAllowed === undefined ? {} : { auditorAllowed: guard.auditorAllowed }),
                },
                { allowRootRoutes: rootRoutesAllowed },
            );
        }
    }

    // Sidebar items. First-party ("official") plugins register into the
    // trusted "Official" nav section rather than "Community Plugins", so an
    // auto-provisioned, licence-gated Quox plugin does not present next to
    // untrusted third-party uploads.
    if (manifest.sidebar || exports.sidebar) {
        const sidebarItems = exports.sidebar || manifest.sidebar;
        if (Array.isArray(sidebarItems)) {
            registerPluginNavItems(pluginId, sidebarItems, manifest.official === true ? 'official' : undefined);
        }
    } else if (exports.routes && Object.keys(exports.routes).length > 0) {
        // Fallback: a plugin with pages but no declared sidebar item would
        // otherwise be invisible in the sidebar — getNavSections only builds
        // the "Community Plugins" section when at least one nav item exists,
        // so a route-only plugin is reachable by direct URL but has no rail
        // icon. Auto-register a nav entry for its first route so every
        // installed community plugin shows up in the rail.
        const firstPath = Object.keys(exports.routes)[0];
        registerPluginNavItems(
            pluginId,
            [{ path: firstPath, label: manifest.name || pluginId, icon: 'puzzle' }],
            manifest.official === true ? 'official' : undefined
        );
    }
}

/**
 * RES.5 (plan/19): ask the collector to start + register this plugin's backend
 * container from its manifest.backend. Routed through the /collector proxy
 * (forwards session cookies) to the admin ensure endpoint. Idempotent.
 * @param {string} pluginId
 * @param {{image:string, port?:number, healthPath?:string}} backend
 */
async function ensurePluginBackend(pluginId, backend) {
    const base = (typeof window !== 'undefined' && window.__quoxCollectorUrl) || '/collector';
    const res = await fetch(`${base}/api/v1/admin/plugins/${encodeURIComponent(pluginId)}/backend/ensure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ image: backend.image, port: backend.port, healthPath: backend.healthPath }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || body.error || `ensure HTTP ${res.status}`);
    }
    const body = await res.json();
    console.log(`[PluginHost] Backend ready for ${pluginId}: ${body.url} (healthy=${body.healthy})`);
    return body;
}

/**
 * Enable or disable an installed third-party plugin org-wide.
 *
 * PD-1 (PERSIST-TRUTH): the server's `is_enabled` column is the source of
 * truth — this PATCHes it first (admin-only route) and only mutates local DOM
 * state / the in-memory installedList mirror on success. A non-admin caller
 * gets the server's 403 `insufficient_role` surfaced back to the UI instead of
 * a toggle that silently only worked for the current tab/session.
 *
 * @param {string} pluginId
 * @param {boolean} enabled
 * @returns {Promise<{success: boolean, error?: string, code?: string}>}
 */
export async function setThirdPartyPluginEnabled(pluginId, enabled) {
    const orgId = getActiveOrgId();
    if (!orgId) {
        return { success: false, error: 'No active org — cannot change plugin state' };
    }

    try {
        const updated = await apiSetEnabled(orgId, pluginId, enabled);
        if (enabled) {
            const result = await activateThirdPartyPlugin(pluginId);
            if (!result.success) {
                return { success: false, error: result.error };
            }
        } else {
            deactivateThirdPartyPlugin(pluginId);
        }
        setPluginEnabled(pluginId, !!updated?.is_enabled);
        return { success: true };
    } catch (err) {
        const message = err?.code === 'insufficient_role'
            ? 'Only org admins can enable or disable plugins.'
            : (err?.message || 'Failed to update plugin state');
        return { success: false, error: message, code: err?.code };
    }
}

/**
 * Deactivate a third-party plugin (remove from DOM, unregister routes/nav).
 *
 * @param {string} pluginId
 */
export function deactivateThirdPartyPlugin(pluginId) {
    const entry = loadedPlugins.get(pluginId);
    if (!entry) return;

    // Call onDeactivate hook. LL-6d: bind CapabilityPanels to this plugin's
    // identity so its unregister() only removes panels IT registered (owner
    // match), never another plugin's or a core panel.
    if (entry.exports?.hooks?.onDeactivate) {
        try {
            withBoundCapabilityPanels(pluginId, entry.official === true, () => entry.exports.hooks.onDeactivate());
        } catch (err) {
            console.warn(`[PluginHost] ${pluginId} onDeactivate hook error:`, err);
        }
    }

    // Remove script element (official/in-parent path)
    if (entry.scriptEl) {
        entry.scriptEl.remove();
    }

    // QUOXTRUST F2 — tear down the isolated frame (untrusted/frame-hosted path).
    if (entry.isolated || entry.frame) {
        removeFrame(pluginId);
    }

    // Remove style element
    if (entry.styleEl) {
        entry.styleEl.remove();
    }

    // Revoke blob URL
    if (entry.blobUrl) {
        URL.revokeObjectURL(entry.blobUrl);
    }

    // Unregister routes and nav items
    unregisterPluginRoutes(pluginId);
    unregisterPluginNavItems(pluginId);

    // PSDK-3: Unregister plugin agent
    const agentId = entry.manifest?.agentDefinition?.id || pluginId;
    if (agentRegistry.agents[agentId]?.ownership?.plugin === pluginId) {
        delete agentRegistry.agents[agentId];
        agentRegistry.hierarchy.pluginAgents = agentRegistry.hierarchy.pluginAgents.filter(id => id !== agentId);
        if (agentRegistry.agents.quox) {
            agentRegistry.agents.quox.canDelegateTo = agentRegistry.agents.quox.canDelegateTo.filter(id => id !== agentId);
        }
    }
    if (assistants[agentId]) {
        delete assistants[agentId];
    }
    unregisterPluginKeywords(agentId);

    loadedPlugins.delete(pluginId);
    setPluginEnabled(pluginId, false);
    uninstallPluginApi(pluginId);

    console.log(`[PluginHost] Deactivated ${pluginId}`);
}

/**
 * Uninstall a third-party plugin (deactivate + remove from storage).
 *
 * @param {string} pluginId
 * @param {boolean} [deleteData=false] - Also delete plugin-scoped localStorage
 */
export async function uninstallThirdPartyPlugin(pluginId, deleteData = false) {
    // PD-5: fire onUninstall hook BEFORE tearing down so the hook still has
    // access to the live api object. Errors do not block the uninstall.
    await fireLifecycleHook(pluginId, 'onUninstall', { deleteData });

    // Deactivate first (DOM + registries)
    deactivateThirdPartyPlugin(pluginId);

    // PD-1: server is source of truth — remove there first.
    const orgId = getActiveOrgId();
    if (orgId) {
        try {
            await apiUninstall(orgId, pluginId);
        } catch (err) {
            console.warn(`[PluginHost] Server uninstall failed for ${pluginId}:`, err.message);
        }
    }

    // Then clear local cache.
    await dbDelete(pluginId);
    recordUninstalled(pluginId);

    // Optional: clean up plugin-scoped browser storage (admin opt-in via UI).
    if (deleteData) {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.includes(pluginId)) keysToRemove.push(key);
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
    }

    console.log(`[PluginHost] Uninstalled ${pluginId}`);
}

/**
 * Load all installed + enabled plugins on startup.
 * Called from main.jsx after initPluginHost().
 *
 * PD-1: server is the source of truth. We hydrate the in-memory list from
 * `/api/orgs/:orgId/plugins`, validate each cached bundle's SHA-256 against
 * what the server reports, refetch any mismatches, then activate enabled ones.
 */
export async function loadInstalledPlugins() {
    const orgId = getActiveOrgId();
    if (!orgId) {
        installedList = [];
        listStatus = 'no-org';
        emitHydrationState();
        return;
    }
    listStatus = 'idle';
    pendingActivations.clear();
    failedActivations.clear();
    emitHydrationState();

    // PD-2: one-shot migration of any pre-PD-1 IndexedDB-only installs.
    // Idempotent — already-migrated records are tagged with `migrated_at`.
    try {
        await migrateLegacyInstalls(orgId);
    } catch (err) {
        console.warn('[PluginHost] Legacy migration skipped:', err.message);
    }

    let serverList;
    try {
        serverList = await apiList(orgId);
    } catch (err) {
        // Network/auth failure during boot — leave list empty rather than
        // resurrecting stale browser state.
        console.warn('[PluginHost] Could not hydrate from server:', err.message);
        installedList = [];
        listStatus = 'error';
        emitHydrationState();
        return;
    }

    // LL-7 review note 1 — entitlement loss. The auth service un-provisions a
    // licence-gated first-party install the moment the lease lapses, so the
    // plugin simply stops appearing in this list. Anything we still hold
    // locally for it is now paid code the org is not entitled to, cached in a
    // store that survives reloads. Purge it here, before any activation, and
    // tear down a live instance if one is running.
    //
    // The sweep covers EVERY cached record the server did not list, not just
    // the id we happened to be watching: the store is keyed on pluginId alone
    // (not org+plugin), so leftovers from a previous org on a shared browser
    // are exactly as unjustified. Cost is a refetch after an org switch, which
    // is the correct price for a cache whose source of truth is the server.
    //
    // Only reached on a SUCCESSFUL list fetch — the failure path above returns
    // early, so a 503 or an expired session is never mistaken for revocation.
    await purgeUnlistedPluginCaches(serverList.map(s => s.plugin_id));

    installedList = serverList.map(s => ({
        pluginId: s.plugin_id,
        name: s.manifest?.name || s.plugin_id,
        version: s.version,
        author: s.manifest?.author,
        enabled: !!s.is_enabled,
        installedAt: s.installed_at,
        bundleSha256: s.bundle_sha256,
    }));

    const enabled = installedList.filter(p => p.enabled);
    enabled.forEach(p => pendingActivations.add(p.pluginId));
    listStatus = 'ok';
    emitHydrationState();
    if (enabled.length === 0) return;

    console.log(`[PluginHost] Hydrating ${enabled.length} third-party plugin(s) from server...`);

    // INIT-OPT (2026-09-03): activate all enabled plugins CONCURRENTLY, not one
    // at a time. The previous serial `for...await` chained each plugin's bundle
    // fetch+eval+nav-registration behind the last, so N enabled plugins meant N
    // sequential round-trips — the sidebar visibly filled in "at its own rate",
    // one icon per completed bundle. ensureCachedAndActivate touches only its
    // own pluginId in the shared Maps and JS is single-threaded, so concurrent
    // activation is safe: the interleaving only happens at await points, and the
    // synchronous route/nav registration for distinct ids never collides. The
    // nav-change events now land in a tight burst instead of spread across the
    // network time (AppShell coalesces that burst into one sidebar rebuild).
    const byId = new Map(serverList.map(s => [s.plugin_id, s]));
    await Promise.allSettled(enabled.map(async (entry) => {
        try {
            await ensureCachedAndActivate(orgId, entry, byId.get(entry.pluginId));
            pendingActivations.delete(entry.pluginId);
            emitHydrationState();
        } catch (err) {
            console.error(`[PluginHost] Failed to load ${entry.pluginId}:`, err);
            pendingActivations.delete(entry.pluginId);
            failedActivations.add(entry.pluginId);
            emitHydrationState();
            // Self-heal: a load/activation failure often means the cached bytes
            // are stale or corrupt (e.g. a bundle from a superseded build that
            // predates a host contract change). Evict the cache entry so the
            // NEXT boot refetches fresh from the server instead of re-running
            // the same bad bytes every reload — the trap that made a broken
            // plugin appear to "come back" after a plain refresh.
            try {
                await dbDelete(entry.pluginId);
                console.warn(`[PluginHost] Evicted cached bundle for ${entry.pluginId} — next boot will refetch from server`);
            } catch (evictErr) {
                console.warn(`[PluginHost] Could not evict cache for ${entry.pluginId}:`, evictErr.message);
            }
        }
    }));
}

/**
 * LL-7 — drop every locally cached bundle the server did not list.
 *
 * Called from loadInstalledPlugins() only after a successful list fetch. A
 * plugin that vanished from the list has either been uninstalled or had its
 * entitlement revoked; either way the browser must stop holding runnable
 * bytes for it. Deactivates first (routes, nav, agents, injected script/CSS)
 * so a currently-mounted revoked plugin actually disappears, then deletes the
 * IndexedDB record.
 *
 * Best-effort per record: one undeletable entry must not abort hydration of
 * everything else.
 *
 * @param {string[]} listedIds — plugin ids the server reports for the active org
 * @returns {Promise<string[]>} the ids actually purged
 */
async function purgeUnlistedPluginCaches(listedIds) {
    const keep = new Set(listedIds);
    let cached;
    try {
        cached = await dbGetAll();
    } catch (err) {
        console.warn('[PluginHost] Could not read cache for entitlement sweep:', err.message);
        return [];
    }

    const purged = [];
    for (const record of cached) {
        const pluginId = record?.pluginId;
        if (!pluginId || keep.has(pluginId)) continue;
        try {
            if (loadedPlugins.has(pluginId)) deactivateThirdPartyPlugin(pluginId);
            await dbDelete(pluginId);
            recordUninstalled(pluginId);
            purged.push(pluginId);
            console.log(`[PluginHost] Purged cached bundle for ${pluginId} — the server no longer lists it for this org`);
        } catch (err) {
            console.warn(`[PluginHost] Could not purge cached bundle for ${pluginId}:`, err.message);
        }
    }
    return purged;
}

/**
 * PD-5 — Lifecycle hook dispatch.
 *
 * Plugins can export hooks { onInstall, onUpgrade, onUninstall, onRestore }
 * from their entry. The host invokes them at the matching boundaries with the
 * plugin's runtime api object (durable + secrets + memory + notify) plus any
 * boundary-specific context. Errors are caught and audited but never abort
 * the host operation.
 *
 * onActivate / onDeactivate already exist (DOM lifecycle) and are unchanged.
 * The four PD-5 hooks fire at install/upgrade/uninstall/restore points.
 */
async function fireLifecycleHook(pluginId, hookName, ctx = {}) {
    return _fireLifecycleHook({
        loadedPlugins,
        pluginId,
        hookName,
        ctx,
        getApi: (id) => window.__quoxPluginApi?.[id] || installPluginApi(id),
    });
}

/**
 * PD-2 — Migrate legacy IndexedDB-only installs into the server registry.
 *
 * On first boot after the PD-1 deploy, IDB may contain plugin records that
 * were never POSTed to the server. Walk the cache, push each unmigrated
 * record to /migrate (idempotent on the server), and stamp `migrated_at` so
 * we never re-attempt.
 *
 * Best-effort: errors here do not block hydration. If the user is not an org
 * admin, /migrate returns 403 and we leave the IDB record alone — the next
 * admin to load the dashboard will complete the migration.
 */
async function migrateLegacyInstalls(orgId) {
    const all = await dbGetAll();
    const candidates = all.filter(r => !r.migrated_at);
    if (candidates.length === 0) return;

    for (const rec of candidates) {
        if (!rec.manifest || !rec.bundleCode) continue;
        try {
            const result = await apiMigrate(orgId, {
                manifest: rec.manifest,
                bundleCode: rec.bundleCode,
                cssCode: rec.cssCode || null,
                signatureData: rec.signatureData || null,
            });
            // Stamp the sha of the bytes we actually HOLD, never the server's.
            // When the server answers sha_mismatch_server_authoritative the
            // local bundleCode is known-stale; recording the server sha here
            // made the stale cache pass the equality check in
            // ensureCachedAndActivate forever and run old code after upgrades.
            const localSha = await sha256Hex(rec.bundleCode);
            await dbPut({
                ...rec,
                bundleSha256: localSha,
                migrated_at: new Date().toISOString(),
                migrated_reason: result?.migrated ? 'created' : (result?.reason || 'noop'),
            });
            console.log(`[PluginHost] Migrated legacy install ${rec.pluginId} (${result?.migrated ? 'created' : result?.reason})`);
        } catch (err) {
            if (err.status === 403) {
                console.info(`[PluginHost] Migration deferred for ${rec.pluginId} — current user is not an org admin`);
                return; // bail out for the whole batch; non-admin won't get further
            }
            console.warn(`[PluginHost] Could not migrate ${rec.pluginId}:`, err.message);
        }
    }
}

/**
 * Ensure the IndexedDB cache for a plugin matches the server (by SHA-256), then
 * activate it. Refetches bundle + CSS from the server if the cache is stale or
 * missing.
 */
async function ensureCachedAndActivate(orgId, listEntry, serverRow) {
    const cached = await dbGet(listEntry.pluginId);
    const serverSha = serverRow?.bundle_sha256 || listEntry.bundleSha256;
    const previousSha = cached?.bundleSha256 || null;
    const previousVersion = cached?.manifest?.version || null;

    // Defense in depth: trust the cached record only if its RECORDED sha both
    // matches the server AND matches the bytes it actually holds. A record
    // whose sha was ever stamped without refetching (or corrupted) must not
    // short-circuit the refetch.
    let cacheTrustworthy = false;
    if (cached && cached.bundleSha256 === serverSha && cached.bundleCode) {
        const actualSha = await sha256Hex(cached.bundleCode);
        cacheTrustworthy = actualSha === cached.bundleSha256;
        if (!cacheTrustworthy) {
            console.warn(`[PluginHost] Cached bundle for ${listEntry.pluginId} fails content-hash check — refetching from server`);
        }
    }

    let upgraded = false;
    if (!cacheTrustworthy) {
        const { bundleCode, bundleSha256, cssLength } = await apiGetBundle(orgId, listEntry.pluginId);
        const cssCode = cssLength > 0 ? await apiGetCss(orgId, listEntry.pluginId) : null;
        await dbPut({
            pluginId: listEntry.pluginId,
            manifest: serverRow?.manifest || cached?.manifest || {
                id: listEntry.pluginId, name: listEntry.name, version: listEntry.version,
            },
            bundleCode,
            cssCode,
            signatureData: serverRow?.signature || null,
            signatureStatus: serverRow?.signature ? 'signed' : 'unsigned',
            bundleSha256,
            installedAt: listEntry.installedAt,
            // LL-7: these bytes CAME FROM the server, so this record is not a
            // pre-PD-1 legacy install and must never be offered back to
            // /plugins/migrate. Without the stamp, migrateLegacyInstalls()
            // treated every server-hydrated record as a migration candidate on
            // the next boot — and after an entitlement lapsed, that POST
            // re-created the install row the reconciler had just removed,
            // resurrecting a revoked plugin from the local cache. The auth
            // service now also 402s that POST (routes/plugins.js migrate); this
            // is the client half, so the request is never made at all.
            migrated_at: new Date().toISOString(),
            migrated_reason: 'server_hydrated',
        });
        // Treat as an upgrade only when there was a prior cached bundle
        // (otherwise this is the first hydration on a fresh device).
        upgraded = previousSha !== null && previousSha !== bundleSha256;
    }
    await activateThirdPartyPlugin(listEntry.pluginId);

    // PD-5: onUpgrade fires after activation so the hook has the live api.
    if (upgraded) {
        await fireLifecycleHook(listEntry.pluginId, 'onUpgrade', {
            fromVersion: previousVersion,
            toVersion: serverRow?.version || listEntry.version,
        });
    }
}

/**
 * Get list of installed third-party plugins with their status.
 * Returns the in-memory mirror populated by `loadInstalledPlugins()`.
 * @returns {Array<{pluginId, name, version, author, enabled, installedAt}>}
 */
export function getInstalledPlugins() {
    return installedList.slice();
}

/**
 * The installed manifest of a loaded plugin (null when not loaded). Used by
 * PluginFrameView to decide whether the host renders an agent dock.
 * @param {string} pluginId
 * @returns {Object|null}
 */
export function getLoadedPluginManifest(pluginId) {
    return loadedPlugins.get(pluginId)?.manifest || null;
}

/**
 * Get a loaded plugin's exports (for PluginSandbox).
 * @param {string} pluginId
 * @returns {Object|null}
 */
export function getPluginExports(pluginId) {
    return loadedPlugins.get(pluginId)?.exports || null;
}

/**
 * Get a plugin's manifest from IndexedDB.
 * @param {string} pluginId
 * @returns {Promise<Object|null>}
 */
export async function getPluginManifest(pluginId) {
    const record = await dbGet(pluginId);
    return record?.manifest || null;
}

/**
 * LICENSE-LAUNCH LL-8 v1: whether an installed plugin's cached record
 * verifies as a genuine Quox first-party bundle — Quox-signed AND
 * manifest.official (see officialPluginSignature.js), never trusted from
 * manifest.official alone. Used by Settings to keep verified first-party
 * installs (LL-7 strip) out of the Community Plugins section — they already
 * render in the licensed/claimable/premium board sections as first-party
 * manifests, so listing them again under Community both duplicates the
 * boards and misrepresents them as third-party. Degrades closed (false) on
 * any missing record or verification failure, same as resolveRootRoutePrivilege.
 * @param {string} pluginId
 * @returns {Promise<boolean>}
 */
export async function isInstalledPluginOfficial(pluginId) {
    try {
        const record = await dbGet(pluginId);
        if (!record?.manifest) return false;
        const { official } = await resolveRootRoutePrivilege(record.manifest, record.signatureData || null, {
            bundleCode: record.bundleCode,
            cssCode: record.cssCode,
        });
        return official === true;
    } catch (err) {
        console.warn(`[PluginHost] official-status check failed for ${pluginId}:`, err?.message);
        return false;
    }
}

/**
 * Check if a plugin is currently active (loaded and running).
 * @param {string} pluginId
 * @returns {boolean}
 */
export function isPluginActive(pluginId) {
    return loadedPlugins.has(pluginId) && loadedPlugins.get(pluginId).exports != null;
}
