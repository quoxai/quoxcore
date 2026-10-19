/**
 * G2d slice 3 — INSTANCE-ADMIN, SERVER-WIDE backup/restore lane.
 *
 * This is the operator surface for "back up / restore THIS BOX", as distinct
 * from routes/backups.js, which is the per-ORG tenant lane (one org's data,
 * scoped by :orgId, gated on org membership). Nothing here is org-scoped:
 * a server-wide archive contains every org, so the only correct gate is
 * instance admin, and a real restore is the most destructive verb the
 * product has.
 *
 * The work itself is NOT done here. The governed runner already exists:
 *   collector POST/GET /api/v1/dev-backup/:hostId/{dispatch,status,archives,
 *   restore,restore-status}  (services/collector/lib/devBackupProxy.js)
 * which signs a JobEnvelope and delivers it over Bastion to the host-side
 * quoxagent dev.backup / dev.restore executors, wrapping
 * scripts/backup-quox.sh and scripts/restore-quox.sh. This router is a thin,
 * honest reach-through to that plane plus the local archive mount for
 * downloads. It never spawns a backup, never composes an archive id, and
 * never invents a dry-run posture.
 *
 * ── GUARD LAYERS (every route passes ALL of 1-4, then its own) ──────────────
 *  1. server.js app-level: helmet + CORS allow-list + csrfProtection()
 *     (line ~341) — a cross-site POST cannot reach these routes at all.
 *  2. Mount point: '/api/admin/backups' ONLY (server.js), mounted immediately
 *     before adminRoutes so the subtree is explicit and nothing broader is
 *     shadowed. See the [auth-mount-order] note at server.js:593.
 *  3. router.use(authenticate())          → 401 without a valid session.
 *  4. router.use(requireInstanceAdmin('readonly')) → 403 for any user who is
 *     not an instance admin. readonly is the FLOOR, never the ceiling.
 *  5. Per-route escalation (the ceiling):
 *       GET  /                      readonly   (list archives)
 *       GET  /status                readonly
 *       GET  /restore-status        readonly
 *       POST /                      admin      (dispatch a backup)
 *       GET  /:archiveId/download   admin      (exfiltrates every org's data)
 *       POST /:archiveId/restore    superadmin (destroys every org's data)
 *  6. Configuration gate: BACKUP_RUNNER_HOST must name a registered dev
 *     server, else 503 with the env name — never a silent no-op.
 *  7. Input validation: archive id pattern, mode enum, boolean-only dry_run,
 *     literal confirm token for a live restore.
 *  8. Path containment on download: the resolved file must live INSIDE
 *     BACKUP_ROOT, and must ALSO be an archive the runner itself registered.
 *
 * Failures from the collector are passed through with their status and their
 * real message. A dispatch that never reached the host must never look like
 * one that did, so nothing here collapses an upstream error into a 500.
 */

import { hostPath } from '../utils/hostPaths.js';
import { Router } from 'express';
import { existsSync, createReadStream, statSync } from 'fs';
import * as path from 'path';
import { authenticate } from '../middleware/authenticate.js';
import { requireInstanceAdmin } from '../middleware/instanceAdmin.js';

const router = Router();

// Same token rule as the collector's devBackupProxy.ARCHIVE_ID_PATTERN, but
// tighter (64, not 128) because this id also becomes a FILENAME under
// BACKUP_ROOT. No '/', no '\', no '..' can survive it — the path containment
// check below is belt to this braces.
const ARCHIVE_ID_PATTERN = /^[0-9A-Za-z._-]{1,64}$/;

const BACKUP_MODES = Object.freeze(['full', 'quick']);

// Short by design: these are control-plane calls (sign + deliver + parse),
// not the backup itself. The backup runs asynchronously on the host; we only
// ever wait for the dispatch acknowledgement.
const COLLECTOR_TIMEOUT_MS = 20000;

// Read per-request, NOT at module load: a test (and a live config change)
// must be able to point this at a different root without a restart. The org
// lane (backups.js:47) freezes it at import time; that is a deliberate
// difference, not an oversight.
function backupRoot() {
    return process.env.BACKUP_ROOT || hostPath('backups');
}

function collectorBaseUrl() {
    return process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
}

function runnerHostId() {
    const raw = process.env.BACKUP_RUNNER_HOST;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * Write the 503 for an unconfigured runner and return true, or return false.
 * Names the exact env var and where the answer lives: an operator who hits
 * this should not have to grep for the knob.
 */
function refuseUnconfigured(res) {
    if (runnerHostId()) return false;
    res.status(503).json({
        error: 'backup_runner_not_configured',
        message: 'Server-wide backups run through the governed host-side runner, and no runner host is configured on this instance. '
            + 'Set BACKUP_RUNNER_HOST to the host_id of a registered dev server whose verified profile enables dev.backup '
            + '(and dev.restore, for restores). See docs/RESTORE_RUNBOOK.md (the disaster-recovery runbook) for the full procedure.',
    });
    return true;
}

/**
 * One call to the collector's dev-backup control plane.
 *
 * Returns { ok, status, data } and NEVER throws for an HTTP-level failure —
 * the caller decides how to surface it, because "the runner refused" and
 * "the collector is unreachable" are different facts and the operator needs
 * to be told which one happened. A transport failure comes back as
 * status 502 with a body naming the URL that failed.
 *
 * The fetch implementation is injectable via app.locals.backupRunnerFetch —
 * the same test-seam convention as app.locals.qlusterBackupRunner in
 * routes/internal-backups.js — so tests never open a socket.
 */
export async function callRunner(req, { method, path: subPath, body }) {
    const fetchImpl = req.app?.locals?.backupRunnerFetch || fetch;
    const hostId = runnerHostId();
    const url = `${collectorBaseUrl()}/api/v1/dev-backup/${encodeURIComponent(hostId)}${subPath}`;
    const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COLLECTOR_TIMEOUT_MS);
    try {
        const res = await fetchImpl(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Service-Key': serviceKey,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        return { ok: res.ok, status: res.status, data };
    } catch (err) {
        return {
            ok: false,
            status: 502,
            transport: true,
            data: {
                error: 'backup_runner_unreachable',
                message: `Could not reach the backup control plane at ${url}: ${err && err.message ? err.message : String(err)}`,
            },
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Collector receipts (durable outcomes), not the live runner. Separate call,
 * separate failure mode: an operator must be able to tell "no receipts yet"
 * from "I could not read the receipts".
 */
async function callCollectorJson(req, subPath) {
    const fetchImpl = req.app?.locals?.backupRunnerFetch || fetch;
    const url = `${collectorBaseUrl()}${subPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COLLECTOR_TIMEOUT_MS);
    try {
        const res = await fetchImpl(url, {
            method: 'GET',
            headers: { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '' },
            signal: controller.signal,
        });
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        return { ok: res.ok, status: res.status, data };
    } catch (err) {
        return {
            ok: false,
            status: 502,
            transport: true,
            data: {
                error: 'collector_unreachable',
                message: `Could not reach ${url}: ${err && err.message ? err.message : String(err)}`,
            },
        };
    } finally {
        clearTimeout(timer);
    }
}

// Pass an upstream refusal through with its own status and message. 4xx/5xx
// keep their meaning; only a status express cannot send is normalised.
function passThrough(res, result, fallbackError) {
    const status = Number.isInteger(result.status) && result.status >= 400 && result.status <= 599
        ? result.status
        : 502;
    const data = result.data && typeof result.data === 'object' ? result.data : {};
    return res.status(status).json({
        error: data.error || fallbackError,
        message: data.message || data.error || `Backup control plane returned ${result.status}`,
        upstream_status: result.status,
    });
}

// ── Layers 3 and 4: authenticated, and an instance admin at minimum ─────────
router.use(authenticate());
router.use(requireInstanceAdmin('readonly'));

/**
 * GET /api/admin/backups — the archives the runner host has registered.
 * Guard: authenticate → instance admin (readonly) → runner configured.
 */
router.get('/', async (req, res) => {
    if (refuseUnconfigured(res)) return;
    const result = await callRunner(req, { method: 'GET', path: '/archives' });
    if (!result.ok) return passThrough(res, result, 'backup_archives_failed');
    return res.json({
        runner_host: runnerHostId(),
        archives: (result.data && result.data.archives) || [],
        ...(result.data && typeof result.data === 'object' ? { host_id: result.data.host_id } : {}),
    });
});

/**
 * GET /api/admin/backups/status — live runner state PLUS the durable receipts.
 * Guard: authenticate → instance admin (readonly) → runner configured.
 *
 * Two different facts, reported separately and never merged: the runner says
 * what is happening NOW, the receipts say what has actually completed. A 200
 * here means the live read succeeded; when it did not, the upstream status is
 * passed through and the receipts we DID manage to read ride along in the
 * body, clearly labelled, rather than being dropped or dressed up as success.
 */
router.get('/status', async (req, res) => {
    if (refuseUnconfigured(res)) return;
    const [runner, receipts] = await Promise.all([
        callRunner(req, { method: 'GET', path: '/status' }),
        callCollectorJson(req, '/api/v1/backup-status'),
    ]);

    const receiptsPart = receipts.ok
        ? { receipts: (receipts.data && receipts.data.hosts) || [], receipts_error: null }
        : { receipts: null, receipts_error: (receipts.data && receipts.data.message) || `backup-status returned ${receipts.status}` };

    if (!runner.ok) {
        const data = runner.data && typeof runner.data === 'object' ? runner.data : {};
        const status = Number.isInteger(runner.status) && runner.status >= 400 && runner.status <= 599 ? runner.status : 502;
        return res.status(status).json({
            error: data.error || 'backup_runner_status_failed',
            message: data.message || data.error || `Backup control plane returned ${runner.status}`,
            upstream_status: runner.status,
            runner_host: runnerHostId(),
            runner: null,
            ...receiptsPart,
        });
    }

    return res.json({
        runner_host: runnerHostId(),
        runner: runner.data || {},
        ...receiptsPart,
    });
});

/**
 * GET /api/admin/backups/restore-status — live restore-engine state PLUS the
 * durable restore receipts. Same two-facts rule as /status above.
 * Guard: authenticate → instance admin (readonly) → runner configured.
 */
router.get('/restore-status', async (req, res) => {
    if (refuseUnconfigured(res)) return;
    const [runner, receipts] = await Promise.all([
        callRunner(req, { method: 'GET', path: '/restore-status' }),
        callCollectorJson(req, '/api/v1/backup-receipts?kind=restore&limit=10'),
    ]);

    const receiptsPart = receipts.ok
        ? { receipts: (receipts.data && receipts.data.receipts) || [], receipts_error: null }
        : { receipts: null, receipts_error: (receipts.data && receipts.data.message) || `backup-receipts returned ${receipts.status}` };

    if (!runner.ok) {
        const data = runner.data && typeof runner.data === 'object' ? runner.data : {};
        const status = Number.isInteger(runner.status) && runner.status >= 400 && runner.status <= 599 ? runner.status : 502;
        return res.status(status).json({
            error: data.error || 'restore_status_failed',
            message: data.message || data.error || `Backup control plane returned ${runner.status}`,
            upstream_status: runner.status,
            runner_host: runnerHostId(),
            runner: null,
            ...receiptsPart,
        });
    }

    return res.json({
        runner_host: runnerHostId(),
        runner: runner.data || {},
        ...receiptsPart,
    });
});

/**
 * POST /api/admin/backups { mode?: 'full' | 'quick' } — dispatch a server-wide
 * backup on the runner host.
 * Guard: authenticate → instance admin ('admin') → runner configured → mode enum.
 *
 * A 200 here means QUEUED, not backed up. The response says so in words,
 * because "the API returned 200" has been mistaken for "the backup exists"
 * more than once.
 */
router.post('/', requireInstanceAdmin('admin'), async (req, res) => {
    if (refuseUnconfigured(res)) return;
    const body = req.body || {};
    const mode = body.mode;
    if (mode !== undefined && mode !== null && !BACKUP_MODES.includes(mode)) {
        return res.status(400).json({
            error: 'invalid_mode',
            message: `mode must be one of: ${BACKUP_MODES.join(', ')}`,
        });
    }

    // Only forward mode when the caller actually asserted one — the engine
    // owns the default, and asserting one here would silently override a
    // host-side policy change.
    const payload = {};
    if (mode) payload.mode = mode;

    const result = await callRunner(req, { method: 'POST', path: '/dispatch', body: payload });
    if (!result.ok) return passThrough(res, result, 'backup_dispatch_failed');

    return res.json({
        dispatched: true,
        runner_host: runnerHostId(),
        mode: mode || null,
        note: 'Queued on the runner host. This is an acknowledgement of dispatch, NOT a completed backup: '
            + 'poll GET /api/admin/backups/status and check the receipt before treating the backup as real.',
        runner: result.data || {},
    });
});

/**
 * Resolve an archive id to an absolute path strictly inside BACKUP_ROOT.
 * Returns { error, message } on refusal, or { fileName, absPath, bareId }.
 *
 * A bare id (the engine's run timestamp, e.g. 20260917_020000) resolves to
 * <BACKUP_ROOT>/<id>.tar.gz. An id that already ends .tar.gz is used as-is.
 * path.resolve + a prefix check is the containment: even though the id
 * pattern above admits no separator, the check stands on its own so a future
 * loosening of the pattern cannot silently open a traversal.
 */
function resolveArchivePath(archiveId) {
    if (typeof archiveId !== 'string' || !ARCHIVE_ID_PATTERN.test(archiveId)) {
        return { error: 'invalid_archive_id', message: 'archiveId must be 1-64 chars of [0-9A-Za-z._-]' };
    }
    const fileName = archiveId.endsWith('.tar.gz') ? archiveId : `${archiveId}.tar.gz`;
    const bareId = fileName.replace(/\.tar\.gz$/, '');
    const root = path.resolve(backupRoot());
    const absPath = path.resolve(root, fileName);
    if (absPath !== root && !absPath.startsWith(root + path.sep)) {
        return { error: 'archive_outside_backup_root', message: 'Refused: the resolved archive path is outside BACKUP_ROOT.' };
    }
    return { fileName, absPath, bareId };
}

// Does the runner's archives list contain this archive? Matched on the id the
// host registered, or on the basename of the path it registered.
function archiveIsRegistered(archives, bareId, fileName) {
    if (!Array.isArray(archives)) return false;
    return archives.some((a) => {
        if (!a || typeof a !== 'object') return false;
        if (typeof a.id === 'string' && (a.id === bareId || a.id === fileName)) return true;
        if (typeof a.path === 'string' && path.basename(a.path) === fileName) return true;
        return false;
    });
}

/**
 * GET /api/admin/backups/:archiveId/download — stream the archive from the
 * LOCAL archive mount (BACKUP_ROOT).
 * Guard: authenticate → instance admin ('admin') → runner configured →
 *        archive id pattern → BACKUP_ROOT containment → registered with the
 *        runner → file exists.
 *
 * The registration check is defence in depth, and it fails CLOSED: if the
 * runner cannot be reached we answer 502 rather than serving a file we could
 * not confirm the host ever produced. Serving an unverified blob from a
 * writable directory under the name "your backup" is exactly the kind of
 * quiet lie this codebase refuses.
 */
router.get('/:archiveId/download', requireInstanceAdmin('admin'), async (req, res) => {
    if (refuseUnconfigured(res)) return;

    const resolved = resolveArchivePath(req.params.archiveId);
    if (resolved.error) {
        return res.status(400).json({ error: resolved.error, message: resolved.message });
    }

    const listing = await callRunner(req, { method: 'GET', path: '/archives' });
    if (!listing.ok) {
        const data = listing.data && typeof listing.data === 'object' ? listing.data : {};
        return res.status(502).json({
            error: 'archive_registration_unverifiable',
            message: `Refusing to serve ${resolved.fileName}: the runner's archive list could not be read, so this file cannot be confirmed as an archive the host produced. `
                + (data.message || data.error || `Backup control plane returned ${listing.status}`),
            upstream_status: listing.status,
        });
    }
    const archives = (listing.data && listing.data.archives) || [];
    if (!archiveIsRegistered(archives, resolved.bareId, resolved.fileName)) {
        return res.status(404).json({
            error: 'archive_not_registered',
            message: `${resolved.bareId} is not an archive registered by ${runnerHostId()}. Only archives the host itself produced can be downloaded.`,
        });
    }

    if (!existsSync(resolved.absPath)) {
        return res.status(404).json({
            error: 'archive_not_found',
            message: `${resolved.fileName} is registered by the runner but is not present under BACKUP_ROOT (${backupRoot()}) on this node. `
                + 'On a baked deployment, check that the archive directory is mounted into the auth container.',
        });
    }

    // Same headers + stream-error handling as the internal download route
    // (routes/internal-backups.js:509) — one download contract, two lanes.
    let size = null;
    try { size = statSync(resolved.absPath).size; } catch { /* fall through without Content-Length */ }
    if (size != null) res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${resolved.fileName}"`);

    const stream = createReadStream(resolved.absPath);
    stream.on('error', (err) => {
        console.error('[admin-backups] download stream error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'stream_error', message: err.message });
        else try { res.end(); } catch { /* ignore */ }
    });
    stream.pipe(res);
});

/**
 * POST /api/admin/backups/:archiveId/restore { dry_run?, stores?, confirm? }
 * Guard: authenticate → instance admin ('superadmin') → runner configured →
 *        archive id pattern → boolean-only dry_run → literal confirm token
 *        for a live restore.
 *
 * dry_run is NEVER invented. Absent stays absent so the agent's own
 * dry-run-default (true) rules, exactly as the collector's restore handler
 * documents. A live restore therefore requires TWO explicit assertions from
 * the caller: dry_run === false AND confirm === 'RESTORE'. This is the most
 * destructive verb in the product; one fat-fingered flag must not be enough.
 */
router.post('/:archiveId/restore', requireInstanceAdmin('superadmin'), async (req, res) => {
    if (refuseUnconfigured(res)) return;

    const resolved = resolveArchivePath(req.params.archiveId);
    if (resolved.error) {
        return res.status(400).json({ error: resolved.error, message: resolved.message });
    }

    const body = req.body || {};
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') {
        return res.status(400).json({
            error: 'invalid_dry_run',
            message: 'dry_run must be a boolean when supplied. A string "false" is refused rather than coerced, because '
                + 'a quoted flag quietly becoming a real restore is precisely the accident this rejects.',
        });
    }
    if (body.dry_run === false && body.confirm !== 'RESTORE') {
        return res.status(400).json({
            error: 'restore_confirmation_required',
            message: 'A live restore (dry_run: false) overwrites this instance\'s data for EVERY org from the archive. '
                + 'Re-send with "confirm": "RESTORE" (exact string) to proceed, or omit dry_run to run a dry-run instead.',
        });
    }

    let stores;
    if (body.stores !== undefined) {
        if (!Array.isArray(body.stores) || body.stores.length === 0) {
            return res.status(400).json({
                error: 'invalid_stores',
                message: 'stores must be a non-empty array of store names when supplied.',
            });
        }
        stores = body.stores.map((s) => (typeof s === 'string' ? s.trim() : ''));
        if (!stores.every((s) => ARCHIVE_ID_PATTERN.test(s))) {
            return res.status(400).json({
                error: 'invalid_stores',
                message: 'each store name must be 1-64 chars of [0-9A-Za-z._-]',
            });
        }
    }

    const payload = { archive_id: resolved.bareId };
    if (body.dry_run !== undefined) payload.dry_run = body.dry_run;
    if (stores) payload.stores = stores;

    const result = await callRunner(req, { method: 'POST', path: '/restore', body: payload });
    if (!result.ok) return passThrough(res, result, 'restore_dispatch_failed');

    return res.json({
        dispatched: true,
        runner_host: runnerHostId(),
        archive_id: resolved.bareId,
        // Reported exactly as sent, including absent — the response must not
        // claim a posture the caller never asserted.
        dry_run: payload.dry_run === undefined ? null : payload.dry_run,
        stores: payload.stores || null,
        note: 'Dispatched to the runner host. Poll GET /api/admin/backups/restore-status for the outcome.',
        runner: result.data || {},
    });
});

export default router;
