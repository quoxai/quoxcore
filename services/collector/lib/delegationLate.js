'use strict';

/**
 * Late delegation results (#959/#964).
 *
 * When a delegate_to_agent wait expires the specialist is NOT cancelled (delegationContract
 * `detach`). This module owns what happens when it finishes after the parent stopped waiting:
 *
 *  - the result, with the specialist's tool outcomes, is posted into the SAME conversation as a
 *    follow-up exchange (so the user sees it and the next turn's history carries it);
 *  - a routing_verdict artifact (completed_late) is written against the original session, so the
 *    evidence trail shows what the specialist did, not "did not respond";
 *  - the handle is queryable (`status`) while the work runs and after it lands.
 *
 * Pure + injectable (recordExchange, postArtifact, now) so it is unit-testable. Never throws.
 */

const MAX_REPLY = 6000;
const NESTED = new Set(['ok', 'failed', 'denied', 'effect_unknown']);
const _handles = new Map(); // handle -> record (bounded)
const MAX_HANDLES = 500;

function gist(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }

function toolLine(outcomes) {
  if (!Array.isArray(outcomes) || !outcomes.length) return '';
  const parts = outcomes.slice(0, 25).filter((o) => o && typeof o.tool === 'string' && o.tool)
    .map((o) => `${gist(o.tool, 60)}: ${NESTED.has(o.status) ? o.status : 'unknown'}`);
  return parts.length ? `Tools it ran: ${parts.join(', ')}.` : '';
}

/** The follow-up text. Grounded: it states only what the specialist reported. */
function buildFollowUp({ agentId, ok, result, error }) {
  const who = agentId || 'The specialist';
  if (!ok) {
    return `Update: ${who} has finished but did NOT confirm success${error ? `: ${gist(error, 300)}` : ''}. ${toolLine(result && result.tool_outcomes)}`.trim();
  }
  const body = gist(result && result.response, MAX_REPLY);
  return [`Update: ${who} has finished the task I said was still in progress.`, body && `It reported: ${body}`, toolLine(result && result.tool_outcomes)].filter(Boolean).join(' ');
}

function remember(rec) {
  _handles.set(rec.handle, rec);
  if (_handles.size > MAX_HANDLES) _handles.delete(_handles.keys().next().value);
}

/**
 * Attach a detached delegation. `settled` resolves { ok, result?, error? }.
 * @returns {object} the handle record (status 'pending' until it lands)
 */
function attachLateDelegation({ handle, agentId, task, ctx = {}, settled, deadlineMs, recordExchange, postArtifact, now = Date.now } = {}) {
  const rec = { handle, agent: agentId, task_gist: gist(task, 120), org_id: ctx.orgId || null, session_id: ctx.session_id || ctx.conversationId || null, started_at: now(), status: 'pending' };
  remember(rec);
  Promise.resolve(settled).then(async (s) => {
    const ok = !!(s && s.ok);
    rec.status = ok ? 'completed' : 'failed';
    rec.finished_at = now();
    rec.tool_outcomes = (s && s.result && Array.isArray(s.result.tool_outcomes)) ? s.result.tool_outcomes : undefined;
    const reply = buildFollowUp({ agentId, ok, result: s && s.result, error: (s && (s.error || (s.result && s.result.error))) || null });
    rec.followup = reply;
    const postFollowUp = () => {
      try {
        const rx = recordExchange || require('./chatSessionHistory.js').recordExchange;
        rec.posted = !!rx({
          orgId: ctx.orgId, userId: ctx.userId, sessionId: rec.session_id,
          prompt: `[delegation ${handle}] ${agentId} was still working on: ${rec.task_gist}`,
          reply, turnId: ctx.turnId || handle, agentId: agentId || null,
          activity: toolLine(rec.tool_outcomes) || undefined,
        });
      } catch (e) { rec.posted = false; console.warn(`[Delegation] late follow-up not posted (${handle}): ${e && e.message}`); }
    };
    // quox#1044: a live outer turn still waiting for this answer shows it in the same turn (and
    // stores it with that turn's answer); if that turn ends without showing it, it calls postFollowUp.
    let inline = false;
    try { inline = typeof rec.inlineDeliver === 'function' && rec.inlineDeliver(s, postFollowUp) === true; } catch { inline = false; }
    if (inline) rec.posted = 'inline';
    else postFollowUp();
    try {
      const post = postArtifact || (() => {});
      post({
        body: {
          task_class: 'delegation', chosen_agent: agentId,
          candidates: [{ agent: agentId, score: null, reason: rec.task_gist }],
          rationale: `Delegated (late result ${handle}): ${rec.task_gist}`,
          latency_budget_ms: deadlineMs || null,
          outcome: { breached: true, action_taken: ok ? 'completed_late' : 'failed_late', elapsed_ms: rec.finished_at - rec.started_at, cost_breached: false, rerouted_to: null },
        },
        session_id: rec.session_id || undefined,
      });
    } catch (_) { /* evidence is best-effort */ }
    console.log(`[Delegation] ${agentId} late result ${handle}: ${rec.status} after ${rec.finished_at - rec.started_at}ms, follow-up ${rec.posted === 'inline' ? 'shown in the live turn' : rec.posted ? 'posted' : 'NOT posted'}`);
  }).catch((e) => { rec.status = 'failed'; console.warn(`[Delegation] late attach failed (${handle}): ${e && e.message}`); });
  return rec;
}

function status(handle) { return _handles.get(handle) || null; }

module.exports = { attachLateDelegation, buildFollowUp, status };
