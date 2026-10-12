/**
 * Command Validator for Collector (CJS)
 *
 * Server-side command validation against a denylist of dangerous patterns.
 * Used by POST /terminal/shell/exec to prevent blocked commands from being
 * injected into active PTY sessions.
 *
 * IMPORTANT: The DENIED_PATTERNS list is shared with src/config/denylist.js (ESM).
 * When updating patterns, update BOTH files to keep them in sync.
 */

const DENIED_PATTERNS = [
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
];

const SEVERITY_ACTIONS = {
  RED: 'BLOCK',
  ORANGE: 'REQUIRE_APPROVAL',
  AMBER: 'WARN',
  YELLOW: 'WARN',
  GREEN: 'ALLOW',
  BLUE: 'ALLOW'
};

/**
 * Validate a command against the denylist.
 * @param {string} command - The command to validate
 * @returns {object} Validation result
 */
function validateCommand(command) {
  if (!command) return { allowed: true };

  for (const rule of DENIED_PATTERNS) {
    if (rule.pattern.test(command)) {
      return {
        allowed: !rule.blocked,
        blocked: rule.blocked,
        severity: rule.severity,
        description: rule.description,
        requiresAuth: rule.requiresAuth || false,
        pattern: rule.pattern.toString()
      };
    }
  }

  return { allowed: true };
}

/**
 * Get the action to take for a command based on validation results.
 * @param {string} command - The command to check
 * @returns {object} Action result with action type and validation details
 */
function getCommandAction(command) {
  const validation = validateCommand(command);

  if (validation.allowed && !validation.severity) {
    return { action: 'ALLOW', ...validation };
  }

  let action;

  if (validation.severity === 'RED') {
    if (validation.blocked) {
      action = 'BLOCK';
    } else if (validation.requiresAuth) {
      action = 'REQUIRE_OVERRIDE';
    } else {
      action = 'BLOCK';
    }
  } else if (validation.severity === 'ORANGE') {
    action = 'REQUIRE_APPROVAL';
  } else if (validation.severity === 'AMBER' || validation.severity === 'YELLOW') {
    action = 'WARN';
  } else if (validation.severity === 'GREEN' || validation.severity === 'BLUE') {
    action = 'ALLOW';
  } else {
    action = SEVERITY_ACTIONS[validation.severity] || 'ALLOW';
  }

  return { action, ...validation };
}

/**
 * Validate a multi-line command by checking each line independently.
 * Returns the most severe validation result.
 * @param {string} command - Command that may contain newlines
 * @returns {object} Most severe action result
 */
function validateMultiLineCommand(command) {
  if (!command) return { action: 'ALLOW', allowed: true };

  const lines = command.split('\n').map(l => l.trim()).filter(Boolean);

  if (lines.length === 0) return { action: 'ALLOW', allowed: true };
  if (lines.length === 1) return getCommandAction(lines[0]);

  const severityOrder = ['ALLOW', 'WARN', 'REQUIRE_APPROVAL', 'REQUIRE_OVERRIDE', 'BLOCK'];
  let worst = { action: 'ALLOW', allowed: true };

  for (const line of lines) {
    const result = getCommandAction(line);
    if (severityOrder.indexOf(result.action) > severityOrder.indexOf(worst.action)) {
      worst = result;
    }
  }

  return worst;
}

module.exports = {
  DENIED_PATTERNS,
  SEVERITY_ACTIONS,
  validateCommand,
  getCommandAction,
  validateMultiLineCommand
};
