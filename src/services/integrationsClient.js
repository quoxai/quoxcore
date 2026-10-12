/**
 * Integrations Client - API client for the Integrations Vault
 *
 * Provides functions to:
 * - List integration credentials (masked)
 * - Create new credentials
 * - Update existing credentials
 * - Delete credentials
 * - Test connections
 * - Set default integrations
 * - Get integration types
 *
 * Security: Keys are never returned from the API - only masked previews.
 */

import { csrfFetch } from '../utils/csrfFetch';
import {
    VAULT_LIST, VAULT_CREATE, VAULT_GET, VAULT_UPDATE, VAULT_DELETE,
    VAULT_TEST, VAULT_DEFAULT, VAULT_TYPES, VAULT_TEST_CREDENTIALS
} from '../config/apiPaths';
import {
    logCredentialCreated, logCredentialUpdated, logCredentialDeleted, logDefaultSet,
} from './integrationsAudit';

/**
 * Resolve the current org ID from localStorage
 */
function getOrgId() {
    const orgId = localStorage.getItem('current_org_id');
    if (!orgId) {
        console.warn('[integrationsClient] No org ID found in localStorage');
    }
    return orgId;
}

/**
 * List all integrations for the current org
 * @param {string} [type] - Optional type filter (e.g., 'openai', 'telegram')
 * @returns {Promise<{credentials: Array, count: number}>}
 */
export async function listIntegrations(type) {
    try {
        const orgId = getOrgId();
        if (!orgId) return { credentials: [], count: 0 };

        const base = VAULT_LIST(orgId);
        const url = type ? `${base}?type=${encodeURIComponent(type)}` : base;
        const res = await fetch(url, {
            credentials: 'include'
        });

        if (!res.ok) {
            if (res.status === 401 || res.status === 404) {
                return { credentials: [], count: 0 };
            }
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `Failed to fetch integrations: ${res.status}`);
        }

        return await res.json();
    } catch (err) {
        console.error('[Integrations] Failed to list:', err);
        return { credentials: [], count: 0, error: err.message };
    }
}

/**
 * Get a single integration by ID (masked credentials)
 * @param {string} id - Integration ID
 * @returns {Promise<Object|null>}
 */
export async function getIntegration(id) {
    try {
        const orgId = getOrgId();
        if (!orgId) return null;

        const res = await fetch(VAULT_GET(orgId, id), {
            credentials: 'include'
        });

        if (!res.ok) {
            if (res.status === 404) return null;
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `Failed to fetch integration: ${res.status}`);
        }

        return await res.json();
    } catch (err) {
        console.error(`[Integrations] Failed to get ${id}:`, err);
        return null;
    }
}

/**
 * Create a new integration credential
 * @param {Object} data - Integration data
 * @param {string} data.integration_type - Type (e.g., 'openai')
 * @param {string} data.label - Unique label for this credential
 * @param {Object} data.credentials - Credential fields (api_key, etc.)
 * @param {string} [data.description] - Optional description
 * @param {string} [data.endpoint_url] - Custom endpoint URL
 * @param {boolean} [data.is_default] - Set as default for this type
 * @returns {Promise<{success: boolean, id?: string, error?: string}>}
 */
export async function createIntegration(data) {
    try {
        const orgId = getOrgId();
        if (!orgId) return { success: false, error: 'No organization selected' };

        const res = await csrfFetch(VAULT_CREATE(orgId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        const result = await res.json();

        if (!res.ok) {
            return { success: false, error: result.message || 'Failed to create integration' };
        }

        logCredentialCreated(result);
        return { success: true, ...result };
    } catch (err) {
        console.error('[Integrations] Failed to create:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Update an existing integration
 * Note: Credentials must be re-entered when updating
 * @param {string} id - Integration ID
 * @param {Object} data - Updated data
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function updateIntegration(id, data) {
    try {
        const orgId = getOrgId();
        if (!orgId) return { success: false, error: 'No organization selected' };

        const res = await csrfFetch(VAULT_UPDATE(orgId, id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        const result = await res.json();

        if (!res.ok) {
            return { success: false, error: result.message || 'Failed to update integration' };
        }

        logCredentialUpdated(id);
        return { success: true, ...result };
    } catch (err) {
        console.error(`[Integrations] Failed to update ${id}:`, err);
        return { success: false, error: err.message };
    }
}

/**
 * Delete an integration
 * @param {string} id - Integration ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function deleteIntegration(id) {
    try {
        const orgId = getOrgId();
        if (!orgId) return { success: false, error: 'No organization selected' };

        const res = await csrfFetch(VAULT_DELETE(orgId, id), {
            method: 'DELETE'
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { success: false, error: err.message || 'Failed to delete integration' };
        }

        logCredentialDeleted(id);
        return { success: true };
    } catch (err) {
        console.error(`[Integrations] Failed to delete ${id}:`, err);
        return { success: false, error: err.message };
    }
}

/**
 * Test an integration connection
 * @param {string} id - Integration ID
 * @returns {Promise<{success: boolean, message?: string, response_time_ms?: number}>}
 */
export async function testIntegration(id) {
    try {
        const orgId = getOrgId();
        if (!orgId) return { success: false, message: 'No organization selected' };

        const res = await csrfFetch(VAULT_TEST(orgId, id), {
            method: 'POST'
        });

        return await res.json();
    } catch (err) {
        console.error(`[Integrations] Failed to test ${id}:`, err);
        return { success: false, message: err.message };
    }
}

/**
 * Test credentials before saving (for new integrations)
 * @param {Object} data - Credential data to test
 * @param {string} data.integration_type - Type (e.g., 'openai')
 * @param {Object} data.credentials - Credentials to test
 * @param {string} [data.endpoint_url] - Custom endpoint
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export async function testCredentials(data) {
    try {
        const orgId = getOrgId();
        if (!orgId) return { success: false, message: 'No organization selected' };

        const res = await csrfFetch(VAULT_TEST_CREDENTIALS(orgId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        return await res.json();
    } catch (err) {
        console.error('[Integrations] Failed to test credentials:', err);
        return { success: false, message: err.message };
    }
}

/**
 * Set an integration as the default for its type
 * @param {string} id - Integration ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function setDefaultIntegration(id) {
    try {
        const orgId = getOrgId();
        if (!orgId) return { success: false, error: 'No organization selected' };

        const res = await csrfFetch(VAULT_DEFAULT(orgId, id), {
            method: 'POST'
        });

        const result = await res.json();

        if (!res.ok) {
            return { success: false, error: result.message || 'Failed to set default' };
        }

        logDefaultSet(id);
        return { success: true, ...result };
    } catch (err) {
        console.error(`[Integrations] Failed to set default ${id}:`, err);
        return { success: false, error: err.message };
    }
}

/**
 * Get available integration types
 * @returns {Promise<Object>} - Map of type id to type config
 */
export async function getIntegrationTypes() {
    try {
        const orgId = getOrgId();
        if (!orgId) return {};

        const res = await fetch(VAULT_TYPES(orgId), {
            credentials: 'include'
        });

        if (!res.ok) {
            return {};
        }

        return await res.json();
    } catch (err) {
        console.error('[Integrations] Failed to get types:', err);
        return {};
    }
}

/**
 * Get the default integration for a type
 * @param {string} type - Integration type
 * @returns {Promise<Object|null>}
 */
export async function getDefaultIntegration(type) {
    try {
        const { credentials } = await listIntegrations(type);
        return credentials.find(c => c.is_default) || credentials[0] || null;
    } catch (err) {
        console.error(`[Integrations] Failed to get default for ${type}:`, err);
        return null;
    }
}

/**
 * List orgs (the authenticated user belongs to) that have a credential
 * of the given type. Used by connector onboarding to surface cross-org
 * availability — "you have credentials in QUOX DEVELOPMENT, switch?".
 *
 * @param {string} type - Integration type, e.g. 'tailscale'
 * @returns {Promise<{integration_type: string, available_in: Array}>}
 */
export async function listCrossOrgCredentials(type) {
    const { CROSS_ORG_CREDENTIALS } = await import('../config/apiPaths');
    const res = await csrfFetch(CROSS_ORG_CREDENTIALS(type), { credentials: 'include' });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Cross-org lookup failed: ${res.status}`);
    }
    return res.json();
}

/**
 * Copy a credential from a sibling org into the active org. The active
 * org becomes the new owner; the source row is left in place.
 *
 * @param {string} targetOrgId - Org to copy into
 * @param {string} sourceCredentialId - Source credential id
 * @param {Object} [opts]
 * @param {string} [opts.label]      Override label (default: source label + ' (copy)')
 * @param {boolean}[opts.makeDefault] Force default flag in target org
 * @returns {Promise<Object>} Created credential row (masked, no secrets)
 */
export async function copyIntegrationFromOrg(targetOrgId, sourceCredentialId, opts = {}) {
    const { VAULT_COPY_FROM } = await import('../config/apiPaths');
    const res = await csrfFetch(VAULT_COPY_FROM(targetOrgId, sourceCredentialId), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            label: opts.label,
            makeDefault: opts.makeDefault,
        }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Copy failed: ${res.status}`);
    }
    return res.json();
}

// Export as object for convenience
export const integrationsClient = {
    list: listIntegrations,
    get: getIntegration,
    create: createIntegration,
    update: updateIntegration,
    delete: deleteIntegration,
    test: testIntegration,
    testCredentials,
    setDefault: setDefaultIntegration,
    getTypes: getIntegrationTypes,
    getDefault: getDefaultIntegration,
    listCrossOrg: listCrossOrgCredentials,
    copyFromOrg: copyIntegrationFromOrg,
};

export default integrationsClient;
