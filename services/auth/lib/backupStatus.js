/**
 * GRIPE-710: backup exit-code to status mapping, shared by routes/backups.js
 * (manual runs) and services/backupScheduler.js (the nightly path).
 *
 * scripts/backup-quox.sh exits:
 *   0  archive built, every REQUIRED component captured     -> 'completed'
 *   2  archive built, but a REQUIRED component was skipped  -> 'degraded'
 *   *  anything else                                        -> 'failed'
 * and on exit 2 prints `DEGRADED: skipped_required=a,b,c` to stdout.
 */
export const EXIT_DEGRADED = 2;

export function classifyBackupExit(code) {
    if (code === 0) return 'completed';
    if (code === EXIT_DEGRADED) return 'degraded';
    return 'failed';
}

export function parseSkippedRequired(stdout) {
    const m = /^DEGRADED: skipped_required=(.*)$/m.exec(String(stdout || ''));
    if (!m) return [];
    return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

export function degradedMessage(skippedRequired) {
    const list = skippedRequired && skippedRequired.length ? skippedRequired.join(', ') : 'unknown';
    return `INCOMPLETE: required components NOT backed up: ${list}`;
}

/** A degraded backup is only ever "valid" for the archive hash, never complete. */
export function isBackupComplete(manifest) {
    return !(manifest && manifest.degraded === true);
}

/**
 * QUOXON-PROOF (quox#823): a run that produced no archive (missing, or 0 bytes) backed
 * nothing up, whatever its exit code. On 2026-10-11 the weekly full found the daily quick
 * holding the lock, backup-quox.sh exited 0 without archiving, and the row read
 * 'completed' with 0 bytes. Callers treat such a run as 'failed' with this message.
 */
export const LOCK_SKIP_MARKER = 'another backup is already running';

export function emptyArchiveMessage(code, stdout, stderr) {
    const out = `${stdout || ''}\n${stderr || ''}`;
    if (out.includes(LOCK_SKIP_MARKER)) {
        return 'SKIPPED: another backup held the lock, so this run backed up nothing (0 bytes). Recorded as failed, not completed.';
    }
    return `NO ARCHIVE: the backup script exited ${code} but produced no archive (0 bytes). Recorded as failed, not completed.`;
}

/** True when a finished run left a real, non-empty archive. */
export function hasArchive(sizeBytes) {
    return Number.isFinite(Number(sizeBytes)) && Number(sizeBytes) > 0;
}
