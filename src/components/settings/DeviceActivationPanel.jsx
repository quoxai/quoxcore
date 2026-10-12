/**
 * DeviceActivationPanel — LICENSE-LAUNCH LL-8-dash.
 *
 * Settings → Instance → Licensing. Activates this server with no key paste:
 * the instance asks quox.ai for a short code, the admin approves that code
 * while logged in on quox.ai/link, and the instance polls until the licence
 * lands. The customer never handles the signed key JSON at all.
 *
 * Everything happens through the auth service
 * (POST /api/setup/licensing/device/start|poll, instance-admin gated), so the
 * device_code (this box's bearer secret for the activation) is minted and
 * spent server-side and the browser only ever sees the human code.
 *
 * No browser-only state: the lease is written to instance_config by the auth
 * service, exactly where a pasted key would put it. Closing this page before
 * approval simply abandons the code; nothing half-activated is left behind.
 *
 * Data: services/auth/routes/setup.js → lib/deviceActivationClient.js.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { fetchEntitlements } from '../../services/licenseValidator'
import SettingsCard from './SettingsCard'
import Button from '../ui/Button'

const START_PATH = '/api/setup/licensing/device/start'
const POLL_PATH = '/api/setup/licensing/device/poll'
const DEFAULT_INTERVAL_SECONDS = 5

const LinkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19" />
  </svg>
)

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6" />
  </svg>
)

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
)

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6L9 17l-5-5" />
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

function formatRemaining(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'expired'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${String(secs).padStart(2, '0')}`
}

/** The honest wording for each way an activation can end without a licence. */
function terminalCopy(state, body) {
  switch (state) {
    case 'denied':
      return {
        title: 'Approval was denied',
        detail: 'This code was denied on quox.ai. Nothing was activated on this server.',
      }
    case 'expired':
      return {
        title: 'The code expired',
        detail: 'It was not approved in time. Start a new link to get a fresh code.',
      }
    case 'consumed':
      return {
        title: 'That code was already used',
        detail: 'Activation codes are single use. Start a new link to get a fresh code.',
      }
    case 'seat_limit_reached':
      return {
        title: 'This licence has no free seats',
        detail: body?.max_servers != null
          ? `The licence covers ${body.max_servers} server${body.max_servers === 1 ? '' : 's'}, and they are all in use. Release one on quox.ai or run \`quox setup license deactivate\` on the server that no longer needs it.`
          : 'Release a seat on quox.ai or run `quox setup license deactivate` on the server that no longer needs it, then try again.',
      }
    case 'activation_failed':
      return {
        title: 'Approved, but the licence could not be stored',
        detail: body?.message || body?.error || 'The approval landed but this server could not save the lease. Start a new link and try again.',
      }
    default:
      return {
        title: 'Activation failed',
        detail: body?.message || body?.error || 'The licence server refused the activation.',
      }
  }
}

export default function DeviceActivationPanel({ onNotification, onActivated, authFetch: authFetchProp }) {
  const authFetch = useResolvedAuthFetch(authFetchProp)

  // idle → starting → waiting → activated | terminal
  const [phase, setPhase] = useState('idle')
  const [link, setLink] = useState(null)         // { device_code, user_code, verification_url }
  const [interval_, setInterval_] = useState(DEFAULT_INTERVAL_SECONDS)
  const [deadline, setDeadline] = useState(null)
  const [remaining, setRemaining] = useState(0)
  const [pollCount, setPollCount] = useState(0)  // re-arms the poll timer
  const [blip, setBlip] = useState(null)         // transient "server unreachable" notice
  const [terminal, setTerminal] = useState(null) // { title, detail, bound, max_servers }
  const [lease, setLease] = useState(null)

  const linkRef = useRef(null)
  linkRef.current = link

  const fail = useCallback((state, body) => {
    const copy = terminalCopy(state, body)
    setTerminal({ ...copy, bound: Array.isArray(body?.bound) ? body.bound : null, max_servers: body?.max_servers ?? null })
    setPhase('terminal')
    setLink(null)
    setBlip(null)
    onNotification?.(copy.title, 'error')
  }, [onNotification])

  const start = useCallback(async () => {
    if (!authFetch) {
      fail('error', { message: 'Not authenticated.' })
      return
    }
    setPhase('starting')
    setTerminal(null)
    setBlip(null)
    setLease(null)

    let response
    try {
      response = await authFetch(START_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    } catch (err) {
      fail('error', { message: err.message || 'Could not reach this server.' })
      return
    }

    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.user_code || !data.device_code) {
      fail('error', { message: data.message || data.error || `Could not start an activation (${response.status}).` })
      return
    }

    const seconds = Number(data.expires_in) > 0 ? Number(data.expires_in) : 900
    setLink({
      device_code: data.device_code,
      user_code: data.user_code,
      verification_url: data.verification_url || 'https://quox.ai/link',
    })
    setInterval_(Number(data.interval) > 0 ? Number(data.interval) : DEFAULT_INTERVAL_SECONDS)
    setDeadline(Date.now() + seconds * 1000)
    setRemaining(seconds)
    setPollCount(0)
    setPhase('waiting')
  }, [authFetch, fail])

  const poll = useCallback(async () => {
    const current = linkRef.current
    if (!current) return

    let response
    try {
      response = await authFetch(POLL_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: current.device_code, interval: interval_ }),
      })
    } catch (err) {
      // A blip is not a verdict: the code is still live upstream.
      setBlip(err.message || 'The licence server is unreachable right now.')
      setPollCount(c => c + 1)
      return
    }

    const data = await response.json().catch(() => ({}))

    if (response.status === 503) {
      setBlip(data.message || 'The licence server is unreachable right now. Still waiting.')
      setPollCount(c => c + 1)
      return
    }

    if (response.status === 409 && data.error === 'seat_limit_reached') {
      fail('seat_limit_reached', data)
      return
    }

    if (!response.ok) {
      fail(data.state || 'error', data)
      return
    }

    setBlip(null)
    const state = data.state || 'pending'

    if (state === 'approved') {
      setLease(data.lease || null)
      setLink(null)
      setPhase('activated')
      // Refresh the entitlement cache so the plugin gates reflect the new
      // licence without a reload, same as the pasted-key path does.
      try {
        await fetchEntitlements(authFetch)
      } catch (err) {
        console.warn('[DeviceActivationPanel] entitlements refresh failed:', err.message)
      }
      onNotification?.('This server is activated.', 'success')
      onActivated?.(data)
      return
    }

    if (state === 'pending' || state === 'slow_down') {
      if (Number(data.interval) > 0) setInterval_(Number(data.interval))
      setPollCount(c => c + 1)
      return
    }

    fail(state, data)
  }, [authFetch, interval_, fail, onNotification, onActivated])

  // Poll timer: one timeout per pass, re-armed by pollCount.
  useEffect(() => {
    if (phase !== 'waiting') return undefined
    const timer = setTimeout(() => { poll() }, interval_ * 1000)
    return () => clearTimeout(timer)
  }, [phase, interval_, pollCount, poll])

  // Countdown. When it runs out the code is genuinely dead upstream, so say
  // so rather than polling a corpse.
  useEffect(() => {
    if (phase !== 'waiting' || !deadline) return undefined
    const timer = setInterval(() => {
      const left = Math.round((deadline - Date.now()) / 1000)
      setRemaining(left)
      if (left <= 0) fail('expired', {})
    }, 1000)
    return () => clearInterval(timer)
  }, [phase, deadline, fail])

  const cancel = () => {
    setPhase('idle')
    setLink(null)
    setBlip(null)
  }

  return (
    <SettingsCard
      title="Activate this server"
      subtitle="Approve a short code on quox.ai. No licence key is pasted into this server."
      icon={<LinkIcon />}
      glass
      data-testid="device-activation-panel"
    >
      {phase === 'idle' && (
        <>
          <p style={{ fontSize: 12.5, color: 'var(--ui-text-muted)', margin: '0 0 12px' }}>
            This server will ask quox.ai for a short code. Enter that code while signed in to
            quox.ai and the licence lands here on its own, seat-bound to this instance.
          </p>
          <Button variant="primary" size="sm" icon={<LinkIcon />} onClick={start}>
            Activate this server
          </Button>
        </>
      )}

      {phase === 'starting' && (
        <p style={{ fontSize: 13, color: 'var(--ui-text-muted)', margin: 0 }}>Asking quox.ai for a code...</p>
      )}

      {phase === 'waiting' && link && (
        <div>
          <p style={{ fontSize: 12.5, color: 'var(--ui-text-muted)', margin: '0 0 10px' }}>
            Open{' '}
            <a
              data-testid="device-verification-url"
              href={link.verification_url}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--ui-blue, #3090ff)' }}
            >
              {link.verification_url}
            </a>{' '}
            while signed in to quox.ai, and enter this code:
          </p>

          <div
            data-testid="device-user-code"
            style={{
              fontFamily: 'Monaco, Menlo, monospace',
              fontSize: 30,
              letterSpacing: '0.18em',
              fontWeight: 600,
              textAlign: 'center',
              padding: '16px 8px',
              borderRadius: 8,
              background: 'var(--ui-input-bg, rgba(0,0,0,0.2))',
              border: '1px solid var(--ui-border, rgba(255,255,255,0.12))',
            }}
          >
            {link.user_code}
          </div>

          <p data-testid="device-countdown" style={{ fontSize: 12, color: 'var(--ui-text-muted)', margin: '10px 0 0' }}>
            Expires in {formatRemaining(remaining)}. Keep this page open until it is approved.
          </p>

          {blip && (
            <p style={{ fontSize: 12, color: 'var(--ui-amber, #fbbf24)', margin: '8px 0 0' }}>{blip}</p>
          )}

          <div style={{ marginTop: 12 }}>
            <Button variant="ghost" size="sm" icon={<CloseIcon />} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {phase === 'activated' && (
        <div data-testid="device-activated">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ui-green, #34d399)' }}>
            <CheckIcon />
            <strong style={{ fontSize: 14 }}>This server is activated</strong>
          </div>
          <dl style={{ margin: '12px 0 0', fontSize: 13 }}>
            <div style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
              <dt style={{ color: 'var(--ui-text-muted)', minWidth: 120 }}>Licence</dt>
              <dd style={{ margin: 0 }}>{lease?.license_id || 'unknown'}</dd>
            </div>
            <div style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
              <dt style={{ color: 'var(--ui-text-muted)', minWidth: 120 }}>Entitlements</dt>
              <dd style={{ margin: 0 }}>{(lease?.entitlements || []).join(', ') || 'none'}</dd>
            </div>
            <div style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
              <dt style={{ color: 'var(--ui-text-muted)', minWidth: 120 }}>Lease expires</dt>
              <dd style={{ margin: 0 }}>{lease?.expires_at || 'unknown'}</dd>
            </div>
          </dl>
          <p style={{ fontSize: 12, color: 'var(--ui-text-muted)', margin: '10px 0 0' }}>
            The lease renews itself while this server can reach quox.ai. Release the seat with
            `quox setup license deactivate` before moving the licence to another server.
          </p>
        </div>
      )}

      {phase === 'terminal' && terminal && (
        <div data-testid="device-terminal">
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ui-red, #ef4444)' }}>{terminal.title}</div>
          <p style={{ fontSize: 12.5, color: 'var(--ui-text-muted)', margin: '6px 0 0' }}>{terminal.detail}</p>

          {terminal.bound && terminal.bound.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--ui-text-muted)' }}>
              {terminal.bound.map((entry, i) => (
                <li key={entry?.instance_id || i}>
                  {entry?.instance_name || entry?.instance_id || 'unknown instance'}
                </li>
              ))}
            </ul>
          )}

          <div style={{ marginTop: 12 }}>
            <Button variant="primary" size="sm" icon={<RefreshIcon />} onClick={start}>
              Try again
            </Button>
          </div>
        </div>
      )}
    </SettingsCard>
  )
}
