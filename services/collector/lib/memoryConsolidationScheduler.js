/**
 * Memory Consolidation Scheduler — TRUST-GATE-1.11
 *
 * Before: the ONLY trigger for "memory consolidation" was a browser
 * setInterval in src/services/reflectionLoop.js — a zero-tolerance
 * violation (browser timers are not background jobs — they only run
 * while a tab is open). That client-side loop also never actually called
 * the memory service's authoritative consolidation route; it deduplicated
 * a separate legacy localStorage-only "learned memory" cache instead.
 *
 * After: this module runs consolidation server-side, daily at a fixed
 * off-peak hour (env-configurable), against the real memory service via
 * POST /api/memory/consolidate (services/memory/server.js:867). That route
 * expects PRE-COMPUTED action lists (duplicates/contradictions/
 * promote_to_core/archive_ids) — this module computes the `duplicates`
 * list using the same word-overlap technique already used client-side by
 * memoryManager.findDuplicateMemories(), applied to the org's real
 * server-side memories instead of a localStorage cache.
 *
 * TRUST-GATE-1.12a: the memory service's `authenticate` middleware now also
 * accepts X-Service-Key (+ X-Org-Id/X-User-Id scoping headers) alongside the
 * user-JWT path (services/memory/middleware/auth.js). This module already
 * sent X-Service-Key, but never sent the org scoping header — its `orgId`
 * param was accepted but unused, so every call silently fell back to the
 * service default org ('default') regardless of which org was being
 * consolidated. Fixed below: X-Org-Id is now sent on both the list call and
 * the consolidate call.
 *
 * TRUST-GATE-1.23: the scheduler's `orgIds` option defaulted to ['default']
 * with no live-org enumeration, so only that one hardcoded org ever actually
 * got consolidated — every other tenant's memories were silently never
 * consolidated. Fixed below: when no explicit `orgIds` are passed, the
 * scheduler enumerates the real live orgs via `fetchLiveOrgIds()`, which
 * calls a small new auth-service internal endpoint
 * (GET /api/internal/orgs/list, services/auth/routes/internal-orgs.js) over
 * the existing INTERNAL_SERVICE_KEY / X-Service-Key service-to-service auth
 * path, and consolidates each org independently.
 */

const configResolver = require('./configResolver.js')

const MEMORY_URL = `http://${process.env.MEMORY_HOST || 'memory'}:${process.env.MEMORY_PORT || '3103'}`
const AUTH_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000 // daily
const DEFAULT_HOUR_UTC = 3 // off-peak default (03:00 UTC)
const DEFAULT_DUP_THRESHOLD = 0.6
// STABILITY-AUDITS #4: house scheduler triad (mirrors reflectionMiningScheduler.js
// 88811f7f / feedScheduler.js 49eb13d4 in this same collector service) —
// bounded concurrency instead of an unawaited ids.forEach() fan-out.
const DEFAULT_ORG_CONCURRENCY = 3

// VAULT-INTEG P13 slice 2: was a bare process.env read — now resolved
// through configResolver.getInstanceSetting() (platformCapabilities.js
// MEMORY_CONSOLIDATION_ORG_CONCURRENCY) so a stored instance-wide override
// can win over env. Called fresh from inside runAll() on every tick (not
// captured once via a default param at scheduler start), so a change to
// the stored/env value applies from the very next tick — no restart
// needed, unlike getIntervalMs() below (whose value only takes effect
// where the scheduler's own timer is created).
function resolveOrgConcurrency() {
  const raw = configResolver.getInstanceSetting('MEMORY_CONSOLIDATION_ORG_CONCURRENCY').value
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ORG_CONCURRENCY
}

// VAULT-INTEG P13 slice 2: was a bare process.env read — now resolved
// through configResolver.getInstanceSetting() (platformCapabilities.js
// MEMORY_CONSOLIDATION_INTERVAL_MS), still called once when the scheduler
// starts (see startMemoryConsolidationScheduler below) — an override is
// stored/audited immediately but only takes effect from the next collector
// restart, since the setInterval this value seeds cannot change cadence
// without being recreated (registry entry: requiresRestart: true).
function getIntervalMs() {
  const raw = configResolver.getInstanceSetting('MEMORY_CONSOLIDATION_INTERVAL_MS').value
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS
}

function getTargetHourUtc() {
  const raw = process.env.MEMORY_CONSOLIDATION_HOUR_UTC
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 23 ? parsed : DEFAULT_HOUR_UTC
}

/**
 * ms until the next UTC occurrence of `hourUtc` (0-23), so the scheduler's
 * first run lands on an off-peak boundary instead of firing at boot time.
 */
function msUntilNextHour(hourUtc, now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0))
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next.getTime() - now.getTime()
}

/**
 * Jaccard word-overlap similarity — same technique as the browser-side
 * memoryManager.calculateTextSimilarity(), ported here so it runs against
 * the real server-side memory store instead of a localStorage cache.
 */
function jaccardSimilarity(a = '', b = '') {
  const words1 = new Set(String(a).toLowerCase().split(/\s+/).filter(Boolean))
  const words2 = new Set(String(b).toLowerCase().split(/\s+/).filter(Boolean))
  if (words1.size === 0 || words2.size === 0) return 0
  const intersection = new Set([...words1].filter(w => words2.has(w)))
  const union = new Set([...words1, ...words2])
  return intersection.size / union.size
}

/**
 * Group near-duplicate memories within the same memory_type + agent_id
 * (never merge across types/agents) and build the `duplicates` payload
 * shape the consolidate endpoint expects: { memory_ids, merged_content, reason }.
 * The highest-confidence (then most-recent) memory in each group is kept
 * first — the endpoint keeps memory_ids[0] and supersedes the rest.
 */
function computeDuplicates(memories = [], threshold = DEFAULT_DUP_THRESHOLD) {
  const buckets = new Map()
  for (const mem of memories) {
    const key = `${mem.memory_type || 'unknown'}::${mem.agent_id || 'none'}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(mem)
  }

  const duplicates = []

  for (const items of buckets.values()) {
    const claimed = new Set()
    for (let i = 0; i < items.length; i++) {
      if (claimed.has(items[i].id)) continue
      const group = [items[i]]
      for (let j = i + 1; j < items.length; j++) {
        if (claimed.has(items[j].id)) continue
        if (jaccardSimilarity(items[i].content, items[j].content) >= threshold) {
          group.push(items[j])
        }
      }
      if (group.length > 1) {
        group.forEach(m => claimed.add(m.id))
        const sorted = [...group].sort((a, b) => {
          const confDiff = (b.confidence ?? 0.5) - (a.confidence ?? 0.5)
          if (confDiff !== 0) return confDiff
          return new Date(b.created_at || 0) - new Date(a.created_at || 0)
        })
        duplicates.push({
          memory_ids: sorted.map(m => m.id),
          merged_content: sorted[0].content,
          reason: `${sorted.length} near-duplicate memories (>= ${Math.round(threshold * 100)}% word overlap)`,
        })
      }
    }
  }

  return duplicates
}

async function fetchOrgMemories({ orgId, fetchFn }) {
  const res = await fetchFn(`${MEMORY_URL}/api/memory?limit=200`, {
    headers: { 'X-Service-Key': SERVICE_KEY, 'X-Org-Id': orgId },
  })
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`)
  }
  const data = await res.json()
  return data.memories || []
}

/**
 * Run one consolidation pass for an org. Never throws — this is a
 * background job — but every failure path is logged loudly (console.error
 * with status + body excerpt), never silently swallowed.
 */
async function runMemoryConsolidation({ orgId = 'default', fetchFn = fetch, threshold = DEFAULT_DUP_THRESHOLD } = {}) {
  let memories
  try {
    memories = await fetchOrgMemories({ orgId, fetchFn })
  } catch (err) {
    console.error(`[MemoryConsolidation] org=${orgId}: failed to list memories — ${err.message}`)
    return { orgId, error: err.message }
  }

  const duplicates = computeDuplicates(memories, threshold)

  if (duplicates.length === 0) {
    console.log(`[MemoryConsolidation] org=${orgId}: checked ${memories.length} memories, no duplicates found`)
    return { orgId, merged: 0, checked: memories.length }
  }

  try {
    const res = await fetchFn(`${MEMORY_URL}/api/memory/consolidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, 'X-Org-Id': orgId },
      body: JSON.stringify({ duplicates, contradictions: [], promote_to_core: [], archive_ids: [] }),
    })

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      console.error(`[MemoryConsolidation] org=${orgId}: consolidate call failed HTTP ${res.status} — ${bodyText.slice(0, 300) || '(empty body)'}`)
      return { orgId, error: `HTTP ${res.status}`, checked: memories.length }
    }

    const result = await res.json()
    console.log(`[MemoryConsolidation] org=${orgId}: merged ${result.merged || 0} duplicate group(s) from ${memories.length} memories checked`)
    return { orgId, checked: memories.length, ...result }
  } catch (err) {
    console.error(`[MemoryConsolidation] org=${orgId}: consolidate call failed — ${err.message}`)
    return { orgId, error: err.message, checked: memories.length }
  }
}

/**
 * Enumerate the real live orgs to consolidate, via the auth service's
 * internal orgs endpoint (service-to-service auth: X-Service-Key). Never
 * throws — this feeds a background scheduler — but every failure is logged
 * loudly rather than silently swallowed. Returns [] on any failure, which
 * callers must treat as "nothing to consolidate this cycle" rather than
 * falling back to a hardcoded org.
 */
async function fetchLiveOrgIds({ fetchFn = fetch } = {}) {
  try {
    const res = await fetchFn(`${AUTH_URL}/api/internal/orgs/list`, {
      headers: { 'X-Service-Key': SERVICE_KEY },
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      console.error(`[MemoryConsolidation] failed to enumerate live orgs — HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`)
      return []
    }
    const data = await res.json()
    const orgIds = Array.isArray(data.orgIds) ? data.orgIds : []
    if (orgIds.length === 0) {
      console.warn('[MemoryConsolidation] live org enumeration returned zero orgs — no consolidation will run this cycle')
    }
    return orgIds
  } catch (err) {
    console.error(`[MemoryConsolidation] failed to enumerate live orgs — ${err.message}`)
    return []
  }
}

let schedulerTimeout = null
let schedulerInterval = null
// STABILITY-AUDITS #4: overlap guard — a daily run is bounded by nothing
// (no per-org timeout in this module), so if one org's consolidate call
// hangs, the scheduled interval firing again a day later must not start a
// SECOND overlapping run on top of it. Same shape as reflectionMiningScheduler.js's
// cycleInFlight / feedScheduler.js's per-source in-flight guard.
let cycleInFlight = false

/**
 * Start the server-side daily consolidation schedule.
 * @param {object} [opts]
 * @param {string[]} [opts.orgIds] - explicit orgs to consolidate each run. If
 *   omitted (the default), the scheduler enumerates the real live orgs via
 *   `listOrgIdsFn` on every run instead of hardcoding a single org
 *   (TRUST-GATE-1.23).
 * @param {function} [opts.listOrgIdsFn] - injectable for tests (defaults to fetchLiveOrgIds)
 * @param {function} [opts.setTimeoutFn] - injectable for tests
 * @param {function} [opts.setIntervalFn] - injectable for tests
 * @param {function} [opts.runFn] - injectable for tests (defaults to runMemoryConsolidation)
 * @param {number} [opts.orgConcurrency] - bounded fan-out width (STABILITY-AUDITS #4).
 *   An explicit value here always wins (tests). Omitted (the default), it is
 *   resolved fresh via resolveOrgConcurrency() on every tick — VAULT-INTEG
 *   P13 slice 2 — rather than once here, so a stored/env
 *   MEMORY_CONSOLIDATION_ORG_CONCURRENCY override applies from the very
 *   next tick, not just the next scheduler restart.
 */
function startMemoryConsolidationScheduler({
  orgIds = null,
  listOrgIdsFn = fetchLiveOrgIds,
  setTimeoutFn = setTimeout,
  setIntervalFn = setInterval,
  runFn = runMemoryConsolidation,
  orgConcurrency,
} = {}) {
  if (schedulerTimeout || schedulerInterval) return // already started

  const hourUtc = getTargetHourUtc()
  const intervalMs = getIntervalMs()
  const delay = msUntilNextHour(hourUtc)

  // VAULT-INTEG P13 slice 2: an explicit orgConcurrency (tests) always
  // wins; otherwise resolved fresh EVERY call (including from inside
  // runAll() on every tick, not just here at scheduler start).
  const resolveEffectiveOrgConcurrency = () =>
    Number.isFinite(orgConcurrency) && orgConcurrency > 0 ? orgConcurrency : resolveOrgConcurrency()

  console.log(`[MemoryConsolidation] scheduled daily at ${hourUtc}:00 UTC (first run in ${Math.round(delay / 60000)}m, then every ${Math.round(intervalMs / 3600000)}h, concurrency ${resolveEffectiveOrgConcurrency()})`)

  // STABILITY-AUDITS #4: was `ids.forEach(orgId => runFn({ orgId }))` —
  // unawaited (the promises were fired and abandoned, never observed) and
  // unbounded (every live org's consolidate call launched concurrently in
  // one burst). Now awaited in bounded batches, with an in-flight guard so
  // a run that's still going when the next daily tick fires is skipped
  // rather than doubled up, and success/failure counted distinctly so a
  // bad cycle is visible in the logs instead of silently swallowed.
  const runAll = async () => {
    if (cycleInFlight) {
      console.warn('[MemoryConsolidation] previous run still in progress — skipping this cycle')
      return
    }
    cycleInFlight = true
    try {
      const ids = Array.isArray(orgIds) && orgIds.length > 0 ? orgIds : await listOrgIdsFn()
      if (!ids || ids.length === 0) {
        console.warn('[MemoryConsolidation] no orgs to consolidate this cycle')
        return
      }

      const effectiveOrgConcurrency = resolveEffectiveOrgConcurrency()
      let succeeded = 0
      let failed = 0
      for (let i = 0; i < ids.length; i += effectiveOrgConcurrency) {
        const batch = ids.slice(i, i + effectiveOrgConcurrency)
        const batchResults = await Promise.all(batch.map(orgId => runFn({ orgId })))
        for (const r of batchResults) {
          if (r && r.error) failed += 1
          else succeeded += 1
        }
      }
      console.log(`[MemoryConsolidation] cycle complete: ${succeeded} org(s) ok, ${failed} org(s) failed, ${ids.length} org(s) total`)
    } finally {
      cycleInFlight = false
    }
  }

  schedulerTimeout = setTimeoutFn(() => {
    runAll()
    schedulerInterval = setIntervalFn(runAll, intervalMs)
    if (schedulerInterval && typeof schedulerInterval.unref === 'function') schedulerInterval.unref()
  }, delay)
  if (schedulerTimeout && typeof schedulerTimeout.unref === 'function') schedulerTimeout.unref()
}

function stopMemoryConsolidationScheduler() {
  if (schedulerTimeout) { clearTimeout(schedulerTimeout); schedulerTimeout = null }
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null }
  cycleInFlight = false
}

module.exports = {
  runMemoryConsolidation,
  computeDuplicates,
  jaccardSimilarity,
  msUntilNextHour,
  getIntervalMs,
  getTargetHourUtc,
  fetchLiveOrgIds,
  startMemoryConsolidationScheduler,
  stopMemoryConsolidationScheduler,
}
