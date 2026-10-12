/**
 * MON-GOV-3: Governance webhook configuration store.
 *
 * Per-org SIEM delivery targets. auth_secret is encrypted at rest via
 * the AEE field encryption helper (AES-256-GCM with MASTER_ENCRYPTION_KEY).
 * The encryption envelope is opaque to every consumer except the
 * dispatcher, which decrypts on the fly right before signing / sending.
 */

const { SUPPORTED_FORMATS } = require('./governanceEventFormatter.js');
const { encryptField, decryptField } = require('../utils/fieldEncryption.js');
const { INCIDENT_TYPES, INCIDENT_SEVERITIES } = require('./governanceIncidents.js');

const AUTH_SCHEMES = ['none', 'bearer', 'basic', 'hmac'];

// Severity ordering for `min_severity` comparison — higher number = more severe.
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

const UPDATABLE_FIELDS = [
  'target_url',
  'format',
  'auth_scheme',
  'auth_secret',
  'event_type_filter',
  'min_severity',
  'enabled',
  'last_delivery_at',
  'last_status',
  'last_error',
];

function initGovernanceWebhookConfig(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_webhook_config (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      target_url TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'generic_json',
      auth_scheme TEXT NOT NULL DEFAULT 'none',
      auth_secret TEXT,
      event_type_filter TEXT,
      min_severity TEXT NOT NULL DEFAULT 'medium',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_delivery_at TEXT,
      last_status INTEGER,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_org ON governance_webhook_config(org_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_enabled ON governance_webhook_config(enabled);
  `);
}

function generateWebhookId() {
  return `WHK_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function validateInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object') throw new Error('webhook config must be an object');

  if (!partial) {
    if (!input.org_id) throw new Error('org_id is required');
    if (!input.target_url) throw new Error('target_url is required');
  }

  if (input.format !== undefined && !SUPPORTED_FORMATS.includes(input.format)) {
    throw new Error(`format must be one of: ${SUPPORTED_FORMATS.join(', ')}`);
  }
  if (input.auth_scheme !== undefined && !AUTH_SCHEMES.includes(input.auth_scheme)) {
    throw new Error(`auth_scheme must be one of: ${AUTH_SCHEMES.join(', ')}`);
  }
  if (input.min_severity !== undefined && !INCIDENT_SEVERITIES.includes(input.min_severity)) {
    throw new Error(`min_severity must be one of: ${INCIDENT_SEVERITIES.join(', ')}`);
  }
  if (input.event_type_filter !== undefined && input.event_type_filter !== null) {
    if (!Array.isArray(input.event_type_filter)) {
      throw new Error('event_type_filter must be an array or null');
    }
    for (const t of input.event_type_filter) {
      if (!INCIDENT_TYPES.includes(t)) {
        throw new Error(`event_type_filter contains unknown incident_type: ${t}`);
      }
    }
  }
}

function createWebhook(db, input) {
  validateInput(input);

  const id = generateWebhookId();
  const ts = nowIso();
  const row = {
    id,
    org_id: input.org_id,
    target_url: input.target_url,
    format: input.format || 'generic_json',
    auth_scheme: input.auth_scheme || 'none',
    auth_secret: input.auth_secret ? encryptField(input.auth_secret) : null,
    event_type_filter: input.event_type_filter
      ? JSON.stringify(input.event_type_filter)
      : null,
    min_severity: input.min_severity || 'medium',
    enabled: input.enabled === false ? 0 : 1,
    created_at: ts,
    updated_at: ts,
    last_delivery_at: null,
    last_status: null,
    last_error: null,
    consecutive_failures: 0,
  };

  db.prepare(`
    INSERT INTO governance_webhook_config (
      id, org_id, target_url, format, auth_scheme, auth_secret,
      event_type_filter, min_severity, enabled,
      created_at, updated_at, last_delivery_at, last_status, last_error, consecutive_failures
    ) VALUES (
      @id, @org_id, @target_url, @format, @auth_scheme, @auth_secret,
      @event_type_filter, @min_severity, @enabled,
      @created_at, @updated_at, @last_delivery_at, @last_status, @last_error, @consecutive_failures
    )
  `).run(row);

  return getWebhook(db, id);
}

function getWebhook(db, id, { includeSecret = false } = {}) {
  const row = db.prepare('SELECT * FROM governance_webhook_config WHERE id = ?').get(id);
  return row ? deserialize(row, { includeSecret }) : null;
}

function listWebhooks(db, { org_id, enabled } = {}) {
  const where = [];
  const params = [];
  if (org_id) { where.push('org_id = ?'); params.push(org_id); }
  if (enabled !== undefined) { where.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM governance_webhook_config ${whereSql} ORDER BY created_at DESC`)
    .all(...params);
  return rows.map((r) => deserialize(r, { includeSecret: false }));
}

function updateWebhook(db, id, patch) {
  const existing = db.prepare('SELECT * FROM governance_webhook_config WHERE id = ?').get(id);
  if (!existing) throw new Error(`Webhook ${id} not found`);

  validateInput(patch, { partial: true });

  const setClauses = [];
  const params = [];

  for (const field of UPDATABLE_FIELDS) {
    if (patch[field] === undefined) continue;
    setClauses.push(`${field} = ?`);
    if (field === 'enabled') {
      params.push(patch.enabled ? 1 : 0);
    } else if (field === 'auth_secret') {
      params.push(patch.auth_secret ? encryptField(patch.auth_secret) : null);
    } else if (field === 'event_type_filter') {
      params.push(patch.event_type_filter == null ? null : JSON.stringify(patch.event_type_filter));
    } else {
      params.push(patch[field]);
    }
  }

  // Allow callers to reset the circuit-breaker counter explicitly.
  if (patch.consecutive_failures !== undefined) {
    setClauses.push('consecutive_failures = ?');
    params.push(patch.consecutive_failures);
  }

  if (setClauses.length === 0) return deserialize(existing);

  setClauses.push('updated_at = ?');
  params.push(nowIso());

  db.prepare(`
    UPDATE governance_webhook_config SET ${setClauses.join(', ')} WHERE id = ?
  `).run(...params, id);

  return getWebhook(db, id);
}

function deleteWebhook(db, id) {
  const result = db.prepare('DELETE FROM governance_webhook_config WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Find every enabled webhook that should fire for a given incident —
 * org match, severity ≥ min_severity, and event_type_filter (if set)
 * containing the incident_type.
 */
function getMatchingWebhooks(db, incident) {
  if (!incident || !incident.org_id) return [];

  const rows = db
    .prepare('SELECT * FROM governance_webhook_config WHERE org_id = ? AND enabled = 1')
    .all(incident.org_id);

  const incidentRank = SEVERITY_RANK[incident.severity] ?? 2;
  const matches = [];

  for (const row of rows) {
    const cfg = deserialize(row, { includeSecret: true });

    const minRank = SEVERITY_RANK[cfg.min_severity] ?? 2;
    if (incidentRank < minRank) continue;

    if (cfg.event_type_filter && cfg.event_type_filter.length > 0) {
      if (!cfg.event_type_filter.includes(incident.incident_type)) continue;
    }

    matches.push(cfg);
  }

  return matches;
}

// ─── Serialisation ───────────────────────────────────────────────────────

function deserialize(row, { includeSecret = false } = {}) {
  if (!row) return null;
  return {
    ...row,
    enabled: row.enabled === 1,
    event_type_filter: row.event_type_filter ? safeJsonArray(row.event_type_filter) : null,
    auth_secret: includeSecret && row.auth_secret ? decryptField(row.auth_secret) : null,
    has_auth_secret: !!row.auth_secret,
  };
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = {
  SUPPORTED_FORMATS,
  AUTH_SCHEMES,
  SEVERITY_RANK,
  initGovernanceWebhookConfig,
  createWebhook,
  getWebhook,
  listWebhooks,
  updateWebhook,
  deleteWebhook,
  getMatchingWebhooks,
};
