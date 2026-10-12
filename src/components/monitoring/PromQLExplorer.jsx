/**
 * PromQLExplorer — Interactive PromQL query builder for the Prometheus plugin.
 * Run instant or range queries, pick from presets, view results in a table.
 */

import { useState, useCallback } from 'react'
import { queryPrometheus, queryRange } from '../../services/prometheusClient'

const PRESETS = [
  { label: 'CPU usage per host', query: '100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)' },
  { label: 'Memory usage', query: '(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100' },
  { label: 'Disk usage', query: '(1 - (node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})) * 100' },
  { label: 'Network RX rate', query: 'rate(node_network_receive_bytes_total{device!="lo"}[5m])' },
  { label: 'Load average', query: 'node_load1' },
  { label: 'Hosts up', query: 'count(up == 1)' },
  { label: 'Top 5 CPU', query: 'topk(5, 100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100))' },
  { label: 'Container memory', query: 'container_memory_usage_bytes' },
]

const RANGE_PRESETS = [
  { label: '15m', seconds: 900 },
  { label: '1h', seconds: 3600 },
  { label: '6h', seconds: 21600 },
  { label: '24h', seconds: 86400 },
  { label: '7d', seconds: 604800 },
]

function formatValue(v) {
  const num = parseFloat(v)
  if (isNaN(num)) return v
  if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(2) + ' G'
  if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(2) + ' M'
  if (Math.abs(num) >= 1e3) return (num / 1e3).toFixed(2) + ' K'
  return num % 1 === 0 ? num.toString() : num.toFixed(4)
}

function metricLabel(metric) {
  if (!metric || Object.keys(metric).length === 0) return '{}'
  const inst = metric.instance || metric.__name__ || ''
  const extra = Object.entries(metric)
    .filter(([k]) => k !== '__name__' && k !== 'instance' && k !== 'job')
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ')
  return inst + (extra ? ` (${extra})` : '')
}

function formatTimestamp(ts) {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
}

export function PromQLExplorer() {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState('instant') // 'instant' | 'range'
  const [rangeDuration, setRangeDuration] = useState(3600)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [resultType, setResultType] = useState(null)
  const [history, setHistory] = useState([])

  const addToHistory = useCallback((q) => {
    setHistory(prev => {
      const filtered = prev.filter(h => h !== q)
      return [q, ...filtered].slice(0, 10)
    })
  }, [])

  const runQuery = useCallback(async () => {
    if (!query.trim()) return
    setLoading(true)
    setError(null)
    setResult(null)
    addToHistory(query.trim())

    try {
      let res
      if (mode === 'range') {
        const now = Math.floor(Date.now() / 1000)
        const start = now - rangeDuration
        const step = rangeDuration <= 3600 ? '15s' : rangeDuration <= 86400 ? '1m' : '5m'
        res = await queryRange(query.trim(), start.toString(), now.toString(), step)
      } else {
        res = await queryPrometheus(query.trim())
      }

      if (!res.success) {
        setError(res.error || 'Query failed')
      } else {
        setResultType(res.resultType)
        setResult(res.result)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [query, mode, rangeDuration, addToHistory])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      runQuery()
    }
  }

  const renderVectorTable = () => {
    if (!result || result.length === 0) return <div className="pql-empty">No results</div>
    return (
      <table className="pql-table">
        <thead>
          <tr><th>Instance / Metric</th><th>Value</th></tr>
        </thead>
        <tbody>
          {result.map((item, i) => (
            <tr key={i}>
              <td className="pql-cell-metric">{metricLabel(item.metric)}</td>
              <td className="pql-cell-value">{formatValue(item.value?.[1])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  const renderMatrixTable = () => {
    if (!result || result.length === 0) return <div className="pql-empty">No results</div>
    return (
      <div className="pql-matrix-wrap">
        {result.map((series, si) => (
          <div key={si} className="pql-series">
            <div className="pql-series-label">{metricLabel(series.metric)}</div>
            <table className="pql-table">
              <thead>
                <tr><th>Time</th><th>Value</th></tr>
              </thead>
              <tbody>
                {(series.values || []).map(([ts, val], vi) => (
                  <tr key={vi}>
                    <td className="pql-cell-time">{formatTimestamp(ts)}</td>
                    <td className="pql-cell-value">{formatValue(val)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="pql-explorer">
      <style>{explorerStyles}</style>

      <div className="pql-header">
        <span className="pql-title">PromQL Explorer</span>
        <span className="pql-subtitle">Query Prometheus directly</span>
      </div>

      {/* Preset selector */}
      <div className="pql-presets-row">
        <select
          className="pql-preset-select"
          value=""
          onChange={(e) => { if (e.target.value) setQuery(e.target.value) }}
        >
          <option value="">Preset queries...</option>
          {PRESETS.map((p, i) => (
            <option key={i} value={p.query}>{p.label}</option>
          ))}
        </select>
      </div>

      {/* Query input */}
      <div className="pql-input-row">
        <input
          className="pql-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter PromQL query..."
          spellCheck={false}
        />
        <button className="pql-run-btn" onClick={runQuery} disabled={loading || !query.trim()}>
          {loading ? '...' : '▶ Run'}
        </button>
        <button className="pql-clear-btn" onClick={() => { setQuery(''); setResult(null); setError(null) }}>
          ↻
        </button>
      </div>

      {/* Mode + range controls */}
      <div className="pql-controls-row">
        <div className="pql-mode-toggle">
          <button
            className={`pql-mode-btn ${mode === 'instant' ? 'active' : ''}`}
            onClick={() => setMode('instant')}
          >Instant</button>
          <button
            className={`pql-mode-btn ${mode === 'range' ? 'active' : ''}`}
            onClick={() => setMode('range')}
          >Range</button>
        </div>
        {mode === 'range' && (
          <div className="pql-range-presets">
            {RANGE_PRESETS.map((rp) => (
              <button
                key={rp.seconds}
                className={`pql-range-btn ${rangeDuration === rp.seconds ? 'active' : ''}`}
                onClick={() => setRangeDuration(rp.seconds)}
              >{rp.label}</button>
            ))}
          </div>
        )}
      </div>

      {/* Query history */}
      {history.length > 0 && (
        <div className="pql-history">
          <span className="pql-history-label">Recent:</span>
          {history.map((h, i) => (
            <button key={i} className="pql-history-chip" onClick={() => setQuery(h)} title={h}>
              {h.length > 50 ? h.slice(0, 47) + '...' : h}
            </button>
          ))}
        </div>
      )}

      {/* Error */}
      {error && <div className="pql-error">Error: {error}</div>}

      {/* Results */}
      {result && (
        <div className="pql-results">
          <div className="pql-results-header">
            <span>Results ({resultType}, {result.length} series)</span>
          </div>
          <div className="pql-results-body">
            {resultType === 'matrix' ? renderMatrixTable() : renderVectorTable()}
          </div>
        </div>
      )}
    </div>
  )
}

const explorerStyles = `
.pql-explorer {
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 8px;
  padding: 20px;
  color: rgba(255,255,255,0.85);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
.pql-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 16px;
}
.pql-title {
  font-size: 18px;
  font-weight: 600;
  color: #e6522c;
}
.pql-subtitle {
  font-size: 13px;
  color: rgba(255,255,255,0.5);
}
.pql-presets-row {
  margin-bottom: 10px;
}
.pql-preset-select {
  background: #27272a;
  color: rgba(255,255,255,0.85);
  border: 1px solid #3f3f46;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 13px;
  width: 100%;
  cursor: pointer;
}
.pql-preset-select option {
  background: #27272a;
  color: rgba(255,255,255,0.85);
}
.pql-input-row {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.pql-input {
  flex: 1;
  background: #09090b;
  border: 1px solid #3f3f46;
  border-radius: 6px;
  padding: 8px 12px;
  color: rgba(255,255,255,0.9);
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 13px;
}
.pql-input:focus {
  outline: none;
  border-color: #e6522c;
}
.pql-run-btn {
  background: #e6522c;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.pql-run-btn:hover:not(:disabled) {
  background: #d4451f;
}
.pql-run-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pql-clear-btn {
  background: #27272a;
  color: rgba(255,255,255,0.7);
  border: 1px solid #3f3f46;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 15px;
  cursor: pointer;
}
.pql-clear-btn:hover {
  background: #3f3f46;
  color: rgba(255,255,255,0.9);
}
.pql-controls-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.pql-mode-toggle {
  display: flex;
  background: rgba(255,255,255,0.06);
  border: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
  border-radius: 10px;
  overflow: hidden;
}
.pql-mode-btn {
  background: transparent;
  color: rgba(255,255,255,0.75);
  border: none;
  padding: 5px 14px;
  font-size: 12px;
  cursor: pointer;
}
.pql-mode-btn.active {
  background: linear-gradient(145deg, rgba(168,85,247,0.1), rgba(56,189,248,0.04));
  color: #fff;
}
.pql-mode-btn:hover:not(.active) {
  background: rgba(255,255,255,0.08);
}
.pql-range-presets {
  display: flex;
  gap: 4px;
}
.pql-range-btn {
  background: #27272a;
  color: rgba(255,255,255,0.6);
  border: 1px solid #3f3f46;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.pql-range-btn.active {
  border-color: #e6522c;
  color: #e6522c;
}
.pql-range-btn:hover:not(.active) {
  background: #3f3f46;
}
.pql-history {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 14px;
}
.pql-history-label {
  font-size: 11px;
  color: rgba(255,255,255,0.4);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.pql-history-chip {
  background: #27272a;
  color: rgba(255,255,255,0.65);
  border: 1px solid #3f3f46;
  border-radius: 12px;
  padding: 3px 10px;
  font-size: 11px;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  cursor: pointer;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pql-history-chip:hover {
  border-color: #e6522c;
  color: rgba(255,255,255,0.85);
}
.pql-error {
  background: rgba(239,68,68,0.12);
  border: 1px solid rgba(239,68,68,0.3);
  border-radius: 6px;
  padding: 10px 14px;
  color: #f87171;
  font-size: 13px;
  margin-bottom: 12px;
}
.pql-results {
  border: 1px solid #27272a;
  border-radius: 6px;
  overflow: hidden;
}
.pql-results-header {
  background: #1f1f23;
  padding: 8px 14px;
  font-size: 12px;
  color: rgba(255,255,255,0.5);
  border-bottom: 1px solid #27272a;
}
.pql-results-body {
  max-height: 400px;
  overflow-y: auto;
  min-height: 0;
}
.pql-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.pql-table thead th {
  background: #1f1f23;
  padding: 8px 14px;
  text-align: left;
  font-weight: 500;
  color: rgba(255,255,255,0.5);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  position: sticky;
  top: 0;
}
.pql-table tbody tr {
  border-top: 1px solid #27272a;
}
.pql-table tbody tr:hover {
  background: rgba(230,82,44,0.06);
}
.pql-cell-metric {
  padding: 6px 14px;
  color: rgba(255,255,255,0.75);
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  word-break: break-all;
}
.pql-cell-value {
  padding: 6px 14px;
  color: #e6522c;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 13px;
  font-weight: 600;
  text-align: right;
  white-space: nowrap;
}
.pql-cell-time {
  padding: 6px 14px;
  color: rgba(255,255,255,0.5);
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  white-space: nowrap;
}
.pql-empty {
  padding: 24px;
  text-align: center;
  color: rgba(255,255,255,0.35);
  font-size: 13px;
}
.pql-series {
  margin-bottom: 2px;
}
.pql-series-label {
  background: #1f1f23;
  padding: 6px 14px;
  font-size: 12px;
  color: #e6522c;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  border-top: 1px solid #27272a;
}
.pql-matrix-wrap {
  max-height: 400px;
  overflow-y: auto;
  min-height: 0;
}
`

export default PromQLExplorer
