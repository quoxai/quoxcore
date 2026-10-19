/**
 * Audit logging utility for Quox Auth Service
 */

import { generateId } from './crypto.js';
import { queries } from '../db/index.js';

// ============================================================================
// Audit Actions
// ============================================================================

export const AuditActions = {
    // Authentication
    AUTH_SIGNUP: 'auth.signup',
    AUTH_LOGIN: 'auth.login',
    AUTH_LOGOUT: 'auth.logout',
    AUTH_LOGIN_FAILED: 'auth.login_failed',
    AUTH_PASSWORD_RESET_REQUEST: 'auth.password_reset_request',
    AUTH_PASSWORD_RESET_COMPLETE: 'auth.password_reset_complete',
    AUTH_PASSWORD_CHANGE: 'auth.password_change',
    // fleet #438: profile edits used to be logged as AUTH_PASSWORD_CHANGE,
    // which put routine preference saves into a security-sensitive intent
    // (11,070 quox.auth.password_change envelopes since May, almost none of
    // them actual password changes). A profile update is its own event.
    AUTH_PROFILE_UPDATE: 'auth.profile_update',
    AUTH_EMAIL_VERIFY: 'auth.email_verify',
    AUTH_MFA_ENABLE: 'auth.mfa_enable',
    AUTH_MFA_DISABLE: 'auth.mfa_disable',
    AUTH_MFA_VERIFY: 'auth.mfa_verify',
    AUTH_SESSION_REVOKE: 'auth.session_revoke',
    AUTH_SESSION_REVOKE_ALL: 'auth.session_revoke_all',
    AUTH_ORG_SWITCH: 'auth.org_switch',  // Phase 2: Multi-tenancy

    // Organization
    ORG_CREATE: 'org.create',
    ORG_UPDATE: 'org.update',
    ORG_DELETE: 'org.delete',

    // Membership
    ORG_MEMBER_INVITE: 'org.member.invite',
    ORG_MEMBER_ACCEPT: 'org.member.accept',
    ORG_MEMBER_ROLE_CHANGE: 'org.member.role_change',
    ORG_MEMBER_SUSPEND: 'org.member.suspend',
    ORG_MEMBER_REMOVE: 'org.member.remove',
    ORG_MEMBER_LEAVE: 'org.member.leave',

    // Teams
    TEAM_CREATE: 'team.create',
    TEAM_UPDATE: 'team.update',
    TEAM_DELETE: 'team.delete',
    TEAM_MEMBER_ADD: 'team.member.add',
    TEAM_MEMBER_REMOVE: 'team.member.remove',
    TEAM_MEMBER_ROLE_CHANGE: 'team.member.role_change',

    // Service Accounts
    SERVICE_ACCOUNT_CREATE: 'service_account.create',
    SERVICE_ACCOUNT_REVOKE: 'service_account.revoke',
    SERVICE_ACCOUNT_USE: 'service_account.use',

    // Secrets
    SECRET_CREATE: 'secret.create',
    SECRET_ACCESS: 'secret.access',
    // A refused credential resolution (cross-org, unknown id). Never a release; status 'denied'.
    SECRET_ACCESS_DENIED: 'secret.access.denied',
    SECRET_UPDATE: 'secret.update',
    SECRET_DELETE: 'secret.delete',
    SECRET_ROTATE: 'secret.rotate',
    // VAULT-P5.G: lease enforcement live wiring (F4) — advisory-mode release
    // despite a missing/expired lease, and enforced-mode denial.
    SECRET_ACCESS_LEASE_MISSING: 'secret.access.lease_missing',
    SECRET_ACCESS_LEASE_DENIED: 'secret.access.lease_denied',

    // Directory
    ASSISTANT_CREATE: 'directory.assistant.create',
    ASSISTANT_UPDATE: 'directory.assistant.update',
    ASSISTANT_DELETE: 'directory.assistant.delete',
    ASSISTANT_DEPLOY: 'directory.assistant.deploy',
    AGENT_CREATE: 'directory.agent.create',
    AGENT_UPDATE: 'directory.agent.update',
    AGENT_DELETE: 'directory.agent.delete',
    TOOL_CREATE: 'directory.tool.create',
    TOOL_UPDATE: 'directory.tool.update',
    TOOL_DELETE: 'directory.tool.delete',
    WORKFLOW_CREATE: 'directory.workflow.create',
    WORKFLOW_UPDATE: 'directory.workflow.update',
    WORKFLOW_DELETE: 'directory.workflow.delete',
    WORKFLOW_PUBLISH: 'directory.workflow.publish',

    // Runtime
    RUN_START: 'runtime.run.start',
    RUN_COMPLETE: 'runtime.run.complete',
    RUN_CANCEL: 'runtime.run.cancel',
    RUN_FAIL: 'runtime.run.fail',

    // HITL
    HITL_REQUEST: 'hitl.request',
    HITL_APPROVE: 'hitl.approve',
    HITL_DENY: 'hitl.deny',
    HITL_TIMEOUT: 'hitl.timeout',

    // Notifications (Security Issue #43)
    NOTIFICATION_TEST_EMAIL: 'notification.test_email',

    // Integration Credentials
    INTEGRATION_CREATE: 'integration.create',
    INTEGRATION_UPDATE: 'integration.update',
    INTEGRATION_DELETE: 'integration.delete',
    INTEGRATION_TEST: 'integration.test',
    INTEGRATION_ACCESS: 'integration.access',
    INTEGRATION_SET_DEFAULT: 'integration.set_default',
    INTEGRATION_ROTATE: 'integration.rotate',
    // #1288: an org admin allowed (or was refused) their own Ollama on a private address
    INTEGRATION_PRIVATE_ORIGIN: 'integration.private_origin',

    // Instance Configuration (Core Integrations)
    CONFIG_UPDATE: 'config.update',
    CONFIG_API_KEY_SET: 'config.api_key.set',
    CONFIG_API_KEY_CLEAR: 'config.api_key.clear',
    CONFIG_ENDPOINT_UPDATE: 'config.endpoint.update',
    CONFIG_SMTP_UPDATE: 'config.smtp.update',
    CONFIG_ENCRYPTION_ROTATE: 'config.encryption.rotate',
    // GDPR / Privacy (Security Issue #56, #57)
    GDPR_DATA_EXPORT: 'gdpr.data_export',
    GDPR_DATA_ERASURE: 'gdpr.data_erasure',
    GDPR_CONSENT_UPDATE: 'gdpr.consent_update',

    // Admin Data Access (Security Issue #75)
    ADMIN_VIEW_CONFIG: 'admin.view.config',
    ADMIN_VIEW_ADMINS: 'admin.view.admins',
    ADMIN_VIEW_API_KEYS: 'admin.view.api_keys',
    ADMIN_VIEW_SERVICES: 'admin.view.services',
    ADMIN_VIEW_LOGS: 'admin.view.logs',
    ADMIN_VIEW_STATS: 'admin.view.stats',
    ADMIN_TEST_API_KEY: 'admin.test.api_key',
    ADMIN_SERVICE_HEALTH_CHECK: 'admin.service.health_check',

    // Bastion command HITL (#50)
    BASTION_COMMAND_VALIDATED: 'bastion.command_validated',
    BASTION_COMMAND_BLOCKED: 'bastion.command_blocked',
    BASTION_APPROVAL_REQUESTED: 'bastion.approval_requested',
    BASTION_APPROVAL_APPROVED: 'bastion.approval_approved',
    BASTION_APPROVAL_DENIED: 'bastion.approval_denied',
    BASTION_APPROVAL_CANCELLED: 'bastion.approval_cancelled',
    BASTION_APPROVAL_EXPIRED: 'bastion.approval_expired',
    BASTION_TOKEN_VERIFIED: 'bastion.token_verified',
    BASTION_COMMAND_EXECUTED: 'bastion.command_executed',

    // Account Deletion (GDPR Art. 17 - Right to Erasure)
    AUTH_ACCOUNT_DELETE_REQUEST: 'auth.account_delete_request',
    AUTH_ACCOUNT_DELETE_SCHEDULED: 'auth.account_delete_scheduled',
    AUTH_ACCOUNT_DELETE_CANCELLED: 'auth.account_delete_cancelled',
    AUTH_ACCOUNT_DELETE_COMPLETE: 'auth.account_delete_complete',

    // Frontend Operations (Security Issue #69 - moved from localStorage to server-side)
    FRONTEND_OPERATION: 'frontend.operation',
    FRONTEND_OPERATION_BLOCKED: 'frontend.operation.blocked',
    FRONTEND_OPERATION_DRY_RUN: 'frontend.operation.dry_run',
    FRONTEND_ROUTER_DECISION: 'frontend.router.decision',
    FRONTEND_ROUTER_ESCALATION: 'frontend.router.escalation',

    // Data Retention (Security Issue #73)
    RETENTION_CLEANUP_MANUAL: 'retention.cleanup.manual',
    RETENTION_CLEANUP_SCHEDULED: 'retention.cleanup.scheduled',
    RETENTION_POLICY_UPDATE: 'retention.policy.update',
    RETENTION_PREFERENCES_UPDATE: 'retention.preferences.update',
    RETENTION_DELETION_REQUESTED: 'retention.deletion.requested'
};

// ============================================================================
// Audit Logger
// ============================================================================

/**
 * Log an audit event
 *
 * @param {Object} event
 * @param {string} event.action - Action from AuditActions
 * @param {Object} event.actor - { type: 'user'|'service_account'|'system', id }
 * @param {string} [event.orgId] - Organization ID
 * @param {Object} [event.target] - { type, id }
 * @param {string} [event.scopeId] - Team/project scope
 * @param {string} [event.status] - 'success'|'failure'|'denied'
 * @param {Object} [event.request] - Express request object (for IP/UA extraction)
 * @param {Object} [event.metadata] - Additional event-specific data
 */
export function logAudit(event) {
    const {
        action,
        actor,
        orgId,
        target,
        scopeId,
        status = 'success',
        request,
        metadata = {}
    } = event;

    // Extract IP and user agent from request
    const ipAddress = request ?
        (request.headers['x-forwarded-for']?.split(',')[0] ||
         request.socket?.remoteAddress ||
         request.ip) : null;
    const userAgent = request?.headers['user-agent'] || null;

    const auditEvent = {
        id: generateId(),
        org_id: orgId || null,
        actor_type: actor.type,
        actor_id: actor.id,
        action,
        target_type: target?.type || null,
        target_id: target?.id || null,
        scope_id: scopeId || null,
        status,
        ip_address: ipAddress,
        user_agent: userAgent ? userAgent.slice(0, 500) : null,  // Truncate long UAs
        metadata_json: JSON.stringify(metadata)
    };

    try {
        queries.createAuditEvent(auditEvent);
    } catch (err) {
        // Log to console if DB write fails - audit should never crash the app
        console.error('Failed to write audit event:', err.message, auditEvent);
    }

    // AEE-CORE-3: also emit an AEE envelope so auth/org/membership events
    // appear in the unified Activity Centre. Fire-and-forget; never block the
    // auth request on a collector round-trip.
    try {
        // Lazy import so tests that mock fetch don't need to care about this.
        import('../lib/aeeClient.js').then(({ emitEnvelope }) => {
            // Map `auth.login` → `quox.auth.login`, `org.create` → `quox.org.create`,
            // etc. Fallback to `quox.<action>` for anything else.
            const dotted = String(action || 'unknown');
            const intent = dotted.startsWith('quox.') ? dotted : `quox.${dotted}`;
            const corr = `AUTH_${auditEvent.id}`;
            emitEnvelope({
                // fleet #438: tag the envelope when, and ONLY when, the caller
                // actually knew an org. User-scoped events (signup, password
                // change, profile update) legitimately have none, and stamping
                // them with "some org this user belongs to" would fabricate
                // provenance in an audit trail. An honest NULL is a read-side
                // question, a wrong org is a lie.
                org_id: orgId || null,
                type: status === 'success' ? 'event' : 'error',
                from: actor.type === 'user' ? `human.${actor.id}` : `system.${actor.type || 'auth'}`,
                to: 'audit.system',
                intent,
                corr,
                payload: {
                    action,
                    actor_type: actor.type,
                    actor_id: actor.id,
                    org_id: orgId || undefined,
                    target_type: target?.type || undefined,
                    target_id: target?.id || undefined,
                    status,
                    ip_address: ipAddress || undefined,
                    // Redact user agent to avoid noisy full strings in AEE
                    user_agent: userAgent ? userAgent.slice(0, 120) : undefined,
                    ...metadata,
                },
            });
        }).catch(() => { /* lazy load failed — don't crash audit */ });
    } catch { /* never crash the app over an audit bridge hiccup */ }

    return auditEvent;
}

/**
 * Log an authentication event (convenience wrapper)
 */
export function logAuthEvent(action, userId, request, metadata = {}, orgId = null) {
    return logAudit({
        action,
        actor: { type: 'user', id: userId || 'anonymous' },
        target: userId ? { type: 'user', id: userId } : null,
        // fleet #438: optional, and only passed by call sites where the org is
        // UNAMBIGUOUS (an org switch knows exactly which org it switched to).
        // Left null for genuinely user-scoped events rather than guessed at.
        orgId: orgId || null,
        request,
        metadata
    });
}

/**
 * Log an organization event (convenience wrapper)
 */
export function logOrgEvent(action, actor, orgId, request, metadata = {}) {
    return logAudit({
        action,
        actor,
        orgId,
        target: { type: 'org', id: orgId },
        request,
        metadata
    });
}

/**
 * Log a membership event (convenience wrapper)
 */
export function logMembershipEvent(action, actor, orgId, targetUserId, request, metadata = {}) {
    return logAudit({
        action,
        actor,
        orgId,
        target: { type: 'user', id: targetUserId },
        request,
        metadata
    });
}

/**
 * Log an integration credential event (convenience wrapper)
 */
export function logIntegrationEvent(action, actor, orgId, integrationId, request, metadata = {}) {
    return logAudit({
        action,
        actor,
        orgId,
        target: { type: 'integration', id: integrationId },
        request,
        metadata
    });
}

/**
 * Log an admin data access event (convenience wrapper)
 * Security Issue #75: Ensures all admin data access is audited
 */
export function logAdminAccess(action, actor, request, target = null, metadata = {}) {
    return logAudit({
        action,
        actor,
        target,
        request,
        metadata
    });
}

// ============================================================================
// Audit Query Helpers
// ============================================================================

/**
 * Get audit events for an organization
 */
export function getOrgAuditLog(orgId, options = {}) {
    const { limit = 100, offset = 0 } = options;
    return queries.getAuditEvents(orgId, limit, offset);
}

/**
 * Get audit events for a specific actor
 */
export function getActorAuditLog(actorType, actorId, options = {}) {
    const { limit = 100, offset = 0 } = options;
    const db = queries.getDb?.() || require('../db/index.js').getDb();
    return db.prepare(`
        SELECT * FROM audit_events
        WHERE actor_type = ? AND actor_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
    `).all(actorType, actorId, limit, offset);
}

export default {
    logAudit,
    logAuthEvent,
    logOrgEvent,
    logMembershipEvent,
    logIntegrationEvent,
    logAdminAccess,
    getOrgAuditLog,
    getActorAuditLog,
    AuditActions
};
