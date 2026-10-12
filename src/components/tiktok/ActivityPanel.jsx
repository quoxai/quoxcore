/**
 * ActivityPanel — the org's governed TikTok write history. TT-4, mirrors
 * src/components/instagram/ActivityPanel.jsx.
 *
 * Reads the REAL approval trail: every drafted publish_video or
 * upload_draft and its human decision. The card trail IS the ledger, no
 * parallel bookkeeping.
 */

import './tiktok.css'

const STATUS_STYLES = {
  awaiting_approval: { label: 'Awaiting approval', color: 'rgba(251, 191, 36, 0.9)' },
  executing: { label: 'Executing', color: 'rgba(96, 165, 250, 0.9)' },
  published: { label: 'Published', color: 'rgba(52, 211, 153, 0.9)' },
  denied: { label: 'Denied', color: 'rgba(148, 163, 184, 0.9)' },
  failed: { label: 'Failed', color: 'rgba(248, 113, 113, 0.9)' },
}

export default function ActivityPanel({ activity = [], onRefresh }) {
  return (
    <div className="tt-panel">
      <div className="tt-panel__header">
        <h3 className="tt-panel__title">{'\u{1F4DC}'} Activity</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
            {activity.length} governed write{activity.length === 1 ? '' : 's'}
          </span>
          {onRefresh && (
            <button className="tt-panel__action" onClick={onRefresh} title="Refresh">&#8635;</button>
          )}
        </div>
      </div>
      <div className="tt-panel__body">
        {activity.length === 0 ? (
          <p style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13, margin: '8px 0' }}>
            No governed writes yet. Every publish or draft upload lands here with its
            approval outcome the moment it is drafted.
          </p>
        ) : (
          <div className="tt-activity-list">
            {activity.map((item) => {
              const s = STATUS_STYLES[item.status] || { label: item.status, color: 'rgba(255,255,255,0.6)' }
              const isDraft = item.kind === 'upload_draft'
              return (
                <div key={item.approval_id} className="tt-activity-row" style={{ padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ color: s.color, fontSize: 12, fontWeight: 600 }}>
                      <span className="tt-health-dot" style={{ background: s.color, marginRight: 6 }} />
                      {s.label}
                    </span>
                    <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
                      {isDraft ? 'Draft upload' : `Publish${item.privacy_level ? ` (${item.privacy_level})` : ''}`}
                      {item.agent_id ? ` · via ${item.agent_id}` : ''}
                      {item.created_at ? ` · ${new Date(item.created_at).toLocaleString()}` : ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', whiteSpace: 'pre-wrap' }}>
                    {item.title || '(no title)'}
                  </div>
                  {item.file && (
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>File: {item.file}</div>
                  )}
                  {item.publish_id && (
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>publish_id: {item.publish_id}</div>
                  )}
                  {item.note && (
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>{item.note}</div>
                  )}
                  {item.error && (
                    <div style={{ fontSize: 12, color: 'rgba(248,113,113,0.85)', marginTop: 2 }}>{item.error}</div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
