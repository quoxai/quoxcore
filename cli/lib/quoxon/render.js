/**
 * QUOXON view layer (Ink 6, React.createElement). Width-aware everywhere,
 * horizontal rules only (no side borders), semantic colour, mono-safe.
 */
import React from 'react';
import chalk from 'chalk';
import { Box, Text, useStdout } from 'ink';
import { graphemes, lineCol } from './textBuffer.js';

const h = React.createElement;
/** Coloured runs (from theme.paintLine/paintRuns) as Text children; the characters are unchanged. */
const runs = (rs) => rs.map((r, i) => (r.role ? h(Text, { key: i, color: c(r.role) }, r.text) : r.text));

import { COLORS, MODE_COLOR, MIN_COLS, mono, c, clampCols, clip, paintLine, paintRuns, agentColor, proto, toneText, stripMarks } from './theme.js';
import { reducedMotion, motionAllowed } from './motion/clock.js';
import { ruleColors, ringStep, ringMode } from './motion/ring.js';
import { useFrame } from './motion/frame.js';
import { rgbStr, hexRgb, mix, clamp01, mixOk, pulse01 } from './motion/color.js';
import { revealCells, TIMING } from './motion/reveal.js';
import { handoffFrame } from './motion/level.js';
import * as themeNs from './theme.js';
import { qArt, qArtFrame } from '../core/banner.js';
import { TIP_FOOTER } from './tips.js';
import { Markdown, markdownRows, wrapRows, WText, Heading } from './markdown.js';
import { termRows } from './term.js';
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
  const keyW = Math.min(24, Math.max(...model.filter(m => m.key).map(m => [...m.key].length), 8) + 2);
  return h(Box, { flexDirection: 'column', marginTop: 1, width: cols }, ...model.map((m, i) => {
    if (m.kind === 'gap') return h(Text, { key: i }, ' ');
    if (m.kind === 'head') return m.dim ? h(Text, { key: i, bold: true, color: c('muted') }, m.text) : h(Heading, { key: i, text: m.text });
    if (m.kind === 'row' || (m.kind === 'dim' && m.key)) {
      const dim = m.kind === 'dim';
      return h(Box, { key: i },
        h(Box, { width: keyW + 2, flexShrink: 0 }, h(Text, { color: c('muted') }, '  ', ...(dim ? [m.key] : runs(paintRuns(m.key, 'key').map(r => (r.role === 'muted' || r.role === 'key' ? r : { ...r, role: /^\s*(just type|paste|status line)\s*$/.test(m.key) ? 'label' : 'key' })))))),
        h(Box, { flexGrow: 1, flexShrink: 1 }, h(Text, { color: c(dim ? 'muted' : 'text') }, ...(dim ? [m.text] : runs(paintRuns(m.text, 'text'))))));
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

export function Intro({ item, cols, progress = 1, rows, dragon = false }) {
  const { stdout } = useStdout();
  const art = introArt(cols, rows ?? termRows(stdout) ?? 40, progress, !mono(), { dragon });
  const wide = cols >= 60;
  const info = h(Box, { flexDirection: 'column', justifyContent: 'center', marginLeft: wide ? 2 : 0, marginTop: wide ? 0 : 1 },
    h(Grad, { text: 'Quox' }),
    h(Text, { color: c('dim') }, clip(item.text, cols - (wide ? art.w + 4 : 2))),
    h(Text, { color: c('dim') }, 'Talk to Quox. /help for everything.'));
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
 *   - a new turn (user message) opens with one blank; the user message and its answer form one block (no blank)
 *   - a run of notices is one group: one blank before and after it, none inside (an /approvals listing stays tight)
 *   - a bang output block gets a blank before it
 *   - items that draw their own leading blank (intro, welcome, help, object cards) add none here
 *   - under 20 terminal rows nothing is padded: only a new turn keeps its blank
 */
const SELF_SPACED = new Set(['intro', 'welcome', 'help', 'object']);
const NOTICE = new Set(['note', 'tip', 'error']);
export function historyGap(prev, item, rows = null) {
  if (!item || SELF_SPACED.has(item.kind)) return 0;
  if (item.kind === 'user') return 1;
  if (!prev) return item.kind === 'text' ? 1 : 0;
  if (rows != null && rows < 20) return 0;
  if (NOTICE.has(item.kind)) return NOTICE.has(prev.kind) ? 0 : 1;
  if (item.kind === 'bang') return 1;
  if (NOTICE.has(prev.kind) || prev.kind === 'bang') return 1;
  if (item.kind === 'text') return prev.kind === 'user' ? 0 : 1;
  return 0;
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
    case 'tip': return h(TipView, { item, cols });
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
export const noteRows = (text, cols, tone) => noteLines(toneText(text, tone), cols - 2).reduce((n, l) => n + wrapRows(stripMarks(l), cols - 2), 0);

/** A failure: a red ✖ then the sentence in prose, so a command inside (`/login`) keeps the command colour. */
function ErrorView({ item, cols, fx }) {
  const raw = String(item.text ?? '');
  const t = [...stripMarks(raw)].length > cols - 6 ? clip(stripMarks(raw), cols - 6) : raw;
  const parts = [{ t: '✖ ', color: 'error' }, ...paintRuns(t, 'prose').map(r => ({ t: r.text, color: r.role || 'prose' }))];
  return h(Box, { paddingLeft: 2 }, fx ? h(Text, null, ...fxNodes(parts, fx, 13)) : h(Text, null, ...parts.map((p, i) => h(Text, { key: i, color: c(p.color) }, p.t))));
}

function NoteView({ item, cols, fx = null }) {
  // Tone shows as a glyph (⚠ ✖ ✔) in front; the sentence stays prose so commands and values keep their own colours.
  const color = c('prose');
  const text = toneText(item.text, item.tone);
  // While it reveals, a line that fits decodes in; a line that wraps keeps plain wrapping (never mis-measured).
  return h(Box, { paddingLeft: 2, flexDirection: 'column', width: cols }, ...noteLines(text, cols - 2).map((l, i) => (fx && wrapRows(stripMarks(l), cols - 2) === 1
    ? h(Text, { key: i }, ...fxNodes(paintLine(l, item.tone).map(r => (typeof r === 'string' ? { t: r, color: 'prose' } : { t: r.text, color: r.role || 'prose' })), { e: fx.e - i * 0.05, timing: fx.timing }, 17 + i))
    : h(WText, { key: i, color }, ...runs(paintLine(l, item.tone))))));
}

/** A "did you know" tip (tips.js). Normal foreground text with a coloured "Tip:" label; nothing grey. Same words as tipLine(). */
function TipView({ item, cols }) {
  return h(Box, { paddingLeft: 2, width: cols }, h(Text, null,
    h(Text, { color: c('sky'), bold: true }, 'Tip:'), ` ${item.text}  `,
    h(Text, { color: c('key'), bold: true }, 'Try:'), ` ${item.cmd}  ${TIP_FOOTER}`));
}

/** Rows a live block takes as HistoryItem renders it (sizes the live region; keep in step with HistoryItem). */
export function liveRows(blocks, cols) {
  return blocks.reduce((n, b) => {
    switch (b.kind) {
      case 'text': return n + 1 + markdownRows(b.text, cols - 2, true);
      case 'note': return n + noteRows(b.text, cols, b.tone);
      case 'summary': return n + noteLines(b.text, cols - 4).length;
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

/** Pure: the rule split around a right-aligned session name: `───── name ─`. Below 30 cols, or no name: plain. */
export function ruleParts(cols, name) {
  if (!name || cols < 30) return { left: '─'.repeat(cols), label: '', right: '' };
  const label = ` ${clip(name, cols - 8)} `;
  return { left: '─'.repeat(Math.max(1, cols - [...label].length - 1)), label, right: '─' };
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
export const Rule = ({ cols, color, name, ring = null }) => {
  const p = ruleParts(cols, name);
  if (ring && ring.state && ring.state.k > 0 && !mono()) {
    const rgbs = ruleColors(cols, ring.top, ring.state, COLORS[color] || color);
    if (!p.label) return h(Text, null, ringString(p.left, rgbs));
    const ls = [...p.left].length, lb = [...p.label].length;
    return h(Text, null, ringString(p.left, rgbs), h(Text, { color: c('violet'), bold: true }, p.label), ringString(p.right, rgbs, ls + lb));
  }
  if (!p.label) return h(Text, { color: c(color) }, p.left);
  return h(Text, null, h(Text, { color: c(color) }, p.left), h(Text, { color: c('label'), bold: true }, p.label), h(Text, { color: c(color) }, p.right));
};

/** Split the buffer into visible lines with an inverse cursor cell. */
export function composerLines(buf, maxLines = 8) {
  const lines = buf.text.split('\n');
  const { line: cl, col } = lineCol(buf.text, buf.cursor);
  let from = 0;
  if (lines.length > maxLines) from = Math.min(Math.max(0, cl - Math.floor(maxLines / 2)), lines.length - maxLines);
  return lines.slice(from, from + maxLines).map((text, i) => {
    const idx = from + i;
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
  return h(Composer, { ...props, ring });
}

/** `ring` = a ring state from motion/ring.js, or null for the static rules. Hook-free (pure render). */
export function Composer({ buf, cols, mode, busy, placeholder, name, ring = null }) {
  const empty = buf.text === '';
  const lines = composerLines(buf);
  const body = empty
    ? [h(Box, { key: 'p' }, h(Text, { color: c('sky'), bold: true }, '› '), h(Text, { inverse: true }, ' '), h(Text, { color: c('placeholder') }, clip(placeholder, cols - 5)))]
    : lines.map((l, i) => h(Box, { key: l.key },
      h(Text, { color: c('sky'), bold: true }, i === 0 ? '› ' : '  '),
      l.at === undefined
        ? h(Text, { color: c('input') }, l.text || ' ')
        : h(Text, { color: c('input') }, l.before, h(Text, { inverse: true }, l.at), l.after)));
  return h(Box, { flexDirection: 'column', width: cols },
    h(Rule, { cols, color: MODE_COLOR[mode] || 'sky', name, ring: ring ? { state: ring, top: true } : null }),
    ...body,
    h(Rule, { cols, color: 'dim', ring: ring ? { state: ring, top: false } : null }));
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
  return h(Text, { color: c('warn') }, ' ' + clip(`${n} approval${n === 1 ? '' : 's'} waiting from ${from}${items.some(i => i.privileged) ? ' (privileged)' : ''}: /approvals`, cols - 2));
}

export function ApprovalCard({ card, org, cols, armed, draftHint = null, motionE = null, confirm = false }) {
  const rows = card.undescribable ? [['tool', card.tool], ['org', org]] : [
    ['tool', card.tool], ['target', card.target], ['scope', card.scope], ['risk', card.risk], ['org', org]
  ].filter(r => r[1]);
  if (card.privileged) rows.push(['grants', `PRIVILEGED: ${[card.tool, card.target].filter(Boolean).join(' ')}`]);
  const e = motionE;
  const title = '⚠ Approval needed: execution is held';
  const filled = e == null ? 0 : Math.min(ARM_BAR, Math.floor(clamp01(e / 0.3) * ARM_BAR));
  const arming = e == null || mono()
    ? h(Text, { color: c('dim') }, e == null ? '  arming…' : `  arming… ${'▰'.repeat(filled)}${'▱'.repeat(ARM_BAR - filled)}`)
    : h(Text, null, h(Text, { color: c('dim') }, '  arming… '), h(Text, { color: c('warn') }, '▰'.repeat(filled)), h(Text, { color: c('faint') }, '▱'.repeat(ARM_BAR - filled)));
  return h(Box, { flexDirection: 'column', width: cols, marginTop: 1 },
    e == null ? h(Rule, { cols, color: 'warn' }) : h(DrawRule, { cols, color: 'warn', e }),
    e == null ? h(Text, { color: c('warn'), bold: true }, title) : h(Text, null, ...fxNodes([{ t: title, color: 'warn', bold: true }], { e: e - 0.1, timing: TIMING.title }, 23)),
    ...rows.map(([k, v]) => h(Text, { key: k, color: c('text') }, '  ', h(Text, { color: c('label') }, k.padEnd(7)), h(Text, { color: c(k === 'risk' ? 'warn' : 'value') }, clip(v, cols - 10)))),
    card.undescribable ? h(Text, { color: c('warn'), bold: true }, '  Quox could not describe this action') : null,
    draftHint === 'draft' ? h(Text, { color: c('warn') }, '  Tab to answer the approval card (your draft is kept)') : null,
    draftHint === 'focus' ? h(Text, { color: c('warn') }, '  card focused (Esc returns to your draft)') : null,
    draftHint === 'tab' ? h(Text, { color: c('warn') }, '  press Tab to answer this card (typing does not approve)') : null,
    !armed ? arming : h(Text, { color: c('muted') }, ...runs(paintLine(
      card.privileged && confirm ? '  press y to confirm the privileged grant · anything else cancels · d deny'
        : card.privileged ? (card.undescribable ? '  Tab to focus, then type the word approve to grant · d deny (no default)' : '  Tab to focus, then a and y (or type approve) to grant · d deny (no default)')
        : card.undescribable ? '  type the word approve to allow · d deny (no default)'
          : '  a approve · d deny · o open in dashboard (no default)'))),
    e == null ? h(Rule, { cols, color: 'warn' }) : h(DrawRule, { cols, color: 'warn', e }));
}

/** Columns the status line's Q takes: 2 for the Braille glyph, 1 for the Ⓠ fallback. */
export const statusGlyphWidth = () => glyphStill('resting', { mono: mono(), mode: glyphMode(process.env) }).width;

/**
 * Fit the status line to the width: fields are dropped by priority (org, then the key hint, then mode,
 * then profile) and joined by separators, never clipped mid-word or glued to the hint. Pure.
 */
export function statusLayout({ cols, slot, agent, parts, hint, qw = statusGlyphWidth() }) {
  const room = Math.max(10, cols - 1);
  const ident = slot ? `⬢ slot ${slot}` : '⬡ no slot';
  const ag = agent ? `● ${agent}` : '○ no agent';
  const order = ['org', 'rules', 'hint', 'mode', 'profile']; // first dropped first; model is kept longest
  let keep = new Set(['profile', 'org', 'model', 'mode', 'hint', 'rules']);
  const build = () => {
    const tail = ['profile', 'org', 'model', 'mode', 'rules'].filter(k => keep.has(k) && parts[k]).map(k => parts[k]).join(' · ');
    const left = ` Ⓠ ✦ ${ident} · ${ag}${tail ? ' · ' + tail : ''}`;
    const hintS = keep.has('hint') && hint ? hint : '';
    return { left, hint: hintS, width: [...left].length + (qw - 1) + (hintS ? 2 + [...hintS].length : 0) };
  };
  let out = build();
  for (const k of order) { if (out.width <= room) break; keep.delete(k); out = build(); }
  return out;
}

export function StatusLine({ cols, slot, agent, parts, right }) {
  const p = Array.isArray(parts) ? { profile: parts[0], org: parts[1], model: parts[2], mode: parts[3], rules: parts[4] } : parts;
  const L = statusLayout({ cols, slot, agent, parts: p, hint: right });
  const gap = L.hint ? Math.max(2, cols - 1 - [...L.left].length - (statusGlyphWidth() - 1) - [...L.hint].length) : 0;
  const lead = ' Ⓠ ✦ ';
  const rest = L.left.slice(lead.length);
  // The still Q (qglyph.js): two Braille cells, or Ⓠ under NO_COLOR / no Braille. statusLayout reserved its width.
  const q = glyphStill('resting', { mono: mono(), mode: glyphMode(process.env), depth: colorDepth(process.env) });
  return h(Box, { width: cols },
    h(Text, { wrap: 'truncate-end' }, ' ', h(Text, { bold: true }, ...cellNodes(q.cells, 'sq')), h(Text, { color: c('icon') }, ' ✦ '),
      h(Text, { color: c('text') }, ...statusIdent(rest.split(' · ').slice(0, 2).join(' · '))),
      rest.split(' · ').length > 2 ? h(Text, { color: c('label') }, ...runs(paintRuns(' · ' + rest.split(' · ').slice(2).join(' · '), 'label'))) : null,
      L.hint ? h(Text, { color: c('muted') }, ' '.repeat(gap), ...runs(paintRuns(L.hint, 'muted'))) : null));
}

/** `⬢ slot NAME · ● AGENT` as runs: glyphs in the icon role, `slot` a label, the agent in its own shade. */
function statusIdent(t) {
  const m = t.match(/^(⬢|⬡) (slot |no slot)(.*?) · (●|○) (.*)$/);
  if (!m) return [t];
  const agent = m[4] === '●';
  return [h(Text, { key: 'g', color: c(m[1] === '⬢' ? 'icon' : 'muted') }, m[1] + ' '), h(Text, { key: 's', color: c(m[3] ? 'label' : 'muted') }, m[2]),
    m[3] ? h(Text, { key: 'n', color: c('value') }, m[3]) : null, h(Text, { key: 'd', color: c('muted') }, ' · '),
    h(Text, { key: 'a', color: agent ? agentColor(m[5]) : c('muted') }, m[4] + ' '), h(Text, { key: 'an', color: agent ? agentColor(m[5]) : c('muted'), bold: agent }, m[5])];
}

/** Live, actionable counts under the status line. Never a transcript message. */
export function NotifyBar({ approvals, error, cols, signedOut = false, alerts = [] }) {
  if (signedOut) return h(Text, { color: c('warn') }, ' ' + clip('not signed in: approvals unavailable until you sign in', cols - 2));
  const count = approvals ? h(Text, { key: 'n', color: c('warn') }, ' ' + clip(`⛔ ${approvals} approval${approvals === 1 ? '' : 's'} waiting for you${error ? ' (last known)' : ''} · /approvals`, cols - 3)) : null;
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
        h(Text, { color: c(l.selected ? 'text' : ROSTER_TONE[l.state]) }, ' ' + l.marker + l.glyph),
        e == null ? h(Text, { color: c(l.selected ? 'text' : l.tone) }, l.rest) : h(Text, null, ...fxNodes([{ t: l.rest, color: l.selected ? 'text' : l.tone }], { e, timing: TIMING.roster }, 29 + i)));
    }),
    view.more ? h(Text, { key: 'more', color: c('dim') }, `   +${view.more} more · /roster`) : null,
    ...peek.map((p, i) => h(Text, { key: 'p' + i, color: c('dim'), wrap: 'truncate-end' }, '   ' + clip(p, cols - 5))),
    confirm ? h(Text, { key: 'cf', color: c('warn') }, ' ' + clip(confirm, cols - 2)) : null,
    hint ? h(Text, { key: 'h', color: c('dim') }, ' ' + clip(hint, cols - 2)) : null);
}
