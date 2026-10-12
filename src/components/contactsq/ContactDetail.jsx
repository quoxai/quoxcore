/**
 * Detail pane for one contact (flat: it lives inside the People card). Identity header with
 * quick actions, underline sub-tabs, one pane at a time. Server is the source of truth; every
 * save refetches. The active pane is owned by the parent so it can live in the URL (?pane=).
 */
import { useEffect, useRef, useState } from 'react'
import { api } from './lib/api'
import { useAsync } from './lib/useAsync'
import { useContactFocus } from './lib/useContactFocus'
import { IDENTIFIER_CHANNELS, explainError, flagLabel, labelOf } from './lib/reasonCodes'
import { channelHue, chipClass, flagHue, relationshipHue, statusHue } from './lib/chips'
import { cardName, namePartRows } from './lib/names'
import { AsyncGuard, ErrorBanner, Field, MenuItem, Popover, Section, fmtDate } from './shared'
import ContactEdit from './ContactEdit'
import ConsentPanel from './ConsentPanel'
import ReachPanel from './ReachPanel'
import RelationshipsPanel from './RelationshipsPanel'
import PrivacyPanel from './PrivacyPanel'
import TimelinePanel from './TimelinePanel'
import FactsPanel from './FactsPanel'
import PhotoMenu from './PhotoMenu'
import { FLAG_ICON } from './FlagPicker'
import { CopyButton, RevealNotice, useReveal } from './Reveal'
import { ArchiveIcon, ChevronLeftIcon, ChevronRightIcon, DownloadIcon, EditIcon, EyeIcon, EyeOffIcon, MoreIcon, PhoneIcon, PlusIcon, SplitIcon, TrashIcon, XIcon } from './icons'

/** Sub-tabs, in order. `edit` is reached from the Edit button (or ?pane=edit), not a tab. */
export const PANES = [['overview', 'Overview'], ['reach', 'Reach'], ['consent', 'Consent'], ['timeline', 'Timeline'], ['relationships', 'Relationships'], ['facts', 'Facts'], ['privacy', 'Privacy']]
export const PANE_KEYS = [...PANES.map(([k]) => k), 'edit']
export const isPane = (v) => PANE_KEYS.includes(v)
const MAX_FLAG_PILLS = 5

function Identifiers({ card, contactId, rev, onAdded }) {
  const { full } = rev
  const rows = full?.identifiers
    ? full.identifiers.map((i) => ({ key: i.id, channel: i.channel, label: i.label, text: i.value, extra: i.verification, raw: true }))
    : (card.identifier_summary || []).map((i, n) => ({ key: `${i.channel}-${n}`, channel: i.channel, label: i.label, text: i.masked }))
  return (
    <Section title="Contact details">
      {rows.length === 0 ? (
        <div className="qx-empty"><div className="qx-empty__body">No numbers or addresses yet. Add one below.</div></div>
      ) : (
        <ul className="qx-kv" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((r) => (
            <li key={r.key} className="qx-stat-row">
              <span className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                <span className={chipClass(channelHue(r.channel))}>{labelOf(IDENTIFIER_CHANNELS, r.channel)}</span>
                {r.label ? <span>{r.label}</span> : null}
              </span>
              <span className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                <span className={`qx-stat__value--mono${r.raw ? ' cnq-revealed' : ''}`} data-revealed={r.raw ? 'true' : undefined}>{r.text}</span>
                {r.extra ? <span className="qx-hint qx-hint--sm">{r.extra}</span> : null}
                {r.raw && r.text ? <CopyButton value={r.text} label={`${labelOf(IDENTIFIER_CHANNELS, r.channel).toLowerCase()}${r.label ? ` ${r.label}` : ''}`} /> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {full?.notes ? <div className="qx-kv"><div className="qx-stat-row"><span>Notes</span><span>{full.notes}</span></div></div> : null}
      <AddIdentifier contactId={contactId} onAdded={() => { rev.hide(); onAdded() }} />
    </Section>
  )
}

function AddIdentifier({ contactId, onAdded }) {
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ channel: 'phone', value: '', label: '' })
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  if (!open) return <div><button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setOpen(true)}><PlusIcon />Add number or address</button></div>
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null)
    try {
      await api.addIdentifier(contactId, { channel: f.channel, value: f.value.trim(), ...(f.label.trim() ? { label: f.label.trim() } : {}) })
      setF({ channel: 'phone', value: '', label: '' }); setOpen(false); onAdded()
    } catch (e2) { setErr(e2) } finally { setBusy(false) }
  }
  return (
    <form className="qx-stack qx-stack--compact" onSubmit={submit} aria-label="Add identifier">
      {err ? <div className="qx-banner qx-banner--error" role="alert">{explainError(err)}</div> : null}
      <div className="qx-row qx-row--wrap">
        <Field label="Type"><select className="qx-select" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{IDENTIFIER_CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></Field>
        <Field label="Value"><input className="qx-input" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} required autoComplete="off" /></Field>
        <Field label="Label"><input className="qx-input" placeholder="Work, mobile" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
      </div>
      <div className="qx-row qx-row--end qx-row--tight">
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setOpen(false)}><XIcon />Cancel</button>
        <button type="submit" className="qx-btn qx-btn--primary qx-btn--sm" disabled={busy || !f.value.trim()}><PlusIcon />{busy ? 'Adding' : 'Add'}</button>
      </div>
    </form>
  )
}

/** Archive confirmation, shown under the header when chosen from the More menu. */
function ArchiveConfirm({ card, onDone, onCancel }) {
  const [err, setErr] = useState(null)
  const go = async () => {
    setErr(null)
    try { await api.archiveContact(card.id); onDone() } catch (e) { setErr(e) }
  }
  return (
    <div className="qx-stack qx-stack--tight">
      <ErrorBanner error={err} />
      <div className="qx-banner qx-banner--warn" role="alert">
        <span>Archive {cardName(card)}? They stay on record but drop out of the list.</span>
        <button type="button" className="qx-btn qx-btn--danger qx-btn--sm" onClick={go}><ArchiveIcon />Archive</button>
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onCancel}><XIcon />Keep</button>
      </div>
    </div>
  )
}

function IdentityHeader({ card, rev, pane, setPane, onClose, onArchive, onChanged }) {
  const name = cardName(card)
  const flags = card.flags || []
  const primary = rev.full?.identifiers
    ? rev.full.identifiers.slice(0, 2).map((i) => ({ k: i.id, t: i.value, raw: true, channel: i.channel }))
    : (card.identifier_summary || []).slice(0, 2).map((i, n) => ({ k: `${i.channel}-${n}`, t: i.masked, channel: i.channel }))
  const archived = card.status === 'archived' || card.status === 'erased'
  const [callState, setCallState] = useState(null) // null | {busy} | {ok, lease} | {error}
  const placeCall = async () => {
    const reason = window.prompt(`Quox's voice agent will phone ${name} now and open with what you type here. What is the call about?`, '')
    if (reason === null) return
    setCallState({ busy: true })
    try {
      const out = await api.callContact(card.id, reason.trim())
      setCallState({ ok: true, lease: out && out.lease })
    } catch (e) {
      setCallState({ error: explainError(e) })
    }
  }
  return (
    <header className="qx-stack qx-stack--tight">
      <div className="qx-row qx-row--apart qx-row--wrap" style={{ alignItems: 'flex-start' }}>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center', minWidth: 0 }}>
          <PhotoMenu card={card} size="lg" onChanged={onChanged} />
          <div className="qx-stack qx-stack--tight" style={{ gap: 4, minWidth: 0 }}>
            <h2 style={{ margin: 0 }}>{name}</h2>
            <div className="qx-row qx-row--wrap qx-row--tight" style={{ alignItems: 'center' }}>
              {card.relationship_primary ? <span className={chipClass(relationshipHue(card.relationship_primary))}>{labelOf([], card.relationship_primary)}</span> : null}
              <span className={chipClass(statusHue(card.status))}>{labelOf([], card.status)}</span>
              {card.kind === 'organisation' ? <span className={chipClass('indigo')}>Organisation</span> : null}
              {card.lifecycle_stage ? <span className="qx-hint qx-hint--sm">{card.lifecycle_stage}</span> : null}
            </div>
            {card.org ? <div>{card.org.role ? `${card.org.role} at ` : 'At '}<strong>{card.org.name}</strong></div> : null}
            {primary.length ? (
              <div className="qx-row qx-row--wrap qx-row--tight" style={{ alignItems: 'center' }}>
                {primary.map((p) => (
                  <span key={p.k} className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                    <span className={p.raw ? 'qx-code cnq-revealed' : 'qx-code'} data-revealed={p.raw ? 'true' : undefined}>{p.t}</span>
                    {p.raw && p.t ? <CopyButton value={p.t} label={`${labelOf(IDENTIFIER_CHANNELS, p.channel).toLowerCase()}`} /> : null}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="qx-row qx-row--wrap qx-row--tight" style={{ alignItems: 'center' }}>
          <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={placeCall} disabled={archived || (callState && callState.busy)} title="Quox's voice agent phones them through a single-use lease; you never see the number"><PhoneIcon />{callState && callState.busy ? 'Calling' : 'Call'}</button>
          {rev.full
            ? <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={rev.hide}><EyeOffIcon />Hide</button>
            : <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={rev.reveal} disabled={rev.busy}><EyeIcon />{rev.busy ? 'Checking' : 'Reveal'}</button>}
          <button type="button" className={`qx-btn qx-btn--sm ${pane === 'edit' ? 'qx-btn--primary' : 'qx-btn--ghost'}`} onClick={() => setPane('edit')}><EditIcon />Edit</button>
          <Popover label="" icon={MoreIcon} caret={false} ariaLabel="More actions" align="end">
            {(close) => (
              <>
                <MenuItem icon={DownloadIcon} title="Download their data (DSAR)" onClick={() => { close(); setPane('privacy') }} />
                {!archived ? <MenuItem icon={ArchiveIcon} title="Archive contact" onClick={() => { close(); onArchive() }} /> : null}
                <div className="qx-menu__sep" />
                <MenuItem icon={TrashIcon} danger title="Erase..." help="Opens the danger zone. Nothing is erased yet." onClick={() => { close(); setPane('privacy') }} />
              </>
            )}
          </Popover>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose} aria-label="Close contact" title="Close"><XIcon /></button>
        </div>
      </div>
      {flags.length ? (
        <div className="qx-row qx-row--wrap qx-row--tight" aria-label="Active flags">
          {flags.slice(0, MAX_FLAG_PILLS).map((f) => {
            const Icon = FLAG_ICON[f]
            return <span key={f} className={chipClass(flagHue(f))}>{Icon ? <Icon /> : null}{flagLabel(f)}</span>
          })}
          {flags.length > MAX_FLAG_PILLS ? <span className={chipClass('slate')} title={flags.slice(MAX_FLAG_PILLS).map(flagLabel).join(', ')}>+{flags.length - MAX_FLAG_PILLS} more</span> : null}
        </div>
      ) : null}
          {callState && callState.ok ? <div className="qx-banner qx-banner--info" role="status">Call queued: the phone bridge is dialling now (lease {callState.lease ? callState.lease.id : ''}).</div> : null}
      {callState && callState.error ? <div className="qx-banner qx-banner--warn" role="alert">{callState.error}</div> : null}
</header>
  )
}

/** The name, never collapsed: every part that is set, or a prompt to split a one-field name. */
function NameSection({ card, onSplit }) {
  if (card.kind === 'organisation') return null
  const rows = namePartRows(card)
  if (!rows.length && !cardName(card)) return null
  return (
    <Section title="Name" action={!rows.length && card.name !== undefined ? <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onSplit}><SplitIcon />Split name</button> : null}>
      <div className="qx-kv">
        {rows.length ? rows.map((r) => <div key={r.key} className="qx-stat-row"><span>{r.label}</span><span>{r.value}</span></div>) : (
          <div className="qx-stat-row"><span>Full name</span><span>{cardName(card)}</span></div>
        )}
        {card.org ? <div className="qx-stat-row"><span>Organisation</span><span>{card.org.role ? `${card.org.role}, ` : ''}{card.org.name}</span></div> : null}
      </div>
    </Section>
  )
}

/** How long ago, in words a person would say. Pure, exported for tests. */
export function ageLabel(hours) {
  const h = Number(hours)
  if (!Number.isFinite(h) || h < 1) return 'just now'
  if (h < 48) return `${Math.floor(h)}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Open threads: the latest handoff notes an agent left on this contact. Renders nothing when there are none (or the read fails). */
export function OpenThreads({ contactId }) {
  const { data } = useAsync(() => api.getHandoffs(contactId, 3), [contactId])
  const notes = (data && data.handoffs) || []
  if (!notes.length) return null
  return (
    <Section title="Open threads">
      <div className="qx-kv">
        {notes.map((n) => (
          <div key={n.id} className="qx-stat-row">
            <span>{ageLabel(n.age_hours)}</span>
            <span>{n.summary || 'Note not readable'}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

function Overview({ card, contactId, rev, onAdded, onSplit }) {
  const tags = card.tags || []
  return (
    // Two columns when there is room: how to reach them on the left, who they are and the record on the right.
    <div className="cnq-overview">
     <div className="cnq-overview__grid">
      <div className="qx-stack">
        <Identifiers card={card} contactId={contactId} rev={rev} onAdded={onAdded} />
      </div>
      <div className="qx-stack">
      <NameSection card={card} onSplit={onSplit} />
      <OpenThreads contactId={contactId} />
      <Section title="Record">
       <div className="qx-kv">
        <div className="qx-stat-row"><span>Added</span><span>{fmtDate(card.created_at)}</span></div>
        <div className="qx-stat-row"><span>Last contact</span><span>{card.last_touchpoint_at ? fmtDate(card.last_touchpoint_at) : 'Never'}</span></div>
        {tags.length ? (
          <div className="qx-stat-row">
            <span>Tags</span>
            <span className="qx-row qx-row--wrap qx-row--tight">
              {tags.slice(0, 6).map((t) => <span key={t} className="qx-chip qx-chip--xs">{t}</span>)}
              {tags.length > 6 ? <span className="qx-chip qx-chip--xs" title={tags.slice(6).join(', ')}>+{tags.length - 6}</span> : null}
            </span>
          </div>
        ) : null}
       </div>
      </Section>
      </div>
     </div>
    </div>
  )
}

/** Sub-tabs in a sideways scroller that SAYS it scrolls: a fade on the clipped edge and arrow buttons (shown only when there is more). */
export function ScrollTabs({ label, children, activeKey }) {
  const ref = useRef(null)
  const [more, setMore] = useState({ left: false, right: false })
  const measure = () => {
    const el = ref.current
    if (!el) return
    setMore({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 })
  }
  useEffect(() => {
    measure()
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const on = ref.current?.querySelector('[aria-selected="true"]')
    if (on && typeof on.scrollIntoView === 'function') on.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeKey])
  const nudge = (dir) => ref.current?.scrollBy?.({ left: dir * 160, behavior: 'smooth' })
  return (
    <div className="cnq-scrolltabs" data-more-left={more.left} data-more-right={more.right}>
      {more.left ? <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm cnq-scrolltabs__arrow" aria-label="Scroll sections left" onClick={() => nudge(-1)}><ChevronLeftIcon /></button> : null}
      <div className="cnq-scrolltabs__track" ref={ref} onScroll={measure}>
        <div className="qx-tabs qx-tabs--underline" role="tablist" aria-label={label} style={{ width: 'max-content', minWidth: '100%' }}>{children}</div>
      </div>
      {more.right ? <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm cnq-scrolltabs__arrow" aria-label="Scroll sections right" onClick={() => nudge(1)}><ChevronRightIcon /></button> : null}
    </div>
  )
}

export default function ContactDetail({ id, pane = 'overview', onPane, onClose, onChanged }) {
  useContactFocus(id) // P8B: lets an attached agent resolve "this person"
  const { data, error, loading, reload } = useAsync(() => api.getContact(id), [id])
  const card = data?.contact
  const rev = useReveal(id)
  const [archiving, setArchiving] = useState(false)
  const refreshed = () => { reload(); onChanged?.() }
  const setPane = (p) => onPane?.(p)
  const active = isPane(pane) ? pane : 'overview'

  return (
    <section className="qx-stack" aria-label="Contact detail">
      <AsyncGuard error={error} loading={loading && !card} onRetry={reload} rows={4} what="This contact">
        {card ? (
          <>
            <IdentityHeader card={card} rev={rev} pane={active} setPane={setPane} onClose={onClose} onArchive={() => setArchiving(true)} onChanged={refreshed} />
            {rev.err ? <div className="qx-banner qx-banner--warn" role="alert">{rev.err.status === 403 ? (rev.err.body?.message || explainError(rev.err)) : explainError(rev.err)}</div> : null}
            {rev.full ? <RevealNotice secondsLeft={rev.secondsLeft} onHide={rev.hide} /> : null}
            {archiving ? <ArchiveConfirm card={card} onDone={() => { setArchiving(false); refreshed() }} onCancel={() => setArchiving(false)} /> : null}
            <ScrollTabs label="Contact sections" activeKey={active}>
              {PANES.map(([k, l]) => (
                <button key={k} type="button" role="tab" aria-selected={active === k} className={`qx-tab${active === k ? ' qx-tab--active' : ''}`} onClick={() => setPane(k)}>{l}</button>
              ))}
              {active === 'edit' ? <button type="button" role="tab" aria-selected className="qx-tab qx-tab--active">Edit</button> : null}
            </ScrollTabs>
            {active === 'overview' ? <Overview card={card} contactId={id} rev={rev} onAdded={refreshed} onSplit={() => setPane('edit')} /> : null}
            {active === 'edit' ? <ContactEdit card={card} onSaved={refreshed} /> : null}
            {active === 'consent' ? <ConsentPanel contactId={id} /> : null}
            {active === 'reach' ? <ReachPanel contactId={id} /> : null}
            {active === 'timeline' ? <TimelinePanel contactId={id} onChanged={refreshed} /> : null}
            {active === 'relationships' ? <RelationshipsPanel contactId={id} onChanged={refreshed} /> : null}
            {active === 'facts' ? <FactsPanel contactId={id} onChanged={onChanged} /> : null}
            {active === 'privacy' ? <PrivacyPanel card={card} onChanged={onChanged} /> : null}
          </>
        ) : null}
      </AsyncGuard>
    </section>
  )
}
