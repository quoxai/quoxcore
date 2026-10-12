/**
 * Quox CoreComms — first-party plugin entry (LICENSE-LAUNCH LL-7 increment 3f).
 *
 * A THIN entry, following the telegram-pro / quoxbox-macmini pattern exactly. It
 * imports the existing view from its current home in the dashboard source tree
 * rather than moving it: the strip is about proving the loader contract, not
 * relocating code. Rollup follows the import from here, so CommsView (and the
 * components/comms/* panels + useCommsData, which only it uses) compile into
 * plugin.esm.js and are NOT reachable from the free dashboard build once the
 * /comms row and its lazy() import are deleted from the core tables.
 *
 * MatrixCommsView (/matrix-comms) is a SEPARATE, surviving core view whose name
 * merely ends in "CommsView"; it stays in the free build. The strip-boundary
 * selector was anchored in increment 3f precisely so this basename cannot
 * substring-match that surviving import. The collector notification surfaces
 * (auth routes/messages.js + routes/notifications.js) are a BACKEND surface and
 * are left in place; CoreCommsSettings.jsx stays in core Settings.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/comms) only because the host verifies the
 *     Ed25519 signature over this plugin's manifest against a Quox publisher key.
 *     Unsigned, it lands under /plugins/core-comms/.
 *   - The stripped /comms core row was ungated (pluginId was metadata, not a
 *     guard), so no routeGuards.
 */

import CommsView from '../../src/pages/views/CommsView.jsx'

const PLUGIN_ID = 'core-comms'

const pluginExports = {
    routes: {
        '/comms': CommsView,
    },
    sidebar: [
        { path: '/comms', label: 'Comms', icon: 'bell', shortcut: 'C' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_core-comms',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
