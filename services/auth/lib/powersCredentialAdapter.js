/**
 * powersCredentialAdapter.js
 *
 * Adapter layer that writes/reads POWERS credentials through the canonical
 * Vault (integration_credentials) instead of the deprecated powers_credentials
 * parallel table.
 *
 * Label conventions:
 *   mcp_hosted env var:   'powers:{toolDefId}:{key}'
 *   mcp_endpoint auth:    'powers:mcp_endpoint:{toolDefId}'
 *
 * integration_type is always 'custom' (enum supported without schema change).
 * metadata_json.kind distinguishes the two subtypes.
 *
 * All writes use direct SQL on the same DB instance so they can participate
 * in the caller's existing better-sqlite3 transaction (auth-side only, no
 * cross-service HTTP needed).
 *
 * Audit events (secret.create / secret.access) are written by this module
 * for operations that Vault's HTTP layer would normally handle.
 */

import { ulid } from '../utils/helpers.js';
import { encrypt, decrypt } from '../utils/encryption.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a masked key_preview from a plaintext value.
 * Format: first 4 chars + '***' (or '***' if value is short).
 */
function buildKeyPreview(value) {
  if (!value || typeof value !== 'string') return '***';
  return value.length > 4 ? value.slice(0, 4) + '***' : '***';
}

/**
 * Write a secret.create audit event (non-fatal if it fails).
 */
function emitCreateAudit(db, { orgId, actorId, credentialId, label, kind }) {
  try {
    const id = ulid();
    db.prepare(`
      INSERT INTO audit_events (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, orgId, actorId ? 'user' : 'system', actorId || 'system',
      'secret.create', 'integration_credential', credentialId,
      'success',
      JSON.stringify({ label, kind, source: 'powers_credential_adapter' }),
      new Date().toISOString()
    );
  } catch (_) {
    // Audit failure is non-fatal — don't break the deploy transaction
  }
}

/**
 * Write a secret.access audit event (non-fatal if it fails).
 */
function emitAccessAudit(db, { orgId, credentialId, label, kind, actorId }) {
  try {
    const id = ulid();
    db.prepare(`
      INSERT INTO audit_events (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, orgId, 'service', actorId || 'powers-host',
      'secret.access', 'integration_credential', credentialId,
      'success',
      JSON.stringify({ label, kind, source: 'powers_credential_adapter' }),
      new Date().toISOString()
    );
  } catch (_) {
    // Audit failure is non-fatal
  }
}

/**
 * Update last_used_at on a credential row (non-fatal).
 */
function touchLastUsed(db, credentialId) {
  try {
    db.prepare(
      "UPDATE integration_credentials SET last_used_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), credentialId);
  } catch (_) {/* non-fatal */}
}

// ─── P2: mcp_hosted env vars ─────────────────────────────────────────────────

/**
 * Write a single env-var credential to the Vault.
 *
 * Idempotent: if a credential with the same (org_id, NULL scope_id,
 * 'custom', label) already exists, it is updated in place rather than
 * duplicated.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} opts.toolDefId - tool_definitions.id (ULID, NOT the tool_id slug)
 * @param {string} opts.key       - env var name
 * @param {string} opts.value     - plaintext env var value
 * @param {string} [opts.userId]  - deploying user ID
 * @returns {{ id: string, label: string }}
 */
export function putPowersCredential(db, { orgId, toolDefId, key, value, userId }) {
  const label = `powers:${toolDefId}:${key}`;
  const kind = 'mcp_hosted_env';
  const ciphertext = encrypt(value);
  const keyPreview = buildKeyPreview(value);
  const metaJson = JSON.stringify({
    tool_def_id: toolDefId,
    key,
    source: 'powers_mvp',
    kind,
  });
  const now = new Date().toISOString();

  // Check for existing (idempotent upsert)
  const existing = db.prepare(`
    SELECT id FROM integration_credentials
    WHERE org_id = ? AND scope_id IS NULL AND integration_type = 'custom' AND label = ?
  `).get(orgId, label);

  if (existing) {
    db.prepare(`
      UPDATE integration_credentials
      SET ciphertext = ?, key_preview = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?
    `).run(ciphertext, keyPreview, metaJson, now, existing.id);
    return { id: existing.id, label };
  }

  const id = ulid();
  db.prepare(`
    INSERT INTO integration_credentials (
      id, org_id, scope_id, integration_type, label,
      ciphertext, key_preview,
      auth_type, description, metadata_json,
      is_default, created_by, created_at, updated_at
    ) VALUES (?, ?, NULL, 'custom', ?, ?, ?, 'custom', ?, ?, 0, ?, ?, ?)
  `).run(
    id, orgId, label,
    ciphertext, keyPreview,
    `POWERS env var: ${key} for tool ${toolDefId}`,
    metaJson,
    userId || null,
    now, now
  );

  emitCreateAudit(db, { orgId, actorId: userId, credentialId: id, label, kind });
  return { id, label };
}

/**
 * Bulk-write env-var credentials inside an existing transaction.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} opts.toolDefId
 * @param {{ key: string, value: string }[]} opts.envVars
 * @param {string} [opts.userId]
 * @returns {{ id: string, label: string }[]}
 */
export function bulkPutPowersCredentials(db, { orgId, toolDefId, envVars, userId }) {
  const results = [];
  for (const { key, value } of envVars) {
    results.push(putPowersCredential(db, { orgId, toolDefId, key, value, userId }));
  }
  return results;
}

/**
 * List all env-var credentials for a tool (no ciphertext).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @param {string} toolDefId
 * @returns {object[]}
 */
export function listPowersCredentials(db, orgId, toolDefId) {
  return db.prepare(`
    SELECT id, org_id, label, key_preview, auth_type, description, metadata_json,
           created_by, created_at, updated_at, last_used_at
    FROM integration_credentials
    WHERE org_id = ? AND integration_type = 'custom' AND label LIKE ?
    ORDER BY label
  `).all(orgId, `powers:${toolDefId}:%`);
}

/**
 * Get a single env-var credential by (orgId, toolDefId, key) and decrypt it.
 * Emits a secret.access audit event.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @param {string} toolDefId
 * @param {string} key
 * @returns {{ id: string, key: string, value: string } | null}
 */
export function getPowersCredential(db, orgId, toolDefId, key) {
  const label = `powers:${toolDefId}:${key}`;

  const row = db.prepare(`
    SELECT id, org_id, label, ciphertext, metadata_json
    FROM integration_credentials
    WHERE org_id = ? AND scope_id IS NULL AND integration_type = 'custom' AND label = ?
  `).get(orgId, label);

  if (!row) return null;

  const value = decrypt(row.ciphertext);
  touchLastUsed(db, row.id);
  emitAccessAudit(db, { orgId, credentialId: row.id, label, kind: 'mcp_hosted_env' });

  return { id: row.id, key, value };
}

/**
 * Get all decrypted env vars for a tool (used at spawn time).
 * Returns an array of { key, value } pairs.
 * Emits secret.access audit events for each credential read.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @param {string} toolDefId
 * @returns {{ key: string, value: string }[]}
 */
export function getAllPowersCredentials(db, orgId, toolDefId) {
  const rows = db.prepare(`
    SELECT id, label, ciphertext, metadata_json
    FROM integration_credentials
    WHERE org_id = ? AND integration_type = 'custom' AND label LIKE ?
    ORDER BY label
  `).all(orgId, `powers:${toolDefId}:%`);

  const results = [];
  for (const row of rows) {
    let plainValue;
    try {
      plainValue = decrypt(row.ciphertext);
    } catch (err) {
      console.error(`[powersCredentialAdapter] decrypt failed for credential id=${row.id}: ${err.message}`);
      throw new Error(`credential_decrypt_failed: id=${row.id}`);
    }

    touchLastUsed(db, row.id);
    emitAccessAudit(db, { orgId, credentialId: row.id, label: row.label, kind: 'mcp_hosted_env' });

    // Extract key from label format 'powers:{toolDefId}:{key}'
    const labelParts = row.label.split(':');
    const key = labelParts.slice(2).join(':'); // key may contain colons
    results.push({ key, value: plainValue });
  }

  return results;
}

/**
 * Delete a single env-var credential.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @param {string} toolDefId
 * @param {string} key
 * @returns {boolean} true if deleted
 */
export function deletePowersCredential(db, orgId, toolDefId, key) {
  const label = `powers:${toolDefId}:${key}`;
  const result = db.prepare(`
    DELETE FROM integration_credentials
    WHERE org_id = ? AND scope_id IS NULL AND integration_type = 'custom' AND label = ?
  `).run(orgId, label);
  return result.changes > 0;
}

/**
 * Delete all env-var credentials for a tool (used at teardown).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @param {string} toolDefId
 * @returns {number} number of rows deleted
 */
export function deletePowersCredentialsForTool(db, orgId, toolDefId) {
  const result = db.prepare(`
    DELETE FROM integration_credentials
    WHERE org_id = ? AND integration_type = 'custom' AND label LIKE ?
  `).run(orgId, `powers:${toolDefId}:%`);
  return result.changes;
}

// ─── P1: mcp_endpoint auth value ─────────────────────────────────────────────

/**
 * Store the mcp_endpoint authentication value in the Vault.
 *
 * Label: 'powers:mcp_endpoint:{toolDefId}'
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} opts.toolDefId
 * @param {string} opts.authValue - plaintext auth token/header value
 * @param {string} opts.authKind  - 'bearer' | 'header' | 'none'
 * @param {string} [opts.userId]
 * @returns {{ id: string, label: string } | null} null if authKind is 'none' or authValue is empty
 */
export function putMcpEndpointAuth(db, { orgId, toolDefId, authValue, authKind, userId }) {
  if (!authValue || authKind === 'none') return null;

  const label = `powers:mcp_endpoint:${toolDefId}`;
  const kind = 'mcp_endpoint_auth';
  const ciphertext = encrypt(authValue);
  const keyPreview = buildKeyPreview(authValue);
  const metaJson = JSON.stringify({
    tool_def_id: toolDefId,
    auth_kind: authKind,
    source: 'powers_mvp',
    kind,
  });
  const now = new Date().toISOString();

  // Idempotent upsert
  const existing = db.prepare(`
    SELECT id FROM integration_credentials
    WHERE org_id = ? AND scope_id IS NULL AND integration_type = 'custom' AND label = ?
  `).get(orgId, label);

  if (existing) {
    db.prepare(`
      UPDATE integration_credentials
      SET ciphertext = ?, key_preview = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?
    `).run(ciphertext, keyPreview, metaJson, now, existing.id);
    return { id: existing.id, label };
  }

  const id = ulid();
  db.prepare(`
    INSERT INTO integration_credentials (
      id, org_id, scope_id, integration_type, label,
      ciphertext, key_preview,
      auth_type, description, metadata_json,
      is_default, created_by, created_at, updated_at
    ) VALUES (?, ?, NULL, 'custom', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    id, orgId, label,
    ciphertext, keyPreview,
    authKind === 'bearer' ? 'bearer' : 'custom',
    `POWERS mcp_endpoint auth for tool ${toolDefId}`,
    metaJson,
    userId || null,
    now, now
  );

  emitCreateAudit(db, { orgId, actorId: userId, credentialId: id, label, kind });
  return { id, label };
}

/**
 * Get the mcp_endpoint auth value for a tool and decrypt it.
 * Emits a secret.access audit event.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @param {string} toolDefId
 * @returns {{ id: string, authKind: string, authValue: string } | null}
 */
export function getMcpEndpointAuth(db, orgId, toolDefId) {
  const label = `powers:mcp_endpoint:${toolDefId}`;

  const row = db.prepare(`
    SELECT id, org_id, label, ciphertext, metadata_json
    FROM integration_credentials
    WHERE org_id = ? AND scope_id IS NULL AND integration_type = 'custom' AND label = ?
  `).get(orgId, label);

  if (!row) return null;

  const authValue = decrypt(row.ciphertext);
  const meta = JSON.parse(row.metadata_json || '{}');
  touchLastUsed(db, row.id);
  emitAccessAudit(db, { orgId, credentialId: row.id, label, kind: 'mcp_endpoint_auth' });

  return { id: row.id, authKind: meta.auth_kind || 'custom', authValue };
}

/**
 * Delete the mcp_endpoint auth credential for a tool.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @param {string} toolDefId
 * @returns {boolean}
 */
export function deleteMcpEndpointAuth(db, orgId, toolDefId) {
  const label = `powers:mcp_endpoint:${toolDefId}`;
  const result = db.prepare(`
    DELETE FROM integration_credentials
    WHERE org_id = ? AND scope_id IS NULL AND integration_type = 'custom' AND label = ?
  `).run(orgId, label);
  return result.changes > 0;
}

export default {
  putPowersCredential,
  bulkPutPowersCredentials,
  listPowersCredentials,
  getPowersCredential,
  getAllPowersCredentials,
  deletePowersCredential,
  deletePowersCredentialsForTool,
  putMcpEndpointAuth,
  getMcpEndpointAuth,
  deleteMcpEndpointAuth,
};
