/**
 * DashboardChatSidebar — Multi-agent chat for the Platform Command Centre.
 *
 * Thin wrapper around AgentChatSidebar.
 * Agent dropdown: QUOX (orchestrator), METRICS (system health), INSIGHT (pattern analysis).
 * Context builder: health data, objectives, analytics, fleet, services.
 */

import { useState, useCallback } from 'react'
import { AgentChatSidebar } from '../chat/AgentChatSidebar'
import '../activity/activity-chat.css'

const DASHBOARD_AGENTS = [
  { id: 'quox', name: 'CommanderQ', role: 'Orchestrator', color: '#38bdf8' },
  { id: 'metrics', name: 'METRICS', role: 'System Health', color: '#30ff90' },
  { id: 'insight', name: 'INSIGHT', role: 'Pattern Analysis', color: '#f46800' },
]

const AGENT_SUGGESTIONS = {
  quox: [
    'Give me a status overview',
    'What needs my attention right now?',
    'Summarise today\'s operations',
    'Any objectives stuck or failing?',
    'What happened in the last hour?',
  ],
  metrics: [
    'Which services are degraded?',
    'Show me response time trends',
    'Any services at risk of going down?',
    'What\'s the uptime this week?',
    'Check fleet health across all hosts',
  ],
  insight: [
    'What patterns do you see today?',
    'Any anomalies in conversation volume?',
    'Which agents are busiest this week?',
    'Compare today\'s activity to last week',
  ],
}

export function DashboardChatSidebar({
  healthData,
  analyticsData,
  objectives,
  hostSummary,
  selectedService,
  onClose,
  selectedAgent: externalAgent,
  onAgentChange: externalAgentChange,
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [internalAgent, setInternalAgent] = useState('quox')

  const selectedAgent = externalAgent || internalAgent
  const onAgentChange = externalAgentChange || setInternalAgent

  const agent = DASHBOARD_AGENTS.find(a => a.id === selectedAgent) || DASHBOARD_AGENTS[0]

  const buildContext = useCallback(async () => {
    const summary = []
    const unhealthyServices = healthData?.services
      ? Object.entries(healthData.services)
          .filter(([, svc]) => !svc.healthy)
          .slice(0, 6)
      : []
    const activeObjectives = objectives?.filter(o => ['running', 'decomposing', 'paused', 'pending'].includes(o.status)) || []
    const failedObjectives = objectives?.filter(o => o.status === 'failed') || []
    const evidence = []

    // Health summary
    if (healthData?.summary) {
      const s = healthData.summary
      summary.push({
        label: 'System health',
        value: s.allHealthy ? 'All operational' : s.criticalTotal - s.criticalHealthy > 0 ? 'Critical' : 'Degraded'
      })
      summary.push({ label: 'Healthy services', value: `${s.healthy}/${s.total}` })
      if (s.criticalTotal > 0) {
        summary.push({ label: 'Critical services', value: `${s.criticalHealthy}/${s.criticalTotal} healthy` })
      }

      unhealthyServices.forEach(([key, svc]) => {
        evidence.push({
          label: svc.name || key,
          text: svc.responding ? 'degraded' : 'down'
        })
      })
    }

    // Analytics
    if (analyticsData?.overview) {
      const o = analyticsData.overview
      if (o.total_conversations != null) summary.push({ label: '24h conversations', value: o.total_conversations })
      if (o.success_rate != null) summary.push({ label: '24h success rate', value: `${Math.round(o.success_rate)}%` })
      if (analyticsData.fleet?.total_jobs) summary.push({ label: 'Fleet jobs', value: analyticsData.fleet.total_jobs })
      if (analyticsData.health?.has_anomalies) summary.push({ label: 'Anomalies', value: `${analyticsData.health.anomaly_count} detected` })
    }

    // Objectives
    if (objectives && objectives.length > 0) {
      summary.push({ label: 'Active objectives', value: activeObjectives.length })
      if (failedObjectives.length > 0) summary.push({ label: 'Failed objectives', value: failedObjectives.length })
      activeObjectives.slice(0, 3).forEach(obj => {
        const pct = obj.task_count > 0 ? Math.round((obj.tasks_completed / obj.task_count) * 100) : 0
        evidence.push({
          label: obj.title,
          text: `${obj.status} • ${pct}% complete`
        })
      })
      failedObjectives.slice(0, 3).forEach((obj) => {
        evidence.push({
          label: `Failed: ${obj.title}`,
          text: obj.status
        })
      })
    }

    // Fleet
    if (hostSummary?.total > 0) {
      summary.push({ label: 'Fleet hosts', value: hostSummary.total })
      if (hostSummary.byCategory) {
        const cats = Object.entries(hostSummary.byCategory).sort((a, b) => b[1] - a[1])
        summary.push({ label: 'Fleet categories', value: cats.map(([c, n]) => `${c}(${n})`).join(', ') })
      }
    }

    const preambles = {
      quox: 'You are CommanderQ, the platform orchestrator. Provide a clear, executive-level overview of system status, pending work, and anything requiring human attention. Be concise and actionable.',
      metrics: 'You are METRICS, the system health specialist. Analyse service health, response times, uptime trends, and infrastructure status. Flag risks and recommend actions. Be precise and data-driven.',
      insight: 'You are INSIGHT, the analytics specialist. Find patterns in platform activity, conversation volumes, agent workloads, and operational trends. Highlight anomalies and opportunities. Be concise.',
    }

    return {
      surface: 'sidebar',
      page: 'Dashboard',
      panel: `${agent.name} command sidebar`,
      focus: selectedService
        ? {
            type: 'Service',
            label: selectedService,
            id: selectedService,
            detail: healthData?.services?.[selectedService]?.healthy ? 'healthy' : 'degraded'
          }
        : {
            type: 'Overview',
            label: 'Platform command centre',
            detail: unhealthyServices.length > 0 ? `${unhealthyServices.length} unhealthy service${unhealthyServices.length === 1 ? '' : 's'}` : 'No unhealthy services in current snapshot'
          },
      summary,
      evidenceTitle: selectedService ? 'Related system and objective signals' : 'Key platform signals',
      evidence,
      instructions: [preambles[selectedAgent] || preambles.quox],
    }
  }, [agent.name, analyticsData, healthData, hostSummary, objectives, selectedAgent, selectedService])

  const headerContent = (
    <div className="acc-header__agent-wrap">
      <button
        className="acc-header__agent-btn"
        onClick={() => setDropdownOpen(v => !v)}
        style={{ '--agent-color': agent.color }}
      >
        <span className="acc-header__dot" style={{ background: agent.color }} />
        <span className="acc-header__name">{agent.name}</span>
        <span className="acc-header__chevron">{dropdownOpen ? '▴' : '▾'}</span>
      </button>
      {dropdownOpen && (
        <div className="acc-dropdown">
          {DASHBOARD_AGENTS.map(a => (
            <button
              key={a.id}
              className={`acc-dropdown__item ${a.id === selectedAgent ? 'acc-dropdown__item--active' : ''}`}
              onClick={() => { onAgentChange(a.id); setDropdownOpen(false); }}
            >
              <span className="acc-dropdown__dot" style={{ background: a.color }} />
              <span className="acc-dropdown__name">{a.name}</span>
              <span className="acc-dropdown__role">{a.role}</span>
            </button>
          ))}
        </div>
      )}
      <span className="acc-header__role">{agent.role}</span>
      {onClose && (
        <button className="acc-header__close" onClick={onClose} title="Close sidebar">
          <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      )}
    </div>
  )

  return (
    <AgentChatSidebar
      agentId={selectedAgent || 'quox'}
      agentName={agent.name}
      agentColor={agent.color}
      agentRole={agent.role}
      headerContent={headerContent}
      contextBuilder={buildContext}
      suggestions={AGENT_SUGGESTIONS[selectedAgent] || AGENT_SUGGESTIONS.quox}
      sessionPrefix={`DASHBOARD_${(selectedAgent || 'quox').toUpperCase()}_CHAT`}
      vizStorageKey="dashboard-viz-collapsed"
      placeholder={`Ask ${agent.name} about the dashboard...`}
      emptyText={`Ask ${agent.name} about platform status...`}
    />
  )
}

export default DashboardChatSidebar
