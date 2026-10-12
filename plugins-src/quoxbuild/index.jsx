/**
 * QuoxBuild — first-party plugin entry (LICENSE-LAUNCH LL-7 quoxbuild strip).
 *
 * A THIN entry, following the quoxbox-macmini/browser-q/dev-servers pilots: it
 * imports the existing panel from its current home in the dashboard source tree
 * rather than moving it. Rollup follows the import from here, so DevBuildPanel
 * compiles into plugin.esm.js and is NOT reachable from the free dashboard
 * build once its registration is deleted from
 * src/components/devsuite/panels/index.js.
 *
 * ── Why this one has no routes ───────────────────────────────────────────
 *
 * Every strip before this deleted a ROUTE EDGE. quoxbuild has no route to
 * delete: its manifest's dashboardSurface is "embedded", because a build queue
 * belongs to a host, so its whole UI is a dev-suite CAPABILITY PANEL rendered
 * inside a host card. The edge that kept it in the free build was a side-effect
 * registration in the built-in panel barrel, which the CORE DevServersHubPanel
 * imports for the ungated /infra route — so the paid panel shipped to every org
 * regardless of the dev-servers strip. That is why this row sat deferred in
 * src/config/stripRegistry.js from 2026-08-30 until now.
 *
 * The replacement is entitlement-keyed LATE registration: core keeps only the
 * metadata (PREMIUM_CAPABILITY_PANELS in src/config/capabilityPanelRegistry.js)
 * so the hub can render an honest locked slot, and this bundle registers the
 * real panel on activation.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The capability panel goes through window.__quoxSharedDeps.CapabilityPanels
 *     and NOT through a direct import of ../../src/config/capabilityPanelRegistry:
 *     that module keeps its Map in module scope, so an imported copy would be a
 *     SECOND registry the dashboard never reads. Same reason React is shared.
 *   - onDeactivate unregisters it again, so entitlement LOSS puts the hub back
 *     to the locked slot (LL-7 plan review note 1) without a reload.
 */

import DevBuildPanel from '../../src/components/devsuite/panels/DevBuildPanel.jsx'

const PLUGIN_ID = 'quoxbuild'
const CAPABILITY = 'dev.build'

/** The host's shared capability-panel registry, or null if the host is older. */
function capabilityPanels() {
    if (typeof window === 'undefined') return null
    return window.__quoxSharedDeps?.CapabilityPanels || null
}

const pluginExports = {
    // Deliberately empty: no route, no sidebar row. The panel is the surface.
    routes: {},
    hooks: {
        onActivate() {
            capabilityPanels()?.register(CAPABILITY, DevBuildPanel)
        },
        onDeactivate() {
            capabilityPanels()?.unregister(CAPABILITY)
        },
    },
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_quoxbuild',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
