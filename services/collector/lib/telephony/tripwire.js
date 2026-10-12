/**
 * Tripwire decision (COMMANDERQ P10 — auto-detect -> call trigger).
 *
 * "Know if we're being hacked." When a critical incident is recorded, this decides
 * whether it warrants Q reaching out to a human — the DECISION only. The action
 * (raise a contactability-gated call intent + a Telegram fallback ping + evidence)
 * is orchestrated by the caller, so this stays pure and testable.
 *
 * Event-driven by design: this is evaluated PER incident as incidents happen — no
 * polling loop, no scheduler, so none of the loop-hygiene failure modes apply.
 * Two independent brakes stop it ever spamming:
 *   1. cooldown (withinCooldown) — at most one call per source per window;
 *   2. deny-by-default contactability (applied downstream) — no opt-in, no call.
 */

'use strict';

const SEVERITY_RANK = { info: 0, low: 1, warning: 2, medium: 2, high: 3, critical: 4 };

// Categories that are routine operational noise and must NEVER auto-call, even at
// high severity (a collector restart is not an intrusion). Security/intrusion
// categories are NOT here, so they pass.
const EXCLUDED_CATEGORIES = new Set([
  'service_restart', 'deploy', 'build', 'info', 'heartbeat', 'uptime_warning',
]);

/**
 * @param {object} incident - { severity, category?, source?, summary? }
 * @param {object} [opts] - { minSeverity = 'critical' }
 * @returns {{ warrants: boolean, reason: string }}
 */
function shouldRaiseCall(incident, { minSeverity = 'critical' } = {}) {
  if (!incident || typeof incident !== 'object') return { warrants: false, reason: 'no_incident' };
  const sev = String(incident.severity || '').toLowerCase();
  const rank = SEVERITY_RANK[sev];
  if (rank === undefined) return { warrants: false, reason: `unknown_severity(${sev || 'none'})` };
  const min = SEVERITY_RANK[minSeverity] ?? 4;
  if (rank < min) return { warrants: false, reason: `below_threshold(${sev}<${minSeverity})` };
  const cat = String(incident.category || '').toLowerCase();
  if (cat && EXCLUDED_CATEGORIES.has(cat)) return { warrants: false, reason: `excluded_category(${cat})` };
  return { warrants: true, reason: `severity_${sev}` };
}

/**
 * True if the last raise for a source was within the cooldown window — used to
 * suppress repeat calls for the same ongoing incident.
 */
function withinCooldown(lastIso, nowIso, cooldownMinutes) {
  if (!lastIso) return false;
  const last = Date.parse(lastIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return false;
  return (now - last) < Math.max(0, cooldownMinutes) * 60000;
}

module.exports = { shouldRaiseCall, withinCooldown, SEVERITY_RANK, EXCLUDED_CATEGORIES };
