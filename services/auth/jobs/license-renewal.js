/**
 * jobs/license-renewal.js — LICENSE-ENFORCE LE-2
 *
 * Leases are short-lived (72h, quox.ai side) by design: a quox.ai blip must
 * not kill a customer's premium entitlements (licenseClient.renewAll() keeps
 * the lease on network error), but a lease that is never renewed must not
 * grant entitlements forever either. This job renews every stored lease
 * every 6h, plus once at boot (non-blocking) so a freshly restarted
 * instance re-syncs immediately instead of waiting for the first interval
 * tick. Follows the same setInterval + .unref() pattern as
 * jobs/session-state-prune.js and jobs/lease-expiry.js.
 */

import { renewAll } from '../lib/licenseClient.js';
import { clearEntitlementsCache } from '../lib/entitlements.js';

// Exported (LICENSE-LAUNCH LL-3c) so the soak harness can advance fake timers
// by exactly one scheduling period instead of hardcoding a copy of it. A
// hardcoded 6h in the test would silently stop testing the schedule the day
// this constant changes. Value and behaviour are unchanged.
export const LICENSE_RENEWAL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const INTERVAL_MS = LICENSE_RENEWAL_INTERVAL_MS;

let _interval = null;
let _lastRun = null;
let _lastResults = [];

async function runRenewal() {
    try {
        const results = await renewAll();
        _lastResults = results;
        _lastRun = new Date().toISOString();
        // A renewed/removed lease changes what hasPlugin()/getEntitlements()
        // return — drop the 10s cache so the next request sees it immediately.
        clearEntitlementsCache();

        if (results.length > 0) {
            const renewed = results.filter((r) => r.action === 'renewed').length;
            const removed = results.filter((r) => r.action === 'removed').length;
            const kept = results.length - renewed - removed;
            console.log(`[LicenseRenewal] ${renewed} renewed, ${removed} removed, ${kept} kept`);
        }
    } catch (err) {
        console.error('[LicenseRenewal] Job failed:', err.message);
    }
}

/**
 * Start the license renewal background job. Idempotent — safe to call
 * multiple times. Runs once immediately (non-blocking) then every 6h.
 */
export function startLicenseRenewalJob() {
    if (_interval) return; // Already running

    console.log('[LicenseRenewal] Starting background job (boot run + every 6h)');

    // Non-blocking boot run — don't hold up server startup on quox.ai reachability.
    runRenewal();

    _interval = setInterval(runRenewal, INTERVAL_MS);
    if (_interval.unref) _interval.unref();
}

/**
 * Stop the license renewal background job.
 */
export function stopLicenseRenewalJob() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
        console.log('[LicenseRenewal] Stopped background job');
    }
}

/**
 * Run the renewal sweep immediately (for testing / manual trigger).
 * Safe to call without starting the scheduler.
 */
export function runLicenseRenewalNow() {
    return runRenewal();
}

/**
 * Get health status of the renewal job.
 */
export function getLicenseRenewalJobHealth() {
    return {
        running: !!_interval,
        lastRun: _lastRun,
        lastResults: _lastResults,
    };
}

export default {
    startLicenseRenewalJob,
    stopLicenseRenewalJob,
    runLicenseRenewalNow,
    getLicenseRenewalJobHealth,
};
