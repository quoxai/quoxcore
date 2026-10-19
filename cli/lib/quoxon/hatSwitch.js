/**
 * /hat helpers (pure), quox#1183. Match a hat the way a person names it (key, display name, "the DevOps hat", a unique
 * prefix) and the lines /hat prints. Never guesses between ties; an unknown name is { none: true }.
 */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '').replace(/ hat$/, '').trim();

export const isPrivileged = (hat) => hat?.definition?.transitions?.privileged === true || hat?.privileged === true;

/** -> { hat } | { ambiguous: [hats] } | { none: true } */
export function matchHat(query, hats) {
  const rows = Array.isArray(hats) ? hats.filter(Boolean) : [];
  const raw = String(query ?? '').trim();
  const q = norm(raw);
  if (!q) return { none: true };
  const byId = rows.filter((h) => h.id && h.id === raw);
  if (byId.length === 1) return { hat: byId[0] };
  const exact = rows.filter((h) => norm(h.key) === q || norm(h.name) === q);
  if (exact.length === 1) return { hat: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };
  const pre = rows.filter((h) => norm(h.key).startsWith(q) || norm(h.name).startsWith(q));
  if (pre.length === 1) return { hat: pre[0] };
  if (pre.length > 1) return { ambiguous: pre };
  return { none: true };
}

/** "key (Name)" for each hat, for an error that tells you what to type. */
export const hatChoices = (hats) => (Array.isArray(hats) ? hats : []).map((h) => (h.name && h.name !== h.key ? `${h.key} (${h.name})` : h.key)).join(', ');

/** One line per hat; the active one is marked with *. */
export function hatLines(hats, activeKey) {
  const rows = Array.isArray(hats) ? hats : [];
  const w = Math.min(28, Math.max(4, ...rows.map((h) => [...String(h.name || h.key)].length)));
  return rows.map((h) => `${h.key === activeKey ? '* ' : '  '}${String(h.name || h.key).padEnd(w)}  ${h.key}${isPrivileged(h) ? '  (privileged: asks you first)' : ''}`);
}

/** A conversation id in the collector's own shape (turnStream ensureConversationId), for a window with none yet. */
export const mintConversationId = (uuid) => `QXC_${uuid}`;
