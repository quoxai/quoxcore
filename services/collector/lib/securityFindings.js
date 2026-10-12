'use strict';

/**
 * QUOX-SECURITY Phase 1 (continued): findings storage. Closes the gap
 * flagged repeatedly in STATUS_AND_LIMITS_SECURITY.md, "no findings storage
 * exists yet, findings_verifier reviews claims made in conversation, not
 * structured records." A candidate finding is created by a specialist, then
 * either confirmed or refuted by findings_verifier, always with a reason,
 * never a bare verdict, the same adversarial discipline this whole stream
 * has followed since Phase 0.
 *
 * Deliberately does not attempt CVSS-style scoring or a taxonomy engine:
 * severity is one of a fixed set of plain labels. That machinery is out of
 * scope for Phase 1 and would be invented without a real finding to design
 * it against.
 */

const { generateUlid } = require('./imageStore.js');
const securityEngagement = require('./securityEngagement.js');

const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];
const STATUSES = ['candidate', 'confirmed', 'refuted', 'resolved'];
const VERDICTS = ['confirmed', 'refuted'];

function parseRow(row) {
  if (!row) return null;
  return { ...row };
}

/**
 * @param {object} input
 * @param {object} deps - { db }
 */
function createFinding(input, deps) {
  const { db } = deps;
  const { engagement_id, org_id, target_value, title, description, reported_by } = input || {};
  const severity = input?.severity || 'info';

  if (!org_id) throw new Error('org_id is required');
  const engagement = securityEngagement.getEngagement(engagement_id, org_id, { db });
  if (!engagement) throw new Error(`Engagement "${engagement_id}" not found or not authorized for org "${org_id}"`);

  if (!title || !String(title).trim()) throw new Error('title is required');
  if (!description || !String(description).trim()) throw new Error('description is required');
  if (!SEVERITIES.includes(severity)) throw new Error(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (!target_value) throw new Error('target_value is required');

  const id = `FND_${generateUlid()}`;
  db.prepare(`
    INSERT INTO security_findings (
      id, engagement_id, org_id, target_value, title, description, severity, status, reported_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?)
  `).run(id, engagement_id, org_id, target_value, title, description, severity, reported_by || null);

  const created = getFinding(id, org_id, deps);
  try { require('./lucid/emit.js').findingEvent(created); } catch { /* LUCID must never break findings */ }
  return created;
}

function getFinding(id, orgId, deps) {
  const row = deps.db.prepare('SELECT * FROM security_findings WHERE id = ? AND org_id = ?').get(id, orgId);
  return parseRow(row);
}

function listFindings(engagementId, orgId, deps) {
  const rows = deps.db.prepare(
    'SELECT * FROM security_findings WHERE engagement_id = ? AND org_id = ? ORDER BY created_at DESC, rowid DESC'
  ).all(engagementId, orgId);
  return rows.map(parseRow);
}

/**
 * Dedup lookup for scheduled-scan finding persistence: returns the first
 * still-open (status not 'refuted', not 'resolved') finding in the given
 * engagement+org that matches this target_value and title, else null. A
 * recurring schedule that keeps re-observing the same high/critical result
 * uses this to avoid re-creating a duplicate finding every run. A finding
 * that was refuted (false positive) or resolved (remediated) is deliberately
 * NOT matched, so a genuinely-reappearing issue can be filed afresh.
 *
 * @param {string} engagementId
 * @param {string} orgId
 * @param {string} targetValue
 * @param {string} title
 * @param {object} deps - { db }
 */
function findOpenFindingByTitle(engagementId, orgId, targetValue, title, deps) {
  const row = deps.db.prepare(`
    SELECT * FROM security_findings
    WHERE engagement_id = ? AND org_id = ? AND target_value = ? AND title = ?
      AND status NOT IN ('refuted', 'resolved')
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(engagementId, orgId, targetValue, title);
  return parseRow(row);
}

/**
 * The adversarial step. Never a bare verdict, always a reason: matches the
 * discipline findings_verifier's own persona rules already require of it.
 *
 * @param {string} id
 * @param {string} orgId
 * @param {{verdict:string, reason:string, verified_by?:string}} args
 * @param {object} deps - { db }
 */
function verifyFinding(id, orgId, { verdict, reason, verified_by } = {}, deps) {
  const { db } = deps;
  const finding = getFinding(id, orgId, deps);
  if (!finding) throw new Error(`Finding "${id}" not found or not authorized for org "${orgId}"`);
  if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(', ')}`);
  if (!reason || !String(reason).trim()) throw new Error('reason is required, a bare verdict is not accepted');

  const status = verdict; // 'confirmed' | 'refuted', same literal as the status column
  db.prepare(`
    UPDATE security_findings
    SET status = ?, verdict_reason = ?, verified_by = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, reason, verified_by || null, id);

  const verified = getFinding(id, orgId, deps);
  try { require('./lucid/emit.js').findingEvent(verified); } catch { /* LUCID must never break findings */ }
  return verified;
}

/**
 * Re-grade a finding's severity AFTER it was reported (quoxai/quox#601).
 * Severity is fixed at report-finding time, and a batch reported at the 'info'
 * default (as trust-proof cycle 3 was) had no governed way to be corrected —
 * rewriting the /security projection directly is the forgery the signing gate
 * forbids. This is that governed, witnessed correction path.
 *
 * A reason is required, mirroring verifyFinding: severity is one of the fields
 * /security publishes, so a change to it must carry its rationale, never a bare
 * new label. The old->new transition and its reason are appended to
 * verdict_reason (same non-clobbering append discipline as resolveFinding), so
 * the record keeps an auditable trail; the collector route additionally emits a
 * WARD-witnessed AEE envelope. Status, verdict and verifier are left untouched:
 * a re-grade changes how severe a real finding is, not whether it is real.
 *
 * @param {string} id
 * @param {string} orgId
 * @param {{severity:string, reason:string, regraded_by?:string}} args
 * @param {object} deps - { db }
 * @returns the updated finding, with a transient `severity_from` for the caller
 */
function regradeFinding(id, orgId, { severity, reason, regraded_by } = {}, deps) {
  const { db } = deps;
  const finding = getFinding(id, orgId, deps);
  if (!finding) throw new Error(`Finding "${id}" not found or not authorized for org "${orgId}"`);
  if (!SEVERITIES.includes(severity)) throw new Error(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (!reason || !String(reason).trim()) throw new Error('reason is required, a severity change without a rationale is not accepted');

  const from = finding.severity;
  const cleanReason = String(reason).trim();
  const actor = regraded_by ? ` (by ${regraded_by})` : '';
  const note = `regraded ${from} -> ${severity}${actor}: ${cleanReason}`;
  const nextVerdictReason = finding.verdict_reason ? `${finding.verdict_reason} | ${note}` : note;

  db.prepare(`
    UPDATE security_findings
    SET severity = ?, verdict_reason = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(severity, nextVerdictReason, id);

  const updated = getFinding(id, orgId, deps);
  updated.severity_from = from;
  return updated;
}

/**
 * Set the GitHub issue URL a finding was raised as ("Raise as Gripe").
 * Idempotent-safe: overwrites any prior value, since re-filing (after an
 * issue was closed elsewhere, say) should be allowed rather than refused.
 *
 * @param {string} id
 * @param {string} orgId
 * @param {string} gripeUrl
 * @param {object} deps - { db }
 */
function setFindingGripeUrl(id, orgId, gripeUrl, deps) {
  const { db } = deps;
  const finding = getFinding(id, orgId, deps);
  if (!finding) throw new Error(`Finding "${id}" not found or not authorized for org "${orgId}"`);
  if (!gripeUrl || !String(gripeUrl).trim()) throw new Error('gripeUrl is required');
  db.prepare(`
    UPDATE security_findings
    SET gripe_url = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(gripeUrl, id);
  return getFinding(id, orgId, deps);
}

/**
 * Set the QuoxPlan reference a finding was proposed as ("Propose as
 * QuoxPlan"). Same idempotent-overwrite semantics as setFindingGripeUrl.
 *
 * @param {string} id
 * @param {string} orgId
 * @param {string} quoxplanRef
 * @param {object} deps - { db }
 */
function setFindingQuoxplanRef(id, orgId, quoxplanRef, deps) {
  const { db } = deps;
  const finding = getFinding(id, orgId, deps);
  if (!finding) throw new Error(`Finding "${id}" not found or not authorized for org "${orgId}"`);
  if (!quoxplanRef || !String(quoxplanRef).trim()) throw new Error('quoxplanRef is required');
  db.prepare(`
    UPDATE security_findings
    SET quoxplan_ref = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(quoxplanRef, id);
  return getFinding(id, orgId, deps);
}

/**
 * Marks a finding as remediated ("resolved"): its underlying problem has been
 * fixed, most commonly because the GitHub issue it was filed as was closed.
 * Distinct from 'refuted' (a false positive) — resolving a refuted finding is
 * refused, because a thing that was never real cannot be remediated.
 *
 * Idempotent: resolving an already-resolved finding is a no-op success and
 * preserves the original resolved_at. A reason, when given, is appended to
 * verdict_reason rather than clobbering any existing verdict text.
 *
 * @param {string} id
 * @param {string} orgId
 * @param {{reason?:string}} args
 * @param {object} deps - { db }
 */
function resolveFinding(id, orgId, { reason } = {}, deps) {
  const { db } = deps;
  const finding = getFinding(id, orgId, deps);
  if (!finding) throw new Error(`Finding "${id}" not found or not authorized for org "${orgId}"`);
  if (finding.status === 'refuted') {
    throw new Error('A refuted finding is a false positive, not a real thing to resolve');
  }
  if (finding.status === 'resolved') {
    return finding; // idempotent no-op, keep the original resolved_at
  }

  const cleanReason = reason && String(reason).trim();
  const nextVerdictReason = cleanReason
    ? (finding.verdict_reason ? `${finding.verdict_reason} | ${cleanReason}` : cleanReason)
    : finding.verdict_reason;

  db.prepare(`
    UPDATE security_findings
    SET status = 'resolved', resolved_at = datetime('now'), verdict_reason = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(nextVerdictReason ?? null, id);

  const resolved = getFinding(id, orgId, deps);
  try { require('./lucid/emit.js').findingEvent(resolved); } catch { /* LUCID must never break findings */ }
  return resolved;
}

/**
 * Caches the last-known GitHub issue state (open/closed/null) on the finding
 * row, so the UI can show remediation progress without a live API call on
 * every read.
 *
 * @param {string} id
 * @param {string} orgId
 * @param {string} issueState
 * @param {object} deps - { db }
 */
function setFindingIssueState(id, orgId, issueState, deps) {
  const { db } = deps;
  const finding = getFinding(id, orgId, deps);
  if (!finding) throw new Error(`Finding "${id}" not found or not authorized for org "${orgId}"`);
  db.prepare(`
    UPDATE security_findings
    SET issue_state = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(issueState ?? null, id);
  return getFinding(id, orgId, deps);
}

module.exports = {
  SEVERITIES,
  STATUSES,
  VERDICTS,
  createFinding,
  getFinding,
  listFindings,
  findOpenFindingByTitle,
  verifyFinding,
  regradeFinding,
  setFindingGripeUrl,
  setFindingQuoxplanRef,
  resolveFinding,
  setFindingIssueState,
};
