/**
 * Codebase Mirror — first-party plugin entry (LICENSE-LAUNCH LL-7 increment 3c).
 *
 * A THIN entry, following the quoxbox-macmini pilot exactly. It imports the
 * existing view from its current home in the dashboard source tree rather than
 * moving it: the strip is about proving the loader contract, not relocating
 * code. Rollup follows the import from here, so CodebaseMirrorView compiles into
 * plugin.esm.js and is NOT reachable from the free dashboard build once the
 * /codebase-mirror row and its lazy() import are deleted from the core tables.
 * The scanner backend (/api/v1/codebase + lib/codebaseScanner|Store|Diff) is a
 * BACKEND surface, entitlement-gated server-side, and is left in place.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/codebase-mirror) only because the host
 *     verifies the Ed25519 signature over this plugin's manifest against a Quox
 *     publisher key. Unsigned, it lands under /plugins/codebase-mirror/.
 *   - Route guards live in the SIGNED manifest (routeGuards), not here:
 *     /codebase-mirror was minRole 'builder' in core, preserved in
 *     manifest.routeGuards. FREE tier does NOT mean ungated: per owner ruling R1
 *     a free plugin still carries a (free) entitlement.
 */

import CodebaseMirrorView from '../../src/pages/views/CodebaseMirrorView.jsx'

const PLUGIN_ID = 'codebase-mirror'

const pluginExports = {
    routes: {
        '/codebase-mirror': CodebaseMirrorView,
    },
    sidebar: [
        { path: '/codebase-mirror', label: 'Codebase Mirror', icon: 'layers', minRole: 'builder' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_codebase-mirror',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
