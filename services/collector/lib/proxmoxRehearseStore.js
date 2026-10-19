'use strict';

/**
 * Rehearsal twins: durable record store (DEVFLEET-P15).
 *
 * One table, proxmox_rehearsals, on the collector's aee.db handle. EVERY query filters by
 * org_id and org_id always comes from the trusted caller, never from tool input, so org B
 * can never read org A's rehearsal. An approval card references a record by its id.
 */

const crypto = require('crypto');

let _db = null;

function ensure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxmox_rehearsals (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL,
      vmid          INTEGER NOT NULL,
      node          TEXT NOT NULL,
      twin_vmid     INTEGER,
      snapshot      TEXT,
      command       TEXT,
      verdict       TEXT NOT NULL,
      exit_code     INTEGER,
      duration_s    INTEGER,
      new_failed_units INTEGER,
      failed_units_before_json TEXT,
      failed_units_after_json  TEXT,
      checks_before_json TEXT,
      checks_after_json  TEXT,
      flipped_json  TEXT,
      output_tail   TEXT,
      error         TEXT,
      keep_twin     INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_proxmox_rehearsals_org ON proxmox_rehearsals(org_id, created_at);
  `);
  // The full deterministic plan the approver saw (params + every host command), its hash, and the
  // ephemeral grant minted for it.
  const have = new Set(db.prepare('PRAGMA table_info(proxmox_rehearsals)').all().map((c) => c.name));
  for (const [col, ddl] of [['plan_json', 'TEXT'], ['plan_sha256', 'TEXT'], ['grant_id', 'TEXT'], ['approval_id', 'TEXT']]) {
    if (!have.has(col)) db.exec(`ALTER TABLE proxmox_rehearsals ADD COLUMN ${col} ${ddl}`);
  }
  _db = db;
}

function requireDb() {
  if (!_db) throw new Error('proxmoxRehearseStore.ensure(db) must be called before use');
  return _db;
}

function needOrg(orgId) {
  if (!orgId || typeof orgId !== 'string') throw new Error('org_id is required');
}

const json = (v) => JSON.stringify(v === undefined ? null : v);
const unjson = (t) => { try { return t === null || t === undefined ? null : JSON.parse(t); } catch { return null; } };

function rowToRecord(r) {
  if (!r) return null;
  return {
    id: r.id, state: r.verdict === 'running' ? 'running' : r.verdict === 'awaiting_approval' ? 'awaiting_approval' : 'done', vmid: r.vmid, node: r.node, twin_vmid: r.twin_vmid, snapshot: r.snapshot, command: r.command,
    verdict: r.verdict, exit_code: r.exit_code, duration_s: r.duration_s, new_failed_units: r.new_failed_units,
    failed_units_before: unjson(r.failed_units_before_json), failed_units_after: unjson(r.failed_units_after_json),
    checks_before: unjson(r.checks_before_json), checks_after: unjson(r.checks_after_json), flipped: unjson(r.flipped_json),
    output_tail: r.output_tail, error: r.error, keep_twin: !!r.keep_twin, plan_sha256: r.plan_sha256 || null, grant_id: r.grant_id || null, approval_id: r.approval_id || null,
    created_at: new Date(r.created_at).toISOString(), updated_at: new Date(r.updated_at).toISOString(),
  };
}

function newId() { return `RH_${crypto.randomBytes(8).toString('hex').toUpperCase()}`; }

/**
 * Start a record in verdict 'running' so an orphaned twin is traceable if the collector dies mid-run.
 * twin_vmid and snapshot are set (patch) only once each actually exists, so boot recovery never
 * touches a VMID or snapshot this rehearsal did not create.
 */
function begin(orgId, { vmid, node, twin_vmid, snapshot, command, keep_twin, plan, verdict = 'running' }) {
  needOrg(orgId);
  const id = newId(); const t = Date.now();
  requireDb().prepare(`INSERT INTO proxmox_rehearsals (id, org_id, vmid, node, twin_vmid, snapshot, command, verdict, keep_twin, created_at, updated_at, plan_json, plan_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, orgId, vmid, node, twin_vmid ?? null, snapshot ?? null, String(command || '').slice(0, 2000), verdict, keep_twin ? 1 : 0, t, t,
    plan ? JSON.stringify(plan) : null, plan && plan.sha256 ? plan.sha256 : null);
  return id;
}

function patch(orgId, id, { twin_vmid, snapshot, grant_id, approval_id }) {
  needOrg(orgId);
  const db = requireDb();
  if (grant_id !== undefined) db.prepare('UPDATE proxmox_rehearsals SET grant_id = ?, updated_at = ? WHERE org_id = ? AND id = ?').run(grant_id, Date.now(), orgId, id);
  if (approval_id !== undefined) db.prepare('UPDATE proxmox_rehearsals SET approval_id = ?, updated_at = ? WHERE org_id = ? AND id = ?').run(approval_id, Date.now(), orgId, id);
  if (twin_vmid !== undefined) db.prepare('UPDATE proxmox_rehearsals SET twin_vmid = ?, updated_at = ? WHERE org_id = ? AND id = ?').run(twin_vmid, Date.now(), orgId, id);
  if (snapshot !== undefined) db.prepare('UPDATE proxmox_rehearsals SET snapshot = ?, updated_at = ? WHERE org_id = ? AND id = ?').run(snapshot, Date.now(), orgId, id);
}

/** Boot recovery only (system level, all orgs): 'running' rows not touched for olderThanMs. Callers act per row's own org. */
function staleRunning(olderThanMs, nowMs = Date.now(), verdict = 'running') {
  return requireDb().prepare('SELECT * FROM proxmox_rehearsals WHERE verdict = ? AND updated_at <= ?').all(verdict, nowMs - olderThanMs)
    .map((r) => ({ org_id: r.org_id, ...rowToRecord(r) }));
}

function finish(orgId, id, r) {
  needOrg(orgId);
  requireDb().prepare(`UPDATE proxmox_rehearsals SET verdict = ?, exit_code = ?, duration_s = ?, new_failed_units = ?,
    failed_units_before_json = ?, failed_units_after_json = ?, checks_before_json = ?, checks_after_json = ?, flipped_json = ?,
    output_tail = ?, error = ?, updated_at = ? WHERE org_id = ? AND id = ?`)
    .run(r.verdict, r.exit_code ?? null, r.duration_s ?? null, r.new_failed_units ?? null, json(r.failed_units_before), json(r.failed_units_after),
      json(r.checks_before), json(r.checks_after), json(r.flipped), r.output_tail ?? null, r.error ? String(r.error).slice(0, 500) : null, Date.now(), orgId, id);
  return get(orgId, id);
}

/** The stored plan (params + commands + sha) for an org's rehearsal, or null. */
function getPlan(orgId, id) {
  needOrg(orgId);
  const r = requireDb().prepare('SELECT plan_json, plan_sha256, verdict, approval_id, grant_id FROM proxmox_rehearsals WHERE org_id = ? AND id = ?').get(orgId, String(id));
  if (!r || !r.plan_json) return null;
  try { return { plan: JSON.parse(r.plan_json), plan_sha256: r.plan_sha256, verdict: r.verdict, approval_id: r.approval_id, grant_id: r.grant_id }; } catch { return null; }
}

/**
 * Move awaiting_approval -> running atomically (so one approval starts one run). -> true when this call won.
 */
function claimToRun(orgId, id, approvalId) {
  needOrg(orgId);
  return requireDb().prepare("UPDATE proxmox_rehearsals SET verdict = 'running', approval_id = ?, updated_at = ? WHERE org_id = ? AND id = ? AND verdict = 'awaiting_approval'")
    .run(approvalId || null, Date.now(), orgId, id).changes === 1;
}

function get(orgId, id) {
  needOrg(orgId);
  return rowToRecord(requireDb().prepare('SELECT * FROM proxmox_rehearsals WHERE org_id = ? AND id = ?').get(orgId, String(id)));
}

function list(orgId, limit = 20) {
  needOrg(orgId);
  return requireDb().prepare('SELECT * FROM proxmox_rehearsals WHERE org_id = ? ORDER BY created_at DESC LIMIT ?').all(orgId, Math.min(Math.max(Number(limit) || 20, 1), 100)).map(rowToRecord);
}

/** Twin VMIDs of rehearsals still marked running (so a new rehearsal never reuses one). */
function runningTwinVmids(orgId) {
  needOrg(orgId);
  const fresh = Date.now() - 2 * 3600000;
  const rows = requireDb().prepare("SELECT twin_vmid, plan_json, verdict, updated_at FROM proxmox_rehearsals WHERE org_id = ? AND verdict IN ('running','awaiting_approval')").all(orgId);
  const out = [];
  for (const r of rows) {
    if (r.twin_vmid) out.push(r.twin_vmid);
    if (r.verdict === 'awaiting_approval' && r.updated_at > fresh && r.plan_json) { try { out.push(JSON.parse(r.plan_json).params.twin); } catch { /* skip */ } }
  }
  return out;
}

/** One-line card summary: 'Rehearsed on twin: PASS, 0 new failed units, 41s'. */
function summaryLine(rec) {
  if (!rec) return null;
  const v = String(rec.verdict || 'unknown').toUpperCase();
  const nf = rec.new_failed_units === null || rec.new_failed_units === undefined ? '?' : rec.new_failed_units;
  const flips = Array.isArray(rec.flipped) && rec.flipped.length ? `, ${rec.flipped.length} check${rec.flipped.length === 1 ? '' : 's'} flipped` : '';
  return `Rehearsed on twin: ${v}, ${nf} new failed unit${nf === 1 ? '' : 's'}${flips}, ${rec.duration_s ?? '?'}s`;
}

module.exports = { ensure, begin, patch, getPlan, claimToRun, staleRunning, finish, get, list, runningTwinVmids, summaryLine };
