/**
 * InfraActionsSidebar — Left sidebar for QuoxAgents page.
 *
 * Contextual quick actions with descriptions that send prompts to chat.
 * Fleet status summary.
 */

import { memo } from 'react'

const ACTIONS = [
  {
    id: 'deploy',
    label: 'Deploy Agent',
    desc: 'Install QuoxAgent on a new host',
    prompt: 'Deploy QuoxAgent to a new host. What hosts need it?',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'currentColor' }} strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  },
  {
    id: 'job',
    label: 'Submit Job',
    desc: 'Run a command on a remote agent',
    prompt: 'Submit a command to run on an agent. Which agent and what command?',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'currentColor' }} strokeWidth="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>,
  },
  {
    id: 'playbook',
    label: 'Run Playbook',
    desc: 'Execute an automation workflow',
    prompt: 'What playbooks are available? Help me pick one and explain what it does.',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'currentColor' }} strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  },
  {
    id: 'health',
    label: 'Fleet Health',
    desc: 'Check health across all agents',
    prompt: 'Run a fleet-wide health check on all connected agents. Show CPU, memory, disk.',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'currentColor' }} strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
  },
  {
    id: 'sessions',
    label: 'AI Sessions',
    desc: 'View Claude, GPT, Gemini across fleet',
    prompt: 'Show all active AI agent sessions across the fleet with details.',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'currentColor' }} strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  },
  {
    id: 'plugins',
    label: 'Manage Plugins',
    desc: 'Enable, disable, check plugin status',
    prompt: 'Show plugin status for all agents. Which plugins are enabled and what capabilities do they provide?',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'currentColor' }} strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  },
]

const ActionCard = memo(function ActionCard({ action, onAction }) {
  return (
    <button className="iv-action" onClick={() => onAction(action)}>
      <span className="iv-action__icon">{action.icon}</span>
      <span className="iv-action__text">
        <span className="iv-action__label">{action.label}</span>
        <span className="iv-action__desc">{action.desc}</span>
      </span>
    </button>
  )
})

export function InfraActionsSidebar({ agents, onAction }) {
  const agentList = agents || []
  const connected = agentList.filter(a => a.status?.connection === 'connected').length
  const stale = agentList.filter(a => a.status?.connection === 'stale').length
  const dead = agentList.filter(a => a.status?.connection === 'dead').length

  return (
    <div className="iv-actions-inner">
      <div className="iv-section-label">Quick Actions</div>
      <div className="iv-actions-grid">
        {ACTIONS.map(action => (
          <ActionCard key={action.id} action={action} onAction={onAction} />
        ))}
      </div>

      <div className="iv-section-label iv-section-label--spaced">Fleet Overview</div>
      <div className="iv-fleet-stats">
        <div className="iv-fleet-stat">
          <span className="iv-fleet-stat__value" style={{ color: connected > 0 ? '#30ff90' : '#333' }}>{connected}</span>
          <span className="iv-fleet-stat__label">Online</span>
        </div>
        <div className="iv-fleet-stat">
          <span className="iv-fleet-stat__value" style={{ color: stale > 0 ? '#ffb030' : '#333' }}>{stale}</span>
          <span className="iv-fleet-stat__label">Stale</span>
        </div>
        <div className="iv-fleet-stat">
          <span className="iv-fleet-stat__value" style={{ color: dead > 0 ? '#ff5555' : '#333' }}>{dead}</span>
          <span className="iv-fleet-stat__label">Dead</span>
        </div>
        <div className="iv-fleet-stat">
          <span className="iv-fleet-stat__value" style={{ color: 'rgba(255,255,255,0.4)' }}>{agentList.length}</span>
          <span className="iv-fleet-stat__label">Total</span>
        </div>
      </div>
    </div>
  )
}

export default InfraActionsSidebar
