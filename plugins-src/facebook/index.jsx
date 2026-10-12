/**
 * Facebook — first-party plugin entry (FB-3). Twin of plugins-src/linkedin/index.jsx.
 *
 * A THIN entry, following the linkedin/quoxbox-macmini pattern exactly. It
 * imports the existing view from its current home in the dashboard source
 * tree rather than moving it: the strip is about proving the loader
 * contract, not relocating code. Rollup follows the import from here, so the
 * view (and the components/facebook dir + useFacebookData, which only it
 * uses) compile into plugin.esm.js and are NOT reachable from the free
 * dashboard build once the /facebook row and its lazy() import are deleted
 * from the core tables. Auth is a pasted long-lived Page access token
 * (vault credential type 'meta'); a real OAuth broker is future work.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/facebook) only because the host verifies
 *     the Ed25519 signature over this plugin's manifest against a Quox
 *     publisher key. Unsigned, it lands under /plugins/facebook/.
 *   - The stripped /facebook core row was ungated, so no routeGuards.
 */

import FacebookView from '../../src/pages/views/FacebookView.jsx'

const PLUGIN_ID = 'facebook'

const pluginExports = {
    routes: {
        '/facebook': FacebookView,
    },
    sidebar: [
        { path: '/facebook', label: 'Facebook', icon: 'facebook', badge: 'NEW' },
    ],
    // Same sentinel discipline as linkedin: a bare unused const is
    // tree-shaken; a property on the object handed to
    // __quoxPluginRegister cannot be, because the object escapes into a
    // call the bundler cannot see through.
    __qxSentinel: 'QX_P1_facebook',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
