/**
 * AssistantCard — Premium identity card for settings grid.
 *
 * Shows avatar with color ring, breathing DEFCON dot, role/LLM badges,
 * domain tags, and quick-access meta (visualizer type, voice).
 * Agents show tools/workflows. Assistants show delegation targets.
 * No emoji icons — all text/SVG.
 */

import React from 'react'
import { generateIdentityCard, hasOverrides } from '../../services/entityRegistry'
import { agentRegistry } from '../../config/agentRegistry'
import { useAgentToolsTruth } from '../../services/agentToolsTruth'
import { AgentProfileBadges } from '../agents/AgentProfileBadges.jsx'

const ROLE_LABELS = {
  orchestrator: 'ORCH',
  manager: 'MGR',
  analyst: 'ANLST',
  specialist: 'SPEC'
}

const DEFCON_CLASS = {
  GREEN: 'ac__defcon--green',
  AMBER: 'ac__defcon--amber',
  RED: 'ac__defcon--red'
}

const LLM_LABELS = {
  anthropic: 'Claude',
  openai: 'GPT',
  gemini: 'Gemini',
  perplexity: 'Pplx'
}

const LLM_COLORS = {
  anthropic: { bg: 'rgba(217, 119, 6, 0.12)', fg: '#d97706' },
  openai: { bg: 'rgba(16, 163, 127, 0.12)', fg: '#10a37f' },
  gemini: { bg: 'rgba(66, 133, 244, 0.12)', fg: '#4285f4' },
  perplexity: { bg: 'rgba(34, 197, 94, 0.12)', fg: '#22c55e' }
}

const VIZ_LABELS = {
  'commander-sigil': 'Sigil',
  hal: 'HAL',
  wave: 'Wave',
  grid: 'Grid',
  atom: 'Atom',
  brain: 'Brain',
  dna: 'DNA',
  sphere: 'Sphere',
  fluid: 'Fluid',
  holo: 'Holo',
  nexus: 'Nexus',
  kitt: 'KITT',
  ripple: 'Ripple',
  iris: 'Iris',
  core: 'Core'
}

export default function AssistantCard({ assistant, entityType, selected, onSelect, onEdit }) {
  // Hooks must run unconditionally (before the `!assistant?.id` early return
  // below) — safe to call with a null/undefined id.
  const toolsTruth = useAgentToolsTruth(assistant?.id)

  if (!assistant?.id) return null
  const card = generateIdentityCard(assistant.id) || {}
  const isCustomized = hasOverrides(assistant.id)

  const llmColor = LLM_COLORS[card.llm?.provider] || { bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.5)' }
  const vizType = assistant.ui?.visualizer?.type || 'commander-sigil'

  // Get registry data for workflows/delegation. Tools come from the runtime
  // truth (AGENT-OVERHAUL-2), not the registry's declared list — see
  // agentToolsTruth.js.
  const registryEntry = agentRegistry.agents?.[assistant.id]
  const tools = toolsTruth.tools
  const workflows = registryEntry?.workflows || []
  const delegatesTo = registryEntry?.canDelegateTo || []

  return (
    <div
      className={`ac ${selected ? 'ac--selected' : ''}`}
      style={{ '--ac-color': card.color || '#8b5cf6' }}
      onClick={() => onSelect(assistant.id)}
      role="listitem"
    >
      {/* Header: Avatar + Identity */}
      <div className="ac__header">
        <div className="ac__avatar">
          <span className="ac__avatar-letter">{card.shortName}</span>
          <div className={`ac__defcon ${DEFCON_CLASS[card.defcon] || DEFCON_CLASS.GREEN}`}
               title={`DEFCON ${card.defcon}`} />
        </div>

        <div className="ac__identity">
          <h3 className="ac__name">
            {card.name}
            {isCustomized && <span className="ac__custom-mark" title="Customised">*</span>}
          </h3>
          <span className="ac__tagline">{card.tagline}</span>
        </div>
      </div>

      {/* Badges: Role + Level + LLM */}
      <div className="ac__badges">
        <span className="ac__badge ac__badge--role">
          {ROLE_LABELS[card.role] || card.role}
        </span>
        <span className="ac__badge ac__badge--level">
          L{card.level}
        </span>
        <span
          className="ac__badge ac__badge--llm"
          style={{ backgroundColor: llmColor.bg, color: llmColor.fg }}
          title={card.llm?.model || 'default'}
        >
          {LLM_LABELS[card.llm?.provider] || card.llm?.provider || 'Claude'}
        </span>
      </div>

      {/* Domains */}
      {card.domains?.length > 0 && (
        <div className="ac__domains">
          {card.domains.slice(0, 4).map(domain => (
            <span key={domain} className="ac__domain">{domain}</span>
          ))}
          {card.domains.length > 4 && (
            <span className="ac__domain">+{card.domains.length - 4}</span>
          )}
        </div>
      )}

      {/* Catalog stats: skills / tools / workflows / crystals */}
      <AgentProfileBadges agentId={assistant.id} variant="compact" />

      {/* Capabilities: Tools, Workflows, Delegation */}
      {(tools.length > 0 || workflows.length > 0 || delegatesTo.length > 0) && (
        <div className="ac__capabilities">
          {tools.length > 0 && (
            <div className="ac__cap-row">
              <span className="ac__cap-label">
                Tools{toolsTruth.source === 'fallback' && <span style={{ opacity: 0.5 }}> (unverified)</span>}
              </span>
              <span className="ac__cap-value">{tools.length}</span>
            </div>
          )}
          {workflows.length > 0 && (
            <div className="ac__cap-row">
              <span className="ac__cap-label">Workflows</span>
              <span className="ac__cap-value">{workflows.length}</span>
            </div>
          )}
          {delegatesTo.length > 0 && (
            <div className="ac__cap-row">
              <span className="ac__cap-label">Delegates</span>
              <span className="ac__cap-value">{delegatesTo.length}</span>
            </div>
          )}
        </div>
      )}

      {/* Manages info */}
      {card.manages?.length > 0 && (
        <div className="ac__manages">
          Manages: {card.manages.join(', ')}
        </div>
      )}

      {/* Footer: Meta + Configure */}
      <div className="ac__footer">
        <div className="ac__meta-row">
          <span className="ac__meta-item" title={`Visualiser: ${VIZ_LABELS[vizType] || vizType}`}>
            <span className="ac__meta-icon">◉</span>
            {VIZ_LABELS[vizType] || 'HAL'}
          </span>
          <span className="ac__meta-item" title={`Voice assigned`}>
            <span className="ac__meta-icon">♪</span>
            Voice
          </span>
          {tools.length > 0 && (
            <span className="ac__meta-item" title={`${tools.length} tools`}>
              <span className="ac__meta-icon">⚙</span>
              {tools.length}
            </span>
          )}
        </div>

        <button
          className="ac__configure-btn"
          onClick={(e) => {
            e.stopPropagation()
            onEdit(assistant.id)
          }}
        >
          Configure
        </button>
      </div>
    </div>
  )
}
