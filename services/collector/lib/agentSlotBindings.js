'use strict';

/**
 * agentSlotBindings.js — QuoxIdentity P3 (territory F, collector): the
 * durable, org-scoped pointer from an agent identity to a slot ADDRESS.
 * See docs/QUOXIDENTITY_P3_CONTRACT.md and migrations/aee/029-agent-slot-bindings.sql.
 *
 * A binding is pure pointer state: setting one does NOT create the slot it
 * names (see server.js's route, which 404s if the named dev_slots row does
 * not exist in the org before calling setBinding here), and this store
 * never reaches into dev_slots itself — it only enforces its own two
 * UNIQUE invariants ("one slot per agent, one agent per slot, org-scoped").
 *
 * Same DI shape as devSlotsStore.js / devSlotBridgesStore.js: every
 * exported function is bound to a db handle via createAgentSlotBindingsStore,
 * so tests run against a throwaway better-sqlite3 db with zero module state.
 */

const crypto = require('crypto');

function newBindingId() {
  return `aslotbind_${crypto.randomBytes(12).toString('hex')}`;
}

function isUniqueViolation(err) {
  return !!err && typeof err.message === 'string' && err.message.includes('UNIQUE');
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    org_id: row.org_id,
    agent_id: row.agent_id,
    slot_name: row.slot_name,
    created_by: row.created_by || null,
    created_at: row.created_at,
  };
}

/**
 * @param {object} deps
 * @param {Function} deps.getDb - returns the better-sqlite3 handle (may be
 *   evaluated lazily, matching the aeeDb-not-ready-at-require-time pattern
 *   the dev-slots routes already use).
 * @param {Function} [deps.now] - ISO-8601 clock, test override.
 */
function createAgentSlotBindingsStore({ getDb, now = () => new Date().toISOString() } = {}) {
  if (typeof getDb !== 'function') throw new Error('createAgentSlotBindingsStore: getDb function is required');

  function db() {
    const handle = getDb();
    if (!handle) throw new Error('agentSlotBindings: db not available');
    return handle;
  }

  function getBindingRow(orgId, agentId) {
    return db().prepare('SELECT * FROM agent_slot_bindings WHERE org_id = ? AND agent_id = ?').get(orgId, agentId) || null;
  }

  function getBinding({ orgId, agentId } = {}) {
    if (!orgId || !agentId) throw new Error('getBinding: orgId and agentId are required');
    return rowToRecord(getBindingRow(orgId, agentId));
  }

  // Binding lookup BY SLOT NAME — used by kit hydration to go the other
  // direction is not needed (kit already has the agent id); this is here
  // for completeness of the org-scoped pair and for future GET-by-slot
  // surfaces, kept deliberately simple (no extra index needed beyond the
  // UNIQUE(org_id, slot_name) constraint already backing lookups).
  function getBindingBySlot({ orgId, slotName } = {}) {
    if (!orgId || !slotName) throw new Error('getBindingBySlot: orgId and slotName are required');
    return rowToRecord(
      db().prepare('SELECT * FROM agent_slot_bindings WHERE org_id = ? AND slot_name = ?').get(orgId, slotName)
    );
  }

  function listBindings({ orgId } = {}) {
    if (!orgId) throw new Error('listBindings: orgId is required');
    const rows = db().prepare('SELECT * FROM agent_slot_bindings WHERE org_id = ? ORDER BY agent_id').all(orgId);
    return rows.map(rowToRecord);
  }

  // No UPSERT here on purpose: a rebind is delete-then-insert at the CALLER
  // (route) layer, never an UPDATE in this store. An UPDATE on an existing
  // agent-row's slot_name (or an existing slot-row's agent_id) could
  // silently collide with the OTHER UNIQUE constraint and either violate it
  // opaquely or (with an INSERT OR REPLACE shape) quietly orphan the paired
  // row — see the migration file header. setBinding therefore only ever
  // INSERTs a fresh row and reports which invariant a conflict violated.
  function setBinding({ orgId, agentId, slotName, createdBy } = {}) {
    if (!orgId || !agentId || !slotName) {
      throw new Error('setBinding: orgId, agentId and slotName are required');
    }
    const t = now();
    try {
      db().prepare(`
        INSERT INTO agent_slot_bindings (id, org_id, agent_id, slot_name, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(newBindingId(), orgId, agentId, slotName, createdBy || null, t);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Distinguish WHICH invariant tripped so the route can return a
        // precise error rather than a generic conflict: an existing binding
        // on this agent_id is a different problem for the caller to fix
        // (unbind first) than an existing binding on this slot_name
        // (someone else already owns that address).
        const existingForAgent = getBindingRow(orgId, agentId);
        if (existingForAgent) return { ok: false, code: 'agent_already_bound' };
        return { ok: false, code: 'slot_already_bound' };
      }
      throw err;
    }
    return { ok: true, binding: getBinding({ orgId, agentId }) };
  }

  function deleteBinding({ orgId, agentId } = {}) {
    if (!orgId || !agentId) throw new Error('deleteBinding: orgId and agentId are required');
    const info = db().prepare('DELETE FROM agent_slot_bindings WHERE org_id = ? AND agent_id = ?').run(orgId, agentId);
    return { ok: true, deleted: info.changes > 0 };
  }

  return {
    getBinding,
    getBindingBySlot,
    listBindings,
    setBinding,
    deleteBinding,
  };
}

module.exports = {
  createAgentSlotBindingsStore,
};
