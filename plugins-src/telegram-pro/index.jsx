/**
 * Quox Telegram Pro — first-party plugin entry (LICENSE-LAUNCH LL-7 increment 3d).
 *
 * A THIN entry, following the quoxbox-macmini pilot exactly. It imports the
 * existing view from its current home in the dashboard source tree rather than
 * moving it: the strip is about proving the loader contract, not relocating
 * code. Rollup follows the import from here, so the view (and TelegramProWizard
 * + telegramProService, which only it uses) compile into plugin.esm.js and are
 * NOT reachable from the free dashboard build once the /telegram-pro row and its
 * lazy() import are deleted from the core tables. The collector /telegram-pro
 * routes + services/auth routes/telegramPro.js are a BACKEND surface, already
 * entitlement-gated by LL-6d, and are left in place.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/telegram-pro) only because the host verifies
 *     the Ed25519 signature over this plugin's manifest against a Quox
 *     publisher key. Unsigned, it lands under /plugins/telegram-pro/.
 *   - The stripped /telegram-pro core row was ungated (pluginId was metadata,
 *     not a guard), so no routeGuards.
 */

import TelegramProView from '../../src/components/telegram-pro/TelegramProView.jsx'

const PLUGIN_ID = 'telegram-pro'

const pluginExports = {
    routes: {
        '/telegram-pro': TelegramProView,
    },
    sidebar: [
        { path: '/telegram-pro', label: 'Telegram Pro', icon: 'send', badge: 'NEW' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_telegram-pro',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
