/**
 * Quox Voice — first-party plugin entry (QUOX-VOICE P2).
 *
 * Thin entry following the quoxsignal pattern: the view lives in the
 * dashboard source tree (src/components/quox-voice/) and Rollup follows this
 * import, so the view AND its livekit-client dependency compile into
 * plugin.esm.js and never reach the free core build.
 *
 * Tier is "free" for now ON PURPOSE: the quox-voice / advanced-voice
 * entitlement relationship is an unresolved three-way conflict
 * (STORE-CANON #3842) and shipping a wrong paywall is the known failure
 * class. P4 implements whatever that reconciliation decides.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps.
 *   - The bundle registers via window.__quoxPluginRegister(id, exports).
 *   - Root path /quox-voice/* requires the Ed25519-signed manifest.
 */

import QuoxVoiceView from '../../src/components/quox-voice/QuoxVoiceView.jsx'

const PLUGIN_ID = 'quox-voice'

const pluginExports = {
    routes: {
        '/quox-voice/*': QuoxVoiceView,
    },
    sidebar: [
        { path: '/quox-voice', label: 'Quox Voice', icon: 'mic', badge: 'BETA' },
    ],
    __qxSentinel: 'QX_P1_quox-voice',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
