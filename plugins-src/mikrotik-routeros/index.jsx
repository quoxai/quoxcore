/**
 * RouterOS (mikrotik-routeros) — first-party plugin entry (LICENSE-LAUNCH LL-7
 * increment 3h).
 *
 * A THIN entry, following the bastion-fleet pattern exactly (the closest sibling:
 * a guarded route). It imports the existing view from its current home in the
 * dashboard source tree rather than moving it: the strip is about proving the
 * loader contract, not relocating code. Rollup follows the import from here, so
 * RouterOSView (and its components/routeros subtree — the setup wizard, health /
 * inventory / DHCP / alerts / VPN panels and the device/lease/troubleshoot
 * modals) compile into plugin.esm.js and are NOT reachable from the free
 * dashboard build once the /routeros row and its lazy() import are deleted from
 * the core tables.
 *
 * The canonical catalogue id is mikrotik-routeros (plugins/mikrotik.json,
 * plugins/index.js, stripRegistry, firstPartyPlugins), so the plugin dir and the
 * signed manifest use it; the ROUTE stays /routeros. "RouterOS" as an INTEGRATION
 * TYPE at the service level (services/routerosClient.js, config/extensions.js)
 * stays in core — other code depends on it. Only the FRONTEND view strips.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/routeros) only because the host verifies the
 *     Ed25519 signature over this plugin's manifest against a Quox publisher key.
 *     Unsigned, it lands under /plugins/mikrotik-routeros/.
 *   - Route guards live in the SIGNED manifest (routeGuards), not here: /routeros
 *     was minRole 'builder' in core, preserved in manifest.routeGuards.
 */

import RouterOSView from '../../src/pages/views/RouterOSView.jsx'

const PLUGIN_ID = 'mikrotik-routeros'

const pluginExports = {
    routes: {
        '/routeros': RouterOSView,
    },
    sidebar: [
        { path: '/routeros', label: 'RouterOS', icon: 'globe', minRole: 'builder' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_mikrotik-routeros',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
