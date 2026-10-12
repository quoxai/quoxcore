/**
 * RSP-CONTRACT Phase 1a — Responsibility Contract REST API.
 *
 * Mounted at /orgs/:orgId/agent-contracts (mergeParams router — orgId
 * comes from the parent mount path in server.js, mirroring the
 * MON-GOV-3 governance-webhooks org-scoping pattern).
 *
 * Auth: server.js mounts this router behind requireServiceOrUserAuth().
 * Reads are allowed for any authenticated member of the org (auditors
 * need to read contracts without being admins); writes (PUT/DELETE)
 * require admin role for user callers, same as governance-webhooks.
 * Internal services (INTERNAL_SERVICE_KEY) bypass both checks.
 *
 * Routes:
 *   GET    /                          — list active contracts (org-default + all agents)
 *   GET    /default                   — active org-default contract
 *   GET    /default/versions          — org-default version history
 *   PUT    /default                   — create/version the org-default contract
 *   DELETE /default                   — delete ALL org-default contract versions
 *   GET    /:agentId                  — active per-agent contract (or null)
 *   GET    /:agentId/versions         — per-agent version history
 *   PUT    /:agentId                  — create/version a per-agent contract
 *   DELETE /:agentId                  — delete ALL per-agent contract versions
 *   GET    /:agentId/resolve          — effective contract (org-default merged with agent override)
 *   GET    /:agentId/diff             — auditor diff: agent contract vs org-default
 *
 * Phase-1b seam (NOT wired here): the AOCL per-node evaluator in
 * quoxflow (control-pipeline.ts) should call resolveContract(voltDb, orgId,
 * agentId) from ../lib/agentContractStore.js and attach the result (or a
 * `contract_clause` summary of it) to the aocl.policy.evaluated envelope —
 * see the module doc in agentContractStore.js for the exact merge shape.
 */

'use strict';

const { Router } = require('express');
const store = require('../lib/agentContractStore.js');
// SEC (2026-08-11): shared admin-role gate, reads req.user.dashboardRole
// (the only role field requireAuth()/requireServiceOrUserAuth() actually
// populate). See utils/httpAuth.js for the full rationale.
const { isAdminUser } = require('../utils/httpAuth.js');

const router = Router({ mergeParams: true });

// Injected by server.js via init() once voltDb is available.
let deps = { voltDb: null };

function init(injected) {
  deps = { ...deps, ...injected };
}

function getDb() {
  return deps.voltDb;
}

function requireContractAdmin(req, res) {
  if (isAdminUser(req)) return true;
  if (!req.user) {
    res.status(401).json({ error: 'authentication_required' });
    return false;
  }
  res.status(403).json({ error: 'admin role required for contract administration' });
  return false;
}

function requireContractReader(req, res) {
  if (req.service) return true;
  if (!req.user) {
    res.status(401).json({ error: 'authentication_required' });
    return false;
  }
  return true;
}

/**
 * Routes are nested under :orgId. For user callers the path orgId must
 * match req.user.org_id; internal services may operate on any org.
 * Mirrors resolveWebhookOrgId() in server.js's governance-webhooks block.
 */
function resolveOrgId(req) {
  const pathOrg = req.params.orgId;
  if (req.user && req.user.org_id && pathOrg !== req.user.org_id) return null;
  return pathOrg;
}

function dbUnavailable(res) {
  return res.status(503).json({ error: 'Contract storage not available' });
}

function orgScopeMismatch(res) {
  return res.status(403).json({ error: 'org scope mismatch' });
}

// ─── Reads ────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const db = getDb();
  if (!db) return dbUnavailable(res);
  if (!requireContractReader(req, res)) return;
  const orgId = resolveOrgId(req);
  if (!orgId) return orgScopeMismatch(res);

  try {
    const contracts = store.listActiveContracts(db, orgId);
    res.json({ data: contracts });
  } catch (err) {
    console.error('[RSP-CONTRACT] list error:', err);
    res.status(500).json({ error: 'Failed to list contracts' });
  }
});

router.get('/default', (req, res) => {
  const db = getDb();
  if (!db) return dbUnavailable(res);
  if (!requireContractReader(req, res)) return;
  const orgId = resolveOrgId(req);
  if (!orgId) return orgScopeMismatch(res);

  try {
    const contract = store.getActiveContract(db, orgId, null);
    res.json({ contract });
  } catch (err) {
    console.error('[RSP-CONTRACT] get org-default error:', err);
    res.status(500).json({ error: 'Failed to get org-default contract' });
  }
});

router.get('/default/versions', (req, res) => {
  const db = getDb();
  if (!db) return dbUnavailable(res);
  if (!requireContractReader(req, res)) return;
  const orgId = resolveOrgId(req);
  if (!orgId) return orgScopeMismatch(res);

  try {
    const versions = store.listContractVersions(db, orgId, null);
    res.json({ data: versions });
  } catch (err) {
    console.error('[RSP-CONTRACT] org-default versions error:', err);
    res.status(500).json({ error: 'Failed to list org-default versions' });
  }
});

router.put('/default', (req, res) => {
  const db = getDb();
  if (!db) return dbUnavailable(res);
  if (!requireContractAdmin(req, res)) return;
  const orgId = resolveOrgId(req);
  if (!orgId) return orgScopeMismatch(res);

  try {
    const updated = store.updateContract(db, orgId, null, {
      contract: req.body?.contract,
      provenance: req.body?.provenance,
      created_by: req.user?.id || req.serviceAgent || null,
    });
    res.json({ contract: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/default', (req, res) => {
  const db = getDb();
  if (!db) return dbUnavailable(res);
  if (!requireContractAdmin(req, res)) return;
  const orgId = resolveOrgId(req);
  if (!orgId) return orgScopeMismatch(res);

  try {
    const deleted = store.deleteContract(db, orgId, null);
    res.json({ ok: deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Per-agent ────────────────────────────────────────────────────────────

router.get('/:agentId/resolve', (req, res) => {
  const db = getDb();
  if (!db) return dbUnavailable(res);
  if (!requireContractReader(req, res)) return;
  const orgId = resolveOrgId(req);
  if (!orgId) return orgScopeMismatch(res);

  try {
    const resolved = store.resolveContract(db, orgId, req.params.agentId);
    res.json({ data: resolved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:agentId/diff', (req, res) => {
  const db = getDb();
  if (!db) return dbUnavailable(res);
  if (!requireContractReader(req, res)) return;
  const orgId = resolveOrgId(req);
  if (!orgId) return orgScopeMismatch(res);

  try {
    const diff = store.diffAgainstOrgDefault(db, orgId, req.params.agentId);
    res.json({ data: diff });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:agentId/versions', (req, res) => {
  const db = getDb();
  if (!db) return dbUnavailable(res);
  if (!requireContractReader(req, res)) return;
  const orgId = resolveOrgId(req);
  if (!orgId) return orgScopeMismatch(res);

  try {
    const versions = store.listContractVersions(db, orgId, req.params.agentId);
    res.json({ data: versions });
  } catch (err) {
    console.error('[RSP-CONTRACT] agent versions error:', err);
    res.status(500).json({ error: 'Failed to list agent contract versions' });
  }
});

router.get('/:agentId', (req, res) => {
  const db = getDb();
  if (!db) return dbUnavailable(res);
  if (!requireContractReader(req, res)) return;
  const orgId = resolveOrgId(req);
  if (!orgId) return orgScopeMismatch(res);

  try {
    const contract = store.getActiveContract(db, orgId, req.params.agentId);
    res.json({ contract });
  } catch (err) {
    console.error('[RSP-CONTRACT] get agent contract error:', err);
    res.status(500).json({ error: 'Failed to get agent contract' });
  }
});

router.put('/:agentId', (req, res) => {
  const db = getDb();
  if (!db) return dbUnavailable(res);
  if (!requireContractAdmin(req, res)) return;
  const orgId = resolveOrgId(req);
  if (!orgId) return orgScopeMismatch(res);

  try {
    const updated = store.updateContract(db, orgId, req.params.agentId, {
      contract: req.body?.contract,
      provenance: req.body?.provenance,
      created_by: req.user?.id || req.serviceAgent || null,
    });
    res.json({ contract: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:agentId', (req, res) => {
  const db = getDb();
  if (!db) return dbUnavailable(res);
  if (!requireContractAdmin(req, res)) return;
  const orgId = resolveOrgId(req);
  if (!orgId) return orgScopeMismatch(res);

  try {
    const deleted = store.deleteContract(db, orgId, req.params.agentId);
    res.json({ ok: deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, init };
