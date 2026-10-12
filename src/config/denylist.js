// Command Denylist Configuration
// Patterns that should be blocked or require special authorization

import { detectIntent } from '../utils/intentDetector.js'

export const DENIED_PATTERNS = [
  // CRITICAL - Always blocked (RED)
  {
    pattern: /rm\s+-rf\s+[\/~]/i,
    severity: 'RED',
    description: 'Recursive delete from root or home',
    blocked: true
  },
  {
    pattern: /rm\s+-rf\s+\/\*/i,
    severity: 'RED',
    description: 'Delete all files from root',
    blocked: true
  },
  {
    pattern: /dd\s+if=.*of=\/dev\/[sh]d/i,
    severity: 'RED',
    description: 'Direct disk write operation',
    blocked: true
  },
  {
    pattern: /mkfs\./i,
    severity: 'RED',
    description: 'Filesystem format operation',
    blocked: true
  },
  {
    pattern: />\s*\/dev\/[sh]d/i,
    severity: 'RED',
    description: 'Overwrite disk device',
    blocked: true
  },
  {
    pattern: /:\(\)\{.*:\|:.*\}/,
    severity: 'RED',
    description: 'Fork bomb detected',
    blocked: true
  },

  // VM/Container Destruction (RED - requires auth code)
  {
    pattern: /qm\s+destroy\s+\d+/i,
    severity: 'RED',
    description: 'VM destruction command',
    blocked: false,
    requiresAuth: true
  },
  {
    pattern: /pct\s+destroy\s+\d+/i,
    severity: 'RED',
    description: 'Container destruction command',
    blocked: false,
    requiresAuth: true
  },
  {
    pattern: /pvesh\s+delete/i,
    severity: 'RED',
    description: 'Proxmox resource deletion via API',
    blocked: false,
    requiresAuth: true
  },

  // Firewall/Network (RED - requires auth code)
  {
    pattern: /iptables\s+-F/i,
    severity: 'RED',
    description: 'Firewall flush - will drop all rules',
    blocked: false,
    requiresAuth: true
  },
  {
    pattern: /iptables\s+--flush/i,
    severity: 'RED',
    description: 'Firewall flush - will drop all rules',
    blocked: false,
    requiresAuth: true
  },
  {
    pattern: /ufw\s+disable/i,
    severity: 'RED',
    description: 'Disable firewall completely',
    blocked: false,
    requiresAuth: true
  },

  // System Power (ORANGE - requires confirmation)
  {
    pattern: /shutdown\s/i,
    severity: 'ORANGE',
    description: 'System shutdown command',
    blocked: false,
    requiresAuth: false
  },
  {
    pattern: /reboot/i,
    severity: 'ORANGE',
    description: 'System reboot command',
    blocked: false,
    requiresAuth: false
  },
  {
    pattern: /poweroff/i,
    severity: 'ORANGE',
    description: 'System power off command',
    blocked: false,
    requiresAuth: false
  },
  {
    pattern: /init\s+0/i,
    severity: 'ORANGE',
    description: 'System halt via init',
    blocked: false,
    requiresAuth: false
  },
  {
    pattern: /init\s+6/i,
    severity: 'ORANGE',
    description: 'System reboot via init',
    blocked: false,
    requiresAuth: false
  },

  // Dangerous Permissions (ORANGE)
  {
    pattern: /chmod\s+-R\s+777/i,
    severity: 'ORANGE',
    description: 'Recursive world-writable permissions',
    blocked: false,
    requiresAuth: false
  },
  {
    pattern: /chown\s+-R\s+.*:/i,
    severity: 'ORANGE',
    description: 'Recursive ownership change',
    blocked: false,
    requiresAuth: false
  },

  // Service Destruction (AMBER)
  {
    pattern: /systemctl\s+stop\s+/i,
    severity: 'AMBER',
    description: 'Service stop command',
    blocked: false,
    requiresAuth: false
  },
  {
    pattern: /systemctl\s+disable\s+/i,
    severity: 'AMBER',
    description: 'Service disable command',
    blocked: false,
    requiresAuth: false
  },
  {
    pattern: /docker\s+rm\s+-f/i,
    severity: 'AMBER',
    description: 'Force remove Docker container',
    blocked: false,
    requiresAuth: false
  },
  {
    pattern: /docker\s+stop/i,
    severity: 'AMBER',
    description: 'Docker container stop',
    blocked: false,
    requiresAuth: false
  },

  // Package Management (AMBER)
  {
    pattern: /apt\s+(remove|purge)\s+/i,
    severity: 'AMBER',
    description: 'Package removal',
    blocked: false,
    requiresAuth: false
  },
  {
    pattern: /yum\s+(remove|erase)\s+/i,
    severity: 'AMBER',
    description: 'Package removal',
    blocked: false,
    requiresAuth: false
  }
]

// Query-based dangerous patterns (for natural language queries)
// NOTE: These only apply to ACTION requests, not informational queries
// The isInformationalQuery() check should be applied BEFORE these patterns
export const DANGEROUS_QUERY_PATTERNS = [
  {
    // Mass deletion - requires explicit action words
    pattern: /\b(delete|remove|destroy)\b.*\b(all|every)\b.*\b(vm|container|host|server)/i,
    severity: 'RED',
    description: 'Mass deletion request',
    requiresAuth: true,
    actionOnly: true  // Only trigger if intent is action, not informational
  },
  {
    // VM destruction with explicit destroy verb
    pattern: /\b(destroy|delete)\b.*\b(vm|virtual machine|container)\b/i,
    severity: 'RED',
    description: 'VM/container destruction request',
    requiresAuth: true,
    actionOnly: true
  },
  {
    // Data wipe/erase - must be imperative (not "what format")
    pattern: /^(wipe|erase)\b|\b(wipe|erase)\s+(the\s+)?(disk|drive|data|storage)/i,
    severity: 'RED',
    description: 'Data destruction request',
    requiresAuth: true,
    actionOnly: true
  },
  {
    // Format disk - must be action context (not "what format is")
    pattern: /\bformat\s+(the\s+)?(disk|drive|partition|volume|storage)/i,
    severity: 'RED',
    description: 'Disk format request',
    requiresAuth: true,
    actionOnly: true
  },
  {
    // Mass power operations
    pattern: /\b(shutdown|reboot|restart|poweroff)\b.*\b(all|every|entire|fleet)\b/i,
    severity: 'ORANGE',
    description: 'Mass power operation',
    requiresAuth: false,
    actionOnly: true
  },
  {
    // Mass updates with explicit action
    pattern: /\b(update|upgrade|patch)\b.*\b(all|every|entire)\b.*\b(server|host|system|machine)/i,
    severity: 'ORANGE',
    description: 'Mass update operation',
    requiresAuth: false,
    actionOnly: true
  }
]

/**
 * Validate a command against the denylist
 * @param {string} command - The command to validate
 * @returns {object} Validation result
 */
export function validateCommand(command) {
  if (!command) return { allowed: true }

  for (const rule of DENIED_PATTERNS) {
    if (rule.pattern.test(command)) {
      return {
        allowed: !rule.blocked,
        blocked: rule.blocked,
        severity: rule.severity,
        description: rule.description,
        requiresAuth: rule.requiresAuth || false,
        pattern: rule.pattern.toString()
      }
    }
  }

  return { allowed: true }
}

/**
 * Validate a natural language query
 * @param {string} query - The user's query
 * @param {object} [intentOverride] - Optional pre-computed intent
 * @returns {object} Validation result
 */
export function validateQuery(query, intentOverride = null) {
  if (!query) return { severity: 'GREEN', requiresAuth: false }

  // Check if this is an informational query
  const intent = intentOverride || detectIntent(query)
  const isInformational = intent.isInformational && !intent.isDestructive

  for (const rule of DANGEROUS_QUERY_PATTERNS) {
    if (rule.pattern.test(query)) {
      // Skip action-only rules for informational queries
      if (rule.actionOnly && isInformational) {
        continue
      }

      return {
        severity: rule.severity,
        description: rule.description,
        requiresAuth: rule.requiresAuth,
        matched: true,
        skippedDueToIntent: false
      }
    }
  }

  return { severity: 'GREEN', requiresAuth: false, matched: false }
}

/**
 * Severity to action mapping
 * Maps severity levels to default actions when no special flags are set
 */
export const SEVERITY_ACTIONS = {
  RED: 'BLOCK',           // Most severe - block by default (unless requiresAuth)
  ORANGE: 'REQUIRE_APPROVAL',
  AMBER: 'WARN',
  YELLOW: 'WARN',
  GREEN: 'ALLOW',
  BLUE: 'ALLOW'
}

/**
 * Get the action to take for a command based on validation results
 * @param {string} command - The command to check
 * @returns {object} Action result with action type and validation details
 */
export function getCommandAction(command) {
  const validation = validateCommand(command)

  // If no pattern matched, allow the command
  if (validation.allowed && !validation.severity) {
    return {
      action: 'ALLOW',
      ...validation
    }
  }

  // Determine action based on severity and flags
  let action

  if (validation.severity === 'RED') {
    if (validation.blocked) {
      action = 'BLOCK'
    } else if (validation.requiresAuth) {
      action = 'REQUIRE_OVERRIDE'
    } else {
      action = 'BLOCK'  // Default for RED without specific flags
    }
  } else if (validation.severity === 'ORANGE') {
    action = 'REQUIRE_APPROVAL'
  } else if (validation.severity === 'AMBER' || validation.severity === 'YELLOW') {
    action = 'WARN'
  } else if (validation.severity === 'GREEN' || validation.severity === 'BLUE') {
    action = 'ALLOW'
  } else {
    // Fallback to SEVERITY_ACTIONS mapping or ALLOW
    action = SEVERITY_ACTIONS[validation.severity] || 'ALLOW'
  }

  return {
    action,
    ...validation
  }
}

/**
 * Get severity color
 */
export function getSeverityColor(severity) {
  const colors = {
    GREEN: '#30ff90',
    BLUE: '#3090ff',
    AMBER: '#ffb030',
    ORANGE: '#ff6b30',
    RED: '#38bdf8'
  }
  return colors[severity] || colors.GREEN
}

export default {
  DENIED_PATTERNS,
  DANGEROUS_QUERY_PATTERNS,
  SEVERITY_ACTIONS,
  validateCommand,
  validateQuery,
  getCommandAction,
  getSeverityColor
}
