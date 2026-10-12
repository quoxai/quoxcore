/**
 * Quox Memory Manager
 *
 * Manages structured memory (files) + vector memory (Qdrant)
 * for continuous, personalized AI interactions.
 *
 * Phase 5 Integration: Now uses MemoryClient for server-side persistence
 * with automatic localStorage fallback when server is unavailable.
 */

import { getVectorMemory, MEMORY_TYPES } from './vectorMemory'
import {
  getMemoryTierSync,
  getTierLimits,
  hasFeature,
  checkLimit,
  createUpgradePrompt
} from './memoryTier'
import { getMemoryClient } from './memoryClient'
import { logMemorySaved, logMemoryUpdated, logMemoryDeleted, logEntityStored } from './memoryAudit'

// Memory client singleton - handles server-side persistence with fallback
const memoryClient = getMemoryClient()

// Memory storage path - configurable via VITE_MEMORY_PATH env var
// Falls back to ./data/memory relative to project root
const MEMORY_PATH = import.meta.env.VITE_MEMORY_PATH || './data/memory'
const QDRANT_URL = import.meta.env.VITE_QDRANT_URL || '/qdrant'
const COLLECTION = 'memories'

// Salience signals for determining what to remember
const SALIENCE_SIGNALS = {
  explicit_preference: 1.0,    // "I prefer X over Y"
  explicit_fact: 0.9,          // "The server IP is X"
  decision_made: 0.9,          // "Let's go with X"
  constraint_stated: 0.95,     // "Never do X"
  error_fix: 0.85,             // Problem + solution pair
  repeated_pattern: 0.7,       // Same topic 3+ times
  configuration_change: 0.6,   // Changed a setting
  status_check: 0.2,           // "Check disk usage"
  routine_operation: 0.3,      // Normal operations
}

// SECRET DETECTION PATTERNS - Block storing sensitive data
const SECRET_PATTERNS = {
  // API keys and tokens
  api_key: /\b(api[_-]?key|apikey|api[_-]?token|access[_-]?token|bearer)\s*[=:]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
  aws_key: /\b(AKIA[0-9A-Z]{16})\b/g,
  github_token: /\b(gh[pousr]_[A-Za-z0-9_]{36,})\b/g,
  generic_secret: /\b(secret|private[_-]?key|auth[_-]?token)\s*[=:]\s*['"]?([^\s'"]{8,})['"]?/gi,

  // Passwords
  password: /\b(password|passwd|pwd)\s*[=:]\s*['"]?([^\s'"]{4,})['"]?/gi,
  connection_string: /\b(mongodb|postgres|mysql|redis):\/\/[^\s]+:[^\s@]+@/gi,

  // Private keys
  private_key: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/gi,
  ssh_key: /ssh-(rsa|ed25519|ecdsa)\s+[A-Za-z0-9+\/=]{40,}/gi,

  // Credit cards (basic check)
  credit_card: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/g,
}

// Check if content contains secrets and return details
function detectSecrets(content) {
  if (!content || typeof content !== 'string') return { hasSecrets: false, types: [] }

  const detectedTypes = []
  for (const [type, pattern] of Object.entries(SECRET_PATTERNS)) {
    if (pattern.test(content)) {
      detectedTypes.push(type)
      // Reset regex lastIndex for global patterns
      pattern.lastIndex = 0
    }
  }

  return {
    hasSecrets: detectedTypes.length > 0,
    types: detectedTypes
  }
}

// Redact secrets from content (replace with [REDACTED])
function redactSecrets(content) {
  if (!content || typeof content !== 'string') return content

  let redacted = content
  for (const pattern of Object.values(SECRET_PATTERNS)) {
    redacted = redacted.replace(pattern, '[REDACTED]')
    pattern.lastIndex = 0
  }
  return redacted
}

// Patterns to detect salience (ordered by specificity)
const SALIENCE_PATTERNS = {
  // Explicit memory requests - highest priority
  explicit_remember: /\b(remember|note that|save this|keep in mind|don't forget|for future reference|fyi|btw|by the way)\b/i,

  // Identity and personal info
  identity: /\b(my name is|i am|i'm|i work|my job|my role|i live|my home|my network|my lab|my server|my setup)\b/i,

  // Infrastructure specifics - IPs, hostnames, paths
  infrastructure: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|\/[a-z][a-z0-9\/\-_\.]+|[a-z][a-z0-9\-]+\d+\.?)\b/i,

  // Preferences with context
  preference: /\b(i prefer|i like|i want|i always|i never|i don't like|i usually|i typically|my favorite|my preferred)\b/i,

  // Specific facts (not just "is/are")
  fact: /\b(the .+ is|.+ runs on|.+ located at|.+ IP is|.+ uses port|.+ version|.+ password is|.+ api key|.+ configured)\b/i,

  // Decisions made
  decision: /\b(let's|we'll|going with|decided|will use|chose|selected|picking|settled on)\b/i,

  // Constraints and rules
  constraint: /\b(never|don't ever|avoid|must not|shouldn't|not allowed|forbidden|blocked|restricted)\b/i,

  // Error patterns
  error: /\b(error|failed|failure|exception|crash|broken|fix|fixed|resolved|solution|workaround|bug|issue)\b/i,

  // Configuration and setup
  config: /\b(configured|set up|installed|deployed|running on|hosted on|mounted|mapped|connected to)\b/i,
}

// Memory types (including reflection for self-improvement)
const MEMORY_TYPES_LOCAL = ['preference', 'fact', 'decision', 'constraint', 'error', 'reflection']

// Reflection triggers and thresholds
const REFLECTION_CONFIG = {
  minInteractionsForReflection: 10,    // Minimum interactions before reflecting
  reflectionInterval: 20,              // Reflect every N interactions
  maxReflectionsPerSession: 5,         // Don't over-reflect
  patternThreshold: 3,                 // Minimum occurrences to be a pattern
  insightCategories: [
    'recurring_topic',      // Topics that come up frequently
    'successful_approach',  // Approaches that worked well
    'common_error',         // Errors that keep happening
    'user_preference',      // Inferred preferences from behavior
    'workflow_pattern',     // Common operation sequences
    'knowledge_gap'         // Areas where more info was needed
  ]
}

// Reciprocal Rank Fusion constant (k=60 is standard)
const RRF_K = 60

// Importance scoring weights
const IMPORTANCE_WEIGHTS = {
  recency: 0.25,      // How recent is the memory
  salience: 0.25,     // Original extraction confidence
  accessFreq: 0.20,   // How often it's retrieved
  explicit: 0.30,     // User-marked importance
}

// Entity types for entity memory
const ENTITY_TYPES = ['host', 'service', 'user', 'project', 'network', 'container', 'file']

// Relationship schema for knowledge graph
const RELATIONSHIP_SCHEMA = {
  // Infrastructure relationships
  runs: { inverse: 'runs_on', description: 'Host runs a service/container' },
  runs_on: { inverse: 'runs', description: 'Service/container runs on host' },
  hosts: { inverse: 'hosted_by', description: 'Host hosts a service' },
  hosted_by: { inverse: 'hosts', description: 'Service is hosted by' },

  // Dependencies
  depends_on: { inverse: 'required_by', description: 'Entity depends on another' },
  required_by: { inverse: 'depends_on', description: 'Entity is required by another' },

  // Network relationships
  connects_to: { inverse: 'connected_from', description: 'Network connection to' },
  connected_from: { inverse: 'connects_to', description: 'Network connection from' },
  routes_to: { inverse: 'routed_from', description: 'Routes traffic to' },
  routed_from: { inverse: 'routes_to', description: 'Receives routed traffic from' },

  // Management relationships
  manages: { inverse: 'managed_by', description: 'Entity manages another' },
  managed_by: { inverse: 'manages', description: 'Entity is managed by' },
  monitors: { inverse: 'monitored_by', description: 'Entity monitors another' },
  monitored_by: { inverse: 'monitors', description: 'Entity is monitored by' },

  // Storage relationships
  stores_data_for: { inverse: 'data_stored_on', description: 'Provides storage for' },
  data_stored_on: { inverse: 'stores_data_for', description: 'Has data stored on' },
  backs_up: { inverse: 'backed_up_by', description: 'Backs up another entity' },
  backed_up_by: { inverse: 'backs_up', description: 'Is backed up by' },

  // Cluster relationships
  cluster_member: { inverse: 'has_member', description: 'Is member of cluster' },
  has_member: { inverse: 'cluster_member', description: 'Cluster has member' },
  primary_for: { inverse: 'has_primary', description: 'Is primary for cluster' },
  has_primary: { inverse: 'primary_for', description: 'Has this as primary' },

  // Generic
  related_to: { inverse: 'related_to', description: 'Generally related entities' }
}

// ============================================================================
// PROVENANCE & CONFIDENCE SCHEMA (Wave 1 Memory Overhaul)
// ============================================================================

// Truth priority - how much to trust different sources
const TRUTH_PRIORITY = {
  tool_output: 1.0,       // Highest - verified by system/tool
  explicit_command: 0.95, // User said "remember this"
  user_stated: 0.85,      // User mentioned in conversation
  model_inference: 0.6    // Claude inferred from context
}

// Stability levels - how likely a memory is to change
const STABILITY_LEVELS = {
  volatile: 'volatile',     // Likely to change (current task, session state)
  stable: 'stable',         // Changes occasionally (config, preference)
  permanent: 'permanent'    // Rarely changes (identity, core constraint)
}

// Map memory types to default stability
const TYPE_STABILITY = {
  preference: 'stable',
  fact: 'stable',
  decision: 'volatile',
  constraint: 'permanent',
  error: 'stable',
  reflection: 'stable',
  identity: 'permanent'
}

// Confidence decay - half-life in days for different stability levels
const CONFIDENCE_DECAY = {
  volatile: 7,      // 7 days half-life
  stable: 30,       // 30 days half-life
  permanent: 365    // 1 year half-life
}

// Create default provenance object
function createProvenance(source = 'model_inference', createdBy = 'system') {
  return {
    source,                           // 'user_stated' | 'tool_output' | 'model_inference' | 'explicit_command'
    createdBy,                        // 'human.adam' | 'agent.cipher' | 'system.reflection'
    createdAt: new Date().toISOString(),
    modifiedBy: null,
    modifiedAt: null,
    supersedes: null,                 // ID of memory this replaces
    supersededBy: null                // ID of memory that replaced this
  }
}

// Create default confidence object
function createConfidence(score = 0.7, stability = 'stable') {
  return {
    score,                            // 0.0-1.0 confidence level
    stability,                        // 'volatile' | 'stable' | 'permanent'
    lastVerified: null,               // Last time this was verified as true
    decayRate: CONFIDENCE_DECAY[stability] || 30,  // Half-life in days
    verificationCount: 0              // How many times verified
  }
}

// Create default conflicts object
function createConflicts() {
  return {
    detectedAt: null,
    conflictsWith: [],                // IDs of conflicting memories
    resolution: null,                 // 'pending' | 'user_resolved' | 'auto_resolved'
    resolvedAt: null
  }
}

// Calculate decayed confidence based on time elapsed
function calculateDecayedConfidence(confidence) {
  if (!confidence || !confidence.score) return 0.5

  const lastVerified = confidence.lastVerified || confidence.createdAt
  if (!lastVerified) return confidence.score

  const daysSince = (Date.now() - new Date(lastVerified).getTime()) / (1000 * 60 * 60 * 24)
  const halfLife = confidence.decayRate || 30
  const decayFactor = Math.pow(0.5, daysSince / halfLife)

  // Don't decay below 0.3 for stable/permanent, 0.1 for volatile
  const floor = confidence.stability === 'volatile' ? 0.1 : 0.3
  return Math.max(floor, confidence.score * decayFactor)
}

// Determine provenance source from content patterns
function inferProvenanceSource(content, isExplicit = false) {
  if (isExplicit) return 'explicit_command'

  const lowerContent = content.toLowerCase()

  // Tool output patterns
  if (/\b(output|result|returned|showed|displayed|response from)\b/.test(lowerContent)) {
    return 'tool_output'
  }

  // User stated patterns
  if (/\b(i |my |me |we |our )\b/.test(lowerContent)) {
    return 'user_stated'
  }

  return 'model_inference'
}

// Runbook intent patterns for matching user queries
const RUNBOOK_INTENTS = {
  restart: {
    patterns: ['restart', 'reboot', 'reset', 'bring back up'],
    synonyms: ['restarting', 'rebooting', 'resetting']
  },
  check: {
    patterns: ['check', 'status', 'health', 'verify', 'inspect', 'look at'],
    synonyms: ['checking', 'verifying', 'inspecting']
  },
  deploy: {
    patterns: ['deploy', 'release', 'push', 'rollout', 'ship'],
    synonyms: ['deploying', 'releasing', 'shipping']
  },
  backup: {
    patterns: ['backup', 'snapshot', 'archive', 'save state'],
    synonyms: ['backing up', 'archiving']
  },
  troubleshoot: {
    patterns: ['troubleshoot', 'debug', 'diagnose', 'fix', 'investigate', 'why is'],
    synonyms: ['troubleshooting', 'debugging', 'fixing']
  },
  configure: {
    patterns: ['configure', 'setup', 'set up', 'config', 'settings'],
    synonyms: ['configuring', 'setting up']
  },
  monitor: {
    patterns: ['monitor', 'watch', 'alert', 'track', 'observe'],
    synonyms: ['monitoring', 'watching', 'tracking']
  },
  cleanup: {
    patterns: ['cleanup', 'clean up', 'delete', 'remove', 'prune', 'clear'],
    synonyms: ['cleaning', 'deleting', 'removing']
  },
  scale: {
    patterns: ['scale', 'resize', 'expand', 'grow', 'shrink'],
    synonyms: ['scaling', 'resizing', 'expanding']
  },
  migrate: {
    patterns: ['migrate', 'move', 'transfer', 'relocate'],
    synonyms: ['migrating', 'moving', 'transferring']
  }
}

// Agent domains for specialized memory
const AGENT_DOMAINS = {
  quox: {
    name: 'Quox',
    domains: ['orchestration', 'general', 'coordination', 'health'],
    keywords: ['status', 'help', 'coordinate', 'delegate', 'overview']
  },
  sentinel: {
    name: 'WARDEN',
    domains: ['security', 'threats', 'vulnerabilities', 'audit', 'compliance'],
    keywords: ['security', 'threat', 'vulnerability', 'audit', 'firewall', 'attack', 'breach']
  },
  cipher: {
    name: 'CIPHER',
    domains: ['network', 'connectivity', 'traffic', 'firewall', 'vpn'],
    keywords: ['network', 'dns', 'ip', 'port', 'firewall', 'vpn', 'traffic', 'bandwidth']
  },
  nova: {
    name: 'DAEDALUS',
    domains: ['devops', 'automation', 'deployment', 'cicd', 'containers'],
    keywords: ['deploy', 'pipeline', 'ci/cd', 'automation', 'docker', 'kubernetes']
  },
  atlas: {
    name: 'HYPERION',
    domains: ['proxmox', 'virtualization', 'vm', 'cluster', 'migration'],
    keywords: ['vm', 'proxmox', 'cluster', 'migrate', 'snapshot', 'template', 'node']
  },
  metrics: {
    name: 'METRICS',
    domains: ['monitoring', 'prometheus', 'grafana', 'alerts', 'slo'],
    keywords: ['prometheus', 'grafana', 'metric', 'alert', 'dashboard', 'slo', 'sli']
  },
  beacon: {
    name: 'VIGIL',
    domains: ['uptime', 'availability', 'status', 'incidents'],
    keywords: ['uptime', 'down', 'status', 'incident', 'availability', 'ping']
  },
  forge: {
    name: 'VULCAN',
    domains: ['docker', 'containers', 'images', 'compose', 'registry'],
    keywords: ['docker', 'container', 'image', 'compose', 'registry', 'podman']
  },
  vault: {
    name: 'VAULT',
    domains: ['secrets', 'backup', 'storage', 'nas', 'pbs'],
    keywords: ['secret', 'backup', 'restore', 'nas', 'storage', 'pbs', 'password']
  },
  nexus: {
    name: 'NEXUS',
    domains: ['dns', 'discovery', 'proxy', 'routing'],
    keywords: ['dns', 'record', 'proxy', 'route', 'discovery', 'traefik', 'nginx']
  },
  insight: {
    name: 'INSIGHT',
    domains: ['analysis', 'reporting', 'trends', 'capacity'],
    keywords: ['analyze', 'report', 'trend', 'capacity', 'forecast', 'log']
  }
}

// User preference categories
const PREFERENCE_CATEGORIES = {
  communication: {
    description: 'How Quox communicates with you',
    fields: {
      verbosity: { type: 'select', options: ['concise', 'detailed', 'technical'], default: 'concise' },
      format: { type: 'select', options: ['text', 'markdown', 'structured'], default: 'markdown' },
      useEmojis: { type: 'boolean', default: false }
    }
  },
  technical: {
    description: 'Your technical preferences',
    fields: {
      preferredLanguages: { type: 'array', default: [] },
      preferredTools: { type: 'array', default: [] },
      codeStyle: { type: 'select', options: ['minimal', 'documented', 'verbose'], default: 'minimal' }
    }
  },
  workflow: {
    description: 'How you work with Quox',
    fields: {
      confirmDestructive: { type: 'boolean', default: true },
      autoSave: { type: 'boolean', default: true },
      showThinking: { type: 'boolean', default: false }
    }
  },
  time: {
    description: 'Time-related preferences',
    fields: {
      timezone: { type: 'string', default: '' },
      workingHours: { type: 'string', default: '' }
    }
  }
}

// TRUST-GATE-1.15: maps identity namespaces (server-side identity_blobs) to
// their primary localStorage cache key. Used by hydrateIdentityFromServer()
// to detect a fresh browser (empty cache) and by _identityWriteThrough() as
// documentation of which namespace a given save site belongs to.
const IDENTITY_NAMESPACE_KEYS = {
  profile: 'quox_profile',
  projects: 'quox_projects',
  narratives: 'quox_narratives',
  syntheses: 'quox_syntheses',
  trends: 'quox_trends',
  personalization: 'quox_personalization_profile',
  reflection_state: 'quox_reflection_state',
  importance_evolution: 'quox_importance_evolution',
  privacy: 'quox_privacy',
}

// Entity extraction patterns
const ENTITY_PATTERNS = {
  host: /\b(?:host|server|node|machine|vm)\s*[:\s]?\s*([a-z0-9][\w.-]+)/gi,
  ip: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
  service: /\b(?:service|daemon|process)\s*[:\s]?\s*([a-z][\w-]+)/gi,
  container: /\b(?:container|docker|pod)\s*[:\s]?\s*([a-z][\w.-]+)/gi,
  port: /\b(?:port)\s*[:\s]?\s*(\d+)\b/gi,
}

/**
 * Memory Manager class
 */
export class MemoryManager {
  constructor() {
    this.candidateBuffer = []
    this.recentContext = []
    this.vectorMemory = getVectorMemory()
    this.vectorInitialized = false

    // Initialize vector memory in background
    this.initVector()

    // CLARITY-4: hydrateIdentityFromServer() is intentionally NOT called
    // here. It used to fire fire-and-forget at construct time, which runs
    // regardless of auth state (including on the unauthenticated /login
    // page) and produces expected-but-noisy 401s from the identity API.
    // It is now triggered explicitly, once, from
    // <AuthGatedBackgroundServices> (src/App.jsx) when a session becomes
    // authenticated — same gating pattern CLARITY-1 applied to AEE sync
    // and the ReflectionLoop. The method remains public/callable for that
    // caller (and for tests).
  }

  async initVector() {
    try {
      this.vectorInitialized = await this.vectorMemory.init()
      if (this.vectorInitialized) {
        console.log('Vector memory initialized')
      }
    } catch (e) {
      console.warn('Vector memory initialization failed:', e)
    }
  }

  /**
   * Write-through cache: localStorage stays the fast synchronous read path
   * for memoryManager's legacy sync API; the memory service becomes the
   * authoritative durable copy so a fresh browser/device can hydrate
   * identity via hydrateIdentityFromServer(). Fire-and-forget — failures
   * are logged, never thrown, so callers' existing sync contracts are
   * unaffected. TRUST-GATE-1.15 / 1.16.
   */
  _identityWriteThrough(namespace, data) {
    try {
      memoryClient.setIdentity(namespace, data).catch(err => {
        console.warn(`[MemoryManager] Identity write-through failed for ${namespace}:`, err.message)
      })
    } catch (err) {
      console.warn(`[MemoryManager] Identity write-through error for ${namespace}:`, err.message)
    }
  }

  /**
   * Hydrate localStorage identity caches from the memory service on startup.
   * TRUST-GATE-1.15: on a fresh browser (empty/cleared localStorage) the
   * server-side identity blob is authoritative — without this, QUOX greets
   * the owner as a stranger on every new device/browser. Only hydrates a
   * namespace whose local cache key is currently empty; never overwrites an
   * existing local cache. Best-effort: failures are logged and swallowed so
   * a down/unreachable memory service never blocks app boot.
   */
  async hydrateIdentityFromServer() {
    for (const [namespace, key] of Object.entries(IDENTITY_NAMESPACE_KEYS)) {
      try {
        if (localStorage.getItem(key)) continue
        const result = await memoryClient.getIdentity(namespace)
        if (result && result.data !== null && result.data !== undefined) {
          localStorage.setItem(key, JSON.stringify(result.data))
        }
      } catch (err) {
        console.warn(`[MemoryManager] Identity hydration failed for ${namespace}:`, err.message)
      }
    }
  }

  /**
   * Process an interaction and update memory
   * IMPORTANT: This stores EVERY conversation, not just candidates
   */
  async processInteraction(interaction) {
    const { query, response, agent, duration, cost, timestamp = Date.now() } = interaction

    // 1. Append FULL conversation to episodic log (always - this is the source of truth)
    await this.appendEpisodic({
      type: 'interaction',
      query,
      response, // Store FULL response, not truncated
      agent,
      duration,
      cost,
      timestamp
    })

    // 2. Store in vector memory for semantic search (with chunking for long responses)
    if (this.vectorInitialized) {
      try {
        // Store query
        await this.vectorMemory.store({
          id: `query_${timestamp}`,
          content: query,
          type: MEMORY_TYPES.EPISODIC,
          agent,
          timestamp,
          metadata: { duration, cost, role: 'user' }
        })

        // Store response (chunk if needed for long responses)
        if (response) {
          const chunks = this.chunkText(response, 2000)
          for (let i = 0; i < chunks.length; i++) {
            await this.vectorMemory.store({
              id: `response_${timestamp}_${i}`,
              content: chunks[i],
              type: MEMORY_TYPES.EPISODIC,
              agent,
              timestamp,
              metadata: { duration, cost, role: 'assistant', chunkIndex: i, totalChunks: chunks.length }
            })
          }
        }
      } catch (e) {
        console.warn('Failed to store in vector memory:', e)
      }
    }

    // 3. Extract high-salience memory candidates for structured storage
    // These become preferences, facts, decisions, constraints, errors
    const candidates = this.extractCandidates(query, response, agent)
    this.candidateBuffer.push(...candidates)

    // 4. Auto-process candidates if buffer gets large (immediate learning)
    if (this.candidateBuffer.length >= 5) {
      await this.processCandidates()
    }

    // 5. Add to recent context window
    this.recentContext.push({
      query,
      agent,
      timestamp,
      summary: response?.substring(0, 500)
    })

    // Keep recent context bounded
    if (this.recentContext.length > 20) {
      this.recentContext = this.recentContext.slice(-20)
    }

    // 6. Extract and store entities (hosts, services, IPs, etc.)
    const combined = `${query} ${response || ''}`
    this.processEntitiesFromInteraction(combined)

    // 7. Track interaction for reflection system (may trigger auto-reflection)
    this.trackInteraction()

    return candidates
  }

  /**
   * Chunk text into smaller pieces for vector storage
   */
  chunkText(text, maxLength = 2000) {
    if (!text || text.length <= maxLength) return [text]

    const chunks = []
    const sentences = text.split(/(?<=[.!?])\s+/)
    let currentChunk = ''

    for (const sentence of sentences) {
      if ((currentChunk + sentence).length > maxLength) {
        if (currentChunk) chunks.push(currentChunk.trim())
        currentChunk = sentence
      } else {
        currentChunk += (currentChunk ? ' ' : '') + sentence
      }
    }
    if (currentChunk) chunks.push(currentChunk.trim())

    return chunks
  }

  /**
   * Load unified memory data (for Phase 10 methods)
   * Combines data from multiple storage keys into a unified structure
   */
  _loadData() {
    try {
      const data = {
        profile: {},
        learned: {},
        entities: {},
        sessions: {},
        syntheses: {},
        narratives: {},
        trends: {},
        privacy: { levels: {}, expirations: {}, anonymized: {} },
        backups: []
      }

      // Load profile
      const profileData = localStorage.getItem('quox_profile')
      if (profileData) data.profile = JSON.parse(profileData)

      // Load learned memories by type
      for (const type of ['preferences', 'facts', 'decisions', 'constraints', 'errors', 'workflows']) {
        const key = `quox_learned_${type.replace(/s$/, '')}`
        const typeData = localStorage.getItem(key)
        if (typeData) data.learned[type] = JSON.parse(typeData)
      }

      // Load entities
      const entitiesData = localStorage.getItem('quox_entities')
      if (entitiesData) data.entities = JSON.parse(entitiesData)

      // Load sessions
      const sessionsData = localStorage.getItem('quox_sessions')
      if (sessionsData) data.sessions = JSON.parse(sessionsData)

      // Load syntheses
      const synthesesData = localStorage.getItem('quox_syntheses')
      if (synthesesData) data.syntheses = JSON.parse(synthesesData)

      // Load narratives
      const narrativesData = localStorage.getItem('quox_narratives')
      if (narrativesData) data.narratives = JSON.parse(narrativesData)

      // Load trends
      const trendsData = localStorage.getItem('quox_trends')
      if (trendsData) data.trends = JSON.parse(trendsData)

      // Load privacy settings
      const privacyData = localStorage.getItem('quox_privacy')
      if (privacyData) data.privacy = JSON.parse(privacyData)

      // Load backups
      const backupsData = localStorage.getItem('quox_backups')
      if (backupsData) data.backups = JSON.parse(backupsData)

      return data
    } catch (e) {
      console.error('Error loading data:', e)
      return {
        profile: {},
        learned: {},
        entities: {},
        sessions: {},
        syntheses: {},
        narratives: {},
        trends: {},
        privacy: { levels: {}, expirations: {}, anonymized: {} },
        backups: []
      }
    }
  }

  /**
   * Save unified memory data (for Phase 10 methods)
   */
  _saveData(data) {
    try {
      // Save profile
      if (data.profile) {
        localStorage.setItem('quox_profile', JSON.stringify(data.profile))
        this._identityWriteThrough('profile', data.profile)
      }

      // Save learned memories by type
      if (data.learned) {
        for (const [type, items] of Object.entries(data.learned)) {
          if (Array.isArray(items)) {
            const key = `quox_learned_${type.replace(/s$/, '')}`
            localStorage.setItem(key, JSON.stringify(items))
          }
        }
      }

      // Save entities
      if (data.entities) {
        localStorage.setItem('quox_entities', JSON.stringify(data.entities))
      }

      // Save sessions
      if (data.sessions) {
        localStorage.setItem('quox_sessions', JSON.stringify(data.sessions))
      }

      // Save syntheses
      if (data.syntheses) {
        localStorage.setItem('quox_syntheses', JSON.stringify(data.syntheses))
        this._identityWriteThrough('syntheses', data.syntheses)
      }

      // Save narratives
      if (data.narratives) {
        localStorage.setItem('quox_narratives', JSON.stringify(data.narratives))
        this._identityWriteThrough('narratives', data.narratives)
      }

      // Save trends
      if (data.trends) {
        localStorage.setItem('quox_trends', JSON.stringify(data.trends))
        this._identityWriteThrough('trends', data.trends)
      }

      // Save privacy settings
      if (data.privacy) {
        localStorage.setItem('quox_privacy', JSON.stringify(data.privacy))
        // G2a: privacy settings are server-authoritative (identity_blobs,
        // org+user scoped) so a fresh browser/device hydrates them rather than
        // resetting privacy to defaults. localStorage stays the fast sync cache.
        this._identityWriteThrough('privacy', data.privacy)
      }

      // Save backups
      if (data.backups) {
        localStorage.setItem('quox_backups', JSON.stringify(data.backups))
      }

      return true
    } catch (e) {
      console.error('Error saving data:', e)
      return false
    }
  }

  /**
   * Append to episodic log file
   */
  async appendEpisodic(event) {
    const date = new Date(event.timestamp)
    const dateStr = date.toISOString().split('T')[0]
    const logEntry = JSON.stringify({
      ...event,
      timestamp: date.toISOString()
    }) + '\n'

    // In browser context, we'll store in localStorage
    // In Node context, this would write to file
    const key = `episodic_${dateStr}`
    const existing = localStorage.getItem(key) || ''
    localStorage.setItem(key, existing + logEntry)

    // Also update recent buffer
    const recentKey = 'episodic_recent'
    const recent = localStorage.getItem(recentKey) || ''
    const lines = (recent + logEntry).split('\n').filter(Boolean)
    // Keep last 100 entries
    localStorage.setItem(recentKey, lines.slice(-100).join('\n') + '\n')
  }

  /**
   * Extract memory candidates from interaction
   * Now with smarter pattern matching and explicit memory detection
   */
  extractCandidates(query, response, agent) {
    const candidates = []
    const combined = `${query} ${response || ''}`
    const queryLower = query.toLowerCase()

    // 1. HIGHEST PRIORITY: Explicit memory requests
    // "Remember that...", "Note that...", "FYI..."
    if (SALIENCE_PATTERNS.explicit_remember.test(query)) {
      candidates.push({
        type: 'fact',
        content: query,
        salience: 1.0, // Maximum salience for explicit requests
        agent,
        timestamp: Date.now(),
        explicit: true
      })
      console.log('[Memory] Explicit memory request detected:', query.substring(0, 50))
    }

    // 2. Identity information - always important
    // "My name is...", "I am a...", "I work on..."
    if (SALIENCE_PATTERNS.identity.test(query)) {
      candidates.push({
        type: 'preference', // Identity goes to preferences
        content: query,
        salience: 0.95,
        agent,
        timestamp: Date.now(),
        category: 'identity'
      })
      console.log('[Memory] Identity info detected:', query.substring(0, 50))
    }

    // 3. Infrastructure information from USER query
    // IPs, hostnames, paths mentioned by user
    if (SALIENCE_PATTERNS.infrastructure.test(query)) {
      candidates.push({
        type: 'fact',
        content: query,
        salience: 0.85,
        agent,
        timestamp: Date.now(),
        category: 'infrastructure'
      })
    }

    // 4. Preferences with context
    if (SALIENCE_PATTERNS.preference.test(query)) {
      candidates.push({
        type: 'preference',
        content: query,
        salience: SALIENCE_SIGNALS.explicit_preference,
        agent,
        timestamp: Date.now()
      })
    }

    // 5. Specific facts (from combined - could be from response too)
    if (SALIENCE_PATTERNS.fact.test(combined)) {
      // Extract just the relevant sentence containing the fact
      const sentences = combined.split(/[.!?]+/).filter(s => SALIENCE_PATTERNS.fact.test(s))
      for (const sentence of sentences.slice(0, 3)) { // Max 3 facts per interaction
        candidates.push({
          type: 'fact',
          content: sentence.trim().substring(0, 300),
          salience: SALIENCE_SIGNALS.explicit_fact,
          agent,
          timestamp: Date.now()
        })
      }
    }

    // 6. Configuration info (from response typically)
    if (SALIENCE_PATTERNS.config.test(combined)) {
      const sentences = combined.split(/[.!?]+/).filter(s => SALIENCE_PATTERNS.config.test(s))
      for (const sentence of sentences.slice(0, 2)) {
        candidates.push({
          type: 'fact',
          content: sentence.trim().substring(0, 300),
          salience: 0.75,
          agent,
          timestamp: Date.now(),
          category: 'config'
        })
      }
    }

    // 7. Decisions
    if (SALIENCE_PATTERNS.decision.test(combined)) {
      candidates.push({
        type: 'decision',
        content: combined.substring(0, 500),
        salience: SALIENCE_SIGNALS.decision_made,
        agent,
        timestamp: Date.now()
      })
    }

    // 8. Constraints - check user query specifically
    if (SALIENCE_PATTERNS.constraint.test(query)) {
      candidates.push({
        type: 'constraint',
        content: query,
        salience: SALIENCE_SIGNALS.constraint_stated,
        agent,
        timestamp: Date.now()
      })
    }

    // 9. Error patterns
    if (SALIENCE_PATTERNS.error.test(combined)) {
      candidates.push({
        type: 'error',
        content: combined.substring(0, 500),
        salience: SALIENCE_SIGNALS.error_fix,
        agent,
        timestamp: Date.now()
      })
    }

    // Log what we extracted
    if (candidates.length > 0) {
      console.log(`[Memory] Extracted ${candidates.length} candidates from interaction`)
    }

    return candidates
  }

  /**
   * Get context for a query
   */
  async getContext(query, options = {}) {
    const { agent, maxItems = 10, includeVectorSearch = true } = options

    // 1. Get profile
    const profile = this.getProfile()

    // 2. Get recent events
    const recentEvents = this.getRecentEvents(5)

    // 3. Get relevant projects (keyword match for now)
    const projects = this.getRelevantProjects(query)

    // 4. Get agent-specific memory
    const agentMemory = agent ? this.getAgentMemory(agent) : null

    // 5. Get pending candidates that might be relevant
    const pendingCandidates = this.candidateBuffer
      .filter(c => c.salience > 0.5)
      .slice(-5)

    // 6. Get learned memories (preferences, facts, decisions, constraints)
    const learned = this.getLearnedMemories(query, maxItems)

    // 7. Get relevant reflections (self-improvement insights)
    const reflections = this.getRelevantReflections(query, 3)

    // 8. Hybrid search (vector + keyword with RRF) for best results
    let hybridResults = []
    let semanticMatches = []
    if (includeVectorSearch && query) {
      try {
        hybridResults = await this.hybridSearch(query, maxItems)
      } catch (e) {
        console.warn('Hybrid search failed:', e)
      }

      // Also get pure semantic matches if vector is available
      if (this.vectorInitialized) {
        try {
          semanticMatches = await this.vectorMemory.search(query, maxItems)
        } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }
      }
    }

    return {
      profile,
      recentEvents,
      projects,
      agentMemory,
      pendingCandidates,
      learned,
      reflections,
      hybridResults,
      semanticMatches,
      timestamp: Date.now()
    }
  }

  /**
   * Hybrid retrieval combining vector search + keyword search with Reciprocal Rank Fusion
   * This is more accurate than either method alone
   * TIERED: Free version only gets keyword search
   */
  async hybridSearch(query, maxResults = 10) {
    // Defensive validation
    if (!query || typeof query !== 'string') return []

    // Strip pronouns that cause entity resolution issues
    const cleanQuery = query
      .replace(/\b(your|my|our|their|its)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (cleanQuery.length < 2) return []

    const results = new Map() // id -> { item, scores: { vector, keyword } }
    const canUseSemanticSearch = hasFeature('hasSemanticSearch')

    // 1. Vector search (semantic similarity) - PREMIUM ONLY
    if (this.vectorInitialized && canUseSemanticSearch) {
      try {
        const vectorResults = await this.vectorMemory.search(cleanQuery, maxResults * 2)
        vectorResults.forEach((item, rank) => {
          const id = item.id || `v_${rank}`
          if (!results.has(id)) {
            results.set(id, { item, scores: { vector: 0, keyword: 0 } })
          }
          results.get(id).scores.vector = 1 / (RRF_K + rank + 1)
        })
      } catch (e) {
        console.warn('Vector search failed in hybrid:', e)
      }
    } else if (this.vectorInitialized && !canUseSemanticSearch) {
      // Log that we're skipping semantic search due to tier
      console.log('[Memory] Semantic search skipped - requires Premium tier')
    }

    // 2. Keyword search (BM25-style matching)
    const keywordResults = this.keywordSearch(cleanQuery, maxResults * 2)
    keywordResults.forEach((item, rank) => {
      const id = item.id || `k_${rank}_${item.content?.substring(0, 20)}`
      if (!results.has(id)) {
        results.set(id, { item, scores: { vector: 0, keyword: 0 } })
      }
      results.get(id).scores.keyword = 1 / (RRF_K + rank + 1)
    })

    // 3. Combine scores using RRF
    const combined = Array.from(results.values())
      .map(r => ({
        ...r.item,
        rrfScore: r.scores.vector + r.scores.keyword,
        vectorScore: r.scores.vector,
        keywordScore: r.scores.keyword
      }))
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, maxResults)

    return combined
  }

  /**
   * Keyword-based search across all memory types
   * Simple BM25-inspired scoring
   */
  keywordSearch(query, maxResults = 20) {
    const results = []
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2)

    if (queryTerms.length === 0) return results

    // Search learned items
    for (const type of MEMORY_TYPES_LOCAL) {
      try {
        const items = this.getLearnedItemsByType(type)
        for (const item of items) {
          const content = (item.content || '').toLowerCase()
          const score = this.calculateBM25Score(queryTerms, content)
          if (score > 0) {
            results.push({ ...item, type, keywordScore: score, id: item.id || `${type}_${item.timestamp}` })
          }
        }
      } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }
    }

    // Search projects
    try {
      const projects = this.getAllProjects()
      for (const proj of projects) {
        const content = `${proj.name} ${proj.description || ''} ${(proj.keywords || []).join(' ')}`.toLowerCase()
        const score = this.calculateBM25Score(queryTerms, content)
        if (score > 0) {
          results.push({ ...proj, type: 'project', keywordScore: score, id: proj.id })
        }
      }
    } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }

    // Search recent episodic
    try {
      const recent = localStorage.getItem('episodic_recent') || ''
      const entries = recent.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)

      for (const entry of entries) {
        const content = `${entry.query || ''} ${entry.response || ''}`.toLowerCase()
        const score = this.calculateBM25Score(queryTerms, content)
        if (score > 0) {
          results.push({
            ...entry,
            type: 'episodic',
            keywordScore: score,
            id: `episodic_${entry.timestamp}`,
            content: entry.query
          })
        }
      }
    } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }

    // Sort by score and return
    return results
      .sort((a, b) => b.keywordScore - a.keywordScore)
      .slice(0, maxResults)
  }

  /**
   * Calculate composite importance score for a memory item
   * Multi-factor: recency + salience + access frequency + explicit importance
   */
  calculateImportance(item) {
    const now = Date.now()
    const maxAge = 90 * 24 * 60 * 60 * 1000 // 90 days

    // 1. Recency score (1.0 for now, decays to 0 over maxAge)
    const itemTime = new Date(item.learnedAt || item.timestamp || item.created_at || 0).getTime()
    const age = now - itemTime
    const recencyScore = Math.max(0, 1 - (age / maxAge))

    // 2. Salience score (original extraction confidence)
    const salienceScore = item.salience || 0.5

    // 3. Access frequency score (normalized to 0-1, caps at 20 accesses)
    const accessScore = Math.min(1, (item.accessCount || 0) / 20)

    // 4. Explicit importance (user-marked)
    const explicitScore = item.important ? 1.0 : 0.5

    // Weighted combination
    const importance =
      IMPORTANCE_WEIGHTS.recency * recencyScore +
      IMPORTANCE_WEIGHTS.salience * salienceScore +
      IMPORTANCE_WEIGHTS.accessFreq * accessScore +
      IMPORTANCE_WEIGHTS.explicit * explicitScore

    return {
      total: importance,
      breakdown: {
        recency: recencyScore,
        salience: salienceScore,
        access: accessScore,
        explicit: explicitScore
      }
    }
  }

  /**
   * Mark a learned item as important (boosts importance score)
   */
  markAsImportant(type, itemId, important = true) {
    try {
      const key = `quox_learned_${type}`
      const data = localStorage.getItem(key)
      if (!data) return false

      const items = JSON.parse(data)
      const index = items.findIndex(i => i.id === itemId)
      if (index === -1) return false

      items[index].important = important
      items[index].markedAt = new Date().toISOString()
      localStorage.setItem(key, JSON.stringify(items))
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Get top memories by importance score
   */
  getTopMemories(maxResults = 10) {
    const allMemories = []

    for (const type of MEMORY_TYPES_LOCAL) {
      const items = this.getLearnedItemsByType(type)
      for (const item of items) {
        const importance = this.calculateImportance(item)
        allMemories.push({
          ...item,
          type,
          importance: importance.total,
          importanceBreakdown: importance.breakdown
        })
      }
    }

    return allMemories
      .sort((a, b) => b.importance - a.importance)
      .slice(0, maxResults)
  }

  // ==================== ENTITY MEMORY ====================

  /**
   * Extract entities from text (hosts, services, IPs, etc.)
   */
  extractEntities(text) {
    const entities = []
    if (!text) return entities

    const textLower = text.toLowerCase()

    // Extract hosts
    let match
    while ((match = ENTITY_PATTERNS.host.exec(text)) !== null) {
      entities.push({ type: 'host', name: match[1], source: 'pattern' })
    }
    ENTITY_PATTERNS.host.lastIndex = 0 // Reset regex

    // Extract IPs
    while ((match = ENTITY_PATTERNS.ip.exec(text)) !== null) {
      entities.push({ type: 'ip', value: match[1], source: 'pattern' })
    }
    ENTITY_PATTERNS.ip.lastIndex = 0

    // Extract services
    while ((match = ENTITY_PATTERNS.service.exec(text)) !== null) {
      entities.push({ type: 'service', name: match[1], source: 'pattern' })
    }
    ENTITY_PATTERNS.service.lastIndex = 0

    // Extract containers
    while ((match = ENTITY_PATTERNS.container.exec(text)) !== null) {
      entities.push({ type: 'container', name: match[1], source: 'pattern' })
    }
    ENTITY_PATTERNS.container.lastIndex = 0

    // Extract ports
    while ((match = ENTITY_PATTERNS.port.exec(text)) !== null) {
      entities.push({ type: 'port', value: match[1], source: 'pattern' })
    }
    ENTITY_PATTERNS.port.lastIndex = 0

    // Known host names (common infra patterns)
    const knownPatterns = [
      /\b(docker\d{2}|proxmox\d{2}|nas\d{2}|grafana\d{2}|prometheus\d{2})\b/gi,
      /\b([a-z]+-\d{2,3})\b/gi,  // e.g., web-01, db-02
    ]

    for (const pattern of knownPatterns) {
      while ((match = pattern.exec(text)) !== null) {
        if (!entities.some(e => e.name === match[1])) {
          entities.push({ type: 'host', name: match[1], source: 'known_pattern' })
        }
      }
      pattern.lastIndex = 0
    }

    return entities
  }

  /**
   * Store or update an entity in memory
   */
  storeEntity(entity) {
    try {
      const key = 'quox_entities'
      const data = localStorage.getItem(key)
      const entities = data ? JSON.parse(data) : {}

      const entityKey = `${entity.type}:${entity.name || entity.value}`

      if (!entities[entityKey]) {
        entities[entityKey] = {
          ...entity,
          id: entityKey,
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          mentionCount: 1,
          attributes: entity.attributes || {},
          relationships: []
        }
      } else {
        entities[entityKey].lastSeen = new Date().toISOString()
        entities[entityKey].mentionCount++
        // Merge new attributes
        if (entity.attributes) {
          entities[entityKey].attributes = {
            ...entities[entityKey].attributes,
            ...entity.attributes
          }
        }
      }

      localStorage.setItem(key, JSON.stringify(entities))

      // Phase 5: Also save to server (non-blocking)
      memoryClient.saveEntity({
        name: entity.name || entity.value,
        type: entity.type,
        attributes: entities[entityKey].attributes
      }).catch(err => {
        console.warn('[Memory] Server entity save failed:', err.message)
      })

      // AEE audit trail
      logEntityStored(entities[entityKey])

      return entities[entityKey]
    } catch (e) {
      return null
    }
  }

  /**
   * Get all entities
   */
  getAllEntities() {
    try {
      const data = localStorage.getItem('quox_entities')
      return data ? Object.values(JSON.parse(data)) : []
    } catch (e) {
      return []
    }
  }

  /**
   * Get entities by type
   */
  getEntitiesByType(type) {
    return this.getAllEntities().filter(e => e.type === type)
  }

  /**
   * Get a specific entity
   */
  getEntity(type, name) {
    try {
      const data = localStorage.getItem('quox_entities')
      if (!data) return null
      const entities = JSON.parse(data)
      return entities[`${type}:${name}`] || null
    } catch (e) {
      return null
    }
  }

  /**
   * Update entity attributes
   */
  updateEntityAttributes(type, name, attributes) {
    try {
      const key = 'quox_entities'
      const data = localStorage.getItem(key)
      if (!data) return false

      const entities = JSON.parse(data)
      const entityKey = `${type}:${name}`

      if (!entities[entityKey]) return false

      entities[entityKey].attributes = {
        ...entities[entityKey].attributes,
        ...attributes
      }
      entities[entityKey].lastUpdated = new Date().toISOString()

      localStorage.setItem(key, JSON.stringify(entities))
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Add relationship between entities
   */
  addEntityRelationship(fromType, fromName, toType, toName, relationship) {
    try {
      const key = 'quox_entities'
      const data = localStorage.getItem(key)
      if (!data) return false

      const entities = JSON.parse(data)
      const fromKey = `${fromType}:${fromName}`

      if (!entities[fromKey]) return false

      if (!entities[fromKey].relationships) {
        entities[fromKey].relationships = []
      }

      // Check if relationship already exists
      const exists = entities[fromKey].relationships.some(
        r => r.toType === toType && r.toName === toName && r.type === relationship
      )

      if (!exists) {
        entities[fromKey].relationships.push({
          type: relationship,
          toType,
          toName,
          createdAt: new Date().toISOString()
        })
      }

      localStorage.setItem(key, JSON.stringify(entities))
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Search entities
   */
  searchEntities(query) {
    const queryLower = query.toLowerCase()
    return this.getAllEntities().filter(entity => {
      const searchText = `${entity.type} ${entity.name || ''} ${entity.value || ''} ${JSON.stringify(entity.attributes || {})}`.toLowerCase()
      return searchText.includes(queryLower)
    })
  }

  /**
   * Process entities from interaction
   */
  processEntitiesFromInteraction(text) {
    const entities = this.extractEntities(text)
    const stored = []

    for (const entity of entities) {
      const result = this.storeEntity(entity)
      if (result) stored.push(result)
    }

    return stored
  }

  /**
   * Get entity statistics
   */
  getEntityStats() {
    const entities = this.getAllEntities()
    const stats = {
      total: entities.length,
      byType: {}
    }

    for (const entity of entities) {
      stats.byType[entity.type] = (stats.byType[entity.type] || 0) + 1
    }

    return stats
  }

  // ============================================
  // Knowledge Graph Methods
  // ============================================

  /**
   * Get the relationship schema (types and their inverses)
   */
  getRelationshipSchema() {
    return RELATIONSHIP_SCHEMA
  }

  /**
   * Add bidirectional relationship between entities
   * Automatically creates the inverse relationship
   */
  addBidirectionalRelationship(fromType, fromName, toType, toName, relationship) {
    try {
      const key = 'quox_entities'
      const data = localStorage.getItem(key)
      if (!data) return false

      const entities = JSON.parse(data)
      const fromKey = `${fromType}:${fromName}`
      const toKey = `${toType}:${toName}`

      // Ensure both entities exist
      if (!entities[fromKey] || !entities[toKey]) return false

      // Initialize relationships arrays
      if (!entities[fromKey].relationships) entities[fromKey].relationships = []
      if (!entities[toKey].relationships) entities[toKey].relationships = []

      // Add forward relationship
      const forwardExists = entities[fromKey].relationships.some(
        r => r.toType === toType && r.toName === toName && r.type === relationship
      )
      if (!forwardExists) {
        entities[fromKey].relationships.push({
          type: relationship,
          toType,
          toName,
          createdAt: new Date().toISOString()
        })
      }

      // Add inverse relationship
      const inverse = RELATIONSHIP_SCHEMA[relationship]?.inverse || 'related_to'
      const inverseExists = entities[toKey].relationships.some(
        r => r.toType === fromType && r.toName === fromName && r.type === inverse
      )
      if (!inverseExists) {
        entities[toKey].relationships.push({
          type: inverse,
          toType: fromType,
          toName: fromName,
          createdAt: new Date().toISOString()
        })
      }

      localStorage.setItem(key, JSON.stringify(entities))
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Get all entities directly related to a given entity
   */
  getRelatedEntities(type, name, relationshipFilter = null) {
    const entity = this.getEntity(type, name)
    if (!entity || !entity.relationships) return []

    let relationships = entity.relationships
    if (relationshipFilter) {
      relationships = relationships.filter(r => r.type === relationshipFilter)
    }

    return relationships.map(rel => {
      const relatedEntity = this.getEntity(rel.toType, rel.toName)
      return {
        ...relatedEntity,
        relationshipType: rel.type,
        relationshipCreatedAt: rel.createdAt
      }
    }).filter(e => e !== null)
  }

  /**
   * Get N-hop neighborhood of an entity (graph traversal)
   */
  getEntityNeighborhood(type, name, hops = 1) {
    const visited = new Set()
    const result = []
    const startKey = `${type}:${name}`

    const queue = [{ type, name, depth: 0, path: [] }]
    visited.add(startKey)

    while (queue.length > 0) {
      const { type: currentType, name: currentName, depth, path } = queue.shift()

      if (depth > 0) {
        const entity = this.getEntity(currentType, currentName)
        if (entity) {
          result.push({
            ...entity,
            depth,
            path: [...path]
          })
        }
      }

      if (depth < hops) {
        const related = this.getRelatedEntities(currentType, currentName)
        for (const rel of related) {
          const relKey = `${rel.type}:${rel.name}`
          if (!visited.has(relKey)) {
            visited.add(relKey)
            queue.push({
              type: rel.type,
              name: rel.name,
              depth: depth + 1,
              path: [...path, { from: currentName, rel: rel.relationshipType, to: rel.name }]
            })
          }
        }
      }
    }

    return result
  }

  /**
   * Find shortest path between two entities (BFS)
   */
  findPath(fromType, fromName, toType, toName, maxDepth = 5) {
    const targetKey = `${toType}:${toName}`
    const visited = new Set()
    const startKey = `${fromType}:${fromName}`

    const queue = [{ type: fromType, name: fromName, path: [] }]
    visited.add(startKey)

    while (queue.length > 0) {
      const { type, name, path } = queue.shift()

      if (path.length > maxDepth) continue

      const currentKey = `${type}:${name}`
      if (currentKey === targetKey) {
        return {
          found: true,
          path,
          length: path.length
        }
      }

      const related = this.getRelatedEntities(type, name)
      for (const rel of related) {
        const relKey = `${rel.type}:${rel.name}`
        if (!visited.has(relKey)) {
          visited.add(relKey)
          queue.push({
            type: rel.type,
            name: rel.name,
            path: [...path, {
              from: { type, name },
              relationship: rel.relationshipType,
              to: { type: rel.type, name: rel.name }
            }]
          })
        }
      }
    }

    return { found: false, path: [], length: -1 }
  }

  /**
   * Get entity importance based on graph centrality (degree + betweenness approximation)
   */
  getEntityImportance(type, name) {
    const entity = this.getEntity(type, name)
    if (!entity) return { score: 0, breakdown: {} }

    const relationships = entity.relationships || []
    const allEntities = this.getAllEntities()

    // Degree centrality (number of connections)
    const degree = relationships.length
    const maxDegree = Math.max(...allEntities.map(e => (e.relationships || []).length), 1)
    const degreeScore = degree / maxDegree

    // Mention frequency
    const mentionScore = Math.min(1, (entity.mentionCount || 1) / 20)

    // Recency
    const lastSeen = new Date(entity.lastSeen || entity.firstSeen || Date.now())
    const daysSinceAccess = (Date.now() - lastSeen) / (1000 * 60 * 60 * 24)
    const recencyScore = Math.exp(-daysSinceAccess / 30) // Decay over 30 days

    // Combined score
    const score = (degreeScore * 0.4) + (mentionScore * 0.3) + (recencyScore * 0.3)

    return {
      score,
      breakdown: {
        degree: degreeScore,
        mentions: mentionScore,
        recency: recencyScore
      },
      connectionCount: degree,
      mentionCount: entity.mentionCount || 1
    }
  }

  /**
   * Get a subgraph of connected entities for visualization
   */
  getEntityGraph(centerType = null, centerName = null, maxNodes = 50) {
    const nodes = []
    const edges = []
    const nodeMap = new Map()

    let entities = this.getAllEntities()

    // If center specified, start from there
    if (centerType && centerName) {
      const neighborhood = this.getEntityNeighborhood(centerType, centerName, 2)
      const centerEntity = this.getEntity(centerType, centerName)
      if (centerEntity) {
        entities = [centerEntity, ...neighborhood]
      }
    }

    // Limit nodes
    entities = entities.slice(0, maxNodes)

    // Build nodes
    for (const entity of entities) {
      const key = `${entity.type}:${entity.name}`
      if (!nodeMap.has(key)) {
        const importance = this.getEntityImportance(entity.type, entity.name)
        nodes.push({
          id: key,
          type: entity.type,
          name: entity.name,
          attributes: entity.attributes,
          importance: importance.score,
          mentionCount: entity.mentionCount || 1
        })
        nodeMap.set(key, true)
      }
    }

    // Build edges
    for (const entity of entities) {
      const fromKey = `${entity.type}:${entity.name}`
      for (const rel of entity.relationships || []) {
        const toKey = `${rel.toType}:${rel.toName}`
        if (nodeMap.has(toKey)) {
          edges.push({
            from: fromKey,
            to: toKey,
            type: rel.type,
            label: rel.type.replace(/_/g, ' ')
          })
        }
      }
    }

    return { nodes, edges }
  }

  /**
   * Infer relationships from entity attributes
   * e.g., hosts on same subnet might be related
   */
  inferRelationships() {
    const entities = this.getAllEntities()
    const inferred = []

    // Group hosts by subnet
    const hostsBySubnet = {}
    for (const entity of entities) {
      if (entity.type === 'host' && entity.attributes?.ip) {
        const ip = entity.attributes.ip
        const subnet = ip.split('.').slice(0, 3).join('.')
        if (!hostsBySubnet[subnet]) hostsBySubnet[subnet] = []
        hostsBySubnet[subnet].push(entity)
      }
    }

    // Infer same-network relationships
    for (const [subnet, hosts] of Object.entries(hostsBySubnet)) {
      if (hosts.length > 1) {
        for (let i = 0; i < hosts.length; i++) {
          for (let j = i + 1; j < hosts.length; j++) {
            const exists = this.getRelatedEntities(hosts[i].type, hosts[i].name, 'connects_to')
              .some(r => r.name === hosts[j].name)

            if (!exists) {
              inferred.push({
                from: hosts[i],
                to: hosts[j],
                relationship: 'connects_to',
                reason: `Same subnet (${subnet}.*)`
              })
            }
          }
        }
      }
    }

    // Infer container-host relationships based on naming
    for (const entity of entities) {
      if (entity.type === 'container') {
        // Look for hosts with matching prefixes
        const hosts = entities.filter(e => e.type === 'host')
        for (const host of hosts) {
          if (entity.name.includes(host.name) || host.name.includes('docker')) {
            const exists = this.getRelatedEntities(entity.type, entity.name, 'runs_on')
              .some(r => r.name === host.name)

            if (!exists) {
              inferred.push({
                from: entity,
                to: host,
                relationship: 'runs_on',
                reason: 'Name pattern match'
              })
            }
          }
        }
      }
    }

    return inferred
  }

  /**
   * Apply inferred relationships to the graph
   */
  applyInferredRelationships() {
    const inferred = this.inferRelationships()
    let applied = 0

    for (const inf of inferred) {
      const success = this.addBidirectionalRelationship(
        inf.from.type, inf.from.name,
        inf.to.type, inf.to.name,
        inf.relationship
      )
      if (success) applied++
    }

    return { inferred: inferred.length, applied }
  }

  /**
   * Suggest entities related to a query context
   */
  suggestRelatedEntities(query, limit = 5) {
    const queryLower = query.toLowerCase()
    const suggestions = []

    const entities = this.getAllEntities()
    for (const entity of entities) {
      let score = 0

      // Name match
      if (queryLower.includes(entity.name.toLowerCase())) {
        score += 0.5
      }

      // Type match (if query mentions type)
      if (queryLower.includes(entity.type)) {
        score += 0.2
      }

      // Attribute match
      const attrStr = JSON.stringify(entity.attributes || {}).toLowerCase()
      if (attrStr.split(/\s+/).some(word => queryLower.includes(word))) {
        score += 0.2
      }

      // Relationship boost (more connected = more likely relevant)
      const relCount = (entity.relationships || []).length
      score += Math.min(0.3, relCount * 0.05)

      if (score > 0) {
        const importance = this.getEntityImportance(entity.type, entity.name)
        suggestions.push({
          entity,
          relevanceScore: score,
          importanceScore: importance.score,
          combinedScore: (score * 0.6) + (importance.score * 0.4)
        })
      }
    }

    return suggestions
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, limit)
  }

  /**
   * Get graph statistics
   */
  getGraphStats() {
    const entities = this.getAllEntities()
    let totalRelationships = 0
    let maxConnections = 0
    let isolatedNodes = 0
    const relationshipTypes = {}

    for (const entity of entities) {
      const relCount = (entity.relationships || []).length
      totalRelationships += relCount
      if (relCount > maxConnections) maxConnections = relCount
      if (relCount === 0) isolatedNodes++

      for (const rel of entity.relationships || []) {
        relationshipTypes[rel.type] = (relationshipTypes[rel.type] || 0) + 1
      }
    }

    return {
      nodeCount: entities.length,
      edgeCount: totalRelationships,
      isolatedNodes,
      maxConnections,
      avgConnections: entities.length > 0 ? (totalRelationships / entities.length).toFixed(2) : 0,
      relationshipTypes,
      density: entities.length > 1 ? (totalRelationships / (entities.length * (entities.length - 1))).toFixed(4) : 0
    }
  }

  // ============================================
  // Runbook Memory Methods
  // ============================================

  /**
   * Get runbook intent patterns
   */
  getRunbookIntents() {
    return RUNBOOK_INTENTS
  }

  /**
   * Store or update a runbook
   */
  storeRunbook(runbook) {
    try {
      const key = 'quox_runbooks'
      const data = localStorage.getItem(key)
      const runbooks = data ? JSON.parse(data) : {}

      const id = runbook.id || `runbook_${Date.now()}`

      if (!runbooks[id]) {
        runbooks[id] = {
          ...runbook,
          id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          executionCount: 0,
          successCount: 0,
          failureCount: 0,
          executions: []
        }
      } else {
        runbooks[id] = {
          ...runbooks[id],
          ...runbook,
          updatedAt: new Date().toISOString()
        }
      }

      localStorage.setItem(key, JSON.stringify(runbooks))
      return runbooks[id]
    } catch (e) {
      return null
    }
  }

  /**
   * Get all runbooks
   */
  getAllRunbooks() {
    try {
      const data = localStorage.getItem('quox_runbooks')
      return data ? Object.values(JSON.parse(data)) : []
    } catch (e) {
      return []
    }
  }

  /**
   * Get a specific runbook by ID
   */
  getRunbook(id) {
    try {
      const data = localStorage.getItem('quox_runbooks')
      if (!data) return null
      const runbooks = JSON.parse(data)
      return runbooks[id] || null
    } catch (e) {
      return null
    }
  }

  /**
   * Delete a runbook
   */
  deleteRunbook(id) {
    try {
      const key = 'quox_runbooks'
      const data = localStorage.getItem(key)
      if (!data) return false

      const runbooks = JSON.parse(data)
      if (!runbooks[id]) return false

      delete runbooks[id]
      localStorage.setItem(key, JSON.stringify(runbooks))
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Detect intents from a query
   */
  detectIntents(query) {
    const queryLower = query.toLowerCase()
    const detectedIntents = []

    for (const [intent, config] of Object.entries(RUNBOOK_INTENTS)) {
      const allPatterns = [...config.patterns, ...config.synonyms]
      for (const pattern of allPatterns) {
        if (queryLower.includes(pattern)) {
          detectedIntents.push({
            intent,
            matchedPattern: pattern,
            confidence: config.patterns.includes(pattern) ? 1.0 : 0.8
          })
          break // Only match once per intent
        }
      }
    }

    return detectedIntents
  }

  /**
   * Calculate runbook match score for a query
   */
  scoreRunbook(runbook, query) {
    const queryLower = query.toLowerCase()
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2)
    let score = 0

    // Title match (high weight)
    const titleLower = (runbook.title || '').toLowerCase()
    const titleMatch = queryWords.filter(w => titleLower.includes(w)).length
    score += titleMatch * 0.3

    // Trigger match (high weight)
    const triggers = runbook.triggers || []
    for (const trigger of triggers) {
      if (queryLower.includes(trigger.toLowerCase())) {
        score += 0.25
      }
    }

    // Intent match
    const queryIntents = this.detectIntents(query)
    const runbookIntents = runbook.intents || []
    for (const detected of queryIntents) {
      if (runbookIntents.includes(detected.intent)) {
        score += 0.2 * detected.confidence
      }
    }

    // Entity match
    const runbookEntities = runbook.entities || []
    const queryEntities = this.extractEntities(query)
    for (const qEntity of queryEntities) {
      const qKey = `${qEntity.type}:${qEntity.name || qEntity.value}`
      for (const rEntity of runbookEntities) {
        // Support wildcards like "host:*"
        if (rEntity.endsWith(':*')) {
          const rType = rEntity.split(':')[0]
          if (qEntity.type === rType) {
            score += 0.15
          }
        } else if (rEntity === qKey) {
          score += 0.2
        }
      }
    }

    // Description match
    const descLower = (runbook.description || '').toLowerCase()
    const descMatch = queryWords.filter(w => descLower.includes(w)).length
    score += descMatch * 0.1

    // Success rate bonus
    if (runbook.executionCount > 0) {
      const successRate = runbook.successCount / runbook.executionCount
      score += successRate * 0.1
    }

    return Math.min(1.0, score)
  }

  /**
   * Find runbooks matching a query
   */
  findRunbooks(query, limit = 5, minScore = 0.1) {
    const runbooks = this.getAllRunbooks()
    const scored = []

    for (const runbook of runbooks) {
      const score = this.scoreRunbook(runbook, query)
      if (score >= minScore) {
        scored.push({
          runbook,
          score,
          intents: this.detectIntents(query)
        })
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /**
   * Record runbook execution
   */
  recordRunbookExecution(runbookId, success, duration = null, notes = null) {
    try {
      const key = 'quox_runbooks'
      const data = localStorage.getItem(key)
      if (!data) return false

      const runbooks = JSON.parse(data)
      if (!runbooks[runbookId]) return false

      const execution = {
        timestamp: new Date().toISOString(),
        success,
        duration,
        notes
      }

      runbooks[runbookId].executionCount++
      if (success) {
        runbooks[runbookId].successCount++
      } else {
        runbooks[runbookId].failureCount++
      }

      // Keep last 20 executions
      if (!runbooks[runbookId].executions) {
        runbooks[runbookId].executions = []
      }
      runbooks[runbookId].executions.unshift(execution)
      runbooks[runbookId].executions = runbooks[runbookId].executions.slice(0, 20)
      runbooks[runbookId].lastExecuted = execution.timestamp

      localStorage.setItem(key, JSON.stringify(runbooks))
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Get runbook statistics
   */
  getRunbookStats() {
    const runbooks = this.getAllRunbooks()
    let totalExecutions = 0
    let totalSuccess = 0
    let totalFailure = 0
    const byIntent = {}

    for (const runbook of runbooks) {
      totalExecutions += runbook.executionCount || 0
      totalSuccess += runbook.successCount || 0
      totalFailure += runbook.failureCount || 0

      for (const intent of runbook.intents || []) {
        byIntent[intent] = (byIntent[intent] || 0) + 1
      }
    }

    return {
      totalRunbooks: runbooks.length,
      totalExecutions,
      totalSuccess,
      totalFailure,
      overallSuccessRate: totalExecutions > 0 ? (totalSuccess / totalExecutions).toFixed(2) : 0,
      byIntent,
      mostUsed: runbooks
        .filter(r => r.executionCount > 0)
        .sort((a, b) => (b.executionCount || 0) - (a.executionCount || 0))
        .slice(0, 5)
        .map(r => ({ id: r.id, title: r.title, executions: r.executionCount }))
    }
  }

  /**
   * Create runbook from successful interaction pattern
   */
  createRunbookFromPattern(title, steps, triggers, intents, entities = []) {
    return this.storeRunbook({
      title,
      description: `Auto-generated runbook: ${title}`,
      triggers,
      intents,
      entities,
      steps: steps.map((step, i) => ({
        order: i + 1,
        action: step.action || 'manual',
        command: step.command,
        description: step.description || `Step ${i + 1}`
      })),
      autoGenerated: true
    })
  }

  /**
   * Suggest runbook creation from recent interactions
   */
  suggestRunbookCreation() {
    const suggestions = []
    const recentEvents = this.getRecentEvents(50)

    // Group by detected intents
    const intentGroups = {}
    for (const event of recentEvents) {
      if (!event?.query) continue

      const intents = this.detectIntents(event.query)
      for (const detected of intents) {
        if (!intentGroups[detected.intent]) {
          intentGroups[detected.intent] = []
        }
        intentGroups[detected.intent].push(event)
      }
    }

    // Suggest runbooks for frequently occurring patterns
    for (const [intent, events] of Object.entries(intentGroups)) {
      if (events.length >= 3) {
        // Extract common entities
        const entityCounts = {}
        for (const event of events) {
          const entities = this.extractEntities(event.query)
          for (const entity of entities) {
            const key = `${entity.type}:${entity.name || entity.value}`
            entityCounts[key] = (entityCounts[key] || 0) + 1
          }
        }

        const commonEntities = Object.entries(entityCounts)
          .filter(([_, count]) => count >= 2)
          .map(([key]) => key)

        suggestions.push({
          intent,
          occurrences: events.length,
          suggestedTitle: `${intent.charAt(0).toUpperCase() + intent.slice(1)} procedure`,
          commonEntities,
          sampleQueries: events.slice(0, 3).map(e => e.query)
        })
      }
    }

    return suggestions
  }

  /**
   * Get runbooks for a specific entity
   */
  getRunbooksForEntity(entityType, entityName) {
    const entityKey = `${entityType}:${entityName}`
    const wildcardKey = `${entityType}:*`

    return this.getAllRunbooks().filter(runbook => {
      const entities = runbook.entities || []
      return entities.includes(entityKey) || entities.includes(wildcardKey)
    })
  }

  // ============================================
  // Cross-Encoder Reranking Methods
  // ============================================

  /**
   * Cross-encoder style scoring for a query-document pair
   * Simulates what a neural cross-encoder would compute
   */
  crossEncoderScore(query, document) {
    const queryLower = query.toLowerCase()
    const docLower = (document || '').toLowerCase()

    if (!docLower) return { score: 0, breakdown: {} }

    const queryTokens = queryLower.split(/\s+/).filter(t => t.length > 1)
    const docTokens = docLower.split(/\s+/).filter(t => t.length > 1)

    if (queryTokens.length === 0 || docTokens.length === 0) {
      return { score: 0, breakdown: {} }
    }

    // 1. Token overlap ratio (Jaccard-like)
    const querySet = new Set(queryTokens)
    const docSet = new Set(docTokens)
    const intersection = [...querySet].filter(t => docSet.has(t)).length
    const union = new Set([...querySet, ...docSet]).size
    const overlapScore = intersection / union

    // 2. Coverage - what fraction of query terms appear in doc
    const coverageScore = intersection / queryTokens.length

    // 3. Position bonus - terms appearing early in document get bonus
    let positionScore = 0
    for (const token of queryTokens) {
      const pos = docLower.indexOf(token)
      if (pos >= 0) {
        // Higher score for terms appearing earlier (normalized by doc length)
        positionScore += 1 - (pos / docLower.length)
      }
    }
    positionScore = queryTokens.length > 0 ? positionScore / queryTokens.length : 0

    // 4. Exact phrase matching bonus
    let phraseScore = 0
    if (queryLower.length > 5 && docLower.includes(queryLower)) {
      phraseScore = 1.0
    } else {
      // Check for bigram matches
      for (let i = 0; i < queryTokens.length - 1; i++) {
        const bigram = `${queryTokens[i]} ${queryTokens[i + 1]}`
        if (docLower.includes(bigram)) {
          phraseScore += 0.3
        }
      }
      phraseScore = Math.min(1, phraseScore)
    }

    // 5. Length penalty - very short or very long docs get penalized
    const idealLength = queryTokens.length * 10
    const lengthRatio = docTokens.length / idealLength
    const lengthScore = lengthRatio > 1 ? 1 / lengthRatio : lengthRatio

    // 6. Term importance weighting (pseudo-IDF)
    // Common words get less weight
    const commonWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'or', 'and', 'not', 'this', 'that', 'it'])
    let importanceScore = 0
    let importantTermCount = 0
    for (const token of queryTokens) {
      if (!commonWords.has(token)) {
        importantTermCount++
        if (docSet.has(token)) {
          importanceScore += 1
        }
      }
    }
    importanceScore = importantTermCount > 0 ? importanceScore / importantTermCount : coverageScore

    // Combine scores with learned weights
    const weights = {
      overlap: 0.15,
      coverage: 0.25,
      position: 0.10,
      phrase: 0.20,
      length: 0.05,
      importance: 0.25
    }

    const totalScore = (
      weights.overlap * overlapScore +
      weights.coverage * coverageScore +
      weights.position * positionScore +
      weights.phrase * phraseScore +
      weights.length * lengthScore +
      weights.importance * importanceScore
    )

    return {
      score: Math.min(1, totalScore),
      breakdown: {
        overlap: overlapScore,
        coverage: coverageScore,
        position: positionScore,
        phrase: phraseScore,
        length: lengthScore,
        importance: importanceScore
      }
    }
  }

  /**
   * Late interaction scoring (ColBERT-style token matching)
   * Computes max similarity for each query token
   */
  lateInteractionScore(query, document) {
    const queryTokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 2)
    const docTokens = document.toLowerCase().split(/\s+/).filter(t => t.length > 2)

    if (queryTokens.length === 0 || docTokens.length === 0) return 0

    // For each query token, find max similarity with any doc token
    let totalScore = 0
    for (const qToken of queryTokens) {
      let maxSim = 0
      for (const dToken of docTokens) {
        // Simple similarity: exact match = 1, prefix match = 0.8, contains = 0.5
        if (qToken === dToken) {
          maxSim = 1.0
          break
        } else if (dToken.startsWith(qToken) || qToken.startsWith(dToken)) {
          maxSim = Math.max(maxSim, 0.8)
        } else if (dToken.includes(qToken) || qToken.includes(dToken)) {
          maxSim = Math.max(maxSim, 0.5)
        }
      }
      totalScore += maxSim
    }

    return totalScore / queryTokens.length
  }

  /**
   * Rerank a list of results using cross-encoder scoring
   */
  rerank(query, results, topK = null) {
    if (!results || results.length === 0) return []

    const reranked = results.map(item => {
      // Extract searchable content from item
      const content = this.extractSearchableContent(item)

      // Get cross-encoder score
      const ceResult = this.crossEncoderScore(query, content)

      // Get late interaction score
      const liScore = this.lateInteractionScore(query, content)

      // Combine scores (cross-encoder weighted higher)
      const combinedScore = (ceResult.score * 0.7) + (liScore * 0.3)

      return {
        ...item,
        rerankedScore: combinedScore,
        crossEncoderScore: ceResult.score,
        lateInteractionScore: liScore,
        scoreBreakdown: ceResult.breakdown
      }
    })

    // Sort by reranked score
    reranked.sort((a, b) => b.rerankedScore - a.rerankedScore)

    return topK ? reranked.slice(0, topK) : reranked
  }

  /**
   * Extract searchable content from an item
   */
  extractSearchableContent(item) {
    if (!item) return ''

    const parts = []

    // Different item types have different content fields
    if (item.content) parts.push(item.content)
    if (item.title) parts.push(item.title)
    if (item.name) parts.push(item.name)
    if (item.description) parts.push(item.description)
    if (item.query) parts.push(item.query)
    if (item.response) parts.push(item.response)
    if (Array.isArray(item.keywords)) parts.push(item.keywords.join(' '))
    if (Array.isArray(item.triggers)) parts.push(item.triggers.join(' '))

    return parts.join(' ')
  }

  /**
   * Enhanced hybrid search with cross-encoder reranking
   */
  async hybridSearchWithReranking(query, maxResults = 10, rerankTopK = 20) {
    // First, get more initial results than needed
    const initialResults = await this.hybridSearch(query, rerankTopK)

    // Then rerank with cross-encoder scoring
    const reranked = this.rerank(query, initialResults, maxResults)

    return reranked.map(item => ({
      ...item,
      // Combine original RRF score with reranked score for final score
      finalScore: (item.rrfScore || 0) * 0.3 + item.rerankedScore * 0.7
    }))
  }

  /**
   * Get reranking configuration
   */
  getRerankingConfig() {
    return {
      crossEncoderWeights: {
        overlap: 0.15,
        coverage: 0.25,
        position: 0.10,
        phrase: 0.20,
        length: 0.05,
        importance: 0.25
      },
      combinedWeights: {
        crossEncoder: 0.7,
        lateInteraction: 0.3
      },
      finalScoreWeights: {
        initialRetrieval: 0.3,
        reranking: 0.7
      }
    }
  }

  /**
   * Calibrate scores to be more discriminative
   * Uses temperature scaling
   */
  calibrateScores(scores, temperature = 1.0) {
    if (!scores || scores.length === 0) return []

    // Apply temperature scaling (softmax-like)
    const maxScore = Math.max(...scores)
    const expScores = scores.map(s => Math.exp((s - maxScore) / temperature))
    const sumExp = expScores.reduce((a, b) => a + b, 0)

    return expScores.map(s => s / sumExp)
  }

  // ============================================
  // Proactive Suggestions System
  // ============================================

  /**
   * Generate proactive suggestions based on current context
   */
  generateSuggestions(currentContext = {}) {
    const suggestions = []
    const now = new Date()
    const hour = now.getHours()

    // 1. Time-based suggestions
    const timeSuggestions = this.getTimBasedSuggestions(hour)
    suggestions.push(...timeSuggestions)

    // 2. Pattern-based suggestions from reflection insights
    const patternSuggestions = this.getPatternBasedSuggestions()
    suggestions.push(...patternSuggestions)

    // 3. Runbook suggestions based on recent activity
    const runbookSuggestions = this.getRunbookSuggestions(currentContext)
    suggestions.push(...runbookSuggestions)

    // 4. Entity-based suggestions (frequently used entities)
    const entitySuggestions = this.getEntitySuggestions()
    suggestions.push(...entitySuggestions)

    // 5. Maintenance suggestions
    const maintenanceSuggestions = this.getMaintenanceSuggestions()
    suggestions.push(...maintenanceSuggestions)

    // Score and rank suggestions
    const scored = suggestions.map(s => ({
      ...s,
      finalScore: this.scoreSuggestion(s, currentContext)
    }))

    // Sort by score and deduplicate
    const seen = new Set()
    return scored
      .sort((a, b) => b.finalScore - a.finalScore)
      .filter(s => {
        const key = `${s.type}:${s.title}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, 5)
  }

  /**
   * Time-based suggestions
   */
  getTimBasedSuggestions(hour) {
    const suggestions = []

    // Morning suggestions (6-10am)
    if (hour >= 6 && hour < 10) {
      suggestions.push({
        type: 'time_based',
        title: 'Morning health check',
        description: 'Run infrastructure health checks to start the day',
        action: 'check',
        priority: 0.7,
        timeRelevance: 1.0
      })
    }

    // End of day (5-7pm)
    if (hour >= 17 && hour < 19) {
      suggestions.push({
        type: 'time_based',
        title: 'Daily backup verification',
        description: 'Verify backup jobs completed successfully',
        action: 'backup',
        priority: 0.6,
        timeRelevance: 1.0
      })
    }

    // Late night (11pm-2am) - maintenance window
    if (hour >= 23 || hour < 2) {
      suggestions.push({
        type: 'time_based',
        title: 'Maintenance window',
        description: 'Good time for updates or maintenance tasks',
        action: 'configure',
        priority: 0.5,
        timeRelevance: 1.0
      })
    }

    return suggestions
  }

  /**
   * Pattern-based suggestions from reflection insights
   */
  getPatternBasedSuggestions() {
    const suggestions = []
    const reflections = this.getLearnedItemsByType('reflection')

    for (const reflection of reflections.slice(-10)) {
      if (reflection.category === 'recurring_topic' && reflection.confidence > 0.7) {
        suggestions.push({
          type: 'pattern',
          title: `Frequent topic: ${reflection.relatedTopic || 'detected pattern'}`,
          description: reflection.content?.substring(0, 100),
          action: 'investigate',
          priority: reflection.confidence,
          source: 'reflection',
          reflectionId: reflection.id
        })
      }

      if (reflection.category === 'common_error') {
        suggestions.push({
          type: 'pattern',
          title: 'Address recurring errors',
          description: reflection.content?.substring(0, 100),
          action: 'troubleshoot',
          priority: 0.8,
          source: 'reflection'
        })
      }
    }

    return suggestions
  }

  /**
   * Runbook suggestions based on context
   */
  getRunbookSuggestions(context = {}) {
    const suggestions = []
    const runbooks = this.getAllRunbooks()

    // Get recently executed runbooks
    const recentlyExecuted = runbooks
      .filter(r => r.lastExecuted)
      .sort((a, b) => new Date(b.lastExecuted) - new Date(a.lastExecuted))
      .slice(0, 3)

    // Suggest follow-up runbooks
    for (const runbook of recentlyExecuted) {
      const hoursSinceExecution = (Date.now() - new Date(runbook.lastExecuted)) / (1000 * 60 * 60)

      // If executed recently, might need verification
      if (hoursSinceExecution < 24) {
        suggestions.push({
          type: 'runbook_followup',
          title: `Verify: ${runbook.title}`,
          description: `Last executed ${Math.round(hoursSinceExecution)} hours ago`,
          action: 'check',
          priority: 0.6,
          runbookId: runbook.id
        })
      }
    }

    // Suggest highly successful runbooks
    const successfulRunbooks = runbooks
      .filter(r => r.executionCount >= 3 && (r.successCount / r.executionCount) > 0.8)
      .slice(0, 2)

    for (const runbook of successfulRunbooks) {
      suggestions.push({
        type: 'runbook_recommended',
        title: runbook.title,
        description: `High success rate (${Math.round(runbook.successCount / runbook.executionCount * 100)}%)`,
        action: runbook.intents?.[0] || 'execute',
        priority: 0.5,
        runbookId: runbook.id
      })
    }

    return suggestions
  }

  /**
   * Entity-based suggestions
   */
  getEntitySuggestions() {
    const suggestions = []
    const entities = this.getAllEntities()

    // Find entities with high mention count but not recently accessed
    const staleHighUse = entities.filter(e => {
      const mentionCount = e.mentionCount || 0
      const lastSeen = new Date(e.lastSeen || 0)
      const daysSince = (Date.now() - lastSeen) / (1000 * 60 * 60 * 24)

      return mentionCount > 5 && daysSince > 7
    }).slice(0, 2)

    for (const entity of staleHighUse) {
      suggestions.push({
        type: 'entity_check',
        title: `Check ${entity.type}: ${entity.name}`,
        description: `Frequently used but not accessed recently`,
        action: 'check',
        priority: 0.5,
        entityType: entity.type,
        entityName: entity.name
      })
    }

    return suggestions
  }

  /**
   * Maintenance suggestions
   */
  getMaintenanceSuggestions() {
    const suggestions = []
    const health = this.getMemoryHealth()

    if (health.needsMaintenance) {
      suggestions.push({
        type: 'maintenance',
        title: 'Run memory maintenance',
        description: 'Memory system needs consolidation and cleanup',
        action: 'maintenance',
        priority: 0.7
      })
    }

    // Check for duplicate memories
    const duplicates = this.findDuplicateMemories(0.7)
    if (duplicates.length > 3) {
      suggestions.push({
        type: 'maintenance',
        title: 'Consolidate duplicate memories',
        description: `Found ${duplicates.length} potential duplicates`,
        action: 'consolidate',
        priority: 0.6
      })
    }

    // Check for contradictions
    const contradictions = this.detectContradictions()
    if (contradictions.length > 0) {
      suggestions.push({
        type: 'maintenance',
        title: 'Resolve memory contradictions',
        description: `Found ${contradictions.length} conflicting memories`,
        action: 'resolve',
        priority: 0.8
      })
    }

    return suggestions
  }

  /**
   * Score a suggestion based on context
   */
  scoreSuggestion(suggestion, context = {}) {
    let score = suggestion.priority || 0.5

    // Boost for time relevance
    if (suggestion.timeRelevance) {
      score *= (1 + suggestion.timeRelevance * 0.2)
    }

    // Boost for context match
    if (context.recentQuery && suggestion.title) {
      const queryWords = context.recentQuery.toLowerCase().split(/\s+/)
      const titleWords = suggestion.title.toLowerCase().split(/\s+/)
      const overlap = queryWords.filter(w => titleWords.some(t => t.includes(w))).length
      if (overlap > 0) {
        score *= (1 + overlap * 0.1)
      }
    }

    // Boost for maintenance if overdue
    if (suggestion.type === 'maintenance') {
      score *= 1.1
    }

    return Math.min(1.0, score)
  }

  /**
   * Record suggestion feedback (accepted/dismissed)
   */
  recordSuggestionFeedback(suggestionId, accepted, context = {}) {
    try {
      const key = 'quox_suggestion_feedback'
      const data = localStorage.getItem(key)
      const feedback = data ? JSON.parse(data) : []

      feedback.push({
        suggestionId,
        accepted,
        timestamp: new Date().toISOString(),
        context
      })

      // Keep last 100 feedback entries
      const trimmed = feedback.slice(-100)
      localStorage.setItem(key, JSON.stringify(trimmed))

      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Get suggestion acceptance rate by type
   */
  getSuggestionStats() {
    try {
      const data = localStorage.getItem('quox_suggestion_feedback')
      const feedback = data ? JSON.parse(data) : []

      const byType = {}
      let totalAccepted = 0
      let totalDismissed = 0

      for (const f of feedback) {
        const type = f.context?.type || 'unknown'
        if (!byType[type]) {
          byType[type] = { accepted: 0, dismissed: 0 }
        }

        if (f.accepted) {
          byType[type].accepted++
          totalAccepted++
        } else {
          byType[type].dismissed++
          totalDismissed++
        }
      }

      return {
        total: feedback.length,
        totalAccepted,
        totalDismissed,
        acceptanceRate: feedback.length > 0 ? (totalAccepted / feedback.length).toFixed(2) : 0,
        byType
      }
    } catch (e) {
      return { total: 0, totalAccepted: 0, totalDismissed: 0, acceptanceRate: 0, byType: {} }
    }
  }

  // ============================================
  // Memory Compression & Summarization
  // ============================================

  /**
   * Compress old episodic memories into summaries
   */
  compressEpisodicMemories(daysToKeepFull = 7, maxSummaryLength = 200) {
    try {
      const cutoffDate = new Date(Date.now() - daysToKeepFull * 24 * 60 * 60 * 1000)
      const episodicKey = 'quox_episodic'
      const summaryKey = 'quox_episodic_summaries'

      const episodicData = localStorage.getItem(episodicKey)
      const episodic = episodicData ? JSON.parse(episodicData) : []

      const summaryData = localStorage.getItem(summaryKey)
      const summaries = summaryData ? JSON.parse(summaryData) : []

      const toCompress = []
      const toKeep = []

      for (const entry of episodic) {
        const entryDate = new Date(entry.timestamp)
        if (entryDate < cutoffDate) {
          toCompress.push(entry)
        } else {
          toKeep.push(entry)
        }
      }

      if (toCompress.length === 0) {
        return { compressed: 0, summariesCreated: 0 }
      }

      // Group by day for summarization
      const byDay = {}
      for (const entry of toCompress) {
        const day = entry.timestamp.split('T')[0]
        if (!byDay[day]) byDay[day] = []
        byDay[day].push(entry)
      }

      // Create summaries for each day
      let summariesCreated = 0
      for (const [day, entries] of Object.entries(byDay)) {
        const summary = this.summarizeDay(entries, maxSummaryLength)
        summaries.push({
          date: day,
          summary,
          entryCount: entries.length,
          topics: this.extractTopics(entries),
          createdAt: new Date().toISOString()
        })
        summariesCreated++
      }

      // Save compressed state
      localStorage.setItem(episodicKey, JSON.stringify(toKeep))
      localStorage.setItem(summaryKey, JSON.stringify(summaries))

      return { compressed: toCompress.length, summariesCreated }
    } catch (e) {
      return { compressed: 0, summariesCreated: 0, error: e.message }
    }
  }

  /**
   * Summarize a day's worth of entries
   */
  summarizeDay(entries, maxLength = 200) {
    if (!entries || entries.length === 0) return ''

    // Extract key information
    const queries = entries.map(e => e.query).filter(Boolean)
    const agents = [...new Set(entries.map(e => e.agent).filter(Boolean))]

    // Find most common words (excluding stop words)
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'or', 'and', 'not', 'this', 'that', 'it', 'what', 'how', 'when', 'where', 'why', 'which', 'who', 'can', 'you', 'me', 'my', 'your', 'i'])

    const wordCounts = {}
    for (const query of queries) {
      const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w))
      for (const word of words) {
        wordCounts[word] = (wordCounts[word] || 0) + 1
      }
    }

    const topWords = Object.entries(wordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word)

    // Build summary
    const parts = []
    parts.push(`${entries.length} interactions`)

    if (agents.length > 0) {
      parts.push(`with ${agents.join(', ')}`)
    }

    if (topWords.length > 0) {
      parts.push(`about ${topWords.join(', ')}`)
    }

    const summary = parts.join(' ')
    return summary.length > maxLength ? summary.substring(0, maxLength - 3) + '...' : summary
  }

  /**
   * Extract topics from entries
   */
  extractTopics(entries) {
    const topics = {}
    const intents = this.getRunbookIntents()

    for (const entry of entries) {
      const query = (entry.query || '').toLowerCase()

      // Check against runbook intents
      for (const [intent, config] of Object.entries(intents)) {
        if (config.patterns.some(p => query.includes(p))) {
          topics[intent] = (topics[intent] || 0) + 1
        }
      }

      // Extract entity types mentioned
      const entities = this.extractEntities(entry.query || '')
      for (const entity of entities) {
        const key = `entity:${entity.type}`
        topics[key] = (topics[key] || 0) + 1
      }
    }

    return Object.entries(topics)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic]) => topic)
  }

  /**
   * Get episodic summaries
   */
  getEpisodicSummaries() {
    try {
      const data = localStorage.getItem('quox_episodic_summaries')
      return data ? JSON.parse(data) : []
    } catch (e) {
      return []
    }
  }

  /**
   * Get compression statistics
   */
  getCompressionStats() {
    const episodic = this.getRecentEvents(1000)
    const summaries = this.getEpisodicSummaries()

    const episodicSize = JSON.stringify(episodic).length
    const summarySize = JSON.stringify(summaries).length

    let totalSummarizedEntries = 0
    for (const summary of summaries) {
      totalSummarizedEntries += summary.entryCount || 0
    }

    // Estimate original size of summarized entries (average 500 bytes per entry)
    const estimatedOriginalSize = totalSummarizedEntries * 500

    return {
      currentEpisodicEntries: episodic.length,
      summaryCount: summaries.length,
      totalSummarizedEntries,
      currentStorageBytes: episodicSize + summarySize,
      estimatedSavings: Math.max(0, estimatedOriginalSize - summarySize),
      compressionRatio: estimatedOriginalSize > 0 ? (summarySize / estimatedOriginalSize).toFixed(2) : 1
    }
  }

  /**
   * Auto-compress if needed (called during maintenance)
   */
  autoCompress(threshold = 500) {
    const episodic = this.getRecentEvents(1000)

    if (episodic.length > threshold) {
      return this.compressEpisodicMemories()
    }

    return { compressed: 0, summariesCreated: 0, reason: 'threshold_not_met' }
  }

  /**
   * Extract key facts from a conversation for permanent storage
   */
  extractKeyFacts(query, response) {
    const facts = []

    // Look for declarative statements in response
    const sentences = response.split(/[.!?]+/).filter(s => s.trim().length > 10)

    for (const sentence of sentences) {
      const trimmed = sentence.trim()

      // Skip questions
      if (trimmed.includes('?')) continue

      // Look for factual patterns
      const factPatterns = [
        /(?:is|are|was|were)\s+(?:located|running|configured|set|using)/i,
        /(?:runs|uses|requires|needs|has)\s+/i,
        /(?:port|ip|address|version|path)\s*(?:is|:)\s*/i,
        /(?:default|always|never|typically)\s+/i
      ]

      for (const pattern of factPatterns) {
        if (pattern.test(trimmed) && trimmed.length < 200) {
          facts.push({
            content: trimmed,
            source: 'extracted',
            confidence: 0.6
          })
          break
        }
      }
    }

    return facts.slice(0, 3) // Limit to 3 facts per interaction
  }

  /**
   * Store extracted facts as learned items
   */
  storeExtractedFacts(query, response) {
    const facts = this.extractKeyFacts(query, response)
    let stored = 0

    for (const fact of facts) {
      // Check for duplicates
      const existing = this.getLearnedItemsByType('fact')
      const isDuplicate = existing.some(e =>
        this.calculateTextSimilarity(
          e.content || '',
          fact.content
        ) > 0.7
      )

      if (!isDuplicate) {
        this.addLearnedItem('fact', {
          content: fact.content,
          source: 'auto_extracted',
          extractedFrom: query.substring(0, 50),
          confidence: fact.confidence
        })
        stored++
      }
    }

    return stored
  }

  // ============================================
  // Context Window Optimization
  // ============================================

  /**
   * Optimize context selection with a token budget
   */
  optimizeContext(query, budget = 4000) {
    const context = {
      profile: null,
      preferences: [],
      recentContext: [],
      learnedItems: [],
      entities: [],
      reflections: [],
      summaries: []
    }

    let usedTokens = 0
    const estimateTokens = (text) => Math.ceil((text || '').length / 4)

    // Priority 1: Profile (most important, always include)
    const profile = this.getProfile()
    const profileTokens = estimateTokens(JSON.stringify(profile))
    if (profileTokens < budget * 0.1) {
      context.profile = profile
      usedTokens += profileTokens
    }

    // Priority 2: Query-relevant learned items
    const learnedMemories = this.getLearnedMemories(query)
    // Flatten the object (facts, preferences, etc.) into a single array
    const learnedItems = [
      ...(learnedMemories.facts || []),
      ...(learnedMemories.preferences || []),
      ...(learnedMemories.decisions || []),
      ...(learnedMemories.constraints || []),
      ...(learnedMemories.errors || [])
    ]
    for (const item of learnedItems.slice(0, 10)) {
      const itemTokens = estimateTokens(item.content)
      if (usedTokens + itemTokens < budget * 0.4) {
        context.learnedItems.push(item)
        usedTokens += itemTokens
      }
    }

    // Priority 3: Related entities
    const relatedEntities = this.suggestRelatedEntities(query, 5)
    for (const { entity } of relatedEntities) {
      const entityTokens = estimateTokens(JSON.stringify(entity))
      if (usedTokens + entityTokens < budget * 0.5) {
        context.entities.push(entity)
        usedTokens += entityTokens
      }
    }

    // Priority 4: Relevant reflections
    const reflections = this.getRelevantReflections(query, 3)
    for (const reflection of reflections) {
      const refTokens = estimateTokens(reflection.content)
      if (usedTokens + refTokens < budget * 0.6) {
        context.reflections.push(reflection)
        usedTokens += refTokens
      }
    }

    // Priority 5: Recent context (conversation continuity)
    const recentEvents = this.getRecentEvents(10)
    for (const event of recentEvents.slice(0, 5)) {
      const eventTokens = estimateTokens(event.query + event.response)
      if (usedTokens + eventTokens < budget * 0.8) {
        context.recentContext.push({
          query: event.query?.substring(0, 100),
          summary: event.response?.substring(0, 150)
        })
        usedTokens += eventTokens
      }
    }

    // Priority 6: Historical summaries (if space allows)
    const summaries = this.getEpisodicSummaries().slice(-5)
    for (const summary of summaries) {
      const summaryTokens = estimateTokens(summary.summary)
      if (usedTokens + summaryTokens < budget * 0.9) {
        context.summaries.push(summary)
        usedTokens += summaryTokens
      }
    }

    return {
      context,
      usedTokens,
      budget,
      utilizationPercent: ((usedTokens / budget) * 100).toFixed(1)
    }
  }

  /**
   * Format optimized context for prompt injection
   */
  formatOptimizedContext(optimizedContext) {
    const parts = []
    const ctx = optimizedContext.context

    // Profile
    if (ctx.profile?.name) {
      parts.push(`User: ${ctx.profile.name}`)
    }

    // Learned items
    if (ctx.learnedItems?.length > 0) {
      parts.push('\nRelevant knowledge:')
      for (const item of ctx.learnedItems.slice(0, 5)) {
        parts.push(`- ${item.content?.substring(0, 100)}`)
      }
    }

    // Entities
    if (ctx.entities?.length > 0) {
      parts.push('\nRelated entities:')
      for (const entity of ctx.entities.slice(0, 3)) {
        parts.push(`- ${entity.type}: ${entity.name}`)
      }
    }

    // Reflections
    if (ctx.reflections?.length > 0) {
      parts.push('\nInsights:')
      for (const ref of ctx.reflections.slice(0, 2)) {
        parts.push(`- ${ref.content?.substring(0, 80)}`)
      }
    }

    // Recent context
    if (ctx.recentContext?.length > 0) {
      parts.push('\nRecent conversation:')
      for (const recent of ctx.recentContext.slice(0, 3)) {
        parts.push(`Q: ${recent.query}`)
      }
    }

    return parts.join('\n')
  }

  /**
   * Get context utilization metrics
   */
  getContextMetrics(query) {
    const optimized = this.optimizeContext(query)

    return {
      utilizationPercent: optimized.utilizationPercent,
      usedTokens: optimized.usedTokens,
      budget: optimized.budget,
      breakdown: {
        profile: optimized.context.profile ? 1 : 0,
        learnedItems: optimized.context.learnedItems.length,
        entities: optimized.context.entities.length,
        reflections: optimized.context.reflections.length,
        recentContext: optimized.context.recentContext.length,
        summaries: optimized.context.summaries.length
      }
    }
  }

  // ============================================
  // Learning from Feedback
  // ============================================

  /**
   * Record feedback on a memory/retrieval result
   */
  recordMemoryFeedback(memoryId, useful, context = {}) {
    try {
      const key = 'quox_memory_feedback'
      const data = localStorage.getItem(key)
      const feedback = data ? JSON.parse(data) : []

      feedback.push({
        memoryId,
        useful,
        timestamp: new Date().toISOString(),
        query: context.query,
        memoryType: context.type
      })

      // Keep last 500 feedback entries
      const trimmed = feedback.slice(-500)
      localStorage.setItem(key, JSON.stringify(trimmed))

      // Update memory importance based on feedback
      this.updateMemoryImportance(memoryId, useful)

      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Update memory importance based on feedback
   */
  updateMemoryImportance(memoryId, useful) {
    try {
      // Try to find and update the memory
      for (const type of MEMORY_TYPES_LOCAL) {
        const items = this.getLearnedItemsByType(type)
        const itemIndex = items.findIndex(i => i.id === memoryId)

        if (itemIndex >= 0) {
          const item = items[itemIndex]
          const currentImportance = item.importance || 0.5

          // Adjust importance: +0.1 if useful, -0.05 if not
          const adjustment = useful ? 0.1 : -0.05
          const newImportance = Math.max(0.1, Math.min(1.0, currentImportance + adjustment))

          item.importance = newImportance
          item.feedbackCount = (item.feedbackCount || 0) + 1
          item.lastFeedback = new Date().toISOString()

          // Save updated items
          const key = `quox_learned_${type}`
          localStorage.setItem(key, JSON.stringify(items))
          logMemoryUpdated(memoryId, useful)
          return true
        }
      }
      return false
    } catch (e) {
      return false
    }
  }

  /**
   * Get memory feedback statistics
   */
  getMemoryFeedbackStats() {
    try {
      const data = localStorage.getItem('quox_memory_feedback')
      const feedback = data ? JSON.parse(data) : []

      const byType = {}
      let totalUseful = 0
      let totalNotUseful = 0

      for (const f of feedback) {
        const type = f.memoryType || 'unknown'
        if (!byType[type]) {
          byType[type] = { useful: 0, notUseful: 0 }
        }

        if (f.useful) {
          byType[type].useful++
          totalUseful++
        } else {
          byType[type].notUseful++
          totalNotUseful++
        }
      }

      return {
        totalFeedback: feedback.length,
        totalUseful,
        totalNotUseful,
        usefulnessRate: feedback.length > 0 ? (totalUseful / feedback.length).toFixed(2) : 0,
        byType
      }
    } catch (e) {
      return { totalFeedback: 0, totalUseful: 0, totalNotUseful: 0, usefulnessRate: 0, byType: {} }
    }
  }

  /**
   * Get memories sorted by feedback-adjusted importance
   */
  getMemoriesByImportance(type, limit = 20) {
    const items = this.getLearnedItemsByType(type)

    return items
      .map(item => ({
        ...item,
        effectiveImportance: this.calculateEffectiveImportance(item)
      }))
      .sort((a, b) => b.effectiveImportance - a.effectiveImportance)
      .slice(0, limit)
  }

  /**
   * Calculate effective importance based on multiple factors
   */
  calculateEffectiveImportance(item) {
    const baseImportance = item.importance || 0.5
    const feedbackCount = item.feedbackCount || 0

    // More feedback = more confidence in the importance
    const confidenceBoost = Math.min(0.2, feedbackCount * 0.02)

    // Recency factor
    const lastAccess = new Date(item.lastFeedback || item.timestamp || 0)
    const daysSince = (Date.now() - lastAccess) / (1000 * 60 * 60 * 24)
    const recencyFactor = Math.exp(-daysSince / 30) // Decay over 30 days

    return (baseImportance + confidenceBoost) * (0.7 + 0.3 * recencyFactor)
  }

  /**
   * Prune low-importance memories
   */
  pruneLowImportanceMemories(threshold = 0.2, dryRun = true) {
    const toPrune = []

    for (const type of MEMORY_TYPES_LOCAL) {
      const items = this.getLearnedItemsByType(type)

      for (const item of items) {
        const importance = this.calculateEffectiveImportance(item)
        if (importance < threshold && (item.feedbackCount || 0) >= 3) {
          toPrune.push({ type, item, importance })
        }
      }
    }

    if (!dryRun) {
      for (const { type, item } of toPrune) {
        const items = this.getLearnedItemsByType(type)
        const filtered = items.filter(i => i.id !== item.id)
        localStorage.setItem(`quox_learned_${type}`, JSON.stringify(filtered))
      }
    }

    return {
      found: toPrune.length,
      pruned: dryRun ? 0 : toPrune.length,
      dryRun,
      items: toPrune.map(p => ({ type: p.type, id: p.item.id, importance: p.importance }))
    }
  }

  /**
   * Get learning statistics
   */
  getLearningStats() {
    const feedbackStats = this.getMemoryFeedbackStats()
    const suggestionStats = this.getSuggestionStats()

    // Calculate improvements over time
    const recentFeedback = []
    try {
      const data = localStorage.getItem('quox_memory_feedback')
      const feedback = data ? JSON.parse(data) : []
      const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

      for (const f of feedback) {
        if (new Date(f.timestamp) > oneWeekAgo) {
          recentFeedback.push(f)
        }
      }
    } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }

    const recentUseful = recentFeedback.filter(f => f.useful).length
    const recentRate = recentFeedback.length > 0 ? (recentUseful / recentFeedback.length) : 0

    return {
      memoryFeedback: feedbackStats,
      suggestionFeedback: suggestionStats,
      recentWeek: {
        feedbackCount: recentFeedback.length,
        usefulnessRate: recentRate.toFixed(2)
      },
      isImproving: recentRate > parseFloat(feedbackStats.usefulnessRate)
    }
  }

  /**
   * Simple BM25-inspired scoring
   * Considers term frequency and document length
   */
  calculateBM25Score(queryTerms, content) {
    if (!content) return 0

    const words = content.split(/\s+/)
    const docLength = words.length
    const avgDocLength = 100 // Approximate average
    const k1 = 1.2
    const b = 0.75

    let score = 0
    for (const term of queryTerms) {
      const termFreq = (content.match(new RegExp(term, 'gi')) || []).length
      if (termFreq > 0) {
        // Simplified BM25 formula
        const idf = Math.log(1 + 1) // Simplified - would need corpus stats for real IDF
        const tf = (termFreq * (k1 + 1)) / (termFreq + k1 * (1 - b + b * (docLength / avgDocLength)))
        score += idf * tf
      }
    }

    // Bonus for exact phrase match
    if (content.includes(queryTerms.join(' '))) {
      score *= 1.5
    }

    return score
  }

  /**
   * Calculate text similarity using Jaccard index of word sets
   */
  calculateTextSimilarity(text1, text2) {
    if (!text1 || !text2) return 0

    const normalize = (text) =>
      text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2)

    const words1 = new Set(normalize(text1))
    const words2 = new Set(normalize(text2))

    if (words1.size === 0 || words2.size === 0) return 0

    const intersection = new Set([...words1].filter(w => words2.has(w)))
    const union = new Set([...words1, ...words2])

    return intersection.size / union.size
  }

  /**
   * Find duplicate or near-duplicate memories
   * Returns pairs of similar memories with their similarity scores
   */
  findDuplicateMemories(threshold = 0.6) {
    const duplicates = []

    for (const type of MEMORY_TYPES_LOCAL) {
      const items = this.getLearnedItemsByType(type)

      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const similarity = this.calculateTextSimilarity(
            items[i].content,
            items[j].content
          )

          if (similarity >= threshold) {
            duplicates.push({
              type,
              item1: items[i],
              item2: items[j],
              similarity
            })
          }
        }
      }
    }

    return duplicates.sort((a, b) => b.similarity - a.similarity)
  }

  /**
   * Consolidate duplicate memories
   * Merges near-duplicates, keeping the best version
   * Returns { merged: count, removed: count }
   */
  consolidateMemories(threshold = 0.6) {
    const stats = { merged: 0, removed: 0 }
    const duplicates = this.findDuplicateMemories(threshold)

    // Group duplicates by type
    const byType = {}
    for (const dup of duplicates) {
      if (!byType[dup.type]) byType[dup.type] = []
      byType[dup.type].push(dup)
    }

    // Process each type
    for (const type of Object.keys(byType)) {
      const key = `quox_learned_${type}`
      const data = localStorage.getItem(key)
      if (!data) continue

      let items = JSON.parse(data)
      const toRemove = new Set()

      for (const dup of byType[type]) {
        // Skip if either item already marked for removal
        if (toRemove.has(dup.item1.id) || toRemove.has(dup.item2.id)) continue

        // Determine which to keep (higher salience, or newer if equal)
        const score1 = (dup.item1.salience || 0.5) + (dup.item1.accessCount || 0) * 0.1
        const score2 = (dup.item2.salience || 0.5) + (dup.item2.accessCount || 0) * 0.1

        let keep, remove
        if (score1 > score2) {
          keep = dup.item1
          remove = dup.item2
        } else if (score2 > score1) {
          keep = dup.item2
          remove = dup.item1
        } else {
          // Equal scores - keep newer
          const time1 = new Date(dup.item1.learnedAt || 0).getTime()
          const time2 = new Date(dup.item2.learnedAt || 0).getTime()
          if (time1 > time2) {
            keep = dup.item1
            remove = dup.item2
          } else {
            keep = dup.item2
            remove = dup.item1
          }
        }

        // Mark for removal and update keep with merged access count
        toRemove.add(remove.id)
        const keepIndex = items.findIndex(i => i.id === keep.id)
        if (keepIndex !== -1) {
          items[keepIndex].accessCount = (items[keepIndex].accessCount || 0) + (remove.accessCount || 0)
          items[keepIndex].consolidatedFrom = items[keepIndex].consolidatedFrom || []
          items[keepIndex].consolidatedFrom.push(remove.id)
          stats.merged++
        }
        stats.removed++
      }

      // Remove duplicates
      items = items.filter(i => !toRemove.has(i.id))
      localStorage.setItem(key, JSON.stringify(items))
    }

    return stats
  }

  /**
   * Detect potential contradictions in memories
   * Returns pairs of memories that may conflict
   */
  detectContradictions() {
    const contradictions = []

    // Contradiction patterns
    const opposites = [
      { pos: /\balways\b/i, neg: /\bnever\b/i },
      { pos: /\bprefer\b/i, neg: /\bavoid\b/i },
      { pos: /\buse\b/i, neg: /\bdon't use\b/i },
      { pos: /\benable\b/i, neg: /\bdisable\b/i },
      { pos: /\ballow\b/i, neg: /\bblock\b/i },
      { pos: /\bis\b/i, neg: /\bisn't\b|\bis not\b/i },
    ]

    for (const type of MEMORY_TYPES_LOCAL) {
      const items = this.getLearnedItemsByType(type)

      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const content1 = items[i].content || ''
          const content2 = items[j].content || ''

          // Check if topics overlap (some word similarity)
          const similarity = this.calculateTextSimilarity(content1, content2)
          if (similarity < 0.2) continue // Topics too different

          // Check for opposite patterns
          for (const { pos, neg } of opposites) {
            if ((pos.test(content1) && neg.test(content2)) ||
                (neg.test(content1) && pos.test(content2))) {
              contradictions.push({
                type,
                item1: items[i],
                item2: items[j],
                similarity,
                reason: 'Opposite sentiment patterns detected'
              })
              break
            }
          }
        }
      }
    }

    // Also check constraints vs decisions
    const constraints = this.getLearnedItemsByType('constraint')
    const decisions = this.getLearnedItemsByType('decision')

    for (const constraint of constraints) {
      for (const decision of decisions) {
        const similarity = this.calculateTextSimilarity(
          constraint.content,
          decision.content
        )

        if (similarity > 0.3) {
          // Topics overlap - might be a conflict
          const constraintLower = (constraint.content || '').toLowerCase()
          const decisionLower = (decision.content || '').toLowerCase()

          // Extract key action words
          const constraintWords = constraintLower.match(/\b(never|don't|avoid|must not)\s+(\w+)/i)
          const decisionWords = decisionLower.match(/\b(will|going to|decided to|let's)\s+(\w+)/i)

          if (constraintWords && decisionWords) {
            // Check if the action word in decision appears in constraint's prohibited action
            if (constraintLower.includes(decisionWords[2])) {
              contradictions.push({
                type: 'constraint-decision',
                item1: constraint,
                item2: decision,
                similarity,
                reason: 'Decision may violate a constraint'
              })
            }
          }
        }
      }
    }

    return contradictions
  }

  /**
   * Get consolidation report without making changes
   */
  getConsolidationReport(threshold = 0.6) {
    const duplicates = this.findDuplicateMemories(threshold)
    const contradictions = this.detectContradictions()

    return {
      duplicates: duplicates.length,
      duplicateDetails: duplicates.slice(0, 10), // Top 10
      contradictions: contradictions.length,
      contradictionDetails: contradictions,
      recommendation: duplicates.length > 5
        ? 'Consider running consolidateMemories() to merge duplicates'
        : contradictions.length > 0
          ? 'Review contradictions to ensure memory consistency'
          : 'Memory is in good shape'
    }
  }

  /**
   * Get learned memories (preferences, facts, decisions, constraints, errors)
   * Optionally filter by relevance to query
   */
  getLearnedMemories(query = null, maxPerType = 5) {
    const result = {
      preferences: [],
      facts: [],
      decisions: [],
      constraints: [],
      errors: []
    }

    for (const type of MEMORY_TYPES_LOCAL) {
      try {
        const key = `quox_learned_${type}`
        const data = localStorage.getItem(key)
        if (!data) continue

        let items = JSON.parse(data)

        // If query provided, filter by relevance
        if (query) {
          const queryLower = query.toLowerCase()
          const queryWords = queryLower.split(/\s+/).filter(w => w.length > 3)

          items = items
            .map(item => {
              const content = (item.content || '').toLowerCase()
              const matchScore = queryWords.reduce((score, word) =>
                score + (content.includes(word) ? 1 : 0), 0)
              return { ...item, matchScore }
            })
            .filter(item => item.matchScore > 0 || item.salience > 0.8)
            .sort((a, b) => b.matchScore - a.matchScore || b.salience - a.salience)
        } else {
          // Sort by salience and recency
          items.sort((a, b) =>
            (b.salience || 0.5) - (a.salience || 0.5) ||
            new Date(b.timestamp || 0) - new Date(a.timestamp || 0)
          )
        }

        // Track access for decay scoring
        const retrieved = items.slice(0, maxPerType)
        for (const item of retrieved) {
          this.trackAccess(type, item.content)
        }

        result[`${type}s`] = retrieved
      } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }
    }

    return result
  }

  /**
   * Get user profile from localStorage/memory
   */
  getProfile() {
    try {
      const stored = localStorage.getItem('quox_profile')
      if (stored) return JSON.parse(stored)
    } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }

    return {
      name: null,
      preferences: {
        verbosity: 'concise',
        confirmDestructive: true
      }
    }
  }

  /**
   * Save user profile
   */
  saveProfile(profile) {
    const record = {
      ...profile,
      updated_at: new Date().toISOString()
    }
    localStorage.setItem('quox_profile', JSON.stringify(record))
    this._identityWriteThrough('profile', record)
  }

  /**
   * Get preference categories schema
   */
  getPreferenceCategories() {
    return PREFERENCE_CATEGORIES
  }

  /**
   * Get a specific preference value
   */
  getPreference(category, field) {
    const profile = this.getProfile()
    const categoryData = profile.preferences?.[category]
    if (categoryData && field in categoryData) {
      return categoryData[field]
    }
    // Return default from schema
    return PREFERENCE_CATEGORIES[category]?.fields[field]?.default ?? null
  }

  /**
   * Set a specific preference value
   * TIERED: Free version limited to 3 preferences
   */
  setPreference(category, field, value) {
    const profile = this.getProfile()

    // Validate category exists
    if (!PREFERENCE_CATEGORIES[category]) {
      console.warn(`Unknown preference category: ${category}`)
      return false
    }

    // Validate field exists in category
    if (!PREFERENCE_CATEGORIES[category].fields[field]) {
      console.warn(`Unknown field ${field} in category ${category}`)
      return false
    }

    // Initialize nested structure if needed
    if (!profile.preferences) profile.preferences = {}
    if (!profile.preferences[category]) profile.preferences[category] = {}

    // TIER CHECK: Count existing preferences (only check if this is a new preference)
    const isNewPreference = profile.preferences[category][field] === undefined
    if (isNewPreference) {
      let totalPreferences = 0
      for (const cat of Object.values(profile.preferences || {})) {
        if (typeof cat === 'object' && cat !== null) {
          totalPreferences += Object.keys(cat).filter(k => cat[k] !== undefined).length
        }
      }

      const tierCheck = checkLimit('preferences', totalPreferences)
      if (!tierCheck.allowed) {
        console.warn('[Memory] Free version preference limit reached. Purchase Advanced Memory Plugin for unlimited preferences.')
        return {
          success: false,
          blocked: true,
          reason: 'tier_limit',
          upgrade: createUpgradePrompt('preferences'),
          current: totalPreferences,
          limit: tierCheck.limit
        }
      }
    }

    profile.preferences[category][field] = value
    this.saveProfile(profile)
    return true
  }

  /**
   * Get all preferences for a category
   */
  getCategoryPreferences(category) {
    const profile = this.getProfile()
    const schema = PREFERENCE_CATEGORIES[category]
    if (!schema) return null

    const result = {}
    for (const [field, config] of Object.entries(schema.fields)) {
      result[field] = profile.preferences?.[category]?.[field] ?? config.default
    }
    return result
  }

  /**
   * Set multiple preferences at once
   */
  setPreferences(updates) {
    const profile = this.getProfile()
    if (!profile.preferences) profile.preferences = {}

    for (const [category, fields] of Object.entries(updates)) {
      if (!PREFERENCE_CATEGORIES[category]) continue
      if (!profile.preferences[category]) profile.preferences[category] = {}

      for (const [field, value] of Object.entries(fields)) {
        if (PREFERENCE_CATEGORIES[category].fields[field]) {
          profile.preferences[category][field] = value
        }
      }
    }

    this.saveProfile(profile)
    return true
  }

  /**
   * Get all preferences with defaults filled in
   */
  getAllPreferences() {
    const result = {}
    for (const category of Object.keys(PREFERENCE_CATEGORIES)) {
      result[category] = this.getCategoryPreferences(category)
    }
    return result
  }

  /**
   * Get recent events from episodic log
   */
  getRecentEvents(count = 5) {
    try {
      const recent = localStorage.getItem('episodic_recent') || ''
      const lines = recent.split('\n').filter(Boolean)
      return lines.slice(-count).map(line => {
        try {
          return JSON.parse(line)
        } catch (e) {
          return null
        }
      }).filter(Boolean)
    } catch (e) {
      return []
    }
  }

  /**
   * Get relevant projects based on query
   */
  getRelevantProjects(query) {
    try {
      const stored = localStorage.getItem('quox_projects')
      if (!stored) return []

      const projects = JSON.parse(stored)
      const queryLower = query.toLowerCase()

      // Simple keyword matching
      return projects.filter(p => {
        const content = `${p.name} ${p.description || ''} ${(p.keywords || []).join(' ')}`.toLowerCase()
        return queryLower.split(/\s+/).some(word =>
          word.length > 3 && content.includes(word)
        )
      }).slice(0, 3)
    } catch (e) {
      return []
    }
  }

  /**
   * Get all projects
   */
  getAllProjects() {
    try {
      const stored = localStorage.getItem('quox_projects')
      return stored ? JSON.parse(stored) : []
    } catch (e) {
      return []
    }
  }

  /**
   * Get agent-specific memory
   */
  getAgentMemory(agentId) {
    try {
      const stored = localStorage.getItem(`quox_agent_${agentId}`)
      const memory = stored ? JSON.parse(stored) : null

      if (!memory) {
        // Return default agent memory structure
        return {
          agentId,
          domains: AGENT_DOMAINS[agentId]?.domains || [],
          learnedItems: [],
          interactionCount: 0,
          lastActive: null,
          expertise: {}
        }
      }

      return memory
    } catch (e) {
      return null
    }
  }

  /**
   * Save agent-specific memory
   */
  saveAgentMemory(agentId, memory) {
    localStorage.setItem(`quox_agent_${agentId}`, JSON.stringify({
      ...memory,
      agentId,
      updated_at: new Date().toISOString()
    }))
  }

  /**
   * Get agent domain configuration
   */
  getAgentDomains(agentId) {
    return AGENT_DOMAINS[agentId] || null
  }

  /**
   * Get all agent domains
   */
  getAllAgentDomains() {
    return AGENT_DOMAINS
  }

  /**
   * Record an agent interaction and update agent memory
   */
  recordAgentInteraction(agentId, query, response, metadata = {}) {
    const memory = this.getAgentMemory(agentId) || {
      agentId,
      domains: AGENT_DOMAINS[agentId]?.domains || [],
      learnedItems: [],
      interactionCount: 0,
      lastActive: null,
      expertise: {}
    }

    // Update interaction count
    memory.interactionCount = (memory.interactionCount || 0) + 1
    memory.lastActive = new Date().toISOString()

    // Track expertise areas based on query keywords
    const agentConfig = AGENT_DOMAINS[agentId]
    if (agentConfig) {
      const queryLower = query.toLowerCase()
      for (const keyword of agentConfig.keywords) {
        if (queryLower.includes(keyword)) {
          memory.expertise[keyword] = (memory.expertise[keyword] || 0) + 1
        }
      }
    }

    // Track recent topics
    if (!memory.recentTopics) memory.recentTopics = []
    memory.recentTopics.unshift({
      query: query.substring(0, 100),
      timestamp: new Date().toISOString(),
      ...metadata
    })
    memory.recentTopics = memory.recentTopics.slice(0, 20) // Keep last 20

    this.saveAgentMemory(agentId, memory)
    return memory
  }

  /**
   * Add a learned item to a specific agent's memory
   */
  addAgentLearnedItem(agentId, item) {
    const memory = this.getAgentMemory(agentId)
    if (!memory.learnedItems) memory.learnedItems = []

    memory.learnedItems.push({
      ...item,
      id: item.id || `${agentId}_${Date.now()}`,
      learnedAt: new Date().toISOString()
    })

    // Keep last 50 per agent
    memory.learnedItems = memory.learnedItems.slice(-50)
    this.saveAgentMemory(agentId, memory)
    return true
  }

  /**
   * Get agent's learned items, optionally filtered by query
   */
  getAgentLearnedItems(agentId, query = null, limit = 10) {
    const memory = this.getAgentMemory(agentId)
    if (!memory?.learnedItems) return []

    let items = [...memory.learnedItems]

    if (query) {
      const queryLower = query.toLowerCase()
      const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2)

      items = items
        .map(item => {
          const content = (item.content || '').toLowerCase()
          const matchScore = queryWords.reduce((score, word) =>
            score + (content.includes(word) ? 1 : 0), 0)
          return { ...item, matchScore }
        })
        .filter(item => item.matchScore > 0)
        .sort((a, b) => b.matchScore - a.matchScore)
    }

    return items.slice(0, limit)
  }

  /**
   * Get the best agent for a query based on domain matching
   */
  suggestAgentForQuery(query) {
    const queryLower = query.toLowerCase()
    const scores = {}

    for (const [agentId, config] of Object.entries(AGENT_DOMAINS)) {
      let score = 0

      // Check keyword matches
      for (const keyword of config.keywords) {
        if (queryLower.includes(keyword)) {
          score += 2
        }
      }

      // Check domain matches
      for (const domain of config.domains) {
        if (queryLower.includes(domain)) {
          score += 1
        }
      }

      if (score > 0) {
        scores[agentId] = { agentId, name: config.name, score }
      }
    }

    // Sort by score and return top matches
    const ranked = Object.values(scores).sort((a, b) => b.score - a.score)

    if (ranked.length === 0) {
      // Default to quox for general queries
      return { agentId: 'quox', name: 'Quox', score: 0, isDefault: true }
    }

    return ranked[0]
  }

  /**
   * Get agent statistics across all agents
   */
  getAgentStats() {
    const stats = {
      agents: {},
      totalInteractions: 0,
      mostActive: null,
      expertiseBreakdown: {}
    }

    for (const agentId of Object.keys(AGENT_DOMAINS)) {
      const memory = this.getAgentMemory(agentId)
      const interactionCount = memory?.interactionCount || 0

      stats.agents[agentId] = {
        name: AGENT_DOMAINS[agentId].name,
        interactionCount,
        learnedItems: memory?.learnedItems?.length || 0,
        lastActive: memory?.lastActive,
        topExpertise: this.getTopExpertise(memory?.expertise || {}, 3)
      }

      stats.totalInteractions += interactionCount

      if (!stats.mostActive || interactionCount > stats.agents[stats.mostActive].interactionCount) {
        stats.mostActive = agentId
      }

      // Aggregate expertise
      for (const [keyword, count] of Object.entries(memory?.expertise || {})) {
        stats.expertiseBreakdown[keyword] = (stats.expertiseBreakdown[keyword] || 0) + count
      }
    }

    return stats
  }

  /**
   * Get top N expertise areas from expertise object
   */
  getTopExpertise(expertise, n = 5) {
    return Object.entries(expertise)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([keyword, count]) => ({ keyword, count }))
  }

  /**
   * Clear agent-specific memory
   */
  clearAgentMemory(agentId) {
    localStorage.removeItem(`quox_agent_${agentId}`)
  }

  /**
   * Clear all agent memories
   */
  clearAllAgentMemories() {
    for (const agentId of Object.keys(AGENT_DOMAINS)) {
      this.clearAgentMemory(agentId)
    }
  }

  // ========================================
  // REFLECTION LOOPS - Self-Improvement
  // ========================================

  /**
   * Get reflection state (tracks when to trigger reflection)
   */
  getReflectionState() {
    try {
      const stored = localStorage.getItem('quox_reflection_state')
      if (stored) return JSON.parse(stored)
    } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }

    return {
      totalInteractions: 0,
      lastReflectionAt: 0,
      reflectionsThisSession: 0,
      sessionStart: Date.now()
    }
  }

  /**
   * Save reflection state
   */
  saveReflectionState(state) {
    const record = {
      ...state,
      updated_at: Date.now()
    }
    localStorage.setItem('quox_reflection_state', JSON.stringify(record))
    this._identityWriteThrough('reflection_state', record)
  }

  /**
   * Check if it's time to trigger a reflection
   */
  shouldReflect() {
    const state = this.getReflectionState()
    const { minInteractionsForReflection, reflectionInterval, maxReflectionsPerSession } = REFLECTION_CONFIG

    // Don't reflect if we haven't had enough interactions
    if (state.totalInteractions < minInteractionsForReflection) return false

    // Don't over-reflect in a single session
    if (state.reflectionsThisSession >= maxReflectionsPerSession) return false

    // Check if enough interactions since last reflection
    const interactionsSinceReflection = state.totalInteractions - state.lastReflectionAt
    return interactionsSinceReflection >= reflectionInterval
  }

  /**
   * Increment interaction count and check for reflection trigger
   */
  trackInteraction() {
    const state = this.getReflectionState()
    state.totalInteractions++
    this.saveReflectionState(state)

    if (this.shouldReflect()) {
      // Trigger async reflection (don't block)
      setTimeout(() => this.performReflection(), 100)
    }
  }

  /**
   * Analyze recent interactions for patterns
   */
  analyzePatterns() {
    const patterns = {
      topics: {},
      errors: [],
      successfulApproaches: [],
      frequentEntities: {},
      timePatterns: { morning: 0, afternoon: 0, evening: 0, night: 0 }
    }

    // Analyze recent episodic memory
    const recentEvents = this.getRecentEvents(50)

    for (const event of recentEvents) {
      if (!event) continue

      const query = (event.query || '').toLowerCase()
      const response = (event.response || '').toLowerCase()
      const timestamp = new Date(event.timestamp || Date.now())

      // Extract topics (significant words)
      const words = query.split(/\s+/).filter(w => w.length > 4)
      for (const word of words) {
        patterns.topics[word] = (patterns.topics[word] || 0) + 1
      }

      // Detect errors in responses
      if (SALIENCE_PATTERNS.error.test(response)) {
        patterns.errors.push({
          query: event.query,
          timestamp: event.timestamp,
          agent: event.agent
        })
      }

      // Track time patterns
      const hour = timestamp.getHours()
      if (hour >= 6 && hour < 12) patterns.timePatterns.morning++
      else if (hour >= 12 && hour < 17) patterns.timePatterns.afternoon++
      else if (hour >= 17 && hour < 21) patterns.timePatterns.evening++
      else patterns.timePatterns.night++
    }

    // Analyze entity usage
    const entities = this.getAllEntities()
    for (const entity of entities) {
      const key = `${entity.type}:${entity.name}`
      patterns.frequentEntities[key] = (patterns.frequentEntities[key] || 0) + (entity.mentionCount || 1)
    }

    // Analyze learned items for successful approaches
    const decisions = this.getLearnedItemsByType('decision')
    for (const decision of decisions.slice(-10)) {
      if (decision.accessCount > 2) {
        patterns.successfulApproaches.push(decision.content)
      }
    }

    return patterns
  }

  /**
   * Generate insights from pattern analysis
   */
  generateInsights(patterns) {
    const insights = []
    const { patternThreshold } = REFLECTION_CONFIG

    // Recurring topics
    const topTopics = Object.entries(patterns.topics)
      .filter(([_, count]) => count >= patternThreshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)

    for (const [topic, count] of topTopics) {
      insights.push({
        category: 'recurring_topic',
        content: `Topic "${topic}" appears frequently (${count} times). Consider creating dedicated knowledge for this area.`,
        confidence: Math.min(0.9, 0.5 + count * 0.1),
        relatedTopic: topic
      })
    }

    // Common errors
    if (patterns.errors.length >= patternThreshold) {
      const errorAgents = {}
      for (const err of patterns.errors) {
        errorAgents[err.agent] = (errorAgents[err.agent] || 0) + 1
      }

      const topErrorAgent = Object.entries(errorAgents).sort((a, b) => b[1] - a[1])[0]
      if (topErrorAgent) {
        insights.push({
          category: 'common_error',
          content: `Agent ${topErrorAgent[0]} encountered ${topErrorAgent[1]} errors recently. May need additional context or training.`,
          confidence: 0.7,
          relatedAgent: topErrorAgent[0]
        })
      }
    }

    // Time pattern insights
    const totalTime = Object.values(patterns.timePatterns).reduce((a, b) => a + b, 0)
    if (totalTime > 10) {
      const peakTime = Object.entries(patterns.timePatterns).sort((a, b) => b[1] - a[1])[0]
      if (peakTime[1] / totalTime > 0.4) {
        insights.push({
          category: 'user_preference',
          content: `User is most active during ${peakTime[0]} (${Math.round(peakTime[1] / totalTime * 100)}% of interactions).`,
          confidence: 0.8,
          relatedPreference: 'active_time'
        })
      }
    }

    // Successful approaches
    for (const approach of patterns.successfulApproaches.slice(0, 3)) {
      insights.push({
        category: 'successful_approach',
        content: `Approach frequently referenced: "${approach.substring(0, 100)}..."`,
        confidence: 0.75
      })
    }

    // Frequent entities (workflow patterns)
    const topEntities = Object.entries(patterns.frequentEntities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)

    if (topEntities.length > 0) {
      insights.push({
        category: 'workflow_pattern',
        content: `Most frequently referenced: ${topEntities.map(([k]) => k.split(':')[1]).join(', ')}`,
        confidence: 0.7
      })
    }

    return insights
  }

  /**
   * Perform a reflection cycle
   */
  performReflection() {
    console.log('[Memory] Performing reflection cycle...')

    const state = this.getReflectionState()

    // Analyze patterns
    const patterns = this.analyzePatterns()

    // Generate insights
    const insights = this.generateInsights(patterns)

    // Store valuable insights as reflections
    let storedCount = 0
    for (const insight of insights) {
      if (insight.confidence >= 0.7) {
        this.addLearnedItem('reflection', {
          content: insight.content,
          category: insight.category,
          confidence: insight.confidence,
          generatedAt: new Date().toISOString(),
          basedOnInteractions: state.totalInteractions,
          metadata: {
            relatedTopic: insight.relatedTopic,
            relatedAgent: insight.relatedAgent,
            relatedPreference: insight.relatedPreference
          }
        })
        storedCount++
      }
    }

    // Update reflection state
    state.lastReflectionAt = state.totalInteractions
    state.reflectionsThisSession++
    this.saveReflectionState(state)

    console.log(`[Memory] Reflection complete. Generated ${insights.length} insights, stored ${storedCount}.`)

    return { insights, stored: storedCount }
  }

  /**
   * Get reflections relevant to a query
   */
  getRelevantReflections(query, limit = 3) {
    const reflections = this.getLearnedItemsByType('reflection')
    if (!reflections.length) return []

    if (!query) {
      // Return most recent high-confidence reflections
      return reflections
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .slice(0, limit)
    }

    const queryLower = query.toLowerCase()
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 3)

    return reflections
      .map(r => {
        const content = (r.content || '').toLowerCase()
        let score = r.confidence || 0.5

        // Boost if query words match
        for (const word of queryWords) {
          if (content.includes(word)) score += 0.2
        }

        // Boost if related topic matches
        if (r.metadata?.relatedTopic && queryLower.includes(r.metadata.relatedTopic)) {
          score += 0.3
        }

        return { ...r, relevanceScore: score }
      })
      .filter(r => r.relevanceScore > 0.5)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit)
  }

  /**
   * Manually trigger reflection (for testing or UI)
   */
  triggerReflection() {
    return this.performReflection()
  }

  /**
   * Get reflection statistics
   */
  getReflectionStats() {
    const state = this.getReflectionState()
    const reflections = this.getLearnedItemsByType('reflection')

    const byCategory = {}
    for (const r of reflections) {
      const cat = r.category || 'unknown'
      byCategory[cat] = (byCategory[cat] || 0) + 1
    }

    return {
      totalInteractions: state.totalInteractions,
      totalReflections: reflections.length,
      lastReflectionAt: state.lastReflectionAt,
      reflectionsThisSession: state.reflectionsThisSession,
      byCategory,
      nextReflectionIn: Math.max(0, REFLECTION_CONFIG.reflectionInterval - (state.totalInteractions - state.lastReflectionAt))
    }
  }

  /**
   * Add a project
   */
  addProject(project) {
    try {
      const stored = localStorage.getItem('quox_projects')
      const projects = stored ? JSON.parse(stored) : []
      projects.push({
        ...project,
        id: project.id || `proj_${Date.now()}`,
        created_at: new Date().toISOString()
      })
      localStorage.setItem('quox_projects', JSON.stringify(projects))
      this._identityWriteThrough('projects', projects)
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Update a project by ID
   */
  updateProject(projectId, updates) {
    try {
      const stored = localStorage.getItem('quox_projects')
      if (!stored) return false

      const projects = JSON.parse(stored)
      const index = projects.findIndex(p => p.id === projectId)
      if (index === -1) return false

      projects[index] = {
        ...projects[index],
        ...updates,
        updated_at: new Date().toISOString()
      }
      localStorage.setItem('quox_projects', JSON.stringify(projects))
      this._identityWriteThrough('projects', projects)
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Delete a project by ID
   */
  deleteProject(projectId) {
    try {
      const stored = localStorage.getItem('quox_projects')
      if (!stored) return false

      const projects = JSON.parse(stored)
      const filtered = projects.filter(p => p.id !== projectId)

      if (filtered.length === projects.length) return false // Not found

      localStorage.setItem('quox_projects', JSON.stringify(filtered))
      this._identityWriteThrough('projects', filtered)
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Get a project by ID
   */
  getProject(projectId) {
    try {
      const projects = this.getAllProjects()
      return projects.find(p => p.id === projectId) || null
    } catch (e) {
      return null
    }
  }

  /**
   * Add a learned item (preference, fact, decision, constraint, error)
   * Now includes provenance, confidence, and conflict tracking
   * TIERED: Free version limited to 10 items
   */
  addLearnedItem(type, item, options = {}) {
    try {
      if (!MEMORY_TYPES_LOCAL.includes(type)) return false

      // SECRET DETECTION: Check for sensitive data
      const secretCheck = detectSecrets(item.content)
      if (secretCheck.hasSecrets) {
        console.warn('[Memory] Blocked storing sensitive data:', secretCheck.types.join(', '))
        // Option 1: Block entirely (safer)
        if (options.blockSecrets !== false) {
          return { blocked: true, reason: 'sensitive_data', types: secretCheck.types }
        }
        // Option 2: Redact and continue (if explicitly allowed)
        item = { ...item, content: redactSecrets(item.content) }
      }

      const key = `quox_learned_${type}`
      const existing = localStorage.getItem(key)
      const items = existing ? JSON.parse(existing) : []

      // TIER CHECK: Enforce free version limit (excludes reflections from count)
      if (type !== 'reflection') {
        const totalLearned = this._getTotalLearnedCount()
        const tierCheck = checkLimit('learned', totalLearned)

        if (!tierCheck.allowed) {
          console.warn('[Memory] Free version limit reached. Purchase Advanced Memory Plugin for unlimited memory.')
          return {
            success: false,
            blocked: true,
            reason: 'tier_limit',
            upgrade: createUpgradePrompt('learnedItems'),
            current: totalLearned,
            limit: tierCheck.limit
          }
        }
      }

      // Determine provenance source
      const provenanceSource = options.source || inferProvenanceSource(
        item.content || '',
        options.explicit || false
      )

      // Determine stability from type or options
      const stability = options.stability || TYPE_STABILITY[type] || 'stable'

      // Calculate initial confidence based on source
      const baseConfidence = options.confidence || TRUTH_PRIORITY[provenanceSource] || 0.7

      // Create the enriched memory item
      const enrichedItem = {
        accessCount: 0,
        ...item,
        id: item.id || `${type}_${Date.now()}`,
        learnedAt: new Date().toISOString(),

        // NEW: Provenance tracking
        provenance: item.provenance || createProvenance(
          provenanceSource,
          options.createdBy || 'system'
        ),

        // NEW: Confidence scoring
        confidence: item.confidence || createConfidence(baseConfidence, stability),

        // NEW: Conflict tracking
        conflicts: item.conflicts || createConflicts()
      }

      items.push(enrichedItem)

      // Keep last 50 per type
      localStorage.setItem(key, JSON.stringify(items.slice(-50)))

      // Check for potential contradictions with existing items
      this._checkForContradictions(type, enrichedItem, items.slice(0, -1))

      // Phase 5: Also save to server (non-blocking)
      // This provides server-side persistence while preserving localStorage for immediate access
      memoryClient.saveMemory({
        type,
        content: enrichedItem.content,
        importance: enrichedItem.importance || 'medium',
        tags: enrichedItem.tags || [],
        agentId: options.agentId,
        conversationId: options.conversationId
      }).catch(err => {
        console.warn('[Memory] Server save failed (will retry later):', err.message)
      })

      // AEE audit trail (thread conversation correlation when available)
      logMemorySaved(enrichedItem, type, options.conversationId)

      return enrichedItem
    } catch (e) {
      console.error('[Memory] Failed to add learned item:', e)
      return false
    }
  }

  /**
   * Get total count of learned items (for tier limit checking)
   * Excludes reflections which are not counted toward limits
   * @private
   */
  _getTotalLearnedCount() {
    let total = 0
    for (const type of MEMORY_TYPES_LOCAL) {
      if (type === 'reflection') continue // Reflections don't count toward limit
      try {
        const items = this.getLearnedItemsByType(type)
        total += items.length
      } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }
    }
    return total
  }

  /**
   * Check if new item contradicts existing memories
   * @private
   */
  _checkForContradictions(type, newItem, existingItems) {
    if (!newItem.content) return

    const newContent = newItem.content.toLowerCase()

    for (const existing of existingItems) {
      if (!existing.content) continue

      const existingContent = existing.content.toLowerCase()

      // Check for opposite patterns
      const opposites = [
        ['always', 'never'],
        ['prefer', 'avoid'],
        ['use', "don't use"],
        ['enable', 'disable'],
        ['allow', 'block'],
        ['like', "don't like"],
        ['want', "don't want"]
      ]

      for (const [pos, neg] of opposites) {
        const newHasPos = newContent.includes(pos)
        const newHasNeg = newContent.includes(neg)
        const existHasPos = existingContent.includes(pos)
        const existHasNeg = existingContent.includes(neg)

        // Check for conflict: one has positive, other has negative
        if ((newHasPos && existHasNeg) || (newHasNeg && existHasPos)) {
          // Check topic similarity (simple word overlap)
          const newWords = new Set(newContent.split(/\s+/).filter(w => w.length > 3))
          const existWords = new Set(existingContent.split(/\s+/).filter(w => w.length > 3))
          const overlap = [...newWords].filter(w => existWords.has(w)).length

          if (overlap >= 2) {
            // Mark both as having conflicts
            console.warn(`[Memory] Potential contradiction detected between "${newItem.id}" and "${existing.id}"`)

            newItem.conflicts = {
              ...newItem.conflicts,
              detectedAt: new Date().toISOString(),
              conflictsWith: [...(newItem.conflicts?.conflictsWith || []), existing.id],
              resolution: 'pending'
            }

            // Update existing item's conflicts too
            this._markConflict(type, existing.id, newItem.id)
          }
        }
      }
    }
  }

  /**
   * Mark an existing item as having a conflict
   * @private
   */
  _markConflict(type, itemId, conflictingId) {
    try {
      const key = `quox_learned_${type}`
      const data = localStorage.getItem(key)
      if (!data) return

      const items = JSON.parse(data)
      const item = items.find(i => i.id === itemId)
      if (!item) return

      item.conflicts = item.conflicts || createConflicts()
      item.conflicts.detectedAt = item.conflicts.detectedAt || new Date().toISOString()
      item.conflicts.conflictsWith = [...new Set([...(item.conflicts.conflictsWith || []), conflictingId])]
      item.conflicts.resolution = 'pending'

      localStorage.setItem(key, JSON.stringify(items))
    } catch (e) {
      console.error('[Memory] Failed to mark conflict:', e)
    }
  }

  /**
   * Update a learned item by ID
   * Tracks modification provenance
   */
  updateLearnedItem(type, itemId, updates, options = {}) {
    try {
      const key = `quox_learned_${type}`
      const data = localStorage.getItem(key)
      if (!data) return false

      const items = JSON.parse(data)
      const index = items.findIndex(i => i.id === itemId)
      if (index === -1) return false

      const now = new Date().toISOString()
      const item = items[index]

      // Track modification in provenance
      const provenance = {
        ...item.provenance,
        modifiedBy: options.modifiedBy || 'system',
        modifiedAt: now
      }

      // If this is a superseding update, track that
      if (options.supersedes) {
        provenance.supersedes = options.supersedes
      }

      // Re-verify confidence if explicitly verified
      const confidence = { ...item.confidence }
      if (options.verified) {
        confidence.lastVerified = now
        confidence.verificationCount = (confidence.verificationCount || 0) + 1
        // Boost confidence on verification
        confidence.score = Math.min(1.0, (confidence.score || 0.7) + 0.1)
      }

      items[index] = {
        ...item,
        ...updates,
        provenance,
        confidence,
        updatedAt: now
      }

      localStorage.setItem(key, JSON.stringify(items))
      return items[index]
    } catch (e) {
      console.error('[Memory] Failed to update learned item:', e)
      return false
    }
  }

  /**
   * Verify a memory item (confirms it's still true)
   */
  verifyMemory(type, itemId, verifiedBy = 'user') {
    return this.updateLearnedItem(type, itemId, {}, {
      modifiedBy: verifiedBy,
      verified: true
    })
  }

  /**
   * Resolve a conflict between memories
   */
  resolveConflict(type, itemId, resolution, keepId = null) {
    try {
      const key = `quox_learned_${type}`
      const data = localStorage.getItem(key)
      if (!data) return false

      const items = JSON.parse(data)
      const item = items.find(i => i.id === itemId)
      if (!item || !item.conflicts) return false

      const now = new Date().toISOString()

      // Mark as resolved
      item.conflicts.resolution = resolution // 'user_resolved' | 'auto_resolved'
      item.conflicts.resolvedAt = now

      // If keeping one and discarding others
      if (resolution === 'user_resolved' && keepId) {
        const discardIds = item.conflicts.conflictsWith.filter(id => id !== keepId)
        for (const discardId of discardIds) {
          this.supersededBy(type, discardId, keepId)
        }
      }

      localStorage.setItem(key, JSON.stringify(items))
      return true
    } catch (e) {
      console.error('[Memory] Failed to resolve conflict:', e)
      return false
    }
  }

  /**
   * Mark a memory as superseded by another
   */
  supersededBy(type, oldId, newId) {
    try {
      const key = `quox_learned_${type}`
      const data = localStorage.getItem(key)
      if (!data) return false

      const items = JSON.parse(data)
      const oldItem = items.find(i => i.id === oldId)
      const newItem = items.find(i => i.id === newId)

      if (!oldItem || !newItem) return false

      // Mark old as superseded
      oldItem.provenance = oldItem.provenance || createProvenance()
      oldItem.provenance.supersededBy = newId
      oldItem.confidence = oldItem.confidence || createConfidence()
      oldItem.confidence.score = 0.1 // Very low confidence for superseded items

      // Mark new as superseding
      newItem.provenance = newItem.provenance || createProvenance()
      newItem.provenance.supersedes = oldId

      localStorage.setItem(key, JSON.stringify(items))
      return true
    } catch (e) {
      console.error('[Memory] Failed to mark superseded:', e)
      return false
    }
  }

  /**
   * Delete a learned item by ID
   */
  deleteLearnedItem(type, itemId) {
    try {
      const key = `quox_learned_${type}`
      const data = localStorage.getItem(key)
      if (!data) return false

      const items = JSON.parse(data)
      const filtered = items.filter(i => i.id !== itemId)

      if (filtered.length === items.length) return false // Not found

      localStorage.setItem(key, JSON.stringify(filtered))
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Get all learned items of a specific type
   */
  getLearnedItemsByType(type) {
    try {
      const key = `quox_learned_${type}`
      const data = localStorage.getItem(key)
      return data ? JSON.parse(data) : []
    } catch (e) {
      return []
    }
  }

  /**
   * Process candidate buffer (maintenance task)
   */
  async processCandidates() {
    const candidates = [...this.candidateBuffer]
    this.candidateBuffer = []

    // Group by type
    const byType = {}
    for (const c of candidates) {
      if (!byType[c.type]) byType[c.type] = []
      byType[c.type].push(c)
    }

    // Store high-salience items
    for (const [type, items] of Object.entries(byType)) {
      const highSalience = items.filter(i => i.salience >= 0.7)
      if (highSalience.length > 0) {
        const key = `quox_learned_${type}`
        const existing = localStorage.getItem(key)
        const learned = existing ? JSON.parse(existing) : []
        learned.push(...highSalience)
        // Keep last 50 per type
        localStorage.setItem(key, JSON.stringify(learned.slice(-50)))
      }
    }

    return candidates.length
  }

  /**
   * Get memory statistics
   */
  getStats() {
    const stats = {
      recentContextSize: this.recentContext.length,
      candidateBufferSize: this.candidateBuffer.length,
      episodicEntries: 0,
      learnedPreferences: 0,
      learnedFacts: 0,
      learnedDecisions: 0,
      learnedConstraints: 0,
      learnedErrors: 0,
      learnedReflections: 0,
      projects: 0
    }

    try {
      const recent = localStorage.getItem('episodic_recent') || ''
      stats.episodicEntries = recent.split('\n').filter(Boolean).length

      for (const type of MEMORY_TYPES_LOCAL) {
        const data = localStorage.getItem(`quox_learned_${type}`)
        const count = data ? JSON.parse(data).length : 0
        stats[`learned${type.charAt(0).toUpperCase() + type.slice(1)}s`] = count
      }

      const projects = localStorage.getItem('quox_projects')
      stats.projects = projects ? JSON.parse(projects).length : 0

      // Include reflection stats
      const reflectionState = this.getReflectionState()
      stats.totalInteractions = reflectionState.totalInteractions
      stats.nextReflectionIn = Math.max(0, REFLECTION_CONFIG.reflectionInterval - (reflectionState.totalInteractions - reflectionState.lastReflectionAt))
    } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }

    return stats
  }

  /**
   * Export all memory to JSON
   */
  exportMemory() {
    const data = {
      profile: this.getProfile(),
      projects: [],
      learned: {
        preferences: [],
        facts: [],
        decisions: [],
        constraints: [],
        errors: []
      },
      recentContext: this.recentContext,
      exported_at: new Date().toISOString()
    }

    try {
      const projects = localStorage.getItem('quox_projects')
      data.projects = projects ? JSON.parse(projects) : []

      for (const type of MEMORY_TYPES_LOCAL) {
        const items = localStorage.getItem(`quox_learned_${type}`)
        data.learned[`${type}s`] = items ? JSON.parse(items) : []
      }
    } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }

    return data
  }

  /**
   * Import memory from JSON
   */
  importMemory(data) {
    try {
      if (data.profile) {
        this.saveProfile(data.profile)
      }

      if (data.projects) {
        localStorage.setItem('quox_projects', JSON.stringify(data.projects))
        this._identityWriteThrough('projects', data.projects)
      }

      if (data.learned) {
        for (const [type, items] of Object.entries(data.learned)) {
          const key = `quox_learned_${type.replace(/s$/, '')}`
          localStorage.setItem(key, JSON.stringify(items))
        }
      }

      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Get total storage size used by memory system
   * @returns {object} Storage statistics
   */
  getStorageStats() {
    let totalBytes = 0
    let itemCount = 0
    const breakdown = {}

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('quox_') || key?.startsWith('episodic_')) {
        const value = localStorage.getItem(key)
        const bytes = (key.length + (value?.length || 0)) * 2 // UTF-16
        totalBytes += bytes
        itemCount++

        // Categorize
        const category = key.split('_')[1] || 'other'
        breakdown[category] = (breakdown[category] || 0) + bytes
      }
    }

    return {
      totalBytes,
      totalMB: (totalBytes / (1024 * 1024)).toFixed(2),
      itemCount,
      breakdown,
      limitMB: 5, // 5MB soft limit
      isOverLimit: totalBytes > 5 * 1024 * 1024
    }
  }

  /**
   * Enforce storage limits - remove oldest items when over limit
   * @returns {number} Number of items pruned
   */
  enforceStorageLimits() {
    const stats = this.getStorageStats()
    if (!stats.isOverLimit) return 0

    console.warn('[Memory] Storage over limit:', stats.totalMB, 'MB. Running cleanup...')

    let pruned = 0

    // Prune each learned type to 30 items (from 50)
    for (const type of MEMORY_TYPES_LOCAL) {
      const key = `quox_learned_${type}`
      const stored = localStorage.getItem(key)
      if (stored) {
        try {
          const items = JSON.parse(stored)
          if (items.length > 30) {
            const trimmed = items.slice(-30)
            localStorage.setItem(key, JSON.stringify(trimmed))
            pruned += items.length - 30
          }
        } catch (e) { /* ignore */ }
      }
    }

    // Trim episodic to last 500 entries
    const episodicKey = 'episodic_recent'
    const episodic = localStorage.getItem(episodicKey)
    if (episodic) {
      const lines = episodic.split('\n').filter(Boolean)
      if (lines.length > 500) {
        localStorage.setItem(episodicKey, lines.slice(-500).join('\n'))
        pruned += lines.length - 500
      }
    }

    console.log('[Memory] Pruned', pruned, 'items. New size:', this.getStorageStats().totalMB, 'MB')
    return pruned
  }

  /**
   * Clear all memory
   */
  clearMemory() {
    const keys = [
      'quox_profile',
      'quox_projects',
      'quox_entities',
      ...MEMORY_TYPES_LOCAL.map(t => `quox_learned_${t}`),
      'episodic_recent'
    ]

    for (const key of keys) {
      localStorage.removeItem(key)
    }

    // Clear agent memories
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('quox_agent_') || key?.startsWith('episodic_')) {
        localStorage.removeItem(key)
      }
    }

    this.candidateBuffer = []
    this.recentContext = []
  }

  /**
   * Run all maintenance tasks
   */
  async runMaintenance() {
    const results = {
      candidatesProcessed: 0,
      topicsPromoted: 0,
      entriesSummarized: 0,
      memoriesPruned: 0
    }

    try {
      // 1. Process candidate buffer
      results.candidatesProcessed = await this.processCandidates()

      // 2. Promote recurring topics to projects
      results.topicsPromoted = await this.promoteRecurringTopics()

      // 3. Summarize old episodic logs
      results.entriesSummarized = await this.summarizeOldEpisodic()

      // 4. Prune stale memories (decay)
      results.memoriesPruned = await this.pruneStaleMemories()

      // 5. Enforce storage limits
      results.storagePruned = this.enforceStorageLimits()

      // Store last maintenance time
      localStorage.setItem('quox_last_maintenance', new Date().toISOString())

    } catch (e) {
      console.error('Maintenance failed:', e)
    }

    return results
  }

  /**
   * Topic Promotion - Elevate recurring topics to first-class projects
   * Based on: 5+ mentions, 3+ days, 2+ contexts
   */
  async promoteRecurringTopics() {
    let promoted = 0

    try {
      // Get recent episodic entries
      const recentKey = 'episodic_recent'
      const recent = localStorage.getItem(recentKey) || ''
      const entries = recent.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)

      if (entries.length < 10) return 0

      // Extract topics (simple keyword extraction)
      const topicCounts = new Map()
      const topicDays = new Map()
      const topicAgents = new Map()

      for (const entry of entries) {
        const text = `${entry.query || ''} ${entry.response || ''}`.toLowerCase()
        const day = new Date(entry.timestamp).toDateString()
        const agent = entry.agent || 'unknown'

        // Extract potential topics (words 4+ chars that appear meaningful)
        const words = text.match(/\b[a-z]{4,}\b/g) || []
        const stopWords = new Set(['that', 'this', 'with', 'from', 'have', 'been', 'will', 'would', 'could', 'should', 'their', 'there', 'what', 'when', 'where', 'which', 'about', 'into', 'your', 'more', 'some', 'them', 'then', 'than'])

        for (const word of words) {
          if (stopWords.has(word)) continue

          topicCounts.set(word, (topicCounts.get(word) || 0) + 1)

          if (!topicDays.has(word)) topicDays.set(word, new Set())
          topicDays.get(word).add(day)

          if (!topicAgents.has(word)) topicAgents.set(word, new Set())
          topicAgents.get(word).add(agent)
        }
      }

      // Find topics meeting promotion criteria
      const existingProjects = this.getAllProjects()
      const existingKeywords = new Set(
        existingProjects.flatMap(p => (p.keywords || []).map(k => k.toLowerCase()))
      )

      for (const [topic, count] of topicCounts) {
        // Skip if already a project keyword
        if (existingKeywords.has(topic)) continue

        const days = topicDays.get(topic)?.size || 0
        const agents = topicAgents.get(topic)?.size || 0

        // Promotion criteria: 5+ mentions, 3+ days, 2+ agents/contexts
        if (count >= 5 && days >= 3 && agents >= 2) {
          // Create project from topic
          this.addProject({
            name: topic.charAt(0).toUpperCase() + topic.slice(1),
            description: `Auto-promoted from recurring discussions (${count} mentions over ${days} days)`,
            keywords: [topic],
            auto_promoted: true,
            promoted_at: new Date().toISOString(),
            stats: { mentions: count, days, contexts: agents }
          })
          promoted++

          // Limit promotions per run
          if (promoted >= 3) break
        }
      }
    } catch (e) {
      console.error('Topic promotion failed:', e)
    }

    return promoted
  }

  /**
   * Summarize old episodic logs (older than 7 days)
   */
  async summarizeOldEpisodic() {
    let summarized = 0

    try {
      const now = Date.now()
      const weekAgo = now - (7 * 24 * 60 * 60 * 1000)

      // Find all episodic_* keys
      const keysToSummarize = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith('episodic_') && key !== 'episodic_recent') {
          // Check if it's an old date key
          const dateStr = key.replace('episodic_', '')
          const date = new Date(dateStr)
          if (!isNaN(date.getTime()) && date.getTime() < weekAgo) {
            keysToSummarize.push(key)
          }
        }
      }

      for (const key of keysToSummarize) {
        const data = localStorage.getItem(key)
        if (!data) continue

        const entries = data.split('\n').filter(Boolean)
        if (entries.length < 5) continue

        // Create summary
        const dateStr = key.replace('episodic_', '')
        const parsed = entries.map(e => {
          try { return JSON.parse(e) } catch { return null }
        }).filter(Boolean)

        const summary = {
          date: dateStr,
          entryCount: parsed.length,
          agents: [...new Set(parsed.map(p => p.agent))],
          topics: this.extractTopics(parsed),
          summarized_at: new Date().toISOString()
        }

        // Store summary and remove raw data
        localStorage.setItem(`episodic_summary_${dateStr}`, JSON.stringify(summary))
        localStorage.removeItem(key)
        summarized++
      }
    } catch (e) {
      console.error('Episodic summarization failed:', e)
    }

    return summarized
  }

  /**
   * Extract topics from parsed entries
   */
  extractTopics(entries) {
    const wordCounts = new Map()
    const stopWords = new Set(['that', 'this', 'with', 'from', 'have', 'been', 'will', 'would', 'could', 'should'])

    for (const entry of entries) {
      const text = `${entry.query || ''}`.toLowerCase()
      const words = text.match(/\b[a-z]{4,}\b/g) || []

      for (const word of words) {
        if (!stopWords.has(word)) {
          wordCounts.set(word, (wordCounts.get(word) || 0) + 1)
        }
      }
    }

    // Return top 5 topics
    return [...wordCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word)
  }

  /**
   * Prune stale memories based on decay
   * Memory temperature model: Hot -> Warm -> Cool -> Cold -> Pruned
   */
  async pruneStaleMemories() {
    let pruned = 0

    try {
      const now = Date.now()
      const DECAY_THRESHOLDS = {
        hot: 24 * 60 * 60 * 1000,      // < 1 day
        warm: 7 * 24 * 60 * 60 * 1000,  // < 1 week
        cool: 30 * 24 * 60 * 60 * 1000, // < 1 month
        cold: 90 * 24 * 60 * 60 * 1000  // < 3 months
      }

      // Process each learned type
      for (const type of MEMORY_TYPES_LOCAL) {
        const key = `quox_learned_${type}`
        const data = localStorage.getItem(key)
        if (!data) continue

        const items = JSON.parse(data)
        const kept = []

        for (const item of items) {
          const age = now - new Date(item.learnedAt || item.timestamp || 0).getTime()
          const accessCount = item.accessCount || 0
          const salience = item.salience || 0.5

          // Calculate decay score
          let decayScore = 1.0

          if (age > DECAY_THRESHOLDS.cold) {
            decayScore = 0.1
          } else if (age > DECAY_THRESHOLDS.cool) {
            decayScore = 0.3
          } else if (age > DECAY_THRESHOLDS.warm) {
            decayScore = 0.6
          }

          // Boost score for frequently accessed or high-salience items
          decayScore += (accessCount * 0.1)
          decayScore += (salience * 0.3)

          // Keep if decay score > 0.3
          if (decayScore > 0.3) {
            item.decayScore = decayScore
            kept.push(item)
          } else {
            pruned++
          }
        }

        localStorage.setItem(key, JSON.stringify(kept))
      }

      // Prune old summaries (older than 6 months)
      const sixMonthsAgo = now - (180 * 24 * 60 * 60 * 1000)
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i)
        if (key?.startsWith('episodic_summary_')) {
          const dateStr = key.replace('episodic_summary_', '')
          const date = new Date(dateStr)
          if (!isNaN(date.getTime()) && date.getTime() < sixMonthsAgo) {
            localStorage.removeItem(key)
            pruned++
          }
        }
      }

    } catch (e) {
      console.error('Memory pruning failed:', e)
    }

    return pruned
  }

  /**
   * Track memory access for decay scoring
   */
  trackAccess(type, content) {
    try {
      const key = `quox_learned_${type}`
      const data = localStorage.getItem(key)
      if (!data) return

      const items = JSON.parse(data)
      for (const item of items) {
        if (item.content === content) {
          item.accessCount = (item.accessCount || 0) + 1
          item.lastAccess = new Date().toISOString()
          break
        }
      }
      localStorage.setItem(key, JSON.stringify(items))
    } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }
  }

  /**
   * Get memory health stats
   */
  getMemoryHealth() {
    const stats = this.getStats()
    const lastMaintenance = localStorage.getItem('quox_last_maintenance')

    return {
      ...stats,
      lastMaintenance,
      needsMaintenance: !lastMaintenance ||
        (Date.now() - new Date(lastMaintenance).getTime() > 24 * 60 * 60 * 1000),
      vectorEnabled: this.vectorInitialized
    }
  }

  /**
   * Search across all memories
   * Searches projects, learned items, episodic, and vector memory
   */
  async searchMemories(query, options = {}) {
    const { maxResults = 20, types = null } = options
    const results = []

    // Default search all types
    const searchTypes = types || ['projects', 'preferences', 'facts', 'decisions', 'constraints', 'episodic']
    const queryLower = query.toLowerCase()
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2)

    // Helper to calculate match score
    const calcScore = (text) => {
      const textLower = text.toLowerCase()
      let score = 0
      for (const word of queryWords) {
        if (textLower.includes(word)) score += 1
      }
      // Bonus for exact phrase match
      if (textLower.includes(queryLower)) score += 2
      return score
    }

    // Search projects
    if (searchTypes.includes('projects')) {
      try {
        const projects = this.getAllProjects()
        for (const proj of projects) {
          const searchText = `${proj.name} ${proj.description || ''} ${(proj.keywords || []).join(' ')}`
          const score = calcScore(searchText)
          if (score > 0) {
            results.push({
              type: 'project',
              id: proj.id,
              content: proj.name,
              description: proj.description,
              score,
              data: proj
            })
          }
        }
      } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }
    }

    // Search learned items
    for (const type of ['preference', 'fact', 'decision', 'constraint']) {
      if (!searchTypes.includes(`${type}s`)) continue

      try {
        const items = this.getLearnedItemsByType(type)
        for (const item of items) {
          const score = calcScore(item.content || '')
          if (score > 0) {
            results.push({
              type,
              id: item.id,
              content: item.content,
              score,
              salience: item.salience,
              learnedAt: item.learnedAt,
              data: item
            })
          }
        }
      } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }
    }

    // Search episodic (recent)
    if (searchTypes.includes('episodic')) {
      try {
        const recent = localStorage.getItem('episodic_recent') || ''
        const entries = recent.split('\n').filter(Boolean).map(line => {
          try { return JSON.parse(line) } catch { return null }
        }).filter(Boolean)

        for (const entry of entries) {
          const searchText = `${entry.query || ''} ${entry.response || ''}`
          const score = calcScore(searchText)
          if (score > 0) {
            results.push({
              type: 'episodic',
              content: entry.query,
              summary: entry.response?.substring(0, 100),
              score,
              timestamp: entry.timestamp,
              agent: entry.agent,
              data: entry
            })
          }
        }
      } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }
    }

    // Vector semantic search
    if (this.vectorInitialized && query) {
      try {
        const vectorResults = await this.vectorMemory.search(query, 10)
        for (const vr of vectorResults) {
          results.push({
            type: 'semantic',
            content: vr.content?.substring(0, 200),
            score: vr.score || 0.5,
            data: vr
          })
        }
      } catch (e) { console.warn('[MemoryManager] Operation failed:', e.message) }
    }

    // Sort by score and return top results
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
  }

  /**
   * Get memory summary for a time period
   */
  getMemorySummary(daysBack = 7) {
    const summary = {
      period: `Last ${daysBack} days`,
      interactions: 0,
      topAgents: {},
      topTopics: {},
      learnedCount: {
        preferences: 0,
        facts: 0,
        decisions: 0,
        constraints: 0
      },
      projects: []
    }

    try {
      // Count recent interactions
      const recent = localStorage.getItem('episodic_recent') || ''
      const entries = recent.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)

      const cutoff = Date.now() - (daysBack * 24 * 60 * 60 * 1000)

      for (const entry of entries) {
        const entryTime = new Date(entry.timestamp).getTime()
        if (entryTime < cutoff) continue

        summary.interactions++

        // Count agents
        const agent = entry.agent || 'unknown'
        summary.topAgents[agent] = (summary.topAgents[agent] || 0) + 1

        // Extract topics
        const words = (entry.query || '').toLowerCase().match(/\b[a-z]{4,}\b/g) || []
        for (const word of words) {
          summary.topTopics[word] = (summary.topTopics[word] || 0) + 1
        }
      }

      // Count learned items
      for (const type of ['preference', 'fact', 'decision', 'constraint']) {
        const items = this.getLearnedItemsByType(type)
        summary.learnedCount[`${type}s`] = items.filter(i => {
          const learnedTime = new Date(i.learnedAt || i.timestamp || 0).getTime()
          return learnedTime >= cutoff
        }).length
      }

      // Get active projects
      summary.projects = this.getAllProjects()
        .filter(p => {
          const updated = new Date(p.updated_at || p.created_at || 0).getTime()
          return updated >= cutoff
        })
        .map(p => ({ name: p.name, id: p.id }))

      // Sort and limit topics
      summary.topTopics = Object.entries(summary.topTopics)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .reduce((obj, [k, v]) => ({ ...obj, [k]: v }), {})

    } catch (e) {
      console.error('Failed to generate summary:', e)
    }

    return summary
  }

  // ============================================
  // Phase 5: Multi-Agent Memory Specialization
  // ============================================

  /**
   * Agent specialization profiles defining memory access patterns
   */
  static AGENT_PROFILES = {
    quox: {
      name: 'Quox',
      role: 'orchestrator',
      memoryAccess: ['all'],
      priorityTypes: ['decision', 'constraint', 'preference'],
      canWrite: ['all'],
      contextBudget: 6000,
      description: 'Central orchestrator with full memory access'
    },
    vault: {
      name: 'Vault',
      role: 'infrastructure',
      memoryAccess: ['fact', 'error', 'entity', 'runbook'],
      priorityTypes: ['fact', 'error', 'entity'],
      canWrite: ['fact', 'error', 'entity', 'runbook'],
      contextBudget: 4000,
      description: 'Infrastructure management specialist'
    },
    analyst: {
      name: 'Analyst',
      role: 'analysis',
      memoryAccess: ['fact', 'decision', 'reflection', 'entity'],
      priorityTypes: ['reflection', 'fact'],
      canWrite: ['fact', 'reflection'],
      contextBudget: 5000,
      description: 'Data analysis and insights specialist'
    },
    coder: {
      name: 'Coder',
      role: 'development',
      memoryAccess: ['fact', 'error', 'decision', 'constraint'],
      priorityTypes: ['error', 'constraint', 'fact'],
      canWrite: ['fact', 'error', 'decision'],
      contextBudget: 4000,
      description: 'Code development and debugging specialist'
    },
    researcher: {
      name: 'Researcher',
      role: 'research',
      memoryAccess: ['fact', 'reflection', 'entity'],
      priorityTypes: ['fact', 'reflection'],
      canWrite: ['fact', 'reflection'],
      contextBudget: 5000,
      description: 'Research and documentation specialist'
    }
  }

  /**
   * Get agent profile by name
   */
  getAgentProfile(agentName) {
    const name = (agentName || 'quox').toLowerCase()
    return MemoryManager.AGENT_PROFILES[name] || MemoryManager.AGENT_PROFILES.quox
  }

  /**
   * Get all available agent profiles
   */
  getAllAgentProfiles() {
    return { ...MemoryManager.AGENT_PROFILES }
  }

  /**
   * Check if agent can access a memory type
   */
  canAgentAccess(agentName, memoryType) {
    const profile = this.getAgentProfile(agentName)
    return profile.memoryAccess.includes('all') || profile.memoryAccess.includes(memoryType)
  }

  /**
   * Check if agent can write to a memory type
   */
  canAgentWrite(agentName, memoryType) {
    const profile = this.getAgentProfile(agentName)
    return profile.canWrite.includes('all') || profile.canWrite.includes(memoryType)
  }

  /**
   * Get specialized context for an agent based on their profile
   */
  getAgentSpecializedContext(agentName, query, options = {}) {
    const profile = this.getAgentProfile(agentName)
    const budget = options.budget || profile.contextBudget

    const context = {
      agent: profile.name,
      role: profile.role,
      profile: null,
      memories: [],
      entities: [],
      runbooks: [],
      recentContext: []
    }

    let usedTokens = 0
    const estimateTokens = (text) => Math.ceil((text || '').length / 4)

    // Always include basic profile
    const userProfile = this.getProfile()
    const profileTokens = estimateTokens(JSON.stringify(userProfile))
    if (profileTokens < budget * 0.1) {
      context.profile = userProfile
      usedTokens += profileTokens
    }

    // Get memories filtered by agent access and prioritized by agent preferences
    const accessibleTypes = profile.memoryAccess.includes('all')
      ? MEMORY_TYPES_LOCAL
      : profile.memoryAccess.filter(t => MEMORY_TYPES_LOCAL.includes(t))

    const allMemories = []
    for (const type of accessibleTypes) {
      const items = this.getLearnedItemsByType(type)
      for (const item of items) {
        const isPriority = profile.priorityTypes.includes(type)
        allMemories.push({
          ...item,
          memoryType: type,
          agentPriority: isPriority ? 1.5 : 1.0
        })
      }
    }

    // Score and sort memories by relevance to query and agent priority
    const queryLower = (query || '').toLowerCase()
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2)

    const scoredMemories = allMemories.map(mem => {
      const content = (mem.content || '').toLowerCase()
      const relevance = queryWords.reduce((score, word) =>
        score + (content.includes(word) ? 1 : 0), 0)
      const importance = mem.importance || mem.salience || 0.5
      return {
        ...mem,
        score: (relevance * 2 + importance) * mem.agentPriority
      }
    }).sort((a, b) => b.score - a.score)

    // Add memories within budget
    for (const mem of scoredMemories) {
      const memTokens = estimateTokens(mem.content)
      if (usedTokens + memTokens < budget * 0.5) {
        context.memories.push(mem)
        usedTokens += memTokens
      }
      if (context.memories.length >= 15) break
    }

    // Add entities if agent has access
    if (this.canAgentAccess(agentName, 'entity')) {
      const entities = this.suggestRelatedEntities(query, 5)
      for (const { entity } of entities) {
        const entityTokens = estimateTokens(JSON.stringify(entity))
        if (usedTokens + entityTokens < budget * 0.7) {
          context.entities.push(entity)
          usedTokens += entityTokens
        }
      }
    }

    // Add runbooks if agent has access
    if (this.canAgentAccess(agentName, 'runbook')) {
      const runbooks = this.findRunbooks(query, 3)
      for (const rb of runbooks) {
        const rbTokens = estimateTokens(JSON.stringify(rb))
        if (usedTokens + rbTokens < budget * 0.8) {
          context.runbooks.push(rb)
          usedTokens += rbTokens
        }
      }
    }

    // Add recent context
    const recentEvents = this.getRecentEvents(5)
    for (const event of recentEvents) {
      const eventTokens = estimateTokens(event.query + (event.response || '').substring(0, 100))
      if (usedTokens + eventTokens < budget * 0.9) {
        context.recentContext.push({
          query: event.query?.substring(0, 80),
          agent: event.agent,
          timestamp: event.timestamp
        })
        usedTokens += eventTokens
      }
    }

    return {
      context,
      usedTokens,
      budget,
      profile
    }
  }

  /**
   * Store memory with agent attribution
   */
  storeAgentMemory(agentName, type, item) {
    if (!this.canAgentWrite(agentName, type)) {
      return { success: false, error: `Agent ${agentName} cannot write to ${type}` }
    }

    const enrichedItem = {
      ...item,
      sourceAgent: agentName,
      agentRole: this.getAgentProfile(agentName).role,
      createdAt: new Date().toISOString()
    }

    const result = this.addLearnedItem(type, enrichedItem)
    return { success: !!result, item: result || enrichedItem }
  }

  // ============================================
  // Memory Sharing Protocol
  // ============================================

  /**
   * Memory visibility levels
   */
  static VISIBILITY_LEVELS = {
    PRIVATE: 'private',      // Only visible to creating agent
    TEAM: 'team',            // Visible to agents with same role
    SHARED: 'shared',        // Visible to all agents
    BROADCAST: 'broadcast'   // Pushed to all agents proactively
  }

  /**
   * Share a memory with specific visibility
   */
  shareMemory(memoryId, visibility, options = {}) {
    const key = 'quox_memory_sharing'
    const data = localStorage.getItem(key)
    const sharing = data ? JSON.parse(data) : {}

    sharing[memoryId] = {
      visibility,
      sharedBy: options.sharedBy || 'quox',
      sharedAt: new Date().toISOString(),
      allowedAgents: options.allowedAgents || [],
      expiresAt: options.expiresAt || null,
      tags: options.tags || []
    }

    localStorage.setItem(key, JSON.stringify(sharing))
    return { success: true, memoryId, visibility }
  }

  /**
   * Get sharing info for a memory
   */
  getMemorySharing(memoryId) {
    const key = 'quox_memory_sharing'
    const data = localStorage.getItem(key)
    const sharing = data ? JSON.parse(data) : {}
    return sharing[memoryId] || { visibility: MemoryManager.VISIBILITY_LEVELS.SHARED }
  }

  /**
   * Check if agent can see a memory based on sharing rules
   */
  canAgentSeeMemory(agentName, memoryId, memoryItem = null) {
    const sharing = this.getMemorySharing(memoryId)
    const agentProfile = this.getAgentProfile(agentName)

    // Check expiration
    if (sharing.expiresAt && new Date(sharing.expiresAt) < new Date()) {
      return false
    }

    switch (sharing.visibility) {
      case MemoryManager.VISIBILITY_LEVELS.PRIVATE:
        // Only creating agent can see
        return memoryItem?.sourceAgent === agentName || sharing.sharedBy === agentName

      case MemoryManager.VISIBILITY_LEVELS.TEAM:
        // Same role can see
        const sharerProfile = this.getAgentProfile(sharing.sharedBy)
        return agentProfile.role === sharerProfile.role

      case MemoryManager.VISIBILITY_LEVELS.SHARED:
      case MemoryManager.VISIBILITY_LEVELS.BROADCAST:
        return true

      default:
        // Check explicit allowed list
        if (sharing.allowedAgents?.length > 0) {
          return sharing.allowedAgents.includes(agentName)
        }
        return true
    }
  }

  /**
   * Get memories visible to a specific agent
   */
  getVisibleMemories(agentName, type = null) {
    const profile = this.getAgentProfile(agentName)
    const types = type ? [type] : (profile.memoryAccess.includes('all') ? MEMORY_TYPES_LOCAL : profile.memoryAccess)

    const visible = []
    for (const t of types) {
      if (!MEMORY_TYPES_LOCAL.includes(t)) continue

      const items = this.getLearnedItemsByType(t)
      for (const item of items) {
        if (this.canAgentSeeMemory(agentName, item.id, item)) {
          visible.push({ ...item, memoryType: t })
        }
      }
    }

    return visible
  }

  /**
   * Broadcast a memory to all agents
   */
  broadcastMemory(memoryId, message = null) {
    this.shareMemory(memoryId, MemoryManager.VISIBILITY_LEVELS.BROADCAST)

    // Store broadcast notification
    const key = 'quox_broadcasts'
    const data = localStorage.getItem(key)
    const broadcasts = data ? JSON.parse(data) : []

    broadcasts.push({
      memoryId,
      message,
      broadcastAt: new Date().toISOString(),
      acknowledged: []
    })

    // Keep last 50 broadcasts
    localStorage.setItem(key, JSON.stringify(broadcasts.slice(-50)))
    return { success: true, memoryId }
  }

  /**
   * Get pending broadcasts for an agent
   */
  getPendingBroadcasts(agentName) {
    const key = 'quox_broadcasts'
    const data = localStorage.getItem(key)
    const broadcasts = data ? JSON.parse(data) : []

    return broadcasts.filter(b => !b.acknowledged.includes(agentName))
  }

  /**
   * Acknowledge a broadcast
   */
  acknowledgeBroadcast(agentName, memoryId) {
    const key = 'quox_broadcasts'
    const data = localStorage.getItem(key)
    const broadcasts = data ? JSON.parse(data) : []

    const broadcast = broadcasts.find(b => b.memoryId === memoryId)
    if (broadcast && !broadcast.acknowledged.includes(agentName)) {
      broadcast.acknowledged.push(agentName)
      localStorage.setItem(key, JSON.stringify(broadcasts))
      return { success: true }
    }
    return { success: false, error: 'Broadcast not found or already acknowledged' }
  }

  // ============================================
  // Conversation Threading
  // ============================================

  /**
   * Create a new conversation thread
   */
  createThread(options = {}) {
    const thread = {
      id: options.id || `thread_${Date.now()}`,
      parentId: options.parentId || null,
      title: options.title || 'New Thread',
      agent: options.agent || 'quox',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
      messages: [],
      metadata: options.metadata || {},
      tags: options.tags || []
    }

    const key = 'quox_threads'
    const data = localStorage.getItem(key)
    const threads = data ? JSON.parse(data) : []
    threads.push(thread)
    localStorage.setItem(key, JSON.stringify(threads))

    return thread
  }

  /**
   * Get a thread by ID
   */
  getThread(threadId) {
    const key = 'quox_threads'
    const data = localStorage.getItem(key)
    const threads = data ? JSON.parse(data) : []
    return threads.find(t => t.id === threadId) || null
  }

  /**
   * Get all threads, optionally filtered
   */
  getAllThreads(filter = {}) {
    const key = 'quox_threads'
    const data = localStorage.getItem(key)
    let threads = data ? JSON.parse(data) : []

    if (filter.agent) {
      threads = threads.filter(t => t.agent === filter.agent)
    }
    if (filter.status) {
      threads = threads.filter(t => t.status === filter.status)
    }
    if (filter.parentId !== undefined) {
      threads = threads.filter(t => t.parentId === filter.parentId)
    }

    return threads.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  }

  /**
   * Add a message to a thread
   */
  addThreadMessage(threadId, message) {
    const key = 'quox_threads'
    const data = localStorage.getItem(key)
    const threads = data ? JSON.parse(data) : []
    const thread = threads.find(t => t.id === threadId)

    if (!thread) {
      return { success: false, error: 'Thread not found' }
    }

    const msg = {
      id: `msg_${Date.now()}`,
      role: message.role || 'user',
      content: message.content,
      agent: message.agent || thread.agent,
      timestamp: new Date().toISOString(),
      metadata: message.metadata || {}
    }

    thread.messages.push(msg)
    thread.updatedAt = new Date().toISOString()
    localStorage.setItem(key, JSON.stringify(threads))

    return { success: true, message: msg }
  }

  /**
   * Branch a thread at a specific message
   */
  branchThread(threadId, atMessageId, options = {}) {
    const parentThread = this.getThread(threadId)
    if (!parentThread) {
      return { success: false, error: 'Parent thread not found' }
    }

    const msgIndex = parentThread.messages.findIndex(m => m.id === atMessageId)
    if (msgIndex === -1) {
      return { success: false, error: 'Message not found in thread' }
    }

    // Create new thread with messages up to branch point
    const branchThread = this.createThread({
      parentId: threadId,
      title: options.title || `Branch of ${parentThread.title}`,
      agent: options.agent || parentThread.agent,
      metadata: {
        ...parentThread.metadata,
        branchedFrom: threadId,
        branchedAt: atMessageId,
        branchReason: options.reason || null
      },
      tags: [...(parentThread.tags || []), 'branch']
    })

    // Copy messages up to and including branch point
    const key = 'quox_threads'
    const data = localStorage.getItem(key)
    const threads = data ? JSON.parse(data) : []
    const newThread = threads.find(t => t.id === branchThread.id)

    if (newThread) {
      newThread.messages = parentThread.messages.slice(0, msgIndex + 1).map(m => ({
        ...m,
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      }))
      localStorage.setItem(key, JSON.stringify(threads))
    }

    return { success: true, thread: branchThread }
  }

  /**
   * Merge threads back together
   */
  mergeThreads(sourceThreadId, targetThreadId, options = {}) {
    const key = 'quox_threads'
    const data = localStorage.getItem(key)
    const threads = data ? JSON.parse(data) : []

    const source = threads.find(t => t.id === sourceThreadId)
    const target = threads.find(t => t.id === targetThreadId)

    if (!source || !target) {
      return { success: false, error: 'Thread not found' }
    }

    // Add merge marker
    target.messages.push({
      id: `msg_merge_${Date.now()}`,
      role: 'system',
      content: `[Merged from thread: ${source.title}]`,
      timestamp: new Date().toISOString(),
      metadata: { mergedFrom: sourceThreadId }
    })

    // Append source messages
    const startIndex = options.startFromMessage
      ? source.messages.findIndex(m => m.id === options.startFromMessage)
      : 0

    for (const msg of source.messages.slice(startIndex >= 0 ? startIndex : 0)) {
      target.messages.push({
        ...msg,
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        metadata: { ...msg.metadata, mergedFrom: sourceThreadId }
      })
    }

    target.updatedAt = new Date().toISOString()
    source.status = 'merged'
    source.metadata.mergedInto = targetThreadId

    localStorage.setItem(key, JSON.stringify(threads))
    return { success: true, target, source }
  }

  /**
   * Get thread context for continuing a conversation
   */
  getThreadContext(threadId, maxMessages = 10) {
    const thread = this.getThread(threadId)
    if (!thread) return null

    const recentMessages = thread.messages.slice(-maxMessages)

    // Build context including parent thread if this is a branch
    let parentContext = null
    if (thread.parentId) {
      const parent = this.getThread(thread.parentId)
      if (parent) {
        parentContext = {
          id: parent.id,
          title: parent.title,
          messageCount: parent.messages.length
        }
      }
    }

    // Get child branches
    const branches = this.getAllThreads({ parentId: threadId })

    return {
      thread: {
        id: thread.id,
        title: thread.title,
        agent: thread.agent,
        status: thread.status,
        messageCount: thread.messages.length
      },
      recentMessages,
      parentContext,
      branches: branches.map(b => ({
        id: b.id,
        title: b.title,
        messageCount: b.messages.length
      }))
    }
  }

  // ============================================
  // Memory Health Diagnostics
  // ============================================

  /**
   * Run comprehensive memory health check
   */
  runHealthCheck() {
    const health = {
      timestamp: new Date().toISOString(),
      overallScore: 100,
      issues: [],
      warnings: [],
      recommendations: [],
      metrics: {}
    }

    // Check storage usage
    const storageCheck = this.checkStorageHealth()
    health.metrics.storage = storageCheck
    if (storageCheck.usagePercent > 80) {
      health.issues.push({
        type: 'storage',
        severity: 'high',
        message: `Storage usage at ${storageCheck.usagePercent}%`
      })
      health.overallScore -= 20
    } else if (storageCheck.usagePercent > 60) {
      health.warnings.push({
        type: 'storage',
        message: `Storage usage at ${storageCheck.usagePercent}%`
      })
      health.overallScore -= 5
    }

    // Check memory quality
    const qualityCheck = this.checkMemoryQuality()
    health.metrics.quality = qualityCheck
    if (qualityCheck.lowImportanceRatio > 0.5) {
      health.warnings.push({
        type: 'quality',
        message: `${Math.round(qualityCheck.lowImportanceRatio * 100)}% of memories have low importance`
      })
      health.recommendations.push('Consider pruning low-importance memories')
      health.overallScore -= 10
    }

    // Check for duplicates
    const duplicates = this.findDuplicateMemories(0.7)
    health.metrics.duplicates = duplicates.length
    if (duplicates.length > 10) {
      health.warnings.push({
        type: 'duplicates',
        message: `Found ${duplicates.length} potential duplicate memories`
      })
      health.recommendations.push('Run memory consolidation to merge duplicates')
      health.overallScore -= 5
    }

    // Check for contradictions
    const contradictions = this.detectContradictions()
    health.metrics.contradictions = contradictions.length
    if (contradictions.length > 0) {
      health.issues.push({
        type: 'contradictions',
        severity: 'medium',
        message: `Found ${contradictions.length} contradicting memories`
      })
      health.recommendations.push('Review and resolve contradicting memories')
      health.overallScore -= contradictions.length * 2
    }

    // Check memory age distribution
    const ageCheck = this.checkMemoryAgeHealth()
    health.metrics.age = ageCheck
    if (ageCheck.staleRatio > 0.3) {
      health.warnings.push({
        type: 'staleness',
        message: `${Math.round(ageCheck.staleRatio * 100)}% of memories are stale (>30 days old)`
      })
      health.recommendations.push('Review and refresh stale memories')
      health.overallScore -= 5
    }

    // Check entity graph health
    const graphStats = this.getGraphStats()
    health.metrics.graph = graphStats
    if (graphStats.isolatedNodes > graphStats.totalNodes * 0.3) {
      health.warnings.push({
        type: 'graph',
        message: `${graphStats.isolatedNodes} entities have no relationships`
      })
      health.recommendations.push('Run relationship inference to connect isolated entities')
    }

    // Check feedback health
    const feedbackStats = this.getMemoryFeedbackStats()
    health.metrics.feedback = feedbackStats
    if (feedbackStats.totalFeedback > 20 && parseFloat(feedbackStats.usefulnessRate) < 0.5) {
      health.warnings.push({
        type: 'feedback',
        message: `Low usefulness rate: ${feedbackStats.usefulnessRate}`
      })
      health.recommendations.push('Review retrieval strategies - memories may not be relevant')
      health.overallScore -= 10
    }

    // Ensure score doesn't go below 0
    health.overallScore = Math.max(0, health.overallScore)

    // Store health check result
    localStorage.setItem('quox_last_health_check', JSON.stringify(health))

    return health
  }

  /**
   * Check storage health
   */
  checkStorageHealth() {
    let totalSize = 0
    const breakdown = {}

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('quox_')) {
        const value = localStorage.getItem(key)
        const size = new Blob([value]).size
        totalSize += size
        breakdown[key] = size
      }
    }

    // Estimate max storage (usually 5-10MB)
    const maxStorage = 5 * 1024 * 1024

    return {
      totalBytes: totalSize,
      totalKB: Math.round(totalSize / 1024),
      usagePercent: Math.round((totalSize / maxStorage) * 100),
      breakdown,
      largestKeys: Object.entries(breakdown)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([key, size]) => ({ key, sizeKB: Math.round(size / 1024) }))
    }
  }

  /**
   * Check memory quality metrics
   */
  checkMemoryQuality() {
    const metrics = {
      totalMemories: 0,
      byType: {},
      lowImportanceCount: 0,
      highImportanceCount: 0,
      withFeedback: 0,
      averageImportance: 0
    }

    let importanceSum = 0

    for (const type of MEMORY_TYPES_LOCAL) {
      const items = this.getLearnedItemsByType(type)
      metrics.byType[type] = items.length
      metrics.totalMemories += items.length

      for (const item of items) {
        const importance = item.importance || item.salience || 0.5
        importanceSum += importance

        if (importance < 0.3) metrics.lowImportanceCount++
        if (importance > 0.7) metrics.highImportanceCount++
        if (item.feedbackCount > 0) metrics.withFeedback++
      }
    }

    metrics.averageImportance = metrics.totalMemories > 0
      ? (importanceSum / metrics.totalMemories).toFixed(2)
      : 0
    metrics.lowImportanceRatio = metrics.totalMemories > 0
      ? metrics.lowImportanceCount / metrics.totalMemories
      : 0
    metrics.feedbackCoverage = metrics.totalMemories > 0
      ? (metrics.withFeedback / metrics.totalMemories).toFixed(2)
      : 0

    return metrics
  }

  /**
   * Check memory age distribution
   */
  checkMemoryAgeHealth() {
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const ages = {
      fresh: 0,      // < 7 days
      recent: 0,     // 7-30 days
      aging: 0,      // 30-90 days
      stale: 0       // > 90 days
    }

    let totalMemories = 0

    for (const type of MEMORY_TYPES_LOCAL) {
      const items = this.getLearnedItemsByType(type)
      for (const item of items) {
        totalMemories++
        const created = new Date(item.learnedAt || item.timestamp || 0).getTime()
        const ageDays = (now - created) / dayMs

        if (ageDays < 7) ages.fresh++
        else if (ageDays < 30) ages.recent++
        else if (ageDays < 90) ages.aging++
        else ages.stale++
      }
    }

    return {
      ...ages,
      total: totalMemories,
      staleRatio: totalMemories > 0 ? ages.stale / totalMemories : 0,
      freshRatio: totalMemories > 0 ? ages.fresh / totalMemories : 0
    }
  }

  /**
   * Get last health check result
   */
  getLastHealthCheck() {
    const data = localStorage.getItem('quox_last_health_check')
    return data ? JSON.parse(data) : null
  }

  /**
   * Get health trend over time
   */
  getHealthTrend(days = 7) {
    const key = 'quox_health_history'
    const data = localStorage.getItem(key)
    const history = data ? JSON.parse(data) : []

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    return history.filter(h => new Date(h.timestamp).getTime() > cutoff)
  }

  /**
   * Store health check in history
   */
  recordHealthCheck(healthResult) {
    const key = 'quox_health_history'
    const data = localStorage.getItem(key)
    const history = data ? JSON.parse(data) : []

    history.push({
      timestamp: healthResult.timestamp,
      score: healthResult.overallScore,
      issues: healthResult.issues.length,
      warnings: healthResult.warnings.length
    })

    // Keep last 30 checks
    localStorage.setItem(key, JSON.stringify(history.slice(-30)))
  }

  /**
   * Auto-fix common health issues
   */
  autoFixHealthIssues(options = {}) {
    const fixes = {
      applied: [],
      skipped: [],
      errors: []
    }

    const health = this.runHealthCheck()

    // Fix duplicates
    if (health.metrics.duplicates > 5 && options.fixDuplicates !== false) {
      try {
        const result = this.consolidateMemories(0.7)
        fixes.applied.push({
          type: 'duplicates',
          action: 'consolidated',
          count: result.merged
        })
      } catch (e) {
        fixes.errors.push({ type: 'duplicates', error: e.message })
      }
    }

    // Prune low importance (only if explicitly enabled)
    if (options.pruneLowImportance && health.metrics.quality.lowImportanceRatio > 0.4) {
      try {
        const result = this.pruneLowImportanceMemories(0.2, false)
        fixes.applied.push({
          type: 'pruning',
          action: 'removed low importance',
          count: result.pruned
        })
      } catch (e) {
        fixes.errors.push({ type: 'pruning', error: e.message })
      }
    }

    // Compress old episodic memories
    if (options.compressOld !== false) {
      try {
        const result = this.compressEpisodicMemories(7)
        fixes.applied.push({
          type: 'compression',
          action: 'compressed old episodic',
          count: result.compressed
        })
      } catch (e) {
        fixes.errors.push({ type: 'compression', error: e.message })
      }
    }

    // Infer relationships for isolated entities
    if (health.metrics.graph?.isolatedNodes > 5 && options.inferRelationships !== false) {
      try {
        const result = this.applyInferredRelationships()
        fixes.applied.push({
          type: 'relationships',
          action: 'inferred',
          count: result.applied
        })
      } catch (e) {
        fixes.errors.push({ type: 'relationships', error: e.message })
      }
    }

    // Record the health check
    this.recordHealthCheck(health)

    return fixes
  }

  // ============================================
  // Phase 6: Memory Versioning & History
  // ============================================

  /**
   * Create a versioned snapshot of a memory
   */
  createMemoryVersion(memoryId, type) {
    const items = this.getLearnedItemsByType(type)
    const item = items.find(i => i.id === memoryId)

    if (!item) {
      return { success: false, error: 'Memory not found' }
    }

    const key = 'quox_memory_versions'
    const data = localStorage.getItem(key)
    const versions = data ? JSON.parse(data) : {}

    if (!versions[memoryId]) {
      versions[memoryId] = []
    }

    const versionNumber = versions[memoryId].length + 1
    const version = {
      versionId: `v_${Date.now()}_${versionNumber}_${Math.random().toString(36).slice(2, 8)}`,
      versionNumber,
      snapshot: { ...item },
      createdAt: new Date().toISOString(),
      reason: null
    }

    versions[memoryId].push(version)

    // Keep last 10 versions per memory
    versions[memoryId] = versions[memoryId].slice(-10)

    localStorage.setItem(key, JSON.stringify(versions))
    return { success: true, version }
  }

  /**
   * Get version history for a memory
   */
  getMemoryVersions(memoryId) {
    const key = 'quox_memory_versions'
    const data = localStorage.getItem(key)
    const versions = data ? JSON.parse(data) : {}
    return versions[memoryId] || []
  }

  /**
   * Rollback memory to a specific version
   */
  rollbackMemory(memoryId, versionId, type) {
    const versions = this.getMemoryVersions(memoryId)
    const targetVersion = versions.find(v => v.versionId === versionId)

    if (!targetVersion) {
      return { success: false, error: 'Version not found' }
    }

    // Create a version of current state before rollback
    this.createMemoryVersion(memoryId, type)

    // Update the memory with the snapshot
    const key = `quox_learned_${type}`
    const data = localStorage.getItem(key)
    const items = data ? JSON.parse(data) : []

    const index = items.findIndex(i => i.id === memoryId)
    if (index >= 0) {
      items[index] = {
        ...targetVersion.snapshot,
        rolledBackAt: new Date().toISOString(),
        rolledBackFrom: versionId
      }
      localStorage.setItem(key, JSON.stringify(items))
      return { success: true, restoredVersion: targetVersion.versionNumber }
    }

    return { success: false, error: 'Memory not found for rollback' }
  }

  /**
   * Compare two versions of a memory
   */
  compareVersions(memoryId, versionId1, versionId2) {
    const versions = this.getMemoryVersions(memoryId)
    const v1 = versions.find(v => v.versionId === versionId1)
    const v2 = versions.find(v => v.versionId === versionId2)

    if (!v1 || !v2) {
      return { success: false, error: 'One or both versions not found' }
    }

    const changes = []
    const allKeys = new Set([...Object.keys(v1.snapshot), ...Object.keys(v2.snapshot)])

    for (const key of allKeys) {
      if (JSON.stringify(v1.snapshot[key]) !== JSON.stringify(v2.snapshot[key])) {
        changes.push({
          field: key,
          oldValue: v1.snapshot[key],
          newValue: v2.snapshot[key]
        })
      }
    }

    return {
      success: true,
      version1: { id: versionId1, number: v1.versionNumber, createdAt: v1.createdAt },
      version2: { id: versionId2, number: v2.versionNumber, createdAt: v2.createdAt },
      changes
    }
  }

  /**
   * Update memory with automatic versioning
   */
  updateMemoryWithVersion(memoryId, type, updates, reason = null) {
    // Create version before update
    const versionResult = this.createMemoryVersion(memoryId, type)

    if (!versionResult.success) {
      return versionResult
    }

    // Tag the version with reason
    if (reason) {
      const versions = this.getMemoryVersions(memoryId)
      const latest = versions[versions.length - 1]
      if (latest) {
        latest.reason = reason
        const key = 'quox_memory_versions'
        const data = localStorage.getItem(key)
        const allVersions = data ? JSON.parse(data) : {}
        allVersions[memoryId] = versions
        localStorage.setItem(key, JSON.stringify(allVersions))
      }
    }

    // Perform the update
    const updateResult = this.updateLearnedItem(type, memoryId, updates)

    return {
      success: !!updateResult,
      versionCreated: versionResult.version.versionNumber
    }
  }

  /**
   * Get memories with recent changes
   */
  getRecentlyModifiedMemories(days = 7, limit = 20) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const modified = []

    for (const type of MEMORY_TYPES_LOCAL) {
      const items = this.getLearnedItemsByType(type)
      for (const item of items) {
        const updatedAt = new Date(item.updatedAt || item.learnedAt || 0).getTime()
        if (updatedAt > cutoff) {
          const versions = this.getMemoryVersions(item.id)
          modified.push({
            ...item,
            memoryType: type,
            versionCount: versions.length,
            hasHistory: versions.length > 0
          })
        }
      }
    }

    return modified
      .sort((a, b) => new Date(b.updatedAt || b.learnedAt) - new Date(a.updatedAt || a.learnedAt))
      .slice(0, limit)
  }

  // ============================================
  // Adaptive Retrieval Strategies
  // ============================================

  /**
   * Query type classifications for retrieval optimization
   */
  static QUERY_TYPES = {
    FACTUAL: 'factual',           // "What is...", "How does..."
    PROCEDURAL: 'procedural',     // "How to...", "Steps to..."
    DIAGNOSTIC: 'diagnostic',     // "Why is...", "What caused..."
    COMPARATIVE: 'comparative',   // "Difference between...", "Compare..."
    TEMPORAL: 'temporal',         // "When did...", "Last time..."
    ENTITY: 'entity',             // Looking up specific hosts/services
    PREFERENCE: 'preference',     // User preferences and settings
    CONTEXTUAL: 'contextual'      // Needs conversation context
  }

  /**
   * Classify a query to determine optimal retrieval strategy
   */
  classifyQuery(query) {
    const q = (query || '').toLowerCase()
    const patterns = {
      [MemoryManager.QUERY_TYPES.PROCEDURAL]: [
        /how (do|can|to|should)/i,
        /steps to/i,
        /procedure for/i,
        /guide (for|to)/i,
        /setup|configure|install/i
      ],
      [MemoryManager.QUERY_TYPES.DIAGNOSTIC]: [
        /why (is|did|does|was)/i,
        /what caused/i,
        /reason for/i,
        /troubleshoot/i,
        /debug|error|fail|issue|problem/i
      ],
      [MemoryManager.QUERY_TYPES.COMPARATIVE]: [
        /difference between/i,
        /compare|versus|vs\./i,
        /which (is|should|would) (better|best)/i,
        /pros and cons/i
      ],
      [MemoryManager.QUERY_TYPES.TEMPORAL]: [
        /when (did|was|will)/i,
        /last time/i,
        /yesterday|today|this week|last week/i,
        /history of/i,
        /recently|lately/i
      ],
      [MemoryManager.QUERY_TYPES.ENTITY]: [
        /\b(docker|proxmox|grafana|nginx|redis)\d*\b/i,
        /192\.168\.\d+\.\d+/,
        /server|host|node|container|vm/i,
        /status of|check on/i
      ],
      [MemoryManager.QUERY_TYPES.PREFERENCE]: [
        /i (prefer|like|want|need)/i,
        /my (preference|setting|config)/i,
        /remember that i/i,
        /always|never|usually/i
      ],
      [MemoryManager.QUERY_TYPES.CONTEXTUAL]: [
        /what (we|i) (just|were)/i,
        /continue|follow up/i,
        /as i (said|mentioned)/i,
        /earlier|before/i
      ]
    }

    // Check each pattern
    const scores = {}
    for (const [type, patternList] of Object.entries(patterns)) {
      scores[type] = 0
      for (const pattern of patternList) {
        if (pattern.test(q)) {
          scores[type]++
        }
      }
    }

    // Find best match
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1])

    if (sorted[0][1] > 0) {
      return {
        primaryType: sorted[0][0],
        confidence: Math.min(1, sorted[0][1] / 2),
        allScores: scores
      }
    }

    // Default to factual
    return {
      primaryType: MemoryManager.QUERY_TYPES.FACTUAL,
      confidence: 0.3,
      allScores: scores
    }
  }

  /**
   * Get optimal retrieval strategy for a query type
   */
  getRetrievalStrategy(queryType) {
    const strategies = {
      [MemoryManager.QUERY_TYPES.FACTUAL]: {
        priorityTypes: ['fact', 'entity'],
        useVector: true,
        useKeyword: true,
        maxResults: 10,
        includeReflections: false,
        weightRecency: 0.2
      },
      [MemoryManager.QUERY_TYPES.PROCEDURAL]: {
        priorityTypes: ['runbook', 'decision', 'fact'],
        useVector: true,
        useKeyword: true,
        maxResults: 5,
        includeReflections: false,
        weightRecency: 0.1
      },
      [MemoryManager.QUERY_TYPES.DIAGNOSTIC]: {
        priorityTypes: ['error', 'fact', 'reflection'],
        useVector: true,
        useKeyword: true,
        maxResults: 15,
        includeReflections: true,
        weightRecency: 0.4
      },
      [MemoryManager.QUERY_TYPES.COMPARATIVE]: {
        priorityTypes: ['fact', 'decision', 'preference'],
        useVector: true,
        useKeyword: false,
        maxResults: 10,
        includeReflections: true,
        weightRecency: 0.1
      },
      [MemoryManager.QUERY_TYPES.TEMPORAL]: {
        priorityTypes: ['episodic', 'fact'],
        useVector: false,
        useKeyword: true,
        maxResults: 20,
        includeReflections: false,
        weightRecency: 0.8
      },
      [MemoryManager.QUERY_TYPES.ENTITY]: {
        priorityTypes: ['entity', 'fact', 'runbook'],
        useVector: true,
        useKeyword: true,
        maxResults: 8,
        includeReflections: false,
        weightRecency: 0.3
      },
      [MemoryManager.QUERY_TYPES.PREFERENCE]: {
        priorityTypes: ['preference', 'constraint', 'decision'],
        useVector: false,
        useKeyword: true,
        maxResults: 10,
        includeReflections: false,
        weightRecency: 0.1
      },
      [MemoryManager.QUERY_TYPES.CONTEXTUAL]: {
        priorityTypes: ['episodic', 'fact'],
        useVector: true,
        useKeyword: false,
        maxResults: 10,
        includeReflections: false,
        weightRecency: 0.9
      }
    }

    return strategies[queryType] || strategies[MemoryManager.QUERY_TYPES.FACTUAL]
  }

  /**
   * Perform adaptive retrieval based on query classification
   */
  adaptiveRetrieve(query, options = {}) {
    const classification = this.classifyQuery(query)
    const strategy = this.getRetrievalStrategy(classification.primaryType)

    const results = {
      classification,
      strategy,
      memories: [],
      entities: [],
      runbooks: [],
      recentContext: []
    }

    // Retrieve from priority types
    for (const type of strategy.priorityTypes) {
      if (type === 'episodic') {
        const recent = this.getRecentEvents(strategy.maxResults)
        results.recentContext = recent
      } else if (type === 'entity') {
        const entities = this.suggestRelatedEntities(query, 5)
        results.entities = entities.map(e => e.entity)
      } else if (type === 'runbook') {
        const runbooks = this.findRunbooks(query, 3)
        results.runbooks = runbooks
      } else if (MEMORY_TYPES_LOCAL.includes(type)) {
        const items = this.getLearnedItemsByType(type)
        const queryLower = query.toLowerCase()
        const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2)

        // Score and filter
        const scored = items.map(item => {
          const content = (item.content || '').toLowerCase()
          let score = 0

          // Keyword matching
          if (strategy.useKeyword) {
            score += queryWords.reduce((s, w) => s + (content.includes(w) ? 1 : 0), 0)
          }

          // Recency weighting
          const age = (Date.now() - new Date(item.learnedAt || 0).getTime()) / (1000 * 60 * 60 * 24)
          const recencyScore = Math.exp(-age / 30) * strategy.weightRecency
          score += recencyScore

          // Importance
          score += (item.importance || item.salience || 0.5) * 0.5

          return { ...item, memoryType: type, score }
        }).filter(item => item.score > 0.1)
          .sort((a, b) => b.score - a.score)
          .slice(0, strategy.maxResults)

        results.memories.push(...scored)
      }
    }

    // Sort all memories by score
    results.memories.sort((a, b) => b.score - a.score)
    results.memories = results.memories.slice(0, strategy.maxResults)

    // Include reflections if strategy says so
    if (strategy.includeReflections) {
      const reflections = this.getRelevantReflections(query, 3)
      results.reflections = reflections
    }

    // Record retrieval for learning
    this.recordRetrievalAttempt(query, classification, results)

    return results
  }

  /**
   * Record retrieval attempt for adaptive learning
   */
  recordRetrievalAttempt(query, classification, results) {
    const key = 'quox_retrieval_history'
    const data = localStorage.getItem(key)
    const history = data ? JSON.parse(data) : []

    history.push({
      timestamp: new Date().toISOString(),
      query: query.substring(0, 100),
      queryType: classification.primaryType,
      confidence: classification.confidence,
      resultCount: results.memories.length,
      feedbackPending: true
    })

    // Keep last 200 attempts
    localStorage.setItem(key, JSON.stringify(history.slice(-200)))
  }

  /**
   * Record feedback on retrieval results
   */
  recordRetrievalFeedback(query, helpful, details = {}) {
    const key = 'quox_retrieval_feedback'
    const data = localStorage.getItem(key)
    const feedback = data ? JSON.parse(data) : []

    const classification = this.classifyQuery(query)

    feedback.push({
      timestamp: new Date().toISOString(),
      queryType: classification.primaryType,
      helpful,
      details
    })

    localStorage.setItem(key, JSON.stringify(feedback.slice(-500)))

    // Update strategy effectiveness
    this.updateStrategyEffectiveness(classification.primaryType, helpful)
  }

  /**
   * Update strategy effectiveness based on feedback
   */
  updateStrategyEffectiveness(queryType, helpful) {
    const key = 'quox_strategy_stats'
    const data = localStorage.getItem(key)
    const stats = data ? JSON.parse(data) : {}

    if (!stats[queryType]) {
      stats[queryType] = { total: 0, helpful: 0 }
    }

    stats[queryType].total++
    if (helpful) stats[queryType].helpful++

    localStorage.setItem(key, JSON.stringify(stats))
  }

  /**
   * Get retrieval strategy effectiveness stats
   */
  getStrategyStats() {
    const key = 'quox_strategy_stats'
    const data = localStorage.getItem(key)
    const stats = data ? JSON.parse(data) : {}

    const result = {}
    for (const [type, s] of Object.entries(stats)) {
      result[type] = {
        ...s,
        effectiveness: s.total > 0 ? (s.helpful / s.total).toFixed(2) : 'N/A'
      }
    }

    return result
  }

  // ============================================
  // Temporal Reasoning
  // ============================================

  /**
   * Parse temporal expressions from query
   */
  parseTemporalExpression(query) {
    const now = new Date()
    const q = query.toLowerCase()

    const expressions = {
      today: { start: new Date(now.setHours(0, 0, 0, 0)), end: new Date() },
      yesterday: (() => {
        const d = new Date()
        d.setDate(d.getDate() - 1)
        d.setHours(0, 0, 0, 0)
        const end = new Date(d)
        end.setHours(23, 59, 59, 999)
        return { start: d, end }
      })(),
      'this week': (() => {
        const d = new Date()
        const day = d.getDay()
        d.setDate(d.getDate() - day)
        d.setHours(0, 0, 0, 0)
        return { start: d, end: new Date() }
      })(),
      'last week': (() => {
        const d = new Date()
        const day = d.getDay()
        d.setDate(d.getDate() - day - 7)
        d.setHours(0, 0, 0, 0)
        const end = new Date(d)
        end.setDate(end.getDate() + 6)
        end.setHours(23, 59, 59, 999)
        return { start: d, end }
      })(),
      'this month': (() => {
        const d = new Date()
        d.setDate(1)
        d.setHours(0, 0, 0, 0)
        return { start: d, end: new Date() }
      })(),
      'last month': (() => {
        const d = new Date()
        d.setMonth(d.getMonth() - 1)
        d.setDate(1)
        d.setHours(0, 0, 0, 0)
        const end = new Date(d)
        end.setMonth(end.getMonth() + 1)
        end.setDate(0)
        end.setHours(23, 59, 59, 999)
        return { start: d, end }
      })(),
      recently: (() => {
        const d = new Date()
        d.setDate(d.getDate() - 3)
        return { start: d, end: new Date() }
      })(),
      'last few days': (() => {
        const d = new Date()
        d.setDate(d.getDate() - 3)
        return { start: d, end: new Date() }
      })()
    }

    // Check for relative day patterns
    const daysAgoMatch = q.match(/(\d+)\s*days?\s*ago/)
    if (daysAgoMatch) {
      const days = parseInt(daysAgoMatch[1])
      const d = new Date()
      d.setDate(d.getDate() - days)
      d.setHours(0, 0, 0, 0)
      const end = new Date(d)
      end.setHours(23, 59, 59, 999)
      return { expression: `${days} days ago`, timeRange: { start: d, end } }
    }

    // Check for week patterns
    const weeksAgoMatch = q.match(/(\d+)\s*weeks?\s*ago/)
    if (weeksAgoMatch) {
      const weeks = parseInt(weeksAgoMatch[1])
      const d = new Date()
      d.setDate(d.getDate() - weeks * 7)
      d.setHours(0, 0, 0, 0)
      const end = new Date(d)
      end.setDate(end.getDate() + 6)
      end.setHours(23, 59, 59, 999)
      return { expression: `${weeks} weeks ago`, timeRange: { start: d, end } }
    }

    // Check predefined expressions
    for (const [expr, range] of Object.entries(expressions)) {
      if (q.includes(expr)) {
        return { expression: expr, timeRange: range }
      }
    }

    return null
  }

  /**
   * Query memories within a time range
   */
  queryByTimeRange(startDate, endDate, options = {}) {
    const start = new Date(startDate).getTime()
    const end = new Date(endDate).getTime()
    const results = {
      memories: [],
      episodic: [],
      entities: []
    }

    // Search learned memories
    if (options.includeMemories !== false) {
      for (const type of MEMORY_TYPES_LOCAL) {
        const items = this.getLearnedItemsByType(type)
        for (const item of items) {
          const ts = new Date(item.learnedAt || item.timestamp || 0).getTime()
          if (ts >= start && ts <= end) {
            results.memories.push({ ...item, memoryType: type })
          }
        }
      }
    }

    // Search episodic logs
    if (options.includeEpisodic !== false) {
      const episodicData = localStorage.getItem('quox_episodic')
      const episodic = episodicData ? JSON.parse(episodicData) : []
      for (const entry of episodic) {
        const ts = new Date(entry.timestamp || 0).getTime()
        if (ts >= start && ts <= end) {
          results.episodic.push(entry)
        }
      }
    }

    // Search entities by last seen
    if (options.includeEntities !== false) {
      const entities = this.getAllEntities()
      for (const entity of entities) {
        const ts = new Date(entity.lastSeen || entity.createdAt || 0).getTime()
        if (ts >= start && ts <= end) {
          results.entities.push(entity)
        }
      }
    }

    // Sort by timestamp
    results.memories.sort((a, b) =>
      new Date(b.learnedAt || b.timestamp) - new Date(a.learnedAt || a.timestamp))
    results.episodic.sort((a, b) =>
      new Date(b.timestamp) - new Date(a.timestamp))

    return results
  }

  /**
   * Perform temporal query with natural language parsing
   */
  temporalQuery(query, options = {}) {
    const temporal = this.parseTemporalExpression(query)

    if (!temporal) {
      return {
        success: false,
        error: 'No temporal expression found in query',
        suggestion: 'Try using phrases like "yesterday", "last week", "3 days ago"'
      }
    }

    const results = this.queryByTimeRange(
      temporal.timeRange.start,
      temporal.timeRange.end,
      options
    )

    // Extract keywords from query (excluding temporal words)
    const temporalWords = ['today', 'yesterday', 'week', 'month', 'ago', 'last', 'this', 'recent']
    const keywords = query.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2 && !temporalWords.includes(w))

    // Filter by keywords if present
    if (keywords.length > 0) {
      results.memories = results.memories.filter(m => {
        const content = (m.content || '').toLowerCase()
        return keywords.some(kw => content.includes(kw))
      })
      results.episodic = results.episodic.filter(e => {
        const content = ((e.query || '') + ' ' + (e.response || '')).toLowerCase()
        return keywords.some(kw => content.includes(kw))
      })
    }

    return {
      success: true,
      temporal,
      results,
      summary: {
        memoriesFound: results.memories.length,
        episodicFound: results.episodic.length,
        entitiesFound: results.entities.length,
        timeRange: `${temporal.timeRange.start.toLocaleDateString()} - ${temporal.timeRange.end.toLocaleDateString()}`
      }
    }
  }

  /**
   * Get activity summary for a time period
   */
  getActivitySummary(days = 7) {
    const endDate = new Date()
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - days)

    const results = this.queryByTimeRange(startDate, endDate)

    const summary = {
      period: { start: startDate, end: endDate, days },
      counts: {
        memories: results.memories.length,
        conversations: results.episodic.length,
        entities: results.entities.length
      },
      byType: {},
      byDay: {},
      topTopics: {}
    }

    // Count by type
    for (const mem of results.memories) {
      const type = mem.memoryType
      summary.byType[type] = (summary.byType[type] || 0) + 1
    }

    // Count by day
    for (const entry of results.episodic) {
      const day = new Date(entry.timestamp).toLocaleDateString()
      summary.byDay[day] = (summary.byDay[day] || 0) + 1
    }

    // Extract topics
    const words = {}
    const stopWords = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'are', 'was', 'were'])

    for (const entry of results.episodic) {
      const text = (entry.query || '').toLowerCase()
      for (const word of text.split(/\s+/)) {
        if (word.length > 3 && !stopWords.has(word)) {
          words[word] = (words[word] || 0) + 1
        }
      }
    }

    summary.topTopics = Object.entries(words)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .reduce((obj, [k, v]) => ({ ...obj, [k]: v }), {})

    return summary
  }

  // ============================================
  // Memory Clustering
  // ============================================

  /**
   * Calculate similarity between two texts using Jaccard with n-grams
   */
  calculateClusterSimilarity(text1, text2) {
    const getNgrams = (text, n = 2) => {
      const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 2)
      const ngrams = new Set()
      for (let i = 0; i <= words.length - n; i++) {
        ngrams.add(words.slice(i, i + n).join(' '))
      }
      // Also add individual words
      words.forEach(w => ngrams.add(w))
      return ngrams
    }

    const ngrams1 = getNgrams(text1)
    const ngrams2 = getNgrams(text2)

    if (ngrams1.size === 0 || ngrams2.size === 0) return 0

    let intersection = 0
    for (const ng of ngrams1) {
      if (ngrams2.has(ng)) intersection++
    }

    return intersection / (ngrams1.size + ngrams2.size - intersection)
  }

  /**
   * Cluster memories by similarity
   */
  clusterMemories(options = {}) {
    const threshold = options.threshold || 0.3
    const maxClusters = options.maxClusters || 20
    const types = options.types || MEMORY_TYPES_LOCAL

    // Gather all memories
    const allMemories = []
    for (const type of types) {
      const items = this.getLearnedItemsByType(type)
      for (const item of items) {
        if (item.content) {
          allMemories.push({ ...item, memoryType: type })
        }
      }
    }

    if (allMemories.length === 0) {
      return { clusters: [], unclustered: [] }
    }

    // Simple greedy clustering
    const clusters = []
    const assigned = new Set()

    for (let i = 0; i < allMemories.length && clusters.length < maxClusters; i++) {
      if (assigned.has(i)) continue

      const cluster = {
        id: `cluster_${Date.now()}_${i}`,
        centroid: allMemories[i],
        members: [allMemories[i]],
        memberIds: [allMemories[i].id]
      }
      assigned.add(i)

      // Find similar memories
      for (let j = i + 1; j < allMemories.length; j++) {
        if (assigned.has(j)) continue

        const similarity = this.calculateClusterSimilarity(
          allMemories[i].content,
          allMemories[j].content
        )

        if (similarity >= threshold) {
          cluster.members.push(allMemories[j])
          cluster.memberIds.push(allMemories[j].id)
          assigned.add(j)
        }
      }

      // Only keep clusters with more than one member
      if (cluster.members.length > 1) {
        // Generate cluster label
        cluster.label = this.generateClusterLabel(cluster.members)
        cluster.size = cluster.members.length
        clusters.push(cluster)
      }
    }

    // Get unclustered memories
    const unclustered = allMemories.filter((_, i) => !assigned.has(i))

    return {
      clusters: clusters.sort((a, b) => b.size - a.size),
      unclustered,
      stats: {
        totalMemories: allMemories.length,
        clusteredCount: allMemories.length - unclustered.length,
        clusterCount: clusters.length,
        averageClusterSize: clusters.length > 0
          ? (clusters.reduce((s, c) => s + c.size, 0) / clusters.length).toFixed(1)
          : 0
      }
    }
  }

  /**
   * Generate a label for a cluster based on common words
   */
  generateClusterLabel(members) {
    const wordCounts = {}
    const stopWords = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'are', 'was', 'were', 'been', 'being', 'will', 'would', 'could', 'should'])

    for (const mem of members) {
      const words = (mem.content || '').toLowerCase().split(/\s+/)
      const seen = new Set()
      for (const word of words) {
        if (word.length > 3 && !stopWords.has(word) && !seen.has(word)) {
          wordCounts[word] = (wordCounts[word] || 0) + 1
          seen.add(word)
        }
      }
    }

    // Get words that appear in most members
    const threshold = members.length * 0.5
    const commonWords = Object.entries(wordCounts)
      .filter(([_, count]) => count >= threshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([word]) => word)

    return commonWords.length > 0 ? commonWords.join(', ') : 'Miscellaneous'
  }

  /**
   * Find the cluster a memory belongs to
   */
  findMemoryCluster(memoryId) {
    const clustering = this.clusterMemories()

    for (const cluster of clustering.clusters) {
      if (cluster.memberIds.includes(memoryId)) {
        return {
          found: true,
          cluster,
          relatedMemories: cluster.members.filter(m => m.id !== memoryId)
        }
      }
    }

    return { found: false, cluster: null, relatedMemories: [] }
  }

  /**
   * Get suggested clusters for organizing memories
   */
  suggestMemoryOrganization() {
    const clustering = this.clusterMemories({ threshold: 0.25 })

    const suggestions = []

    // Large clusters might need splitting
    for (const cluster of clustering.clusters) {
      if (cluster.size > 10) {
        suggestions.push({
          type: 'split',
          cluster: cluster.label,
          reason: `Cluster "${cluster.label}" has ${cluster.size} items - consider splitting`,
          affectedCount: cluster.size
        })
      }
    }

    // Many unclustered items might need review
    if (clustering.unclustered.length > clustering.stats.totalMemories * 0.3) {
      suggestions.push({
        type: 'review',
        reason: `${clustering.unclustered.length} memories are not clustered - consider adding tags or consolidating`,
        affectedCount: clustering.unclustered.length
      })
    }

    // Clusters with similar labels might be mergeable
    const labels = clustering.clusters.map(c => c.label.split(', '))
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const overlap = labels[i].filter(w => labels[j].includes(w))
        if (overlap.length > 0) {
          suggestions.push({
            type: 'merge',
            clusters: [clustering.clusters[i].label, clustering.clusters[j].label],
            reason: `Clusters share common topic: "${overlap.join(', ')}"`,
            affectedCount: clustering.clusters[i].size + clustering.clusters[j].size
          })
        }
      }
    }

    return {
      clustering: clustering.stats,
      suggestions
    }
  }

  /**
   * Auto-tag memories based on cluster analysis
   */
  autoTagMemories(options = {}) {
    const clustering = this.clusterMemories(options)
    const tagged = []

    for (const cluster of clustering.clusters) {
      const tags = cluster.label.split(', ').map(t => t.trim())

      for (const member of cluster.members) {
        // Update memory with cluster tags
        const currentTags = member.tags || []
        const newTags = [...new Set([...currentTags, ...tags, `cluster:${cluster.id}`])]

        if (JSON.stringify(currentTags) !== JSON.stringify(newTags)) {
          this.updateLearnedItem(member.memoryType, member.id, { tags: newTags })
          tagged.push({
            memoryId: member.id,
            addedTags: tags
          })
        }
      }
    }

    return {
      clustersProcessed: clustering.clusters.length,
      memoriesTagged: tagged.length,
      details: tagged
    }
  }

  // ============================================
  // Phase 7: Enhanced Cross-Encoder Reranking
  // ============================================

  /**
   * Calculate enhanced cross-encoder style relevance score between query and document
   * Uses multiple signals: lexical overlap, semantic indicators, position, freshness
   * This is an enhanced version that includes metadata signals (timestamp, importance, access)
   */
  enhancedCrossEncoderScore(query, document, metadata = {}) {
    const queryLower = query.toLowerCase()
    const docLower = (document || '').toLowerCase()

    // Tokenize
    const queryTokens = queryLower.split(/\s+/).filter(t => t.length > 2)
    const docTokens = docLower.split(/\s+/).filter(t => t.length > 2)

    if (queryTokens.length === 0 || docTokens.length === 0) {
      return { score: 0, signals: {} }
    }

    const signals = {}

    // 1. Exact match ratio
    const exactMatches = queryTokens.filter(t => docTokens.includes(t)).length
    signals.exactMatch = exactMatches / queryTokens.length

    // 2. Fuzzy match (substring containment)
    let fuzzyMatches = 0
    for (const qt of queryTokens) {
      if (docLower.includes(qt) || queryTokens.some(dt => dt.includes(qt) && dt !== qt)) {
        fuzzyMatches++
      }
    }
    signals.fuzzyMatch = fuzzyMatches / queryTokens.length

    // 3. Query coverage in document (how much of query appears)
    const queryBigrams = this._getNgrams(queryLower, 2)
    const docBigrams = this._getNgrams(docLower, 2)
    const bigramOverlap = [...queryBigrams].filter(b => docBigrams.has(b)).length
    signals.bigramCoverage = queryBigrams.size > 0 ? bigramOverlap / queryBigrams.size : 0

    // 4. Position signal (matches earlier in doc score higher)
    let positionScore = 0
    for (const qt of queryTokens) {
      const pos = docLower.indexOf(qt)
      if (pos !== -1) {
        positionScore += 1 - (pos / Math.max(docLower.length, 1))
      }
    }
    signals.position = queryTokens.length > 0 ? positionScore / queryTokens.length : 0

    // 5. Length penalty (prefer concise, relevant matches)
    const idealLength = queryTokens.length * 10
    const lengthRatio = Math.min(docTokens.length, idealLength * 3) / (idealLength * 3)
    signals.lengthPenalty = 1 - Math.abs(0.3 - lengthRatio)

    // 6. Freshness signal
    if (metadata.timestamp) {
      const age = Date.now() - new Date(metadata.timestamp).getTime()
      const dayMs = 24 * 60 * 60 * 1000
      signals.freshness = Math.max(0, 1 - (age / (30 * dayMs))) // Decay over 30 days
    } else {
      signals.freshness = 0.5
    }

    // 7. Importance signal
    signals.importance = metadata.importance || 0.5

    // 8. Access frequency boost
    signals.accessBoost = Math.min(1, (metadata.accessCount || 0) / 10)

    // Weighted combination
    const weights = {
      exactMatch: 0.25,
      fuzzyMatch: 0.10,
      bigramCoverage: 0.20,
      position: 0.10,
      lengthPenalty: 0.05,
      freshness: 0.10,
      importance: 0.15,
      accessBoost: 0.05
    }

    let score = 0
    for (const [signal, weight] of Object.entries(weights)) {
      score += (signals[signal] || 0) * weight
    }

    return { score: Math.min(1, Math.max(0, score)), signals }
  }

  /**
   * Helper to get n-grams from text
   */
  _getNgrams(text, n) {
    const words = text.split(/\s+/).filter(w => w.length > 1)
    const ngrams = new Set()
    for (let i = 0; i <= words.length - n; i++) {
      ngrams.add(words.slice(i, i + n).join(' '))
    }
    return ngrams
  }

  /**
   * Rerank search results using enhanced cross-encoder scoring
   */
  enhancedCrossEncoderRerank(query, results, options = {}) {
    const { topK = 10, minScore = 0.1, includeSignals = false } = options

    const scored = results.map(result => {
      const content = result.content || result.text || ''
      const metadata = {
        timestamp: result.timestamp || result.learnedAt,
        importance: result.importance || result.salience,
        accessCount: result.accessCount || 0
      }

      const { score, signals } = this.enhancedCrossEncoderScore(query, content, metadata)

      return {
        ...result,
        crossEncoderScore: score,
        originalScore: result.score || result.similarity || 0,
        combinedScore: (score * 0.6) + ((result.score || result.similarity || 0) * 0.4),
        ...(includeSignals ? { rerankerSignals: signals } : {})
      }
    })

    // Sort by combined score
    scored.sort((a, b) => b.combinedScore - a.combinedScore)

    // Filter and limit
    return scored
      .filter(r => r.combinedScore >= minScore)
      .slice(0, topK)
  }

  /**
   * Enhanced hybrid search with enhanced cross-encoder reranking
   */
  async enhancedHybridSearch(query, options = {}) {
    const { rerankTopK = 20, finalTopK = 10 } = options

    // Get initial results from hybrid search
    const hybridResults = await this.hybridSearch(query, rerankTopK)

    // Rerank with enhanced cross-encoder
    const reranked = this.enhancedCrossEncoderRerank(query, hybridResults, {
      topK: finalTopK,
      includeSignals: options.includeSignals
    })

    return reranked
  }

  // ============================================
  // Phase 7: Memory Importance Decay
  // ============================================

  /**
   * Calculate decayed importance for a memory based on age and access patterns
   */
  calculateDecayedImportance(memory) {
    const baseImportance = memory.importance || memory.salience || 0.5
    const createdAt = new Date(memory.learnedAt || memory.timestamp || Date.now())
    const lastAccessed = new Date(memory.lastAccessedAt || createdAt)

    const now = Date.now()
    const ageMs = now - createdAt.getTime()
    const lastAccessMs = now - lastAccessed.getTime()

    const dayMs = 24 * 60 * 60 * 1000

    // Base decay: importance decays over time
    // Half-life of 30 days for base decay
    const halfLife = 30 * dayMs
    const ageDecay = Math.pow(0.5, ageMs / halfLife)

    // Access reinforcement: recent access slows decay
    // If accessed recently, boost importance
    const accessRecency = Math.max(0, 1 - (lastAccessMs / (7 * dayMs)))
    const accessCount = memory.accessCount || 0
    const accessBoost = Math.min(0.5, accessCount * 0.05) + (accessRecency * 0.3)

    // Type-based decay rates (some memories decay slower)
    const typeDecayRates = {
      constraint: 0.1,    // Constraints decay very slowly
      preference: 0.3,    // Preferences decay slowly
      fact: 0.5,          // Facts decay at normal rate
      decision: 0.6,      // Decisions decay faster
      error: 0.7,         // Errors decay faster (unless reinforced)
      runbook: 0.2        // Runbooks decay slowly
    }
    const typeRate = typeDecayRates[memory.type] || 0.5

    // Calculate final importance
    const decayedBase = baseImportance * (ageDecay * typeRate + (1 - typeRate))
    const finalImportance = Math.min(1, decayedBase + accessBoost)

    return {
      original: baseImportance,
      decayed: finalImportance,
      factors: {
        ageDecay,
        accessRecency,
        accessBoost,
        typeRate,
        ageDays: Math.floor(ageMs / dayMs),
        daysSinceAccess: Math.floor(lastAccessMs / dayMs)
      }
    }
  }

  /**
   * Record memory access and reinforce importance
   */
  recordMemoryAccess(memoryId, type) {
    const key = `quox_learned_${type}`
    const data = localStorage.getItem(key)
    if (!data) return false

    const items = JSON.parse(data)
    const index = items.findIndex(i => i.id === memoryId)
    if (index === -1) return false

    const item = items[index]
    items[index] = {
      ...item,
      accessCount: (item.accessCount || 0) + 1,
      lastAccessedAt: new Date().toISOString()
    }

    localStorage.setItem(key, JSON.stringify(items))
    return true
  }

  /**
   * Get memories sorted by decayed importance
   */
  getMemoriesByDecayedImportance(type = null, options = {}) {
    const { minImportance = 0, limit = 50 } = options
    const results = []

    const types = type ? [type] : MEMORY_TYPES_LOCAL

    for (const t of types) {
      const items = this.getLearnedItemsByType(t)
      for (const item of items) {
        const decay = this.calculateDecayedImportance({ ...item, type: t })
        if (decay.decayed >= minImportance) {
          results.push({
            ...item,
            type: t,
            decayedImportance: decay.decayed,
            decayFactors: decay.factors
          })
        }
      }
    }

    results.sort((a, b) => b.decayedImportance - a.decayedImportance)
    return results.slice(0, limit)
  }

  /**
   * Prune low-importance memories that have decayed below threshold
   */
  pruneDecayedMemories(threshold = 0.1, options = {}) {
    const { dryRun = false, maxPrune = 100 } = options
    const pruned = []

    for (const type of MEMORY_TYPES_LOCAL) {
      const items = this.getLearnedItemsByType(type)

      for (const item of items) {
        if (pruned.length >= maxPrune) break

        const decay = this.calculateDecayedImportance({ ...item, type })

        if (decay.decayed < threshold) {
          pruned.push({
            id: item.id,
            type,
            content: item.content?.substring(0, 50),
            decayedImportance: decay.decayed,
            factors: decay.factors
          })

          if (!dryRun) {
            // Create version before deletion
            this.createMemoryVersion(item.id, type)
            this.deleteLearnedItem(type, item.id)
          }
        }
      }
    }

    return {
      prunedCount: pruned.length,
      dryRun,
      threshold,
      pruned
    }
  }

  // ============================================
  // Phase 7: Contextual Memory Compression
  // ============================================

  /**
   * Extract key information from memory content
   */
  extractKeyInfo(content) {
    if (!content || typeof content !== 'string') {
      return { keywords: [], entities: [], summary: '' }
    }

    const words = content.toLowerCase().split(/\s+/)
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
      'into', 'through', 'during', 'before', 'after', 'above', 'below',
      'between', 'under', 'again', 'further', 'then', 'once', 'here',
      'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few',
      'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
      'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
      'and', 'but', 'if', 'or', 'because', 'until', 'while', 'this',
      'that', 'these', 'those', 'what', 'which', 'who', 'whom'
    ])

    // Extract keywords (non-stopwords with frequency)
    const wordFreq = {}
    for (const word of words) {
      const clean = word.replace(/[^a-z0-9]/g, '')
      if (clean.length > 2 && !stopWords.has(clean)) {
        wordFreq[clean] = (wordFreq[clean] || 0) + 1
      }
    }

    const keywords = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word)

    // Extract potential entities (capitalized words, IPs, paths)
    const entities = []
    const entityPatterns = [
      /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g,  // Capitalized names
      /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,  // IP addresses
      /\/[\w\-\/]+/g,  // File paths
      /\b[a-z]+\d+\b/gi,  // Host names like docker01
      /\b[A-Z_]+\b/g  // Constants
    ]

    for (const pattern of entityPatterns) {
      const matches = content.match(pattern) || []
      entities.push(...matches.slice(0, 5))
    }

    // Create summary (first sentence or truncated)
    const firstSentence = content.match(/^[^.!?]+[.!?]/)
    const summary = firstSentence
      ? firstSentence[0].trim()
      : content.substring(0, 100).trim() + (content.length > 100 ? '...' : '')

    return {
      keywords: [...new Set(keywords)],
      entities: [...new Set(entities)].slice(0, 10),
      summary
    }
  }

  /**
   * Compress a memory to essential information
   */
  compressMemory(memory) {
    const content = memory.content || ''
    const keyInfo = this.extractKeyInfo(content)

    const compressed = {
      id: memory.id,
      type: memory.type,
      summary: keyInfo.summary,
      keywords: keyInfo.keywords,
      entities: keyInfo.entities,
      importance: memory.importance,
      originalLength: content.length,
      compressedAt: new Date().toISOString(),
      learnedAt: memory.learnedAt,
      accessCount: memory.accessCount || 0
    }

    // Calculate compression ratio
    const compressedLength = JSON.stringify(compressed).length
    compressed.compressionRatio = content.length > 0
      ? (1 - compressedLength / content.length).toFixed(2)
      : 0

    return compressed
  }

  /**
   * Compress old memories to save space while preserving key information
   */
  compressOldMemories(options = {}) {
    const {
      ageDays = 30,
      minLength = 200,
      dryRun = false,
      preserveHighImportance = true,
      importanceThreshold = 0.8
    } = options

    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - ageDays)

    const compressed = []
    const key = 'quox_compressed_memories'
    const existingData = localStorage.getItem(key)
    const compressedStore = existingData ? JSON.parse(existingData) : []

    for (const type of MEMORY_TYPES_LOCAL) {
      const items = this.getLearnedItemsByType(type)

      for (const item of items) {
        const learnedAt = new Date(item.learnedAt || item.timestamp || Date.now())
        const contentLength = (item.content || '').length

        // Check if should compress
        if (learnedAt < cutoffDate && contentLength >= minLength) {
          // Skip high importance if preserving
          if (preserveHighImportance && (item.importance || 0) >= importanceThreshold) {
            continue
          }

          const compressedMemory = this.compressMemory({ ...item, type })
          compressed.push(compressedMemory)

          if (!dryRun) {
            // Store compressed version
            compressedStore.push(compressedMemory)

            // Update original with compressed flag and summary
            this.updateLearnedItem(type, item.id, {
              compressed: true,
              compressedAt: compressedMemory.compressedAt,
              originalContent: item.content,
              content: compressedMemory.summary
            })
          }
        }
      }
    }

    if (!dryRun && compressed.length > 0) {
      localStorage.setItem(key, JSON.stringify(compressedStore))
    }

    return {
      compressedCount: compressed.length,
      dryRun,
      ageDays,
      minLength,
      compressed: compressed.map(c => ({
        id: c.id,
        type: c.type,
        originalLength: c.originalLength,
        compressionRatio: c.compressionRatio
      }))
    }
  }

  /**
   * Restore a compressed memory to full content
   */
  restoreCompressedMemory(memoryId, type) {
    const items = this.getLearnedItemsByType(type)
    const item = items.find(i => i.id === memoryId)

    if (!item) {
      return { success: false, error: 'Memory not found' }
    }

    if (!item.compressed || !item.originalContent) {
      return { success: false, error: 'Memory is not compressed or original not available' }
    }

    this.updateLearnedItem(type, memoryId, {
      content: item.originalContent,
      compressed: false,
      compressedAt: null,
      originalContent: null,
      restoredAt: new Date().toISOString()
    })

    return { success: true, restoredLength: item.originalContent.length }
  }

  /**
   * Get memory compression statistics (for learned memories)
   */
  getMemoryCompressionStats() {
    const stats = {
      totalMemories: 0,
      compressedMemories: 0,
      originalTotalSize: 0,
      currentTotalSize: 0,
      spaceSaved: 0,
      byType: {}
    }

    for (const type of MEMORY_TYPES_LOCAL) {
      const items = this.getLearnedItemsByType(type)
      stats.byType[type] = { total: 0, compressed: 0, sizeSaved: 0 }

      for (const item of items) {
        stats.totalMemories++
        stats.byType[type].total++

        const currentSize = (item.content || '').length
        stats.currentTotalSize += currentSize

        if (item.compressed && item.originalContent) {
          stats.compressedMemories++
          stats.byType[type].compressed++

          const originalSize = item.originalContent.length
          stats.originalTotalSize += originalSize
          stats.byType[type].sizeSaved += originalSize - currentSize
          stats.spaceSaved += originalSize - currentSize
        } else {
          stats.originalTotalSize += currentSize
        }
      }
    }

    stats.compressionRatio = stats.originalTotalSize > 0
      ? ((stats.spaceSaved / stats.originalTotalSize) * 100).toFixed(1) + '%'
      : '0%'

    return stats
  }

  // ============================================
  // Phase 7: Memory Graph Relationships
  // ============================================

  /**
   * Create a relationship between two memories
   */
  createMemoryRelationship(sourceId, targetId, relationshipType, metadata = {}) {
    const key = 'quox_memory_relationships'
    const data = localStorage.getItem(key)
    const relationships = data ? JSON.parse(data) : []

    // Check for existing relationship
    const existing = relationships.find(r =>
      r.sourceId === sourceId &&
      r.targetId === targetId &&
      r.type === relationshipType
    )

    if (existing) {
      // Update existing
      existing.strength = Math.min(1, (existing.strength || 0.5) + 0.1)
      existing.updatedAt = new Date().toISOString()
      existing.metadata = { ...existing.metadata, ...metadata }
    } else {
      // Create new
      relationships.push({
        id: `rel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sourceId,
        targetId,
        type: relationshipType,
        strength: metadata.strength || 0.5,
        createdAt: new Date().toISOString(),
        metadata
      })
    }

    localStorage.setItem(key, JSON.stringify(relationships))
    return { success: true }
  }

  /**
   * Get relationships for a memory
   */
  getMemoryRelationships(memoryId, options = {}) {
    const { direction = 'both', type = null, minStrength = 0 } = options
    const key = 'quox_memory_relationships'
    const data = localStorage.getItem(key)
    const relationships = data ? JSON.parse(data) : []

    return relationships.filter(r => {
      const matchesSource = direction !== 'incoming' && r.sourceId === memoryId
      const matchesTarget = direction !== 'outgoing' && r.targetId === memoryId
      const matchesType = !type || r.type === type
      const matchesStrength = (r.strength || 0) >= minStrength

      return (matchesSource || matchesTarget) && matchesType && matchesStrength
    })
  }

  /**
   * Find related memories through graph traversal
   */
  findRelatedMemories(memoryId, options = {}) {
    const { maxDepth = 2, maxResults = 20, relationshipTypes = null } = options
    const visited = new Set([memoryId])
    const related = []

    const traverse = (currentId, depth) => {
      if (depth > maxDepth || related.length >= maxResults) return

      const rels = this.getMemoryRelationships(currentId)

      for (const rel of rels) {
        if (relationshipTypes && !relationshipTypes.includes(rel.type)) continue

        const relatedId = rel.sourceId === currentId ? rel.targetId : rel.sourceId

        if (!visited.has(relatedId)) {
          visited.add(relatedId)

          // Find the actual memory
          for (const type of MEMORY_TYPES_LOCAL) {
            const items = this.getLearnedItemsByType(type)
            const memory = items.find(i => i.id === relatedId)
            if (memory) {
              related.push({
                ...memory,
                memoryType: type,
                relationship: rel,
                depth
              })
              break
            }
          }

          traverse(relatedId, depth + 1)
        }
      }
    }

    traverse(memoryId, 1)

    // Sort by relationship strength and depth
    related.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth
      return (b.relationship.strength || 0) - (a.relationship.strength || 0)
    })

    return related.slice(0, maxResults)
  }

  /**
   * Auto-detect and create relationships based on content similarity
   */
  autoDetectRelationships(options = {}) {
    const {
      similarityThreshold = 0.4,
      maxRelationships = 100,
      relationshipType = 'similar'
    } = options

    const allMemories = []
    for (const type of MEMORY_TYPES_LOCAL) {
      const items = this.getLearnedItemsByType(type)
      for (const item of items) {
        allMemories.push({ ...item, memoryType: type })
      }
    }

    const created = []

    for (let i = 0; i < allMemories.length && created.length < maxRelationships; i++) {
      for (let j = i + 1; j < allMemories.length && created.length < maxRelationships; j++) {
        const mem1 = allMemories[i]
        const mem2 = allMemories[j]

        const similarity = this.calculateClusterSimilarity(
          mem1.content || '',
          mem2.content || ''
        )

        if (similarity >= similarityThreshold) {
          // Check if relationship already exists
          const existing = this.getMemoryRelationships(mem1.id)
            .find(r => r.targetId === mem2.id || r.sourceId === mem2.id)

          if (!existing) {
            this.createMemoryRelationship(mem1.id, mem2.id, relationshipType, {
              strength: similarity,
              autoDetected: true
            })
            created.push({
              source: { id: mem1.id, type: mem1.memoryType },
              target: { id: mem2.id, type: mem2.memoryType },
              similarity
            })
          }
        }
      }
    }

    return {
      relationshipsCreated: created.length,
      threshold: similarityThreshold,
      created
    }
  }

  /**
   * Get memory graph statistics
   */
  getMemoryGraphStats() {
    const key = 'quox_memory_relationships'
    const data = localStorage.getItem(key)
    const relationships = data ? JSON.parse(data) : []

    const stats = {
      totalRelationships: relationships.length,
      byType: {},
      avgStrength: 0,
      mostConnected: [],
      isolated: []
    }

    // Count by type
    for (const rel of relationships) {
      stats.byType[rel.type] = (stats.byType[rel.type] || 0) + 1
      stats.avgStrength += rel.strength || 0
    }

    if (relationships.length > 0) {
      stats.avgStrength = (stats.avgStrength / relationships.length).toFixed(2)
    }

    // Find most connected memories
    const connectionCount = {}
    for (const rel of relationships) {
      connectionCount[rel.sourceId] = (connectionCount[rel.sourceId] || 0) + 1
      connectionCount[rel.targetId] = (connectionCount[rel.targetId] || 0) + 1
    }

    stats.mostConnected = Object.entries(connectionCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, count]) => ({ memoryId: id, connections: count }))

    // Find isolated memories (no relationships)
    const connectedIds = new Set([
      ...relationships.map(r => r.sourceId),
      ...relationships.map(r => r.targetId)
    ])

    for (const type of MEMORY_TYPES_LOCAL) {
      const items = this.getLearnedItemsByType(type)
      for (const item of items) {
        if (!connectedIds.has(item.id)) {
          stats.isolated.push({ id: item.id, type })
        }
      }
    }

    stats.isolatedCount = stats.isolated.length
    stats.isolated = stats.isolated.slice(0, 20) // Limit output

    return stats
  }

  /**
   * Delete a relationship between memories
   */
  deleteMemoryRelationship(relationshipId) {
    const key = 'quox_memory_relationships'
    const data = localStorage.getItem(key)
    if (!data) return { success: false, error: 'No relationships found' }

    const relationships = JSON.parse(data)
    const index = relationships.findIndex(r => r.id === relationshipId)

    if (index === -1) {
      return { success: false, error: 'Relationship not found' }
    }

    relationships.splice(index, 1)
    localStorage.setItem(key, JSON.stringify(relationships))
    logMemoryDeleted(relationshipId)
    return { success: true }
  }

  /**
   * Build context from memory graph for enhanced retrieval
   */
  async getGraphEnhancedContext(query, options = {}) {
    const { maxDepth = 2, includeRelated = 5 } = options

    // Get initial search results
    const searchResults = await this.enhancedHybridSearch(query, { finalTopK: 5 })

    if (searchResults.length === 0) {
      return { primary: [], related: [], graph: { nodes: 0, edges: 0 } }
    }

    // Get related memories through graph
    const relatedSet = new Map()

    for (const result of searchResults) {
      if (result.id) {
        const related = this.findRelatedMemories(result.id, {
          maxDepth,
          maxResults: includeRelated
        })

        for (const rel of related) {
          if (!relatedSet.has(rel.id)) {
            relatedSet.set(rel.id, rel)
          }
        }
      }
    }

    // Score related by relevance to query
    const relatedWithScores = [...relatedSet.values()].map(rel => {
      const { score } = this.enhancedCrossEncoderScore(query, rel.content || '')
      return { ...rel, relevanceScore: score }
    })

    relatedWithScores.sort((a, b) => b.relevanceScore - a.relevanceScore)

    return {
      primary: searchResults,
      related: relatedWithScores.slice(0, includeRelated),
      graph: {
        nodes: 1 + relatedSet.size,
        edges: relatedWithScores.reduce((sum, r) => sum + (r.depth || 0), 0)
      }
    }
  }

  // ============================================
  // Phase 8: Intelligent Personalization Engine
  // ============================================

  // Style dimension definitions
  static STYLE_DIMENSIONS = {
    formality: { min: 0, max: 1, default: 0.5 },
    verbosity: { min: 0, max: 1, default: 0.5 },
    technicality: { min: 0, max: 1, default: 0.5 },
    emotionality: { min: 0, max: 1, default: 0.3 },
    directness: { min: 0, max: 1, default: 0.7 }
  }

  // ----------------------------------------
  // 8.1 Style Learning System
  // ----------------------------------------

  /**
   * Analyze the communication style of a message
   */
  analyzeMessageStyle(text) {
    if (!text || typeof text !== 'string') {
      return null
    }

    const words = text.split(/\s+/)
    const sentences = text.split(/[.!?]+/).filter(s => s.trim())
    const wordCount = words.length
    const avgWordLength = words.reduce((sum, w) => sum + w.length, 0) / Math.max(wordCount, 1)

    // Formality indicators
    const contractions = (text.match(/\b(can't|won't|don't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|doesn't|didn't|wouldn't|couldn't|shouldn't|mightn't|mustn't|let's|that's|there's|here's|it's|what's|who's|how's|where's|when's|why's|I'm|you're|we're|they're|he's|she's|I've|you've|we've|they've|I'll|you'll|we'll|they'll|I'd|you'd|we'd|they'd)\b/gi) || []).length
    const slangWords = (text.match(/\b(gonna|wanna|gotta|kinda|sorta|yeah|yep|nope|hey|hi|ok|okay|cool|awesome|stuff|things|guy|guys|like|basically|literally|actually)\b/gi) || []).length
    const formalWords = (text.match(/\b(therefore|however|furthermore|consequently|nevertheless|moreover|thus|hence|regarding|concerning|pursuant|accordingly|henceforth|whereby|wherein|thereof)\b/gi) || []).length
    const greetings = (text.match(/^(hi|hey|hello|dear|greetings)/i) || []).length

    // Calculate formality (0 = casual, 1 = formal)
    const informalSignals = contractions + slangWords + greetings
    const formalSignals = formalWords + (text.match(/[;:]/) || []).length
    const formality = Math.max(0, Math.min(1,
      0.5 + (formalSignals * 0.1) - (informalSignals * 0.05)
    ))

    // Verbosity indicators (0 = concise, 1 = detailed)
    const avgSentenceLength = wordCount / Math.max(sentences.length, 1)
    const hasExamples = /for example|e\.g\.|such as|like when|instance/i.test(text) ? 0.2 : 0
    const hasElaboration = /specifically|in detail|to clarify|more specifically|in other words/i.test(text) ? 0.2 : 0
    const verbosity = Math.max(0, Math.min(1,
      (avgSentenceLength / 25) + hasExamples + hasElaboration
    ))

    // Technicality indicators (0 = simple, 1 = technical)
    const technicalTerms = (text.match(/\b(api|server|database|docker|kubernetes|nginx|ssh|http|tcp|udp|dns|ssl|tls|json|yaml|config|deploy|container|cluster|node|pod|service|endpoint|proxy|cache|queue|async|sync|latency|throughput|bandwidth|cpu|ram|memory|disk|network|firewall|load.?balancer|microservice|monolith|scalab|redundan|failover|backup|restore|monitor|metric|log|trace|debug|compile|runtime|framework|library|module|package|dependency|version|release|commit|branch|merge|pipeline|ci.?cd)\b/gi) || []).length
    const codePatterns = (text.match(/`[^`]+`|```[\s\S]*?```|\$\{|\(\)|\[\]|->|=>|::|\/\//g) || []).length
    const acronyms = (text.match(/\b[A-Z]{2,}\b/g) || []).length

    const technicality = Math.max(0, Math.min(1,
      (technicalTerms * 0.05) + (codePatterns * 0.1) + (acronyms * 0.02)
    ))

    // Emotionality indicators (0 = neutral, 1 = expressive)
    const exclamations = (text.match(/!/g) || []).length
    const emojis = (text.match(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|:\)|:\(|:D|:P|;\)|<3/gu) || []).length
    const intensifiers = (text.match(/\b(very|really|extremely|incredibly|absolutely|totally|completely|super|so|such|quite|rather|pretty|fairly)\b/gi) || []).length
    const sentimentWords = (text.match(/\b(love|hate|amazing|terrible|awesome|awful|fantastic|horrible|great|worst|best|excited|frustrated|happy|sad|angry|worried|confused)\b/gi) || []).length

    const emotionality = Math.max(0, Math.min(1,
      (exclamations * 0.1) + (emojis * 0.15) + (intensifiers * 0.05) + (sentimentWords * 0.08)
    ))

    // Directness indicators (0 = indirect/hedged, 1 = direct)
    const hedgeWords = (text.match(/\b(maybe|perhaps|possibly|might|could|would|should|seem|appear|think|believe|feel|guess|suppose|wonder|tend|generally|usually|often|sometimes)\b/gi) || []).length
    const directPhrases = (text.match(/\b(need|must|will|do|is|are|always|never|definitely|certainly|clearly|obviously|exactly|precisely)\b/gi) || []).length
    const questions = (text.match(/\?/g) || []).length
    const commands = (text.match(/^(please |can you |could you |would you |I need |I want )/gim) || []).length

    const directness = Math.max(0, Math.min(1,
      0.5 + (directPhrases * 0.03) - (hedgeWords * 0.04) - (questions * 0.05) + (commands * 0.05)
    ))

    return {
      formality: Math.round(formality * 100) / 100,
      verbosity: Math.round(verbosity * 100) / 100,
      technicality: Math.round(technicality * 100) / 100,
      emotionality: Math.round(emotionality * 100) / 100,
      directness: Math.round(directness * 100) / 100,
      metadata: {
        wordCount,
        sentenceCount: sentences.length,
        avgWordLength: Math.round(avgWordLength * 10) / 10,
        avgSentenceLength: Math.round(avgSentenceLength * 10) / 10
      }
    }
  }

  /**
   * Get the current style profile
   */
  getStyleProfile() {
    const key = 'quox_style_profile'
    const data = localStorage.getItem(key)
    if (data) {
      return JSON.parse(data)
    }

    // Return default profile
    return {
      style: {
        formality: 0.5,
        verbosity: 0.5,
        technicality: 0.5,
        emotionality: 0.3,
        directness: 0.7
      },
      confidence: 0,
      observationCount: 0,
      lastUpdated: null,
      history: []
    }
  }

  /**
   * Update style profile with new observations
   */
  updateStyleProfile(styleSignals, options = {}) {
    if (!styleSignals) return null

    const { learningRate = 0.1, maxHistory = 50 } = options
    const key = 'quox_style_profile'
    const profile = this.getStyleProfile()

    // Update running averages with exponential smoothing
    const dimensions = ['formality', 'verbosity', 'technicality', 'emotionality', 'directness']

    for (const dim of dimensions) {
      if (typeof styleSignals[dim] === 'number') {
        const oldValue = profile.style[dim]
        const newValue = styleSignals[dim]
        // Exponential moving average
        profile.style[dim] = Math.round(
          (oldValue * (1 - learningRate) + newValue * learningRate) * 100
        ) / 100
      }
    }

    // Update metadata
    profile.observationCount++
    profile.lastUpdated = new Date().toISOString()

    // Calculate confidence based on observations
    profile.confidence = Math.min(1, profile.observationCount / 20)

    // Store recent observations for trend analysis
    profile.history.push({
      timestamp: new Date().toISOString(),
      signals: styleSignals
    })
    profile.history = profile.history.slice(-maxHistory)

    localStorage.setItem(key, JSON.stringify(profile))
    return profile
  }

  /**
   * Detect if user's style has shifted recently
   */
  detectStyleShift(windowSize = 5) {
    const profile = this.getStyleProfile()

    if (profile.history.length < windowSize * 2) {
      return { shifted: false, reason: 'Not enough history' }
    }

    const recent = profile.history.slice(-windowSize)
    const previous = profile.history.slice(-windowSize * 2, -windowSize)

    const dimensions = ['formality', 'verbosity', 'technicality', 'emotionality', 'directness']
    const shifts = {}
    let significantShift = false

    for (const dim of dimensions) {
      const recentAvg = recent.reduce((sum, h) => sum + (h.signals[dim] || 0), 0) / recent.length
      const previousAvg = previous.reduce((sum, h) => sum + (h.signals[dim] || 0), 0) / previous.length
      const delta = recentAvg - previousAvg

      shifts[dim] = {
        previous: Math.round(previousAvg * 100) / 100,
        recent: Math.round(recentAvg * 100) / 100,
        delta: Math.round(delta * 100) / 100
      }

      // Significant shift if delta > 0.15
      if (Math.abs(delta) > 0.15) {
        significantShift = true
      }
    }

    return {
      shifted: significantShift,
      shifts,
      windowSize,
      samplesAnalyzed: windowSize * 2
    }
  }

  /**
   * Get style-based formatting recommendations
   */
  getStyleRecommendations() {
    const profile = this.getStyleProfile()
    const recommendations = []

    if (profile.confidence < 0.3) {
      return {
        recommendations: ['Still learning user style - using defaults'],
        confidence: profile.confidence,
        profile: profile.style
      }
    }

    // Formality recommendations
    if (profile.style.formality < 0.3) {
      recommendations.push('Use casual, conversational tone')
      recommendations.push('Contractions are fine')
    } else if (profile.style.formality > 0.7) {
      recommendations.push('Maintain formal, professional tone')
      recommendations.push('Avoid contractions and slang')
    }

    // Verbosity recommendations
    if (profile.style.verbosity < 0.3) {
      recommendations.push('Keep responses brief and to the point')
      recommendations.push('Use bullet points for lists')
    } else if (profile.style.verbosity > 0.7) {
      recommendations.push('Provide detailed explanations')
      recommendations.push('Include examples and context')
    }

    // Technicality recommendations
    if (profile.style.technicality < 0.3) {
      recommendations.push('Explain technical concepts simply')
      recommendations.push('Avoid jargon without explanation')
    } else if (profile.style.technicality > 0.7) {
      recommendations.push('Use precise technical terminology')
      recommendations.push('Assume technical familiarity')
    }

    // Emotionality recommendations
    if (profile.style.emotionality > 0.6) {
      recommendations.push('Match enthusiastic tone when appropriate')
    } else if (profile.style.emotionality < 0.2) {
      recommendations.push('Keep tone neutral and factual')
    }

    // Directness recommendations
    if (profile.style.directness > 0.7) {
      recommendations.push('Be direct and assertive')
      recommendations.push('Lead with the answer')
    } else if (profile.style.directness < 0.3) {
      recommendations.push('Use softer language')
      recommendations.push('Frame suggestions as options')
    }

    return {
      recommendations,
      confidence: profile.confidence,
      profile: profile.style
    }
  }

  // ----------------------------------------
  // 8.2 Behavior Pattern Detection
  // ----------------------------------------

  /**
   * Get behavior patterns storage
   */
  getBehaviorPatterns() {
    const key = 'quox_behavior_patterns'
    const data = localStorage.getItem(key)
    if (data) {
      return JSON.parse(data)
    }

    return {
      timing: {
        activeHours: new Array(24).fill(0),
        activeDays: new Array(7).fill(0),
        sessionDurations: [],
        avgResponseTime: 0
      },
      interaction: {
        queryLengths: [],
        followUpRate: 0,
        correctionRate: 0,
        totalQueries: 0,
        followUps: 0,
        corrections: 0
      },
      content: {
        topicFrequency: {},
        entityInteractions: {},
        queryPatterns: {},
        toolUsage: {}
      },
      satisfaction: {
        positiveSignals: 0,
        negativeSignals: 0,
        neutralSignals: 0
      },
      lastUpdated: null
    }
  }

  /**
   * Track user behavior from an interaction
   */
  trackUserBehavior(interaction) {
    const { query, response, timestamp, duration, agent } = interaction
    const key = 'quox_behavior_patterns'
    const patterns = this.getBehaviorPatterns()

    const now = timestamp ? new Date(timestamp) : new Date()

    // Timing patterns
    patterns.timing.activeHours[now.getHours()]++
    patterns.timing.activeDays[now.getDay()]++

    if (duration) {
      patterns.timing.sessionDurations.push(duration)
      patterns.timing.sessionDurations = patterns.timing.sessionDurations.slice(-100)
    }

    // Interaction patterns
    patterns.interaction.totalQueries++

    if (query) {
      const queryLength = query.split(/\s+/).length
      patterns.interaction.queryLengths.push(queryLength)
      patterns.interaction.queryLengths = patterns.interaction.queryLengths.slice(-100)

      // Detect follow-up
      if (this._isFollowUp(query)) {
        patterns.interaction.followUps++
      }

      // Detect correction
      if (this._isCorrection(query)) {
        patterns.interaction.corrections++
      }

      // Update rates
      patterns.interaction.followUpRate =
        patterns.interaction.followUps / Math.max(patterns.interaction.totalQueries, 1)
      patterns.interaction.correctionRate =
        patterns.interaction.corrections / Math.max(patterns.interaction.totalQueries, 1)

      // Content patterns - topics
      const topics = this._extractTopics(query)
      for (const topic of topics) {
        patterns.content.topicFrequency[topic] =
          (patterns.content.topicFrequency[topic] || 0) + 1
      }

      // Query pattern type
      const queryType = this._classifyQueryPattern(query)
      patterns.content.queryPatterns[queryType] =
        (patterns.content.queryPatterns[queryType] || 0) + 1
    }

    // Agent/tool usage
    if (agent) {
      patterns.content.toolUsage[agent] =
        (patterns.content.toolUsage[agent] || 0) + 1
    }

    // Satisfaction signals from query
    if (query) {
      const satisfaction = this._detectSatisfactionSignal(query)
      if (satisfaction === 'positive') patterns.satisfaction.positiveSignals++
      else if (satisfaction === 'negative') patterns.satisfaction.negativeSignals++
      else patterns.satisfaction.neutralSignals++
    }

    patterns.lastUpdated = new Date().toISOString()
    localStorage.setItem(key, JSON.stringify(patterns))

    return patterns
  }

  /**
   * Check if query is a follow-up
   */
  _isFollowUp(query) {
    const followUpPatterns = [
      /^(and |also |what about |how about |can you also )/i,
      /^(yes|no|ok|okay|sure|right|exactly|correct)[\s,]/i,
      /\b(that|this|it|those|these)\b.*\?$/i,
      /^(why|how come|but )/i,
      /^(more |another |else |other )/i
    ]
    return followUpPatterns.some(p => p.test(query))
  }

  /**
   * Check if query is a correction
   */
  _isCorrection(query) {
    const correctionPatterns = [
      /^(no,? |not |wrong |incorrect |actually )/i,
      /\b(didn't mean|meant to say|should have|that's not|not what I)\b/i,
      /^(I said |I meant |I want(ed)? )/i,
      /\b(try again|redo|undo|fix|correct)\b/i
    ]
    return correctionPatterns.some(p => p.test(query))
  }

  /**
   * Extract topics from query
   */
  _extractTopics(query) {
    const topics = []
    const topicPatterns = {
      docker: /\b(docker|container|compose|dockerfile|image)\b/i,
      kubernetes: /\b(kubernetes|k8s|kubectl|pod|deployment|helm)\b/i,
      networking: /\b(network|dns|ip|port|firewall|proxy|nginx|traefik)\b/i,
      monitoring: /\b(monitor|prometheus|grafana|alert|metric|dashboard)\b/i,
      storage: /\b(storage|disk|volume|nas|backup|restore)\b/i,
      security: /\b(security|ssl|tls|certificate|auth|password|secret)\b/i,
      proxmox: /\b(proxmox|vm|virtual|cluster|migration)\b/i,
      automation: /\b(automat|script|cron|pipeline|ci.?cd|ansible)\b/i
    }

    for (const [topic, pattern] of Object.entries(topicPatterns)) {
      if (pattern.test(query)) {
        topics.push(topic)
      }
    }

    return topics
  }

  /**
   * Classify query pattern type
   */
  _classifyQueryPattern(query) {
    if (/^(how (do|can|to)|what('s| is) the (way|best|right))/i.test(query)) return 'how_to'
    if (/^(what|which|who|where)/i.test(query)) return 'information'
    if (/^(why|how come)/i.test(query)) return 'explanation'
    if (/^(is|are|does|do|can|will|should)/i.test(query)) return 'yes_no'
    if (/\b(help|assist|support)\b/i.test(query)) return 'help'
    if (/\b(fix|solve|debug|troubleshoot|error|issue|problem)\b/i.test(query)) return 'troubleshooting'
    if (/\b(show|list|display|get)\b/i.test(query)) return 'retrieval'
    if (/\b(create|make|build|setup|configure|install)\b/i.test(query)) return 'creation'
    if (/\b(update|change|modify|edit)\b/i.test(query)) return 'modification'
    if (/\b(delete|remove|stop|disable)\b/i.test(query)) return 'deletion'
    return 'general'
  }

  /**
   * Detect satisfaction signal from query
   */
  _detectSatisfactionSignal(query) {
    const positivePatterns = [
      /^(thanks|thank you|great|perfect|awesome|excellent|nice|good job)/i,
      /\b(works|worked|helpful|solved|fixed)\b/i,
      /^(yes|yep|exactly|correct|right)\b/i
    ]
    const negativePatterns = [
      /^(no|nope|wrong|incorrect|not what I)/i,
      /\b(doesn't work|didn't work|still broken|not helping|useless)\b/i,
      /\b(frustrated|annoyed|confused|lost)\b/i
    ]

    if (positivePatterns.some(p => p.test(query))) return 'positive'
    if (negativePatterns.some(p => p.test(query))) return 'negative'
    return 'neutral'
  }

  /**
   * Infer preferences from behavior patterns
   */
  inferPreferencesFromBehavior() {
    const patterns = this.getBehaviorPatterns()
    const inferred = {
      timing: {},
      communication: {},
      workflow: {},
      confidence: 0
    }

    // Need enough data
    if (patterns.interaction.totalQueries < 10) {
      return {
        inferred,
        confidence: 0,
        reason: 'Not enough interactions yet'
      }
    }

    // Timing preferences
    const peakHour = patterns.timing.activeHours.indexOf(
      Math.max(...patterns.timing.activeHours)
    )
    inferred.timing.peakActivityHour = peakHour
    inferred.timing.peakActivityPeriod =
      peakHour < 6 ? 'night' :
      peakHour < 12 ? 'morning' :
      peakHour < 18 ? 'afternoon' : 'evening'

    const peakDay = patterns.timing.activeDays.indexOf(
      Math.max(...patterns.timing.activeDays)
    )
    inferred.timing.peakActivityDay = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][peakDay]

    // Communication preferences from query lengths
    const avgQueryLength = patterns.interaction.queryLengths.length > 0
      ? patterns.interaction.queryLengths.reduce((a, b) => a + b, 0) / patterns.interaction.queryLengths.length
      : 0

    inferred.communication.queryStyle =
      avgQueryLength < 5 ? 'terse' :
      avgQueryLength < 15 ? 'concise' :
      avgQueryLength < 30 ? 'detailed' : 'verbose'

    inferred.communication.followUpTendency =
      patterns.interaction.followUpRate > 0.3 ? 'high' :
      patterns.interaction.followUpRate > 0.1 ? 'medium' : 'low'

    // Workflow preferences from patterns
    const topQueryType = Object.entries(patterns.content.queryPatterns)
      .sort((a, b) => b[1] - a[1])[0]
    inferred.workflow.primaryQueryType = topQueryType ? topQueryType[0] : 'general'

    const topTopic = Object.entries(patterns.content.topicFrequency)
      .sort((a, b) => b[1] - a[1])[0]
    inferred.workflow.primaryTopic = topTopic ? topTopic[0] : 'general'

    const topAgent = Object.entries(patterns.content.toolUsage)
      .sort((a, b) => b[1] - a[1])[0]
    inferred.workflow.preferredAgent = topAgent ? topAgent[0] : null

    // Satisfaction inference
    const totalSatisfaction =
      patterns.satisfaction.positiveSignals +
      patterns.satisfaction.negativeSignals +
      patterns.satisfaction.neutralSignals

    if (totalSatisfaction > 0) {
      inferred.workflow.satisfactionRate =
        patterns.satisfaction.positiveSignals / totalSatisfaction
    }

    // Calculate confidence
    inferred.confidence = Math.min(1, patterns.interaction.totalQueries / 50)

    return {
      inferred,
      confidence: inferred.confidence,
      basedOn: {
        interactions: patterns.interaction.totalQueries,
        uniqueTopics: Object.keys(patterns.content.topicFrequency).length
      }
    }
  }

  /**
   * Predict user intent from query
   */
  predictUserIntent(query) {
    const patterns = this.getBehaviorPatterns()
    const styleProfile = this.getStyleProfile()

    const prediction = {
      queryType: this._classifyQueryPattern(query),
      topics: this._extractTopics(query),
      isFollowUp: this._isFollowUp(query),
      isCorrection: this._isCorrection(query),
      expectedResponseStyle: {},
      suggestedAgent: null,
      confidence: 0
    }

    // Suggest agent based on topics
    const topicToAgent = {
      docker: 'forge',
      kubernetes: 'nova',
      networking: 'cipher',
      monitoring: 'metrics',
      storage: 'vault',
      security: 'sentinel',
      proxmox: 'atlas',
      automation: 'nova'
    }

    for (const topic of prediction.topics) {
      if (topicToAgent[topic]) {
        prediction.suggestedAgent = topicToAgent[topic]
        break
      }
    }

    // Expected response style from profile
    if (styleProfile.confidence > 0.3) {
      prediction.expectedResponseStyle = {
        verbosity: styleProfile.style.verbosity < 0.3 ? 'concise' :
                   styleProfile.style.verbosity > 0.7 ? 'detailed' : 'moderate',
        technicality: styleProfile.style.technicality < 0.3 ? 'simple' :
                      styleProfile.style.technicality > 0.7 ? 'technical' : 'balanced',
        formality: styleProfile.style.formality < 0.3 ? 'casual' :
                   styleProfile.style.formality > 0.7 ? 'formal' : 'neutral'
      }
    }

    // Confidence based on pattern match strength
    prediction.confidence =
      (prediction.topics.length > 0 ? 0.3 : 0) +
      (prediction.queryType !== 'general' ? 0.3 : 0) +
      (styleProfile.confidence * 0.4)

    return prediction
  }

  // ----------------------------------------
  // 8.3 Personalization Profiles
  // ----------------------------------------

  /**
   * Create a unified personalization profile
   */
  createPersonalizationProfile() {
    const styleProfile = this.getStyleProfile()
    const behaviorPatterns = this.getBehaviorPatterns()
    const inferredPrefs = this.inferPreferencesFromBehavior()
    const explicitPrefs = this.getAllPreferences()

    const profile = {
      id: `profile_${Date.now()}`,
      version: 1,
      createdAt: new Date().toISOString(),

      // Communication style (learned)
      style: {
        ...styleProfile.style,
        confidence: styleProfile.confidence
      },

      // Inferred preferences (from behavior)
      inferred: inferredPrefs.inferred,

      // Explicit preferences (user-stated)
      explicit: explicitPrefs,

      // Behavior summary
      behavior: {
        totalInteractions: behaviorPatterns.interaction.totalQueries,
        topTopics: Object.entries(behaviorPatterns.content.topicFrequency)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([topic, count]) => ({ topic, count })),
        topQueryTypes: Object.entries(behaviorPatterns.content.queryPatterns)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([type, count]) => ({ type, count })),
        satisfactionScore: behaviorPatterns.satisfaction.positiveSignals /
          Math.max(1, behaviorPatterns.satisfaction.positiveSignals +
                     behaviorPatterns.satisfaction.negativeSignals)
      },

      // Overall confidence
      overallConfidence: (styleProfile.confidence + inferredPrefs.confidence) / 2
    }

    // Store the profile
    localStorage.setItem('quox_personalization_profile', JSON.stringify(profile))
    this._identityWriteThrough('personalization', profile)

    return profile
  }

  /**
   * Get the current personalization profile
   */
  getPersonalizationProfile() {
    const key = 'quox_personalization_profile'
    const data = localStorage.getItem(key)

    if (data) {
      return JSON.parse(data)
    }

    // Generate fresh if not exists
    return this.createPersonalizationProfile()
  }

  /**
   * Get personalization context for prompt injection
   */
  getPersonalizationContext() {
    const profile = this.getPersonalizationProfile()
    const recommendations = this.getStyleRecommendations()

    const context = {
      summary: '',
      recommendations: recommendations.recommendations,
      confidence: profile.overallConfidence
    }

    // Build summary string
    const parts = []

    if (profile.overallConfidence > 0.3) {
      // Style summary
      const styleDesc = []
      if (profile.style.formality < 0.3) styleDesc.push('casual')
      else if (profile.style.formality > 0.7) styleDesc.push('formal')

      if (profile.style.verbosity < 0.3) styleDesc.push('concise')
      else if (profile.style.verbosity > 0.7) styleDesc.push('detailed')

      if (profile.style.technicality > 0.6) styleDesc.push('technical')
      else if (profile.style.technicality < 0.3) styleDesc.push('non-technical')

      if (styleDesc.length > 0) {
        parts.push(`Communication style: ${styleDesc.join(', ')}`)
      }

      // Topic interests
      if (profile.behavior.topTopics.length > 0) {
        const topics = profile.behavior.topTopics.slice(0, 3).map(t => t.topic)
        parts.push(`Primary interests: ${topics.join(', ')}`)
      }

      // Activity pattern
      if (profile.inferred.timing?.peakActivityPeriod) {
        parts.push(`Most active: ${profile.inferred.timing.peakActivityPeriod}`)
      }
    }

    context.summary = parts.join('. ')
    return context
  }

  /**
   * Compare two profiles for similarity
   */
  compareProfiles(profile1, profile2) {
    const styleDims = ['formality', 'verbosity', 'technicality', 'emotionality', 'directness']
    let styleSimilarity = 0

    for (const dim of styleDims) {
      const diff = Math.abs(
        (profile1.style?.[dim] || 0.5) - (profile2.style?.[dim] || 0.5)
      )
      styleSimilarity += (1 - diff)
    }
    styleSimilarity /= styleDims.length

    // Topic overlap
    const topics1 = new Set((profile1.behavior?.topTopics || []).map(t => t.topic))
    const topics2 = new Set((profile2.behavior?.topTopics || []).map(t => t.topic))
    const topicIntersection = [...topics1].filter(t => topics2.has(t)).length
    const topicUnion = new Set([...topics1, ...topics2]).size
    const topicSimilarity = topicUnion > 0 ? topicIntersection / topicUnion : 0

    return {
      overall: (styleSimilarity * 0.6 + topicSimilarity * 0.4),
      styleSimilarity,
      topicSimilarity,
      dimensions: {
        formality: 1 - Math.abs((profile1.style?.formality || 0.5) - (profile2.style?.formality || 0.5)),
        verbosity: 1 - Math.abs((profile1.style?.verbosity || 0.5) - (profile2.style?.verbosity || 0.5)),
        technicality: 1 - Math.abs((profile1.style?.technicality || 0.5) - (profile2.style?.technicality || 0.5))
      }
    }
  }

  /**
   * Export personalization profile
   */
  exportPersonalizationProfile() {
    const profile = this.getPersonalizationProfile()
    const styleProfile = this.getStyleProfile()
    const behaviorPatterns = this.getBehaviorPatterns()

    return {
      exportVersion: '1.0',
      exportedAt: new Date().toISOString(),
      profile,
      styleProfile,
      behaviorPatterns,
      checksum: this._generateChecksum(JSON.stringify(profile))
    }
  }

  /**
   * Import personalization profile
   */
  importPersonalizationProfile(exportData, options = {}) {
    const { merge = false } = options

    if (!exportData.profile) {
      return { success: false, error: 'Invalid export data' }
    }

    if (merge) {
      // Merge with existing
      const existing = this.getPersonalizationProfile()
      const merged = {
        ...existing,
        style: {
          formality: (existing.style.formality + exportData.profile.style.formality) / 2,
          verbosity: (existing.style.verbosity + exportData.profile.style.verbosity) / 2,
          technicality: (existing.style.technicality + exportData.profile.style.technicality) / 2,
          emotionality: (existing.style.emotionality + exportData.profile.style.emotionality) / 2,
          directness: (existing.style.directness + exportData.profile.style.directness) / 2
        },
        importedAt: new Date().toISOString()
      }
      localStorage.setItem('quox_personalization_profile', JSON.stringify(merged))
      this._identityWriteThrough('personalization', merged)
      return { success: true, mode: 'merged' }
    } else {
      // Replace
      localStorage.setItem('quox_personalization_profile', JSON.stringify(exportData.profile))
      this._identityWriteThrough('personalization', exportData.profile)
      if (exportData.styleProfile) {
        localStorage.setItem('quox_style_profile', JSON.stringify(exportData.styleProfile))
      }
      if (exportData.behaviorPatterns) {
        localStorage.setItem('quox_behavior_patterns', JSON.stringify(exportData.behaviorPatterns))
      }
      return { success: true, mode: 'replaced' }
    }
  }

  /**
   * Generate simple checksum
   */
  _generateChecksum(str) {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(16)
  }

  // ----------------------------------------
  // 8.4 Adaptive Response Formatting
  // ----------------------------------------

  /**
   * Get formatting guidelines based on profile
   */
  getFormattingGuidelines() {
    const profile = this.getPersonalizationProfile()
    const guidelines = {
      structure: {},
      tone: {},
      content: {},
      confidence: profile.overallConfidence
    }

    if (profile.overallConfidence < 0.2) {
      return {
        ...guidelines,
        note: 'Using defaults - still learning preferences'
      }
    }

    // Structure guidelines
    if (profile.style.verbosity < 0.3) {
      guidelines.structure.maxParagraphs = 2
      guidelines.structure.preferBullets = true
      guidelines.structure.includeExamples = false
    } else if (profile.style.verbosity > 0.7) {
      guidelines.structure.maxParagraphs = 5
      guidelines.structure.preferBullets = false
      guidelines.structure.includeExamples = true
      guidelines.structure.includeContext = true
    } else {
      guidelines.structure.maxParagraphs = 3
      guidelines.structure.preferBullets = true
      guidelines.structure.includeExamples = 'when_helpful'
    }

    // Tone guidelines
    if (profile.style.formality < 0.3) {
      guidelines.tone.useContractions = true
      guidelines.tone.casualGreetings = true
      guidelines.tone.conversational = true
    } else if (profile.style.formality > 0.7) {
      guidelines.tone.useContractions = false
      guidelines.tone.casualGreetings = false
      guidelines.tone.conversational = false
      guidelines.tone.professionalClosing = true
    }

    if (profile.style.directness > 0.7) {
      guidelines.tone.leadWithAnswer = true
      guidelines.tone.avoidHedging = true
    } else if (profile.style.directness < 0.3) {
      guidelines.tone.useSofteners = true
      guidelines.tone.offerAlternatives = true
    }

    // Content guidelines
    if (profile.style.technicality > 0.7) {
      guidelines.content.assumeExpertise = true
      guidelines.content.useJargon = true
      guidelines.content.includeCommands = true
      guidelines.content.showConfigExamples = true
    } else if (profile.style.technicality < 0.3) {
      guidelines.content.explainTerms = true
      guidelines.content.avoidJargon = true
      guidelines.content.stepByStep = true
    }

    return guidelines
  }

  /**
   * Suggest response length based on profile
   */
  suggestResponseLength(queryComplexity = 'medium') {
    const profile = this.getPersonalizationProfile()

    const baseLengths = {
      simple: { min: 20, max: 100 },
      medium: { min: 50, max: 300 },
      complex: { min: 100, max: 500 }
    }

    const base = baseLengths[queryComplexity] || baseLengths.medium

    // Adjust for verbosity
    const verbosityMultiplier = 0.5 + profile.style.verbosity

    return {
      minWords: Math.round(base.min * verbosityMultiplier),
      maxWords: Math.round(base.max * verbosityMultiplier),
      verbosity: profile.style.verbosity,
      confidence: profile.overallConfidence
    }
  }

  /**
   * Check if response matches expected style
   */
  validateResponseStyle(response, expectedStyle = null) {
    const analyzed = this.analyzeMessageStyle(response)
    const profile = expectedStyle || this.getPersonalizationProfile().style

    const mismatches = []
    const threshold = 0.25 // Acceptable deviation

    if (Math.abs(analyzed.formality - profile.formality) > threshold) {
      mismatches.push({
        dimension: 'formality',
        expected: profile.formality,
        actual: analyzed.formality,
        suggestion: analyzed.formality > profile.formality
          ? 'Response is too formal - use more casual language'
          : 'Response is too casual - use more professional language'
      })
    }

    if (Math.abs(analyzed.verbosity - profile.verbosity) > threshold) {
      mismatches.push({
        dimension: 'verbosity',
        expected: profile.verbosity,
        actual: analyzed.verbosity,
        suggestion: analyzed.verbosity > profile.verbosity
          ? 'Response is too long - be more concise'
          : 'Response is too brief - add more detail'
      })
    }

    if (Math.abs(analyzed.technicality - profile.technicality) > threshold) {
      mismatches.push({
        dimension: 'technicality',
        expected: profile.technicality,
        actual: analyzed.technicality,
        suggestion: analyzed.technicality > profile.technicality
          ? 'Response is too technical - simplify language'
          : 'Response could be more technical - user is comfortable with jargon'
      })
    }

    return {
      matches: mismatches.length === 0,
      mismatches,
      analyzed,
      expectedProfile: profile
    }
  }

  /**
   * Process interaction with personalization tracking
   */
  async processInteractionWithPersonalization(interaction) {
    // Track behavior patterns
    this.trackUserBehavior(interaction)

    // Analyze and update style profile
    if (interaction.query) {
      const styleSignals = this.analyzeMessageStyle(interaction.query)
      if (styleSignals) {
        this.updateStyleProfile(styleSignals)
      }
    }

    // Run standard interaction processing
    const result = await this.processInteraction(interaction)

    // Periodically update personalization profile
    const patterns = this.getBehaviorPatterns()
    if (patterns.interaction.totalQueries % 10 === 0) {
      this.createPersonalizationProfile()
    }

    return {
      ...result,
      personalization: {
        styleUpdated: true,
        behaviorTracked: true,
        profileConfidence: this.getStyleProfile().confidence
      }
    }
  }

  // ============================================
  // Phase 9: Memory Intelligence & Synthesis
  // ============================================

  // Synthesis type definitions
  static SYNTHESIS_TYPES = {
    factual_summary: {
      description: 'Combined facts about an entity/topic',
      trigger: 5,
      template: '{subject} synthesis: {combined_facts}'
    },
    preference_profile: {
      description: 'Aggregated preferences in a domain',
      trigger: 3,
      template: 'User {domain} preferences: {preferences}'
    },
    decision_pattern: {
      description: 'Pattern across multiple decisions',
      trigger: 3,
      template: 'Decision pattern: When {condition}, user tends to {action}'
    },
    workflow_insight: {
      description: 'Observed workflow patterns',
      trigger: 3,
      template: 'Workflow: {steps} (observed {count} times)'
    },
    relationship_insight: {
      description: 'Connections between entities',
      trigger: 2,
      template: '{entity1} and {entity2}: {relationship_summary}'
    }
  }

  // ----------------------------------------
  // 9.1 Knowledge Synthesis Engine
  // ----------------------------------------

  /**
   * Get all syntheses from storage
   */
  getSyntheses() {
    const key = 'quox_syntheses'
    const data = localStorage.getItem(key)
    return data ? JSON.parse(data) : []
  }

  /**
   * Save syntheses to storage
   */
  _saveSyntheses(syntheses) {
    localStorage.setItem('quox_syntheses', JSON.stringify(syntheses))
    this._identityWriteThrough('syntheses', syntheses)
  }

  /**
   * Synthesize knowledge from a set of related memories
   */
  synthesizeKnowledge(memorySet, options = {}) {
    if (!memorySet || memorySet.length < 2) {
      return null
    }

    const { type = 'auto', forceNew = false } = options

    // Extract common elements
    const contents = memorySet.map(m => m.content || m)
    const topics = this._extractCommonTopics(contents)
    const entities = this._extractCommonEntities(contents)

    // Determine synthesis type if auto
    let synthesisType = type
    if (type === 'auto') {
      synthesisType = this._determineSynthesisType(memorySet)
    }

    // Generate synthesis based on type
    const synthesis = {
      id: `synthesis_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: synthesisType,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceMemories: memorySet.map(m => m.id || m),
      sourceCount: memorySet.length,
      topics,
      entities,
      confidence: this._calculateSynthesisConfidence(memorySet),
      accessCount: 0,
      content: '',
      summary: ''
    }

    // Generate content based on type
    switch (synthesisType) {
      case 'factual_summary':
        synthesis.content = this._generateFactualSummary(contents, topics)
        synthesis.summary = `Summary of ${topics.join(', ') || 'multiple facts'}`
        break
      case 'preference_profile':
        synthesis.content = this._generatePreferenceProfile(contents)
        synthesis.summary = `Preferences for ${topics.join(', ') || 'various topics'}`
        break
      case 'decision_pattern':
        synthesis.content = this._generateDecisionPattern(contents)
        synthesis.summary = `Decision pattern detected`
        break
      case 'workflow_insight':
        synthesis.content = this._generateWorkflowInsight(contents)
        synthesis.summary = `Workflow pattern`
        break
      case 'relationship_insight':
        synthesis.content = this._generateRelationshipInsight(contents, entities)
        synthesis.summary = `Relationship: ${entities.slice(0, 2).join(' ↔ ')}`
        break
      default:
        synthesis.content = this._generateGenericSynthesis(contents)
        synthesis.summary = `Combined knowledge`
    }

    // Store synthesis
    const syntheses = this.getSyntheses()

    // Check for existing similar synthesis
    if (!forceNew) {
      const existing = syntheses.find(s =>
        s.type === synthesisType &&
        this._calculateTopicOverlap(s.topics, topics) > 0.7
      )
      if (existing) {
        return this.updateSynthesis(existing.id, memorySet)
      }
    }

    syntheses.push(synthesis)
    this._saveSyntheses(syntheses)

    return synthesis
  }

  /**
   * Determine the best synthesis type for a memory set
   */
  _determineSynthesisType(memorySet) {
    const types = memorySet.map(m => m.type || 'unknown')
    const typeCount = {}
    types.forEach(t => typeCount[t] = (typeCount[t] || 0) + 1)

    // Check for preferences
    if (typeCount.preference >= 3) return 'preference_profile'

    // Check for decisions
    if (typeCount.decision >= 3) return 'decision_pattern'

    // Check for facts
    if (typeCount.fact >= 5) return 'factual_summary'

    // Check if multiple entities involved
    const entities = new Set()
    memorySet.forEach(m => {
      if (m.entities) m.entities.forEach(e => entities.add(e))
    })
    if (entities.size >= 2) return 'relationship_insight'

    return 'factual_summary'
  }

  /**
   * Extract common topics from content array
   */
  _extractCommonTopics(contents) {
    const topicPatterns = {
      docker: /\b(docker|container|compose|dockerfile)\b/i,
      kubernetes: /\b(kubernetes|k8s|kubectl|pod|helm)\b/i,
      networking: /\b(network|dns|ip|port|firewall|proxy|nginx)\b/i,
      monitoring: /\b(monitor|prometheus|grafana|alert|metric)\b/i,
      storage: /\b(storage|disk|volume|nas|backup)\b/i,
      security: /\b(security|ssl|tls|certificate|auth)\b/i,
      proxmox: /\b(proxmox|vm|virtual|cluster)\b/i,
      automation: /\b(automat|script|cron|pipeline|ansible)\b/i
    }

    const topicCounts = {}
    contents.forEach(content => {
      const text = typeof content === 'string' ? content : JSON.stringify(content)
      for (const [topic, pattern] of Object.entries(topicPatterns)) {
        if (pattern.test(text)) {
          topicCounts[topic] = (topicCounts[topic] || 0) + 1
        }
      }
    })

    // Return topics appearing in at least 2 contents
    return Object.entries(topicCounts)
      .filter(([_, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([topic]) => topic)
  }

  /**
   * Extract common entities from content array
   */
  _extractCommonEntities(contents) {
    const entityPattern = /\b(docker\d+|proxmox\d+|nas\d+|grafana\d+|prometheus\d+|nginx\d*|traefik|pihole\d*|pfsense\d*)\b/gi
    const entityCounts = {}

    contents.forEach(content => {
      const text = typeof content === 'string' ? content : JSON.stringify(content)
      const matches = text.match(entityPattern) || []
      matches.forEach(entity => {
        const normalized = entity.toLowerCase()
        entityCounts[normalized] = (entityCounts[normalized] || 0) + 1
      })
    })

    return Object.entries(entityCounts)
      .filter(([_, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([entity]) => entity)
  }

  /**
   * Calculate confidence for a synthesis
   */
  _calculateSynthesisConfidence(memorySet) {
    // Base confidence from source count
    const countFactor = Math.min(1, memorySet.length / 10)

    // Consistency factor - how similar are the memories
    const contentSimilarity = this._calculateSetSimilarity(memorySet)

    // Recency factor
    const now = Date.now()
    const avgAge = memorySet.reduce((sum, m) => {
      const created = m.createdAt ? new Date(m.createdAt).getTime() : now
      return sum + (now - created)
    }, 0) / memorySet.length
    const recencyFactor = Math.max(0.5, 1 - (avgAge / (30 * 24 * 60 * 60 * 1000))) // Decay over 30 days

    return Math.round((countFactor * 0.4 + contentSimilarity * 0.4 + recencyFactor * 0.2) * 100) / 100
  }

  /**
   * Calculate similarity within a memory set
   */
  _calculateSetSimilarity(memorySet) {
    if (memorySet.length < 2) return 1

    const contents = memorySet.map(m =>
      typeof m === 'string' ? m : (m.content || JSON.stringify(m))
    )

    let totalSimilarity = 0
    let comparisons = 0

    for (let i = 0; i < contents.length; i++) {
      for (let j = i + 1; j < contents.length; j++) {
        totalSimilarity += this.calculateClusterSimilarity(contents[i], contents[j])
        comparisons++
      }
    }

    return comparisons > 0 ? totalSimilarity / comparisons : 0
  }

  /**
   * Generate factual summary synthesis
   */
  _generateFactualSummary(contents, topics) {
    const topicStr = topics.length > 0 ? topics.join(', ') : 'various topics'
    const facts = contents.slice(0, 5).map(c =>
      typeof c === 'string' ? c : (c.content || JSON.stringify(c))
    )

    return `Knowledge synthesis about ${topicStr}:\n` +
           facts.map((f, i) => `${i + 1}. ${f.substring(0, 200)}`).join('\n')
  }

  /**
   * Generate preference profile synthesis
   */
  _generatePreferenceProfile(contents) {
    const preferences = contents.map(c =>
      typeof c === 'string' ? c : (c.content || '')
    ).filter(c => c.length > 0)

    return `User preferences profile:\n` +
           preferences.slice(0, 5).map(p => `• ${p.substring(0, 150)}`).join('\n')
  }

  /**
   * Generate decision pattern synthesis
   */
  _generateDecisionPattern(contents) {
    const decisions = contents.slice(0, 4).map(c =>
      typeof c === 'string' ? c : (c.content || '')
    )

    return `Decision pattern observed:\n` +
           `Based on ${contents.length} similar decisions:\n` +
           decisions.map(d => `• ${d.substring(0, 100)}`).join('\n')
  }

  /**
   * Generate workflow insight synthesis
   */
  _generateWorkflowInsight(contents) {
    return `Workflow pattern detected from ${contents.length} observations:\n` +
           contents.slice(0, 3).map((c, i) => {
             const text = typeof c === 'string' ? c : (c.content || '')
             return `Step ${i + 1}: ${text.substring(0, 100)}`
           }).join('\n')
  }

  /**
   * Generate relationship insight synthesis
   */
  _generateRelationshipInsight(contents, entities) {
    const entityStr = entities.slice(0, 3).join(', ')
    return `Relationship insight for ${entityStr}:\n` +
           contents.slice(0, 3).map(c => {
             const text = typeof c === 'string' ? c : (c.content || '')
             return `• ${text.substring(0, 150)}`
           }).join('\n')
  }

  /**
   * Generate generic synthesis
   */
  _generateGenericSynthesis(contents) {
    return `Combined knowledge from ${contents.length} sources:\n` +
           contents.slice(0, 5).map(c => {
             const text = typeof c === 'string' ? c : (c.content || '')
             return `• ${text.substring(0, 100)}`
           }).join('\n')
  }

  /**
   * Calculate topic overlap between two topic arrays
   */
  _calculateTopicOverlap(topics1, topics2) {
    if (!topics1?.length || !topics2?.length) return 0
    const set1 = new Set(topics1)
    const set2 = new Set(topics2)
    const intersection = [...set1].filter(t => set2.has(t)).length
    const union = new Set([...topics1, ...topics2]).size
    return union > 0 ? intersection / union : 0
  }

  /**
   * Helper to flatten learned memories object into array
   */
  _flattenLearnedMemories(learnedObj) {
    const all = []
    for (const [type, items] of Object.entries(learnedObj)) {
      if (Array.isArray(items)) {
        items.forEach(item => all.push({ ...item, type: type.replace(/s$/, '') }))
      }
    }
    return all
  }

  /**
   * Generate synthesis for a specific topic
   */
  generateSynthesis(topic, options = {}) {
    const { minMemories = 3, maxMemories = 20 } = options

    // Find memories related to topic
    const learnedObj = this.getLearnedMemories(topic)
    const learned = this._flattenLearnedMemories(learnedObj)
    const relevant = learned.filter(m => {
      const content = m.content || ''
      return content.toLowerCase().includes(topic.toLowerCase())
    }).slice(0, maxMemories)

    if (relevant.length < minMemories) {
      return {
        success: false,
        reason: `Not enough memories about "${topic}" (found ${relevant.length}, need ${minMemories})`
      }
    }

    const synthesis = this.synthesizeKnowledge(relevant, { forceNew: true })
    return {
      success: true,
      synthesis
    }
  }

  /**
   * Get syntheses relevant to a query
   */
  getSynthesisForQuery(query) {
    const syntheses = this.getSyntheses()
    if (syntheses.length === 0) return []

    const queryLower = query.toLowerCase()
    const queryWords = queryLower.split(/\s+/)

    return syntheses
      .map(synthesis => {
        let score = 0

        // Topic match
        synthesis.topics.forEach(topic => {
          if (queryLower.includes(topic)) score += 0.3
        })

        // Entity match
        synthesis.entities.forEach(entity => {
          if (queryLower.includes(entity)) score += 0.4
        })

        // Content match
        const contentLower = synthesis.content.toLowerCase()
        queryWords.forEach(word => {
          if (word.length > 3 && contentLower.includes(word)) score += 0.1
        })

        return { ...synthesis, relevanceScore: score }
      })
      .filter(s => s.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
  }

  /**
   * Update an existing synthesis with new memories
   */
  updateSynthesis(synthesisId, newMemories) {
    const syntheses = this.getSyntheses()
    const index = syntheses.findIndex(s => s.id === synthesisId)

    if (index === -1) {
      return { success: false, error: 'Synthesis not found' }
    }

    const synthesis = syntheses[index]

    // Add new source memories
    const newIds = newMemories.map(m => m.id || m)
    synthesis.sourceMemories = [...new Set([...synthesis.sourceMemories, ...newIds])]
    synthesis.sourceCount = synthesis.sourceMemories.length

    // Update topics and entities
    const allContents = newMemories.map(m => m.content || m)
    synthesis.topics = [...new Set([...synthesis.topics, ...this._extractCommonTopics(allContents)])]
    synthesis.entities = [...new Set([...synthesis.entities, ...this._extractCommonEntities(allContents)])]

    // Recalculate confidence
    synthesis.confidence = this._calculateSynthesisConfidence(newMemories)
    synthesis.updatedAt = new Date().toISOString()

    syntheses[index] = synthesis
    this._saveSyntheses(syntheses)

    return { success: true, synthesis }
  }

  /**
   * Auto-generate syntheses from existing memories
   */
  autoGenerateSyntheses(options = {}) {
    const { minClusterSize = 3, maxSyntheses = 10 } = options
    const learnedObj = this.getLearnedMemories()
    const learned = this._flattenLearnedMemories(learnedObj)
    const generated = []

    // Group by type
    const byType = {}
    learned.forEach(m => {
      const type = m.type || 'unknown'
      if (!byType[type]) byType[type] = []
      byType[type].push(m)
    })

    // Generate syntheses for each type with enough memories
    for (const [type, memories] of Object.entries(byType)) {
      if (memories.length >= minClusterSize && generated.length < maxSyntheses) {
        // Cluster by topic
        const clusters = this._clusterByTopic(memories)

        for (const cluster of clusters) {
          if (cluster.length >= minClusterSize && generated.length < maxSyntheses) {
            const synthesis = this.synthesizeKnowledge(cluster)
            if (synthesis) {
              generated.push(synthesis)
            }
          }
        }
      }
    }

    return {
      generated: generated.length,
      syntheses: generated
    }
  }

  /**
   * Cluster memories by topic similarity
   */
  _clusterByTopic(memories) {
    const clusters = []
    const assigned = new Set()

    for (const memory of memories) {
      if (assigned.has(memory.id)) continue

      const cluster = [memory]
      assigned.add(memory.id)

      const memTopics = this._extractCommonTopics([memory.content || ''])

      for (const other of memories) {
        if (assigned.has(other.id)) continue

        const otherTopics = this._extractCommonTopics([other.content || ''])
        if (this._calculateTopicOverlap(memTopics, otherTopics) > 0.3) {
          cluster.push(other)
          assigned.add(other.id)
        }
      }

      if (cluster.length >= 2) {
        clusters.push(cluster)
      }
    }

    return clusters
  }

  // ----------------------------------------
  // 9.2 Trend Detection System
  // ----------------------------------------

  /**
   * Get trend data storage
   */
  getTrendData() {
    const key = 'quox_trend_data'
    const data = localStorage.getItem(key)
    return data ? JSON.parse(data) : {
      snapshots: [],
      lastAnalysis: null
    }
  }

  /**
   * Save trend data
   */
  _saveTrendData(data) {
    localStorage.setItem('quox_trend_data', JSON.stringify(data))
    // Note: 'quox_trend_data' is a separate legacy localStorage key from
    // 'quox_trends' (written in _saveData above), but both map to the same
    // server-side 'trends' identity namespace pre-existing duplication,
    // not introduced here. Last writer wins server-side.
    this._identityWriteThrough('trends', data)
  }

  /**
   * Record a trend snapshot
   */
  recordTrendSnapshot() {
    const trendData = this.getTrendData()
    const patterns = this.getBehaviorPatterns()
    const learnedObj = this.getLearnedMemories()
    const learned = this._flattenLearnedMemories(learnedObj)

    const snapshot = {
      timestamp: new Date().toISOString(),
      metrics: {
        totalMemories: learned.length,
        totalInteractions: patterns.interaction.totalQueries,
        topTopics: Object.entries(patterns.content.topicFrequency)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([topic, count]) => ({ topic, count })),
        queryTypes: { ...patterns.content.queryPatterns },
        satisfaction: {
          positive: patterns.satisfaction.positiveSignals,
          negative: patterns.satisfaction.negativeSignals,
          neutral: patterns.satisfaction.neutralSignals
        },
        avgQueryLength: patterns.interaction.queryLengths.length > 0
          ? patterns.interaction.queryLengths.reduce((a, b) => a + b, 0) / patterns.interaction.queryLengths.length
          : 0
      }
    }

    trendData.snapshots.push(snapshot)
    // Keep last 100 snapshots
    trendData.snapshots = trendData.snapshots.slice(-100)
    this._saveTrendData(trendData)

    return snapshot
  }

  /**
   * Detect trends over a time window
   */
  detectTrends(timeWindowDays = 7) {
    const trendData = this.getTrendData()
    const cutoff = Date.now() - (timeWindowDays * 24 * 60 * 60 * 1000)

    const recentSnapshots = trendData.snapshots.filter(s =>
      new Date(s.timestamp).getTime() > cutoff
    )

    if (recentSnapshots.length < 2) {
      return {
        detected: false,
        reason: 'Not enough data points',
        snapshotCount: recentSnapshots.length
      }
    }

    const trends = {
      detected: true,
      timeWindow: `${timeWindowDays} days`,
      snapshotCount: recentSnapshots.length,
      trends: {}
    }

    // Analyze memory growth
    const firstSnapshot = recentSnapshots[0]
    const lastSnapshot = recentSnapshots[recentSnapshots.length - 1]

    trends.trends.memoryGrowth = {
      start: firstSnapshot.metrics.totalMemories,
      end: lastSnapshot.metrics.totalMemories,
      change: lastSnapshot.metrics.totalMemories - firstSnapshot.metrics.totalMemories,
      direction: lastSnapshot.metrics.totalMemories > firstSnapshot.metrics.totalMemories ? 'increasing' :
                 lastSnapshot.metrics.totalMemories < firstSnapshot.metrics.totalMemories ? 'decreasing' : 'stable'
    }

    // Analyze interaction trend
    trends.trends.interactions = {
      start: firstSnapshot.metrics.totalInteractions,
      end: lastSnapshot.metrics.totalInteractions,
      change: lastSnapshot.metrics.totalInteractions - firstSnapshot.metrics.totalInteractions,
      direction: lastSnapshot.metrics.totalInteractions > firstSnapshot.metrics.totalInteractions ? 'increasing' : 'stable'
    }

    // Analyze topic evolution
    const startTopics = new Set(firstSnapshot.metrics.topTopics.map(t => t.topic))
    const endTopics = new Set(lastSnapshot.metrics.topTopics.map(t => t.topic))
    const newTopics = [...endTopics].filter(t => !startTopics.has(t))
    const droppedTopics = [...startTopics].filter(t => !endTopics.has(t))

    trends.trends.topicEvolution = {
      newTopics,
      droppedTopics,
      stable: [...startTopics].filter(t => endTopics.has(t)),
      shift: newTopics.length > 0 || droppedTopics.length > 0
    }

    // Analyze satisfaction trend
    const startSat = firstSnapshot.metrics.satisfaction
    const endSat = lastSnapshot.metrics.satisfaction
    const startTotal = startSat.positive + startSat.negative + startSat.neutral
    const endTotal = endSat.positive + endSat.negative + endSat.neutral

    const startPositiveRate = startTotal > 0 ? startSat.positive / startTotal : 0
    const endPositiveRate = endTotal > 0 ? endSat.positive / endTotal : 0

    trends.trends.satisfaction = {
      startRate: Math.round(startPositiveRate * 100),
      endRate: Math.round(endPositiveRate * 100),
      change: Math.round((endPositiveRate - startPositiveRate) * 100),
      direction: endPositiveRate > startPositiveRate ? 'improving' :
                 endPositiveRate < startPositiveRate ? 'declining' : 'stable'
    }

    // Analyze query complexity (avg length trend)
    const avgLengths = recentSnapshots.map(s => s.metrics.avgQueryLength).filter(l => l > 0)
    if (avgLengths.length >= 2) {
      const firstHalf = avgLengths.slice(0, Math.floor(avgLengths.length / 2))
      const secondHalf = avgLengths.slice(Math.floor(avgLengths.length / 2))
      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
      const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length

      trends.trends.queryComplexity = {
        earlyAvg: Math.round(firstAvg * 10) / 10,
        recentAvg: Math.round(secondAvg * 10) / 10,
        direction: secondAvg > firstAvg * 1.1 ? 'increasing' :
                   secondAvg < firstAvg * 0.9 ? 'decreasing' : 'stable'
      }
    }

    trendData.lastAnalysis = new Date().toISOString()
    this._saveTrendData(trendData)

    return trends
  }

  /**
   * Generate a trend report
   */
  getTrendReport() {
    const trends = this.detectTrends(30) // Last 30 days

    if (!trends.detected) {
      return {
        summary: 'Not enough data for trend analysis',
        recommendations: ['Continue using the system to build trend data']
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      period: trends.timeWindow,
      summary: '',
      highlights: [],
      recommendations: []
    }

    // Build summary
    const summaryParts = []

    if (trends.trends.memoryGrowth?.change > 0) {
      summaryParts.push(`${trends.trends.memoryGrowth.change} new memories added`)
      report.highlights.push({
        type: 'memory_growth',
        message: `Memory base grew by ${trends.trends.memoryGrowth.change} items`
      })
    }

    if (trends.trends.topicEvolution?.newTopics?.length > 0) {
      summaryParts.push(`New interests: ${trends.trends.topicEvolution.newTopics.join(', ')}`)
      report.highlights.push({
        type: 'new_interests',
        message: `Started exploring: ${trends.trends.topicEvolution.newTopics.join(', ')}`
      })
    }

    if (trends.trends.satisfaction?.direction === 'improving') {
      report.highlights.push({
        type: 'satisfaction_up',
        message: `Satisfaction improved by ${trends.trends.satisfaction.change}%`
      })
    } else if (trends.trends.satisfaction?.direction === 'declining') {
      report.highlights.push({
        type: 'satisfaction_down',
        message: `Satisfaction declined by ${Math.abs(trends.trends.satisfaction.change)}%`
      })
      report.recommendations.push('Review recent interactions for areas of improvement')
    }

    if (trends.trends.queryComplexity?.direction === 'increasing') {
      report.highlights.push({
        type: 'expertise_growth',
        message: 'Query complexity increasing - user becoming more sophisticated'
      })
    }

    report.summary = summaryParts.length > 0
      ? summaryParts.join('. ') + '.'
      : 'System usage has been stable.'

    report.trends = trends.trends

    return report
  }

  /**
   * Predict future trend based on current data
   */
  predictFromTrends(metric) {
    const trends = this.detectTrends(14) // Use 2 weeks of data

    if (!trends.detected || !trends.trends[metric]) {
      return {
        prediction: null,
        confidence: 0,
        reason: `No trend data for ${metric}`
      }
    }

    const trend = trends.trends[metric]
    const prediction = {
      metric,
      currentDirection: trend.direction,
      confidence: 0.5,
      prediction: null
    }

    // Simple linear prediction
    if (trend.direction === 'increasing') {
      prediction.prediction = 'Expected to continue growing'
      prediction.confidence = 0.6
    } else if (trend.direction === 'declining') {
      prediction.prediction = 'May continue to decline'
      prediction.confidence = 0.5
      prediction.recommendation = 'Consider interventions'
    } else {
      prediction.prediction = 'Expected to remain stable'
      prediction.confidence = 0.7
    }

    return prediction
  }

  // ----------------------------------------
  // 9.3 Predictive Context Loading
  // ----------------------------------------

  /**
   * Prediction signals configuration
   */
  static PREDICTION_SIGNALS = {
    query_prefix: {
      'how do i': ['procedures', 'workflows', 'similar_questions'],
      'how to': ['procedures', 'workflows', 'similar_questions'],
      'what is': ['facts', 'entities', 'definitions'],
      'what are': ['facts', 'entities', 'definitions'],
      'why did': ['errors', 'decisions', 'constraints'],
      'why is': ['errors', 'decisions', 'constraints'],
      'show me': ['entities', 'recent_context', 'projects'],
      'list': ['entities', 'facts', 'recent_context'],
      'fix': ['errors', 'troubleshooting', 'constraints'],
      'debug': ['errors', 'troubleshooting', 'recent_context']
    },
    time_of_day: {
      morning: ['status_checks', 'health_reports', 'daily_tasks'],
      afternoon: ['active_work', 'debugging', 'development'],
      evening: ['backup_procedures', 'cleanup_tasks', 'summaries'],
      night: ['monitoring', 'batch_jobs', 'maintenance']
    }
  }

  /**
   * Predict what context will be needed for a query
   */
  predictContextNeeds(query) {
    const prediction = {
      query,
      predictedNeeds: [],
      confidence: 0,
      signals: []
    }

    const queryLower = query.toLowerCase()

    // Check query prefix patterns
    for (const [prefix, needs] of Object.entries(MemoryManager.PREDICTION_SIGNALS.query_prefix)) {
      if (queryLower.startsWith(prefix)) {
        prediction.predictedNeeds.push(...needs)
        prediction.signals.push({ type: 'prefix', value: prefix })
        prediction.confidence += 0.3
        break
      }
    }

    // Check for entity mentions
    const entityPattern = /\b(docker\d*|proxmox\d*|nas\d*|grafana\d*|nginx|traefik)\b/gi
    const entities = query.match(entityPattern) || []
    if (entities.length > 0) {
      prediction.predictedNeeds.push('entities')
      prediction.predictedNeeds.push('entity_relationships')
      prediction.signals.push({ type: 'entity_mention', value: entities })
      prediction.confidence += 0.2
    }

    // Check time of day
    const hour = new Date().getHours()
    let timeOfDay = 'afternoon'
    if (hour < 6) timeOfDay = 'night'
    else if (hour < 12) timeOfDay = 'morning'
    else if (hour < 18) timeOfDay = 'afternoon'
    else timeOfDay = 'evening'

    const timeNeeds = MemoryManager.PREDICTION_SIGNALS.time_of_day[timeOfDay] || []
    prediction.predictedNeeds.push(...timeNeeds)
    prediction.signals.push({ type: 'time_of_day', value: timeOfDay })

    // Check recent context patterns
    const patterns = this.getBehaviorPatterns()
    const topTopics = Object.entries(patterns.content.topicFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([topic]) => topic)

    if (topTopics.some(t => queryLower.includes(t))) {
      prediction.predictedNeeds.push('topic_history')
      prediction.signals.push({ type: 'frequent_topic', value: topTopics })
      prediction.confidence += 0.15
    }

    // Deduplicate needs
    prediction.predictedNeeds = [...new Set(prediction.predictedNeeds)]
    prediction.confidence = Math.min(1, prediction.confidence)

    return prediction
  }

  /**
   * Preload context based on predictions
   */
  async preloadContext(predictions) {
    const preloaded = {
      timestamp: new Date().toISOString(),
      sources: {},
      totalItems: 0
    }

    for (const need of predictions.predictedNeeds) {
      switch (need) {
        case 'entities':
        case 'entity_relationships':
          preloaded.sources.entities = this.getAllEntities().slice(0, 10)
          preloaded.totalItems += preloaded.sources.entities.length
          break

        case 'facts':
        case 'definitions':
          preloaded.sources.facts = (this.getLearnedMemories().facts || []).slice(0, 10)
          preloaded.totalItems += (preloaded.sources.facts?.length || 0)
          break

        case 'procedures':
        case 'workflows':
          preloaded.sources.workflows = this.getSyntheses()
            .filter(s => s.type === 'workflow_insight')
            .slice(0, 5)
          preloaded.totalItems += (preloaded.sources.workflows?.length || 0)
          break

        case 'errors':
        case 'troubleshooting':
          preloaded.sources.errors = (this.getLearnedMemories().errors || []).slice(0, 10)
          preloaded.totalItems += (preloaded.sources.errors?.length || 0)
          break

        case 'recent_context':
          preloaded.sources.recent = this.getRecentContext(10)
          preloaded.totalItems += (preloaded.sources.recent?.length || 0)
          break

        case 'projects':
          preloaded.sources.projects = this.getProjects().slice(0, 5)
          preloaded.totalItems += (preloaded.sources.projects?.length || 0)
          break

        case 'similar_questions':
          // Use syntheses as proxy for similar questions
          preloaded.sources.similar = this.getSyntheses().slice(0, 5)
          preloaded.totalItems += (preloaded.sources.similar?.length || 0)
          break
      }
    }

    return preloaded
  }

  /**
   * Get predictive recommendations based on context
   */
  getPredictiveRecommendations() {
    const patterns = this.getBehaviorPatterns()
    const styleProfile = this.getStyleProfile()
    const recommendations = []

    // Based on frequent topics
    const topTopics = Object.entries(patterns.content.topicFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)

    if (topTopics.length > 0) {
      recommendations.push({
        type: 'topic_focus',
        message: `You frequently work with ${topTopics.map(([t]) => t).join(', ')}`,
        suggestions: topTopics.map(([topic]) => `Review ${topic} knowledge`)
      })
    }

    // Based on time patterns
    const peakHour = patterns.timing.activeHours.indexOf(
      Math.max(...patterns.timing.activeHours)
    )
    const currentHour = new Date().getHours()

    if (Math.abs(currentHour - peakHour) <= 2) {
      recommendations.push({
        type: 'peak_time',
        message: 'This is typically your most active time',
        suggestions: ['Good time for complex tasks']
      })
    }

    // Based on query patterns
    const topQueryType = Object.entries(patterns.content.queryPatterns)
      .sort((a, b) => b[1] - a[1])[0]

    if (topQueryType) {
      recommendations.push({
        type: 'query_pattern',
        message: `You often ask ${topQueryType[0].replace('_', ' ')} questions`,
        suggestions: [`Consider creating saved procedures for common ${topQueryType[0]} queries`]
      })
    }

    return recommendations
  }

  /**
   * Learn from what context was actually useful
   */
  learnContextPatterns(interaction) {
    const key = 'quox_context_patterns'
    const data = localStorage.getItem(key)
    const patterns = data ? JSON.parse(data) : {
      usefulContext: {},
      queryToContext: {}
    }

    // Track what context was provided and if it was useful
    if (interaction.contextProvided && interaction.wasUseful) {
      for (const contextType of interaction.contextProvided) {
        patterns.usefulContext[contextType] =
          (patterns.usefulContext[contextType] || 0) + 1
      }
    }

    // Track query pattern to useful context mapping
    if (interaction.query && interaction.usefulContext) {
      const queryType = this._classifyQueryPattern(interaction.query)
      if (!patterns.queryToContext[queryType]) {
        patterns.queryToContext[queryType] = {}
      }
      for (const ctx of interaction.usefulContext) {
        patterns.queryToContext[queryType][ctx] =
          (patterns.queryToContext[queryType][ctx] || 0) + 1
      }
    }

    localStorage.setItem(key, JSON.stringify(patterns))
    return patterns
  }

  // ----------------------------------------
  // 9.4 Cross-Session Narrative
  // ----------------------------------------

  /**
   * Get session narratives storage
   */
  getSessionNarratives() {
    const key = 'quox_session_narratives'
    const data = localStorage.getItem(key)
    return data ? JSON.parse(data) : []
  }

  /**
   * Save session narratives
   */
  _saveSessionNarratives(narratives) {
    localStorage.setItem('quox_session_narratives', JSON.stringify(narratives))
    // Note: 'quox_session_narratives' is a separate legacy localStorage key
    // from 'quox_narratives' (written in _saveData above), but both map to
    // the same server-side 'narratives' identity namespace — pre-existing
    // duplication, not introduced here. Last writer wins server-side.
    this._identityWriteThrough('narratives', narratives)
  }

  /**
   * Build a narrative for a session
   */
  buildSessionNarrative(sessionId, interactions = []) {
    const narrative = {
      sessionId: sessionId || crypto.randomUUID(),
      startTime: new Date().toISOString(),
      endTime: null,
      summary: '',
      keyTopics: [],
      entitiesDiscussed: [],
      decisionsMade: [],
      problemsSolved: [],
      questionsAsked: 0,
      continuesFrom: null,
      continuedBy: null,
      relatedSessions: [],
      newKnowledge: [],
      reinforcedKnowledge: []
    }

    // Analyze interactions
    const allTopics = new Set()
    const allEntities = new Set()

    for (const interaction of interactions) {
      narrative.questionsAsked++

      // Extract topics
      const topics = this._extractTopics(interaction.query || '')
      topics.forEach(t => allTopics.add(t))

      // Extract entities
      const entityPattern = /\b(docker\d*|proxmox\d*|nas\d*|nginx|grafana)\b/gi
      const entities = (interaction.query || '').match(entityPattern) || []
      entities.forEach(e => allEntities.add(e.toLowerCase()))

      // Track decisions
      if (/decide|chose|going with|will use/i.test(interaction.query || '')) {
        narrative.decisionsMade.push(interaction.query.substring(0, 100))
      }

      // Track problems solved
      if (/fixed|solved|resolved|working now/i.test(interaction.query || '')) {
        narrative.problemsSolved.push(interaction.query.substring(0, 100))
      }
    }

    narrative.keyTopics = [...allTopics]
    narrative.entitiesDiscussed = [...allEntities]

    // Generate summary
    const summaryParts = []
    if (narrative.keyTopics.length > 0) {
      summaryParts.push(`Topics: ${narrative.keyTopics.join(', ')}`)
    }
    if (narrative.decisionsMade.length > 0) {
      summaryParts.push(`${narrative.decisionsMade.length} decisions made`)
    }
    if (narrative.problemsSolved.length > 0) {
      summaryParts.push(`${narrative.problemsSolved.length} problems solved`)
    }
    narrative.summary = summaryParts.join('. ')

    return narrative
  }

  /**
   * Save and link a session narrative
   */
  saveSessionNarrative(narrative) {
    const narratives = this.getSessionNarratives()

    // Find potentially related sessions
    const related = narratives.filter(n => {
      const topicOverlap = this._calculateTopicOverlap(n.keyTopics, narrative.keyTopics)
      return topicOverlap > 0.3
    }).slice(0, 5)

    narrative.relatedSessions = related.map(r => r.sessionId)
    narrative.endTime = new Date().toISOString()

    // Check if this continues from a recent session
    const recentNarratives = narratives
      .filter(n => {
        const endTime = new Date(n.endTime).getTime()
        const now = Date.now()
        return (now - endTime) < (2 * 60 * 60 * 1000) // Within 2 hours
      })
      .sort((a, b) => new Date(b.endTime) - new Date(a.endTime))

    if (recentNarratives.length > 0) {
      const recent = recentNarratives[0]
      const topicOverlap = this._calculateTopicOverlap(recent.keyTopics, narrative.keyTopics)

      if (topicOverlap > 0.5) {
        narrative.continuesFrom = recent.sessionId
        // Update the previous session to point to this one
        const prevIndex = narratives.findIndex(n => n.sessionId === recent.sessionId)
        if (prevIndex !== -1) {
          narratives[prevIndex].continuedBy = narrative.sessionId
        }
      }
    }

    narratives.push(narrative)
    // Keep last 100 narratives
    const trimmed = narratives.slice(-100)
    this._saveSessionNarratives(trimmed)

    return narrative
  }

  /**
   * Get context from past sessions relevant to a query
   */
  getCrossSessionContext(query) {
    const narratives = this.getSessionNarratives()
    if (narratives.length === 0) return []

    const queryTopics = this._extractTopics(query)
    const queryLower = query.toLowerCase()

    return narratives
      .map(narrative => {
        let relevance = 0

        // Topic overlap
        relevance += this._calculateTopicOverlap(queryTopics, narrative.keyTopics) * 0.4

        // Entity overlap
        narrative.entitiesDiscussed.forEach(entity => {
          if (queryLower.includes(entity)) relevance += 0.2
        })

        // Recency bonus
        const age = Date.now() - new Date(narrative.endTime).getTime()
        const daysSince = age / (24 * 60 * 60 * 1000)
        if (daysSince < 1) relevance += 0.2
        else if (daysSince < 7) relevance += 0.1

        return { ...narrative, relevance }
      })
      .filter(n => n.relevance > 0.1)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 5)
  }

  /**
   * Get ongoing narratives (storylines across sessions)
   */
  getOngoingNarratives() {
    const narratives = this.getSessionNarratives()
    const chains = []
    const visited = new Set()

    for (const narrative of narratives) {
      if (visited.has(narrative.sessionId)) continue
      if (!narrative.continuesFrom && !narrative.continuedBy) continue

      // Build chain
      const chain = [narrative]
      visited.add(narrative.sessionId)

      // Follow backwards
      let current = narrative
      while (current.continuesFrom) {
        const prev = narratives.find(n => n.sessionId === current.continuesFrom)
        if (!prev || visited.has(prev.sessionId)) break
        chain.unshift(prev)
        visited.add(prev.sessionId)
        current = prev
      }

      // Follow forwards
      current = narrative
      while (current.continuedBy) {
        const next = narratives.find(n => n.sessionId === current.continuedBy)
        if (!next || visited.has(next.sessionId)) break
        chain.push(next)
        visited.add(next.sessionId)
        current = next
      }

      if (chain.length >= 2) {
        chains.push({
          id: `chain_${chain[0].sessionId}`,
          sessions: chain,
          topics: [...new Set(chain.flatMap(c => c.keyTopics))],
          startTime: chain[0].startTime,
          endTime: chain[chain.length - 1].endTime,
          totalQuestions: chain.reduce((sum, c) => sum + c.questionsAsked, 0)
        })
      }
    }

    return chains.sort((a, b) => new Date(b.endTime) - new Date(a.endTime))
  }

  // ----------------------------------------
  // 9.5 Memory Importance Evolution
  // ----------------------------------------

  /**
   * Get importance evolution data
   */
  getImportanceEvolutionData() {
    const key = 'quox_importance_evolution'
    const data = localStorage.getItem(key)
    return data ? JSON.parse(data) : {
      history: {},
      lastEvolution: null
    }
  }

  /**
   * Save importance evolution data
   */
  _saveImportanceEvolutionData(data) {
    localStorage.setItem('quox_importance_evolution', JSON.stringify(data))
    this._identityWriteThrough('importance_evolution', data)
  }

  /**
   * Evolution factors
   */
  static IMPORTANCE_EVOLUTION = {
    reinforcement: {
      accessed: 0.05,
      cited_in_response: 0.10,
      user_confirmed_useful: 0.15,
      used_in_synthesis: 0.08
    },
    decay: {
      time_based_weekly: -0.02,
      contradicted: -0.20,
      user_marked_wrong: -0.30,
      never_accessed_monthly: -0.05
    },
    thresholds: {
      promotion: 0.8,
      demotion: 0.2
    }
  }

  /**
   * Run importance evolution cycle
   */
  evolveImportance() {
    const learnedObj = this.getLearnedMemories()
    const learned = this._flattenLearnedMemories(learnedObj)
    const evolutionData = this.getImportanceEvolutionData()
    const now = Date.now()

    const results = {
      evolved: 0,
      promoted: [],
      demoted: [],
      unchanged: 0
    }

    for (const memory of learned) {
      const memoryId = memory.id
      if (!memoryId) continue

      // Get or create history
      if (!evolutionData.history[memoryId]) {
        evolutionData.history[memoryId] = {
          initialImportance: memory.salience || 0.5,
          currentImportance: memory.salience || 0.5,
          lastAccessed: memory.createdAt,
          accessCount: 0,
          evolutionHistory: []
        }
      }

      const history = evolutionData.history[memoryId]
      const oldImportance = history.currentImportance

      // Apply time-based decay
      const lastAccessed = new Date(history.lastAccessed).getTime()
      const weeksSinceAccess = (now - lastAccessed) / (7 * 24 * 60 * 60 * 1000)

      let newImportance = oldImportance

      if (weeksSinceAccess > 1) {
        newImportance += MemoryManager.IMPORTANCE_EVOLUTION.decay.time_based_weekly * Math.floor(weeksSinceAccess)
      }

      // Apply never-accessed decay
      if (history.accessCount === 0) {
        const monthsSinceCreation = (now - new Date(memory.createdAt).getTime()) / (30 * 24 * 60 * 60 * 1000)
        if (monthsSinceCreation > 1) {
          newImportance += MemoryManager.IMPORTANCE_EVOLUTION.decay.never_accessed_monthly * Math.floor(monthsSinceCreation)
        }
      }

      // Clamp importance
      newImportance = Math.max(0, Math.min(1, newImportance))

      // Check for promotion/demotion
      if (newImportance >= MemoryManager.IMPORTANCE_EVOLUTION.thresholds.promotion &&
          oldImportance < MemoryManager.IMPORTANCE_EVOLUTION.thresholds.promotion) {
        results.promoted.push({
          id: memoryId,
          content: memory.content?.substring(0, 50),
          importance: newImportance
        })
      } else if (newImportance <= MemoryManager.IMPORTANCE_EVOLUTION.thresholds.demotion &&
                 oldImportance > MemoryManager.IMPORTANCE_EVOLUTION.thresholds.demotion) {
        results.demoted.push({
          id: memoryId,
          content: memory.content?.substring(0, 50),
          importance: newImportance
        })
      }

      if (Math.abs(newImportance - oldImportance) > 0.01) {
        history.currentImportance = newImportance
        history.evolutionHistory.push({
          timestamp: new Date().toISOString(),
          oldValue: oldImportance,
          newValue: newImportance,
          reason: 'time_decay'
        })
        history.evolutionHistory = history.evolutionHistory.slice(-20) // Keep last 20
        results.evolved++
      } else {
        results.unchanged++
      }
    }

    evolutionData.lastEvolution = new Date().toISOString()
    this._saveImportanceEvolutionData(evolutionData)

    return results
  }

  /**
   * Record memory access for importance evolution (reinforcement)
   */
  recordEvolutionAccess(memoryId, accessType = 'accessed') {
    const evolutionData = this.getImportanceEvolutionData()

    if (!evolutionData.history[memoryId]) {
      evolutionData.history[memoryId] = {
        initialImportance: 0.5,
        currentImportance: 0.5,
        lastAccessed: new Date().toISOString(),
        accessCount: 0,
        evolutionHistory: []
      }
    }

    const history = evolutionData.history[memoryId]
    const reinforcement = MemoryManager.IMPORTANCE_EVOLUTION.reinforcement[accessType] || 0.05

    history.accessCount++
    history.lastAccessed = new Date().toISOString()

    const oldImportance = history.currentImportance
    history.currentImportance = Math.min(1, history.currentImportance + reinforcement)

    history.evolutionHistory.push({
      timestamp: new Date().toISOString(),
      oldValue: oldImportance,
      newValue: history.currentImportance,
      reason: accessType
    })

    this._saveImportanceEvolutionData(evolutionData)

    return {
      memoryId,
      oldImportance,
      newImportance: history.currentImportance,
      accessCount: history.accessCount
    }
  }

  /**
   * Get importance history for a memory
   */
  getImportanceHistory(memoryId) {
    const evolutionData = this.getImportanceEvolutionData()
    return evolutionData.history[memoryId] || null
  }

  /**
   * Identify memories with emerging importance
   */
  identifyEmergingImportance(threshold = 0.1) {
    const evolutionData = this.getImportanceEvolutionData()
    const emerging = []

    for (const [memoryId, history] of Object.entries(evolutionData.history)) {
      if (history.evolutionHistory.length < 2) continue

      const recentHistory = history.evolutionHistory.slice(-5)
      const oldestRecent = recentHistory[0]
      const newest = recentHistory[recentHistory.length - 1]

      const growth = newest.newValue - oldestRecent.oldValue

      if (growth > threshold) {
        emerging.push({
          memoryId,
          currentImportance: history.currentImportance,
          growth,
          accessCount: history.accessCount
        })
      }
    }

    return emerging.sort((a, b) => b.growth - a.growth)
  }

  /**
   * Identify fading memories
   */
  identifyFadingMemories(threshold = 0.1) {
    const evolutionData = this.getImportanceEvolutionData()
    const fading = []

    for (const [memoryId, history] of Object.entries(evolutionData.history)) {
      if (history.evolutionHistory.length < 2) continue

      const recentHistory = history.evolutionHistory.slice(-5)
      const oldestRecent = recentHistory[0]
      const newest = recentHistory[recentHistory.length - 1]

      const decline = oldestRecent.oldValue - newest.newValue

      if (decline > threshold) {
        fading.push({
          memoryId,
          currentImportance: history.currentImportance,
          decline,
          lastAccessed: history.lastAccessed,
          neverAccessed: history.accessCount === 0
        })
      }
    }

    return fading.sort((a, b) => b.decline - a.decline)
  }

  /**
   * Get memory evolution statistics
   */
  getMemoryEvolutionStats() {
    const evolutionData = this.getImportanceEvolutionData()
    const histories = Object.values(evolutionData.history)

    if (histories.length === 0) {
      return {
        totalTracked: 0,
        avgImportance: 0,
        accessedCount: 0,
        promotionCandidates: 0,
        demotionCandidates: 0
      }
    }

    const importances = histories.map(h => h.currentImportance)
    const totalAccessed = histories.filter(h => h.accessCount > 0).length

    return {
      totalTracked: histories.length,
      avgImportance: Math.round((importances.reduce((a, b) => a + b, 0) / importances.length) * 100) / 100,
      accessedCount: totalAccessed,
      neverAccessedCount: histories.length - totalAccessed,
      promotionCandidates: histories.filter(h =>
        h.currentImportance >= MemoryManager.IMPORTANCE_EVOLUTION.thresholds.promotion
      ).length,
      demotionCandidates: histories.filter(h =>
        h.currentImportance <= MemoryManager.IMPORTANCE_EVOLUTION.thresholds.demotion
      ).length,
      lastEvolution: evolutionData.lastEvolution
    }
  }

  // ============================================================================
  // PHASE 10: MEMORY EXPERIENCE LAYER
  // ============================================================================
  // Provides user-friendly interfaces for memory management including natural
  // language commands, visualization data, privacy controls, and health metrics.
  // ============================================================================

  // ---------------------------------------------------------------------------
  // 10.1 Natural Language Memory Control
  // ---------------------------------------------------------------------------
  // Allows users to manage memories through natural language commands

  /**
   * Command patterns for natural language memory control
   */
  static NL_COMMAND_PATTERNS = {
    remember: [
      /^remember\s+(?:that\s+)?(.+)$/i,
      /^note\s+(?:that\s+)?(.+)$/i,
      /^save\s+(?:that\s+)?(.+)$/i,
      /^store\s+(?:that\s+)?(.+)$/i,
      /^don'?t\s+forget\s+(?:that\s+)?(.+)$/i
    ],
    forget: [
      /^forget\s+(?:about\s+)?(.+)$/i,
      /^delete\s+(?:memory\s+(?:about\s+)?)?(.+)$/i,
      /^remove\s+(?:memory\s+(?:about\s+)?)?(.+)$/i,
      /^erase\s+(?:memory\s+(?:about\s+)?)?(.+)$/i
    ],
    query: [
      /^what\s+do\s+you\s+(?:know|remember)\s+about\s+(.+)\??$/i,
      /^recall\s+(?:everything\s+about\s+)?(.+)$/i,
      /^search\s+(?:memories?\s+(?:for|about)\s+)?(.+)$/i,
      /^find\s+(?:memories?\s+(?:for|about)\s+)?(.+)$/i
    ],
    update: [
      /^update\s+(?:memory\s+)?(?:about\s+)?(.+?)\s+to\s+(.+)$/i,
      /^change\s+(?:memory\s+)?(?:about\s+)?(.+?)\s+to\s+(.+)$/i,
      /^correct\s+(?:that\s+)?(.+?)\s+(?:to|is actually)\s+(.+)$/i,
      /^actually[,\s]+(.+?)\s+(?:is|should be)\s+(.+)$/i
    ],
    list: [
      /^list\s+(?:all\s+)?(?:my\s+)?memories?(?:\s+about\s+(.+))?$/i,
      /^show\s+(?:all\s+)?(?:my\s+)?memories?(?:\s+about\s+(.+))?$/i,
      /^what\s+(?:do\s+you|have\s+you)\s+remembered\??$/i
    ],
    privacy: [
      /^mark\s+(.+?)\s+as\s+(private|sensitive|confidential)$/i,
      /^make\s+(.+?)\s+(private|sensitive|confidential)$/i,
      /^hide\s+(.+)$/i
    ],
    export: [
      /^export\s+(?:my\s+)?memories?$/i,
      /^backup\s+(?:my\s+)?memories?$/i,
      /^download\s+(?:my\s+)?memories?$/i
    ]
  }

  /**
   * Parse a natural language memory command
   * @param {string} input - User input
   * @returns {Object|null} Parsed command or null
   */
  parseMemoryCommand(input) {
    if (!input || typeof input !== 'string') {
      return null
    }

    const trimmed = input.trim()

    // Check each command type
    for (const [commandType, patterns] of Object.entries(MemoryManager.NL_COMMAND_PATTERNS)) {
      for (const pattern of patterns) {
        const match = trimmed.match(pattern)
        if (match) {
          const result = {
            type: commandType,
            raw: trimmed,
            parsed: {
              content: match[1]?.trim(),
              target: match[2]?.trim()
            },
            confidence: this._calculateCommandConfidence(commandType, match),
            timestamp: new Date().toISOString()
          }

          // Detect memory type from content for remember commands
          if (commandType === 'remember') {
            result.parsed.memoryType = this._inferMemoryType(result.parsed.content)
          }

          return result
        }
      }
    }

    return null
  }

  /**
   * Calculate confidence score for parsed command
   */
  _calculateCommandConfidence(commandType, match) {
    let confidence = 0.7 // Base confidence

    // Boost for explicit command words
    const explicitWords = {
      remember: ['remember', 'save', 'store', 'note'],
      forget: ['forget', 'delete', 'remove', 'erase'],
      query: ['recall', 'search', 'find', 'know', 'remember'],
      update: ['update', 'change', 'correct', 'actually'],
      list: ['list', 'show', 'remembered'],
      privacy: ['mark', 'make', 'hide', 'private'],
      export: ['export', 'backup', 'download']
    }

    if (explicitWords[commandType]?.some(w => match[0].toLowerCase().includes(w))) {
      confidence += 0.2
    }

    // Reduce confidence for very short content
    if (match[1]?.length < 10) {
      confidence -= 0.1
    }

    // Boost for longer, more specific content
    if (match[1]?.length > 50) {
      confidence += 0.1
    }

    return Math.min(1, Math.max(0, confidence))
  }

  /**
   * Infer memory type from content
   */
  _inferMemoryType(content) {
    if (!content) return 'fact'

    const lower = content.toLowerCase()

    // Preference patterns
    if (lower.match(/\b(prefer|like|want|don'?t like|hate|love|favorite|always|never)\b/)) {
      return 'preference'
    }

    // Constraint patterns
    if (lower.match(/\b(don'?t|never|avoid|must not|shouldn'?t|can'?t|won'?t)\b/)) {
      return 'constraint'
    }

    // Decision patterns
    if (lower.match(/\b(decided|chose|picked|went with|selected|will use)\b/)) {
      return 'decision'
    }

    // Workflow patterns
    if (lower.match(/\b(workflow|process|steps?|procedure|routine|how I)\b/)) {
      return 'workflow'
    }

    // Error patterns
    if (lower.match(/\b(error|bug|issue|problem|fixed|broken|crashed)\b/)) {
      return 'error'
    }

    return 'fact'
  }

  /**
   * Execute a parsed memory command
   * @param {Object} command - Parsed command from parseMemoryCommand
   * @returns {Object} Execution result
   */
  async executeMemoryCommand(command) {
    if (!command?.type) {
      return {
        success: false,
        error: 'Invalid command',
        message: 'Could not understand the memory command.'
      }
    }

    const executors = {
      remember: () => this._executeRememberCommand(command),
      forget: () => this._executeForgetCommand(command),
      query: () => this._executeQueryCommand(command),
      update: () => this._executeUpdateCommand(command),
      list: () => this._executeListCommand(command),
      privacy: () => this._executePrivacyCommand(command),
      export: () => this._executeExportCommand(command)
    }

    const executor = executors[command.type]
    if (!executor) {
      return {
        success: false,
        error: 'Unknown command type',
        message: `Unknown command type: ${command.type}`
      }
    }

    try {
      const result = await executor()
      return {
        ...result,
        command: command.type,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: `Failed to execute ${command.type} command: ${error.message}`
      }
    }
  }

  /**
   * Execute remember command
   */
  _executeRememberCommand(command) {
    const { content, memoryType } = command.parsed

    if (!content) {
      return {
        success: false,
        message: 'Nothing to remember. Please specify what you want me to remember.'
      }
    }

    const memory = this.addLearnedItem(memoryType || 'fact', {
      content,
      source: 'natural_language_command',
      confidence: command.confidence
    })

    return {
      success: true,
      message: `I'll remember that: "${content}"`,
      memoryType: memoryType || 'fact',
      memoryId: memory?.id || null,
      requiresConfirmation: false
    }
  }

  /**
   * Execute forget command
   */
  _executeForgetCommand(command) {
    const { content } = command.parsed

    if (!content) {
      return {
        success: false,
        message: 'Nothing specified to forget. Please specify what to forget.'
      }
    }

    // Search for matching memories
    const matches = this._findMatchingMemories(content)

    if (matches.length === 0) {
      return {
        success: false,
        message: `I don't have any memories about "${content}".`
      }
    }

    // If multiple matches, require confirmation
    if (matches.length > 1) {
      return {
        success: false,
        requiresConfirmation: true,
        matches: matches.slice(0, 5),
        message: `I found ${matches.length} memories about "${content}". Which one should I forget?`,
        confirmationRequired: 'select_one'
      }
    }

    // Single match - mark for deletion but require confirmation
    return {
      success: true,
      requiresConfirmation: true,
      matches,
      message: `I'll forget: "${matches[0].content.substring(0, 100)}..."`,
      confirmationRequired: 'confirm_delete',
      pendingAction: {
        type: 'delete',
        memoryId: matches[0].id,
        memoryType: matches[0].type
      }
    }
  }

  /**
   * Execute query command
   */
  _executeQueryCommand(command) {
    const { content } = command.parsed

    if (!content) {
      return {
        success: true,
        message: 'What would you like me to recall?',
        results: []
      }
    }

    // Hybrid search for best results
    const results = this.hybridSearch(content, { limit: 10 })

    if (results.length === 0) {
      return {
        success: true,
        message: `I don't have any memories about "${content}".`,
        results: []
      }
    }

    return {
      success: true,
      message: `Here's what I remember about "${content}":`,
      results: results.map(r => ({
        content: r.content,
        type: r.type,
        score: r.score,
        timestamp: r.timestamp,
        source: r.source
      })),
      totalFound: results.length
    }
  }

  /**
   * Execute update command
   */
  _executeUpdateCommand(command) {
    const { content, target } = command.parsed

    if (!content || !target) {
      return {
        success: false,
        message: 'Please specify what to update and the new value.'
      }
    }

    // Find matching memories
    const matches = this._findMatchingMemories(content)

    if (matches.length === 0) {
      return {
        success: false,
        message: `I don't have any memories about "${content}" to update.`
      }
    }

    // Update the best match
    const toUpdate = matches[0]

    return {
      success: true,
      requiresConfirmation: true,
      message: `Update "${toUpdate.content.substring(0, 50)}..." to "${target}"?`,
      confirmationRequired: 'confirm_update',
      pendingAction: {
        type: 'update',
        memoryId: toUpdate.id,
        memoryType: toUpdate.type,
        oldContent: toUpdate.content,
        newContent: target
      }
    }
  }

  /**
   * Execute list command
   */
  _executeListCommand(command) {
    const { content } = command.parsed

    const learned = this.getLearnedMemories()
    const flattened = this._flattenLearnedMemories(learned)

    let results = flattened

    // Filter if topic specified
    if (content) {
      const lower = content.toLowerCase()
      results = flattened.filter(m =>
        m.content?.toLowerCase().includes(lower) ||
        m.type?.toLowerCase().includes(lower)
      )
    }

    // Group by type
    const grouped = {}
    for (const mem of results) {
      const type = mem.type || 'other'
      if (!grouped[type]) grouped[type] = []
      grouped[type].push(mem)
    }

    return {
      success: true,
      message: content
        ? `Here are your memories about "${content}":`
        : 'Here are all your memories:',
      results: grouped,
      totalCount: results.length,
      byType: Object.fromEntries(
        Object.entries(grouped).map(([k, v]) => [k, v.length])
      )
    }
  }

  /**
   * Execute privacy command
   */
  _executePrivacyCommand(command) {
    const { content, target } = command.parsed

    if (!content) {
      return {
        success: false,
        message: 'Please specify what to mark as private.'
      }
    }

    const sensitivityLevel = target?.toLowerCase() || 'private'
    const matches = this._findMatchingMemories(content)

    if (matches.length === 0) {
      return {
        success: false,
        message: `I don't have any memories about "${content}" to mark as private.`
      }
    }

    return {
      success: true,
      requiresConfirmation: true,
      message: `Mark ${matches.length} memorie(s) as ${sensitivityLevel}?`,
      confirmationRequired: 'confirm_privacy',
      pendingAction: {
        type: 'set_privacy',
        memories: matches.map(m => m.id),
        sensitivityLevel
      }
    }
  }

  /**
   * Execute export command
   */
  _executeExportCommand(command) {
    const exportData = this.exportAllMemories()

    return {
      success: true,
      message: 'Memory export ready.',
      data: exportData,
      stats: {
        totalMemories: exportData.statistics?.total || 0,
        exportedAt: new Date().toISOString()
      }
    }
  }

  /**
   * Find memories matching a query
   */
  _findMatchingMemories(query) {
    if (!query) return []

    const learned = this.getLearnedMemories()
    const flattened = this._flattenLearnedMemories(learned)

    const lower = query.toLowerCase()

    // Score and sort matches
    const scored = flattened
      .map(mem => ({
        ...mem,
        matchScore: this._calculateTextMatch(mem.content || '', lower)
      }))
      .filter(m => m.matchScore > 0.3)
      .sort((a, b) => b.matchScore - a.matchScore)

    return scored.slice(0, 10)
  }

  /**
   * Calculate text match score
   */
  _calculateTextMatch(text, query) {
    const textLower = text.toLowerCase()
    const queryWords = query.split(/\s+/)

    // Exact substring match
    if (textLower.includes(query)) {
      return 0.9
    }

    // Word overlap
    const textWords = new Set(textLower.split(/\s+/))
    const matchCount = queryWords.filter(w => textWords.has(w)).length

    return matchCount / queryWords.length
  }

  /**
   * Confirm and execute a pending memory action
   * @param {Object} pendingAction - Action from executeMemoryCommand
   * @param {boolean} confirmed - User confirmation
   * @returns {Object} Result
   */
  confirmMemoryAction(pendingAction, confirmed) {
    if (!confirmed) {
      return {
        success: false,
        cancelled: true,
        message: 'Action cancelled.'
      }
    }

    if (!pendingAction?.type) {
      return {
        success: false,
        error: 'No pending action'
      }
    }

    switch (pendingAction.type) {
      case 'delete':
        return this._confirmDelete(pendingAction)
      case 'update':
        return this._confirmUpdate(pendingAction)
      case 'set_privacy':
        return this._confirmPrivacy(pendingAction)
      default:
        return {
          success: false,
          error: `Unknown action type: ${pendingAction.type}`
        }
    }
  }

  /**
   * Confirm delete action
   */
  _confirmDelete(action) {
    const { memoryId, memoryType } = action

    // Remove from learned items
    const data = this._loadData()
    if (data.learned?.[memoryType + 's']) {
      data.learned[memoryType + 's'] = data.learned[memoryType + 's']
        .filter(m => m.id !== memoryId)
      this._saveData(data)
    }

    return {
      success: true,
      message: 'Memory deleted successfully.',
      deletedId: memoryId
    }
  }

  /**
   * Confirm update action
   */
  _confirmUpdate(action) {
    const { memoryId, memoryType, newContent } = action

    const data = this._loadData()
    const typeKey = memoryType + 's'

    if (data.learned?.[typeKey]) {
      const memory = data.learned[typeKey].find(m => m.id === memoryId)
      if (memory) {
        memory.content = newContent
        memory.updatedAt = new Date().toISOString()
        memory.updateSource = 'natural_language_command'
        this._saveData(data)

        return {
          success: true,
          message: 'Memory updated successfully.',
          updatedId: memoryId
        }
      }
    }

    return {
      success: false,
      error: 'Memory not found'
    }
  }

  /**
   * Confirm privacy action
   */
  _confirmPrivacy(action) {
    const { memories, sensitivityLevel } = action

    let updated = 0
    for (const memoryId of memories) {
      if (this.setSensitivityLevel(memoryId, sensitivityLevel)) {
        updated++
      }
    }

    return {
      success: true,
      message: `Marked ${updated} memorie(s) as ${sensitivityLevel}.`,
      updatedCount: updated
    }
  }

  /**
   * Format memory results for display
   * @param {Object} result - Result from executeMemoryCommand
   * @returns {string} Formatted string
   */
  formatMemoryResponse(result) {
    if (!result) return 'No response.'

    const lines = [result.message || '']

    if (result.results) {
      if (Array.isArray(result.results)) {
        // Query results
        for (const r of result.results.slice(0, 5)) {
          const type = r.type ? `[${r.type}] ` : ''
          lines.push(`  • ${type}${r.content?.substring(0, 80)}...`)
        }
        if (result.totalFound > 5) {
          lines.push(`  ... and ${result.totalFound - 5} more`)
        }
      } else {
        // Grouped results from list
        for (const [type, items] of Object.entries(result.results)) {
          lines.push(`\n${type.toUpperCase()} (${items.length}):`)
          for (const item of items.slice(0, 3)) {
            lines.push(`  • ${item.content?.substring(0, 60)}...`)
          }
          if (items.length > 3) {
            lines.push(`  ... and ${items.length - 3} more`)
          }
        }
      }
    }

    if (result.requiresConfirmation) {
      lines.push('\n[Confirmation required]')
    }

    return lines.join('\n')
  }

  // ---------------------------------------------------------------------------
  // 10.2 Memory Visualization Data
  // ---------------------------------------------------------------------------
  // Provides data structures for visualizing memory relationships

  /**
   * Get memory graph data for visualization
   * @param {Object} options - Graph options
   * @returns {Object} Graph data with nodes and edges
   */
  getMemoryGraphData(options = {}) {
    const {
      maxNodes = 100,
      includeTypes = ['fact', 'preference', 'decision', 'constraint', 'entity'],
      minConnections = 0
    } = options

    const nodes = []
    const edges = []
    const nodeMap = new Map()

    // Get all memories
    const learned = this.getLearnedMemories()
    const flattened = this._flattenLearnedMemories(learned)
    const entities = Object.values(this.getAllEntities())

    // Add memory nodes
    for (const mem of flattened.slice(0, maxNodes)) {
      if (!includeTypes.includes(mem.type)) continue

      const nodeId = mem.id || `mem_${nodes.length}`
      nodes.push({
        id: nodeId,
        type: 'memory',
        subtype: mem.type,
        label: mem.content?.substring(0, 30) || 'Memory',
        content: mem.content,
        timestamp: mem.timestamp,
        importance: mem.importance || 0.5,
        size: 10 + (mem.importance || 0.5) * 20
      })
      nodeMap.set(nodeId, nodes.length - 1)

      // Extract keywords for edge creation
      const keywords = this._extractKeywords(mem.content || '')
      mem._keywords = keywords
    }

    // Add entity nodes
    if (includeTypes.includes('entity')) {
      for (const entity of entities.slice(0, maxNodes - nodes.length)) {
        const nodeId = entity.id || `entity_${nodes.length}`
        nodes.push({
          id: nodeId,
          type: 'entity',
          subtype: entity.type,
          label: entity.name || entity.type,
          data: entity,
          size: 15
        })
        nodeMap.set(nodeId, nodes.length - 1)
      }
    }

    // Create edges based on keyword overlap
    const processedPairs = new Set()
    for (let i = 0; i < Math.min(nodes.length, flattened.length); i++) {
      const mem1 = flattened[i]
      if (!mem1._keywords) continue

      for (let j = i + 1; j < Math.min(nodes.length, flattened.length); j++) {
        const mem2 = flattened[j]
        if (!mem2._keywords) continue

        const pairKey = `${i}_${j}`
        if (processedPairs.has(pairKey)) continue
        processedPairs.add(pairKey)

        const overlap = this._calculateKeywordOverlap(mem1._keywords, mem2._keywords)
        if (overlap > 0.2) {
          edges.push({
            source: mem1.id || `mem_${i}`,
            target: mem2.id || `mem_${j}`,
            weight: overlap,
            type: 'keyword_similarity'
          })
        }
      }
    }

    // Add temporal edges (memories close in time)
    const sortedByTime = [...flattened]
      .filter(m => m.timestamp)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))

    for (let i = 0; i < sortedByTime.length - 1; i++) {
      const current = sortedByTime[i]
      const next = sortedByTime[i + 1]

      const timeDiff = new Date(next.timestamp) - new Date(current.timestamp)
      const hoursDiff = timeDiff / (1000 * 60 * 60)

      if (hoursDiff < 1) { // Within 1 hour
        edges.push({
          source: current.id,
          target: next.id,
          weight: 0.5,
          type: 'temporal'
        })
      }
    }

    // Filter nodes by minimum connections if specified
    if (minConnections > 0) {
      const connectionCount = new Map()
      for (const edge of edges) {
        connectionCount.set(edge.source, (connectionCount.get(edge.source) || 0) + 1)
        connectionCount.set(edge.target, (connectionCount.get(edge.target) || 0) + 1)
      }

      const filteredNodeIds = new Set(
        nodes
          .filter(n => (connectionCount.get(n.id) || 0) >= minConnections)
          .map(n => n.id)
      )

      return {
        nodes: nodes.filter(n => filteredNodeIds.has(n.id)),
        edges: edges.filter(e =>
          filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target)
        ),
        stats: {
          totalNodes: nodes.length,
          filteredNodes: filteredNodeIds.size,
          totalEdges: edges.length
        }
      }
    }

    return {
      nodes,
      edges,
      stats: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        avgConnections: edges.length * 2 / nodes.length || 0
      }
    }
  }

  /**
   * Extract keywords from text
   */
  _extractKeywords(text) {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'shall', 'can', 'of', 'in', 'to',
      'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
      'that', 'this', 'it', 'and', 'or', 'but', 'if', 'then', 'than'
    ])

    return text
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
  }

  /**
   * Calculate keyword overlap between two sets
   */
  _calculateKeywordOverlap(keywords1, keywords2) {
    const set1 = new Set(keywords1)
    const set2 = new Set(keywords2)

    const intersection = [...set1].filter(k => set2.has(k))
    const union = new Set([...set1, ...set2])

    return intersection.length / union.size
  }

  /**
   * Get memory timeline data for visualization
   * @param {Object} options - Timeline options
   * @returns {Object} Timeline data
   */
  getMemoryTimelineData(options = {}) {
    const {
      startDate = null,
      endDate = null,
      groupBy = 'day', // 'hour', 'day', 'week', 'month'
      includeTypes = null
    } = options

    const learned = this.getLearnedMemories()
    const flattened = this._flattenLearnedMemories(learned)

    // Filter by date range
    let filtered = flattened.filter(m => m.timestamp)

    if (startDate) {
      const start = new Date(startDate)
      filtered = filtered.filter(m => new Date(m.timestamp) >= start)
    }

    if (endDate) {
      const end = new Date(endDate)
      filtered = filtered.filter(m => new Date(m.timestamp) <= end)
    }

    if (includeTypes) {
      filtered = filtered.filter(m => includeTypes.includes(m.type))
    }

    // Group by time period
    const groups = new Map()
    for (const mem of filtered) {
      const date = new Date(mem.timestamp)
      const key = this._getTimeGroupKey(date, groupBy)

      if (!groups.has(key)) {
        groups.set(key, {
          period: key,
          date: this._getGroupStartDate(date, groupBy),
          memories: [],
          byType: {}
        })
      }

      const group = groups.get(key)
      group.memories.push(mem)

      const type = mem.type || 'other'
      group.byType[type] = (group.byType[type] || 0) + 1
    }

    // Sort by date
    const timeline = [...groups.values()]
      .sort((a, b) => new Date(a.date) - new Date(b.date))

    // Calculate statistics
    const totalMemories = filtered.length
    const avgPerPeriod = totalMemories / Math.max(timeline.length, 1)

    // Find peak period
    let peakPeriod = null
    let peakCount = 0
    for (const group of timeline) {
      if (group.memories.length > peakCount) {
        peakCount = group.memories.length
        peakPeriod = group.period
      }
    }

    return {
      timeline: timeline.map(g => ({
        period: g.period,
        date: g.date,
        count: g.memories.length,
        byType: g.byType
      })),
      stats: {
        total: totalMemories,
        periods: timeline.length,
        avgPerPeriod: Math.round(avgPerPeriod * 10) / 10,
        peakPeriod,
        peakCount
      },
      groupBy
    }
  }

  /**
   * Get time group key
   */
  _getTimeGroupKey(date, groupBy) {
    switch (groupBy) {
      case 'hour':
        return `${date.toISOString().split('T')[0]}_${date.getHours()}`
      case 'day':
        return date.toISOString().split('T')[0]
      case 'week':
        const weekStart = new Date(date)
        weekStart.setDate(date.getDate() - date.getDay())
        return `week_${weekStart.toISOString().split('T')[0]}`
      case 'month':
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      default:
        return date.toISOString().split('T')[0]
    }
  }

  /**
   * Get group start date
   */
  _getGroupStartDate(date, groupBy) {
    const d = new Date(date)
    switch (groupBy) {
      case 'hour':
        d.setMinutes(0, 0, 0)
        return d.toISOString()
      case 'day':
        d.setHours(0, 0, 0, 0)
        return d.toISOString()
      case 'week':
        d.setDate(d.getDate() - d.getDay())
        d.setHours(0, 0, 0, 0)
        return d.toISOString()
      case 'month':
        d.setDate(1)
        d.setHours(0, 0, 0, 0)
        return d.toISOString()
      default:
        return d.toISOString()
    }
  }

  /**
   * Get memory category breakdown for pie/donut charts
   * @returns {Object} Category breakdown
   */
  getMemoryCategoryBreakdown() {
    const learned = this.getLearnedMemories()
    const entities = Object.values(this.getAllEntities())

    const breakdown = {
      byType: {},
      bySource: {},
      byImportance: { low: 0, medium: 0, high: 0 },
      byAge: { recent: 0, week: 0, month: 0, older: 0 }
    }

    const now = new Date()
    const oneWeek = 7 * 24 * 60 * 60 * 1000
    const oneMonth = 30 * 24 * 60 * 60 * 1000
    const oneDay = 24 * 60 * 60 * 1000

    // Process learned memories
    for (const [type, items] of Object.entries(learned)) {
      if (!Array.isArray(items)) continue

      breakdown.byType[type] = items.length

      for (const item of items) {
        // By source
        const source = item.source || 'unknown'
        breakdown.bySource[source] = (breakdown.bySource[source] || 0) + 1

        // By importance
        const imp = item.importance || 0.5
        if (imp >= 0.7) breakdown.byImportance.high++
        else if (imp >= 0.4) breakdown.byImportance.medium++
        else breakdown.byImportance.low++

        // By age
        if (item.timestamp) {
          const age = now - new Date(item.timestamp)
          if (age < oneDay) breakdown.byAge.recent++
          else if (age < oneWeek) breakdown.byAge.week++
          else if (age < oneMonth) breakdown.byAge.month++
          else breakdown.byAge.older++
        }
      }
    }

    // Add entities
    breakdown.byType.entities = entities.length

    // Calculate totals
    const total = Object.values(breakdown.byType).reduce((a, b) => a + b, 0)

    return {
      ...breakdown,
      total,
      percentages: {
        byType: Object.fromEntries(
          Object.entries(breakdown.byType).map(([k, v]) => [k, Math.round(v / total * 100)])
        ),
        byImportance: {
          high: Math.round(breakdown.byImportance.high / total * 100),
          medium: Math.round(breakdown.byImportance.medium / total * 100),
          low: Math.round(breakdown.byImportance.low / total * 100)
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 10.3 Privacy Controls & Sensitivity
  // ---------------------------------------------------------------------------
  // Manages memory privacy, sensitivity levels, and data protection

  /**
   * Sensitivity levels and their properties
   */
  static SENSITIVITY_LEVELS = {
    public: { level: 0, expires: null, anonymize: false },
    normal: { level: 1, expires: null, anonymize: false },
    private: { level: 2, expires: 90 * 24 * 60 * 60 * 1000, anonymize: false }, // 90 days
    sensitive: { level: 3, expires: 30 * 24 * 60 * 60 * 1000, anonymize: true }, // 30 days
    confidential: { level: 4, expires: 7 * 24 * 60 * 60 * 1000, anonymize: true } // 7 days
  }

  /**
   * Patterns for detecting sensitive content
   */
  static SENSITIVE_PATTERNS = [
    // Personal identification
    { pattern: /\b\d{3}-\d{2}-\d{4}\b/, type: 'ssn', level: 'confidential' },
    { pattern: /\b\d{9}\b/, type: 'potential_ssn', level: 'sensitive' },

    // Financial
    { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, type: 'credit_card', level: 'confidential' },
    { pattern: /\b(?:visa|mastercard|amex|credit\s*card)\b/i, type: 'financial', level: 'sensitive' },

    // Authentication
    { pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/i, type: 'password', level: 'confidential' },
    { pattern: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*\S+/i, type: 'api_key', level: 'confidential' },
    { pattern: /\b[a-f0-9]{32,}\b/i, type: 'potential_hash', level: 'sensitive' },

    // Personal data
    { pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/, type: 'email', level: 'private' },
    { pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/, type: 'phone', level: 'private' },

    // Medical/Health
    { pattern: /\b(?:diagnosis|medical|prescription|medication|therapy|treatment)\b/i, type: 'medical', level: 'sensitive' },

    // Legal/Sensitive topics
    { pattern: /\b(?:lawsuit|attorney|legal\s*action|confidential)\b/i, type: 'legal', level: 'sensitive' }
  ]

  /**
   * Detect sensitive content in text
   * @param {string} text - Text to analyze
   * @returns {Object} Detection result
   */
  detectSensitiveContent(text) {
    if (!text || typeof text !== 'string') {
      return { isSensitive: false, detections: [], recommendedLevel: 'normal' }
    }

    const detections = []
    let highestLevel = 'normal'
    const levelOrder = ['public', 'normal', 'private', 'sensitive', 'confidential']

    for (const { pattern, type, level } of MemoryManager.SENSITIVE_PATTERNS) {
      const matches = text.match(new RegExp(pattern, 'gi'))
      if (matches) {
        detections.push({
          type,
          level,
          count: matches.length,
          positions: this._findPatternPositions(text, pattern)
        })

        if (levelOrder.indexOf(level) > levelOrder.indexOf(highestLevel)) {
          highestLevel = level
        }
      }
    }

    return {
      isSensitive: detections.length > 0,
      detections,
      recommendedLevel: highestLevel,
      confidence: detections.length > 0 ? Math.min(0.5 + detections.length * 0.1, 1) : 0
    }
  }

  /**
   * Find positions of pattern matches
   */
  _findPatternPositions(text, pattern) {
    const positions = []
    const regex = new RegExp(pattern, 'gi')
    let match

    while ((match = regex.exec(text)) !== null) {
      positions.push({
        start: match.index,
        end: match.index + match[0].length,
        masked: '*'.repeat(match[0].length)
      })
    }

    return positions
  }

  /**
   * Set sensitivity level for a memory
   * @param {string} memoryId - Memory ID
   * @param {string} level - Sensitivity level
   * @returns {boolean} Success
   */
  setSensitivityLevel(memoryId, level) {
    if (!memoryId || !MemoryManager.SENSITIVITY_LEVELS[level]) {
      return false
    }

    const data = this._loadData()

    // Initialize privacy data
    if (!data.privacy) {
      data.privacy = { levels: {}, expirations: {}, anonymized: {} }
    }

    data.privacy.levels[memoryId] = level

    // Set expiration if applicable
    const levelConfig = MemoryManager.SENSITIVITY_LEVELS[level]
    if (levelConfig.expires) {
      data.privacy.expirations[memoryId] = Date.now() + levelConfig.expires
    } else {
      delete data.privacy.expirations[memoryId]
    }

    this._saveData(data)
    return true
  }

  /**
   * Get sensitivity level for a memory
   * @param {string} memoryId - Memory ID
   * @returns {string} Sensitivity level
   */
  getSensitivityLevel(memoryId) {
    const data = this._loadData()
    return data.privacy?.levels?.[memoryId] || 'normal'
  }

  /**
   * Auto-expire memories based on sensitivity
   * @returns {Object} Expiration result
   */
  autoExpireMemories() {
    const data = this._loadData()
    const now = Date.now()
    const expired = []
    const expiring = []

    if (!data.privacy?.expirations) {
      return { expired: [], expiring: [], checked: 0 }
    }

    for (const [memoryId, expirationTime] of Object.entries(data.privacy.expirations)) {
      const timeLeft = expirationTime - now

      if (timeLeft <= 0) {
        // Memory has expired - mark for deletion
        expired.push({
          memoryId,
          expiredAt: new Date(expirationTime).toISOString()
        })

        // Remove from all learned categories
        for (const type of Object.keys(data.learned || {})) {
          if (Array.isArray(data.learned[type])) {
            data.learned[type] = data.learned[type].filter(m => m.id !== memoryId)
          }
        }

        // Clean up privacy data
        delete data.privacy.levels[memoryId]
        delete data.privacy.expirations[memoryId]
      } else if (timeLeft < 24 * 60 * 60 * 1000) {
        // Expiring within 24 hours
        expiring.push({
          memoryId,
          expiresAt: new Date(expirationTime).toISOString(),
          hoursLeft: Math.round(timeLeft / (60 * 60 * 1000))
        })
      }
    }

    if (expired.length > 0) {
      this._saveData(data)
    }

    return {
      expired,
      expiring,
      checked: Object.keys(data.privacy.expirations).length
    }
  }

  /**
   * Anonymize a memory by masking sensitive content
   * @param {string} memoryId - Memory ID
   * @returns {Object} Result
   */
  anonymizeMemory(memoryId) {
    const data = this._loadData()

    // Find the memory
    let memory = null
    let typeKey = null

    for (const [type, items] of Object.entries(data.learned || {})) {
      if (Array.isArray(items)) {
        const found = items.find(m => m.id === memoryId)
        if (found) {
          memory = found
          typeKey = type
          break
        }
      }
    }

    if (!memory) {
      return { success: false, error: 'Memory not found' }
    }

    // Detect and mask sensitive content
    const detection = this.detectSensitiveContent(memory.content || '')

    if (!detection.isSensitive) {
      return {
        success: true,
        message: 'No sensitive content detected',
        modified: false
      }
    }

    // Create anonymized version
    let anonymized = memory.content
    for (const det of detection.detections) {
      for (const pos of det.positions) {
        anonymized = anonymized.slice(0, pos.start) + pos.masked + anonymized.slice(pos.end)
      }
    }

    // Update memory
    memory.content = anonymized
    memory.anonymized = true
    memory.anonymizedAt = new Date().toISOString()
    memory.originalHash = this._hashContent(memory.content)

    // Track anonymization
    if (!data.privacy) data.privacy = {}
    if (!data.privacy.anonymized) data.privacy.anonymized = {}
    data.privacy.anonymized[memoryId] = {
      types: detection.detections.map(d => d.type),
      anonymizedAt: new Date().toISOString()
    }

    this._saveData(data)

    return {
      success: true,
      modified: true,
      maskedTypes: detection.detections.map(d => d.type),
      message: `Masked ${detection.detections.length} sensitive element(s)`
    }
  }

  /**
   * Simple content hash
   */
  _hashContent(content) {
    let hash = 0
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return hash.toString(16)
  }

  /**
   * Get privacy summary
   * @returns {Object} Privacy statistics
   */
  getPrivacySummary() {
    const data = this._loadData()
    const learned = this.getLearnedMemories()
    const flattened = this._flattenLearnedMemories(learned)

    const levelCounts = {}
    for (const level of Object.keys(MemoryManager.SENSITIVITY_LEVELS)) {
      levelCounts[level] = 0
    }

    // Count by level
    for (const mem of flattened) {
      const level = data.privacy?.levels?.[mem.id] || 'normal'
      levelCounts[level]++
    }

    // Count expiring
    const expirationEntries = Object.entries(data.privacy?.expirations || {})
    const now = Date.now()
    const expiringCount = expirationEntries.filter(([_, exp]) =>
      exp - now < 7 * 24 * 60 * 60 * 1000 && exp > now
    ).length

    return {
      byLevel: levelCounts,
      total: flattened.length,
      withExpiration: expirationEntries.length,
      expiringWithinWeek: expiringCount,
      anonymized: Object.keys(data.privacy?.anonymized || {}).length
    }
  }

  // ---------------------------------------------------------------------------
  // 10.4 Memory Export/Import/Backup
  // ---------------------------------------------------------------------------
  // Comprehensive backup and restore functionality

  /**
   * Export all memories in a portable format
   * @param {Object} options - Export options
   * @returns {Object} Exportable data
   */
  exportAllMemories(options = {}) {
    const {
      includePrivacy = true,
      includeSensitive = false,
      format = 'json'
    } = options

    const data = this._loadData()
    const exportData = {
      version: '2.0',
      exportedAt: new Date().toISOString(),
      system: 'Quox Memory System',
      profile: data.profile || {},
      learned: {},
      entities: data.entities || {},
      sessions: data.sessions || {},
      syntheses: data.syntheses || {},
      narratives: data.narratives || {},
      trends: data.trends || {}
    }

    // Process learned memories
    for (const [type, items] of Object.entries(data.learned || {})) {
      if (!Array.isArray(items)) continue

      exportData.learned[type] = items
        .filter(item => {
          if (!includeSensitive) {
            const level = data.privacy?.levels?.[item.id] || 'normal'
            const levelNum = MemoryManager.SENSITIVITY_LEVELS[level]?.level || 1
            return levelNum < 3 // Exclude sensitive and confidential
          }
          return true
        })
        .map(item => ({
          ...item,
          _sensitivity: includePrivacy
            ? (data.privacy?.levels?.[item.id] || 'normal')
            : undefined
        }))
    }

    // Add statistics
    const flattened = this._flattenLearnedMemories(exportData.learned)
    exportData.statistics = {
      total: flattened.length,
      byType: Object.fromEntries(
        Object.entries(exportData.learned).map(([k, v]) => [k, v.length])
      ),
      entityCount: Object.keys(exportData.entities).length,
      sessionCount: Object.keys(exportData.sessions).length
    }

    return exportData
  }

  /**
   * Import memories from export
   * @param {Object} importData - Data to import
   * @param {Object} options - Import options
   * @returns {Object} Import result
   */
  importMemories(importData, options = {}) {
    const {
      merge = true, // Merge with existing or replace
      skipDuplicates = true,
      preserveIds = false
    } = options

    if (!importData || importData.system !== 'Quox Memory System') {
      return {
        success: false,
        error: 'Invalid import data format'
      }
    }

    const data = merge ? this._loadData() : {
      profile: {},
      learned: {},
      entities: {},
      sessions: {}
    }

    const stats = {
      imported: 0,
      skipped: 0,
      merged: 0,
      errors: []
    }

    // Import profile (merge or replace)
    if (importData.profile) {
      if (merge) {
        data.profile = { ...data.profile, ...importData.profile }
        stats.merged++
      } else {
        data.profile = importData.profile
      }
    }

    // Import learned memories
    for (const [type, items] of Object.entries(importData.learned || {})) {
      if (!Array.isArray(items)) continue

      if (!data.learned[type]) {
        data.learned[type] = []
      }

      for (const item of items) {
        // Generate new ID if not preserving
        const newItem = {
          ...item,
          id: preserveIds ? item.id : `imported_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          importedAt: new Date().toISOString()
        }

        // Check for duplicates
        if (skipDuplicates) {
          const isDuplicate = data.learned[type].some(existing =>
            existing.content === newItem.content
          )
          if (isDuplicate) {
            stats.skipped++
            continue
          }
        }

        data.learned[type].push(newItem)
        stats.imported++
      }
    }

    // Import entities
    if (importData.entities) {
      for (const [id, entity] of Object.entries(importData.entities)) {
        const entityId = preserveIds ? id : `imported_${id}`
        if (!data.entities[entityId] || !skipDuplicates) {
          data.entities[entityId] = { ...entity, importedAt: new Date().toISOString() }
          stats.imported++
        } else {
          stats.skipped++
        }
      }
    }

    // Import privacy levels if present
    if (importData.learned) {
      if (!data.privacy) data.privacy = { levels: {}, expirations: {} }

      for (const items of Object.values(importData.learned)) {
        if (!Array.isArray(items)) continue
        for (const item of items) {
          if (item._sensitivity && item._sensitivity !== 'normal') {
            data.privacy.levels[item.id] = item._sensitivity
          }
        }
      }
    }

    this._saveData(data)

    return {
      success: true,
      stats,
      message: `Imported ${stats.imported} items, skipped ${stats.skipped} duplicates`
    }
  }

  /**
   * Create a timestamped backup
   * @returns {Object} Backup result
   */
  createBackup() {
    const exportData = this.exportAllMemories({ includeSensitive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

    const data = this._loadData()
    if (!data.backups) data.backups = []

    const backup = {
      id: `backup_${timestamp}`,
      createdAt: new Date().toISOString(),
      statistics: exportData.statistics,
      checksum: this._calculateChecksum(exportData),
      data: exportData
    }

    data.backups.push(backup)

    // Keep only last 5 backups
    if (data.backups.length > 5) {
      data.backups = data.backups.slice(-5)
    }

    this._saveData(data)

    return {
      success: true,
      backupId: backup.id,
      createdAt: backup.createdAt,
      stats: backup.statistics
    }
  }

  /**
   * List available backups
   * @returns {Array} Backup list
   */
  listBackups() {
    const data = this._loadData()
    return (data.backups || []).map(b => ({
      id: b.id,
      createdAt: b.createdAt,
      statistics: b.statistics
    }))
  }

  /**
   * Restore from a backup
   * @param {string} backupId - Backup ID
   * @returns {Object} Restore result
   */
  restoreFromBackup(backupId) {
    const data = this._loadData()
    const backup = data.backups?.find(b => b.id === backupId)

    if (!backup) {
      return {
        success: false,
        error: 'Backup not found'
      }
    }

    // Verify checksum
    const currentChecksum = this._calculateChecksum(backup.data)
    if (currentChecksum !== backup.checksum) {
      return {
        success: false,
        error: 'Backup data integrity check failed'
      }
    }

    // Import backup data
    const result = this.importMemories(backup.data, {
      merge: false,
      preserveIds: true
    })

    return {
      success: true,
      restoredFrom: backup.createdAt,
      stats: result.stats
    }
  }

  /**
   * Calculate simple checksum for data integrity
   */
  _calculateChecksum(data) {
    const str = JSON.stringify(data)
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(16)
  }

  // ---------------------------------------------------------------------------
  // 10.5 Memory Health Dashboard Data
  // ---------------------------------------------------------------------------
  // Provides metrics for monitoring memory system health

  /**
   * Get comprehensive dashboard metrics
   * @returns {Object} Dashboard metrics
   */
  getDashboardMetrics() {
    const data = this._loadData()
    const learned = this.getLearnedMemories()
    const flattened = this._flattenLearnedMemories(learned)
    const entities = Object.values(this.getAllEntities())

    // Time-based metrics
    const now = new Date()
    const oneDay = 24 * 60 * 60 * 1000
    const oneWeek = 7 * oneDay

    const todayMemories = flattened.filter(m =>
      m.timestamp && (now - new Date(m.timestamp)) < oneDay
    ).length

    const weekMemories = flattened.filter(m =>
      m.timestamp && (now - new Date(m.timestamp)) < oneWeek
    ).length

    // Quality metrics
    const withContent = flattened.filter(m => m.content?.length > 10).length
    const withTimestamp = flattened.filter(m => m.timestamp).length
    const withImportance = flattened.filter(m => typeof m.importance === 'number').length

    // Activity metrics
    const sessions = Object.values(data.sessions || {})
    const recentSessions = sessions.filter(s =>
      s.endTime && (now - new Date(s.endTime)) < oneWeek
    )

    return {
      summary: {
        totalMemories: flattened.length,
        totalEntities: entities.length,
        totalSessions: sessions.length
      },
      activity: {
        memoriesAddedToday: todayMemories,
        memoriesAddedThisWeek: weekMemories,
        avgMemoriesPerDay: Math.round(weekMemories / 7 * 10) / 10,
        recentSessionCount: recentSessions.length
      },
      quality: {
        withContent: withContent,
        withTimestamp: withTimestamp,
        withImportance: withImportance,
        completenessScore: Math.round(
          ((withContent + withTimestamp + withImportance) / (flattened.length * 3 || 1)) * 100
        )
      },
      health: this.getMemoryHealthScore(),
      growth: this.getMemoryGrowthRate(),
      lastUpdated: new Date().toISOString()
    }
  }

  /**
   * Calculate memory health score (0-100)
   * @returns {Object} Health score and factors
   */
  getMemoryHealthScore() {
    const data = this._loadData()
    const learned = this.getLearnedMemories()
    const flattened = this._flattenLearnedMemories(learned)

    const factors = {
      diversity: 0,
      freshness: 0,
      completeness: 0,
      organization: 0,
      utilization: 0
    }

    if (flattened.length === 0) {
      return { score: 0, factors, status: 'empty' }
    }

    // Diversity: variety of memory types
    const typeCount = Object.keys(learned).filter(k =>
      Array.isArray(learned[k]) && learned[k].length > 0
    ).length
    factors.diversity = Math.min(typeCount / 5, 1) * 100

    // Freshness: ratio of recent memories
    const now = new Date()
    const oneMonth = 30 * 24 * 60 * 60 * 1000
    const recentCount = flattened.filter(m =>
      m.timestamp && (now - new Date(m.timestamp)) < oneMonth
    ).length
    factors.freshness = (recentCount / flattened.length) * 100

    // Completeness: memories with all fields
    const completeCount = flattened.filter(m =>
      m.content && m.timestamp && typeof m.importance === 'number'
    ).length
    factors.completeness = (completeCount / flattened.length) * 100

    // Organization: presence of syntheses and narratives
    const hasSyntheses = Object.keys(data.syntheses || {}).length > 0
    const hasNarratives = Object.keys(data.narratives || {}).length > 0
    factors.organization = (hasSyntheses ? 50 : 0) + (hasNarratives ? 50 : 0)

    // Utilization: memories that have been accessed
    const evolutionData = this.getImportanceEvolutionData()
    const accessedCount = Object.values(evolutionData.history || {})
      .filter(h => h.accessCount > 0).length
    factors.utilization = flattened.length > 0
      ? (accessedCount / flattened.length) * 100
      : 0

    // Calculate weighted score
    const weights = {
      diversity: 0.2,
      freshness: 0.2,
      completeness: 0.25,
      organization: 0.15,
      utilization: 0.2
    }

    const score = Math.round(
      Object.entries(factors).reduce((sum, [key, value]) =>
        sum + value * weights[key], 0
      )
    )

    // Determine status
    let status = 'critical'
    if (score >= 80) status = 'excellent'
    else if (score >= 60) status = 'good'
    else if (score >= 40) status = 'fair'
    else if (score >= 20) status = 'poor'

    return {
      score,
      factors: Object.fromEntries(
        Object.entries(factors).map(([k, v]) => [k, Math.round(v)])
      ),
      status,
      recommendations: this._generateHealthRecommendations(factors)
    }
  }

  /**
   * Generate health recommendations
   */
  _generateHealthRecommendations(factors) {
    const recommendations = []

    if (factors.diversity < 50) {
      recommendations.push({
        area: 'diversity',
        message: 'Try recording different types of memories (preferences, decisions, constraints)',
        priority: 'medium'
      })
    }

    if (factors.freshness < 30) {
      recommendations.push({
        area: 'freshness',
        message: 'Most memories are older. Consider adding recent learnings.',
        priority: 'low'
      })
    }

    if (factors.completeness < 50) {
      recommendations.push({
        area: 'completeness',
        message: 'Many memories lack importance scores or timestamps',
        priority: 'medium'
      })
    }

    if (factors.organization < 50) {
      recommendations.push({
        area: 'organization',
        message: 'Run synthesis and narrative generation to better organize memories',
        priority: 'high'
      })
    }

    if (factors.utilization < 30) {
      recommendations.push({
        area: 'utilization',
        message: 'Many memories are never accessed. Consider reviewing or archiving unused ones.',
        priority: 'low'
      })
    }

    return recommendations
  }

  /**
   * Calculate memory growth rate
   * @returns {Object} Growth statistics
   */
  getMemoryGrowthRate() {
    const learned = this.getLearnedMemories()
    const flattened = this._flattenLearnedMemories(learned)
      .filter(m => m.timestamp)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))

    if (flattened.length < 2) {
      return {
        rate: 0,
        trend: 'stable',
        periodStats: {}
      }
    }

    // Calculate weekly stats
    const now = new Date()
    const weeks = {}

    for (const mem of flattened) {
      const date = new Date(mem.timestamp)
      const weeksAgo = Math.floor((now - date) / (7 * 24 * 60 * 60 * 1000))
      const weekKey = `week_${weeksAgo}`

      if (weeksAgo <= 4) { // Last 4 weeks
        weeks[weekKey] = (weeks[weekKey] || 0) + 1
      }
    }

    // Calculate growth rate
    const thisWeek = weeks['week_0'] || 0
    const lastWeek = weeks['week_1'] || 0

    let rate = 0
    let trend = 'stable'

    if (lastWeek > 0) {
      rate = Math.round(((thisWeek - lastWeek) / lastWeek) * 100)
      if (rate > 10) trend = 'growing'
      else if (rate < -10) trend = 'declining'
    } else if (thisWeek > 0) {
      trend = 'growing'
      rate = 100
    }

    // Calculate average
    const weekCounts = Object.values(weeks)
    const avgPerWeek = weekCounts.length > 0
      ? Math.round(weekCounts.reduce((a, b) => a + b, 0) / weekCounts.length)
      : 0

    return {
      rate,
      trend,
      thisWeek,
      lastWeek,
      avgPerWeek,
      periodStats: weeks,
      totalTracked: flattened.length
    }
  }

  /**
   * Get memory system overview for quick display
   * @returns {Object} Quick overview
   */
  getQuickOverview() {
    const metrics = this.getDashboardMetrics()
    const health = metrics.health

    return {
      memories: metrics.summary.totalMemories,
      entities: metrics.summary.totalEntities,
      healthScore: health.score,
      healthStatus: health.status,
      addedToday: metrics.activity.memoriesAddedToday,
      trend: metrics.growth.trend
    }
  }
}

// Singleton instance
let memoryManagerInstance = null

export function getMemoryManager() {
  if (!memoryManagerInstance) {
    memoryManagerInstance = new MemoryManager()
  }
  return memoryManagerInstance
}

/**
 * Trigger migration from localStorage to server-side memory
 * Should be called once on app initialization
 * Phase 5 of Memory Overhaul (#153)
 */
export async function migrateToServerMemory() {
  try {
    const result = await memoryClient.migrate()
    if (result.migrated) {
      console.log('[Memory] Migration completed:', result)
    } else if (result.skipped) {
      console.log('[Memory] Migration already completed')
    } else {
      console.warn('[Memory] Migration deferred:', result.reason)
    }
    return result
  } catch (err) {
    console.error('[Memory] Migration failed:', err)
    return { migrated: false, error: err.message }
  }
}

/**
 * Get server-side memory statistics
 * Phase 5 of Memory Overhaul (#153)
 */
export async function getServerMemoryStats() {
  return memoryClient.getStats()
}

/**
 * Check if memory service is available
 */
export async function isMemoryServiceAvailable() {
  return memoryClient.checkHealth()
}

/**
 * Reset the memory manager singleton (for testing)
 */
export function resetMemoryManager() {
  if (memoryManagerInstance) {
    // Clear localStorage to reset persistent state
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('quox_profile')
      localStorage.removeItem('quox_preferences')
      localStorage.removeItem('quox_episodic')
      localStorage.removeItem('quox_semantic')
      localStorage.removeItem('quox_candidates')
      localStorage.removeItem('quox_entities')
      localStorage.removeItem('quox_runbooks')
      localStorage.removeItem('quox_contexts')
      // Clear all learned_ items
      const keysToRemove = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith('quox_learned_')) {
          keysToRemove.push(key)
        }
      }
      keysToRemove.forEach(key => localStorage.removeItem(key))
    }
  }
  memoryManagerInstance = null
}

// Export provenance/confidence utilities for external use
export {
  TRUTH_PRIORITY,
  STABILITY_LEVELS,
  TYPE_STABILITY,
  CONFIDENCE_DECAY,
  createProvenance,
  createConfidence,
  createConflicts,
  calculateDecayedConfidence,
  inferProvenanceSource
}

// Helper to format context for Claude
export function formatContextForPrompt(context) {
  const parts = []

  if (context.profile?.name) {
    parts.push(`User: ${context.profile.name}`)
  }

  if (context.profile?.preferences) {
    const prefs = context.profile.preferences
    if (prefs.verbosity) parts.push(`Verbosity: ${prefs.verbosity}`)
  }

  // Include learned preferences (important for personalization)
  if (context.learned?.preferences?.length > 0) {
    parts.push('\nUser preferences:')
    for (const pref of context.learned.preferences.slice(0, 5)) {
      parts.push(`- ${pref.content?.substring(0, 100)}`)
    }
  }

  // Include constraints (critical - should never be ignored)
  if (context.learned?.constraints?.length > 0) {
    parts.push('\nConstraints (respect these):')
    for (const c of context.learned.constraints.slice(0, 5)) {
      parts.push(`- ${c.content?.substring(0, 100)}`)
    }
  }

  // Include relevant facts
  if (context.learned?.facts?.length > 0) {
    parts.push('\nKnown facts:')
    for (const fact of context.learned.facts.slice(0, 5)) {
      parts.push(`- ${fact.content?.substring(0, 100)}`)
    }
  }

  // Include recent decisions for context continuity
  if (context.learned?.decisions?.length > 0) {
    parts.push('\nRecent decisions:')
    for (const dec of context.learned.decisions.slice(0, 3)) {
      parts.push(`- ${dec.content?.substring(0, 100)}`)
    }
  }

  // Include past errors and fixes (helps avoid repeating mistakes)
  if (context.learned?.errors?.length > 0) {
    parts.push('\nPast issues and fixes:')
    for (const err of context.learned.errors.slice(0, 3)) {
      parts.push(`- ${err.content?.substring(0, 150)}`)
    }
  }

  // Include relevant reflections (self-improvement insights)
  if (context.reflections?.length > 0) {
    parts.push('\nSelf-improvement insights:')
    for (const ref of context.reflections.slice(0, 3)) {
      const category = ref.category ? `[${ref.category}] ` : ''
      parts.push(`- ${category}${ref.content?.substring(0, 120)}`)
    }
  }

  if (context.recentEvents?.length > 0) {
    parts.push('\nRecent activity:')
    for (const event of context.recentEvents.slice(-3)) {
      const time = new Date(event.timestamp).toLocaleTimeString()
      parts.push(`- [${time}] ${event.query?.substring(0, 50)}...`)
    }
  }

  if (context.projects?.length > 0) {
    parts.push('\nRelevant projects:')
    for (const proj of context.projects) {
      parts.push(`- ${proj.name}: ${proj.description || 'No description'}`)
    }
  }

  if (context.pendingCandidates?.length > 0) {
    parts.push('\nPending observations:')
    for (const c of context.pendingCandidates) {
      parts.push(`- [${c.type}] ${c.content?.substring(0, 100)}`)
    }
  }

  // Include hybrid search results (best retrieval)
  if (context.hybridResults?.length > 0) {
    parts.push('\nRelevant memories (hybrid search):')
    for (const match of context.hybridResults.slice(0, 5)) {
      const typeTag = match.type ? `[${match.type}] ` : ''
      parts.push(`- ${typeTag}${match.content?.substring(0, 120)}`)
    }
  }

  // Include semantic matches if available (fallback)
  if (context.semanticMatches?.length > 0 && !context.hybridResults?.length) {
    parts.push('\nRelated context (semantic):')
    for (const match of context.semanticMatches.slice(0, 3)) {
      parts.push(`- ${match.content?.substring(0, 100)}`)
    }
  }

  return parts.join('\n')
}

export default MemoryManager
