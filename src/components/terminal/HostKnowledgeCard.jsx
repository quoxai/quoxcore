/**
 * HostKnowledgeCard
 *
 * Shows accumulated knowledge about a host when connecting to
 * a known host in the terminal. Pulls data from the memory system:
 * - Session count from localStorage
 * - Known services/containers from entity memory
 * - Last error from error entities
 *
 * Renders nothing for first-time/unknown hosts.
 * Dismissible per session (sessionStorage).
 */

import { useState, useEffect, useMemo } from 'react'
import { getMemoryManager } from '../../services/memoryManager'
import './HostKnowledgeCard.css'

const SESSIONS_KEY = 'quox_terminal_sessions'

function getSessionCount(hostId) {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    if (!raw) return 0
    const sessions = JSON.parse(raw)
    return sessions.filter(s => s.hostId === hostId).length
  } catch {
    return 0
  }
}

function getHostServices(mm, hostId) {
  try {
    const all = mm.getAllEntities()
    return all
      .filter(e =>
        (e.type === 'service' || e.type === 'container') &&
        e.attributes?.hostId === hostId
      )
      .map(e => e.name)
      .slice(0, 6)
  } catch {
    return []
  }
}

function getLastError(mm, hostId) {
  try {
    const all = mm.getAllEntities()
    const errors = all
      .filter(e => e.type === 'error' && e.attributes?.hostId === hostId)
      .sort((a, b) => {
        const ta = a.attributes?.detectedAt || ''
        const tb = b.attributes?.detectedAt || ''
        return tb.localeCompare(ta)
      })
    return errors[0] || null
  } catch {
    return null
  }
}

function relativeTime(isoStr) {
  if (!isoStr) return ''
  try {
    const diff = Date.now() - new Date(isoStr).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  } catch {
    return ''
  }
}

export default function HostKnowledgeCard({ hostId, sessionId }) {
  const [dismissed, setDismissed] = useState(false)

  // Check if dismissed for this session
  useEffect(() => {
    if (!sessionId) return
    try {
      const key = `quox_host_card_dismissed_${sessionId}`
      if (sessionStorage.getItem(key) === 'true') {
        setDismissed(true)
      }
    } catch {
      // sessionStorage unavailable
    }
  }, [sessionId])

  const data = useMemo(() => {
    if (!hostId || hostId === 'local') return null

    const mm = getMemoryManager()
    if (!mm) return null

    const sessionCount = getSessionCount(hostId)
    const hostEntity = mm.getEntity('host', hostId)

    // Only show for known hosts (at least 1 previous session or entity exists)
    if (sessionCount === 0 && !hostEntity) return null

    const services = getHostServices(mm, hostId)
    const lastError = getLastError(mm, hostId)

    return { sessionCount, services, lastError }
  }, [hostId])

  if (!data || dismissed) return null

  const handleDismiss = () => {
    setDismissed(true)
    if (sessionId) {
      try {
        sessionStorage.setItem(`quox_host_card_dismissed_${sessionId}`, 'true')
      } catch {
        // sessionStorage unavailable
      }
    }
  }

  return (
    <div className="host-card">
      <div className="host-card__header">
        <svg className="host-card__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
          <path d="M9 21h6" />
        </svg>
        <span className="host-card__title">
          {hostId}
          {data.sessionCount > 0 && (
            <span className="host-card__sessions">
              {' '}&mdash; {data.sessionCount} previous session{data.sessionCount !== 1 ? 's' : ''}
            </span>
          )}
        </span>
        <button className="host-card__dismiss" onClick={handleDismiss} title="Dismiss">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {data.services.length > 0 && (
        <div className="host-card__row">
          <span className="host-card__label">Services:</span>
          <span className="host-card__value">{data.services.join(', ')}</span>
        </div>
      )}

      {data.lastError && (
        <div className="host-card__row host-card__row--error">
          <span className="host-card__label">Last error:</span>
          <span className="host-card__value">
            {data.lastError.attributes?.errorType || 'unknown'}
            {data.lastError.attributes?.detectedAt && (
              <span className="host-card__time">
                {' '}({relativeTime(data.lastError.attributes.detectedAt)})
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  )
}
