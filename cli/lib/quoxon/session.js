/**
 * Session name, new-session invite, agent matching. Pure helpers plus the local
 * name store (~/.config/quox/sessions.json, keyed by conversation id). The
 * collector has no conversation rename route, so names persist here.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const INVITE = 'Ⓠ /rename this session · /slot <name> for an address · /attach <agent>';
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
export function saveName(id, name, path = sessionsPath()) {
  try {
    const all = loadNames(path);
    all[id] = { name, updated_at: new Date().toISOString() };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message || 'failed' }; }
}

const lev = (a, b) => {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[a.length][b.length];
};

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
