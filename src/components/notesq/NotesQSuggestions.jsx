/** Details-rail "Suggested links" (AQ-9D P5): notes mentioned by title but not linked, and related notes not yet linked. Mirrors `quox notes suggest`. */
import { useEffect, useState } from 'react'
import { api } from './lib/api'
import { linkMention, addSeeAlso } from './lib/noteLinks'
import { LinkIcon } from './icons'

const CONFLICT = 'The note changed meanwhile. Reload and try again.'

export default function NotesQSuggestions({ note, dirty = false, onRefresh, onOpenNote }) {
  const [data, setData] = useState(null)
  const [loadErr, setLoadErr] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let live = true
    setData(null); setLoadErr(''); setErr('')
    Promise.resolve().then(() => api.getSuggestions(note.id, { limit: 8 }))
      .then((r) => { if (live) setData(r) })
      .catch((e) => { if (live) setLoadErr(e.message) })
    return () => { live = false }
  }, [note.id, note.content_hash])

  const write = async (id, nextMarkdown) => {
    setBusyId(id); setErr('')
    try {
      await api.updateNote(note.id, { markdown: nextMarkdown, properties: note.properties || {}, base_hash: note.content_hash })
      await onRefresh?.()
    } catch (e) {
      setErr(e.status === 409 ? CONFLICT : e.message)
    } finally { setBusyId(null) }
  }
  const link = (m) => {
    const r = linkMention(note.markdown || '', m.title)
    if (!r.changed) { setErr(`Could not find "${m.title}" as plain text in the saved note.`); return }
    write(m.id, r.markdown)
  }
  const seeAlso = (rel) => write(rel.id, addSeeAlso(note.markdown || '', rel.title))

  const mentions = data?.mentions || []
  const related = data?.related || []
  const empty = data && mentions.length === 0 && related.length === 0
  const title = (n) => <button type="button" className="nq-cell-link" onClick={() => onOpenNote?.(n.id)}>{n.title || n.id}</button>

  return (
    <section className="qx-card qx-card--compact qx-stack qx-stack--compact" aria-label="Suggested links">
      <div className="qx-section-title">Suggested links</div>
      {loadErr ? <div className="qx-banner qx-banner--error" role="status">Could not load suggestions. {loadErr}</div> : null}
      {err ? <div className="qx-banner qx-banner--error" role="alert">{err}</div> : null}
      {!data && !loadErr ? <div className="qx-skeleton qx-skeleton--line-md" aria-hidden="true" /> : null}
      {empty ? <div className="qx-hint qx-hint--sm">No suggestions: nothing in this notebook mentions another note&apos;s title.</div> : null}
      {dirty && data && !empty ? <div className="qx-hint qx-hint--sm">Save your changes first.</div> : null}
      {mentions.length ? <div className="qx-hint qx-hint--sm">Mentioned but not linked</div> : null}
      {mentions.map((m) => (
        <div key={m.id} className="nq-sugg-item" data-testid="nq-mention">
          <div className="nq-sugg">
            {title(m)}
            <span className="qx-pill qx-pill--xs qx-pill--ghost">{m.count}x</span>
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={dirty || busyId !== null} onClick={() => link(m)} aria-label={`Link ${m.title}`} title="Turn the first plain mention into a link"><LinkIcon /> Link</button>
          </div>
          {m.snippet ? <div className="qx-hint qx-hint--sm nq-sugg__snip" title={m.snippet}>{m.snippet}</div> : null}
        </div>
      ))}
      {related.length ? <div className="qx-hint qx-hint--sm">Related, not yet linked</div> : null}
      {related.slice(0, 5).map((r) => (
        <div key={r.id} className="nq-sugg" data-testid="nq-related" title={r.excerpt || undefined}>
          {title(r)}
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={dirty || busyId !== null} onClick={() => seeAlso(r)} aria-label={`Add ${r.title} to See also`} title="Add a link under See also"><LinkIcon /> See also</button>
        </div>
      ))}
    </section>
  )
}
