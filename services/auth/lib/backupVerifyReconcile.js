/**
 * quox#1205: a verify sets backups.status='verifying' and runs in-process. If auth
 * restarts (or the verifier hangs) the row would stay 'verifying' forever. This
 * restores the status the last STORED verification result supports. It never
 * writes 'verified' without a stored valid + complete result.
 */

// A verify running longer than this is treated as orphaned. Constant on purpose (no env var).
export const VERIFY_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const VERIFY_INTERRUPTED_MESSAGE = 'verification interrupted (auth restarted); run verify again';

function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// SQLite datetime('now') is UTC without a zone marker.
function parseUpdatedAtMs(value) {
  if (!value) return NaN;
  const s = String(value);
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}

/**
 * @param {object} db better-sqlite3 handle
 * @param {{now?: number, staleAfterMs?: number}} opts staleAfterMs 0 = every 'verifying' row
 * @returns {string[]} reconciled backup ids
 */
export function reconcileInterruptedVerifies(db, { now = Date.now(), staleAfterMs = 0 } = {}) {
  const rows = db.prepare(`SELECT id, updated_at, verification_json, manifest_json, error_message FROM backups WHERE status = 'verifying'`).all();
  const reconciled = [];
  for (const row of rows) {
    if (staleAfterMs > 0) {
      const since = parseUpdatedAtMs(row.updated_at);
      // Unknown start time: cannot prove it is stale, leave it for a later tick.
      if (!Number.isFinite(since) || now - since < staleAfterMs) continue;
    }
    const v = parseJson(row.verification_json);
    // A degraded marker (manifest.degraded, or an INCOMPLETE error_message) means required
    // components are missing: a reconcile must never upgrade such a backup to 'completed'.
    const degradedMarker = parseJson(row.manifest_json)?.degraded === true
      || String(row.error_message || '').startsWith('INCOMPLETE');
    let status;
    let message = null;
    if (v && typeof v === 'object' && 'valid' in v) {
      if (v.valid === false && v.integrityFailed === true) status = 'failed'; // hash mismatch: never 'completed'
      else if (v.valid === true && v.complete === true) status = 'verified';
      else if (v.valid === true && v.complete === false) status = 'degraded';
      else status = degradedMarker ? 'degraded' : 'completed';
    } else if (degradedMarker) {
      status = 'degraded'; // keep the existing error_message
    } else {
      status = 'completed';
      message = VERIFY_INTERRUPTED_MESSAGE;
    }
    const res = message
      ? db.prepare(`UPDATE backups SET status = ?, error_message = ?, updated_at = datetime('now') WHERE id = ? AND status = 'verifying'`).run(status, message, row.id)
      : db.prepare(`UPDATE backups SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'verifying'`).run(status, row.id);
    if (res.changes > 0) reconciled.push(row.id);
  }
  return reconciled;
}
