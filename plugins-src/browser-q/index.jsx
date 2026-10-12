/**
 * Browser-Q — first-party plugin entry (LICENSE-LAUNCH LL-7 increment 3c).
 *
 * A THIN entry, following the quoxbox-macmini pilot exactly. It imports the
 * existing views from their current home in the dashboard source tree rather
 * than moving them: the strip is about proving the loader contract, not
 * relocating code. Rollup follows the imports from here, so both views (and the
 * components/browser-q dir + browserQService, which only they use) compile into
 * plugin.esm.js and are NOT reachable from the free dashboard build once the
 * /browser-q rows and their lazy() imports are deleted from the core tables. The
 * browser-q collector routes (/api/browser-q, screencap) are a BACKEND surface,
 * entitlement-gated server-side, and are left in place.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The routes keep their ROOT paths (/browser-q, /browser-q/run/:objectiveId)
 *     only because the host verifies the Ed25519 signature over this plugin's
 *     manifest against a Quox publisher key. Unsigned, they land under
 *     /plugins/browser-q/.
 *   - Both stripped core rows were UNGATED, so no routeGuards.
 */

import BrowserQView from '../../src/pages/views/BrowserQView.jsx'
import BrowserQRunDetailView from '../../src/pages/views/BrowserQRunDetailView.jsx'

const PLUGIN_ID = 'browser-q'

const pluginExports = {
    routes: {
        '/browser-q': BrowserQView,
        '/browser-q/run/:objectiveId': BrowserQRunDetailView,
    },
    sidebar: [
        { path: '/browser-q', label: 'Browser-Q', icon: 'globe', badge: 'NEW' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_browser-q',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
