/** Unified line diff of two note revisions, in a modal. Read-only. */
import { useEffect, useMemo, useState } from 'react'
import { api } from './lib/api'
import { lineDiff, parseDiff } from './lib/revisionDiff'
import { XIcon } from './icons'

/**
 * `from` and `to` are revision numbers; `from` may be null (no earlier revision:
 * everything shows as added). Fetches both bodies through api.getRevision.
 */
export default function NotesQDiff({ noteId, from, to, onClose }) {
  const [state, setState] = useState({ loading: true, err: '', before: '', after: '' })

  useEffect(() => {
    let live = true
    setState({ loading: true, err: '', before: '', after: '' })
    Promise.all([from ? api.getRevision(noteId, from) : Promise.resolve({ markdown: '' }), api.getRevision(noteId, to)])
      .then(([a, b]) => { if (live) setState({ loading: false, err: '', before: a.markdown || '', after: b.markdown || '' }) })
      .catch((e) => { if (live) setState({ loading: false, err: e.message, before: '', after: '' }) })
    return () => { live = false }
  }, [noteId, from, to])

  const diff = useMemo(() => lineDiff(state.before, state.after, { context: 3, maxLines: 400 }), [state.before, state.after])
  const rows = useMemo(() => parseDiff(diff.text), [diff])

  return (
    <div className="qx-modal-overlay" style={{ padding: '0 16px' }} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="qx-modal" style={{ maxWidth: 760, outline: 'none' }} role="dialog" aria-modal="true" aria-labelledby="nq-diff-title" tabIndex={-1}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <div className="qx-modal__header">
          <h2 id="nq-diff-title">{from ? `Changes from #${from} to #${to}` : `Revision #${to}`}</h2>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose} aria-label="Close"><XIcon /></button>
        </div>
        <div className="qx-modal__body qx-stack qx-stack--compact">
          {state.loading ? <div className="qx-skeleton qx-skeleton--block" aria-busy="true" /> : null}
          {state.err ? <div className="qx-banner qx-banner--error" role="alert">Could not load the revisions. {state.err}</div> : null}
          {!state.loading && !state.err ? (
            !diff.changed ? (
              <div className="qx-hint">No differences between these revisions.</div>
            ) : (
              <>
                <div className="qx-row qx-row--tight">
                  <span className="qx-pill qx-pill--xs qx-pill--success">+{diff.added}</span>
                  <span className="qx-pill qx-pill--xs qx-pill--danger">-{diff.removed}</span>
                </div>
                <div className="nq-diff" role="table" aria-label="Line changes">
                  {rows.map((r, i) => (
                    <div key={i} role="row" className={`nq-diff__row nq-diff__row--${r.kind}`} data-kind={r.kind}>
                      <span className="nq-diff__sign" aria-hidden="true">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ''}</span>
                      <span role="cell" className="nq-diff__text">{r.kind === 'gap' ? (r.text || 'Unchanged lines hidden') : (r.text || ' ')}</span>
                    </div>
                  ))}
                </div>
              </>
            )
          ) : null}
          <div className="qx-modal__actions">
            <button type="button" className="qx-btn qx-btn--ghost" onClick={onClose}><XIcon /> Close</button>
          </div>
        </div>
      </div>
    </div>
  )
}
