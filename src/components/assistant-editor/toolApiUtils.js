/**
 * Tool API Utilities (TWR-1)
 *
 * Transforms UI tool definitions into auth service API format.
 * Used by ToolBuilderTab to persist custom tools server-side.
 *
 * Auth service endpoints:
 *   POST /orgs/:orgId/tools — create custom tool definition
 *   GET  /orgs/:orgId/tools — list org's custom tools
 *   POST /orgs/:orgId/agents/:agentId/tools — assign tool to agent
 */

const DEFCON_TO_RISK = {
  'GREEN': 'low',
  'BLUE': 'low',
  'AMBER': 'medium',
  'ORANGE': 'high',
  'RED': 'critical',
}

/**
 * Transform a UI tool definition (from ToolBuilderTab) into the auth service
 * POST /orgs/:orgId/tools request body.
 *
 * @param {object} uiTool — { id, name, description, category, parameters[], accessLevel, defconLevel, requiresApproval }
 * @returns {object} — auth API format
 */
export function buildToolCreatePayload(uiTool) {
  // Build JSON Schema for input parameters
  const properties = {}
  const required = []

  if (Array.isArray(uiTool.parameters)) {
    uiTool.parameters.forEach(p => {
      if (!p.name) return
      properties[p.name] = {
        type: p.type || 'string',
        ...(p.description && { description: p.description }),
        ...(p.default !== undefined && p.default !== '' && { default: p.default }),
        ...(p.enum && p.enum.length > 0 && { enum: p.enum }),
      }
      if (p.required) required.push(p.name)
    })
  }

  const inputSchema = {
    type: 'object',
    properties,
    required,
  }

  return {
    name: uiTool.name || uiTool.id,
    slug: uiTool.id,
    description: uiTool.description || '',
    tool_type: 'function',
    risk_level: DEFCON_TO_RISK[uiTool.defconLevel] || 'low',
    requires_approval: uiTool.requiresApproval || false,
    input_schema: inputSchema,
    output_schema: {},
    spec: {
      category: uiTool.category || 'data',
      accessLevel: uiTool.accessLevel || 'specialists+',
      defconLevel: uiTool.defconLevel || 'GREEN',
      _custom: true,
      _version: '2.0',
    },
  }
}

/**
 * Build a tool assignment payload for POST /orgs/:orgId/agents/:agentId/tools
 *
 * @param {string} toolInstallationId — the installation ID (from tool_installations table)
 * @param {string} accessMode — 'full' | 'read_only' | 'with_approval'
 * @returns {object}
 */
export function buildToolAssignPayload(toolInstallationId, accessMode = 'full') {
  return {
    tool_installation_id: toolInstallationId,
    access_mode: accessMode,
  }
}

/**
 * Create a custom tool and return its ID.
 * Calls POST /orgs/:orgId/tools via authFetch.
 *
 * @param {function} authFetch — authenticated fetch
 * @param {string} orgId
 * @param {object} uiTool — UI tool definition from ToolBuilderTab
 * @returns {Promise<{success: boolean, toolId?: string, error?: string}>}
 */
export async function createCustomTool(authFetch, orgId, uiTool) {
  try {
    const payload = buildToolCreatePayload(uiTool)
    const resp = await authFetch(`/api/orgs/${orgId}/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      return { success: false, error: err.error || `HTTP ${resp.status}` }
    }

    const data = await resp.json()
    return { success: true, toolId: data.tool?.id || data.id }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

/**
 * Load org's custom tools.
 * Calls GET /orgs/:orgId/tools via authFetch.
 *
 * @param {function} authFetch
 * @param {string} orgId
 * @returns {Promise<Array>}
 */
export async function loadOrgTools(authFetch, orgId) {
  try {
    const resp = await authFetch(`/api/orgs/${orgId}/tools?limit=100`)
    if (!resp.ok) return []
    const data = await resp.json()
    return data.tools || data.items || []
  } catch {
    return []
  }
}
