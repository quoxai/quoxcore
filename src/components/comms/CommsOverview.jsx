/**
 * CommsOverview — Dashboard grid for Communications Command Centre.
 * Shows channel health cards, delivery stats, and recent delivery feed.
 */

import ChannelCard from './ChannelCard'
import './comms-layout.css'

const CHANNEL_ICONS = {
  telegram: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#0088cc' }}>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
    </svg>
  ),
  slack: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#e01e5a' }}>
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52z"/>
    </svg>
  ),
  discord: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#5865f2' }}>
      <circle cx="12" cy="12" r="10"/>
    </svg>
  ),
  email: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: '#ea4335' }}>
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>
    </svg>
  ),
}

const STATUS_ICONS = {
  sent: <span className="comms-badge comms-badge--success">Sent</span>,
  delivered: <span className="comms-badge comms-badge--success">Delivered</span>,
  failed: <span className="comms-badge comms-badge--error">Failed</span>,
  pending: <span className="comms-badge comms-badge--warning">Pending</span>,
  bounced: <span className="comms-badge comms-badge--error">Bounced</span>,
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return d.toLocaleDateString()
}

export default function CommsOverview({ config, channelStatus, deliveryStats, recentDeliveries, onSelectChannel }) {
  const channels = ['telegram', 'slack', 'discord', 'email']
  const rate = deliveryStats.total > 0
    ? Math.round(((deliveryStats.sent) / deliveryStats.total) * 100)
    : null

  return (
    <div>
      <div className="comms-content__header">
        <h2 className="comms-content__title">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
          </svg>
          Channel Overview
        </h2>
      </div>

      {/* Channel cards grid */}
      <div className="comms-overview-grid">
        {channels.map(ch => (
          <ChannelCard
            key={ch}
            channelType={ch}
            config={config?.[ch]}
            status={channelStatus?.[ch]}
            onSelect={onSelectChannel}
          />
        ))}
      </div>

      {/* Recent deliveries feed */}
      <div className="comms-delivery-feed">
        <div className="comms-delivery-feed__title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          Recent Deliveries
        </div>
        {recentDeliveries.length > 0 ? (
          <div className="comms-delivery-feed__list">
            {recentDeliveries.map(d => (
              <div key={d.id} className="comms-delivery-feed__item">
                <div className="comms-delivery-feed__channel">
                  {CHANNEL_ICONS[d.channel_type] || CHANNEL_ICONS.email}
                </div>
                <span className="comms-delivery-feed__title-text">
                  {d.title || d.content_json?.title || d.inbox_item_title || 'Notification'}
                </span>
                {STATUS_ICONS[d.status] || <span className="comms-badge comms-badge--neutral">{d.status}</span>}
                <span className="comms-delivery-feed__time">
                  {formatTime(d.created_at || d.sent_at)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="comms-delivery-feed__empty">
            No deliveries yet. Configure a channel and send a test notification.
          </div>
        )}
      </div>
    </div>
  )
}
