/**
 * Assistant Type Configuration (AUX-2)
 *
 * Defines which tabs are visible for each assistant type.
 * Used by EditorShell to render type-appropriate configuration panels.
 *
 * Types:
 *   agent     — Core agents + plugin agents (tools, delegation, safety, viz)
 *   assistant — User-created + scoped assistants (lighter config)
 *   chief     — Agentic team chiefs (team members, delegation)
 *   chatbot   — QuoxChat website widgets (knowledge, training, style, actions, budget)
 */

export const ASSISTANT_TYPE_CONFIGS = {
  agent: {
    label: 'Agent',
    icon: 'shield',      // lucide icon name
    accent: '#38bdf8',   // cyan
    tabs: [
      'identity', 'personality', 'system-prompt', 'voice', 'llm',
      'tools', 'quick-actions', 'delegation', 'safety', 'visualization', 'ui'
    ],
    createFields: ['name', 'domain', 'description'],
    features: { tools: true, delegation: true, safety: true, viz: true, quickActions: true }
  },

  assistant: {
    label: 'Custom Assistant',
    icon: 'user',
    accent: '#a855f7',   // purple
    tabs: [
      'identity', 'personality', 'system-prompt', 'voice', 'llm',
      'rules', 'tools', 'quick-actions', 'visualization', 'ui'
    ],
    createFields: ['name', 'description', 'scope'],
    features: { tools: true, delegation: false, safety: false, viz: true, quickActions: true }
  },

  chief: {
    label: 'Team Chief',
    icon: 'crown',
    accent: '#f59e0b',   // amber
    tabs: [
      'identity', 'personality', 'system-prompt', 'voice', 'llm',
      'team-members', 'rules', 'visualization', 'ui'
    ],
    createFields: ['name', 'specialty', 'tier'],
    features: { tools: false, delegation: true, safety: false, viz: true, quickActions: false }
  },

  chatbot: {
    label: 'ChatBot Widget',
    icon: 'message-circle',
    accent: '#30ff90',   // green
    tabs: [
      'identity', 'personality', 'system-prompt', 'voice', 'llm',
      'knowledge', 'training', 'style', 'actions', 'analytics',
      'logs', 'budget', 'settings'
    ],
    createFields: ['name', 'greeting', 'domain'],
    features: { tools: true, delegation: false, safety: false, viz: false, quickActions: false }
  }
}

/**
 * Get the tab list for a given assistant type.
 * Falls back to 'agent' for unknown types (backward compatible).
 */
export function getTabsForType(type) {
  return ASSISTANT_TYPE_CONFIGS[type]?.tabs || ASSISTANT_TYPE_CONFIGS.agent.tabs
}

/**
 * Get the full config for a given assistant type.
 */
export function getTypeConfig(type) {
  return ASSISTANT_TYPE_CONFIGS[type] || ASSISTANT_TYPE_CONFIGS.agent
}

/**
 * Determine the assistant type from a persona object.
 * Checks persona_json.assistant_type, falls back to role-based inference.
 */
export function resolveAssistantType(entity) {
  // Explicit type in persona
  const explicit = entity?.persona?.assistant_type || entity?._persona?.assistant_type || entity?.assistantType
  if (explicit && ASSISTANT_TYPE_CONFIGS[explicit]) return explicit

  // Infer from role
  const role = entity?.hierarchy?.role || entity?.role
  if (role === 'orchestrator' || role === 'manager') return 'assistant'

  // Infer from source
  const source = entity?.ownership?.source || entity?._source
  if (source === 'scope') return 'assistant'

  // Default
  return 'agent'
}

/**
 * Shared tabs that appear in ALL types (for validation/testing).
 */
export const SHARED_TABS = ['identity', 'personality', 'llm']
