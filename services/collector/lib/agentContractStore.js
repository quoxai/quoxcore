/**
 * RSP-CONTRACT Phase 1a: Responsibility Contract store.
 *
 * Foundation only — schema + CRUD + resolution/merge. Does NOT wire the
 * AOCL observe-mode enforcement hook (Phase 1b) or the /contracts UI
 * (Phase 1c). See docs/STREAM_RSP_LIN_ENG_REVIEW.md §4 for the full wedge
 * scope and docs/STREAM_RSP_ENG_PLAN.md §4.4 for the original clause shape.
 *
 * Mirrors the MON-GOV-3 governanceWebhookConfig.js pattern one seam over:
 * org-scoped rows in voltDb, an init*(db) idempotent schema function
 * (real schema lives in migrations/volt/002-agent-contracts.sql — this is
 * the same "redundant safety net" pattern as initGovernanceWebhookConfig),
 * simple CRUD, and validation that throws on bad input.
 *
 * Contract rows are versioned and immutable once written: updateContract()
 * never mutates a row — it inserts the next version and flips `active`.
 * Two row shapes share the table:
 *   - org-default row:  agent_id === null
 *   - per-agent row:    agent_id === '<id>'
 *
 * resolveContract(db, orgId, agentId) merges the org-default's active
 * version with the per-agent active version, per clause type — a
 * per-agent row that defines a clause type replaces the org-default's
 * array for that type; a clause type it does NOT define inherits from
 * the org-default. Every resolved clause type carries a `source` tag
 * ('agent' | 'org_default' | 'none') for auditor provenance.
 */

'use strict';

// v1 clause shape. Each is an array of { id, description, ...extra }.
// Any top-level key outside this list is rejected by validateContractBody
// (the "unknown clause" test case called for in the review doc §8).
const CLAUSE_TYPES = ['responsibilities', 'allowed_actions', 'forbidden_actions', 'obligations'];

function initAgentContracts(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_contracts (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      agent_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      contract_json TEXT NOT NULL DEFAULT '{}',
      provenance TEXT NOT NULL DEFAULT 'admin',
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_org_default_version
      ON agent_contracts(org_id, version) WHERE agent_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_agent_version
      ON agent_contracts(org_id, agent_id, version) WHERE agent_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_contracts_org ON agent_contracts(org_id);
    CREATE INDEX IF NOT EXISTS idx_contracts_org_agent_active
      ON agent_contracts(org_id, agent_id, active);
  `);
}

function generateContractId() {
  return `CTR_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Validates a contract body against the v1 clause shape. Throws on
 * anything invalid. `partial` allows an empty/undefined body (used for
 * the org-default row bootstrap) but still rejects unknown keys or
 * malformed clause items when the body IS present.
 */
function validateContractBody(body) {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('contract body must be an object');
  }

  const unknown = Object.keys(body).filter((k) => !CLAUSE_TYPES.includes(k));
  if (unknown.length > 0) {
    throw new Error(`contract body has unknown clause type(s): ${unknown.join(', ')}`);
  }

  for (const clauseType of CLAUSE_TYPES) {
    if (body[clauseType] === undefined) continue;
    if (!Array.isArray(body[clauseType])) {
      throw new Error(`clause "${clauseType}" must be an array`);
    }
    for (const item of body[clauseType]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`clause "${clauseType}" items must be objects`);
      }
      if (!item.id || typeof item.id !== 'string') {
        throw new Error(`clause "${clauseType}" item missing string "id"`);
      }
      if (!item.description || typeof item.description !== 'string') {
        throw new Error(`clause "${clauseType}" item "${item.id}" missing string "description"`);
      }
    }
  }

  return body;
}

function deserialize(row) {
  if (!row) return null;
  let contract;
  try {
    contract = JSON.parse(row.contract_json);
  } catch {
    contract = {};
  }
  return {
    id: row.id,
    org_id: row.org_id,
    agent_id: row.agent_id, // null = org-default
    version: row.version,
    contract,
    provenance: row.provenance,
    active: row.active === 1,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeAgentId(agentId) {
  return agentId === undefined ? null : agentId;
}

/**
 * Creates the FIRST version of a contract for (org_id, agent_id).
 * Throws if an active contract already exists for that scope — callers
 * should use updateContract() to version an existing scope.
 */
function createContract(db, input) {
  if (!input || typeof input !== 'object') throw new Error('input must be an object');
  if (!input.org_id) throw new Error('org_id is required');

  const agentId = normalizeAgentId(input.agent_id);
  const body = validateContractBody(input.contract);

  const existing = getActiveContract(db, input.org_id, agentId);
  if (existing) {
    throw new Error(
      `an active contract already exists for org_id=${input.org_id} agent_id=${agentId ?? 'null (org-default)'} — use updateContract() to create a new version`
    );
  }

  const id = generateContractId();
  const ts = nowIso();
  const row = {
    id,
    org_id: input.org_id,
    agent_id: agentId,
    version: 1,
    contract_json: JSON.stringify(body),
    provenance: input.provenance || 'admin',
    active: 1,
    created_by: input.created_by || null,
    created_at: ts,
    updated_at: ts,
  };

  db.prepare(`
    INSERT INTO agent_contracts (
      id, org_id, agent_id, version, contract_json, provenance, active,
      created_by, created_at, updated_at
    ) VALUES (
      @id, @org_id, @agent_id, @version, @contract_json, @provenance, @active,
      @created_by, @created_at, @updated_at
    )
  `).run(row);

  return getContractById(db, id);
}

function getContractById(db, id) {
  const row = db.prepare('SELECT * FROM agent_contracts WHERE id = ?').get(id);
  return deserialize(row);
}

/**
 * Returns the currently active contract row for a scope, or null.
 * `agentId === null` looks up the org-default row.
 */
function getActiveContract(db, orgId, agentId) {
  agentId = normalizeAgentId(agentId);
  const row = agentId === null
    ? db.prepare('SELECT * FROM agent_contracts WHERE org_id = ? AND agent_id IS NULL AND active = 1').get(orgId)
    : db.prepare('SELECT * FROM agent_contracts WHERE org_id = ? AND agent_id = ? AND active = 1').get(orgId, agentId);
  return deserialize(row);
}

/**
 * Full version history for a scope, newest first.
 */
function listContractVersions(db, orgId, agentId) {
  agentId = normalizeAgentId(agentId);
  const rows = agentId === null
    ? db.prepare('SELECT * FROM agent_contracts WHERE org_id = ? AND agent_id IS NULL ORDER BY version DESC').all(orgId)
    : db.prepare('SELECT * FROM agent_contracts WHERE org_id = ? AND agent_id = ? ORDER BY version DESC').all(orgId, agentId);
  return rows.map(deserialize);
}

/**
 * Lists the active contract for every agent scope in an org (excludes
 * the org-default row unless includeOrgDefault is true).
 */
function listActiveContracts(db, orgId, { includeOrgDefault = true } = {}) {
  const where = includeOrgDefault
    ? 'WHERE org_id = ? AND active = 1'
    : 'WHERE org_id = ? AND active = 1 AND agent_id IS NOT NULL';
  const rows = db.prepare(`SELECT * FROM agent_contracts ${where} ORDER BY agent_id IS NULL DESC, agent_id ASC`).all(orgId);
  return rows.map(deserialize);
}

/**
 * Creates a NEW version for an existing (org_id, agent_id) scope and
 * deactivates the previous active version. Previous rows are never
 * mutated — immutable version history for future replay (LIN-REPLAY).
 * If no contract exists yet for the scope, this behaves like
 * createContract() (version 1).
 */
function updateContract(db, orgId, agentId, patch) {
  agentId = normalizeAgentId(agentId);
  if (!orgId) throw new Error('org_id is required');

  const current = getActiveContract(db, orgId, agentId);
  const body = validateContractBody(patch?.contract !== undefined ? patch.contract : current?.contract);

  const txn = db.transaction(() => {
    if (current) {
      db.prepare('UPDATE agent_contracts SET active = 0, updated_at = ? WHERE id = ?')
        .run(nowIso(), current.id);
    }

    const id = generateContractId();
    const ts = nowIso();
    const nextVersion = current ? current.version + 1 : 1;
    const row = {
      id,
      org_id: orgId,
      agent_id: agentId,
      version: nextVersion,
      contract_json: JSON.stringify(body),
      provenance: patch?.provenance || current?.provenance || 'admin',
      active: 1,
      created_by: patch?.created_by || null,
      created_at: ts,
      updated_at: ts,
    };

    db.prepare(`
      INSERT INTO agent_contracts (
        id, org_id, agent_id, version, contract_json, provenance, active,
        created_by, created_at, updated_at
      ) VALUES (
        @id, @org_id, @agent_id, @version, @contract_json, @provenance, @active,
        @created_by, @created_at, @updated_at
      )
    `).run(row);

    return id;
  });

  const newId = txn();
  return getContractById(db, newId);
}

/**
 * Deletes ALL versions of a contract scope (org-default or per-agent).
 * Used for cleanup/tests and the DELETE route. Returns true if any rows
 * were removed.
 */
function deleteContract(db, orgId, agentId) {
  agentId = normalizeAgentId(agentId);
  const result = agentId === null
    ? db.prepare('DELETE FROM agent_contracts WHERE org_id = ? AND agent_id IS NULL').run(orgId)
    : db.prepare('DELETE FROM agent_contracts WHERE org_id = ? AND agent_id = ?').run(orgId, agentId);
  return result.changes > 0;
}

/**
 * Resolves the EFFECTIVE contract for an agent: org-default merged with
 * the per-agent override, per clause type. A per-agent row that defines
 * a clause type replaces the org-default's array for that type; a clause
 * type it does not define inherits the org-default's array untouched.
 * Every clause carries `source` for auditor provenance.
 */
function resolveContract(db, orgId, agentId) {
  if (!orgId) throw new Error('org_id is required');
  if (!agentId) throw new Error('agent_id is required to resolve an effective contract');

  const orgDefault = getActiveContract(db, orgId, null);
  const agentContract = getActiveContract(db, orgId, agentId);

  const clauses = {};
  for (const clauseType of CLAUSE_TYPES) {
    const agentHasClause = agentContract && Array.isArray(agentContract.contract?.[clauseType]);
    const orgHasClause = orgDefault && Array.isArray(orgDefault.contract?.[clauseType]);

    if (agentHasClause) {
      clauses[clauseType] = { items: agentContract.contract[clauseType], source: 'agent' };
    } else if (orgHasClause) {
      clauses[clauseType] = { items: orgDefault.contract[clauseType], source: 'org_default' };
    } else {
      clauses[clauseType] = { items: [], source: 'none' };
    }
  }

  return {
    org_id: orgId,
    agent_id: agentId,
    clauses,
    org_default_version: orgDefault?.version ?? null,
    agent_version: agentContract?.version ?? null,
    resolved_at: nowIso(),
  };
}

/**
 * Auditor diff: per clause type, per item id — which items an agent's
 * OWN contract defines, and which items come from (or are shadowed
 * relative to) the org-default. Distinct from resolveContract's merge
 * output — this is the "what did this agent change from the baseline"
 * view the auditor surface needs.
 */
function diffAgainstOrgDefault(db, orgId, agentId) {
  if (!orgId) throw new Error('org_id is required');
  if (!agentId) throw new Error('agent_id is required');

  const orgDefault = getActiveContract(db, orgId, null);
  const agentContract = getActiveContract(db, orgId, agentId);

  const diff = {};
  for (const clauseType of CLAUSE_TYPES) {
    const orgItems = orgDefault?.contract?.[clauseType] || [];
    const agentItems = agentContract?.contract?.[clauseType] || [];

    const orgIds = new Set(orgItems.map((i) => i.id));
    const agentIds = new Set(agentItems.map((i) => i.id));

    const inherited = orgItems.filter((i) => !agentContract || !Array.isArray(agentContract.contract?.[clauseType]));
    const added = agentItems.filter((i) => !orgIds.has(i.id));
    const overridden = agentItems.filter((i) => orgIds.has(i.id));
    const removed = agentContract && Array.isArray(agentContract.contract?.[clauseType])
      ? orgItems.filter((i) => !agentIds.has(i.id))
      : [];

    diff[clauseType] = {
      has_agent_override: !!(agentContract && Array.isArray(agentContract.contract?.[clauseType])),
      inherited,
      added,
      overridden,
      removed,
    };
  }

  return {
    org_id: orgId,
    agent_id: agentId,
    org_default_version: orgDefault?.version ?? null,
    agent_version: agentContract?.version ?? null,
    diff,
  };
}

module.exports = {
  CLAUSE_TYPES,
  initAgentContracts,
  validateContractBody,
  createContract,
  getContractById,
  getActiveContract,
  listContractVersions,
  listActiveContracts,
  updateContract,
  deleteContract,
  resolveContract,
  diffAgainstOrgDefault,
};
