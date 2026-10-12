/**
 * Compliance Data Service — Server-First Data Access
 *
 * CRP-BE-2: Queries compliance data from the collector's server-side SQLite
 * with IndexedDB fallback. Ensures compliance reports work from any browser,
 * even with an empty cache.
 *
 * Server endpoints used:
 *   GET /collector/aee/query     — envelope queries (with decryption)
 *   GET /collector/aee/stats     — total envelopes, conversations, date range
 *   GET /collector/volt/runs     — VOLT run listing
 *   GET /collector/volt/runs/:id/events — VOLT events for a run
 *   GET /collector/volt/stats    — VOLT aggregate stats
 */

import { queryEnvelopes as queryIDB, getConversations as getConvsIDB, getStats as getStatsIDB } from '../../lib/aee'

/**
 * Query envelopes from server-side AEE SQLite, with IndexedDB fallback.
 *
 * @param {Object} filters - { after, before, type, intent, from, to, limit }
 * @returns {Promise<Array>} Envelopes
 */
export async function queryEnvelopesServer(filters = {}) {
  try {
    const params = new URLSearchParams()
    if (filters.after) params.set('after', filters.after)
    if (filters.before) params.set('before', filters.before)
    if (filters.type) params.set('type', filters.type)
    if (filters.intent) params.set('intent', filters.intent)
    if (filters.from) params.set('from', filters.from)
    if (filters.to) params.set('to', filters.to)
    params.set('limit', String(filters.limit || 10000))

    const res = await fetch(`/collector/aee/query?${params}`)
    if (!res.ok) throw new Error(`Server returned ${res.status}`)
    const data = await res.json()
    return data.envelopes || []
  } catch (err) {
    console.warn('[Compliance] Server query failed, falling back to IndexedDB:', err.message)
    return queryIDB(filters)
  }
}

/**
 * Get conversation list from server, with IndexedDB fallback.
 *
 * @param {Object} options - { after, limit }
 * @returns {Promise<Array>} Conversations
 */
export async function getConversationsServer(options = {}) {
  try {
    // Fetch more than needed since server endpoint has no date filtering
    const fetchLimit = Math.max((options.limit || 100) * 2, 500)
    const params = new URLSearchParams()
    params.set('limit', String(fetchLimit))
    const res = await fetch(`/collector/aee/conversations?${params}`)
    if (!res.ok) throw new Error(`Server returned ${res.status}`)
    const data = await res.json()
    let convs = data.conversations || []

    // Client-side date filtering (server endpoint doesn't support after/before)
    if (options.after) {
      convs = convs.filter(c => (c.last_ts || c.ts || '') >= options.after)
    }

    // Apply the original limit after filtering
    if (options.limit && convs.length > options.limit) {
      convs = convs.slice(0, options.limit)
    }

    return convs
  } catch (err) {
    console.warn('[Compliance] Server conversations failed, falling back to IndexedDB:', err.message)
    return getConvsIDB(options)
  }
}

/**
 * Get AEE stats from server, with IndexedDB fallback.
 *
 * @returns {Promise<Object>} { totalEnvelopes, totalConversations, oldestTs, newestTs }
 */
export async function getStatsServer() {
  try {
    const res = await fetch('/collector/aee/stats')
    if (!res.ok) throw new Error(`Server returned ${res.status}`)
    const data = await res.json()
    return {
      totalEnvelopes: data.total_envelopes || 0,
      totalConversations: data.conversations || 0,
      oldestTs: data.oldest_ts || null,
      newestTs: data.newest_ts || null
    }
  } catch (err) {
    console.warn('[Compliance] Server stats failed, falling back to IndexedDB:', err.message)
    return getStatsIDB()
  }
}

/**
 * Gather VOLT evidence from server-side SQLite.
 *
 * Queries VOLT runs and events from the collector, verifies a sample,
 * and returns integrity metrics. Falls back to null (not IndexedDB)
 * since VOLT frontend data may be incomplete.
 *
 * @param {Object} period - { start, end }
 * @returns {Promise<Object|null>} VOLT evidence summary or null
 */
export async function gatherVoltEvidenceServer(period) {
  try {
    // Get all runs from server
    const runsRes = await fetch(`/collector/volt/runs?limit=200`)
    if (!runsRes.ok) throw new Error(`VOLT runs: ${runsRes.status}`)
    const runsData = await runsRes.json()

    // Filter to completed runs in period
    const runs = (runsData.runs || []).filter(r => {
      if (r.status !== 'completed') return false
      if (period.start && r.started_at < period.start) return false
      if (period.end && r.completed_at > period.end) return false
      return true
    })

    if (runs.length === 0) return null

    // Verify a sample of runs (up to 10)
    const sample = runs.slice(0, 10)
    const verifications = []

    for (const run of sample) {
      try {
        const eventsRes = await fetch(`/collector/volt/runs/${run.run_id}/events`)
        if (!eventsRes.ok) continue
        const eventsData = await eventsRes.json()
        const events = eventsData.events || []

        if (events.length === 0) continue

        // Basic chain verification: check prev_hash linkage
        let chainValid = true
        for (let i = 1; i < events.length; i++) {
          const prevData = events[i - 1].data || events[i - 1]
          const currData = events[i].data || events[i]
          if (currData.prev_hash && prevData.hash && currData.prev_hash !== prevData.hash) {
            chainValid = false
            break
          }
        }

        verifications.push({
          run_id: run.run_id,
          valid: chainValid,
          event_count: events.length,
          chain_valid: chainValid
        })
      } catch (err) {
        verifications.push({
          run_id: run.run_id,
          valid: false,
          error: err.message
        })
      }
    }

    const validCount = verifications.filter(v => v.valid).length

    return {
      total_runs: runs.length,
      verified_sample: verifications.length,
      valid_count: validCount,
      integrity_rate: verifications.length > 0
        ? Math.round((validCount / verifications.length) * 100)
        : 0,
      verifications
    }
  } catch (err) {
    console.warn('[Compliance] VOLT evidence gathering failed:', err.message)
    return null
  }
}
