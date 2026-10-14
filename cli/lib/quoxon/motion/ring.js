/**
 * Composer ring (owner-approved lab prototype `quox-intro-lab rules`, plus the green writing sweep from
 * `quox-intro-lab fx`). The two composer rules are one light ring: top rule left to right is the first half
 * of the perimeter, bottom rule right to left the second. The gradient is the quox.ai panel ring:
 * conic(cyan .85, purple .8 @35%, transparent @60%, teal .55 @85%, cyan .85). ~1 revolution / 2.5 s.
 * Modes: work (cyan/purple), write (greens, while answer text streams), wait (slower amber, approval held).
 * When the turn ends the sweep eases to a stop over ~400 ms. Pure state stepping; no timers here.
 */
import { mix, smooth, hexRgb } from './color.js';

export const PALS = {
  work: [[0x38, 0xbd, 0xf8], [0xa8, 0x55, 0xf7], [0x06, 0xb6, 0xd4]],
  write: [[0x22, 0xc5, 0x5e], [0x4a, 0xde, 0x80], [0x16, 0xa3, 0x4a]],
  wait: [[0xf5, 0x9e, 0x0b], [0xea, 0x58, 0x0c], [0xb4, 0x53, 0x09]],
};
const STOPS = [[0, 0, 0.85], [0.35, 1, 0.8], [0.6, 0, 0], [0.85, 2, 0.55], [1, 0, 0.85]];
export const DIM = [58, 66, 82];
export const OMEGA = 360 / 2.5;             // deg/s while working
export const SPEED = { work: 1, write: 1, wait: 0.3 };
export const SETTLE_S = 0.4, RAMP_S = 0.15, BLEND_S = 0.2;

export const initialRing = () => ({ phase: 'idle', angle: 0, k: 0, om: 0, wt: { work: 1, write: 0, wait: 0 }, at: null, settleAt: null, from: null });

/** Colour + alpha of the ring at perimeter position u in [0,1) for palette weights wt. */
export function ringAt(u, wt) {
  let i = 0; while (i < STOPS.length - 2 && u > STOPS[i + 1][0]) i++;
  const [p0, c0, a0] = STOPS[i], [p1, c1, a1] = STOPS[i + 1];
  const t = (u - p0) / (p1 - p0 || 1);
  const col = (c) => [0, 1, 2].map((ch) => wt.work * PALS.work[c][ch] + wt.write * PALS.write[c][ch] + wt.wait * PALS.wait[c][ch]);
  const A = a0 + (a1 - a0) * t;
  const pm = mix(col(c0).map((v) => v * a0), col(c1).map((v) => v * a1), t); // premultiplied: the clear stop does not tint
  return [A ? pm.map((v) => v / A) : col(c0), A];
}

/**
 * Advance the ring to time `now` (ms). active = a turn is running; mode = 'work' | 'write' | 'wait'.
 * Returns a new state; `animating` tells the clock whether frames are still wanted.
 */
export function ringStep(prev, { active, mode = 'work', now }) {
  const s = { ...(prev || initialRing()), wt: { ...(prev || initialRing()).wt } };
  const dt = s.at == null ? 0 : Math.max(0, Math.min(0.25, (now - s.at) / 1000));
  s.at = now;
  if (active) {
    if (s.phase !== 'run') s.phase = 'run';
    s.om = OMEGA * (SPEED[mode] ?? 1);
    s.k = Math.min(1, s.k + dt / RAMP_S);
    for (const m of Object.keys(s.wt)) s.wt[m] += ((m === mode ? 1 : 0) - s.wt[m]) * Math.min(1, dt / BLEND_S);
  } else if (s.phase === 'run') {
    s.phase = 'settle'; s.settleAt = now; s.from = { om: s.om, k: s.k };
  }
  if (s.phase === 'settle') {
    const p = (now - s.settleAt) / 1000 / SETTLE_S;
    if (p >= 1) { s.phase = 'idle'; s.k = 0; s.om = 0; } else { s.om = s.from.om * (1 - p) ** 2; s.k = s.from.k * (1 - smooth(p)); }
  }
  s.angle = (s.angle + s.om * dt) % 360;
  return s;
}
export const ringAnimating = (s) => Boolean(s) && s.phase !== 'idle';

/** Per-cell rgb for one rule of `cols` cells. base = the rule's static colour (hex or rgb). Pure. */
export function ruleColors(cols, top, s, base) {
  const b = Array.isArray(base) ? base : hexRgb(base);
  const out = new Array(cols);
  for (let x = 0; x < cols; x++) {
    if (!s || s.k <= 0) { out[x] = b; continue; }
    const pos = top ? (x + 0.5) / (2 * cols) : (cols + (cols - 1 - x) + 0.5) / (2 * cols);
    const u = (((pos - s.angle / 360) % 1) + 1) % 1;
    const [c, a] = ringAt(u, s.wt);
    out[x] = mix(b, mix(DIM, c, a), s.k);
  }
  return out;
}

/** Which ring mode a live turn is in, from what the client actually knows. */
export function ringMode({ approvals = 0, act = null } = {}) {
  if (approvals > 0 || act?.tone === 'wait') return 'wait';
  if (act?.word === 'Writing') return 'write';
  return 'work';
}
