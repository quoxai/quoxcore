/**
 * Pure grouping for the Findings lifecycle list (services/collector/lib/
 * lensFindings.js's lifecycle records: new -> confirmed -> remediated or
 * lapsed, with accepted-risk and regressed side branches — see that
 * module's header for the full transition table).
 *
 * The house rule this file exists to satisfy: a digest that re-reports the
 * same "confirmed" finding every run is noise, and noise is what makes
 * people stop reading. `groupFindings` never returns a `confirmed` bucket at
 * all — those findings are still real (the artifact still has the problem),
 * they are just not new information, so they are omitted rather than
 * re-listed. `needsAttention` leads because it is the one bucket a human
 * must act on: genuinely new findings, findings that came back after being
 * marked fixed, and accepted risks whose exemption window has lapsed.
 *
 * Kept side-effect free and separate from FindingsView.jsx so this ordering
 * rule is unit-testable without React.
 */

/** Mirrors services/collector/lib/lensFindings.js's isAcceptanceActive — an
 * acceptance with no `until` is never active, matching that module's own
 * "no permanent exemptions" rule. */
function isAcceptanceActive(acceptance, now) {
  if (!acceptance || !acceptance.until) return false;
  return new Date(acceptance.until).getTime() > new Date(now).getTime();
}

/**
 * @param {Array<object>} findings - lifecycle records (see lensFindings.js)
 * @param {string|Date} [now]
 * @returns {{
 *   needsAttention: Array<object>,
 *   acceptedRisk: Array<object>,
 *   remediated: Array<object>,
 *   lapsed: Array<object>,
 *   omittedConfirmed: number
 * }}
 */
export function groupFindings(findings, now = new Date().toISOString()) {
  const list = Array.isArray(findings) ? findings : [];

  const needsAttention = [];
  const acceptedRisk = [];
  const remediated = [];
  const lapsed = [];
  let omittedConfirmed = 0;

  for (const record of list) {
    if (!record || !record.state) continue;

    if (record.state === 'new' || record.state === 'regressed') {
      needsAttention.push(record);
    } else if (record.state === 'accepted-risk') {
      if (isAcceptanceActive(record.acceptance, now)) {
        acceptedRisk.push(record);
      } else {
        // A lapsed exemption is exactly as actionable as a new finding —
        // the risk the owner accepted is no longer covered by that
        // acceptance, whether or not a fresh sweep has run to flip its
        // stored `state` yet (see lensFindings.summarise's own comment).
        needsAttention.push(record);
      }
    } else if (record.state === 'remediated') {
      remediated.push(record);
    } else if (record.state === 'lapsed') {
      // Its own bucket, never merged into remediated: a lapsed finding is
      // one nobody reported again on an artifact that did not change, which
      // is not a repair and must never be displayed as one. Shown rather
      // than omitted, because the open question is the point.
      lapsed.push(record);
    } else if (record.state === 'confirmed') {
      omittedConfirmed += 1;
    }
  }

  const byLastSeenDesc = (a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
  needsAttention.sort(byLastSeenDesc);
  acceptedRisk.sort(byLastSeenDesc);
  remediated.sort(byLastSeenDesc);
  lapsed.sort(byLastSeenDesc);

  return { needsAttention, acceptedRisk, remediated, lapsed, omittedConfirmed };
}
