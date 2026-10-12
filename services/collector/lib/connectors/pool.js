/**
 * Connector Instance Pool
 *
 * Manages active connector instances per org. Each instance holds:
 * - Resolved credentials (decrypted, short-lived in memory)
 * - Loaded connector module with tool definitions
 * - Usage tracking for idle timeout
 *
 * Instances are created on first tool call and cleaned up after idle timeout.
 * Multi-org isolation: each org gets its own instances.
 */

const IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const MAX_INSTANCES_PER_ORG = 10
const CLEANUP_INTERVAL_MS = 60 * 1000 // Check every minute

// Map: `${orgId}:${connectorId}` → ConnectorInstance
const _pool = new Map()
let _cleanupTimer = null

/**
 * @typedef {Object} ConnectorInstance
 * @property {string} connectorId
 * @property {string} orgId
 * @property {Object} credentials - Decrypted credential fields
 * @property {string} credentialId - Vault credential ID (for VOLT tracking)
 * @property {Object} module - Loaded connector module
 * @property {Object[]} tools - Tool definitions from the module
 * @property {number} createdAt
 * @property {number} lastUsedAt
 * @property {number} callCount
 */

/**
 * #481: `variant` distinguishes instances that share an org and connector but
 * hold DIFFERENT credentials — a GitHub PAT scoped to the website repo versus
 * one scoped to the product repos. Without it the first repo to warm the pool
 * would lend its token to every other repo for the next five minutes, which is
 * the very bug repo scoping exists to fix, reintroduced one layer down.
 *
 * An empty variant produces byte-identical keys to before, so every existing
 * caller is unchanged.
 */
function poolKey(orgId, connectorId, variant = '') {
  return variant ? `${orgId}:${connectorId}#${variant}` : `${orgId}:${connectorId}`
}

/**
 * Get or create a connector instance
 */
function getInstance(orgId, connectorId, variant = '') {
  const key = poolKey(orgId, connectorId, variant)
  const instance = _pool.get(key)
  if (instance) {
    instance.lastUsedAt = Date.now()
    instance.callCount++
    return instance
  }
  return null
}

/**
 * Register a new connector instance
 */
function setInstance(orgId, connectorId, instance, variant = '') {
  const key = poolKey(orgId, connectorId, variant)

  // Enforce per-org limits
  const orgInstances = [..._pool.entries()].filter(([k]) => k.startsWith(`${orgId}:`))
  if (orgInstances.length >= MAX_INSTANCES_PER_ORG) {
    // Evict the least recently used
    const lru = orgInstances.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0]
    if (lru) {
      _pool.delete(lru[0])
      console.log(`[ConnectorPool] Evicted LRU instance: ${lru[0]}`)
    }
  }

  _pool.set(key, {
    ...instance,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    callCount: 0,
  })
}

/**
 * Remove a connector instance
 */
function removeInstance(orgId, connectorId) {
  // Removes EVERY variant for this org+connector. The only caller is
  // deactivateConnector (credential rotation), and rotating a credential must
  // not leave repo-scoped siblings holding the retired secret.
  const base = poolKey(orgId, connectorId)
  let removed = 0
  for (const key of [..._pool.keys()]) {
    if (key === base || key.startsWith(`${base}#`)) {
      _pool.delete(key)
      removed++
    }
  }
  return removed > 0
}

/**
 * Remove all instances for an org (e.g., credential rotation)
 */
function clearOrg(orgId) {
  let removed = 0
  for (const key of _pool.keys()) {
    if (key.startsWith(`${orgId}:`)) {
      _pool.delete(key)
      removed++
    }
  }
  return removed
}

/**
 * Get all active instances (for status/monitoring)
 */
function getPoolStatus() {
  const instances = []
  for (const [key, inst] of _pool.entries()) {
    instances.push({
      key,
      connectorId: inst.connectorId,
      orgId: inst.orgId,
      credentialId: inst.credentialId,
      toolCount: inst.tools?.length || 0,
      callCount: inst.callCount,
      createdAt: inst.createdAt,
      lastUsedAt: inst.lastUsedAt,
      idleMs: Date.now() - inst.lastUsedAt,
    })
  }
  return {
    totalInstances: _pool.size,
    instances,
  }
}

/**
 * Clean up idle instances
 */
function cleanupIdle() {
  const now = Date.now()
  let removed = 0
  for (const [key, inst] of _pool.entries()) {
    if (now - inst.lastUsedAt > IDLE_TIMEOUT_MS) {
      _pool.delete(key)
      removed++
      console.log(`[ConnectorPool] Cleaned up idle instance: ${key} (idle ${Math.round((now - inst.lastUsedAt) / 1000)}s)`)
    }
  }
  return removed
}

/**
 * Start background cleanup timer
 */
function startCleanup() {
  if (_cleanupTimer) return
  _cleanupTimer = setInterval(cleanupIdle, CLEANUP_INTERVAL_MS)
  if (_cleanupTimer.unref) _cleanupTimer.unref()
}

/**
 * Stop background cleanup timer
 */
function stopCleanup() {
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer)
    _cleanupTimer = null
  }
}

/**
 * Clear entire pool (for shutdown)
 */
function clearAll() {
  _pool.clear()
  stopCleanup()
}

module.exports = {
  getInstance,
  setInstance,
  removeInstance,
  clearOrg,
  getPoolStatus,
  cleanupIdle,
  startCleanup,
  stopCleanup,
  clearAll,
  IDLE_TIMEOUT_MS,
  MAX_INSTANCES_PER_ORG,
}
