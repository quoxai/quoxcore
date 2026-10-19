/** /org helpers (pure). Org list rows, fuzzy match, and the lines the command prints. QUOXON-FW3. */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const orgRows = (list) => (Array.isArray(list) ? list : []).map((o) => ({ id: o.id, name: o.name || o.slug || o.id, slug: o.slug || null, role: o.role || null }));

/**
 * Resolve a typed name or id against the user's orgs. Exact id, exact slug/name, then every word of the
 * query found in the name or slug (so "hot tubs hampshire" finds "Hot Tubs Hampshire Ltd"). Never guesses between ties.
 * -> { org } | { ambiguous: [orgs] } | { none: true }
 */
export function matchOrg(query, list) {
  const rows = orgRows(list);
  const q = norm(query);
  if (!q) return { none: true };
  // An exact slug wins outright, so a slug never ties with another org's look-alike name (#1141).
  const bySlug = rows.filter((o) => o.slug && o.slug === String(query).trim());
  if (bySlug.length === 1) return { org: bySlug[0] };
  const exact = rows.filter((o) => String(o.id).toLowerCase() === String(query).trim().toLowerCase() || norm(o.slug) === q || norm(o.name) === q);
  if (exact.length === 1) return { org: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };
  const words = q.split(' ');
  const fuzzy = rows.filter((o) => { const hay = `${norm(o.name)} ${norm(o.slug)}`; return words.every((w) => hay.includes(w)); });
  if (fuzzy.length === 1) return { org: fuzzy[0] };
  if (fuzzy.length > 1) return { ambiguous: fuzzy };
  return { none: true };
}

/** One line per org; the current one is marked. */
export function orgLines(list, currentId) {
  const rows = orgRows(list);
  const w = Math.min(36, Math.max(4, ...rows.map((o) => [...o.name].length)));
  return rows.map((o) => `${o.id === currentId ? '* ' : '  '}${o.name.padEnd(w)}  ${o.slug || o.id}${o.role ? `  (${o.role})` : ''}`);
}
