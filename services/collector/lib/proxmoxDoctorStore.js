'use strict';

/**
 * VM Doctor: durable, org-scoped report store (DEVFLEET-DOCTOR).
 *
 * One table, proxmox_doctor_reports, on the collector's aee.db handle. EVERY query filters by
 * org_id and org_id always comes from the trusted caller, never from tool input, so org B can
 * never read org A's report. Same ensure(db) pattern as proxmoxRehearseStore / proxmoxPoolStore.
 */

const crypto = require('crypto');

let _db = null;

function ensure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxmox_doctor_reports (
      org_id        TEXT NOT NULL,
      report_id     TEXT NOT NULL,
      vmid          INTEGER NOT NULL,
      node          TEXT,
      verdict       TEXT NOT NULL,
      findings_json TEXT NOT NULL,
      gaps_json     TEXT NOT NULL,
      report_json   TEXT,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (org_id, report_id)
    );
    CREATE INDEX IF NOT EXISTS idx_proxmox_doctor_reports_vm ON proxmox_doctor_reports(org_id, vmid, created_at);
  `);
  _db = db;
}

function requireDb() {
  if (!_db) throw new Error('proxmoxDoctorStore.ensure(db) must be called before use');
  return _db;
}

function needOrg(orgId) {
  if (!orgId || typeof orgId !== 'string') throw new Error('org_id is required');
}

const unjson = (t) => { try { return t === null || t === undefined ? null : JSON.parse(t); } catch { return null; } };

function newId() { return `DR_${crypto.randomBytes(8).toString('hex').toUpperCase()}`; }

/** Save a full report for an org. The report object is stored whole so a read returns exactly what the caller saw. */
function save(orgId, report) {
  needOrg(orgId);
  const vm = report.vm || {};
  requireDb().prepare(`INSERT INTO proxmox_doctor_reports (org_id, report_id, vmid, node, verdict, findings_json, gaps_json, report_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(orgId, report.report_id, Number(vm.vmid), vm.node || null, report.verdict, JSON.stringify(report.findings || []), JSON.stringify(report.gaps || []), JSON.stringify(report), Date.parse(report.generated_at) || Date.now());
  return report.report_id;
}

function rowToReport(r) {
  if (!r) return null;
  const whole = unjson(r.report_json);
  if (whole) return whole;
  return { report_id: r.report_id, vm: { vmid: r.vmid, node: r.node }, verdict: r.verdict, findings: unjson(r.findings_json) || [], gaps: unjson(r.gaps_json) || [], generated_at: new Date(r.created_at).toISOString() };
}

function get(orgId, reportId) {
  needOrg(orgId);
  return rowToReport(requireDb().prepare('SELECT * FROM proxmox_doctor_reports WHERE org_id = ? AND report_id = ?').get(orgId, String(reportId)));
}

function list(orgId, { vmid, limit = 20 } = {}) {
  needOrg(orgId);
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const rows = vmid !== undefined && vmid !== null
    ? requireDb().prepare('SELECT * FROM proxmox_doctor_reports WHERE org_id = ? AND vmid = ? ORDER BY created_at DESC LIMIT ?').all(orgId, Number(vmid), lim)
    : requireDb().prepare('SELECT * FROM proxmox_doctor_reports WHERE org_id = ? ORDER BY created_at DESC LIMIT ?').all(orgId, lim);
  return rows.map(rowToReport);
}

module.exports = { ensure, save, get, list, newId };
