/**
 * TailscaleChatSidebar — thin wrapper around AgentChatSidebar.
 */

import { useCallback } from 'react'
import AgentChatSidebar from '../chat/AgentChatSidebar'

const SUGGESTIONS = [
  'Is my mesh healthy?',
  'Which devices are offline?',
  'Show subnet routes',
  'Any keys expiring soon?',
  'Explain the ACL policy',
  'Create a pre-auth key for tag:server',
]

export function TailscaleChatSidebar({ devices = [], keys = [], summary, selectedDevice, collapsed, onToggle }) {
  const contextBuilder = useCallback(async () => {
    const onlineCount = devices.filter(d => d.online).length
    const subnetRouters = devices.filter(d => d.isSubnetRouter)
    const exitNodes = devices.filter(d => d.isExitNode)
    const expiringKeys = keys.filter(k => k.daysUntilExpiry !== null && k.daysUntilExpiry <= 7)
    const contextSummary = [
      { label: 'Devices', value: `${devices.length} total • ${onlineCount} online • ${devices.length - onlineCount} offline` },
      { label: 'Subnet routers', value: subnetRouters.length },
      { label: 'Exit nodes', value: exitNodes.length },
      { label: 'Auth keys', value: `${keys.length}${expiringKeys.length > 0 ? ` (${expiringKeys.length} expiring soon)` : ''}` },
    ]

    const evidence = []
    if (selectedDevice) {
      evidence.push({
        label: `Focused device ${selectedDevice.hostname}`,
        text: [
          selectedDevice.os || 'Unknown OS',
          selectedDevice.online ? 'online' : 'offline',
          (selectedDevice.ips || [])[0] || 'no IP',
          (selectedDevice.enabledRoutes || []).length > 0 ? `routes ${selectedDevice.enabledRoutes.join(',')}` : null,
        ].filter(Boolean).join(' • ')
      })
    }

    devices.slice(0, 10).forEach((device) => {
      evidence.push({
        label: device.hostname,
        text: [
          device.os,
          device.online ? 'online' : 'offline',
          (device.ips || [])[0] || 'no IP',
          device.isSubnetRouter ? 'subnet router' : null,
          device.isExitNode ? 'exit node' : null,
        ].filter(Boolean).join(' • ')
      })
    })

    expiringKeys.slice(0, 5).forEach((key) => {
      evidence.push({
        label: key.description || key.id || 'Auth key',
        text: key.daysUntilExpiry != null ? `expires in ${key.daysUntilExpiry} day${key.daysUntilExpiry === 1 ? '' : 's'}` : 'expiry unknown'
      })
    })

    return {
      surface: 'sidebar',
      page: 'Tailscale',
      panel: 'MESHNET sidebar',
      focus: selectedDevice
        ? {
            type: 'Device',
            label: selectedDevice.hostname,
            id: selectedDevice.id || selectedDevice.nodeId || selectedDevice.hostname,
            detail: `${selectedDevice.online ? 'online' : 'offline'} • ${(selectedDevice.ips || [])[0] || 'no IP'}`
          }
        : {
            type: 'Mesh overview',
            label: 'Tailscale network',
            detail: `${onlineCount}/${devices.length} devices online`
          },
      summary: contextSummary,
      evidenceTitle: selectedDevice ? 'Focused device and mesh evidence' : 'Mesh evidence',
      evidence,
      instructions: ['You are MESHNET, the Tailscale mesh networking specialist. You manage devices, routes, keys, and ACL policies. Be direct, proactive, and safety-conscious. Explain consequences before making changes.'],
    }
  }, [devices, keys, selectedDevice])

  return (
    <AgentChatSidebar
      agentId="meshnet"
      agentName="MESHNET"
      agentColor="#5be9b9"
      agentRole="Networking"
      contextBuilder={contextBuilder}
      suggestions={SUGGESTIONS}
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder={selectedDevice ? `Ask about ${selectedDevice?.hostname}...` : 'Ask MESHNET...'}
      sessionPrefix="TAILSCALE_MESHNET_CHAT"
    />
  )
}

export default TailscaleChatSidebar
