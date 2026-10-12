/**
 * novaContextAssembler.js
 *
 * Assembles LLM-ready context fragments for DAEDALUS (the workflow builder assistant).
 * Sourced from the palette and registry definitions so the prompt stays in sync
 * with what the UI actually shows users.
 */

import { NODE_CATEGORIES } from '../components/workflow/NodePalette.jsx'
import { agentRegistry } from '../config/agentRegistry'
import { PLUGINS } from '../config/plugins/index.js'
import { searchWorkflows, loadWorkflowLibraryIndex } from './workflowLibrary'

/**
 * Heuristic: does the user's message contain workflow-design intent?
 * Matches phrases like "build me X", "I want to send Y", "how do I automate Z".
 * Returns false for conversational/Q&A turns so we skip the library lookup
 * and save tokens.
 */
const INTENT_HEURISTIC = /\b(build|create|make|set ?up|automate|send|trigger on|when|every|whenever|i (?:want|need)|how (?:do|can) i|workflow (?:that|to)|template for)\b/i

/**
 * Returns a markdown summary of the top 3-5 workflow library templates most
 * relevant to the user's query. Returns an empty string when no design intent
 * is detected (saves tokens on conversational / Q&A turns).
 *
 * Compression: title + 1-line purpose + trigger type + key integrations.
 * Does NOT include full workflow JSON — templates are loaded on demand if
 * the user asks DAEDALUS to apply one via the load_template action.
 *
 * @param {string|null} userQuery - The current user message text
 * @param {object|null} _currentWorkflow - Reserved for future use (unused)
 * @returns {Promise<string>} Markdown block, or '' if no match / no intent
 */
export async function findRelevantTemplates(userQuery, _currentWorkflow) {
  if (!userQuery || !INTENT_HEURISTIC.test(userQuery)) return ''

  try {
    // Ensure the index is loaded (no-op if already initialised)
    await loadWorkflowLibraryIndex()
  } catch (err) {
    console.warn('[novaContextAssembler] workflow library index not available:', err.message)
    return ''
  }

  let results
  try {
    results = searchWorkflows(userQuery, { limit: 5 })
  } catch (err) {
    console.warn('[novaContextAssembler] searchWorkflows failed:', err.message)
    return ''
  }

  const workflows = results?.workflows ?? []
  if (workflows.length === 0) return ''

  const lines = workflows.slice(0, 5).map((w) => {
    const name = w.identity?.name ?? w.id
    const id = w.id
    const triggerType = w.trigger?.type ?? 'unknown'
    const integrations = (w.capabilities?.integrations ?? []).join(', ') || 'none'

    let desc = w.identity?.description ?? ''
    if (desc.length > 120) desc = desc.slice(0, 117) + '...'

    return `- **${name}** (\`${id}\`) — trigger: ${triggerType}. ${desc} Integrations: ${integrations}.`
  })

  return [
    '## Relevant Workflow Templates (from library)',
    '',
    'These existing templates may match the user\'s intent. Reference them when',
    'proposing a plan; offer to load one with the load_template action if a',
    'strong fit:',
    '',
    ...lines,
  ].join('\n')
}

/**
 * Returns a markdown-formatted node-type catalog for injection into DAEDALUS's
 * system prompt. Sourced from NodePalette.jsx NODE_CATEGORIES so the prompt
 * stays in sync with what the palette actually shows users.
 *
 * Output is deterministic — same input always produces byte-identical output.
 *
 * @returns {string} Markdown catalog of all node types grouped by category
 */
export function getNodeCatalogForLLM() {
  const sections = NODE_CATEGORIES.map((category) => {
    const heading = `## ${category.label}`
    const lines = category.nodes.map((node) => {
      const base = `- \`${node.type}\` — ${node.name}`
      if (node.description) {
        return `${base}: ${node.description}`
      }
      return base
    })
    return [heading, ...lines].join('\n')
  })

  return sections.join('\n\n')
}

/**
 * Compressed agent catalog for DAEDALUS's prompt. One line per agent so she can
 * recommend specific agents in agent:agentic nodes instead of generic LLM calls.
 *
 * Compression: id, name, role, 1-line capability summary, tool names (up to 5)
 * or tool count if no map supplied.
 * NOT included: full systemPrompt (too long), suggestions, manages/reportsTo
 * (not relevant to workflow design), defconLevel.
 *
 * @param {Map<string, Array<{name: string, description: string}>>} [agentToolsMap]
 *   Optional — populated by agentToolCatalogClient. When provided, tool names
 *   (up to 5, "+N more" suffix) replace the bare count. When absent the
 *   function falls back to tool count from agentRegistry (backwards-compat).
 * @returns {Promise<string>} Markdown list of all agents, alphabetical by id
 */
export async function getAgentCatalogForLLM(agentToolsMap) {
  const agents = agentRegistry.agents

  // Collect entries and sort alphabetically by id
  const entries = Object.keys(agents)
    .sort()
    .map((id) => {
      const agent = agents[id]

      // Build name+role tag
      const roleTag = agent.role ? ` (${agent.role})` : ''

      // Description truncated to ~120 chars
      let desc = agent.description || agent.name
      if (desc.length > 120) {
        desc = desc.slice(0, 117) + '...'
      }

      // Capabilities: up to 4 items, "..." if more
      const caps = agent.capabilities || []
      let capsStr = caps.slice(0, 4).join(', ')
      if (caps.length > 4) capsStr += ', ...'

      // Tool names or count
      let toolsStr
      if (agentToolsMap && agentToolsMap.has(id)) {
        const tools = agentToolsMap.get(id)
        const MAX_LIST = 5
        if (tools.length === 0) {
          toolsStr = 'none'
        } else if (tools.length <= MAX_LIST) {
          toolsStr = tools.map((t) => t.name).join(', ')
        } else {
          toolsStr = tools.slice(0, MAX_LIST).map((t) => t.name).join(', ') + ` +${tools.length - MAX_LIST} more`
        }
      } else {
        const toolCount = Array.isArray(agent.tools) ? agent.tools.length : 0
        toolsStr = String(toolCount)
      }

      return `- \`${id}\` (${agent.name}${roleTag}) — ${desc}. Capabilities: ${capsStr || 'none'}. Tools: ${toolsStr}.`
    })

  return entries.join('\n')
}

/**
 * Compressed plugin catalog. DAEDALUS needs to know which integrations are
 * available so she can suggest workflows like "use the slack plugin to post
 * the result" instead of generic HTTP.
 *
 * @returns {string} Markdown list of all plugins, alphabetical by id
 */
export function getPluginCatalogForLLM() {
  const entries = Object.keys(PLUGINS)
    .sort()
    .map((id) => {
      const plugin = PLUGINS[id]

      // Prefer shortDescription (concise), fall back to description, then name
      let desc = plugin.shortDescription || plugin.description || plugin.name || id
      if (desc.length > 100) {
        desc = desc.slice(0, 97) + '...'
      }

      return `- \`${id}\` — ${desc}`
    })

  return entries.join('\n')
}
