/**
 * QUOXON view layer (Ink 6, React.createElement). Width-aware everywhere,
 * horizontal rules only (no side borders), semantic colour, mono-safe.
 */
import React from 'react';
import chalk from 'chalk';
import { Box, Text, useStdout } from 'ink';
import stringWidth from 'string-width';
import { graphemes, lineCol, selection, composerFrom } from './textBuffer.js';

const h = React.createElement;
/** Coloured runs (from theme.paintLine/paintRuns) as Text children; the characters are unchanged. */
const runs = (rs) => rs.map((r, i) => (r.role ? h(Text, { key: i, color: c(r.role) }, r.text) : r.text));

import { COLORS, MODE_COLOR, MIN_COLS, mono, c, clampCols, clip, paintLine, paintRuns, agentColor, proto, toneText, stripMarks, providerOf, providerColor } from './theme.js';
import { reducedMotion, motionAllowed } from './motion/clock.js';
import { ruleColors, ringStep, ringMode } from './motion/ring.js';
import { useFrame } from './motion/frame.js';
import { rgbStr, hexRgb, mix, clamp01, mixOk, pulse01 } from './motion/color.js';
import { revealCells, TIMING } from './motion/reveal.js';
import { handoffFrame } from './motion/level.js';
import { dividerRuleEl } from './dividerRule.js';
import * as themeNs from './theme.js';
import { qArt, qArtFrame } from '../core/banner.js';
import { cmd } from './palette.js';
import { themeRole, rowParts, clipParts, labelWidth } from './rows.js';
import { Markdown, wrapCell, markdownRows, wrapRows, WText, Heading } from './markdown.js';
import { parseAsk, keysLabel, askText } from './ask.js';
import { parseAsideNote } from './asideView.js';
import { formatSlotBody, inlineable, codeRows } from './slotFormat.js';
import { termRows } from './term.js';
import { cellWidth, ambiguousWide } from './cells.js';
import { welcomeModel } from './welcome.js';
import { Q_GLYPH, qColor, stateWord, indicatorState, fmtTokens, wordFrame, wordColor } from './indicator.js';

import { qSize, qDims, orbitFrame, qLines, labSize, introPlan, qCells, cellsToAnsi, INTRO_MS } from './qart.js';
import { glyphStill, glyphMode, colorDepth } from './qglyph.js';
export { INTRO_MS };
import { QGlyph, cellNodes } from './qmotion.js';
import { CLIPS as DRAGON_CLIPS, clipCells } from './qdragonScenes.js';
import { dragonLayout } from './qdragon.js';
import { ObjectView } from './objects/view.js';
import { aoclLineSegs, aoclTableLines } from './aocl.js';
export { COLORS, MODE_COLOR, MIN_COLS, clampCols, clip, reducedMotion };

// ---- working indicator (the one animated line) -------------------------------------------------
export const KANA = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
export const RAIN = 4;
const G0 = [56, 189, 248], G1 = [168, 85, 247];

/** Pure frame: array of { ch, rgb, bold } for tick t. rand is injectable for tests. */
export function rainFrame(t, rand = Math.random) {
  return Array.from({ length: RAIN }, (_, i) => {
    const ch = KANA[Math.floor(rand() * KANA.length)];
    const k = ((t + i * 3) % 16) / 15;
    const m = k < 0.5 ? k * 2 : 2 - k * 2;
    return { ch, rgb: G0.map((v, j) => Math.round(v + (G1[j] - v) * m)), bold: i === RAIN - 1 };
  });
}
export const STATIC_RAIN = 'ｸｵｯｸ'.slice(0, RAIN);

export function describeActivity(state) {
  const running = state.blocks.filter(b => b.kind === 'tool' && b.status === 'running');
  if (state.approvals.length) return 'Waiting for approval';
  if (running.length) { const r = running[running.length - 1]; return r.agentName ? `Delegating to ${r.agentName}` : `Running ${r.tool}`; }
  if (state.turn?.status === 'interrupting') return 'Stopping';
  return state.turn?.stage || 'Working';
}

/**
 * The one animated status line. It owns no timer: the app's motion clock re-renders it (frames while motion
 * is on, once a second otherwise) and passes `now`. `motion` false = static word and colour (reduced motion);
 * colour is separately off under NO_COLOR.
 */
export const Working = ({ activity, since, interrupting, escLabel, state, failing = false, tokens = 0, act = null, now: nowProp, motion = !reducedMotion(), handoff = false }) => {
  const now = useFrame(nowProp);
  const quiet = !motion;
  const t = Math.floor(now / 120); // the indicator's colour periods are in 120 ms ticks
  const st = state || (act?.tone === 'wait' ? 'waiting' : indicatorState(act ? act.word : activity, failing));
  // A new word decodes in over DECODE_MS; remember when the current word first appeared.
  const wordKey = act ? act.word : null;
  const seenRef = React.useRef({ key: wordKey, at: Date.now() });
  if (seenRef.current.key !== wordKey) seenRef.current = { key: wordKey, at: now };
  const flashing = Boolean(act?.flash) && now - act.flash < 800;
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  const q = h(QGlyph, { key: 'q', state: flashing ? 'failing' : st, ms: now, since: act?.flash ?? null, quiet }); // the perpetual Q (qglyph.js), driven by the shared clock
  // The word is ALL colour: one gradient sweeps across it (sky/violet/teal thinking, green writing, amber
  // waiting, red failed). While working it rains through itself (indicator.wordFrame): each letter on its own
  // clock, ~30% scrambled at a time, cascades of 2..4 half-width katakana resolving with a flash. Reduced
  // motion: a still, coloured, plain word. NO_COLOR: the motion stays, the colour goes. Elapsed, tokens and
  // hints are never scrambled.
  // Silent wait (FW1): after 3 s on one activity with no answer text, say what it is waiting on, live.
  const actSecs = act ? Math.max(0, Math.floor((now - act.since) / 1000)) : 0;
  const longWait = Boolean(act) && st === 'working' && actSecs >= 3 && act.word !== 'Writing';
  const waitTool = longWait && act.tool ? act.tool : null;
  const stale = longWait && !act.tool && (act.word === 'Sending' || act.word === 'Routing');
  const plain = clip(stateWord(st, stale ? 'Thinking' : (act ? act.word : activity)), 40);
  const scramble = st === 'working' && !quiet;
  const cst = st === 'working' && (act ? act.word : activity) === 'Writing' ? 'writing' : st;
  const cells = scramble ? wordFrame(plain, now, { since: seenRef.current.at }) : [...plain].map(ch => ({ ch, glyph: false, flash: false }));
  const n = cells.length;
  const wordNodes = cells.map((g, i) => h(Text, {
    key: i, bold: g.flash,
    color: mono() ? undefined : `rgb(${wordColor(cst, i, n, now, g.flash ? 'flash' : g.glyph ? 'glyph' : 'letter', quiet).join(',')})`
  }, g.ch));
  const ell = st === 'failing' ? null : h(Text, { key: 'e', color: mono() ? undefined : `rgb(${wordColor(cst, n, n + 1, now, 'letter', quiet).join(',')})` }, '…');
  const detail = waitTool ? clip(`waiting on ${waitTool}`, 40) : (act?.detail && st !== 'failing' ? clip(act.detail, 28) : '');
  // Expressive: while delegating, a dot travels from Quox to the agent it is handing to (motion/level.js).
  const delegating = handoff && !quiet && st === 'working' && (act ? act.word : activity) === 'Delegating';
  const track = delegating ? h(Text, { key: 'ho' }, ' ', ...handoffFrame(now, 5, { mono: mono() }).map((cl, i) => h(Text, { key: i, color: cl.rgb ? rgbStr(cl.rgb) : undefined }, cl.ch))) : null;
  const word = h(Text, { wrap: 'truncate-end' }, h(Text, null, ...wordNodes, ell), track,
    detail ? h(Text, { color: c('dim') }, ` ${delegating ? '' : '· '}${detail}`) : '');
  const { stdout: so } = useStdout();
  const narrow = (so?.columns || 100) < 60; // keep the line on one row: short hint, tokens still shown
  const tok = tokens > 0 ? ` · ↓ ${fmtTokens(tokens)} tokens` : '';
  const sep = st === 'failing' ? '' : (detail ? ' · ' : ' '); // the separator lives in the tail so a squeezed word never swallows it
  const tail = st === 'failing' ? '' : `${sep}${waitTool ? actSecs : secs}s${tok} · ${interrupting ? 'stopping; waiting for the server to confirm' : (narrow ? 'Esc' : (escLabel || 'Esc to stop'))}`;
  return h(Box, { paddingLeft: 2 }, q, h(Text, null, ' '), word, h(Text, { color: c('dim'), wrap: 'truncate-end' }, tail));
};

// ---- drop-in reveals (motion/reveal.js) ------------------------------------------------------------
const KANA_RGB = [hexRgb('#38bdf8'), [58, 66, 82]];
const GLOW_RGB = [110, 231, 183];
/**
 * Render segments [{ t, color, bold }] as Text nodes. With `fx` = { e, timing } (seconds since the item
 * landed) the whole row decodes in along one edge; without it the output is exactly the plain segments.
 */
export function fxNodes(segs, fx, salt = 1) {
  const live = segs.filter(x => x && x.t);
  if (!fx || fx.e == null) return live.map((x, i) => h(Text, { key: i, color: x.color ? c(x.color) : undefined, bold: x.bold }, x.t));
  const total = live.reduce((n, x) => n + graphemes(x.t).length, 0);
  const runs = [];
  let offset = 0;
  for (const x of live) {
    const resolved = x.color ? c(x.color) : undefined;
    const base = typeof resolved === 'string' && /^#[0-9a-f]{6}$/i.test(resolved) ? hexRgb(resolved) : null; // palette role, hex or ansi256
    for (const cell of revealCells(x.t, fx.e, fx.timing, { offset, total, salt })) {
      let color, bold = false;
      if (cell.kind === 'kana') color = mono() ? undefined : rgbStr(mix(KANA_RGB[1], KANA_RGB[0], 0.35 + 0.65 * cell.g));
      else if (cell.kind === 'glow') { color = base ? rgbStr(mix(base, GLOW_RGB, 0.5 * cell.g)) : undefined; bold = cell.bold || Boolean(x.bold); }
      else if (cell.kind === 'plain') { color = x.color ? c(x.color) : undefined; bold = Boolean(x.bold); }
      const last = runs[runs.length - 1];
      if (last && last.color === color && last.bold === bold) last.t += cell.ch; else runs.push({ t: cell.ch, color, bold });
    }
    offset += graphemes(x.t).length;
  }
  return runs.map((r, i) => h(Text, { key: i, color: r.color, bold: r.bold }, r.t));
}

// ---- rows ------------------------------------------------------------------------------------
const STATUS_GLYPH = { running: '◐', ok: '✔', failed: '✖', denied: '⊘', effect_unknown: '⚠', unknown: '?' };
const STATUS_TONE = { running: 'sky', ok: 'ok', failed: 'fail', denied: 'warn', effect_unknown: 'warn', unknown: 'dim' };
const PROTO = { aee: ['⛓', 'AEE'], aocl: ['▤', 'AOCL'], volt: ['▣', 'VOLT'], ward: ['◉', 'WARD'] };

export const fmtDuration = (ms) => (ms == null ? '' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

export const Row = ({ glyph, tone, name, body, tail, cols }) => {
  const nameW = cols >= 70 ? 14 : 10;
  const used = 2 + 2 + nameW + 3;
  const room = Math.max(8, cols - used);
  const tailStr = tail ? clip(tail, Math.max(8, Math.floor(room / 2))) : '';
  const bodyStr = clip(body, Math.max(4, room - (tailStr ? [...tailStr].length + 3 : 0)));
  return h(Box, null,
    h(Text, null, '  '), h(Text, { color: c(tone) }, glyph), h(Text, null, ' '),
    h(Text, { bold: true, color: c('text') }, clip(name, nameW - 1).padEnd(nameW - 1)), h(Text, { color: c('dim') }, ' │ '),
    h(Text, { color: c('text') }, bodyStr),
    tailStr ? h(Text, { color: c('dim') }, ' │ ') : null,
    tailStr ? h(Text, { color: c(tone) }, tailStr) : null);
};

// Tool ids are `<family>_<verb words>`. The family is the short label in the QuoxGlyph grammar
// (`✔ SEO │ summary │ 30 crawls · 2.4s`), never the whole id upper-cased.
const FAMILY = { quoxseo: 'SEO', quoxplan: 'PLAN', quoxsignal: 'SIGNAL', quoxflow: 'FLOW', lucid: 'LUCID', fleet: 'FLEET', memory: 'MEMORY', bastion: 'BASTION' };
export function toolLabel(id) {
  const t = String(id || 'tool');
  const i = t.indexOf('_');
  const pre = (i > 0 ? t.slice(0, i) : t).toLowerCase();
  const verb = i > 0 ? t.slice(i + 1).replace(/_+/g, ' ').trim() : '';
  const family = FAMILY[pre] || (pre.startsWith('quox') && pre.length > 4 ? pre.slice(4) : pre).toUpperCase();
  return { family, verb: verb || t };
}

const gw = (s) => graphemes(s).length;
/** Clip free text at a word or comma boundary; a single over-long token becomes just the ellipsis. */
function clipWords(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (gw(t) <= max) return t;
  if (max < 2) return '';
  const gs = graphemes(t).slice(0, max - 1).map(g => g.text).join('');
  const nextIsBreak = /[\s,]/.test(graphemes(t)[max - 1]?.text || '');
  const cut = nextIsBreak ? gs : gs.replace(/[^\s,]*$/, '');
  const kept = cut.replace(/[\s,]+$/, '');
  return kept ? kept + '…' : '…';
}

/**
 * A server result_summary fitted to `max` columns. `key: value, key: value` summaries read as
 * `value key` (numbers) or `key: value`; `k_total` supersedes `k` (k is the page, the total is the truth);
 * whole pairs are dropped from the end to fit (all of them when none fits), never cut mid-token.
 * Other text clips at a word boundary.
 */
export function fitResult(summary, max) {
  const raw = String(summary ?? '').replace(/\s+/g, ' ').trim();
  const parts = raw.split(/,\s*/);
  const pairs = parts.map(p => p.match(/^([A-Za-z_][\w ]*?):\s*(.+)$/));
  if (!raw || !pairs.every(Boolean)) return clipWords(raw, max);
  const map = new Map(pairs.map(m => [m[1].trim(), m[2].trim()]));
  const items = [];
  for (const [k, v] of map) {
    if (map.has(`${k}_total`)) continue;
    const key = k.replace(/_total$/, '').replace(/_+/g, ' ');
    items.push(/^-?\d+(\.\d+)?$/.test(v) ? `${v} ${key}` : `${key}: ${v}`);
  }
  for (let n = items.length; n > 0; n--) {
    const joined = items.slice(0, n).join(', ');
    if (gw(joined) <= max) return joined;
  }
  return ''; // not even one whole pair fits: show none rather than a value without its key
}

/**
 * The ignition glow's colour (expressive motion): `hex` flared by g 0..1. Dark terminals flare towards a warm
 * white, light ones towards amber (white would vanish on a light background). g 0 returns hex untouched.
 */
export function igniteColor(col, g, light = themeNs.isLight()) {
  const rgb = Array.isArray(col) ? col : typeof col === 'string' && /^#[0-9a-f]{6}$/i.test(col) ? hexRgb(col) : null;
  if (!(g > 0) || !rgb) return Array.isArray(col) ? rgbStr(col) : col;
  return rgbStr(mix(rgb, light ? [217, 119, 6] : [255, 244, 214], Math.min(1, g) * (light ? 0.7 : 0.85)));
}

/** Pure: the delegation row text. body while running names the target and the task; the result names the outcome. */
export function delegationText(b) {
  const who = b.agentName;
  const body = b.status === 'running' ? `Delegating to ${who}${b.taskGist ? ` \u00b7 ${b.taskGist}` : ''}` : `${who}${b.taskGist ? ` \u00b7 ${b.taskGist}` : ''}`;
  if (b.status === 'running') return { body, result: '', warn: false };
  if (b.status === 'ok' && Number.isFinite(b.toolsUsed)) {
    return b.toolsUsed === 0
      ? { body, result: `${who} did nothing (0 tools)`, warn: true }
      : { body, result: `${who} finished \u00b7 used ${b.toolsUsed} tool${b.toolsUsed === 1 ? '' : 's'}`, warn: false };
  }
  return { body, result: '', warn: false };
}

export function ToolRow({ b, cols, fx = null, pulse = null, ignite = 0 }) {
  const glyph = STATUS_GLYPH[b.status] || '◐';
  const tone = STATUS_TONE[b.status] || 'sky';
  const dur = fmtDuration(b.durationMs);
  const { family, verb } = toolLabel(b.tool);
  const name = clip(family, 10);
  // QUOXON-FW3: a delegation names WHO ran it, what it was for, and whether it did anything.
  const deleg = b.agentName ? delegationText(b) : null;
  const body0 = deleg ? deleg.body : b.summary && b.summary !== b.tool ? b.summary : verb;
  const room = Math.max(4, cols - 2 - 2 - gw(name) - 3); // indent, glyph + space, family, ' │ '
  const running = b.status === 'running';
  // the facts after the result: duration, then witnessing state
  let after = [];
  if (!running && b.receipt) {
    const v = b.receipt.verified;
    after = [dur, v === true ? 'witnessed' : v === false ? 'unverified' : 'verification pending', `receipt ward:${b.receipt.ward_seq}`].filter(Boolean);
  } else if (!running) {
    after = [dur, b.envelopeId ? `envelope ${String(b.envelopeId).slice(0, 8)}` : '', b.envelopeId ? 'witnessing pending' : ''].filter(Boolean);
  }
  const result = running ? '' : deleg && deleg.result ? deleg.result : (b.resultSummary ? `${b.status === 'unknown' ? 'unknown: ' : ''}${b.resultSummary}` : b.status);
  const bodyStr = clipWords(body0, running || !result ? room : Math.max(6, Math.min(gw(body0), Math.floor(room / 2))));
  const tailRoom = room - gw(bodyStr) - 3;
  let tail = '';
  if (!running && tailRoom > 0) {
    const facts = after.join(' · ');
    const resRoom = tailRoom - (facts ? gw(facts) + 3 : 0);
    const res = resRoom >= 4 ? fitResult(result, resRoom) : '';
    tail = clipWords([res, facts].filter(Boolean).join(' · '), tailRoom);
  }
  const verified = b.receipt?.verified === true;
  const glyphColor = b.receipt && !running ? (verified ? 'ok' : 'warn') : tone;
  // Running: one glyph whose colour pulses sky <-> violet in OKLab (never a spinner of different glyphs).
  const runRgb = running && pulse != null && !mono() ? mixOk(hexRgb(COLORS.sky), hexRgb(COLORS.violet), pulse01(pulse, 1200)) : null;
  const runColor = runRgb ? rgbStr(runRgb) : null;
  const tailRuns = tail ? paintRuns(tail, deleg && deleg.warn ? 'warn' : tone === 'ok' ? 'value' : tone).map(r => (/^(witnessed)$/.test(r.text.trim()) ? { ...r, role: 'ok' } : r)) : [];
  // Expressive: the row ignites as the tool starts (a short warm flare on the glyph and the family, motion/level.js).
  const lit = running && ignite > 0 && !mono();
  const glyphC = lit ? igniteColor(runRgb || c(glyphColor) || COLORS.sky, ignite) : runColor || glyphColor;
  const head = [{ t: '  ' }, { t: glyph, color: glyphC, bold: lit && ignite > 0.5 }, { t: ' ' }, { t: name, color: lit ? igniteColor(agentColor(name), ignite * 0.7) : agentColor(name), bold: true }, { t: ' │ ', color: 'muted' }, { t: bodyStr, color: 'text' }];
  const tailSegs = tail ? [{ t: ' │ ', color: 'muted' }, ...tailRuns.map(r => ({ t: r.text, color: r.role }))] : [];
  // Settle (running -> result): the glyph flashes once and the result decodes in behind it.
  if (fx?.settle != null && !running) {
    const flash = fx.settle < 0.12 && !mono();
    if (flash) head[1] = { t: glyph, color: '#ffffff', bold: true };
    return h(Box, null, ...fxNodes(head, null), ...fxNodes(tailSegs, { e: fx.settle, timing: TIMING.settle }, 7));
  }
  return h(Box, null, ...fxNodes([...head, ...tailSegs], fx, 3));
}

/** Compact protocol detail: drop the quox.chat./quox. intent prefix and keep only the tail of long correlation ids, so the line fits instead of clipping. */
export function compactTrace(text) {
  return String(text || '')
    .replace(/\bquox\.(chat\.)?/g, '')
    .replace(/\bcorr\s+([A-Za-z0-9_-]{10,})/g, (m, id) => `corr …${id.slice(-6)}`)
    .replace(/\s+/g, ' ').trim();
}

// Protocol stage colours: the palette's proto(name) role when theme.js provides one, else these.
const PROTO_FALLBACK = { aee: '#06b6d4', aocl: '#a855f7', volt: '#f59e0b', ward: '#4ade80' };
export const protoColor = (name) => (typeof themeNs.proto === 'function' && themeNs.proto(name)) || PROTO_FALLBACK[name] || COLORS.dim;
const BG_DIM = [58, 66, 82];

/**
 * The protocol icon's colour. Icons never change glyph, only colour (owner 2026-10-12): `pulse` (clock ms) while
 * this is the active stage = a smooth OKLab pulse in the stage colour; `fx` (arrival) = brightening in, with a
 * one-frame glint for the WARD seal; otherwise the steady stage colour.
 */
function protoIconColor(protocol, { pulse = null, fx = null } = {}) {
  if (mono()) return undefined;
  const raw = protoColor(protocol);
  if (!/^#[0-9a-f]{6}$/i.test(String(raw))) return raw; // 256-colour fallback: steady, no pulse
  const col = hexRgb(raw);
  if (pulse != null) return rgbStr(mixOk(mixOk(col, BG_DIM, 0.55), mixOk(col, [255, 255, 255], 0.3), pulse01(pulse, 1200)));
  if (fx && fx.e != null && fx.e < 0.36) {
    if (protocol === 'ward' && fx.e >= 0.3) return '#ffffff';
    return rgbStr(mixOk(BG_DIM, col, clamp01(fx.e / 0.3)));
  }
  return rgbStr(col);
}

/**
 * Pure: a protocol row body wrapped into at most `max` lines of `room` cells, breaking only at spaces (a word
 * longer than a whole line is the one thing ever cut). Overflow ends the last line with " …" after a whole word.
 */
export function wrapTrace(body, room, max = 4) {
  const words = String(body || '').split(' ').filter(Boolean);
  const w = (s) => [...s].length;
  const lines = [];
  let cur = '';
  let i = 0;
  for (; i < words.length && lines.length < max; i++) {
    let word = words[i];
    if (!cur && w(word) > room) { // longer than a line: the only hard break
      while (w(word) > room && lines.length < max) { lines.push([...word].slice(0, room).join('')); word = [...word].slice(room).join(''); }
      if (lines.length >= max) { i++; break; }
      cur = word; continue;
    }
    if (!cur) { cur = word; continue; }
    if (w(cur) + 1 + w(word) <= room) { cur += ' ' + word; continue; }
    lines.push(cur); cur = '';
    i--; // place this word on the next line
  }
  if (cur && lines.length < max) lines.push(cur);
  if (i < words.length) { // more than fits: end on a whole word plus an ellipsis
    let last = lines.length ? lines[lines.length - 1] : '';
    while (last && w(last) + 2 > room) last = last.includes(' ') ? last.slice(0, last.lastIndexOf(' ')) : [...last].slice(0, Math.max(0, room - 2)).join('');
    lines[Math.max(0, lines.length - 1)] = `${last} …`;
  }
  return lines;
}

export function TraceRow({ b, cols, fx = null, pulse = null }) {
  const [g, label] = PROTO[b.protocol] || ['·', String(b.protocol || 'TRACE').toUpperCase()];
  const ref = b.ref != null ? ` · ${String(b.ref).slice(0, 8)}` : '';
  const body = compactTrace(`${b.label || ''}${b.detail ? ' · ' + b.detail : ''}`) + ref;
  const head = `  ${g} ${label.padEnd(5)}│ `;
  const afterIcon = head.slice(2 + g.length);
  const room = Math.max(10, cols - [...head].length - 1);
  // icon (colour only, never another glyph) + label in the protocol's own shade, the rest muted
  const icon = h(Text, { color: PROTO[b.protocol] ? protoIconColor(b.protocol, { pulse, fx }) : c('muted') }, g);
  const labelSeg = ' ' + label;
  const labelNode = h(Text, { color: proto(b.protocol) }, labelSeg);
  if ([...body].length <= room) {
    if (!fx) return h(Box, null, h(Text, null, '  ', icon, labelNode, h(Text, { color: c('muted') }, afterIcon.slice(labelSeg.length) + body)));
    return h(Box, null, h(Text, null, '  '), icon, ...fxNodes([{ t: labelSeg, color: 'proto:' + b.protocol }, { t: afterIcon.slice(labelSeg.length) + body, color: 'muted' }], fx, 5));
  }
  // Too long even when compacted: wrap at word boundaries onto indented lines (at most 4) rather than hiding the end.
  const pad = ' '.repeat([...head].length);
  const lines = wrapTrace(body, room, 4).map((l, i) => (i ? pad : afterIcon) + l);
  return h(Box, { flexDirection: 'column' }, ...lines.map((l, i) => (i === 0
    ? h(Text, { key: i }, '  ', icon, labelNode, h(Text, { color: c('muted') }, l.slice(labelSeg.length)))
    : h(Text, { key: i, color: c('muted') }, l))));
}

export function HelpView({ model, cols }) {
  // TUI-UX #6: the key column is sized from the usage text (capped), always followed by a two-space gutter. A usage that
  // does not fit its column goes on its own line with the description underneath, so the two never run together.
  const keyW = Math.min(24, Math.max(...model.filter(m => m.key).map(m => [...m.key].length), 8) + 2);
  return h(Box, { flexDirection: 'column', marginTop: 1, width: cols }, ...model.map((m, i) => {
    if (m.kind === 'gap') return h(Text, { key: i }, ' ');
    if (m.kind === 'head') return m.dim ? h(Text, { key: i, bold: true, color: c('muted') }, m.text) : h(Heading, { key: i, text: m.text });
    if (m.kind === 'row' || (m.kind === 'dim' && m.key)) {
      const dim = m.kind === 'dim';
      const keyRole = (r) => (r.role === 'muted' || r.role === 'key' ? r : { ...r, role: /^\s*(just type|paste|status line)\s*$/.test(m.key) ? 'label' : 'key' });
      const keyNode = (txt) => h(Text, { color: c('muted') }, ...(dim ? [txt] : runs(paintRuns(txt, 'key').map(keyRole))));
      const descNode = (txt) => h(Text, { color: c(dim ? 'muted' : 'text') }, ...(dim ? [txt] : runs(paintRuns(txt, 'text'))));
      // Both columns are wrapped here, by words, so no continuation line starts with a stray space and none collides.
      const descLines = wrapCell(m.text, Math.max(10, cols - keyW - 4));
      if ([...m.key].length + 2 <= keyW) { // usage plus a two-space gutter fits the key column
        return h(Box, { key: i, flexDirection: 'column' }, ...descLines.map((d, k) => h(Box, { key: k },
          h(Box, { width: keyW + 2, flexShrink: 0 }, k === 0 ? h(Text, null, '  ', keyNode(m.key)) : h(Text, null, ' ')),
          h(Box, { flexGrow: 1, flexShrink: 1 }, descNode(d)))));
      }
      const keyLines = wrapCell(m.key, Math.max(10, cols - 8)).map((l, k) => (k ? '    ' : '  ') + l);
      return h(Box, { key: i, flexDirection: 'column' },
        ...keyLines.map((l, k) => h(Text, { key: `k${k}` }, keyNode(l))),
        ...descLines.map((d, k) => h(Box, { key: `d${k}`, paddingLeft: keyW + 2 }, descNode(d))));
    }
    return h(Text, { key: i, color: c(m.kind === 'dim' ? 'muted' : 'text') }, ...runs(paintRuns(m.text, m.kind === 'dim' ? 'muted' : 'text')));
  }));
}

export function WelcomeView({ version, cols }) {
  const LABEL = 10;
  return h(Box, { flexDirection: 'column', marginTop: 1, width: cols },
    ...welcomeModel(version).map((m, i) => {
      switch (m.kind) {
        case 'title': return h(Heading, { key: i, text: m.text });
        case 'sub': return h(Text, { key: i, color: c('muted') }, ...runs(paintRuns(m.text, 'muted')));
        case 'rule': return h(Text, { key: i, color: c('dim') }, '─'.repeat(cols));
        case 'field': if (m.link && [...m.value].length > cols - LABEL) { // a URL is never split: stack it under its label
          return h(Box, { key: i, flexDirection: 'column' }, h(Text, { color: c('label') }, m.label), h(Text, { color: c('link'), underline: true }, m.value));
        }
        return h(Box, { key: i },
          h(Box, { width: LABEL, flexShrink: 0 }, h(Text, { color: c('label') }, m.label)),
          h(Box, { flexGrow: 1, flexShrink: 1 }, h(WText, { color: c(m.link ? 'link' : 'value'), underline: Boolean(m.link) && !mono() }, m.value)));
        case 'hint': return h(WText, { key: i, color: c('muted') }, ...runs(paintRuns(m.text, 'muted')));
        default: return h(WText, { key: i, color: c('text') }, m.text);
      }
    }));
}

export const INTRO_FRAMES = 18; // INTRO_MS (900) at 50 ms frames on the shared clock: Orbit & Lock on the lab's timing
/** Animate the intro? Only on a real terminal, never under reduced motion or QUOX_TUI_LITE. NO_COLOR animates in mono. */
export const introAnimates = (isTTY) => motionAllowed(isTTY);

/**
 * Text rows of the Q for a terminal size and progress (0..1 of the plan; 1 = settled). Lab sizing (labSize: the
 * compact particle Q under 60 cols or 12 rows) and the lab timeline (introPlan: Orbit & Lock in INTRO_MS, then
 * the dragon greeting when `dragon`). Exported so tests can assert on frames.
 */
export function introArt(cols, rows, progress = 1, color = !mono(), { dragon = false, theme = themeNs.isLight() ? 'light' : 'dark' } = {}) {
  const size = labSize(cols, rows);
  const plan = introPlan(size, { color });
  const ms = dragon ? INTRO_MS + DRAGON_CLIPS.greeting.dur + 300 : plan.ms;
  const t = progress >= 1 ? Infinity : Math.max(0, progress) * ms;
  if (dragon && t !== Infinity) {
    // Cinematic: the settled Q opens its eyes, looks at you and winks (the dragon greeting, qdragonScenes.js). The
    // dragon is drawn at the Q's OWN size (the compact dragon under 60 cols) on the Q's left edge, and the box keeps
    // the dragon's height and width for the whole sequence (Orbit & Lock frames are padded), so nothing jumps.
    const L = dragonLayout(qDims(size).cols + 6, { size, lm: 0 }), w = Math.max(qDims(size).cols, L.cols);
    if (t >= INTRO_MS) return { size, w, ms, lines: cellsToAnsi(clipCells('greeting', t - INTRO_MS, { cols: L.cols, size, lm: 0, theme, mono: !color, label: false })) };
    const q = cellsToAnsi(plan.at(Math.min(t, plan.ms)));
    return { size, w, ms, lines: [...q, ...Array.from({ length: Math.max(0, L.rows - q.length) }, () => '')] };
  }
  return { size, w: qDims(size).cols, ms, lines: cellsToAnsi(t === Infinity ? qCells(size, { color }) : plan.at(Math.min(t, plan.ms))) };
}

export const INTRO_HEAD = "Hi, I'm Quox!";
export const INTRO_LINES = ['Tell me what you want. Watch me work.', '/help for commands, or just ask me anything.'];

export function Intro({ item, cols, progress = 1, rows, dragon = false }) {
  const { stdout } = useStdout();
  const art = introArt(cols, rows ?? termRows(stdout) ?? 40, progress, !mono(), { dragon });
  // Beside the art only when the longest line fits there; otherwise the text goes under the art, left-aligned and wrapped, never clipped.
  const need = Math.max(...[INTRO_HEAD, ...INTRO_LINES, item.text].map(l => [...l].length));
  const wide = cols >= 60 && cols - 2 - art.w - 2 >= need;
  const info = h(Box, { flexDirection: 'column', justifyContent: 'center', marginLeft: wide ? 2 : 0, marginTop: wide ? 0 : 1, flexShrink: 1, ...(wide ? {} : { width: Math.max(10, cols - 4) }) },
    h(Grad, { text: INTRO_HEAD }),
    ...INTRO_LINES.map((l, k) => h(Text, { key: k, color: c('text'), wrap: 'wrap' }, l)),
    h(Text, { color: c('label'), wrap: 'wrap' }, item.text)); // version/build line: quieter (normal weight, soft brand tint), never grey
  return h(Box, { flexDirection: wide ? 'row' : 'column', marginTop: 1, marginBottom: 2, marginLeft: 2 }, h(Box, { flexDirection: 'column' }, ...art.lines.map((l, k) => h(Text, { key: k, wrap: 'truncate' }, l))), info);
}

/** Reveal timing per item kind (null = never revealed: user input, answer text, intro, help, welcome). */
export function revealTimingFor(item) {
  switch (item?.kind) {
    case 'tool': return TIMING.row;
    case 'trace': return TIMING.dim;
    case 'note': case 'summary': case 'error': return TIMING.dim;
    case 'object': return TIMING.title; // inline object cards decode in on the shared clock (objects/view.js)
    default: return null;
  }
}

// QUOXON-AOCL: ONE line per turn ("▤ AOCL 11/11 ✔ · 9 passed · 2 bypassed · 34 ms"), red naming the layer
// on a reject; with table:true, the /aocl per-layer table. White on dark, never grey (owner rule).
const AOCL_TONE = { ok: 'ok', fail: 'fail', warn: 'warn', text: 'input', error: 'fail', accent: 'sky' };
export function AoclRow({ item, cols }) {
  const icon = h(Text, { color: protoIconColor('aocl') }, '▤');
  const label = h(Text, { color: proto('aocl'), bold: true }, ' AOCL ');
  if (item.table) {
    const rows = aoclTableLines(item.sum);
    return h(Box, { paddingLeft: 2, flexDirection: 'column', width: cols }, ...rows.map(([t, tone], i) => h(Text, { key: i, color: c(AOCL_TONE[tone] || 'input') }, clip(i === 0 ? t : '  ' + t, cols - 4))));
  }
  let room = Math.max(10, cols - 10);
  const segs = [];
  for (const sg of aoclLineSegs(item.sum).segs) {
    if (room <= 0) break;
    const t = clip(sg.t, room);
    room -= [...t].length;
    segs.push(h(Text, { key: segs.length, color: c(AOCL_TONE[sg.tone] || 'input') }, t));
  }
  return h(Box, { width: cols }, h(Text, null, '  ', icon, label, ...segs));
}

/**
 * Visual rhythm, decided in ONE place (the history renderer), never per producer. Blank rows BEFORE an item given
 * the item above it (an item never carries a trailing blank, so two blanks in a row cannot happen):
 *   - a blank row between EVERY distinct block (user message, tool group, answer, notice group, AOCL footer, tip
 *     frame, bang block); tight only inside a block: a run of tool rows, a run of notices, the AOCL + Thought
 *     footer lines. A blank follows the prompt, separates the answer from the footer, and follows the footer.
 *   - items that draw their own leading blank (intro, welcome, help, object cards) add none here
 *   - under 20 terminal rows nothing is padded: only a new turn keeps its blank
 */
const SELF_SPACED = new Set(['intro', 'welcome', 'help', 'object']);
const GROUP = { tool: 'tools', trace: 'tools', note: 'notice', error: 'notice', aocl: 'footer', summary: 'footer' };
const FOOTER = new Set(['aocl', 'summary']);
export function historyGap(prev, item, rows = null) {
  if (!item || SELF_SPACED.has(item.kind)) return 0;
  if (item.kind === 'user') return 1;
  if (!prev) return item.kind === 'text' ? 1 : 0;
  if (rows != null && rows < 20) return 0;
  if (FOOTER.has(item.kind) && FOOTER.has(prev.kind)) return 0; // the AOCL line and the Thought line are one footer block
  const g = GROUP[item.kind];
  if (g && g === GROUP[prev.kind]) return 0; // a run of tool rows, or of notices, is one block
  return 1; // every other pair of distinct blocks (each tip frame is its own block)
}

export function HistoryItem({ item, cols, live = false, fx = null, pulse = null, ignite = 0, gap }) {
  if (gap !== undefined && gap > 0 && !['user', 'text'].includes(item.kind)) {
    return h(Box, { marginTop: gap, flexDirection: 'column' }, h(HistoryItem, { item, cols, live, fx, pulse, ignite, gap: 0 }));
  }
  switch (item.kind) {
    case 'intro': return h(Intro, { item, cols });
    case 'user': return h(Box, { marginTop: gap ?? 1, width: cols }, // gutter box + wrapping text box = hanging indent
      h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: c('sky'), bold: true }, item.queued ? '» ' : '› ')),
      h(Box, { flexGrow: 1, flexShrink: 1 }, h(WText, { color: c('input') }, item.text)));
    case 'welcome': return h(WelcomeView, { version: item.version, cols });
    case 'help': return h(HelpView, { model: item.model, cols });
    case 'object': return h(ObjectView, { item, cols, fx });
    case 'summary': { // the closing line wraps at its ' · ' separators: no fact (model, receipt id) is ever cut off
      const ls = noteLines(item.text, cols - 4).map(l => clip(l, cols - 4));
      const segs = (l) => paintRuns(l, 'muted').map(r => ({ t: r.text, color: r.role || 'muted' }));
      return h(Box, { paddingLeft: 2, flexDirection: 'column' }, ...ls.map((l, i) => (fx
        ? h(Text, { key: i }, ...fxNodes(segs(l), { e: fx.e - i * 0.05, timing: fx.timing }, 11 + i))
        : h(Text, { key: i, color: c('dim') }, ...runs(paintRuns(l, 'muted'))))));
    }
    case 'text': return h(Box, { marginTop: gap ?? 1, paddingLeft: 2, flexDirection: 'column' }, h(Markdown, { text: item.text, cols: cols - 2, live }));
    case 'tool': return h(ToolRow, { b: item, cols, fx, pulse, ignite });
    case 'trace': return h(TraceRow, { b: item, cols, fx, pulse });
    case 'aocl': return h(AoclRow, { item, cols });
    case 'error': return h(ErrorView, { item, cols, fx });
    case 'note': return h(NoteView, { item, cols, fx });
    case 'slotmsg': return h(SlotMsgView, { item, cols });
    case 'tip': return h(TipView, { item, cols });
    case 'whatsnew': return h(WhatsNewView, { item, cols });
    case 'bcard': return h(BroadcastCardView, { item, cols });
    case 'bang': return h(Box, { paddingLeft: 2, flexDirection: 'column', width: cols }, ...String(item.text).split('\n').map((l, i) => h(Text, { key: i, color: c('text') }, l || ' ')));
    default: return null;
  }
}

// ---- notes ---------------------------------------------------------------------------------------
const SEP = ' · ';
/** Lines of a note at `width`: one line when it fits; a ' · ' list breaks only at separators. */
export function noteLines(text, width) {
  const t = String(text ?? '');
  if (!t.includes(SEP) || t.includes('\n') || wrapRows(stripMarks(t), width) === 1) return [t];
  const lines = [];
  let cur = '';
  for (const seg of t.split(SEP)) {
    const next = cur ? cur + SEP + seg : seg;
    if (!cur || graphemes(stripMarks(next)).length <= width) cur = next;
    else { lines.push(cur); cur = seg; }
  }
  lines.push(cur);
  return lines;
}
/** A note line that is one bare URL longer than the row: never hard-wrapped (a break inside a token breaks copy and click). */
const longUrl = (l, width) => { const t = stripMarks(l); return /^https?:\/\/\S+$/.test(t) && graphemes(t).length > width; };
export const noteRows = (text, cols, tone) => noteLines(toneText(text, tone), cols - 2).reduce((n, l) => n + (longUrl(l, cols - 2) ? 1 : wrapRows(stripMarks(l), cols - 2)), 0);

/**
 * Z2H-7B3: a failure message can be several lines (what ran, what did not, the advice). Every line shows,
 * wrapped at the row width, never clipped to one: the first line leads with a red ✖, the rest indent under it.
 */
export const errorRows = (text, cols) => String(text ?? '').split('\n').reduce((n, l) => n + Math.max(1, wrapRows(stripMarks(l), Math.max(10, cols - 4))), 0);
function ErrorView({ item, cols, fx }) {
  const raw = String(item.text ?? '');
  const lines = raw.split('\n');
  const paint = (l) => paintRuns(l, 'prose').map(r => ({ t: r.text, color: r.role || 'prose' }));
  if (lines.length === 1 && wrapRows(stripMarks(raw), Math.max(10, cols - 4)) === 1) {
    const parts = [{ t: '✖ ', color: 'error' }, ...paint(raw)];
    return h(Box, { paddingLeft: 2 }, fx ? h(Text, null, ...fxNodes(parts, fx, 13)) : h(Text, null, ...parts.map((p, i) => h(Text, { key: i, color: c(p.color) }, p.t))));
  }
  return h(Box, { paddingLeft: 2, flexDirection: 'column', width: cols },
    ...lines.map((l, i) => h(Box, { key: i },
      h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: c('error') }, i === 0 ? '✖ ' : '  ')),
      h(Box, { flexGrow: 1, flexShrink: 1 }, h(WText, { color: c('prose') }, ...runs(paintRuns(l || ' ', 'prose')))))));
}

/**
 * /aside: a read-only side answer, drawn apart from the conversation: a violet ┃ bar down the left, the question
 * as its header, the answer as markdown, a quiet read-only footer. Rows: margin + header + body + footer (asideRows).
 */
function AsideView({ item, cols }) {
  const { head, body, foot } = parseAsideNote(item.text);
  const w = Math.max(10, cols - 5);
  return h(Box, { marginLeft: 2, marginTop: 1, flexDirection: 'column', width: cols - 2, borderStyle: 'bold', borderTop: false, borderRight: false, borderBottom: false, borderLeftColor: c('violet'), paddingLeft: 1 },
    h(Text, { color: c('violet'), bold: true }, clip(head, w)),
    h(Markdown, { text: body.join('\n') || '(no answer)', cols: w }),
    ...(foot ? [h(Text, { key: 'f', color: c('quiet') }, clip(foot, w))] : []));
}
export const asideRows = (text, cols) => { const { body, foot } = parseAsideNote(text); return 2 + Math.max(1, markdownRows(body.join('\n') || '(no answer)', Math.max(10, cols - 5))) + (foot ? 1 : 0); };

function NoteView({ item, cols, fx = null }) {
  if (item.tone === 'ask') return h(AskCard, { text: item.text, cols }); // QUOXON-ASK: every ask is the approval card
  if (item.tone === 'aside') return h(AsideView, { item, cols });
  // RECO-HIGHLIGHT: the recommended option of a decision card: bold, accent colour, never grey.
  if (item.tone === 'reco') return h(Box, { paddingLeft: 2, width: cols }, h(WText, { color: c('sky'), bold: true }, stripMarks(item.text)));
  // Tone shows as a glyph (⚠ ✖ ✔) in front; the sentence stays prose so commands and values keep their own colours.
  const color = c('prose');
  const text = toneText(item.text, item.tone);
  // While it reveals, a line that fits decodes in; a line that wraps keeps plain wrapping (never mis-measured).
  return h(Box, { paddingLeft: 2, flexDirection: 'column', width: cols }, ...noteLines(text, cols - 2).map((l, i) => longUrl(l, cols - 2)
    ? h(Box, { key: i, width: graphemes(stripMarks(l)).length, flexShrink: 0 }, h(Text, { color: c('link'), wrap: 'truncate-end' }, stripMarks(l)))
    : (fx && wrapRows(stripMarks(l), cols - 2) === 1
    ? h(Text, { key: i }, ...fxNodes(paintLine(l, item.tone).map(r => (typeof r === 'string' ? { t: r, color: 'prose' } : { t: r.text, color: r.role || 'prose' })), { e: fx.e - i * 0.05, timing: fx.timing }, 17 + i))
    : h(WText, { key: i, color, bold: item.tone === 'ask' }, ...runs(paintLine(l, item.tone))))));
}

/**
 * QUOXON-MESH: a slot chat line. Incoming "◆ quox2 (Adam) 04:56 hello" (violet: another session speaking),
 * outgoing "→ quox2 04:56 hello ✔" (sky: you). A file shows its name, three lines and a /slot log pointer;
 * /slot log prints the whole file (`full`).
 */
function SlotMsgView({ item, cols }) {
  const l = item.line || {};
  if (l.roomLine) { // QUOXON-ROOMS: `#group-chat  QUOXON: text`, a stable colour per sender
    return h(Box, { paddingLeft: 2, width: cols },
      h(WText, null,
        h(Text, { color: c('label') }, `#${l.room}  `),
        h(Text, { color: c(l.color || 'sky'), bold: true }, `${l.who}: `),
        h(Text, { color: c('text') }, String(l.text ?? ''))));
  }
  const role = l.out ? 'sky' : l.urgent ? 'error' : 'violet';
  const body = String(l.text ?? '');
  // SLOT-RUN A (owner 2026-10-16 "messy needs a format"): one tidy header line (sender, no-reply marker, time);
  // a short plain line stays on it, anything longer or with markdown renders below as formatted rows.
  const time = l.time ? ` ${l.time}` : '';
  const headLen = graphemes(`${l.glyph || '◆'} ${l.who || ''}${!l.out && l.noReply ? ' (no reply address)' : ''}${time} `).length;
  const run = !l.out && l.run ? l.run : null;
  const inline = !run && (Boolean(l.file) || l.out || inlineable(body, cols - 2 - headLen - 2));
  const segRow = (segs, key) => h(Box, { key, paddingLeft: 4, width: cols }, segs.length ? h(Text, null, ...segs.map((sg, i) => h(Text, { key: i, color: c(sg.role || 'text'), bold: sg.bold || undefined }, sg.t))) : h(Text, null, ' '));
  const out = [h(Box, { key: 'h', paddingLeft: 2, width: cols },
    h(WText, null,
      h(Text, { color: c(role), bold: true }, `${l.glyph || '◆'} ${l.who || ''}`),
      !l.out && l.noReply ? h(Text, { color: c('label') }, ' (no reply address)') : null,
      h(Text, { color: c('label') }, `${time} `),
      inline ? h(Text, { color: c(l.urgent ? 'error' : 'text') }, body) : null,
      l.out && l.delivered ? h(Text, { color: c('ok') }, ' ✔') : null))];
  if (!inline && !l.file && !run && body.trim()) formatSlotBody(body, cols - 6, { role: l.urgent ? 'error' : 'text' }).forEach((segs, i) => out.push(segRow(segs, `b${i}`)));
  // SLOT-RUN B: a run request shows the shared ask, the FULL command (never clipped), and its answer line.
  // ASK-SETTLE: an answered or expired run request is one line (what was asked and the answer), never a live card.
  if (run && run.settled) out.push(h(Box, { key: 'run', paddingLeft: 4, width: cols }, h(WText, { color: c('prose') }, ...runs(paintLine(toneText(run.settled, run.settledTone), run.settledTone)))));
  else if (run) out.push(h(Box, { key: 'run' }, h(NeedsYouCard, { // QUOXON-ASK: a run request is the approval card too
    cols, title: `⚠ ${run.who} asks you to run this here`, rows: run.why ? [['why', run.why]] : [], block: codeRows([run.cmd], cols - 4),
    notes: run.runnable ? [] : [`✖ Not offered: ${run.refuse}. Copy it yourself only if you trust it.`],
    footer: run.danger ? `▶ ${run.danger}. Type run to run it, n to skip? run · n no · c chat` : '▶ Run it? y yes · n no · c chat',
    arming: run.runnable ? null : h(Text, null, '') })));
  if (l.file && !l.out) {
    const lines = l.full ? String(l.file.body).split('\n') : l.file.preview;
    lines.forEach((t, i) => out.push(h(Box, { key: `f${i}`, paddingLeft: 6, width: cols }, h(Text, { color: c('text') }, clip(t || ' ', cols - 8)))));
    if (!l.full && l.file.lines > lines.length) out.push(h(Box, { key: 'more', paddingLeft: 6 }, h(Text, { color: c('prose') }, `… ${l.file.lines - lines.length} more line${l.file.lines - lines.length === 1 ? '' : 's'}: `), h(Text, { color: c('command') }, '/slot log')));
    else if (!l.full) out.push(h(Box, { key: 'more', paddingLeft: 6 }, h(Text, { color: c('prose') }, 'full file: '), h(Text, { color: c('command') }, '/slot log')));
  }
  return h(Box, { flexDirection: 'column' }, ...out);
}

export const TIP_HINT = `${cmd('/tip')} for another · ${cmd('/tip-settings off')} to stop`;
/** Word-wrap plain text to `width` columns (a word longer than the width is hard-split). */
function wrapPlain(text, width) {
  const out = []; let line = '';
  for (const w0 of String(text ?? '').split(/\s+/).filter(Boolean)) {
    let w = w0;
    while ([...w].length > width) { if (line) { out.push(line); line = ''; } out.push([...w].slice(0, width).join('')); w = [...w].slice(width).join(''); }
    if (line && [...line].length + 1 + [...w].length > width) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/**
 * A tip in a rounded brand-accent frame: width min(cols - 4, 76), 1-col padding, wrapped text, "Try:" on its own
 * line in the command colour, the /tip hint as the last line inside. Under 40 cols or NO_COLOR: a plain "Tip:" block.
 */
function TipView({ item, cols }) {
  if (mono() || cols < 40) {
    const w = Math.max(10, cols - 2);
    const lines = [...wrapPlain(`Tip: ${item.text}`, w), `Try: ${item.cmd}`, ...wrapPlain(stripMarks(TIP_HINT), w)];
    return h(Box, { paddingLeft: 2, flexDirection: 'column', width: cols }, ...lines.map((l, i) => h(Text, { key: i }, l)));
  }
  const W = Math.min(cols - 4, 76), inner = W - 4, edge = { color: c('brand') };
  const row = (key, kids, len) => h(Box, { key }, h(Text, edge, '│ '), h(Text, null, ...kids), h(Text, null, ' '.repeat(Math.max(0, inner - len))), h(Text, edge, ' │'));
  const body = wrapPlain(item.text, inner).map((l, i) => row(`t${i}`, [h(Text, { key: 0, color: c('prose') }, l)], [...l].length));
  const cmdText = clip(item.cmd, inner - 5);
  const tryRow = row('try', [h(Text, { key: 0, color: c('prose'), bold: true }, 'Try: '), h(Text, { key: 1, color: c('command') }, cmdText)], 5 + [...cmdText].length);
  const hintRow = row('hint', runs(paintRuns(TIP_HINT, 'quiet')), [...stripMarks(TIP_HINT)].length);
  return h(Box, { paddingLeft: 2, flexDirection: 'column' },
    h(Text, edge, '╭─ ', h(Text, { bold: true }, 'Tip'), ' ', '─'.repeat(W - 8), '╮'),
    ...body, tryRow, hintRow,
    h(Text, edge, '╰', '─'.repeat(W - 2), '╯'));
}

/**
 * The startup "What's new since you last ran Quox" box: same frame as a tip, one title row (+ a "Try:" row) per entry,
 * then ALWAYS a "Try: /whatsnew" footer ("+N more. Try: /whatsnew" when more are unseen), so the way to the full list
 * never depends on which entries happen to be newest. The compact head variant (item.head, the new-commands line)
 * already ends "/whatsnew for more" and gets no footer. Under 40 cols or NO_COLOR: plain lines, no frame.
 */
function WhatsNewView({ item, cols }) {
  const HEAD = item.head || "What's new since you last ran Quox";
  const lead = item.more > 0 ? `+${item.more} more. ` : '';
  const more = item.head ? '' : `${lead}Try: /whatsnew`;
  if (mono() || cols < 40) {
    const w = Math.max(10, cols - 2);
    const lines = [HEAD, ...item.items.flatMap(it => [`- ${it.title}`, ...(it.cmd ? [`  Try: ${it.cmd}`] : [])]), ...(more ? [more] : [])].flatMap(l => wrapPlain(l, w));
    return h(Box, { paddingLeft: 2, flexDirection: 'column', width: cols }, ...lines.map((l, i) => h(Text, { key: i }, l)));
  }
  const W = Math.min(cols - 4, 76), inner = W - 4, edge = { color: c('brand') };
  const row = (key, kids, len) => h(Box, { key }, h(Text, edge, '│ '), h(Text, null, ...kids), h(Text, null, ' '.repeat(Math.max(0, inner - len))), h(Text, edge, ' │'));
  const rows = item.items.flatMap((it, i) => {
    const t = clip(it.title, inner - 2);
    const out = [row(`t${i}`, [h(Text, { key: 0, color: c('prose'), bold: true }, `• ${t}`)], 2 + [...t].length)];
    if (it.cmd) { const k = clip(it.cmd, inner - 7); out.push(row(`c${i}`, [h(Text, { key: 0, color: c('prose') }, '  Try: '), h(Text, { key: 1, color: c('command') }, k)], 7 + [...k].length)); }
    return out;
  });
  if (more) rows.push(row('more', [h(Text, { key: 0, color: c('prose') }, lead), h(Text, { key: 1, color: c('prose'), bold: true }, 'Try: '), h(Text, { key: 2, color: c('command') }, '/whatsnew')], [...more].length));
  if (item.pad) { rows.unshift(row('p0', [], 0)); rows.push(row('p1', [], 0)); }
  return h(Box, { paddingLeft: 2, flexDirection: 'column' },
    h(Text, edge, '╭─ ', h(Text, { bold: true }, HEAD), ' ', '─'.repeat(Math.max(1, W - 5 - HEAD.length)), '╮'),
    ...rows,
    h(Text, edge, '╰', '─'.repeat(W - 2), '╯'));
}

/**
 * QUOXON-BROADCAST: the sender's delivery card. Rounded frame in the card's tone (green all in, gold pending, red a
 * real failure), one row per fact, the id and the status hint in the bottom edge. Widths are measured in cells so the
 * emoji does not skew the edge. Under 50 cols: the model's one-line form.
 */
function BroadcastCardView({ item, cols }) {
  const m = item.card;
  if (cols < 50) return h(Box, { paddingLeft: 1, width: cols }, h(WText, { color: c('prose') }, m.narrow));
  const W = Math.min(cols - 4, 76), inner = W - 4, edge = { color: c(m.tone) };
  const cut = (t, room) => { let o = ''; for (const ch of [...t]) { if (stringWidth(o + ch) > room - 1) return o + '…'; o += ch; } return o; };
  const fit = (t, room) => (stringWidth(t) > room ? cut(t, room) : t);
  const rows = m.rows.map((segs, i) => {
    let left = inner;
    const kids = segs.map(([t, role], k) => { const x = fit(t, left); left -= stringWidth(x); return h(Text, { key: k, color: c(role) }, x); });
    return h(Box, { key: i }, h(Text, edge, '│ '), h(Text, null, ...kids), h(Text, null, ' '.repeat(Math.max(0, left))), h(Text, edge, ' │'));
  });
  const title = fit(m.title, W - 5);
  const foot = fit(m.foot, W - 5);
  return h(Box, { paddingLeft: 2, flexDirection: 'column' },
    h(Text, edge, '╭─ ', h(Text, { bold: true, color: c('prose') }, title), ' ', '─'.repeat(Math.max(1, W - 5 - stringWidth(title))), '╮'),
    ...rows,
    h(Text, edge, '╰─ ', h(Text, { color: c('quiet') }, foot), ' ', '─'.repeat(Math.max(1, W - 5 - stringWidth(foot))), '╯'));
}

/** Rows a live block takes as HistoryItem renders it (sizes the live region; keep in step with HistoryItem). */
export function liveRows(blocks, cols) {
  return blocks.reduce((n, b) => {
    switch (b.kind) {
      case 'text': return n + 1 + markdownRows(b.text, cols - 2, true);
      case 'note': return n + (b.tone === 'ask' ? askCardRows(b.text, cols) : b.tone === 'aside' ? asideRows(b.text, cols) : noteRows(b.text, cols, b.tone));
      case 'summary': return n + noteLines(b.text, cols - 4).length;
      case 'error': return n + errorRows(b.text, cols);
      case 'slotmsg': return n + (b.line?.run && !b.line.run.settled ? 9 + Math.ceil(String(b.line.run.cmd || '').length / Math.max(10, cols - 8)) : 1); // ASK-SETTLE: an armed run card is held live
      default: return n + 1;
    }
  }, 0);
}

// ---- composer --------------------------------------------------------------------------------
export const Grad = ({ text }) => {
  if (mono()) return h(Text, { bold: true }, text);
  const chars = [...text];
  return h(Text, { bold: true }, ...chars.map((ch, i) => {
    const k = chars.length > 1 ? i / (chars.length - 1) : 0;
    return h(Text, { key: i, color: `rgb(${G0.map((v, j) => Math.round(v + (G1[j] - v) * k)).join(',')})` }, ch);
  }));
};

/**
 * Pure: the model as the composer's bottom-rule label (`──── anthropic claude-sonnet-5-5 ─`). Degrades to fit,
 * never wraps: full, then a shortened provider (`anth claude-sonnet-5-5`), then the model alone, then the
 * model clipped. Leaves at least four rule cells on the left. Below 30 cols, or no model: ''.
 */
export function modelRuleLabel(cols, model) {
  const full = String(model || '').trim();
  if (!full || cols < 30) return '';
  const room = cols - 7; // ' label ' + one trailing dash + four leading dashes
  const fits = (t) => cellWidth(t) <= room; // cells under the ambiguous-width policy (cells.js)
  if (fits(full)) return full;
  const segs = full.split(' · ');
  const tailSeg = segs[segs.length - 1];
  const words = (segs.length > 1 ? segs[0] : full).split(' ');
  const name = segs.length > 1 ? tailSeg : words.slice(1).join(' ') || words[0];
  const provider = segs.length > 1 ? segs[0] : words.length > 1 ? words[0] : '';
  if (provider) { const short = `${provider.slice(0, 4)} ${name}`; if (fits(short)) return short; }
  if (fits(name)) return name;
  return clip(name, room);
}

/** Pure: the rule split around a right-aligned session name: `───── name ─`. Below 30 cols, or no name: plain. */
export function ruleParts(cols, name) {
  // TUI-FOOTER: '─' is East Asian Ambiguous; where the terminal draws it two cells wide, half as many fill the row
  const d = cellWidth('─');
  if (!name || cols < 30) return { left: '─'.repeat(Math.floor(cols / d)), label: '', right: '' };
  const label = ` ${clip(name, cols - 8)} `;
  return { left: '─'.repeat(Math.max(1, Math.floor((cols - cellWidth(label) - d) / d))), label, right: '─' };
}

/**
 * A ring rule segment as ONE pre-coloured string (not a Text per cell): the gradient is quantised to steps of
 * RING_Q per channel so neighbouring cells share a colour run. Cuts the escapes Ink must tokenise per frame.
 */
const RING_Q = 12;
function ringString(str, rgbs, from = 0) {
  let out = '', run = '', key = null;
  const flush = () => { if (run) out += chalk.rgb(...key.split(',').map(Number))(run); run = ''; };
  [...str].forEach((ch, i) => {
    const k = rgbs[from + i].map(v => Math.max(0, Math.min(255, Math.round(v / RING_Q) * RING_Q))).join(',');
    if (k !== key) { flush(); key = k; }
    run += ch;
  });
  flush();
  return out;
}

/**
 * A composer rule. `ring` (motion only, never under NO_COLOR) = { state, top }: the rule becomes half of the
 * light ring (motion/ring.js); the session name stays bright on top of it.
 */
export const Rule = ({ cols, color, name, ring = null, labelColor = null }) => {
  const p = ruleParts(cols, name);
  // `labelColor` (the model on the bottom rule): its own colour, not bold, so it reads as context, not a title
  const lab = labelColor ? { color: labelColor } : null;
  if (ring && ring.state && ring.state.k > 0 && !mono()) {
    const rgbs = ruleColors(cols, ring.top, ring.state, COLORS[color] || color);
    if (!p.label) return h(Text, null, ringString(p.left, rgbs));
    const ls = [...p.left].length, lb = [...p.label].length;
    return h(Text, null, ringString(p.left, rgbs), h(Text, lab || { color: c('violet'), bold: true }, p.label), ringString(p.right, rgbs, ls + lb));
  }
  if (!p.label) return h(Text, { color: c(color) }, p.left);
  return h(Text, null, h(Text, { color: c(color) }, p.left), h(Text, lab || { color: c('label'), bold: true }, p.label), h(Text, { color: c(color) }, p.right));
};

/** Split the buffer into visible lines with an inverse cursor cell. */
export function composerLines(buf, maxLines = 8) {
  const lines = buf.text.split('\n');
  const { line: cl, col } = lineCol(buf.text, buf.cursor);
  const from = composerFrom(buf, maxLines);
  const sel = selection(buf);
  const starts = []; { let o = 0; for (const l of lines) { starts.push(o); o += l.length + 1; } }
  return lines.slice(from, from + maxLines).map((text, i) => {
    const idx = from + i;
    if (sel) { // QUOXON-MOUSE: the selected span is drawn inverse; no cursor cell while a selection shows
      const a = Math.max(0, Math.min(text.length, sel.from - starts[idx])); const b = Math.max(0, Math.min(text.length, sel.to - starts[idx]));
      return a < b ? { key: idx, pre: text.slice(0, a), sel: text.slice(a, b), post: text.slice(b) } : { text, cursor: null, key: idx };
    }
    if (idx !== cl) return { text, cursor: null, key: idx };
    const gs = graphemes(text);
    return { key: idx, before: gs.slice(0, col).map(g => g.text).join(''), at: gs[col] ? gs[col].text : ' ', after: gs.slice(col + 1).map(g => g.text).join('') };
  });
}

/**
 * The composer with its light ring. `ring` = { ref, active, mode } (motion + colour only): this wrapper steps
 * the ring on every clock frame itself, so a frame re-renders the composer, not the app.
 */
export function RingComposer({ ring: ringIn, ...props }) {
  const now = useFrame();
  const ring = ringIn ? (ringIn.ref.current = ringStep(ringIn.ref.current, { active: ringIn.active, mode: ringIn.mode, now })) : null;
  return h(Composer, { ...props, ring, now });
}

/** `ring` = a ring state from motion/ring.js, or null for the static rules. Hook-free (pure render). */
// TUI-DIVIDER: `divider` = { d, slow } (the AOCL strip state and the per-turn slow-redraw ref), drawn only on the
// ring path (motion + colour), so NO_COLOR, reduced motion and the lite TUI keep the plain rule.
/** Does the block directly above the composer close with a rule? Then no spacer and no second rule (one rule only). */
export function endsInRule({ card = null, asks = [], background = 0, pending = [], steering = [], countdown = false }) {
  if (background > 0 || pending.length || steering.length || countdown) return false;
  if (asks.length) return !askCardModel(asks[asks.length - 1].text).plain && askCardRows(asks[asks.length - 1].text, 80) > 0;
  return Boolean(card);
}

export function Composer({ buf, cols, mode, busy, placeholder, name, model = null, ring = null, divider = null, now = 0, topRule = true }) {
  const empty = buf.text === '';
  const lines = composerLines(buf);
  const body = empty
    ? [h(Box, { key: 'p' }, h(Text, { color: c('sky'), bold: true }, '› '), h(Text, { inverse: true }, ' '), h(Text, { color: c('placeholder') }, clip(placeholder, cols - 5)))]
    : lines.map((l, i) => h(Box, { key: l.key },
      h(Box, { flexShrink: 0 }, h(Text, { color: c('sky'), bold: true }, i === 0 ? '› ' : '  ')), // COMPOSER-EDIT: never squeezed, so wrapped rows are cols - 2 wide
      l.sel !== undefined
        ? h(Text, { color: c('input') }, l.pre, h(Text, { inverse: true }, l.sel), l.post)
        : l.at === undefined
        ? h(Text, { color: c('input') }, l.text || ' ')
        : h(Text, { color: c('input') }, l.before, h(Text, { inverse: true }, l.at), l.after)));
  return h(Box, { flexDirection: 'column', width: cols },
    topRule ? h(Rule, { cols, color: MODE_COLOR[mode] || 'sky', name, ring: ring ? { state: ring, top: true } : null }) : null,
    ...body,
    (ring && divider && dividerRuleEl({ cols, label: modelRuleLabel(cols, model), divider: divider.d, now, ruleColor: c('dim'), labelColor: modelColor(model), mono: mono(), reduced: cellWidth('─') !== 1, slow: divider.slow }))
      || h(Rule, { cols, color: 'dim', name: modelRuleLabel(cols, model), labelColor: modelColor(model), ring: ring ? { state: ring, top: false } : null }));
}

/** The model label's colour: its provider's brand colour, else the label role (never a grey). */
function modelColor(model) {
  if (mono()) return undefined;
  const [prov, ...rest] = String(model || '').split(' ');
  const pc = providerOf(prov, rest.join(' ')) ? providerColor(prov, rest.join(' ')) : null;
  return pc || c('label');
}

export function Pending({ pending, steering, cols }) {
  if (!pending.length && !steering.length) return null;
  return h(Box, { flexDirection: 'column', paddingLeft: 2 },
    ...steering.map(s => h(Text, { key: 's' + s.id, color: c('sky') }, `↳ steering: ${clip(s.text, cols - 16)}`)),
    ...pending.map((p, i) => h(Text, { key: 'q' + p.id, color: c('dim') }, `» queued ${i + 1}: ${clip(p.text, cols - 16)}`)),
    pending.length ? h(Text, { key: 'hint', color: c('dim') }, 'Up edits the last queued message') : null);
}

/** A rule drawing itself in left to right over `dur` seconds (approval card arrival). Same width every frame. */
function DrawRule({ cols, color, e, dur = 0.25 }) {
  const n = Math.round(clamp01(e / dur) * cols);
  if (n >= cols) return h(Rule, { cols, color });
  const edge = n > 0 && !mono() ? h(Text, { color: '#ffffff' }, '─') : (n > 0 ? h(Text, null, '─') : null);
  return h(Text, null, h(Text, { color: c(color) }, '─'.repeat(Math.max(0, n - 1))), edge, ' '.repeat(cols - n));
}

export const ARM_BAR = 6;
/** `motionE` = seconds since the card appeared, when motion is on: the rule draws in, the title decodes, the arming bar fills. */
/** Approvals raised by ANOTHER session: a notice line only. It never takes focus or keys; answer through /approvals. */
export function WaitingNotice({ items = [], cols }) {
  if (!items.length) return null;
  const from = [...new Set(items.map(i => i.origin || 'another session'))].slice(0, 2).join(', ');
  const n = items.length;
  return h(Text, { color: c('ask'), bold: true }, ' ' + clip(`▶ ${n} approval${n === 1 ? '' : 's'} waiting from ${from}${items.some(i => i.privileged) ? ' (privileged)' : ''}: /approvals`, cols - 2));
}

/**
 * QUOXON-ASK (owner 2026-10-16 "every ask should look like an approval card"): THE card frame for anything that needs
 * the human. Approval cards and every other ask render through this one function, so they cannot drift apart:
 * a rule, a bold title saying who is asking, label/value rows (what a yes does, in full, and why), then the
 * "▶ question? keys" footer in the ask colour, and a closing rule. `arming` replaces the footer until keys are live.
 */
export function NeedsYouCard({ cols, title, rows = [], block = [], notes = [], footer, arming = null, motionE = null }) {
  const e = motionE;
  return h(Box, { flexDirection: 'column', width: cols, marginTop: 1 },
    e == null ? h(Rule, { cols, color: 'warn' }) : h(DrawRule, { cols, color: 'warn', e }),
    e == null ? h(Text, { color: c('warn'), bold: true, wrap: 'wrap' }, title) : h(Text, null, ...fxNodes([{ t: title, color: 'warn', bold: true }], { e: e - 0.1, timing: TIMING.title }, 23)),
    // APPROVAL-WHAT: wrap at word boundaries under the label instead of cutting the action or target off
    ...rows.flatMap(([k, v]) => wrapPlain(String(v), Math.max(10, cols - 10)).slice(0, 8).map((line, i) => h(Text, { key: `${k}${i}`, color: c('text') }, '  ', h(Text, { color: c('label') }, (i ? '' : k).padEnd(7)), h(Text, { color: c(k === 'risk' ? 'warn' : 'value') }, line)))),
    // block: pre-shaped segment rows shown verbatim (a command to run: never word-wrapped, never clipped)
    ...block.map((segs, i) => h(Box, { key: `b${i}`, paddingLeft: 2, width: cols }, h(Text, null, ...segs.map((sg, j) => h(Text, { key: j, color: c(sg.role || 'text'), bold: sg.bold || undefined }, sg.t))))),
    ...notes.map((n, i) => h(Text, { key: `n${i}`, color: c('warn'), bold: true, wrap: 'wrap' }, `  ${n}`)),
    arming || h(Text, { color: c('prose'), bold: true, wrap: 'wrap' }, '  ', ...runs(paintLine(footer, 'ask'))),
    e == null ? h(Rule, { cols, color: 'warn' }) : h(DrawRule, { cols, color: 'warn', e }));
}

/** The card's fields for an ask line (from askText): who asks, what a yes does, why, and the footer. */
export function askCardModel(text) {
  const a = parseAsk(text);
  const rows = [['do', a.action], ['why', a.reason]].filter(r => r[1]);
  if (a.plain) return { plain: true, title: '', rows: [], footer: String(text).trim() }; // one quiet line, no box (the walkthrough's prompt)
  return { title: a.title ? `⚠ ${a.title}` : `⚠ ${a.who || 'This terminal'} asks: ${a.question}`, rows, footer: `▶ ${a.question} ${keysLabel(a.keys)}`.trim() };
}

/** Any ask (y/N/c and friends) as the approval card frame. `text` is the askText line. */
export function AskCard({ text, cols }) {
  if (!String(text ?? '').replace(/^\s*▶?\s*/, '').trim()) return null; // an empty ask draws nothing: no rules, no blank line
  const m = askCardModel(text);
  if (m.plain) return h(Box, { width: cols, marginTop: 1 }, h(Text, { color: c('prose'), bold: true, wrap: 'wrap' }, '  ', ...runs(paintLine(m.footer, 'ask'))));
  return h(NeedsYouCard, { cols, title: m.title, rows: m.rows, footer: m.footer });
}
/** Rows an AskCard takes (sizes the live region). */
export const askCardRows = (text, cols) => {
  if (!String(text ?? '').replace(/^\s*▶?\s*/, '').trim()) return 0;
  const m = askCardModel(text);
  if (m.plain) return 1 + wrapRows(m.footer, cols - 2);
  return 4 + wrapRows(m.title, cols) + m.rows.reduce((n, [, v]) => n + Math.min(8, wrapPlain(String(v), Math.max(10, cols - 10)).length), 0) + wrapRows(m.footer, cols - 2);
};

export function ApprovalCard({ card, org, cols, armed, draftHint = null, motionE = null, confirm = false, position = null }) {
  const when = card.askedAt ? String(card.askedAt).replace('T', ' ').slice(0, 16) + ' UTC' : null;
  const rows = card.undescribable ? [['what', card.what], ['from', card.askedBy || card.origin], ['asked', when], ['org', org]].filter(r => r[1]) : [
    ['what', card.what && card.what !== card.tool ? card.what : null], ['tool', card.tool], ['target', card.target], ['scope', card.scope], ['risk', card.risk], ['from', card.foreign ? card.origin : null], ['org', org]
  ].filter(r => r[1]);
  if (card.privileged) rows.push(['grants', `PRIVILEGED: ${[card.tool, card.target].filter(Boolean).join(' ')}`]);
  // APPROVAL-WWWH: what exactly (verbatim), where, who, why, when, read-only or write. The command is a block: never word-wrapped.
  const f = card.facts || null; const block = [];
  if (f && !card.undescribable) {
    if (f.where && /^\d+ (hosts|targets):/.test(f.where)) { for (const k of ['target', 'what']) { const i = rows.findIndex(r => r[0] === k && (k === 'target' || String(r[1]).includes(f.hostList[1]))); if (i >= 0) rows.splice(i, 1); } }
    if (f.command) { block.push([{ t: f.command.kind === 'input' ? 'input:' : 'command:', role: 'label' }]); block.push(...codeRows(f.command.shown.split('\n'), cols - 4)); }
    for (const r of [['where', f.where], ['who', f.who], ['why', f.why], ['asked', [f.asked && `"${f.asked}"`, f.when].filter(Boolean).join(' · ') || null], ['class', f.access]]) if (r[1]) rows.push(r);
  }
  const e = motionE;
  const title = `⚠ Approval needed${position && position.n > 1 ? ` (${position.i} of ${position.n})` : ''}: execution is held`;
  const filled = e == null ? 0 : Math.min(ARM_BAR, Math.floor(clamp01(e / 0.3) * ARM_BAR));
  const arming = e == null || mono()
    ? h(Text, { color: c('dim') }, e == null ? '  arming…' : `  arming… ${'▰'.repeat(filled)}${'▱'.repeat(ARM_BAR - filled)}`)
    : h(Text, null, h(Text, { color: c('dim') }, '  arming… '), h(Text, { color: c('warn') }, '▰'.repeat(filled)), h(Text, { color: c('faint') }, '▱'.repeat(ARM_BAR - filled)));
  const footer = card.privileged && confirm ? `▶ Grant ${[card.tool, card.target].filter(Boolean).join(' ')}? press y again to confirm, any other key cancels`
    : card.undescribable && confirm ? '▶ Quox could not describe this action. Approve it anyway? press y again to confirm, any other key cancels'
      : draftHint === 'focus' ? askText('Approve it?', { keys: 'y approve · n deny · card focused (Esc returns to your draft)' }) // RESTORE-TUI: every y/n goes through askText (same text)
      : draftHint === 'draft' ? askText('Approve it?', { keys: 'y/n answer once your draft is empty · Tab to answer the approval card (your draft is kept)' })
        : '▶ Approve it? y approve · n deny · c chat · Tab later · /approvals all';
  return h(NeedsYouCard, { cols, title, rows, block, notes: card.undescribable && !confirm ? ['Quox could not describe this action'] : [], footer, arming: armed ? null : arming, motionE: e });
}

/** Columns the status line's Q takes: 2 for the Braille glyph, 1 for the Ⓠ fallback (2 where Ambiguous is wide). */
export const statusGlyphWidth = () => cellWidth(glyphStill('resting', { mono: mono(), mode: glyphMode(process.env) }).text);

/** The composer mode in plain words on the status line's context row. */
export const MODE_WORDS = { ask: 'ask first', auto: 'auto, acts without asking', plan: 'plan only' };

/**
 * The status as ONE continuous line that wraps (owner 2026-10-17 19:47: "should just make it one long line that wraps
 * to second or third line if needed ... so much space, looks wrong"; "should say agent: none, when nothing attached").
 * `● agent X · ⬢ slot S · ⬢ groups a 2, b · profile P · org O · mode ask first · rules · ↻ auto-restart`, wrapped
 * onto as few rows as it needs, evened out so no item sits alone, broken only between items, every further row at
 * the same left edge (never inside an item; a
 * single value too long for a row is split across rows). The key hints are separate: always their own row at that
 * same left edge, so nothing is right-aligned and no row carries a gap. The model sits on the composer's bottom rule
 * (modelRuleLabel). Widths are terminal cells under the ambiguous-width policy (cells.js).
 * Pure: rows of { text, segs, hint, gap, lead } where segs are [text, kind, extra].
 */
export function statusRows({ cols, slot, agent, groups = [], parts, hint, qw = statusGlyphWidth(), wide = ambiguousWide() }) {
  const len = (t) => cellWidth(t, { wide });
  const W = Math.max(12, cols - 1);
  const lead = 1 + qw + len(' ✦ '); // ' ' + Q + ' ✦ '
  const room = Math.max(4, W - lead);
  // a token: segs to draw, joined to the previous token on the same row by `pre`
  const tokens = [];
  tokens.push(agent
    ? { pre: ' · ', segs: [['● ', 'agentDot', agent], ['agent ', 'label'], [agent, 'agent', agent]] }
    : { pre: ' · ', segs: [['○ ', 'icon'], ['agent: ', 'label'], ['none', 'value']] });
  tokens.push({ pre: ' · ', segs: slot ? [['⬢ ', 'icon'], ['slot ', 'label'], [slot, 'value']] : [['⬡ no slot', 'label']] });
  (groups || []).filter(g => g?.name).forEach((g, i) => tokens.push({ pre: i ? ', ' : ' · ',
    segs: [...(i ? [] : [['⬢ ', 'icon'], ['groups ', 'label']]), [g.name, 'value'], ...(g.unread ? [[' ' + g.unread, 'number']] : [])] }));
  const p = parts || {};
  // every context item says what it is (owner: "profile moo .. ask?? what?"); /help status explains each in a line
  const word = { profile: 'profile ', org: 'org ', mode: 'mode ' };
  const val = (k) => k === 'mode' ? (MODE_WORDS[p.mode] || null) : k === 'auto' ? '↻ auto-restart' : String(p[k]);
  for (const k of ['profile', 'org', 'mode', 'rules', 'auto'].filter(k => p[k])) tokens.push({ pre: ' · ',
    segs: word[k] && val(k) ? [[word[k], 'label'], [val(k), k === 'mode' && p.mode === 'plan' ? 'violet' : 'value']] : [[k === 'mode' ? String(p[k]) : val(k), 'label']] });
  const tlen = (tk) => tk.segs.reduce((n, sg) => n + len(sg[0]), 0);
  // split a token too wide for a row into row-sized pieces (whole characters by cell width, never an ellipsis)
  const fit = (tk) => {
    if (tlen(tk) <= room) return [tk];
    const out = [];
    let segs = [], w = 0;
    const flush = () => { out.push({ pre: out.length ? '' : tk.pre, segs, forceBreak: out.length > 0 }); segs = []; w = 0; };
    for (const [t, k, x] of tk.segs) for (const ch of t) {
      const cw = len(ch);
      if (w + cw > room && segs.length) flush();
      const last = segs[segs.length - 1];
      if (last && last[1] === k) last[0] += ch; else segs.push([ch, k, x]);
      w += cw;
    }
    if (segs.length) flush();
    return out;
  };
  // fill each row left to right; break only between items (or at a forced piece of an over-long one)
  const pack = (pieces, limit = room) => {
    const rows = [];
    let cur = null, w = 0;
    for (const tk of pieces) {
      const need = tlen(tk) + (cur && cur.length ? len(tk.pre) : 0);
      if (!cur || tk.forceBreak || w + need > limit) { cur = [{ ...tk, pre: '' }]; rows.push(cur); w = tlen(tk); continue; }
      cur.push(tk); w += need;
    }
    return rows;
  };
  // as few rows as filling gives, evened out (the narrowest limit that keeps that count): no item left alone on a row
  const balanced = (pieces) => {
    const n = pack(pieces).length;
    if (n < 2) return pack(pieces);
    let lo = Math.max(1, ...pieces.map(tlen)), hi = room;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pack(pieces, m).length <= n) hi = m; else lo = m + 1; }
    return pack(pieces, lo);
  };
  const toSegs = (row) => row.flatMap(tk => [...(tk.pre ? [[tk.pre, 'sep']] : []), ...tk.segs]);
  const rowsOut = balanced(tokens.flatMap(fit)).map(row => ({ segs: toSegs(row), hint: '' }));
  const hintS = String(hint || '');
  if (hintS) for (const r of pack(hintS.split(' · ').map(t => ({ pre: ' · ', segs: [[t, 'hint']] })))) rowsOut.push({ segs: [], hint: toSegs(r).map(x => x[0]).join('') });
  const pad = ' '.repeat(lead);
  return rowsOut.map((r, i) => {
    const body = r.segs.map(x => x[0]).join('');
    const head = i === 0 ? ' ' + 'Ⓠ'.padEnd(qw, ' ') + ' ✦ ' : pad;
    return { segs: r.segs, hint: r.hint, gap: 0, lead, text: head + body + r.hint };
  });
}

/** QUOXON-FW17: custom rows, one truncated line each, just above the status line. */
export function RowsBar({ rows, cols }) {
  if (!rows?.length) return null;
  const shown = rows.slice(0, 3);
  const labelW = labelWidth(shown); // labels line up across rows
  return h(Box, { flexDirection: 'column', width: cols },
    ...shown.map((r) => {
      const parts = clipParts(rowParts(r, { labelW }), Math.max(1, cols - 2));
      // ROWS: label, value, tone and trend as their own runs; every role is a palette colour (no grey, owner rule).
      return h(Text, { key: r.row.id, wrap: 'truncate-end' }, ' ', ...parts.map(([t, role, bold], i) => h(Text, { key: i, color: c(themeRole(role)), bold: Boolean(bold) }, t)));
    }));
}

export function StatusLine({ cols, slot, agent, groups = [], parts, right }) {
  const p = Array.isArray(parts) ? { profile: parts[0], org: parts[1], model: parts[2], mode: parts[3], rules: parts[4], auto: parts[5] } : parts;
  const qw = statusGlyphWidth();
  const rows = statusRows({ cols, slot, agent, groups, parts: p, hint: right, qw });
  // The still Q (qglyph.js): two Braille cells, or Ⓠ under NO_COLOR / no Braille. statusRows reserved its width.
  const q = glyphStill('resting', { mono: mono(), mode: glyphMode(process.env), depth: colorDepth(process.env) });
  const colour = (k, x) => k === 'agentDot' || k === 'agent' ? agentColor(x) : c(k === 'sep' || k === 'hint' ? 'label' : k);
  return h(Box, { width: cols, flexDirection: 'column' }, ...rows.map((r, i) => h(Text, { key: 'r' + i, wrap: 'truncate-end' },
    i === 0 ? h(Text, null, ' ', h(Text, { bold: true }, ...cellNodes(q.cells, 'sq')), h(Text, { color: c('icon') }, ' ✦ ')) : ' '.repeat(r.lead),
    ...r.segs.map(([t, k, x], j) => h(Text, { key: j, color: colour(k, x), bold: k === 'agent' || k === 'number' }, t)),
    r.hint ? h(Text, { color: c('label') }, ' '.repeat(r.gap), ...hintNodes(r.hint)) : null))); // no grey (owner rule)
}

/** `Enter send · /help`: each key in the key role, its words and the separators in label (never a grey). */
function hintNodes(hint) {
  return hint.split(' · ').flatMap((part, i) => {
    const [k, ...rest] = part.split(' ');
    return [i ? h(Text, { key: 's' + i, color: c('label') }, ' · ') : null, h(Text, { key: 'k' + i, color: c('key') }, k), rest.length ? h(Text, { key: 'w' + i, color: c('label') }, ' ' + rest.join(' ')) : null];
  }).filter(Boolean);
}

/** Live, actionable counts under the status line. Never a transcript message. */
export function NotifyBar({ approvals, error, cols, signedOut = false, alerts = [], hideCount = false }) {
  if (signedOut) return h(Text, { color: c('warn') }, ' ' + clip('not signed in: approvals unavailable until you sign in', cols - 2));
  const count = approvals && !hideCount ? h(Text, { key: 'n', color: c('ask'), bold: true }, ' ' + clip(`▶ ${approvals} approval${approvals === 1 ? '' : 's'} waiting for you${error ? ' (last known)' : ''} · /approvals`, cols - 3)) : null;
  // Background workflows that keep failing: one deduped line each (max 2), never roster rows.
  const alertLines = alerts.slice(0, 2).map((t, i) => h(Text, { key: 'a' + i, color: c('fail') }, ' ' + clip(t, cols - 2)));
  if (alertLines.length) {
    return h(Box, { flexDirection: 'column' }, count, ...alertLines,
      error ? h(Text, { key: 'e', color: c('warn') }, ' ' + clip('approvals unavailable: inbox not reachable, will retry', cols - 2)) : null);
  }
  if (!error) return count;
  // A failed refresh is never "no approvals": say the inbox is unavailable, keep any last known count.
  return h(Box, { flexDirection: 'column' }, count,
    h(Text, { key: 'e', color: c('warn') }, ' ' + clip('approvals unavailable: inbox not reachable, will retry', cols - 2)));
}

const ROSTER_TONE = { running: 'sky', waiting: 'warn', done: 'ok', failed: 'fail' };
/** Live roster under the status line. `view` comes from roster.rosterView; `peek` is plain lines; `confirm` a question. */
export function Roster({ view, peek = [], confirm = null, hint = null, cols, fx = null }) {
  if (view.mode === 'hidden') return null;
  if (view.mode === 'summary') return h(Text, { color: c('dim'), wrap: 'truncate-end' }, view.summary);
  return h(Box, { flexDirection: 'column', width: cols },
    // glyph keeps the state colour; the rest of the line steps down in tone with position and (for finished rows) age
    ...view.lines.map((l, i) => {
      const e = fx && l.key != null ? fx(l.key) : null; // a row that just appeared decodes in (new rows land on top)
      return h(Text, { key: 'r' + i, bold: l.selected, wrap: 'truncate-end' },
        h(Text, { color: c(l.selected ? 'text' : (l.glyphRole || ROSTER_TONE[l.state])) }, ' ' + l.marker + l.glyph),
        e == null ? h(Text, { color: c(l.selected ? 'text' : l.tone) }, l.rest) : h(Text, null, ...fxNodes([{ t: l.rest, color: l.selected ? 'text' : l.tone }], { e, timing: TIMING.roster }, 29 + i)),
        l.pulse ? h(Text, { color: c(l.pulseRole === 'dim' && l.selected ? 'text' : l.pulseRole) }, l.pulse) : null);
    }),
    view.more ? h(Text, { key: 'more', color: c('dim') }, `   +${view.more} more · /roster`) : null,
    ...peek.map((p, i) => h(Text, { key: 'p' + i, color: c('dim'), wrap: 'truncate-end' }, '   ' + clip(p, cols - 5))),
    confirm ? h(Text, { key: 'cf', color: c('warn') }, ' ' + clip(confirm, cols - 2)) : null,
    hint ? h(Text, { key: 'h', color: c('dim') }, ' ' + clip(hint, cols - 2)) : null);
}
