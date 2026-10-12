/**
 * XScheduledPanel, posts that are approved and waiting to publish.
 * X-PLUGIN phase 12.
 *
 * Owner decision 2026-09-12: "approve then schedule! trigger time is not
 * delayed". Everything listed here is ALREADY APPROVED. It will publish at its
 * own time with no further tap, which is exactly why this surface has to
 * exist: a queue of committed publishes that nobody can see or stop would be
 * the worst possible shape for this feature.
 *
 * Cancel is therefore the point of the panel, not a nicety. It is available
 * while a row is pending, and honestly refused once a row is firing or
 * published, because at that point the post may already exist on X and
 * "cancelled" would imply nothing happened.
 */

import { useState } from 'react'

const STATUS_PILL = {
  pending: 'qx-pill--medium',
  firing: 'qx-pill--medium',
  published: 'qx-pill--success',
  failed: 'qx-pill--danger',
  cancelled: 'qx-pill--ghost',
  needs_review: 'qx-pill--danger',
}

/** Said plainly, because each of these means something different to a human
 * deciding whether to act. */
const STATUS_MEANING = {
  pending: 'Approved, waiting for its time. Will publish without another tap.',
  firing: 'Publishing right now. Too late to cancel.',
  published: 'Published to X.',
  failed: 'Gave up after repeated failures. NOTHING was posted, and the budget slot was released.',
  cancelled: 'Cancelled before it fired. Nothing was posted.',
  needs_review: 'The collector stopped mid-publish. It is NOT known whether this reached X, and it was deliberately not retried. Check the account.',
}

function fmt(iso) {
  if (!iso) return 'unknown'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function relative(iso) {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!Number.isFinite(ms)) return ''
  const mins = Math.round(Math.abs(ms) / 60000)
  const phrase = mins < 60
    ? `${mins} minute${mins === 1 ? '' : 's'}`
    : mins < 1440
      ? `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? '' : 's'}`
      : `${Math.round(mins / 1440)} day${Math.round(mins / 1440) === 1 ? '' : 's'}`
  return ms >= 0 ? `in about ${phrase}` : `${phrase} ago`
}

export default function XScheduledPanel({ scheduled = [], canCancel = false, loading = false, error = null, onCancel, onRefresh }) {
  const [busy, setBusy] = useState(null)
  const [cancelError, setCancelError] = useState(null)

  const pending = scheduled.filter((s) => s.status === 'pending')

  async function cancel(inboxItemId) {
    setBusy(inboxItemId)
    setCancelError(null)
    try {
      await onCancel(inboxItemId)
      if (onRefresh) await onRefresh()
    } catch (e) {
      // Never swallow it: the row may have started firing, and the user needs
      // to know the post is going out anyway.
      setCancelError(e.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="qx-card">
      <div className="qx-stack">
        <div className="qx-row qx-row--apart qx-row--wrap">
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Scheduled to publish</h3>
          <button type="button" className="qx-btn xs-btn qx-btn--sm" onClick={onRefresh} disabled={loading}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
            Refresh
          </button>
        </div>

        <p className="qx-hint qx-hint--sm">
          These are already approved. Each will publish to X at its own time without another tap.
          A pending one holds a slot in your posting budget, and cancelling it hands that slot back.
        </p>

        {error && <div className="qx-banner qx-banner--error">{error}</div>}
        {cancelError && <div className="qx-banner qx-banner--error">{cancelError}</div>}

        {loading && scheduled.length === 0 ? (
          <div className="qx-skeleton qx-skeleton--block" />
        ) : scheduled.length === 0 ? (
          <div className="qx-empty">
            <div className="qx-empty__title">Nothing scheduled</div>
            <div className="qx-empty__body">
              Approve and schedule a post from the Compose tab and it will appear here until it publishes.
            </div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="qx-table" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Publishes</th>
                  <th>Approved</th>
                  <th>By</th>
                  <th>Action</th>
                  <th>{canCancel ? 'Cancel' : ''}</th>
                </tr>
              </thead>
              <tbody>
                {scheduled.map((s) => (
                  <tr key={s.inbox_item_id}>
                    <td>
                      <span className={`qx-pill qx-pill--sm ${STATUS_PILL[s.status] || 'qx-pill--ghost'}`}>{s.status}</span>
                      <div className="qx-hint qx-hint--sm" style={{ maxWidth: 320 }}>{STATUS_MEANING[s.status] || ''}</div>
                      {s.last_error && <div className="qx-hint qx-hint--sm qx-hint--danger">{s.last_error}</div>}
                    </td>
                    <td>
                      {fmt(s.scheduled_publish_at)}
                      <div className="qx-hint qx-hint--sm">{s.status === 'pending' ? relative(s.scheduled_publish_at) : ''}</div>
                    </td>
                    <td>{fmt(s.approved_at)}</td>
                    <td>{s.approver || 'unknown'}</td>
                    <td><code className="qx-code">{s.action}</code></td>
                    <td>
                      {canCancel && s.status === 'pending' ? (
                        <button
                          type="button"
                          className="qx-btn xs-btn qx-btn--sm"
                          onClick={() => cancel(s.inbox_item_id)}
                          disabled={busy === s.inbox_item_id}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
                          {busy === s.inbox_item_id ? 'Cancelling…' : 'Cancel'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!canCancel && pending.length > 0 && (
          <p className="qx-hint qx-hint--sm">
            Only an org owner or admin can cancel a scheduled post.
          </p>
        )}
      </div>
    </section>
  )
}
