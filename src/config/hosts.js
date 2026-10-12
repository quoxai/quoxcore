// Quox Host Registry
// Centralized source of truth for all managed hosts
//
// INTEGRATION: QuoxBastion is now the canonical source of truth for hosts.
// This module provides backwards-compatible sync functions using cached data
// and async functions that fetch live data from Bastion.
//
// Configuration priority:
// 1. QuoxBastion API (primary source - live data)
// 2. Infrastructure config from Settings UI (fallback)
// 3. Example hosts for demo/development (final fallback)

import * as bastionClient from '../services/bastionClient.js'

// Cache for Bastion data
let bastionHostsCache = []
let bastionGroupsCache = []
let bastionPingCache = []
let lastBastionFetch = 0
const BASTION_CACHE_TTL = 30000 // 30 seconds

// Track if Bastion is available
let bastionAvailable = null

// Empty registry — all host data comes from QuoxBastion API or user settings.
// NO placeholder/example data — it leaks into LLM prompts and causes hallucinations.
const EMPTY_REGISTRY = {}

/**
 * Load host registry from localStorage settings or use example hosts
 */
function loadHostRegistry() {
  try {
    const settings = JSON.parse(localStorage.getItem('quox-settings') || '{}')

    // If user has configured infrastructure, use that
    if (settings.infrastructure?.hosts) {
      console.log('[hosts] Using configured infrastructure from settings')
      return settings.infrastructure.hosts
    }
  } catch (err) {
    console.warn('[hosts] Failed to load settings:', err.message)
  }

  // No local settings — hosts will be fetched from QuoxBastion API dynamically.
  // Never return placeholder data; it leaks into LLM prompts and causes hallucinations.
  console.log('[hosts] No local host settings. Infrastructure data will come from QuoxBastion API.')
  return EMPTY_REGISTRY
}

// Load registry - will be example hosts until user configures their infrastructure
export const hostRegistry = loadHostRegistry()

// Build lookup maps
const hostnameToId = new Map()
const idToHost = new Map()
const allHostnames = new Set()

function rebuildMaps() {
  hostnameToId.clear()
  idToHost.clear()
  allHostnames.clear()

  Object.values(hostRegistry).flat().forEach(host => {
    idToHost.set(host.id, host)
    hostnameToId.set(host.id.toLowerCase(), host.id)
    allHostnames.add(host.id)

    host.aliases?.forEach(alias => {
      hostnameToId.set(alias.toLowerCase(), host.id)
      allHostnames.add(alias)
    })
  })
}

rebuildMaps()

/**
 * Get all known hostnames (IDs + aliases)
 */
export function getAllHostnames() {
  return Array.from(allHostnames)
}

/**
 * Get all canonical host IDs (no aliases)
 */
export function getAllHostIds() {
  return Array.from(idToHost.keys())
}

/**
 * Resolve an alias or partial name to canonical host ID
 */
export function resolveHostname(input) {
  if (!input) return null
  const lower = input.toLowerCase().trim()

  // Direct match
  if (hostnameToId.has(lower)) {
    return hostnameToId.get(lower)
  }

  // Partial match (e.g., "kuma" matches "kuma01")
  for (const [alias, id] of hostnameToId) {
    if (alias.startsWith(lower) || lower.startsWith(alias)) {
      return id
    }
  }

  return null
}

/**
 * Get host details by ID
 */
export function getHost(id) {
  return idToHost.get(id) || null
}

/**
 * Get hosts by category
 */
export function getHostsByCategory(category) {
  return hostRegistry[category] || []
}

/**
 * Extract host references from a query string
 */
export function extractHostsFromQuery(query) {
  const words = query.toLowerCase().split(/[\s,]+/)
  const found = new Set()

  for (const word of words) {
    const resolved = resolveHostname(word)
    if (resolved) {
      found.add(resolved)
    }
  }

  return Array.from(found)
}

/**
 * Get summary for context injection
 */
export function getHostSummary() {
  const categories = Object.keys(hostRegistry)
  const counts = categories.map(cat => `${cat}: ${hostRegistry[cat].length}`)
  const total = Object.values(hostRegistry).flat().length

  return {
    total,
    byCategory: Object.fromEntries(
      categories.map(cat => [cat, hostRegistry[cat].length])
    ),
    summary: `${total} hosts (${counts.join(', ')})`
  }
}

/**
 * Update host registry from settings (call after settings change)
 */
export function refreshHostRegistry() {
  const newHosts = loadHostRegistry()
  Object.keys(hostRegistry).forEach(key => delete hostRegistry[key])
  Object.assign(hostRegistry, newHosts)
  rebuildMaps()
  console.log('[hosts] Registry refreshed')
}

// ============================================
// BASTION INTEGRATION - Async API Functions
// ============================================

/**
 * Check if QuoxBastion is available
 * @returns {Promise<boolean>}
 */
export async function isBastionAvailable() {
  if (bastionAvailable !== null && Date.now() - lastBastionFetch < BASTION_CACHE_TTL) {
    return bastionAvailable
  }

  try {
    await bastionClient.checkHealth()
    bastionAvailable = true
    console.log('[hosts] QuoxBastion is available')
    return true
  } catch {
    bastionAvailable = false
    console.log('[hosts] QuoxBastion not available, using local registry')
    return false
  }
}

/**
 * Fetch hosts from QuoxBastion (async, with caching)
 * Falls back to local registry if Bastion is unavailable
 * @returns {Promise<Array>} List of hosts
 */
export async function getHosts() {
  const now = Date.now()

  // Return cache if fresh
  if (bastionHostsCache.length > 0 && now - lastBastionFetch < BASTION_CACHE_TTL) {
    return bastionHostsCache
  }

  try {
    const hosts = await bastionClient.listHosts()
    bastionHostsCache = hosts
    lastBastionFetch = now
    bastionAvailable = true

    // Also update the sync registry for backwards compat
    updateRegistryFromBastion(hosts)

    console.log(`[hosts] Fetched ${hosts.length} hosts from QuoxBastion`)
    return hosts
  } catch (err) {
    console.warn('[hosts] Failed to fetch from Bastion:', err.message)
    bastionAvailable = false

    // Return cached data if available, otherwise convert local registry
    if (bastionHostsCache.length > 0) {
      return bastionHostsCache
    }

    // Convert local registry to Bastion format
    return convertRegistryToList()
  }
}

/**
 * Get hosts with live ping status from Bastion
 * @returns {Promise<{hosts: Array, ping: Object}>}
 */
export async function getHostsWithPing() {
  try {
    const [hosts, pingResults] = await Promise.all([
      getHosts(),
      bastionClient.pingHosts()
    ])

    // Convert ping results to a lookup map
    const pingMap = {}
    for (const result of pingResults) {
      pingMap[result.host] = {
        reachable: result.reachable,
        latency_ms: result.latency_ms,
        error: result.error
      }
    }

    bastionPingCache = pingMap

    return { hosts, ping: pingMap }
  } catch (err) {
    console.warn('[hosts] Failed to get hosts with ping:', err.message)
    return { hosts: await getHosts(), ping: bastionPingCache }
  }
}

/**
 * Get all groups from Bastion
 * @returns {Promise<Array>}
 */
export async function getGroups() {
  const now = Date.now()

  if (bastionGroupsCache.length > 0 && now - lastBastionFetch < BASTION_CACHE_TTL) {
    return bastionGroupsCache
  }

  try {
    const groups = await bastionClient.listGroups()
    bastionGroupsCache = groups
    return groups
  } catch (err) {
    console.warn('[hosts] Failed to fetch groups:', err.message)
    // Return local categories as fallback
    return Object.keys(hostRegistry)
  }
}

/**
 * Get fleet summary from Bastion
 * @returns {Promise<Object>}
 */
export async function getFleetSummary() {
  try {
    return await bastionClient.getFleetSummary()
  } catch (err) {
    console.warn('[hosts] Failed to get fleet summary:', err.message)
    const hosts = await getHosts()
    return {
      totalHosts: hosts.length,
      groups: Object.keys(hostRegistry),
      groupCount: Object.keys(hostRegistry).length,
      health: { unknown: hosts.length },
      hosts
    }
  }
}

/**
 * Resolve a hostname using Bastion (falls back to local)
 * @param {string} nameOrAlias
 * @returns {Promise<Object|null>}
 */
export async function resolveHostFromBastion(nameOrAlias) {
  if (!nameOrAlias) return null

  try {
    const host = await bastionClient.resolveHost(nameOrAlias)
    return host
  } catch {
    // Fallback to local resolution
    const id = resolveHostname(nameOrAlias)
    return id ? getHost(id) : null
  }
}

/**
 * Ping all hosts through Bastion
 * @returns {Promise<Array>}
 */
export async function pingAllHosts() {
  try {
    const results = await bastionClient.pingHosts()
    bastionPingCache = results.reduce((acc, r) => {
      acc[r.host] = r
      return acc
    }, {})
    return results
  } catch (err) {
    console.warn('[hosts] Failed to ping hosts:', err.message)
    return []
  }
}

/**
 * Get cached ping results
 * @returns {Object}
 */
export function getCachedPing() {
  return bastionPingCache
}

/**
 * Force refresh from Bastion
 */
export async function refreshFromBastion() {
  lastBastionFetch = 0
  bastionHostsCache = []
  bastionGroupsCache = []
  await getHosts()
  console.log('[hosts] Forced refresh from Bastion')
}

// ============================================
// Internal helpers
// ============================================

/**
 * Convert local registry format to Bastion list format
 */
function convertRegistryToList() {
  const hosts = []
  for (const [category, categoryHosts] of Object.entries(hostRegistry)) {
    for (const host of categoryHosts || []) {
      hosts.push({
        id: host.id,
        address: host.ip,
        group: category,
        user: host.user || 'control',
        aliases: host.aliases || [],
        description: host.description || ''
      })
    }
  }
  return hosts
}

/**
 * Update local registry from Bastion data (for backwards compat)
 */
function updateRegistryFromBastion(hosts) {
  // Group hosts by their group field
  const grouped = {}
  for (const host of hosts) {
    const group = host.group || 'other'
    if (!grouped[group]) grouped[group] = []
    grouped[group].push({
      id: host.id,
      ip: host.address,
      aliases: host.aliases || [],
      description: host.description || ''
    })
  }

  // Update registry (preserve existing structure)
  for (const [group, groupHosts] of Object.entries(grouped)) {
    hostRegistry[group] = groupHosts
  }

  rebuildMaps()
}

/**
 * Generate infrastructure context for LLM injection
 * This is the key function that gives assistants Bastion awareness
 * @returns {Promise<string>}
 */
export async function generateInfrastructureContext() {
  try {
    const { hosts, ping } = await getHostsWithPing()
    const groups = await getGroups()

    const online = Object.values(ping).filter(p => p.reachable).length
    const offline = Object.values(ping).filter(p => !p.reachable).length

    // Group hosts by category
    const groupedHosts = {}
    for (const host of hosts) {
      const group = host.group || 'other'
      if (!groupedHosts[group]) groupedHosts[group] = []
      groupedHosts[group].push({
        ...host,
        status: ping[host.id]?.reachable ? 'online' : 'offline',
        latency: ping[host.id]?.latency_ms
      })
    }

    let context = `
### Infrastructure Status (via QuoxBastion)
- **Total Hosts:** ${hosts.length}
- **Online:** ${online}/${hosts.length}
- **Offline:** ${offline}
- **Groups:** ${groups.join(', ')}

**Host Categories:**
`

    for (const [group, groupHosts] of Object.entries(groupedHosts)) {
      const onlineCount = groupHosts.filter(h => h.status === 'online').length
      context += `- **${group}** (${onlineCount}/${groupHosts.length} online): ${groupHosts.map(h => h.id).join(', ')}\n`
    }

    // Add quick reference for offline hosts
    const offlineHosts = hosts.filter(h => ping[h.id] && !ping[h.id].reachable)
    if (offlineHosts.length > 0) {
      context += `\n**Currently Offline:**\n`
      for (const h of offlineHosts.slice(0, 10)) {
        context += `- ${h.id}: ${ping[h.id]?.error || 'unreachable'}\n`
      }
    }

    context += `
### SSH Execution via Bastion
You can execute commands on any host via QuoxBastion:
- Use \`bastionClient.execOnHost(hostId, command)\` for single host
- Use \`bastionClient.execOnGroup(group, command)\` for group-wide execution
- Use \`bastionClient.pingHost(hostId)\` to check connectivity

**Bastion API:** http://gw-01:9850
`

    return context
  } catch (err) {
    console.warn('[hosts] Failed to generate infrastructure context:', err.message)
    return `
### Infrastructure Status — UNAVAILABLE
**QuoxBastion is not reachable or not authenticated.** No infrastructure data is available.
- Error: ${err.message}
- **Do NOT guess or fabricate host IPs.** Tell the user that QuoxBastion is unavailable.
- The user should check: (1) Is QuoxBastion running on gw-01? (2) Is the API token configured in Settings > Bastion Fleet?
`
  }
}

export default hostRegistry
