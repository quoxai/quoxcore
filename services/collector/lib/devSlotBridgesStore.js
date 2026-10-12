'use strict';

/**
 * devSlotBridgesStore.js — DEVSUITE-SLOTS phase 9: durable, org-scoped
 * bridge-room config (migrations/aee/014-dev-slot-bridges.sql; design in
 * QuoxPlan DEVSUITE-SLOTS plan v2, note #2837).
 *
 * A slot `say` renders into the owner's Telegram/Discord bridge rooms.
 * Those room ids used to live only in QUOX_SLOT_BRIDGE_ROOM /
 * QUOX_SLOT_DISCORD_ROOM env vars, which violates the no-env-only-config
 * house rule (a feature merged with only an env flag is not done). This
 * store makes the room ids a governed, per-org setting set via
 * `quox slot bridge set/clear`; the env vars remain a fallback only, read
 * by the route (server.js) when no row exists for an org/platform.
 *
 * Same DI shape as devSlotsStore.js: every exported function is bound to a
 * db handle via createDevSlotBridgesStore, so tests run against a
 * throwaway better-sqlite3 db with zero module state.
 */

const PLATFORMS = ['telegram', 'discord'];

function rowToEntry(row) {
  if (!row) return null;
  return {
    platform: row.platform,
    room_id: row.room_id,
    updated_at: row.updated_at,
    updated_by: row.updated_by || null,
    // Phase 10 (trust): the probe verdict travels with the row so every
    // surface can state WHY a bridge is trusted. verified_at null means
    // "never verified" (a pre-migration row, or a --force override), which
    // is a different thing from "verified and failed" and must not be
    // collapsed into it.
    verified_at: row.verified_at || null,
    verified_ok: row.verified_at ? row.verified_ok === 1 : null,
    verified_reason: row.verified_reason || null,
    channel_label: row.channel_label || null,
  };
}

/**
 * @param {object} deps
 * @param {Function} deps.getDb - returns the better-sqlite3 handle (may be
 *   evaluated lazily, matching the aeeDb-not-ready-at-require-time pattern
 *   the dev-slots routes already use).
 * @param {Function} [deps.now] - ISO-8601 clock, test override.
 */
function createDevSlotBridgesStore({ getDb, now = () => new Date().toISOString() } = {}) {
  if (typeof getDb !== 'function') throw new Error('createDevSlotBridgesStore: getDb function is required');

  function db() {
    const handle = getDb();
    if (!handle) throw new Error('devSlotBridgesStore: db not available');
    return handle;
  }

  function listBridges({ orgId } = {}) {
    if (!orgId) throw new Error('listBridges: orgId is required');
    const rows = db().prepare(
      'SELECT * FROM dev_slot_bridges WHERE org_id = ? ORDER BY platform'
    ).all(orgId);
    return rows.map(rowToEntry);
  }

  // Convenience read for the say route: always returns both platform keys
  // (null when unset) so the caller can fall back to the env var per key
  // without a second lookup shape.
  function getBridgeRooms({ orgId } = {}) {
    if (!orgId) throw new Error('getBridgeRooms: orgId is required');
    const rows = listBridges({ orgId });
    const byPlatform = { telegram: null, discord: null };
    for (const row of rows) byPlatform[row.platform] = row.room_id;
    return byPlatform;
  }

  // Phase 10: the full rows keyed by platform, for surfaces that need the
  // verdict and not just the room id (the deck's bridge status, `quox slot
  // bridge list`). Kept separate from getBridgeRooms so the hot `say` path
  // stays the cheap shape it already was.
  function getBridgeDetails({ orgId } = {}) {
    if (!orgId) throw new Error('getBridgeDetails: orgId is required');
    const byPlatform = { telegram: null, discord: null };
    for (const row of listBridges({ orgId })) byPlatform[row.platform] = row;
    return byPlatform;
  }

  function setBridge({ orgId, platform, roomId, updatedBy, verification } = {}) {
    if (!orgId || !platform) throw new Error('setBridge: orgId and platform are required');
    if (!PLATFORMS.includes(platform)) return { ok: false, code: 'bad_platform' };

    const value = roomId == null ? '' : String(roomId).trim();
    if (!value) {
      db().prepare('DELETE FROM dev_slot_bridges WHERE org_id = ? AND platform = ?').run(orgId, platform);
      return { ok: true, cleared: true, platform };
    }

    const t = now();
    // A verification verdict is optional so the store stays usable without a
    // live appservice (tests, and the --force path). When absent the verdict
    // columns are cleared rather than left stale: an unverified write must not
    // inherit the previous room's green tick.
    const v = verification || null;
    db().prepare(`
      INSERT INTO dev_slot_bridges (org_id, platform, room_id, updated_at, updated_by, verified_at, verified_ok, verified_reason, channel_label)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id, platform) DO UPDATE SET
        room_id = excluded.room_id,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by,
        verified_at = excluded.verified_at,
        verified_ok = excluded.verified_ok,
        verified_reason = excluded.verified_reason,
        channel_label = excluded.channel_label
    `).run(
      orgId, platform, value, t, updatedBy || null,
      v ? t : null,
      v ? (v.ok ? 1 : 0) : null,
      v ? (v.reason || null) : null,
      v ? (v.channel_label || null) : null
    );

    const row = db().prepare(
      'SELECT * FROM dev_slot_bridges WHERE org_id = ? AND platform = ?'
    ).get(orgId, platform);
    return { ok: true, cleared: false, entry: rowToEntry(row) };
  }

  return {
    listBridges,
    getBridgeRooms,
    getBridgeDetails,
    setBridge,
  };
}

module.exports = {
  PLATFORMS,
  createDevSlotBridgesStore,
};
