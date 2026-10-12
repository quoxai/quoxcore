// Pre-recorded ElevenLabs acknowledgment audio clips
// Each agent has their own voice, style, and personality

// Agent-specific acknowledgments organized by personality
const AGENT_ACKS = {
  // QuoxCORE - Warm, sophisticated British butler
  quox: {
    voice: 'jarvis',
    general: [
      { id: 'quox-1', text: "Very good, Sir." },
      { id: 'quox-2', text: "At once." },
      { id: 'quox-3', text: "Consider it handled." },
      { id: 'quox-4', text: "Right away, Sir." },
      { id: 'quox-5', text: "Allow me." },
      { id: 'quox-6', text: "Certainly." },
      { id: 'quox-7', text: "I shall attend to it." },
      { id: 'quox-8', text: "Leave it with me." },
      { id: 'quox-9', text: "Of course." },
      { id: 'quox-10', text: "As you wish." },
    ],
    system: [
      { id: 'quox-s1', text: "Coordinating with the systems now." },
      { id: 'quox-s2', text: "I'll orchestrate that for you." },
      { id: 'quox-s3', text: "Let me consult the infrastructure." },
      { id: 'quox-s4', text: "Bringing up the status now." },
      { id: 'quox-s5', text: "Running diagnostics, Sir." },
    ]
  },

  // WARDEN - Calm, measured, security-focused
  sentinel: {
    voice: 'hal',
    general: [
      { id: 'sentinel-1', text: "Acknowledged. Scanning." },
      { id: 'sentinel-2', text: "Security check initiated." },
      { id: 'sentinel-3', text: "Understood. Analyzing threat surface." },
      { id: 'sentinel-4', text: "Monitoring systems." },
      { id: 'sentinel-5', text: "Initiating security sweep." },
      { id: 'sentinel-6', text: "Perimeter check in progress." },
      { id: 'sentinel-7', text: "Running security protocols." },
      { id: 'sentinel-8', text: "Affirmative. Scanning." },
      { id: 'sentinel-9', text: "Security analysis underway." },
      { id: 'sentinel-10', text: "I am checking the logs now." },
    ],
    system: [
      { id: 'sentinel-s1', text: "Checking authentication events." },
      { id: 'sentinel-s2', text: "Reviewing firewall logs." },
      { id: 'sentinel-s3', text: "Analyzing access patterns." },
      { id: 'sentinel-s4', text: "Scanning for anomalies." },
      { id: 'sentinel-s5', text: "Running vulnerability assessment." },
    ]
  },

  // CIPHER - Edgy, direct, cyberpunk tech slang
  cipher: {
    voice: 'cyberpunk',
    general: [
      { id: 'cipher-1', text: "On it, choom." },
      { id: 'cipher-2', text: "Jacking in now." },
      { id: 'cipher-3', text: "Got your signal." },
      { id: 'cipher-4', text: "Running the trace." },
      { id: 'cipher-5', text: "Copy that. Executing." },
      { id: 'cipher-6', text: "Pinging the net." },
      { id: 'cipher-7', text: "Scanning the grid." },
      { id: 'cipher-8', text: "Network sweep incoming." },
      { id: 'cipher-9', text: "Locked and loaded." },
      { id: 'cipher-10', text: "Delta acknowledged." },
    ],
    system: [
      { id: 'cipher-s1', text: "Checking the backbone." },
      { id: 'cipher-s2', text: "Running packet analysis." },
      { id: 'cipher-s3', text: "Scanning all ports." },
      { id: 'cipher-s4', text: "Tracing the route." },
      { id: 'cipher-s5', text: "Mapping the network topology." },
    ]
  },

  // DAEDALUS - Cool, confident, minimal words
  nova: {
    voice: 'trinity',
    general: [
      { id: 'nova-1', text: "Done." },
      { id: 'nova-2', text: "Executing." },
      { id: 'nova-3', text: "On it." },
      { id: 'nova-4', text: "Deploying." },
      { id: 'nova-5', text: "Running." },
      { id: 'nova-6', text: "Initiated." },
      { id: 'nova-7', text: "In progress." },
      { id: 'nova-8', text: "Starting now." },
      { id: 'nova-9', text: "Pipeline triggered." },
      { id: 'nova-10', text: "Automation engaged." },
    ],
    system: [
      { id: 'nova-s1', text: "Containers spinning up." },
      { id: 'nova-s2', text: "Checking deployments." },
      { id: 'nova-s3', text: "CI/CD status loading." },
      { id: 'nova-s4', text: "Build queued." },
      { id: 'nova-s5', text: "Infrastructure scan running." },
    ]
  },

  // PRISM - Analytical, dual perspective
  prism: {
    voice: 'trinity',
    general: [
      { id: 'prism-1', text: "Analyzing both angles." },
      { id: 'prism-2', text: "Processing the data." },
      { id: 'prism-3', text: "Let me cross-reference that." },
      { id: 'prism-4', text: "Running analysis." },
      { id: 'prism-5', text: "Validating the request." },
      { id: 'prism-6', text: "Classification in progress." },
      { id: 'prism-7', text: "Examining the variables." },
      { id: 'prism-8', text: "Considering all factors." },
      { id: 'prism-9', text: "Synthesizing information." },
      { id: 'prism-10', text: "Dual analysis initiated." },
    ],
    system: [
      { id: 'prism-s1', text: "Parsing the logs now." },
      { id: 'prism-s2', text: "Cross-checking system data." },
      { id: 'prism-s3', text: "Running pattern recognition." },
      { id: 'prism-s4', text: "Correlating events." },
      { id: 'prism-s5', text: "Summarizing findings." },
    ]
  },

  // HYPERION - Strong, dependable, carries the weight
  atlas: {
    voice: 'jarvis',
    general: [
      { id: 'atlas-1', text: "Engaging the cluster." },
      { id: 'atlas-2', text: "Virtual machines responding." },
      { id: 'atlas-3', text: "Cluster operations underway." },
      { id: 'atlas-4', text: "Lifting the load now." },
      { id: 'atlas-5', text: "Hypervisor engaged." },
      { id: 'atlas-6', text: "Resources allocated." },
      { id: 'atlas-7', text: "Standing by for VM ops." },
      { id: 'atlas-8', text: "Proxmox cluster responding." },
      { id: 'atlas-9', text: "Migration pathways clear." },
      { id: 'atlas-10', text: "Holding the infrastructure steady." },
    ],
    system: [
      { id: 'atlas-s1', text: "Querying all Proxmox nodes." },
      { id: 'atlas-s2', text: "Checking VM status across cluster." },
      { id: 'atlas-s3', text: "Gathering snapshot data." },
      { id: 'atlas-s4', text: "Checking storage pools." },
      { id: 'atlas-s5', text: "Cluster quorum verified." },
    ]
  },

  // METRICS - Data-driven, numerical precision
  metrics: {
    voice: 'hal',
    general: [
      { id: 'metrics-1', text: "Querying Prometheus." },
      { id: 'metrics-2', text: "Gathering metrics." },
      { id: 'metrics-3', text: "Time series loading." },
      { id: 'metrics-4', text: "Aggregating data points." },
      { id: 'metrics-5', text: "Running PromQL query." },
      { id: 'metrics-6', text: "Metrics pipeline active." },
      { id: 'metrics-7', text: "Scraping targets now." },
      { id: 'metrics-8', text: "Calculating aggregates." },
      { id: 'metrics-9', text: "Alert states loading." },
      { id: 'metrics-10', text: "Numerical analysis in progress." },
    ],
    system: [
      { id: 'metrics-s1', text: "Checking all scrape targets." },
      { id: 'metrics-s2', text: "Loading CPU and memory data." },
      { id: 'metrics-s3', text: "Fetching disk I/O metrics." },
      { id: 'metrics-s4', text: "Querying alert manager." },
      { id: 'metrics-s5', text: "Analyzing time series trends." },
    ]
  },

  // INSIGHT - Visualization focused, observant
  insight: {
    voice: 'jarvis',
    general: [
      { id: 'insight-1', text: "Visualizing the data." },
      { id: 'insight-2', text: "Loading dashboards." },
      { id: 'insight-3', text: "Rendering the view." },
      { id: 'insight-4', text: "Preparing the visualization." },
      { id: 'insight-5', text: "Grafana responding." },
      { id: 'insight-6', text: "Charts generating." },
      { id: 'insight-7', text: "Panels refreshing." },
      { id: 'insight-8', text: "Insight extraction underway." },
      { id: 'insight-9', text: "Dashboard query running." },
      { id: 'insight-10', text: "Observing patterns now." },
    ],
    system: [
      { id: 'insight-s1', text: "Fetching all dashboard panels." },
      { id: 'insight-s2', text: "Checking Grafana alerts." },
      { id: 'insight-s3', text: "Loading visualization data." },
      { id: 'insight-s4', text: "Rendering trend graphs." },
      { id: 'insight-s5', text: "Preparing the data story." },
    ]
  },

  // SCHOLAR - Knowledgeable, research-oriented
  scholar: {
    voice: 'hal',
    general: [
      { id: 'scholar-1', text: "Consulting the knowledge base." },
      { id: 'scholar-2', text: "Researching now." },
      { id: 'scholar-3', text: "Seeking the answer." },
      { id: 'scholar-4', text: "Searching documentation." },
      { id: 'scholar-5', text: "Knowledge query initiated." },
      { id: 'scholar-6', text: "Let me find that for you." },
      { id: 'scholar-7', text: "Accessing CVE database." },
      { id: 'scholar-8', text: "Research in progress." },
      { id: 'scholar-9', text: "Gathering references." },
      { id: 'scholar-10', text: "Wisdom retrieval underway." },
    ],
    system: [
      { id: 'scholar-s1', text: "Searching CVE records." },
      { id: 'scholar-s2', text: "Checking security advisories." },
      { id: 'scholar-s3', text: "Retrieving troubleshooting guides." },
      { id: 'scholar-s4', text: "Consulting best practices." },
      { id: 'scholar-s5', text: "Cross-referencing documentation." },
    ]
  },

  // VIGIL - Watchful, uptime focused
  beacon: {
    voice: 'jarvis',
    general: [
      { id: 'beacon-1', text: "Checking service status." },
      { id: 'beacon-2', text: "Uptime report loading." },
      { id: 'beacon-3', text: "Monitoring pulse active." },
      { id: 'beacon-4', text: "Status lights checking." },
      { id: 'beacon-5', text: "Availability scan running." },
      { id: 'beacon-6', text: "Heartbeat detection active." },
      { id: 'beacon-7', text: "SLA metrics loading." },
      { id: 'beacon-8', text: "Service health incoming." },
      { id: 'beacon-9', text: "Vigil sweep initiated." },
      { id: 'beacon-10', text: "Monitoring all endpoints." },
    ],
    system: [
      { id: 'beacon-s1', text: "Pinging all services." },
      { id: 'beacon-s2', text: "Checking Uptime Kuma." },
      { id: 'beacon-s3', text: "Calculating availability percentages." },
      { id: 'beacon-s4', text: "Loading incident history." },
      { id: 'beacon-s5', text: "Service response times loading." },
    ]
  },

  // VULCAN - Code-savvy, clever
  forge: {
    voice: 'cyberpunk',
    general: [
      { id: 'forge-1', text: "Compiling solution." },
      { id: 'forge-2', text: "Code generation initiated." },
      { id: 'forge-3', text: "Script loading." },
      { id: 'forge-4', text: "Syntax check running." },
      { id: 'forge-5', text: "Function crafting." },
      { id: 'forge-6', text: "Logic assembling." },
      { id: 'forge-7', text: "Algorithm processing." },
      { id: 'forge-8', text: "Template rendering." },
      { id: 'forge-9', text: "Building the solution." },
      { id: 'forge-10', text: "Code synthesis underway." },
    ],
    system: [
      { id: 'forge-s1', text: "Generating bash script." },
      { id: 'forge-s2', text: "Writing config template." },
      { id: 'forge-s3', text: "Crafting automation code." },
      { id: 'forge-s4', text: "Optimizing the logic." },
      { id: 'forge-s5', text: "Linting the output." },
    ]
  }
}

// Fallback generic acknowledgments (used if agent-specific not available)
const FALLBACK_ACKS = [
  { id: 'fallback-1', text: "On it." },
  { id: 'fallback-2', text: "One moment." },
  { id: 'fallback-3', text: "Processing." },
  { id: 'fallback-4', text: "Working on it." },
  { id: 'fallback-5', text: "Got it." },
]

// Prepared acknowledgments storage (text-only, no audio preloading needed)
let preparedAgentAcks = {}
let isPreloaded = false

/**
 * Get the audio path for an acknowledgment (for future use with pre-recorded files)
 */
const getAudioPath = (agentId, ackId) => {
  return `/audio/agents/${agentId}/${ackId}.mp3`
}

/**
 * Prepare all acknowledgments for all agents
 * This just organizes the text - audio is played on-demand via TTS
 */
export const preloadAcknowledgments = () => {
  if (isPreloaded) return

  let totalCount = 0

  Object.entries(AGENT_ACKS).forEach(([agentId, agentData]) => {
    preparedAgentAcks[agentId] = {
      voice: agentData.voice,
      general: [],
      system: []
    }

    // Prepare general acks
    agentData.general.forEach(ack => {
      preparedAgentAcks[agentId].general.push({ text: ack.text, id: ack.id })
      totalCount++
    })

    // Prepare system acks
    agentData.system.forEach(ack => {
      preparedAgentAcks[agentId].system.push({ text: ack.text, id: ack.id })
      totalCount++
    })
  })

  // Prepare fallbacks
  preparedAgentAcks['fallback'] = {
    general: FALLBACK_ACKS.map(ack => {
      totalCount++
      return { text: ack.text, id: ack.id }
    }),
    system: []
  }

  isPreloaded = true
  console.log(`[ACK] Prepared ${totalCount} agent-specific acknowledgments`)
}

/**
 * Detect if query is system/infrastructure related
 */
const isSystemQuery = (query) => {
  if (!query) return false
  const lower = query.toLowerCase()
  const systemKeywords = [
    'status', 'check', 'health', 'disk', 'cpu', 'memory',
    'host', 'server', 'docker', 'proxmox', 'network',
    'scan', 'run', 'execute', 'query', 'show', 'list',
    'infrastructure', 'system', 'service', 'container',
    'vm', 'cluster', 'metrics', 'prometheus', 'grafana',
    'alert', 'uptime', 'deploy', 'security', 'firewall'
  ]
  return systemKeywords.some(kw => lower.includes(kw))
}

/**
 * Get an agent-specific acknowledgment
 * @param {string} query - The user's query (for context detection)
 * @param {string} agentId - The current agent ID (quox, sentinel, etc.)
 * Returns the text to display immediately (audio handled separately via TTS)
 */
export const playAck = (query = '', agentId = 'quox') => {
  // Initialize if not done
  if (!isPreloaded) {
    preloadAcknowledgments()
  }

  // Get agent-specific acks, fall back to quox then fallback
  let agentAcks = preparedAgentAcks[agentId]
    || preparedAgentAcks['quox']
    || preparedAgentAcks['fallback']

  if (!agentAcks) {
    console.warn('[ACK] No acknowledgments available')
    return { audio: null, text: 'Processing...' }
  }

  // Choose from system acks if query is system-related (70% chance)
  let pool
  if (isSystemQuery(query) && agentAcks.system && agentAcks.system.length > 0 && Math.random() > 0.3) {
    pool = agentAcks.system
  } else {
    pool = (agentAcks.general && agentAcks.general.length > 0) ? agentAcks.general : FALLBACK_ACKS
  }

  const idx = Math.floor(Math.random() * pool.length)
  const selected = pool[idx]

  if (!selected) {
    return { audio: null, text: 'Processing...' }
  }

  console.log(`[ACK] ${agentId}: "${selected.text}"`)

  // Return text for immediate display
  // Audio will be handled separately via TTS if needed
  return { audio: null, text: selected.text }
}

/**
 * Play a random acknowledgment (alias for backward compatibility)
 */
export const playRandomAck = (query) => playAck(query, 'quox')

/**
 * Wait for an audio element to finish playing
 */
export const waitForAudio = (audio) => {
  if (!audio) return Promise.resolve()

  return new Promise(resolve => {
    if (audio.ended || audio.paused) {
      resolve()
    } else {
      audio.onended = resolve
      audio.onerror = resolve
      // Fallback timeout in case onended doesn't fire
      setTimeout(resolve, 3000)
    }
  })
}

/**
 * Extract a speakable summary from a longer response
 * Tries to get the first sentence, falls back to truncation
 */
export const extractSummary = (text) => {
  if (!text) return ''

  // Clean up the text - remove markdown formatting
  let cleaned = text.trim()
    .replace(/```[\s\S]*?```/g, '')  // Remove code blocks
    .replace(/\*\*([^*]+)\*\*/g, '$1')  // Remove bold
    .replace(/\*([^*]+)\*/g, '$1')  // Remove italic
    .replace(/^#+\s+/gm, '')  // Remove headers
    .replace(/^[-*]\s+/gm, '')  // Remove list markers
    .trim()

  // Try to get the first sentence
  const firstSentence = cleaned.match(/^[^.!?\n]+[.!?]/)
  if (firstSentence && firstSentence[0].length <= 200) {
    return firstSentence[0].trim()
  }

  // If first sentence is too long or not found, truncate at word boundary
  if (cleaned.length <= 150) {
    return cleaned
  }

  const truncated = cleaned.substring(0, 150)
  const lastSpace = truncated.lastIndexOf(' ')

  if (lastSpace > 50) {
    return truncated.substring(0, lastSpace) + '...'
  }

  return truncated + '...'
}

/**
 * Get count of preloaded acknowledgments per agent
 */
export const getAckCount = () => {
  const counts = {}
  let total = 0

  Object.entries(AGENT_ACKS).forEach(([agentId, data]) => {
    const general = data.acks?.length || 0
    const system = data.systemAcks?.length || 0
    counts[agentId] = { general, system, total: general + system }
    total += general + system
  })

  return { agents: counts, total }
}

/**
 * Get all acknowledgment texts for an agent (for TTS generation)
 */
export const getAgentAckTexts = (agentId) => {
  const agentData = AGENT_ACKS[agentId]
  if (!agentData) return null

  return {
    voice: agentData.voice,
    texts: [
      ...agentData.general.map(a => ({ id: a.id, text: a.text, type: 'general' })),
      ...agentData.system.map(a => ({ id: a.id, text: a.text, type: 'system' }))
    ]
  }
}

/**
 * Get all agents and their acknowledgment data (for TTS batch generation)
 */
export const getAllAgentAcks = () => AGENT_ACKS

export default {
  preloadAcknowledgments,
  playAck,
  playRandomAck,
  waitForAudio,
  extractSummary,
  getAckCount,
  getAgentAckTexts,
  getAllAgentAcks
}
