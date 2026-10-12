/**
 * HITL-CONTEXT (owner 2026-10-07): render an approval item's
 * payload.approval_context (built server-side by the collector at request
 * time) for `quox inbox list` / `quox inbox show`. Pure, so it is testable.
 */

function clip(text, n) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function getApprovalContext(item) {
  const c = item && item.payload && item.payload.approval_context;
  return c && typeof c === 'object' ? c : null;
}

/** Ordered [label, value] pairs: Source, On behalf of, Reason, Method, Command, Why approval, Risk, Expires. */
export function approvalContextFields(c) {
  if (!c) return [];
  const rows = [];
  const rb = c.requested_by || {};
  let source = c.source_label || rb.agent_label || 'unknown';
  if (rb.profile) source += ` · profile ${rb.profile}`;
  rows.push(['Source', source]);
  if (c.on_behalf_of) {
    const ob = c.on_behalf_of;
    let v = ob.user_name || ob.user_id || 'unknown user';
    if (ob.request_excerpt) v += `, asked: "${ob.request_excerpt}"`;
    if (ob.conversation_id) v += ` (conversation ${ob.conversation_id})`;
    rows.push(['On behalf of', v]);
  }
  const r = c.reason || {};
  rows.push(['Reason', r.text ? `${r.text}${r.source === 'inferred' ? ' (inferred, not stated by the caller)' : ''}` : 'none given']);
  const m = c.method || {};
  rows.push(['Method', `${m.tool || '?'} via ${m.transport || '?'}${m.target ? ` on ${m.target}` : ''}`]);
  if (m.command) rows.push(['Command', m.command]);
  else if (m.args) rows.push(['Args', m.args]);
  if (c.why_approval && c.why_approval.label) rows.push(['Why approval', c.why_approval.label]);
  if (c.risk) rows.push(['Risk', c.risk]);
  if (c.expires_at) rows.push(['Expires', c.expires_at]);
  return rows;
}

/** Plain-text block for `quox inbox show`. */
export function formatApprovalContext(c) {
  const rows = approvalContextFields(c);
  if (rows.length === 0) return '';
  const w = Math.max(...rows.map(([k]) => k.length));
  return ['Approval context', ...rows.map(([k, v]) => `  ${k.padEnd(w)}  ${v}`)].join('\n');
}

/** Short columns for `quox inbox list`. */
export function approvalListColumns(item) {
  const c = getApprovalContext(item);
  if (!c) return { source: '', reason: '' };
  const r = c.reason || {};
  return {
    source: clip(c.source_label || '', 40),
    reason: r.text ? clip(`${r.text}${r.source === 'inferred' ? ' (inferred)' : ''}`, 60) : '',
  };
}
