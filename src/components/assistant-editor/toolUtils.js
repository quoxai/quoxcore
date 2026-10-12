/**
 * Tool Utilities (AUX-5)
 *
 * Validation and schema generation for custom tool definitions.
 * Used by ToolBuilderTab for creating tools via UI.
 */

export const TOOL_CATEGORIES = [
  'orchestration', 'infrastructure', 'data', 'dev', 'analytics', 'security',
  'content', 'visualization', 'governance', 'social', 'marketing', 'customer_service',
  'sales', 'project_management', 'model', 'image', 'audio', 'video',
]

export const ACCESS_LEVELS = [
  { id: 'all', label: 'All agents', level: 0 },
  { id: 'workers+', label: 'Workers and above', level: 1 },
  { id: 'specialists+', label: 'Specialists and above', level: 2 },
  { id: 'managers+', label: 'Managers and above', level: 3 },
  { id: 'orchestrator', label: 'Orchestrator only', level: 4 },
]

export const DEFCON_LEVELS = [
  { id: 'GREEN', label: 'GREEN — Safe, read-only', color: '#30ff90' },
  { id: 'BLUE', label: 'BLUE — Informational', color: '#38bdf8' },
  { id: 'AMBER', label: 'AMBER — Caution, may modify state', color: '#f59e0b' },
  { id: 'ORANGE', label: 'ORANGE — Elevated risk', color: '#f97316' },
  { id: 'RED', label: 'RED — Critical, destructive potential', color: '#ef4444' },
]

export const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object']

/**
 * Validate a tool definition. Returns array of error strings (empty = valid).
 */
export function validateToolDefinition(tool) {
  const errors = []

  if (!tool.id || !tool.id.trim()) {
    errors.push('Tool ID is required')
  } else if (!/^[a-z][a-z0-9_-]*$/.test(tool.id)) {
    errors.push('Tool ID must be lowercase alphanumeric with underscores/dashes')
  }

  if (!tool.name || !tool.name.trim()) {
    errors.push('Tool name is required')
  } else if (tool.name.length > 50) {
    errors.push('Tool name must be 50 characters or less')
  }

  if (!tool.description || !tool.description.trim()) {
    errors.push('Description is required')
  } else if (tool.description.length > 500) {
    errors.push('Description must be 500 characters or less')
  }

  if (tool.parameters && Array.isArray(tool.parameters)) {
    tool.parameters.forEach((p, i) => {
      if (!p.name || !p.name.trim()) {
        errors.push(`Parameter ${i + 1}: name is required`)
      }
      if (!PARAM_TYPES.includes(p.type)) {
        errors.push(`Parameter ${i + 1}: invalid type "${p.type}"`)
      }
    })
  }

  return errors
}

/**
 * Generate a v2-compatible tool schema object from a UI definition.
 */
export function generateToolSchema(tool) {
  const parameters = {}
  if (Array.isArray(tool.parameters)) {
    tool.parameters.forEach(p => {
      parameters[p.name] = {
        type: p.type,
        description: p.description || '',
        ...(p.required && { required: true }),
        ...(p.default !== undefined && p.default !== '' && { default: p.default }),
        ...(p.enum && p.enum.length > 0 && { enum: p.enum }),
        ...(p.sensitive && { sensitive: true }),
      }
    })
  }

  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    category: tool.category || 'data',
    parameters,
    accessLevel: tool.accessLevel || 'specialists+',
    defconLevel: tool.defconLevel || 'GREEN',
    requiresApproval: tool.requiresApproval || false,
  }
}
