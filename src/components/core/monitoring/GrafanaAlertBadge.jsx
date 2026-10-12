/**
 * GrafanaAlertBadge — Compact alert state widget for NOC header
 *
 * Polls Grafana alert rules via the collector proxy and shows
 * firing/pending/normal counts in a compact inline badge.
 */

import { useState, useEffect, useRef } from 'react'
import { getAlertStates } from '../../../services/grafanaClient'
import './monitoring.css'

export function GrafanaAlertBadge({ pollInterval = 30000 }) {
  const [summary, setSummary] = useState(null)
  const [rules, setRules] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const intervalRef = useRef(null)
  const badgeRef = useRef(null)

  useEffect(() => {
    let cancelled = false

    const fetchAlerts = async () => {
      try {
        const result = await getAlertStates()
        if (cancelled) return
        if (result.success) {
          setSummary(result.summary)
          setRules(result.rules || [])
          setError(false)
        } else {
          setError(true)
        }
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchAlerts()
    intervalRef.current = setInterval(fetchAlerts, pollInterval)
    return () => {
      cancelled = true
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [pollInterval])

  // Close dropdown on outside click
  useEffect(() => {
    if (!expanded) return
    const handleClick = (e) => {
      if (badgeRef.current && !badgeRef.current.contains(e.target)) {
        setExpanded(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [expanded])

  if (loading) {
    return (
      <div className="grafana-alert-badge grafana-alert-badge--loading">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        <span className="grafana-alert-badge__text">Alerts...</span>
      </div>
    )
  }

  if (error || !summary) {
    return (
      <div className="grafana-alert-badge grafana-alert-badge--error" title="Grafana unreachable">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        <span className="grafana-alert-badge__text">N/A</span>
      </div>
    )
  }

  const hasFiring = summary.firing > 0
  const hasPending = summary.pending > 0
  const firingRules = rules.filter(r => {
    const s = (r.state || '').toLowerCase()
    return s === 'firing' || s === 'alerting'
  })
  const pendingRules = rules.filter(r => (r.state || '').toLowerCase() === 'pending')

  return (
    <div className="grafana-alert-badge" ref={badgeRef}>
      <button
        className={`grafana-alert-badge__btn ${hasFiring ? 'grafana-alert-badge--firing' : hasPending ? 'grafana-alert-badge--pending' : 'grafana-alert-badge--ok'}`}
        onClick={() => setExpanded(!expanded)}
        title={`Grafana Alerts: ${summary.firing} firing, ${summary.pending} pending, ${summary.normal} normal`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        {hasFiring && <span className="grafana-alert-count grafana-alert-count--firing">{summary.firing}</span>}
        {hasPending && <span className="grafana-alert-count grafana-alert-count--pending">{summary.pending}</span>}
        {!hasFiring && !hasPending && <span className="grafana-alert-count grafana-alert-count--ok">OK</span>}
      </button>

      {expanded && (
        <div className="grafana-alert-dropdown">
          <div className="grafana-alert-dropdown__header">
            Grafana Alerts
            <span className="grafana-alert-dropdown__total">{summary.firing + summary.pending + summary.normal} rules</span>
          </div>
          {firingRules.length > 0 && (
            <div className="grafana-alert-dropdown__section">
              <div className="grafana-alert-dropdown__label grafana-alert-dropdown__label--firing">Firing ({summary.firing})</div>
              {firingRules.map((r, i) => (
                <div key={i} className="grafana-alert-dropdown__item grafana-alert-dropdown__item--firing">
                  <span className="grafana-alert-dropdown__dot" />
                  {r.title}
                  {r.folder && <span className="grafana-alert-dropdown__folder">{r.folder}</span>}
                </div>
              ))}
            </div>
          )}
          {pendingRules.length > 0 && (
            <div className="grafana-alert-dropdown__section">
              <div className="grafana-alert-dropdown__label grafana-alert-dropdown__label--pending">Pending ({summary.pending})</div>
              {pendingRules.map((r, i) => (
                <div key={i} className="grafana-alert-dropdown__item grafana-alert-dropdown__item--pending">
                  <span className="grafana-alert-dropdown__dot" />
                  {r.title}
                </div>
              ))}
            </div>
          )}
          {!hasFiring && !hasPending && (
            <div className="grafana-alert-dropdown__ok">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#30ff90" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              All {summary.normal} rules normal
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default GrafanaAlertBadge
