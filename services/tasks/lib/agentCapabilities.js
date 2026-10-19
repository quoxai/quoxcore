/**
 * MACH-FOLLOWUP WI-A — agent tool-capability lookup for tool-aware
 * decomposition.
 *
 * The decomposer runs in the tasks service, a separate Node process from
 * the collector, so it cannot import `services/collector/lib/agentTools.js`
 * directly. Instead it reads the collector's existing (unauthenticated,
 * read-only) `GET /api/v1/tools/agents` projection of that map
 * (`{ agentTools: {agentId: [toolName]}, toolAgents: {toolName: [agentId]} }`,
 * collector server.js:4474-4487).
 *
 * This module is intentionally free of any decomposer-specific concerns
 * (prompt text, task shape) so it can be unit-tested in isolation and
 * reused by any future tool-aware surface.
 */

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://collector:9848'
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 min, per plan §10

/**
 * STATIC_CAPABILITY_SNAPSHOT — checked-in fallback used only when the
 * collector's `/api/v1/tools/agents` endpoint is unreachable at
 * decomposition time. Manually copied from `AGENT_TOOLS` in
 * services/collector/lib/agentTools.js (lines ~6383-6518) on 2026-07-07 for
 * the 9 agents in decomposer.js's DEFAULT_AGENT_LIST. `archivist` and
 * `codex` have no entries in the live `AGENT_TOOLS` map (verified by grep —
 * zero hits) so their static tool lists are empty here too; that mirrors
 * reality rather than being a gap introduced by this snapshot.
 *
 * v1 scope note (plan §3 non-goal): core agents only — per-org/POWERS
 * plugin tools are not covered by either the live endpoint or this
 * snapshot.
 */
const MEMORY_TOOLS = ['memory_save', 'memory_search', 'memory_update', 'entity_note']
const SKILL_TOOLS = ['skills_list', 'skill_view', 'skill_manage', 'session_search']

const STATIC_AGENT_TOOLS = {
  quox: [
    'delegate_to_agent', 'orchestrate_objective', 'get_objective_results', 'save_as_workflow',
    'create_inbox_item', 'create_workflow', 'send_notification',
    'ssh_exec', 'fleet_status', 'docker_status', 'docker_extended',
    'system_admin', 'network_check', 'proxmox_vms', 'proxmox_cluster_status',
    'proxmox_vm_action', 'security_audit', 'metrics_query',
    ...MEMORY_TOOLS, ...SKILL_TOOLS,
  ],
  sentinel: ['ssh_exec', 'security_audit', 'ssl_certificates', 'fleet_status', 'network_check', 'execution_intelligence', 'codebase_query', 'create_inbox_item', 'send_notification', 'browser_navigate', 'browser_screenshot', 'browser_extract', ...MEMORY_TOOLS, ...SKILL_TOOLS],
  cipher: ['ssh_exec', 'network_check', 'fleet_status', 'system_admin', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS],
  nova: ['ssh_exec', 'docker_status', 'docker_extended', 'system_admin', 'fleet_status', 'execution_intelligence', 'codebase_query', 'create_workflow', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS],
  atlas: ['ssh_exec', 'proxmox_read', 'proxmox_vm_action', 'proxmox_vm_snapshot', 'proxmox_vm_clone', 'proxmox_pool_lease', 'proxmox_pool_release', 'proxmox_pool_configure', 'proxmox_rehearse', 'proxmox_vm_doctor', 'fleet_status', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS],
  metrics: ['ssh_exec', 'metrics_query', 'alerts_manage', 'grafana_dashboards', 'fleet_status', 'execution_intelligence', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS],
  archivist: [],
  codex: [],
  'browser-q': [
    'browser_navigate', 'browser_screenshot', 'browser_extract',
    'browser_extract_table', 'browser_extract_schema', 'browser_extract_template',
    'browser_extract_links', 'browser_extract_metadata',
    'browser_click', 'browser_type', 'browser_wait', 'browser_scroll',
    'browser_fill_form', 'browser_select', 'browser_find_element', 'browser_analyze_forms',
    'browser_pdf', 'browser_download', 'browser_login',
    ...MEMORY_TOOLS, ...SKILL_TOOLS,
  ],
}

function buildToolAgents(agentTools) {
  const toolAgents = {}
  for (const [agentId, toolNames] of Object.entries(agentTools || {})) {
    for (const tool of toolNames || []) {
      if (!toolAgents[tool]) toolAgents[tool] = []
      toolAgents[tool].push(agentId)
    }
  }
  return toolAgents
}

export const STATIC_CAPABILITY_SNAPSHOT = {
  agentTools: STATIC_AGENT_TOOLS,
  toolAgents: buildToolAgents(STATIC_AGENT_TOOLS),
  source: 'static',
}

let cache = null // { agentTools, toolAgents, source, fetchedAt }

/**
 * Fetch the live agent→tool capability map from the collector, with a 5
 * minute module-level cache. On any failure (network, non-2xx, malformed
 * body) falls back to STATIC_CAPABILITY_SNAPSHOT and logs one warning —
 * never throws, so a collector outage cannot block decomposition.
 */
export async function fetchAgentCapabilities({ collectorUrl, timeoutMs = 3000 } = {}) {
  const baseUrl = collectorUrl || COLLECTOR_URL
  const now = Date.now()
  if (cache && (now - cache.fetchedAt) < CACHE_TTL_MS) {
    return cache
  }

  try {
    const res = await fetch(`${baseUrl}/api/v1/tools/agents`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...(INTERNAL_SERVICE_KEY ? { 'x-service-key': INTERNAL_SERVICE_KEY } : {}),
      },
    })
    if (!res.ok) throw new Error(`collector responded ${res.status}`)
    const data = await res.json()
    if (!data || typeof data.agentTools !== 'object' || data.agentTools === null) {
      throw new Error('malformed capability response (missing agentTools)')
    }
    cache = {
      agentTools: data.agentTools,
      toolAgents: data.toolAgents && typeof data.toolAgents === 'object' ? data.toolAgents : buildToolAgents(data.agentTools),
      source: 'live',
      fetchedAt: now,
    }
    return cache
  } catch (err) {
    console.warn(`[agentCapabilities] fetch failed, using static fallback snapshot: ${err.message}`)
    return { ...STATIC_CAPABILITY_SNAPSHOT, fetchedAt: now }
  }
}

/**
 * Test-only helper: clear the module-level cache so each test starts from
 * a known state (mirrors resetReconcilerState()-style patterns elsewhere).
 */
export function _resetCapabilityCache() {
  cache = null
}

/**
 * Render a decompose-prompt agent list with a `tools: [...]` clause per
 * agent, appended to whatever description text the caller supplies. Pure —
 * no I/O. Works for both decomposer.js's DEFAULT_AGENT_LIST and a
 * team-manifest-derived member list.
 *
 * @param {Array<{agentId: string, description: string}>} agents
 * @param {Object} agentTools - { agentId: [toolName, ...] }
 * @param {Object} [opts]
 * @param {number} [opts.maxToolsPerAgent=12] - truncate long tool lists so the prompt stays bounded
 */
export function buildAgentListWithTools(agents, agentTools = {}, { maxToolsPerAgent = 12 } = {}) {
  if (!Array.isArray(agents)) return ''
  return agents
    .map(a => {
      const tools = (agentTools?.[a.agentId] || []).slice(0, maxToolsPerAgent)
      const toolsClause = tools.length > 0 ? ` — tools: [${tools.join(', ')}]` : ''
      return `- ${a.agentId} (${a.description})${toolsClause}`
    })
    .join('\n')
}

/**
 * Soft tool-aware reassignment. Runs AFTER the existing bandit/AT-3
 * assignment step (decomposer.js:534-553) — layers tool-correctness on top
 * rather than replacing domain-based routing. Pure function, mutates and
 * returns the same `parsedTasks` array for convenience. Never throws.
 *
 * For each task with a non-empty `required_tools`:
 *  - Filters to names present in `toolAgents` (unknown/hallucinated names
 *    are ignored and recorded in `metadata.routing.unknown_tools`, never
 *    treated as errors).
 *  - No-op if the assigned agent already covers every known required tool.
 *  - Otherwise looks for the candidate agent (optionally restricted to
 *    `allowedAgents`) covering the MOST required tools; ties broken by
 *    fewest total tools (most specialised). Reassigns only if that
 *    candidate covers strictly more required tools than the current agent
 *    already does.
 *  - If nobody covers more than the current agent, keeps the existing
 *    assignment and records `missing_tools` — assignment is always soft,
 *    per plan §10 (never fails decomposition on unsatisfiable requirements).
 */
export function applyToolAwareAssignment(parsedTasks, { agentTools, toolAgents, allowedAgents, fallbackAgent } = {}) {
  if (!Array.isArray(parsedTasks)) return parsedTasks
  const safeAgentTools = agentTools && typeof agentTools === 'object' ? agentTools : {}
  const safeToolAgents = toolAgents && typeof toolAgents === 'object' ? toolAgents : {}

  for (const task of parsedTasks) {
    try {
      const requiredTools = Array.isArray(task?.required_tools) ? task.required_tools.filter(t => typeof t === 'string' && t) : []
      if (requiredTools.length === 0) continue

      const knownRequired = []
      const unknownTools = []
      for (const t of requiredTools) {
        if (Array.isArray(safeToolAgents[t]) && safeToolAgents[t].length > 0) knownRequired.push(t)
        else unknownTools.push(t)
      }

      const routing = {}
      if (unknownTools.length > 0) routing.unknown_tools = unknownTools
      if (knownRequired.length === 0) {
        if (unknownTools.length > 0) {
          task.metadata = { ...(task.metadata || {}), routing: { ...(task.metadata?.routing || {}), ...routing } }
        }
        continue
      }

      const currentAgentId = task.agent_id || fallbackAgent
      const currentTools = safeAgentTools[currentAgentId] || []
      const currentCovered = knownRequired.filter(t => currentTools.includes(t))
      const currentMissing = knownRequired.filter(t => !currentTools.includes(t))

      if (currentMissing.length === 0) {
        // Current agent already covers every known required tool — no-op.
        continue
      }

      let candidateIds = Object.keys(safeAgentTools)
      if (allowedAgents instanceof Set) candidateIds = candidateIds.filter(id => allowedAgents.has(id))

      let best = null
      for (const id of candidateIds) {
        const tools = safeAgentTools[id] || []
        const covered = knownRequired.filter(t => tools.includes(t))
        if (covered.length === 0) continue
        if (
          !best ||
          covered.length > best.covered.length ||
          (covered.length === best.covered.length && tools.length < best.tools.length)
        ) {
          best = { id, covered, tools }
        }
      }

      if (!best || best.covered.length <= currentCovered.length) {
        // Nobody covers strictly more than the current agent — keep the
        // assignment (soft failure), just record what's missing.
        task.metadata = {
          ...(task.metadata || {}),
          routing: { ...(task.metadata?.routing || {}), ...routing, missing_tools: currentMissing },
        }
        console.warn(`[agentCapabilities] no agent fully covers required_tools for task "${task.title}"; keeping ${currentAgentId} (missing: ${currentMissing.join(', ')})`)
        continue
      }

      const originalAgentId = currentAgentId
      const missingTools = knownRequired.filter(t => !best.covered.includes(t))
      task.original_agent_id = originalAgentId
      task.agent_id = best.id
      task.routing_reason = 'tool_capability'
      task.metadata = {
        ...(task.metadata || {}),
        routing: {
          ...(task.metadata?.routing || {}),
          ...routing,
          original_agent_id: originalAgentId,
          reason: 'tool_capability',
          required_tools: knownRequired,
          matched_tools: best.covered,
          missing_tools: missingTools,
        },
      }
    } catch (err) {
      // Never throw — a malformed task must not abort the whole decomposition.
      console.warn(`[agentCapabilities] applyToolAwareAssignment: skipping task due to error: ${err.message}`)
    }
  }

  return parsedTasks
}
