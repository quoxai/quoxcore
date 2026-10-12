/**
 * REG-CORE: Universal Asset Registry library (2026-04-12)
 *
 * Data-layer operations for the four REG tables + the governance-column
 * additions on the agents table. Exports pure functions that take a
 * better-sqlite3 handle — no singleton state, easy to test with
 * in-memory DBs.
 *
 * Used by:
 *   - services/auth/db/index.js to apply the schema at startup
 *   - services/auth/routes/models.js (REG-3 — future route)
 *   - services/auth/scripts/seed-core-agents.js (REG-1)
 *   - services/auth/scripts/seed-models.js (REG-3)
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', 'db', 'schema-reg.sql');

// Asset types recognized by the polymorphic owner/data-class tables.
// Anything outside this list is rejected at write time.
export const KNOWN_ASSET_TYPES = ['agent', 'tool', 'workflow', 'model', 'plugin', 'integration'];

const VALID_RISK_TIERS = ['low', 'standard', 'high', 'critical'];
const VALID_MODEL_STATUS = ['available', 'beta', 'deprecated', 'disabled'];
const VALID_SENSITIVITY = ['public', 'internal', 'confidential', 'restricted'];
const VALID_OWNER_TYPES = ['user', 'team', 'system'];
const VALID_OWNER_ROLES = ['owner', 'steward', 'reviewer'];

const STANDARD_DATA_CLASSES = [
  { id: 'pii',            name: 'Personally Identifiable Information', default_sensitivity: 'confidential', compliance_frameworks_json: '["gdpr"]',           sort_order: 10 },
  { id: 'credentials',    name: 'Credentials and Secrets',             default_sensitivity: 'restricted',   compliance_frameworks_json: '["soc2","iso27001"]', sort_order: 20 },
  { id: 'financial',      name: 'Financial Data',                      default_sensitivity: 'restricted',   compliance_frameworks_json: '["pci"]',             sort_order: 30 },
  { id: 'health',         name: 'Protected Health Information',        default_sensitivity: 'restricted',   compliance_frameworks_json: '["hipaa"]',           sort_order: 40 },
  { id: 'source_code',    name: 'Source Code',                         default_sensitivity: 'confidential', compliance_frameworks_json: '[]',                  sort_order: 50 },
  { id: 'infrastructure', name: 'Infrastructure / Operations',         default_sensitivity: 'confidential', compliance_frameworks_json: '[]',                  sort_order: 60 },
  { id: 'internal',       name: 'Internal Business Data',              default_sensitivity: 'internal',     compliance_frameworks_json: '[]',                  sort_order: 70 },
  { id: 'public',         name: 'Public / Shareable',                  default_sensitivity: 'public',       compliance_frameworks_json: '[]',                  sort_order: 80 },
];

function ulid(prefix) {
  // Simple monotonic-enough ID for test fixtures. Production auth service
  // uses proper ULID elsewhere — this matches that naming convention.
  const t = Date.now().toString(36).padStart(9, '0');
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${t}${r}`;
}

// ─── Schema application ───────────────────────────────────────────────────

export function applyRegSchema(db) {
  if (!existsSync(SCHEMA_PATH)) {
    throw new Error(`REG schema not found at ${SCHEMA_PATH}`);
  }
  const sql = readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(sql);
}

/**
 * Idempotently add governance columns to the agents table.
 * Uses individual ALTER TABLE calls with try/catch because SQLite
 * doesn't have IF NOT EXISTS for columns.
 */
export function applyAgentGovernanceColumns(db) {
  const additions = [
    `ALTER TABLE agents ADD COLUMN is_core INTEGER DEFAULT 0`,
    `ALTER TABLE agents ADD COLUMN risk_tier TEXT DEFAULT 'standard'`,
    `ALTER TABLE agents ADD COLUMN data_classes_json TEXT DEFAULT '[]'`,
    `ALTER TABLE agents ADD COLUMN approval_status TEXT DEFAULT 'approved'`,
    `ALTER TABLE agents ADD COLUMN approved_by TEXT`,
    `ALTER TABLE agents ADD COLUMN approved_at TEXT`,
    `ALTER TABLE agents ADD COLUMN last_reviewed_at TEXT`,
    `ALTER TABLE agents ADD COLUMN compliance_tags_json TEXT DEFAULT '[]'`,
  ];
  for (const sql of additions) {
    try {
      db.exec(sql);
    } catch (err) {
      // "duplicate column" — already applied — ignore
      if (!/duplicate column|already exists/i.test(err.message)) throw err;
    }
  }
}

// ─── Model registry ───────────────────────────────────────────────────────

export function createModel(db, fields) {
  const risk_tier = fields.risk_tier || 'standard';
  if (!VALID_RISK_TIERS.includes(risk_tier)) {
    throw new Error(`risk_tier must be one of: ${VALID_RISK_TIERS.join(', ')}`);
  }
  const status = fields.status || 'available';
  if (!VALID_MODEL_STATUS.includes(status)) {
    throw new Error(`status must be one of: ${VALID_MODEL_STATUS.join(', ')}`);
  }
  if (!fields.model_id || !fields.display_name || !fields.provider) {
    throw new Error('model_id, display_name, and provider are required');
  }

  const id = fields.id || ulid('MDL');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO model_definitions (
      id, model_id, display_name, provider, provider_model_id,
      context_window, supports_vision, supports_tools, supports_streaming,
      cost_per_input_mtok, cost_per_output_mtok,
      risk_tier, data_residency, compliance_certifications, requires_approval,
      status, deprecated_at, replacement_model_id,
      knowledge_cutoff, is_core,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?
    )
  `).run(
    id, fields.model_id, fields.display_name, fields.provider, fields.provider_model_id || null,
    fields.context_window || null,
    fields.supports_vision ? 1 : 0,
    fields.supports_tools === false ? 0 : 1,
    fields.supports_streaming === false ? 0 : 1,
    fields.cost_per_input_mtok || null, fields.cost_per_output_mtok || null,
    risk_tier, fields.data_residency || null,
    fields.compliance_certifications || '[]',
    fields.requires_approval ? 1 : 0,
    status, fields.deprecated_at || null, fields.replacement_model_id || null,
    fields.knowledge_cutoff || null,
    fields.is_core === 0 ? 0 : 1,
    now, now
  );

  return getModel(db, fields.model_id);
}

export function getModel(db, model_id) {
  const row = db.prepare('SELECT * FROM model_definitions WHERE model_id = ?').get(model_id);
  return row || null;
}

export function listModels(db, opts = {}) {
  const filters = [];
  const params = [];
  if (opts.provider) { filters.push('provider = ?'); params.push(opts.provider); }
  if (!opts.includeDeprecated) filters.push("status != 'deprecated'");
  const where = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';
  return db.prepare(`SELECT * FROM model_definitions ${where} ORDER BY provider, model_id`).all(...params);
}

export function updateModel(db, model_id, updates) {
  const allowed = [
    'display_name', 'provider_model_id',
    'context_window', 'supports_vision', 'supports_tools', 'supports_streaming',
    'cost_per_input_mtok', 'cost_per_output_mtok',
    'risk_tier', 'data_residency', 'compliance_certifications', 'requires_approval',
    'status', 'deprecated_at', 'replacement_model_id', 'knowledge_cutoff',
  ];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (key in updates) {
      if (key === 'risk_tier' && !VALID_RISK_TIERS.includes(updates[key])) {
        throw new Error(`risk_tier must be one of: ${VALID_RISK_TIERS.join(', ')}`);
      }
      if (key === 'status' && !VALID_MODEL_STATUS.includes(updates[key])) {
        throw new Error(`status must be one of: ${VALID_MODEL_STATUS.join(', ')}`);
      }
      sets.push(`${key} = ?`);
      params.push(updates[key]);
    }
  }
  sets.push(`updated_at = ?`);
  params.push(new Date().toISOString());
  params.push(model_id);
  db.prepare(`UPDATE model_definitions SET ${sets.join(', ')} WHERE model_id = ?`).run(...params);
  return getModel(db, model_id);
}

// ─── Asset owners ─────────────────────────────────────────────────────────

export function setAssetOwner(db, fields) {
  if (!KNOWN_ASSET_TYPES.includes(fields.asset_type)) {
    throw new Error(`asset_type must be one of: ${KNOWN_ASSET_TYPES.join(', ')}`);
  }
  if (!VALID_OWNER_TYPES.includes(fields.owner_type)) {
    throw new Error(`owner_type must be one of: ${VALID_OWNER_TYPES.join(', ')}`);
  }
  const role = fields.role || 'owner';
  if (!VALID_OWNER_ROLES.includes(role)) {
    throw new Error(`role must be one of: ${VALID_OWNER_ROLES.join(', ')}`);
  }

  const id = ulid('AOW');
  db.prepare(`
    INSERT INTO asset_owners (
      id, org_id, asset_type, asset_id,
      owner_type, owner_id,
      is_primary, role,
      assigned_by, assigned_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, fields.org_id, fields.asset_type, fields.asset_id,
    fields.owner_type, fields.owner_id,
    fields.is_primary ? 1 : 0, role,
    fields.assigned_by || null, new Date().toISOString()
  );
  return db.prepare('SELECT * FROM asset_owners WHERE id = ?').get(id);
}

export function getAssetOwners(db, asset_type, asset_id) {
  return db.prepare(
    'SELECT * FROM asset_owners WHERE asset_type = ? AND asset_id = ? ORDER BY is_primary DESC, assigned_at ASC'
  ).all(asset_type, asset_id);
}

// ─── Asset data classes ───────────────────────────────────────────────────

export function seedDataClassDefinitions(db) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO data_class_definitions
      (id, name, description, default_sensitivity, compliance_frameworks_json, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const cls of STANDARD_DATA_CLASSES) {
      insert.run(
        cls.id, cls.name, cls.description || null,
        cls.default_sensitivity, cls.compliance_frameworks_json, cls.sort_order
      );
    }
  });
  tx();
}

export function setAssetDataClass(db, fields) {
  if (!KNOWN_ASSET_TYPES.includes(fields.asset_type)) {
    throw new Error(`asset_type must be one of: ${KNOWN_ASSET_TYPES.join(', ')}`);
  }
  const sensitivity = fields.sensitivity || 'internal';
  if (!VALID_SENSITIVITY.includes(sensitivity)) {
    throw new Error(`sensitivity must be one of: ${VALID_SENSITIVITY.join(', ')}`);
  }

  const id = ulid('ADC');
  db.prepare(`
    INSERT INTO asset_data_classes (
      id, org_id, asset_type, asset_id,
      data_class, sensitivity,
      classified_by, classified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, fields.org_id, fields.asset_type, fields.asset_id,
    fields.data_class, sensitivity,
    fields.classified_by || null, new Date().toISOString()
  );
  return db.prepare('SELECT * FROM asset_data_classes WHERE id = ?').get(id);
}

export function getAssetDataClasses(db, asset_type, asset_id) {
  return db.prepare(
    'SELECT * FROM asset_data_classes WHERE asset_type = ? AND asset_id = ?'
  ).all(asset_type, asset_id);
}
