/**
 * AEE Capability Discovery
 * Allows agents to query each other's capabilities
 *
 * @fileoverview Registry of agent capabilities for the QUOX system
 */

import { createTask, createResult } from './envelope.js'
import { AEE_INTENTS } from './intents.js'

/**
 * @typedef {Object} AgentCapability
 * @property {string} intent - Supported intent
 * @property {string} description - What this capability does
 * @property {string[]} [parameters] - Required parameters
 */

/**
 * @typedef {Object} AgentProfile
 * @property {string} id - Agent identifier (e.g., "agent.cipher")
 * @property {string} name - Display name
 * @property {string} description - What this agent does
 * @property {AgentCapability[]} capabilities - Supported capabilities
 */

/**
 * QUOX Agent Registry
 * @type {Map<string, AgentProfile>}
 */
const agentRegistry = new Map()

// ============================================================================
// Register Default QUOX Agents
// ============================================================================

// QUOX - Executive agent
agentRegistry.set('agent.quox', {
  id: 'agent.quox',
  name: 'CommanderQ',
  description: 'Executive orchestrator for all infrastructure operations',
  capabilities: [
    { intent: 'quox.chat.query', description: 'Handle general queries and route to specialists' },
    { intent: 'quox.agent.delegate', description: 'Delegate tasks to specialist agents' },
    { intent: 'ops.approval.request', description: 'Request approval for high-risk operations' }
  ]
})

// CIPHER - Network/Security specialist
agentRegistry.set('agent.cipher', {
  id: 'agent.cipher',
  name: 'CIPHER',
  description: 'Network and security operations specialist',
  capabilities: [
    { intent: 'quox.chat.query', description: 'Answer network and security questions' },
    { intent: 'ops.network.ping', description: 'Ping hosts for connectivity checks' },
    { intent: 'ops.network.scan', description: 'Scan network for hosts and ports' },
    { intent: 'ops.security.audit', description: 'Perform security audits' }
  ]
})

// WARDEN - Monitoring specialist
agentRegistry.set('agent.sentinel', {
  id: 'agent.sentinel',
  name: 'WARDEN',
  description: 'System monitoring and alerting specialist',
  capabilities: [
    { intent: 'quox.chat.query', description: 'Answer monitoring questions' },
    { intent: 'ops.disk.check', description: 'Check disk usage on hosts' },
    { intent: 'ops.service.status', description: 'Check service status' },
    { intent: 'ops.alert.list', description: 'List active alerts' }
  ]
})

// DAEDALUS - Automation specialist
agentRegistry.set('agent.nova', {
  id: 'agent.nova',
  name: 'DAEDALUS',
  description: 'Automation and deployment specialist',
  capabilities: [
    { intent: 'quox.chat.query', description: 'Answer automation questions' },
    { intent: 'ops.deploy.trigger', description: 'Trigger deployments' },
    { intent: 'ops.container.manage', description: 'Manage Docker containers' },
    { intent: 'ops.backup.create', description: 'Create system backups' }
  ]
})

// QuoxAgent Collector
agentRegistry.set('collector.quox', {
  id: 'collector.quox',
  name: 'QuoxAgent Collector',
  description: 'Central heartbeat collector for QuoxAgent agents',
  capabilities: [
    { intent: 'quoxagent.heartbeat.report', description: 'Receive and store agent heartbeats' },
    { intent: 'quoxagent.fleet.status', description: 'Provide fleet status summary' }
  ]
})

// SCHOLAR - Analytics and insights agent
agentRegistry.set('agent.scholar', {
  id: 'agent.scholar',
  name: 'SCHOLAR',
  description: 'Analytics, pattern detection, and insights specialist',
  capabilities: [
    { intent: 'aee.analyze.conversation', description: 'Analyze and summarize a conversation' },
    { intent: 'aee.analyze.patterns', description: 'Detect patterns and anomalies in AEE data' },
    { intent: 'aee.stats.dashboard', description: 'Generate analytics dashboard' },
    { intent: 'aee.stats.host', description: 'Get host activity statistics' },
    { intent: 'aee.stats.user', description: 'Analyze user behavior patterns' },
    { intent: 'quox.alert.proactive', description: 'Generate proactive alerts from patterns' }
  ]
})

// ARCHIVIST - Memory and knowledge management agent
agentRegistry.set('agent.archivist', {
  id: 'agent.archivist',
  name: 'ARCHIVIST',
  description: 'Memory extraction, knowledge management, and context specialist',
  capabilities: [
    { intent: 'aee.memory.extract', description: 'Extract memories from conversations' },
    { intent: 'aee.memory.consolidate', description: 'Consolidate and deduplicate memories' },
    { intent: 'aee.context.restore', description: 'Restore context from previous conversations' },
    { intent: 'aee.context.proactive', description: 'Generate proactive context for new conversations' },
    { intent: 'aee.knowledge.graph', description: 'Build and query knowledge graph from entities' }
  ]
})

// PRISM - Code and development specialist
agentRegistry.set('agent.prism', {
  id: 'agent.prism',
  name: 'PRISM',
  description: 'Code analysis, development, and technical documentation specialist',
  capabilities: [
    { intent: 'quox.chat.query', description: 'Answer development and code questions' },
    { intent: 'ops.code.review', description: 'Review code for issues and improvements' },
    { intent: 'ops.docs.generate', description: 'Generate technical documentation' }
  ]
})

// ============================================================================
// Capability Discovery Functions
// ============================================================================

/**
 * Register an agent's capabilities
 *
 * @param {AgentProfile} profile - Agent profile to register
 */
export function registerAgent(profile) {
  if (!profile.id) throw new Error('Agent profile must have an id')
  agentRegistry.set(profile.id, profile)
}

/**
 * Unregister an agent
 *
 * @param {string} agentId - Agent ID to remove
 */
export function unregisterAgent(agentId) {
  agentRegistry.delete(agentId)
}

/**
 * Get all registered agents
 *
 * @returns {AgentProfile[]}
 */
export function getAllAgents() {
  return Array.from(agentRegistry.values())
}

/**
 * Get a specific agent's profile
 *
 * @param {string} agentId - Agent ID
 * @returns {AgentProfile|null}
 */
export function getAgent(agentId) {
  return agentRegistry.get(agentId) || null
}

/**
 * Get an agent's capabilities
 *
 * @param {string} agentId - Agent ID
 * @returns {AgentCapability[]}
 */
export function getAgentCapabilities(agentId) {
  const agent = agentRegistry.get(agentId)
  return agent ? agent.capabilities : []
}

/**
 * Find agents that support a specific intent
 *
 * @param {string} intent - Intent to search for
 * @returns {AgentProfile[]}
 */
export function findAgentsByIntent(intent) {
  const results = []
  for (const agent of agentRegistry.values()) {
    if (agent.capabilities.some(c => c.intent === intent)) {
      results.push(agent)
    }
  }
  return results
}

/**
 * Find agents that can handle intents matching a pattern
 *
 * @param {string} pattern - Intent pattern (e.g., "ops.*" or "quoxagent.job.*")
 * @returns {AgentProfile[]}
 */
export function findAgentsByPattern(pattern) {
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
  const results = []

  for (const agent of agentRegistry.values()) {
    if (agent.capabilities.some(c => regex.test(c.intent))) {
      results.push(agent)
    }
  }

  return results
}

/**
 * Create a capability list request envelope
 *
 * @param {string} from - Requester
 * @param {string} to - Target agent
 * @returns {Object} - AEE task envelope
 */
export function createCapabilityRequest(from, to) {
  return createTask(from, to, AEE_INTENTS.CAPABILITY_LIST, {
    requested_at: new Date().toISOString()
  })
}

/**
 * Create a capability list response envelope
 *
 * @param {Object} requestEnvelope - The request envelope
 * @param {string} agentId - Agent responding
 * @returns {Object} - AEE result envelope
 */
export function createCapabilityResponse(requestEnvelope, agentId) {
  const agent = agentRegistry.get(agentId)

  if (!agent) {
    return createResult(requestEnvelope, {
      error: 'Agent not found',
      agent_id: agentId
    })
  }

  return createResult(requestEnvelope, {
    agent_id: agent.id,
    name: agent.name,
    description: agent.description,
    intents: agent.capabilities.map(c => c.intent),
    capabilities: agent.capabilities
  })
}

/**
 * Get capability manifest for all agents (useful for system prompts)
 *
 * @returns {Object} - Agent manifest
 */
export function getCapabilityManifest() {
  const manifest = {
    version: '1.0',
    updated_at: new Date().toISOString(),
    agents: {}
  }

  for (const [id, agent] of agentRegistry) {
    manifest.agents[id] = {
      name: agent.name,
      description: agent.description,
      intents: agent.capabilities.map(c => c.intent)
    }
  }

  return manifest
}
