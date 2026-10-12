/**
 * qlusterReadApi.js — Qluster Phase 3 box-side patch
 *
 * Three read-only, read-token-gated endpoints consumed by the external
 * Qluster fleet controller for cross-instance audit/config checks:
 *
 *   GET /api/v1/qluster/config-fingerprint
 *   GET /api/v1/qluster/ward-chain
 *   GET /api/v1/qluster/backups-summary
 *
 * Unlike GET /api/v1/health/resources and GET /api/v1/health/aggregate
 * (Phase 2 — public-by-default, opt-in gated), these three endpoints expose
 * audit/config surface and must NEVER be reachable without an explicitly
 * configured QUOXCORE_READ_TOKEN. Every route below is registered behind
 * BOTH:
 *   1. requireReadTokenConfigured (this file)  — 403 when the token isn't
 *      configured at all (fail closed by default, opposite of resourceStats'
 *      opt-in no-op behaviour).
 *   2. requireReadToken (lib/resourceStats.js) — the existing timing-safe
 *      bearer check, reused as-is per Phase 2.
 *
 * Handlers are built via factory functions that accept their collaborators
 * as dependencies (with safe defaults) so they can be unit tested without
 * booting the full collector/server.js or touching real SQLite files.
 */

const crypto = require('crypto');

// ─── Shared: fail-closed gate (opposite default of requireReadToken) ─────
//
// requireReadToken (resourceStats.js) is a no-op when QUOXCORE_READ_TOKEN is
// unset, by design, for the Phase 2 health endpoints. These Phase 3
// endpoints are audit/config surface, so they must 403 in that same
// unset-token case instead of falling through unauthenticated.

function requireReadTokenConfigured(req, res, next) {
  if (!process.env.QUOXCORE_READ_TOKEN) {
    return res.status(403).json({ error: 'read_token_required' });
  }
  return next();
}

// ─── 1. GET /api/v1/qluster/config-fingerprint ───────────────────────────
//
// Deterministic SHA-256 fingerprint over a sorted, sanitised JSON object of
// non-secret deploy-shape facts. Only booleans/counts/short enum-like
// strings that are already surfaced elsewhere (e.g. GET /health) are
// included — never secret values, tokens, keys, or URLs/hostnames.
//
// Facts chosen (documented individually below) and why each is safe +
// available in the collector process today:

function defaultGetToolDefsCount() {
  try {
    // Lazy require mirrors the existing inline `require('./lib/
    // toolDefinitionsStore.js')` pattern already used throughout server.js.
    const toolDefStore = require('./toolDefinitionsStore.js');
    return toolDefStore.listToolMetas('__global__').length;
  } catch {
    return 0;
  }
}

function defaultGetEncryptionConfigured() {
  try {
    const { checkEncryptionConfig } = require('../utils/fieldEncryption');
    return !!checkEncryptionConfig().configured;
  } catch {
    return false;
  }
}

function defaultGetWardApiMountStatus() {
  return false;
}

/**
 * Build the sanitised, sorted facts object the fingerprint is computed
 * over. Exported separately (not just the hash) so tests can regex-scan
 * the actual values for secret-looking strings.
 */
function buildConfigFingerprintFacts({
  getWardApiMountStatus = defaultGetWardApiMountStatus,
  getToolDefsCount = defaultGetToolDefsCount,
  getEncryptionConfigured = defaultGetEncryptionConfigured,
} = {}) {
  return {
    // Build/version identifier — already publicly returned by GET /health,
    // not a secret, useful for the controller to detect drift after deploys.
    QUOXCORE_VERSION: process.env.QUOXCORE_VERSION || '0.0.0',
    // Deploy environment name (e.g. "production"/"development") — a short
    // enum-like string, never a hostname/credential.
    NODE_ENV: process.env.NODE_ENV || 'development',
    // Whether the WARD witnessing API mounted successfully — already
    // surfaced as ward_api: 'mounted'|'degraded' on GET /health.
    WARD_API_ENABLED: !!getWardApiMountStatus(),
    // Presence-only booleans for optional service integrations. The actual
    // URL values (which may embed internal hostnames) are NEVER included —
    // only whether each is configured.
    QUOXFLOW_URL_CONFIGURED: !!process.env.QUOXFLOW_URL,
    AUTH_SERVICE_URL_CONFIGURED: !!process.env.AUTH_SERVICE_URL,
    MEMORY_SERVICE_URL_CONFIGURED: !!process.env.MEMORY_SERVICE_URL,
    REPOBRAIN_URL_CONFIGURED: !!process.env.REPOBRAIN_URL,
    // Presence-only boolean for the service-to-service auth key — never
    // the key value itself.
    INTERNAL_SERVICE_KEY_CONFIGURED: !!process.env.INTERNAL_SERVICE_KEY,
    // Whether field-level encryption is configured (boolean only — no key
    // material, mirrors checkEncryptionConfig()'s own `configured` flag).
    ENCRYPTION_CONFIGURED: !!getEncryptionConfigured(),
    // Count (not names/contents) of registered tool definitions — a
    // deploy-shape fact about installed capability surface.
    TOOL_DEFS_COUNT: Number(getToolDefsCount()) || 0,
  };
}

/**
 * Canonical JSON stringify with recursively sorted keys, so the hash is
 * stable regardless of property insertion order.
 */
function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',');
  return `{${body}}`;
}

function computeConfigFingerprint(facts) {
  const canonical = canonicalStringify(facts);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function createConfigFingerprintHandler(deps = {}) {
  return function configFingerprintHandler(req, res) {
    try {
      const facts = buildConfigFingerprintFacts(deps);
      const fingerprint = computeConfigFingerprint(facts);
      res.json({
        fingerprint,
        computed_from: Object.keys(facts).sort(),
        ts: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to compute config fingerprint', detail: err.message });
    }
  };
}

// ─── 2. GET /api/v1/qluster/ward-chain ───────────────────────────────────
//
// Ground truth: services/ward/lib/store.js `ward_entries` table columns are
// seq, witnessed_at, source_kind, source_id, payload_hash, prev_chain_hash,
// chain_hash (see UNIQUE(chain_id, seq)).
//
// CONTRACT CORRECTION: the controller must be able to RECOMPUTE chain_hash
// itself to verify the chain, so the entry must carry every field fed into
// the preimage. Per services/ward/lib/crypto.js `chainHash()` (SPEC §4.4):
//   chain_hash = SHA-256(prev_chain_hash|chain_id|seq|ward_entry_id|
//                         timestamp|source_kind|source_id|payload_hash)
// and services/ward/lib/witness.js `witness()`, the `timestamp` fed into
// that preimage is the SAME value stored as `witnessed_at` (both are set
// from the one `witnessedAt` local — no drift between the two). `chain_id`
// is included too (top-level once, not per-entry, since a single response
// is scoped to one chain). Real columns are mapped to the response shape:
//   seq          <- seq
//   ts           <- witnessed_at        (== preimage `timestamp`)
//   ward_entry_id<- ward_entry_id
//   source_kind  <- source_kind
//   source_id    <- source_id
//   payload_hash <- payload_hash
//   prev_hash    <- prev_chain_hash
//   entry_hash   <- chain_hash
// source_kind/source_id are provenance identifiers (which subsystem/record
// the entry witnesses), not payload content — still hashes/IDs only, never
// `tags`/`sig`/actual payload bytes.

const WARD_CHAIN_MAX_LIMIT = 1000;
const WARD_CHAIN_DEFAULT_LIMIT = 500;

// Same env var + default the collector's own WARD init (server.js) uses,
// so this endpoint reads the same chain the box actually witnesses into.
function defaultWardChainId() {
  return process.env.WARD_CHAIN_ID || 'ward:org/quox/env/production';
}

function mapWardEntryRow(row) {
  return {
    seq: row.seq,
    ts: row.witnessed_at,
    ward_entry_id: row.ward_entry_id,
    source_kind: row.source_kind,
    source_id: row.source_id,
    payload_hash: row.payload_hash,
    prev_hash: row.prev_chain_hash,
    entry_hash: row.chain_hash,
  };
}

/**
 * Query a single page of a WARD chain's entries, ascending by seq.
 * @param {object} db - better-sqlite3 database handle (or a test double
 *   exposing the same `.prepare(sql).all(...)/.get(...)` shape).
 */
function queryWardChainPage(db, chainId, { limit, after }) {
  const rows = db
    .prepare('SELECT seq, witnessed_at, ward_entry_id, source_kind, source_id, payload_hash, prev_chain_hash, chain_hash FROM ward_entries WHERE chain_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
    .all(chainId, after, limit);
  const totalRow = db
    .prepare('SELECT COUNT(*) as total FROM ward_entries WHERE chain_id = ?')
    .get(chainId);
  return {
    entries: rows.map(mapWardEntryRow),
    total: (totalRow && totalRow.total) || 0,
  };
}

function createWardChainHandler({
  getWardService,
  chainId = defaultWardChainId(),
} = {}) {
  return async function wardChainHandler(req, res) {
    try {
      if (typeof getWardService !== 'function') {
        return res.status(503).json({ error: 'ward_unavailable' });
      }

      const rawLimit = parseInt(req.query.limit, 10);
      const limit = Math.min(
        WARD_CHAIN_MAX_LIMIT,
        Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : WARD_CHAIN_DEFAULT_LIMIT
      );
      const rawAfter = parseInt(req.query.after, 10);
      const after = Number.isFinite(rawAfter) && rawAfter >= 0 ? rawAfter : 0;

      const ward = await getWardService();
      if (!ward || typeof ward.getDb !== 'function') {
        return res.status(503).json({ error: 'ward_unavailable' });
      }
      const db = ward.getDb();

      const { entries, total } = queryWardChainPage(db, chainId, { limit, after });
      res.json({ chain_id: chainId, entries, total });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read ward chain', detail: err.message });
    }
  };
}

// ─── 3. GET /api/v1/qluster/backups-summary ──────────────────────────────
//
// QLUSTER-4: the auth service now exposes an internal (X-Service-Key gated)
// cross-org summary at GET /api/internal/backups/summary (see
// services/auth/routes/internal-backups.js), so this handler proxies to it
// instead of returning 501. Returns { newest_backup_ts, count } across all
// orgs. Dependency-injected (authBaseUrl/serviceKey/fetchImpl) for testing.

function createBackupsSummaryHandler(deps = {}) {
  return async function backupsSummaryHandler(req, res) {
    const base = (deps.authBaseUrl || process.env.AUTH_SERVICE_URL || 'http://auth:3101').replace(/\/$/, '');
    const serviceKey = deps.serviceKey || process.env.INTERNAL_SERVICE_KEY || '';
    const fetchImpl = deps.fetchImpl || global.fetch;
    try {
      const r = await fetchImpl(`${base}/api/internal/backups/summary`, {
        headers: { 'X-Service-Key': serviceKey },
      });
      const data = await r.json().catch(() => null);
      return res.status(r.status).json(data);
    } catch (err) {
      return res.status(502).json({ error: 'auth_unreachable', detail: err.message });
    }
  };
}

// ─── 4. GET /api/v1/qluster/evidence/:corr ───────────────────────────────
//
// Qluster Phase 5c — cross-box EVIDENCE display. The external Qluster
// controller pulls a single conversation's per-corr AEE evidence for
// DISPLAY ONLY (read-only, never re-ingested). This is a READ (it
// self-auths via the read token, exactly like config-fingerprint /
// ward-chain), NOT an operational/signed route.
//
// The response is derived from the same source as the ground-truth
// GET /aee/conversation/:corr/bundle endpoint, but shaped to the minimal
// cross-box display contract: { corr, envelopes:[...], ward?, manifest? }.
// It carries envelope METADATA + WARD hashes only — never raw payloads
// beyond what the bundle already exposes. An unknown/empty corr returns
// { corr, envelopes: [] } (not a 404), so the controller can render an
// "no evidence" state without a 404-storm.
//
// `getBundle(corr)` is injected (server.js wires it to the real AEE/VOLT
// statements) so this handler is unit-testable with a mock bundle source.

function createEvidenceHandler({ getBundle } = {}) {
  return async function evidenceHandler(req, res) {
    const corr = req.params ? req.params.corr : undefined;
    try {
      let bundle = null;
      if (typeof getBundle === 'function') {
        bundle = await getBundle(corr);
      }
      const envelopes = bundle && Array.isArray(bundle.envelopes) ? bundle.envelopes : [];
      if (envelopes.length === 0) {
        // Empty/unknown corr → not a 404 (display-only, avoid a 404-storm).
        return res.json({ corr, envelopes: [] });
      }
      const body = { corr, envelopes };
      // Pass through the WARD witness hashes + manifest the bundle already
      // exposes — never add payloads the bundle source doesn't yield.
      if (bundle.ward) body.ward = bundle.ward;
      if (bundle.manifest) body.manifest = bundle.manifest;
      return res.json(body);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to read evidence', detail: err.message });
    }
  };
}

module.exports = {
  requireReadTokenConfigured,
  createEvidenceHandler,
  buildConfigFingerprintFacts,
  computeConfigFingerprint,
  createConfigFingerprintHandler,
  queryWardChainPage,
  mapWardEntryRow,
  createWardChainHandler,
  createBackupsSummaryHandler,
  WARD_CHAIN_MAX_LIMIT,
  WARD_CHAIN_DEFAULT_LIMIT,
};
