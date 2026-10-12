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
