/**
 * userLibraryClient — STUDY-REV-2 / P5.D
 *
 * Client for the auth-service user workflow library API (port 3101).
 *
 * Endpoints:
 *   GET    /api/orgs/:orgId/user-library[?source=X]  → list user's saved entries
 *   POST   /api/orgs/:orgId/user-library             → save entry
 *   DELETE /api/orgs/:orgId/user-library/:id         → remove entry
 *
 * Each function takes { authFetch, ...args } so it can be called from
 * React components (where authFetch comes from useAuth()) and from tests
 * (where authFetch is a vi.fn() mock). Matches the pattern in toolInstallScopeClient.js.
 */

const BASE = '/api/orgs';

/**
 * List the calling user's saved workflow library entries.
 *
 * @param {{ authFetch: Function, orgId: string, source?: string }} opts
 *   source: 'curated' | 'n8n-imported' | 'mine' — optional filter
 * @returns {Promise<Array>} entries array from response body
 */
export async function listUserLibrary({ authFetch, orgId, source }) {
    let url = `${BASE}/${encodeURIComponent(orgId)}/user-library`;
    if (source) {
        url += `?source=${encodeURIComponent(source)}`;
    }

    const resp = await authFetch(url);
    if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || body.message || `listUserLibrary failed: HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return data.entries || [];
}

/**
 * Save a workflow to the user's library.
 *
 * @param {{
 *   authFetch: Function,
 *   orgId: string,
 *   name: string,
 *   description?: string,
 *   definitionJson: Object|string,
 *   source?: string,
 *   sourceWorkflowId?: string,
 *   tags?: string[]
 * }} opts
 * @returns {Promise<Object>} saved entry from response body
 */
export async function saveToUserLibrary({
    authFetch,
    orgId,
    name,
    description,
    definitionJson,
    source,
    sourceWorkflowId,
    tags,
}) {
    const bodyObj = {
        name,
        definition_json: definitionJson,
    };
    if (description !== undefined) bodyObj.description = description;
    if (source !== undefined) bodyObj.source = source;
    if (sourceWorkflowId !== undefined) bodyObj.source_workflow_id = sourceWorkflowId;
    if (tags !== undefined) bodyObj.tags = tags;

    const resp = await authFetch(`${BASE}/${encodeURIComponent(orgId)}/user-library`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
    });

    if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(errBody.error || errBody.message || `saveToUserLibrary failed: HTTP ${resp.status}`);
    }

    const data = await resp.json();
    return data.entry;
}

/**
 * Delete a saved workflow library entry (ownership enforced server-side).
 *
 * @param {{ authFetch: Function, orgId: string, id: string }} opts
 * @returns {Promise<{ ok: boolean }>}
 */
export async function deleteFromUserLibrary({ authFetch, orgId, id }) {
    const resp = await authFetch(
        `${BASE}/${encodeURIComponent(orgId)}/user-library/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
    );

    if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(errBody.error || errBody.message || `deleteFromUserLibrary failed: HTTP ${resp.status}`);
    }

    return resp.json();
}
