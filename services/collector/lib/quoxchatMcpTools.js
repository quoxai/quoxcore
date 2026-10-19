/**
 * QCX-3.3 — QuoxChat MCP tool bridge.
 *
 * Exposes widget operations to developer-surface MCP clients (Claude
 * Desktop, Cursor, Claude CLI via quoxmcp). Each tool is a collector
 * TOOL_DEFS entry — agentTools.js merges these in at boot so the MCP
 * bridge discovers them via /api/v1/tools/list.
 *
 * Tools:
 *   quoxchat_list_widgets      — list widgets in an org (service-key)
 *   quoxchat_search_knowledge  — semantic RAG search over a widget
 *   quoxchat_list_conversations — conversations for a widget (read-only)
 *   quoxchat_get_transcript    — messages of one conversation (read-only)
 *   quoxchat_get_availability  — operator_online + office hours (read-only)
 *   quoxchat_simulate_message  — send a test message end-to-end
 *
 * execute() returns {success: bool, result?: any, error?: string} — the
 * canonical TOOL_DEFS shape. Fetch errors surface as {success:false,
 * error}; never throws.
 */

const AUTH_URL = () => process.env.AUTH_SERVICE_URL || 'http://auth:3101';
const COLLECTOR_URL = () => process.env.COLLECTOR_INTERNAL_URL || 'http://127.0.0.1:9848';

function _serviceKey() {
  return process.env.INTERNAL_SERVICE_KEY || '';
}

async function _authFetch(path, init = {}) {
  const sk = _serviceKey();
  if (!sk) return { ok: false, status: 503, data: { error: 'service_key_unset' } };
  const resp = await fetch(`${AUTH_URL()}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), 'x-service-key': sk },
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

async function _collectorFetch(path, init = {}) {
  const resp = await fetch(`${COLLECTOR_URL()}${path}`, init);
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}


const NO_ORG = 'no organisation on this session (widgets are only reachable within your own organisation)';
const NOT_MINE = 'widget not found in your organisation';

/**
 * QC-PROOF: resolve a widget reference (id, public_key or exact name, case-insensitive)
 * strictly within the caller's org, via the org-scoped internal list. Never trusts a
 * model-supplied id that is not in that list.
 */
async function _resolveOwnWidget(ref, ctx) {
  const orgId = ctx && ctx.orgId ? String(ctx.orgId) : null;
  if (!orgId) return { error: NO_ORG };
  const want = String(ref || '').trim();
  if (!want) return { error: 'widget is required (id, public_key or exact name)' };
  const { ok, status, data } = await _authFetch(`/api/internal/orgs/${encodeURIComponent(orgId)}/widgets`);
  if (!ok) return { error: data?.error || `auth_${status}` };
  const widgets = Array.isArray(data?.widgets) ? data.widgets : [];
  let hit = widgets.find((w) => w.id === want || w.public_key === want);
  if (!hit) {
    const named = widgets.filter((w) => String(w.name || '').toLowerCase() === want.toLowerCase());
    if (named.length > 1) return { error: `widget name "${want}" is ambiguous (${named.length} widgets); use the id or public_key` };
    hit = named[0];
  }
  if (!hit) return { error: NOT_MINE };
  return { orgId, widget: hit };
}

const WIDGET_PROP = { type: 'string', description: 'Widget id, public_key, or exact widget name (case-insensitive).' };

const QUOXCHAT_MCP_TOOLS = {
  quoxchat_list_widgets: {
    name: 'quoxchat_list_widgets',
    description: 'List QuoxChat widgets for an organisation. Returns id, public_key, name, status, deployment_type, operator_online, timestamps, plus total_conversations, total_messages and last_conversation_at per widget, so conversation/message totals need no further call. Use this to discover widgets before invoking other quoxchat_* tools.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Optional. Defaults to your current organisation; another organisation is refused.' },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      // QUOXON-REVIEW: the caller's org comes from the turn (ctx.orgId); a model-chosen org
      // that is not the caller's is refused (this call runs with the service key).
      const callerOrg = ctx && ctx.orgId ? String(ctx.orgId) : null;
      if (callerOrg && input?.org_id && String(input.org_id) !== callerOrg) {
        return { success: false, error: 'widgets can only be listed for your current organisation' };
      }
      const org_id = callerOrg || input?.org_id;
      if (!org_id) return { success: false, error: 'org_id is required (no organisation on this session)' };
      try {
        const { ok, status, data } = await _authFetch(`/api/internal/orgs/${encodeURIComponent(org_id)}/widgets`);
        if (!ok) return { success: false, error: data?.error || `auth_${status}` };
        return { success: true, result: { widgets: data?.widgets || [], count: data?.count || 0 } };
      } catch (err) {
        return { success: false, error: err?.message || 'fetch_failed' };
      }
    },
  },

  quoxchat_search_knowledge: {
    name: 'quoxchat_search_knowledge',
    description: 'Semantic search over a widget\'s knowledge base. Returns the top chunks (text, source, section, score) without running the LLM. Useful for debugging bad RAG retrieval or exploring what the widget knows.',
    input_schema: {
      type: 'object',
      properties: {
        widget_id: { type: 'string', description: 'Widget id or public_key.' },
        query: { type: 'string', description: 'Search query. Natural language.' },
        limit: { type: 'integer', description: 'Max chunks to return (1-20, default 5).' },
      },
      required: ['widget_id', 'query'],
    },
    execute: async (input, ctx) => {
      if (!input?.widget_id) return { success: false, error: 'widget_id is required' };
      if (!input?.query) return { success: false, error: 'query is required' };
      try {
        const r = await _resolveOwnWidget(input.widget_id, ctx);
        if (r.error) return { success: false, error: r.error };
        const { ok, status, data } = await _collectorFetch('/quoxchat/knowledge/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-service-key': _serviceKey() },
          body: JSON.stringify({ widget_id: r.widget.id, query: input.query, limit: input.limit }),
        });
        if (!ok) return { success: false, error: data?.error || `search_${status}` };
        return { success: true, result: { chunks: data?.chunks || [], collection: data?.collection, ...(data?.degraded ? { degraded: data.degraded, note: data.degraded.message } : {}) } };
      } catch (err) {
        return { success: false, error: err?.message || 'fetch_failed' };
      }
    },
  },

  quoxchat_list_conversations: {
    name: 'quoxchat_list_conversations',
    description: 'List recent conversations for one of your QuoxChat widgets (read-only). Returns id, status, started_at, last_message_at, message_count, visitor name/id and a handed_off flag, plus the total count. Optionally filter by status (handed_off, active, closed). Name the widget by id, public_key or exact name.',
    input_schema: {
      type: 'object',
      properties: {
        widget: WIDGET_PROP,
        status: { type: 'string', enum: ['handed_off', 'active', 'closed'], description: 'Optional status filter.' },
        limit: { type: 'integer', description: 'Max conversations (1-50, default 20).' },
      },
      required: ['widget'],
    },
    execute: async (input, ctx) => {
      if (input?.status && !['handed_off', 'active', 'closed'].includes(input.status)) {
        return { success: false, error: 'status must be handed_off, active or closed' };
      }
      try {
        const r = await _resolveOwnWidget(input?.widget, ctx);
        if (r.error) return { success: false, error: r.error };
        const n = parseInt(input?.limit, 10);
        const limit = Math.min(50, Math.max(1, Number.isFinite(n) ? n : 20));
        const qs = new URLSearchParams({ limit: String(limit) });
        if (input?.status) qs.set('status', input.status);
        const { ok, status, data } = await _authFetch(
          `/api/internal/orgs/${encodeURIComponent(r.orgId)}/widgets/${encodeURIComponent(r.widget.id)}/conversations?${qs}`);
        if (!ok) return { success: false, error: data?.error || `auth_${status}` };
        return { success: true, result: { widget: { id: r.widget.id, name: r.widget.name }, total: data?.total ?? 0, conversations: data?.conversations || [] } };
      } catch (err) {
        return { success: false, error: err?.message || 'fetch_failed' };
      }
    },
  },

  quoxchat_get_transcript: {
    name: 'quoxchat_get_transcript',
    description: 'Get the ordered message transcript (role, content, created_at) of one conversation on one of your QuoxChat widgets (read-only, capped at 200 messages). Get conversation ids from quoxchat_list_conversations.',
    input_schema: {
      type: 'object',
      properties: {
        widget: WIDGET_PROP,
        conversation_id: { type: 'string', description: 'Conversation id from quoxchat_list_conversations.' },
      },
      required: ['widget', 'conversation_id'],
    },
    execute: async (input, ctx) => {
      if (!input?.conversation_id) return { success: false, error: 'conversation_id is required' };
      try {
        const r = await _resolveOwnWidget(input?.widget, ctx);
        if (r.error) return { success: false, error: r.error };
        const { ok, status, data } = await _authFetch(
          `/api/internal/orgs/${encodeURIComponent(r.orgId)}/widgets/${encodeURIComponent(r.widget.id)}/conversations/${encodeURIComponent(input.conversation_id)}/messages`);
        if (!ok) return { success: false, error: data?.error || `auth_${status}` };
        return { success: true, result: { widget: { id: r.widget.id, name: r.widget.name }, conversation: data?.conversation, messages: data?.messages || [], truncated: !!data?.truncated } };
      } catch (err) {
        return { success: false, error: err?.message || 'fetch_failed' };
      }
    },
  },

  quoxchat_get_availability: {
    name: 'quoxchat_get_availability',
    description: 'Show whether a human operator is online for one of your QuoxChat widgets, and its office-hours configuration (read-only). Name the widget by id, public_key or exact name.',
    input_schema: {
      type: 'object',
      properties: { widget: WIDGET_PROP },
      required: ['widget'],
    },
    execute: async (input, ctx) => {
      try {
        const r = await _resolveOwnWidget(input?.widget, ctx);
        if (r.error) return { success: false, error: r.error };
        const { ok, status, data } = await _authFetch(`/api/internal/widgets/${encodeURIComponent(r.widget.id)}/meta`);
        if (!ok) return { success: false, error: data?.error || `auth_${status}` };
        let office_hours = null;
        if (data?.office_hours_json) {
          try { office_hours = JSON.parse(data.office_hours_json); } catch { office_hours = data.office_hours_json; }
        }
        // Allowlist: the meta response also carries secrets; never pass it through.
        return { success: true, result: { id: r.widget.id, name: r.widget.name, status: data?.status ?? r.widget.status, operator_online: Boolean(data?.operator_online), office_hours } };
      } catch (err) {
        return { success: false, error: err?.message || 'fetch_failed' };
      }
    },
  },

  quoxchat_read: {
    name: 'quoxchat_read',
    description: 'One read-only tool for QuoxChat widget questions: how many conversations a widget has had (view=widgets gives total_conversations / total_messages), which conversations were handed off to a human (view=conversations, status=handed_off), what a visitor said (view=transcript with a conversation_id), and whether a human operator is online / office hours (view=availability). Name the widget by id, public_key or exact name; it only reaches widgets in your own organisation.',
    input_schema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['widgets', 'conversations', 'transcript', 'availability'], description: 'widgets: all widgets with conversation/message totals. conversations: list a widget\'s conversations. transcript: messages of one conversation. availability: operator_online + office hours.' },
        widget: WIDGET_PROP,
        conversation_id: { type: 'string', description: 'Required for view=transcript.' },
        status: { type: 'string', enum: ['handed_off', 'active', 'closed'], description: 'Optional filter for view=conversations.' },
        limit: { type: 'integer', description: 'view=conversations: max rows (1-50, default 20).' },
      },
      required: ['view'],
    },
    execute: async (input, ctx) => {
      const map = {
        widgets: 'quoxchat_list_widgets',
        conversations: 'quoxchat_list_conversations',
        transcript: 'quoxchat_get_transcript',
        availability: 'quoxchat_get_availability',
      };
      const target = map[input?.view];
      if (!target) return { success: false, error: 'view must be one of widgets, conversations, transcript, availability' };
      // routed_tool names the narrow executor that really ran, so the turn evidence can show it
      // (conversationToolEvents ROUTER_TOOLS -> nested_tools).
      const out = await QUOXCHAT_MCP_TOOLS[target].execute(input || {}, ctx);
      return out && typeof out === 'object' ? { ...out, routed_tool: target } : out;
    },
  },

  quoxchat_simulate_message: {
    name: 'quoxchat_simulate_message',
    description: 'Send a test visitor message to a widget and return the full response — RAG sources, tool calls, tokens, model. Uses a synthetic visitor_id so this never pollutes real visitor memory. Useful for debugging prompts + regression-testing config.',
    input_schema: {
      type: 'object',
      properties: {
        widget_id: { type: 'string', description: 'Widget id or public_key.' },
        message: { type: 'string', description: 'Visitor message to simulate.' },
        visitor_id: { type: 'string', description: 'Optional synthetic visitor id. Defaults to "mcp.dev".' },
      },
      required: ['widget_id', 'message'],
    },
    execute: async (input) => {
      if (!input?.widget_id) return { success: false, error: 'widget_id is required' };
      if (!input?.message) return { success: false, error: 'message is required' };
      try {
        const { ok, status, data } = await _collectorFetch('/quoxchat/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-service-key': process.env.INTERNAL_SERVICE_KEY || '' },
          body: JSON.stringify({
            widget_id: input.widget_id,
            visitor_id: input.visitor_id || 'mcp.dev',
            message: input.message,
          }),
        });
        if (!ok) return { success: false, error: data?.error || `message_${status}` };
        return { success: true, result: data };
      } catch (err) {
        return { success: false, error: err?.message || 'fetch_failed' };
      }
    },
  },
};

const QUOXCHAT_MCP_TOOL_NAMES = Object.keys(QUOXCHAT_MCP_TOOLS);

module.exports = { QUOXCHAT_MCP_TOOLS, QUOXCHAT_MCP_TOOL_NAMES };
