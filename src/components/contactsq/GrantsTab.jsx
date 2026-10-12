/** Standing grants: what an agent may do without asking each time. Org admin only for writes. */
import { useState } from 'react'
import { api } from './lib/api'
import { useAsync } from './lib/useAsync'
import { CHANNELS, PURPOSES, explainError, labelOf } from './lib/reasonCodes'
import { AsyncGuard, Field, TabHeader, fmtDate } from './shared'
import { channelHue, chipClass } from './lib/chips'
import { KeyIcon, PlusIcon, TrashIcon } from './icons'

export const RECEPTIONIST_PRESET = { projection: 'dial', channels: ['voice'], purposes: ['service'], max_uses_per_day: 20 }
const GRANT_CHANNELS = CHANNELS.filter((c) => ['voice', 'sms', 'email'].includes(c.key))

function GrantForm({ onAdded }) {
  const [f, setF] = useState({ subject_id: '', projection: 'dial', channels: ['voice'], purposes: ['service'], max_uses_per_day: 20 })
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const toggle = (k, v) => setF((s) => ({ ...s, [k]: s[k].includes(v) ? s[k].filter((x) => x !== v) : [...s[k], v] }))
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null)
    try {
      await api.createGrant({ ...f, subject_id: f.subject_id.trim().toLowerCase(), max_uses_per_day: Number(f.max_uses_per_day) })
      setF({ ...f, subject_id: '' }); onAdded()
    } catch (e2) { setErr(e2) } finally { setBusy(false) }
  }
  return (
    <form className="qx-stack qx-stack--compact" onSubmit={submit} aria-label="Add grant">
      <div className="qx-row qx-row--apart">
        <h3 className="qx-section-title" style={{ margin: 0 }}>Give an agent a standing grant</h3>
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setF({ ...f, ...RECEPTIONIST_PRESET })}><KeyIcon />Receptionist preset</button>
      </div>
      {err ? <div className="qx-banner qx-banner--error" role="alert">{explainError(err)}</div> : null}
      <div className="qx-row qx-row--wrap">
        <Field label="Agent id" hint="One named agent. A wildcard is not allowed."><input className="qx-input" value={f.subject_id} onChange={(e) => setF({ ...f, subject_id: e.target.value })} required /></Field>
        <Field label="Action">
          <select className="qx-select" value={f.projection} onChange={(e) => setF({ ...f, projection: e.target.value })}><option value="dial">Place calls</option><option value="send">Send messages</option></select>
        </Field>
        <Field label="Most per day" hint="1 to 500"><input type="number" min={1} max={500} className="qx-input qx-input--narrow" value={f.max_uses_per_day} onChange={(e) => setF({ ...f, max_uses_per_day: e.target.value })} /></Field>
      </div>
      <span className="qx-field__label">Channels</span>
      <div className="qx-row qx-row--wrap qx-row--tight" role="group" aria-label="Channels">
        {GRANT_CHANNELS.map((c) => <button key={c.key} type="button" aria-pressed={f.channels.includes(c.key)} className={chipClass(channelHue(c.key), { size: '', variant: 'toggle' })} onClick={() => toggle('channels', c.key)}>{c.label}</button>)}
      </div>
      <span className="qx-field__label">Purposes</span>
      <div className="qx-row qx-row--wrap qx-row--tight" role="group" aria-label="Purposes">
        {PURPOSES.filter((p) => p.key !== 'ai_interaction').map((p) => <button key={p.key} type="button" aria-pressed={f.purposes.includes(p.key)} className={chipClass('violet', { size: '', variant: 'toggle' })} onClick={() => toggle('purposes', p.key)}>{p.label}</button>)}
      </div>
      <div className="qx-row qx-row--end">
        <button type="submit" className="qx-btn qx-btn--primary" disabled={busy || !f.subject_id.trim() || !f.channels.length || !f.purposes.length}><PlusIcon />{busy ? 'Granting' : 'Grant'}</button>
      </div>
    </form>
  )
}

export default function GrantsTab() {
  const { data, error, loading, reload } = useAsync(() => api.listGrants(), [])
  const [revokeErr, setRevokeErr] = useState(null)
  const grants = (data?.grants || []).filter((g) => !g.revoked_at)
  const revoke = async (id) => { setRevokeErr(null); try { await api.revokeGrant(id); reload() } catch (e) { setRevokeErr(e) } }
  return (
    <section className="qx-card qx-stack" aria-label="Agent permissions">
      <TabHeader icon={KeyIcon} title="Agent permissions" subtitle="A standing grant lets one named agent reach people without asking you each time. It never overrides consent or the do-not-contact list: if policy says a person must approve, the grant is ignored for that approach. Org admins only." />
      <div className="qx-divider" />
      {revokeErr ? <div className="qx-banner qx-banner--error" role="alert">{explainError(revokeErr)}</div> : null}
      <AsyncGuard error={error} loading={loading && !data} onRetry={reload} rows={3} what="Agent permissions">
        {grants.length === 0 ? (
          <div className="qx-empty"><div className="qx-empty__icon"><KeyIcon size={22} /></div><div className="qx-empty__title">No standing grants</div><div className="qx-empty__body">Every approach by an agent asks you first. Add a grant below for an agent you trust to handle routine calls.</div></div>
        ) : (
          <table className="qx-table qx-table--dense" aria-label="Standing grants">
            <thead><tr><th>Agent</th><th>Action</th><th>How</th><th>Why</th><th>Per day</th><th>Granted</th><th /></tr></thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.id}>
                  <td>{g.subject_id}</td><td>{g.projection === 'dial' ? 'Place calls' : 'Send messages'}</td>
                  <td>{(g.channels || []).map((c) => labelOf(CHANNELS, c)).join(', ')}</td><td>{(g.purposes || []).map((p) => labelOf(PURPOSES, p)).join(', ')}</td>
                  <td>{g.max_uses_per_day}</td><td>{fmtDate(g.created_at)}</td>
                  <td><button type="button" className="qx-btn qx-btn--danger qx-btn--sm" onClick={() => revoke(g.id)} aria-label={`Revoke grant for ${g.subject_id}`}><TrashIcon />Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AsyncGuard>
      <div className="qx-divider" />
      <GrantForm onAdded={reload} />
    </section>
  )
}
