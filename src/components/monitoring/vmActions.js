/**
 * vmActions — Shared VM/CT action builder used by ProxmoxActions and ProxmoxContextMenu.
 */

export function buildVMActions(vm) {
  if (!vm) return []

  const { vmid, node, name, status, type } = vm
  const vmType = type === 'lxc' ? 'lxc' : 'qemu'
  const displayName = name || `${vmType === 'lxc' ? 'CT' : 'VM'} ${vmid}`
  const guestWord = vmType === 'lxc' ? 'container' : 'VM'

  const actions = []

  if (status === 'stopped') {
    actions.push({
      id: 'vm-start',
      icon: '▶',
      label: `Start`,
      description: `Start ${vmType} ${vmid} on ${node}`,
      prompt: `Start the ${guestWord} ${vmid} (${displayName}) on node ${node}. Use the proxmox_vm_action tool.`,
    })
  }

  if (status === 'running') {
    actions.push({
      id: 'vm-stop',
      icon: '■',
      label: `Stop`,
      description: `Stop ${vmType} ${vmid} on ${node}`,
      prompt: `Stop the ${guestWord} ${vmid} (${displayName}) on node ${node}. Use the proxmox_vm_action tool.`,
      danger: true,
    })
    actions.push({
      id: 'vm-restart',
      icon: '↻',
      label: `Restart`,
      description: `Restart ${vmType} ${vmid} on ${node}`,
      prompt: `Restart the ${guestWord} ${vmid} (${displayName}) on node ${node}. Use the proxmox_vm_action tool with action "reboot".`,
    })
  }

  actions.push({
    id: 'vm-snapshot',
    icon: '◉',
    label: 'Snapshot',
    description: `Create a snapshot of ${vmType} ${vmid}`,
    prompt: `Create a snapshot of ${guestWord} ${vmid} (${displayName}) on node ${node}. Name it with today's date. Use the proxmox_vm_snapshot tool with vmid ${vmid}, node "${node}" and snapname.`,
  })

  // VM Doctor (DEVFLEET-DOCTOR): QEMU VMs only. The view opens the diagnosis panel for this id;
  // the prompt is the fallback for a consumer that has no panel (it asks HYPERION to run the tool).
  if (vmType === 'qemu') {
    actions.push({
      id: 'vm-diagnose',
      icon: '⚕',
      label: 'Diagnose',
      description: `Why is ${vmType} ${vmid} slow or unhealthy? Ranked findings with evidence`,
      prompt: `Why is the VM ${vmid} (${displayName}) on node ${node} slow or unhealthy? Run proxmox_vm_doctor with target "${vmid}" and explain the top findings with their evidence.`,
    })
  }

  actions.push({
    id: 'vm-status',
    icon: 'ℹ',
    label: 'Status',
    description: `Get detailed status of ${vmType} ${vmid}`,
    prompt: `Get the detailed status of ${guestWord} ${vmid} (${displayName}) on node ${node}. Show CPU, memory, disk, network, and uptime details.`,
  })

  return actions
}
