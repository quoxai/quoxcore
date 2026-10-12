/**
 * Inbox list status / decision filter (INBOX-HISTORY).
 *
 * `status` may be: absent (legacy default: active only), a single value, a
 * comma list, or `all` (no status restriction, so answered approvals are
 * visible as history). `decision` narrows resolved items by the recorded
 * response action (approved / rejected).
 */
export const ALL_STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'cancelled', 'expired'];
const ACTIVE = ['open', 'in_progress', 'waiting'];
const DECISIONS = {
    approved: ['approve', 'approved'],
    rejected: ['reject', 'rejected', 'deny', 'denied'],
};

/** Returns { sql, params, explicit } or { error }. sql may be null (no restriction). */
export function buildStatusFilter(status, decision) {
    let sql = null;
    let params = [];
    let explicit = false;
    const raw = typeof status === 'string' ? status.trim() : '';
    if (!raw) {
        sql = `ii.status IN (${ACTIVE.map(() => '?').join(',')})`;
        params = [...ACTIVE];
    } else {
        explicit = true;
        const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (parts.includes('all')) {
            sql = null;
        } else {
            const valid = [...new Set(parts.filter((p) => ALL_STATUSES.includes(p)))];
            if (!valid.length) return { error: `invalid status: ${raw}` };
            sql = `ii.status IN (${valid.map(() => '?').join(',')})`;
            params = valid;
        }
    }
    if (decision) {
        const d = DECISIONS[String(decision).toLowerCase()];
        if (!d) return { error: `invalid decision: ${decision}` };
        explicit = true;
        const clause = `lower(json_extract(ii.response_json, '$.action')) IN (${d.map(() => '?').join(',')})`;
        sql = sql ? `${sql} AND ${clause}` : clause;
        params = [...params, ...d];
    }
    return { sql, params, explicit };
}

export const HISTORY_ORDER = "datetime(COALESCE(ii.resolved_at, ii.created_at)) DESC, ii.id DESC";
