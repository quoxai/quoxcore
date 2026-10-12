/**
 * Sync card (Settings tab): one-way pull from a CardDAV address book (iCloud, Fastmail, Nextcloud).
 * ContactsQ is the governed copy: nothing is ever written back, an upstream deletion only FLAGS the contact
 * ("Removed at source"), and a field you edited here is never overwritten. The login is a vault credential of kind
 * carddav_account, picked here and never typed into this page. Org admin only; the server enforces it.
 */
import { useEffect, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { api } from './lib/api'
import { useAsync } from './lib/useAsync'
import { explainError } from './lib/reasonCodes'
import { AsyncGuard, Field, fmtDate } from './shared'
import { LinkIcon, PlayIcon, FlaskIcon, CheckIcon, XIcon, TrashIcon, PlusIcon, RefreshIcon } from './icons'

const ADDRESSBOOK_KINDS = ['icloud_contacts', 'carddav']
const INTERVALS = [{ v: '', label: 'Manual only' }, { v: '60', label: 'Every hour' }, { v: '360', label: 'Every 6 hours' }, { v: '1440', label: 'Daily' }]

/** -> { label, pill } for the status chip. */
export function statusChip(s) {
  if (s.retired_at) return { label: 'Stopped after repeated failures', pill: 'qx-pill--danger' }
  if (!s.last_run_at) return { label: 'Not run yet', pill: 'qx-pill--ghost' }
  const st = s.last_status || ''
  if (st === 'ok') return { label: 'Up to date', pill: 'qx-pill--online' }
  if (st.startsWith('failed')) return { label: `Failing (${s.consecutive_failures} in a row)`, pill: 'qx-pill--degraded' }
  return { label: st || 'Unknown', pill: 'qx-pill--ghost' }
}

export function countsLine(c) {
  if (!c) return ''
  const bits = [
    [c.created, 'new'], [c.updated, 'updated'], [c.linked_existing, 'matched existing'], [c.flagged_removed, 'removed at source'],
    [c.restored, 'restored'], [c.skipped_tombstoned, 'skipped (erased earlier)'],
  ].filter(([n]) => n)
  return bits.length ? bits.map(([n, l]) => `${n} ${l}`).join(', ') : 'No changes'
}

function AddForm({ credentials, onAdded, onCancel }) {
  const [picked, setCredId] = useState('')
  const credId = picked && credentials.some((c) => c.id === picked) ? picked : (credentials[0]?.id || '')
  const [label, setLabel] = useState('')
  const [every, setEvery] = useState('')
  const [books, setBooks] = useState(null)
  const [book, setBook] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null)
    try {
      const body = { credential_id: credId }
      if (label.trim()) body.label = label.trim()
      if (every) body.interval_min = Number(every)
      if (book) body.addressbook_url = book
      await api.addSyncSource(body)
      onAdded()
    } catch (e2) {
      if (e2.code === 'addressbook_choice_required' && e2.body?.addressbooks) { setBooks(e2.body.addressbooks); setBook(e2.body.addressbooks[0]?.url || '') } else setErr(e2)
    } finally { setBusy(false) }
  }
  return (
    <form className="qx-stack qx-stack--tight" onSubmit={submit} aria-label="Add sync source">
      {err ? <div className="qx-banner qx-banner--error" role="alert">{explainError(err)}</div> : null}
      {credentials.length === 0 ? (
        <div className="qx-banner qx-banner--info" role="status">
          No address book login is saved in the vault yet. Add one under Vault, kind &quot;Address books (CardDAV)&quot;, type iCloud Contacts or CardDAV.
        </div>
      ) : null}
      <div className="qx-row qx-row--wrap">
        <Field label="Login (from the vault)" hint="iCloud: create an app-specific password at account.apple.com > Sign-In and Security > App-Specific Passwords, then save it in the vault as an iCloud Contacts login. Your Apple ID password will not work.">
          <select className="qx-input" value={credId} onChange={(e) => setCredId(e.target.value)} aria-label="Address book login" disabled={!credentials.length}>
            {credentials.map((c) => <option key={c.id} value={c.id}>{c.label || c.id}</option>)}
          </select>
        </Field>
        <Field label="Name" hint="Optional."><input className="qx-input" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Source name" /></Field>
        <Field label="Sync"><select className="qx-input" value={every} onChange={(e) => setEvery(e.target.value)} aria-label="Sync schedule">{INTERVALS.map((i) => <option key={i.v} value={i.v}>{i.label}</option>)}</select></Field>
      </div>
      {books ? (
        <Field label="Address book" hint="This account has more than one. Choose the one to pull.">
          <select className="qx-input" value={book} onChange={(e) => setBook(e.target.value)} aria-label="Address book">{books.map((b) => <option key={b.url} value={b.url}>{b.name || 'Unnamed'}</option>)}</select>
        </Field>
      ) : null}
      <div className="qx-row qx-row--end">
        <button type="button" className="qx-btn qx-btn--sm" onClick={onCancel}><XIcon />Cancel</button>
        <button type="submit" className="qx-btn qx-btn--primary qx-btn--sm" disabled={busy || !credId}><CheckIcon />{busy ? 'Connecting' : 'Add source'}</button>
      </div>
    </form>
  )
}

function SourceRow({ s, onChanged }) {
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)
  const [note, setNote] = useState(null)
  const chip = statusChip(s)
  const act = async (name, fn) => {
    setBusy(name); setErr(null); setNote(null)
    try { return await fn() } catch (e) { setErr(e); return null } finally { setBusy(null) }
  }
  const run = async (dry) => {
    const r = await act(dry ? 'dry' : 'run', () => api.runSyncSource(s.id, { dryRun: dry }))
    if (r) { setNote(`${dry ? 'Dry run, nothing written: ' : ''}${countsLine(r.counts)}`); if (!dry) onChanged() }
    else onChanged()
  }
  const toggle = async () => { if (await act('toggle', () => api.updateSyncSource(s.id, { enabled: s.retired_at ? true : !s.enabled }))) onChanged() }
  const remove = async () => {
    if (!window.confirm('Stop syncing this address book? Contacts already pulled are kept.')) return
    if (await act('remove', () => api.removeSyncSource(s.id))) onChanged()
  }
  const sched = s.interval_min ? `every ${s.interval_min >= 60 ? `${s.interval_min / 60} h` : `${s.interval_min} min`}` : 'manual only'
  return (
    <li className="qx-stack qx-stack--tight" style={{ listStyle: 'none' }} data-testid={`sync-source-${s.id}`}>
      <div className="qx-row qx-row--wrap" style={{ alignItems: 'center' }}>
        <strong>{s.label}</strong>
        <span className="qx-pill qx-pill--xs qx-pill--ghost">{s.provider === 'icloud' ? 'iCloud' : 'CardDAV'}</span>
        <span className={`qx-pill qx-pill--xs ${chip.pill}`}>{chip.label}</span>
        <span className="qx-hint qx-hint--sm">{s.enabled && !s.retired_at ? sched : 'paused'}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={() => run(false)} disabled={!!busy}><RefreshIcon />{busy === 'run' ? 'Syncing' : 'Sync now'}</button>
        <button type="button" className="qx-btn qx-btn--sm" onClick={() => run(true)} disabled={!!busy}><FlaskIcon />{busy === 'dry' ? 'Checking' : 'Dry run'}</button>
        <button type="button" className="qx-btn qx-btn--sm" onClick={toggle} disabled={!!busy}><PlayIcon />{s.retired_at ? 'Enable again' : s.enabled ? 'Disable' : 'Enable'}</button>
        <button type="button" className="qx-btn qx-btn--sm" onClick={remove} disabled={!!busy} aria-label={`Remove ${s.label}`}><TrashIcon />Remove</button>
      </div>
      <div className="qx-hint qx-hint--sm">
        {s.last_run_at ? `Last run ${fmtDate(s.last_run_at)}. ${countsLine(s.last_counts)}.` : 'Never run. Try a dry run first: it shows what would happen and writes nothing.'}
        {s.retired_at ? ` It stopped (${(s.last_status || '').replace(/^retired:/, '')}). Check the saved login, then enable it again.` : ''}
      </div>
      {note ? <div className="qx-banner qx-banner--success" role="status">{note}</div> : null}
      {err ? <div className="qx-banner qx-banner--error" role="alert">{explainError(err)}</div> : null}
    </li>
  )
}

export default function SyncCard() {
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id || null
  const { data, error, loading, reload } = useAsync(() => api.listSyncSources(), [])
  const [creds, setCreds] = useState([])
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    let live = true
    if (!adding || !orgId || !authFetch) return undefined
    authFetch(`/api/orgs/${encodeURIComponent(orgId)}/integrations`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!live || !j) return
        const rows = j.credentials || j.integrations || []
        setCreds(rows.filter((c) => c.credential_kind === 'carddav_account' || ADDRESSBOOK_KINDS.includes(c.integration_type)).map((c) => ({ id: c.id, label: c.label || c.name })))
      })
      .catch(() => { if (live) setCreds([]) })
    return () => { live = false }
  }, [adding, orgId, authFetch])
  const sources = data?.sources || []
  return (
    <section className="qx-stack" aria-label="Address book sync">
      <div className="qx-divider" />
      <div className="qx-row qx-row--wrap" style={{ alignItems: 'center' }}>
        <h3 className="qx-section-title" style={{ margin: 0 }}><LinkIcon />Sync</h3>
        <span style={{ flex: 1 }} />
        {!adding ? <button type="button" className="qx-btn qx-btn--sm" onClick={() => setAdding(true)}><PlusIcon />Add source</button> : null}
      </div>
      <div className="qx-hint">
        Keep ContactsQ in step with your iCloud or CardDAV address book. It pulls one way and never writes back. A contact deleted there is flagged here, never erased, and anything you edited here is kept.
      </div>
      <AsyncGuard error={error} loading={loading && !data} onRetry={reload} rows={2} what="Sync">
        {adding ? <AddForm credentials={creds} onAdded={() => { setAdding(false); reload() }} onCancel={() => setAdding(false)} /> : null}
        {sources.length ? <ul className="qx-stack" style={{ margin: 0, padding: 0 }}>{sources.map((s) => <SourceRow key={s.id} s={s} onChanged={reload} />)}</ul>
          : !adding ? <div className="qx-empty"><div className="qx-empty__title">No address book linked</div><div className="qx-empty__body">Add a source to pull your iCloud or CardDAV contacts in and keep them up to date.</div></div> : null}
      </AsyncGuard>
    </section>
  )
}
