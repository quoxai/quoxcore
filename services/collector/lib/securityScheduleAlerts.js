'use strict';

const { mintInboxItem } = require('./inboxMint.js');

/**
 * QUOX-SECURITY-SCHED Phase 3: HITL alert on new high/critical findings from
 * a scheduled scan. Reuses the SAME internal auth inbox mint used by
 * approvalGate.js's createApprovalRequest (POST
 * ${AUTH_SERVICE_URL}/api/internal/orgs/:orgId/inbox with an
 * X-Service-Key/x-service-key header) and qlusterDelegate.js's
 * mintPendingAndRespond — the collector's one established
 * "surface something to a human inbox from server-side code" path. Unlike
 * those two callers this alert is informational, not a resolvable approval
 * (nothing here blocks execution pending a human decision), so it mints
 * kind:'incident' rather than kind:'approval' — 'incident' is one of the
 * auth service's ITEM_KINDS (services/auth/routes/inbox.js) and is the
 * closest existing fit for "something happened that a human should look
 * at", not "something is waiting on a human to proceed".
 *
 * Best-effort by design: a mint failure is logged and swallowed, never
 * thrown — this module is always called from a background job-completion
 * hook that must not fail the scan job over a notification failure (see
 * runScheduleDiffAndAlert in securityCapabilityTools.js).
 */

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

/**
 * @param {{schedule: object, diff: {newHighSeverity: Array}, deps?: {fetchImpl?: Function, authBaseUrl?: string, serviceKey?: string}}} args
 * @returns {Promise<{created:boolean, item_id?:string, error?:string}>}
 */
async function alertOnNewFindings({ schedule, diff, deps = {} }) {
  const newHigh = (diff && diff.newHighSeverity) || [];
  if (newHigh.length === 0) return { created: false };

  const fetchImpl = deps.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const authBaseUrl = deps.authBaseUrl || AUTH_SERVICE_URL;
  const serviceKey = deps.serviceKey || INTERNAL_SERVICE_KEY;

  if (!fetchImpl) {
    console.warn('[securityScheduleAlerts] no fetch implementation available, cannot mint inbox alert (non-fatal)');
    return { created: false, error: 'no_fetch_impl' };
  }

  const target = schedule.target_value;
  const items = newHigh.map((f) => `- **${f.severity}** \`${f.label}\``).join('\n');
  const title = `Scheduled scan: ${newHigh.length} new high/critical finding${newHigh.length === 1 ? '' : 's'} on ${target}`;
  const bodyMd = `Schedule \`${schedule.id}\` (${schedule.tool}) against \`${target}\` produced ` +
    `${newHigh.length} new high/critical finding${newHigh.length === 1 ? '' : 's'} not present in the previous successful run:\n\n${items}`;

  // quox#562: mechanics live in lib/inboxMint.js (never throws); this site
  // keeps its injected fetchImpl/serviceKey and its own logging.
  const r = await mintInboxItem({
    orgId: schedule.org_id, title, bodyMd, kind: 'incident', priority: 'high',
    aeeCorrelationId: schedule.last_job_id || schedule.id,
    payload: {
      type: 'security_schedule_new_findings',
      schedule_id: schedule.id,
      tool: schedule.tool,
      target_value: target,
      new_high_severity_count: newHigh.length,
    },
  }, { authBaseUrl, serviceKey, fetchImpl });
  if (!r.ok) {
    console.warn('[securityScheduleAlerts] inbox mint failed (non-fatal):', r.error);
    return { created: false, error: r.error };
  }
  return { created: true, item_id: r.itemId };
}

module.exports = { alertOnNewFindings };
