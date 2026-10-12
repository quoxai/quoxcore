/**
 * NotesQView: P1 notebook at /notes. Three panes (filters, list, editor) that
 * collapse to stacked list -> editor below 900px (see notesq.css).
 * Collector-native routes, same licence gate as InboxQ.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { readNoteParam, NOTE_SYNC_OPTIONS } from '../../pages/views/quoxbrainDeepLink'
import { setNoteCacheOrg, prefetchNotes, fetchNote, putNote } from './lib/noteCache'

const whenIdle = (fn) => (typeof window !== 'undefined' && window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 300))
import { usePluginLicensed, usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import LicenceGate from '../plugins/LicenceGate'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import NotesQChatSidebar from './NotesQChatSidebar'
import NotesQLocked from './NotesQLocked'
import NotesQSidebar from './NotesQSidebar'
import NotesQImportDialog from './NotesQImportDialog'
import NotesQTemplateDialog from './NotesQTemplateDialog'
import NotesQHealthDialog from './NotesQHealthDialog'
import NotesQList from './NotesQList'
import NotesQEditor from './NotesQEditor'
import NotesQSkillList from './NotesQSkillList'
import NotesQSkillEditor from './NotesQSkillEditor'
import { listQuoxSkills } from '../../services/quoxflowClient'
import { api } from './lib/api'
import { saveLastNote, resolveInitialNote } from './lib/lastNote'
import { useNotesqSettings } from './lib/useNotesqSettings'
import { parseViewParam, loadView, saveView, serializeViewParam } from './lib/propertyViews'
import { layoutReducer, effectiveLayout, loadLayout, saveLayout, parseLayoutParam, agentPlacement, loadAgentOpen, saveAgentOpen } from './lib/layout'
import NotesQPaneRail from './NotesQPaneRail'
import { NotesIcon, BookOpenIcon } from './icons'
import './notesq.css'

// Container width under which an open note auto-collapses the list pane.
const NARROW_PX = 1100
// At or below this container width the CSS stacks list -> editor and no pane can be collapsed.
const STACKED_PX = 820

const DEFAULT_FILTERS = { scope: 'all', q: '', collection: '', tag: '', pinned: false, archived: 'exclude' }

function NotesQContent({ narrow, stacked, width, orgId, initialNote, restoreLast = true }) {
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const navigate = useNavigate()
  // Org settings (Settings > NotesQ). Defaults until fetched; any failure keeps them.
  const orgSettings = useNotesqSettings()
  const [notes, setNotes] = useState([])
  const [total, setTotal] = useState(0)
  const [facets, setFacets] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // /notes?note=<id> opens a note directly (same helper + replace-sync as
  // Qortex's /brain2?note=<id>), so chat cards and links can deep-link here.
  const [searchParams, setSearchParams] = useSearchParams()
  // Skills folder: ?folder=skills, a selected skill is ?skill=<id>. ?note= and ?skill= are mutually exclusive (skill wins on load).
  const [skillId, setSkillId] = useState(() => searchParams.get('skill') || null)
  const [skillsMode, setSkillsMode] = useState(() => searchParams.get('folder') === 'skills' || !!searchParams.get('skill'))
  const bootInSkills = useRef(skillsMode)
  // undefined = loading, null = unavailable (401/403/error hides the folder silently; quoxflow enforces the role), array = loaded.
  const [skills, setSkills] = useState(undefined)
  const skillDirty = useRef(false)
  const onSkillDirty = useCallback((d) => { skillDirty.current = d }, [])
  const [selectedId, setSelectedIdRaw] = useState(() => (searchParams.get('skill') ? null : initialNote))
  // Leaving an edited skill asks first; every navigation away from the skill editor goes through here.
  const guard = useCallback((go) => {
    if (skillDirty.current && !window.confirm('You have unsaved changes to this skill. Discard them?')) return false
    skillDirty.current = false
    go()
    return true
  }, [])
  // Choosing a note clears any skill selection and leaves Skills mode.
  const setSelectedId = useCallback((idOrFn) => {
    const id = typeof idOrFn === 'function' ? idOrFn(null) : idOrFn
    if (id) guard(() => { setSkillId(null); setSkillsMode(false); setSelectedIdRaw(id) })
    else setSelectedIdRaw(null)
  }, [guard])
  // Reopen where you were: remember the note you open, not only the one you last saved.
  // Keyed on selection only: an org switch must not file the old org's note under the new org.
  const orgRef = useRef(orgId); orgRef.current = orgId
  setNoteCacheOrg(orgId)
  useEffect(() => { if (selectedId) saveLastNote(orgRef.current, selectedId) }, [selectedId])
  const openSkill = useCallback((id) => { guard(() => { setSelectedIdRaw(null); setSkillsMode(true); setSkillId(id) }) }, [guard])
  const loadSkills = useCallback(() => {
    return listQuoxSkills().then((list) => setSkills(Array.isArray(list) ? list : [])).catch(() => setSkills(null))
  }, [])
  useEffect(() => { loadSkills() }, [loadSkills])
  const skillsShown = skillsMode && skills !== null
  // No ?note=: reopen the note last saved in this browser (never when stacked, where it would hide the list).
  useEffect(() => {
    if (initialNote || stacked || bootInSkills.current || !restoreLast) return undefined
    let live = true
    resolveInitialNote({ orgId, explicit: null, getNote: api.getNote }).then((id) => { if (live && id) setSelectedIdRaw((cur) => cur || id) })
    return () => { live = false }
  }, []) // first mount only
  useEffect(() => {
    // Functional form: a view change in the same batch must not be overwritten by a stale snapshot.
    // One update for note + folder + skill: two functional setSearchParams calls in the same commit would clobber each other.
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev.toString())
      if (selectedId) p.set('note', selectedId); else p.delete('note')
      if (skillsShown) p.set('folder', 'skills'); else p.delete('folder')
      if (skillsShown && skillId) p.set('skill', skillId); else p.delete('skill')
      return p.toString() === prev.toString() ? prev : p
    }, NOTE_SYNC_OPTIONS)
  }, [selectedId, skillsShown, skillId]) // sync only on selection change; searchParams is read, not a trigger
  // Property projections (?view=table|cards|timeline): a per-viewer display preference, URL first then localStorage.
  const [view, setViewState] = useState(() => parseViewParam(searchParams.get('view')) || loadView())
  const setView = useCallback((v) => {
    setViewState(v); saveView(v)
    setSearchParams((prev) => serializeViewParam(prev, v), NOTE_SYNC_OPTIONS)
  }, [setSearchParams])
  const projecting = view !== 'list'
  const openFromProjection = useCallback((id) => { setSelectedId(id); setView('list') }, [setView, setSelectedId])
  const [creating, setCreating] = useState(false)
  // ?import=1 opens the Import dialog on load (deep link + screenshot without a click, like ?layout=).
  const [importOpen, setImportOpen] = useState(() => searchParams.get('import') === '1')
  const [templateOpen, setTemplateOpen] = useState(false)
  // ?health=1 opens the Notebook health dialog on load (deep link + screenshot without a click).
  const [healthOpen, setHealthOpen] = useState(() => searchParams.get('health') === '1')
  // ?layout=details opens the Details rail of the note opened on load (this load only).
  const detailsOpen = useRef(!!parseLayoutParam(searchParams.get('layout'))?.details)
  const [createErr, setCreateErr] = useState('')
  const reqSeq = useRef(0)
  const [layoutState, dispatchLayout] = useReducer(layoutReducer, undefined, () => {
    // ?layout=filters,list,focus: explicit state for THIS load only (never persisted, see parseLayoutParam).
    const fromUrl = parseLayoutParam(searchParams.get('layout'))
    return fromUrl ?? loadLayout()
  })
  // Persist only user-chosen pane state, and never a URL-forced one (urlLayout.current guards the first write).
  const urlLayout = useRef(!!parseLayoutParam(searchParams.get('layout')))
  useEffect(() => {
    if (urlLayout.current) { urlLayout.current = false; return }
    saveLayout(layoutState)
  }, [layoutState.filters, layoutState.list])
  // No note means nothing to focus on: closing, deselecting or deleting ends focus.
  const docOpen = skillsShown ? !!skillId : !!selectedId
  useEffect(() => { if (!docOpen) dispatchLayout({ type: 'NOTE_CLOSED' }) }, [docOpen])
  const layout = effectiveLayout(layoutState, { narrow, noteOpen: docOpen && (skillsShown || !projecting), stacked })
  // Esc leaves focus mode. A wikilink menu Esc calls preventDefault first, so it is not double-handled.
  useEffect(() => {
    if (!layoutState.focus) return undefined
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) dispatchLayout({ type: 'ESCAPE' }) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layoutState.focus])
  // Agent dock: remembered per browser (convenience only); ?layout=agent opens it for this load.
  // Default (no remembered choice, no ?layout=): open, but only where it docks beside the editor;
  // on a narrow screen it would cover the note, so it starts closed there.
  const agentDefaulted = useRef(false)
  const [agentOpen, setAgentOpen] = useState(() => {
    const fromParam = parseLayoutParam(searchParams.get('layout'))?.agent
    if (fromParam != null) return fromParam
    const stored = loadAgentOpen()
    if (stored != null) return stored
    agentDefaulted.current = true
    return true
  })
  const toggleAgent = () => setAgentOpen((o) => { saveAgentOpen(!o); return !o })
  const closeAgent = () => { setAgentOpen(false); saveAgentOpen(false) }
  const placement = agentPlacement({ open: agentOpen, stacked, width, filtersCollapsed: layout.filtersCollapsed, listCollapsed: layout.listCollapsed, focus: layout.focus })
  useEffect(() => {
    if (agentDefaulted.current && placement === 'overlay') { agentDefaulted.current = false; setAgentOpen(false) }
    else if (width) agentDefaulted.current = false
  }, [placement, width])
  // Overlay mode: Esc closes the dock (it covers the editor).
  useEffect(() => {
    if (placement !== 'overlay') return undefined
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) closeAgent() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [placement])
  const [editorTick, setEditorTick] = useState(0)
  const toggleList = () => dispatchLayout({ type: 'TOGGLE_LIST', current: layout.listCollapsed })
  const toggleFilters = () => dispatchLayout({ type: 'TOGGLE_FILTERS', current: layout.filtersCollapsed })

  const refresh = useCallback(async () => {
    const seq = ++reqSeq.current
    setLoading(true)
    // Facets load independently: a slow facet count must never hold the list
    // in its skeleton state (it did, 2026-10-03, before the vault-first fix).
    api.getFacets(filters.scope)
      .then((f) => { if (seq === reqSeq.current) setFacets(f) })
      .catch(() => { /* facets are decoration; the list surfaces real errors */ })
    try {
      const list = await api.listNotes(filters)
      if (seq !== reqSeq.current) return
      setNotes(list.notes || []); setTotal(list.total ?? (list.notes || []).length); setError('')
      // Warm the top of the list (pinned + most recent) and the rich editor while idle, so opening
      // a note paints from memory. Server stays the truth: the editor revalidates every open.
      whenIdle(() => {
        import('./NotesQRichEditor').catch(() => {})
        prefetchNotes((list.notes || []).map((n) => n.id), api.getNote)
      })
    } catch (e) {
      if (seq === reqSeq.current) setError(e.message)
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [filters])

  useEffect(() => { refresh() }, [refresh])

  // The agent may have created or edited notes: refetch list + facets and nudge the open editor.
  const onAgentWrote = useCallback(() => { refresh(); setEditorTick((t) => t + 1) }, [refresh])
  const openInPlace = useCallback((id) => { setSelectedId(id) }, [setSelectedId])

  const onQ = useCallback((q) => setFilters((f) => ({ ...f, q })), [])
  const prefetchOne = useCallback((id) => { fetchNote(id, api.getNote).catch(() => {}) }, [])

  const create = async (scope) => {
    setCreating(true); setCreateErr('')
    try {
      // A new note lands in the collection being viewed; otherwise in the org's default collection (NotesQ settings).
      const collection = filters.collection || orgSettings.defaultCollection
      const properties = collection ? { collection } : {}
      const res = await api.createNote({ scope, markdown: '# Untitled\n\n', properties })
      // The create response IS the note: seed the cache so the editor opens without a second round trip.
      putNote(res.note)
      saveLastNote(orgId, res.note.id)
      setSelectedId(res.note.id)
      refresh()
    } catch (e) {
      setCreateErr(e.message)
      // The error banner lives in the list pane: never leave it hidden behind a rail.
      if (layout.listCollapsed) dispatchLayout({ type: 'TOGGLE_LIST', current: true })
    } finally { setCreating(false) }
  }

  const openNote = selectedId ? (notes.find((n) => n.id === selectedId) || { id: selectedId }) : null
  const hasFilters = !!(filters.q || filters.collection || filters.tag || filters.pinned || filters.archived !== 'exclude')

  return (
    <div className="nq-shell" data-detail-open={docOpen && (skillsShown || !projecting) ? 'true' : 'false'} data-view={view}
      data-filters={layout.filtersCollapsed ? 'collapsed' : 'open'} data-list={layout.listCollapsed ? 'collapsed' : 'open'} data-focus={layout.focus ? 'true' : 'false'}
      data-agent={placement === 'docked' ? 'open' : 'closed'}>
      <NotesQSidebar filters={filters} facets={facets} onFilters={(f) => { if (skillsShown) guard(() => { setSkillsMode(false); setSkillId(null); setFilters(f) }); else setFilters(f) }}
        skillsCount={Array.isArray(skills) ? skills.length : null} skillsActive={skillsShown} onSkills={() => guard(() => { setSelectedIdRaw(null); setSkillsMode(true); setSkillId(null) })} onCreate={create} creating={creating} onImport={() => setImportOpen(true)} onTemplate={() => setTemplateOpen(true)} onHealth={() => setHealthOpen(true)} onSettings={() => navigate('/settings#account/notesq')}
        collapsed={layout.filtersCollapsed && !layout.focus} onToggle={toggleFilters} />
      {layout.listCollapsed && !layout.focus ? (
        <NotesQPaneRail className="nq-pane--list" icon={NotesIcon} label={skillsShown ? 'Skills' : 'Notes'} count={skillsShown ? (Array.isArray(skills) ? skills.length : null) : (loading && !notes.length ? null : total)} expandLabel={skillsShown ? 'Show skills list' : 'Show notes list'} onExpand={toggleList} />
      ) : (
        <div className="nq-pane nq-pane--list" style={{ gap: 12 }}>
          {skillsShown ? <NotesQSkillList skills={skills || []} selectedId={skillId} onSelect={openSkill} onCollapse={toggleList} /> : null}
          {createErr ? <div className="qx-banner qx-banner--error" role="alert">Could not create the note. {createErr}</div> : null}
          {skillsShown ? null : <NotesQList q={filters.q} onQ={onQ} notes={notes} total={total} loading={loading} error={error}
            selectedId={selectedId} onSelect={setSelectedId} onPrefetch={prefetchOne} hasFilters={hasFilters} onRetry={refresh} onCollapse={toggleList}
            onAgent={selectedId ? undefined : toggleAgent} agentOpen={agentOpen}
            view={view} onView={setView} onOpen={openFromProjection} />}
        </div>
      )}
      {skillsShown ? (
        skillId ? (
          <NotesQSkillEditor key={skillId} skillId={skillId} onDirtyChange={onSkillDirty} onBack={() => guard(() => setSkillId(null))}
            onOpenNote={(id) => setSelectedId(id)} onChanged={loadSkills} />
        ) : (
          <section className="nq-pane nq-pane--doc qx-card">
            <div className="qx-empty">
              <div className="qx-empty__icon"><BookOpenIcon /></div>
              <div className="qx-empty__title">Select a skill</div>
              <div className="qx-empty__body">Skills are owned by the Skills library. Edits here go through the same governed patch flow, with history and revert.</div>
            </div>
          </section>
        )
      ) : projecting ? null : selectedId ? (
        <NotesQEditor key={selectedId} noteId={selectedId} scope={filters.scope} collections={facets?.collections}
          onSaved={(n) => { if (n?.id) saveLastNote(orgId, n.id); refresh() }} onDeleted={() => { setSelectedId(null); refresh() }}
          onBack={() => setSelectedId(null)} onOpenNote={setSelectedId}
          onAgent={toggleAgent} agentOpen={agentOpen} refreshTick={editorTick} initialRail={detailsOpen.current} autosaveMs={orgSettings.autosaveMs}
          focus={layout.focus} onToggleFocus={() => dispatchLayout({ type: 'TOGGLE_FOCUS' })} />
      ) : (
        <section className="nq-pane nq-pane--doc qx-card">
          <div className="qx-empty">
            <div className="qx-empty__icon"><NotesIcon /></div>
            <div className="qx-empty__title">Select a note</div>
            <div className="qx-empty__body">Pick a note from the list, or create one. Notes are markdown and searchable by every Quox agent through Qortex.</div>
          </div>
        </section>
      )}
      {placement !== 'closed' ? (
        <div className="nq-agent-dock qx-surface--backed" data-placement={placement} role={placement === 'overlay' ? 'dialog' : undefined}
          aria-label="NotesQ agent">
          <NotesQChatSidebar orgId={orgId} openNote={openNote} filters={filters}
            onOpenNote={openInPlace} onAgentWrote={onAgentWrote} onClose={closeAgent} />
        </div>
      ) : null}
      {templateOpen ? (
        <NotesQTemplateDialog collection={filters.collection} onClose={() => setTemplateOpen(false)}
          onCreated={(id) => { setTemplateOpen(false); setSelectedId(id); refresh() }} />
      ) : null}
      {healthOpen ? (
        <NotesQHealthDialog defaultScope={filters.scope === 'user' ? 'user' : 'org'} onClose={() => setHealthOpen(false)}
          onOpenNote={(id) => { setHealthOpen(false); setSelectedId(id); setView('list') }} />
      ) : null}
      {importOpen ? <NotesQImportDialog onClose={() => setImportOpen(false)} onDone={refresh} /> : null}
    </div>
  )
}

export default function NotesQView() {
  const licensed = usePluginLicensed('notesq')
  const diag = usePluginLicenseDiagnosis('notesq')
  const rootRef = useRef(null)
  const [narrow, setNarrow] = useState(false)
  const [stacked, setStacked] = useState(false)
  const [width, setWidth] = useState(null)
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id || null
  const [epoch, setEpoch] = useState(0)
  const [searchParams] = useSearchParams()
  // The ?note= deep link applies to the first mount only. After an org switch the id belongs to the
  // other org, so it is dropped (and removed from the URL) before the new content mounts.
  const bootNote = useRef(readNoteParam(searchParams))
  const lastOrg = useRef(orgId)
  // Reopening the last note is for the first load only: after an org switch it would belong to the other org.
  const restoreLast = useRef(true)
  if (lastOrg.current !== orgId) { lastOrg.current = orgId; bootNote.current = null; restoreLast.current = false }
  // `quox-org-switch` (WorkspaceContext) fires before currentOrg re-renders: remount now (the new content's mount clears ?note=), so no
  // old-org note, list, in-flight response or pending autosave survives into the new org.
  useEffect(() => {
    const onSwitch = () => {
      bootNote.current = null
      restoreLast.current = false
      setEpoch((e) => e + 1)
    }
    window.addEventListener('quox-org-switch', onSwitch)
    return () => window.removeEventListener('quox-org-switch', onSwitch)
  }, [])
  // Container width (not viewport): a docked chat panel or wide nav rail narrows us too.
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(([entry]) => { const w = entry.contentRect.width; setNarrow(w < NARROW_PX); setStacked(w <= STACKED_PX); setWidth(w) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [licensed])
  // An org-seat problem is explained, not sold again (governed since 2026-10-07).
  if (!licensed) return <LicenceGate diag={diag} displayName="NotesQ" locked={<NotesQLocked />} />
  return (
    <div className="qx-view nq-view" ref={rootRef}>
      <NotesQContent key={`${orgId}:${epoch}`} narrow={narrow} stacked={stacked} width={width} orgId={orgId} initialNote={bootNote.current} restoreLast={restoreLast.current} />
    </div>
  )
}
