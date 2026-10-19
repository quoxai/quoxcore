/**
 * TUI-DIVIDER: the composer's bottom rule drawn from a dividerAocl frame (pips, bullet, katakana label, green/red).
 * Draws ONE pre-coloured string per colour run (as the ring does), so a frame is a single row of exactly `cols`
 * cells and Ink tokenises a handful of escapes, not one per cell.
 */
import React from 'react';
import chalk from 'chalk';
import { Text } from 'ink';
import { dividerFrame } from './dividerAocl.js';

const h = React.createElement;
const RUN_Q = 8; // quantise shimmer colours so neighbouring cells share a run

/**
 * Per turn, a frame gap this long while the strip is live marks the redraw as slow: the strip then drops its motion
 * (no bullet, no katakana) for the rest of that turn but keeps every lit pip. `slow` is a ref object owned by the caller.
 */
export const SLOW_GAP_MS = 400;
export function noteFrameGap(slow, d, now) {
  if (!slow || !d) return false;
  if (slow.turnId !== d.turnId) { slow.turnId = d.turnId; slow.last = now; slow.slow = false; return false; }
  if (slow.last != null && now - slow.last > SLOW_GAP_MS && d.endedAt == null) slow.slow = true;
  slow.last = now;
  return slow.slow;
}

/** The frame as one string of chalk runs; `ruleColor`/`labelColor` are hex or undefined (theme roles resolved). */
export function paintFrame(f, { ruleColor, labelColor }) {
  let out = '', run = '', key = null, style = null;
  const paint = (s) => {
    if (!s) return '';
    let p = chalk;
    if (style.rgb) p = p.rgb(...style.rgb);
    else if (style.hex) p = p.hex(style.hex);
    if (style.bold) p = p.bold;
    return p(s);
  };
  const flush = () => { if (run) out += paint(run); run = ''; };
  for (const c of f.cells) {
    const rgb = c.rgb ? c.rgb.map(v => Math.max(0, Math.min(255, Math.round(v / RUN_Q) * RUN_Q))) : null;
    const st = { rgb, hex: rgb ? null : (c.label ? labelColor : ruleColor) || null, bold: Boolean(c.bold) };
    const k = `${rgb ? rgb.join(',') : st.hex}|${st.bold}`;
    if (k !== key) { flush(); key = k; style = st; }
    run += c.t;
  }
  flush();
  return out;
}

/** The bottom rule as a strip element, or null when the caller should draw its normal Rule (a plain call, not a component). */
export function dividerRuleEl({ cols, label, divider, now, ruleColor, labelColor, mono = false, reduced = false, slow = null }) {
  if (!divider) return null;
  const isSlow = noteFrameGap(slow, divider, now);
  const f = dividerFrame({ cols, label, d: divider, now, mono, reduced, still: isSlow }); // slow: keep the lit pips, drop the motion
  if (!f) return null;
  return h(Text, { wrap: 'truncate-end' }, paintFrame(f, { ruleColor, labelColor }));
}
