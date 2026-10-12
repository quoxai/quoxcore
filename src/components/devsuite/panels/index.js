/**
 * DEVSUITE-HUB Phase 3 — built-in capability panel registrations.
 *
 * dev.register, dev.sessions and dev.plan have real panels registered here,
 * each owned by its substream (DEVSUITE-HUB, DEVSUITE-DEVMODE, DEVSUITE).
 * dev.clarify/dev.gripe/dev.docs have no real panel built yet —
 * DevServersHubPanel falls back to the honest "no panel available" message for
 * those via resolveCapabilityPanel(), rather than anything registered here
 * ahead of the substream that owns them.
 *
 * Imported once (for its registration side effect) by DevServersHubPanel.
 *
 * ── dev.build is NOT here, and must never come back ──────────────────────
 *
 * LICENSE-LAUNCH LL-7 quoxbuild strip (2026-08-31, owner-ratified): this file
 * used to `import DevBuildPanel` and register it unconditionally. Because
 * DevServersHubPanel side-effect imports this barrel and renders on the CORE
 * /infra route, that single line put the whole paid QuoxBuild panel into the
 * free build for every org — regardless of the dev-servers strip, which is
 * exactly why the quoxbuild row sat deferred in src/config/stripRegistry.js.
 *
 * DevBuildPanel now ships inside the signed quoxbuild bundle
 * (plugins-src/quoxbuild/index.jsx) and registers ITSELF into the shared
 * capability-panel registry on activation. Core keeps only the metadata, in
 * PREMIUM_CAPABILITY_PANELS, so the hub renders an honest locked slot when the
 * org is not entitled. Re-adding the import here would silently un-strip a
 * paid plugin; eslint.config.js and scripts/check-dist-clean.mjs both fail on
 * it now, which is the point.
 */
import { registerCapabilityPanel } from '../../../config/capabilityPanelRegistry'
// BUNDLE POLISH D: real CSS for the panel chrome these components were
// declaring inline in every instance. Imported here, with the panels, so any
// consumer of the barrel gets it.
import './capability-panels.css'
import DevRegisterPanel from './DevRegisterPanel'
import DevSessionsPanel from './DevSessionsPanel'
import DevPlanPanel from './DevPlanPanel'

registerCapabilityPanel('dev.register', DevRegisterPanel)
// DEVSUITE-HUB replan phase 8: the loop-sessions window + HALT button.
registerCapabilityPanel('dev.sessions', DevSessionsPanel)
// DEVSUITE phase 6: the roadmap work assigned to this host.
//
// NOTE ON REACHABILITY, so this is not mistaken for shipped-and-working: no
// host advertises dev.plan yet. Capability pills are built from what the
// agent reports in its signed profile, and dev.plan is not in quoxagent's
// capability list, so this panel is registered and currently unreachable in
// the UI. It lights up when an agent release adds the capability and a host's
// profile is re-signed to enable it, which is fleet work (phases 7/8).
//
// Registered now anyway because the DATA path is real and proven end to end:
// streams carry a dev_server tag, the roadmap filters by it, and the governed
// collector proxy serves it. The alternative was leaving the panel unwritten
// and the tag unusable from the product.
registerCapabilityPanel('dev.plan', DevPlanPanel)
