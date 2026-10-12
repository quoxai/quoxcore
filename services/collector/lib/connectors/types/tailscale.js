/**
 * Tailscale Connector — Stream TN (TailOps)
 *
 * 12 tools for the Tailscale API v2: 7 read + 5 write.
 * Requires: api_key (tskey-api-...) + tailnet (e.g. example.com or -)
 *
 * Tool names are auto-prefixed with 'tailscale_' by the connector bridge.
 * E.g., 'list_devices' becomes 'tailscale_list_devices' at the agent layer.
 */

const TAILSCALE_API = 'https://api.tailscale.com/api/v2'
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000  // 5 minutes
const KEY_EXPIRY_WARNING_DAYS = 7
const REQUEST_TIMEOUT_MS = 15_000

async function tailscaleFetch(path, credentials, options = {}) {
  const { api_key, tailnet } = credentials
  const resolvedPath = path.replace('{tailnet}', encodeURIComponent(tailnet))
  const url = `${TAILSCALE_API}${resolvedPath}`

  const auth = Buffer.from(`${api_key}:`).toString('base64')

  let resp
  try {
    resp = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new Error('Tailscale API request timed out after 15 seconds. Check your network connectivity.')
    }
    throw err
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    if (resp.status === 401) {
      throw new Error(`Tailscale API 401 Unauthorized: Invalid or expired API key. Ensure your token starts with tskey-api- and hasn't expired.`)
    }
    if (resp.status === 429) {
      throw new Error('Tailscale API 429: Rate limit exceeded. Please wait before retrying.')
    }
    if (resp.status === 403) {
      throw new Error('Tailscale API 403: Forbidden. Check that your API key has the required scopes.')
    }
    if (resp.status === 404) {
      throw new Error('Tailscale API 404: Resource not found. Check your tailnet name and device IDs.')
    }
    throw new Error(`Tailscale API error (${resp.status}). Check your credentials and try again.`)
  }

  if (resp.status === 204) return {}

  return resp.json()
}

// ── Helpers ──

function shapeDevice(d) {
  const now = Date.now()
  const lastSeenMs = d.lastSeen ? Date.parse(d.lastSeen) : 0
  const expiresMs = d.expires ? Date.parse(d.expires) : null
  const enabledRoutes = d.enabledRoutes || []
  const isOnline = d.lastSeen ? (now - lastSeenMs) < ONLINE_THRESHOLD_MS : false

  return {
    id: d.id,
    hostname: d.hostname,
    fqdn: d.name,
    os: d.os,
    ips: d.addresses || [],
    tags: d.tags || [],
    authorized: d.authorized,
    lastSeen: d.lastSeen,
    online: isOnline,
    created: d.created,
    expires: d.expires,
    keyExpiryDisabled: d.keyExpiryDisabled,
    daysUntilExpiry: expiresMs && !d.keyExpiryDisabled
      ? Math.max(0, Math.round((expiresMs - now) / 86_400_000))
      : null,
    enabledRoutes,
    advertisedRoutes: d.advertisedRoutes || [],
    isSubnetRouter: enabledRoutes.length > 0 && !enabledRoutes.some(r => r === '0.0.0.0/0' || r === '::/0'),
    isExitNode: enabledRoutes.some(r => r === '0.0.0.0/0' || r === '::/0'),
    clientVersion: d.clientVersion,
    updateAvailable: d.updateAvailable,
    blocksIncomingConnections: d.blocksIncomingConnections,
    derp: d.clientConnectivity?.derp || null,
    latency: d.clientConnectivity?.latency || null,
    // Intentionally omitted: machineKey, nodeKey, deviceKey, endpoints (WAN IPs)
  }
}

function computeSummary(devices) {
  let online = 0, offline = 0, subnetRouters = 0, exitNodes = 0, expiringKeys = 0
  for (const d of devices) {
    if (d.online) online++; else offline++
    if (d.isSubnetRouter) subnetRouters++
    if (d.isExitNode) exitNodes++
    if (d.daysUntilExpiry !== null && d.daysUntilExpiry <= KEY_EXPIRY_WARNING_DAYS) expiringKeys++
  }
  return { total: devices.length, online, offline, subnetRouters, exitNodes, expiringKeys }
}

function generateAclSummary(acl) {
  const parts = []
  const groups = acl.groups || {}
  const groupCount = Object.keys(groups).length
  const ruleCount = (acl.acls || []).length
  const tagCount = Object.keys(acl.tagowners || {}).length

  if (groupCount > 0) {
    parts.push(`${groupCount} group(s): ${Object.keys(groups).join(', ')}`)
    for (const [name, members] of Object.entries(groups)) {
      parts.push(`  ${name}: ${members.length} member(s)`)
    }
  }
  if (ruleCount > 0) {
    parts.push(`${ruleCount} ACL rule(s):`)
    for (const rule of (acl.acls || [])) {
      const src = (rule.src || rule.users || []).join(', ')
      const dst = (rule.dst || rule.ports || []).join(', ')
      parts.push(`  ${rule.action}: ${src} → ${dst}`)
    }
  }
  if (tagCount > 0) {
    parts.push(`${tagCount} tag owner(s): ${Object.keys(acl.tagowners).join(', ')}`)
  }
  return parts.join('\n') || 'No ACL policy configured.'
}

// ── Tools ──

function getTools(credentials) {
  return [
    // ===== Read tools (7) =====

    {
      name: 'list_devices',
      description: 'List all devices on the Tailscale mesh with status, IPs, routes, and health summary',
      input_schema: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Optional filter by hostname, FQDN, IP, or tag' },
        },
      },
      execute: async (input, creds) => {
        const data = await tailscaleFetch('/tailnet/{tailnet}/devices', creds)
        let devices = (data.devices || []).map(shapeDevice)

        if (input.filter) {
          const f = input.filter.toLowerCase()
          devices = devices.filter(d =>
            d.hostname.toLowerCase().includes(f) ||
            d.fqdn.toLowerCase().includes(f) ||
            d.ips.some(ip => ip.includes(f)) ||
            d.tags.some(t => t.toLowerCase().includes(f))
          )
        }

        return { devices, summary: computeSummary(devices) }
      },
    },

    {
      name: 'device_details',
      description: 'Get full details of a specific Tailscale device including connectivity, latency, and routes',
      input_schema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'Tailscale device ID' },
        },
        required: ['device_id'],
      },
      execute: async (input, creds) => {
        const device = await tailscaleFetch(`/device/${encodeURIComponent(input.device_id)}`, creds)
        return shapeDevice(device)
      },
    },

    {
      name: 'get_routes',
      description: 'Get advertised and enabled subnet routes for a Tailscale device',
      input_schema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'Tailscale device ID' },
        },
        required: ['device_id'],
      },
      execute: async (input, creds) => {
        return await tailscaleFetch(`/device/${encodeURIComponent(input.device_id)}/routes`, creds)
      },
    },

    {
      name: 'get_acl',
      description: 'Get the Tailscale ACL policy with groups, rules, tag owners, and a human-readable summary',
      input_schema: {
        type: 'object',
        properties: {},
      },
      execute: async (input, creds) => {
        const acl = await tailscaleFetch('/tailnet/{tailnet}/acl', creds)
        return {
          acls: acl.acls || [],
          groups: acl.groups || {},
          tagowners: acl.tagowners || {},
          hosts: acl.hosts || {},
          nodeAttrs: acl.nodeAttrs || [],
          tests: acl.tests || [],
          humanReadableSummary: generateAclSummary(acl),
        }
      },
    },

    {
      name: 'get_dns',
      description: 'Get Tailscale DNS configuration: nameservers, MagicDNS, search paths, and split DNS rules',
      input_schema: {
        type: 'object',
        properties: {},
      },
      execute: async (input, creds) => {
        const results = await Promise.allSettled([
          tailscaleFetch('/tailnet/{tailnet}/dns/nameservers', creds),
          tailscaleFetch('/tailnet/{tailnet}/dns/preferences', creds),
          tailscaleFetch('/tailnet/{tailnet}/dns/searchpaths', creds),
          tailscaleFetch('/tailnet/{tailnet}/dns/split-dns', creds),
        ])
        const [ns, prefs, paths, split] = results.map(r => r.status === 'fulfilled' ? r.value : {})
        return {
          nameservers: ns.dns || [],
          magicDNS: prefs.magicDNS ?? false,
          searchPaths: paths.searchPaths || [],
          splitDNS: split || {},
        }
      },
    },

    {
      name: 'list_keys',
      description: 'List all auth keys on the tailnet with expiry status and summary',
      input_schema: {
        type: 'object',
        properties: {},
      },
      execute: async (input, creds) => {
        const data = await tailscaleFetch('/tailnet/{tailnet}/keys', creds)
        const rawKeys = data.keys || data || []
        const keysArray = Array.isArray(rawKeys) ? rawKeys : []
        const now = Date.now()

        const keys = keysArray.map(k => {
          const expiresMs = k.expires ? Date.parse(k.expires) : null
          const daysUntilExpiry = expiresMs ? Math.round((expiresMs - now) / 86_400_000) : null
          const create = k.capabilities?.devices?.create || {}
          return {
            id: k.id,
            created: k.created,
            expires: k.expires,
            daysUntilExpiry,
            reusable: create.reusable || false,
            ephemeral: create.ephemeral || false,
            preauthorized: create.preauthorized || false,
            tags: create.tags || [],
          }
        })

        let expired = 0, expiringSoon = 0
        for (const k of keys) {
          if (k.daysUntilExpiry !== null && k.daysUntilExpiry < 0) expired++
          else if (k.daysUntilExpiry !== null && k.daysUntilExpiry <= KEY_EXPIRY_WARNING_DAYS) expiringSoon++
        }

        return { keys, summary: { total: keys.length, expired, expiringSoon } }
      },
    },

    {
      name: 'audit_log',
      description: 'Get recent Tailscale configuration audit log entries',
      input_schema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'ISO date string — show events after this date (default: 7 days ago)' },
          actor: { type: 'string', description: 'Filter by actor email' },
          action: { type: 'string', description: 'Filter by action type (CREATE, UPDATE, DELETE)' },
          limit: { type: 'number', description: 'Max entries to return (default 50)' },
        },
      },
      execute: async (input, creds) => {
        const since = input.since || new Date(Date.now() - 7 * 86_400_000).toISOString()
        const params = new URLSearchParams({ start: since })
        const data = await tailscaleFetch(`/tailnet/{tailnet}/logging/configuration?${params}`, creds)
        let entries = Array.isArray(data) ? data : []

        if (input.actor) {
          entries = entries.filter(e => e.actor?.loginName?.toLowerCase().includes(input.actor.toLowerCase()))
        }
        if (input.action) {
          entries = entries.filter(e => e.action === input.action)
        }

        const limit = input.limit || 50
        return entries.slice(0, limit).map(e => ({
          eventTime: e.eventTime,
          type: e.type,
          action: e.action,
          actor: e.actor ? { loginName: e.actor.loginName, type: e.actor.type } : null,
          target: e.target ? { name: e.target.name, type: e.target.type, property: e.target.property } : null,
          old: e.old,
          new: e.new,
        }))
      },
    },

    // ===== Write tools (5) =====

    {
      name: 'authorize_device',
      description: 'Authorize or deauthorize a Tailscale device. Deauthorizing disconnects it from the tailnet.',
      input_schema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'Tailscale device ID' },
          authorized: { type: 'boolean', description: 'true to authorize, false to deauthorize' },
        },
        required: ['device_id', 'authorized'],
      },
      execute: async (input, creds) => {
        await tailscaleFetch(`/device/${encodeURIComponent(input.device_id)}/authorized`, creds, {
          method: 'POST',
          body: JSON.stringify({ authorized: input.authorized }),
        })
        return {
          success: true,
          device_id: input.device_id,
          authorized: input.authorized,
          message: input.authorized
            ? `Device ${input.device_id} has been authorized`
            : `Device ${input.device_id} has been deauthorized and disconnected from the tailnet`,
        }
      },
    },

    {
      name: 'set_device_tags',
      description: 'Set tags on a Tailscale device. Replaces all existing tags.',
      input_schema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'Tailscale device ID' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags to set (e.g. ["tag:server", "tag:prod"])' },
        },
        required: ['device_id', 'tags'],
      },
      execute: async (input, creds) => {
        await tailscaleFetch(`/device/${encodeURIComponent(input.device_id)}/tags`, creds, {
          method: 'POST',
          body: JSON.stringify({ tags: input.tags }),
        })
        return {
          success: true,
          device_id: input.device_id,
          tags: input.tags,
          message: `Tags updated on device ${input.device_id}: ${input.tags.join(', ')}`,
        }
      },
    },

    {
      name: 'manage_routes',
      description: 'Enable or disable subnet routes on a Tailscale device. Provide the list of routes to enable.',
      input_schema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'Tailscale device ID' },
          routes: { type: 'array', items: { type: 'string' }, description: 'CIDR routes to enable (e.g. ["10.0.0.0/24"])' },
        },
        required: ['device_id', 'routes'],
      },
      execute: async (input, creds) => {
        const result = await tailscaleFetch(`/device/${encodeURIComponent(input.device_id)}/routes`, creds, {
          method: 'POST',
          body: JSON.stringify({ routes: input.routes }),
        })
        return {
          success: true,
          device_id: input.device_id,
          enabledRoutes: result.enabledRoutes || input.routes,
          advertisedRoutes: result.advertisedRoutes || [],
          message: `Routes updated on device ${input.device_id}`,
        }
      },
    },

    {
      name: 'create_auth_key',
      description: 'Create a new Tailscale auth key for device enrollment. The full key is only shown once.',
      input_schema: {
        type: 'object',
        properties: {
          reusable: { type: 'boolean', description: 'Whether the key can be used multiple times (default false)' },
          ephemeral: { type: 'boolean', description: 'Whether devices using this key are ephemeral (default false)' },
          preauthorized: { type: 'boolean', description: 'Whether devices are pre-authorized (default true)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags to apply to devices using this key' },
          expiry_seconds: { type: 'number', description: 'Key expiry in seconds (default 86400 = 24h, max 7776000 = 90 days)' },
        },
      },
      execute: async (input, creds) => {
        const payload = {
          capabilities: {
            devices: {
              create: {
                reusable: input.reusable || false,
                ephemeral: input.ephemeral || false,
                preauthorized: input.preauthorized !== false, // default true
                tags: input.tags || [],
              },
            },
          },
          expirySeconds: Math.min(input.expiry_seconds || 86400, 7776000),
        }

        const result = await tailscaleFetch(`/tailnet/{tailnet}/keys`, creds, {
          method: 'POST',
          body: JSON.stringify(payload),
        })

        return {
          id: result.id,
          key: result.key,
          created: result.created,
          expires: result.expires,
          capabilities: result.capabilities,
          message: 'Auth key created. The full key is shown above — it will not be displayed again.',
        }
      },
    },

    {
      name: 'fleet_cross_reference',
      description: 'Cross-reference Tailscale devices with bastion fleet hosts. Shows which hosts are on both, Tailscale-only, or bastion-only. Requires both tailscale and bastion-fleet plugins.',
      input_schema: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Optional hostname filter' },
        },
      },
      execute: async (input, creds) => {
        // Fetch Tailscale devices
        const tsData = await tailscaleFetch('/tailnet/{tailnet}/devices', creds)
        const tsDevices = (tsData.devices || []).map(d => ({
          hostname: d.hostname,
          tailscale_ip: (d.addresses || [])[0] || null,
          online: d.lastSeen ? (Date.now() - Date.parse(d.lastSeen)) < ONLINE_THRESHOLD_MS : false,
          os: d.os,
        }))

        // Fetch fleet hosts from local bastion API
        let fleetHosts = []
        try {
          const port = process.env.COLLECTOR_PORT || 9848
          const resp = await fetch(`http://127.0.0.1:${port}/api/v1/agents`, { signal: AbortSignal.timeout(5000) })
          if (resp.ok) {
            const data = await resp.json()
            fleetHosts = (data.agents || []).map(a => ({
              hostname: a.host_id,
              bastion_ip: a.ip,
              online: a.status?.connection === 'connected',
            }))
          }
        } catch {
          // Fleet API not available — return Tailscale-only data
        }

        // Cross-reference by hostname
        const tsMap = new Map(tsDevices.map(d => [d.hostname.toLowerCase(), d]))
        const fleetMap = new Map(fleetHosts.map(h => [h.hostname.toLowerCase(), h]))

        const matched = []
        const tailscaleOnly = []
        const bastionOnly = []

        for (const [key, ts] of tsMap) {
          const fleet = fleetMap.get(key)
          if (fleet) {
            matched.push({
              hostname: ts.hostname,
              tailscale_ip: ts.tailscale_ip,
              bastion_ip: fleet.bastion_ip,
              tailscale_online: ts.online,
              bastion_online: fleet.online,
            })
          } else {
            tailscaleOnly.push({ hostname: ts.hostname, tailscale_ip: ts.tailscale_ip, online: ts.online })
          }
        }

        for (const [key, fleet] of fleetMap) {
          if (!tsMap.has(key)) {
            bastionOnly.push({ hostname: fleet.hostname, bastion_ip: fleet.bastion_ip, online: fleet.online })
          }
        }

        // Apply filter
        const f = (input.filter || '').toLowerCase()
        const filterFn = item => !f || item.hostname.toLowerCase().includes(f)

        return {
          matched: matched.filter(filterFn),
          tailscale_only: tailscaleOnly.filter(filterFn),
          bastion_only: bastionOnly.filter(filterFn),
          summary: `${matched.length} on both, ${tailscaleOnly.length} Tailscale-only, ${bastionOnly.length} bastion-only`,
        }
      },
    },

    {
      name: 'revoke_key',
      description: 'Revoke a Tailscale auth key. Devices already authenticated with this key are NOT affected.',
      input_schema: {
        type: 'object',
        properties: {
          key_id: { type: 'string', description: 'Key ID to revoke' },
        },
        required: ['key_id'],
      },
      execute: async (input, creds) => {
        await tailscaleFetch(`/tailnet/{tailnet}/keys/${encodeURIComponent(input.key_id)}`, creds, {
          method: 'DELETE',
        })
        return {
          success: true,
          key_id: input.key_id,
          message: `Auth key ${input.key_id} has been revoked. Existing devices are not affected.`,
        }
      },
    },
  ]
}

module.exports = { getTools }
