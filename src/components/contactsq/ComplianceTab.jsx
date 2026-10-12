/**
 * Compliance posture: the Article 14 / lawful-basis / retention bands (GET /compliance) and the
 * retention reaper (GET /retention/status), with a dry-run so nobody has to guess what the next
 * automatic clean-up will delete. Everything shown comes from the server.
 */
import { useState } from 'react'
import { api, downloadJson } from './lib/api'
import { useAsync } from './lib/useAsync'
import { AsyncGuard, ErrorBanner, Section, TabHeader, fmtDate } from './shared'
import { ClockIcon, DownloadIcon, FlaskIcon, PlayIcon, ShieldIcon } from './icons'

export const BANDS = [
  { key: 'notice_overdue', label: 'Notices overdue', help: 'People whose details came from somewhere other than them, and who have not been told within 30 days (Article 14).', tone: 'danger' },
  { key: 'candidates_expiring_7d', label: 'Unknown callers expiring this week', help: 'Auto-created contacts that will be erased within 7 days unless you keep them.', tone: 'info' },
  { key: 'no_lawful_basis', label: 'No lawful basis on file', help: 'Active contacts with no relationship and no consent recorded.', tone: 'degraded' },
  { key: 'consents_expiring_30d', label: 'Consents expiring in 30 days', help: 'Consent that lapses soon and needs renewing.', tone: 'degraded' },
  { key: 'special_category', label: 'Sensitive information', help: 'Contacts holding a fact in a sensitive category (health, religion, union, sexuality, politics, biometric, criminal). Review them in the Facts tab of each contact.', tone: 'ghost' },
]

function Band({ def, band }) {
  const n = band?.count ?? 0
  const pill = n === 0 ? 'qx-pill--online' : `qx-pill--${def.tone}`
  return (
    <li className="qx-stack qx-stack--tight" style={{ gap: 4 }}>
      <div className="qx-row qx-row--apart qx-row--tight" style={{ alignItems: 'center' }}>
        <strong>{def.label}</strong>
        <span className={`qx-pill qx-pill--xs ${pill}`}>{n}</span>
      </div>
      <div className="qx-hint">{def.help}</div>
      {n > 0 ? (
        <details className="qx-disclosure">
          <summary className="qx-disclosure__head">{band.truncated ? `First ${band.ids.length} of ${n}` : `${n} contact${n === 1 ? '' : 's'}`} <span className="qx-disclosure__chev">▸</span></summary>
          <div className="qx-disclosure__body qx-row qx-row--wrap qx-row--tight">{band.ids.map((id) => <span key={id} className="qx-chip qx-chip--xs qx-stat__value--mono">{id}</span>)}</div>
        </details>
      ) : null}
    </li>
  )
}

function Retention({ status, onRan }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [res, setRes] = useState(null)
  const preview = async () => {
    setBusy(true); setErr(null)
    try { setRes((await api.runRetention({ dry_run: true })).run) } catch (e) { setErr(e) } finally { setBusy(false) }
  }
  const last = status.last_counts
  return (
    <Section title="Automatic clean-up" label="Retention" action={<span className={`qx-pill qx-pill--xs ${status.enabled ? 'qx-pill--online' : 'qx-pill--ghost'}`}><ClockIcon />{status.enabled ? 'On' : 'Off'}</span>}>
      <div>Unknown callers are erased for good once their retention date passes, unless the contact is on legal hold. Switch it off or change the time in Settings.</div>
      <div className="qx-stack qx-stack--tight">
        <div className="qx-stat-row"><span>Runs daily at (UTC)</span><span>{status.run_time_utc}</span></div>
        <div className="qx-stat-row"><span>Next run</span><span>{status.enabled ? fmtDate(status.next_tick_at) : 'Switched off'}</span></div>
        <div className="qx-stat-row"><span>Last run</span><span>{status.last_run_at ? `${fmtDate(status.last_run_at)} (${status.last_status === 'ok' ? 'clean' : status.last_status})` : 'Never'}</span></div>
        {last ? <div className="qx-stat-row"><span>Last result</span><span>{last.erased} erased, {last.failed} failed, {last.skipped_legal_hold} on hold</span></div> : null}
        {status.consecutive_failures > 0 ? <div className="qx-banner qx-banner--warn" role="alert">The last {status.consecutive_failures} run{status.consecutive_failures === 1 ? '' : 's'} had failures{status.backoff_until ? `. Retrying after ${fmtDate(status.backoff_until)}.` : '.'}</div> : null}
        <div className="qx-stat-row"><span>Due for erasure now</span><span>{status.pending?.expired ?? 0}</span></div>
        {status.pending?.legal_hold ? <div className="qx-stat-row"><span>Held back by legal hold</span><span>{status.pending.legal_hold}</span></div> : null}
        {status.pending?.retired_failed ? <div className="qx-stat-row"><span>Gave up after repeated failures</span><span>{status.pending.retired_failed}</span></div> : null}
      </div>
      <ErrorBanner error={err} />
      {res ? (
        <div className="qx-banner qx-banner--info" role="status">
          <ShieldIcon /><span>Preview only, nothing was changed. {res.considered === 0 ? 'Nothing is due.' : `${res.would_erase_ids?.length ?? res.considered} contact${res.considered === 1 ? '' : 's'} would be erased${res.remaining ? `, ${res.remaining} more on a later run` : ''}.`}</span>
        </div>
      ) : null}
      <div className="qx-row qx-row--tight qx-row--wrap">
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={preview} disabled={busy}><FlaskIcon />{busy ? 'Checking' : 'Preview what would be erased'}</button>
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onRan}><PlayIcon />Refresh</button>
      </div>
    </Section>
  )
}

function Article30() {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const go = async () => {
    setBusy(true); setErr(null)
    try { downloadJson('record-of-processing.json', await api.getProcessingRecord()) } catch (e) { setErr(e) } finally { setBusy(false) }
  }
  return (
    <Section title="Record of processing (Article 30)" label="Record of processing">
      <div>What kinds of data you hold, why, who it was shared with and how long you keep it. Counts only, no personal details.</div>
      <ErrorBanner error={err} />
      <div><button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={go} disabled={busy}><DownloadIcon />{busy ? 'Preparing' : 'Download the record'}</button></div>
    </Section>
  )
}

export default function ComplianceTab() {
  const comp = useAsync(() => api.getCompliance(), [])
  const ret = useAsync(() => api.getRetentionStatus(), [])
  return (
    <section className="qx-card qx-stack" aria-label="Compliance">
      <TabHeader icon={ShieldIcon} title="Compliance" subtitle="Where your address book stands against notice, lawful-basis, consent and retention rules, and what the automatic clean-up will do next." />
      <div className="qx-divider" />
      <Section title="Posture">
        <AsyncGuard error={comp.error} loading={comp.loading && !comp.data} onRetry={comp.reload} rows={4} what="Compliance posture">
          {comp.data ? <ul className="qx-stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>{BANDS.map((def) => <Band key={def.key} def={def} band={comp.data.bands?.[def.key]} />)}</ul> : null}
        </AsyncGuard>
      </Section>
      <div className="qx-divider" />
      <AsyncGuard error={ret.error} loading={ret.loading && !ret.data} onRetry={ret.reload} rows={4} what="Automatic clean-up">
        {ret.data ? <Retention status={ret.data} onRan={() => { ret.reload(); comp.reload() }} /> : null}
      </AsyncGuard>
      <div className="qx-divider" />
      <Article30 />
    </section>
  )
}
