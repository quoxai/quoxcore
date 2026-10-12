/**
 * EnforcementPanel — LICENSE-LAUNCH LL-6b piece 4.
 *
 * Settings → Security. Shows what each security enforcement gate is ACTUALLY
 * doing right now, whether the environment agrees, and any break-glass window
 * holding one open.
 *
 * Why it exists: the collector's default-deny gate and AEE endpoint auth are
 * both switched by an env var that defaults to OFF, so a production box could
 * run with them decorative and nothing on any screen would say so. Under the
 * no-env-only-config house rule an enforcement flag needs a visible state and
 * a governed way to change it. In production, off without an unexpired
 * break-glass record is now treated as ON by the services themselves.
 *
 * Writing (open or close a window) is instance-admin only server-side; this
 * component surfaces the 403 rather than pretending to gate it.
 *
 * Data: src/services/enforcementClient.js → services/auth/routes/setup.js.
 */

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import SettingsCard from './SettingsCard'
import Button from '../ui/Button'
import { fetchEnforcement, openBreakGlass, clearBreakGlass } from '../../services/enforcementClient'

const ShieldIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
)

const KeyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 2l-2 2m-7.6 7.6a5 5 0 1 1-7.1 7.1 5 5 0 0 1 7.1-7.1zm0 0L15 8m0 0l3 3 3-3-3-3" />
  </svg>
)

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
)

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6" />
  </svg>
)

function useResolvedAuthFetch(explicitAuthFetch) {
  let ctx = null
  try {
    ctx = useAuth()
  } catch {
    ctx = null
  }
  return explicitAuthFetch || ctx?.authFetch
}

function formatExpiry(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const hours = Math.max(0, Math.round((t - Date.now()) / 3600_000))
  return `${new Date(t).toLocaleString()} (about ${hours}h from now)`
}

function stateLabel(flag) {
  if (flag.forced_on) return 'Enforced (forced)'
  return flag.enforced ? 'Enforced' : 'Not enforced'
}

function stateColour(flag) {
  if (flag.forced_on) return 'var(--ui-amber, #fbbf24)'
  return flag.enforced ? 'var(--ui-green, #34d399)' : 'var(--ui-red, #ef4444)'
}

function FlagRow({ flag, maxHours, busy, onOpen, onClear }) {
  const [showForm, setShowForm] = useState(false)
  const [reason, setReason] = useState('')
  const [hours, setHours] = useState(4)

  const submit = async () => {
    await onOpen({ flag: flag.key, reason, hours: Number(hours) })
    setShowForm(false)
    setReason('')
  }

  return (
    <div
      data-testid={`enforcement-flag-${flag.key}`}
      style={{
        padding: '12px 0',
        borderBottom: '1px solid var(--ui-border, rgba(255,255,255,0.08))',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 500 }}>{flag.name}</div>
          <div style={{ fontSize: 12, color: 'var(--ui-text-muted)', marginTop: 2 }}>{flag.key}</div>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: stateColour(flag), whiteSpace: 'nowrap' }}>
          {stateLabel(flag)}
        </div>
      </div>

      {flag.description && (
        <p style={{ fontSize: 12.5, color: 'var(--ui-text-muted)', margin: '8px 0 0' }}>{flag.description}</p>
      )}

      <p style={{ fontSize: 12, color: 'var(--ui-text-muted)', margin: '6px 0 0' }}>
        Environment asks for: {flag.env_enforced ? 'enforce' : 'off'}.
      </p>

      {flag.forced_on && (
        <div style={{
          margin: '10px 0 0',
          padding: '8px 10px',
          fontSize: 12,
          borderRadius: 6,
          background: 'rgba(251, 191, 36, 0.1)',
          border: '1px solid rgba(251, 191, 36, 0.35)',
          color: '#fbbf24',
        }}>
          Switched off in the environment, but this is production and no break-glass window is open,
          so the service is enforcing anyway. Open a window below if the gate genuinely has to stay off.
        </div>
      )}

      {flag.break_glass && (
        <div
          data-testid={`break-glass-${flag.key}`}
          style={{
            margin: '10px 0 0',
            padding: '8px 10px',
            fontSize: 12,
            borderRadius: 6,
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
          }}
        >
          <div><strong>Break-glass open.</strong> {flag.break_glass.reason}</div>
          <div style={{ marginTop: 4, color: 'var(--ui-text-muted)' }}>
            Opened by {flag.break_glass.created_by}. Expires {formatExpiry(flag.break_glass.expires_at)}.
          </div>
          <div style={{ marginTop: 8 }}>
            <Button variant="outline-red" size="small" icon={<CloseIcon />} disabled={busy}
              onClick={() => onClear(flag.key)}>
              Close now
            </Button>
          </div>
        </div>
      )}

      {!flag.break_glass && !showForm && (
        <div style={{ marginTop: 10 }}>
          <Button variant="outline-amber" size="small" icon={<KeyIcon />} disabled={busy}
            onClick={() => setShowForm(true)}>
            Open break-glass
          </Button>
        </div>
      )}

      {showForm && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 12, color: 'var(--ui-text-muted)' }}>
            Why this gate has to be off (recorded against your account)
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="For example: fleet rollout of the agent service key still in flight"
              style={{
                display: 'block', width: '100%', marginTop: 4, padding: 8, fontSize: 13,
                borderRadius: 6, background: 'var(--ui-input-bg, rgba(0,0,0,0.2))',
                border: '1px solid var(--ui-border, rgba(255,255,255,0.12))',
                color: 'var(--ui-text-primary, inherit)',
              }}
            />
          </label>
          <label style={{ fontSize: 12, color: 'var(--ui-text-muted)' }}>
            Expires after (hours, {maxHours} maximum)
            <input
              type="number" min={1} max={maxHours} value={hours}
              onChange={(e) => setHours(e.target.value)}
              style={{
                display: 'block', width: 120, marginTop: 4, padding: 8, fontSize: 13,
                borderRadius: 6, background: 'var(--ui-input-bg, rgba(0,0,0,0.2))',
                border: '1px solid var(--ui-border, rgba(255,255,255,0.12))',
                color: 'var(--ui-text-primary, inherit)',
              }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="primary" size="small" icon={<KeyIcon />} disabled={busy || !reason.trim()}
              onClick={submit}>
              Open window
            </Button>
            <Button variant="ghost" size="small" icon={<CloseIcon />} disabled={busy}
              onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function EnforcementPanel({ onNotification, authFetch: authFetchProp }) {
  const authFetch = useResolvedAuthFetch(authFetchProp)
  const [flags, setFlags] = useState([])
  const [maxHours, setMaxHours] = useState(72)
  const [nodeEnv, setNodeEnv] = useState('unknown')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchEnforcement(authFetch)
      .then(({ flags: rows, maxBreakGlassHours, nodeEnv: env }) => {
        setFlags(rows)
        setMaxHours(maxBreakGlassHours)
        setNodeEnv(env)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [authFetch])

  useEffect(() => { load() }, [load])

  const handleOpen = async ({ flag, reason, hours }) => {
    setBusy(true)
    try {
      await openBreakGlass(authFetch, { flag, reason, hours })
      onNotification?.(`Break-glass window opened for ${flag}.`, 'success')
      load()
    } catch (err) {
      onNotification?.(err.message || 'Could not open the break-glass window.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async (flag) => {
    setBusy(true)
    try {
      await clearBreakGlass(authFetch, flag)
      onNotification?.(`Break-glass window closed for ${flag}.`, 'success')
      load()
    } catch (err) {
      onNotification?.(err.message || 'Could not close the break-glass window.', 'error')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <SettingsCard title="Enforcement" subtitle="Security gates and break-glass" icon={<ShieldIcon />} glass>
        <p style={{ color: 'var(--ui-text-muted)', fontSize: 13, margin: 0 }}>Loading…</p>
      </SettingsCard>
    )
  }

  return (
    <SettingsCard
      title="Enforcement"
      subtitle={`Security gates and break-glass. This instance runs as ${nodeEnv}.`}
      icon={<ShieldIcon />}
      glass
      headerActions={(
        <Button variant="ghost" size="small" icon={<RefreshIcon />} onClick={load} disabled={busy}>
          Refresh
        </Button>
      )}
    >
      {error && (
        <p style={{ color: '#ef4444', fontSize: 12, margin: '0 0 12px' }}>
          Could not load enforcement posture: {error}
        </p>
      )}

      <p style={{ fontSize: 12.5, color: 'var(--ui-text-muted)', margin: '0 0 8px' }}>
        In production a gate switched off in the environment is enforced anyway unless an
        instance admin opens a break-glass window. Windows carry a reason, are recorded against the
        account that opened them, and expire after at most {maxHours} hours.
      </p>

      {flags.length === 0 && !error ? (
        <p style={{ color: 'var(--ui-text-muted)', fontSize: 13, margin: 0 }}>
          No enforcement flags registered.
        </p>
      ) : (
        flags.map((flag) => (
          <FlagRow
            key={flag.key}
            flag={flag}
            maxHours={maxHours}
            busy={busy}
            onOpen={handleOpen}
            onClear={handleClear}
          />
        ))
      )}
    </SettingsCard>
  )
}
