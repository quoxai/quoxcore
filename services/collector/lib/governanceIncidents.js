/**
 * MON-GOV Phase 0: Governance Incidents Module
 *
 * Server-side store + CRUD for governance incidents. Records policy
 * violations, anomalies, and threshold breaches detected at runtime.
 *
 * Primary insertion path (wired in Phase 1): the AOCL layer envelope
 * emitter at server.js:2124 calls createIncidentFromEnvelope() for
 * governance-relevant intents. Dedup by (corr, layer, policy_id,
 * incident_type) keeps pipeline retries idempotent.
 *
 * Incident rows live in voltDb alongside compliance_jobs and VOLT runs
 * (the operational-response domain). Linked AEE envelopes live in aeeDb
 * and are resolved via envelope_ids at read time.
 */

const crypto = require('crypto');

const INCIDENT_TYPES = [
  'policy_violation',
  'anomaly_detected',
  'threshold_breach',
  'manual',
  'response_blocked',
  'identity_missing',
  // QUOXTRUST WP4.2: raised by lib/evidenceReconciler.js when the bidirectional
  // reconciliation finds a settled effect without a provable witnessed receipt,
  // a broken WARD chain window, or a witnessed hash diverging from its
  // decrypted source envelope. corr is qtrust:<direction>:<subject>.
  'evidence_mismatch',
];

const INCIDENT_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

const INCIDENT_STATUSES = [
  'open',
  'investigating',
  'resolved',
  'closed',
  'false_positive',
];

const UPDATABLE_FIELDS = [
  'status',
  'severity',
  'assigned_to',
  'resolution',
  'escalated',
  'witnessed_by_ward',
  'witness_receipt',
];

// ============================================================
// Schema Init
// ============================================================

function initGovernanceIncidents(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_incidents (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      incident_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      layer TEXT,
      policy_id TEXT,
      policy_name TEXT,
      framework_mapping TEXT NOT NULL DEFAULT '[]',
      corr TEXT NOT NULL,
      envelope_ids TEXT NOT NULL DEFAULT '[]',
      agent_id TEXT,
      user_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      context_json TEXT,
      assigned_to TEXT,
      resolution TEXT,
      resolved_at TEXT,
      escalated INTEGER NOT NULL DEFAULT 0,
      witnessed_by_ward INTEGER NOT NULL DEFAULT 0,
      witness_receipt TEXT,
      dedup_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_dedup ON governance_incidents(dedup_key);
    CREATE INDEX IF NOT EXISTS idx_incidents_org_status ON governance_incidents(org_id, status);
    CREATE INDEX IF NOT EXISTS idx_incidents_corr ON governance_incidents(corr);
    CREATE INDEX IF NOT EXISTS idx_incidents_created ON governance_incidents(created_at);
    CREATE INDEX IF NOT EXISTS idx_incidents_severity ON governance_incidents(severity);
  `);
}

// ============================================================
// Dedup key
// ============================================================

function computeDedupKey({ corr, layer, policy_id, incident_type }) {
  const parts = [
    corr ?? '',
    layer ?? '',
    policy_id ?? '',
    incident_type ?? '',
  ].join('|');
  return crypto.createHash('sha256').update(parts).digest('hex');
}

// ============================================================
// CRUD
// ============================================================

function generateIncidentId() {
  return `INC_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function validateOnCreate(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('incident payload must be an object');
  }
  if (!input.org_id) throw new Error('org_id is required');
  if (!input.corr) throw new Error('corr is required');
  if (!input.title) throw new Error('title is required');
  if (!INCIDENT_TYPES.includes(input.incident_type)) {
    throw new Error(`incident_type must be one of: ${INCIDENT_TYPES.join(', ')}`);
  }
  if (input.severity && !INCIDENT_SEVERITIES.includes(input.severity)) {
    throw new Error(`severity must be one of: ${INCIDENT_SEVERITIES.join(', ')}`);
  }
  if (input.status && !INCIDENT_STATUSES.includes(input.status)) {
    throw new Error(`status must be one of: ${INCIDENT_STATUSES.join(', ')}`);
  }
}

function createIncident(db, input) {
  validateOnCreate(input);

  const id = generateIncidentId();
  const ts = nowIso();
  const dedup_key = computeDedupKey({
    corr: input.corr,
    layer: input.layer ?? null,
    policy_id: input.policy_id ?? null,
    incident_type: input.incident_type,
  });

  // Detect whether this call will be an insert or an upsert BEFORE the write.
  // We don't rely on timestamp comparison because nowIso() has 1 ms
  // resolution — under load, two emissions can land in the same ms and
  // an upsert would look identical to a first insert. better-sqlite3
  // runs synchronously on one writer so the SELECT → INSERT sequence
  // isn't racy in practice.
  const existing = db
    .prepare('SELECT id FROM governance_incidents WHERE dedup_key = ?')
    .get(dedup_key);
  const inserted = !existing;

  const row = {
    id,
    org_id: input.org_id,
    incident_type: input.incident_type,
    severity: input.severity || 'medium',
    status: input.status || 'open',
    layer: input.layer ?? null,
    policy_id: input.policy_id ?? null,
    policy_name: input.policy_name ?? null,
    framework_mapping: JSON.stringify(input.framework_mapping ?? []),
    corr: input.corr,
    envelope_ids: JSON.stringify(input.envelope_ids ?? []),
    agent_id: input.agent_id ?? null,
    user_id: input.user_id ?? null,
    title: input.title,
    description: input.description ?? null,
    context_json: input.context_json === undefined ? null : JSON.stringify(input.context_json),
    assigned_to: input.assigned_to ?? null,
    resolution: input.resolution ?? null,
    resolved_at: input.resolved_at ?? null,
    escalated: input.escalated ? 1 : 0,
    witnessed_by_ward: input.witnessed_by_ward ? 1 : 0,
    witness_receipt: input.witness_receipt ?? null,
    dedup_key,
    created_at: ts,
    updated_at: ts,
  };

  // ON CONFLICT DO UPDATE keeps the handler idempotent under pipeline
  // retry. We only bump updated_at and refresh the incoming context —
  // resolver state (status, resolution, assigned_to) is preserved.
  db.prepare(`
    INSERT INTO governance_incidents (
      id, org_id, incident_type, severity, status,
      layer, policy_id, policy_name, framework_mapping,
      corr, envelope_ids, agent_id, user_id,
      title, description, context_json,
      assigned_to, resolution, resolved_at,
      escalated, witnessed_by_ward, witness_receipt,
      dedup_key, created_at, updated_at
    ) VALUES (
      @id, @org_id, @incident_type, @severity, @status,
      @layer, @policy_id, @policy_name, @framework_mapping,
      @corr, @envelope_ids, @agent_id, @user_id,
      @title, @description, @context_json,
      @assigned_to, @resolution, @resolved_at,
      @escalated, @witnessed_by_ward, @witness_receipt,
      @dedup_key, @created_at, @updated_at
    )
    ON CONFLICT(dedup_key) DO UPDATE SET
      description = excluded.description,
      context_json = excluded.context_json,
      envelope_ids = excluded.envelope_ids,
      updated_at = excluded.updated_at
  `).run(row);

  const stored = db
    .prepare('SELECT * FROM governance_incidents WHERE dedup_key = ?')
    .get(dedup_key);
  const result = deserialize(stored);
  // Non-persisted signal for callers that want to fire side-effects
  // (WARD self-envelope, SIEM fan-out) only on the first insert.
  if (result) result._inserted = inserted;

  // COMMANDERQ P10 auto-detect -> call: on a FRESH CRITICAL incident, best-effort
  // fire the tripwire brain (raise a contactability-gated call intent / Telegram
  // fallback). Fully decoupled + guarded: runs out-of-band via setImmediate,
  // swallows all errors, and no-ops unless server.js registered the handler — it
  // can never throw into or slow down incident creation.
  if (result && inserted && result.severity === 'critical' && typeof global.__quoxHandleTripwireIncident === 'function') {
    setImmediate(() => {
      try {
        Promise.resolve(global.__quoxHandleTripwireIncident(
          { severity: 'critical', category: result.incident_type, source: `governance:${result.incident_type}`, summary: result.title },
          result.org_id, { actor: 'agent.quox', corr: result.corr }
        )).catch(() => {});
      } catch (_) { /* never affect incident creation */ }
    });
  }
  return result;
}

function getIncident(db, id) {
  const row = db.prepare('SELECT * FROM governance_incidents WHERE id = ?').get(id);
  return row ? deserialize(row) : null;
}

function listIncidents(db, filters = {}) {
  const {
    org_id,
    severity,
    status,
    incident_type,
    agent_id,
    corr,
    since,
    until,
    limit = 100,
    offset = 0,
  } = filters;

  const where = [];
  const params = [];

  if (org_id) { where.push('org_id = ?'); params.push(org_id); }
  if (severity) { where.push('severity = ?'); params.push(severity); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (incident_type) { where.push('incident_type = ?'); params.push(incident_type); }
  if (agent_id) { where.push('agent_id = ?'); params.push(agent_id); }
  if (corr) { where.push('corr = ?'); params.push(corr); }
  if (since) { where.push('created_at >= ?'); params.push(since); }
  if (until) { where.push('created_at <= ?'); params.push(until); }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM governance_incidents ${whereSql}`)
    .get(...params).n;

  const rows = db
    .prepare(`
      SELECT * FROM governance_incidents ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset);

  return {
    data: rows.map(deserialize),
    total,
  };
}

function updateIncident(db, id, patch = {}) {
  const existing = db.prepare('SELECT * FROM governance_incidents WHERE id = ?').get(id);
  if (!existing) {
    throw new Error(`Incident ${id} not found`);
  }

  if (patch.status !== undefined && !INCIDENT_STATUSES.includes(patch.status)) {
    throw new Error(`status must be one of: ${INCIDENT_STATUSES.join(', ')}`);
  }
  if (patch.severity !== undefined && !INCIDENT_SEVERITIES.includes(patch.severity)) {
    throw new Error(`severity must be one of: ${INCIDENT_SEVERITIES.join(', ')}`);
  }

  const setClauses = [];
  const params = [];

  for (const field of UPDATABLE_FIELDS) {
    if (patch[field] === undefined) continue;
    setClauses.push(`${field} = ?`);
    if (field === 'escalated' || field === 'witnessed_by_ward') {
      params.push(patch[field] ? 1 : 0);
    } else {
      params.push(patch[field]);
    }
  }

  // Auto-stamp resolved_at on status transitions into a terminal state
  const terminal = new Set(['resolved', 'closed', 'false_positive']);
  if (patch.status !== undefined && terminal.has(patch.status) && !existing.resolved_at) {
    setClauses.push('resolved_at = ?');
    params.push(nowIso());
  }

  if (setClauses.length === 0) {
    return deserialize(existing);
  }

  setClauses.push('updated_at = ?');
  params.push(nowIso());

  db.prepare(`
    UPDATE governance_incidents SET ${setClauses.join(', ')} WHERE id = ?
  `).run(...params, id);

  const updated = db.prepare('SELECT * FROM governance_incidents WHERE id = ?').get(id);
  return deserialize(updated);
}

// ============================================================
// Serialisation
// ============================================================

function deserialize(row) {
  if (!row) return null;
  return {
    ...row,
    escalated: row.escalated === 1,
    witnessed_by_ward: row.witnessed_by_ward === 1,
    framework_mapping: safeJsonArray(row.framework_mapping),
    envelope_ids: safeJsonArray(row.envelope_ids),
    context_json: row.context_json == null ? null : safeJson(row.context_json),
  };
}

function safeJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// ============================================================
// Envelope → Incident mapper (Phase 1 hook)
// ============================================================

const GOVERNANCE_REJECT_INTENTS = new Set([
  'aocl.layer.L1.reject',
  'aocl.layer.L3.reject',
  'aocl.layer.L8.reject',
  'aocl.run.reject',
  'aocl.policy.reject',
]);

const SENSITIVE_FRAMEWORK_PREFIXES = ['gdpr', 'hipaa', 'pci'];

function isGovernanceRejection(envelope) {
  if (!envelope || typeof envelope.intent !== 'string') return false;
  return GOVERNANCE_REJECT_INTENTS.has(envelope.intent);
}

function extractUserId(envelope) {
  const to = envelope?.to || '';
  if (!to || to === 'human.anonymous') return null;
  const match = to.match(/^human\.(.+)$/);
  return match ? match[1] : null;
}

function deriveIncidentType(intent) {
  if (intent === 'aocl.layer.L1.reject') return 'identity_missing';
  if (intent === 'aocl.layer.L8.reject') return 'response_blocked';
  return 'policy_violation';
}

function deriveLayer(envelope) {
  if (envelope.intent === 'aocl.run.reject') return null;
  if (envelope.intent === 'aocl.policy.reject') return null;
  return envelope.payload?.layer ?? null;
}

function deriveSeverity(envelope) {
  const intent = envelope.intent;
  const payload = envelope.payload || {};
  if (intent === 'aocl.layer.L1.reject') return 'high';
  if (intent === 'aocl.layer.L8.reject') return 'medium';
  if (intent === 'aocl.run.reject') return 'medium';
  if (intent === 'aocl.policy.reject') return 'medium';
  if (intent === 'aocl.layer.L3.reject') {
    const frameworks = (payload.matchedPolicies || [])
      .flatMap((p) => p.frameworks || [])
      .map((f) => String(f).toLowerCase());
    if (frameworks.some((f) => SENSITIVE_FRAMEWORK_PREFIXES.some((pfx) => f.startsWith(pfx)))) {
      return 'high';
    }
    if (payload.category === 'safety') return 'high';
    return 'medium';
  }
  return 'medium';
}

function deriveTitle(envelope) {
  const payload = envelope.payload || {};
  const reason = payload.reason || payload.denyReason || payload.firstDenialReason || 'policy violation';
  switch (envelope.intent) {
    case 'aocl.layer.L1.reject':
      return `L1 identity check failed: ${reason}`;
    case 'aocl.layer.L3.reject': {
      const matched = (payload.matchedPolicies || [])[0];
      return matched ? `L3 policy denial: ${matched.name}` : `L3 policy denial: ${reason}`;
    }
    case 'aocl.layer.L8.reject':
      return `L8 response blocked: ${reason}`;
    case 'aocl.run.reject':
      return `AOCL run rejected: ${reason}`;
    case 'aocl.policy.reject':
      return `Execution policy denied: ${reason}`;
    default:
      return 'Governance incident';
  }
}

/**
 * Translate a governance-reject envelope into a createIncident() payload.
 * Returns null if the envelope is not a governance rejection or lacks corr.
 */
function mapEnvelopeToIncident(envelope) {
  if (!isGovernanceRejection(envelope)) return null;
  if (!envelope.corr) return null;

  const payload = envelope.payload || {};
  const matched = (payload.matchedPolicies || [])[0] || null;

  return {
    org_id: payload.orgId || '__default__',
    incident_type: deriveIncidentType(envelope.intent),
    severity: deriveSeverity(envelope),
    layer: deriveLayer(envelope),
    policy_id: matched ? matched.id || null : null,
    policy_name: matched ? matched.name || null : null,
    framework_mapping: matched ? (matched.frameworks || []) : [],
    corr: envelope.corr,
    envelope_ids: envelope.id ? [envelope.id] : [],
    agent_id: payload.agent || null,
    user_id: extractUserId(envelope),
    title: deriveTitle(envelope),
    description: payload.reason || payload.denyReason || payload.firstDenialReason || null,
    context_json: {
      intent: envelope.intent,
      payload,
    },
  };
}

/**
 * Emitter-facing helper. Must never throw — governance observability should
 * never take down the chat pipeline. Callers should not rely on the return
 * value; null means the envelope was not actionable.
 */
function createIncidentFromEnvelope(db, envelope) {
  try {
    const input = mapEnvelopeToIncident(envelope);
    if (!input) return null;
    return createIncident(db, input);
  } catch (err) {
    console.warn('[MON-GOV] createIncidentFromEnvelope failed (non-fatal):', err.message);
    return null;
  }
}

module.exports = {
  INCIDENT_TYPES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  initGovernanceIncidents,
  createIncident,
  getIncident,
  listIncidents,
  updateIncident,
  computeDedupKey,
  isGovernanceRejection,
  mapEnvelopeToIncident,
  createIncidentFromEnvelope,
};
