/**
 * Signal Aggregation Layer — QMD-B
 *
 * Real-time signal processing from fleet heartbeats.
 * Two tiers:
 *   1. Per-host ring buffer (5-min sliding window)
 *   2. Cross-host cascade detection (3+ hosts spike within 60s)
 *
 * Powers: QuoxSense (fleet signals), QuoxInsight (correlations), QuoxValue (concerns)
 *
 * QUOXMIND #1110: concerns carry the org of the heartbeat that raised them, but
 * only when the caller attributes one (server.js does so only for heartbeats
 * presented with the agent or internal service key). getConcernsForOrg(orgId)
 * is the ONLY read that may reach a chat turn; an unattributed concern reaches
 * no org. Host ids are sanitised because they are host-supplied text.
 */

// ── Configuration ─────────────────────────────────────────────────

const RING_SIZE = 10           // 10 entries per host (~5 min at 30s heartbeat)
const CASCADE_WINDOW_MS = 60000  // 60 seconds for cascade detection
const WARN_DISK = 80           // % disk warning threshold
const WARN_CPU = 90            // % CPU warning threshold
const WARN_MEM = 85            // % memory warning threshold
const CASCADE_MIN_HOSTS = 3    // minimum hosts for cascade alert
const MAX_CONCERNS = 50        // max active concerns

// ── Per-host Ring Buffer ──────────────────────────────────────────

const hostBuffers = new Map()  // host_id → Array of { timestamp, cpu, memory, disk }
const activeConcerns = []      // Active concerns list
const recentWarnings = []      // Recent threshold breaches for cascade detection

/**
 * Record a heartbeat signal. Called from the heartbeat handler.
 *
 * @param {string} hostId
 * @param {Object} resources — from heartbeat: { cpu, memory, disk }
 */
function safeHostId(hostId) {
  return String(hostId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
}

function recordHeartbeat(rawHostId, resources, { orgId = null } = {}) {
  if (!rawHostId || !resources) return
  const hostId = safeHostId(rawHostId)
  const org = typeof orgId === 'string' && orgId && orgId !== 'default' ? orgId : null

  const cpu = resources.cpu?.usage_percent
  const mem = resources.memory?.usage_percent
  const diskMounts = Array.isArray(resources.disk) ? resources.disk : []
  const rootDisk = diskMounts.find(d => d.mount_point === '/') || diskMounts[0]
  const disk = rootDisk?.usage_percent

  const entry = {
    timestamp: Date.now(),
    cpu: cpu != null ? Math.round(cpu * 10) / 10 : null,
    memory: mem != null ? Math.round(mem * 10) / 10 : null,
    disk: disk != null ? Math.round(disk * 10) / 10 : null,
  }

  // Update ring buffer
  if (!hostBuffers.has(hostId)) {
    hostBuffers.set(hostId, [])
  }
  const buffer = hostBuffers.get(hostId)
  buffer.push(entry)
  if (buffer.length > RING_SIZE) {
    buffer.shift()
  }

  // Check thresholds and raise concerns
  const warnings = []
  if (entry.disk != null && entry.disk > WARN_DISK) {
    warnings.push({ type: 'disk', value: entry.disk, threshold: WARN_DISK })
  }
  if (entry.cpu != null && entry.cpu > WARN_CPU) {
    warnings.push({ type: 'cpu', value: entry.cpu, threshold: WARN_CPU })
  }
  if (entry.memory != null && entry.memory > WARN_MEM) {
    warnings.push({ type: 'memory', value: entry.memory, threshold: WARN_MEM })
  }

  // Record warnings for cascade detection
  for (const w of warnings) {
    recentWarnings.push({
      hostId,
      orgId: org,
      ...w,
      timestamp: Date.now(),
    })

    // Raise per-host concern
    raiseConcern(
      org ? `${org}:${hostId}_${w.type}` : `${hostId}_${w.type}`,
      `${hostId}: ${w.type} at ${w.value}% (threshold: ${w.threshold}%)`,
      w.type === 'disk' ? 70 : 60,
      { hostId, metric: w.type, value: w.value },
      org
    )
  }

  // Trim old warnings (keep 5 minutes)
  const cutoff = Date.now() - 300000
  while (recentWarnings.length > 0 && recentWarnings[0].timestamp < cutoff) {
    recentWarnings.shift()
  }

  // Check for cascades
  detectCascades()
}

// ── Cascade Detection ─────────────────────────────────────────────

function detectCascades() {
  const now = Date.now()
  const windowStart = now - CASCADE_WINDOW_MS

  // Group recent warnings by org + type within the cascade window (hosts of
  // different orgs never combine into one cascade).
  const groups = new Map()
  for (const w of recentWarnings) {
    if (w.timestamp < windowStart) continue
    const k = `${w.orgId || ''}|${w.type}`
    if (!groups.has(k)) groups.set(k, { orgId: w.orgId || null, type: w.type, hosts: new Set() })
    groups.get(k).hosts.add(w.hostId)
  }

  // If 3+ unique hosts breached the same metric in 60s, cascade alert
  for (const { orgId, type, hosts } of groups.values()) {
    if (hosts.size >= CASCADE_MIN_HOSTS) {
      raiseConcern(
        orgId ? `${orgId}:cascade_${type}` : `cascade_${type}`,
        `CASCADE: ${hosts.size} hosts with high ${type} in last 60s (${[...hosts].join(', ')})`,
        90,
        { type: 'cascade', metric: type, hosts: [...hosts], count: hosts.size },
        orgId
      )
    }
  }
}

// ── Concern Management ────────────────────────────────────────────

function raiseConcern(id, description, priority, data = null, orgId = null) {
  // Update if exists, create if not
  const existing = activeConcerns.findIndex(c => c.id === id)
  const concern = {
    id,
    description,
    priority: Math.max(0, Math.min(100, priority)),
    data,
    orgId: orgId || null,
    raisedAt: Date.now(),
    updatedAt: Date.now(),
  }

  if (existing >= 0) {
    activeConcerns[existing] = concern
  } else {
    activeConcerns.push(concern)
  }

  // Trim and sort
  activeConcerns.sort((a, b) => b.priority - a.priority)
  if (activeConcerns.length > MAX_CONCERNS) {
    activeConcerns.length = MAX_CONCERNS
  }
}

/**
 * Get active concerns sorted by priority.
 * Concerns auto-expire after 10 minutes without update.
 */
function getConcerns() {
  const now = Date.now()
  const EXPIRY_MS = 10 * 60 * 1000  // 10 minutes

  // Remove expired concerns
  for (let i = activeConcerns.length - 1; i >= 0; i--) {
    if (now - activeConcerns[i].updatedAt > EXPIRY_MS) {
      activeConcerns.splice(i, 1)
    }
  }

  return activeConcerns.slice(0, 20)
}

/**
 * QUOXMIND #1110: the concerns of ONE org, for QuoxSense's "notable now" in a
 * chat turn. Ids are returned without the org prefix. Unattributed concerns
 * are never returned.
 */
function getConcernsForOrg(orgId) {
  if (!orgId) return []
  const prefix = `${orgId}:`
  return getConcerns()
    .filter((c) => c.orgId === orgId)
    .map((c) => ({ id: c.id.startsWith(prefix) ? c.id.slice(prefix.length) : c.id, description: c.description, priority: c.priority }))
}

function _resetForTests() {
  hostBuffers.clear()
  activeConcerns.length = 0
  recentWarnings.length = 0
}

/**
 * Get signal aggregation stats for the Mirror.
 */
function getSignalStats() {
  const hostsWithWarnings = new Set()
  const now = Date.now()
  const RECENT_MS = 5 * 60 * 1000

  for (const w of recentWarnings) {
    if (now - w.timestamp < RECENT_MS) {
      hostsWithWarnings.add(w.hostId)
    }
  }

  return {
    hostsMonitored: hostBuffers.size,
    hostsWithWarnings: hostsWithWarnings.size,
    warningHosts: [...hostsWithWarnings],
    activeConcerns: activeConcerns.length,
    topConcern: activeConcerns[0]?.description || null,
    cascadesDetected: activeConcerns.filter(c => c.data?.type === 'cascade').length,
  }
}

/**
 * Get per-host latest readings (for fleet overview).
 */
function getFleetSnapshot() {
  const snapshot = {}
  for (const [hostId, buffer] of hostBuffers) {
    if (buffer.length > 0) {
      const latest = buffer[buffer.length - 1]
      snapshot[hostId] = {
        cpu: latest.cpu,
        memory: latest.memory,
        disk: latest.disk,
        lastSeen: latest.timestamp,
        readings: buffer.length,
      }
    }
  }
  return snapshot
}

module.exports = {
  recordHeartbeat,
  getConcerns,
  getConcernsForOrg,
  getSignalStats,
  _resetForTests,
  getFleetSnapshot,
}
