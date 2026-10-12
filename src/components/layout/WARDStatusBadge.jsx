/**
 * WARDStatusBadge — Write-once Append-only Receipt Digests status for footer
 *
 * Shows WARD chain integrity at a glance. Polls /collector/ward/stats every 30s.
 *
 * States:
 *   - Active (green):  chains exist, integrity verified
 *   - Warning (amber):  verify failed or no recent tips
 *   - Idle (dim):       no chains yet
 */

import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

function WARDStatusBadge() {
  const navigate = useNavigate()
  const [stats, setStats] = useState(null)
  const [chains, setChains] = useState(null)
  const [error, setError] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const badgeRef = useRef(null)

  useEffect(() => {
    const load = async () => {
      try {
        const [statsRes, chainsRes] = await Promise.all([
          fetch('/collector/ward/stats', { signal: AbortSignal.timeout(5000) }),
          fetch('/collector/ward/chains', { signal: AbortSignal.timeout(5000) }),
        ])
        if (statsRes.ok) {
          setStats(await statsRes.json())
        }
        if (chainsRes.ok) {
          const data = await chainsRes.json()
          setChains(Array.isArray(data) ? data : data?.chains || [])
        }
        setError(false)
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

  const totalEntries = stats?.stats?.total_entries || stats?.total_entries || 0
  const totalChains = chains?.length || stats?.stats?.total_chains || 0
  const witnessEntries = stats?.witness?.total_entries || 0
  const hasData = totalEntries > 0 || totalChains > 0

  let dotClass = 'status-dot--online'
  let label = 'WARD'

  if (error && !stats) {
    dotClass = 'status-dot--degraded'
    label = 'WARD'
  } else if (!hasData) {
    dotClass = 'status-dot--loading'
    label = 'WARD'
  }

  // Count chain statuses
  const activeChains = chains?.filter(c => c.status === 'active').length || 0
  const sealedChains = chains?.filter(c => c.status === 'sealed').length || 0

  return (
    <span
      className="app-shell__status-badge ward-badge"
      ref={badgeRef}
      onClick={() => setDropdownOpen(!dropdownOpen)}
      style={{ cursor: 'pointer' }}
    >
      <WARDIcon />
      <span className={`status-dot ${dotClass}`}></span>
      {label}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        style={{ width: 12, height: 12, marginLeft: 4, opacity: 0.6 }}>
        <polyline points={dropdownOpen ? "6 9 12 15 18 9" : "18 15 12 9 6 15"} />
      </svg>
      {dropdownOpen && (
        <div className="volt-badge-dropdown ward-badge-dropdown">
          <div className="volt-badge-dropdown__title">WARD: Receipt Digests</div>
          <div className="volt-badge-dropdown__stats">
            <div className="volt-badge-dropdown__row">
              <span>Total Entries</span>
              <span className="volt-badge-dropdown__value">{totalEntries.toLocaleString()}</span>
            </div>
            <div className="volt-badge-dropdown__row">
              <span>Chains</span>
              <span className="volt-badge-dropdown__value">{totalChains}</span>
            </div>
            {activeChains > 0 && (
              <div className="volt-badge-dropdown__row">
                <span>Active Chains</span>
                <span className="volt-badge-dropdown__value" style={{ color: '#30ff90' }}>{activeChains}</span>
              </div>
            )}
            {sealedChains > 0 && (
              <div className="volt-badge-dropdown__row">
                <span>Sealed</span>
                <span className="volt-badge-dropdown__value">{sealedChains}</span>
              </div>
            )}
            {witnessEntries > 0 && (
              <div className="volt-badge-dropdown__row">
                <span>Witnessed</span>
                <span className="volt-badge-dropdown__value">{witnessEntries.toLocaleString()}</span>
              </div>
            )}
          </div>
          <button
            className="volt-badge-dropdown__link"
            onClick={(e) => { e.stopPropagation(); navigate('/ward'); setDropdownOpen(false) }}
          >
            View WARD Dashboard
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      )}
    </span>
  )
}

const WARDIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginRight: 4 }}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18" />
    <path d="M9 21V9" />
  </svg>
)

export default WARDStatusBadge
