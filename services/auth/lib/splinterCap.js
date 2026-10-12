/**
 * lib/splinterCap.js — QUOXIDENTITY P9 (#487): the per-agent splinter cap.
 *
 * Resolution order (NO-ENV-ONLY-CONFIG): org setting QUOX_MAX_SPLINTERS
 * (configResolver.getSetting, org-scoped), then the instance-wide setting
 * (getInstanceSetting), then the process env QUOX_MAX_SPLINTERS as a
 * last-resort fallback, then DEFAULT_MAX_SPLINTERS (4). configResolver never
 * throws and resolves null on any failure, so this always yields a number.
 */
import { getSetting, getInstanceSetting } from './configResolver.js';
import { DEFAULT_MAX_SPLINTERS } from './agentAttachStore.js';

export const MAX_SPLINTERS_KEY = 'QUOX_MAX_SPLINTERS';

function toCap(v) {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : null;
}

export async function resolveMaxSplinters(orgId, deps = {}) {
    for (const lookup of [
        () => getSetting(orgId, MAX_SPLINTERS_KEY, deps),
        () => getInstanceSetting(MAX_SPLINTERS_KEY, deps),
    ]) {
        try {
            const r = await lookup();
            const cap = r && toCap(r.value);
            if (cap) return cap;
        } catch (err) {
            console.error('[Auth splinterCap] resolver failed, falling back —', err.message);
        }
    }
    return toCap(process.env.QUOX_MAX_SPLINTERS) || DEFAULT_MAX_SPLINTERS;
}
