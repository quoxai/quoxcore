/**
 * QuoxTemporal Service — Temporal Intelligence
 *
 * Inspired by the temporal lobe. Provides time-aware cognition:
 * recency weighting, rhythm detection, duration anomaly tracking,
 * and temporal pattern recognition.
 *
 * Stream QMB Phase QMB-3.
 *
 * Data sources:
 * - Signal log (from senseService)
 * - Execution history (from task service via collector)
 * - Memory timestamps (from memoryManager)
 */

import { getRecentSignals } from './senseService.js'

// ── Temporal Event Log ─────────────────────────────────────────────
// Tracks events with timestamps for rhythm and duration analysis.

const TEMPORAL_BUFFER_SIZE = 500
const temporalEvents = []

/**
 * Record a temporal event.
 * @param {string} category — event category (execution, health, memory, agent)
 * @param {string} label — descriptive label
 * @param {number} [durationMs] — how long it took (null for point events)
 * @param {Object} [metadata] — extra data
 */
export function recordTemporalEvent(category, label, durationMs = null, metadata = null) {
  const event = {
    category,
    label,
    durationMs,
    metadata,
    timestamp: Date.now(),
    hour: new Date().getHours(),
    dayOfWeek: new Date().getDay(),  // 0=Sun, 6=Sat
  }

  temporalEvents.push(event)

  if (temporalEvents.length > TEMPORAL_BUFFER_SIZE) {
    temporalEvents.splice(0, temporalEvents.length - TEMPORAL_BUFFER_SIZE)
  }

  return event
}

/**
 * Get events from the last N hours.
 * @param {number} hours
 * @returns {Array}
 */
export function getEventsInWindow(hours = 24) {
  const cutoff = Date.now() - (hours * 3600000)
  return temporalEvents.filter(e => e.timestamp >= cutoff)
}

// ── Rhythm Detection ───────────────────────────────────────────────

/**
 * Detect time-of-day patterns.
 * Returns a histogram of events by hour.
 * @returns {Object} { hourHistogram: number[24], peakHour: number, quietHour: number }
 */
export function detectDailyRhythm() {
  const histogram = new Array(24).fill(0)

  for (const event of temporalEvents) {
    histogram[event.hour]++
  }

  let peakHour = 0
  let quietHour = 0
  for (let h = 0; h < 24; h++) {
    if (histogram[h] > histogram[peakHour]) peakHour = h
    if (histogram[h] < histogram[quietHour]) quietHour = h
  }

  return { hourHistogram: histogram, peakHour, quietHour }
}

/**
 * Detect day-of-week patterns.
 * @returns {Object} { dayHistogram: number[7], busiestDay: number, quietestDay: number }
 */
export function detectWeeklyRhythm() {
  const histogram = new Array(7).fill(0)
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  for (const event of temporalEvents) {
    histogram[event.dayOfWeek]++
  }

  let busiestDay = 0
  let quietestDay = 0
  for (let d = 0; d < 7; d++) {
    if (histogram[d] > histogram[busiestDay]) busiestDay = d
    if (histogram[d] < histogram[quietestDay]) quietestDay = d
  }

  return {
    dayHistogram: histogram,
    busiestDay,
    busiestDayName: dayNames[busiestDay],
    quietestDay,
    quietestDayName: dayNames[quietestDay],
  }
}

// ── Duration Tracking ──────────────────────────────────────────────

/**
 * Get average duration for a category.
 * @param {string} category
 * @returns {number|null} average duration in ms, or null if no data
 */
export function getAverageDuration(category) {
  const events = temporalEvents.filter(e => e.category === category && e.durationMs != null)
  if (events.length === 0) return null
  const sum = events.reduce((acc, e) => acc + e.durationMs, 0)
  return Math.round(sum / events.length)
}

/**
 * Detect duration anomalies — events significantly longer than average.
 * @param {string} category
 * @param {number} [multiplier=2] — how many times the average is "anomalous"
 * @returns {Array} anomalous events
 */
export function detectDurationAnomalies(category, multiplier = 2) {
  const avg = getAverageDuration(category)
  if (avg === null) return []
  const threshold = avg * multiplier
  return temporalEvents.filter(e =>
    e.category === category && e.durationMs != null && e.durationMs > threshold
  )
}

// ── Pattern Detection ──────────────────────────────────────────────

/**
 * Count detected patterns (rhythms + anomalies).
 * @returns {number}
 */
export function countPatterns() {
  let count = 0
  const { hourHistogram } = detectDailyRhythm()

  // Count hours with significant activity (> 2x average)
  const avgPerHour = temporalEvents.length / 24
  count += hourHistogram.filter(h => h > avgPerHour * 2).length

  // Count duration anomalies across categories
  const categories = [...new Set(temporalEvents.map(e => e.category))]
  for (const cat of categories) {
    count += detectDurationAnomalies(cat).length
  }

  return count
}

// ── Temporal Stats (for implant data fetcher) ──────────────────────
// QMH-2 QuoxTemporal commit: source of truth is /tasks/api/engine/temporal/stats
// (durable signal from tasks.duration_ms). The in-memory event buffer remains
// as a dev-mode fallback so a backend outage doesn't blank the topology card.

const TEMPORAL_STATS_URL = '/tasks/api/engine/temporal/stats'
const TEMPORAL_FETCH_TIMEOUT_MS = 4000

async function fetchTemporalStatsFromBackend() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEMPORAL_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(TEMPORAL_STATS_URL, {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = new Error(`temporal stats: HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function legacyInMemoryStats() {
  const recentEvents = getEventsInWindow(24)
  const avgDuration = getAverageDuration('execution') || 0
  const patternsDetected = countPatterns()
  const recentSignals = getRecentSignals(3600000) // 1 hour of signals

  // Seed temporal events from sense signals if we have no temporal data yet
  if (temporalEvents.length === 0 && recentSignals.length > 0) {
    for (const signal of recentSignals.slice(-20)) {
      recordTemporalEvent(signal.type, signal.summary, null, { fromSignal: true })
    }
  }

  return {
    healthScore: recentEvents.length > 0 ? 50 : null,
    recentEvents: recentEvents.length,
    avgDuration,
    patternsDetected,
    totalEvents: temporalEvents.length,
    rhythm: detectDailyRhythm(),
    fallback: true,
  }
}

/**
 * Get QuoxTemporal implant metrics.
 * Called by cognitiveTopologyService.fetchAllImplantData().
 *
 * Returns the convention-shaped backend response when reachable, or a
 * fallback object with `fallback: true` when the endpoint is unreachable.
 * The reflectionService and topology card both read `healthScore` directly.
 */
export async function getTemporalStats() {
  try {
    const body = await fetchTemporalStatsFromBackend()
    const fields = body.fields || {}
    return {
      healthScore: body.healthScore ?? null,
      primaryMetric: body.primaryMetric || null,
      collecting: body.healthScore === null && body.primaryMetric?.label?.startsWith('Collecting'),
      taskCount: fields.taskCount ?? 0,
      p50_ms: fields.p50_ms ?? null,
      p95_ms: fields.p95_ms ?? null,
      p99_ms: fields.p99_ms ?? null,
      anomalies_24h: fields.anomalies_24h ?? 0,
      hourly_histogram: fields.hourly_histogram || {},
      windowSinceIso: fields.windowSinceIso || null,
      sourceVersion: body.sourceVersion || null,
    }
  } catch (err) {
    // Fall back so topology page degrades gracefully. Logged once per session.
    if (!globalThis.__quoxTemporalFallbackLogged) {
      console.warn('[QuoxTemporal] backend unreachable, using in-memory fallback:', err?.message || err)
      globalThis.__quoxTemporalFallbackLogged = true
    }
    return legacyInMemoryStats()
  }
}
