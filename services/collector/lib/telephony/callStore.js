/**
 * Governed outbound-call object (COMMANDERQ P10 / F1+F3).
 *
 * The spine of "CommanderQ calls you": a call is a governed, org-scoped object
 * with a guarded lifecycle and a signed receipt at the end. It exists so that
 * WHEN the audio bridge lands (Discord voice, owner-present), the call is already
 * consented, state-managed, and evidenced — the audio is the last wire, not the
 * governance.
 *
 * DENY-BY-DEFAULT by construction: a call intent is only created after the P9
 * contactability engine ALLOWS it (the caller passes the decision in). A denied
 * intent is still recorded (state 'blocked') as evidence that Q wanted to reach
 * you and correctly held off — the audit trail of restraint, not just of action.
 *
 * States (outbound):
 *   intended  — allowed + queued; the audio bridge would now ring the recipient
 *   blocked   — contactability denied/deferred; NOT dialled (terminal)
 *   connected — recipient answered (driven by the bridge, not built yet)
 *   ended     — completed; carries a signed P4 call_summary artifact (F3)
 *   failed    — ring/connect failed (driven by the bridge)
 *   cancelled — abandoned before connect
 * Live transitions today: intended→cancelled, intended→connected, connected→ended,
 * intended→failed. connected/failed will be driven by the bridge when it exists;
 * the guard already allows them so the bridge needs no schema change.
 *
 * Pure — caller passes the voltDb handle. Reads ALWAYS filter by org_id.
 */

'use strict';

const TERMINAL = new Set(['blocked', 'ended', 'failed', 'cancelled']);
const ALLOWED = {
  intended: new Set(['connected', 'failed', 'cancelled', 'ended']),
  connected: new Set(['ended', 'failed']),
};

function initCallStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      call_ref            TEXT PRIMARY KEY,
      org_id              TEXT NOT NULL,
      direction           TEXT NOT NULL DEFAULT 'outbound',
      channel             TEXT NOT NULL,
      recipient           TEXT NOT NULL,
      purpose             TEXT,
      trigger             TEXT,
      state               TEXT NOT NULL,
      block_reason        TEXT,
      states_json         TEXT NOT NULL DEFAULT '[]',
      summary             TEXT,
      summary_artifact_id TEXT,
      created_by          TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      ended_at            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_calls_org_state ON calls (org_id, state, created_at);
  `);
}

function _now() { return new Date().toISOString(); }

/**
 * Create a call record. `state` is decided by the caller from the contactability
 * verdict: 'intended' when allowed, 'blocked' when denied/deferred (with reason).
 */
function createCall(db, c) {
  if (!c || !c.orgId || !c.callRef || !c.channel || !c.recipient || !c.state) return false;
  const now = c.createdAt || _now();
  db.prepare(`
    INSERT INTO calls (call_ref, org_id, direction, channel, recipient, purpose, trigger, state, block_reason, states_json, created_by, created_at, updated_at)
    VALUES (@call_ref, @org_id, @direction, @channel, @recipient, @purpose, @trigger, @state, @block_reason, @states_json, @created_by, @created_at, @updated_at)
  `).run({
    call_ref: c.callRef,
    org_id: c.orgId,
    direction: c.direction || 'outbound',
    channel: c.channel,
    recipient: c.recipient,
    purpose: c.purpose || null,
    trigger: c.trigger || null,
    state: c.state,
    block_reason: c.blockReason || null,
    states_json: JSON.stringify([{ state: c.state, ts: now, reason: c.blockReason || null }]),
    created_by: c.createdBy || null,
    created_at: now,
    updated_at: now,
  });
  try { require('../lucid/emit.js').callEvent(getCall(db, c.callRef, c.orgId)); } catch { /* LUCID must never break calls */ }
  return true;
}

function getCall(db, callRef, orgId) {
  if (!callRef || !orgId) return null;
  const row = db.prepare('SELECT * FROM calls WHERE call_ref = ? AND org_id = ?').get(callRef, orgId);
  if (!row) return null;
  try { row.states = JSON.parse(row.states_json || '[]'); } catch { row.states = []; }
  return row;
}

/**
 * Guarded state transition. Returns { ok, error?, call? }. Rejects illegal moves
 * (e.g. out of a terminal state, or a transition not in the allow-map).
 */
function transitionCall(db, callRef, orgId, toState, { reason } = {}) {
  const call = getCall(db, callRef, orgId);
  if (!call) return { ok: false, error: 'not_found' };
  if (TERMINAL.has(call.state)) return { ok: false, error: `already_${call.state}` };
  const allowed = ALLOWED[call.state];
  if (!allowed || !allowed.has(toState)) return { ok: false, error: `illegal_transition_${call.state}_to_${toState}` };
  const now = _now();
  const states = call.states.concat([{ state: toState, ts: now, reason: reason || null }]);
  db.prepare('UPDATE calls SET state = ?, states_json = ?, updated_at = ?, ended_at = ? WHERE call_ref = ? AND org_id = ?')
    .run(toState, JSON.stringify(states), now, TERMINAL.has(toState) ? now : call.ended_at, callRef, orgId);
  const updated = getCall(db, callRef, orgId);
  try { require('../lucid/emit.js').callEvent(updated); } catch { /* LUCID must never break calls */ }
  return { ok: true, call: updated };
}

/**
 * End a call with a summary (F3). Attaches the signed call_summary artifact id and
 * moves to 'ended'. Only a non-terminal call can be ended.
 */
function endCallWithSummary(db, callRef, orgId, { summary, summaryArtifactId }) {
  const call = getCall(db, callRef, orgId);
  if (!call) return { ok: false, error: 'not_found' };
  if (TERMINAL.has(call.state)) return { ok: false, error: `already_${call.state}` };
  const now = _now();
  const states = call.states.concat([{ state: 'ended', ts: now, reason: 'summary_recorded' }]);
  db.prepare('UPDATE calls SET state = ?, states_json = ?, summary = ?, summary_artifact_id = ?, updated_at = ?, ended_at = ? WHERE call_ref = ? AND org_id = ?')
    .run('ended', JSON.stringify(states), summary || null, summaryArtifactId || null, now, now, callRef, orgId);
  const ended = getCall(db, callRef, orgId);
  try { require('../lucid/emit.js').callEvent(ended); } catch { /* LUCID must never break calls */ }
  return { ok: true, call: ended };
}

function listCalls(db, orgId, { state, limit = 50 } = {}) {
  if (!orgId) return [];
  const cap = Math.min(Math.max(1, limit | 0), 200);
  const rows = state
    ? db.prepare('SELECT call_ref, channel, recipient, purpose, trigger, state, block_reason, created_at, ended_at, summary_artifact_id FROM calls WHERE org_id = ? AND state = ? ORDER BY created_at DESC LIMIT ?').all(orgId, state, cap)
    : db.prepare('SELECT call_ref, channel, recipient, purpose, trigger, state, block_reason, created_at, ended_at, summary_artifact_id FROM calls WHERE org_id = ? ORDER BY created_at DESC LIMIT ?').all(orgId, cap);
  return rows;
}

module.exports = {
  initCallStore,
  createCall,
  getCall,
  transitionCall,
  endCallWithSummary,
  listCalls,
  TERMINAL,
};
