/**
 * QuoxVoiceConsoleView: org-level console for QuoxLine telephony.
 * P0 increment = Numbers & Policy tab (list numbers, edit label + policy).
 * Calls / Recordings are placeholders. Zero bespoke CSS: composes .qx-* globals.
 * Route bounded-height chain lives in app-shell.css (.qvc-view).
 */
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import ReceiptChip from '../../components/ui/ReceiptChip'

const API = '/collector/api/v1/telephony/numbers'
const CALLS_API = '/collector/api/v1/voice/calls'
const IDENT_API = '/collector/api/v1/telephony/identities'
const INSIGHTS_API = '/collector/api/v1/voice/insights'
const TIP = 'Stored now; enforced as the bridge reads each field'
const E164 = /^\+[1-9]\d{6,14}$/

const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

function getPath(policy, path) {
  return path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), policy)
}

// Overlay one edited field onto a deep copy; empty values remove the key so nothing stray is written.
function setPath(policy, path, value) {
  const next = { ...policy }
  let cur = next
  for (let i = 0; i < path.length - 1; i++) {
    cur[path[i]] = { ...asObj(cur[path[i]]) }
    cur = cur[path[i]]
  }
  const last = path[path.length - 1]
  if (value === '' || value === undefined) delete cur[last]
  else cur[last] = value
  return next
}

function cleanPolicy(policy) {
  if (!Array.isArray(policy.caller_allowlist)) return policy
  const list = policy.caller_allowlist.map((x) => String(x).trim()).filter(Boolean)
  return setPath(policy, ['caller_allowlist'], list.length ? list : '')
}

function Text({ label, hint, policy, path, onChange, placeholder }) {
  return (
    <div className="qx-field">
      <label className="qx-field__label">{label}</label>
      <input
        className="qx-input"
        value={getPath(policy, path) ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(setPath(policy, path, e.target.value))}
      />
      {hint && <div className="qx-field__hint">{hint}</div>}
    </div>
  )
}

function Toggle({ label, policy, path, onChange }) {
  return (
    <div className="qx-row qx-row--tight qx-row--center">
      <label className="qx-toggle">
        <input
          type="checkbox"
          checked={!!getPath(policy, path)}
          onChange={(e) => onChange(setPath(policy, path, e.target.checked))}
        />
        <span className="qx-toggle__track" />
      </label>
      <span>{label}</span>
    </div>
  )
}

function Select({ label, policy, path, options, onChange }) {
  return (
    <div className="qx-field">
      <label className="qx-field__label">{label}</label>
      <select
        className="qx-select"
        value={getPath(policy, path) ?? ''}
        onChange={(e) => onChange(setPath(policy, path, e.target.value))}
      >
        <option value="">(default)</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )
}

function Group({ title, children }) {
  return (
    <div className="qx-stack">
      <h3 className="qx-section-title">{title}</h3>
      <div className="qx-hint qx-hint--sm">{TIP}</div>
      {children}
    </div>
  )
}

function PolicyEditor({ policy, onChange }) {
  const allow = Array.isArray(policy.caller_allowlist) ? policy.caller_allowlist.join(', ') : (policy.caller_allowlist ?? '')
  const fwd = policy.forward_to_mobile
  const fwdBad = fwd && !E164.test(fwd)
  return (
    <div className="qx-stack">
      <Group title="Greeting and persona">
        <div className="qx-grid-2">
          <Text label="Brand" hint="Business name the line answers as, e.g. Quox A.I." policy={policy} path={['brand']} onChange={onChange} placeholder="Quox A.I." />
          <Text label="Opener name" hint="Name spoken in the opener, e.g. CommanderQ" policy={policy} path={['opener_name']} onChange={onChange} placeholder="CommanderQ" />
          <Text label="Greeting" policy={policy} path={['greeting']} onChange={onChange} />
          <Text label="Persona" policy={policy} path={['persona']} onChange={onChange} />
        </div>
      </Group>
      <Group title="IVR menu">
        <div className="qx-grid-3">
          <Toggle label="Support" policy={policy} path={['ivr', 'support']} onChange={onChange} />
          <Toggle label="Investors" policy={policy} path={['ivr', 'investors']} onChange={onChange} />
          <Toggle label="Account" policy={policy} path={['ivr', 'account']} onChange={onChange} />
        </div>
      </Group>
      <Group title="Recording">
        <div className="qx-grid-2">
          <Select label="Mode" policy={policy} path={['recording', 'mode']} options={['off', 'disclaimer', 'dtmf']} onChange={onChange} />
          <Toggle label="Recording enabled" policy={policy} path={['recording', 'enabled']} onChange={onChange} />
        </div>
      </Group>
      <Group title="Access and forwarding">
        <div className="qx-grid-3">
          <Toggle label="PIN required" policy={policy} path={['pin_required']} onChange={onChange} />
          <div className="qx-field">
            <label className="qx-field__label">Caller allowlist (comma separated)</label>
            <input
              className="qx-input"
              value={allow}
              onChange={(e) => onChange(setPath(policy, ['caller_allowlist'], e.target.value.split(',').map((s) => s.trim()).filter(Boolean).length ? e.target.value.split(',').map((s) => s.trim()) : ''))}
            />
          </div>
          <div className="qx-field">
            <label className="qx-field__label">Forward to mobile (E.164)</label>
            <input
              className="qx-input"
              placeholder="+447700900123"
              value={fwd ?? ''}
              onChange={(e) => onChange(setPath(policy, ['forward_to_mobile'], e.target.value))}
            />
            {fwdBad && <div className="qx-field__error">Expected E.164, e.g. +447700900123</div>}
          </div>
        </div>
      </Group>
      <Group title="Routing and schedule">
        <div className="qx-grid-3">
          <Text label="Support widget id" policy={policy} path={['support_widget_id']} onChange={onChange} />
          <Text label="Business hours" policy={policy} path={['business_hours']} onChange={onChange} placeholder="Mon-Fri 09:00-17:30" />
          <Text label="Do not disturb" policy={policy} path={['dnd']} onChange={onChange} placeholder="22:00-07:00" />
        </div>
        <Toggle label="Self learning" policy={policy} path={['self_learning']} onChange={onChange} />
      </Group>
      <Group title="Voice">
        <div className="qx-grid-3">
          <Text label="Voice" policy={policy} path={['voice']} onChange={onChange} />
          <Text label="Language" policy={policy} path={['language']} onChange={onChange} placeholder="en-GB" />
          <Select label="Verbosity" policy={policy} path={['verbosity']} options={['quiet', 'normal', 'verbose']} onChange={onChange} />
        </div>
      </Group>
    </div>
  )
}

function NumberEditor({ row, onSaved, onDeleted, authFetch }) {
  const [label, setLabel] = useState(row.label || '')
  const [policy, setPolicy] = useState(asObj(row.policy))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    setLabel(row.label || '')
    setPolicy(asObj(row.policy))
    setMsg(null)
  }, [row.number, row.label, row.policy])

  const fail = async (res, verb) => {
    if (res.status === 403) return 'Org admin required to change numbers.'
    let detail = ''
    try { detail = (await res.json())?.error || '' } catch { /* body is not JSON */ }
    return `${verb} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`
  }

  const save = async () => {
    setBusy(true); setMsg(null)
    try {
      const res = await authFetch(`${API}/${encodeURIComponent(row.number)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, policy: cleanPolicy(policy) }),
      })
      if (!res.ok) setMsg({ kind: 'error', text: await fail(res, 'Save') })
      else { setMsg({ kind: 'success', text: 'Saved.' }); onSaved() }
    } catch (e) {
      setMsg({ kind: 'error', text: `Save failed: ${e.message || e}` })
    } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!window.confirm(`Remove ${row.number} from this org?`)) return
    setBusy(true); setMsg(null)
    try {
      const res = await authFetch(`${API}/${encodeURIComponent(row.number)}`, { method: 'DELETE' })
      if (!res.ok) setMsg({ kind: 'error', text: await fail(res, 'Delete') })
      else onDeleted(row.number)
    } catch (e) {
      setMsg({ kind: 'error', text: `Delete failed: ${e.message || e}` })
    } finally { setBusy(false) }
  }

  return (
    <div className="qx-stack">
      <div className="qx-row qx-row--apart">
        <h3 className="qx-section-title">{row.number}</h3>
        <div className="qx-row qx-row--tight">
          <button className="qx-btn qx-btn--danger qx-btn--sm" onClick={remove} disabled={busy}>Remove</button>
          <button className="qx-btn qx-btn--primary qx-btn--sm" onClick={save} disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
      {msg && <div className={`qx-banner qx-banner--${msg.kind}`}>{msg.text}</div>}
      <div className="qx-hint">
        This QuoxLine answers as: {policy.opener_name || policy.persona || 'default persona'} for {policy.brand || 'Quox A.I.'} · voice {policy.voice || 'default'} · widget {policy.support_widget_id || 'none'}
      </div>
      <div className="qx-field">
        <label className="qx-field__label">Label</label>
        <input className="qx-input" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <PolicyEditor policy={policy} onChange={setPolicy} />
    </div>
  )
}

function NumbersTab() {
  const { authFetch } = useAuth()
  const [rows, setRows] = useState(null)
  const [configured, setConfigured] = useState([])
  const [bindMsg, setBindMsg] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [newNumber, setNewNumber] = useState('')
  const [addMsg, setAddMsg] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await authFetch(API)
      if (!res.ok) { setError(`Could not load numbers (HTTP ${res.status}).`); setRows([]); return }
      const body = await res.json()
      setRows(Array.isArray(body.numbers) ? body.numbers : [])
      setConfigured(Array.isArray(body.configured) ? body.configured : [])
      setError(null)
    } catch (e) {
      setError(`Could not load numbers: ${e.message || e}`); setRows([])
    }
  }, [authFetch])

  useEffect(() => { load() }, [load])

  const add = async () => {
    const n = newNumber.trim()
    if (!E164.test(n)) { setAddMsg('Enter the number in E.164 form, e.g. +442045770000.'); return }
    setAddMsg(null)
    try {
      const res = await authFetch(`${API}/${encodeURIComponent(n)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: '', policy: {} }),
      })
      if (res.status === 403) { setAddMsg('Org admin required to add numbers.'); return }
      if (!res.ok) { setAddMsg(`Add failed (HTTP ${res.status}).`); return }
      setNewNumber(''); setSelected(n); load()
    } catch (e) { setAddMsg(`Add failed: ${e.message || e}`) }
  }

  const bind = async (line) => {
    setBindMsg(null)
    try {
      const res = await authFetch(`${API}/${encodeURIComponent(line.number)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: line.label || '', policy: {} }),
      })
      if (res.status === 403) { setBindMsg('Org admin required to bind numbers.'); return }
      if (!res.ok) { setBindMsg(`Bind failed (HTTP ${res.status}).`); return }
      setSelected(line.number); load()
    } catch (e) { setBindMsg(`Bind failed: ${e.message || e}`) }
  }

  const current = rows && rows.find((r) => r.number === selected)

  return (
    <div className="qx-stack">
      {error && <div className="qx-banner qx-banner--error">{error}</div>}
      {rows === null && <div className="qx-skeleton qx-skeleton--block" />}
      {configured.length > 0 && (
        <div className="qx-stack">
          <h3 className="qx-section-title">Your QuoxLine</h3>
          {bindMsg && <div className="qx-banner qx-banner--warn">{bindMsg}</div>}
          {configured.map((l) => (
            <div key={l.number} className="qx-row qx-row--apart qx-row--center">
              <div className="qx-row qx-row--tight qx-row--center">
                <span className="qx-code">{l.number}</span>
                <span>{l.label || ''}</span>
              </div>
              <button className="qx-btn qx-btn--primary qx-btn--sm" onClick={() => bind(l)}>Bind</button>
            </div>
          ))}
        </div>
      )}
      {rows && rows.length === 0 && configured.length === 0 && !error && (
        <div className="qx-empty">
          <div className="qx-empty__title">No numbers bound yet</div>
          <div className="qx-empty__body">No numbers bound yet. Add your QuoxLine number above to configure its policy.</div>
        </div>
      )}
      {rows && rows.length > 0 && (
        <table className="qx-table">
          <thead><tr><th>Number</th><th>Label</th><th>Policy keys</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.number}
                className={r.number === selected ? 'qx-table__row--active' : ''}
                onClick={() => setSelected(r.number)}
              >
                <td><span className="qx-code">{r.number}</span></td>
                <td>{r.label || '-'}</td>
                <td>{Object.keys(asObj(r.policy)).length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="qx-row qx-row--tight qx-row--center">
        <input
          className="qx-input qx-input--grow qx-input--mono"
          placeholder="+442045770000"
          value={newNumber}
          onChange={(e) => setNewNumber(e.target.value)}
        />
        <button className="qx-btn qx-btn--sm" onClick={add}>Add number</button>
      </div>
      {addMsg && <div className="qx-banner qx-banner--warn">{addMsg}</div>}
      {current && (
        <NumberEditor
          row={current}
          authFetch={authFetch}
          onSaved={load}
          onDeleted={() => { setSelected(null); load() }}
        />
      )}
    </div>
  )
}

function Placeholder({ title, body = 'Coming soon.' }) {
  return (
    <div className="qx-empty">
      <div className="qx-empty__title">{title}</div>
      <div className="qx-empty__body">{body}</div>
    </div>
  )
}

const toMs = (v) => {
  if (v == null || v === '') return null
  const t = typeof v === 'number' ? v : new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}
const fmtTime = (v) => { const t = toMs(v); return t ? new Date(t).toLocaleString() : '-' }
const isOut = (c) => String(c.direction || '').startsWith('out')

function ago(ms, now = Date.now()) {
  const d = Math.max(0, Math.round((now - ms) / 1000))
  if (d < 60) return `${d}s ago`
  if (d < 3600) return `${Math.round(d / 60)}m ago`
  if (d < 86400) return `${Math.round(d / 3600)}h ago`
  return `${Math.round(d / 86400)}d ago`
}

// Duration only when both ends exist; never invented.
function callDuration(c) {
  const a = toMs(c.started_at)
  const b = toMs(c.ended_at)
  if (a == null || b == null || b < a) return '-'
  const s = Math.round((b - a) / 1000)
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

// The call rows carry no agent field yet, so this is inferred from direction and labelled so.
const handledBy = (c) => (isOut(c) ? 'OutboundQ' : 'ReceptionistQ')
const INFERRED = 'Inferred from direction (call rows carry no agent field yet)'

// The sentence a line answers with, built only from policy keys that are set.
function answerSentence(policy) {
  const p = asObj(policy)
  const parts = [`ReceptionistQ answering as ${p.opener_name || 'Reception'} for ${p.brand || 'Quox A.I.'}`]
  if (p.pin_required) parts.push('PIN required')
  if (p.forward_to_mobile) parts.push('forwards to mobile')
  return parts.join(' · ')
}

// Speaker name for transcript turns: the line's opener_name when it is unambiguous, else "Reception".
function openerFor(lines) {
  const names = [...new Set((lines || []).map((l) => asObj(l.policy).opener_name).filter(Boolean))]
  return names.length === 1 ? names[0] : 'Reception'
}

function Switchboard({ lines, calls, error }) {
  const loading = lines === null || calls === null
  const today = new Date().toDateString()
  const list = calls || []
  const todayCount = list.filter((c) => { const t = toMs(c.started_at); return t != null && new Date(t).toDateString() === today }).length
  const outbound = list.filter(isOut).length
  const canTellLive = list.some((c) => 'ended_at' in c)
  const live = canTellLive ? list.filter((c) => toMs(c.started_at) != null && !toMs(c.ended_at)).length : null
  const times = list.map((c) => toMs(c.started_at)).filter((t) => t != null)
  const last = times.length ? Math.max(...times) : null

  return (
    <div className="qx-card qx-card--bar qx-stack">
      <div className="qx-row qx-row--apart qx-row--nowrap">
        <h3 className="qx-section-title">QuoxVoice switchboard</h3>
        <span className="qx-hint qx-hint--sm">{last ? `last call ${ago(last)}` : 'no calls recorded'}</span>
      </div>
      {error && <div className="qx-banner qx-banner--error">{error}</div>}
      {loading && !error && (
        <>
          <div className="qx-skeleton qx-skeleton--line-lg" />
          <div className="qx-skeleton qx-skeleton--line-lg" />
        </>
      )}
      {!loading && (
        <>
          <div className="qx-row qx-row--wrap">
            <div className="qx-stat">
              <span className="qx-stat__value qx-stat__value--hero">{(lines || []).length}</span>
              <span className="qx-stat__label">{(lines || []).length === 1 ? 'line' : 'lines'}</span>
            </div>
            {live != null && (
              <div className="qx-stat">
                <span className="qx-stat__value qx-stat__value--sm">{live}</span>
                <span className="qx-stat__label">on a call now</span>
              </div>
            )}
            <div className="qx-stat">
              <span className="qx-stat__value qx-stat__value--sm">{list.length}</span>
              <span className="qx-stat__label">calls</span>
            </div>
            <div className="qx-stat">
              <span className="qx-stat__value qx-stat__value--sm">{list.length - outbound}</span>
              <span className="qx-stat__label">inbound</span>
            </div>
            <div className="qx-stat">
              <span className="qx-stat__value qx-stat__value--sm">{outbound}</span>
              <span className="qx-stat__label">outbound</span>
            </div>
          </div>
          {(lines || []).length === 0 && <div className="qx-hint">No QuoxLine bound yet. Add one in the QuoxLines tab.</div>}
          {(lines || []).map((l) => {
            const bound = Object.keys(asObj(l.policy)).length > 0
            return (
              <div key={l.number} className="qx-host-row">
                <span className={`qx-dot qx-dot--static ${bound ? 'qx-dot--online' : 'qx-dot--idle'} qx-host-row__dot`} aria-hidden="true" />
                <div className="qx-host-row__body">
                  <span className="qx-host-row__primary"><span className="qx-code">{l.number}</span></span>
                  <span className="qx-host-row__secondary">{l.label || 'Unlabelled'}</span>
                </div>
                <span className="qx-host-row__meta">{bound ? answerSentence(l.policy) : 'No policy set, answering with defaults'}</span>
              </div>
            )
          })}
          <div className="qx-hint">
            {last
              ? `${todayCount} call${todayCount === 1 ? '' : 's'} today, last call ${ago(last)}.`
              : 'No calls yet, so there is nothing to report on the voice lines.'}
          </div>
        </>
      )}
    </div>
  )
}

const DIRS = [['all', 'All'], ['in', 'Inbound'], ['out', 'Outbound']]

function AgentTag({ call }) {
  return (
    <span className="qx-agent-tile qx-tip" data-tip={INFERRED} title={INFERRED}>
      <span className="qx-agent-tile__body">
        <span className="qx-agent-tile__name">{handledBy(call)}</span>
      </span>
    </span>
  )
}

const DETAIL_TIP = 'Available once the call-to-envelope join ships'

function CallDetail({ call, speaker }) {
  const turns = Array.isArray(call.transcript) ? call.transcript : []
  const ended = toMs(call.ended_at)
  return (
    <div className="qx-card qx-split qx-split--master">
      <div className="qx-stack">
        <div className="qx-row qx-row--apart">
          <h3 className="qx-section-title">Call <span className="qx-code">{call.call_sid}</span></h3>
          <div className="qx-row qx-row--tight">
            {['Open envelope', 'Verify', 'Export'].map((l) => (
              <button key={l} type="button" className="qx-btn qx-btn--sm" disabled title={DETAIL_TIP}>{l}</button>
            ))}
          </div>
        </div>
        <span className="qx-stage-track" role="list" aria-label="call stages">
          <span className={`qx-stage-track__node ${ended ? 'qx-stage-track__node--done' : 'qx-stage-track__node--current'}`} role="listitem" />
          <span className="qx-stage-track__label">answered</span>
          <span className={`qx-stage-track__bar${ended ? ' qx-stage-track__bar--done' : ''}`} />
          <span className={`qx-stage-track__node${ended ? ' qx-stage-track__node--terminal' : ''}`} role="listitem" />
          <span className="qx-stage-track__label">{ended ? 'ended' : 'in progress'}</span>
        </span>
        <div className="qx-kv">
          <div className="qx-stat-row"><span className="qx-stat-row__label">Handled by</span><span className="qx-stat-row__value qx-tip" data-tip={INFERRED} title={INFERRED}>{handledBy(call)} (inferred)</span></div>
          <div className="qx-stat-row"><span className="qx-stat-row__label">Duration</span><span className="qx-stat-row__value">{callDuration(call)}</span></div>
          <div className="qx-stat-row"><span className="qx-stat-row__label">Turns</span><span className="qx-stat-row__value">{turns.length}</span></div>
          <div className="qx-stat-row"><span className="qx-stat-row__label">Receipt</span><span className="qx-stat-row__value"><ReceiptChip state="pending" /></span></div>
        </div>
      </div>
      <div className="qx-stack">
        <h3 className="qx-section-title">Transcript</h3>
        <div className="qx-slate qx-card qx-stack">
          {turns.length === 0 && <div className="qx-hint">No transcript recorded.</div>}
          {turns.map((t, i) => {
            const caller = t.role === 'user'
            const when = toMs(t.ts ?? t.at ?? t.timestamp)
            return (
              <div key={i} className="qx-slot-msg">
                <div className="qx-slot-msg__meta">
                  <span className={`qx-dot qx-dot--static ${caller ? 'qx-dot--idle' : 'qx-dot--online'}`} aria-hidden="true" />
                  <strong>{caller ? 'Caller' : speaker}</strong>
                  <span className="qx-hint qx-hint--sm">{when ? new Date(when).toLocaleTimeString() : `turn ${i + 1}`}</span>
                </div>
                <div className="qx-slot-msg__body">{typeof t.content === 'string' ? t.content : JSON.stringify(t.content)}</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function CallsTab({ calls, lines, error }) {
  const [open, setOpen] = useState(null)
  const [dir, setDir] = useState('all')

  const shown = (calls || []).filter((c) => dir === 'all' || (dir === 'out') === isOut(c))
  const current = calls && calls.find((c) => c.call_sid === open)

  return (
    <div className="qx-stack">
      {error && <div className="qx-banner qx-banner--error">{error}</div>}
      {calls === null && <div className="qx-skeleton qx-skeleton--block" />}
      {calls && calls.length === 0 && !error && (
        <div className="qx-empty">
          <div className="qx-empty__title">No calls yet.</div>
        </div>
      )}
      {calls && calls.length > 0 && (
        <div className="qx-row qx-row--apart qx-row--center">
          <div className="qx-seg" role="group" aria-label="Direction">
            {DIRS.map(([id, l]) => (
              <button key={id} type="button" className={`qx-seg__btn${dir === id ? ' qx-seg__btn--active' : ''}`} aria-pressed={dir === id} onClick={() => setDir(id)}>{l}</button>
            ))}
          </div>
          <span className="qx-hint">Select a call to read its transcript. Receipts show pending until the call-to-envelope join ships.</span>
        </div>
      )}
      {calls && calls.length > 0 && (
        <table className="qx-table">
          <thead><tr><th></th><th>When</th><th>Dir</th><th>Who</th><th>Handled by</th><th>Dur</th><th>Receipt</th></tr></thead>
          <tbody>
            {shown.map((c) => (
              <tr
                key={c.call_sid}
                className={c.call_sid === open ? 'qx-table__row--active' : ''}
                onClick={() => setOpen(c.call_sid === open ? null : c.call_sid)}
              >
                <td>{c.call_sid === open ? '▾' : '▸'}</td>
                <td>
                  <div title={fmtTime(c.started_at)}>{toMs(c.started_at) ? ago(toMs(c.started_at)) : '-'}</div>
                  <div className="qx-hint qx-hint--sm">{c.summary || 'No summary'}</div>
                </td>
                <td><span className={`qx-pill qx-pill--xs ${isOut(c) ? 'qx-pill--purple' : 'qx-pill--info'}`}>{isOut(c) ? 'out' : 'in'}</span></td>
                <td><span className="qx-code">{c.peer || '-'}</span></td>
                <td><AgentTag call={c} /></td>
                <td>{callDuration(c)}</td>
                <td><ReceiptChip state="pending" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {calls && calls.length > 0 && shown.length === 0 && <div className="qx-hint">No calls match this filter.</div>}
      {current && <CallDetail call={current} speaker={openerFor(lines)} />}
    </div>
  )
}

function IdentitiesTab() {
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id
  const [identities, setIdentities] = useState(null)
  const [members, setMembers] = useState(null)
  const [membersError, setMembersError] = useState(false)
  const [error, setError] = useState(null)
  const [msg, setMsg] = useState(null)
  const [number, setNumber] = useState('')
  const [userId, setUserId] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)

  const loadIdentities = useCallback(async () => {
    try {
      const res = await authFetch(IDENT_API)
      if (!res.ok) { setError(`Could not load identities (HTTP ${res.status}).`); setIdentities([]); return }
      const body = await res.json()
      setIdentities(Array.isArray(body.identities) ? body.identities : [])
      setError(null)
    } catch (e) {
      setError(`Could not load identities: ${e.message || e}`); setIdentities([])
    }
  }, [authFetch])

  const loadMembers = useCallback(async () => {
    try {
      const res = await authFetch(`/api/orgs/${orgId}/members`)
      if (!res.ok) { setMembersError(true); return }
      const body = await res.json()
      setMembers(Array.isArray(body.members) ? body.members : [])
      setMembersError(false)
    } catch { setMembersError(true) }
  }, [authFetch, orgId])

  useEffect(() => { loadIdentities(); loadMembers() }, [loadIdentities, loadMembers])

  const memberMap = new Map((members || []).map((m) => [m.id, m]))
  const memberText = (m) => {
    const name = m.display_name || m.email || m.id
    return m.display_name && m.email ? `${name} (${m.email})` : name
  }

  const failText = (res, verb) => (res.status === 403
    ? 'Org admin required to map voice identities.'
    : `${verb} failed (HTTP ${res.status}).`)

  const map = async () => {
    const n = number.trim()
    if (!E164.test(n)) { setMsg({ kind: 'warn', text: 'Enter the number in E.164 form, e.g. +447700900123.' }); return }
    if (!userId.trim()) { setMsg({ kind: 'warn', text: 'Choose a user to map this number to.' }); return }
    setBusy(true); setMsg(null)
    try {
      const res = await authFetch(`${IDENT_API}/${encodeURIComponent(n)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId.trim(), label: label.trim() }),
      })
      if (!res.ok) setMsg({ kind: res.status === 403 ? 'warn' : 'error', text: failText(res, 'Map') })
      else { setNumber(''); setUserId(''); setLabel(''); loadIdentities() }
    } catch (e) {
      setMsg({ kind: 'error', text: `Map failed: ${e.message || e}` })
    } finally { setBusy(false) }
  }

  const remove = async (n) => {
    if (!window.confirm(`Remove the identity mapping for ${n}?`)) return
    setBusy(true); setMsg(null)
    try {
      const res = await authFetch(`${IDENT_API}/${encodeURIComponent(n)}`, { method: 'DELETE' })
      if (!res.ok) setMsg({ kind: res.status === 403 ? 'warn' : 'error', text: failText(res, 'Remove') })
      else loadIdentities()
    } catch (e) {
      setMsg({ kind: 'error', text: `Remove failed: ${e.message || e}` })
    } finally { setBusy(false) }
  }

  return (
    <div className="qx-stack">
      <div className="qx-hint">
        Map a verified caller's phone number to a user. A PIN-verified call from that number then acts on behalf of that user (create notes, drive sessions). Admin only.
      </div>
      {error && <div className="qx-banner qx-banner--error">{error}</div>}
      {msg && <div className={`qx-banner qx-banner--${msg.kind}`}>{msg.text}</div>}
      {identities === null && <div className="qx-skeleton qx-skeleton--block" />}
      {identities && identities.length === 0 && !error && (
        <div className="qx-empty">
          <div className="qx-empty__title">No voice identities mapped yet.</div>
        </div>
      )}
      {identities && identities.length > 0 && (
        <table className="qx-table">
          <thead><tr><th>Number</th><th>User</th><th>Label</th><th></th></tr></thead>
          <tbody>
            {identities.map((i) => {
              const m = memberMap.get(i.user_id)
              return (
                <tr key={i.number}>
                  <td><span className="qx-code">{i.number}</span></td>
                  <td>
                    {m ? (
                      <>
                        <div>{m.display_name || m.email || m.id}</div>
                        {m.display_name && m.email && <div className="qx-hint qx-hint--sm">{m.email}</div>}
                      </>
                    ) : <span className="qx-code">{i.user_id}</span>}
                  </td>
                  <td>{i.label || '-'}</td>
                  <td><button className="qx-btn qx-btn--danger qx-btn--sm" onClick={() => remove(i.number)} disabled={busy}>Remove</button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <div className="qx-row qx-row--tight qx-row--center">
        <input
          className="qx-input qx-input--mono"
          placeholder="+447700900123"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
        />
        {membersError || members === null ? (
          <input
            className="qx-input"
            placeholder="User id"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          />
        ) : (
          <select className="qx-select" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">(select user)</option>
            {members.map((m) => <option key={m.id} value={m.id}>{memberText(m)}</option>)}
          </select>
        )}
        <input
          className="qx-input qx-input--grow"
          placeholder="Label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button className="qx-btn qx-btn--primary qx-btn--sm" onClick={map} disabled={busy}>Map</button>
      </div>
    </div>
  )
}

const fmtDuration = (s) => (s == null ? '-' : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`)

function Stat({ label, value }) {
  return (
    <div className="qx-stat">
      <span className="qx-stat__value">{value}</span>
      <span className="qx-stat__label">{label}</span>
    </div>
  )
}

function InsightsTab() {
  const { authFetch } = useAuth()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await authFetch(INSIGHTS_API)
      if (!res.ok) { setError(`Could not load insights (HTTP ${res.status}).`); setData({}); return }
      setData(await res.json())
      setError(null)
    } catch (e) {
      setError(`Could not load insights: ${e.message || e}`); setData({})
    }
  }, [authFetch])

  useEffect(() => { load() }, [load])

  if (data === null) return <div className="qx-skeleton qx-skeleton--block" />
  if (error) return <div className="qx-banner qx-banner--error">{error}</div>
  if (data.total_calls === 0) {
    return (
      <div className="qx-empty">
        <div className="qx-empty__title">No calls yet.</div>
      </div>
    )
  }
  const days = Array.isArray(data.by_day) ? data.by_day : []
  const peers = Array.isArray(data.top_peers) ? data.top_peers : []
  const maxDay = Math.max(...days.map((d) => Number(d.count) || 0), 1)
  const avgTurns = data.avg_turns == null ? '-' : Number(data.avg_turns).toFixed(1)

  return (
    <div className="qx-stack">
      <div className="qx-grid-3">
        <Stat label="Total calls" value={data.total_calls ?? 0} />
        <Stat label="Inbound" value={data.inbound ?? 0} />
        <Stat label="Outbound" value={data.outbound ?? 0} />
        <Stat label="Avg turns" value={avgTurns} />
        <Stat label="Avg duration" value={fmtDuration(data.avg_duration_sec)} />
        <Stat label="Last call" value={data.last_call_at ? new Date(data.last_call_at).toLocaleString() : '-'} />
      </div>
      {days.length > 0 && (
        <div className="qx-stack qx-stack--tight">
          <h3 className="qx-section-title">Calls by day</h3>
          <div className="qx-bars" style={{ height: 90 }}>
            {days.map((d) => (
              <div
                key={d.day}
                className="qx-bars__bar"
                style={{ '--qx-h': (Number(d.count) || 0) / maxDay }}
                title={`${d.day}: ${d.count} call${d.count === 1 ? '' : 's'}`}
              />
            ))}
          </div>
          <div className="qx-row qx-row--apart">
            <span className="qx-hint qx-hint--sm">{days[0].day}</span>
            <span className="qx-hint qx-hint--sm">{days[days.length - 1].day}</span>
          </div>
        </div>
      )}
      {peers.length > 0 && (
        <div className="qx-stack qx-stack--tight">
          <h3 className="qx-section-title">Top callers</h3>
          <table className="qx-table">
            <thead><tr><th>Peer</th><th>Calls</th></tr></thead>
            <tbody>
              {peers.map((p) => (
                <tr key={p.peer}>
                  <td><span className="qx-code">{p.peer}</span></td>
                  <td>{p.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function RecordingsTab() {
  return (
    <div className="qx-empty">
      <div className="qx-empty__title">Recordings</div>
      <div className="qx-empty__body">
        Recording mode is configured per QuoxLine (in the QuoxLines tab), but the capture and storage engine is not yet available in this instance. Recordings will appear here once it ships.
      </div>
    </div>
  )
}

const VALID_TABS = ['numbers', 'calls', 'team', 'identities', 'insights', 'recordings', 'live']

export default function QuoxVoiceConsoleView() {
  const { authFetch } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const urlTab = searchParams.get('tab')
  const [tab, setTab] = useState(VALID_TABS.includes(urlTab) ? urlTab : 'numbers')
  const selectTab = (id) => {
    setTab(id)
    const next = new URLSearchParams(searchParams)
    next.set('tab', id)
    setSearchParams(next, { replace: true })
  }
  const [lines, setLines] = useState(null)
  const [calls, setCalls] = useState(null)
  const [callsError, setCallsError] = useState(null)
  const [linesError, setLinesError] = useState(null)
  const tabCls = (id) => `qx-tab${tab === id ? ' qx-tab--active' : ''}`

  const loadCalls = useCallback(async () => {
    try {
      const res = await authFetch(CALLS_API)
      if (!res.ok) { setCallsError(`Could not load calls (HTTP ${res.status}).`); setCalls([]); return }
      const body = await res.json()
      setCalls(Array.isArray(body.calls) ? body.calls : [])
      setCallsError(null)
    } catch (e) {
      setCallsError(`Could not load calls: ${e.message || e}`); setCalls([])
    }
  }, [authFetch])

  const loadLines = useCallback(async () => {
    try {
      const res = await authFetch(API)
      if (!res.ok) { setLinesError(`Could not load numbers (HTTP ${res.status}).`); setLines([]); return }
      const body = await res.json()
      setLines(Array.isArray(body.numbers) ? body.numbers : [])
      setLinesError(null)
    } catch (e) {
      setLinesError(`Could not load numbers: ${e.message || e}`); setLines([])
    }
  }, [authFetch])

  useEffect(() => { loadCalls() }, [loadCalls])
  // Re-read the lines on every tab change so the switchboard reflects policy edits.
  useEffect(() => { loadLines() }, [loadLines, tab])

  return (
    <div className="qx-view qvc-view">
      <Switchboard lines={lines} calls={calls} error={linesError || callsError} />
      <div
        className="qx-card"
        style={{ padding: 20, flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <div className="qx-tabs">
          <button className={tabCls('numbers')} onClick={() => selectTab('numbers')}>QuoxLines</button>
          <button className={tabCls('calls')} onClick={() => selectTab('calls')}>Calls</button>
          <button className={tabCls('team')} onClick={() => selectTab('team')}>Team</button>
          <button className={tabCls('identities')} onClick={() => selectTab('identities')}>Identities</button>
          <button className={tabCls('insights')} onClick={() => selectTab('insights')}>Insights</button>
          <button className={tabCls('recordings')} onClick={() => selectTab('recordings')}>Recordings</button>
          <button className={tabCls('live')} onClick={() => selectTab('live')}>Live</button>
        </div>
        {tab === 'numbers' && <NumbersTab />}
        {tab === 'calls' && <CallsTab calls={calls} lines={lines} error={callsError} />}
        {tab === 'team' && <Placeholder title="Team" body="Coming next." />}
        {tab === 'identities' && <IdentitiesTab />}
        {tab === 'insights' && <InsightsTab />}
        {tab === 'live' && <Placeholder title="Live" body="Realtime voice is a separate beta plugin; enable it to talk live." />}
        {tab === 'recordings' && <RecordingsTab />}
      </div>
    </div>
  )
}
