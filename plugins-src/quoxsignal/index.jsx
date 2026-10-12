/**
 * QuoxSignal — first-party plugin entry (LICENSE-LAUNCH LL-7 increment 3g).
 *
 * A THIN entry, following the qlarity / web-terminal pattern exactly. It imports
 * the existing view from its current home in the dashboard source tree rather
 * than moving it: the strip is about proving the loader contract, not relocating
 * code. Rollup follows the import from here, so QuoxSignalView (and its sub-views,
 * ScoutChatSidebar, QuoxSignalLocked, and the lib/* clients it uses — including
 * the quoxplan lib/api it reaches into as a PLUGIN-to-PLUGIN dependency) compile
 * into plugin.esm.js and are NOT reachable from the free dashboard build once the
 * /quoxsignal/* row and its lazy() import are deleted from the core tables.
 *
 * The quoxsignal service (repo quoxai/quoxsignal, :3108) + its collector proxy
 * are BACKEND surfaces, entitlement-gated in services/collector/server.js's
 * /api/v1/signal/* mount, and are left in place — only the FRONTEND view strips.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/quoxsignal/*) only because the host verifies
 *     the Ed25519 signature over this plugin's manifest against a Quox publisher
 *     key. Unsigned, it lands under /plugins/quoxsignal/.
 *   - The stripped /quoxsignal/* core row was ungated, so no routeGuards.
 */

import QuoxSignalView from '../../src/components/quoxsignal/QuoxSignalView.jsx'

const PLUGIN_ID = 'quoxsignal'

const pluginExports = {
    routes: {
        '/quoxsignal/*': QuoxSignalView,
    },
    sidebar: [
        { path: '/quoxsignal', label: 'QuoxSignal', icon: 'signal', badge: 'NEW' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_quoxsignal',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
