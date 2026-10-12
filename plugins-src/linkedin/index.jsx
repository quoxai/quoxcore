/**
 * LinkedIn — first-party plugin entry (LICENSE-LAUNCH LL-7 increment 3d).
 *
 * A THIN entry, following the quoxbox-macmini pilot exactly. It imports the
 * existing view from its current home in the dashboard source tree rather than
 * moving it: the strip is about proving the loader contract, not relocating
 * code. Rollup follows the import from here, so the view (and the
 * components/linkedin dir + useLinkedInData, which only it uses) compile into
 * plugin.esm.js and are NOT reachable from the free dashboard build once the
 * /linkedin row and its lazy() import are deleted from the core tables.
 * NOTE (LI-OVERHAUL P6): there are NO backend LinkedIn OAuth routes — an
 * earlier version of this comment asserted some existed. Auth is a pasted
 * 60-day vault token (type 'linkedin'); a real OAuth broker is future work.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/linkedin) only because the host verifies
 *     the Ed25519 signature over this plugin's manifest against a Quox
 *     publisher key. Unsigned, it lands under /plugins/linkedin/.
 *   - The stripped /linkedin core row was ungated, so no routeGuards.
 */

import LinkedInView from '../../src/pages/views/LinkedInView.jsx'

const PLUGIN_ID = 'linkedin'

const pluginExports = {
    routes: {
        '/linkedin': LinkedInView,
    },
    sidebar: [
        { path: '/linkedin', label: 'LinkedIn', icon: 'linkedin', badge: 'NEW' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_linkedin',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
