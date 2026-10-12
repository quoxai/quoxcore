/**
 * QuoxBastion Client
 *
 * Service client for interacting with QuoxBastion API.
 * Used by QuoxCORE dashboard and agents (CIPHER, DAEDALUS).
 */

import {
  logHostAdded, logHostUpdated, logHostRemoved,
  logCommandExecuted, logRegistryImported,
  logKeyGenerated, logKeyDeployed, logKeyRevoked,
  logSudoSetup, logToolRun,
} from './infraAudit'

// SECURITY FIX C3: this client used to fetch a raw BASTION_API_TOKEN from
// the collector, cache it in localStorage, and send it as a Bearer header
// directly to the bastion host — giving every authenticated dashboard
// session a fleet-admin bastion credential. The token now never leaves the
// server. All calls go through the collector's bastion proxy
// (`/collector/api/v1/bastion/proxy/*`), which injects the token
// server-side and authorizes the call by the caller's dashboard role.
// Auth to the collector itself is via session cookie (`credentials: 'include'`).

// Default configuration — hits the collector's bastion proxy, not the
// bastion host directly.
const DEFAULT_CONFIG = {
  baseUrl: '/collector/api/v1/bastion/proxy',
  authServiceUrl: '/api/auth',
  timeout: 30000
}

let config = { ...DEFAULT_CONFIG }

/**
 * Configure the client (e.g. override baseUrl). Token configuration is
 * intentionally no longer supported — the browser never holds a bastion
 * token; the collector proxy injects it server-side.
 * @param {Object} options - Configuration options (e.g. { baseUrl })
 */
export function configure(options) {
  const { token, ...rest } = options || {}
  config = { ...config, ...rest }
}

/**
 * @deprecated No-op. The bastion token is never held by the frontend —
 * the collector proxy injects it server-side. Kept as a no-op so older
 * call sites don't throw while they're cleaned up.
 */
export function configureBastionToken() {
  return false
}

/**
 * Make an API request
 * @param {string} path - API path
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} - Response data
 */
async function request(path, options = {}) {
  // baseUrl already points at the collector's bastion proxy, which forwards
  // to `${BASTION_URL}/api/v1${subpath}` — so the subpath here must be the
  // bare bastion path (e.g. '/hosts'), NOT prefixed with '/api/v1' again.
  const url = `${config.baseUrl}${path}`

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), config.timeout)

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include',
      signal: controller.signal
    })

    clearTimeout(timeoutId)

    // Get response text first to handle empty responses
    const text = await response.text()

    if (!response.ok) {
      // Rate-limited — service is up but throttling, don't throw
      if (response.status === 429) {
        return { _rate_limited: true }
      }
      // Try to parse error JSON, fallback to status text
      let errorMessage = `HTTP ${response.status}`
      if (text) {
        try {
          const error = JSON.parse(text)
          errorMessage = error.error || error.message || errorMessage
        } catch {
          // Strip HTML tags (e.g. nginx error pages) for clean display
          const cleaned = text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
          errorMessage = cleaned ? cleaned.slice(0, 100) : errorMessage
        }
      }
      throw new Error(errorMessage)
    }

    // Handle empty success responses
    if (!text) {
      return {}
    }

    // Parse JSON response
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`Invalid JSON response: ${text.slice(0, 100)}`)
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out')
    }
    // Improve connection error messages
    if (err.message === 'Failed to fetch' || err.code === 'ECONNREFUSED') {
      throw new Error('QuoxBastion server is not reachable. Make sure it is running on your bastion host.')
    }
    throw err
  }
}

// ============ Host Operations ============

/**
 * List all hosts
 * @returns {Promise<Array>} - List of hosts
 */
export async function listHosts() {
  const data = await request('/hosts')
  return data.hosts || []
}

/**
 * Get a specific host
 * @param {string} id - Host ID or alias
 * @returns {Promise<Object>} - Host details
 */
export async function getHost(id) {
  return await request(`/hosts/${encodeURIComponent(id)}`)
}

/**
 * Add a new host
 * @param {Object} host - Host data
 * @returns {Promise<Object>} - Created host
 */
export async function addHost(host) {
  const result = await request('/hosts', {
    method: 'POST',
    body: JSON.stringify(host)
  })
  logHostAdded(host)
  return result
}

/**
 * Update a host
 * @param {string} id - Host ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - Updated host
 */
export async function updateHost(id, updates) {
  const result = await request(`/hosts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(updates)
  })
  logHostUpdated(id, updates)
  return result
}

/**
 * Remove a host
 * @param {string} id - Host ID
 * @returns {Promise<void>}
 */
export async function removeHost(id) {
  await request(`/hosts/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  })
  logHostRemoved(id)
}

// ============ Group Operations ============

/**
 * List all groups
 * @returns {Promise<Array>} - List of group names
 */
export async function listGroups() {
  const data = await request('/groups')
  return data.groups || []
}

/**
 * List hosts in a group
 * @param {string} group - Group name
 * @returns {Promise<Array>} - List of hosts
 */
export async function listGroupHosts(group) {
  const data = await request(`/groups/${encodeURIComponent(group)}/hosts`)
  return data.hosts || []
}

// ============ Execution ============

/**
 * Execute a command on one or more hosts
 * @param {Object} options - Execution options
 * @param {string[]} options.targets - Target host IDs
 * @param {string} options.group - Target group (alternative to targets)
 * @param {string} options.command - Command to execute
 * @param {number} options.timeout - Execution timeout in seconds
 * @param {string} [options.approvalToken] - Optional approval token for pre-approved commands
 * @returns {Promise<Array>} - Execution results
 */
export async function execCommand({ targets, group, command, timeout = 60, approvalToken = null }) {
  const requestBody = {
    targets,
    group,
    command,
    timeout,
    parallel: true
  }

  // Include approval token in request body if provided
  if (approvalToken) {
    requestBody.approval_token = approvalToken
  }

  const headers = {}
  // Also include token in header for bastion verification
  if (approvalToken) {
    headers['X-Bastion-Approval-Token'] = approvalToken
  }

  const data = await request('/exec', {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  })
  logCommandExecuted(targets || group, command)
  return data.results || []
}

/**
 * Execute a command on a single host
 * @param {string} hostId - Host ID
 * @param {string} command - Command to execute
 * @param {string} [token] - Optional approval token for pre-approved commands
 * @returns {Promise<Object>} - Execution result
 */
export async function execOnHost(hostId, command, token = null) {
  if (token) {
    // Verify token with auth service before execution
    const isValid = await verifyApprovalToken(token)
    if (!isValid) {
      throw new Error('Invalid or expired approval token')
    }
  }

  const options = token ? { approvalToken: token } : {}
  const results = await execCommand({ targets: [hostId], command, ...options })
  return results[0]
}

/**
 * Execute a command on all hosts in a group
 * @param {string} group - Group name
 * @param {string} command - Command to execute
 * @returns {Promise<Array>} - Execution results
 */
export async function execOnGroup(group, command) {
  return await execCommand({ group, command })
}

// ============ Approval Token Operations ============

/**
 * Execute a command with an approval token
 * @param {string} hostId - Host ID
 * @param {string} command - Command to execute
 * @param {string} token - Approval token for verification
 * @returns {Promise<Object>} - Execution result
 */
export async function execWithApprovalToken(hostId, command, token) {
  if (!token) {
    throw new Error('Approval token is required')
  }

  const requestBody = {
    targets: [hostId],
    command,
    timeout: 60,
    parallel: true,
    approval_token: token
  }

  const data = await request('/exec', {
    method: 'POST',
    headers: {
      'X-Bastion-Approval-Token': token
    },
    body: JSON.stringify(requestBody)
  })

  return data.results?.[0] || null
}

/**
 * Verify an approval token with the auth service
 * @param {string} token - Approval token to verify
 * @returns {Promise<boolean>} - True if token is valid
 */
async function verifyApprovalToken(token) {
  try {
    const url = `${config.authServiceUrl}/approvals/verify`

    const headers = {
      'Content-Type': 'application/json'
    }

    if (config.token) {
      headers['Authorization'] = `Bearer ${config.token}`
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token })
    })

    if (!response.ok) {
      return false
    }

    const data = await response.json()
    return data.valid === true
  } catch {
    return false
  }
}

/**
 * Check the status of a command approval request
 * @param {string} approvalId - Approval request ID
 * @returns {Promise<Object>} - Approval status object
 * @returns {string} return.status - 'pending', 'approved', 'rejected', 'expired'
 * @returns {string} [return.token] - Approval token if approved
 * @returns {string} [return.approvedBy] - User who approved (if approved)
 * @returns {string} [return.approvedAt] - Timestamp of approval (if approved)
 * @returns {string} [return.rejectedBy] - User who rejected (if rejected)
 * @returns {string} [return.rejectedAt] - Timestamp of rejection (if rejected)
 * @returns {string} [return.reason] - Rejection reason (if rejected)
 */
export async function checkApprovalStatus(approvalId) {
  if (!approvalId) {
    throw new Error('Approval ID is required')
  }

  const url = `${config.authServiceUrl}/approvals/${encodeURIComponent(approvalId)}`

  const headers = {
    'Content-Type': 'application/json'
  }

  if (config.token) {
    headers['Authorization'] = `Bearer ${config.token}`
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), config.timeout)

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.error || `HTTP ${response.status}`)
    }

    return await response.json()
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out')
    }
    throw err
  }
}

/**
 * Request approval for a command execution
 * @param {string} orgId - Organization ID
 * @param {string} hostId - Host ID where command will be executed
 * @param {string} hostName - Human-readable host name
 * @param {string} command - Command to be executed
 * @returns {Promise<Object>} - Approval request object
 * @returns {string} return.approvalId - ID to poll for status
 * @returns {string} return.status - Initial status ('pending')
 * @returns {string} return.expiresAt - When the approval request expires
 */
export async function requestCommandApproval(orgId, hostId, hostName, command) {
  if (!orgId || !hostId || !command) {
    throw new Error('Organization ID, host ID, and command are required')
  }

  const url = `${config.authServiceUrl}/approvals`

  const headers = {
    'Content-Type': 'application/json'
  }

  if (config.token) {
    headers['Authorization'] = `Bearer ${config.token}`
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), config.timeout)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        type: 'command_execution',
        org_id: orgId,
        host_id: hostId,
        host_name: hostName || hostId,
        command,
        metadata: {
          requested_at: new Date().toISOString(),
          client: 'bastion-client'
        }
      })
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.error || `HTTP ${response.status}`)
    }

    return await response.json()
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out')
    }
    throw err
  }
}

/**
 * Poll for approval status until approved, rejected, or timeout
 * @param {string} approvalId - Approval request ID
 * @param {Object} [options] - Polling options
 * @param {number} [options.interval=2000] - Polling interval in ms
 * @param {number} [options.maxAttempts=30] - Maximum polling attempts
 * @param {function} [options.onStatus] - Callback for status updates
 * @returns {Promise<Object>} - Final approval status
 */
export async function pollApprovalStatus(approvalId, options = {}) {
  const {
    interval = 2000,
    maxAttempts = 30,
    onStatus = null
  } = options

  let attempts = 0

  while (attempts < maxAttempts) {
    const status = await checkApprovalStatus(approvalId)

    if (onStatus) {
      onStatus(status, attempts + 1, maxAttempts)
    }

    if (status.status === 'approved' || status.status === 'rejected' || status.status === 'expired') {
      return status
    }

    attempts++
    if (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, interval))
    }
  }

  throw new Error('Approval polling timed out')
}

// ============ Health & Status ============

/**
 * Check API health
 * @returns {Promise<Object>} - Health status
 */
export async function checkHealth() {
  return await request('/health?diag=true')
}

/**
 * Get fleet summary
 * @returns {Promise<Object>} - Fleet statistics
 */
export async function getFleetSummary() {
  const hosts = await listHosts()
  const groups = await listGroups()

  const healthCounts = hosts.reduce((acc, h) => {
    const health = h.status?.health || 'unknown'
    acc[health] = (acc[health] || 0) + 1
    return acc
  }, {})

  return {
    totalHosts: hosts.length,
    groups,
    groupCount: groups.length,
    health: healthCounts,
    hosts
  }
}

// ============ Import/Export ============

/**
 * Export the full registry
 * @returns {Promise<Object>} - Full registry data
 */
export async function exportRegistry() {
  return await request('/registry')
}

/**
 * Import hosts into the registry
 * @param {Object} registry - Registry data
 * @param {string} mode - 'merge' or 'replace'
 * @returns {Promise<void>}
 */
export async function importRegistry(registry, mode = 'merge') {
  await request('/registry/import', {
    method: 'POST',
    body: JSON.stringify({ registry, mode })
  })
  logRegistryImported(mode)
}

// ============ Convenience Functions ============

/**
 * Resolve a hostname or alias to a host object
 * @param {string} nameOrAlias - Host ID or alias
 * @returns {Promise<Object|null>} - Host or null if not found
 */
export async function resolveHost(nameOrAlias) {
  try {
    return await getHost(nameOrAlias)
  } catch {
    return null
  }
}

/**
 * Ping all hosts to check connectivity
 * @returns {Promise<Array>} - Ping results with latency
 */
export async function pingHosts() {
  const data = await request('/ping')
  return data.results || []
}

/**
 * Check if a host is reachable (via exec)
 * @param {string} hostId - Host ID
 * @returns {Promise<boolean>} - True if reachable
 */
export async function pingHost(hostId) {
  try {
    const result = await execOnHost(hostId, 'echo pong')
    return result.exit_code === 0 && result.stdout.trim() === 'pong'
  } catch {
    return false
  }
}

// ============================================================
// Tools Registry
// ============================================================

/**
 * List all registered tools
 * @param {string} [category] - Optional category filter
 * @returns {Promise<Array>} - Array of tool definitions
 */
export async function listTools(category) {
  const path = category ? `/tools?category=${encodeURIComponent(category)}` : '/tools'
  const data = await request(path)
  return data.tools || data || []
}

/**
 * Get a specific tool by ID
 * @param {string} id - Tool ID
 * @returns {Promise<Object>} - Tool definition
 */
export async function getTool(id) {
  return request(`/tools/${encodeURIComponent(id)}`)
}

/**
 * Run a tool on target hosts
 * @param {Object} params - Run params
 * @param {string} params.tool_id - Tool ID
 * @param {Array<string>} [params.hosts] - Target host IDs
 * @param {string} [params.group] - Target group name
 * @param {boolean} [params.all] - Target all hosts
 * @param {Object} [params.params] - Tool parameters
 * @param {boolean} [params.dry_run] - Dry run mode
 * @returns {Promise<Object>} - Tool run result
 */
export async function runTool(params) {
  const result = await request('/tools/run', {
    method: 'POST',
    body: JSON.stringify(params)
  })
  logToolRun(params)
  return result
}

// ============================================================
// SSH Key Management
// ============================================================

/**
 * List all managed SSH keys
 * @returns {Promise<Array>} - Array of key info objects
 */
export async function listKeys() {
  const data = await request('/keys')
  return data.keys || data || []
}

/**
 * Get a specific key by ID
 * @param {string} id - Key ID
 * @returns {Promise<Object>} - Key info
 */
export async function getKey(id) {
  return request(`/keys/${encodeURIComponent(id)}`)
}

/**
 * Generate a new SSH keypair
 * @param {Object} params - Generation params
 * @param {string} params.name - Key name
 * @param {string} [params.comment] - Key comment
 * @returns {Promise<Object>} - Generated key info
 */
export async function generateKey(params) {
  const result = await request('/keys/generate', {
    method: 'POST',
    body: JSON.stringify(params)
  })
  logKeyGenerated(params)
  return result
}

/**
 * Deploy a key to hosts
 * @param {Object} params - Deploy params
 * @param {string} params.key_id - Key ID
 * @param {Array<string>} [params.hosts] - Target host IDs
 * @param {string} [params.group] - Target group name
 * @returns {Promise<Object>} - Deploy result
 */
export async function deployKey(params) {
  const result = await request('/keys/deploy', {
    method: 'POST',
    body: JSON.stringify(params)
  })
  logKeyDeployed(params)
  return result
}

/**
 * Revoke (delete) a managed key
 * @param {string} id - Key ID
 * @returns {Promise<Object>} - Revoke result
 */
export async function revokeKey(id) {
  const result = await request(`/keys/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  })
  logKeyRevoked(id)
  return result
}

/**
 * Setup passwordless sudo on hosts
 * @param {Object} params - Setup params
 * @param {Array<string>} [params.hosts] - Target host IDs
 * @param {string} [params.group] - Target group name
 * @param {string} [params.user] - User for sudo setup
 * @returns {Promise<Object>} - Setup result
 */
export async function setupSudo(params) {
  const result = await request('/sudo/setup', {
    method: 'POST',
    body: JSON.stringify(params)
  })
  logSudoSetup(params)
  return result
}

// ============================================================
// Audit Log
// ============================================================

/**
 * Query the audit log
 * @param {Object} [filters] - Query filters
 * @param {string} [filters.type] - Event type filter
 * @param {string} [filters.since] - ISO date string
 * @param {string} [filters.until] - ISO date string
 * @param {string} [filters.search] - Free text search
 * @param {string} [filters.token] - Token name filter
 * @param {number} [filters.offset] - Pagination offset
 * @param {number} [filters.limit] - Max results (default 100)
 * @returns {Promise<Object>} - { events, total, offset, limit }
 */
export async function queryAuditLog(filters = {}) {
  const params = new URLSearchParams()
  if (filters.type) params.set('type', filters.type)
  if (filters.since) params.set('since', filters.since)
  if (filters.until) params.set('until', filters.until)
  if (filters.search) params.set('search', filters.search)
  if (filters.token) params.set('token', filters.token)
  if (filters.offset) params.set('offset', String(filters.offset))
  if (filters.limit) params.set('limit', String(filters.limit))

  const query = params.toString()
  return request(`/audit${query ? '?' + query : ''}`)
}

// ============================================================
// Fleet Metrics
// ============================================================

/**
 * Get fleet metrics summary
 * @returns {Promise<Object>} - { total, healthy, unhealthy, unknown, groups }
 */
export async function getFleetMetrics() {
  return request('/metrics')
}

// Default export
export default {
  configure,
  listHosts,
  getHost,
  addHost,
  updateHost,
  removeHost,
  listGroups,
  listGroupHosts,
  execCommand,
  execOnHost,
  execOnGroup,
  execWithApprovalToken,
  checkApprovalStatus,
  requestCommandApproval,
  pollApprovalStatus,
  checkHealth,
  getFleetSummary,
  exportRegistry,
  importRegistry,
  resolveHost,
  pingHosts,
  pingHost,
  listTools,
  getTool,
  runTool,
  listKeys,
  getKey,
  generateKey,
  deployKey,
  revokeKey,
  setupSudo,
  queryAuditLog,
  getFleetMetrics,
  configureBastionToken
}
