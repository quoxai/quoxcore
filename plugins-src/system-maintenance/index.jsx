/**
 * System Maintenance — first-party plugin entry (LICENSE-LAUNCH LL-7 increment 3a).
 *
 * A THIN entry, following the quoxbox-macmini pilot exactly. It imports the
 * existing view from its current home in the dashboard source tree rather than
 * moving it. Rollup follows the import from here, so SystemMaintenanceView and
 * the maintenance components only it uses (KeeperChatSidebar, UpdatePanel …)
 * compile into plugin.esm.js and are NOT reachable from the free dashboard build
 * once the /system row and its lazy() import are deleted from the core tables.
 *
 * Note: SystemMaintenanceView renders BackupPanel from the backup-restore
 * plugin's component dir as a tab, so backup's UI rides into this bundle. That
 * is the current shape (backup-restore has no route of its own — see
 * src/config/stripRegistry.js), not a decision made here.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/system) only because the host verifies the
 *     Ed25519 signature over this plugin's manifest against a Quox publisher key.
 *     Unsigned, it lands under /plugins/system-maintenance/.
 *   - Route guards live in the SIGNED manifest (routeGuards), not here.
 */

import SystemMaintenanceView from '../../src/pages/views/SystemMaintenanceView.jsx'

const PLUGIN_ID = 'system-maintenance'

const pluginExports = {
    routes: {
        '/system': SystemMaintenanceView,
    },
    sidebar: [
        { path: '/system', label: 'System Maintenance', icon: 'shield', minRole: 'admin' },
    ],
    // LL-7 review note 2: a marker that SURVIVES minification must be a property
    // on the object handed to __quoxPluginRegister, not a bare const (which would
    // be tree-shaken out of plugin.esm.js and kill the dist-scan positive control).
    __qxSentinel: 'QX_P1_system-maintenance',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
