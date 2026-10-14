'use strict';

/**
 * Map a nested /chat/claude reply onto the delegate_to_agent result.
 *
 * QUOXON-REVIEW (finding 066b547ddc46): the nested chat error bodies
 * ({ error: 'internal_error' } on a 500) carry no `success` field, and the old
 * mapping copied `result.success` straight through. That gave
 * { success: undefined, response: 'internal_error' }, which every classifier
 * reads as ok, so the terminal showed a green "tools_used: 0" for a failed
 * delegation. A delegation succeeds only on a 2xx with no error and no
 * explicit success:false; anything else carries a top-level `error`.
 */
function normalizeDelegateResponse(resp, result) {
  const body = result && typeof result === 'object' ? result : {};
  const httpOk = !!(resp && resp.ok);
  const ok = httpOk && !body.error && body.success !== false;
  const out = {
    success: ok,
    response: body.result || body.error || 'No response',
    tools_used: body.tools_used || [],
    tokensUsed: body.tokensUsed || body.tokens_used || undefined,
    needs_approval: body.needs_approval || null,
  };
  if (!ok) {
    const detail = body.error || body.message
      || (!httpOk ? `HTTP ${resp && resp.status != null ? resp.status : 'error'}` : 'specialist reported failure');
    out.error = String(detail);
  }
  return out;
}

module.exports = { normalizeDelegateResponse };
