/** Notebook health dialog (AQ-9D P5): possible duplicates, stale but linked notes, broken links. Mirrors `quox notes health`. */
import { useEffect, useRef, useState } from 'react'
import { api } from './lib/api'
import { relativeTime } from './lib/listQuery'
import { XIcon } from './icons'

const STALE_OPTS = [90, 180, 365]

export function groupLabel(g) {
  if (g.kind === 'exact') return 'Identical'
  if (g.kind === 'title') return 'Same title'
  return `Similar ${Math.round((g.similarity || 0) * 100)}%`
}

export default function NotesQHealthDialog({ defaultScope = 'org', onClose, onOpenNote }) {
  const [scope, setScope] = useState(defaultScope)
  const [staleDays, setStaleDays] = useState(180)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const dialogRef = useRef(null)

  useEffect(() => { dialogRef.current?.focus() }, [])
  useEffect(() => {
    let live = true
    setData(null); setError('')
    Promise.resolve().then(() => api.getHealth({ scope, staleDays }))
      .then((r) => { if (live) setData(r) })
      .catch((e) => { if (live) setError(`Could not scan the notebook. ${e.message}`) })
    return () => { live = false }
  }, [scope, staleDays])

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
    if (e.key === 'Tab' && dialogRef.current) {
      const els = [...dialogRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      if (!els.length) return
      const first = els[0]; const last = els[els.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }

  const open = (n) => <button type="button" className="nq-cell-link" onClick={() => onOpenNote(n.id)}>{n.title || n.id}</button>
  const dups = data?.duplicates || []
  const stale = data?.stale || []
  const broken = data?.broken_links || []

  return (
    <div className="qx-modal-overlay" style={{ padding: '0 16px' }} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={dialogRef} className="qx-modal" style={{ maxWidth: 640, outline: 'none' }} role="dialog" aria-modal="true"
        aria-labelledby="nq-health-title" tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="qx-modal__header">
          <h2 id="nq-health-title">Notebook health</h2>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose} aria-label="Close"><XIcon /></button>
        </div>
        <div className="qx-modal__body qx-stack qx-stack--compact" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <div className="qx-row qx-row--fill">
            <div className="qx-field">
              <label className="qx-field__label" htmlFor="nq-health-scope">Scope</label>
              <select id="nq-health-scope" className="qx-select" value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="org">Org</option>
                <option value="user">Personal</option>
              </select>
            </div>
            <div className="qx-field">
              <label className="qx-field__label" htmlFor="nq-health-stale">Stale after</label>
              <select id="nq-health-stale" className="qx-select" value={staleDays} onChange={(e) => setStaleDays(Number(e.target.value))}>
                {STALE_OPTS.map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </div>
          </div>
          {error ? <div className="qx-banner qx-banner--error" role="alert">{error}</div> : null}
          {!data && !error ? <div className="qx-hint" role="status">Scanning notes...</div> : null}
          {data ? (
            <>
              <div className="qx-hint qx-hint--sm" data-testid="nq-health-scanned">Scanned {data.scanned} notes</div>
              {data.truncated ? <div className="qx-banner qx-banner--warning" role="status">This notebook is larger than one scan covers, so only the 2000 most recently updated notes were checked.</div> : null}

              <section className="qx-stack qx-stack--tight" aria-label="Possible duplicates">
                <div className="qx-section-title">Possible duplicates ({dups.length})</div>
                {dups.length === 0 ? <div className="qx-hint qx-hint--sm">No duplicates found.</div> : null}
                {dups.map((g, i) => (
                  <div key={i} className="qx-stack qx-stack--tight" data-testid="nq-dup-group">
                    <span className="qx-pill qx-pill--xs qx-pill--ghost nq-pill-start">{groupLabel(g)}</span>
                    {(g.notes || []).map((n) => (
                      <div key={n.id} className="qx-row qx-row--apart qx-row--tight">
                        {open(n)}
                        <span className="qx-hint qx-hint--sm">{relativeTime(n.updated_at)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </section>

              <section className="qx-stack qx-stack--tight" aria-label="Stale but linked">
                <div className="qx-section-title">Stale but linked ({stale.length})</div>
                {stale.length === 0 ? <div className="qx-hint qx-hint--sm">No notes are both stale and relied on by other notes.</div> : null}
                {stale.map((n) => (
                  <div key={n.id} className="qx-row qx-row--apart qx-row--tight" data-testid="nq-stale-row">
                    {open(n)}
                    <span className="qx-hint qx-hint--sm">updated {relativeTime(n.updated_at)}, {n.backlinks} backlink{n.backlinks === 1 ? '' : 's'}</span>
                  </div>
                ))}
              </section>

              <section className="qx-stack qx-stack--tight" aria-label="Broken links">
                <div className="qx-section-title">Broken links ({broken.length})</div>
                {broken.length === 0 ? <div className="qx-hint qx-hint--sm">No broken links.</div> : null}
                {broken.map((b, i) => (
                  <div key={i} className="qx-row qx-row--apart qx-row--tight" data-testid="nq-broken-row">
                    <span>{open(b.source)} <span className="qx-hint qx-hint--sm">links to</span> <code>[[{b.target_raw}]]</code></span>
                    <span className="qx-pill qx-pill--xs qx-pill--ghost">{b.count}x</span>
                  </div>
                ))}
              </section>
            </>
          ) : null}
          <div className="qx-modal__actions">
            <button type="button" className="qx-btn qx-btn--ghost" onClick={onClose}><XIcon /> Close</button>
          </div>
        </div>
      </div>
    </div>
  )
}
