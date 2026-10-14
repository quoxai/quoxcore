/**
 * The Q face for the web (cli.quox.ai): the SAME pure frames the CLI draws (qart.js, qglyph.js, qhello.js),
 * rendered into <pre> elements as coloured spans. Plays Orbit & Lock, then the Q says hello (the line
 * decodes in from katakana), then idles: the mark breathes, the status Q breathes beside "Ready", and now
 * and then the dragon's googly eyes open and blink. prefers-reduced-motion: the settled frame only.
 *
 * Browser ESM, no dependencies, no build: import it next to ../qart.js, ../qglyph.js, ../qhello.js.
 *   import { mountQFace } from './qface.js';
 *   mountQFace(document.getElementById('face'), { hello: "Hi, I'm Quox!" });
 */
import { introPlan, restCellsAt, INTRO_MS } from '../qart.js';
import { eggCells, EGG_MS } from '../qdragonScenes.js';
import { qGlyph } from '../qglyph.js';
import { helloCells, helloGradient, helloMs } from '../qhello.js';

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** One row of cells -> HTML spans, merging runs of the same colour. */
export function rowToHTML(row) {
  let html = '', run = '', key = null;
  const flush = () => { if (!run) return; html += key ? `<span style="${key}">${esc(run)}</span>` : esc(run); run = ''; };
  for (const c of row) {
    const parts = [c.rgb ? `color:rgb(${c.rgb.join(',')})` : null, c.bg ? `background-color:rgb(${c.bg.join(',')})` : null, c.bold ? 'font-weight:700' : null].filter(Boolean);
    const k = parts.length ? parts.join(';') : null; // bg: the dragon's quadrant-block eyes (solid whites, dark pupil)
    if (k !== key) { flush(); key = k; }
    run += c.ch;
  }
  flush();
  return html;
}
// Blank cells in Braille art are drawn as U+2800 (the empty Braille pattern), not a space: a browser can
// give a space and a Braille glyph different advances (font fallback), which shears the Q row by row.
const BLANK = '\u2800';
export const cellsToHTML = (rows) => rows.map((r) => rowToHTML(r.map((c) => (c.ch === ' ' ? { ...c, ch: BLANK } : c)))).join('\n');

/** Which Q size fits a container of `px` CSS pixels at a monospace advance of `cw` px. */
export function sizeForWidth(px, cw = 8.4) {
  const cols = Math.floor(px / cw);
  return cols >= 34 ? 'large' : cols >= 22 ? 'mid' : 'small';
}

/**
 * Timeline state at t ms (pure): which picture, the hello progress, and whether the eye is open.
 * eyeAt: list of start times (ms) for idle eye blinks.
 */
export function faceFrame(t, { size, hello, eyeAt = [], color = true }) {
  const plan = introPlan(size, { color, quant: false });
  const hT = t - INTRO_MS, settledAt = INTRO_MS + helloMs(hello);
  let q;
  const eye = eyeAt.find((s) => t >= s && t < s + EGG_MS + 400);
  if (t < INTRO_MS) q = plan.at(t);
  else if (eye != null) q = eggCells(size, t - eye, { color });
  else q = restCellsAt(size, Math.max(0, t - settledAt), { color, quant: false });
  const line = helloCells(hello, hT, { fg: helloGradient(hello), mono: !color });
  const glyph = qGlyph('resting', Math.max(0, t - settledAt), { mono: !color });
  return { q, line, glyph, showStatus: t >= settledAt };
}

export function mountQFace(root, { hello = "Hi, I'm Quox!", status = 'Ready', seed = 7, reduced = null, eyeEveryMs = [9000, 16000] } = {}) {
  const doc = root.ownerDocument, win = doc.defaultView;
  root.classList.add('qface');
  root.innerHTML = '<pre class="qface-q" aria-hidden="true"></pre><div class="qface-side"><pre class="qface-hello"></pre><pre class="qface-status"></pre></div>';
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', `The Quox Q says: ${hello}`);
  const [qEl, hEl, sEl] = ['.qface-q', '.qface-hello', '.qface-status'].map((s) => root.querySelector(s));
  const still = reduced ?? Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  let r = seed; const rand = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
  const eyeAt = [];
  let next = INTRO_MS + helloMs(hello) + 2500; // the first blink comes soon after hello, then rarely
  for (let i = 0; i < 40; i++) { eyeAt.push(next); next += EGG_MS + eyeEveryMs[0] + rand() * (eyeEveryMs[1] - eyeEveryMs[0]); }
  const size = () => sizeForWidth(Math.min(root.clientWidth || 600, win.innerWidth || 600) * (root.clientWidth > 520 ? 0.55 : 1));
  const draw = (t) => {
    const f = faceFrame(t, { size: size(), hello, eyeAt });
    qEl.innerHTML = cellsToHTML(f.q);
    hEl.innerHTML = rowToHTML(f.line);
    sEl.innerHTML = f.showStatus ? `${rowToHTML(f.glyph.cells)} <span class="qface-word">${esc(status)}</span>` : '&nbsp;';
  };
  if (still) { draw(INTRO_MS + helloMs(hello) + 10); return { stop() {}, pause() {}, resume() {}, seek: draw }; }
  // pause()/resume() keep the animation's own clock: time spent paused (offscreen, hidden tab) is not skipped.
  let raf = 0, t0 = null, stopped = false, paused = false, pausedAt = null, last = 0;
  const tick = (now) => { if (stopped || paused) return; t0 ??= now; last = now - t0; draw(last); raf = win.requestAnimationFrame(tick); };
  raf = win.requestAnimationFrame(tick);
  return {
    stop() { stopped = true; win.cancelAnimationFrame(raf); },
    pause() { if (paused || stopped) return; paused = true; pausedAt = last; win.cancelAnimationFrame(raf); },
    resume() { if (!paused || stopped) return; paused = false; t0 = null; const base = pausedAt; raf = win.requestAnimationFrame((now) => { t0 = now - base; tick(now); }); },
    seek: draw,
  };
}
