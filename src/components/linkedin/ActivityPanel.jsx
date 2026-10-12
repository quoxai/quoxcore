/**
 * ActivityPanel — the org's governed LinkedIn write history (LI-OVERHAUL P11).
 *
 * Reads the REAL approval trail: every drafted publish/comment and its human
 * decision. The card trail IS the ledger — there is no parallel bookkeeping,
 * so this list cannot drift from what actually happened.
 */

import './linkedin.css'

const STATUS_STYLES = {
  awaiting_approval: { label: 'Awaiting approval', color: 'rgba(251, 191, 36, 0.9)' },
  executing: { label: 'Executing', color: 'rgba(96, 165, 250, 0.9)' },
  published: { label: 'Published', color: 'rgba(52, 211, 153, 0.9)' },
  denied: { label: 'Denied', color: 'rgba(148, 163, 184, 0.9)' },
  failed: { label: 'Failed', color: 'rgba(248, 113, 113, 0.9)' },
}

function postUrl(urn) {
  if (!urn || typeof urn !== 'string' || !urn.startsWith('urn:li:')) return null
  return `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/`
}

export default function ActivityPanel({ activity = [], onRefresh }) {
  return (
    <div className="li-panel">
      <div className="li-panel__header">
        <h3 className="li-panel__title">{'\u{1F4DC}'} Activity</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
            {activity.length} governed write{activity.length === 1 ? '' : 's'}
          </span>
          {onRefresh && (
            <button className="li-panel__action" onClick={onRefresh} title="Refresh">&#8635;</button>
          )}
        </div>
      </div>
      <div className="li-panel__body">
        {activity.length === 0 ? (
          <p style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13, margin: '8px 0' }}>
            No governed writes yet. Every publish and comment lands here with its
            approval outcome the moment it is drafted.
          </p>
        ) : (
          <div className="li-activity-list">
            {activity.map((item) => {
              const s = STATUS_STYLES[item.status] || { label: item.status, color: 'rgba(255,255,255,0.6)' }
              const link = postUrl(item.post_urn)
              return (
                <div key={item.approval_id} className="li-activity-row" style={{ padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ color: s.color, fontSize: 12, fontWeight: 600 }}>
                      <span className="li-health-dot" style={{ background: s.color, marginRight: 6 }} />
                      {s.label}
                    </span>
                    <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
                      {item.kind === 'comment' ? 'Comment' : 'Post'}
                      {item.agent_id ? ` · via ${item.agent_id}` : ''}
                      {item.created_at ? ` · ${new Date(item.created_at).toLocaleString()}` : ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', whiteSpace: 'pre-wrap' }}>
                    {item.text || '(no text)'}
                  </div>
                  {link && (
                    <a href={link} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: 'rgba(10,102,194,0.9)' }}>
                      View on LinkedIn
                    </a>
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
