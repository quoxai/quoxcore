/**
 * Workflow Utilities — engine-agnostic workflow JSON helpers
 *
 * Extracted from n8nClient.js during n8n decoupling.
 * These functions operate on workflow JSON format (parsing, summarizing,
 * exporting, templates) and have no dependency on any execution engine.
 */

/**
 * Parse workflow JSON
 * @param {string} jsonString - Raw JSON string
 * @returns {object} Parsed workflow with validation
 */
export function parseWorkflowJson(jsonString) {
  try {
    const data = JSON.parse(jsonString)

    if (!data.name) {
      throw new Error('Workflow must have a name')
    }
    if (!data.nodes || !Array.isArray(data.nodes)) {
      throw new Error('Workflow must have a nodes array')
    }

    return {
      valid: true,
      workflow: data,
      metadata: {
        name: data.name,
        nodeCount: data.nodes.length,
        nodeTypes: [...new Set(data.nodes.map(n => n.type))],
        hasTrigger: data.nodes.some(n =>
          n.type.includes('Trigger') ||
          n.type.includes('Webhook') ||
          n.type.includes('Schedule')
        ),
        hasCredentials: data.nodes.some(n => n.credentials && Object.keys(n.credentials).length > 0),
        credentialTypes: [...new Set(
          data.nodes
            .filter(n => n.credentials)
            .flatMap(n => Object.keys(n.credentials))
        )]
      }
    }
  } catch (err) {
    return {
      valid: false,
      error: err.message
    }
  }
}

/**
 * Export workflow to JSON string
 * @param {object} workflow - Workflow object
 * @returns {string} JSON string
 */
export function exportWorkflowJson(workflow) {
  return JSON.stringify(workflow, null, 2)
}

/**
 * Summarize a workflow for display
 * @param {object} workflow - Workflow object
 */
export function summarizeWorkflow(workflow) {
  const nodes = workflow.nodes || []
  const triggerNode = nodes.find(n => {
    const t = (n.type || '').toLowerCase()
    return t.includes('trigger') || t.includes('webhook') || t.includes('schedule') || t.includes('start')
  })

  return {
    id: workflow.id,
    name: workflow.name,
    active: workflow.active,
    nodeCount: nodes.length,
    description: workflow.description,
    trigger: triggerNode ? {
      type: triggerNode.type,
      name: triggerNode.name
    } : null,
    nodeTypes: [...new Set(nodes.map(n => (n.type || '').replace('n8n-nodes-base.', '')))],
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt
  }
}

// =============================================================================
// WORKFLOW TEMPLATES
// =============================================================================

export const WORKFLOW_TEMPLATES = {
  webhook_to_notification: {
    name: 'Webhook to Notification',
    description: 'Receive webhook, process data, send notification',
    nodes: [
      {
        type: 'n8n-nodes-base.webhook',
        name: 'Webhook Trigger',
        parameters: { path: 'quox-webhook' }
      },
      {
        type: 'n8n-nodes-base.set',
        name: 'Set Data',
        parameters: {}
      }
    ]
  },

  scheduled_check: {
    name: 'Scheduled Check',
    description: 'Run checks on a schedule',
    nodes: [
      {
        type: 'n8n-nodes-base.cron',
        name: 'Schedule Trigger',
        parameters: { cronExpression: '0 * * * *' }
      },
      {
        type: 'n8n-nodes-base.httpRequest',
        name: 'HTTP Request',
        parameters: {}
      }
    ]
  },

  hitl_approval: {
    name: 'HITL Approval Flow',
    description: 'Request human approval before proceeding',
    nodes: [
      {
        type: 'n8n-nodes-base.webhook',
        name: 'Start',
        parameters: {}
      },
      {
        type: 'n8n-nodes-base.wait',
        name: 'Wait for Approval',
        parameters: { resumeMode: 'webhook' }
      }
    ]
  }
}

/**
 * Get available workflow templates
 */
export function getWorkflowTemplates() {
  return Object.entries(WORKFLOW_TEMPLATES).map(([key, template]) => ({
    id: key,
    ...template
  }))
}
