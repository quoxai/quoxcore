/**
 * Discord Pro Agent Tools (QDIS-CONCIERGE)
 *
 * Gives CONCIERGE (src/config/agentRegistry.js `concierge`) direct, governed
 * access to the Quox Discord Pro daemon (separate repo:
 * /opt/quoxcore/quox-discord-pro), which before this had no agent surface at
 * all -- the only way to operate it was the `qdp` CLI on the daemon host, or
 * hand-editing config.json. Owner framing: "he should be the concierge."
 *
 * Every tool here calls the collector's OWN /api/discord-pro/* routes
 * (services/collector/routes/discord-pro.js), the existing proxy to the
 * daemon's loopback control API -- never a second path straight to the
 * daemon. Same self-fetch pattern as quoxplanTools.js's quoxplanWrite():
 * X-Service-Key (INTERNAL_SERVICE_KEY) authenticates as a service caller,
 * which requireServiceOrUserAuth() accepts and which the proxy's
 * requireBindingAdmin() treats as pre-authorized (req.service short-circuits
 * the admin-role check) -- the human-approval requirement for mutations
 * lives in the agent gate below, not in a second admin check here.
 *
 * discord_diagnose surfaces the daemon's own doctor.js classification
 * (quox-discord-pro/src/doctor.js `runDoctor`/`formatDoctorReport`) through
 * the collector's /diagnose proxy -- the diagnosis logic is never
 * reimplemented here, only relayed.
 *
 * discord_bind_channel / discord_unbind_channel are MUTATING and wrapped in
 * withApprovalGate exactly like github_create_pull_request (agentTools.js) --
 * a binding change can repoint a channel at an arbitrary remote host via the
 * bridge_remote_host/bridge_remote_inbox fields (a real finding in the
 * 2026-08-11 audit), so approval is required unconditionally, independent of
 * org policy configuration. See AGENT_GATED_TOOLS['concierge'] in
 * approvalGate.js and the discord_bind_channel/discord_unbind_channel branch
 * of buildAgentGateProposal there.
 */

const { withApprovalGate } = require('./approvalGate');

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://localhost:9848';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
// 5s is right for the list/bind/unbind calls, which the daemon answers from
// memory. It is NOT right for diagnose: that fans out to one Discord REST call
// per binding (~12s at 27 bindings, and it grows with the estate), so a flat 5s
// ceiling made discord_diagnose permanently impossible. Worse, the timeout was
// reported to the agent as "proxy unreachable", so CONCIERGE truthfully told the
// user the collector was down while the collector was healthy and simply slower
// than the budget. Same mistake existed one layer down in routes/discord-pro.js
// (3s against the same 12s call) — when a call fans out, every layer above it
// needs a budget proportional to the work, or the innermost fix is invisible.
const FETCH_TIMEOUT_MS = 5000;
const DIAGNOSE_TIMEOUT_MS = 45000;

/** Shared GET helper for the two read-only tools. Never throws into the
 * agent loop -- network failures, timeouts, and non-2xx all become a
 * readable { success: false, error } instead of an unhandled rejection. */
async function discordProGet(path, timeoutMs = FETCH_TIMEOUT_MS) {
  const url = `${COLLECTOR_URL}${path}`;
  const headers = {};
  if (INTERNAL_SERVICE_KEY) headers['X-Service-Key'] = INTERNAL_SERVICE_KEY;
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`Discord Pro proxy unreachable (${err.message}). Is the collector running on ${COLLECTOR_URL}?`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON or empty body */ }
  if (!res.ok) {
    const detail = json && json.error ? json.error : `${res.status} ${res.statusText}`;
    throw new Error(`Discord Pro proxy rejected the request (${res.status}): ${detail}`);
  }
  return json || {};
}

/** Shared PUT/DELETE helper for the two mutating tools' actual write, only
 * ever invoked from inside withApprovalGate's executeAction after a human
 * has approved. Mirrors quoxplanTools.js's quoxplanWrite() error shape. */
async function discordProWrite(method, path, body) {
  const url = `${COLLECTOR_URL}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_SERVICE_KEY) headers['X-Service-Key'] = INTERNAL_SERVICE_KEY;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Discord Pro proxy unreachable (${err.message}). Is the collector running on ${COLLECTOR_URL}?`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON or empty body */ }
  if (!res.ok) {
    const detail = json && json.error ? json.error : `${res.status} ${res.statusText}`;
    throw new Error(`Discord Pro proxy rejected the request (${res.status}): ${detail}`);
  }
  return json || {};
}

const DISCORD_PRO_TOOLS = {
  discord_list_bindings: {
    name: 'discord_list_bindings',
    description: 'List every Discord channel binding on the Discord Pro daemon: channel id, channel name, Discord server (guild), mode (echo/support/quoxchat/team/roundtable/bridge), and the agent/persona it talks to. Also reports whether the daemon is reachable. Read-only.',
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      try {
        const status = await discordProGet('/api/discord-pro/status');
        return { success: status.ok !== false, ...status };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  discord_diagnose: {
    name: 'discord_diagnose',
    description: 'Diagnose why a Discord Pro binding is not working. Checks whether the bot can actually VIEW each bound channel -- Discord only delivers messages for channels the bot can see, so a channel or category denying View Channel produces total silence with zero errors anywhere (this is what caused 18 of 25 bindings to be silently dead for weeks on 2026-08-11). Reports OK / WARN (webhook-only feed degraded) / FATAL (conversational binding dead) per binding. For every broken binding, names the specific permission bits missing (View Channel, Read Message History) and the plain-language remedy -- the bot cannot repair this itself, a human must grant the permission via a Discord role or a per-channel overwrite. Read-only.',
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      try {
        const report = await discordProGet('/api/discord-pro/diagnose', DIAGNOSE_TIMEOUT_MS);
        return { success: report.ok !== false, ...report };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  discord_bind_channel: {
    name: 'discord_bind_channel',
    // QUOXTRUST C2/WP2: reaches outside the box — durable intent gated at the choke.
    externalEffect: true,
    // Approval gate runs INSIDE execute — the dispatch stamp lands at the real
    // effect boundary via ctx._markDispatched (approvalGate), not pre-execute.
    gatedInExecute: true,
    description: 'Bind (or rebind) a Discord channel to a mode and agent. MUTATING and HIGH RISK: bridge mode routes messages to a remote host you name (bridge_remote_host/bridge_remote_inbox), so a binding change can repoint a channel at an arbitrary remote host. This ALWAYS requires human approval before it executes, regardless of org policy configuration -- calling this tool files a proposal, it never applies the change directly.',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Discord channel snowflake id (digits only)' },
        mode: { type: 'string', enum: ['echo', 'support', 'quoxchat', 'team', 'roundtable', 'bridge'], description: 'Binding mode' },
        agent_id: { type: 'string', description: 'Agent this channel talks to (team/roundtable/quoxchat modes)' },
        persona: { type: 'string', description: 'Webhook display name for the agent in this channel' },
        hitl_policy: { type: 'string', description: 'Human-in-the-loop policy for this binding' },
        cooldown_s: { type: 'integer', description: 'Cooldown in seconds between bot responses' },
        require_mention: { type: 'boolean', description: 'Whether the bot must be @mentioned to respond' },
        instance: { type: 'string', description: 'Which Quox instance handles this channel (multi-instance deployments)' },
        bridge_two_way: { type: 'boolean', description: 'bridge mode only: allow authorised humans to talk back through the bridge' },
        bridge_remote_host: { type: 'string', description: 'bridge mode only: the fleet host this channel relays to' },
        bridge_remote_inbox: { type: 'string', description: 'bridge mode only: the remote session-mail inbox' },
        bridge_outbox_host: { type: 'string', description: 'bridge mode only: the host that relays replies back' },
        bridge_outbox_inbox: { type: 'string', description: 'bridge mode only: the outbox inbox name' },
        _approvalId: { type: 'string', description: 'Approval ID for re-invocation after approval' },
      },
      required: ['channel_id', 'mode'],
    },
    execute: async (input, ctx) => {
      const { channel_id, _approvalId, _resumeToken, ...bindingFields } = input;
      const toolInput = {
        channel_id,
        ...bindingFields,
        ...(_approvalId ? { _approvalId } : {}),
        ...(_resumeToken ? { _resumeToken } : {}),
      };
      return await withApprovalGate('discord_bind_channel', toolInput, async () => {
        try {
          const result = await discordProWrite('PUT', `/api/discord-pro/bindings/${encodeURIComponent(channel_id)}`, bindingFields);
          return { success: true, ...result };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }, ctx);
    },
  },

  discord_unbind_channel: {
    name: 'discord_unbind_channel',
    // QUOXTRUST C2/WP2: reaches outside the box — durable intent gated at the choke.
    externalEffect: true,
    // Approval gate runs INSIDE execute — the dispatch stamp lands at the real
    // effect boundary via ctx._markDispatched (approvalGate), not pre-execute.
    gatedInExecute: true,
    description: 'Remove a Discord channel binding, stopping the bot from acting in that channel. MUTATING: this ALWAYS requires human approval before it executes, regardless of org policy configuration -- calling this tool files a proposal, it never applies the change directly.',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Discord channel snowflake id (digits only)' },
        _approvalId: { type: 'string', description: 'Approval ID for re-invocation after approval' },
      },
      required: ['channel_id'],
    },
    execute: async (input, ctx) => {
      const { channel_id, _approvalId, _resumeToken } = input;
      const toolInput = {
        channel_id,
        ...(_approvalId ? { _approvalId } : {}),
        ...(_resumeToken ? { _resumeToken } : {}),
      };
      return await withApprovalGate('discord_unbind_channel', toolInput, async () => {
        try {
          const result = await discordProWrite('DELETE', `/api/discord-pro/bindings/${encodeURIComponent(channel_id)}`);
          return { success: true, ...result };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }, ctx);
    },
  },
};

module.exports = { DISCORD_PRO_TOOLS, discordProGet, discordProWrite };
