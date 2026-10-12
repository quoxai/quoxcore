/**
 * LIFECYCLE-P1-D3 — Powers Deprecation TTL Background Job
 *
 * Runs once daily to drop tool_installations.config_json.available_tools entries
 * that have been deprecated for more than 30 days AND have not reappeared.
 *
 * Uses the same setTimeout-chain pattern as retentionService.js and
 * backupScheduler.js — single daily fire, .unref() so the timer doesn't
 * prevent clean process exit.
 */

import { getDb } from '../db/index.js';
import { dropExpiredDeprecations } from '../lib/powersAvailableToolsDrift.js';

const DAILY_MS = 24 * 60 * 60 * 1000;
// Default: run at 04:00 UTC (offset from retention's 03:00 to avoid contention)
const DEFAULT_RUN_HOUR = 4;

let _timer = null;

function msUntilNextRun(targetHour) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(targetHour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function runCleanup() {
  try {
    const db = getDb();
    const { dropped, installations_scanned } = dropExpiredDeprecations(db);
    if (dropped > 0 || installations_scanned > 0) {
      console.log(
        '[LIFECYCLE-P1-D3] Daily cleanup done: dropped=%d scanned=%d',
        dropped, installations_scanned
      );
    }
  } catch (err) {
    console.error('[LIFECYCLE-P1-D3] Daily cleanup failed:', err.message);
  }
}

/**
 * Start the daily deprecation-TTL cleanup job.
 * Idempotent — safe to call multiple times.
 */
export function startDeprecationTtlJob() {
  if (_timer) {
    console.log('[LIFECYCLE-P1-D3] Deprecation TTL job already running');
    return;
  }

  const scheduleNext = () => {
    const delay = msUntilNextRun(DEFAULT_RUN_HOUR);
    const nextRun = new Date(Date.now() + delay).toISOString();
    console.log('[LIFECYCLE-P1-D3] Next deprecation TTL run at %s', nextRun);

    _timer = setTimeout(() => {
      runCleanup();
      scheduleNext();
    }, delay);

    // Don't prevent process exit
    if (_timer.unref) _timer.unref();
  };

  scheduleNext();
  console.log('[LIFECYCLE-P1-D3] Deprecation TTL job started (daily at %d:00 UTC)', DEFAULT_RUN_HOUR);
}

/**
 * Stop the daily cleanup job.
 */
export function stopDeprecationTtlJob() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
    console.log('[LIFECYCLE-P1-D3] Deprecation TTL job stopped');
  }
}

/**
 * Run cleanup immediately (for testing / manual trigger).
 * Safe to call without starting the scheduler.
 */
export function runDeprecationTtlNow() {
  runCleanup();
}
