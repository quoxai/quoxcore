/**
 * XEngagementPanel — recent post engagement for the connected account.
 * X-PLUGIN P5.
 *
 * Reads via xClient.getUserTweets (twitter connector's get_user_tweets tool,
 * a paid X API read — see connectors/types/twitter.js's cost comment). Cost
 * honesty rules for this panel, non-negotiable:
 *   - NO fetch on mount, NO polling, NO setInterval/setTimeout. A browser
 *     timer is not a background job (house rule) and a paid-per-read API is
 *     the worst possible place to auto-poll.
 *   - Exactly one fetch per explicit user click on the Refresh button below,
 *     and the button's own label states the cost before the click happens.
 *   - Every terminal state (empty / error / budget-exceeded / 401) renders
 *     as its own honest message — never a bare spinner or a silently empty
 *     table when the real story is "the read failed".
 */

import { useState, useCallback } from 'react'
import { getUserTweets } from '../../services/xClient'

const MAX_TWEETS = 10
// A refresh calls get_user_tweets exactly once; the connector charges a single
// budget read per call regardless of how many posts come back (chargeRead in
// connectors/types/twitter.js), so one refresh is one read at about $0.005,
// not one read per post returned.
const COST_PER_REFRESH_USD = '$0.005'

function classifyError(message) {
  const m = (message || '').toLowerCase()
  if (m.includes('budget exhausted') || m.includes('budget')) return 'budget'
  if (m.includes('401') || m.includes('expired or invalid') || m.includes('re-authenticate')) return 'auth'
  return 'generic'
}

function fmtNum(n) {
  if (n === null || n === undefined) return '—'
  return Intl.NumberFormat('en-US', { notation: 'compact' }).format(n)
}

function fmtTime(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

/** Lightweight inline sparkline for a single metric across the loaded posts,
 * matching the bar-sparkline pattern used elsewhere (.qx-spark, TriggersView
 * CostsTab). Renders nothing (not a zeroed chart) when there is no metric
 * data to plot — an empty bar row would assert a false zero. */
function EngagementSpark({ values }) {
  const vals = (values || []).filter((v) => typeof v === 'number')
  if (vals.length < 2) return null
  const max = Math.max(...vals, 1)
  return (
    <span className="qx-spark" aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 20 }}>
      {vals.map((v, i) => (
        <span
          key={i}
          style={{
            display: 'inline-block',
            width: 4,
            height: `${Math.max(2, Math.round((v / max) * 18))}px`,
            background: 'var(--m-accent-cyan, #4ecdc4)',
            borderRadius: 1,
            opacity: 0.75,
          }}
        />
      ))}
    </span>
  )
}

export default function XEngagementPanel({ authFetch }) {
  const [tweets, setTweets] = useState(null) // null = never loaded this session
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null) // { kind, message }

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const out = await getUserTweets(authFetch, { maxResults: MAX_TWEETS })
      if (out?.success === false) {
        setError({ kind: classifyError(out.error), message: out.error || 'Read failed' })
        setTweets(null)
        return
      }
      setTweets(Array.isArray(out?.tweets) ? out.tweets : [])
    } catch (e) {
      setError({ kind: classifyError(e.message), message: e.message })
      setTweets(null)
    } finally {
      setLoading(false)
    }
  }, [authFetch])

  const impressionsSpark = tweets ? tweets.map((t) => t.public_metrics?.impression_count).filter((v) => typeof v === 'number') : []

  return (
    <section className="qx-card">
      <div className="qx-stack">
        <div className="qx-row qx-row--apart">
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Engagement</h3>
          <button type="button" className="qx-btn xs-btn qx-btn--sm" onClick={refresh} disabled={loading}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <p className="qx-hint qx-hint--sm">
          Each refresh is one API call, costing about {COST_PER_REFRESH_USD}, and returns up to {MAX_TWEETS} posts.
          This panel never refreshes on its own; only this button spends credits.
        </p>

        {error && error.kind === 'budget' && (
          <div className="qx-banner qx-banner--error">
            Read budget exhausted for today. {error.message}
          </div>
        )}
        {error && error.kind === 'auth' && (
          <div className="qx-banner qx-banner--error">
            X credentials are expired or invalid (401). Re-connect the account in Account health before retrying.
          </div>
        )}
        {error && error.kind === 'generic' && (
          <div className="qx-banner qx-banner--error">{error.message}</div>
        )}

        {loading && tweets === null && !error ? (
          <div className="qx-skeleton qx-skeleton--block" />
        ) : tweets === null && !error ? (
          <div className="qx-empty">
            <div className="qx-empty__title">Not loaded yet</div>
            <div className="qx-empty__body">
              Engagement data costs a real read credit, so it is never fetched automatically.
              Click Refresh above to spend {COST_PER_REFRESH_USD} on one API call and see up to {MAX_TWEETS} posts.
            </div>
          </div>
        ) : tweets && tweets.length === 0 ? (
          <div className="qx-empty">
            <div className="qx-empty__title">No posts found</div>
            <div className="qx-empty__body">The connected account has no recent posts to show.</div>
          </div>
        ) : tweets && tweets.length > 0 ? (
          <div className="qx-stack qx-stack--tight">
            <div className="qx-row qx-row--apart">
              <span className="qx-section-title xs-title">Last {tweets.length} posts</span>
              <EngagementSpark values={impressionsSpark} />
            </div>
            <table className="qx-table">
              <thead>
                <tr>
                  <th>Post</th>
                  <th>Posted</th>
                  <th>Impressions</th>
                  <th>Likes</th>
                  <th>Replies</th>
                  <th>Reposts</th>
                </tr>
              </thead>
              <tbody>
                {tweets.map((t) => {
                  const m = t.public_metrics || null
                  return (
                    <tr key={t.id}>
                      <td>
                        <a href={`https://x.com/i/status/${t.id}`} target="_blank" rel="noopener noreferrer" className="qx-chip qx-chip--xs" title={t.text}>
                          {(t.text || '').slice(0, 60) || t.id}{(t.text || '').length > 60 ? '…' : ''}
                        </a>
                      </td>
                      <td>{fmtTime(t.created_at)}</td>
                      <td>{m && m.impression_count !== undefined ? fmtNum(m.impression_count) : '—'}</td>
                      <td>{m ? fmtNum(m.like_count) : '—'}</td>
                      <td>{m ? fmtNum(m.reply_count) : '—'}</td>
                      <td>{m ? fmtNum(m.retweet_count) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {tweets.some((t) => !t.public_metrics) && (
              <p className="qx-hint qx-hint--sm">
                Some posts did not return metrics from the X API, shown as a dash rather than a false zero.
              </p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  )
}
