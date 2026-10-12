/**
 * LL-7 D1 — helpers for the READ-ONLY licensing surface exposed to plugin
 * bundles on window.__quoxSharedDeps.LicenseValidator (built in
 * thirdPartyPluginHost.js).
 *
 * The sync licenseValidator readers that return objects/arrays hand out LIVE
 * references into the module-scope entitlement cache (_orgBands[x],
 * _serverLicenseCache, _serverPluginLicensesCache). A loaded plugin bundle is
 * ordinary same-origin code, so handing it a live reference lets it do
 * `window.__quoxSharedDeps.LicenseValidator.getOrgBand('x').org_licensed = true`
 * and flip the client gate with no writer ever exposed. Wrapping those readers
 * with frozenCloneReader hands the bundle a FROZEN DEEP CLONE instead — readable,
 * not mutable, and disconnected from the host's cache.
 *
 * Extracted from thirdPartyPluginHost.js so the freeze contract is unit-testable
 * without loading the full host module graph (React + every plugin surface).
 * The CORE app keeps importing licenseValidator directly and gets the real
 * (unfrozen) values — only the window surface freezes.
 */

/** Recursively freeze an object/array in place. Primitives pass through. */
export function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    for (const key of Object.getOwnPropertyNames(obj)) {
        const value = obj[key];
        if (value !== null && typeof value === 'object') deepFreeze(value);
    }
    return Object.freeze(obj);
}

/** Wrap a reader so its object/array return is handed out as a frozen deep
 *  clone. Guards null and non-object returns (passed through untouched). */
export function frozenCloneReader(fn) {
    return (...args) => {
        const value = fn(...args);
        if (value === null || typeof value !== 'object') return value;
        return deepFreeze(structuredClone(value));
    };
}
