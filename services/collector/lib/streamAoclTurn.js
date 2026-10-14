'use strict';
/**
 * QUOXON-AOCL: the full L0-L10 AOCL stack for a STREAMED chat turn (POST /chat/stream).
 *
 * Before this module, /chat/stream ran only runPreLLMPipeline (L1 identity + L3 policy)
 * and never ran L8, so every streamed turn (the CLI, the dashboard stream) accounted for
 * 2 of 11 layers while the non-streaming /chat path ran the whole stack. This module makes
 * a streamed turn account for all 11, using the same layer modules as stack mode
 * (buildChatStack), split around the stream:
 *
 *   pre  (before any SSE frame, fail-closed):  L0 ingress, L1 identity, L2 router (observe),
 *                                              L3 policy, L4 planner
 *   post (when the stream ends, before turn.finished):
 *        L5 context   bypass: stream.inline_context (the stream handler fetches memory and
 *                     agent context itself, it is not a stack layer on this path)
 *        L6 shape     bypass: stream.inline_prompt (the stream handler builds the prompt)
 *        L7 delegate  complete when the provider produced an answer (dispatched by the stream
 *                     handler); bypass with the reason when the turn errored or was interrupted
 *        L8 verify    runs on the final assistant text, honouring AOCL_L8_MODE
 *        L9 assemble  bypass: stream.delivered_incrementally (the text went out as chunks)
 *        L10 audit    complete, carrying the run/bypass lists
 *
 * L2 runs in OBSERVE mode here: a fast-path match is recorded (fastpath_eligible) but does
 * not replace the answer, so a streamed "status" still reaches the model. Stack mode on /chat
 * does answer canned text; the stream deliberately does not change what the user gets.
 *
 * L8 on a stream: the text is already on screen when L8 can run. In enforce mode a failed
 * verification cannot un-send it, so the turn gets an `aocl.verdict` event (verdict:'blocked')
 * the client must show against the answer, the L8 envelope is a reject, and the turn's AOCL
 * status is denied. In warn mode the failure is a warning on a passing L8.
 *
 * Fail-closed: L1 and L3 run with no timeout budget (a budget turns a slow layer into a
 * bypass, which for identity and policy would be fail-open). A layer that throws rejects.
 * The caller wraps runPre in a try/catch that refuses the turn (503) on any throw.
 */

const { buildChatStack } = require('./aoclStack.js');
const { runPipeline, emitLayerEnvelope, EXPECTED_LAYERS } = require('./aoclPipeline.js');

const PRE_LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4'];
// Identity and policy must never degrade to a timeout bypass.
const PRE_BUDGET_OVERRIDES = Object.freeze({ L1: 0, L3: 0 });

function nowMs() {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

/** Map a stack-layer denial onto the legacy runPreLLMPipeline HTTP shape (clients key off these codes). */
function legacyDenial(layerId, layerResult = {}) {
  if (layerId === 'L1') {
    return { httpStatus: 401, errorCode: 'identity_required', errorMessage: `L1 identity check failed: ${layerResult.reason || 'identity_required'}` };
  }
  if (layerId === 'L3') {
    if (layerResult.error || String(layerResult.reason || '').startsWith('evaluator_error')) {
      return { httpStatus: 500, errorCode: 'policy_evaluator_error', errorMessage: `Policy evaluation failed: ${layerResult.error || layerResult.reason}` };
    }
    if (layerResult.requiresApproval) {
      return { httpStatus: 403, errorCode: 'approval_required', errorMessage: layerResult.approvalReason || layerResult.reason };
    }
    return { httpStatus: 403, errorCode: `${layerResult.category || 'compliance'}_policy_violation`, errorMessage: layerResult.reason };
  }
  return null;
}

/**
 * @param {object} opts
 * @param {object} opts.aoclCtx       from setupPipelinePhase(req, { source: SOURCES.SSE })
 * @param {object|null} opts.voltDb   policy store (null skips L3 store policies, as before)
 * @param {object} [opts.deps]        test seams: enforceIdentity, evaluateCompliance, evaluateSafety, verify, l8Mode
 */
function createStreamAoclTurn({ aoclCtx, voltDb = null, deps = {} } = {}) {
  if (!aoclCtx) throw new Error('createStreamAoclTurn: aoclCtx is required');
  if (!aoclCtx.layerResults) aoclCtx.layerResults = {};
  const records = new Map(); // id -> { id, outcome, ms, reason }
  let preMs = 0;
  let postMs = 0;
  let postDone = false;
  let verdict = null;

  const stack = buildChatStack({
    profile: 'default',
    voltDb,
    enforceIdentity: deps.enforceIdentity,
    evaluateCompliance: deps.evaluateCompliance,
    evaluateSafety: deps.evaluateSafety,
    verify: deps.verify,
    l8Mode: deps.l8Mode,
  });
  const byId = Object.fromEntries(stack.layers.map(l => [l.id, l]));

  function record(id, outcome, ms, reason) {
    records.set(id, { id, outcome, ms: Math.round((Number(ms) || 0) * 10) / 10, ...(reason ? { reason: String(reason).slice(0, 120) } : {}) });
  }

  function bypass(id, reason, extras = {}) {
    aoclCtx.layerResults[id] = { proceed: true, bypass: true, reason, duration_ms: 0 };
    emitLayerEnvelope(aoclCtx, id, 'bypass', { reason, duration_ms: 0, ...extras });
    record(id, 'bypass', 0, reason);
  }

  // L2 observe: record a fast-path match without halting (the stream never answers canned text).
  const l2Observe = {
    id: 'L2',
    run: async (ctx) => {
      const r = await byId.L2.run(ctx);
      if (ctx.halt && ctx.halt.reason === 'l2.fastpath') {
        const intent = ctx.halt.intent || null;
        delete ctx.halt;
        return { proceed: true, extras: { ...(r && r.extras), handled: false, fastpath_eligible: true, fastpath_intent: intent, stream_observe: true } };
      }
      return r;
    },
  };

  // L3 parity with runPreLLMPipeline: a resumed delegation carrying a GRANTED approval
  // satisfies approval_required (it is still denied by a hard policy deny).
  const l3 = {
    id: 'L3',
    run: async (ctx) => {
      const r = await byId.L3.run(ctx);
      if (r && r.proceed === false && r.extras && r.extras.requiresApproval && ctx.approvalGranted) {
        ctx.deniedAtLayer = null; ctx.firstDenialReason = null; ctx.status = 'running';
        return { proceed: true, warnings: r.warnings, extras: { ...r.extras, approvalSatisfied: true, reason: 'approval_satisfied', inbox_item_id: ctx.approvalInboxItemId || null } };
      }
      return r;
    },
  };

  /**
   * Pre-LLM layers. Returns the runPreLLMPipeline result shape so the call site's
   * refusal handling is unchanged.
   */
  async function runPre() {
    const t0 = nowMs();
    const layers = PRE_LAYERS.map(id => (id === 'L2' ? l2Observe : id === 'L3' ? l3 : byId[id]));
    const timed = layers.map(l => ({ id: l.id, run: async (ctx) => { const s = nowMs(); try { return await l.run(ctx); } finally { ctx.__aoclLayerMs = { ...(ctx.__aoclLayerMs || {}), [l.id]: nowMs() - s }; } } }));
    const r = await runPipeline(aoclCtx, { layers: timed }, { budgetOverrides: PRE_BUDGET_OVERRIDES });
    preMs = nowMs() - t0;
    const ms = aoclCtx.__aoclLayerMs || {};
    for (const id of PRE_LAYERS) {
      if (r.layersBypassed.includes(id)) record(id, 'bypass', ms[id], aoclCtx.layerResults[id]?.reason);
      else if (r.deniedAtLayer === id) record(id, 'reject', ms[id], aoclCtx.layerResults[id]?.reason);
      else if (r.layersRun.includes(id)) record(id, 'complete', ms[id]);
    }
    delete aoclCtx.__aoclLayerMs;
    if (!r.proceed) {
      const legacy = legacyDenial(r.deniedAtLayer, aoclCtx.layerResults[r.deniedAtLayer]);
      if (legacy) Object.assign(r, legacy);
    }
    return r;
  }

  /**
   * Post-stream layers. Call once when the stream ends (before turn.finished).
   * @param {{ text?: string, status?: 'completed'|'failed'|'interrupted' }} p
   * @returns {Promise<{ summary: object, verdict: object|null }>}
   */
  async function runPost({ text = '', status = 'completed' } = {}) {
    if (postDone) return { summary: summary(), verdict };
    postDone = true;
    const t0 = nowMs();
    try {
      bypass('L5', 'stream.inline_context');
      bypass('L6', 'stream.inline_prompt');

      const answered = typeof text === 'string' && text.length > 0;
      if (answered && status === 'completed') {
        aoclCtx.layerResults.L7 = { proceed: true, dispatched_by: 'stream_handler', duration_ms: 0 };
        emitLayerEnvelope(aoclCtx, 'L7', 'complete', { dispatched_by: 'stream_handler', response_length: text.length, duration_ms: 0 });
        record('L7', 'complete', 0);
      } else {
        bypass('L7', status === 'completed' ? 'stream.no_answer' : `stream.${status}`);
      }

      // L8 on the final text (runL8 reads C5.llmResponse; bypasses itself when there is none).
      aoclCtx.C5 = aoclCtx.C5 || {};
      if (answered) aoclCtx.C5.llmResponse = text;
      const s8 = nowMs();
      let l8;
      try {
        l8 = await byId.L8.run(aoclCtx);
      } catch (err) {
        l8 = { proceed: false, reason: `l8.exception: ${err && err.message}`, extras: { exception: true } };
      }
      const l8Ms = nowMs() - s8;
      const l8Extras = (l8 && l8.extras) || {};
      aoclCtx.layerResults.L8 = { ...l8, ...l8Extras, duration_ms: l8Ms };
      const l8Outcome = l8 && l8.bypass ? 'bypass' : (l8 && l8.proceed === false ? 'reject' : 'complete');
      emitLayerEnvelope(aoclCtx, 'L8', l8Outcome, { ...l8Extras, reason: l8 && l8.reason, duration_ms: l8Ms });
      record('L8', l8Outcome, l8Ms, l8Outcome === 'complete' ? (l8Extras.valid === false ? `warn: ${l8.reason || 'verification_failed'}` : null) : l8 && l8.reason);
      if (l8Outcome === 'reject') {
        verdict = { verdict: 'blocked', layer: 'L8', mode: l8Extras.mode || 'enforce', reason: l8.reason || 'verification_failed', delivered: true };
      } else if (l8Outcome === 'complete' && l8Extras.valid === false) {
        verdict = { verdict: 'warned', layer: 'L8', mode: l8Extras.mode || 'warn', reason: l8.reason || 'verification_failed', delivered: true };
      }

      bypass('L9', 'stream.delivered_incrementally');

      const runIds = [...records.values()].filter(r => r.outcome !== 'bypass').map(r => r.id);
      const bypassIds = [...records.values()].filter(r => r.outcome === 'bypass').map(r => r.id);
      const l10 = await byId.L10.run(aoclCtx);
      const l10Extras = { ...((l10 && l10.extras) || {}), layers_run: runIds, layers_bypassed: bypassIds, layer_count: runIds.length, bypass_count: bypassIds.length };
      aoclCtx.layerResults.L10 = { ...l10, ...l10Extras };
      emitLayerEnvelope(aoclCtx, 'L10', 'complete', l10Extras);
      record('L10', 'complete', 0);
    } finally {
      postMs = nowMs() - t0;
    }
    return { summary: summary(), verdict };
  }

  function summary() {
    const layers = EXPECTED_LAYERS.map(id => records.get(id) || { id, outcome: 'not_run', ms: 0 });
    const count = (o) => layers.filter(l => l.outcome === o).length;
    const rejected = layers.filter(l => l.outcome === 'reject');
    return {
      type: 'aocl.summary',
      corr: aoclCtx.corr || null,
      layers,
      total: EXPECTED_LAYERS.length,
      accounted: layers.filter(l => l.outcome !== 'not_run').length,
      passed: count('complete'),
      bypassed: count('bypass'),
      rejected: rejected.length,
      rejected_at: rejected.length ? rejected[0].id : null,
      pre_ms: Math.round(preMs * 10) / 10,
      post_ms: Math.round(postMs * 10) / 10,
      ms: Math.round((preMs + postMs) * 10) / 10,
      ...(verdict ? { verdict } : {}),
    };
  }

  return { runPre, runPost, summary, get postDone() { return postDone; } };
}

/**
 * Wire a stream AOCL turn into a turnStream (lib/turnStream.js) so the post-stream layers
 * run once at close and their ONE aocl.summary (plus aocl.verdict when L8 flags the
 * already-delivered text) is emitted BEFORE turn.finished.
 *
 * - observes `chunk` and `done` (full_response, interrupted) through turnStream.send
 *   (callers must call turnStream.send late-bound, not a captured reference);
 * - defers turnStream.finish() until the summary is out, so a direct finish() ahead of
 *   res.end is held, and the close path calls finish() again after close() settles;
 * - close() is bounded by timeoutMs: a stuck L8 never holds the stream open.
 *
 * @returns {{ pending: () => boolean, close: () => Promise<void> }}
 */
function attachStreamAoclClose({ turnStream, aoclTurn, timeoutMs = 2000, log = console } = {}) {
  if (!aoclTurn || !turnStream) return { pending: () => false, close: () => Promise.resolve() };
  const seen = { text: '', chunks: '', interrupted: false };
  let sent = false;
  let closing = null;

  const send = turnStream.send;
  turnStream.send = (data) => {
    if (data && data.type === 'chunk' && typeof data.content === 'string') seen.chunks += data.content;
    if (data && data.type === 'done') {
      if (typeof data.full_response === 'string' && data.full_response) seen.text = data.full_response;
      if (data.interrupted) seen.interrupted = true;
    }
    return send(data);
  };
  const finish = turnStream.finish;
  turnStream.finish = () => { if (!sent) return; finish(); };

  function close() {
    if (closing) return closing;
    const st = turnStream.state || {};
    const status = (seen.interrupted || st.interrupted) ? 'interrupted' : (st.failed ? 'failed' : 'completed');
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    closing = Promise.race([aoclTurn.runPost({ text: seen.text || seen.chunks, status }), timeout])
      .then((out) => {
        const summary = out ? out.summary : aoclTurn.summary();
        if (out && out.verdict) turnStream.emit('aocl.verdict', out.verdict);
        const { type: _type, ...fields } = summary;
        turnStream.emit('aocl.summary', fields);
      })
      .catch((err) => { log.warn('[SSE] AOCL post-stream layers failed (non-fatal):', err && err.message); })
      .finally(() => { clearTimeout(timer); sent = true; });
    return closing;
  }

  return { pending: () => !sent, close };
}

module.exports = { createStreamAoclTurn, attachStreamAoclClose, PRE_LAYERS, legacyDenial };
