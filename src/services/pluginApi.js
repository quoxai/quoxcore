/**
 * pluginApi — runtime PluginAPI object exposed to third-party plugins.
 *
 * The host calls `installPluginApi(pluginId)` when a plugin activates and
 * `uninstallPluginApi(pluginId)` when it deactivates. Plugins read the api
 * via `window.__quoxPluginApi[pluginId]` (or via the React prop `pluginApi`
 * passed to plugin route components).
 *
 * Stream PD scope:
 *   - PD-3 lands `api.durable` (server-backed, org/user scoped)
 *   - PD-4 will add `api.secrets` (encrypted at rest)
 *   - PD-6 will rename `api.storage` to `api.cache` and add deprecation
 *     warnings
 *
 * For now, `api.storage` and `api.config` retain the legacy localStorage
 * behaviour with a single console warning so existing plugins keep working
 * while the durable path is the new sanctioned default.
 */

import { csrfFetch } from '../utils/csrfFetch';

const API_BASE = '/api/orgs';

// Browser sessions carry cookies, so the auth service enforces CSRF on every
// mutation. Plain fetch made durable.set/remove and secrets.set/remove 403
// for EVERY plugin in a real session (latent until Quox Spatial's migration
// became the first genuine in-browser durable write). csrfFetch is a drop-in
// wrapper; tests keep injecting their own fetchImpl.
const defaultFetch = typeof window !== 'undefined' ? csrfFetch : (typeof fetch !== 'undefined' ? fetch : null);

if (typeof window !== 'undefined' && !window.__quoxPluginApi) {
    window.__quoxPluginApi = {};
}

function getActiveOrgId() {
    try { return localStorage.getItem('current_org_id') || null; } catch { return null; }
}

function nsKey(pluginId, key) { return `quox-plugin:${pluginId}:${key}`; }

function buildCache(pluginId) {
    let warned = false;
    const warn = () => {
        if (warned) return;
        warned = true;
        console.warn(
            `[plugin:${pluginId}] api.storage is browser-only and will be renamed to api.cache. ` +
            `Use api.durable for persistence that survives browser resets and syncs across devices.`,
        );
    };
    // DATA-LOSS GUARD: the cache MUST be org-scoped to match api.durable (which
    // is per-org). Without this, switching orgs made one org's cache visible/
    // overwritable under another — a plugin reading an empty server index for a
    // new org could clobber the shared cache holding a different org's data.
    // Keying by org keeps each org's cache isolated (a plugin bug reproduced
    // live with the spatial plugin's waypoint index).
    const base = () => `quox-plugin:${pluginId}:${getActiveOrgId() || 'default'}:`;
    return {
        get(key) {
            warn();
            try {
                const raw = localStorage.getItem(base() + key);
                return raw == null ? null : JSON.parse(raw);
            } catch { return null; }
        },
        set(key, value) {
            warn();
            try { localStorage.setItem(base() + key, JSON.stringify(value)); } catch { /* quota */ }
        },
        remove(key) {
            warn();
            try { localStorage.removeItem(base() + key); } catch { /* */ }
        },
        keys() {
            warn();
            const prefix = base();
            const out = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length));
            }
            return out;
        },
    };
}

function buildSecrets(pluginId, fetchImpl = defaultFetch) {
    function base() {
        const orgId = getActiveOrgId();
        if (!orgId) throw new Error('no_active_org');
        return `${API_BASE}/${encodeURIComponent(orgId)}/plugins/${encodeURIComponent(pluginId)}/secrets`;
    }
    return {
        async list() {
            const res = await fetchImpl(base(), { credentials: 'include' });
            if (!res.ok) throw new Error(`secrets.list failed status=${res.status}`);
            const json = await res.json();
            return (json?.secrets || []).map(s => s.name);
        },
        async set(name, value, { description } = {}) {
            const res = await fetchImpl(`${base()}/${encodeURIComponent(name)}`, {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value, description: description || null }),
            });
            if (!res.ok) {
                const err = new Error(`secrets.set failed status=${res.status}`);
                err.status = res.status;
                throw err;
            }
        },
        async get(name) {
            const res = await fetchImpl(`${base()}/${encodeURIComponent(name)}/reveal`, {
                method: 'POST',
                credentials: 'include',
            });
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`secrets.get failed status=${res.status}`);
            const json = await res.json();
            return json?.value ?? null;
        },
        async remove(name) {
            const res = await fetchImpl(`${base()}/${encodeURIComponent(name)}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            if (!res.ok && res.status !== 404) throw new Error(`secrets.remove failed status=${res.status}`);
        },
    };
}

function buildDurable(pluginId, fetchImpl = defaultFetch) {
    function url(key, opts) {
        const orgId = getActiveOrgId();
        if (!orgId) throw new Error('no_active_org');
        const q = opts?.scope === 'user' ? '?scope=user' : '';
        return `${API_BASE}/${encodeURIComponent(orgId)}/plugins/${encodeURIComponent(pluginId)}/data/${encodeURIComponent(key)}${q}`;
    }
    function listUrl(opts) {
        const orgId = getActiveOrgId();
        if (!orgId) throw new Error('no_active_org');
        const q = opts?.scope === 'user' ? '?scope=user' : '';
        return `${API_BASE}/${encodeURIComponent(orgId)}/plugins/${encodeURIComponent(pluginId)}/data${q}`;
    }
    return {
        async get(key, opts) {
            const res = await fetchImpl(url(key, opts), { credentials: 'include' });
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`durable.get failed status=${res.status}`);
            const json = await res.json();
            return json?.value ?? null;
        },
        async set(key, value, opts) {
            const res = await fetchImpl(url(key, opts), {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value }),
            });
            if (!res.ok) throw new Error(`durable.set failed status=${res.status}`);
        },
        async remove(key, opts) {
            const res = await fetchImpl(url(key, opts), { method: 'DELETE', credentials: 'include' });
            if (!res.ok && res.status !== 404) throw new Error(`durable.remove failed status=${res.status}`);
        },
        async keys(opts) {
            const res = await fetchImpl(listUrl(opts), { credentials: 'include' });
            if (!res.ok) throw new Error(`durable.keys failed status=${res.status}`);
            const json = await res.json();
            return (json?.keys || []).map(k => k.key);
        },
    };
}

/**
 * PD-8 — gate an api facet behind a manifest-declared permission.
 *
 * Returns a Proxy that throws `permission_denied` when any method is called
 * unless the requested permission name is present on the manifest's
 * `permissions` array. Permission gating is opt-in: callers without a
 * declared permission set get the unguarded api (back-compat for older
 * plugins that pre-date PD-8).
 */
function permissionGate(facet, permissionName, permissions, pluginId) {
    if (!permissions) return facet;                        // back-compat: ungated
    if (permissions.includes(permissionName)) return facet;// granted
    return new Proxy(facet, {
        get() {
            // Return an async function so callers using `await` get a
            // rejected promise rather than a sync throw — matches the rest
            // of the durable/secrets/memory async surface.
            return async () => {
                const err = new Error(`permission_denied: plugin '${pluginId}' is missing '${permissionName}' in manifest.permissions`);
                err.code = 'permission_denied';
                throw err;
            };
        },
    });
}

/**
 * Build the runtime api object for a single plugin.
 *
 * @param {string} pluginId
 * @param {Object} [opts]
 * @param {Function} [opts.fetchImpl]   — override for tests
 * @param {string[]} [opts.permissions] — plugin manifest.permissions array.
 *   When supplied, methods on durable/secrets/memory/aee/network throw
 *   permission_denied unless the matching permission is declared.
 */
export function buildPluginApi(pluginId, {
    fetchImpl = defaultFetch,
    permissions = null,
} = {}) {
    const api = {
        pluginId,
        cache: buildCache(pluginId),
        // Legacy alias kept for existing plugins; renamed properly in PD-6.
        get storage() { return this.cache; },
        durable: permissionGate(buildDurable(pluginId, fetchImpl), 'durable', permissions, pluginId),
        secrets: permissionGate(buildSecrets(pluginId, fetchImpl), 'secrets', permissions, pluginId),
        config: {
            get() { return JSON.parse(localStorage.getItem(nsKey(pluginId, '__config')) || '{}'); },
            save(cfg) { localStorage.setItem(nsKey(pluginId, '__config'), JSON.stringify(cfg || {})); },
        },
        // Active org context — so a plugin can show the user WHICH org they are
        // acting in (e.g. "Creating this waypoint for ExamplePools"). id is always
        // available; name/slug are present once the host publishes org context
        // (window.__quoxOrgContext), updated on the quox-org-switch event.
        getOrg() {
            const id = getActiveOrgId();
            const ctx = (typeof window !== 'undefined' && window.__quoxOrgContext) || {};
            const matches = ctx.id && ctx.id === id;
            return { id, name: matches ? (ctx.name || null) : null, slug: matches ? (ctx.slug || null) : null };
        },
        notify(message, type = 'info') {
            // Minimal default; the host can replace this with a real toast bridge.
            console.log(`[plugin:${pluginId}] ${type}: ${message}`);
        },
        fetch: permissions && !permissions.includes('network')
            ? () => { const e = new Error(`permission_denied: '${pluginId}' missing 'network'`); e.code = 'permission_denied'; throw e; }
            : async (path, options) => {
                // Documented contract (SDK backend-plugins.md): api.fetch
                // proxies to the plugin's OWN backend via the collector
                // gateway. Relative paths are rewritten to the gateway route —
                // a raw passthrough sent them to the dashboard's nginx/auth
                // instead (404, SPATIAL-W2 find).
                //
                // AUDIT HIGH: a same-origin relative path is exactly one that
                // starts with a single '/'. A protocol-relative '//evil.com'
                // or an absolute http(s) URL is NOT own-backend traffic — send
                // it WITHOUT credentials so session cookies can never be
                // exfiltrated to a third-party host via the network permission.
                const isSameOriginRelative = typeof path === 'string'
                    && path.startsWith('/') && !path.startsWith('//');
                const base = (typeof window !== 'undefined' && window.__quoxCollectorUrl) || '/collector';
                if (isSameOriginRelative) {
                    const target = `${base}/api/v1/plugins/${encodeURIComponent(pluginId)}${path}`;
                    return fetchImpl(target, { credentials: 'include', ...(options || {}) });
                }
                // Non-relative: allowed (some plugins call their own external
                // backends) but never with the dashboard's cookies.
                const opts = { ...(options || {}) };
                if (opts.credentials === 'include') delete opts.credentials;
                return fetchImpl(path, opts);
            },
        memory: permissionGate({
            async save(_entry) { return { success: false, reason: 'not_implemented_in_pd_3' }; },
            async search(_q, _l) { return { results: [] }; },
        }, 'memory', permissions, pluginId),
        aee: permissionGate({
            async emit(_intent, _payload) { return { success: false, reason: 'not_implemented_in_pd_3' }; },
        }, 'aee', permissions, pluginId),
    };
    return api;
}

export function installPluginApi(pluginId, { permissions = null } = {}) {
    if (typeof window === 'undefined') return null;
    if (!window.__quoxPluginApi) window.__quoxPluginApi = {};
    const api = buildPluginApi(pluginId, { permissions });
    window.__quoxPluginApi[pluginId] = api;
    return api;
}

export function uninstallPluginApi(pluginId) {
    if (typeof window === 'undefined' || !window.__quoxPluginApi) return;
    delete window.__quoxPluginApi[pluginId];
}
