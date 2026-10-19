'use strict';
// QUOXON-FLEET: one place that folds agent-reported health into the summary buckets.
// quoxagent reports healthy | degraded | unhealthy; older producers use warning | critical.
// Both vocabularies must land in warning/critical, or the summary reads "0 warning, 0
// critical" while hosts are degraded (the 2026-10-14 gitea / prtg01 miss).
function bucketFleetHealth(agents) {
  const out = { healthy: 0, warning: 0, critical: 0, unknown: 0 };
  for (const agent of agents) {
    const h = String(agent?.status?.health || 'unknown').toLowerCase();
    if (h === 'healthy') out.healthy++;
    else if (h === 'warning' || h === 'degraded') out.warning++;
    else if (h === 'critical' || h === 'unhealthy') out.critical++;
    else out.unknown++;
  }
  return out;
}
module.exports = { bucketFleetHealth };
