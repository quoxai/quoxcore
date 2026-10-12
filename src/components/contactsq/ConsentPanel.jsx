/** Consent matrix (purpose x channel, current state), add-consent form, and append-only history. */
import { useMemo, useState } from 'react'
import { api } from './lib/api'
import { useAsync } from './lib/useAsync'
import { buildConsentGrid, consentDotClass, normaliseConsents } from './lib/consents'
import { CHANNELS, CONSENT_STATUSES, LAWFUL_BASES, PURPOSES, explainError, labelOf } from './lib/reasonCodes'
import { AsyncGuard, Field, Section, fmtDate } from './shared'
import { ChevronDownIcon, PlusIcon, XIcon } from './icons'

const statusMeta = (s) => CONSENT_STATUSES.find((x) => x.key === s) || { label: s, pill: 'qx-pill--ghost' }

function AddConsent({ contactId, onAdded }) {
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ purpose: 'marketing', channel: 'email', status: 'granted', lawful_basis: 'consent', evidence_ref: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null)
    try {
      await api.addConsent(contactId, { purpose: f.purpose, channel: f.channel, status: f.status, lawful_basis: f.lawful_basis, ...(f.evidence_ref.trim() ? { evidence_ref: f.evidence_ref.trim() } : {}) })
      setOpen(false); onAdded()
    } catch (e2) { setErr(e2) } finally { setBusy(false) }
  }
  if (!open) return <div><button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setOpen(true)}><PlusIcon />Record a consent change</button></div>
  const sel = (k, list) => <select className="qx-select" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}>{list.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select>
  return (
    <form className="qx-stack qx-stack--compact" onSubmit={submit} aria-label="Record consent">
      {err ? <div className="qx-banner qx-banner--error" role="alert">{explainError(err)}</div> : null}
      <div className="qx-row qx-row--wrap">
        <Field label="Purpose">{sel('purpose', PURPOSES)}</Field>
        <Field label="Channel">{sel('channel', CHANNELS)}</Field>
        <Field label="What happened">{sel('status', CONSENT_STATUSES)}</Field>
        <Field label="Lawful basis">{sel('lawful_basis', LAWFUL_BASES)}</Field>
      </div>
      <Field label="Evidence reference" hint="A reference to where this was captured, such as a ticket or receipt id. Never paste the content itself.">
        <input className="qx-input" value={f.evidence_ref} onChange={(e) => setF({ ...f, evidence_ref: e.target.value })} />
      </Field>
      <div className="qx-row qx-row--end">
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setOpen(false)}><XIcon />Cancel</button>
        <button type="submit" className="qx-btn qx-btn--primary qx-btn--sm" disabled={busy}><PlusIcon />{busy ? 'Recording' : 'Record'}</button>
      </div>
    </form>
  )
}

const HISTORY_PREVIEW = 6

export function ConsentGrid({ current }) {
  const grid = useMemo(() => buildConsentGrid(current, PURPOSES, CHANNELS), [current])
  return (
    <div className="qx-stack qx-stack--tight">
      <div style={{ overflowX: 'auto' }}>
        <table className="qx-table qx-table--dense" aria-label="Consent matrix">
          <thead><tr><th>Purpose</th>{grid.channels.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
          <tbody>
            {grid.rows.map(({ purpose, cells }) => (
              <tr key={purpose.key}>
                <td>{purpose.label}</td>
                {cells.map(({ channel, row }) => (
                  <td key={channel.key}>
                    {row
                      ? <span role="img" className={consentDotClass(row.status)} aria-label={`${purpose.label}, ${channel.label}: ${statusMeta(row.status).label}`} title={`${statusMeta(row.status).label} · ${labelOf(LAWFUL_BASES, row.lawful_basis)} · ${fmtDate(row.captured_at)}`} />
                      : <span className="qx-hint" aria-label="No record">-</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="qx-row qx-row--wrap qx-row--tight qx-hint" aria-label="Legend">
        {CONSENT_STATUSES.map((s) => <span key={s.key} className="qx-row qx-row--tight" style={{ alignItems: 'center' }}><span className={consentDotClass(s.key)} />{s.label}</span>)}
      </div>
    </div>
  )
}

export default function ConsentPanel({ contactId }) {
  const { data, error, loading, reload } = useAsync(() => api.getConsents(contactId), [contactId])
  const { history, current } = useMemo(() => normaliseConsents(data), [data])
  const [all, setAll] = useState(false)
  const shown = all ? history : history.slice(0, HISTORY_PREVIEW)
  return (
    <div className="qx-stack">
      <AsyncGuard error={error} loading={loading && !data} onRetry={reload} rows={4} what="Consent">
        <Section title="Current consent">
          <ConsentGrid current={current} />
        </Section>
        <div className="qx-divider" />
        <Section title="History (never edited, only added to)">
          {history.length === 0 ? (
            <div className="qx-empty"><div className="qx-empty__title">No consent recorded</div><div className="qx-empty__body">Service and transactional contact is allowed without it. Marketing needs a recorded consent. Record one below when you have it.</div></div>
          ) : (
            <>
              <table className="qx-table qx-table--dense" aria-label="Consent history">
                <thead><tr><th>When</th><th>Purpose</th><th>Channel</th><th>Status</th><th>Basis</th><th>Via</th></tr></thead>
                <tbody>
                  {shown.map((r, i) => (
                    <tr key={r.id || i}>
                      <td>{fmtDate(r.captured_at)}</td><td>{labelOf(PURPOSES, r.purpose)}</td><td>{labelOf(CHANNELS, r.channel)}</td>
                      <td><span className={`qx-pill qx-pill--xs ${statusMeta(r.status).pill}`}>{statusMeta(r.status).label}</span></td>
                      <td>{labelOf(LAWFUL_BASES, r.lawful_basis)}</td><td>{r.captured_via || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {history.length > HISTORY_PREVIEW ? (
                <div><button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setAll((a) => !a)}><ChevronDownIcon />{all ? 'Show fewer' : `Show all ${history.length}`}</button></div>
              ) : null}
            </>
          )}
        </Section>
        <div className="qx-divider" />
        <AddConsent contactId={contactId} onAdded={reload} />
      </AsyncGuard>
    </div>
  )
}
