/**
 * openApprovals: THE one definition of "the approvals a user can act on right now".
 *
 * Every surface that shows approvals (the dashboard header badge and inbox stats, the CLI
 * and its TUI /approvals, LUCID's approvals area) derives its SET and COUNT from here, so
 * they cannot drift. Every approval source (tool-held HITL, plugin cards, workflow
 * approvals, agent-asks-human) lands as an inbox_items row of kind 'approval', so that
 * table is the single place to ask. "Open" = every ACTIVE status (open, in_progress, waiting),
 * snoozed included (a snooze hides a card from the list, it does not resolve it).
 *
 * Failures are named, never dropped: a row whose payload cannot be parsed is still counted
 * (source 'unclassified') and reported in failed_sources.
 */
import { prepare } from '../db/index.js';

export const ACTIVE_STATUSES = ['open', 'in_progress', 'waiting'];

/**
 * A decision request (quox ask) is an inbox item of kind 'question' whose payload says type 'decision'
 * (the inbox_items kind CHECK cannot take a new value without a table rebuild). It is a HITL request a
 * human must answer, so it is counted and listed with approvals and can never be hidden from them
 * (quox#1052). One SQL fragment so the list, stats and the org-wide count cannot drift.
 */
export const APPROVAL_OR_DECISION_SQL = `(ii.kind = 'approval' OR (ii.kind = 'question' AND ii.payload_json LIKE '%"type":"decision"%'))`;

export function isDecisionRow(row) {
  if (!row || row.kind !== 'question') return false;
  try { return JSON.parse(row.payload_json || '{}').type === 'decision'; } catch { return false; }
}

/** Mark every active decision whose expiry has passed as expired (lazy: runs before any read of the set). */
export function expireDueDecisions(orgId, prepareFn = prepare) {
  const st = prepareFn(`
    UPDATE inbox_items SET status = 'expired', updated_at = datetime('now'),
      response_json = COALESCE(response_json, '{"outcome":"expired"}')
    WHERE org_id = ? AND kind = 'question' AND payload_json LIKE '%"type":"decision"%'
    AND status IN ('open', 'in_progress', 'waiting') AND due_at IS NOT NULL AND due_at < ?
  `);
  return typeof st?.run === 'function' ? st.run(orgId, new Date().toISOString()).changes : 0; // a read-only prepareFn (tests) cannot write
}

/** Row visibility: owners/admins see every org item; members see their own inbox, items assigned to or filed by them. */
export function visibilityClause({ isOrgAdmin, personalInboxId, userId }) {
  if (isOrgAdmin) return { sql: '', params: [] };
  return {
    sql: `AND (
      ii.inbox_id = ?
      OR ii.created_by = ?
      OR EXISTS (
        SELECT 1 FROM inbox_item_assignees iia
        WHERE iia.inbox_item_id = ii.id
        AND iia.assignee_type = 'user'
        AND iia.assignee_id = ?
      )
    )`,
    params: [personalInboxId, userId, userId],
  };
}

/** Which approval source filed this card. */
export function approvalSource(row, payload) {
  const p = payload || {};
  if (p.type === 'decision') return 'decision';
  if (p.type === 'native_tool_approval' || p.approval_id) return 'tool';
  if (row.run_id) return 'workflow';
  if (p.source && typeof p.source === 'string') return p.source;
  if (p.plugin) return String(p.plugin);
  return 'agent';
}

export function isPrivilegedPayload(payload) {
  const p = payload || {};
  return p.privileged === true || (p.approval_context && p.approval_context.privileged === true) || false;
}

/**
 * @param {{orgId:string, userId?:string, isOrgAdmin?:boolean, personalInboxId?:string, prepareFn?:Function}} args
 * @returns {{approvals:Array, count:number, failed_sources:Array}}
 */
export function openApprovals({ orgId, userId = null, isOrgAdmin = false, personalInboxId = null, prepareFn = prepare }) {
  if (!orgId) throw new Error('openApprovals: orgId required');
  const vis = visibilityClause({ isOrgAdmin, personalInboxId, userId });
  expireDueDecisions(orgId, prepareFn);
  const rows = prepareFn(`
    SELECT ii.*, ib.name AS inbox_name, ib.inbox_type
    FROM inbox_items ii
    LEFT JOIN inboxes ib ON ii.inbox_id = ib.id
    WHERE ii.org_id = ? AND ii.deleted_at IS NULL AND ${APPROVAL_OR_DECISION_SQL}
    AND ii.status IN ('open', 'in_progress', 'waiting')
    ${vis.sql}
    ORDER BY ii.created_at DESC
  `).all(orgId, ...vis.params);

  const failed = [];
  const approvals = rows.map((row) => {
    let payload = {};
    let source;
    try { payload = row.payload_json ? JSON.parse(row.payload_json) : {}; source = approvalSource(row, payload); }
    catch (e) { source = 'unclassified'; failed.push({ source: 'payload', id: row.id, error: e && e.message ? e.message : String(e) }); }
    return {
      id: row.id,
      source,
      title: row.title,
      privileged: isPrivilegedPayload(payload),
      ...(payload.conversation_id || payload.conversationId ? { conversationId: payload.conversation_id || payload.conversationId } : {}),
      createdAt: row.created_at,
      status: row.status,
      approvalId: payload.approval_id || null,
      item: { ...row, payload },
    };
  });
  return { approvals, count: approvals.length, failed_sources: failed };
}
