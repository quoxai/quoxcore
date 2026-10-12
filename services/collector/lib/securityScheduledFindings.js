'use strict';

/**
 * QUOX-SECURITY-SCHED Phase 6: turn a scheduled scan's NEW high/critical diff
 * items into DURABLE security_findings rows AND auto-filed GitHub issues.
 *
 * Before this, a scheduled scan that surfaced a new high/critical only wrote
 * an informational HITL inbox item; the diff findings were ephemeral (they
 * live only inside securityScanDiff's in-memory diff) and a human had to
 * manually re-file them as real findings. This module persists them and files
 * them, so the inbox alert becomes a notification about durable records
 * rather than the only trace of the finding.
 *
 * A diff.newHighSeverity item has shape { key, severity, label, raw } (from
 * securityScanDiff.js) and is NOT a persisted finding. For each one we:
 *  1. DEDUP against an existing still-open finding (same engagement/org,
 *     same target_value, same title) so a recurring schedule does not
 *     re-create the same finding every run.
 *  2. PERSIST it via securityFindings.createFinding (always runs, even when
 *     filing is skipped or fails).
 *  3. AUTO-FILE it as a GitHub issue via securityReportActions.fileGripeForFinding,
 *     wrapped per-finding so a filing failure never loses the persisted
 *     finding or aborts the loop.
 *
 * PRODUCT GAP (owner-owned, deliberately NOT solved here): fileGripeForFinding
 * targets a fixed default repo (quoxai/quox) and resolves the GitHub token via
 * the engagement's OWN org. For a customer-site engagement whose GitHub
 * connector lives in a DIFFERENT org, or whose issues belong in a customer
 * repo, no token/repo will resolve and filing is honestly skipped (the persist
 * step still runs, so the finding is never lost). Per-engagement gripe-repo +
 * connector-org targeting has no config surface yet; building one is out of
 * this file's scope. Skipped filings are surfaced explicitly in the returned
 * `skipped` entries (skippedReason: 'not-configured') so this gap is visible,
 * not silent.
 */

const securityEngagement = require('./securityEngagement.js');
const securityFindings = require('./securityFindings.js');
const securityReportActions = require('./securityReportActions.js');

// A finding title is a plain human label, not free-form scan output. Keep it
// short enough to sit in a GitHub issue title and a findings table cell.
const TITLE_MAX = 160;

function truncate(str, max) {
  const s = String(str == null ? '' : str);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Builds a short, never-empty human description from a diff item. createFinding
 * requires a non-empty description, and the raw scan object is the best source
 * of detail we have for a scheduled (non-conversational) finding.
 */
function buildDescription(item) {
  const severity = item && item.severity ? item.severity : 'unknown';
  const parts = [
    `Automatically raised by a scheduled Quox security scan on detecting a new ${severity}-severity result.`,
  ];
  if (item && item.label) parts.push(`Result: ${item.label}`);
  if (item && item.raw !== undefined && item.raw !== null) {
    let rawText;
    try {
      rawText = typeof item.raw === 'string' ? item.raw : JSON.stringify(item.raw);
    } catch {
      rawText = String(item.raw);
    }
    if (rawText && rawText.trim()) parts.push(`Scan detail: ${truncate(rawText, 1500)}`);
  }
  const out = parts.join('\n\n').trim();
  return out || `New ${severity}-severity result from a scheduled Quox security scan.`;
}

/**
 * @param {{ job: object, diff: object }} args
 *   `job` is the succeeded scheduled job row (engagement_id, org_id, target,
 *   tool, ...). `diff` is the securityScanDiff result; only diff.newHighSeverity
 *   is consumed here.
 * @param {object} deps - { db, getGitHubToken, ghFetch, fileGripe? }
 *   fileGripe defaults to securityReportActions.fileGripeForFinding and is
 *   injectable for tests.
 * @returns {Promise<{createdFindingIds:string[], filed:Array, skipped:Array}>}
 */
async function persistAndFileScheduledFindings({ job, diff }, deps = {}) {
  const { db, getGitHubToken, ghFetch } = deps;
  const fileGripe = deps.fileGripe || securityReportActions.fileGripeForFinding;

  const result = { createdFindingIds: [], filed: [], skipped: [] };
  if (!job || !diff || !Array.isArray(diff.newHighSeverity)) return result;

  const engagementId = job.engagement_id;
  const orgId = job.org_id;
  const targetValue = job.target;

  // Load the engagement once, reused for every gripe payload. If it can't be
  // loaded, filing still fails soft per-finding below (engagement is optional
  // to fileGripeForFinding's payload builder).
  let engagement = null;
  try {
    engagement = securityEngagement.getEngagement(engagementId, orgId, { db });
  } catch {
    engagement = null;
  }

  for (const item of diff.newHighSeverity) {
    const title = truncate(item && item.label ? item.label : `New ${item && item.severity} finding`, TITLE_MAX);

    // DEDUP: a still-open finding with this target+title already exists, skip.
    let existing = null;
    try {
      existing = securityFindings.findOpenFindingByTitle(engagementId, orgId, targetValue, title, { db });
    } catch {
      existing = null;
    }
    if (existing) {
      result.skipped.push({ findingId: existing.id, filed: false, skippedReason: 'duplicate' });
      continue;
    }

    let created;
    try {
      created = securityFindings.createFinding({
        engagement_id: engagementId,
        org_id: orgId,
        target_value: targetValue,
        title,
        description: buildDescription(item),
        severity: item && item.severity,
        reported_by: 'scheduled-scan',
      }, { db });
    } catch (err) {
      // Persist failed for this item (e.g. an unexpected severity value). Record
      // it and move on; one bad item must not lose the others.
      result.skipped.push({ findingId: null, filed: false, skippedReason: `persist-failed: ${err && err.message}` });
      continue;
    }

    result.createdFindingIds.push(created.id);

    // AUTO-FILE. Per-finding try/catch: a filing failure NEVER loses the
    // already-persisted finding or aborts the loop.
    try {
      const filing = await fileGripe(
        { finding: created, engagement, orgId },
        { db, getGitHubToken, ghFetch }
      );
      if (filing && filing.configured === false) {
        // PRODUCT GAP surfaced honestly: no token/repo resolved for this
        // engagement's org. The finding is persisted; the issue is not filed.
        result.skipped.push({ findingId: created.id, filed: false, skippedReason: 'not-configured' });
      } else if (filing && filing.ok === false) {
        result.skipped.push({ findingId: created.id, filed: false, skippedReason: filing.reason || 'file-rejected' });
      } else if (filing && filing.url) {
        result.filed.push({ findingId: created.id, filed: true, url: filing.url });
      } else {
        result.filed.push({ findingId: created.id, filed: true });
      }
    } catch (err) {
      result.skipped.push({ findingId: created.id, filed: false, skippedReason: `file-error: ${err && err.message}` });
    }
  }

  return result;
}

module.exports = {
  persistAndFileScheduledFindings,
};
