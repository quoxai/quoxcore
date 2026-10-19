/**
 * QuoxFlow Bridge — QE2 Phase 6
 *
 * Routes objective execution through QuoxFlow instead of the legacy
 * task executor. Takes parsed tasks from the decomposer and:
 *
 * 1. Converts them to a QuoxFlow workflow (via workflowConverter)
 * 2. Creates the workflow via QuoxFlow API
 * 3. Executes it
 * 4. Returns the workflow ID and execution ID
 *
 * The objective record in the tasks service DB stores the QuoxFlow
 * IDs for status tracking and UI linking.
 */

import { convertTasksToWorkflow } from './workflowConverter.js'
import { appendTaskSummary } from './teamLoader.js'
import { recordPerformance, computeQualityScore, inferDomainFromTitle } from './agentScorer.js'

// AEE-FULL Gap 3: dual-read both legacy and canonical LLM completion/failure
// intents. Historical envelopes are WARD-immutable; new envelopes carry
// quox.flow.llm.*. Canonical source: src/lib/aee/llmIntents.js (dashboard).
// MUST stay in sync with that file — duplication is intentional because the
// tasks service is a separate Node process that cannot cross-import dashboard
// frontend source. Update both if the intent union changes.
const LLM_COMPLETED_INTENTS = ['quox.flow.llm.completed', 'quox.flow.agent.completed', 'ops.assistant.invoked', 'agentic.think']
const LLM_FAILED_INTENTS = ['quox.flow.llm.failed', 'quox.flow.agent.failed']

const QUOXFLOW_URL = process.env.QUOXFLOW_URL || 'http://quoxflow:3200'

/**
 * MACH-FOLLOWUP WI-B: normalise an envelope's raw tool-call payload into a
 * deduped array of tool-name strings. Entries may be plain strings or
 * objects (e.g. `{ name: 'ssh_exec' }` / `{ tool: 'ssl_certificates' }`) —
 * both quoxflow's `agent-invoke.executor.ts` (tool_calls) and collector's
 * `/api/internal/agents/invoke` (tools_used) shapes are tolerated. Capped
 * at 100 entries to bound row size on pathological runs.
 */
function normalizeToolsUsed(raw) {
  if (!Array.isArray(raw)) return []
  const names = raw
    .map(entry => {
      if (entry && typeof entry === 'object') return entry.name ?? entry.tool ?? String(entry)
      return entry == null ? '' : String(entry)
    })
    .filter(Boolean)
  return Array.from(new Set(names)).slice(0, 100)
}

/**
 * Execute parsed tasks via QuoxFlow instead of the legacy executor.
 *
 * @param {Array} tasks - [{title, agent_id, prompt, depends_on}]
 * @param {Object} options
 * @returns {{ success, workflowId?, executionId?, error? }}
 */
export async function executeViaQuoxFlow(tasks, options = {}) {
  const {
    objectiveId,
    objectiveTitle,
    orgId,
    userId,
    teamId,
    maxTokens,
    maxToolCalls,
    maxDurationMs,
    quoxflowUrl,
  } = options

  const baseUrl = quoxflowUrl || QUOXFLOW_URL
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || ''

  // 1. Convert tasks to QuoxFlow workflow
  const workflow = convertTasksToWorkflow(tasks, {
    objectiveId,
    objectiveTitle,
    orgId,
    userId,
    teamId,
    maxTokens,
    maxToolCalls,
    maxDurationMs,
  })

  // 2. Create workflow via QuoxFlow API
  let workflowId
  try {
    const createRes = await fetch(`${baseUrl}/api/workflows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(serviceKey ? { 'x-service-key': serviceKey } : {}),
        // QF-MT WP8 completion: the write path must carry X-Org-Id just like
        // the read path (pollExecutionStatus below). WP8 org-scoped reads but
        // missed these two writes, so once quoxflow enforced org-scope on
        // /api/workflows the whole approve-plan→execute spine 500'd with
        // "Org scope required". Source orgId the same way reads do.
        ...(orgId ? { 'X-Org-Id': orgId } : {}),
      },
      body: JSON.stringify(workflow),
      signal: AbortSignal.timeout(15000),
    })

    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => `HTTP ${createRes.status}`)
      return { success: false, error: `QuoxFlow workflow creation failed: ${errText}` }
    }

    const createData = await createRes.json()
    workflowId = createData?.data?.id || createData?.id
    if (!workflowId) {
      return { success: false, error: 'QuoxFlow workflow creation returned no ID' }
    }
  } catch (err) {
    return { success: false, error: `QuoxFlow workflow creation failed: ${err.message}` }
  }

  // 3. Execute workflow
  let executionId
  try {
    const execRes = await fetch(`${baseUrl}/api/workflows/${workflowId}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(serviceKey ? { 'x-service-key': serviceKey } : {}),
        // QF-MT WP8 completion (see create call above): org-scope the execute write too.
        ...(orgId ? { 'X-Org-Id': orgId } : {}),
      },
      body: JSON.stringify({
        // P8.F HITL-ORGID-PLUMB: orgId at top level for first-class plumb-through
        // into ExecutionContext. Also included in triggerData for legacy compatibility.
        ...(orgId ? { orgId } : {}),
        triggerData: {
          objectiveId,
          objectiveTitle,
          orgId,
          userId,
        },
        async: true,
      }),
      signal: AbortSignal.timeout(15000),
    })

    if (!execRes.ok) {
      const errText = await execRes.text().catch(() => `HTTP ${execRes.status}`)
      return { success: false, error: `QuoxFlow execution failed: ${errText}`, workflowId }
    }

    const execData = await execRes.json()
    executionId = execData?.data?.executionId || execData?.executionId || execData?.data?.id
  } catch (err) {
    return { success: false, error: `QuoxFlow execution failed: ${err.message}`, workflowId }
  }

  return {
    success: true,
    workflowId,
    executionId,
  }
}

/**
 * Poll QuoxFlow execution status and sync back to tasks service DB.
 * Fire-and-forget — called after approve-plan returns.
 *
 * Updates individual task statuses and objective completion based on
 * QuoxFlow node execution results.
 */
export async function pollExecutionStatus(executionId, objectiveId, taskIds, options = {}) {
  const baseUrl = options.quoxflowUrl || QUOXFLOW_URL
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || ''
  // QF-MT WP8: reads carry X-Org-Id sourced the same way the write path
  // (executeViaQuoxFlow above) sources orgId — from options.orgId — so
  // quoxflow scopes the execution/envelope reads to this objective's org
  // instead of falling back to unscoped service-key/system scope.
  const orgId = options.orgId || 'default'
  const headers = {
    'Content-Type': 'application/json',
    ...(serviceKey ? { 'x-service-key': serviceKey } : {}),
    'X-Org-Id': orgId,
  }
  const { getDatabase } = await import('../db/index.js')
  const { emitProgress } = await import('./progress.js')
  const { checkObjectiveCompletion } = await import('./dagUtils.js')
  // AEE-TASK-EVIDENCE (quox#480): task-lifecycle envelopes died with
  // executor.js in QE2 Phase 6 and this poller only ever emitted SSE. The
  // envelope emission is restored here, on the shapes the old emitter wrote.
  const { createTaskEnvelope, TASK_INTENTS, hasTaskEnvelope } = await import('./envelopes.js')

  const maxPollMs = options.maxPollMs || 900000 // 15 min max (agentic runs need time)
  const pollInterval = options.pollInterval || 3000 // 3s
  const startTime = Date.now()

  while (Date.now() - startTime < maxPollMs) {
    await new Promise(r => setTimeout(r, pollInterval))

    try {
      const res = await fetch(`${baseUrl}/api/executions/${executionId}`, {
        headers,
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        console.warn(`[QuoxFlow Poller] GET /api/executions/${executionId} returned ${res.status}: ${errText.slice(0, 200)}`)
        continue
      }

      const data = await res.json()
      const exec = data?.data || data

      // Fix 1+2: Check for agentic pause (CAPTCHA, login, needs_human)
      if (exec.status === 'completed' && exec.output?.paused === true) {
        const db = getDatabase()
        const pauseReason = exec.output.pauseReason || 'Agent needs human assistance'
        const sessionId = exec.output.session_id || ''
        console.log(`[QuoxFlow Poller] Execution ${executionId} PAUSED: ${pauseReason}`)

        // Set objective to paused
        db.prepare("UPDATE objectives SET status = 'paused' WHERE id = ?").run(objectiveId)

        // Emit SSE event
        emitProgress(objectiveId, {
          type: 'agentic_paused',
          pauseReason,
          session_id: sessionId,
          executionId,
        })

        // Create HITL inbox item
        try {
          const authUrl = process.env.AUTH_URL || 'http://auth:3101'
          await fetch(`${authUrl}/api/internal/orgs/${orgId}/inbox`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              kind: 'browser_assistance',
              priority: 'high',
              title: `Browser agent needs help: ${pauseReason.substring(0, 60)}`,
              body_md: `The browser agent paused during execution.\n\n**Reason:** ${pauseReason}\n\nOpen BrowserQ or Mission Control to assist.`,
              payload: { objective_id: objectiveId, execution_id: executionId, session_id: sessionId, pause_reason: pauseReason },
              tasks_objective_id: objectiveId,
              quoxflow_execution_id: executionId,
            }),
            signal: AbortSignal.timeout(5000),
          })
          console.log(`[QuoxFlow Poller] HITL inbox item created for ${objectiveId}`)
        } catch (inboxErr) {
          console.error(`[QuoxFlow Poller] HITL inbox creation failed:`, inboxErr.message)
        }
        return // Stop polling — objective is paused, waiting for human
      }

      // Emit progress while still running
      if (exec.status === 'running') {
        emitProgress(objectiveId, {
          type: 'progress_update',
          status: 'running',
          duration_ms: exec.duration || (Date.now() - startTime),
          engine: 'quoxflow',
          executionId,
        })
        continue
      }

      console.log(`[QuoxFlow Poller] Execution ${executionId}: status=${exec.status} duration=${exec.duration || 0}ms`)

      // Check if execution has completed
      if (exec.status === 'completed' || exec.status === 'failed') {
        const db = getDatabase()

        console.log(`[QuoxFlow Poller] Execution ${executionId} ${exec.status} — fetching envelopes for ${taskIds.length} tasks`)
        // Fetch per-node results from QuoxFlow envelopes
        let nodeResults = new Map()
        try {
          const envRes = await fetch(`${baseUrl}/api/executions/${executionId}/envelopes`, {
            headers,
            signal: AbortSignal.timeout(10000),
          })
          if (envRes.ok) {
            const envData = await envRes.json()
            // QuoxFlow returns { success, data: { envelopes: [...] } }
            const envelopes = Array.isArray(envData) ? envData
              : Array.isArray(envData?.data?.envelopes) ? envData.data.envelopes
              : Array.isArray(envData?.data) ? envData.data
              : Array.isArray(envData?.envelopes) ? envData.envelopes
              : []
            if (envelopes.length === 0) {
              console.warn(`[QuoxFlow] No envelopes found for execution ${executionId}`)
            }
            // Extract node completion envelopes (one per node)
            for (const env of envelopes) {
              const isNodeLifecycle = env.intent === 'quox.flow.node.completed' || env.intent === 'quox.flow.node.failed'
              const isLlmEvent = LLM_COMPLETED_INTENTS.includes(env.intent) || LLM_FAILED_INTENTS.includes(env.intent)
              if (isNodeLifecycle || isLlmEvent) {
                const nodeId = env.payload?.nodeId
                if (nodeId) {
                  // tokens_used: v1 envelopes split tokens_input/output; sum them for legacy compatibility.
                  // Legacy envelopes have opaque tokens_used; pass through.
                  const tokensUsed =
                    typeof env.payload?.tokens_input === 'number' || typeof env.payload?.tokens_output === 'number'
                      ? (env.payload?.tokens_input || 0) + (env.payload?.tokens_output || 0)
                      : env.payload?.tokens_used || 0
                  // MACH-FOLLOWUP WI-B: the llm.completed envelope carries
                  // `tool_calls` (agent-invoke.executor.ts:262); node output /
                  // collector-forwarded envelopes may instead carry
                  // `tools_used` or a nested `result.tools_used`. Try all
                  // three shapes; `agent:agentic` (browser-q) nodes carry
                  // none of these (action_log ≠ tools — out of scope v1) and
                  // correctly fall through to an empty array.
                  const rawToolCalls = Array.isArray(env.payload?.tool_calls) ? env.payload.tool_calls
                    : Array.isArray(env.payload?.tools_used) ? env.payload.tools_used
                    : Array.isArray(env.payload?.result?.tools_used) ? env.payload.result.tools_used
                    : []
                  nodeResults.set(nodeId, {
                    success: env.payload?.success !== false,
                    result: env.payload?.result || env.payload,
                    duration_ms: env.payload?.duration_ms || 0,
                    tokens_used: tokensUsed,
                    tools_used: normalizeToolsUsed(rawToolCalls),
                    agent_id: env.payload?.agent_id,
                  })
                }
              }
            }
          } else {
            const errText = await envRes.text().catch(() => '')
            console.warn(`[QuoxFlow Poller] GET /api/executions/${executionId}/envelopes returned ${envRes.status}: ${errText.slice(0, 200)}`)
          }
        } catch (envErr) {
          console.error(`[QuoxFlow Poller] Envelope fetch error for ${executionId}:`, envErr.message)
        }

        console.log(`[QuoxFlow Poller] Found ${nodeResults.size} node results for ${taskIds.length} tasks`)

        // MACHINERY-4a: resolve team_instance_id once so per-task shared
        // context writes below only run for team objectives.
        // AEE-TASK-EVIDENCE (quox#480): the same read now also carries the
        // objective context the task envelopes need (title, corr_id, team,
        // orchestrator), so the envelope payloads match the pre-QE2 shapes.
        const objectiveRow = db.prepare(
          'SELECT team_instance_id, title, corr_id, team_id, orchestrator_agent_id FROM objectives WHERE id = ?'
        ).get(objectiveId)
        const teamInstanceId = objectiveRow?.team_instance_id || null
        // Task rows are now fetched for EVERY objective, not just team ones:
        // the envelopes need title/agent_id/prompt/depends_on/retry_count
        // whether or not a team instance is attached.
        let taskMetaById = new Map()
        if (taskIds.length > 0) {
          const rows = db.prepare(
            `SELECT id, org_id, title, agent_id, prompt, depends_on, sequence_num, retry_count, metadata FROM tasks WHERE id IN (${taskIds.map(() => '?').join(',')})`
          ).all(...taskIds)
          taskMetaById = new Map(rows.map(r => [r.id, r]))
        }

        // Resolve dependency titles once per poll for the task.started
        // payload's `depends_on` (the old executor read them per task).
        const depTitleFor = (meta) => {
          try {
            const depIds = JSON.parse(meta?.depends_on || '[]')
            if (!Array.isArray(depIds) || depIds.length === 0) return []
            return depIds
              .map(id => taskMetaById.get(id))
              .filter(Boolean)
              .map(d => ({ id: d.id, title: d.title, agent_id: d.agent_id }))
          } catch {
            return []
          }
        }

        // Update each task with its corresponding node result
        for (let i = 0; i < taskIds.length; i++) {
          const nodeId = `task-${i}`
          const nodeResult = nodeResults.get(nodeId)

          let taskStatus, taskResult, durationMs, tokensUsed, toolsUsed
          if (nodeResult) {
            taskStatus = nodeResult.success ? 'completed' : 'failed'
            const r = nodeResult.result
            taskResult = typeof r === 'string' ? r : JSON.stringify(r)
            durationMs = nodeResult.duration_ms
            tokensUsed = nodeResult.tokens_used
            toolsUsed = nodeResult.tools_used
          } else {
            // Node has no result envelope — it was skipped or never reached
            taskStatus = 'skipped'
            taskResult = 'No execution result — node was skipped or not reached'
            durationMs = 0
            tokensUsed = 0
            toolsUsed = []
          }

          db.prepare(`
            UPDATE tasks SET status = ?, result = ?, completed_at = datetime('now'),
            duration_ms = ?, tokens_used = ?, tools_used = ?
            WHERE id = ?
          `).run(
            taskStatus,
            (typeof taskResult === 'string' ? taskResult : JSON.stringify(taskResult)).slice(0, 10000),
            durationMs,
            tokensUsed,
            // MACH-FOLLOWUP WI-B: always a JSON-array string. '[]' = measured
            // zero (executed, no tool calls); NULL is reserved for legacy
            // rows written before this column was populated.
            JSON.stringify(toolsUsed),
            taskIds[i]
          )

          emitProgress(objectiveId, {
            type: taskStatus === 'completed' ? 'task_completed' : (taskStatus === 'failed' ? 'task_failed' : 'task_skipped'),
            task_id: taskIds[i],
          })

          // QUOXMIND-PROOF (2026-10-15): feed QuoxLearn / QuoxValue and the
          // decomposer's selectBestAgent. recordPerformance() lost both callers
          // when the legacy executor was deleted (QE2 Phase 6), freezing
          // agent_performance at 2026-03-28 while the router kept scoring on it.
          // A skipped task never ran, so it records nothing. Best-effort: a
          // failed insert is logged, never breaks the poll. Once per task: the
          // reconciler can re-poll an objective (same reason the envelopes
          // below check hasTaskEnvelope), and a re-poll must not double-count.
          if ((taskStatus === 'completed' || taskStatus === 'failed') &&
              !db.prepare('SELECT 1 FROM agent_performance WHERE task_id = ? LIMIT 1').get(taskIds[i])) {
            try {
              const meta = taskMetaById.get(taskIds[i]) || {}
              let domain = null
              try { domain = JSON.parse(meta.metadata || '{}')?.domain || null } catch { domain = null }
              recordPerformance(meta.org_id || orgId, meta.agent_id || 'unknown', taskIds[i], objectiveId, {
                success: taskStatus === 'completed',
                latencyMs: durationMs,
                tokensUsed,
                domain: domain || inferDomainFromTitle(meta.title),
                qualityScore: taskStatus === 'completed'
                  ? computeQualityScore({ result: taskResult, toolsUsed: (toolsUsed || []).length, wasRetry: (meta.retry_count || 0) > 0 })
                  : 0,
              })
            } catch (err) {
              console.warn(`[QuoxLearn] agent_performance write failed for task ${taskIds[i]}: ${err.message}`)
            }
          }

          // AEE-TASK-EVIDENCE (quox#480): write the task lifecycle to the
          // envelopes table alongside the SSE emit above.
          //
          // Boundary honesty: QuoxFlow owns the actual moment a node starts,
          // and this poller only learns the outcome, so task.started is
          // written retroactively here, at the same poll pass as its
          // terminal envelope. `duration_ms` on the terminal envelope is
          // what recovers the real start time. A skipped task never ran and
          // therefore gets NO started envelope, and no terminal one either:
          // 'skipped' is not a lifecycle outcome the AEE intent set names,
          // and inventing one would be worse evidence than none.
          const meta = taskMetaById.get(taskIds[i]) || {}
          if (taskStatus !== 'skipped') {
            const agentId = nodeResult?.agent_id || meta.agent_id || 'quox'
            if (!hasTaskEnvelope(taskIds[i], TASK_INTENTS.TASK_STARTED)) {
              createTaskEnvelope({
                type: 'event', from: 'service.tasks', to: `agent.${agentId}`,
                intent: TASK_INTENTS.TASK_STARTED,
                payload: {
                  task_id: taskIds[i],
                  title: meta.title,
                  agent_id: agentId,
                  sequence_num: meta.sequence_num,
                  objective_title: objectiveRow?.title,
                  prompt: (meta.prompt || '').slice(0, 1000),
                  depends_on: depTitleFor(meta),
                  team_id: objectiveRow?.team_id || undefined,
                  orchestrator: objectiveRow?.orchestrator_agent_id || undefined,
                  retry_count: parseInt(meta.retry_count || '0', 10) || undefined,
                  engine: 'quoxflow',
                  execution_id: executionId,
                },
                corrId: objectiveRow?.corr_id, objectiveId, taskId: taskIds[i],
              })
            }

            const terminalIntent = taskStatus === 'completed' ? TASK_INTENTS.TASK_COMPLETED : TASK_INTENTS.TASK_FAILED
            if (!hasTaskEnvelope(taskIds[i], terminalIntent)) {
              const resultStr = typeof taskResult === 'string' ? taskResult : JSON.stringify(taskResult)
              const basePayload = {
                task_id: taskIds[i],
                title: meta.title,
                agent_id: agentId,
                duration_ms: durationMs,
                objective_title: objectiveRow?.title,
                engine: 'quoxflow',
                execution_id: executionId,
              }
              createTaskEnvelope({
                type: 'event', from: `agent.${agentId}`, to: 'service.tasks',
                intent: terminalIntent,
                payload: taskStatus === 'completed'
                  ? {
                      ...basePayload,
                      tokens_used: tokensUsed,
                      tool_calls: Array.isArray(toolsUsed) ? toolsUsed.length : 0,
                      tools_used: Array.isArray(toolsUsed) ? toolsUsed.slice(0, 20) : undefined,
                      result_preview: (resultStr || '').slice(0, 500),
                    }
                  : {
                      ...basePayload,
                      // The failure reason travels in the node result, not an
                      // Error object, so error_type is the honest constant
                      // 'NodeFailure' rather than a fabricated JS error name.
                      error: (resultStr || 'Task failed').slice(0, 1000),
                      error_type: 'NodeFailure',
                      retry_count: parseInt(meta.retry_count || '0', 10),
                      prompt_preview: (meta.prompt || '').slice(0, 300),
                    },
                corrId: objectiveRow?.corr_id, objectiveId, taskId: taskIds[i],
              })
            }
          }

          // MACHINERY-4a: feed a compact structured summary of this task's
          // outcome into the team instance's shared context so subsequent
          // member task prompts (built at the next dispatch — e.g. a
          // re-observe round) can see what happened. Skipped tasks carry
          // no meaningful result and are omitted.
          if (teamInstanceId && (taskStatus === 'completed' || taskStatus === 'failed')) {
            const resultStr = typeof taskResult === 'string' ? taskResult : JSON.stringify(taskResult)
            appendTaskSummary(teamInstanceId, {
              task_id: taskIds[i],
              role: meta?.agent_id || 'unknown',
              status: taskStatus,
              result_summary: resultStr.slice(0, 500),
              completed_at: new Date().toISOString(),
            })
          }
        }

        // Sync objective counters from actual task states + roll up token usage.
        // Source-of-truth is the tasks table — re-summing on each poll keeps
        // the objective in sync without needing an idempotent counter.
        const taskAgg = db.prepare(`
          SELECT
            COUNT(*)                                        AS n,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
            COALESCE(SUM(tokens_used), 0)                   AS tokens
          FROM tasks WHERE objective_id = ?
        `).get(objectiveId)

        // MACH-FOLLOWUP WI-B: tool_calls_used roll-up. SQLite can't sum JSON
        // array lengths portably, so compute in JS from each task's
        // tools_used column (already written above in this same poll pass).
        // This makes the previously-dead objectives.tool_calls_used counter
        // live for the first time — its only prior writer, budget.js's
        // recordUsage(), has zero callers and is left untouched (flagged,
        // not deleted — see STREAM_MACH_FOLLOWUP_PLAN.md §10).
        const toolsUsedRows = db.prepare(`SELECT tools_used FROM tasks WHERE objective_id = ?`).all(objectiveId)
        const toolCallsUsed = toolsUsedRows.reduce((sum, row) => {
          if (!row.tools_used) return sum
          try {
            const arr = JSON.parse(row.tools_used)
            return sum + (Array.isArray(arr) ? arr.length : 0)
          } catch {
            return sum
          }
        }, 0)

        db.prepare(`
          UPDATE objectives
          SET tasks_completed = ?, tasks_failed = ?, task_count = ?, tokens_used = ?, tool_calls_used = ?
          WHERE id = ?
        `).run(taskAgg.completed, taskAgg.failed, taskAgg.n, taskAgg.tokens, toolCallsUsed, objectiveId)

        // Run objective completion logic (VOLT, QuoxMind, team instance, etc.)
        checkObjectiveCompletion(objectiveId)
        return
      }
    } catch {
      // Non-fatal — continue polling
    }
  }

  // Timeout — mark objective as failed
  try {
    const db = getDatabase()
    const timeoutMsg = `QuoxFlow execution polling timed out after ${Math.round(maxPollMs / 1000)}s (executionId=${executionId})`
    db.prepare(`UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ? WHERE id = ?`)
      .run(timeoutMsg, objectiveId)
    emitProgress(objectiveId, { type: 'objective_failed', message: timeoutMsg })
  } catch { /* best effort */ }
}
