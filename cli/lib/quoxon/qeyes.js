// Quox eyes (canonical source: quox cli/lib/quoxon/qeyes.js; the cli.quox.ai site vendors this file as is).
// Two friendly cartoon eyes in the Q's own terminal cell pipeline, so the web (cellsToHTML) and the
// terminal (cellsToAnsi) draw identical eyes. Two techniques, both terminal-safe:
//   dots    Braille dots (the Q's own particles): a closed disc of white dots, a pupil of UNLIT dots (the
//           background shows through, so it reads black), a 2x2 dot glint, and a 2-dot arc when closed.
//   blocks  Unicode quadrant blocks with a foreground AND a background colour (as qdragon's eye layer).
// Plus motion as pure functions of time: blink, look around, idle (eyeState).
//
// PURE AND PORTABLE: no DOM, no timers, no Node APIs. A function of (geometry, state) or (mode, t).
// The left eye is computed once and the right eye is the same eye TRANSLATED (both centres snapped to even
// dots, so both sit on the same Braille cell phase): the two always match, and both pupils look the same way.
// Compositing is per cell: a cell inside an eye's footprint is drawn from the eye layer only, so a Q dot never
// shares a cell (and its one colour) with an eye. The Q itself is never redrawn.
//
// Geometry is the Q's own unit space (qart.js): y 0..1 down the Q, x 0..0.82, the bowl's axis at x 0.41.

const AXIS = 0.41;
const BR = [[0x1, 0x8], [0x2, 0x10], [0x4, 0x20], [0x40, 0x80]];
const QUAD = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'];
export const EYE_WHITE = [255, 255, 255]; // pure white (owner: whiter whites)
export const EYE_PUPIL = [10, 12, 18];
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = (e) => { e = clamp(e); return e * e * (3 - 2 * e); };

/**
 * The owner's pick ("big and googly"). r, sep, y in Q units. pupil: pupil radius as a share of r. rest: where the
 * pupils rest (gaze -1..1; a little down reads as "looking at you"). rim: the least white (dots) kept round the
 * pupil at every gaze. glint: the 2x2 glint's offset from the pupil centre, as a share of the pupil radius (out
 * towards the upper left, near the pupil's edge, so it reads as a highlight and not a bullseye). sag: closed lid.
 */
export const GOOGLY = { r: 0.104, sep: 0.124, y: 0.53, ox: 0.95, oy: 1.02, pupil: 0.46, rest: [0, 1], rim: 2, glint: 0.62, sag: 0.34 };
/** Variant A of the bullseye fix (rejected by screenshot: the thinner rim still read as a donut). */
export const GOOGLY_A = { ...GOOGLY, pupil: 0.52 };
/** The v2 dots (before the bullseye fix): smaller pupil, glint near its centre. Kept for comparison. */
export const GOOGLY_V2 = { ...GOOGLY, pupil: 0.43, glint: 0.45, rest: [0, 0.6] };

function centres(geo, v) {
  const R = v.r * geo.Hq, axis = 2 * Math.round((geo.ox + AXIS * geo.Hq) / 2), cy = (geo.oy ?? 0) + v.y * geo.Hq;
  const cxL = axis - 2 * Math.ceil((v.sep * geo.Hq) / 2);
  return { R, cy, cxL, shift: 2 * (axis - cxL) }; // right eye = left eye + shift (an even number of dots)
}

/** The left eye in dot units: f(x, y) -> 0 none | 1 white | 2 pupil | 3 glint, for an open eye. */
function eyeShape(cx, cy, R, v, open, gx, gy) {
  const rx = R * v.ox, ry = R * v.oy, pr = R * v.pupil;
  const lidY = cy - ry + (1 - open) * 2 * ry * 0.92; // the upper lid: everything above it is closed
  // the pupil travels inside the white, shrunk by its radius plus the rim, and snaps to whole dots
  const ax = Math.max(0, rx - pr - v.rim), ay = Math.max(0, ry - pr - v.rim), n = Math.hypot(gx, gy), s = n > 1 ? 1 / n : 1;
  const px = cx + Math.trunc(gx * s * ax), py = cy + Math.trunc(gy * s * ay); // truncate: never into the rim
  const glint = pr >= 2.6, g = pr * v.glint * 0.75, gx0 = Math.round(px - g), gy0 = Math.round(py - g); // up-left, a dark dot clear of the rim
  return (x, y) => {
    if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1 || y < lidY) return 0;
    if (y < lidY + 2) return 1; // the lid's edge: a 2-dot white line
    if (Math.hypot(x - px, y - py) > pr) return 1;
    if (glint && Math.floor(x) >= gx0 && Math.floor(x) <= gx0 + 1 && Math.floor(y) >= gy0 && Math.floor(y) <= gy0 + 1) return 3;
    return 2;
  };
}
/** The closed lid's centre line y(x) (an arc bowed upwards, like a shut lid; owner flipped it from a smile) and its half-width, in dot units. */
function lid(cx, cy, R, v) {
  const w = R * v.ox * 0.88, d = R >= 6 ? R * v.sag : 0.6, y0 = cy - d / 2;
  return { n: Math.round(w), y: (x) => { const u = (x - cx) / w; return y0 + d * u * u; } };
}

/** Footprint: the cells each eye owns (its white ellipse plus a little margin), as a Uint8Array cols*rows. */
function footprint(geo, v) {
  const { R, cy, cxL, shift } = centres(geo, v), foot = new Uint8Array(geo.cols * geo.rows);
  for (const cx of [cxL, cxL + shift]) for (let r = 0; r < geo.rows; r++) for (let c = 0; c < geo.cols; c++) {
    const x = c * 2 + 1, y = r * 4 + 2;
    if (((x - cx) / (R * v.ox + 0.4)) ** 2 + ((y - cy) / (R * v.oy + 0.4)) ** 2 <= 1) foot[r * geo.cols + c] = 1;
  }
  return foot;
}
const gaze = (state, v) => [state.gx ?? v.rest[0], state.gy ?? v.rest[1]];

// ---- dots ---------------------------------------------------------------------------------------------------
/** Lit dots of both eyes on the W x H dot grid (Uint8Array, 1 = lit). state: { open 0..1, gx, gy -1..1 }. */
export function eyeDots(geo, state = {}, v = GOOGLY) {
  const W = geo.cols * 2, H = geo.rows * 4, lit = new Uint8Array(W * H);
  const { R, cy, cxL, shift } = centres(geo, v), open = clamp(state.open ?? 1);
  const set = (x, y) => { for (const xx of [x, x + shift]) if (xx >= 0 && y >= 0 && xx < W && y < H) lit[y * W + xx] = 1; };
  if (open < 0.15) {
    const L = lid(cxL, cy, R, v); // one clean arc, 2 dots thick, symmetric about the eye centre
    for (let x = cxL - L.n; x < cxL + L.n; x++) { const y = Math.round(L.y(x + 0.5) - 0.5); set(x, y); set(x, y + 1); }
    return lit;
  }
  const [gx, gy] = gaze(state, v), f = eyeShape(cxL, cy, R, v, open, gx, gy);
  for (let y = Math.floor(cy - R * 2); y <= Math.ceil(cy + R * 2); y++) for (let x = Math.floor(cxL - R * 2); x <= Math.ceil(cxL + R * 2); x++) {
    const k = f(x + 0.5, y + 0.5);
    if (k === 1 || k === 3) set(x, y);
  }
  return lit;
}

/** The dot eye layer: rows of cells (null = no eye here). */
export function eyeCells(geo, state, v = GOOGLY) {
  const W = geo.cols * 2, lit = eyeDots(geo, state, v), foot = footprint(geo, v), rows = [];
  for (let r = 0; r < geo.rows; r++) {
    const row = [];
    for (let c = 0; c < geo.cols; c++) {
      let bits = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) if (lit[(r * 4 + dy) * W + c * 2 + dx]) bits |= BR[dy][dx];
      row.push(bits ? { ch: String.fromCharCode(0x2800 + bits), rgb: EYE_WHITE } : foot[r * geo.cols + c] ? { ch: ' ', rgb: null } : null);
    }
    rows.push(row);
  }
  return rows;
}

// ---- blocks (reference) -------------------------------------------------------------------------------------
/** The block eye layer: 2x2 quadrant pixels per cell (a pixel is 1 dot wide, 2 tall), fg + bg colours. */
export function blockEyeCells(geo, state = {}, v = GOOGLY) {
  const PW = geo.cols * 2, PH = geo.rows * 2, px = new Uint8Array(PW * PH); // 0 none, 1 white, 2 pupil
  const { R, cy, cxL, shift } = centres(geo, v), open = clamp(state.open ?? 1);
  const put = (x, y, k) => { for (const xx of [x, x + shift]) if (xx >= 0 && y >= 0 && xx < PW && y < PH) px[y * PW + xx] = k; };
  if (open < 0.15) {
    const L = lid(cxL, cy, R, v);
    for (let x = cxL - L.n; x < cxL + L.n; x++) put(x, Math.floor(L.y(x + 0.5) / 2), 1);
  } else {
    const [gx, gy] = gaze(state, v), f = eyeShape(cxL, cy, R, { ...v, pupil: 0.43 }, open, gx, gy), small = R < 6;
    for (let y = Math.floor((cy - R * 2) / 2); y <= Math.ceil((cy + R * 2) / 2); y++) for (let x = Math.floor(cxL - R * 2); x <= Math.ceil(cxL + R * 2); x++) {
      const k = f(x + 0.5, y * 2 + 1);
      if (k) put(x, y, k === 3 ? 1 : k === 2 && small ? 1 : k);
    }
    if (small) { const pr0 = Math.round(cy / 2); for (const x of [cxL - 1, cxL]) for (const y of [pr0 - 1, pr0]) put(x, y, 2); }
  }
  const foot = footprint(geo, v), rows = [];
  for (let r = 0; r < geo.rows; r++) {
    const row = [];
    for (let c = 0; c < geo.cols; c++) {
      const q = [px[(r * 2) * PW + c * 2], px[(r * 2) * PW + c * 2 + 1], px[(r * 2 + 1) * PW + c * 2], px[(r * 2 + 1) * PW + c * 2 + 1]];
      if (!q.some((k) => k)) { row.push(foot[r * geo.cols + c] ? { ch: ' ', rgb: null } : null); continue; }
      let m = 0; q.forEach((k, i) => { if (k === 1) m |= 1 << i; });
      if (q.includes(1)) row.push({ ch: QUAD[m], rgb: EYE_WHITE, bg: q.includes(2) ? EYE_PUPIL : null });
      else row.push({ ch: '█', rgb: EYE_PUPIL });
    }
    rows.push(row);
  }
  return rows;
}

// ---- motion: pure functions of time ---------------------------------------------------------------------------
export const BLINK_MS = 200;
/** Lid openness u ms into a blink: shut in 70 ms, held 40, open again by 200. */
export function blinkOpen(u) {
  if (u < 0 || u >= BLINK_MS) return 1;
  if (u < 70) return 1 - smooth(u / 70);
  if (u < 110) return 0;
  return smooth((u - 110) / 90);
}
const hash = (n) => { let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };
// keyframes [[ms, [gx, gy]], ...], eased between neighbours, held at the ends
function gazeKf(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, a] = keys[i], [t1, b] = keys[i + 1];
    if (t < t1) { const e = smooth((t - t0) / (t1 - t0)); return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e]; }
  }
  return keys[keys.length - 1][1];
}
const REST = GOOGLY.rest;
/** Look around: centre, left, right, up, down, centre; 260 ms moves, 600 ms holds. */
export const LOOK_KEYS = (() => {
  const pts = [REST, [-1, 0.2], [1, 0.2], [0, -1], [0, 1], REST], keys = [];
  let t = 0;
  for (const p of pts) { keys.push([t, p]); t += 600; keys.push([t, p]); t += 260; }
  return keys;
})();
export const LOOK_MS = LOOK_KEYS[LOOK_KEYS.length - 1][0] + 400;

/**
 * The eyes' state at t ms for a mode: 'open' | 'closed' | 'blink' | 'look' | 'idle'. Returns { open, gx, gy }.
 *   blink  a blink every 1.6 s; every third one is a double blink.
 *   look   the look-around loop (LOOK_KEYS).
 *   idle   blinks every 2.6 to 5 s (one in five a double), and now and then a glance that holds and returns.
 */
export function eyeState(mode, t) {
  if (mode === 'closed') return { open: 0, gx: REST[0], gy: REST[1] };
  if (mode === 'open' || t < 0) return { open: 1, gx: REST[0], gy: REST[1] };
  if (mode === 'blink') {
    const k = Math.floor(t / 1600), u = t - k * 1600;
    return { open: Math.min(blinkOpen(u - 300), k % 3 === 2 ? blinkOpen(u - 560) : 1), gx: REST[0], gy: REST[1] };
  }
  if (mode === 'look') { const [gx, gy] = gazeKf(t % LOOK_MS, LOOK_KEYS); return { open: 1, gx, gy }; }
  // idle: a seeded schedule of events, each 2.6 to 5 s long, so any t maps to the same frame
  let start = 0, i = 0;
  for (;;) { const len = 2600 + hash(i * 7 + 1) * 2400; if (t < start + len) break; start += len; i++; if (i > 100000) break; }
  const u = t - start, len = 2600 + hash(i * 7 + 1) * 2400;
  let open = 1, g = REST;
  if (hash(i * 7 + 2) < 0.4) {
    // a glance: move in 240 ms, hold, come back before the event ends
    const dir = [[-1, 0.2], [1, 0.2], [-0.8, -0.7], [0.8, -0.7], [0, 1]][Math.floor(hash(i * 7 + 3) * 5)];
    g = gazeKf(u, [[300, REST], [540, dir], [540 + 900, dir], [540 + 900 + 260, REST]]);
  }
  const b = len - 700; // the blink near the end of each event
  open = Math.min(blinkOpen(u - b), hash(i * 7 + 4) < 0.2 ? blinkOpen(u - b - 260) : 1);
  return { open, gx: g[0], gy: g[1] };
}

// ---- compose ------------------------------------------------------------------------------------------------
/** Composite: eye cells over base cells (same grid). Base cells are untouched wherever the eye layer is null. */
export function overlay(base, eyes) {
  return base.map((row, r) => row.map((cell, c) => (eyes[r] && eyes[r][c]) || cell));
}
const layer = (style) => (style === 'blocks' ? blockEyeCells : eyeCells);
/** Eyes for the settled qart Q, given its mask ({ W, H, ox } from qMask). style: 'dots' | 'blocks'. */
export function eyesForQ(mask, state, v = GOOGLY, style = 'dots') {
  return layer(style)({ cols: mask.W / 2, rows: mask.H / 4, ox: mask.ox, Hq: mask.H }, state, v);
}
/** Eyes for a qdragon layout ({ cols, rows, qx0, qy0, H }). */
export function eyesForDragon(L, state, v = GOOGLY, style = 'dots') {
  return layer(style)({ cols: L.cols, rows: L.rows, ox: L.qx0, oy: L.qy0, Hq: L.H }, state, v);
}
