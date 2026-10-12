/**
 * DelegationFlowDiagram — Post-completion diagram showing delegation flow
 *
 * Orchestrator at top, arrows down to agents. Arrow thickness = task count.
 * Green = all succeeded, amber = mixed.
 *
 * @param {{ id, name, color }} orchestrator
 * @param {Array} delegations — [{ from, to, taskCount, successCount }]
 * @param {Array} agents — [{ id, name, color }]
 * @param {number} [width] — default 300
 */

import { useMemo } from 'react'

const NODE_SIZE = 32
const NODE_GAP = 16

export default function DelegationFlowDiagram({ orchestrator, delegations = [], agents = [], width = 300 }) {
  if (!orchestrator || agents.length === 0) return null

  // Aggregate: per-agent task counts
  const agentStats = useMemo(() => {
    const stats = {}
    for (const d of delegations) {
      if (!stats[d.to]) stats[d.to] = { tasks: 0, successes: 0 }
      stats[d.to].tasks += d.taskCount || 0
      stats[d.to].successes += d.successCount || 0
    }
    return stats
  }, [delegations])

  const activeAgents = agents.filter(a => agentStats[a.id])
  if (activeAgents.length === 0) return null

  const centerX = width / 2
  const agentSpacing = Math.min(60, (width - 40) / Math.max(activeAgents.length, 1))
  const agentStartX = centerX - ((activeAgents.length - 1) * agentSpacing) / 2
  const orchY = 20
  const agentY = 80

  return (
    <svg width={width} height={120} viewBox={`0 0 ${width} 120`}>
      {/* Orchestrator node */}
      <circle cx={centerX} cy={orchY} r={NODE_SIZE / 2}
        fill={orchestrator.color || '#3b82f6'} opacity={0.2}
        stroke={orchestrator.color || '#3b82f6'} strokeWidth={2} />
      <text x={centerX} y={orchY} textAnchor="middle" dominantBaseline="central"
        fontSize={10} fontWeight={700} fill="rgba(255,255,255,0.8)">
        {(orchestrator.name || orchestrator.id || '?')[0]}
      </text>

      {/* Agent nodes + arrows */}
      {activeAgents.map((agent, i) => {
        const x = agentStartX + i * agentSpacing
        const stat = agentStats[agent.id]
        const allSuccess = stat.tasks > 0 && stat.successes === stat.tasks
        const arrowColor = allSuccess ? '#10b981' : '#f59e0b'
        const arrowWidth = Math.min(3, Math.max(1, (stat.tasks || 1) * 0.5))

        return (
          <g key={agent.id}>
            {/* Arrow */}
            <line
              x1={centerX} y1={orchY + NODE_SIZE / 2}
              x2={x} y2={agentY - NODE_SIZE / 2}
              stroke={arrowColor} strokeWidth={arrowWidth} opacity={0.6}
            />

            {/* Agent circle */}
            <circle cx={x} cy={agentY} r={NODE_SIZE / 2 - 2}
              fill={agent.color || '#71717a'} opacity={0.2}
              stroke={agent.color || '#71717a'} strokeWidth={1.5} />
            <text x={x} y={agentY} textAnchor="middle" dominantBaseline="central"
              fontSize={9} fontWeight={600} fill="rgba(255,255,255,0.7)">
              {(agent.name || agent.id)[0]}
            </text>

            {/* Task count */}
            <text x={x} y={agentY + NODE_SIZE / 2 + 10} textAnchor="middle"
              fontSize={8} fill="rgba(255,255,255,0.4)"
              fontFamily="var(--m-font-mono, monospace)">
              {stat.successes}/{stat.tasks}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
