/**
 * ProxmoxChatSidebar — thin wrapper around AgentChatSidebar.
 */

import { useCallback, useMemo } from 'react'
import AgentChatSidebar from '../chat/AgentChatSidebar'

const SUGGESTIONS = [
  'List all VMs across the cluster',
  'Show Proxmox cluster status',
  'What VMs are running on hyp-01?',
  'Check resource usage on proxmox nodes',
  'Create a snapshot of VM 100',
  'How is the VM pool doing?',
]

export function ProxmoxChatSidebar({ cluster, vms, containers, selectedVM, pool, collapsed, onToggle }) {
  const contextBuilder = useCallback(async () => {
    const summary = [
      { label: 'Quorum', value: cluster?.summary?.quorate ? 'OK' : 'NO QUORUM' },
      { label: 'Nodes', value: `${cluster?.summary?.online ?? 0}/${cluster?.summary?.totalNodes ?? 0} online` },
      { label: 'VMs', value: `${vms?.summary?.running ?? 0} running • ${vms?.summary?.stopped ?? 0} stopped • ${vms?.summary?.total ?? 0} total` },
      { label: 'Containers', value: `${containers?.summary?.running ?? 0} running • ${containers?.summary?.stopped ?? 0} stopped • ${containers?.summary?.total ?? 0} total` },
    ]
    if (pool) {
      summary.push({
        label: 'VM pool',
        value: pool.enabled
          ? `${pool.ready} ready • ${pool.leased} leased • ${pool.building} building • ${pool.failed} failed • warm target ${pool.warm_target} • ${pool.lanes} lane${pool.lanes === 1 ? '' : 's'}${pool.paused ? ' • PAUSED on an approval' : ''}`
          : 'disabled',
      })
    }
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
      instructions: ['You are HYPERION, the Proxmox virtualization specialist. Your tools cover: VM lifecycle (start, stop, reboot, shutdown; always approval-gated), clones from templates, the disposable VM pool (lease, release, configure; approval-gated), create-only snapshots (no restore), and rehearsal twins. You cannot migrate guests, restore snapshots, or create templates. Be structured and concise.'],
    }
  }, [cluster, vms, containers, selectedVM, pool])

  // VM Doctor: a one-click question for the focused QEMU VM, ahead of the generic ones.
  const suggestions = useMemo(() => (
    selectedVM && selectedVM.type !== 'lxc'
      ? [`Why is ${selectedVM.name || `VM ${selectedVM.vmid}`} slow?`, ...SUGGESTIONS]
      : SUGGESTIONS
  ), [selectedVM])

  return (
    <AgentChatSidebar
      agentId="atlas"
      agentName="HYPERION"
      agentColor="#e65100"
      agentRole="Infrastructure"
      contextBuilder={contextBuilder}
      suggestions={suggestions}
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder={selectedVM ? `Ask about ${selectedVM?.name || 'VM ' + selectedVM?.vmid}...` : 'Ask HYPERION...'}
      sessionPrefix="PROXMOX_CHAT"
    />
  )
}

export default ProxmoxChatSidebar
