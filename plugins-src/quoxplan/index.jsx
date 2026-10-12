/**
 * QuoxPlan — first-party plugin entry (LICENSE-LAUNCH LL-7 increment 4a).
 *
 * A THIN entry, following the quoxsignal / qlarity / web-terminal pattern
 * exactly. It imports the existing view from its current home in the dashboard
 * source tree rather than moving it: the strip is about proving the loader
 * contract, not relocating code. Rollup follows the import from here, so
 * QuoxPlanView (and its sub-views, RoadyRail, contexts and lib/* helpers)
 * compile into plugin.esm.js and are NOT reachable from the free dashboard build
 * once the /quoxplan/* row and its lazy() import are deleted from the core tables.
 *
 * The QuoxPlan API client that OnboardView still needs was extracted to a CORE
 * service (src/services/quoxplanApiClient.js) in the prior commit, so the free
 * build no longer reaches into this plugin at all.
 *
 * The QuoxPlan service (repo quoxai/quoxplan, :3107) + its /api/v1/quoxplan/*
 * collector proxy are BACKEND surfaces, entitlement-gated in the collector, and
 * are left in place — only the FRONTEND view strips.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/quoxplan/*) only because the host verifies
 *     the Ed25519 signature over this plugin's manifest against a Quox publisher
 *     key. Unsigned, it lands under /plugins/quoxplan/.
 *   - The stripped /quoxplan/* core row was ungated, so no routeGuards.
 */

import QuoxPlanView from '../../src/components/quoxplan/QuoxPlanView.jsx'

const PLUGIN_ID = 'quoxplan'

const pluginExports = {
    routes: {
        '/quoxplan/*': QuoxPlanView,
    },
    sidebar: [
        { path: '/quoxplan', label: 'QuoxPlan', icon: 'octahedron', badge: 'NEW' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_quoxplan',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
