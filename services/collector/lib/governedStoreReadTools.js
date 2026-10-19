'use strict';
/**
 * QUOXON-ENGINE lane N, class 1 (quox#837): the governed QuoxVoice call record as an agent
 * read, the same store `quox voice calls` and the QuoxVoice Console read
 * (lib/telephony/voiceCallStore.js). Raw provider logs (twilio_list_calls) carry no turn
 * counts and mislabel direction; turnToolSelection withholds them when this tool is in
 * the pool and the user asks about calls.
 *
 * Org from the turn (ctx.orgId), never from the model. The counterparty number is masked
 * to its last four digits (ContactsQ rule: agents never hold a raw number). The totals come
 * from the whole store, not the page, so "N calls in total" is a total the tool returned.
 * A store that cannot be read is success:false with the reason, never "no calls".
 */

const NO_ORG = { success: false, error: 'No organization context for this turn; refusing to read.' };

function maskPeer(peer) {
  const s = String(peer || '');
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 4) return `***${digits.slice(-4)}`;
  return '***';
}

function shapeCall(c) {
  const dur = typeof c.started_at === 'number' && typeof c.ended_at === 'number' && c.ended_at > c.started_at
    ? Math.round((c.ended_at - c.started_at) / 1000) : null;
  return {
    call_sid: c.call_sid,
    direction: c.direction || 'unknown',
    peer: maskPeer(c.peer),
    started_at: c.started_at ? new Date(c.started_at).toISOString() : null,
    duration_sec: dur,
    turns: Array.isArray(c.transcript) ? c.transcript.length : 0,
    summary: String(c.summary || '').slice(0, 400),
  };
}

const voice_calls = {
  name: 'voice_calls',
  description: 'List the org\'s QuoxVoice calls from the governed call record (the store `quox voice calls` reads): direction (inbound or outbound), time, duration, turn count and summary, plus whole-store totals. Use this for any question about calls; raw provider logs (Twilio) do not track turns or Quox direction. Read-only.',
  input_schema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'How many recent calls to return (1-50, default 20; 0 for totals only, the cheap answer to how-many asks).' },
      direction: { type: 'string', enum: ['inbound', 'outbound'], description: 'Optional filter.' },
    },
    required: [],
  },
  execute: async (input, ctx) => {
    const orgId = ctx && ctx.orgId;
    if (!orgId) return NO_ORG;
    // limit 0 = totals only (a count ask never needs the rows).
    const asked = parseInt(input && input.limit, 10);
    const limit = asked === 0 ? 0 : Math.min(Math.max(asked || 20, 1), 50);
    try {
      const store = require('./telephony/voiceCallStore.js');
      let calls = (limit === 0 ? [] : store.listForOrg(orgId, input && input.direction ? 200 : limit)).map(shapeCall);
      if (input && input.direction) calls = calls.filter((c) => String(c.direction).toLowerCase().startsWith(input.direction.slice(0, 2))).slice(0, limit);
      const stats = store.statsForOrg(orgId);
      return {
        success: true,
        source: 'QuoxVoice call record',
        as_of: new Date().toISOString(),
        count: calls.length,
        total: stats.total_calls,
        totals: { calls: stats.total_calls, inbound: stats.inbound, outbound: stats.outbound, turns: stats.total_turns, avg_turns: stats.avg_turns },
        last_call_at: stats.last_call_at ? new Date(stats.last_call_at).toISOString() : null,
        calls,
      };
    } catch (e) {
      return { success: false, error: `The QuoxVoice call record could not be read (${(e && e.code) || 'error'}). Say so; do not answer from another source.` };
    }
  },
};

// The per-line policy keys that may hold a phone number; masked to last-4 on the
// way out so an agent never holds a raw third-party / owner-personal number
// (the same ContactsQ rule maskPeer enforces for call counterparties).
function sanitizePolicy(policy) {
  if (!policy || typeof policy !== 'object') return {};
  const out = { ...policy };
  if ('forward_to_mobile' in out) out.forward_to_mobile = maskPeer(out.forward_to_mobile);
  if (Array.isArray(out.caller_allowlist)) out.caller_allowlist = out.caller_allowlist.map(maskPeer);
  return out;
}

// QUOXON voice settings as an agent read: the same per-line policy the CLI
// `quox voice numbers list` and the QuoxVoice Console show (lib/telephony/numbersStore.js).
// Org from the turn (ctx.orgId), never the model. Phone-number policy fields are masked.
const voice_numbers = {
  name: 'voice_numbers',
  description: 'List this org\'s QuoxVoice phone lines (QuoxLines) and their per-line policy: the opener brand and name the line answers with, whether the IVR menu is on, voice, language, persona, verbosity, PIN requirement and recording mode. The same config `quox voice numbers list` and the QuoxVoice Console read. Use this for any question about how a line answers or is configured. Read-only; phone numbers in the policy are masked.',
  input_schema: {
    type: 'object',
    properties: {
      number: { type: 'string', description: 'Optional E.164 line to report on (e.g. +447782222972); omit to list all the org\'s lines.' },
    },
    required: [],
  },
  execute: async (input, ctx) => {
    const orgId = ctx && ctx.orgId;
    if (!orgId) return NO_ORG;
    try {
      const store = require('./telephony/numbersStore.js');
      let lines = store.listForOrg(orgId);
      const want = input && input.number ? String(input.number).trim() : null;
      if (want) lines = lines.filter((l) => l.number === want);
      return {
        success: true,
        source: 'QuoxVoice per-line policy',
        as_of: new Date().toISOString(),
        count: lines.length,
        lines: lines.map((l) => ({ number: l.number, label: l.label || null, policy: sanitizePolicy(l.policy) })),
      };
    } catch (e) {
      return { success: false, error: `The QuoxVoice line policy could not be read (${(e && e.code) || 'error'}). Say so; do not answer from another source.` };
    }
  },
};

// class 5: the exact real TUI / CLI command for an ask (lib/commandGuidance.js).
const { quox_command_lookup } = require('./commandGuidance');

// QUOXON-AGG (quox#900): named aggregate reads (lib/aggregateReadTools.js).
const { AGGREGATE_READ_TOOLS } = require('./aggregateReadTools');

const GOVERNED_STORE_READ_TOOLS = { voice_calls, voice_numbers, quox_command_lookup, ...AGGREGATE_READ_TOOLS };

module.exports = { GOVERNED_STORE_READ_TOOLS, maskPeer, shapeCall };
