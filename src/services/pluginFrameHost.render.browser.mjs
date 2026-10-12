/**
 * QUOXTRUST F2 — real-browser RENDER proof for the isolated frame host (the functional
 * twin of pluginFrameHost.browser.mjs's containment proof). A BENIGN plugin renders its
 * own UI into #plugin-root inside the sandboxed iframe, declares a route, and a mediated
 * storage RPC round-trips. Playwright reads INSIDE the sandboxed frame (via the frame
 * handle, which works regardless of the opaque origin) to prove the UI actually painted.
 *
 * Run: node src/services/pluginFrameHost.render.browser.mjs   (exit 0 = renders + RPC OK)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// pluginFrameHost.js imports the build-time virtual module; resolve it here with the same esbuild bundle.
import { buildFrameDepsCode } from '../../scripts/vite-plugin-frame-deps.mjs';
const moduleSrc = readFileSync(path.join(__dirname, 'pluginFrameHost.js'), 'utf8')
    .replace(/^import frameDepsCode from 'virtual:quox-frame-deps';$/m,
        `const frameDepsCode = ${JSON.stringify(await buildFrameDepsCode())};`);

// A benign plugin: renders visible UI into #plugin-root, registers a route, does a
// mediated storage round-trip, and re-renders on the host's 'route' event.
const BENIGN_BUNDLE = `
  var root = document.getElementById('plugin-root');
  function render(label) {
    root.innerHTML = '<h1 id="plugin-ui">Hello from isolated plugin</h1><p id="route-label">' + (label || 'boot') + '</p>';
  }
  render('boot');
  window.__quoxPluginRegister({ routes: [{ path: '/dash', title: 'Dash' }], nav: [{ id: 'n', label: 'Acme', route: '/dash' }] });
  window.quox.onEvent(function (method, args) { if (method === 'route') render('route:' + args.path); });
  // exercise the mediated RPC end to end
  window.quox.storage.set('k', 'v-123').then(function () {
    return window.quox.storage.get('k');
  }).then(function (v) {
    var el = document.createElement('div'); el.id = 'rpc-result'; el.textContent = 'storage=' + v; root.appendChild(el);
  });
`;

const HARNESS = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="mount" style="width:800px;height:400px"></div>
<script type="module">
import { createPluginFrame, createHostMediator } from '/pluginFrameHost.js';
const store = {};
const mediator = createHostMediator({
  pluginId: 'benign',
  getAuthContext: () => ({ userId: 'u1', orgId: 'ORG', role: 'admin', tier: 'pro' }),
  collectorBase: '/collector',
  // Simulate the collector storage endpoints so storage.set/get round-trips host-side.
  doFetch: async (url, opts) => {
    const m = String(url).match(/\\/storage\\/([^/?]+)/);
    const key = m ? decodeURIComponent(m[1]) : null;
    if (opts && opts.method === 'PUT') { store[key] = JSON.parse(opts.body).value; return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }; }
    return { ok: true, status: 200, json: async () => ({ value: store[key] ?? null, data: store }), text: async () => JSON.stringify(store) };
  },
});
const frame = createPluginFrame({ pluginId: 'benign', bundleCode: ${JSON.stringify(BENIGN_BUNDLE)}, mountEl: document.getElementById('mount'), mediator });
frame.registration.then((s) => { window.__surfaces = s; });
window.__frame = frame;
window.__ready = true;
</script>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.endsWith('/pluginFrameHost.js')) return route.fulfill({ contentType: 'text/javascript', body: moduleSrc });
    if (u.includes('/harness.html')) return route.fulfill({ contentType: 'text/html', body: HARNESS });
    return route.fulfill({ status: 404, body: '' });
});
await page.goto('http://localhost.test/harness.html');
await page.waitForFunction('window.__ready === true');
await page.waitForTimeout(1200);

// The iframe is a real frame in the page; Playwright can query inside it despite the
// opaque origin. Find the plugin frame and read its rendered UI.
const frames = page.frames();
let pluginText = null, routeLabel = null, rpcResult = null, surfaces = null;
for (const f of frames) {
    if (f === page.mainFrame()) continue;
    try {
        const h1 = await f.$('#plugin-ui');
        if (h1) {
            pluginText = await f.textContent('#plugin-ui');
            // Read the RPC result FIRST — the route event below re-renders #plugin-root
            // (wiping the appended #rpc-result node), so capture it before emitting.
            try { await f.waitForSelector('#rpc-result', { timeout: 2000 }); rpcResult = await f.textContent('#rpc-result'); }
            catch { rpcResult = null; }
            // Now emit a host route event and confirm the plugin re-rendered for it.
            await page.evaluate(() => window.__frame.emit('route', { path: '/dash' }));
            await page.waitForTimeout(300);
            routeLabel = await f.textContent('#route-label');
        }
    } catch { /* not this frame */ }
}
surfaces = await page.evaluate(() => window.__surfaces || null);

await browser.close();

const fails = [];
if (pluginText !== 'Hello from isolated plugin') fails.push(`plugin UI did not render in the iframe (got: ${JSON.stringify(pluginText)})`);
if (routeLabel !== 'route:/dash') fails.push(`plugin did not receive the host 'route' event (got: ${JSON.stringify(routeLabel)})`);
if (rpcResult !== 'storage=v-123') fails.push(`mediated storage RPC did not round-trip (got: ${JSON.stringify(rpcResult)})`);
if (!surfaces || !Array.isArray(surfaces.routes) || surfaces.routes[0]?.path !== '/dash') fails.push(`declarative surfaces did not register (got: ${JSON.stringify(surfaces)})`);

console.log('F2 render smoke:', JSON.stringify({ pluginText, routeLabel, rpcResult, surfaces }, null, 2));
if (fails.length) { console.error('\n❌ F2 RENDER FAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('\n✅ F2 RENDER PASSED: an isolated plugin renders its own UI in the sandboxed iframe, receives host route events, and its mediated RPC round-trips.');
process.exit(0);
