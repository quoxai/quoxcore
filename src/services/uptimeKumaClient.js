/**
 * Uptime Kuma Client Service
 * Uses server-side cached endpoints for instant page loads.
 * The collector fetches from Kuma, caches results, and serves them.
 */

const STATUS_API = '/collector/api/v1/monitoring/uptime-kuma/status'

/**
 * Fetch all configured status pages from the collector's monitoring config.
 * @returns {Promise<Array<{slug: string, label: string}>>} Array of status pages
 */
export async function getConfiguredPages(orgId) {
  try {
    const headers = {}
    if (orgId) headers['X-Org-Id'] = orgId
    const resp = await fetch('/collector/api/v1/monitoring/config', { headers, credentials: 'include' })
    const data = await resp.json()
    const kumaConfig = data.services?.['uptime-kuma']
    if (kumaConfig?.statusPages?.length) return kumaConfig.statusPages
    // Backwards compat: single slug
    if (kumaConfig?.statusPageSlug) return [{ slug: kumaConfig.statusPageSlug, label: kumaConfig.statusPageSlug }]
    return []
  } catch {
    return []
  }
}

/**
 * Remove a status page from the config.
 * @param {string} slug - The slug to remove
 * @returns {Promise<object>} Result with remaining pages
 */
export async function removeStatusPage(slug, orgId) {
  try {
    const headers = {}
    if (orgId) headers['X-Org-Id'] = orgId
    const resp = await fetch(`/collector/api/v1/monitoring/config/uptime-kuma/status-page/${slug}`, { method: 'DELETE', headers, credentials: 'include' })
    return await resp.json()
  } catch (error) {
    return { success: false, error: error.message }
  }
}

/**
 * Get status for a slug — returns cached data first, optionally refreshes.
 * @param {string} slug - Status page slug (required)
 * @param {object} opts
 * @param {boolean} opts.refresh - Force fresh fetch from Kuma
 * @returns {Promise<object>} Status data with cached/scannedAt metadata
 */
export async function getStatus(slug, { refresh = false } = {}, orgId) {
  try {
    // If no slug provided, fetch first configured page
    let targetSlug = slug
    if (!targetSlug) {
      const pages = await getConfiguredPages(orgId)
      if (pages.length === 0) {
        return {
          success: false,
          needsStatusPage: true,
          error: 'No status page configured.'
        }
      }
      targetSlug = pages[0].slug
    }

    const url = `${STATUS_API}/${targetSlug}${refresh ? '?refresh=true' : ''}`
    const headers = {}
    if (orgId) headers['X-Org-Id'] = orgId
    const resp = await fetch(url, { headers, credentials: 'include', signal: AbortSignal.timeout(refresh ? 15000 : 5000) })
    const data = await resp.json()

    if (!data.success) {
      return {
        success: false,
        needsSetup: true,
        error: data.error || 'Uptime Kuma not reachable',
        setupHint: 'Configure your Uptime Kuma URL via the setup wizard on this page.'
      }
    }

    return data
  } catch (error) {
    if (!error.message.includes('Failed to fetch')) {
      console.warn('[UptimeKuma] Unavailable:', error.message)
    }
    return {
      success: false,
      needsSetup: true,
      error: 'Uptime Kuma not reachable',
      setupHint: 'Configure your Uptime Kuma URL via the setup wizard on this page.'
    }
  }
}

/**
 * Trigger background refresh of all configured pages.
 * Returns immediately — the collector refreshes async.
 */
export async function refreshAll(orgId) {
  try {
    const headers = {}
    if (orgId) headers['X-Org-Id'] = orgId
    await fetch('/collector/api/v1/monitoring/uptime-kuma/refresh', { method: 'POST', headers, credentials: 'include' })
  } catch {
    // Best effort
  }
}

/**
 * Get overall health status
 * @param {string} slug - Status page slug
 * @returns {Promise<object>} Health status
 */
export async function getHealth(slug, orgId) {
  try {
    const status = await getStatus(slug, {}, orgId)

    if (!status.success) {
      return {
        success: false,
        healthy: false,
        error: status.error
      }
    }

    const { summary } = status
    const healthy = summary.down === 0 && summary.pending === 0

    return {
      success: true,
      healthy,
      status: healthy ? 'healthy' : (summary.down > 0 ? 'degraded' : 'warning'),
      summary,
      message: healthy
        ? `All ${summary.up} services operational`
        : `${summary.down} service(s) down, ${summary.up} operational`
    }
  } catch (error) {
    console.error('[UptimeKuma] Health check failed:', error)
    return {
      success: false,
      healthy: false,
      error: error.message
    }
  }
}

/**
 * Status code to text mapping
 */
export const STATUS_CODES = {
  0: { text: 'Down', color: '#dc3545', icon: 'error' },
  1: { text: 'Up', color: '#28a745', icon: 'check' },
  2: { text: 'Pending', color: '#ffc107', icon: 'pending' },
  3: { text: 'Maintenance', color: '#6c757d', icon: 'maintenance' }
}

/**
 * Get status text for a status code
 * @param {number} status - Status code
 * @returns {object} Status info
 */
export function getStatusInfo(status) {
  return STATUS_CODES[status] || { text: 'Unknown', color: '#6c757d', icon: 'unknown' }
}

/**
 * Format ping time
 * @param {number} ping - Ping in ms
 * @returns {string} Formatted ping
 */
export function formatPing(ping) {
  if (ping === null || ping === undefined) return '-'
  if (ping < 1) return '<1ms'
  if (ping > 1000) return `${(ping / 1000).toFixed(1)}s`
  return `${Math.round(ping)}ms`
}

/**
 * Get quick overview for dashboard
 * @param {string} slug - Status page slug
 * @returns {Promise<object>} Quick overview
 */
export async function getOverview(slug, orgId) {
  try {
    const health = await getHealth(slug, orgId)

    if (!health.success) {
      return {
        success: false,
        error: health.error
      }
    }

    return {
      success: true,
      status: health.status,
      healthy: health.healthy,
      message: health.message,
      summary: health.summary
    }
  } catch (error) {
    console.error('[UptimeKuma] Failed to get overview:', error)
    return {
      success: false,
      error: error.message
    }
  }
}

export default {
  getConfiguredPages,
  removeStatusPage,
  getStatus,
  refreshAll,
  getHealth,
  getOverview,
  getStatusInfo,
  formatPing,
  STATUS_CODES
}
