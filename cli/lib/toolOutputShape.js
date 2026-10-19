/**
 * #970: governed output shaping for `quox tool exec` (--select / --summary / --limit).
 *
 * On the chat CLI-tools path every shell call except `quox tool exec` is denied, so a model
 * facing a large result (wazuh agents, seo urls, a 618 KB calendar overlay) has no honest
 * way to narrow it. This is that way, inside the governed call: the path grammar is the
 * safe evaluator QuoxOn rows already use (parsePath: a.b, a[0], list[field=value], list[field~text], list[*], {a,b},
 * count(path)), no eval and no new dependency. The shape is sent to the collector so the
 * receipt records what view of the result the caller was shown.
 *
 * Honesty rules: a truncated list always says "showing N of M"; a path that matches
 * nothing says so rather than returning null; a malformed path is an error BEFORE the
 * tool runs.
 */

import { parsePath } from './quoxon/rows.js';

const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
const GRAMMAR = 'use a.b, a[0], list[field=value] (exact), list[field~text] (contains, any case), list[*].field (that field of every item), list[*].{a,b} (several fields of every item, one call), list[field=value].name, count(list), or several paths at once: total,count(list)';
export const DEFAULT_SAMPLE = 10;
const COUNT_KEY_RE = /^(status|state|type|kind|level|severity|health|healthy|enabled|active|category|source|platform|os|role|priority|result|outcome|connected|online)$/i;

// Split on commas outside [], {} and (): "total, count(a[x=1]), b.{c,d}" -> three paths. null when there is no
// top-level comma (a single path), [] entries kept so an empty part is an error, never silently dropped.
function splitTopLevel(e) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) { parts.push(e.slice(start, i).trim()); start = i + 1; }
  }
  if (!parts.length) return null;
  parts.push(e.slice(start).trim());
  return parts;
}

function parseSelect(expr) {
  const e = String(expr ?? '').trim();
  // GUIDES-FIX: several paths in one call ("total,active_total"): each must be a valid path on its own.
  const parts = splitTopLevel(e);
  if (parts) {
    if (parts.some((x) => !x)) return { error: `--select: empty path in ${JSON.stringify(e)}; separate several paths with commas, e.g. total,count(list); ${GRAMMAR}` };
    const multi = [];
    for (const x of parts) {
      const p = parseSelect(x);
      if (p.error) return p;
      multi.push({ expr: x, ...p });
    }
    return { multi };
  }
  const fn = /^([A-Za-z_]+)\s*\(([\s\S]*)\)$/.exec(e);
  if (fn) {
    if (fn[1] !== 'count') return { error: `--select: unknown function ${fn[1]}() (only count); ${GRAMMAR}` };
    const steps = parsePath(fn[2]);
    return steps ? { fn: 'count', steps } : { error: `--select: count() needs a path; ${GRAMMAR}` };
  }
  const steps = parsePath(e);
  return steps ? { steps } : { error: `--select: bad path ${JSON.stringify(e)}; ${GRAMMAR}` };
}

function parseLimit(v) {
  if (v === undefined || v === null || v === true) return { value: undefined };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10000) return { error: `--limit: expected a whole number from 1 to 10000, got ${JSON.stringify(String(v))}` };
  return { value: n };
}

/** Validate a shape before the tool runs -> error string or null. */
export function checkShape({ select, limit } = {}) {
  if (select !== undefined) { const p = parseSelect(select); if (p.error) return p.error; }
  const l = parseLimit(limit);
  return l.error || null;
}

/** The content-free record of the shape, as sent to the collector for the receipt. */
export function shapeRecord({ select, summary, limit } = {}) {
  const r = {};
  if (select !== undefined) r.select = String(select);
  if (summary) r.summary = true;
  const l = parseLimit(limit);
  if (l.value !== undefined) r.limit = l.value;
  return Object.keys(r).length ? r : null;
}

const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const own = (o, k) => isObj(o) && !BLOCKED.has(k) && Object.hasOwn(o, k);

/** Like the rows evaluator, plus projection: a key step on a list maps over its items. */
function walk(data, steps) {
  let cur = data;
  for (const st of steps) {
    if (cur === undefined || cur === null) return undefined;
    if ('key' in st) {
      if (Array.isArray(cur)) cur = cur.filter((it) => own(it, st.key)).map((it) => it[st.key]);
      else { if (!own(cur, st.key)) return undefined; cur = cur[st.key]; }
    } else if ('index' in st) {
      if (!Array.isArray(cur)) return undefined; cur = cur[st.index];
    } else if (st.wildcard) {
      // list[*]: every item; the key steps after it already map over a list.
      if (!Array.isArray(cur)) return undefined;
    } else if (st.fields) {
      // #1044: {a,b}: only these fields, of every item on a list. Blocked keys are never copied.
      const pick = (o) => { const r = {}; for (const f of st.fields) if (own(o, f)) r[f] = o[f]; return r; };
      cur = Array.isArray(cur) ? cur.map((it) => (isObj(it) ? pick(it) : {})) : isObj(cur) ? pick(cur) : undefined;
    } else {
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

const countOf = (v) => (Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : v === undefined ? 0 : 1);

/** The main list of a value: itself, else its largest array (top level, then one level down). */
function mainList(value) {
  if (Array.isArray(value)) return { path: '', list: value };
  if (!isObj(value)) return null;
  let best = null;
  const consider = (path, v) => { if (Array.isArray(v) && (!best || v.length > best.list.length)) best = { path, list: v }; };
  for (const [k, v] of Object.entries(value)) consider(k, v);
  if (!best) for (const [k, v] of Object.entries(value)) if (isObj(v)) for (const [k2, v2] of Object.entries(v)) consider(`${k}.${k2}`, v2);
  return best;
}

function fieldCounts(list) {
  const counts = {};
  const keys = new Set();
  for (const it of list) if (isObj(it)) for (const k of Object.keys(it)) if (COUNT_KEY_RE.test(k)) keys.add(k);
  for (const k of keys) {
    const c = {};
    for (const it of list) {
      const v = isObj(it) ? it[k] : undefined;
      if (v === undefined || v === null || typeof v === 'object') continue;
      const key = String(v);
      c[key] = (c[key] || 0) + 1;
    }
    if (Object.keys(c).length && Object.keys(c).length <= 20) counts[k] = c;
  }
  return counts;
}

/** Honest summary: total, per-field counts where obvious, a bounded sample, "showing N of M". */
export function summarize(value, { limit = DEFAULT_SAMPLE } = {}) {
  const found = mainList(value);
  if (!found) {
    return isObj(value)
      ? { note: 'no list in this result; showing its keys', keys: Object.keys(value) }
      : { note: 'no list in this result', value };
  }
  const M = found.list.length;
  const N = Math.min(limit, M);
  const out = { list_path: found.path || '(root)', total: M, showing: N, note: `showing ${N} of ${M}` };
  const counts = fieldCounts(found.list);
  if (Object.keys(counts).length) out.counts = counts;
  if (isObj(value)) {
    const scalars = Object.fromEntries(Object.entries(value).filter(([, v]) => v === null || typeof v !== 'object'));
    if (Object.keys(scalars).length) out.fields = scalars;
  }
  out.sample = found.list.slice(0, N);
  return out;
}

function truncate(value, n) {
  if (Array.isArray(value)) {
    if (value.length <= n) return value;
    return { total: value.length, showing: n, note: `showing ${n} of ${value.length}`, items: value.slice(0, n) };
  }
  const found = mainList(value);
  if (!found || !found.path || found.list.length <= n) return value;
  const copy = structuredClone(value);
  const parts = found.path.split('.');
  let host = copy;
  for (const p of parts.slice(0, -1)) host = host[p];
  host[parts[parts.length - 1]] = found.list.slice(0, n);
  copy._truncated = { path: found.path, total: found.list.length, showing: n, note: `showing ${n} of ${found.list.length}` };
  return copy;
}

function asData(raw) {
  if (typeof raw !== 'string') return raw;
  const t = raw.trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch { /* text */ } }
  return raw;
}

/** Apply select, then summary or limit. -> { value } (throws on a malformed shape). */
export function shapeOutput(raw, shape = {}) {
  const err = checkShape(shape);
  if (err) throw new Error(err);
  let value = asData(raw);
  if (shape.select !== undefined) {
    const p = parseSelect(shape.select);
    if (p.multi) {
      // each path under its own expression; a path that matched nothing is named, never dropped
      const out = {};
      const unmatched = [];
      for (const q of p.multi) {
        const v = walk(value, q.steps);
        if (q.fn === 'count') out[q.expr] = countOf(v);
        else if (v === undefined) unmatched.push(q.expr);
        else out[q.expr] = v;
      }
      if (!Object.keys(out).length) {
        return { value: { select: String(shape.select), matched: false, note: 'none of the --select paths matched anything in the result', top_keys: isObj(value) ? Object.keys(value) : [] } };
      }
      if (unmatched.length) { out._unmatched = unmatched; out._note = `${unmatched.length} of ${p.multi.length} --select paths matched nothing in the result`; }
      value = out;
    } else {
    const v = walk(value, p.steps);
    if (p.fn === 'count') value = countOf(v);
    else if (v === undefined) {
      return { value: { select: String(shape.select), matched: false, note: 'the --select path matched nothing in the result', top_keys: isObj(value) ? Object.keys(value) : [] } };
    } else value = v;
    }
  }
  const { value: limit } = parseLimit(shape.limit);
  if (shape.summary) return { value: summarize(value, { limit: limit ?? DEFAULT_SAMPLE }) };
  if (limit !== undefined) return { value: truncate(value, limit) };
  return { value };
}

/**
 * BASH-FALLBACK: keep an unshaped result inline on the model-driven path.
 *
 * Claude Code saves Bash output above its inline limit (30000 chars by default) to a file
 * and shows only a path plus a 2 KB preview. The model then reaches for jq/python/grep on
 * that file, which the CLI-tools Bash guard denies (55 of 64 Bash attempts in the
 * 2026-10-14/15 proof evidence). Capping here, below that limit, means the model never
 * gets a file to post-process: it gets the honest --summary view plus how to re-run with
 * --select. The cap only ever shrinks what is SHOWN; the call itself already ran governed.
 */
export const INLINE_MAX_CHARS = 20000;

const jsonLen = (v) => (typeof v === 'string' ? v.length : JSON.stringify(v, null, 2).length);

/** A {output: "<json>"} envelope (quox_cli and some tools) -> its parsed body, else null. */
function innerOutput(value) {
  if (!isObj(value) || typeof value.output !== 'string') return null;
  const parsed = asData(value.output);
  return typeof parsed === 'string' ? null : parsed;
}

/**
 * FLEET-UNHEALTHY: the small non-scalar top-level fields beside the main list (a short "not_healthy" list, a
 * "by_state" count object) are often the answer itself; the summary used to drop every non-scalar. Each kept
 * whole or left out whole, never cut: at most SMALL_FIELD_MAX chars each and SMALL_FIELDS_MAX in total.
 */
const SMALL_FIELD_MAX = 6000;
const SMALL_FIELDS_MAX = 9000;
function smallTopFields(body, found) {
  if (!isObj(body)) return null;
  const mainKey = found && found.path ? found.path.split('.')[0] : null;
  const out = {};
  let used = 0;
  for (const [k, v] of Object.entries(body)) {
    if (k === mainKey || BLOCKED.has(k) || v === null || typeof v !== 'object') continue;
    const n = jsonLen(v);
    if (n > SMALL_FIELD_MAX || used + n > SMALL_FIELDS_MAX) continue;
    out[k] = v;
    used += n;
  }
  return Object.keys(out).length ? out : null;
}

export function capInline(value, { maxChars = INLINE_MAX_CHARS } = {}) {
  const size = jsonLen(value);
  if (size <= maxChars) return { value, capped: false };
  const fullKb = Math.round(size / 1024);
  const data = asData(value);
  if (typeof data === 'string') {
    const wrap = (keep) => ({
      oversized: true,
      full_size_kb: fullKb,
      note: `showing the first ${keep} of ${data.length} characters`,
      next: "Too large to show whole. Run the same call again with narrower --args, or --select '<path>' / --limit N if it is JSON. Never read or post-process a saved output with a shell.",
      text: data.slice(0, keep),
    });
    // JSON escaping (newlines, quotes) inflates the text: shrink until the wrapper fits.
    let keep = Math.max(0, maxChars - 1200);
    let out = wrap(keep);
    while (keep > 0 && jsonLen(out) > maxChars) { keep = Math.floor(keep * 0.8); out = wrap(keep); }
    return { capped: true, value: out };
  }
  const inner = innerOutput(data);
  const body = inner ?? data;
  const via = inner ? 'output (a JSON string: --select cannot reach inside it, so narrow it with --args or the tool\'s own filters)' : null;
  const found = mainList(body);
  const lp = found && found.path ? found.path : (found ? '' : null);
  const example = lp === null
    ? "--select '<key>'"
    : `--select '${lp ? `${lp}[field=value].name` : '[0]'}', --select 'count(${lp || ''})' or --select '${lp ? `${lp}[*].field` : '[*].field'}'`;
  const next = `Result is ${fullKb} KB, too large to show whole, so this is the --summary view. For the exact part you need, run the same quox tool exec again with ${example} (or --summary --limit N for a bigger sample)${via ? `; the list is inside ${via}` : ''}. Never read or post-process a saved output with a shell.`;
  const head = { oversized: true, full_size_kb: fullKb, next, top_keys: isObj(body) ? Object.keys(body).slice(0, 40) : undefined };
  const extra = smallTopFields(body, found);
  for (const limit of [DEFAULT_SAMPLE, 5, 3, 1, 0]) {
    const s = summarize(body, { limit });
    const out = { ...head, ...s, ...(extra ? { fields: { ...(s.fields || {}), ...extra } } : {}) };
    if (jsonLen(out) <= maxChars) return { capped: true, value: out };
  }
  for (const limit of [DEFAULT_SAMPLE, 5, 3, 1, 0]) {
    const out = { ...head, ...summarize(body, { limit }) };
    if (jsonLen(out) <= maxChars) return { capped: true, value: out };
  }
  // Even an empty sample is too big (a huge scalar field): keep only the counts and shape.
  const s = summarize(body, { limit: 0 });
  return { capped: true, value: { ...head, list_path: s.list_path, total: s.total, showing: 0, note: s.note || 'fields too large to show', counts: s.counts } };
}
