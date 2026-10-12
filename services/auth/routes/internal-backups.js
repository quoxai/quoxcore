/**
 * QLUSTER-4 — internal (service-to-service) backups access for the collector's
 * Qluster backup proxy (services/collector/lib/qlusterBackupProxy.js).
 *
 *   GET  /api/internal/backups/summary          → { newest_backup_ts, count } (all orgs)
 *   GET  /api/internal/backups?org_id=          → list (id, org_id, created_at, size, status, archiveHash)
 *   GET  /api/internal/backups/status?org_id=   → per-org health summary (AGENT-OVERHAUL: mirrors
 *                                                  GET /orgs/:orgId/backup-status for KEEPER's
 *                                                  keeper_backup_status tool, which 401'd hitting the
 *                                                  user-facing route with no browser JWT — org_id
 *                                                  required, no default/wildcard org)
 *   POST /api/internal/backups/trigger {org_id}→ same creation path as POST /orgs/:orgId/backups
 *                                                  (G2d slice 3: when BACKUP_RUNNER_HOST is set the
 *                                                  work is dispatched to the GOVERNED host-side
 *                                                  runner instead of spawned in-container — route
 *                                                  path, 201 body, row lifecycle and manifest shape
 *                                                  are unchanged, because Qluster depends on them)
 *   GET  /api/internal/backups/:id/download    → stream the archive file (404 if missing)
 *   POST /api/internal/backups/verify  {org_id,backup_id} → same path as POST
 *                                                  /orgs/:orgId/backups/:backupId/verify
 *                                                  (AGENT-OVERHAUL: keeper_backup_verify fix —
 *                                                  the org route requires a CSRF token a
 *                                                  service-key caller can't present)
 *   POST /api/internal/backups/restore {org_id,backup_id,dry_run?} → same path as POST
 *                                                  /orgs/:orgId/backups/:backupId/restore
 *                                                  (AGENT-OVERHAUL: keeper_backup_restore fix,
 *                                                  same CSRF class of bug as verify above)
 *
 * Auth: X-Service-Key (INTERNAL_SERVICE_KEY), timing-safe, fails CLOSED when
 * the key isn't configured — identical to routes/internal-orgs.js and
 * routes/internal-tool-definitions.js. This unblocks the collector's Phase 3
 * backups-summary (previously 501, no internal endpoint existed) and Phase 4
 * remote backup pull. The download route is the "missing route" flagged in
 * docs/PLAN.md §8.3 — the box-side backup subsystem had no archive download
 * endpoint (archive_path was used only for delete/verify/restore).
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { safeCompare } from '../utils/crypto.js';
import { ulid, safeJsonParse } from '../utils/helpers.js';
import { runBackupProcess, verifyBackupIntegrity, runRestoreProcess, logBackupAudit, DEFCON_LEVELS, resolveBackupTimeoutMs } from './backups.js';
import { dispatchBackupToRunner, runnerHostId } from '../lib/backupRunnerDispatch.js';
import { existsSync, createReadStream, statSync } from 'fs';
import * as path from 'path';

// Where archives live on THIS node. Read per-call, not frozen at import: the
// download fallback below needs whatever the container is mounted with now.
function backupRoot() {
  return process.env.BACKUP_ROOT || '/opt/quoxcore/backups';
}

const router = Router();

function requireInternalAuth(req, res, next) {
  const expectedKey = process.env.INTERNAL_SERVICE_KEY;
  if (!expectedKey) {
    console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying internal backups request');
    return res.status(401).json({ error: 'Service key not configured' });
  }
  const serviceKey = req.headers['x-service-key'];
  if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
  return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

router.use(requireInternalAuth);

// Extract the archive hash from a backup's manifest (schema-backups.sql:34 —
// manifest_json.archiveHash, e.g. "sha256:<hex>").
function archiveHashOf(manifestJson) {
  const manifest = safeJsonParse(manifestJson, null);
  return manifest?.archiveHash || null;
}

// Org allow-list forwarded by the collector's Qluster backup proxy. Returns
// null when the caller supplied no filter, or an array (possibly empty ⇒
// deny-all) of org ids when it did. Defense in depth: the collector already
// enforces the controller's allowed_orgs; honoring it here too closes any gap.
function parseAllowedOrgs(req) {
  const raw = req.query?.allowed_orgs;
  if (raw == null) return null;
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * GET /api/internal/backups/summary
 * Fleet freshness across ALL orgs — the value the controller's Phase 3
 * backups-summary check needs (newest backup + total count).
 */
router.get('/backups/summary', (req, res) => {
  const db = req.db || getDb();
  try {
    const row = db.prepare(`
      SELECT MAX(COALESCE(completed_at, created_at)) AS newest_backup_ts,
             COUNT(*) AS count
      FROM backups
    `).get();
    return res.json({
      newest_backup_ts: row?.newest_backup_ts || null,
      count: row?.count || 0,
    });
  } catch (err) {
    console.error('[internal-backups] summary query failed:', err.message);
    return res.status(500).json({ error: 'db_error', message: err.message });
  }
});

/**
 * GET /api/internal/backups?org_id=
 * List backups (all orgs, or one org when org_id is supplied). Same source
 * table + fields as routes/backups.js GET /orgs/:orgId/backups, projected to
 * the controller-facing shape.
 */
router.get('/backups', (req, res) => {
  const db = req.db || getDb();
  const { org_id } = req.query;
  const allowed = parseAllowedOrgs(req);
  try {
    // Deny-all when an (empty) allow-list is supplied — never fall through to
    // an unscoped listing.
    if (allowed !== null && allowed.length === 0) {
      return res.json({ backups: [], count: 0 });
    }
    const clauses = [];
    const params = [];
    if (org_id) { clauses.push('org_id = ?'); params.push(org_id); }
    if (allowed !== null) {
      clauses.push(`org_id IN (${allowed.map(() => '?').join(',')})`);
      params.push(...allowed);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT id, org_id, created_at, archive_size_bytes, status, manifest_json
      FROM backups
      ${where}
      ORDER BY created_at DESC
    `).all(...params);
    const backups = rows.map((b) => ({
      id: b.id,
      org_id: b.org_id,
      created_at: b.created_at,
      size: b.archive_size_bytes,
      status: b.status,
      archiveHash: archiveHashOf(b.manifest_json),
    }));
    return res.json({ backups, count: backups.length });
  } catch (err) {
    console.error('[internal-backups] list query failed:', err.message);
    return res.status(500).json({ error: 'db_error', message: err.message });
  }
});

// Small local JSON parse guard (avoids a cross-module import for two reads).
function safeParseJson(raw, fallback) {
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

/**
 * GET /api/internal/backup-schedules?org_id=
 * Service-key mirror of GET /orgs/:orgId/backup-schedules (routes/backups.js).
 * KEEPER's keeper_schedule_list tool has no browser JWT, so it 401'd against
 * the user-facing route (AGENT-OVERHAUL phase 7). org_id is required, never
 * defaulted, so a missing scope never lists every org's schedules.
 */
router.get('/backup-schedules', (req, res) => {
  const db = req.db || getDb();
  const { org_id } = req.query;
  if (!org_id) return res.status(400).json({ error: 'org_id_required' });
  const allowed = parseAllowedOrgs(req);
  if (allowed !== null && !allowed.includes(org_id)) {
    return res.json({ schedules: [] });
  }
  try {
    const rows = db.prepare(`
      SELECT s.*, b.status as last_backup_status
      FROM backup_schedules s
      LEFT JOIN backups b ON s.last_backup_id = b.id
      WHERE s.org_id = ?
      ORDER BY s.created_at DESC
    `).all(org_id);
    const schedules = rows.map((s) => ({
      ...s,
      components: safeParseJson(s.components_json, []),
      enabled: s.enabled === 1,
    }));
    return res.json({ schedules });
  } catch (err) {
    console.error('[internal-backups] schedule list failed:', err.message);
    return res.status(500).json({ error: 'db_error', message: err.message });
  }
});

/**
 * GET /api/internal/backup-audit-log?org_id=&operation=&defcon_level=&limit=
 * Service-key mirror of GET /orgs/:orgId/backup-audit-log (routes/backups.js).
 * Fixes keeper_audit_log (same 401 class as above). org_id required.
 */
router.get('/backup-audit-log', (req, res) => {
  const db = req.db || getDb();
  const { org_id, operation, defcon_level, backup_id, limit } = req.query;
  if (!org_id) return res.status(400).json({ error: 'org_id_required' });
  const allowed = parseAllowedOrgs(req);
  if (allowed !== null && !allowed.includes(org_id)) {
    return res.json({ entries: [], total: 0 });
  }
  try {
    const clauses = ['org_id = ?'];
    const params = [org_id];
    if (operation) { clauses.push('operation = ?'); params.push(operation); }
    if (defcon_level) { clauses.push('defcon_level = ?'); params.push(defcon_level); }
    if (backup_id) { clauses.push('backup_id = ?'); params.push(backup_id); }
    const lim = Math.min(Number(limit) || 20, 200);
    const entries = db.prepare(`
      SELECT * FROM backup_audit_log
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, lim);
    const parsed = entries.map((e) => ({ ...e, metadata: safeParseJson(e.metadata_json, {}) }));
    return res.json({ entries: parsed, total: parsed.length });
  } catch (err) {
    console.error('[internal-backups] audit-log failed:', err.message);
    return res.status(500).json({ error: 'db_error', message: err.message });
  }
});

/**
 * GET /api/internal/backups/status?org_id=
 * Per-org backup health summary — mirrors GET /orgs/:orgId/backup-status
 * (routes/backups.js) exactly, but org_id is required explicitly (never
 * defaulted) instead of taken from a browser-authenticated :orgId param.
 * Fixes keeper_backup_status: the KEEPER agent tool has no browser JWT to
 * present, so it always 401'd against the user-facing route.
 */
router.get('/backups/status', (req, res) => {
  const db = req.db || getDb();
  const { org_id } = req.query;
  if (!org_id) return res.status(400).json({ error: 'org_id required' });

  try {
    const lastSuccess = db.prepare(`
      SELECT id, name, backup_type, archive_size_bytes, completed_at, duration_ms
      FROM backups
      WHERE org_id = ? AND status IN ('completed', 'verified')
      ORDER BY completed_at DESC LIMIT 1
    `).get(org_id);

    const lastFailed = db.prepare(`
      SELECT id, name, error_message, completed_at
      FROM backups
      WHERE org_id = ? AND status = 'failed'
      ORDER BY completed_at DESC LIMIT 1
    `).get(org_id);

    const running = db.prepare(`
      SELECT id, name, backup_type, started_at
      FROM backups
      WHERE org_id = ? AND status = 'running'
      ORDER BY started_at DESC LIMIT 1
    `).get(org_id);

    const totals = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(archive_size_bytes), 0) as totalBytes
      FROM backups
      WHERE org_id = ? AND status IN ('completed', 'verified')
    `).get(org_id);

    let scheduleStats = null;
    try {
      scheduleStats = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled,
               MIN(CASE WHEN enabled = 1 AND next_run_at IS NOT NULL THEN next_run_at END) as nextRun
        FROM backup_schedules
        WHERE org_id = ?
      `).get(org_id);
    } catch { /* backup_schedules table optional in test fixtures */ }

    let health = 'unknown';
    let healthReason = 'No backups found';

    if (lastSuccess?.completed_at) {
      const lastSuccessAge = Date.now() - new Date(lastSuccess.completed_at).getTime();
      const hoursAgo = lastSuccessAge / (1000 * 60 * 60);
      if (hoursAgo < 24) {
        health = 'healthy';
        healthReason = `Last backup ${Math.round(hoursAgo)}h ago`;
      } else if (hoursAgo < 72) {
        health = 'warning';
        healthReason = `Last backup ${Math.round(hoursAgo)}h ago`;
      } else {
        health = 'critical';
        healthReason = `Last backup ${Math.round(hoursAgo / 24)}d ago — overdue`;
      }
    }

    if (lastFailed?.completed_at && lastSuccess?.completed_at) {
      if (new Date(lastFailed.completed_at) > new Date(lastSuccess.completed_at)) {
        if (health === 'healthy') health = 'warning';
        healthReason += ' (last attempt failed)';
      }
    }

    return res.json({
      health,
      healthReason,
      lastSuccess: lastSuccess ? {
        id: lastSuccess.id,
        name: lastSuccess.name,
        type: lastSuccess.backup_type,
        sizeBytes: lastSuccess.archive_size_bytes,
        completedAt: lastSuccess.completed_at,
        durationMs: lastSuccess.duration_ms
      } : null,
      lastFailed: lastFailed ? {
        id: lastFailed.id,
        name: lastFailed.name,
        error: lastFailed.error_message,
        completedAt: lastFailed.completed_at
      } : null,
      running: running ? {
        id: running.id,
        name: running.name,
        type: running.backup_type,
        startedAt: running.started_at
      } : null,
      totals: {
        count: totals?.count || 0,
        totalBytes: totals?.totalBytes || 0,
      },
      schedules: {
        total: scheduleStats?.total || 0,
        enabled: scheduleStats?.enabled || 0,
        nextRun: scheduleStats?.nextRun || null
      }
    });
  } catch (err) {
    console.error('[internal-backups] status query failed:', err.message);
    return res.status(500).json({ error: 'db_error', message: err.message });
  }
});

/**
 * POST /api/internal/backups/trigger { org_id }
 * Invokes the SAME creation path as POST /orgs/:orgId/backups: insert a
 * 'running' record then hand off to backups.js runBackupProcess (spawn script,
 * timeout, manifest, backup_audit_log). No duplicated execution logic.
 * The heavy async runner is overridable via app.locals.qlusterBackupRunner so
 * tests don't spawn a real backup.
 */
router.post('/backups/trigger', (req, res) => {
  const db = req.db || getDb();
  // org_id is required; backup_type/name/description/components are optional so
  // service-key callers (KEEPER backup_create, REGULA backup_run) get parity
  // with POST /orgs/:orgId/backups instead of being forced to a fixed full
  // backup. Absent params reproduce the original org-id-only behaviour, so the
  // Qluster controller's {org_id}-only call is unchanged.
  const { org_id, backup_type, name, description, components } = req.body || {};
  if (!org_id) return res.status(400).json({ error: 'org_id required' });
  try {
    const backupId = ulid();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const type = backup_type === 'selective' ? 'selective' : 'full';
    const backupName = name || `Backup ${timestamp}`;
    const desc = description || 'Remote-triggered backup';
    const selectedComponents = (type === 'selective' && Array.isArray(components) && components.length)
      ? components : undefined;
    const componentsJson = selectedComponents ? JSON.stringify(selectedComponents) : null;
    db.prepare(`
      INSERT INTO backups (id, org_id, backup_type, name, description, status, components_json, created_by, started_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, datetime('now'))
    `).run(backupId, org_id, type, backupName, desc, componentsJson);

    // G2d slice 3 — three-way runner selection, in this precedence order:
    //
    //   1. app.locals.qlusterBackupRunner  (TEST SEAM — always wins, so no
    //      test ever spawns a real backup or opens a socket)
    //   2. the GOVERNED host-side runner, when BACKUP_RUNNER_HOST names one.
    //      On baked/public boxes backup-quox.sh is not in this image, so an
    //      in-container spawn can only ever fail; the engine lives host-side
    //      behind quoxagent's dev.backup executor. Dispatch there and watch
    //      for the receipt, keeping this row's existing lifecycle intact.
    //   3. backups.js runBackupProcess — the in-container spawn, unchanged,
    //      which is still correct on a dev box with the project bind-mounted.
    //
    // The EXTERNAL contract (route path, 201 body, row lifecycle, manifest
    // shape) is identical in all three cases: the collector's Qluster backup
    // proxy depends on it and is not being changed.
    const seam = req.app?.locals?.qlusterBackupRunner;
    if (seam) {
      try {
        seam(backupId, org_id, type, selectedComponents, 'service:trigger', null);
      } catch (runErr) {
        console.error('[internal-backups] backup runner failed to start:', runErr.message);
      }
    } else if (runnerHostId()) {
      // Fire-and-forget, exactly like runBackupProcess: the row is already
      // 'running' and the 201 below is the dispatch acknowledgement. Any
      // failure inside is recorded ON THE ROW, never thrown at the caller.
      (async () => {
        const timeoutMs = await resolveBackupTimeoutMs(org_id);
        return dispatchBackupToRunner({
          db,
          appLocals: req.app?.locals || {},
          backupId,
          orgId: org_id,
          backupType: type,
          timeoutMs,
        });
      })().catch((runErr) => {
        console.error('[internal-backups] governed backup runner dispatch failed to start:', runErr.message);
      });
    } else {
      try {
        runBackupProcess(backupId, org_id, type, selectedComponents, 'service:trigger', null);
      } catch (runErr) {
        console.error('[internal-backups] backup runner failed to start:', runErr.message);
      }
    }

    return res.status(201).json({
      backup: { id: backupId, org_id, status: 'running', name: backupName, backup_type: type },
    });
  } catch (err) {
    console.error('[internal-backups] trigger failed:', err.message);
    return res.status(500).json({ error: 'db_error', message: err.message });
  }
});

/**
 * POST /api/internal/backups/verify { org_id, backup_id }
 * Mirrors POST /orgs/:orgId/backups/:backupId/verify (routes/backups.js) —
 * same lookup/guards, hands off to the SAME verifyBackupIntegrity() runner
 * (no duplicated verification logic). The heavy async verifier is
 * overridable via app.locals.qlusterBackupVerifier so tests don't touch the
 * real (module-singleton) auth db that verifyBackupIntegrity reads/writes
 * through internally.
 *
 * KNOWN GAP (G2d slice 3): the download route below now falls back to
 * <BACKUP_ROOT>/<basename> when a host-produced archive_path does not resolve
 * inside this container. Verify does NOT, deliberately: the guard here is only
 * half of it — verifyBackupIntegrity() re-reads archive_path itself, so a
 * translation applied only at this gate would be a lie the verifier then
 * disproves. Fixing it properly means teaching backups.js the same
 * translation, which is org-lane surgery and out of this slice's scope. On a
 * baked box, verify a host-produced archive host-side instead.
 */
router.post('/backups/verify', (req, res) => {
  const db = req.db || getDb();
  const { org_id, backup_id } = req.body || {};
  if (!org_id) return res.status(400).json({ error: 'org_id required' });
  if (!backup_id) return res.status(400).json({ error: 'backup_id required' });
  try {
    const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND org_id = ?').get(backup_id, org_id);
    if (!backup) return res.status(404).json({ error: 'Backup not found' });

    if (backup.status !== 'completed' && backup.status !== 'verified') {
      return res.status(400).json({ error: 'Can only verify completed backups' });
    }
    if (!backup.archive_path || !existsSync(backup.archive_path)) {
      return res.status(400).json({ error: 'Backup archive not found' });
    }

    db.prepare(`UPDATE backups SET status = 'verifying', updated_at = datetime('now') WHERE id = ?`).run(backup_id);

    logBackupAudit({
      orgId: org_id,
      operation: 'BACKUP_VERIFY_STARTED',
      defconLevel: DEFCON_LEVELS.BACKUP_VERIFY,
      backupId: backup_id,
      operator: 'service:verify',
      operatorId: null,
      result: 'pending',
    });

    const verifier = req.app?.locals?.qlusterBackupVerifier || verifyBackupIntegrity;
    try {
      verifier(backup_id, org_id, backup.archive_path, safeJsonParse(backup.manifest_json, null), 'service:verify', null);
    } catch (runErr) {
      console.error('[internal-backups] verifier failed to start:', runErr.message);
    }

    return res.json({ message: 'Verification started', status: 'verifying' });
  } catch (err) {
    console.error('[internal-backups] verify failed:', err.message);
    return res.status(500).json({ error: 'Failed to start verification' });
  }
});

/**
 * POST /api/internal/backups/restore { org_id, backup_id, dry_run? }
 * Mirrors POST /orgs/:orgId/backups/:backupId/restore (routes/backups.js) —
 * same lookup/guards/restore_operations record, hands off to the SAME
 * runRestoreProcess() runner (no duplicated restore logic). No
 * requireOrgMembership/capability check here: this is a service-key
 * internal route, same trust boundary as /backups/trigger above.
 */
router.post('/backups/restore', (req, res) => {
  const db = req.db || getDb();
  const { org_id, backup_id, dry_run = true, components } = req.body || {};
  if (!org_id) return res.status(400).json({ error: 'org_id required' });
  if (!backup_id) return res.status(400).json({ error: 'backup_id required' });
  try {
    const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND org_id = ?').get(backup_id, org_id);
    if (!backup) return res.status(404).json({ error: 'Backup not found' });

    if (backup.status !== 'completed' && backup.status !== 'verified') {
      return res.status(400).json({ error: 'Can only restore from completed or verified backups' });
    }
    if (!backup.archive_path || !existsSync(backup.archive_path)) {
      return res.status(400).json({ error: 'Backup archive not found' });
    }

    const restoreId = ulid();
    const isDryRun = dry_run === true || dry_run === 'true';

    let defconLevel = DEFCON_LEVELS.RESTORE_FULL;
    if (isDryRun) {
      defconLevel = DEFCON_LEVELS.RESTORE_DRY_RUN;
    } else if (components && components.length > 0) {
      defconLevel = DEFCON_LEVELS.RESTORE_SELECTIVE;
    }

    db.prepare(`
      INSERT INTO restore_operations (id, org_id, backup_id, dry_run, components_json, status, performed_by, started_at)
      VALUES (?, ?, ?, ?, ?, 'running', NULL, datetime('now'))
    `).run(restoreId, org_id, backup_id, isDryRun ? 1 : 0, components ? JSON.stringify(components) : null);

    logBackupAudit({
      orgId: org_id,
      operation: isDryRun ? 'RESTORE_DRY_RUN' : 'RESTORE_STARTED',
      defconLevel,
      backupId: backup_id,
      restoreId,
      operator: 'service:restore',
      operatorId: null,
      result: 'pending',
      metadata: { components, dry_run: isDryRun },
    });

    const restorer = req.app?.locals?.qlusterBackupRestorer || runRestoreProcess;
    try {
      restorer(restoreId, org_id, backup, components, isDryRun, 'service:restore', null);
    } catch (runErr) {
      console.error('[internal-backups] restorer failed to start:', runErr.message);
    }

    return res.status(201).json({
      restore: {
        id: restoreId,
        status: 'running',
        dry_run: isDryRun,
        message: isDryRun
          ? 'Dry-run started. No changes will be made.'
          : 'Restore started. Poll /restore-operations/:id for status.',
      },
    });
  } catch (err) {
    console.error('[internal-backups] restore failed:', err.message);
    return res.status(500).json({ error: 'Failed to start restore' });
  }
});

/**
 * GET /api/internal/backups/:id/download
 * Streams the archive file. 404 when the record or archive file is missing —
 * the download route flagged missing in docs/PLAN.md §8.3.
 */
router.get('/backups/:id/download', (req, res) => {
  const db = req.db || getDb();
  const { id } = req.params;
  const allowed = parseAllowedOrgs(req);
  try {
    // Resolve the backup's org FIRST — the org check must pass before we ever
    // touch (let alone stream) the archive file.
    const backup = db.prepare('SELECT id, org_id, archive_path, archive_size_bytes FROM backups WHERE id = ?').get(id);
    if (!backup) return res.status(404).json({ error: 'backup_not_found' });
    if (allowed !== null && !allowed.includes(backup.org_id)) {
      return res.status(403).json({ error: 'org_not_allowed' });
    }
    if (!backup.archive_path) {
      return res.status(404).json({ error: 'archive_not_found' });
    }

    // G2d slice 3 — MOUNT TRANSLATION. When the backup was produced by the
    // governed HOST-side runner, archive_path is the path as the HOST sees it.
    // A baked deployment mounts the archive directory at BACKUP_ROOT inside
    // this container, which may not be the same string. Falling back to
    // <BACKUP_ROOT>/<basename> resolves the same file without inventing one:
    // the basename comes from the stored row, never from the request, and the
    // join can therefore not escape BACKUP_ROOT.
    let archivePath = backup.archive_path;
    if (!existsSync(archivePath)) {
      const translated = path.join(backupRoot(), path.basename(archivePath));
      if (translated !== archivePath && existsSync(translated)) {
        archivePath = translated;
      } else {
        return res.status(404).json({ error: 'archive_not_found' });
      }
    }

    let size = backup.archive_size_bytes;
    try { size = statSync(archivePath).size; } catch { /* keep stored size */ }
    if (size != null) res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(archivePath)}"`);

    const stream = createReadStream(archivePath);
    stream.on('error', (err) => {
      console.error('[internal-backups] download stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'stream_error' });
      else try { res.end(); } catch { /* ignore */ }
    });
    stream.pipe(res);
  } catch (err) {
    console.error('[internal-backups] download failed:', err.message);
    return res.status(500).json({ error: 'db_error', message: err.message });
  }
});

export default router;
