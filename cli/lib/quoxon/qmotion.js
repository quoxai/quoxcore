/**
 * Ink adaptors for the pure Q frames (qart.js, qglyph.js, qhello.js): the status glyph, the hello intro
 * used by Getting started. The frame math lives in the pure modules
 * so the web face draws the same frames; this file only maps cells to <Text>.
 */
import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { qGlyph, glyphMode, colorDepth } from './qglyph.js';
import { labSize, qDims, introPlan, INTRO_MS } from './qart.js';
import { helloCells, helloGradient, helloMs } from './qhello.js';
import { mono, c, clip, isLight } from './theme.js';
import { CLIPS, clipCells, clipCaption, eggCells, EGG_MS } from './qdragonScenes.js';
import { reducedMotion } from './motion/clock.js';
import { FrameContext, useFrame } from './motion/frame.js';
const isQuiet = () => reducedMotion(); // motion only (NO_COLOR is colour only; QGlyph falls back to the circled Q itself)
import { termRows } from './term.js';

const h = React.createElement;
const rgbS = (rgb) => (rgb ? `rgb(${rgb.join(',')})` : undefined);

/** Runs of same-coloured cells -> one <Text> each (keeps Ink's per-frame tokenising cheap). */
export function cellNodes(cells, keyBase = 'c') {
  const out = [];
  let run = '', col, bg, bold = false, k = 0;
  const flush = () => { if (run) out.push(h(Text, { key: `${keyBase}${k++}`, color: col, backgroundColor: bg, bold }, run)); run = ''; };
  for (const cl of cells) {
    const cc = rgbS(cl.rgb), bb = rgbS(cl.bg), b = Boolean(cl.bold); // bg: the dragon's quadrant-block eyes
    if (cc !== col || bb !== bg || b !== bold) { flush(); col = cc; bg = bb; bold = b; }
    run += cl.ch;
  }
  flush();
  return out;
}

let envCache = null;
const envGlyph = () => (envCache ??= { mode: glyphMode(process.env), depth: colorDepth(process.env) });

/**
 * The status glyph: the perpetual Q for a state at ms (sample it from the shared clock, ~12 fps). One fixed
 * shape; only its colour moves. since: when the state began (failing flashes from there). Ⓠ under NO_COLOR.
 */
export function QGlyph({ state = 'working', ms = Date.now(), since = null, quiet = isQuiet() }) {
  const { mode, depth } = envGlyph();
  const g = qGlyph(state, ms, { mono: mono(), quiet, mode, depth, since });
  return h(Text, { bold: true }, ...cellNodes(g.cells, 'g'));
}

// ---- hello intro (Getting started) ----------------------------------------------------------------------
import { HELLO } from './onboarding/copy.js';
export { HELLO };
/** Total ms of the hello intro: Orbit & Lock, the greeting decode, then (egg) the dragon's googly-eye greeting. */
export const helloIntroMs = ({ eye = false, text = HELLO } = {}) => INTRO_MS + helloMs(text) + (eye ? EGG_MS + 400 : 0);

/**
 * The Q, then the Q says hello beside it. t: ms since the intro started (Infinity = settled). The greeting
 * decodes in once the Q has locked; the egg (the dragon's googly-eye greeting) plays after the greeting has landed.
 */
export function HelloIntro({ item, cols, rows, t = Infinity, eye = false, text = HELLO }) {
  const { stdout } = useStdout();
  const size = labSize(cols, rows ?? termRows(stdout) ?? 40);
  const color = !mono();
  const helloAt = t - INTRO_MS;
  const plan = introPlan(size, { color });
  let cells;
  if (eye && helloAt >= helloMs(text)) cells = eggCells(size, helloAt - helloMs(text), { color, theme: isLight() ? 'light' : 'dark' });
  else cells = plan.at(Math.min(t, INTRO_MS));
  const wide = cols >= 60;
  const w = qDims(size).cols;
  const hello = helloCells(text, Number.isFinite(helloAt) ? Math.max(-1000, helloAt) : 1e9, { fg: helloGradient(text), mono: !color });
  const info = h(Box, { flexDirection: 'column', justifyContent: 'center', marginLeft: wide ? 2 : 0, marginTop: wide ? 0 : 1 },
    h(Text, { bold: true }, ...cellNodes(hello, 'h')),
    h(Text, { color: c('dim') }, clip(item?.text || '', cols - (wide ? w + 4 : 2))));
  return h(Box, { flexDirection: wide ? 'row' : 'column', marginBottom: 1 },
    h(Box, { flexDirection: 'column' }, ...cells.map((row, k) => h(Text, { key: k, wrap: 'truncate' }, ...cellNodes(row, `r${k}-`)))),
    info);
}

// ---- /dragon: the living dragon on demand (and the cinematic moods) ---------------------------------------
const dragonListeners = new Set();
let dragonNow = null; // { clip, start }
export const DRAGON_STILL_MS = 2000;
/** Play a dragon clip now ('pick' for /dragon, 'idle' for /dragon classic (both the hero), 'fire' for /dragon fire, or a mood). Returns true. */
export function playDragon(clip = 'pick', now = Date.now()) {
  if (!CLIPS[clip]) return false;
  dragonNow = { clip, start: now };
  for (const fn of dragonListeners) fn();
  return true;
}
/** The clip playing at `now`, or null. Reduced motion or NO_COLOR: a still dragon for DRAGON_STILL_MS. */
export function dragonPlaying(now = Date.now(), still = isQuiet() || mono()) {
  if (!dragonNow) return null;
  const span = still ? DRAGON_STILL_MS : CLIPS[dragonNow.clip].dur + 300;
  return now - dragonNow.start < span ? { ...dragonNow, t: now - dragonNow.start, still } : null;
}
export const dragonActive = (now = Date.now(), still) => dragonPlaying(now, still) != null;
/** Test hook: forget any clip in flight. */
export const resetDragon = () => { dragonNow = null; };

/**
 * Mounted once in the live region; renders nothing until /dragon (or a cinematic mood). The clip plays in the
 * live region and never enters history. Short terminals (under 32 rows) get the compact dragon. Reduced
 * motion or NO_COLOR: the static dragon (shapes only under NO_COLOR) for two seconds.
 */
export function DragonLive({ cols, rows }) {
  const { stdout } = useStdout();
  const onClock = React.useContext(FrameContext) != null;
  useFrame();
  const [, bump] = React.useState(0);
  React.useEffect(() => { const fn = () => bump((x) => x + 1); dragonListeners.add(fn); return () => dragonListeners.delete(fn); }, []);
  const now = Date.now();
  const p = dragonPlaying(now);
  React.useEffect(() => {
    if (!p || onClock) return undefined; // standalone only (no shared clock): its own bounded timer
    const id = setInterval(() => { bump((x) => x + 1); if (!dragonActive()) clearInterval(id); }, p.still ? 500 : 40);
    return () => clearInterval(id);
  }, [Boolean(p), p?.still, onClock]);
  if (!p) return null;
  const tall = (rows ?? termRows(stdout) ?? 40) >= 32;
  const cells = clipCells(p.clip, p.t, { cols, theme: isLight() ? 'light' : 'dark', mono: mono(), still: p.still, size: tall ? undefined : 'mid' });
  const caption = p.still ? 'the dragon' : clipCaption(p.clip, p.t);
  return h(Box, { flexDirection: 'column', marginTop: 1 },
    ...cells.map((row, k) => h(Text, { key: k, wrap: 'truncate' }, ...cellNodes(row, `d${k}-`))),
    h(Text, { color: c('dim') }, clip(caption, Math.max(10, cols - 2))));
}
