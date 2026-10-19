/**
 * fleetLoopSpawner.js — DEVSUITE-DEVMODE fleet spawn seam, tasks half:
 * the REAL implementation of loopDispatch.js's loopSpawner seam.
 *
 *   tasks (this) → collector POST /api/v1/dev-sessions/spawn
 *                → Bastion ssh → quoxagent /api/v1/dev/invoke
 *                → dev.sessions.structured-start (signed, profile-gated)
 *   events: agent EventForwarder → collector store
 *                → GET /api/v1/dev-sessions/:id/events?since_seq= (polled here)
 *
 * Design decisions (QuoxPlan DEVSUITE-DEVMODE #2665): the read side is a
 * since_seq poll, not SSE — resumable by construction, bounded reads, and
 * loop turns arrive seconds apart so poll latency is immaterial.
 *
 * Host selection: the first registered dev server advertising an ENABLED
 * dev.sessions capability (org-scoped list). No dev server → throw loud;
 * a loop objective with nowhere to run must fail visibly, never sit
 * phantom-running (same posture the old NOT-WIRED default had).
 */

import { getLoopProvider } from './loopProviders.js'
import { canExecuteResource, recordResourceFailure, recordResourceSuccess, CircuitBreakerOpenError } from './resourceBreaker.js'

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://collector:9848'
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''
const POLL_INTERVAL_MS = 2000

function authHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...(INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {}),
    ...extra,
  }
}

/**
 * Pick the dev server that can host a structured loop session. Not
 * individually breaker-gated — see the QM-7 comment on
 * createFleetLoopSpawner below for why the breaker wraps the whole spawn
 * operation (this lookup + the spawn POST) as one unit instead.
 */
async function resolveDevServer(fetchFn, orgId) {
  // ORG-SCOPE (2026-08-15): the collector filters on ?org_id= (the X-Org-Id
  // header was never read by that route). Without this, the first org to
  // enroll an alphabetically-early host captured every org's loop spawns.
  const resp = await fetchFn(`${COLLECTOR_URL}/api/v1/dev-servers?org_id=${encodeURIComponent(orgId)}`, {
    headers: authHeaders({ 'X-Org-Id': orgId }),
    signal: AbortSignal.timeout(10000),
  })
  if (!resp.ok) {
    throw new Error(`fleetLoopSpawner: dev-servers lookup returned ${resp.status}`)
  }
  const data = await resp.json()
  const servers = Array.isArray(data) ? data : (data.dev_servers || data.servers || [])
  const eligible = servers.find(s =>
    Array.isArray(s.enabled_capabilities) && s.enabled_capabilities.includes('dev.sessions'))
  if (!eligible) {
    // QLoop moved into QuoxCORE on 2026-08-19, so this error is now the first
    // thing a CORE customer meets when they start a loop — not a dev-suite
    // operator who knows what a capability profile is. Say the actual state
    // plainly, including the part that is our shortfall rather than theirs:
    // loop execution is fleet-only TODAY, and core-local execution is not
    // built yet. The engine's spawner seam is injectable, so this is missing
    // wiring, not a design limit.
    // CORE-LOCAL (QuoxPlan #2873, built 2026-08-20): no eligible dev server
    // no longer dead-ends a core customer. Returning null makes the spawn
    // request go host-less, and the collector runs the loop in-process
    // (authenticated claude/codex live in its container) with identical
    // event/evidence/interrupt behavior. A fleet host, when one exists,
    // still wins: it is the governed, capability-profiled path.
    return null
  }
  return eligible.host_id
}

/**
 * Async generator polling the collector's event read API. Yields the
 * PARSED stream-json event objects (loopDispatch's normalizeLoopEvent
 * vocabulary). Ends when the session reports a terminal status AND all
 * stored events have been drained, or when the hard deadline passes
 * (forwarder batches are honest-lossy — if the terminal `done` batch was
 * lost, ending the iteration lets the consumer's no-result rule mark the
 * objective failed rather than polling forever).
 */
// POLL-RETRY (2026-08-15): one aborted or failed event poll must never kill a
// healthy live loop — obj 01M01EFJN8 (30 real events, mid-work on .131) was
// marked failed by a single 'operation was aborted due to timeout' poll. Only
// this many CONSECUTIVE failures is terminal; any success resets the count.
const MAX_CONSECUTIVE_POLL_FAILURES = 5

async function* pollEvents(fetchFn, sessionId, { maxDurationMs, sleep }) {
  const deadline = Date.now() + (maxDurationMs > 0 ? maxDurationMs : 30 * 60 * 1000) + 60000
  let since = 0
  let consecutiveFailures = 0

  while (Date.now() < deadline) {
    let page
    try {
      const resp = await fetchFn(
        `${COLLECTOR_URL}/api/v1/dev-sessions/${encodeURIComponent(sessionId)}/events?since_seq=${since}&limit=200`,
        { headers: authHeaders(), signal: AbortSignal.timeout(10000) },
      )
      if (!resp.ok) {
        throw new Error(`event read returned ${resp.status}`)
      }
      page = await resp.json()
    } catch (err) {
      consecutiveFailures += 1
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error(`fleetLoopSpawner: event poll failed ${consecutiveFailures} consecutive times, last: ${err.message}`)
      }
      // Linear backoff, then keep polling — the loop on the host is unaffected
      // by our read-side blip and its events remain resumable by since_seq.
      await sleep(POLL_INTERVAL_MS * consecutiveFailures)
      continue
    }
    consecutiveFailures = 0
    for (const e of page.events || []) {
      since = Math.max(since, e.seq)
      let parsed
      try {
        parsed = JSON.parse(e.raw)
      } catch {
        continue // an unparseable stored event is skipped, same as the agent-side scanner
      }
      if (parsed && typeof parsed === 'object') yield parsed
    }
    const terminal = page.status === 'done' || page.status === 'error'
    if (terminal && (page.events || []).length === 0) return
    if ((page.events || []).length === 0) await sleep(POLL_INTERVAL_MS)
  }
}

/**
 * Build a loopSpawner (see loopDispatch.js SEAM CONTRACT). fetchFn/sleep
 * injectable for tests.
 */
function createFleetLoopSpawner({ fetchFn, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  return async function fleetLoopSpawner({ objective, backend, payload, args, capabilityScope, toolAccess, maxDurationMs, maxTurns, orgId, approvalItemId }) {
    // Resolve fetch at CALL time (not a module-load default), so a
    // globalThis.fetch swap in tests takes effect and no stale reference
    // is held.
    const doFetch = fetchFn || globalThis.fetch

    // QM-7: the whole spawn attempt (dev-servers lookup + the spawn POST,
    // whether it lands on a fleet host over Bastion ssh or falls back
    // CORE-LOCAL inside the collector's own container) is gated as ONE
    // 'ssh' breaker operation — this module's own header names the pair
    // "the real fleet spawn substrate", one seam. A single
    // canExecuteResource check up front and a single record*() at the end
    // is deliberate: recording the lookup and the spawn as two SEPARATE
    // outcomes was tried and reverted, because a lookup that keeps
    // succeeding kept calling recordResourceSuccess and zeroing the
    // failure count a failing spawn had just incremented, one step
    // earlier in the very same attempt — the breaker could never
    // accumulate past 1 failure and would never trip. A refusal here is
    // NOT itself recorded as a failure, or a refused retry would keep
    // pushing lastFailure forward and the reset window would never elapse.
    if (!canExecuteResource('ssh')) {
      throw new CircuitBreakerOpenError('ssh')
    }

    try {
      // api-kind backends (openai) never run on a fleet host: the collector
      // runs them in-process, so skip the dev-server lookup (host-less spawn).
      const hostId = getLoopProvider(backend)?.kind === 'api' ? null : await resolveDevServer(doFetch, orgId)

      const resp = await doFetch(`${COLLECTOR_URL}/api/v1/dev-sessions/spawn`, {
        method: 'POST',
        headers: authHeaders({ 'X-Org-Id': orgId }),
        body: JSON.stringify({
          // host_id omitted (core-local) when no eligible dev server exists.
          org_id: orgId,
          // Lets the collector mint a Bastion grant anchored to the approved
          // before_start item and bound to this objective.
          objective_id: objective?.id,
          approval_item_id: approvalItemId || null,
          host_id: hostId,
          backend,
          payload,
          args,
          // The signed scope and its governed tool grant travel WITH the spawn:
          // the collector stamps the session id onto tool_access and the agent
          // starts the session already scoped. Dropping them here (as this
          // destructure once did) left capability_scope enforced nowhere.
          capability_scope: capabilityScope,
          tool_access: toolAccess,
          max_duration_ms: maxDurationMs,
          max_turns: maxTurns,
        }),
        signal: AbortSignal.timeout(60000),
      })
      if (!resp.ok) {
        let detail = ''
        try { detail = JSON.stringify(await resp.json()) } catch { /* body optional */ }
        throw new Error(`fleetLoopSpawner: spawn returned ${resp.status} ${detail}`.trim())
      }
      const spawned = await resp.json()
      if (!spawned.session_id) {
        throw new Error('fleetLoopSpawner: spawn response had no session_id')
      }
      recordResourceSuccess('ssh')

      return {
        sessionId: spawned.session_id,
        events: pollEvents(doFetch, spawned.session_id, { maxDurationMs, sleep }),
      }
    } catch (err) {
      recordResourceFailure('ssh')
      throw err
    }
  }
}

export { createFleetLoopSpawner, resolveDevServer, POLL_INTERVAL_MS }
