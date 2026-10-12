/**
 * Wazuh SIEM — first-party plugin entry (LICENSE-LAUNCH LL-7 increment 3f).
 *
 * A THIN entry, following the web-terminal / bastion-fleet pattern exactly. It
 * imports the existing view from its current home in the dashboard source tree
 * rather than moving it: the strip is about proving the loader contract, not
 * relocating code. Rollup follows the import from here, so WazuhView (and the
 * components/wazuh/* panels + chat + setup gate it uses) compile into
 * plugin.esm.js and are NOT reachable from the free dashboard build once the
 * /wazuh row and its lazy() import are deleted from the core tables.
 *
 * The 16 Wazuh collector handlers stay SERVER-SIDE (a BACKEND surface); only the
 * frontend view strips. Shared services the view leans on (licenseValidator,
 * AuthContext, PageLayout) stay in core because other core code imports them;
 * they simply ship a second copy inside this bundle too.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/wazuh) only because the host verifies the
 *     Ed25519 signature over this plugin's manifest against a Quox publisher key.
 *     Unsigned, it lands under /plugins/wazuh/.
 *   - Route guards live in the SIGNED manifest (routeGuards), not here: /wazuh
 *     was minRole 'builder' in core, preserved in manifest.routeGuards.
 */

import WazuhView from '../../src/pages/views/WazuhView.jsx'

const PLUGIN_ID = 'wazuh'

const pluginExports = {
    routes: {
        '/wazuh': WazuhView,
    },
    sidebar: [
        { path: '/wazuh', label: 'Wazuh SIEM', icon: 'wazuh', minRole: 'builder' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_wazuh',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
