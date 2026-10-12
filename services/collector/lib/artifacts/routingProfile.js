/**
 * Outcome-learned delegation router profile (COMMANDERQ P7 / B1+B2).
 *
 * The loop this closes: P6 wraps every delegation in a latency contract and
 * emits a SIGNED routing_verdict artifact recording who was chosen and how it
 * went (completed / breached / degraded / rerouted, elapsed_ms). Those verdicts
 * already persist, org-scoped, in the `artifacts` table. This module reads them
 * back and aggregates them into an EMPIRICAL, per-(tenant, task_class, agent)
 * reliability profile — so the next routing decision can be made from what has
 * actually happened rather than from a static prompt hunch. Each recommendation
 * cites the verdict artifact_ids it is derived from (evidence, not vibes).
 *
 * B2 retrospection is inherent here: every routing_verdict is a post-run verdict,
 * so the profile updates the moment a delegation completes — no separate write.
 *
 * HONEST SCOPE: this learns from DELEGATION RELIABILITY (did the specialist
 * answer in-budget, did it breach/degrade/reroute, how long it took). It does
 * NOT grade answer CORRECTNESS — that needs a separate eval signal. The tool
 * and route say so plainly so nobody reads more into the score than is there.
 *
 * Pure — the caller passes the voltDb handle. Reads ALWAYS filter by org_id.
 * Never throws on bad rows: a malformed signed_json is skipped, not fatal.
 */

'use strict';

// action_taken values runWithContract can emit (delegationContract.js), bucketed.
const COMPLETED_ACTIONS = new Set(['completed', 'completed_over_budget']);
const REROUTED_ACTIONS = new Set(['rerouted', 'rerouted_breaker_open']);

/** Normalize a caller-supplied task class into a stable key. Empty → 'general'. */
function normalizeTaskClass(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'general';
}

function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : null; }

/**
 * Read an org's routing_verdict artifacts and fold them into per-agent stats,
 * optionally scoped to one task_class and/or a time window.
 * @returns {{ agents: object[], total_verdicts: number, task_class: string|null, window_since: string|null }}
 *   agents: one row per chosen_agent, richest-evidence first, with rates + a
 *   reliability score and up to 3 citing artifact_ids.
 */
function aggregateRoutingProfile(db, orgId, { taskClass, sinceIso, limit = 500 } = {}) {
  const empty = { agents: [], total_verdicts: 0, task_class: taskClass ? normalizeTaskClass(taskClass) : null, window_since: sinceIso || null };
  if (!orgId) return empty;
  const cap = Math.min(Math.max(1, limit | 0), 2000);
  const rows = sinceIso
    ? db.prepare(`SELECT artifact_id, signed_json FROM artifacts WHERE org_id = ? AND artifact_type = 'routing_verdict' AND created_at >= ? ORDER BY created_at DESC LIMIT ?`).all(orgId, sinceIso, cap)
    : db.prepare(`SELECT artifact_id, signed_json FROM artifacts WHERE org_id = ? AND artifact_type = 'routing_verdict' ORDER BY created_at DESC LIMIT ?`).all(orgId, cap);

  const wantClass = taskClass ? normalizeTaskClass(taskClass) : null;
  const byAgent = new Map();
  let total = 0;

  for (const r of rows) {
    let body;
    try { body = JSON.parse(r.signed_json).body; } catch { continue; }
    if (!body) continue;
    const cls = normalizeTaskClass(body.task_class);
    if (wantClass && cls !== wantClass) continue;
    const agent = body.chosen_agent || (body.candidates && body.candidates[0] && body.candidates[0].agent) || 'unknown';
    const oc = body.outcome || {};
    const action = oc.action_taken || 'unknown';

    let a = byAgent.get(agent);
    if (!a) { a = { agent, delegations: 0, completed: 0, breached: 0, rerouted: 0, degraded: 0, _elapsedSum: 0, _elapsedN: 0, evidence: [] }; byAgent.set(agent, a); }
    a.delegations += 1;
    total += 1;
    if (COMPLETED_ACTIONS.has(action)) a.completed += 1;
    else if (REROUTED_ACTIONS.has(action)) a.rerouted += 1;
    else a.degraded += 1; // degraded / cancelled / breaker_open_degraded / execute_error / unknown
    if (oc.breached === true) a.breached += 1;
    if (Number.isFinite(oc.elapsed_ms)) { a._elapsedSum += oc.elapsed_ms; a._elapsedN += 1; }
    if (a.evidence.length < 3) a.evidence.push(r.artifact_id);
  }

  const agents = [...byAgent.values()].map((a) => {
    const success_rate = pct(a.completed, a.delegations);
    const breach_rate = pct(a.breached, a.delegations);
    const avg_elapsed_ms = a._elapsedN > 0 ? Math.round(a._elapsedSum / a._elapsedN) : null;
    // Reliability score in [0,100]: reward in-budget completion, penalize
    // breaches. Latency is a tiebreak (via sort), not folded into the score, so
    // a fast-but-failing agent never outranks a slower reliable one.
    const score = a.delegations > 0
      ? Math.round(((a.completed - 0.5 * a.breached) / a.delegations) * 1000) / 10
      : null;
    return {
      agent: a.agent,
      delegations: a.delegations,
      completed: a.completed,
      breached: a.breached,
      rerouted: a.rerouted,
      degraded: a.degraded,
      success_rate,
      breach_rate,
      avg_elapsed_ms,
      score,
      evidence: a.evidence,
    };
  });

  // Rank: highest score, then more evidence, then lower latency.
  agents.sort((x, y) =>
    (y.score ?? -1) - (x.score ?? -1) ||
    y.delegations - x.delegations ||
    ((x.avg_elapsed_ms ?? Infinity) - (y.avg_elapsed_ms ?? Infinity))
  );

  return { agents, total_verdicts: total, task_class: wantClass, window_since: sinceIso || null };
}

// Below this many prior verdicts for a task_class, a recommendation is a weak
// prior, not a learned fact — flagged so Q (and the reader) can discount it.
const MIN_CONFIDENT_SAMPLE = 3;

/**
 * Recommend the empirically-best agent for a task_class in this tenant.
 * @returns an advisory object (never throws): recommended_agent may be null
 *   with a reason when there is no prior evidence.
 */
function adviseRoute(db, orgId, taskClass, { sinceIso } = {}) {
  const cls = normalizeTaskClass(taskClass);
  const { agents, total_verdicts } = aggregateRoutingProfile(db, orgId, { taskClass: cls, sinceIso });
  if (agents.length === 0) {
    return {
      task_class: cls,
      recommended_agent: null,
      reason: 'no_prior_outcomes',
      note: 'No prior routing verdicts for this task class in this tenant. Route on your own judgement; the verdict from this delegation will seed the profile.',
      ranked: [],
      sample_size: 0,
      low_confidence: true,
      based_on: 'delegation reliability (completion vs breach/degrade + latency); NOT answer correctness',
    };
  }
  const top = agents[0];
  const evidence = agents.flatMap((a) => a.evidence).slice(0, 5);
  return {
    task_class: cls,
    recommended_agent: top.agent,
    ranked: agents,
    sample_size: total_verdicts,
    low_confidence: total_verdicts < MIN_CONFIDENT_SAMPLE,
    evidence,
    based_on: 'delegation reliability (completion vs breach/degrade + latency); NOT answer correctness',
  };
}

module.exports = {
  normalizeTaskClass,
  aggregateRoutingProfile,
  adviseRoute,
};
