/**
 * quox#562 — the ONE way the collector mints an org inbox item.
 *
 * Every scheduled job and gate used to hand-roll the same
 * fetch(AUTH_SERVICE_URL + '/api/internal/orgs/:orgId/inbox') with subtly
 * different header casing, timeout, error handling and response-id
 * extraction (the auth route returns { item: { id } } on 201 but
 * { deduplicated: true, existing_item_id } on the dedup 200, and call sites
 * guessed different unions of those). This helper owns the shape once.
 *
 * Never throws: returns { ok, status, itemId, deduplicated, error, data }.
 * Callers keep their own logging and their own decision about how loud a
 * mint failure is; this only owns the mechanics.
 */

'use strict';

const { checkWhat } = require('./approvalWhat.js');

const DEFAULT_TIMEOUT_MS = 10000;

function extractItemId(data) {
  if (!data || typeof data !== 'object') return null;
  return (data.item && data.item.id) || data.existing_item_id || data.id || data.item_id || null;
}

/**
 * @param {object} fields { orgId, title, bodyMd, kind, priority, payload?, aeeCorrelationId?, assigneeUserId? }
 * @param {object} deps   { authBaseUrl?, serviceKey?, fetchImpl?, timeoutMs? }
 */
async function mintInboxItem(fields, deps = {}) {
  const { orgId, title, bodyMd, kind = 'info', priority = 'normal', payload, aeeCorrelationId, assigneeUserId } = fields || {};
  const authBaseUrl = deps.authBaseUrl
    || process.env.AUTH_SERVICE_URL
    || `http://${process.env.AUTH_HOST || 'quox-auth'}:${process.env.AUTH_PORT || '3101'}`;
  const serviceKey = deps.serviceKey !== undefined ? deps.serviceKey : process.env.INTERNAL_SERVICE_KEY;
  const fetchImpl = deps.fetchImpl || fetch;
  const timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!orgId) return { ok: false, status: 0, itemId: null, deduplicated: false, error: 'orgId is required' };
  // APPROVAL-WHAT: an approval nobody can identify is refused here, before the network call.
  if (kind === 'approval') {
    const w = checkWhat(payload && payload.what);
    if (!w.ok) return { ok: false, status: 0, itemId: null, deduplicated: false, error: `approval_undescribed: ${w.error}` };
  }
  if (!serviceKey) {
    return { ok: false, status: 0, itemId: null, deduplicated: false, error: 'INTERNAL_SERVICE_KEY not configured' };
  }

  try {
    const res = await fetchImpl(`${authBaseUrl}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
      body: JSON.stringify({
        title,
        body_md: bodyMd,
        kind,
        priority,
        ...(payload !== undefined ? { payload } : {}),
        ...(aeeCorrelationId ? { aee_correlation_id: aeeCorrelationId } : {}),
        ...(assigneeUserId ? { assignee_user_id: assigneeUserId } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (data && (data.error || data.message)) || '';
      return {
        ok: false, status: res.status, itemId: null, deduplicated: false,
        error: `inbox mint failed: auth ${res.status}${detail ? ` (${String(detail).slice(0, 200)})` : ''}`,
        data,
      };
    }
    return { ok: true, status: res.status, itemId: extractItemId(data), deduplicated: !!data.deduplicated, error: null, data };
  } catch (err) {
    return { ok: false, status: 0, itemId: null, deduplicated: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = { mintInboxItem, extractItemId, DEFAULT_TIMEOUT_MS };
