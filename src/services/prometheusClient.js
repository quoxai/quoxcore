/**
 * Prometheus Client Service
 * Routes all requests through the collector proxy to avoid CORS issues
 * and keep service URLs server-side.
 */

const PROXY_BASE = '/collector/api/v1/monitoring/proxy/prometheus'

/**
 * Execute a PromQL query
 * @param {string} query - PromQL query string
 * @param {object} options - Query options (time, timeout)
 * @returns {Promise<object>} Query result
 */
export async function queryPrometheus(query, options = {}) {
  const params = new URLSearchParams({
    query,
    ...(options.time && { time: options.time }),
    ...(options.timeout && { timeout: options.timeout })
  })

  try {
    const response = await fetch(`${PROXY_BASE}/api/v1/query?${params}`)
    const data = await response.json()

    if (data.status !== 'success') {
      throw new Error(data.error || 'Prometheus query failed')
    }

    return {
      success: true,
      resultType: data.data.resultType,
      result: data.data.result
    }
  } catch (error) {
    console.error('[Prometheus] Query failed:', error)
    return {
      success: false,
      error: error.message
    }
  }
}

/**
 * Execute a range query
 * @param {string} query - PromQL query string
 * @param {string} start - Start time (RFC3339 or unix timestamp)
 * @param {string} end - End time
 * @param {string} step - Query resolution step (e.g., '15s', '1m')
 * @returns {Promise<object>} Query result
 */
export async function queryRange(query, start, end, step = '1m') {
  const params = new URLSearchParams({ query, start, end, step })

  try {
    const response = await fetch(`${PROXY_BASE}/api/v1/query_range?${params}`)
    const data = await response.json()

    if (data.status !== 'success') {
      throw new Error(data.error || 'Prometheus range query failed')
    }

    return {
      success: true,
      resultType: data.data.resultType,
      result: data.data.result
    }
  } catch (error) {
    console.error('[Prometheus] Range query failed:', error)
    return {
      success: false,
      error: error.message
    }
  }
}

/**
 * Get all currently firing alerts
 * @returns {Promise<object>} Active alerts
 */
export async function getAlerts() {
  try {
    const response = await fetch(`${PROXY_BASE}/api/v1/alerts`)
    const data = await response.json()

    if (data.status !== 'success') {
      throw new Error(data.error || 'Failed to fetch alerts')
    }

    const alerts = data.data.alerts || []

    // Categorize alerts by state and severity
    const firing = alerts.filter(a => a.state === 'firing')
    const pending = alerts.filter(a => a.state === 'pending')

    const critical = firing.filter(a => a.labels?.severity === 'critical')
    const warning = firing.filter(a => a.labels?.severity === 'warning')
    const info = firing.filter(a => !['critical', 'warning'].includes(a.labels?.severity))

    return {
      success: true,
      alerts,
      firing,
      pending,
      critical,
      warning,
      info,
      summary: {
        total: alerts.length,
        firing: firing.length,
        pending: pending.length,
        critical: critical.length,
        warning: warning.length
      }
    }
  } catch (error) {
    console.error('[Prometheus] Failed to fetch alerts:', error)
    return {
      success: false,
      error: error.message,
      alerts: [],
      firing: [],
      pending: [],
      critical: [],
      warning: [],
      info: [],
      summary: { total: 0, firing: 0, pending: 0, critical: 0, warning: 0 }
    }
  }
}

/**
 * Get all configured scrape targets
 * @returns {Promise<object>} Scrape targets with health status
 */
export async function getTargets() {
  try {
    const response = await fetch(`${PROXY_BASE}/api/v1/targets`)
    const data = await response.json()

    if (data.status !== 'success') {
      throw new Error(data.error || 'Failed to fetch targets')
    }

    const activeTargets = data.data.activeTargets || []
    const droppedTargets = data.data.droppedTargets || []

    // Categorize by health
    const up = activeTargets.filter(t => t.health === 'up')
    const down = activeTargets.filter(t => t.health === 'down')
    const unknown = activeTargets.filter(t => t.health === 'unknown')

    return {
      success: true,
      activeTargets,
      droppedTargets,
      up,
      down,
      unknown,
      summary: {
        total: activeTargets.length,
        up: up.length,
        down: down.length,
        unknown: unknown.length,
        dropped: droppedTargets.length
      }
    }
  } catch (error) {
    console.error('[Prometheus] Failed to fetch targets:', error)
    return {
      success: false,
      error: error.message,
      activeTargets: [],
      summary: { total: 0, up: 0, down: 0, unknown: 0, dropped: 0 }
    }
  }
}

/**
 * Get Prometheus server metadata
 * @returns {Promise<object>} Server info
 */
export async function getStatus() {
  try {
    const [buildInfo, runtimeInfo, configResponse] = await Promise.all([
      fetch(`${PROXY_BASE}/api/v1/status/buildinfo`).then(r => r.json()),
      fetch(`${PROXY_BASE}/api/v1/status/runtimeinfo`).then(r => r.json()),
      fetch(`${PROXY_BASE}/api/v1/status/config`).then(r => r.json())
    ])

    return {
      success: true,
      version: buildInfo.data?.version,
      goVersion: buildInfo.data?.goVersion,
      startTime: runtimeInfo.data?.startTime,
      storageRetention: runtimeInfo.data?.storageRetention,
      configReloadedAt: configResponse.data?.configReloadedAt
    }
  } catch (error) {
    console.error('[Prometheus] Failed to fetch status:', error)
    return {
      success: false,
      error: error.message
    }
  }
}

/**
 * Common metric queries for dashboard
 */
export const COMMON_QUERIES = {
  // CPU usage per instance
  cpuUsage: '100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',

  // Memory usage per instance
  memoryUsage: '(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100',

  // Disk usage per instance
  diskUsage: '(1 - (node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})) * 100',

  // Network receive rate
  networkRx: 'rate(node_network_receive_bytes_total{device!="lo"}[5m])',

  // Network transmit rate
  networkTx: 'rate(node_network_transmit_bytes_total{device!="lo"}[5m])',

  // System uptime
  uptime: 'node_time_seconds - node_boot_time_seconds',

  // Load average (1 min)
  loadAvg: 'node_load1',

  // Total hosts up
  hostsUp: 'count(up == 1)',

  // Total hosts down
  hostsDown: 'count(up == 0)'
}

/**
 * Get quick system overview
 * @returns {Promise<object>} System metrics overview
 */
export async function getSystemOverview() {
  try {
    const [alerts, targets, cpuResult, memResult, diskResult] = await Promise.all([
      getAlerts(),
      getTargets(),
      queryPrometheus(COMMON_QUERIES.cpuUsage),
      queryPrometheus(COMMON_QUERIES.memoryUsage),
      queryPrometheus(COMMON_QUERIES.diskUsage)
    ])

    // If no real data, show setup prompt
    if (!cpuResult.success && !targets.success) {
      console.log('[Prometheus] Not connected — prompting setup')
      return {
        success: false,
        needsSetup: true,
        error: 'Prometheus not reachable',
        setupHint: 'Configure your Prometheus URL via the setup wizard on this page.'
      }
    }

    // Process CPU metrics
    const cpuMetrics = cpuResult.result?.map(r => ({
      instance: r.metric.instance,
      value: parseFloat(r.value[1]).toFixed(1)
    })) || []

    // Process memory metrics
    const memMetrics = memResult.result?.map(r => ({
      instance: r.metric.instance,
      value: parseFloat(r.value[1]).toFixed(1)
    })) || []

    // Process disk metrics
    const diskMetrics = diskResult.result?.map(r => ({
      instance: r.metric.instance,
      mountpoint: r.metric.mountpoint,
      value: parseFloat(r.value[1]).toFixed(1)
    })) || []

    // Calculate averages
    const avgCpu = cpuMetrics.length > 0
      ? (cpuMetrics.reduce((sum, m) => sum + parseFloat(m.value), 0) / cpuMetrics.length).toFixed(1)
      : 0
    const avgMem = memMetrics.length > 0
      ? (memMetrics.reduce((sum, m) => sum + parseFloat(m.value), 0) / memMetrics.length).toFixed(1)
      : 0
    const avgDisk = diskMetrics.length > 0
      ? (diskMetrics.reduce((sum, m) => sum + parseFloat(m.value), 0) / diskMetrics.length).toFixed(1)
      : 0

    return {
      success: true,
      alerts: alerts.summary,
      targets: targets.summary,
      metrics: {
        cpu: { avg: avgCpu, instances: cpuMetrics },
        memory: { avg: avgMem, instances: memMetrics },
        disk: { avg: avgDisk, instances: diskMetrics }
      }
    }
  } catch (error) {
    console.error('[Prometheus] Failed to get system overview:', error)
    return {
      success: false,
      error: error.message
    }
  }
}

export default {
  queryPrometheus,
  queryRange,
  getAlerts,
  getTargets,
  getStatus,
  getSystemOverview,
  COMMON_QUERIES
}
