/**
 * Instagram — first-party plugin entry (IG-3). Twin of plugins-src/facebook/index.jsx.
 *
 * A THIN entry, following the facebook/linkedin pattern exactly. It imports
 * the existing view from its current home in the dashboard source tree
 * rather than moving it: the strip is about proving the loader contract,
 * not relocating code. Rollup follows the import from here, so the view
 * (and the components/instagram dir + useInstagramData, which only it uses)
 * compile into plugin.esm.js and are NOT reachable from the free dashboard
 * build once the /instagram row and its lazy() import are deleted from the
 * core tables. Auth is the SAME pasted long-lived Facebook Page access
 * token the facebook plugin uses (vault credential type 'meta'); there is
 * no separate Instagram credential or OAuth broker.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/instagram) only because the host verifies
 *     the Ed25519 signature over this plugin's manifest against a Quox
 *     publisher key. Unsigned, it lands under /plugins/instagram/.
 *   - The stripped /instagram core row was ungated, so no routeGuards.
 */

import InstagramView from '../../src/pages/views/InstagramView.jsx'

const PLUGIN_ID = 'instagram'

const pluginExports = {
    routes: {
        '/instagram': InstagramView,
    },
    sidebar: [
        { path: '/instagram', label: 'Instagram', icon: 'instagram', badge: 'NEW' },
    ],
    // Same sentinel discipline as facebook: a bare unused const is
    // tree-shaken; a property on the object handed to
    // __quoxPluginRegister cannot be, because the object escapes into a
    // call the bundler cannot see through.
    __qxSentinel: 'QX_P1_instagram',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
