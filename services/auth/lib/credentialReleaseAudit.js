/**
 * VAULT-AUDIT P5.E — Shared tamper-evident release audit for credential
 * decrypt/release endpoints.
 *
 * Every internal endpoint that releases a decrypted credential (its plaintext
 * `credentials` field) to a caller must write a WARD-witnessed audit_events
 * row documenting WHO (caller_service), WHAT (credential_id, integration_type,
 * org_id), WHEN — but NEVER the secret values themselves.
 *
 * Extracted from routes/setup.js's VAULT-AUDIT P5.A1 credential-decrypt
 * handler (the first release path to get this treatment — INSERT into
 * audit_events, THEN witnessAuthAudit fire-and-forget, only after the DB
 * write succeeds) so every other release path can call the exact same
 * implementation instead of re-inlining it:
 *   - POST /api/setup/internal/resolve-by-id           (routes/setup.js)
 *   - GET  /internal/integrations/:id/service-decrypt   (routes/integrations.js)
 *   - POST /internal/integrations/:id/decrypt           (routes/integrations.js)
 *   - GET  /api/setup/internal/credential-decrypt/:id   (routes/setup.js)
 *
 * Audit failure is ALWAYS non-fatal — it must never block the credential
 * release itself.
 */
import { ulid } from 'ulid';
import { getDb } from '../db/index.js';
import { AuditActions } from '../utils/audit.js';
import { witnessAuthAudit } from './wardAdapter.js';

/**
 * @param {object} params
 * @param {import('better-sqlite3').Database} [params.db] - DB handle (defaults to getDb())
 * @param {string|null} params.orgId - Org the credential belongs to (audit row's org_id)
 * @param {string} params.credentialId - integration_credentials.id
 * @param {string} [params.integrationType]
 * @param {string} [params.label]
 * @param {string} [params.authType]
 * @param {string} [params.callerService] - defaults to 'internal'
 * @param {string} params.via - which endpoint released it (e.g. 'credential-decrypt', 'resolve-by-id', 'service-decrypt', 'decrypt')
 */
export function writeCredentialReleaseAudit({
    db,
    orgId,
    credentialId,
    integrationType,
    label,
    authType,
    callerService,
    via,
    outcome,
    reason,
}) {
    try {
        const database = db || getDb();
        const auditId = ulid();
        const createdAt = new Date().toISOString();
        const service = callerService || 'internal';
        // A refused resolution (cross-org, unknown id) must not read as a release. This writer used to drop the
        // outcome/reason its callers pass, so every denial was recorded AND WARD-witnessed as secret.access 'success'.
        const denied = outcome === 'denied';
        const action = denied ? AuditActions.SECRET_ACCESS_DENIED : AuditActions.SECRET_ACCESS;
        const status = denied ? 'denied' : 'success';

        database.prepare(`
            INSERT INTO audit_events (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            auditId, orgId || null, 'service', service, action,
            'integration_credential', credentialId,
            status,
            JSON.stringify({
                integration_type: integrationType || null,
                label: label || null,
                auth_type: authType || null,
                caller_service: service,
                via,
                ...(denied ? { outcome: 'denied', reason: reason || null } : {}),
            }),
            createdAt
        );

        witnessAuthAudit({
            id: auditId,
            org_id: orgId || null,
            actor_type: 'service',
            actor_id: service,
            action,
            target_type: 'integration_credential',
            target_id: credentialId,
            status,
            created_at: createdAt,
        }, orgId || null).catch(() => {
            // witnessAuthAudit already swallows errors internally; final safety net
        });
    } catch (auditErr) {
        // Audit failure is non-fatal — never block credential release on it.
        console.error('[VAULT-AUDIT] credential release audit write failed (non-fatal):', auditErr.message);
    }
}

/**
 * VAULT-P5.G — WARD-witnessed audit for lease-gate outcomes (F4 live
 * enforcement). Written IN ADDITION to writeCredentialReleaseAudit — one row
 * documents "a secret was released", this one documents "...and it required
 * a lease the caller didn't cleanly hold" (advisory = allowed anyway,
 * denied = release refused).
 *
 * @param {object} params
 * @param {import('better-sqlite3').Database} [params.db]
 * @param {string|null} params.orgId
 * @param {string} params.credentialId
 * @param {string} [params.integrationType]
 * @param {string} [params.label]
 * @param {string|null} [params.agentId]
 * @param {'lease_missing'|'lease_denied'} params.outcome
 * @param {string} [params.reason] - e.g. 'lease_required' | 'lease_exhausted' | 'lease_check_error'
 * @param {string} [params.callerService]
 * @param {string} params.via - which endpoint evaluated the gate
 */
export function writeLeaseAccessAudit({
    db,
    orgId,
    credentialId,
    integrationType,
    label,
    agentId,
    outcome,
    reason,
    callerService,
    via,
}) {
    try {
        const database = db || getDb();
        const auditId = ulid();
        const createdAt = new Date().toISOString();
        const service = callerService || 'internal';
        const action = outcome === 'lease_denied'
            ? AuditActions.SECRET_ACCESS_LEASE_DENIED
            : AuditActions.SECRET_ACCESS_LEASE_MISSING;

        database.prepare(`
            INSERT INTO audit_events (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            auditId, orgId || null, 'service', service, action,
            'integration_credential', credentialId,
            outcome === 'lease_denied' ? 'denied' : 'success',
            JSON.stringify({
                integration_type: integrationType || null,
                label: label || null,
                agent_id: agentId || null,
                reason: reason || null,
                caller_service: service,
                via,
            }),
            createdAt
        );

        witnessAuthAudit({
            id: auditId,
            org_id: orgId || null,
            actor_type: 'service',
            actor_id: service,
            action,
            target_type: 'integration_credential',
            target_id: credentialId,
            status: outcome === 'lease_denied' ? 'denied' : 'success',
            created_at: createdAt,
        }, orgId || null).catch(() => {
            // witnessAuthAudit already swallows errors internally; final safety net
        });
    } catch (auditErr) {
        console.error('[VAULT-P5.G] lease access audit write failed (non-fatal):', auditErr.message);
    }
}

/**
 * AQ-9B DEBT 2 — tamper-evident audit for PATCH /internal/credential-fields/:id
 * (Calendar-Q OAuth write-back and any future caller of that endpoint).
 * Documents WHO (callerService), WHAT (credential_id, integration_type,
 * org_id, the PATCHED FIELD NAMES only), WHEN — never the field values.
 * Audit failure is non-fatal, same contract as writeCredentialReleaseAudit.
 *
 * @param {object} params
 * @param {import('better-sqlite3').Database} [params.db]
 * @param {string|null} params.orgId
 * @param {string} params.credentialId
 * @param {string} [params.integrationType]
 * @param {string} [params.label]
 * @param {string[]} params.fieldNames - names only, e.g. ['refresh_token']
 * @param {string} [params.callerService]
 * @param {string} params.via
 */
export function writeCredentialUpdateAudit({
    db,
    orgId,
    credentialId,
    integrationType,
    label,
    fieldNames,
    callerService,
    via,
}) {
    try {
        const database = db || getDb();
        const auditId = ulid();
        const createdAt = new Date().toISOString();
        const service = callerService || 'internal';

        database.prepare(`
            INSERT INTO audit_events (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            auditId, orgId || null, 'service', service, AuditActions.SECRET_UPDATE,
            'integration_credential', credentialId,
            'success',
            JSON.stringify({
                integration_type: integrationType || null,
                label: label || null,
                field_names: fieldNames || [],
                caller_service: service,
                via,
            }),
            createdAt
        );

        witnessAuthAudit({
            id: auditId,
            org_id: orgId || null,
            actor_type: 'service',
            actor_id: service,
            action: AuditActions.SECRET_UPDATE,
            target_type: 'integration_credential',
            target_id: credentialId,
            status: 'success',
            created_at: createdAt,
        }, orgId || null).catch(() => {
            // witnessAuthAudit already swallows errors internally; final safety net
        });
    } catch (auditErr) {
        console.error('[VAULT-AUDIT] credential update audit write failed (non-fatal):', auditErr.message);
    }
}
