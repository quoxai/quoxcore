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
    // #889: the specialist's per-call outcomes, so the parent turn can report what actually ran.
    tool_outcomes: Array.isArray(body.tool_outcomes) ? body.tool_outcomes : undefined,
    tokensUsed: body.tokensUsed || body.tokens_used || undefined,
    needs_approval: body.needs_approval || null,
  };
  // quox#1167: L7 is the LLM dispatch itself. A 403 from it means the specialist's run failed while
  // executing (CLI timeout or crash, provider error), NOT that policy refused it. Its tool calls are not
  // in this body, so tools_used is unknown, never "0".
  if (!ok && body.deniedByLayer === 'L7') {
    const reason = body.message && !/^Blocked at L7$/i.test(body.message) ? body.message : 'no reason given';
    out.error_code = 'specialist_exec_failed';
    out.error = `the specialist's run did not finish (an execution failure, not a policy decision): ${reason}`;
    out.response = out.error;
    out.tools_used = undefined;
    out.tools_ran = 'unknown';
    return out;
  }
  if (!ok) {
    const detail = body.error || body.message
      || (!httpOk ? `HTTP ${resp && resp.status != null ? resp.status : 'error'}` : 'specialist reported failure');
    out.error = String(detail);
  }
  return out;
}

module.exports = { normalizeDelegateResponse };
