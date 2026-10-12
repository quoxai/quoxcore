/**
 * Docker Fleet — first-party plugin entry (LICENSE-LAUNCH LL-7 increment 3c).
 *
 * A THIN entry, following the quoxbox-macmini pilot exactly. It imports the
 * existing view from its current home in the dashboard source tree rather than
 * moving it: the strip is about proving the loader contract, not relocating
 * code. Rollup follows the import from here, so DockerView (and DockerDashboard +
 * DockerChatSidebar, which only it uses) compile into plugin.esm.js and are NOT
 * reachable from the free dashboard build once the /docker row and its lazy()
 * import are deleted from the core tables. The Docker fleet collector routes are
 * a BACKEND surface, entitlement-gated server-side, and are left in place.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/docker) only because the host verifies
 *     the Ed25519 signature over this plugin's manifest against a Quox
 *     publisher key. Unsigned, it lands under /plugins/docker-fleet/.
 *   - Route guards live in the SIGNED manifest (routeGuards), not here: /docker
 *     was minRole 'builder' in core, preserved in manifest.routeGuards.
 */

import DockerView from '../../src/pages/views/DockerView.jsx'

const PLUGIN_ID = 'docker-fleet'

const pluginExports = {
    routes: {
        '/docker': DockerView,
    },
    sidebar: [
        { path: '/docker', label: 'Docker Fleet', icon: 'docker', minRole: 'builder' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_docker-fleet',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
