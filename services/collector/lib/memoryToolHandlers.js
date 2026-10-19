// Memory Tool Handlers
// Execute memory tool calls from agents

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory:3103';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

// Auth to the memory service. Interactive users carry a bearer token; org-scoped
// SERVICE/agent contexts (the Matrix appservice, workflow invokes) have no bearer,
// so fall back to internal service-key + tenant-scoping headers exactly as
// memoryImplant.js does (the memory service accepts both). Without this, every
// agent memory tool call in Rooms/Slack/Telegram failed with "Invalid token".
function memoryAuthHeaders({ token, orgId, userId }) {
  if (token) return { 'Authorization': `Bearer ${token}` };
  return {
    'X-Service-Key': INTERNAL_SERVICE_KEY,
    'X-Org-Id': orgId || 'default',
    'X-User-Id': userId || 'service',
  };
}

// =============================================================================
// QSKL-13: memory_role write guard (collector pre-validation layer)
// Mirrors the guard in the memory service. Rejects disallowed roles before
// making any network call, so the LLM gets a structured payload immediately.
// =============================================================================

const ALLOWED_WRITE_ROLES = ['fact'];

function buildRoleError(memory_role) {
  if (memory_role === 'procedure') {
    return {
      ok: false,
      error_code: 'WRONG_LAYER',
      layer: 'skills',
      suggested_action: "skill_manage({action:'create', body_md:'<your procedure>', title:'<short title>'})",
      reason: "Procedures belong in the skills layer — they are versioned, reviewable, and load on demand. Memory is for durable facts only."
    };
  }

  if (memory_role === 'session_history') {
    return {
      ok: false,
      error_code: 'WRONG_LAYER',
      layer: 'sessions',
      suggested_action: "session_search({query:'<keywords>', limit:10})",
      reason: "Session history is captured automatically as you work — do not write it to memory. Use session_search to recall past work."
    };
  }

  return {
    ok: false,
    error_code: 'UNKNOWN_KIND',
    allowed: ['fact'],
    reason: `Only 'fact' is accepted for memory_save. Provided: '${memory_role}'.`
  };
}

/**
 * Handle memory tool calls from agents
 * @param {string} toolName - The tool being called
 * @param {object} params - Tool parameters
 * @param {object} context - Execution context (orgId, userId, agentId, conversationId, token)
 * @param {function} emit - Function to emit streaming events
 * @returns {object} Tool result
 */
async function handleMemoryTool(toolName, params, context, emit) {
  const { orgId, userId, agentId, conversationId, token } = context;

  // Emit thinking event for visibility
  if (emit) {
    emit('thinking', {
      stage: 'tool_call',
      agent: agentId,
      message: getToolMessage(toolName, params),
      tool: toolName,
      tool_input: params
    });
  }

  try {
    let result;

    switch (toolName) {
      case 'memory_save':
        result = await memorySave(params, context);
        break;
      case 'memory_search':
        result = await memorySearch(params, context);
        break;
      case 'memory_update':
        result = await memoryUpdate(params, context);
        break;
      case 'memory_forget':
        result = await memoryForget(params, context);
        break;
      case 'entity_note':
        result = await entityNote(params, context);
        break;
      default:
        throw new Error(`Unknown memory tool: ${toolName}`);
    }

    // Emit result event
    if (emit) {
      emit('thinking', {
        stage: 'tool_result',
        agent: agentId,
        message: getResultMessage(toolName, result),
        tool: toolName,
        result_preview: JSON.stringify(result).slice(0, 200)
      });
    }

    return result;
  } catch (error) {
    console.error(`[Memory Tool] ${toolName} error:`, error);

    if (emit) {
      emit('thinking', {
        stage: 'tool_error',
        agent: agentId,
        message: `Memory operation failed: ${error.message}`,
        tool: toolName,
        error: error.message
      });
    }

    return { error: error.message, success: false };
  }
}

/**
 * Save a new memory
 */
async function memorySave(params, context) {
  // memory_type is accepted as an alias for type (the memory service's own field name).
  const { content, importance = 'medium', tags = [], memory_role = 'fact' } = params;
  const type = params.type || params.memory_type;
  const { orgId, userId, agentId, conversationId, messageId, token } = context;

  if (!type) {
    return { success: false, error: 'type is required (e.g. fact, preference, decision, constraint, observation); memory_type is accepted as an alias' };
  }

  // QSKL-13: pre-validate memory_role before any network call
  if (!ALLOWED_WRITE_ROLES.includes(memory_role)) {
    return buildRoleError(memory_role);
  }

  const response = await fetch(`${MEMORY_SERVICE_URL}/api/memory`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...memoryAuthHeaders({ token, orgId, userId })
    },
    body: JSON.stringify({
      memory_type: type,
      content,
      importance,
      tags,
      memory_role,
      agent_id: agentId,
      source_conversation_id: conversationId,
      source_message_id: messageId
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to save memory');
  }

  const memory = await response.json();
  return {
    success: true,
    memory_id: memory.id,
    message: `Saved ${type}: "${content.slice(0, 50)}..."`
  };
}

/**
 * Search memories
 */
async function memorySearch(params, context) {
  const { query, type_filter = 'all', limit = 5, memory_scope } = params;
  const { token, orgId, userId, agentId, attachLeaseId, holderUserId } = context;

  const url = new URL(`${MEMORY_SERVICE_URL}/api/memory/search`);
  url.searchParams.set('q', query);
  if (type_filter && type_filter !== 'all') {
    url.searchParams.set('type', type_filter);
  }
  url.searchParams.set('limit', limit.toString());

  // QUOXIDENTITY P2 (territory D, docs/QUOXIDENTITY_P2_CONTRACT.md): scope
  // the read to the caller's own agent namespace ONLY when the caller is
  // attach-bound (attachLeaseId set from the verified attach_lease_id JWT
  // claim, see createSecureContext()) OR explicitly opts in via
  // memory_scope:'agent'. NON-BREAKING rule: a caller with neither carries
  // no agent_id here, which is byte-identical to pre-P2 behavior.
  //
  // CX1 F9 (owner yes 2026-10-11): attached Cortex is the user's own second
  // brain, so it reads ALL the user's memories: the lease holder's (the set
  // recall sees) merged with what Cortex itself saved in its agent namespace.
  // memory_scope:'agent' narrows back to its own namespace. Keyed on the
  // verified attach lease + holder claim, never on a body value; every other
  // agent keeps P2.
  const cortexHolder = Boolean(attachLeaseId && holderUserId && agentId === 'cortex' && memory_scope !== 'agent');
  const scopeToAgent = Boolean(attachLeaseId) || memory_scope === 'agent';
  const ownUrl = new URL(url.toString());
  if (scopeToAgent && agentId) {
    ownUrl.searchParams.set('agent_id', agentId);
  }

  const fetchResults = async (u, headers) => {
    const response = await fetch(u.toString(), { headers });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to search memories');
    }
    const body = await response.json();
    return Array.isArray(body?.results) ? body.results : [];
  };

  let results;
  if (cortexHolder) {
    const [own, held] = await Promise.allSettled([
      fetchResults(ownUrl, memoryAuthHeaders({ token, orgId, userId })),
      fetchResults(url, memoryAuthHeaders({ orgId, userId: String(holderUserId) })),
    ]);
    if (own.status === 'rejected' && held.status === 'rejected') throw own.reason;
    const lists = [own, held].map((r) => (r.status === 'fulfilled' ? r.value : []));
    // Interleave so neither set crowds the other out, dedupe by id, then cap.
    const seen = new Set();
    results = [];
    for (let i = 0; results.length < limit && i < Math.max(lists[0].length, lists[1].length); i++) {
      for (const list of lists) {
        const m = list[i];
        if (m && !seen.has(m.id) && results.length < limit) { seen.add(m.id); results.push(m); }
      }
    }
  } else {
    results = await fetchResults(ownUrl, memoryAuthHeaders({ token, orgId, userId }));
  }

  // Z2H-3c: a small model searched type "observation" for a fact saved as a "preference", got nothing, and
  // invented a memory. A typed miss retries untyped (the type is the model's guess), and an empty result
  // says plainly that nothing matched.
  let note;
  const typed = type_filter && type_filter !== 'all';
  if (results.length === 0 && typed && !cortexHolder) {
    const untyped = new URL(ownUrl.toString());
    untyped.searchParams.delete('type');
    results = await fetchResults(untyped, memoryAuthHeaders({ token, orgId, userId }));
    if (results.length) note = `No "${type_filter}" memories matched, so these are from all types.`;
  }
  if (results.length === 0) {
    note = `Nothing saved matched "${query}". Tell the user you have nothing saved about that; do not invent or guess a memory.`;
  }

  const searchResult = {
    success: true,
    ...(note ? { note } : {}),
    count: results.length,
    results: results.map(m => ({
      id: m.id,
      type: m.memory_type,
      content: m.content,
      importance: m.importance,
      tags: m.tags,
      created_at: m.created_at
    }))
  };

  // QM-LTM Phase 1: dark-flagged (QM_LTM_ENABLED), best-effort recall of past
  // conversations scoped to org/user, surfaced alongside the memory results.
  // When the flag is off (default) or recall fails, past_conversations is
  // simply omitted, so the flag-off shape stays byte-identical to today.
  if (orgId) {
    try {
      const { isLtmEnabled, recallConversations } = require('./conversationRecall.js');
      if (isLtmEnabled()) {
        const past = await recallConversations({ query, orgId, userId, limit: 3 });
        if (Array.isArray(past) && past.length > 0) {
          searchResult.past_conversations = past;
        }
      }
    } catch { /* non-fatal, QM-LTM recall must never break memory_search */ }
  }

  return searchResult;
}

/**
 * Update an existing memory
 */
async function memoryUpdate(params, context) {
  const { memory_id, new_content, reason } = params;
  const { token, agentId, orgId, userId } = context;
  const url = `${MEMORY_SERVICE_URL}/api/memory/${memory_id}`;
  const headers = { 'Content-Type': 'application/json', ...memoryAuthHeaders({ token, orgId, userId }) };

  // The memory store writes `tags` WHOLESALE. Sending only the audit tags destroyed every user tag on every
  // agent update (reproduced live 2026-10-15), so read first and merge: user tags kept, the previous
  // updated_by:/reason: audit pair replaced by this update's.
  const cur = await fetch(url, { headers });
  if (!cur.ok) {
    const error = await cur.json().catch(() => ({}));
    throw new Error(error.error || `Could not read memory ${memory_id} before updating (${cur.status})`);
  }
  const existing = await cur.json();
  const userTags = (Array.isArray(existing.tags) ? existing.tags : []).filter((t) => !/^(updated_by|reason):/.test(String(t)));
  const tags = [...userTags, `updated_by:${agentId}`, `reason:${String(reason || '').slice(0, 50)}`];

  const response = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ content: new_content, tags })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to update memory');
  }

  // Report the STORED record, and refuse to call it updated if the store does not show the new content.
  const memory = await response.json();
  if (memory.content !== new_content) {
    return { success: false, memory_id: memory.id || memory_id, error: 'The memory service answered ok but the stored memory does not show the new content' };
  }
  return {
    success: true,
    memory_id: memory.id,
    content: memory.content,
    tags: memory.tags,
    message: `Updated memory: "${String(memory.content).slice(0, 50)}..."`
  };
}

/**
 * Forget one of the caller's own memories (ONE-BRAIN CX6). The memory service
 * enforces own-org + own-user, decrements quota and emits the AEE envelope;
 * this only maps the outcome honestly. Soft delete unless permanent is true.
 */
async function memoryForget(params, context) {
  const { memoryId, permanent = false, reason } = params || {};
  const { token, orgId, userId } = context;

  if (!memoryId || typeof memoryId !== 'string') {
    return { success: false, error: 'memoryId is required' };
  }
  // Identity comes from ctx only. A bearer token carries it; the service-key
  // path needs an explicit org and user.
  if (!token && !(orgId && userId)) {
    return { success: false, error: 'Cannot forget a memory without a signed-in user identity' };
  }

  const headers = { 'Content-Type': 'application/json', ...memoryAuthHeaders({ token, orgId, userId }) };
  const base = `${MEMORY_SERVICE_URL}/api/memory/${encodeURIComponent(memoryId)}`;

  // Best effort: fetch first so we can name what was forgotten. Ownership and
  // existence are still decided by the DELETE itself.
  let preview = '';
  try {
    const got = await fetch(base, { method: 'GET', headers });
    if (got.ok) {
      const mem = await got.json();
      const text = String(mem?.content || '').replace(/\s+/g, ' ').trim();
      if (text) preview = text.length > 80 ? `${text.slice(0, 80)}...` : text;
    }
  } catch { /* preview only, never blocks the forget */ }

  const response = await fetch(permanent ? `${base}?hard=true` : base, { method: 'DELETE', headers });

  if (response.status === 404) return { success: false, error: 'no such memory' };
  if (response.status === 403) return { success: false, error: 'that memory is not yours to forget' };
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.error || ''; } catch { /* non-JSON error body */ }
    return { success: false, error: `Failed to forget memory (HTTP ${response.status})${detail ? `: ${detail}` : ''}` };
  }

  return {
    success: true,
    memory_id: memoryId,
    permanent: !!permanent,
    ...(reason ? { reason: String(reason).slice(0, 200) } : {}),
    message: `${permanent ? 'Permanently deleted' : 'Forgot'} memory${preview ? `: "${preview}"` : ` ${memoryId}`}`
  };
}

/**
 * Create or update an entity note
 */
async function entityNote(params, context) {
  const { name, entity_type, attributes = {}, relates_to = [] } = params;
  const { token, orgId, userId } = context;

  // Create/update the entity
  const entityResponse = await fetch(`${MEMORY_SERVICE_URL}/api/entity`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...memoryAuthHeaders({ token, orgId, userId })
    },
    body: JSON.stringify({
      name,
      entity_type,
      attributes
    })
  });

  if (!entityResponse.ok) {
    const error = await entityResponse.json();
    throw new Error(error.error || 'Failed to create entity');
  }

  const entity = await entityResponse.json();

  // Create relationships if specified
  const relationResults = [];
  for (const rel of relates_to) {
    try {
      // First, find or create the related entity
      const relatedResponse = await fetch(`${MEMORY_SERVICE_URL}/api/entity`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...memoryAuthHeaders({ token, orgId, userId })
        },
        body: JSON.stringify({
          name: rel.name,
          entity_type: 'concept' // Default type for referenced entities
        })
      });

      if (relatedResponse.ok) {
        const relatedEntity = await relatedResponse.json();

        // Create the relation
        await fetch(`${MEMORY_SERVICE_URL}/api/entity/relation`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...memoryAuthHeaders({ token, orgId, userId })
          },
          body: JSON.stringify({
            source_entity_id: entity.id,
            relation_type: rel.relation,
            target_entity_id: relatedEntity.id,
            context: `${name} ${rel.relation} ${rel.name}`
          })
        });

        relationResults.push({ name: rel.name, relation: rel.relation, success: true });
      }
    } catch (error) {
      relationResults.push({ name: rel.name, relation: rel.relation, success: false, error: error.message });
    }
  }

  return {
    success: true,
    entity_id: entity.id,
    name: entity.name,
    type: entity.entity_type,
    relations_created: relationResults.filter(r => r.success).length,
    message: `Noted ${entity_type} "${name}"${relates_to.length ? ` with ${relationResults.filter(r => r.success).length} relations` : ''}`
  };
}

/**
 * Get human-readable message for tool call
 */
function getToolMessage(toolName, params) {
  switch (toolName) {
    case 'memory_save':
      return `Remembering ${params.type}: "${params.content?.slice(0, 50)}..."`;
    case 'memory_search':
      return `Searching memories for: "${params.query}"`;
    case 'memory_update':
      return `Updating memory ${params.memory_id?.slice(0, 8)}...`;
    case 'memory_forget':
      return `Forgetting memory ${params.memoryId?.slice(0, 8)}...`;
    case 'entity_note':
      return `Recording ${params.entity_type}: "${params.name}"`;
    default:
      return `Calling ${toolName}`;
  }
}

/**
 * Get human-readable message for tool result
 */
function getResultMessage(toolName, result) {
  if (!result.success && result.error) {
    return `Failed: ${result.error}`;
  }

  switch (toolName) {
    case 'memory_save':
      return `Saved memory ${result.memory_id?.slice(0, 8)}`;
    case 'memory_search':
      return `Found ${result.count} relevant memories`;
    case 'memory_update':
      return `Updated memory`;
    case 'memory_forget':
      return `Forgot memory`;
    case 'entity_note':
      return `Noted ${result.type} "${result.name}"`;
    default:
      return `Completed ${toolName}`;
  }
}

/**
 * Check if a tool name is a memory tool
 */
function isMemoryTool(toolName) {
  return ['memory_save', 'memory_search', 'memory_update', 'memory_forget', 'entity_note'].includes(toolName);
}

module.exports = {
  handleMemoryTool,
  isMemoryTool
};
