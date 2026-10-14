/**
 * L0 command palette: the pure model behind the list that opens under the composer when a draft
 * starts with `/`. Built from the one REGISTRY (commands.js), so the palette, /help and dispatch can
 * never disagree. Only commands that can work here are bright; anything this session cannot run is
 * dim with the reason. Planned commands stay hidden unless typed exactly.
 */
import { REGISTRY } from '../commands.js';

export const PALETTE_MAX = 8;

/** The draft as a palette query: '/co' -> 'co'; null when the draft is not a bare command word. */
export function paletteQuery(draft) {
  const t = String(draft ?? '');
  if (!t.startsWith('/') || t.startsWith('//')) return null;
  if (/[\s]/.test(t)) return null; // args typed (or several lines): the palette steps aside
  return t.slice(1).toLowerCase();
}

/**
 * Why a command cannot run in this session, or null. `api` is the session's server wrapper (a method
 * missing means this mode has no route for it); `caps` is GET /api/v1/capabilities when the server has
 * it ({ id: { available, reason } }), else null; `blocked` is the not-signed-in message.
 */
export function unavailableReason(entry, { api = {}, caps = null, blocked = null } = {}) {
  const cap = caps ? caps[entry.cap || entry.id] : null;
  if (cap && cap.available === false) return cap.reason || 'not available on this server';
  for (const m of entry.needs || []) if (typeof api[m] !== 'function') return 'not available in this mode';
  if (blocked && entry.server) return 'not signed in';
  return null;
}

/**
 * GET /api/v1/capabilities as api.capabilities() returns it ({ ok, capabilities:[{ id, availability, reason, setup }] })
 * -> { id: { available, reason } }, or null when the server has no contract. Only `installed` runs.
 */
export function capabilityMap(res) {
  if (!res || res.ok !== true || !Array.isArray(res.capabilities)) return null;
  const label = { requires_setup: 'needs setup', unavailable: 'unavailable on this server', planned: 'planned, not built yet' };
  return Object.fromEntries(res.capabilities.filter(c => c && c.id).map(c => {
    const available = c.availability === 'installed';
    return [c.id, { available, reason: available ? null : (c.reason || label[c.availability] || 'not available on this server'), setup: c.setup || null }];
  }));
}

/** All palette rows for this session, registry order. */
export function paletteItems(ctx = {}, registry = REGISTRY) {
  return registry.filter(e => e.kind === 'command').map(e => ({
    id: e.id,
    name: '/' + e.id,
    usage: e.usage,
    desc: e.desc,
    aliases: (e.aliases || []).map(a => '/' + a),
    planned: e.status === 'planned',
    disabled: e.status === 'planned' ? 'planned, not built yet' : unavailableReason(e, ctx)
  }));
}

/** Subsequence score of q in s (lower is better), or null when q is not a subsequence. */
export function fuzzy(q, s) {
  q = String(q).toLowerCase(); s = String(s).toLowerCase();
  if (!q) return 0;
  if (s.startsWith(q)) return 0;
  const at = s.indexOf(q);
  if (at >= 0) return 10 + at;
  let i = 0, gaps = 0, last = -1;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) { if (last >= 0) gaps += j - last - 1; last = j; i++; }
  }
  return i === q.length ? 100 + gaps : null;
}

/** Filter + rank. Planned rows appear only on an exact name or alias match. */
export function filterPalette(items, query) {
  const q = String(query ?? '').toLowerCase();
  const exact = (it) => it.id === q || it.aliases.includes('/' + q);
  const scored = [];
  items.forEach((it, idx) => {
    if (it.planned && !exact(it)) return;
    const names = [it.id, ...it.aliases.map(a => a.slice(1))];
    let best = null;
    for (const n of names) { const sc = fuzzy(q, n); if (sc != null && (best == null || sc < best)) best = sc; }
    if (best == null && q.length >= 3 && it.desc.toLowerCase().includes(q)) best = 500; // words in the description
    if (best == null) return;
    if (exact(it)) best = -1;
    if (it.disabled) best += 0.5; // a working command outranks an unavailable one on a tie
    scored.push({ it, best, idx });
  });
  return scored.sort((a, b) => a.best - b.best || a.idx - b.idx).map(x => x.it);
}

/** What Tab puts in the draft: the name, plus a space when the command takes arguments. */
export function completion(item) {
  const takesArgs = /^\S+\s+\S/.test(String(item.usage).trim());
  return item.name + (takesArgs ? ' ' : '');
}

/** View rows for the palette: a window of PALETTE_MAX around the selection. */
export function paletteView(rows, sel, max = PALETTE_MAX) {
  if (!rows.length) return { rows: [], sel: 0, more: 0, empty: true };
  const s = Math.max(0, Math.min(sel, rows.length - 1));
  const start = Math.max(0, Math.min(s - max + 1, rows.length - max));
  const win = rows.slice(Math.max(0, start), Math.max(0, start) + max);
  return { rows: win, sel: s - Math.max(0, start), more: rows.length - win.length, empty: false };
}
