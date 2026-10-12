/**
 * AEEStatusBadge — Agent Envelope Exchange status for footer
 *
 * Shows AEE activity at a glance. Polls /collector/aee/stats every 30s.
 *
 * States:
 *   - Active (green):  envelopes exist, recent activity
 *   - Idle (dim):      no envelopes yet
 *   - Error (amber):   fetch failed
 */

import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

function AEEStatusBadge() {
  const navigate = useNavigate()
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const badgeRef = useRef(null)

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/collector/aee/stats', { signal: AbortSignal.timeout(5000) })
        if (res.ok) {
          setStats(await res.json())
          setError(false)
        } else {
          setError(true)
        }
      } catch {
        setError(true)
      }
    }
    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!dropdownOpen) return
    const handleClick = (e) => {
      if (badgeRef.current && !badgeRef.current.contains(e.target))
        setDropdownOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [dropdownOpen])

  const total = stats?.total_envelopes || stats?.total || 0
  const conversations = stats?.conversations || 0
  const hasData = total > 0

  let dotClass = 'status-dot--online'
  let label = 'AEE'

  if (error && !stats) {
    dotClass = 'status-dot--degraded'
    label = 'AEE'
  } else if (!hasData) {
    dotClass = 'status-dot--loading'
    label = 'AEE'
  }

  return (
    <span
      className="app-shell__status-badge aee-badge"
      ref={badgeRef}
      onClick={() => setDropdownOpen(!dropdownOpen)}
      style={{ cursor: 'pointer' }}
    >
      <AEEIcon />
      <span className={`status-dot ${dotClass}`}></span>
      {label}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        style={{ width: 12, height: 12, marginLeft: 4, opacity: 0.6 }}>
        <polyline points={dropdownOpen ? "6 9 12 15 18 9" : "18 15 12 9 6 15"} />
      </svg>
      {dropdownOpen && (
        <div className="volt-badge-dropdown aee-badge-dropdown">
          <div className="volt-badge-dropdown__title">AEE — Envelope Exchange</div>
          <div className="volt-badge-dropdown__stats">
            <div className="volt-badge-dropdown__row">
              <span>Envelopes</span>
              <span className="volt-badge-dropdown__value">{total.toLocaleString()}</span>
            </div>
            <div className="volt-badge-dropdown__row">
              <span>Conversations</span>
              <span className="volt-badge-dropdown__value">{conversations.toLocaleString()}</span>
            </div>
            {stats?.oldest_ts && (
              <div className="volt-badge-dropdown__row">
                <span>First Seen</span>
                <span className="volt-badge-dropdown__value">{new Date(stats.oldest_ts).toLocaleDateString()}</span>
              </div>
            )}
            {stats?.newest_ts && (
              <div className="volt-badge-dropdown__row">
                <span>Latest</span>
                <span className="volt-badge-dropdown__value">{timeAgo(stats.newest_ts)}</span>
              </div>
            )}
          </div>
          <button
            className="volt-badge-dropdown__link"
            onClick={(e) => { e.stopPropagation(); navigate('/activity'); setDropdownOpen(false) }}
          >
            View Activity
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      )}
    </span>
  )
}

function timeAgo(ts) {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const AEEIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginRight: 4 }}>
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
    <polyline points="22 6 12 13 2 6" />
  </svg>
)

export default AEEStatusBadge
