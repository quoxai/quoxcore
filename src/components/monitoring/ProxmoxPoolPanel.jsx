/**
 * ProxmoxPoolPanel: the HYPERION disposable VM pool (DEVFLEET-B5).
 *
 * Shows the pool state, lets a signed-in human lease a VM with their own SSH public key,
 * release one, and (org admins) edit the pool settings. All state is server-side
 * (GET /api/v1/proxmox/pool); the browser holds nothing but form drafts.
 * Styling is global .qx-* classes only.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { usePoolStatus, poolErrorText, POOL_URL } from './useProxmoxPool'

const POLL_MS = 10000
const GRANT_HINT = 'quox approvals grants create --preset proxmox-test-vm-lane ...'
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|PuTTY-User-Key-File|^openssh-key-v1/i
const PUBKEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]{16,2048}={0,2})(?: ([A-Za-z0-9@._:+=-]{1,64}))?$/

/** Client-side check; the server re-validates. Returns an error string or null. */
export function validatePubkeyLine(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return 'An SSH public key is required.'
  if (PRIVATE_KEY_RE.test(text)) return 'That looks like a PRIVATE key. Never paste it. Paste the public key (the .pub file).'
  if (/[\r\n]/.test(text)) return 'Paste a single public key line (one line only).'
  if (/['"`$\\]/.test(text)) return 'The key must not contain quotes, backslashes or shell characters.'
  if (!PUBKEY_RE.test(text)) return 'Paste one ssh-ed25519, ssh-rsa or ecdsa-sha2-nistp* public key line.'
  return null
}

const STATE_PILL = {
  ready: 'qx-pill--online',
  leased: 'qx-pill--info',
  building: 'qx-pill--degraded',
  recycling: 'qx-pill--degraded',
  failed: 'qx-pill--danger',
}

function sinceOf(vm) {
  const t = vm.leased_at || vm.updated_at || vm.created_at
  if (!t) return '--'
  const ms = Date.now() - Date.parse(t)
  if (!Number.isFinite(ms) || ms < 0) return '--'
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 1440) return `${Math.floor(m / 60)}h ago`
  return `${Math.floor(m / 1440)}d ago`
}

const sizeOf = (vm) => `${vm.cores ?? '?'}c / ${vm.mem_gb ?? '?'}G / ${vm.disk_gb ?? '?'}G`

function GuidanceEmpty({ configured }) {
  return (
    <div className="qx-empty">
      <div className="qx-empty__title">The VM pool is {configured ? 'switched off' : 'not set up'}</div>
      <div className="qx-empty__body">
        An org admin enables the pool and adds lanes; each lane needs a standing grant:
        {' '}<code className="qx-code">{GRANT_HINT}</code>
      </div>
    </div>
  )
}

function LeaseForm({ config, authFetch, onLeased, onBuilding }) {
  const { user } = useAuth()
  const defaultLessee = user?.display_name || (user?.email ? user.email.split('@')[0] : '') || ''
  const [lessee, setLessee] = useState(defaultLessee)
  const [pubkey, setPubkey] = useState('')
  const [cores, setCores] = useState(config.default_cores ?? 4)
  const [memory, setMemory] = useState(config.default_mem_gb ?? 8)
  const [disk, setDisk] = useState(config.default_disk_gb ?? 40)
  const [purpose, setPurpose] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const keyError = validatePubkeyLine(pubkey)

  async function submit(e) {
    e.preventDefault()
    setTouched(true)
    setError(null)
    if (keyError) return
    if (!lessee.trim()) { setError('Who is this VM for? A lessee name is required.'); return }
    setBusy(true)
    try {
      const res = await authFetch(`${POOL_URL}/lease`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lessee: lessee.trim(),
          ssh_pubkey: pubkey.trim(),
          cores: Number(cores),
          memory_gb: Number(memory),
          disk_gb: Number(disk),
          purpose: purpose.trim(),
        }),
      })
      let body = null
      try { body = await res.json() } catch { body = null }
      if (res.status === 201 && body && body.lease) onLeased(body.lease)
      else if (res.status === 202 && body && body.state === 'building') onBuilding({ vmid: body.vmid })
      else if (res.status === 202) setError(poolErrorText(body, res.status))
      else setError(poolErrorText(body, res.status))
    } catch (err) {
      setError(err && err.message ? err.message : 'Could not reach the collector')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="qx-card qx-stack" onSubmit={submit} aria-label="Lease a VM">
      <h3 className="qx-section-title">Lease a VM</h3>
      <div className="qx-form-grid">
        <div className="qx-form-grid__cells">
          <div className="qx-field" style={{ '--span': 6, '--span-sm': 12 }}>
            <label className="qx-field__label qx-field__label--required" htmlFor="pool-lessee">Lessee</label>
            <input id="pool-lessee" className="qx-input" value={lessee} onChange={(e) => setLessee(e.target.value)} maxLength={80} />
          </div>
          <div className="qx-field" style={{ '--span': 6, '--span-sm': 12 }}>
            <label className="qx-field__label" htmlFor="pool-purpose">Purpose</label>
            <input id="pool-purpose" className="qx-input" value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={200} />
          </div>
          <div className="qx-field" style={{ '--span': 12 }}>
            <label className="qx-field__label qx-field__label--required" htmlFor="pool-pubkey">SSH public key</label>
            <textarea
              id="pool-pubkey"
              className="qx-textarea qx-input--mono"
              rows={3}
              value={pubkey}
              onChange={(e) => setPubkey(e.target.value)}
              placeholder="ssh-ed25519 AAAA... you@laptop"
              spellCheck={false}
            />
            {touched && keyError
              ? <div className="qx-field__error" role="alert">{keyError}</div>
              : <div className="qx-field__hint">Your own public key. The VM trusts only this key; there is no shared login.</div>}
          </div>
          <div className="qx-field" style={{ '--span': 4, '--span-sm': 12 }}>
            <label className="qx-field__label" htmlFor="pool-cores">Cores</label>
            <input id="pool-cores" type="number" min={1} max={32} className="qx-input" value={cores} onChange={(e) => setCores(e.target.value)} />
          </div>
          <div className="qx-field" style={{ '--span': 4, '--span-sm': 12 }}>
            <label className="qx-field__label" htmlFor="pool-mem">Memory (GB)</label>
            <input id="pool-mem" type="number" min={1} max={128} className="qx-input" value={memory} onChange={(e) => setMemory(e.target.value)} />
          </div>
          <div className="qx-field" style={{ '--span': 4, '--span-sm': 12 }}>
            <label className="qx-field__label" htmlFor="pool-disk">Disk (GB)</label>
            <input id="pool-disk" type="number" min={20} max={500} className="qx-input" value={disk} onChange={(e) => setDisk(e.target.value)} />
          </div>
        </div>
      </div>
      {error && <div className="qx-banner qx-banner--error" role="alert">{error}</div>}
      <div className="qx-row qx-row--end">
        <button type="submit" className="qx-btn qx-btn--primary" disabled={busy}>{busy ? 'Leasing...' : 'Lease VM'}</button>
      </div>
    </form>
  )
}

function LeaseResult({ lease, guestUser, onDismiss }) {
  const user = lease.user || guestUser || 'hyp'
  const line = `ssh ${user}@${lease.ip}`
  return (
    <div className="qx-banner qx-banner--success" role="status">
      <div className="qx-stack qx-stack--tight">
        <strong>VM {lease.vmid} is yours{lease.name ? ` (${lease.name})` : ''}.</strong>
        <div>Connect with <code className="qx-code">{line}</code></div>
        <div>Use the private key that matches the public key you gave. It is destroyed when released or when the lease expires.</div>
        <div><button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onDismiss}>Dismiss</button></div>
      </div>
    </div>
  )
}

function SettingsPanel({ config, authFetch, onSaved }) {
  const [enabled, setEnabled] = useState(!!config.enabled)
  const [warm, setWarm] = useState(String(config.warm_target ?? 2))
  const [vmidMin, setVmidMin] = useState(config.vmid_min ?? '')
  const [vmidMax, setVmidMax] = useState(config.vmid_max ?? '')
  const [lanes, setLanes] = useState((config.lanes || []).map((l) => ({ ...l })))
  const [deny, setDeny] = useState((config.deny_nodes || []).join(', '))
  const [window_, setWindow] = useState(config.backup_window || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  const setLane = (i, patch) => setLanes((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  async function save(e) {
    e.preventDefault()
    setBusy(true); setError(null); setSaved(false)
    const patch = {
      enabled,
      warm_target: warm === '' ? warm : Number(warm),
      lanes: lanes.map((l) => ({ node: String(l.node || '').trim(), template_vmid: Number(l.template_vmid), max: Number(l.max), clone_mode: l.clone_mode || 'linked' })),
      deny_nodes: deny.split(',').map((s) => s.trim()).filter(Boolean),
      backup_window: window_.trim() === '' ? null : window_.trim(),
    }
    if (vmidMin !== '' && vmidMax !== '') { patch.vmid_min = Number(vmidMin); patch.vmid_max = Number(vmidMax) }
    try {
      const res = await authFetch(`${POOL_URL}/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      let body = null
      try { body = await res.json() } catch { body = null }
      if (!res.ok) { setError(poolErrorText(body, res.status)); return }
      setSaved(true)
      onSaved()
    } catch (err) {
      setError(err && err.message ? err.message : 'Could not reach the collector')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="qx-card qx-stack" onSubmit={save} aria-label="Pool settings">
      <h3 className="qx-section-title">Pool settings</h3>
      <label className="qx-row qx-row--tight" htmlFor="pool-enabled">
        <span className="qx-toggle">
          <input id="pool-enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="qx-toggle__track" />
        </span>
        <span>Pool enabled</span>
      </label>
      <div className="qx-form-grid">
        <div className="qx-form-grid__cells">
          <div className="qx-field" style={{ '--span': 3, '--span-sm': 12 }}>
            <label className="qx-field__label" htmlFor="pool-warm">Warm target</label>
            <input id="pool-warm" type="number" min={0} max={20} className="qx-input" value={warm} onChange={(e) => setWarm(e.target.value)} />
          </div>
          <div className="qx-field" style={{ '--span': 3, '--span-sm': 12 }}>
            <label className="qx-field__label" htmlFor="pool-vmid-min">VMID range start</label>
            <input id="pool-vmid-min" type="number" className="qx-input" value={vmidMin} onChange={(e) => setVmidMin(e.target.value)} />
          </div>
          <div className="qx-field" style={{ '--span': 3, '--span-sm': 12 }}>
            <label className="qx-field__label" htmlFor="pool-vmid-max">VMID range end</label>
            <input id="pool-vmid-max" type="number" className="qx-input" value={vmidMax} onChange={(e) => setVmidMax(e.target.value)} />
          </div>
          <div className="qx-field" style={{ '--span': 3, '--span-sm': 12 }}>
            <label className="qx-field__label" htmlFor="pool-window">Backup window (UTC)</label>
            <input id="pool-window" className="qx-input qx-input--mono" placeholder="05:45-08:00" value={window_} onChange={(e) => setWindow(e.target.value)} />
          </div>
          <div className="qx-field" style={{ '--span': 12 }}>
            <label className="qx-field__label" htmlFor="pool-deny">Denied nodes (comma separated)</label>
            <input id="pool-deny" className="qx-input qx-input--mono" value={deny} onChange={(e) => setDeny(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="qx-stack qx-stack--compact">
        <div className="qx-row qx-row--apart">
          <span className="qx-field__label">Lanes</span>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setLanes((ls) => [...ls, { node: '', template_vmid: '', max: 5, clone_mode: 'linked' }])}>Add lane</button>
        </div>
        {lanes.length === 0 && <div className="qx-field__hint">No lanes yet. A lane is one node and one template VM; the pool only builds where a lane exists.</div>}
        {lanes.map((l, i) => (
          <div className="qx-row qx-row--wrap qx-row--tight" key={i} role="group" aria-label={`Lane ${i + 1}`}>
            <input aria-label={`Lane ${i + 1} node`} className="qx-input qx-input--mono" placeholder="node" value={l.node} onChange={(e) => setLane(i, { node: e.target.value })} />
            <input aria-label={`Lane ${i + 1} template VMID`} type="number" className="qx-input qx-input--narrow" placeholder="template" value={l.template_vmid} onChange={(e) => setLane(i, { template_vmid: e.target.value })} />
            <input aria-label={`Lane ${i + 1} max`} type="number" className="qx-input qx-input--narrow" placeholder="max" value={l.max} onChange={(e) => setLane(i, { max: e.target.value })} />
            <select aria-label={`Lane ${i + 1} clone mode`} className="qx-select qx-select--auto" value={l.clone_mode || 'linked'} onChange={(e) => setLane(i, { clone_mode: e.target.value })}>
              <option value="linked">linked</option>
              <option value="full">full</option>
            </select>
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setLanes((ls) => ls.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
      </div>

      {error && <div className="qx-banner qx-banner--error" role="alert">{error}</div>}
      {saved && !error && <div className="qx-banner qx-banner--success" role="status">Settings saved.</div>}
      <div className="qx-row qx-row--end">
        <button type="submit" className="qx-btn qx-btn--primary" disabled={busy}>{busy ? 'Saving...' : 'Save settings'}</button>
      </div>
    </form>
  )
}

export function ProxmoxPoolPanel({ pool: examplepoolsp }) {
  const own = usePoolStatus({ enabled: !examplepoolsp })
  const pool = examplepoolsp || own
  const { authFetch } = useAuth()
  const { isOrgAdmin } = useWorkspace()
  const [lease, setLease] = useState(null)
  const [building, setBuilding] = useState(null) // { vmid }
  const [buildNote, setBuildNote] = useState(null)
  const [releasing, setReleasing] = useState(null) // vm awaiting confirm
  const [relBusy, setRelBusy] = useState(false)
  const [relError, setRelError] = useState(null)
  const [showSettings, setShowSettings] = useState(false)

  const data = pool.data
  const config = data?.config
  const vms = useMemo(() => data?.vms || [], [data])
  const reload = pool.reload

  // A made-to-order lease returned 202: poll every 10s until that VM is leased or failed.
  useEffect(() => {
    if (!building) return undefined
    const id = setInterval(() => { reload() }, POLL_MS)
    return () => clearInterval(id)
  }, [building, reload])

  useEffect(() => {
    if (!building) return
    const vm = vms.find((v) => v.vmid === building.vmid)
    if (!vm) return
    if (vm.state === 'leased' && vm.ip) {
      setLease({ vmid: vm.vmid, name: vm.name, ip: vm.ip, user: config?.guest_user })
      setBuilding(null); setBuildNote(null)
    } else if (vm.state === 'failed') {
      setBuildNote(`VM ${vm.vmid} failed to build: ${vm.last_error || 'no reason recorded'}`)
      setBuilding(null)
    }
  }, [vms, building, config])

  const laneRows = useMemo(() => (config?.lanes || []).map((l) => ({
    ...l, used: vms.filter((v) => v.node === l.node && v.state !== 'failed').length,
  })), [config, vms])

  const doRelease = useCallback(async () => {
    if (!releasing) return
    setRelBusy(true); setRelError(null)
    try {
      const res = await authFetch(`${POOL_URL}/${releasing.vmid}/release`, { method: 'POST' })
      let body = null
      try { body = await res.json() } catch { body = null }
      if (!res.ok) { setRelError(poolErrorText(body, res.status)); return }
      setReleasing(null)
      reload()
    } catch (err) {
      setRelError(err && err.message ? err.message : 'Could not reach the collector')
    } finally {
      setRelBusy(false)
    }
  }, [releasing, authFetch, reload])

  if (pool.loading && !data) return <div className="qx-card"><span className="qx-spinner qx-spinner--sm" /> Loading the VM pool...</div>
  if (!data) {
    return (
      <div className="qx-stack">
        <div className="qx-banner qx-banner--error" role="alert">Could not load the VM pool: {pool.error || 'unknown error'}</div>
        <div><button type="button" className="qx-btn qx-btn--ghost" onClick={reload}>Retry</button></div>
      </div>
    )
  }

  const counts = data.counts || {}
  const enabled = !!config.enabled
  const settings = isOrgAdmin ? (
    <>
      <div className="qx-row qx-row--end">
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setShowSettings((s) => !s)}>
          {showSettings ? 'Hide settings' : 'Settings'}
        </button>
      </div>
      {showSettings && <SettingsPanel config={config} authFetch={authFetch} onSaved={reload} />}
    </>
  ) : null

  if (!enabled) {
    return (
      <div className="qx-stack qx-pad">
        <GuidanceEmpty configured={!!config.configured} />
        {settings}
      </div>
    )
  }

  return (
    <div className="qx-stack qx-pad">
      <div className="qx-row qx-row--apart qx-row--wrap">
        <div className="qx-row qx-row--tight qx-row--wrap">
          <span className="qx-pill qx-pill--online">Pool enabled</span>
          <span className="qx-chip qx-chip--static">Warm target {config.warm_target}</span>
          <span className="qx-chip qx-chip--static">{counts.ready || 0} ready</span>
          <span className="qx-chip qx-chip--static">{counts.leased || 0} leased</span>
          <span className="qx-chip qx-chip--static">{counts.building || 0} building</span>
          {(counts.failed || 0) > 0 && <span className="qx-pill qx-pill--danger">{counts.failed} failed</span>}
          {config.backup_window && <span className="qx-chip qx-chip--static">Backup window {config.backup_window} UTC</span>}
        </div>
        {settings}
      </div>

      {data.paused && (
        <div className="qx-banner qx-banner--warn" role="alert">
          Warming is paused: a host command needs approval {data.paused.approval_id}. Approve it in Approvals, or give the lane a standing grant: <code className="qx-code">{GRANT_HINT}</code>
        </div>
      )}
      {pool.error && <div className="qx-banner qx-banner--error" role="alert">Refresh failed: {pool.error}</div>}

      {lease && <LeaseResult lease={lease} guestUser={config.guest_user} onDismiss={() => setLease(null)} />}
      {building && (
        <div className="qx-banner qx-banner--info" role="status">
          <span className="qx-spinner qx-spinner--sm" /> Your VM {building.vmid} is building. This takes a few minutes; this page checks every 10 seconds.
        </div>
      )}
      {buildNote && <div className="qx-banner qx-banner--error" role="alert">{buildNote}</div>}

      <section className="qx-card qx-stack" aria-label="Lanes">
        <h3 className="qx-section-title">Lanes</h3>
        {laneRows.length === 0 ? <div className="qx-field__hint">No lanes configured.</div> : (
          <table className="qx-table qx-table--dense">
            <thead><tr><th>Node</th><th>Template</th><th>Clone</th><th>Used / max</th></tr></thead>
            <tbody>
              {laneRows.map((l) => (
                <tr key={l.node}>
                  <td>{l.node}</td><td>{l.template_vmid}</td><td>{l.clone_mode}</td><td>{l.used} / {l.max}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="qx-card qx-stack" aria-label="Pool VMs">
        <h3 className="qx-section-title">Pool VMs</h3>
        {vms.length === 0 ? <div className="qx-field__hint">No pool VMs yet. The scheduler warms up to {config.warm_target} within a few minutes, or lease one below to build to order.</div> : (
          <table className="qx-table qx-table--dense">
            <thead><tr><th>VMID</th><th>Name</th><th>Node</th><th>State</th><th>IP</th><th>Size</th><th>Lessee</th><th>Purpose</th><th>Since</th><th /></tr></thead>
            <tbody>
              {vms.map((v) => (
                <tr key={v.vmid}>
                  <td>{v.vmid}</td>
                  <td>{v.name}</td>
                  <td>{v.node}</td>
                  <td>
                    <span className={`qx-pill qx-pill--sm ${STATE_PILL[v.state] || 'qx-pill--info'}`}>{v.state}</span>
                    {v.state === 'failed' && v.last_error ? <div className="qx-field__hint">{v.last_error}</div> : null}
                  </td>
                  <td>{v.ip || '--'}</td>
                  <td>{sizeOf(v)}</td>
                  <td>{v.lessee || '--'}</td>
                  <td>{v.purpose || '--'}</td>
                  <td>{sinceOf(v)}</td>
                  <td>
                    {(v.state === 'leased' || v.state === 'ready') && (
                      <button type="button" className="qx-btn qx-btn--danger qx-btn--sm" onClick={() => { setRelError(null); setReleasing(v) }}>Release</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <LeaseForm
        key={config.org_id || 'org'}
        config={config}
        authFetch={authFetch}
        onLeased={(l) => { setLease(l); setBuildNote(null); reload() }}
        onBuilding={(b) => { setBuilding(b); setLease(null); setBuildNote(null); reload() }}
      />

      {releasing && (
        <div className="qx-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !relBusy) setReleasing(null) }}>
          <div className="qx-modal" role="dialog" aria-modal="true" aria-label="Release VM">
            <div className="qx-modal__header"><h3>Release VM {releasing.vmid}?</h3></div>
            <div className="qx-modal__body">
              <p>
                {releasing.name} on {releasing.node}
                {releasing.lessee ? `, leased to ${releasing.lessee}` : ''} will be destroyed. This cannot be undone.
              </p>
              {relError && <div className="qx-banner qx-banner--error" role="alert">{relError}</div>}
              <div className="qx-modal__actions">
                <button type="button" className="qx-btn qx-btn--ghost" disabled={relBusy} onClick={() => setReleasing(null)}>Cancel</button>
                <button type="button" className="qx-btn qx-btn--danger" disabled={relBusy} onClick={doRelease}>{relBusy ? 'Releasing...' : 'Destroy VM'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ProxmoxPoolPanel
