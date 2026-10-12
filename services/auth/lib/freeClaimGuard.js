/**
 * lib/freeClaimGuard.js — LICENSE-LAUNCH LL-8
 *
 * The FREE-ONLY GUARD for the self-serve free-claim device flow. Owner ruling:
 * free (conversion-ladder) plugins get a self-serve claim path WITHOUT
 * instance admin; PAID activation stays instance-admin gated and untouched
 * (routes/setup.js POST /licensing/device/start|poll, POST /licensing/activate).
 *
 * A free-claim poll must never store a lease carrying a paid entitlement or a
 * `plan.<tier>` grant, even if the control plane itself is compromised or
 * buggy and hands one back on an approved free-claim poll. This module is
 * that last line: every license_key an approved free-claim poll is about to
 * activate is parsed and checked here BEFORE lib/licenseClient.js activate()
 * ever sees it. Fail closed — any parse failure, any plan grant, any id that
 * is not KNOWN and FREE in the signed catalogue refuses the whole key.
 *
 * Deliberately reuses lib/entitlements.js parseEntitlementEntry() for the
 * org-scope suffix grammar (`<id>` / `<id>@orgs=<N>`) and its
 * PLAN_ENTITLEMENT_PREFIX constant, rather than a second regex that could
 * drift from the resolver's own parsing.
 */

import { parseEntitlementEntry, PLAN_ENTITLEMENT_PREFIX, FALLBACK_FREE_ENTITLEMENT_IDS } from './entitlements.js';
import { freeIdsFromCatalog } from './signedCatalog.js';

/**
 * The free-id universe to check against: the signed catalogue's price === 0
 * ids when a verified snapshot is installed, else the documented pre-cutover
 * fallback list (same fallback posture as isPaidEntitlementId() in
 * entitlements.js — catalogue is the authority when present, the hardcoded
 * list otherwise).
 *
 * @param {{ products: object[] }|null} catalog result of loadSignedCatalog()
 * @returns {Set<string>}
 */
export function freeOnlyIdSet(catalog) {
    return catalog ? freeIdsFromCatalog(catalog.products) : FALLBACK_FREE_ENTITLEMENT_IDS;
}

/**
 * Parse a v2 license key JSON string and assert every entitlement it carries
 * is a free product. Pure: takes the catalogue as a parameter, does no I/O.
 *
 * @param {string} keyString  raw license_key string (JSON.stringify'd v2 object)
 * @param {{ products: object[] }|null} catalog  result of loadSignedCatalog()
 * @returns {{ ok: true } | { ok: false, error: string, message?: string }}
 */
export function assertFreeOnlyLicenseKey(keyString, catalog) {
    if (typeof keyString !== 'string' || !keyString) {
        return { ok: false, error: 'malformed_license_key', message: 'license_key is missing or not a string' };
    }

    let parsed;
    try {
        parsed = JSON.parse(keyString);
    } catch (err) {
        return { ok: false, error: 'malformed_license_key', message: `license_key is not valid JSON: ${err.message}` };
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entitlements)) {
        return { ok: false, error: 'malformed_license_key', message: 'license_key carries no entitlements[] array' };
    }

    const freeIds = freeOnlyIdSet(catalog);

    for (const raw of parsed.entitlements) {
        const str = String(raw);

        // plan.<tier> is never a free-claim grant, regardless of what the
        // catalogue says — a plan tier is not a product it could ever price
        // as free.
        if (str.startsWith(PLAN_ENTITLEMENT_PREFIX)) {
            return {
                ok: false,
                error: 'plan_entitlement_not_free',
                message: `entitlement '${str}' is a plan grant, not a free product`,
            };
        }

        const { pluginId } = parseEntitlementEntry(str);
        if (!freeIds.has(pluginId)) {
            return {
                ok: false,
                error: 'paid_or_unknown_entitlement',
                message: `entitlement '${pluginId}' is not a free product in the signed catalogue`,
            };
        }
    }

    return { ok: true };
}

export default { freeOnlyIdSet, assertFreeOnlyLicenseKey };
