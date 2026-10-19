/**
 * Session name, new-session invite, agent matching. Pure helpers plus the local
 * name store (~/.config/quox/sessions.json, keyed by conversation id). The
 * collector has no conversation rename route, so names persist here.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const INVITE = 'Ⓠ /rename this session · /slot <name> for an address · /attach <agent>';
/** The new-session invite; the /slot segment only where slots are licensed (Z2H-R5 C). */
export const inviteText = ({ slots = true } = {}) => (slots ? INVITE : 'Ⓠ /rename this session · /attach <agent>');
export const MAX_NAME = 40;

export const sessionsPath = () => join(homedir(), '.config', 'quox', 'sessions.json');

/** Free text -> a one-line name, or null when nothing usable is left. */
export function cleanName(raw) {
  const s = String(raw ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? [...s].slice(0, MAX_NAME).join('') : null;
}

export function loadNames(path = sessionsPath()) {
  try {
    const d = JSON.parse(readFileSync(path, 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}

/** -> { ok:true } | { ok:false, error }. Atomic write; never throws. */
export function saveName(id, name, path = sessionsPath(), meta = {}) {
  try {
    const all = loadNames(path);
    all[id] = { name, ...(meta.profile ? { profile: meta.profile } : {}), ...(meta.org ? { org: meta.org } : {}), updated_at: new Date().toISOString() };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message || 'failed' }; }
}

/**
 * Resolve a saved name to a conversation. Entries saved under this profile (or legacy entries with no profile)
 * win, newest updated_at first. Only other-profile entries left: one profile -> newest; several -> ambiguous.
 * -> { id, entry } | { ambiguous: [ids] } | null
 */
export function pickNamed(names, want, profile) {
  const w = String(want).trim().toLowerCase();
  const all = Object.entries(names || {}).filter(([, v]) => v?.name && String(v.name).toLowerCase() === w);
  if (!all.length) return null;
  const newest = (xs) => xs.slice().sort((a, b) => String(b[1].updated_at || '').localeCompare(String(a[1].updated_at || '')))[0];
  const mine = all.filter(([, v]) => !v.profile || v.profile === profile);
  if (mine.length) { const [id, entry] = newest(mine); return { id, entry }; }
  if (new Set(all.map(([, v]) => v.profile)).size > 1) return { ambiguous: all.map(([id]) => id) };
  const [id, entry] = newest(all); return { id, entry };
}

const lev = (a, b) => {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[a.length][b.length];
};

/** Names compare ignoring case, hyphens, underscores and spaces: "triageq" is "triage-q". */
export const squash = (s) => String(s ?? '').toLowerCase().replace(/[-_\s]+/g, '');

/** The ONE name in `names` that equals `input` once squashed (exact match wins first); null when none or several. */
export function uniqueSquash(input, names) {
  const q = squash(input);
  if (!q) return null;
  const list = (names || []).map(n => String(n));
  const exact = list.find(n => n.toLowerCase() === String(input).trim().toLowerCase());
  if (exact) return exact;
  const hits = [...new Set(list.filter(n => squash(n) === q))];
  return hits.length === 1 ? hits[0] : null;
}

/**
 * QUOXON-SAY-BY-SESSION: resolve what the user typed after /say to a slot. A slot name wins (exact, then a unique
 * squash match); otherwise the slot HELD by a session of that name ("/say SITE-CLI" reaches slot cli-site).
 * -> slot name | null.
 */
export function slotForName(input, rows, senders = null) {
  return resolveSayTarget(input, rows, senders)?.slot || null;
}

/**
 * SLOTS-REPLY: the full resolution behind slotForName. Order: a slot name, then the session HOLDING a slot, then a
 * name that recently SPOKE with a verified from_slot (`senders`: slot messages, oldest first). The slot is the
 * address; `name` is the session/sender name it was reached by (null for a plain slot name).
 * -> { slot, via: 'slot'|'session'|'sender', name } | null.
 */
export function resolveSayTarget(input, rows, senders = null) {
  const list = Array.isArray(rows) ? rows : [];
  const byName = uniqueSquash(input, list.map(r => r?.name).filter(Boolean));
  if (byName) return { slot: byName, via: 'slot', name: null };
  const held = list.filter(r => r?.name && r?.holder_session && r?.state !== 'free');
  const who = uniqueSquash(input, held.map(r => r.holder_session));
  if (who) {
    const slots = [...new Set(held.filter(r => r.holder_session === who).map(r => r.name))];
    return slots.length === 1 ? { slot: slots[0], via: 'session', name: who } : null;
  }
  // A sender is known by its full label ("quox1 (Adam)") and by its head ("quox1"); the newest message wins.
  const spoke = new Map();
  for (const m of Array.isArray(senders) ? senders : []) {
    const f = String(m?.from || '').trim();
    if (!f || !m?.from_slot) continue;
    spoke.set(f, m.from_slot);
    const head = f.replace(/\s*\(.*\)\s*$/, '');
    if (head && head !== f) spoke.set(head, m.from_slot);
  }
  const by = uniqueSquash(input, [...spoke.keys()]);
  return by ? { slot: spoke.get(by), via: 'sender', name: by } : null;
}

/** SLOTS-REPLY: how an address is shown everywhere: the slot first, the session/display name in brackets. */
export function addressLabel(slot, name) {
  const s = String(slot || ''); const n = String(name || '').trim();
  if (!n || n === s || n.startsWith(`${s} (`)) return n.startsWith(`${s} (`) ? n : s;
  return `${s} (${n})`;
}

/**
 * QUOXON-SAY-MISS: /say to a name that is neither a slot nor a session holding one. Say so plainly, suggest a close
 * match, list who IS reachable (slot and the session holding it), and how the other session becomes reachable.
 */
export function sayMissText(input, rows, cap = 8) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => r?.name);
  const held = list.filter(r => r.holder_session && r.state !== 'free');
  const near = nearest(input, [...new Set([...list.map(r => r.name), ...held.map(r => r.holder_session)])], 2);
  const reach = held.slice(0, cap).map(r => `${r.name} (${r.holder_session})`).join(', ');
  return [
    `Nothing called "${input}" can get a /say: it is not a slot, and no session by that name holds one.`,
    near.length ? `Did you mean ${near.join(' or ')}?` : null,
    `If ${input} is a running session, it needs a slot first; ask it to run: quox slot checkout <name> --create --session ${input}`,
    reach ? `Reachable now: ${reach}${held.length > cap ? `, +${held.length - cap} more (/slots)` : ''}` : null,
  ].filter(Boolean).join('\n');
}

const idOf = (a) => String(a?.agent_id ?? a?.id ?? a?.name ?? '');
const nameOf = (a) => String(a?.name ?? a?.agent_id ?? a?.id ?? '');

/**
 * -> { agent: { id, name } } on an exact (case-insensitive) id or name match,
 * else { matches: [ids] } with the closest names (may be empty).
 */
export function matchAgent(input, agents) {
  const q = String(input || '').trim().toLowerCase();
  const list = Array.isArray(agents) ? agents : [];
  const hit = list.find(a => idOf(a).toLowerCase() === q || nameOf(a).toLowerCase() === q);
  if (hit) return { agent: { id: idOf(hit), name: nameOf(hit) } };
  const sq = squash(q);
  const loose = sq ? list.filter(a => squash(idOf(a)) === sq || squash(nameOf(a)) === sq) : [];
  if (new Set(loose.map(idOf)).size === 1) return { agent: { id: idOf(loose[0]), name: nameOf(loose[0]) } };
  const scored = list.map(a => {
    const ks = [idOf(a).toLowerCase(), nameOf(a).toLowerCase()];
    const d = Math.min(...ks.map(k => (k.includes(q) || (k && q.includes(k)) ? 0 : lev(q, k))));
    return { id: idOf(a), d };
  }).filter(x => x.d <= Math.max(2, Math.floor(q.length / 3))).sort((x, y) => x.d - y.d || x.id.localeCompare(y.id));
  return { matches: scored.slice(0, 3).map(x => x.id) };
}

/**
 * "/attach" argument -> { kind: 'slot'|'agent'|null, name, rest }. The FIRST token is the name; anything after it
 * is a message for the target. `slot:x` / `agent:x` force the kind.
 */
export function parseTarget(input) {
  const m = String(input || '').trim().match(/^(\S+)\s*([\s\S]*)$/);
  if (!m) return { kind: null, name: '', rest: '' };
  const p = m[1].match(/^(slot|agent):(.*)$/i);
  return p ? { kind: p[1].toLowerCase(), name: p[2], rest: m[2].trim() } : { kind: null, name: m[1], rest: m[2].trim() };
}

/** Closest names to `input` among plain strings: substring either way, else edit distance. Best first, max 3. */
export function nearest(input, names, max = 3) {
  const q = String(input || '').trim().toLowerCase();
  if (!q) return [];
  return (names || []).map(n => String(n)).map(n => { const k = n.toLowerCase(); return { n, d: k.includes(q) || (k && q.includes(k)) ? 0 : lev(q, k) }; })
    .filter(x => x.d <= Math.max(2, Math.floor(q.length / 3))).sort((a, b) => a.d - b.d || a.n.localeCompare(b.n)).slice(0, max).map(x => x.n);
}

/** Why a list call failed, in words a person can act on. 401/403 is "signed out", never a missing item. */
export function listFailure(e, profile = null) {
  const st = e?.status;
  if (st === 401 || st === 403) return `signed out (HTTP ${st}). Run quox login -p ${profile || '<profile>'}.`;
  if (st) return `HTTP ${st}`;
  return /timed out/i.test(e?.message || '') ? 'timed out' : (e?.message || 'failed');
}

/** More free slots than this fold into one "+N free" line in /slots (TUI-UX #8). */
export const FREE_COLLAPSE_OVER = 5;

/**
 * /slots as aligned columns, held first then newest use first (owner 2026-10-16: "messy output. I want columns. And last used
 * date/time"). Without `cols` every slot prints in the full-width layout. With `cols` (TUI-UX #8) the table fits the terminal:
 * the full layout when it fits, else a compact one (no HOST / absolute time, names clipped with an ellipsis), and free slots
 * collapse into one "+N free" line unless `all`. Unread is never shown on a free slot.
 */
export function slotsTable(rows, { mine = null, now = Date.now(), cols = null, all = false } = {}) {
  const t = (r) => Math.max(...['last_heartbeat_at', 'last_read_at', 'checked_out_at', 'released_at', 'created_at'].map(k => Date.parse(r[k] || '') || 0));
  const ago = (ms) => { if (!ms) return '-'; const m = Math.max(0, Math.floor((now - ms) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
  const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '-');
  const isHeld = (r) => Boolean(r.holder_session && r.state !== 'free');
  const sorted = [...rows].filter(r => r?.name).sort((a, b) => (isHeld(b) - isHeld(a)) || (t(b) - t(a)));
  const limited = Number.isFinite(cols) && cols > 0;
  const freeCount = sorted.filter(r => !isHeld(r)).length;
  const collapse = limited && !all && freeCount > FREE_COLLAPSE_OVER; // a handful of free slots stay listed: folding one row into a summary saves nothing
  const shown = collapse ? sorted.filter(isHeld) : sorted;
  const unread = (r) => (r.unread_count && isHeld(r) ? String(r.unread_count) : '');
  const nameOf = (r) => r.name + (r.name === mine ? ' *' : '');
  const layout = (heads, cellsOf) => {
    const head = heads, body = shown.map(cellsOf);
    return { head, body, w: head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length))) };
  };
  let L = layout(['', 'SLOT', 'HOLDER', 'HOST', 'LAST USED (UTC)', 'AGO', 'UNREAD'],
    r => [isHeld(r) ? '●' : '○', nameOf(r), isHeld(r) ? r.holder_session : 'free', r.host_id || '-', when(t(r)), ago(t(r)), unread(r)]);
  const width = (w) => w.reduce((a, b) => a + b, 0) + 2 * (w.length - 1);
  let compact = false;
  if (limited && width(L.w) > cols) {
    compact = true;
    L = layout(['', 'SLOT', 'HOLDER', 'AGO', 'UNREAD'], r => [isHeld(r) ? '●' : '○', nameOf(r), isHeld(r) ? r.holder_session : 'free', ago(t(r)), unread(r)]);
    // still too wide: shrink the two name columns (widest first) with a trailing ellipsis, never below 6
    while (width(L.w) > cols) {
      const k = L.w[1] >= L.w[2] ? 1 : 2;
      if (L.w[k] <= 6) break;
      L.w[k] -= 1;
    }
  }
  const fit = (cell, n) => (cell.length > n ? cell.slice(0, Math.max(1, n - 1)) + '…' : cell);
  const fmt = (cells) => cells.map((c, i) => (compact && (i === 1 || i === 2) ? fit(c, L.w[i]) : c).padEnd(L.w[i])).join('  ').trimEnd();
  const out = [fmt(L.head), ...L.body.map(fmt)];
  if (collapse) out.push(`+${freeCount} free (/slots all)`);
  return out;
}
