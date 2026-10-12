/**
 * Credential Health Scanner — QuoxVault Phase 2
 *
 * Scans vault credentials for health issues:
 * - Stale credentials (not used in >30 days)
 * - Untested credentials
 * - Failed test status
 * - Expiring credentials (Phase 4 — future)
 *
 * Runs on-demand via API or on a 4-hour interval.
 */

import { getDb, prepare } from '../db/index.js';
import { ulid } from 'ulid';
import { emitItemCreated, emitStatsUpdate } from '../utils/inboxEvents.js';

// Scan interval: 4 hours
const SCAN_INTERVAL_MS = 4 * 60 * 60 * 1000;
const STALE_THRESHOLD_DAYS = 30;
const EXPIRING_THRESHOLD_DAYS = 7;
const ROTATION_OVERDUE_DAYS = 90;

let _lastScanTime = 0;
let _lastScanResult = null;
let _scanTimer = null;

/**
 * Get vault health stats for an organization
 * @param {string} orgId - Organization ID
 * @returns {Object} Health statistics
 */
export function getVaultStats(orgId) {
    const db = getDb();

    const total = db.prepare(
        'SELECT COUNT(*) as c FROM integration_credentials WHERE org_id = ?'
    ).get(orgId)?.c || 0;

    const healthy = db.prepare(
        "SELECT COUNT(*) as c FROM integration_credentials WHERE org_id = ? AND test_status = 'success'"
    ).get(orgId)?.c || 0;

    const failed = db.prepare(
        "SELECT COUNT(*) as c FROM integration_credentials WHERE org_id = ? AND test_status = 'failed'"
    ).get(orgId)?.c || 0;

    const untested = db.prepare(
        "SELECT COUNT(*) as c FROM integration_credentials WHERE org_id = ? AND test_status = 'untested'"
    ).get(orgId)?.c || 0;

    // Stale: not used in 30+ days (or never used)
    const stale = db.prepare(`
        SELECT COUNT(*) as c FROM integration_credentials
        WHERE org_id = ?
          AND (last_used_at IS NULL OR last_used_at < datetime('now', '-' || ? || ' days'))
    `).get(orgId, STALE_THRESHOLD_DAYS)?.c || 0;

    // Expiring within 7 days
    const expiring = db.prepare(`
        SELECT COUNT(*) as c FROM integration_credentials
        WHERE org_id = ?
          AND expires_at IS NOT NULL
          AND expires_at < datetime('now', '+' || ? || ' days')
    `).get(orgId, EXPIRING_THRESHOLD_DAYS)?.c || 0;

    // Rotation overdue (>90 days since last rotation or creation)
    const rotationOverdue = db.prepare(`
        SELECT COUNT(*) as c FROM integration_credentials
        WHERE org_id = ?
          AND (
            (rotated_at IS NULL AND created_at < datetime('now', '-' || ? || ' days'))
            OR (rotated_at IS NOT NULL AND rotated_at < datetime('now', '-' || ? || ' days'))
          )
    `).get(orgId, ROTATION_OVERDUE_DAYS, ROTATION_OVERDUE_DAYS)?.c || 0;

    // Total usage across all credentials
    const totalUseCount = db.prepare(
        'SELECT COALESCE(SUM(use_count), 0) as c FROM integration_credentials WHERE org_id = ?'
    ).get(orgId)?.c || 0;

    // Most used credential
    const mostUsed = db.prepare(`
        SELECT integration_type, label, use_count
        FROM integration_credentials
        WHERE org_id = ? AND use_count > 0
        ORDER BY use_count DESC LIMIT 1
    `).get(orgId) || null;

    // Type breakdown
    const typeBreakdown = db.prepare(`
        SELECT integration_type, COUNT(*) as count,
               SUM(CASE WHEN test_status = 'success' THEN 1 ELSE 0 END) as healthy,
               SUM(CASE WHEN test_status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM integration_credentials
        WHERE org_id = ?
        GROUP BY integration_type
        ORDER BY count DESC
    `).all(orgId);

    return {
        total,
        healthy,
        failed,
        untested,
        stale,
        expiring,
        rotationOverdue,
        totalUseCount,
        mostUsed,
        typeBreakdown,
        lastScanAt: _lastScanTime ? new Date(_lastScanTime).toISOString() : null,
        encryption: 'AES-256-GCM'
    };
}

/**
 * Run a health scan for an organization
 * Identifies credentials that need attention
 *
 * @param {string} orgId
 * @returns {Object} Scan results with issues found
 */
export function runHealthScan(orgId) {
    const db = getDb();
    const issues = [];

    // 1. Find stale credentials (not used in 30+ days)
    const staleCredentials = db.prepare(`
        SELECT id, integration_type, label, last_used_at, use_count
        FROM integration_credentials
        WHERE org_id = ?
          AND (last_used_at IS NULL OR last_used_at < datetime('now', '-' || ? || ' days'))
    `).all(orgId, STALE_THRESHOLD_DAYS);

    for (const cred of staleCredentials) {
        issues.push({
            credentialId: cred.id,
            type: cred.integration_type,
            label: cred.label,
            severity: 'warning',
            issue: 'stale',
            message: cred.last_used_at
                ? `Not used since ${cred.last_used_at}`
                : 'Never used',
            useCount: cred.use_count
        });
    }

    // 2. Find failed credentials
    const failedCredentials = db.prepare(`
        SELECT id, integration_type, label, last_tested_at, test_status
        FROM integration_credentials
        WHERE org_id = ? AND test_status = 'failed'
    `).all(orgId);

    for (const cred of failedCredentials) {
        issues.push({
            credentialId: cred.id,
            type: cred.integration_type,
            label: cred.label,
            severity: 'error',
            issue: 'failed_test',
            message: `Test failed at ${cred.last_tested_at || 'unknown'}`,
        });
    }

    // 3. Find untested credentials older than 24 hours
    const untestedCredentials = db.prepare(`
        SELECT id, integration_type, label, created_at
        FROM integration_credentials
        WHERE org_id = ? AND test_status = 'untested'
          AND created_at < datetime('now', '-1 day')
    `).all(orgId);

    for (const cred of untestedCredentials) {
        issues.push({
            credentialId: cred.id,
            type: cred.integration_type,
            label: cred.label,
            severity: 'info',
            issue: 'untested',
            message: `Created ${cred.created_at}, never tested`,
        });
    }

    // 4. Find credentials with no defaults set (orphaned types)
    const typesWithoutDefault = db.prepare(`
        SELECT integration_type, COUNT(*) as count
        FROM integration_credentials
        WHERE org_id = ? AND is_default = 0
        GROUP BY integration_type
        HAVING count > 0
          AND integration_type NOT IN (
            SELECT integration_type FROM integration_credentials
            WHERE org_id = ? AND is_default = 1
          )
    `).all(orgId, orgId);

    for (const row of typesWithoutDefault) {
        issues.push({
            type: row.integration_type,
            severity: 'info',
            issue: 'no_default',
            message: `${row.count} credential(s) but no default set`,
        });
    }

    // 5. Find expiring credentials (within 7 days)
    const expiringCredentials = db.prepare(`
        SELECT id, integration_type, label, expires_at
        FROM integration_credentials
        WHERE org_id = ?
          AND expires_at IS NOT NULL
          AND expires_at < datetime('now', '+' || ? || ' days')
    `).all(orgId, EXPIRING_THRESHOLD_DAYS);

    for (const cred of expiringCredentials) {
        const isExpired = new Date(cred.expires_at) < new Date();
        issues.push({
            credentialId: cred.id,
            type: cred.integration_type,
            label: cred.label,
            severity: isExpired ? 'error' : 'warning',
            issue: isExpired ? 'expired' : 'expiring',
            message: isExpired
                ? `Expired at ${cred.expires_at}`
                : `Expires at ${cred.expires_at}`,
        });
        // LI-OVERHAUL P5: the scanner only ever CACHED these findings for
        // API reads — nothing warned a human, despite the LinkedIn setup
        // wizard promising exactly that. Mint an org-admin inbox item,
        // deduplicated per credential + expiry window.
        notifyExpiringCredential(orgId, cred, isExpired);
    }

    // 6. Find credentials overdue for rotation (>90 days since rotation or creation)
    const overdueCredentials = db.prepare(`
        SELECT id, integration_type, label, rotated_at, created_at
        FROM integration_credentials
        WHERE org_id = ?
          AND (
            (rotated_at IS NULL AND created_at < datetime('now', '-' || ? || ' days'))
            OR (rotated_at IS NOT NULL AND rotated_at < datetime('now', '-' || ? || ' days'))
          )
    `).all(orgId, ROTATION_OVERDUE_DAYS, ROTATION_OVERDUE_DAYS);

    for (const cred of overdueCredentials) {
        const lastRotation = cred.rotated_at || cred.created_at;
        issues.push({
            credentialId: cred.id,
            type: cred.integration_type,
            label: cred.label,
            severity: 'warning',
            issue: 'rotation_overdue',
            message: cred.rotated_at
                ? `Last rotated ${cred.rotated_at}`
                : `Created ${cred.created_at}, never rotated`,
        });
    }

    _lastScanTime = Date.now();
    _lastScanResult = {
        orgId,
        scannedAt: new Date(_lastScanTime).toISOString(),
        issueCount: issues.length,
        issues,
        stats: getVaultStats(orgId)
    };

    return _lastScanResult;
}

/**
 * Get recent vault activity from audit_events
 *
 * @param {string} orgId
 * @param {Object} options
 * @param {number} [options.limit=20]
 * @param {number} [options.offset=0]
 * @returns {Array} Recent vault events
 */
export function getVaultActivity(orgId, options = {}) {
    const { limit = 20, offset = 0 } = options;
    const db = getDb();

    try {
        return db.prepare(`
            SELECT id, action, actor_type, actor_id,
                   target_type, target_id, status,
                   metadata_json, created_at
            FROM audit_events
            WHERE org_id = ?
              AND action LIKE 'integration.%'
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `).all(orgId, limit, offset);
    } catch {
        // audit_events table may not exist in test environments
        return [];
    }
}

/**
 * Get the last scan result (cached)
 */
export function getLastScanResult() {
    return _lastScanResult;
}

/**
 * LI-OVERHAUL P5 — surface an expiring/expired credential to the org's
 * admins as an inbox item (kind info/incident), so the wizard's "the
 * dashboard will warn you" line is finally true. Deduplicated on
 * source_id = `${credentialId}:${expires_at}`: one warning per credential
 * per expiry window regardless of item status (a rotation sets a new
 * expires_at and so re-warns exactly once), and the 4-hour tick can never
 * spam. Failures are logged, never thrown — a warning that cannot be
 * minted must not break the scan itself.
 */
function notifyExpiringCredential(orgId, cred, isExpired) {
    try {
        const db = getDb();
        // NOTE: inbox_items has no source_type/source_id columns (the
        // backupScheduler INSERT that assumes them has been failing silently
        // inside its own catch since it shipped — found during LI-OVERHAUL
        // P5). The dedup key lives in payload_json instead.
        const dedupKey = `credential_health:${cred.id}:${cred.expires_at}`;
        const existing = db.prepare(`
            SELECT id FROM inbox_items
            WHERE org_id = ? AND json_extract(payload_json, '$.dedup') = ?
        `).get(orgId, dedupKey);
        if (existing) return;

        const admins = db.prepare(`
            SELECT user_id FROM org_memberships
            WHERE org_id = ? AND role IN ('owner', 'admin')
        `).all(orgId);
        if (admins.length === 0) return;

        const daysLeft = Math.ceil((new Date(cred.expires_at) - Date.now()) / 86400000);
        const title = isExpired
            ? `Credential expired: ${cred.label} (${cred.integration_type})`
            : `Credential expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}: ${cred.label} (${cred.integration_type})`;
        const body = (isExpired
            ? `The **${cred.integration_type}** credential **${cred.label}** expired at ${cred.expires_at}. Tools using it are failing now.`
            : `The **${cred.integration_type}** credential **${cred.label}** expires at ${cred.expires_at}.`)
            + `\n\nRotate it in Vault → Credentials to keep the integration working.`;

        const kind = isExpired ? 'incident' : 'info';
        const priority = isExpired ? 'high' : 'normal';
        const payload = JSON.stringify({
            dedup: dedupKey,
            source: 'credential_health',
            credential_id: cred.id,
            integration_type: cred.integration_type,
            expires_at: cred.expires_at,
        });
        for (const { user_id } of admins) {
            const inboxId = ensurePersonalInbox(orgId, user_id);
            const itemId = ulid();
            db.prepare(`
                INSERT INTO inbox_items (
                    id, org_id, inbox_id, kind, priority, title, body_md,
                    payload_json, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', datetime('now'), datetime('now'))
            `).run(itemId, orgId, inboxId, kind, priority, title, body, payload);
            emitItemCreated(orgId, { id: itemId, kind, priority, title, status: 'open' });
        }
        emitStatsUpdate(orgId);
    } catch (err) {
        console.error('[HealthScanner] Failed to mint expiry inbox item:', err.message);
    }
}

/**
 * Ensure user has a personal inbox in the org (same local-copy pattern as
 * backupScheduler.js / bastion-approvals.js).
 */
function ensurePersonalInbox(orgId, userId) {
    const existing = prepare(`
        SELECT id FROM inboxes
        WHERE org_id = ? AND owner_id = ? AND inbox_type = 'personal'
    `).get(orgId, userId);
    if (existing) return existing.id;

    const inboxId = ulid();
    prepare(`
        INSERT INTO inboxes (id, org_id, inbox_type, name, owner_id)
        VALUES (?, ?, 'personal', 'Personal Inbox', ?)
    `).run(inboxId, orgId, userId);
    return inboxId;
}

/**
 * Run the health scan for every active org (F3 fix — the periodic tick
 * has no single orgId to scan, so it must iterate all orgs itself).
 * Per-org failures are caught individually so one bad org can't stop
 * the rest of the sweep.
 */
export function runHealthScanAllOrgs() {
    const db = getDb();
    const orgs = db.prepare(`SELECT id FROM orgs WHERE deleted_at IS NULL`).all();

    const results = { orgCount: orgs.length, scanned: 0, failed: 0 };

    for (const org of orgs) {
        try {
            runHealthScan(org.id);
            results.scanned++;
        } catch (err) {
            results.failed++;
            console.error(`[HealthScanner] Scan failed for org ${org.id}:`, err.message);
        }
    }

    return results;
}

/**
 * Start periodic health scanning
 *
 * F3 fix: the previous implementation called runHealthScan(orgId) with
 * whatever (usually undefined) orgId it was started with, so every tick
 * bound `undefined` into `WHERE org_id = ?` and threw (silently swallowed
 * by the catch below). The periodic tick has no single org in scope, so
 * it now scans ALL orgs each interval.
 */
export function startPeriodicScan() {
    if (_scanTimer) return;
    _scanTimer = setInterval(() => {
        try {
            const results = runHealthScanAllOrgs();
            if (results.failed > 0) {
                console.warn(`[HealthScanner] Periodic scan: ${results.scanned} orgs scanned, ${results.failed} failed`);
            }
        } catch (err) {
            console.error('[HealthScanner] Periodic scan failed:', err.message);
        }
    }, SCAN_INTERVAL_MS);
    // Don't prevent process exit
    if (_scanTimer.unref) _scanTimer.unref();
}

/**
 * Stop periodic scanning
 */
export function stopPeriodicScan() {
    if (_scanTimer) {
        clearInterval(_scanTimer);
        _scanTimer = null;
    }
}

export default {
    getVaultStats,
    runHealthScan,
    runHealthScanAllOrgs,
    getVaultActivity,
    getLastScanResult,
    startPeriodicScan,
    stopPeriodicScan
};
