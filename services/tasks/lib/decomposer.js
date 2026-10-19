// Objective → task DAG decomposition via collector LLM
import { ulid } from 'ulid'
import { getDatabase } from '../db/index.js'
import { emitProgress } from './progress.js'
import { createTaskEnvelope, TASK_INTENTS } from './envelopes.js'
import { getTeamDefinition } from './teamLoader.js'
import { selectBestAgent } from './agentSelector.js'
import { inferDomainFromTitle } from './agentScorer.js'
import { scorePriority } from './priorityScorer.js'
import { isPluginLicensed } from './licenseGate.js'
import { fetchAgentCapabilities, buildAgentListWithTools, applyToolAwareAssignment, STATIC_CAPABILITY_SNAPSHOT } from './agentCapabilities.js'
import { canExecuteResource, recordResourceFailure, recordResourceSuccess, CircuitBreakerOpenError } from './resourceBreaker.js'

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://collector:9848'

// QM-6: Fleet batch decomposition heuristic
const FLEET_PATTERNS = [
  /(\d+)\s*(?:hosts?|servers?|nodes?|machines?|instances?)/i,
  /all\s+(?:\d+\s+)?(?:hosts?|servers?|nodes?|machines?)/i,
  /every\s+(?:host|server|node|machine)/i,
  /across\s+(?:the\s+)?fleet/i,
  /fleet[\s-]*wide/i,
  /across\s+all/i,
  /all\s+bastion/i,
  /all\s+docker/i,
  /all\s+proxmox/i,
]

const FLEET_COUNT_PATTERN = /(\d+)\s*(?:hosts?|servers?|nodes?|machines?|instances?)/i

const FLEET_BATCH_DIRECTIVE = `
--- FLEET OPERATION DETECTED ---
MANDATORY: Do NOT create a single task that operates on all hosts simultaneously.
Instead, create tasks in this pattern:
1. Canary: operate on 1 host first, verify success
2. Batch 1: operate on next 5 hosts (depends on canary success)
3. Batch 2-N: remaining hosts in groups of 5-8 (each depends on previous batch)
4. Final: verify all hosts, compile report
If any batch has >20% failure rate, subsequent batches should check conditions before proceeding.
This prevents timeout failures from sequential operations on large host counts.
--- END FLEET DIRECTIVE ---
`

/**
 * QM-6: Detect fleet operations from objective text.
 * Returns { isFleetOperation, hostCount } where hostCount may be null.
 */
function detectFleetOperation(title, description) {
  const text = `${title || ''} ${description || ''}`
  for (const pattern of FLEET_PATTERNS) {
    if (pattern.test(text)) {
      const countMatch = text.match(FLEET_COUNT_PATTERN)
      const hostCount = countMatch ? parseInt(countMatch[1], 10) : null
      // Only trigger for counts > 5 when a number is explicitly mentioned
      if (countMatch && hostCount <= 5) continue
      return { isFleetOperation: true, hostCount }
    }
  }
  return { isFleetOperation: false, hostCount: null }
}

/**
 * QM-6: Try to get actual fleet host count from bastion registry.
 * Falls back to null if unavailable.
 */
async function getFleetHostCount() {
  try {
    const res = await fetch(`${COLLECTOR_URL}/api/internal/fleet/hosts`, {
      method: 'GET',
      headers: {
        'X-Quox-Source': 'task-service',
        ...(INTERNAL_SERVICE_KEY ? { 'x-service-key': INTERNAL_SERVICE_KEY } : {})
      },
      signal: AbortSignal.timeout(3000)
    })
    if (res.ok) {
      const data = await res.json()
      const count = Array.isArray(data) ? data.length : (data.count || data.total || null)
      return count
    }
  } catch { /* non-critical, fall back to heuristic count */ }
  return null
}

const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

// MACH-FOLLOWUP WI-A: structured form of the agent list (agentId +
// description) used to render tool-aware decompose prompts via
// buildAgentListWithTools. Keep the agentIds in sync with
// agentCapabilities.js's STATIC_CAPABILITY_SNAPSHOT.agentTools keys.
const DEFAULT_AGENT_LIST = [
  { agentId: 'quox', description: 'general purpose, orchestrator' },
  { agentId: 'sentinel', description: 'security scanning, vulnerability checks' },
  { agentId: 'cipher', description: 'networking, DNS, routing, encryption, PKI' },
  { agentId: 'nova', description: 'DevOps, Docker, deployments, infrastructure, SSH, CI/CD, backup, restore' },
  { agentId: 'atlas', description: 'virtualization, Proxmox, VMs, snapshots' },
  { agentId: 'metrics', description: 'monitoring, Prometheus, alerting, data analysis' },
  { agentId: 'archivist', description: 'file operations, document analysis' },
  { agentId: 'codex', description: 'code review, development' },
  { agentId: 'browser-q', description: 'web automation: navigate websites, fill forms, take screenshots, extract data, login to sites, monitor pages for changes' },
]

const DECOMPOSE_TEMPLATE = `You are a task planner for QuoxCORE. Break the given objective into concrete, actionable tasks.
Return ONLY a valid JSON array — no markdown, no explanation.

Objective: "{title}" — {description}

Available agents:
{agents}

Return format:
[
  { "title": "Task title", "agent_id": "agent_id_here", "prompt": "Detailed instruction for the agent", "depends_on": [], "required_tools": ["tool_name"] }
]

Rules:
- Default cap: 10 tasks
- Each task will have up to {taskMinutes} minutes of execution time
- Each task must be atomic and self-contained
- ONLY assign tasks to the agents listed above
- Use specialist agents where their domain matches the task
- "required_tools" is OPTIONAL: list the specific tools the task needs, chosen ONLY from the tool lists shown next to each agent above. Omit or leave empty if no specific tool is required. Prefer assigning each task to an agent that already has all its required tools.
- depends_on is an array of 0-based task indices (e.g., [0] means depends on the first task)
- First task should have depends_on: []
- CRITICAL: Tasks that need information from earlier tasks MUST declare depends_on. For example, if task 0 gathers installation details and task 2 performs the installation, task 2 MUST have depends_on: [0]. Verification/health-check tasks MUST depend on the tasks they verify.
- For ordered operations (install, configure, verify), use a sequential chain: each step depends on the previous one. Do NOT make installation and verification tasks independent.
- Each task prompt MUST be self-contained BUT assume it will receive results from its dependency tasks at execution time. Reference what information you expect from prior tasks (e.g., "Using the IP address and installation method from the prior task...").

STRICT SERIALIZATION OVERRIDE:
If the objective uses ANY of these patterns, produce exactly ONE task per item — do NOT batch — even if the resulting list exceeds the 10-task default cap. Cap rises to 50 in this mode.
- "strictly serial", "strict serial", "no parallel"
- "one at a time", "one VM at a time", "one per X"
- "sequentially", "in sequence", "in order"
- per-item HITL/approval gates ("HITL approval before each", "approval gate before each")
- explicit numbered manifests in the description (e.g. "Process VMs in this order: 1. … 2. … 3. …")
When this override fires, each task targets exactly one item from the manifest. Use sequential depends_on chains (task N depends on task N-1) so execution remains serial. NEVER lump multiple items ("Batch 1: VMs 2-5") into a single task under this mode.`

/**
 * OBJ-4: detect whether an objective requests strict per-item serialization.
 * Triggers raise the task cap from 10 to 50 and tell the LLM to emit one
 * task per item rather than batching. Match is conservative: a substring
 * hit on any of the canonical phrases below.
 */
const SERIAL_TRIGGERS = [
  'strictly serial', 'strict serial', 'no parallel',
  'one at a time', 'one per ', 'one task per',
  'sequentially', 'in sequence',
  'hitl approval before each', 'approval gate before each',
  'approval before each',
]
export function detectStrictSerial(title, description) {
  const text = `${title || ''}\n${description || ''}`.toLowerCase()
  return SERIAL_TRIGGERS.some(t => text.includes(t))
}

/**
 * TRUST-GATE-1.5: count items in an explicit sequential numbered manifest
 * embedded in an objective description (e.g. "1. vm-a 2. vm-b 3. vm-c").
 * Returns null when no strict 1..N sequential manifest is found, since
 * strict-serial mode can also be triggered by phrases like "one at a time"
 * with no explicit item count to check the parsed plan against.
 */
export function countManifestItems(description) {
  if (!description) return null
  const numbers = [...description.matchAll(/(?:^|\s)(\d+)[.)]\s/g)].map(m => parseInt(m[1], 10))
  if (numbers.length < 2) return null
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i + 1) return null
  }
  return numbers.length
}

/**
 * TRUST-GATE-1.5: post-parse guard against silent batching regressions.
 * The STRICT SERIALIZATION OVERRIDE (one task per item) is enforced only
 * via prompt instruction today, so a model regression could silently
 * reintroduce batching (or padding) with nothing to catch it. When
 * strict-serial mode is active AND the description carries an explicit
 * numbered manifest, the parsed task count must match the manifest size
 * exactly. Throws — never truncates or pads — so callers can route the
 * failure through the existing decomposition-failed error path.
 */
export function assertStrictSerialTaskCount(title, description, taskCount) {
  if (!detectStrictSerial(title, description)) return
  const expected = countManifestItems(description)
  if (expected === null) return
  if (taskCount !== expected) {
    throw new Error(
      `Strict-serial violation: expected exactly ${expected} task(s) (one per manifest item) but decomposition produced ${taskCount}. Refusing to silently truncate or pad.`
    )
  }
}

/**
 * Build the structured (agentId + description) agent list from a team
 * manifest, for buildAgentListWithTools. Same shape as DEFAULT_AGENT_LIST.
 */
function buildTeamAgentList(manifest) {
  const list = []
  const orch = manifest.orchestrator
  list.push({ agentId: orch.agentId, description: `${(orch.domains || ['orchestration']).join(', ')}, orchestrator` })
  for (const m of manifest.members || []) {
    list.push({ agentId: m.agentId, description: `${(m.domains || []).join(', ')}, ${m.role}` })
  }
  return list
}

/**
 * AT-1: Get topology-specific prompt suffix based on team manifest.
 * Guides the decomposer to structure tasks according to the team's coordination pattern.
 *
 * @param {Object} manifest — team manifest (may be missing topology field)
 * @returns {string} prompt suffix to append
 */
export function getTopologyPromptSuffix(manifest) {
  const type = manifest?.topology?.type || 'star'

  switch (type) {
    case 'star':
      return `\n\nTopology: Star (flat).\nBreak this into independent tasks, one per specialist. Each task runs in parallel where possible. Specialists report results back to you. Assign each task to exactly one agent.`

    case 'hierarchical': {
      const subOrchs = manifest.topology.subOrchestrators || []
      return `\n\nTopology: Hierarchical.\nYou are the programme manager. Break this into high-level work packages.\nSub-orchestrators [${subOrchs.join(', ')}] will further decompose their packages into subtasks.\nCreate high-level tasks for sub-orchestrators, not low-level tasks for individual specialists.\nEach sub-orchestrator task should describe a work package, not a single action.`
    }

    case 'pipeline': {
      const stages = (manifest.topology.pipelineStages || []).map(s => s.name)
      return `\n\nTopology: Pipeline (sequential stages).\nBreak this into stages: ${stages.join(' → ')}.\nEach stage must complete before the next begins. Within a stage, tasks can run in parallel.\nAssign each task to an agent within their designated stage.\nFor each task, include "stage": "<stage_name>" in a metadata field.`
    }

    case 'mesh':
      return `\n\nTopology: Mesh (collaborative).\nBreak this into research and analysis tasks where agents can reference each other's results.\nAll tasks can run in parallel. Agents build on each other's findings.\nInclude a final synthesis task that consolidates all agent outputs into a unified result.\nThe synthesis task should depend on all other tasks.`

    default:
      return getTopologyPromptSuffix({ topology: { type: 'star' } })
  }
}

/**
 * Build the decomposition prompt for a given objective.
 * If a team manifest is provided, uses team members as the agent list.
 * AT-1: Includes topology-aware suffix when manifest has topology field.
 *
 * MACH-FOLLOWUP WI-A: accepts an optional `capabilities` object
 * (`{ agentTools, toolAgents, source }`, shape returned by
 * fetchAgentCapabilities/STATIC_CAPABILITY_SNAPSHOT) so the rendered agent
 * list carries each agent's tools. Defaults to STATIC_CAPABILITY_SNAPSHOT
 * when omitted (e.g. existing 2-arg callers/tests) — behaviour-compatible:
 * the returned prompt still contains every agent id, just with a `tools:`
 * clause appended.
 */
export function buildDecomposePrompt(title, description, teamManifest, taskMinutes = 30, capabilities = null) {
  const caps = capabilities || STATIC_CAPABILITY_SNAPSHOT
  const agentList = teamManifest ? buildTeamAgentList(teamManifest) : DEFAULT_AGENT_LIST
  const agents = buildAgentListWithTools(agentList, caps.agentTools)
  const topologySuffix = teamManifest ? getTopologyPromptSuffix(teamManifest) : ''
  return DECOMPOSE_TEMPLATE
    .replace('{title}', title || '')
    .replace('{description}', description || '')
    .replace('{agents}', agents)
    .replace('{taskMinutes}', String(taskMinutes))
    + topologySuffix
}

/**
 * Parse the LLM response into a task array.
 * Falls back to single-task if parsing fails.
 * @param {string} responseText
 * @param {object} objective
 * @param {object} [opts]
 * @param {Set<string>} [opts.allowedAgents] - If set, restrict agent_id to these IDs
 * @param {string} [opts.fallbackAgent] - Agent ID for fallback (default: orchestrator or 'quox')
 * @param {number} [opts.maxTasks] - Hard cap on returned tasks (default 10).
 *   OBJ-4: callers raise this to 50 when the objective requests strict
 *   serialization / per-item gating, so 18-VM sweeps don't get truncated to 10.
 */
export function parseTasksFromResponse(responseText, objective, opts = {}) {
  const fallbackAgent = opts.fallbackAgent || 'quox'
  const allowed = opts.allowedAgents || null
  const maxTasks = typeof opts.maxTasks === 'number' && opts.maxTasks > 0 ? opts.maxTasks : 10

  try {
    // Try to extract JSON from the response
    let jsonStr = responseText.trim()

    // Strip markdown code fences if present
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim()
    }

    // Find the JSON array
    const arrayStart = jsonStr.indexOf('[')
    const arrayEnd = jsonStr.lastIndexOf(']')
    if (arrayStart !== -1 && arrayEnd !== -1) {
      jsonStr = jsonStr.slice(arrayStart, arrayEnd + 1)
    }

    const tasks = JSON.parse(jsonStr)

    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error('Response is not a valid task array')
    }

    // Validate and normalize each task (cap controlled by opts.maxTasks)
    return tasks.slice(0, maxTasks).map((t, idx) => {
      let agentId = t.agent_id || fallbackAgent
      // If team constraint active and agent not in team, fall back to orchestrator
      if (allowed && !allowed.has(agentId)) agentId = fallbackAgent
      // MACH-FOLLOWUP WI-A: optional LLM-emitted required_tools, sanitised
      // to an array of non-empty strings capped at 10 (plan §4.1). Hallucinated/
      // unknown tool names are NOT filtered here — that's applyToolAwareAssignment's
      // job (it needs the raw list to record unknown_tools in metadata).
      const requiredTools = Array.isArray(t.required_tools)
        ? t.required_tools.filter(rt => typeof rt === 'string' && rt.trim()).slice(0, 10)
        : []
      return {
        title: t.title || `Task ${idx + 1}`,
        agent_id: agentId,
        prompt: t.prompt || t.description || t.title || '',
        depends_on: Array.isArray(t.depends_on) ? t.depends_on.filter(d => typeof d === 'number' && d >= 0 && d < tasks.length) : [],
        ...(requiredTools.length > 0 ? { required_tools: requiredTools } : {}),
      }
    })
  } catch {
    // Fallback: single task with the full objective
    return [{
      title: objective.title,
      agent_id: fallbackAgent,
      prompt: `${objective.title}\n\n${objective.description || ''}`.trim(),
      depends_on: []
    }]
  }
}

/**
 * Decompose an objective into tasks by calling the collector LLM.
 * Creates task records in the database.
 * Returns the created tasks.
 */
export async function decomposeObjective(objective) {
  const db = getDatabase()

  // Stream E2: Resolve team manifest for team objectives
  let teamManifest = null
  const orchestratorId = objective.orchestrator_agent_id || 'quox'

  if (objective.team_id && objective.org_id) {
    const teamDef = getTeamDefinition(objective.org_id, objective.team_id)
    if (teamDef) teamManifest = teamDef.manifest
  }

  // Resolve policy-driven timeout from team manifest
  const policies = teamManifest?.policies || {}
  const decompDeadline = policies.maxTaskDurationMs || 1800000  // 30min default
  const taskMinutes = Math.round((policies.maxTaskDurationMs || 1800000) / 60000)

  // QM-3 + QMH-4b: Pre-flight advisory from QuoxMind. Mandatory directives
  // are quoxmind-pro only; free orgs get the same wisdom + probability +
  // risk flags as advisory text but no directives the planner is required
  // to honour.
  let advisoryText = ''
  try {
    const { generateAdvisory } = await import('./advisor.js')
    const mandatoryEnabled = await isPluginLicensed(objective.org_id, 'quoxmind-pro')
    const advisory = generateAdvisory(
      objective.org_id,
      objective.title,
      objective.description,
      { mandatoryEnabled }
    )
    if (advisory.advisory) {
      advisoryText = `\n\n--- QUOXMIND PRE-FLIGHT INTELLIGENCE ---\n${advisory.advisory}\n--- END INTELLIGENCE ---\n`
      console.log(`[QuoxMind] Advisory injected: ${advisory.wisdomCount} wisdom entries, ${advisory.pastOutcomeCount} past outcomes, predicted success: ${(advisory.probability * 100).toFixed(0)}%, mandatory=${mandatoryEnabled}`)
      if (advisory.mandatoryDirectives.length > 0) {
        console.log(`[QuoxMind] Mandatory directives: ${advisory.mandatoryDirectives.length}`)
      }
    }
  } catch (err) {
    console.warn('[QuoxMind] Advisory generation failed (non-fatal):', err.message)
  }

  // QM-6: Fleet batch decomposition — detect fleet ops and inject batching directive
  let fleetDirective = ''
  const fleetDetection = detectFleetOperation(objective.title, objective.description)
  if (fleetDetection.isFleetOperation) {
    let actualCount = await getFleetHostCount()
    const hostCount = actualCount || fleetDetection.hostCount
    const countNote = hostCount ? `\nEstimated host count: ${hostCount}.` : ''
    fleetDirective = FLEET_BATCH_DIRECTIVE + countNote + '\n'
    console.log(`[Decomposer] QM-6: Fleet operation detected (hostCount: ${hostCount || 'unknown'}), injecting batch directive`)
  }

  // Include plan adjustment feedback if present (from "Adjust Plan" flow)
  const descWithFeedback = objective.plan_feedback
    ? `${objective.description || ''}${fleetDirective}${advisoryText}\n\nPrevious plan was rejected with this feedback — incorporate these adjustments:\n${objective.plan_feedback}`
    : `${objective.description || ''}${fleetDirective}${advisoryText}`

  // MACH-FOLLOWUP WI-A: fetch tool capabilities once up front so both the
  // rendered prompt (agent tool lists) and the post-parse soft-reassignment
  // step below use the same snapshot. Non-fatal — falls back to the static
  // snapshot on any collector failure (fetchAgentCapabilities never throws).
  const capabilities = await fetchAgentCapabilities({ collectorUrl: COLLECTOR_URL })
  if (capabilities.source === 'static') {
    console.warn(`[Decomposer] Using static capability snapshot for objective ${objective.id} (collector capability fetch failed or unreachable)`)
  }

  const prompt = buildDecomposePrompt(objective.title, descWithFeedback, teamManifest, taskMinutes, capabilities)

  createTaskEnvelope({
    type: 'event', from: 'service.tasks', to: `agent.${orchestratorId}`,
    intent: TASK_INTENTS.OBJECTIVE_DECOMPOSED,
    payload: {
      phase: 'started',
      objective_id: objective.id,
      title: objective.title,
      description: (objective.description || '').slice(0, 500),
      team_id: objective.team_id || null,
      orchestrator: orchestratorId,
      has_feedback: !!objective.plan_feedback,
      max_tokens: objective.max_tokens || undefined,
      max_tool_calls: objective.max_tool_calls || undefined,
    },
    corrId: objective.corr_id, objectiveId: objective.id
  })

  emitProgress(objective.id, {
    type: 'decomposition_started',
    message: 'Breaking down objective into tasks...'
  })

  let responseText = ''

  // QM-7 wiring: an OPEN llm breaker refuses fast, before the network is
  // touched, and flows through the SAME failDecomposition() path as any
  // other decomposition failure (objective marked failed, task_logs row
  // written) — never a bespoke return shape. A refusal is NOT itself
  // recorded as a failure — see goalEvaluator.js's identical comment.
  if (!canExecuteResource('llm')) {
    const err = new CircuitBreakerOpenError('llm')
    console.warn(`[Decomposer] ${err.message}`)
    return failDecomposition(err)
  }

  try {
    console.log(`[Decomposer] Calling collector for objective ${objective.id} (deadline: ${Math.round(decompDeadline / 1000)}s)...`)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), decompDeadline)

    const res = await fetch(`${COLLECTOR_URL}/api/internal/agents/invoke`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Quox-Source': 'task-service',
        ...(INTERNAL_SERVICE_KEY ? { 'x-service-key': INTERNAL_SERVICE_KEY } : {})
      },
      body: JSON.stringify({
        agent_id: orchestratorId,
        task: prompt,
        org_id: objective.org_id,
        user_id: objective.user_id,
        max_duration_ms: decompDeadline,
        no_tools: true, // QE2: decomposition is pure reasoning, no tool calls needed
        // REPLAY-ONLY .A0: org_id + objective_id are threaded (identity context).
        // workflow_id/execution_id are intentionally ABSENT here — decomposition
        // happens before any workflow exists (a workflow is only created later,
        // at approve-plan). Do not fabricate one; a future replay-only gate must
        // treat pre-dispatch objective/decomposer calls as their own case, not
        // assume workflow context (docs/STREAM_REPLAY_ONLY_FABLE_REVIEW.md §5 .A0,
        // §4 row 5).
        context: {
          source: 'task-service',
          objective_id: objective.id,
          team_id: objective.team_id || null,
          team_instance_id: objective.team_instance_id || null
        }
      })
    })
    clearTimeout(timeout)

    console.log(`[Decomposer] Collector responded: ${res.status}`)

    if (!res.ok) {
      const errText = await res.text()
      console.error(`[Decomposer] Collector error body: ${errText.slice(0, 500)}`)
      throw new Error(`Collector returned ${res.status}: ${errText}`)
    }

    const data = await res.json()

    // Check application-level success — collector returns 200 even on auth failures
    if (data.success === false) {
      const baseMessage = data.result
        || (typeof data.error === 'string' && !/^[a-z0-9_]+$/i.test(data.error) ? data.error : '')
        || 'Agent invocation returned success=false'
      const errMsg = data.hint ? `${baseMessage}\n\n${data.hint}` : baseMessage
      throw new Error(errMsg)
    }

    responseText = data.result || data.response || data.text || data.content || JSON.stringify(data)
    console.log(`[Decomposer] Got response (${responseText.length} chars)`)
    recordResourceSuccess('llm')
  } catch (error) {
    console.error('[Decomposer] LLM call failed:', error.message)
    recordResourceFailure('llm')
    return failDecomposition(error)
  }

  // TRUST-GATE-1.5: shared failure path for decomposition errors discovered
  // after a successful LLM call (e.g. the strict-serial post-parse
  // assertion below). Mirrors the LLM-call failure handling above.
  function failDecomposition(error) {
    db.prepare(`
      UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ?
      WHERE id = ?
    `).run(`Decomposition failed: ${error.message}`.slice(0, 2000), objective.id)
    db.prepare(`
      INSERT INTO task_logs (id, objective_id, level, event, message, details, created_at)
      VALUES (?, ?, 'error', 'decomposition_failed', ?, ?, datetime('now'))
    `).run(ulid(), objective.id, `Decomposition failed: ${error.message}`, JSON.stringify({ error: error.message }))

    createTaskEnvelope({
      type: 'event', from: 'service.tasks', to: 'system',
      intent: TASK_INTENTS.OBJECTIVE_FAILED,
      payload: {
        phase: 'decomposition_failed',
        objective_id: objective.id,
        objective_title: objective.title,
        error: error.message,
        error_type: error.name || 'Error',
        orchestrator: orchestratorId,
        team_id: objective.team_id || null,
      },
      corrId: objective.corr_id, objectiveId: objective.id
    })

    emitProgress(objective.id, {
      type: 'objective_failed',
      message: `Decomposition failed: ${error.message}`
    })
    return { taskCount: 0, error: error.message }
  }

  // Build allowed agents set for team objectives
  let allowedAgents = null
  if (teamManifest) {
    allowedAgents = new Set()
    allowedAgents.add(teamManifest.orchestrator?.agentId)
    for (const m of teamManifest.members || []) allowedAgents.add(m.agentId)
  }

  // OBJ-4: detect strict-serial requests in title/description and raise the
  // task cap so 18-VM sweeps with per-item HITL gates don't get truncated to
  // 10 (the bug seen 2026-05-10 where 18 VMs decomposed to 7 batched tasks).
  const isStrictSerial = detectStrictSerial(objective.title, objective.description)
  const parsedTasks = parseTasksFromResponse(responseText, objective, {
    allowedAgents,
    fallbackAgent: orchestratorId,
    maxTasks: isStrictSerial ? 50 : 10
  })
  if (isStrictSerial) {
    console.log(`[Decomposer] OBJ-4: strict-serial mode active for objective ${objective.id} — task cap raised to 50`)
  }
  console.log(`[Decomposer] Parsed ${parsedTasks.length} task(s): ${parsedTasks.map(t => t.title).join(', ')}`)

  // TRUST-GATE-1.5: the STRICT SERIALIZATION OVERRIDE above is prompt-only —
  // nothing previously verified the LLM actually honoured it. Reject loudly
  // (never truncate/pad) if the parsed plan doesn't match the manifest size.
  try {
    assertStrictSerialTaskCount(objective.title, objective.description, parsedTasks.length)
  } catch (error) {
    console.error(`[Decomposer] TRUST-GATE-1.5: strict-serial post-parse assertion failed for objective ${objective.id}:`, error.message)
    return failDecomposition(error)
  }

  // AT-3: Learning router — override agent assignments when better candidates exist
  if (teamManifest && teamManifest.policies?.learningRouterEnabled !== false) {
    for (const task of parsedTasks) {
      const taskDomain = task.metadata?.domain || inferDomainFromTitle(task.title)
      const candidates = (teamManifest.members || [])
        .filter(m => m.domains?.includes(taskDomain))
        .map(m => m.agentId)
      if (candidates.length > 1) {
        try {
          const pick = await selectBestAgent(objective.org_id, taskDomain, candidates)
          if (pick.agentId && pick.agentId !== task.agent_id && pick.confidence > 0.3) {
            task.original_agent_id = task.agent_id
            task.agent_id = pick.agentId
            task.routing_reason = pick.reason
            console.log(`[Decomposer] Router override: ${task.title} ${task.original_agent_id} → ${pick.agentId} (${pick.reason}, score: ${pick.score})`)
          }
        } catch { /* learning router is non-critical */ }
      }
    }
  }

  // MACH-FOLLOWUP WI-A: tool-aware soft reassignment. Runs AFTER the AT-3
  // learning-router block above so tool-correctness is the final gate over
  // the bandit's domain pick (plan §4.1). Uses the same `capabilities`
  // snapshot fetched before the prompt was built. Never fails decomposition
  // — soft reassignment only (plan §10).
  applyToolAwareAssignment(parsedTasks, {
    agentTools: capabilities.agentTools,
    toolAgents: capabilities.toolAgents,
    allowedAgents,
    fallbackAgent: orchestratorId,
  })

  // QMH-3 part 2: precompute dependent counts for the priority scorer's
  // critical-path bonus (how many other tasks depend on this one).
  const dependentCount = new Array(parsedTasks.length).fill(0)
  for (const t of parsedTasks) {
    for (const idx of t.depends_on) {
      if (typeof idx === 'number' && idx >= 0 && idx < dependentCount.length) {
        dependentCount[idx]++
      }
    }
  }

  // Create task records (now with priority via QMH-3 priorityScorer)
  // MACH-FOLLOWUP WI-D: every task inherits objective.system_prompt VERBATIM
  // (owner-authored persona/voice channel — the decomposer LLM never writes
  // this field; see plan §4.4 step 3 / §9-Q1).
  const insertTask = db.prepare(`
    INSERT INTO tasks (id, objective_id, org_id, title, agent_id, prompt, sequence_num, depends_on, priority, metadata, system_prompt, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `)

  const taskIds = []
  const createTasks = db.transaction(() => {
    for (let i = 0; i < parsedTasks.length; i++) {
      const t = parsedTasks[i]
      const taskId = ulid()
      taskIds.push(taskId)

      // Convert index-based depends_on to ID-based
      const depIds = t.depends_on.map(idx => taskIds[idx]).filter(Boolean)

      const priority = scorePriority({
        title: t.title,
        prompt: t.prompt,
        severity: t.severity,
        dueBy: t.dueBy,
        dependentCount: dependentCount[i],
      })

      // MACH-FOLLOWUP WI-A: persist AT-3's original_agent_id/routing_reason
      // annotations (already set in-memory, previously never written — plan
      // §1.2) alongside the new tool-aware routing metadata/required_tools.
      const metadata = (t.required_tools?.length || t.metadata?.routing || t.original_agent_id)
        ? JSON.stringify({
            ...(t.required_tools?.length ? { required_tools: t.required_tools } : {}),
            ...(t.metadata?.routing ? { routing: t.metadata.routing } : (t.original_agent_id ? { routing: { original_agent_id: t.original_agent_id, reason: t.routing_reason } } : {})),
          })
        : null

      insertTask.run(
        taskId,
        objective.id,
        objective.org_id,
        t.title,
        t.agent_id,
        t.prompt,
        i,
        JSON.stringify(depIds),
        priority,
        metadata,
        objective.system_prompt || null
      )
    }

    // Phase 4.B: Set status to 'decomposed' for preview-plan flow
    // Clear plan_feedback after successful re-decomposition
    db.prepare(`
      UPDATE objectives SET task_count = ?, status = 'decomposed', started_at = COALESCE(started_at, datetime('now')), plan_feedback = NULL
      WHERE id = ?
    `).run(parsedTasks.length, objective.id)
  })

  createTasks()

  // Log decomposition
  db.prepare(`
    INSERT INTO task_logs (id, objective_id, level, event, message, details, created_at)
    VALUES (?, ?, 'info', 'decomposed', ?, ?, datetime('now'))
  `).run(
    ulid(),
    objective.id,
    `Decomposed into ${parsedTasks.length} task(s)`,
    JSON.stringify(parsedTasks.map(t => t.title))
  )

  const decompEnvelope = createTaskEnvelope({
    type: 'event', from: `agent.${orchestratorId}`, to: 'service.tasks',
    intent: TASK_INTENTS.OBJECTIVE_DECOMPOSED,
    payload: {
      phase: 'completed',
      objective_id: objective.id,
      objective_title: objective.title,
      team_id: objective.team_id || null,
      orchestrator: orchestratorId,
      task_count: parsedTasks.length,
      tasks: parsedTasks.map((t, i) => ({
        id: taskIds[i],
        title: t.title,
        agent_id: t.agent_id,
        prompt: (t.prompt || '').slice(0, 300),
        depends_on: t.depends_on,
      })),
    },
    corrId: objective.corr_id, objectiveId: objective.id
  })

  emitProgress(objective.id, {
    type: 'decomposition_completed',
    task_count: parsedTasks.length,
    tasks: parsedTasks.map((t, i) => ({ id: taskIds[i], title: t.title, agent_id: t.agent_id })),
    envelope: decompEnvelope
  })

  return taskIds.map((id, i) => ({
    id,
    ...parsedTasks[i],
    objective_id: objective.id,
    status: 'pending'
  }))
}
