/**
 * toolCategoriesClient — STUDY-REV-2/P1.A-categories
 *
 * Client for the auth-service tool_categories API.
 * Endpoint: /api/catalog/categories (GET + POST)
 *
 * listCategories — returns global + org-scoped categories
 * createCategory — creates an org-scoped category on the fly
 */

const CATEGORIES_URL = '/api/catalog/categories';

/**
 * Fetch all categories visible to the org (global + org-scoped).
 *
 * @param {{ authFetch: Function, orgId?: string }} opts
 * @returns {Promise<Array<{ id, name, icon, description, sort_order, org_id, tool_count }>>}
 */
export async function listCategories({ authFetch, orgId }) {
    const url = orgId
        ? `${CATEGORIES_URL}?org_id=${encodeURIComponent(orgId)}`
        : CATEGORIES_URL;
    const resp = await authFetch(url);
    if (!resp.ok) throw new Error('Failed to load categories');
    const data = await resp.json();
    return data.categories || [];
}

/**
 * Create an org-scoped category.
 *
 * @param {{ authFetch: Function, name: string, icon?: string, description?: string }} opts
 * @returns {Promise<{ id, name, icon, description, sort_order, org_id }>}
 */
export async function createCategory({ authFetch, name, icon, description }) {
    const resp = await authFetch(CATEGORIES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, icon, description }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || data.error || 'Create failed');
    return data.category;
}
