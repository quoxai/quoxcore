/**
 * MON-GOV-INT Phase 1: Governance ticketing configuration store.
 *
 * Per-org ticketing targets (Jira first; PagerDuty/ServiceNow are
 * provider-enum-valid but their adapters ship in later phases). Unlike
 * governance_webhook_config, NO secret ever lives on this table — only a
 * `credential_id` reference into the vault (integration_credentials).
 * The dispatcher resolves the credential at send time.
 */

const { INCIDENT_TYPES, INCIDENT_SEVERITIES } = require('./governanceIncidents.js');

const PROVIDERS = ['jira', 'pagerduty', 'servicenow'];

// Severity ordering for `min_severity` comparison — mirrors
// governanceWebhookConfig.js's SEVERITY_RANK (higher number = more severe).
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

const UPDATABLE_FIELDS = [
  'provider',
  'credential_id',
  'settings_json',
  'min_severity',
  'incident_type_filter',
  'enabled',
  'resolve_sync',
  'rate_limit_max',
  'rate_limit_window_s',
  'suppressed_count',
  'last_delivery_at',
  'last_status',
  'last_error',
  'consecutive_failures',
];

function initGovernanceTicketConfig(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_ticket_config (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}',
      min_severity TEXT NOT NULL DEFAULT 'high',
      incident_type_filter TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      resolve_sync INTEGER NOT NULL DEFAULT 1,
      rate_limit_max INTEGER NOT NULL DEFAULT 10,
      rate_limit_window_s INTEGER NOT NULL DEFAULT 300,
      suppressed_count INTEGER NOT NULL DEFAULT 0,
      last_delivery_at TEXT,
      last_status INTEGER,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_config_org ON governance_ticket_config(org_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_config_enabled ON governance_ticket_config(enabled);
  `);
}

function generateTicketConfigId() {
  return `TKT_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function validateInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object') throw new Error('ticket config must be an object');

  if (!partial) {
    if (!input.org_id) throw new Error('org_id is required');
    if (!input.provider) throw new Error('provider is required');
    if (!input.credential_id) throw new Error('credential_id is required');
  }

  if (input.provider !== undefined && !PROVIDERS.includes(input.provider)) {
    throw new Error(`provider must be one of: ${PROVIDERS.join(', ')}`);
  }
  if (input.min_severity !== undefined && !INCIDENT_SEVERITIES.includes(input.min_severity)) {
    throw new Error(`min_severity must be one of: ${INCIDENT_SEVERITIES.join(', ')}`);
  }
  if (input.incident_type_filter !== undefined && input.incident_type_filter !== null) {
    if (!Array.isArray(input.incident_type_filter)) {
      throw new Error('incident_type_filter must be an array or null');
    }
    for (const t of input.incident_type_filter) {
      if (!INCIDENT_TYPES.includes(t)) {
        throw new Error(`incident_type_filter contains unknown incident_type: ${t}`);
      }
    }
  }

  const provider = input.provider;
  const settings = input.settings_json && typeof input.settings_json === 'object' ? input.settings_json : {};
  if (provider === 'jira' && !partial && !settings.project_key) {
    throw new Error('jira settings require project_key');
  }
}

function createTicketConfig(db, input) {
  validateInput(input);

  const id = generateTicketConfigId();
  const ts = nowIso();
  const row = {
    id,
    org_id: input.org_id,
    provider: input.provider,
    credential_id: input.credential_id,
    settings_json: JSON.stringify(input.settings_json || {}),
    min_severity: input.min_severity || 'high',
    incident_type_filter: input.incident_type_filter
      ? JSON.stringify(input.incident_type_filter)
      : null,
    enabled: input.enabled === false ? 0 : 1,
    resolve_sync: input.resolve_sync === false ? 0 : 1,
    rate_limit_max: input.rate_limit_max ?? 10,
    rate_limit_window_s: input.rate_limit_window_s ?? 300,
    suppressed_count: 0,
    last_delivery_at: null,
    last_status: null,
    last_error: null,
    consecutive_failures: 0,
    created_at: ts,
    updated_at: ts,
  };

  db.prepare(`
    INSERT INTO governance_ticket_config (
      id, org_id, provider, credential_id, settings_json,
      min_severity, incident_type_filter, enabled, resolve_sync,
      rate_limit_max, rate_limit_window_s, suppressed_count,
      last_delivery_at, last_status, last_error, consecutive_failures,
      created_at, updated_at
    ) VALUES (
      @id, @org_id, @provider, @credential_id, @settings_json,
      @min_severity, @incident_type_filter, @enabled, @resolve_sync,
      @rate_limit_max, @rate_limit_window_s, @suppressed_count,
      @last_delivery_at, @last_status, @last_error, @consecutive_failures,
      @created_at, @updated_at
    )
  `).run(row);

  return getTicketConfig(db, id);
}

function getTicketConfig(db, id) {
  const row = db.prepare('SELECT * FROM governance_ticket_config WHERE id = ?').get(id);
  return row ? deserialize(row) : null;
}

function listTicketConfigs(db, { org_id, enabled } = {}) {
  const where = [];
  const params = [];
  if (org_id) { where.push('org_id = ?'); params.push(org_id); }
  if (enabled !== undefined) { where.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM governance_ticket_config ${whereSql} ORDER BY created_at DESC`)
    .all(...params);
  return rows.map(deserialize);
}

function updateTicketConfig(db, id, patch) {
  const existing = db.prepare('SELECT * FROM governance_ticket_config WHERE id = ?').get(id);
  if (!existing) throw new Error(`Ticket config ${id} not found`);

  validateInput(patch, { partial: true });

  const setClauses = [];
  const params = [];

  for (const field of UPDATABLE_FIELDS) {
    if (patch[field] === undefined) continue;
    setClauses.push(`${field} = ?`);
    if (field === 'enabled' || field === 'resolve_sync') {
      params.push(patch[field] ? 1 : 0);
    } else if (field === 'settings_json') {
      params.push(JSON.stringify(patch.settings_json || {}));
    } else if (field === 'incident_type_filter') {
      params.push(patch.incident_type_filter == null ? null : JSON.stringify(patch.incident_type_filter));
    } else {
      params.push(patch[field]);
    }
  }

  if (setClauses.length === 0) return deserialize(existing);

  setClauses.push('updated_at = ?');
  params.push(nowIso());

  db.prepare(`
    UPDATE governance_ticket_config SET ${setClauses.join(', ')} WHERE id = ?
  `).run(...params, id);

  return getTicketConfig(db, id);
}

function deleteTicketConfig(db, id) {
  const result = db.prepare('DELETE FROM governance_ticket_config WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Find every enabled ticket config that should fire for a given incident —
 * org match, severity ≥ min_severity, and incident_type_filter (if set)
 * containing the incident_type. Mirrors getMatchingWebhooks().
 */
function getMatchingTicketConfigs(db, incident) {
  if (!incident || !incident.org_id) return [];

  const rows = db
    .prepare('SELECT * FROM governance_ticket_config WHERE org_id = ? AND enabled = 1')
    .all(incident.org_id);

  const incidentRank = SEVERITY_RANK[incident.severity] ?? 2;
  const matches = [];

  for (const row of rows) {
    const cfg = deserialize(row);

    const minRank = SEVERITY_RANK[cfg.min_severity] ?? 3;
    if (incidentRank < minRank) continue;

    if (cfg.incident_type_filter && cfg.incident_type_filter.length > 0) {
      if (!cfg.incident_type_filter.includes(incident.incident_type)) continue;
    }

    matches.push(cfg);
  }

  return matches;
}

// ─── Serialisation ───────────────────────────────────────────────────────

function deserialize(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: row.enabled === 1,
    resolve_sync: row.resolve_sync === 1,
    settings_json: safeJsonObject(row.settings_json),
    incident_type_filter: row.incident_type_filter ? safeJsonArray(row.incident_type_filter) : null,
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

function safeJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = {
  PROVIDERS,
  SEVERITY_RANK,
  initGovernanceTicketConfig,
  createTicketConfig,
  getTicketConfig,
  listTicketConfigs,
  updateTicketConfig,
  deleteTicketConfig,
  getMatchingTicketConfigs,
};
