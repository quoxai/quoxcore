/**
 * fleetHostCredentialsStore.js — per-fleet-host credentials, org-bound at
 * issuance, distinct from the shared INTERNAL_SERVICE_KEY.
 *
 * SEC-FLEET-CRED (owner-authorized, HIGH severity). See
 * migrations/aee/007-fleet-host-credentials-table.sql for the full incident
 * writeup this fixes: lib/fleetGripeHandler.js previously trusted org_id
 * straight from the request body under requireServiceOrUserAuth()'s
 * shared-key branch, so any holder of INTERNAL_SERVICE_KEY (every same-box
 * trusted internal service) could impersonate any org's vault-stored GitHub
 * credentials. That master key is fine for same-box services; it is NOT
 * fine to hand to a remote fleet host (quoxagent, running on arbitrary
 * managed hosts, potentially compromised).
 *
 * This module provides:
 *   - issueFleetHostCredential(db, ...)     — mint + persist-hashed (UPSERT
 *     by host_id — reissuing a host's credential replaces its prior token).
 *   - createFleetHostCredentialIssueHandler — Express handler factory for
 *     POST /api/internal/fleet-hosts/:hostId/credential (admin/service-key
 *     gated at the route-registration level in server.js, mirrors
 *     lib/gpuEnroll.js's createGpuEnrollIssueHandler + qlusterAdminGate
 *     pairing).
 *   - requireFleetHostAuth()                — Express middleware. Reads
 *     X-Fleet-Host-Token (NOT X-Service-Key — the two trust tiers are never
 *     conflated), hashes it, looks up fleet_host_credentials WHERE
 *     token_hash = ? AND revoked_at IS NULL, and sets
 *     req.fleetHost = { hostId, orgId } on success. Fails closed (401) on
 *     missing header, no match, or a revoked credential.
 *
 * Token/hash primitives mirror the THREE existing high-entropy-token stores
 * in this codebase (services/auth/utils/scimTokens.js, services/auth/routes/
 * mcp-tokens.js, services/collector/lib/gpuEnroll.js): crypto.randomBytes()
 * for generation, plain SHA-256 for at-rest hashing (correct for random
 * high-entropy tokens — unlike human passwords, which use the separate
 * scrypt-based hashPassword() in services/auth/utils/crypto.js; a slow KDF
 * is neither needed nor precedented for this token shape here).
 *
 * Self-contained + dependency-injected (no server.js import), same
 * unit-testable-without-booting-the-server discipline as gpuEnroll.js /
 * devServersStore.js.
 */

'use strict';

const crypto = require('crypto');

const FLEET_HOST_TOKEN_PREFIX = 'qfleet_';

// ─── Crypto helpers ─────────────────────────────────────────────────────
function generateFleetHostToken() {
  return FLEET_HOST_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function hashFleetHostToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    hostId: row.host_id,
    orgId: row.org_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

// ─── issueFleetHostCredential — mint + UPSERT-by-host_id ────────────────
// Only the sha256 hash is persisted; the plaintext token is returned ONCE
// by the caller (createFleetHostCredentialIssueHandler below) and never
// retrievable again. Re-issuing for the same host_id replaces the prior
// token_hash and clears revoked_at (host_id is the table's PK).
function issueFleetHostCredential(db, { hostId, orgId, now = () => Date.now(), genToken = generateFleetHostToken } = {}) {
  if (!db) throw new Error('issueFleetHostCredential: db required');
  if (!hostId) throw new Error('issueFleetHostCredential: hostId required');
  if (!orgId) throw new Error('issueFleetHostCredential: orgId required');

  const token = genToken();
  const tokenHash = hashFleetHostToken(token);
  const createdAt = now();

  db.prepare(`
    INSERT INTO fleet_host_credentials (host_id, org_id, token_hash, created_at, revoked_at)
    VALUES (@host_id, @org_id, @token_hash, @created_at, NULL)
    ON CONFLICT(host_id) DO UPDATE SET
      org_id = @org_id,
      token_hash = @token_hash,
      created_at = @created_at,
      revoked_at = NULL
  `).run({ host_id: hostId, org_id: orgId, token_hash: tokenHash, created_at: createdAt });

  return { hostId, orgId, token, createdAt };
}

// ─── resolveFleetHostToken — hash + look up an unrevoked credential ─────
function resolveFleetHostToken(db, token) {
  if (!db || !token || typeof token !== 'string') return null;
  const tokenHash = hashFleetHostToken(token);
  const row = db
    .prepare('SELECT * FROM fleet_host_credentials WHERE token_hash = ? AND revoked_at IS NULL')
    .get(tokenHash);
  return rowToRecord(row);
}

// ─── revokeFleetHostCredential — revoke without deleting the audit row ──
function revokeFleetHostCredential(db, hostId, { now = () => Date.now() } = {}) {
  if (!db || !hostId) return { changes: 0 };
  const result = db
    .prepare('UPDATE fleet_host_credentials SET revoked_at = ? WHERE host_id = ? AND revoked_at IS NULL')
    .run(now(), hostId);
  return { changes: result.changes };
}

// ─── Express handler: POST /api/internal/fleet-hosts/:hostId/credential ─
// Admin/service-key gated at route registration (server.js) — this is an
// enrollment action performed BY an operator/admin ON BEHALF OF a fleet
// host, not something the fleet host calls on itself.
function createFleetHostCredentialIssueHandler(deps = {}) {
  const { getDb, now = () => Date.now(), genToken = generateFleetHostToken } = deps;
  return function fleetHostCredentialIssueHandler(req, res) {
    try {
      const db = getDb();
      if (!db) return res.status(503).json({ error: 'store_unavailable' });

      const hostId = req.params && req.params.hostId ? String(req.params.hostId).trim() : '';
      const body = req.body || {};
      const orgId = typeof body.org_id === 'string' ? body.org_id.trim() : '';

      if (!hostId) return res.status(400).json({ error: 'bad_request', message: 'hostId path param is required' });
      if (!orgId) return res.status(400).json({ error: 'bad_request', message: 'org_id is required' });

      const result = issueFleetHostCredential(db, { hostId, orgId, now, genToken });

      // The raw token is returned ONCE — only its hash is persisted. Standard
      // generate-once/show-once API-key issuance pattern (mirrors
      // services/auth/utils/scimTokens.js / mcp-tokens.js / lib/gpuEnroll.js).
      return res.status(201).json({
        host_id: result.hostId,
        org_id: result.orgId,
        token: result.token,
        created_at: result.createdAt,
      });
    } catch (err) {
      return res.status(500).json({ error: 'fleet_host_credential_issue_failed', detail: err.message });
    }
  };
}

// ─── Express middleware: requireFleetHostAuth() ─────────────────────────
// Reads X-Fleet-Host-Token (a distinct header/trust tier from X-Service-Key
// — never conflated with the internal-service master key). Resolves
// req.fleetHost = { hostId, orgId } from the fleet_host_credentials table.
// Fails closed (401) on missing header, malformed value, no match, or a
// revoked credential.
function requireFleetHostAuth(deps = {}) {
  const { getDb } = deps;
  return function fleetHostAuthMiddleware(req, res, next) {
    const header = req.headers['x-fleet-host-token'];
    const token = typeof header === 'string' ? header.trim() : '';

    if (!token) {
      return res.status(401).json({ error: 'fleet_host_token_required', message: 'X-Fleet-Host-Token header is required' });
    }

    let db;
    try {
      db = typeof getDb === 'function' ? getDb() : null;
    } catch (err) {
      return res.status(503).json({ error: 'store_unavailable', detail: err.message });
    }
    if (!db) return res.status(503).json({ error: 'store_unavailable' });

    const credential = resolveFleetHostToken(db, token);
    if (!credential) {
      return res.status(401).json({ error: 'invalid_fleet_host_token', message: 'Unknown, malformed, or revoked fleet host token' });
    }

    // The ONLY org identifier this request is trusted to carry — resolved
    // server-side from the credential binding, never from the request body.
    req.fleetHost = { hostId: credential.hostId, orgId: credential.orgId };
    return next();
  };
}

module.exports = {
  FLEET_HOST_TOKEN_PREFIX,
  generateFleetHostToken,
  hashFleetHostToken,
  issueFleetHostCredential,
  resolveFleetHostToken,
  revokeFleetHostCredential,
  createFleetHostCredentialIssueHandler,
  requireFleetHostAuth,
};
