/**
 * QuotaPanel — the rolling 24-hour publishing quota (hard cap: 100
 * API-published posts per 24h). IG-3, no Facebook equivalent: Instagram's
 * content_publishing_limit is a real Graph API surface Facebook Pages does
 * not have.
 */

import './instagram.css'

export default function QuotaPanel({ quota }) {
  const used = quota?.quota_usage ?? null
  const total = quota?.quota_total ?? null
  const pct = used != null && total ? Math.min(100, Math.round((used / total) * 100)) : null

  return (
    <div className="ig-panel">
      <div className="ig-panel__header">
        <h3 className="ig-panel__title">{'\u{1F4CA}'} Publishing Quota</h3>
      </div>
      <div className="ig-panel__body">
        {used == null || total == null ? (
          <div className="ig-empty">
            <p>Quota unavailable. This reads content_publishing_limit for the connected account.</p>
          </div>
        ) : (
          <>
            <div className="ig-quota-label">
              <span>{used} / {total} posts used</span>
              <span>{pct}%</span>
            </div>
            <div className="ig-quota-bar">
              <div className="ig-quota-bar__fill" style={{ width: `${pct}%` }} />
            </div>
            <p style={{ marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
              Rolling {quota?.quota_duration ? `${Math.round(quota.quota_duration / 3600)}h` : '24h'} window,
              hard-capped by Meta at 100 API-published posts. A carousel counts as one post
              (carousels are not built in this plugin yet).
            </p>
          </>
        )}
      </div>
    </div>
  )
}
