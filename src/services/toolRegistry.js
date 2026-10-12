/**
 * Tool Registry Service
 *
 * AutoGen-style dynamic tool discovery and management.
 * Tools can be registered at runtime and matched to assistant capabilities.
 */

import { getAssistant, listAssistants } from './entityRegistry.js'

// Tool access levels (from assistant manifests)
const ACCESS_LEVELS = {
  'orchestrator': 4,    // Full access
  'managers+': 3,       // Managers and above
  'specialists+': 2,    // Specialists and above
  'restricted': 1,      // Limited access
  'none': 0             // No access
}

// Storage key for custom tools
import { orgGet, orgSet } from './orgScopedStorage'

// Default tool definitions
const DEFAULT_TOOLS = {
  // QuoxAgent Tools
  'quoxagent.execute': {
    id: 'quoxagent.execute',
    name: 'QuoxAgent Execute',
    description: 'Execute commands on remote hosts via QuoxAgent agent',
    category: 'quoxagent',
    accessLevel: 'managers+',
    parameters: {
      hostId: { type: 'string', required: true, description: 'Target host ID' },
      command: { type: 'string', required: true, description: 'Command to execute' },
      timeout: { type: 'number', required: false, description: 'Timeout in seconds', default: 30 }
    },
    returns: { type: 'object', properties: { stdout: 'string', stderr: 'string', exitCode: 'number' } },
    defconLevel: 'AMBER',
    requiresApproval: true,
    endpoint: '/api/v1/jobs'
  },

  'quoxagent.status': {
    id: 'quoxagent.status',
    name: 'QuoxAgent Agent Status',
    description: 'Check status of QuoxAgent agents across the fleet',
    category: 'quoxagent',
    accessLevel: 'specialists+',
    parameters: {
      hostId: { type: 'string', required: false, description: 'Specific host or "all"' }
    },
    returns: { type: 'array', items: { type: 'object' } },
    defconLevel: 'GREEN',
    requiresApproval: false,
    endpoint: '/api/v1/agents'
  },

  'quoxagent.install': {
    id: 'quoxagent.install',
    name: 'QuoxAgent Install',
    description: 'Install QuoxAgent agent on a host',
    category: 'quoxagent',
    accessLevel: 'managers+',
    parameters: {
      hostId: { type: 'string', required: true, description: 'Target host ID' }
    },
    returns: { type: 'object', properties: { success: 'boolean', message: 'string' } },
    defconLevel: 'AMBER',
    requiresApproval: true,
    endpoint: '/install'
  },

  // Prometheus Tools
  'prometheus.query': {
    id: 'prometheus.query',
    name: 'Prometheus Query',
    description: 'Execute PromQL query against Prometheus',
    category: 'prometheus',
    accessLevel: 'specialists+',
    parameters: {
      query: { type: 'string', required: true, description: 'PromQL query' },
      time: { type: 'string', required: false, description: 'Evaluation timestamp (RFC3339 or Unix)' },
      timeout: { type: 'string', required: false, description: 'Evaluation timeout' }
    },
    returns: { type: 'object', properties: { resultType: 'string', result: 'array' } },
    defconLevel: 'GREEN',
    requiresApproval: false,
    endpoint: '/api/v1/query'
  },

  'prometheus.alerts': {
    id: 'prometheus.alerts',
    name: 'Prometheus Alerts',
    description: 'Get current alert status from Prometheus',
    category: 'prometheus',
    accessLevel: 'specialists+',
    parameters: {},
    returns: { type: 'object', properties: { alerts: 'array' } },
    defconLevel: 'GREEN',
    requiresApproval: false,
    endpoint: '/api/v1/alerts'
  },

  'prometheus.targets': {
    id: 'prometheus.targets',
    name: 'Prometheus Targets',
    description: 'Get scrape target health status',
    category: 'prometheus',
    accessLevel: 'specialists+',
    parameters: {},
    returns: { type: 'object', properties: { activeTargets: 'array', droppedTargets: 'array' } },
    defconLevel: 'GREEN',
    requiresApproval: false,
    endpoint: '/api/v1/targets'
  },

  // Grafana Tools
  'grafana.dashboards': {
    id: 'grafana.dashboards',
    name: 'Grafana Dashboards',
    description: 'List available Grafana dashboards',
    category: 'grafana',
    accessLevel: 'specialists+',
    parameters: {
      folder: { type: 'string', required: false, description: 'Filter by folder' }
    },
    returns: { type: 'array', items: { type: 'object' } },
    defconLevel: 'GREEN',
    requiresApproval: false,
    endpoint: '/api/search'
  },

  'grafana.annotations': {
    id: 'grafana.annotations',
    name: 'Grafana Annotations',
    description: 'Create or query Grafana annotations',
    category: 'grafana',
    accessLevel: 'specialists+',
    parameters: {
      dashboardId: { type: 'number', required: false },
      from: { type: 'string', required: false },
      to: { type: 'string', required: false }
    },
    returns: { type: 'array', items: { type: 'object' } },
    defconLevel: 'GREEN',
    requiresApproval: false,
    endpoint: '/api/annotations'
  },

  // Proxmox Tools
  'proxmox.vms': {
    id: 'proxmox.vms',
    name: 'Proxmox VMs',
    description: 'List virtual machines across Proxmox cluster',
    category: 'proxmox',
    accessLevel: 'specialists+',
    parameters: {
      node: { type: 'string', required: false, description: 'Specific node or "all"' },
      status: { type: 'string', required: false, description: 'Filter by status (running, stopped)' }
    },
    returns: { type: 'array', items: { type: 'object' } },
    defconLevel: 'GREEN',
    requiresApproval: false,
    endpoint: '/api2/json/cluster/resources'
  },

  'proxmox.vm.start': {
    id: 'proxmox.vm.start',
    name: 'Proxmox VM Start',
    description: 'Start a virtual machine',
    category: 'proxmox',
    accessLevel: 'managers+',
    parameters: {
      node: { type: 'string', required: true },
      vmid: { type: 'number', required: true }
    },
    returns: { type: 'object', properties: { success: 'boolean', task: 'string' } },
    defconLevel: 'AMBER',
    requiresApproval: false,
    endpoint: '/api2/json/nodes/{node}/qemu/{vmid}/status/start'
  },

  'proxmox.vm.stop': {
    id: 'proxmox.vm.stop',
    name: 'Proxmox VM Stop',
    description: 'Stop a virtual machine',
    category: 'proxmox',
    accessLevel: 'managers+',
    parameters: {
      node: { type: 'string', required: true },
      vmid: { type: 'number', required: true }
    },
    returns: { type: 'object', properties: { success: 'boolean', task: 'string' } },
    defconLevel: 'AMBER',
    requiresApproval: true,
    endpoint: '/api2/json/nodes/{node}/qemu/{vmid}/status/stop'
  },

  'proxmox.vm.snapshot': {
    id: 'proxmox.vm.snapshot',
    name: 'Proxmox VM Snapshot',
    description: 'Create VM snapshot',
    category: 'proxmox',
    accessLevel: 'managers+',
    parameters: {
      node: { type: 'string', required: true },
      vmid: { type: 'number', required: true },
      name: { type: 'string', required: true },
      description: { type: 'string', required: false }
    },
    returns: { type: 'object', properties: { success: 'boolean', task: 'string' } },
    defconLevel: 'AMBER',
    requiresApproval: false,
    endpoint: '/api2/json/nodes/{node}/qemu/{vmid}/snapshot'
  },

  // Docker Tools
  'docker.containers': {
    id: 'docker.containers',
    name: 'Docker Containers',
    description: 'List Docker containers on a host',
    category: 'docker',
    accessLevel: 'specialists+',
    parameters: {
      hostId: { type: 'string', required: true },
      all: { type: 'boolean', required: false, default: true }
    },
    returns: { type: 'array', items: { type: 'object' } },
    defconLevel: 'GREEN',
    requiresApproval: false
  },

  'docker.logs': {
    id: 'docker.logs',
    name: 'Docker Logs',
    description: 'Get container logs',
    category: 'docker',
    accessLevel: 'specialists+',
    parameters: {
      hostId: { type: 'string', required: true },
      container: { type: 'string', required: true },
      tail: { type: 'number', required: false, default: 100 }
    },
    returns: { type: 'string' },
    defconLevel: 'GREEN',
    requiresApproval: false
  },

  'docker.restart': {
    id: 'docker.restart',
    name: 'Docker Restart',
    description: 'Restart a container',
    category: 'docker',
    accessLevel: 'managers+',
    parameters: {
      hostId: { type: 'string', required: true },
      container: { type: 'string', required: true }
    },
    returns: { type: 'object', properties: { success: 'boolean' } },
    defconLevel: 'AMBER',
    requiresApproval: true
  },

  // Memory Tools
  'memory.store': {
    id: 'memory.store',
    name: 'Memory Store',
    description: 'Store information in long-term memory',
    category: 'memory',
    accessLevel: 'specialists+',
    parameters: {
      type: { type: 'string', required: true, enum: ['fact', 'preference', 'decision', 'constraint'] },
      content: { type: 'string', required: true },
      metadata: { type: 'object', required: false }
    },
    returns: { type: 'object', properties: { id: 'string', stored: 'boolean' } },
    defconLevel: 'GREEN',
    requiresApproval: false
  },

  'memory.recall': {
    id: 'memory.recall',
    name: 'Memory Recall',
    description: 'Search and retrieve memories',
    category: 'memory',
    accessLevel: 'specialists+',
    parameters: {
      query: { type: 'string', required: true },
      limit: { type: 'number', required: false, default: 10 },
      type: { type: 'string', required: false }
    },
    returns: { type: 'array', items: { type: 'object' } },
    defconLevel: 'GREEN',
    requiresApproval: false
  },

  // Analysis Tools
  'analyze.logs': {
    id: 'analyze.logs',
    name: 'Log Analysis',
    description: 'Analyze logs for patterns and anomalies',
    category: 'analysis',
    accessLevel: 'specialists+',
    parameters: {
      source: { type: 'string', required: true },
      timeRange: { type: 'string', required: false, default: '1h' },
      pattern: { type: 'string', required: false }
    },
    returns: { type: 'object', properties: { patterns: 'array', anomalies: 'array', summary: 'string' } },
    defconLevel: 'GREEN',
    requiresApproval: false
  },

  'analyze.trends': {
    id: 'analyze.trends',
    name: 'Trend Analysis',
    description: 'Identify trends in metrics over time',
    category: 'analysis',
    accessLevel: 'specialists+',
    parameters: {
      metric: { type: 'string', required: true },
      period: { type: 'string', required: false, default: '7d' }
    },
    returns: { type: 'object', properties: { trend: 'string', slope: 'number', forecast: 'array' } },
    defconLevel: 'GREEN',
    requiresApproval: false
  }
}

// Registry cache
let _toolsCache = null

// Clear cache on org switch so tools reload from new org's namespace
if (typeof window !== 'undefined') {
  window.addEventListener('quox-org-switch', () => { _toolsCache = null })
}

/**
 * Load custom tools from localStorage
 */
function loadCustomTools() {
  try {
    const stored = orgGet('custom-tools')
    return stored ? JSON.parse(stored) : {}
  } catch (err) {
    console.warn('Failed to load custom tools:', err)
    return {}
  }
}

/**
 * Save custom tools to localStorage
 */
function saveCustomTools(tools) {
  try {
    orgSet('custom-tools', JSON.stringify(tools))
    return true
  } catch (err) {
    console.error('Failed to save custom tools:', err)
    return false
  }
}

/**
 * Get all tools (default + custom)
 */
export function getTools() {
  if (_toolsCache) return _toolsCache

  const customTools = loadCustomTools()
  _toolsCache = { ...DEFAULT_TOOLS, ...customTools }
  return _toolsCache
}

/**
 * Get a single tool by ID
 */
export function getTool(id) {
  const tools = getTools()
  return tools[id] || null
}

/**
 * List all tools with optional filtering
 */
export function listTools(options = {}) {
  const { category, accessLevel, defconLevel, search } = options
  const tools = Object.values(getTools())

  let result = tools

  if (category) {
    result = result.filter(t => t.category === category)
  }

  if (accessLevel) {
    const minLevel = ACCESS_LEVELS[accessLevel] || 0
    result = result.filter(t => ACCESS_LEVELS[t.accessLevel] >= minLevel)
  }

  if (defconLevel) {
    result = result.filter(t => t.defconLevel === defconLevel)
  }

  if (search) {
    const searchLower = search.toLowerCase()
    result = result.filter(t =>
      t.name.toLowerCase().includes(searchLower) ||
      t.description.toLowerCase().includes(searchLower) ||
      t.id.toLowerCase().includes(searchLower)
    )
  }

  return result.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Get tools by category
 */
export function getToolsByCategory(category) {
  return listTools({ category })
}

/**
 * Get all unique categories
 */
export function getCategories() {
  const tools = Object.values(getTools())
  const categories = new Set(tools.map(t => t.category))
  return Array.from(categories).sort()
}

/**
 * Check if an assistant can access a tool
 */
export function canAccessTool(assistantId, toolId) {
  const assistant = getAssistant(assistantId)
  const tool = getTool(toolId)

  if (!assistant || !tool) return false

  // Check tool access level
  const assistantAccess = assistant.capabilities.toolAccess
  const toolAccess = tool.accessLevel

  const assistantLevel = ACCESS_LEVELS[assistantAccess] || 0
  const requiredLevel = ACCESS_LEVELS[toolAccess] || 0

  if (assistantLevel < requiredLevel) return false

  // Check if tool is in assistant's capability list
  const toolCapabilities = assistant.capabilities.toolCapabilities || []
  const toolCategory = tool.category

  // Assistant has access if:
  // 1. Tool category matches one of their tool capabilities
  // 2. Or they have wildcard access at their level
  const hasCapability = toolCapabilities.some(cap =>
    cap === toolCategory ||
    cap === tool.id ||
    cap.includes(toolCategory)
  )

  return hasCapability || assistantLevel >= ACCESS_LEVELS['managers+']
}

/**
 * Get tools available to an assistant
 */
export function getToolsForAssistant(assistantId) {
  const allTools = Object.values(getTools())
  return allTools.filter(tool => canAccessTool(assistantId, tool.id))
}

/**
 * Find assistants that can use a specific tool
 */
export function findAssistantsForTool(toolId) {
  const assistants = listAssistants()
  return assistants.filter(a => canAccessTool(a.id, toolId))
}

/**
 * Register a new tool
 */
export function registerTool(tool) {
  if (!tool.id || !tool.name) {
    throw new Error('Tool must have id and name')
  }

  const customTools = loadCustomTools()
  customTools[tool.id] = {
    ...tool,
    _custom: true,
    _registeredAt: new Date().toISOString()
  }

  if (saveCustomTools(customTools)) {
    _toolsCache = null // Invalidate cache
    return getTool(tool.id)
  }

  return null
}

/**
 * Unregister a custom tool
 */
export function unregisterTool(toolId) {
  const tool = getTool(toolId)
  if (!tool || !tool._custom) {
    return false // Can't unregister default tools
  }

  const customTools = loadCustomTools()
  delete customTools[toolId]

  if (saveCustomTools(customTools)) {
    _toolsCache = null
    return true
  }

  return false
}

/**
 * Generate tool documentation for context injection
 */
export function generateToolDocs(assistantId = null) {
  const tools = assistantId ? getToolsForAssistant(assistantId) : Object.values(getTools())

  const lines = ['### Available Tools\n']

  // Group by category
  const byCategory = {}
  for (const tool of tools) {
    if (!byCategory[tool.category]) {
      byCategory[tool.category] = []
    }
    byCategory[tool.category].push(tool)
  }

  for (const [category, categoryTools] of Object.entries(byCategory)) {
    lines.push(`#### ${category.toUpperCase()}`)

    for (const tool of categoryTools) {
      lines.push(`- **${tool.name}** (\`${tool.id}\`): ${tool.description}`)

      // Show parameters
      if (tool.parameters && Object.keys(tool.parameters).length > 0) {
        const params = Object.entries(tool.parameters)
          .map(([name, schema]) => `${name}${schema.required ? '*' : ''}`)
          .join(', ')
        lines.push(`  - Params: ${params}`)
      }

      // Show access and safety
      lines.push(`  - Access: ${tool.accessLevel}, DEFCON: ${tool.defconLevel}${tool.requiresApproval ? ' (approval required)' : ''}`)
    }

    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Generate OpenAI-style function definitions for tools
 */
export function generateFunctionDefinitions(assistantId = null) {
  const tools = assistantId ? getToolsForAssistant(assistantId) : Object.values(getTools())

  return tools.map(tool => ({
    name: tool.id.replace(/\./g, '_'),
    description: tool.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.parameters || {}).map(([name, schema]) => [
          name,
          {
            type: schema.type,
            description: schema.description,
            enum: schema.enum,
            default: schema.default
          }
        ])
      ),
      required: Object.entries(tool.parameters || {})
        .filter(([, schema]) => schema.required)
        .map(([name]) => name)
    }
  }))
}

/**
 * Validate tool invocation
 */
export function validateToolCall(toolId, params, assistantId = null) {
  const tool = getTool(toolId)

  if (!tool) {
    return { valid: false, error: `Tool not found: ${toolId}` }
  }

  if (assistantId && !canAccessTool(assistantId, toolId)) {
    return { valid: false, error: `Assistant ${assistantId} cannot access tool ${toolId}` }
  }

  // Validate required parameters
  const errors = []
  for (const [name, schema] of Object.entries(tool.parameters || {})) {
    if (schema.required && !(name in params)) {
      errors.push(`Missing required parameter: ${name}`)
    }

    if (name in params && schema.type) {
      const actualType = typeof params[name]
      if (schema.type === 'number' && actualType !== 'number') {
        errors.push(`Parameter ${name} must be a number`)
      }
      if (schema.type === 'string' && actualType !== 'string') {
        errors.push(`Parameter ${name} must be a string`)
      }
      if (schema.type === 'boolean' && actualType !== 'boolean') {
        errors.push(`Parameter ${name} must be a boolean`)
      }
      if (schema.enum && !schema.enum.includes(params[name])) {
        errors.push(`Parameter ${name} must be one of: ${schema.enum.join(', ')}`)
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  return {
    valid: true,
    tool,
    requiresApproval: tool.requiresApproval,
    defconLevel: tool.defconLevel
  }
}

/**
 * Get tool execution context
 */
export function getToolContext(toolId) {
  const tool = getTool(toolId)
  if (!tool) return null

  return {
    id: tool.id,
    name: tool.name,
    category: tool.category,
    defconLevel: tool.defconLevel,
    requiresApproval: tool.requiresApproval,
    endpoint: tool.endpoint,
    accessLevel: tool.accessLevel
  }
}

export default {
  getTools,
  getTool,
  listTools,
  getToolsByCategory,
  getCategories,
  canAccessTool,
  getToolsForAssistant,
  findAssistantsForTool,
  registerTool,
  unregisterTool,
  generateToolDocs,
  generateFunctionDefinitions,
  validateToolCall,
  getToolContext
}
