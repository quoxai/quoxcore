/**
 * InboxQProposalCard — the chat-sidebar addon that turns an
 * inbox_propose_* tool call into an in-place approve/deny card (design doc
 * INBOXQ_AGENT_DESIGN.md section C, "Rendering tool activity and proposal
 * cards inline").
 *
 * Wraps the SAME `ProposalCard` presentation InboxQView's Proposals panel
 * uses (InboxQProposalPresentation.jsx) while it is still `proposed`, so the
 * chat card and the Proposals panel never drift into two different looks for
 * one record. Once resolved it swaps to a plain outcome line, because
 * ProposalCard itself has no "applied/denied/failed" rendering (resolved
 * proposals simply drop out of the Proposals panel's list on next fetch) —
 * the chat transcript is what keeps a permanent trace of the decision, so it
 * needs to say what happened rather than disappear.
 *
 * HONESTY (hard requirement, not cosmetic): the tool result string the agent
 * sees is literally "PROPOSAL CREATED ... NOT EXECUTED" (inboxqTools.js), so
 * this card starts in the `proposed` state and NEVER says moved/blocked/
 * created until it has read a real resolve response back — approving here
 * calls the same `api.resolveProposal` the Proposals panel uses and renders
 * exactly what that response says (`executed` + counts), never an assumption.
 */
import { useState, useCallback } from 'react';
import { api } from './lib/api.js';
import { ProposalCard } from './InboxQProposalPresentation.jsx';

export function InboxQProposalCard({ proposal, onResolved }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null); // { decision, executed, moved, error } | null

  const handleResolve = useCallback(async (proposalId, decision) => {
    setBusy(true);
    try {
      const data = await api.resolveProposal(proposalId, decision);
      if (decision === 'deny') {
        setOutcome({ decision: 'deny' });
      } else if (data?.executed) {
        const n = Array.isArray(data.moved) ? data.moved.length : (typeof data.moved === 'number' ? data.moved : null);
        setOutcome({ decision: 'approve', executed: true, count: n });
      } else if (data?.status === 'failed') {
        setOutcome({ decision: 'approve', executed: false, failed: true, error: data.error || 'Execution failed.' });
      } else {
        // Approved but decision-only (e.g. block/draft kinds not yet wired to
        // execute-on-approve) — recorded, not applied. Never say "done".
        setOutcome({ decision: 'approve', executed: false });
      }
      onResolved?.();
    } catch (err) {
      setOutcome({ decision, executed: false, failed: true, error: err?.body?.error || err.message || 'Could not record this decision.' });
    } finally {
      setBusy(false);
    }
  }, [onResolved]);

  if (!outcome) {
    return (
      <div className="qx-stack qx-stack--tight" style={{ marginTop: 8 }}>
        <ProposalCard proposal={proposal} busy={busy} onResolve={handleResolve} />
      </div>
    );
  }

  if (outcome.decision === 'deny') {
    return <div className="qx-banner qx-banner--info" style={{ marginTop: 8 }}>Denied by you. Nothing changed.</div>;
  }

  if (outcome.failed) {
    return (
      <div className="qx-banner qx-banner--error" style={{ marginTop: 8 }}>
        Failed: {outcome.error} — nothing partially claimed.
      </div>
    );
  }

  if (outcome.executed) {
    return (
      <div className="qx-banner qx-banner--success" style={{ marginTop: 8 }}>
        Applied{outcome.count != null ? ` · moved ${outcome.count} message${outcome.count === 1 ? '' : 's'}` : ''}.
      </div>
    );
  }

  return (
    <div className="qx-banner qx-banner--info" style={{ marginTop: 8 }}>
      Approved. Decision recorded; nothing was moved or sent automatically.
    </div>
  );
}

export default InboxQProposalCard;
