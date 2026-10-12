/**
 * useVaultHealth Hook — QuoxVault Phase 2
 *
 * Fetches vault health stats, issues, and activity feed.
 * Polls every 60s for live dashboard updates.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { csrfFetch } from '../utils/csrfFetch';
import { VAULT_STATS, VAULT_HEALTH_SCAN, VAULT_ACTIVITY } from '../config/apiPaths';

const POLL_INTERVAL = 60_000; // 60 seconds

function getOrgId(orgId) {
    if (orgId && orgId !== 'current') return orgId;
    return localStorage.getItem('current_org_id');
}

/**
 * @returns {Object} { stats, issues, loading, error, refresh, runScan, scanning }
 */
export function useVaultHealth({ orgId: orgIdProp, autoPoll = true } = {}) {
    const [stats, setStats] = useState(null);
    const [issues, setIssues] = useState([]);
    const [loading, setLoading] = useState(true);
    const [scanning, setScanning] = useState(false);
    const [error, setError] = useState(null);
    const mountedRef = useRef(true);
    const timerRef = useRef(null);

    const fetchStats = useCallback(async () => {
        const orgId = getOrgId(orgIdProp);
        if (!orgId) return;
        try {
            const res = await fetch(VAULT_STATS(orgId), {
                credentials: 'include'
            });
            if (!res.ok) {
                if (res.status === 401 || res.status === 404) return;
                throw new Error(`Failed to fetch vault stats: ${res.status}`);
            }
            const data = await res.json();
            if (mountedRef.current) {
                setStats(data);
                setError(null);
            }
        } catch (err) {
            if (mountedRef.current) {
                setError(err.message);
            }
        } finally {
            if (mountedRef.current) {
                setLoading(false);
            }
        }
    }, [orgIdProp]);

    const runScan = useCallback(async () => {
        const orgId = getOrgId(orgIdProp);
        if (!orgId) return null;
        setScanning(true);
        try {
            const res = await csrfFetch(VAULT_HEALTH_SCAN(orgId), {
                method: 'POST'
            });
            if (!res.ok) throw new Error(`Health scan failed: ${res.status}`);
            const data = await res.json();
            if (mountedRef.current) {
                setIssues(data.issues || []);
                setStats(data.stats || null);
                setError(null);
            }
            return data;
        } catch (err) {
            if (mountedRef.current) {
                setError(err.message);
            }
            return null;
        } finally {
            if (mountedRef.current) {
                setScanning(false);
            }
        }
    }, [orgIdProp]);

    useEffect(() => {
        mountedRef.current = true;
        fetchStats();

        if (autoPoll) {
            timerRef.current = setInterval(fetchStats, POLL_INTERVAL);
        }

        return () => {
            mountedRef.current = false;
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [fetchStats, autoPoll]);

    return {
        stats,
        issues,
        loading,
        scanning,
        error,
        refresh: fetchStats,
        runScan
    };
}

/**
 * useVaultActivity Hook
 * Fetches recent vault events from audit log
 */
export function useVaultActivity({ orgId: orgIdProp, limit = 20, autoPoll = false } = {}) {
    const [events, setEvents] = useState([]);
    const [loading, setLoading] = useState(true);
    const mountedRef = useRef(true);

    const fetchActivity = useCallback(async () => {
        const orgId = getOrgId(orgIdProp);
        if (!orgId) return;
        try {
            const res = await fetch(`${VAULT_ACTIVITY(orgId)}?limit=${limit}`, {
                credentials: 'include'
            });
            if (!res.ok) return;
            const data = await res.json();
            if (mountedRef.current) {
                setEvents(data.events || []);
            }
        } catch {
            // Silently fail — activity feed is non-critical
        } finally {
            if (mountedRef.current) setLoading(false);
        }
    }, [orgIdProp, limit]);

    useEffect(() => {
        mountedRef.current = true;
        fetchActivity();

        let timer;
        if (autoPoll) {
            timer = setInterval(fetchActivity, POLL_INTERVAL);
        }

        return () => {
            mountedRef.current = false;
            if (timer) clearInterval(timer);
        };
    }, [fetchActivity, autoPoll]);

    return { events, loading, refresh: fetchActivity };
}

export default useVaultHealth;
