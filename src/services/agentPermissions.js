/**
 * Quox Agent Permissions Service
 *
 * Enforces memory domain boundaries and sharing protocols between agents.
 * Part of Wave 3 Memory Overhaul - "giggly-seeking-beacon"
 */

import { getMemoryManager } from './memoryManager.js'

// ============================================================================
// AGENT HIERARCHY
// ============================================================================

/**
 * Agent roles and their hierarchy levels
 * Lower number = higher authority
 */
export const AGENT_ROLES = {
  orchestrator: { level: 0, description: 'System orchestrator (Quox)' },
  manager: { level: 1, description: 'Domain manager (WARDEN, DAEDALUS)' },
  specialist: { level: 2, description: 'Domain specialist (CIPHER, PRISM)' },
  worker: { level: 3, description: 'Task worker' },
  observer: { level: 4, description: 'Read-only observer' }
}

/**
 * Memory domains for access control
 */
export const MEMORY_DOMAINS = {
  shared: { description: 'Shared across all agents', sensitivity: 'low' },
  orchestration: { description: 'System orchestration state', sensitivity: 'high' },
  security: { description: 'Security-related memories', sensitivity: 'high' },
  network: { description: 'Network and infrastructure', sensitivity: 'medium' },
  infrastructure: { description: 'Infrastructure state', sensitivity: 'medium' },
  operations: { description: 'Operational runbooks and procedures', sensitivity: 'medium' },
  analytics: { description: 'Analytics and patterns', sensitivity: 'low' },
  user: { description: 'User preferences and profile', sensitivity: 'medium' },
  private: { description: 'Agent-private memories', sensitivity: 'high' }
}

/**
 * Agent permission definitions
 */
export const AGENT_PERMISSIONS = {
  quox: {
    role: 'orchestrator',
    displayName: 'Quox',
    read: ['*'],  // Can read all domains
    write: ['shared', 'orchestration', 'user'],
    manage: ['*'],  // Can grant permissions
    escalateTo: null,
    description: 'Master orchestrator with full access'
  },

  sentinel: {
    role: 'manager',
    displayName: 'WARDEN',
    read: ['shared', 'security', 'infrastructure', 'network', 'operations'],
    write: ['security', 'shared'],
    manage: ['security'],
    escalateTo: 'quox',
    description: 'Security operations manager'
  },

  cipher: {
    role: 'specialist',
    displayName: 'CIPHER',
    read: ['shared', 'network', 'infrastructure'],
    write: ['network', 'shared'],
    manage: [],
    escalateTo: 'sentinel',
    description: 'Network and connectivity specialist'
  },

  nova: {
    role: 'manager',
    displayName: 'DAEDALUS',
    read: ['shared', 'infrastructure', 'operations', 'analytics'],
    write: ['infrastructure', 'operations', 'shared'],
    manage: ['infrastructure', 'operations'],
    escalateTo: 'quox',
    description: 'Infrastructure operations manager'
  },

  prism: {
    role: 'specialist',
    displayName: 'PRISM',
    read: ['shared', 'infrastructure', 'analytics'],
    write: ['analytics', 'shared'],
    manage: [],
    escalateTo: 'nova',
    description: 'Workload and container specialist'
  },

  vault: {
    role: 'specialist',
    displayName: 'VAULT',
    read: ['shared', 'infrastructure', 'operations'],
    write: ['infrastructure', 'shared'],
    manage: [],
    escalateTo: 'nova',
    description: 'Storage and backup specialist'
  },

  scholar: {
    role: 'specialist',
    displayName: 'SCHOLAR',
    read: ['shared', 'analytics', 'infrastructure', 'operations'],
    write: ['analytics', 'shared'],
    manage: [],
    escalateTo: 'quox',
    description: 'Analytics and pattern detection'
  },

  archivist: {
    role: 'specialist',
    displayName: 'ARCHIVIST',
    read: ['*'],  // Can read all for archival
    write: ['shared'],
    manage: [],
    escalateTo: 'quox',
    description: 'Memory and knowledge management'
  }
}

// ============================================================================
// PERMISSION CHECKING
// ============================================================================

/**
 * Check if an agent can read from a domain
 */
export function canRead(agentId, domain) {
  const agent = getAgentPermissions(agentId)
  if (!agent) return false

  // Wildcard access
  if (agent.read.includes('*')) return true

  // Private domain - only owner can read
  if (domain === 'private') {
    return domain === `private.${agentId}`
  }

  return agent.read.includes(domain)
}

/**
 * Check if an agent can write to a domain
 */
export function canWrite(agentId, domain) {
  const agent = getAgentPermissions(agentId)
  if (!agent) return false

  // Wildcard access (only orchestrator)
  if (agent.write.includes('*')) return true

  // Private domain - only owner can write
  if (domain === 'private' || domain.startsWith('private.')) {
    return domain === `private.${agentId}`
  }

  return agent.write.includes(domain)
}

/**
 * Check if an agent can manage (grant access to) a domain
 */
export function canManage(agentId, domain) {
  const agent = getAgentPermissions(agentId)
  if (!agent) return false

  if (agent.manage.includes('*')) return true

  return agent.manage.includes(domain)
}

/**
 * Get agent permissions
 */
export function getAgentPermissions(agentId) {
  const normalized = normalizeAgentId(agentId)
  return AGENT_PERMISSIONS[normalized] || null
}

/**
 * Normalize agent ID (agent.cipher -> cipher)
 */
function normalizeAgentId(agentId) {
  if (!agentId) return null
  return agentId.replace(/^agent\./, '').toLowerCase()
}

/**
 * Get all domains an agent can read
 */
export function getReadableDomains(agentId) {
  const agent = getAgentPermissions(agentId)
  if (!agent) return []

  if (agent.read.includes('*')) {
    return Object.keys(MEMORY_DOMAINS)
  }

  return agent.read.filter(d => d !== '*')
}

/**
 * Get all domains an agent can write
 */
export function getWritableDomains(agentId) {
  const agent = getAgentPermissions(agentId)
  if (!agent) return []

  if (agent.write.includes('*')) {
    return Object.keys(MEMORY_DOMAINS)
  }

  return agent.write.filter(d => d !== '*')
}

// ============================================================================
// MEMORY ACCESS ENFORCEMENT
// ============================================================================

/**
 * Read memory with permission check
 */
export function readMemory(agentId, domain, query, options = {}) {
  if (!canRead(agentId, domain)) {
    return {
      success: false,
      error: `Agent ${agentId} cannot read from domain ${domain}`,
      code: 'PERMISSION_DENIED'
    }
  }

  const mm = getMemoryManager()

  // Filter memories by domain
  const memories = mm.getLearnedItemsByType(options.type || 'fact')
    .filter(m => m.domain === domain || !m.domain)  // Include undomained for backwards compat

  return {
    success: true,
    memories,
    domain,
    agentId
  }
}

/**
 * Write memory with permission check
 */
export function writeMemory(agentId, domain, memory, options = {}) {
  if (!canWrite(agentId, domain)) {
    return {
      success: false,
      error: `Agent ${agentId} cannot write to domain ${domain}`,
      code: 'PERMISSION_DENIED'
    }
  }

  const mm = getMemoryManager()
  const type = memory.type || 'fact'

  const enrichedMemory = {
    ...memory,
    domain,
    provenance: {
      ...memory.provenance,
      createdBy: `agent.${normalizeAgentId(agentId)}`,
      domain
    }
  }

  const result = mm.addLearnedItem(type, enrichedMemory, {
    source: memory.provenance?.source || 'model_inference',
    createdBy: `agent.${normalizeAgentId(agentId)}`,
    ...options
  })

  return {
    success: !!result,
    memory: result,
    domain,
    agentId
  }
}

/**
 * Query memories across accessible domains
 */
export function queryMemories(agentId, query, options = {}) {
  const readableDomains = getReadableDomains(agentId)

  if (readableDomains.length === 0) {
    return {
      success: false,
      error: `Agent ${agentId} has no read access`,
      memories: []
    }
  }

  const mm = getMemoryManager()
  const allMemories = []

  // Gather memories from all accessible domains
  for (const type of ['fact', 'preference', 'constraint', 'decision']) {
    const items = mm.getLearnedItemsByType(type)
    for (const item of items) {
      // Include if domain matches or is shared/undefined
      const itemDomain = item.domain || 'shared'
      if (readableDomains.includes(itemDomain) || readableDomains.includes('*')) {
        allMemories.push({ ...item, type })
      }
    }
  }

  return {
    success: true,
    memories: allMemories,
    domains: readableDomains,
    agentId
  }
}

// ============================================================================
// HANDOFF ENVELOPES
// ============================================================================

/**
 * Create a handoff envelope for agent delegation/escalation
 */
export function createHandoffEnvelope(options) {
  const {
    from,
    to,
    type = 'delegation',  // delegation | escalation | notification
    context = {},
    briefing = {},
    grantedAccess = {}
  } = options

  const fromAgent = getAgentPermissions(from)
  const toAgent = getAgentPermissions(to)

  if (!fromAgent || !toAgent) {
    throw new Error(`Invalid agent in handoff: ${from} -> ${to}`)
  }

  // Validate escalation path
  if (type === 'escalation') {
    if (fromAgent.escalateTo !== normalizeAgentId(to) &&
        toAgent.role !== 'orchestrator') {
      throw new Error(`Agent ${from} cannot escalate to ${to}`)
    }
  }

  return {
    id: `handoff_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    createdAt: new Date().toISOString(),
    from: `agent.${normalizeAgentId(from)}`,
    to: `agent.${normalizeAgentId(to)}`,
    type,

    // Context transfer
    context: {
      query: context.query || null,
      findings: context.findings || [],
      memoriesAccessed: context.memoriesAccessed || [],
      memorySnapshot: context.memorySnapshot || {}
    },

    // Briefing for receiving agent
    briefing: {
      situation: briefing.situation || '',
      analysis: briefing.analysis || '',
      recommendedAction: briefing.recommendedAction || '',
      urgency: briefing.urgency || 'normal'
    },

    // Temporary access grants
    grantedAccess: {
      read: grantedAccess.read || [],
      write: grantedAccess.write || [],
      temporary: grantedAccess.temporary !== false,
      expires: grantedAccess.expires || Date.now() + 3600000  // 1 hour default
    },

    // Status tracking
    status: 'pending',
    acceptedAt: null,
    completedAt: null,
    result: null
  }
}

/**
 * Accept a handoff envelope
 */
export function acceptHandoff(envelope, agentId) {
  const normalized = normalizeAgentId(agentId)

  if (envelope.to !== `agent.${normalized}`) {
    return {
      success: false,
      error: `Handoff is for ${envelope.to}, not ${agentId}`
    }
  }

  envelope.status = 'accepted'
  envelope.acceptedAt = new Date().toISOString()

  // Register temporary access grants
  if (envelope.grantedAccess.temporary) {
    registerTemporaryAccess(normalized, envelope.grantedAccess, envelope.id)
  }

  return {
    success: true,
    envelope
  }
}

/**
 * Complete a handoff
 */
export function completeHandoff(envelope, result) {
  envelope.status = 'completed'
  envelope.completedAt = new Date().toISOString()
  envelope.result = result

  // Revoke temporary access
  if (envelope.grantedAccess.temporary) {
    revokeTemporaryAccess(envelope.id)
  }

  return envelope
}

// ============================================================================
// TEMPORARY ACCESS MANAGEMENT
// ============================================================================

// In-memory store for temporary access grants
const temporaryGrants = new Map()

/**
 * Register temporary access for an agent
 */
function registerTemporaryAccess(agentId, access, handoffId) {
  const key = `${agentId}:${handoffId}`
  temporaryGrants.set(key, {
    agentId,
    handoffId,
    read: access.read || [],
    write: access.write || [],
    expires: access.expires,
    createdAt: Date.now()
  })
}

/**
 * Revoke temporary access
 */
function revokeTemporaryAccess(handoffId) {
  for (const [key, grant] of temporaryGrants.entries()) {
    if (grant.handoffId === handoffId) {
      temporaryGrants.delete(key)
    }
  }
}

/**
 * Check if agent has temporary read access to domain
 */
export function hasTemporaryReadAccess(agentId, domain) {
  const normalized = normalizeAgentId(agentId)
  const now = Date.now()

  for (const grant of temporaryGrants.values()) {
    if (grant.agentId === normalized &&
        grant.read.includes(domain) &&
        grant.expires > now) {
      return true
    }
  }

  return false
}

/**
 * Check if agent has temporary write access to domain
 */
export function hasTemporaryWriteAccess(agentId, domain) {
  const normalized = normalizeAgentId(agentId)
  const now = Date.now()

  for (const grant of temporaryGrants.values()) {
    if (grant.agentId === normalized &&
        grant.write.includes(domain) &&
        grant.expires > now) {
      return true
    }
  }

  return false
}

/**
 * Clean up expired temporary grants
 */
export function cleanupExpiredGrants() {
  const now = Date.now()
  for (const [key, grant] of temporaryGrants.entries()) {
    if (grant.expires < now) {
      temporaryGrants.delete(key)
    }
  }
}

// ============================================================================
// PERMISSION AUDIT
// ============================================================================

/**
 * Get permission audit for an agent
 */
export function getAgentAudit(agentId) {
  const agent = getAgentPermissions(agentId)
  if (!agent) {
    return { success: false, error: 'Agent not found' }
  }

  return {
    success: true,
    agent: normalizeAgentId(agentId),
    displayName: agent.displayName,
    role: agent.role,
    roleLevel: AGENT_ROLES[agent.role]?.level,
    permissions: {
      read: agent.read,
      write: agent.write,
      manage: agent.manage
    },
    escalationPath: agent.escalateTo,
    readableDomains: getReadableDomains(agentId),
    writableDomains: getWritableDomains(agentId),
    temporaryGrants: Array.from(temporaryGrants.values())
      .filter(g => g.agentId === normalizeAgentId(agentId))
  }
}

/**
 * Get system-wide permission audit
 */
export function getSystemAudit() {
  const agents = Object.entries(AGENT_PERMISSIONS).map(([id, agent]) => ({
    id,
    displayName: agent.displayName,
    role: agent.role,
    level: AGENT_ROLES[agent.role]?.level,
    read: agent.read,
    write: agent.write,
    escalateTo: agent.escalateTo
  }))

  const domains = Object.entries(MEMORY_DOMAINS).map(([id, domain]) => ({
    id,
    ...domain,
    readers: agents.filter(a => a.read.includes('*') || a.read.includes(id)).map(a => a.id),
    writers: agents.filter(a => a.write.includes('*') || a.write.includes(id)).map(a => a.id)
  }))

  return {
    agents,
    domains,
    temporaryGrants: Array.from(temporaryGrants.values()),
    hierarchy: buildHierarchy(agents)
  }
}

/**
 * Build agent hierarchy tree
 */
function buildHierarchy(agents) {
  const sorted = [...agents].sort((a, b) => a.level - b.level)
  const tree = {}

  for (const agent of sorted) {
    if (!agent.escalateTo) {
      tree[agent.id] = { ...agent, subordinates: [] }
    }
  }

  for (const agent of sorted) {
    if (agent.escalateTo && tree[agent.escalateTo]) {
      tree[agent.escalateTo].subordinates.push(agent.id)
    }
  }

  return tree
}

// Issue 1.6: Store interval ID for cleanup
let cleanupIntervalId = null

/**
 * Start permission cleanup interval - Issue 1.6 fix
 * Stores interval ID to allow stopping
 */
export function startPermissionCleanup() {
  if (cleanupIntervalId) return  // Already running
  cleanupIntervalId = setInterval(cleanupExpiredGrants, 60000)  // Every minute
}

/**
 * Stop permission cleanup interval - Issue 1.6 fix
 */
export function stopPermissionCleanup() {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId)
    cleanupIntervalId = null
  }
}

// Auto-start cleanup in browser (Issue 1.6: now controllable)
if (typeof setInterval !== 'undefined') {
  startPermissionCleanup()
}

export default {
  AGENT_ROLES,
  MEMORY_DOMAINS,
  AGENT_PERMISSIONS,
  canRead,
  canWrite,
  canManage,
  getAgentPermissions,
  getReadableDomains,
  getWritableDomains,
  readMemory,
  writeMemory,
  queryMemories,
  createHandoffEnvelope,
  acceptHandoff,
  completeHandoff,
  hasTemporaryReadAccess,
  hasTemporaryWriteAccess,
  getAgentAudit,
  getSystemAudit,
  startPermissionCleanup,
  stopPermissionCleanup
}
