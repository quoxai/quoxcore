import { existsSync } from 'fs';

/** Mirrors RETENTION_DAYS=30 in scripts/backup-quox.sh, which deletes archives older than this. */
export const BACKUP_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Age in ms of a backup row (sqlite UTC 'YYYY-MM-DD HH:MM:SS' or ISO); NaN when no timestamp. */
export function backupAgeMs(row, now = Date.now()) {
  const t = row?.created_at || row?.completed_at;
  if (!t) return NaN;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : String(t).replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? NaN : now - ms;
}

/** True when the archive is gone AND the backup is past the retention window (pruned on purpose, not lost). */
export function isRetentionExpired(row, { exists = existsSync, now = Date.now() } = {}) {
  if (!row?.archive_path) return false;
  const age = backupAgeMs(row, now);
  if (!(age > BACKUP_RETENTION_DAYS * DAY_MS)) return false;
  return !exists(row.archive_path);
}

/**
 * quox#1205: the user-facing verify state of a backup row, derived from status plus
 * verification_json. A completed row that nobody verified reads 'never_verified'.
 */
export function verifyState(row, opts = {}) {
  const status = row?.status;
  if (status === 'verifying') return 'verifying';
  if (status === 'failed') return 'failed';
  let v = row?.verification;
  if (v === undefined && row?.verification_json) {
    try { v = JSON.parse(row.verification_json); } catch { v = null; }
  }
  if (status === 'verified') return 'verified';
  // Retention pruned the archive (backup-quox.sh): not a loss, and not "never verified" either.
  // A missing archive inside the window is NOT expired and stays loud via the normal paths.
  if ((status === 'completed' || status === 'degraded') && isRetentionExpired(row, opts)) return 'expired';
  if (v && typeof v === 'object') {
    if (v.valid === null) return 'unverifiable';
    if (v.valid === true && v.complete === false) return 'degraded';
  }
  if (status === 'degraded') return 'degraded';
  return 'never_verified';
}
