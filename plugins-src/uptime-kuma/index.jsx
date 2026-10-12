/**
 * Uptime Kuma — first-party plugin entry (LICENSE-LAUNCH LL-7 monitoring strip).
 *
 * One of four monitoring plugins that strip together — see
 * plugins-src/proxmox/index.jsx for why LL-5 classified them as a set and what
 * the preceding directory split moved to src/components/core/monitoring/.
 *
 * THIN entry: UptimeKumaView stays at src/pages/views/UptimeKumaView.jsx and
 * is imported from here. Its exclusive content is the standalone page itself
 * (licence gate, connection check, setup/add-page flow); UptimePanel is CORE
 * now and keeps rendering on NOC and NOCPopout for every org.
 *
 * The stripped core row carried minRole: 'builder', preserved in
 * manifest.routeGuards so activation does not widen access.
 */

import UptimeKumaView from '../../src/pages/views/UptimeKumaView.jsx'

const PLUGIN_ID = 'uptime-kuma'

const pluginExports = {
    routes: {
        '/monitoring/uptime-kuma': UptimeKumaView,
    },
    sidebar: [
        { path: '/monitoring/uptime-kuma', label: 'Uptime Kuma', icon: 'uptime-kuma', minRole: 'builder' },
    ],
    __qxSentinel: 'QX_P1_uptime-kuma',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
