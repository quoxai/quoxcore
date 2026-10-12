/**
 * qlusterEnroll.js — Qluster Phase 4 box-side enrollment + scoped-token
 * security layer for the external Qluster fleet controller.
 *
 * Ground truth carried from docs/PLAN.md §8:
 *   - Box admin issues a single-use enrollment token (32B, 15min TTL, hashed
 *     at rest) with an explicit scope checklist (node.read default;
 *     backup.trigger / backup.download opt-in).
 *   - The controller exchanges that token (the token IS the auth on
 *     /exchange) for a long-lived scoped bearer (32B, hashed at rest) plus a
 *     pinned box Ed25519 keypair; the box keeps box_privkey, hands back
 *     box_pubkey, and pins the controller's pubkey.
 *   - Operational (state-changing / data-egress) requests carry a signed
 *     envelope with replay protection (ts ±120s + seen-nonce window).
 *   - Box admin lists + revokes controllers; revocation is effective ≤60s
 *     (validate-cache TTL).
 *
 * Storage lives in the collector's existing aee.db (see server.js DB init).
 * All handlers/middleware are factory functions taking their collaborators as
 * dependencies (with env/default fallbacks) so they can be unit-tested against
 * an in-memory better-sqlite3 db without booting server.js — mirroring the
 * lib/qlusterReadApi.js pattern.
 */

const crypto = require('crypto');

// ─── Constants (PLAN §8.1) ────────────────────────────────────────────────
const ENROLL_TTL_MS = 15 * 60 * 1000;          // enrollment token lifetime
const BEARER_CACHE_TTL_MS = 60 * 1000;         // ≤60s — bounds revocation lag
const NONCE_WINDOW_MS = 10 * 60 * 1000;        // replay-protection window
const TS_SKEW_SEC = 120;                       // ±120s clock skew tolerance (X-Qluster-Ts is unix SECONDS)
const EXCHANGE_RATE_LIMIT = 5;                 // 5/min/IP on /exchange
const EXCHANGE_RATE_WINDOW_MS = 60 * 1000;

const VALID_SCOPES = ['node.read', 'backup.trigger', 'backup.download', 'agent.delegate'];
const DEFAULT_SCOPES = ['node.read'];

// Operational scopes additionally require a signed envelope (Ed25519 sig +
// replay protection). Both data-egress/state-change backup.* AND governed
// agent delegation (agent.*, Phase 5b) are operational: a delegated prompt can
// drive state-changing tools on THIS box, so it must be signed like a backup
// trigger, never a bare bearer.
function isOperationalScope(scope) {
  return typeof scope === 'string' && (scope.startsWith('backup.') || scope.startsWith('agent.'));
}

// ─── Schema (guarded migration; called from server.js DB init) ────────────
function ensureQlusterSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qluster_enroll_tokens (
      id               TEXT PRIMARY KEY,
      token_hash       TEXT NOT NULL UNIQUE,
      scopes_json      TEXT NOT NULL DEFAULT '[]',
      allowed_orgs_json TEXT NOT NULL DEFAULT '[]',
      expires_at       INTEGER NOT NULL,
      used_at          INTEGER,
      created_by       TEXT,
      created_at       INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qluster_controllers (
      id                TEXT PRIMARY KEY,
      name              TEXT,
      token_hash        TEXT NOT NULL UNIQUE,
      scopes_json       TEXT NOT NULL DEFAULT '[]',
      allowed_orgs_json TEXT NOT NULL DEFAULT '[]',
      controller_pubkey TEXT,
      box_privkey       TEXT,
      box_pubkey        TEXT,
      created_at        INTEGER NOT NULL,
      revoked_at        INTEGER,
      last_seen         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_qluster_ctrl_token ON qluster_controllers(token_hash);
  `);
  // Guarded migration: existing DBs (pre org-binding) gain allowed_orgs_json.
  // Absent/empty allowed_orgs means DENY-ALL for backups (fail-closed) —
  // enforced in qlusterBackupProxy.js and internal-backups.js.
  ensureColumn(db, 'qluster_enroll_tokens', 'allowed_orgs_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'qluster_controllers', 'allowed_orgs_json', "TEXT NOT NULL DEFAULT '[]'");
}

function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Normalise an allowed_orgs input to an array of non-empty org id strings.
function normalizeAllowedOrgs(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((o) => typeof o === 'string' && o.length > 0);
}
function parseAllowedOrgs(json) {
  try {
    const a = JSON.parse(json || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

// ─── Crypto helpers ───────────────────────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}
function generateId() {
  return crypto.randomUUID();
}
function sha256Hex(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
}

// Ed25519 keypair for the box side of a controller pairing. Public key is
// SPKI PEM — the same encoding the controller sends its controller_pubkey in
// (integration canon: quox-qluster server/lib/identity.js).
function generateBoxKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}
// Exposed for tests: mint a controller-side keypair with the same encoding.
function generateControllerKeypair() {
  return generateBoxKeypair();
}

// bodyHash = sha256 HEX of the RAW JSON body string exactly as transmitted, or
// sha256 hex of '' when there is no body (integration canon: signedFetch.js).
function computeBodyHash(rawBody) {
  return sha256Hex(rawBody || '');
}

// Signed-envelope preimage (integration canon):
//   `${ts}.${nonce}.${METHOD}.${path}.${bodyHash}`
// where ts is the unix-SECONDS string as sent, path is pathname+search, and
// `body` is the RAW transmitted body string ('' when none).
function buildSignedMessage({ ts, nonce, method, path, body }) {
  return `${ts}.${nonce}.${String(method).toUpperCase()}.${path}.${computeBodyHash(body)}`;
}

function signMessage({ message, privateKeyPem }) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(message, 'utf8'), key).toString('base64');
}

// controller_pubkey is stored as the SPKI PEM the controller sent; verify with
// crypto.verify(null, messageBuf, pemKey, sigBuf).
function verifySignature({ message, signatureB64, publicKeyPem }) {
  try {
    return crypto.verify(null, Buffer.from(message, 'utf8'), publicKeyPem, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

// ─── In-memory state (per collector process) ──────────────────────────────
// Bearer→row validate cache (bounds revocation lag to ≤ cacheTtlMs).
const _bearerCache = new Map();     // token_hash -> { row, cachedAt }
// Seen-nonce replay window.
const _nonceStore = new Map();      // nonce -> expiresAt
// Exchange rate-limit buckets.
const _rateBuckets = new Map();     // ip -> number[] (timestamps)

function pruneNonces(store, now) {
  for (const [nonce, exp] of store) {
    if (exp <= now) store.delete(nonce);
  }
}

// ─── Enrollment: POST /enroll/issue (box-admin) ───────────────────────────
function createEnrollIssueHandler(deps = {}) {
  const {
    getDb,
    now = () => Date.now(),
    ttlMs = ENROLL_TTL_MS,
    genToken = generateToken,
    genId = generateId,
  } = deps;
  return function enrollIssueHandler(req, res) {
    try {
      const db = getDb();
      const body = req.body || {};
      const scopes = Array.isArray(body.scopes) && body.scopes.length ? body.scopes : DEFAULT_SCOPES;
      const invalid = scopes.filter((s) => !VALID_SCOPES.includes(s));
      if (invalid.length) {
        return res.status(400).json({ error: 'invalid_scope', invalid });
      }
      // Box-admin declares which orgs this controller may touch for backups.
      // Absent/empty = deny-all for backups (fail-closed); node.read is fine.
      const allowedOrgs = normalizeAllowedOrgs(body.allowed_orgs);
      const token = genToken();
      const id = genId();
      const created = now();
      const createdBy = req.user?.id || (req.service ? 'service:internal' : null);
      db.prepare(
        'INSERT INTO qluster_enroll_tokens (id, token_hash, scopes_json, allowed_orgs_json, expires_at, used_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)'
      ).run(id, hashToken(token), JSON.stringify(scopes), JSON.stringify(allowedOrgs), created + ttlMs, createdBy, created);
      // The token is returned ONCE — only its hash is persisted.
      return res.status(201).json({
        id,
        enrollment_token: token,
        scopes,
        allowed_orgs: allowedOrgs,
        expires_at: created + ttlMs,
        name: body.name || null,
      });
    } catch (err) {
      return res.status(500).json({ error: 'enroll_issue_failed', detail: err.message });
    }
  };
}

// ─── Enrollment: POST /enroll/exchange (UNauthed — token IS the auth) ─────
function createEnrollExchangeHandler(deps = {}) {
  const {
    getDb,
    now = () => Date.now(),
    genToken = generateToken,
    genId = generateId,
    genKeypair = generateBoxKeypair,
  } = deps;
  return function enrollExchangeHandler(req, res) {
    try {
      const db = getDb();
      const { enrollment_token, controller_name, controller_pubkey } = req.body || {};
      if (!enrollment_token || !controller_pubkey) {
        return res.status(400).json({ error: 'missing_fields' });
      }
      const th = hashToken(enrollment_token);
      const row = db.prepare('SELECT * FROM qluster_enroll_tokens WHERE token_hash = ?').get(th);
      if (!row) return res.status(401).json({ error: 'invalid_token' });
      if (row.used_at) return res.status(401).json({ error: 'token_used' });
      if (now() > row.expires_at) return res.status(401).json({ error: 'token_expired' });

      // Single-use: mark used atomically; lose the race → already used.
      const upd = db
        .prepare('UPDATE qluster_enroll_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL')
        .run(now(), th);
      if (upd.changes === 0) return res.status(401).json({ error: 'token_used' });

      const kp = genKeypair();
      const bearer = genToken();
      const controllerId = genId();
      const scopes = row.scopes_json;
      // Carry the org binding declared at issue onto the controller row.
      const allowedOrgsJson = row.allowed_orgs_json || '[]';
      db.prepare(
        'INSERT INTO qluster_controllers (id, name, token_hash, scopes_json, allowed_orgs_json, controller_pubkey, box_privkey, box_pubkey, created_at, revoked_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)'
      ).run(
        controllerId,
        controller_name || null,
        hashToken(bearer),
        scopes,
        allowedOrgsJson,
        controller_pubkey,
        kp.privatePem,
        kp.publicPem,
        now()
      );
      return res.status(201).json({
        controller_id: controllerId,
        bearer_token: bearer,
        box_pubkey: kp.publicPem,
        scopes: JSON.parse(scopes),
        allowed_orgs: parseAllowedOrgs(allowedOrgsJson),
      });
    } catch (err) {
      return res.status(500).json({ error: 'enroll_exchange_failed', detail: err.message });
    }
  };
}

// Rate-limit middleware for /exchange (5/min/IP).
function enrollExchangeRateLimit(deps = {}) {
  const {
    limit = EXCHANGE_RATE_LIMIT,
    windowMs = EXCHANGE_RATE_WINDOW_MS,
    now = () => Date.now(),
    store = _rateBuckets,
  } = deps;
  return function rateLimit(req, res, next) {
    const ip =
      (req.headers && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) ||
      req.ip ||
      req.socket?.remoteAddress ||
      'unknown';
    const t = now();
    const bucket = (store.get(ip) || []).filter((ts) => t - ts < windowMs);
    if (bucket.length >= limit) {
      store.set(ip, bucket);
      return res.status(429).json({ error: 'rate_limited' });
    }
    bucket.push(t);
    store.set(ip, bucket);
    return next();
  };
}

// ─── Controllers: list + revoke (box-admin) ───────────────────────────────
function createControllersListHandler(deps = {}) {
  const { getDb } = deps;
  return function controllersListHandler(req, res) {
    try {
      const db = getDb();
      const rows = db
        .prepare('SELECT id, name, scopes_json, allowed_orgs_json, created_at, revoked_at, last_seen FROM qluster_controllers ORDER BY created_at DESC')
        .all();
      // Never expose token_hash, keys.
      const controllers = rows.map((r) => ({
        id: r.id,
        name: r.name,
        scopes: JSON.parse(r.scopes_json || '[]'),
        allowed_orgs: JSON.parse(r.allowed_orgs_json || '[]'),
        created_at: r.created_at,
        revoked_at: r.revoked_at,
        last_seen: r.last_seen,
        revoked: !!r.revoked_at,
      }));
      return res.json({ controllers, count: controllers.length });
    } catch (err) {
      return res.status(500).json({ error: 'controllers_list_failed', detail: err.message });
    }
  };
}

function createRevokeHandler(deps = {}) {
  const { getDb, now = () => Date.now() } = deps;
  return function revokeHandler(req, res) {
    try {
      const db = getDb();
      const id = req.params.id;
      const ts = now();
      const upd = db
        .prepare('UPDATE qluster_controllers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(ts, id);
      if (upd.changes === 0) {
        const exists = db.prepare('SELECT revoked_at FROM qluster_controllers WHERE id = ?').get(id);
        if (!exists) return res.status(404).json({ error: 'controller_not_found' });
        return res.json({ ok: true, revoked_at: exists.revoked_at, already: true });
      }
      return res.json({ ok: true, revoked_at: ts });
    } catch (err) {
      return res.status(500).json({ error: 'revoke_failed', detail: err.message });
    }
  };
}

// ─── requireQlusterScope middleware factory ───────────────────────────────
//
// Bearer hash lookup (cache ≤60s) → not revoked → scope present. For
// operational (backup.*) scopes ALSO require a signed envelope with replay
// protection.
function requireQlusterScope(scope, deps = {}) {
  const {
    getDb,
    now = () => Date.now(),
    cacheTtlMs = BEARER_CACHE_TTL_MS,
    nonceWindowMs = NONCE_WINDOW_MS,
    tsSkewSec = TS_SKEW_SEC,
    cache = _bearerCache,
    nonceStore = _nonceStore,
  } = deps;

  // PLAN §8.1: revocation effective ≤60s — the validate cache must not
  // outlive that bound.
  if (cacheTtlMs > BEARER_CACHE_TTL_MS) {
    throw new Error(`requireQlusterScope: cacheTtlMs (${cacheTtlMs}) exceeds 60s revocation bound`);
  }

  function lookupController(db, tokenHash, t) {
    const cached = cache.get(tokenHash);
    if (cached && t - cached.cachedAt < cacheTtlMs) return cached.row;
    const row = db.prepare('SELECT * FROM qluster_controllers WHERE token_hash = ?').get(tokenHash) || null;
    cache.set(tokenHash, { row, cachedAt: t });
    return row;
  }

  return function qlusterScopeMiddleware(req, res, next) {
    try {
      const db = getDb();
      const auth = req.headers?.authorization || '';
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      if (!m) return res.status(401).json({ error: 'missing_bearer' });
      const tokenHash = hashToken(m[1]);
      const t = now();
      const controller = lookupController(db, tokenHash, t);
      if (!controller) return res.status(401).json({ error: 'invalid_bearer' });
      if (controller.revoked_at) return res.status(401).json({ error: 'revoked' });

      const scopes = JSON.parse(controller.scopes_json || '[]');
      if (!scopes.includes(scope)) return res.status(403).json({ error: 'scope_denied', required: scope });

      // Operational scopes require a signed envelope.
      if (isOperationalScope(scope)) {
        const ts = Number(req.headers['x-qluster-ts']);
        const nonce = req.headers['x-qluster-nonce'];
        const sig = req.headers['x-qluster-signature'];
        if (!Number.isFinite(ts) || !nonce || !sig) {
          return res.status(401).json({ error: 'signature_required' });
        }
        // X-Qluster-Ts is unix SECONDS; `t`/`now()` is milliseconds — compare
        // in the same unit (PLAN §8.1 ±120s skew).
        if (Math.abs(t / 1000 - ts) > tsSkewSec) {
          return res.status(401).json({ error: 'stale_timestamp' });
        }
        pruneNonces(nonceStore, t);
        if (nonceStore.has(nonce)) {
          return res.status(401).json({ error: 'replayed_nonce' });
        }
        // Canon: sign pathname+search (req.originalUrl), not the
        // query-stripped req.path. Body hash is over the RAW transmitted
        // body string (req.rawBody), never the parsed object — an empty/GET
        // body must hash as '' not '{}' / '[object Object]'.
        const path = req.originalUrl || req.url || '';
        const message = buildSignedMessage({ ts, nonce, method: req.method, path, body: req.rawBody || '' });
        const ok = verifySignature({
          message,
          signatureB64: sig,
          publicKeyPem: controller.controller_pubkey,
        });
        if (!ok) return res.status(401).json({ error: 'bad_signature' });
        // Only record the nonce once the signature verifies.
        nonceStore.set(nonce, t + nonceWindowMs);
      }

      // Best-effort last_seen; never fail the request on this.
      try {
        db.prepare('UPDATE qluster_controllers SET last_seen = ? WHERE id = ?').run(t, controller.id);
      } catch { /* ignore */ }

      req.qlusterController = {
        id: controller.id,
        name: controller.name,
        scopes,
        allowed_orgs: parseAllowedOrgs(controller.allowed_orgs_json),
      };
      return next();
    } catch (err) {
      return res.status(500).json({ error: 'scope_check_failed', detail: err.message });
    }
  };
}

// Test/util: clear in-memory state between cases.
function _resetState() {
  _bearerCache.clear();
  _nonceStore.clear();
  _rateBuckets.clear();
}

module.exports = {
  // constants
  ENROLL_TTL_MS,
  BEARER_CACHE_TTL_MS,
  NONCE_WINDOW_MS,
  TS_SKEW_SEC,
  EXCHANGE_RATE_LIMIT,
  VALID_SCOPES,
  DEFAULT_SCOPES,
  isOperationalScope,
  // schema
  ensureQlusterSchema,
  // crypto helpers
  generateToken,
  hashToken,
  generateId,
  sha256Hex,
  generateBoxKeypair,
  generateControllerKeypair,
  computeBodyHash,
  buildSignedMessage,
  signMessage,
  verifySignature,
  // handlers + middleware
  createEnrollIssueHandler,
  createEnrollExchangeHandler,
  enrollExchangeRateLimit,
  createControllersListHandler,
  createRevokeHandler,
  requireQlusterScope,
  // test util
  _resetState,
};
