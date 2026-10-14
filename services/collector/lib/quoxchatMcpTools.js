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

const QUOXCHAT_MCP_TOOLS = {
  quoxchat_list_widgets: {
    name: 'quoxchat_list_widgets',
    description: 'List QuoxChat widgets for an organisation. Returns id, public_key, name, status, timestamps. Use this to discover widgets before invoking other quoxchat_* tools.',
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
    execute: async (input) => {
      if (!input?.widget_id) return { success: false, error: 'widget_id is required' };
      if (!input?.query) return { success: false, error: 'query is required' };
      try {
        const { ok, status, data } = await _collectorFetch('/quoxchat/knowledge/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ widget_id: input.widget_id, query: input.query, limit: input.limit }),
        });
        if (!ok) return { success: false, error: data?.error || `search_${status}` };
        return { success: true, result: { chunks: data?.chunks || [], collection: data?.collection } };
      } catch (err) {
        return { success: false, error: err?.message || 'fetch_failed' };
      }
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
