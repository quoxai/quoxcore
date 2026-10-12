/**
 * toolInstallScopeClient — STUDY-REV-2 / P4.0.B
 *
 * Client for the auth-service install-to-scope API (port 3101).
 *
 * Endpoints:
 *   GET  /api/tools/installed?scope_id=:orgId  → org's install-to-scope rows
 *   POST /api/tools/install-to-scope           → idempotent upsert
 *   DELETE /api/tools/install-to-scope/:tool_id → soft-disable
 *
 * Each function takes { authFetch, ...args } so it can be called from
 * React components (where authFetch comes from useAuth()) and from tests
 * (where authFetch is a vi.fn() mock). This matches the pattern used by
 * toolCategoriesClient.js.
 */

const BASE = '/api/tools';

/**
 * List tools installed for a given org scope.
 *
 * @param {{ authFetch: Function, orgId: string }} opts
 * @returns {Promise<Array>}  installations array from response body
 */
export async function listInstalledTools({ authFetch, orgId }) {
    const url = `${BASE}/installed?scope_id=${encodeURIComponent(orgId)}`;
    const resp = await authFetch(url);
    if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || body.message || `listInstalledTools failed: HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return data.installations || [];
}

/**
 * Install a tool to the current org scope (idempotent upsert).
 *
 * @param {{ authFetch: Function, toolId: string, config?: Object, pinnedVersion?: string|null }} opts
 * @returns {Promise<Object>}  installation record from response body
 */
export async function installToolToScope({ authFetch, toolId, config = {}, pinnedVersion = null }) {
    const body = { tool_id: toolId };
    if (config && Object.keys(config).length > 0) body.config = config;
    if (pinnedVersion) body.pinned_version = pinnedVersion;

    const resp = await authFetch(`${BASE}/install-to-scope`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(errBody.error || errBody.message || `installToolToScope failed: HTTP ${resp.status}`);
    }

    const data = await resp.json();
    return data.installation;
}

/**
 * Soft-disable (uninstall) a tool from the current org scope.
 *
 * @param {{ authFetch: Function, toolId: string }} opts
 * @returns {Promise<{ ok: boolean, removed: boolean }>}
 */
export async function uninstallToolFromScope({ authFetch, toolId }) {
    const resp = await authFetch(`${BASE}/install-to-scope/${encodeURIComponent(toolId)}`, {
        method: 'DELETE',
    });

    if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(errBody.error || errBody.message || `uninstallToolFromScope failed: HTTP ${resp.status}`);
    }

    return resp.json();
}
