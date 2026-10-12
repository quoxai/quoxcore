/**
 * ArchitectChat — Sidebar chat for the ARCHITECT agent
 *
 * TWR-3: Follows the WorkflowBuilderChat pattern.
 * - ChatEngine wrapper with agent="architect"
 * - contextBuilder injects current agent registry + tool catalog + type configs
 * - Parses `agent-action` code blocks from ARCHITECT's responses
 * - Renders AgentActionCard inline with Apply/Edit/Cancel buttons
 * - Apply calls auth API to create agents/tools
 */

import { useState, useCallback, useMemo } from 'react'
import { parseAgentActions, validateAgentAction, summarizeAction } from './architectParser'
import { buildToolCreatePayload } from './toolApiUtils'
import { ASSISTANT_TYPE_CONFIGS } from './typeConfig'
import { TONE_PRESETS, STYLE_PRESETS, AVAILABLE_TRAITS } from './personalityUtils'
import { agentRegistry } from '../../config/agentRegistry'

/**
 * Build the context string injected into ARCHITECT's system prompt.
 * This tells ARCHITECT what agents, tools, and types exist.
 */
export function buildArchitectContext() {
  // Current agents
  const agentList = Object.entries(agentRegistry.agents || {}).map(([id, a]) => ({
    id, name: a.name, domain: a.domain, tools: (a.tools || []).length,
  }))

  // Available types
  const types = Object.entries(ASSISTANT_TYPE_CONFIGS).map(([id, c]) => ({
    type: id, label: c.label, tabs: c.tabs.length,
  }))

  return `
CURRENT AGENTS (${agentList.length}):
${agentList.map(a => `- ${a.name} (${a.id}): ${a.domain}, ${a.tools} tools`).join('\n')}

AVAILABLE TYPES:
${types.map(t => `- ${t.type}: ${t.label} (${t.tabs} config tabs)`).join('\n')}

TONE PRESETS: ${Object.keys(TONE_PRESETS).join(', ')}
STYLE PRESETS: ${Object.keys(STYLE_PRESETS).join(', ')}
TRAITS: ${AVAILABLE_TRAITS.join(', ')}

When proposing agent/tool creation, use \`\`\`agent-action code blocks.
Format:
\`\`\`agent-action
{
  "action": "create_agent|create_tool|update_agent|assign_tool|set_personality",
  "payload": { ... },
  "target": "agent_id (for updates)"
}
\`\`\`

Always wait for user approval before executing.
`
}

/**
 * Process ARCHITECT's response — extract actions and return parsed results.
 *
 * @param {string} responseText — raw LLM response
 * @returns {{ actions: Array, cleanText: string }}
 */
export function processArchitectResponse(responseText) {
  const actions = parseAgentActions(responseText)
  const validatedActions = actions.map(action => ({
    ...action,
    errors: validateAgentAction(action),
    summary: summarizeAction(action),
  }))

  // Remove action blocks from display text
  const cleanText = responseText.replace(/```agent-action[\s\S]*?```/g, '').trim()

  return { actions: validatedActions, cleanText }
}

/**
 * Execute an ARCHITECT action via auth API.
 *
 * @param {object} action — parsed action from architectParser
 * @param {object} ctx — { authFetch, orgId, navigate }
 * @returns {Promise<{success: boolean, message: string, id?: string}>}
 */
export async function executeArchitectAction(action, { authFetch, orgId }) {
  if (!authFetch || !orgId) {
    return { success: false, message: 'Not authenticated' }
  }

  const p = action.payload || {}

  switch (action.action) {
    case 'create_agent': {
      const persona = {
        assistant_type: p.type || 'agent',
        system_prompt: p.systemPrompt || '',
        personality: p.personality || {},
        color: p.color || '#8b5cf6',
        role: p.role || 'specialist',
        level: p.level ?? 1,
        shortName: p.shortName || (p.name || 'A').slice(0, 2).toUpperCase(),
        specialty: p.domain || '',
        tools: p.tools || [],
        instructions: p.rules?.always || [],
      }

      const resp = await authFetch(`/api/orgs/${orgId}/assistants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: p.name,
          description: p.description || `${p.domain || 'General'} specialist`,
          persona,
          llm: p.llm || { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.7, maxTokens: 4096 },
        })
      })

      if (resp.ok) {
        const data = await resp.json()
        return { success: true, message: `Agent "${p.name}" created`, id: data.assistant?.id }
      }
      const err = await resp.json().catch(() => ({}))
      return { success: false, message: err.error || `HTTP ${resp.status}` }
    }

    case 'create_tool': {
      const toolPayload = buildToolCreatePayload(p)
      const resp = await authFetch(`/api/orgs/${orgId}/tools`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toolPayload),
      })
      if (resp.ok) {
        const data = await resp.json()
        return { success: true, message: `Tool "${p.name}" created`, id: data.tool?.id }
      }
      const err = await resp.json().catch(() => ({}))
      return { success: false, message: err.error || `HTTP ${resp.status}` }
    }

    case 'update_agent': {
      const targetId = action.target || p.id
      if (!targetId) return { success: false, message: 'No target agent ID' }

      const resp = await authFetch(`/api/orgs/${orgId}/assistants/${targetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona: p, llm: p.llm }),
      })
      if (resp.ok) return { success: true, message: `Agent updated` }
      const err = await resp.json().catch(() => ({}))
      return { success: false, message: err.error || `HTTP ${resp.status}` }
    }

    case 'set_personality': {
      const targetId = action.target || p.id
      if (!targetId) return { success: false, message: 'No target agent ID' }

      const resp = await authFetch(`/api/orgs/${orgId}/assistants/${targetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona: { personality: p } }),
      })
      if (resp.ok) return { success: true, message: 'Personality updated' }
      const err = await resp.json().catch(() => ({}))
      return { success: false, message: err.error || `HTTP ${resp.status}` }
    }

    default:
      return { success: false, message: `Action "${action.action}" not yet implemented` }
  }
}

/**
 * AgentActionCard — Inline preview of an ARCHITECT proposal in the chat stream.
 */
export function AgentActionCard({ action, onApply, onEdit, onCancel, applying }) {
  const p = action.payload || {}
  const hasErrors = action.errors && action.errors.length > 0

  const typeColors = { agent: '#38bdf8', assistant: '#a855f7', chief: '#f59e0b', chatbot: '#30ff90' }
  const typeColor = typeColors[p.type] || '#38bdf8'

  return (
    <div style={{
      padding: 12, margin: '8px 0', borderRadius: 10,
      background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(168,85,247,0.15)',
    }}>
      {/* Summary */}
      <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
        {action.summary}
      </div>

      {/* Agent preview for create_agent */}
      {action.action === 'create_agent' && p.name && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8,
          padding: 10, background: 'rgba(0,0,0,0.15)', borderRadius: 8,
          borderLeft: `2px solid ${typeColor}`,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: `${p.color || typeColor}15`, border: `1.5px solid ${p.color || typeColor}`,
            fontSize: 13, fontWeight: 800, color: '#fff',
          }}>
            {(p.shortName || p.name?.slice(0, 2) || 'A').toUpperCase()}
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{p.name}</div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.65)' }}>
              {p.domain || 'General'} · {(p.tools || []).length} tools
            </div>
          </div>
        </div>
      )}

      {/* Tool preview for create_tool */}
      {action.action === 'create_tool' && p.id && (
        <div style={{
          padding: 8, marginBottom: 8, background: 'rgba(0,0,0,0.15)', borderRadius: 8,
          borderLeft: '2px solid #38bdf8', fontSize: 12,
        }}>
          <span style={{ fontWeight: 700, color: '#fff', fontFamily: "'JetBrains Mono', monospace" }}>{p.id}</span>
          <span style={{ color: 'rgba(255,255,255,0.65)', marginLeft: 8 }}>{p.description || ''}</span>
        </div>
      )}

      {/* Errors */}
      {hasErrors && (
        <div style={{ padding: 6, marginBottom: 8, background: 'rgba(239,68,68,0.06)', borderRadius: 6, border: '1px solid rgba(239,68,68,0.15)' }}>
          {action.errors.map((e, i) => <div key={i} style={{ fontSize: 10, color: '#ef4444' }}>{e}</div>)}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={onApply}
          disabled={hasErrors || applying}
          style={{
            padding: '5px 14px', fontSize: 11, fontWeight: 700,
            background: hasErrors ? 'rgba(255,255,255,0.05)' : '#30ff90',
            border: 'none', borderRadius: 6, cursor: hasErrors ? 'not-allowed' : 'pointer',
            color: hasErrors ? 'rgba(255,255,255,0.65)' : '#000',
            opacity: applying ? 0.6 : 1,
          }}
        >
          {applying ? 'Applying...' : 'Apply'}
        </button>
        <button onClick={onEdit} style={{
          padding: '5px 14px', fontSize: 11, fontWeight: 500,
          background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 6, cursor: 'pointer', color: 'rgba(255,255,255,0.7)', fontFamily: 'inherit',
        }}>
          Edit in Panel
        </button>
        <button onClick={onCancel} style={{
          padding: '5px 14px', fontSize: 11, fontWeight: 500,
          background: 'transparent', border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 6, cursor: 'pointer', color: 'rgba(255,255,255,0.65)', fontFamily: 'inherit',
        }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export default {
  buildArchitectContext,
  processArchitectResponse,
  executeArchitectAction,
  AgentActionCard,
}
