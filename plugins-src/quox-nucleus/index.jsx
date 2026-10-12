/**
 * RepoBrain (quox-nucleus) — first-party plugin entry (LICENSE-LAUNCH LL-7
 * increment 3g).
 *
 * A THIN entry, following the qlarity / web-terminal pattern exactly. It imports
 * the existing view from its current home in the dashboard source tree rather
 * than moving it: the strip is about proving the loader contract, not relocating
 * code. Rollup follows the import from here, so RepoBrainView (and the
 * components/nucleus/* tabs — CodeSearch, CodebaseGraph, ManageRepos,
 * ConnectionsView, HowToUseView, RepoBrainContext) compile into plugin.esm.js and
 * are NOT reachable from the free dashboard build once the /nucleus row and its
 * lazy() import are deleted from the core tables. Shared UI (QHorn) the view leans
 * on stays in core because other core code imports it; it simply ships a second
 * copy inside this bundle too.
 *
 * The RepoBrain engine (repo quox-repobrain, :3105) + its collector proxy are a
 * separate BACKEND surface, entitlement-gated, and are left in place — only the
 * FRONTEND view strips. The /nucleus/graph and /nucleus/repos redirects stay in
 * App.jsx: they only <Navigate> to /nucleus and never reference the view, so they
 * do not re-arm the free-build edge.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/nucleus) only because the host verifies the
 *     Ed25519 signature over this plugin's manifest against a Quox publisher key.
 *     Unsigned, it lands under /plugins/quox-nucleus/.
 *   - The stripped /nucleus core row was UNGATED, so no routeGuards.
 */

import RepoBrainView from '../../src/components/nucleus/RepoBrainView.jsx'

const PLUGIN_ID = 'quox-nucleus'

const pluginExports = {
    routes: {
        '/nucleus': RepoBrainView,
    },
    sidebar: [
        { path: '/nucleus', label: 'RepoBrain', icon: 'code-2', badge: 'NEW' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_quox-nucleus',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
