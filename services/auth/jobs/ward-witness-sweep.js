/**
 * #1078: retry auth audit witnesses the collector did not accept (lib/wardAdapter.js ward_witness_outbox).
 * Scheduler triad: a failed delivery is counted (sweep result + /health ward_witness), a pass with failures and no
 * progress doubles the interval (capped), and rows retire as 'dead' after the max attempts (never retried forever).
 * setTimeout chain + unref, like audit-event-reaper.js.
 */
import { sweepWardWitnessOutbox } from '../lib/wardAdapter.js';

const BASE_MS = 60 * 1000;
const CAP_MS = 15 * 60 * 1000;
let _timer = null;
let _interval = BASE_MS;

export async function runWardWitnessSweepOnce() {
  const r = await sweepWardWitnessOutbox();
  if (r.sent || r.failed || r.dead) console.log('[WARD-WITNESS] sweep sent=%d failed=%d dead=%d', r.sent, r.failed, r.dead);
  _interval = r.failed && !r.sent ? Math.min(_interval * 2, CAP_MS) : BASE_MS;
  return r;
}

export function startWardWitnessSweep() {
  if (_timer) return;
  const tick = async () => {
    try { await runWardWitnessSweepOnce(); } catch (err) { console.error('[WARD-WITNESS] sweep error:', err.message); _interval = Math.min(_interval * 2, CAP_MS); }
    _timer = setTimeout(tick, _interval);
    _timer.unref?.();
  };
  _timer = setTimeout(tick, BASE_MS);
  _timer.unref?.();
}

export function stopWardWitnessSweep() { if (_timer) clearTimeout(_timer); _timer = null; _interval = BASE_MS; }
