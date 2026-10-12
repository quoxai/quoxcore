/**
 * Codebase Storage Layer — SQLite persistence for scan results.
 */

const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const { join } = require('path');
const { existsSync, mkdirSync } = require('fs');

let db = null;

function initCodebaseDb(dbPath) {
  if (db) return db;
  const resolvedPath = dbPath || join(process.cwd(), 'data', 'codebase.db');
  const dir = resolvedPath.replace(/\/[^/]+$/, '');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS codebase_scans (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'default',
      project_path TEXT NOT NULL,
      project_name TEXT NOT NULL,
      project_type TEXT NOT NULL,
      scan_data JSON NOT NULL,
      metrics JSON NOT NULL,
      invariant_status TEXT DEFAULT 'pass',
      scanned_at TEXT NOT NULL,
      previous_scan_id TEXT
    );
    CREATE TABLE IF NOT EXISTS codebase_changes (
      id TEXT PRIMARY KEY,
      scan_id TEXT NOT NULL REFERENCES codebase_scans(id),
      change_type TEXT NOT NULL,
      element_type TEXT NOT NULL,
      element_name TEXT NOT NULL,
      details JSON,
      detected_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scans_org_path ON codebase_scans(org_id, project_path);
    CREATE INDEX IF NOT EXISTS idx_scans_project_name ON codebase_scans(project_name);
    CREATE INDEX IF NOT EXISTS idx_changes_scan ON codebase_changes(scan_id);
  `);
  return db;
}

function getCodebaseDb() {
  if (!db) throw new Error('Codebase DB not initialized');
  return db;
}

function storeScan(scanResult, orgId = 'default') {
  const d = getCodebaseDb();
  const scanId = randomUUID();
  const prev = d.prepare('SELECT id FROM codebase_scans WHERE org_id = ? AND project_path = ? ORDER BY scanned_at DESC LIMIT 1').get(orgId, scanResult.rootPath);
  const invariantStatus = getOverallStatus(scanResult.invariantChecks);

  d.prepare('INSERT INTO codebase_scans (id, org_id, project_path, project_name, project_type, scan_data, metrics, invariant_status, scanned_at, previous_scan_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(scanId, orgId, scanResult.rootPath, scanResult.projectName, scanResult.projectType, JSON.stringify(scanResult), JSON.stringify(scanResult.metrics), invariantStatus, scanResult.scannedAt, prev?.id || null);
  return scanId;
}

function storeChanges(scanId, changes) {
  const d = getCodebaseDb();
  const stmt = d.prepare('INSERT INTO codebase_changes (id, scan_id, change_type, element_type, element_name, details, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const now = new Date().toISOString();
  const insert = d.transaction((items) => { for (const c of items) stmt.run(randomUUID(), scanId, c.changeType, c.elementType, c.elementName, c.details ? JSON.stringify(c.details) : null, now); });
  insert(changes);
}

function getLatestScan(projectPath, orgId = 'default') {
  const d = getCodebaseDb();
  const row = d.prepare('SELECT * FROM codebase_scans WHERE org_id = ? AND (project_path = ? OR project_name = ?) ORDER BY scanned_at DESC LIMIT 1').get(orgId, projectPath, projectPath);
  if (!row) return null;
  return { ...row, scan_data: JSON.parse(row.scan_data), metrics: JSON.parse(row.metrics) };
}

function listProjects(orgId = 'default') {
  const d = getCodebaseDb();
  const rows = d.prepare(`
    SELECT DISTINCT project_path, project_name, project_type,
      MAX(scanned_at) as last_scan,
      (SELECT invariant_status FROM codebase_scans s2 WHERE s2.project_path = s.project_path AND s2.org_id = s.org_id ORDER BY s2.scanned_at DESC LIMIT 1) as invariant_status,
      (SELECT metrics FROM codebase_scans s3 WHERE s3.project_path = s.project_path AND s3.org_id = s.org_id ORDER BY s3.scanned_at DESC LIMIT 1) as metrics
    FROM codebase_scans s WHERE org_id = ? GROUP BY project_path ORDER BY project_name
  `).all(orgId);
  return rows.map((r) => ({ ...r, metrics: JSON.parse(r.metrics) }));
}

function getChanges(scanId) {
  const d = getCodebaseDb();
  return d.prepare('SELECT * FROM codebase_changes WHERE scan_id = ? ORDER BY detected_at DESC').all(scanId).map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
}

function queryElements(projectPath, elementType, filter = {}, orgId = 'default') {
  const scan = getLatestScan(projectPath, orgId);
  if (!scan) return [];
  const data = scan.scan_data;
  let elements = [];

  switch (elementType) {
    case 'route':
      elements = data.routes || [];
      if (filter.protected !== undefined) elements = elements.filter((r) => r.protected === filter.protected);
      if (filter.minRole) elements = elements.filter((r) => r.minRole === filter.minRole);
      break;
    case 'service': elements = data.services || []; break;
    case 'schema': elements = data.schemas || []; break;
    case 'registry':
      elements = data.registries || [];
      if (filter.name) elements = elements.filter((r) => r.name.includes(filter.name));
      break;
    case 'plugin':
    case 'agent':
      elements = (data.registries || []).filter((r) => r.name === `${elementType}s` || r.name === elementType).flatMap((r) => r.entries);
      break;
    default: break;
  }

  if (filter.name && elementType !== 'registry') {
    const pattern = filter.name.toLowerCase();
    elements = elements.filter((e) => (e.name || e.path || e.id || '').toLowerCase().includes(pattern));
  }
  return elements;
}

function getPreviousScan(scanId) {
  const d = getCodebaseDb();
  const current = d.prepare('SELECT previous_scan_id FROM codebase_scans WHERE id = ?').get(scanId);
  if (!current?.previous_scan_id) return null;
  const prev = d.prepare('SELECT * FROM codebase_scans WHERE id = ?').get(current.previous_scan_id);
  if (!prev) return null;
  return { ...prev, scan_data: JSON.parse(prev.scan_data), metrics: JSON.parse(prev.metrics) };
}

function getOverallStatus(checks) {
  if (!checks || checks.length === 0) return 'pass';
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'pass';
}

function closeCodebaseDb() {
  if (db) { db.close(); db = null; }
}

module.exports = { initCodebaseDb, getCodebaseDb, storeScan, storeChanges, getLatestScan, listProjects, getChanges, queryElements, getPreviousScan, closeCodebaseDb };
