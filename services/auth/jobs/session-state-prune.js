/**
 * jobs/session-state-prune.js — VAULT-AUDIT P3.C (F-4)
 *
 * pruneExpiredSessionState(db) (db/sessionState.js) was exported but never
 * called anywhere, so expired credential_session_state ciphertext rows
 * (encrypted browser session cookies, VAULT-AUDIT P3.B1) accumulated forever.
 * This wires a lightweight periodic sweep, following the same
 * setInterval + .unref() pattern as jobs/lease-expiry.js.
 */

import { getDb } from '../db/index.js';
import { pruneExpiredSessionState } from '../db/sessionState.js';

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let _interval = null;
let _lastRun = null;
let _lastPruned = 0;

function runPrune() {
    try {
        const pruned = pruneExpiredSessionState(getDb());
        _lastPruned = pruned;
        _lastRun = new Date().toISOString();

        if (pruned > 0) {
            console.log(`[SessionStatePrune] Pruned ${pruned} expired session-state row(s)`);
        }
    } catch (err) {
        console.error('[SessionStatePrune] Job failed:', err.message);
    }
}

/**
 * Start the session-state prune background job.
 * Idempotent — safe to call multiple times.
 */
export function startSessionStatePruneJob() {
    if (_interval) return; // Already running

    console.log('[SessionStatePrune] Starting background job (every 6h)');
    _interval = setInterval(runPrune, INTERVAL_MS);

    // Don't prevent process exit
    if (_interval.unref) _interval.unref();
}

/**
 * Stop the session-state prune background job.
 */
export function stopSessionStatePruneJob() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
        console.log('[SessionStatePrune] Stopped background job');
    }
}

/**
 * Run the prune sweep immediately (for testing / manual trigger).
 * Safe to call without starting the scheduler.
 */
export function runSessionStatePruneNow() {
    runPrune();
}

/**
 * Get health status of the prune job.
 */
export function getSessionStatePruneJobHealth() {
    return {
        running: !!_interval,
        lastRun: _lastRun,
        lastPruned: _lastPruned,
    };
}

export default {
    startSessionStatePruneJob,
    stopSessionStatePruneJob,
    runSessionStatePruneNow,
    getSessionStatePruneJobHealth,
};
