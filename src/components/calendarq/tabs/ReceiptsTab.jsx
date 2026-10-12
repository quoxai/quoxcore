/**
 * ReceiptsTab — real receipts list (L2-C2), honest empty state kept.
 *
 * Reads GET /api/v1/calendarq/receipts via calendarQService.listReceipts.
 * Every row's state pill reflects the operation's CURRENT state (not just
 * the receipt's own kind) — 'outcome_unknown' is highlighted distinctly,
 * never shown as if it were a normal in-progress state, since it means the
 * create request was dispatched but its result was lost and needs
 * calendar_reconcile, not a retry.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { listReceipts } from '../../../services/calendarQService';

const STATE_PILL = {
  confirmed: 'qx-pill--online',
  proposed: 'qx-pill--ghost',
  awaiting_approval: 'qx-pill--ghost',
  attempted: 'qx-pill--ghost',
  outcome_unknown: 'qx-pill--warn',
  partial: 'qx-pill--warn',
  failed: 'qx-pill--offline',
};

function formatWhen(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function effectSummary(receipt) {
  const body = receipt.body || {};
  if (body.effect && body.effect.title) return body.effect.title;
  if (body.providerEventId) return `Event ${body.providerEventId}`;
  if (body.reason) return body.reason;
  return receipt.kind === 'reconcile' ? 'Reconcile check' : 'Create event';
}

export default function ReceiptsTab() {
  const { authFetch } = useAuth();
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listReceipts(authFetch)
      .then((res) => setReceipts(res?.receipts || []))
      .catch((e) => setError(e.message || 'Could not load Calendar-Q receipts.'))
      .finally(() => setLoading(false));
  }, [authFetch]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="qx-card qx-card--compact qx-stack qx-stack--tight" data-testid="calendarq-receipts-loading">
        <div className="qx-skeleton" style={{ height: 32 }} />
        <div className="qx-skeleton" style={{ height: 160 }} />
      </div>
    );
  }

  if (error) {
    return <div className="qx-banner qx-banner--error" data-testid="calendarq-receipts-error">{error}</div>;
  }

  if (receipts.length === 0) {
    return (
      <div className="qx-card qx-card--compact qx-empty" data-testid="calendarq-receipts-empty">
        <div className="qx-empty__title">No receipts yet</div>
        <div className="qx-empty__body">
          Receipts appear when an approved calendar_event_create call runs. Propose an event, approve it from the Approvals inbox, and its receipt will show up here.
        </div>
      </div>
    );
  }

  return (
    // Own card now that the main pane is a transparent column (NotesQ look).
    <div className="qx-card qx-card--compact qx-stack qx-stack--tight" data-testid="calendarq-receipts-tab">
      <table className="qx-table" data-testid="calendarq-receipts-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Effect</th>
            <th>State</th>
            <th>Provider</th>
          </tr>
        </thead>
        <tbody>
          {receipts.map((r) => (
            <tr key={r.id}>
              <td>{formatWhen(r.createdAt)}</td>
              <td>{effectSummary(r)}</td>
              <td>
                <span className={`qx-pill qx-pill--xs ${STATE_PILL[r.operationState] || 'qx-pill--ghost'}`}>
                  {r.operationState === 'outcome_unknown' ? 'outcome unknown — needs reconcile' : (r.operationState || r.body?.outcome || 'unknown')}
                </span>
              </td>
              <td>
                {r.body && r.body.htmlLink ? (
                  <a className="qx-btn qx-btn--sm qx-btn--ghost" href={r.body.htmlLink} target="_blank" rel="noreferrer">Open</a>
                ) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
