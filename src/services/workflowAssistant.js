/**
 * Workflow Assistant - AI-Powered Workflow Builder
 *
 * Core conversation engine for the Workflow Lab plugin.
 * Guides users through building n8n workflows via natural language chat.
 *
 * The Workflow Engineering Loop:
 * BRIEF → BUILD PLAN → GENERATE JSON → SIMULATE → DEPLOY → OBSERVE → REFACTOR
 */

import { parseWorkflowJson, summarizeWorkflow } from './workflowEngine'

// =============================================================================
// CONVERSATION PHASES
// =============================================================================

export const WORKFLOW_PHASES = {
  BRIEF: 'brief',           // What do you want to automate?
  TRIGGER: 'trigger',       // When should it run?
  DATA_SOURCE: 'source',    // Where does data come from?
  TRANSFORM: 'transform',   // Any processing needed?
  DESTINATION: 'dest',      // Where does output go?
  APPROVAL: 'approval',     // Needs human approval?
  REVIEW: 'review',         // Confirm before generation
  GENERATE: 'generate',     // Building the workflow
  COMPLETE: 'complete'      // Workflow ready
}

export const PHASE_LABELS = {
  [WORKFLOW_PHASES.BRIEF]: 'Understanding Your Need',
  [WORKFLOW_PHASES.TRIGGER]: 'Trigger Configuration',
  [WORKFLOW_PHASES.DATA_SOURCE]: 'Data Sources',
  [WORKFLOW_PHASES.TRANSFORM]: 'Processing & Logic',
  [WORKFLOW_PHASES.DESTINATION]: 'Output & Notifications',
  [WORKFLOW_PHASES.APPROVAL]: 'Human Approval',
  [WORKFLOW_PHASES.REVIEW]: 'Review & Confirm',
  [WORKFLOW_PHASES.GENERATE]: 'Generating Workflow',
  [WORKFLOW_PHASES.COMPLETE]: 'Complete'
}

// =============================================================================
// INTENT TYPES
// =============================================================================

export const WORKFLOW_INTENTS = {
  MONITORING: 'monitoring',
  AUTOMATION: 'automation',
  INTEGRATION: 'integration',
  NOTIFICATION: 'notification',
  HITL: 'hitl',
  DATA_PIPELINE: 'data_pipeline',
  UNKNOWN: 'unknown'
}

// =============================================================================
// TRIGGER TYPES
// =============================================================================

export const TRIGGER_TYPES = {
  SCHEDULE: 'schedule',     // Cron/interval based
  WEBHOOK: 'webhook',       // HTTP webhook
  MANUAL: 'manual',         // On-demand execution
  EVENT: 'event'            // External event trigger
}

// =============================================================================
// WORKFLOW ASSISTANT CLASS
// =============================================================================

export class WorkflowAssistant {
  constructor() {
    this.conversation = []
    this.phase = WORKFLOW_PHASES.BRIEF
    this.phaseHistory = []
    this.intent = null
    this.config = {
      name: '',
      description: '',
      trigger: null,
      dataSources: [],
      transforms: [],
      destinations: [],
      hitlRequired: false,
      hitlConfig: null
    }
    this.generatedWorkflow = null
  }

  /**
   * Reset the assistant state
   */
  reset() {
    this.conversation = []
    this.phase = WORKFLOW_PHASES.BRIEF
    this.phaseHistory = []
    this.intent = null
    this.config = {
      name: '',
      description: '',
      trigger: null,
      dataSources: [],
      transforms: [],
      destinations: [],
      hitlRequired: false,
      hitlConfig: null
    }
    this.generatedWorkflow = null
  }

  /**
   * Go back to the previous phase
   * @returns {string|null} The previous phase name, or null if at the beginning
   */
  goToPreviousPhase() {
    if (this.phaseHistory.length === 0) return null
    const previousPhase = this.phaseHistory.pop()
    this.phase = previousPhase
    return previousPhase
  }

  /**
   * Check if we can go back
   * @returns {boolean}
   */
  canGoBack() {
    return this.phaseHistory.length > 0
  }

  /**
   * Serialize the assistant state for persistence
   * @returns {object} Serializable state object
   */
  serialize() {
    return {
      conversation: this.conversation.map(msg => ({
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp
      })),
      phase: this.phase,
      phaseHistory: [...this.phaseHistory],
      intent: this.intent,
      config: { ...this.config },
      generatedWorkflow: this.generatedWorkflow
    }
  }

  /**
   * Restore assistant state from serialized data
   * @param {object} state - Previously serialized state
   * @returns {boolean} True if restored successfully
   */
  deserialize(state) {
    if (!state || typeof state !== 'object') {
      console.warn('[WorkflowAssistant] Invalid state for deserialize')
      return false
    }

    try {
      // Validate phase is known
      const validPhases = Object.values(WORKFLOW_PHASES)
      if (state.phase && !validPhases.includes(state.phase)) {
        console.warn('[WorkflowAssistant] Unknown phase:', state.phase)
        return false
      }

      // Restore state
      this.conversation = Array.isArray(state.conversation) ? state.conversation : []
      this.phase = state.phase || WORKFLOW_PHASES.BRIEF
      this.phaseHistory = Array.isArray(state.phaseHistory) ? state.phaseHistory : []
      this.intent = state.intent || null
      this.config = {
        name: state.config?.name || '',
        description: state.config?.description || '',
        trigger: state.config?.trigger || null,
        dataSources: state.config?.dataSources || [],
        transforms: state.config?.transforms || [],
        destinations: state.config?.destinations || [],
        hitlRequired: state.config?.hitlRequired || false,
        hitlConfig: state.config?.hitlConfig || null
      }
      this.generatedWorkflow = state.generatedWorkflow || null

      console.log('[WorkflowAssistant] Restored state at phase:', this.phase)
      return true
    } catch (err) {
      console.error('[WorkflowAssistant] Failed to deserialize:', err)
      return false
    }
  }

  /**
   * Get the current phase
   */
  getCurrentPhase() {
    return {
      phase: this.phase,
      label: PHASE_LABELS[this.phase]
    }
  }

  /**
   * Get the current configuration
   */
  getConfig() {
    return { ...this.config }
  }

  /**
   * Process a user message and return the assistant's response
   * @param {string} message - User's message
   * @returns {object} Response with text, options, and next phase
   */
  async processMessage(message) {
    // Add user message to conversation
    this.conversation.push({
      role: 'user',
      content: message,
      timestamp: new Date().toISOString()
    })

    let response

    switch (this.phase) {
      case WORKFLOW_PHASES.BRIEF:
        response = await this._handleBrief(message)
        break
      case WORKFLOW_PHASES.TRIGGER:
        response = await this._handleTrigger(message)
        break
      case WORKFLOW_PHASES.DATA_SOURCE:
        response = await this._handleDataSource(message)
        break
      case WORKFLOW_PHASES.TRANSFORM:
        response = await this._handleTransform(message)
        break
      case WORKFLOW_PHASES.DESTINATION:
        response = await this._handleDestination(message)
        break
      case WORKFLOW_PHASES.APPROVAL:
        response = await this._handleApproval(message)
        break
      case WORKFLOW_PHASES.REVIEW:
        response = await this._handleReview(message)
        break
      case WORKFLOW_PHASES.GENERATE:
        response = await this._handleGenerate(message)
        break
      default:
        response = this._createResponse("I'm not sure what phase we're in. Let's start over.", {
          nextPhase: WORKFLOW_PHASES.BRIEF
        })
    }

    // Add assistant response to conversation
    this.conversation.push({
      role: 'assistant',
      content: response.text,
      timestamp: new Date().toISOString()
    })

    return response
  }

  // ===========================================================================
  // PHASE HANDLERS
  // ===========================================================================

  /**
   * Handle the BRIEF phase - understand what the user wants to automate
   */
  async _handleBrief(message) {
    const intent = this._extractIntent(message)
    this.intent = intent

    // Extract workflow name if mentioned
    const nameMatch = message.match(/(?:called?|named?)\s+["']?([^"'\n]+)["']?/i)
    if (nameMatch) {
      this.config.name = nameMatch[1].trim()
    }

    this.config.description = message

    // Generate follow-up questions based on intent
    const followUp = this._getIntentQuestions(intent, message)

    this.phaseHistory.push(this.phase)
    this.phase = WORKFLOW_PHASES.TRIGGER
    return followUp
  }

  /**
   * Handle the TRIGGER phase - determine when the workflow runs
   */
  async _handleTrigger(message) {
    const triggerType = this._extractTriggerType(message)
    const triggerConfig = this._extractTriggerConfig(message, triggerType)

    this.config.trigger = {
      type: triggerType,
      config: triggerConfig
    }

    this.phaseHistory.push(this.phase)
    this.phase = WORKFLOW_PHASES.DATA_SOURCE
    return this._createResponse(
      `Got it! The workflow will ${this._describeTrigger(this.config.trigger)}.\n\nNow, where should the data come from?`,
      {
        options: this._getDataSourceOptions(),
        nextPhase: WORKFLOW_PHASES.DATA_SOURCE
      }
    )
  }

  /**
   * Handle the DATA_SOURCE phase - identify data inputs
   */
  async _handleDataSource(message) {
    const sources = this._extractDataSources(message)
    this.config.dataSources = sources

    this.phaseHistory.push(this.phase)
    this.phase = WORKFLOW_PHASES.TRANSFORM
    return this._createResponse(
      `Data sources configured: ${sources.map(s => s.name).join(', ')}.\n\nDo you need any data transformation or filtering?`,
      {
        options: [
          { label: 'No transformation needed', value: 'none' },
          { label: 'Filter results', value: 'filter' },
          { label: 'Map/transform data', value: 'map' },
          { label: 'Aggregate/summarize', value: 'aggregate' },
          { label: 'Custom logic', value: 'custom' }
        ],
        nextPhase: WORKFLOW_PHASES.TRANSFORM
      }
    )
  }

  /**
   * Handle the TRANSFORM phase - processing logic
   */
  async _handleTransform(message) {
    const transforms = this._extractTransforms(message)
    this.config.transforms = transforms

    this.phaseHistory.push(this.phase)
    this.phase = WORKFLOW_PHASES.DESTINATION
    return this._createResponse(
      `${transforms.length > 0 ? 'Transformation configured.' : 'No transformation needed.'}\n\nWhere should the output go?`,
      {
        options: this._getDestinationOptions(),
        nextPhase: WORKFLOW_PHASES.DESTINATION
      }
    )
  }

  /**
   * Handle the DESTINATION phase - output targets
   */
  async _handleDestination(message) {
    const destinations = this._extractDestinations(message)
    this.config.destinations = destinations

    this.phaseHistory.push(this.phase)
    this.phase = WORKFLOW_PHASES.APPROVAL
    return this._createResponse(
      `Output will go to: ${destinations.map(d => d.name).join(', ')}.\n\nShould this workflow require human approval before critical actions?`,
      {
        options: [
          { label: 'No approval needed', value: 'no' },
          { label: 'Yes, require approval', value: 'yes' },
          { label: 'Only for errors/alerts', value: 'errors_only' }
        ],
        nextPhase: WORKFLOW_PHASES.APPROVAL
      }
    )
  }

  /**
   * Handle the APPROVAL phase - HITL configuration
   */
  async _handleApproval(message) {
    const needsApproval = this._extractApprovalConfig(message)
    this.config.hitlRequired = needsApproval.required
    this.config.hitlConfig = needsApproval.config

    // Generate workflow name if not set
    if (!this.config.name) {
      this.config.name = this._generateWorkflowName()
    }

    this.phaseHistory.push(this.phase)
    this.phase = WORKFLOW_PHASES.REVIEW
    return this._createResponse(
      this._generateReviewSummary(),
      {
        options: [
          { label: 'Generate Workflow', value: 'generate', primary: true },
          { label: 'Make Changes', value: 'edit' },
          { label: 'Start Over', value: 'reset' }
        ],
        nextPhase: WORKFLOW_PHASES.REVIEW
      }
    )
  }

  /**
   * Handle the REVIEW phase - confirm and generate
   */
  async _handleReview(message) {
    const lower = message.toLowerCase()

    if (lower.includes('generate') || lower.includes('yes') || lower.includes('confirm') || lower.includes('looks good')) {
      this.phaseHistory.push(this.phase)
      this.phase = WORKFLOW_PHASES.GENERATE
      const workflow = this._generateN8nWorkflow()
      this.generatedWorkflow = workflow

      return this._createResponse(
        `Workflow "${this.config.name}" has been generated!\n\n${this._formatWorkflowPreview(workflow)}`,
        {
          workflow,
          options: [
            { label: 'Deploy Workflow', value: 'deploy', primary: true },
            { label: 'Run Simulation', value: 'simulate' },
            { label: 'Download JSON', value: 'download' },
            { label: 'Make Changes', value: 'edit' }
          ],
          nextPhase: WORKFLOW_PHASES.COMPLETE
        }
      )
    } else if (lower.includes('edit') || lower.includes('change')) {
      return this._createResponse(
        'What would you like to change?',
        {
          options: [
            { label: 'Trigger', value: 'trigger' },
            { label: 'Data Sources', value: 'sources' },
            { label: 'Transformations', value: 'transforms' },
            { label: 'Destinations', value: 'destinations' },
            { label: 'Approval Settings', value: 'approval' }
          ]
        }
      )
    } else if (lower.includes('reset') || lower.includes('start over')) {
      this.reset()
      return this._createResponse(
        'Starting over. What would you like to automate?',
        { nextPhase: WORKFLOW_PHASES.BRIEF }
      )
    }

    return this._createResponse(
      'Would you like to generate the workflow, make changes, or start over?',
      {
        options: [
          { label: 'Generate Workflow', value: 'generate', primary: true },
          { label: 'Make Changes', value: 'edit' },
          { label: 'Start Over', value: 'reset' }
        ]
      }
    )
  }

  /**
   * Handle the GENERATE phase - post-generation actions
   */
  async _handleGenerate(message) {
    const lower = message.toLowerCase()

    if (lower.includes('deploy')) {
      return this._createResponse(
        'Deploying workflow...',
        {
          action: 'deploy',
          workflow: this.generatedWorkflow
        }
      )
    } else if (lower.includes('simulate') || lower.includes('test')) {
      return this._createResponse(
        'Running workflow simulation...',
        {
          action: 'simulate',
          workflow: this.generatedWorkflow
        }
      )
    } else if (lower.includes('download')) {
      return this._createResponse(
        'Here\'s your workflow JSON:',
        {
          action: 'download',
          workflow: this.generatedWorkflow
        }
      )
    }

    return this._createResponse(
      'What would you like to do with the workflow?',
      {
        options: [
          { label: 'Deploy Workflow', value: 'deploy', primary: true },
          { label: 'Run Simulation', value: 'simulate' },
          { label: 'Download JSON', value: 'download' }
        ]
      }
    )
  }

  // ===========================================================================
  // EXTRACTION HELPERS
  // ===========================================================================

  /**
   * Extract workflow intent from user message
   */
  _extractIntent(message) {
    const lower = message.toLowerCase()

    // Monitoring keywords
    if (/monitor|watch|check|alert|notify.*when|cpu|memory|disk|health|uptime|status/i.test(lower)) {
      return WORKFLOW_INTENTS.MONITORING
    }

    // Automation keywords
    if (/automat|schedule|cleanup|backup|deploy|restart|start|stop|run.*daily|run.*hourly/i.test(lower)) {
      return WORKFLOW_INTENTS.AUTOMATION
    }

    // Integration keywords
    if (/sync|integrat|connect|api|webhook|fetch.*from|send.*to|import|export/i.test(lower)) {
      return WORKFLOW_INTENTS.INTEGRATION
    }

    // Notification keywords
    if (/notify|alert|send.*message|email|telegram|slack|digest|report/i.test(lower)) {
      return WORKFLOW_INTENTS.NOTIFICATION
    }

    // HITL keywords
    if (/approv|review|confirm|human|manual.*check|override/i.test(lower)) {
      return WORKFLOW_INTENTS.HITL
    }

    // Data pipeline keywords
    if (/pipeline|etl|transform|process.*data|collect.*data/i.test(lower)) {
      return WORKFLOW_INTENTS.DATA_PIPELINE
    }

    return WORKFLOW_INTENTS.UNKNOWN
  }

  /**
   * Extract trigger type from message
   */
  _extractTriggerType(message) {
    const lower = message.toLowerCase()

    if (/every|hourly|daily|weekly|monthly|cron|schedule|interval|\d+\s*(minute|hour|day|week)/i.test(lower)) {
      return TRIGGER_TYPES.SCHEDULE
    }

    if (/webhook|http|post.*to|call.*url|endpoint/i.test(lower)) {
      return TRIGGER_TYPES.WEBHOOK
    }

    if (/manual|on.?demand|when.*i.*say|click|button/i.test(lower)) {
      return TRIGGER_TYPES.MANUAL
    }

    // Default to schedule for monitoring/automation
    if (this.intent === WORKFLOW_INTENTS.MONITORING || this.intent === WORKFLOW_INTENTS.AUTOMATION) {
      return TRIGGER_TYPES.SCHEDULE
    }

    return TRIGGER_TYPES.MANUAL
  }

  /**
   * Extract trigger configuration details
   */
  _extractTriggerConfig(message, triggerType) {
    const lower = message.toLowerCase()
    const config = {}

    if (triggerType === TRIGGER_TYPES.SCHEDULE) {
      // Extract interval
      const intervalMatch = lower.match(/every\s+(\d+)\s*(minute|hour|day|week)/i)
      if (intervalMatch) {
        config.interval = parseInt(intervalMatch[1])
        config.unit = intervalMatch[2].toLowerCase()
      } else if (/hourly/i.test(lower)) {
        config.interval = 1
        config.unit = 'hour'
      } else if (/daily/i.test(lower)) {
        config.interval = 1
        config.unit = 'day'
      } else if (/weekly/i.test(lower)) {
        config.interval = 1
        config.unit = 'week'
      } else {
        // Default: every 5 minutes for monitoring
        config.interval = 5
        config.unit = 'minute'
      }

      // Convert to cron
      config.cron = this._intervalToCron(config.interval, config.unit)
    }

    if (triggerType === TRIGGER_TYPES.WEBHOOK) {
      config.path = '/quox-workflow'
      config.method = 'POST'
    }

    return config
  }

  /**
   * Extract data sources from message
   */
  _extractDataSources(message) {
    const lower = message.toLowerCase()
    const sources = []

    // Host/server sources
    const hostPatterns = [
      /(?:from\s+)?(?:host|server)s?\s+([a-z0-9,\s-]+)/i,
      /(?:docker|proxmox|kuma)\d+/gi,
      /all\s+(?:docker|proxmox|monitoring)\s+hosts/i
    ]

    for (const pattern of hostPatterns) {
      const match = lower.match(pattern)
      if (match) {
        sources.push({
          type: 'host',
          name: 'Host Metrics',
          config: { hosts: match[1] || match[0] }
        })
      }
    }

    // API sources
    if (/api|endpoint|url|http/i.test(lower)) {
      sources.push({
        type: 'http',
        name: 'HTTP API',
        config: {}
      })
    }

    // QuoxAgent/agent sources
    if (/quoxagent|agent/i.test(lower)) {
      sources.push({
        type: 'quoxagent',
        name: 'QuoxAgent Agent',
        config: {}
      })
    }

    // Default: webhook data
    if (sources.length === 0 && this.config.trigger?.type === TRIGGER_TYPES.WEBHOOK) {
      sources.push({
        type: 'webhook_body',
        name: 'Webhook Data',
        config: {}
      })
    }

    return sources.length > 0 ? sources : [{ type: 'manual', name: 'Manual Input', config: {} }]
  }

  /**
   * Extract transformations from message
   */
  _extractTransforms(message) {
    const lower = message.toLowerCase()
    const transforms = []

    if (/none|no\s+transform|skip/i.test(lower)) {
      return transforms
    }

    if (/filter|where|only.*if|greater.*than|less.*than|threshold/i.test(lower)) {
      transforms.push({
        type: 'filter',
        name: 'Filter',
        config: {}
      })

      // Extract threshold conditions
      const thresholdMatch = lower.match(/(cpu|memory|disk)\s*>\s*(\d+)/gi)
      if (thresholdMatch) {
        transforms[transforms.length - 1].config.conditions = thresholdMatch
      }
    }

    if (/map|transform|convert|format/i.test(lower)) {
      transforms.push({
        type: 'map',
        name: 'Transform Data',
        config: {}
      })
    }

    if (/aggregat|sum|average|count|group/i.test(lower)) {
      transforms.push({
        type: 'aggregate',
        name: 'Aggregate',
        config: {}
      })
    }

    return transforms
  }

  /**
   * Extract destinations from message
   */
  _extractDestinations(message) {
    const lower = message.toLowerCase()
    const destinations = []

    if (/telegram/i.test(lower)) {
      destinations.push({
        type: 'telegram',
        name: 'Telegram',
        config: {}
      })
    }

    if (/email|mail/i.test(lower)) {
      destinations.push({
        type: 'email',
        name: 'Email',
        config: {}
      })
    }

    if (/slack/i.test(lower)) {
      destinations.push({
        type: 'slack',
        name: 'Slack',
        config: {}
      })
    }

    if (/inbox|dashboard|quox/i.test(lower)) {
      destinations.push({
        type: 'inbox',
        name: 'Quox Inbox',
        config: {}
      })
    }

    if (/webhook|http.*post|api/i.test(lower)) {
      destinations.push({
        type: 'webhook',
        name: 'Webhook',
        config: {}
      })
    }

    // Default: inbox
    if (destinations.length === 0) {
      destinations.push({
        type: 'inbox',
        name: 'Quox Inbox',
        config: {}
      })
    }

    return destinations
  }

  /**
   * Extract approval configuration
   */
  _extractApprovalConfig(message) {
    const lower = message.toLowerCase()

    if (/yes|require|need|want.*approval/i.test(lower)) {
      return {
        required: true,
        config: {
          type: 'all_actions',
          timeout: '1h'
        }
      }
    }

    if (/error|alert|critical|danger/i.test(lower)) {
      return {
        required: true,
        config: {
          type: 'errors_only',
          timeout: '30m'
        }
      }
    }

    return {
      required: false,
      config: null
    }
  }

  // ===========================================================================
  // GENERATION HELPERS
  // ===========================================================================

  /**
   * Generate workflow name from config
   */
  _generateWorkflowName() {
    const intentNames = {
      [WORKFLOW_INTENTS.MONITORING]: 'Monitor',
      [WORKFLOW_INTENTS.AUTOMATION]: 'Automate',
      [WORKFLOW_INTENTS.INTEGRATION]: 'Sync',
      [WORKFLOW_INTENTS.NOTIFICATION]: 'Notify',
      [WORKFLOW_INTENTS.HITL]: 'Approval',
      [WORKFLOW_INTENTS.DATA_PIPELINE]: 'Pipeline'
    }

    const prefix = intentNames[this.intent] || 'Workflow'
    const timestamp = new Date().toISOString().slice(0, 10)
    return `${prefix}-${timestamp}`
  }

  /**
   * Generate the n8n workflow JSON
   */
  _generateN8nWorkflow() {
    const nodes = []
    const connections = {}
    let nodeIndex = 0
    let lastNodeName = null

    // Add trigger node
    const triggerNode = this._createTriggerNode(nodeIndex++)
    nodes.push(triggerNode)
    lastNodeName = triggerNode.name

    // Add data source nodes
    for (const source of this.config.dataSources) {
      const sourceNode = this._createDataSourceNode(source, nodeIndex++)
      nodes.push(sourceNode)

      if (lastNodeName) {
        connections[lastNodeName] = { main: [[{ node: sourceNode.name, type: 'main', index: 0 }]] }
      }
      lastNodeName = sourceNode.name
    }

    // Add transform nodes
    for (const transform of this.config.transforms) {
      const transformNode = this._createTransformNode(transform, nodeIndex++)
      nodes.push(transformNode)

      if (lastNodeName) {
        connections[lastNodeName] = { main: [[{ node: transformNode.name, type: 'main', index: 0 }]] }
      }
      lastNodeName = transformNode.name
    }

    // Add HITL node if required
    if (this.config.hitlRequired) {
      const hitlNode = this._createHitlNode(nodeIndex++)
      nodes.push(hitlNode)

      if (lastNodeName) {
        connections[lastNodeName] = { main: [[{ node: hitlNode.name, type: 'main', index: 0 }]] }
      }
      lastNodeName = hitlNode.name
    }

    // Add destination nodes
    for (const dest of this.config.destinations) {
      const destNode = this._createDestinationNode(dest, nodeIndex++)
      nodes.push(destNode)

      if (lastNodeName) {
        connections[lastNodeName] = { main: [[{ node: destNode.name, type: 'main', index: 0 }]] }
      }
      lastNodeName = destNode.name
    }

    return {
      name: this.config.name,
      nodes,
      connections,
      active: false,
      settings: {
        executionOrder: 'v1'
      },
      tags: [],
      meta: {
        generatedBy: 'Quox Workflow Lab',
        generatedAt: new Date().toISOString(),
        intent: this.intent
      }
    }
  }

  /**
   * Create trigger node based on config
   */
  _createTriggerNode(index) {
    const { type, config } = this.config.trigger

    if (type === TRIGGER_TYPES.SCHEDULE) {
      return {
        id: `node_${index}`,
        name: 'Schedule Trigger',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.1,
        position: [240, 300],
        parameters: {
          rule: {
            interval: [{
              field: 'cronExpression',
              expression: config.cron || '*/5 * * * *'
            }]
          }
        }
      }
    }

    if (type === TRIGGER_TYPES.WEBHOOK) {
      return {
        id: `node_${index}`,
        name: 'Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 1.1,
        position: [240, 300],
        parameters: {
          path: config.path || 'quox-workflow',
          httpMethod: config.method || 'POST'
        },
        webhookId: `quox-${Date.now()}`
      }
    }

    // Manual trigger
    return {
      id: `node_${index}`,
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [240, 300],
      parameters: {}
    }
  }

  /**
   * Create data source node
   */
  _createDataSourceNode(source, index) {
    const baseNode = {
      id: `node_${index}`,
      position: [440 + (index * 200), 300]
    }

    if (source.type === 'http' || source.type === 'host') {
      return {
        ...baseNode,
        name: `Fetch ${source.name}`,
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.1,
        parameters: {
          method: 'GET',
          url: '={{ $vars.api_url }}',
          options: {}
        }
      }
    }

    if (source.type === 'quoxagent') {
      return {
        ...baseNode,
        name: 'QuoxAgent Agent Query',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.1,
        parameters: {
          method: 'GET',
          url: 'http://localhost:9847/api/v1/status',
          options: {}
        }
      }
    }

    // Default: code node for manual processing
    return {
      ...baseNode,
      name: 'Process Data',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      parameters: {
        jsCode: '// Process incoming data\nreturn $input.all()'
      }
    }
  }

  /**
   * Create transform node
   */
  _createTransformNode(transform, index) {
    const baseNode = {
      id: `node_${index}`,
      position: [440 + (index * 200), 300]
    }

    if (transform.type === 'filter') {
      return {
        ...baseNode,
        name: 'Filter Results',
        type: 'n8n-nodes-base.filter',
        typeVersion: 2,
        parameters: {
          conditions: {
            options: {
              caseSensitive: true,
              leftValue: '',
              typeValidation: 'strict'
            },
            conditions: [
              {
                leftValue: '={{ $json.value }}',
                rightValue: 80,
                operator: { type: 'number', operation: 'gt' }
              }
            ]
          }
        }
      }
    }

    if (transform.type === 'map') {
      return {
        ...baseNode,
        name: 'Transform Data',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.2,
        parameters: {
          mode: 'manual',
          duplicateItem: false,
          assignments: {
            assignments: []
          },
          options: {}
        }
      }
    }

    // Default: code node
    return {
      ...baseNode,
      name: transform.name || 'Process',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      parameters: {
        jsCode: '// Custom transformation\nreturn $input.all()'
      }
    }
  }

  /**
   * Create HITL/approval node
   */
  _createHitlNode(index) {
    return {
      id: `node_${index}`,
      name: 'Request Approval',
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [440 + (index * 200), 300],
      parameters: {
        resume: 'webhook',
        options: {
          webhookSuffix: '/approve'
        }
      }
    }
  }

  /**
   * Create destination node
   */
  _createDestinationNode(dest, index) {
    const baseNode = {
      id: `node_${index}`,
      position: [440 + (index * 200), 300]
    }

    if (dest.type === 'telegram') {
      return {
        ...baseNode,
        name: 'Send to Telegram',
        type: 'n8n-nodes-base.telegram',
        typeVersion: 1.1,
        parameters: {
          operation: 'sendMessage',
          chatId: '={{ $vars.telegram_chat_id }}',
          text: '={{ $json.message }}'
        }
      }
    }

    if (dest.type === 'email') {
      return {
        ...baseNode,
        name: 'Send Email',
        type: 'n8n-nodes-base.emailSend',
        typeVersion: 2.1,
        parameters: {
          fromEmail: '={{ $vars.from_email }}',
          toEmail: '={{ $vars.to_email }}',
          subject: '={{ $json.subject }}',
          emailFormat: 'text',
          text: '={{ $json.message }}'
        }
      }
    }

    if (dest.type === 'slack') {
      return {
        ...baseNode,
        name: 'Send to Slack',
        type: 'n8n-nodes-base.slack',
        typeVersion: 2.1,
        parameters: {
          operation: 'message',
          channel: '={{ $vars.slack_channel }}',
          text: '={{ $json.message }}'
        }
      }
    }

    if (dest.type === 'webhook' || dest.type === 'inbox') {
      return {
        ...baseNode,
        name: dest.type === 'inbox' ? 'Create Inbox Item' : 'Send Webhook',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.1,
        parameters: {
          method: 'POST',
          url: dest.type === 'inbox'
            ? 'http://localhost:3001/api/v1/inbox'
            : '={{ $vars.webhook_url }}',
          sendBody: true,
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify($json) }}'
        }
      }
    }

    // Default: set output
    return {
      ...baseNode,
      name: 'Output',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.2,
      parameters: {
        mode: 'manual',
        assignments: {
          assignments: []
        }
      }
    }
  }

  // ===========================================================================
  // RESPONSE HELPERS
  // ===========================================================================

  /**
   * Create a structured response
   */
  _createResponse(text, options = {}) {
    return {
      text,
      options: options.options || null,
      workflow: options.workflow || null,
      action: options.action || null,
      nextPhase: options.nextPhase || this.phase,
      phase: this.phase,
      config: this.getConfig()
    }
  }

  /**
   * Get intent-specific questions
   */
  _getIntentQuestions(intent, originalMessage) {
    const questions = {
      [WORKFLOW_INTENTS.MONITORING]: {
        text: `I'll help you build a monitoring workflow. Let me understand what you need:\n\n**When should this run?**`,
        options: [
          { label: 'Every 5 minutes', value: 'every 5 minutes' },
          { label: 'Every hour', value: 'every hour' },
          { label: 'Every day', value: 'daily' },
          { label: 'When triggered by webhook', value: 'webhook' },
          { label: 'Custom schedule', value: 'custom' }
        ]
      },
      [WORKFLOW_INTENTS.AUTOMATION]: {
        text: `I'll help you automate this task. **When should it run?**`,
        options: [
          { label: 'Daily', value: 'daily' },
          { label: 'Weekly', value: 'weekly' },
          { label: 'On demand', value: 'manual' },
          { label: 'Custom schedule', value: 'custom' }
        ]
      },
      [WORKFLOW_INTENTS.INTEGRATION]: {
        text: `I'll help you set up this integration. **How should it be triggered?**`,
        options: [
          { label: 'Webhook (receive data)', value: 'webhook' },
          { label: 'Scheduled sync', value: 'schedule' },
          { label: 'Manual trigger', value: 'manual' }
        ]
      },
      [WORKFLOW_INTENTS.NOTIFICATION]: {
        text: `I'll help you set up notifications. **When should alerts be sent?**`,
        options: [
          { label: 'When triggered by event', value: 'webhook' },
          { label: 'Scheduled digest', value: 'schedule' },
          { label: 'Manual trigger', value: 'manual' }
        ]
      },
      [WORKFLOW_INTENTS.HITL]: {
        text: `I'll help you create an approval workflow. **What triggers the approval request?**`,
        options: [
          { label: 'Webhook from another system', value: 'webhook' },
          { label: 'Scheduled review', value: 'schedule' },
          { label: 'Manual request', value: 'manual' }
        ]
      },
      [WORKFLOW_INTENTS.UNKNOWN]: {
        text: `I'd like to understand better. What kind of workflow do you need?`,
        options: [
          { label: 'Monitor something', value: 'monitoring' },
          { label: 'Automate a task', value: 'automation' },
          { label: 'Connect systems', value: 'integration' },
          { label: 'Send notifications', value: 'notification' },
          { label: 'Request approvals', value: 'hitl' }
        ]
      }
    }

    return this._createResponse(
      questions[intent]?.text || questions[WORKFLOW_INTENTS.UNKNOWN].text,
      {
        options: questions[intent]?.options || questions[WORKFLOW_INTENTS.UNKNOWN].options,
        nextPhase: WORKFLOW_PHASES.TRIGGER
      }
    )
  }

  /**
   * Get data source options
   */
  _getDataSourceOptions() {
    return [
      { label: 'HTTP/API endpoint', value: 'api' },
      { label: 'Host metrics (via QuoxAgent)', value: 'host' },
      { label: 'Database query', value: 'database' },
      { label: 'Webhook payload', value: 'webhook' },
      { label: 'Manual input', value: 'manual' }
    ]
  }

  /**
   * Get destination options
   */
  _getDestinationOptions() {
    return [
      { label: 'Telegram', value: 'telegram' },
      { label: 'Email', value: 'email' },
      { label: 'Slack', value: 'slack' },
      { label: 'Quox Inbox', value: 'inbox' },
      { label: 'Webhook/API', value: 'webhook' },
      { label: 'Multiple channels', value: 'multiple' }
    ]
  }

  /**
   * Describe trigger configuration
   */
  _describeTrigger(trigger) {
    if (!trigger) return 'run manually'

    const { type, config } = trigger

    if (type === TRIGGER_TYPES.SCHEDULE) {
      if (config.interval && config.unit) {
        return `run every ${config.interval} ${config.unit}${config.interval > 1 ? 's' : ''}`
      }
      return 'run on a schedule'
    }

    if (type === TRIGGER_TYPES.WEBHOOK) {
      return 'trigger via webhook'
    }

    return 'run manually'
  }

  /**
   * Generate review summary
   */
  _generateReviewSummary() {
    const lines = [
      `**Workflow: ${this.config.name || 'Untitled'}**\n`,
      `**Trigger:** ${this._describeTrigger(this.config.trigger)}`,
      `**Data Sources:** ${this.config.dataSources.map(s => s.name).join(', ') || 'None'}`,
      `**Transformations:** ${this.config.transforms.length > 0 ? this.config.transforms.map(t => t.name).join(', ') : 'None'}`,
      `**Destinations:** ${this.config.destinations.map(d => d.name).join(', ')}`,
      `**Human Approval:** ${this.config.hitlRequired ? 'Yes' : 'No'}`,
      '\n**Ready to generate?**'
    ]

    return lines.join('\n')
  }

  /**
   * Format workflow preview
   */
  _formatWorkflowPreview(workflow) {
    const nodeList = workflow.nodes.map(n => `- ${n.name} (${n.type.replace('n8n-nodes-base.', '')})`).join('\n')
    return `**Nodes:**\n${nodeList}\n\n**Total:** ${workflow.nodes.length} nodes`
  }

  /**
   * Convert interval to cron expression
   */
  _intervalToCron(interval, unit) {
    switch (unit) {
      case 'minute':
        return interval === 1 ? '* * * * *' : `*/${interval} * * * *`
      case 'hour':
        return interval === 1 ? '0 * * * *' : `0 */${interval} * * *`
      case 'day':
        return '0 9 * * *' // 9 AM daily
      case 'week':
        return '0 9 * * 1' // Monday 9 AM
      default:
        return '*/5 * * * *'
    }
  }
}

// =============================================================================
// WORKFLOW EXPLANATION
// =============================================================================

/**
 * Generate a plain-English explanation of an n8n workflow
 * @param {object} workflow - n8n workflow JSON
 * @returns {object} Explanation with summary and details
 */
export function explainWorkflow(workflow) {
  const summary = summarizeWorkflow(workflow)

  // Identify trigger
  const triggerNode = workflow.nodes?.find(n =>
    n.type?.includes('Trigger') ||
    n.type?.includes('Webhook') ||
    n.type?.includes('Schedule')
  )

  // Count node types
  const nodeTypes = {}
  for (const node of workflow.nodes || []) {
    const shortType = node.type?.replace('n8n-nodes-base.', '') || 'unknown'
    nodeTypes[shortType] = (nodeTypes[shortType] || 0) + 1
  }

  // Build explanation
  const explanation = {
    summary: `This workflow "${workflow.name}" has ${summary.nodeCount} nodes.`,
    trigger: triggerNode
      ? `It is triggered by: ${triggerNode.type.replace('n8n-nodes-base.', '')}`
      : 'It has no automatic trigger (manual start only)',
    nodeTypes: Object.entries(nodeTypes).map(([type, count]) => `${type}: ${count}`),
    dataFlow: workflow.connections
      ? 'Data flows through ' + Object.keys(workflow.connections).length + ' connections'
      : 'No connections defined',
    credentials: summary.credentialTypes?.length > 0
      ? 'Requires credentials: ' + summary.credentialTypes.join(', ')
      : 'No external credentials required',
    suggestions: []
  }

  // Add improvement suggestions
  if (!workflow.nodes?.some(n => n.type?.includes('errorTrigger'))) {
    explanation.suggestions.push('Consider adding error handling')
  }

  if (summary.nodeCount > 15) {
    explanation.suggestions.push('Workflow is complex - consider splitting into sub-workflows')
  }

  return explanation
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

let instance = null

export function getWorkflowAssistant() {
  if (!instance) {
    instance = new WorkflowAssistant()
  }
  return instance
}

export function createWorkflowAssistant() {
  return new WorkflowAssistant()
}

export default {
  WorkflowAssistant,
  getWorkflowAssistant,
  createWorkflowAssistant,
  explainWorkflow,
  WORKFLOW_PHASES,
  PHASE_LABELS,
  WORKFLOW_INTENTS,
  TRIGGER_TYPES
}
