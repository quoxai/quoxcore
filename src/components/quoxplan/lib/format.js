/** Small formatting helpers shared across views. */

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

export function flattenStreams(nested) {
  const out = [];
  for (const s of nested) {
    out.push(s);
    if (s.substreams?.length) out.push(...flattenStreams(s.substreams));
  }
  return out;
}

export function countAll(nested) {
  return flattenStreams(nested).length;
}
