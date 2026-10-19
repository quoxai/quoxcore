/**
 * QUOXON-FW17: custom rows. User-defined lines rendered just above the status line.
 *
 * A row is { id, label?, source: { type: 'url', url, every } | { type: 'cmd', cmd, every }, template, colour? }.
 * The template pulls values out of the fetched JSON (or the command's stdout, as {{text}}) with a tiny
 * SAFE evaluator: {{a.b[0].c}}, {{count(list)}}, {{count(list[field=value])}}, list[field~text] (contains, any
 * case, a plain includes), list[*] (every item) and {a,b} (only these fields). Nothing is eval'd.
 *
 * Sync split (a security line, enforced here and tested): url rows sync per user (preference namespace
 * quoxonRows); cmd rows are LOCAL ONLY. normRows() on anything that arrives from the server drops every cmd
 * row, so a synced row can never make another machine run a shell command.
 *
 * ROWS (2026-10-17): the status-row contract. A row with NO template reads the public JSON shape
 *   { text, label?, value?, tone?: ok|warn|error|info|neutral, trend?: up|down|flat|<number>, link? }
 * (docs/STATUS_ROWS.md). Plain text output counts as { text }. Two more keyless, sync-safe sources:
 *   quox:   { type: 'quox', service: auth|collector, path: '/api/...{org}...' }  your own Quox, with your session
 *   plugin: { type: 'plugin', plugin: '<id>', path: '<relative>' }             GET /api/v1/plugins/<id>/<path>
 * Everything a row prints passes cleanText(): terminal escapes and control characters never reach the screen.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

export const MAX_ROWS = 3;
export const FETCH_TIMEOUT_MS = 5000;
/** url rows fetch from busy boxes (the proof board is ~400 KB): 15 s. cmd rows keep FETCH_TIMEOUT_MS. */
export const URL_TIMEOUT_MS = 15000;
/** A failed refresh keeps showing the last good value (with an age marker) for this long, then warns. */
export const STALE_MAX_MS = 30 * 60 * 1000;
export const BACKOFF_CAP_MS = 10 * 60 * 1000;
export const OUTPUT_CAP = 64 * 1024;
/** A JSON body is parsed whole or not at all: cutting it leaves nothing to read (2026-10-14: the proof board grew to 347 KB and the row showed only dashes). */
export const JSON_CAP = 2 * 1024 * 1024;
export const ROLES = ['prose', 'command', 'value', 'ok', 'warn', 'error', 'brand', 'quiet'];
const ROLE_TO_THEME = { value: 'id' }; // palette role -> theme.js name
export const themeRole = (r) => ROLE_TO_THEME[r] || r || 'prose';

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/* ---- what a row may print ------------------------------------------------------------------ */

// CSI, OSC (title, hyperlink, clipboard), DCS/SOS/PM/APC strings and lone 2-byte escapes.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[@-Z\\-_]?/g;
// C0, DEL, C1, zero-width space, LRM/RLM, bidi embeddings, overrides and isolates, BOM. ZWJ stays (emoji).
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Text from a URL, a command or a plugin -> one safe line. A remote endpoint must never be able to move the
 * cursor, retitle the terminal, write the clipboard (OSC 52) or reorder text with bidi overrides.
 */
export function cleanText(v, max = 500) {
  return String(v ?? '').replace(ANSI_RE, '').replace(/[\t\n\r\v\f]+/g, ' ').replace(CTRL_RE, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/* ---- durations --------------------------------------------------------------------------- */

/** '60s' | '5m' | '1h' -> ms, or null. Floor 5 s, ceiling 1 day. */
export function parseEvery(s) {
  const m = /^(\d+)\s*(s|m|h)$/i.exec(String(s ?? '').trim());
  if (!m) return null;
  const ms = Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2].toLowerCase()];
  return ms >= 5000 && ms <= 86400000 ? ms : null;
}

/* ---- the template evaluator ------------------------------------------------------------- */

/** A path -> steps, or null when malformed. */
export function parsePath(src) {
  const s = String(src ?? '').trim();
  if (!s) return null;
  const steps = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '.') { i++; continue; }
    if (s[i] === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) return null;
      const inner = s.slice(i + 1, end).trim();
      i = end + 1;
      if (/^\d+$/.test(inner)) steps.push({ index: Number(inner) });
      else if (inner === '*') steps.push({ wildcard: true }); // list[*]: every item
      else {
        const eq = /^([^=~\s\[\]]+)\s*=\s*(.*)$/.exec(inner);
        if (eq) steps.push({ field: eq[1], value: eq[2].trim().replace(/^(["'])(.*)\1$/, '$2') });
        else {
          // list[field~text]: case-insensitive contains, a plain includes (never a regex from input).
          const ct = /^([^=~\s\[\]]+)\s*~\s*(.*)$/.exec(inner);
          if (!ct) return null;
          const text = ct[2].trim().replace(/^(["'])(.*)\1$/, '$2');
          if (!text) return null;
          steps.push({ field: ct[1], contains: text.toLowerCase() });
        }
      }
      continue;
    }
    if (s[i] === '{') {
      // #1044: {a,b,c} keeps only these fields (of every item when on a list).
      const end = s.indexOf('}', i);
      if (end < 0) return null;
      const fields = s.slice(i + 1, end).split(',').map((f) => f.trim());
      if (!fields.length || fields.some((f) => !/^[A-Za-z0-9_-]+$/.test(f))) return null;
      steps.push({ fields });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
    const key = s.slice(i, j).trim();
    if (!key || /[\s(){}=,;+*\/]/.test(key)) return null;
    steps.push({ key });
    i = j;
  }
  return steps.length ? steps : null;
}

const own = (o, k) => o !== null && typeof o === 'object' && !Array.isArray(o) && !BLOCKED_KEYS.has(k) && Object.hasOwn(o, k);

function walk(data, steps) {
  let cur = data;
  for (const st of steps) {
    if (cur === undefined || cur === null) return undefined;
    if ('key' in st) { if (!own(cur, st.key)) return undefined; cur = cur[st.key]; }
    else if ('index' in st) { if (!Array.isArray(cur)) return undefined; cur = cur[st.index]; }
    else if (st.wildcard) { if (!Array.isArray(cur)) return undefined; }
    else if (st.fields) {
      const pick = (o) => { const r = {}; for (const f of st.fields) if (own(o, f)) r[f] = o[f]; return r; };
      cur = Array.isArray(cur) ? cur.map(pick) : pick(cur);
    }
    else {
      if (!Array.isArray(cur)) return undefined;
      const sub = parsePath(st.field);
      cur = cur.filter((it) => {
        const v = sub ? walk(it, sub) : undefined;
        if (v === undefined || v === null || typeof v === 'object') return false;
        return 'contains' in st ? String(v).toLowerCase().includes(st.contains) : String(v) === st.value;
      });
    }
  }
  return cur;
}

/** 1234 -> 1.2k, 12345 -> 12k, 1500000 -> 1.5M. Small numbers stay as they are. */
export function fmtNum(n) {
  if (!Number.isFinite(n)) return String(n);
  const a = Math.abs(n);
  if (a < 1000) return String(Number.isInteger(n) ? n : Number(n.toFixed(1)));
  for (const [u, sfx] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
    if (a >= u) {
      const v = n / u;
      return `${Math.abs(v) < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}${sfx}`;
    }
  }
  return String(n);
}

const show = (v) => {
  if (v === undefined || v === null) return '–';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'string') return cleanText(v);
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return String(v.length);
  return '{…}';
};

/** One {{ expr }} body -> { ok, value } | { ok: false, error }. */
function parseExpr(body) {
  const e = String(body ?? '').trim();
  const fn = /^([A-Za-z_]+)\s*\(([\s\S]*)\)$/.exec(e);
  if (fn) {
    if (fn[1] !== 'count') return { error: `unknown function ${fn[1]}() (only count)` };
    const steps = parsePath(fn[2]);
    return steps ? { fn: 'count', steps } : { error: 'count() needs a path' };
  }
  const steps = parsePath(e);
  return steps ? { steps } : { error: e ? `bad path "${e}"` : 'empty {{ }}' };
}

const countOf = (v) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : undefined);

/** Syntax check for a template at add time -> an error string or null. */
export function checkTemplate(tpl) {
  const t = String(tpl ?? '');
  if (!t.trim()) return 'The template is empty.';
  if ((t.match(/\{\{/g) || []).length !== (t.match(/\}\}/g) || []).length) return 'Unbalanced {{ }} in the template.';
  for (const m of t.matchAll(/\{\{([\s\S]*?)\}\}/g)) { const p = parseExpr(m[1]); if (p.error) return p.error; }
  return null;
}

/** Fill a template from parsed data. Unknown paths show as "–". Never throws. */
export function evalTemplate(tpl, data) {
  return String(tpl ?? '').replace(/\{\{([\s\S]*?)\}\}/g, (_, body) => {
    const p = parseExpr(body);
    if (p.error) return '–';
    const v = walk(data, p.steps);
    return show(p.fn === 'count' ? countOf(v) : v);
  });
}

/** Raw text (a response body or stdout) -> the object the template reads: parsed JSON, else { text }. */
export function dataFrom(raw) {
  const text = String(raw ?? '');
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { const j = JSON.parse(t); if (j && typeof j === 'object') return j; } catch { /* plain text */ } }
  return { text: t };
}

/* ---- the status-row contract (docs/STATUS_ROWS.md) ---------------------------------------- */

export const STATUS_ROW_TONES = ['ok', 'warn', 'error', 'info', 'neutral'];
const TONE_ROLE = { ok: 'ok', warn: 'warn', error: 'error', info: 'command', neutral: 'prose' };
const TONE_GLYPH = { ok: '✔', warn: '⚠', error: '✖', info: '◆' };
export const toneRole = (t) => TONE_ROLE[t] || null;

const trendText = (t) => {
  if (t === 'up') return '▲';
  if (t === 'down') return '▼';
  if (t === 'flat') return '▬';
  if (typeof t === 'number' && Number.isFinite(t)) return t > 0 ? `▲${fmtNum(t)}` : t < 0 ? `▼${fmtNum(-t)}` : '▬';
  return '';
};

/**
 * Parsed data -> { seg, warnings } | { error }. Lenient on read (an unknown tone shows neutral and is named
 * in warnings, so `quox rows test` can say so); strict on what it prints (everything passes cleanText).
 */
export function parseStatusRow(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { error: 'A status row is a JSON object: {"text": "..."}.' };
  const warnings = [];
  const seg = {};
  const text = typeof d.text === 'string' ? cleanText(d.text, 160) : typeof d.text === 'number' ? fmtNum(d.text) : '';
  if (text) seg.text = text;
  if (typeof d.value === 'number' && Number.isFinite(d.value)) seg.value = fmtNum(d.value);
  else if (typeof d.value === 'string' && cleanText(d.value, 24)) seg.value = cleanText(d.value, 24);
  else if (d.value !== undefined && d.value !== null) warnings.push('"value" is a number or a short string; ignored.');
  if (!seg.text && !seg.value) return { error: 'Not a status row: it needs "text" (see quox rows contract).' };
  if (d.tone !== undefined && d.tone !== null) {
    if (STATUS_ROW_TONES.includes(d.tone)) { if (d.tone !== 'neutral') seg.tone = d.tone; }
    else warnings.push(`"tone" is one of ${STATUS_ROW_TONES.join(', ')}; "${cleanText(d.tone, 16)}" shows as neutral.`);
  }
  if (d.trend !== undefined && d.trend !== null) {
    const tt = trendText(d.trend);
    if (tt) seg.trend = tt; else warnings.push('"trend" is up, down, flat or a number; ignored.');
  }
  if (typeof d.label === 'string' && cleanText(d.label, 16)) seg.label = cleanText(d.label, 16);
  if (d.link !== undefined && d.link !== null) {
    let ok = false;
    try { const u = new URL(String(d.link)); ok = (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && String(d.link).length <= 500; } catch { ok = false; }
    if (ok) seg.link = new URL(String(d.link)).href; else warnings.push('"link" must be an http(s) URL with no credentials; ignored.');
  }
  return { seg, warnings };
}

/**
 * Data that is not a status row -> the paths a template could use (scalars, one level deep), for a helpful
 * "try --template" hint. -> ['open', 'connection.connected', ...] (at most `max`).
 */
export function fieldHints(data, max = 12) {
  const out = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  for (const [k, v] of Object.entries(data)) {
    if (out.length >= max) break;
    if (!/^[A-Za-z0-9_-]+$/.test(k) || BLOCKED_KEYS.has(k)) continue;
    if (v !== null && typeof v !== 'object') out.push(k);
    else if (Array.isArray(v)) out.push(`count(${k})`);
    else if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v)) {
      if (out.length >= max) break;
      if (/^[A-Za-z0-9_-]+$/.test(k2) && !BLOCKED_KEYS.has(k2) && v2 !== null && typeof v2 !== 'object') out.push(`${k}.${k2}`);
    }
  }
  return out;
}

/** seg -> the one-line text (screen context, /row list, tests): "value text trend". */
export const segText = (seg) => [seg.value, seg.text, seg.trend].filter(Boolean).join(' ');

/**
 * A row + the raw text its source returned -> { ok, text, seg, warnings } | { ok: false, error }.
 * With a template: the template fills from the data. Without one: the status-row contract.
 */
export function rowValue(row, raw) {
  // Empty output is not a value (owner frame 2026-10-17: "QPE │" drew blank). The engine keeps the last good value.
  if (!cleanText(raw)) return { ok: false, error: 'no output' };
  const data = dataFrom(raw);
  if (row.template) {
    const text = evalTemplate(row.template, data);
    return text.trim() ? { ok: true, text, seg: null, warnings: [] } : { ok: false, error: 'no output' };
  }
  const p = parseStatusRow(data);
  if (p.error) return { ok: false, error: p.error };
  return { ok: true, text: segText(p.seg), seg: p.seg, warnings: p.warnings };
}

/* ---- row records -------------------------------------------------------------------------- */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;
export const validId = (s) => ID_RE.test(String(s ?? ''));
export const SOURCE_TYPES = ['url', 'cmd', 'quox', 'plugin'];
export const QUOX_SERVICES = ['auth', 'collector'];
const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A quox or plugin path -> an error string or null. GET only, no traversal, no other host. */
function badPath(path, { absolute }) {
  if (!path) return 'The path is empty.';
  if (path.length > 300) return 'That path is too long (300 characters).';
  if (/[\s#\\]/.test(path) || /[\u0000-\u001f\u007f]/.test(path)) return 'A path has no spaces, # or backslashes.';
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) return 'A path, not a URL: it is read from your own Quox.';
  if (path.split(/[/?]/).some((seg) => seg === '..' || seg === '.' || /%2e%2e|%2f/i.test(seg))) return 'A path cannot step out with .. or encoded slashes.';
  if (absolute && !path.startsWith('/api/')) return 'A quox path starts with /api/.';
  if (!/^[A-Za-z0-9._~\-/?=&%{}:,+]+$/.test(path)) return 'That path has characters a row path cannot use.';
  return null;
}

/** True when a row reads data that is safe to sync and share (no shell). */
export const syncable = (r) => r?.source?.type !== 'cmd';

// Names a secret-bearing query parameter, or a value that looks like a token.
const SECRET_KEY_RE = /^(.*[_-])?(token|access[_-]?token|api[_-]?key|apikey|key|secret|password|passwd|pwd|sig|signature|auth|authorization|session|sessionid|jwt|bearer|credential|creds)$/i;
const SECRET_VAL_RE = /^(eyJ[A-Za-z0-9_-]{8,}\.|(sk|pk|ghp|gho|xox[abp]|qmcp)[-_][A-Za-z0-9]|[A-Fa-f0-9]{32,}$|[A-Za-z0-9+/_-]{40,}={0,2}$)/;

/**
 * Never put a secret in a row definition (it syncs to your account and can be shared). -> a reason or null.
 * Checked when a row is ADDED, EDITED, IMPORTED or SHARED; a stored row is never silently dropped for it.
 */
export function secretInRow(v) {
  const src = v?.source || {};
  const target = src.type === 'url' ? src.url : (src.type === 'quox' || src.type === 'plugin') ? src.path : null;
  if (typeof target === 'string') {
    let q = '';
    try { q = src.type === 'url' ? new URL(target).search : (target.split('?')[1] || ''); } catch { q = ''; }
    for (const [k, val] of new URLSearchParams(q)) {
      if (SECRET_KEY_RE.test(k)) return `The "${k}" parameter looks like a secret. Rows never carry secrets: use a ${src.type === 'url' ? 'quox or plugin row (your session is used)' : 'path without it'} or a local command that reads the secret itself.`;
      if (SECRET_VAL_RE.test(val)) return `The value of "${k}" looks like a token. Rows never carry secrets.`;
    }
  }
  if (src.type === 'cmd' && typeof src.cmd === 'string' && /(authorization:\s*bearer\s+\S{8,}|\b(sk|ghp|xox[abp]|qmcp)[-_][A-Za-z0-9]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.)/i.test(src.cmd))
    return 'That command has a token written into it. Read the secret inside your script (from a file or the vault), never in the row.';
  return null;
}

/** Validate one row -> { row } | { error }. Strict: used for typed input and for everything stored. */
export function checkRow(v) {
  const id = typeof v?.id === 'string' ? v.id.trim() : '';
  if (!validId(id)) return { error: 'Row ids are letters, digits, - and _ (24 at most).' };
  const src = v?.source;
  const every = src?.every === undefined ? '60s' : String(src.every).trim();
  if (parseEvery(every) === null) return { error: `"${every}" is not an interval. Use 30s, 5m or 1h (5s to 1 day).` };
  let source;
  if (src?.type === 'url') {
    let u;
    try { u = new URL(String(src.url)); } catch { return { error: 'That is not a URL.' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Only http and https URLs.' };
    if (u.username || u.password) return { error: 'Put no credentials in the URL; none are sent.' };
    if (String(src.url).length > 500) return { error: 'That URL is too long.' };
    source = { type: 'url', url: u.href, every };
  } else if (src?.type === 'cmd') {
    const cmd = typeof src.cmd === 'string' ? src.cmd.trim() : '';
    if (!cmd || cmd.length > 500) return { error: 'The command must be 1 to 500 characters.' };
    source = { type: 'cmd', cmd, every };
  } else if (src?.type === 'quox') {
    const service = src.service === undefined ? 'auth' : String(src.service);
    if (!QUOX_SERVICES.includes(service)) return { error: `A quox row reads the ${QUOX_SERVICES.join(' or ')} service.` };
    const path = typeof src.path === 'string' ? src.path.trim() : '';
    const bad = badPath(path, { absolute: true });
    if (bad) return { error: bad };
    source = { type: 'quox', service, path, every };
  } else if (src?.type === 'plugin') {
    const plugin = typeof src.plugin === 'string' ? src.plugin.trim() : '';
    if (!PLUGIN_ID_RE.test(plugin)) return { error: 'A plugin id is letters, digits, dots, - and _ (64 at most).' };
    const path = typeof src.path === 'string' ? src.path.trim().replace(/^\/+/, '') : '';
    const bad = badPath(path, { absolute: false });
    if (bad) return { error: bad };
    source = { type: 'plugin', plugin, path, every };
  } else return { error: `A row source is one of ${SOURCE_TYPES.join(', ')}.` };
  // No template = the status-row contract ({ text, value?, tone?, trend?, link? }, or plain text).
  const template = typeof v.template === 'string' ? v.template.trim() : '';
  if (template.length > 300) return { error: 'The template is too long (300 characters).' };
  if (template) { const bad = checkTemplate(template); if (bad) return { error: bad }; }
  const row = { id, source };
  if (template) row.template = template;
  const label = typeof v.label === 'string' ? v.label.trim().slice(0, 24) : '';
  if (label) row.label = label;
  if (v.colour !== undefined && v.colour !== null && v.colour !== '') {
    if (!ROLES.includes(v.colour)) return { error: `Colour is one of ${ROLES.join(', ')}.` };
    if (v.colour !== 'prose') row.colour = v.colour;
  }
  return { row };
}

/**
 * Anything stored or received -> clean rows (bad ones dropped, duplicate ids dropped, capped).
 * cmd rows survive ONLY with { cmd: true }; the server copy is always read without it.
 */
export function normRows(v, { cmd = false } = {}) {
  const out = [];
  for (const x of Array.isArray(v) ? v : Array.isArray(v?.rows) ? v.rows : []) {
    if (x?.source?.type === 'cmd' && !cmd) continue;
    const r = checkRow(x);
    if (r.row && !out.some((o) => o.id === r.row.id) && out.length < MAX_ROWS) out.push(r.row);
  }
  return out;
}

/** url = every row that syncs (url, quox, plugin); cmd = this machine only. */
export const splitRows = (rows) => ({
  url: rows.filter(syncable),
  cmd: rows.filter((r) => !syncable(r))
});
export const rowLabel = (r) => r.label || r.id;

/* ---- /row argument parsing ---------------------------------------------------------------- */

/** Quote-aware split: "double" and 'single' quotes group, \" escapes. -> tokens, or null on an open quote. */
export function tokenize(s) {
  const out = [];
  let i = 0;
  const str = String(s ?? '');
  while (i < str.length) {
    if (/\s/.test(str[i])) { i++; continue; }
    let tok = '';
    if (str[i] === '"' || str[i] === "'") {
      const q = str[i++];
      let closed = false;
      while (i < str.length) {
        if (str[i] === '\\' && i + 1 < str.length && (str[i + 1] === q || str[i + 1] === '\\')) { tok += str[i + 1]; i += 2; continue; }
        if (str[i] === q) { closed = true; i++; break; }
        tok += str[i++];
      }
      if (!closed) return null;
    } else while (i < str.length && !/\s/.test(str[i])) tok += str[i++];
    out.push(tok);
  }
  return out;
}

/**
 * The words after /row -> { kind, ... }. kinds: list add rm on off test error.
 * add: /row add <id> url <url> "<template>" [every 60s] [label X] [colour role]
 *      /row add <id> cmd "<shell cmd>" "<template>" [every 60s] ...
 */
export function parseRowCmd(arg) {
  const toks = tokenize(arg);
  if (!toks) return { kind: 'error', text: 'A quote is not closed.' };
  const sub = (toks[0] || 'list').toLowerCase();
  if (sub === 'list' || sub === 'ls') return { kind: 'list' };
  if (sub === 'on' || sub === 'off') return { kind: sub };
  if (['rm', 'remove', 'del', 'delete'].includes(sub))
    return toks[1] ? { kind: 'rm', id: toks[1] } : { kind: 'error', text: 'Usage: /row rm <id>' };
  if (sub === 'test') return toks[1] ? { kind: 'test', id: toks[1] } : { kind: 'error', text: 'Usage: /row test <id>' };
  if (sub === 'new') return { kind: 'new' };
  if (sub === 'reload') return { kind: 'reload' };
  if (sub === 'edit') return toks[1] ? { kind: 'edit', id: toks[1] } : { kind: 'error', text: 'Usage: /row edit <id>' };
  if (sub === 'add') {
    const USAGE = 'Usage: /row add <id> url <url> "<template>" [every 60s]   or   /row add <id> cmd "<shell cmd>" "<template>"';
    let [, id, type, target, template, ...rest] = toks;
    // No template (nothing after the target, or straight into an option) = the status-row contract.
    if (template !== undefined && ['every', 'label', 'colour', 'color'].includes(template.toLowerCase()) && rest.length % 2 === 1) { rest = [template, ...rest]; template = ''; }
    if (template === undefined && target !== undefined) template = '';
    if (!id || !target || (type !== 'url' && type !== 'cmd')) return { kind: 'error', text: USAGE };
    const opts = {};
    for (let i = 0; i < rest.length; i += 2) {
      const k = (rest[i] || '').toLowerCase();
      if (!['every', 'label', 'colour', 'color'].includes(k) || rest[i + 1] === undefined)
        return { kind: 'error', text: `Unexpected "${rest[i]}". Options: every 60s, label <text>, colour <role>.` };
      opts[k === 'color' ? 'colour' : k] = rest[i + 1];
    }
    const row = { id, source: { type, ...(type === 'url' ? { url: target } : { cmd: target }), ...(opts.every ? { every: opts.every } : {}) } };
    if (template) row.template = template;
    if (opts.label) row.label = opts.label;
    if (opts.colour) row.colour = opts.colour;
    return { kind: 'add', row };
  }
  return { kind: 'error', text: 'Usage: /row [new | add | list | edit <id> | rm <id> | test <id> | reload | on | off]' };
}

/* ---- fetching and running ----------------------------------------------------------------- */

/** Plain fetch of an http(s) URL, no credentials, 15 s timeout, body capped. -> text. Throws a short reason. */
export async function plainFetch(url, { timeoutMs = URL_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error('bad URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s)');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(u.href, { signal: ctl.signal, redirect: 'follow', credentials: 'omit', headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    const t0 = text.trimStart();
    if (t0.startsWith('{') || t0.startsWith('[')) {
      if (text.length > JSON_CAP) throw new Error(`response too large (${Math.round(text.length / 1024)} KB)`);
      return text;
    }
    return text.length > OUTPUT_CAP * 4 ? text.slice(0, OUTPUT_CAP * 4) : text;
  } catch (e) {
    if (ctl.signal.aborted) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
    if (/^HTTP \d+|^response too large/.test(e?.message)) throw e;
    const code = e?.cause?.code || e?.code || '';
    throw new Error(code ? String(code) : 'unreachable');
  } finally { clearTimeout(t); }
}

/** Run a shell command via the user's shell: timeout, output cap. -> stdout. Throws a short reason. */
export function runShell(cmd, { timeoutMs = FETCH_TIMEOUT_MS, shell = process.env.SHELL || '/bin/sh', exec = execFile } = {}) {
  return new Promise((resolve, reject) => {
    exec(shell, ['-c', cmd], { timeout: timeoutMs, maxBuffer: OUTPUT_CAP, killSignal: 'SIGKILL', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, (err, stdout) => {
      if (!err) return resolve(String(stdout ?? ''));
      if (err.killed || err.signal === 'SIGKILL') return reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
      if (/maxBuffer/i.test(err.message || '') || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new Error('output too large'));
      reject(new Error(typeof err.code === 'number' ? `exit ${err.code}` : 'could not run'));
    });
  });
}

/* ---- the engine --------------------------------------------------------------------------- */

/** Next retry delay after `fails` consecutive failures: 5 s doubling, capped at 10 minutes. */
export const backoffMs = (fails) => Math.min(BACKOFF_CAP_MS, 5000 * 2 ** Math.max(0, fails - 1));

const sameRow = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Owns the polling. Injected: fetchUrl(url) -> text, runCmd(cmd) -> text, onChange(), timer fns (tests).
 * Never blocks input: every poll is async and a failure is state, not an exception.
 */
export function createRowEngine({ fetchUrl, runCmd, fetchQuox = () => Promise.reject(new Error('not available here')), onChange = () => {}, now = Date.now, setT = setTimeout, clearT = clearTimeout }) {
  let rows = [];
  let enabled = true;
  let stopped = false;
  const st = new Map(); // id -> { row, status, text, error, fails, timer, running }

  const note = () => { try { onChange(); } catch { /* a render hiccup never kills polling */ } };

  async function probe(row) {
    let raw;
    try {
      const t = row.source.type;
      raw = t === 'url' ? await fetchUrl(row.source.url) : t === 'cmd' ? await runCmd(row.source.cmd) : await fetchQuox(row.source);
    } catch (e) { return { ok: false, error: cleanText(e?.message || 'failed', 60) || 'failed' }; }
    const v = rowValue(row, raw);
    return v.ok ? { ok: true, raw: String(raw ?? ''), text: v.text, seg: v.seg, warnings: v.warnings } : { ok: false, raw: String(raw ?? ''), error: v.error.slice(0, 60) };
  }

  function arm(s, ms) {
    clearT(s.timer);
    if (stopped || !enabled) { s.timer = null; return; }
    s.timer = setT(() => poll(s), ms);
    s.timer?.unref?.();
  }

  async function poll(s) {
    if (stopped || !enabled || s.running || st.get(s.row.id) !== s) return;
    s.running = true;
    const r = await probe(s.row);
    s.running = false;
    if (stopped || st.get(s.row.id) !== s) return; // removed or replaced while in flight
    if (r.ok) { s.status = 'ok'; s.text = r.text; s.seg = r.seg || null; s.error = null; s.fails = 0; s.at = now(); arm(s, parseEvery(s.row.source.every) ?? 60000); }
    else { // s.text and s.at stay: the last good value is still shown
      s.status = 'error'; s.error = r.error; s.fails += 1; arm(s, backoffMs(s.fails)); }
    note();
  }

  return {
    /** Replace the row set. Unchanged rows keep their state; new or edited ones start at once. */
    setRows(next) {
      rows = next.slice(0, MAX_ROWS);
      const ids = new Set(rows.map((r) => r.id));
      for (const [id, s] of st) if (!ids.has(id)) { clearT(s.timer); st.delete(id); }
      for (const row of rows) {
        const cur = st.get(row.id);
        if (cur && sameRow(cur.row, row)) continue;
        if (cur) clearT(cur.timer);
        const s = { row, status: 'loading', text: '', seg: null, error: null, fails: 0, timer: null, running: false };
        st.set(row.id, s);
        if (enabled && !stopped) setT(() => poll(s), 0)?.unref?.();
      }
      note();
    },
    setEnabled(on) {
      enabled = Boolean(on);
      for (const s of st.values()) {
        if (!enabled) { clearT(s.timer); s.timer = null; }
        else if (!s.running) { s.status = s.status === 'ok' ? 'ok' : 'loading'; setT(() => poll(s), 0)?.unref?.(); }
      }
      note();
    },
    isEnabled: () => enabled,
    /** The rows to draw, in order: [{ row, status, text, error }]. Empty when hidden. */
    view() { return enabled ? rows.map((r) => st.get(r.id)).filter(Boolean) : []; },
    state: (id) => st.get(id) || null,
    probe,
    stop() { stopped = true; for (const s of st.values()) clearT(s.timer); }
  };
}

const ageMark = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`; };

/** One row's display -> { text, role }. Pure; the caller clips to the width. */
export function rowDisplay({ row, status, text, error, at }, now = Date.now()) {
  if (status === 'error' && text && at != null && now - at <= STALE_MAX_MS)
    return { text: `${text} · ${ageMark(now - at)} old`, role: row.colour || 'prose' };
  if (status === 'error') return { text: `⚠ ${rowLabel(row)}: ${String(error || 'failed').slice(0, 40)}`, role: 'error' };
  if (status === 'loading' || !text) return { text: `${rowLabel(row)} …`, role: row.colour || 'prose' };
  return { text, role: row.colour || 'prose' };
}

/** The width a label column takes for these rows (labels align across rows), 0 when none has a label. */
export const labelWidth = (states) => Math.min(16, Math.max(0, ...(states || []).map((st) => [...String(st?.row?.label || st?.seg?.label || '')].length)));

/**
 * One row as coloured segments -> [[text, role, bold?]]. A row without a label or contract fields draws exactly
 * as rowDisplay always has (one run); a labelled or contract row reads `✔ Label │ value text ▲3`. Roles are
 * palette roles (never a grey): label for the name and separators, value for the number, the tone for the text.
 */
export function rowParts(st, { now = Date.now(), labelW = 0 } = {}) {
  // Never a bare label: an ok state with nothing to show draws as still loading ("QPE …").
  if (st.status === 'ok' && !String(st.text ?? '').trim() && !st.seg?.value && !st.seg?.text) st = { ...st, status: 'loading' };
  const d = rowDisplay(st, now);
  const { row, seg } = st;
  const live = st.status === 'ok' || (st.status === 'error' && d.role !== 'error');
  if (!live || st.status === 'loading') return [[d.text, d.role]];
  const label = row.label || seg?.label || '';
  const toneR = seg?.tone ? toneRole(seg.tone) : null;
  if (!label && !seg?.tone && !seg?.value && !seg?.trend) return [[d.text, d.role]];
  const out = [];
  if (seg?.tone && TONE_GLYPH[seg.tone]) out.push([TONE_GLYPH[seg.tone] + ' ', toneR]);
  if (label) out.push([label.padEnd(Math.max(labelW, [...label].length)), 'label', true], [' │ ', 'label']);
  const role = toneR || row.colour || 'prose';
  if (seg) {
    if (seg.value) out.push([seg.value, 'value', true]);
    if (seg.text) out.push([(seg.value ? ' ' : '') + seg.text, role]);
    if (seg.trend) out.push([' ' + seg.trend, 'label']);
  } else out.push([st.text, role]);
  if (st.status === 'error') out.push([` · ${ageMark(now - st.at)} old`, 'warn']);
  return out;
}

/** Fit segments into `width` columns (code points), ending in … when cut. */
export function clipParts(parts, width) {
  const out = []; let used = 0;
  const w = Math.max(1, width);
  for (const part of parts) {
    const [t, role, bold] = part;
    const cs = [...String(t)];
    if (used + cs.length <= w) { out.push(part); used += cs.length; continue; }
    const room = w - used - 1;
    if (room > 0) out.push([cs.slice(0, room).join(''), role, bold]);
    out.push(['…', role, bold]);
    return out;
  }
  return out;
}

/* ---- local-only store for cmd rows -------------------------------------------------------- */

export const localRowsFile = () => join(homedir(), '.config', 'quox', 'quoxon-rows.local.json');

/** The local cmd rows. Never throws. */
export function loadLocalCmdRows(file = localRowsFile()) {
  try { return normRows(JSON.parse(readFileSync(file, 'utf8')), { cmd: true }).filter((r) => r.source.type === 'cmd'); }
  catch { return []; }
}
/** -> true when written. Only cmd rows are ever written here. */
export function saveLocalCmdRows(rows, file = localRowsFile()) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ rows: rows.filter((r) => r.source.type === 'cmd') }, null, 2), { mode: 0o600 });
    return true;
  } catch { return false; }
}


/* ---- share and import --------------------------------------------------------------------- */

export const BUNDLE_KIND = 'quox.status-rows';

/**
 * Rows -> a share bundle. ONLY syncable rows go in: a command row runs a shell on the machine that holds it and is
 * never shared (it is listed in `skipped`). A row that names a secret is refused (in `refused`).
 */
export function shareBundle(rows) {
  const out = []; const skipped = []; const refused = [];
  for (const r of rows || []) {
    if (!syncable(r)) { skipped.push(r.id); continue; }
    const why = secretInRow(r);
    if (why) { refused.push({ id: r.id, why }); continue; }
    out.push(r);
  }
  return { bundle: { kind: BUNDLE_KIND, version: 1, rows: out }, skipped, refused };
}

/**
 * Untrusted JSON -> { rows, commands, errors }. rows are syncable and valid; commands are cmd rows, NEVER added by
 * an import on their own (the caller shows each command and needs a person to say yes to it, one by one).
 */
export function readBundle(input) {
  let v = input;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return { rows: [], commands: [], errors: ['That is not JSON.'] }; } }
  const list = Array.isArray(v) ? v : v && typeof v === 'object' && (v.kind === undefined || v.kind === BUNDLE_KIND) && Array.isArray(v.rows) ? v.rows : null;
  if (!list) return { rows: [], commands: [], errors: [`Not a status-row bundle (expected {"kind":"${BUNDLE_KIND}","rows":[...]}).`] };
  const rows = []; const commands = []; const errors = [];
  for (const x of list.slice(0, 20)) {
    const c = checkRow(x);
    const id = cleanText(x?.id, 24) || '?';
    if (c.error) { errors.push(`${id}: ${c.error}`); continue; }
    const why = secretInRow(c.row);
    if (why) { errors.push(`${id}: ${why}`); continue; }
    (syncable(c.row) ? rows : commands).push(c.row);
  }
  return { rows, commands, errors };
}
