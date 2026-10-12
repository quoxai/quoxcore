/**
 * Cognitive Core 3D — first-party plugin entry (LICENSE-LAUNCH LL-7
 * extraction 3, the R3F half).
 *
 * A THIN entry, same shape as action-tracker/dev-servers: it imports the view
 * from its existing home in the dashboard source tree rather than moving it.
 * Rollup follows the import from here, so CognitiveCore3DView and the
 * opsdeck3d modules ONLY it uses (CognitiveCore.jsx, hud/*, hooks/*, and the
 * lib/ modules the free build never reaches) compile into plugin.esm.js and
 * are not reachable from the free dashboard build once the /cogcore3d route
 * and its lazy() import are deleted from App.jsx.
 *
 * src/components/opsdeck3d/ STAYS CORE and is deliberately NOT moved: two core
 * views still consume it — ThreeDLabView (/3d-lab, zones + effects + lib) and
 * QuoxbrainView (/brain2, lazy BrainOrgan3D). Only the parts of that directory
 * that nothing core imports follow this bundle out, which Rollup decides by
 * reachability. Do not add a barrel export over opsdeck3d to "tidy" this: an
 * R3F barrel eager-evaluates useFrame/useThree outside <Canvas> and crashes
 * every page that touches it (cc3d-dev skill, rule 2).
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/cogcore3d) only because the host verifies
 *     the Ed25519 signature over this plugin's manifest against a Quox
 *     publisher key. Unsigned, it lands under /plugins/cogcore3d/.
 *   - No routeGuards: the stripped core row was ungated (the licence gate lived
 *     inside the view itself, via isPluginLicensed).
 *   - MOUNT POINT CHANGE: in core this route sat in App.jsx's STANDALONE block
 *     (no AppShell, its own AuthProvider). Plugin routes mount inside AppShell,
 *     which is itself inside the app-level AuthProvider — so the useAuth
 *     dependency is still satisfied, and the view renders fullscreen anyway
 *     because its root is `position: fixed; inset: 0`
 *     (CognitiveCore3DView.jsx). Verified unlicensed only; see the commit
 *     message for what the activated path still owes.
 */

import CognitiveCore3DView from '../../src/pages/views/CognitiveCore3DView.jsx'

const PLUGIN_ID = 'cogcore3d'

const pluginExports = {
    routes: {
        '/cogcore3d': CognitiveCore3DView,
    },
    sidebar: [
        { path: '/cogcore3d', label: 'Cognitive Core 3D', icon: 'box', badge: 'NEW' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_cogcore3d',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
