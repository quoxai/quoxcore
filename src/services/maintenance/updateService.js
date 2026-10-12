/**
 * Update Service
 *
 * Factory-pattern service for system update operations.
 * Matches the createBackupService() pattern from backup/backupService.js.
 *
 * Usage:
 *   const svc = createUpdateService(authFetch, orgId)
 *   const status = await svc.getUpdateStatus()
 */

/**
 * Compare two semver strings.
 * Returns: -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareSemver(a, b) {
    const pa = (a || '0.0.0').replace(/^v/, '').split('.').map(Number);
    const pb = (b || '0.0.0').replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    return 0;
}

/**
 * Get the current QuoxCORE version from the build-time injected env var
 */
export function getLocalVersion() {
    return import.meta.env.VITE_QUOXCORE_VERSION || '0.0.0';
}

/**
 * Create an update service bound to an org context
 * @param {Function} authFetch - Authenticated fetch function
 * @param {string} orgId - Organization ID
 * @returns {Object} Service object with update methods
 */
export function createUpdateService(authFetch, orgId) {
    if (!orgId) {
        throw new Error('Organization context not available — cannot create update service');
    }

    const basePath = `/api/orgs/${orgId}`;

    async function request(path, options = {}) {
        const res = await authFetch(`${basePath}${path}`, {
            headers: { 'Content-Type': 'application/json', ...options.headers },
            ...options
        });

        if (!res.ok) {
            let message;
            try {
                const data = await res.json();
                message = data.error || res.statusText;
            } catch {
                message = res.statusText;
            }
            throw new Error(message);
        }

        return res.json();
    }

    return {
        /**
         * Get current version, available version, active operation, and settings
         */
        getUpdateStatus() {
            return request('/update-status');
        },

        /**
         * Force a version check against GitHub releases
         */
        checkForUpdates() {
            return request('/update-check', { method: 'POST' });
        },

        /**
         * Get changelog markdown for available update
         */
        getChangelog() {
            return request('/update-changelog');
        },

        /**
         * Start an update operation (admin only)
         */
        startUpdate() {
            return request('/update-start', { method: 'POST' });
        },

        /**
         * Cancel an in-progress update (admin only)
         */
        cancelUpdate() {
            return request('/update-cancel', { method: 'POST' });
        },

        /**
         * Rollback to a previous version (admin only)
         * @param {string} [operationId] - Specific operation to rollback, or latest
         */
        rollbackUpdate(operationId) {
            return request('/update-rollback', {
                method: 'POST',
                body: JSON.stringify(operationId ? { operation_id: operationId } : {})
            });
        },

        /**
         * Get past update operations
         * @param {Object} [params] - { limit, offset }
         */
        getUpdateHistory(params = {}) {
            const query = new URLSearchParams();
            if (params.limit) query.set('limit', params.limit);
            if (params.offset) query.set('offset', params.offset);
            const qs = query.toString();
            return request(`/update-history${qs ? `?${qs}` : ''}`);
        },

        /**
         * Get update settings
         */
        getUpdateSettings() {
            return request('/update-settings');
        },

        /**
         * Update settings (admin only)
         * @param {Object} settings - Fields to update
         */
        updateSettings(settings) {
            return request('/update-settings', {
                method: 'PATCH',
                body: JSON.stringify(settings)
            });
        },

        /**
         * Get the SSE URL for update progress streaming
         */
        getProgressStreamUrl() {
            return `${basePath}/update-progress`;
        }
    };
}
