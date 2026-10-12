/**
 * ARCHITECT Action Parser (AUX-6)
 *
 * Parses structured `agent-action` code blocks from ARCHITECT agent LLM responses.
 * Follows the WorkflowBuilderChat pattern: structured output → parse → validate → execute.
 *
 * Action block format in LLM output:
 * ```agent-action
 * {
 *   "action": "create_agent",
 *   "payload": { ... }
 * }
 * ```
 *
 * Supported actions:
 *   create_agent   — Create a new agent/assistant/chatbot
 *   update_agent   — Modify an existing agent's config
 *   create_tool    — Create a new custom tool
 *   assign_tool    — Assign a tool to an agent
 *   remove_tool    — Remove a tool from an agent
 *   set_personality — Update personality settings
 *   set_rules      — Update always/never rules
 *   publish        — Publish an assistant (draft → active)
 */

export const ACTION_TYPES = [
  'create_agent',
  'update_agent',
  'create_tool',
  'assign_tool',
  'remove_tool',
  'set_personality',
  'set_rules',
  'publish',
]

/**
 * Parse agent-action code blocks from markdown text.
 * Returns array of parsed action objects.
 *
 * @param {string} text — Raw LLM response text (markdown)
 * @returns {Array<{action: string, payload: object, target?: string}>}
 */
export function parseAgentActions(text) {
  if (!text) return []

  const actions = []
  // Match ```agent-action ... ``` blocks
  const regex = /```agent-action\s*\n([\s\S]*?)```/g
  let match

  while ((match = regex.exec(text)) !== null) {
    const jsonStr = match[1].trim()
    try {
      const parsed = JSON.parse(jsonStr)
      if (parsed && typeof parsed.action === 'string') {
        actions.push(parsed)
      }
    } catch {
      // Skip malformed JSON blocks silently
    }
  }

  return actions
}

/**
 * Validate an agent action. Returns array of error strings (empty = valid).
 *
 * @param {object} action — { action, payload, target? }
 * @returns {string[]}
 */
export function validateAgentAction(action) {
  const errors = []

  if (!action || !action.action) {
    errors.push('Action type is required')
    return errors
  }

  if (!ACTION_TYPES.includes(action.action)) {
    errors.push(`Unknown action type: ${action.action}`)
    return errors
  }

  const payload = action.payload || {}

  switch (action.action) {
    case 'create_agent': {
      if (!payload.name) errors.push('Agent name is required')
      if (payload.name && payload.name.length > 50) errors.push('Agent name must be 50 characters or less')
      if (!payload.type) errors.push('Agent type is required (agent, assistant, chief, chatbot)')
      break
    }

    case 'update_agent': {
      if (!action.target && !payload.id) errors.push('Target agent ID is required for update')
      break
    }

    case 'create_tool': {
      if (!payload.id) errors.push('Tool ID is required')
      if (payload.id && !/^[a-z][a-z0-9_-]*$/.test(payload.id)) errors.push('Tool ID must be lowercase alphanumeric with underscores/dashes')
      if (!payload.name) errors.push('Tool name is required')
      if (!payload.description) errors.push('Tool description is required')
      break
    }

    case 'assign_tool': {
      if (!payload.toolId) errors.push('Tool ID is required')
      if (!action.target && !payload.agentId) errors.push('Target agent ID is required')
      break
    }

    case 'remove_tool': {
      if (!payload.toolId) errors.push('Tool ID is required')
      if (!action.target && !payload.agentId) errors.push('Target agent ID is required')
      break
    }

    case 'set_personality': {
      // Personality is flexible — no strict requirements
      break
    }

    case 'set_rules': {
      // Rules are flexible
      break
    }

    case 'publish': {
      if (!action.target && !payload.id) errors.push('Target assistant ID is required for publish')
      break
    }
  }

  return errors
}

/**
 * Extract a human-readable summary of an action for display in chat.
 *
 * @param {object} action — Parsed action object
 * @returns {string}
 */
export function summarizeAction(action) {
  const p = action.payload || {}
  switch (action.action) {
    case 'create_agent':
      return `Create ${p.type || 'agent'}: ${p.name || 'unnamed'} (${p.domain || 'general'})`
    case 'update_agent':
      return `Update agent: ${action.target || p.id || 'unknown'}`
    case 'create_tool':
      return `Create tool: ${p.name || p.id || 'unnamed'} (${p.category || 'general'})`
    case 'assign_tool':
      return `Assign tool ${p.toolId} to ${action.target || p.agentId}`
    case 'remove_tool':
      return `Remove tool ${p.toolId} from ${action.target || p.agentId}`
    case 'set_personality':
      return `Update personality for ${action.target || 'current agent'}`
    case 'set_rules':
      return `Update rules for ${action.target || 'current agent'}`
    case 'publish':
      return `Publish ${action.target || p.id || 'assistant'} to production`
    default:
      return `Unknown action: ${action.action}`
  }
}
