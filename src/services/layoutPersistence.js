/**
 * Layout Persistence Service
 *
 * Persists UI layout preferences to localStorage AND syncs to server.
 * localStorage is the fast read cache; server is source of truth.
 *
 * Supports:
 * - Section collapse states
 * - Panel sizes
 * - View-specific preferences
 * - Custom widget arrangements
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { queueSync } from './serverSyncQueue';

const STORAGE_PREFIX = 'quox-layout';
const SERVER_NAMESPACE = 'layoutState';

/**
 * Get a persisted layout value
 * @param {string} key - The layout key (e.g., 'dashboard.sections.fleet')
 * @param {any} defaultValue - Default value if not found
 * @returns {any} The persisted value or default
 */
export function getLayoutValue(key, defaultValue = null) {
    try {
        const fullKey = `${STORAGE_PREFIX}.${key}`;
        const stored = localStorage.getItem(fullKey);
        if (stored === null) return defaultValue;
        return JSON.parse(stored);
    } catch (error) {
        console.warn(`Failed to get layout value for ${key}:`, error);
        return defaultValue;
    }
}

/**
 * Set a persisted layout value
 * @param {string} key - The layout key
 * @param {any} value - Value to persist
 */
export function setLayoutValue(key, value) {
    try {
        const fullKey = `${STORAGE_PREFIX}.${key}`;
        localStorage.setItem(fullKey, JSON.stringify(value));
        // Queue server sync (debounced — all layout changes batched together)
        syncLayoutToServer();
    } catch (error) {
        console.warn(`Failed to set layout value for ${key}:`, error);
    }
}

/** Collect all layout values and queue for server sync */
let layoutSyncTimer = null;
function syncLayoutToServer() {
    clearTimeout(layoutSyncTimer);
    layoutSyncTimer = setTimeout(() => {
        const layoutState = getLayoutGroup('');
        // Also grab prefixed groups
        const allLayout = {};
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(STORAGE_PREFIX)) {
                    const shortKey = key.slice(STORAGE_PREFIX.length + 1);
                    allLayout[shortKey] = JSON.parse(localStorage.getItem(key));
                }
            }
        } catch { /* */ }
        queueSync(SERVER_NAMESPACE, allLayout);
    }, 500);
}

/**
 * Get all layout values for a view/component
 * @param {string} prefix - The key prefix (e.g., 'dashboard')
 * @returns {object} Object with all matching keys
 */
export function getLayoutGroup(prefix) {
    const result = {};
    const fullPrefix = `${STORAGE_PREFIX}.${prefix}`;

    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(fullPrefix)) {
                const shortKey = key.slice(fullPrefix.length + 1);
                result[shortKey] = JSON.parse(localStorage.getItem(key));
            }
        }
    } catch (error) {
        console.warn(`Failed to get layout group for ${prefix}:`, error);
    }

    return result;
}

/**
 * Clear all layout values for a view/component
 * @param {string} prefix - The key prefix
 */
export function clearLayoutGroup(prefix) {
    const fullPrefix = `${STORAGE_PREFIX}.${prefix}`;

    try {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(fullPrefix)) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));
    } catch (error) {
        console.warn(`Failed to clear layout group for ${prefix}:`, error);
    }
}

/**
 * Hook for persisted section collapse state
 * @param {string} viewId - The view identifier
 * @param {string} sectionId - The section identifier
 * @param {boolean} defaultCollapsed - Default collapse state
 * @returns {[boolean, function]} [isCollapsed, setIsCollapsed]
 */
export function useSectionCollapse(viewId, sectionId, defaultCollapsed = false) {
    const key = useMemo(() => `${viewId}.sections.${sectionId}`, [viewId, sectionId]);
    const [isCollapsed, setIsCollapsed] = useState(() =>
        getLayoutValue(key, defaultCollapsed)
    );

    // Track if this is the initial mount to avoid writing on first render
    const isInitialMount = useRef(true);

    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }
        setLayoutValue(key, isCollapsed);
    }, [key, isCollapsed]);

    const toggle = useCallback(() => {
        setIsCollapsed(prev => !prev);
    }, []);

    return [isCollapsed, toggle, setIsCollapsed];
}

/**
 * Hook for persisted panel width
 * @param {string} viewId - The view identifier
 * @param {string} panelId - The panel identifier
 * @param {number} defaultWidth - Default width in pixels
 * @returns {[number, function]} [width, setWidth]
 */
export function usePanelWidth(viewId, panelId, defaultWidth = 300) {
    const key = useMemo(() => `${viewId}.panels.${panelId}.width`, [viewId, panelId]);
    const [width, setWidth] = useState(() =>
        getLayoutValue(key, defaultWidth)
    );

    const isInitialMount = useRef(true);

    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }
        setLayoutValue(key, width);
    }, [key, width]);

    return [width, setWidth];
}

/**
 * Hook for persisted view mode/tab
 * @param {string} viewId - The view identifier
 * @param {string} defaultMode - Default mode/tab
 * @returns {[string, function]} [mode, setMode]
 */
export function useViewMode(viewId, defaultMode = 'default') {
    const key = useMemo(() => `${viewId}.mode`, [viewId]);
    const [mode, setMode] = useState(() =>
        getLayoutValue(key, defaultMode)
    );

    const isInitialMount = useRef(true);

    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }
        setLayoutValue(key, mode);
    }, [key, mode]);

    return [mode, setMode];
}

/**
 * Hook for persisted widget order/arrangement
 * @param {string} viewId - The view identifier
 * @param {string[]} defaultOrder - Default widget order
 * @returns {[string[], function]} [order, setOrder]
 */
export function useWidgetOrder(viewId, defaultOrder = []) {
    const key = useMemo(() => `${viewId}.widgetOrder`, [viewId]);
    const [order, setOrder] = useState(() =>
        getLayoutValue(key, defaultOrder)
    );

    const isInitialMount = useRef(true);

    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }
        setLayoutValue(key, order);
    }, [key, order]);

    return [order, setOrder];
}

/**
 * Hook for persisted generic object state
 * @param {string} key - Storage key
 * @param {object} defaultValue - Default value
 * @returns {[object, function]} [value, setValue]
 */
export function usePersistedState(key, defaultValue = {}) {
    const [value, setValue] = useState(() =>
        getLayoutValue(key, defaultValue)
    );

    const isInitialMount = useRef(true);

    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }
        setLayoutValue(key, value);
    }, [key, value]);

    return [value, setValue];
}

/**
 * Hydrate layout state from server data.
 * Called on login when server preferences are available.
 * @param {Object} serverLayoutState - Layout state from server preferences
 */
export function hydrateLayoutFromServer(serverLayoutState) {
    if (!serverLayoutState || typeof serverLayoutState !== 'object') return;
    try {
        for (const [key, value] of Object.entries(serverLayoutState)) {
            const fullKey = `${STORAGE_PREFIX}.${key}`;
            localStorage.setItem(fullKey, JSON.stringify(value));
        }
    } catch (error) {
        console.warn('Failed to hydrate layout from server:', error);
    }
}

// Export all utilities
export default {
    getLayoutValue,
    setLayoutValue,
    getLayoutGroup,
    clearLayoutGroup,
    useSectionCollapse,
    usePanelWidth,
    useViewMode,
    useWidgetOrder,
    usePersistedState,
    hydrateLayoutFromServer,
};
