/**
 * X — first-party plugin entry (X-PLUGIN P3).
 *
 * A THIN entry, modelled on plugins-src/linkedin/index.jsx. It imports the
 * view from its home in the dashboard source tree; Rollup follows the import
 * from here so XView + src/components/x/* + src/services/xClient.js compile
 * into plugin.esm.js.
 *
 * UNLIKE linkedin, X is NOT yet stripped from the core build: the /x route,
 * App.jsx lazy import and nav rail row are still core edges (stripRegistry
 * status: pending). This bundle is additive today — when the strip increment
 * lands, deleting those core edges is what makes this bundle the only way to
 * reach the view, exactly as LL-7 increment 3d did for linkedin.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps (@quoxai/quox-plugin-vite
 *     externalisation), so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/x) only because the host verifies the
 *     Ed25519 signature over this manifest against a Quox publisher key.
 *     Unsigned, it lands under /plugins/x/.
 *
 * accentColor note: the brand accent is pure black (#000000), which is
 * invisible on the dark cinematic background — UI surfaces use the visible
 * fallback #E7E9EA (manifest.accentColorFallback) wherever the accent must
 * actually be seen.
 */

import XView from '../../src/pages/views/XView.jsx'

const PLUGIN_ID = 'x'

const pluginExports = {
    routes: {
        '/x': XView,
    },
    sidebar: [
        { path: '/x', label: 'X', icon: 'x', badge: 'NEW' },
    ],
    // Dist-scan positive-control marker that survives minification: a property
    // on the object handed to __quoxPluginRegister cannot be tree-shaken,
    // because the object escapes into a call the bundler cannot see through
    // (same rationale as linkedin's LL-7 review note 2).
    __qxSentinel: 'QX_P1_x',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
