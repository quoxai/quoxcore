/**
 * AUD-PDF audit fix: PDF export cache
 *
 * Single voltDb table + insert/select helpers. Keyed by a hash of
 * (format, cache_input) so callers can pass whatever input uniquely
 * identifies the render (e.g. report JSON, soa id + version,
 * dpia id + version). On a cache hit the dispatcher streams the
 * stored bytes straight back — bypassing pdfkit (~5s saved for a
 * 30-day ISO report).
 *
 * Retention: 365 days, matches AEE/WARD retention windows.
 */

const crypto = require('crypto');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
}

function canonicalize(val) {
  if (val === null || val === undefined) return JSON.stringify(val);
  if (typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return '[' + val.map((v) => canonicalize(v)).join(',') + ']';
  const sorted = Object.keys(val).filter((k) => val[k] !== undefined).sort();
  return '{' + sorted.map((k) => JSON.stringify(k) + ':' + canonicalize(val[k])).join(',') + '}';
}

function initPdfCache(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pdf_exports (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      format TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      pdf_bytes BLOB NOT NULL,
      bytes_length INTEGER NOT NULL,
      page_count INTEGER,
      redacted INTEGER NOT NULL DEFAULT 0,
      generated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_cache_key ON pdf_exports(org_id, cache_key);
    CREATE INDEX IF NOT EXISTS idx_pdf_org_time ON pdf_exports(org_id, generated_at DESC);
  `);
}

function computeCacheKey({ format, input }) {
  return sha256Hex(format + '|' + canonicalize(input));
}

function generateCacheId() {
  return `PDF_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Look up a cached render. Returns { bytes, manifest_hash, page_count,
 * redacted, generated_at } or null on miss.
 */
function getCached(db, { org_id, cache_key }) {
  if (!db || !org_id || !cache_key) return null;
  const row = db
    .prepare(`SELECT pdf_bytes, manifest_hash, page_count, redacted, generated_at
              FROM pdf_exports WHERE org_id = ? AND cache_key = ?`)
    .get(org_id, cache_key);
  if (!row) return null;
  return {
    bytes: row.pdf_bytes,
    manifest_hash: row.manifest_hash,
    page_count: row.page_count,
    redacted: row.redacted === 1,
    generated_at: row.generated_at,
  };
}

/**
 * Store a freshly-rendered PDF. UPSERT on (org_id, cache_key) so the
 * freshest bytes always win — same inputs may bump if the renderer
 * itself changes.
 */
function putCached(db, { org_id, format, cache_key, manifest_hash, pdf_bytes, page_count, redacted }) {
  if (!db) return null;
  const id = generateCacheId();
  db.prepare(`
    INSERT INTO pdf_exports (id, org_id, format, cache_key, manifest_hash, pdf_bytes, bytes_length, page_count, redacted, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(org_id, cache_key) DO UPDATE SET
      manifest_hash = excluded.manifest_hash,
      pdf_bytes = excluded.pdf_bytes,
      bytes_length = excluded.bytes_length,
      page_count = excluded.page_count,
      redacted = excluded.redacted,
      generated_at = excluded.generated_at
  `).run(
    id, org_id, format, cache_key, manifest_hash,
    pdf_bytes, pdf_bytes.length, page_count || null, redacted ? 1 : 0,
  );
  return id;
}

/**
 * Purge cached exports older than the given days. Called by the daily
 * retention runner in server.js alongside pruneAEEDatabase +
 * pruneGovernanceIncidents.
 */
function prunePdfCache(db, { olderThanDays = 365 } = {}) {
  if (!db) return 0;
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(`DELETE FROM pdf_exports WHERE generated_at < ?`).run(cutoff);
  return result.changes;
}

module.exports = {
  initPdfCache,
  computeCacheKey,
  getCached,
  putCached,
  prunePdfCache,
};
