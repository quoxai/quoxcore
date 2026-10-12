/**
 * Service Health Scheduler Daemon
 *
 * Follow-up to the FALSE-OFFLINE bug fix (2026-07): the `services` table's
 * health_endpoint columns now correctly point at compose service DNS names
 * instead of localhost, BUT nothing was periodically re-checking them — rows
 * sat at status='unknown' until an admin manually clicked "Check Now" on the
 * Observability "Service Health" cards. After any boot/migration the cards
 * showed UNKNOWN indefinitely.
 *
 * This scheduler reuses the exact probe+classify logic from
 * POST /admin/services/:id/check (routes/admin.js), now shared via
 * probeServiceHealth() in utils/serviceHealthClassifier.js, and applies it
 * on a timer to every row in `services` so cards populate without manual
 * intervention.
 *
 * Pattern mirrors services/backupScheduler.js: setInterval + .unref() so the
 * timer never keeps the process alive, an isRunning guard against
 * overlapping ticks, an env-configurable interval, and an initial check
 * shortly after boot so cards populate quickly instead of waiting a full
 * interval.
 */

import { prepare } from '../db/index.js';
import { startAdaptiveInterval } from '../lib/configResolver.js';
import { probeServiceHealth } from '../utils/serviceHealthClassifier.js';

// Configuration
const CHECK_INTERVAL_MS = parseInt(process.env.SERVICE_HEALTH_CHECK_INTERVAL_MS || '60000', 10); // 1 minute
const INITIAL_CHECK_DELAY_MS = parseInt(process.env.SERVICE_HEALTH_INITIAL_DELAY_MS || '5000', 10); // 5 seconds

let schedulerInterval = null;
let initialCheckTimeout = null;
let isRunning = false; // Prevent concurrent check runs

/**
 * Check a single service's health endpoint and persist the result.
 * Reuses the shared probe+classify step (see serviceHealthClassifier.js) —
 * the same code path the admin-triggered "Check Now" button uses.
 */
async function checkOneService(service) {
    if (!service.health_endpoint) {
        return; // Nothing to probe; leave status as-is (e.g. 'unknown')
    }

    try {
        const { status, statusMessage } = await probeServiceHealth(service);

        const updateSql = status === 'healthy'
            ? `UPDATE services SET status = ?, status_message = ?, last_check_at = datetime('now'), last_healthy_at = datetime('now') WHERE id = ?`
            : `UPDATE services SET status = ?, status_message = ?, last_check_at = datetime('now') WHERE id = ?`;

        prepare(updateSql).run(status, statusMessage, service.id);
    } catch (err) {
        console.error(`[ServiceHealthScheduler] Check failed for ${service.id}: ${err.message}`);
    }
}

/**
 * Check every registered service's health endpoint.
 */
export async function checkAllServices() {
    if (isRunning) return; // Prevent concurrent runs
    isRunning = true;

    try {
        const services = prepare('SELECT * FROM services').all();

        // Run checks sequentially (small fixed set of services; avoids
        // hammering the network stack all at once and keeps behavior
        // predictable/testable, mirroring backupScheduler's sequential loop).
        for (const service of services) {
            await checkOneService(service);
        }
    } catch (err) {
        console.error(`[ServiceHealthScheduler] Check run failed: ${err.message}`);
    } finally {
        isRunning = false;
    }
}

/**
 * Start the service health scheduler daemon.
 */
export function startServiceHealthScheduler() {
    if (schedulerInterval) {
        console.log('[ServiceHealthScheduler] Already running');
        return;
    }

    console.log(`[ServiceHealthScheduler] Starting (check interval: ${CHECK_INTERVAL_MS}ms)`);

    // Run an initial check shortly after boot so the Observability cards
    // populate quickly instead of sitting at 'unknown' for a full interval.
    initialCheckTimeout = setTimeout(() => {
        checkAllServices();
    }, INITIAL_CHECK_DELAY_MS);
    initialCheckTimeout.unref();

    // Set up recurring check
    // SETEC S3: SERVICE_HEALTH_CHECK_INTERVAL_MS stored setting re-read each
    // tick (live, no restart). Don't prevent process exit (unref).
    schedulerInterval = startAdaptiveInterval('SERVICE_HEALTH_CHECK_INTERVAL_MS', CHECK_INTERVAL_MS, () => {
        checkAllServices();
    }, { unref: true });
}

/**
 * Stop the service health scheduler daemon.
 */
export function stopServiceHealthScheduler() {
    if (initialCheckTimeout) {
        clearTimeout(initialCheckTimeout);
        initialCheckTimeout = null;
    }
    if (schedulerInterval) {
        schedulerInterval.stop();
        schedulerInterval = null;
        console.log('[ServiceHealthScheduler] Stopped');
    }
}

export default { startServiceHealthScheduler, stopServiceHealthScheduler, checkAllServices };
