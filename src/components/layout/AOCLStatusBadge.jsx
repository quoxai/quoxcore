/**
 * AOCLStatusBadge — Agent Orchestration Control Layers system info for footer
 *
 * AOCL is a processing pipeline (L0-L10), not a data store. Every chat message
 * passes through all 11 layers. This badge polls a real collector signal
 * (F2 honesty fix) — it is no longer forced green regardless of state:
 *   - online:   collector reachable AND at least one AOCL envelope recorded
 *   - degraded: collector reachable but zero AOCL envelopes recorded yet, OR
 *               one poll failed and we are waiting to see if it repeats
 *   - offline:  TWO consecutive polls failed
 * Follows the same poll-every-30s pattern as VoltStatusBadge.jsx.
 *
 * Why two failures and not one (2026-08-18): a walkthrough capture caught this
 * badge green in one shot and hard red in another, taken a minute apart, on a
 * platform that was healthy throughout. A single 5s timeout against a query
 * that scans a 1.7M-row table was enough to paint "AOCL offline" across the
 * footer of every page. Declaring a subsystem dead on one missed poll is the
 * same overconfidence the VOLT badge had in the other direction: a failed
 * probe is UNKNOWN, and unknown is amber, not red. Two consecutive misses is
 * a signal; one is weather.
 */

import { useState, useRef, useEffect } from 'react'
import { AOCL_LAYERS, AOCL_LAYER_ORDER } from '../../lib/aee/index.js'

const LAYER_COUNT = Object.keys(AOCL_LAYERS).length

function AOCLStatusBadge() {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [status, setStatus] = useState('loading') // loading | online | degraded | offline
  const badgeRef = useRef(null)

  // Poll a real AOCL activity signal from the collector every 30s, same
  // cadence as VoltStatusBadge.jsx. No suitable dedicated "AOCL health"
  // endpoint exists yet, so we reuse the AOCL envelope count — an error
  // means "offline", a fetch that succeeds with zero envelopes means
  // "degraded" (reachable but no processing evidence), never a forced green.
  useEffect(() => {
    let cancelled = false
    // Consecutive-failure counter, held in a ref so a re-render cannot reset it
    // and so the poll closure always reads the current value.
    let misses = 0
    const load = async () => {
      try {
        const res = await fetch('/collector/aee/query?intent=aocl.&limit=1', {
          credentials: 'include',
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) throw new Error(`${res.status}`)
        const data = await res.json()
        if (cancelled) return
        misses = 0
        setStatus((data.count || 0) > 0 ? 'online' : 'degraded')
      } catch {
        if (cancelled) return
        misses += 1
        // One miss is weather: a 5s timeout against a query that scans a
        // 1.7M-row table proves nothing about AOCL. Two in a row is a signal.
        setStatus(misses >= 2 ? 'offline' : 'degraded')
      }
    }
    load()
    const interval = setInterval(load, 30000)
    return () => { cancelled = true; clearInterval(interval) }
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

  const dotClass = status === 'online'
    ? 'status-dot--online'
    : status === 'degraded'
      ? 'status-dot--degraded'
      : status === 'offline'
        ? 'status-dot--offline'
        : 'status-dot--loading'

  const statusLabel = status === 'online'
    ? 'AOCL active — envelopes recorded'
    : status === 'degraded'
      ? 'AOCL reachable — no envelopes recorded yet'
      : status === 'offline'
        ? 'AOCL unreachable — collector fetch failed'
        : 'AOCL — checking status'

  return (
    <span
      className="app-shell__status-badge aocl-badge"
      ref={badgeRef}
      onClick={() => setDropdownOpen(!dropdownOpen)}
      style={{ cursor: 'pointer' }}
      title={statusLabel}
    >
      <AOCLIcon />
      <span className={`status-dot ${dotClass}`}></span>
      AOCL
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        style={{ width: 12, height: 12, marginLeft: 4, opacity: 0.6 }}>
        <polyline points={dropdownOpen ? "6 9 12 15 18 9" : "18 15 12 9 6 15"} />
      </svg>
      {dropdownOpen && (
        <div className="volt-badge-dropdown aocl-badge-dropdown">
          <div className="volt-badge-dropdown__title">AOCL — {LAYER_COUNT} Control Layers</div>
          <div className="aocl-layer-stack">
            {AOCL_LAYER_ORDER.map(id => {
              const layer = AOCL_LAYERS[id]
              return (
                <div key={id} className="aocl-layer-row">
                  <span className="aocl-layer-id" style={{ color: layer.color }}>{id}</span>
                  <span className="aocl-layer-name">{layer.label}</span>
                  <span className="aocl-layer-desc">{layer.description}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </span>
  )
}

const AOCLIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginRight: 4 }}>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
)

export default AOCLStatusBadge
