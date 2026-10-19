'use strict';

/**
 * agentFetchAllowlistStore.js — per-org URL-prefix allowlist for the governed
 * agent fetch tool (web_fetch_allowlisted, quox#1171). Same DI shape as
 * qlarityAllowlistStore.js: every function is bound to a db handle.
 *
 * An entry is scheme + host + port + path. Never a bare host, never a
 * wildcard. Default ports are explicit (https=443, http=80): URL parsing
 * canonicalises them away, so https://h/ and https://h:443/ are one entry and
 * https://h/ never admits http://h:8080/ or https://h:8443/.
 *
 * matches() is the security-relevant function: same origin AND path-segment
 * aware prefix (/api does not match /apix), and any URL carrying credentials
 * or an encoded dot/slash/backslash segment is refused, because an upstream
 * that decodes those could walk out of the allowed prefix.
 */

function parseHttpUrl(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'url must be a string' };
  const v = raw.trim();
  if (!v) return { ok: false, reason: 'url is empty' };
  if (v.length > 2048) return { ok: false, reason: 'url is unreasonably long' };
  if (!/^https?:\/\/[^/?#]/i.test(v)) {
    return { ok: false, reason: 'a full http:// or https:// URL prefix is required (a bare host is not accepted)' };
  }
  if (v.includes('*')) return { ok: false, reason: 'wildcards are not allowed: name each prefix explicitly' };
  let u;
  try { u = new URL(v); } catch { return { ok: false, reason: 'not a valid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'only http or https is allowed' };
  if (u.username || u.password) return { ok: false, reason: 'credentials in a URL are not accepted' };
  if (!u.hostname) return { ok: false, reason: 'URL has no host' };
  return { ok: true, url: u };
}

/** Returns { ok, prefix } or { ok: false, reason }. */
function normalisePrefix(raw) {
  const p = parseHttpUrl(raw);
  if (!p.ok) return p;
  const u = p.url;
  const pathname = u.pathname || '/';
  return { ok: true, prefix: `${u.origin}${pathname.startsWith('/') ? pathname : `/${pathname}`}` };
}

const ENCODED_ESCAPE_RE = /%(2e|2f|5c)/i;

function pathWithin(entryPath, urlPath) {
  const base = entryPath.endsWith('/') ? entryPath : `${entryPath}/`;
  return urlPath === entryPath || urlPath.startsWith(base);
}

function rowToEntry(row) {
  if (!row) return null;
  return { url_prefix: row.url_prefix, added_at: row.added_at || null, added_by: row.added_by || null, note: row.note || null, allow_private: row.allow_private === 1 };
}

function createAgentFetchAllowlistStore({ getDb, now = () => new Date().toISOString() } = {}) {
  if (typeof getDb !== 'function') throw new Error('createAgentFetchAllowlistStore: getDb function is required');

  function db() {
    const handle = getDb();
    if (!handle) throw new Error('agentFetchAllowlistStore: db not available');
    return handle;
  }

  function listPrefixes({ orgId } = {}) {
    if (!orgId) throw new Error('listPrefixes: orgId is required');
    return db().prepare('SELECT * FROM agent_fetch_allowlist WHERE org_id = ? ORDER BY url_prefix').all(orgId).map(rowToEntry);
  }

  // allowPrivate: true ONLY when an INSTANCE admin added the entry (the routes decide); it is what
  // lets a fetch reach a private range (RFC1918, CGNAT, ULA). Re-adding resets it to the new value.
  function addPrefix({ orgId, prefix, addedBy, note, allowPrivate = false } = {}) {
    if (!orgId) throw new Error('addPrefix: orgId is required');
    const n = normalisePrefix(prefix);
    if (!n.ok) return { ok: false, code: 'bad_prefix', reason: n.reason };
    db().prepare(`
      INSERT INTO agent_fetch_allowlist (org_id, url_prefix, added_by, added_at, note, allow_private)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id, url_prefix) DO UPDATE SET
        added_by = excluded.added_by, added_at = excluded.added_at, note = excluded.note,
        allow_private = excluded.allow_private
    `).run(orgId, n.prefix, addedBy || null, now(), note || null, allowPrivate === true ? 1 : 0);
    const row = db().prepare('SELECT * FROM agent_fetch_allowlist WHERE org_id = ? AND url_prefix = ?').get(orgId, n.prefix);
    return { ok: true, entry: rowToEntry(row) };
  }

  function removePrefix({ orgId, prefix } = {}) {
    if (!orgId) throw new Error('removePrefix: orgId is required');
    const n = normalisePrefix(prefix);
    const target = n.ok ? n.prefix : String(prefix || '').trim();
    const res = db().prepare('DELETE FROM agent_fetch_allowlist WHERE org_id = ? AND url_prefix = ?').run(orgId, target);
    return { ok: true, removed: res.changes > 0, prefix: target };
  }

  // The matching entry (an instance-admin one preferred when several match), or null.
  function matchEntry({ orgId, url } = {}) {
    if (!orgId || typeof orgId !== 'string') return null;
    const p = parseHttpUrl(url);
    if (!p.ok) return null;
    if (ENCODED_ESCAPE_RE.test(p.url.pathname)) return null;
    const rows = db().prepare('SELECT * FROM agent_fetch_allowlist WHERE org_id = ?').all(orgId);
    let best = null;
    for (const r of rows) {
      let e;
      try { e = new URL(r.url_prefix); } catch { continue; }
      if (e.origin === p.url.origin && pathWithin(e.pathname, p.url.pathname)) {
        if (!best || (r.allow_private === 1 && best.allow_private !== 1)) best = r;
      }
    }
    return rowToEntry(best);
  }

  function matches({ orgId, url } = {}) {
    return !!matchEntry({ orgId, url });
  }

  return { listPrefixes, addPrefix, removePrefix, matches, matchEntry };
}

module.exports = { normalisePrefix, createAgentFetchAllowlistStore };
