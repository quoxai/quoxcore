/**
 * useConnectorStatus Hook — Phase 6.4
 *
 * Fetches connector bridge status and available tools from the collector.
 * Used by VaultDashboardView to show active connector integrations.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

const POLL_INTERVAL = 60_000; // 60 seconds

function getOrgId() {
    return localStorage.getItem('current_org_id') || 'default';
}

/**
 * @returns {Object} { bridge, tools, loading, error, refresh }
 */
export function useConnectorStatus({ autoPoll = true } = {}) {
    const [bridge, setBridge] = useState(null);
    const [tools, setTools] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const mountedRef = useRef(true);
    const timerRef = useRef(null);

    const fetchStatus = useCallback(async () => {
        try {
            const [statusRes, toolsRes] = await Promise.all([
                fetch('/collector/connectors/status', {
                    credentials: 'include',
                    signal: AbortSignal.timeout(5000),
                }),
                fetch(`/collector/connectors/tools?orgId=${encodeURIComponent(getOrgId())}`, {
                    credentials: 'include',
                    signal: AbortSignal.timeout(8000),
                }),
            ]);

            if (!mountedRef.current) return;

            if (statusRes.ok) {
                const data = await statusRes.json();
                setBridge(data);
            }

            if (toolsRes.ok) {
                const data = await toolsRes.json();
                setTools(data.tools || []);
            }

            setError(null);
        } catch (err) {
            if (mountedRef.current) {
                setError(err.message);
            }
        } finally {
            if (mountedRef.current) {
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        fetchStatus();

        if (autoPoll) {
            timerRef.current = setInterval(fetchStatus, POLL_INTERVAL);
        }

        return () => {
            mountedRef.current = false;
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [fetchStatus, autoPoll]);

    return { bridge, tools, loading, error, refresh: fetchStatus };
}
