/**
 * InboxQProposalPresentation — the proposal-card presentation shared by
 * InboxQView's Proposals panel and the InboxQ agent chat sidebar (chat
 * sidebar UX, design doc INBOXQ_AGENT_DESIGN.md section C).
 *
 * Pulled out of InboxQView.jsx (was inline there) so InboxQProposalCard.jsx
 * (the chat-sidebar wrapper that adds its own resolve + outcome state) can
 * import the exact same headline/scope-line logic instead of re-deriving it,
 * without InboxQView.jsx and the chat sidebar importing from each other
 * (would be circular: InboxQView -> InboxQChatSidebar -> InboxQProposalCard).
 */

/** Whether a proposal carries enough real payload to safely resolve. `file`
 * needs a concrete message set and a destination; `block` needs a real
 * address; `draft` and any unrecognized kind stay unreviewable until the
 * collector documents/validates those payload fields (audit D: never guess
 * recipients, content, or default an unknown count to 1). */
export function isProposalReviewable(p) {
  const pl = p?.payload || {};
  if (p?.kind === 'file') {
    return Array.isArray(pl.messageIds) && pl.messageIds.length > 0 && typeof pl.folder === 'string' && pl.folder.trim().length > 0;
  }
  if (p?.kind === 'block') {
    return typeof pl.fromAddr === 'string' && pl.fromAddr.trim().length > 0;
  }
  return false;
}

/** One proposal, described as a decision with its evidence and effect — never
 * a bare "proposal <id>". The raw id/status live behind a Details disclosure. */
export function ProposalCard({ proposal: p, busy, onResolve }) {
  const pl = p.payload || {};
  const reviewable = isProposalReviewable(p);

  let headline = `${p.kind || 'Unknown'} proposal`;
  let scopeLine = 'This proposal kind is not recognized by this view, so it cannot be safely reviewed.';
  let approveLabel = 'Approve';
  let denyLabel = 'Deny';
  let previewSubject = null;

  if (p.kind === 'file') {
    const n = Array.isArray(pl.messageIds) ? pl.messageIds.length : 0;
    const folder = pl.folder || '(no folder specified)';
    const who = pl.fromName || pl.fromAddr
      ? ` from ${pl.fromName ? `${pl.fromName} (${pl.fromAddr || 'no address'})` : pl.fromAddr}`
      : '';
    headline = `File ${n} message${n === 1 ? '' : 's'}${who} to "${folder}"`;
    scopeLine = n > 0
      ? `Applies to these ${n} message${n === 1 ? '' : 's'} only. Approving moves them now.`
      : 'No messages are attached to this proposal, so it cannot be applied.';
    approveLabel = 'Approve filing';
    denyLabel = 'Keep messages here';
    previewSubject = pl.subject || null;
  } else if (p.kind === 'block') {
    const addr = pl.fromAddr || null;
    headline = addr ? `Block ${pl.fromName ? `${pl.fromName} <${addr}>` : addr}` : 'Block sender';
    scopeLine = addr
      ? 'Screens future mail from this sender into the Screened zone. Decision recorded on approval, nothing else changes automatically.'
      : 'No sender address is attached to this proposal, so it cannot be applied.';
    approveLabel = 'Approve block proposal';
    denyLabel = "Don't block";
  } else if (p.kind === 'draft') {
    headline = pl.subject ? `Draft a reply to "${pl.subject}"` : 'Draft a reply';
    scopeLine = 'Draft recipients and content are not exposed by this proposal yet, so it cannot be safely reviewed here.';
  }

  return (
    <div className="qx-card qx-surface--backed qx-stack qx-stack--tight" data-testid="inboxq-proposal-card">
      <div className="qx-stack qx-stack--tight" style={{ gap: 4 }}>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <span className="qx-chip qx-chip--xs qx-chip--brand">{p.kind}</span>
          <strong style={{ wordBreak: 'break-word' }}>{headline}</strong>
        </div>
        <span className="qx-hint qx-hint--sm">{scopeLine}</span>
        {previewSubject && <span className="qx-hint qx-hint--sm">e.g. "{previewSubject}"</span>}
      </div>

      {!reviewable && (
        <div className="qx-banner qx-banner--warn">Cannot review this proposal: essential details are missing.</div>
      )}

      <div className="qx-row qx-row--apart" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <details className="qx-disclosure">
          <summary className="qx-disclosure__head"><span className="qx-disclosure__chev">▸</span> Details</summary>
          <div className="qx-disclosure__body qx-stack qx-stack--tight">
            <span className="qx-hint qx-hint--sm">Proposal ID: {p.id}</span>
            <span className="qx-hint qx-hint--sm">Status: {p.status}</span>
            {p.createdAt && <span className="qx-hint qx-hint--sm">Created: {p.createdAt}</span>}
          </div>
        </details>
        <div className="qx-row qx-row--tight">
          <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" disabled={busy} onClick={() => onResolve(p.id, 'deny')}>{denyLabel}</button>
          <button type="button" className="qx-btn qx-btn--sm qx-btn--primary" disabled={busy || !reviewable} onClick={() => onResolve(p.id, 'approve')}>{approveLabel}</button>
        </div>
      </div>
    </div>
  );
}

export default ProposalCard;
