/**
 * QuoxBox — Mac mini · first-party plugin entry (LICENSE-LAUNCH LL-7 pilot).
 *
 * This is a THIN entry, deliberately. It imports the existing view from its
 * current home in the dashboard source tree rather than moving it: LL-7
 * increment 1 is about proving the loader contract, not about relocating code.
 * Rollup follows the import from here, so the view and its hook are compiled
 * into plugin.esm.js and are NOT reachable from the free dashboard build once
 * the /quoxbox row and its lazy() import are deleted from the core tables.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - Routes keep their ROOT path (/quoxbox) only because the host verifies
 *     the Ed25519 signature over this plugin's manifest against a Quox
 *     publisher key. Unsigned, it lands under /plugins/quoxbox-macmini/.
 *   - Route guards live in the SIGNED manifest (routeGuards), not here.
 */

import QuoxBoxView from '../../src/pages/views/QuoxBoxView.jsx'

const PLUGIN_ID = 'quoxbox-macmini'

const pluginExports = {
    routes: {
        '/quoxbox': QuoxBoxView,
    },
    sidebar: [
        { path: '/quoxbox', label: 'QuoxBox', icon: 'server' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through. Terser/esbuild do not
    // mangle property names by default, so both the key and the value string
    // land verbatim in plugin.esm.js.
    __qxSentinel: 'QX_P1_quoxbox-macmini',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
