/**
 * Address book (first tab). Two columns plus the collapsible agent dock:
 *   LEFT  (narrow, flat): search, Add contact, Import, Duplicates, saved views with counts, and the filters.
 *   MAIN: the contact LIST; opening a contact REPLACES the list with the record (identity header + sub-tabs)
 *         and a "Back to list" control. Esc and the browser Back button (the ?contact= deep link) also go back;
 *         the filters and the list's scroll position survive the round trip.
 * No statistics and no compliance here: those live on the History and Compliance tabs.
 */
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DockSlotContext } from './lib/dockSlot'
import { useSearchParams } from 'react-router-dom'
import { api } from './lib/api'
import { useAsync } from './lib/useAsync'
import { RELATIONSHIPS, FLAGS, STATUSES, flagLabel, isPolicyFlag, labelOf } from './lib/reasonCodes'
import { SAVED_VIEWS, applyView, escLeavesRecord, filterCards, layoutOf, viewCounts } from './lib/book'
import { relationshipHue, chipClass, statusHue } from './lib/chips'
import { dockPlacement, loadDockOpen, saveDockOpen } from './lib/dock'
import { cardName } from './lib/names'
import { AsyncGuard, Skeleton } from './shared'
import ContactAvatar from './ContactAvatar'
import ContactsQChatSidebar from './ContactsQChatSidebar'
import AddContactForm from './AddContactForm'
import ContactDetail, { isPane } from './ContactDetail'
import ImportPanel from './ImportPanel'
import DuplicatesPanel from './DuplicatesPanel'
import { AlertIcon, BanIcon, BookIcon, ChevronLeftIcon, ClockIcon, MergeIcon, PlusIcon, SearchIcon, SparklesIcon, StarIcon, UploadIcon, UsersIcon, XIcon } from './icons'

export { filterCards }
const VIEW_ICON = { all: UsersIcon, vip: StarIcon, review: AlertIcon, dnc: BanIcon, recent: ClockIcon }

const useDebounced = (value, ms = 250) => {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

/** The second line of a list row: "Buyer, Acme Corp", "Acme Corp", or what kind of record it is. */
export function subline(c) {
  if (c.org?.name) return c.org.role ? `${c.org.role}, ${c.org.name}` : c.org.name
  if (c.kind === 'organisation') return 'Organisation'
  if (c.status === 'candidate') return 'Unknown caller to review'
  return ''
}

export default function AddressBookTab({ orgId, initialContact = null, onChanged }) {
  const [q, setQ] = useState('')
  const [relationship, setRelationship] = useState('')
  const [status, setStatus] = useState('')
  const [flag, setFlag] = useState('')
  const [view, setView] = useState('all')
  // Deep link: /contacts?contact=<id>&pane=<overview|reach|consent|timeline|relationships|facts|privacy|edit>
  // (agents cite it, like /notes?note=<id>). Opening a contact PUSHES a history entry, so the browser Back button
  // returns to the list; a pane change only replaces. Both are read on load and kept in sync.
  const [searchParams, setSearchParams] = useSearchParams()
  const urlContact = searchParams.get('contact') || null
  const [selectedId, setSelectedId] = useState(() => initialContact || urlContact || null)
  const [pane, setPane] = useState(() => (isPane(searchParams.get('pane')) ? searchParams.get('pane') : 'overview'))
  const select = (id) => { setSelectedId(id); setPane('overview') }
  const layout = layoutOf(selectedId)
  const lastPushed = useRef(selectedId)
  useEffect(() => {
    const curContact = searchParams.get('contact') || null
    const curPane = searchParams.get('pane') || null
    const wantPane = selectedId && pane !== 'overview' ? pane : null
    if (curContact === selectedId && curPane === wantPane) { lastPushed.current = selectedId; return }
    const next = new URLSearchParams(searchParams)
    if (selectedId) next.set('contact', selectedId); else next.delete('contact')
    if (wantPane) next.set('pane', wantPane); else next.delete('pane')
    const replace = lastPushed.current === selectedId // same record, only the pane moved
    lastPushed.current = selectedId
    setSearchParams(next, { replace })
  }, [selectedId, pane]) // sync on selection/pane change only; searchParams is read, not a trigger
  // Browser Back / Forward / an in-page link changed ?contact=: follow it.
  useEffect(() => {
    if (urlContact === selectedId) return
    lastPushed.current = urlContact
    setSelectedId(urlContact)
    const p = searchParams.get('pane')
    setPane(isPane(p) ? p : 'overview')
  }, [urlContact])
  const [adding, setAdding] = useState(false)
  const [tool, setTool] = useState(null) // 'import' | 'duplicates' | null
  const [tick, setTick] = useState(0) // bumps when the agent wrote something, to remount the open detail
  const dq = useDebounced(q.trim())

  // The list's scroll position survives opening a record and coming back.
  const mainRef = useRef(null)
  const listScroll = useRef(0)
  const backToList = useCallback(() => { if (mainRef.current) listScroll.current = 0; setSelectedId(null); setPane('overview') }, [])
  const openRecord = (id) => { if (mainRef.current && layout === 'list') listScroll.current = mainRef.current.scrollTop; select(id); setAdding(false); setTool(null) }
  useLayoutEffect(() => {
    if (!mainRef.current) return
    mainRef.current.scrollTop = layout === 'list' ? listScroll.current : 0
  }, [layout])
  // Changing what the list shows (search, view, filter) while a record is open goes back to the list first.
  const toListThen = (fn) => (...a) => { if (selectedId) setSelectedId(null); fn(...a) }
  // Esc leaves the record (not while typing, and not when a menu or the overlay dock already took the key).
  useEffect(() => {
    if (layout !== 'record') return undefined
    const onKey = (e) => {
      const t = e.target
      if (escLeavesRecord({ key: e.key, defaultPrevented: e.defaultPrevented, targetTag: t?.tagName || '', editable: !!t?.isContentEditable })) backToList()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layout, backToList])

  // Agent dock: remembered; with no choice yet it opens only when it can dock beside the main column (never starts as an overlay).
  const rootRef = useRef(null)
  const shell = useContext(DockSlotContext)
  const [ownWidth, setWidth] = useState(null)
  // Inside the page shell the whole shell width decides (the dock lives beside the book, not inside it).
  const width = shell ? shell.width : ownWidth
  const [dockOpen, setDockOpen] = useState(loadDockOpen)
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const firstWidth = useRef(true)
  useEffect(() => {
    if (!width || width <= 0 || !firstWidth.current) return
    firstWidth.current = false
    setDockOpen(loadDockOpen(width))
  }, [width])
  // Resizing down to phone width (or rotating) closes the dock without forgetting the person's saved choice.
  const wasNarrow = useRef(false)
  useEffect(() => {
    const narrow = !!width && width > 0 && width < 900
    if (narrow && !wasNarrow.current) setDockOpen(false)
    wasNarrow.current = narrow
  }, [width])
  const placement = dockPlacement({ open: dockOpen, width })
  const external = !!(shell && shell.slot && placement === 'docked')
  useEffect(() => {
    if (!shell) return undefined
    shell.setDocked(external)
    return () => shell.setDocked(false)
  }, [shell?.setDocked, external]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggleDock = () => setDockOpen((o) => { saveDockOpen(!o); return !o })
  const closeDock = () => { setDockOpen(false); saveDockOpen(false) }
  useEffect(() => {
    if (placement !== 'overlay') return undefined
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeDock() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [placement])

  const { data, error, loading, reload } = useAsync(async () => {
    if (dq) {
      const r = await api.search(dq)
      return { cards: r.candidates || r.contacts || [], hint: r.ambiguous ? r.hint : null }
    }
    const r = await api.listContacts({ status: status || undefined })
    return { cards: r.contacts || [], hint: null }
  }, [dq, status])

  const base = useMemo(() => filterCards(data?.cards || [], { relationship, flag, status }), [data, relationship, flag, status])
  const counts = useMemo(() => viewCounts(base), [base])
  const cards = useMemo(() => applyView(base, view), [base, view])
  const filterCount = [relationship, status, flag].filter(Boolean).length
  const filtered = !!(dq || filterCount || view !== 'all')
  const changed = () => { reload(); onChanged?.() }
  const onAgentWrote = useCallback(() => { reload(); setTick((t) => t + 1); onChanged?.() }, [reload, onChanged])
  const openContact = selectedId ? (() => {
    const c = (data?.cards || []).find((x) => x.id === selectedId)
    return c ? { id: c.id, display_name: cardName(c), kind: c.kind, status: c.status, relationship_primary: c.relationship_primary || null } : { id: selectedId }
  })() : null
  const clearAll = () => { setRelationship(''); setStatus(''); setFlag(''); setView('all'); setQ('') }

  return (
    <div className="cnq-book" data-dock={external ? 'external' : placement} data-layout={layout} ref={rootRef}>
      <section className="qx-card qx-card--visible cnq-book__card" aria-label="Address book">
        <div className="qx-split cnq-split">
          <aside className="qx-stack qx-stack--compact cnq-pane cnq-left" aria-label="Find and filter">
            <div className="qx-search-wrap">
              <span className="qx-search-wrap__icon" aria-hidden="true"><SearchIcon /></span>
              <input className="qx-input" placeholder="Search by name" aria-label="Search contacts" value={q} onChange={(e) => toListThen(setQ)(e.target.value)} />
            </div>
            <button type="button" className="qx-btn qx-btn--primary" onClick={() => { setSelectedId(null); setTool(null); setAdding((a) => !a) }}><PlusIcon />Add contact</button>
            <div className="qx-row qx-row--tight qx-row--nowrap cnq-left__tools">
              <button type="button" className="qx-btn qx-btn--sm" aria-pressed={tool === 'import'} onClick={() => { setSelectedId(null); setAdding(false); setTool(tool === 'import' ? null : 'import') }}><UploadIcon />Import</button>
              <button type="button" className="qx-btn qx-btn--sm" aria-pressed={tool === 'duplicates'} onClick={() => { setSelectedId(null); setAdding(false); setTool(tool === 'duplicates' ? null : 'duplicates') }}><MergeIcon />Duplicates</button>
              <button type="button" className={`qx-btn qx-btn--sm ${placement === 'closed' ? '' : 'qx-btn--primary'}`} aria-pressed={placement !== 'closed'} onClick={toggleDock}
                title={placement === 'closed' ? 'Open the ContactsQ agent' : 'Close the ContactsQ agent'}><SparklesIcon />Agent</button>
            </div>
            <nav aria-label="Saved views">
              <div className="qx-menu__header cnq-left__head">Views</div>
              <div className="qx-tabs qx-tabs--vert qx-tabs--plain" role="group" aria-label="Saved views">
                {SAVED_VIEWS.map((v) => {
                  const Icon = VIEW_ICON[v.key]
                  return (
                    <button key={v.key} type="button" className={`qx-tab${view === v.key ? ' qx-tab--active' : ''}`} aria-pressed={view === v.key} data-view={v.key} onClick={() => toListThen(setView)(v.key)}>
                      <Icon /><span style={{ flex: 1, textAlign: 'left' }}>{v.label}</span><span className="qx-pill qx-pill--ghost qx-pill--xs" aria-label={`${counts[v.key] ?? 0} contacts`}>{data ? counts[v.key] ?? 0 : '-'}</span>
                    </button>
                  )
                })}
              </div>
            </nav>
            <div className="qx-stack qx-stack--tight" role="group" aria-label="Filters">
              <div className="qx-menu__header cnq-left__head">Filters{filterCount ? ` (${filterCount})` : ''}</div>
              <select className="qx-select" aria-label="Relationship" value={relationship} onChange={(e) => toListThen(setRelationship)(e.target.value)}>
                <option value="">Any relationship</option>
                {RELATIONSHIPS.map((r) => <option key={r} value={r}>{labelOf([], r)}</option>)}
              </select>
              <select className="qx-select" aria-label="Status" value={status} onChange={(e) => toListThen(setStatus)(e.target.value)}>
                <option value="">Active and candidates</option>
                {STATUSES.map((s) => <option key={s} value={s}>{labelOf([], s)}</option>)}
              </select>
              <select className="qx-select" aria-label="Flag" value={flag} onChange={(e) => toListThen(setFlag)(e.target.value)}>
                <option value="">Any flag</option>
                {FLAGS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
              {filtered ? <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={clearAll}><XIcon />Clear all</button> : null}
            </div>
          </aside>
          <div className="cnq-pane cnq-main" ref={mainRef}>
            {layout === 'record' ? (
              <div className="qx-stack">
                <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                  <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={backToList} title="Back to the list (Esc)"><ChevronLeftIcon />Back to list</button>
                  <span className="qx-kbd" aria-hidden="true">Esc</span>
                </div>
                <ContactDetail key={`${selectedId}:${tick}`} id={selectedId} pane={pane} onPane={setPane} onClose={backToList} onChanged={changed} />
              </div>
            ) : (
              <div className="qx-stack qx-stack--compact">
                <h2 className="qx-section-title" style={{ margin: 0 }}><BookIcon />Address book{data ? <span className="qx-pill qx-pill--ghost qx-pill--xs">{cards.length}</span> : null}</h2>
                {tool === 'import' ? <ImportPanel onClose={() => setTool(null)} onImported={changed} /> : null}
                {tool === 'duplicates' ? <DuplicatesPanel onClose={() => setTool(null)} onChanged={changed} /> : null}
                {adding ? <AddContactForm onCancel={() => setAdding(false)} onCreated={(c) => { setAdding(false); select(c.id); changed() }} /> : null}
                {data?.hint ? <div className="qx-banner qx-banner--info" role="status">{data.hint}</div> : null}
                <AsyncGuard error={error} loading={loading && !data} onRetry={reload} rows={5} what="The address book">
                  {cards.length === 0 ? (
                    <div className="qx-empty">
                      <div className="qx-empty__icon"><UsersIcon size={22} /></div>
                      <div className="qx-empty__title">{filtered ? 'No one matches' : 'No contacts yet'}</div>
                      <div className="qx-empty__body">{filtered ? 'Try a different name or clear a filter.' : 'Add the people you deal with. Details are encrypted, and agents only ever see masked cards.'}</div>
                    </div>
                  ) : (
                    <table className="qx-table qx-table--dense" aria-label="Contacts">
                      <tbody>
                        {cards.map((c) => {
                          const candidate = c.status === 'candidate'
                          const policy = (c.flags || []).filter(isPolicyFlag)
                          const nm = cardName(c)
                          const sub = subline(c)
                          return (
                            <tr key={c.id} className={candidate ? 'qx-table__row--muted' : ''} onClick={() => openRecord(c.id)} style={{ cursor: 'pointer' }} aria-selected={c.id === selectedId}>
                              <td>
                                <span className="qx-row qx-row--tight" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
                                  <ContactAvatar card={c} size="sm" />
                                  <span className="qx-stack qx-stack--tight" style={{ gap: 0, minWidth: 0 }}>
                                    <a href={`/contacts?contact=${encodeURIComponent(c.id)}`} aria-label={`Open ${nm}`} style={{ color: 'inherit', fontWeight: 600, textDecoration: 'none' }} onClick={(e) => { e.preventDefault(); e.stopPropagation(); openRecord(c.id) }}>{nm}</a>
                                    {sub ? <span className="qx-hint qx-hint--sm">{sub}</span> : null}
                                  </span>
                                  {policy.length ? <span className="qx-dot qx-dot--sm qx-dot--static qx-dot--degraded" role="img" aria-label={`${policy.length} policy flag${policy.length === 1 ? '' : 's'}`} title={policy.map(flagLabel).join(', ')} /> : null}
                                </span>
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <span className="qx-row qx-row--tight qx-row--end" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
                                  {candidate ? <span className={chipClass(statusHue('candidate'))} title="An unknown caller saved for you to review"><AlertIcon />To review</span> : null}
                                  {c.status === 'archived' ? <span className={chipClass(statusHue('archived'))}>Archived</span>
                                    : c.relationship_primary ? <span className={chipClass(relationshipHue(c.relationship_primary))}>{labelOf([], c.relationship_primary)}</span> : null}
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
                </AsyncGuard>
                {loading && data ? <Skeleton rows={1} /> : null}
              </div>
            )}
          </div>
        </div>
      </section>
      {placement !== 'closed' ? (() => {
        const dock = (
          <div className="cnq-dock qx-surface--backed" data-placement={placement} role={placement === 'overlay' ? 'dialog' : undefined} aria-label="ContactsQ agent">
            <ContactsQChatSidebar orgId={orgId} openContact={openContact} filters={{ q: dq, relationship, status, flag }}
              onOpenContact={openRecord} onAgentActed={onAgentWrote} onClose={closeDock} />
          </div>
        )
        return external ? createPortal(dock, shell.slot) : dock
      })() : null}
    </div>
  )
}
