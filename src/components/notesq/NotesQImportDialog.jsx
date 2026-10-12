/** Import dialog: choose file -> dry-run preview -> confirm -> poll job -> summary. Nothing is written until confirm. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './lib/api'
import { UploadIcon, CheckIcon, XIcon, RefreshIcon } from './icons'

const POLL_MS = 1500
const MAX_BYTES = 100 * 1024 * 1024

function errText(e) {
  if (e?.status === 413) {
    const mb = e.body?.max_bytes ? Math.round(e.body.max_bytes / (1024 * 1024)) : 100
    return `That file is too large. The limit is ${mb} MB.`
  }
  if (e?.status === 402) return e.message || 'Import is not included in your licence.'
  return e?.message || 'Something went wrong.'
}

export default function NotesQImportDialog({ onClose, onDone }) {
  // step: choose | previewing | preview | running | done
  const [step, setStep] = useState('choose')
  const [file, setFile] = useState(null)
  const [scope, setScope] = useState('org')
  const [collection, setCollection] = useState('')
  const [preview, setPreview] = useState(null)
  const [job, setJob] = useState(null)
  const [error, setError] = useState('')
  const [jobId, setJobId] = useState(null)
  const dialogRef = useRef(null)
  const fileRef = useRef(null)
  const alive = useRef(true)
  const seq = useRef(0)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { dialogRef.current?.focus() }, [])

  const opts = () => ({ scope, collection: collection.trim() || undefined })

  const choose = useCallback(async (f) => {
    if (!f) return
    setFile(f); setError(''); setPreview(null)
    if (f.size > MAX_BYTES) { setError('That file is too large. The limit is 100 MB.'); setStep('choose'); return }
    const mine = ++seq.current
    setStep('previewing')
    try {
      const p = await api.previewImport(f, { scope, collection: collection.trim() || undefined })
      if (!alive.current || mine !== seq.current) return
      setPreview(p); setStep('preview')
    } catch (e) {
      if (!alive.current || mine !== seq.current) return
      setError(errText(e)); setStep('choose')
    }
  }, [scope, collection])

  const start = async () => {
    setError('')
    try {
      const res = await api.startImport(file, opts())
      if (!alive.current) return
      setJob({ status: 'running', total: preview?.notes ?? 0, created: 0, skipped: 0, failed: 0, errors: [] })
      setJobId(res.job_id); setStep('running')
    } catch (e) {
      if (alive.current) setError(errText(e))
    }
  }

  // Poll while running; the cleanup stops the timer on unmount and on done/failed.
  useEffect(() => {
    if (step !== 'running' || !jobId) return undefined
    let stopped = false
    let timer = null
    const tick = async () => {
      try {
        const j = await api.getImportJob(jobId)
        if (stopped) return
        setJob(j)
        if (j.status === 'done' || j.status === 'failed') { setStep('done'); onDone?.(); return }
        setError('')
      } catch (e) {
        if (stopped) return
        setError(`Could not read progress: ${errText(e)}. Still trying.`)
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [step, jobId, onDone])

  const running = step === 'running'
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && !running) { e.stopPropagation(); onClose(); return }
    if (e.key === 'Tab' && dialogRef.current) {
      const els = [...dialogRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      if (!els.length) return
      const first = els[0]; const last = els[els.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }

  const reset = () => { seq.current++; setFile(null); setPreview(null); setError(''); setStep('choose'); if (fileRef.current) fileRef.current.value = '' }
  const cols = preview ? Object.entries(preview.collections || {}) : []
  const failedItems = job?.errors || []

  return (
    <div className="qx-modal-overlay" style={{ padding: '0 16px' }} onClick={(e) => { if (e.target === e.currentTarget && !running) onClose() }}>
      <div ref={dialogRef} className="qx-modal" style={{ maxWidth: 560, outline: 'none' }} role="dialog" aria-modal="true"
        aria-labelledby="nq-import-title" tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="qx-modal__header">
          <h2 id="nq-import-title">Import notes</h2>
          {!running ? <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose} aria-label="Close"><XIcon /></button> : null}
        </div>
        <div className="qx-modal__body qx-stack qx-stack--compact">
          {error ? <div className="qx-banner qx-banner--error" role="alert">{error}</div> : null}

          {(step === 'choose' || step === 'previewing') ? (
            <>
              <p className="qx-hint">Bring notes in from Evernote (.enex export), an Obsidian vault / Markdown folder (.zip), or Notion (Markdown & CSV export .zip). Nothing is written until you confirm.</p>
              <div className="qx-field">
                <span className="qx-field__label">File</span>
                {/* Native file input kept for accessibility and tests, shown as a design-system button. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <label className="qx-btn qx-btn--ghost" htmlFor="nq-import-file" aria-disabled={step === 'previewing'}>
                    <UploadIcon /> Choose file
                  </label>
                  <span className="qx-hint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file?.name || 'No file chosen'}</span>
                </div>
                <input id="nq-import-file" ref={fileRef} type="file" accept=".enex,.zip,.md" aria-label="File"
                  style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}
                  disabled={step === 'previewing'} onChange={(e) => choose(e.target.files?.[0])} />
              </div>
              <div className="qx-seg" role="group" aria-label="Import scope">
                {[['org', 'Shared with org'], ['user', 'Only me']].map(([v, l]) => (
                  <button key={v} type="button" className={`qx-seg__btn${scope === v ? ' qx-seg__btn--active' : ''}`} aria-pressed={scope === v} onClick={() => setScope(v)}>{l}</button>
                ))}
              </div>
              <div className="qx-field">
                <label className="qx-field__label" htmlFor="nq-import-coll">Put everything in collection (optional)</label>
                <input id="nq-import-coll" className="qx-input" type="text" value={collection} onChange={(e) => setCollection(e.target.value)} />
              </div>
              {step === 'previewing' ? <div className="qx-hint" role="status">Reading {file?.name}...</div> : null}
              <div className="qx-modal__actions">
                <button type="button" className="qx-btn qx-btn--ghost" onClick={onClose}><XIcon /> Cancel</button>
              </div>
            </>
          ) : null}

          {step === 'preview' && preview ? (
            <>
              <div><strong>{file?.name}</strong> <span className="qx-badge">{preview.format}</span></div>
              <div>{preview.notes} notes, {preview.attachments} attachments</div>
              {cols.length ? (
                <table className="qx-table">
                  <thead><tr><th>Collection</th><th>Notes</th></tr></thead>
                  <tbody>{cols.map(([n, c]) => <tr key={n}><td>{n}</td><td>{c}</td></tr>)}</tbody>
                </table>
              ) : null}
              {(preview.tags || []).length ? (
                <div className="qx-row qx-row--wrap qx-row--tight">{preview.tags.map((t) => <span key={t} className="qx-chip">#{t}</span>)}</div>
              ) : null}
              {(preview.sample || []).length ? (
                <div><div className="qx-section-title">Sample</div><ul>{preview.sample.map((t, i) => <li key={`${t}-${i}`}>{t}</li>)}</ul></div>
              ) : null}
              {(preview.warnings || []).length ? (
                <div className="qx-banner qx-banner--warn" role="status"><ul>{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
              ) : null}
              <div className="qx-modal__actions">
                <button type="button" className="qx-btn qx-btn--ghost" onClick={onClose}><XIcon /> Cancel</button>
                <button type="button" className="qx-btn qx-btn--ghost" onClick={reset}><RefreshIcon /> Choose another file</button>
                <button type="button" className="qx-btn qx-btn--primary" onClick={start}><UploadIcon /> Import {preview.notes} notes</button>
              </div>
            </>
          ) : null}

          {step === 'running' ? (
            <>
              <div role="status">Imported {(job?.created ?? 0)} of {job?.total ?? 0} ({job?.skipped ?? 0} already present, {job?.failed ?? 0} failed)</div>
              <div className="qx-progress" role="progressbar" aria-label="Import progress" style={{ '--qx-progress': job?.total ? Math.min(1, ((job.created || 0) + (job.skipped || 0) + (job.failed || 0)) / job.total) : 0 }} />
              <p className="qx-hint">You can close this; the import continues on the server.</p>
              <div className="qx-modal__actions">
                <button type="button" className="qx-btn qx-btn--ghost" onClick={onClose}><XIcon /> Close</button>
              </div>
            </>
          ) : null}

          {step === 'done' && job ? (
            <>
              {job.status === 'failed'
                ? <div className="qx-banner qx-banner--error" role="alert">The import failed before it finished.</div>
                : <div className="qx-banner qx-banner--success" role="status">Import finished.</div>}
              <div>Imported {job.created} of {job.total} ({job.skipped} already present, {job.failed} failed)</div>
              {failedItems.length ? (
                <div><div className="qx-section-title">Failed notes</div>
                  <ul>{failedItems.map((f, i) => <li key={i}>{f.title}: {f.error}</li>)}</ul></div>
              ) : null}
              <p className="qx-hint">Re-running the same file skips notes already imported.</p>
              <div className="qx-modal__actions">
                <button type="button" className="qx-btn qx-btn--primary" onClick={onClose}><CheckIcon /> Done</button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
