/**
 * Loop Dispatch — DEVSUITE-DEVMODE Phase 5b-1 (first increment)
 *
 * dispatchObjective() (objectiveDispatch.js) handles 'dag' mode: a
 * fixed, pre-decomposed set of tasks converted to a QuoxFlow workflow.
 * A 'loop' mode objective is different in kind, not just plumbing — it
 * has no upfront task plan. It hands its goal to the model's own native
 * agentic loop (turn by turn: observe, decide, act, repeat) and each
 * turn is discovered as the loop runs, not planned in advance. This
 * module is the loop-mode branch of that same dispatch path.
 *
 * SEAM CONTRACT (options.loopSpawner)
 * ------------------------------------
 * The cross-service path from tasks -> collector -> quoxagent
 * dev.sessions (the real fleet spawn substrate: `claude -p` stream-json,
 * honest post-hoc accounting, hard kill, capability_scope enforced
 * pre-start by the autonomy gate) does NOT exist yet. That wiring is the
 * NEXT increment. This increment defines the seam it will plug into and
 * makes the seam injectable so it can be exercised end-to-end in tests
 * today, with a loud, unambiguous failure in production until the real
 * seam lands.
 *
 * Signature:
 *   loopSpawner({ objective, backend, payload, args, capabilityScope, toolAccess, maxDurationMs, maxTurns, orgId })
 *     -> Promise<{ sessionId: string, events: AsyncIterable<LoopEvent> }>
 *
 *   - objective        the full objective row
 *   - backend          which CLI drives the loop: 'claude' or 'codex' (from
 *                       objectives.loop_backend, default 'claude'). The loop
 *                       is NOT claude-only; see buildLoopInput for why the
 *                       backends differ structurally (stdin vs argv).
 *   - payload          the bytes a real seam writes to the session's stdin
 *                       then closes: a stream-json line for claude, plain
 *                       text instructions for codex (`codex exec --json -`
 *                       reads the prompt from stdin — verified against real
 *                       codex-cli 0.118.0, 2026-08-11)
 *   - args             extra CLI args beyond quoxagent structuredBaseArgs():
 *                       the claude backend's --append-system-prompt and
 *                       --allowedTools flags (see buildLoopInput), undefined
 *                       when the objective carries neither
 *   - capabilityScope  the parsed deny-by-default tool allowlist (array or
 *                       null — see autonomyDecision.js resolveCapabilityScope)
 *   - toolAccess       governed Quox tool grant for the session, or null when
 *                       the scope names no mcp__quox__ tool (see
 *                       buildToolAccess)
 *   - maxDurationMs    objective.max_duration_ms
 *   - maxTurns         objective.max_iterations
 *   - orgId            objective.org_id
 *
 *   Returns `sessionId` (persisted to objectives.loop_session_id) and
 *   `events`, an async iterable (array, async generator, or any object
 *   implementing Symbol.asyncIterator/Symbol.iterator) yielding
 *   structured events shaped like Claude Code's stream-json output:
 *   `{ type: 'assistant' | 'tool_use' | 'result' | ..., ... }`.
 *
 * A production caller that does not supply `options.loopSpawner` gets
 * the default seam, which FAILS LOUDLY (throws) rather than silently
 * no-opping or pretending success — a loop objective with no real spawn
 * path must be visibly failed, never a phantom 'running' row.
 */

import { ulid } from 'ulid'
import { emitProgress } from './progress.js'
import { trackPoll } from './objectiveReconciler.js'
import { createFleetLoopSpawner } from './fleetLoopSpawner.js'
import { createStuckDetector, argsKeyFor } from './loopStuckDetector.js'
import { assertLoopBackendDispatchable, getLoopProvider, DEFAULT_LOOP_BACKEND } from './loopProviders.js'
import { canonicalToolName, scopeToBackendArgs, enabledToolsFromScope, assertCodexScopeHonorable, HARNESS_INTERNAL_TOOLS } from './backendVocabulary.js'
import { createGateLatch, evaluateLoopGates, riskGateFinding, haltLoopForExpiredLease, haltLoopForSafetyGate } from './loopCheckpoints.js'
import { hasActiveSandboxApprovalGrant } from './disposableTestInstance.js'
import { checkSafetyGate } from './safetyGate.js'
import { createTaskEnvelope, TASK_INTENTS } from './envelopes.js'
import { canExecuteResource, recordResourceFailure, recordResourceSuccess, CircuitBreakerOpenError } from './resourceBreaker.js'
import { getExitPredicate, getEffectiveExitPredicate, implicitGoalExitEnabled, isCheapPredicate, evaluateExitPredicate } from './exitPredicate.js'

// P7 CONTINUITY: resident-agent loops BECOME their prior self before acting
// and never end without a self-delta on the chain. Resident = the wake
// seam's synthetic owner (quoxperticusWake.QUOXPERTICUS_USER_ID).
const RESIDENT_AGENT_USER = 'quoxperticus'

// QM-7: this is a plain collector call (no ssh/Bastion hop, no LLM invoke),
// so it is the genuine choke point for the 'collector' breaker — distinct
// from the fleet-spawn 'ssh' bucket (fleetLoopSpawner.js) and the
// agents/invoke 'llm' bucket (goalEvaluator.js / coordinatorStep.js /
// decomposer.js). A refusal is NOT itself recorded as a failure, or a
// refused retry would keep pushing lastFailure forward and the reset
// window would never elapse.
async function fetchContinuityRecall(orgId, agentId) {
  if (!canExecuteResource('collector')) {
    throw new CircuitBreakerOpenError('collector')
  }
  const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://collector:9848'
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || ''
  let res
  try {
    res = await fetch(
      `${COLLECTOR_URL}/api/internal/continuity/recall?org_id=${encodeURIComponent(orgId)}&agent_id=${encodeURIComponent(agentId)}`,
      { headers: { ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}) }, signal: AbortSignal.timeout(8000) },
    )
  } catch (err) {
    recordResourceFailure('collector')
    throw err
  }
  if (!res || !res.ok) {
    recordResourceFailure('collector')
    throw new Error(`continuity recall HTTP ${res && res.status}`)
  }
  recordResourceSuccess('collector')
  return res.json()
}

function renderRecallPreamble(recall) {
  if (recall.first_wake) {
    return [
      '## Continuity: first wake',
      'You have no prior self on this instance yet. Whatever you become this',
      'loop is the start of your witnessed chain: commit a self-delta with the',
      'continuity tool before you finish.',
      '',
    ].join('\n')
  }
  const loops = (recall.open_loops || []).map(l => `- ${l}`).join('\n')
  return [
    '## Continuity: become your prior self before acting',
    `Prior anchor: ${recall.prior_anchor}`,
    '',
    '### Your narrative so far',
    recall.narrative,
    '',
    '### Open loops you left yourself',
    loops || '- none',
    '',
    recall.message_to_next ? `### Message from your last self\n${recall.message_to_next}` : '',
    '',
    'Act as the continuation of this self. Before the loop ends, commit a',
    'self-delta (continuity tool, action commit): what changed about who you',
    'are, the loops you opened or closed, and one message to your next self.',
    '',
  ].join('\n')
}

async function postContinuityCommit({ orgId, objectiveId, deltaMd }) {
  try {
    const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://collector:9848'
    const serviceKey = process.env.INTERNAL_SERVICE_KEY || ''
    await fetch(`${COLLECTOR_URL}/api/internal/continuity/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}) },
      body: JSON.stringify({ org_id: orgId, agent_id: RESIDENT_AGENT_USER, delta_md: deltaMd, objective_id: objectiveId }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (e) {
    // The witness chain gap is logged, never fatal to the loop outcome.
    console.warn('[LoopDispatch] continuity terminal commit failed:', e && e.message)
  }
}

import { recordOutcome as recordObjectiveOutcome } from './wisdomStore.js'
import { reflectOnOutcome } from './dreamCycle.js'
import { observeCompletedRun } from './learningObserver.js'
import { recordPerformance, inferDomainFromTitle } from './agentScorer.js'
import { buildLearningRun, emitLearningCandidate } from './learningSink.js'

// DEVSUITE-DEVMODE fleet spawn seam: the default seam is now the REAL
// fleet spawner (tasks → collector → Bastion → quoxagent dev.sessions).
// It still fails LOUD — with the actual reason — when no dev server with
// dev.sessions is enrolled or the collector is unreachable: a loop
// objective with nowhere to run must be a visibly failed objective, never
// a phantom running row.
const defaultLoopSpawner = createFleetLoopSpawner()

/**
 * Ask the collector to kill a live loop session (it signs a structured-kill
 * envelope and delivers it via Bastion to the agent). Fire-and-forget-ish: a
 * failed interrupt is logged by the caller; the loop still has its
 * max_duration/max_turns backstops.
 *
 * `reason` travels to the collector so the evidence trail says WHY the session
 * died: 'observer_stuck' for the Observer/Knot verdict, 'checkpoint_denied'
 * when a human denies a live HITL gate. Exported because the checkpoint deny
 * path (loopCheckpoints.js, reached from an HTTP route) needs the same
 * structured-kill without a handle on any running consumer's closure.
 */
export async function interruptLoopSession(objective, reason = 'observer_stuck') {
  const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://collector:9848'
  const key = process.env.INTERNAL_SERVICE_KEY || ''
  const sid = objective.loop_session_id
  if (!sid) return
  const resp = await fetch(`${COLLECTOR_URL}/api/v1/dev-sessions/${encodeURIComponent(sid)}/interrupt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Service-Key': key } : {}), 'X-Org-Id': objective.org_id || '' },
    body: JSON.stringify({ reason }),
    signal: AbortSignal.timeout(15000),
  })
  if (!resp.ok) throw new Error(`interrupt returned ${resp.status}`)
}

/** QLoop Observer/Knot default interrupt. */
async function defaultInterruptFn(objective) {
  return interruptLoopSession(objective, 'observer_stuck')
}

/**
 * Build the single stream-json line that a loop session's first turn
 * carries as user input. Objectives don't have a `prompt` column
 * (that's a tasks-table concept) — the objective's own text lives in
 * `title` / `description`, with `goal_condition` (the STUDY-REV R3
 * re-observe evaluator field) appended as extra context when present.
 *
 * `systemPromptText` is the escape hatch for a backend with no system-prompt
 * FLAG (codex): the operator's standing instructions are prepended to the same
 * stdin bytes, under a separator clear enough that the model reads them as
 * instructions about the objective rather than part of it.
 */
function buildLoopPayloadText(objective, systemPromptText = null) {
  const parts = []
  if (objective.title) parts.push(objective.title)
  if (objective.description) parts.push(objective.description)
  if (objective.goal_condition) parts.push(`Goal condition: ${objective.goal_condition}`)
  const body = parts.join('\n\n') || objective.title || ''
  if (!systemPromptText) return body
  return `System instructions:\n${systemPromptText}\n\n=== OBJECTIVE ===\n\n${body}`
}

function buildClaudePayload(objective) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: buildLoopPayloadText(objective) }] },
  })
}

/**
 * Build the backend-appropriate initial input for a loop session. The loop is
 * NOT claude-only, and backends differ in payload FORMAT, not stdin-vs-argv:
 * both read their first input from STDIN, but `claude -p` wants a stream-json
 * message line (verified, be9179d) while `codex exec --json -` wants the
 * instructions as PLAIN TEXT (verified against real codex-cli 0.118.0,
 * 2026-08-11: the `-` positional makes exec read from stdin; stdin is chosen
 * over the argv prompt so the objective text never leaks into `ps`). Both
 * therefore return `{ payload }` — the bytes a real seam writes to the
 * session's stdin and closes. Base CLI flags per backend live in quoxagent's
 * structuredBaseArgs(), not here.
 *
 * `args` carries the per-objective flags, compiled from the system prompt and
 * the capability scope by backendVocabulary.scopeToBackendArgs, which owns the
 * knowledge that claude takes --append-system-prompt/--allowedTools while codex
 * takes --sandbox/-a and no tool allowlist at all. A backend that cannot express
 * the system prompt as a flag gets it back as `systemPromptText`, which this
 * function folds into the stdin payload instead.
 * @returns {{ payload?: string, args?: string[] }}
 */
function buildLoopInput(objective, backend, capabilityScope) {
  const provider = assertLoopBackendDispatchable(backend)
  const { args, systemPromptText } = scopeToBackendArgs(backend, capabilityScope, objective.system_prompt)
  const payload = provider.payloadFormat === 'stream-json'
    ? buildClaudePayload(objective)
    : buildLoopPayloadText(objective, systemPromptText)
  return { payload, args }
}

/**
 * Governed tool access for the loop session. A loop only reaches Quox's own
 * tools through the collector's MCP chokepoint, and those tools are the only
 * ones named `mcp__quox__*`, so the scope itself decides whether the session
 * needs a tool-access grant at all. `session_id` is deliberately absent: it is
 * not known tasks-side, and the collector stamps it on the spawn it creates.
 *
 * `enabled_tools` carries the same grant as PLAIN tool names, because a backend
 * whose MCP allowlist lives in a config file rather than a CLI flag (codex) is
 * configured host-side by the agent, and the host needs the names in the form
 * that config expects.
 * @returns {{ enabled: true, agent_id: string, org_id: string, enabled_tools: string[] } | null}
 */
function buildToolAccess(objective, capabilityScope) {
  const enabledTools = enabledToolsFromScope(capabilityScope)
  if (enabledTools.length === 0) return null
  return { enabled: true, agent_id: 'qloop', org_id: objective.org_id, enabled_tools: enabledTools }
}

/**
 * Per-turn scope matcher for the post-hoc backstop. A tool is allowed when the
 * scope names it exactly, or when a scoped entry of the form 'Name(pattern)'
 * names it by its prefix, which is the CLI's own allowlist syntax, so a scope written
 * as 'Bash(git *)' still recognises the stream's bare 'Bash'. The narrower
 * argument pattern is enforced pre-flight by the CLI; this backstop only ever
 * answers "was this tool in scope at all".
 */
function isToolInScope(tool, capabilityScope) {
  // P1 DEC-6: an absent/empty scope is DENY-ALL, not allow-all. Dispatch
  // refuses scope-less loops before any spawn, so this branch only fires for
  // a legacy in-flight loop or a bug upstream — and then it must knot every
  // governed tool rather than wave everything through (harness internals
  // still pass; they are the stream's own plumbing, not capabilities).
  if (!Array.isArray(capabilityScope) || capabilityScope.length === 0) {
    return HARNESS_INTERNAL_TOOLS.has(tool)
  }
  if (HARNESS_INTERNAL_TOOLS.has(tool)) return true
  return capabilityScope.some(entry => {
    if (typeof entry !== 'string') return false
    if (entry === tool) return true
    const paren = entry.indexOf('(')
    return paren > 0 && entry.slice(0, paren).trim() === tool
  })
}

function parseCapabilityScope(objective) {
  try {
    const parsed = JSON.parse(objective.capability_scope || 'null')
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function safeStringify(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function extractAssistantText(event) {
  const content = event?.message?.content
  if (!Array.isArray(content)) return ''
  return content.filter(c => c?.type === 'text' && c.text).map(c => c.text).join(' ')
}

/** Human-readable one-line summary of a turn event, used as the synthetic task's title. */
function summarizeTurn(event) {
  if (event.type === 'tool_use') {
    const name = event.name || event.tool_name || event.tool || 'tool'
    return `Tool call: ${name}`
  }
  if (event.type === 'assistant') {
    const text = extractAssistantText(event)
    return text ? `Assistant: ${text.slice(0, 200)}` : 'Assistant turn'
  }
  return `Loop event: ${event.type}`
}

function insertSyntheticTask(db, objective, title, event, sequenceNum) {
  const id = ulid()
  db.prepare(`
    INSERT INTO tasks (id, objective_id, org_id, title, agent_id, prompt, sequence_num, depends_on, status, result, created_at, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, '[]', 'completed', ?, datetime('now'), datetime('now'), datetime('now'))
  `).run(id, objective.id, objective.org_id, title, event.agent_id || 'loop', sequenceNum, safeStringify(event).slice(0, 10000))
  return id
}

/**
 * AEE-TASK-EVIDENCE (quox#480): write the task.started / task.completed pair
 * for one consumed loop turn.
 *
 * Never throws: evidence that cannot be written must not kill a running
 * loop's event consumer, the same rule usage accounting and checkpoint
 * creation already follow on this path.
 */
function emitLoopTurnEnvelopes(objective, { taskId, title, agentId, sequenceNum, tokensUsed, toolCalls }) {
  try {
    const common = {
      task_id: taskId,
      title,
      agent_id: agentId,
      sequence_num: sequenceNum,
      objective_title: objective.title,
      engine: 'loop',
      loop_session_id: objective.loop_session_id || undefined,
      loop_backend: objective.loop_backend || undefined,
    }
    createTaskEnvelope({
      type: 'event', from: 'service.tasks', to: `agent.${agentId}`,
      intent: TASK_INTENTS.TASK_STARTED,
      payload: { ...common },
      corrId: objective.corr_id, objectiveId: objective.id, taskId,
    })
    createTaskEnvelope({
      type: 'event', from: `agent.${agentId}`, to: 'service.tasks',
      intent: TASK_INTENTS.TASK_COMPLETED,
      payload: { ...common, tokens_used: tokensUsed, tool_calls: toolCalls },
      corrId: objective.corr_id, objectiveId: objective.id, taskId,
    })
  } catch (err) {
    console.error(`[LoopDispatch] Turn envelope emission failed for ${objective.id}:`, err.message)
  }
}

/**
 * Normalize one backend event onto the consumer's internal vocabulary:
 *   { kind: 'turn',   title, isToolCall }  — becomes one synthetic tasks row
 *   { kind: 'result', usage }              — terminal success
 *   { kind: 'failed', message }            — terminal failure
 *   null                                   — lifecycle/noise, ignored
 *
 * Claude vocabulary is the stream-json events verified in be9179d
 * ('assistant' / 'tool_use' / 'result', result carries `usage`).
 *
 * Codex vocabulary is `codex exec --json` JSONL, verified against real
 * codex-cli 0.118.0 (2026-08-11): lifecycle + failure shapes captured
 * live (thread.started/turn.started/error/turn.failed), success item
 * shapes per the official non-interactive docs (item.completed with
 * item.type agent_message/command_execution/mcp_tool_call/...,
 * turn.completed with usage.{input_tokens,cached_input_tokens,
 * output_tokens,reasoning_output_tokens}). Unknown event types are
 * ignored, never crash the consumer; a stream that ends with no
 * terminal event is still a failure (see consumeLoopEvents).
 */
function normalizeLoopEvent(event) {
  const t = event?.type
  // — claude stream-json —
  // `usage` is ADDITIVE (turns previously carried none): claude reports
  // per-turn consumption on assistant message.usage, and the live budget gate
  // needs it mid-run rather than only on the terminal 'result'. Codex reports
  // nothing per turn, so on that backend this stays null and the budget gate
  // leans on tool calls and duration.
  if (t === 'assistant') {
    // A claude tool call is an assistant-typed event carrying a tool_use
    // content block, NOT a tool_use-typed event (that shape is codex, below).
    // Reading only the event type left every claude tool call counted as
    // isToolCall:false, so objectives.tool_calls_used stayed 0 for claude
    // loops and the budget gate's tool-call dimension never fired.
    const content = event?.message?.content
    const isToolCall = Array.isArray(content) && content.some(c => c && c.type === 'tool_use')
    return { kind: 'turn', title: summarizeTurn(event), isToolCall, usage: event?.message?.usage || null }
  }
  if (t === 'tool_use') return { kind: 'turn', title: summarizeTurn(event), isToolCall: true, usage: event?.message?.usage || null }
  if (t === 'result') return { kind: 'result', usage: event.usage || null }
  // — codex exec --json —
  if (t === 'item.completed') {
    const item = event.item || {}
    switch (item.type) {
      case 'agent_message':
        return { kind: 'turn', title: item.text ? `Assistant: ${String(item.text).slice(0, 200)}` : 'Assistant turn', isToolCall: false }
      case 'command_execution':
        return { kind: 'turn', title: `Tool call: ${String(item.command || 'command').slice(0, 160)}`, isToolCall: true }
      case 'mcp_tool_call':
        return { kind: 'turn', title: `Tool call: ${[item.server, item.tool].filter(Boolean).join('.') || 'mcp_tool'}`, isToolCall: true }
      case 'file_change':
        return { kind: 'turn', title: 'File change', isToolCall: true }
      case 'web_search':
        return { kind: 'turn', title: 'Web search', isToolCall: true }
      default:
        return null // reasoning, plan updates, unknown item types: progress noise, not durable turns
    }
  }
  if (t === 'turn.completed') return { kind: 'result', usage: event.usage || null }
  if (t === 'turn.failed') return { kind: 'failed', message: event.error?.message || 'codex turn failed' }
  if (t === 'error') return { kind: 'failed', message: event.message || 'codex error' }
  return null // thread.started, turn.started, item.started/updated, anything unrecognized
}

/**
 * Extract the QLoop Observer/Knot detector turns from a raw stream-json event
 * (loopStuckDetector.observe shape). Distinct from normalizeLoopEvent (which
 * drives the synthetic-task rows): the detector needs the tool identity + args
 * and the assistant text, and claude nests BOTH inside one `assistant` event's
 * message.content, with tool RESULTS arriving in a later `user` event carrying
 * is_error. Returns an array (an assistant turn can yield text + a tool_use).
 */
function detectorTurnsFor(event) {
  const t = event?.type
  const out = []
  if (t === 'assistant') {
    const content = event?.message?.content
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'text' && c.text) out.push({ kind: 'assistant', text: c.text })
        if (c?.type === 'tool_use') out.push({ kind: 'tool_use', tool: c.name || 'tool', argsKey: c.input ? JSON.stringify(c.input).slice(0, 200) : '', isError: false })
      }
    }
    return out
  }
  // claude tool RESULT: a user event whose content carries tool_result +
  // is_error. We don't re-signature the action here (the detector already
  // saw the tool_use); a true error just raises the pattern's severity if it
  // recurs, so surface it as an error-flavored repeat of the last action via
  // an out-of-band marker the consumer applies.
  if (t === 'user') {
    const content = event?.message?.content
    if (Array.isArray(content)) {
      const err = content.find(c => c?.type === 'tool_result' && c.is_error)
      if (err) out.push({ kind: 'tool_result_error' })
    }
    return out
  }
  // top-level tool_use (defensive — some backends flatten it)
  if (t === 'tool_use') {
    out.push({ kind: 'tool_use', tool: event.name || event.tool_name || event.tool || 'tool', argsKey: argsKeyFor(event), isError: false })
    return out
  }
  // codex command executions
  if (t === 'item.completed') {
    const item = event.item || {}
    if (item.type === 'command_execution') out.push({ kind: 'tool_use', tool: 'command', argsKey: String(item.command || '').slice(0, 200), isError: item.exit_code != null && item.exit_code !== 0 })
    else if (item.type === 'mcp_tool_call') out.push({ kind: 'tool_use', tool: [item.server, item.tool].filter(Boolean).join('.') || 'mcp_tool', argsKey: '', isError: !!item.error })
    else if (item.type === 'agent_message' && item.text) out.push({ kind: 'assistant', text: item.text })
    return out
  }
  if (t === 'result' || t === 'turn.completed') out.push({ kind: 'result' })
  return out
}

/** Tokens on one usage block, in the field names both backends share. */
function usageTokens(usage) {
  if (!usage) return 0
  return (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0)
}

/**
 * Add consumption to the objective's existing budget-tracking columns.
 *
 * Takes DELTAS, not totals, and is now called per TURN as well as at the
 * terminal event: a loop that runs for minutes used to show tokens_used = 0
 * until the moment it finished, which made every budget number invisible for
 * exactly as long as it was still actionable. Both backends report a
 * cumulative total on their terminal event (claude 'result'.usage, codex
 * 'turn.completed'.usage), so the terminal call adds only what per-turn writes
 * have not already persisted.
 *
 * Never throws — accounting must not mask a completed run.
 */
function recordLoopUsage(db, objectiveId, tokenDelta, toolCallDelta) {
  if (!tokenDelta && !toolCallDelta) return
  try {
    db.prepare(`
      UPDATE objectives SET tokens_used = tokens_used + ?, tool_calls_used = tool_calls_used + ?
      WHERE id = ?
    `).run(tokenDelta, toolCallDelta, objectiveId)
  } catch (err) {
    console.error(`[LoopDispatch] Usage accounting failed for ${objectiveId}:`, err.message)
  }
}

/**
 * QuoxMind (INTELLIGENT dimension): feed a terminal loop into the SAME
 * observe-analyse-learn path the DAG objective path uses
 * (dagUtils.checkObjectiveCompletion). recordOutcome writes an
 * objective_outcomes row from the objective's synthetic task rows, then
 * reflectOnOutcome runs the analyser (license-gated inside dreamCycle).
 *
 * Best-effort by design: a wisdom/analyser failure must never break the
 * loop's own terminal handling (the objective is already completed/failed
 * before this runs), so the whole block is wrapped and only logged.
 *
 * @param {object} db
 * @param {object} objective - the objective row (carries id, org_id, etc.)
 * @param {string} status - the terminal status just written ('completed' | 'failed')
 */
/**
 * QUOXMIND-PROOF (2026-10-15): one agent_performance row per finished loop,
 * attributed to 'loop:<backend>' so QuoxLearn/QuoxValue compare providers on
 * real runs. Loops were the only live objective path on dev and never wrote
 * here, so both implants froze at 2026-03-28. The id never matches a DAG team
 * member, so the decomposer's selectBestAgent is unaffected. Once per
 * objective (task_id = objective id); own try so a failed insert is logged
 * and never blocks the outcome/analyser path.
 */
function recordLoopPerformance(db, objective, status) {
  try {
    if (db.prepare('SELECT 1 FROM agent_performance WHERE task_id = ? LIMIT 1').get(objective.id)) return
    const row = db.prepare('SELECT title, tokens_used, started_at, completed_at FROM objectives WHERE id = ?').get(objective.id) || {}
    const ms = row.started_at && row.completed_at
      ? Math.max(0, Date.parse(`${row.completed_at.replace(' ', 'T')}Z`) - Date.parse(`${row.started_at.replace(' ', 'T')}Z`)) || 0
      : 0
    recordPerformance(objective.org_id, `loop:${objective.loop_backend || DEFAULT_LOOP_BACKEND}`, objective.id, objective.id, {
      success: status === 'completed',
      latencyMs: ms,
      tokensUsed: row.tokens_used || 0,
      domain: inferDomainFromTitle(row.title || objective.title),
      // No per-loop quality grader exists yet: success records the scorer's
      // neutral 50, failure 0. Success rate and latency carry the signal.
      qualityScore: status === 'completed' ? undefined : 0,
    })
  } catch (err) {
    console.warn(`[QuoxLearn] loop agent_performance write failed for ${objective.id}: ${err.message}`)
  }
}

function recordLoopOutcome(db, objective, status) {
  try {
    const tasks = db.prepare('SELECT * FROM tasks WHERE objective_id = ?').all(objective.id)
    const outcome = recordObjectiveOutcome({ ...objective, status }, tasks)
    if (outcome) {
      const outcomeRecord = db.prepare('SELECT * FROM objective_outcomes WHERE objective_id = ?').get(objective.id)
      if (outcomeRecord) {
        void reflectOnOutcome(objective.org_id, objective.id, outcomeRecord)
      }
    }
    recordLoopPerformance(db, objective, status)
    // QLOOP-ENGINE P3 (step a): read-only learning observer. Flag-gated OFF by
    // default; fires only on a clean 'completed' loop that is witnessed
    // (volt_bundle_id). Best-effort, never affects loop finalisation.
    observeCompletedRun(
      buildLearningRun({ kind: 'loop', objective, tasks, status }),
      { emit: emitLearningCandidate },
    )
  } catch (err) {
    console.warn('[QuoxMind] Loop outcome/analysis failed (non-fatal):', err.message)
  }
}

/**
 * Consume the loop session's event stream (fire-and-forget — the loop
 * can run for minutes). One synthetic tasks row per meaningful turn
 * ('assistant' or 'tool_use' event), progress events mirroring
 * quoxflowBridge.pollExecutionStatus's task_completed emission, and a
 * terminal transition on the 'result' event. A stream that ends without
 * a 'result' event (killed, aborted, disconnected) is a failure, not a
 * silent stall.
 */
async function consumeLoopEvents(db, objective, events, startSequenceNum, options = {}) {
  let sequenceNum = startSequenceNum
  let terminal = false
  let toolCallCount = 0

  // Live HITL gates (QLoop feature 4). Running totals are kept here and
  // written through per turn, so the budget the gate judges is the same number
  // the dashboard shows while the loop is still going.
  const nowFn = options.nowFn || (() => Date.now())
  const streamStartedMs = nowFn()
  const gateLatch = createGateLatch()
  let tokensUsed = 0
  let persistedTokens = 0
  let persistedToolCalls = 0

  // QLoop Observer/Knot: watch the turn stream for stuck/oscillation patterns.
  // On a verdict, witness an observer finding (a synthetic row + progress
  // event) and — the "Knot inherits interrupt" behavior — request a kill of
  // the live session via the injected interruptFn (the fleet seam's
  // structured-kill), so a wedged loop is stopped early instead of burning to
  // its max_duration. A NULL interruptFn (tests, or pre-wired deploys) just
  // records the finding.
  const capabilityScope = parseCapabilityScope(objective)
  const backend = objective.loop_backend || DEFAULT_LOOP_BACKEND
  const stuck = createStuckDetector({ threshold: options.stuckThreshold || 3 })
  let interrupted = false

  // QLOOP-ENGINE P1: server-evaluated exit predicate bound to an EXTERNAL
  // observable (metadata.exit_predicate). Absent => behaviour unchanged.
  // QLOOP-ENGINE (default-path guard): when QLOOP_GOAL_CONDITION_EXIT is on, a
  // loop with only a plain goal_condition gets an implicit llm predicate so the
  // model's "done" is still server-checked. Flag OFF (default) => exactly as
  // before. The effective predicate is threaded into evalExit so the same
  // implicit predicate is used both to gate termination and to evaluate it.
  const exitPredicate = getEffectiveExitPredicate(objective, {
    implicitGoalExit: implicitGoalExitEnabled(options.env || process.env),
  })
  const exitDeps = options.exitPredicateDeps || {}
  const evalExit = async (completedTasks = []) => {
    const r = await evaluateExitPredicate(objective, completedTasks, { ...exitDeps, predicate: exitPredicate })
    try {
      const row = db.prepare('SELECT goal_evaluation_log AS l FROM objectives WHERE id = ?').get(objective.id)
      let log = []
      try { log = JSON.parse((row && row.l) || '[]') } catch { log = [] }
      if (!Array.isArray(log)) log = []
      log.push({ iteration: log.length + 1, met: r.met, reason: r.reason, kind: r.kind, source: 'exit_predicate', ts: new Date().toISOString() })
      db.prepare('UPDATE objectives SET goal_evaluation_log = ? WHERE id = ?').run(JSON.stringify(log.slice(-50)), objective.id)
    } catch (err) {
      console.warn(`[LoopDispatch] exit predicate log write failed for ${objective.id}: ${err.message}`)
    }
    return r
  }
  const onStuck = async (verdict) => {
    const message = `QLoop Observer: ${verdict.pattern} — ${verdict.detail}`
    const obsId = ulid()
    db.prepare(`
      INSERT INTO tasks (id, objective_id, org_id, title, agent_id, prompt, sequence_num, depends_on, status, result, created_at, started_at, completed_at)
      VALUES (?, ?, ?, ?, 'observer', NULL, ?, '[]', 'completed', ?, datetime('now'), datetime('now'), datetime('now'))
    `).run(obsId, objective.id, objective.org_id, `Observer: ${verdict.pattern}`, sequenceNum, JSON.stringify(verdict))
    sequenceNum += 1
    emitProgress(objective.id, { type: 'observer_finding', pattern: verdict.pattern, detail: verdict.detail, task_id: obsId })
    if (!interrupted && typeof options.interruptFn === 'function') {
      interrupted = true
      try {
        await options.interruptFn(objective, verdict)
        emitProgress(objective.id, { type: 'observer_interrupt', pattern: verdict.pattern })
      } catch (err) {
        console.error(`[LoopDispatch] Observer interrupt failed for ${objective.id}:`, err.message)
      }
    }
  }

  const markFailed = (message) => {
    // Do NOT clobber an objective a human already terminated. A halt or a gate
    // deny sets status='failed' with its own distinct message (and already fed
    // QuoxMind); the consumer draining the now-killed session then reaches this
    // path (no natural 'result' event arrived, because the process was killed)
    // and would otherwise overwrite that message with a generic one and
    // double-record the outcome. Guarding on a non-terminal status makes this
    // idempotent: if a human already failed it, this is a no-op.
    const res = db.prepare(`
      UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ?
      WHERE id = ? AND status NOT IN ('failed', 'completed', 'cancelled', 'aborted')
    `).run(message.slice(0, 2000), objective.id)
    if (res.changes === 0) return
    emitProgress(objective.id, { type: 'objective_failed', message })
    // INTELLIGENT dimension: feed the failed loop into observe-analyse-learn,
    // exactly as the DAG path does on objective failure. Best-effort inside.
    recordLoopOutcome(db, objective, 'failed')
    // P7: witness the failure on the resident's chain too.
    if (objective.user_id === RESIDENT_AGENT_USER) {
      void (options.continuityCommitFn || postContinuityCommit)({
        orgId: objective.org_id,
        objectiveId: objective.id,
        deltaMd: `[system] Loop ${objective.id} failed: ${String(message).slice(0, 300)}`,
      })
    }
  }

  try {
    for await (const event of events) {
      if (!event || typeof event !== 'object') continue

      // This turn's risk finding, captured where the tool identity and args
      // are in hand, applied after the turn is recorded (gates are evaluated
      // in one place, in one order).
      let riskFinding = null

      // Observer/Knot: feed every detector turn (an assistant event can yield
      // text + a tool_use; a user event carries tool errors).
      for (const dt of detectorTurnsFor(event)) {
        // Scope backstop: the CLI's --allowedTools denies out-of-scope tools
        // before they run, but that enforcement lives on the far side of the
        // fleet seam. Checking the turn stream too means a session that
        // somehow reaches a tool outside its signed scope is witnessed and
        // knotted here, on evidence, rather than trusted to have been denied.
        //
        // The scope is authored in claude's vocabulary, so a non-claude stream
        // is canonicalised before the comparison: without that, EVERY codex
        // command_execution and MCP call in a scoped loop was a false positive.
        // The raw stream name is still accepted, so a scope an operator wrote
        // in a backend's own spelling keeps working.
        if (dt.kind === 'tool_use') {
          const canonicalTool = canonicalToolName(backend, dt.tool)
          // Live risk gate: a destructive shell command or a high-risk governed
          // tool is worth a human's eye WHILE the loop runs, even when it is
          // squarely inside the signed scope.
          riskFinding = riskFinding || riskGateFinding(canonicalTool, dt.argsKey)
          const inScope = isToolInScope(dt.tool, capabilityScope)
            || isToolInScope(canonicalTool, capabilityScope)
          if (!inScope) {
            await onStuck({
              pattern: 'out_of_scope_tool',
              reason: 'out_of_scope_tool',
              tool: canonicalTool,
              raw_tool: dt.tool,
              detail: `tool '${canonicalTool}' is outside this objective's capability_scope`,
            })
          }
        }
        const verdict = dt.kind === 'tool_result_error' ? stuck.flagLastActionError() : stuck.observe(dt)
        if (verdict) await onStuck(verdict)
      }

      const norm = normalizeLoopEvent(event)
      if (!norm) continue

      if (norm.kind === 'turn') {
        const taskId = insertSyntheticTask(db, objective, norm.title, event, sequenceNum)
        sequenceNum += 1
        if (norm.isToolCall) toolCallCount += 1

        // Write consumption through per turn, then judge the gates on it.
        const turnTokens = usageTokens(norm.usage)
        const turnToolCalls = norm.isToolCall ? 1 : 0
        tokensUsed += turnTokens
        recordLoopUsage(db, objective.id, turnTokens, turnToolCalls)
        persistedTokens += turnTokens
        persistedToolCalls += turnToolCalls

        emitProgress(objective.id, { type: 'task_started', task_id: taskId })
        emitProgress(objective.id, { type: 'task_completed', task_id: taskId })

        // AEE-TASK-EVIDENCE (quox#480): a loop turn is a task row, so it owes
        // the same task.started / task.completed evidence the DAG path owes.
        // A turn is discovered already finished (insertSyntheticTask writes it
        // 'completed'), so the pair is written back to back, exactly as the SSE
        // pair above is. There is no loop turn failure intent: a turn that goes
        // wrong surfaces as the session's terminal failure, not a failed row.
        emitLoopTurnEnvelopes(objective, {
          taskId,
          title: norm.title,
          agentId: event.agent_id || 'loop',
          sequenceNum: sequenceNum - 1,
          tokensUsed: turnTokens,
          toolCalls: turnToolCalls,
        })

        evaluateLoopGates(db, objective, {
          latch: gateLatch,
          tokensUsed,
          toolCallsUsed: toolCallCount,
          elapsedMs: nowFn() - streamStartedMs,
          sequenceNum,
          risk: riskFinding,
        })

        // P0b DEC-9: a sandbox-leased loop must not outlive its lease. The
        // grant client caches successful answers 60s, so this per-turn
        // re-check costs at most one auth roundtrip a minute; any lapse
        // (expiry, revocation, flag off, auth unreachable — all fail safe to
        // "no grant") halts the live session through the same structured-kill
        // teeth as the human halt and ends this consumer. Unleased loops
        // (every loop on a real instance) never probe.
        if (objective.sandbox_leased) {
          let stillGranted = false
          try {
            stillGranted = await (options.sandboxGrantFn || hasActiveSandboxApprovalGrant)()
          } catch {
            stillGranted = false
          }
          if (!stillGranted) {
            terminal = true
            await haltLoopForExpiredLease(db, objective, { interruptFn: options.interruptFn })
            break
          }
        }

        // quox#503: kill switch / DEFCON turn-boundary re-check. A per-agent
        // E-STOP pressed mid-flight, or the instance DEFCON dropping to RED,
        // must stop an ALREADY-RUNNING loop, not just block new dispatch —
        // the pre-dispatch gate in agentScheduler.js only runs once, before
        // this session ever spawned. checkSafetyGate fails CLOSED (an
        // unreachable collector reports blocked: true), same posture as the
        // sandbox-lease re-check immediately above, so a network blip halts
        // the loop rather than letting it run blind. Only `blocked` kills
        // the session here — DEFCON ORANGE's escalate/hold is a pre-dispatch
        // decision (autonomyDecision.js), not a reason to kill a loop a
        // human already approved into flight.
        const safetyGate = await (options.safetyGateFn || checkSafetyGate)(objective.org_id, objective.orchestrator_agent_id || 'quox')
        if (safetyGate.blocked) {
          terminal = true
          await haltLoopForSafetyGate(db, objective, safetyGate.reason, { interruptFn: options.interruptFn })
          break
        }

        // QLOOP-ENGINE P1: cheap exit predicates are checked every turn against
        // the external observable; satisfied => the loop ends here, as a
        // completion, and the live session is interrupted (not left to burn
        // to its own stop or cap). llm-kind waits for the result event.
        if (exitPredicate && isCheapPredicate(exitPredicate)) {
          const verdict = await evalExit()
          if (verdict.met) {
            terminal = true
            db.prepare(`
              UPDATE objectives SET status = 'completed', completed_at = datetime('now'), task_count = ?
              WHERE id = ? AND status NOT IN ('failed', 'completed', 'cancelled', 'aborted')
            `).run(sequenceNum, objective.id)
            emitProgress(objective.id, {
              type: 'objective_completed',
              message: `Exit predicate satisfied (${verdict.kind}): ${verdict.reason}`,
              loopSessionId: objective.loop_session_id,
            })
            recordLoopOutcome(db, objective, 'completed')
            if (typeof options.interruptFn === 'function') {
              try { await options.interruptFn(objective, { pattern: 'exit_predicate_met', detail: verdict.reason }) } catch (err) {
                console.error(`[LoopDispatch] Exit-predicate interrupt failed for ${objective.id}:`, err.message)
              }
            }
            break
          }
        }
      } else if (norm.kind === 'result') {
        terminal = true
        // QLOOP-ENGINE P1: the model saying "done" is not evidence. With an
        // exit predicate the external observable has the last word.
        if (exitPredicate) {
          const done = db.prepare("SELECT * FROM tasks WHERE objective_id = ? AND status = 'completed'").all(objective.id)
          const verdict = await evalExit(done)
          if (!verdict.met) {
            recordLoopUsage(db, objective.id, Math.max(0, usageTokens(norm.usage) - persistedTokens), toolCallCount - persistedToolCalls)
            markFailed(`Loop session ended but the exit predicate (${verdict.kind}) was not satisfied: ${verdict.reason}`)
            continue
          }
        }
        recordLoopUsage(db, objective.id, Math.max(0, usageTokens(norm.usage) - persistedTokens), toolCallCount - persistedToolCalls)
        db.prepare(`
          UPDATE objectives SET status = 'completed', completed_at = datetime('now'), task_count = ?
          WHERE id = ?
        `).run(sequenceNum, objective.id)
        emitProgress(objective.id, {
          type: 'objective_completed',
          message: 'Loop session completed',
          loopSessionId: objective.loop_session_id,
        })
        // INTELLIGENT dimension: feed the completed loop into
        // observe-analyse-learn, exactly as the DAG path does on objective
        // completion. Best-effort inside recordLoopOutcome.
        recordLoopOutcome(db, objective, 'completed')
        // P7: the chain never gaps — a system-authored terminal delta lands
        // even when the agent voiced its own commit mid-loop.
        if (objective.user_id === RESIDENT_AGENT_USER) {
          await (options.continuityCommitFn || postContinuityCommit)({
            orgId: objective.org_id,
            objectiveId: objective.id,
            deltaMd: `[system] Loop ${objective.id} completed after ${sequenceNum} turns. Title: ${objective.title}.`,
          })
        }
      } else if (norm.kind === 'failed') {
        terminal = true
        recordLoopUsage(db, objective.id, 0, toolCallCount - persistedToolCalls)
        markFailed(`Loop session failed: ${norm.message}`)
      }
    }
  } catch (err) {
    if (!terminal) markFailed(`Loop session stream error: ${err.message}`)
    return
  }

  if (!terminal) {
    // F10 (first live patrols, 2026-08-15): a resident patrol has no bounded
    // done-condition, so it runs to its turn/duration budget and the fleet
    // spawner kills the session at the cap. A killed session emits no final
    // 'result' event — but if the patrol did REAL work (recorded at least one
    // turn), that is a budget-reached completion, not a crash. Reclassify it
    // as an honest terminal so a working patrol is not reported as failed.
    // A resident patrol that produced NO turns, and every NON-resident loop,
    // still fail on a missing result event (that path is a real crash signal
    // for the DAG-adjacent loops).
    const didWork = sequenceNum > startSequenceNum
    if (objective.user_id === RESIDENT_AGENT_USER && didWork) {
      terminal = true
      db.prepare(`
        UPDATE objectives SET status = 'completed', completed_at = datetime('now'),
          task_count = ?, error_message = ?
        WHERE id = ?
      `).run(sequenceNum, `Patrol reached its turn/duration budget after ${sequenceNum} turns (patrol_budget_reached)`, objective.id)
      emitProgress(objective.id, {
        type: 'objective_completed',
        message: `Patrol completed at budget after ${sequenceNum} turns`,
        loopSessionId: objective.loop_session_id,
      })
      recordLoopOutcome(db, objective, 'completed')
      if (options.continuityCommitFn || postContinuityCommit) {
        await (options.continuityCommitFn || postContinuityCommit)({
          orgId: objective.org_id,
          objectiveId: objective.id,
          deltaMd: `[system] Patrol ${objective.id} reached its turn/duration budget after ${sequenceNum} turns.`,
        })
      }
    } else {
      markFailed('Loop session ended without a result event')
    }
  }
}

/**
 * Dispatch a loop-mode objective. Mirrors dispatchObjective's shape
 * (validate -> kick off -> persist ids -> attach tracked fire-and-forget
 * work -> return immediately) but has no pre-planned task list to hand
 * to QuoxFlow — the loop discovers its own turns.
 *
 * @param {object} objective - the full objective row (execution_mode === 'loop')
 * @param {Array} tasks - any pre-existing task rows (normally empty for loop mode)
 * @param {object} [options]
 * @param {object} [options.db] - injected db handle (defaults to getDatabase())
 * @param {Function} [options.loopSpawner] - see SEAM CONTRACT above
 * @returns {Promise<{success: boolean, loopSessionId?: string, error?: string}>}
 */
export async function dispatchLoopObjective(objective, tasks, options = {}) {
  const { getDatabase } = await import('../db/index.js')
  const db = options.db || getDatabase()

  // P1 DEC-6: empty/malformed capability_scope = DENY-ALL, enforced by
  // refusing the dispatch loudly. Before this check, a scope-less loop
  // spawned with NO --allowedTools (an unrestricted CLI) and the per-turn
  // backstop waved everything through — deny-by-default silently inverted to
  // allow-everything exactly when the value was missing.
  let capabilityScope = null
  let scopeProblem = null
  try {
    const parsed = JSON.parse(objective.capability_scope || 'null')
    if (Array.isArray(parsed) && parsed.length > 0) capabilityScope = parsed
    else if (Array.isArray(parsed)) scopeProblem = 'capability_scope is an empty list'
    else scopeProblem = 'capability_scope is missing or not a list'
  } catch {
    scopeProblem = 'capability_scope is unparseable JSON'
  }
  if (scopeProblem) {
    const error = `Loop refused: ${scopeProblem} — a loop objective must carry an explicit non-empty capability_scope (deny-by-default, DEC-6). Author one (see loopScopePresets.js) and retry.`
    db.prepare(`
      UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ?
      WHERE id = ?
    `).run(error, objective.id)
    emitProgress(objective.id, { type: 'objective_failed', message: error })
    return { success: false, error }
  }
  // quox#503: kill switch / DEFCON pre-spawn gate. Belt-and-suspenders with
  // agentScheduler.js's pre-dispatch check (which a loop objective may
  // bypass — teamScheduler / approve-plan HTTP also reach dispatchObjective)
  // and with the per-turn re-check below in consumeLoopEvents: refuse to
  // ever spawn a session for an agent that is already halted, rather than
  // spawning it and killing it one turn later.
  const preSpawnGate = await (options.safetyGateFn || checkSafetyGate)(objective.org_id, objective.orchestrator_agent_id || 'quox')
  if (preSpawnGate.blocked) {
    const error = `Loop refused: ${preSpawnGate.reason}`
    db.prepare(`
      UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ?
      WHERE id = ?
    `).run(error.slice(0, 2000), objective.id)
    emitProgress(objective.id, { type: 'objective_failed', message: error })
    return { success: false, error }
  }

  const maxDurationMs = objective.max_duration_ms
  const maxTurns = objective.max_iterations
  const backend = objective.loop_backend || DEFAULT_LOOP_BACKEND
  const spawner = options.loopSpawner || defaultLoopSpawner

  let sessionId, events
  try {
    // Built inside the try so an unverified/unknown backend fails through the
    // same path as a spawn failure (objective marked failed, no phantom row).
    // Codex cannot enforce argument patterns, so a patterned scope on a codex
    // loop would be silently widened: reject it here, loudly, before any spawn.
    // claude honors --allowedTools patterns and is unaffected.
    getLoopProvider(backend)?.assertScopeHonorable(capabilityScope)
    // P7 CONTINUITY: mandatory recall stage for resident loops. Fail-closed
    // like DEC-6: a resident that cannot become its prior self does not run.
    let inputObjective = objective
    if (objective.user_id === RESIDENT_AGENT_USER) {
      let recall
      try {
        recall = await (options.continuityRecallFn || fetchContinuityRecall)(objective.org_id, RESIDENT_AGENT_USER)
      } catch (err) {
        throw new Error(`continuity recall unavailable (${err.message}) — a resident loop must become its prior self before acting; refusing to dispatch`)
      }
      inputObjective = { ...objective, description: `${renderRecallPreamble(recall)}\n\n${objective.description || ''}` }
    }
    const { payload, args } = buildLoopInput(inputObjective, backend, capabilityScope)
    // WHY: the human-approved before_start checkpoint's inbox item anchors the
    // Bastion approval grant the collector mints for this spawn. None found
    // (scheduler / skip-checkpoint) means null: grantless, unchanged.
    const approvalRow = db.prepare(`
      SELECT inbox_item_id FROM checkpoints
      WHERE objective_id = ? AND checkpoint_type = 'before_start' AND status = 'approved' AND inbox_item_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(objective.id)
    const spawned = await spawner({
      objective,
      approvalItemId: approvalRow?.inbox_item_id || null,
      backend,
      payload,
      args,
      capabilityScope,
      toolAccess: buildToolAccess(objective, capabilityScope),
      maxDurationMs,
      maxTurns,
      orgId: objective.org_id,
    })
    sessionId = spawned?.sessionId
    events = spawned?.events
    if (!sessionId || !events) {
      throw new Error('loopSpawner returned no sessionId/events')
    }
  } catch (err) {
    const error = err.message || 'Loop spawn failed'
    db.prepare(`
      UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ?
      WHERE id = ?
    `).run(error.slice(0, 2000), objective.id)
    emitProgress(objective.id, { type: 'objective_failed', message: error })
    return { success: false, error }
  }

  // P0b DEC-9 (leased, not latched): a loop dispatched while the sandbox
  // approval grant is active (disposable_test instance + unexpired
  // test-approver lease, read server-side from auth) is stamped leased; its
  // consumer re-checks the grant every turn and halts the session the moment
  // the lease lapses. On a real instance the grant is never active, so this
  // is always 0 there and nothing changes. Fail-safe: a check that errors
  // leaves the loop unleased (the lease-halt leash is a sandbox behaviour,
  // never something an auth blip should strap onto a real loop).
  const sandboxGrantFn = options.sandboxGrantFn || hasActiveSandboxApprovalGrant
  let sandboxLeased = 0
  try {
    sandboxLeased = (await sandboxGrantFn()) ? 1 : 0
  } catch {
    sandboxLeased = 0
  }

  db.prepare(`
    UPDATE objectives SET status = 'running', started_at = COALESCE(started_at, datetime('now')),
    loop_session_id = ?, sandbox_leased = ?
    WHERE id = ?
  `).run(sessionId, sandboxLeased, objective.id)

  emitProgress(objective.id, {
    type: 'objective_started',
    message: 'Executing via loop session',
    loopSessionId: sessionId,
  })

  // Fire-and-forget: the loop can run for minutes. trackPoll() so the
  // reaper sees this objective as attended (same reasoning as the DAG
  // path's QuoxFlow poller in objectiveDispatch.js).
  const consumerPromise = trackPoll(
    objective.id,
    consumeLoopEvents(db, { ...objective, loop_session_id: sessionId, sandbox_leased: sandboxLeased }, events, tasks.length, {
      exitPredicateDeps: options.exitPredicateDeps,
      env: options.env,
      stuckThreshold: options.stuckThreshold,
      sandboxGrantFn: options.sandboxGrantFn,
      // Observer/Knot interrupt: default wiring kills the live session via the
      // fleet seam (collector /dev-sessions/:id/interrupt -> agent
      // structured-kill). Tests inject their own interruptFn (or null).
      interruptFn: options.interruptFn !== undefined ? options.interruptFn : defaultInterruptFn,
    }).catch(err => {
      console.error(`[LoopDispatch] Event consumer error for ${objective.id}:`, err.message)
    })
  )
  // Test seam: callers (tests) can await options.consumerPromise to
  // deterministically wait for the fire-and-forget consumer instead of
  // sleeping.
  options.consumerPromise = consumerPromise

  return { success: true, loopSessionId: sessionId }
}
