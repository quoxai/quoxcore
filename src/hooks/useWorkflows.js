/**
 * useWorkflows - React Hook for Workflow Draft & Deployed Management
 *
 * Combines localStorage drafts with deployed workflows (via QuoxFlow).
 * Provides unified interface for workflow lifecycle management.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
    listDrafts,
    loadDraft,
    saveDraft as saveDraftToStorage,
    deleteDraft as deleteDraftFromStorage,
    getPhaseDisplayName,
    getRelativeTime
} from '../services/workflowDraftService';
import { listWorkflows } from '../services/workflowEngine';

/**
 * useWorkflows hook
 *
 * @returns {Object} Workflow management interface
 */
export function useWorkflows() {
    // State
    const [drafts, setDrafts] = useState([]);
    const [deployed, setDeployed] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    // Track if mounted
    const mountedRef = useRef(true);

    /**
     * Load drafts from localStorage
     */
    const refreshDrafts = useCallback(() => {
        try {
            const loadedDrafts = listDrafts();
            if (mountedRef.current) {
                setDrafts(loadedDrafts);
            }
        } catch (err) {
            console.error('[useWorkflows] Failed to load drafts:', err);
        }
    }, []);

    /**
     * Load deployed workflows
     */
    const refreshDeployed = useCallback(async () => {
        try {
            const workflows = await listWorkflows();
            if (mountedRef.current) {
                // Filter to show Quox-generated workflows or all
                const quoxWorkflows = workflows.filter(w =>
                    w.meta?.generatedBy === 'Quox Workflow Lab' ||
                    w.name?.startsWith('Monitor') ||
                    w.name?.startsWith('Automate') ||
                    w.name?.startsWith('Sync') ||
                    true // Show all for now
                );
                setDeployed(quoxWorkflows);
            }
        } catch (err) {
            console.warn('[useWorkflows] Failed to load deployed workflows:', err);
            // Don't set error state - workflow service might be unavailable
            if (mountedRef.current) {
                setDeployed([]);
            }
        }
    }, []);

    /**
     * Refresh all data
     */
    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);

        try {
            refreshDrafts();
            await refreshDeployed();
        } catch (err) {
            if (mountedRef.current) {
                setError(err);
            }
        } finally {
            if (mountedRef.current) {
                setLoading(false);
            }
        }
    }, [refreshDrafts, refreshDeployed]);

    /**
     * Save a draft
     * @param {Object} draftData - Draft data to save
     * @returns {Object} Saved draft with ID
     */
    const saveDraft = useCallback((draftData) => {
        try {
            const saved = saveDraftToStorage(draftData);
            refreshDrafts();
            return saved;
        } catch (err) {
            console.error('[useWorkflows] Failed to save draft:', err);
            throw err;
        }
    }, [refreshDrafts]);

    /**
     * Delete a draft
     * @param {string} draftId - Draft ID to delete
     * @returns {boolean} True if deleted
     */
    const deleteDraft = useCallback((draftId) => {
        try {
            const deleted = deleteDraftFromStorage(draftId);
            if (deleted) {
                refreshDrafts();
            }
            return deleted;
        } catch (err) {
            console.error('[useWorkflows] Failed to delete draft:', err);
            return false;
        }
    }, [refreshDrafts]);

    /**
     * Resume a draft - returns the state for WorkflowChat
     * @param {string} draftId - Draft ID to resume
     * @returns {Object|null} Resume state or null if not found
     */
    const resumeDraft = useCallback((draftId) => {
        try {
            const draft = loadDraft(draftId);
            if (!draft) {
                console.warn('[useWorkflows] Draft not found:', draftId);
                return null;
            }

            // Return state suitable for WorkflowAssistant.deserialize()
            return {
                id: draft.id,
                conversation: draft.conversation,
                phase: draft.phase,
                intent: draft.intent,
                config: draft.config,
                generatedWorkflow: draft.generatedWorkflow
            };
        } catch (err) {
            console.error('[useWorkflows] Failed to resume draft:', err);
            return null;
        }
    }, []);

    /**
     * Get draft by ID
     * @param {string} draftId - Draft ID
     * @returns {Object|null} Draft or null
     */
    const getDraft = useCallback((draftId) => {
        return loadDraft(draftId);
    }, []);

    // Load on mount
    useEffect(() => {
        mountedRef.current = true;
        refresh();

        return () => {
            mountedRef.current = false;
        };
    }, [refresh]);

    return {
        // Data
        drafts,
        deployed,
        loading,
        error,

        // Draft actions
        saveDraft,
        deleteDraft,
        resumeDraft,
        getDraft,

        // Refresh actions
        refresh,
        refreshDrafts,
        refreshDeployed,

        // Utilities
        getPhaseDisplayName,
        getRelativeTime
    };
}

export default useWorkflows;
