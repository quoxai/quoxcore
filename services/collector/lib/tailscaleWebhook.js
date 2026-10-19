/**
 * Tailscale Webhook Receiver + Device Status Poller
 *
 * Handles Tailscale webhook events and routes them to the HITL inbox.
 * Also polls device status for online/offline transitions (no webhook for this).
 *
 * Patterns follow slackWebhook.js / telegramWebhook.js.
 */

const crypto = require('crypto')

const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes
const TAILSCALE_API = 'https://api.tailscale.com/api/v2'

// ── Device state tracking (per org) ──

const deviceStateMap = new Map() // orgId -> Map<deviceId, { online: boolean, hostname: string }>

// ── Signature Verification ──

/**
 * Verify Tailscale webhook HMAC-SHA256 signature.
 * Signature format: v1,<timestamp>.<hmac_hex>
 */
const WEBHOOK_MAX_AGE_SECONDS = 300 // 5 minutes — reject replayed webhooks older than this

function verifyWebhookSignature(body, signature, secret) {
  if (!signature || !secret || !body) return false

  try {
    // Parse: v1,<timestamp>.<hmac>
    const withoutPrefix = signature.startsWith('v1,') ? signature.slice(3) : signature
    const dotIndex = withoutPrefix.indexOf('.')
    if (dotIndex === -1) return false

    const timestamp = withoutPrefix.slice(0, dotIndex)
    const receivedHmac = withoutPrefix.slice(dotIndex + 1)

    // Replay protection: reject if timestamp is too old
    const tsSeconds = parseInt(timestamp, 10)
    if (isNaN(tsSeconds)) return false
    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsSeconds)
    if (ageSeconds > WEBHOOK_MAX_AGE_SECONDS) return false

    // Compute expected HMAC
    const sigPayload = `${timestamp}.${body}`
    const expectedHmac = crypto.createHmac('sha256', secret).update(sigPayload).digest('hex')

    // Timing-safe comparison
    if (receivedHmac.length !== expectedHmac.length) return false
    return crypto.timingSafeEqual(Buffer.from(receivedHmac), Buffer.from(expectedHmac))
  } catch {
    return false
  }
}

// ── Inbox Item Creation ──

/**
 * Create a HITL inbox item via the auth service.
 * Fire-and-forget — failures are logged but never block.
 */
async function createTailscaleInboxItem(orgId, { title, body_md, kind, priority, requires_action, payload: extraPayload }) {
  if (!orgId) return

  try {
    await fetch(`${AUTH_BASE_URL}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {})
      },
      body: JSON.stringify({
        kind: kind || 'info',
        priority: priority || 'normal',
        title,
        body_md,
        requires_action: requires_action || false,
        payload: { source: 'tailscale', ...extraPayload },
      }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    console.error('[Tailscale] Failed to create inbox item:', err.message)
  }
}

// ── Input sanitisation (prevent XSS in inbox items) ──

function sanitise(str) {
  if (!str || typeof str !== 'string') return ''
  return str.replace(/[<>&"'`]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]))
    .slice(0, 200) // Truncate to prevent oversized payloads
}

function sanitiseUrl(url) {
  if (!url || typeof url !== 'string') return null
  // Only allow https URLs — reject javascript:, data:, etc.
  if (!url.startsWith('https://')) return null
  return sanitise(url)
}

// ── Event Handlers ──

const EVENT_HANDLERS = {
  nodeCreated: (event, orgId) => { const name = sanitise(event.data?.deviceName) || 'unknown'; return createTailscaleInboxItem(orgId, {
    title: `New Tailscale device: ${name}`,
    body_md: `**${name}** has joined the tailnet.${event.data?.managedBy ? `\nManaged by: ${sanitise(event.data.managedBy)}` : ''}`,
    kind: 'info',
    priority: 'low',
    payload: { event_type: 'nodeCreated', node_id: event.data?.nodeID, device_name: name },
  })},

  nodeDeleted: (event, orgId) => { const name = sanitise(event.data?.deviceName) || 'unknown'; return createTailscaleInboxItem(orgId, {
    title: `Tailscale device removed: ${name}`,
    body_md: `**${name}** has been removed from the tailnet.${event.data?.actor ? `\nRemoved by: ${sanitise(event.data.actor)}` : ''}`,
    kind: 'incident',
    priority: 'high',
    payload: { event_type: 'nodeDeleted', node_id: event.data?.nodeID, device_name: name },
  })},

  nodeNeedsApproval: (event, orgId) => { const name = sanitise(event.data?.deviceName) || 'unknown'; const url = sanitiseUrl(event.data?.url); return createTailscaleInboxItem(orgId, {
    title: `Tailscale device needs approval: ${name}`,
    body_md: `**${name}** is waiting for authorization.${event.data?.managedBy ? `\nManaged by: ${sanitise(event.data.managedBy)}` : ''}${url ? `\n\n[View in Tailscale Admin](${url})` : ''}`,
    kind: 'approval',
    priority: 'medium',
    requires_action: true,
    payload: { event_type: 'nodeNeedsApproval', node_id: event.data?.nodeID, device_name: name, what: { action: 'authorize Tailscale device', target: `device ${name}${event.data?.nodeID ? ` (${event.data.nodeID})` : ''}`, summary: `let device ${name} join the tailnet (approve it in the Tailscale admin console)` } },
  })},

  nodeApproved: (event, orgId) => { const name = sanitise(event.data?.deviceName) || 'unknown'; return createTailscaleInboxItem(orgId, {
    title: `Tailscale device approved: ${name}`,
    body_md: `**${name}** has been authorized.`,
    kind: 'info',
    priority: 'low',
    payload: { event_type: 'nodeApproved', node_id: event.data?.nodeID },
  })},

  nodeKeyExpiringInOneDay: (event, orgId) => { const name = sanitise(event.data?.deviceName) || 'a device'; return createTailscaleInboxItem(orgId, {
    title: `Tailscale key expiring: ${name}`,
    body_md: `The auth key for **${name}** expires within 24 hours. The device will need to re-authenticate once the key expires.`,
    kind: 'info',
    priority: 'medium',
    payload: { event_type: 'nodeKeyExpiringInOneDay', node_id: event.data?.nodeID, device_name: name },
  })},

  nodeKeyExpired: (event, orgId) => { const name = sanitise(event.data?.deviceName) || 'a device'; return createTailscaleInboxItem(orgId, {
    title: `Tailscale key expired: ${name}`,
    body_md: `The auth key for **${name}** has expired. The device needs to re-authenticate to rejoin the tailnet.`,
    kind: 'incident',
    priority: 'high',
    payload: { event_type: 'nodeKeyExpired', node_id: event.data?.nodeID, device_name: name },
  })},

  policyUpdate: (event, orgId) => createTailscaleInboxItem(orgId, {
    title: 'Tailscale ACL policy updated',
    body_md: `The Tailscale ACL policy has been updated.${event.data?.actor ? ` Changed by: ${sanitise(event.data.actor)}` : ''}`,
    kind: 'info',
    priority: 'low',
    payload: { event_type: 'policyUpdate' },
  }),

  subnetIPForwardingNotEnabled: (event, orgId) => { const name = sanitise(event.data?.deviceName) || 'A subnet router'; return createTailscaleInboxItem(orgId, {
    title: `Subnet router misconfigured: ${name}`,
    body_md: `**${name}** is advertising routes but IP forwarding is not enabled on the host. Subnet traffic will not be routed until IP forwarding is configured.\n\nFix: \`echo 'net.ipv4.ip_forward = 1' | sudo tee -a /etc/sysctl.conf && sudo sysctl -p\``,
    kind: 'incident',
    priority: 'high',
    payload: { event_type: 'subnetIPForwardingNotEnabled', device_name: name },
  })},

  exitNodeIPForwardingNotEnabled: (event, orgId) => { const name = sanitise(event.data?.deviceName) || 'An exit node'; return createTailscaleInboxItem(orgId, {
    title: `Exit node misconfigured: ${name}`,
    body_md: `**${name}** is configured as an exit node but IP forwarding is not enabled.`,
    kind: 'incident',
    priority: 'high',
    payload: { event_type: 'exitNodeIPForwardingNotEnabled', device_name: name },
  })},

  userNeedsApproval: (event, orgId) => createTailscaleInboxItem(orgId, {
    title: `Tailscale user needs approval: ${sanitise(event.data?.managedBy) || 'unknown'}`,
    body_md: `A new user is waiting for approval to join the tailnet.`,
    kind: 'approval',
    priority: 'medium',
    requires_action: true,
    payload: { event_type: 'userNeedsApproval', what: { action: 'approve Tailscale user', target: `user ${sanitise(event.data?.managedBy) || 'unknown'}`, summary: `let user ${sanitise(event.data?.managedBy) || 'unknown'} join the tailnet (approve them in the Tailscale admin console)` } },
  }),
}

/**
 * Process an array of Tailscale webhook events.
 */
async function handleWebhookEvents(events, orgId) {
  for (const event of events) {
    const handler = EVENT_HANDLERS[event.type]
    if (handler) {
      try {
        await handler(event, orgId)
      } catch (err) {
        console.error(`[Tailscale] Event handler failed for ${event.type}:`, err.message)
      }
    } else {
      console.log(`[Tailscale] Unhandled event type: ${event.type}`)
    }
  }
}

// ── Device Status Poller ──

/**
 * Poll Tailscale API for device status changes.
 * Compares current state with previous state and returns alerts for transitions.
 *
 * Returns: Array of { type: 'device_offline'|'device_online'|'device_removed', hostname, deviceId }
 */
async function pollDeviceStatus(orgId, credentials) {
  const { api_key, tailnet } = credentials
  const auth = Buffer.from(`${api_key}:`).toString('base64')
  const url = `${TAILSCALE_API}/tailnet/${encodeURIComponent(tailnet)}/devices`

  const resp = await fetch(url, {
    headers: { 'Authorization': `Basic ${auth}` },
    signal: AbortSignal.timeout(15000),
  })

  if (!resp.ok) {
    throw new Error(`Tailscale API ${resp.status}`)
  }

  const data = await resp.json()
  const devices = data.devices || []
  const now = Date.now()

  // Build current state
  const currentState = new Map()
  for (const d of devices) {
    const online = (now - Date.parse(d.lastSeen)) < ONLINE_THRESHOLD_MS
    currentState.set(d.id, { online, hostname: d.hostname })
  }

  // Compare with previous state
  const previousState = deviceStateMap.get(orgId)
  const alerts = []

  if (previousState) {
    // Check for state transitions
    for (const [id, current] of currentState) {
      const prev = previousState.get(id)
      if (prev) {
        if (prev.online && !current.online) {
          alerts.push({ type: 'device_offline', hostname: current.hostname, deviceId: id })
        } else if (!prev.online && current.online) {
          alerts.push({ type: 'device_online', hostname: current.hostname, deviceId: id })
        }
      }
      // New device (no previous state) = no alert (it's just new)
    }

    // Check for removed devices
    for (const [id, prev] of previousState) {
      if (!currentState.has(id)) {
        alerts.push({ type: 'device_removed', hostname: prev.hostname, deviceId: id })
      }
    }
  }

  // Update state
  deviceStateMap.set(orgId, currentState)

  return alerts
}

// ── Test helpers (exported for test access) ──

function _getDeviceStateMap() { return deviceStateMap }
function _clearDeviceStateMap() { deviceStateMap.clear() }

module.exports = {
  verifyWebhookSignature,
  handleWebhookEvents,
  pollDeviceStatus,
  createTailscaleInboxItem,
  _getDeviceStateMap,
  _clearDeviceStateMap,
}
