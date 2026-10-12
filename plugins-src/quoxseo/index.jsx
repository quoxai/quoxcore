/**
 * QuoxSEO — first-party plugin entry (QUOXSEO S2).
 *
 * Thin entry on the quoxsignal/qlarity pattern: imports the view from the
 * dashboard source tree; Rollup follows the import so QuoxSEOView and its
 * sub-components compile into plugin.esm.js and are not reachable from the
 * free build. The backend (repo quoxai/quox-seo, loopback :3110) is proxied
 * and entitlement-gated at services/collector/server.js /api/v1/quoxseo/*.
 *
 * Contract (src/services/thirdPartyPluginHost.js): React comes from
 * window.__quoxSharedDeps; the bundle registers via __quoxPluginRegister;
 * the root path (/quoxseo/*) is a signed-manifest privilege.
 */

import QuoxSEOView from '../../src/components/quoxseo/QuoxSEOView.jsx'

const PLUGIN_ID = 'quoxseo'

const pluginExports = {
    routes: {
        '/quoxseo/*': QuoxSEOView,
    },
    sidebar: [
        { path: '/quoxseo', label: 'QuoxSEO', icon: 'trending-up', badge: 'NEW' },
    ],
    __qxSentinel: 'QX_P1_quoxseo',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
