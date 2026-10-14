/**
 * AnalyticsTab: Widget performance dashboard
 *
 * QCX-5j additions:
 *   - Range selector (7d / 30d / 90d / all)
 *   - Period-over-period compare (delta % vs previous equally-long window)
 *   - CSV export of the current stats snapshot
 *
 * Earlier phases: top-questions, source utilisation, response-time
 * distribution.
 *
 * Wave 5 (QUOXCHAT-BRUTALOOP): the stat cards come from the server-side
 * GET .../analytics/summary (whole range, not page 1 of /conversations).
 * The old "Resolved" card is gone (nothing ever sets a conversation to
 * resolved) and "Knowledge coverage" (a chunk-count formula) is replaced by
 * "Answer quality", computed from each answer's stored grounding verdict,
 * plus an honest "Knowledge size" line and an Unanswered feed.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { computeStats } from '../../../../widget/analyticsUtils'
import {
  dateRangeFor,
  shiftRangeBack,
  computePctChange,
  serializeStatsCsv,
  ratioDisplay,
  countRatedConversations,
  filterInterrogatives,
  statsFromSummary,
  answerQualityDisplay,
  UNANSWERED_REASON_LABELS,
} from './analyticsTabUtils'

const RANGE_OPTIONS = [
  { id: '7d',  label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
  { id: 'all', label: 'All time' },
]

function StatCard({ label, value, color, subtitle, delta }) {
  const deltaSign = delta != null && delta !== 0
    ? (delta > 0 ? 'pos' : 'neg')
    : 'flat'
  return (
    <div className="qx-flat-panel" style={{ padding: 14, flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.65)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <div style={{ fontSize: value === 'unavailable' ? 14 : 24, fontWeight: 800, color: value === 'unavailable' ? '#fca5a5' : (color || '#fff'), fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        {delta != null && (
          <span
            data-delta={deltaSign}
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: delta > 0 ? '#86efac' : delta < 0 ? '#fca5a5' : 'rgba(255,255,255,0.5)',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {delta > 0 ? '+' : ''}{delta}%
          </span>
        )}
      </div>
      {subtitle && <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.65)', marginTop: 2 }}>{subtitle}</div>}
    </div>
  )
}

function withRange(url, range) {
  if (!range || (!range.from && !range.to)) return url
  const sep = url.includes('?') ? '&' : '?'
  const params = []
  if (range.from) params.push(`from=${encodeURIComponent(range.from)}`)
  if (range.to)   params.push(`to=${encodeURIComponent(range.to)}`)
  return params.length ? `${url}${sep}${params.join('&')}` : url
}

export default function AnalyticsTab({ widget, authFetch, orgId }) {
  const [rangeId, setRangeId] = useState('30d')
  const [conversations, setConversations] = useState([])
  const [prevConversations, setPrevConversations] = useState([])
  const [summary, setSummary] = useState(null)
  const [prevSummary, setPrevSummary] = useState(null)
  const [unanswered, setUnanswered] = useState([])
  const [corrected, setCorrected] = useState([])
  const [leads, setLeads] = useState([])
  const [knowledge, setKnowledge] = useState({ totalChunks: 0, totalSources: 0, qaCount: 0 })
  const [topQuestions, setTopQuestions] = useState([])
  const [sourceUtilisation, setSourceUtilisation] = useState([])
  const [responseTimes, setResponseTimes] = useState(null)
  const [usage, setUsage] = useState(null)
  const [loading, setLoading] = useState(false)
  // W12: a failed fetch is 'unavailable', never a fabricated 0.
  const [failed, setFailed] = useState({})
  const [reloadTick, setReloadTick] = useState(0)
  const [loadedOnce, setLoadedOnce] = useState(false)

  const range = useMemo(() => dateRangeFor(rangeId), [rangeId])
  const prevRange = useMemo(() => shiftRangeBack(range), [range])

  useEffect(() => {
    if (!authFetch || !orgId || !widget?.id) return
    let cancelled = false
    setLoading(true)
    const base = `/api/orgs/${orgId}/widgets/${widget.id}`
    const FAIL = Symbol('fail')
    const j = (r) => (r.ok ? r.json() : FAIL)
    Promise.all([
      authFetch(withRange(`${base}/conversations`, range)).then(j).catch(() => FAIL),
      authFetch(`${base}/knowledge/stats`).then(j).catch(() => FAIL),
      authFetch(withRange(`${base}/analytics/top-questions?limit=10`, range)).then(j).catch(() => FAIL),
      authFetch(withRange(`${base}/analytics/source-utilisation`, range)).then(j).catch(() => FAIL),
      authFetch(withRange(`${base}/analytics/response-times`, range)).then(j).catch(() => FAIL),
      // QCL-BACKEND-UX #131: usage-vs-cap burn panel. Org-scoped endpoint;
      // never calls the collector or internal endpoint from the browser.
      // Caught like every other call here so a failed/empty fetch degrades
      // to "no burn panel" rather than crashing the tab.
      authFetch(`${base}/usage/current`).then(j).catch(() => FAIL),
      // QCX-5j: previous equally-long window for compare-to-previous deltas.
      // Skipped when 'all time' is selected; there's no previous window.
      prevRange.from
        ? authFetch(withRange(`${base}/conversations`, prevRange)).then(j).catch(() => FAIL)
        : Promise.resolve(null),
      authFetch(withRange(`${base}/analytics/summary`, range)).then(j).catch(() => FAIL),
      prevRange.from
        ? authFetch(withRange(`${base}/analytics/summary`, prevRange)).then(j).catch(() => FAIL)
        : Promise.resolve(null),
      authFetch(withRange(`${base}/analytics/unanswered?limit=20`, range)).then(j).catch(() => FAIL),
      authFetch(`${base}/leads?limit=50`).then(j).catch(() => FAIL),
    ]).then((res) => {
      if (cancelled) return
      const names = ['conversations', 'knowledge', 'topQuestions', 'sourceUtilisation', 'responseTimes', 'usage', 'prevConversations', 'summary', 'prevSummary', 'unanswered', 'leads']
      const nextFailed = {}
      names.forEach((n, i) => { if (res[i] === FAIL) nextFailed[n] = true })
      setFailed(nextFailed)
      setLoadedOnce(true)
      const [convData, statsData, topQ, srcU, rt, usageData, prevConv, sum, prevSum, unans, leadData] = res.map(v => (v === FAIL ? null : v))
      setSummary(sum && typeof sum === 'object' && typeof sum.total_conversations === 'number' ? sum : null)
      setPrevSummary(prevSum && typeof prevSum === 'object' && typeof prevSum.total_conversations === 'number' ? prevSum : null)
      setUnanswered(Array.isArray(unans?.items) ? unans.items : [])
      setCorrected(Array.isArray(unans?.corrected) ? unans.corrected : [])
      setLeads(Array.isArray(leadData?.items) ? leadData.items : Array.isArray(leadData?.data) ? leadData.data : [])
      const rows = Array.isArray(convData?.items) ? convData.items : Array.isArray(convData?.data) ? convData.data : Array.isArray(convData) ? convData : []
      setConversations(rows)
      const prevRows = Array.isArray(prevConv?.items) ? prevConv.items : Array.isArray(prevConv?.data) ? prevConv.data : Array.isArray(prevConv) ? prevConv : []
      setPrevConversations(prevRows)
      if (statsData) {
        setKnowledge({
          totalChunks: statsData.totalChunks || 0,
          totalSources: statsData.totalSources || 0,
          qaCount: statsData.qaCount || 0,
        })
      }
      setTopQuestions(Array.isArray(topQ?.items) ? topQ.items : [])
      setSourceUtilisation(Array.isArray(srcU?.items) ? srcU.items : [])
      setResponseTimes(rt && typeof rt === 'object' ? rt : null)
      // QCL-BACKEND-UX #131: a failed/empty fetch (network error, 404, or a
      // response missing the fields we need) must degrade to "no panel",
      // never to a fake zero-vs-cap that implies a cap exists.
      setUsage(usageData && typeof usageData === 'object' && typeof usageData.requests === 'number' ? usageData : null)
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [authFetch, orgId, widget?.id, range, prevRange, reloadTick])

  // Server summary is the truth; the client-side fallback (page 1 of the
  // conversations list) only serves servers that predate the summary route.
  const stats = useMemo(() => (summary ? statsFromSummary(summary) : computeStats(conversations)), [summary, conversations])
  const prevStats = useMemo(() => (prevSummary ? statsFromSummary(prevSummary) : computeStats(prevConversations)), [prevSummary, prevConversations])
  const ratedCount = useMemo(() => (summary ? (summary.rating?.rated || 0) : countRatedConversations(conversations)), [summary, conversations])
  const hasKnowledge = knowledge.totalSources > 0 || knowledge.totalChunks > 0
  const satisfaction = useMemo(() => ratioDisplay(stats.satisfactionRatio, ratedCount), [stats.satisfactionRatio, ratedCount])
  const quality = useMemo(() => answerQualityDisplay(summary?.answer_quality), [summary])
  const filteredQuestions = useMemo(() => filterInterrogatives(topQuestions), [topQuestions])
  const questionsToShow = filteredQuestions.length > 0 ? filteredQuestions : topQuestions
  const questionsSectionLabel = filteredQuestions.length > 0 || topQuestions.length === 0 ? 'Top questions' : 'Top visitor messages'

  const deltas = useMemo(() => ({
    totalConversations: computePctChange(stats.totalConversations, prevStats.totalConversations),
    totalMessages:      computePctChange(stats.totalMessages, prevStats.totalMessages),
    handedOffCount:     computePctChange(stats.handedOffCount, prevStats.handedOffCount),
    satisfactionRatio:  computePctChange(stats.satisfactionRatio, prevStats.satisfactionRatio),
    avgMessages:        computePctChange(stats.avgMessages, prevStats.avgMessages),
  }), [stats, prevStats])

  const handleExport = useCallback(() => {
    const range = dateRangeFor(rangeId)
    const csv = serializeStatsCsv(stats, { rangeLabel: rangeId, from: range.from, to: range.to })
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `widget-${widget?.id || 'unknown'}-analytics-${rangeId}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [rangeId, stats, widget?.id])

  // W13: the server summary is the only truth for the stat cards. A failed
  // summary (or a loaded-but-null one) is 'unavailable', never a fabricated 0.
  const statsUnavailable = !summary && (!!failed.summary || !!failed.conversations || (loadedOnce && !loading))
  const failedLabels = Object.keys(failed).filter(k => !['prevConversations', 'prevSummary'].includes(k))
  const UNAVAIL = <div data-testid="unavailable" style={{ fontSize: 11, color: '#fca5a5' }}>unavailable (could not be loaded)</div>
  const isEmpty = !loading && !statsUnavailable && stats.totalConversations === 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* QCX-5j toolbar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'rgba(255,255,255,0.85)' }}>
          <span>Date range</span>
          <select
            aria-label="Date range"
            value={rangeId}
            onChange={(e) => setRangeId(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 4, fontSize: 12, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.18)', color: 'inherit', fontFamily: 'inherit' }}
          >
            {RANGE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <button
          type="button"
          onClick={handleExport}
          style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600, background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.25)', borderRadius: 4, cursor: 'pointer', color: '#38bdf8', fontFamily: 'inherit' }}
        >
          Export CSV
        </button>
        {prevRange.from && (
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', marginLeft: 'auto' }}>
            vs previous {rangeId === '7d' ? '7' : rangeId === '30d' ? '30' : '90'} days
          </span>
        )}
      </div>

      {failedLabels.length > 0 && !loading && (
        <div role="alert" data-testid="analytics-load-error" style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 11, color: '#fca5a5' }}>
          <span>Some analytics are unavailable: {failedLabels.join(', ')}.</span>
          <button type="button" className="glass-btn" onClick={() => setReloadTick(t => t + 1)} style={{ padding: '4px 12px', fontSize: 11, cursor: 'pointer' }}>Retry</button>
        </div>
      )}

      {/* Stat cards */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <StatCard label="Conversations" value={statsUnavailable ? 'unavailable' : stats.totalConversations} color="#38bdf8" subtitle={`${stats.totalMessages} total messages`} delta={deltas.totalConversations} />
        <StatCard label="Handed off" value={statsUnavailable ? 'unavailable' : stats.handedOffCount} color="#30ff90" subtitle={stats.totalConversations > 0 ? `${stats.closedCount} closed · ${stats.activeCount} active` : 'No conversations yet'} delta={deltas.handedOffCount} />
        <StatCard label="Satisfaction" value={statsUnavailable ? 'unavailable' : satisfaction.value} color={satisfaction.color} subtitle={satisfaction.suppressed ? `${ratedCount} rating${ratedCount === 1 ? '' : 's'} so far` : 'Thumbs up ratio'} delta={satisfaction.suppressed ? null : deltas.satisfactionRatio} />
        <StatCard label="Avg length" value={statsUnavailable ? 'unavailable' : (stats.avgMessages || 0)} subtitle="messages per conversation" delta={deltas.avgMessages} />
        {summary && (
          <StatCard label="Avg response" value={summary.avg_response_ms == null ? 'n/a' : `${(summary.avg_response_ms / 1000).toFixed(1)}s`} subtitle={`${summary.leads || 0} lead${summary.leads === 1 ? '' : 's'} captured${summary.blocked_turns ? ` · ${summary.blocked_turns} blocked` : ''}`} />
        )}
      </div>

      {isEmpty && (
        <div className="qx-flat-panel--ghost" style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', textAlign: 'center' }}>
          No conversations yet. Deploy the widget and have a chat to populate analytics.
        </div>
      )}

      {/* Usage-vs-cap burn panel (QCL-BACKEND-UX #131). Absent entirely when
          the usage fetch failed/returned nothing; never fabricate a cap. */}
      {usage && (
        <div className="qx-flat-panel" data-testid="usage-burn-panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>Usage this month</span>
          </div>
          {Number.isFinite(usage.caps?.monthly_requests) && usage.caps.monthly_requests > 0 ? (
            <>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', marginBottom: 6 }}>
                {usage.requests ?? 0} of {usage.caps.monthly_requests} requests used this month
              </div>
              <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.06)' }}>
                <div style={{
                  width: `${Math.min(100, Math.round(((usage.requests || 0) / usage.caps.monthly_requests) * 100))}%`,
                  height: '100%', borderRadius: 4,
                  background: usage.exceeded?.monthly_requests ? '#ef4444' : '#30ff90',
                  transition: 'width 0.5s ease',
                }} />
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.65)', marginTop: 6 }}>
                {Math.max(0, usage.remaining?.monthly_requests ?? 0)} remaining
                {usage.exceeded?.monthly_requests ? ' (cap reached)' : ''}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>
              {usage.requests ?? 0} requests this month · no monthly cap set
            </div>
          )}
        </div>
      )}

      {/* Answer quality: computed from each answer's grounding verdict */}
      <div className="qx-flat-panel" data-testid="answer-quality-panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>Answer quality</span>
          <span style={{ fontSize: 20, fontWeight: 800, color: quality.color, fontFamily: "'JetBrains Mono', monospace" }}>{quality.valueLabel}</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.06)' }}>
          <div style={{ width: `${quality.percent}%`, height: '100%', borderRadius: 4, background: quality.color, transition: 'width 0.5s ease' }} />
        </div>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.65)', marginTop: 6 }}>{quality.detail}</div>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.65)', marginTop: 4 }}>
          Knowledge size: {failed.knowledge ? 'unavailable' : `${knowledge.totalSources} source${knowledge.totalSources === 1 ? '' : 's'} · ${knowledge.totalChunks} chunks · ${knowledge.qaCount} Q&A pair${knowledge.qaCount === 1 ? '' : 's'}`}
          {!failed.knowledge && !hasKnowledge ? ' (add a knowledge source to ground answers)' : ''}
        </div>
      </div>

      {/* Unanswered / low confidence feed */}
      <div className="qx-flat-panel" data-testid="unanswered-panel">
        <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 8 }}>Unanswered questions</div>
        {failed.unanswered ? UNAVAIL : unanswered.length === 0 ? (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>Nothing flagged in this range. Questions the knowledge base could not back will appear here.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {unanswered.map((u) => (
              <div key={u.message_id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={u.answer}>
                  {u.question || '(question not recorded)'}
                </span>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', whiteSpace: 'nowrap' }}>{UNANSWERED_REASON_LABELS[u.reason] || u.reason}{Array.isArray(u.removed_figures) && u.removed_figures.length > 0 ? ` (${u.removed_figures.join(', ')})` : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {corrected.length > 0 && (
        <div className="qx-flat-panel" data-testid="corrected-panel">
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Answer was corrected</div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', marginBottom: 8 }}>The claim check removed an unsupported claim before the visitor saw the reply. Not unanswered, but worth checking your sources cover these.</div>
          {corrected.map((u) => (
            <div key={u.message_id} style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }} title={u.answer}>{u.question || '(question not recorded)'}</div>
          ))}
        </div>
      )}

      {/* Leads captured by the lead_capture action */}
      <div className="qx-flat-panel" data-testid="leads-panel">
        <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 8 }}>Leads</div>
        {failed.leads ? UNAVAIL : leads.length === 0 ? (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>No leads captured yet. They appear here when a visitor leaves contact details in the chat.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {leads.map((l) => (
              <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 11, color: 'rgba(255,255,255,0.85)' }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[l.name, l.email, l.phone, l.company].filter(Boolean).join(' · ') || '(no details)'}</span>
                <span style={{ color: 'rgba(255,255,255,0.55)', whiteSpace: 'nowrap' }}>{l.status || 'new'} · {l.captured_at ? String(l.captured_at).slice(0, 10) : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Two-column: top questions + source utilisation */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="qx-flat-panel">
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 8 }}>{questionsSectionLabel}</div>
          {failed.topQuestions ? UNAVAIL : questionsToShow.length === 0 ? (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>No questions yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {questionsToShow.map((q, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: i === questionsToShow.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.04)' }}>
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {q.question}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#a855f7', fontFamily: "'JetBrains Mono', monospace" }}>×{q.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="qx-flat-panel">
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 8 }}>Source utilisation</div>
          {failed.sourceUtilisation ? UNAVAIL : sourceUtilisation.length === 0 ? (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>No sources cited yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {sourceUtilisation.slice(0, 10).map((s, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: i === Math.min(sourceUtilisation.length, 10) - 1 ? 'none' : '1px solid rgba(255,255,255,0.04)' }}>
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {s.source}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#38bdf8', fontFamily: "'JetBrains Mono', monospace" }}>×{s.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Response time distribution */}
      {responseTimes && responseTimes.samples > 0 && (
        <div className="qx-flat-panel">
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 8 }}>Response times</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
            {[
              { label: 'p50', value: responseTimes.p50 },
              { label: 'p90', value: responseTimes.p90 },
              { label: 'p99', value: responseTimes.p99 },
              { label: 'min', value: responseTimes.min },
              { label: 'max', value: responseTimes.max },
            ].map(({ label, value }) => (
              <div key={label} style={{ padding: 8, borderRadius: 6, background: 'rgba(0,0,0,0.15)' }}>
                <div style={{ fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', fontFamily: "'JetBrains Mono', monospace" }}>
                  {value == null ? 'n/a' : `${value}ms`}
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', marginTop: 6 }}>
            based on {responseTimes.samples} exchange{responseTimes.samples === 1 ? '' : 's'}
          </div>
        </div>
      )}
    </div>
  )
}
