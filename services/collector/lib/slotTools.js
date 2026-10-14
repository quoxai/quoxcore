'use strict';

/**
 * slotTools.js — QUOXIFY PASS 2 (DEVSUITE phase 15): QuoxSlots as a set of
 * governed tools, so agents and external Claudes can address a slot.
 *
 * DELIBERATELY NOT AN AGENT (owner decision, QuoxPlan DEVSUITE note #2843).
 * The feature-vs-agent rule the six audits converged on: give it a
 * conversational agent where there is a DOMAIN to reason over across turns;
 * keep it a feature with tools where it is a mechanical or ADDRESSING
 * primitive. A slot is an address you talk THROUGH to a held session. There
 * is nothing to reason about, so it gets tools and no persona.
 *
 * THE GOVERNANCE POINT THAT SHAPED THIS FILE
 * The collector's slot routes admin-gate pool curation (create / retire /
 * assign) via requireAdminRole, and that helper deliberately ALLOWS
 * service-key callers so the CLI works. These tools call with the service
 * key. So exposing curation directly would have handed every agent silent
 * org-admin powers over the slot pool, with the gate still looking present in
 * the route.
 *
 * Therefore: reads and `say` are direct (they are org-member-level actions
 * anyway), and every pool-curation write goes through withApprovalGate, the
 * same helper bob_mark_build_outcome and loop_halt use. An agent can propose
 * a slot change; a human resolves it.
 */

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://localhost:9848';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const FETCH_TIMEOUT_MS = 15000;

async function slotCall(method, path, { orgId, body } = {}) {
  if (!orgId) {
    throw new Error('org_context_required: slot tools need an authenticated org context.');
  }
  const sep = path.includes('?') ? '&' : '?';
  const url = `${COLLECTOR_URL}${path}${sep}org_id=${encodeURIComponent(orgId)}`;
  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_SERVICE_KEY) headers['X-Service-Key'] = INTERNAL_SERVICE_KEY;
  const hasBody = !['GET', 'HEAD'].includes(method);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(body || {}) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Slots service unreachable (${err.message}). Is the collector running on ${COLLECTOR_URL}?`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* may be empty */ }
  if (!res.ok) {
    const detail = json && (json.message || json.error) ? (json.message || json.error) : `${res.status} ${res.statusText}`;
    throw new Error(`Slot request failed (${res.status}): ${detail}`);
  }
  return json;
}

// QUOXON-PROOF (quox#824): slot_list reads the slot store IN-PROCESS when the collector
// has registered it (server.js, configureSlotStore). The loopback HTTP hop it replaced
// queued behind every busy turn on the same event loop, so about 7 concurrent chat turns
// tripped the 15s abort ("Slots service unreachable", 23s and 64s) although the route's
// own work is a few indexed sqlite reads. The licence gate the route applies is kept.
// Unconfigured (a test or another process) it falls back to the HTTP route.
let inProcessStore = null;
function configureSlotStore(store) {
  inProcessStore = store && typeof store.listSlots === 'function' && typeof store.isLicensed === 'function' ? store : null;
}

async function listSlotsForOrg(orgId) {
  if (!orgId) {
    throw new Error('org_context_required: slot tools need an authenticated org context.');
  }
  if (!inProcessStore) {
    const data = await slotCall('GET', '/api/v1/slots', { orgId });
    return Array.isArray(data && data.slots) ? data.slots : [];
  }
  let licensed;
  try {
    licensed = await inProcessStore.isLicensed(orgId);
  } catch (err) {
    throw new Error(`QuoxSlots licence check unavailable (${err.message}); retry shortly.`);
  }
  if (!licensed) throw new Error('QuoxSlots is not licensed for this organisation.');
  const slots = inProcessStore.listSlots({ orgId });
  if (!Array.isArray(slots)) throw new Error('unexpected response from the slot store');
  return slots;
}

const SLOT_TOOLS = {

  slot_list: {
    name: 'slot_list',
    description: "List the org's slots: the fixed pool of durable named addresses (like 'triage' or 'builder') that ephemeral agent sessions check out and release. Shows each slot's state (free/held/stale), who holds it, which host, and whether it is waiting for a named session to claim it. Read-only. Use this to find the right slot before saying anything to one.",
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (_input, ctx) => {
      try {
        const slots = await listSlotsForOrg(ctx && ctx.orgId);
        return {
          success: true,
          count: slots.length,
          slots: slots.map((s) => ({
            name: s.name,
            state: s.state,
            holder_session: s.holder_session || null,
            assigned_to: s.assigned_to || null,
            host_id: s.host_id || null,
            last_heartbeat_at: s.last_heartbeat_at || null,
          })),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  slot_say: {
    name: 'slot_say',
    description: "Send a message into a slot's chat thread. Whatever session currently holds the slot reads it, wherever it is running, and the line also renders into any bridged chat app (Telegram today). This is how you steer a working session by ADDRESS rather than needing to know which session is running. The message is witnessed. Say who the message is from when you know.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Slot name, e.g. triage.' },
        text: { type: 'string', description: 'The message to deliver into the slot thread.' },
        from: { type: 'string', description: 'Optional sender label shown in the thread.' },
      },
      required: ['name', 'text'],
    },
    execute: async ({ name, text, from }, ctx) => {
      if (!name || !text) return { success: false, error: 'name and text are required' };
      try {
        const data = await slotCall('POST', `/api/v1/slots/${encodeURIComponent(name)}/say`, {
          orgId: ctx && ctx.orgId,
          body: { text, from: from || 'agent' },
        });
        return { success: true, slot: name, message: data && data.message ? data.message : null };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  slot_read: {
    name: 'slot_read',
    description: "Read recent messages from a slot's chat thread. IMPORTANT HONESTY NOTE: this returns what Quox has SEEN and cached server-side, which is the record of messages that went through the slot seam. It is not a full read of the underlying room timeline, so a message posted directly in a bridged chat app may not appear here. Say 'seen by Quox' rather than implying it is the complete conversation.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Slot name.' },
        limit: { type: 'number', description: 'Max messages (default 20).' },
      },
      required: ['name'],
    },
    execute: async ({ name, limit }, ctx) => {
      if (!name) return { success: false, error: 'name is required' };
      try {
        const n = limit && limit > 0 ? Math.min(limit, 100) : 20;
        const data = await slotCall('GET', `/api/v1/slots/${encodeURIComponent(name)}/messages?limit=${n}`, { orgId: ctx && ctx.orgId });
        const messages = Array.isArray(data && data.messages) ? data.messages : [];
        return {
          success: true,
          slot: name,
          count: messages.length,
          source_note: 'seen by Quox (server-side cache of the slot seam), not a full room timeline read',
          messages: messages.map((m) => ({
            from: m.from || null,
            source: m.source || null,
            at: m.created_at || null,
            text: typeof m.text === 'string' ? m.text.slice(0, 1000) : null,
          })),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  slot_assign: {
    name: 'slot_assign',
    description: "Set which session is EXPECTED to hold a slot. The slot stays free until that session starts and claims it with `quox slot claim`, so this is scheduling an address, not seizing one. Curating the slot pool is an org-admin action, so this ALWAYS goes through the approval gate: you propose, a human resolves. Report it as requested, never as done. Get the session name exactly right, a typo leaves the slot waiting for a session that will never come.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Slot name.' },
        session: { type: 'string', description: 'Session name expected to claim it. Pass null or omit to clear the assignment.' },
      },
      required: ['name'],
    },
    execute: async (input, ctx) => {
      const { name, session } = input || {};
      if (!name) return { success: false, error: 'name is required' };
      const { withApprovalGate } = require('./approvalGate');
      return withApprovalGate('slot_assign', input, async () => {
        try {
          const data = await slotCall('POST', `/api/v1/slots/${encodeURIComponent(name)}/assign`, {
            orgId: ctx && ctx.orgId,
            body: { assigned_to: session || null },
          });
          return { success: true, slot: name, assigned_to: session || null, result: data || null };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }, ctx || {});
    },
  },
};

function getSlotToolDefinitions() {
  return Object.values(SLOT_TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

function executeSlotTool(name, input, ctx) {
  const tool = SLOT_TOOLS[name];
  if (!tool) throw new Error(`Unknown slot tool: ${name}`);
  return tool.execute(input || {}, ctx || {});
}

module.exports = {
  SLOT_TOOLS,
  configureSlotStore,
  getSlotToolDefinitions,
  executeSlotTool,
};
