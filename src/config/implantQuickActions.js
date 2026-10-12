/**
 * QuoxMind Implant Quick Actions Configuration
 *
 * Defines contextual quick actions for each cognitive implant.
 * Actions can be conditional (based on implant state/metrics) or general.
 *
 * Updated for QuoxMind 12-implant architecture (Stream QMB).
 */

/**
 * Quick action definitions per implant
 * Each implant has:
 * - conditionalActions: Only shown when condition is met
 * - generalActions: Always shown
 */
export const IMPLANT_QUICK_ACTIONS = {
  'quox-memory': {
    conditionalActions: [
      {
        id: 'resolve-contradictions',
        label: 'Resolve Contradictions',
        query: 'There are contradictions in my memory. Help me resolve them.',
        condition: (data) => (data?.contradictions || 0) > 0,
        priority: 'high'
      },
      {
        id: 'low-health',
        label: 'Why is health low?',
        query: 'My QuoxMemory health is low. What factors are affecting it and how can I improve it?',
        condition: (data) => (data?.healthScore || 100) < 50,
        priority: 'medium'
      }
    ],
    generalActions: [
      {
        id: 'improve-memory',
        label: 'How to improve?',
        query: 'How can I improve my QuoxMemory Implant health and effectiveness?'
      },
      {
        id: 'whats-stored',
        label: "What's stored?",
        query: 'Give me an overview of what types of memories are stored.'
      }
    ]
  },

  'quox-temporal': {
    conditionalActions: [
      {
        id: 'debug-failures',
        label: 'Debug Failures',
        query: 'My workflow success rate is low. Help me understand what is failing and why.',
        condition: (data) => (data?.successRate || 100) < 70,
        priority: 'high'
      },
      {
        id: 'monitor-running',
        label: 'Monitor Running Jobs',
        query: 'I have multiple workflows running. Give me a status update on all active jobs.',
        condition: (data) => (data?.running || 0) > 5,
        priority: 'medium'
      }
    ],
    generalActions: [
      {
        id: 'recent-workflows',
        label: 'Recent Activity',
        query: 'Show me recent workflow execution activity and any notable temporal patterns.'
      },
      {
        id: 'optimize-workflows',
        label: 'Optimize Timing',
        query: 'How can I optimize execution timing for better reliability?'
      }
    ]
  },

  'quox-guard': {
    conditionalActions: [
      {
        id: 'active-alerts',
        label: 'Active Alerts!',
        query: 'I have active alerts. What services are affected and what should I do?',
        condition: (data) => (data?.alertsActive || 0) > 0,
        priority: 'high'
      },
      {
        id: 'degraded-uptime',
        label: 'Uptime Degraded',
        query: 'My uptime is below target. Which services are causing issues?',
        condition: (data) => (data?.uptime || 100) < 95,
        priority: 'medium'
      }
    ],
    generalActions: [
      {
        id: 'check-uptime',
        label: 'Check Safety',
        query: 'Give me a safety and reliability report across all monitored services.'
      },
      {
        id: 'improve-reliability',
        label: 'Improve Safety',
        query: 'What can I do to improve overall system safety and reliability?'
      }
    ]
  },

  'quox-focus': {
    conditionalActions: [
      {
        id: 'too-many-loops',
        label: 'Too Many Open Loops',
        query: 'I have many open loops. Help me prioritise and close some of these threads.',
        condition: (data) => (data?.openLoops || 0) > 5,
        priority: 'medium'
      }
    ],
    generalActions: [
      {
        id: 'expand-context',
        label: 'Expand Focus',
        query: 'How can I expand my attention capacity to maintain better continuity?'
      },
      {
        id: 'current-focus',
        label: 'Current Focus',
        query: 'What is my current focus and what context am I tracking?'
      }
    ]
  },

  'quox-value': {
    conditionalActions: [
      {
        id: 'add-workflows',
        label: 'Add More Capabilities',
        query: 'My capability set is limited. What tools and workflows should I add?',
        condition: (data) => (data?.workflows || 0) < 5,
        priority: 'low'
      }
    ],
    generalActions: [
      {
        id: 'available-tools',
        label: 'Available Capabilities',
        query: 'What capabilities are available and how are they prioritised?'
      },
      {
        id: 'suggest-tools',
        label: 'Suggest Priorities',
        query: 'Based on my usage patterns, what should I prioritise next?'
      }
    ]
  },

  'quox-executive': {
    conditionalActions: [
      {
        id: 'expand-agents',
        label: 'Expand Agent Network',
        query: 'I have few agents in my network. What agents should I add to expand capabilities?',
        condition: (data) => (data?.totalAgents || 0) < 5,
        priority: 'low'
      }
    ],
    generalActions: [
      {
        id: 'agent-status',
        label: 'Agent Status',
        query: 'Give me a status report on all agents and their delegation performance.'
      },
      {
        id: 'agent-collaboration',
        label: 'Improve Delegation',
        query: 'How can my agents collaborate more effectively?'
      }
    ]
  },

  'quox-insight': {
    conditionalActions: [
      {
        id: 'unhealthy-services',
        label: 'Unhealthy Services',
        query: 'Some services are unhealthy. What patterns do you see and how do I fix it?',
        condition: (data) => (data?.healthyServices || 0) < (data?.totalServices || 1),
        priority: 'high'
      }
    ],
    generalActions: [
      {
        id: 'insight-status',
        label: 'Pattern Report',
        query: 'Give me a report on patterns and significance detected across operations.'
      },
      {
        id: 'add-integrations',
        label: 'Add Integrations',
        query: 'What integrations could I add to improve pattern detection?'
      }
    ]
  },

  'quox-reflect': {
    conditionalActions: [
      {
        id: 'how-to-unlock',
        label: 'How to Unlock?',
        query: 'The QuoxReflect Implant is locked. What do I need to do to unlock self-evaluation?',
        condition: (data) => data?.isLocked === true,
        priority: 'medium'
      }
    ],
    generalActions: [
      {
        id: 'reflection-overview',
        label: 'Reflection Overview',
        query: 'Show me recent self-evaluation results and quality trends.'
      },
      {
        id: 'permissions-audit',
        label: 'Quality Audit',
        query: 'Audit my recent operational quality and suggest improvements.'
      }
    ]
  },

  'quox-learn': {
    conditionalActions: [
      {
        id: 'unlock-learn',
        label: 'Unlock Learning',
        query: 'The QuoxLearn Implant is locked. How do I unlock behavioural adaptation?',
        condition: (data) => data?.isLocked === true,
        priority: 'medium'
      }
    ],
    generalActions: [
      {
        id: 'learn-overview',
        label: 'Knowledge Overview',
        query: 'Give me an overview of what has been learned and adapted.'
      },
      {
        id: 'organize-data',
        label: 'Organise Knowledge',
        query: 'How can I better organise my knowledge for more effective learning?'
      }
    ]
  },

  'quox-dream': {
    conditionalActions: [
      {
        id: 'sync-changes',
        label: 'Sync Pending Changes',
        query: 'I have pending changes to consolidate. Help me complete the synchronisation.',
        condition: (data) => (data?.pendingChanges || 0) > 0,
        priority: 'medium'
      }
    ],
    generalActions: [
      {
        id: 'consolidation-status',
        label: 'Consolidation Status',
        query: 'What is the status of memory consolidation and what knowledge has been compressed?'
      },
      {
        id: 'improve-consolidation',
        label: 'Improve Consolidation',
        query: 'How can I improve knowledge consolidation across sessions?'
      }
    ]
  },

  'quox-predict': {
    conditionalActions: [
      {
        id: 'resolve-drift',
        label: 'Resolve Drift',
        query: 'There are prediction drift alerts. Show me what changed and help recalibrate.',
        condition: (data) => (data?.driftAlerts || 0) > 0,
        priority: 'high'
      }
    ],
    generalActions: [
      {
        id: 'prediction-accuracy',
        label: 'Prediction Accuracy',
        query: 'How accurate have my recent predictions been? Show me the calibration report.'
      },
      {
        id: 'wisdom-patterns',
        label: 'Wisdom Patterns',
        query: 'Show me the wisdom patterns that are driving predictions.'
      }
    ]
  }
}

/**
 * Get quick actions for an implant based on its current state
 * @param {string} implantId - The implant ID
 * @param {Object} data - The implant's current data/metrics
 * @returns {Array} Array of applicable quick actions
 */
export function getImplantQuickActions(implantId, data = {}) {
  const config = IMPLANT_QUICK_ACTIONS[implantId]
  if (!config) return []

  const actions = []

  // Add conditional actions that meet their conditions
  if (config.conditionalActions) {
    for (const action of config.conditionalActions) {
      if (action.condition(data)) {
        actions.push({ ...action, isConditional: true })
      }
    }
  }

  // Add general actions
  if (config.generalActions) {
    actions.push(...config.generalActions.map(a => ({ ...a, isConditional: false })))
  }

  // Sort by priority (high first) then by conditional (conditional first)
  const priorityOrder = { high: 0, medium: 1, low: 2, undefined: 3 }
  actions.sort((a, b) => {
    if (a.isConditional !== b.isConditional) {
      return a.isConditional ? -1 : 1
    }
    return (priorityOrder[a.priority] || 3) - (priorityOrder[b.priority] || 3)
  })

  return actions
}

/**
 * Get the most important action for an implant (for badges/alerts)
 * @param {string} implantId - The implant ID
 * @param {Object} data - The implant's current data/metrics
 * @returns {Object|null} The highest priority conditional action, or null
 */
export function getImplantAlert(implantId, data = {}) {
  const config = IMPLANT_QUICK_ACTIONS[implantId]
  if (!config?.conditionalActions) return null

  for (const action of config.conditionalActions) {
    if (action.condition(data) && action.priority === 'high') {
      return action
    }
  }

  return null
}

export default IMPLANT_QUICK_ACTIONS
