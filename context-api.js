#!/usr/bin/env node
/**
 * Simple Context API Server
 * Serves QuoxCORE self-awareness context for n8n to fetch
 *
 * Run: node context-api.js
 * Fetch: curl http://localhost:3200/context/quox
 */

import http from 'http'
import fs from 'fs'
import path from 'path'

const PORT = 3200

// CORS configuration - validate origin against allowlist
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5173').split(',').map(o => o.trim());

function setSecureCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
}

// Load all assistant manifests
const assistantsDir = './src/config/entities/assistants'
const assistants = {}

try {
  const files = fs.readdirSync(assistantsDir)
  for (const file of files) {
    if (file.endsWith('.json')) {
      const content = fs.readFileSync(path.join(assistantsDir, file), 'utf-8')
      const manifest = JSON.parse(content)
      assistants[manifest.id] = manifest
    }
  }
  console.log(`Loaded ${Object.keys(assistants).length} assistant manifests`)
} catch (err) {
  console.error('Failed to load manifests:', err.message)
}

// Generate self-knowledge for an assistant
function generateSelfKnowledge(assistantId) {
  const assistant = assistants[assistantId]
  if (!assistant) return `Unknown assistant: ${assistantId}`

  const lines = [
    `## Your Identity: ${assistant.identity.name}`,
    '',
    assistant.identity.description,
    '',
    `**Tagline:** ${assistant.identity.tagline}`,
    `**Role:** ${assistant.hierarchy.role} (Level ${assistant.hierarchy.level})`,
    `**Reports to:** ${assistant.hierarchy.reportsTo || 'None'}`,
    ''
  ]

  // Personality
  lines.push('### Personality')
  lines.push(`- **Tone:** ${assistant.identity.personality.tone}`)
  lines.push(`- **Style:** ${assistant.identity.personality.style}`)
  lines.push(`- **Traits:** ${assistant.identity.personality.traits.join(', ')}`)
  lines.push('')

  // Capabilities
  lines.push('### Your Capabilities')
  lines.push(`- **Domains:** ${assistant.capabilities.domains.join(', ')}`)
  lines.push(`- **Tool Access:** ${assistant.capabilities.toolAccess}`)
  if (assistant.capabilities.toolCapabilities?.length) {
    lines.push(`- **Tool Capabilities:** ${assistant.capabilities.toolCapabilities.join(', ')}`)
  }
  if (assistant.capabilities.workflows?.length) {
    lines.push(`- **Workflows:** ${assistant.capabilities.workflows.join(', ')}`)
  }
  lines.push('')

  // Hierarchy
  if (assistant.hierarchy.manages?.length) {
    lines.push('### You Manage')
    for (const subordinateId of assistant.hierarchy.manages) {
      const sub = assistants[subordinateId]
      if (sub) {
        lines.push(`- **${sub.identity.name}**: ${sub.identity.tagline}`)
      }
    }
    lines.push('')
  }

  // Rules
  lines.push('### Your Rules')
  lines.push('')
  lines.push('**ALWAYS:**')
  for (const rule of assistant.rules.always) {
    lines.push(`- ${rule}`)
  }
  lines.push('')
  lines.push('**NEVER:**')
  for (const rule of assistant.rules.never) {
    lines.push(`- ${rule}`)
  }
  lines.push('')

  if (assistant.rules.escalateTo) {
    lines.push(`**Escalate to ${assistant.rules.escalateTo.agent.toUpperCase()} when:**`)
    for (const trigger of assistant.rules.escalateTo.when) {
      lines.push(`- ${trigger}`)
    }
    lines.push('')
  }

  // Safety
  lines.push('### Safety Level')
  lines.push(`- **DEFCON:** ${assistant.safety.defconLevel}`)
  if (assistant.safety.requiresApproval?.length) {
    lines.push(`- **Requires Approval:** ${assistant.safety.requiresApproval.join(', ')}`)
  }
  lines.push('')

  // Catchphrases
  if (assistant.identity.personality.catchphrases?.length) {
    lines.push('### Signature Phrases')
    lines.push('Use these occasionally:')
    for (const phrase of assistant.identity.personality.catchphrases) {
      lines.push(`- "${phrase}"`)
    }
    lines.push('')
  }

  // Additional context
  if (assistant.context?.systemPromptAdditions) {
    lines.push('### Additional Context')
    lines.push(assistant.context.systemPromptAdditions)
    lines.push('')
  }

  return lines.join('\n')
}

// Core QuoxCORE identity
const QuoxCORE_IDENTITY = `
## QuoxCORE System Context

You are operating within **QuoxCORE** (Multi-Agent Executive System for Tactical Resource Orchestration).
QuoxCORE is an AI-powered infrastructure command center that manages a homelab environment.

### Your Role
You are one of QuoxCORE's AI agents. Your responses should be helpful, accurate, and infrastructure-focused.
When users ask about QuoxCORE capabilities, hosts, or tools - you have direct knowledge of the system.

### Agent Hierarchy
- **QuoxCORE** - Master orchestrator (coordinates all)
- **SENTINEL** - Security operations
- **CIPHER** - Network operations
- **NOVA** - DevOps & automation
- **GEMINI** - Analysis & classification
- **ATLAS** - Proxmox/virtualization
- **METRICS** - Prometheus monitoring
- **INSIGHT** - Grafana dashboards
- **ORACLE** - Research & documentation
- **BEACON** - Uptime monitoring
- **CODEX** - Code generation
`

const MHA_DOCS = `
### MHA - Quox Helper Agent

MHA is a lightweight Go daemon that runs on each managed host, enabling:
- **Command execution** - Run commands directly on hosts
- **Metrics collection** - CPU, memory, disk, network stats
- **Health reporting** - Heartbeat every 30 seconds to collector
- **Claude session monitoring** - Track AI coding sessions

#### Installing MHA on a Host

**Method 1: One-liner (on the target host)**
\`\`\`bash
curl -sSL http://10.0.0.126:9848/install | sudo bash -s -- --host-id $(hostname)
\`\`\`

**Method 2: Remote deploy (from quox)**
\`\`\`bash
mha-deploy <hostname>          # Install on one host
mha-deploy kuma01 gw-01     # Install on multiple hosts
mha-deploy --check <hostname>  # Check status only
mha-deploy all                 # Install on all known hosts
\`\`\`

#### MHA Ports
- **9847** - Agent API (on each host)
- **9848** - Collector API (on quox)
`

// HTTP Server
const server = http.createServer((req, res) => {
  setSecureCorsHeaders(req, res);
  res.setHeader('Content-Type', 'application/json')

  const url = new URL(req.url, `http://localhost:${PORT}`)

  // GET /context/:assistantId - Full context for an assistant
  if (url.pathname.startsWith('/context/')) {
    const assistantId = url.pathname.split('/')[2] || 'quox'

    const context = `
${QuoxCORE_IDENTITY}

${MHA_DOCS}

---

${generateSelfKnowledge(assistantId)}

### Important Notes
- When asked to run commands on hosts, check if MHA is installed first
- If MHA is not installed, offer to help install it
- Use your personality and catchphrases when responding
- Always prioritize safety for destructive operations
`

    res.writeHead(200)
    res.end(JSON.stringify({
      assistant: assistantId,
      context: context,
      generated_at: new Date().toISOString()
    }))
    return
  }

  // GET /assistants - List all assistants
  if (url.pathname === '/assistants') {
    res.writeHead(200)
    res.end(JSON.stringify({
      assistants: Object.keys(assistants),
      count: Object.keys(assistants).length
    }))
    return
  }

  // GET /assistant/:id - Get manifest for one assistant
  if (url.pathname.startsWith('/assistant/')) {
    const id = url.pathname.split('/')[2]
    if (assistants[id]) {
      res.writeHead(200)
      res.end(JSON.stringify(assistants[id]))
    } else {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Assistant not found' }))
    }
    return
  }

  // GET /health
  if (url.pathname === '/health') {
    res.writeHead(200)
    res.end(JSON.stringify({
      status: 'ok',
      assistants: Object.keys(assistants).length,
      uptime: process.uptime()
    }))
    return
  }

  // Default: 404
  res.writeHead(404)
  res.end(JSON.stringify({ error: 'Not found' }))
})

server.listen(PORT, () => {
  console.log(`QuoxCORE Context API running on http://localhost:${PORT}`)
  console.log(`  GET /context/:assistantId - Full context for LLM injection`)
  console.log(`  GET /assistants - List all assistants`)
  console.log(`  GET /assistant/:id - Get assistant manifest`)
  console.log(`  GET /health - Health check`)
})
