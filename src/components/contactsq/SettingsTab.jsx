/** Org settings. Only fields the server returned are sent back, so older collectors keep working. */
import { useEffect, useState } from 'react'
import { api } from './lib/api'
import { useAsync } from './lib/useAsync'
import { explainError } from './lib/reasonCodes'
import { AsyncGuard, Field, TabHeader } from './shared'
import SyncCard from './SyncCard'
import { GearIcon, SaveIcon } from './icons'

export function buildSettingsBody(loaded, f) {
  const body = {}
  const has = (k) => Object.prototype.hasOwnProperty.call(loaded, k)
  if (has('default_region')) body.default_region = f.default_region.trim().toUpperCase()
  if (has('candidate_retention_days')) body.candidate_retention_days = Number(f.candidate_retention_days)
  if (has('strict_names')) body.strict_names = !!f.strict_names
  if (has('default_jurisdiction')) body.default_jurisdiction = f.default_jurisdiction.trim().toLowerCase()
  if (has('backup_retention_days')) body.backup_retention_days = Number(f.backup_retention_days)
  if (has('retention_reaper_enabled')) body.retention_reaper_enabled = !!f.retention_reaper_enabled
  if (has('retention_run_time_utc')) body.retention_run_time_utc = f.retention_run_time_utc
  if (has('compliance_report')) {
    body.compliance_report = { enabled: !!f.cr_enabled, cadence: f.cr_cadence, day: Number(f.cr_day), time_utc: f.cr_time }
  }
  if (has('default_quiet_hours')) body.default_quiet_hours = { start: f.qh_start, end: f.qh_end, tz: f.qh_tz.trim() }
  return body
}

function Form({ settings, onSaved }) {
  const qh = settings.default_quiet_hours || {}
  const cr = settings.compliance_report || {}
  const [f, setF] = useState({
    default_region: settings.default_region ?? '', candidate_retention_days: settings.candidate_retention_days ?? 30, strict_names: !!settings.strict_names,
    default_jurisdiction: settings.default_jurisdiction ?? 'uk',
    backup_retention_days: settings.backup_retention_days ?? 30, retention_reaper_enabled: settings.retention_reaper_enabled ?? true, retention_run_time_utc: settings.retention_run_time_utc ?? '03:15', qh_start: qh.start || '21:00', qh_end: qh.end || '08:00', qh_tz: qh.tz || 'Europe/London',
    cr_enabled: !!cr.enabled, cr_cadence: cr.cadence || 'weekly', cr_day: cr.day ?? 1, cr_time: cr.time_utc || '08:00',
  })
  const [err, setErr] = useState(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setSaved(false) }, [f])
  const has = (k) => Object.prototype.hasOwnProperty.call(settings, k)
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null)
    try { await api.putSettings(buildSettingsBody(settings, f)); onSaved(); setSaved(true) } catch (e2) { setErr(e2) } finally { setBusy(false) }
  }
  return (
    <form className="qx-stack" onSubmit={submit} aria-label="Contacts settings">
      {err ? <div className="qx-banner qx-banner--error" role="alert">{explainError(err)}</div> : null}
      {saved && !err ? <div className="qx-banner qx-banner--success" role="status">Settings saved.</div> : null}
      <div className="qx-row qx-row--wrap">
        <Field label="Default region" hint="Two-letter country code used to read phone numbers typed without a country code, for example GB."><input className="qx-input qx-input--narrow" maxLength={2} value={f.default_region} onChange={(e) => setF({ ...f, default_region: e.target.value })} /></Field>
        <Field label="Keep unknown callers for (days)" hint="Candidates created from unknown callers are removed after this long unless you promote them."><input type="number" min={1} className="qx-input qx-input--narrow" value={f.candidate_retention_days} onChange={(e) => setF({ ...f, candidate_retention_days: e.target.value })} /></Field>
        {has('default_jurisdiction') ? <Field label="Jurisdiction" hint="Which rule set applies to reach decisions. Only uk is available today."><input className="qx-input qx-input--narrow" value={f.default_jurisdiction} onChange={(e) => setF({ ...f, default_jurisdiction: e.target.value })} /></Field> : null}
      </div>
      <div className="qx-divider" />
      <label className="qx-row qx-row--tight" style={{ alignItems: 'center', cursor: 'pointer' }}>
        <span className="qx-toggle"><input type="checkbox" checked={f.strict_names} onChange={(e) => setF({ ...f, strict_names: e.target.checked })} aria-label="Strict names" /><span className="qx-toggle__track" /></span>
        <span><strong>Strict names</strong><br /><span>Names are stored encrypted and agents see only a placeholder (Contact 1a2b3c); people signed in still see real names. Search then matches exact name words only, with no sound-alike matching. Existing contacts change only when an admin runs <code className="qx-code">quox contacts strict-names apply</code>.</span></span>
      </label>
      {has('retention_reaper_enabled') ? (
        <div className="qx-stack qx-stack--tight">
          <div className="qx-divider" />
          <h3 className="qx-section-title" style={{ margin: 0 }}>Retention and erasure</h3>
          <label className="qx-row qx-row--tight" style={{ alignItems: 'center', cursor: 'pointer' }}>
            <span className="qx-toggle"><input type="checkbox" checked={!!f.retention_reaper_enabled} onChange={(e) => setF({ ...f, retention_reaper_enabled: e.target.checked })} aria-label="Automatic clean-up" /><span className="qx-toggle__track" /></span>
            <span><strong>Automatic clean-up</strong><br /><span>Erase unknown callers for good once their retention date passes. Contacts on legal hold are never touched. Turn this off to stop it at once.</span></span>
          </label>
          <div className="qx-row qx-row--wrap">
            <Field label="Runs daily at (UTC)" hint="The time of day the clean-up runs. It never runs when the service starts."><input type="time" className="qx-input" value={f.retention_run_time_utc} onChange={(e) => setF({ ...f, retention_run_time_utc: e.target.value })} /></Field>
            <Field label="Backups keep data for (days)" hint="Shown on erasure certificates as the date erased data ages out of backups."><input type="number" min={1} className="qx-input qx-input--narrow" value={f.backup_retention_days} onChange={(e) => setF({ ...f, backup_retention_days: e.target.value })} /></Field>
          </div>
        </div>
      ) : null}
      {has('compliance_report') ? (
        <div className="qx-stack qx-stack--tight">
          <div className="qx-divider" />
          <h3 className="qx-section-title" style={{ margin: 0 }}>Compliance report</h3>
          <label className="qx-row qx-row--tight" style={{ alignItems: 'center', cursor: 'pointer' }}>
            <span className="qx-toggle"><input type="checkbox" checked={f.cr_enabled} onChange={(e) => setF({ ...f, cr_enabled: e.target.checked })} aria-label="Send a compliance report" /><span className="qx-toggle__track" /></span>
            <span><strong>Send a compliance report</strong><br /><span>A summary of notices, expiring consents and contact counts lands in your Approvals inbox for org admins. Counts and ids only, never names or numbers. Off by default.</span></span>
          </label>
          {f.cr_enabled ? (
            <div className="qx-row qx-row--wrap">
              <Field label="How often"><select className="qx-input" value={f.cr_cadence} onChange={(e) => setF({ ...f, cr_cadence: e.target.value, cr_day: 1 })} aria-label="Report cadence"><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></Field>
              <Field label={f.cr_cadence === 'weekly' ? 'On' : 'On day of month'}>
                {f.cr_cadence === 'weekly' ? (
                  <select className="qx-input" value={f.cr_day} onChange={(e) => setF({ ...f, cr_day: e.target.value })} aria-label="Report day">
                    {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
                  </select>
                ) : <input type="number" min={1} max={28} className="qx-input qx-input--narrow" value={f.cr_day} onChange={(e) => setF({ ...f, cr_day: e.target.value })} aria-label="Report day" />}
              </Field>
              <Field label="At (UTC)" hint="Delivered once per period, never when the service starts."><input type="time" className="qx-input" value={f.cr_time} onChange={(e) => setF({ ...f, cr_time: e.target.value })} aria-label="Report time" /></Field>
            </div>
          ) : null}
        </div>
      ) : null}
      {has('default_quiet_hours') ? (
        <div className="qx-stack qx-stack--tight">
          <div className="qx-divider" />
          <h3 className="qx-section-title" style={{ margin: 0 }}>Quiet hours (org default)</h3>
          <div className="qx-row qx-row--wrap">
            <Field label="From"><input type="time" className="qx-input" value={f.qh_start} onChange={(e) => setF({ ...f, qh_start: e.target.value })} /></Field>
            <Field label="Until"><input type="time" className="qx-input" value={f.qh_end} onChange={(e) => setF({ ...f, qh_end: e.target.value })} /></Field>
            <Field label="Timezone"><input className="qx-input" value={f.qh_tz} onChange={(e) => setF({ ...f, qh_tz: e.target.value })} /></Field>
          </div>
          <div>Agents need a person to approve any call or text inside these hours.</div>
        </div>
      ) : null}
      <div className="qx-row qx-row--end"><button type="submit" className="qx-btn qx-btn--primary" disabled={busy}><SaveIcon />{busy ? 'Saving' : 'Save settings'}</button></div>
    </form>
  )
}

export default function SettingsTab() {
  const { data, error, loading, reload } = useAsync(() => api.getSettings(), [])
  return (
    <section className="qx-card qx-stack" aria-label="Settings">
      <TabHeader icon={GearIcon} title="Settings" subtitle="Defaults for the whole organisation: how numbers are read, how long unknown callers are kept, quiet hours and the compliance report." />
      <div className="qx-divider" />
      <AsyncGuard error={error} loading={loading && !data} onRetry={reload} rows={4} what="Settings">
        {data?.settings ? <Form settings={data.settings} onSaved={reload} /> : null}
      </AsyncGuard>
      <SyncCard />
    </section>
  )
}
