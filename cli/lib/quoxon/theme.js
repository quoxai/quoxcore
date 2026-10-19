/**
 * Shared look: the semantic palette, NO_COLOR handling, width helpers.
 *
 * Every colour is a ROLE mapped to a shade of the Q glyph (sky #38bdf8 -> indigo #6366f1 -> violet #a855f7,
 * plus teal #06b6d4) or a state colour. Two tables: DARK (checked >= 4.5:1 against #000) and LIGHT
 * (checked >= 4.5:1 against #fff), chosen by the terminal background (COLORFGBG when set, else dark).
 * Each entry carries a 256-colour fallback used when the terminal is a 256-colour TTY without truecolor.
 * Purple is for keys and accents only, never whole sentences.
 */
import { graphemes } from "./textBuffer.js";
import { SEMANTIC_DARK, SEMANTIC_LIGHT, stripMarks, MARK } from './palette.js';

export const MIN_COLS = 40;

/** role -> [truecolor hex, ansi256 index]. */
export const DARK = {
  heading: ['#38bdf8', 75], // first stop; the word is painted with HEADING_STOPS
  icon: ['#06b6d4', 38],
  bullet1: ['#38bdf8', 75], bullet2: ['#818cf8', 105], bullet3: ['#a855f7', 135],
  label: ['#a5b4fc', 147],
  value: ['#f1f5f9', 255],
  number: ['#38bdf8', 75],
  link: ['#38bdf8', 75],
  code: ['#2dd4bf', 80], codeBg: ['#1f2937', 235], codeRule: ['#155e75', 24],
  key: ['#2dd4bf', 80], // a thing you type: the command colour (purple is brand chrome only)
  muted: ['#bcc8e8', 189],
  ok: ['#4ade80', 78], warn: ['#f59e0b', 214], error: ['#f87171', 210],
  ask: ['#f472b6', 211], // QUOXON-ASK: "needs you" (every y/N and approval): glyph and keys, bold line
  gold: ['#d4af37', 178], // the authorisation moment: step-up PIN card frame, filled dots, human-present countdown
  // legacy names, kept so existing call sites read the same
  sky: ['#38bdf8', 75], violet: ['#a855f7', 135], indigo: ['#818cf8', 105], teal: ['#06b6d4', 38],
  fail: ['#f87171', 210], dim: ['#bcc8e8', 189], faint: ['#7c8fe0', 105],
  text: ['#f1f5f9', 255], input: ['#ffffff', 231], placeholder: ['#bcc8e8', 189],
  // semantic roles (palette.js)
  prose: SEMANTIC_DARK.prose, command: SEMANTIC_DARK.command, id: SEMANTIC_DARK.value, brand: SEMANTIC_DARK.brand, quiet: SEMANTIC_DARK.quiet, rule: SEMANTIC_DARK.rule
};
export const LIGHT = {
  heading: ['#0369a1', 25],
  icon: ['#0e7490', 30],
  bullet1: ['#0369a1', 25], bullet2: ['#4338ca', 62], bullet3: ['#7e22ce', 91],
  label: ['#4f46e5', 62],
  value: ['#0f172a', 234],
  number: ['#0369a1', 25],
  link: ['#0369a1', 25],
  code: ['#0f766e', 30], codeBg: ['#ecfeff', 195], codeRule: ['#67e8f9', 117],
  key: ['#0f766e', 30],
  muted: ['#3b4f87', 60],
  ok: ['#15803d', 28], warn: ['#b45309', 130], error: ['#b91c1c', 124],
  ask: ['#be185d', 161],
  gold: ['#8a6500', 94],
  sky: ['#0369a1', 25], violet: ['#7e22ce', 91], indigo: ['#4338ca', 62], teal: ['#0e7490', 30],
  fail: ['#b91c1c', 124], dim: ['#3b4f87', 60], faint: ['#7280c8', 104],
  text: ['#0f172a', 234], input: ['#0f172a', 234], placeholder: ['#3b4f87', 60],
  prose: SEMANTIC_LIGHT.prose, command: SEMANTIC_LIGHT.command, id: SEMANTIC_LIGHT.value, brand: SEMANTIC_LIGHT.brand, quiet: SEMANTIC_LIGHT.quiet, rule: SEMANTIC_LIGHT.rule
};
/** Roles a reader must be able to read: each is held to >= 4.5:1 on its background (tests). */
export const ROLES = ['heading', 'icon', 'bullet1', 'bullet2', 'bullet3', 'label', 'value', 'number', 'link', 'code', 'key', 'muted', 'ok', 'warn', 'error', 'ask', 'gold', 'text', 'placeholder', 'prose', 'command', 'id', 'brand', 'quiet'];

/** Heading gradient stops across the word: sky -> indigo -> violet (light: the -700 shades). */
export const HEADING_STOPS = { dark: ['#38bdf8', '#6366f1', '#a855f7'], light: ['#0369a1', '#4338ca', '#7e22ce'] };
/** Agent names get a stable shade of the Q by hash. */
export const AGENT_SHADES = {
  dark: ['#38bdf8', '#a855f7', '#2dd4bf', '#818cf8', '#c4b5fd', '#7dd3fc'],
  light: ['#0369a1', '#7e22ce', '#0f766e', '#4338ca', '#6d28d9', '#075985']
};

/** Model providers in their brand colours (dark, light). Unknown = muted. */
export const PROVIDER_COLORS = {
  openai: ['#f5f5f5', '#111111'], anthropic: ['#D97757', '#b4532e'], google: ['#4796E3', '#1a62c4'],
  ollama: ['#e5e7eb', '#3b4f87'], mistral: ['#FA520F', '#c2410c'], deepseek: ['#4D6BFE', '#2f4fe0'],
  perplexity: ['#20808D', '#1a6b76'], xai: ['#f5f5f5', '#111111'],
  // B5: OpenAI-compatible presets (dark bg shade, light bg shade; all >= 4.5:1 on their background)
  openrouter: ['#6566F1', '#4f46e5'], huggingface: ['#FFD21E', '#8a6500'], groq: ['#F55036', '#c2290f'],
  together: ['#0F6FFF', '#0b57d0'], lmstudio: ['#a78bfa', '#6d28d9'], vllm: ['#30A2FF', '#0b6bb8'],
  openai_compatible: ['#c7d2fe', '#3b4f87']
};
/** Protocol trace marks (AEE, AOCL, VOLT, WARD), each its own Q shade (dark, light). */
export const PROTO_COLORS = {
  aee: ['#38bdf8', '#0369a1'], aocl: ['#818cf8', '#4338ca'], volt: ['#2dd4bf', '#0f766e'], ward: ['#a855f7', '#7e22ce']
};

/** Back-compat: the dark truecolor table as name -> hex. */
export const COLORS = Object.fromEntries(Object.entries(DARK).map(([k, v]) => [k, v[0]]));
export const MODE_COLOR = { ask: COLORS.sky, auto: COLORS.warn, plan: COLORS.violet, demo: COLORS.violet };

export const mono = () => Boolean(process.env.NO_COLOR);

/** Light background? COLORFGBG is "fg;bg" (sometimes "fg;x;bg"); bg 7 or 9..15 is light. Unknown = dark. */
export function isLight(env = process.env) {
  if (env.QUOX_THEME === 'light') return true;
  if (env.QUOX_THEME === 'dark') return false;
  const parts = String(env.COLORFGBG || '').split(';');
  const bg = Number(parts[parts.length - 1]);
  if (!env.COLORFGBG || !Number.isFinite(bg)) return false;
  return bg === 7 || (bg >= 9 && bg <= 15);
}
export const table = (env = process.env) => (isLight(env) ? LIGHT : DARK);

/** 256-colour terminal (a TTY that says 256color and not truecolor): use the explicit fallback index. */
export function use256(env = process.env, isTTY = Boolean(process.stdout?.isTTY)) {
  if (!isTTY) return false;
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM || '')) return false;
  return /256/.test(env.TERM || '') || env.FORCE_COLOR === '2';
}

/** Role or legacy name -> an Ink colour string; anything else passes through. undefined under NO_COLOR.
 *  `provider:<id>` and `proto:<name>` resolve through providerColor / proto. */
export const c = (name) => {
  if (mono()) return undefined;
  if (typeof name === 'string' && name.startsWith('provider:')) return providerColor(name.slice(9));
  if (typeof name === 'string' && name.startsWith('proto:')) return proto(name.slice(6));
  const e = table()[name];
  if (!e) return name;
  return use256() ? `ansi256(${e[1]})` : e[0];
};

export function clampCols(n) { return Math.max(MIN_COLS, Number.isFinite(n) ? Math.floor(n) : 80); }

export const clip = (s, max) => {
  const gs = graphemes(String(s ?? '').replace(/\s+/g, ' '));
  if (max <= 0) return '';
  return gs.length > max ? gs.slice(0, max - 1).map(g => g.text).join('') + '…' : gs.map(g => g.text).join('');
};

const hex2rgb = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
/** sRGB relative luminance and WCAG contrast. */
export function luminance(hex) {
  const [r, g, b] = hex2rgb(hex).map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Per-character gradient colours for a heading (empty array under NO_COLOR). */
export function gradient(text, stops = HEADING_STOPS[isLight() ? 'light' : 'dark']) {
  const chars = [...String(text)];
  if (mono()) return chars.map(ch => ({ ch, color: undefined }));
  const rgb = stops.map(hex2rgb);
  return chars.map((ch, i) => {
    const k = chars.length > 1 ? i / (chars.length - 1) : 0;
    const seg = Math.min(rgb.length - 2, Math.floor(k * (rgb.length - 1)));
    const f = k * (rgb.length - 1) - seg;
    const col = rgb[seg].map((v, j) => Math.round(v + (rgb[seg + 1][j] - v) * f));
    return { ch, color: use256() ? stops[Math.round(k * (stops.length - 1))] : `#${col.map(v => v.toString(16).padStart(2, '0')).join('')}` };
  });
}

/** Stable shade for an agent name (SEER, LUCID, VULCAN ... stay distinguishable). */
export function agentColor(name) {
  if (mono()) return undefined;
  const shades = AGENT_SHADES[isLight() ? 'light' : 'dark'];
  let x = 5381;
  for (const ch of String(name || '').toUpperCase()) x = ((x * 33) ^ ch.codePointAt(0)) >>> 0;
  return shades[x % shades.length];
}

/** Provider id from a provider and/or model name (turn.started.provider/model, vault types, display names). */
export function providerOf(provider, model) {
  const p = String(provider || '').toLowerCase().replace(/[\s_-]*(api|subscription)$/, '').trim();
  const m = String(model || '').toLowerCase();
  const DIRECT = { openai: 'openai', chatgpt: 'openai', gpt: 'openai', anthropic: 'anthropic', claude: 'anthropic', google: 'google', gemini: 'google',
    ollama: 'ollama', local: 'ollama', mistral: 'mistral', deepseek: 'deepseek', perplexity: 'perplexity', xai: 'xai', grok: 'xai',
    openrouter: 'openrouter', huggingface: 'huggingface', hf: 'huggingface', groq: 'groq', together: 'together', lmstudio: 'lmstudio', 'lm studio': 'lmstudio',
    'lm-studio': 'lmstudio', vllm: 'vllm', custom: 'openai_compatible', openai_compatible: 'openai_compatible', 'openai-compatible': 'openai_compatible' };
  if (DIRECT[p]) return DIRECT[p];
  const x = m || p;
  if (/^(gpt-|chatgpt|o[134](-|$)|openai)/.test(x)) return 'openai';
  if (/^claude|^anthropic/.test(x)) return 'anthropic';
  if (/^gemini|^google/.test(x)) return 'google';
  if (/^ollama[:/]|^ollama$/.test(x)) return 'ollama';
  if (/^(mistral|codestral|mixtral|magistral|devstral)/.test(x)) return 'mistral';
  if (/^deepseek/.test(x)) return 'deepseek';
  if (/^(sonar|perplexity|pplx)/.test(x)) return 'perplexity';
  if (/^(grok|xai)/.test(x)) return 'xai';
  return null;
}
/** Brand colour for a provider/model; unknown = muted; undefined under NO_COLOR. */
export function providerColor(provider, model) {
  if (mono()) return undefined;
  const id = providerOf(provider, model);
  if (!id) return c('muted');
  return PROVIDER_COLORS[id][isLight() ? 1 : 0];
}
/** Colour for a protocol trace mark: aee sky, aocl indigo, volt teal, ward violet; unknown = muted. */
export function proto(name) {
  if (mono()) return undefined;
  const e = PROTO_COLORS[String(name || '').toLowerCase()];
  return e ? e[isLight() ? 1 : 0] : c('muted');
}

/** Bullet colour by list depth (0-based): sky, indigo, violet, cycling. */
export const bulletRole = (depth) => ['bullet1', 'bullet2', 'bullet3'][((depth % 3) + 3) % 3];

// ---- paint: split a plain line into coloured runs; the characters never change ---------------------
const GLYPH_ROLE = {
  '●': 'ok', '✔': 'ok', '◐': 'warn', '○': 'quiet', '?': 'quiet', '✖': 'error', '⚠': 'warn', '⊘': 'warn',
  '◉': 'icon', 'Ⓠ': 'icon', '▸': 'brand', '⛔': 'warn', '↳': 'icon', '»': 'quiet', '·': 'quiet', '⬢': 'icon', '⬡': 'quiet', '▶': 'ask'
};
const KEYS = '(?:(?:Ctrl|Shift|Alt|Cmd|Option)\\+\\S+|Enter|Tab|Esc|Up|Down|Left|Right|Space|Backspace|PgUp|PgDn)';
const TOKEN = new RegExp([
  '(https?:\\/\\/[^\\s)]+)', // 1 link
  '(\\bquox(?: (?![·])[^\\s·,;)]+)+)', // 2 a quox command
  '((?<![\\w/])\\/[a-z][\\w-]*(?: (?:--?[a-z][\\w-]*|<[^>\\s]+>|\\[[^\\]\\s]+\\]|\\d+|[\\w-]+(?:\\|[\\w-]+)+))*)', // 3 slash command + its flags/args
  `((?<![\\w+])${KEYS}(?![\\w+]))`, // 4 keyboard key
  '((?<![\\w<])<[^>\\s]+>|\\[[^\\]\\s]+\\])', // 5 placeholder <name> or [args]
  '( · )', // 6 separator
  '((?<![\\w/.-])(?:(?:gpt|claude|gemini|o[134]|mistral|codestral|deepseek|sonar|grok)-[\\w.:-]*\\w|ollama:[\\w.:-]*\\w|OpenAI|openai|Anthropic|anthropic|Claude(?: API)?|Gemini|Ollama|ollama|Mistral|DeepSeek|Perplexity|Grok|xAI)(?![\\w-]))', // 7 provider/model
  '((?<![\\w.#-])\\d+(?:[.,:-]\\d+)*(?:%|ms|s|k|m|h|d|x|KB|MB|GB)?(?![\\w]))' // 8 number
].join('|'), 'g');
const ROLE_OF = [null, 'id', 'command', 'command', 'command', 'command', 'quiet', 'provider', 'id'];
const LETTER_KEY = /^([a-z])(?= (?:approve|deny|open|stop|peek|confirm|edit|retry|cancel|copy|quit)\b)/;

/** Runs of `text` with roles; `base` colours the prose between tokens. Pure. */
export function paintRuns(text, base) {
  const out = [];
  const push = (t, role) => { if (!t) return; const last = out[out.length - 1]; if (last && last.role === role) last.text += t; else out.push({ text: t, role }); };
  const s = String(text ?? '');
  let i = 0;
  const startsSeg = (at) => at === 0 || s.slice(0, at).endsWith(' · ') || /^\s*$/.test(s.slice(0, at));
  if (/[⟦⟪]/.test(s)) { // explicit markup: `command` and «value» are atomic spans, the rest is auto-tokenised
    let j = 0;
    for (const m of s.matchAll(MARK)) {
      for (const r of paintRuns(s.slice(j, m.index), base)) push(r.text, r.role);
      push(m[1] ?? m[2], m[1] !== undefined ? 'command' : 'id');
      j = m.index + m[0].length;
    }
    for (const r of paintRuns(s.slice(j), base)) push(r.text, r.role);
    return out;
  }
  for (const m of s.matchAll(TOKEN)) {
    proseRuns(s.slice(i, m.index), base, push, startsSeg(i));
    const g = m.findIndex((x, k) => k > 0 && x !== undefined);
    push(m[0], ROLE_OF[g] === 'provider' ? `provider:${providerOf(m[0], m[0])}` : ROLE_OF[g]);
    i = m.index + m[0].length;
  }
  proseRuns(s.slice(i), base, push, startsSeg(i));
  return out;
}
function proseRuns(seg, base, push, segStart) {
  const k = segStart && seg.match(LETTER_KEY);
  if (k) { push(k[1], 'command'); seg = seg.slice(1); }
  push(seg, base);
}

/**
 * A note/list line as runs: a leading state glyph, then `Label  value` (two spaces) or `label: value`,
 * then tokens. tone: undefined/'dim' (neutral), 'ok', 'warn', 'accent', 'error', 'ask' (a question for the human).
 */
export function paintLine(text, tone) {
  const s = String(text ?? '');
  const out = [];
  // The tone colours the GLYPH only. The sentence stays prose, so commands and values inside keep their roles.
  const TONE_GLYPH = { warn: 'warn', error: 'error', fail: 'error', ok: 'ok', accent: 'brand', ask: 'ask' };
  // [\s\S]* not .*: a notice can carry a newline (a server error body), and a failed match crashed the TUI
  // ("m is not iterable", 2026-10-15 03:44 while the collector was down).
  const m = s.match(/^(\s*)(?:([●✔◐○?✖⚠⊘◉Ⓠ▸⛔↳»·⬢⬡▶])( ))?([\s\S]*)$/u) || [s, '', undefined, undefined, s];
  const [, lead, glyph, gsp, rest0] = m;
  if (lead) out.push({ text: lead, role: undefined });
  if (glyph) out.push({ text: glyph, role: ['ok', 'warn', 'error'].includes(GLYPH_ROLE[glyph]) ? GLYPH_ROLE[glyph] : (TONE_GLYPH[tone] || GLYPH_ROLE[glyph]) }, { text: gsp, role: undefined });
  let rest = rest0;
  if (tone === 'ask') { // QUOXON-ASK: "▶ reason. question? keys": the keys after the last "? " are the ask colour
    const q = rest.lastIndexOf('? ');
    if (q >= 0) { out.push(...paintRuns(rest.slice(0, q + 2), 'prose'), ...paintRuns(rest.slice(q + 2), 'ask')); return out; }
    out.push(...paintRuns(rest, 'prose')); return out;
  }
  const lv = rest.match(/^(\S[^·]{0,30}?\S|\S)( {2,})(\S.*)$/) || rest.match(/^([A-Za-z][\w .-]{0,22}:)( )(\S.*)$/);
  const valueBase = 'prose';
  if (lv && !/^https?:/.test(lv[1])) {
    const pv = providerOf(lv[1].replace(/\s*\(.*\)$/, ''), null);
    out.push({ text: lv[1], role: pv ? `provider:${pv}` : 'label' }, { text: lv[2], role: undefined });
    rest = lv[3];
  }
  out.push(...paintRuns(rest, valueBase));
  return out;
}

/** The glyph a bare notice line gets so its tone shows without tinting the sentence. '' for neutral tones. */
export const TONE_PREFIX = { warn: '⚠ ', error: '✖ ', fail: '✖ ', ok: '✔ ' };
export const toneText = (text, tone) => {
  const p = TONE_PREFIX[tone];
  const t = String(text ?? '');
  return p && !/^\s*[●✔◐○?✖⚠⊘◉Ⓠ▸⛔↳»·⬢⬡▶] /u.test(t) ? p + t : t;
};
export { stripMarks };
