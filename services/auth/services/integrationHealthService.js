/**
 * Integration Health Service
 *
 * Extracted from integrations.js routes — handles connection testing
 * for integration credentials. Vault stores results; this service executes tests.
 *
 * Imports test configuration from the integration type registry.
 */

import { INTEGRATION_TYPES, getTestConfig } from '../config/integrationTypeRegistry.js';
import { validateUrlForSSRF, safeFetch, DEFAULT_TIMEOUT_MS } from '../utils/urlValidation.js';
import { readInstanceConfigValue } from '../lib/instanceConfigOverrides.js';

/**
 * Whether LAN (RFC1918) targets are permitted for this integration type.
 * Owner-approved 2026-09-06 (VAULT-INTEG): true ONLY when BOTH hold:
 *  - the registry entry declares lanAllowed: true (self-hosted-by-nature
 *    types: uptime_kuma, mikrotik_routeros, proxmox, grafana, wazuh,
 *    home_assistant), AND
 *  - the operator enabled the instance gate `allow_lan_integration_targets`
 *    in instance_config (default absent = OFF, today's behaviour).
 * Loopback and link-local stay blocked unconditionally either way; see the
 * security note on isBlockedHostname in utils/urlValidation.js.
 * @param {string} integrationType
 * @returns {boolean}
 */
export function lanTargetsAllowed(integrationType) {
    const type = INTEGRATION_TYPES[integrationType];
    if (!type || type.lanAllowed !== true) return false;
    const gate = readInstanceConfigValue('allow_lan_integration_targets');
    return gate === 'true' || gate === '1' || gate === true;
}

/**
 * Test a connection for an integration credential.
 *
 * @param {string} integrationType - The integration type ID (e.g., 'openai', 'slack')
 * @param {Object} credentials - The decrypted credential fields
 * @param {string|null} endpointUrl - Optional override endpoint URL
 * @returns {Promise<{success: boolean, error?: string, message?: string, result_kind?: 'live'|'format_check'}>}
 *   result_kind is set on every path that actually resolves a type
 *   ('live' for a real network probe, 'format_check' for a shape-only
 *   validateCredentials() check) so callers never have to infer test depth
 *   from message text. It is omitted for the two error paths above type
 *   resolution (unknown type / no test endpoint at all) since there was
 *   nothing to classify.
 */
export async function testConnection(integrationType, credentials, endpointUrl = null) {
    const type = INTEGRATION_TYPES[integrationType];
    if (!type) {
        return { success: false, error: 'Unknown integration type' };
    }

    try {
        // If type has a validateCredentials function and no testEndpoint, use validation only
        if (type.validateCredentials && !type.testEndpoint) {
            const validation = type.validateCredentials(credentials);
            if (validation.valid) {
                // VAULT-INTEG P8: result_kind distinguishes this from a real
                // network probe so callers (routes, UI) never have to infer
                // "was this actually tested?" from message string content.
                return { success: true, result_kind: 'format_check', message: 'Credentials validated (format check only)' };
            } else {
                return { success: false, result_kind: 'format_check', error: validation.error };
            }
        }

        let url;
        if (typeof type.testEndpoint === 'function') {
            url = type.testEndpoint(credentials);
        } else if (type.testEndpoint) {
            // For relative URLs (like n8n), prepend base_url
            if (type.testEndpoint.startsWith('/')) {
                const baseUrl = credentials.base_url || endpointUrl;
                if (!baseUrl) {
                    return { success: false, result_kind: 'live', error: 'Base URL required for test' };
                }
                url = baseUrl.replace(/\/$/, '') + type.testEndpoint;
            } else {
                url = type.testEndpoint;
            }
        } else if (endpointUrl) {
            url = endpointUrl;
        } else {
            return { success: false, error: 'No test endpoint configured' };
        }

        // Add query params if needed
        if (type.testParams) {
            const params = new URLSearchParams(type.testParams(credentials));
            url += (url.includes('?') ? '&' : '?') + params.toString();
        }

        // SSRF Protection: Validate URL before making request.
        // allowPrivate is computed per type x instance gate (lanTargetsAllowed);
        // for every non-lanAllowed type this is byte-for-byte the old behaviour.
        const ssrfOpts = { allowPrivate: lanTargetsAllowed(integrationType) };
        const urlValidation = await validateUrlForSSRF(url, ssrfOpts);
        if (!urlValidation.valid) {
            return { success: false, error: urlValidation.error };
        }

        const options = {
            method: type.testMethod || 'GET',
            headers: {
                ...type.testHeaders(credentials),
                'Accept': 'application/json'
            }
        };

        if (type.testBody && type.testMethod === 'POST') {
            // testBody can be a function (for dynamic body) or an object
            const body = typeof type.testBody === 'function' ? type.testBody(credentials) : type.testBody;
            // If body is already a string (e.g., URLSearchParams), use as-is
            options.body = typeof body === 'string' ? body : JSON.stringify(body);
            if (!options.headers['Content-Type']) {
                options.headers['Content-Type'] = 'application/json';
            }
        }

        // Use safeFetch with timeout protection instead of plain fetch
        const response = await safeFetch(url, options, DEFAULT_TIMEOUT_MS, 0, ssrfOpts);

        if (response.ok || response.status === 200 || response.status === 201) {
            return { success: true, result_kind: 'live' };
        }

        const text = await response.text();
        let errorMessage = `HTTP ${response.status}`;
        try {
            const json = JSON.parse(text);
            errorMessage = json.error?.message || json.message || json.error || errorMessage;
        } catch {
            if (text.length < 200) {
                errorMessage = text || errorMessage;
            }
        }

        return { success: false, result_kind: 'live', error: errorMessage };
    } catch (err) {
        return { success: false, error: err.message };
    }
}
