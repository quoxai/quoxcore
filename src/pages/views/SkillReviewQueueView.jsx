/**
 * SkillReviewQueueView — QSKL-SAFETY.F
 *
 * Minimal reviewer surface for the skill safety review queue.
 * Two-column layout: list panel (left) + detail panel (right).
 *
 * Per design system: composes only global qx-* classes. No bespoke CSS.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  listSkillReviewQueue,
  approveSkillReview,
  rejectSkillReview,
} from '../../services/quoxflowClient'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelative(iso) {
  if (!iso) return '—'
  try {
    const diffMs = Date.now() - new Date(iso).getTime()
    if (diffMs < 0) return new Date(iso).toLocaleDateString()
    const diffMin = Math.floor(diffMs / 60_000)
    if (diffMin < 2) return 'just now'
    const diffHr = Math.floor(diffMin / 60)
    if (diffHr < 24) return `${diffHr}h ago`
    const diffDay = Math.floor(diffHr / 24)
    if (diffDay < 60) return `${diffDay}d ago`
    return `${Math.floor(diffDay / 30)}mo ago`
  } catch { return '—' }
}

const RUBRIC_DIMS = [
  { key: 'clarity', label: 'Clarity' },
  { key: 'side_effects', label: 'Side Effects' },
  { key: 'capability_scope', label: 'Capability Scope' },
  { key: 'privacy', label: 'Privacy' },
  { key: 'prompt_injection_risk', label: 'Injection Risk' },
]

/** Worst rubric score across all dimensions */
function worstScore(rubric_scores) {
  if (!rubric_scores) return null
  const vals = RUBRIC_DIMS.map(d => rubric_scores[d.key]).filter(v => v != null)
  if (!vals.length) return null
  return Math.min(...vals)
}

function severityBadgeStyle(score) {
  if (score === null || score === undefined) return { background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.55)' }
  if (score >= 4) return { background: 'rgba(74,222,128,0.15)', color: 'rgba(134,239,172,1)' }
  if (score >= 3) return { background: 'rgba(251,191,36,0.15)', color: 'rgba(253,230,138,1)' }
  return { background: 'rgba(248,113,113,0.18)', color: 'rgba(254,202,202,1)' }
}

function scoreLabel(score) {
  if (score === null || score === undefined) return '—'
  if (score >= 4) return 'LOW'
  if (score >= 3) return 'MED'
  return 'HIGH'
}

function rubricBarStyle(score) {
  if (score === null || score === undefined) return { width: '0%', background: 'rgba(255,255,255,0.2)' }
  const pct = Math.min(100, Math.max(0, (score / 5) * 100))
  let color = 'rgba(74,222,128,0.8)'
  if (score < 4) color = 'rgba(251,191,36,0.8)'
  if (score < 3) color = 'rgba(248,113,113,0.8)'
  return { width: `${pct}%`, background: color }
}

// ─── Detail Panel ─────────────────────────────────────────────────────────────

function DetailPanel({ item, onDecide }) {
  const [comment, setComment] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [bodyExpanded, setBodyExpanded] = useState(false)

  // Reset comment when item changes
  useEffect(() => {
    setComment('')
    setError(null)
  }, [item?.id])

  if (!item) {
    return (
      <div className="qx-card" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>Select an item to review</p>
      </div>
    )
  }

  const rubric = item.rubric_scores || {}
  const isDecided = item.status !== 'pending'

  async function handleDecide(decision) {
    setLoading(true)
    setError(null)
    try {
      if (decision === 'approve') {
        await approveSkillReview(item.id, { comment })
      } else {
        await rejectSkillReview(item.id, { comment })
      }
      onDecide()
    } catch (err) {
      setError(err?.message || 'Failed to submit decision')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="qx-card qx-stack" style={{ flex: 1, minHeight: 0, overflowY: 'auto', gap: 16 }}>
      {/* Header */}
      <header className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="qx-stack" style={{ gap: 4 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{item.skill_name || item.skill_id}</h3>
          <div className="qx-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
              v{item.version}
            </span>
            {item.skill_author_id && (
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
                by {item.skill_author_id}
              </span>
            )}
            {item.skill_edition && (
              <span className="qx-pill" style={{ fontSize: 10 }}>{item.skill_edition}</span>
            )}
            {item.skill_created_at && (
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                created {formatRelative(item.skill_created_at)}
              </span>
            )}
          </div>
        </div>
        {isDecided && (
          <span
            className="qx-pill"
            style={item.status === 'approved'
              ? { background: 'rgba(74,222,128,0.15)', color: 'rgba(134,239,172,1)' }
              : { background: 'rgba(248,113,113,0.18)', color: 'rgba(254,202,202,1)' }}
          >
            {item.status}
          </span>
        )}
      </header>

      {/* Rubric Scores */}
      <section>
        <h4 style={{ margin: '0 0 10px', fontSize: 12, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Judge Scores
        </h4>
        <div className="qx-stack" style={{ gap: 8 }}>
          {RUBRIC_DIMS.map(({ key, label }) => {
            const score = rubric[key] ?? null
            return (
              <div key={key} className="qx-row" style={{ gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', minWidth: 130, flexShrink: 0 }}>
                  {label}
                </span>
                <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 3, transition: 'width 0.3s', ...rubricBarStyle(score) }} />
                </div>
                <span
                  style={{
                    fontSize: 11, minWidth: 28, textAlign: 'right',
                    color: score !== null ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.3)',
                  }}
                >
                  {score !== null ? score : '—'}
                </span>
              </div>
            )
          })}
        </div>
        {item.judge_run_id && (
          <p style={{ margin: '8px 0 0', fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
            Run: {item.judge_run_id}
          </p>
        )}
      </section>

      {/* Firewall Findings */}
      {Array.isArray(item.findings) && item.findings.length > 0 && (
        <section>
          <h4 style={{ margin: '0 0 10px', fontSize: 12, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Judge Findings ({item.findings.length})
          </h4>
          <div className="qx-stack" style={{ gap: 6 }}>
            {item.findings.map((f, i) => (
              <div key={i} className="qx-card qx-card--compact" style={{ padding: '8px 12px' }}>
                <div className="qx-row" style={{ gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 600 }}>{f.rule_id}</span>
                  <span
                    className="qx-pill"
                    style={{
                      fontSize: 10,
                      ...(f.severity === 'critical' || f.severity === 'high'
                        ? { background: 'rgba(248,113,113,0.18)', color: 'rgba(254,202,202,1)' }
                        : f.severity === 'medium'
                        ? { background: 'rgba(251,191,36,0.15)', color: 'rgba(253,230,138,1)' }
                        : { background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.55)' })
                    }}
                  >
                    {f.severity}
                  </span>
                  {f.line && (
                    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>line {f.line}</span>
                  )}
                </div>
                {f.snippet && (
                  <code style={{ fontSize: 11, color: 'rgba(255,200,100,0.85)', wordBreak: 'break-all' }}>
                    {f.snippet}
                  </code>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Latest Firewall Scan */}
      {item.latest_firewall_log && (
        <section>
          <h4 style={{ margin: '0 0 10px', fontSize: 12, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Latest Firewall Scan
          </h4>
          <div className="qx-card qx-card--compact" style={{ padding: '8px 12px' }}>
            <div className="qx-row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <span
                className="qx-pill"
                style={item.latest_firewall_log.allow
                  ? { background: 'rgba(74,222,128,0.15)', color: 'rgba(134,239,172,1)' }
                  : { background: 'rgba(248,113,113,0.18)', color: 'rgba(254,202,202,1)' }}
              >
                {item.latest_firewall_log.allow ? 'ALLOWED' : 'BLOCKED'}
              </span>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                {formatRelative(item.latest_firewall_log.scanned_at)}
              </span>
            </div>
            {Array.isArray(item.latest_firewall_log.findings) && item.latest_firewall_log.findings.map((f, i) => (
              <div key={i} style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 2 }}>
                {f.rule_id} — <span style={{ color: 'rgba(255,200,100,0.85)' }}>{f.snippet}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Skill Body Preview */}
      {item.skill_body_md_preview && (
        <section>
          <button
            type="button"
            className="qx-btn qx-btn--sm"
            onClick={() => setBodyExpanded(v => !v)}
            style={{ marginBottom: 8 }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 4, pointerEvents: 'none' }}>
              {bodyExpanded
                ? <><polyline points="18 15 12 9 6 15" /></>
                : <><polyline points="6 9 12 15 18 9" /></>}
            </svg>
            {bodyExpanded ? 'Collapse' : 'Show'} skill body
          </button>
          {bodyExpanded && (
            <pre style={{
              fontSize: 12, background: 'rgba(0,0,0,0.25)', borderRadius: 6,
              padding: 12, overflowX: 'auto', whiteSpace: 'pre-wrap',
              wordBreak: 'break-word', color: 'rgba(255,255,255,0.8)',
              maxHeight: 360, overflowY: 'auto',
            }}>
              {item.skill_body_md_preview}
            </pre>
          )}
        </section>
      )}

      {/* Decision */}
      {!isDecided && (
        <section>
          <h4 style={{ margin: '0 0 8px', fontSize: 12, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Decision
          </h4>
          {error && (
            <div className="qx-banner qx-banner--danger" style={{ marginBottom: 10, fontSize: 12 }}>
              {error}
            </div>
          )}
          <textarea
            className="qx-input"
            placeholder="Comment (optional)…"
            value={comment}
            onChange={e => setComment(e.target.value)}
            rows={3}
            style={{ width: '100%', resize: 'vertical', marginBottom: 10 }}
            aria-label="Review comment"
          />
          <div className="qx-row" style={{ gap: 10 }}>
            <button
              type="button"
              className="qx-btn qx-btn--primary qx-btn--sm"
              onClick={() => handleDecide('approve')}
              disabled={loading}
              aria-label="Approve skill"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 4, pointerEvents: 'none' }}>
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {loading ? 'Submitting…' : 'Approve'}
            </button>
            <button
              type="button"
              className="qx-btn qx-btn--sm"
              onClick={() => handleDecide('reject')}
              disabled={loading}
              style={{ borderColor: 'rgba(248,113,113,0.4)', color: 'rgba(254,202,202,0.9)' }}
              aria-label="Reject skill"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 4, pointerEvents: 'none' }}>
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              {loading ? 'Submitting…' : 'Reject'}
            </button>
          </div>
        </section>
      )}

      {/* Metadata footer */}
      <section style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 10 }}>
        <div className="qx-row" style={{ gap: 16, flexWrap: 'wrap' }}>
          {item.cost_usd != null && (
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
              Cost: ${item.cost_usd.toFixed(4)}
            </span>
          )}
          {item.tokens_in != null && (
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
              Tokens: {item.tokens_in + (item.tokens_out || 0)} ({item.tokens_in}in / {item.tokens_out || 0}out)
            </span>
          )}
          {item.queued_at && (
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
              Queued {formatRelative(item.queued_at)}
            </span>
          )}
        </div>
      </section>
    </div>
  )
}

// ─── Main View ────────────────────────────────────────────────────────────────

export default function SkillReviewQueueView() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)

  const selectedItem = items.find(i => i.id === selectedId) || null

  const load = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const data = await listSkillReviewQueue({ status: 'pending' })
      setItems(Array.isArray(data) ? data : [])
    } catch (err) {
      setFetchError(err?.message || 'Failed to load review queue')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function handleDecide() {
    // Clear selection + refresh list after approve/reject
    setSelectedId(null)
    load()
  }

  return (
    <div className="qx-view">
      <div className="qx-stack">

        {/* ── Header ── */}
        <section className="qx-card">
          <header className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="qx-stack" style={{ gap: 4 }}>
              <h2 style={{ margin: 0 }}>Skill Review Queue</h2>
              <p style={{ margin: 0, color: 'rgba(255,255,255,0.7)' }}>
                Safety review: approve or reject skills flagged by the judge.
              </p>
            </div>
            <div className="qx-row" style={{ gap: 10, alignItems: 'center' }}>
              <span className="qx-badge">{items.length} pending</span>
              <button
                type="button"
                className="qx-btn qx-btn--sm"
                onClick={load}
                disabled={loading}
                aria-label="Refresh queue"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: 'middle', pointerEvents: 'none' }}>
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </button>
            </div>
          </header>
        </section>

        {/* ── Main two-column layout ── */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>

          {/* Left: list panel */}
          <div style={{ width: 320, flexShrink: 0 }}>
            {loading && (
              <div className="qx-card" style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
                <span className="qx-spinner" />
              </div>
            )}
            {!loading && fetchError && (
              <div className="qx-banner qx-banner--danger">{fetchError}</div>
            )}
            {!loading && !fetchError && items.length === 0 && (
              <div className="qx-card" style={{ textAlign: 'center', padding: 32 }}>
                <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13, margin: 0 }}>
                  No pending items
                </p>
              </div>
            )}
            {!loading && items.map(item => {
              const worst = worstScore(item.rubric_scores)
              const isSelected = item.id === selectedId
              return (
                <div
                  key={item.id}
                  className="qx-card qx-card--compact"
                  role="button"
                  tabIndex={0}
                  data-testid="queue-item"
                  onClick={() => setSelectedId(item.id)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setSelectedId(item.id) }}
                  style={{
                    marginBottom: 8, cursor: 'pointer',
                    outline: isSelected ? '2px solid rgba(99,179,237,0.6)' : 'none',
                    borderColor: isSelected ? 'rgba(99,179,237,0.4)' : undefined,
                  }}
                >
                  <div className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div className="qx-stack" style={{ gap: 3, flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.skill_name || item.skill_id}
                      </span>
                      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                        v{item.version} · {formatRelative(item.queued_at)}
                      </span>
                    </div>
                    <span
                      className="qx-pill"
                      style={{ fontSize: 10, flexShrink: 0, ...severityBadgeStyle(worst) }}
                    >
                      {scoreLabel(worst)}
                    </span>
                  </div>
                  {!isSelected && (
                    <div style={{ marginTop: 8, textAlign: 'right' }}>
                      <button
                        type="button"
                        className="qx-btn qx-btn--sm"
                        onClick={e => { e.stopPropagation(); setSelectedId(item.id) }}
                        style={{ fontSize: 11 }}
                      >
                        Review
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Right: detail panel */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <DetailPanel item={selectedItem} onDecide={handleDecide} />
          </div>
        </div>

      </div>
    </div>
  )
}
