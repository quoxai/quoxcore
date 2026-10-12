/**
 * Legacy hash anchor alias manifest — SET-IA Phase 6.
 *
 * Pre-Phase-1 callers used short hash anchors like /settings#vault,
 * /settings#plugins, /settings#voice. Phase 1 introduced canonical
 * scope-prefixed ids (account/integrations, account/plugins, etc).
 *
 * To avoid a 40+ file rename PR + bookmark rot, this manifest maps
 * every short anchor declared in `legacyHash` on a section back to
 * its canonical id. The map is derived directly from the section
 * registry — there is nothing to maintain by hand.
 *
 * Consumers:
 *   - useV2HashSection in SettingsLayout (read on hashchange)
 *   - Phase 7's flip will keep this manifest live as long as Phase 6
 *     deploys before the v1 sidebar is removed; Phase 8 audits whether
 *     any can be retired.
 */

import { SETTINGS_SECTIONS, getSectionById } from './settingsSections.js';

export const LEGACY_ANCHOR_ALIASES = Object.freeze(
    Object.fromEntries(
        SETTINGS_SECTIONS
            .filter(s => s.legacyHash)
            .map(s => [s.legacyHash, s.id])
    )
);

/**
 * Translate a legacy hash anchor (e.g. 'vault') into a canonical
 * section id (e.g. 'account/integrations'). Returns null for:
 *   - unknown anchors
 *   - already-canonical ids (caller should use them directly)
 *   - falsy input
 *
 * Caller pattern:
 *   const id = getSectionById(raw) ? raw : resolveLegacyAnchor(raw);
 */
export function resolveLegacyAnchor(hash) {
    if (!hash || typeof hash !== 'string') return null;
    if (getSectionById(hash)) return null;       // already canonical
    return LEGACY_ANCHOR_ALIASES[hash] || null;
}
