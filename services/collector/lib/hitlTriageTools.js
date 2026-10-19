'use strict';
/**
 * TRIAGE-TOOLS (2026-10-16): the HITL inbox triage tools TRIAGE-Q asked for.
 *
 * Reads (as the user driving the turn, with that user's inbox visibility):
 *   hitl_queue   ranked + filtered queue: sort priority|due|newest|oldest, min_priority, overdue,
 *                unread, kind, source; each item carries due_at/overdue, age, excerpt, source, link
 *   hitl_item    one item in full (body, payload, assignees, SLA stages)
 *   hitl_groups  open items grouped by exact title, to clear repeated noise in batches
 * Housekeeping (NON-decision items only: info, incident, task; the auth service refuses
 * approval, override_required and question items whatever the caller):
 *   hitl_item_dismiss  dismiss (noise) or resolve (done) one item
 *   hitl_item_snooze   snooze one item for this user
 *   hitl_item_assign   add an org member as an assignee (additive)
 *   hitl_bulk_dismiss  dismiss many INFO items: ALWAYS a proposal a human confirms
 *                      (AGENT_ALWAYS_PROPOSE_TOOLS), and the auth route re-checks that an
 *                      approved hitl_bulk_dismiss approval exists before it changes anything.
 * Approve and deny are NOT here: they stay on approve_request / deny_request.
 *
 * Server truth: services/auth/lib/inboxQueue.js behind the service-key internal router.
 */

const TIMEOUT_MS = 8000;

function authBase() { return process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101'; }

async function authCall(method, path, ctx, { query = {}, body = null } = {}) {
  const orgId = ctx?.orgId;
  const userId = ctx?.userId;
  if (!orgId) return { ok: false, result: { success: false, error: 'No organization context: cannot reach the HITL inbox' } };
  if (!userId) return { ok: false, result: { success: false, error: 'No user identity on this turn: the HITL inbox is read and changed as a user, so this cannot run' } };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  if (method === 'GET') params.set('user_id', userId);
  const qs = params.toString();
  const url = `${authBase()}/api/internal/orgs/${encodeURIComponent(orgId)}${path}${qs ? `?${qs}` : ''}`;
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
        'x-actor-type': 'agent',
        'x-actor-id': String(ctx?.agentId || 'agent'),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify({ ...body, user_id: userId }) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    // An error body is not data: report the status and the server's own words.
    if (!res.ok) return { ok: false, status: res.status, result: { success: false, status: res.status, error: (data && (data.message || data.error)) || `HITL inbox API returned ${res.status}` } };
    if (!data || typeof data !== 'object') return { ok: false, result: { success: false, error: 'HITL inbox API returned a body that is not JSON' } };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, result: { success: false, error: `Failed to reach the HITL inbox: ${err.message}` } };
  }
}

const KIND_ENUM = ['approval', 'question', 'task', 'incident', 'info', 'override_required'];
const itemIdProp = { type: 'string', description: 'The inbox item id (from hitl_queue / inbox_pending).' };

const HITL_TRIAGE_TOOLS = {
  hitl_queue: {
    name: 'hitl_queue',
    description: 'Read the HITL inbox queue (the Quox work queue of approvals, incidents, tasks, questions and info; not email) RANKED and FILTERED, as the current user sees it. Use this to answer "what is urgent", "which item is overdue", "what is unread", "what did LUCID file". sort: priority (default; urgent first, overdue first within a priority), due (soonest deadline first), newest, oldest. Filters: min_priority (e.g. "high" = high and urgent), overdue (true = open/in_progress items past their due_at), unread, kind, source (e.g. "lucid", "service_monitor"), status (open default, active, all). Each item has id, title, kind, priority, status, age_minutes, due_at, overdue (+ overdue_by_minutes / due_in_minutes), next_escalation (its own SLA stage, when it has one), source, excerpt, link. A pending decision (quox ask) also has a decision block: every option with its LABEL, recommend_label and any unlabelled keys; recommend it in words with the key in brackets and name the question by its title, never a bare letter, and never invent a meaning for an unlabelled option. total is every match, not the page. Items with no due_at have no deadline (there is no per-kind SLA policy); say so and give their age.',
    input_schema: {
      type: 'object',
      properties: {
        sort: { type: 'string', enum: ['priority', 'due', 'newest', 'oldest'], description: 'Ordering. Default priority.' },
        min_priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Only items at this priority or above.' },
        overdue: { type: 'boolean', description: 'Only items past their due_at (open or in_progress).' },
        unread: { type: 'boolean', description: 'Only items the current user has not read.' },
        kind: { type: 'string', enum: KIND_ENUM, description: 'Only this kind.' },
        source: { type: 'string', description: 'Only items whose payload source (or agent_id) is this, e.g. lucid.' },
        status: { type: 'string', description: 'open (default), active (open, in_progress, waiting), all, or a comma list.' },
        include_snoozed: { type: 'boolean', description: 'Include items the user snoozed (hidden by default).' },
        limit: { type: 'number', description: 'Max items per page (default 20, max 200). total says how many match; page on with offset when truncated.' },
        offset: { type: 'number', description: 'Skip this many (paging).' },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      const i = input || {};
      const r = await authCall('GET', '/inbox/queue', ctx, { query: { sort: i.sort, min_priority: i.min_priority, overdue: i.overdue ? 'true' : undefined, unread: i.unread ? 'true' : undefined, kind: i.kind, source: i.source, status: i.status, include_snoozed: i.include_snoozed ? 'true' : undefined, limit: i.limit, offset: i.offset } });
      if (!r.ok) return r.result;
      const d = r.data;
      const items = Array.isArray(d.items) ? d.items : [];
      return {
        success: true, count: items.length, total: Number.isInteger(d.total) ? d.total : null, truncated: !!d.truncated,
        sort: d.sort, filter: d.filter, items, sla_note: d.sla_note,
        ...(d.truncated ? { note: `Showing ${items.length} of ${d.total}. Page with offset, or use hitl_groups to see repeated titles.` } : {}),
      };
    },
  },

  hitl_item: {
    name: 'hitl_item',
    description: 'Read ONE HITL inbox item in full: body, payload (the context behind it), response, assignees, due_at / overdue and its SLA escalation stages. Use before recommending anything about a specific item, instead of guessing from the title.',
    input_schema: { type: 'object', properties: { item_id: itemIdProp }, required: ['item_id'] },
    execute: async (input, ctx) => {
      const id = String(input?.item_id || '').trim();
      if (!id) return { success: false, error: 'item_id is required' };
      const r = await authCall('GET', `/inbox/queue/items/${encodeURIComponent(id)}`, ctx);
      if (!r.ok) return r.result;
      return { success: true, item: r.data.item };
    },
  },

  hitl_groups: {
    name: 'hitl_groups',
    description: 'Group the HITL inbox by exact title (count, kinds, top priority, oldest and newest, sample ids), largest first. Use to find repeated noise (e.g. dozens of identical LUCID findings or info notices) so it can be cleared in one batch with hitl_bulk_dismiss. Only info groups can be bulk dismissed; an incident or task group is closed item by item with hitl_item_dismiss after reading each one.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KIND_ENUM, description: 'Only this kind (e.g. info).' },
        source: { type: 'string', description: 'Only items from this source, e.g. lucid.' },
        status: { type: 'string', description: 'open (default), active, all.' },
        min_count: { type: 'number', description: 'Smallest group to show (default 2).' },
        limit: { type: 'number', description: 'Max groups (default 25, max 100).' },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      const i = input || {};
      const r = await authCall('GET', '/inbox/queue/groups', ctx, { query: { kind: i.kind, source: i.source, status: i.status, min_count: i.min_count, limit: i.limit } });
      if (!r.ok) return r.result;
      return { success: true, ...r.data };
    },
  },

  hitl_item_dismiss: {
    name: 'hitl_item_dismiss',
    description: 'Close ONE non-decision HITL inbox item (info, incident or task): mode "dismiss" (noise, not acted on) or "resolve" (done). Never works on approvals, overrides or questions: those are a human decision (the server refuses them). Report exactly what the tool returned; for many items of the same title use hitl_bulk_dismiss.',
    input_schema: {
      type: 'object',
      properties: {
        item_id: itemIdProp,
        mode: { type: 'string', enum: ['dismiss', 'resolve'], description: 'dismiss (default) or resolve.' },
        reason: { type: 'string', description: 'Short reason, recorded on the item.' },
      },
      required: ['item_id'],
    },
    execute: async (input, ctx) => {
      const id = String(input?.item_id || '').trim();
      if (!id) return { success: false, error: 'item_id is required' };
      const mode = input?.mode === 'resolve' ? 'resolve' : 'dismiss';
      const r = await authCall('POST', `/inbox/queue/items/${encodeURIComponent(id)}/housekeep`, ctx, { body: { action: mode, reason: input?.reason || '' } });
      if (!r.ok) return r.result;
      return { success: true, ...r.data };
    },
  },

  hitl_item_snooze: {
    name: 'hitl_item_snooze',
    description: 'Snooze ONE non-decision HITL inbox item (info, incident or task) for the current user until a time, hiding it from their queue until then. Give until (ISO 8601) or hours. Pass clear:true to un-snooze. Never works on approvals, overrides or questions.',
    input_schema: {
      type: 'object',
      properties: {
        item_id: itemIdProp,
        until: { type: 'string', description: 'ISO 8601 date-time in the future (max 90 days).' },
        hours: { type: 'number', description: 'Snooze for this many hours instead of until.' },
        clear: { type: 'boolean', description: 'Un-snooze.' },
      },
      required: ['item_id'],
    },
    execute: async (input, ctx) => {
      const id = String(input?.item_id || '').trim();
      if (!id) return { success: false, error: 'item_id is required' };
      let until = null;
      if (!input?.clear) {
        if (input?.until) until = String(input.until);
        else if (Number.isFinite(Number(input?.hours)) && Number(input.hours) > 0) until = new Date(Date.now() + Number(input.hours) * 3600_000).toISOString();
        else return { success: false, error: 'Give until (ISO 8601), hours, or clear:true' };
      }
      const r = await authCall('POST', `/inbox/queue/items/${encodeURIComponent(id)}/housekeep`, ctx, { body: { action: 'snooze', until } });
      if (!r.ok) return r.result;
      return { success: true, ...r.data };
    },
  },

  hitl_item_assign: {
    name: 'hitl_item_assign',
    description: 'Add an org member as an assignee of ONE non-decision HITL inbox item (info, incident or task). Additive: nobody is removed. The assignee must be an active member (find user ids with org_directory). Never works on approvals, overrides or questions.',
    input_schema: {
      type: 'object',
      properties: { item_id: itemIdProp, assignee_user_id: { type: 'string', description: 'User id of the org member to add.' } },
      required: ['item_id', 'assignee_user_id'],
    },
    execute: async (input, ctx) => {
      const id = String(input?.item_id || '').trim();
      const who = String(input?.assignee_user_id || '').trim();
      if (!id || !who) return { success: false, error: 'item_id and assignee_user_id are required' };
      const r = await authCall('POST', `/inbox/queue/items/${encodeURIComponent(id)}/housekeep`, ctx, { body: { action: 'assign', assignee_user_id: who } });
      if (!r.ok) return r.result;
      return { success: true, ...r.data };
    },
  },

  hitl_bulk_dismiss: {
    name: 'hitl_bulk_dismiss',
    description: 'Dismiss many INFO items in the HITL inbox at once: every open info item with one exact title (from hitl_groups), or a list of item ids (max 500). INFO ONLY: incidents and tasks are never bulk dismissed; check each incident first and close it one at a time with hitl_item_dismiss, and never offer a batch of incidents. Anything that is not info in the list is skipped and reported. This ALWAYS goes through the approval gate: you propose, a human confirms. Report it as proposed, never as done.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Exact title of the info items to dismiss (from hitl_groups).' },
        item_ids: { type: 'array', items: { type: 'string' }, description: 'Specific item ids instead of a title.' },
        reason: { type: 'string', description: 'Why these are noise; shown on the approval card and recorded.' },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      const i = input || {};
      const ids = Array.isArray(i.item_ids) ? i.item_ids.map(String).filter(Boolean) : [];
      if (!ids.length && !i.title) return { success: false, error: 'Give a title (from hitl_groups) or item_ids' };
      if (ids.length > 500) return { success: false, error: 'At most 500 items per bulk dismiss' };
      const { withApprovalGate } = require('./approvalGate');
      return withApprovalGate('hitl_bulk_dismiss', i, async () => {
        const r = await authCall('POST', '/inbox/queue/bulk-dismiss', ctx, { body: { title: ids.length ? undefined : i.title, item_ids: ids.length ? ids : undefined, reason: i.reason || '', approval_id: i._approvalId || null } });
        if (!r.ok) return r.result;
        return { success: true, applied: true, ...r.data };
      }, ctx || {});
    },
  },
};

module.exports = { HITL_TRIAGE_TOOLS, authCall };
