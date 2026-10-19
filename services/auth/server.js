/**
 * Quox Auth Service
 *
 * Authentication and authorization service for Quox Enterprise Workspace.
 *
 * Features:
 * - User signup/login with email verification
 * - JWT-based authentication with refresh tokens
 * - MFA (TOTP) support with backup codes
 * - Organization and team management
 * - Invite system
 * - RBAC with capabilities
 * - Audit logging
 * - Rate limiting
 */

// Load environment variables
import 'dotenv/config';

import express from 'express';
// Safety net: patch Express 4 so rejections from `async (req,res)` route handlers
// propagate to the error-handling middleware below instead of leaving the request
// hanging forever (unhandled promise rejection → no response). Auth has ~381 async
// handlers; without this an escaped DB/crypto error in any of them is a client hang
// (DoS-adjacent), not a 500. See the generic error handler near the bottom.
import 'express-async-errors';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import nodemailer from 'nodemailer';

import { getDb, closeDb, queries } from './db/index.js';
import { readInstanceConfigValue, readInstanceConfigBoolean } from './lib/instanceConfigOverrides.js';
import { createAccessToken, createRefreshToken, generateId, safeCompare } from './utils/crypto.js';
import { startCleanup, stopCleanup, apiLimiter, emailTestLimiter, sendEmailLimiter, authLimiter } from './middleware/rateLimit.js';
import { sanitizeRecipients } from './utils/recipientGuard.js';
import { startRetryWorker } from './utils/webhookRetry.js';
import { logSecurityWarnings, validateJwtSecurity } from './utils/crypto.js';
import { validateMasterKey } from './utils/encryption.js';
import { csrfProtection, getCsrfTokenHandler } from './middleware/csrf.js';
// Security Issue #43: Auth middleware for test-email endpoint
import { requireAuth } from './middleware/auth.js';
import { requireAdmin } from './middleware/authorize.js';
import { logAudit, AuditActions } from './utils/audit.js';
import { isAllowedCorsOrigin } from './utils/corsPolicy.js';
import { RESOLVED_VERSION } from './lib/resolveVersion.js';

// Routes
import authRoutes from './routes/auth.js';
import loginLinkRoutes from './routes/loginLink.js';
import orgsRoutes from './routes/orgs.js';
import customRolesRoutes from './routes/customRoles.js';
import membersRoutes from './routes/members.js';
import orgSecurityRoutes from './routes/orgSecurity.js';
import ssoRoutes from './routes/sso.js';
import domainsRoutes from './routes/domains.js';
import webhooksRoutes from './routes/webhooks.js';
import scimRoutes from './routes/scim.js';
import bulkInviteRoutes from './routes/bulkInvite.js';
import guestInviteRoutes from './routes/guestInvite.js';
import secretsRoutes from './routes/secrets.js';
import pluginsRoutes from './routes/plugins.js';
import invitesRoutes from './routes/invites.js';
import mfaRoutes from './routes/mfa.js';
import adminRoutes from './routes/admin.js';
import keysRoutes from './routes/keys.js';
import uploadsRoutes, { UPLOAD_DIR } from './routes/uploads.js';
// Phase B routes
import divisionsRoutes from './routes/divisions.js';
import departmentsRoutes from './routes/departments.js';
import teamsRoutes from './routes/teams.js';
import scopesRoutes from './routes/scopes.js';
import sharePoliciesRoutes from './routes/share-policies.js';
import toolsRoutes from './routes/tools.js';
import tagsRoutes from './routes/tags.js';
import workflowsRoutes from './routes/workflows.js';
import assistantsRoutes from './routes/assistants.js';
import widgetsRoutes, { widgetsInternalRouter } from './routes/widgets.js';
import widgetConnectorsRoutes, { widgetConnectorsInternalRouter } from './routes/widget-connectors.js';
import widgetScenariosRoutes, { widgetScenariosInternalRouter } from './routes/widget-scenarios.js';
import fileObjectsRoutes, { fileObjectsInternalRouter } from './routes/file-objects.js';
// Phase C routes (HITL)
import runsRoutes from './routes/runs.js';
import inboxRoutes from './routes/inbox.js';
import stepUpRoutes from './routes/stepUp.js';
import routingRoutes from './routes/routing.js';
import llmRoutingPolicyRoutes from './routes/llm-routing-policies.js';
import notificationsRoutes from './routes/notifications.js';
// Integrations Vault
import integrationsRoutes from './routes/integrations.js';
import integrationsMigrateRoutes from './routes/integrations-migrate.js';
import telegramProRoutes from './routes/telegramPro.js';
import oauthConnectRoutes from './routes/oauth-connect.js';
// Tool Library (Phase B2 - Agent-centric tool catalog)
import toolCatalogRoutes from './routes/tool-catalog.js';
// STUDY-REV-2 / P4.0.A — Install-to-Scope endpoints
import toolInstallScopeRoutes from './routes/tool-install-scope.js';
// STUDY-REV-2 / P4.A — Register tool from Git repo
import toolCatalogFromRepoRoutes from './routes/tool-catalog-from-repo.js';
// STUDY-REV-2 / P4.B — Register tool from Script body
import toolCatalogFromScriptRoutes from './routes/tool-catalog-from-script.js';
// TOOLSMITH Slice E — Install from Toolsmith draft
import toolCatalogFromToolsmithRoutes from './routes/tool-catalog-from-toolsmith.js';
// Catalog search (Toolsmith concierge + library sidebar)
import toolSearchRoutes from './routes/tool-search.js';
// POWERS — MCP endpoint deploy + detect
import powersRoutes, { internalRouter as powersInternalRoutes } from './routes/powers.js';
// Enterprise Entity Model - Agent Management
import agentsRoutes, { internalRouter as agentsInternalRoutes } from './routes/agents.js';
import modelsRoutes from './routes/models.js';
// Setup Routes (first-run wizard)
import setupRoutes from './routes/setup.js';
// VAULT-AUDIT P3.B1 (F17) — encrypted session-state internal endpoints
import sessionStateRoutes from './routes/session-state.js';
// VAULT-AUDIT P4.A-auth — SSH known-hosts TOFU + drift-detection internal endpoints
import sshKnownHostsRoutes from './routes/ssh-known-hosts.js';
// VAULT-AUDIT P3.C — vault_compute TOTP endpoint (seed never leaves the vault)
import totpRoutes from './routes/totp.js';
// Test Lab Routes
import testsRoutes from './routes/tests.js';
// Phase D routes (Backup, Restore, Migration)
import backupsRoutes from './routes/backups.js';
import updatesRoutes from './routes/updates.js';
// Privacy/Consent routes (Security Issue #72)
import consentRoutes, { internalRouter as consentInternalRoutes } from './routes/consent.js';
// Data Retention routes (Security Issue #73)
import retentionRoutes from './routes/retention.js';
// LICENSE-LAUNCH LL-9i3 — Quox Verified enablement admin config (no-env-only-config)
import quoxVerifiedConfigRoutes from './routes/quox-verified-config.js';
import { startScheduledCleanup, stopScheduledCleanup } from './services/retentionService.js';
// Backup Scheduler (Issue #190)
import { reconcileInterruptedVerifies } from './lib/backupVerifyReconcile.js';
import { startBackupScheduler, stopBackupScheduler, finalizeScheduledRun } from './services/backupScheduler.js';
import { startBackupAdoption } from './services/backupAdoption.js';
import { finalizeBackupRun } from './routes/backups.js';
// Service Health Scheduler (TRUST-GATE-AUDIT follow-up — periodic health checks)
import { startServiceHealthScheduler, stopServiceHealthScheduler } from './services/serviceHealthScheduler.js';
import { startPeriodicScan, stopPeriodicScan } from './services/credentialHealthScanner.js';
import { migrateInstanceConfigToVault, migrateInstanceSmtpToVault } from './migrations/instance-config-to-vault.js';
import { backfillDefaultToolPolicies, backfillEmailTranscriptSchema, backfillLeadCaptureSchema } from './lib/widgetDefaultTools.js';
import { seedCoreAgentsIfEmpty } from './migrations/seed-core-agents-on-boot.js';
import { seedToolCatalogOnBoot } from './migrations/seed-tool-catalog-on-boot.js';
// Bastion Approval routes (HITL for command execution)
import bastionApprovalsRoutes from './routes/bastion-approvals.js';
// Messages & Conversations routes (Phase 1 - audit trail)
import messagesRoutes from './routes/messages.js';
// Phase 3: Agent Tool Execution
import agentToolsRoutes from './routes/agent-tools.js';
// Phase D5: Scope-Channel Assignments + Delivery Analytics
import scopeChannelsRoutes from './routes/scope-channels.js';
// Stream E3: Team Assistants (internal service-to-service)
import teamAssistantsRoutes from './routes/teamAssistants.js';
// MCPB-HARDEN-1a: membership verification (internal service-to-service)
import identityInternalRouter from './routes/identity.js';
// MCPB-HARDEN-2B: per-user MCP token issuance + collector validation
import mcpTokensRoutes, { internalRouter as mcpTokensInternalRouter } from './routes/mcp-tokens.js';
import { internalRouter as pluginCredentialsInternalRouter } from './routes/plugin-credentials.js';
// #453 phase 15: resident agent identity (Ed25519 keypair-derived, zero human minting)
import { internalRouter as residentIdentityInternalRouter, publicRouter as residentIdentityPublicRouter } from './routes/resident-identity.js';
// MATRIX-P4a: Matrix (Synapse) JWT SSO token bridge
import matrixSsoRoutes from './routes/matrix-sso.js';
// Scoped Action Tracker
import actionRoutes from './routes/actions.js';
// QuoxVault Phase 9: Credential Leasing (JIT Agent Access)
import leaseRoutes from './routes/credential-leases.js';
// QuoxVault Phase 14: Agent Credential Assignments (extracted from integrations.js)
import agentCredentialRoutes, { internalRouter as agentCredentialInternalRoutes } from './routes/agent-credentials.js';
// QUOXIDENTITY P1 (#487): attach a live session to a registry agent identity
import agentAttachRoutes from './routes/agent-attach.js';
import { startLeaseExpiryJob, stopLeaseExpiryJob } from './jobs/lease-expiry.js';
// LIFECYCLE-P1-D3: Powers deprecation TTL daily cleanup
import { startDeprecationTtlJob, stopDeprecationTtlJob } from './jobs/powers-deprecation-ttl.js';
// LIFECYCLE-P3-D4: Audit event reaper (durable retry queue for B1 secret.access + failed audit events)
import { startAuditEventReaper, stopAuditEventReaper } from './jobs/audit-event-reaper.js';
import { startWardWitnessSweep } from './jobs/ward-witness-sweep.js';
import { getWardWitnessHealth } from './lib/wardAdapter.js';
import { startVoltWitnessReaper, stopVoltWitnessReaper } from './jobs/volt-witness-reaper.js';
import { startSlaEscalation, stopSlaEscalation, configureSlaEscalation } from './jobs/sla-escalation.js';
import { routeAndNotify } from './services/notificationRouter.js';
// VAULT-AUDIT P3.C (F-4): prune expired credential_session_state rows
import { startSessionStatePruneJob, stopSessionStatePruneJob } from './jobs/session-state-prune.js';
// LICENSE-ENFORCE LE-2: server-side instance identity + Ed25519 license lease renewal
import { ensureInstanceId } from './lib/instanceIdentity.js';
import { startLicenseRenewalJob, stopLicenseRenewalJob } from './jobs/license-renewal.js';
import { getRenewalHealth } from './lib/licenseClient.js';
// GitHub Org Mappings (Phase R2)
import githubMappingsRoutes from './routes/github-mappings.js';
// QN Phase 1: RepoBrain connection registry
import repobrainConnectionsRoutes from './routes/repobrain-connections.js';
// STUDY-REV-2 / P5.D — User Workflow Library
import userLibraryRoutes from './routes/user-library.js';
// STUDY-REV-2 / P7.E.1 — User-owned Prompts Library
import promptsRoutes from './routes/prompts.js';
// TOOLSMITH Slice B — tool draft persistence
import toolDraftsRoutes from './routes/tool-drafts.js';
// Marketplace (Stream 2: Developer Portal)
import sellersRoutes from './routes/sellers.js';
import listingsRoutes from './routes/listings.js';
import reviewsRoutes from './routes/reviews.js';
import marketplaceRoutes from './routes/marketplace.js';

// Configuration
const PORT = process.env.AUTH_PORT || 3101;
const HOST = process.env.AUTH_HOST || '0.0.0.0';

// CORS Origins - Issue #140: Support dynamic origins for setup wizard
// In production, set CORS_ORIGINS env var to your specific domain(s)
const ENV_CORS_ORIGINS = process.env.CORS_ORIGINS?.split(',') || [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://localhost:3443'
];

// VAULT-INTEG P17: instance_config ('cors_origins', comma list written by
// the setup wizard) is UNIONED with the env-derived list rather than
// replacing it — the wizard's dashboardUrl auto-append (routes/setup.js)
// already relies on additive CORS_ORIGINS behaviour, and losing an
// env-configured origin because the wizard was used once would be a silent
// lockout. Evaluated per request (isSetupComplete() above is already
// re-read the same way) so a wizard write takes effect without a restart.
function resolveCorsOrigins() {
    const stored = readInstanceConfigValue('cors_origins');
    if (!stored) return ENV_CORS_ORIGINS;
    const wizardOrigins = stored.split(',').map(o => o.trim()).filter(Boolean);
    return Array.from(new Set([...ENV_CORS_ORIGINS, ...wizardOrigins]));
}

// Dynamic CORS origin handler for setup phase
// SECURITY FIX: Only allow wide-open origins during initial setup, not after
let _setupComplete = null; // Cached setup status

async function isSetupComplete() {
    if (_setupComplete !== null) return _setupComplete;
    try {
        const db = getDb();
        const row = db.prepare("SELECT value FROM instance_config WHERE key = 'instance.setup_complete'").get();
        _setupComplete = row?.value === 'true';
    } catch {
        _setupComplete = false; // If DB not ready, assume setup not complete
    }
    return _setupComplete;
}

// Allow cache to be invalidated when setup completes
export function invalidateSetupCache() {
    _setupComplete = null;
}

const baseCorsOptions = {
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-CSRF-Token', 'X-Step-Up-Token']
};

const corsOptionsDelegate = (req, callback) => {
    const origin = req.header('Origin');

    isSetupComplete().then((complete) => {
        const decision = isAllowedCorsOrigin({
            origin,
            requestHost: req.header('Host') || req.hostname,
            explicitOrigins: resolveCorsOrigins(),
            setupComplete: complete,
        });

        if (decision.allowed) {
            if (!complete && decision.reason === 'setup_safe_origin' && origin) {
                console.log(`[CORS] Allowing setup origin: ${origin}`);
            }

            return callback(null, {
                ...baseCorsOptions,
                origin: true,
            });
        }

        return callback(new Error('Not allowed by CORS'), {
            ...baseCorsOptions,
            origin: false,
        });
    }).catch(() => {
        callback(new Error('Not allowed by CORS'), {
            ...baseCorsOptions,
            origin: false,
        });
    });
};

// TRUST-GATE-OPS: refuse to boot with test-only env flags in production
// (same guard as collector — see lib/bootGuard.js)
const { guardTestEnvFlags } = await import('./lib/bootGuard.js');
const _bootGuardResult = guardTestEnvFlags(process.env);
if (_bootGuardResult.shouldAbort) {
    console.error(`[boot] Refusing to start with test-only env flags set: ${_bootGuardResult.presentFlags.join(',')}. Set ALLOW_TEST_FLAGS=true to bypass (test contexts only).`);
    process.exit(1);
} else if (_bootGuardResult.presentFlags.length > 0) {
    console.warn(`[boot] WARNING: test-only env flags active under ALLOW_TEST_FLAGS=true: ${_bootGuardResult.presentFlags.join(',')}`);
}

// Initialize Express app
const app = express();

// Trust first proxy (nginx) so req.ip uses X-Forwarded-For / X-Real-IP
// Without this, all requests behind nginx share the same Docker bridge IP
// and rate limiting blocks everyone after one user hits the limit.
app.set('trust proxy', 1);

// Security middleware
// Issue #140 Fix 2: Only enable HSTS when running over HTTPS
// VAULT-INTEG P17: instance_config ('cookie_secure', written by the setup
// wizard) wins over the env-derived default when set — mirrors
// lib/accessTokenCookie.js's resolveCookieSecure(). Read once at boot: HSTS
// is baked into the helmet() config below, which itself runs once per
// process start, so this can't be re-evaluated per request without also
// restructuring the helmet wiring (out of scope here).
const isHttps = (() => {
    const override = readInstanceConfigBoolean('cookie_secure');
    if (override !== null) return override;
    return process.env.COOKIE_SECURE === 'true' || process.env.SSL_MODE === 'true';
})();
app.use(helmet({
    contentSecurityPolicy: {
        reportOnly: true,  // Start in report-only mode for safety
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://fonts.googleapis.com"],
            objectSrc: ["'none'"],
            frameAncestors: ["'self'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            upgradeInsecureRequests: []
        }
    },
    crossOriginEmbedderPolicy: false,
    // HSTS should only be sent over HTTPS per RFC 6797
    hsts: isHttps ? { maxAge: 31536000, includeSubDomains: true } : false
}));

// CORS - Security Issue #44: Added X-CSRF-Token header
// Issue #140: Use dynamic origin handler for setup wizard accessibility
app.use(cors(corsOptionsDelegate));

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// CSRF Protection (Security Issue #44)
// Implements Double Submit Cookie pattern for state-changing requests
app.use(csrfProtection({
    enabled: process.env.CSRF_PROTECTION !== 'disabled'  // Can be disabled for testing
}));

// CSRF token endpoint - clients can call this to get a fresh token
app.get('/api/csrf-token', getCsrfTokenHandler);

// Static file serving for uploads
app.use('/uploads', express.static(UPLOAD_DIR, {
    maxAge: '7d',
    etag: true,
    lastModified: true
}));

// Request logging (simple)
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        const logLevel = res.statusCode >= 400 ? 'warn' : 'info';
        console[logLevel](`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
    next();
});

// Health check (no rate limit)
app.get('/health', (req, res) => {
    try {
        // Quick DB check
        const db = getDb();
        db.prepare('SELECT 1').get();

        // quox#522: a durable licence-renewal failure degrades the report but
        // stays HTTP 200 — a quox.ai outage must never make an orchestrator
        // restart-loop this service.
        const renewal = getRenewalHealth(db);

        // #1078: auth audit witnessing (the collector is the WARD writer). A failure degrades the report, stays 200.
        const wardWitness = getWardWitnessHealth();
        res.json({
            status: renewal.degraded || wardWitness.status !== 'ok' ? 'degraded' : 'ok',
            db: true,
            ward_witness: wardWitness,
            service: 'quox-auth',
            version: RESOLVED_VERSION,
            licensing: {
                renewal: renewal.degraded ? 'failing' : 'ok',
                ...(renewal.degraded ? { failing: renewal.failing } : {})
            },
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(503).json({
            status: 'error',
            db: false,
            error: err.message
        });
    }
});

// Apply rate limiting to API routes (exempt high-frequency session endpoints).
// Session endpoints (login/refresh/logout) have their own dedicated limiters
// at the route level — they must not share the global IP bucket, otherwise
// background pollers starve login under the same origin.
const RATE_EXEMPT_PATHS = [
    '/api/auth/me',
    '/api/auth/login',
    '/api/auth/refresh',
    '/api/auth/logout',
    '/api/setup/status',
    '/api/csrf-token'
];
app.use('/api', (req, res, next) => {
    if (RATE_EXEMPT_PATHS.includes(req.path)) return next();
    return apiLimiter(req, res, next);
});

// Test Lab Routes (no auth required - must be before routes with auth middleware)
app.use('/api/tests', testsRoutes);

// Setup Routes (no auth required for first-run wizard)
app.use('/api/setup', setupRoutes);

// VAULT-AUDIT P3.B1 (F17) — internal service-key-guarded session-state
// endpoints. Mounted alongside setupRoutes (before any requireAuth router)
// since these are guarded by authorizeInternalServiceRequest, not JWT auth.
app.use('/api/setup', sessionStateRoutes);

// VAULT-AUDIT P4.A-auth — internal service-key-guarded SSH known-hosts TOFU
// + drift-detection endpoints. Same guard/mount pattern as sessionStateRoutes.
app.use('/api/setup', sshKnownHostsRoutes);

// VAULT-AUDIT P3.C — internal service-key-guarded vault_compute TOTP
// endpoint. Same guard/mount pattern as sessionStateRoutes.
app.use('/api/setup', totpRoutes);

// Security Issue #43: Test email endpoint now requires authentication + admin role
// Middleware chain: auth -> admin check -> rate limit -> handler
// EMAIL-UNIFY P2: the SMTP transport is resolved SERVER-SIDE from QuoxVault
// (org override, then the instance credential). It is no longer accepted from
// the request body — a browser posting a host, username and password to send
// mail through was the last place email credentials travelled in the clear,
// and it let any authenticated caller drive the server's mailer at an
// arbitrary host. Any `smtp` field in the body is ignored.
app.post('/api/notifications/test-email', requireAuth, requireAdmin(), emailTestLimiter, async (req, res) => {
    const startTime = Date.now();
    try {
        const { to, from, subject, body } = req.body;
        const { resolveSmtpForOrg } = await import('./utils/emailService.js');
        const { config: smtp, source } = resolveSmtpForOrg(req.user.orgId);

        if (!to || !smtp) {
            logAudit({
                action: AuditActions.NOTIFICATION_TEST_EMAIL,
                actor: { type: 'user', id: req.user.id },
                orgId: req.user.orgId,
                status: 'failure',
                request: req,
                metadata: { reason: to ? 'email_not_configured' : 'missing_recipient', recipient: to }
            });
            return res.status(400).json({
                error: to
                    ? 'Email is not configured. Set it up in Settings -> Email & SMTP.'
                    : 'A recipient is required',
            });
        }

        const transporter = nodemailer.createTransport({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            auth: smtp.auth,
            connectionTimeout: 10000,
            greetingTimeout: 5000,
            socketTimeout: 10000
        });
        await transporter.verify();
        await transporter.sendMail({
            from: from || smtp.from,
            to,
            subject: subject || 'QuoxCore Email Test',
            text: body || 'This is a test email from QuoxCore CoreComms.'
        });

        // Log successful test email
        logAudit({
            action: AuditActions.NOTIFICATION_TEST_EMAIL,
            actor: { type: 'user', id: req.user.id },
            orgId: req.user.orgId,
            status: 'success',
            request: req,
            metadata: {
                recipient: to,
                smtpHost: smtp.host,
                smtpPort: smtp.port,
                smtpSource: source,
                durationMs: Date.now() - startTime
            }
        });

        res.json({ success: true, message: 'Test email sent successfully', source });
    } catch (error) {
        console.error('Email test failed:', error);
        let errorMessage = error.message;
        if (error.code === 'EAUTH') errorMessage = 'Authentication failed. Check username and password.';
        else if (error.code === 'ECONNECTION' || error.code === 'ETIMEDOUT') errorMessage = 'Could not connect to mail server. Check host and port.';
        else if (error.code === 'ESOCKET') errorMessage = 'Connection error. Try toggling the secure/TLS setting.';

        // Log failed attempt
        logAudit({
            action: AuditActions.NOTIFICATION_TEST_EMAIL,
            actor: { type: 'user', id: req.user.id },
            orgId: req.user.orgId,
            status: 'failure',
            request: req,
            metadata: {
                errorCode: error.code,
                errorMessage: error.message,
                recipient: req.body?.to,
                durationMs: Date.now() - startTime
            }
        });

        res.status(500).json({ error: errorMessage });
    }
});

// EMAIL-UNIFY P2: transport resolved server-side from QuoxVault. See the note
// on /test-email above — a client-supplied `smtp` block is ignored.
app.post('/api/notifications/send-email', requireAuth, sendEmailLimiter, async (req, res) => {
    try {
        // QUOXTRUST S2 (FND_01M3CJJQSWWJN76YV35DWJN76Y): this route was requireAuth-only with
        // no rate limit, a caller-supplied `from`, and an unbounded `to` — an authenticated
        // open mail relay over the org SMTP identity. Containment: rate limiter (above),
        // recipient bounding (below), and the sender forced to the resolved org identity.
        // requireAuth is retained deliberately so the legitimate per-user alert path keeps
        // working (alertService -> coreCommsService.sendEmail); admin-gating it would break
        // notification emails for non-admin users. Full per-org recipient authorization is
        // the S3 reference-monitor's job.
        const { to, subject, body, html } = req.body;
        if (!to || !subject) {
            return res.status(400).json({ error: 'Recipient and subject are required' });
        }
        const rcpt = sanitizeRecipients(to);
        if (!rcpt.ok) {
            return res.status(400).json({ error: rcpt.error });
        }
        const { resolveSmtpForOrg } = await import('./utils/emailService.js');
        const { config: smtp } = resolveSmtpForOrg(req.user.orgId);
        if (!smtp) {
            return res.status(400).json({ error: 'Email is not configured. Set it up in Settings -> Email & SMTP.' });
        }
        const transporter = nodemailer.createTransport({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            auth: smtp.auth,
            connectionTimeout: 10000,
            greetingTimeout: 5000,
            socketTimeout: 10000
        });
        // Sender is the resolved org SMTP identity, never the caller's `from` (anti-spoof).
        await transporter.sendMail({ from: smtp.from, to: rcpt.recipients.join(', '), subject, text: body, html });
        console.info(`[send-email] org=${req.user.orgId} user=${req.user.id} recipients=${rcpt.recipients.length}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Email send failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// API info (must be before routes with auth middleware)
app.get('/api', (req, res) => {
    res.json({
        service: 'Quox Auth Service',
        version: '1.2.0',
        endpoints: {
            csrfToken: '/api/csrf-token',  // Security Issue #44: CSRF token endpoint
            auth: '/api/auth',
            orgs: '/api/orgs',
            invites: '/api/invites',
            mfa: '/api/mfa',
            admin: '/api/admin',
            // Phase B
            divisions: '/api/orgs/:orgId/divisions',
            departments: '/api/orgs/:orgId/divisions/:divId/departments',
            teams: '/api/orgs/:orgId/teams',
            scopes: '/api/orgs/:orgId/scopes',
            // Phase C (HITL)
            runs: '/api/orgs/:orgId/runs',
            inbox: '/api/orgs/:orgId/inbox',
            routingRules: '/api/orgs/:orgId/routing-rules',
            notifications: '/api/users/me/notification-channels',
            integrations: '/api/orgs/:orgId/integrations',
            // Tool Library (B2)
            toolCatalog: '/api/tools/catalog',
            toolInstallations: '/api/orgs/:orgId/tool-library',
            agents: '/api/orgs/:orgId/agents',
            agentTools: '/api/orgs/:orgId/agents/:agentDbId/tools',
            // Phase 3: Agent Tool Execution
            agentToolExecution: '/api/orgs/:orgId/agent-tools/execute',
            // Scoped Action Tracker
            actions: '/api/orgs/:orgId/actions'
        },
        docs: 'https://docs.quox.door.black/api/auth'
    });
});

// Internal service-to-service endpoints (no auth, no CSRF — Docker internal only)
// Must be mounted BEFORE other route handlers that apply requireAuth
// Any /api/* mount with router.use(requireAuth) will catch /api/internal/* requests
// because they share the /api/ prefix. Put ALL internal routers here.
app.get('/api/internal/orgs/:orgId/github/mappings', (await import('./routes/github-mappings.js')).internalGithubMappingsHandler);
// QUOXMIND #1111: agent identities of an org (service key), for memory recall scoping.
app.get('/api/internal/orgs/:orgId/agent-users', (await import('./routes/agent-users-internal.js')).internalOrgAgentUsersHandler);
// quox#1197: one org's members for security_user_audit (service key; MFA flag, never the secret).
app.get('/api/internal/orgs/:orgId/user-audit', (await import('./routes/user-audit-internal.js')).internalOrgUserAuditHandler);
app.use('/api/internal', (await import('./routes/inbox.js')).internalRouter);
app.use('/api/internal', consentInternalRoutes);
app.use('/api/internal', widgetsInternalRouter);
app.use('/api/internal', widgetConnectorsInternalRouter);
app.use('/api/internal', widgetScenariosInternalRouter);
app.use('/api/internal', fileObjectsInternalRouter);
app.use('/api/internal', teamAssistantsRoutes);
app.use('/api/internal', identityInternalRouter);
app.use('/api/internal/mcp/tokens', mcpTokensInternalRouter);
app.use('/api/internal/plugin-credentials', pluginCredentialsInternalRouter); // SEC-PLUGIN-TRUST C1
app.use('/api/internal/resident-identities', residentIdentityInternalRouter); // #453 phase 15
// POWERS-P2.C-fix-3: tool-definitions snapshot for collector boot-reseed
app.use('/api/internal', (await import('./routes/internal-tool-definitions.js')).default);
// TRUST-GATE-1.23: live-org enumeration for the collector's memory consolidation scheduler
app.use('/api/internal', (await import('./routes/internal-orgs.js')).default);
// QUOXIDENTITY custom-attach fix Part A (#487): single custom-assistant
// accessor (org-scoped) for the collector's agent-attach kit fallback.
app.use('/api/internal', (await import('./routes/internal-assistants.js')).default);
// QUOXPERTICUS P0b (DEC-1): server-side disposable_test instance flag for the
// collector's approval gate (read-only; the flag is human-admin-writable only)
app.use('/api/internal', (await import('./routes/internal-instance.js')).default);
app.use('/api/internal', (await import('./routes/internal-env-projection.js')).default); // SETEC S2
// LICENSE-LAUNCH LL-9i2 (Quox Verified, dep 2): current-lease accessor for the
// WARD quox-verified sink (service-key gated, never a public surface)
app.use('/api/internal', (await import('./routes/internal-current-lease.js')).default);
// VAULT-P6.I: on-demand WARD audit-content reconciliation (FINDING P6-T4)
app.use('/api/internal', (await import('./routes/internal-ward-reconcile.js')).default);
// REPLAY-ONLY .B1a: per-org crystal signing oracle (Ed25519 CSK sign + public-key)
app.use('/api/internal', (await import('./routes/internal-crystal-signing.js')).default);
// DEVSUITE-HUB Phase 2: per-org dev capability profile signing oracle (Ed25519 DCSK sign + public-key)
app.use('/api/internal', (await import('./routes/internal-dev-profile-signing.js')).default);
// TRUST-PROOF slice 4: per-org approval-grant minting oracle for QuoxBastion's
// X-Bastion-Approval-Grant gate (Ed25519 AGSK mint + public-key)
app.use('/api/internal', (await import('./routes/internal-approval-grants.js')).default);
// QLUSTER-4: internal (service-key gated) backups access — summary/list/trigger/download
// for the collector's Qluster backup proxy. MUST mount here, before any bare
// '/api' router that applies requireAuth (same reason as internal-orgs above).
app.use('/api/internal', (await import('./routes/internal-backups.js')).default);
// AGENT-OVERHAUL: internal (service-key gated) tool catalog search for the
// Quartermaster agent's search_catalog tool — CSRF-exempt equivalent of the
// user-facing POST /api/tools/search.
app.use('/api/internal', (await import('./routes/internal-tool-search.js')).default);
// AGENT-OVERHAUL: internal (service-key gated) Action Tracker writes for
// agent-initiated action_add/move/update/delete — CSRF-exempt equivalent of
// the user-facing /api/orgs/:orgId/actions routes, org+user still validated.
app.use('/api/internal', (await import('./routes/internal-actions.js')).default);
// POWERS-VAULT-MIGRATION A.3: internal powers credential listing (service-to-service)
app.use('/api/internal', powersInternalRoutes);
// M-ROOMS: internal provision/deprovision-node endpoint for agentic_team rooms
app.use('/api/internal', (await import('./routes/internal-matrix-provision.js')).default);
// QUOXCHAT-PRO P2: widget-conversation Matrix relay (handoff lookup, room id
// set/get, operator/visitor message persistence, poll read, close+deprovision)
app.use('/api/internal', (await import('./routes/internal-widget-matrix.js')).default);
// QUOXCHAT-PRO Matrix-less handoff: org-authed LogsTab operator-reply route
// (requireAuth + requireOrgMembership per-route, same pattern as widgets.js).
app.use('/api', (await import('./routes/internal-widget-matrix.js')).widgetConversationOrgRouter);
// LLM-CHOICE P1: llm-routing-policies contains a service-key /internal route.
// It MUST mount before the bare '/api' routers that apply router-level
// requireAuth (divisions, departments) — those intercept /api/internal/*
// with a silent 401 otherwise (see feedback_auth_mount_order).
app.use('/api', llmRoutingPolicyRoutes);
// QUOXHAT P1: hat storage + manual selection. Same mount rules as
// llm-routing-policies above (carries a service-key /internal route, so it
// must precede the router-level requireAuth '/api' routers).
app.use('/api', (await import('./routes/quoxhat.js')).default);

// QuoxVault Phase 15: Vault namespace aliasing
// Rewrites /vault/* URLs to /integrations/* so both prefixes work
app.use((req, res, next) => {
    // Decode URL once to prevent double-encoding bypass
    const decoded = decodeURIComponent(req.url);
    // /orgs/:orgId/vault/folders/* → /orgs/:orgId/credential-folders/*
    if (/\/orgs\/[^/]+\/vault\/folders/.test(decoded)) {
        req.url = req.url.replace(/\/vault\/folders/, '/credential-folders');
    }
    // /orgs/:orgId/vault/* → /orgs/:orgId/integrations/*
    else if (/\/orgs\/[^/]+\/vault(\/|$|\?)/.test(decoded)) {
        req.url = req.url.replace(/\/vault/, '/integrations');
    }
    // /internal/vault/* → /internal/integrations/*
    else if (/\/internal\/vault\//.test(decoded)) {
        req.url = req.url.replace('/internal/vault/', '/internal/integrations/');
    }
    next();
});

// Marketplace public routes (no auth — must be mounted BEFORE routers that use router.use(requireAuth))
app.use('/api', sellersRoutes);
app.use('/api', listingsRoutes);
app.use('/api', reviewsRoutes);
app.use('/api', marketplaceRoutes);

// Mount routes
// QUOXON-C2c: one-time dashboard sign-in link (CLI first-run finish). Before the
// /api/auth router so its own guards apply; authLimiter at mount time.
app.use('/api/auth/login-link', authLimiter, loginLinkRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/auth/tokens/mcp', mcpTokensRoutes);  // MCPB-HARDEN-2B: per-user MCP token management
app.use('/api/auth/resident', residentIdentityPublicRouter);  // #453 phase 15: resident agent challenge/response login
app.use('/api/matrix/token', matrixSsoRoutes);  // MATRIX-P4a: Matrix (Synapse) JWT SSO bridge
app.use('/api/orgs', orgsRoutes);
app.use('/api', customRolesRoutes);  // ET-4 Phase B — custom roles (Enterprise tier)
app.use('/api', membersRoutes);      // ET-ENFORCE B — custom role overlay assignment
app.use('/api', orgSecurityRoutes);  // ET-4 Phase C — session/IP/MFA policies (Enterprise tier)
// ET-2B Phase B — SAML factory. Lazy import of the wrapper so tests
// that exercise other routes don't pay for node-saml's startup cost.
app.locals.samlFactory = (providerRow, opts) => {
    // eslint-disable-next-line no-undef
    const modPromise = import('./utils/samlClient.js');
    return modPromise.then(m => m.createSamlClientFromProvider(providerRow, opts));
};

// ET-2 Phase B — SSO callback uses this to install a session cookie.
// Mirrors the issuance path in routes/auth.js::login.
app.locals.issueSession = async (res, { userId, orgId, email, req }) => {
    let orgRole = null;
    if (orgId) {
        const m = queries.getOrgMembership(orgId, userId);
        if (m && m.status === 'active') orgRole = m.role;
        // ET-ENFORCE round-3: SSO callback is a credential-mint path.
        // Apply IP allowlist before issuing the cookie so a token can't
        // be minted from outside the org's allowed network. (MFA is
        // delegated to the IdP on this path.)
        try {
            const { enforceIpAllowlist } = await import('./utils/enforcement.js');
            const ipVerdict = enforceIpAllowlist(getDb(), { orgId, ip: req?.ip });
            if (!ipVerdict.allowed) {
                res.status(403).json({
                    error: 'ip_not_allowed',
                    message: 'Your IP address is not on this organisation’s allowlist.',
                });
                return null;
            }
        } catch (err) {
            console.error('[issueSession] IP allowlist check failed:', err.message);
        }
    }
    const sessionId    = generateId();
    const refreshToken = createRefreshToken({ sub: userId, session_id: sessionId });
    queries.createSession({
        id:                 sessionId,
        user_id:            userId,
        org_id:             orgId || null,
        refresh_token_hash: refreshToken.hash,
        device_fingerprint: req?.headers?.['user-agent']?.slice(0, 100),
        ip_address:         req?.ip,
        user_agent:         req?.headers?.['user-agent']?.slice(0, 500),
        expires_at:         refreshToken.expiresAt,
    });
    const accessToken = createAccessToken({
        sub: userId, email, org_id: orgId || null, role: orgRole,
        session_id: sessionId, mfa_verified: false,
    });
    res.cookie('access_token', accessToken, {
        httpOnly: true, secure: isHttps, sameSite: 'lax', maxAge: 60 * 60 * 1000,
    });
    res.cookie('refresh_token', refreshToken.signed, {
        httpOnly: true, secure: isHttps, sameSite: 'lax',
        path: '/api/auth/refresh', maxAge: 7 * 24 * 60 * 60 * 1000,
    });
};

app.use('/api', ssoRoutes);          // ET-2 Phase A + B — SSO registry (admin) + login/callback (public)
app.use('/api', domainsRoutes);      // ET-3 Phase A — domain verification (Team tier+)
app.use('/api', webhooksRoutes);     // ET-3 Phase B — team_events + webhook subscribers (Enterprise)
app.use('/scim/v2', scimRoutes);     // ET-3 Phase C — SCIM 2.0 (bearer auth, no cookies)
app.use('/api', bulkInviteRoutes);   // ET-3 Phase D — bulk CSV invite (Team tier+)
// ET-ENFORCE G — gate the anonymous /signup-and-accept endpoint with the
// auth rate-limiter at mount time, so the route module itself does not
// have to import the rate-limit middleware (which would pull the SQLite
// store into every test that imports the route).
app.use('/api/invites/:token/signup-and-accept', authLimiter);
app.use('/api', guestInviteRoutes);  // ET-6B — assistant-scoped guest invites (Enterprise)
app.use('/api', secretsRoutes);      // ET-6C — org + scope-bound secrets (Team tier+)
app.use('/api', pluginsRoutes);      // PD-1 — durable plugin install registry (admin-only writes)
app.use('/api/invites', invitesRoutes);
app.use('/api/mfa', mfaRoutes);
// G2d slice 3 — instance-admin, SERVER-WIDE backup/restore lane (a governed
// reach-through to the collector's dev-backup control plane). Mounted on the
// NARROW '/api/admin/backups' subtree, and BEFORE adminRoutes so the subtree
// is unambiguous: admin.js owns everything else under /api/admin and applies
// its own router-level authenticate() + requireInstanceAdmin('readonly') to
// whatever reaches it. Both routers carry their own full guard stack, so
// order here is about clarity, not about one protecting the other. See the
// guard-layer header in routes/admin-backups.js.
app.use('/api/admin/backups', (await import('./routes/admin-backups.js')).default);
app.use('/api/admin/instance', (await import('./routes/admin-instance.js')).default);
app.use('/api/admin', adminRoutes);
// SET-IA Phase 5b: unified provider key view. Auth handled inside.
app.use('/api/keys', keysRoutes);
app.use('/api/uploads', uploadsRoutes);
// Phase B routes (mounted under /api for flat structure)
app.use('/api', divisionsRoutes);
app.use('/api', departmentsRoutes);
app.use('/api', teamsRoutes);
app.use('/api', scopesRoutes);
app.use('/api', sharePoliciesRoutes);
app.use('/api', toolsRoutes);
app.use('/api', tagsRoutes);
app.use('/api', workflowsRoutes);
app.use('/api', assistantsRoutes);
// Note: widgetsInternalRouter is mounted earlier with other /api/internal routers (line ~431)
// so it lands before any /api/* router with requireAuth can intercept it.
app.use('/api', widgetsRoutes);
app.use('/api', widgetConnectorsRoutes);
app.use('/api', widgetScenariosRoutes);
app.use('/api', fileObjectsRoutes);
// Phase C routes (HITL - inboxes, runs, notifications)
app.use('/api', runsRoutes);
app.use('/api/auth', stepUpRoutes); // /api/auth/me/step-up*, nginx routes /api/auth to this service
app.use('/api', inboxRoutes);
app.use('/api', routingRoutes);
// llmRoutingPolicyRoutes mounted earlier (before requireAuth routers) — see LLM-CHOICE P1 note above
app.use('/api', notificationsRoutes);
// QuoxVault Phase 9: Credential Leases (JIT Agent Access)
// MUST mount before integrationsRoutes: its literal `/orgs/:orgId/integrations/leases`
// path is otherwise shadowed by integrations' `GET /orgs/:orgId/integrations/:id`
// param route (:id captures "leases" → 404), leaving the leases list dead-empty.
app.use('/api', leaseRoutes);
// Integrations Vault
app.use('/api', integrationsRoutes);
app.use('/api', integrationsMigrateRoutes);
// QTG-PRO P1: Telegram Pro bots/chats/bindings/user-links (schema + routes
// only: no router-level requireAuth, per-route auth like integrationsRoutes
// above, so its /internal/telegram-pro/bots route is mount-order-safe).
app.use('/api', telegramProRoutes);
// BRAIN2-OAUTH-NOTION — OAuth-connect flow for Brain2's OAuth-connected
// feed sources (Notion). Writes into the same integrations vault above.
app.use('/api', oauthConnectRoutes);
// Tool Library (Phase B2)
app.use('/api', toolCatalogRoutes);
// STUDY-REV-2 / P4.0.A — Install-to-Scope
app.use('/api', toolInstallScopeRoutes);
// STUDY-REV-2 / P4.A — Register from Git Repo
app.use('/api', toolCatalogFromRepoRoutes);
// STUDY-REV-2 / P4.B — Register from Script body
app.use('/api', toolCatalogFromScriptRoutes);
// TOOLSMITH Slice E — Install from Toolsmith draft
app.use('/api', toolCatalogFromToolsmithRoutes);
// Catalog search (Toolsmith concierge + library sidebar)
app.use('/api', toolSearchRoutes);
// POWERS — MCP endpoint deploy + detect
app.use('/api', powersRoutes);
// Enterprise Entity Model - Agent Management
app.use('/api', agentsRoutes);
// REG-3: Model Registry (Universal Asset Registry)
app.use('/api/models', modelsRoutes);
// Phase D routes (Backup, Restore, Migration)
app.use('/api', backupsRoutes);
app.use('/api', updatesRoutes);
// Privacy/Consent routes (Security Issue #72 - AI data consent)
app.use('/api/consent', consentRoutes);
// Data Retention routes (Security Issue #73)
app.use('/api', retentionRoutes);
// LICENSE-LAUNCH LL-9i3 — Quox Verified enablement admin config (no-env-only-config)
app.use('/api', quoxVerifiedConfigRoutes);
// Bastion Approval routes (HITL for command execution)
app.use('/api', bastionApprovalsRoutes);
// Messages & Conversations (Phase 1 - audit trail)
app.use('/api', messagesRoutes);
// Phase 3: Agent Tool Execution
app.use('/api', agentToolsRoutes);
// Phase D5: Scope-Channel Assignments + Delivery Analytics
app.use('/api', scopeChannelsRoutes);
// Scoped Action Tracker
app.use('/api', actionRoutes);
// QuoxVault Phase 9 leaseRoutes mounted earlier (before integrationsRoutes) — see shadowing note above
// QuoxVault Phase 14: Agent Credential Assignments
app.use('/api', agentCredentialRoutes);
// QUOXIDENTITY P1 (#487): attach a live session to a registry agent identity
app.use('/api/agent-attach', agentAttachRoutes);
// GitHub Org Mappings (Phase R2)
app.use('/api', githubMappingsRoutes);
// QN Phase 1: RepoBrain connection registry
app.use('/api', repobrainConnectionsRoutes);
app.use('/api', userLibraryRoutes);
// STUDY-REV-2 / P7.E.1 — User-owned Prompts Library
app.use('/api', promptsRoutes);
// TOOLSMITH Slice B — tool draft persistence (user JWT auth)
app.use('/api/toolsmith', toolDraftsRoutes);
// Internal endpoints (service-to-service, X-Service-Key auth)
app.use('/internal', agentsInternalRoutes);
// BLAST-RADIUS-P0: agent-credential-assignments passthrough for the
// collector's reach resolver (agent-credentials.js's public route is
// user-JWT gated, which a server-side caller cannot present).
app.use('/internal', agentCredentialInternalRoutes);
// Note: teamAssistantsRoutes is mounted earlier with other /api/internal routers (line ~431)
// so it lands before any /api/* router with requireAuth can intercept it.

// CLI-PARITY WP1.1: runtime route-introspection helper for GET /__routes.
// Loaded fail-safe via a guarded dynamic import — a static top-level
// `import` of a missing file is a hard boot failure in ESM (unlike
// require(), it can't be wrapped in try/catch at the import site), so any
// Dockerfile/path drift between this file's on-disk layout and the built
// image would crash-loop the whole auth service. Degrades to an empty
// route list instead. services/shared is COPY'd to /app/services/shared
// (see Dockerfile — this service's build context is repo-root).
let __listRoutes = () => [];
for (const candidate of ['../shared/routeIntrospection.cjs', './shared/routeIntrospection.cjs']) {
    try {
        ({ listRoutes: __listRoutes } = await import(candidate));
        break;
    } catch (err) {
        console.warn(`[ROUTE_INTROSPECTION] Failed to load ${candidate}:`, err.message);
    }
}

// CLI-PARITY WP1.1: GET /__routes — fully-resolved route table for the CLI's
// live-vs-static endpoint diff. Mounted last (after every app.use/route
// above, before the 404 handler) so listRoutes(app) reflects every router
// actually attached to this app instance.
// Auth: X-Service-Key (INTERNAL_SERVICE_KEY), same timing-safe pattern used
// by routes/internal-orgs.js and routes/internal-tool-definitions.js.
app.get('/__routes', (req, res) => {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying /__routes request');
        return res.status(401).json({ error: 'Service key not configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (!serviceKey || !safeCompare(serviceKey, expectedKey)) {
        return res.status(401).json({ error: 'Unauthorized: invalid service key' });
    }
    res.json({ service: 'auth', routes: __listRoutes(app) });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'not_found',
        message: `Route ${req.method} ${req.path} not found`
    });
});

// CORS error handler — return 403 instead of 500 (#186)
app.use((err, req, res, next) => {
    if (err.message === 'Not allowed by CORS') {
        console.warn(`[CORS] Rejected origin: ${req.headers.origin} for ${req.method} ${req.path}`);
        return res.status(403).json({
            error: 'cors_rejected',
            message: 'Origin not allowed by CORS policy'
        });
    }
    next(err);
});

// JSON parse error handler — return 400 instead of 500 (#185)
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400)) {
        return res.status(400).json({
            error: 'invalid_json',
            message: 'Request body contains invalid JSON'
        });
    }
    next(err);
});

// Generic error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);

    // #49 S4: honour an explicit err.statusCode (e.g. validation throws with
    // {statusCode:400}) instead of masking every thrown error as a 500.
    const status = Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode < 600
        ? err.statusCode
        : 500;

    // Client errors (4xx) and explicitly-exposed errors may surface their
    // message; 5xx internals stay masked in production.
    const message = (status < 500 || err?.expose)
        ? (err?.message || 'Error')
        : (process.env.NODE_ENV === 'production' ? 'Internal server error' : err?.message);

    res.status(status).json({
        error: err?.code || (status < 500 ? 'bad_request' : 'internal_error'),
        message
    });
});

// Validate security configuration
// This will throw in production if JWT_SECRET is not properly configured
try {
    validateJwtSecurity();
} catch (err) {
    console.error(err.message);
    process.exit(1);
}

// QuoxVault F6: boot-time master-key validation.
// utils/encryption.js (getMasterKey) already validates MASTER_ENCRYPTION_KEY, but
// only lazily — the first time something is encrypted/decrypted, which can happen
// well after startup (e.g. first credential read). In production we want a hard,
// loud failure at boot instead of a mid-request crypto error. Skipped under the
// test harness (NODE_ENV==='test') since tests set their own per-run keys; dev
// behavior (lazy validation on first crypto call) is unchanged.
if (process.env.NODE_ENV === 'production') {
    const masterKeyCheck = validateMasterKey(process.env.MASTER_ENCRYPTION_KEY);
    if (!masterKeyCheck.valid) {
        console.error(`[SECURITY] MASTER_ENCRYPTION_KEY invalid at boot: ${masterKeyCheck.message}. Refusing to start in production.`);
        process.exit(1);
    }
}

// D3: Reject boot in production if POWERS test-bypass flags are set to true.
// These flags short-circuit real collector sync and build kickoff — dangerous in prod.
// (Sibling to feedback_test_env_flags_in_prod.md)
if (process.env.NODE_ENV === 'production') {
    for (const flag of ['POWERS_SKIP_BUILD_KICKOFF', 'POWERS_SKIP_COLLECTOR_SYNC']) {
        if (process.env[flag] === 'true') {
            console.error('[SECURITY] %s=true in production — refusing to boot', flag);
            process.exit(1);
        }
    }
}

// Initialize database
console.log('Initializing database...');
getDb();

// Log security warnings (non-fatal in development)
logSecurityWarnings();

// Start rate limit cleanup
startCleanup();

// Start data retention scheduled cleanup (Security Issue #73)
startScheduledCleanup();

// ET-3 Phase B follow-up — webhook retry worker. Polls every 60s and
// re-delivers failed webhook rows whose next_retry_at has arrived.
// Disabled in test harness (no real-time loop needed).
const webhookRetryHandle = (process.env.NODE_ENV === 'test')
    ? null
    : startRetryWorker(getDb(), { intervalMs: 60_000 });

// Ingest bootstrap restore audit log (written by setup wizard before DB replacement)
try {
    const { dirname, join } = await import('path');
    const { readFileSync, unlinkSync, existsSync } = await import('fs');
    const dataDir = process.env.AUTH_DB_PATH
        ? dirname(process.env.AUTH_DB_PATH)
        : '/var/lib/quox';
    const auditPath = join(dataDir, 'bootstrap-restore-audit.json');
    if (existsSync(auditPath)) {
        const entries = JSON.parse(readFileSync(auditPath, 'utf-8'));
        const db = getDb();
        const insert = db.prepare(`
            INSERT OR IGNORE INTO backup_audit_log (id, org_id, operation, defcon_level, operator, result, duration_ms, metadata_json, created_at)
            VALUES (?, NULL, ?, 'AMBER', 'system', ?, ?, ?, ?)
        `);
        let ingested = 0;
        for (const entry of (Array.isArray(entries) ? entries : [entries])) {
            const id = `bootstrap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const operation = entry.event === 'BOOTSTRAP_RESTORE_FAILED' ? 'RESTORE_FAILED' : 'RESTORE_COMPLETED';
            const result = entry.event === 'BOOTSTRAP_RESTORE_FAILED' ? 'failed' : 'success';
            const metadata = JSON.stringify({
                source: 'bootstrap-restore',
                archive: entry.archive,
                restored: entry.restored,
                skipped: entry.skipped,
                restoreLog: entry.restoreLog,
                userCount: entry.userCount,
                error: entry.error
            });
            insert.run(id, operation, result, entry.duration_ms || null, metadata, entry.timestamp);
            ingested++;
        }
        unlinkSync(auditPath);
        console.log(`[Startup] Ingested ${ingested} bootstrap restore audit entries into backup_audit_log`);
    }
} catch (err) {
    console.warn('[Startup] Bootstrap audit ingestion failed (non-fatal):', err.message);
}

// Start backup scheduler daemon (Issue #190)
// quox#1205: verify runs in-process, so any 'verifying' row at boot is orphaned. Restore its
// status from the stored verification result before the scheduler starts.
try {
    for (const id of reconcileInterruptedVerifies(getDb(), { staleAfterMs: 0 })) {
        console.log(`[Startup] Reconciled interrupted backup verify ${id}`);
    }
} catch (err) {
    console.error('[Startup] Backup verify reconcile failed (non-fatal):', err.message);
}
startBackupScheduler();

// BACKUP #727: re-attach to detached backup containers that outlived the
// previous auth process (and reap orphans). Fire-and-forget: never blocks boot.
startBackupAdoption({ finalizeRoute: finalizeBackupRun, finalizeScheduled: finalizeScheduledRun })
    .catch((err) => console.error('[Startup] Backup adoption failed (non-fatal):', err.message));

// Start service health scheduler daemon (TRUST-GATE-AUDIT follow-up)
startServiceHealthScheduler();

// Migrate instance_config AI keys to vault (QuoxVault Phase 12)
try {
    migrateInstanceConfigToVault();
} catch (err) {
    console.error('[VaultMigration] Migration failed (non-fatal):', err.message);
}

// Migrate the instance SMTP config into the vault (EMAIL-UNIFY P2), so
// QuoxVault is the single source of truth for email credentials. Idempotent;
// defers to the next boot on an install that has no users yet.
try {
    migrateInstanceSmtpToVault();
} catch (err) {
    console.error('[VaultMigration] Instance SMTP migration failed (non-fatal):', err.message);
}

// QUOXCHAT-EMAIL D4 — allow-list email_transcript on widgets whose recorded
// intent is "tool active" but which never made a tool_policies decision.
// Repairs the two-switch defect that shipped the marketed transcript action
// silently dead on every widget. Idempotent; never touches a widget with
// any tool_policies present.
try {
    const bf = backfillDefaultToolPolicies();
    if (bf.updated > 0) console.log(`[WidgetPolicies] Allow-listed email_transcript on ${bf.updated} widget(s) with no prior tool_policies`);
    const sf = backfillEmailTranscriptSchema();
    if (sf.updated > 0) console.log(`[WidgetPolicies] email_transcript schema updated on ${sf.updated} widget tool row(s)`);
    const lf = backfillLeadCaptureSchema();
    if (lf.updated > 0) console.log(`[WidgetPolicies] lead_capture schema (email or phone) updated on ${lf.updated} widget tool row(s)`);
} catch (err) {
    console.error('[WidgetPolicies] tool_policies backfill failed (non-fatal):', err.message);
}

// Seed the built-in agent roster if this install has none. Nothing ever ran
// scripts/seed-core-agents.js on a fresh install, so the agents table was empty
// on any new instance and every surface built on the roster (including the iOS
// chat picker) was empty out of the box. Idempotent, and a no-op once seeded.
seedCoreAgentsIfEmpty().catch((err) => {
    console.error('[CoreAgents] Roster seed failed (non-fatal):', err.message);
});

// quox#1045: seed the global tool catalog from the shipped manifests. Nothing
// ran scripts/seed-tools.js on a fresh install, so the catalog was empty and no
// tool could be installed or assigned. Insert-if-missing on every boot (so
// upgrades get new manifests), never overwrites an edited row. Non-fatal.
seedToolCatalogOnBoot();

// First-party plugin auto-provisioning is scheduled AFTER app.listen() (see the
// listen callback below), NOT here. LL-7: running it synchronously before listen
// looped every org × every bundle in one tick (≈3240 iterations at 135 orgs × 24
// bundles), froze the event loop for ~210s, and starved the HTTP listener so
// /health returned 000 and a real orchestrator crash-looped the container. It now
// runs in the background, chunked and yielding, once the server is answering.

// Start credential health scanner (QuoxVault Phase 5)
startPeriodicScan();

// Start lease expiry background job (QuoxVault Phase 9)
startLeaseExpiryJob();

// Start powers deprecation TTL cleanup (LIFECYCLE-P1-D3)
startDeprecationTtlJob();

// Start audit event reaper (LIFECYCLE-P3-D4 — durable retry for B1 secret.access events)
startAuditEventReaper();
// #1078: retry auth audit witnesses the collector did not accept yet.
startWardWitnessSweep();

// HITL-VOLT-WITNESS (QuoxPlan #2202) — durable retry for approval decision
// VOLT witness events that failed to reach the collector on first attempt.
startVoltWitnessReaper();

// LAUNCH-SPINE: fire HITL SLA escalation stages when they come due. Stages were
// already being written with a scheduled_at at item-creation time; nothing ever
// fired them, so a configured SLA sat in the database and did nothing.
// auto_approve stays blocked unless HITL_SLA_ALLOW_AUTO_APPROVE=true.
configureSlaEscalation({
    getDb,
    notifier: (orgId, item) => { routeAndNotify(orgId, item); },
});
startSlaEscalation();

// Start session-state prune job (VAULT-AUDIT P3.C F-4 — sweeps expired
// credential_session_state ciphertext rows every 6h)
startSessionStatePruneJob();

// LICENSE-ENFORCE LE-2: server-side instance identity (qi_<uuid>, survives
// restarts via instance_config on the mounted data volume) + Ed25519 license
// lease renewal daemon (boot run + every 6h). ensureInstanceId is always
// safe to run (pure DB write, no network); the renewal daemon itself makes
// real outbound calls to quox.ai, so it is skipped under the test harness
// same as the webhookRetryHandle above.
ensureInstanceId(getDb());
if (process.env.NODE_ENV !== 'test') {
    startLicenseRenewalJob();
}

// Start server
const server = app.listen(PORT, HOST, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║           QuoxCORE AUTH SERVICE STARTED                ║
╠═══════════════════════════════════════════════════════╣
║  Port: ${PORT}                                           ║
║  Host: ${HOST}                                       ║
║  Env:  ${process.env.NODE_ENV || 'development'}                                  ║
╚═══════════════════════════════════════════════════════╝

Endpoints:
  GET    /api/csrf-token             Get CSRF token
  POST   /api/auth/signup            Create account
  POST   /api/auth/login             Login
  POST   /api/auth/logout            Logout
  POST   /api/auth/refresh           Refresh token
  POST   /api/auth/verify-email      Verify email
  POST   /api/auth/forgot-password   Request password reset
  POST   /api/auth/reset-password    Complete password reset
  GET    /api/auth/me                Get current user

  POST   /api/orgs                   Create organization
  GET    /api/orgs                   List organizations
  GET    /api/orgs/:id               Get organization
  PATCH  /api/orgs/:id               Update organization
  GET    /api/orgs/:id/members       List members
  POST   /api/orgs/:id/members       Invite member
  PATCH  /api/orgs/:id/members/:uid  Update member role
  DELETE /api/orgs/:id/members/:uid  Remove member

  GET    /api/invites/:token         Get invite details
  POST   /api/invites/:token/accept  Accept invite
  POST   /api/invites/:token/decline Decline invite

  POST   /api/mfa/setup              Start MFA setup
  POST   /api/mfa/verify-setup       Complete MFA setup
  POST   /api/mfa/verify             Verify MFA code
  POST   /api/mfa/disable            Disable MFA
  GET    /api/mfa/backup-codes       Get backup code count
  POST   /api/mfa/regenerate-backup-codes  Generate new codes

  GET    /api/admin/config           Get instance config
  PATCH  /api/admin/config/:key      Update config value
  GET    /api/admin/admins           List instance admins
  POST   /api/admin/admins           Grant admin role
  DELETE /api/admin/admins/:userId   Revoke admin role
  GET    /api/admin/keys             List API keys
  POST   /api/admin/keys             Create API key
  GET    /api/admin/services         List services
  GET    /api/admin/logs             Query system logs
  GET    /api/admin/stats            Dashboard stats

  GET    /health                     Health check
`);

    // LL-7: first-party provisioning runs in the BACKGROUND, only after the
    // server is listening and /health is answerable. scheduleFirstPartyProvisioning
    // returns immediately (defers via setImmediate) and yields between chunks of
    // orgs, so it never blocks the event loop. Non-fatal, idempotent, skipped
    // under test, disableable via env.
    if (process.env.NODE_ENV !== 'test' && process.env.FIRST_PARTY_PLUGINS !== 'off') {
        import('./utils/firstPartyProvision.js')
            .then(({ scheduleFirstPartyProvisioning }) => {
                scheduleFirstPartyProvisioning(getDb());
            })
            .catch((err) => {
                console.error('[FirstParty] provisioning failed to schedule (non-fatal):', err.message);
            });
    }
});

// Graceful shutdown
const shutdown = (signal) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);

    server.close(() => {
        console.log('HTTP server closed');

        stopCleanup();
        stopScheduledCleanup();
        stopBackupScheduler();
        stopServiceHealthScheduler();
        stopPeriodicScan();
        stopLeaseExpiryJob();
        stopAuditEventReaper();
        stopVoltWitnessReaper();
        stopSlaEscalation();
        stopSessionStatePruneJob();
        stopLicenseRenewalJob();
        if (webhookRetryHandle) webhookRetryHandle.stop();
        closeDb();

        console.log('Cleanup complete. Exiting.');
        process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
        console.error('Forced exit after timeout');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
