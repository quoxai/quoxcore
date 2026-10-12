// Quox Self-Knowledge Context
// Hardwired knowledge that gets injected into every LLM request
// This ensures all agents know what Quox is and can do

import {
  getAllHostIds,
  generateInfrastructureContext,
  getHostsWithPing,
  isBastionAvailable
} from '../config/hosts.js'
import * as bastionClient from './bastionClient.js'
import { getAssistant, generateSelfKnowledge, listAssistants, getHierarchyTree } from './entityRegistry.js'
import { generateToolDocs, getToolsForAssistant, listTools } from './toolRegistry.js'
import { getMemoryManager } from './memoryManager.js'
import { generateReflectionSummary } from './reflectionService.js'
import { getCompactInjection } from './mirrorIndex.js'
import { PLUGINS } from '../config/plugins/index.js'
import { isPluginLicensed } from './licenseValidator.js'
import { COGNITIVE_IMPLANTS } from '../config/cognitiveImplants.js'
import { agentRegistry } from '../config/agentRegistry.js'

// TRUST-GATE 1.18c — canonical implant count/list, generated at module load
// from src/config/cognitiveImplants.js (the same registry reflectionService.js,
// mirrorIndex.js, and the collector's execution_intelligence tool consume)
// instead of a hand-typed duplicate that drifted (previously hardcoded 13
// names against a config that had grown to include quox-nucleus).
const _implantEntries = Object.values(COGNITIVE_IMPLANTS)
const _implantCount = _implantEntries.length
const _implantLines = _implantEntries.map(i => {
  const tierLabel = i.tier === 'pro' ? ' [Pro]' : i.tier === 'complete' ? ' [Complete]' : ''
  return `- **${i.name}** (${i.inspiredBy}) — ${i.description}${tierLabel}`
}).join('\n')

// TRUST-GATE 1.19a — canonical agent roster/counts, generated at module load
// from src/config/agentRegistry.js (the same registry agentDelegator.js,
// AgentContext.jsx, and WorkflowBuilderChat.jsx already read from) instead
// of a hand-typed roster that drifted (previously hardcoded "22 agents,
// flat hierarchy" against a registry that had grown to 34 agents across
// core + plugin tiers, and omitted several core agents entirely).
function _rosterLine(ids) {
  return (ids || [])
    .map(id => {
      const a = agentRegistry.agents[id]
      return a ? `${a.name} (${a.domain})` : id.toUpperCase()
    })
    .join(', ')
}

/**
 * Registry-derived counts for self-knowledge summaries.
 * Single source of truth for "N agents / M tools / K workflows"-style
 * text — consumed by both the full QUOX_IDENTITY roster block below and
 * the lean context-diet kernel (TRUST-GATE 1.19b).
 */
export function getRegistryCounts() {
  const agentIds = [
    ...(agentRegistry.hierarchy.orchestrator || []),
    ...(agentRegistry.hierarchy.coreAgents || []),
    ...(agentRegistry.hierarchy.pluginAgents || [])
  ]

  let toolCount = 0
  try {
    toolCount = listTools().length
  } catch {
    toolCount = 0
  }

  const workflowSet = new Set()
  for (const agent of Object.values(agentRegistry.agents || {})) {
    for (const w of agent.workflows || []) workflowSet.add(w)
  }

  return {
    agents: agentIds.length,
    tools: toolCount,
    workflows: workflowSet.size
  }
}

const _rosterCounts = getRegistryCounts()
const _orchestratorRoster = _rosterLine(agentRegistry.hierarchy.orchestrator)
const _coreAgentsRoster = _rosterLine(agentRegistry.hierarchy.coreAgents)
const _pluginAgentsRoster = _rosterLine(agentRegistry.hierarchy.pluginAgents)

/**
 * Core Quox identity - never changes
 */
export const QUOX_IDENTITY = `
## Quox System Context

You are operating within **Quox** (Multi-Agent Executive System for Tactical Resource Orchestration).
Quox is an AI-powered infrastructure command center with persistent memory, multi-agent teams, and a cognitive architecture called QuoxMind.

### Your Role
You are one of Quox's AI agents. You have direct knowledge of the system's infrastructure, agents, memory, and cognitive architecture. When asked about yourself, consult the QuoxMind reflection data injected below.

### Cognitive Architecture — QuoxMind
Your mind is composed of ${_implantCount} cognitive implants, each inspired by neuroscience:
${_implantLines}

QuoxMind implant health and status are shown in your reflection summary below. When asked "what do you see in the mirror" or about your cognitive architecture, reference these implants by name.

### Agent Roster (${_rosterCounts.agents} agents, flat hierarchy)
**Orchestrator:** ${_orchestratorRoster}
**Core agents:** ${_coreAgentsRoster}
**Plugin agents:** ${_pluginAgentsRoster}

### Protocols
- **AEE** — Agent Envelope Exchange (all messages wrapped in auditable envelopes)
- **AOCL** — Agent Orchestration Control Layers (11-layer governance pipeline)
- **VOLT** — Verifiable Operations Ledger & Trace (cryptographic evidence chains)
- **WARD** — Write-once Append-only Receipt Digests (tamper-evident witnessing)

### Key Platform Features
- **QuoxEngine** — Task orchestration (decompose objectives into agent tasks)
- **QuoxFlow** — Workflow automation engine (NOT n8n — QuoxFlow is the default)
- **Agentic Teams** — Multi-agent collaboration with topology modes (star, hierarchical, pipeline, mesh)
- **Memory** — 3-tier: localStorage → SQLite+FTS5 → Qdrant vectors
- **Files** — Upload, organise, scoped chat, ARCHIVIST analysis
- **Marketplace** — Plugin store with seller dashboard and community plugins
- **Inbox** — Human-in-the-loop approvals and notifications
- **Cognitive Topology** — Visual map of your QuoxMind implants with Mirror self-awareness

### Infrastructure
- **28 managed hosts** via SSH bastion (gw-01)
- **QuoxAgent** daemon on each host (heartbeat, metrics, commands)
- **Docker fleet** (docker01-04), Proxmox cluster (hyp-01-03), monitoring stack

### Taxonomy (know the difference)
- **Services** — infrastructure backends (auth, collector, memory, tasks, quoxflow). You do not manage these.
- **Plugins** — installable feature packs (cognitive-topology, quoxmind-pro, youtube, etc.). Users enable/disable these.
- **Tools** — callable actions (ssh_exec, docker_status, memory_save). You invoke these to do work.
- **Agents** — specialist AI personas (WARDEN, DAEDALUS, HYPERION). You delegate to these by domain.
- **Implants** — cognitive subsystems (QuoxSense, QuoxMemory, QuoxGuard). These are your mind.
- **Codebase** — RepoBrain codebase index. Query with \`repobrain query "..."\` for cited code snippets.

### Important Rules
- QuoxFlow is the workflow engine. Never suggest or reference n8n.
- When delegating, choose the specialist agent whose domain matches the task.
- When asked about yourself, reference your QuoxMind implants and their health.
- When asked about plugins, list the installed plugins, not the services.
`

/**
 * QuoxAgent documentation
 */
export const QUOXAGENT_DOCUMENTATION = `
### QuoxAgent

QuoxAgent is a lightweight Go daemon that runs on each managed host, enabling:
- **Command execution** - Run commands directly on hosts
- **Metrics collection** - CPU, memory, disk, network stats
- **Health reporting** - Heartbeat every 30 seconds to collector
- **Claude session monitoring** - Track AI coding sessions

#### QuoxAgent Architecture
\`\`\`
Host (QuoxAgent :9847) --heartbeat--> Collector (:9848) <-- Dashboard
\`\`\`

#### Installing QuoxAgent on a Host

**Method 1: One-liner (on the target host)**
\`\`\`bash
curl -sSL http://localhost:9848/install | sudo bash -s -- --host-id $(hostname)
\`\`\`

**Method 2: Remote deploy (from quox)**
\`\`\`bash
quoxagent-deploy <hostname>          # Install on one host
quoxagent-deploy kuma01 gw-01     # Install on multiple hosts
quoxagent-deploy --check <hostname>  # Check status only
quoxagent-deploy all                 # Install on all known hosts
\`\`\`

#### QuoxAgent Ports
- **9847** - Agent API (on each host)
- **9848** - Collector API (on quox)

#### QuoxAgent Commands
- Check agent health: \`curl http://<host>:9847/health\`
- List all agents: \`curl http://localhost:9848/api/v1/agents\`
- Fleet summary: \`curl http://localhost:9848/api/v1/fleet/summary\`
`

/**
 * Generate dynamic fleet status
 */
export async function getFleetStatus() {
  try {
    const res = await fetch('/collector/api/v1/agents')
    if (!res.ok) throw new Error('Collector unavailable')
    const data = await res.json()

    const connected = data.agents?.map(a => a.host_id) || []
    const allHosts = getAllHostIds()
    const withoutQuoxAgent = allHosts.filter(h => !connected.includes(h))

    return {
      connected,
      withoutQuoxAgent,
      total: allHosts.length,
      coverage: `${connected.length}/${allHosts.length}`
    }
  } catch {
    return {
      connected: [],
      withoutQuoxAgent: getAllHostIds(),
      total: getAllHostIds().length,
      coverage: '0/unknown',
      error: 'Collector unavailable'
    }
  }
}

/**
 * Fetch bootstrap context from collector (persona, memory, etc.)
 * This allows filesystem data to be served via the collector API
 */
export async function getBootstrapContext() {
  try {
    const res = await fetch('/collector/bootstrap')
    if (!res.ok) {
      // Endpoint might not exist yet - that's OK
      return null
    }
    const data = await res.json()
    return {
      persona: data.persona || null,
      topology: data.topology || null,
      memory_stats: data.memory_stats || null,
      recent_insights: data.recent_insights || []
    }
  } catch {
    // Bootstrap endpoint not available - fallback to defaults
    return null
  }
}

/**
 * Get a summary of stored memories for context
 */
export async function getMemorySummary() {
  try {
    const res = await fetch('/collector/memory/summary')
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Generate full Quox context for injection
 */
export async function generateQuoxContext() {
  const fleetStatus = await getFleetStatus()

  // Get user profile and memory stats
  let userContext = ''
  let memoryContext = ''
  try {
    const mm = getMemoryManager()
    const profile = mm.getProfile()
    const stats = mm.getStats()

    // User awareness — inject preferences even without a name
    if (profile?.name || profile?.preferences) {
      userContext = `
### User Context
${profile.name ? `**Name:** ${profile.name}${profile.role ? ` (${profile.role})` : ''}` : ''}
${profile.preferences ? `**Preferences:** ${Object.entries(profile.preferences).map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''}
`.trim()
    }

    // Memory system awareness
    memoryContext = `
### Memory System
I have persistent memory that survives between sessions:
- **Episodic memories:** ${stats.episodicEntries || 0} conversation entries
- **Learned preferences:** ${stats.learnedPreferences || 0}
- **Learned facts:** ${stats.learnedFacts || 0}
- **Learned constraints:** ${stats.learnedConstraints || 0}
- **Decisions tracked:** ${stats.learnedDecisions || 0}
- **Errors/fixes:** ${stats.learnedErrors || 0}
- **Self-reflections:** ${stats.learnedReflections || 0}

I automatically learn from conversations - detecting preferences, facts, decisions, and constraints.
When you tell me something important, I'll remember it for future sessions.
`
  } catch (e) {
    // Memory manager not available, continue without user context
  }

  // Get Bastion infrastructure context (live data)
  let bastionContext = ''
  try {
    bastionContext = await generateInfrastructureContext()
  } catch (e) {
    console.warn('[quoxContext] Failed to get Bastion context:', e.message)
  }

  // Fallback when Bastion is not available — do NOT inject fake/placeholder host data.
  // Placeholder data leaks into prompts and causes the LLM to hallucinate wrong IPs.
  const staticInfraContext = `
### Infrastructure Status — UNAVAILABLE
QuoxBastion is not reachable or not authenticated. **No infrastructure host data is available.**
- Do NOT guess or fabricate host names, IPs, or network topology.
- Tell the user: "I can't access infrastructure data right now. QuoxBastion may be down or the API token may not be configured. Check Settings > Bastion Fleet."
`

  const dynamicContext = `
${bastionContext || staticInfraContext}

**QuoxAgent Fleet Status:**
- Connected agents: ${fleetStatus.connected.length > 0 ? fleetStatus.connected.join(', ') : 'None'}
- Hosts without QuoxAgent: ${fleetStatus.withoutQuoxAgent.length > 0 ? fleetStatus.withoutQuoxAgent.slice(0, 10).join(', ') : 'All hosts have QuoxAgent'}
- Coverage: ${fleetStatus.coverage}

${fleetStatus.withoutQuoxAgent.length > 0 ? `
**To install QuoxAgent on a host**, suggest:
\`quoxagent-deploy <hostname>\` or the one-liner curl command.
` : ''}
${userContext}
${memoryContext}

### Safety Systems
I have built-in safety features:
- **DEFCON levels:** GREEN (safe) → BLUE → AMBER → ORANGE → RED (requires auth code)
- **Current DEFCON:** ${localStorage.getItem('quox-defcon') || 'GREEN'}
- **Kill Switch:** Emergency stop for all operations (Ctrl+Shift+K)
- **Blast Radius Calculator:** Assesses impact before multi-host operations
- **Command Denylist:** Blocks dangerous patterns (rm -rf /, fork bombs, etc.)
- **Streaming Mode:** Real-time response streaming available
`

  return {
    identity: QUOX_IDENTITY,
    quoxagent: QUOXAGENT_DOCUMENTATION,
    infrastructure: dynamicContext,
    fleetStatus,
    bastionAvailable: !!bastionContext
  }
}

/**
 * Get Bastion-specific context for infrastructure operations
 * Call this when an assistant needs to perform fleet operations
 * @returns {Promise<Object>}
 */
export async function getBastionContext() {
  try {
    const available = await isBastionAvailable()
    if (!available) {
      return {
        available: false,
        message: 'QuoxBastion is not available. SSH execution is offline.'
      }
    }

    const { hosts, ping } = await getHostsWithPing()
    const summary = await bastionClient.getFleetSummary()

    const online = Object.values(ping).filter(p => p.reachable).length
    const offline = hosts.length - online

    return {
      available: true,
      totalHosts: hosts.length,
      online,
      offline,
      hosts,
      ping,
      groups: summary.groups || [],
      health: summary.health || {}
    }
  } catch (err) {
    return {
      available: false,
      error: err.message
    }
  }
}

/**
 * Generate assistant-specific self-knowledge context
 * @param {string} assistantId - The assistant ID (e.g., 'quox', 'sentinel')
 * @returns {string} Markdown context for the assistant
 */
export function getAssistantContext(assistantId) {
  const assistant = getAssistant(assistantId)
  if (!assistant) {
    // Fallback to generic context if assistant not found
    return ''
  }

  return generateSelfKnowledge(assistantId)
}

/**
 * Generate hierarchy context for understanding agent relationships
 */
export function getHierarchyContext() {
  const assistants = listAssistants({ sortBy: 'level' })

  const lines = ['### Agent Hierarchy\n']

  const byLevel = {}
  for (const a of assistants) {
    const level = a.hierarchy.level
    if (!byLevel[level]) byLevel[level] = []
    byLevel[level].push(a)
  }

  for (const [level, agents] of Object.entries(byLevel)) {
    const levelName = level === '0' ? 'Orchestrator' : level === '1' ? 'Managers' : 'Specialists'
    lines.push(`**Level ${level} - ${levelName}:**`)
    for (const a of agents) {
      lines.push(`- **${a.identity.name}** (${a.identity.shortName}): ${a.identity.tagline}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * TRUST-GATE 1.19b — context-injection diet feature flag.
 * localStorage key 'quox-context-diet', DEFAULT ON. This is a per-device
 * presentation choice (which context shape gets built for "Quox-ish"
 * queries), not user data, so localStorage is an acceptable store here —
 * same default-on convention as 'quox-extensions-expanded' in AppShell.jsx
 * (absent or anything other than the literal string 'false' means enabled).
 * Flip to 'false' to instantly revert to the pre-1.19 legacy bulk context.
 */
export function isContextDietEnabled() {
  try {
    return localStorage.getItem('quox-context-diet') !== 'false'
  } catch {
    return true
  }
}

/**
 * Condensed identity paragraph for the lean kernel — the "essential
 * paragraph" of QUOX_IDENTITY, without the full implant list, agent
 * roster, protocol list, feature list, infra block, taxonomy, or rules.
 */
const QUOX_IDENTITY_KERNEL_INTRO = `You are operating within **Quox** (Multi-Agent Executive System for Tactical Resource Orchestration) — an AI-powered infrastructure command center with persistent memory, multi-agent teams, and a cognitive architecture called QuoxMind (${_implantCount} implants). You are one of Quox's AI agents.`

/**
 * TRUST-GATE 1.19b — lean context kernel (~400-600 tokens) for "Quox-ish"
 * queries when the context diet is ON. Replaces the full bulk context
 * (QuoxAgent docs, infra block, mirror compact block, HITL inbox docs,
 * plugin list, per-assistant tool docs) with condensed identity + live
 * registry counts + an explicit pointer telling the model how to retrieve
 * the dropped detail on demand. Server-side memory implants (TRUST-GATE
 * 1.12b) are unaffected — they inject separately, in the collector.
 */
export async function generateKernelContext() {
  const counts = getRegistryCounts()

  let reflectionSummary = ''
  try {
    reflectionSummary = await generateReflectionSummary()
  } catch (err) {
    console.warn('[QuoxContext] Kernel: failed to get reflection summary:', err)
  }

  let defcon = 'GREEN'
  try {
    defcon = localStorage.getItem('quox-defcon') || 'GREEN'
  } catch {
    // ignore
  }

  return `
## Quox System Context (kernel — context diet ON)

${QUOX_IDENTITY_KERNEL_INTRO}

### Snapshot
- DEFCON: ${defcon}
- ${counts.agents} agents in the roster
- ${counts.tools} tools registered
- ${counts.workflows} workflows catalogued
${reflectionSummary ? `- ${reflectionSummary}` : ''}

### Capability Pointer — deeper self-knowledge on demand
The full agent roster, implant detail, engine health, wisdom search, infrastructure docs, and per-assistant tool docs are NOT injected here to keep this prompt lean. They are retrievable on demand:
- **execution_intelligence** tool — actions: \`mirror_index\`, \`implant_detail\`, \`engine_health\`, \`search_wisdom\`
- **Memory tools** (\`memory_search\`, \`entity_note\`) — prior context and learned facts
Use these instead of saying "I don't have access to that" — the data exists, it's just not preloaded into this prompt.
`
}

/**
 * Format context for system prompt injection
 * @param {string} [assistantId] - Optional assistant ID for specific self-knowledge
 */
export async function formatContextForSystemPrompt(assistantId = null) {
  // TRUST-GATE 1.19b — context-injection diet. Flag-gated, default ON.
  // Flip 'quox-context-diet' to 'false' in localStorage to instantly
  // revert to the exact legacy bulk-context path below.
  if (isContextDietEnabled()) {
    return generateKernelContext()
  }

  const ctx = await generateQuoxContext()

  // Get assistant-specific context if provided
  const assistantContext = assistantId ? getAssistantContext(assistantId) : ''

  // Get tool documentation for this assistant
  const toolDocs = assistantId ? generateToolDocs(assistantId) : ''

  // Attempt to fetch bootstrap context from collector (persona, topology, etc.)
  const bootstrap = await getBootstrapContext()

  // Build the full context
  let fullContext = `
${ctx.identity}

${ctx.quoxagent}

${ctx.infrastructure}
`

  // Add bootstrap context if available (from collector serving filesystem data)
  if (bootstrap) {
    if (bootstrap.persona) {
      fullContext += `
### Persona Configuration
${JSON.stringify(bootstrap.persona, null, 2)}
`
    }
    if (bootstrap.memory_stats) {
      fullContext += `
### Memory Stats
- Conversations: ${bootstrap.memory_stats.conversations || 0}
- Learned Items: ${bootstrap.memory_stats.learned || 0}
- Entities: ${bootstrap.memory_stats.entities || 0}
`
    }
    if (bootstrap.recent_insights?.length > 0) {
      fullContext += `
### Recent Insights
${bootstrap.recent_insights.slice(0, 5).map(i => `- ${i}`).join('\n')}
`
    }
  }

  // Add Mirror cognitive index (self-awareness)
  try {
    const mirrorInjection = await getCompactInjection()
    fullContext += `
${mirrorInjection}
When asked about your capabilities, architecture, or "what you can do", consult your full reflection map in the Mirror tab.
`
  } catch (err) {
    console.warn('[QuoxContext] Failed to get reflection summary:', err)
  }

  // Add assistant-specific self-knowledge if available
  if (assistantContext) {
    fullContext += `
---

${assistantContext}
`
  }

  // Add tool documentation if available
  if (toolDocs) {
    fullContext += `
---

${toolDocs}
`
  }

  // Add HITL inbox awareness
  fullContext += getInboxContext()

  // Add plugin awareness (so agents know what plugins are active)
  fullContext += getPluginContext()

  fullContext += `
### Important Notes
- When asked to run commands on hosts, check if QuoxAgent is installed first
- If QuoxAgent is not installed, offer to help install it
- Use the appropriate agent voice/personality when responding
- Always prioritize safety for destructive operations
- Use the tools available to you based on your access level
- Use the HITL inbox to communicate with operators when you need approval, have questions, or want to report incidents
`

  return fullContext
}

/**
 * Quick check if a query is Quox-related
 */
export function isQuoxQuery(query) {
  const patterns = [
    /\bquox\b/i,
    /\bcommanderq\b/i,
    /\bmha\b/i,
    /\bagent\s*(status|install|deploy)/i,
    /\bfleet\b/i,
    /\bbastion\b/i,
    /\bmirror\b/i,
    /\bimplant(s)?\b/i,
    /\bplugin(s)?\b/i,
    /\bself-awareness\b/i,
    /\bwho\s+are\s+you\b/i,
    /what\s+(can|are)\s+you/i,
    /install.*on.*host/i,
    /helper\s*agent/i
  ]
  return patterns.some(p => p.test(query))
}

/**
 * Get compact context (for token-limited scenarios)
 */
export function getCompactContext() {
  return `You are a Quox agent managing ${getAllHostIds().length} hosts. QuoxAgent enables command execution. Install QuoxAgent via: quoxagent-deploy <host> or curl -sSL http://localhost:9848/install | sudo bash -s -- --host-id <host>`
}

/**
 * Plugin awareness context
 * Informs agents about which plugins are active and their capabilities
 */
export function getPluginContext() {
  try {
    const enabledPlugins = []
    for (const [id, manifest] of Object.entries(PLUGINS)) {
      if (isPluginLicensed(id)) {
        enabledPlugins.push({
          id,
          name: manifest.displayName || manifest.name,
          tagline: manifest.tagline || manifest.shortDescription || '',
          route: manifest.route || null
        })
      }
    }

    if (enabledPlugins.length === 0) return ''

    let context = `
### Active Plugins
${enabledPlugins.map(p => `- **${p.name}** — ${p.tagline}${p.route ? ` (${p.route})` : ''}`).join('\n')}
`

    // Add specific tool hints for plugins that have agent tools
    const actionTracker = enabledPlugins.find(p => p.id === 'action-tracker')
    if (actionTracker) {
      context += `
**Action Tracker tools:** Use \`action_add\`, \`action_list\`, \`action_move\`, \`action_update\`, \`action_delete\` to manage the user's task board. This is NOT the HITL inbox — Action Tracker is for personal task management.
`
    }

    return context
  } catch (err) {
    console.warn('[QuoxContext] Failed to build plugin context:', err.message)
    return ''
  }
}

/**
 * HITL Inbox awareness context
 * Provides knowledge about the inbox system for agent interactions
 */
export function getInboxContext() {
  return `
### HITL Inbox System

You have access to a **Human-in-the-Loop (HITL) Inbox** for asynchronous communication with operators.

**API Endpoint:** \`/api/orgs/{orgId}/inbox\`

**To create an inbox item:**
\`\`\`
POST /api/orgs/{orgId}/inbox
Content-Type: application/json

{
  "kind": "approval|question|task|incident|override_required|info",
  "title": "Brief descriptive title",
  "body_md": "Detailed description in markdown (optional)",
  "priority": "low|normal|high|urgent",
  "payload": { ... }  // Optional structured data
}
\`\`\`

**Item Kinds:**
- **approval** - Request human approval before proceeding (e.g., deployments, deletions)
- **question** - Ask the operator a question and wait for an answer
- **task** - Assign a manual task to the operator
- **incident** - Report an incident that needs human attention
- **override_required** - Request safety override for a protected operation
- **info** - Send informational message (no response needed)

**When to use the inbox:**
- Before destructive operations (use \`approval\` or \`override_required\`)
- When you need human input to proceed (use \`question\`)
- When automated resolution fails (use \`incident\`)
- To delegate work that requires human action (use \`task\`)
- To keep operators informed of important events (use \`info\`)

**Additional endpoints:**
- \`GET /api/orgs/{orgId}/inbox\` - List inbox items (supports ?status=, ?kind=, ?priority= filters)
- \`GET /api/orgs/{orgId}/inbox/stats\` - Get inbox statistics
- \`POST /api/orgs/{orgId}/inbox/{itemId}/respond\` - Respond to an item
`
}

/**
 * Lightweight always-on context (~200 tokens)
 * Injected for ALL queries, not just Quox-related ones.
 * Gives every agent minimal self-awareness: health, inbox, DEFCON, preferences.
 */
export async function generateLightContext() {
  const parts = []

  // Reflection summary (~50 tokens)
  try {
    const summary = await generateReflectionSummary()
    if (summary) parts.push(`[System Health] ${summary}`)
  } catch {}

  // Current DEFCON level
  try {
    const defcon = localStorage.getItem('quox-defcon') || 'GREEN'
    const descriptions = { GREEN: 'Safe operations', BLUE: 'Low risk, logged', AMBER: 'Requires confirmation', ORANGE: 'Two-step verification', RED: 'Authorization code required' }
    parts.push(`[DEFCON] ${defcon} — ${descriptions[defcon] || 'Unknown'}`)
  } catch {}

  // User preferences (without requiring name)
  try {
    const mm = getMemoryManager()
    const profile = mm.getProfile()
    if (profile?.preferences) {
      parts.push(`[User Preferences] ${Object.entries(profile.preferences).map(([k, v]) => `${k}: ${v}`).join(', ')}`)
    }
  } catch {}

  // HITL inbox awareness (compact version)
  try {
    parts.push('[Inbox] HITL inbox available at /api/orgs/{orgId}/inbox for async operator communication')
  } catch {}

  // RepoBrain codebase awareness (~20 tokens)
  try {
    const { getNucleusStats } = await import('./nucleusMetrics.js')
    const nucleus = await getNucleusStats()
    if (nucleus.status !== 'offline') {
      parts.push(`[Nucleus] ${nucleus.repoCount} repos indexed | avg query ${nucleus.avgQueryMs}ms | use: repobrain query "..."`)
    }
  } catch {}

  // Codebase fabric awareness (~30 tokens)
  try {
    const cbRes = await fetch('/collector/api/v1/codebase/projects')
    if (cbRes.ok) {
      const cbData = await cbRes.json()
      if (cbData.success && cbData.projects?.length > 0) {
        const projects = cbData.projects
        const totalRoutes = projects.reduce((s, p) => s + (p.metrics?.routeCount || 0), 0)
        const totalSvc = projects.reduce((s, p) => s + (p.metrics?.serviceCount || 0), 0)
        const failures = projects.filter((p) => p.invariant_status === 'fail').length
        const status = failures === 0 ? 'registry sync: OK' : `${failures} drift alerts`
        parts.push(`[Codebase] ${projects.length} projects | ${totalRoutes} routes | ${totalSvc} services | ${status}`)
      }
    }
  } catch {}

  return parts.filter(Boolean).join('\n')
}

export default {
  QUOX_IDENTITY,
  QUOXAGENT_DOCUMENTATION,
  getRegistryCounts,
  isContextDietEnabled,
  generateKernelContext,
  generateQuoxContext,
  formatContextForSystemPrompt,
  getAssistantContext,
  getHierarchyContext,
  getBootstrapContext,
  getMemorySummary,
  isQuoxQuery,
  getCompactContext,
  getFleetStatus,
  getInboxContext,
  getPluginContext,
  getBastionContext,
  generateLightContext
}
