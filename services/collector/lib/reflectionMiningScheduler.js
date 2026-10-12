/**
 * Reflection Mining Scheduler — TRUST-GATE-1.18f
 *
 * Before: the ONLY trigger for AEE conversation mining — extracting
 * memories/entities from completed conversations, detecting patterns
 * (repeated failures, host issues, anomalies), and generating proactive
 * alerts — was a browser setInterval in src/services/reflectionLoop.js,
 * started from src/App.jsx (CLARITY-1's <AuthGatedBackgroundServices>). A
 * zero-tolerance violation: browser timers are not background jobs, they
 * only run while a tab is open. (TRUST-GATE-1.11 already moved the
 * separate "consolidate knowledge" step server-side — see
 * memoryConsolidationScheduler.js — this covers the remaining mining
 * cycle: extractMemories / detectPatterns / generateAlerts.)
 *
 * After: this module runs the mining cycle server-side on an
 * env-configurable interval (REFLECTION_MINING_INTERVAL_MS, default 5m —
 * same default the browser loop used), reading AEE conversations/envelopes
 * via injectable query functions (production wiring in server.js queries
 * the collector's own aeeDb directly — the AEE store lives in this same
 * process, unlike the memory service) and writing extracted memories,
 * entities, and pattern-alerts to the memory service via
 * POST /api/memory using the internal-service-auth path (X-Service-Key +
 * X-Org-Id headers), the same contract memoryConsolidationScheduler.js
 * uses (TRUST-GATE-1.12a).
 *
 * The AEE envelopes table has no org_id column (single-tenant store today)
 * — same situation memoryConsolidationScheduler.js is in. `orgIds` is
 * accepted and forwarded as the X-Org-Id scoping header on every outbound
 * memory-service call.
 *
 * TRUST-GATE-1.24: `orgIds` defaulted to ['default'] with no live-org
 * enumeration, so only that one hardcoded org ever actually got AEE
 * conversation mining — every other tenant's conversations were silently
 * never mined. Fixed below, mirroring memoryConsolidationScheduler.js's
 * TRUST-GATE-1.23 fix: when no explicit `orgIds` are passed, the scheduler
 * enumerates the real live orgs via `fetchLiveOrgIds()`, which calls the
 * same auth-service internal endpoint (GET /api/internal/orgs/list,
 * services/auth/routes/internal-orgs.js) over the existing
 * INTERNAL_SERVICE_KEY / X-Service-Key service-to-service auth path, and
 * mines each org independently on every scheduled tick.
 *
 * TRUST-GATE-1.25 (live regression, 2026-07-03): on a real multi-tenant box
 * (50+ orgs) the 1.24 fix pinned the collector at 82% CPU and flooded the
 * alert store, because two gaps that were invisible with one hardcoded org
 * became catastrophic with fifty:
 *   1. Conversation dedup lived only in an in-memory Set — no durable
 *      per-org watermark, so a restart reprocessed everything, and every
 *      cycle still paid the full lookback-window query cost per org even
 *      when nothing was new.
 *   2. Proactive alerts had zero idempotency — the same repeated-failure /
 *      anomaly / host-health condition regenerated an identical alert
 *      every single tick, per org, forever.
 * Fixed via a small durable store (reflectionMiningWatermark.js): a
 * per-org high-water mark bounds each cycle's query to genuinely new
 * activity (cheap no-op otherwise), and an alert dedup fingerprint (org +
 * type + subject) stops re-emitting the same alert inside a dedup window.
 * `startReflectionMiningScheduler` also now caps orgs processed per tick
 * (`maxOrgsPerCycle`) so a single cycle can't unboundedly fan out across
 * every live org at once.
 */

const watermarkStore = require('./reflectionMiningWatermark.js')
const configResolver = require('./configResolver.js')

const MEMORY_URL = `http://${process.env.MEMORY_HOST || 'memory'}:${process.env.MEMORY_PORT || '3103'}`
const AUTH_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes — same default the browser loop used
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000 // 24 hours
const DEFAULT_IDLE_MS = 5 * 60 * 1000 // conversation must be idle 5m before mining
const DEFAULT_MAX_CONVERSATIONS_PER_CYCLE = 10
const DEFAULT_ALERT_THRESHOLDS = { repeatedFailureCount: 3, anomalyCount: 2, patternConfidence: 0.7 }
// TRUST-GATE-1.25: same alert condition won't re-fire more than once per window.
const DEFAULT_ALERT_DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000 // 6 hours
// TRUST-GATE-1.25: hard cap on orgs fanned out to per scheduler tick — a
// multi-tenant box with many more orgs than this catches up over
// subsequent ticks rather than launching unbounded concurrent work.
const DEFAULT_MAX_ORGS_PER_CYCLE = 25
// fleet #393: how many orgs are mined at once within a cycle. The cap above
// bounds work per TICK; this bounds it per MOMENT, which is what actually
// protects request latency on a single-threaded event loop. Deliberately
// small — mining has no deadline, API calls do.
const DEFAULT_ORG_CONCURRENCY = 3

// A 25-org cycle runs every org's postMemory()/fetchLiveOrgIds() call
// concurrently via Promise.all — the bare global `fetch` has no timeout, so
// a single slow/hung downstream call (memory service, auth service) blocks
// the ENTIRE cycle from ever completing, which means cycleInFlight never
// releases and the scheduler effectively wedges (found live 2026-08-11:
// sustained ~100% CPU, docker healthcheck flipped unhealthy, persisted
// across a container restart because the very next scheduled/immediate
// tick hit the same unbounded-wait shape again). Every fetchFn default in
// this file must route through this wrapper, not bare `fetch`.
const FETCH_TIMEOUT_MS = 15000
function fetchWithTimeout(url, opts = {}) {
  return fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(FETCH_TIMEOUT_MS) })
}

// Same AEE intent strings as src/lib/aee/intents.js — duplicated here (not
// imported) so this module has no dependency on frontend-only source,
// mirroring memoryConsolidationScheduler.js's ported jaccardSimilarity().
const CHAT_QUERY_INTENT = 'quox.chat.query'
const JOB_SUBMIT_INTENT = 'quoxagent.job.submit'
const APPROVAL_REQUEST_INTENT = 'ops.approval.request'
const APPROVAL_GRANT_INTENT = 'ops.approval.grant'
const HEARTBEAT_INTENT = 'quoxagent.heartbeat.report'

// fleet #393: env-overridable so this can be tuned on a box without a code
// change, same shape as getIntervalMs() above it.
//
// VAULT-INTEG P13 slice 2: was a bare process.env read — now resolved
// through configResolver.getInstanceSetting() (platformCapabilities.js
// REFLECTION_MINING_ORG_CONCURRENCY) so a stored instance-wide override can
// win over env. Called fresh from inside runAll() on every tick (see
// startReflectionMiningScheduler below — it is no longer captured once via
// a default param at scheduler start), so a change to the stored/env value
// applies from the very next tick — no restart needed, unlike
// getIntervalMs() below (whose value only takes effect where the
// scheduler's own timer is created).
function resolveOrgConcurrency() {
  const raw = configResolver.getInstanceSetting('REFLECTION_MINING_ORG_CONCURRENCY').value
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ORG_CONCURRENCY
}

// VAULT-INTEG P13 slice 2: was a bare process.env read — now resolved
// through configResolver.getInstanceSetting() (platformCapabilities.js
// REFLECTION_MINING_INTERVAL_MS), still called once when the scheduler
// starts (see startReflectionMiningScheduler below) — an override is
// stored/audited immediately but only takes effect from the next collector
// restart, since the setInterval this value seeds cannot change cadence
// without being recreated (registry entry: requiresRestart: true).
function getIntervalMs() {
  const raw = configResolver.getInstanceSetting('REFLECTION_MINING_INTERVAL_MS').value
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS
}

function summarize(text, maxLength) {
  if (!text) return ''
  const str = String(text)
  if (str.length <= maxLength) return str
  return str.substring(0, maxLength - 3) + '...'
}

// ============================================================================
// Entity extraction — ported from src/services/aeeMemoryBridge.js
// extractEntitiesFromEnvelopes()
// ============================================================================

const HOST_PATTERN = /\b(docker\d+|proxmox\d+|kuma\d*|nas\d+|truenas\d*|grafana\d*|prometheus\d*|pihole\d*|pfsense\d*|access\d+)\b/gi
const IP_PATTERN = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g
const SERVICE_PATTERN = /\b(nginx|redis|postgres|mysql|mongodb|elasticsearch|n8n|grafana|prometheus)\b/gi

function extractEntitiesFromEnvelopes(envelopes = []) {
  const entities = new Map()

  for (const envelope of envelopes) {
    const textContent = JSON.stringify(envelope.payload || {})

    const hosts = textContent.match(HOST_PATTERN) || []
    for (const host of hosts) {
      const key = `host:${host.toLowerCase()}`
      if (!entities.has(key)) entities.set(key, { type: 'host', name: host.toLowerCase() })
    }

    const ips = textContent.match(IP_PATTERN) || []
    for (const ip of ips) {
      const key = `ip:${ip}`
      if (!entities.has(key)) entities.set(key, { type: 'ip_address', name: ip })
    }

    const services = textContent.match(SERVICE_PATTERN) || []
    for (const service of services) {
      const key = `service:${service.toLowerCase()}`
      if (!entities.has(key)) entities.set(key, { type: 'service', name: service.toLowerCase() })
    }

    if (envelope.from && envelope.from.startsWith('quoxagent.')) {
      const host = envelope.from.replace('quoxagent.', '')
      const key = `host:${host}`
      if (!entities.has(key)) entities.set(key, { type: 'host', name: host })
    }
  }

  return Array.from(entities.values())
}

// ============================================================================
// Memory extraction — ported from src/services/aeeMemoryBridge.js
// extractMemoriesFromConversation()
// ============================================================================

/**
 * Extract learnable memories + entities from one conversation's envelopes.
 * Pure function — no I/O. Returns memory-service-ready payloads
 * ({ memory_type, content, tags }), mapped onto the canonical memory types
 * (fact, observation, decision, entity) since this module cannot modify
 * services/memory's schema/validation.
 */
function extractMemoriesFromEnvelopes(envelopes = [], corr) {
  const memories = []
  const entityNames = new Set()

  const tasks = envelopes.filter(e => e.type === 'task')
  const results = envelopes.filter(e => e.type === 'result')

  for (const task of tasks) {
    if (task.intent === CHAT_QUERY_INTENT) {
      const result = results.find(r => r.reply_to === task.id)
      if (result && result.payload?.text) {
        memories.push({
          memory_type: 'fact',
          content: `Q: ${summarize(task.payload?.text, 200)} — A: ${summarize(result.payload.text, 500)}`,
          tags: ['conversation_qa', `corr:${corr}`],
        })
      }
    }

    if (task.intent === JOB_SUBMIT_INTENT) {
      const result = results.find(r => r.reply_to === task.id)
      const host = task.to?.replace('quoxagent.', '')
      memories.push({
        memory_type: 'observation',
        content: `${host || 'unknown host'}: ran "${task.payload?.command || ''}" — ${result?.payload?.exit_code === 0 ? 'succeeded' : 'failed'}${result?.payload?.output ? ` (${summarize(result.payload.output, 200)})` : ''}`,
        tags: ['operation', `corr:${corr}`, ...(host ? [`host:${host}`] : [])],
      })
      if (host) entityNames.add(host)
    }

    if (task.intent === APPROVAL_REQUEST_INTENT) {
      const result = results.find(r => r.reply_to === task.id)
      const granted = result?.intent === APPROVAL_GRANT_INTENT
      memories.push({
        memory_type: 'decision',
        content: `${granted ? 'Approved' : 'Denied'}: ${task.payload?.operation || 'operation'} (${task.payload?.risk_level || 'unknown'} risk) — ${task.payload?.reason || ''}`,
        tags: ['approval', `corr:${corr}`],
      })
    }
  }

  const entities = extractEntitiesFromEnvelopes(envelopes).map(e => ({
    memory_type: 'entity',
    content: `${e.type}: ${e.name}`,
    tags: ['entity', e.type, `corr:${corr}`],
  }))

  return { memories, entities }
}

// ============================================================================
// Pattern detection — ported from src/services/aeeAnalytics.js detectPatterns()
// ============================================================================

const SENSITIVITY_THRESHOLDS = {
  low: { failure_count: 5 },
  medium: { failure_count: 3 },
  high: { failure_count: 2 },
}

function detectPatterns(envelopes = [], { startTime, sensitivity = 'medium' } = {}) {
  const patterns = { repeated_failures: [], time_correlations: [], host_patterns: [], anomalies: [] }

  if (envelopes.length < 10) return patterns

  const thresholds = SENSITIVITY_THRESHOLDS[sensitivity] || SENSITIVITY_THRESHOLDS.medium
  const now = new Date()

  // 1. Repeated failures (same intent+target)
  const errorsByIntent = {}
  for (const env of envelopes.filter(e => e.type === 'error')) {
    const key = `${env.intent}:${env.to}`
    if (!errorsByIntent[key]) errorsByIntent[key] = { count: 0, examples: [] }
    errorsByIntent[key].count++
    if (errorsByIntent[key].examples.length < 3) {
      errorsByIntent[key].examples.push({ id: env.id, ts: env.ts, message: env.payload?.message?.substring(0, 100) })
    }
  }
  for (const [key, data] of Object.entries(errorsByIntent)) {
    if (data.count >= thresholds.failure_count) {
      const [intent, target] = key.split(':')
      patterns.repeated_failures.push({
        intent, target, count: data.count, examples: data.examples,
        severity: data.count >= 5 ? 'high' : 'medium',
      })
    }
  }

  // 2. Time correlations — errors clustered at certain hours
  const errorsByHour = Array(24).fill(0)
  for (const env of envelopes.filter(e => e.type === 'error')) {
    errorsByHour[new Date(env.ts).getHours()]++
  }
  const avgErrorsPerHour = errorsByHour.reduce((a, b) => a + b, 0) / 24
  for (let hour = 0; hour < 24; hour++) {
    if (errorsByHour[hour] > avgErrorsPerHour * 2 && errorsByHour[hour] > 0) {
      patterns.time_correlations.push({
        hour, error_count: errorsByHour[hour], avg: Math.round(avgErrorsPerHour),
        suggestion: `Errors spike at ${hour}:00 - investigate scheduled tasks`,
      })
    }
  }

  // 3. Host patterns — hosts that frequently appear in errors
  const hostErrorCounts = {}
  for (const env of envelopes.filter(e => e.type === 'error')) {
    const host = env.from?.replace('quoxagent.', '') || env.to?.replace('quoxagent.', '')
    if (host && !host.startsWith('human.') && !host.startsWith('agent.')) {
      hostErrorCounts[host] = (hostErrorCounts[host] || 0) + 1
    }
  }
  for (const [host, count] of Object.entries(hostErrorCounts)) {
    if (count >= thresholds.failure_count) {
      patterns.host_patterns.push({ host, error_count: count, severity: count >= 5 ? 'high' : 'medium', suggestion: `Host ${host} has elevated error rate` })
    }
  }

  // 4. Anomalies — activity spike + heartbeat silence
  const defaultStart = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString()
  const recentEnvelopes = envelopes.filter(e => e.ts > oneHourAgo)
  const olderEnvelopes = envelopes.filter(e => e.ts <= oneHourAgo)

  const recentRate = recentEnvelopes.length
  const baselineRate = olderEnvelopes.length / Math.max(1, (new Date(oneHourAgo) - new Date(startTime || defaultStart)) / (60 * 60 * 1000))

  if (recentRate > baselineRate * 3 && recentRate > 0) {
    patterns.anomalies.push({ type: 'activity_spike', description: 'Unusual activity spike in last hour', recent_count: recentRate, baseline_hourly: Math.round(baselineRate), severity: 'medium' })
  }

  const recentHeartbeats = recentEnvelopes.filter(e => e.intent === HEARTBEAT_INTENT)
  if (recentHeartbeats.length === 0 && envelopes.some(e => e.intent === HEARTBEAT_INTENT)) {
    patterns.anomalies.push({ type: 'heartbeat_silence', description: 'No QuoxAgent heartbeats in last hour', severity: 'high' })
  }

  return patterns
}

// ============================================================================
// Proactive alerts — ported from src/services/reflectionLoop.js
// generateProactiveAlerts()
// ============================================================================

function generateProactiveAlerts(patterns = {}, alertThresholds = DEFAULT_ALERT_THRESHOLDS) {
  const alerts = []
  const thresholds = { ...DEFAULT_ALERT_THRESHOLDS, ...alertThresholds }

  for (const failure of patterns.repeated_failures || []) {
    if (failure.count >= thresholds.repeatedFailureCount) {
      alerts.push({
        type: 'repeated_failure', severity: failure.severity,
        message: `Repeated failures for ${failure.intent} to ${failure.target}`,
        data: failure, suggestion: `Consider investigating root cause of ${failure.intent} failures`,
      })
    }
  }

  for (const anomaly of patterns.anomalies || []) {
    alerts.push({ type: 'anomaly', severity: anomaly.severity, message: anomaly.description, data: anomaly })
  }

  for (const hostPattern of patterns.host_patterns || []) {
    if (hostPattern.error_count >= thresholds.repeatedFailureCount) {
      alerts.push({
        type: 'host_health', severity: hostPattern.severity,
        message: `Host ${hostPattern.host} has elevated error rate`,
        data: hostPattern, suggestion: `Check health of ${hostPattern.host}`,
      })
    }
  }

  return alerts
}

/**
 * TRUST-GATE-1.25: stable dedup fingerprint for an alert — org + type +
 * subject (the thing the alert is about, not the transient count/severity
 * that legitimately fluctuates cycle to cycle). Two alerts about the same
 * underlying condition produce the same key, letting the caller skip
 * re-emitting a memory-service write for a condition already reported
 * within the dedup window.
 */
function buildAlertDedupKey(orgId, alert) {
  let subject = ''
  if (alert.type === 'repeated_failure') subject = `${alert.data?.intent || ''}:${alert.data?.target || ''}`
  else if (alert.type === 'host_health') subject = alert.data?.host || ''
  else if (alert.type === 'anomaly') subject = alert.data?.type || ''
  else subject = alert.message || ''
  return `${orgId}::${alert.type}::${subject}`
}

// ============================================================================
// Memory service write path — same contract as memoryConsolidationScheduler.js
// ============================================================================

async function postMemory({ orgId, memory, fetchFn }) {
  try {
    const res = await fetchFn(`${MEMORY_URL}/api/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, 'X-Org-Id': orgId },
      body: JSON.stringify(memory),
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      console.error(`[ReflectionMining] org=${orgId}: memory write failed HTTP ${res.status} — ${bodyText.slice(0, 300) || '(empty body)'}`)
      return { error: `HTTP ${res.status}` }
    }
    return await res.json()
  } catch (err) {
    console.error(`[ReflectionMining] org=${orgId}: memory write failed — ${err.message}`)
    return { error: err.message }
  }
}

// ============================================================================
// Cycle orchestration
// ============================================================================

// TRUST-GATE-1.25: default injectable wrappers around the durable watermark
// store, so production wiring gets durable per-org state for free (no
// server.js changes needed) while tests can override with plain fakes.
async function defaultGetWatermarkFn(orgId) {
  return watermarkStore.getWatermark(orgId)
}
async function defaultSetWatermarkFn(orgId, ts) {
  return watermarkStore.setWatermark(orgId, ts)
}
async function defaultAlertAlreadySentFn(dedupKey, { withinMs } = {}) {
  return watermarkStore.alertAlreadySent(dedupKey, { withinMs })
}
async function defaultRecordAlertSentFn(dedupKey, orgId) {
  return watermarkStore.recordAlertSent(dedupKey, orgId)
}

/**
 * Run one mining cycle for an org. Never throws — this is a background job
 * — but every failure path is logged loudly, never silently swallowed.
 */
async function runReflectionMining({
  orgId = 'default',
  fetchFn = fetchWithTimeout,
  listIdleConversationsFn,
  getConversationEnvelopesFn,
  queryRecentEnvelopesFn,
  lookbackMs = DEFAULT_LOOKBACK_MS,
  idleMs = DEFAULT_IDLE_MS,
  maxConversationsPerCycle = DEFAULT_MAX_CONVERSATIONS_PER_CYCLE,
  alertThresholds = DEFAULT_ALERT_THRESHOLDS,
  alertDedupWindowMs = DEFAULT_ALERT_DEDUP_WINDOW_MS,
  processedConversations = new Set(),
  getWatermarkFn = defaultGetWatermarkFn,
  setWatermarkFn = defaultSetWatermarkFn,
  alertAlreadySentFn = defaultAlertAlreadySentFn,
  recordAlertSentFn = defaultRecordAlertSentFn,
} = {}) {
  const results = { orgId, conversationsProcessed: 0, conversationsFailed: 0, memoriesExtracted: 0, patternsDetected: 0, alertsGenerated: 0, alertsSkippedDuplicate: 0, errors: [] }

  const now = Date.now()
  const lookbackCutoff = new Date(now - lookbackMs).toISOString()
  const idleCutoff = new Date(now - idleMs).toISOString()

  // TRUST-GATE-1.25: durable per-org watermark — only look for conversations
  // newer than the last one this org actually mined, so a cycle with
  // nothing new is a cheap no-op instead of re-querying + re-filtering the
  // full lookback window every 5 minutes forever.
  let storedWatermark = null
  try {
    storedWatermark = await getWatermarkFn(orgId)
  } catch (err) {
    console.error(`[ReflectionMining] org=${orgId}: watermark read failed, falling back to full lookback — ${err.message}`)
  }
  const effectiveAfter = storedWatermark && storedWatermark > lookbackCutoff ? storedWatermark : lookbackCutoff

  // 1. OBSERVE + 2. ANALYZE/LEARN: mine idle, unprocessed conversations
  try {
    const conversations = await listIdleConversationsFn({ orgId, after: effectiveAfter })
    const idle = (conversations || [])
      .filter(c => !processedConversations.has(c.corr) && c.lastTs <= idleCutoff && (!storedWatermark || c.lastTs > storedWatermark))
      .sort((a, b) => (a.lastTs < b.lastTs ? -1 : a.lastTs > b.lastTs ? 1 : 0))

    if (idle.length === 0) {
      console.debug(`[ReflectionMining] org=${orgId}: no new conversations since watermark — skipping`)
    }

    let newWatermark = storedWatermark || null

    for (const conv of idle.slice(0, maxConversationsPerCycle)) {
      try {
        const envelopes = await getConversationEnvelopesFn({ orgId, corr: conv.corr })
        const { memories, entities } = extractMemoriesFromEnvelopes(envelopes || [], conv.corr)
        const toWrite = [...memories, ...entities]

        let writeFailures = 0
        for (const memory of toWrite) {
          const written = await postMemory({ orgId, memory, fetchFn })
          if (written?.error) {
            writeFailures++
            results.errors.push({ phase: 'extract', corr: conv.corr, error: written.error })
          } else {
            results.memoriesExtracted++
          }
        }

        // INFRA-CPU (2026-08-30 CPU incident): a conversation that had real
        // content to write but couldn't persist ANY of it (memory-service
        // down/provider error) is a FAILURE, distinct from a conversation
        // that genuinely had nothing extractable (toWrite.length === 0, no
        // error possible). Conflating the two previously made a downed
        // write path indistinguishable from an idle/heartbeat-only
        // conversation in the tick log, AND retired the conversation
        // regardless — silently dropping its memories forever. A total
        // failure is left un-retired (not added to processedConversations,
        // watermark untouched) so it's retried once the write path
        // recovers, same contract as an outright extraction throw below.
        const totalFailure = toWrite.length > 0 && writeFailures === toWrite.length
        if (totalFailure) {
          results.conversationsFailed++
        } else {
          results.conversationsProcessed++
          processedConversations.add(conv.corr)
          if (conv.lastTs && (!newWatermark || conv.lastTs > newWatermark)) newWatermark = conv.lastTs
        }
      } catch (err) {
        results.conversationsFailed++
        results.errors.push({ phase: 'extract', corr: conv.corr, error: err.message })
        console.error(`[ReflectionMining] org=${orgId}: extraction failed for ${conv.corr} — ${err.message}`)
      }
    }

    if (newWatermark && newWatermark !== storedWatermark) {
      try {
        await setWatermarkFn(orgId, newWatermark)
      } catch (err) {
        console.error(`[ReflectionMining] org=${orgId}: watermark write failed — ${err.message}`)
      }
    }
  } catch (err) {
    results.errors.push({ phase: 'observe', error: err.message })
    console.error(`[ReflectionMining] org=${orgId}: failed to list idle conversations — ${err.message}`)
  }

  // 3. ANALYZE: detect patterns + 4. ACT: generate + persist proactive alerts
  try {
    const recentEnvelopes = await queryRecentEnvelopesFn({ orgId, after: lookbackCutoff })
    const patterns = detectPatterns(recentEnvelopes || [], { startTime: lookbackCutoff })
    results.patternsDetected = patterns.repeated_failures.length + patterns.time_correlations.length + patterns.host_patterns.length + patterns.anomalies.length

    const alerts = generateProactiveAlerts(patterns, alertThresholds)

    for (const alert of alerts) {
      const dedupKey = buildAlertDedupKey(orgId, alert)
      let alreadySent = false
      try {
        alreadySent = await alertAlreadySentFn(dedupKey, { withinMs: alertDedupWindowMs })
      } catch (err) {
        console.error(`[ReflectionMining] org=${orgId}: alert dedup check failed for ${dedupKey}, emitting anyway — ${err.message}`)
      }

      if (alreadySent) {
        results.alertsSkippedDuplicate++
        continue
      }

      const written = await postMemory({
        orgId,
        memory: { memory_type: 'observation', content: `[${alert.type}] ${alert.message}`, tags: ['pattern-alert', alert.type, alert.severity] },
        fetchFn,
      })
      if (written?.error) {
        results.errors.push({ phase: 'alerts', error: written.error })
      } else {
        results.alertsGenerated++
        try {
          await recordAlertSentFn(dedupKey, orgId)
        } catch (err) {
          console.error(`[ReflectionMining] org=${orgId}: failed to record alert dedup for ${dedupKey} — ${err.message}`)
        }
      }
    }
  } catch (err) {
    results.errors.push({ phase: 'patterns', error: err.message })
    console.error(`[ReflectionMining] org=${orgId}: pattern detection failed — ${err.message}`)
  }

  // INFRA-CPU (2026-08-30 CPU incident): conversationsFailed is a distinct,
  // never-silent signal — a downed memory-service write or a thrown
  // extraction call must never read the same as "nothing to mine" (a
  // console.debug-level no-op). Any failed conversation forces console.warn
  // regardless of what else happened this tick.
  const isNoop = results.conversationsProcessed === 0 && results.alertsGenerated === 0 && results.conversationsFailed === 0 && results.errors.length === 0
  const logFn = results.conversationsFailed > 0 ? console.warn : (isNoop ? console.debug : console.log)
  const failedSuffix = results.conversationsFailed ? `, ${results.conversationsFailed} failed` : ''
  logFn(`[ReflectionMining] org=${orgId}: processed ${results.conversationsProcessed} conversation(s), extracted ${results.memoriesExtracted} memor(y/ies), ${results.alertsGenerated} alert(s)${failedSuffix}${results.alertsSkippedDuplicate ? ` (${results.alertsSkippedDuplicate} duplicate alert(s) suppressed)` : ''}`)

  return results
}

/**
 * Enumerate the real live orgs to mine, via the auth service's internal
 * orgs endpoint (service-to-service auth: X-Service-Key). Same contract as
 * memoryConsolidationScheduler.js's fetchLiveOrgIds(). Never throws — this
 * feeds a background scheduler — but every failure is logged loudly rather
 * than silently swallowed. Returns [] on any failure, which callers must
 * treat as "nothing to mine this cycle" rather than falling back to a
 * hardcoded org.
 */
async function fetchLiveOrgIds({ fetchFn = fetchWithTimeout } = {}) {
  try {
    const res = await fetchFn(`${AUTH_URL}/api/internal/orgs/list`, {
      headers: { 'X-Service-Key': SERVICE_KEY },
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      console.error(`[ReflectionMining] failed to enumerate live orgs — HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`)
      return []
    }
    const data = await res.json()
    const orgIds = Array.isArray(data.orgIds) ? data.orgIds : []
    if (orgIds.length === 0) {
      console.warn('[ReflectionMining] live org enumeration returned zero orgs — no mining will run this cycle')
    }
    return orgIds
  } catch (err) {
    console.error(`[ReflectionMining] failed to enumerate live orgs — ${err.message}`)
    return []
  }
}

// ============================================================================
// Scheduler lifecycle
// ============================================================================

let schedulerInterval = null
let cycleInFlight = false
let cycleRoundRobinOffset = 0

// TRUST-GATE-1.25: conversation dedup must be scoped PER-ORG, not a single
// Set shared across every org. A shared Set meant whichever org happened to
// iterate first "claimed" a conversation and every other org silently never
// got it mined (or its own memory-service write) at all — invisible with
// the single hardcoded 'default' org TRUST-GATE-1.24 replaced, real with 50+.
const perOrgProcessedConversations = new Map()
function defaultGetProcessedConversationsForOrg(orgId) {
  if (!perOrgProcessedConversations.has(orgId)) perOrgProcessedConversations.set(orgId, new Set())
  return perOrgProcessedConversations.get(orgId)
}

/**
 * Start the server-side reflection mining scheduler. Runs immediately, then
 * on the configured interval (default 5m). Overlap-safe: a scheduled tick
 * that fires while the previous cycle is still running is skipped (logged),
 * matching the original browser loop's "set isRunning first" race-guard
 * intent (reflectionLoop.js Issue 1.7) but for a real concurrent scheduler.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.orgIds] - explicit orgs to mine each tick. If
 *   omitted (the default), the scheduler enumerates the real live orgs via
 *   `listOrgIdsFn` on every tick instead of hardcoding a single org
 *   (TRUST-GATE-1.24).
 * @param {function} [opts.listOrgIdsFn] - injectable for tests (defaults to fetchLiveOrgIds)
 * @param {number} [opts.maxOrgsPerCycle] - TRUST-GATE-1.25: hard cap on orgs
 *   fanned out to per tick. When live enumeration returns more orgs than
 *   this, the scheduler round-robins across ticks so every org still gets
 *   mined eventually, instead of unboundedly launching work for every org
 *   at once every 5 minutes.
 * @param {function} [opts.getProcessedConversationsForOrg] - injectable for
 *   tests (defaults to a per-org Set keyed off a module-level Map).
 * @param {number} [opts.orgConcurrency] - bounded fan-out width. An explicit
 *   value here always wins (tests). Omitted (the default), it is resolved
 *   fresh via resolveOrgConcurrency() on every tick — VAULT-INTEG P13 slice
 *   2 — rather than once here, so a stored/env
 *   REFLECTION_MINING_ORG_CONCURRENCY override applies from the very next
 *   tick, not just the next scheduler restart.
 */
function startReflectionMiningScheduler({
  orgIds = null,
  listOrgIdsFn = fetchLiveOrgIds,
  intervalMs = getIntervalMs(),
  maxOrgsPerCycle = DEFAULT_MAX_ORGS_PER_CYCLE,
  orgConcurrency,
  setIntervalFn = setInterval,
  runFn = runReflectionMining,
  listIdleConversationsFn,
  getConversationEnvelopesFn,
  queryRecentEnvelopesFn,
  fetchFn,
  getProcessedConversationsForOrg = defaultGetProcessedConversationsForOrg,
  // quox#508: per-org enable flag resolver (REFLECTION_MINING_ENABLED,
  // settings-surfaced). Fails OPEN on error — mining is a feature, not a
  // safety gate, and an unreadable settings store must not silently kill
  // it. Null (no resolver wired) means always enabled, preserving the
  // pre-flag behavior for tests and minimal deployments.
  isMiningEnabledFn = null,
} = {}) {
  if (schedulerInterval) return // already started

  // INFRA-CPU (2026-08-30 CPU incident): live evidence showed every tick
  // logging "processed 10 conversation(s), extracted 0 memor(y/ies)" per
  // org, forever — mining has no deadline, so a tick that achieves nothing
  // real (no memories extracted, no alerts generated, across every org)
  // should back off rather than spin at the configured cadence, and an org
  // whose conversations just failed to extract/write should not be hammered
  // again on the very next tick. Mirrors 8e1a0958's EmbedBackfill fix: both
  // backoffs are capped so the effective gap between real attempts never
  // exceeds MAX_BACKOFF_MS regardless of how small intervalMs is configured.
  const MAX_BACKOFF_MS = 15 * 60 * 1000
  const backoffTicksCap = Math.max(1, Math.round(MAX_BACKOFF_MS / intervalMs))
  // VAULT-INTEG P13 slice 2: an explicit orgConcurrency (tests) always
  // wins; otherwise resolved fresh on every tick from inside runAll() below.
  const resolveEffectiveOrgConcurrency = () =>
    Number.isFinite(orgConcurrency) && orgConcurrency > 0 ? orgConcurrency : resolveOrgConcurrency()
  let consecutiveStalledTicks = 0
  let backoffTicksRemaining = 0
  const orgFailureStreak = new Map()
  const orgCooldownTicks = new Map()

  const runAll = async () => {
    if (cycleInFlight) {
      console.warn('[ReflectionMining] previous cycle still running — skipping this tick')
      return
    }
    if (backoffTicksRemaining > 0) {
      backoffTicksRemaining -= 1
      console.log(`[ReflectionMining] tick skipped: backing off after ${consecutiveStalledTicks} consecutive zero-progress tick(s), ${backoffTicksRemaining} tick(s) of backoff remaining`)
      return
    }
    cycleInFlight = true
    try {
      let ids = Array.isArray(orgIds) && orgIds.length > 0 ? orgIds : await listOrgIdsFn({ fetchFn })
      if (!ids || ids.length === 0) {
        console.warn('[ReflectionMining] no orgs to mine this cycle')
        consecutiveStalledTicks = 0
        return
      }

      // quox#508: per-org REFLECTION_MINING_ENABLED check, BEFORE bounding
      // and round-robin so disabled orgs never consume cycle slots. A
      // fully-disabled instance ticks as a free no-op that neither arms
      // backoff nor counts as a stall — re-enabling takes effect on the
      // very next tick.
      if (typeof isMiningEnabledFn === 'function') {
        const enabledFlags = await Promise.all(ids.map(async (orgId) => {
          try {
            return (await isMiningEnabledFn(orgId)) !== false
          } catch (err) {
            console.warn(`[ReflectionMining] org=${orgId}: enable-flag check failed (${err.message}) — failing OPEN`)
            return true
          }
        }))
        const skipped = ids.filter((_, i) => !enabledFlags[i]).length
        ids = ids.filter((_, i) => enabledFlags[i])
        if (skipped > 0) console.log(`[ReflectionMining] ${skipped} org(s) skipped: REFLECTION_MINING_ENABLED is off for them`)
        if (ids.length === 0) {
          console.log('[ReflectionMining] mining disabled for every live org — tick is a no-op')
          consecutiveStalledTicks = 0
          return
        }
      }

      let boundedIds = ids
      if (ids.length > maxOrgsPerCycle) {
        const start = cycleRoundRobinOffset % ids.length
        boundedIds = []
        for (let i = 0; i < maxOrgsPerCycle; i++) boundedIds.push(ids[(start + i) % ids.length])
        cycleRoundRobinOffset = (start + maxOrgsPerCycle) % ids.length
        console.warn(`[ReflectionMining] ${ids.length} live orgs but capped at ${maxOrgsPerCycle} per cycle — round-robining, ${ids.length - maxOrgsPerCycle} deferred to later ticks`)
      }

      // fleet #393: this used to be `Promise.all(boundedIds.map(...))` — all
      // 25 orgs mined CONCURRENTLY. On a box with 111 orgs that pinned the
      // collector's single event loop at ~102% CPU for the length of a tick,
      // and since every dashboard call goes through the collector, every
      // screen stalled with it. Measured on .126: a /health route that
      // returns a constant took 7.5s, 9.2s, 10.3s and repeatedly >20s during
      // a tick, then 5ms between ticks. QuoxPlan felt worst because it
      // proxies through the collector (:3107 itself answered in 4.8ms).
      //
      // Mining is background work with no deadline, so it should yield to
      // request traffic rather than compete with it. Now runs a small number
      // of orgs at a time and gives the event loop air between batches: the
      // same work completes within the cycle, but as a low ripple instead of
      // a wall.
      let totalMemoriesExtracted = 0
      let totalAlertsGenerated = 0

      // VAULT-INTEG P13 slice 2: resolved fresh on THIS tick, not captured
      // once at scheduler start — see resolveEffectiveOrgConcurrency() above.
      const orgConcurrency = resolveEffectiveOrgConcurrency()

      for (let i = 0; i < boundedIds.length; i += orgConcurrency) {
        // Per-org cooldown: an org whose mining just failed outright is not
        // worth retrying immediately — skip it until its cooldown expires,
        // same shape as EmbedBackfill's per-org backoff (8e1a0958).
        const batch = boundedIds.slice(i, i + orgConcurrency).filter(orgId => {
          const cooldown = orgCooldownTicks.get(orgId) || 0
          if (cooldown > 0) {
            orgCooldownTicks.set(orgId, cooldown - 1)
            console.log(`[ReflectionMining] org=${orgId}: skipped, ${cooldown - 1} cooldown tick(s) remaining`)
            return false
          }
          return true
        })

        const batchResults = await Promise.all(batch.map(orgId => runFn({
          orgId, fetchFn, listIdleConversationsFn, getConversationEnvelopesFn, queryRecentEnvelopesFn,
          processedConversations: getProcessedConversationsForOrg(orgId),
        })))

        batch.forEach((orgId, idx) => {
          const r = batchResults[idx] || {}
          totalMemoriesExtracted += r.memoriesExtracted || 0
          totalAlertsGenerated += r.alertsGenerated || 0

          if ((r.conversationsFailed || 0) > 0) {
            const streak = (orgFailureStreak.get(orgId) || 0) + 1
            orgFailureStreak.set(orgId, streak)
            const cooldownTicks = Math.min(streak, backoffTicksCap)
            orgCooldownTicks.set(orgId, cooldownTicks)
            console.warn(`[ReflectionMining] org=${orgId}: ${r.conversationsFailed} conversation(s) failed (streak ${streak}), backing off ${cooldownTicks} tick(s)`)
          } else {
            orgFailureStreak.delete(orgId)
            orgCooldownTicks.delete(orgId)
          }
        })

        // Hand the loop back so queued HTTP requests get served between
        // batches. setImmediate yields a full macrotask turn, which a
        // resolved promise (microtask) would not.
        if (i + orgConcurrency < boundedIds.length) {
          await new Promise(resolve => setImmediate(resolve))
        }
      }

      // Whole-tick zero-progress backoff: real progress (a memory actually
      // extracted, or an alert actually generated) resets the counter; a
      // tick that achieved neither, across every org mined this cycle,
      // grows it — capped so the real gap between attempts never exceeds
      // MAX_BACKOFF_MS.
      const madeProgress = totalMemoriesExtracted > 0 || totalAlertsGenerated > 0
      if (madeProgress) {
        consecutiveStalledTicks = 0
      } else {
        consecutiveStalledTicks += 1
        backoffTicksRemaining = Math.min(consecutiveStalledTicks, backoffTicksCap)
      }
    } finally {
      cycleInFlight = false
    }
  }

  const orgLabel = Array.isArray(orgIds) && orgIds.length > 0 ? `for org(s): ${orgIds.join(', ')}` : '(live org enumeration each cycle)'
  console.log(`[ReflectionMining] scheduled every ${Math.round(intervalMs / 60000)}m ${orgLabel}, max ${maxOrgsPerCycle} org(s)/cycle`)

  runAll()
  schedulerInterval = setIntervalFn(runAll, intervalMs)
  if (schedulerInterval && typeof schedulerInterval.unref === 'function') schedulerInterval.unref()
}

function stopReflectionMiningScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
  }
  cycleInFlight = false
}

module.exports = {
  extractEntitiesFromEnvelopes,
  extractMemoriesFromEnvelopes,
  detectPatterns,
  generateProactiveAlerts,
  runReflectionMining,
  getIntervalMs,
  fetchLiveOrgIds,
  startReflectionMiningScheduler,
  stopReflectionMiningScheduler,
  fetchWithTimeout,
  FETCH_TIMEOUT_MS,
}
