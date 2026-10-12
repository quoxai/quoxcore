/**
 * awarenessStore.js: the QuoxAwareness ledger.
 *
 * Any surface or agent posts its last-known state (idempotent upsert by
 * org_id + key); readers (voice receptionist, dashboard widget, CLI) read a
 * compact current-state summary. Server is the source of truth. Binds its db
 * handle at ensure(db), mirroring voiceCallStore.js.
 */

let _db = null;

const SEVERITIES = ['info', 'warn', 'critical'];
const SCOPES = ['org', 'global'];

function ensure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS awareness_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT NOT NULL,
      key TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'org',
      title TEXT,
      state TEXT,
      detail TEXT,
      source TEXT,
      severity TEXT NOT NULL DEFAULT 'info',
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      UNIQUE(org_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_awareness_org_updated ON awareness_entries(org_id, updated_at DESC);
  `);
  _db = db;
}

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function requireDb() {
  if (!_db) throw fail('store_not_initialised', 'awareness store not ensured');
  return _db;
}

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

function rowToEntry(r) {
  if (!r) return null;
  return {
    id: r.id,
    org_id: r.org_id,
    key: r.key,
    scope: r.scope,
    title: r.title || '',
    state: r.state || '',
    detail: r.detail || '',
    source: r.source || '',
    severity: r.severity,
    updated_at: r.updated_at,
    expires_at: r.expires_at == null ? null : r.expires_at,
  };
}

function str(v, max) {
  return v == null ? null : String(v).slice(0, max);
}

function upsert(rec = {}) {
  const db = requireDb();
  const orgId = typeof rec.org_id === 'string' ? rec.org_id.trim() : '';
  const key = typeof rec.key === 'string' ? rec.key.trim() : '';
  if (!orgId) throw fail('bad_request', 'org_id required');
  if (!key) throw fail('bad_request', 'key required');
  const scope = SCOPES.includes(rec.scope) ? rec.scope : 'org';
  const severity = SEVERITIES.includes(rec.severity) ? rec.severity : 'info';
  const updatedAt = toMs(rec.updated_at) || Date.now();
  const ttl = Number(rec.ttl_s);
  const expiresAt = Number.isFinite(ttl) && ttl > 0 ? updatedAt + Math.round(ttl * 1000) : null;
  db.prepare(`
    INSERT INTO awareness_entries (org_id, key, scope, title, state, detail, source, severity, updated_at, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(org_id, key) DO UPDATE SET
      scope = excluded.scope, title = excluded.title, state = excluded.state,
      detail = excluded.detail, source = excluded.source, severity = excluded.severity,
      updated_at = excluded.updated_at, expires_at = excluded.expires_at
  `).run(
    orgId, key.slice(0, 200), scope,
    str(rec.title, 200), str(rec.state, 1000), str(rec.detail, 4000), str(rec.source, 80),
    severity, updatedAt, expiresAt
  );
  return get(orgId, key.slice(0, 200));
}

function listForOrg(orgId, { source, activeOnly = true } = {}) {
  const db = requireDb();
  const where = ['org_id = ?'];
  const args = [orgId];
  if (source) { where.push('source = ?'); args.push(String(source)); }
  if (activeOnly) { where.push('(expires_at IS NULL OR expires_at >= ?)'); args.push(Date.now()); }
  return db
    .prepare(`SELECT * FROM awareness_entries WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC`)
    .all(...args)
    .map(rowToEntry);
}

function get(orgId, key) {
  const db = requireDb();
  return rowToEntry(db.prepare('SELECT * FROM awareness_entries WHERE org_id = ? AND key = ?').get(orgId, key));
}

function remove(orgId, key) {
  const db = requireDb();
  return db.prepare('DELETE FROM awareness_entries WHERE org_id = ? AND key = ?').run(orgId, key).changes > 0;
}

function ageLabel(updatedAt, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const SEV_RANK = { critical: 0, warn: 1, info: 2 };

function summarize(orgId) {
  const now = Date.now();
  const rows = listForOrg(orgId);
  const entries = rows.map((r) => ({
    key: r.key,
    title: r.title,
    state: r.state,
    severity: r.severity,
    source: r.source,
    updated_at: r.updated_at,
    age_label: ageLabel(r.updated_at, now),
  }));
  const counts = { total: entries.length, info: 0, warn: 0, critical: 0 };
  for (const e of entries) counts[e.severity] += 1;
  if (!entries.length) return { text: 'No current awareness entries.', entries, counts };
  const ordered = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (SEV_RANK[a.e.severity] - SEV_RANK[b.e.severity]) || (a.i - b.i))
    .map((x) => x.e);
  const lines = ordered.map((e) => `${e.title || e.key}: ${e.state} (${e.age_label})`);
  return { text: `Current awareness (${entries.length} items):\n${lines.join('\n')}`, entries, counts };
}

module.exports = { ensure, upsert, listForOrg, get, remove, summarize };
