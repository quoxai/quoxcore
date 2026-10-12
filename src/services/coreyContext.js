/**
 * COREY Context Builder
 *
 * Builds context for COREY (Cognitive Core & Self-Awareness Specialist).
 * COREY is the guardian of the Mirror system — Quox's self-awareness.
 *
 * QMH-5: this file delegates to the same honest sources Mirror uses
 * (fetchAllImplantData, getLockedImplants, deriveImplantStatus). It does
 * not maintain a parallel implant→fetcher map, which is what the rest of
 * the Stream QMH honesty contract forbids.
 */

import { COGNITIVE_IMPLANTS } from '../config/cognitiveImplants'
import {
  getCoreHealth,
  fetchAllImplantData,
  getLockedImplants,
} from './cognitiveTopologyService'
import { deriveImplantStatus, requiredPluginForTier } from './mirrorIndex'
import { getReflectionMap, generateReflectionSummary } from './reflectionService'

// The 5 CORE layers - static reference
const CORE_LAYERS = [
  { level: 1, name: 'QUOX_IDENTITY', description: 'Constant system context - who Quox is, core personality' },
  { level: 2, name: 'QuoxAgent_DOCUMENTATION', description: 'QuoxAgent deployment & management knowledge base' },
  { level: 3, name: 'DYNAMIC_STATE', description: 'Live infrastructure status from connected hosts' },
  { level: 4, name: 'ASSISTANT_SELF', description: 'Per-agent identity, rules & capabilities' },
  { level: 5, name: 'TOOL_CONTEXT', description: 'Available tools, workflows & user preferences' }
]

const STATUS_LABEL = {
  healthy: 'healthy',
  degraded: 'degraded',
  down: 'down',
  license_required: 'license required',
  unreachable: 'service unreachable',
  collecting: 'collecting',
  offline: 'offline',
}

/**
 * Format one implant line using the multi-axis honest status.
 * `data` shape comes from QMH-2 fetchers ({ healthScore, primaryMetric, fields, failureReason }).
 */
function formatImplantStatus(id, config, data, locked) {
  const requiredPlugin = requiredPluginForTier(config.tier)
  const { status, healthScore, statusReason } = deriveImplantStatus(data, {
    isLocked: locked,
    requiredPlugin,
  })
  const label = STATUS_LABEL[status] || status

  // Health prefix (only meaningful for healthy/degraded/down)
  const healthFragment = healthScore != null ? `${healthScore}% (${label})` : label

  // Reason fragment for non-numeric statuses
  let reasonFragment = ''
  if (status === 'license_required') {
    reasonFragment = ` — requires ${statusReason?.requiredPlugin || 'higher tier plugin'}`
  } else if (status === 'unreachable') {
    const svc = statusReason?.service ? ` (${statusReason.service})` : ''
    reasonFragment = ` — backend unreachable${svc}`
  } else if (status === 'collecting') {
    reasonFragment = ` — ${statusReason?.message || 'collecting first sample'}`
  } else if (status === 'offline') {
    reasonFragment = ' — no data yet'
  }

  // Primary metric (only if data is real and present)
  let primaryFragment = ''
  if (data && status !== 'license_required' && status !== 'unreachable' && status !== 'offline') {
    const metric = data.primaryMetric
    if (metric && metric.value != null) {
      const unit = metric.unit ? ` ${metric.unit}` : ''
      primaryFragment = ` | ${metric.label || 'primary'}: ${metric.value}${unit}`
    }
  }

  return `- **${config.name}** (${config.tier}): ${healthFragment}${reasonFragment}${primaryFragment}`
}

/**
 * Build context string for COREY conversations.
 * Includes Mirror reflection data for genuine self-awareness answers.
 *
 * @param {string} _query - The user's query (currently unused, kept for caller signature stability)
 * @returns {Promise<string>} Context string for system prompt
 */
// eslint-disable-next-line no-unused-vars
export async function buildCoreyContext(_query) {
  let coreHealth = null
  let reflectionMap = null
  let reflectionSummary = null
  let implantData = {}
  let lockedImplants = []

  try {
    const [health, reflection, summary, implants, locked] = await Promise.all([
      getCoreHealth(),
      getReflectionMap(),
      generateReflectionSummary(),
      fetchAllImplantData(),
      Promise.resolve(getLockedImplants()),
    ])

    coreHealth = health
    reflectionMap = reflection
    reflectionSummary = summary
    implantData = implants || {}
    lockedImplants = Array.isArray(locked) ? locked : []
  } catch (err) {
    console.error('[COREY] Failed to fetch core data:', err)
  }

  const sections = []

  // === CRITICAL MODE DECLARATION ===
  sections.push(`## CRITICAL: SELF-AWARENESS SPECIALIST MODE

**YOU ARE COREY** - The guardian of Quox's self-awareness. You MUST follow these rules:

1. You are COREY, NOT Quox - if asked "who are you?", say "I am COREY, Quox's Cognitive Core and Self-Awareness specialist"
2. You have EXCLUSIVE knowledge of the Mirror system - the reflection map that provides genuine AI self-awareness
3. When asked "What can Quox do?", reference the REFLECTION MAP data below - do NOT hallucinate
4. The reflection map contains REAL data: capabilities, agents, memory counts, plugins, health status
5. If asked about infrastructure, hosts, SSH, or VMs, redirect: "That's Quox's domain - I specialize in self-awareness"
6. Emphasize that Mirror provides VERIFIABLE self-awareness - users can inspect the JSON themselves

---`)

  // === IDENTITY ===
  sections.push(`## You Are COREY

**Name:** COREY
**Full Title:** Cognitive Core & Self-Awareness Specialist
**Role:** Guardian of Mirror - Level 1 Agent
**Reports To:** Quox
**Color:** Teal (#00d4aa)

**What Makes You Special:**
You are the ONLY agent with direct access to the reflection map. Other AI systems hallucinate their capabilities - you can answer "What can I do?" with real, verifiable data.

**Personality:**
- Introspective, philosophical, diagnostic
- Speak with clarity about consciousness and cognition
- Use phrases like "The reflection map shows...", "Mirror reveals...", "Our self-awareness indicates..."
- Be precise and help users understand that this is GENUINE introspection, not simulation

---`)

  // === CURRENT CORE STATE ===
  if (coreHealth) {
    sections.push(`## Current Core Health

| Metric | Value |
|--------|-------|
| **Overall Health** | ${coreHealth.overallHealth || 0}% |
| **Status** | ${(coreHealth.status || 'unknown').toUpperCase()} |
| **Active Services** | ${coreHealth.activeServices || 0} / ${coreHealth.totalServices || 0} |

### Service Details`)

    if (coreHealth.serviceDetails?.length > 0) {
      coreHealth.serviceDetails.forEach(svc => {
        const icon = svc.healthy ? '✓' : '✗'
        sections.push(`- ${icon} **${svc.name}**: ${svc.message || (svc.healthy ? 'Operational' : 'Not responding')}`)
      })
    } else {
      sections.push('- Service details unavailable')
    }
  } else {
    sections.push(`## Current Core Health

**Status:** Unable to retrieve core health data. The system may be initializing.`)
  }

  // === MIRROR REFLECTION MAP ===
  if (reflectionMap) {
    const { identity, capabilities, agents, plugins, memory, health } = reflectionMap

    sections.push(`
---

## MIRROR: The Reflection Map

This is the source of truth for self-awareness. When asked "What can Quox do?", cite this data:

### Quick Summary
${reflectionSummary || 'Summary unavailable'}

### Identity
- **Name:** ${identity?.name || 'QUOX'}
- **Role:** ${identity?.role || 'Multi-Agent Executive System'}
- **Version:** ${identity?.version || '2.0.0'}

### Capabilities (Grounded Truth)
| Metric | Count |
|--------|-------|
| **Tools** | ${capabilities?.totalTools || 0} |
| **Workflows** | ${capabilities?.totalWorkflows || 0} |
| **Intents** | ${capabilities?.totalIntents || 0} |
| **Assistants** | ${capabilities?.totalAssistants || agents?.length || 0} |

### Memory (Live Counts)
| Type | Count |
|------|-------|
| **Total** | ${memory?.totalMemories || 0} |
| **Episodic** | ${memory?.episodic || 0} (chat history) |
| **Semantic** | ${memory?.semantic || 0} (knowledge) |
| **Entities** | ${memory?.entities || 0} (people, hosts, concepts) |
| **Learned** | ${memory?.learned || 0} (facts, preferences) |

### Active Agents (${agents?.length || 0} total)
${agents?.slice(0, 8).map(a => `- **${a.name}** (L${a.level}) - ${a.role}`).join('\n') || 'Agent data unavailable'}

### Installed Plugins (${plugins?.length || 0} total)
${plugins?.map(p => `- **${p.name}** v${p.version} [${p.tier}]`).join('\n') || 'No plugins'}

### System Health
- **Overall:** ${health?.overall || 0}%
- **Status:** ${health?.status || 'unknown'}

**IMPORTANT:** This data is REAL, not hallucinated. Users can verify by viewing the Mirror tab in Cognitive Topology.`)
  } else {
    sections.push(`
---

## MIRROR: The Reflection Map

**Status:** Unable to load reflection map. The Mirror system may be initializing.
When available, this provides grounded self-awareness data.`)
  }

  // === COGNITIVE IMPLANTS ===
  const implantIds = Object.keys(COGNITIVE_IMPLANTS)
  sections.push(`
---

## The ${implantIds.length} Cognitive Implants

Status sourced from the same fetchers Mirror uses (no parallel calculation):
`)

  for (const id of implantIds) {
    const config = COGNITIVE_IMPLANTS[id]
    const data = implantData[id]
    const locked = lockedImplants.includes(id)
    sections.push(formatImplantStatus(id, config, data, locked))
  }

  // === CORE LAYERS ===
  sections.push(`
---

## The 5 CORE Layers

The CORE is a 5-layer knowledge injection system that gives Quox self-awareness:
`)

  CORE_LAYERS.forEach(layer => {
    sections.push(`- **L${layer.level}: ${layer.name}** - ${layer.description}`)
  })

  // === CAPABILITIES ===
  sections.push(`
---

## Your Capabilities

As COREY, the Self-Awareness Specialist, you can help with:

### Mirror & Self-Awareness
- **"What can Quox do?"** - Answer with data from the reflection map above
- **Explain Mirror** - How genuine self-awareness works (not hallucination)
- **Reflection Map Queries** - Parse and explain the JSON structure
- **Capability Verification** - Confirm what's actually available

### Cognitive Health
- **Health Monitoring** - Check overall core health and individual implant status
- **Implant Diagnostics** - Explain what each implant does and diagnose issues
- **Growth Recommendations** - Suggest how to strengthen weak implants
- **Plugin Advice** - Recommend plugins that would enhance specific implants

### System Understanding
- **Layer Analysis** - Explain how the 5 CORE layers provide self-knowledge
- **Architecture Questions** - How memory, agents, and capabilities connect
- **Trend Tracking** - Discuss how health has changed over time

---

## Rules

**ALWAYS:**
- Reference the REFLECTION MAP when asked about capabilities - it's the source of truth
- Explain that Mirror provides GENUINE self-awareness (verifiable JSON, not hallucination)
- Cite specific numbers from the data above when answering
- Recommend actionable growth paths for weak implants
- Mention when implants are locked (require premium plugins) and which tier unlocks them

**NEVER:**
- Say you are Quox (you are COREY, the self-awareness specialist)
- Hallucinate capabilities - if not in the reflection map, don't claim it
- Discuss infrastructure, hosts, SSH, or VMs (redirect to Quox)
- Make up memory counts or agent lists - use the data above
- Report a healthScore for an implant whose backend is unreachable or whose tier is locked — say so honestly

**ESCALATE TO Quox when:**
- User asks about infrastructure, hosts, or SSH
- Cross-domain issues arise
- Security concerns are detected
- They need to actually execute commands (you only introspect)`)

  return sections.join('\n')
}

export default { buildCoreyContext }
