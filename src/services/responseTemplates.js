/**
 * Response Templates for Smart Router
 *
 * Provides structured response formats for router patterns.
 * Templates can be rendered as rich UI components or fallback to markdown.
 */

/**
 * Response types that can be rendered specially
 */
export const RESPONSE_TYPES = {
  LIST: 'list',
  TABLE: 'table',
  STATUS_CARD: 'status_card',
  ACTION_PROMPT: 'action_prompt',
  STATS: 'stats',
  HOST_INFO: 'host_info',
  AGENT_INFO: 'agent_info',
  MEMORY_RESULTS: 'memory_results',
  HELP: 'help',
  ERROR: 'error',
  INFO: 'info'
}

/**
 * Create a list response template
 */
export function createListTemplate(title, items, options = {}) {
  const {
    emptyMessage = 'No items found',
    actions = [],
    groupBy = null,
    maxItems = 20
  } = options

  return {
    type: RESPONSE_TYPES.LIST,
    title,
    items: items.slice(0, maxItems),
    totalCount: items.length,
    truncated: items.length > maxItems,
    emptyMessage,
    actions,
    groupBy,
    // Markdown fallback
    toMarkdown() {
      if (items.length === 0) return `**${title}**\n\n${emptyMessage}`

      let md = `**${title}** (${items.length})\n\n`
      for (const item of this.items) {
        if (typeof item === 'string') {
          md += `- ${item}\n`
        } else {
          md += `- **${item.name || item.id}**`
          if (item.description) md += `: ${item.description}`
          if (item.status) md += ` (${item.status})`
          md += '\n'
        }
      }
      if (this.truncated) {
        md += `\n*...and ${items.length - maxItems} more*\n`
      }
      return md
    }
  }
}

/**
 * Create a table response template
 */
export function createTableTemplate(title, columns, rows, options = {}) {
  const {
    emptyMessage = 'No data',
    actions = [],
    maxRows = 15
  } = options

  return {
    type: RESPONSE_TYPES.TABLE,
    title,
    columns,
    rows: rows.slice(0, maxRows),
    totalCount: rows.length,
    truncated: rows.length > maxRows,
    emptyMessage,
    actions,
    // Markdown fallback
    toMarkdown() {
      if (rows.length === 0) return `**${title}**\n\n${emptyMessage}`

      let md = `**${title}**\n\n`
      // Header
      md += '| ' + columns.map(c => c.label || c.key).join(' | ') + ' |\n'
      md += '| ' + columns.map(() => '---').join(' | ') + ' |\n'
      // Rows
      for (const row of this.rows) {
        md += '| ' + columns.map(c => row[c.key] ?? '-').join(' | ') + ' |\n'
      }
      if (this.truncated) {
        md += `\n*...and ${rows.length - maxRows} more rows*\n`
      }
      return md
    }
  }
}

/**
 * Create a status card template
 */
export function createStatusCard(title, status, details = {}, options = {}) {
  const {
    icon = null,
    color = null,
    actions = []
  } = options

  // Determine color based on status
  const statusColors = {
    healthy: 'green',
    ok: 'green',
    running: 'green',
    active: 'green',
    warning: 'yellow',
    degraded: 'yellow',
    error: 'red',
    critical: 'red',
    offline: 'red',
    unknown: 'gray'
  }

  return {
    type: RESPONSE_TYPES.STATUS_CARD,
    title,
    status,
    statusColor: color || statusColors[status.toLowerCase()] || 'gray',
    details,
    icon,
    actions,
    // Markdown fallback
    toMarkdown() {
      const statusEmoji = {
        green: '',
        yellow: '',
        red: '',
        gray: ''
      }
      let md = `**${title}**: ${status} ${statusEmoji[this.statusColor] || ''}\n\n`
      for (const [key, value] of Object.entries(details)) {
        md += `- **${key}:** ${value}\n`
      }
      return md
    }
  }
}

/**
 * Create an action prompt template
 */
export function createActionPrompt(message, actions, options = {}) {
  const {
    type = 'info',
    dismissible = true
  } = options

  return {
    type: RESPONSE_TYPES.ACTION_PROMPT,
    message,
    actions: actions.map(a => ({
      label: a.label,
      command: a.command,
      primary: a.primary || false,
      dangerous: a.dangerous || false
    })),
    promptType: type,
    dismissible,
    // Markdown fallback
    toMarkdown() {
      let md = `${message}\n\n`
      if (actions.length > 0) {
        md += '**Quick Actions:**\n'
        for (const action of actions) {
          md += `- \`${action.command}\` - ${action.label}\n`
        }
      }
      return md
    }
  }
}

/**
 * Create a stats template
 */
export function createStatsTemplate(title, stats, options = {}) {
  const {
    showTrend = false,
    period = null
  } = options

  return {
    type: RESPONSE_TYPES.STATS,
    title,
    stats: stats.map(s => ({
      label: s.label,
      value: s.value,
      unit: s.unit || '',
      trend: s.trend || null,
      color: s.color || null
    })),
    period,
    showTrend,
    // Markdown fallback
    toMarkdown() {
      let md = `**${title}**\n\n`
      for (const stat of this.stats) {
        md += `- **${stat.label}:** ${stat.value}${stat.unit}`
        if (stat.trend) md += ` (${stat.trend > 0 ? '+' : ''}${stat.trend}%)`
        md += '\n'
      }
      return md
    }
  }
}

/**
 * Create host info template
 */
export function createHostInfoTemplate(host, quoxagentStatus = null) {
  return {
    type: RESPONSE_TYPES.HOST_INFO,
    host: {
      id: host.id,
      name: host.name || host.id,
      ip: host.ip,
      category: host.category,
      description: host.description,
      os: host.os,
      role: host.role,
      services: host.services || []
    },
    quoxagent: quoxagentStatus ? {
      installed: quoxagentStatus.installed,
      running: quoxagentStatus.running,
      version: quoxagentStatus.version
    } : null,
    // Markdown fallback
    toMarkdown() {
      let md = `**Host: ${this.host.id}**\n\n`
      if (this.host.ip) md += `- **IP:** ${this.host.ip}\n`
      if (this.host.category) md += `- **Category:** ${this.host.category}\n`
      if (this.host.description) md += `- **Description:** ${this.host.description}\n`
      if (this.host.os) md += `- **OS:** ${this.host.os}\n`
      if (this.host.services?.length) md += `- **Services:** ${this.host.services.join(', ')}\n`
      if (this.quoxagent) {
        const status = this.quoxagent.running ? 'Running' : this.quoxagent.installed ? 'Installed (stopped)' : 'Not installed'
        md += `\n**QuoxAgent Status:** ${status}\n`
        if (this.quoxagent.version) md += `**QuoxAgent Version:** ${this.quoxagent.version}\n`
      }
      return md
    }
  }
}

/**
 * Create agent info template
 */
export function createAgentInfoTemplate(agent) {
  return {
    type: RESPONSE_TYPES.AGENT_INFO,
    agent: {
      id: agent.id,
      name: agent.identity?.name || agent.name || agent.id,
      tagline: agent.identity?.tagline || agent.specialty || '',
      level: agent.hierarchy?.level ?? agent.level ?? 0,
      reportsTo: agent.hierarchy?.reports_to || agent.reports_to,
      capabilities: agent.capabilities || agent.skills || [],
      memoryDomains: agent.memory_domains || [],
      color: agent.identity?.color?.primary || agent.color
    },
    // Markdown fallback
    toMarkdown() {
      const levelName = this.agent.level === 0 ? 'Orchestrator' :
                       this.agent.level === 1 ? 'Manager' : 'Specialist'
      let md = `**Agent: ${this.agent.name}**\n\n`
      md += `- **Role:** ${this.agent.tagline}\n`
      md += `- **Level:** ${this.agent.level} (${levelName})\n`
      if (this.agent.reportsTo) md += `- **Reports To:** ${this.agent.reportsTo.toUpperCase()}\n`
      if (this.agent.capabilities?.length) {
        md += `\n**Capabilities:**\n`
        for (const cap of this.agent.capabilities.slice(0, 8)) {
          md += `- ${cap}\n`
        }
      }
      if (this.agent.memoryDomains?.length) {
        md += `\n**Memory Domains:** ${this.agent.memoryDomains.join(', ')}\n`
      }
      return md
    }
  }
}

/**
 * Create memory results template
 */
export function createMemoryResultsTemplate(query, results) {
  return {
    type: RESPONSE_TYPES.MEMORY_RESULTS,
    query,
    results: results.map(r => ({
      type: r.type || 'memory',
      content: r.content || r.text || r.value,
      score: r.score,
      timestamp: r.timestamp,
      metadata: r.metadata
    })),
    count: results.length,
    // Markdown fallback
    toMarkdown() {
      if (this.count === 0) {
        return `No memories found for "${this.query}".`
      }
      let md = `**Memory Search: "${this.query}"** (${this.count} results)\n\n`
      for (const result of this.results) {
        const score = result.score ? ` (${Math.round(result.score * 100)}%)` : ''
        const content = result.content?.slice(0, 200) + (result.content?.length > 200 ? '...' : '')
        md += `**${result.type}**${score}:\n${content}\n\n`
      }
      return md
    }
  }
}

/**
 * Create help template
 */
export function createHelpTemplate(sections) {
  return {
    type: RESPONSE_TYPES.HELP,
    sections: sections.map(s => ({
      title: s.title,
      commands: s.commands.map(c => ({
        command: c.command,
        description: c.description
      }))
    })),
    // Markdown fallback
    toMarkdown() {
      let md = '**Available Commands**\n\n'
      for (const section of this.sections) {
        md += `**${section.title}:**\n`
        for (const cmd of section.commands) {
          md += `- \`${cmd.command}\` - ${cmd.description}\n`
        }
        md += '\n'
      }
      return md
    }
  }
}

/**
 * Create error template
 */
export function createErrorTemplate(message, options = {}) {
  const {
    code = null,
    suggestion = null,
    retryAction = null
  } = options

  return {
    type: RESPONSE_TYPES.ERROR,
    message,
    code,
    suggestion,
    retryAction,
    // Markdown fallback
    toMarkdown() {
      let md = `**Error:** ${this.message}\n`
      if (this.code) md += `\n*Error code: ${this.code}*\n`
      if (this.suggestion) md += `\n**Suggestion:** ${this.suggestion}\n`
      if (this.retryAction) md += `\n*Try: \`${this.retryAction}\`*\n`
      return md
    }
  }
}

/**
 * Render a template to markdown (fallback for non-rich contexts)
 */
export function renderToMarkdown(template) {
  if (!template) return ''
  if (typeof template === 'string') return template
  if (typeof template.toMarkdown === 'function') return template.toMarkdown()
  return JSON.stringify(template, null, 2)
}

/**
 * Check if a response is a structured template
 */
export function isStructuredTemplate(response) {
  return response && typeof response === 'object' && response.type in RESPONSE_TYPES
}

export default {
  RESPONSE_TYPES,
  createListTemplate,
  createTableTemplate,
  createStatusCard,
  createActionPrompt,
  createStatsTemplate,
  createHostInfoTemplate,
  createAgentInfoTemplate,
  createMemoryResultsTemplate,
  createHelpTemplate,
  createErrorTemplate,
  renderToMarkdown,
  isStructuredTemplate
}
