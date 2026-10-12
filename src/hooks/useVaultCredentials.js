/**
 * useVaultCredentials Hook — QuoxVault Phase 5
 *
 * Fetches org vault credentials with filtering, search, and grouping.
 * Supports type, visibility, folder, status, and text search filters.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { VAULT_LIST } from '../config/apiPaths';

const POLL_INTERVAL = 60_000; // 60 seconds

// AI-relevant integration types for default filtering
const AI_PROVIDER_TYPES = [
    'openai', 'anthropic', 'gemini', 'perplexity',
    'groq', 'mistral', 'xai', 'deepseek', 'together',
    'elevenlabs'
];

/**
 * Group credentials by integration_type
 * @param {Array} credentials
 * @returns {Object} { openai: [...], anthropic: [...], ... }
 */
function groupByType(credentials) {
    const grouped = {};
    for (const cred of credentials) {
        const type = cred.integration_type;
        if (!grouped[type]) grouped[type] = [];
        grouped[type].push(cred);
    }
    return grouped;
}

/**
 * @param {Object} options
 * @param {string} [options.type] - Filter to a specific integration type (e.g., 'openai')
 * @param {boolean} [options.aiOnly=false] - Filter to AI provider types only
 * @param {boolean} [options.autoPoll=false] - Poll every 60s
 * @param {string} [options.visibility] - Filter by visibility: 'org', 'team', 'personal'
 * @param {string} [options.folderId] - Filter by folder ID
 * @param {string} [options.status] - Filter by health status: 'healthy', 'failed', 'untested'
 * @param {string} [options.search] - Text search across label and description
 * @returns {Object} { credentials, grouped, filtered, loading, error, refresh }
 */
export function useVaultCredentials({
    type,
    orgId: providedOrgId,
    aiOnly = false,
    autoPoll = false,
    visibility,
    folderId,
    status,
    search
} = {}) {
    const [credentials, setCredentials] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const mountedRef = useRef(true);
    const timerRef = useRef(null);

    const fetchCredentials = useCallback(async () => {
        try {
            const orgId = providedOrgId || localStorage.getItem('current_org_id');
            if (!orgId) {
                setLoading(false);
                return;
            }

            const params = new URLSearchParams();
            if (type) params.set('type', type);
            if (visibility) params.set('visibility', visibility);
            if (folderId) params.set('folder_id', folderId);
            const query = params.toString() ? `?${params.toString()}` : '';

            const res = await fetch(`${VAULT_LIST(orgId)}${query}`, {
                credentials: 'include'
            });
            if (!res.ok) {
                if (res.status === 401 || res.status === 404) return;
                throw new Error(`Failed to fetch vault credentials: ${res.status}`);
            }
            const data = await res.json();
            if (mountedRef.current) {
                let creds = data.credentials || [];
                // Filter to AI providers if requested and no specific type given
                if (aiOnly && !type) {
                    creds = creds.filter(c => AI_PROVIDER_TYPES.includes(c.integration_type));
                }
                setCredentials(creds);
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
    }, [type, providedOrgId, aiOnly, visibility, folderId]);

    useEffect(() => {
        mountedRef.current = true;
        fetchCredentials();

        if (autoPoll) {
            timerRef.current = setInterval(fetchCredentials, POLL_INTERVAL);
        }

        return () => {
            mountedRef.current = false;
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [fetchCredentials, autoPoll]);

    // Client-side filtering for status and search (server doesn't have health status)
    const filtered = useMemo(() => {
        let result = credentials;

        if (status) {
            result = result.filter(c => {
                const health = c.last_test_status || 'untested';
                return health === status;
            });
        }

        if (search?.trim()) {
            const q = search.toLowerCase().trim();
            result = result.filter(c =>
                (c.label || '').toLowerCase().includes(q) ||
                (c.description || '').toLowerCase().includes(q) ||
                (c.integration_type || '').toLowerCase().includes(q)
            );
        }

        return result;
    }, [credentials, status, search]);

    return {
        credentials,
        filtered,
        grouped: groupByType(credentials),
        loading,
        error,
        refresh: fetchCredentials
    };
}

/**
 * useMultiOrgVaultCredentials - Fetch vault credentials across multiple orgs
 *
 * Parallel-fetches from each org, tags results with org_id, merges.
 */
export function useMultiOrgVaultCredentials({
    orgIds = [],
    type,
    aiOnly = false,
    visibility,
    folderId,
    status,
    search
} = {}) {
    const [credentials, setCredentials] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const mountedRef = useRef(true);

    const fetchAll = useCallback(async () => {
        if (!orgIds.length) { setLoading(false); return; }

        try {
            const params = new URLSearchParams();
            if (type) params.set('type', type);
            if (visibility) params.set('visibility', visibility);
            if (folderId) params.set('folder_id', folderId);
            const query = params.toString() ? `?${params.toString()}` : '';

            const results = await Promise.allSettled(
                orgIds.map(async (orgId) => {
                    const res = await fetch(`${VAULT_LIST(orgId)}${query}`, {
                        credentials: 'include'
                    });
                    if (!res.ok) {
                        if (res.status === 401 || res.status === 404) return [];
                        throw new Error(`HTTP ${res.status}`);
                    }
                    const data = await res.json();
                    let creds = data.credentials || [];
                    if (aiOnly && !type) {
                        creds = creds.filter(c => AI_PROVIDER_TYPES.includes(c.integration_type));
                    }
                    return creds.map(c => ({ ...c, org_id: c.org_id || orgId }));
                })
            );

            if (mountedRef.current) {
                const merged = results
                    .filter(r => r.status === 'fulfilled')
                    .flatMap(r => r.value);
                setCredentials(merged);
                setError(null);
            }
        } catch (err) {
            if (mountedRef.current) setError(err.message);
        } finally {
            if (mountedRef.current) setLoading(false);
        }
    }, [orgIds.join(','), type, aiOnly, visibility, folderId]);

    useEffect(() => {
        mountedRef.current = true;
        fetchAll();
        return () => { mountedRef.current = false; };
    }, [fetchAll]);

    const filtered = useMemo(() => {
        let result = credentials;
        if (status) {
            result = result.filter(c => (c.last_test_status || 'untested') === status);
        }
        if (search?.trim()) {
            const q = search.toLowerCase().trim();
            result = result.filter(c =>
                (c.label || '').toLowerCase().includes(q) ||
                (c.description || '').toLowerCase().includes(q) ||
                (c.integration_type || '').toLowerCase().includes(q)
            );
        }
        return result;
    }, [credentials, status, search]);

    return {
        credentials,
        filtered,
        grouped: groupByType(credentials),
        loading,
        error,
        refresh: fetchAll
    };
}

export { AI_PROVIDER_TYPES };
export default useVaultCredentials;
