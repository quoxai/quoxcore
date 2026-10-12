/**
 * Prometheus Intelligence — first-party plugin entry
 * (LICENSE-LAUNCH LL-7 monitoring strip).
 *
 * One of four monitoring plugins that strip together — see
 * plugins-src/proxmox/index.jsx for why LL-5 classified them as a set and what
 * the preceding directory split moved to src/components/core/monitoring/.
 *
 * THIN entry: PrometheusView stays at src/pages/views/PrometheusView.jsx and
 * is imported from here, so rollup pulls it plus its exclusive tree
 * (FleetHeatmap, PromQLExplorer, AlertTimeline, MetricsChatSidebar) into
 * plugin.esm.js. MetricsPanel is NOT exclusive — it is core now, rendered on
 * NOC and NOCPopout for every org, and stays in the free build.
 *
 * The stripped core row carried minRole: 'builder', preserved in
 * manifest.routeGuards so activation does not widen access.
 */

import PrometheusView from '../../src/pages/views/PrometheusView.jsx'

const PLUGIN_ID = 'prometheus'

const pluginExports = {
    routes: {
        '/monitoring/prometheus': PrometheusView,
    },
    sidebar: [
        { path: '/monitoring/prometheus', label: 'Prometheus', icon: 'prometheus', minRole: 'builder' },
    ],
    __qxSentinel: 'QX_P1_prometheus',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
