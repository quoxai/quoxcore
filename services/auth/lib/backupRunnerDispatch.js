/**
 * G2d slice 3 — run a Qluster-triggered backup through the GOVERNED host-side
 * runner instead of spawning the engine inside the auth container.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * routes/internal-backups.js POST /backups/trigger is the collector's Qluster
 * backup lane. It used to hand off to backups.js runBackupProcess(), which
 * spawns scripts/backup-quox.sh INSIDE the auth container. On a baked/public
 * box that script is not in the image (no bind mount of the project dir), so
 * the lane fails honestly but uselessly: the fleet controller can see that a
 * box has no backups and can do nothing about it.
 *
 * On those boxes the engine runs HOST-side, driven by quoxagent's dev.backup
 * executor via the collector's dev-backup control plane. When BACKUP_RUNNER_HOST
 * names such a host, this module dispatches there and then WATCHES for the
 * outcome, so the Qluster lane keeps its existing row lifecycle (running →
 * completed/failed, with a manifest carrying archiveHash) and the controller's
 * verification keeps working unchanged.
 *
 * POLLER DISCIPLINE (the 2026-08-30 CPU incident, in code)
 * ---------------------------------------------------------------------------
 * Every rule that incident produced is implemented here, deliberately:
 *   - Failure accounting is DISTINCT from "no result yet". A poll that got a
 *     clean 200 with no matching receipt is PROGRESS-FREE, not FAILED, and is
 *     logged differently. "0 failed" while the dependency is down is the lie
 *     that hid a 30-hour outage.
 *   - Backoff on consecutive ERRORS: 15s → 30s → 60s, capped.
 *   - Retirement is guaranteed and bounded three ways: the backup timeout, the
 *     consecutive-error ceiling, and a terminal receipt. There is no path that
 *     re-arms forever.
 *   - A throw can never escape a tick. Every tick body is wrapped; the error is
 *     RECORDED (counted and logged), never swallowed into silence.
 *   - The pending timer is cleared on every terminal state, and unref'd so it
 *     can never hold the process open.
 */

import * as path from 'path';

export const RUNNER_POLL_DEFAULTS = Object.freeze({
    // First poll is later than the interval: the engine needs a moment to even
    // start, and an immediate poll is guaranteed-empty noise.
    firstDelayMs: 10_000,
    intervalMs: 15_000,
    // Applied to CONSECUTIVE ERRORS only, never to empty-but-healthy polls.
    errorBackoffMs: Object.freeze([15_000, 30_000, 60_000]),
    maxConsecutiveErrors: 8,
    // How many recent backup receipts to scan per poll.
    receiptLimit: 20,
});

function collectorBaseUrl() {
    return process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
}

function backupRoot() {
    return process.env.BACKUP_ROOT || '/opt/quoxcore/backups';
}

/** The configured runner host_id, or null when this instance has no runner. */
export function runnerHostId() {
    const raw = process.env.BACKUP_RUNNER_HOST;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function normalizeSha(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    return value.trim().replace(/^sha256:/i, '');
}

/** ms-epoch for a receipt/archive timestamp that may be an int or a string. */
function toMillis(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const asNum = Number(value);
        if (Number.isFinite(asNum) && value.trim() !== '') return asNum;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

async function collectorFetch(fetchImpl, url, { method = 'GET', body, timeoutMs = 20_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
        const res = await fetchImpl(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        return { ok: res.ok, status: res.status, data };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Dispatch a backup to the governed runner and watch for its outcome.
 *
 * Fire-and-forget by contract (same as runBackupProcess): the caller has
 * already inserted the 'running' row and answered 201. This function owns the
 * row from that point until it reaches a terminal state, and it ALWAYS reaches
 * one.
 *
 * @param {object} deps
 * @param {object} deps.db          better-sqlite3 handle owning the backups table
 * @param {object} deps.appLocals   req.app.locals (test seams live here)
 * @param {string} deps.backupId
 * @param {string} deps.orgId
 * @param {string} deps.backupType  'full' | 'selective' (mapped to engine modes)
 * @param {number} deps.timeoutMs   overall budget; on expiry the row fails 'runner_timeout'
 * @param {object} [deps.logger]
 * @returns {Promise<{dispatched: boolean, reason?: string}>}
 */
export async function dispatchBackupToRunner({
    db,
    appLocals = {},
    backupId,
    orgId,
    backupType,
    timeoutMs,
    logger = console,
}) {
    const hostId = runnerHostId();
    const fetchImpl = appLocals.backupRunnerFetch || fetch;
    const poll = { ...RUNNER_POLL_DEFAULTS, ...(appLocals.backupRunnerPollConfig || {}) };
    const startedAtMs = Date.now();

    const failRow = (message) => {
        try {
            db.prepare(`
                UPDATE backups
                SET status = 'failed', error_message = ?, duration_ms = ?,
                    completed_at = datetime('now'), updated_at = datetime('now')
                WHERE id = ?
            `).run(String(message).slice(0, 2000), Date.now() - startedAtMs, backupId);
        } catch (err) {
            logger.error('[backup-runner] could not mark backup %s failed: %s', backupId, err.message);
        }
    };

    // ── Dispatch ────────────────────────────────────────────────────────────
    // A dispatch that never reached the host must NEVER look like one that did:
    // the row goes straight to failed with the real upstream reason.
    let dispatchResult;
    try {
        dispatchResult = await collectorFetch(
            fetchImpl,
            `${collectorBaseUrl()}/api/v1/dev-backup/${encodeURIComponent(hostId)}/dispatch`,
            { method: 'POST', body: backupType === 'quick' ? { mode: 'quick' } : { mode: 'full' } },
        );
    } catch (err) {
        const reason = `Backup runner dispatch to ${hostId} failed: ${err && err.message ? err.message : String(err)}`;
        logger.error('[backup-runner] %s', reason);
        failRow(reason);
        return { dispatched: false, reason };
    }

    if (!dispatchResult.ok) {
        const data = dispatchResult.data && typeof dispatchResult.data === 'object' ? dispatchResult.data : {};
        const reason = `Backup runner refused dispatch on ${hostId} (HTTP ${dispatchResult.status}): ${data.message || data.error || 'no detail'}`;
        logger.error('[backup-runner] %s', reason);
        failRow(reason);
        return { dispatched: false, reason };
    }

    const dispatchedAtMs = Date.now();
    logger.log('[backup-runner] backup %s dispatched to %s (org=%s, type=%s)', backupId, hostId, orgId, backupType);

    // ── Watch ───────────────────────────────────────────────────────────────
    let timer = null;
    let consecutiveErrors = 0;
    let settled = false;

    const stop = () => {
        settled = true;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const schedule = (delayMs) => {
        if (settled) return;
        timer = setTimeout(tick, delayMs);
        if (typeof timer.unref === 'function') timer.unref();
    };

    /** A poll that FAILED (transport, non-2xx, or a throw) — counted, backed off. */
    const recordPollError = (reason) => {
        consecutiveErrors += 1;
        logger.error(
            '[backup-runner] poll ERROR %d/%d for backup %s: %s',
            consecutiveErrors, poll.maxConsecutiveErrors, backupId, reason,
        );
        if (consecutiveErrors >= poll.maxConsecutiveErrors) {
            stop();
            failRow(`Backup runner outcome could not be read: ${poll.maxConsecutiveErrors} consecutive poll failures. Last error: ${reason}`);
            return;
        }
        const idx = Math.min(consecutiveErrors - 1, poll.errorBackoffMs.length - 1);
        schedule(poll.errorBackoffMs[idx]);
    };

    const completeRow = async (receipt) => {
        // Prefer the archive the host itself registered; fall back to what the
        // receipt asserted. Either way the manifest carries the EXACT shape
        // backups.js generateManifest() writes, because the Qluster controller
        // verifies manifest_json.archiveHash.
        let archive = null;
        try {
            const listing = await collectorFetch(
                fetchImpl,
                `${collectorBaseUrl()}/api/v1/dev-backup/${encodeURIComponent(hostId)}/archives`,
            );
            if (listing.ok) {
                const archives = (listing.data && listing.data.archives) || [];
                if (receipt.archive_id) {
                    archive = archives.find((a) => a && a.id === receipt.archive_id) || null;
                }
                if (!archive) {
                    const fresh = archives
                        .filter((a) => {
                            const ms = toMillis(a && a.created_at);
                            return ms !== null && ms >= dispatchedAtMs;
                        })
                        .sort((a, b) => toMillis(b.created_at) - toMillis(a.created_at));
                    archive = fresh[0] || null;
                }
            } else {
                logger.warn('[backup-runner] archives list returned %s for backup %s, falling back to the receipt', listing.status, backupId);
            }
        } catch (err) {
            logger.warn('[backup-runner] archives list failed for backup %s (%s), falling back to the receipt', backupId, err.message);
        }

        const archiveId = (archive && archive.id) || receipt.archive_id || null;
        const archivePath = (archive && archive.path)
            || (archiveId ? path.join(backupRoot(), `${archiveId}.tar.gz`) : null);
        const sha = normalizeSha((archive && archive.sha256) || receipt.archive_sha256);
        const sizeBytes = (archive && typeof archive.size_bytes === 'number' ? archive.size_bytes : null)
            ?? (typeof receipt.archive_size_bytes === 'number' ? receipt.archive_size_bytes : null);

        // No hash means no verifiable manifest. Say so in the row rather than
        // writing a manifest that asserts a checksum nobody computed — the
        // controller would "verify" a hash we invented.
        const manifest = sha
            ? {
                archiveHash: `sha256:${sha}`,
                archivePath,
                totalBytes: sizeBytes,
                createdAt: (archive && archive.created_at) || new Date().toISOString(),
                checksumAlgorithm: 'sha256',
            }
            : null;
        const note = manifest
            ? null
            : `Backup completed on ${hostId}, but no archive checksum was reported, so this row carries no verifiable manifest.`;

        try {
            db.prepare(`
                UPDATE backups
                SET status = 'completed', archive_path = ?, archive_size_bytes = ?,
                    manifest_json = ?, duration_ms = ?, error_message = ?,
                    completed_at = datetime('now'), updated_at = datetime('now')
                WHERE id = ?
            `).run(
                archivePath,
                sizeBytes,
                manifest ? JSON.stringify(manifest) : null,
                Date.now() - startedAtMs,
                note,
                backupId,
            );
        } catch (err) {
            logger.error('[backup-runner] could not mark backup %s completed: %s', backupId, err.message);
            return;
        }
        logger.log('[backup-runner] backup %s completed on %s (archive=%s)', backupId, hostId, archiveId || 'unknown');
    };

    async function tick() {
        timer = null;
        if (settled) return;
        try {
            if (Date.now() - dispatchedAtMs > timeoutMs) {
                stop();
                failRow(`runner_timeout: no backup receipt from ${hostId} within ${Math.round(timeoutMs / 1000)}s of dispatch. The run may still be in flight host-side; check \`quox backup server status\`.`);
                return;
            }

            let result;
            try {
                result = await collectorFetch(
                    fetchImpl,
                    `${collectorBaseUrl()}/api/v1/backup-receipts?kind=backup&limit=${poll.receiptLimit}`,
                );
            } catch (err) {
                recordPollError(`backup-receipts unreachable: ${err && err.message ? err.message : String(err)}`);
                return;
            }
            if (!result.ok) {
                recordPollError(`backup-receipts returned HTTP ${result.status}`);
                return;
            }

            const receipts = (result.data && Array.isArray(result.data.receipts)) ? result.data.receipts : [];
            const fresh = receipts.filter((r) => {
                const ms = toMillis(r && r.created_at);
                return ms !== null && ms >= dispatchedAtMs;
            });
            // Prefer a receipt whose host matches the runner; the engine posts
            // its own hostname, which need not equal the registered host_id.
            const receipt = fresh.find((r) => r.host === hostId) || fresh[0] || null;

            if (!receipt) {
                // PROGRESS-FREE, NOT FAILED. Reset the error streak (the
                // dependency is demonstrably healthy) and keep the steady
                // cadence — backoff is for errors only.
                consecutiveErrors = 0;
                logger.log('[backup-runner] backup %s: no receipt yet (dependency healthy)', backupId);
                schedule(poll.intervalMs);
                return;
            }

            stop();
            const outcome = String(receipt.result || '').trim().toLowerCase();
            if (outcome === 'ok' || outcome === 'success' || outcome === 'completed') {
                await completeRow(receipt);
            } else {
                failRow(`Backup runner reported ${receipt.result || 'an unknown result'} on ${hostId}${receipt.message ? `: ${receipt.message}` : ''}`);
                logger.error('[backup-runner] backup %s failed on %s: %s', backupId, hostId, receipt.result);
            }
        } catch (err) {
            // A throw must never escape a tick. Record it like any other poll
            // failure so the streak counter can retire the watcher.
            recordPollError(`unexpected poll exception: ${err && err.message ? err.message : String(err)}`);
        }
    }

    schedule(poll.firstDelayMs);
    return { dispatched: true, hostId, stop };
}

export default { dispatchBackupToRunner, runnerHostId, RUNNER_POLL_DEFAULTS };
