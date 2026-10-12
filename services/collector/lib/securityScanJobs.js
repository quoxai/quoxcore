'use strict';

/**
 * QUOX-SECURITY Phase 1 (continued): async scan job storage. Backs the
 * async job model for capability tools that can outrun a single blocking
 * HTTP request (found live 2026-08-10/11: a real sectest_vuln_scan/nuclei
 * default-template run against even one target takes longer than
 * defaultCallBastion's 30s budget). Pure CRUD + status transitions here;
 * the actual command execution and background scheduling lives in
 * executeSecurityCapabilityToolAsync (securityCapabilityTools.js), same
 * storage/execution split as securityFindings.js vs its callers.
 */

const { generateUlid } = require('./imageStore.js');
const securityEngagement = require('./securityEngagement.js');

const STATUSES = ['queued', 'running', 'succeeded', 'failed'];

function parseRow(row) {
  if (!row) return null;
  return { ...row };
}

/**
 * @param {{engagement_id:string, org_id:string, tool:string, target:string, created_by?:string, schedule_id?:string}} input
 * @param {object} deps - { db }
 */
function createJob(input, deps) {
  const { db } = deps;
  const { engagement_id, org_id, tool, target, created_by, schedule_id } = input || {};

  if (!org_id) throw new Error('org_id is required');
  const engagement = securityEngagement.getEngagement(engagement_id, org_id, { db });
  if (!engagement) throw new Error(`Engagement "${engagement_id}" not found or not authorized for org "${org_id}"`);
  if (!tool) throw new Error('tool is required');
  if (!target) throw new Error('target is required');

  const id = `JOB_${generateUlid()}`;
  db.prepare(`
    INSERT INTO security_scan_jobs (id, engagement_id, org_id, tool, target, status, created_by, schedule_id)
    VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
  `).run(id, engagement_id, org_id, tool, target, created_by || null, schedule_id || null);

  return getJob(id, org_id, deps);
}

function getJob(id, orgId, deps) {
  const row = deps.db.prepare('SELECT * FROM security_scan_jobs WHERE id = ? AND org_id = ?').get(id, orgId);
  return parseRow(row);
}

function listJobs(engagementId, orgId, deps) {
  const rows = deps.db.prepare(
    'SELECT * FROM security_scan_jobs WHERE engagement_id = ? AND org_id = ? ORDER BY created_at DESC, rowid DESC'
  ).all(engagementId, orgId);
  return rows.map(parseRow);
}

/** @param {object} deps - { db } (no orgId check: only ever called internally by the execution path that already holds the row) */
function markRunning(id, deps) {
  deps.db.prepare(`
    UPDATE security_scan_jobs SET status = 'running', started_at = datetime('now') WHERE id = ?
  `).run(id);
  return parseRow(deps.db.prepare('SELECT * FROM security_scan_jobs WHERE id = ?').get(id));
}

function markSucceeded(id, result, deps) {
  deps.db.prepare(`
    UPDATE security_scan_jobs SET status = 'succeeded', result_json = ?, finished_at = datetime('now') WHERE id = ?
  `).run(JSON.stringify(result), id);
  return parseRow(deps.db.prepare('SELECT * FROM security_scan_jobs WHERE id = ?').get(id));
}

function markFailed(id, error, deps) {
  deps.db.prepare(`
    UPDATE security_scan_jobs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?
  `).run(String(error), id);
  return parseRow(deps.db.prepare('SELECT * FROM security_scan_jobs WHERE id = ?').get(id));
}

/**
 * QUOX-SECURITY-SCHED Phase 3: the diff baseline lookup. Finds the most
 * recent SUCCEEDED job that this schedule fired, strictly before the given
 * timestamp (normally the current job's created_at), so a diff always
 * compares against the schedule's actual prior run rather than any job
 * that happens to share its schedule_id. Returns null when there is no such
 * job (first run, or every prior run for this schedule failed) — callers
 * treat null as "no baseline" (see securityScanDiff.diffScanResults).
 *
 * Not org-scoped, matching listDueSchedules's internal-scheduler-only
 * convention (securityEngagementSchedules.js) — this is only ever called
 * from the background job-completion hook, which already holds the row.
 *
 * @param {string} scheduleId
 * @param {string} beforeCreatedAt - ISO-ish timestamp; strictly less-than
 * @param {object} deps - { db }
 */
function getPreviousSucceededJobForSchedule(scheduleId, beforeCreatedAt, deps) {
  const row = deps.db.prepare(`
    SELECT * FROM security_scan_jobs
    WHERE schedule_id = ? AND status = 'succeeded' AND created_at < ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(scheduleId, beforeCreatedAt);
  return parseRow(row);
}

module.exports = {
  STATUSES,
  createJob,
  getJob,
  listJobs,
  markRunning,
  markSucceeded,
  markFailed,
  getPreviousSucceededJobForSchedule,
};
