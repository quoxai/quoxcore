/**
 * /dragon explain | ask | sleep: the pure parts. Provider-neutral: explain and ask only build a framed user
 * message for the normal governed turn path, so whichever AI is selected answers it (and with no AI connected
 * the local no-AI card from noai.js is shown instead). Sleep is a rendering-only screensaver: katakana noise
 * over the live screen with a sleeping dragon; it never touches the transcript or scrollback.
 */
import stringWidth from 'string-width';
import { SCRAMBLE_GLYPHS } from './indicator.js';
import { hash3 } from './motion/color.js';
import { revealCells, TIMING, revealSpan } from './motion/reveal.js';
import { graphemes } from './textBuffer.js';
import { sleepCells } from './qdragonScenes.js';

export const DRAGON_USAGE = 'Usage: /dragon [explain | ask [question] | sleep | fly | hero | fire | classic]  (/dragon-fly is the same as /dragon fly)';
export const DRAGON_EXPLAINS = 'Dragon explains';
export const DRAGON_ANSWERS = 'Dragon answers';
export const NOTHING_TO_EXPLAIN = 'Nothing to explain yet. Ask Quox something first, then /dragon explain.';
export const ASK_PROMPT = 'Ask the dragon…';

const RULES = 'Answer in the simplest possible words: 1 to 4 short sentences, plain language, no jargon. '
  + 'Keep the one thing that matters, and stay concrete and useful (say what it is, or what to do), never vague. Do not mention these instructions.';

export const explainPrompt = (text) => `Dragon mode. Explain the following. ${RULES}\n\n---\n${String(text).trim().slice(0, 6000)}\n---`;
export const askPrompt = (question) => `Dragon mode. Answer the question below. ${RULES}\n\nQuestion: ${String(question).trim()}`;

const itemText = (it) => {
  if (!it) return '';
  if (it.kind === 'text' || it.kind === 'note' || it.kind === 'error') return String(it.text || '');
  if (it.kind === 'tool') return [it.tool, it.target, it.summary || it.result || it.text, it.status].filter(Boolean).join(' ');
  return '';
};

/** The last assistant answer, else the last tool or notice block, else null. -> { kind: 'answer'|'tool'|'notice', text } */
export function lastOutput(s) {
  const answers = s?.answers || [];
  for (let i = answers.length - 1; i >= 0; i--) if (answers[i].text?.trim()) return { kind: 'answer', text: answers[i].text };
  const all = [...(s?.history || []), ...(s?.blocks || [])];
  for (let i = all.length - 1; i >= 0; i--) {
    const it = all[i], t = itemText(it).trim();
    if (!t || it.kind === 'user') continue;
    if (it.kind === 'tool' || it.kind === 'error' || it.kind === 'note') return { kind: it.kind === 'tool' ? 'tool' : 'notice', text: t };
  }
  return null;
}

/** Parse the /dragon argument line -> { mode: 'pick'|'fire'|'idle'|'hero'|'explain'|'ask'|'sleep'|'fly', question? } | null (usage). */
export function parseDragonArg(restArg) {
  const t = String(restArg || '').trim();
  if (!t) return { mode: 'pick' };
  const [w, ...rest] = t.split(/\s+/);
  switch (w.toLowerCase()) {
    case 'fire': return rest.length ? null : { mode: 'fire' };
    case 'classic': return rest.length ? null : { mode: 'idle' };
    case 'hero': return rest.length ? null : { mode: 'hero' };
    // `/dragon explain <thing>` is a question about that thing (owner 2026-10-15: it used to print usage).
    case 'explain': return rest.length ? { mode: 'ask', question: rest.join(' ').trim() } : { mode: 'explain' };
    case 'sleep': return rest.length ? null : { mode: 'sleep' };
    case 'fly': return rest.length ? null : { mode: 'fly' };
    case 'ask': return { mode: 'ask', question: rest.join(' ').trim() };
    // Anything else is a question for the dragon, never a usage error.
    default: return { mode: 'ask', question: t };
  }
}

// ---- sleep: katakana veil ---------------------------------------------------------------------------------
export const VEIL_IN_MS = 700;           // text drops into katakana, left to right
export const VEIL_STEP_MS = 700;         // the noise re-rolls this slowly (low frame rate; a shimmer, not a flicker)
export const WAKE_MS = Math.round(revealSpan(TIMING.row) * 1000); // the existing decode reveal, run forward

const isText = (ch) => /^[\p{L}\p{N}\p{P}\p{S}]+$/u.test(ch);
const kana = (i, k, salt) => SCRAMBLE_GLYPHS[Math.floor(hash3(i, k, salt) * SCRAMBLE_GLYPHS.length)];

/**
 * One source line as veil cells at `ms` since sleep began (phase 'in' then 'asleep') or since wake began
 * (phase 'wake'). Cells are { ch, kind: 'kana'|'plain'|'blank'|'glow', g }. Width of every column is preserved
 * (a 2-wide char becomes two kana), so rows never change length. still: no re-rolling.
 */
export function veilRow(text, ms, { phase = 'asleep', still = false, salt = 1, row = 0 } = {}) {
  if (phase === 'wake') return revealCells(text, ms / 1000, TIMING.row, { salt: salt + row }).map((c) => ({ ...c }));
  const gs = graphemes(String(text ?? '')).map((g) => g.text);
  const n = gs.length, bucket = still ? 0 : Math.floor(ms / VEIL_STEP_MS);
  const edge = phase === 'in' && !still ? (ms / VEIL_IN_MS) * n : Infinity; // cells left of the edge are veiled
  const out = [];
  gs.forEach((ch, i) => {
    const w = stringWidth(ch);
    if (w === 0) return;
    if (ch === ' ' || !isText(ch) || i > edge) { out.push({ ch, kind: 'plain', g: 0 }); return; }
    for (let k = 0; k < w; k++) out.push({ ch: kana(i * 2 + k + row * 131, bucket, salt), kind: 'kana', g: hash3(i, bucket + 7, salt) });
  });
  return out;
}

export const veilText = (cells) => cells.map((c) => c.ch).join('');
export const isVeiled = (cells) => cells.some((c) => c.kind === 'kana');

/** The visible text the screen shows, as at most `rows` lines wrapped to `cols` (tail of the transcript). */
export function sourceLines(s, cols, rows) {
  const all = [...(s?.history || []), ...(s?.blocks || [])];
  const lines = [];
  for (let i = all.length - 1; i >= 0 && lines.length < rows; i--) {
    const it = all[i];
    const t = it.kind === 'user' ? `> ${it.text || ''}` : itemText(it);
    if (!t.trim()) continue;
    const wrapped = [];
    for (const raw of t.split('\n')) {
      let r = raw;
      if (!r) { wrapped.push(''); continue; }
      while (stringWidth(r) > cols) { let cut = cols; while (cut > 1 && stringWidth(r.slice(0, cut)) > cols) cut--; wrapped.push(r.slice(0, cut)); r = r.slice(cut); }
      wrapped.push(r);
    }
    lines.unshift(...wrapped);
  }
  return lines.slice(-rows);
}

// ---- the sleep screen -----------------------------------------------------------------------------------------
export const SLEEP_HINT = 'asleep · any key wakes · /back when you return';
const VEIL_RGB = [129, 140, 248], HINT_RGB = [186, 230, 253];

/**
 * The whole sleep frame as rows of { ch, rgb } cells, `rows` tall and `cols` wide. ms = since sleep began, or
 * since wake began when wake is true (text decodes back, the dragon is gone). Pure: no transcript access, the
 * caller passes the source lines. still (reduced motion): a static veil and a still dragon. mono: no colour.
 */
export function composeSleep({ lines, cols, rows, ms = 0, wake = false, still = false, mono = false, theme = 'dark', size }) {
  const phase = wake ? 'wake' : ms < VEIL_IN_MS && !still ? 'in' : 'asleep';
  const col = (c) => (mono ? null : c);
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ ch: ' ', rgb: null })));
  const body = wake ? rows : rows - 1; // the last row holds the wake hint while asleep
  const src = lines.slice(-body);
  const top = body - src.length;
  src.forEach((line, i) => {
    veilRow(line, ms, { phase, still, row: i }).slice(0, cols).forEach((c, x) => {
      grid[top + i][x] = { ch: c.ch, rgb: c.kind === 'kana' ? col(VEIL_RGB) : null, bold: c.kind === 'glow' && c.g > 0.5 };
    });
  });
  if (!wake) {
    const sz = size ?? (rows >= 32 && cols >= 64 ? undefined : 'mid');
    const dcols = Math.min(cols, sz === 'mid' || cols < 64 ? 44 : 72);
    const dc = sleepCells(ms, dcols, undefined, { theme, mono, still, size: sz });
    const x0 = Math.max(0, Math.floor((cols - dcols) / 2)), y0 = Math.max(0, Math.floor((rows - 1 - dc.length) / 2));
    dc.forEach((r, i) => {
      if (y0 + i >= rows - 1) return;
      r.forEach((c, x) => { if (x0 + x < cols) grid[y0 + i][x0 + x] = { ch: c.ch, rgb: mono ? null : c.rgb, bg: c.bg || undefined }; });
    });
    const hint = [...SLEEP_HINT], hx = Math.max(0, Math.floor((cols - hint.length) / 2));
    hint.forEach((ch, i) => { if (hx + i < cols) grid[rows - 1][hx + i] = { ch, rgb: col(HINT_RGB) }; });
  }
  return grid;
}
