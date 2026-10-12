/**
 * workflowDraftService - Draft persistence for Workflow Builder
 *
 * Saves workflow drafts to localStorage for resume capability.
 * Auto-manages draft limits and cleanup.
 */

import { queueSync } from './serverSyncQueue';

const DRAFTS_KEY = 'quox-workflow-drafts';
const MAX_DRAFTS = 20;

/**
 * Generate a unique draft ID
 */
function generateDraftId() {
    return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Get all drafts from localStorage
 * @returns {Array} Array of draft objects, sorted by savedAt DESC
 */
export function listDrafts() {
    try {
        const stored = localStorage.getItem(DRAFTS_KEY);
        if (!stored) return [];

        const drafts = JSON.parse(stored);
        // Sort by savedAt descending (newest first)
        return drafts.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    } catch (err) {
        console.error('[DraftService] Failed to load drafts:', err);
        return [];
    }
}

/**
 * Load a single draft by ID
 * @param {string} id - Draft ID
 * @returns {Object|null} Draft object or null if not found
 */
export function loadDraft(id) {
    const drafts = listDrafts();
    return drafts.find(d => d.id === id) || null;
}

/**
 * Save a draft to localStorage
 * Auto-generates ID if not provided, enforces MAX_DRAFTS limit
 *
 * @param {Object} draft - Draft to save
 * @param {string} draft.id - Optional existing draft ID
 * @param {string} draft.phase - Current workflow phase
 * @param {Array} draft.conversation - Message history
 * @param {Object} draft.config - Workflow configuration
 * @param {Object} draft.generatedWorkflow - Generated workflow JSON (if any)
 * @returns {Object} Saved draft with ID and timestamp
 */
export function saveDraft(draft) {
    try {
        const drafts = listDrafts();

        // Create or update draft
        const draftId = draft.id || generateDraftId();
        const existingIndex = drafts.findIndex(d => d.id === draftId);

        const savedDraft = {
            id: draftId,
            savedAt: new Date().toISOString(),
            title: draft.title || getDraftTitle(draft.config, draft.conversation),
            phase: draft.phase,
            conversation: draft.conversation || [],
            config: draft.config || {},
            generatedWorkflow: draft.generatedWorkflow || null,
            intent: draft.intent || null
        };

        if (existingIndex >= 0) {
            // Update existing draft
            drafts[existingIndex] = savedDraft;
        } else {
            // Add new draft at the beginning
            drafts.unshift(savedDraft);
        }

        // Enforce max drafts limit (remove oldest)
        while (drafts.length > MAX_DRAFTS) {
            drafts.pop();
        }

        // Check storage quota before saving. F11: a write that never actually
        // lands in localStorage must NOT be reported as a successful save —
        // `persisted` tracks whether SOME write of `drafts` (possibly after
        // trimming to fit) actually succeeded; saveDraft only returns once
        // that's true, otherwise it throws so callers (WorkflowChat.jsx
        // already wraps both call sites in try/catch) surface the failure
        // instead of showing "Draft saved" over nothing.
        let persisted = false;
        const jsonStr = JSON.stringify(drafts);
        try {
            localStorage.setItem(DRAFTS_KEY, jsonStr);
            persisted = true;
        } catch (quotaErr) {
            // Storage full - try removing oldest drafts until it fits.
            // Must keep trying even down to the last (possibly oversized)
            // draft — stopping at length > 1 left a single oversized draft
            // never attempted at all.
            console.warn('[DraftService] Storage full, removing old drafts...');
            while (!persisted && drafts.length > 0) {
                if (drafts.length > 1) drafts.pop();
                try {
                    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
                    persisted = true;
                } catch {
                    if (drafts.length <= 1) break; // nothing left to trim
                }
            }
        }

        if (!persisted) {
            throw new Error('Could not save draft: browser storage is full. Free up space (clear old drafts/files) and try again.');
        }

        queueSync('workflowDrafts', drafts);

        console.log('[DraftService] Saved draft:', draftId);
        return savedDraft;

    } catch (err) {
        console.error('[DraftService] Failed to save draft:', err);
        throw err;
    }
}

/**
 * Delete a draft by ID
 * @param {string} id - Draft ID to delete
 * @returns {boolean} True if deleted, false if not found
 */
export function deleteDraft(id) {
    try {
        const drafts = listDrafts();
        const filtered = drafts.filter(d => d.id !== id);

        if (filtered.length === drafts.length) {
            return false; // Not found
        }

        localStorage.setItem(DRAFTS_KEY, JSON.stringify(filtered));
        queueSync('workflowDrafts', filtered);
        console.log('[DraftService] Deleted draft:', id);
        return true;

    } catch (err) {
        console.error('[DraftService] Failed to delete draft:', err);
        return false;
    }
}

/**
 * Clear all drafts
 */
export function clearAllDrafts() {
    try {
        localStorage.removeItem(DRAFTS_KEY);
        console.log('[DraftService] Cleared all drafts');
    } catch (err) {
        console.error('[DraftService] Failed to clear drafts:', err);
    }
}

/**
 * Auto-generate a draft title from config or conversation
 * @param {Object} config - Workflow config
 * @param {Array} conversation - Conversation history
 * @returns {string} Generated title
 */
export function getDraftTitle(config, conversation) {
    // Try workflow name first
    if (config?.name) {
        return config.name;
    }

    // Try trigger description
    if (config?.trigger?.description) {
        return config.trigger.description.slice(0, 50);
    }

    // Try first user message
    if (conversation?.length > 0) {
        const firstUserMsg = conversation.find(m => m.role === 'user');
        if (firstUserMsg?.text) {
            const text = firstUserMsg.text.slice(0, 50);
            return text.length < firstUserMsg.text.length ? `${text}...` : text;
        }
    }

    // Fallback
    return 'Untitled Workflow';
}

/**
 * Get phase display name
 * @param {string} phase - Phase constant
 * @returns {string} Human-readable phase name
 */
export function getPhaseDisplayName(phase) {
    const phases = {
        'GREETING': 'Getting Started',
        'INTENT_DISCOVERY': 'Discovering Intent',
        'TRIGGER_CONFIG': 'Configuring Trigger',
        'DATA_SOURCE': 'Setting Data Sources',
        'TRANSFORM_PROCESS': 'Adding Transforms',
        'DESTINATION': 'Setting Destinations',
        'HITL_CONFIG': 'HITL Configuration',
        'REVIEW': 'Review & Generate',
        'COMPLETE': 'Complete'
    };
    return phases[phase] || phase;
}

/**
 * Get relative time string
 * @param {string} isoString - ISO date string
 * @returns {string} Relative time (e.g., "2 hours ago")
 */
export function getRelativeTime(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;

    return date.toLocaleDateString();
}

export default {
    listDrafts,
    loadDraft,
    saveDraft,
    deleteDraft,
    clearAllDrafts,
    getDraftTitle,
    getPhaseDisplayName,
    getRelativeTime
};
