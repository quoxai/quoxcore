/**
 * XOverviewPanel, the X plugin's default landing tab. X-PLUGIN P11 (XView UX v2).
 *
 * Pure presentation: the parent fetches GET /collector/x/overview via
 * xClient.getOverview and hands the result down as props. This component
 * never imports xClient, never calls fetch, and never reaches X itself, 
 * the collector route is free (it reads cached/local tables), so a refresh
 * here costs nothing, but the discipline still holds: no network calls on
 * mount, ever.
 *
 * Reuses the .qx-progress recipe from XBudgetPanel.jsx: the fill is painted
 * by the component's own ::after from the --qx-progress CSS variable (0..1).
 * Rendering a __fill child draws every bar EMPTY, see XBudgetPanel.jsx for
 * the incident this caused. Do not repeat it here.
 */

function variantFor(used, limit) {
  if (!limit) return ''
  const ratio = used / limit
  if (ratio >= 1) return 'qx-progress--crit'
  if (ratio >= 0.8) return 'qx-progress--warn'
  return 'qx-progress--brand'
}

function fmtRelative(iso) {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const diffMs = Date.now() - then
  const mins = Math.round(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

function fmtAbsolute(iso) {
  if (!iso) return null
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

const STATUS_PILL = {
  pending: 'qx-pill--warn',
  posted: 'qx-pill--online',
  approved: 'qx-pill--online',
  failed: 'qx-pill--critical',
  rejected: 'qx-pill--critical',
}

function statusPillClass(status) {
  return `qx-pill qx-pill--sm ${STATUS_PILL[status] || 'qx-pill--ghost'}`
}

function StatTile({ label, value, icon, tone }) {
  return (
    <div className="qx-stat">
      <div className="qx-stat__head">
        {icon}
        <span>{label}</span>
      </div>
      <div className="qx-stat__value" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  )
}

function BudgetGauge({ label, used, limit, remaining, note }) {
  const safeLimit = limit ?? 0
  const safeUsed = used ?? 0
  const pct = safeLimit ? Math.min(100, Math.round((safeUsed / safeLimit) * 100)) : 0
  return (
    <div className="qx-stack qx-stack--tight">
      <div className="qx-row qx-row--apart">
        <span className="qx-section-title xs-title">{label}</span>
        <span className="xs-caption">
          {safeUsed} of {safeLimit} used · {remaining ?? Math.max(0, safeLimit - safeUsed)} remaining
        </span>
      </div>
      {/* .qx-progress paints its fill from --qx-progress via its own ::after.
          No __fill child element exists in the component library — see
          XBudgetPanel.jsx for the incident where one was invented and every
          bar rendered empty, including a fully-spent (17/17) budget. */}
      <div
        className={`qx-progress ${variantFor(safeUsed, safeLimit)}`}
        style={{ '--qx-progress': safeLimit ? Math.min(1, safeUsed / safeLimit) : 0 }}
        role="progressbar"
        aria-valuenow={safeUsed}
        aria-valuemin={0}
        aria-valuemax={safeLimit}
        aria-label={`${label}: ${safeUsed} of ${safeLimit} used (${pct}%)`}
      />
      {note && <span className="qx-hint qx-hint--sm">{note}</span>}
    </div>
  )
}

/** "2026-09-11" to "Fri 11". Falls back to the raw ISO day if it will not
 * parse, because an unreadable label is better than a silently wrong one. */
function dayLabel(iso) {
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}`
}

/**
 * The 7-day posting chart.
 *
 * X-PLUGIN phase 13: this was one SVG at preserveAspectRatio="none", so
 * stretching a 280-unit viewBox across the panel width stretched the date
 * labels' GLYPHS with it, which is what the owner saw as "stretched wildly".
 * Bars tolerate being stretched; type does not. So the bars are now plain
 * elements in a 7-column grid and each label is a normal text node in its own
 * column: sized to its own text, centred under its own bar, never justified
 * across the width. The whole block keeps one role="img" plus the same
 * sentence summary, so a screen reader still gets the series in one read
 * rather than 14 stray numbers.
 */
function Sparkline({ days }) {
  const points = days && days.length > 0 ? days : []
  const max = Math.max(1, ...points.map((d) => d.posts || 0))
  const total = points.reduce((sum, d) => sum + (d.posts || 0), 0)
  const summary = points.length
    ? `Last 7 days: ${points.map((d) => `${d.day} ${d.posts} post${d.posts === 1 ? '' : 's'}`).join(', ')}. Total ${total}.`
    : 'No posting history yet.'

  return (
    <div className="xs-spark" role="img" aria-label={summary} title={summary}>
      {points.map((d) => {
        const posts = d.posts || 0
        // Percentage of the track, floored so a zero day is still a visible
        // baseline rather than a gap in the series.
        const heightPct = posts > 0 ? Math.max(8, Math.round((posts / max) * 100)) : 4
        return (
          <div className="xs-spark__col" key={d.day}>
            <span className="xs-spark__count">{posts}</span>
            <div className="xs-spark__track">
              <div
                className={`xs-spark__bar ${posts > 0 ? '' : 'xs-spark__bar--empty'}`}
                style={{ height: `${heightPct}%` }}
              />
            </div>
            <span className="xs-spark__label">{dayLabel(d.day)}</span>
          </div>
        )
      })}
    </div>
  )
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  )
}

function AccountIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  )
}

function tileIcon(path) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      {path}
    </svg>
  )
}

export default function XOverviewPanel({ overview, loading = false, error = null, onRefresh }) {
  return (
    <section className="qx-card">
      <div className="qx-stack">
        <div className="qx-row qx-row--apart">
          <div className="xs-panel-head">
            <h3>Overview</h3>
          </div>
          <button type="button" className="qx-btn xs-btn qx-btn--sm" onClick={onRefresh} disabled={loading}>
            <RefreshIcon />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {error && (
          <div className="qx-banner qx-banner--error">
            <svg className="qx-banner__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {loading && !overview ? (
          <div className="qx-stack">
            <div className="qx-skeleton qx-skeleton--block" />
            <div className="qx-skeleton qx-skeleton--block" />
            <div className="qx-skeleton qx-skeleton--block" />
          </div>
        ) : !overview ? (
          !error && <p className="qx-hint qx-hint--sm">No data yet.</p>
        ) : (
          <>
            {/* Account card */}
            <div className="qx-row qx-row--tight qx-row--wrap" style={{ alignItems: 'center' }}>
              {overview.account ? (
                <>
                  <span className="xs-badge xs-badge--ok">
                    <AccountIcon />
                    @{overview.account.username}
                  </span>
                  {overview.account.name && <span className="xs-caption xs-caption--strong">{overview.account.name}</span>}
                  {overview.account.verifiedAt && (
                    <span className="xs-caption">last verified {fmtRelative(overview.account.verifiedAt)}</span>
                  )}
                </>
              ) : (
                <>
                  <span className="xs-badge xs-badge--warn">Not verified yet</span>
                  <span className="xs-caption">We have not checked which X account this org posts as.</span>
                </>
              )}
            </div>

            {/* Stat tiles */}
            <div className="qx-grid-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
              <StatTile label="Published" value={overview.totals?.published ?? 0} icon={tileIcon(<><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7Z" /></>)} />
              <StatTile label="Replies" value={overview.totals?.replies ?? 0} icon={tileIcon(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />)} />
              <StatTile label="Approvals pending" value={overview.totals?.approvals_pending ?? 0} icon={tileIcon(<><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>)} tone={overview.totals?.approvals_pending ? '#f59e0b' : undefined} />
              <StatTile label="Approvals filed" value={overview.totals?.approvals_filed ?? 0} icon={tileIcon(<path d="M20 6 9 17l-5-5" />)} />
              <StatTile label="Failed" value={overview.totals?.approvals_failed ?? 0} icon={tileIcon(<><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></>)} tone={overview.totals?.approvals_failed ? '#f87171' : undefined} />
              <StatTile label="Deletes" value={overview.totals?.deletes ?? 0} icon={tileIcon(<><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>)} />
            </div>

            {/* Sparkline */}
            <div className="qx-stack qx-stack--tight">
              <span className="qx-section-title xs-title">Posting activity (7 days)</span>
              {overview.totals?.published || (overview.sparkline || []).some((d) => d.posts > 0) ? (
                <Sparkline days={overview.sparkline} />
              ) : (
                <div className="qx-empty" style={{ padding: '24px 12px' }}>
                  <div className="qx-empty__title">Nothing published yet</div>
                  <div className="qx-empty__body">Once a post goes out, the last 7 days will chart here.</div>
                </div>
              )}
            </div>

            {/* Budget gauges */}
            <div className="qx-stack">
              <span className="qx-section-title xs-title">Budgets</span>
              <BudgetGauge
                label="Daily posts"
                used={overview.budget?.dailyUsed}
                limit={overview.budget?.dailyLimit}
                remaining={overview.budget?.dailyRemaining}
                note={overview.budget?.dailyFreesAt ? `Frees at ${fmtAbsolute(overview.budget.dailyFreesAt)}` : undefined}
              />
              <BudgetGauge
                label="Monthly posts"
                used={overview.budget?.monthlyUsed}
                limit={overview.budget?.monthlyLimit}
                remaining={overview.budget?.monthlyRemaining}
                note={overview.budget?.monthlyFreesAt ? `Frees at ${fmtAbsolute(overview.budget.monthlyFreesAt)}` : undefined}
              />
              <BudgetGauge
                label="Reads (24h)"
                used={overview.reads?.dailyUsed}
                limit={overview.reads?.dailyLimit}
                remaining={overview.reads?.dailyRemaining}
              />
              <p className="xs-caption">
                Limits are enforced server-side at draft and at approval time: an approved post that would
                exceed the budget is refused by the collector, not by this page.
              </p>
            </div>

            {/* Recent activity */}
            <div className="qx-stack qx-stack--tight">
              <span className="qx-section-title xs-title">Recent activity</span>
              {(overview.recent || []).length === 0 ? (
                <div className="qx-empty" style={{ padding: '24px 12px' }}>
                  <div className="qx-empty__title">No drafts yet</div>
                  <div className="qx-empty__body">Compose a post and it will appear here awaiting approval.</div>
                </div>
              ) : (
                <table className="qx-table">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Status</th>
                      <th>Posts</th>
                      <th>Tweets</th>
                      <th>Claimed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.recent.map((r) => (
                      <tr key={r.inbox_item_id}>
                        <td><code className="qx-code">{r.action}</code></td>
                        <td><span className={statusPillClass(r.status)}>{r.status}</span></td>
                        <td>{r.posts_reserved}</td>
                        <td>
                          {r.tweet_ids && r.tweet_ids.length > 0
                            ? r.tweet_ids.map((id) => (
                              <a key={id} href={`https://x.com/i/web/status/${id}`} target="_blank" rel="noopener noreferrer" className="qx-chip qx-chip--xs">
                                {id}
                              </a>
                            ))
                            : '—'}
                        </td>
                        <td>{fmtRelative(r.claimed_at) || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Mentions polling line */}
            <p className="xs-caption">
              Mentions polling: {overview.poll?.enabled
                ? `on, every ${overview.poll.interval}`
                : 'off'}.
            </p>
          </>
        )}
      </div>
    </section>
  )
}
