/**
 * CommanderQ COMMITMENT tools (COMMANDERQ P8) — commitment ledger.
 *
 * Lets CommanderQ treat a promise as a governed object: record it (signed
 * `commitment` artifact + ledger row), find open/overdue ones, and resolve them
 * (fulfilled / escalated / cancelled). Escalation surfaces to a human inbox; Q
 * never silently drops a promise. Thin never-throw self-fetch wrappers over the
 * /api/v1/commitments routes (own copy of the helper, same posture as the other
 * commanderq tool families).
 */

'use strict';

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://localhost:9848';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const FETCH_TIMEOUT_MS = 15000;

async function callCollector(path, ctx, { method = 'GET', body } = {}) {
  const url = `${COLLECTOR_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Service-Key': INTERNAL_SERVICE_KEY,
    ...(ctx && ctx.orgId ? { 'x-org-id': ctx.orgId } : {}),
    ...(ctx && ctx.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
  };
  try {
    const res = await fetch(url, {
      method, headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    let data = null;
    try { data = await res.json(); }
    catch { try { data = { raw: await res.text() }; } catch { data = null; } }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: `Collector unreachable (${err.message}).` } };
  }
}

const COMMANDERQ_COMMITMENT_TOOLS = {
  commitment_create: {
    name: 'commitment_create',
    description: 'Record a promise you are making as a governed commitment: a signed, witnessed object with an owner, an optional due time, and a channel. Use whenever you tell the user you will do something later ("I\'ll call back with the deploy result", "I\'ll chase this by 5pm") so it can be tracked, chased, and never silently dropped. Returns a commitment_id.',
    input_schema: {
      type: 'object',
      properties: {
        promise: { type: 'string', description: 'The promise, in plain language.' },
        owner: { type: 'string', description: 'Who is responsible (agent id or human ref). Defaults to you (agent.quox) if omitted upstream.' },
        due_at: { type: 'string', description: 'Optional ISO8601 deadline.' },
        channel: { type: 'string', description: 'Optional channel where it will be fulfilled (chat/telegram/call).' },
      },
      required: ['promise', 'owner'],
    },
    async execute(input, ctx) {
      const r = await callCollector('/api/v1/commitments', ctx, {
        method: 'POST',
        body: { promise: input.promise, owner: input.owner, due_at: input.due_at, channel: input.channel },
      });
      if (!r.ok) return { success: false, error: (r.data && r.data.error) || `create failed (status ${r.status})`, status: r.status };
      return { success: true, ...r.data };
    },
  },

  commitment_list: {
    name: 'commitment_list',
    description: 'List commitments for this org. filter: "open" (default), "overdue" (open and past due), "all", or a specific status (fulfilled/escalated/cancelled). Use "overdue" to find promises that need chasing.',
    input_schema: {
      type: 'object',
      properties: { filter: { type: 'string', description: 'open | overdue | all | fulfilled | escalated | cancelled' } },
    },
    async execute(input, ctx) {
      const filter = input.filter || 'open';
      const r = await callCollector(`/api/v1/commitments?filter=${encodeURIComponent(filter)}`, ctx, { method: 'GET' });
      if (!r.ok) return { success: false, error: (r.data && r.data.error) || `list failed (status ${r.status})`, status: r.status };
      return { success: true, ...r.data };
    },
  },

  commitment_resolve: {
    name: 'commitment_resolve',
    description: 'Resolve a commitment: mark it fulfilled, escalated, or cancelled (with an optional note). Escalating files a human inbox card. Only an open commitment can be resolved. Use when you have delivered on a promise, or when it needs a human.',
    input_schema: {
      type: 'object',
      properties: {
        commitment_id: { type: 'string' },
        status: { type: 'string', enum: ['fulfilled', 'escalated', 'cancelled'] },
        note: { type: 'string', description: 'Optional short note on the resolution.' },
      },
      required: ['commitment_id', 'status'],
    },
    async execute(input, ctx) {
      const id = encodeURIComponent(input.commitment_id || '');
      const r = await callCollector(`/api/v1/commitments/${id}/resolve`, ctx, {
        method: 'POST',
        body: { status: input.status, note: input.note },
      });
      if (!r.ok) return { success: false, error: (r.data && r.data.error) || `resolve failed (status ${r.status})`, status: r.status };
      return { success: true, ...r.data };
    },
  },
};

module.exports = { COMMANDERQ_COMMITMENT_TOOLS };
