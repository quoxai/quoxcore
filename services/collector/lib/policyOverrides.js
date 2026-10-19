'use strict';
/**
 * QUOXON-STEPUP part B: policy overrides.
 *
 * A person with a fresh PIN step-up may override ONE blocked action. This module is the generic
 * record: who, what, which block, why, and the step-up token that authorised it. An override is
 * single-use (consumed by the first gate that honours it), short-lived, and bound to org and block
 * type (and agent where the block is per-agent). Only block types listed in HONOURED_BLOCK_TYPES
 * have a gate that actually consumes an override today; for every other type the record is made
 * and witnessed but NOTHING is bypassed (callers must say so, never imply otherwise).
 */
const crypto = require('crypto');

const BLOCK_TYPES = ['safety', 'budget', 'aocl', 'ward'];
const HONOURED_BLOCK_TYPES = ['safety']; // safetyDispatchGate (E-STOP / DEFCON RED dispatch refusal)
const OVERRIDE_TTL_MS = 5 * 60 * 1000;
const MIN_REASON = 8;

function fail(code, message) { const e = new Error(message || code); e.code = code; return e; }

function ensure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_overrides (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      block_type TEXT NOT NULL,
      agent_id TEXT,
      action_summary TEXT,
      reason TEXT NOT NULL,
      step_up_jti TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_policy_overrides_org ON policy_overrides(org_id, created_at DESC);
  `);
}

function record(db, { orgId, userId, blockId, blockType, agentId = null, actionSummary = null, reason, stepUpJti = null, now = Date.now() }) {
  if (!orgId || !userId) throw fail('org_and_user_required');
  if (!blockId || typeof blockId !== 'string') throw fail('block_id_required');
  if (!BLOCK_TYPES.includes(blockType)) throw fail('bad_block_type', `block_type must be one of ${BLOCK_TYPES.join(', ')}`);
  if (typeof reason !== 'string' || reason.trim().length < MIN_REASON) throw fail('reason_required', `reason must be at least ${MIN_REASON} characters`);
  const id = 'ovr_' + crypto.randomBytes(12).toString('hex');
  const expiresAt = now + OVERRIDE_TTL_MS;
  db.prepare(`INSERT INTO policy_overrides (id, org_id, user_id, block_id, block_type, agent_id, action_summary, reason, step_up_jti, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, orgId, userId, blockId.slice(0, 200), blockType, agentId, actionSummary ? String(actionSummary).slice(0, 500) : null, reason.trim().slice(0, 1000), stepUpJti, now, expiresAt);
  return { id, expires_at: expiresAt, enforced: HONOURED_BLOCK_TYPES.includes(blockType) };
}

/** Atomically consume an override for this org + block type (+ agent when bound). Single use. */
function consume(db, { overrideId, orgId, blockType, agentId = null, now = Date.now() }) {
  if (!overrideId || !orgId) return null;
  const row = db.prepare(`SELECT * FROM policy_overrides WHERE id = ?`).get(overrideId);
  if (!row || row.org_id !== orgId || row.block_type !== blockType) return null;
  if (row.agent_id && row.agent_id !== agentId) return null;
  if (row.expires_at < now) return null;
  const info = db.prepare(`UPDATE policy_overrides SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`).run(now, overrideId);
  return info.changes === 1 ? row : null;
}

module.exports = { BLOCK_TYPES, HONOURED_BLOCK_TYPES, OVERRIDE_TTL_MS, MIN_REASON, ensure, record, consume };
