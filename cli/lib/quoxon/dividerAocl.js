/**
 * TUI-DIVIDER: the composer's bottom rule (`──────── anthropic claude-sonnet-5-5 ─`) as a live AOCL strip.
 *
 * Owner design (2026-10-17 22:09, after the first cut): a PIPELINE, like the dashboard command screen's
 * LayerStackMini. One compact chain of 11 dots, one per AOCL layer, each in its own layer colour, sits just left of
 * the model label: `────────•─•─●─●─◆─•─•─•─•─•─• anthropic claude-sonnet-5-5 ─`. On Enter the dots light left to
 * right as the real layer events arrive; when they reach the model, only the label animates (katakana shimmer).
 * Motion lives in one place at a time (the newest dot, or the label), never across the row. The finished state is
 * the label green (red on an error or a block, with the blocking dot marked) for ~1.6 s, then the normal rule.
 *
 * HONESTY: only REAL state moves this. A pip lights only when that layer's `aocl.layer` event arrives (or a
 * pre-stream refusal's `aocl_layers` record), in the colour of its real result. A bypassed layer (not evaluated
 * on this path) stays unlit, and so does every layer of a server that sends no `aocl.layer`. The "model is
 * working" phase starts on a real signal: the last pre-model layer (L4) reported, or the first model output.
 * Dots light one step apart for readability (STEP_MS), but never before their own event.
 *
 * Pure: `dividerStep` folds actions into state, `dividerFrame` draws one frame (or null = draw the normal rule).
 * Nothing here runs a timer; the app asks the clock for frames only while `dividerLive` says so.
 */
import stringWidth from 'string-width';
import { wordFrame, wordColor } from './indicator.js';
import { LAYER_NAMES } from './aocl.js';

export const ORDER = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10'];
const PRE_LAST = 'L4';
export const GREEN_MS = 1600;   // the label holds green this long after a completed reply (under the app's 2 s idle guarantee, motion-app.test)
export const RED_MS = 1600;     // and red this long after an error or a block (the error itself stays in the transcript)
export const MIN_COLS = 70;     // narrower than this: the plain rule, no animation
export const STEP_MS = 120;     // dots light at most one per step, left to right (never before their event)
export const CURRENT_MS = 700;  // the newest dot blinks this long after it lights; then it is just lit
export const TAG_MS = 1200;     // the newest layer's name shows beside the chain this long
export const LIT_RESULTS = new Set(['pass', 'gated', 'blocked']);

// Real model work only. `thinking` frames are mostly server staging (routing, processing, provider notes) sent
// before turn.started; only the model's own reasoning counts.
const MODEL_SIGNALS = new Set(['chunk', 'text.delta', 'tool.started']);
const isModelSignal = (ev) => MODEL_SIGNALS.has(ev.type) || (ev.type === 'thinking' && ev.stage === 'model_reasoning');

/** A fresh strip for a turn the user just sent. */
export const dividerStart = (turnId, now) => ({ turnId, startedAt: now, pips: {}, seen: {}, order: [], modelAt: null, phase: 'gates', endedAt: null, blockedAt: null });

function light(d, l, now) {
  const id = String(l?.id || '');
  if (!ORDER.includes(id) || d.pips[id]) return d; // unknown layer or already lit: nothing changes
  const result = String(l.result || '');
  if (!LIT_RESULTS.has(result)) { // bypass: a real event, but not evaluated: the pipeline steps over it, unlit
    return result === 'bypass' && !(d.seen || {})[id] ? { ...d, seen: { ...(d.seen || {}), [id]: { result, at: now } } } : d;
  }
  let n = { ...d, pips: { ...d.pips, [id]: { result, at: now } }, seen: { ...(d.seen || {}), [id]: { result, at: now } }, order: [...d.order, id] };
  if (result === 'blocked') n = { ...n, phase: 'error', blockedAt: id, endedAt: n.endedAt ?? now };
  return n;
}

/**
 * Fold one reducer action into the strip. `a` is the quoxon reducer action ({type:'turn.begin'} or
 * {type:'event', ev}); unknown actions return `d` unchanged (same object).
 */
export function dividerStep(d, a, now) {
  if (!a) return d;
  if (a.type === 'turn.begin') return dividerStart(a.turnId, now);
  if (a.type !== 'event' || !d || d.endedAt != null && a.ev?.type !== 'aocl.layer') return d;
  const ev = a.ev || {};
  if (ev.type === 'aocl.layer') {
    if (d.endedAt != null && d.phase !== 'error') return d; // a finished green strip never changes
    let n = light(d, ev, now);
    const pre = ev.phase === 'pre' || ORDER.indexOf(String(ev.id)) <= ORDER.indexOf(PRE_LAST);
    if (n.phase === 'gates' && (String(ev.id) === PRE_LAST || !pre)) n = { ...n, phase: 'model', modelAt: n.modelAt ?? now };
    return n;
  }
  if (isModelSignal(ev)) return d.phase === 'gates' ? { ...d, phase: 'model', modelAt: now } : d;
  if (ev.type === 'aocl.verdict' && ev.verdict === 'blocked') {
    const id = ORDER.includes(ev.layer) ? ev.layer : 'L8';
    return { ...d, phase: 'error', blockedAt: d.blockedAt || id, endedAt: d.endedAt ?? now };
  }
  if (ev.type === 'error') return { ...d, phase: 'error', endedAt: now };
  if (ev.type === 'turn.finished') {
    const ok = (ev.status || 'completed') === 'completed';
    return ok && d.phase !== 'error' ? { ...d, phase: 'done', endedAt: now } : { ...d, phase: 'error', endedAt: d.endedAt ?? now };
  }
  return d;
}

/** True while the strip needs frames: a turn in flight, or the green/red hold after it. */
export function dividerLive(d, now) {
  if (!d) return false;
  if (d.endedAt == null) return true;
  return now - d.endedAt < (d.phase === 'done' ? GREEN_MS : RED_MS);
}

// Each layer's own colour, from the dashboard (src/lib/aee/envelope.js AOCL_LAYERS, which LayerStackMini uses).
// L0 and L10 are grey there (#6b7280); the TUI has no grey text, so they take sky and violet.
export const LAYER_HEX = {
  L0: '#38bdf8', L1: '#3b82f6', L2: '#3b82f6', L3: '#f59e0b', L4: '#8b5cf6', L5: '#8b5cf6',
  L6: '#6366f1', L7: '#f97316', L8: '#14b8a6', L9: '#22c55e', L10: '#a855f7',
};
const hexRgb = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const DARK = [30, 36, 48];
export const layerRgb = (id) => hexRgb(LAYER_HEX[id]);
export const dimRgb = (id) => mixRgb(layerRgb(id), DARK, 0.6); // pending / bypassed: the layer's own hue, dimmed (not grey)

export const RGB = { done: [34, 197, 94], blocked: [239, 68, 68], model: [56, 189, 248] };
const LIT = { pass: '●', gated: '◆', blocked: '✖' };
const PENDING = '•';

/**
 * When each layer the server reported was reached in the pipeline: in layer order, one STEP_MS apart, never
 * before its own event. Bypassed layers are reached (the chain passes them) but stay unlit.
 */
export function layerReachTimes(d) {
  const out = {};
  if (!d) return out;
  let t = d.startedAt - STEP_MS;
  for (const id of ORDER) {
    const s = (d.seen || {})[id] || d.pips[id];
    if (!s) continue;
    t = Math.max(t + STEP_MS, s.at);
    out[id] = t;
  }
  return out;
}

/** When the pipeline hands over to the model (the label starts to shimmer): every pre-model layer seen was reached. */
export function modelReachedAt(d) {
  if (!d || d.modelAt == null) return null;
  const r = layerReachTimes(d);
  const pre = ORDER.slice(0, ORDER.indexOf(PRE_LAST) + 1).map(id => r[id]).filter(x => x != null);
  return Math.max(d.modelAt, ...pre, d.startedAt) + (pre.length ? STEP_MS : 0);
}

/** The chain of 11 dots joined by rule: cells [{ t, rgb, bold }]. Motion only on the newest dot. */
export function chainCells(d, now, { still = false } = {}) {
  const reach = layerReachTimes(d);
  const reached = ORDER.filter(id => reach[id] != null && reach[id] <= now);
  const newest = reached.filter(id => d.pips[id]).sort((a, b) => reach[b] - reach[a])[0] || null;
  const cells = [];
  ORDER.forEach((id, i) => {
    if (i) cells.push({ t: '─' });
    const p = d.pips[id];
    if (p && reach[id] <= now) {
      // only the newest dot blinks, only while the turn runs, and a blocked dot never dims (it stays red)
      const blinkOff = !still && d.endedAt == null && p.result !== 'blocked' && id === newest && now - reach[id] < CURRENT_MS && Math.floor((now - reach[id]) / 175) % 2 === 1;
      const rgb = p.result === 'blocked' ? RGB.blocked : layerRgb(id);
      cells.push({ t: LIT[p.result], rgb: blinkOff ? dimRgb(id) : rgb, bold: !blinkOff });
    } else cells.push({ t: PENDING, rgb: dimRgb(id) });
  });
  return { cells, newest, newestAt: newest ? reach[newest] : null };
}

/**
 * One frame of the rule: `{ cells: [{ t, rgb?, bold?, label? }] }` whose widths sum to exactly `cols`, or null
 * when the normal rule should draw (no strip, the hold is over, NO_COLOR, reduced motion, too narrow, no label).
 * Cells without `rgb` take the rule's own colour; `label: true` takes the label's own colour.
 * `still` (a slow redraw): no blink and no katakana, but every lit dot and the end colours stay.
 */
export function dividerFrame({ cols, label, d, now, mono = false, reduced = false, still = false, seed = 0 }) {
  if (mono || reduced || !d || cols < MIN_COLS || !label || !dividerLive(d, now)) return null;
  const lab = ` ${label} `;
  const lw = stringWidth(lab);
  const chain = chainCells(d, now, { still });
  const cw = chain.cells.length;
  const left = cols - lw - 1 - cw;
  if (left < 4) return null;
  // the newest lit layer names itself to the left of the chain, in its colour, while it is new
  const tag = chain.newest && now - chain.newestAt < TAG_MS ? ` ${chain.newest} ${LAYER_NAMES[chain.newest] || ''} ` : '';
  const fill = Math.max(1, left - (tag && tag.length + 1 <= left - 1 ? tag.length : 0));
  const leftCells = Array.from({ length: fill }, () => ({ t: '─' }));
  if (fill < left) {
    const rgb = d.pips[chain.newest].result === 'blocked' ? RGB.blocked : layerRgb(chain.newest);
    leftCells.splice(fill - 1, 0, ...[...tag].map(ch => ({ t: ch, rgb, bold: true })));
  }
  while (leftCells.length < left) leftCells.push({ t: '─' });
  let labelCells;
  if (d.phase === 'done') labelCells = [{ t: lab, rgb: RGB.done, bold: true }];
  else if (d.phase === 'error') labelCells = [{ t: lab, rgb: RGB.blocked, bold: true }];
  else {
    const at = modelReachedAt(d);
    if (at != null && now >= at) {
      if (still) labelCells = [{ t: lab, rgb: RGB.model, bold: true }];
      else {
        const fr = wordFrame(label, now, { since: at, seed });
        const n = fr.length;
        labelCells = [{ t: ' ' }, ...fr.map((c, i) => ({ t: c.ch, rgb: wordColor('working', i, n, now, c.flash ? 'flash' : c.glyph ? 'glyph' : 'letter') })), { t: ' ' }];
      }
    } else labelCells = [{ t: lab, label: true }];
  }
  return { cells: [...leftCells, ...chain.cells, ...labelCells, { t: '─' }] };
}

/** Plain text of a frame (tests and pty proofs). */
export const frameText = (f) => (f ? f.cells.map(c => c.t).join('') : null);
