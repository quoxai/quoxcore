/**
 * TailMesh (tailscale) — first-party plugin entry (LICENSE-LAUNCH LL-7 increment 3h).
 *
 * A THIN entry, following the bastion-fleet pattern exactly (bastion-fleet is the
 * closest sibling: a guarded route). It imports the existing view from its current
 * home in the dashboard source tree rather than moving it: the strip is about
 * proving the loader contract, not relocating code. Rollup follows the import from
 * here, so TailscaleView (and its components/tailscale subtree — MeshOverview,
 * RoutesPanel, KeysPanel, TailscaleChatSidebar, ActivityPanel) compile into
 * plugin.esm.js and are NOT reachable from the free dashboard build once the
 * /tailscale row and its lazy() import are deleted from the core tables.
 *
 * IMPORTANT: only the VIEW strips. "Tailscale" as an INTEGRATION TYPE at the
 * service/config level (services/tailscaleClient.js, config/integrationTypes.js,
 * config/extensions.js) and the shared CrossOrgCredentialBanner stay in core —
 * they are separate surfaces other code depends on.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/tailscale) only because the host verifies
 *     the Ed25519 signature over this plugin's manifest against a Quox publisher
 *     key. Unsigned, it lands under /plugins/tailscale/.
 *   - Route guards live in the SIGNED manifest (routeGuards), not here: /tailscale
 *     was minRole 'viewer' in core, preserved in manifest.routeGuards.
 */

import TailscaleView from '../../src/pages/views/TailscaleView.jsx'

const PLUGIN_ID = 'tailscale'

const pluginExports = {
    routes: {
        '/tailscale': TailscaleView,
    },
    sidebar: [
        { path: '/tailscale', label: 'TailMesh', icon: 'globe', badge: 'NEW', minRole: 'viewer' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_tailscale',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
