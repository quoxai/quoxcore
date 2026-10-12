/**
 * Capability Panel Registry
 *
 * DEVSUITE-HUB Phase 3 (docs/STREAM_DEVSUITE_HUB_PLAN.md): dev-suite member
 * plugins contribute a per-server panel React component for one of the known
 * dev-suite capabilities (dev.register, dev.build, dev.clarify, dev.gripe,
 * dev.docs). DevServersHubPanel renders whatever's registered when a host's
 * capability pill is activated. This module is the registry mechanism only —
 * it does NOT contain any capability's real panel content beyond the one
 * dev.register example proving the mechanism works end-to-end (see
 * ../components/devsuite/panels/DevRegisterPanel.jsx). Real panel content for
 * dev.build/dev.clarify/dev.gripe/dev.docs belongs to their own substreams.
 *
 * Mirrors the register/get Map pattern already used for third-party plugin
 * contributions elsewhere in this codebase (registerPluginRoute/
 * getPluginRoutes in routeRegistry.js, registerPluginNavItems/
 * getPluginNavItems in navRegistry.js) rather than inventing a parallel
 * mechanism.
 *
 * Contract: a registered panel component receives `{ server }` — the full
 * dev_servers row for the host whose pill was activated (host_id,
 * profile_verified, profile_version, enabled_capabilities, known_capabilities,
 * checked_at, last_seen_at, ...), the same object GET /api/v1/dev-servers
 * already returns. Panels read this collector state only; no new backend
 * calls are part of this mechanism.
 *
 * ── LICENSE-LAUNCH LL-7 quoxbuild strip: registration is now LATE ─────────
 *
 * A capability panel can belong to a PAID plugin, and then its code must not
 * be in the free build at all. dev.build is the first: DevBuildPanel used to
 * be registered unconditionally by ../components/devsuite/panels/index.js,
 * which the CORE DevServersHubPanel side-effect imports for /infra — so the
 * paid panel shipped to every org no matter what any route strip did.
 *
 * The shape that fixes it, and that any future paid panel should copy:
 *
 *   - core keeps only METADATA here (PREMIUM_CAPABILITY_PANELS below), which
 *     is what lets the hub render an honest locked slot rather than pretending
 *     the panel was never built. Metadata is exempt from the LL-7 acceptance;
 *     code is not, so nothing here may import the panel;
 *   - the panel ships inside the plugin's signed bundle and calls
 *     registerCapabilityPanel on activation, through the shared registry
 *     surface the plugin host exposes as
 *     window.__quoxSharedDeps.CapabilityPanels (a bundle importing this module
 *     directly would get a SECOND Map and register into nothing);
 *   - losing the entitlement calls unregisterCapabilityPanel again, and the
 *     hub goes back to the locked slot.
 *
 * Registration is therefore no longer a boot-time constant, so it fires a
 * `quox-capability-panel-change` window event — the same shape routeRegistry
 * uses for `quox-plugin-route-change` — for surfaces that render pills off the
 * registry and would otherwise be stuck on a pre-activation snapshot.
 *
 * ── LICENSE-LAUNCH LL-7 quoxslots strip: ONE registry, N compiled copies ──
 *
 * The Map is hung off `window` rather than kept in module scope. That is not
 * belt-and-braces, it is required by the second routeless strip:
 * SlotsDeckPanel's surface is the `slots` tab of DevSuiteView, and DevSuiteView
 * is itself stripped — it compiles INTO the signed dev-servers bundle, taking a
 * SECOND copy of this module with it. With a module-scope Map the quoxslots
 * bundle would register through the host into CORE's registry while the slots
 * tab read the dev-servers copy, so an entitled org would sit on the locked
 * slot forever. One window-scoped Map means every compiled copy — core, and
 * any bundle that happens to import a component that imports this — reads and
 * writes the same registry.
 *
 * Bundles still register through window.__quoxSharedDeps.CapabilityPanels
 * rather than importing this module: that is the documented plugin contract,
 * it keeps a bundle from compiling in React via this module's import, and it
 * does not depend on a bundle having a copy of this file at all.
 *
 * ── LICENSE-LAUNCH LL-7 local-inference strip: SETTINGS sections too ──────
 *
 * The third routeless strip generalises this registry past the dev-suite: a
 * PREMIUM SETTINGS SECTION resolves through exactly the same mechanism, keyed
 * 'settings.<pluginId>'. Core /settings keeps the section's METADATA (the row
 * in src/config/settingsSections.js, the sidebar label), so an unentitled org
 * still sees Local Inference exists and gets the locked upsell instead of a
 * section that silently vanished; the panel's CODE ships in the signed bundle.
 *
 * Nothing about the mechanism changed for this — a key is a key. What was added
 * is CapabilityPanelSlot below, because the late-resolution + event-subscription
 * dance was about to be hand-rolled a THIRD and FOURTH time (SectionRenderer for
 * the V2 settings IA, SettingsView for V1) after DevSuiteView's SlotsTab and
 * DevServersHubPanel already each wrote their own.
 */

import React from 'react'

/**
 * Map<capabilityName, React.ComponentType<{server: object}>>, shared across
 * every compiled copy of this module in the page (see the header note). Falls
 * back to a module-local Map under Node/SSR, where there is no window and
 * there is only ever one copy anyway.
 */
const capabilityPanels = (() => {
    if (typeof window === 'undefined') return new Map()
    if (!(window.__quoxCapabilityPanels instanceof Map)) {
        window.__quoxCapabilityPanels = new Map()
    }
    return window.__quoxCapabilityPanels
})()

/**
 * Map<capabilityName, ownerId>, the sibling of capabilityPanels and shared the
 * same way (see the header note on why the panel Map hangs off window). Records
 * WHO registered each panel so a second owner cannot silently overwrite or
 * unregister the first's, and so a reserved core key can be gated to official
 * bundles. Owner is CORE_CAPABILITY_OWNER for in-tree core/first-party calls.
 */
const capabilityPanelOwners = (() => {
    if (typeof window === 'undefined') return new Map()
    if (!(window.__quoxCapabilityPanelOwners instanceof Map)) {
        window.__quoxCapabilityPanelOwners = new Map()
    }
    return window.__quoxCapabilityPanelOwners
})()

/**
 * Owner id for CORE / first-party in-tree registrations — anything that calls
 * registerCapabilityPanel without an explicit ownerId (panels/index.js, unit
 * tests). CORE is fully privileged: it may claim a reserved key and may
 * overwrite or unregister any registration. A THIRD-PARTY bundle never reaches
 * this path: the plugin host hands it an owner-bound wrapper (see
 * makeCapabilityPanelsForPlugin in thirdPartyPluginHost.js).
 */
export const CORE_CAPABILITY_OWNER = '__core__'

/**
 * Capability-name prefixes that CORE surfaces render directly: 'settings.<id>'
 * (SectionRenderer / SettingsView) and 'dev.<cap>' (the dev-servers hub). A
 * panel registered under one of these renders INSIDE a genuine core surface,
 * so a non-official bundle registering one could impersonate core chrome and
 * phish. These are the RESERVED namespace, gated to official bundles below.
 */
export const RESERVED_CAPABILITY_PREFIXES = Object.freeze(['settings.', 'dev.'])

/**
 * Whether a capability name belongs to the reserved core namespace: any key
 * that a core surface renders. Covers the two core-rendered prefixes and, belt
 * and braces, every explicit PREMIUM_CAPABILITY_PANELS key (all of which sit
 * inside those prefixes anyway).
 * @param {string} capabilityName
 * @returns {boolean}
 */
export function isReservedCapability(capabilityName) {
    if (typeof capabilityName !== 'string') return false
    if (Object.prototype.hasOwnProperty.call(PREMIUM_CAPABILITY_PANELS, capabilityName)) return true
    return RESERVED_CAPABILITY_PREFIXES.some((prefix) => capabilityName.startsWith(prefix))
}

/** Fired whenever the registry gains or loses a panel. */
export const CAPABILITY_PANEL_CHANGE_EVENT = 'quox-capability-panel-change'

function announceChange(capabilityName) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
    window.dispatchEvent(new CustomEvent(CAPABILITY_PANEL_CHANGE_EVENT, { detail: { capability: capabilityName } }))
}

/**
 * Capability panels that ship inside a PAID plugin bundle rather than the free
 * build. PURE DATA — never import the panel component here, that is the whole
 * point. Copy is a reviewed snapshot of the plugin's catalogue manifest
 * (src/config/plugins/<id>.json), deliberately duplicated rather than imported,
 * exactly as src/config/premiumRouteStubs.js does it for routes.
 */
export const PREMIUM_CAPABILITY_PANELS = Object.freeze({
    'dev.build': Object.freeze({
        pluginId: 'quoxbuild',
        name: 'QuoxBuild',
        tagline: 'Green only after the service answered.',
        blurb: 'A governed build queue for your dev servers. A dispatch names a target the host '
            + 'already registered, never a command, and a receipt only reads green once a '
            + 'post-deploy probe confirms the service actually came up.',
        priceDisplay: '$20',
        accentColor: '#f59e0b',
    }),
    // LICENSE-LAUNCH LL-7 quoxslots strip, 2026-08-31. Not a dev-server
    // capability pill like dev.build: 'dev.slots' is the key the `slots` TAB of
    // the dev-servers hub resolves through, so the deck's code can live in the
    // quoxslots bundle instead of compiling into the dev-servers one. Copy is a
    // reviewed snapshot of src/config/plugins/quoxslots.json.
    'dev.slots': Object.freeze({
        pluginId: 'quoxslots',
        name: 'QuoxSlots',
        tagline: 'A durable address for every session.',
        blurb: 'A fixed pool of named slots that ephemeral agent sessions check out and release. '
            + 'You talk to the slot, not to whichever session happens to be holding it, so a '
            + 'handover never costs you the thread. When a session dies its slot goes stale and '
            + 'frees itself, so a crash never wedges an address.',
        priceDisplay: '$39',
        accentColor: '#38bdf8',
    }),
    // LICENSE-LAUNCH LL-7 local-inference strip, 2026-08-31. The first PREMIUM
    // SETTINGS SECTION: 'settings.local-inference' is the key both /settings
    // surfaces (SectionRenderer for the V2 IA, SettingsView for V1) resolve the
    // Local Inference section through, so LocalInferenceSettings.jsx can ship in
    // the signed bundle while the section ROW stays core metadata. Copy is a
    // reviewed snapshot of src/config/plugins/local-inference.json.
    //
    // priceDisplay is deliberately absent, unlike its two siblings above. The
    // catalogue lists $89 one-time AND beta: true / betaPrice: 0 / "Free during
    // public beta", so quoting either number in this slot would state a price
    // that is not currently the price. The CTA sends people to /settings#plugins,
    // where the live price is resolved from the catalogue.
    'settings.local-inference': Object.freeze({
        pluginId: 'local-inference',
        name: 'Local Inference',
        tagline: 'Run AI on your own hardware.',
        blurb: 'Connect QuoxCORE to self-hosted LLM inference servers running on your own GPU '
            + 'machines. Supports Ollama, vLLM, llama.cpp and NVIDIA NIM via OpenAI-compatible '
            + 'APIs: zero API costs, full data privacy, and an audit trail for every inference '
            + 'request.',
        accentColor: '#22c55e',
    }),
})

/**
 * Metadata for a capability whose panel ships in a paid bundle, or null.
 * @param {string} capabilityName
 * @returns {{pluginId: string, name: string, tagline?: string, blurb?: string, priceDisplay?: string, accentColor?: string}|null}
 */
export function getPremiumCapabilityPanel(capabilityName) {
    return PREMIUM_CAPABILITY_PANELS[capabilityName] || null
}

/**
 * The three honest states a capability's panel can be in, for callers that
 * render a control BEFORE the click (hub pills, drill-in tabs).
 *
 *   'registered' — a panel is loaded and can be opened;
 *   'locked'     — a panel exists but ships with a plugin this org has not
 *                  activated; opening it shows the upsell, not a lie;
 *   'none'       — nothing has been built for this capability yet.
 *
 * @param {string} capabilityName
 * @returns {'registered'|'locked'|'none'}
 */
export function capabilityPanelState(capabilityName) {
    if (capabilityPanels.has(capabilityName)) return 'registered'
    if (getPremiumCapabilityPanel(capabilityName)) return 'locked'
    return 'none'
}

/**
 * Register a panel component for a capability name.
 *
 * LICENSE-LAUNCH LL-6d — registration is now PRIVILEGE-GATED, mirroring the
 * official-route model in thirdPartyPluginHost.js. A validly-signed but
 * NON-OFFICIAL third-party bundle must not be able to register a reserved core
 * capability key (settings.* / dev.*) and render inside a genuine core surface
 * to phish. Two guards, both no-op-on-refusal (return false, never override):
 *
 *   - a RESERVED key may be registered only by an official bundle or by core;
 *   - an existing registration is never silently overwritten by a DIFFERENT
 *     owner (core may overwrite anything; a plugin may only re-register its own).
 *
 * Core / first-party in-tree callers pass no options and are treated as CORE,
 * so every existing caller keeps working unchanged. Third-party bundles reach
 * this only through the owner-bound wrapper the host hands them.
 *
 * @param {string} capabilityName - e.g. 'dev.register', 'dev.build'
 * @param {React.ComponentType<{server: object}>} Component
 * @param {{ownerId?: string, official?: boolean}} [options]
 * @returns {boolean} true if registered, false if refused
 */
export function registerCapabilityPanel(capabilityName, Component, options = {}) {
  if (!capabilityName || typeof capabilityName !== 'string') {
    throw new Error('registerCapabilityPanel: capabilityName (string) required')
  }
  if (typeof Component !== 'function') {
    throw new Error('registerCapabilityPanel: Component (React component) required')
  }
  const ownerId = options.ownerId || CORE_CAPABILITY_OWNER
  const isCore = ownerId === CORE_CAPABILITY_OWNER
  const official = isCore || options.official === true

  if (isReservedCapability(capabilityName) && !official) {
    console.warn(
      `[capabilityPanels] refused: non-official owner '${ownerId}' may not register reserved `
      + `core capability '${capabilityName}'. Core-surface impersonation blocked (LL-6d).`,
    )
    return false
  }

  const existingOwner = capabilityPanelOwners.get(capabilityName)
  if (!isCore && existingOwner !== undefined && existingOwner !== ownerId) {
    console.warn(
      `[capabilityPanels] refused: owner '${ownerId}' may not overwrite '${capabilityName}' `
      + `already registered by '${existingOwner}'.`,
    )
    return false
  }

  capabilityPanels.set(capabilityName, Component)
  capabilityPanelOwners.set(capabilityName, ownerId)
  announceChange(capabilityName)
  return true
}

/**
 * Remove a registered panel for a capability. Also the entitlement-LOSS path:
 * a paid plugin's onDeactivate hook calls this, and the hub drops back to the
 * locked slot (LL-7 plan review note 1).
 * @param {string} capabilityName
 */
export function unregisterCapabilityPanel(capabilityName, options = {}) {
  const ownerId = options.ownerId || CORE_CAPABILITY_OWNER
  const isCore = ownerId === CORE_CAPABILITY_OWNER
  const existingOwner = capabilityPanelOwners.get(capabilityName)

  // LL-6d: unregister only by the owner that registered, or by core. A plugin
  // must not be able to tear down another plugin's (or a core) panel.
  if (!isCore && existingOwner !== undefined && existingOwner !== ownerId) {
    console.warn(
      `[capabilityPanels] refused: owner '${ownerId}' may not unregister '${capabilityName}' `
      + `registered by '${existingOwner}'.`,
    )
    return false
  }

  const deleted = capabilityPanels.delete(capabilityName)
  capabilityPanelOwners.delete(capabilityName)
  if (!deleted) return false
  announceChange(capabilityName)
  return true
}

/**
 * Look up the registered panel component for a capability.
 * @param {string} capabilityName
 * @returns {React.ComponentType<{server: object}>|null}
 */
export function getCapabilityPanel(capabilityName) {
  return capabilityPanels.get(capabilityName) || null
}

/**
 * Every capability name with a currently-registered panel.
 * @returns {string[]}
 */
export function getRegisteredCapabilities() {
  return Array.from(capabilityPanels.keys())
}

/**
 * Honest fallback panel — rendered when a capability has no registered panel
 * yet. Never fabricate placeholder content for a capability that doesn't
 * have a real panel built (DEVSUITE-HUB Phase 3 is registry-mechanism-only).
 * @param {{capability: string}} props
 */
export function CapabilityPanelFallback({ capability }) {
  return React.createElement(
    'div',
    { className: 'capability-panel-fallback', 'data-testid': 'capability-panel-fallback' },
    `No panel available for ${capability} yet.`
  )
}

/**
 * Locked slot for a capability whose panel ships in a paid bundle this org has
 * not activated (LICENSE-LAUNCH LL-7). The panel-sized sibling of
 * components/plugins/PluginLockedView.jsx, built from the same page vocabulary
 * (qx-pill, qx-hint, qx-btn) and driven entirely by PREMIUM_CAPABILITY_PANELS
 * metadata, so no paid component is reachable from here.
 * @param {{capability: string}} props
 */
export function CapabilityPanelLocked({ capability }) {
  const meta = getPremiumCapabilityPanel(capability)
  if (!meta) return React.createElement(CapabilityPanelFallback, { capability })
  const accent = meta.accentColor || '#38bdf8'
  return React.createElement(
    'div',
    {
      className: 'capability-panel-locked',
      'data-testid': 'capability-panel-locked',
      'data-plugin-id': meta.pluginId,
    },
    React.createElement(
      'div',
      { className: 'capability-panel-row' },
      React.createElement(
        'svg',
        {
          width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: accent,
          strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        },
        React.createElement('rect', { x: 3, y: 11, width: 18, height: 11, rx: 2 }),
        React.createElement('path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }),
      ),
      React.createElement('strong', null, meta.name),
      meta.priceDisplay
        ? React.createElement('span', { className: 'qx-pill qx-pill--sm qx-pill--ghost' }, meta.priceDisplay)
        : null,
    ),
    meta.tagline
      ? React.createElement('div', { className: 'capability-panel-row qx-hint qx-hint--sm' }, meta.tagline)
      : null,
    meta.blurb
      ? React.createElement('div', { className: 'capability-panel-row qx-hint qx-hint--sm' }, meta.blurb)
      : null,
    React.createElement(
      'div',
      { className: 'capability-panel-row' },
      React.createElement(
        'a',
        {
          className: 'qx-btn qx-btn--sm',
          href: '/settings#plugins',
          'data-testid': 'capability-panel-locked-cta',
        },
        React.createElement(
          'svg',
          {
            width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
            strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
          },
          React.createElement('path', { d: 'M12 5v14M5 12h14' }),
        ),
        `Activate ${meta.name}${meta.priceDisplay ? ` (${meta.priceDisplay})` : ''}`,
      ),
    ),
  )
}

/**
 * Resolve the component to render for a capability, in the three-state
 * vocabulary capabilityPanelState() describes: the registered panel, else the
 * locked upsell if the panel ships in a paid bundle, else the honest
 * "nothing built yet" fallback bound to that capability's name.
 * Callers can drop the result straight into JSX as `<Resolved server={s} />`.
 * @param {string} capabilityName
 * @returns {React.ComponentType<{server: object}>}
 */
export function resolveCapabilityPanel(capabilityName) {
  const registered = getCapabilityPanel(capabilityName)
  if (registered) return registered
  if (getPremiumCapabilityPanel(capabilityName)) {
    return function CapabilityPanelLockedBound(props) {
      return React.createElement(CapabilityPanelLocked, { ...props, capability: capabilityName })
    }
  }
  return function CapabilityPanelFallbackBound(props) {
    return React.createElement(CapabilityPanelFallback, { ...props, capability: capabilityName })
  }
}

/**
 * Render whatever a capability currently resolves to, and KEEP rendering the
 * right thing as entitlement changes (LICENSE-LAUNCH LL-7 local-inference).
 *
 * The subscription is the load-bearing half, and it is not defensive: plugin
 * activation is asynchronous (bundle fetch + Ed25519 verify + inject), so a
 * customer who lands straight on the surface renders BEFORE their own bundle
 * has registered. Without the listener they would sit on a locked slot they
 * had paid for until they reloaded the page. DevSuiteView's SlotsTab and
 * DevServersHubPanel each hand-rolled this; the two /settings surfaces use
 * this instead of writing it a third and fourth time.
 *
 * Every prop other than `capability` is forwarded to the resolved panel, which
 * is how the V1 SettingsView keeps passing `onNotification` to the real Local
 * Inference panel once the bundle is active.
 *
 * @param {{capability: string}} props
 */
export function CapabilityPanelSlot({ capability, ...props }) {
  const [, bump] = React.useState(0)
  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onChange = (e) => {
      if (!e?.detail?.capability || e.detail.capability === capability) bump((n) => n + 1)
    }
    window.addEventListener(CAPABILITY_PANEL_CHANGE_EVENT, onChange)
    return () => window.removeEventListener(CAPABILITY_PANEL_CHANGE_EVENT, onChange)
  }, [capability])
  const Panel = resolveCapabilityPanel(capability)
  return React.createElement(Panel, props)
}
