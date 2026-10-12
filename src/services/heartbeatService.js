/**
 * Heartbeat Service
 *
 * Sends periodic telemetry heartbeats to quox.ai when enabled.
 * Opt-in by default during setup. Can be disabled at any time in Settings.
 *
 * What we send: instance ID, version, uptime, platform, aggregate counts.
 * What we NEVER send: conversation content, hostnames, IPs, API keys, file contents, PII.
 */

import { getFirstLicenseId } from './licenseValidator'

const HEARTBEAT_URL = 'https://api.quox.ai/api/heartbeat'
const SETTINGS_KEY = 'quox-telemetry'
const INSTANCE_ID_KEY = 'quox-instance-id'
const DEFAULT_INTERVAL = 5 * 60 * 1000 // 5 minutes
const MAX_BACKOFF = 60 * 60 * 1000 // 1 hour

let timeoutHandle = null
let backoffMs = DEFAULT_INTERVAL
let startTime = Date.now()
let running = false

// ===== Settings =====

export function isTelemetryEnabled() {
  const stored = localStorage.getItem(SETTINGS_KEY)
  // TRUST-PROOF audit cycle 1: default OFF. Telemetry is genuinely opt-in —
  // it runs only after an explicit yes (setup toggle or Settings). The old
  // default-true meant an instance that skipped or predated the setup step
  // phoned home without anyone agreeing, which contradicts the trust page's
  // "nothing leaves your box uninvited" posture.
  if (stored === null) return false
  return stored === 'true'
}

export function setTelemetryEnabled(enabled) {
  localStorage.setItem(SETTINGS_KEY, String(enabled))
  if (enabled) {
    start()
  } else {
    stop()
  }
}

// ===== Instance ID =====

/**
 * Derive a stable instance ID from license + browser fingerprint.
 * Same license on the same browser/device always produces the same ID,
 * preventing phantom duplicate rows in the instances table.
 * Different browsers or devices on the same license get distinct IDs (legitimate).
 */
async function deriveInstanceId(licenseId) {
  const fingerprint = [
    licenseId,
    navigator.userAgent || '',
    `${screen.width}x${screen.height}`,
    navigator.language || ''
  ].join('|')

  const encoded = new TextEncoder().encode(fingerprint)
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  return 'qc_' + hashHex.slice(0, 16)
}

// Cached for the session so we don't re-hash on every heartbeat
let cachedInstanceId = null

function getInstanceId() {
  // Return cached value if available (set during sendHeartbeat)
  if (cachedInstanceId) return cachedInstanceId
  // Fallback to localStorage for backward compat during startup
  return localStorage.getItem(INSTANCE_ID_KEY) || null
}

// ===== Payload Builder =====

/**
 * Build the heartbeat payload. This is what gets sent.
 * Users can view this exact payload in Settings > Telemetry > "View payload".
 */
export function buildPayload() {
  const uptime = Math.floor((Date.now() - startTime) / 1000)

  // Extract generic browser family (no version — reduces fingerprinting)
  const ua = navigator.userAgent || ''
  let browserFamily = 'unknown'
  if (ua.includes('Firefox')) browserFamily = 'Firefox'
  else if (ua.includes('Edg/')) browserFamily = 'Edge'
  else if (ua.includes('Chrome')) browserFamily = 'Chrome'
  else if (ua.includes('Safari')) browserFamily = 'Safari'

  return {
    instance_id: getInstanceId(),
    version: import.meta.env.VITE_APP_VERSION || '1.0.0',
    uptime,
    platform: {
      os: navigator.platform || 'unknown',
      arch: ua.includes('x86_64') || ua.includes('Win64') ? 'x64' : 'unknown',
      browser: browserFamily
    },
    metrics: {
      // These are aggregate counts only — no content, no names, no IPs
      plugins_enabled: countEnabledPlugins(),
      memory_entries: countMemoryEntries(),
      session_duration: uptime,
      timestamp: new Date().toISOString()
    }
  }
}

function countEnabledPlugins() {
  try {
    const settings = JSON.parse(localStorage.getItem('quox-settings') || '{}')
    if (settings.plugins) {
      return Object.values(settings.plugins).filter(Boolean).length
    }
    return 0
  } catch { return 0 }
}

function countMemoryEntries() {
  try {
    const mem = JSON.parse(localStorage.getItem('quox-memories') || '[]')
    return Array.isArray(mem) ? mem.length : 0
  } catch { return 0 }
}

// ===== Heartbeat Sender =====

async function sendHeartbeat() {
  if (!isTelemetryEnabled()) {
    console.log('[Heartbeat] Telemetry disabled, skipping')
    return
  }

  const licenseId = getFirstLicenseId()
  if (!licenseId) {
    console.log('[Heartbeat] No license found, skipping (will retry)')
    return
  }

  // Derive a stable instance ID from the license (once per session)
  if (!cachedInstanceId) {
    cachedInstanceId = await deriveInstanceId(licenseId)
    localStorage.setItem(INSTANCE_ID_KEY, cachedInstanceId)
  }

  const payload = buildPayload()
  console.log('[Heartbeat] Sending to', HEARTBEAT_URL, 'with license', licenseId.slice(0, 12) + '...')

  try {
    const res = await fetch(HEARTBEAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${licenseId}`
      },
      body: JSON.stringify(payload)
    })

    if (res.status === 401) {
      console.warn('[Heartbeat] License rejected (401), stopping telemetry')
      stop()
      return
    }

    if (res.status === 429) {
      // Rate-limited by the telemetry server. Back off aggressively — the
      // session guard means we won't re-init on every page load, but if we do
      // get throttled we should wait much longer before retrying.
      backoffMs = Math.min(backoffMs * 4, MAX_BACKOFF)
      console.warn('[Heartbeat] Rate-limited (429), backing off to', backoffMs / 1000, 's')
      return
    }

    if (res.ok) {
      const data = await res.json()
      console.log('[Heartbeat] Success:', data.license_status, `(next in ${backoffMs/1000}s)`)
      backoffMs = DEFAULT_INTERVAL

      // Process server messages (version updates, license warnings)
      if (data.messages?.length) {
        data.messages.forEach(msg => {
          if (msg.type === 'warning') {
            console.warn('[Heartbeat]', msg.text)
          } else {
            console.info('[Heartbeat]', msg.text)
          }
        })
      }

      return data
    }

    // Server error — increase backoff
    console.warn('[Heartbeat] Server error:', res.status, `(backoff ${backoffMs/1000}s → ${Math.min(backoffMs*2, MAX_BACKOFF)/1000}s)`)
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF)
  } catch (err) {
    // Network error — increase backoff
    console.warn('[Heartbeat] Network error:', err.message, `(backoff → ${Math.min(backoffMs*2, MAX_BACKOFF)/1000}s)`)
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF)
  }
}

// ===== Lifecycle =====

// sessionStorage key that marks this browser session as already having an
// active heartbeat scheduler. Survives SPA soft-navigations (component
// remounts) but is cleared when the tab is closed, preventing the 10-second
// first-beat from firing on every navigation when the discovery walker does
// full-page-load style route walking.
const SESSION_GUARD_KEY = 'quox-heartbeat-session'

/**
 * Schedule the next heartbeat using setTimeout (not setInterval).
 * This ensures backoff changes actually take effect.
 */
function scheduleNext() {
  if (!running) return
  timeoutHandle = setTimeout(() => {
    sendHeartbeat()
      .catch(() => {}) // Never let unhandled rejections escape
      .finally(() => {
        if (running) scheduleNext()
      })
  }, backoffMs)
}

export function start() {
  if (!isTelemetryEnabled()) {
    console.log('[Heartbeat] Telemetry disabled, not starting')
    return
  }
  if (running) {
    console.log('[Heartbeat] Already running, skipping start')
    return
  }

  // Guard against re-firing within the same browser session. If the module
  // is re-evaluated (e.g. full-page reload during a route walk), the
  // sessionStorage flag prevents a second scheduler from being created and
  // hammering the external API with per-navigation requests.
  try {
    if (sessionStorage.getItem(SESSION_GUARD_KEY)) {
      console.log('[Heartbeat] Session already initialised, skipping start')
      return
    }
    sessionStorage.setItem(SESSION_GUARD_KEY, '1')
  } catch {
    // sessionStorage unavailable (e.g. SSR, private-mode quirk) — continue anyway
  }

  running = true
  startTime = Date.now()
  backoffMs = DEFAULT_INTERVAL
  console.log('[Heartbeat] Starting — first beat in 10s')

  // Send first heartbeat after a short delay (don't block startup)
  timeoutHandle = setTimeout(() => {
    sendHeartbeat()
      .catch(() => {})
      .finally(() => {
        if (running) scheduleNext()
      })
  }, 10000)
}

export function stop() {
  running = false
  if (timeoutHandle) {
    clearTimeout(timeoutHandle)
    timeoutHandle = null
  }
  try {
    sessionStorage.removeItem(SESSION_GUARD_KEY)
  } catch {
    // sessionStorage unavailable — ignore
  }
}

/**
 * Initialize heartbeat on app startup.
 * Only starts if telemetry is enabled.
 */
export function initHeartbeat() {
  if (isTelemetryEnabled()) {
    start()
  }
}
