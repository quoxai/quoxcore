'use strict';

/**
 * slotControl.js - QUOX-CLAUDE-3 (quox#672) remote session control for a held
 * slot. Authority is decided ONLY here, server-side:
 *   - a HUMAN org owner/admin (isHumanAdmin: never a service key, never an
 *     agent or agent-operated session), or
 *   - a service caller (the Discord daemon) naming a discord_user_id that is in
 *     the org setting QUOX_SLOT_CONTROL_DISCORD_IDS (empty = Discord path denied).
 * Agents are always denied: an agent must never control a session.
 * Reading/acking the queue is slot-VOICE only (isSlotVoice), never an admin.
 */

const crypto = require('crypto');
const { isSlotVoice } = require('./devSlotsStore.js');
const { deriveActorType } = require('../utils/actorType.js');
const { callerFromReq } = require('./slotSplinter.js');

const CONTROL_COMMANDS = ['compact', 'status'];
const SETTING_KEY = 'QUOX_SLOT_CONTROL_DISCORD_IDS';
// Owner decision 2026-10-05 (option A): the Discord daemon authenticates with
// an MCP token, which deriveActorType reads as an agent. Only MCP tokens whose
// id is listed here may relay a Discord user's command; every other MCP token
// stays refused. Token ids are identifiers, not secrets.
const RELAY_SETTING_KEY = 'QUOX_SLOT_CONTROL_RELAY_IDS';
// A relay candidate: an MCP-token caller (never an attach token).
function relayTokenId(req) {
  return req && req.mcpToken && req.mcpToken.id && !(req.user && req.user.attach_lease_id) ? String(req.mcpToken.id) : null;
}

function parseIdList(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function createSlotControlStore({ getDb }) {
  const db = () => getDb();
  const now = () => new Date().toISOString();
  return {
    create({ orgId, slotId, slotName, command, requestedBy, requestedVia }) {
      const id = `ctl_${crypto.randomBytes(10).toString('hex')}`;
      db().prepare(`INSERT INTO dev_slot_controls
        (id, org_id, slot_id, slot_name, command, requested_by, requested_via, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(id, orgId, slotId, slotName, command, requestedBy || null, requestedVia, now());
      return id;
    },
    listPending({ orgId, slotId }) {
      return db().prepare(`SELECT id, slot_name, command, requested_by, requested_via, status, created_at
        FROM dev_slot_controls WHERE org_id = ? AND slot_id = ? AND status = 'pending' ORDER BY created_at, rowid`)
        .all(orgId, slotId);
    },
    get({ orgId, slotId, id }) {
      return db().prepare(`SELECT id, slot_name, command, requested_by, requested_via, status, result, created_at, acked_at
        FROM dev_slot_controls WHERE id = ? AND org_id = ? AND slot_id = ?`).get(id, orgId, slotId) || null;
    },
    ack({ orgId, slotId, id, status, result }) {
      const info = db().prepare(`UPDATE dev_slot_controls SET status = ?, result = ?, acked_at = ?
        WHERE id = ? AND org_id = ? AND slot_id = ? AND status = 'pending'`)
        .run(status, result == null ? null : String(result).slice(0, 500), now(), id, orgId, slotId);
      if (info.changes === 1) return { ok: true };
      const row = db().prepare('SELECT status FROM dev_slot_controls WHERE id = ? AND org_id = ? AND slot_id = ?').get(id, orgId, slotId);
      return row ? { ok: false, code: 'already_acked', status: row.status } : { ok: false, code: 'not_found' };
    },
  };
}

function createSlotControlHandlers({ devSlots, store, resolveOrgId, getSetting, isHumanAdmin, audit }) {
  function findSlot(req) {
    const orgId = resolveOrgId(req);
    if (orgId) return devSlots.getSlot({ orgId, name: req.params.name });
    if (req.service) {
      const matches = devSlots.findSlotsByName({ name: req.params.name });
      return matches.length === 1 ? matches[0] : null;
    }
    return null;
  }

  const request = (req, res) => {
    try {
      const actor = deriveActorType(req);
      const body = req.body || {};
      let via;
      let by;
      let discordId = null;
      if (actor === 'human') {
        if (!isHumanAdmin(req)) return res.status(403).json({ error: 'slot control requires an org owner or admin' });
        via = 'cli';
        by = (req.user && (req.user.userId || req.user.id || req.user.email)) || 'human';
      } else if (actor === 'service' || relayTokenId(req)) {
        discordId = body.discord_user_id ? String(body.discord_user_id) : null;
        if (!discordId) return res.status(403).json({ error: 'slot control by a service caller needs discord_user_id' });
        via = 'discord';
        by = `discord:${discordId}`;
      } else {
        return res.status(403).json({ error: 'agents may not control a session' });
      }
      const relayId = actor === 'service' ? null : relayTokenId(req);
      if (!CONTROL_COMMANDS.includes(body.command)) {
        return res.status(400).json({ error: 'unknown command', allowed: CONTROL_COMMANDS });
      }
      const slot = findSlot(req);
      if (!slot) return res.status(404).json({ error: 'unknown slot' });
      if (relayId && !parseIdList(getSetting(slot.org_id, RELAY_SETTING_KEY)).includes(relayId)) {
        return res.status(403).json({ error: 'agents may not control a session' });
      }
      if (via === 'discord') {
        const allowed = parseIdList(getSetting(slot.org_id, SETTING_KEY));
        if (!allowed.includes(discordId)) return res.status(403).json({ error: 'discord user not authorised for slot control' });
      }
      if (slot.state !== 'held') return res.status(409).json({ error: 'slot is not held, nothing to control' });
      const controlId = store.create({
        orgId: slot.org_id, slotId: slot.id, slotName: slot.name, command: body.command, requestedBy: by, requestedVia: via,
      });
      audit({
        type: 'intent', from: by.startsWith('discord:') ? `service.${by}` : `human.${by}`, to: 'audit.system', intent: 'quox.slot.control',
        corr: slot.id,
        payload: { org_id: slot.org_id, name: slot.name, command: body.command, requested_via: via, control_id: controlId, ...(relayId ? { relay_token_id: relayId } : {}) },
      });
      return res.status(201).json({ control_id: controlId });
    } catch (err) {
      console.error('[DevSlots] control failed:', err.message);
      return res.status(500).json({ error: 'control failed' });
    }
  };

  // Requester read of one control's state/result. Same authority as `request`.
  const get = (req, res) => {
    try {
      const actor = deriveActorType(req);
      const q = req.query || {};
      if (actor === 'human') {
        if (!isHumanAdmin(req)) return res.status(403).json({ error: 'slot control requires an org owner or admin' });
      } else if (actor === 'service' || relayTokenId(req)) {
        if (!q.discord_user_id) return res.status(403).json({ error: 'slot control by a service caller needs discord_user_id' });
      } else {
        return res.status(403).json({ error: 'agents may not control a session' });
      }
      const slot = findSlot(req);
      if (!slot) return res.status(404).json({ error: 'unknown slot' });
      const relayId = actor === 'service' ? null : relayTokenId(req);
      if (relayId && !parseIdList(getSetting(slot.org_id, RELAY_SETTING_KEY)).includes(relayId)) {
        return res.status(403).json({ error: 'agents may not control a session' });
      }
      if (actor !== 'human') {
        const allowed = parseIdList(getSetting(slot.org_id, SETTING_KEY));
        if (!allowed.includes(String(q.discord_user_id))) return res.status(403).json({ error: 'discord user not authorised for slot control' });
      }
      const row = store.get({ orgId: slot.org_id, slotId: slot.id, id: req.params.id });
      if (!row) return res.status(404).json({ error: 'unknown control' });
      return res.json(row);
    } catch (err) {
      console.error('[DevSlots] control get failed:', err.message);
      return res.status(500).json({ error: 'control get failed' });
    }
  };

  function voiceSlot(req, res) {
    const orgId = resolveOrgId(req);
    if (!orgId) { res.status(400).json({ error: 'org could not be resolved' }); return null; }
    const slot = devSlots.getSlot({ orgId, name: req.params.name });
    if (!slot) { res.status(404).json({ error: 'unknown slot' }); return null; }
    const session = (req.query && req.query.holder_session) || (req.body && req.body.holder_session) || null;
    if (!isSlotVoice(slot, callerFromReq(req, { session }))) {
      res.status(403).json({ error: 'not slot voice' });
      return null;
    }
    return { orgId, slot, session };
  }

  const pending = (req, res) => {
    try {
      const v = voiceSlot(req, res);
      if (!v) return undefined;
      return res.json({ pending: store.listPending({ orgId: v.orgId, slotId: v.slot.id }) });
    } catch (err) {
      console.error('[DevSlots] control pending failed:', err.message);
      return res.status(500).json({ error: 'control pending failed' });
    }
  };

  const ack = (req, res) => {
    try {
      const status = req.body && req.body.status;
      if (status !== 'done' && status !== 'failed') return res.status(400).json({ error: 'status must be done or failed' });
      const v = voiceSlot(req, res);
      if (!v) return undefined;
      const r = store.ack({ orgId: v.orgId, slotId: v.slot.id, id: req.params.id, status, result: req.body.result });
      if (!r.ok && r.code === 'not_found') return res.status(404).json({ error: 'unknown control' });
      if (!r.ok) return res.status(409).json({ error: 'already acked', status: r.status });
      audit({
        type: 'event', from: `session.${v.session || 'unknown'}`, to: 'audit.system', intent: 'quox.slot.control_ack',
        corr: v.slot.id,
        payload: { org_id: v.orgId, name: v.slot.name, control_id: req.params.id, status },
      });
      return res.json({ acked: true, status });
    } catch (err) {
      console.error('[DevSlots] control ack failed:', err.message);
      return res.status(500).json({ error: 'control ack failed' });
    }
  };

  return { request, pending, ack, get };
}

module.exports = { CONTROL_COMMANDS, SETTING_KEY, parseIdList, createSlotControlStore, createSlotControlHandlers };
