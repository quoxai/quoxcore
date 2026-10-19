/**
 * CLI-ERRORS (owner 2026-10-17): a respond on a card that is already closed answers
 * "Already approved by <who> at <time>; nothing to do", not a bare status. And a tool
 * approvalId (the card's aee_correlation_id) finds the card whatever its status, so a
 * resolved approval is never reported as "not found".
 */
import { isApproveAction, isDenyAction } from './inboxResponseClassifier.js';

/**
 * Find an org's inbox item by its id, else by the tool approvalId it carries
 * (aee_correlation_id, or payload.approval_id). Org-scoped; any status.
 * @returns {object|undefined} the row (with run_id when `withRun`)
 */
export function findItemByIdOrApprovalId(db, orgId, id, { withRun = false } = {}) {
    const cols = withRun ? 'ii.*, r.id as run_id' : 'ii.*';
    const join = withRun ? 'LEFT JOIN runs r ON ii.run_id = r.id' : '';
    const byId = db.prepare(`SELECT ${cols} FROM inbox_items ii ${join} WHERE ii.id = ? AND ii.org_id = ?`).get(id, orgId);
    if (byId) return byId;
    return db.prepare(`
        SELECT ${cols} FROM inbox_items ii ${join}
        WHERE ii.org_id = ? AND (ii.aee_correlation_id = ? OR json_extract(ii.payload_json, '$.approval_id') = ?)
        ORDER BY ii.created_at DESC LIMIT 1
    `).get(orgId, id, id);
}

/** A y/n decision answered "y" reads as approved, "n" as rejected; another option as answered "<key>". */
function outcomeOf(prior) {
    const opt = prior && typeof prior.option === 'string' ? prior.option : null;
    if (opt === 'y') return 'approved';
    if (opt === 'n') return 'rejected';
    const n = normalise(prior?.action);
    return n === 'answered' && opt ? `answered "${opt}"` : n;
}

/** sqlite "YYYY-MM-DD HH:MM:SS" (UTC) or ISO -> ISO, or null. */
function toIso(ts) {
    if (!ts) return null;
    const s = String(ts);
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO -> "2026-10-17 10:02 UTC" */
export function humanUtc(iso) {
    return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'an unknown time';
}

function normalise(action) {
    const a = String(action || '').trim().toLowerCase();
    if (isApproveAction(a)) return 'approved';
    if (isDenyAction(a)) return 'rejected';
    if (a === 'answer') return 'answered';
    if (a === 'defer') return 'deferred';
    if (a === 'resolve' || a === 'resolved') return 'resolved';
    if (a === 'request_changes') return 'changes requested';
    return a ? 'resolved' : null;
}

/**
 * The structured body for a respond on a closed card. Status stays 400 at the route (pinned
 * by decisions.test.js) and `error` keeps its old string (the dashboard and TUI match it).
 */
export function alreadyResolvedBody(db, item, requestedAction) {
    let prior = null;
    try { prior = item.response_json ? JSON.parse(item.response_json) : null; } catch { prior = null; }
    const outcome = item.status === 'expired' ? 'expired'
        : item.status === 'cancelled' ? 'cancelled'
        : (outcomeOf(prior) || 'resolved');
    let name = prior?.responded_by_name || null;
    if (!name && item.resolved_by) {
        try { name = db.prepare('SELECT COALESCE(display_name, primary_email) AS n FROM users WHERE id = ?').get(item.resolved_by)?.n || null; } catch { name = null; }
    }
    const at = toIso(item.resolved_at) || toIso(prior?.responded_at) || (outcome === 'expired' ? toIso(item.expires_at) || toIso(item.updated_at) : null);
    const requested = String(requestedAction || '').trim().toLowerCase() || null;
    const matches = Boolean(requested) && outcome !== 'expired' && outcome !== 'cancelled' && normalise(requested) === outcome;

    let message;
    if (outcome === 'expired') {
        message = item.kind === 'approval'
            ? `This approval expired at ${humanUtc(at)}; nothing was approved. Ask for it again.`
            : `This item expired at ${humanUtc(at)}; nothing was recorded.`;
    } else if (outcome === 'cancelled') {
        message = `This item was cancelled at ${humanUtc(at)}${name ? ` by ${name}` : ''}; there is nothing to respond to.`;
    } else {
        const head = `Already ${outcome}${name ? ` by ${name}` : ''} at ${humanUtc(at)}`;
        message = matches || !requested ? `${head}; nothing to do.` : `${head}; your ${requested} was not applied.`;
    }
    return {
        error: 'Item is not open for response',
        code: 'already_resolved',
        message,
        resolution: {
            item_id: item.id,
            status: item.status,
            outcome,
            ...(prior?.option ? { option: prior.option } : {}),
            resolved_by: item.resolved_by || null,
            resolved_by_name: name,
            resolved_at: at,
            requested,
            matches,
        },
    };
}

export function notFoundBody(id) {
    return {
        error: 'Inbox item not found',
        code: 'not_found',
        message: `No inbox item or approval with id ${id} in this org, open or resolved.`,
    };
}
