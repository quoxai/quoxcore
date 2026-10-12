/**
 * Dev Servers — first-party plugin entry (LICENSE-LAUNCH LL-7 dev-servers strip).
 *
 * A THIN entry, following the quoxbox-macmini/browser-q pilots exactly. It
 * imports the existing views from their current home in the dashboard source
 * tree rather than moving them: the strip is about proving the loader
 * contract, not relocating code. Rollup follows the imports from here, so all
 * three views compile into plugin.esm.js and are NOT reachable from the free
 * dashboard build once their rows and lazy() imports are deleted from the
 * core tables (App.jsx, routeRegistry.js, navRegistry.js).
 *
 * DevServersHubPanel + DocsPanel (the actual hub CONTENT — inventory grid,
 * capability pills, docs browser) are a DIFFERENT, CORE surface: they moved to
 * src/components/core/devsuite/ in the prior LL-7 extraction and render on the
 * ungated /infra route for every org regardless of licence. Only the /dev-suite
 * drill-in routes (the tabbed hub page, the per-host capability detail page,
 * and the per-host resident page) strip here. That split is deliberate: it is
 * what keeps the owner-intended "hub is always reachable" behaviour true after
 * a paid strip, per docs/LL5_CLASSIFICATION_TABLE_2026-08-28.md's ratified
 * Group B ruling on dev-servers.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The routes keep their ROOT paths (/dev-suite, /dev-suite/servers/:hostId,
 *     /quoxperticus/:hostId) only because the host verifies the Ed25519
 *     signature over this plugin's manifest against a Quox publisher key.
 *     Unsigned, they land under /plugins/dev-servers/.
 *   - All three stripped core rows were UNGATED at the route level (licence
 *     gate lived inside each view via isPluginLicensed), so no routeGuards.
 */

import DevSuiteView from '../../src/pages/views/DevSuiteView.jsx'
import DevSuiteHostDetailView from '../../src/pages/views/DevSuiteHostDetailView.jsx'
import QuoxperticusResidentView from '../../src/pages/views/QuoxperticusResidentView.jsx'

const PLUGIN_ID = 'dev-servers'

const pluginExports = {
    routes: {
        '/dev-suite': DevSuiteView,
        '/dev-suite/servers/:hostId': DevSuiteHostDetailView,
        '/quoxperticus/:hostId': QuoxperticusResidentView,
    },
    sidebar: [
        { path: '/dev-suite', label: 'Dev Servers', icon: 'server', badge: 'NEW' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_dev-servers',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
