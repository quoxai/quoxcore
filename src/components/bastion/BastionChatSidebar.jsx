/**
 * BastionChatSidebar — JANUS, the gateway specialist.
 *
 * Sidebar for /bastion. Wraps AgentChatSidebar with Janus context:
 * hosts, unreachable count, recent audit events, current tab, selected host.
 * V1: conversational only — reads fleet state, guides user, pre-fills actions.
 * V2 (future): gains direct command execution via server-side bastion_* tools.
 */

import { useCallback } from 'react'
import { AgentChatSidebar } from '../chat/AgentChatSidebar'
import '../activity/activity-chat.css'
import * as bastion from '../../services/bastionClient'

const JANUS_AGENT = { id: 'janus', name: 'JANUS', role: 'Gate Warden', color: '#a855f7' }

const TAB_SUGGESTIONS = {
  fleet: [
    'Which hosts are unreachable right now?',
    'Add a host called hyp-07 at 203.0.113.107',
    'Health of the pve-cluster group',
    'Walk me through adding a new host',
    'How many hosts do I have by group?',
  ],
  cli: [
    'Pre-fill `uptime` for all Proxmox hosts',
    'What command should I run to check disk on docker01?',
    'How do I run the same command on a whole group?',
    'Why is passwordless SSH failing?',
  ],
  tools: [
    'What tools are available for the pve group?',
    'Explain the install-agent tool',
    'Walk me through running a tool safely',
  ],
  keys: [
    'Rotate my SSH key across the fleet',
    'Which hosts don\'t have the latest key?',
    'Walk me through deploying a new key',
    'How does passwordless access actually work here?',
  ],
  audit: [
    'Who ran commands on gw-01 today?',
    'Show me failed command attempts in the last hour',
    'Any unusual activity this week?',
    'Summarise today\'s audit trail',
  ],
}

export function BastionChatSidebar({ activeTab = 'fleet', selectedHost, onClose }) {
  const agent = JANUS_AGENT

  const buildContext = useCallback(async () => {
    const summary = []
    const evidence = []

    // Fleet snapshot
    let hosts = []
    let metrics = null
    try {
      hosts = await bastion.listHosts()
      summary.push({ label: 'Hosts registered', value: hosts.length })
    } catch { /* backend offline, carry on */ }

    try {
      metrics = await bastion.getFleetMetrics()
      if (metrics) {
        if (metrics.healthy != null) summary.push({ label: 'Healthy', value: metrics.healthy })
        if (metrics.unhealthy != null) summary.push({ label: 'Unhealthy', value: metrics.unhealthy })
        if (metrics.unknown != null) summary.push({ label: 'Unknown', value: metrics.unknown })
      }
    } catch { /* optional */ }

    // Selected host
    if (selectedHost) {
      summary.push({
        label: 'Selected host',
        value: `${selectedHost.id} (${selectedHost.ip})`,
      })
      if (selectedHost.group) {
        summary.push({ label: 'Group', value: selectedHost.group })
      }
    }

    // Top unreachable (if any)
    if (metrics?.unhealthy > 0 && hosts.length) {
      const unhealthyHosts = hosts.slice(0, 6).filter(h => h?.health === 'unhealthy' || h?.status === 'unreachable')
      unhealthyHosts.forEach(h => {
        evidence.push({ label: h.id, text: `${h.ip || '?'} · unreachable` })
      })
    }

    // Recent audit events
    try {
      const audit = await bastion.queryAuditLog({ limit: 5 })
      if (audit?.events?.length) {
        summary.push({ label: 'Recent audit events', value: audit.events.length })
        audit.events.slice(0, 5).forEach(ev => {
          const who = ev.actor || ev.user || 'unknown'
          const what = ev.type || ev.action || 'event'
          const when = ev.ts ? new Date(ev.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''
          evidence.push({ label: `${when} · ${who}`, text: what })
        })
      }
    } catch { /* optional */ }

    const focus = selectedHost
      ? {
          type: 'Host',
          label: selectedHost.id,
          id: selectedHost.id,
          detail: `${selectedHost.ip || ''} · tab: ${activeTab}`,
        }
      : {
          type: 'Bastion',
          label: 'Fleet overview',
          detail: `Active tab: ${activeTab}${hosts.length ? ` · ${hosts.length} hosts` : ''}`,
        }

    return {
      surface: 'sidebar',
      page: 'Bastion',
      panel: `JANUS gateway sidebar — ${activeTab} tab`,
      focus,
      summary,
      evidenceTitle: 'Fleet signals',
      evidence,
      instructions: [
        `User is on the ${activeTab} tab of the Bastion view. Tailor suggestions and guidance to that tab.`,
        'V1 mode: you cannot directly execute commands or modify state. Guide the user to the right button or pre-fill the CLI textarea with a recommended command.',
        'When the user asks to run a command, clearly state the target host(s), the exact command, and tell them to run it in the CLI tab.',
      ],
    }
  }, [activeTab, selectedHost])

  const headerContent = (
    <div className="acc-header__agent-wrap">
      <button className="acc-header__agent-btn" style={{ '--agent-color': agent.color }} disabled>
        <span className="acc-header__dot" style={{ background: agent.color }} />
        <span className="acc-header__name">{agent.name}</span>
      </button>
      <span className="acc-header__role">{agent.role}</span>
      {onClose && (
        <button className="acc-header__close" onClick={onClose} title="Close sidebar">
          <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.85)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  )

  return (
    <AgentChatSidebar
      /* The parent <aside> already carries the glass recipe, so the sidebar must not
         add its own or the surface renders glass on glass. */
      panel={false}
      agentId="janus"
      agentName={agent.name}
      agentColor={agent.color}
      agentRole={agent.role}
      headerContent={headerContent}
      contextBuilder={buildContext}
      suggestions={TAB_SUGGESTIONS[activeTab] || TAB_SUGGESTIONS.fleet}
      sessionPrefix="BASTION_JANUS_CHAT"
      vizStorageKey="bastion-janus-viz-collapsed"
      placeholder={`Ask JANUS about the fleet…`}
      emptyText={`Ask JANUS about hosts, keys, audit, or commands…`}
    />
  )
}

export default BastionChatSidebar
