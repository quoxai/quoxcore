/**
 * Web Terminal — first-party plugin entry (LICENSE-LAUNCH LL-7 increment 3e).
 *
 * A THIN entry, following the quoxbox-macmini pilot exactly. It imports the
 * existing view from its current home in the dashboard source tree rather than
 * moving it: the strip is about proving the loader contract, not relocating
 * code. Rollup follows the import from here, so TerminalView (and the
 * components/terminal panes/chat it uses) compile into plugin.esm.js and are NOT
 * reachable from the free dashboard build once the /terminal row and its lazy()
 * import are deleted from the core tables.
 *
 * Only the /terminal WORKSPACE strips. /terminal/about (TerminalPromo) and
 * /terminal/share/:shareId (SnapshotViewer) are the public promo and share
 * surfaces — they stay in core, so they keep their own lazy() imports. Shared
 * services the workspace leans on (services/terminalMemoryBridge.js and friends)
 * also stay in core because other core code imports them; they simply ship a
 * second copy inside this bundle too.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/terminal) only because the host verifies
 *     the Ed25519 signature over this plugin's manifest against a Quox
 *     publisher key. Unsigned, it lands under /plugins/web-terminal/.
 *   - Route guards live in the SIGNED manifest (routeGuards), not here: /terminal
 *     was minRole 'runner' in core, preserved in manifest.routeGuards.
 */

import TerminalView from '../../src/pages/views/TerminalView.jsx'

const PLUGIN_ID = 'web-terminal'

const pluginExports = {
    routes: {
        '/terminal': TerminalView,
    },
    sidebar: [
        { path: '/terminal', label: 'Terminal', icon: 'terminal', badge: 'NEW', minRole: 'runner' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_web-terminal',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
