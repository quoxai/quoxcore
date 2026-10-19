/**
 * Ink face of the step-up PIN card and the "human present" bar. All text comes from cardLines() (pure,
 * counts only, never a digit); this file only paints roles. Roles: gold frame/title/filled dots/countdown,
 * prose for ink, ok green, error red. Never grey.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { c, mono } from '../theme.js';
import { cardLines, mmss, ANIM_MIN_COLS } from './stepUp.js';

const h = React.createElement;

/** Animate only on a roomy, coloured terminal that is keeping up. */
export const animationOn = (cols, slow = false) => cols >= ANIM_MIN_COLS && !slow && !mono() && process.env.TERM !== 'dumb';
const FRAME_MS = 90;

export function StepUpCard({ view, cols }) {
  const [tick, setTick] = React.useState(0);
  const [pulse, setPulse] = React.useState(-1);
  const [slow, setSlow] = React.useState(false);
  const on = animationOn(cols, slow);
  const phase = view?.phase;
  // verifying shimmer + sweep: one timer, only while verifying. A tick that lands far late means the terminal
  // cannot keep up, so the card goes still for good rather than stutter.
  React.useEffect(() => {
    if (!on || phase !== 'verifying') return undefined;
    let last = Date.now();
    const t = setInterval(() => {
      const n = Date.now(); if (n - last > FRAME_MS * 4) setSlow(true);
      last = n; setTick((x) => x + 1);
    }, FRAME_MS);
    return () => clearInterval(t);
  }, [on, phase === 'verifying']);
  // per-digit pulse: flash the slot just filled for ~150 ms. Reads only the COUNT of digits, never a digit.
  const filled = view?.filled || 0; const prev = React.useRef(0);
  React.useEffect(() => {
    const was = prev.current; prev.current = filled;
    if (!on || filled <= was || phase !== 'input') { setPulse(-1); return undefined; }
    setPulse(filled - 1);
    const t = setTimeout(() => setPulse(-1), 150);
    return () => clearTimeout(t);
  }, [filled, on]);
  const lines = cardLines(on ? { ...view, pulse, tick: phase === 'verifying' ? tick : null } : view, cols);
  return h(Box, { flexDirection: 'column', width: cols, marginBottom: 1 }, // QUOXON-1191b: the spacer Box above supplies the one blank row above; this adds the one below
    ...lines.map((segs, i) => h(Text, { key: i, wrap: 'truncate-end' },
      ...segs.map((s, j) => h(Text, { key: j, color: c(s.role === 'prose' ? 'text' : s.role), bold: (s.role === 'gold' && j === 0 && i === 0) || s.role === 'key' || (s.role === 'ok' && s.text.startsWith('✔ AUTH')) }, s.text)))));
}

/** One gold line above the status bar while the /authenticate window is live; ticks once a second. */
export function PresentBar({ stepUp, cols }) {
  const [, tick] = React.useReducer((n) => n + 1, 0);
  const left = stepUp.presentMs();
  React.useEffect(() => {
    if (!left) return undefined;
    const t = setInterval(() => tick(), 1000);
    return () => clearInterval(t);
  }, [left > 0]);
  if (!left) return null;
  return h(Box, { width: cols }, h(Text, { wrap: 'truncate-end' }, ' ', h(Text, { color: c('gold'), bold: true }, '◉ human present '), h(Text, { color: c('gold') }, mmss(left)), h(Text, { color: c('text') }, ' · /authenticate renews')));
}
