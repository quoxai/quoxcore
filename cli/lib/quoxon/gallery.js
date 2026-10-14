/**
 * `quox motion`: the product version of the animation lab (~/quoxon-work/intro/lab). Plays every Q motion
 * with a caption: Orbit & Lock, Portal, Particle collapse, the perpetual status Q in its
 * four states, the hello, the composer ring and the reveal effects. No server, no account, nothing sent.
 *
 * Scenes are pure: galleryScenes() returns { id, title, caption, ms, frame(t) -> ANSI lines }. runGallery()
 * is the only part that touches a terminal (cursor, timers, signals).
 */
import {
  labSize, orbitCellsAt, portalCellsAt, particleCellsAt, cellsToAnsi, qCells,
  INTRO_MS, PORTAL_MS, SKY, VIOLET, AMBER,
} from './qart.js';
import { qGlyph, glyphAnsi, GLYPH_STATES } from './qglyph.js';
import { helloCells, helloAnsi, helloGradient, helloMs } from './qhello.js';
import { CLIPS, MOOD_CLIPS, clipCells, clipCaption } from './qdragonScenes.js';
import { isLight } from './theme.js';

const RESET = '\x1b[0m';
const fg = (rgb) => `\x1b[38;2;${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))).join(';')}m`;
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const DIM = [58, 66, 82], MUTED = [120, 132, 150], TXT = [226, 232, 240], TEAL = [6, 182, 212];
const GREEN = [34, 197, 94], WHITE = [255, 255, 255];
const paint = (s, rgb, mono) => (mono || !rgb ? s : fg(rgb) + s + RESET);

// ---- composer ring (lab rules.mjs: the website's conic border as one light ring over the two rules) ------
const PAL = { work: [SKY, VIOLET, TEAL], wait: [AMBER, [0xea, 0x58, 0x0c], [0xb4, 0x53, 0x09]] };
const STOPS = [[0, 0, 0.85], [0.35, 1, 0.8], [0.6, 0, 0], [0.85, 2, 0.55], [1, 0, 0.85]];
function ringAt(u, w) {
  let i = 0; while (i < STOPS.length - 2 && u > STOPS[i + 1][0]) i++;
  const [p0, c0, a0] = STOPS[i], [p1, c1, a1] = STOPS[i + 1], t = (u - p0) / (p1 - p0 || 1);
  const col = (c) => mix(PAL.work[c], PAL.wait[c], w);
  const A = a0 + (a1 - a0) * t;
  const pm = mix(col(c0).map((v) => v * a0), col(c1).map((v) => v * a1), t);
  return [A ? pm.map((v) => v / A) : col(c0), A];
}
const RING_SEG = [['idle', 0.8], ['work', 3.2], ['settle', 0.4], ['idle', 0.6], ['wait', 2.2], ['settle', 0.4]];
export const RING_MS = RING_SEG.reduce((a, s) => a + s[1], 0) * 1000;
/** Ring state at t ms, integrated at 60 Hz from 0 (deterministic). { angle, k, w, mode } */
export function ringState(t) {
  let angle = 0, k = 0, w = 0, mode = 'idle', settleFrom = { om: 144 }, om = 0, prev = 'idle';
  const T = t / 1000, dt = 1 / 60;
  for (let s = 0; s < T; s += dt) {
    let acc = 0, si = 0;
    while (si < RING_SEG.length - 1 && acc + RING_SEG[si][1] <= s) acc += RING_SEG[si++][1];
    const [m, dur] = RING_SEG[si], p = clamp((s - acc) / dur);
    if (m === 'settle' && prev !== 'settle') settleFrom = { om };
    mode = m; prev = m;
    let wt = 0;
    if (m === 'work') { om = 144; k = Math.min(1, k + dt / 0.15); wt = 0; }
    else if (m === 'wait') { om = 144 * 0.3; k = Math.min(1, k + dt / 0.15); wt = 1; }
    else if (m === 'settle') { om = settleFrom.om * (1 - p) ** 2; k = 1 - p * p * (3 - 2 * p); wt = w; }
    else { om = 0; k = 0; w = 0; }
    if (m !== 'idle') w += (wt - w) * Math.min(1, dt / 0.2);
    angle = (angle + om * dt) % 360;
  }
  return { angle, k, w, mode };
}
/** The two composer rules at ring state st, W columns wide. */
export function ringLines(W, st, mono = false) {
  const line = (top) => {
    let s = '', last = '';
    const base = top ? mix(DIM, SKY, 0.75) : DIM;
    for (let x = 0; x < W; x++) {
      let rgb = base;
      if (st.k > 0) {
        const pos = top ? (x + 0.5) / (2 * W) : (W + (W - 1 - x) + 0.5) / (2 * W);
        const u = (((pos - st.angle / 360) % 1) + 1) % 1;
        const [c, a] = ringAt(u, st.w);
        rgb = mix(base, mix(DIM, c, a), st.k);
      }
      if (!mono) { const e = fg(rgb); if (e !== last) { s += e; last = e; } }
      s += '─';
    }
    return s + (mono ? '' : RESET);
  };
  const label = { idle: 'idle', work: 'working', wait: 'waiting for approval', settle: 'done' }[st.mode];
  return [line(true), paint('› ', SKY, mono) + paint('Ask Quox anything…', MUTED, mono), line(false), paint(`ring: ${label}`, MUTED, mono)];
}

// ---- reveal effects (lab fx.mjs, the reveals that ship in the client) ------------------------------------
const decodeLine = (text, t, f, mono, perChar = 14) => helloAnsi(helloCells(text, t, { fg: f, mono, perChar }));
/** fx at t ms: a tool row settles, an answer drops in, an approval card arms, a receipt seals, ProofFlow lights. */
export function fxLines(t, W, mono = false) {
  const out = [];
  const at = (s) => t - s;
  // tool row (0 ms): spinner while running, then a flash to ✔ and the result decodes in
  const L = at(0), SETTLE = 900;
  const head = L < SETTLE ? paint('◐◓◑◒'[Math.floor(t / 125) % 4], SKY, mono) : paint('✔', L < SETTLE + 120 ? WHITE : GREEN, mono);
  out.push(head + decodeLine(' SEO │ summary │ ', L, (i, ch) => (ch === '│' ? DIM : i < 5 ? TEAL : MUTED), mono) + (L < SETTLE ? paint('…', MUTED, mono) : decodeLine('30 crawls · 2.4s', L - SETTLE, TXT, mono)));
  out.push('');
  // answer (1400 ms): lines drop in one by one, first chars decode, afterglow behind
  const ans = ['Crawls finished with no blocking errors this week.', 'Impressions are up 8 percent; 3 pages moved into the top ten.'];
  ans.forEach((ln, k) => { const s = at(1400 + k * 110); out.push(s < -140 ? '' : '  ' + decodeLine(ln.slice(0, W - 4), s, TXT, mono, 6)); });
  out.push('');
  // approval card (2600 ms): amber rule draws in, title decodes, 300 ms arming, then ready
  const A = at(2600), iw = Math.min(W - 4, 50), draw = clamp(A / 250), n = Math.round(draw * (iw + 2));
  const rule = (a, b) => (A <= 0 ? '' : paint([...(a + '─'.repeat(iw) + b)].slice(0, n).join(''), AMBER, mono));
  out.push(rule('╭', '╮'));
  const armed = clamp((A - 400) / 300), ready = A >= 700;
  out.push(A > 100 ? paint('│ ', AMBER, mono) + decodeLine('Send the weekly SEO report?', A - 100, TXT, mono) : '');
  out.push(A > 100 ? paint('│ ', AMBER, mono) + paint('[ Approve ]', ready ? AMBER : DIM, mono) + '  ' + paint('[ Deny ]', ready ? MUTED : DIM, mono) + '  ' + paint(ready ? 'ready ' : 'arming', ready ? GREEN : AMBER, mono) + ' ' + paint([...'▰▰▰▰▰▰'].map((c, i) => (ready || i < Math.floor(armed * 6) ? '▰' : '▱')).join(''), ready ? GREEN : AMBER, mono) : '');
  out.push(rule('╰', '╯'));
  out.push('');
  // receipt seal (3800 ms): text resolves, the seal settles with a one-frame glint
  const R = at(3800), seq = ['·', '○', '◌', '◎'];
  const seal = R < 0 ? ' ' : R < 400 ? paint(seq[Math.floor(R / 70) % 4], mix(DIM, TEAL, clamp(R / 400)), mono) : paint('◉', R < 460 ? WHITE : TEAL, mono);
  out.push(R < -140 ? '' : seal + decodeLine(' WARD │ witnessed · seq 393', R, (i, ch) => (ch === '│' ? DIM : i < 5 ? TEAL : TXT), mono));
  // ProofFlow (4600 ms): AEE > AOCL > TOOL > WARD light up in sequence; completed ones stay still
  const P = at(4600);
  out.push(P < 0 ? '' : paint('proof  ', MUTED, mono) + ['AEE', 'AOCL', 'TOOL', 'WARD'].map((nm, i) => { const d = P - i * 120; return paint(nm, d < 0 ? DIM : d < 100 ? WHITE : SKY, mono); }).join(paint(' ─▸ ', mix(DIM, SKY, 0.8), mono)));
  out.push('');
  // closing line (5400 ms)
  const C = at(5400);
  out.push(C < -140 ? '' : decodeLine('Thought for 12s · 1.4k tokens · $0.02', C, (i, ch) => (ch === '·' ? DIM : MUTED), mono));
  return out;
}
export const FX_MS = 6600;

// ---- scenes ------------------------------------------------------------------------------------------------
const STATE_WORD = { resting: 'Ready', working: 'Thinking…', waiting: 'Waiting for approval', failing: 'Failed' };
const STATE_TAG = { resting: 'resting: slow breathing glow', working: 'working: the gradient flows through it', waiting: 'waiting: amber pulse', failing: 'failing: a red flash, then steady red' };
const STATE_RGB = { resting: SKY, working: SKY, waiting: AMBER, failing: [239, 68, 68] };
export const PERP_MS = 2600;

/**
 * The gallery's scenes for a terminal. narrow forces the 40-column layout (the compact particle Q).
 * Each scene: { id, title, caption, ms, frame(t, { mono }) -> string[] }.
 */
export function galleryScenes({ cols = 100, rows = 30, narrow = false, theme = isLight() ? 'light' : 'dark' } = {}) {
  const W = narrow ? 40 : cols;
  // the dragon (qdragonScenes.js): eyes as quadrant blocks with a background colour, the lab's light palette on light terminals
  const fit = (str) => (str.length > W ? str.slice(0, W - 1) + '…' : str);
  const dragon = (name, t, o) => [...art(clipCells(name, t, { cols: W, theme, mono: o.mono })), '', paint(fit(clipCaption(name, t)), MUTED, o.mono)];
  const MOOD_SPAN = MOOD_CLIPS.map((m) => CLIPS[m].dur + 400);
  const size = narrow ? 'small' : labSize(W, rows);
  const big = size === 'small' ? 'small' : size;
  const art = (cells) => cellsToAnsi(cells);
  const hello = "Hi, I'm Quox.";
  return [
    { id: 'orbit', title: 'Orbit & Lock', caption: size === 'small' ? 'the compact Q: particles circle, then collapse into the mark (the intro under 60 columns)' : 'particles swirl on a ring with trailing drag, then lock into the Q in an angular wave; horns grow out, the tail sweeps in last (the intro)', ms: INTRO_MS + 300,
      frame: (t, o) => art(orbitCellsAt(big, t, { color: !o.mono })) },
    { id: 'portal', title: 'Portal', caption: 'a ring spins edge-on and opens; the Q fills in from the opening, the tail sweeps in last', ms: PORTAL_MS + 600,
      frame: (t, o) => art(portalCellsAt(big, t, { color: !o.mono })) },
    { id: 'particle', title: 'Particle collapse', caption: 'density rises on a circle, then collapses into the compact Q', ms: 1100 + 500,
      frame: (t, o) => art(particleCellsAt('small', t, { color: !o.mono })) },
    { id: 'hello', title: 'Hello', caption: 'the Q locks, then says hello: the line decodes in from katakana with a short afterglow', ms: INTRO_MS + helloMs(hello) + 600,
      frame: (t, o) => {
        const q = art(t < INTRO_MS ? orbitCellsAt(big, t, { color: !o.mono }) : qCells(big, { color: !o.mono }));
        const line = helloAnsi(helloCells(hello, t - INTRO_MS, { fg: helloGradient(hello), mono: o.mono }));
        if (W < 60) return [...q, '', line];
        const mid = Math.floor(q.length / 2);
        return q.map((l, i) => (i === mid ? l + '  ' + line : l));
      } },
    { id: 'perpetual', title: 'The perpetual Q', caption: 'the status glyph carries state in colour alone, one fixed shape: resting breathes, working flows sky to violet to teal, waiting pulses amber, failing flashes red', ms: PERP_MS * 4,
      frame: (t, o) => {
        const i = Math.min(3, Math.floor(t / PERP_MS)), st = GLYPH_STATES[i], tt = t - i * PERP_MS;
        return GLYPH_STATES.map((s, k) => {
          const g = qGlyph(s, k === i ? tt : 0, { mono: o.mono, quiet: k !== i, since: 0 });
          const word = paint(STATE_WORD[s], k === i ? STATE_RGB[s] : DIM, o.mono);
          const tag = W >= 70 ? '   ' + paint(STATE_TAG[s], k === i ? MUTED : DIM, o.mono) : '';
          return (k === i ? '› ' : '  ') + glyphAnsi(g) + ' ' + word + tag;
        }).concat(['', '  ' + paint(`now: ${st}`, MUTED, o.mono)]);
      } },
    { id: 'ring', title: 'The composer ring', caption: 'the two composer rules become one light ring while Quox works; amber while it waits for you', ms: RING_MS,
      frame: (t, o) => ringLines(Math.min(W - 2, 72), ringState(t), o.mono) },
    { id: 'fx', title: 'Reveal effects', caption: 'tool row, answer drop-in, approval arming, receipt seal, ProofFlow, closing line', ms: FX_MS,
      frame: (t, o) => fxLines(t, Math.min(W - 2, 78), o.mono) },
    { id: 'dragon', title: CLIPS.pick.title, caption: CLIPS.pick.caption, ms: CLIPS.pick.dur, frame: (t, o) => dragon('pick', t, o) },
    { id: 'dragon-fire', title: CLIPS.fire.title, caption: CLIPS.fire.caption, ms: CLIPS.fire.dur, frame: (t, o) => dragon('fire', t, o) },
    { id: 'dragon-moods', title: 'Dragon moods', caption: 'at the cinematic motion level the dragon reacts: wide eyes and an amber glint while it waits for you, a wink when done, a puff of smoke on failure, and a greeting on launch',
      ms: MOOD_SPAN.reduce((a, b) => a + b, 0),
      frame: (t, o) => {
        let i = 0, s0 = 0;
        while (i < MOOD_CLIPS.length - 1 && t >= s0 + MOOD_SPAN[i]) s0 += MOOD_SPAN[i++];
        const m = MOOD_CLIPS[i];
        return [...art(clipCells(m, t - s0, { cols: Math.min(W, 64), theme, mono: o.mono })), '', paint(fit(`${m}: ${CLIPS[m].caption.split(':')[1].replace(/\s*\(.*\)$/, '').trim()}`), MUTED, o.mono)];
      } },
  ];
}
export const SCENE_IDS = ['orbit', 'portal', 'particle', 'hello', 'perpetual', 'ring', 'fx', 'dragon', 'dragon-fire', 'dragon-moods'];

// ---- runner (the only impure part) ---------------------------------------------------------------------------
const visible = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');  // eslint-disable-line no-control-regex
const width = (s) => [...visible(s)].length;

/** One full screen for a scene frame: title + caption on top, the frame centred under it. */
export function screenFor(scene, t, { cols, mono, index, total }) {
  const lines = scene.frame(t, { mono });
  const head = paint(`[${index + 1}/${total}] ${scene.title}`, SKY, mono);
  const cap = wrap(scene.caption, Math.max(20, cols - 2)).map((l) => paint(l, MUTED, mono));
  const w = Math.max(0, ...lines.map(width));
  const left = ' '.repeat(Math.max(0, Math.floor((cols - w) / 2)));
  return [head, ...cap, '', ...lines.map((l) => left + l)];
}
function wrap(s, n) { const o = []; let l = ''; for (const w of s.split(' ')) { if ((l + ' ' + w).trim().length > n) { o.push(l); l = w; } else l = (l + ' ' + w).trim(); } if (l) o.push(l); return o; }

export async function runGallery({ out = process.stdout, env = process.env, only = [], narrow = false, slow = false, mono: monoFlag = false } = {}) {
  const cols = narrow ? 40 : Math.max(40, out.columns || 100), rows = out.rows || 30;
  const mono = monoFlag || Boolean(env.NO_COLOR) || env.TERM === 'dumb';
  const still = env.QUOX_REDUCED_MOTION === '1' || !out.isTTY;
  const all = galleryScenes({ cols, rows, narrow });
  const bad = only.filter((n) => !SCENE_IDS.includes(n));
  if (bad.length) throw new Error(`unknown motion: ${bad.join(', ')} (one of ${SCENE_IDS.join(', ')})`);
  const scenes = only.length ? all.filter((s) => only.includes(s.id)) : all;
  if (still) {
    // Reduced motion or piped: every scene's settled frame, printed once.
    scenes.forEach((s, i) => out.write(screenFor(s, s.ms, { cols, mono, index: i, total: scenes.length }).join('\n') + '\n\n'));
    return;
  }
  const SLOW = slow ? 3 : 1;
  let restored = false;
  const restore = () => { if (!restored) { restored = true; out.write(RESET + '\x1b[?25h\n'); } };
  const onSig = () => { restore(); process.exit(130); };
  process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
  out.write('\x1b[?25l');
  try {
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      out.write('\x1b[2J\x1b[H');
      const t0 = performance.now();
      for (let n = 0; ; n++) {
        const t = (performance.now() - t0) / SLOW;
        const done = t >= s.ms;
        const lines = screenFor(s, done ? s.ms : t, { cols, mono, index: i, total: scenes.length });
        out.write('\x1b[?2026h\x1b[H' + lines.map((l) => l + '\x1b[K').join('\n') + '\x1b[J\x1b[?2026l');
        if (done) break;
        const wait = t0 + (n + 1) * (1000 / 30) - performance.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      await new Promise((r) => setTimeout(r, 700 * SLOW));
    }
  } finally {
    process.off('SIGINT', onSig); process.off('SIGTERM', onSig);
    restore();
  }
}
