/**
 * Blast Radius Calculator
 * Calculates the risk level based on number and type of affected hosts
 */

// Production host patterns (high value targets)
// More specific to avoid false positives like "main.py" or "primary key"
const PRODUCTION_PATTERNS = [
  /^prod\d*$/i,           // prod, prod01, prod1
  /^production\d*$/i,     // production, production01
  /-prod$/i,              // web-prod, api-prod
  /^live\d*$/i,           // live, live01
  /-live$/i,              // web-live
  /^primary\d*$/i,        // primary, primary01 (as hostname)
  /-primary$/i            // db-primary
  // Removed /main/i - too many false positives
  // Removed /master/i - conflicts with git terminology
]

// Critical infrastructure patterns
// Made more specific to match actual hostnames, not random strings
const CRITICAL_PATTERNS = [
  /^pve\d+$/i,            // Proxmox nodes: hyp-01, hyp-02
  /^proxmox\d*$/i,        // proxmox, proxmox01
  /^nas\d*$/i,            // NAS: nas, nas01
  /^truenas\d*$/i,        // TrueNAS
  /^firewall\d*$/i,       // firewall, firewall01
  /^pfsense\d*$/i,        // pfSense
  /^opnsense\d*$/i,       // OPNsense
  /^router\d*$/i,         // router, router01
  /^dns\d*$/i,            // dns, dns01
  /^pihole\d*$/i,         // pihole, pihole01
  /^ldap\d*$/i,           // ldap, ldap01
  /^ad\d+$/i,             // Active Directory: ad01, ad02
  /^dc\d+$/i,             // Domain controller: dc01, dc02
  /^db\d+$/i,             // Database servers: db01, db02
  /^mysql\d*$/i,          // mysql, mysql01
  /^postgres\d*$/i,       // postgres, postgres01
  /^redis\d*$/i           // redis, redis01
  // Removed /sql/i - too generic, catches "sql query" in text
]

/**
 * Check if a host is a production system
 * @param {string} hostname - Host name to check
 * @returns {boolean}
 */
export function isProductionHost(hostname) {
  if (!hostname) return false
  return PRODUCTION_PATTERNS.some(p => p.test(hostname))
}

/**
 * Check if a host is critical infrastructure
 * @param {string} hostname - Host name to check
 * @returns {boolean}
 */
export function isCriticalHost(hostname) {
  if (!hostname) return false
  return CRITICAL_PATTERNS.some(p => p.test(hostname))
}

/**
 * Calculate blast radius for a set of hosts
 * @param {string[]} hosts - Array of hostnames
 * @param {number} totalHosts - Total hosts in infrastructure (for percentage)
 * @returns {object} Blast radius analysis
 */
export function calculateBlastRadius(hosts, totalHosts = 50) {
  if (!hosts || hosts.length === 0) {
    return {
      level: 'none',
      count: 0,
      percentage: 0,
      productionCount: 0,
      criticalCount: 0,
      requiresApproval: false,
      requiresAuthCode: false,
      message: 'No hosts affected'
    }
  }

  const count = hosts.length
  const percentage = Math.round((count / totalHosts) * 100)

  // Count production and critical hosts
  const productionHosts = hosts.filter(isProductionHost)
  const criticalHosts = hosts.filter(isCriticalHost)

  // Determine risk level
  let level, requiresApproval, requiresAuthCode, message

  if (productionHosts.length > 0 || criticalHosts.length > 0) {
    // Any production or critical host = HIGH or CRITICAL
    if (count > 10 || productionHosts.length > 3 || criticalHosts.length > 2) {
      level = 'critical'
      requiresApproval = true
      requiresAuthCode = true
      message = `CRITICAL: ${count} hosts including ${productionHosts.length} production and ${criticalHosts.length} critical systems`
    } else {
      level = 'high'
      requiresApproval = true
      requiresAuthCode = true
      message = `HIGH RISK: Includes production/critical infrastructure`
    }
  } else if (count > 20) {
    level = 'critical'
    requiresApproval = true
    requiresAuthCode = true
    message = `CRITICAL: Mass operation affecting ${count} hosts (${percentage}% of infrastructure)`
  } else if (count > 10) {
    level = 'high'
    requiresApproval = true
    requiresAuthCode = false
    message = `HIGH: Significant operation affecting ${count} hosts`
  } else if (count > 5) {
    level = 'medium'
    requiresApproval = true
    requiresAuthCode = false
    message = `MEDIUM: Multiple hosts (${count}) will be affected`
  } else if (count > 1) {
    level = 'low'
    requiresApproval = false
    requiresAuthCode = false
    message = `LOW: ${count} hosts affected`
  } else {
    level = 'minimal'
    requiresApproval = false
    requiresAuthCode = false
    message = `Single host operation`
  }

  return {
    level,
    count,
    percentage,
    productionCount: productionHosts.length,
    criticalCount: criticalHosts.length,
    productionHosts,
    criticalHosts,
    requiresApproval,
    requiresAuthCode,
    message
  }
}

/**
 * Get DEFCON level from blast radius
 * @param {object} blastRadius - Blast radius analysis
 * @returns {string} DEFCON level
 */
export function getDefconFromBlastRadius(blastRadius) {
  switch (blastRadius.level) {
    case 'critical':
      return 'RED'
    case 'high':
      return 'ORANGE'
    case 'medium':
      return 'AMBER'
    case 'low':
      return 'BLUE'
    default:
      return 'GREEN'
  }
}

/**
 * Get color for blast radius level
 * @param {string} level - Blast radius level
 * @returns {string} Color hex code
 */
export function getBlastRadiusColor(level) {
  const colors = {
    critical: '#38bdf8',
    high: '#ff6b30',
    medium: '#ffb030',
    low: '#30ff90',
    minimal: '#30ff90',
    none: '#666'
  }
  return colors[level] || colors.none
}

/**
 * Extract host list from a query
 * Tries to find host references in natural language
 * @param {string} query - User query
 * @param {string[]} knownHosts - List of known hostnames
 * @returns {string[]} Detected hosts
 */
export function extractHostsFromQuery(query, knownHosts = []) {
  if (!query) return []

  const lowerQuery = query.toLowerCase()
  const detected = []

  // Check for known hosts mentioned
  knownHosts.forEach(host => {
    if (lowerQuery.includes(host.toLowerCase())) {
      detected.push(host)
    }
  })

  // Check for "all" patterns
  const allPatterns = [
    /all\s+(hosts?|servers?|systems?|machines?)/i,
    /every\s+(host|server|system|machine)/i,
    /across\s+all/i,
    /entire\s+(infrastructure|cluster|fleet)/i
  ]

  if (allPatterns.some(p => p.test(query))) {
    return knownHosts // Return all known hosts
  }

  // Check for category patterns
  const categoryPatterns = [
    { pattern: /all\s+proxmox/i, filter: h => /pve\d+/i.test(h) },
    { pattern: /all\s+docker/i, filter: h => /docker/i.test(h) },
    { pattern: /all\s+production/i, filter: isProductionHost },
    { pattern: /all\s+monitoring/i, filter: h => /prometheus|grafana|monitor/i.test(h) }
  ]

  for (const { pattern, filter } of categoryPatterns) {
    if (pattern.test(query)) {
      return knownHosts.filter(filter)
    }
  }

  return detected
}

export default {
  calculateBlastRadius,
  isProductionHost,
  isCriticalHost,
  getDefconFromBlastRadius,
  getBlastRadiusColor,
  extractHostsFromQuery
}
