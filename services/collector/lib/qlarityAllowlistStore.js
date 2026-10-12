'use strict';

/**
 * qlarityAllowlistStore.js — the per-org QLarity egress allowlist.
 *
 * Why this exists: QLARITY_ALLOWLIST was an install-wide env var, so the one
 * thing a new customer must do to use QLarity (declare an origin) was the one
 * thing they could not do without shell access to the host. See
 * migrations/aee/016-qlarity-org-allowlist.sql for the full reasoning and the
 * deliberately narrow scope.
 *
 * Same DI shape as devSlotBridgesStore.js: every function is bound to a db
 * handle via the factory, so tests run against a throwaway better-sqlite3 db
 * with zero module state.
 *
 * ORIGIN NORMALISATION is the load-bearing part of this file. An allowlist
 * whose entries do not match what the guard compares against is worse than an
 * empty one, because the user believes they configured something. So entries
 * are normalised once, here, on the way in: trimmed, lowercased host, no
 * trailing slash, no path, no credentials. A value we cannot make sense of is
 * REFUSED with a reason rather than stored to fail silently later.
 */

// Deliberately permissive about scheme (a bare hostname is the common case and
// what the existing env var accepts) and strict about everything else.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Turn user input into the canonical form the guard will see, or explain why
 * it cannot be one. Returns { ok, origin } or { ok: false, reason }.
 */
function normaliseOrigin(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'origin must be a string' };
  let v = raw.trim();
  if (!v) return { ok: false, reason: 'origin is empty' };
  if (v.length > 255) return { ok: false, reason: 'origin is unreasonably long' };

  // A wildcard is the thing people reach for when a specific origin is
  // fiddly, and it is exactly what default-deny exists to prevent. Refuse it
  // with the reason rather than storing something that silently means "all".
  if (v.includes('*')) {
    return { ok: false, reason: 'wildcards are not allowed: declare each origin explicitly, that is the point of default-deny' };
  }

  let scheme = '';
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(v);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      return { ok: false, reason: `unsupported scheme "${scheme}": use http or https, or just the hostname` };
    }
    v = v.slice(schemeMatch[0].length);
  }

  if (v.includes('@')) return { ok: false, reason: 'credentials in an origin are not accepted' };

  // Drop any path/query/fragment: the guard matches on origin, so keeping a
  // path would produce an entry that can never match.
  v = v.split(/[/?#]/)[0];

  let port = '';
  const portMatch = /:(\d{1,5})$/.exec(v);
  if (portMatch) {
    port = portMatch[1];
    v = v.slice(0, -(portMatch[0].length));
    if (Number(port) < 1 || Number(port) > 65535) return { ok: false, reason: `invalid port ${port}` };
  }

  const host = v.toLowerCase();
  if (!host) return { ok: false, reason: 'no hostname found' };
  if (!HOSTNAME_RE.test(host)) {
    return { ok: false, reason: `"${host}" is not a valid hostname` };
  }

  const origin = (scheme ? `${scheme}://` : '') + host + (port ? `:${port}` : '');
  return { ok: true, origin };
}

function rowToEntry(row) {
  if (!row) return null;
  return {
    origin: row.origin,
    added_at: row.added_at,
    added_by: row.added_by || null,
    note: row.note || null,
  };
}

function createQlarityAllowlistStore({ getDb, now = () => new Date().toISOString() } = {}) {
  if (typeof getDb !== 'function') throw new Error('createQlarityAllowlistStore: getDb function is required');

  function db() {
    const handle = getDb();
    if (!handle) throw new Error('qlarityAllowlistStore: db not available');
    return handle;
  }

  function listOrigins({ orgId } = {}) {
    if (!orgId) throw new Error('listOrigins: orgId is required');
    return db()
      .prepare('SELECT * FROM qlarity_org_allowlist WHERE org_id = ? ORDER BY origin')
      .all(orgId)
      .map(rowToEntry);
  }

  /** Just the origin strings, for injection into a session create. */
  function originsFor({ orgId } = {}) {
    if (!orgId) return [];
    return listOrigins({ orgId }).map((e) => e.origin);
  }

  function addOrigin({ orgId, origin, addedBy, note } = {}) {
    if (!orgId) throw new Error('addOrigin: orgId is required');
    const n = normaliseOrigin(origin);
    if (!n.ok) return { ok: false, code: 'bad_origin', reason: n.reason };

    db().prepare(`
      INSERT INTO qlarity_org_allowlist (org_id, origin, added_at, added_by, note)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(org_id, origin) DO UPDATE SET
        added_at = excluded.added_at,
        added_by = excluded.added_by,
        note = excluded.note
    `).run(orgId, n.origin, now(), addedBy || null, note || null);

    const row = db().prepare(
      'SELECT * FROM qlarity_org_allowlist WHERE org_id = ? AND origin = ?'
    ).get(orgId, n.origin);
    return { ok: true, entry: rowToEntry(row) };
  }

  function removeOrigin({ orgId, origin } = {}) {
    if (!orgId) throw new Error('removeOrigin: orgId is required');
    // Normalise on the way out too, so removing works with whatever form the
    // user typed rather than only the canonical one they never saw.
    const n = normaliseOrigin(origin);
    const target = n.ok ? n.origin : String(origin || '').trim();
    const res = db()
      .prepare('DELETE FROM qlarity_org_allowlist WHERE org_id = ? AND origin = ?')
      .run(orgId, target);
    return { ok: true, removed: res.changes > 0, origin: target };
  }

  return { listOrigins, originsFor, addOrigin, removeOrigin };
}

module.exports = {
  normaliseOrigin,
  createQlarityAllowlistStore,
};
