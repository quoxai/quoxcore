/**
 * Proxmox Client Service
 * Routes all requests through the collector proxy to avoid CORS and
 * self-signed cert issues. Credentials stored server-side.
 */

const PROXY_BASE = '/collector/api/v1/monitoring/proxy/proxmox'

/**
 * Make a Proxmox API call through the collector proxy
 * @param {string} path - API path (e.g., '/cluster/status')
 * @returns {Promise<any>} Parsed response data
 */
async function proxmoxApi(path) {
  const response = await fetch(`${PROXY_BASE}/api2/json${path}`, {
    credentials: 'include',
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}${text ? ': ' + text : ''}`)
  }
  const json = await response.json()
  return json.data || json
}

/**
 * Split a raw /cluster/resources?type=vm response into VMs and containers.
 *
 * Proxmox's /cluster/resources `type` query param only accepts the enum
 * 'vm', 'storage', 'node', 'sdn' — NOT 'lxc'. Passing type=lxc returns
 * HTTP 400 ("value 'lxc' does not have a value in the enumeration").
 * When type=vm is used, Proxmox returns BOTH qemu and lxc guest rows in
 * the same array; each row's own `type` field ('qemu' | 'lxc') is what
 * distinguishes them. This function does that client-side split.
 */
export function splitGuestResources(resources) {
  const rows = (Array.isArray(resources) ? resources : []).map(r => ({
    vmid: r.vmid,
    name: r.name,
    node: r.node,
    status: r.status,
    type: r.type,
    cpu: r.cpu,
    mem: r.mem,
    maxmem: r.maxmem,
    disk: r.disk,
    maxdisk: r.maxdisk,
    uptime: r.uptime
  }))

  return {
    vms: rows.filter(r => r.type === 'qemu'),
    containers: rows.filter(r => r.type === 'lxc')
  }
}

/**
 * Get all VMs across the cluster
 */
export async function getVMs() {
  try {
    const resources = await proxmoxApi('/cluster/resources?type=vm')
    const { vms } = splitGuestResources(resources)

    const running = vms.filter(vm => vm.status === 'running')
    const stopped = vms.filter(vm => vm.status === 'stopped')
    const paused = vms.filter(vm => vm.status === 'paused')

    return {
      success: true,
      vms, running, stopped, paused,
      summary: { total: vms.length, running: running.length, stopped: stopped.length, paused: paused.length }
    }
  } catch (error) {
    console.error('[Proxmox] Failed to get VMs:', error)
    return {
      success: false,
      error: error.message,
      vms: [], running: [], stopped: [], paused: [],
      summary: { total: 0, running: 0, stopped: 0, paused: 0 }
    }
  }
}

/**
 * Get all containers (LXC) across the cluster
 */
export async function getContainers() {
  try {
    const resources = await proxmoxApi('/cluster/resources?type=vm')
    const { containers } = splitGuestResources(resources)

    const running = containers.filter(ct => ct.status === 'running')
    const stopped = containers.filter(ct => ct.status === 'stopped')

    return {
      success: true,
      containers, running, stopped,
      summary: { total: containers.length, running: running.length, stopped: stopped.length }
    }
  } catch (error) {
    console.error('[Proxmox] Failed to get containers:', error)
    return {
      success: false,
      error: error.message,
      containers: [], running: [], stopped: [],
      summary: { total: 0, running: 0, stopped: 0 }
    }
  }
}

/**
 * Get cluster status
 */
export async function getClusterStatus() {
  try {
    // Try /cluster/status first (needs Sys.Audit), fall back to /nodes
    let nodes = []
    let clusterInfo = {}
    try {
      const statusArray = await proxmoxApi('/cluster/status')
      const items = Array.isArray(statusArray) ? statusArray : []
      clusterInfo = items.find(s => s.type === 'cluster') || {}
      nodes = items.filter(s => s.type === 'node').map(n => ({
        name: n.name, id: n.nodeid, ip: n.ip,
        online: n.online, level: n.level, local: n.local
      }))
    } catch {
      // /cluster/status needs Sys.Audit — fall back to /nodes
      const nodeList = await proxmoxApi('/nodes')
      const items = Array.isArray(nodeList) ? nodeList : []
      nodes = items.map(n => ({
        name: n.node, id: n.id, ip: n.ip || '',
        online: n.status === 'online' ? 1 : 0, level: n.level, local: 0
      }))
    }

    const online = nodes.filter(n => n.online === 1)
    const offline = nodes.filter(n => n.online !== 1)

    return {
      success: true,
      quorate: clusterInfo.quorate === 1 || online.length > 0,
      version: clusterInfo.version,
      nodes, online, offline,
      summary: {
        totalNodes: nodes.length,
        online: online.length,
        offline: offline.length,
        quorate: clusterInfo.quorate === 1 || online.length > 0
      }
    }
  } catch (error) {
    console.error('[Proxmox] Failed to get cluster status:', error)
    return {
      success: false,
      error: error.message,
      quorate: false,
      nodes: [], online: [], offline: [],
      summary: { totalNodes: 0, online: 0, offline: 0, quorate: false }
    }
  }
}

/**
 * Get node resource usage
 */
export async function getNodeStatus(node) {
  try {
    const status = await proxmoxApi(`/nodes/${encodeURIComponent(node)}/status`)
    return {
      success: true,
      node,
      cpu: ((status.cpu || 0) * 100).toFixed(1),
      memory: {
        used: status.memory?.used || 0,
        total: status.memory?.total || 0,
        percent: status.memory?.total > 0
          ? ((status.memory.used / status.memory.total) * 100).toFixed(1) : '0'
      },
      uptime: status.uptime,
      loadavg: status.loadavg,
      kversion: status.kversion
    }
  } catch (error) {
    console.error('[Proxmox] Failed to get node status:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Get storage overview
 */
export async function getStorage() {
  try {
    const resources = await proxmoxApi('/cluster/resources?type=storage')
    const storages = (Array.isArray(resources) ? resources : []).map(s => ({
      ...s,
      usedPercent: s.maxdisk > 0 ? ((s.disk / s.maxdisk) * 100).toFixed(1) : 0
    }))

    const highUsage = storages.filter(s => parseFloat(s.usedPercent) > 80)

    return {
      success: true,
      storages, highUsage,
      summary: { total: storages.length, highUsage: highUsage.length }
    }
  } catch (error) {
    console.error('[Proxmox] Failed to get storage:', error)
    return {
      success: false,
      error: error.message,
      storages: [],
      summary: { total: 0, highUsage: 0 }
    }
  }
}

/**
 * Get VM/Container status
 */
export async function getVMStatus(node, type, vmid) {
  try {
    const status = await proxmoxApi(`/nodes/${encodeURIComponent(node)}/${type}/${vmid}/status/current`)
    return { success: true, ...status }
  } catch (error) {
    console.error('[Proxmox] Failed to get VM status:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Get all snapshots for a VM
 */
export async function getSnapshots(node, type, vmid) {
  try {
    const snapshots = await proxmoxApi(`/nodes/${encodeURIComponent(node)}/${type}/${vmid}/snapshot`)
    return {
      success: true,
      snapshots: Array.isArray(snapshots) ? snapshots : [],
      count: Array.isArray(snapshots) ? snapshots.length : 0
    }
  } catch (error) {
    console.error('[Proxmox] Failed to get snapshots:', error)
    return { success: false, error: error.message, snapshots: [] }
  }
}

/**
 * Get complete cluster overview
 */
export async function getOverview() {
  try {
    const [cluster, vms, containers, storage] = await Promise.all([
      getClusterStatus(),
      getVMs(),
      getContainers(),
      getStorage()
    ])

    const healthy = cluster.summary.quorate &&
                    cluster.summary.offline === 0 &&
                    storage.summary.highUsage === 0

    return {
      success: true,
      healthy,
      status: healthy ? 'healthy' : 'warning',
      cluster: cluster.summary,
      vms: vms.summary,
      containers: containers.summary,
      storage: storage.summary,
      message: healthy
        ? `Cluster healthy: ${cluster.summary.online} nodes, ${vms.summary.running} VMs, ${containers.summary.running} containers`
        : `Cluster warning: Check ${cluster.summary.offline} offline nodes or ${storage.summary.highUsage} high-usage storages`
    }
  } catch (error) {
    console.error('[Proxmox] Failed to get overview:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

/**
 * Format uptime seconds to readable string
 */
export function formatUptime(seconds) {
  if (!seconds) return '-'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/**
 * Parse IP from LXC net0 config field
 * Format: "name=eth0,bridge=vmbr0,hwaddr=XX:XX,ip=10.0.0.101/24,..."
 */
function parseNet0IP(net0) {
  if (!net0) return null
  const match = net0.match(/ip=([^/,]+)/)
  return match ? match[1] : null
}

/**
 * Get LXC container config to extract IP
 */
async function getLxcIP(node, vmid) {
  try {
    const config = await proxmoxApi(`/nodes/${encodeURIComponent(node)}/lxc/${vmid}/config`)
    // Check net0 through net9
    for (let i = 0; i <= 9; i++) {
      const ip = parseNet0IP(config[`net${i}`])
      if (ip && ip !== 'dhcp') return ip
    }
    return null
  } catch {
    return null
  }
}

/**
 * Get QEMU VM IP via guest agent
 */
async function getQemuIP(node, vmid) {
  try {
    const result = await proxmoxApi(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/network-get-interfaces`)
    const ifaces = Array.isArray(result) ? result : (result?.result || [])
    for (const iface of ifaces) {
      if (iface.name === 'lo') continue
      const addrs = iface['ip-addresses'] || []
      for (const addr of addrs) {
        if (addr['ip-address-type'] === 'ipv4' && addr['ip-address'] && !addr['ip-address'].startsWith('127.')) {
          return addr['ip-address']
        }
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Batch-fetch IPs for all VMs and containers.
 * Returns a Map<"node-vmid", ip>
 */
export async function getVMIPs(items) {
  const ipMap = new Map()
  if (!items || items.length === 0) return ipMap

  const promises = items.map(async (item) => {
    const key = `${item.node}-${item.vmid}`
    let ip = null

    if (item.type === 'lxc') {
      ip = await getLxcIP(item.node, item.vmid)
    } else if (item.type === 'qemu' && item.status === 'running') {
      ip = await getQemuIP(item.node, item.vmid)
    }

    if (ip) ipMap.set(key, ip)
  })

  await Promise.allSettled(promises)
  return ipMap
}

/**
 * Get backup schedules from cluster
 */
export async function getBackupSchedules() {
  try {
    const data = await proxmoxApi('/cluster/backup')
    return (Array.isArray(data) ? data : []).map(s => ({
      id: s.id,
      node: s.node || 'all',
      storage: s.storage,
      schedule: s.schedule,
      mode: s.mode,
      enabled: s.enabled === 1,
      all: s.all === 1,
      nextRun: s['next-run'],
      pruneBackups: s['prune-backups'],
    }))
  } catch (error) {
    console.error('[Proxmox] Failed to get backup schedules:', error)
    return []
  }
}

/**
 * Get recent backup tasks from cluster
 */
export async function getBackupTasks() {
  try {
    const data = await proxmoxApi('/cluster/tasks')
    return (Array.isArray(data) ? data : [])
      .filter(t => t.type === 'vzdump')
      .slice(0, 50)
      .map(t => ({
        node: t.node,
        status: t.status,
        starttime: t.starttime,
        endtime: t.endtime,
        upid: t.upid,
        duration: t.endtime && t.starttime ? t.endtime - t.starttime : null,
      }))
  } catch (error) {
    console.error('[Proxmox] Failed to get backup tasks:', error)
    return []
  }
}

/**
 * Get backup content from a storage on a given node.
 * Returns per-VM backup snapshots with size, time, and notes.
 */
export async function getBackupContent(node, storage) {
  try {
    const data = await proxmoxApi(
      `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content?content=backup`
    )
    return (Array.isArray(data) ? data : []).map(b => ({
      vmid: b.vmid,
      volid: b.volid,
      ctime: b.ctime,
      size: b.size,
      format: b.format,
      notes: b.notes || '',
      subtype: b.subtype || 'unknown',
    }))
  } catch (error) {
    console.error(`[Proxmox] Failed to get backup content (${node}/${storage}):`, error)
    return []
  }
}

/**
 * Get backup storage info — storages that hold backup content
 */
export async function getBackupStorages() {
  try {
    const resources = await proxmoxApi('/cluster/resources?type=storage')
    const seen = new Set()
    return (Array.isArray(resources) ? resources : [])
      .filter(s => {
        const content = s.content || ''
        const isBackup = content === 'backup' || content.includes('backup')
        // Deduplicate shared storages — keep one entry per storage name
        const key = s.storage
        if (isBackup && !seen.has(key)) {
          seen.add(key)
          return true
        }
        return false
      })
      .map(s => ({
        storage: s.storage,
        node: s.node,
        plugintype: s.plugintype,
        shared: s.shared === 1,
        disk: s.disk || 0,
        maxdisk: s.maxdisk || 0,
        usedPercent: s.maxdisk > 0 ? ((s.disk / s.maxdisk) * 100).toFixed(1) : 0,
      }))
  } catch (error) {
    console.error('[Proxmox] Failed to get backup storages:', error)
    return []
  }
}

export default {
  getVMs,
  getContainers,
  splitGuestResources,
  getClusterStatus,
  getNodeStatus,
  getVMStatus,
  getStorage,
  getSnapshots,
  getOverview,
  getVMIPs,
  getBackupSchedules,
  getBackupTasks,
  getBackupContent,
  getBackupStorages,
  formatBytes,
  formatUptime
}
