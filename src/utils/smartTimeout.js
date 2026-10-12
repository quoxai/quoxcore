// Smart Timeout System v2.0
// Philosophy: Be GENEROUS with timeouts. Never timeout on legitimate operations.
// Users hate timeouts more than waiting.

// Base timeout: 5 minutes for EVERYTHING
const DEFAULT_TIMEOUT = 300000 // 5 minutes

// Operation categories - these EXTEND the default, never reduce it
const OPERATION_TYPES = {
  // Quick operations - still get 5 minutes minimum
  quick: {
    base: DEFAULT_TIMEOUT,
    keywords: ['ping', 'echo', 'whoami', 'hostname'],
    description: 'Quick command'
  },

  // Standard operations - 5 minutes
  standard: {
    base: DEFAULT_TIMEOUT,
    keywords: ['status', 'check', 'show', 'list', 'get', 'display'],
    description: 'Standard operation'
  },

  // Infrastructure queries - 8 minutes
  infrastructure: {
    base: 480000,
    keywords: ['disk', 'cpu', 'memory', 'docker', 'container', 'service', 'process'],
    description: 'Infrastructure query'
  },

  // Monitoring/Metrics - 8 minutes (Prometheus can be slow)
  monitoring: {
    base: 480000,
    keywords: ['metrics', 'prometheus', 'grafana', 'alert', 'dashboard', 'scrape', 'target'],
    description: 'Monitoring query'
  },

  // Security operations - 10 minutes
  security: {
    base: 600000,
    keywords: ['security', 'firewall', 'auth', 'audit', 'threat', 'vulnerability', 'wazuh'],
    description: 'Security operation'
  },

  // Network operations - 10 minutes
  network: {
    base: 600000,
    keywords: ['network', 'port', 'nmap', 'scan', 'connectivity', 'dns', 'trace'],
    description: 'Network operation'
  },

  // Virtualization - 10 minutes
  virtualization: {
    base: 600000,
    keywords: ['vm', 'proxmox', 'cluster', 'qemu', 'snapshot', 'migrate', 'lxc'],
    description: 'Virtualization operation'
  },

  // Research operations - 15 MINUTES (Perplexity, web search, CVE lookup)
  // These are the ones that were failing!
  research: {
    base: 900000, // 15 minutes
    keywords: ['research', 'perplexity', 'search', 'find', 'look up', 'cve', 'troubleshoot', 'documentation', 'how to', 'why', 'explain', 'scholar'],
    description: 'Research operation'
  },

  // Code generation - 10 minutes
  codegen: {
    base: 600000,
    keywords: ['generate', 'script', 'code', 'write', 'create', 'template', 'forge'],
    description: 'Code generation'
  },

  // Backup operations - 15 minutes
  backup: {
    base: 900000,
    keywords: ['backup', 'restore', 'pbs', 'snapshot'],
    description: 'Backup operation'
  },

  // Update/Install operations - 20 minutes
  update: {
    base: 1200000,
    keywords: ['update', 'upgrade', 'install', 'apt', 'yum', 'dnf', 'patch', 'deploy'],
    description: 'Update operation'
  },

  // Mass operations - 30 minutes
  mass: {
    base: 1800000,
    keywords: ['all servers', 'all hosts', 'every', 'entire', 'whole', 'mass', 'fleet', 'infrastructure-wide'],
    description: 'Mass operation'
  },

  // Full scans - 30 minutes
  fullscan: {
    base: 1800000,
    keywords: ['full scan', 'complete', 'comprehensive', 'deep', 'thorough'],
    description: 'Full scan'
  }
}

// Host multipliers - increase timeout based on host count
const HOST_PATTERNS = [
  { pattern: /all\s+(servers?|hosts?|nodes?|machines?|systems?)/i, multiplier: 2.0 },
  { pattern: /every\s+(server|host|node|machine|system)/i, multiplier: 2.0 },
  { pattern: /entire\s+(infrastructure|cluster|fleet|network)/i, multiplier: 2.5 },
  { pattern: /(\d+)\s+(servers?|hosts?|nodes?|machines?|vms?)/i, extract: true },
  { pattern: /across\s+all/i, multiplier: 2.0 },
  { pattern: /proxmox\s+(cluster|nodes?)/i, multiplier: 1.5 },
  { pattern: /production/i, multiplier: 1.5 }
]

/**
 * Analyze a query and return timeout configuration
 * Key principle: ALWAYS be generous. Users hate timeouts.
 */
export function analyzeQuery(query, hostCount = 1) {
  const q = query.toLowerCase()

  // Find the operation type with the LONGEST timeout that matches
  let matchedType = 'standard'
  let baseTimeout = DEFAULT_TIMEOUT
  let matchedKeywords = []

  for (const [type, config] of Object.entries(OPERATION_TYPES)) {
    for (const keyword of config.keywords) {
      if (q.includes(keyword)) {
        // Always use the LONGER timeout if multiple match
        if (config.base > baseTimeout) {
          matchedType = type
          baseTimeout = config.base
        }
        matchedKeywords.push(keyword)
      }
    }
  }

  // Apply host multiplier
  let hostMultiplier = 1.0
  for (const hp of HOST_PATTERNS) {
    const match = q.match(hp.pattern)
    if (match) {
      if (hp.extract && match[1]) {
        const count = parseInt(match[1], 10)
        hostMultiplier = Math.max(hostMultiplier, 1 + Math.log10(count))
      } else if (hp.multiplier) {
        hostMultiplier = Math.max(hostMultiplier, hp.multiplier)
      }
    }
  }

  // Calculate final timeout
  let timeout = baseTimeout * hostMultiplier

  // Apply bounds - minimum 5 minutes, maximum 1 hour
  const MIN_TIMEOUT = 300000   // 5 minutes minimum for EVERYTHING
  const MAX_TIMEOUT = 3600000  // 1 hour maximum
  timeout = Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, timeout))

  // Round to nice numbers
  timeout = Math.ceil(timeout / 10000) * 10000

  // Determine operation characteristics
  const isLongOperation = timeout > 600000     // > 10 minutes
  const isVeryLongOperation = timeout > 900000 // > 15 minutes
  const isMarathonOperation = timeout > 1200000 // > 20 minutes

  return {
    timeout,
    timeoutSeconds: Math.round(timeout / 1000),
    timeoutMinutes: Math.round(timeout / 60000),
    timeoutFormatted: formatTimeout(timeout),
    operationType: matchedType,
    operationDescription: OPERATION_TYPES[matchedType]?.description || 'Operation',
    matchedKeywords: [...new Set(matchedKeywords)],
    hostMultiplier,
    isLongOperation,
    isVeryLongOperation,
    isMarathonOperation,
    // Show progress for anything over 2 minutes
    shouldShowProgress: timeout > 120000,
    estimatedDescription: getEstimateDescription(timeout, matchedType)
  }
}

/**
 * Format timeout for display
 */
function formatTimeout(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600000) {
    const mins = Math.round(ms / 60000)
    return `${mins} min`
  }
  const hours = Math.floor(ms / 3600000)
  const mins = Math.round((ms % 3600000) / 60000)
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

/**
 * Get human-readable estimate description
 */
function getEstimateDescription(timeout, operationType) {
  const mins = Math.round(timeout / 60000)

  // Type-specific messages
  const typeMessages = {
    research: 'Research operations may take several minutes',
    backup: 'Backup operations can take time',
    update: 'Updates may take a while to complete',
    mass: 'Mass operations across multiple hosts',
    fullscan: 'Comprehensive scan in progress'
  }

  if (typeMessages[operationType]) {
    return typeMessages[operationType]
  }

  // Generic messages based on duration
  if (mins <= 5) return 'Standard operation'
  if (mins <= 10) return `May take up to ${mins} minutes`
  if (mins <= 20) return `Extended operation (~${mins} min)`
  return `Long-running operation (~${mins} min)`
}

/**
 * Get recommended action based on analysis
 */
export function getRecommendedAction(analysis) {
  if (analysis.isMarathonOperation) {
    return {
      action: 'proceed',
      message: `${analysis.operationDescription} - timeout: ${analysis.timeoutFormatted}`,
      showProgress: true
    }
  }

  if (analysis.isLongOperation) {
    return {
      action: 'proceed',
      message: analysis.estimatedDescription,
      showProgress: true
    }
  }

  return {
    action: 'proceed',
    message: null,
    showProgress: analysis.shouldShowProgress
  }
}

/**
 * Check if this looks like a research/perplexity query
 */
export function isResearchQuery(query) {
  const q = query.toLowerCase()
  const researchIndicators = [
    'research', 'search', 'find', 'look up', 'perplexity',
    'cve', 'vulnerability', 'troubleshoot', 'how to', 'why does',
    'explain', 'what is', 'documentation', 'best practice',
    'scholar', 'investigate', 'analyze'
  ]
  return researchIndicators.some(ind => q.includes(ind))
}

/**
 * Check if this is a mass/multi-host operation
 */
export function isMassOperation(query) {
  const massPatterns = [
    /all\s+(servers?|hosts?|nodes?)/i,
    /every\s+(server|host|node)/i,
    /entire\s+(infrastructure|cluster|fleet)/i,
    /\b(\d{2,})\s+(servers?|hosts?)/i,
    /across\s+(all|the\s+entire)/i,
    /mass\s+(update|upgrade|deploy)/i,
    /fleet.wide/i,
    /infrastructure.wide/i
  ]
  return massPatterns.some(p => p.test(query))
}

/**
 * Get a simple timeout for common operation types
 * These are MINIMUM timeouts - actual may be longer
 */
export function getQuickTimeout(operationType) {
  const timeouts = {
    quick: 300000,      // 5 min
    status: 300000,     // 5 min
    health: 300000,     // 5 min
    metrics: 480000,    // 8 min
    docker: 480000,     // 8 min
    security: 600000,   // 10 min
    network: 600000,    // 10 min
    vm: 600000,         // 10 min
    research: 900000,   // 15 min - THIS WAS THE PROBLEM
    backup: 900000,     // 15 min
    update: 1200000,    // 20 min
    mass: 1800000       // 30 min
  }
  return timeouts[operationType] || DEFAULT_TIMEOUT
}

export default {
  analyzeQuery,
  getRecommendedAction,
  isResearchQuery,
  isMassOperation,
  getQuickTimeout,
  DEFAULT_TIMEOUT
}
