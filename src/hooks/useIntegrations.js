/**
 * useIntegrations Hook
 *
 * React hook for managing integration credentials state.
 * Provides caching, optimistic updates, and easy access to vault operations.
 *
 * Usage:
 * ```jsx
 * const {
 *   integrations,
 *   loading,
 *   error,
 *   addIntegration,
 *   updateIntegration,
 *   deleteIntegration,
 *   testIntegration,
 *   setDefault,
 *   refresh
 * } = useIntegrations();
 *
 * // Or filter by type
 * const { integrations: openaiKeys } = useIntegrations({ type: 'openai' });
 * ```
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { integrationsClient } from '../services/integrationsClient';
import { INTEGRATION_TYPES } from '../config/integrationTypes';

// Simple cache for sharing data between hook instances
const cache = {
    data: null,
    timestamp: 0,
    TTL: 30000 // 30 seconds
};

/**
 * Hook for managing integrations
 * @param {Object} [options] - Hook options
 * @param {string} [options.type] - Filter by integration type
 * @param {boolean} [options.autoRefresh] - Auto-refresh on mount (default: true)
 * @returns {Object} Hook state and methods
 */
export function useIntegrations(options = {}) {
    const { type, autoRefresh = true } = options;

    const [integrations, setIntegrations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const mountedRef = useRef(true);

    // Fetch integrations
    const fetchIntegrations = useCallback(async (force = false) => {
        // Use cache if fresh and not forced
        if (!force && cache.data && Date.now() - cache.timestamp < cache.TTL) {
            setIntegrations(cache.data);
            setLoading(false);
            return;
        }

        try {
            setLoading(true);
            setError(null);

            const result = await integrationsClient.list();

            if (!mountedRef.current) return;

            if (result.error) {
                setError(result.error);
                setIntegrations([]);
            } else {
                const data = result.credentials || [];
                cache.data = data;
                cache.timestamp = Date.now();
                setIntegrations(data);
            }
        } catch (err) {
            if (mountedRef.current) {
                setError(err.message);
                setIntegrations([]);
            }
        } finally {
            if (mountedRef.current) {
                setLoading(false);
            }
        }
    }, []);

    // Initial fetch
    useEffect(() => {
        mountedRef.current = true;

        if (autoRefresh) {
            fetchIntegrations();
        }

        return () => {
            mountedRef.current = false;
        };
    }, [fetchIntegrations, autoRefresh]);

    // Filter by type if specified
    const filteredIntegrations = useMemo(() => {
        if (!type) return integrations;
        return integrations.filter(i => i.integration_type === type);
    }, [integrations, type]);

    // Group by type
    const groupedByType = useMemo(() => {
        const groups = {};
        for (const integration of integrations) {
            const t = integration.integration_type;
            if (!groups[t]) {
                groups[t] = {
                    type: INTEGRATION_TYPES[t] || { id: t, name: t, color: '#6B7280' },
                    items: []
                };
            }
            groups[t].items.push(integration);
        }
        return groups;
    }, [integrations]);

    // Add integration
    const addIntegration = useCallback(async (data) => {
        const result = await integrationsClient.create(data);

        if (result.success && mountedRef.current) {
            // Update local state
            setIntegrations(prev => {
                const updated = [...prev, result];
                cache.data = updated;
                cache.timestamp = Date.now();
                return updated;
            });
        }

        return result;
    }, []);

    // Update integration
    const updateIntegration = useCallback(async (id, data) => {
        const result = await integrationsClient.update(id, data);

        if (result.success && mountedRef.current) {
            setIntegrations(prev => {
                const updated = prev.map(i => i.id === id ? { ...i, ...result } : i);
                cache.data = updated;
                cache.timestamp = Date.now();
                return updated;
            });
        }

        return result;
    }, []);

    // Delete integration
    const deleteIntegration = useCallback(async (id) => {
        const result = await integrationsClient.delete(id);

        if (result.success && mountedRef.current) {
            setIntegrations(prev => {
                const updated = prev.filter(i => i.id !== id);
                cache.data = updated;
                cache.timestamp = Date.now();
                return updated;
            });
        }

        return result;
    }, []);

    // Test integration
    const testIntegration = useCallback(async (id) => {
        const result = await integrationsClient.test(id);

        if (mountedRef.current) {
            // Update test status in local state
            setIntegrations(prev => {
                const updated = prev.map(i =>
                    i.id === id
                        ? {
                            ...i,
                            test_status: result.success ? 'success' : 'failed',
                            last_tested_at: new Date().toISOString()
                        }
                        : i
                );
                cache.data = updated;
                cache.timestamp = Date.now();
                return updated;
            });
        }

        return result;
    }, []);

    // Set as default
    const setDefault = useCallback(async (id) => {
        const integration = integrations.find(i => i.id === id);
        if (!integration) return { success: false, error: 'Integration not found' };

        const result = await integrationsClient.setDefault(id);

        if (result.success && mountedRef.current) {
            // Update local state - unset other defaults of same type
            setIntegrations(prev => {
                const updated = prev.map(i => {
                    if (i.id === id) return { ...i, is_default: true };
                    if (i.integration_type === integration.integration_type) {
                        return { ...i, is_default: false };
                    }
                    return i;
                });
                cache.data = updated;
                cache.timestamp = Date.now();
                return updated;
            });
        }

        return result;
    }, [integrations]);

    // Get default for a type
    const getDefault = useCallback((integrationType) => {
        const ofType = integrations.filter(i => i.integration_type === integrationType);
        return ofType.find(i => i.is_default) || ofType[0] || null;
    }, [integrations]);

    // Refresh
    const refresh = useCallback(() => {
        return fetchIntegrations(true);
    }, [fetchIntegrations]);

    // Invalidate cache (for use after external changes)
    const invalidateCache = useCallback(() => {
        cache.data = null;
        cache.timestamp = 0;
    }, []);

    return {
        // State
        integrations: filteredIntegrations,
        allIntegrations: integrations,
        groupedByType,
        loading,
        error,

        // Actions
        addIntegration,
        updateIntegration,
        deleteIntegration,
        testIntegration,
        setDefault,
        getDefault,
        refresh,
        invalidateCache,

        // Helpers
        hasIntegrations: integrations.length > 0,
        hasType: (t) => integrations.some(i => i.integration_type === t),
        countByType: (t) => integrations.filter(i => i.integration_type === t).length
    };
}

/**
 * Hook for selecting an integration in a form/workflow
 * Provides a simpler API for integration selection
 *
 * @param {string} type - Integration type to filter by
 * @returns {Object} Selection state and helpers
 */
export function useIntegrationSelect(type) {
    const { integrations, loading, refresh, getDefault } = useIntegrations({ type });
    const [selectedId, setSelectedId] = useState(null);

    // Auto-select default when integrations load
    useEffect(() => {
        if (!selectedId && integrations.length > 0) {
            const defaultInt = getDefault(type);
            if (defaultInt) {
                setSelectedId(defaultInt.id);
            }
        }
    }, [integrations, selectedId, type, getDefault]);

    const selected = useMemo(() => {
        return integrations.find(i => i.id === selectedId) || null;
    }, [integrations, selectedId]);

    const options = useMemo(() => {
        return integrations.map(i => ({
            id: i.id,
            label: i.label,
            preview: i.key_preview,
            isDefault: i.is_default
        }));
    }, [integrations]);

    return {
        integrations,
        options,
        loading,
        selectedId,
        selected,
        setSelectedId,
        refresh,
        hasOptions: options.length > 0
    };
}

export default useIntegrations;
