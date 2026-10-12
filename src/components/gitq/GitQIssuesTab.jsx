import { useEffect, useRef, useState, useCallback } from 'react'
import * as githubClient from '../../services/githubClient'
import { buildVulcanSeedFromIssue, issueLabel } from './sendToVulcan'

/**
 * GitQ Issues tab: lists open (or closed) issues across the repos configured
 * in the GitHub plugin, and lets the human hand any one of them to Vulcan for
 * triage. Reads through the SERVICE (githubClient.js), never through the
 * stripped GitHubPanel/GitHubView components.
 */
export default function GitQIssuesTab({ accent = '#a855f7', onSendToVulcan }) {
  const [issues, setIssues] = useState([])
  const [state, setState] = useState('open')
  const [filterText, setFilterText] = useState('')
  const [loading, setLoading] = useState(true)
  const [notConfigured, setNotConfigured] = useState(false)
  const [error, setError] = useState(null)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    setError(null)
    setNotConfigured(false)
    try {
      const config = githubClient.getConfig()
      if (!config?.selectedRepos?.length) {
        setNotConfigured(true)
        setIssues([])
        return
      }
      const result = await githubClient.fetchIssues({ state })
      setIssues(Array.isArray(result) ? result : [])
    } catch (err) {
      const msg = err?.message || String(err)
      if (msg.includes('No repos configured') || msg.includes('401')) {
        setNotConfigured(true)
        setIssues([])
      } else {
        setError(msg)
      }
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [state])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (cancelled) return
      await load()
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  const filtered = issues.filter(issue => {
    if (!filterText.trim()) return true
    const needle = filterText.trim().toLowerCase()
    const title = (issue.title || '').toLowerCase()
    const repo = (issue.repo || issue.repository?.full_name || '').toLowerCase()
    return title.includes(needle) || repo.includes(needle)
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="qx-row qx-row--apart" style={{ marginBottom: 12, flexShrink: 0 }}>
        <div className="qx-row qx-row--tight" style={{ flex: 1 }}>
          <input
            className="qx-input qx-input--grow"
            type="text"
            placeholder="Filter by title or repo..."
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
          />
          <div className="qx-seg">
            <button
              type="button"
              className={`qx-seg__btn ${state === 'open' ? 'qx-seg__btn--active' : ''}`}
              onClick={() => setState('open')}
            >
              Open
            </button>
            <button
              type="button"
              className={`qx-seg__btn ${state === 'closed' ? 'qx-seg__btn--active' : ''}`}
              onClick={() => setState('closed')}
            >
              Closed
            </button>
          </div>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={load} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {loading && (
          <div className="qx-row qx-row--center" style={{ padding: '32px 0' }}>
            <div className="qx-spinner" />
            <span style={{ marginLeft: 12 }}>Loading issues...</span>
          </div>
        )}

        {!loading && notConfigured && (
          <div className="qx-empty">
            <div className="qx-empty__title">Connect GitQ to see issues</div>
            <div className="qx-empty__body">
              GitQ needs a provider connected and repos selected before it can list issues.
              Ask the GitQ concierge to connect your provider.
            </div>
          </div>
        )}

        {!loading && !notConfigured && error && (
          <div className="qx-banner qx-banner--error">{error}</div>
        )}

        {!loading && !notConfigured && !error && filtered.length === 0 && (
          <div className="qx-empty">
            <div className="qx-empty__title">No {state} issues</div>
          </div>
        )}

        {!loading && !notConfigured && !error && filtered.length > 0 && (
          <div className="qx-stack qx-stack--compact">
            {filtered.map(issue => (
              <div key={`${issueLabel(issue)}-${issue.number}`} className="qx-card qx-card--compact">
                <div className="qx-row qx-row--apart">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="qx-hint qx-hint--sm">{issueLabel(issue)}</div>
                    <a
                      href={issue.html_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#fff', fontWeight: 600, textDecoration: 'none' }}
                    >
                      {issue.title || '(no title)'}
                    </a>
                    {Array.isArray(issue.labels) && issue.labels.length > 0 && (
                      <div className="qx-row qx-row--tight" style={{ marginTop: 6 }}>
                        {issue.labels.slice(0, 3).map(l => {
                          const name = typeof l === 'string' ? l : l?.name
                          return name ? (
                            <span key={name} className="qx-pill qx-pill--xs qx-pill--ghost">
                              {name}
                            </span>
                          ) : null
                        })}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="qx-btn qx-btn--sm qx-btn--tint"
                    style={{ '--qx-btn-tint': accent }}
                    onClick={() => onSendToVulcan?.(buildVulcanSeedFromIssue(issue))}
                  >
                    Send to Vulcan
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
