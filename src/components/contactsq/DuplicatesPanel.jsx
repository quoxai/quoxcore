/**
 * Possible duplicates: pairs that share an email (once plus-tags and gmail dots are ignored)
 * or share a name at the same organisation. Merging is reversible for 30 days, so the
 * panel also lists recent merges with an Undo. Org admin only for merge and undo.
 */
import { useState } from 'react'
import { api } from './lib/api'
import { useAsync } from './lib/useAsync'
import { duplicateLine } from './lib/importReport'
import { explainError } from './lib/reasonCodes'
import { AsyncGuard, ErrorBanner, fmtDate } from './shared'
import { MergeIcon, UndoIcon, XIcon } from './icons'

function Pair({ d, onDone }) {
  const [survivor, setSurvivor] = useState(d.suggested_survivor)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const loserId = survivor === d.a.id ? d.b.id : d.a.id
  const nameOf = (id) => (id === d.a.id ? d.a.display_name : d.b.display_name)
  const go = async () => {
    setBusy(true); setErr(null)
    try { const r = await api.mergeContacts(survivor, loserId); setConfirm(false); onDone(r.merge) } catch (e) { setErr(e) } finally { setBusy(false) }
  }
  return (
    <li className="qx-stack qx-stack--tight" style={{ listStyle: 'none' }}>
      <div>{duplicateLine(d)}</div>
      <div className="qx-row qx-row--wrap qx-row--tight">
        <label className="qx-row qx-row--tight"><input type="radio" name={`keep-${d.a.id}-${d.b.id}`} checked={survivor === d.a.id} onChange={() => setSurvivor(d.a.id)} />Keep {d.a.display_name}</label>
        <label className="qx-row qx-row--tight"><input type="radio" name={`keep-${d.a.id}-${d.b.id}`} checked={survivor === d.b.id} onChange={() => setSurvivor(d.b.id)} />Keep {d.b.display_name}</label>
      </div>
      <ErrorBanner error={err && { ...err, message: explainError(err) }} />
      {confirm ? (
        <div className="qx-row qx-row--wrap qx-row--tight">
          <span>Fold {nameOf(loserId)} into {nameOf(survivor)}? Numbers, history and facts move across. You can undo for 30 days.</span>
          <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={go} disabled={busy}><MergeIcon />{busy ? 'Merging' : 'Merge'}</button>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setConfirm(false)}><XIcon />Cancel</button>
        </div>
      ) : (
        <div><button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setConfirm(true)}><MergeIcon />Merge these two</button></div>
      )}
    </li>
  )
}

function RecentMerges({ merges, onUndone }) {
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(null)
  const live = merges.filter((m) => m.status === 'merged')
  if (!live.length) return null
  const undo = async (m) => {
    setBusy(m.id); setErr(null)
    try { await api.undoMerge(m.id); onUndone() } catch (e) { setErr(e) } finally { setBusy(null) }
  }
  return (
    <div className="qx-stack qx-stack--tight">
      <h4 className="qx-section-title" style={{ margin: 0 }}>Recent merges you can still undo</h4>
      <ErrorBanner error={err && { ...err, message: explainError(err) }} />
      <ul className="qx-stack qx-stack--tight" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {live.map((m) => (
          <li key={m.id} className="qx-stat-row">
            <span>Merged {fmtDate(m.merged_at)}, undo until {fmtDate(m.expires_at)}</span>
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => undo(m)} disabled={busy === m.id}><UndoIcon />{busy === m.id ? 'Undoing' : 'Undo'}</button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function DuplicatesPanel({ onClose, onChanged }) {
  const { data, error, loading, reload } = useAsync(() => api.getDuplicates(), [])
  const merges = useAsync(() => api.getMerges().catch(() => ({ merges: [] })), [])
  const pairs = data?.duplicates || []
  const refresh = () => { reload(); merges.reload(); onChanged?.() }
  return (
    <section className="qx-stack qx-stack--compact" aria-label="Possible duplicates">
      <div className="qx-row qx-row--apart">
        <h3 className="qx-section-title" style={{ margin: 0 }}>Possible duplicates</h3>
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose}><XIcon />Close</button>
      </div>
      <AsyncGuard error={error} loading={loading && !data} onRetry={reload} rows={3} what="Duplicates">
        {pairs.length === 0 ? (
          <div className="qx-empty"><div className="qx-empty__body">No likely duplicates. Pairs show up here when two contacts share an email or share a name at the same organisation.</div></div>
        ) : (
          <ul className="qx-stack" style={{ margin: 0, padding: 0 }}>{pairs.map((d) => <Pair key={`${d.a.id}-${d.b.id}`} d={d} onDone={refresh} />)}</ul>
        )}
      </AsyncGuard>
      <RecentMerges merges={merges.data?.merges || []} onUndone={refresh} />
    </section>
  )
}
