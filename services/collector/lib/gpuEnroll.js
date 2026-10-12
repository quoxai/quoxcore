/**
 * gpuEnroll.js — real GPU fleet enrollment tokens + WARD-witnessed enrolment.
 *
 * B2 (roadmap #149 QUOXGPU). Replaces the GPU Setup wizard's fabricated
 * `qxg_9f3c…a91e` display token and `7f3c…a91e` WARD hash (both hardcoded
 * mock strings in src/pages/views/GpuSetupView.jsx P1) with a real,
 * single-use, hashed-at-rest enrollment token and a real WARD chain witness.
 *
 * Cloned precisely from lib/qlusterEnroll.js's enrollment pattern (PLAN §8):
 *   - box admin issues a single-use enrollment token (32B, 15min TTL, hashed
 *     at rest, SQLite table) via /enroll/issue.
 *   - the enrolling daemon exchanges that token (the token IS the auth) via
 *     /enroll/exchange — single-use, atomic UPDATE...WHERE used_at IS NULL
 *     to close the race window.
 *   - Storage lives in the collector's existing aee.db (shared with
 *     lib/qlusterEnroll.js and lib/gpuNodesStore.js).
 *   - Handlers are dependency-injected factory functions so they can be
 *     unit-tested against an in-memory better-sqlite3 db without booting
 *     server.js (see lib/qlusterEnroll.js, lib/gpuNodesStore.js).
 *
 * WARD-on-enrol: a successful exchange is witnessed in the real WARD
 * append-only chain via wardHookVOLT() — the SAME fire-and-forget function
 * server.js already calls at the VOLT-sync bundle/event witness sites
 * (server.js ~11027/11040). The digest persisted on gpu_nodes.ward_digest is
 * EXACTLY the payload_hash fed into that witness call (canonical-JSON +
 * SHA-256, the same algorithm as services/ward/lib/crypto.js's payloadHash —
 * see lib/voltEmitter.js's canonicalJSON/sha256, which already mirrors it in
 * this codebase). It is real and independently recomputable, not fabricated.
 * It is NOT the final WARD chain_hash: that requires WARD's internal
 * seq/prev_chain_hash state, and the collector-side CJS bridge
 * (services/ward/hooks-cjs.cjs) does not return wardHookVOLT()'s result to
 * callers — out of scope to change here (WARD-service file, not collector).
 */

'use strict';

const crypto = require('crypto');

const GPU_ENROLL_TTL_MS = 15 * 60 * 1000; // 15min — mirrors qlusterEnroll.ENROLL_TTL_MS
const GPU_TOKEN_PREFIX = 'qxg_';

// ─── Schema ─────────────────────────────────────────────────────────────
function ensureGpuEnrollSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gpu_enroll_tokens (
      id          TEXT PRIMARY KEY,
      token_hash  TEXT NOT NULL UNIQUE,
      org_id      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      used_at     INTEGER,
      host_id     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gpu_enroll_tokens_org ON gpu_enroll_tokens(org_id);
  `);
}

// ─── Crypto helpers ─────────────────────────────────────────────────────
function generateGpuToken() {
  return GPU_TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}
function hashGpuToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}
function generateId() {
  return crypto.randomUUID();
}

// ─── issueGpuEnrollToken — mint a single-use, 15min-TTL token ────────────
// Only the sha256 hash is persisted; the plaintext token is returned ONCE.
function issueGpuEnrollToken(db, deps = {}) {
  const {
    orgId,
    now = () => Date.now(),
    ttlMs = GPU_ENROLL_TTL_MS,
    genToken = generateGpuToken,
    genId = generateId,
  } = deps;
  if (!db) throw new Error('issueGpuEnrollToken: db required');
  if (!orgId) throw new Error('issueGpuEnrollToken: orgId required');

  const token = genToken();
  const id = genId();
  const created = now();
  const expiresAt = created + ttlMs;
  db.prepare(
    'INSERT INTO gpu_enroll_tokens (id, token_hash, org_id, created_at, expires_at, used_at, host_id) VALUES (?, ?, ?, ?, ?, NULL, NULL)'
  ).run(id, hashGpuToken(token), orgId, created, expiresAt);

  return { id, token, org_id: orgId, created_at: created, expires_at: expiresAt };
}

// ─── exchangeGpuEnrollToken — validate + single-use-consume + bind host ──
// Validation order mirrors qlusterEnroll's createEnrollExchangeHandler:
// lookup by hash -> exists -> unused -> unexpired -> atomic single-use
// UPDATE (loses the race -> already used).
function exchangeGpuEnrollToken(db, deps = {}) {
  const { token, hostId, now = () => Date.now() } = deps;
  if (!db) return { ok: false, error: 'store_unavailable' };
  if (!token || !hostId) return { ok: false, error: 'missing_fields' };

  const th = hashGpuToken(token);
  const row = db.prepare('SELECT * FROM gpu_enroll_tokens WHERE token_hash = ?').get(th);
  if (!row) return { ok: false, error: 'invalid_token' };
  if (row.used_at) return { ok: false, error: 'token_used' };

  const t = now();
  if (t > row.expires_at) return { ok: false, error: 'token_expired' };

  const upd = db
    .prepare('UPDATE gpu_enroll_tokens SET used_at = ?, host_id = ? WHERE token_hash = ? AND used_at IS NULL')
    .run(t, hostId, th);
  if (upd.changes === 0) return { ok: false, error: 'token_used' };

  return { ok: true, id: row.id, org_id: row.org_id, host_id: hostId, exchanged_at: t };
}

// ─── Express handler: POST /api/v1/gpu/enroll/issue (authenticated) ─────
function createGpuEnrollIssueHandler(deps = {}) {
  const {
    getDb,
    now = () => Date.now(),
    ttlMs = GPU_ENROLL_TTL_MS,
    genToken = generateGpuToken,
    genId = generateId,
  } = deps;
  return function gpuEnrollIssueHandler(req, res) {
    try {
      const db = getDb();
      if (!db) return res.status(503).json({ error: 'store_unavailable' });
      const body = req.body || {};
      const orgId = body.org_id || req.user?.org_id || 'default';
      const result = issueGpuEnrollToken(db, { orgId, now, ttlMs, genToken, genId });
      // The token is returned ONCE — only its hash is persisted.
      return res.status(201).json({
        id: result.id,
        enrollment_token: result.token,
        org_id: result.org_id,
        expires_at: result.expires_at,
      });
    } catch (err) {
      return res.status(500).json({ error: 'gpu_enroll_issue_failed', detail: err.message });
    }
  };
}

// ─── Express handler: POST /api/v1/gpu/enroll/exchange (UNauthed) ───────
// The enrollment token IS the auth — mirrors qlusterEnroll's exchange route.
// On success: witnesses the enrolment in the real WARD chain (fire-and-forget,
// non-fatal) and marks the gpu_nodes row enrolled with the resulting digest
// (best-effort — never fails the exchange itself).
function createGpuEnrollExchangeHandler(deps = {}) {
  const {
    getDb,
    now = () => Date.now(),
    markEnrolled, // (db, { hostId, orgId, tokenHash, wardDigest, now }) -> record — lib/gpuNodesStore.js markGpuNodeEnrolled
    witnessWard, // (event) -> void, fire-and-forget — server.js's wardHookVOLT
    canonicalHash, // (obj) -> sha256 hex of canonical JSON — lib/voltEmitter.js sha256
  } = deps;
  return function gpuEnrollExchangeHandler(req, res) {
    try {
      const db = getDb();
      if (!db) return res.status(503).json({ error: 'store_unavailable' });
      const body = req.body || {};
      const enrollmentToken = body.enrollment_token;
      const hostId = body.host_id;

      const result = exchangeGpuEnrollToken(db, { token: enrollmentToken, hostId, now });
      if (!result.ok) {
        const status = result.error === 'missing_fields' ? 400 : 401;
        return res.status(status).json({ error: result.error });
      }

      // WARD-on-enrol (fire-and-forget, non-fatal). See file header for why
      // ward_digest is the payload_hash rather than the chain-assigned hash.
      const tsIso = new Date(result.exchanged_at).toISOString();
      let wardDigest = null;
      try {
        if (typeof canonicalHash === 'function') {
          wardDigest = canonicalHash({
            type: 'gpu.enroll',
            host_id: result.host_id,
            org_id: result.org_id,
            token_id: result.id,
            ts: tsIso,
          });
        }
        if (wardDigest && typeof witnessWard === 'function') {
          witnessWard({
            event_id: `GPU_ENROLL_${result.host_id}_${result.exchanged_at}`,
            hash: wardDigest,
            ts: tsIso,
          });
        }
      } catch (wErr) {
        console.warn('[GPU] WARD witness failed (non-fatal):', wErr.message);
      }

      if (typeof markEnrolled === 'function') {
        try {
          markEnrolled(db, {
            hostId: result.host_id,
            orgId: result.org_id,
            tokenHash: hashGpuToken(enrollmentToken),
            wardDigest,
            now,
          });
        } catch (mErr) {
          console.warn('[GPU] gpu_nodes enrollment marking failed (non-fatal):', mErr.message);
        }
      }

      return res.status(201).json({
        ok: true,
        host_id: result.host_id,
        org_id: result.org_id,
        ward_digest: wardDigest,
      });
    } catch (err) {
      return res.status(500).json({ error: 'gpu_enroll_exchange_failed', detail: err.message });
    }
  };
}

module.exports = {
  GPU_ENROLL_TTL_MS,
  GPU_TOKEN_PREFIX,
  ensureGpuEnrollSchema,
  generateGpuToken,
  hashGpuToken,
  generateId,
  issueGpuEnrollToken,
  exchangeGpuEnrollToken,
  createGpuEnrollIssueHandler,
  createGpuEnrollExchangeHandler,
};
