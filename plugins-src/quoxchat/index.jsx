/**
 * QuoxChat — first-party plugin entry (LICENSE-LAUNCH LL-7 increment 3h).
 *
 * A THIN entry, following the quoxbox-macmini pilot / bastion-fleet pattern
 * exactly. It imports the two existing views from their current home in the
 * dashboard source tree rather than moving them: the strip is about proving the
 * loader contract, not relocating code. Rollup follows the imports from here, so
 * QuoxChatView (the widget list + create wizard) and QuoxChatWidgetRoom (the
 * per-widget admin room) compile into plugin.esm.js and are NOT reachable from
 * the free dashboard build once the /quoxchat rows and their lazy() imports are
 * deleted from the core tables.
 *
 * Shared UI the views lean on (assistant-editor OnboardingWizard, automation
 * EvolutionStagePill) stays in core because other core code imports it; it
 * simply ships a second copy inside this bundle too. The QuoxChat collector
 * routes (services/collector/routes/quoxchat.js) and the auth-side widget store
 * are a separate BACKEND surface, entitlement-gated, and are left in place —
 * only the FRONTEND views strip.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The routes keep their ROOT paths (/quoxchat, /quoxchat/:widgetId) only
 *     because the host verifies the Ed25519 signature over this plugin's
 *     manifest against a Quox publisher key. Unsigned, they land under
 *     /plugins/quoxchat/.
 *   - The stripped /quoxchat core rows were UNGATED, so no routeGuards.
 */

import QuoxChatView from '../../src/pages/views/QuoxChatView.jsx'
import QuoxChatWidgetRoom from '../../src/pages/views/QuoxChatWidgetRoom.jsx'

const PLUGIN_ID = 'quoxchat'

const pluginExports = {
    routes: {
        '/quoxchat': QuoxChatView,
        '/quoxchat/:widgetId': QuoxChatWidgetRoom,
    },
    sidebar: [
        { path: '/quoxchat', label: 'QuoxChat', icon: 'messageSquare', badge: 'NEW' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_quoxchat',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
