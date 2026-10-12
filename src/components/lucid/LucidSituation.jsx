/**
 * LucidSituation, the LUCID v2 situation view.
 *
 * Used three places: /lucid (full), Home "LUCID" tab (compact), Home right
 * sidebar (compact + `sidebar`). Data is the server-side situation; the
 * interval only re-fetches (display-only, advance=false). The cursor moves
 * ONLY on the explicit "Mark seen" click.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { getSituation, getTold, ack, fmtWhen, listLessons, deleteLesson, dur } from '../../services/lucid'
import { REFRESH_MS, Btn, Note, Section, Svg, UrgencyPill, sub } from './lucidUi'
import LucidAreaRow from './LucidAreaRow'
import LucidItemCard from './LucidItemCard'
import LucidBlindSpots from './LucidBlindSpots'

const MAX_NEEDS_COMPACT = 3

function outcomeWord(c) {
  if (c.outcome) return c.outcome
  if (c.to === 'gone') return 'Dealt with'
  if (c.from == null) return 'New'
  return `Now ${String(c.to).toLowerCase()}`
}

function groupChanged(changed) {
  const groups = new Map()
  for (const c of changed) {
    const k = outcomeWord(c)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(c)
  }
  return [...groups.entries()]
}

const HOW = {
  l1_inbox: 'Approvals inbox',
  l2_slot: 'Slot nudge',
  l3_call: 'Phone call',
  resolved: 'Withdrawn',
  l2_failed: 'Slot nudge (failed)',
  l3_failed: 'Phone call (failed)',
}

function DoesntAddUp({ items }) {
  return (
    <Section title="Doesn't add up" count={items.length}>
      {items.length === 0 && (
        <Note>Nothing I can see contradicts anything else (I can only compare what the sources tell me).</Note>
      )}
      {items.map((d) => (
        <div key={d.ref} className="qx-card qx-card--compact">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, overflowWrap: 'anywhere' }}>{d.L0 || d.title}</span>
            <UrgencyPill urgency={d.urgency} />
          </div>
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13 }}>
            {d.claimed && <div><b>Claimed:</b> {d.claimed}</div>}
            {d.observed && <div><b>Observed:</b> {d.observed}</div>}
            {d.why && <div><b>Why it matters:</b> {d.why}</div>}
            {d.how && <div><b>How to settle:</b> {d.how}</div>}
            {Array.isArray(d.sources) && d.sources.length > 0 && (
              <div style={sub}>Sources: {d.sources.join(', ')}</div>
            )}
          </div>
        </div>
      ))}
    </Section>
  )
}

function toldRow(t) {
  if (t.type === 'briefing') return { how: 'Briefing', what: 'situation shown' }
  return { how: HOW[t.status] || t.status || 'Message', what: t.summary || 'situation shown' }
}

function Told({ state, onRefresh }) {
  const rows = [...(state.told || [])].sort((a, b) => b.ts - a.ts)
  return (
    <Section title="What LUCID told you" count={state.ok ? rows.length : null} action={
      <Btn label="Refresh" onClick={onRefresh}>
        <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </Btn>
    }>
      {state.error && <div role="alert" style={sub}>What LUCID told you is unavailable: {state.error}</div>}
      {state.ok && rows.length === 0 && <Note>LUCID has not told you anything in the last 24 hours.</Note>}
      {rows.map((t) => {
        const { how, what } = toldRow(t)
        return (
          <div key={`${t.type}-${t.seq || t.id}`} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
            <span style={{ ...sub, flex: 'none' }}>{fmtWhen(t.ts)}</span>
            <span className="qx-pill qx-pill--xs" style={{ flex: 'none' }}>{how}</span>
            <span style={{ flex: 1, minWidth: 120, overflowWrap: 'anywhere' }}>{what}</span>
            {t.ward_entry_id ? (
              <span title="Witnessed in the evidence chain" style={{ ...sub, display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--status-green)' }}>
                <Svg size={12}><polyline points="20 6 9 17 4 12" /></Svg>witnessed
              </span>
            ) : (
              <span style={{ ...sub, opacity: 0.7 }}>not witnessed</span>
            )}
          </div>
        )
      })}
    </Section>
  )
}

function Lessons({ authFetch }) {
  const [open, setOpen] = useState(false)
  const [st, setSt] = useState({ loading: false, ok: true, lessons: [], error: null })

  const load = useCallback(async () => {
    setSt((s) => ({ ...s, loading: true }))
    const r = await listLessons({ authFetch })
    if (r.ok) setSt({ loading: false, ok: true, lessons: r.lessons, error: null })
    else setSt({ loading: false, ok: false, lessons: [], error: String(r.status || r.error) })
  }, [authFetch])

  useEffect(() => { if (open) load() }, [open, load])

  async function del(id) {
    const r = await deleteLesson(id, { authFetch })
    if (!r.ok) setSt((s) => ({ ...s, error: `Delete failed: ${r.status || r.error}` }))
    else load()
  }

  return (
    <Section title="What you have taught me" action={
      <Btn label={open ? 'Hide lessons' : 'Show lessons'} onClick={() => setOpen(!open)} active={open}>
        {open ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}
      </Btn>
    }>
      {open && (
        <>
          {st.error && <div role="alert" style={sub}>LUCID lessons unavailable: {st.error}</div>}
          {!st.error && !st.loading && st.lessons.length === 0 && <Note>No lessons yet.</Note>}
          {st.lessons.map((l) => (
            <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                {l.scope} <b>{l.target}</b>: {l.field} = {String(l.value)}{l.reason ? ` (${l.reason})` : ''}
              </span>
              <Btn label="Delete lesson" withText={false} onClick={() => del(l.id)}>
                <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              </Btn>
            </div>
          ))}
        </>
      )}
    </Section>
  )
}

export default function LucidSituation({ compact = false, showOpenLink = false, refreshKey = 0 }) {
  const { authFetch } = useAuth()
  const [state, setState] = useState({ loading: true, ok: false, situation: null, error: null })
  const [area, setArea] = useState(null)
  const [acking, setAcking] = useState(false)
  const [ackError, setAckError] = useState(null)
  const [showShelved, setShowShelved] = useState(false)

  const fetchRef = useRef(authFetch)
  useEffect(() => { fetchRef.current = authFetch }, [authFetch])
  const stableFetch = useCallback((...a) => (fetchRef.current || fetch)(...a), [])

  const [toldState, setToldState] = useState({ ok: false, told: [], error: null })

  const loadTold = useCallback(async () => {
    const r = await getTold('24h', { authFetch: stableFetch })
    if (r.ok) setToldState({ ok: true, told: r.told, error: null })
    else setToldState({ ok: false, told: [], error: String(r.status || r.error) })
  }, [stableFetch])

  const load = useCallback(async () => {
    const r = await getSituation({ surface: 'panel', advance: false, authFetch: stableFetch })
    if (r.ok) setState({ loading: false, ok: true, situation: r.situation, error: null })
    else setState({ loading: false, ok: false, situation: null, error: String(r.status || r.error) })
  }, [stableFetch])

  useEffect(() => {
    let cancelled = false
    // Display refresh only, and only while someone can see it: a hidden tab never polls.
    const run = () => { if (!cancelled && !document.hidden) { load(); if (!compact) loadTold() } }
    run()
    const id = setInterval(run, REFRESH_MS)
    const onVis = () => { if (!document.hidden) run() }
    document.addEventListener('visibilitychange', onVis)
    return () => { cancelled = true; clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [load, loadTold, compact])

  useEffect(() => { if (refreshKey) { load(); if (!compact) loadTold() } }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  async function markSeen() {
    const sit = state.situation
    if (!sit) return
    setAcking(true)
    setAckError(null)
    const r = await ack(sit.cursor.to, { authFetch: stableFetch })
    if (!r.ok) setAckError(`Mark seen failed: ${r.status || r.error}`)
    await load()
    setAcking(false)
  }

  if (state.loading) {
    return <div className="qx-skeleton qx-skeleton--line-lg" aria-label="Loading situation" />
  }
  if (!state.ok) {
    return (
      <div role="alert" style={{ fontSize: 13 }}>
        LUCID unreachable: {state.error}{' '}
        <Btn label="Retry" onClick={load}>
          <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </Btn>
      </div>
    )
  }

  const sit = state.situation
  const now = sit.generated_at || Date.now()
  const inArea = (x) => !area || x.area === area
  const needs = (sit.needs_you || []).filter(inArea)
  const shownNeeds = compact ? needs.slice(0, MAX_NEEDS_COMPACT) : needs
  const motion = (sit.in_motion || []).filter(inArea)
  const shelved = (sit.shelved || []).filter(inArea)
  const changed = sit.changed || []
  const areas = sit.areas || []

  const briefing = (
    <Section title="In short">
      <div style={{ fontSize: compact ? 14 : 15, lineHeight: 1.5 }}>{sit.L0}</div>
    </Section>
  )

  const needsSection = (
    <Section title="Needs you" count={(sit.needs_you || []).length}>
      {needs.length === 0 && <Note>Nothing waiting on you that I can see{area ? ' in this area' : ''}.</Note>}
      {shownNeeds.map((it) => (
        <LucidItemCard key={it.ref} item={it} authFetch={stableFetch} now={now} compact={compact} onChanged={load} />
      ))}
      {compact && needs.length > MAX_NEEDS_COMPACT && <Note>...and {needs.length - MAX_NEEDS_COMPACT} more</Note>}
    </Section>
  )

  const openLink = showOpenLink ? (
    <div style={{ marginTop: 12 }}>
      <Link to="/lucid" className="glass-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', fontSize: 11, textDecoration: 'none' }}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
        </svg>
        <span>Open LUCID</span>
      </Link>
    </div>
  ) : null

  if (compact) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {briefing}
        <Section title="At a glance">
          <div role="table" aria-label="At a glance" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {areas.map((a) => <LucidAreaRow key={a.area} area={a} now={now} compact />)}
          </div>
        </Section>
        {needsSection}
        <LucidBlindSpots cannotSee={sit.cannot_see} />
        {openLink}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {briefing}

      <Section title="At a glance" action={area ? (
        <Btn label="Show all areas" onClick={() => setArea(null)}>
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </Btn>
      ) : null}>
        <div className="qx-grid-auto qx-grid-auto--start" style={{ '--qx-grid-min': '260px', gap: 12 }}>
          {areas.map((a) => (
            <LucidAreaRow key={a.area} area={a} now={now} selected={area === a.area}
              onSelect={() => setArea(area === a.area ? null : a.area)} />
          ))}
        </div>
      </Section>

      {needsSection}

      <DoesntAddUp items={sit.doesnt_add_up || []} />

      <Section title="Since you looked" action={changed.length > 0 ? (
        <Btn label="Mark seen" onClick={markSeen} disabled={acking}><polyline points="20 6 9 17 4 12" /></Btn>
      ) : null}>
        {changed.length === 0 && <Note>Nothing has changed since you last looked.</Note>}
        {ackError && <div role="alert" style={sub}>{ackError}</div>}
        {groupChanged(changed).map(([word, list]) => (
          <div key={word}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>{word}</div>
            {list.map((c) => (
              <div key={`${c.ref}-${c.ts}`} style={{ fontSize: 13 }}>
                {c.L0} <span style={sub}>· {dur(now - c.ts)} ago{c.changes > 1 ? ` (${c.changes} changes)` : ''}</span>
              </div>
            ))}
          </div>
        ))}
      </Section>

      <Section title="In motion" count={motion.length}>
        {motion.length === 0 && <Note>Nothing in motion that I can see.</Note>}
        {motion.map((it) => (
          <LucidItemCard key={it.ref} item={it} authFetch={stableFetch} now={now} onChanged={load} />
        ))}
      </Section>

      <Section title="Shelved" count={shelved.length} action={shelved.length > 0 ? (
        <Btn label={showShelved ? 'Hide shelved' : 'Show shelved'} onClick={() => setShowShelved(!showShelved)} active={showShelved}>
          {showShelved ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}
        </Btn>
      ) : null}>
        {shelved.length === 0 && <Note>Nothing shelved.</Note>}
        {showShelved && shelved.map((it) => (
          <LucidItemCard key={it.ref} item={it} authFetch={stableFetch} now={now} onChanged={load} />
        ))}
      </Section>

      <Told state={toldState} onRefresh={loadTold} />

      <LucidBlindSpots cannotSee={sit.cannot_see} />
      {sit.lessons_applied > 0 && <Note>{sit.lessons_applied} of your lessons shaped this view.</Note>}
      <Lessons authFetch={stableFetch} />
    </div>
  )
}
