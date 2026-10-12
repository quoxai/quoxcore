// Action Tool Handlers
// Execute action tool calls from agents — proxies to auth service for scoped storage
// Pattern: mirrors memoryToolHandlers.js

const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
const TASKS_URL = `http://${process.env.TASKS_HOST || 'tasks'}:${process.env.TASKS_PORT || '3104'}`;
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

// Maximum items accepted by bulk operations (no bulk handlers currently — guard is future-proof)
const MAX_BULK_ITEMS = 100;

// ============================================================================
// AEE Audit Envelope — injected by server.js via setAuditFn()
// Falls back to a no-op so the module works without wiring.
// ============================================================================

let _storeAuditEnvelope = () => {};

/**
 * Wire in the server's storeAuditEnvelope function.
 * Call once at startup: setAuditFn(storeAuditEnvelope)
 */
function setAuditFn(fn) {
  if (typeof fn === 'function') _storeAuditEnvelope = fn;
}

/**
 * Emit one AEE envelope for a successful action tool call.
 * Silently swallowed on error — never breaks the caller.
 */
function emitActionAudit(toolName, ctx, payload) {
  try {
    _storeAuditEnvelope({
      type: 'event',
      from: `agent.${ctx.agentId || 'action-q'}`,
      to: 'service.collector',
      intent: `quox.actions.${toolName}`,
      corr: ctx.corr || ctx.conversationId || `ACTION_${Date.now()}`,
      payload,
    });
  } catch (_) { /* non-fatal */ }
}

/**
 * Handle action tool calls from agents
 * @param {string} toolName - The tool being called
 * @param {object} params - Tool parameters
 * @param {object} context - Execution context (orgId, userId, agentId, conversationId, token)
 * @param {function} emit - Function to emit streaming events
 * @returns {object} Tool result
 */
async function handleActionTool(toolName, params, context, emit) {
  const { agentId } = context;

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
      case 'action_add':
        result = await actionAdd(params, context);
        break;
      case 'action_list':
        result = await actionList(params, context);
        break;
      case 'action_move':
        result = await actionMove(params, context);
        break;
      case 'action_update':
        result = await actionUpdate(params, context);
        break;
      case 'action_delete':
        result = await actionDelete(params, context);
        break;
      case 'action_analyse':
        result = await actionAnalyse(params, context);
        break;
      case 'action_delegate':
        result = await actionDelegate(params, context);
        break;
      default:
        throw new Error(`Unknown action tool: ${toolName}`);
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
    console.error(`[Action Tool] ${toolName} error:`, error);

    if (emit) {
      emit('thinking', {
        stage: 'tool_error',
        agent: agentId,
        message: `Action operation failed: ${error.message}`,
        tool: toolName,
        error: error.message
      });
    }

    return { error: error.message, success: false };
  }
}

// ============================================================================
// Auth service HTTP helpers
// ============================================================================

/**
 * Make an authenticated request to the auth service action endpoints
 */
async function authRequest(method, path, context, body = null) {
  const { orgId, token } = context;
  if (!orgId) throw new Error('No org context — cannot store action items without an organization');

  const url = `${AUTH_URL}/api/orgs/${orgId}/actions${path}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
    }
  };

  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }
  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `Auth service returned ${res.status}`);
  }

  return data;
}

/**
 * AGENT-OVERHAUL: service-key-authenticated request to the auth service's
 * internal Action Tracker routes (services/auth/routes/internal-actions.js).
 * Used ONLY for agent-initiated writes (action_add/move/update/delete),
 * which run server-to-server with no browser session — they can never carry
 * a CSRF double-submit cookie/header pair, so the user-facing CSRF-gated
 * /api/orgs/:orgId/actions route 403'd them with "Missing CSRF token header".
 *
 * The internal route is CSRF-exempt (/api/internal/ prefix) and service-key
 * gated, but still enforces the SAME per-org, per-user authorization the
 * user-facing route does: org_id AND user_id are threaded through explicitly
 * from the agent's request context (never a wildcard/"any org"), and the
 * auth service re-validates active org membership + creator/assignee/admin
 * permissions server-side. Reads (action_list/analyse/delegate) are
 * unchanged — they use authRequest() against the user-facing GET routes,
 * which are not CSRF-gated.
 */
async function internalActionRequest(method, path, context, body = null) {
  const { orgId, userId } = context;
  if (!orgId) throw new Error('No org context — cannot store action items without an organization');
  if (!userId) throw new Error('No user context — cannot store action items without an authenticated user');
  if (!INTERNAL_SERVICE_KEY) throw new Error('Action Tracker internal service key not configured');

  const url = `${AUTH_URL}/api/internal/actions${path}`;
  const payload = { ...(body || {}), org_id: orgId, user_id: userId };
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Key': INTERNAL_SERVICE_KEY,
    },
    body: JSON.stringify(payload),
  };

  const res = await fetch(url, options);
  const data = await res.json();

  // Guard on status BEFORE treating the body as data — a non-2xx must never
  // be reported as a successful write.
  if (!res.ok) {
    throw new Error(data?.error || data?.message || `Auth service returned ${res.status}`);
  }

  return data;
}

// ============================================================================
// Tool implementations — each proxies to auth service
// ============================================================================

/**
 * Create a new action item
 */
async function actionAdd(params, context) {
  const { title, priority, category, dueDate, description, scope_id } = params;
  const { agentId } = context;

  if (!title || !title.trim()) {
    throw new Error('Title is required');
  }

  const data = await internalActionRequest('POST', '', context, {
    title: title.trim(),
    description: (description || '').trim(),
    priority: priority || 'medium',
    category: (category || '').trim(),
    due_date: dueDate || null,
    scope_id: scope_id || null,
    source: 'ai',
    source_agent: agentId || 'quox'
  });

  const item = data.item;
  console.log(`[Action Tool] Added "${title}" for org ${context.orgId} (by ${agentId})`);

  const result = {
    success: true,
    item,
    message: `Added "${title}" to Action Tracker (TODO, ${item.priority} priority)`
  };
  emitActionAudit('action_add', context, { item_id: item.id, title, priority: item.priority });
  return result;
}

/**
 * List action items
 */
async function actionList(params, context) {
  // ACTIONQ-FIX-SPEC 1d: forward page, and expose nextPage/hasMore/totalCount
  // from the server's real pagination — a tool-level "truncated" flag that
  // only compared this page's count against the total used to flag every
  // non-final page as truncated even when more is reachable via `page`.
  const { status = 'all', limit = 20, scope_id, page = 1 } = params;

  const query = new URLSearchParams();
  if (status && status !== 'all') query.set('status', status);
  if (limit) query.set('limit', String(Math.min(Math.max(1, limit), 100)));
  if (scope_id) query.set('scope_id', scope_id);
  query.set('page', String(Math.max(1, parseInt(page, 10) || 1)));

  const data = await authRequest('GET', `?${query.toString()}`, context);

  const items = data.items || [];
  const pagination = data.pagination || {};
  const total = pagination.total ?? items.length;
  const hasMore = pagination.has_more ?? false;

  return {
    success: true,
    items: items.map(item => ({
      id: item.id,
      title: item.title,
      description: item.description || '',
      priority: item.priority,
      category: item.category || '',
      dueDate: item.due_date,
      status: item.status,
      createdAt: item.created_at,
      source: item.source || 'user',
      scopeName: item.scope_name || null
    })),
    count: items.length,
    totalCount: total,
    page: pagination.page || Number(query.get('page')),
    hasMore,
    nextPage: pagination.next_page ?? (hasMore ? (pagination.page || Number(query.get('page'))) + 1 : null),
    truncated: hasMore,
    message: `Found ${items.length} action item${items.length !== 1 ? 's' : ''}${status !== 'all' ? ` (${status})` : ''}`
  };
}

/**
 * Move an action item to a different status
 */
async function actionMove(params, context) {
  const { id, status } = params;

  if (!id) throw new Error('Item ID is required');
  if (!['todo', 'doing', 'done'].includes(status)) {
    throw new Error('Status must be one of: todo, doing, done');
  }

  const data = await internalActionRequest('PATCH', `/${id}`, context, { status });
  const item = data.item;

  console.log(`[Action Tool] Moved "${item.title}" to ${status} for org ${context.orgId}`);

  const result = {
    success: true,
    item: {
      id: item.id,
      title: item.title,
      status: item.status,
      priority: item.priority,
      completedAt: item.completed_at
    },
    message: `Moved "${item.title}" to ${status.toUpperCase()}`
  };
  emitActionAudit('action_move', context, { item_id: id, title: item.title, status });
  return result;
}

/**
 * Update fields on an existing action item
 */
async function actionUpdate(params, context) {
  const { id, ...updates } = params;

  if (!id) throw new Error('Item ID is required');

  // Map camelCase params to snake_case for auth service
  const body = {};
  if (updates.title !== undefined) body.title = updates.title;
  if (updates.description !== undefined) body.description = updates.description;
  if (updates.priority !== undefined) body.priority = updates.priority;
  if (updates.category !== undefined) body.category = updates.category;
  if (updates.dueDate !== undefined) body.due_date = updates.dueDate;

  const data = await internalActionRequest('PATCH', `/${id}`, context, body);
  const item = data.item;

  console.log(`[Action Tool] Updated "${item.title}" fields: ${(data.changedFields || []).join(', ')} for org ${context.orgId}`);

  const result = {
    success: true,
    item: {
      id: item.id,
      title: item.title,
      priority: item.priority,
      category: item.category,
      dueDate: item.due_date,
      status: item.status
    },
    changedFields: data.changedFields || [],
    message: `Updated "${item.title}" (${(data.changedFields || []).join(', ')})`
  };
  emitActionAudit('action_update', context, { item_id: id, changedFields: data.changedFields || [] });
  return result;
}

/**
 * Delete an action item
 */
async function actionDelete(params, context) {
  const { id } = params;

  if (!id) throw new Error('Item ID is required');

  const data = await internalActionRequest('DELETE', `/${id}`, context);

  console.log(`[Action Tool] Deleted "${data.title}" for org ${context.orgId}`);

  const result = {
    success: true,
    deleted: true,
    title: data.title,
    message: `Deleted "${data.title}"`
  };
  emitActionAudit('action_delete', context, { item_id: id, title: data.title });
  return result;
}

// ============================================================================
// Part 1: AI Analysis — proactive task scanning
// ============================================================================

const DELEGATABLE_KEYWORDS = [
  { keywords: ['security', 'vulnerability', 'audit', 'firewall', 'ssl', 'certificate'], team: 'security-team', label: 'Security' },
  { keywords: ['infrastructure', 'server', 'deploy', 'docker', 'container', 'host', 'nginx', 'dns'], team: 'quoxcore', label: 'Infrastructure' },
  { keywords: ['monitor', 'metrics', 'alert', 'health', 'uptime', 'grafana'], team: 'quoxcore', label: 'Monitoring' },
  { keywords: ['backup', 'restore', 'disaster', 'recovery'], team: 'quoxcore', label: 'Backup' },
];

/**
 * Analyse all open action items and return structured insights
 */
// ACTIONQ-FIX-SPEC 1d: a bounded page budget per status — analysis traverses
// every todo/doing page up to this many pages (500 items/status) before
// explicitly reporting truncated:true, rather than silently stopping (or
// false-flagging) at a single 100-item page.
const ANALYSE_MAX_PAGES_PER_STATUS = 5;

/**
 * Fetch every page for one status, bounded by ANALYSE_MAX_PAGES_PER_STATUS.
 * Returns { items, truncated } — truncated is only true when the budget was
 * exhausted while the server still reported more pages (has_more), never
 * merely because a page happened to be exactly full.
 */
async function fetchAllOpenPages(status, context) {
  const items = [];
  let truncated = false;
  for (let page = 1; page <= ANALYSE_MAX_PAGES_PER_STATUS; page++) {
    const data = await authRequest('GET', `?status=${status}&limit=100&page=${page}`, context);
    items.push(...(data.items || []));
    const hasMore = data.pagination?.has_more ?? false;
    if (!hasMore) break;
    if (page === ANALYSE_MAX_PAGES_PER_STATUS) truncated = true;
  }
  return { items, truncated };
}

async function actionAnalyse(params, context) {
  // Fetch every open todo/doing page (bounded budget) rather than a single
  // page per status — a single 100-item page previously both missed task
  // 101+ AND false-flagged an exactly-100 board as truncated.
  const [todo, doing] = await Promise.all([
    fetchAllOpenPages('todo', context),
    fetchAllOpenPages('doing', context),
  ]);
  const todoItems = todo.items;
  const doingItems = doing.items;
  const items = [...todoItems, ...doingItems];
  const truncated = todo.truncated || doing.truncated;

  if (items.length === 0) {
    return {
      success: true,
      analysis: { totalOpen: 0, suggestions: ['Your board is clear. Well done.'] },
      message: 'No open action items found.'
    };
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // Group by category and priority
  const byCategory = {};
  const byPriority = {};
  let overdueCount = 0;
  let oldestItem = null;
  let oldestAge = 0;
  const staleItems = []; // >7 days in TODO
  const delegatableItems = [];

  for (const item of items) {
    const cat = item.category || 'uncategorised';
    byCategory[cat] = (byCategory[cat] || 0) + 1;

    const pri = item.priority || 'none';
    byPriority[pri] = (byPriority[pri] || 0) + 1;

    // Overdue check
    if (item.due_date && item.due_date < todayStr) {
      overdueCount++;
    }

    // Age calculation
    const created = new Date(item.created_at || item.createdAt || now);
    const ageDays = Math.floor((now - created) / 86400000);
    if (ageDays > oldestAge) {
      oldestAge = ageDays;
      oldestItem = item;
    }

    // Stale check (>7 days in TODO)
    if (item.status === 'todo' && created < sevenDaysAgo) {
      staleItems.push({ id: item.id, title: item.title, ageDays });
    }

    // Delegatable check (matches infrastructure/security keywords)
    const text = `${item.title} ${item.description || ''}`.toLowerCase();
    for (const rule of DELEGATABLE_KEYWORDS) {
      if (rule.keywords.some(kw => text.includes(kw))) {
        delegatableItems.push({ id: item.id, title: item.title, suggestedTeam: rule.team, domain: rule.label });
        break;
      }
    }
  }

  const avgAge = items.length > 0
    ? Math.round(items.reduce((sum, i) => sum + Math.floor((now - new Date(i.created_at || i.createdAt || now)) / 86400000), 0) / items.length)
    : 0;

  // Build suggestions
  const suggestions = [];

  if (overdueCount > 0) {
    const highestOverdue = items
      .filter(i => i.due_date && i.due_date < todayStr)
      .sort((a, b) => {
        const pa = { urgent: 4, high: 3, medium: 2, low: 1 }[a.priority] || 0;
        const pb = { urgent: 4, high: 3, medium: 2, low: 1 }[b.priority] || 0;
        return pb - pa;
      })[0];
    suggestions.push(`You have ${overdueCount} overdue item${overdueCount !== 1 ? 's' : ''} — highest priority: "${highestOverdue.title}"`);
  }

  if (staleItems.length > 0) {
    suggestions.push(`${staleItems.length} item${staleItems.length !== 1 ? 's have' : ' has'} been in TODO for >7 days — consider archiving or delegating`);
  }

  if (delegatableItems.length > 0) {
    const names = delegatableItems.slice(0, 3).map(d => `"${d.title}" (${d.domain})`).join(', ');
    suggestions.push(`These tasks could be handled by agents: ${names}${delegatableItems.length > 3 ? ` and ${delegatableItems.length - 3} more` : ''}`);
  }

  if (oldestItem) {
    suggestions.push(`Oldest open item: "${oldestItem.title}" (${oldestAge} days old)`);
  }

  if (suggestions.length === 0) {
    suggestions.push('Your board looks healthy. Keep it up.');
  }

  const analysis = {
    totalOpen: items.length,
    todoCount: items.filter(i => i.status === 'todo').length,
    doingCount: items.filter(i => i.status === 'doing').length,
    overdueCount,
    avgAgeDays: avgAge,
    oldestItem: oldestItem ? { title: oldestItem.title, ageDays: oldestAge } : null,
    byCategory,
    byPriority,
    staleItems: staleItems.slice(0, 5),
    delegatableItems: delegatableItems.slice(0, 5),
    suggestions,
    truncated,
  };

  console.log(`[Action Tool] Analysis complete: ${items.length} open items, ${overdueCount} overdue, ${delegatableItems.length} delegatable${truncated ? ' (partial — column hit 100 cap)' : ''}`);

  const result = {
    success: true,
    analysis,
    message: `Analysis of ${items.length} open items: ${overdueCount} overdue, ${staleItems.length} stale, ${delegatableItems.length} delegatable to agents${truncated ? ' — note: at least one column has 100+ items, analysis is partial' : ''}`
  };
  emitActionAudit('action_analyse', context, { totalOpen: items.length, overdueCount, staleCount: staleItems.length, delegatableCount: delegatableItems.length });
  return result;
}

// ============================================================================
// Part 2: Task → Objective delegation
// ============================================================================

/**
 * Delegate an action item to an agentic objective
 */
async function actionDelegate(params, context) {
  const { id, team_id } = params;
  if (!id) throw new Error('Action item ID is required');

  // Fetch the action item directly (GET /orgs/:orgId/actions/:id added by parent sprint)
  const itemData = await authRequest('GET', `/${id}`, context);
  const item = itemData.item || itemData;
  if (!item || !item.id) throw new Error(`Action item ${id} not found`);

  // Auto-select team based on keywords if not specified
  let teamId = team_id || null;
  if (!teamId) {
    const text = `${item.title} ${item.description || ''}`.toLowerCase();
    for (const rule of DELEGATABLE_KEYWORDS) {
      if (rule.keywords.some(kw => text.includes(kw))) {
        teamId = rule.team;
        break;
      }
    }
  }

  // Build objective description
  const description = [
    item.description || '',
    item.notes ? `Notes: ${item.notes}` : '',
    `Delegated from Action-Q item [${id.slice(0, 8)}]`,
    item.priority ? `Priority: ${item.priority}` : '',
    item.category ? `Category: ${item.category}` : '',
  ].filter(Boolean).join('\n');

  // Create objective via tasks service
  const headers = {
    'Content-Type': 'application/json',
    'X-Service-Key': INTERNAL_SERVICE_KEY,
  };

  const createPayload = {
    title: item.title,
    description,
    org_id: context.orgId,
    user_id: context.userId,
  };
  if (teamId) createPayload.team_id = teamId;

  const createRes = await fetch(`${TASKS_URL}/api/objectives`, {
    method: 'POST',
    headers,
    body: JSON.stringify(createPayload),
    signal: AbortSignal.timeout(15000),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Failed to create objective: ${createRes.status} ${errText}`);
  }

  const createData = await createRes.json();
  const objectiveId = createData.id || createData.objective?.id;
  if (!objectiveId) throw new Error('Objective creation returned no ID');

  // Auto-start the objective (skip checkpoint for automated delegation)
  try {
    const startRes = await fetch(`${TASKS_URL}/api/objectives/${objectiveId}/start?skip_checkpoint=true`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!startRes.ok) {
      console.warn(`[Action Tool] Objective created but start failed: ${startRes.status}`);
    }
  } catch (err) {
    console.warn(`[Action Tool] Objective start failed (non-fatal): ${err.message}`);
  }

  // Update the action item: move to 'doing' and add delegation metadata in notes
  const notesJson = JSON.stringify({
    delegated_objective_id: objectiveId,
    delegated_at: new Date().toISOString(),
    delegated_team: teamId || 'auto',
  });
  const updatedNotes = item.notes
    ? `${item.notes}\n---\nDelegated to objective ${objectiveId}`
    : `Delegated to objective ${objectiveId}`;

  await authRequest('PATCH', `/${id}`, context, {
    status: 'doing',
    notes: updatedNotes,
    // Store structured metadata in description if notes is display-only
    description: item.description
      ? `${item.description}\n\n[delegation_meta]${notesJson}[/delegation_meta]`
      : `[delegation_meta]${notesJson}[/delegation_meta]`,
  });

  console.log(`[Action Tool] Delegated "${item.title}" to objective ${objectiveId} (team: ${teamId || 'auto'})`);

  const result = {
    success: true,
    objectiveId,
    title: item.title,
    teamId: teamId || 'auto-selected',
    message: `Delegated "${item.title}" to objective ${objectiveId}${teamId ? ` (team: ${teamId})` : ''} — watch progress in OpsDeck`,
    opsDeckLink: `/opsdeck?objective=${objectiveId}`,
  };
  emitActionAudit('action_delegate', context, { item_id: id, title: item.title, objectiveId, teamId: teamId || 'auto' });
  return result;
}

// ============================================================================
// Visibility helpers
// ============================================================================

function getToolMessage(toolName, params) {
  switch (toolName) {
    case 'action_add':
      return `Adding action: "${params.title?.slice(0, 50)}"`;
    case 'action_list':
      return `Listing actions${params.status && params.status !== 'all' ? ` (${params.status})` : ''}`;
    case 'action_move':
      return `Moving action ${params.id?.slice(0, 8)}... to ${params.status}`;
    case 'action_update':
      return `Updating action ${params.id?.slice(0, 8)}...`;
    case 'action_delete':
      return `Deleting action ${params.id?.slice(0, 8)}...`;
    case 'action_analyse':
      return `Analysing action board...`;
    case 'action_delegate':
      return `Delegating action ${params.id?.slice(0, 8)}... to agentic objective`;
    default:
      return `Calling ${toolName}`;
  }
}

function getResultMessage(toolName, result) {
  if (!result.success && result.error) {
    return `Failed: ${result.error}`;
  }

  switch (toolName) {
    case 'action_add':
      return `Added "${result.item?.title}"`;
    case 'action_list':
      return `Found ${result.count} action item${result.count !== 1 ? 's' : ''}`;
    case 'action_move':
      return `Moved to ${result.item?.status?.toUpperCase()}`;
    case 'action_update':
      return `Updated (${result.changedFields?.join(', ')})`;
    case 'action_delete':
      return `Deleted "${result.title}"`;
    case 'action_analyse':
      return `Analysis: ${result.analysis?.totalOpen || 0} open items, ${result.analysis?.overdueCount || 0} overdue`;
    case 'action_delegate':
      return `Delegated to objective ${result.objectiveId}`;
    default:
      return `Completed ${toolName}`;
  }
}

/**
 * Check if a tool name is an action tool
 */
function isActionTool(toolName) {
  return ['action_add', 'action_list', 'action_move', 'action_update', 'action_delete', 'action_analyse', 'action_delegate'].includes(toolName);
}

module.exports = {
  handleActionTool,
  isActionTool,
  setAuditFn,
  // Exported for testing
  authRequest
};
