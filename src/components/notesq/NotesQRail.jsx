/** Right rail: properties, links, history, delete. */
import { useEffect, useState } from 'react'
import { api } from './lib/api'
import { tagChipClass } from './lib/tagHue'
import { normaliseTags, relativeTime } from './lib/listQuery'
import { SplitNote, BatchUndo } from './NotesQSplit'
import NotesQDiff from './NotesQDiff'
import NotesQSuggestions from './NotesQSuggestions'
import { SendTasks, AddToPlan, ProposeSkill } from './NotesQBridges'
import { RestoreIcon, TrashIcon, CheckIcon, XIcon, CopyIcon, ChevronsRightIcon } from './icons'

const STATUSES = ['', 'draft', 'active', 'done']
const TYPES = ['note', 'meeting', 'project', 'reference', 'journal']

function TagEditor({ tags, onChange }) {
  const [val, setVal] = useState('')
  const add = () => { const next = normaliseTags([...tags, ...val.split(',')]); setVal(''); if (next.length !== tags.length) onChange(next) }
  return (
    <div className="qx-tagfield">
      {tags.map((t) => (
        <span key={t} className={`qx-tagfield__tag ${tagChipClass(t)}`}>#{t}
          <button type="button" className="qx-tagfield__x" aria-label={`Remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}><XIcon size={10} /></button>
        </span>
      ))}
      <input className="qx-tagfield__input" value={val} placeholder="Add tag" aria-label="Add tag"
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } else if (e.key === 'Backspace' && !val && tags.length) onChange(tags.slice(0, -1)) }}
        onBlur={() => val.trim() && add()} />
    </div>
  )
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="qx-row qx-row--apart" style={{ cursor: 'pointer' }}>
      <span>{label}</span>
      <span className="qx-toggle"><input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} /><span className="qx-toggle__track" /></span>
    </label>
  )
}

/** Title the copy "<title> (copy)"; a note with no heading gets one. */
export function duplicateMarkdown(md) {
  const text = String(md || '')
  const m = /^\s*#\s+(.+)$/m.exec(text)
  if (m && text.trimStart().startsWith('# ')) return text.replace(m[0], `# ${m[1].trim()} (copy)`)
  return `# Untitled (copy)\n\n${text}`
}
// Bookkeeping that belongs to the original, not the copy.
const NOT_COPIED = new Set(['import_ref', 'source', 'pinned', 'batch_id', 'batch_session'])

export default function NotesQRail({ note, properties, onProps, collections, revisionTick, onRestored, onDeleted, onOpenNote, onDuplicated, onBridged, dirty = false, onRefresh, splitPollMs, onHide }) {
  const [revs, setRevs] = useState(null)
  const [revErr, setRevErr] = useState('')
  const [confirmRev, setConfirmRev] = useState(null)
  const [diffRev, setDiffRev] = useState(null) // { from, to }
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [delErr, setDelErr] = useState('')

  useEffect(() => {
    let live = true
    api.listRevisions(note.id).then((r) => { if (live) { setRevs(r.revisions || []); setRevErr('') } })
      .catch((e) => { if (live) setRevErr(e.message) })
    return () => { live = false }
  }, [note.id, revisionTick])

  const restore = async (rev) => {
    setBusy(true)
    try { const r = await api.restoreRevision(note.id, rev); setConfirmRev(null); onRestored(r.note) }
    catch (e) { setRevErr(e.message) } finally { setBusy(false) }
  }
  const [dupErr, setDupErr] = useState('')
  const duplicate = async () => {
    setBusy(true); setDupErr('')
    try {
      const props = Object.fromEntries(Object.entries(note.properties || {}).filter(([k]) => !NOT_COPIED.has(k)))
      const r = await api.createNote({ scope: note.scope, markdown: duplicateMarkdown(note.markdown), properties: props })
      onDuplicated?.(r.note.id)
    } catch (e) { setDupErr(e.message) } finally { setBusy(false) }
  }
  const del = async () => {
    setBusy(true); setDelErr('')
    try { await api.deleteNote(note.id); onDeleted() }
    catch (e) { setDelErr(e.status === 403 ? 'Only the author or an admin can delete this note.' : e.message); setConfirmDelete(false) }
    finally { setBusy(false) }
  }
  const p = properties || {}
  const tags = normaliseTags(p.tags || [])
  const links = (title, list) => (
    <div className="qx-stack qx-stack--tight">
      <div className="qx-section-title">{title}</div>
      {(list || []).length === 0 ? <div className="qx-hint qx-hint--sm">None.</div> : list.map((l, i) => {
        const id = typeof l === 'string' ? null : l.id
        const label = typeof l === 'string' ? l : (l.title || l.target || l.id)
        return id
          ? <button key={id + i} type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => onOpenNote(id)}>{label}</button>
          : <span key={label + i} className="qx-chip">{label}</span>
      })}
    </div>
  )

  return (
    <>
      <section className="qx-card qx-card--compact qx-stack qx-stack--compact" aria-label="Properties">
        <div className="qx-row qx-row--apart qx-row--tight">
          <div className="qx-section-title nq-grow">Properties</div>
          {onHide ? <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm nq-rail-hide" onClick={onHide}
            aria-label="Hide details" title="Hide details"><ChevronsRightIcon /></button> : null}
        </div>
        <div className="qx-field">
          <label className="qx-field__label" htmlFor="nq-coll">Collection</label>
          <input id="nq-coll" className="qx-input" list="nq-coll-list" value={p.collection || ''} placeholder="None"
            onChange={(e) => onProps({ ...p, collection: e.target.value })} />
          <datalist id="nq-coll-list">{(collections || []).map((c) => <option key={c.name} value={c.name} />)}</datalist>
        </div>
        <div className="qx-field">
          <span className="qx-field__label">Tags</span>
          <TagEditor tags={tags} onChange={(next) => onProps({ ...p, tags: next })} />
        </div>
        <div className="qx-row qx-row--fill">
          <div className="qx-field">
            <label className="qx-field__label" htmlFor="nq-type">Type</label>
            <select id="nq-type" className="qx-select" value={p.type || ''} onChange={(e) => onProps({ ...p, type: e.target.value })}>
              <option value="">None</option>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              {p.type && !TYPES.includes(p.type) ? <option value={p.type}>{p.type}</option> : null}
            </select>
          </div>
          <div className="qx-field">
            <label className="qx-field__label" htmlFor="nq-status">Status</label>
            <select id="nq-status" className="qx-select" value={p.status || ''} onChange={(e) => onProps({ ...p, status: e.target.value })}>
              {STATUSES.map((s) => <option key={s} value={s}>{s || 'None'}</option>)}
              {p.status && !STATUSES.includes(p.status) ? <option value={p.status}>{p.status}</option> : null}
            </select>
          </div>
        </div>
        <Toggle label="Pinned" checked={p.pinned} onChange={(v) => onProps({ ...p, pinned: v })} />
        <Toggle label="Archived" checked={p.archived} onChange={(v) => onProps({ ...p, archived: v })} />
      </section>

      <section className="qx-card qx-card--compact qx-stack qx-stack--compact" aria-label="Links">
        {links('Backlinks', note.backlinks)}
        {links('Outlinks', note.outlinks)}
      </section>

      <NotesQSuggestions note={note} dirty={dirty} onRefresh={onRefresh} onOpenNote={onOpenNote} />

      <section className="qx-card qx-card--compact qx-stack qx-stack--compact" aria-label="History">
        <div className="qx-section-title">History</div>
        {revErr ? <div className="qx-banner qx-banner--error" role="alert">{revErr}</div> : null}
        {revs === null && !revErr ? <div className="qx-skeleton qx-skeleton--line-md" aria-hidden="true" /> : null}
        {revs && revs.length === 0 ? <div className="qx-hint qx-hint--sm">No revisions yet.</div> : null}
        {(revs || []).map((r, i) => (
          <div key={r.rev} className="qx-stack qx-stack--tight">
            <div className="qx-row qx-row--apart qx-row--tight">
              <span>
                <strong>#{r.rev}</strong> <span className="qx-pill qx-pill--xs qx-pill--ghost">{r.action}</span>
                {r.author_kind && r.author_kind !== 'user' ? <span className="qx-pill qx-pill--xs qx-pill--purple">{r.author_kind}</span> : null}
              </span>
              <span className="qx-hint qx-hint--sm">{relativeTime(r.created_at)}</span>
            </div>
            {confirmRev === r.rev ? (
              <div className="qx-row qx-row--tight">
                <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" disabled={busy} onClick={() => restore(r.rev)}><CheckIcon /> Restore #{r.rev}</button>
                <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setConfirmRev(null)}><XIcon /> Cancel</button>
              </div>
            ) : (
              <div className="qx-row qx-row--tight">
                <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setConfirmRev(r.rev)}><RestoreIcon /> Restore</button>
                <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setDiffRev({ from: i > 0 ? revs[i - 1].rev : null, to: r.rev })}>Compare with previous</button>
              </div>
            )}
          </div>
        ))}
        {diffRev ? <NotesQDiff noteId={note.id} from={diffRev.from} to={diffRev.to} onClose={() => setDiffRev(null)} /> : null}
      </section>

      <section className="qx-card qx-card--compact qx-stack qx-stack--compact" aria-label="Send to">
        <SendTasks note={note} onBridged={onBridged} />
        <AddToPlan note={note} properties={properties} onBridged={onBridged} />
        <ProposeSkill note={note} properties={properties} dirty={dirty} onRefresh={onRefresh} />
      </section>

      <SplitNote note={note} dirty={dirty} onRefresh={onRefresh} pollMs={splitPollMs} />
      <BatchUndo note={note} />

      <section className="qx-card qx-card--compact qx-stack qx-stack--compact" aria-label="Duplicate">
        {dupErr ? <div className="qx-banner qx-banner--error" role="alert">Could not duplicate. {dupErr}</div> : null}
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy} onClick={duplicate}><CopyIcon /> Duplicate note</button>
      </section>

      <section className="qx-card qx-card--compact qx-stack qx-stack--compact" aria-label="Delete">
        {delErr ? <div className="qx-banner qx-banner--error" role="alert">{delErr}</div> : null}
        {confirmDelete ? (
          <div className="qx-stack qx-stack--tight">
            <span>Delete this note? It stays in history.</span>
            <div className="qx-row qx-row--tight">
              <button type="button" className="qx-btn qx-btn--danger qx-btn--sm" disabled={busy} onClick={del}><TrashIcon /> Delete note</button>
              <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setConfirmDelete(false)}><XIcon /> Cancel</button>
            </div>
          </div>
        ) : (
          <button type="button" className="qx-btn qx-btn--danger qx-btn--sm" onClick={() => { setDelErr(''); setConfirmDelete(true) }}><TrashIcon /> Delete note</button>
        )}
      </section>
    </>
  )
}
