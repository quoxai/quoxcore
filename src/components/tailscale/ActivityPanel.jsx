/**
 * ActivityPanel — Tab 5: Tailscale audit log feed
 *
 * Shows configuration audit log entries from the Tailscale API.
 * Each entry shows timestamp, actor, action, and target.
 */

import React, { useEffect } from 'react'

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return 'Today'
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function describeAction(entry) {
  const action = (entry.action || '').toLowerCase()
  const target = entry.target?.name || entry.target?.type || 'unknown'
  const prop = entry.target?.property

  if (action === 'create') return `created ${target}${prop ? ` (${prop})` : ''}`
  if (action === 'update') return `updated ${prop || 'settings'} on ${target}`
  if (action === 'delete') return `deleted ${target}`
  return `${action} ${target}${prop ? ` (${prop})` : ''}`
}

export default function ActivityPanel({ data }) {
  useEffect(() => {
    if (data.auditEntries.length === 0) {
      data.loadAuditLog()
    }
  }, [])

  if (data.auditEntries.length === 0) {
    return (
      <div className="ts-empty" style={{ minHeight: '30vh' }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.6 }}>
          <path d="M12 8v4l3 3" stroke="#818cf8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="10" stroke="#818cf8" strokeWidth="1.5" />
        </svg>
        <p className="ts-empty__title" style={{ fontSize: 15 }}>No Recent Activity</p>
        <p className="ts-empty__desc" style={{ fontSize: 13 }}>
          Configuration changes from the last 7 days will appear here.
        </p>
      </div>
    )
  }

  // Group entries by date
  const grouped = {}
  for (const entry of data.auditEntries) {
    const dateKey = formatDate(entry.eventTime)
    if (!grouped[dateKey]) grouped[dateKey] = []
    grouped[dateKey].push(entry)
  }

  return (
    <div>
      {Object.entries(grouped).map(([dateLabel, entries]) => (
        <div key={dateLabel} style={{ marginBottom: 20 }}>
          <div style={{
            fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
            color: 'var(--m-text-tertiary, #71717a)', marginBottom: 8, paddingLeft: 12
          }}>
            {dateLabel}
          </div>
          <div className="ts-activity-feed">
            {entries.map((entry, i) => (
              <div className="ts-activity-entry" key={`${entry.eventTime}-${i}`}>
                <span className="ts-activity-entry__time">
                  {formatTime(entry.eventTime)}
                </span>
                <span className="ts-activity-entry__actor">
                  {entry.actor?.loginName || entry.actor?.type || 'System'}
                </span>
                <span className="ts-activity-entry__action">
                  {describeAction(entry)}
                  {entry.old && entry.new && (
                    <span style={{ fontSize: 11, color: 'var(--m-text-tertiary, #71717a)', marginLeft: 8 }}>
                      ({String(entry.old).slice(0, 30)} → {String(entry.new).slice(0, 30)})
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div style={{ textAlign: 'center', marginTop: 16 }}>
        <button className="ts-btn" onClick={() => data.loadAuditLog({ limit: 100 })}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Load More
        </button>
      </div>
    </div>
  )
}
