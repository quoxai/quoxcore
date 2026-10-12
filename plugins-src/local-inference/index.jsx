/**
 * Local Inference — first-party plugin entry (LICENSE-LAUNCH LL-7 strip).
 *
 * A THIN entry, following the quoxbox-macmini/browser-q/dev-servers/quoxbuild/
 * quoxslots pilots: it imports the existing panel from its current home in the
 * dashboard source tree rather than moving it. Rollup follows the import from
 * here, so LocalInferenceSettings compiles into plugin.esm.js.
 *
 * ── Why this one is a SETTINGS section, not a route ──────────────────────
 *
 * Local Inference never had a route. Its entire client surface is one section
 * of core /settings, which is why docs/LL7_EXTRACTION_PLAN.md §6 left it as an
 * owner call ("extract the settings section, or accept it as STAY-CORE"). Owner
 * ruled 2026-08-31: it is a paid plugin, it strips.
 *
 * Three core edges reached the panel and all three are now late-resolved
 * through the capability-panel registry under the key 'settings.local-inference':
 *
 *   - src/config/settingsSections.js — the section ROW, which STAYS. Metadata
 *     is exempt from the LL-7 acceptance and deleting it would be worse than
 *     useless: a settings section that silently vanishes is indistinguishable
 *     from a broken build, and an unentitled org deserves to know the section
 *     exists behind a plugin;
 *   - src/components/settings/SectionRenderer.jsx (the V2 settings IA) — was a
 *     lazy() import, now a CapabilityPanelSlot;
 *   - src/pages/views/SettingsView.jsx (the V1 view still serving #settings
 *     hashes) — was a static import, now the same slot.
 *
 * ── What did NOT come with it ────────────────────────────────────────────
 *
 * src/services/localModelRegistry.js. The catalogue manifest names it as part
 * of this plugin's integration surface, and it is genuinely local-inference's
 * own module, but NOTHING imports it — not this panel, not any core file — so
 * rollup never followed it into the free build (verified: its storage key
 * 'quox_local_inference_sources' is absent from dist/assets). Importing it here
 * purely to "complete the set" would compile dead code into a paid bundle, and
 * listing it as a coreModule would arm the ESLint boundary against the one file
 * that legitimately exercises it (src/test/localInference.test.js). See the
 * stripRegistry row.
 *
 * The BACKEND surface (collector /api/v1/local-inference/* + the
 * handleLocalInferenceChat provider path) is untouched, as with every other
 * strip: backends are gated by entitlement at the service, not by bundling.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The panel goes through window.__quoxSharedDeps.CapabilityPanels and NOT
 *     through a direct import of ../../src/config/capabilityPanelRegistry: that
 *     is the documented plugin contract, and it keeps this bundle from depending
 *     on the dashboard's module graph for a registration.
 *   - onDeactivate unregisters it, so entitlement LOSS puts the settings section
 *     back to the locked slot without a reload.
 */

import LocalInferenceSettings from '../../src/components/settings/LocalInferenceSettings.jsx'

const PLUGIN_ID = 'local-inference'
const CAPABILITY = 'settings.local-inference'

/** The host's shared capability-panel registry, or null if the host is older. */
function capabilityPanels() {
    if (typeof window === 'undefined') return null
    return window.__quoxSharedDeps?.CapabilityPanels || null
}

const pluginExports = {
    // No route and no sidebar row of its own: the surface is a section of core
    // /settings, whose row is static core metadata (settingsSections.js) and is
    // visible either way — locked when unentitled, the real panel when not.
    routes: {},
    hooks: {
        onActivate() {
            capabilityPanels()?.register(CAPABILITY, LocalInferenceSettings)
        },
        onDeactivate() {
            capabilityPanels()?.unregister(CAPABILITY)
        },
    },
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_local-inference',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
