/**
 * JobsPanel — Shows recent QuoxAgent job executions.
 *
 * Fetches from /mha-agent/api/v1/jobs with 10s polling.
 * Each job shows name, type, status, duration, host.
 * Click to expand and see stdout/stderr output.
 */

import { useState, useEffect, useCallback, memo } from 'react'

const MHA_BASE = `${window.location.origin}/mha-agent`

const STATUS_COLORS = {
  pending: '#f59e0b',
  running: '#22c55e',
  completed: '#6b7280',
  failed: '#ef4444',
}

const TYPE_LABELS = {
  exec: 'Command',
  script: 'Script',
  tool: 'Tool',
}

function formatDuration(ms) {
  if (!ms) return 'N/A'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const JobRow = memo(function JobRow({ job, isExpanded, onToggle }) {
  const status = job.status || job.state || 'unknown'
  const statusColor = STATUS_COLORS[status] || '#6b7280'
  const typeLabel = TYPE_LABELS[job.type] || job.type || 'unknown'

  return (
    <div className="jp-job">
      <button className="jp-job__row" onClick={onToggle}>
        <span className="jp-job__status" style={{ color: statusColor }}>
          {status === 'running' && <span className="jp-job__pulse" style={{ background: statusColor }} />}
          {status}
        </span>
        <span className="jp-job__name">{job.name || job.command || 'Unnamed job'}</span>
        <span className="jp-job__type">{typeLabel}</span>
        <span className="jp-job__time">{formatTime(job.received_at || job.started_at)}</span>
        {job.duration_ms != null && (
          <span className="jp-job__duration">{formatDuration(job.duration_ms)}</span>
        )}
      </button>
      {isExpanded && job.result && (
        <div className="jp-job__output">
          {job.result.stdout && (
            <pre className="jp-job__stdout">{job.result.stdout}</pre>
          )}
          {job.result.stderr && (
            <pre className="jp-job__stderr">{job.result.stderr}</pre>
          )}
          {job.result.exit_code != null && (
            <span className="jp-job__exit">Exit code: {job.result.exit_code}</span>
          )}
          {!job.result.stdout && !job.result.stderr && (
            <span className="jp-job__no-output">No output captured</span>
          )}
        </div>
      )}
    </div>
  )
})

export default function JobsPanel() {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState(null)

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(`${MHA_BASE}/api/v1/jobs`)
      if (res.ok) {
        const data = await res.json()
        setJobs(data.jobs || [])
      }
    } catch {
      // Agent may not be running
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchJobs()
    const interval = setInterval(fetchJobs, 10000)
    return () => clearInterval(interval)
  }, [fetchJobs])

  const toggleExpand = useCallback((jobId) => {
    setExpandedId(prev => prev === jobId ? null : jobId)
  }, [])

  return (
    <div className="jp-panel">
      <div className="jp-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2">
          <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/>
          <circle cx="6" cy="6" r="1"/><circle cx="6" cy="18" r="1"/>
        </svg>
        <span className="jp-header__title">Jobs</span>
        {jobs.length > 0 && (
          <span className="jp-header__count">{jobs.length}</span>
        )}
      </div>

      <div className="jp-body">
        {loading && <div className="jp-empty">Loading jobs...</div>}
        {!loading && jobs.length === 0 && (
          <div className="jp-empty">
            No recent jobs. Use the chat to submit commands to agents.
          </div>
        )}
        {jobs.map(job => (
          <JobRow
            key={job.id}
            job={job}
            isExpanded={expandedId === job.id}
            onToggle={() => toggleExpand(job.id)}
          />
        ))}
      </div>
    </div>
  )
}
