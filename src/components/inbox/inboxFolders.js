/**
 * Inbox Smart Folder Definitions
 *
 * Each folder maps to a combination of filters applied client-side.
 * No new DB tables needed — folders are filter presets.
 */

export const INBOX_FOLDERS = [
    // Main
    { id: 'inbox', label: 'Inbox', group: 'main', icon: 'inbox', filter: { status: ['open', 'in_progress', 'waiting'], archived: false, snoozed: false } },
    { id: 'alerts', label: 'Alerts', group: 'main', icon: 'zap', filter: { kind: 'incident', archived: false } },
    { id: 'mine', label: 'My Active', group: 'main', icon: 'user', filter: { assignee: 'mine', status: ['in_progress'], archived: false } },
    // Types
    { id: 'approvals', label: 'Approvals', group: 'types', icon: 'check', filter: { kind: 'approval', archived: false } },
    { id: 'questions', label: 'Questions', group: 'types', icon: 'help', filter: { kind: 'question', archived: false } },
    { id: 'tasks', label: 'Tasks', group: 'types', icon: 'target', filter: { kind: 'task', archived: false } },
    { id: 'results', label: 'Results', group: 'types', icon: 'info', filter: { kind: 'info', archived: false } },
    // Smart
    { id: 'starred', label: 'Starred', group: 'smart', icon: 'star', filter: { flagged: true, archived: false } },
    { id: 'snoozed', label: 'Snoozed', group: 'smart', icon: 'clock', filter: { snoozed: true, archived: false } },
    { id: 'all', label: 'All Items', group: 'smart', icon: 'layers', filter: { archived: false } },
    { id: 'done', label: 'Done', group: 'smart', icon: 'check', filter: { status: ['resolved', 'cancelled', 'expired'], archived: false } },
    // Archive
    { id: 'archive', label: 'Archive', group: 'archive', icon: 'archive', filter: { archived: true } },
];

export const FOLDER_GROUPS = [
    { id: 'main', label: null },
    { id: 'types', label: 'Types' },
    { id: 'smart', label: 'Smart' },
    { id: 'archive', label: null },
];

/**
 * Apply a folder's filter preset to an item list
 * @param {Array} items - All inbox items (with per-user state)
 * @param {Object} folder - Folder definition from INBOX_FOLDERS
 * @param {string} userId - Current user ID (for "mine" assignee filter)
 * @returns {Array} Filtered items
 */
export function applyFolderFilter(items, folder, userId) {
    if (!folder || !folder.filter) return items;
    const f = folder.filter;

    const now = new Date();

    return items.filter(item => {
        // Status filter (array or single value)
        if (f.status) {
            const statuses = Array.isArray(f.status) ? f.status : [f.status];
            if (!statuses.includes(item.status)) return false;
        }

        // Kind filter
        if (f.kind && item.kind !== f.kind) return false;

        // Flagged filter
        if (f.flagged === true && !item.is_flagged) return false;

        // Archived filter
        if (f.archived === false && item.archived_at) return false;
        if (f.archived === true && !item.archived_at) return false;

        // Snoozed filter
        if (f.snoozed === false) {
            if (item.snoozed_until && new Date(item.snoozed_until) > now) return false;
        }
        if (f.snoozed === true) {
            if (!item.snoozed_until || new Date(item.snoozed_until) <= now) return false;
        }

        // Assignee filter
        if (f.assignee === 'mine' && userId) {
            if (!item.assignees?.some(a => a.assignee_id === userId)) return false;
        }

        return true;
    });
}

/**
 * Compute badge counts for all folders
 */
export function computeFolderCounts(items, userId) {
    const counts = {};
    for (const folder of INBOX_FOLDERS) {
        counts[folder.id] = applyFolderFilter(items, folder, userId).length;
    }
    return counts;
}

/**
 * Server-side query filter per folder (INBOX-HISTORY). Inbox sends no status
 * (server default = active only). Approvals and All Items send status=all so
 * answered items stay visible; Done is the terminal states.
 */
export const FOLDER_SERVER_FILTER = {
    alerts: { kind: 'incident' },
    approvals: { kind: 'approval', status: 'all' },
    questions: { kind: 'question' },
    tasks: { kind: 'task' },
    results: { kind: 'info' },
    all: { status: 'all' },
    done: { status: 'resolved,cancelled,expired' },
};

/** Folders that are history views (get the status chip row + decision pills). */
export const HISTORY_FOLDERS = ['approvals', 'all', 'done'];

/** Status chip row for history folders. Each maps to server status/decision. */
export const HISTORY_CHIPS = [
    { id: 'all', label: 'All', filter: { status: 'all' } },
    { id: 'open', label: 'Open', filter: { status: 'open,in_progress,waiting' } },
    { id: 'approved', label: 'Approved', filter: { status: 'resolved', decision: 'approved' } },
    { id: 'rejected', label: 'Rejected', filter: { status: 'resolved', decision: 'rejected' } },
    { id: 'expired', label: 'Expired', filter: { status: 'expired' } },
];

/** Query-string fragment for a server filter (leading &, or ''). */
export function serverFilterQs(f = {}) {
    return [
        f.kind ? `&kind=${encodeURIComponent(f.kind)}` : '',
        f.status ? `&status=${encodeURIComponent(f.status)}` : '',
        f.decision ? `&decision=${encodeURIComponent(f.decision)}` : '',
    ].join('');
}

const APPROVE = ['approve', 'approved'];
const REJECT = ['reject', 'rejected', 'deny', 'denied'];

/**
 * Decision pill for a row: { label, color, who, when } or null for active items.
 * Reads response (action, responded_by, responded_at) and resolved_at.
 */
export function getDecision(item) {
    if (!item || ['open', 'in_progress', 'waiting'].includes(item.status)) return null;
    const r = item.response || (item.response_json ? safeParse(item.response_json) : null) || {};
    const action = String(r.action || '').toLowerCase();
    let label; let color;
    if (APPROVE.includes(action)) { label = 'Approved'; color = 'green'; }
    else if (REJECT.includes(action)) { label = 'Rejected'; color = 'red'; }
    else if (item.status === 'expired') { label = 'Expired'; color = 'red'; }
    else if (item.status === 'cancelled') { label = 'Cancelled'; color = 'gray'; }
    else { label = 'Resolved'; color = 'green'; }
    return {
        label,
        color,
        who: item.resolved_by_name || r.responded_by_name || r.responded_by || null,
        when: r.responded_at || item.resolved_at || null,
    };
}

function safeParse(v) { try { return JSON.parse(v); } catch { return null; } }

/**
 * Live item_responded merge: the stream event carries action + responded_by (not
 * a status), so record the decision on the item so its pill reads APPROVED /
 * REJECTED instead of a generic Resolved. The item stays in history folders.
 */
export function applyResponded(item, data = {}) {
    const response = {
        ...(item.response || {}),
        ...(data.action ? { action: data.action } : {}),
        ...(data.responded_by ? { responded_by: data.responded_by } : {}),
        responded_at: (item.response && item.response.responded_at) || data.responded_at || new Date().toISOString(),
    };
    return { ...item, status: data.status || 'resolved', response };
}
