/**
 * useIntegrationTypes Hook
 *
 * Fetches integration type definitions from the backend registry.
 * Falls back to static INTEGRATION_TYPES if API is unreachable.
 * Caches at module level so multiple components share the same data.
 */

import { useState, useEffect, useCallback } from 'react';
import { INTEGRATION_TYPES, INTEGRATION_CATEGORIES, getIntegrationsByCategory } from '../config/integrationTypes';

// Module-level cache shared across all hook instances
let cachedTypes = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Reset module cache (for testing only) */
export function _resetCache() {
    cachedTypes = null;
    cacheTimestamp = 0;
}

/**
 * Fetch integration types from backend API
 */
async function fetchTypesFromAPI(orgId) {
    const response = await fetch(`/api/orgs/${orgId}/vault/types`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.types || [];
}

/**
 * Hook for accessing integration type definitions
 * @returns {{ types: Object, getType: Function, categories: Object, getByCategory: Function, loading: boolean }}
 */
export function useIntegrationTypes() {
    const [types, setTypes] = useState(cachedTypes || INTEGRATION_TYPES);
    const [loading, setLoading] = useState(!cachedTypes);

    useEffect(() => {
        // Use cache if fresh
        if (cachedTypes && Date.now() - cacheTimestamp < CACHE_TTL) {
            setTypes(cachedTypes);
            setLoading(false);
            return;
        }

        let cancelled = false;

        // Get orgId from localStorage (standard QuoxCORE pattern)
        const orgId = localStorage.getItem('current_org_id');
        if (!orgId) {
            setLoading(false);
            return;
        }

        fetchTypesFromAPI(orgId)
            .then((apiTypes) => {
                if (cancelled) return;

                // Merge API types into a lookup object, preserving frontend-only fields
                // from static types (like helpText, category) that API may not include
                const merged = { ...INTEGRATION_TYPES };
                for (const apiType of apiTypes) {
                    merged[apiType.id] = {
                        ...merged[apiType.id], // keep frontend extras (helpText, category)
                        ...apiType             // override with fresh API data
                    };
                }

                cachedTypes = merged;
                cacheTimestamp = Date.now();
                setTypes(merged);
                setLoading(false);
            })
            .catch((err) => {
                if (cancelled) return;
                // Fall back to static types — LOUD: this generated copy
                // (src/config/integrationTypes.js) can only ever be as
                // fresh as the last `node scripts/sync-integration-types.mjs`
                // run, so a silent fallback here hides exactly the kind of
                // staleness that let it drift to 369/406+ keys unnoticed.
                console.warn(
                    `[useIntegrationTypes] Failed to fetch integration types from /api/orgs/${orgId}/vault/types` +
                    ` — falling back to the generated static copy (src/config/integrationTypes.js, may be stale):`,
                    err?.message || err
                );
                setTypes(INTEGRATION_TYPES);
                setLoading(false);
            });

        return () => { cancelled = true; };
    }, []);

    const getType = useCallback((typeId) => {
        return types[typeId] || null;
    }, [types]);

    return {
        types,
        getType,
        categories: INTEGRATION_CATEGORIES,
        getByCategory: getIntegrationsByCategory,
        loading
    };
}

export default useIntegrationTypes;
