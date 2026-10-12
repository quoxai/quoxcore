/**
 * OPGOV quox#573 phase 3 — witnessed inventory drift snapshots.
 *
 * Every drift run persists the full inventory payload as a snapshot row and
 * diffs it against the previous one, so "what changed in the org's agent
 * CMDB since last look" is a first-class, witnessed answer instead of a
 * human eyeballing two JSON dumps. Follows the devServersStore pattern:
 * dependency-injected better-sqlite3 handle (the shared aeeDb), schema owned
 * by migrations/aee/031-inventory-snapshots.sql, no server.js import, so the
 * whole module unit-tests against an in-memory db.
 *
 * Honesty rules carried over from the inventory module:
 * - resolved<->unknown transitions are reported as visibility_changes, never
 *   folded into added/removed or silently dropped;
 * - numeric reach deltas are only computed when BOTH sides resolved;
 * - the drift names both sides' completeness so a delta between two
 *   incomplete rollups cannot read as authoritative.
 */

'use strict';

const KEEP_SNAPSHOTS_PER_ORG = 30;

function isResolved(agent) {
  return agent && agent.reach && agent.reach !== 'unknown';
}

/** Pure diff of two inventory payloads (inventory.v1). */
function computeDrift(prev, curr) {
  const prevById = new Map((prev.agents || []).map((a) => [a.id, a]));
  const currById = new Map((curr.agents || []).map((a) => [a.id, a]));

  const agents_added = [];
  const agents_removed = [];
  const model_changes = [];
  const reach_changes = [];
  const visibility_changes = [];

  for (const [id, a] of currById) {
    const p = prevById.get(id);
    if (!p) {
      agents_added.push({ id, source: a.source, model: a.model ?? null });
      continue;
    }
    if ((a.model ?? null) !== (p.model ?? null)) {
      model_changes.push({ id, from: p.model ?? null, to: a.model ?? null });
    }
    const pRes = isResolved(p);
    const cRes = isResolved(a);
    if (pRes !== cRes) {
      visibility_changes.push({ id, from: pRes ? 'resolved' : 'unknown', to: cRes ? 'resolved' : 'unknown' });
    } else if (pRes && cRes) {
      const zones = {};
      for (const zone of ['tools', 'credentials', 'delegates']) {
        const from = p.reach[zone];
        const to = a.reach[zone];
        if (typeof from === 'number' && typeof to === 'number' && from !== to) {
          zones[zone] = { from, to };
        }
      }
      if (Object.keys(zones).length) reach_changes.push({ id, ...zones });
    }
  }
  for (const [id, p] of prevById) {
    if (!currById.has(id)) agents_removed.push({ id, source: p.source, model: p.model ?? null });
  }

  const totalsDelta = {};
  for (const key of ['agents', 'tool_grants', 'credential_grants', 'delegation_edges']) {
    const from = prev.totals ? prev.totals[key] : undefined;
    const to = curr.totals ? curr.totals[key] : undefined;
    if (typeof from === 'number' && typeof to === 'number') totalsDelta[key] = to - from;
  }

  return {
    prev_generated_at: prev.generated_at || null,
    curr_generated_at: curr.generated_at || null,
    prev_complete: !!(prev.totals && prev.totals.complete),
    curr_complete: !!(curr.totals && curr.totals.complete),
    agents_added,
    agents_removed,
    model_changes,
    reach_changes,
    visibility_changes,
    totals_delta: totalsDelta,
    changed: !!(agents_added.length || agents_removed.length || model_changes.length
      || reach_changes.length || visibility_changes.length),
  };
}

function latestSnapshot(db, orgId) {
  const row = db.prepare(
    'SELECT id, org_id, taken_at, payload_json FROM inventory_snapshots WHERE org_id = ? ORDER BY id DESC LIMIT 1',
  ).get(orgId);
  if (!row) return null;
  try {
    return { id: row.id, org_id: row.org_id, taken_at: row.taken_at, payload: JSON.parse(row.payload_json) };
  } catch {
    return null;
  }
}

function saveSnapshot(db, { orgId, inventory, nowIso }) {
  const takenAt = (typeof nowIso === 'function' ? nowIso() : null) || inventory.generated_at || new Date().toISOString();
  const totals = inventory.totals || {};
  const info = db.prepare(
    `INSERT INTO inventory_snapshots (org_id, taken_at, agents, tool_grants, credential_grants, complete, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    orgId,
    takenAt,
    typeof totals.agents === 'number' ? totals.agents : 0,
    typeof totals.tool_grants === 'number' ? totals.tool_grants : 0,
    typeof totals.credential_grants === 'number' ? totals.credential_grants : 0,
    totals.complete ? 1 : 0,
    JSON.stringify(inventory),
  );
  // Retire old rows so the table cannot grow without bound (the volt.db
  // lesson): keep the newest KEEP_SNAPSHOTS_PER_ORG per org.
  db.prepare(
    `DELETE FROM inventory_snapshots WHERE org_id = ? AND id NOT IN (
       SELECT id FROM inventory_snapshots WHERE org_id = ? ORDER BY id DESC LIMIT ?
     )`,
  ).run(orgId, orgId, KEEP_SNAPSHOTS_PER_ORG);
  return { id: info.lastInsertRowid, taken_at: takenAt };
}

/**
 * The drift run: diff the fresh inventory against the last stored snapshot,
 * then store the fresh one as the new baseline. First run returns
 * baseline: true and no drift (there is nothing honest to diff against).
 */
function runDrift({ db, orgId, inventory, nowIso }) {
  const prev = latestSnapshot(db, orgId);
  const drift = prev ? computeDrift(prev.payload, inventory) : null;
  const saved = saveSnapshot(db, { orgId, inventory, nowIso });
  return {
    v: 1,
    schema: 'inventory-drift.v1',
    org_id: orgId,
    baseline: !prev,
    snapshot_id: saved.id,
    taken_at: saved.taken_at,
    prev_taken_at: prev ? prev.taken_at : null,
    drift,
  };
}

module.exports = { computeDrift, runDrift, latestSnapshot, saveSnapshot, KEEP_SNAPSHOTS_PER_ORG };
