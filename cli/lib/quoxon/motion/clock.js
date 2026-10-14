/**
 * The motion engine's one clock (CLI-QUOX motion). Every animation and every visible tick in the client
 * (activity word decode, Q state colour, elapsed timer, roster clock, composer ring, drop-in reveals, intro,
 * approval arming) declares a DEMAND each render; the clock keeps exactly one timer armed for the soonest
 * demand and none at all when nothing asks. Idle is still: no timers, no renders.
 *
 * Demand shapes: { every: ms } (repeat while declared) or { at: epochMs } (one wake at that time).
 */
import { normaliseLevel } from './level.js';
export const FRAME_MS = 83; // ~12 fps for anything that moves
export const SECOND_MS = 1000;

/** Delay until the next wake for these demands, or null when nothing is waiting. Pure. */
export function nextDelay(demands, now) {
  let best = null;
  for (const d of demands || []) {
    if (!d) continue;
    let ms = null;
    if (Number.isFinite(d.every) && d.every > 0) {
      // second ticks align to the wall-clock second so "3s" changes when a second actually passes
      ms = d.every >= SECOND_MS && Number.isFinite(d.since) ? d.every - ((now - d.since) % d.every) : d.every;
    } else if (Number.isFinite(d.at)) ms = Math.max(0, d.at - now);
    if (ms != null && (best == null || ms < best)) best = ms;
  }
  return best == null ? null : Math.max(1, Math.round(best));
}

export class Clock {
  constructor(onTick, timers = { setTimeout, clearTimeout }) {
    this.onTick = onTick; this.timers = timers; this.id = null; this.dueAt = null; this.stopped = false;
    this.ticks = 0; this.lastTickAt = null;
  }
  /** Re-arm for the given demands (called after every render). Keeps the timer when it is already due sooner or equal. */
  schedule(demands, now = Date.now()) {
    if (this.stopped) return null;
    const d = nextDelay(demands, now);
    if (d == null) { this.cancel(); return null; }
    const due = now + d;
    if (this.id != null && this.dueAt != null && this.dueAt <= due + 2) return this.dueAt - now;
    this.cancel();
    this.dueAt = due;
    this.id = this.timers.setTimeout(() => {
      this.id = null; this.dueAt = null; this.ticks++; this.lastTickAt = Date.now();
      if (!this.stopped) this.onTick();
    }, d);
    return d;
  }
  cancel() { if (this.id != null) this.timers.clearTimeout(this.id); this.id = null; this.dueAt = null; }
  stop() { this.stopped = true; this.cancel(); }
  get armed() { return this.id != null; }
}

/** Motion is decoration: off at the quiet level (QUOX_MOTION=quiet, QUOX_REDUCED_MOTION=1, QUOX_TUI_LITE), or when not on a real terminal. Colour is separate (NO_COLOR). */
export const reducedMotion = (env = process.env) => env.QUOX_REDUCED_MOTION === '1' || Boolean(env.QUOX_TUI_LITE) || normaliseLevel(env.QUOX_MOTION) === 'quiet';
export const motionAllowed = (isTTY, env = process.env) => Boolean(isTTY) && !reducedMotion(env);

/**
 * Frame source: the clock's ticks fan out to the animated leaves only (Working, the composer ring, items that
 * are revealing), so a frame re-renders those components instead of the whole app. get() is the frame time.
 */
export function createFrames(now = Date.now()) {
  let t = now;
  const subs = new Set();
  return {
    get: () => t,
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    emit(at = Date.now()) { t = at; for (const fn of [...subs]) fn(); },
    get size() { return subs.size; }
  };
}
