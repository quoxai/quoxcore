/**
 * The Quox dragon: the horned Q brought alive (eyes, tail, fire). Ported from the lab (~/quoxon-work/intro/lab/dragon-core.mjs), tuned there with the owner (CLI-QUOX F3).
 *
 * PURE AND PORTABLE: no process, no timers, no Node or DOM APIs. Everything is a function of
 * (layout, pose, time, seed). A scene maps t (ms) to a pose; renderDragon(pose, layout) maps a pose to rows
 * of cells { ch, rgb, bg } (rgb/bg null = terminal default). The terminal (qart.cellsToAnsi, qmotion.cellNodes)
 * and the web face (web/qface.js) draw these same cells; both understand the bg colour.
 *
 * ONE dragon (v8): a Braille field with the body (bowl ring + horns, from qart.js's vector silhouette), dim bat
 * wings, a spade-tailed spine, the smile and pink cheeks, and the fire (with its embers and smoke) from the mouth.
 * 2x4 dots per cell, one colour per cell. The eyes are NOT drawn here: the googly dot eyes (qeyes.js) are laid over
 * the cells by qdragonScenes.js composeCells, so every scene, mood, greeting and the flight share one face.
 */

export const PAL = {
  SKY: [56, 189, 248], INDIGO: [99, 102, 241], VIOLET: [168, 85, 247], TEAL: [6, 182, 212],
  AMBER: [245, 158, 11], ORANGE: [251, 146, 60], RED: [239, 68, 68], CORE: [255, 250, 235],
  SMOKE: [120, 126, 138],
};
const { SKY, VIOLET, AMBER, ORANGE, RED, CORE, SMOKE } = PAL;

/**
 * Themes. dark: the default (terminal background is dark). light: for light terminal backgrounds; the body
 * gradient is deepened, smoke darkens, and the fire keeps its saturation (no white-hot core, which would vanish on a light background).
 */
export const THEMES = {
  dark: {
    name: 'dark', bg: [12, 15, 21], light: false, body0: SKY, body1: VIOLET,
    smoke0: [150, 156, 168], smoke1: [72, 78, 90], smoke: SMOKE, label: (c) => c,
  },
  light: {
    name: 'light', bg: [248, 250, 252], light: true, body0: [3, 116, 178], body1: [109, 40, 217],
    smoke0: [96, 104, 118], smoke1: [196, 201, 210], smoke: [110, 116, 128],
    label: (c) => c.map((v) => Math.round(v * 0.62)),
  },
};
let TH = THEMES.dark; // set per renderDragon call (synchronous, so this stays pure per frame)

const TAU = Math.PI * 2;
const ASPECT = 0.82;
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const smooth = (e) => { e = clamp(e); return e * e * (3 - 2 * e); };
const mix = (A, B, t) => A.map((v, i) => v + (B[i] - v) * t);
export function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const hash = (n) => { let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };
/** Keyframes: [[ms, value], ...], eased (smoothstep) between neighbours, held outside. */
export function kf(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
    if (t < t1) return t1 === t0 ? v1 : v0 + (v1 - v0) * smooth((t - t0) / (t1 - t0));
  }
  return keys[keys.length - 1][1];
}
const win = (t, a, b) => t >= a && t < b;

/** Fire colour by heat 0..1: dark red, red, orange, amber, pale gold, hot white core. */
const FIRE_DARK = [[0, [70, 16, 16]], [0.22, RED], [0.45, ORANGE], [0.66, AMBER], [0.84, [253, 224, 140]], [1, CORE]];
const FIRE_LIGHT = [[0, [127, 29, 29]], [0.25, [220, 38, 38]], [0.5, [234, 88, 12]], [0.75, [245, 140, 11]], [1, [251, 191, 36]]];
export function fireRGB(h) {
  const S = TH.light ? FIRE_LIGHT : FIRE_DARK;
  h = clamp(h);
  for (let i = 0; i < S.length - 1; i++) if (h <= S[i + 1][0]) return mix(S[i][1], S[i + 1][1], (h - S[i][0]) / (S[i + 1][0] - S[i][0]));
  return S[S.length - 1][1];
}

// ---- geometry (unit space: y 0..1 down the Q, x 0..ASPECT; the same silhouette as qart.js) ----------------
const BOWL = { cx: ASPECT / 2, cy: 0.6, rx: 0.4, ry: 0.385, w: 0.118 };
const bez = (a, b, c, t) => [(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * b[0] + t * t * c[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * b[1] + t * t * c[1]];
const HORNS = [
  { a: [0.2, 0.29], b: [-0.02, 0.27], c: [0.02, 0.03], r0: 0.048 },
  { a: [0.62, 0.29], b: [0.84, 0.27], c: [0.8, 0.0], r0: 0.048 },
];
const HORN_PTS = HORNS.map((hn) => Array.from({ length: 24 }, (_, i) => ({ p: bez(hn.a, hn.b, hn.c, i / 23), t: i / 23, r0: hn.r0 })));
const TAIL0 = { a: [0.4, 0.69], b: [0.79, 0.985], r0: 0.07, r1: 0.04 };
const TAIL_LEN0 = Math.hypot(TAIL0.b[0] - TAIL0.a[0], TAIL0.b[1] - TAIL0.a[1]);
const TAIL_ANG0 = Math.atan2(TAIL0.b[1] - TAIL0.a[1], TAIL0.b[0] - TAIL0.a[0]);
const TAIL_FIXED = 0.5 * TAIL_LEN0; // the stroke inside the bowl and through the ring never bends
// The mouth is a jaw notch at the bowl's lower right, just above where the tail leaves the ring: the bowl is the
// upper jaw and the tail stroke the lower one, so the fire comes out of the Q's own stroke rather than a hole in
// the side of its head. A small notch is always there (the mouth corner); it opens wide to breathe.
const MOUTH_ANG = 0.52; // radians below the bowl's right-hand horizontal (normalised ellipse angle)
const NOTCH = 0.07;     // the resting notch half-width (radians)

function bodyAt(x, y) {
  const dx = (x - BOWL.cx) / BOWL.rx, dy = (y - BOWL.cy) / BOWL.ry, e = Math.hypot(dx, dy);
  const inner = 1 - BOWL.w / ((BOWL.rx + BOWL.ry) / 2);
  if (e <= 1 && e >= inner) return { part: 'bowl', t: 0, ang: Math.atan2(dy, dx) };
  if (y > 0.34) return null;
  for (const pts of HORN_PTS) for (const q of pts) if (Math.hypot(x - q.p[0], y - q.p[1]) <= q.r0 * (1 - q.t * 0.93) + 0.004) return { part: 'horn', t: q.t, ang: 0 };
  return null;
}

export const DSIZES = { large: 72, mid: 44, small: 24 }; // small = qart's compact Q (under 60 cols), for the intro hand-over
/**
 * Layout for a frame `cols` wide. large (18-row Q) from 64 cols, mid (11 rows) below. The Q sits at the left;
 * everything to its right is room for fire and labels; rows below hold the tail.
 */
export function dragonLayout(cols, { size, lm, ty = 0, rows: fixedRows } = {}) {
  size ??= cols >= 64 ? 'large' : 'mid';
  const H = DSIZES[size], qw = Math.round(H * ASPECT);
  lm ??= cols >= 64 ? 2 : 1; // left margin in cells (0 lines the dragon up with qart's Q, for the intro hand-over)
  const rows = fixedRows ?? Math.ceil((ty + H * 1.34) / 4); // ty: dots of room above the Q (the flight's raised wings and its bob)
  const L = { size, H, cols, rows, Wd: cols * 2, Hd: rows * 4, qx0: lm * 2, qy0: ty, qw, qCols: Math.ceil((lm * 2 + qw) / 2) };
  L.X = (x) => L.qx0 + x * H;
  L.Y = (y) => L.qy0 + y * H;
  L.grad = (xd) => mix(TH.body0, TH.body1, clamp((xd - L.qx0) / qw));
  L.mouth = [L.X(BOWL.cx + BOWL.rx * Math.cos(MOUTH_ANG) * 0.97), L.Y(BOWL.cy + BOWL.ry * Math.sin(MOUTH_ANG) * 0.97)];
  L.mouthL = [L.X(BOWL.cx - BOWL.rx * Math.cos(MOUTH_ANG) * 0.97), L.mouth[1]]; // the mirrored mouth (pose.mouthSide 'left')
  // large eyes are a tall oval (8 quadrant rows) so the iris can move up and down with a row of white to spare
  return L;
}

const bodyCache = new Map();
function bodyDots(L) {
  const key = `${L.size}:${L.qx0}:${L.qy0}`;
  if (bodyCache.has(key)) return bodyCache.get(key);
  const dots = [];
  for (let y = 0; y < L.H; y++) for (let x = 0; x < L.qw + 2; x++) {
    let n = 0;
    for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) if (bodyAt((x + sx) / L.H, (y + sy) / L.H)) n++;
    if (n >= 2) { const p = bodyAt((x + 0.5) / L.H, (y + 0.5) / L.H) || { part: 'bowl', t: 0, ang: 0 }; dots.push({ x: x + L.qx0, y: y + L.qy0, ...p }); }
  }
  bodyCache.set(key, dots);
  return dots;
}

// ---- poses -------------------------------------------------------------------------------------------------
/** The settled dragon: tail at rest, no fire (the eyes are the dot layer, see qdragonScenes.js). Also the static (reduced motion) form. */
export function restPose() {
  return {
    tail: { len: 1.32, bend: -0.6, amp: 0, phase: 0, k: 2.4, curl: 0, wrap: 0, spade: 1 },
    glow: 1, tint: null, tintAmt: 0, mouth: 0, mouthSide: 'right', // 'left' = screen left: the face and the fire mirror
    fire: null, label: null,
  };
}
// ---- drawing -----------------------------------------------------------------------------------------------
function makeField(W, H) {
  const v = new Float32Array(W * H), c = new Float32Array(W * H * 3);
  return {
    W, H, v, c,
    set(x, y, val, rgb) {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = y * W + x;
      if (val > v[i]) { v[i] = val; c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2]; }
    },
  };
}

function drawBody(F, p, L) {
  for (const d of bodyDots(L)) {
    let rgb = L.grad(d.x);
    if (p.tint && p.tintAmt) rgb = mix(rgb, p.tint, p.tintAmt);
    F.set(d.x, d.y, p.glow, rgb);
  }
}

/** The tail spine: fixed through the ring, then bent by sway (a travelling wave), curl (tip spiral) and wrap. */
export function tailSpine(tp, L) {
  const len = (tp.len + 0.85 * tp.wrap) * TAIL_LEN0, step = 0.5 / L.H, pts = [];
  let x = TAIL0.a[0], y = TAIL0.a[1], th = TAIL_ANG0;
  // wrap: a heading offset (not extra curvature, which spirals into a loop). The tail turns once, runs back to
  // the left under the bowl, and the tip hooks up again: a sweep under the Q and back.
  const wrapOff = (f) => tp.wrap * (2.6 * smooth((f - 0.2) / 0.34) + 0.95 * smooth((f - 0.78) / 0.22));
  for (let s = 0; s <= len; s += step) {
    const f = s > TAIL_FIXED ? (s - TAIL_FIXED) / (len - TAIL_FIXED) : 0, h = th + (tp.wrap ? wrapOff(f) : 0);
    pts.push({ x, y, th: h, s, r: Math.max(0.017, TAIL0.r0 - ((TAIL0.r0 - TAIL0.r1) * s) / TAIL_LEN0) });
    if (s > TAIL_FIXED) {
      let k = tp.bend * 2 * f * (1 - tp.wrap) + tp.amp * Math.sin(tp.phase - tp.k * f) * (0.35 + f) * (1 - 0.6 * tp.wrap);
      k -= tp.curl * 26 * smooth((f - 0.45) / 0.45);
      th += k * step;
    }
    x += Math.cos(h) * step; y += Math.sin(h) * step;
  }
  return pts;
}

// v2: how much of the tail shows at (xd, yd) dots: inside the bowl it is behind the head, so it fades to a ghost
const INNER = 1 - BOWL.w / ((BOWL.rx + BOWL.ry) / 2);
function behind(L, xd, yd) {
  const x = (xd - L.qx0) / L.H, y = (yd - L.qy0) / L.H, e = Math.hypot((x - BOWL.cx) / BOWL.rx, (y - BOWL.cy) / BOWL.ry);
  return e < INNER ? 0 : 1; // wholly behind the head
}
function drawTail(F, p, L) {
  const tp = p.tail, pts = tailSpine(tp, L);
  const glow = p.glow, tint = p.tint && p.tintAmt ? p.tint : null;
  const col = (xd) => (tint ? mix(L.grad(xd), tint, p.tintAmt) : L.grad(xd));
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const q = pts[i], f = i / (n - 1);
    const cx = L.X(q.x), cy = L.Y(q.y), R = Math.max(0.6, q.r * L.H * (1 - 0.55 * smooth((f - 0.6) / 0.4)));
    for (let dy = -Math.ceil(R); dy <= Math.ceil(R); dy++) for (let dx = -Math.ceil(R); dx <= Math.ceil(R); dx++) {
      if (dx * dx + dy * dy <= R * R + 0.25) F.set(cx + dx, cy + dy, glow * behind(L, cx + dx, cy + dy), col(cx + dx));
    }
  }
  // v2: little spines along the back of the tail (a dragon, not an imp)
  for (const fs of [0.42, 0.6, 0.76]) {
    const i = Math.round(fs * (n - 1)), q = pts[i], R = q.r * L.H * (1 - 0.55 * smooth((fs - 0.6) / 0.4));
    if (q.s <= TAIL_FIXED * 0.98) continue;
    const c = Math.cos(q.th), s = Math.sin(q.th), nx = s, ny = -c, h = (0.08 - 0.03 * fs) * L.H, b = 0.032 * L.H;
    const bx = L.X(q.x) + nx * R * 0.7, by = L.Y(q.y) + ny * R * 0.7;
    for (let a = -b; a <= b; a += 0.5) for (let u = 0; u <= h * (1 - Math.abs(a + b * 0.5) / (b * 1.5)); u += 0.5) {
      F.set(bx + c * a + nx * u, by + s * a + ny * u, glow, col(bx + c * a));
    }
  }
  if (tp.spade > 0.01) {
    // a sharp spade at the tip: a long point and two barbs swept back, aligned to the tail's last heading
    const e = pts[pts.length - 1], c = Math.cos(e.th), s = Math.sin(e.th), sz = 0.075 * tp.spade;
    const P = (along, side) => [L.X(e.x + c * along * sz - s * side * sz), L.Y(e.y + s * along * sz + c * side * sz)];
    const poly = [P(2.4, 0), P(0.2, 1.0), P(0.55, 0.25), P(-0.3, 0.12), P(-0.3, -0.12), P(0.55, -0.25), P(0.2, -1.0)];
    const xs = poly.map((q) => q[0]), ys = poly.map((q) => q[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
      let inside = false;
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const [xa, ya] = poly[a], [xb, yb] = poly[b];
        if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
      }
      if (inside) F.set(x, y, glow, col(x));
    }
  }
}

/** The face, so the bowl reads as a head: a smile that opens to talk (and to breathe), pink cheeks. p.frown turns the closed smile over. */
export const FACE = { y: 0.75, w: 0.07 };
function drawFace(F, p, L) {
  const ink = [224, 231, 255], o = clamp(p.smile || 0), w = FACE.w, y0 = FACE.y, fx = BOWL.cx + (p.faceX || 0);
  for (let u = -1; u <= 1.0001; u += 0.03) {
    const x = L.X(fx + u * w), top = L.Y(y0 + 0.03 * (1 - u * u)), bot = L.Y(y0 + (0.03 + 0.07 * o) * (1 - u * u));
    if (o > 0.05) { for (let y = Math.round(top); y <= bot; y++) F.set(x, y, 1, Math.abs(u) < 0.6 && y > top + 2 && y < bot - 1 ? [244, 114, 182] : ink); }
    else F.set(x, p.frown ? L.Y(y0 + 0.03 * u * u) : top, 1.05, ink); // frown: the closed smile turned over (a mood, with the eyes)
  }
  for (const sd of [-1, 1]) for (let dy = -1; dy <= 1; dy++) for (let dx = -3; dx <= 3; dx++) {
    if ((dx / 3.4) ** 2 + (dy / 1.6) ** 2 <= 1) F.set(L.X(BOWL.cx + (p.faceX || 0) * 0.5 + sd * 0.2) + dx, L.Y(0.7) + dy, 0.9, [244, 114, 182]);
  }
}

/** v2: two small bat wings tucked behind the head (dim: they are behind it), flapping gently with p.flap (radians). */
function fillPoly(F, poly, val, rgbAt, L) {
  const xs = poly.map((q) => q[0]), ys = poly.map((q) => q[1]);
  for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
    let inside = false;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
      const [xa, ya] = poly[a], [xb, yb] = poly[b];
      if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
    }
    if (inside && (!L || behind(L, x, y))) F.set(x, y, val(x, y), rgbAt(x, y));
  }
}
const WING = [[0, -0.2], [0.34, -0.5], [0.36, -0.3], [0.27, -0.28], [0.25, -0.15], [0.16, -0.17], [0.13, -0.04], [0, 0.02]];
export let WING_K = 0.66, WING_V = 0.42;
export const setWing = (k, v) => { WING_K = k; WING_V = v; };
function drawWings(F, p, L) {
  if (p.wings === 0) return;
  const a = p.flap || 0;
  for (const sd of [-1, 1]) {
    const K = WING_K * (p.wingScale || 1), rx = BOWL.cx + sd * BOWL.rx * 0.86, ry = BOWL.cy - 0.04, c = Math.cos(a * sd), s = Math.sin(a * sd);
    const poly = WING.map(([u, v]) => { const x = K * (u * c + v * s * sd), y = K * (-u * s * sd + v * c); return [L.X(rx + sd * x), L.Y(ry + y)]; });
    fillPoly(F, poly, () => WING_V, (x) => L.grad(x), L);
  }
}
/** Fire breath, embers and smoke at ms since the breath began. Particles are seeded, positions are closed-form. */
const fireCache = new Map();
function fireModel(L, seed, dur) {
  const key = `${L.size}:${L.cols}:${seed}:${dur}${L.left ? `:L${L.qx0}` : ''}`;
  if (fireCache.has(key)) return fireCache.get(key);
  const R = rng(seed), reach = Math.max(14, Math.min(L.H * 1.25, L.left ? L.mouth[0] - 6 : L.Wd - L.mouth[0] - 6));
  const N = Math.round(reach * 26), parts = [];
  for (let i = 0; i < N; i++) {
    const b = R() * dur, u = b / dur;
    const env = smooth(u / 0.12) * (1 - smooth((u - 0.78) / 0.22));
    if (R() > 0.15 + 0.85 * env) continue;
    const ember = R() < 0.07;
    parts.push({
      b, ember, life: ember ? 1400 + R() * 1300 : 300 + R() * 330, ang: 0.06 + (R() - 0.5) * 0.3, v: (reach / 520) * (0.75 + 0.5 * R()),
      ph: R() * TAU, wf: 0.012 + R() * 0.012, lat: (R() - 0.5) * 2, hj: 0.85 + 0.15 * R(), id: i,
    });
  }
  const smoke = [];
  for (let i = 0; i < Math.round(reach * 0.32); i++) {
    smoke.push({
      b: dur * 0.45 + R() * (dur * 0.6 + 1400), d: (0.15 + 0.8 * R()) * reach, dy: (R() - 0.5) * 4, life: 1700 + R() * 1300,
      rise: 0.010 + R() * 0.007, drift: (R() - 0.25) * 0.004, amp: 1.4 + R() * 1.8, w: 0.004 + R() * 0.003, ph: R() * TAU,
    });
  }
  const m = { parts, smoke, reach };
  fireCache.set(key, m);
  return m;
}
function drawFire(F, fire, L) {
  const { t, dur = 1200, seed = 3, scale = 1 } = fire;
  const M = fireModel(L, seed, dur), [mx, my] = L.mouth, sg = L.left ? -1 : 1;
  for (const q of M.parts) {
    const age = t - q.b;
    if (age < 0 || age > q.life) continue;
    const s = age / q.life;
    if (q.ember) {
      const tau = 260, dist = q.v * tau * (1 - Math.exp(-age / tau)) * 1.25 * scale;
      const x = mx + sg * (dist * Math.cos(q.ang) + Math.sin(age * 0.004 + q.ph) * 2.2), y = my + dist * Math.sin(q.ang) + q.lat * 3 - age * 0.009;
      if (hash(q.id * 31 + Math.floor(age / 85)) < 0.28) continue; // flicker
      F.set(x, y, 0.75 + 0.35 * (1 - s), fireRGB(0.72 - 0.4 * s));
      continue;
    }
    for (let k = 0; k < 2; k++) {
      const a = Math.max(0, age - k * 22), sa = a / q.life;
      const dist = q.v * a * (1 - 0.32 * sa) * scale;
      const fr = dist / M.reach;
      const spread = q.lat * dist * 0.2 + Math.sin(a * q.wf + q.ph) * dist * 0.08;
      const x = mx + sg * (dist * Math.cos(q.ang) - Math.sin(q.ang) * spread), y = my + dist * Math.sin(q.ang) + spread * Math.cos(q.ang) - fr * fr * M.reach * 0.14;
      const heat = clamp((1 - sa) ** 0.75 * q.hj * (1 - 0.45 * fr) * (1 - 0.45 * Math.abs(q.lat)) + (dist < 6 ? 0.35 : 0));
      F.set(x, y, (k ? 0.55 : 0.7) + 0.55 * heat, fireRGB(heat - k * 0.08));
    }
  }
  for (const q of M.smoke) drawWisp(F, mx + sg * q.d * Math.cos(0.08), my + q.d * Math.sin(0.08) + q.dy, t - q.b, q, sg);
}

/**
 * A smoke wisp: a rising, gently swaying streak (its head plus a trail of where it has been). Grey shades fade
 * with age (lighter grey to background), and the whole wisp drifts sideways as it rises.
 */
function drawWisp(F, x0, y0, age, q, sg = 1) {
  if (age < 0 || age > q.life + 500) return;
  const pos = (a) => [x0 + sg * (a * q.drift + Math.sin(a * q.w + q.ph) * q.amp * (0.4 + a / q.life)), y0 - a * q.rise];
  let prev = null;
  for (let k = 0; k < 12; k++) {
    const a = age - k * 45;
    if (a < 0) break;
    if (a > q.life) continue;
    const s = a / q.life, fade = (1 - s) ** 1.2 * smooth(a / 220) * (1 - k / 13);
    if (fade < 0.06) continue;
    const [x, y] = pos(a), rgb = mix(TH.smoke0, TH.smoke1, s);
    F.set(x, y, 0.2 + 0.6 * fade, rgb);
    if (prev && Math.hypot(x - prev[0], y - prev[1]) > 1.2) F.set((x + prev[0]) / 2, (y + prev[1]) / 2, 0.2 + 0.55 * fade, rgb);
    prev = [x, y];
  }
}

// ---- compose -----------------------------------------------------------------------------------------------
const BR = [[0x1, 0x8], [0x2, 0x10], [0x4, 0x20], [0x40, 0x80]];

/**
 * Render a pose: rows of cells { ch, rgb, bg }. opts: { mono, theme }. (t is accepted and ignored: nothing flickers.)
 * The label (pose.label = { text | cells, rgb, row, col }) is written into the frame to the right of the Q.
 */
export function renderDragon(pose, L0, { mono = false, theme = 'dark' } = {}) {
  TH = THEMES[theme] || THEMES.dark;
  const L = pose.mouthSide === 'left' ? { ...L0, mouth: [L0.X(BOWL.cx + (pose.faceX || 0) - FACE.w * 0.6), L0.Y(FACE.y + 0.05)], left: true } : L0; // the mouth-dependent parts see the mirrored mouth
  const F = makeField(L.Wd, L.Hd);
  drawWings(F, pose, L);
  drawBody(F, pose, L);
  drawTail(F, pose, L);
  drawFace(F, pose, L);
  if (pose.fire) drawFire(F, pose.fire, L);
  const thr = mono ? 0.35 : 0.04, rows = [];
  for (let cy = 0; cy < L.rows; cy++) {
    const row = [];
    for (let cx = 0; cx < L.cols; cx++) {
      let bits = 0, m = 0, mi = -1;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = (cy * 4 + dy) * L.Wd + cx * 2 + dx, val = F.v[i];
        if (val > thr) { bits |= BR[dy][dx]; if (val > m) { m = val; mi = i; } }
      }
      if (!bits) { row.push({ ch: ' ', rgb: null, bg: null }); continue; }
      let rgb = null;
      if (!mono) {
        const base = [F.c[mi * 3], F.c[mi * 3 + 1], F.c[mi * 3 + 2]], f = 0.28 + 0.72 * Math.min(1, m), fl = clamp(m - 1);
        rgb = TH.light
          ? base.map((c, j) => Math.round((TH.bg[j] + (c - TH.bg[j]) * (0.12 + 0.88 * Math.min(1, m))) * (1 - 0.25 * fl)))
          : base.map((c) => { c *= f; return Math.round(c + (255 - c) * fl * 0.9); });
      }
      row.push({ ch: String.fromCharCode(0x2800 + bits), rgb, bg: null });
    }
    rows.push(row);
  }
  const lb = pose.label;
  if (lb) {
    const cells = (lb.cells || [...lb.text].map((ch) => ({ ch, rgb: lb.rgb || null }))).map((cl) => ({ ch: cl.ch, rgb: cl.rgb ? TH.label(cl.rgb) : null }));
    let r = lb.row ?? Math.floor(L.H / 8), c0 = lb.col ?? L.qCols + (L.cols >= 64 ? 7 : 2);
    if (c0 + cells.length > L.cols) { r = L.H / 4 + 1; c0 = Math.max(0, Math.floor((L.qCols - cells.length) / 2) + 2); } // no room beside: under the Q
    const target = r < rows.length ? rows[r] : null;
    if (target) cells.forEach((cl, k) => { if (c0 + k < L.cols) target[c0 + k] = { ch: cl.ch, rgb: mono ? null : cl.rgb, bg: null }; });
  }
  return rows;
}

// ---- output helpers ----------------------------------------------------------------------------------------
const ANSI16 = [[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]];
function sgr(rgb, depth, bg) {
  const [r, g, b] = rgb;
  if (depth === 3) return `\x1b[${bg ? 48 : 38};2;${r};${g};${b}m`;
  if (depth === 2) return `\x1b[${bg ? 48 : 38};5;${16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51)}m`;
  let best = 0, bd = 1e9;
  ANSI16.forEach((c, i) => { const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2; if (d < bd) { bd = d; best = i; } });
  return `\x1b[${(best < 8 ? 30 + best : 82 + best) + (bg ? 10 : 0)}m`;
}
/** Cells -> ANSI lines. depth 3 truecolor, 2 = 256, 1 = 16, 0 = none. */
export function cellsToAnsi(rows, depth = 3) {
  return rows.map((row) => {
    let s = '', lf = '', lb = '';
    for (const c of row) {
      const f = depth && c.rgb ? sgr(c.rgb, depth, false) : '', b = depth && c.bg ? sgr(c.bg, depth, true) : '';
      if ((lb && !b) || (lf && !f && c.ch !== ' ')) { s += '\x1b[0m'; lf = ''; lb = ''; }
      if (f && f !== lf) { s += f; lf = f; }
      if (b && b !== lb) { s += b; lb = b; }
      s += c.ch;
    }
    return s + (lf || lb ? '\x1b[0m' : '');
  });
}
