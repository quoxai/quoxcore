/**
 * Slim bar under the editor header: the latest revision was written by an
 * agent. View the diff against the previous revision, or undo in one click.
 * Undo is a restore of the previous revision, which itself creates a new
 * revision, so it is always undoable (Redo) and needs no confirmation.
 */
import { useEffect, useRef, useState } from 'react'
import { api } from './lib/api'
import { relativeTime } from './lib/listQuery'
import NotesQDiff from './NotesQDiff'
import { RestoreIcon, EyeIcon, RefreshIcon } from './icons'

const RECENT_MS = 24 * 3600 * 1000
// Newest revision this browser has seen, per note id. Memory only, by design.
const seenRev = new Map()
export const resetSeenRevisions = () => seenRev.clear()

export default function NotesQAgentEditBar({ noteId, contentHash, revTick = 0, dirty = false, onReload, now = Date.now }) {
  const [bar, setBar] = useState(null)        // { rev, prev, created_at }
  const [undone, setUndone] = useState(null)  // { agentRev }
  const [diff, setDiff] = useState(null)      // { from, to }
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const noteRef = useRef(noteId)

  useEffect(() => {
    if (noteRef.current !== noteId) { noteRef.current = noteId; setBar(null); setUndone(null); setDiff(null); setErr('') }
    let live = true
    Promise.resolve().then(() => api.listRevisions(noteId)).then((r) => {
      if (!live) return
      const revs = r.revisions || []
      const latest = revs[revs.length - 1]
      if (!latest) return
      const prev = revs.length > 1 ? revs[revs.length - 2].rev : null
      const seen = seenRev.get(noteId)
      const recent = Date.now() - Date.parse(latest.created_at) < RECENT_MS
      const fresh = seen === undefined ? recent : latest.rev > seen
      seenRev.set(noteId, latest.rev)
      if (latest.author_kind === 'agent' && fresh) { setBar({ rev: latest.rev, prev, created_at: latest.created_at }); setUndone(null) }
      else setBar((b) => (b && b.rev === latest.rev ? b : null))
    }).catch(() => { /* informational bar: stay hidden if the history cannot be read */ })
    return () => { live = false }
  }, [noteId, contentHash, revTick])

  const run = async (rev, after) => {
    setBusy(true); setErr('')
    try { await api.restoreRevision(noteId, rev); await onReload?.(); after() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const undo = () => run(bar.prev, () => { setUndone({ agentRev: bar.rev }); setBar(null) })
  const redo = () => run(undone.agentRev, () => setUndone(null))

  if (!bar && !undone) return null
  return (
    <>
      <div className="qx-banner qx-banner--info nq-agentbar" role="status" data-testid="nq-agentbar">
        {bar ? (
          <>
            <span>Edited by an agent {relativeTime(bar.created_at)}</span>
            <span className="qx-row qx-row--tight">
              {dirty ? <span className="qx-hint qx-hint--sm">Save or discard your changes first</span> : null}
              <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setDiff({ from: bar.prev, to: bar.rev })}><EyeIcon /> View changes</button>
              {bar.prev ? (
                <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" disabled={dirty || busy} onClick={undo}
                  title={dirty ? 'Save or discard your changes first' : 'Restore the version before this edit'}><RestoreIcon /> Undo</button>
              ) : null}
            </span>
          </>
        ) : (
          <>
            <span>Undone.</span>
            <span className="qx-row qx-row--tight">
              {dirty ? <span className="qx-hint qx-hint--sm">Save or discard your changes first</span> : null}
              <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" disabled={dirty || busy} onClick={redo}><RefreshIcon /> Redo</button>
            </span>
          </>
        )}
        {err ? <span role="alert">Could not complete that. {err}</span> : null}
      </div>
      {diff ? <NotesQDiff noteId={noteId} from={diff.from} to={diff.to} onClose={() => setDiff(null)} /> : null}
    </>
  )
}
