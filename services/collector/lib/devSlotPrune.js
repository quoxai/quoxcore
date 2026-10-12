'use strict';

/**
 * Pure candidate selection for `POST /api/v1/slots/prune`: slots that are
 * 'free' (never held, not stale) and whose most recent activity is older
 * than the cutoff. Activity = max(released_at, checked_out_at, created_at,
 * last_heartbeat_at); an unparseable/absent timestamp is ignored, and a slot
 * with no usable timestamp at all is NOT a candidate (cannot prove it is old).
 */
function lastActivity(slot) {
  let best = null;
  for (const k of ['released_at', 'checked_out_at', 'created_at', 'last_heartbeat_at']) {
    const t = Date.parse(slot && slot[k]);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

function selectPruneCandidates(slots, { olderThanDays = 14, now = Date.now() } = {}) {
  const cutoff = now - olderThanDays * 86400000;
  const out = [];
  for (const s of slots || []) {
    if (!s || s.state !== 'free') continue;
    const last = lastActivity(s);
    if (last === null || last >= cutoff) continue;
    out.push({
      name: s.name,
      last_activity: new Date(last).toISOString(),
      discord_channel_id: s.discord_channel_id || null,
    });
  }
  return out;
}

/**
 * Orphan Discord slot channels: daemon bindings (mode 'slot') whose slot_name
 * matches NO live slot in ANY org on this instance. The daemon is
 * instance-level and its bindings carry no org, so only a name unused by
 * every org is safe to call orphaned (a name live in org B must never be
 * reaped from org A's call).
 */
function selectOrphanChannels(bindings, allSlotNames) {
  const live = new Set(allSlotNames || []);
  const out = [];
  for (const b of bindings || []) {
    if (!b || b.mode !== 'slot' || !b.channel_id || !b.slot_name) continue;
    if (live.has(b.slot_name)) continue;
    out.push({ slot_name: b.slot_name, channel_id: b.channel_id });
  }
  return out;
}

/**
 * Who may DELETE orphan channels. Orphans are instance-wide, so deleting them
 * from one org admin's call is cross-tenant reach. Rule: only (a) the shared
 * INTERNAL_SERVICE_KEY caller (req.service === true, the instance trust
 * boundary; qmcp_ tokens set req.user, not req.service), (b) a platform
 * 'system_admin' JWT, or (c) a human org admin of the instance OWNER org
 * (env QUOX_INSTANCE_OWNER_ORG_ID, falling back to DEFAULT_ORG_ID; unset
 * means no org qualifies). Anyone else gets the orphan COUNT only.
 */
function canDeleteInstanceOrphans(req, env = process.env) {
  if (!req) return false;
  if (req.service === true) return true;
  const u = req.user;
  if (!u || u.agent_id || u.agent_ops) return false;
  if (u.dashboardRole === 'system_admin') return true;
  const ownerOrg = env.QUOX_INSTANCE_OWNER_ORG_ID || env.DEFAULT_ORG_ID || '';
  const org = u.org_id || u.orgId;
  return Boolean(ownerOrg && org === ownerOrg && ['owner', 'admin'].includes(u.dashboardRole));
}

module.exports = { lastActivity, selectPruneCandidates, selectOrphanChannels, canDeleteInstanceOrphans };
