/**
 * Workflow Loader Service
 *
 * Loads workflow JSON files on demand from the workflow library.
 */

// Base path for workflow JSON files
const WORKFLOW_JSON_BASE = '/workflow-json';

// Cache for loaded workflows
const workflowCache = new Map();

/**
 * Load workflow JSON by file path
 * @param {string} filePath - Relative path to workflow JSON (from workflowFile field)
 * @returns {Promise<object|null>} - Parsed workflow JSON or null on error
 */
export async function loadWorkflowJson(filePath) {
    if (!filePath) {
        console.warn('No workflow file path provided');
        return null;
    }

    // Check cache
    if (workflowCache.has(filePath)) {
        return workflowCache.get(filePath);
    }

    try {
        // Construct full URL
        const url = `${WORKFLOW_JSON_BASE}/${encodeURIComponent(filePath).replace(/%2F/g, '/')}`;

        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Failed to load workflow: ${response.status} ${response.statusText}`);
            return null;
        }

        const json = await response.json();

        // Cache the result
        workflowCache.set(filePath, json);

        return json;
    } catch (err) {
        console.error('Error loading workflow JSON:', err);
        return null;
    }
}

/**
 * Clear workflow cache
 */
export function clearWorkflowCache() {
    workflowCache.clear();
}

/**
 * Get cache statistics
 */
export function getCacheStats() {
    return {
        size: workflowCache.size,
        keys: [...workflowCache.keys()]
    };
}

export default {
    loadWorkflowJson,
    clearWorkflowCache,
    getCacheStats
};
