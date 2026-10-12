/**
 * goalLaneFeed.js — P10.I-1 Goal Lane on Home
 *
 * Aggregates AEE envelopes by corr (conversation/correlation ID) into
 * "thread cards" that the GoalLane component can render.
 *
 * Data flow (all three merged into one lane, most-recent first):
 *   1. Poll GET /collector/aee/conversations/enriched → chat threads
 *   2. Running OBJECTIVES via objectivesClient.listObjectives → loop + DAG cards
 *      (execution_mode 'loop' | 'dag'; the "new stuff")
 *   3. Running EXECUTIONS via quoxflowClient.listExecutions → flow cards
 *      (this merge was documented from day one but never implemented until now)
 *   4. Merge + dedupe by corr (runs win over a bare chat on the same corr),
 *      sort by latest activity, cap at MAX_THREADS
 *   5. Subscribe callbacks get notified on change
 *
 * All pure logic (aggregation, derivation, run→thread mapping) is exported for
 * unit testing.
 */

import { listObjectives } from './objectivesClient'
import { listExecutions } from './quoxflowClient'

// ── Stage derivation from corr prefix (mirrors store.js classifySource) ───────

/**
 * Map a corr prefix to an EvolutionStage key.
 *
 * @param {string} corr
 * @returns {'chat' | 'objective' | 'workflow' | 'crystal'}
 */
export function deriveStageFromCorr(corr) {
  if (!corr) return 'chat'
  if (corr.startsWith('OBJ_') || corr.startsWith('OBJECTIVE_')) return 'objective'
  if (
    corr.startsWith('WF_') ||
    corr.startsWith('wf-') ||
    corr.startsWith('FLOW_')
  )
    return 'workflow'
  if (corr.startsWith('CRYSTAL_') || corr.startsWith('SKILL_')) return 'crystal'
  return 'chat'
}

// ── Status derivation from the latest envelope intent ─────────────────────────

const RUNNING_INTENTS = new Set([
  'quox.chat.query',
  'quox.chat.streaming',
  'quox.workflow.started',
  'quox.execution.started',
  'quox.execution.running',
  'quox.objective.started',
  'aocl.run.start',
])

const APPROVAL_INTENTS = new Set([
  'quox.hitl.approval_required',
  'quox.approval.pending',
  'quox.task.pending_approval',
])

// R3.high: 'exhausted' covers quox.budget.exhausted intent — budget-stopped threads
// must show as failed, not running.
const FAILED_INTENTS_SUBSTRINGS = ['failed', 'error', 'timeout', 'cancelled', 'exhausted']

const COMPLETED_INTENTS_SUBSTRINGS = ['completed', 'done', 'success', 'finished']

/**
 * Derive thread status from the latest envelope's intent.
 *
 * @param {string} intent
 * @returns {'running' | 'awaiting-approval' | 'failed' | 'ready'}
 */
export function deriveStatus(intent) {
  if (!intent) return 'ready'
  if (RUNNING_INTENTS.has(intent)) return 'running'
  if (APPROVAL_INTENTS.has(intent)) return 'awaiting-approval'

  const lower = intent.toLowerCase()
  if (FAILED_INTENTS_SUBSTRINGS.some((s) => lower.includes(s))) return 'failed'
  if (COMPLETED_INTENTS_SUBSTRINGS.some((s) => lower.includes(s))) return 'ready'

  // Objective / workflow created → ready to act on
  if (lower.includes('created') || lower.includes('saved')) return 'ready'

  // Default for chat responses etc.
  return 'running'
}

// ── Display name + elapsed time helpers ──────────────────────────────────────

/**
 * Strip routing-prefix and trailing hash to produce a human-readable name.
 *
 *   wf-sentinel-heartbeat-7GPK3FCC → sentinel-heartbeat
 *   OBJ_research-q3-metrics_8XYZ   → research-q3-metrics
 *   CONV_abc123                    → abc123
 *
 * @param {string} corr
 * @returns {string}
 */
export function deriveDisplayName(corr) {
  if (!corr) return 'Thread'
  // Bare ULID (26 chars Crockford base32, no separators) — corr is just the
  // execution/conversation id with no human-readable prefix. Showing the raw
  // ULID is unhelpful, so render it as "Execution <last-6>".
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(corr)) {
    return `Execution ${corr.slice(-6)}`
  }
  let name = corr.replace(/^(wf-|WF_|FLOW_|CONV_|OBJ_|OBJECTIVE_|CRYSTAL_|SKILL_)/i, '')
  // Trim trailing -XXXXXXXX hash (8+ alnum chars at end)
  name = name.replace(/[-_][A-Z0-9]{8,}$/i, '')
  if (name.length > 30) name = name.slice(0, 27) + '…'
  return name || corr.slice(0, 16)
}

/**
 * Compact relative-time string ("2m ago", "3h ago", "just now").
 *
 * @param {string|Date|number} ts
 * @param {Date} [now]   — for testability
 * @returns {string}
 */
export function formatElapsed(ts, now = new Date()) {
  if (!ts) return ''
  const t = ts instanceof Date ? ts.getTime() : new Date(ts).getTime()
  if (!Number.isFinite(t)) return ''
  const ms = Math.max(0, now.getTime() - t)
  if (ms < 5_000) return 'just now'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

// ── Next action prompt ─────────────────────────────────────────────────────────

/**
 * Return a one-line description of what's actually happening, derived from
 * the latest envelope's payload + intent. Avoids duplicating the status pill.
 *
 * @param {{
 *   status: 'running'|'awaiting-approval'|'failed'|'ready',
 *   stage:  'chat'|'objective'|'workflow'|'crystal',
 *   latestIntent?: string,
 *   latestPayload?: object|null,
 * }} ctx
 * @returns {string}
 */
export function deriveNextAction(ctx) {
  // Back-compat: tolerate legacy (status, stage) call signature
  if (typeof ctx === 'string') {
    return deriveNextAction({ status: ctx, stage: arguments[1] })
  }
  const { status, stage, latestIntent, latestPayload } = ctx || {}

  // High-priority — user must act
  if (status === 'awaiting-approval') {
    const note = latestPayload?.message || latestPayload?.reason
    return note ? `Awaiting approval: ${String(note).slice(0, 80)}` : 'Awaiting your approval'
  }
  if (status === 'failed') {
    const errMsg = latestPayload?.error?.message || latestPayload?.message
    if (errMsg) return `Failed: ${String(errMsg).slice(0, 80)}`
    return 'Failed — review error log'
  }

  // Running — surface what it's actually doing right now
  if (status === 'running') {
    // Try to surface concrete node / action from the latest envelope
    const concrete = latestPayload?.nodeName
      || latestPayload?.node_id
      || latestPayload?.action
      || latestPayload?.step
    if (concrete) return String(concrete).slice(0, 80)

    // Fall back to intent verb
    const intent = (latestIntent || '').toLowerCase()
    if (intent.includes('skill.retrieved')) return 'Loading proven patterns'
    if (intent.includes('skill.drafted')) return 'Proposing new skill'
    if (intent.includes('skill.refined')) return 'Refining skill draft'
    if (intent.includes('skill.promoted')) return 'Promoting to canonical skill'
    if (intent.includes('node.started')) return 'Starting next step'
    if (intent.includes('node.completed')) return 'Step complete'
    if (intent.includes('budget.warning')) return 'Approaching budget cap'
    if (intent.includes('approval.requested')) return 'Requesting approval'
    if (stage === 'workflow') return 'Workflow in progress'
    if (stage === 'objective') return 'Objective in progress'
    if (stage === 'crystal') return 'Crystal executing'
    return 'In progress'
  }

  // Ready
  if (stage === 'crystal') return 'Ready to publish'
  if (stage === 'workflow') return 'Complete — crystallise to save'
  if (stage === 'objective') return 'Reached goal — promote to workflow?'
  return 'Continue conversation'
}

// ── Target route derivation ─────────────────────────────────────────────────

/**
 * Determine where clicking the card should navigate.
 *
 * @param {{ corr: string, stage: string, executionId: string|null, objectiveId: string|null }} thread
 * @returns {string} react-router path (may include ?params)
 */
export function deriveTargetRoute(thread) {
  const { corr, stage, executionId, objectiveId } = thread

  if (executionId) {
    return `/executions/${executionId}`
  }
  if (objectiveId || stage === 'objective') {
    const id = objectiveId || corr
    return `/mission-control?tab=objectives&corr=${encodeURIComponent(id)}`
  }
  if (stage === 'workflow') {
    // corr looks like "wf-<workflow-id>-<exec-suffix>". Strip prefix + trailing
    // hash to recover the workflow_id and open the Workflow Builder, which
    // exposes the Recent Runs overlay so the user can drill into the specific
    // execution. /workflows-hub?tab=runs does not exist (renders blank).
    const wfid = corr.replace(/^wf-/i, '').replace(/[-_][A-Z0-9]{8,}$/i, '')
    if (wfid) return `/workflow-builder?id=${encodeURIComponent(wfid)}`
  }
  if (stage === 'crystal') {
    return `/crystals`
  }
  // Bare ULID corr with no detected executionId — this reached us from the
  // "chats" conversation feed, so it's a conversation, not an execution. Open
  // it in Activity (which selects the conversation from ?corr=). The old
  // /executions/<ulid> route 404'd for chat ULIDs.
  // chat-only → open the conversation in Activity. The old /?corr= just
  // re-navigated to Home and looked like nothing happened (owner: "click does
  // nothing"). Activity reads ?corr= and opens that conversation.
  return `/activity?corr=${encodeURIComponent(corr)}`
}

// ── Run cards: loops, DAG objectives, workflow executions ─────────────────────

/**
 * Compact token count for the loop progress line ("3.2k", "850").
 * @param {number} n
 * @returns {string}
 */
export function formatTokens(n) {
  if (!Number.isFinite(n)) return ''
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
}

/**
 * Map a backend run status (objective/execution) to a card status.
 *
 * @param {string} s
 * @returns {'running'|'awaiting-approval'|'failed'|'ready'}
 */
export function mapRunStatus(s) {
  const v = String(s || '').toLowerCase()
  if (v === 'running' || v === 'active' || v === 'in_progress' || v === 'streaming') return 'running'
  if (v.includes('await') || v.includes('pending') || v === 'paused') return 'awaiting-approval'
  if (v.includes('fail') || v.includes('error') || v === 'halted' || v === 'cancelled') return 'failed'
  if (v.includes('complet') || v === 'done' || v === 'success' || v === 'finished') return 'ready'
  return 'running'
}

/**
 * One-line current-action for a run card.
 * @param {{kind:'loop'|'dag'|'flow', status:string, obj?:object, exec?:object}} ctx
 * @returns {string}
 */
export function deriveRunAction({ kind, status, obj, exec }) {
  if (status === 'failed') return kind === 'loop' ? 'Loop stopped — review' : 'Run stopped — review'
  if (status === 'ready') return 'Complete'
  if (status === 'awaiting-approval') return 'Awaiting your approval'
  if (kind === 'loop') {
    const used = Number(obj?.tokens_used)
    const cap = Number(obj?.max_tokens)
    if (Number.isFinite(used) && Number.isFinite(cap) && cap > 0) {
      return `Loop · ${formatTokens(used)}/${formatTokens(cap)} tokens`
    }
    return 'Loop running'
  }
  if (kind === 'dag') return 'Planned run in progress'
  if (kind === 'flow') {
    const node = exec?.currentNode || exec?.current_node || exec?.currentNodeName
    return node ? `Running: ${String(node).slice(0, 60)}` : 'Workflow in progress'
  }
  return 'Objective in progress'
}

/**
 * Convert an Objective record (loop or DAG execution_mode) into a ThreadCard.
 * Loops and DAG are both 'objective'-stage; the `kind` tag distinguishes them.
 *
 * @param {object} o - objective record from listObjectives
 * @returns {ThreadCard|null}
 */
export function objectiveToThread(o) {
  if (!o || !o.id) return null
  const isLoop = o.execution_mode === 'loop'
  const kind = isLoop ? 'loop' : (o.execution_mode === 'dag' ? 'dag' : 'objective')
  const corr = o.corr_id || `OBJ_${o.id}`
  const status = mapRunStatus(o.status)
  const rawTitle = o.title || (isLoop ? 'Loop' : 'Objective')
  const displayName = rawTitle.length > 52 ? rawTitle.slice(0, 51) + '…' : rawTitle
  return {
    corr,
    displayName,
    stage: 'objective',
    kind,
    status,
    nextAction: deriveRunAction({ kind, status, obj: o }),
    // No /objectives/:id detail route exists — open the QLoop / Objectives list.
    targetRoute: '/objectives',
    executionId: null,
    objectiveId: o.id,
    latestTs: o.updated_at || o.created_at || o.last_activity_at || null,
    latestIntent: null,
    latestPayload: null,
    envelopeCount: 0,
  }
}

/**
 * Convert a workflow execution (DAG run) into a ThreadCard.
 *
 * @param {object} e - execution record from listExecutions
 * @returns {ThreadCard|null}
 */
export function executionToThread(e) {
  const id = e?.id || e?.execution_id || e?.executionId
  if (!id) return null
  const rawName = e.workflowName || e.workflow_name || e.name || e.workflowId || e.workflow_id || 'Workflow'
  const displayName = rawName.length > 52 ? rawName.slice(0, 51) + '…' : rawName
  const status = mapRunStatus(e.status)
  return {
    corr: e.corr || `WF_${id}`,
    displayName,
    stage: 'workflow',
    kind: 'flow',
    status,
    nextAction: deriveRunAction({ kind: 'flow', status, exec: e }),
    targetRoute: `/executions/${encodeURIComponent(id)}`,
    executionId: id,
    objectiveId: null,
    latestTs: e.startedAt || e.started_at || e.created_at || e.updatedAt || e.updated_at || null,
    latestIntent: null,
    latestPayload: null,
    envelopeCount: 0,
  }
}

// ── Core aggregation ──────────────────────────────────────────────────────────

/**
 * Aggregate a flat array of AEE envelopes into thread cards.
 *
 * Rules:
 *  - Skip envelopes missing a corr value
 *  - Group by corr
 *  - Latest ts wins for latestIntent / stage / status derivation
 *  - Detect executionId and objectiveId from payload or corr prefix
 *
 * @param {Array<{corr:string, ts:string, intent:string, payload?:object}>} envelopes
 * @returns {Array<ThreadCard>}
 */
export function aggregateEnvelopesIntoThreads(envelopes) {
  /** @type {Map<string, {corr: string, envelopes: object[], latestTs: string, latestIntent: string}>} */
  const map = new Map()

  for (const envelope of envelopes) {
    const corr = envelope.corr
    // Skip null / undefined / empty corr values
    if (!corr) continue

    if (!map.has(corr)) {
      map.set(corr, {
        corr,
        envelopes: [],
        latestTs: envelope.ts,
        latestIntent: envelope.intent,
        latestPayload: envelope.payload || null,
        // First human-readable message text for this thread — becomes the card
        // title so it reads as a description, not a reference number.
        title: envelope.preview || null,
      })
    }

    const entry = map.get(corr)
    entry.envelopes.push(envelope)
    if (!entry.title && envelope.preview) entry.title = envelope.preview

    // Latest-wins: compare timestamps
    if (envelope.ts && entry.latestTs && envelope.ts > entry.latestTs) {
      entry.latestTs = envelope.ts
      entry.latestIntent = envelope.intent
      entry.latestPayload = envelope.payload || null
    } else if (!entry.latestTs) {
      entry.latestTs = envelope.ts
      entry.latestIntent = envelope.intent
      entry.latestPayload = envelope.payload || null
    }
  }

  // Build ThreadCard objects from each grouped entry
  const threads = []
  for (const [corr, entry] of map) {
    // Derive IDs from corr prefix or payload scan
    let executionId = null
    let objectiveId = null

    if (corr.startsWith('OBJ_') || corr.startsWith('OBJECTIVE_')) {
      objectiveId = corr
    }

    // Scan payloads for explicit executionId
    for (const e of entry.envelopes) {
      if (e.payload?.executionId) { executionId = e.payload.executionId; break }
      if (e.payload?.execution_id) { executionId = e.payload.execution_id; break }
    }

    const stage = deriveStageFromCorr(corr)
    const status = deriveStatus(entry.latestIntent)
    const nextAction = deriveNextAction({
      status,
      stage,
      latestIntent: entry.latestIntent,
      latestPayload: entry.latestPayload,
    })
    // Prefer the real conversation text as the title (truncated); fall back to
    // the corr-derived label only when there's no message text at all.
    const displayName = entry.title
      ? (entry.title.length > 52 ? entry.title.slice(0, 51) + '…' : entry.title)
      : deriveDisplayName(corr)
    const targetRoute = deriveTargetRoute({ corr, stage, executionId, objectiveId })

    threads.push({
      corr,
      displayName,
      stage,
      status,
      nextAction,
      targetRoute,
      executionId,
      objectiveId,
      latestTs: entry.latestTs,
      latestIntent: entry.latestIntent,
      latestPayload: entry.latestPayload,
      envelopeCount: entry.envelopes.length,
    })
  }

  // Sort by latest activity, most-recent first
  threads.sort((a, b) => (b.latestTs || '').localeCompare(a.latestTs || ''))

  return threads
}

// ── Feed subscription (polls the server) ──────────────────────────────────────

const POLL_INTERVAL_MS = 10_000 // 10 seconds
const MAX_THREADS = 20 // cap for the lane

let _subscribers = []
let _pollingInterval = null
let _lastFetchFn = null

/**
 * Fetch threads from the server.
 *
 * Uses the existing /collector/aee/conversations/enriched endpoint which
 * returns recent conversations. We then pull the running executions to detect
 * active workflow threads.
 *
 * @param {Function} authFetch — authenticated fetch (from AuthContext)
 * @param {string} orgId
 * @returns {Promise<ThreadCard[]>}
 */
export async function fetchGoalLaneThreads(authFetch, orgId) {
  if (!authFetch) return []

  // Fetch all three sources concurrently. Each is independently guarded so one
  // dead backend (tasks :3104 or quoxflow) degrades the lane rather than
  // emptying it — a running loop still shows if AEE is down, and vice versa.
  const [convThreads, runThreads] = await Promise.all([
    fetchConversationThreads(authFetch),
    fetchRunThreads(authFetch),
  ])

  // Merge + dedupe by corr. A running loop/DAG/flow card carries far more than a
  // bare chat conversation on the same corr, so runs override chats on collision.
  const byCorr = new Map()
  for (const t of convThreads) byCorr.set(t.corr, t)
  for (const t of runThreads) byCorr.set(t.corr, t)

  const merged = [...byCorr.values()]
  merged.sort((a, b) => (b.latestTs || '').localeCompare(a.latestTs || ''))
  return merged.slice(0, MAX_THREADS)
}

/**
 * Chat threads from the AEE enriched-conversations endpoint.
 * @param {Function} authFetch
 * @returns {Promise<ThreadCard[]>}
 */
async function fetchConversationThreads(authFetch) {
  try {
    const res = await authFetch(`/collector/aee/conversations/enriched?limit=50`)
    if (!res.ok) return []

    const data = await res.json()
    const convs = data.conversations || []

    // Build an envelope from each conversation record. The enriched endpoint
    // returns { corr, first_ts, last_ts, count, firstMessage: <envelope>, ... }
    // — NOT a flat { intent, preview }. The previous code read c.intent (always
    // undefined → every thread defaulted to 'running') and set payload:{} (threw
    // away the real message text → every card fell back to the raw ULID/corr,
    // the "meaningless reference numbers"). Thread the firstMessage through so
    // the card shows a human title + a real current-action line.
    const envelopes = convs
      .filter((c) => c.corr)
      .map((c) => {
        const fm = c.firstMessage || {}
        const p = fm.payload || {}
        const preview = p.text || p.title || p.query_preview || p.queryPreview || null
        return {
          corr: c.corr,
          ts: c.last_ts || c.ts || new Date().toISOString(),
          intent: fm.intent || c.intent || 'quox.chat.query',
          payload: p,
          preview: preview ? String(preview).trim() : null,
        }
      })

    return aggregateEnvelopesIntoThreads(envelopes)
  } catch {
    return []
  }
}

/**
 * Run threads: active loops + DAG objectives, plus running workflow executions.
 * @param {Function} authFetch
 * @returns {Promise<ThreadCard[]>}
 */
async function fetchRunThreads(authFetch) {
  const [objs, execs] = await Promise.all([
    listObjectives(authFetch, { status: 'running', limit: 25 })
      .then((r) => r?.objectives || [])
      .catch(() => []),
    listExecutions({ status: 'running', limit: 25 })
      .then((r) => r?.executions || r?.data || (Array.isArray(r) ? r : []))
      .catch(() => []),
  ])

  const threads = []
  for (const o of objs) { const t = objectiveToThread(o); if (t) threads.push(t) }
  for (const e of execs) { const t = executionToThread(e); if (t) threads.push(t) }
  return threads
}

/**
 * Subscribe a callback to Goal Lane thread updates.
 * Starts polling if not already running.
 *
 * @param {(threads: ThreadCard[]) => void} callback
 * @param {Function} authFetch
 * @param {string} orgId
 * @returns {() => void} unsubscribe function
 */
export function subscribeGoalLane(callback, authFetch, orgId) {
  _subscribers.push(callback)

  const notify = async () => {
    const threads = await fetchGoalLaneThreads(authFetch, orgId)
    for (const sub of _subscribers) {
      try { sub(threads) } catch { /* ignore subscriber errors */ }
    }
  }

  // Initial fetch
  notify()

  // Start polling if first subscriber
  if (_subscribers.length === 1) {
    _pollingInterval = setInterval(notify, POLL_INTERVAL_MS)
    _lastFetchFn = notify
  }

  return () => {
    _subscribers = _subscribers.filter((s) => s !== callback)
    if (_subscribers.length === 0 && _pollingInterval) {
      clearInterval(_pollingInterval)
      _pollingInterval = null
      _lastFetchFn = null
    }
  }
}

/**
 * Force an immediate refresh of the Goal Lane feed.
 * No-op if no subscribers are active.
 */
export function refreshGoalLane() {
  if (_lastFetchFn) _lastFetchFn()
}
