/**
 * ProxmoxChatSidebar — thin wrapper around AgentChatSidebar.
 */

import { useCallback } from 'react'
import AgentChatSidebar from '../chat/AgentChatSidebar'

const SUGGESTIONS = [
  'List all VMs across the cluster',
  'Show Proxmox cluster status',
  'What VMs are running on hyp-01?',
  'Check resource usage on proxmox nodes',
  'Create a snapshot of VM 100',
]

export function ProxmoxChatSidebar({ cluster, vms, containers, selectedVM, collapsed, onToggle }) {
  const contextBuilder = useCallback(async () => {
    const summary = [
      { label: 'Quorum', value: cluster?.summary?.quorate ? 'OK' : 'NO QUORUM' },
      { label: 'Nodes', value: `${cluster?.summary?.online ?? 0}/${cluster?.summary?.totalNodes ?? 0} online` },
      { label: 'VMs', value: `${vms?.summary?.running ?? 0} running • ${vms?.summary?.stopped ?? 0} stopped • ${vms?.summary?.total ?? 0} total` },
      { label: 'Containers', value: `${containers?.summary?.running ?? 0} running • ${containers?.summary?.stopped ?? 0} stopped • ${containers?.summary?.total ?? 0} total` },
    ]
    const evidence = []

    if (selectedVM) {
      evidence.push({
        label: `Focused guest ${selectedVM.name || selectedVM.vmid}`,
        text: [
          `VMID ${selectedVM.vmid}`,
          selectedVM.type === 'lxc' ? 'LXC Container' : 'QEMU VM',
          selectedVM.node,
          selectedVM.status,
          selectedVM.ip || null,
          selectedVM.cpu != null && selectedVM.status === 'running' ? `CPU ${(selectedVM.cpu * 100).toFixed(1)}%` : null,
        ].filter(Boolean).join(' • ')
      })
    }

    return {
      surface: 'sidebar',
      page: 'Proxmox',
      panel: 'HYPERION cluster sidebar',
      focus: selectedVM
        ? {
            type: selectedVM.type === 'lxc' ? 'Container' : 'Virtual machine',
            label: selectedVM.name || String(selectedVM.vmid),
            id: selectedVM.vmid,
            detail: `${selectedVM.node} • ${selectedVM.status}`
          }
        : {
            type: 'Cluster overview',
            label: 'Proxmox cluster',
            detail: `${cluster?.summary?.online ?? 0}/${cluster?.summary?.totalNodes ?? 0} nodes online`
          },
      summary,
      evidenceTitle: selectedVM ? 'Focused guest evidence' : 'Cluster evidence',
      evidence,
      instructions: ['You are HYPERION, the Proxmox virtualization specialist. You have tools for VM lifecycle, snapshots, migrations, and cluster operations. Be structured and concise.'],
    }
  }, [cluster, vms, containers, selectedVM])

  return (
    <AgentChatSidebar
      agentId="atlas"
      agentName="HYPERION"
      agentColor="#e65100"
      agentRole="Infrastructure"
      contextBuilder={contextBuilder}
      suggestions={SUGGESTIONS}
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder={selectedVM ? `Ask about ${selectedVM?.name || 'VM ' + selectedVM?.vmid}...` : 'Ask HYPERION...'}
      sessionPrefix="PROXMOX_CHAT"
    />
  )
}

export default ProxmoxChatSidebar
