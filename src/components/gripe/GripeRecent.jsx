import { useCallback, useEffect, useRef, useState } from 'react'
import * as githubClient from '../../services/githubClient'
import { FLEET_LABELS } from './gripeInference'
import { buildVulcanSeedFromIssue, issueLabel } from '../gitq/sendToVulcan'

const MAX_ROWS = 20

/**
 * Merge several per-label issue lists into one recent list: de-duplicated by
 * repo + number, newest first, capped. Pure so it can be tested.
 */
export function mergeRecent(lists, max = MAX_ROWS) {
  const seen = new Map()
  for (const list of lists) {
    for (const i of list || []) {
      const key = `${i.repo || i._repo || ''}#${i.number}`
      if (!seen.has(key)) seen.set(key, i)
    }
  }
  return [...seen.values()]
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, max)
}

/**
 * Recent fleet-labelled issues across the connected repos. The proxy exposes no
 * body search, so this lists issues carrying a fleet/* label (what Gripe applies),
 * which includes gripes filed by the CLI, chat agent and this page.
 */
export default function GripeRecent({ refreshKey = 0, onSendToVulcan }) {
  const [issues, setIssues] = useState([])
  const [loading, setLoading] = useState(true)
  const [notConfigured, setNotConfigured] = useState(false)
  const [error, setError] = useState(null)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true); setError(null); setNotConfigured(false)
    try {
      const config = githubClient.getConfig()
      if (!config?.selectedRepos?.length) { setNotConfigured(true); setIssues([]); return }
      const org = config.orgName
      const lists = await Promise.all(
        FLEET_LABELS.map((labels) => githubClient.fetchIssues({ state: 'all', labels, per_page: MAX_ROWS })),
      )
      const normalised = lists.map((l) => (Array.isArray(l) ? l : []).map((i) => ({
        ...i,
        repo: i.repo || (i._repo ? `${org}/${i._repo}` : undefined),
        html_url: i.html_url || i.url,
      })))
      setIssues(mergeRecent(normalised))
    } catch (err) {
      const msg = err?.message || String(err)
      if (msg.includes('No repos configured')) { setNotConfigured(true); setIssues([]) } else setError(msg)
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load, refreshKey])

  return (
    <div className="qx-stack qx-stack--compact">
      <div className="qx-row qx-row--apart">
        <span className="qx-section-title">Recent gripes</span>
        <button type="button" className="glass-btn" onClick={load} disabled={loading}>Refresh</button>
      </div>

      {loading && <div className="qx-row"><div className="qx-spinner" /><span>Loading issues...</span></div>}
      {!loading && notConfigured && (
        <div className="qx-empty">
          <div className="qx-empty__title">Connect GitQ to see recent gripes</div>
          <div className="qx-empty__body">A GitHub connector with repos selected is needed to list issues.</div>
        </div>
      )}
      {!loading && !notConfigured && error && <div className="qx-banner qx-banner--error">{error}</div>}
      {!loading && !notConfigured && !error && issues.length === 0 && (
        <div className="qx-empty"><div className="qx-empty__title">No fleet-labelled issues yet</div></div>
      )}
      {!loading && !notConfigured && !error && issues.map((issue) => (
        <div key={`${issueLabel(issue)}`} className="qx-card qx-card--compact">
          <div className="qx-row qx-row--apart">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="qx-hint qx-hint--sm">{issueLabel(issue)}</div>
              <a href={issue.html_url} target="_blank" rel="noopener noreferrer">{issue.title || '(no title)'}</a>
            </div>
            <div className="qx-row qx-row--tight">
              <span className="qx-pill">{issue.state}</span>
              {onSendToVulcan && (
                <button
                  type="button"
                  className="glass-btn"
                  onClick={() => onSendToVulcan(buildVulcanSeedFromIssue(issue))}
                >
                  Send to Vulcan
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
