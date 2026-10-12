/**
 * Main pane: title, Edit/Read toggle, autosaving textarea, wikilink
 * autocomplete, conflict banner, and the right rail.
 *
 * Editor choice: a plain styled textarea (.qx-textarea). Monaco is already a
 * dependency but would add its loader + worker weight to this route chunk for
 * a prose editor that needs no language services.
 *
 * Never-drop-text contract: the draft lives in component state AND in a
 * localStorage buffer (cache only) written on every edit; the buffer is
 * cleared only after a successful save of that exact draft.
 */
import { hasUnsupported, contentOf } from './lib/richSafety'
import { Component, lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import NotesQMarkdown from './NotesQMarkdown'
import NotesQToolbar from './NotesQToolbar'
import NotesQRail from './NotesQRail'
import NotesQAgentEditBar from './NotesQAgentEditBar'
import { api } from './lib/api'
import { saveReducer, INITIAL_SAVE_STATE, shouldAutosave, STATUS_LABEL, AUTOSAVE_DELAY_MS } from './lib/saveMachine'
import { saveDraft, loadDraft, clearDraft } from './lib/draftBuffer'
import { detectWikilinkTrigger, applyWikilink } from './lib/wikilink'
import { deriveTitle } from './lib/listQuery'
import { formatAction, continueList, indentLines, toggleTask, diffRange } from './lib/mdFormat'
import { loadMode, saveMode } from './lib/layout'
import { loadZoom, saveZoom, stepZoom, DEFAULT_ZOOM } from './lib/textZoom'
import { TextSizeControl } from '../ui/TextSizeControl'
import { getCachedNote, fetchNote, putNote, forgetNote } from './lib/noteCache'
import { placeholderText, replacePlaceholder } from './lib/attachments'
import { useAttachmentUpload, prepareFile } from './useAttachmentUpload'
import { EditIcon, EyeIcon, CodeIcon, ChevronLeftIcon, SidebarIcon, RefreshIcon, CheckIcon, FocusIcon, FocusExitIcon, XIcon, HistoryIcon, ChatIcon, ChevronsRightIcon } from './icons'

// Shortcut table: e.code for the shifted digits (e.key differs per keyboard layout).
const SHORTCUTS = [
  { id: 'bold', key: 'b' }, { id: 'italic', key: 'i' }, { id: 'link', key: 'k' },
  { id: 'ol', code: 'Digit7', shift: true }, { id: 'ul', code: 'Digit8', shift: true }, { id: 'check', code: 'Digit9', shift: true },
]

// TipTap lives in its own chunk; Markdown/Read modes never pay for it.
// One retry after a failed import (a transient network blip should not strand the note).
const NotesQRichEditor = lazy(() => import('./NotesQRichEditor').catch(() => import('./NotesQRichEditor')))

const SLOW_MS = 6000       // show the escape banner
const GIVE_UP_MS = 15000   // a rich editor that never mounts falls back to markdown

// Local boundary: a failed rich chunk must never take the page down.
class RichBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false } }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="qx-banner qx-banner--error" role="alert">
        <span>The rich editor could not load.</span>
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={this.props.onMarkdown}><CodeIcon /> Open in Markdown</button>
      </div>
    )
  }
}

const mark = (name) => { try { performance.mark(name) } catch { /* diagnostics only */ } }
const measure = (name, start) => { try { performance.measure(name, start) } catch { /* diagnostics only */ } }
const Skeleton = ({ wait }) => (
  <div aria-busy="true" data-nq-wait={wait}><div className="qx-skeleton qx-skeleton--line-lg" /><div className="qx-skeleton qx-skeleton--block" /></div>
)

const STATUS_PILL = { saved: 'qx-pill--success', saving: 'qx-pill--info', unsaved: 'qx-pill--medium', conflict: 'qx-pill--danger', error: 'qx-pill--danger' }

export default function NotesQEditor({ noteId, scope, collections, onSaved, onDeleted, onBack, onOpenNote,
  focus = false, onToggleFocus, onAgent, agentOpen = false, refreshTick = 0, autosaveMs = AUTOSAVE_DELAY_MS, initialRail = false }) {
  const [state, dispatch] = useReducer(saveReducer, INITIAL_SAVE_STATE)
  const [note, setNote] = useState(null)
  const [draft, setDraft] = useState({ markdown: '', properties: {} })
  const [loadErr, setLoadErr] = useState('')
  // null until the Rich-safety guard has decided (see decideMode).
  const [mode, setMode] = useState(null)
  const [richBlocked, setRichBlocked] = useState(false)
  const modeRef = useRef(null); modeRef.current = mode
  // Diagnostics + escape hatch for the three waiting states (note / mode / editor).
  const [ms, setMs] = useState({})
  const [editorReady, setEditorReady] = useState(false)
  const [slow, setSlow] = useState(false)
  const [slowDismissed, setSlowDismissed] = useState(false)
  const t0 = useRef({})
  const decideSeq = useRef(0)
  const richOrig = useRef('')
  const richVerified = useRef(false)
  const endStage = useCallback((k) => {
    const start = t0.current[k]
    if (start == null) return
    t0.current[k] = null
    measure(`nq:${k}`, `nq:${k}:start`)
    setMs((m) => ({ ...m, [k]: Math.max(0, Math.round(performance.now() - start)) }))
  }, [])
  const startStage = (k) => { t0.current[k] = performance.now(); mark(`nq:${k}:start`) }
  // Rail starts open only where there is room beside the editor (container
  // >1100px roughly equals a viewport >= 1500px with the nav rail open).
  const [rail, setRail] = useState(() => initialRail || (typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(min-width: 1500px)').matches))
  const [zoom, setZoom] = useState(loadZoom)
  const changeZoom = (dir) => setZoom((z) => { const next = dir === 0 ? DEFAULT_ZOOM : stepZoom(z, dir); saveZoom(next); return next })
  const [restored, setRestored] = useState(false)
  const [revTick, setRevTick] = useState(0)
  const [trigger, setTrigger] = useState(null)
  const [titles, setTitles] = useState([])
  const [pick, setPick] = useState(0)
  const taRef = useRef(null)
  const fileInput = useRef(null)
  const cameraInput = useRef(null)
  const [attachNote, setAttachNote] = useState('')
  const [attachErr, setAttachErr] = useState('')
  const uploadFile = useAttachmentUpload(noteId)
  const stateRef = useRef(state); stateRef.current = state
  const draftRef = useRef(draft); draftRef.current = draft

  // Rich mode is only entered when the note survives markdown -> doc -> markdown
  // unchanged, so rich editing can never silently rewrite a note (HTML blocks,
  // tables, footnotes...). Otherwise the note opens in Markdown mode with a banner.
  // The guard lives in the lazy chunk, next to TipTap.
  const decideMode = useCallback(async (md, wanted) => {
    const seq = ++decideSeq.current
    startStage('mode')
    const finish = (m, blocked) => {
      if (seq !== decideSeq.current) return // user picked a mode meanwhile
      if (m === 'rich') startStage('editor')
      setMode(m); setRichBlocked(blocked); endStage('mode')
    }
    if (wanted !== 'rich') { finish(wanted, false); return }
    // Cheap, synchronous guard only; the full content check runs on the real editor (onEditorReady).
    if (hasUnsupported(md)) { finish('markdown', true); return }
    richOrig.current = md
    richVerified.current = false
    finish('rich', false)
  }, [endStage])

  // Paint a note into the editor (from the cache or the server).
  const apply = useCallback((n) => {
    const server = { markdown: n.markdown ?? n.body ?? '', properties: { ...(n.properties || {}), tags: n.properties?.tags ?? n.tags ?? [] } }
    setNote(n)
    endStage('note')
    dispatch({ type: 'LOAD', hash: n.content_hash })
    const buffered = loadDraft(noteId)
    if (buffered && (buffered.markdown !== server.markdown || JSON.stringify(buffered.properties) !== JSON.stringify(server.properties))) {
      setDraft({ markdown: buffered.markdown, properties: buffered.properties || server.properties })
      setRestored(true)
      dispatch({ type: 'EDIT' })
      if (modeRef.current == null || modeRef.current === 'rich') decideMode(buffered.markdown, modeRef.current ?? loadMode())
    } else {
      setDraft(server)
      if (modeRef.current == null || modeRef.current === 'rich') decideMode(server.markdown, modeRef.current ?? loadMode())
      clearDraft(noteId)
    }
  }, [noteId, decideMode, endStage])

  // Cached copy first (instant open), then the server: a newer content_hash replaces it unless
  // the user already started editing, which routes through the conflict banner instead.
  const load = useCallback(async () => {
    setLoadErr('')
    startStage('note')
    const cached = getCachedNote(noteId)
    if (cached) apply(cached)
    try {
      const n = await fetchNote(noteId, api.getNote)
      if (!cached) { apply(n); return }
      if (n.content_hash === cached.content_hash) return
      const st = stateRef.current
      if (!st.dirty) apply(n)
      else if (st.status !== 'conflict') dispatch({ type: 'SAVE_CONFLICT', currentHash: n.content_hash })
    } catch (e) { if (!cached) setLoadErr(e.message) }
  }, [noteId, apply])

  useEffect(() => { load() }, [load])

  // The agent (or anything else) may have written this note. Clean: reload it. Unsaved local edits:
  // never overwrite them, route a changed server hash through the existing conflict banner.
  const firstTick = useRef(refreshTick)
  useEffect(() => {
    if (refreshTick === firstTick.current) return undefined
    let live = true
    ;(async () => {
      try {
        forgetNote(noteId)
        const n = await fetchNote(noteId, api.getNote)
        if (!live) return
        const st = stateRef.current
        if (n.content_hash === st.baseHash) return
        if (st.status === 'saved' && !st.dirty) apply(n)
        else if (st.status !== 'conflict') dispatch({ type: 'SAVE_CONFLICT', currentHash: n.content_hash })
      } catch { /* best effort: the next edit or save surfaces real errors */ }
    })()
    return () => { live = false }
  }, [refreshTick])

  const save = useCallback(async () => {
    const d = draftRef.current
    const baseHash = stateRef.current.baseHash
    dispatch({ type: 'SAVE_START' })
    try {
      const res = await api.updateNote(noteId, { markdown: d.markdown, properties: d.properties, base_hash: baseHash })
      dispatch({ type: 'SAVE_OK', hash: res.note.content_hash })
      setNote(res.note)
      putNote(res.note)
      if (draftRef.current === d) { clearDraft(noteId); setRestored(false) }
      if (!res.unchanged) setRevTick((t) => t + 1)
      onSaved?.(res.note)
    } catch (e) {
      if (e.status === 409) dispatch({ type: 'SAVE_CONFLICT', currentHash: e.body?.current_hash })
      else dispatch({ type: 'SAVE_ERROR', message: e.message })
    }
  }, [noteId, onSaved])

  useEffect(() => {
    if (!shouldAutosave(state)) return undefined
    const t = setTimeout(save, autosaveMs)
    return () => clearTimeout(t)
  }, [state, draft, save, autosaveMs])

  const edit = (next) => { setDraft(next); saveDraft(noteId, next); dispatch({ type: 'EDIT' }) }

  const loadLatest = async () => { clearDraft(noteId); setRestored(false); forgetNote(noteId); await load() }
  const keepMine = async () => {
    try {
      const { note: n } = await api.getNote(noteId)
      dispatch({ type: 'KEEP_MINE', hash: n.content_hash })
    } catch (e) { dispatch({ type: 'SAVE_ERROR', message: e.message }) }
  }

  // Wikilink autocomplete: detect on every input/caret move, fetch titles debounced.
  const refreshTrigger = (value, caret) => { setTrigger(detectWikilinkTrigger(value, caret)); setPick(0) }
  useEffect(() => {
    if (!trigger) { setTitles([]); return undefined }
    let live = true
    const t = setTimeout(() => {
      api.searchTitles({ scope: scope === 'all' ? 'all' : scope, q: trigger.query })
        .then((r) => { if (live) setTitles((r.titles || []).slice(0, 8)) })
        .catch(() => { if (live) setTitles([]) })
    }, 150)
    return () => { live = false; clearTimeout(t) }
  }, [trigger, scope])

  const insertTitle = (title) => {
    const ta = taRef.current
    if (!ta || !trigger) return
    const r = applyWikilink(draft.markdown, trigger, ta.selectionStart, title)
    edit({ ...draft, markdown: r.text })
    setTrigger(null)
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(r.caret, r.caret) })
  }
  // Apply a pure transform result to the textarea. execCommand('insertText')
  // keeps the browser undo stack; it fires a normal input event, which runs the
  // regular onChange -> edit() -> autosave path. Without it (jsdom, old
  // browsers) setRangeText + an explicit edit() does the same job.
  const commit = (ta, r) => {
    const { from, toOld, insert } = diffRange(ta.value, r.text)
    ta.focus()
    ta.setSelectionRange(from, toOld)
    let ok = false
    try { ok = typeof document.execCommand === 'function' && (insert === '' ? document.execCommand('delete') : document.execCommand('insertText', false, insert)) } catch { ok = false }
    if (!ok || ta.value !== r.text) {
      ta.setRangeText(insert, from, toOld, 'end')
      edit({ ...draftRef.current, markdown: ta.value })
    }
    ta.setSelectionRange(r.start, r.end)
    refreshTrigger(ta.value, r.end)
  }
  // Stage (c): started in decideMode when rich is chosen, ended by onReady once TipTap is mounted.
  // Readiness resets on LEAVING rich (child effects run before parent ones, so never on entry).
  useEffect(() => { if (mode !== 'rich') { t0.current.editor = null; setEditorReady(false) } }, [mode])
  const onEditorReady = useCallback((ed) => {
    if (!richVerified.current) {
      let ok = false
      try { ok = contentOf(ed.getMarkdown()) === contentOf(richOrig.current) } catch { ok = false }
      if (!ok) { setMode('markdown'); setRichBlocked(true); endStage('editor'); return }
      richVerified.current = true
    }
    setEditorReady(true); endStage('editor')
  }, [endStage])
  const waiting = !!note && (mode == null || (mode === 'rich' && !editorReady))
  // Safety net: a rich editor that never mounts falls back to markdown on its own.
  useEffect(() => {
    if (mode !== 'rich' || editorReady) return undefined
    const t = setTimeout(() => { setMode('markdown'); setRichBlocked(true) }, GIVE_UP_MS)
    return () => clearTimeout(t)
  }, [mode, editorReady])
  useEffect(() => {
    if (!waiting) { setSlow(false); setSlowDismissed(false); return undefined }
    const t = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(t)
  }, [waiting])
  // Escape hatch: markdown for this note only, remembered preference untouched.
  const openMarkdownOnce = () => { decideSeq.current += 1; setMode('markdown'); setRichBlocked(false) }

  const chooseMode = (m) => {
    decideSeq.current += 1
    saveMode(m)
    if (m === 'rich') decideMode(draftRef.current.markdown, 'rich')
    else { setMode(m); setRichBlocked(false) }
  }
  // Markdown-mode attachments: a placeholder is inserted at the caret, then swapped for the final
  // markdown (or removed on failure) through edit(), so autosave sees it like any typing. Uploads
  // never block typing. Deleting a reference never deletes the stored file (revisions may use it).
  const attachFiles = (files) => {
    const ta = taRef.current
    if (!files.length) return
    setAttachErr(''); setAttachNote('')
    files.map(prepareFile).forEach((file) => {
      const cur = draftRef.current.markdown
      const at = ta ? Math.min(ta.selectionEnd, cur.length) : cur.length
      const ph = placeholderText(file.name)
      const pad = (at > 0 && cur[at - 1] !== '\n' ? '\n' : '')
      const next = cur.slice(0, at) + pad + ph + '\n' + cur.slice(at)
      draftRef.current = { ...draftRef.current, markdown: next }
      edit(draftRef.current)
      uploadFile(file).then((a) => {
        if (a.notice) setAttachNote(a.notice)
        const md = draftRef.current.markdown
        edit({ ...draftRef.current, markdown: replacePlaceholder(md, file.name, a.markdown) })
      }).catch((e) => {
        edit({ ...draftRef.current, markdown: replacePlaceholder(draftRef.current.markdown, file.name, '') })
        setAttachErr(e.message)
      })
    })
  }
  const runAction = (id) => {
    if (id === 'attach') { fileInput.current?.click(); return }
    if (id === 'camera') { cameraInput.current?.click(); return }
    const ta = taRef.current
    if (!ta) return
    const r = formatAction(id, { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd })
    if (r) commit(ta, r)
  }
  const toggleTaskAt = (i) => {
    const next = toggleTask(draftRef.current.markdown, i)
    if (next != null) edit({ ...draftRef.current, markdown: next })
  }

  const onKeyDown = (e) => {
    if (trigger && titles.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPick((p) => (p + 1) % titles.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPick((p) => (p - 1 + titles.length) % titles.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertTitle(titles[pick].title); return }
      if (e.key === 'Escape') { e.preventDefault(); setTrigger(null); return }
    }
    if (e.nativeEvent?.isComposing) return
    const ta = e.currentTarget
    const mod = e.ctrlKey || e.metaKey
    if (mod && !e.altKey) {
      const hit = SHORTCUTS.find((x) => !!x.shift === e.shiftKey && (x.code ? e.code === x.code : e.key.toLowerCase() === x.key))
      if (hit) { e.preventDefault(); runAction(hit.id) }
      return
    }
    if (e.altKey || (e.shiftKey && e.key !== 'Tab')) return
    if (e.key === 'Enter' && ta.selectionStart === ta.selectionEnd) {
      const r = continueList(ta.value, ta.selectionStart)
      if (r) { e.preventDefault(); commit(ta, { text: r.text, start: r.caret, end: r.caret }) }
    } else if (e.key === 'Tab') {
      const r = indentLines(ta.value, ta.selectionStart, ta.selectionEnd, e.shiftKey)
      if (r) { e.preventDefault(); commit(ta, r) }
    }
  }

  if (loadErr) {
    return (
      <section className="nq-pane nq-pane--doc qx-card">
        <div className="qx-banner qx-banner--error" role="alert">
          <span>Could not load this note. {loadErr}</span>
          <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={load}><RefreshIcon /> Retry</button>
        </div>
      </section>
    )
  }
  if (!note) {
    return (
      <section className="nq-pane nq-pane--doc qx-card" aria-busy="true" data-nq-wait="note">
        <div className="qx-skeleton qx-skeleton--line-lg" /><div className="qx-skeleton qx-skeleton--block" />
      </section>
    )
  }

  const title = deriveTitle(draft.markdown) || note.title
  return (
    <div className="nq-pane nq-pane--doc nq-doc" data-rail={rail && !focus ? 'open' : 'closed'}>
      <div className="nq-doc__main">
        <header className="qx-card qx-card--bar nq-bar">
          <div className="nq-bar__id">
            {focus && onToggleFocus ? (
              <button type="button" className="qx-btn qx-btn--primary qx-btn--sm nq-exit-focus" onClick={onToggleFocus}
                aria-label="Exit focus" title="Exit focus (Esc)"><FocusExitIcon /> Exit focus <kbd className="qx-kbd">Esc</kbd></button>
            ) : null}
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm nq-back" onClick={onBack}><ChevronLeftIcon /> Notes</button>
            <strong className="nq-bar__title" title={title}>{title}</strong>
            <span className={`qx-pill qx-pill--xs ${note.scope === 'org' ? 'qx-pill--info' : 'qx-pill--purple'}`}>{note.scope === 'org' ? 'Org' : 'Personal'}</span>
            <span className={`qx-pill qx-pill--sm ${STATUS_PILL[state.status]}`} role="status" aria-live="polite">{STATUS_LABEL[state.status]}</span>
            {state.status === 'error' ? (
              <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => { dispatch({ type: 'RETRY' }) }}><RefreshIcon /> Retry</button>
            ) : null}
          </div>
          <div className="qx-seg nq-bar__mode" role="group" aria-label="Mode">
            <button type="button" className={`qx-seg__btn${mode === 'rich' ? ' qx-seg__btn--active' : ''}`} onClick={() => chooseMode('rich')} aria-label="Rich" title="Edit with formatting, no markdown needed"><EditIcon /> <span className="nq-btn-label">Rich</span></button>
            <button type="button" className={`qx-seg__btn${mode === 'markdown' ? ' qx-seg__btn--active' : ''}`} onClick={() => chooseMode('markdown')} aria-label="Markdown" title="Edit the raw markdown"><CodeIcon /> <span className="nq-btn-label">Markdown</span></button>
            <button type="button" className={`qx-seg__btn${mode === 'read' ? ' qx-seg__btn--active' : ''}`} onClick={() => chooseMode('read')} aria-label="Read" title="Read the rendered note"><EyeIcon /> <span className="nq-btn-label">Read</span></button>
          </div>
          <div className="nq-bar__tools">
            <TextSizeControl zoom={zoom} onChange={changeZoom} />
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" aria-pressed={rail && !focus} disabled={focus} onClick={() => setRail((r) => !r)}
              aria-label="Details" title="Details panel"><SidebarIcon /> <span className="nq-btn-label">Details</span></button>
            {onAgent ? (
              <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" aria-pressed={!!agentOpen} onClick={onAgent}
                aria-label="Agent" title="Ask the NotesQ agent"><ChatIcon /> <span className="nq-btn-label">Agent</span></button>
            ) : null}
            {onToggleFocus && !focus ? (
              <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm nq-wide-only" aria-pressed={focus} onClick={onToggleFocus}
                aria-label={focus ? 'Exit focus' : 'Focus'} title={focus ? 'Leave focus mode (Esc)' : 'Focus: hide the sidebars for more room'}>
                {focus ? <FocusExitIcon /> : <FocusIcon />} <span className="nq-btn-label">{focus ? 'Exit focus' : 'Focus'}</span>
              </button>
            ) : null}
          </div>
        </header>

        <NotesQAgentEditBar noteId={noteId} contentHash={note.content_hash} revTick={revTick} dirty={!!state.dirty}
          onReload={async () => { clearDraft(noteId); setRestored(false); await load(); setRevTick((t) => t + 1); onSaved?.() }} />

        {state.status === 'conflict' ? (
          <div className="qx-banner qx-banner--warn" role="alert">
            <span>This note changed elsewhere while you were editing. Autosave is paused and your text is kept.</span>
            <span className="qx-row qx-row--tight">
              <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={loadLatest}><RefreshIcon /> Load latest</button>
              <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={keepMine}><CheckIcon /> Keep mine (overwrite)</button>
            </span>
          </div>
        ) : null}
        {state.status === 'error' ? <div className="qx-banner qx-banner--error" role="alert">{state.error}. Your text is kept locally; edit or retry to save again.</div> : null}
        {richBlocked ? (
          <div className="qx-banner qx-banner--info" role="status">
            <span>This note uses markdown that Rich mode cannot reproduce exactly (for example HTML, tables or footnotes), so it opened in Markdown mode to keep your text untouched.</span>
          </div>
        ) : null}
        {attachNote && mode === 'markdown' ? (
          <div className="qx-banner qx-banner--info" role="status">
            <span>{attachNote}</span>
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setAttachNote('')}><XIcon /> Dismiss</button>
          </div>
        ) : null}
        {attachErr && mode === 'markdown' ? (
          <div className="qx-banner qx-banner--error" role="alert">
            <span>{attachErr}</span>
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setAttachErr('')}><XIcon /> Dismiss</button>
          </div>
        ) : null}
        {restored ? <div className="qx-banner qx-banner--info">Restored an unsaved draft from this browser.</div> : null}

        <div className={`nq-doc__body qx-slate qx-card qx-card--compact${mode === 'read' ? '' : ' nq-doc__body--edit'}`} data-mode={mode}
          style={{ '--qx-text-zoom': zoom }}
          data-nq-ms-note={ms.note} data-nq-ms-mode={ms.mode} data-nq-ms-editor={ms.editor}>
          {waiting && slow && !slowDismissed ? (
            <div className="qx-banner qx-banner--info" role="status">
              <span>The rich editor is taking longer than usual.</span>
              <span className="qx-row qx-row--tight">
                <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={openMarkdownOnce}><CodeIcon /> Open in Markdown</button>
                <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setSlowDismissed(true)}><HistoryIcon /> Keep waiting</button>
              </span>
            </div>
          ) : null}
          {mode == null ? (
            <Skeleton wait="mode" />
          ) : mode === 'read' ? (
            draft.markdown.trim() ? (
              <NotesQMarkdown markdown={draft.markdown} onToggleTask={toggleTaskAt} />
            ) : (
              <div className="qx-empty"><div className="qx-empty__title">Nothing to read yet</div><div className="qx-empty__body">Switch to Rich or Markdown and start writing.</div></div>
            )
          ) : mode === 'rich' ? (
            <RichBoundary onMarkdown={openMarkdownOnce}>
              {!editorReady ? <Skeleton wait="editor" /> : null}
              <Suspense fallback={null}>
                <NotesQRichEditor markdown={draft.markdown} scope={scope} noteId={noteId} onReady={onEditorReady}
                  onChange={(md) => { if (richVerified.current) edit({ ...draftRef.current, markdown: md }) }} />
              </Suspense>
            </RichBoundary>
          ) : (
            <div className="nq-edit">
              <NotesQToolbar onAction={runAction} />
              <input ref={fileInput} type="file" multiple hidden aria-label="Attach files" tabIndex={-1}
                onChange={(e) => { attachFiles(Array.from(e.target.files || [])); e.target.value = '' }} />
              <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden aria-label="Take photo" tabIndex={-1}
                onChange={(e) => { attachFiles(Array.from(e.target.files || [])); e.target.value = '' }} />
              <div className="nq-edit__area">
                <div className="nq-edit__pane">
                  <textarea ref={taRef} className="qx-textarea qx-textarea--mono nq-editor" value={draft.markdown} spellCheck
                    aria-label="Note markdown" placeholder="Write in markdown. Type [[ to link another note."
                    onChange={(e) => { edit({ ...draft, markdown: e.target.value }); refreshTrigger(e.target.value, e.target.selectionStart) }}
                    onKeyDown={onKeyDown}
                    onPaste={(e) => {
                      const files = Array.from(e.clipboardData?.files || [])
                      if (files.length && !e.clipboardData.getData('text/plain')) { e.preventDefault(); attachFiles(files) }
                    }}
                    onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault() }}
                    onDrop={(e) => {
                      const files = Array.from(e.dataTransfer?.files || [])
                      if (files.length) { e.preventDefault(); attachFiles(files) }
                    }}
                    onClick={(e) => refreshTrigger(e.target.value, e.target.selectionStart)}
                    onBlur={() => setTimeout(() => setTrigger(null), 150)} />
                  {trigger && titles.length > 0 ? (
                    <div className="qx-menu nq-menu-anchor" role="listbox" aria-label="Link to note">
                      {titles.map((t, i) => (
                        <button key={t.id} type="button" role="option" aria-selected={i === pick}
                          className={`qx-menu__item${i === pick ? ' qx-menu__item--active' : ''}`}
                          onMouseDown={(e) => { e.preventDefault(); insertTitle(t.title) }}>
                          {t.title}<span className="qx-menu__meta">{t.scope === 'org' ? 'Org' : 'Personal'}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {rail && !focus ? (
        <div className="nq-doc__rail">
          <NotesQRail onHide={() => setRail(false)} note={note} properties={draft.properties} collections={collections}
            onProps={(props) => edit({ ...draft, properties: props })}
            revisionTick={revTick}
            onRestored={async () => { clearDraft(noteId); setRestored(false); await load(); setRevTick((t) => t + 1); onSaved?.() }}
            onDeleted={onDeleted} onOpenNote={onOpenNote}
            onDuplicated={(id) => { onSaved?.(); onOpenNote?.(id) }}
            onBridged={async () => { if (!stateRef.current.dirty) await load() }}
            dirty={!!state.dirty}
            onRefresh={async () => { clearDraft(noteId); await load(); setRevTick((t) => t + 1); onSaved?.() }} />
        </div>
      ) : null}
    </div>
  )
}
