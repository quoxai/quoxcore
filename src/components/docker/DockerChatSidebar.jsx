/**
 * DockerChatSidebar — thin wrapper around AgentChatSidebar.
 */

import { useCallback } from 'react'
import AgentChatSidebar from '../chat/AgentChatSidebar'

const SUGGESTIONS = [
  'Scan the fleet for Docker hosts',
  'Show disk usage across all hosts',
  'Which containers have restarted recently?',
  'List all containers on maestro',
  'Check logs for quox-collector',
  'What images are using the most space?',
]

export function DockerChatSidebar({ hosts, containers, selectedHost, collapsed, onToggle }) {
  const contextBuilder = useCallback(async () => {
    const running = containers.filter(c => (c.state || c.status || '').toLowerCase().startsWith('running'))
    const stopped = containers.length - running.length
    const summary = [
      { label: 'Hosts discovered', value: hosts.length },
      { label: 'Containers', value: `${running.length} running • ${stopped} stopped • ${containers.length} total` },
    ]

    const evidence = []
    hosts.slice(0, 8).forEach((host) => {
      evidence.push({
        label: host.id,
        text: `Docker ${host.docker_version || '?'} • ${host.containers_running || 0}/${host.containers_total || 0} containers`
      })
    })

    if (selectedHost) {
      const hostContainers = containers.filter(c => c.host === selectedHost)
      evidence.unshift({
        label: `Focused host ${selectedHost}`,
        text: `${hostContainers.length} containers`
      })
      hostContainers.slice(0, 8).forEach((container) => {
        const status = (container.state || container.status || 'unknown').split(' ')[0]
        evidence.push({
          label: container.name || container.id?.slice(0, 12) || 'container',
          text: `${status} • ${container.image || container.image_name || 'unknown image'}`
        })
      })
    }

    return {
      surface: 'sidebar',
      page: 'Docker Fleet',
      panel: 'DOCKULA docker sidebar',
      focus: selectedHost
        ? {
            type: 'Docker host',
            label: selectedHost,
            id: selectedHost,
            detail: `${containers.filter(c => c.host === selectedHost).length} visible containers`
          }
        : {
            type: 'Docker overview',
            label: 'Container fleet',
            detail: `${hosts.length} hosts • ${containers.length} containers`
          },
      summary,
      evidenceTitle: selectedHost ? 'Focused host and container evidence' : 'Fleet evidence',
      evidence,
      instructions: ['You are DOCKULA, the container fleet overlord. Use your Docker fleet tools to scan hosts, inspect containers, check logs, and manage the fleet. Be direct and operational.'],
    }
  }, [hosts, containers, selectedHost])

  return (
    <AgentChatSidebar
      agentId="dockeragent"
      agentName="DOCKULA"
      agentColor="#2496ed"
      agentRole="Fleet Overlord"
      contextBuilder={contextBuilder}
      suggestions={SUGGESTIONS}
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder={selectedHost ? `Ask about ${selectedHost}...` : 'Ask DOCKULA...'}
      sessionPrefix="DOCKER_DOCKULA_CHAT"
    />
  )
}

export default DockerChatSidebar
