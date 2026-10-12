/**
 * Tailscale Client
 *
 * Frontend service for calling Tailscale connector tools via the collector.
 * Pattern follows linkedinClient.js — calls /connectors/tailscale/tools/:name/execute
 */

const COLLECTOR_URL = '/collector'

async function callTool(toolName, input = {}, orgId) {
  const body = { input }
  if (orgId) body.orgId = orgId

  const resp = await fetch(`${COLLECTOR_URL}/connectors/tailscale/tools/${toolName}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    if (resp.status === 401) {
      // Check if it's a session auth issue vs Tailscale API key issue
      if (text.includes('authentication_required') || text.includes('JWT')) {
        throw new Error('Session expired. Please refresh the page to re-authenticate.')
      }
      throw new Error('Tailscale API key invalid or expired. Check your credentials in the vault.')
    }
    if (resp.status === 404) {
      throw new Error('Tailscale connector not available. Ensure the plugin is activated and credentials are configured.')
    }
    throw new Error(`TailMesh error (${resp.status}): ${text.slice(0, 200)}`)
  }

  let data
  try {
    data = await resp.json()
  } catch {
    throw new Error('TailMesh received an invalid response from the server.')
  }

  if (data.success === false) {
    throw new Error(data.error || `TailMesh ${toolName} failed`)
  }

  return data.result !== undefined ? data.result : data
}

// ── Read tools ──

export async function listDevices(filter, orgId) {
  return callTool('list_devices', filter ? { filter } : {}, orgId)
}

export async function deviceDetails(deviceId, orgId) {
  return callTool('device_details', { device_id: deviceId }, orgId)
}

export async function getRoutes(deviceId, orgId) {
  return callTool('get_routes', { device_id: deviceId }, orgId)
}

export async function getAcl(orgId) {
  return callTool('get_acl', {}, orgId)
}

export async function getDns(orgId) {
  return callTool('get_dns', {}, orgId)
}

export async function listKeys(orgId) {
  return callTool('list_keys', {}, orgId)
}

export async function auditLog(options = {}, orgId) {
  return callTool('audit_log', options, orgId)
}

// ── Write tools ──

export async function authorizeDevice(deviceId, authorized, orgId) {
  return callTool('authorize_device', { device_id: deviceId, authorized }, orgId)
}

export async function setDeviceTags(deviceId, tags, orgId) {
  return callTool('set_device_tags', { device_id: deviceId, tags }, orgId)
}

export async function manageRoutes(deviceId, routes, orgId) {
  return callTool('manage_routes', { device_id: deviceId, routes }, orgId)
}

export async function createAuthKey(options = {}, orgId) {
  return callTool('create_auth_key', options, orgId)
}

export async function revokeKey(keyId, orgId) {
  return callTool('revoke_key', { key_id: keyId }, orgId)
}
