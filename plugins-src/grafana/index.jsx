/**
 * Grafana — first-party plugin entry (LICENSE-LAUNCH LL-7 monitoring strip).
 *
 * One of four monitoring plugins that strip together — see
 * plugins-src/proxmox/index.jsx for why LL-5 classified them as a set and what
 * the preceding directory split moved to src/components/core/monitoring/.
 *
 * This is the thinnest of the four: GrafanaView is a licence gate plus a page
 * frame around GrafanaEmbed, and GrafanaEmbed is CORE (NOC and NOCPopout both
 * render it, and GrafanaAlertBadge polls alert state for the NOC header). So
 * only the standalone /monitoring/grafana page leaves the free build; the
 * embed itself does not. That is the same shape as the dev-servers strip,
 * where the hub content stayed core and only the drill-in route stripped.
 *
 * The stripped core row carried minRole: 'builder', preserved in
 * manifest.routeGuards so activation does not widen access.
 */

import GrafanaView from '../../src/pages/views/GrafanaView.jsx'

const PLUGIN_ID = 'grafana'

const pluginExports = {
    routes: {
        '/monitoring/grafana': GrafanaView,
    },
    sidebar: [
        { path: '/monitoring/grafana', label: 'Grafana', icon: 'grafana', minRole: 'builder' },
    ],
    __qxSentinel: 'QX_P1_grafana',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
