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

async function slotCall(method, path, { orgId, body, headers: extraHeaders } = {}) {
  if (!orgId) {
    throw new Error('org_context_required: slot tools need an authenticated org context.');
  }
  const sep = path.includes('?') ? '&' : '?';
  const url = `${COLLECTOR_URL}${path}${sep}org_id=${encodeURIComponent(orgId)}`;
  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_SERVICE_KEY) headers['X-Service-Key'] = INTERNAL_SERVICE_KEY;
  // HYPERION #21: an ALLOWLIST, never a merge. Only X-On-Behalf-Of passes (any case); a caller can never replace the
  // service key, set Authorization or move the org, and a lowercase duplicate can never reach fetch as a second entry.
  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (String(k).toLowerCase() === 'x-on-behalf-of' && typeof v === 'string') headers['X-On-Behalf-Of'] = v;
    }
  }
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

// QUOXON lane S: slot_create / slot_checkout run IN-PROCESS through actions server.js
// registers (configureSlotActions): the same store calls and side effects (audit envelope,
// Matrix room, Discord channel) as POST /api/v1/slots and /:name/checkout, with the caller
// taken from the turn identity, never the service key. That is also why they work on every
// dispatch path: the Claude CLI's per-turn token is audience-bound to /tools/execute and
// could not reach the slot routes.
// quox#1171: a USER-MADE agent (auth agents table, `quox agent create`) may slot_say only into the
// slot an org admin bound it to (`quox agent bind-slot`). Built-ins, residents and attached
// assistants are not user-made agents and keep their existing behaviour. Wired from server.js.
let slotAgentScope = null;
function configureSlotAgentScope(deps) {
  slotAgentScope = deps && typeof deps.isOrgCustomAgent === 'function' && typeof deps.getBinding === 'function' ? deps : null;
}

// Returns null when the post may go ahead, else a plain refusal. Fails closed.
async function userMadeAgentSlotRefusal(name, ctx) {
  const agentId = ctx && ctx.agentId;
  const orgId = ctx && ctx.orgId;
  if (!agentId || !orgId) return null;
  if (!slotAgentScope) return null;
  let custom;
  try {
    custom = await slotAgentScope.isOrgCustomAgent({ orgId, agentId });
  } catch (err) {
    return `slot_say refused: could not confirm what agent ${agentId} is (${err.message}); nothing was sent.`;
  }
  if (!custom) return null;
  let binding = null;
  try { binding = slotAgentScope.getBinding({ orgId, agentId }); } catch (err) {
    return `slot_say refused: could not read agent ${agentId}'s slot binding (${err.message}); nothing was sent.`;
  }
  if (!binding || !binding.slot_name) {
    return `slot_say refused: no slot is bound to agent ${agentId}. An org admin can bind one with \`quox agent bind-slot ${agentId} <slot>\`. Nothing was sent.`;
  }
  if (binding.slot_name !== name) {
    return `slot_say refused: agent ${agentId} can only post to the slot it is bound to (${binding.slot_name}), not ${name}. Nothing was sent.`;
  }
  return null;
}

let slotActions = null;
function configureSlotActions(actions) {
  slotActions = actions && typeof actions.create === 'function' && typeof actions.checkout === 'function' ? actions : null;
}

const SLOT_NAME_RE = /^[a-z0-9-]{1,32}$/;
// The user's own words asking to create, attach to or check out a slot.
const SLOT_ASK_RE = /\bslots?\b/i;
const SLOT_VERB_RE = /\b(create|make|new|add|set ?up|open|attach|check ?out|checkout|claim|join|hold|take|use|switch|move)\b/i;
const ADMIN_ROLES = new Set(['owner', 'admin']);

function userAskedForSlot(text) {
  const t = String(text || '');
  return SLOT_ASK_RE.test(t) && SLOT_VERB_RE.test(t);
}

/**
 * The house rule (feedback-direct-user-action-is-authorization): the signed-in human's own
 * request IS the authorization, so no approval card. The record is the one the approval gate
 * reads (lib/directRequestRegistry.js), written only by the interactive chat handler after it
 * verified a human login; scheduled, autonomous, agent and service callers never have one.
 * -> { ok: true, human } | { ok: false, result }
 */
function requireDirectSlotRequest(toolName, ctx) {
  const refuse = (error) => ({ ok: false, result: { success: false, refused: true, error } });
  const registry = require('./directRequestRegistry.js');
  const conv = ctx && (ctx.conversationId || ctx.session_id);
  const human = registry.isDirectRequest(conv, ctx && ctx.orgId);
  if (!human || !ctx.userId || String(ctx.userId) !== human.userId) {
    return refuse(`${toolName} runs only on the signed-in user's own request in a live chat. Autonomous and scheduled turns cannot change slots (and a conversation that has read outside content since the user's last message needs the user to ask again). Nothing ran.`);
  }
  if (!userAskedForSlot(human.ask)) {
    return refuse(`${toolName} runs only when the user's own message asks for a slot. Nothing ran.`);
  }
  return { ok: true, human };
}

function normaliseSlotName(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

/**
 * QUOXON-ENGINE: the org's slot names, for turn tool selection (a message addressed to a
 * slot routes to slot_say). Synchronous, in-process only; [] when the store is not
 * configured, the org is unknown or the read fails. Names only, never holders.
 */
function slotNamesForOrg(orgId) {
  if (!orgId || !inProcessStore) return [];
  try {
    const slots = inProcessStore.listSlots({ orgId });
    return Array.isArray(slots) ? slots.map((x) => x && x.name).filter((n) => typeof n === 'string' && n) : [];
  } catch { return []; }
}

/**
 * QUOXON-MESH (live bug 2026-10-14): slot_say signed lines as the model's own persona
 * ("CommanderQ"), so another window asking "any messages from quox1?" found none. The sender
 * is the slot THIS conversation's window holds, recorded by the chat handler from the turn
 * request (lib/directRequestRegistry.js heldSlotFor, never model input) and re-checked here
 * against the slot store: the slot must still be held by that window's session. Returns
 * "quox1 (Adam)" / "quox1", or null (the say route then derives the caller's identity).
 */
function verifiedHeldSlot(ctx) {
  const conv = ctx && (ctx.conversationId || ctx.session_id);
  if (!conv || !ctx.orgId || !inProcessStore) return null;
  const held = require('./directRequestRegistry.js').heldSlotFor(conv, ctx.orgId);
  if (!held) return null;
  let row = null;
  try {
    const all = inProcessStore.listSlots({ orgId: ctx.orgId });
    row = Array.isArray(all) ? all.find((x) => x && x.name === held.name) : null;
  } catch { return null; }
  if (!row || row.state === 'free' || row.holder_session !== held.session) return null;
  return held;
}
/** The slot name this turn's window holds (verified), or null. */
function heldSlotForTurn(ctx) {
  const h = verifiedHeldSlot(ctx);
  return h ? h.name : null;
}
// quox#1306: the acting agent of a turn, from ctx.agentId (set by the server from the verified turn identity,
// never model input), or null when absent or not a plain agent id. Same shape the say route accepts.
const ACTING_AGENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function actingAgentFor(ctx) {
  const id = ctx && ctx.agentId;
  return typeof id === 'string' && ACTING_AGENT_RE.test(id) ? id : null;
}
// The turn's verified user (or system actor) the agent acted for; the route re-validates it.
function onBehalfOfFor(ctx) {
  const u = ctx && ctx.userId;
  return typeof u === 'string' && u ? u : null;
}
// The display label fits the say route's 64-character label cap; a very long id is shown bare.
function agentSenderLabel(id) {
  const label = `${id} (agent)`;
  return label.length <= 64 ? label : id;
}
function turnSenderLabel(ctx) {
  const held = verifiedHeldSlot(ctx);
  if (!held) return null;
  const display = held.display ? held.display.replace(/[^A-Za-z0-9._@:\- ]/g, '').trim().slice(0, 24) : '';
  return display ? `${held.name} (${display})` : held.name;
}

// QUOXON-MESH (live 2026-10-14): in the quox2 window "any messages from quox1 slot?" read quox1's OWN thread
// and found only quox2's earlier line; quox1's hellos were in quox2's slot. A sender ask is about MY slot
// filtered by sender. Detected from the HUMAN's own words (the direct-request record), not the model's guess.
const SLOT_FROM_RE = /\b(?:(?:messages?|anything|something|replies|reply|word|news|heard|hear)\s+(?:back\s+)?from\s+(?:the\s+)?(?:slot\s+)?([\w-]+)|did\s+(?:the\s+)?(?:slot\s+)?([\w-]+)\s+(?:send|say|reply|write|message|post)|what\s+did\s+(?:the\s+)?(?:slot\s+)?([\w-]+)\s+(?:say|send|write|post))\b/i;
const SLOT_THREAD_RE = /\bthread\b|\b(?:messages?|anything|lines?)\s+(?:to|in|into)\b|\bread\s+(?:the\s+)?(?:slot\b|[\w-]+\s+slot\b)/i;
/** The sender a human's ask is about ("messages from quox1" -> 'quox1'), or null. */
function senderAskedAbout(text) {
  const t = String(text || '');
  if (SLOT_THREAD_RE.test(t)) return null;
  const m = SLOT_FROM_RE.exec(t);
  const who = m && (m[1] || m[2] || m[3]);
  return who ? who.toLowerCase() : null;
}
/** "quox1" matches "quox1" and "quox1 (Adam)", never "quox10"; a person name matches "(Adam)" or the identity. */
function sentBy(m, want) {
  const w = String(want || '').trim().toLowerCase();
  if (!w) return true;
  const label = String(m.from || '').toLowerCase();
  const ident = String(m.author_identity || '').toLowerCase();
  return label === w || label.startsWith(`${w} (`) || label.includes(`(${w})`) || ident === w || ident.split('@')[0] === w;
}
/**
 * Which slot slot_read reads. No name: this window's held slot. A name that is the SENDER of the human's
 * own "messages from X" ask (and not the held slot): the held slot filtered by X, with a note saying so.
 */
function resolveReadTarget({ name, from }, ctx) {
  const held = heldSlotForTurn(ctx);
  const nm = normaliseSlotName(name);
  const fr = typeof from === 'string' && from.trim() ? from.trim().toLowerCase() : null;
  if (!nm) {
    if (!held) return { error: "This window holds no slot, so there is no slot of yours to read. /slot <name> gives it one; pass name to read a named slot's own thread." };
    return { slot: held, mine: true, from: fr };
  }
  if (held && nm !== held) {
    const conv = ctx && (ctx.conversationId || ctx.session_id);
    const human = conv ? require('./directRequestRegistry.js').isDirectRequest(conv, ctx.orgId) : null;
    const asked = human ? senderAskedAbout(human.ask) : null;
    if ((fr && fr === nm) || asked === nm) {
      return { slot: held, mine: true, from: fr || nm, note: `Read your slot ${held} for messages sent by ${nm} (messages from ${nm} land in your slot, not in ${nm}'s own thread).` };
    }
  }
  return { slot: nm, from: fr };
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
          total: slots.length,
          held: slots.filter((s) => s.state === 'held').length,
          free: slots.filter((s) => s.state === 'free').length,
          stale: slots.filter((s) => s.state === 'stale').length,
          held_names: slots.filter((s) => s.state === 'held').map((s) => s.name),
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
    description: "Send a message into a slot's chat thread. Whatever session currently holds the slot reads it, wherever it is running, and the line also renders into any bridged chat app (Telegram today). This is how you steer a working session by ADDRESS rather than needing to know which session is running. A slot is not an agent: when the user addresses a slot by name (say hello to quox2), use this, never delegate_to_agent. The message is witnessed. The sender is set by Quox from this conversation (the slot this window holds and the user's name), never chosen by you.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Slot name, e.g. triage.' },
        text: { type: 'string', description: 'The message to deliver into the slot thread.' },
      },
      required: ['name', 'text'],
    },
    // QUOXON-MESH: `from` is no longer model input. A model-supplied label is ignored.
    execute: async ({ name, text }, ctx) => {
      if (!name || !text) return { success: false, error: 'name and text are required' };
      const scopeRefusal = await userMadeAgentSlotRefusal(name, ctx);
      if (scopeRefusal) return { success: false, error: scopeRefusal };
      try {
        const held = turnSenderLabel(ctx || {});
        // quox#1306: an agent turn with no held slot (delegation, workflow, schedule) posts AS the agent, from the
        // turn's verified agent id; the say route stores it as service:agent:<id>. A window's held slot still wins.
        const acting = !held ? actingAgentFor(ctx) : null;
        const from = held || (acting ? agentSenderLabel(acting) : null);
        const data = await slotCall('POST', `/api/v1/slots/${encodeURIComponent(name)}/say`, {
          orgId: ctx && ctx.orgId,
          body: acting ? { text, from, acting_agent: acting } : from ? { text, from } : { text },
          ...(acting && onBehalfOfFor(ctx) ? { headers: { 'X-On-Behalf-Of': onBehalfOfFor(ctx) } } : {}),
        });
        const pending = Boolean(data && data.room_pending);
        return {
          success: true, slot: name, from: from || null, message: data && data.message ? data.message : null,
          ...(pending ? { room_pending: true, note: `Delivered to slot ${name} (sessions listening on it have it now); its chat room is still being set up, so the room copy is queued and goes out when the room is ready.` } : {}),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  slot_read: {
    name: 'slot_read',
    description: "Read slot messages. Omit name to read YOUR slot (the one this window holds): that is where other sessions' messages to you land, so 'any messages from quox1?' / 'did quox1 send anything?' is slot_read with NO name and from: 'quox1'. Pass name only to read a named slot's own thread ('read the quox1 slot', 'messages to quox1'). IMPORTANT HONESTY NOTE: this returns what Quox has SEEN and cached server-side, which is the record of messages that went through the slot seam. It is not a full read of the underlying room timeline, so a message posted directly in a bridged chat app may not appear here. Say 'seen by Quox' rather than implying it is the complete conversation.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Slot whose own thread to read. Omit to read your own slot." },
        from: { type: 'string', description: 'Keep only lines sent by this slot or person (quox1 matches "quox1 (Adam)").' },
        limit: { type: 'number', description: 'Max messages (default 20, or 50 with from).' },
      },
      required: [],
    },
    execute: async ({ name, from, limit } = {}, ctx) => {
      const c = ctx || {};
      const target = resolveReadTarget({ name, from }, c);
      if (!target.slot) return { success: false, error: target.error };
      try {
        const want = target.from;
        const n = limit && limit > 0 ? Math.min(limit, 100) : (want ? 50 : 20);
        const data = await slotCall('GET', `/api/v1/slots/${encodeURIComponent(target.slot)}/messages?limit=${n}`, { orgId: c.orgId });
        const all = Array.isArray(data && data.messages) ? data.messages : [];
        const messages = want ? all.filter((m) => sentBy(m, want)) : all;
        return {
          success: true,
          slot: target.slot,
          ...(target.mine ? { your_slot: true } : {}),
          ...(want ? { from: want } : {}),
          ...(target.note ? { note: target.note } : {}),
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

  slot_create: {
    name: 'slot_create',
    description: "Create a new slot (a durable named address sessions check out) in the user's org. Runs only when the user's own message asks for it, and only for an org owner or admin. The CLI equivalent is `quox slot create <name>`. To also attach this conversation to it, use slot_checkout with create:true instead.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Slot name: lowercase letters, digits and dashes, up to 32 (QUOX1 becomes quox1).' },
        description: { type: 'string', description: 'Optional note on what the slot is for.' },
      },
      required: ['name'],
    },
    execute: async (input, ctx) => {
      const gate = requireDirectSlotRequest('slot_create', ctx || {});
      if (!gate.ok) return gate.result;
      const name = normaliseSlotName(input && input.name);
      if (!SLOT_NAME_RE.test(name)) return { success: false, error: 'slot name must be lowercase letters, digits and dashes (a-z0-9-), 1 to 32 characters' };
      if (!ADMIN_ROLES.has(String(gate.human.role || ''))) {
        return { success: false, error: `Creating a slot needs an org owner or admin, and this login is not one. An admin can run \`quox slot create ${name}\`, or you can attach to an existing slot with \`quox slot checkout <name>\`. Nothing ran.` };
      }
      if (!slotActions) return { success: false, error: 'slot actions are not available in this process (collector not fully started); nothing ran' };
      const description = input && typeof input.description === 'string' ? input.description.slice(0, 500) : null;
      try {
        const r = await slotActions.create({ orgId: ctx.orgId, name, notes: description, actor: `human.${ctx.userId}` });
        if (!r || !r.ok) {
          if (r && r.code === 'duplicate') return { success: false, error: `slot ${name} already exists; attach to it with slot_checkout (\`quox slot checkout ${name}\`)` };
          if (r && r.code === 'bad_name') return { success: false, error: 'slot name must be lowercase letters, digits and dashes (a-z0-9-), 1 to 32 characters' };
          if (r && r.code === 'unlicensed') return { success: false, error: 'QuoxSlots is not licensed for this organisation; nothing ran' };
          return { success: false, error: `slot create failed${r && r.code ? ` (${r.code})` : ''}` };
        }
        return { success: true, slot: { name: r.slot.name, state: r.slot.state }, message: r.room_pending ? `Created slot ${name}. Its chat room is still being set up; messages sent now are kept and delivered when it is ready.` : `Created slot ${name}.` };
      } catch (err) {
        return { success: false, error: `slot create failed: ${err.message}` };
      }
    },
  },

  slot_checkout: {
    name: 'slot_checkout',
    description: "Attach THIS conversation to a slot (check it out), so messages to the slot reach this session. Pass create:true to create the slot if it does not exist. Runs only when the user's own message asks for it. The CLI equivalent is `quox slot checkout <name> --create`.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Slot name: lowercase letters, digits and dashes, up to 32 (QUOX1 becomes quox1).' },
        create: { type: 'boolean', description: 'Create the slot if it does not exist yet.' },
      },
      required: ['name'],
    },
    execute: async (input, ctx) => {
      const gate = requireDirectSlotRequest('slot_checkout', ctx || {});
      if (!gate.ok) return gate.result;
      const name = normaliseSlotName(input && input.name);
      if (!SLOT_NAME_RE.test(name)) return { success: false, error: 'slot name must be lowercase letters, digits and dashes (a-z0-9-), 1 to 32 characters' };
      if (!slotActions) return { success: false, error: 'slot actions are not available in this process (collector not fully started); nothing ran' };
      const holderSession = String(ctx.conversationId || ctx.session_id);
      try {
        const r = await slotActions.checkout({
          orgId: ctx.orgId, name, holderSession, holderKind: 'conversation', holderIdentity: `user:${ctx.userId}`,
          create: input && input.create === true, actor: `human.${ctx.userId}`,
        });
        if (!r || !r.ok) {
          const code = r && r.code;
          if (code === 'not_found') return { success: false, error: `no slot named ${name}; pass create:true to create it (\`quox slot checkout ${name} --create\`)` };
          if (code === 'conflict') return { success: false, error: `slot ${name} is held by ${(r.slot && r.slot.holder_session) || 'another session'}; nothing was forced` };
          if (code === 'assigned_to_other') return { success: false, error: `slot ${name} is assigned to ${(r.slot && r.slot.assigned_to) || 'another session'}; nothing was forced` };
          if (code === 'bad_name') return { success: false, error: 'slot name must be lowercase letters, digits and dashes (a-z0-9-), 1 to 32 characters' };
          if (code === 'unlicensed') return { success: false, error: 'QuoxSlots is not licensed for this organisation; nothing ran' };
          return { success: false, error: `slot checkout failed${code ? ` (${code})` : ''}` };
        }
        return {
          success: true,
          ...(r.created ? { created: true } : {}),
          ...(r.refreshed ? { refreshed: true } : {}),
          slot: { name: r.slot.name, state: r.slot.state, holder_session: r.slot.holder_session },
          message: `${r.created ? 'Created slot' : 'Attached to slot'} ${name}; this conversation holds it.`,
        };
      } catch (err) {
        return { success: false, error: `slot checkout failed: ${err.message}` };
      }
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
  _slotCall: slotCall, // test seam (HYPERION #21 header allowlist)
  turnSenderLabel,
  senderAskedAbout,
  slotNamesForOrg,
  SLOT_TOOLS,
  configureSlotStore,
  configureSlotActions,
  configureSlotAgentScope,
  userAskedForSlot,
  getSlotToolDefinitions,
  executeSlotTool,
};
