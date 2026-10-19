/**
 * inboxStats: THE one computation of a user's HITL inbox counts.
 *
 * GET /api/orgs/:orgId/inbox/stats (the dashboard, `quox inbox stats`) and the service-key
 * GET /api/internal/orgs/:orgId/inbox/stats?user_id= (the collector's inbox_stats agent tool,
 * QUOXON-PROOF #864) both return this, so the chat answer and the CLI cannot drift.
 *
 * Visibility: owners/admins count the whole org; members count their personal inbox and items
 * assigned to them (unchanged from the original route). by_priority and assigned_to_me are
 * ACTIVE items only (open, in_progress, waiting), under the same visibility.
 */
import { prepare } from '../db/index.js';
import { openApprovals, APPROVAL_OR_DECISION_SQL, expireDueDecisions } from './openApprovals.js';

export function computeInboxStats({ orgId, userId, isOrgAdmin = false, personalInboxId = null }) {
  if (!orgId || !userId) throw new Error('computeInboxStats: orgId and userId required');

  const visibilityClause = isOrgAdmin
    ? { sql: '', params: [] }
    : {
      sql: `AND (
        ii.inbox_id = ?
        OR EXISTS (
          SELECT 1 FROM inbox_item_assignees iia
          WHERE iia.inbox_item_id = ii.id
          AND iia.assignee_type = 'user'
          AND iia.assignee_id = ?
        )
      )`,
      params: [personalInboxId, userId],
    };

  const stats = prepare(`
    SELECT ii.status, COUNT(*) as count
    FROM inbox_items ii
    WHERE ii.org_id = ?
    AND ii.deleted_at IS NULL
    ${visibilityClause.sql}
    GROUP BY ii.status
  `).all(orgId, ...visibilityClause.params);

  const urgent = prepare(`
    SELECT COUNT(*) as count
    FROM inbox_items ii
    WHERE ii.org_id = ?
    AND ii.deleted_at IS NULL
    AND ii.status IN ('open', 'in_progress')
    AND ii.priority = 'urgent'
    ${visibilityClause.sql}
  `).get(orgId, ...visibilityClause.params);

  const overdue = prepare(`
    SELECT COUNT(*) as count
    FROM inbox_items ii
    WHERE ii.org_id = ?
    AND ii.deleted_at IS NULL
    AND ii.status IN ('open', 'in_progress')
    AND ii.due_at IS NOT NULL
    AND julianday(ii.due_at) < julianday('now') -- same rule as lib/inboxQueue.js OVERDUE_SQL (ISO and SQLite forms)
    ${visibilityClause.sql}
  `).get(orgId, ...visibilityClause.params);

  const byStatus = stats.reduce((acc, s) => ({ ...acc, [s.status]: s.count }), {});

  const unread = prepare(`
    SELECT COUNT(*) as count
    FROM inbox_items ii
    JOIN inbox_item_assignees iia ON iia.inbox_item_id = ii.id
    WHERE ii.org_id = ?
    AND ii.deleted_at IS NULL
    AND ii.status IN ('open', 'in_progress', 'waiting')
    AND iia.assignee_type = 'user'
    AND iia.assignee_id = ?
    AND iia.is_read = 0
  `).get(orgId, userId);

  const flagged = prepare(`
    SELECT COUNT(*) as count
    FROM inbox_items ii
    JOIN inbox_item_assignees iia ON iia.inbox_item_id = ii.id
    WHERE ii.org_id = ?
    AND ii.deleted_at IS NULL
    AND iia.assignee_type = 'user'
    AND iia.assignee_id = ?
    AND iia.is_flagged = 1
  `).get(orgId, userId);

  const snoozed = prepare(`
    SELECT COUNT(*) as count
    FROM inbox_items ii
    JOIN inbox_item_assignees iia ON iia.inbox_item_id = ii.id
    WHERE ii.org_id = ?
    AND ii.deleted_at IS NULL
    AND iia.assignee_type = 'user'
    AND iia.assignee_id = ?
    AND iia.snoozed_until IS NOT NULL
    AND iia.snoozed_until > datetime('now')
  `).get(orgId, userId);

  // Approvals THIS user can act on (quox#827: one shared definition).
  const pendingApprovals = { count: openApprovals({ orgId, userId, isOrgAdmin, personalInboxId }).count };

  // Active items grouped by kind (the folder sidebar's server-sourced counts).
  const byKindRows = prepare(`
    SELECT ii.kind, COUNT(*) as count
    FROM inbox_items ii
    WHERE ii.org_id = ?
    AND ii.deleted_at IS NULL
    AND ii.status IN ('open', 'in_progress', 'waiting')
    ${visibilityClause.sql}
    GROUP BY ii.kind
  `).all(orgId, ...visibilityClause.params);
  const byKind = byKindRows.reduce((acc, r) => ({ ...acc, [r.kind]: r.count }), {});

  // #864: active items by priority, same visibility.
  const byPriorityRows = prepare(`
    SELECT ii.priority, COUNT(*) as count
    FROM inbox_items ii
    WHERE ii.org_id = ?
    AND ii.deleted_at IS NULL
    AND ii.status IN ('open', 'in_progress', 'waiting')
    ${visibilityClause.sql}
    GROUP BY ii.priority
  `).all(orgId, ...visibilityClause.params);
  const byPriority = byPriorityRows.reduce((acc, r) => ({ ...acc, [r.priority || 'none']: r.count }), {});

  // #864: active items assigned to this user (any role).
  const assignedToMe = prepare(`
    SELECT COUNT(DISTINCT ii.id) as count
    FROM inbox_items ii
    JOIN inbox_item_assignees iia ON iia.inbox_item_id = ii.id
    WHERE ii.org_id = ?
    AND ii.deleted_at IS NULL
    AND ii.status IN ('open', 'in_progress', 'waiting')
    AND iia.assignee_type = 'user'
    AND iia.assignee_id = ?
  `).get(orgId, userId);

  expireDueDecisions(orgId);
  // ORG-WIDE approvals awaiting a human: a count only, deliberately not visibility-scoped
  // (a non-admin agent identity learns approvals are waiting without seeing them).
  const awaitingHuman = prepare(`
    SELECT COUNT(*) as count
    FROM inbox_items ii
    WHERE ii.org_id = ?
    AND ii.deleted_at IS NULL
    AND ${APPROVAL_OR_DECISION_SQL}
    AND ii.status IN ('open', 'in_progress', 'waiting')
  `).get(orgId);

  return {
    open: byStatus.open || 0,
    in_progress: byStatus.in_progress || 0,
    waiting: byStatus.waiting || 0,
    resolved: byStatus.resolved || 0,
    urgent: urgent?.count || 0,
    overdue: overdue?.count || 0,
    total_active: (byStatus.open || 0) + (byStatus.in_progress || 0) + (byStatus.waiting || 0),
    unread: unread?.count || 0,
    flagged: flagged?.count || 0,
    snoozed: snoozed?.count || 0,
    pending_approvals: pendingApprovals?.count || 0,
    awaiting_human: awaitingHuman?.count || 0,
    by_kind: byKind,
    by_priority: byPriority,
    assigned_to_me: assignedToMe?.count || 0,
    scope: isOrgAdmin ? 'org' : 'mine',
  };
}
