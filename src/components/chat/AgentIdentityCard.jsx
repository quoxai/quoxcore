/**
 * AgentIdentityCard - Compact agent identity for the right sidebar
 * Shows type badge, name, specialty, and expandable description.
 * Lives below the HAL visualizer in the sidebar.
 */

import { useState, useMemo } from 'react'
import { agentRegistry } from '../../config/agentRegistry'
import { getRuntimeAssistantConfig } from '../../services/entityRegistry'
import './agent-identity-card.css'

function resolveIdentity(assistantId) {
    const core = getRuntimeAssistantConfig(assistantId)
    const reg = agentRegistry.agents[assistantId]
    const role = reg?.role || 'specialist'
    const level = reg?.level ?? 1

    let typeLabel = 'Assistant'
    if (role === 'orchestrator') typeLabel = 'Orchestrator'
    else if (role === 'manager') typeLabel = 'Agent'
    else if (role === 'specialist') typeLabel = 'Specialist'

    const description = reg?.description || core?.description || ''
    const color = core?.color?.primary || core?.color || '#38bdf8'

    return { typeLabel, level, description, color, role }
}

export default function AgentIdentityCard({ assistantId, currentAssistantData }) {
    const [expanded, setExpanded] = useState(false)
    const data = useMemo(() => resolveIdentity(assistantId), [assistantId])

    const name = currentAssistantData?.name || 'QuoxCORE'
    const specialty = currentAssistantData?.specialty || 'Infrastructure Command Center'
    const accent = data.color

    const desc = data.description
    const isLong = desc.length > 100

    return (
        <div className="aic">
            {/* Type badge + level */}
            <div className="aic__badge" style={{ color: accent }}>
                <span className="aic__dot" style={{ background: accent, color: accent }} />
                <span>{data.typeLabel}</span>
                <span className="aic__level">L{data.level}</span>
            </div>

            {/* Name */}
            <div className="aic__name">{name}</div>

            {/* Specialty */}
            <div className="aic__specialty">{specialty}</div>

            {/* Description */}
            {desc && (
                <p className={`aic__desc ${expanded ? 'aic__desc--expanded' : ''}`}>
                    {expanded ? desc : desc.slice(0, 100)}
                    {isLong && (
                        <button className="aic__more" onClick={() => setExpanded(!expanded)} style={{ color: accent }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                                <polyline points="6 9 12 15 18 9"/>
                            </svg>
                            {expanded ? 'less' : 'more'}
                        </button>
                    )}
                </p>
            )}

            {/* Gradient divider */}
            <div className="aic__divider" />
        </div>
    )
}
