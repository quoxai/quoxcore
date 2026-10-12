/**
 * ET-2 Phase A — SSO provider registry.
 *
 * Schema + CRUD helpers. Stores an org's external identity providers
 * (Google / Okta / Azure / generic OIDC). Client secrets are encrypted
 * at rest with the master key; list/get responses never include the
 * cipher text.
 *
 * Phase B will add the OIDC login + callback flows that use these
 * provider rows as configuration.
 */

import { ulid } from './helpers.js';
import { encrypt, decrypt } from './encryption.js';

export const SSO_PROTOCOLS = Object.freeze(['oidc', 'saml']);

// When the sso_providers table was first created for OIDC, several
// columns (issuer, client_id, client_secret_cipher) were NOT NULL.
// SAML providers don't use them; we feed these sentinels so the old
// rows still validate. Real validation lives in validateCreate.
const SAML_ISSUER_PLACEHOLDER    = 'urn:quox:saml';
const SAML_CLIENT_ID_PLACEHOLDER = 'saml';
const SAML_CIPHER_PLACEHOLDER    = 'saml';

// ──────────────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────────────

export function ensureSsoSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS sso_providers (
            id                   TEXT PRIMARY KEY,
            org_id               TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            protocol             TEXT NOT NULL DEFAULT 'oidc',
            provider_key         TEXT NOT NULL,
            display_name         TEXT,
            issuer               TEXT NOT NULL,
            client_id            TEXT NOT NULL,
            client_secret_cipher TEXT NOT NULL,
            authz_url            TEXT,
            token_url            TEXT,
            userinfo_url         TEXT,
            jwks_uri             TEXT,
            scopes_json          TEXT NOT NULL DEFAULT '[]',
            enabled              INTEGER NOT NULL DEFAULT 1,
            sso_only             INTEGER NOT NULL DEFAULT 0,
            created_at           TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(org_id, provider_key)
        );
        CREATE INDEX IF NOT EXISTS idx_sso_providers_org
            ON sso_providers(org_id, enabled);

        CREATE TABLE IF NOT EXISTS sso_provider_domains (
            id          TEXT PRIMARY KEY,
            provider_id TEXT NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
            domain      TEXT NOT NULL,
            UNIQUE(provider_id, domain)
        );
        CREATE INDEX IF NOT EXISTS idx_sso_provider_domains_domain
            ON sso_provider_domains(domain);

        CREATE TABLE IF NOT EXISTS sso_sessions (
            id             TEXT PRIMARY KEY,
            user_id        TEXT NOT NULL,
            provider_id    TEXT NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
            subject        TEXT NOT NULL,
            email          TEXT,
            last_login_at  TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(provider_id, subject)
        );
    `);

    // ET-2B: SAML-specific columns. Idempotent ALTERs for existing
    // OIDC-only databases.
    const cols = db.prepare(`PRAGMA table_info(sso_providers)`).all().map(c => c.name);
    const ensure = (name, ddl) => {
        if (!cols.includes(name)) db.exec(`ALTER TABLE sso_providers ADD COLUMN ${ddl}`);
    };
    ensure('entity_id',           'entity_id TEXT');
    ensure('sso_url',             'sso_url TEXT');
    ensure('slo_url',             'slo_url TEXT');
    ensure('x509_cert',           'x509_cert TEXT');
    ensure('nameid_format',       'nameid_format TEXT');
    ensure('attribute_map_json',  `attribute_map_json TEXT NOT NULL DEFAULT '{}'`);
    ensure('group_role_map_json', `group_role_map_json TEXT NOT NULL DEFAULT '{}'`);
}

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

function normaliseDomain(d) {
    if (typeof d !== 'string') return null;
    const trimmed = d.trim().toLowerCase();
    if (!trimmed || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed)) return null;
    return trimmed;
}

function validateOidcCreate({ providerKey, issuer, clientId, clientSecret }) {
    if (!providerKey || typeof providerKey !== 'string') {
        throw new Error('provider_key is required');
    }
    if (!issuer || typeof issuer !== 'string') {
        throw new Error('issuer is required');
    }
    if (!clientId || typeof clientId !== 'string') {
        throw new Error('client_id is required');
    }
    if (!clientSecret || typeof clientSecret !== 'string') {
        throw new Error('client_secret is required on create');
    }
}

function validateSamlCreate({ providerKey, entityId, ssoUrl, x509Cert }) {
    if (!providerKey || typeof providerKey !== 'string') {
        throw new Error('provider_key is required');
    }
    if (!entityId || typeof entityId !== 'string') {
        throw new Error('entity_id is required for SAML providers');
    }
    if (!ssoUrl || typeof ssoUrl !== 'string') {
        throw new Error('sso_url is required for SAML providers');
    }
    if (typeof x509Cert !== 'string' || !/BEGIN CERTIFICATE/.test(x509Cert)) {
        throw new Error('x509_cert (PEM) is required for SAML providers');
    }
}

function validateCreate(input) {
    const protocol = input.protocol || 'oidc';
    if (!SSO_PROTOCOLS.includes(protocol)) {
        throw new Error(`unsupported protocol "${protocol}" — expected one of ${SSO_PROTOCOLS.join(', ')}`);
    }
    if (protocol === 'saml') validateSamlCreate(input);
    else                     validateOidcCreate(input);
}

function rowToProvider(row, domains = []) {
    if (!row) return null;
    const { client_secret_cipher: _cipher, x509_cert: _cert,
            scopes_json, attribute_map_json, group_role_map_json, ...rest } = row;
    return {
        ...rest,
        enabled:         !!row.enabled,
        sso_only:        !!row.sso_only,
        scopes:          scopes_json ? JSON.parse(scopes_json) : [],
        attribute_map:   attribute_map_json   ? JSON.parse(attribute_map_json)   : {},
        group_role_map:  group_role_map_json  ? JSON.parse(group_role_map_json)  : {},
        email_domains:   domains,
    };
}

function loadDomains(db, providerId) {
    return db.prepare(
        `SELECT domain FROM sso_provider_domains WHERE provider_id = ? ORDER BY domain ASC`,
    ).all(providerId).map(r => r.domain);
}

function writeDomainsAtomic(db, providerId, rawDomains) {
    const clean = Array.isArray(rawDomains)
        ? [...new Set(rawDomains.map(normaliseDomain).filter(Boolean))]
        : [];
    const run = db.transaction(() => {
        db.prepare(`DELETE FROM sso_provider_domains WHERE provider_id = ?`).run(providerId);
        const insert = db.prepare(
            `INSERT INTO sso_provider_domains (id, provider_id, domain) VALUES (?, ?, ?)`,
        );
        for (const d of clean) insert.run(ulid(), providerId, d);
    });
    run();
    return clean;
}

// ──────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────

export function createSsoProvider(db, orgId, input) {
    const protocol    = input.protocol     || 'oidc';
    const providerKey = input.providerKey  || input.provider_key;

    // Normalise — the caller can send either camel or snake style; both
    // protocols accept the display_name / email_domains / enabled flags.
    const normalised = {
        protocol,
        providerKey,
        // OIDC
        issuer:       input.issuer,
        clientId:     input.clientId     || input.client_id,
        clientSecret: input.clientSecret || input.client_secret,
        // SAML
        entityId:     input.entityId     || input.entity_id,
        ssoUrl:       input.ssoUrl       || input.sso_url,
        sloUrl:       input.sloUrl       || input.slo_url,
        x509Cert:     input.x509Cert     || input.x509_cert,
        nameidFormat: input.nameidFormat || input.nameid_format,
        attributeMap:  input.attributeMap  || input.attribute_map  || {},
        groupRoleMap:  input.groupRoleMap  || input.group_role_map || {},
    };
    validateCreate(normalised);

    const id = ulid();
    const isSaml = protocol === 'saml';

    // For OIDC we encrypt the client_secret. For SAML the column is
    // unused; we store an encrypted placeholder so the NOT NULL
    // constraint still holds (and nothing sensitive leaks).
    const cipher = isSaml
        ? encrypt(SAML_CIPHER_PLACEHOLDER)
        : encrypt(normalised.clientSecret);
    const scopes = Array.isArray(input.scopes) ? input.scopes
        : (isSaml ? [] : ['openid', 'email', 'profile']);

    db.prepare(`
        INSERT INTO sso_providers (
            id, org_id, protocol, provider_key, display_name,
            issuer, client_id, client_secret_cipher,
            authz_url, token_url, userinfo_url, jwks_uri,
            scopes_json, enabled, sso_only,
            entity_id, sso_url, slo_url, x509_cert, nameid_format, attribute_map_json,
            group_role_map_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, orgId, protocol, providerKey, input.displayName || null,
        isSaml ? SAML_ISSUER_PLACEHOLDER    : normalised.issuer,
        isSaml ? SAML_CLIENT_ID_PLACEHOLDER : normalised.clientId,
        cipher,
        input.authzUrl    || null,
        input.tokenUrl    || null,
        input.userinfoUrl || null,
        input.jwksUri     || null,
        JSON.stringify(scopes),
        input.enabled === false ? 0 : 1,
        input.ssoOnly === true ? 1 : 0,
        normalised.entityId     || null,
        normalised.ssoUrl       || null,
        normalised.sloUrl       || null,
        normalised.x509Cert     || null,
        normalised.nameidFormat || null,
        JSON.stringify(normalised.attributeMap || {}),
        JSON.stringify(normalised.groupRoleMap || {}),
    );

    writeDomainsAtomic(db, id, input.emailDomains || input.email_domains || []);
    return getSsoProvider(db, orgId, id);
}

const PROVIDER_SELECT = `
    id, org_id, protocol, provider_key, display_name,
    issuer, client_id, authz_url, token_url, userinfo_url,
    jwks_uri, scopes_json, enabled, sso_only, created_at, updated_at,
    entity_id, sso_url, slo_url, nameid_format, attribute_map_json,
    group_role_map_json
`;

export function listSsoProviders(db, orgId) {
    const rows = db.prepare(`
        SELECT ${PROVIDER_SELECT}
        FROM sso_providers WHERE org_id = ?
        ORDER BY created_at ASC, id ASC
    `).all(orgId);
    return rows.map(r => rowToProvider(r, loadDomains(db, r.id)));
}

export function getSsoProvider(db, orgId, providerId) {
    const row = db.prepare(`
        SELECT ${PROVIDER_SELECT}
        FROM sso_providers WHERE id = ? AND org_id = ?
    `).get(providerId, orgId);
    if (!row) return null;
    return rowToProvider(row, loadDomains(db, row.id));
}

export function updateSsoProvider(db, orgId, providerId, patch) {
    const existing = db.prepare(
        `SELECT id FROM sso_providers WHERE id = ? AND org_id = ?`,
    ).get(providerId, orgId);
    if (!existing) return null;

    const sets = [];
    const values = [];
    const mapping = {
        // Shared
        protocol:     'protocol',
        providerKey:  'provider_key',
        displayName:  'display_name',
        // OIDC
        issuer:       'issuer',
        clientId:     'client_id',
        authzUrl:     'authz_url',
        tokenUrl:     'token_url',
        userinfoUrl:  'userinfo_url',
        jwksUri:      'jwks_uri',
        // SAML
        entityId:     'entity_id',
        ssoUrl:       'sso_url',
        sloUrl:       'slo_url',
        x509Cert:     'x509_cert',
        nameidFormat: 'nameid_format',
    };
    for (const [key, col] of Object.entries(mapping)) {
        if (key in patch) {
            sets.push(`${col} = ?`);
            values.push(patch[key]);
        }
    }
    if ('enabled' in patch) {
        sets.push('enabled = ?');
        values.push(patch.enabled ? 1 : 0);
    }
    if ('ssoOnly' in patch) {
        sets.push('sso_only = ?');
        values.push(patch.ssoOnly ? 1 : 0);
    }
    if ('scopes' in patch && Array.isArray(patch.scopes)) {
        sets.push('scopes_json = ?');
        values.push(JSON.stringify(patch.scopes));
    }
    if ('clientSecret' in patch && patch.clientSecret) {
        sets.push('client_secret_cipher = ?');
        values.push(encrypt(patch.clientSecret));
    }
    if ('attributeMap' in patch || 'attribute_map' in patch) {
        const m = patch.attributeMap || patch.attribute_map || {};
        sets.push('attribute_map_json = ?');
        values.push(JSON.stringify(m));
    }
    if ('groupRoleMap' in patch || 'group_role_map' in patch) {
        const g = patch.groupRoleMap || patch.group_role_map || {};
        sets.push('group_role_map_json = ?');
        values.push(JSON.stringify(g));
    }
    sets.push(`updated_at = datetime('now')`);

    if (values.length) {
        db.prepare(`UPDATE sso_providers SET ${sets.join(', ')} WHERE id = ?`).run(...values, providerId);
    }
    if ('emailDomains' in patch || 'email_domains' in patch) {
        writeDomainsAtomic(db, providerId, patch.emailDomains || patch.email_domains || []);
    }
    return getSsoProvider(db, orgId, providerId);
}

export function deleteSsoProvider(db, orgId, providerId) {
    db.prepare(`DELETE FROM sso_providers WHERE id = ? AND org_id = ?`).run(providerId, orgId);
}

// ──────────────────────────────────────────────────────────────────────
// Lookup by email domain (used by login redirect in Phase C)
// ──────────────────────────────────────────────────────────────────────

export function findProviderByEmailDomain(db, email) {
    if (typeof email !== 'string' || !email.includes('@')) return null;
    const domain = email.split('@')[1].toLowerCase();
    const row = db.prepare(`
        SELECT p.id, p.org_id, p.protocol, p.provider_key, p.display_name,
               p.issuer, p.client_id, p.authz_url, p.token_url, p.userinfo_url,
               p.jwks_uri, p.scopes_json, p.enabled, p.sso_only,
               p.created_at, p.updated_at
        FROM sso_providers p
        INNER JOIN sso_provider_domains d ON d.provider_id = p.id
        WHERE LOWER(d.domain) = ? AND p.enabled = 1
        LIMIT 1
    `).get(domain);
    if (!row) return null;
    return rowToProvider(row, loadDomains(db, row.id));
}

// ──────────────────────────────────────────────────────────────────────
// Secret access (Phase B consumer)
// ──────────────────────────────────────────────────────────────────────

export function getDecryptedClientSecret(db, providerId) {
    const row = db.prepare(
        `SELECT client_secret_cipher FROM sso_providers WHERE id = ?`,
    ).get(providerId);
    if (!row) return null;
    return decrypt(row.client_secret_cipher);
}
