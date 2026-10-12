/**
 * Generic approval-callback dispatcher — STREAM WAZ v2, GAP 1 fix
 * (docs/STREAM_WAZ_PLAN_V2.md section 4.1).
 *
 * Any inbox approval item can carry `payload.callback_url` pointing at the
 * collector's internal decide endpoint for that action (e.g. Wazuh's
 * `/api/internal/wazuh/approvals/decide`, `services/collector/server.js`
 * `pushWazuhApproval()`). Until this module existed, nothing ever called
 * that URL — the approval was recorded as "resolved" in the inbox but the
 * deferred action (deploy/remove/active-response) never ran. This is the
 * generic bridge: any future plugin's HITL approval that carries a
 * `callback_url` inherits execution for free, no per-plugin wiring needed.
 *
 * SSRF guard (mandatory): `callback_url` MUST be a relative path starting
 * with `/api/internal/`. Absolute URLs, protocol-relative URLs (`//host/..`),
 * and any other path shape are rejected before any fetch is attempted — the
 * outbound host is always `COLLECTOR_INTERNAL_URL` (server config), never a
 * value that traces back to the stored payload's own string content.
 */

const COLLECTOR_INTERNAL_URL =
    process.env.COLLECTOR_INTERNAL_URL ||
    process.env.COLLECTOR_URL ||
    process.env.QUOX_COLLECTOR_URL ||
    'http://collector:9848';

/**
 * @param {unknown} callbackUrl
 * @returns {boolean} true only for a relative path under /api/internal/
 */
export function isValidInternalCallbackPath(callbackUrl) {
    if (typeof callbackUrl !== 'string' || !callbackUrl) return false;
    if (!callbackUrl.startsWith('/api/internal/')) return false;
    // Defence-in-depth beyond the prefix check above: reject protocol-relative
    // ("//host/path"), any embedded URL scheme ("http:", "javascript:", ...),
    // and backslashes (some URL parsers treat "\" as "/", enabling scheme
    // confusion tricks like "/api/internal/\\evil.com").
    if (callbackUrl.startsWith('//')) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(callbackUrl)) return false;
    if (callbackUrl.includes('\\')) return false;
    if (callbackUrl.includes('\r') || callbackUrl.includes('\n')) return false;
    return true;
}

/**
 * Fire the decide callback for an approval item. Never throws — callers
 * (the inbox respond handler) must not have their own response delayed or
 * failed by a downstream dispatch problem; failures are logged and returned
 * in the result, not raised.
 *
 * @param {object} item - the inbox_items row (must have `id`)
 * @param {string} callbackUrl - item.payload.callback_url, already extracted by the caller
 * @param {'approve'|'deny'} action
 * @param {object} [opts]
 * @param {string} [opts.approver]
 * @param {string} [opts.reason]
 * @param {object} [opts.actionParams] - item.payload.action_params
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export async function dispatchApprovalCallback(item, callbackUrl, action, opts = {}) {
    const { approver, reason, actionParams } = opts;

    if (!isValidInternalCallbackPath(callbackUrl)) {
        console.error(
            `[ApprovalCallback] Rejected callback_url for item ${item?.id}: not a relative /api/internal/ path (${JSON.stringify(callbackUrl)})`
        );
        return { ok: false, error: 'invalid_callback_url' };
    }
    if (action !== 'approve' && action !== 'deny') {
        console.error(`[ApprovalCallback] Rejected item ${item?.id}: action must be "approve" or "deny" (got ${JSON.stringify(action)})`);
        return { ok: false, error: 'invalid_action' };
    }

    const body = {
        inbox_item_id: item.id,
        action,
        approver,
        reason,
        action_params: actionParams,
    };

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`${COLLECTOR_INTERNAL_URL}${callbackUrl}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.INTERNAL_SERVICE_KEY ? { 'x-service-key': process.env.INTERNAL_SERVICE_KEY } : {}),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            console.error(`[ApprovalCallback] Dispatch failed for item ${item.id} (${res.status}): ${text.slice(0, 500)}`);
            return { ok: false, status: res.status, error: text.slice(0, 500) };
        }
        console.log(`[ApprovalCallback] Dispatched item ${item.id} -> ${callbackUrl} (action=${action})`);
        return { ok: true, status: res.status };
    } catch (err) {
        console.error(`[ApprovalCallback] Dispatch error for item ${item.id}:`, err.message);
        return { ok: false, error: err.message };
    }
}
