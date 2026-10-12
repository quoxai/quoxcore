/**
 * TikTok — first-party plugin entry (TT-4). Twin of plugins-src/instagram/index.jsx.
 *
 * A THIN entry, following the instagram/facebook pattern exactly. It imports
 * the existing view from its current home in the dashboard source tree
 * rather than moving it: the strip is about proving the loader contract,
 * not relocating code. Rollup follows the import from here, so the view
 * (and the components/tiktok dir + useTikTokData, which only it uses)
 * compile into plugin.esm.js and are NOT reachable from the free dashboard
 * build once the /tiktok row and its lazy() import are deleted from the
 * core tables. TikTok has its OWN dedicated vault credential type
 * ('tiktok'), not shared with any other plugin.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/tiktok) only because the host verifies
 *     the Ed25519 signature over this plugin's manifest against a Quox
 *     publisher key. Unsigned, it lands under /plugins/tiktok/.
 *   - The stripped /tiktok core row was ungated, so no routeGuards.
 */

import TikTokView from '../../src/pages/views/TikTokView.jsx'

const PLUGIN_ID = 'tiktok'

const pluginExports = {
    routes: {
        '/tiktok': TikTokView,
    },
    sidebar: [
        { path: '/tiktok', label: 'TikTok', icon: 'tiktok', badge: 'NEW' },
    ],
    // Same sentinel discipline as instagram: a bare unused const is
    // tree-shaken; a property on the object handed to
    // __quoxPluginRegister cannot be, because the object escapes into a
    // call the bundler cannot see through.
    __qxSentinel: 'QX_P1_tiktok',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
