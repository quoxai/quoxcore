/**
 * useInboxStats - Hook for fetching inbox statistics
 *
 * Polls inbox stats to show badge counts in sidebar.
 * Part of Mission 2: Teams/Inbox Visibility.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useWorkspace } from '../contexts/WorkspaceContext';

// Default poll interval: 60 seconds
const DEFAULT_POLL_INTERVAL = 60000;

// Dev mode mock stats
const DEV_MOCK_STATS = {
    open: 4,
    in_progress: 1,
    waiting: 1,
    resolved: 0,
    urgent: 2,
    overdue: 1,
    total_active: 6,
    pending_approvals: 2
};

/**
 * Hook to fetch and poll inbox statistics
 * @param {Object} options
 * @param {number} options.pollInterval - Poll interval in ms (default: 60000)
 * @param {boolean} options.enabled - Whether polling is enabled (default: true)
 * @returns {Object} { stats, loading, error, refetch }
 */
export function useInboxStats({ pollInterval = DEFAULT_POLL_INTERVAL, enabled = true } = {}) {
    const { authFetch, user, isDevMode } = useAuth();
    const { currentOrg } = useWorkspace();
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const intervalRef = useRef(null);

    // Check if we're in dev mode
    const isDevOrg = currentOrg?.id === 'dev-org-001' || isDevMode || user?.is_dev_mode;

    const fetchStats = useCallback(async () => {
        if (!currentOrg?.id) {
            setStats(null);
            setLoading(false);
            return;
        }

        // Use mock data in dev mode
        if (isDevOrg) {
            // Simulate small delay
            await new Promise(r => setTimeout(r, 100));
            setStats(DEV_MOCK_STATS);
            setLoading(false);
            setError(null);
            return;
        }

        try {
            const response = await authFetch(`/api/orgs/${currentOrg.id}/inbox/stats`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            setStats({
                open: data.open || 0,
                in_progress: data.in_progress || 0,
                waiting: data.waiting || 0,
                resolved: data.resolved || 0,
                urgent: data.urgent || 0,
                overdue: data.overdue || 0,
                total_active: data.total_active || 0,
                unread: data.unread || 0,
                flagged: data.flagged || 0,
                snoozed: data.snoozed || 0,
                pending_approvals: data.pending_approvals || 0
            });
            setError(null);
        } catch (err) {
            console.warn('[useInboxStats] Failed to fetch stats:', err);
            setError(err.message || 'Failed to fetch inbox stats');
            // Don't clear stats on error to preserve last known state
        } finally {
            setLoading(false);
        }
    }, [authFetch, currentOrg?.id, isDevOrg]);

    // Initial fetch and polling
    useEffect(() => {
        if (!enabled) return;

        // Initial fetch
        fetchStats();

        // Set up polling
        if (pollInterval > 0) {
            intervalRef.current = setInterval(fetchStats, pollInterval);
        }

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, [fetchStats, enabled, pollInterval]);

    // Computed values for easy consumption
    const badgeCount = stats?.total_active || 0;
    const hasUrgent = (stats?.urgent || 0) > 0 || (stats?.overdue || 0) > 0;

    return {
        stats,
        loading,
        error,
        refetch: fetchStats,
        // Convenience values for sidebar badge
        badgeCount,
        hasUrgent
    };
}

export default useInboxStats;
