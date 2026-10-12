/**
 * Credential Kind Registry — VAULT-AUDIT P2
 *
 * Single source of truth for the typed credential taxonomy. Each kind
 * declares:
 *   - id, label — identity + display
 *   - shape — 'permissive' | 'required' | 'oneOf'
 *       permissive: any credentials object is valid (per-integration-type
 *         required/prefix checks in routes/integrations.js validateCredentials
 *         already run separately).
 *       required: every key in `required` must be present + non-empty.
 *       oneOf: at least one group in `oneOf` (an array of key arrays) must be
 *         fully present + non-empty.
 *   - releasePolicies — allow-list of release_policy values valid for this kind
 *   - defaultReleasePolicy — release_policy stored when none is supplied
 *
 * validateKindShape() operates on the DECRYPTED credentials object (the plain
 * field map before encryption) — never the ciphertext.
 *
 * NOTE: this registry is app-enforced only. There is intentionally no DB CHECK
 * constraint on credential_kind/release_policy (see migrations/074), so new
 * kinds can ship without a migration.
 *
 * P2 scope: storage + shape validation only. release_policy BEHAVIOR
 * (enforcing how a credential may actually be released to an agent/tool) is
 * NOT enforced anywhere yet — that's P5.
 */

export const RELEASE_POLICIES = ['api', 'injection_only', 'vault_compute'];

export const CREDENTIAL_KINDS = {
    service_api: {
        id: 'service_api',
        label: 'Service / API key',
        shape: 'permissive',
        releasePolicies: ['api', 'injection_only'],
        defaultReleasePolicy: 'api',
    },
    email_account: {
        id: 'email_account',
        label: 'Email account',
        shape: 'oneOf',
        oneOf: [
            ['imap_host', 'imap_port', 'username', 'password'],
            ['oauth_provider', 'oauth_refresh_token'],
            // EMAIL-UNIFY P2: send-only SMTP. A mail-sending account has no
            // inbox to read and may have no auth at all (internal relay), so it
            // satisfies neither group above. host + from are exactly what the
            // send path needs to build a transport (utils/emailService.js).
            ['smtp_host', 'from'],
        ],
        // Remaining SMTP-send fields (VAULT P3.D — per-credential SMTP).
        // Declarative only (validateKindShape checks required/oneOf, not
        // optional). `username`/`password` are absent on unauthenticated
        // relays; `from` overrides the envelope sender.
        optional: ['smtp_port', 'smtp_secure', 'username', 'password'],
        releasePolicies: ['api', 'injection_only'],
        defaultReleasePolicy: 'api',
    },
    carddav_account: {
        id: 'carddav_account',
        label: 'Address book (CardDAV)',
        shape: 'required',
        required: ['username', 'password'],
        optional: ['server_url'],
        releasePolicies: ['api', 'injection_only'],
        defaultReleasePolicy: 'api',
    },
    web_login: {
        id: 'web_login',
        label: 'Website / web-app login',
        shape: 'required',
        required: ['username', 'password'],
        optional: ['domain', 'totp_secret'],
        releasePolicies: ['api', 'vault_compute'],
        defaultReleasePolicy: 'api',
    },
    ssh_key: {
        id: 'ssh_key',
        label: 'SSH key pair',
        shape: 'required',
        required: ['private_key'],
        optional: ['passphrase', 'public_key', 'host', 'username'],
        releasePolicies: ['injection_only', 'vault_compute', 'api'],
        defaultReleasePolicy: 'injection_only',
    },
    tls_cert: {
        id: 'tls_cert',
        label: 'TLS certificate',
        shape: 'required',
        required: ['certificate'],
        optional: ['private_key', 'chain'],
        releasePolicies: ['injection_only', 'api'],
        defaultReleasePolicy: 'injection_only',
    },
    database: {
        id: 'database',
        label: 'Database connection',
        shape: 'oneOf',
        oneOf: [
            ['host', 'port', 'database', 'username', 'password'],
            ['connection_string'],
        ],
        releasePolicies: ['api', 'injection_only'],
        defaultReleasePolicy: 'api',
    },
    cloud: {
        id: 'cloud',
        label: 'Cloud provider',
        shape: 'oneOf',
        oneOf: [
            ['access_key_id', 'secret_access_key'],
            ['credentials_json'],
        ],
        releasePolicies: ['api', 'injection_only'],
        defaultReleasePolicy: 'api',
    },
    generic: {
        id: 'generic',
        label: 'Generic secret',
        shape: 'permissive',
        releasePolicies: ['api', 'injection_only'],
        defaultReleasePolicy: 'api',
    },
};

/**
 * @param {string} id
 * @returns {object|null}
 */
export function getKind(id) {
    return CREDENTIAL_KINDS[id] || null;
}

/**
 * @returns {object[]}
 */
export function listKinds() {
    return Object.values(CREDENTIAL_KINDS);
}

/**
 * @param {string} id
 * @returns {boolean}
 */
export function isValidKind(id) {
    return Object.prototype.hasOwnProperty.call(CREDENTIAL_KINDS, id);
}

/**
 * @param {string} policy
 * @returns {boolean}
 */
export function isValidReleasePolicy(policy) {
    return RELEASE_POLICIES.includes(policy);
}

/**
 * @param {string} kindId
 * @param {string} policy
 * @returns {boolean}
 */
export function isReleasePolicyAllowedForKind(kindId, policy) {
    const kind = getKind(kindId);
    if (!kind) return false;
    return kind.releasePolicies.includes(policy);
}

function missingKeys(group, credentials) {
    return group.filter((key) => credentials[key] === undefined || credentials[key] === null || credentials[key] === '');
}

/**
 * Validate that `credentials` (a decrypted plain field map) satisfies the
 * shape required by `kindId`.
 *
 * @param {string} kindId
 * @param {object} credentials
 * @returns {{ valid: boolean, message?: string }}
 */
export function validateKindShape(kindId, credentials) {
    const kind = getKind(kindId);
    if (!kind) {
        return { valid: false, message: `Unknown credential_kind: ${kindId}` };
    }

    const creds = credentials || {};

    if (kind.shape === 'permissive') {
        return { valid: true };
    }

    if (kind.shape === 'required') {
        const missing = missingKeys(kind.required, creds);
        if (missing.length > 0) {
            return { valid: false, message: `${kind.label} requires: ${missing.join(', ')}` };
        }
        return { valid: true };
    }

    if (kind.shape === 'oneOf') {
        for (const group of kind.oneOf) {
            if (missingKeys(group, creds).length === 0) {
                return { valid: true };
            }
        }
        const groupDescriptions = kind.oneOf.map((g) => g.join(' + ')).join(' OR ');
        return { valid: false, message: `${kind.label} requires one of: ${groupDescriptions}` };
    }

    return { valid: false, message: `Unknown shape for credential_kind: ${kindId}` };
}

export default {
    RELEASE_POLICIES,
    CREDENTIAL_KINDS,
    getKind,
    listKinds,
    isValidKind,
    isValidReleasePolicy,
    isReleasePolicyAllowedForKind,
    validateKindShape,
};
