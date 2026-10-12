/**
 * Rich (WYSIWYG) mode. TipTap edits a document model but markdown stays the
 * canonical store: every change is serialised to markdown and pushed through
 * onChange, which is the same draft -> autosave path the textarea uses.
 * Lazy-loaded (see NotesQEditor) so TipTap stays out of the route's main chunk.
 */
import { useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import NotesQToolbar from './NotesQToolbar'
import { buildExtensions, uploadKey, placeholderPos } from './lib/richExtensions'
import { useAttachmentUpload, prepareFile } from './useAttachmentUpload'
import { api } from './lib/api'
import { CheckIcon, XIcon } from './icons'

const TRIGGER = /\[\[([^\]\n]*)$/

export default function NotesQRichEditor({ markdown, onChange, scope, noteId, onReady }) {
  const cb = useRef(onChange); cb.current = onChange
  const emitted = useRef(markdown)          // last markdown we produced; distinguishes our own echoes from external loads
  const [link, setLink] = useState(null)    // null | url string while the inline link form is open
  const [trigger, setTrigger] = useState(null) // { from, to, query } for the [[ autocomplete
  const [titles, setTitles] = useState([])
  const [pick, setPick] = useState(0)
  const live = useRef({}); live.current = { trigger, titles, pick }
  const [attachErr, setAttachErr] = useState('')
  const [attachNote, setAttachNote] = useState('')
  const fileInput = useRef(null)
  const cameraInput = useRef(null)
  const uploadFile = useAttachmentUpload(noteId)
  const attach = useRef(null)

  // Placeholders are decorations (never document text, never autosaved). The
  // stored file is not deleted if its link is later removed from the note:
  // revisions may still reference it.
  attach.current = (files, pos) => {
    const ed = editorRef.current
    if (!ed || !files.length) return
    setAttachErr(''); setAttachNote('')
    files.map(prepareFile).forEach((file, i) => {
      const id = `${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`
      const at = pos ?? ed.state.selection.to
      ed.view.dispatch(ed.state.tr.setMeta(uploadKey, { add: { id, pos: at, name: file.name } }))
      uploadFile(file).then((a) => {
        if (a.notice) setAttachNote(a.notice)
        const p = placeholderPos(ed.state, id)
        if (p == null) return
        const content = a.kind === 'image'
          ? { type: 'nqImage', attrs: { src: a.url, alt: a.label } }
          : { type: 'text', text: a.label, marks: [{ type: 'link', attrs: { href: a.url } }] }
        ed.chain().insertContentAt(p, content).run()
        ed.view.dispatch(ed.state.tr.setMeta(uploadKey, { remove: id }))
      }).catch((e) => {
        if (!ed.isDestroyed) ed.view.dispatch(ed.state.tr.setMeta(uploadKey, { remove: id }))
        setAttachErr(e.message)
      })
    })
  }
  const editorRef = useRef(null)

  const detect = (ed) => {
    const { $from, empty } = ed.state.selection
    if (!empty || !$from.parent.isTextblock) { setTrigger(null); return }
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\0')
    const m = TRIGGER.exec(before)
    if (!m || m[1].length > 80) { setTrigger(null); return }
    setTrigger({ from: $from.pos - m[0].length, to: $from.pos, query: m[1] })
    setPick(0)
  }

  const editor = useEditor({
    extensions: buildExtensions({ placeholder: 'Start writing. Type [[ to link another note.' }),
    content: markdown,
    contentType: 'markdown',
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { class: 'nq-prose', 'aria-label': 'Note text', role: 'textbox', 'aria-multiline': 'true' },
      handleKeyDown: (view, e) => {
        const { trigger: t, titles: ts, pick: p } = live.current
        if (t && ts.length > 0) {
          if (e.key === 'ArrowDown') { setPick((x) => (x + 1) % ts.length); return true }
          if (e.key === 'ArrowUp') { setPick((x) => (x - 1 + ts.length) % ts.length); return true }
          if (e.key === 'Enter' || e.key === 'Tab') { insertTitle(ts[p].title); return true }
          if (e.key === 'Escape') { setTrigger(null); e.preventDefault(); return true }
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openLink(); return true }
        return false
      },
      // Screenshots and files: pasted/dropped files upload; plain text/HTML pastes (no files, or files alongside text such as a spreadsheet range) stay with TipTap.
      handlePaste: (view, e) => {
        const cd = e.clipboardData
        const files = Array.from(cd?.files || [])
        if (!files.length || cd.getData('text/plain')) return false
        e.preventDefault()
        attach.current(files)
        return true
      },
      handleDrop: (view, e, slice, moved) => {
        const files = Array.from(e.dataTransfer?.files || [])
        if (moved || !files.length) return false
        e.preventDefault()
        attach.current(files, view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos)
        return true
      },
    },
    onUpdate: ({ editor: ed }) => {
      const md = ed.getMarkdown()
      emitted.current = md
      cb.current(md)
      detect(ed)
    },
    onSelectionUpdate: ({ editor: ed }) => detect(ed),
  })

  editorRef.current = editor

  // Signals the parent that TipTap is really mounted (not merely that the chunk resolved).
  useEffect(() => { if (editor) onReady?.(editor) }, [editor, onReady])

  // External change (Load latest, Restore revision): swap content without echoing it back as an edit.
  useEffect(() => {
    if (!editor || markdown === emitted.current) return
    emitted.current = markdown
    editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false })
  }, [markdown, editor])

  useEffect(() => {
    if (!trigger) { setTitles([]); return undefined }
    let alive = true
    const t = setTimeout(() => {
      api.searchTitles({ scope: scope === 'all' ? 'all' : scope, q: trigger.query })
        .then((r) => { if (alive) setTitles((r.titles || []).slice(0, 8)) })
        .catch(() => { if (alive) setTitles([]) })
    }, 150)
    return () => { alive = false; clearTimeout(t) }
  }, [trigger, scope])

  function insertTitle(title) {
    const t = live.current.trigger
    if (!editor || !t) return
    editor.chain().focus().deleteRange({ from: t.from, to: t.to }).insertContent({ type: 'wikilink', attrs: { title } }).run()
    setTrigger(null)
  }
  function openLink() { setLink(editor?.getAttributes('link').href || 'https://') }
  const applyLink = () => {
    const url = (link || '').trim()
    const chain = editor.chain().focus().extendMarkRange('link')
    if (!url || url === 'https://') chain.unsetLink().run()
    else chain.setLink({ href: url }).run()
    setLink(null)
  }

  const run = (id) => {
    if (!editor) return
    const c = editor.chain().focus()
    switch (id) {
      case 'bold': c.toggleBold().run(); break
      case 'italic': c.toggleItalic().run(); break
      case 'strike': c.toggleStrike().run(); break
      case 'h1': c.toggleHeading({ level: 1 }).run(); break
      case 'h2': c.toggleHeading({ level: 2 }).run(); break
      case 'h3': c.toggleHeading({ level: 3 }).run(); break
      case 'ul': c.toggleBulletList().run(); break
      case 'ol': c.toggleOrderedList().run(); break
      case 'check': c.toggleTaskList().run(); break
      case 'quote': c.toggleBlockquote().run(); break
      case 'code': c.toggleCode().run(); break
      case 'codeblock': c.toggleCodeBlock().run(); break
      case 'link': openLink(); break
      case 'notelink': c.insertContent('[[').run(); break   // opens the autocomplete through detect()
      case 'hr': c.setHorizontalRule().run(); break
      case 'attach': fileInput.current?.click(); break
      case 'camera': cameraInput.current?.click(); break
      default: break
    }
  }
  const isActive = (id) => {
    if (!editor) return false
    const map = { bold: 'bold', italic: 'italic', strike: 'strike', ul: 'bulletList', ol: 'orderedList', check: 'taskList', quote: 'blockquote', code: 'code', codeblock: 'codeBlock', link: 'link' }
    if (map[id]) return editor.isActive(map[id])
    const h = /^h([123])$/.exec(id)
    return h ? editor.isActive('heading', { level: Number(h[1]) }) : false
  }

  return (
    <div className="nq-edit">
      <NotesQToolbar onAction={run} isActive={isActive} />
      <input ref={fileInput} type="file" multiple hidden aria-label="Attach files" tabIndex={-1}
        onChange={(e) => { attach.current(Array.from(e.target.files || [])); e.target.value = '' }} />
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden aria-label="Take photo" tabIndex={-1}
        onChange={(e) => { attach.current(Array.from(e.target.files || [])); e.target.value = '' }} />
      {attachNote ? (
        <div className="qx-banner qx-banner--info" role="status">
          <span>{attachNote}</span>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setAttachNote('')}><XIcon /> Dismiss</button>
        </div>
      ) : null}
      {attachErr ? (
        <div className="qx-banner qx-banner--error" role="alert">
          <span>{attachErr}</span>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setAttachErr('')}><XIcon /> Dismiss</button>
        </div>
      ) : null}
      {link !== null ? (
        <div className="qx-row qx-row--tight nq-linkbar">
          <input className="qx-input" type="url" autoFocus value={link} aria-label="Link address" placeholder="https://"
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyLink() } else if (e.key === 'Escape') { setLink(null); editor?.commands.focus() } }} />
          <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={applyLink}><CheckIcon /> Apply</button>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => { setLink(null); editor?.commands.focus() }}><XIcon /> Cancel</button>
        </div>
      ) : null}
      <div className="nq-edit__area">
        <div className="nq-edit__pane nq-rich">
          <EditorContent editor={editor} className="nq-rich__content" />
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
  )
}
