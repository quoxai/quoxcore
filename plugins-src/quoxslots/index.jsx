/**
 * QuoxSlots — first-party plugin entry (LICENSE-LAUNCH LL-7 quoxslots strip).
 *
 * A THIN entry, following the quoxbox-macmini/browser-q/dev-servers/quoxbuild
 * pilots: it imports the existing panel from its current home in the dashboard
 * source tree rather than moving it. Rollup follows the import from here, so
 * SlotsDeckPanel compiles into plugin.esm.js.
 *
 * ── Why this one had already half-stripped, and what was still owed ──────
 *
 * SlotsDeckPanel's only importer was DevSuiteView, which stripped with
 * dev-servers on 2026-08-30 — so the deck's code left the FREE dist as a side
 * effect and the row sat deferred rather than done. Two real edges were still
 * open:
 *
 *   - the deck was compiling into the DEV-SERVERS bundle, because DevSuiteView
 *     imported it. A $39 Dev Servers customer got the $39 QuoxSlots deck for
 *     nothing. That is the same cross-bundle leak the quoxbuild strip found and
 *     fixed by rebuilding dev-servers, and it is fixed the same way here;
 *   - /dev-suite?tab=slots was still a static core nav row (pluginId-gated, so
 *     never visible to a free org, but static all the same). It comes from this
 *     bundle's manifest.sidebar now.
 *
 * ── Why this one has no routes ───────────────────────────────────────────
 *
 * Like quoxbuild, QuoxSlots is routeless by design: its catalogue manifest sets
 * dashboardSurface "embedded" and says "No standalone route by design: Slots is
 * a tab on /dev-suite (/dev-suite?tab=slots)." So the surface is a capability
 * panel keyed 'dev.slots', which DevSuiteView's slots tab resolves through the
 * shared registry. Unentitled, that tab renders the locked upsell slot built
 * from metadata alone.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The capability panel goes through window.__quoxSharedDeps.CapabilityPanels
 *     and NOT through a direct import of ../../src/config/capabilityPanelRegistry:
 *     that is the documented plugin contract, and it keeps this bundle from
 *     depending on the dashboard's module graph for a registration.
 *   - onDeactivate unregisters it, so entitlement LOSS puts the slots tab back
 *     to the locked slot without a reload.
 */

import SlotsDeckPanel from '../../src/components/devsuite/SlotsDeckPanel.jsx'

const PLUGIN_ID = 'quoxslots'
const CAPABILITY = 'dev.slots'

/** The host's shared capability-panel registry, or null if the host is older. */
function capabilityPanels() {
    if (typeof window === 'undefined') return null
    return window.__quoxSharedDeps?.CapabilityPanels || null
}

const pluginExports = {
    // No route of its own: the deck is the `slots` tab of /dev-suite, which the
    // dev-servers bundle owns. The sidebar row deep-links straight to it, which
    // is why it survived phase 9's "sellable but unfindable" fix.
    routes: {},
    sidebar: [
        { path: '/dev-suite?tab=slots', label: 'Slots', icon: 'server', badge: 'NEW' },
    ],
    hooks: {
        onActivate() {
            capabilityPanels()?.register(CAPABILITY, SlotsDeckPanel)
        },
        onDeactivate() {
            capabilityPanels()?.unregister(CAPABILITY)
        },
    },
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_quoxslots',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
