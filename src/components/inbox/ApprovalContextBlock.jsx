/**
 * ApprovalContextBlock (HITL-CONTEXT, owner 2026-10-07).
 *
 * "Source: Vulcan, Reason: Access hyp-01 to fix xyz, Method: Bastion": the
 * compact labelled block an approver needs to decide, rendered from
 * payload.approval_context. That block is built SERVER-SIDE by the collector
 * at request time and persisted with the inbox item, so it reads the same
 * hours later from any browser. Global qx-* classes only, no per-view CSS.
 */

const BLOCK_PREFIX = '**Approval context**';

export function getApprovalContext(item) {
    const c = item?.payload?.approval_context;
    return c && typeof c === 'object' ? c : null;
}

/**
 * The collector also prepends the same context as markdown to body_md (so the
 * CLI, notifications and older clients see it). When this block renders it,
 * drop that prefix from the description so it is not shown twice.
 */
export function stripContextMarkdown(bodyMd) {
    if (typeof bodyMd !== 'string' || !bodyMd.startsWith(BLOCK_PREFIX)) return bodyMd;
    const end = bodyMd.indexOf('\n---\n');
    return end === -1 ? bodyMd : bodyMd.slice(end + 5).replace(/^\s+/, '');
}

function Row({ label, children }) {
    return (
        <div className="qx-stat-row" data-testid={`approval-context-${label.toLowerCase().replace(/\s+/g, '-')}`}>
            <span>{label}</span>
            <span>{children}</span>
        </div>
    );
}

export default function ApprovalContextBlock({ context }) {
    if (!context) return null;
    const rb = context.requested_by || {};
    const ob = context.on_behalf_of;
    const reason = context.reason || {};
    const method = context.method || {};
    const why = context.why_approval || {};
    const expires = context.expires_at ? new Date(context.expires_at) : null;
    const expired = expires && !Number.isNaN(expires.getTime()) && expires.getTime() < Date.now();

    return (
        <div className="qx-stack" data-testid="approval-context">
            <div className="qx-section-title">Approval context</div>
            <Row label="Source">
                {context.source_label || rb.agent_label}
                {rb.profile ? ` · profile ${rb.profile}` : ''}
            </Row>
            {ob && (
                <Row label="On behalf of">
                    {ob.user_name || ob.user_id || 'unknown user'}
                    {ob.request_excerpt ? `, asked: "${ob.request_excerpt}"` : ''}
                </Row>
            )}
            <Row label="Reason">
                {reason.text || 'none given'}
                {reason.source === 'inferred' && (
                    <> <span className="qx-pill qx-pill--ghost qx-pill--xs" title="Not stated by the caller; taken from the request that led here">inferred</span></>
                )}
            </Row>
            <Row label="Method">
                {method.tool} via {method.transport}{method.target ? ` on ${method.target}` : ''}
            </Row>
            {(method.command || method.args) && (
                <pre className="qx-code-block" data-testid="approval-context-command">{method.command || method.args}</pre>
            )}
            {why.label && <Row label="Why approval">{why.label}</Row>}
            {context.risk && (
                <Row label="Risk"><span className="qx-pill qx-pill--high qx-pill--xs">{context.risk}</span></Row>
            )}
            {expires && !Number.isNaN(expires.getTime()) && (
                <Row label="Expires">
                    {expires.toLocaleString()}
                    {expired && <> <span className="qx-pill qx-pill--danger qx-pill--xs">expired</span></>}
                </Row>
            )}
        </div>
    );
}
