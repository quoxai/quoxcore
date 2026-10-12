/**
 * Backup Service
 * Frontend service for backup, restore, and migration operations.
 *
 * All API functions require (authFetch, orgId) — provided by the caller
 * via useAuth() and useWorkspace() hooks. Use createBackupService() to
 * create a bound instance from a React component.
 */

// Storage keys for local caching
const CACHE_KEY = 'quox-backup-cache'
const LAST_BACKUP_KEY = 'quox-last-backup'

/**
 * Create a backup service instance bound to authFetch + orgId.
 * Use from React components:
 *
 *   const { authFetch } = useAuth()
 *   const { currentOrg } = useWorkspace()
 *   const backup = createBackupService(authFetch, currentOrg?.id)
 */
export function createBackupService(authFetch, orgId) {
    if (!orgId) {
        throw new Error('Organization context not available — please select an organization')
    }

    async function request(path, options = {}) {
        const response = await authFetch(`/api/orgs/${orgId}${path}`, {
            headers: { 'Content-Type': 'application/json', ...options.headers },
            ...options
        })
        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: response.statusText }))
            throw new Error(error.error || error.message || 'Request failed')
        }
        return response.json()
    }

    return {
        // Status
        async getBackupStatus() {
            return request('/backup-status')
        },

        // Components
        async getBackupComponents() {
            const result = await request('/backup-components')
            return result.components || []
        },

        // Backups CRUD
        async listBackups(filters = {}) {
            const params = new URLSearchParams(filters)
            const result = await request(`/backups?${params}`)
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify({
                    timestamp: Date.now(),
                    backups: result.items || result.backups || []
                }))
            } catch (e) { /* ignore cache errors */ }
            return result
        },

        async getBackup(backupId) {
            const result = await request(`/backups/${backupId}`)
            return result.backup
        },

        async createBackup(options = {}) {
            const result = await request('/backups', {
                method: 'POST',
                body: JSON.stringify({
                    backup_type: options.backup_type || 'full',
                    name: options.name,
                    description: options.description,
                    components: options.components
                })
            })
            try {
                localStorage.setItem(LAST_BACKUP_KEY, JSON.stringify({
                    id: result.backup.id,
                    timestamp: Date.now()
                }))
            } catch (e) { /* ignore */ }
            return result.backup
        },

        async deleteBackup(backupId) {
            await request(`/backups/${backupId}`, { method: 'DELETE' })
        },

        // Verification
        async verifyBackup(backupId) {
            return request(`/backups/${backupId}/verify`, { method: 'POST' })
        },

        // Restore
        async restoreBackup(backupId, options = {}) {
            return request(`/backups/${backupId}/restore`, {
                method: 'POST',
                body: JSON.stringify({
                    dry_run: options.dry_run !== false,
                    components: options.components
                })
            })
        },

        async getRestoreOperation(restoreId) {
            const result = await request(`/restore-operations/${restoreId}`)
            return result.restore
        },

        // Schedules
        async listSchedules() {
            const result = await request('/backup-schedules')
            return result.schedules || []
        },

        async createSchedule(schedule) {
            const result = await request('/backup-schedules', {
                method: 'POST',
                body: JSON.stringify(schedule)
            })
            return result.schedule
        },

        async updateSchedule(scheduleId, updates) {
            await request(`/backup-schedules/${scheduleId}`, {
                method: 'PATCH',
                body: JSON.stringify(updates)
            })
        },

        async deleteSchedule(scheduleId) {
            await request(`/backup-schedules/${scheduleId}`, { method: 'DELETE' })
        },

        // Audit
        async getAuditLog(filters = {}) {
            const params = new URLSearchParams(filters)
            return request(`/backup-audit-log?${params}`)
        },

        // Comparison (pre-restore)
        async compareBackup(backupId) {
            return request(`/backups/${backupId}/compare`)
        },

        // Validation
        async validateRestore() {
            return request('/backups/validate-restore')
        },

        // Restore history (for rollback UI)
        async listRestoreOperations(limit = 10) {
            return request(`/restore-operations?limit=${limit}`)
        },

        // Rollback a restore
        async rollbackRestore(restoreId) {
            return request(`/restore-operations/${restoreId}/rollback`, {
                method: 'POST'
            })
        },

        // Scan backup directory for importable archives
        async scanForBackups() {
            return request('/backups/scan-imports', {
                method: 'POST'
            })
        }
    }
}

// ============================================================================
// UTILITIES (no auth needed — pure functions)
// ============================================================================

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes) {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

/**
 * Format duration in milliseconds to human readable string
 */
export function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
    const hours = Math.floor(minutes / 60)
    const remainingMinutes = minutes % 60
    return `${hours}h ${remainingMinutes}m`
}

/**
 * Get cached backup list (for offline/quick display)
 */
export function getCachedBackups() {
    try {
        const cached = localStorage.getItem(CACHE_KEY)
        if (cached) {
            const data = JSON.parse(cached)
            if (Date.now() - data.timestamp < 5 * 60 * 1000) {
                return data
            }
        }
    } catch (e) { /* ignore */ }
    return null
}

/**
 * Get last backup info
 */
export function getLastBackupInfo() {
    try {
        const info = localStorage.getItem(LAST_BACKUP_KEY)
        return info ? JSON.parse(info) : null
    } catch (e) {
        return null
    }
}

/**
 * Clear local cache
 */
export function clearCache() {
    try {
        localStorage.removeItem(CACHE_KEY)
        localStorage.removeItem(LAST_BACKUP_KEY)
    } catch (e) { /* ignore */ }
}

/**
 * Poll for backup/restore completion
 */
export async function pollForCompletion(fetchFn, onUpdate, interval = 2000, timeout = 600000) {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
        const status = await fetchFn()

        if (onUpdate) {
            onUpdate(status)
        }

        if (['completed', 'verified', 'failed', 'cancelled', 'dry_run_complete'].includes(status.status)) {
            return status
        }

        await new Promise(resolve => setTimeout(resolve, interval))
    }

    throw new Error('Operation timed out')
}

export default {
    createBackupService,
    formatBytes,
    formatDuration,
    getCachedBackups,
    getLastBackupInfo,
    clearCache,
    pollForCompletion
}
