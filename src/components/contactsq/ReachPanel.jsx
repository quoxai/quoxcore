/** "Can we reach them?" policy check, policy decision history and the lease ledger. */
import { useState } from 'react'
import { api, isUnavailable } from './lib/api'
import { useAsync } from './lib/useAsync'
import { CHANNELS, DECISIONS, PURPOSES, REACH_CHANNELS, explainError, explainReason, labelOf } from './lib/reasonCodes'
import { AsyncGuard, Field, Unavailable, fmtDate } from './shared'
import { ShieldIcon } from './icons'

export function DecisionView({ result }) {
  const meta = DECISIONS[result.decision] || { label: result.decision, pill: 'qx-pill--ghost', blurb: '' }
  const reasons = result.reasons || []
  return (
    <div className="qx-stack qx-stack--tight" role="status">
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <span className={`qx-pill qx-pill--lg ${meta.pill}`}>{meta.label}</span>
        <span>{meta.blurb}</span>
      </div>
      {reasons.length ? <ul style={{ margin: 0, paddingLeft: 20 }}>{reasons.map((r, i) => <li key={i}>{explainReason(r)}</li>)}</ul> : <div>No special conditions apply.</div>}
      {result.pack ? <div className="qx-chip qx-chip--xs">Rules: {result.pack}</div> : null}
    </div>
  )
}

function PolicyCheck({ contactId }) {
  const [purpose, setPurpose] = useState('service')
  const [channel, setChannel] = useState('voice')
  const [res, setRes] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const run = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null); setRes(null)
    try { setRes(await api.checkPolicy(contactId, { purpose, channel })) } catch (e2) { setErr(e2) } finally { setBusy(false) }
  }
  return (
    <form className="qx-stack qx-stack--compact" onSubmit={run} aria-label="Can we reach them">
      <h3 className="qx-section-title" style={{ margin: 0 }}>Can we reach them?</h3>
      <div className="qx-row qx-row--wrap" style={{ alignItems: 'flex-end' }}>
        <Field label="Why"><select className="qx-select" value={purpose} onChange={(e) => setPurpose(e.target.value)}>{PURPOSES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
        <Field label="How"><select className="qx-select" value={channel} onChange={(e) => setChannel(e.target.value)}>{REACH_CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></Field>
        <button type="submit" className="qx-btn qx-btn--primary" disabled={busy}><ShieldIcon />{busy ? 'Checking' : 'Check'}</button>
      </div>
      {err ? (isUnavailable(err) ? <Unavailable what="The reachability check" /> : <div className="qx-banner qx-banner--error" role="alert">{explainError(err)}</div>) : null}
      {res ? <DecisionView result={res} /> : <div>This is advisory only. Nothing is sent and nothing is recorded.</div>}
    </form>
  )
}

function Decisions({ contactId }) {
  const { data, error, loading, reload } = useAsync(() => api.getPolicyDecisions(contactId), [contactId])
  const rows = data?.decisions || []
  return (
    <div className="qx-stack qx-stack--tight">
      <h3 className="qx-section-title" style={{ margin: 0 }}>Past decisions</h3>
      <AsyncGuard error={error} loading={loading} onRetry={reload} rows={2} what="Decision history">
        {rows.length === 0 ? <div className="qx-empty"><div className="qx-empty__body">No approach has been checked against this person yet.</div></div> : (
          <table className="qx-table qx-table--dense" aria-label="Policy decisions">
            <thead><tr><th>When</th><th>Who asked</th><th>Why</th><th>How</th><th>Decision</th><th>Reasons</th></tr></thead>
            <tbody>
              {rows.map((d, i) => (
                <tr key={d.id || i}>
                  <td>{fmtDate(d.decided_at)}</td><td>{d.subject_id || '-'}</td><td>{labelOf(PURPOSES, d.purpose)}</td><td>{labelOf(CHANNELS, d.channel)}</td>
                  <td><span className={`qx-pill qx-pill--xs ${DECISIONS[d.decision]?.pill || 'qx-pill--ghost'}`}>{DECISIONS[d.decision]?.label || d.decision}</span></td>
                  <td>{(d.reasons || d.reasons_json || []).map(explainReason).join(' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AsyncGuard>
    </div>
  )
}

function Leases({ contactId }) {
  const { data, error, loading, reload } = useAsync(() => api.getLeases(contactId), [contactId])
  const rows = data?.leases || []
  return (
    <div className="qx-stack qx-stack--tight">
      <h3 className="qx-section-title" style={{ margin: 0 }}>Lease ledger</h3>
      <AsyncGuard error={error} loading={loading} onRetry={reload} rows={2} what="The lease ledger">
        {rows.length === 0 ? <div className="qx-empty"><div className="qx-empty__body">No agent has been given a way to reach this person. Leases appear here when one is.</div></div> : (
          <table className="qx-table qx-table--dense" aria-label="Lease ledger">
            <thead><tr><th>Asked</th><th>Who</th><th>How</th><th>Why</th><th>Status</th><th>Decided by</th><th>Uses</th></tr></thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td>{fmtDate(l.requested_at || l.expires_at)}</td><td>{l.subject_id || l.subject_type || '-'}</td><td>{labelOf(CHANNELS, l.channel)}</td><td>{labelOf(PURPOSES, l.purpose)}</td>
                  <td><span className={`qx-pill qx-pill--xs ${l.status === 'active' ? 'qx-pill--online' : l.status === 'denied' || l.status === 'revoked' ? 'qx-pill--danger' : 'qx-pill--ghost'}`}>{l.status}</span></td>
                  <td>{String(l.decided_by || '').startsWith('policy:') ? 'Standing grant' : l.decided_by === 'approval_gate' ? 'A person approved' : (l.decided_by || '-')}</td>
                  <td>{l.use_count ?? 0}/{l.max_uses ?? 1}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AsyncGuard>
    </div>
  )
}

export default function ReachPanel({ contactId }) {
  return (
    <div className="qx-stack">
      <PolicyCheck contactId={contactId} />
      <div className="qx-divider" />
      <Decisions contactId={contactId} />
      <div className="qx-divider" />
      <Leases contactId={contactId} />
    </div>
  )
}
