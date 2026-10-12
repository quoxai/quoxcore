/**
 * Small formatting helpers shared across views. Ported verbatim from
 * quox-signal/web/src/lib/format.js.
 */

export function relativeTime(iso, now = new Date()) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const nowMs = new Date(now).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = nowMs - then;
  const abs = Math.abs(diffMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const suffix = diffMs >= 0 ? 'ago' : 'from now';

  if (abs < minute) return 'just now';
  if (abs < hour) return `${Math.round(abs / minute)}m ${suffix}`;
  if (abs < day) return `${Math.round(abs / hour)}h ${suffix}`;
  if (abs < 30 * day) return `${Math.round(abs / day)}d ${suffix}`;
  const months = Math.round(abs / (30 * day));
  if (months < 12) return `${months}mo ${suffix}`;
  return `${Math.round(months / 12)}y ${suffix}`;
}

/** m:ss for a duration in seconds, or "~" when unknown — never a wrong number. */
export function formatDuration(durationS) {
  if (durationS === null || durationS === undefined || Number.isNaN(durationS)) return '~';
  const total = Math.round(durationS);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Seconds to M:SS. The transcript panel was printing raw seconds ("0", "4.64"), which
 * undercuts the one claim this product actually rests on: a verbatim quote AT a timestamp.
 * A number like 4.64 is not a timestamp a human can act on.
 */
export function timecode(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return '';
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Split a post title into its substance and its hashtag tail.
 *
 * WHY: creator titles are frequently "real point here #ai #claudecode #vibecoding #tech",
 * and rendering the whole thing bold makes the hashtag wall the loudest object on a triage
 * row. The tags are not worthless, they are just not the thing you scan for, so they get
 * demoted rather than deleted.
 */
export function splitTitle(title) {
  const t = String(title || '');
  const i = t.search(/\s#/);
  if (i === -1) return { head: t, tags: '' };
  return { head: t.slice(0, i).trim(), tags: t.slice(i).trim() };
}
