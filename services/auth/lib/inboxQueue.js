/**
 * inboxQueue: the triage read side and the safe housekeeping writes for the HITL inbox
 * (TRIAGE-TOOLS, owner ask 2026-10-16 via TRIAGE-Q: "which item is overdue?", "rank the urgent
 * ones", "let me clear the info noise in batches").
 *
 * Reads run as a user: the same visibility as the dashboard list and inboxStats (owners and
 * admins see the whole org, members see their personal inbox, items filed by them and items
 * assigned to them). Unread and snoozed are that user's own per-assignee state.
 *
 * SLA: the schema's real deadline is inbox_items.due_at (+ escalation_stages for staged SLAs).
 * There is NO per-kind SLA policy anywhere in the product, so nothing is derived: an item with
 * no due_at has no deadline, and the read says so and gives its age instead.
 *
 * Writes (housekeeping) NEVER touch a decision: approval, override_required and question
 * items (a question asks a human; a decision is a question) are refused here, whatever the
 * caller. Resolving or denying those stays on the governed respond path.
 */
import { prepare, transaction } from '../db/index.js';
import { visibilityClause } from './openApprovals.js';
import { decisionBrief } from './decisions.js';
import { ulid } from '../utils/helpers.js';

export const PRIORITY_RANK = { low: 1, normal: 2, high: 3, urgent: 4 };
export const HOUSEKEEPING_KINDS = ['info', 'incident', 'task'];
export const DECISION_KINDS = ['approval', 'override_required', 'question'];
const ACTIVE = ['open', 'in_progress', 'waiting'];
const ALL_STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'cancelled', 'expired'];
const SORTS = ['priority', 'newest', 'oldest', 'due'];
const KINDS = ['approval', 'question', 'task', 'incident', 'info', 'override_required'];
export const BULK_DISMISS_MAX = 500;
export const QUEUE_MAX_LIMIT = 200;

// julianday() reads both ISO-8601 ('2026-10-16T01:00:00.000Z') and SQLite ('2026-10-16 01:00:00')
// forms; a raw string compare against datetime('now') misorders same-day ISO values.
export const OVERDUE_SQL = `ii.status IN ('open', 'in_progress') AND ii.due_at IS NOT NULL AND julianday(ii.due_at) < julianday('now')`;
const PRIORITY_ORDER = `CASE ii.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END`;
const ORDER_BY = {
  priority: `${PRIORITY_ORDER} DESC, (CASE WHEN ${OVERDUE_SQL} THEN 1 ELSE 0 END) DESC, ii.created_at DESC`,
  newest: 'ii.created_at DESC',
  oldest: 'ii.created_at ASC',
  due: `(ii.due_at IS NULL) ASC, julianday(ii.due_at) ASC, ${PRIORITY_ORDER} DESC, ii.created_at DESC`,
};

function parseJson(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
function minutesBetween(a, b) {
  const x = Date.parse(a); const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 60000) : null;
}
// SQLite datetime('now') has no zone marker; it is UTC.
function asUtc(ts) {
  if (!ts) return ts;
  const s = String(ts);
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
}
function excerptOf(row, payload, max = 240) {
  const p = payload || {};
  const raw = row.body_md || p.what?.summary || p.summary || p.description || p.message || p.detail || '';
  const flat = String(raw).replace(/[#*_`>]+/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
function sourceOf(row, payload) {
  const p = payload || {};
  return p.source || p.agent_id || p.agentId || p.toolName || p.type || (row.quoxflow_execution_id ? 'workflow' : null) || (row.created_by ? 'user' : 'system');
}

/** The membership row a user-scoped read needs, or null when the user is not an active member. */
export function activeMembership(orgId, userId) {
  const m = prepare('SELECT role, status, expires_at FROM org_memberships WHERE org_id = ? AND user_id = ?').get(orgId, userId);
  const expired = m?.expires_at && !Number.isNaN(Date.parse(m.expires_at)) && Date.parse(m.expires_at) <= Date.now();
  if (!m || m.status !== 'active' || expired) return null;
  return { role: m.role, isOrgAdmin: ['owner', 'admin'].includes(m.role) };
}

/** Normalise and validate queue filters. -> { filters } or { error }. */
export function parseQueueFilters(q = {}) {
  const f = {};
  const status = typeof q.status === 'string' ? q.status.trim().toLowerCase() : '';
  if (!status || status === 'open') f.statuses = ['open'];
  else if (status === 'active') f.statuses = ACTIVE;
  else if (status === 'all') f.statuses = null;
  else {
    const list = status.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.some((s) => !ALL_STATUSES.includes(s))) return { error: `status must be open, active, all or one of ${ALL_STATUSES.join(', ')}` };
    f.statuses = list;
  }
  if (q.kind) {
    const kinds = String(q.kind).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (kinds.some((k) => !KINDS.includes(k))) return { error: `kind must be one of ${KINDS.join(', ')}` };
    f.kinds = kinds;
  }
  if (q.min_priority) {
    const mp = String(q.min_priority).trim().toLowerCase();
    if (!PRIORITY_RANK[mp]) return { error: 'min_priority must be low, normal, high or urgent' };
    f.minRank = PRIORITY_RANK[mp];
  }
  const truthy = (v) => v === true || v === 'true' || v === '1' || v === 1;
  f.overdue = truthy(q.overdue);
  f.unread = truthy(q.unread);
  f.includeSnoozed = truthy(q.include_snoozed);
  if (q.source) f.source = String(q.source).trim().slice(0, 120);
  if (q.title) f.title = String(q.title).slice(0, 300);
  const sort = q.sort ? String(q.sort).trim().toLowerCase() : 'priority';
  if (!SORTS.includes(sort)) return { error: `sort must be one of ${SORTS.join(', ')}` };
  f.sort = sort;
  const lim = parseInt(q.limit, 10);
  // TRIAGE-Q asked for 200 urgent and got a capped page (11 of 49 from inbox_pending): one page
  // holds up to QUEUE_MAX_LIMIT, and total + truncated always say when more exist.
  f.limit = Math.min(Math.max(Number.isFinite(lim) ? lim : 20, 1), QUEUE_MAX_LIMIT);
  const off = parseInt(q.offset, 10);
  f.offset = Number.isFinite(off) && off > 0 ? off : 0;
  return { filters: f };
}

function whereFor({ orgId, userId, isOrgAdmin, personalInboxId, f }) {
  const conds = ['ii.org_id = ?', 'ii.deleted_at IS NULL'];
  const params = [orgId];
  const vis = visibilityClause({ isOrgAdmin, personalInboxId, userId });
  if (vis.sql) { conds.push(vis.sql.replace(/^AND /, '')); params.push(...vis.params); }
  if (f.statuses) { conds.push(`ii.status IN (${f.statuses.map(() => '?').join(',')})`); params.push(...f.statuses); }
  if (f.kinds) { conds.push(`ii.kind IN (${f.kinds.map(() => '?').join(',')})`); params.push(...f.kinds); }
  if (f.minRank) { conds.push(`${PRIORITY_ORDER} >= ?`); params.push(f.minRank); }
  if (f.overdue) conds.push(`(${OVERDUE_SQL})`);
  if (f.unread) {
    conds.push(`EXISTS (SELECT 1 FROM inbox_item_assignees iu WHERE iu.inbox_item_id = ii.id AND iu.assignee_type = 'user' AND iu.assignee_id = ? AND iu.is_read = 0)`);
    params.push(userId);
  }
  if (f.source) {
    conds.push(`(json_extract(CASE WHEN json_valid(ii.payload_json) THEN ii.payload_json ELSE '{}' END, '$.source') = ? OR json_extract(CASE WHEN json_valid(ii.payload_json) THEN ii.payload_json ELSE '{}' END, '$.agent_id') = ?)`);
    params.push(f.source, f.source);
  }
  if (f.title !== undefined) { conds.push('ii.title = ?'); params.push(f.title); }
  if (!f.includeSnoozed) {
    conds.push(`NOT EXISTS (SELECT 1 FROM inbox_item_assignees iz WHERE iz.inbox_item_id = ii.id AND iz.assignee_type = 'user' AND iz.assignee_id = ? AND iz.snoozed_until IS NOT NULL AND julianday(iz.snoozed_until) > julianday('now'))`);
    params.push(userId);
  }
  return { sql: conds.join(' AND '), params };
}

function compactRow(row, userId, now) {
  const payload = parseJson(row.payload_json, {});
  const due = row.due_at ? asUtc(row.due_at) : null;
  const created = asUtc(row.created_at);
  const overdue = !!(due && ['open', 'in_progress'].includes(row.status) && Date.parse(due) < now.getTime());
  const out = {
    id: row.id,
    title: row.title,
    kind: row.kind,
    priority: row.priority,
    status: row.status,
    created_at: row.created_at,
    age_minutes: minutesBetween(created, now.toISOString()),
    due_at: row.due_at || null,
    overdue,
    ...(due ? (overdue ? { overdue_by_minutes: minutesBetween(due, now.toISOString()) } : { due_in_minutes: minutesBetween(now.toISOString(), due) }) : {}),
    source: sourceOf(row, payload),
    excerpt: excerptOf(row, payload),
    link: `/inbox/${row.id}`,
    is_read: row.my_is_read === null || row.my_is_read === undefined ? null : !!row.my_is_read,
    assignee_user_id: row.first_assignee || null,
  };
  { const d = decisionBrief(payload); if (d) out.decision = d; } // DECISION-LABELS
  if (userId && row.my_snoozed_until) out.snoozed_until = row.my_snoozed_until;
  // The item's own staged SLA (escalation_stages, fired by jobs/sla-escalation.js): the next stage still to fire.
  if (row.stage_count) {
    out.sla_stages = row.stage_count;
    if (row.next_stage) {
      const [at, action, num] = String(row.next_stage).split('|');
      out.next_escalation = { stage: Number(num), action, scheduled_at: at || null };
    }
  }
  return out;
}

/**
 * The triage queue as `userId` sees it. -> { items, total, sort, filter, sla_note }.
 */
export function queryInboxQueue({ orgId, userId, isOrgAdmin = false, personalInboxId = null, filters, now = new Date() }) {
  if (!orgId || !userId) throw new Error('queryInboxQueue: orgId and userId required');
  const f = filters || parseQueueFilters({}).filters;
  const w = whereFor({ orgId, userId, isOrgAdmin, personalInboxId, f });
  const total = prepare(`SELECT COUNT(*) AS n FROM inbox_items ii WHERE ${w.sql}`).get(...w.params)?.n ?? 0;
  const rows = prepare(`
    SELECT ii.*,
      (SELECT iia.is_read FROM inbox_item_assignees iia WHERE iia.inbox_item_id = ii.id AND iia.assignee_type = 'user' AND iia.assignee_id = ? LIMIT 1) AS my_is_read,
      (SELECT iia.snoozed_until FROM inbox_item_assignees iia WHERE iia.inbox_item_id = ii.id AND iia.assignee_type = 'user' AND iia.assignee_id = ? LIMIT 1) AS my_snoozed_until,
      (SELECT iia.assignee_id FROM inbox_item_assignees iia WHERE iia.inbox_item_id = ii.id AND iia.assignee_type = 'user' ORDER BY iia.rowid LIMIT 1) AS first_assignee,
      (SELECT es.scheduled_at || '|' || es.action || '|' || es.stage_num FROM escalation_stages es WHERE es.inbox_item_id = ii.id AND es.triggered_at IS NULL ORDER BY es.stage_num LIMIT 1) AS next_stage,
      (SELECT COUNT(*) FROM escalation_stages es2 WHERE es2.inbox_item_id = ii.id) AS stage_count
    FROM inbox_items ii
    WHERE ${w.sql}
    ORDER BY ${ORDER_BY[f.sort] || ORDER_BY.priority}
    LIMIT ? OFFSET ?
  `).all(userId, userId, ...w.params, f.limit, f.offset);
  const items = rows.map((r) => compactRow(r, userId, now));
  return {
    items,
    total,
    truncated: total > f.offset + items.length,
    sort: f.sort,
    filter: {
      status: f.statuses ? f.statuses.join(',') : 'all',
      kind: f.kinds ? f.kinds.join(',') : 'all',
      min_priority: Object.keys(PRIORITY_RANK).find((k) => PRIORITY_RANK[k] === f.minRank) || null,
      overdue: f.overdue, unread: f.unread, source: f.source || null, include_snoozed: f.includeSnoozed,
    },
    sla_note: 'overdue = open or in_progress with a due_at in the past (the same rule as inbox stats). next_escalation is the item\'s own next SLA stage (fired server-side). Items without due_at or stages have no deadline; there is no per-kind SLA policy, so age_minutes is the only clock for them.',
  };
}

/** Whether `userId` may see `row` (same rule as the dashboard item routes). */
function canSee(row, { userId, isOrgAdmin, personalInboxId }) {
  if (!row) return false;
  if (isOrgAdmin) return true;
  if (row.created_by && row.created_by === userId) return true;
  if (row.inbox_id && row.inbox_id === personalInboxId) return true;
  return !!prepare(`SELECT 1 FROM inbox_item_assignees WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ? LIMIT 1`).get(row.id, userId);
}

/** One item's full detail as `userId` sees it, or null (absent or not visible: same answer). */
export function getInboxItemDetail({ orgId, userId, isOrgAdmin = false, personalInboxId = null, itemId, now = new Date() }) {
  const row = prepare('SELECT * FROM inbox_items WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(itemId, orgId);
  if (!canSee(row, { userId, isOrgAdmin, personalInboxId })) return null;
  const mine = prepare(`SELECT is_read, snoozed_until FROM inbox_item_assignees WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ? LIMIT 1`).get(itemId, userId);
  const compact = compactRow({ ...row, my_is_read: mine ? mine.is_read : null, my_snoozed_until: mine?.snoozed_until || null }, userId, now);
  const payload = parseJson(row.payload_json, {});
  let payloadText = JSON.stringify(payload);
  const payloadTruncated = payloadText.length > 4000;
  if (payloadTruncated) payloadText = `${payloadText.slice(0, 4000)}…`;
  const assignees = prepare(`
    SELECT iia.assignee_type, iia.assignee_id, iia.mode, iia.status, u.display_name
    FROM inbox_item_assignees iia LEFT JOIN users u ON iia.assignee_type = 'user' AND u.id = iia.assignee_id
    WHERE iia.inbox_item_id = ?`).all(itemId).map((a) => ({ type: a.assignee_type, id: a.assignee_id, name: a.display_name || null, mode: a.mode, status: a.status }));
  let stages = [];
  try {
    stages = prepare('SELECT stage_num, trigger_after_minutes, action, scheduled_at, triggered_at FROM escalation_stages WHERE inbox_item_id = ? ORDER BY stage_num').all(itemId);
  } catch { /* table absent on very old schemas: no stages */ }
  const body = row.body_md ? String(row.body_md) : '';
  return {
    ...compact,
    body_md: body.length > 8000 ? `${body.slice(0, 8000)}…` : body,
    payload: payloadTruncated ? payloadText : payload,
    payload_truncated: payloadTruncated,
    response: parseJson(row.response_json, null),
    resolved_at: row.resolved_at || null,
    assignees,
    sla_stages: stages,
    decision_kind: DECISION_KINDS.includes(row.kind),
  };
}

/** Group the visible queue by exact title. -> { groups:[{title, count, kinds, top_priority, oldest, newest, sample_ids}], total_groups }. */
export function groupInboxByTitle({ orgId, userId, isOrgAdmin = false, personalInboxId = null, filters, minCount = 2, limit = 25 }) {
  const f = { ...(filters || parseQueueFilters({}).filters) };
  const w = whereFor({ orgId, userId, isOrgAdmin, personalInboxId, f });
  const min = Math.max(1, parseInt(minCount, 10) || 2);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const rows = prepare(`
    SELECT ii.title AS title, COUNT(*) AS count, GROUP_CONCAT(DISTINCT ii.kind) AS kinds,
      MAX(${PRIORITY_ORDER}) AS top_rank, MIN(ii.created_at) AS oldest, MAX(ii.created_at) AS newest
    FROM inbox_items ii WHERE ${w.sql}
    GROUP BY ii.title HAVING COUNT(*) >= ?
    ORDER BY COUNT(*) DESC, MAX(ii.created_at) DESC
  `).all(...w.params, min);
  const rankName = (r) => Object.keys(PRIORITY_RANK).find((k) => PRIORITY_RANK[k] === r) || null;
  const groups = rows.slice(0, lim).map((g) => {
    const ids = prepare(`SELECT ii.id FROM inbox_items ii WHERE ${w.sql} AND ii.title = ? ORDER BY ii.created_at DESC LIMIT 5`).all(...w.params, g.title).map((r) => r.id);
    return { title: g.title, count: g.count, kinds: String(g.kinds || '').split(',').filter(Boolean), top_priority: rankName(g.top_rank), oldest: g.oldest, newest: g.newest, sample_ids: ids };
  });
  return { groups, total_groups: rows.length, items_in_groups: rows.reduce((s, g) => s + g.count, 0), min_count: min };
}

// ---------------------------------------------------------------------------
// Housekeeping writes (non-decision items only)
// ---------------------------------------------------------------------------

export class HousekeepingError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function loadForHousekeeping({ orgId, itemId, userId, isOrgAdmin, personalInboxId }) {
  const row = prepare('SELECT * FROM inbox_items WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(itemId, orgId);
  if (!canSee(row, { userId, isOrgAdmin, personalInboxId })) throw new HousekeepingError(404, 'not_found', 'Inbox item not found');
  if (!HOUSEKEEPING_KINDS.includes(row.kind)) {
    throw new HousekeepingError(403, 'decision_item', `This is a ${row.kind} item: housekeeping never applies to approvals, overrides or questions. A human answers those from the inbox.`);
  }
  return row;
}

/** Resolve (done) or dismiss (cancelled, noise) one non-decision item. */
export function closeItem({ orgId, itemId, userId, isOrgAdmin, personalInboxId, mode = 'dismiss', reason = '', actor = {} }) {
  if (!['dismiss', 'resolve'].includes(mode)) throw new HousekeepingError(400, 'bad_mode', 'mode must be dismiss or resolve');
  const row = loadForHousekeeping({ orgId, itemId, userId, isOrgAdmin, personalInboxId });
  if (!ACTIVE.includes(row.status)) return { changed: false, status: row.status, note: `already ${row.status}` };
  const status = mode === 'resolve' ? 'resolved' : 'cancelled';
  const response = { action: mode === 'resolve' ? 'resolved' : 'dismissed', comment: String(reason || '').slice(0, 500), responded_by: actor.id ? `${actor.type || 'agent'}:${actor.id}` : `user:${userId}`, on_behalf_of: userId, responded_at: new Date().toISOString(), housekeeping: true };
  prepare(`UPDATE inbox_items SET status = ?, response_json = ?, resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND org_id = ? AND kind IN ('info','incident','task')`)
    .run(status, JSON.stringify(response), itemId, orgId);
  return { changed: true, status, previous_status: row.status, kind: row.kind, title: row.title };
}

/** Snooze one non-decision item for `userId` until `until` (ISO, future). null clears. */
export function snoozeItem({ orgId, itemId, userId, isOrgAdmin, personalInboxId, until }) {
  loadForHousekeeping({ orgId, itemId, userId, isOrgAdmin, personalInboxId });
  let value = null;
  if (until !== null && until !== undefined && until !== '') {
    const d = new Date(until);
    if (Number.isNaN(d.getTime())) throw new HousekeepingError(400, 'bad_until', 'until must be an ISO 8601 date-time');
    if (d <= new Date()) throw new HousekeepingError(400, 'bad_until', 'until must be in the future');
    if (d.getTime() - Date.now() > 90 * 86400000) throw new HousekeepingError(400, 'bad_until', 'until must be within 90 days');
    value = d.toISOString();
  }
  const r = prepare(`UPDATE inbox_item_assignees SET snoozed_until = ? WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?`).run(value, itemId, userId);
  if (r.changes === 0) {
    // An admin seeing an item through org-wide visibility has no assignee row: give them one
    // (mode anyone, the same row the internal filer writes) so the snooze is theirs alone.
    prepare(`INSERT INTO inbox_item_assignees (id, inbox_item_id, assignee_type, assignee_id, mode, snoozed_until) VALUES (?, ?, 'user', ?, 'anyone', ?)`).run(ulid(), itemId, userId, value);
  }
  return { changed: true, snoozed_until: value };
}

/** Add an org member as an assignee of one non-decision item (additive: nobody is removed). */
export function assignItem({ orgId, itemId, userId, isOrgAdmin, personalInboxId, assigneeUserId }) {
  const row = loadForHousekeeping({ orgId, itemId, userId, isOrgAdmin, personalInboxId });
  if (!ACTIVE.includes(row.status)) throw new HousekeepingError(400, 'closed', `Cannot assign a ${row.status} item`);
  if (!assigneeUserId || !activeMembership(orgId, assigneeUserId)) throw new HousekeepingError(400, 'bad_assignee', 'assignee must be an active member of this organization');
  const exists = prepare(`SELECT 1 FROM inbox_item_assignees WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?`).get(itemId, assigneeUserId);
  if (exists) return { changed: false, note: 'already assigned' };
  prepare(`INSERT INTO inbox_item_assignees (id, inbox_item_id, assignee_type, assignee_id, mode) VALUES (?, ?, 'user', ?, 'anyone')`).run(ulid(), itemId, assigneeUserId);
  return { changed: true, assignee_user_id: assigneeUserId };
}

/**
 * Dismiss many INFO items at once (by ids, or every visible open info item with one title).
 * Info only: incidents and tasks are dismissed one at a time, decisions never.
 */
export function bulkDismissInfo({ orgId, userId, isOrgAdmin, personalInboxId, itemIds, title, reason = '', actor = {} }) {
  let ids = Array.isArray(itemIds) ? [...new Set(itemIds.map(String))] : [];
  if (!ids.length && typeof title === 'string' && title) {
    const f = parseQueueFilters({ status: 'active', kind: 'info', include_snoozed: true }).filters;
    f.title = title;
    const w = whereFor({ orgId, userId, isOrgAdmin, personalInboxId, f });
    ids = prepare(`SELECT ii.id FROM inbox_items ii WHERE ${w.sql} LIMIT ?`).all(...w.params, BULK_DISMISS_MAX + 1).map((r) => r.id);
  }
  if (!ids.length) throw new HousekeepingError(400, 'nothing_selected', 'Give item_ids or a title that matches open info items');
  if (ids.length > BULK_DISMISS_MAX) throw new HousekeepingError(400, 'too_many', `At most ${BULK_DISMISS_MAX} items per bulk dismiss`);
  const results = { dismissed: [], skipped: [] };
  transaction(() => {
    for (const id of ids) {
      const row = prepare('SELECT * FROM inbox_items WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(id, orgId);
      if (!canSee(row, { userId, isOrgAdmin, personalInboxId })) { results.skipped.push({ id, reason: 'not_found' }); continue; }
      if (row.kind !== 'info') { results.skipped.push({ id, reason: `kind ${row.kind} is not info` }); continue; }
      if (!ACTIVE.includes(row.status)) { results.skipped.push({ id, reason: `already ${row.status}` }); continue; }
      const response = { action: 'dismissed', comment: String(reason || '').slice(0, 500), responded_by: actor.id ? `${actor.type || 'agent'}:${actor.id}` : `user:${userId}`, on_behalf_of: userId, responded_at: new Date().toISOString(), housekeeping: true, bulk: true };
      prepare(`UPDATE inbox_items SET status = 'cancelled', response_json = ?, resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND org_id = ? AND kind = 'info'`).run(JSON.stringify(response), id, orgId);
      results.dismissed.push(id);
    }
  });
  return { ...results, dismissed_count: results.dismissed.length, skipped_count: results.skipped.length };
}
