/**
 * pluginFrameHost — QuoxTrust F2 runtime isolation for third-party plugins.
 *
 * Engagement ENG_01M3R1RVXHFNRB3GF6CAFNRB3G, finding FND_01M3R1TS88AKXVYS36GDAKXVYS
 * (critical): today `thirdPartyPluginHost.js` injects the plugin bundle as a
 * `<script type=module>` into the PARENT document, so untrusted plugin code runs with
 * the user's full authority (parent DOM incl. the approval UI, cookies, localStorage,
 * same-origin credentialed fetch). `PluginSandbox.jsx` is an ErrorBoundary + a
 * convention API — NOT a boundary.
 *
 * This host runs the plugin inside a sandboxed iframe with a UNIQUE OPAQUE ORIGIN
 * (`sandbox="allow-scripts"`, deliberately WITHOUT `allow-same-origin`) and a strict
 * in-frame CSP (`connect-src 'none'`, `default-src 'none'`). The plugin has no parent
 * DOM, no cookies, no network. Its ONLY channel is a narrow postMessage RPC that the
 * host mediates, attaching the authenticated org/user itself so the plugin can neither
 * forge a request as the user nor assert a different org.
 *
 * The full contract: docs/PLUGIN_ISOLATION_CONTRACT.md.
 *
 * Design note: the security-critical decisions (which messages are accepted, what the
 * frame document is allowed to do, and that org is host-attached not plugin-supplied)
 * are pure exported functions so they can be pinned by unit tests. `createPluginFrame`
 * is the thin DOM wiring that composes them.
 */

import frameDepsCode from 'virtual:quox-frame-deps';

// The sandbox token set. allow-scripts lets the plugin run; the ABSENCE of
// allow-same-origin is what makes the frame an opaque origin (no parent DOM, no host
// cookies/storage). Never add allow-same-origin here — it defeats the whole boundary.
export const FRAME_SANDBOX = 'allow-scripts';

// The in-frame Content-Security-Policy. connect-src 'none' means the plugin cannot
// fetch/XHR/WebSocket/EventSource anything — all network must go through the RPC to the
// host. default-src 'none' + no blob:/https: in script-src means it cannot pull
// external code. img/font data: keep self-contained assets working.
export const FRAME_CSP = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
].join('; ');

const RPC_MARK = '__quoxPluginFrame';

/**
 * Decide whether an incoming postMessage is a legitimate message from THIS plugin
 * frame. Two independent checks, both required:
 *   1. event.source is the frame's own contentWindow (the real gate — a page cannot
 *      forge the source of a postMessage);
 *   2. the payload carries the per-frame channel token the host minted (defence in
 *      depth + routing when several frames are live).
 * A message that fails either check is dropped silently.
 * @returns {boolean}
 */
export function isMessageFromFrame(event, iframe, channel) {
    if (!event || !iframe) return false;
    if (event.source !== iframe.contentWindow) return false;
    const data = event.data;
    if (!data || typeof data !== 'object') return false;
    if (data[RPC_MARK] !== 1) return false;
    if (!channel || data.channel !== channel) return false;
    return true;
}

/**
 * Build the srcdoc document for the isolated frame. The host controls this document
 * entirely; the plugin bundle is inlined (a parent-created blob URL is parent-origin
 * and unreachable from an opaque-origin frame, so inlining is both necessary and the
 * tighter choice — no blob: in script-src).
 *
 * @param {object} p
 * @param {string} p.pluginId
 * @param {string} p.channel   per-frame random token
 * @param {string} p.bundleCode  the plugin's built ESM bundle (runs inside the frame)
 * @param {string} [p.cssCode]   optional plugin CSS (scoped to the frame document)
 * @returns {string} the srcdoc HTML
 */
export function buildFrameSrcdoc({ pluginId, channel, bundleCode, cssCode = '' }) {
    // The bootstrap shim: exposes window.quox (the mediated SDK) and
    // window.__quoxPluginRegister to the plugin, both talking ONLY via postMessage.
    // No host object, function, or credential is ever passed into the frame.
    const shim = `
(function () {
  var CH = ${JSON.stringify(channel)};
  var MARK = ${JSON.stringify(RPC_MARK)};
  var seq = 0;
  var pending = {};
  function send(kind, body) {
    parent.postMessage(Object.assign({ __quoxPluginFrame: 1, channel: CH, kind: kind }, body), '*');
  }
  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = 'c' + (++seq);
      pending[id] = { resolve: resolve, reject: reject };
      send('call', { id: id, method: method, args: args });
    });
  }
  window.addEventListener('message', function (e) {
    // Only accept messages from the host (the frame's parent) on our channel.
    if (e.source !== parent) return;
    var d = e.data;
    if (!d || d[MARK] !== 1 || d.channel !== CH) return;
    if (d.kind === 'result') {
      var p = pending[d.id];
      if (!p) return;
      delete pending[d.id];
      if (d.ok) p.resolve(d.value); else p.reject(new Error(d.error || 'plugin RPC error'));
    } else if (d.kind === 'event') {
      // Host -> frame navigation: DATA ONLY (a path string). Drives the legacy bridge.
      if (d.method === 'route' && d.args && typeof d.args.path === 'string') mountLegacyRoute(d.args.path);
      if (typeof window.__quoxPluginOnEvent === 'function') {
        try { window.__quoxPluginOnEvent(d.method, d.args); } catch (err) { /* plugin handler threw */ }
      }
    }
  });
  // The mediated SDK. Every method is an RPC — the plugin has no direct fetch/DOM/creds.
  var api = {
    pluginId: ${JSON.stringify(pluginId)},
    storage: {
      get: function (k) { return call('storage.get', { key: k }); },
      set: function (k, v) { return call('storage.set', { key: k, value: v }); },
      remove: function (k) { return call('storage.remove', { key: k }); },
      keys: function () { return call('storage.keys', {}); },
      getAll: function () { return call('storage.getAll', {}); },
    },
    fetch: function (path, options) { return call('fetch', { path: path, options: options || {} }); },
    memory: {
      save: function (entry) { return call('memory.save', { entry: entry }); },
      search: function (q, limit) { return call('memory.search', { query: q, limit: limit || 10 }); },
    },
    aee: { emit: function (intent, payload) { return call('aee.emit', { intent: intent, payload: payload }); } },
    navigate: function (p) { return call('navigate', { path: p }); },
    notify: function (m, t) { return call('notify', { message: m, type: t || 'info' }); },
    getUser: function () { return call('getUser', {}); },
    onEvent: function (fn) { window.__quoxPluginOnEvent = fn; },
  };
  window.quox = api;
  window.usePluginApi = function () { return api; };
  // Registration: the plugin declares its serialisable surfaces. React components do
  // NOT cross the boundary — the plugin renders its own UI into #plugin-root.
  // LEGACY BRIDGE (GRIPE-701). Pre-isolation bundles call
  // __quoxPluginRegister(pluginId, { routes: { path: Component }, sidebar }). The
  // components stay IN this frame; only route paths + plain-string nav entries are
  // sent to the host, which later sends a 'route' event (a path string) to pick which
  // component to mount into #plugin-root.
  var legacyRoutes = null;
  var legacyRoot = null;
  var legacyPath = null;
  function plainNav(items) {
    var out = [];
    (Array.isArray(items) ? items : []).forEach(function (it) {
      if (!it || typeof it.path !== 'string') return;
      var n = { path: it.path };
      ['label', 'icon', 'section', 'title'].forEach(function (k) { if (typeof it[k] === 'string') n[k] = it[k]; });
      out.push(n);
    });
    return out;
  }
  function mountLegacyRoute(path) {
    if (!legacyRoutes) return;
    var Comp = legacyRoutes[path];
    if (!Comp) return;
    var deps = window.__quoxSharedDeps || {};
    var R = deps.React, RD = deps.ReactDOM;
    var host = document.getElementById('plugin-root');
    if (!R || !RD || !RD.createRoot || !host) return;
    legacyPath = path;
    if (!legacyRoot) legacyRoot = RD.createRoot(host);
    var Boundary = (function (Base) {
      function B(props) { Base.call(this, props); this.state = { err: null }; }
      B.prototype = Object.create(Base.prototype);
      B.prototype.constructor = B;
      B.getDerivedStateFromError = function (err) { return { err: err }; };
      B.prototype.render = function () {
        if (this.state.err) {
          return R.createElement('pre', { style: { color: '#ff8a8a', whiteSpace: 'pre-wrap', padding: '1rem' } },
            'Plugin error: ' + String(this.state.err && this.state.err.message || this.state.err));
        }
        return this.props.children;
      };
      return B;
    })(R.Component);
    var el = R.createElement(Comp, {});
    var RR = deps.ReactRouterDOM;
    if (RR && RR.MemoryRouter) el = R.createElement(RR.MemoryRouter, { initialEntries: [path] }, el);
    // key forces a clean remount when the route changes.
    legacyRoot.render(R.createElement(Boundary, { key: path }, el));
  }
  window.__quoxPluginRegister = function (a, b) {
    if (typeof a === 'string' && b && typeof b === 'object') {
      var routes = b.routes && typeof b.routes === 'object' ? b.routes : {};
      legacyRoutes = routes;
      var paths = Object.keys(routes);
      send('register', { surfaces: {
        routes: paths.map(function (p) { return { path: p }; }),
        nav: plainNav(b.sidebar),
        panels: [],
        agent: null,
      } });
      if (paths.length) mountLegacyRoute(paths[0]);
      return;
    }
    var reg = a || {};
    send('register', { surfaces: {
      routes: reg.routes || [],
      nav: reg.nav || [],
      panels: reg.panels || [],
      agent: reg.agent || reg.agentDefinition || null,
    } });
  };
  send('boot', {});
})();
`;
    // NB: cssCode/bundleCode are attacker-influenced. They can only ever run INSIDE this
    // opaque-origin, network-less frame, so string interpolation here does not create a
    // host-side injection surface — the blast radius is the sandbox itself, by design.
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<style>html,body{margin:0;padding:0;background:transparent;color:#fff;font-family:system-ui,sans-serif}</style>
<style data-plugin-css="${pluginId}">${cssCode || ''}</style>
</head>
<body>
<div id="plugin-root" data-plugin-root="${pluginId}"></div>
<script>${frameDepsCode}</script>
<script>${shim}</script>
<script type="module">${bundleCode}</script>
</body>
</html>`;
}

/**
 * The default host-side mediator: turns an RPC call into the same collector surface the
 * legacy `createPluginApi` used, with two invariants the legacy path could not enforce
 * because the plugin ran in-parent:
 *   - the plugin cannot bypass it (it has no direct fetch), and
 *   - the ORG is attached by the host from the authenticated session, never taken from
 *     plugin input (T7 at the RPC boundary).
 *
 * `getAuthContext()` must return { userId, orgId, role, tier } resolved host-side.
 * `doFetch` defaults to the global fetch; injectable for tests.
 *
 * @returns {{ handle: (method:string, args:object) => Promise<any> }}
 */
export function createHostMediator({ pluginId, getAuthContext, collectorBase, doFetch } = {}) {
    const base = collectorBase || (typeof window !== 'undefined' && window.__quoxCollectorUrl) || '/collector';
    const fetchImpl = doFetch || ((...a) => fetch(...a));
    // F3: the plugin id is spliced into every URL, so it must be a plain slug.
    if (typeof pluginId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pluginId) || pluginId.includes('..')) {
        throw new Error('invalid_plugin_id');
    }
    const prefix = `${base}/api/v1/plugins/${pluginId}`;
    const P = (p) => `${prefix}${p.startsWith('/') ? p : '/' + p}`;

    // F3: confine any plugin-influenced path to the plugin's own namespace. Rejects
    // absolute / protocol-relative / scheme forms, backslashes, `;`, NUL/control chars,
    // and raw or (multiply) percent-encoded dot segments, THEN proves by URL resolution
    // that the final pathname is still under the prefix.
    function confine(raw) {
        const path = String(raw == null ? '' : raw);
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || path.startsWith('//') || path.startsWith('\\')) {
            throw new Error('absolute_url_forbidden');
        }
        const pathOnly = path.split(/[?#]/, 1)[0];
        let dec = pathOnly;
        for (let i = 0; i < 4; i++) {
            let next;
            try { next = decodeURIComponent(dec); } catch { throw new Error('path_forbidden'); }
            if (next === dec) break;
            dec = next;
        }
        // eslint-disable-next-line no-control-regex
        if (/[\\;\u0000-\u001f\u007f]/.test(dec) || /[\\;\u0000-\u001f\u007f]/.test(pathOnly)) throw new Error('path_forbidden');
        if (dec.startsWith('//')) throw new Error('absolute_url_forbidden');
        if (dec.split('/').some((seg) => seg === '.' || seg === '..')) throw new Error('path_forbidden');
        const url = P(path);
        let resolved;
        try {
            const origin = (typeof location !== 'undefined' && location.origin && location.origin !== 'null') ? location.origin : 'http://host.invalid';
            resolved = new URL(url, origin);
            if (resolved.origin !== new URL(prefix, origin).origin) throw new Error('x');
        } catch { throw new Error('path_forbidden'); }
        const want = new URL(prefix, resolved.origin).pathname;
        if (resolved.pathname !== want && !resolved.pathname.startsWith(want + '/')) throw new Error('path_forbidden');
        return url;
    }

    const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    const ALLOWED_HEADERS = new Set(['content-type', 'accept']);
    function safeHeaders(h) {
        const out = { 'Content-Type': 'application/json' };
        if (h && typeof h === 'object') {
            for (const [k, v] of Object.entries(h)) {
                const lk = String(k).toLowerCase();
                if (!ALLOWED_HEADERS.has(lk) || typeof v !== 'string' || /[\r\n]/.test(v)) continue;
                if (lk === 'content-type') out['Content-Type'] = v; else out.Accept = v;
            }
        }
        return out;
    }
    function storageUrl(key) {
        const k = String(key);
        if (k === '.' || k === '..' || k === '') throw new Error('path_forbidden');
        return P(`/storage/${encodeURIComponent(k)}`);
    }
    async function storageWrite(url, init) {
        const res = await fetchImpl(url, init);
        if (!res || !res.ok) throw new Error(`storage_failed:${res ? res.status : 'no_response'}`);
        return true;
    }

    // Every server call is credentialed (host session) AND stamped with the host-
    // resolved org — the plugin never supplies org_id. A missing org fails closed.
    function authOrThrow() {
        const ctx = (getAuthContext && getAuthContext()) || {};
        if (!ctx.orgId) throw new Error('no_org_context');
        return ctx;
    }

    async function json(res) { try { return await res.json(); } catch { return null; } }

    const handlers = {
        async 'storage.get'({ key }) {
            authOrThrow();
            const res = await fetchImpl(storageUrl(key), { credentials: 'include' });
            const d = await json(res); return d ? d.value : null;
        },
        async 'storage.set'({ key, value }) {
            authOrThrow();
            return storageWrite(storageUrl(key), {
                method: 'PUT', credentials: 'include',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
            });
        },
        async 'storage.remove'({ key }) {
            authOrThrow();
            return storageWrite(storageUrl(key), { method: 'DELETE', credentials: 'include' });
        },
        async 'storage.keys'() {
            authOrThrow();
            const d = await json(await fetchImpl(P('/storage'), { credentials: 'include' }));
            return Object.keys((d && d.data) || {});
        },
        async 'storage.getAll'() {
            authOrThrow();
            const d = await json(await fetchImpl(P('/storage'), { credentials: 'include' }));
            return (d && d.data) || {};
        },
        // Proxied fetch: the plugin supplies only a PATH under its own namespace, never
        // an arbitrary URL. Routed through the collector plugin gateway (licence +
        // org-scope + the F5 effect-gate live there).
        async fetch({ path, options }) {
            authOrThrow();
            const url = confine(path);
            const opts = options || {};
            const method = String(opts.method || 'GET').toUpperCase();
            if (!ALLOWED_METHODS.has(method)) throw new Error('method_forbidden');
            const res = await fetchImpl(url, {
                method,
                credentials: 'include',
                headers: safeHeaders(opts.headers),
                body: opts.body,
            });
            const body = await res.text();
            return { status: res.status, ok: res.ok, body };
        },
        async 'memory.save'({ entry }) {
            authOrThrow();
            return json(await fetchImpl(`${base}/api/v1/memory`, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...(entry || {}), source: `plugin:${pluginId}` }),
            }));
        },
        async 'memory.search'({ query, limit }) {
            authOrThrow();
            return json(await fetchImpl(`${base}/api/v1/memory/search`, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, limit: limit || 10, source: `plugin:${pluginId}` }),
            }));
        },
        async 'aee.emit'({ intent, payload }) {
            authOrThrow();
            return json(await fetchImpl(`${base}/api/v1/envelopes`, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'event', intent, payload, from: `plugin.${pluginId}` }),
            }));
        },
        async navigate({ path }) {
            // Host dispatches navigation; App-level listener validates against the
            // plugin's declared routes before honouring it.
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('quox-navigate', { detail: { path, source: pluginId } }));
            }
            return true;
        },
        async notify({ message, type }) {
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('quox-notification', { detail: { message, type, source: pluginId } }));
            }
            return true;
        },
        async getUser() {
            const ctx = (getAuthContext && getAuthContext()) || {};
            // Minimal, non-sensitive context ONLY — never a token.
            return { userId: ctx.userId || null, orgId: ctx.orgId || null, role: ctx.role || 'viewer', tier: ctx.tier || 'free' };
        },
    };

    return {
        async handle(method, args) {
            const h = handlers[method];
            if (!h) throw new Error(`unknown_method:${method}`);
            return h(args || {});
        },
    };
}

/**
 * Mint a per-frame random channel token. Uses webcrypto where available.
 * @returns {string}
 */
export function mintChannel() {
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
    if (c && c.getRandomValues) {
        const a = new Uint8Array(16);
        c.getRandomValues(a);
        return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    // Deterministic-random fallback is unacceptable for a security token; if webcrypto
    // is absent we refuse rather than mint a guessable channel.
    throw new Error('no_secure_random_for_channel');
}

/**
 * Create and mount an isolated plugin frame.
 *
 * @param {object} p
 * @param {string} p.pluginId
 * @param {string} p.bundleCode
 * @param {string} [p.cssCode]
 * @param {HTMLElement} p.mountEl        where to append the iframe
 * @param {object} p.mediator           result of createHostMediator (host-side caps)
 * @param {number} [p.registerTimeoutMs]
 * @returns {{ iframe: HTMLIFrameElement, channel: string, registration: Promise<object>,
 *             emit: (method:string, args:object)=>void, destroy: ()=>void }}
 */
export function createPluginFrame({ pluginId, bundleCode, cssCode, mountEl, mediator, registerTimeoutMs = 10000 }) {
    if (typeof document === 'undefined') throw new Error('createPluginFrame requires a DOM');
    const channel = mintChannel();
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', FRAME_SANDBOX);
    iframe.setAttribute('data-plugin', pluginId);
    iframe.setAttribute('title', `plugin:${pluginId}`);
    iframe.style.cssText = 'width:100%;height:100%;border:0;background:transparent;';
    iframe.srcdoc = buildFrameSrcdoc({ pluginId, channel, bundleCode, cssCode });

    let resolveReg, rejectReg;
    const registration = new Promise((res, rej) => { resolveReg = res; rejectReg = rej; });
    const timer = setTimeout(() => rejectReg(new Error(`plugin ${pluginId} did not register in ${registerTimeoutMs}ms`)), registerTimeoutMs);

    async function onMessage(event) {
        if (!isMessageFromFrame(event, iframe, channel)) return; // hard gate
        const d = event.data;
        if (d.kind === 'register') {
            clearTimeout(timer);
            resolveReg(d.surfaces || {});
            return;
        }
        if (d.kind === 'call') {
            let reply;
            try {
                const value = await mediator.handle(d.method, d.args);
                reply = { [RPC_MARK]: 1, channel, kind: 'result', id: d.id, ok: true, value };
            } catch (err) {
                reply = { [RPC_MARK]: 1, channel, kind: 'result', id: d.id, ok: false, error: String(err && err.message || err) };
            }
            if (iframe.contentWindow) iframe.contentWindow.postMessage(reply, '*');
        }
        // 'boot' is informational; no action required.
    }

    window.addEventListener('message', onMessage);
    if (mountEl) mountEl.appendChild(iframe);

    return {
        iframe,
        channel,
        registration,
        emit(method, args) {
            if (iframe.contentWindow) {
                iframe.contentWindow.postMessage({ [RPC_MARK]: 1, channel, kind: 'event', method, args }, '*');
            }
        },
        destroy() {
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            iframe.remove();
        },
    };
}
