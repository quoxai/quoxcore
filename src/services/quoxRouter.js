/**
 * Quox Smart Router
 *
 * Confidence-based router that handles common Quox operations WITHOUT calling the LLM.
 * Uses cascading evaluation with confidence scoring across multiple layers:
 *
 * Architecture:
 * User Query -> Layer 1: Regex Classifier -> [Confidence Check]
 *               |                            |-- HIGH (>0.9)    -> Execute Handler
 *               |                            |-- MEDIUM/LOW     -> Try Layer 2
 *               |
 *               +-> Layer 2: Semantic Classifier (embeddings)
 *                                            |-- Merge results from both layers
 *                                            |-- Pick best match
 *                                            |-- HIGH confidence  -> Execute Handler
 *                                            |-- MEDIUM + Ambiguous -> Clarifying Question
 *                                            |-- LOW confidence   -> Pass to Claude
 *
 * Each response includes "Ask Claude" button for user escalation.
 */

import { getAgents, getFleetSummary, installQuoxAgent, checkQuoxAgentStatus } from './quoxagentClient.js'
import { getFleetStatus, QUOX_IDENTITY, QUOXAGENT_DOCUMENTATION } from './quoxContext.js'
import { getAllHostIds, hostRegistry, resolveHostname, getHosts, getHostsWithPing, getGroups, isBastionAvailable } from '../config/hosts.js'
import * as bastionClient from './bastionClient.js'
import { assistants, getAssistant } from '../config/assistants.js'
import { getBuiltInTeams, getBuiltInTeam, getTeamAgentCount } from '../config/teams/index.js'
import { getAssistants, listAssistants, getHierarchyTree, generateSelfKnowledge } from './entityRegistry.js'
import { getMemoryManager } from './memoryManager.js'
import {
  createListTemplate,
  createStatusCard,
  createStatsTemplate,
  createHostInfoTemplate,
  createAgentInfoTemplate,
  createMemoryResultsTemplate,
  createHelpTemplate,
  renderToMarkdown
} from './responseTemplates.js'
import { RegexClassifier, createFromRouterPatterns } from './regexClassifier.js'
import { calculateAmbiguity, shouldTrustResult, mergeResults } from './intentClassifier.js'
import {
  getRouterConfig,
  getIntentThreshold,
  shouldShowClarification,
  shouldRouteIntent
} from './routerConfig.js'
// Semantic intent classification stubs — the old semantic router for Smart Router
// intents (health_check, fleet_status, etc.) was never completed. Agent-level
// semantic routing now lives in semanticRouter.js and is consumed by agentDelegator.js.
const classifySemantic = async () => ({ intent: null, confidence: 0 })
const isSemanticAvailable = async () => false
const getSemanticStats = () => ({ status: 'disabled', exampleCount: 0, intentCount: 0 })
import { createLayerEvent, storeEnvelope } from '../lib/aee/index.js'
import { delegateToAgent, shouldDelegate, refreshCustomAgents, DELEGATION_CONFIG } from './agentDelegator.js'
import { getCompactInjection as getMirrorSummary } from './mirrorIndex.js'

// Router telemetry for tracking pattern effectiveness
const routerTelemetry = {
  matches: [],
  misses: [],
  reformulations: [],
  escalations: [],
  lastQuery: null,
  lastQueryTime: 0,
  lastPattern: null,

  log(type, query, pattern = null) {
    const now = Date.now()
    const entry = { ts: now, query: query.slice(0, 100), pattern }

    // Detect reformulation: similar query within 30 seconds after a routed response
    if (type === 'match' || type === 'miss') {
      if (this.lastQuery && this.lastPattern && (now - this.lastQueryTime) < 30000) {
        // Quick follow-up after routed response - might be a reformulation
        const similarity = this._querySimilarity(this.lastQuery, query)
        if (similarity > 0.5) {
          this.reformulations.push({
            ts: now,
            originalQuery: this.lastQuery,
            reformulatedQuery: query.slice(0, 100),
            originalPattern: this.lastPattern,
            timeGap: now - this.lastQueryTime,
            similarity
          })
          console.log(`[RouterTelemetry] Possible reformulation detected: "${this.lastQuery}" -> "${query}"`)
          // Keep last 50 reformulations
          if (this.reformulations.length > 50) this.reformulations.shift()
        }
      }

      this.lastQuery = query.slice(0, 100)
      this.lastQueryTime = now
      this.lastPattern = type === 'match' ? pattern : null
    }

    if (type === 'match') this.matches.push(entry)
    else if (type === 'miss') this.misses.push(entry)
    else if (type === 'escalation') {
      this.escalations.push(entry)
      // Keep last 50 escalations
      if (this.escalations.length > 50) this.escalations.shift()
    }

    // Keep last 100 entries
    if (this.matches.length > 100) this.matches.shift()
    if (this.misses.length > 100) this.misses.shift()
  },

  // Simple word-overlap similarity (0-1)
  _querySimilarity(q1, q2) {
    const words1 = new Set(q1.toLowerCase().split(/\s+/))
    const words2 = new Set(q2.toLowerCase().split(/\s+/))
    const intersection = [...words1].filter(w => words2.has(w)).length
    const union = new Set([...words1, ...words2]).size
    return union > 0 ? intersection / union : 0
  },

  // Track when user clicks "Ask Claude" button
  logEscalation(query, pattern) {
    this.log('escalation', query, pattern)
    console.log(`[RouterTelemetry] User escalated to Claude: pattern=${pattern}, query="${query}"`)
  },

  getStats() {
    const total = this.matches.length + this.misses.length
    const recentReformulations = this.reformulations.filter(r => Date.now() - r.ts < 3600000) // Last hour
    const recentEscalations = this.escalations.filter(e => Date.now() - e.ts < 3600000)

    // Calculate per-pattern stats
    const patternStats = {}
    for (const match of this.matches) {
      if (!patternStats[match.pattern]) {
        patternStats[match.pattern] = { count: 0, escalations: 0, reformulations: 0 }
      }
      patternStats[match.pattern].count++
    }

    // Count escalations per pattern
    for (const esc of this.escalations) {
      if (patternStats[esc.pattern]) {
        patternStats[esc.pattern].escalations++
      }
    }

    // Count reformulations per pattern
    for (const ref of this.reformulations) {
      if (patternStats[ref.originalPattern]) {
        patternStats[ref.originalPattern].reformulations++
      }
    }

    return {
      total,
      matches: this.matches.length,
      misses: this.misses.length,
      bypassRate: total > 0 ? Math.round((this.matches.length / total) * 100) : 0,
      recentPatterns: [...new Set(this.matches.slice(-20).map(m => m.pattern))],
      reformulations: {
        total: this.reformulations.length,
        lastHour: recentReformulations.length,
        rate: this.matches.length > 0
          ? Math.round((this.reformulations.length / this.matches.length) * 100)
          : 0
      },
      escalations: {
        total: this.escalations.length,
        lastHour: recentEscalations.length,
        rate: this.matches.length > 0
          ? Math.round((this.escalations.length / this.matches.length) * 100)
          : 0
      },
      patternStats
    }
  }
}

/**
 * Escalation Detection - Patterns that indicate user dissatisfaction
 * When detected after a routed response, we should pass to Claude instead
 */
const ESCALATION_PATTERNS = [
  // Explicit requests to use Claude
  /^(?:ask|try|use)\s+claude/i,
  /^(?:let|have)\s+claude/i,
  /^claude,?\s+/i,
  /^send\s+(?:this\s+)?to\s+claude/i,

  // Expressing dissatisfaction
  /^(?:that's\s+)?not\s+(?:what|right|correct|helpful)/i,
  /^(?:that's\s+)?wrong/i,
  /^no,?\s+(?:that's\s+)?not/i,
  /^(?:i\s+)?didn't\s+(?:ask|mean|want)/i,
  /^that\s+(?:wasn't|isn't)\s+(?:what|my)/i,

  // Requesting retry or different answer
  /^try\s+again/i,
  /^(?:can\s+you\s+)?(?:please\s+)?(?:re-?)?answer/i,
  /^(?:i\s+)?need\s+(?:a\s+)?(?:better|different|real)\s+(?:answer|response)/i,
  /^(?:give\s+me\s+)?(?:a\s+)?(?:proper|real|actual)\s+(?:answer|response)/i,

  // Frustration indicators
  /^(?:this\s+)?(?:doesn't|didn't)\s+(?:help|work|make sense)/i,
  /^(?:i\s+)?(?:don't|didn't)\s+understand/i,
  /^what\s+(?:i\s+)?(?:actually|really)\s+(?:meant|asked|want)/i,
  /^(?:i\s+)?hate/i,
  /^(?:that's?\s+)?(?:terrible|awful|useless|bad|garbage|trash)/i,
  /^not\s+helpful/i,
  /^(?:what\s+a\s+)?(?:waste|joke)/i,
  /^(?:you're|you\s+are)\s+(?:useless|terrible|bad|broken)/i,
  /^(?:this\s+is\s+)?(?:stupid|dumb|broken|garbage)/i,
  /^(?:stop|quit|enough)/i,

  // Explicit bypass request
  /^bypass\s+(?:the\s+)?(?:smart\s+)?router/i,
  /^skip\s+(?:the\s+)?(?:smart\s+)?router/i,
  /^disable\s+(?:the\s+)?(?:smart\s+)?router/i
]

/**
 * Check if a query is an escalation request after a routed response
 * @param {string} query - The user query
 * @returns {{ isEscalation: boolean, reason?: string, originalQuery?: string, originalPattern?: string }}
 */
function checkEscalation(query) {
  const trimmedQuery = query.trim().toLowerCase()
  const now = Date.now()

  // Only check for escalation within 60 seconds of last routed response
  const timeSinceLastRoute = now - routerTelemetry.lastQueryTime
  const wasRecentlyRouted = routerTelemetry.lastPattern && timeSinceLastRoute < 60000

  if (!wasRecentlyRouted) {
    return { isEscalation: false }
  }

  // Check against escalation patterns
  for (const pattern of ESCALATION_PATTERNS) {
    if (pattern.test(trimmedQuery)) {
      console.log(`[QuoxRouter] Escalation detected: "${query}" matches escalation pattern`)
      routerTelemetry.logEscalation(routerTelemetry.lastQuery, routerTelemetry.lastPattern)

      return {
        isEscalation: true,
        reason: 'escalation-pattern-match',
        originalQuery: routerTelemetry.lastQuery,
        originalPattern: routerTelemetry.lastPattern
      }
    }
  }

  return { isEscalation: false }
}

/**
 * Router patterns and their handlers
 * Each pattern has:
 * - regex: Pattern to match against user query
 * - handler: Async function that returns { handled: boolean, response: string, type: string }
 * - description: Human-readable description of what this pattern handles
 */
const ROUTER_PATTERNS = [
  {
    name: 'install_quoxagent',
    regex: /(?:install|deploy|setup)\s+quoxagent\s+(?:on\s+)?(.+)/i,
    handler: triggerQuoxAgentInstall,
    description: 'Install QuoxAgent on specified hosts'
  },
  {
    name: 'fleet_status',
    regex: /(?:quoxagent|fleet|agent)\s+status/i,
    handler: fetchFleetStatus,
    description: 'Get QuoxAgent fleet status'
  },
  {
    name: 'what_is_quox',
    regex: /what\s+(?:is|are)\s+(?:you|quox(?:core)?|commanderq)/i,
    handler: explainQuox,
    description: 'Explain what Quox is'
  },
  {
    name: 'capabilities',
    regex: /what\s+can\s+(?:you|quox)\s+do/i,
    handler: listCapabilities,
    description: 'List Quox capabilities'
  },
  {
    name: 'list_agents',
    regex: /(?:list|show)\s+(?:all\s+)?(?:quoxagent\s+)?agents?/i,
    handler: listAgents,
    description: 'List connected QuoxAgent agents'
  },
  {
    name: 'health_check',
    regex: /(?:health\s*check|check\s+(?:health|status|connectivity))\s+(?:on\s+|for\s+)?([a-z0-9][a-z0-9._-]*)/i,
    handler: runHealthCheck,
    description: 'Run health check on hosts'
  },
  {
    name: 'who_are_you',
    regex: /who\s+are\s+you/i,
    handler: explainQuox,
    description: 'Identity query'
  },
  {
    name: 'list_hosts',
    regex: /(?:list|show)\s+(?:all\s+)?(?:known\s+)?hosts?/i,
    handler: listKnownHosts,
    description: 'List all known hosts'
  },
  {
    name: 'ping_fleet',
    regex: /(?:ping|check\s+connectivity|fleet\s+(?:ping|status|connectivity))/i,
    handler: pingFleetHandler,
    description: 'Ping all hosts in the fleet'
  },
  {
    name: 'bastion_status',
    regex: /(?:bastion|ssh)\s+(?:status|health|check)/i,
    handler: bastionStatusHandler,
    description: 'Check QuoxBastion status'
  },
  {
    name: 'list_assistants',
    regex: /(?:list|show)\s+(?:all\s+)?assistants?|what\s+assistants?\s+(?:are\s+)?(?:there|available)/i,
    handler: listAssistantsHandler,
    description: 'List all Quox assistants'
  },
  // ===== TIER 1 PATTERNS (High Frequency) =====
  {
    name: 'memory_search',
    regex: /(?:what\s+do\s+you\s+(?:know|remember)\s+about|do\s+you\s+remember|recall|search\s+memory\s+for)\s+(.+)/i,
    handler: searchMemoryHandler,
    description: 'Search memory for information about a topic'
  },
  {
    name: 'preference_get',
    regex: /(?:what(?:'s|\s+is)\s+my\s+(?:preference|setting)\s+for|show\s+(?:my\s+)?preference|my\s+(.+)\s+(?:preference|setting))/i,
    handler: getPreferenceHandler,
    description: 'Get user preference value'
  },
  {
    name: 'preference_list',
    regex: /(?:list|show)\s+(?:all\s+)?(?:my\s+)?preferences|my\s+settings/i,
    handler: listPreferencesHandler,
    description: 'List all user preferences'
  },
  {
    name: 'router_stats',
    regex: /(?:router|bypass)\s+stats?|(?:how\s+many|what)\s+(?:queries?\s+)?(?:are\s+)?bypassed?/i,
    handler: getRouterStatsHandler,
    description: 'Show Smart Router bypass statistics'
  },
  // ===== AGENTIC TEAMS PATTERNS =====
  {
    name: 'list_teams',
    regex: /(?:list|show|what)\s+(?:all\s+)?(?:my\s+)?(?:agentic\s+)?teams|(?:which|what)\s+teams?\s+(?:are\s+)?(?:there|available|installed)/i,
    handler: listTeamsHandler,
    description: 'List available agentic teams'
  },
  {
    name: 'team_info',
    regex: /(?:tell\s+me\s+about|describe|info\s+(?:about|on|for)|what\s+is)\s+(?:the\s+)?(?:agentic\s+)?team\s+(.+)/i,
    handler: teamInfoHandler,
    description: 'Get information about a specific agentic team'
  },
  {
    name: 'create_team',
    regex: /(?:create|make|build|set\s*up)\s+(?:a\s+)?(?:new\s+)?(?:agentic\s+)?team/i,
    handler: createTeamGuideHandler,
    description: 'Guide user to create a new agentic team'
  },
  {
    name: 'create_agent',
    regex: /(?:create|make|build|set\s*up)\s+(?:a\s+)?(?:new\s+)?(?:agent|assistant|chatbot|bot|widget)/i,
    handler: (query) => ({
      handled: false,
      escalateToAgent: 'architect',
      reason: 'Agent/assistant creation request — delegating to ARCHITECT'
    }),
    description: 'Delegate agent/assistant creation to ARCHITECT'
  },
  {
    name: 'create_tool',
    regex: /(?:create|make|build)\s+(?:a\s+)?(?:new\s+)?(?:custom\s+)?tool/i,
    handler: (query) => ({
      handled: false,
      escalateToAgent: 'architect',
      reason: 'Tool creation request — delegating to ARCHITECT'
    }),
    description: 'Delegate tool creation to ARCHITECT'
  },
  // ===== TIER 2 PATTERNS (Medium Frequency) =====
  {
    name: 'host_details',
    regex: /(?:tell\s+me\s+about|details?\s+(?:about|for|on)|info\s+(?:about|on|for))\s+(?:host\s+)([a-z0-9][a-z0-9._-]*)|(?:what\s+is)\s+host\s+([a-z0-9][a-z0-9._-]*)/i,
    handler: getHostDetailsHandler,
    description: 'Get details about a specific host (requires "host" keyword or known hostname)'
  },
  {
    name: 'agent_info',
    regex: /(?:what\s+can|tell\s+me\s+about|describe)\s+agent\s+([A-Z]+)|(?:what\s+can)\s+([A-Z]+)\s+(?:agent\s+)?do/i,
    handler: getAgentInfoHandler,
    description: 'Get information about a specific agent (requires "agent" keyword)'
  },
  {
    name: 'greeting',
    regex: /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|greetings)(?:\s+quox)?[!.]?$/i,
    handler: greetingHandler,
    description: 'Respond to greetings'
  },
  {
    name: 'time_query',
    regex: /^(?:what(?:'s|\s+is)\s+the\s+time|current\s+time|what\s+time\s+is\s+it)[?!.]?$/i,
    handler: timeQueryHandler,
    description: 'Get current time (simple — timezone queries go to Claude)'
  },
  {
    name: 'help_query',
    regex: /^(?:help|what\s+can\s+(?:i|you)\s+(?:ask|do)|commands?|how\s+do\s+i)$/i,
    handler: helpQueryHandler,
    description: 'Show available commands and help'
  },
  // ===== FILE OPERATIONS PATTERNS =====
  {
    name: 'file_capabilities',
    regex: /(?:what\s+can\s+(?:you|archivist|quox)\s+do\s+with\s+files?|file\s+capabilities|how\s+do\s+i\s+(?:use|work\s+with)\s+files?|(?:what|which)\s+files?\s+(?:do\s+(?:you|i)\s+have|have\s+access|can\s+(?:you|i)\s+access)|do\s+(?:you|i)\s+have\s+(?:any\s+)?files?)/i,
    handler: fileCapabilitiesHandler,
    description: 'Explain file management capabilities'
  },
  {
    name: 'summarize_file',
    regex: /(?:summarize|summarise|summary\s+of)\s+(?:the\s+)?file\s+(.+)/i,
    handler: summarizeFileHandler,
    description: 'Summarize a file using ARCHIVIST (requires "file" keyword)'
  },
  {
    name: 'compare_files',
    regex: /(?:compare|diff|difference\s+between)\s+(?:files?\s+)?(.+)\s+(?:and|vs|with)\s+(.+)/i,
    handler: compareFilesHandler,
    description: 'Compare two files using ARCHIVIST'
  },
  {
    name: 'list_files',
    regex: /(?:list|show)\s+(?:all\s+)?(?:my\s+)?files?(?:\s+in\s+(.+))?/i,
    handler: listFilesHandler,
    description: 'List files in file manager'
  },
  {
    name: 'archivist_info',
    regex: /(?:what\s+is|who\s+is|tell\s+me\s+about)\s+archivist/i,
    handler: archivistInfoHandler,
    description: 'Explain the ARCHIVIST agent'
  },
  {
    name: 'chat_with_folder',
    regex: /(?:chat\s+with)\s+(?:the\s+)?(?:files?\s+in\s+)?folder\s+(.+)|(?:ask|question)\s+(?:about\s+)?(?:the\s+)?files?\s+in\s+(?:folder\s+)?(.+)/i,
    handler: chatWithFolderHandler,
    description: 'Chat with files in a folder (requires "folder" or "files in" keyword)'
  }
]

// Create handler map for lookup by intent name
const HANDLER_MAP = new Map(ROUTER_PATTERNS.map(p => [p.name, p.handler]))

// Initialize the regex classifier from existing patterns
let regexClassifier = null

function getRegexClassifier() {
  if (!regexClassifier) {
    regexClassifier = createFromRouterPatterns(ROUTER_PATTERNS)
    console.log('[QuoxRouter] Initialized regex classifier with', ROUTER_PATTERNS.length, 'patterns')
  }
  return regexClassifier
}

/**
 * Intent descriptions for clarifying questions
 */
const INTENT_DESCRIPTIONS = {
  install_quoxagent: 'Install QuoxAgent agent on a host',
  fleet_status: 'Check QuoxAgent fleet status',
  what_is_quox: 'Learn about CommanderQ',
  capabilities: 'See what CommanderQ can do',
  list_agents: 'List connected QuoxAgent agents',
  health_check: 'Run health check on hosts',
  who_are_you: 'Learn about Quox\'s identity',
  list_hosts: 'List all known hosts',
  list_assistants: 'List Quox assistants',
  memory_search: 'Search memory for information',
  preference_get: 'Get a specific preference',
  preference_list: 'List all preferences',
  router_stats: 'Show Smart Router statistics',
  host_details: 'Get details about a host',
  agent_info: 'Get information about an agent',
  greeting: 'Greeting response',
  time_query: 'Get current time',
  help_query: 'Show help and commands',
  ping_fleet: 'Ping all hosts in the fleet',
  bastion_status: 'Check QuoxBastion status'
}

/**
 * Format response with agent personality
 * @param {string} agentId - The agent ID (e.g., 'quox', 'nova')
 * @param {string} message - The message content
 * @returns {string} Formatted response with agent prefix
 */
function formatAgentResponse(agentId, message) {
  const agent = getAssistant(agentId) || assistants.quox
  const name = agent?.name || agent?.identity?.name || 'Quox'
  return `[${name}] ${message}`
}

/**
 * Handler: Install QuoxAgent on specified hosts
 */
async function triggerQuoxAgentInstall(match, query, context) {
  const hostsStr = match[1].trim()
  const { currentAssistant } = context

  // Parse host list (comma or space separated)
  const hostNames = hostsStr.split(/[,\s]+/).filter(h => h.length > 0)

  if (hostNames.length === 0) {
    return {
      handled: true,
      response: formatAgentResponse(currentAssistant,
        'Please specify which hosts to install QuoxAgent on. Example: "install quoxagent on docker01" or "install quoxagent on kuma01, gw-01"'),
      type: 'info'
    }
  }

  // Resolve hostnames (handle aliases like "kuma" -> "kuma01")
  const resolvedHosts = hostNames.map(h => {
    const resolved = resolveHostname(h)
    return resolved || h
  })

  // Check which hosts already have QuoxAgent
  const statusResults = await Promise.all(
    resolvedHosts.map(async host => ({
      host,
      status: await checkQuoxAgentStatus(host)
    }))
  )

  const alreadyInstalled = statusResults.filter(r => r.status.installed && r.status.running)
  const needsInstall = statusResults.filter(r => !r.status.installed || !r.status.running)

  if (needsInstall.length === 0) {
    return {
      handled: true,
      response: formatAgentResponse(currentAssistant,
        `QuoxAgent is already installed and running on: ${alreadyInstalled.map(r => r.host).join(', ')}\n\nNo installation needed.`),
      type: 'info'
    }
  }

  // Trigger installation
  const hostsToInstall = needsInstall.map(r => r.host)

  // Return a response with install instructions (we can't actually install directly, but we can guide)
  let response = `Initiating QuoxAgent installation on ${hostsToInstall.length} host(s):\n\n`

  for (const host of hostsToInstall) {
    response += `**${host}**: `
    const status = statusResults.find(r => r.host === host)?.status
    if (status?.installed && !status?.running) {
      response += 'QuoxAgent installed but not running. Restarting...\n'
    } else {
      response += 'Installing QuoxAgent...\n'
    }
  }

  response += `\n**Installation Command:**\n\`\`\`bash\n`
  response += `# From any host with SSH access:\n`
  for (const host of hostsToInstall) {
    response += `quoxagent-deploy ${host}\n`
  }
  response += `\n# Or directly on the target host:\n`
  response += `curl -sSL http://localhost:9848/install | sudo bash -s -- --host-id <hostname>\n`
  response += `\`\`\`\n`

  if (alreadyInstalled.length > 0) {
    response += `\n*Already installed on: ${alreadyInstalled.map(r => r.host).join(', ')}*`
  }

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'action',
    metadata: {
      action: 'quoxagent_install',
      hosts: hostsToInstall,
      alreadyInstalled: alreadyInstalled.map(r => r.host)
    }
  }
}

/**
 * Handler: Fetch fleet status
 */
async function fetchFleetStatus(match, query, context) {
  const { currentAssistant } = context

  try {
    const [fleetSummary, fleetStatus] = await Promise.all([
      getFleetSummary(),
      getFleetStatus()
    ])

    let response = 'Fleet Status Report\n\n'

    if (fleetSummary) {
      response += `**Connected Agents:** ${fleetSummary.connected || 0}\n`
      response += `**Total Hosts:** ${fleetSummary.total || fleetStatus.total}\n`
      response += `**Coverage:** ${fleetStatus.coverage}\n\n`
    } else {
      response += `**Coverage:** ${fleetStatus.coverage}\n\n`
    }

    if (fleetStatus.connected?.length > 0) {
      response += `**Active Agents:**\n`
      for (const host of fleetStatus.connected.slice(0, 10)) {
        response += `- ${host}\n`
      }
      if (fleetStatus.connected.length > 10) {
        response += `  *...and ${fleetStatus.connected.length - 10} more*\n`
      }
      response += '\n'
    }

    if (fleetStatus.withoutQuoxAgent?.length > 0) {
      response += `**Hosts Without QuoxAgent:**\n`
      for (const host of fleetStatus.withoutQuoxAgent.slice(0, 10)) {
        response += `- ${host}\n`
      }
      if (fleetStatus.withoutQuoxAgent.length > 10) {
        response += `  *...and ${fleetStatus.withoutQuoxAgent.length - 10} more*\n`
      }
      response += '\n'
      response += `*Use \`install quoxagent on <host>\` to deploy QuoxAgent to these hosts.*`
    } else {
      response += '*All known hosts have QuoxAgent installed.*'
    }

    if (fleetStatus.error) {
      response += `\n\n**Warning:** ${fleetStatus.error}`
    }

    return {
      handled: true,
      response: formatAgentResponse(currentAssistant, response),
      type: 'status',
      metadata: {
        connected: fleetStatus.connected?.length || 0,
        total: fleetStatus.total,
        coverage: fleetStatus.coverage
      }
    }
  } catch (err) {
    return {
      handled: true,
      response: formatAgentResponse(currentAssistant,
        `Failed to fetch fleet status: ${err.message}\n\nThe QuoxAgent collector may be offline. Check if the collector is running on port 9848.`),
      type: 'error'
    }
  }
}

/**
 * Handler: Explain what Quox is
 */
async function explainQuox(match, query, context) {
  const { currentAssistant } = context

  const response = `I am **CommanderQ** (Multi-Agent Executive System for Tactical Resource Orchestration).

I'm an AI-powered infrastructure command center that manages a homelab environment with 50+ hosts.

**My Capabilities:**
- Infrastructure orchestration and monitoring
- Multi-agent coordination (WARDEN, CIPHER, DAEDALUS, PRISM, and more)
- Voice-enabled command interface
- Security operations and threat monitoring
- Automation and CI/CD workflows
- Proxmox virtualization management
- Real-time metrics and dashboards

**My Agent Hierarchy:**
- **CommanderQ** (Me) - Master orchestrator, coordinates all systems
- **WARDEN** - Security operations (manages SCHOLAR, VIGIL)
- **CIPHER** - Network operations (manages HYPERION, VIGIL)
- **DAEDALUS** - DevOps & automation (manages HYPERION, VULCAN, INSIGHT, METRICS)
- **PRISM** - Analysis & classification

**QuoxAgent (Quox Helper Agent):**
I deploy lightweight agents on each host for direct command execution and metrics collection.

*"At your service. What can I help you with?"*`

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'info'
  }
}

/**
 * Handler: List Quox capabilities
 */
async function listCapabilities(match, query, context) {
  const { currentAssistant } = context

  const response = `Here's what I can do:

**Infrastructure Management:**
- Monitor and manage 50+ hosts across Proxmox, Docker, and bare metal
- Execute commands on remote hosts via QuoxAgent agents
- Check system health, disk usage, and resource metrics

**Files & Document Intelligence (ARCHIVIST):**
- Organize files into folders with drag-and-drop
- Chat with folder contents (with source citations)
- Semantic search across file contents (Premium)
- Summarize, compare, and extract data from files (Premium)
- Generate quizzes and find contradictions (Premium)

**Security Operations (WARDEN):**
- Threat scanning and vulnerability detection
- Authentication audit and log analysis
- Firewall rule management

**Network Operations (CIPHER):**
- Network monitoring and traffic analysis
- VPN and connectivity management
- DNS and routing configuration

**DevOps & Automation (DAEDALUS):**
- Container management (Docker)
- CI/CD pipeline orchestration
- Automated deployments and rollbacks

**Virtualization (HYPERION):**
- Proxmox VM lifecycle management
- Snapshots, migrations, and cloning
- Cluster status monitoring

**Monitoring & Analytics:**
- METRICS: Prometheus queries and alerts
- INSIGHT: Grafana dashboard access
- VIGIL: Uptime and availability monitoring

**AI-Assisted Tasks:**
- VULCAN: Script and code generation
- PRISM: Task classification and analysis
- ARCHIVIST: File intelligence and document analysis
- SCHOLAR: Research and documentation

**Quick Commands:**
- \`quoxagent status\` - Check fleet status
- \`install quoxagent on <host>\` - Deploy QuoxAgent agent
- \`list agents\` - Show connected agents
- \`list hosts\` - Show known hosts
- \`summarize file <name>\` - Summarize a file
- \`compare files\` - Compare two files

*What would you like me to help with?*`

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'info'
  }
}

/**
 * Handler: List connected QuoxAgent agents
 */
async function listAgents(match, query, context) {
  const { currentAssistant } = context

  try {
    const { count, agents } = await getAgents()

    if (count === 0 || !agents?.length) {
      return {
        handled: true,
        response: formatAgentResponse(currentAssistant,
          'No QuoxAgent agents are currently connected.\n\nTo deploy QuoxAgent on a host:\n```bash\nquoxagent-deploy <hostname>\n```'),
        type: 'info'
      }
    }

    let response = `**Connected QuoxAgent Agents:** ${count}\n\n`

    // Group agents by connection status (status is an object: {connection, last_seen_seconds})
    const getConn = a => a.status?.connection || a.health?.status || 'unknown'
    const healthy = agents.filter(a => getConn(a) === 'connected' || getConn(a) === 'healthy')
    const unhealthy = agents.filter(a => getConn(a) !== 'connected' && getConn(a) !== 'healthy')

    if (healthy.length > 0) {
      response += `**Healthy (${healthy.length}):**\n`
      for (const agent of healthy.slice(0, 15)) {
        const lastSeen = agent.last_seen ? new Date(agent.last_seen).toLocaleTimeString() : 'N/A'
        response += `- **${agent.host_id}** - Last seen: ${lastSeen}\n`
      }
      if (healthy.length > 15) {
        response += `  *...and ${healthy.length - 15} more healthy agents*\n`
      }
    }

    if (unhealthy.length > 0) {
      response += `\n**Needs Attention (${unhealthy.length}):**\n`
      for (const agent of unhealthy) {
        response += `- **${agent.host_id}** - Status: ${getConn(agent)}\n`
      }
    }

    return {
      handled: true,
      response: formatAgentResponse(currentAssistant, response),
      type: 'status',
      metadata: { count, healthy: healthy.length, unhealthy: unhealthy.length }
    }
  } catch (err) {
    return {
      handled: true,
      response: formatAgentResponse(currentAssistant,
        `Failed to fetch agents: ${err.message}\n\nThe QuoxAgent collector may be offline.`),
      type: 'error'
    }
  }
}

/**
 * Stop words that should not be treated as hostnames in health check queries
 */
const HEALTH_CHECK_STOP_WORDS = new Set([
  // Articles/prepositions
  'on', 'the', 'a', 'an', 'in', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
  // Common nouns
  'host', 'hosts', 'server', 'servers', 'status', 'system', 'systems',
  'disk', 'space', 'memory', 'cpu', 'network', 'problems', 'issues', 'errors',
  // Adjectives
  'low', 'high', 'any', 'all', 'some', 'every', 'each',
  // Question words
  'what', 'which', 'where', 'how', 'why', 'when',
  // Pronouns
  'my', 'your', 'our', 'their', 'its'
])

/**
 * Check if a string looks like a valid hostname (not a common word)
 * @param {string} str - String to check
 * @returns {boolean}
 */
function looksLikeHostname(str) {
  if (!str || str.length < 2 || str.length > 63) return false
  if (HEALTH_CHECK_STOP_WORDS.has(str.toLowerCase())) return false

  // Must match hostname pattern (starts with letter, alphanumeric with hyphens)
  const hostnamePattern = /^[a-z][a-z0-9-]*[a-z0-9]$/i
  if (!hostnamePattern.test(str)) return false

  // Check if it's a known hostname first
  const resolved = resolveHostname(str)
  if (resolved) return true

  // Prefer structured hostnames (with numbers like docker01, kuma-01)
  return /[a-z]+\d+$|[a-z]+-\d+$/i.test(str)
}

/**
 * Handler: Run health check on specified hosts
 */
async function runHealthCheck(match, query, context) {
  const { currentAssistant } = context
  const targetStr = match[1]?.trim() || ''

  // Extract host names from the query
  // Handle patterns like "check docker01", "health check on kuma01", "check all hosts"
  const targetLower = targetStr.toLowerCase()

  if (targetLower.includes('all') || targetLower.includes('fleet') || targetLower.includes('everything')) {
    // Fleet-wide health check
    try {
      const fleetStatus = await getFleetStatus()
      const { agents } = await getAgents()

      // MR-4: Include Mirror cognitive index summary
      let mirrorSummary = ''
      try { mirrorSummary = await getMirrorSummary() } catch { /* non-blocking */ }

      let response = `Fleet Health Check\n\n`
      if (mirrorSummary) {
        response += mirrorSummary + '\n\n---\n\n'
      }
      response += `**Total Hosts:** ${fleetStatus.total}\n`
      response += `**QuoxAgent Coverage:** ${fleetStatus.coverage}\n\n`

      if (agents?.length > 0) {
        const getConn = a => a.status?.connection || a.health?.status || 'unknown'
        const healthy = agents.filter(a => getConn(a) === 'connected' || getConn(a) === 'healthy')
        response += `**Agent Health:** ${healthy.length}/${agents.length} healthy\n\n`

        const unhealthy = agents.filter(a => getConn(a) !== 'connected' && getConn(a) !== 'healthy')
        if (unhealthy.length > 0) {
          response += `**Agents Needing Attention:**\n`
          for (const a of unhealthy) {
            response += `- ${a.host_id}: ${getConn(a)}\n`
          }
        } else {
          response += `*All connected agents are healthy.*`
        }
      } else {
        response += `*No agents connected for health check.*`
      }

      if (fleetStatus.withoutQuoxAgent?.length > 0) {
        response += `\n\n**Hosts Without QuoxAgent:** ${fleetStatus.withoutQuoxAgent.length}`
        response += `\n*Run \`install quoxagent on <host>\` to add monitoring*`
      }

      return {
        handled: true,
        response: formatAgentResponse(currentAssistant, response),
        type: 'health'
      }
    } catch (err) {
      return {
        handled: true,
        response: formatAgentResponse(currentAssistant,
          `Failed to perform fleet health check: ${err.message}`),
        type: 'error'
      }
    }
  }

  // Single host or specific hosts health check
  const hostNames = targetStr.split(/[,\s]+/).filter(h =>
    h.length > 0 &&
    !HEALTH_CHECK_STOP_WORDS.has(h.toLowerCase()) &&
    looksLikeHostname(h)
  )

  if (hostNames.length === 0) {
    // No valid hostnames extracted — let Claude handle the query.
    // It has fleet_status/ssh_exec tools and can do a real infrastructure check.
    return { handled: false }
  }

  // Resolve hostnames and check status
  const results = await Promise.all(
    hostNames.map(async h => {
      const resolved = resolveHostname(h) || h
      const status = await checkQuoxAgentStatus(resolved)
      return { host: resolved, original: h, status }
    })
  )

  let response = `Health Check Results\n\n`

  for (const { host, original, status } of results) {
    const displayName = host !== original ? `${host} (${original})` : host

    if (status.installed && status.running) {
      response += `**${displayName}:** Healthy\n`
      if (status.version) response += `  - Version: ${status.version}\n`
    } else if (status.installed && !status.running) {
      response += `**${displayName}:** QuoxAgent installed but not running\n`
      response += `  - Try: \`systemctl start quoxagent\` on the host\n`
    } else if (status.error) {
      response += `**${displayName}:** ${status.error}\n`
    } else {
      response += `**${displayName}:** QuoxAgent not installed\n`
      response += `  - Install with: \`quoxagent-deploy ${host}\`\n`
    }
  }

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'health',
    metadata: { hosts: hostNames, results }
  }
}

/**
 * Handler: List known hosts (now uses Bastion as primary source)
 */
async function listKnownHosts(match, query, context) {
  const { currentAssistant } = context

  let response = ''
  let totalHosts = 0

  // Try Bastion first
  const bastionOk = await isBastionAvailable()

  if (bastionOk) {
    try {
      const { hosts, ping } = await getHostsWithPing()
      const groups = await getGroups()

      const online = Object.values(ping).filter(p => p.reachable).length

      response = `Infrastructure Fleet (via QuoxBastion)\n\n`
      response += `**Status:** ${online}/${hosts.length} online\n\n`

      // Group hosts
      const grouped = {}
      for (const host of hosts) {
        const group = host.group || 'other'
        if (!grouped[group]) grouped[group] = []
        grouped[group].push({
          ...host,
          isOnline: ping[host.id]?.reachable,
          latency: ping[host.id]?.latency_ms
        })
      }

      for (const group of groups) {
        const groupHosts = grouped[group] || []
        if (groupHosts.length === 0) continue

        const groupOnline = groupHosts.filter(h => h.isOnline).length
        response += `**${group}** (${groupOnline}/${groupHosts.length} online):\n`

        for (const host of groupHosts) {
          const status = host.isOnline ? '`online`' : '`offline`'
          const latencyStr = host.latency ? ` (${host.latency}ms)` : ''
          response += `- ${host.id} (${host.address}) - ${status}${latencyStr}\n`
        }
        response += '\n'
      }

      totalHosts = hosts.length
      response += `**Total:** ${totalHosts} hosts managed by QuoxBastion`

    } catch (err) {
      console.warn('[listKnownHosts] Bastion fetch failed:', err.message)
      // Fall through to static registry
    }
  }

  // Fallback when Bastion is unavailable
  if (!response) {
    response = `Infrastructure Hosts — Unavailable\n\n`
    response += `**QuoxBastion is not reachable or not authenticated.**\n\n`
    response += `No host data is available. To fix:\n`
    response += `1. Check if QuoxBastion is running on your bastion server\n`
    response += `2. Ensure the API token is configured in **Settings > Bastion Fleet**\n`
    response += `3. Run \`bastion status\` or check the Bastion panel for connectivity\n`
    totalHosts = 0
  }

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'info',
    metadata: { total: totalHosts, bastionAvailable: bastionOk }
  }
}

/**
 * Handler: Ping all hosts in the fleet
 */
async function pingFleetHandler(match, query, context) {
  const { currentAssistant } = context

  try {
    const bastionOk = await isBastionAvailable()

    if (!bastionOk) {
      return {
        handled: true,
        response: formatAgentResponse(currentAssistant,
          `QuoxBastion is not available. Cannot ping fleet.\n\nTo check Bastion status: \`bastion status\`\nTo start Bastion: Ensure the service is running on gw-01:9850`),
        type: 'error'
      }
    }

    const pingResults = await bastionClient.pingHosts()

    const online = pingResults.filter(p => p.reachable)
    const offline = pingResults.filter(p => !p.reachable)

    // Calculate average latency
    const avgLatency = online.length > 0
      ? Math.round(online.reduce((sum, p) => sum + (p.latency_ms || 0), 0) / online.length)
      : 0

    let response = `Fleet Ping Results\n\n`
    response += `**Summary:**\n`
    response += `- Online: ${online.length}/${pingResults.length}\n`
    response += `- Offline: ${offline.length}\n`
    response += `- Avg Latency: ${avgLatency}ms\n\n`

    if (online.length > 0) {
      response += `**Online Hosts:**\n`
      // Sort by latency
      const sorted = online.sort((a, b) => (a.latency_ms || 0) - (b.latency_ms || 0))
      for (const p of sorted.slice(0, 15)) {
        response += `- ${p.host_id || p.host || p.ip || 'unknown'}: ${p.latency_ms}ms\n`
      }
      if (sorted.length > 15) {
        response += `  *...and ${sorted.length - 15} more*\n`
      }
    }

    if (offline.length > 0) {
      response += `\n**Offline Hosts:**\n`
      for (const p of offline) {
        response += `- ${p.host_id || p.host || p.ip || 'unknown'}: ${p.error || 'unreachable'}\n`
      }
    }

    return {
      handled: true,
      response: formatAgentResponse(currentAssistant, response),
      type: 'status',
      metadata: {
        online: online.length,
        offline: offline.length,
        avgLatency,
        total: pingResults.length
      }
    }
  } catch (err) {
    return {
      handled: true,
      response: formatAgentResponse(currentAssistant,
        `Failed to ping fleet: ${err.message}`),
      type: 'error'
    }
  }
}

/**
 * Handler: Check QuoxBastion status
 */
async function bastionStatusHandler(match, query, context) {
  const { currentAssistant } = context

  try {
    const health = await bastionClient.checkHealth()

    let response = `QuoxBastion Status\n\n`
    response += `**Status:** Online\n`
    response += `**Endpoint:** http://gw-01:9850\n\n`

    // Get fleet summary
    try {
      const summary = await bastionClient.getFleetSummary()
      response += `**Fleet Overview:**\n`
      response += `- Total Hosts: ${summary.totalHosts}\n`
      response += `- Groups: ${summary.groupCount}\n`

      if (summary.health) {
        const healthCounts = Object.entries(summary.health)
          .map(([status, count]) => `${status}: ${count}`)
          .join(', ')
        response += `- Health: ${healthCounts}\n`
      }

      if (summary.groups?.length > 0) {
        response += `\n**Groups:** ${summary.groups.join(', ')}\n`
      }
    } catch (e) {
      response += `*Fleet summary unavailable*\n`
    }

    response += `\n**API Endpoints:**\n`
    response += `- \`/api/v1/hosts\` - List all hosts\n`
    response += `- \`/api/v1/ping\` - Ping all hosts\n`
    response += `- \`/api/v1/exec\` - Execute commands\n`
    response += `- \`/api/v1/groups\` - List host groups\n`

    return {
      handled: true,
      response: formatAgentResponse(currentAssistant, response),
      type: 'status',
      metadata: { available: true }
    }
  } catch (err) {
    return {
      handled: true,
      response: formatAgentResponse(currentAssistant,
        `QuoxBastion Status: **OFFLINE**\n\n` +
        `Error: ${err.message}\n\n` +
        `**Troubleshooting:**\n` +
        `1. Check if Bastion is running: \`ssh gw-01 'systemctl status quoxbastion'\`\n` +
        `2. Check port 9850: \`curl -s http://gw-01:9850/api/v1/health\`\n` +
        `3. View logs: \`ssh gw-01 'journalctl -u quoxbastion -n 50'\``),
      type: 'error',
      metadata: { available: false, error: err.message }
    }
  }
}

/**
 * Normalize memory search query by removing AI-referencing pronouns
 * @param {string} query - Raw query string
 * @returns {string} - Normalized query
 */
function normalizeMemoryQuery(query) {
  if (!query) return ''

  // Remove AI-referencing pronouns that cause entity resolution issues
  let cleaned = query.replace(/\b(your|you're|yours)\b/gi, '')

  // Clean up whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim()

  return cleaned.length >= 2 ? cleaned : query
}

/**
 * Handler: Search memory for information
 */
async function searchMemoryHandler(match, query, context) {
  const { currentAssistant } = context
  let searchTerm = match[1]?.trim()

  // Normalize query to handle pronouns
  const originalTerm = searchTerm
  searchTerm = normalizeMemoryQuery(searchTerm)

  if (searchTerm !== originalTerm) {
    console.log(`[Router] Normalized memory query: "${originalTerm}" -> "${searchTerm}"`)
  }

  if (!searchTerm) {
    return {
      handled: true,
      response: formatAgentResponse(currentAssistant,
        'What would you like me to search for in memory? Try: "what do you know about docker01"'),
      type: 'info'
    }
  }

  try {
    const mm = getMemoryManager()
    const results = await mm.hybridSearch(searchTerm, 5)

    if (!results || results.length === 0) {
      return {
        handled: true,
        response: formatAgentResponse(currentAssistant,
          `I don't have any stored memories about "${searchTerm}". Would you like me to remember something about it?`),
        type: 'info',
        metadata: { query: searchTerm, resultCount: 0 }
      }
    }

    let response = `Memory Search: "${searchTerm}"\n\n`
    response += `Found ${results.length} relevant memories:\n\n`

    for (const result of results) {
      const type = result.type || 'memory'
      const content = result.content || result.text || result.value || JSON.stringify(result)
      const score = result.score ? ` (relevance: ${Math.round(result.score * 100)}%)` : ''
      response += `**${type}**${score}:\n${content.slice(0, 200)}${content.length > 200 ? '...' : ''}\n\n`
    }

    return {
      handled: true,
      response: formatAgentResponse(currentAssistant, response),
      type: 'memory',
      metadata: { query: searchTerm, resultCount: results.length }
    }
  } catch (err) {
    return {
      handled: true,
      response: formatAgentResponse(currentAssistant,
        `Memory search failed: ${err.message}`),
      type: 'error'
    }
  }
}

/**
 * Handler: Get a specific preference
 */
async function getPreferenceHandler(match, query, context) {
  const { currentAssistant } = context

  try {
    const mm = getMemoryManager()
    const categories = mm.getPreferenceCategories()

    // Try to extract the preference from the query
    const queryLower = query.toLowerCase()

    // Map common terms to preference categories
    const categoryMappings = {
      'verbosity': ['communication', 'verbosity'],
      'verbose': ['communication', 'verbosity'],
      'communication': ['communication', 'verbosity'],
      'formality': ['communication', 'formality'],
      'formal': ['communication', 'formality'],
      'emoji': ['communication', 'emoji_usage'],
      'emojis': ['communication', 'emoji_usage'],
      'theme': ['interface', 'theme'],
      'dark mode': ['interface', 'theme'],
      'light mode': ['interface', 'theme'],
      'voice': ['interface', 'voice_mode'],
      'timezone': ['interface', 'timezone'],
      'time zone': ['interface', 'timezone'],
      'notifications': ['interface', 'notifications'],
      'work hours': ['schedule', 'work_hours'],
      'working hours': ['schedule', 'work_hours'],
      'focus time': ['schedule', 'focus_time']
    }

    // Find matching preference
    for (const [term, [category, field]] of Object.entries(categoryMappings)) {
      if (queryLower.includes(term)) {
        const value = mm.getPreference(category, field)
        const categoryInfo = categories[category]
        const fieldInfo = categoryInfo?.fields?.[field]

        return {
          handled: true,
          response: formatAgentResponse(currentAssistant,
            `Your **${fieldInfo?.label || field}** preference is set to: **${value ?? 'default'}**\n\n${fieldInfo?.description || ''}`),
          type: 'preference',
          metadata: { category, field, value }
        }
      }
    }

    // No specific preference found - show all
    return listPreferencesHandler(match, query, context)
  } catch (err) {
    return {
      handled: true,
      response: formatAgentResponse(currentAssistant,
        `Failed to get preference: ${err.message}`),
      type: 'error'
    }
  }
}

/**
 * Handler: List all preferences
 */
async function listPreferencesHandler(match, query, context) {
  const { currentAssistant } = context

  try {
    const mm = getMemoryManager()
    const categories = mm.getPreferenceCategories()

    let response = `Your Preferences\n\n`

    for (const [categoryKey, categoryInfo] of Object.entries(categories)) {
      response += `**${categoryInfo.label || categoryKey}:**\n`

      for (const [fieldKey, fieldInfo] of Object.entries(categoryInfo.fields || {})) {
        const value = mm.getPreference(categoryKey, fieldKey)
        const displayValue = value ?? fieldInfo.default ?? 'not set'
        response += `- ${fieldInfo.label || fieldKey}: ${displayValue}\n`
      }
      response += '\n'
    }

    response += `*To change a preference, just tell me what you'd like to change.*`

    return {
      handled: true,
      response: formatAgentResponse(currentAssistant, response),
      type: 'preference',
      metadata: { type: 'list' }
    }
  } catch (err) {
    return {
      handled: true,
      response: formatAgentResponse(currentAssistant,
        `Failed to list preferences: ${err.message}`),
      type: 'error'
    }
  }
}

/**
 * Handler: Get Smart Router statistics
 */
async function getRouterStatsHandler(match, query, context) {
  const { currentAssistant } = context
  const stats = routerTelemetry.getStats()
  const semanticStats = getSemanticStats()

  // Create structured template
  const template = createStatsTemplate('Smart Router Statistics', [
    { label: 'Total Queries', value: stats.total },
    { label: 'Bypassed (no LLM)', value: stats.matches, unit: ` (${stats.bypassRate}%)`, color: 'green' },
    { label: 'Sent to Claude', value: stats.misses, color: 'blue' },
    { label: 'Registered Patterns', value: ROUTER_PATTERNS.length }
  ])

  // Add recent patterns to markdown
  let response = template.toMarkdown()

  // Semantic layer status
  response += `\n**Semantic Layer:**\n`
  response += `- Status: ${semanticStats.status}\n`
  response += `- Intent examples: ${semanticStats.exampleCount}\n`
  response += `- Classifications: ${semanticStats.classifications}\n`
  if (semanticStats.avgLatency > 0) {
    response += `- Avg latency: ${Math.round(semanticStats.avgLatency)}ms\n`
  }

  // Quality metrics
  response += `\n**Quality Metrics:**\n`
  response += `- Reformulation rate: ${stats.reformulations.rate}% (${stats.reformulations.total} total, ${stats.reformulations.lastHour} last hour)\n`
  response += `- Escalation rate: ${stats.escalations.rate}% (${stats.escalations.total} total, ${stats.escalations.lastHour} last hour)\n`

  if (stats.recentPatterns.length > 0) {
    response += `\n**Recent Patterns Used:**\n`
    for (const pattern of stats.recentPatterns) {
      const patternStat = stats.patternStats[pattern]
      if (patternStat) {
        response += `- ${pattern}: ${patternStat.count} uses`
        if (patternStat.escalations > 0) response += `, ${patternStat.escalations} escalations`
        if (patternStat.reformulations > 0) response += `, ${patternStat.reformulations} reformulations`
        response += `\n`
      } else {
        response += `- ${pattern}\n`
      }
    }
  }

  response += `\n*Lower reformulation/escalation rates indicate better routing accuracy. The Smart Router intercepts common queries and responds directly without calling Claude, saving tokens and reducing latency.*`

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'stats',
    template,
    metadata: stats
  }
}

/**
 * Handler: Get host details
 */
async function getHostDetailsHandler(match, query, context) {
  const { currentAssistant } = context
  const hostQuery = (match[1] || match[2])?.trim().toLowerCase()

  if (!hostQuery) {
    return {
      handled: true,
      response: formatAgentResponse(currentAssistant,
        'Which host would you like details about? Try: "tell me about docker01"'),
      type: 'info'
    }
  }

  // Search through host registry
  const allHosts = []
  for (const [category, hosts] of Object.entries(hostRegistry)) {
    for (const host of hosts || []) {
      allHosts.push({ ...host, category })
    }
  }

  // Find matching host
  const matchedHost = allHosts.find(h =>
    h.id?.toLowerCase() === hostQuery ||
    h.id?.toLowerCase().includes(hostQuery) ||
    h.name?.toLowerCase().includes(hostQuery)
  )

  if (!matchedHost) {
    // Try to resolve hostname
    const resolved = resolveHostname(hostQuery)
    if (resolved) {
      const resolvedHost = allHosts.find(h => h.id === resolved)
      if (resolvedHost) {
        return getHostDetailsHandler([match[0], resolved], query, context)
      }
    }

    // Host not in registry — let Claude handle it.
    // Claude has fleet tools and can look up dynamic host data.
    return { handled: false }
  }

  let response = `Host: ${matchedHost.id}\n\n`
  response += `**Category:** ${matchedHost.category}\n`
  if (matchedHost.ip) response += `**IP Address:** ${matchedHost.ip}\n`
  if (matchedHost.description) response += `**Description:** ${matchedHost.description}\n`
  if (matchedHost.os) response += `**OS:** ${matchedHost.os}\n`
  if (matchedHost.role) response += `**Role:** ${matchedHost.role}\n`
  if (matchedHost.services) response += `**Services:** ${matchedHost.services.join(', ')}\n`

  // Check QuoxAgent status
  try {
    const quoxagentStatus = await checkQuoxAgentStatus(matchedHost.id)
    if (quoxagentStatus.installed && quoxagentStatus.running) {
      response += `\n**QuoxAgent Status:** Installed and running\n`
      if (quoxagentStatus.version) response += `**QuoxAgent Version:** ${quoxagentStatus.version}\n`
    } else if (quoxagentStatus.installed) {
      response += `\n**QuoxAgent Status:** Installed but not running\n`
    } else {
      response += `\n**QuoxAgent Status:** Not installed\n`
    }
  } catch (err) {
    response += `\n**QuoxAgent Status:** Unable to check (${err.message})\n`
  }

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'host',
    metadata: { host: matchedHost.id }
  }
}

/**
 * Handler: Get agent information
 */
async function getAgentInfoHandler(match, query, context) {
  const { currentAssistant } = context
  const agentName = (match[1] || match[2])?.trim().toUpperCase()

  if (!agentName) {
    return {
      handled: true,
      response: formatAgentResponse(currentAssistant,
        'Which agent would you like to know about? Try: "what can WARDEN do"'),
      type: 'info'
    }
  }

  // Get all assistants
  const allAssistants = listAssistants()

  // Find matching agent (by name or ID)
  const matchedAgent = allAssistants.find(a =>
    a.id?.toUpperCase() === agentName ||
    a.identity?.name?.toUpperCase() === agentName ||
    a.name?.toUpperCase() === agentName
  )

  if (!matchedAgent) {
    return {
      handled: true,
      response: formatAgentResponse(currentAssistant,
        `I don't have an agent called "${agentName}".\n\nAvailable agents: ${allAssistants.map(a => a.identity?.name || a.name || a.id).join(', ')}`),
      type: 'info'
    }
  }

  const name = matchedAgent.identity?.name || matchedAgent.name || matchedAgent.id
  const tagline = matchedAgent.identity?.tagline || matchedAgent.specialty || ''
  const level = matchedAgent.hierarchy?.level ?? matchedAgent.level ?? 0
  const capabilities = matchedAgent.capabilities || matchedAgent.skills || []
  const domains = matchedAgent.memory_domains || []
  const reports_to = matchedAgent.hierarchy?.reports_to || matchedAgent.reports_to

  let response = `Agent: ${name}\n\n`
  response += `**Role:** ${tagline}\n`
  response += `**Level:** ${level} (${level === 0 ? 'Orchestrator' : level === 1 ? 'Manager' : 'Specialist'})\n`

  if (reports_to) {
    response += `**Reports To:** ${reports_to.toUpperCase()}\n`
  }

  if (capabilities.length > 0) {
    response += `\n**Capabilities:**\n`
    for (const cap of capabilities.slice(0, 8)) {
      response += `- ${cap}\n`
    }
  }

  if (domains.length > 0) {
    response += `\n**Memory Domains:** ${domains.join(', ')}\n`
  }

  response += `\n*Use the assistant selector to switch to ${name}.*`

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'agent',
    metadata: { agent: name }
  }
}

/**
 * Handler: Greeting
 */
async function greetingHandler(match, query, context) {
  const { currentAssistant } = context
  const hour = new Date().getHours()
  let timeOfDay = 'day'
  if (hour < 12) timeOfDay = 'morning'
  else if (hour < 17) timeOfDay = 'afternoon'
  else timeOfDay = 'evening'

  const greetings = [
    `Good ${timeOfDay}. How can I assist you today?`,
    `Hello. Quox systems are online and ready to assist.`,
    `Greetings. All systems operational. What would you like to do?`,
    `Good ${timeOfDay}. At your service.`
  ]

  const response = greetings[Math.floor(Math.random() * greetings.length)]

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'greeting'
  }
}

/**
 * Handler: Time query
 */
async function timeQueryHandler(match, query, context) {
  const { currentAssistant } = context
  const now = new Date()
  const time = now.toLocaleTimeString()
  const date = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant,
      `It's currently **${time}** on ${date}.`),
    type: 'info'
  }
}

/**
 * Handler: Help query
 */
async function helpQueryHandler(match, query, context) {
  const { currentAssistant } = context

  // Create structured help template
  const template = createHelpTemplate([
    {
      title: 'Infrastructure',
      commands: [
        { command: 'quoxagent status', description: 'Check fleet status' },
        { command: 'list hosts', description: 'Show all known hosts' },
        { command: 'list agents', description: 'Show connected QuoxAgent agents' },
        { command: 'install quoxagent on <host>', description: 'Deploy QuoxAgent agent' },
        { command: 'check <host>', description: 'Run health check' },
        { command: 'tell me about <host>', description: 'Get host details' }
      ]
    },
    {
      title: 'Agents & Assistants',
      commands: [
        { command: 'list assistants', description: 'Show all Quox agents' },
        { command: 'what can <AGENT> do', description: 'Get agent info' }
      ]
    },
    {
      title: 'Memory & Settings',
      commands: [
        { command: 'what do you know about <topic>', description: 'Search memory' },
        { command: 'my preferences', description: 'Show your settings' },
        { command: 'router stats', description: 'Show bypass statistics' }
      ]
    },
    {
      title: 'Files & ARCHIVIST',
      commands: [
        { command: 'list files', description: 'Show your files' },
        { command: 'what can you do with files', description: 'File capabilities' },
        { command: 'summarize <file>', description: 'Summarize a document' },
        { command: 'compare <file1> and <file2>', description: 'Compare files' },
        { command: 'what is archivist', description: 'About ARCHIVIST agent' }
      ]
    },
    {
      title: 'General',
      commands: [
        { command: 'what is quox', description: 'About Quox' },
        { command: 'what can you do', description: 'List capabilities' },
        { command: 'what time is it', description: 'Current time' }
      ]
    }
  ])

  let response = template.toMarkdown()
  response += `*For complex queries, just ask naturally - Claude will help.*`

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'help',
    template
  }
}

// ============================================
// FILE OPERATION HANDLERS
// ============================================

/**
 * Handler: File capabilities explanation
 */
async function fileCapabilitiesHandler(match, query, context) {
  const { currentAssistant } = context

  // Try to get current file count
  let fileInfo = ''
  try {
    const { listFiles, getStorageUsage, listFolders, formatFileSize } = await import('./fileStorage.js')
    const allFiles = listFiles({})
    const folders = listFolders()
    const usage = getStorageUsage()

    if (allFiles.length > 0) {
      fileInfo = `
### Your Current Files
You have **${allFiles.length} file${allFiles.length !== 1 ? 's' : ''}** across **${folders.length} folder${folders.length !== 1 ? 's' : ''}**.
- Storage used: ${formatFileSize(usage.used)} / ${formatFileSize(usage.limit)}

Recent files: ${allFiles.slice(0, 5).map(f => f.name).join(', ')}${allFiles.length > 5 ? '...' : ''}

*Go to **Files** in the sidebar to browse and manage them.*
`
    } else {
      fileInfo = `
### Your Files
You don't have any files uploaded yet. Go to **Files** in the sidebar to upload documents, images, or other files.
`
    }
  } catch (e) {
    fileInfo = '\n*Go to **Files** in the sidebar to view your files.*\n'
  }

  const response = `## Quox File Management
${fileInfo}
### Capabilities
- **Upload** - Drag & drop or click to upload files
- **Organize** - Create folders, move/rename files
- **Preview** - View images, documents, JSON, markdown
- **Search** - Find files by name or content

### ARCHIVIST Agent (Premium)
The **ARCHIVIST** agent can analyze your documents:
- **Summarize** - Generate summaries with key points
- **Compare** - Find differences between files
- **Extract** - Pull structured data to JSON
- **Analyze** - Deep content analysis
- **Quiz** - Generate questions from content

### Folder Chat (Premium)
Chat with files in a folder - get answers with citations:
- Select a folder and click "Chat with folder"
- Ask questions, get answers grounded in your files
- Every claim cites the source file`

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'info'
  }
}

/**
 * Handler: Summarize file
 */
async function summarizeFileHandler(match, query, context) {
  const { currentAssistant } = context
  const fileName = match[1]?.trim()

  const response = `To summarize "${fileName}":

1. Go to **Files** in the sidebar
2. Upload the file if not already there
3. Select the file (click checkbox)
4. Use the **ARCHIVIST Skills** panel that appears
5. Click **Summarize**

*Note: File summarization requires the Advanced Memory plugin for full AI analysis.*

Would you like me to explain more about ARCHIVIST capabilities?`

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'info'
  }
}

/**
 * Handler: Compare files
 */
async function compareFilesHandler(match, query, context) {
  const { currentAssistant } = context
  const file1 = match[1]?.trim()
  const file2 = match[2]?.trim()

  const response = `To compare "${file1}" and "${file2}":

1. Go to **Files** in the sidebar
2. Upload both files if not already there
3. Select both files (click their checkboxes)
4. The **ARCHIVIST Skills** panel will show "Compare"
5. Click **Compare** to see similarities and differences

The comparison includes:
- Semantic overlap percentage
- Key differences
- Potential contradictions
- Which is more comprehensive

*Requires Advanced Memory plugin for full AI comparison.*`

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'info'
  }
}

/**
 * Handler: List files
 */
async function listFilesHandler(match, query, context) {
  const { currentAssistant } = context
  const folderPath = match[1]?.trim() || '/'

  // Try to get actual file list
  let fileInfo = ''
  try {
    // Dynamic import to avoid circular dependency
    const { listFiles, getStorageUsage } = await import('./fileStorage.js')
    const files = listFiles({ folderPath })
    const storage = getStorageUsage()

    if (files.length === 0) {
      fileInfo = `You have no files${folderPath !== '/' ? ` in "${folderPath}"` : ''} yet.`
    } else {
      fileInfo = `You have **${files.length}** file(s)${folderPath !== '/' ? ` in "${folderPath}"` : ''}:\n\n`

      const recent = files.slice(0, 10)
      for (const file of recent) {
        const icon = file.category === 'image' ? '🖼️' : '📄'
        fileInfo += `- ${icon} **${file.name}**\n`
      }

      if (files.length > 10) {
        fileInfo += `- *...and ${files.length - 10} more*\n`
      }

      fileInfo += `\n*Storage: ${storage.formatted?.used || '0 B'} / ${storage.formatted?.max || '50 MB'}*`
    }
  } catch (err) {
    fileInfo = 'Navigate to **Files** in the sidebar to see your files.'
  }

  const response = `## Your Files

${fileInfo}

*Go to **Files** in the sidebar to manage, upload, or organize.*`

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'info'
  }
}

/**
 * Handler: ARCHIVIST agent info
 */
async function archivistInfoHandler(match, query, context) {
  const { currentAssistant } = context

  const response = `## ARCHIVIST Agent

**ARCHIVIST** is Quox's document intelligence specialist.

### Capabilities
| Skill | Description |
|-------|-------------|
| **Summarize** | Generate summaries with key points |
| **Compare** | Find differences between files |
| **Extract** | Pull structured data to JSON |
| **Analyze** | Deep content analysis |
| **Find Contradictions** | Cross-file consistency check |
| **Generate Quiz** | Create Q&A from content |

### Hierarchy
- **Reports to**: PRISM (Analysis & Classification)
- **Level**: 2 (Specialist)
- **Color**: Purple (#8b5cf6)

### How to Use
1. Go to **Files** in the sidebar
2. Select one or more files
3. The **ARCHIVIST Skills** panel appears
4. Choose a skill to analyze your documents

*Premium feature - requires Advanced Memory plugin.*`

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'info'
  }
}

/**
 * Handler: Chat with folder
 */
async function chatWithFolderHandler(match, query, context) {
  const { currentAssistant } = context
  const folderName = (match[1] || match[2])?.trim()

  const response = `To chat with files in "${folderName}":

1. Go to **Files** in the sidebar
2. Navigate to the folder (or create it)
3. Upload relevant files to that folder
4. Click the **Chat** icon next to the folder, or right-click and select "Chat with folder"

### Folder Chat Features
- Ask questions about your files
- Get answers with **citations** linking to source files
- Toggle "Include subfolders" for broader context
- Set custom instructions per folder

*Example questions:*
- "What are the main topics in these files?"
- "Find information about X"
- "Summarize the key points"

*Premium features require Advanced Memory plugin.*`

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'info'
  }
}

/**
 * Handler: List Quox assistants
 */
async function listAssistantsHandler(match, query, context) {
  const { currentAssistant } = context

  const allAssistants = listAssistants({ sortBy: 'level' })

  let response = `Quox Agent Hierarchy\n\n`

  // Group by level
  const byLevel = {
    0: [],
    1: [],
    2: []
  }

  for (const a of allAssistants) {
    const level = a.hierarchy?.level ?? a.level ?? 0
    if (!byLevel[level]) byLevel[level] = []
    byLevel[level].push(a)
  }

  const levelNames = {
    0: 'Orchestrator',
    1: 'Managers',
    2: 'Specialists'
  }

  for (const [level, levelAssistants] of Object.entries(byLevel)) {
    if (levelAssistants.length === 0) continue

    response += `**${levelNames[level]} (Level ${level}):**\n`

    for (const a of levelAssistants) {
      const name = a.identity?.name || a.name
      const tagline = a.identity?.tagline || a.specialty || ''
      const color = a.identity?.color?.primary || a.color || '#ffffff'
      response += `- **${name}**: ${tagline}\n`
    }
    response += '\n'
  }

  response += `*Switch assistants using the selector in the header.*`

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'info',
    metadata: { count: allAssistants.length }
  }
}

// ===== AGENTIC TEAMS HANDLERS =====

async function listTeamsHandler(match, query, context) {
  const { currentAssistant } = context
  const teams = getBuiltInTeams()
  const teamIds = Object.keys(teams)

  if (teamIds.length === 0) {
    return {
      handled: true,
      response: formatAgentResponse(currentAssistant, 'No agentic teams are currently configured.'),
      type: 'info'
    }
  }

  let response = `**Agentic Teams** (${teamIds.length} available)\n\n`

  for (const id of teamIds) {
    const t = teams[id]
    const agentCount = getTeamAgentCount(id)
    const orchestrator = t.orchestrator?.agentId || 'unknown'
    response += `- **${t.displayName}** (\`${id}\`) — ${agentCount} agents, orchestrator: ${orchestrator}\n`
    if (t.description) response += `  ${t.description.slice(0, 120)}\n`
  }

  response += `\n*View teams at **AI Studio > Agentic Teams** or say "tell me about team quoxcore".*`

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'info',
    metadata: { count: teamIds.length }
  }
}

async function teamInfoHandler(match, query, context) {
  const { currentAssistant } = context
  const teamName = (match[1] || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '')

  const team = getBuiltInTeam(teamName)
  if (!team) {
    const allIds = Object.keys(getBuiltInTeams())
    return {
      handled: true,
      response: formatAgentResponse(currentAssistant,
        `Team "${teamName}" not found. Available teams: ${allIds.map(id => `\`${id}\``).join(', ')}`),
      type: 'info'
    }
  }

  const agentCount = getTeamAgentCount(teamName)
  const roles = {}
  for (const m of team.members || []) {
    roles[m.role] = (roles[m.role] || 0) + 1
  }

  let response = `**${team.displayName}** (\`${teamName}\`)\n\n`
  if (team.description) response += `${team.description}\n\n`
  response += `**Orchestrator:** ${team.orchestrator.agentId}\n`
  response += `**Members:** ${agentCount} agents`
  if (Object.keys(roles).length > 0) {
    response += ` (${Object.entries(roles).map(([r, c]) => `${c} ${r}${c > 1 ? 's' : ''}`).join(', ')})`
  }
  response += '\n'

  if (team.policies) {
    response += `**Budget:** ${(team.policies.maxBudgetTokens || 0).toLocaleString()} tokens, ${team.policies.maxBudgetToolCalls || 0} tool calls\n`
  }

  const memberList = (team.members || []).map(m => `\`${m.agentId}\` (${m.role})`).join(', ')
  if (memberList) response += `\n**Team members:** ${memberList}\n`

  response += `\n*Open this team at **AI Studio > Agentic Teams > ${team.displayName}**.*`

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'info',
    metadata: { teamId: teamName, agentCount }
  }
}

async function createTeamGuideHandler(match, query, context) {
  const { currentAssistant } = context

  let response = `**Creating an Agentic Team**\n\n`
  response += `To create a new team, go to **AI Studio > Agentic Teams** and click **Create Team**.\n\n`
  response += `You'll need:\n`
  response += `1. A **team name** and description\n`
  response += `2. An **orchestrator** agent to coordinate the team\n`
  response += `3. One or more **member** agents with assigned roles\n`
  response += `4. **Policies** for budget limits and execution rules\n\n`
  response += `Or install a pre-built team from the **Team Packs** section at the top of the page.`

  return {
    handled: true,
    response: formatAgentResponse(currentAssistant, response),
    type: 'info'
  }
}

/**
 * Main router function with confidence-based cascading evaluation
 * @param {string} query - The user query to route
 * @param {object} context - Context including currentAssistant, sessionId, etc.
 * @returns {Promise<{handled: boolean, response?: string, type?: string, metadata?: object}>}
 */
export async function routeQuery(query, context = {}) {
  const trimmedQuery = query.trim()
  const config = getRouterConfig()
  const corr = context.corr || null
  const routeStartTime = Date.now()

  if (!trimmedQuery) {
    return { handled: false, reason: 'empty-query' }
  }

  // ========================================================================
  // Forced Intent - User selected from clarification options
  // ========================================================================
  if (context.forcedIntent) {
    console.log(`[QuoxRouter] Forced intent: ${context.forcedIntent}, query: ${trimmedQuery.slice(0, 80)}`)
    const forcedClassification = { intent: context.forcedIntent, confidence: 1.0, layer: 'forced' }
    return executeHandler(forcedClassification, trimmedQuery, query, context)
  }

  // ========================================================================
  // Escalation Detection - Check if user is dissatisfied with last routed response
  // ========================================================================
  const escalationCheck = checkEscalation(trimmedQuery)
  if (escalationCheck.isEscalation) {
    console.log(`[QuoxRouter] Escalation detected, bypassing router for Claude`)

    // AOCL: L2 bypass - user escalated
    if (corr) {
      storeEnvelope(createLayerEvent('L2', 'bypass', {
        handled: false,
        reason: 'user-escalation',
        originalQuery: escalationCheck.originalQuery,
        originalPattern: escalationCheck.originalPattern,
        duration_ms: Date.now() - routeStartTime
      }, corr)).catch(err => console.warn('[AOCL] L2 bypass:', err))
    }

    return {
      handled: false,
      reason: 'user-escalation',
      escalation: {
        detected: true,
        originalQuery: escalationCheck.originalQuery,
        originalPattern: escalationCheck.originalPattern,
        suggestion: `User expressed dissatisfaction with previous routed response. Original query was: "${escalationCheck.originalQuery}"`
      }
    }
  }

  // AOCL: L2 Route layer start
  if (corr) {
    storeEnvelope(createLayerEvent('L2', 'start', {
      query: trimmedQuery.slice(0, 100),
      hasSemanticLayer: await isSemanticAvailable()
    }, corr)).catch(err => console.warn('[AOCL] L2 start:', err))
  }

  // ========================================================================
  // Layer 1: Regex Classification
  // ========================================================================
  const classifier = getRegexClassifier()
  const regexResult = await classifier.classify(trimmedQuery, context)

  console.log(`[QuoxRouter] Regex: intent=${regexResult.intent}, confidence=${regexResult.confidence?.toFixed(2)}`)

  // HIGH CONFIDENCE from regex (>0.9) - Route immediately
  if (regexResult.intent && regexResult.confidence >= config.thresholds.highConfidence) {
    console.log(`[QuoxRouter] High-confidence regex match, executing handler`)
    // AOCL: L2 complete - routed by regex
    if (corr) {
      storeEnvelope(createLayerEvent('L2', 'complete', {
        handled: true,
        intent: regexResult.intent,
        confidence: regexResult.confidence,
        layer: 'regex',
        duration_ms: Date.now() - routeStartTime
      }, corr)).catch(err => console.warn('[AOCL] L2 complete:', err))
    }
    return executeHandler(regexResult, trimmedQuery, query, context)
  }

  // ========================================================================
  // Layer 2: Semantic Classification (for uncertain regex results)
  // ========================================================================
  let semanticResult = null
  let finalClassification = regexResult

  // Try semantic layer if regex is uncertain or no match
  const shouldTrySemantic = (
    !regexResult.intent ||
    regexResult.confidence < config.thresholds.confidence ||
    calculateAmbiguity(regexResult) > config.thresholds.ambiguity
  )

  if (shouldTrySemantic && await isSemanticAvailable()) {
    try {
      semanticResult = await classifySemantic(trimmedQuery, context)
      console.log(`[QuoxRouter] Semantic: intent=${semanticResult.intent}, confidence=${semanticResult.confidence?.toFixed(2)}`)

      // Merge results from both layers
      if (semanticResult.intent) {
        const results = [regexResult, semanticResult].filter(r => r.intent)
        if (results.length > 0) {
          finalClassification = mergeResults(results)
          console.log(`[QuoxRouter] Merged: intent=${finalClassification.intent}, confidence=${finalClassification.confidence?.toFixed(2)}`)
        }
      }
    } catch (err) {
      console.warn(`[QuoxRouter] Semantic layer error:`, err.message)
      // Continue with regex result only
    }
  }

  // ========================================================================
  // Make routing decision based on final classification
  // ========================================================================

  // No match from any layer - try agent delegation
  if (!finalClassification.intent || finalClassification.confidence === 0) {
    // ========================================================================
    // NEW: Agent Delegation - Try to delegate to a specialized agent
    // Skip delegation when a specialist agent is already explicitly selected
    // (e.g., quoxcode in terminal chat) — the caller chose this agent intentionally.
    // ========================================================================
    const explicitAgent = context.currentAssistant
    const skipDelegation = explicitAgent && explicitAgent !== 'quox'
    if (DELEGATION_CONFIG.enabled && !skipDelegation) {
      // Ensure custom agents are cached before scoring
      await refreshCustomAgents()
      const delegationCheck = shouldDelegate(trimmedQuery)

      if (delegationCheck.shouldDelegate) {
        console.log(`[QuoxRouter] No pattern match, delegating to ${delegationCheck.agentId} (score: ${delegationCheck.score})`)

        // AOCL: L2 delegation event
        if (corr) {
          storeEnvelope(createLayerEvent('L2', 'complete', {
            handled: true,
            reason: 'agent-delegation',
            delegatedTo: delegationCheck.agentId,
            delegationScore: delegationCheck.score,
            duration_ms: Date.now() - routeStartTime
          }, corr)).catch(err => console.warn('[AOCL] L2 delegation:', err))
        }

        try {
          const delegationResult = await delegateToAgent(trimmedQuery, {
            sessionId: context.sessionId,
            voiceMode: context.voiceMode,
            memoryContext: context.memoryContext || ''
          })

          if (delegationResult.delegated && delegationResult.response) {
            routerTelemetry.log('match', trimmedQuery, `delegation:${delegationResult.agentId}`)

            return {
              handled: true,
              response: delegationResult.response,
              type: 'agent-delegation',
              agent: delegationResult.agentName,
              agentId: delegationResult.agentId,
              delegationScore: delegationResult.score,
              handledBy: 'agent-delegator',
              canEscalate: true,
              escalateQuery: trimmedQuery
            }
          }

          // GTM-A1/B1: an agent was selected and the call to it failed. Falling
          // through to the bypass here is what rendered a permanently empty
          // CommanderQ bubble: the user asked a question, saw a thinking
          // indicator, and got silence with no error anywhere on screen.
          // A transport failure is a result the user is entitled to see.
          // Only 'api-error' short-circuits; 'no-suitable-agent' and
          // 'agent-not-found' still fall through to normal handling.
          if (delegationResult.reason === 'api-error') {
            console.warn(
              `[QuoxRouter] Delegation to ${delegationResult.agentId} failed: ${delegationResult.error}`
            )
            return {
              handled: true,
              response: delegationResult.userMessage
                || `${delegationResult.agentName || delegationResult.agentId} could not answer: ${delegationResult.error || 'the request failed'}`,
              type: 'agent-delegation-error',
              isError: true,
              agent: delegationResult.agentName || delegationResult.agentId,
              agentId: delegationResult.agentId,
              handledBy: 'agent-delegator',
              error: delegationResult.error,
              canEscalate: true,
              escalateQuery: trimmedQuery
            }
          }
        } catch (err) {
          console.warn(`[QuoxRouter] Delegation failed:`, err.message)
          // Fall through to bypass
        }
      }
    }

    // No delegation - original bypass behavior
    routerTelemetry.log('miss', trimmedQuery)
    // AOCL: L2 bypass - no pattern match
    if (corr) {
      storeEnvelope(createLayerEvent('L2', 'bypass', {
        handled: false,
        reason: 'no-pattern-match',
        duration_ms: Date.now() - routeStartTime
      }, corr)).catch(err => console.warn('[AOCL] L2 bypass:', err))
    }
    return {
      handled: false,
      reason: 'no-pattern-match',
      classification: finalClassification
    }
  }

  // Calculate ambiguity and make routing decision
  const ambiguity = calculateAmbiguity(finalClassification)
  const routingDecision = shouldRouteIntent(finalClassification.confidence, finalClassification.intent)

  console.log(`[QuoxRouter] Final decision: ${routingDecision.reason}, confidence=${finalClassification.confidence?.toFixed(2)}, ambiguity=${ambiguity.toFixed(2)}`)

  // HIGH CONFIDENCE - Route immediately
  if (routingDecision.trusted && routingDecision.reason === 'high-confidence') {
    // AOCL: L2 complete - routed by merged classification
    if (corr) {
      storeEnvelope(createLayerEvent('L2', 'complete', {
        handled: true,
        intent: finalClassification.intent,
        confidence: finalClassification.confidence,
        layer: finalClassification.layer || 'merged',
        duration_ms: Date.now() - routeStartTime
      }, corr)).catch(err => console.warn('[AOCL] L2 complete:', err))
    }
    return executeHandler(finalClassification, trimmedQuery, query, context)
  }

  // Check for ambiguity - if top two intents are too close
  if (ambiguity > config.thresholds.ambiguity && finalClassification.alternatives?.length > 0) {
    // Should we show clarification?
    if (shouldShowClarification(finalClassification.confidence, ambiguity)) {
      return generateClarificationResponse(finalClassification, trimmedQuery, context)
    }
  }

  // MEDIUM CONFIDENCE - Above threshold, route it
  if (routingDecision.trusted) {
    // AOCL: L2 complete - routed with medium confidence
    if (corr) {
      storeEnvelope(createLayerEvent('L2', 'complete', {
        handled: true,
        intent: finalClassification.intent,
        confidence: finalClassification.confidence,
        layer: finalClassification.layer || 'merged',
        reason: 'medium-confidence-trusted',
        duration_ms: Date.now() - routeStartTime
      }, corr)).catch(err => console.warn('[AOCL] L2 complete:', err))
    }
    return executeHandler(finalClassification, trimmedQuery, query, context)
  }

  // LOW CONFIDENCE - Pass to Claude
  routerTelemetry.log('miss', trimmedQuery, finalClassification.intent)
  // AOCL: L2 bypass - low confidence, escalating to LLM
  if (corr) {
    storeEnvelope(createLayerEvent('L2', 'bypass', {
      handled: false,
      intent: finalClassification.intent,
      confidence: finalClassification.confidence,
      reason: routingDecision.reason,
      escalatedToLLM: true,
      duration_ms: Date.now() - routeStartTime
    }, corr)).catch(err => console.warn('[AOCL] L2 bypass:', err))
  }
  return {
    handled: false,
    reason: routingDecision.reason,
    classification: finalClassification,
    // Include classification info so Claude can use it as a hint
    hint: {
      possibleIntent: finalClassification.intent,
      confidence: finalClassification.confidence,
      alternatives: finalClassification.alternatives,
      layers: {
        regex: regexResult.intent ? { intent: regexResult.intent, confidence: regexResult.confidence } : null,
        semantic: semanticResult?.intent ? { intent: semanticResult.intent, confidence: semanticResult.confidence } : null
      }
    }
  }
}

/**
 * Execute a handler for a classified intent
 */
async function executeHandler(classification, trimmedQuery, originalQuery, context) {
  const handler = HANDLER_MAP.get(classification.intent)

  if (!handler) {
    console.error(`[QuoxRouter] No handler for intent: ${classification.intent}`)
    return {
      handled: false,
      reason: 'no-handler'
    }
  }

  // Find the pattern to get the regex match
  const pattern = ROUTER_PATTERNS.find(p => p.name === classification.intent)
  const match = trimmedQuery.match(pattern.regex)

  if (!match) {
    // Shouldn't happen, but fallback
    console.warn(`[QuoxRouter] Pattern matched during classification but not during execution: ${classification.intent}`)
    return {
      handled: false,
      reason: 'match-inconsistency'
    }
  }

  routerTelemetry.log('match', trimmedQuery, classification.intent)

  try {
    const result = await handler(match, originalQuery, context)
    return {
      ...result,
      pattern: classification.intent,
      handledBy: 'smart-router',
      confidence: classification.confidence,
      layer: classification.layer,
      canEscalate: true,
      escalateQuery: trimmedQuery
    }
  } catch (err) {
    console.error(`[QuoxRouter] Handler error for ${classification.intent}:`, err)
    return {
      handled: true,
      response: formatAgentResponse(context.currentAssistant || 'quox',
        `Error processing request: ${err.message}`),
      type: 'error',
      pattern: classification.intent,
      handledBy: 'smart-router',
      canEscalate: true,
      escalateQuery: trimmedQuery
    }
  }
}

/**
 * Generate a clarifying question when classification is ambiguous
 */
function generateClarificationResponse(classification, query, context) {
  const { currentAssistant } = context
  const config = getRouterConfig()

  // Get top intents for clarification
  const options = [
    { intent: classification.intent, confidence: classification.confidence }
  ]

  if (classification.alternatives) {
    options.push(...classification.alternatives.slice(0, config.clarification.maxOptions - 1))
  }

  // Build clarification message
  let response = `I want to make sure I understand. Are you trying to:\n\n`

  for (let i = 0; i < options.length; i++) {
    const opt = options[i]
    const description = INTENT_DESCRIPTIONS[opt.intent] || opt.intent
    response += `**${i + 1}.** ${description}\n`
  }

  response += `\n**${options.length + 1}.** Something else (let Claude help)\n`
  response += `\n*Type a number to select, or rephrase your query.*`

  routerTelemetry.log('match', query, 'clarification')

  return {
    handled: true,
    type: 'clarification',
    response: formatAgentResponse(currentAssistant, response),
    pattern: 'clarification',
    handledBy: 'smart-router',
    canEscalate: true,
    escalateQuery: query,
    clarificationOptions: options.map((opt, i) => ({
      id: i + 1,
      intent: opt.intent,
      label: INTENT_DESCRIPTIONS[opt.intent] || opt.intent,
      confidence: opt.confidence
    })),
    originalClassification: classification
  }
}

/**
 * Check if a query might be handled by the router (without actually running handlers)
 * Now uses confidence-based classification
 * @param {string} query
 * @returns {{ canRoute: boolean, pattern?: string, description?: string, confidence?: number }}
 */
export function canRouteQuery(query) {
  const trimmedQuery = query.trim()

  if (!trimmedQuery) {
    return { canRoute: false }
  }

  // Use classifier for confidence-based check
  const classifier = getRegexClassifier()

  // Synchronous classification (classifier.classify is async but we need sync here)
  // Fall back to simple regex check for this function
  for (const pattern of ROUTER_PATTERNS) {
    if (pattern.regex.test(trimmedQuery)) {
      // Quick confidence estimate based on match coverage
      const match = trimmedQuery.match(pattern.regex)
      const coverage = match ? match[0].length / trimmedQuery.length : 0
      const estimatedConfidence = coverage > 0.8 ? 0.8 : coverage > 0.5 ? 0.6 : 0.4

      return {
        canRoute: true,
        pattern: pattern.name,
        description: pattern.description,
        confidence: estimatedConfidence
      }
    }
  }

  return {
    canRoute: false
  }
}

/**
 * Async version of canRouteQuery with full confidence scoring
 * @param {string} query
 * @returns {Promise<{ canRoute: boolean, pattern?: string, confidence?: number, classification?: Object }>}
 */
export async function canRouteQueryAsync(query) {
  const trimmedQuery = query.trim()

  if (!trimmedQuery) {
    return { canRoute: false }
  }

  const classifier = getRegexClassifier()
  const classification = await classifier.classify(trimmedQuery)

  if (!classification.intent || classification.confidence === 0) {
    return { canRoute: false }
  }

  const routingDecision = shouldRouteIntent(classification.confidence, classification.intent)

  return {
    canRoute: routingDecision.trusted,
    pattern: classification.intent,
    confidence: classification.confidence,
    reason: routingDecision.reason,
    classification
  }
}

/**
 * Get all registered patterns (for documentation/debugging)
 */
export function getPatterns() {
  return ROUTER_PATTERNS.map(p => ({
    name: p.name,
    pattern: p.regex.toString(),
    description: p.description
  }))
}

/**
 * Add a custom pattern (for extensibility)
 */
export function addPattern(name, regex, handler, description) {
  ROUTER_PATTERNS.push({
    name,
    regex,
    handler,
    description: description || `Custom pattern: ${name}`
  })
}

/**
 * Get router telemetry stats
 */
export function getRouterStats() {
  return routerTelemetry.getStats()
}

/**
 * Log an escalation event (user clicked "Ask Claude" button)
 */
export function logEscalation(query, pattern) {
  routerTelemetry.logEscalation(query, pattern)
}

/**
 * Check if a query is an escalation attempt
 * Exported for use by ChatEngine to provide context to Claude
 */
export function isEscalationQuery(query) {
  return checkEscalation(query)
}

export default {
  routeQuery,
  canRouteQuery,
  canRouteQueryAsync,
  getPatterns,
  addPattern,
  getRouterStats,
  logEscalation,
  isEscalationQuery
}
