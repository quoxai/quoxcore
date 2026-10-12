/**
 * CommanderQ outbound-call tools (COMMANDERQ P10 / F1+F3).
 *
 * "CommanderQ calls you." Q can RAISE a call intent (e.g. a tripwire wants to warn
 * the owner of a security incident) — which is DENY-BY-DEFAULT gated by the P9
 * contactability engine — and CLOSE a call with a signed, receipted summary. The
 * actual audio bridge (Discord voice) is not wired yet; these tools govern,
 * evidence, and state-manage the call. Self-fetch the governed routes; never throw.
 */

'use strict';

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://localhost:9848';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

async function callCollector(path, ctx, { method = 'GET', body } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Service-Key': INTERNAL_SERVICE_KEY,
    ...(ctx && ctx.orgId ? { 'x-org-id': ctx.orgId } : {}),
    ...(ctx && ctx.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
  };
  try {
    const res = await fetch(`${COLLECTOR_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: `Collector unreachable (${err.message}).` } };
  }
}

const COMMANDERQ_CALL_TOOLS = {
  call_raise_intent: {
    name: 'call_raise_intent',
    description: 'Raise an intent to CALL the owner/recipient (e.g. you detected something urgent like a security incident and want to reach them by voice). This is DENY-BY-DEFAULT: it only becomes a real intent if the recipient has consented and quiet-hours/frequency allow — otherwise it is recorded as blocked and no call happens. It does NOT place audio yet (the Discord voice bridge is not wired); it governs and evidences the decision to call. Pass recipient, channel (e.g. discord, voice), a short purpose, and the trigger that prompted it.',
    input_schema: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'Who to call (handle/id/number).' },
        channel: { type: 'string', description: 'Channel: discord, voice, phone.' },
        purpose: { type: 'string', description: 'Why you want to call, in one line.' },
        trigger: { type: 'string', description: 'What prompted this (e.g. "sentinel: critical intrusion alert").' },
      },
      required: ['recipient', 'channel', 'purpose'],
    },
    async execute(input, ctx) {
      const r = await callCollector('/api/v1/commanderq/calls/intent', ctx, { method: 'POST', body: input });
      if (!r.ok) return { success: false, error: (r.data && r.data.error) || `call intent failed (status ${r.status})`, status: r.status };
      return { success: true, ...r.data };
    },
  },

  call_provider_readiness: {
    name: 'call_provider_readiness',
    description: 'Report which outbound-call channels are ready and exactly what credentials or hookups each still needs before real calls can be placed (e.g. Twilio needs TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM; Discord needs the voice bridge). Use when the user asks "can you actually call me yet" or "what do you need to call me".',
    input_schema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      const r = await callCollector('/api/v1/commanderq/calls/providers', ctx);
      if (!r.ok) return { success: false, error: (r.data && r.data.error) || `readiness failed (status ${r.status})`, status: r.status };
      return { success: true, ...r.data };
    },
  },

  call_summarize_and_end: {
    name: 'call_summarize_and_end',
    description: 'Close a call with a receipted, signed summary (the durable record of what was said/decided). Provide the call_ref and a concise summary. Records a signed call_summary artifact as evidence.',
    input_schema: {
      type: 'object',
      properties: {
        call_ref: { type: 'string', description: 'The call reference returned by call_raise_intent.' },
        summary: { type: 'string', description: 'Concise summary of the call: what was conveyed and any decision/outcome.' },
        participants: { type: 'array', items: { type: 'string' }, description: 'Optional list of participants.' },
      },
      required: ['call_ref', 'summary'],
    },
    async execute(input, ctx) {
      const r = await callCollector(`/api/v1/commanderq/calls/${encodeURIComponent(input.call_ref)}/end`, ctx, {
        method: 'POST', body: { summary: input.summary, participants: input.participants },
      });
      if (!r.ok) return { success: false, error: (r.data && r.data.error) || `call end failed (status ${r.status})`, status: r.status };
      return { success: true, ...r.data };
    },
  },
};

module.exports = { COMMANDERQ_CALL_TOOLS };
