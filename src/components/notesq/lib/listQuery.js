/** Pure helpers for the NotesQ list/facet queries. */

export const SCOPES = ['all', 'user', 'org'];
export const ARCHIVED_MODES = ['exclude', 'only', 'include'];

/**
 * Build the query string for GET /notes. Empty/default values are omitted so
 * URLs (and cache keys) stay stable.
 */
export function buildListQuery({
  scope = 'all', q = '', collection = '', tag = '', pinned = false,
  archived = 'exclude', limit = 50, offset = 0,
} = {}) {
  const p = new URLSearchParams();
  p.set('scope', SCOPES.includes(scope) ? scope : 'all');
  const query = String(q || '').trim();
  if (query) p.set('q', query);
  if (collection) p.set('collection', collection);
  if (tag) p.set('tag', tag);
  if (pinned) p.set('pinned', 'true');
  if (archived && archived !== 'exclude' && ARCHIVED_MODES.includes(archived)) p.set('archived', archived);
  if (limit) p.set('limit', String(limit));
  if (offset) p.set('offset', String(offset));
  return p.toString();
}

/** Default scope for a new note: follows the filter, 'org' when All. */
export function defaultNewScope(scopeFilter) {
  return scopeFilter === 'user' ? 'user' : 'org';
}

/** First markdown heading, else first non-empty line, else 'Untitled'. */
export function deriveTitle(markdown) {
  const lines = String(markdown || '').split('\n');
  for (const line of lines) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  const first = lines.find((l) => l.trim());
  return first ? first.trim().slice(0, 80) : 'Untitled';
}

/** Compact relative time ("just now", "5m ago", "3d ago", else a date). */
export function relativeTime(iso, now = Date.now()) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** Normalise tag input: trim, strip leading '#', lowercase, no spaces, de-dupe. */
export function normaliseTags(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const t = String(raw).trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-');
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}
