/**
 * settingsSetupChecklist.js — TRUST-GATE-1.21 (V2 settings IA).
 *
 * Pure derivation of "what still needs setting up" for the V2 settings
 * tree, sourced entirely from data the app already fetches:
 *   - platformReadiness  → AppShell's /api/setup/status poll (readiness half)
 *   - setupSteps         → the SAME /api/setup/status response (steps half)
 *   - pluginCount        → getAllPluginManifests().length (local, synchronous)
 * No new network calls are introduced by this module or its consumers.
 *
 * Two consumers:
 *   - SettingsSidebarV2  pins the still-incomplete sections at the top
 *     of the sidebar (capability-gated via isSectionVisible).
 *   - SettingsLayout     renders a compact readiness checklist strip
 *     above the active V2 panel.
 *
 * Honesty note: the brief's illustrative item "Email configured" was
 * dropped — there is no already-fetched signal for SMTP completion
 * (setupReadiness.js probes services, not SMTP; the `steps.apiKeys`
 * flag is actually shared with the infrastructure step in the backend
 * response, not keys-only). Only genuinely-derivable items are listed
 * here; see TRUST-GATE-1.21 report for detail.
 */

import { getSectionById, isSectionVisible } from './settingsSections.js';

/**
 * Build the full checklist (done + pending) from already-available data.
 * Order matters — this is the display order for both the sidebar pin
 * group and the checklist strip.
 *
 * @param {Object} args
 * @param {Object|null} args.readiness    platformReadiness from AppShell (getSetupReadiness() payload)
 * @param {Object|null} args.setupSteps   steps from the same /setup/status response ({ admin, apiKeys, infrastructure })
 * @param {number} args.pluginCount       getAllPluginManifests().length
 * @returns {Array<{id: string, sectionId: string, label: string, done: boolean}>}
 */
export function buildSetupChecklist({ readiness, setupSteps, pluginCount } = {}) {
    return [
        {
            id: 'provider-keys',
            sectionId: 'instance/provider-keys',
            label: 'Provider key configured',
            done: Boolean(setupSteps?.apiKeys),
        },
        {
            id: 'services',
            sectionId: 'account/services',
            label: 'Services healthy',
            done: Boolean(readiness?.fullPlatformReady),
        },
        {
            id: 'plugins',
            sectionId: 'account/plugins',
            label: 'Plugins registered',
            done: Number(pluginCount) > 0,
        },
    ];
}

/**
 * Pending (not-done) subset, in the same priority order.
 * Returns [] when the platform is fully ready — the pin group and the
 * checklist strip should both disappear entirely in that case, even if
 * some individual signal is technically still missing (e.g. a service
 * flapped healthy again but the poll hasn't refreshed `apiKeys` yet —
 * fullPlatformReady is the authoritative "are we done" gate).
 */
export function getPendingSetupItems({ readiness, setupSteps, pluginCount } = {}) {
    if (readiness?.fullPlatformReady) return [];
    return buildSetupChecklist({ readiness, setupSteps, pluginCount }).filter(item => !item.done);
}

/**
 * Pending items resolved to registered settings sections and filtered
 * to what `principal` is actually allowed to see (capability-gated —
 * a user without instance scope never gets instance items pinned).
 * Returns [] when ready, or when the principal isn't resolved yet.
 */
export function getPinnedSetupSections({ readiness, setupSteps, pluginCount, principal } = {}) {
    if (!principal) return [];
    return getPendingSetupItems({ readiness, setupSteps, pluginCount })
        .map(item => {
            const section = getSectionById(item.sectionId);
            return section ? { ...item, section } : null;
        })
        .filter(Boolean)
        .filter(({ section }) => isSectionVisible(section, principal));
}
