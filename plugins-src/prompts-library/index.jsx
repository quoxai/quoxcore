/**
 * Prompts Library — first-party plugin entry (LICENSE-LAUNCH LL-7 increment 3a).
 *
 * A THIN entry, following the quoxbox-macmini pilot exactly. It imports the
 * existing view from its current home in the dashboard source tree rather than
 * moving it: the strip is about proving the loader contract, not relocating
 * code. Rollup follows the import from here, so the view (and PromptHistoryModal,
 * which only it uses) compile into plugin.esm.js and are NOT reachable from the
 * free dashboard build once the /prompts-library row and its lazy() import are
 * deleted from the core tables.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/prompts-library) only because the host
 *     verifies the Ed25519 signature over this plugin's manifest against a Quox
 *     publisher key. Unsigned, it lands under /plugins/prompts-library/.
 *   - Route guards live in the SIGNED manifest (routeGuards), not here.
 */

import PromptsLibraryView from '../../src/pages/views/PromptsLibraryView.jsx'

const PLUGIN_ID = 'prompts-library'

const pluginExports = {
    routes: {
        '/prompts-library': PromptsLibraryView,
    },
    sidebar: [
        { path: '/prompts-library', label: 'Prompts', icon: 'fileText', minRole: 'builder' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_prompts-library',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
