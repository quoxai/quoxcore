/**
 * quox#1205: every new scheduled backup verifies itself once written. Driven by the
 * existing scheduler tick (no timer of its own). Triad: failure accounting distinct from
 * no-work, capped exponential backoff per backup, durable retirement after MAX_ATTEMPTS.
 */

import { existsSync } from 'fs';
import { isRetentionExpired, BACKUP_RETENTION_DAYS } from './backupVerifyState.js';

// The nightly PBS backup stalls the box about 05:50-08:00 UTC; stay clear of it. Constants, no env.
export const PBS_WINDOW_UTC = { startMin: 5 * 60 + 30, endMin: 8 * 60 + 30 };
export const BACKOFF_BASE_MS = 10 * 60 * 1000;
export const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;
export const MAX_ATTEMPTS = 5;

export function inPbsWindow(now = Date.now()) {
  const d = new Date(now);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= PBS_WINDOW_UTC.startMin && m < PBS_WINDOW_UTC.endMin;
}

export function backoffMs(attempts) {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
}

const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// A new job is due at once. next_at is set to the epoch, not datetime('now'): the tick compares next_at
// with its own `now`, so a wall-clock default made a fresh job "not due yet" for any tick whose now ran
// behind the database clock (an injected now in a test, or a skewed clock).
const DUE_AT_ONCE = '1970-01-01 00:00:00';
export function enqueueSelfVerify(db, backupId, orgId) {
  db.prepare(`INSERT OR IGNORE INTO backup_self_verify (backup_id, org_id, next_at) VALUES (?, ?, ?)`).run(backupId, orgId, DUE_AT_ONCE);
}

let busy = false;
/**
 * The newest completed or degraded backup of each org that has never been verified and has no
 * self-verify job yet gets one. Covers a backup written before self-verify shipped, or one whose
 * enqueue was lost, so the latest backup always reaches a known state. Older unverified backups are
 * left alone (they read never_verified); this never mass-verifies history. Returns the ids enqueued.
 */
export function enqueueLatestUnverified(db, { exists = existsSync, now = Date.now() } = {}) {
  const rows = db.prepare(`
    SELECT b.id, b.org_id, b.archive_path, b.created_at FROM backups b
    WHERE b.status IN ('completed', 'degraded')
      AND (b.verification_json IS NULL OR b.verification_json = '')
      AND b.created_at = (SELECT MAX(x.created_at) FROM backups x WHERE x.org_id = b.org_id AND x.status IN ('completed', 'degraded', 'verified', 'failed', 'verifying'))
      AND NOT EXISTS (SELECT 1 FROM backup_self_verify s WHERE s.backup_id = b.id)
  `).all();
  const out = [];
  for (const r of rows) {
    if (isRetentionExpired(r, { exists, now })) continue; // pruned by retention, nothing left to verify
    enqueueSelfVerify(db, r.id, r.org_id);
    out.push(r.id);
  }
  return out;
}

let enqueueErrors = 0;

/** Enqueue; a failure is counted (reported in the next tick line) and handed to onFail, never swallowed. */
export function tryEnqueueSelfVerify(db, backupId, orgId, onFail) {
  try { enqueueSelfVerify(db, backupId, orgId); return true; }
  catch (err) {
    enqueueErrors++;
    console.error(`[BackupSelfVerify] enqueue failed for ${backupId}: ${err.message}`);
    if (onFail) onFail(err);
    return false;
  }
}

/**
 * @returns {{ran:number, errors:number, deferred:number, retired:number, enqueue_errors:number, idle:boolean}}
 * `errors` counts failed verifies; `idle` means there was simply no work (never conflated).
 */
export async function runSelfVerifyTick(db, { now = Date.now(), verifier, notify, exists = existsSync } = {}) {
  const out = { ran: 0, errors: 0, deferred: 0, retired: 0, idle: false };
  if (enqueueErrors > 0) out.enqueue_errors = enqueueErrors; // omitted when zero
  enqueueErrors = 0;
  if (busy) return out;
  const due = db.prepare(`SELECT * FROM backup_self_verify WHERE state = 'pending' AND next_at <= ? ORDER BY next_at`).all(sqlTime(now));
  if (due.length === 0) { out.idle = !out.enqueue_errors; return out; }
  if (inPbsWindow(now)) { out.deferred = due.length; return out; }
  if (db.prepare(`SELECT 1 FROM backups WHERE status = 'verifying' LIMIT 1`).get()) { out.deferred = due.length; return out; }
  busy = true;
  try {
    for (const job of due) {
      const b = db.prepare(`SELECT * FROM backups WHERE id = ?`).get(job.backup_id);
      if (!b || !['completed', 'degraded'].includes(b.status)) {
        db.prepare(`UPDATE backup_self_verify SET state = 'done', updated_at = datetime('now') WHERE backup_id = ?`).run(job.backup_id);
        continue;
      }
      if (isRetentionExpired(b, { exists, now })) {
        // Already-queued job whose archive retention pruned: retire without even trying the verifier.
        db.prepare(`UPDATE backup_self_verify SET state = 'expired', last_error = 'archive pruned by retention', updated_at = datetime('now') WHERE backup_id = ?`).run(b.id);
        out.expired = (out.expired || 0) + 1;
        console.log(`[BackupSelfVerify] ${b.id} retired as expired: archive ${b.archive_path} was pruned by retention (older than ${BACKUP_RETENTION_DAYS}d), no incident`);
        continue;
      }
      db.prepare(`UPDATE backups SET status = 'verifying', updated_at = datetime('now') WHERE id = ?`).run(b.id);
      let err = null;
      try {
        let manifest = null;
        try { manifest = b.manifest_json ? JSON.parse(b.manifest_json) : null; } catch { /* keep null */ }
        await verifier(b.id, b.org_id, b.archive_path, manifest, 'system:self-verify', null);
        const after = db.prepare(`SELECT verification_json FROM backups WHERE id = ?`).get(b.id);
        let v = null;
        try { v = JSON.parse(after?.verification_json); } catch { /* none */ }
        if (!v || (v.error && !v.verifiedAt)) err = (v && v.error) || 'verifier wrote no result';
      } catch (e) { err = e.message || String(e); }
      out.ran++;
      if (err && (/ENOENT/.test(err) || (b.archive_path && !exists(b.archive_path))) && isRetentionExpired(b, { exists, now })) {
        // Retention pruned the archive: retire quietly, no incident, no error count. Inside retention it stays loud.
        db.prepare(`UPDATE backups SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'verifying'`).run(b.status, b.id);
        db.prepare(`UPDATE backup_self_verify SET state = 'expired', last_error = ?, updated_at = datetime('now') WHERE backup_id = ?`).run(`archive pruned by retention: ${err}`, b.id);
        out.expired = (out.expired || 0) + 1;
        console.log(`[BackupSelfVerify] ${b.id} retired as expired: archive ${b.archive_path} was pruned by retention (older than ${BACKUP_RETENTION_DAYS}d), no incident`);
        continue;
      }
      if (!err) {
        db.prepare(`UPDATE backup_self_verify SET state = 'done', attempts = attempts + 1, last_error = NULL, updated_at = datetime('now') WHERE backup_id = ?`).run(b.id);
        continue;
      }
      out.errors++;
      // A crashed verifier must not leave the row 'verifying'.
      db.prepare(`UPDATE backups SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'verifying'`).run(b.status, b.id);
      const attempts = job.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        const msg = `self-verify gave up after ${attempts} attempts: ${err}`;
        db.prepare(`UPDATE backup_self_verify SET state = 'gave_up', attempts = ?, last_error = ?, updated_at = datetime('now') WHERE backup_id = ?`).run(attempts, err, b.id);
        db.prepare(`UPDATE backups SET error_message = ?, updated_at = datetime('now') WHERE id = ?`).run(msg, b.id);
        out.retired++;
        if (notify) notify(b.org_id, b.name || b.id, b.id, false, { error: msg });
      } else {
        db.prepare(`UPDATE backup_self_verify SET attempts = ?, last_error = ?, next_at = ?, updated_at = datetime('now') WHERE backup_id = ?`)
          .run(attempts, err, sqlTime(now + backoffMs(attempts)), b.id);
      }
    }
  } finally { busy = false; }
  return out;
}
