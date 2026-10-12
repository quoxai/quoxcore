/**
 * XActivityPanel, recent claims + published ledger. X-PLUGIN P3/P11.
 *
 * Data comes from GET /x/activity (org-scoped, server-side x_post_claims +
 * x_post_ledger tables). Global .qx-* classes only.
 *
 * Text and author are optional fields on a claim row (`claim.text`,
 * `claim.author`). When the server has not supplied them we render an
 * honest placeholder rather than guessing what was posted or who drafted it.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'

const STATUS_PILL = {
  pending: 'qx-pill--medium',
  posted: 'qx-pill--success',
  failed: 'qx-pill--danger',
}

function statusPill(status) {
  return `qx-pill qx-pill--sm ${STATUS_PILL[status] || 'qx-pill--ghost'}`
}

function fmtTime(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function truncateText(text, max) {
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const CSV_COLUMNS = [
  'inbox_item_id',
  'tweet_ids',
  'action',
  'status',
  'posts_reserved',
  'claimed_at',
  'author',
  'text',
]

function claimToRow(c) {
  return {
    inbox_item_id: c.inbox_item_id ?? '',
    tweet_ids: c.tweet_ids && c.tweet_ids.length > 0 ? c.tweet_ids.join('; ') : '',
    action: c.action ?? '',
    status: c.status ?? '',
    posts_reserved: c.posts_reserved ?? '',
    claimed_at: c.claimed_at ?? '',
    author: c.author || 'unknown',
    text: c.text || '',
  }
}

/** Quote every field and double any embedded quote, so a tweet containing a
 * comma or a newline cannot break the column count. */
function csvField(value) {
  const s = String(value ?? '')
  return `"${s.replace(/"/g, '""')}"`
}

/** Exported for direct unit testing of CSV correctness (comma/newline/quote
 * escaping) without needing to simulate a real file download in jsdom. */
export function claimsToCsv(claims) {
  const rows = claims.map(claimToRow)
  const lines = [CSV_COLUMNS.map(csvField).join(',')]
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((col) => csvField(row[col])).join(','))
  }
  return lines.join('\r\n')
}

export function claimsToJson(claims) {
  return JSON.stringify(claims.map(claimToRow), null, 2)
}

function downloadBlob(content, mimeType, filename) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10)
}

export default function XActivityPanel({ claims = [], ledger = [], loading = false }) {
  const [expanded, setExpanded] = useState(() => new Set())

  function toggleExpanded(id) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function exportCsv() {
    downloadBlob(claimsToCsv(claims), 'text/csv;charset=utf-8', `x-activity-${todayStamp()}.csv`)
  }

  function exportJson() {
    downloadBlob(claimsToJson(claims), 'application/json', `x-activity-${todayStamp()}.json`)
  }

  return (
    <section className="qx-card">
      <div className="qx-stack">
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Activity</h3>

        <div>
          <div className="qx-row qx-row--apart">
            <span className="qx-section-title xs-title">Approval claims</span>
            <div className="qx-row qx-row--tight">
              <button type="button" className="qx-btn xs-btn qx-btn--sm" onClick={exportCsv} disabled={claims.length === 0}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 3v12" /><polyline points="7 10 12 15 17 10" /><path d="M4 21h16" /></svg>
                Export CSV
              </button>
              <button type="button" className="qx-btn xs-btn qx-btn--sm" onClick={exportJson} disabled={claims.length === 0}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 3v12" /><polyline points="7 10 12 15 17 10" /><path d="M4 21h16" /></svg>
                Export JSON
              </button>
            </div>
          </div>
          {loading && claims.length === 0 ? (
            <div className="qx-skeleton qx-skeleton--block" />
          ) : claims.length === 0 ? (
            <div className="qx-empty">
              <div className="qx-empty__title">No drafts yet</div>
              <div className="qx-empty__body">Compose a post and it will appear here awaiting approval.</div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              {/* The text column collapsed to about 90px inside the fixed panel
                  width, turning every row into a tall paragraph. Give the table
                  a minimum width and let this container scroll sideways
                  instead, so a wide table stays readable without the page
                  itself scrolling. */}
            <table className="qx-table" style={{ minWidth: 980 }}>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Status</th>
                  <th>Posts</th>
                  <th>Tweets</th>
                  <th>Text</th>
                  <th>Author</th>
                  <th>Claimed</th>
                  <th>Inbox</th>
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => {
                  const isExpanded = expanded.has(c.inbox_item_id)
                  const hasText = Boolean(c.text)
                  const long = hasText && c.text.length > 80
                  return (
                    <tr key={c.inbox_item_id}>
                      <td><code className="qx-code">{c.action}</code></td>
                      <td>
                        <span className={statusPill(c.status)}>{c.status}</span>
                        {c.error && <span className="qx-hint qx-hint--sm qx-hint--danger"> {c.error}</span>}
                      </td>
                      <td>{c.posts_reserved}</td>
                      <td>
                        {c.tweet_ids && c.tweet_ids.length > 0
                          ? c.tweet_ids.map((id) => (
                            <a key={id} href={`https://x.com/i/status/${id}`} target="_blank" rel="noopener noreferrer" className="qx-chip qx-chip--xs">
                              {id}
                            </a>
                          ))
                          : '—'}
                      </td>
                      <td style={{ minWidth: 280, maxWidth: 380 }}>
                        {hasText ? (
                          <span className="qx-row qx-row--tight qx-row--wrap">
                            <span title={c.text}>{isExpanded ? c.text : truncateText(c.text, 80)}</span>
                            {long && (
                              <button type="button" className="qx-btn xs-btn qx-btn--sm" onClick={() => toggleExpanded(c.inbox_item_id)}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                                  {isExpanded ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}
                                </svg>
                                {isExpanded ? 'Less' : 'More'}
                              </button>
                            )}
                          </span>
                        ) : (
                          <span className="qx-hint qx-hint--sm">No text recorded</span>
                        )}
                      </td>
                      <td>{c.author || 'unknown'}</td>
                      <td>{fmtTime(c.claimed_at)}</td>
                      <td>
                        <Link to={`/inbox/${c.inbox_item_id}`} className="qx-btn xs-btn qx-btn--sm">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
                          Open
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>

        <div>
          <span className="qx-section-title xs-title">Published (ledger)</span>
          {ledger.length === 0 ? (
            <p className="qx-hint qx-hint--sm">Nothing published yet.</p>
          ) : (
            <table className="qx-table">
              <thead>
                <tr>
                  <th>Tweet</th>
                  <th>Kind</th>
                  <th>Posted</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.tweet_id ? (
                        <a href={`https://x.com/i/status/${row.tweet_id}`} target="_blank" rel="noopener noreferrer" className="qx-chip qx-chip--xs">
                          {row.tweet_id}
                        </a>
                      ) : '—'}
                    </td>
                    <td><code className="qx-code">{row.kind}</code></td>
                    <td>{fmtTime(row.posted_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  )
}
