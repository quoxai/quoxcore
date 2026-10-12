/**
 * FreeClaimPanel, LICENSE-LAUNCH LL-8.
 *
 * Self-serve claim for a governed FREE plugin. Any org owner/admin can run
 * this, no instance-admin gate, no key paste: the browser asks the auth
 * service for a short code, the org owner approves it on quox.ai/link, and
 * this panel polls until the claim lands. Mirrors DeviceActivationPanel's
 * device-code state machine, but claims a whole bundle of plugins in one
 * pass, the conversion-ladder cascade: approving once unlocks every
 * currently unclaimed free plugin, not just the one whose card was clicked.
 *
 * Visual language: the QX Lab store prototype's "unlock cascade"
 * (src/pages/views/qx-lab/QxLabStoreView.jsx), the connect-account beat with
 * segmented glowing code chips, then each unlocked plugin seats in as a
 * staggered qx-minichip, celebrated by name rather than by licence ID.
 *
 * Data: services/auth/routes/setup.js (free/device/start|poll, a parallel
 * stream). This component depends only on the contract below, not on the
 * server implementation.
 *
 * POST /api/setup/licensing/free/device/start {plugin_ids}
 *   -> {device_code, user_code, verification_url, expires_in, interval,
 *       accepted:[id], refused:[{plugin_id, reason}]}
 *      A mixed request proceeds with `accepted`; `refused` entries are shown
 *      as informational, not a failure.
 *   -> 403 {error:'free_only', refused:[{plugin_id, reason}]} only when
 *      nothing in the request was claimable.
 * POST /api/setup/licensing/free/device/poll {device_code}
 *   -> {state:'pending', interval}
 *   -> {state:'approved', terminal:true, results:[{license_id, ok, lease?|error?}]}
 *   -> {state:'denied'|'expired'|'contract_violation'|'error', terminal:true, error, message?}
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchEntitlements } from '../../services/licenseValidator'

const START_PATH = '/api/setup/licensing/free/device/start'
const POLL_PATH = '/api/setup/licensing/free/device/poll'
const DEFAULT_INTERVAL_SECONDS = 5

// Fallback glyph (bolt) for a plugin the richer `plugins` prop didn't cover.
const DEFAULT_GLYPH = 'M13 2L3 14h9l-1 8 10-12h-9l1-8z'
const DEFAULT_ACCENT = '#38bdf8'

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

const GiftIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="8" width="18" height="4" />
    <path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
    <path d="M7.5 8a2.5 2.5 0 0 1 0-5C9.5 3 12 8 12 8s2.5-5 4.5-5a2.5 2.5 0 0 1 0 5" />
  </svg>
)

/** A plugin glyph drawn from a multi-path `M ... M ...` icon string, same
 * segment-split convention as PluginCard's PLUGIN_ICONS map. */
function ChipGlyph({ d, color }) {
  const segments = d.split(' M')
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {segments.map((seg, i) => <path key={i} d={i === 0 ? seg : `M${seg}`} />)}
    </svg>
  )
}

function formatRemaining(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'expired'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${String(secs).padStart(2, '0')}`
}

/** Turns a refused[] entry list into one readable sentence fragment. */
function refusedIdList(refused) {
  return (Array.isArray(refused) ? refused : [])
    .map(r => r?.plugin_id)
    .filter(Boolean)
    .join(', ')
}

/** The honest wording for each way a free claim can end without a licence. */
function terminalCopy(state, body) {
  switch (state) {
    case 'free_only': {
      const ids = refusedIdList(body?.refused)
      return {
        title: 'Not part of the free tier',
        detail: ids
          ? `${ids} ${ids.includes(',') ? 'are' : 'is'} not part of the free tier, so nothing could be claimed this way.`
          : 'None of the selected plugins are free.',
      }
    }
    case 'denied':
      return {
        title: 'Approval was denied',
        detail: 'This code was denied on quox.ai. Nothing was claimed.',
      }
    case 'expired':
      return {
        title: 'The code expired',
        detail: 'It was not approved in time. Try again to get a fresh code.',
      }
    case 'contract_violation':
      return {
        title: 'This claim could not be completed',
        detail: body?.message || 'One or more of the selected plugins failed the licence terms check. Nothing was claimed.',
      }
    default:
      return {
        title: 'Claim failed',
        detail: body?.message || body?.error || 'The licence server refused the claim.',
      }
  }
}

/** The plugins about to be (or that were) claimed, as chip-ready descriptors.
 * Prefers the richer `plugins` prop (name, displayName, accent, glyphPath,
 * the same shape PluginSettings hands the cards) and falls back to the
 * parallel pluginIds/pluginNames arrays for back-compat. */
function buildChipList(pluginIds, pluginNames, plugins) {
  if (Array.isArray(plugins) && plugins.length > 0) {
    return plugins.map(p => ({
      id: p.name,
      name: p.displayName || p.name,
      accent: p.accent || DEFAULT_ACCENT,
      glyph: p.glyphPath || DEFAULT_GLYPH,
    }))
  }
  const ids = Array.isArray(pluginIds) ? pluginIds : []
  const names = Array.isArray(pluginNames) ? pluginNames : []
  if (ids.length === 0 && names.length > 0) {
    return names.map(n => ({ id: n, name: n, accent: DEFAULT_ACCENT, glyph: DEFAULT_GLYPH }))
  }
  return ids.map((id, i) => ({
    id,
    name: names[i] || id,
    accent: DEFAULT_ACCENT,
    glyph: DEFAULT_GLYPH,
  }))
}

/**
 * @param {string[]} pluginIds - manifest names to claim, clicked plugin first
 * @param {string[]} pluginNames - display names, same order as pluginIds
 * @param {Array<{name:string,displayName?:string,accent?:string,glyphPath?:string}>} [plugins]
 *   - richer descriptors so chips match the plugin cards' accent + glyph
 * @param {Function} authFetch - the app's authenticated fetch
 * @param {Function} onClose
 * @param {Function} onClaimed - called with the raw `results` array on approval
 */
export default function FreeClaimPanel({ pluginIds, pluginNames, plugins, authFetch, onClose, onClaimed }) {
  // idle -> starting -> waiting -> approved | terminal
  const [phase, setPhase] = useState('idle')
  const [link, setLink] = useState(null)
  const [interval_, setInterval_] = useState(DEFAULT_INTERVAL_SECONDS)
  const [deadline, setDeadline] = useState(null)
  const [remaining, setRemaining] = useState(0)
  const [pollCount, setPollCount] = useState(0)
  const [blip, setBlip] = useState(null)
  const [terminal, setTerminal] = useState(null)
  const [results, setResults] = useState(null)
  const [refused, setRefused] = useState([])
  const [lit, setLit] = useState(() => new Set())
  const [levelBurst, setLevelBurst] = useState(false)

  const linkRef = useRef(null)
  linkRef.current = link

  // Timers for the staggered unlock cascade, cleared on every unmount so
  // a closed panel never keeps ticking (same later()/timers.current
  // pattern as QxLabStoreView's journey playback).
  const timersRef = useRef([])
  const later = useCallback((fn, ms) => {
    const t = setTimeout(fn, ms)
    timersRef.current.push(t)
    return t
  }, [])
  useEffect(() => () => { timersRef.current.forEach(clearTimeout); timersRef.current = [] }, [])

  const fail = useCallback((state, body) => {
    setTerminal(terminalCopy(state, body))
    setPhase('terminal')
    setLink(null)
    setBlip(null)
  }, [])

  const start = useCallback(async () => {
    if (!authFetch) {
      fail('error', { message: 'Not authenticated.' })
      return
    }
    setPhase('starting')
    setTerminal(null)
    setBlip(null)
    setResults(null)
    setRefused([])

    let response
    try {
      response = await authFetch(START_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin_ids: pluginIds }),
      })
    } catch (err) {
      fail('error', { message: err.message || 'Could not reach this server.' })
      return
    }

    const data = await response.json().catch(() => ({}))

    if (response.status === 403 && data.error === 'free_only') {
      fail('free_only', data)
      return
    }

    if (!response.ok || !data.user_code || !data.device_code) {
      fail('error', { message: data.message || data.error || `Could not start a claim (${response.status}).` })
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
    // A mixed request still starts: the claim proceeds for whatever was
    // accepted, and any refused ids ride along so the review UI can say why
    // they were left out instead of pretending the request was clean.
    setRefused(Array.isArray(data.refused) ? data.refused : [])
    setPhase('waiting')
  }, [authFetch, pluginIds, fail])

  const poll = useCallback(async () => {
    const current = linkRef.current
    if (!current) return

    let response
    try {
      response = await authFetch(POLL_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: current.device_code }),
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

    if (!response.ok && !data.terminal) {
      fail(data.state || 'error', data)
      return
    }

    setBlip(null)
    const state = data.state || 'pending'

    if (state === 'approved') {
      setResults(Array.isArray(data.results) ? data.results : [])
      setLink(null)
      setPhase('approved')
      // Refresh the entitlement cache so the plugin gates reflect the claim
      // without a reload, same as the device-activation and pasted-key paths.
      try {
        await fetchEntitlements(authFetch)
      } catch (err) {
        console.warn('[FreeClaimPanel] entitlements refresh failed:', err.message)
      }
      onClaimed?.(data.results || [])
      return
    }

    if (state === 'pending' || state === 'slow_down') {
      if (Number(data.interval) > 0) setInterval_(Number(data.interval))
      setPollCount(c => c + 1)
      return
    }

    fail(state, data)
  }, [authFetch, fail, onClaimed])

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

  const chipList = buildChipList(pluginIds, pluginNames, plugins)

  // The unlock set: everything the panel was given, minus whatever the
  // start call already refused, minus anything the approved call itself
  // marked ok:false. A plugin that failed the claim was never unlocked,
  // so it never joins the celebration, only the honest failure list below.
  const refusedIds = new Set(refused.map(r => r?.plugin_id).filter(Boolean))
  const failedResults = (results || []).filter(r => r?.ok === false)
  const failedIds = new Set(failedResults.map(r => r?.license_id).filter(Boolean))
  const unlocked = chipList.filter(p => !refusedIds.has(p.id) && !failedIds.has(p.id))
  const codeSegments = link ? link.user_code.split('-') : []

  // The cascade: stagger each unlocked chip ~450ms apart, then a level-up
  // burst once they've all seated. Runs once per approval (dependency is
  // deliberately just `phase`; `unlocked` is read from this render's
  // closure at the moment the transition fires, mirroring how
  // QxLabStoreView's runCascade() reads its own args once per invocation).
  useEffect(() => {
    if (phase !== 'approved') return undefined
    setLit(new Set())
    unlocked.forEach((p, i) => {
      later(() => setLit(prev => { const n = new Set(prev); n.add(p.id); return n }), i * 450)
    })
    const burstAt = unlocked.length > 0 ? (unlocked.length - 1) * 450 + 350 : 0
    later(() => {
      setLevelBurst(true)
      later(() => setLevelBurst(false), 2400)
    }, burstAt)
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  return (
    <div className="qx-modal-overlay" onClick={onClose}>
      <div
        className={`qx-modal ${levelBurst ? 'qx-levelup' : ''}`}
        style={{ maxWidth: 460 }}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Claim free plugins"
      >
        <div className="qx-modal__header">
          <h3>Claim free plugins</h3>
          <button className="pc__quick-btn" onClick={onClose} aria-label="Close" title="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="qx-modal__body">
          <div data-testid="free-claim-status" data-phase={phase}>
            {phase === 'idle' && (
              <>
                <p className="qx-hint">
                  Connect your Quox account to unlock {chipList.length} free plugin{chipList.length === 1 ? '' : 's'}.
                </p>
                <div className="qx-minichip-row" style={{ marginTop: 10 }}>
                  {chipList.map(p => (
                    <div key={p.id} className="qx-minichip" style={{ '--chip-c': p.accent }} title={p.name}>
                      <span className="qx-chip-bloom" />
                      <span className="qx-minichip__die">
                        <ChipGlyph d={p.glyph} color="rgba(255,255,255,0.45)" />
                      </span>
                      <span className="qx-minichip__silk">{p.name}</span>
                    </div>
                  ))}
                </div>
                <p className="qx-hint qx-hint--sm" style={{ marginTop: 10 }}>
                  No key to paste. No instance admin needed. Any org owner or admin can approve.
                </p>
              </>
            )}

            {phase === 'starting' && (
              <p className="qx-hint" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                <span className="qx-spinner qx-spinner--sm" /> Asking quox.ai for a code...
              </p>
            )}

            {phase === 'waiting' && link && (
              <div>
                <p className="qx-hint" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                  <LinkIcon /> Connect your Quox account. Open{' '}
                  <a
                    data-testid="free-claim-link"
                    href={link.verification_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: '#38bdf8' }}
                  >
                    {link.verification_url}
                  </a>{' '}
                  while signed in, and enter this code:
                </p>

                <div data-testid="free-claim-code" className="qx-row qx-row--tight qx-row--center">
                  {codeSegments.map((seg, i) => (
                    <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      {i > 0 && <span aria-hidden="true" style={{ color: 'rgba(255,255,255,0.4)' }}>-</span>}
                      <span className="qx-kbd qx-kbd--lg qx-kbd--glow">{seg}</span>
                    </span>
                  ))}
                </div>

                <p className="qx-hint qx-hint--sm" style={{ marginTop: 12 }}>
                  Expires in {formatRemaining(remaining)}. Keep this open until it is approved.
                </p>

                {blip && (
                  <p className="qx-hint qx-hint--warn" style={{ marginTop: 8 }}>{blip}</p>
                )}

                {refused.length > 0 && (
                  <ul
                    data-testid="free-claim-refused"
                    className="qx-hint qx-hint--sm"
                    style={{ margin: '10px 0 0', paddingLeft: 18 }}
                  >
                    {refused.map((r, i) => (
                      <li key={r.plugin_id || i}>{r.plugin_id} is not part of the free tier, so it was not included in this claim.</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {phase === 'approved' && (
              <div>
                {unlocked.length > 0 ? (
                  <>
                    <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                      <span style={{ color: '#34d399', display: 'inline-flex' }}><CheckIcon /></span>
                      <strong style={{ fontSize: 15 }}>
                        Unlocked {unlocked.length} free plugin{unlocked.length === 1 ? '' : 's'}
                      </strong>
                    </div>
                    <div className="qx-minichip-row" style={{ marginTop: 12 }}>
                      {unlocked.map(p => (
                        <div
                          key={p.id}
                          className={`qx-minichip ${lit.has(p.id) ? 'qx-minichip--on qx-enabled-glow' : ''}`}
                          style={{ '--chip-c': p.accent }}
                          title={`${p.name} unlocked`}
                        >
                          <span className="qx-chip-bloom" />
                          <span className="qx-minichip__die">
                            <ChipGlyph d={p.glyph} color={lit.has(p.id) ? p.accent : 'rgba(255,255,255,0.45)'} />
                          </span>
                          <span className="qx-minichip__silk">{p.name}</span>
                        </div>
                      ))}
                    </div>
                    <p className="qx-hint" style={{ marginTop: 12 }}>
                      Your workspace just grew. These are live on every server you run.
                    </p>
                  </>
                ) : (
                  <p className="qx-hint">Entitlements refreshed.</p>
                )}
                {failedResults.length > 0 && (
                  <ul
                    data-testid="free-claim-failed"
                    className="qx-hint qx-hint--danger"
                    style={{ marginTop: 10, paddingLeft: 18 }}
                  >
                    {failedResults.map((r, i) => (
                      <li key={r.license_id || i}>
                        {r.license_id || 'A plugin'} could not be claimed: {r.error || 'unknown error'}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {phase === 'terminal' && terminal && (
              <div>
                <span className="qx-pill qx-pill--critical">{terminal.title}</span>
                <p className="qx-hint" style={{ marginTop: 8 }}>{terminal.detail}</p>
              </div>
            )}
          </div>
        </div>

        <div className="qx-modal__actions">
          {phase === 'idle' && (
            <>
              <button className="qx-btn qx-btn--ghost" onClick={onClose}>
                <CloseIcon /> Cancel
              </button>
              <button className="qx-btn qx-btn--primary" data-testid="free-claim-start" onClick={start}>
                <GiftIcon /> Claim free
              </button>
            </>
          )}
          {phase === 'waiting' && (
            <button className="qx-btn qx-btn--ghost" onClick={onClose}>
              <CloseIcon /> Cancel
            </button>
          )}
          {phase === 'approved' && (
            <button className="qx-btn qx-btn--primary" onClick={onClose}>
              <CheckIcon /> Done
            </button>
          )}
          {phase === 'terminal' && (
            <>
              <button className="qx-btn qx-btn--ghost" onClick={onClose}>
                <CloseIcon /> Cancel
              </button>
              <button className="qx-btn qx-btn--primary" data-testid="free-claim-start" onClick={start}>
                <RefreshIcon /> Try again
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
