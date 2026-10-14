/**
 * E5 local state: when this profile was last seen in the client (~/.config/quox/away.json, keyed by
 * profile). Only a timestamp is kept; the digest itself always comes from the server. Writes are
 * best-effort: a read-only home must never break the client.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const AWAY_AFTER_MS = 2 * 3600000;
export const awayStatePath = () => join(homedir(), '.config', 'quox', 'away.json');

function readAll(path) {
  try { const j = JSON.parse(readFileSync(path, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; }
}

/** -> epoch ms or null (never seen, or unreadable). */
export function readLastSeen(profile, path = awayStatePath()) {
  const v = readAll(path)[profile || 'default'];
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function writeLastSeen(profile, ts = Date.now(), path = awayStatePath()) {
  try {
    const all = readAll(path);
    all[profile || 'default'] = new Date(ts).toISOString();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all) + '\n');
    renameSync(tmp, path);
    return true;
  } catch { return false; }
}

/** Show the launch card only when the last session ended more than 2 h ago (never on a first launch). */
export const awayDue = (lastSeen, now = Date.now()) => lastSeen != null && now - lastSeen > AWAY_AFTER_MS;

/**
 * /away [since]: a window (90m, 3h, 2d), an ISO time, or nothing (last seen, else 24 h).
 * -> { ok: true, since: iso } | { ok: false, error }
 */
export function parseSince(arg, { now = Date.now(), lastSeen = null } = {}) {
  const a = String(arg || '').trim();
  if (!a) return { ok: true, since: new Date(lastSeen ?? now - 24 * 3600000).toISOString() };
  const m = a.match(/^(\d+)\s*([mhd])$/i);
  if (m) return { ok: true, since: new Date(now - Number(m[1]) * { m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()]).toISOString() };
  const t = /^\d{4}-\d\d-\d\d/.test(a) ? Date.parse(a) : NaN;
  if (!Number.isFinite(t)) return { ok: false, error: `Usage: /away [since]  (e.g. /away 3h, /away 2d, /away 2026-10-13T08:00:00Z)` };
  if (t > now) return { ok: false, error: 'That time is in the future.' };
  return { ok: true, since: new Date(t).toISOString() };
}
