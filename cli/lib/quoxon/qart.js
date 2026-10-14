/**
 * The horned Q as Braille art, and every motion the owner reviewed in the lab (~/quoxon-work/intro/lab):
 * Orbit & Lock (the intro), Portal, Particle collapse. CLI-QUOX.
 *
 * PURE AND PORTABLE on purpose: no Ink, no process, no timers, no terminal APIs. Inputs are size, progress
 * (or ms), state and seed; the core output is rows of cells `{ ch, rgb, bg? }` (rgb null = default colour; bg, when
 * present, a background colour: the dragon's eyes in qdragon.js use it). The
 * same module renders in the terminal (cellsToAnsi) and in a browser (web/qface.js), which is how the Q
 * becomes the face of the app on cli.quox.ai as well as in the CLI.
 *
 * The Q is rasterised from a small vector description (ring bowl, tapered tail, two curved horns) at the
 * dot resolution of the target size, so every size has a smooth bowl instead of a scaled bitmap. Each dot
 * knows which part it belongs to (bowl, tail, horn) and how far along that part it sits, which is what the
 * tail sweep, the horn glint and the portal reveal key off.
 */

export const SKY = [56, 189, 248];
export const VIOLET = [168, 85, 247];
export const AMBER = [245, 158, 11];
export const RED = [239, 68, 68];
const TAU = Math.PI * 2;
const ASPECT = 0.82; // silhouette width / height, in square dots

// size -> dot height. A Braille cell is 2 dots wide and 4 tall, so rows = H / 4.
// small is the lab's compact particle Q (under 60 cols); large/mid are the intro sizes.
export const SIZES = { large: 72, mid: 44, small: 24 };

/** Pick the Q size for a terminal. Under 60 cols the caller uses the half-block compact Q instead. */
export function qSize(cols, rows) {
  if (cols < 60) return 'compact';
  return cols >= 100 && rows >= 30 ? 'large' : 'mid';
}

/** Lab parity sizing: under 60 cols (or under 12 rows) the lab's compact particle Q, never a half-block. */
export function labSize(cols, rows) {
  if (cols < 60 || rows < 12) return 'small';
  return qSize(cols, rows);
}

export function qDims(size) {
  const H = SIZES[size];
  const cells = Math.ceil((H * ASPECT) / 2);
  return { H, W: cells * 2, cols: cells, rows: H / 4 };
}

// ---- silhouette (unit space: y 0..1 top to bottom, x 0..ASPECT) -----------------------------------
const distSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return [Math.sqrt((px - (ax + dx * t)) ** 2 + (py - (ay + dy * t)) ** 2), t];
};
const bez = (a, b, c, t) => [(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * b[0] + t * t * c[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * b[1] + t * t * c[1]];

export const BOWL = { cx: ASPECT / 2, cy: 0.6, rx: 0.4, ry: 0.385, w: 0.118 };
// Each horn is a quadratic curve, thick at the base and tapering to a point: out and up like a bull's.
// The right horn is the exact mirror of the left about the bowl's axis (it was hand-tuned and its tip had
// drifted to y 0.0 against the left's 0.03, which read as a thin stalk next to a solid horn).
const LEFT_HORN = { a: [0.2, 0.29], b: [-0.02, 0.27], c: [0.02, 0.03], r0: 0.048 };
const mirrorX = (p) => [ASPECT - p[0], p[1]];
const HORNS = [LEFT_HORN, { a: mirrorX(LEFT_HORN.a), b: mirrorX(LEFT_HORN.b), c: mirrorX(LEFT_HORN.c), r0: LEFT_HORN.r0 }];
const HORN_PTS = HORNS.map((hn) => Array.from({ length: 24 }, (_, i) => ({ p: bez(hn.a, hn.b, hn.c, i / 23), t: i / 23, r0: hn.r0 })));
const TAIL = { a: [0.4, 0.69], b: [0.79, 0.985], r0: 0.07, r1: 0.04 };

/** Which part of the Q a unit point is in: null, or { part: 'bowl'|'tail'|'horn', t } (t = 0 base .. 1 tip). */
function partAt(x, y) {
  const [d, t] = distSeg(x, y, ...TAIL.a, ...TAIL.b);
  const inTail = d <= TAIL.r0 + (TAIL.r1 - TAIL.r0) * t;
  const dx = (x - BOWL.cx) / BOWL.rx, dy = (y - BOWL.cy) / BOWL.ry;
  const e = Math.sqrt(dx ** 2 + dy ** 2);
  const inner = 1 - BOWL.w / ((BOWL.rx + BOWL.ry) / 2);
  if (e <= 1 && e >= inner) return { part: inTail && t > 0.45 ? 'tail' : 'bowl', t: inTail ? t : 0 };
  if (inTail) return { part: 'tail', t };
  if (y > 0.34) return null;
  for (const pts of HORN_PTS) for (const q of pts) if (Math.sqrt((x - q.p[0]) ** 2 + (y - q.p[1]) ** 2) <= q.r0 * (1 - q.t * 0.93) + 0.004) return { part: 'horn', t: q.t };
  return null;
}

const maskCache = new Map();
/**
 * Boolean mask of the Q silhouette at a size: { W, H, ox, on(x, y), dots: [{ x, y, part, t }] }.
 * ox is the left offset of the silhouette inside the cell grid (dots).
 */
export function qMask(size) {
  if (maskCache.has(size)) return maskCache.get(size);
  const { W, H } = qDims(size);
  const ox = (W - H * ASPECT) / 2; // the Q's axis sits exactly on the grid centre, so the mask mirrors dot for dot
  const dots = [];
  const grid = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // 2x2 supersample for clean edges
    let n = 0;
    for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) if (partAt((x - ox + sx) / H, (y + sy) / H)) n++;
    if (n >= 2) {
      grid[y * W + x] = 1;
      const p = partAt((x - ox + 0.5) / H, (y + 0.5) / H) || { part: 'bowl', t: 0 };
      dots.push({ x, y, part: p.part, t: p.t });
    }
  }
  const m = { W, H, ox, on: (x, y) => grid[y * W + x] === 1, dots };
  maskCache.set(size, m);
  return m;
}

// ---- intensity field -> cells -> text -----------------------------------------------------------------
const BR = [[0x1, 0x8], [0x2, 0x10], [0x4, 0x20], [0x40, 0x80]];
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = (e) => { e = clamp(e); return e * e * (3 - 2 * e); };
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const RESET = '\x1b[0m';

/** A field of dot intensities. 0 = off, 1 = the settled Q, > 1 = a flash (pushes towards white). */
export function makeField(W, H) {
  const v = new Float32Array(W * H);
  return {
    W, H, v,
    set(x, y, val) {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = y * W + x; if (val > v[i]) v[i] = val;
    },
  };
}

/**
 * Turn a field into rows of cells { ch, rgb }. rgb is null for blanks and in mono.
 *   color false (mono): shapes only, dim dots (< 0.35) are dropped, as in the lab.
 *   quant true (terminal default): 4 hue bands x 6 brightness levels, so SGR runs stay long (Ink tokenising
 *     a per-cell colour was ~100 ms a frame); trails keep their own levels so the drag still reads.
 *   quant false (web): the lab's continuous shade, every cell its own colour.
 *   tint: one rgb for every cell instead of the sky to violet gradient (amber, red, ...).
 */
export function fieldToCells(field, { color = true, quant = true, tint = null } = {}) {
  const { W, H, v } = field;
  const thr = color ? 0.04 : 0.35;
  const cols = W / 2, rows = H / 4, out = [];
  for (let cy = 0; cy < rows; cy++) {
    const row = [];
    for (let cx = 0; cx < cols; cx++) {
      let bits = 0, m = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) {
        const val = v[(cy * 4 + dy) * W + cx * 2 + dx];
        if (val > thr) { bits |= BR[dy][dx]; if (val > m) m = val; }
      }
      if (!bits) { row.push({ ch: ' ', rgb: null }); continue; }
      let rgb = null;
      if (color) {
        if (quant) {
          const base = tint || lerp(SKY, VIOLET, (Math.min(3, Math.floor((cx / cols) * 4)) + 0.5) / 4);
          const [lum, fl] = m > 1.5 ? [1, 0.85] : m > 1.05 ? [1, 0.45] : m >= 0.95 ? [1, 0] : m > 0.6 ? [0.72, 0] : m > 0.38 ? [0.48, 0] : [0.3, 0];
          rgb = base.map((c) => Math.round(c * lum + (255 - c * lum) * fl));
        } else {
          const base = tint || lerp(SKY, VIOLET, cols > 1 ? cx / (cols - 1) : 0);
          const f = 0.28 + 0.72 * Math.min(1, m), fl = clamp(m - 1);
          rgb = base.map((c) => { c *= f; return Math.round(c + (255 - c) * fl * 0.9); });
        }
      }
      row.push({ ch: String.fromCharCode(0x2800 + bits), rgb });
    }
    out.push(row);
  }
  return out;
}

const sgr = (rgb, bg = false) => `\x1b[${bg ? 48 : 38};2;${rgb.map((x) => Math.max(0, Math.min(255, Math.round(x)))).join(';')}m`;
/**
 * Cells -> ANSI lines (truecolor SGR, one escape per colour run). Mono cells carry no SGR at all. A cell may
 * also carry `bg` (the dragon's eyes are quadrant blocks with a foreground AND a background colour); a
 * background run is closed with a reset before the next cell without one, so it never bleeds. Cells without
 * bg render exactly as they always have.
 */
export function cellsToAnsi(rows) {
  return rows.map((row) => {
    let s = '', last = '', lastBg = '';
    for (const c of row) {
      const b = c.bg ? sgr(c.bg, true) : '';
      if (lastBg && !b) { s += RESET; last = ''; lastBg = ''; }
      if (c.rgb) { const e = sgr(c.rgb); if (e !== last) { s += e; last = e; } }
      else if (last && c.ch !== ' ') { s += RESET; last = ''; if (lastBg) lastBg = ''; }
      if (b && b !== lastBg) { s += b; lastBg = b; }
      s += c.ch;
    }
    return s + (last || lastBg ? RESET : '');
  });
}
/** Cells -> plain text lines. */
export const cellsToText = (rows) => rows.map((r) => r.map((c) => c.ch).join(''));

const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// ---- the settled Q ------------------------------------------------------------------------------------
/** Cells of the settled Q. */
export function qCells(size, opts = {}) {
  const m = qMask(size), f = makeField(m.W, m.H);
  for (const d of m.dots) f.v[d.y * m.W + d.x] = 1;
  return fieldToCells(f, opts);
}
/** Rows of text for the settled Q (identical to orbitFrame(size, 1)). */
export function qLines(size, { color = true } = {}) { return cellsToAnsi(qCells(size, { color })); }

// ---- 1: Orbit & Lock (and 3: Particle collapse) ---------------------------------------------------------
/** The intro's whole budget, ms. Orbit runs ORBIT_MS of it; the rest holds the finished mark. */
export const INTRO_MS = 900;
export const ORBIT_MS = 820;
const FLASH_MS = 170;
// Lab parameters, verbatim (lab.mjs build()): orbit for large/mid, particle for the compact Q.
const SWARM = {
  orbit: { band: 0.3, appearMax: 0.08, lockStart: 0.42, lockSpan: 0.2, lockLen: 0.2, byAngle: true, spin: [0.5, 5] },
  particle: { band: 0.05, appearMax: 0.5, lockStart: 0.55, lockSpan: 0.12, lockLen: 0.2, byAngle: false, spin: [1.2, 2.5] },
};

const swarmCache = new Map();
function swarm(size, kind, seed) {
  const key = `${size}:${kind}:${seed}`;
  if (swarmCache.has(key)) return swarmCache.get(key);
  const P = SWARM[kind], m = qMask(size), R = rng(seed + m.H);
  const cx = m.W / 2, cy = m.H / 2, Rmax = Math.min(m.W, m.H) / 2 - 1.5;
  const parts = m.dots.map((d) => ({
    tx: d.x, ty: d.y, part: d.part, pt: d.t, ang: Math.atan2(d.y - cy, d.x - cx), th0: R() * TAU,
    rho: Rmax - Rmax * P.band * R() ** 2, w: 0.85 + 0.3 * R(), ap: R() * P.appearMax, rnd: R(),
  }));
  const key2 = (p) => (P.byAngle ? p.ang : p.rnd);
  [...parts].sort((a, b) => key2(a) - key2(b)).forEach((p, i) => { p.s = P.lockStart + P.lockSpan * (i / (parts.length - 1)); });
  // Tail sweep: the tail is the last stroke to land, base to tip, so the Q finishes with a flourish.
  // Horns land tip-last, so each horn grows out of the bowl with its flash travelling up to the point.
  const end = P.lockStart + P.lockSpan;
  for (const p of parts) {
    if (p.part === 'tail') p.s = end - 0.06 + 0.08 * p.pt;
    else if (p.part === 'horn') p.s = Math.min(p.s, end - 0.1) + 0.05 * p.pt;
  }
  const r = { P, parts, cx, cy };
  swarmCache.set(key, r);
  return r;
}

/**
 * The swarm field at t ms. Each particle draws a head plus two trail samples that lag along its path; the
 * lag grows with speed (0.09 * (1 + 2u) rad), which is the "drag" in the lab: fast particles smear.
 */
function swarmField(size, t, { kind = 'orbit', dur = ORBIT_MS, seed = 11 } = {}) {
  const m = qMask(size), { P, parts, cx, cy } = swarm(size, kind, seed), f = makeField(m.W, m.H);
  const u = t / dur, settled = t > dur + FLASH_MS + 300;
  const ph = TAU * (P.spin[0] * u + P.spin[1] * u * u);
  for (const p of parts) {
    const e = settled ? 1 : smooth((u - p.s) / P.lockLen);
    if (e >= 1) {
      const lt = (u - (p.s + P.lockLen)) * dur;
      f.set(p.tx, p.ty, settled ? 1 : 1 + Math.max(0, 1 - lt / FLASH_MS) * 0.9);
      continue;
    }
    if (u < p.ap) continue;
    const fade = Math.min(1, ((u - p.ap) * dur) / 90);
    for (let k = 0; k < 3; k++) {
      const th = p.th0 + (ph - k * 0.09 * (1 + 2 * u)) * p.w;
      const x = cx + p.rho * Math.cos(th), y = cy + p.rho * Math.sin(th);
      f.set(x + (p.tx - x) * e, y + (p.ty - y) * e, (k === 0 ? 0.9 : k === 1 ? 0.5 : 0.28) * fade + (e > 0 && k === 0 ? 0.4 * e : 0));
    }
  }
  return f;
}

/** Orbit & Lock cells at t ms (0..INTRO_MS; >= INTRO_MS is the settled Q). small plays the particle collapse. */
export function orbitCellsAt(size, t, opts = {}) {
  if (t >= INTRO_MS) return qCells(size, opts);
  const kind = size === 'small' ? 'particle' : 'orbit';
  return fieldToCells(swarmField(size, t, { kind, dur: kind === 'particle' ? INTRO_MS - 60 : ORBIT_MS, seed: opts.seed ?? 11 }), opts);
}

/**
 * One frame of Orbit & Lock at progress 0..1 of INTRO_MS (lab timing: 820 ms orbit, all locks done by
 * 672 ms, the last flashes fade by ~840 ms). progress >= 1 is exactly the settled Q.
 */
export function orbitFrame(size, progress, { color = true } = {}) {
  if (progress >= 1) return qLines(size, { color });
  return cellsToAnsi(orbitCellsAt(size, progress * INTRO_MS, { color }));
}

/** Particle collapse at t ms of `dur` (the lab's compact variant, any size). */
export function particleCellsAt(size, t, opts = {}) {
  const dur = opts.dur ?? 1100;
  if (t >= dur + FLASH_MS + 300) return qCells(size, opts);
  return fieldToCells(swarmField(size, t, { kind: 'particle', dur, seed: opts.seed ?? 12 }), opts);
}

// ---- 2: Portal -------------------------------------------------------------------------------------------
export const PORTAL_MS = 1000;
const portalCache = new Map();
function portalModel(size) {
  if (portalCache.has(size)) return portalCache.get(size);
  const m = qMask(size), H = m.H;
  const ccx = m.ox + BOWL.cx * H, ccy = BOWL.cy * H, ringR = 0.3 * H, revR = 0.42 * H;
  const phiAt = (u) => (u < 0.3 ? (Math.PI / 2) * smooth(u / 0.3) : u < 0.7 ? Math.PI / 2 + (Math.PI / 2) * smooth((u - 0.3) / 0.4) : Math.PI);
  const pts = m.dots.map((d) => {
    // The tail sweeps in last, base to tip (lab: rt 0.74 .. 0.94 along the tail).
    if (d.part === 'tail') return { ...d, rt: 0.74 + 0.2 * d.t };
    let rt = 0.74 + 0.1 * (d.y / H);
    for (let u = 0.3; u <= 0.7; u += 0.004) {
      const w = Math.max(0.02, Math.abs(Math.cos(phiAt(u))));
      if (((d.x - ccx) / (revR * w)) ** 2 + ((d.y - ccy) / revR) ** 2 <= 1) { rt = u; break; }
    }
    return { ...d, rt };
  });
  const r = { m, ccx, ccy, ringR, phiAt, pts };
  portalCache.set(size, r);
  return r;
}

/** Portal at t ms: a ring spins in 3D (circle, edge-on line, open), the Q fills from the opening, tail last. */
export function portalCellsAt(size, t, opts = {}) {
  const { m, ccx, ccy, ringR, phiAt, pts } = portalModel(size), f = makeField(m.W, m.H);
  const dur = PORTAL_MS, u = t / dur, settled = t > dur + 500, phi = phiAt(Math.min(u, 1));
  if (settled) return qCells(size, opts);
  const alpha = Math.min(1, u / 0.1) * (1 - clamp((u - 0.68) / 0.12));
  if (alpha > 0) {
    const w = Math.cos(phi), n = Math.round(ringR * 24);
    for (let i = 0; i < n; i++) {
      const th = (i / n) * TAU, z = Math.cos(th) * Math.sin(phi);
      f.set(ccx + ringR * Math.cos(th) * w, ccy + ringR * Math.sin(th), alpha * (0.62 + 0.38 * z));
    }
    if (Math.abs(w) < 0.12) for (let yy = -ringR; yy <= ringR; yy++) f.set(ccx, ccy + yy, alpha * 1.15);
  }
  for (const p of pts) if (u >= p.rt) f.set(p.x, p.y, 1 + Math.max(0, 1 - ((u - p.rt) * dur) / 150) * 0.7);
  return fieldToCells(f, opts);
}

// ---- resting --------------------------------------------------------------------------------------------
export const BREATH_MS = 2400;
/** The settled Q breathing gently (idle on the web face): brightness 0.82 .. 1 over BREATH_MS. */
export function restCellsAt(size, t, opts = {}) {
  const m = qMask(size), f = makeField(m.W, m.H);
  const g = 0.82 + 0.18 * (0.5 + 0.5 * Math.sin((t / BREATH_MS) * TAU - Math.PI / 2));
  for (const d of m.dots) f.v[d.y * m.W + d.x] = g;
  return fieldToCells(f, opts);
}

// ---- intro plan ------------------------------------------------------------------------------------------
/**
 * The intro as one timeline: Orbit & Lock, then the settled Q. Returns { ms, at(t) -> cells }. Callers drive t
 * from their own clock.
 */
export function introPlan(size, opts = {}) {
  return {
    ms: INTRO_MS,
    at(t) {
      if (t < INTRO_MS) return orbitCellsAt(size, t, opts);
      return qCells(size, opts);
    },
  };
}
