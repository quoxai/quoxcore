/**
 * quox#1205: one place that maps a verify outcome to a backups.status, shared by every
 * verify path (org route and internal route both run verifyBackupIntegrity) and the
 * boot/timeout reconcile. A hash MISMATCH is 'failed' ('failed' is already in the
 * backups CHECK enum and understood by the UI, CLI and keeper tools; there is no 'corrupt').
 * No manifest hash means we cannot say anything: the prior status is kept, never upgraded.
 */

export function shortHash(h) {
  return String(h || '').replace(/^sha256:/, '').slice(0, 12);
}

export function integrityFailedMessage(expected, actual) {
  return `INTEGRITY FAILED: archive hash does not match its manifest (expected ${shortHash(expected)}, got ${shortHash(actual)})`;
}

/**
 * @param {{hashValid: boolean, hasManifestHash: boolean, complete: boolean, priorStatus?: string}} p
 * @returns {string} next backups.status
 */
export function verifiedStatus({ hashValid, hasManifestHash, complete, priorStatus }) {
  if (hasManifestHash && !hashValid) return 'failed';
  if (!complete) return 'degraded';
  if (!hasManifestHash) {
    // Cannot verify: keep what we had. 'verified'/'verifying' are not a safe prior.
    return priorStatus && !['verified', 'verifying', 'pending', 'running'].includes(priorStatus) ? priorStatus : 'completed';
  }
  return 'verified';
}
