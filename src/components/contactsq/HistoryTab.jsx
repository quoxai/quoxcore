/**
 * History: a KPI grid (GET /stats; one dominant tile, five equal ones) and the LOG of everything ContactsQ did for
 * this org (GET /history, newest first, paged). The log is written for people: one sentence per row, grouped by day,
 * the noisy reads folded away behind "Show views". The server sends only ids and codes; contact names are resolved
 * here, on the client, for the signed-in human, and never travel back.
 */
import { useContext, useEffect, useMemo, useState } from 'react'
import AuthContext from '../../contexts/AuthContext'
import { api, isUnavailable } from './lib/api'
import { useAsync } from './lib/useAsync'
import { LOG_FILTERS, addedThisWeek, dailyCounts, eventSentence, fmtTime, groupByDay, isViewEvent, visibleEvents } from './lib/history'
import { useContactNames } from './lib/useContactNames'
import { chipClass } from './lib/chips'
import { explainError } from './lib/reasonCodes'
import { AsyncGuard, TabHeader } from './shared'
import { AlertIcon, BanIcon, BotIcon, ChatIcon, ClockIcon, EditIcon, EyeIcon, KeyIcon, MergeIcon, PhoneIcon, PhoneOffIcon, PlusIcon, RefreshIcon, ShieldIcon, UploadIcon, UsersIcon } from './icons'

/** The primary metric and the small ones, from GET /stats. Counts are never fabricated: a missing key shows a dash. */
export const PRIMARY = { key: 'total', label: 'Contacts', icon: UsersIcon }
export const SECONDARY = [
  { key: 'candidates', label: 'To review', foot: 'unknown callers', icon: AlertIcon },
  { key: 'suppressions', label: 'Do-not-contact', foot: 'numbers and emails', icon: BanIcon },
  { key: 'active_grants', label: 'Permissions', foot: 'standing agent grants', icon: KeyIcon },
  { key: 'leases_last_7d', label: 'Access granted', foot: 'last 7 days', icon: PhoneIcon },
  { key: 'denied_last_7d', label: 'Refused', foot: 'last 7 days', icon: PhoneOffIcon },
]
const ICONS = { call: PhoneIcon, refused: PhoneOffIcon, message: ChatIcon, eye: EyeIcon, ban: BanIcon, shield: ShieldIcon, bot: BotIcon, merge: MergeIcon, upload: UploadIcon, plus: PlusIcon, edit: EditIcon }
const ICON_HUE = { calls: 'teal', privacy: 'red', views: 'slate', changes: 'sky' }
const PAGE = 50

function Sparkline({ counts }) {
  const max = Math.max(1, ...counts)
  const pts = counts.map((v, i) => `${(i / Math.max(1, counts.length - 1)) * 100},${27 - (v / max) * 25}`).join(' ')
  return (
    <span className="qx-spark qx-spark--success" style={{ width: '100%' }} role="img" aria-label={`Activity over the last ${counts.length} days`} data-testid="sparkline">
      <svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><polyline className="qx-spark__line" points={pts} fill="none" /></svg>
    </span>
  )
}

function Kpi({ def, value, primary, foot }) {
  const Icon = def.icon
  return (
    <div className={`cnq-kpi${primary ? ' cnq-kpi--primary' : ''}`} role="listitem" data-testid={primary ? 'kpi-primary' : 'kpi'}>
      <div className="qx-stat__head"><Icon />{def.label}</div>
      <div className={`qx-stat__value cnq-kpi__value${primary ? ' qx-stat__value--hero' : ' qx-stat__value--sm'}`} data-testid={primary ? 'primary-metric' : undefined}>{value}</div>
      <div className={`cnq-kpi__foot${primary ? '' : ' qx-hint qx-hint--sm'}`}>{foot || def.foot || null}</div>
    </div>
  )
}

function Stats({ refreshKey, events, hasMore }) {
  const { data, error, loading } = useAsync(() => api.getStats(), [refreshKey])
  if (loading && !data) return <div className="qx-skeleton qx-skeleton--line-lg" aria-busy="true" aria-label="Loading figures" />
  if (error) {
    return <div className="qx-banner qx-banner--info" role="status">{isUnavailable(error) ? 'Figures are available after the next collector deploy.' : 'Figures could not be loaded.'}</div>
  }
  const val = (k) => (typeof data?.[k] === 'number' ? data[k] : '-')
  const week = addedThisWeek(events, { hasMore })
  const counts = dailyCounts(events.filter((e) => !isViewEvent(e)), 30)
  const active = counts.filter((n) => n > 0).length
  return (
    <div className="cnq-kpis" role="list" aria-label="Figures">
      <Kpi primary def={PRIMARY} value={val(PRIMARY.key)} foot={(
        <span className="qx-row qx-row--tight" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
          {week != null ? <span className={`qx-stat__delta ${week > 0 ? 'qx-stat__delta--up' : 'qx-stat__delta--flat'}`} data-testid="week-delta">{week > 0 ? '+' : ''}{week} this week</span> : null}
          {active > 1 ? <span style={{ flex: 1, minWidth: 0 }}><Sparkline counts={counts} /></span> : null}
        </span>
      )} />
      {SECONDARY.map((def) => <Kpi key={def.key} def={def} value={val(def.key)} />)}
    </div>
  )
}

/** One row of the log. Exported for tests. */
export function EventRow({ ev, onOpenContact, nameOf, me }) {
  const s = eventSentence(ev, { nameOf, me })
  const Icon = ICONS[s.icon] || EditIcon
  return (
    <li className="cnq-logrow" data-testid="history-row">
      <span className={`${chipClass(ICON_HUE[s.group] || 'sky')} cnq-logrow__icon`} aria-hidden="true" style={{ justifyContent: 'center' }}><Icon /></span>
      <span className="qx-stack qx-stack--tight" style={{ gap: 2, minWidth: 0 }}>
        <span data-testid="history-sentence" style={{ fontWeight: 600 }}>{s.text}</span>
        {s.detail ? <span className="qx-hint qx-hint--sm">{s.detail}</span> : null}
      </span>
      <span className="qx-row qx-row--tight" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
        <span className="qx-stat__value--mono cnq-logrow__time" title={ev.ts}>{fmtTime(ev.ts)}</span>
        {s.contactId && onOpenContact ? <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" aria-label={`Open contact${nameOf?.(s.contactId) ? ` ${nameOf(s.contactId)}` : ''}`} title="Open contact" onClick={() => onOpenContact(s.contactId)}><UsersIcon /></button> : null}
      </span>
    </li>
  )
}

function useMe() {
  const auth = useContext(AuthContext)
  const u = auth && auth.user
  if (!u) return null
  const id = u.id || u.userId || u.user_id || u.sub || null
  const name = u.name || u.display_name || u.displayName || (typeof u.email === 'string' ? u.email.split('@')[0] : '') || ''
  return id ? { id: String(id), name } : null
}

export default function HistoryTab({ refreshKey, onOpenContact }) {
  const first = useAsync(() => api.getHistory({ limit: PAGE }), [refreshKey])
  const [more, setMore] = useState({ events: [], next: undefined })
  const [busy, setBusy] = useState(false)
  const [moreErr, setMoreErr] = useState(null)
  const [filter, setFilter] = useState('all')
  const [contactId, setContactId] = useState('')
  const [showViews, setShowViews] = useState(false)
  const me = useMe()
  useEffect(() => { setMore({ events: [], next: undefined }); setMoreErr(null) }, [first.data])
  const events = useMemo(() => [...(first.data?.events || []), ...more.events], [first.data, more.events])
  const next = more.next === undefined ? first.data?.next_before : more.next
  const nameOf = useContactNames(events.map((e) => e.contact_id))
  const { rows, hiddenViews } = useMemo(() => visibleEvents(events, { filter, contactId, showViews }), [events, filter, contactId, showViews])
  const days = useMemo(() => groupByDay(rows), [rows])
  const contactIds = useMemo(() => [...new Set(events.map((e) => e.contact_id).filter(Boolean))], [events])
  const loadMore = async () => {
    if (!next) return
    setBusy(true); setMoreErr(null)
    try {
      const r = await api.getHistory({ limit: PAGE, before: next })
      setMore((m) => ({ events: [...m.events, ...(r.events || [])], next: r.next_before || null }))
    } catch (e) { setMoreErr(e) } finally { setBusy(false) }
  }
  return (
    <section className="qx-card qx-stack" aria-label="History">
      <TabHeader icon={ClockIcon} title="History" subtitle="The figures, and everything ContactsQ did for your organisation. Read from the evidence trail: ids and codes only, names are filled in here for you." />
      <Stats refreshKey={refreshKey} events={events} hasMore={!!next} />
      <div className="qx-divider" />
      <section className="qx-stack qx-stack--compact" aria-label="Log">
        <div className="qx-row qx-row--apart qx-row--wrap" style={{ alignItems: 'center' }}>
          <h3 className="qx-section-title" style={{ margin: 0 }}>Log</h3>
          <div className="qx-row qx-row--tight qx-row--wrap" style={{ alignItems: 'center' }}>
            <select className="qx-select qx-select--auto" aria-label="Filter by contact" value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">Any contact</option>
              {contactIds.map((id) => <option key={id} value={id}>{nameOf(id) || 'A contact'}{nameOf(id) ? '' : ` (${id.slice(0, 6)})`}</option>)}
            </select>
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={first.reload}><RefreshIcon />Refresh</button>
          </div>
        </div>
        <div className="qx-row qx-row--tight qx-row--wrap" role="group" aria-label="Filter by action" style={{ alignItems: 'center' }}>
          {LOG_FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={filter === f.key} className={chipClass(filter === f.key ? 'sky' : 'slate', { size: '', variant: 'toggle' })} onClick={() => setFilter(f.key)}>{f.label}</button>
          ))}
          {filter !== 'views' ? (
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" aria-pressed={showViews} onClick={() => setShowViews((v) => !v)}>
              <EyeIcon />{showViews ? 'Hide views' : 'Show views'}{!showViews && hiddenViews ? ` (${hiddenViews})` : ''}
            </button>
          ) : null}
        </div>
        <AsyncGuard error={first.error} loading={first.loading && !first.data} onRetry={first.reload} rows={5} what="The log">
          {events.length === 0 ? (
            <div className="qx-empty">
              <div className="qx-empty__icon"><ClockIcon size={22} /></div>
              <div className="qx-empty__title">Nothing logged yet</div>
              <div className="qx-empty__body">Adding a contact, a reach check or an agent request shows up here as it happens.</div>
            </div>
          ) : rows.length === 0 ? (
            <div className="qx-empty">
              <div className="qx-empty__icon"><ClockIcon size={22} /></div>
              <div className="qx-empty__title">Nothing to show with these filters</div>
              <div className="qx-empty__body">{hiddenViews ? `${hiddenViews} view event${hiddenViews === 1 ? ' is' : 's are'} folded away. Use Show views to see them.` : 'Try another action type or contact.'}</div>
            </div>
          ) : (
            <div className="qx-stack qx-stack--compact" aria-label="Log trail">
              {days.map((d) => (
                <div key={d.key} className="qx-stack qx-stack--tight" role="group" aria-label={d.label}>
                  <div className="qx-menu__header" style={{ borderBottom: 'none', padding: 0 }}>{d.label}</div>
                  <ul className="cnq-day">
                    {d.events.map((ev, n) => <EventRow key={`${ev.id || ev.ts}:${n}`} ev={ev} onOpenContact={onOpenContact} nameOf={nameOf} me={me} />)}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </AsyncGuard>
        {moreErr ? <div className="qx-banner qx-banner--error" role="alert">{explainError(moreErr)}</div> : null}
        {next ? <div><button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy} onClick={loadMore}><ClockIcon />{busy ? 'Loading' : 'Load older'}</button></div> : null}
      </section>
    </section>
  )
}
