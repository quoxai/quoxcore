/**
 * CommanderQ contactability tools (COMMANDERQ P9 / C1+C3).
 *
 * Governed proactivity, TCPA/PECR-shaped and DENY-BY-DEFAULT. Q uses these to
 * check whether it MAY reach a recipient before proposing any outbound contact,
 * and to PROPOSE (never grant) consent or a standing watch. Consent is a human
 * act — the grant route rejects agents by design, so these tools cannot opt a
 * recipient in. Self-fetch the governed routes; never throw.
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

const COMMANDERQ_CONTACTABILITY_TOOLS = {
  contactability_check: {
    name: 'contactability_check',
    description: 'BEFORE proposing ANY outbound contact (call, message, notification), check whether you may reach this recipient on this channel right now. Deny-by-default: with no recorded opt-in you get decision "deny" (reason no_consent). Inside quiet hours or over a frequency cap you get "defer" with next_allowed_at. Only "allow" means it is permitted. This does NOT send anything — you must still act within governance. Pass recipient and channel (e.g. sms, voice, email).',
    input_schema: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'The contact address/identifier (phone, email, handle).' },
        channel: { type: 'string', description: 'Channel: sms, voice, email, push, etc.' },
        purpose: { type: 'string', description: 'Optional short purpose of the contact.' },
      },
      required: ['recipient', 'channel'],
    },
    async execute(input, ctx) {
      const r = await callCollector('/api/v1/commanderq/contactability/check', ctx, { method: 'POST', body: { recipient: input.recipient, channel: input.channel, purpose: input.purpose } });
      if (!r.ok) return { success: false, error: (r.data && r.data.error) || `check failed (status ${r.status})`, status: r.status };
      return { success: true, ...r.data };
    },
  },

  contactability_propose_optin: {
    name: 'contactability_propose_optin',
    description: 'Propose recording contact consent (opt-in) for a recipient/channel. You CANNOT grant consent yourself — this files a human approval card and changes nothing. Contact stays denied-by-default until a human grants it with a lawful basis. Use when a recipient has expressed willingness to be contacted and a human should confirm/record it.',
    input_schema: {
      type: 'object',
      properties: {
        recipient: { type: 'string' },
        channel: { type: 'string' },
        purpose: { type: 'string' },
        quiet_start: { type: 'string', description: 'Optional quiet-hours start "HH:MM" (recipient local).' },
        quiet_end: { type: 'string', description: 'Optional quiet-hours end "HH:MM".' },
        min_interval_minutes: { type: 'number' },
        max_per_day: { type: 'number' },
      },
      required: ['recipient', 'channel'],
    },
    async execute(input, ctx) {
      const r = await callCollector('/api/v1/commanderq/contactability/policy/propose', ctx, { method: 'POST', body: input });
      if (!r.ok) return { success: false, error: (r.data && r.data.error) || `propose failed (status ${r.status})`, status: r.status };
      return { success: true, ...r.data };
    },
  },

  standing_watch_register: {
    name: 'standing_watch_register',
    description: 'Propose a standing watch (tripwire): a named condition that, when it trips, will PROPOSE a contact or action. Registered as "proposed" and files a human approval card to activate — nothing runs until a human approves, and any resulting outbound still clears the deny-by-default contactability check. Use for governed proactivity ("watch X and let me know when Y").',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name for the watch.' },
        condition: { type: 'string', description: 'Plain-language condition that should trip it.' },
        channel: { type: 'string', description: 'Optional channel it would contact on.' },
        recipient: { type: 'string', description: 'Optional recipient it would contact.' },
      },
      required: ['name', 'condition'],
    },
    async execute(input, ctx) {
      const r = await callCollector('/api/v1/commanderq/contactability/watch', ctx, { method: 'POST', body: input });
      if (!r.ok) return { success: false, error: (r.data && r.data.error) || `watch register failed (status ${r.status})`, status: r.status };
      return { success: true, ...r.data };
    },
  },
};

module.exports = { COMMANDERQ_CONTACTABILITY_TOOLS };
