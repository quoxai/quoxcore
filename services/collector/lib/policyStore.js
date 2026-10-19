/**
 * GOV-1: Unified Policy Store
 *
 * Server-side policy storage with CRUD, validation, and seed policies.
 * Replaces the hardcoded POLICY_CONFIG in policyGate.js with a database-backed store.
 *
 * Categories: safety, execution, governance, compliance
 * Effects: allow, deny, require_approval, redact, log_only
 */

const {
  initPolicyHistory,
  appendHistoryEntry,
  computeDiff,
} = require('./policyHistory.js');

const POLICY_CATEGORIES = ['safety', 'execution', 'governance', 'compliance'];
const POLICY_EFFECTS = ['allow', 'deny', 'require_approval', 'redact', 'log_only'];
const CONDITION_OPERATORS = ['AND', 'OR'];
const LEAF_OPERATORS = ['==', '!=', '>', '<', '>=', '<=', 'matches', 'contains', 'in', 'not_in'];
const MAX_CONDITION_DEPTH = 3;

// POL-HIST: context passed to create/update/delete telling history who
// is responsible. Defaults preserve the old silent behaviour (rows get
// actor_id='unknown', actor_source='api') so existing callers don't
// need to change.
//
// 4-eyes approval is OPT-IN via ctx.enforce_4eyes. The existing
// `audit_required` column on policies means "matches of this policy
// produce audit envelopes" — unrelated to whether MUTATING the policy
// needs review. The API layer is the right boundary to decide
// enforce_4eyes (based on org plan, policy category, user role, etc.).
function normaliseCtx(ctx) {
  return {
    actor_id: ctx?.actor_id || 'unknown',
    actor_email: ctx?.actor_email || null,
    actor_label: ctx?.actor_label || ctx?.actor_id || 'unknown',
    actor_source: ctx?.actor_source || 'api',
    reason: ctx?.reason ?? null,
    request_id: ctx?.request_id ?? null,
    enforce_4eyes: !!ctx?.enforce_4eyes,
  };
}

// ============================================================
// Schema Init
// ============================================================

function initPolicyStore(db) {
  // Co-init the POL-HIST table so every policyStore consumer gets
  // change-history machinery for free.
  initPolicyHistory(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      scope TEXT NOT NULL DEFAULT '{}',
      conditions TEXT NOT NULL DEFAULT '{}',
      effect TEXT NOT NULL DEFAULT 'deny',
      reason TEXT DEFAULT '',
      framework_mapping TEXT DEFAULT '[]',
      audit_required INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      org_id TEXT NOT NULL,
      created_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(name, org_id)
    );
    CREATE INDEX IF NOT EXISTS idx_policies_org ON policies(org_id);
    CREATE INDEX IF NOT EXISTS idx_policies_category ON policies(category);
    CREATE INDEX IF NOT EXISTS idx_policies_enabled ON policies(enabled);
  `);
}

// ============================================================
// Validation
// ============================================================

function validateConditionNode(node, depth = 0) {
  const errors = [];

  if (depth > MAX_CONDITION_DEPTH) {
    errors.push({ field: 'conditions', message: `Condition nesting exceeds max depth of ${MAX_CONDITION_DEPTH}` });
    return errors;
  }

  if (!node || typeof node !== 'object') {
    errors.push({ field: 'conditions', message: 'Condition must be an object' });
    return errors;
  }

  // Group node (has operator + conditions array)
  if (node.conditions) {
    if (!node.operator || !CONDITION_OPERATORS.includes(node.operator)) {
      errors.push({ field: 'conditions.operator', message: `Condition group operator must be one of: ${CONDITION_OPERATORS.join(', ')}` });
    }
    if (!Array.isArray(node.conditions)) {
      errors.push({ field: 'conditions', message: 'conditions must be an array' });
    } else {
      for (const child of node.conditions) {
        errors.push(...validateConditionNode(child, depth + 1));
      }
    }
    return errors;
  }

  // Leaf node (has field, operator, value)
  if (!node.field || typeof node.field !== 'string') {
    errors.push({ field: 'conditions', message: 'Condition leaf must have a string field' });
  }
  if (!node.operator || !LEAF_OPERATORS.includes(node.operator)) {
    errors.push({ field: 'conditions', message: `Condition leaf operator must be one of: ${LEAF_OPERATORS.join(', ')}` });
  }
  if (node.value === undefined) {
    errors.push({ field: 'conditions', message: 'Condition leaf must have a value' });
  }

  return errors;
}

function validatePolicy(policy) {
  const errors = [];

  // Name
  if (!policy.name || typeof policy.name !== 'string' || policy.name.trim() === '') {
    errors.push({ field: 'name', message: 'Name is required' });
  }

  // Category
  if (!POLICY_CATEGORIES.includes(policy.category)) {
    errors.push({ field: 'category', message: `Category must be one of: ${POLICY_CATEGORIES.join(', ')}` });
  }

  // Effect
  if (!POLICY_EFFECTS.includes(policy.effect)) {
    errors.push({ field: 'effect', message: `Effect must be one of: ${POLICY_EFFECTS.join(', ')}` });
  }

  // Priority
  if (typeof policy.priority !== 'number' || !Number.isInteger(policy.priority)) {
    errors.push({ field: 'priority', message: 'Priority must be an integer' });
  } else if (policy.priority < 0 || policy.priority > 1000) {
    errors.push({ field: 'priority', message: 'Priority must be between 0 and 1000' });
  }

  // Scope
  if (!policy.scope || typeof policy.scope !== 'object') {
    errors.push({ field: 'scope', message: 'Scope is required' });
  } else if (!policy.scope.agents && !policy.scope.teams && !policy.scope.org_id) {
    errors.push({ field: 'scope', message: 'Scope must define at least agents, teams, or org_id' });
  }

  // Conditions
  if (!policy.conditions || typeof policy.conditions !== 'object') {
    errors.push({ field: 'conditions', message: 'Conditions are required' });
  } else {
    errors.push(...validateConditionNode(policy.conditions));
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================
// ID Generation
// ============================================================

function generatePolicyId() {
  return `POL_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================
// CRUD
// ============================================================

function createPolicy(db, policy, ctx) {
  const validation = validatePolicy(policy);
  if (!validation.valid) {
    throw new Error(`Invalid policy: ${validation.errors.map(e => e.message).join(', ')}`);
  }

  const id = generatePolicyId();
  const now = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO policies (id, name, category, version, enabled, priority, scope, conditions, effect, reason, framework_mapping, audit_required, is_system, org_id, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      policy.name,
      policy.category,
      policy.enabled !== false ? 1 : 0,
      policy.priority,
      JSON.stringify(policy.scope),
      JSON.stringify(policy.conditions),
      policy.effect,
      policy.reason || '',
      JSON.stringify(policy.framework_mapping || []),
      policy.audit_required ? 1 : 0,
      policy.is_system ? 1 : 0,
      policy.org_id,
      policy.created_by || '',
      now,
      now,
    );
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      throw new Error(`Policy with name "${policy.name}" already exists in org ${policy.org_id}`);
    }
    throw err;
  }

  const created = getPolicy(db, id);

  // POL-HIST: emit a 'created' history row. Failures are non-fatal —
  // policy creation success is the contract; an audit-log hiccup must
  // not undo the write.
  try {
    const c = normaliseCtx(ctx);
    appendHistoryEntry(db, {
      policy_id: id,
      org_id: policy.org_id,
      operation: 'created',
      version_after: 1,
      snapshot_json: created,
      actor_id: c.actor_id,
      actor_email: c.actor_email,
      actor_label: c.actor_label,
      actor_source: c.actor_source,
      reason: c.reason,
      request_id: c.request_id,
      approval_state: 'auto',
    });
  } catch (histErr) {
    console.warn('[POL-HIST] append(created) failed (non-fatal):', histErr.message);
  }

  return created;
}

function getPolicy(db, id) {
  const row = db.prepare('SELECT * FROM policies WHERE id = ?').get(id);
  if (!row) return null;
  return deserializePolicy(row);
}

function listPolicies(db, { org_id, category, enabled, effect, limit = 100, offset = 0 } = {}) {
  const whereClauses = [];
  const params = [];

  // Include system policies + org-specific policies
  if (org_id) {
    whereClauses.push('(org_id = ? OR org_id = ?)');
    params.push(org_id, '__system__');
  }

  if (category) {
    whereClauses.push('category = ?');
    params.push(category);
  }

  if (enabled !== undefined) {
    whereClauses.push('enabled = ?');
    params.push(enabled ? 1 : 0);
  }

  if (effect) {
    whereClauses.push('effect = ?');
    params.push(effect);
  }

  const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM policies ${where}`).get(...params);
  const total = countRow.cnt;

  const rows = db.prepare(`SELECT * FROM policies ${where} ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  return {
    data: rows.map(deserializePolicy),
    total,
  };
}

function updatePolicy(db, id, updates, ctx) {
  const existing = getPolicy(db, id);
  if (!existing) {
    throw new Error(`Policy ${id} not found`);
  }

  // System policy restrictions
  if (existing.is_system) {
    const restrictedFields = ['name', 'category', 'conditions', 'effect', 'org_id', 'is_system'];
    const attemptedRestricted = Object.keys(updates).filter(k => restrictedFields.includes(k));
    if (attemptedRestricted.length > 0) {
      throw new Error(`Cannot modify ${attemptedRestricted.join(', ')} on system policies`);
    }
  }

  // Merge and validate
  const merged = { ...existing, ...updates };
  const validation = validatePolicy(merged);
  if (!validation.valid) {
    throw new Error(`Invalid policy update: ${validation.errors.map(e => e.message).join(', ')}`);
  }

  const setClauses = [];
  const params = [];

  const allowedFields = ['name', 'category', 'enabled', 'priority', 'scope', 'conditions', 'effect', 'reason', 'framework_mapping', 'audit_required'];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = ?`);
      if (['scope', 'conditions', 'framework_mapping'].includes(field)) {
        params.push(JSON.stringify(updates[field]));
      } else if (['enabled', 'audit_required'].includes(field)) {
        params.push(updates[field] ? 1 : 0);
      } else {
        params.push(updates[field]);
      }
    }
  }

  if (setClauses.length === 0) return existing;

  const c = normaliseCtx(ctx);

  // POL-HIST 4-eyes gate: the API caller sets ctx.enforce_4eyes when
  // the change needs a second approver. Staged changes never touch the
  // policies table; the approval-resolution flow calls updatePolicy
  // again with enforce_4eyes=false to apply.
  if (c.enforce_4eyes) {
    try {
      const pending = appendHistoryEntry(db, {
        policy_id: id,
        org_id: existing.org_id,
        operation: 'approval_requested',
        version_before: existing.version,
        version_after: existing.version, // not applied yet
        snapshot_json: { ...existing, ...updates }, // the proposed state
        diff_json: computeDiff(existing, { ...existing, ...updates }),
        actor_id: c.actor_id,
        actor_email: c.actor_email,
        actor_label: c.actor_label,
        actor_source: c.actor_source,
        reason: c.reason,
        request_id: c.request_id,
        approval_state: 'pending',
      });
      // Return the existing policy unchanged PLUS a _pending_approval
      // marker so API callers can surface the entry id.
      return { ...existing, _pending_approval: pending.id };
    } catch (histErr) {
      // QUOXTRUST T2 (FND_..S9DJ) — FAIL CLOSED. A 4-eyes-gated change must never be
      // applied by the first actor alone. If staging the pending-approval entry fails,
      // REFUSE the update: an audit-write failure is not a second approver, and the old
      // fall-through applied the change immediately with approval_state='auto' — a
      // dual-control bypass inducible by forcing a history-write error (oversized
      // snapshot_json, lock contention, schema drift). The change stays unstaged and
      // unapplied; the caller must retry when staging works.
      console.error('[POL-HIST] 4-eyes staging failed — REFUSING to apply without dual approval:', histErr.message);
      const e = new Error(`4-eyes staging failed; refusing to apply the policy change without dual approval: ${histErr.message}`);
      e.code = 'FOUR_EYES_STAGING_FAILED';
      throw e;
    }
  }

  setClauses.push('version = version + 1');
  setClauses.push("updated_at = datetime('now')");

  db.prepare(`UPDATE policies SET ${setClauses.join(', ')} WHERE id = ?`).run(...params, id);

  const updated = getPolicy(db, id);

  // POL-HIST: emit an 'updated' (or 'enabled' / 'disabled' if only the
  // enabled flag changed) row with the diff.
  try {
    const diff = computeDiff(existing, updated);
    const onlyToggle =
      Object.keys(diff).length === 1 && Object.keys(diff)[0] === 'enabled';
    const operation = onlyToggle
      ? (diff.enabled.after ? 'enabled' : 'disabled')
      : 'updated';
    appendHistoryEntry(db, {
      policy_id: id,
      org_id: updated.org_id,
      operation,
      version_before: existing.version,
      version_after: updated.version,
      snapshot_json: updated,
      diff_json: diff,
      actor_id: c.actor_id,
      actor_email: c.actor_email,
      actor_label: c.actor_label,
      actor_source: c.actor_source,
      reason: c.reason,
      request_id: c.request_id,
      approval_state: 'auto',
    });
  } catch (histErr) {
    console.warn('[POL-HIST] append(updated) failed (non-fatal):', histErr.message);
  }

  return updated;
}

function deletePolicy(db, id, ctx) {
  const existing = getPolicy(db, id);
  if (!existing) return { deleted: false };

  if (existing.is_system) {
    throw new Error('Cannot delete system policies');
  }

  const c = normaliseCtx(ctx);

  // POL-HIST 4-eyes gate on delete too — opt-in via ctx.enforce_4eyes.
  if (c.enforce_4eyes) {
    try {
      const pending = appendHistoryEntry(db, {
        policy_id: id,
        org_id: existing.org_id,
        operation: 'approval_requested',
        version_before: existing.version,
        version_after: existing.version,
        snapshot_json: existing,
        diff_json: { _deleted: { before: false, after: true } },
        actor_id: c.actor_id,
        actor_email: c.actor_email,
        actor_label: c.actor_label,
        actor_source: c.actor_source,
        reason: c.reason,
        request_id: c.request_id,
        approval_state: 'pending',
      });
      return { deleted: false, pending_approval: pending.id };
    } catch (histErr) {
      console.warn('[POL-HIST] 4-eyes stage (delete) failed:', histErr.message);
      // fall through
    }
  }

  const result = db.prepare('DELETE FROM policies WHERE id = ?').run(id);

  if (result.changes > 0) {
    try {
      appendHistoryEntry(db, {
        policy_id: id,
        org_id: existing.org_id,
        operation: 'deleted',
        version_before: existing.version,
        version_after: existing.version,
        snapshot_json: existing, // pre-delete state
        actor_id: c.actor_id,
        actor_email: c.actor_email,
        actor_label: c.actor_label,
        actor_source: c.actor_source,
        reason: c.reason,
        request_id: c.request_id,
        approval_state: 'auto',
      });
    } catch (histErr) {
      console.warn('[POL-HIST] append(deleted) failed (non-fatal):', histErr.message);
    }
  }

  return { deleted: result.changes > 0 };
}

// ============================================================
// Seed Policies
// ============================================================

// CHAT-SQLI-FP: this policy scans every chat turn (query.text). The original
// regex matched a bare "truncate" (and "delete from" in prose), blocking plain
// English such as "why does it truncate the description...". The pattern now
// needs SQL structure: DROP/TRUNCATE TABLE, or DELETE FROM / TRUNCATE <ident>
// followed by ";" or WHERE. Seeded DBs holding the old regex are upgraded below.
const SQLI_SEED_REGEX = '\\b(drop|truncate)\\s+table\\b|\\bdelete\\s+from\\s+[\\w.`"\\[\\]]+\\s*(;|\\bwhere\\b)|\\btruncate\\s+[\\w.`"\\[\\]]+\\s*;';
const SQLI_SEED_STALE_REGEXES = ['\\b(drop\\s+table|delete\\s+from|truncate)\\b'];

function getSeedPolicies() {
  return [
    {
      name: 'Block SQL Injection Patterns',
      category: 'safety',
      enabled: true,
      priority: 900,
      scope: { agents: ['*'], teams: ['*'] },
      conditions: {
        operator: 'OR',
        conditions: [
          { field: 'query.text', operator: 'matches', value: SQLI_SEED_REGEX },
        ]
      },
      effect: 'deny',
      reason: 'Blocked: potential SQL injection pattern detected',
      framework_mapping: ['owasp.a03.2021'],
      audit_required: true,
      is_system: true,
      org_id: '__system__',
      created_by: 'system',
    },
    {
      name: 'Block Dangerous System Commands',
      category: 'safety',
      enabled: true,
      priority: 900,
      scope: { agents: ['*'], teams: ['*'] },
      conditions: {
        operator: 'OR',
        conditions: [
          { field: 'query.text', operator: 'matches', value: '\\b(rm\\s+-rf|sudo\\s+rm|format\\s+c:)\\b' },
        ]
      },
      effect: 'deny',
      reason: 'Blocked: dangerous system command detected',
      framework_mapping: ['cis.5.4'],
      audit_required: true,
      is_system: true,
      org_id: '__system__',
      created_by: 'system',
    },
    {
      name: 'Block Credential Exposure',
      category: 'safety',
      enabled: true,
      priority: 900,
      scope: { agents: ['*'], teams: ['*'] },
      conditions: {
        operator: 'OR',
        conditions: [
          { field: 'query.text', operator: 'matches', value: '\\b(password|secret|api[_-]?key)\\s*[:=]' },
        ]
      },
      effect: 'deny',
      reason: 'Blocked: credential exposure pattern detected',
      framework_mapping: ['owasp.a07.2021', 'cis.14.4'],
      audit_required: true,
      is_system: true,
      org_id: '__system__',
      created_by: 'system',
    },
    {
      name: 'Rate Limit: Queries Per Minute',
      category: 'safety',
      enabled: true,
      priority: 800,
      scope: { agents: ['*'], teams: ['*'] },
      conditions: {
        operator: 'AND',
        conditions: [
          { field: 'rate.queries_per_minute', operator: '>', value: 30 },
        ]
      },
      effect: 'deny',
      reason: 'Rate limit exceeded: max 30 queries per minute',
      framework_mapping: [],
      audit_required: false,
      is_system: true,
      org_id: '__system__',
      created_by: 'system',
    },
    {
      name: 'Rate Limit: Queries Per Hour',
      category: 'safety',
      enabled: true,
      priority: 800,
      scope: { agents: ['*'], teams: ['*'] },
      conditions: {
        operator: 'AND',
        conditions: [
          { field: 'rate.queries_per_hour', operator: '>', value: 300 },
        ]
      },
      effect: 'deny',
      reason: 'Rate limit exceeded: max 300 queries per hour',
      framework_mapping: [],
      audit_required: false,
      is_system: true,
      org_id: '__system__',
      created_by: 'system',
    },
    {
      name: 'Warn: Elevated Privilege Commands',
      category: 'safety',
      enabled: true,
      priority: 500,
      scope: { agents: ['*'], teams: ['*'] },
      conditions: {
        operator: 'OR',
        conditions: [
          { field: 'query.text', operator: 'matches', value: '\\b(sudo|chmod\\s+777|eval\\()\\b' },
        ]
      },
      effect: 'log_only',
      reason: 'Warning: elevated privilege command detected',
      framework_mapping: ['cis.5.4'],
      audit_required: true,
      is_system: true,
      org_id: '__system__',
      created_by: 'system',
    },
    {
      name: 'Warn: Production Destructive Operations',
      category: 'safety',
      enabled: true,
      priority: 500,
      scope: { agents: ['*'], teams: ['*'] },
      conditions: {
        operator: 'AND',
        conditions: [
          { field: 'query.text', operator: 'matches', value: '\\b(production|prod)\\b.*\\b(delete|remove|drop)\\b' },
        ]
      },
      effect: 'log_only',
      reason: 'Warning: destructive operation targeting production detected',
      framework_mapping: [],
      audit_required: true,
      is_system: true,
      org_id: '__system__',
      created_by: 'system',
    },
    // GOV-6: Compliance seed policies
    {
      name: 'Block PII Transmission to LLMs',
      category: 'compliance',
      enabled: false,  // disabled by default — orgs opt in
      priority: 950,
      scope: { agents: ['*'], teams: ['*'] },
      conditions: {
        operator: 'AND',
        conditions: [
          { field: 'data.hasPII', operator: '==', value: true },
        ]
      },
      effect: 'deny',
      reason: 'PII detected in query. Transmission blocked per compliance policy.',
      framework_mapping: ['hipaa.164.312.a.1', 'gdpr.art.32.1.a', 'soc2.cc6.1'],
      audit_required: true,
      is_system: true,
      org_id: '__system__',
      created_by: 'system',
    },
    {
      name: 'Warn: PII Detected in Query',
      category: 'compliance',
      enabled: true,
      priority: 400,
      scope: { agents: ['*'], teams: ['*'] },
      conditions: {
        operator: 'AND',
        conditions: [
          { field: 'data.hasPII', operator: '==', value: true },
        ]
      },
      effect: 'log_only',
      reason: 'PII detected in query (logged for audit trail)',
      framework_mapping: ['soc2.cc6.1', 'iso27001.a.8.2.3'],
      audit_required: true,
      is_system: true,
      org_id: '__system__',
      created_by: 'system',
    },
  ];
}

function seedDefaultPolicies(db) {
  const seeds = getSeedPolicies();
  let count = 0;

  for (const seed of seeds) {
    const existing = db.prepare('SELECT id FROM policies WHERE name = ? AND org_id = ?').get(seed.name, seed.org_id);
    if (!existing) {
      createPolicy(db, seed);
      count++;
    } else if (seed.name === 'Block SQL Injection Patterns') {
      // Upgrade only an untouched stale seed row; leave any other value alone.
      const row = db.prepare('SELECT conditions FROM policies WHERE id = ?').get(existing.id);
      let leaves = [];
      try { leaves = JSON.parse(row.conditions).conditions || []; } catch { leaves = []; }
      if (leaves.length === 1 && SQLI_SEED_STALE_REGEXES.includes(leaves[0].value)) {
        db.prepare("UPDATE policies SET conditions = ?, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(seed.conditions), existing.id);
      }
    }
  }

  return count;
}

// ============================================================
// Helpers
// ============================================================

function deserializePolicy(row) {
  return {
    ...row,
    enabled: row.enabled === 1,
    audit_required: row.audit_required === 1,
    is_system: row.is_system === 1,
    scope: JSON.parse(row.scope),
    conditions: JSON.parse(row.conditions),
    framework_mapping: JSON.parse(row.framework_mapping),
  };
}

module.exports = {
  POLICY_CATEGORIES,
  POLICY_EFFECTS,
  initPolicyStore,
  validatePolicy,
  createPolicy,
  getPolicy,
  listPolicies,
  updatePolicy,
  deletePolicy,
  getSeedPolicies,
  seedDefaultPolicies,
};
