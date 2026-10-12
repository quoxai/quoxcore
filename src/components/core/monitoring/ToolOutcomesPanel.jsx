import { useState, useEffect, useCallback } from 'react'
import './monitoring.css'

/**
 * ToolOutcomesPanel (NQ-5b)
 *
 * Reads services/collector's /noc/tool-outcomes/stats endpoint — the
 * consumer for the noc_tool_outcomes table (previously write-only).
 * Surfaces per-tool success rate, avg duration, and error counts so
 * "which NOC tools are failing / slow / flaky" is visible at a glance.
 */
export function ToolOutcomesPanel({ window: statsWindow = '24h' }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tools, setTools] = useState([])
  const [lastUpdate, setLastUpdate] = useState(null)

  const fetchStats = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const resp = await fetch(`/collector/noc/tool-outcomes/stats?window=${statsWindow}`, {
        credentials: 'include',
        signal: AbortSignal.timeout(10000),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      setTools(Array.isArray(data.tools) ? data.tools : [])
      setLastUpdate(new Date())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [statsWindow])

  useEffect(() => {
    fetchStats()
    const interval = setInterval(fetchStats, 60000) // Refresh every 60s
    return () => clearInterval(interval)
  }, [fetchStats])

  if (loading && tools.length === 0) {
    return <div className="noc-tool-outcomes noc-tool-outcomes--loading">Loading tool outcomes…</div>
  }

  if (error) {
    return <div className="noc-tool-outcomes noc-tool-outcomes--error">Tool outcomes unavailable: {error}</div>
  }

  if (tools.length === 0) {
    return <div className="noc-tool-outcomes noc-tool-outcomes--empty">No NOC tool calls recorded in the last {statsWindow}.</div>
  }

  return (
    <div className="noc-tool-outcomes">
      <table className="noc-tool-outcomes__table">
        <thead>
          <tr>
            <th>Tool</th>
            <th>Calls</th>
            <th>Success</th>
            <th>Errors</th>
            <th>Avg ms</th>
          </tr>
        </thead>
        <tbody>
          {tools.map(t => {
            const rate = Math.round((t.success_rate ?? 1) * 100)
            const flaky = rate < 90 && t.total >= 3
            return (
              <tr key={t.tool_name} className={flaky ? 'noc-tool-outcomes__row--flaky' : ''}>
                <td>{t.tool_name}</td>
                <td>{t.total}</td>
                <td>{rate}%</td>
                <td>{t.errors}</td>
                <td>{t.avg_duration_ms}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {lastUpdate && (
        <div className="noc-tool-outcomes__footer">Updated {lastUpdate.toLocaleTimeString()} · last {statsWindow}</div>
      )}
    </div>
  )
}
