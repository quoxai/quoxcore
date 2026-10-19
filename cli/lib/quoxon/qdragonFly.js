// /dragon-fly: the v8 dragon in flight (canonical source: quox cli/lib/quoxon/qdragonFly.js).
//
// The same dragon as everywhere else (googly dot eyes, the smile, pink cheeks, dim bat wings, the spade tail),
// made by the same composeCells; in flight the wings are bigger and beat hard, the body bobs with each stroke, the
// tail streams behind and the eyes look the way it is going. It crosses the sky once, left to right.
//
// PURE AND PORTABLE: no DOM, no timers, no Node APIs. flyFrame(ms, cols, opts) -> rows of { ch, rgb, bg } cells.
import { dragonLayout, restPose, kf, DSIZES } from './qdragon.js';
import { composeCells, PICK_EYES } from './qdragonScenes.js';
import { eyeState } from './qeyes.js';

const TAU = Math.PI * 2;
export const FLAP_MS = 760; // one wingbeat
export const FLY_PASS_MS = 9000; // one pass across the sky
export const FLY_STILL_MS = 3000; // how long the still frame stays for reduced motion / NO_COLOR
const SIZE = 'mid';
const WING_SCALE = 1.7;
const TOP = 26; // dots of sky above the Q: room for the raised wings and the bob
const BOB = 5; // dots the body rises and falls with each stroke
const SPAN = 30; // cells of overshoot either side so the wings enter and leave whole

/** The widest sky (in cells) worth drawing: never wider than `cols`; the dragon is 18 cells tall at most, so termRows is not a limit. */
export function flyCols(cols) {
  return Math.max(40, Math.min(cols, 120));
}

/** The dragon's pose in flight at ms into the pass. */
export function flyPose(ms) {
  const p = restPose(), ph = (TAU * ms) / FLAP_MS;
  p.wingScale = WING_SCALE;
  p.flap = -0.2 + 0.8 * Math.sin(ph);
  p.tail.len = 1.55; p.tail.k = 3.2; p.tail.amp = 1.5; p.tail.phase = ms * 0.009;
  p.smile = 0.3;
  return p;
}

/** The frame at `ms` since the pass began. still: the one fixed frame (mid-sky, wings raised). mono: shapes only. */
/** The sky's size for a terminal `termRows` tall: the mid Q, or the small Q (headroom scaled to match) when the mid sky would
 *  not leave 10 rows for the transcript and composer. Never taller than max(12, termRows - 10). */
export function flySky(termRows) {
  const room = Math.max(12, (termRows || 40) - 10);
  const fits = (size, top) => dragonLayout(120, { size, lm: 0, ty: top }).rows <= room;
  if (fits(SIZE, TOP)) return { size: SIZE, top: TOP, bob: BOB };
  const k = DSIZES.small / DSIZES[SIZE];
  return { size: 'small', top: Math.round(TOP * k), bob: Math.max(1, Math.round(BOB * k)) };
}

export function flyFrame(ms, cols, { still = false, mono = false, theme = 'dark', termRows } = {}) {
  const t = still ? 0 : Math.max(0, Math.min(ms, FLY_PASS_MS));
  const { size: SIZE, top: TOP, bob: BOB } = flySky(termRows);
  const probe = dragonLayout(cols, { size: SIZE, lm: 0, ty: TOP });
  const rows = probe.rows;
  const xc = still ? cols / 2 : -SPAN + (cols + 2 * SPAN) * kf(t, [[0, 0], [FLY_PASS_MS, 1]]);
  const lm = Math.round(xc - probe.qw / 4);
  const ph = (TAU * t) / FLAP_MS, bob = still ? 0 : BOB * Math.cos(ph);
  const L = dragonLayout(cols, { size: SIZE, lm, ty: Math.round(TOP - 2 + bob), rows });
  const pose = flyPose(t);
  if (still) pose.flap = 0.55; // wings up
  const eyes = still ? eyeState('open', 0) : { ...eyeState('idle', t), gx: 0.9, gy: 0.5 };
  return composeCells(pose, eyes, L, PICK_EYES, { theme, mono, t });
}
