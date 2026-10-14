/**
 * LUCID deck motion: pure helpers for the deck's ONE clock (quoxon/motion/clock.js).
 *
 * Idle is still. The deck declares a demand each render; the clock keeps one timer for the soonest demand and
 * none at all when nothing asks. Frames (~12 fps) are demanded ONLY while something is visibly moving: a fetch
 * in flight (the Q works), the Q settling after a state change (a short window, then still colour), or a
 * card dropping in. Everything else is a one-shot wake (toast expiry, ghost expiry, the minute tick).
 *
 * LUCID state -> Q state (qglyph.js): needs you = waiting, fetching = working, unreachable = failing,
 * quiet = resting. Failing wins over working so an outage never reads as busy.
 */
import { FRAME_MS } from '../quoxon/motion/clock.js';

export { FRAME_MS };
/** After a state change the Q animates this long, then holds a still colour (no timer, no writes). */
export const SETTLE_MS = 2400;
/** A card dropping in is revealing for this long from its start (rows decode, then a short afterglow). */
export const REVEAL_MS = 1500;
/** Cards of one load start this far apart so the board fills top to bottom. */
export const STAGGER_MS = 70;

export function glyphStateOf({ err = null, fetching = false, needs = 0 } = {}) {
  if (err) return 'failing';
  if (fetching) return 'working';
  return needs > 0 ? 'waiting' : 'resting';
}

/** Is the Q moving at `now`? Working moves while it lasts; every other state settles after SETTLE_MS. */
export function glyphAnimating({ state, since, now, motion }) {
  if (!motion) return false;
  if (state === 'working') return true;
  return since != null && now - since < SETTLE_MS;
}

/** Seconds into a card's reveal, or Infinity when settled (or motion is off). A future start is negative. */
export function revealT(startAt, now, motion) {
  if (!motion || startAt == null) return Infinity;
  const ms = now - startAt;
  return ms >= REVEAL_MS ? Infinity : ms / 1000;
}

/**
 * The demands for this render. frames: something is moving right now. at: epoch ms of one-shot wakes
 * (past or null entries are ignored). Without motion there are no frame demands at all.
 */
export function deckDemands({ motion = false, frames = false, at = [], now = Date.now() } = {}) {
  const d = [];
  if (motion && frames) d.push({ every: FRAME_MS });
  let soonest = null;
  for (const a of at) if (Number.isFinite(a) && a > now && (soonest == null || a < soonest)) soonest = a;
  if (soonest != null) d.push({ at: soonest });
  return d;
}

/** Next wall-clock minute boundary for a displayed time (the injected clock, so tests stay deterministic). */
export const nextMinuteAt = (wall, shown) => wall + (60000 - (shown % 60000));
