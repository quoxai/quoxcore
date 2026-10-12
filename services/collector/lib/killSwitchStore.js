/**
 * quox#503 — server-side kill switch / DEFCON state store.
 *
 * The console E-STOP/DEFCON controls (src/components/safety/KillSwitch.jsx,
 * src/contexts/SafetyContext.jsx) used to be UI-only: localStorage state
 * with zero server-side consumers. This module is the org-scoped source of
 * truth the collector owns, so a fresh browser sees the same halt state as
 * the one that pressed E-STOP (ZERO TOLERANCE — no browser-only
 * persistence for anything that matters, see repo CLAUDE.md).
 *
 * Mirrors platformSettingsStore.js's shape: plain CRUD against
 * better-sqlite3, plus an append-only history table for the audit trail.
 * Extends the same voltDb the collector process already owns.
 *
 * Two independent scopes:
 *   - per-agent E-STOP   agent_kill_switches (org_id, agent_id) -> active bool
 *   - instance DEFCON    org_defcon_state (org_id)              -> level enum
 *
 * DEFCON level table (severity order, mirrors src/contexts/SafetyContext.jsx
 * DEFCON_LEVELS so the frontend and the enforcement gate agree on meaning):
 *   GREEN  - safe, no gating
 *   BLUE   - low risk, no gating
 *   AMBER  - human-confirm risk tier, no gating at the instance level
 *   ORANGE - hold: autonomous dispatch escalates to a human instead of
 *            running (mirrors autonomyDecision.js's per-agent ORANGE/RED
 *            handling) — the objective/run is NOT silently dropped
 *   RED    - full instance halt: new autonomous dispatch is blocked outright
 *            and live loop sessions are killed at their next turn boundary
 */

function initKillSwitchStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_kill_switches (
      org_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      activated_by TEXT,
      activated_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (org_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_kill_switches_org ON agent_kill_switches(org_id);

    CREATE TABLE IF NOT EXISTS org_defcon_state (
      org_id TEXT PRIMARY KEY,
      level TEXT NOT NULL DEFAULT 'GREEN',
      set_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS safety_state_history (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      agent_id TEXT,
      scope TEXT NOT NULL,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT NOT NULL,
      actor_id TEXT NOT NULL DEFAULT 'unknown',
      actor_label TEXT,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_safety_state_history_org
      ON safety_state_history(org_id, created_at DESC);
  `);
}

function generateHistoryId() {
  return `SSH_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const DEFCON_LEVELS = ['GREEN', 'BLUE', 'AMBER', 'ORANGE', 'RED'];

function appendHistory(db, entry) {
  db.prepare(`
    INSERT INTO safety_state_history (id, org_id, agent_id, scope, action, old_value, new_value, actor_id, actor_label, reason, created_at)
    VALUES (@id, @org_id, @agent_id, @scope, @action, @old_value, @new_value, @actor_id, @actor_label, @reason, @created_at)
  `).run({
    id: generateHistoryId(),
    org_id: entry.org_id,
    agent_id: entry.agent_id ?? null,
    scope: entry.scope,
    action: entry.action,
    old_value: entry.old_value ?? null,
    new_value: entry.new_value,
    actor_id: entry.actor_id || 'unknown',
    actor_label: entry.actor_label ?? null,
    reason: entry.reason ?? null,
    created_at: new Date().toISOString(),
  });
}

/** Whether the given agent is currently E-STOPped for this org. Never fabricates history for a never-seen agent — default is false (not halted). */
function getAgentKillSwitch(db, orgId, agentId) {
  if (!db || !orgId || !agentId) return false;
  const row = db.prepare('SELECT active FROM agent_kill_switches WHERE org_id = ? AND agent_id = ?').get(orgId, agentId);
  return !!row && row.active === 1;
}

function listActiveKillSwitches(db, orgId) {
  if (!db || !orgId) return [];
  return db.prepare(`
    SELECT agent_id, reason, activated_by, activated_at
    FROM agent_kill_switches WHERE org_id = ? AND active = 1
    ORDER BY activated_at DESC
  `).all(orgId);
}

/**
 * Activate or release an agent's E-STOP. Upserts (org_id, agent_id) and
 * appends an 'activated'/'released' history row in the same call.
 */
function setAgentKillSwitch(db, orgId, agentId, active, actor = {}, reason = null) {
  if (!db) throw new Error('kill switch storage not available');
  if (!orgId) throw new Error('org_id is required');
  if (!agentId) throw new Error('agent_id is required');

  const wasActive = getAgentKillSwitch(db, orgId, agentId);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO agent_kill_switches (org_id, agent_id, active, reason, activated_by, activated_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, agent_id) DO UPDATE SET
      active = excluded.active,
      reason = excluded.reason,
      activated_by = excluded.activated_by,
      activated_at = excluded.activated_at,
      updated_at = excluded.updated_at
  `).run(orgId, agentId, active ? 1 : 0, active ? reason : null, active ? (actor.actorId || null) : null, active ? now : null, now);

  appendHistory(db, {
    org_id: orgId,
    agent_id: agentId,
    scope: 'kill_switch',
    action: active ? 'activated' : 'released',
    old_value: String(wasActive),
    new_value: String(!!active),
    actor_id: actor.actorId,
    actor_label: actor.actorLabel || actor.actorId,
    reason,
  });

  return { org_id: orgId, agent_id: agentId, active: !!active, was_active: wasActive };
}

function getDefconLevel(db, orgId) {
  if (!db || !orgId) return 'GREEN';
  const row = db.prepare('SELECT level FROM org_defcon_state WHERE org_id = ?').get(orgId);
  return row?.level || 'GREEN';
}

/**
 * Set the instance-wide DEFCON level for an org. Validates against
 * DEFCON_LEVELS before touching the table — an invalid level throws and
 * writes nothing (fails closed, same posture as platformSettingsStore's
 * key/type validation).
 */
function setDefconLevel(db, orgId, level, actor = {}, reason = null) {
  if (!db) throw new Error('kill switch storage not available');
  if (!orgId) throw new Error('org_id is required');
  if (!DEFCON_LEVELS.includes(level)) {
    throw new Error(`invalid DEFCON level: ${level} (expected one of ${DEFCON_LEVELS.join(', ')})`);
  }

  const oldLevel = getDefconLevel(db, orgId);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO org_defcon_state (org_id, level, set_by, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(org_id) DO UPDATE SET
      level = excluded.level,
      set_by = excluded.set_by,
      updated_at = excluded.updated_at
  `).run(orgId, level, actor.actorId || null, now);

  appendHistory(db, {
    org_id: orgId,
    agent_id: null,
    scope: 'defcon',
    action: 'level_set',
    old_value: oldLevel,
    new_value: level,
    actor_id: actor.actorId,
    actor_label: actor.actorLabel || actor.actorId,
    reason,
  });

  return { org_id: orgId, old_level: oldLevel, new_level: level };
}

function getSafetyHistory(db, { org_id, agent_id, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (org_id) { where.push('org_id = ?'); params.push(org_id); }
  if (agent_id) { where.push('agent_id = ?'); params.push(agent_id); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`
    SELECT * FROM safety_state_history ${whereSql}
    ORDER BY created_at DESC, rowid DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

/** Combined read for the UI on load and for the frontend's server-derived state. */
function getSafetyStatus(db, orgId) {
  return {
    org_id: orgId,
    defcon: getDefconLevel(db, orgId),
    killSwitches: listActiveKillSwitches(db, orgId),
  };
}

/**
 * The enforcement decision every dispatch chokepoint calls. Pure read, no
 * side effects — callers (agentScheduler pre-dispatch, loopDispatch turn
 * boundary, collector chat/invoke routes) decide what to DO with the
 * verdict (skip, escalate, kill a live session).
 *
 * `blocked`  — true means "do not dispatch / kill the live session". Set by
 *              either the per-agent E-STOP or instance DEFCON RED.
 * `escalate` — true means "do not act autonomously, but do not silently
 *              drop it either" — DEFCON ORANGE, mirroring autonomyDecision's
 *              per-agent ORANGE/RED -> ESCALATE handling. Never true when
 *              blocked is true (blocked is the stronger verdict).
 *
 * Callers are responsible for their own fail-closed handling when this
 * function itself cannot be reached (e.g. a cross-service HTTP call that
 * times out) — see services/tasks/lib/safetyGate.js's documented posture.
 */
function checkSafetyGate(db, orgId, agentId) {
  const agentHalted = getAgentKillSwitch(db, orgId, agentId);
  const defcon = getDefconLevel(db, orgId);

  if (agentHalted) {
    return { blocked: true, escalate: false, defcon, agentHalted: true, reason: `Agent ${agentId} is E-STOPped (kill switch active)` };
  }
  if (defcon === 'RED') {
    return { blocked: true, escalate: false, defcon, agentHalted: false, reason: `Instance DEFCON is RED — full halt` };
  }
  if (defcon === 'ORANGE') {
    return { blocked: false, escalate: true, defcon, agentHalted: false, reason: `Instance DEFCON is ORANGE — autonomous dispatch requires human approval` };
  }
  return { blocked: false, escalate: false, defcon, agentHalted: false, reason: null };
}

module.exports = {
  DEFCON_LEVELS,
  initKillSwitchStore,
  getAgentKillSwitch,
  listActiveKillSwitches,
  setAgentKillSwitch,
  getDefconLevel,
  setDefconLevel,
  getSafetyHistory,
  getSafetyStatus,
  checkSafetyGate,
};
