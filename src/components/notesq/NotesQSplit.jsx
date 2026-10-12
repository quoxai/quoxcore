/** Details-rail bulk authoring (AQ-9D P8): split a note at its headings, undo a batch. Mirrors `quox notes split | batch-undo`. */
import { useEffect, useState } from 'react'
import { api } from './lib/api'
import { planSplit, buildBatchArchive } from './lib/splitNote'
import { CheckIcon, XIcon, RestoreIcon } from './icons'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SESSION = 'dashboard'

function undoText(r) {
  return `${r.deleted} deleted, ${r.failed} failed of ${r.found}.${r.found ? '' : ' Nothing to undo: no live notes carry that batch id.'}`
}

export function SplitNote({ note, dirty, onRefresh, pollMs = 1500 }) {
  const plan = planSplit(note)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [leftover, setLeftover] = useState(null) // batch id of children to remove after a failed split
  const [done, setDone] = useState(null) // { batchId, prevRev, count }
  const [undoMsg, setUndoMsg] = useState('')

  useEffect(() => { setConfirm(false); setErr(''); setLeftover(null); setDone(null); setUndoMsg('') }, [note.id])

  if (!plan && !done && !leftover) return null

  const run = async () => {
    setBusy(true); setErr(''); setLeftover(null); setUndoMsg('')
    let batchId = null
    try {
      const archive = await buildBatchArchive({ items: plan.items, name: `split-${String(note.id).slice(0, 8)}` })
      const started = await api.startBatch(archive.blob, archive.filename, { scope: note.scope, session: SESSION })
      batchId = started.batch_id
      if (!batchId) throw new Error('Batch did not return a batch id.')
      let st
      const deadline = Date.now() + 10 * 60 * 1000
      for (;;) {
        st = await api.getImportJob(batchId)
        if (st.status !== 'running') break
        if (Date.now() > deadline) throw new Error('The split is still running after 10 minutes. Check back, or undo the children.')
        await sleep(pollMs)
      }
      if (st.status === 'failed' || st.failed > 0 || st.created + st.skipped !== plan.items.length) {
        setLeftover(batchId)
        setErr(`Split stopped: ${st.created} of ${plan.items.length} children written (${st.failed} failed${st.error ? `, ${st.error}` : ''}). The original was NOT changed.`)
        setConfirm(false)
        return
      }
      const revs = await api.listRevisions(note.id)
      const prevRev = Math.max(0, ...((revs.revisions || []).map((r) => Number(r.rev) || 0)))
      try {
        await api.updateNote(note.id, { markdown: plan.parentMd, properties: note.properties || {}, base_hash: note.content_hash })
      } catch (e) {
        setLeftover(batchId)
        setErr(e.status === 409
          ? `The note changed meanwhile, so the index was not written. The ${st.created} children exist as batch ${batchId.slice(0, 8)}.`
          : `${e.message}. The ${st.created} children exist as batch ${batchId.slice(0, 8)}.`)
        setConfirm(false)
        return
      }
      setDone({ batchId, prevRev, count: plan.items.length })
      setConfirm(false)
      await onRefresh?.()
    } catch (e) {
      if (batchId) setLeftover(batchId)
      setErr(e.message)
      setConfirm(false)
    } finally { setBusy(false) }
  }

  const undoChildren = async (alsoRestore) => {
    const batchId = alsoRestore ? done.batchId : leftover
    setBusy(true); setErr(''); setUndoMsg('')
    try {
      const r = await api.undoBatch(batchId)
      let msg = `Children: ${undoText(r)}`
      if (alsoRestore) {
        if (r.failed > 0) { setErr(`${msg} The original was not restored.`); return }
        await api.restoreRevision(note.id, done.prevRev)
        msg += ` Original restored to #${done.prevRev}.`
        setDone(null)
        await onRefresh?.()
      } else {
        setLeftover(null)
      }
      setUndoMsg(msg)
    } catch (e) {
      setErr(e.status === 403 ? 'Only the author or an admin can undo these notes.' : e.message)
    } finally { setBusy(false) }
  }

  return (
    <section className="qx-card qx-card--compact qx-stack qx-stack--compact" aria-label="Split into notes">
      <div className="qx-section-title">Split</div>
      {plan && !done ? <div className="qx-hint qx-hint--sm">{plan.items.length} sections at heading level {plan.level}</div> : null}
      {err ? <div className="qx-banner qx-banner--error" role="alert">{err}</div> : null}
      {undoMsg ? <div className="qx-banner qx-banner--success" role="status">{undoMsg}</div> : null}
      {done ? (
        <>
          <div className="qx-banner qx-banner--success" role="status">Split into {done.count} notes</div>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy} onClick={() => undoChildren(true)}><RestoreIcon /> Undo split</button>
        </>
      ) : null}
      {leftover ? (
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy} onClick={() => undoChildren(false)}><RestoreIcon /> Undo children</button>
      ) : null}
      {plan && !done && !leftover ? (confirm ? (
        <div className="qx-stack qx-stack--tight">
          <span>This writes {plan.items.length} new notes and turns this one into an index linking to them. Both can be undone.</span>
          <ul className="qx-hint qx-hint--sm" aria-label="Child notes">{plan.items.map((i) => <li key={i.key}>{i.title}</li>)}</ul>
          <div className="qx-row qx-row--tight">
            <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" disabled={busy} onClick={run}><CheckIcon /> Confirm</button>
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy} onClick={() => setConfirm(false)}><XIcon /> Cancel</button>
          </div>
        </div>
      ) : (
        <>
          {plan.tooMany ? <div className="qx-hint qx-hint--sm">That would make more notes than one batch allows (200).</div> : null}
          {dirty ? <div className="qx-hint qx-hint--sm">Save your changes first.</div> : null}
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy || dirty || plan.tooMany} onClick={() => { setErr(''); setUndoMsg(''); setConfirm(true) }}>Split into {plan.items.length} notes</button>
        </>
      )) : null}
    </section>
  )
}

export function BatchUndo({ note, onDeleted }) {
  const batchId = note.properties?.batch_id
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => { setConfirm(false); setErr(''); setMsg('') }, [note.id])
  if (!batchId) return null
  const go = async () => {
    setBusy(true); setErr(''); setMsg('')
    try {
      const r = await api.undoBatch(batchId)
      setMsg(undoText(r))
      setConfirm(false)
      if (r.failed > 0) setErr(`${r.failed} note(s) could not be deleted (author or org admin only).`)
    } catch (e) {
      setErr(e.status === 403 ? 'Only the author or an admin can undo this batch.' : e.message)
      setConfirm(false)
    } finally { setBusy(false) }
  }
  return (
    <section className="qx-card qx-card--compact qx-stack qx-stack--compact" aria-label="Batch">
      <div className="qx-section-title">Batch</div>
      <div className="qx-hint qx-hint--sm">Created in batch {String(batchId).slice(0, 8)}</div>
      {err ? <div className="qx-banner qx-banner--error" role="alert">{err}</div> : null}
      {msg ? <div className="qx-banner qx-banner--success" role="status">{msg}</div> : null}
      {confirm ? (
        <div className="qx-stack qx-stack--tight">
          <span>Deletes every note created in this batch. Each can be restored from history.</span>
          <div className="qx-row qx-row--tight">
            <button type="button" className="qx-btn qx-btn--danger qx-btn--sm" disabled={busy} onClick={go}><CheckIcon /> Confirm undo batch</button>
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy} onClick={() => setConfirm(false)}><XIcon /> Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy} onClick={() => { setErr(''); setMsg(''); setConfirm(true) }}><RestoreIcon /> Undo batch</button>
      )}
    </section>
  )
}
