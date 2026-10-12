/**
 * Proxmox VE — first-party plugin entry (LICENSE-LAUNCH LL-7 monitoring strip).
 *
 * One of four monitoring plugins that strip together, because LL-5 classified
 * them as a set: they shared one component directory and one collector endpoint
 * family, so deleting any single route edge on its own yielded zero dist
 * reduction. The dir SPLIT landed first (prior commit): the shared panels moved
 * to src/components/core/monitoring/ where the five core consumers (NOCView,
 * SOCView, InfraView, DashboardView, NOCPopout) read them, and what stayed in
 * src/components/monitoring/ is quad-exclusive and rides these bundles out.
 *
 * This entry is THIN, following the action-tracker/dev-servers pattern: the
 * view stays at src/pages/views/ProxmoxView.jsx and is imported from here, so
 * rollup pulls it plus its exclusive tree (ProxmoxTable, ProxmoxTopology,
 * ProxmoxActions, ProxmoxChatSidebar, ProxmoxContextMenu, ProxmoxNodes,
 * ProxmoxBackups, ProxmoxAlertConfig, useResourceHistory, SparklineCell,
 * vmActions) into plugin.esm.js and out of the free dashboard build.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps.
 *   - The bundle registers itself via window.__quoxPluginRegister(id, exports).
 *   - /monitoring/proxmox keeps its ROOT path only because the host verifies
 *     the Ed25519 signature over this manifest against a Quox publisher key.
 *   - The stripped core row carried minRole: 'builder', preserved in
 *     manifest.routeGuards so activation does not widen access.
 */

import ProxmoxView from '../../src/pages/views/ProxmoxView.jsx'

const PLUGIN_ID = 'proxmox'

const pluginExports = {
    routes: {
        '/monitoring/proxmox': ProxmoxView,
    },
    sidebar: [
        { path: '/monitoring/proxmox', label: 'Proxmox', icon: 'proxmox', minRole: 'builder' },
    ],
    // The dist scan's positive control needs a marker that survives
    // minification. A bare const is tree-shaken; a property on the object
    // handed to __quoxPluginRegister cannot be, because the object escapes
    // into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_proxmox',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
