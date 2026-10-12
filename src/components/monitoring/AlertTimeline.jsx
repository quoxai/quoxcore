import { useState, useEffect, useCallback } from 'react'
import { getAlerts, queryRange } from '../../services/prometheusClient'

const SEVERITY_COLORS = {
  critical: '#ef4444',
  warning: '#f59e0b',
  info: '#3b82f6'
}

const RANGE_OPTIONS = [
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 }
]

function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000)
  if (totalMin < 60) return `${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`
  const d = Math.floor(h / 24)
  const remH = h % 24
  return remH > 0 ? `${d}d ${remH}h` : `${d}d`
}

function getSeverity(alert) {
  const sev = alert.labels?.severity || alert.metric?.severity || 'info'
  return SEVERITY_COLORS[sev] ? sev : 'info'
}

function getAlertName(item) {
  return item.labels?.alertname || item.metric?.alertname || 'Unknown'
}

const styles = `
.alert-timeline {
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 16px;
  color: rgba(255, 255, 255, 0.85);
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
}
.alert-timeline__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.alert-timeline__title {
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.alert-timeline__range-btns {
  display: flex;
  gap: 4px;
}
.alert-timeline__range-btn {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  color: rgba(255, 255, 255, 0.6);
  padding: 3px 10px;
  font-size: 12px;
  font-family: monospace;
  cursor: pointer;
  transition: all 0.15s;
}
.alert-timeline__range-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.85);
}
.alert-timeline__range-btn--active {
  background: rgba(59, 130, 246, 0.2);
  border-color: rgba(59, 130, 246, 0.4);
  color: rgba(255, 255, 255, 0.9);
}
.alert-timeline__summary {
  background: rgba(255, 255, 255, 0.04);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  margin-bottom: 14px;
  font-family: monospace;
  display: flex;
  align-items: center;
  gap: 8px;
}
.alert-timeline__chart {
  margin-bottom: 16px;
  overflow-x: auto;
}
.alert-timeline__row {
  display: flex;
  align-items: center;
  margin-bottom: 4px;
  min-height: 22px;
}
.alert-timeline__row-label {
  width: 140px;
  min-width: 140px;
  font-size: 11px;
  font-family: monospace;
  color: rgba(255, 255, 255, 0.7);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-right: 8px;
}
.alert-timeline__row-bar {
  flex: 1;
  height: 16px;
  position: relative;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 2px;
}
.alert-timeline__bar-segment {
  position: absolute;
  top: 1px;
  height: 14px;
  border-radius: 2px;
  opacity: 0.85;
  min-width: 2px;
}
.alert-timeline__bar-segment:hover {
  opacity: 1;
  box-shadow: 0 0 6px currentColor;
}
.alert-timeline__axis {
  display: flex;
  margin-left: 140px;
  margin-top: 2px;
  margin-bottom: 4px;
}
.alert-timeline__tick {
  font-size: 10px;
  font-family: monospace;
  color: rgba(255, 255, 255, 0.35);
  text-align: center;
}
.alert-timeline__divider {
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  margin: 12px 0;
}
.alert-timeline__section-title {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.alert-timeline__firing-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.alert-timeline__firing-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 4px;
  font-size: 12px;
  font-family: monospace;
}
.alert-timeline__badge {
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}
.alert-timeline__instance {
  color: rgba(255, 255, 255, 0.5);
}
.alert-timeline__duration {
  margin-left: auto;
  color: rgba(255, 255, 255, 0.6);
}
.alert-timeline__empty {
  text-align: center;
  padding: 24px;
  color: rgba(255, 255, 255, 0.35);
  font-size: 13px;
}
.alert-timeline__loading {
  text-align: center;
  padding: 32px;
  color: rgba(255, 255, 255, 0.4);
  font-size: 13px;
}
`

export function AlertTimeline() {
  const [rangeHours, setRangeHours] = useState(24)
  const [loading, setLoading] = useState(true)
  const [currentAlerts, setCurrentAlerts] = useState(null)
  const [timelineRows, setTimelineRows] = useState([])

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const now = Date.now()
      const start = (now - rangeHours * 3600000) / 1000
      const end = now / 1000
      const step = rangeHours <= 6 ? '1m' : rangeHours <= 24 ? '5m' : '15m'

      const [alertsRes, rangeRes] = await Promise.all([
        getAlerts(),
        queryRange('ALERTS{alertstate="firing"}', String(start), String(end), step)
      ])

      setCurrentAlerts(alertsRes)

      // Build timeline rows from range data
      const rowMap = new Map()
      if (rangeRes.success && rangeRes.result) {
        for (const series of rangeRes.result) {
          const name = series.metric?.alertname || 'Unknown'
          const severity = series.metric?.severity || 'info'
          const key = `${name}__${severity}`
          if (!rowMap.has(key)) {
            rowMap.set(key, { name, severity, segments: [] })
          }
          // Each value pair is [timestamp, "1"] when firing
          const values = series.values || []
          const entry = rowMap.get(key)
          let segStart = null
          for (let i = 0; i < values.length; i++) {
            const ts = values[i][0]
            const val = parseFloat(values[i][1])
            if (val >= 1 && segStart === null) {
              segStart = ts
            } else if ((val < 1 || i === values.length - 1) && segStart !== null) {
              const segEnd = val >= 1 ? ts : values[i - 1]?.[0] || ts
              entry.segments.push({ start: segStart, end: segEnd })
              segStart = null
            }
          }
        }
      }

      setTimelineRows(
        Array.from(rowMap.values()).sort((a, b) => {
          const order = { critical: 0, warning: 1, info: 2 }
          return (order[a.severity] ?? 2) - (order[b.severity] ?? 2)
        })
      )
    } catch (err) {
      console.error('[AlertTimeline] fetch failed:', err)
    } finally {
      setLoading(false)
    }
  }, [rangeHours])

  useEffect(() => { fetchData() }, [fetchData])

  const summary = currentAlerts?.summary || { firing: 0, critical: 0, warning: 0 }
  const rangeStart = Date.now() - rangeHours * 3600000
  const rangeEnd = Date.now()
  const rangeDuration = rangeEnd - rangeStart

  // Build hour tick marks
  const ticks = []
  const tickCount = rangeHours <= 6 ? 6 : rangeHours <= 24 ? 8 : 7
  for (let i = 0; i <= tickCount; i++) {
    const t = new Date(rangeStart + (rangeDuration * i) / tickCount)
    const label = rangeHours <= 24
      ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      : t.toLocaleDateString([], { weekday: 'short', hour: '2-digit', hour12: false })
    ticks.push({ pct: (i / tickCount) * 100, label })
  }

  return (
    <div className="alert-timeline">
      <style>{styles}</style>

      <div className="alert-timeline__header">
        <div className="alert-timeline__title">
          {'>>> '} Alert Timeline
        </div>
        <div className="alert-timeline__range-btns">
          {RANGE_OPTIONS.map(opt => (
            <button
              key={opt.label}
              className={`alert-timeline__range-btn ${rangeHours === opt.hours ? 'alert-timeline__range-btn--active' : ''}`}
              onClick={() => setRangeHours(opt.hours)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="alert-timeline__summary">
        <span>{summary.firing > 0 ? '\u26a0' : '\u2713'}</span>
        <span>
          {summary.firing} firing
          {summary.firing > 0 && ` (${summary.critical} critical, ${summary.warning} warning)`}
        </span>
      </div>

      {loading ? (
        <div className="alert-timeline__loading">Loading alert history...</div>
      ) : timelineRows.length === 0 ? (
        <div className="alert-timeline__empty">No alerts in the selected time range</div>
      ) : (
        <div className="alert-timeline__chart">
          {timelineRows.map((row, idx) => (
            <div className="alert-timeline__row" key={idx}>
              <div className="alert-timeline__row-label" title={row.name}>{row.name}</div>
              <div className="alert-timeline__row-bar">
                {row.segments.map((seg, si) => {
                  const left = ((seg.start * 1000 - rangeStart) / rangeDuration) * 100
                  const width = ((seg.end * 1000 - seg.start * 1000) / rangeDuration) * 100
                  const clampLeft = Math.max(0, left)
                  const clampWidth = Math.min(100 - clampLeft, Math.max(0.3, width))
                  return (
                    <div
                      key={si}
                      className="alert-timeline__bar-segment"
                      style={{
                        left: `${clampLeft}%`,
                        width: `${clampWidth}%`,
                        backgroundColor: SEVERITY_COLORS[row.severity] || SEVERITY_COLORS.info,
                        color: SEVERITY_COLORS[row.severity] || SEVERITY_COLORS.info
                      }}
                      title={`${row.name} (${row.severity})\n${new Date(seg.start * 1000).toLocaleTimeString()} - ${new Date(seg.end * 1000).toLocaleTimeString()}`}
                    />
                  )
                })}
              </div>
            </div>
          ))}
          <div className="alert-timeline__axis">
            {ticks.map((tick, i) => (
              <div
                key={i}
                className="alert-timeline__tick"
                style={{ width: i < ticks.length - 1 ? `${100 / tickCount}%` : 'auto' }}
              >
                {tick.label}
              </div>
            ))}
          </div>
        </div>
      )}

      {currentAlerts?.firing?.length > 0 && (
        <>
          <hr className="alert-timeline__divider" />
          <div className="alert-timeline__section-title">Currently Firing</div>
          <div className="alert-timeline__firing-list">
            {currentAlerts.firing.map((alert, i) => {
              const sev = getSeverity(alert)
              const name = getAlertName(alert)
              const instance = alert.labels?.instance || ''
              const activeAt = alert.activeAt ? new Date(alert.activeAt).getTime() : null
              const duration = activeAt ? formatDuration(Date.now() - activeAt) : '--'
              return (
                <div className="alert-timeline__firing-item" key={i}>
                  <span>{name}</span>
                  <span
                    className="alert-timeline__badge"
                    style={{
                      backgroundColor: `${SEVERITY_COLORS[sev]}22`,
                      color: SEVERITY_COLORS[sev],
                      border: `1px solid ${SEVERITY_COLORS[sev]}44`
                    }}
                  >
                    {sev}
                  </span>
                  {instance && (
                    <span className="alert-timeline__instance">{instance}</span>
                  )}
                  <span className="alert-timeline__duration">{duration}</span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

export default AlertTimeline
