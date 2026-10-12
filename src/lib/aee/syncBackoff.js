/**
 * Sync-loop backoff + circuit breaker — pure helpers.
 *
 * Replaces the old naive setInterval poll (fixed 30s regardless of outcome).
 * On every sync attempt the caller reports `success` or `failure`; this
 * module returns the delay to wait before the next attempt.
 *
 * Strategy:
 *   base = 30s (success case — steady state)
 *   on failure: 30s → 60s → 120s → 240s → 300s cap
 *   after N consecutive failures (`circuitThreshold`), trip the breaker
 *     and pause for `circuitPauseMs` (default 10 min) before trying again
 *   on first success: reset counters, back to base
 *
 * All values are integers in milliseconds.
 */

export const SYNC_BASE_MS = 30_000;        // 30s steady-state poll
export const SYNC_MAX_MS = 300_000;         // 5min max backoff before circuit-break
export const CIRCUIT_THRESHOLD = 10;        // consecutive failures before trip
export const CIRCUIT_PAUSE_MS = 600_000;    // 10min cool-off while tripped

/**
 * @param {{ consecutiveFailures: number, breakerTrippedAt: number|null }} state
 * @param {{ baseMs?, maxMs?, threshold?, pauseMs?, now? }} [opts]
 * @returns {number} Next delay in ms.
 */
export function nextSyncDelay(state, opts = {}) {
  const baseMs = opts.baseMs ?? SYNC_BASE_MS;
  const maxMs = opts.maxMs ?? SYNC_MAX_MS;
  const threshold = opts.threshold ?? CIRCUIT_THRESHOLD;
  const pauseMs = opts.pauseMs ?? CIRCUIT_PAUSE_MS;
  const now = opts.now ?? Date.now();

  const failures = Math.max(0, state?.consecutiveFailures | 0);

  // Circuit breaker is tripped: wait out the pause window as one big delay.
  if (state?.breakerTrippedAt) {
    const trippedAge = now - state.breakerTrippedAt;
    if (trippedAge < pauseMs) return pauseMs - trippedAge;
    // pause elapsed — fall through to normal backoff calc
  }

  if (failures === 0) return baseMs;

  // Each failure doubles the wait, capped at maxMs.
  const delay = Math.min(maxMs, baseMs * 2 ** failures);
  return delay;
}

/**
 * Returns the next state after a sync attempt.
 * @param {{ consecutiveFailures: number, breakerTrippedAt: number|null }} state
 * @param {'success' | 'failure'} outcome
 * @param {{ threshold?, now? }} [opts]
 */
export function updateSyncState(state, outcome, opts = {}) {
  const threshold = opts.threshold ?? CIRCUIT_THRESHOLD;
  const now = opts.now ?? Date.now();
  const prev = state || { consecutiveFailures: 0, breakerTrippedAt: null };

  if (outcome === 'success') {
    return { consecutiveFailures: 0, breakerTrippedAt: null, lastSuccessAt: now };
  }

  const nextFailures = (prev.consecutiveFailures | 0) + 1;
  const shouldTrip = nextFailures >= threshold;
  return {
    consecutiveFailures: nextFailures,
    breakerTrippedAt: shouldTrip ? (prev.breakerTrippedAt || now) : null,
    lastSuccessAt: prev.lastSuccessAt,
  };
}

/**
 * Human-readable status for UI surfacing.
 */
export function syncStatus(state, opts = {}) {
  const threshold = opts.threshold ?? CIRCUIT_THRESHOLD;
  const failures = state?.consecutiveFailures | 0;
  if (state?.breakerTrippedAt) return 'breaker-tripped';
  if (failures >= threshold) return 'breaker-tripped'; // defensive
  if (failures === 0) return 'healthy';
  if (failures < 3) return 'degraded';
  return 'failing';
}
