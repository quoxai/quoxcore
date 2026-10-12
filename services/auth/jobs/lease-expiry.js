/**
 * Lease Expiry Background Job
 *
 * Runs every 30 seconds to:
 * 1. Expire active leases past their TTL
 * 2. Cancel stale pending leases (no inbox item after 15 min)
 *
 * Also exposes health check data for monitoring.
 */

import { expireOverdueLeases, cancelStalePendingLeases } from '../db/integrations.js';

let _interval = null;
let _lastRun = null;
let _lastExpired = 0;
let _lastCancelled = 0;

const INTERVAL_MS = 30_000; // 30 seconds

function runExpiryCheck() {
    try {
        _lastExpired = expireOverdueLeases();
        _lastCancelled = cancelStalePendingLeases();
        _lastRun = new Date().toISOString();

        if (_lastExpired > 0 || _lastCancelled > 0) {
            console.log(`[LeaseExpiry] Expired: ${_lastExpired}, Cancelled: ${_lastCancelled}`);
        }
    } catch (err) {
        console.error('[LeaseExpiry] Job failed:', err.message);
    }
}

/**
 * Start the lease expiry background job
 */
export function startLeaseExpiryJob() {
    if (_interval) return; // Already running

    console.log('[LeaseExpiry] Starting background job (every 30s)');
    runExpiryCheck(); // Run immediately on start
    _interval = setInterval(runExpiryCheck, INTERVAL_MS);
}

/**
 * Stop the lease expiry background job
 */
export function stopLeaseExpiryJob() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
        console.log('[LeaseExpiry] Stopped background job');
    }
}

/**
 * Get health status of the expiry job
 * Used by /health endpoint to detect stale jobs
 */
export function getLeaseJobHealth() {
    const now = Date.now();
    const lastRunAge = _lastRun ? now - new Date(_lastRun).getTime() : null;
    const isHealthy = lastRunAge !== null && lastRunAge < 120_000; // Healthy if ran within 2 min

    return {
        running: !!_interval,
        lastRun: _lastRun,
        lastRunAgeMs: lastRunAge,
        healthy: isHealthy,
        lastExpired: _lastExpired,
        lastCancelled: _lastCancelled
    };
}

export default { startLeaseExpiryJob, stopLeaseExpiryJob, getLeaseJobHealth };
