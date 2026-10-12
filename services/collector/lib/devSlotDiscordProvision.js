'use strict';

/**
 * devSlotDiscordProvision.js — DEVSUITE-SLOTS benchmark item 5: the
 * collector's client for the per-slot Discord channel, provisioned through
 * the Discord Pro daemon's control API (the bot token and guild id live
 * with the daemon; this side only ever sees channel ids and webhook URLs).
 *
 * Lifecycle mirrors the slot's Matrix room at the same three call sites
 * (create / heal-on-checkout / retire) with ONE deliberate divergence:
 * RETIRE DOES NOT DELETE THE CHANNEL (owner, 2026-08-20). A Matrix room is
 * infrastructure; a Discord channel is a place a human has been reading.
 * On retire the channel gets a "disconnected" status and stays until a
 * human deletes it.
 *
 * The channel takes the SLOT name and is never renamed per session:
 * Discord does not document the channel-PATCH bucket (checked against
 * docs.discord.com 2026-08-20; headers are the only truth) and the
 * observed name/topic bucket is tight enough that renames degrade silently
 * under churn. The current session lives in the pinned status card
 * (message edits, the generous bucket) plus a best-effort topic.
 *
 * Fail-soft by the same contract as devSlotMatrixProvision: a daemon or
 * Discord outage must NEVER fail the slot create/checkout/retire/release
 * response that triggered it. Callers treat null as "not this attempt";
 * the heal-on-checkout retry is what makes that safe.
 */

const { resolveControl } = require('../routes/discord-pro.js');

// Must match slotChannels.js STATUS_CARD_MARKER in quox-discord-pro: the
// daemon finds the pinned card by this line, and rejects card content
// without it so the contract cannot drift silently.
const STATUS_CARD_MARKER = 'Quox slot status';

const CONTROL_TIMEOUT_MS = Number(process.env.DEV_SLOT_DISCORD_TIMEOUT_MS) || 15000;

async function controlPost(path, body) {
  const control = resolveControl();
  if (!control) {
    // #574: this was the one fully-silent failure mode. When the daemon
    // control endpoint is unresolved (no QDP_CONTROL_URL/token, config
    // unreadable), provisionSlotDiscordChannel returned null with NO log,
    // so from the outside a write-back that never happened looked identical
    // to one that succeeded. Say so, so "did the channel provision?" is
    // always answerable from the collector log.
    console.warn(`[DevSlotDiscord] daemon control not configured (QDP_CONTROL_URL/QDP_CONTROL_TOKEN unset and config unreadable); skipping ${path}`);
    return null;
  }
  try {
    const resp = await fetch(`${control.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-QDP-Token': control.token },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.warn(`[DevSlotDiscord] daemon ${path} returned ${resp.status}: ${text.slice(0, 200)}`);
      return null;
    }
    return await resp.json().catch(() => null);
  } catch (err) {
    console.warn(`[DevSlotDiscord] daemon ${path} failed: ${err.message}`);
    return null;
  }
}

// DELETE counterpart of controlPost. Returns { status, body } (never throws)
// so the caller can tell a 409 (not a slot channel / wrong guild) from an outage.
async function controlDelete(path) {
  const control = resolveControl();
  if (!control) {
    console.warn(`[DevSlotDiscord] daemon control not configured; skipping DELETE ${path}`);
    return { status: 0, body: null, error: 'control_not_configured' };
  }
  try {
    const resp = await fetch(`${control.baseUrl}${path}`, {
      method: 'DELETE',
      headers: { 'X-QDP-Token': control.token },
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    const body = await resp.json().catch(() => null);
    if (!resp.ok) console.warn(`[DevSlotDiscord] daemon DELETE ${path} returned ${resp.status}`);
    return { status: resp.status, body };
  } catch (err) {
    console.warn(`[DevSlotDiscord] daemon DELETE ${path} failed: ${err.message}`);
    return { status: 0, body: null, error: err.message };
  }
}

// GET counterpart. Returns { status, body, error? } (never throws).
async function controlGet(path) {
  const control = resolveControl();
  if (!control) return { status: 0, body: null, error: 'control_not_configured' };
  try {
    const resp = await fetch(`${control.baseUrl}${path}`, {
      method: 'GET',
      headers: { 'X-QDP-Token': control.token },
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    const body = await resp.json().catch(() => null);
    if (!resp.ok) console.warn(`[DevSlotDiscord] daemon GET ${path} returned ${resp.status}`);
    return { status: resp.status, body };
  } catch (err) {
    console.warn(`[DevSlotDiscord] daemon GET ${path} failed: ${err.message}`);
    return { status: 0, body: null, error: err.message };
  }
}

/**
 * The daemon's channel bindings (GET /bindings). Never throws; returns null
 * on any failure (unconfigured, outage, non-2xx, malformed) so callers can
 * report "unknown" rather than guess.
 */
async function getSlotDiscordBindings() {
  const r = await controlGet('/bindings');
  if (!(r.status >= 200 && r.status < 300) || !r.body) return null;
  const list = Array.isArray(r.body) ? r.body : r.body.bindings;
  return Array.isArray(list) ? list : null;
}

/**
 * Delete a slot's Discord channel via the daemon (it only deletes channels it
 * bound as slot channels). Never throws. Returns { ok, deleted, error }.
 */
async function deleteSlotDiscordChannel({ channelId } = {}) {
  if (!channelId) return { ok: false, deleted: false, error: 'no_channel_id' };
  const r = await controlDelete(`/slot-channels/${encodeURIComponent(channelId)}`);
  if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
    return { ok: true, deleted: !!r.body.deleted, error: null };
  }
  const error = r.error || (r.body && r.body.error) || `http_${r.status}`;
  return { ok: false, deleted: false, error };
}

/**
 * Ensure the slot's Discord channel + posting webhook exist. Idempotent by
 * name daemon-side (an existing #<slot-name> is adopted). Returns
 * { channelId, webhookUrl } or null.
 */
async function provisionSlotDiscordChannel({ slotName }) {
  const out = await controlPost('/slot-channels', { name: slotName });
  if (!out || !out.ok || !out.channel_id) return null;
  return { channelId: out.channel_id, webhookUrl: out.webhook_url || null };
}

/** Pinned status card content. The marker line must stay first. */
function slotStatusCardContent({ slotName, state, holderSession, hostId, now = () => new Date().toISOString() }) {
  const lines = [
    `**${STATUS_CARD_MARKER}: ${slotName}**`,
    `state: **${state}**`,
  ];
  if (holderSession) lines.push(`session: \`${holderSession}\``);
  if (hostId) lines.push(`host: \`${hostId}\``);
  if (state === 'retired') lines.push('this slot has been retired; the channel is kept for its history and reads disconnected');
  lines.push(`updated: ${now()}`);
  return lines.join('\n');
}

/**
 * Rewrite the channel's pinned status card (and, best-effort, its topic)
 * to the slot's current state. Fire-and-forget at every call site.
 */
async function updateSlotDiscordStatus({ channelId, slotName, state, holderSession, hostId }) {
  if (!channelId) return null;
  const holder = holderSession ? `held by ${holderSession}` : state;
  return controlPost(`/slot-channels/${encodeURIComponent(channelId)}/status-card`, {
    content: slotStatusCardContent({ slotName, state, holderSession, hostId }),
    topic: `Quox slot "${slotName}" (${holder}). Live status: see the pinned card.`,
  });
}

/** Post a plain bot line into the slot's channel (retire "disconnected"). */
async function postSlotDiscordMessage({ channelId, content }) {
  if (!channelId) return null;
  return controlPost(`/slot-channels/${encodeURIComponent(channelId)}/messages`, { content });
}

module.exports = {
  STATUS_CARD_MARKER,
  provisionSlotDiscordChannel,
  deleteSlotDiscordChannel,
  getSlotDiscordBindings,
  slotStatusCardContent,
  updateSlotDiscordStatus,
  postSlotDiscordMessage,
};
