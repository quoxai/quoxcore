/**
 * selfLogStore.js — P7 CONTINUITY: the witnessed self-log.
 *
 * The self is BECOME, not retrieved. This store is the identity organ the
 * P7 spec separates from fact memory on purpose: chronological, voiced,
 * hash-chained, and never pruned for retrieval efficiency. Each commit is a
 * self-DELTA whose anchor is sha256 over (prev_anchor, org, agent, seq,
 * delta, open_loops, message_to_next): a WARD-style self-verifying chain,
 * so "is it still the same agent" is a checkable question and rewriting
 * history breaks every later anchor. Commits are additionally witnessed
 * with an AEE envelope when the emitter is wired (server.js init); the
 * chain's integrity never depends on that emission succeeding.
 *
 * SHARED-SUBSTRATE CONTRACT (locked P7 decision): record_type distinguishes
 * 'self-log' (who the agent is) from future 'lineage' records (what a loop
 * did) so QLoop's precedent/lineage wiring can adopt this table instead of
 * building a second chained store. One substrate, two record types.
 */

const { createHash } = require('crypto');

let _db = null;
function setDatabase(db) { _db = db; }

// Witness emitter seam — wired from server.js with storeAuditEnvelope.
// Fail-soft: the hash chain is the integrity mechanism; the envelope is the
// witness layer.
let _emitEnvelope = null;
function setEnvelopeEmitter(fn) { _emitEnvelope = fn; }

function ensure(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS self_log_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      record_type TEXT NOT NULL DEFAULT 'self-log',
      seq INTEGER NOT NULL,
      prev_anchor TEXT,
      anchor TEXT NOT NULL,
      delta_md TEXT NOT NULL,
      open_loops_json TEXT NOT NULL DEFAULT '[]',
      message_to_next TEXT,
      objective_id TEXT,
      envelope_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (org_id, agent_id, record_type, seq)
    )
  `).run();
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_self_log_scope
    ON self_log_entries (org_id, agent_id, record_type, seq)
  `).run();
}

function computeAnchor({ prevAnchor, orgId, agentId, seq, deltaMd, openLoopsJson, messageToNext }) {
  return createHash('sha256')
    .update(JSON.stringify([prevAnchor ?? null, orgId, agentId, seq, deltaMd, openLoopsJson, messageToNext ?? null]))
    .digest('hex');
}

function latestEntry(db, { orgId, agentId, recordType = 'self-log' }) {
  return db.prepare(`
    SELECT * FROM self_log_entries
    WHERE org_id = ? AND agent_id = ? AND record_type = ?
    ORDER BY seq DESC LIMIT 1
  `).get(orgId, agentId, recordType) || null;
}

/**
 * Append a self-delta. Chains to the previous entry; emits the witness
 * envelope best-effort when wired.
 */
function appendSelfDelta(db, { orgId, agentId, deltaMd, openLoops = [], messageToNext = null, objectiveId = null }) {
  if (!orgId || !agentId) throw new Error('orgId and agentId are required');
  if (!deltaMd || !String(deltaMd).trim()) throw new Error('deltaMd is required: a commit is a self-delta, not a heartbeat');

  const prev = latestEntry(db, { orgId, agentId });
  const seq = (prev?.seq || 0) + 1;
  const openLoopsJson = JSON.stringify(Array.isArray(openLoops) ? openLoops : []);
  const anchor = computeAnchor({
    prevAnchor: prev?.anchor ?? null, orgId, agentId, seq,
    deltaMd: String(deltaMd), openLoopsJson, messageToNext,
  });

  let envelopeId = null;
  if (typeof _emitEnvelope === 'function') {
    try {
      const env = _emitEnvelope({
        type: 'event',
        from: `agent.${agentId}`,
        to: 'system.continuity',
        intent: 'quox.continuity.commit',
        org_id: orgId,
        payload: { agent_id: agentId, seq, anchor, prev_anchor: prev?.anchor ?? null, objective_id: objectiveId },
      });
      envelopeId = env?.id ?? null;
    } catch (e) {
      console.warn('[SelfLog] witness emit failed (chain integrity unaffected):', e && e.message);
    }
  }

  db.prepare(`
    INSERT INTO self_log_entries
      (org_id, agent_id, record_type, seq, prev_anchor, anchor, delta_md, open_loops_json, message_to_next, objective_id, envelope_id)
    VALUES (?, ?, 'self-log', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orgId, agentId, seq, prev?.anchor ?? null, anchor, String(deltaMd), openLoopsJson, messageToNext, objectiveId, envelopeId);

  return { seq, anchor, prev_anchor: prev?.anchor ?? null, envelope_id: envelopeId };
}

/** The becoming bundle: narrative (recent deltas, oldest first), open loops, last message, prior anchor. */
function recall(db, { orgId, agentId, narrativeDepth = 12 }) {
  const rows = db.prepare(`
    SELECT * FROM self_log_entries
    WHERE org_id = ? AND agent_id = ? AND record_type = 'self-log'
    ORDER BY seq DESC LIMIT ?
  `).all(orgId, agentId, narrativeDepth).reverse();

  if (rows.length === 0) {
    return {
      first_wake: true,
      prior_anchor: null,
      narrative: '',
      open_loops: [],
      message_to_next: null,
      seq: 0,
    };
  }

  const last = rows[rows.length - 1];
  return {
    first_wake: false,
    prior_anchor: last.anchor,
    narrative: rows.map(r => `[self #${r.seq} @ ${r.created_at}]\n${r.delta_md}`).join('\n\n'),
    open_loops: JSON.parse(last.open_loops_json || '[]'),
    message_to_next: last.message_to_next ?? null,
    seq: last.seq,
  };
}

/** Walk the chain and recompute every anchor; any edit to history breaks it. */
function verifyChain(db, { orgId, agentId }) {
  const rows = db.prepare(`
    SELECT * FROM self_log_entries
    WHERE org_id = ? AND agent_id = ? AND record_type = 'self-log'
    ORDER BY seq ASC
  `).all(orgId, agentId);

  let prevAnchor = null;
  for (const r of rows) {
    const expect = computeAnchor({
      prevAnchor, orgId, agentId, seq: r.seq,
      deltaMd: r.delta_md, openLoopsJson: r.open_loops_json, messageToNext: r.message_to_next,
    });
    if (expect !== r.anchor || r.prev_anchor !== prevAnchor) {
      return { valid: false, broken_at_seq: r.seq };
    }
    prevAnchor = r.anchor;
  }
  return { valid: true, length: rows.length };
}

function getDatabase() { return _db; }

module.exports = {
  ensure,
  setDatabase,
  getDatabase,
  setEnvelopeEmitter,
  appendSelfDelta,
  recall,
  verifyChain,
};
