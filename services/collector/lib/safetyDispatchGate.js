/**
 * quox#503 — the collector chokepoint backstop for the kill switch / DEFCON
 * halt state. Same shape and placement rationale as the REPLAY-ONLY gate
 * (docs/STREAM_REPLAY_ONLY_FABLE_REVIEW.md §4 gate 3 / G10): refuse ABOVE
 * provider resolution so no LLM call of any kind happens for a halted agent
 * or a RED-DEFCON org, and emit a denial envelope as audit evidence the
 * boundary held.
 *
 * Pulled into its own module (rather than living inline in server.js like
 * checkAgentInvokeSafetyGate's REPLAY-ONLY sibling) so it has real unit test
 * coverage instead of source-text assertions — server.js has no supertest
 * harness (see replayOnlyA2CollectorBackstop.test.js's precedent/rationale),
 * but a plain function with injected deps does.
 *
 * Only checks `blocked` (per-agent E-STOP or instance DEFCON RED) — DEFCON
 * ORANGE's escalate/hold semantics are a decision made where a decision is
 * being MADE (autonomyDecision.js / agentScheduler.js pre-dispatch, which
 * has an objective + a human inbox to escalate to); this raw dispatch
 * chokepoint has neither, so ORANGE is not gated here (see
 * killSwitchStore.js's DEFCON level table for the full picture).
 */

const killSwitchStore = require('./killSwitchStore.js');
const policyOverrides = require('./policyOverrides.js');

/**
 * @param {object} deps
 * @param {object} deps.db - better-sqlite3 handle (voltDb)
 * @param {(envelope: object) => void} deps.storeAuditEnvelope
 * @param {{orgId?: string, agentId: string, corr?: string, from?: string}} ctx
 * @returns {null | {error: string, message: string, safety: object}} null when dispatch may proceed
 */
function checkAgentInvokeSafetyGate(deps, { orgId, agentId, corr, from, overrideId } = {}) {
  const { db, storeAuditEnvelope } = deps;
  let gate;
  try {
    gate = killSwitchStore.checkSafetyGate(db, orgId || '__default__', agentId);
  } catch (err) {
    // A throw here means the DB itself is unreadable, not a transient
    // network blip (this is a synchronous local read) — fail closed: a
    // kill switch that goes blind and defaults to permissive is not a
    // kill switch.
    console.error('[Safety] gate check failed, failing closed:', err.message);
    gate = { blocked: true, escalate: false, defcon: 'UNKNOWN', agentHalted: false, reason: `safety state unreadable (${err.message}) — failing closed`, gateError: true };
  }
  if (!gate.blocked) return null;
  const blockId = `safety:${orgId || '__default__'}:${agentId}:${gate.defcon || 'ESTOP'}`;

  // QUOXON-STEPUP: a human-granted, single-use override lets ONE dispatch through a block. It never
  // overrides an unreadable safety state (gateError): that stays fail-closed.
  if (overrideId && !gate.gateError) {
    let used = null;
    try { used = policyOverrides.consume(db, { overrideId, orgId: orgId || '__default__', blockType: 'safety', agentId }); }
    catch (err) { console.warn('[Safety] override consume failed (block stands):', err.message); }
    if (used) {
      if (typeof storeAuditEnvelope === 'function') {
        try {
          storeAuditEnvelope({
            type: 'event', from: from || 'system.safety', to: 'system.aee', intent: 'quox.policy.override.consumed',
            corr: corr || `SAFETY_${Date.now()}`,
            payload: { override_id: used.id, granted_by: used.user_id, agent: agentId, orgId: orgId || '__default__', block_id: used.block_id, reason: used.reason, defcon: gate.defcon },
          });
        } catch (envErr) { console.warn('[Safety] override-consumed envelope failed:', envErr.message); }
      }
      return null;
    }
  }

  if (typeof storeAuditEnvelope === 'function') {
    try {
      storeAuditEnvelope({
        type: 'error',
        from: from || 'system.safety',
        to: 'system.aee',
        intent: 'safety.dispatch.blocked',
        corr: corr || `SAFETY_${Date.now()}`,
        payload: { agent: agentId, orgId: orgId || '__default__', reason: gate.reason, defcon: gate.defcon, block_id: blockId },
      });
    } catch (envErr) {
      console.warn('[Safety] dispatch-blocked denial envelope failed:', envErr.message);
    }
  }

  return {
    error: gate.gateError ? 'SAFETY_GATE_UNAVAILABLE' : 'AGENT_HALTED',
    message: gate.reason,
    block_id: blockId,
    safety: gate,
  };
}

module.exports = { checkAgentInvokeSafetyGate };
