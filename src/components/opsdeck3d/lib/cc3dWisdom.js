/**
 * CC3D Wisdom Store — Learn from user interaction patterns.
 *
 * V2-QFY-5: Intelligence dimension.
 * Records navigation outcomes (zone visits, dwell time, feature usage).
 * Provides suggestions based on past behavior.
 *
 * Storage: localStorage (lightweight, no backend dependency).
 * Format: { visits: [...], patterns: {...}, lastSession: ... }
 */

const STORAGE_KEY = 'cc3d_wisdom'
const MAX_VISITS = 200

// ─── Core Storage ───────────────────────────────────────

function loadWisdom() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch { return {} }
}

function saveWisdom(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch { /* quota exceeded */ }
}

// ─── Record Events ──────────────────────────────────────

/**
 * Record a zone visit with dwell time.
 * @param {string} zone — zone code (NUC, SVC, AGT, etc.)
 * @param {number} dwellMs — time spent in zone (milliseconds)
 * @param {string} depth — depth layer (sky, eq, deep)
 */
export function recordZoneVisit(zone, dwellMs, depth = 'eq') {
  const data = loadWisdom()
  if (!data.visits) data.visits = []

  data.visits.push({
    zone,
    depth,
    dwellMs,
    timestamp: Date.now(),
  })

  // Keep last MAX_VISITS
  if (data.visits.length > MAX_VISITS) {
    data.visits = data.visits.slice(-MAX_VISITS)
  }

  // Update frequency map
  if (!data.zoneFrequency) data.zoneFrequency = {}
  data.zoneFrequency[zone] = (data.zoneFrequency[zone] || 0) + 1

  // Track depth preference
  if (!data.depthFrequency) data.depthFrequency = {}
  data.depthFrequency[depth] = (data.depthFrequency[depth] || 0) + 1

  data.lastSession = Date.now()
  data.sessionCount = (data.sessionCount || 0) + 1

  saveWisdom(data)
}

/**
 * Record a feature usage event.
 * @param {string} feature — feature name (search, tour, goldeneye, etc.)
 */
export function recordFeatureUsage(feature) {
  const data = loadWisdom()
  if (!data.featureUsage) data.featureUsage = {}
  data.featureUsage[feature] = (data.featureUsage[feature] || 0) + 1
  saveWisdom(data)
}

// ─── Query Patterns ─────────────────────────────────────

/**
 * Get the user's most visited zone.
 * @returns {{ zone: string, count: number } | null}
 */
export function getMostVisitedZone() {
  const data = loadWisdom()
  if (!data.zoneFrequency) return null
  const entries = Object.entries(data.zoneFrequency)
  if (entries.length === 0) return null
  const [zone, count] = entries.sort((a, b) => b[1] - a[1])[0]
  return { zone, count }
}

/**
 * Get the user's preferred depth layer.
 * @returns {'sky' | 'eq' | 'deep' | null}
 */
export function getPreferredDepth() {
  const data = loadWisdom()
  if (!data.depthFrequency) return null
  const entries = Object.entries(data.depthFrequency)
  if (entries.length === 0) return null
  return entries.sort((a, b) => b[1] - a[1])[0][0]
}

/**
 * Get session count.
 * @returns {number}
 */
export function getSessionCount() {
  const data = loadWisdom()
  return data.sessionCount || 0
}

/**
 * Suggest a starting position based on past behavior.
 * @returns {{ suggestion: string, position: number[] | null, reason: string } | null}
 */
export function getSuggestion() {
  const data = loadWisdom()
  const sessions = data.sessionCount || 0

  // First visit: suggest welcome tour
  if (sessions <= 1) {
    return {
      suggestion: 'Welcome! Press T for a guided tour of the Cognitive Core.',
      position: null,
      reason: 'first-visit',
    }
  }

  // Frequent infra visitor: suggest Deep mode
  const depthPref = getPreferredDepth()
  if (depthPref === 'deep') {
    return {
      suggestion: 'You usually check infrastructure. Starting in DEEP mode.',
      position: [12, -12, 22],
      reason: 'depth-preference',
    }
  }

  // Most visited zone
  const mvz = getMostVisitedZone()
  if (mvz && mvz.count > 5) {
    return {
      suggestion: `You visit ${mvz.zone} often. Jump there with the sidebar.`,
      position: null,
      reason: 'zone-frequency',
    }
  }

  return null
}

/**
 * Get full wisdom stats for debug/display.
 */
export function getWisdomStats() {
  const data = loadWisdom()
  return {
    sessionCount: data.sessionCount || 0,
    totalVisits: data.visits?.length || 0,
    zoneFrequency: data.zoneFrequency || {},
    depthFrequency: data.depthFrequency || {},
    featureUsage: data.featureUsage || {},
    lastSession: data.lastSession || null,
  }
}
