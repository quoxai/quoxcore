/**
 * Vault Credential Kind Display Registry — VAULT-AUDIT P7
 *
 * Frontend-only display labels/ordering for the `credential_kind` taxonomy
 * defined server-side in services/auth/config/credentialKinds.js (VAULT-P2).
 * This is a thin display mirror, NOT a re-implementation of shape/policy
 * validation (that stays server-side).
 *
 * Credentials fetched via GET /orgs/:orgId/integrations already carry
 * `credential_kind` on each row (DB column, defaulted to 'service_api').
 */

export const CREDENTIAL_KIND_LABELS = {
    service_api: 'Service / API Keys',
    email_account: 'Email Accounts',
    carddav_account: 'Address Books (CardDAV)',
    web_login: 'Website Logins',
    ssh_key: 'SSH Keys',
    tls_cert: 'TLS Certificates',
    database: 'Database Connections',
    cloud: 'Cloud Providers',
    generic: 'Generic Secrets',
};

// Display order for kind sections — most operationally sensitive kinds first.
export const CREDENTIAL_KIND_ORDER = [
    'ssh_key',
    'tls_cert',
    'web_login',
    'database',
    'cloud',
    'email_account',
    'carddav_account',
    'service_api',
    'generic',
];

export const DEFAULT_CREDENTIAL_KIND = 'service_api';

/**
 * Resolve a display label for a credential_kind value.
 * Falls back to a titleized version of unknown kinds so new server-side
 * kinds don't render as blank sections.
 */
export function getCredentialKindLabel(kind) {
    if (!kind) return CREDENTIAL_KIND_LABELS[DEFAULT_CREDENTIAL_KIND];
    if (CREDENTIAL_KIND_LABELS[kind]) return CREDENTIAL_KIND_LABELS[kind];
    return kind
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

export default CREDENTIAL_KIND_LABELS;
