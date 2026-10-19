/**
 * Setup Routes - First-run configuration wizard API
 *
 * These endpoints handle the initial setup of QuoxCORE:
 * - Check if setup is complete
 * - Create the first admin user
 * - Save API keys and configuration
 * - Dev mode auto-login
 */

import { hostPath } from '../utils/hostPaths.js';
import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { dirname, join, basename } from 'path';
import multer from 'multer';
import { networkInterfaces } from 'os';
import { randomBytes, createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import { getDb } from '../db/index.js';
import { bootstrapOrgScaffolding } from '../utils/orgScaffolding.js';
import {
    generateId,
    hashPassword,
    verifyPassword,
    createAccessToken,
    createRefreshToken,
    sha256
} from '../utils/crypto.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { logAudit, AuditActions } from '../utils/audit.js';
import { validatePassword } from '../utils/passwordValidation.js';
import { authLimiter, apiLimiter } from '../middleware/rateLimit.js';
import { createCredential, getDefaultCredential, getDecryptedCredential, updateCredential } from '../db/integrations.js';
import { authorizeInternalServiceRequest } from '../utils/internalServiceAuth.js';
import { authenticate } from '../middleware/authenticate.js';
import { getSetupReadiness } from '../utils/setupReadiness.js';
import { writeCredentialReleaseAudit, writeLeaseAccessAudit, writeCredentialUpdateAudit } from '../lib/credentialReleaseAudit.js';
import { evaluateLeaseGate } from '../lib/leaseGate.js';
import { readInstanceConfigBoolean } from '../lib/instanceConfigOverrides.js';
import { validateUrlScheme } from '../utils/urlValidation.js';
import {
    MAX_BREAK_GLASS_MS,
    createBreakGlass,
    clearBreakGlass,
    listBreakGlass,
    enforcementStatus,
} from '../lib/breakGlass.js';

const execAsync = promisify(exec);

// n8n sync removed — voice keys are now served directly by collector

/**
 * Middleware: reject requests if setup is already complete.
 * Protects config/SSL/OAuth endpoints from post-setup abuse.
 */
function requireSetupIncomplete(req, res, next) {
    try {
        const db = getDb();
        const config = db.prepare(
            `SELECT value FROM instance_config WHERE key = 'instance.setup_complete'`
        ).get();
        if (config?.value === 'true') {
            return res.status(403).json({
                error: 'setup_complete',
                message: 'Setup is already complete. Use the admin panel to change configuration.'
            });
        }
    } catch {
        // Table doesn't exist yet — setup is definitely not complete
    }
    next();
}

function allowDuringSetupOtherwiseRequireAuth(req, res, next) {
    try {
        const db = getDb();
        const config = db.prepare(
            `SELECT value FROM instance_config WHERE key = 'instance.setup_complete'`
        ).get();
        if (config?.value === 'true') {
            return authenticate({ required: true })(req, res, next);
        }
    } catch {
        // Table doesn't exist yet — anonymous setup flow is allowed
    }
    return next();
}

/**
 * Validate an IPv4 address string. Rejects newlines, brackets, and non-IP chars.
 */
function isValidIpv4(ip) {
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

const router = Router();

// Dev user constants
const DEV_USER_EMAIL = 'dev@quox.local';
const DEV_USER_ID = '01DEV000000000000000000001';
const DEV_ORG_ID = '01DEV000000000000000000002';

/**
 * GET /api/setup/status
 * Check if initial setup is complete
 */
router.get('/status', async (req, res) => {
    try {
        const db = getDb();

        // Check if any admin exists in instance_admins table
        let adminExists = { count: 0 };
        try {
            adminExists = db.prepare(`
                SELECT COUNT(*) as count FROM instance_admins WHERE revoked_at IS NULL
            `).get();
        } catch (e) {
            // Table might not exist yet - migrations will create it
            console.log('[Setup] instance_admins table not found, will be created by migrations');
        }

        // Check if setup config exists
        let configComplete = false;
        try {
            const config = db.prepare(`
                SELECT value FROM instance_config WHERE key = 'instance.setup_complete'
            `).get();
            configComplete = config?.value === 'true';
        } catch (e) {
            // Table might not exist yet
        }

        // If an admin exists but config was never saved (user skipped optional steps),
        // auto-complete setup so they don't get stuck in a redirect loop
        if (adminExists.count > 0 && !configComplete) {
            try {
                const setConfig = db.prepare(`INSERT OR REPLACE INTO instance_config (key, value) VALUES (?, ?)`);
                setConfig.run('instance.setup_complete', 'true');
                setConfig.run('setup_completed_at', new Date().toISOString());
                configComplete = true;
                console.log('[Setup] Auto-completed setup — admin exists, config step was skipped');
            } catch (e) {
                console.warn('[Setup] Failed to auto-complete setup:', e.message);
            }
        }

        const isComplete = adminExists.count > 0 && configComplete;
        const readiness = await getSetupReadiness();

        res.json({
            complete: isComplete,
            hasAdmin: adminExists.count > 0,
            configComplete,
            readiness,
            steps: {
                admin: adminExists.count > 0,
                apiKeys: configComplete,
                infrastructure: configComplete
            }
        });
    } catch (err) {
        console.error('Setup status check failed:', err);
        res.status(500).json({
            error: 'setup_check_failed',
            message: 'Internal error checking setup status'
        });
    }
});

/**
 * POST /api/setup/admin
 * Create the first admin user
 */
router.post('/admin', authLimiter, async (req, res) => {
    try {
        const db = getDb();

        // Check if admin already exists
        let adminExists = { count: 0 };
        try {
            adminExists = db.prepare(`
                SELECT COUNT(*) as count FROM instance_admins WHERE revoked_at IS NULL
            `).get();
        } catch (e) {
            // Table might not exist - that's ok, we'll create the user anyway
        }

        if (adminExists.count > 0) {
            return res.status(400).json({
                error: 'admin_exists',
                message: 'An admin user already exists. Use the login page instead.'
            });
        }

        const { email, password, name } = req.body;

        // Validation
        if (!email || !password) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Email and password are required'
            });
        }

        const passwordValidation = validatePassword(password);
        if (!passwordValidation.valid) {
            return res.status(400).json({
                error: 'validation_error',
                message: passwordValidation.message,
                errors: passwordValidation.errors
            });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Invalid email format'
            });
        }

        // Hash password
        const passwordHash = await hashPassword(password);

        // Create user with correct schema
        const userId = generateId();
        const emailId = generateId();
        const authId = generateId();
        const orgId = generateId();
        const membershipId = generateId();
        const adminId = generateId();

        // Use transaction for atomicity
        const createAdmin = db.transaction(() => {
            // Create user in users table
            db.prepare(`
                INSERT INTO users (id, primary_email, display_name, status)
                VALUES (?, ?, ?, 'active')
            `).run(userId, email.toLowerCase(), name || 'Admin');

            // Create email record
            db.prepare(`
                INSERT INTO user_emails (id, user_id, email, is_primary, verified_at)
                VALUES (?, ?, ?, 1, datetime('now'))
            `).run(emailId, userId, email.toLowerCase());

            // Create password identity
            db.prepare(`
                INSERT INTO auth_identities (id, user_id, provider, password_hash)
                VALUES (?, ?, 'password', ?)
            `).run(authId, userId, passwordHash);

            // Create default organization
            db.prepare(`
                INSERT INTO orgs (id, name, slug, owner_user_id)
                VALUES (?, ?, ?, ?)
            `).run(orgId, 'Default Organization', 'default', userId);

            // Add user to organization as owner
            db.prepare(`
                INSERT INTO org_memberships (id, org_id, user_id, role, status)
                VALUES (?, ?, ?, 'owner', 'active')
            `).run(membershipId, orgId, userId);

            // Add user as instance admin (superadmin)
            db.prepare(`
                INSERT INTO instance_admins (id, user_id, role, granted_at)
                VALUES (?, ?, 'superadmin', datetime('now'))
            `).run(adminId, userId);

            // An orgs row on its own is not a usable organisation. Without the
            // scope tree, every division created later gets no scope row,
            // departments fail 500 "Division scope not found", and no scope
            // assistant is ever created, so the agent picker is empty. This
            // path used to skip all of it while routes/orgs.js did not, which
            // meant a fresh install was quietly broken from the first boot.
            bootstrapOrgScaffolding({
                orgId,
                orgName: 'Default Organization',
                userId
            });
        });

        createAdmin();

        console.log(`[Setup] Created admin user ${email} and default organization`);

        res.json({
            success: true,
            userId,
            orgId,
            message: 'Admin user created successfully'
        });
    } catch (err) {
        console.error('Admin creation failed:', err);

        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message?.includes('UNIQUE')) {
            return res.status(400).json({
                error: 'email_exists',
                message: 'This email is already registered'
            });
        }

        res.status(500).json({
            error: 'admin_creation_failed',
            message: err.message
        });
    }
});

/**
 * POST /api/setup/dev-login
 * Auto-login for development mode - creates or logs in dev user
 */
router.post('/dev-login', authLimiter, async (req, res) => {
    try {
        // SECURITY: Completely disable in production environments
        if (process.env.NODE_ENV === 'production') {
            return res.status(404).json({
                error: 'not_found',
                message: 'Endpoint not found'
            });
        }

        // SECURITY: Require explicit opt-in via environment variable
        if (process.env.DEV_LOGIN_ENABLED !== 'true') {
            return res.status(404).json({
                error: 'not_found',
                message: 'Endpoint not found'
            });
        }

        // SECURITY: Validate request origin using connection info, not headers
        // X-Forwarded-For and Host headers can be spoofed by attackers
        const remoteAddress = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
        const isLocalConnection = remoteAddress === '127.0.0.1' ||
                                  remoteAddress === '::1' ||
                                  remoteAddress === '::ffff:127.0.0.1';

        if (!isLocalConnection) {
            console.warn(`[Setup] Dev login attempt from non-local address: ${remoteAddress}`);
            return res.status(403).json({
                error: 'forbidden',
                message: 'Dev login only available from localhost'
            });
        }

        const db = getDb();

        // Check if dev user exists
        let devUser = db.prepare(`
            SELECT * FROM users WHERE primary_email = ?
        `).get(DEV_USER_EMAIL);

        if (!devUser) {
            console.log('[Setup] Creating dev user for first time...');

            // Create dev user
            const emailId = generateId();
            const authId = generateId();
            const membershipId = generateId();

            // SECURITY: Generate random password for dev user instead of hardcoded value
            const devPassword = require('crypto').randomBytes(32).toString('hex');
            const passwordHash = await hashPassword(devPassword);

            const createDevUser = db.transaction(() => {
                // Create user
                db.prepare(`
                    INSERT INTO users (id, primary_email, display_name, status)
                    VALUES (?, ?, 'Development User', 'active')
                `).run(DEV_USER_ID, DEV_USER_EMAIL);

                // Create email record
                db.prepare(`
                    INSERT INTO user_emails (id, user_id, email, is_primary, verified_at)
                    VALUES (?, ?, ?, 1, datetime('now'))
                `).run(emailId, DEV_USER_ID, DEV_USER_EMAIL);

                // Create password identity
                db.prepare(`
                    INSERT INTO auth_identities (id, user_id, provider, password_hash)
                    VALUES (?, ?, 'password', ?)
                `).run(authId, DEV_USER_ID, passwordHash);

                // Check if dev org exists, create if not
                const devOrg = db.prepare(`SELECT id FROM orgs WHERE id = ?`).get(DEV_ORG_ID);
                if (!devOrg) {
                    db.prepare(`
                        INSERT INTO orgs (id, name, slug, owner_user_id)
                        VALUES (?, 'Development Org', 'dev', ?)
                    `).run(DEV_ORG_ID, DEV_USER_ID);
                }

                // Add user to dev org as owner
                db.prepare(`
                    INSERT OR IGNORE INTO org_memberships (id, org_id, user_id, role, status)
                    VALUES (?, ?, ?, 'owner', 'active')
                `).run(membershipId, DEV_ORG_ID, DEV_USER_ID);

                // Same scaffolding as the real bootstrap above: a dev org with
                // no scope tree reproduces the identical silent breakage.
                bootstrapOrgScaffolding({
                    orgId: DEV_ORG_ID,
                    orgName: 'Development Org',
                    userId: DEV_USER_ID
                });
            });

            createDevUser();

            devUser = db.prepare(`
                SELECT * FROM users WHERE id = ?
            `).get(DEV_USER_ID);

            console.log('[Setup] Dev user created successfully');
        }

        // Get user's org membership
        const membership = db.prepare(`
            SELECT om.*, o.name as org_name, o.slug as org_slug
            FROM org_memberships om
            JOIN orgs o ON om.org_id = o.id
            WHERE om.user_id = ? AND om.status = 'active' AND o.deleted_at IS NULL
            LIMIT 1
        `).get(devUser.id);

        // Create session
        const sessionId = generateId();
        const refreshToken = createRefreshToken({
            sub: devUser.id,
            session_id: sessionId
        });
        const accessToken = createAccessToken({
            sub: devUser.id,
            email: devUser.primary_email,
            org_id: membership?.org_id || DEV_ORG_ID,
            role: membership?.role || 'owner',
            session_id: sessionId,
            mfa_verified: false
        });

        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

        db.prepare(`
            INSERT INTO sessions (id, user_id, org_id, refresh_token_hash, device_fingerprint, ip_address, user_agent, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            sessionId,
            devUser.id,
            membership?.org_id || DEV_ORG_ID,
            sha256(refreshToken.signed),
            'dev-mode',
            req.ip || '127.0.0.1',
            req.get('user-agent') || 'dev-client',
            expiresAt
        );

        // Set cookies
        // VAULT-INTEG P17: instance_config ('cookie_secure') wins over env
        // when the wizard has set it — mirrors accessTokenCookie.js's
        // resolveCookieSecure(). Same env fallback as before this change.
        const cookieSecureOverride = readInstanceConfigBoolean('cookie_secure');
        const cookieSecure = cookieSecureOverride !== null
            ? cookieSecureOverride
            : process.env.COOKIE_SECURE !== 'false';
        res.cookie('access_token', accessToken, {
            httpOnly: true,
            secure: cookieSecure,
            sameSite: 'lax',
            maxAge: 15 * 60 * 1000 // 15 minutes
        });

        res.cookie('refresh_token', refreshToken.signed, {
            httpOnly: true,
            secure: cookieSecure,
            sameSite: 'lax',
            path: '/api/auth/refresh',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });

        console.log(`[Setup] Dev user logged in: ${devUser.primary_email}`);

        res.json({
            success: true,
            user: {
                id: devUser.id,
                email: devUser.primary_email,
                display_name: devUser.display_name,
                status: devUser.status
            },
            org: membership ? {
                id: membership.org_id,
                name: membership.org_name,
                slug: membership.org_slug,
                role: membership.role
            } : {
                id: DEV_ORG_ID,
                name: 'Development Org',
                slug: 'dev',
                role: 'owner'
            },
            tokens: {
                access_token: accessToken,
                refresh_token: refreshToken.signed,
                expires_in: 900 // 15 minutes
            }
        });
    } catch (err) {
        console.error('Dev login failed:', err);
        res.status(500).json({
            error: 'dev_login_failed',
            message: err.message
        });
    }
});

/**
 * VAULT-INTEG P17: validate the class-B instance-basics fields accepted by
 * POST /api/setup/config. Every field is optional (absent = untouched, same
 * convention as the pre-existing 10 fields' setConfig() no-op-on-undefined
 * behaviour) — this only rejects a field that WAS supplied but malformed.
 *
 * matrixServerName is not a URL (it's a Matrix server_name — bare hostname,
 * no scheme, no path, per the Matrix spec), so it gets its own hostname
 * check rather than validateUrlScheme.
 *
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateInstanceBasics({ appBaseUrl, publicUrl, collectorPublicUrl, corsOrigins, cookieSecure, matrixServerName }) {
    const errors = [];

    for (const [field, value] of [
        ['appBaseUrl', appBaseUrl],
        ['publicUrl', publicUrl],
        ['collectorPublicUrl', collectorPublicUrl]
    ]) {
        if (value === undefined || value === null || value === '') continue;
        if (typeof value !== 'string') {
            errors.push(`${field} must be a string`);
            continue;
        }
        const check = validateUrlScheme(value);
        if (!check.valid) errors.push(`${field}: ${check.error}`);
    }

    if (corsOrigins !== undefined && corsOrigins !== null && corsOrigins !== '') {
        if (typeof corsOrigins !== 'string') {
            errors.push('corsOrigins must be a comma-separated string of origins');
        } else {
            const entries = corsOrigins.split(',').map(o => o.trim()).filter(Boolean);
            if (entries.length === 0) {
                errors.push('corsOrigins must contain at least one origin');
            }
            for (const origin of entries) {
                const check = validateUrlScheme(origin);
                if (!check.valid) errors.push(`corsOrigins entry '${origin}': ${check.error}`);
            }
        }
    }

    if (cookieSecure !== undefined && cookieSecure !== null && typeof cookieSecure !== 'boolean') {
        errors.push('cookieSecure must be a boolean');
    }

    if (matrixServerName !== undefined && matrixServerName !== null && matrixServerName !== '') {
        if (typeof matrixServerName !== 'string' || !/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(matrixServerName)) {
            errors.push('matrixServerName must be a bare hostname (optionally with a :port), no scheme or path');
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * POST /api/setup/config
 * Save API keys and system configuration
 */
router.post('/config', apiLimiter, requireSetupIncomplete, async (req, res) => {
    try {
        const db = getDb();

        const {
            anthropicKey,
            openaiKey,
            elevenlabsKey,
            perplexityKey,
            geminiKey,
            codexKey,
            claudeToken,
            smtp,
            qdrantUrl,
            dashboardUrl,
            // VAULT-INTEG P17: class-B instance basics (public URLs, CORS,
            // TLS posture, Matrix server name) — see validateInstanceBasics
            // below for the accepted shapes.
            appBaseUrl,
            publicUrl,
            collectorPublicUrl,
            corsOrigins,
            cookieSecure,
            matrixServerName
        } = req.body;

        const instanceBasicsCheck = validateInstanceBasics({ appBaseUrl, publicUrl, collectorPublicUrl, corsOrigins, cookieSecure, matrixServerName });
        if (!instanceBasicsCheck.valid) {
            return res.status(400).json({
                error: 'invalid_instance_basics',
                message: instanceBasicsCheck.errors.join('; '),
                errors: instanceBasicsCheck.errors
            });
        }

        const now = new Date().toISOString();

        // Helper to upsert config
        const setConfig = (key, value, shouldEncrypt = false) => {
            if (value === undefined || value === null) return;

            let storedValue = value;
            let isEncrypted = 0;

            if (shouldEncrypt && value) {
                // SECURITY: Require MASTER_ENCRYPTION_KEY for sensitive data
                if (!process.env.MASTER_ENCRYPTION_KEY) {
                    console.error(`[SECURITY] MASTER_ENCRYPTION_KEY not set - refusing to store ${key} in plaintext`);
                    throw new Error('Encryption key not configured. Set MASTER_ENCRYPTION_KEY environment variable.');
                }

                try {
                    // Use shared encryption utility (base64 format)
                    storedValue = encrypt(value);
                    isEncrypted = 1;
                } catch (e) {
                    console.error(`[SECURITY] Encryption failed for ${key}:`, e.message);
                    throw new Error(`Failed to encrypt ${key}: ${e.message}`);
                }
            }

            db.prepare(`
                INSERT INTO instance_config (key, value, value_type, encrypted, updated_at)
                VALUES (?, ?, 'string', ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    encrypted = excluded.encrypted,
                    updated_at = excluded.updated_at
            `).run(key, storedValue, isEncrypted, now);
        };

        // Track what was updated for audit logging
        const updatedKeys = [];

        // Save API keys (encrypted)
        // Note: Only core AI service keys are stored here.
        // Stripe is NOT needed - it's only used on quox.ai website for plugin purchases.
        if (anthropicKey) { setConfig('anthropic_api_key', anthropicKey, true); updatedKeys.push('anthropic'); }
        if (openaiKey) { setConfig('openai_api_key', openaiKey, true); updatedKeys.push('openai'); }
        if (elevenlabsKey) { setConfig('elevenlabs_api_key', elevenlabsKey, true); updatedKeys.push('elevenlabs'); }
        if (perplexityKey) { setConfig('perplexity_api_key', perplexityKey, true); updatedKeys.push('perplexity'); }
        if (geminiKey) { setConfig('gemini_api_key', geminiKey, true); updatedKeys.push('gemini'); }
        if (codexKey) { setConfig('codex_api_key', codexKey, true); updatedKeys.push('codex'); }
        if (claudeToken) { setConfig('claude_oauth_token', claudeToken, true); updatedKeys.push('claude_oauth'); }

        // Audit log for API key changes
        if (updatedKeys.length > 0) {
            logAudit({
                action: AuditActions.CONFIG_API_KEY_SET,
                actor: { type: 'system', id: 'setup' },
                target: { type: 'config', id: 'api_keys' },
                status: 'success',
                request: req,
                metadata: { keys: updatedKeys }
            });
        }

        // Phase 12: Dual-write AI keys to vault if orgs exist
        // On first boot there are no orgs yet — the boot-time migration handles that case.
        // On re-config, dual-write immediately so vault is always up to date.
        try {
            const AI_KEY_MAP = {
                anthropicKey:  { type: 'anthropic',  field: 'api_key' },
                openaiKey:     { type: 'openai',     field: 'api_key' },
                elevenlabsKey: { type: 'elevenlabs', field: 'api_key' },
                perplexityKey: { type: 'perplexity', field: 'api_key' },
                geminiKey:     { type: 'gemini',     field: 'api_key' },
                codexKey:      { type: 'codex',      field: 'api_key' }
            };

            const orgs = db.prepare('SELECT id FROM orgs WHERE deleted_at IS NULL').all();
            for (const org of orgs) {
                for (const [bodyField, { type: intType, field }] of Object.entries(AI_KEY_MAP)) {
                    const value = req.body[bodyField];
                    if (!value) continue;

                    const existing = getDefaultCredential(org.id, intType);
                    if (!existing) {
                        createCredential({
                            org_id: org.id,
                            integration_type: intType,
                            label: `${intType} (auto)`,
                            credentials: { [field]: value },
                            auth_type: 'api_key',
                            is_default: true,
                            created_by: 'system:setup',
                            visibility: 'org'
                        });
                    }
                }
            }
        } catch (vaultErr) {
            // Non-fatal: instance_config is already saved as primary
            console.warn('[Setup] Vault dual-write failed (non-fatal):', vaultErr.message);
        }

        // Save SMTP config. EMAIL-UNIFY P2: the wizard writes the same
        // QuoxVault instance credential the Settings email panel writes, so
        // there is one place email is configured from the very first boot.
        // Falls back to the legacy instance_config rows only if the vault
        // write is impossible (no user row yet to own the credential) — the
        // boot migration then moves them across on the next start.
        if (smtp) {
            try {
                const { upsertSmtpConfig } = await import('../utils/emailService.js');
                const smtpResult = upsertSmtpConfig({
                    host: smtp.host,
                    port: smtp.port,
                    user: smtp.user,
                    pass: smtp.pass,
                    from: smtp.from || smtp.user,
                    secure: smtp.secure !== undefined ? smtp.secure : Number(smtp.port) === 465,
                }, { db, userId: req.user?.id || null });

                if (!smtpResult.ok) {
                    console.warn('[Setup] SMTP config rejected:', JSON.stringify(smtpResult.errors));
                }
            } catch (smtpErr) {
                // The vault credential needs a user row to own it. A wizard that
                // saves SMTP before the admin account exists must not fail the
                // whole setup call — write the legacy rows and let the boot
                // migration move them into the vault on the next start.
                console.warn('[Setup] Vault SMTP write failed, falling back to instance_config:', smtpErr.message);
                setConfig('smtp_host', smtp.host);
                setConfig('smtp_port', smtp.port?.toString());
                setConfig('smtp_user', smtp.user);
                setConfig('smtp_pass', smtp.pass, true);
                setConfig('smtp_from', smtp.from || smtp.user);
                setConfig('smtp_secure', String(smtp.secure !== undefined ? !!smtp.secure : Number(smtp.port) === 465));
            }

            logAudit({
                action: AuditActions.CONFIG_SMTP_UPDATE,
                actor: { type: 'system', id: 'setup' },
                target: { type: 'config', id: 'smtp' },
                status: 'success',
                request: req,
                metadata: { host: smtp.host }
            });
        }

        // Save service URLs
        const endpointUpdates = [];
        if (qdrantUrl) { setConfig('qdrant_url', qdrantUrl); endpointUpdates.push('qdrant'); }

        // Save dashboard URL and auto-configure CORS
        if (dashboardUrl) {
            setConfig('dashboard_url', dashboardUrl);
            endpointUpdates.push('dashboard');

            // Auto-append dashboard origin to CORS_ORIGINS env var
            try {
                const origin = new URL(dashboardUrl).origin;
                const currentOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
                if (!currentOrigins.includes(origin)) {
                    currentOrigins.push(origin);
                    process.env.CORS_ORIGINS = currentOrigins.join(',');
                    console.log(`[Setup] Added ${origin} to CORS_ORIGINS`);
                }
            } catch (urlErr) {
                console.warn('[Setup] Invalid dashboardUrl, skipping CORS update:', urlErr.message);
            }
        }

        if (endpointUpdates.length > 0) {
            logAudit({
                action: AuditActions.CONFIG_ENDPOINT_UPDATE,
                actor: { type: 'system', id: 'setup' },
                target: { type: 'config', id: 'endpoints' },
                status: 'success',
                request: req,
                metadata: { endpoints: endpointUpdates }
            });
        }

        // VAULT-INTEG P17: class-B instance basics — none of these are
        // secrets (public URLs, CORS allowlist, TLS posture, Matrix server
        // name), so setConfig() runs unencrypted. Absent = untouched, same
        // convention as every field above.
        const instanceBasicsUpdates = [];
        if (appBaseUrl) { setConfig('app_base_url', appBaseUrl); instanceBasicsUpdates.push('appBaseUrl'); }
        if (publicUrl) { setConfig('public_url', publicUrl); instanceBasicsUpdates.push('publicUrl'); }
        if (collectorPublicUrl) { setConfig('collector_public_url', collectorPublicUrl); instanceBasicsUpdates.push('collectorPublicUrl'); }
        if (corsOrigins) {
            const normalizedOrigins = corsOrigins.split(',').map(o => o.trim()).filter(Boolean).join(',');
            setConfig('cors_origins', normalizedOrigins);
            instanceBasicsUpdates.push('corsOrigins');
        }
        if (typeof cookieSecure === 'boolean') { setConfig('cookie_secure', String(cookieSecure)); instanceBasicsUpdates.push('cookieSecure'); }
        if (matrixServerName) { setConfig('matrix_server_name', matrixServerName); instanceBasicsUpdates.push('matrixServerName'); }

        if (instanceBasicsUpdates.length > 0) {
            logAudit({
                action: AuditActions.CONFIG_UPDATE,
                actor: { type: 'system', id: 'setup' },
                target: { type: 'config', id: 'instance_basics' },
                status: 'success',
                request: req,
                metadata: { fields: instanceBasicsUpdates }
            });
        }

        // Mark setup as complete
        setConfig('instance.setup_complete', 'true');
        setConfig('setup_completed_at', now);

        console.log('[Setup] Configuration saved successfully');

        res.json({
            success: true,
            message: 'Configuration saved successfully'
        });
    } catch (err) {
        console.error('Config save failed:', err);
        res.status(500).json({
            error: 'config_save_failed',
            message: err.message
        });
    }
});

/**
 * UI-12: cached Qdrant reachability probe for /setup/config. Fresh installs
 * use docker-compose service-name resolution (`http://qdrant:6333`) without
 * writing an `instance_config.qdrant_url` row, so the settings UI showed
 * "Not Set" even though the service was operational. Probe once per minute
 * and report `auto-detected` when reachable but unconfigured.
 */
let _qdrantProbeCache = { result: null, ts: 0 };
const QDRANT_PROBE_CACHE_MS = 60_000;
const QDRANT_PROBE_TIMEOUT_MS = 1_500;
async function probeQdrantReachable() {
    const now = Date.now();
    if (_qdrantProbeCache.result !== null && (now - _qdrantProbeCache.ts) < QDRANT_PROBE_CACHE_MS) {
        return _qdrantProbeCache.result;
    }
    const candidates = [process.env.QDRANT_URL, 'http://qdrant:6333', 'http://127.0.0.1:6333']
        .filter(Boolean)
        .map(u => u.replace(/\/$/, ''));
    const headers = process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : undefined;
    let reachableUrl = null;
    for (const baseUrl of candidates) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), QDRANT_PROBE_TIMEOUT_MS);
            const r = await fetch(`${baseUrl}/healthz`, { headers, signal: ctrl.signal });
            clearTimeout(timer);
            if (r.ok) { reachableUrl = baseUrl; break; }
        } catch { /* try next candidate */ }
    }
    _qdrantProbeCache = { result: reachableUrl, ts: now };
    return reachableUrl;
}

/**
 * GET /api/setup/config
 * Get current configuration (without sensitive values)
 */
router.get('/config', allowDuringSetupOtherwiseRequireAuth, async (req, res) => {
    try {
        const db = getDb();

        // Check if instance_config table exists
        const tableExists = db.prepare(`
            SELECT name FROM sqlite_master WHERE type='table' AND name='instance_config'
        `).get();

        if (!tableExists) {
            return res.json({
                configured: false,
                keys: {}
            });
        }

        const configs = db.prepare(`
            SELECT key, encrypted, updated_at FROM instance_config
        `).all();

        // Build lookup: key presence + timestamps + vault credential IDs
        const keyPresent = {};
        const keyTimestamps = {};
        const vaultCredIds = {};
        for (const config of configs) {
            keyPresent[config.key] = true;
            if (config.updated_at) keyTimestamps[config.key] = config.updated_at;
            // Vault credential ID entries follow pattern: <provider>_vault_credential_id
            if (config.key.endsWith('_vault_credential_id') && !config.encrypted) {
                const provider = config.key.replace('_vault_credential_id', '').replace('_api_key', '');
                vaultCredIds[provider] = config.value || null; // unencrypted ID string
            }
        }

        // Map instance_config key → provider name for timestamps + vault IDs
        const PROVIDER_KEY_MAP = {
            anthropic_api_key: 'anthropic',
            openai_api_key: 'openai',
            elevenlabs_api_key: 'elevenlabs',
            perplexity_api_key: 'perplexity',
            gemini_api_key: 'gemini',
            codex_api_key: 'codex',
            claude_oauth_token: 'claude',
        };

        const timestamps = {};
        const vaultSelections = {};
        for (const [configKey, provider] of Object.entries(PROVIDER_KEY_MAP)) {
            if (keyTimestamps[configKey]) timestamps[provider] = keyTimestamps[configKey];
            if (vaultCredIds[provider]) vaultSelections[provider] = vaultCredIds[provider];
        }

        res.json({
            configured: keyPresent['instance.setup_complete'] === true,
            keys: {
                hasAnthropicKey: !!keyPresent['anthropic_api_key'],
                hasOpenaiKey: !!keyPresent['openai_api_key'],
                hasElevenlabsKey: !!keyPresent['elevenlabs_api_key'],
                hasPerplexityKey: !!keyPresent['perplexity_api_key'],
                hasGeminiKey: !!keyPresent['gemini_api_key'],
                hasCodexKey: !!keyPresent['codex_api_key'],
                hasClaudeToken: !!keyPresent['claude_oauth_token'],
                hasSmtp: !!keyPresent['smtp_host'],
                // UI-12: report 'auto-detected' when Qdrant is reachable
                // via docker-compose service name (or env / localhost) but
                // no explicit instance_config row exists. The frontend
                // treats both 'configured' and 'auto-detected' as truthy
                // for the "configured" badge.
                qdrantUrl: keyPresent['qdrant_url']
                    ? 'configured'
                    : ((await probeQdrantReachable()) ? 'auto-detected' : null)
            },
            timestamps,
            vaultSelections
        });
    } catch (err) {
        console.error('Config fetch failed:', err);
        res.status(500).json({
            error: 'config_fetch_failed',
            message: err.message
        });
    }
});

/**
 * GET /api/setup/internal/voice-keys
 * Internal endpoint for collector to get decrypted voice API keys
 * Only accessible from localhost/docker network
 */
router.get('/internal/voice-keys', async (req, res) => {
    try {
        const auth = authorizeInternalServiceRequest(req);
        if (!auth.authorized) {
            console.warn(`[Security] Rejected voice-keys request from: ${auth.clientIp} (${auth.reason})`);
            return res.status(403).json({
                error: 'forbidden',
                message: 'Internal endpoint only'
            });
        }

        // Use credentialResolver waterfall: vault → instance_config → env
        const { resolveProviderKey } = await import('../services/credentialResolver.js');
        let orgId = req.query.org_id || 'default';

        // When no specific org, find the first org that has credentials
        if (orgId === 'default') {
            try {
                const db = getDb();
                const firstOrg = db.prepare(
                    "SELECT DISTINCT org_id FROM integration_credentials WHERE integration_type IN ('elevenlabs', 'openai') AND is_default = 1 LIMIT 1"
                ).get();
                if (firstOrg?.org_id) orgId = firstOrg.org_id;
            } catch (_) { /* fall through to instance_config/env */ }
        }

        const result = {};

        const elevenlabs = resolveProviderKey(orgId, 'elevenlabs');
        if (elevenlabs?.key) {
            result.elevenlabs_api_key = elevenlabs.key;
        }

        const openai = resolveProviderKey(orgId, 'openai');
        if (openai?.key) {
            result.openai_api_key = openai.key;
        }

        res.json(result);
    } catch (err) {
        console.error('[Voice Keys] Error:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to retrieve voice keys'
        });
    }
});

/**
 * GET /api/setup/internal/claude-keys
 * Internal endpoint for collector to get decrypted Claude auth tokens
 * Only accessible from localhost/docker network
 */
router.get('/internal/claude-keys', (req, res) => {
    try {
        const auth = authorizeInternalServiceRequest(req);
        if (!auth.authorized) {
            console.warn(`[Security] Rejected claude-keys request from: ${auth.clientIp} (${auth.reason})`);
            return res.status(403).json({
                error: 'forbidden',
                message: 'Internal endpoint only'
            });
        }

        const db = getDb();

        const claudeRow = db.prepare(`
            SELECT value, encrypted FROM instance_config WHERE key = 'claude_oauth_token'
        `).get();

        const anthropicRow = db.prepare(`
            SELECT value, encrypted FROM instance_config WHERE key = 'anthropic_api_key'
        `).get();

        const result = {};

        if (claudeRow?.value) {
            try {
                result.claude_oauth_token = claudeRow.encrypted
                    ? decrypt(claudeRow.value)
                    : claudeRow.value;
            } catch (e) {
                console.error('[Claude Keys] Failed to decrypt claude token:', e.message);
            }
        }

        if (anthropicRow?.value) {
            try {
                result.anthropic_api_key = anthropicRow.encrypted
                    ? decrypt(anthropicRow.value)
                    : anthropicRow.value;
            } catch (e) {
                console.error('[Claude Keys] Failed to decrypt anthropic key:', e.message);
            }
        }

        res.json(result);
    } catch (err) {
        console.error('[Claude Keys] Error:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to retrieve Claude keys'
        });
    }
});

/**
 * GET /api/setup/internal/smtp-config
 * Internal endpoint for collector to get the decrypted instance SMTP
 * transport (EMAIL-UNIFY). Reuses loadSmtpConfig from emailService.js —
 * the same config the Settings email panel writes and auth's own
 * transactional/QuoxChat-transcript sends already use. Modeled on
 * /internal/claude-keys above (same authorizeInternalServiceRequest gate;
 * internal-only, never exposed as a public/admin-auth route).
 */
router.get('/internal/smtp-config', async (req, res) => {
    try {
        const auth = authorizeInternalServiceRequest(req);
        if (!auth.authorized) {
            console.warn(`[Security] Rejected smtp-config request from: ${auth.clientIp} (${auth.reason})`);
            return res.status(403).json({
                error: 'forbidden',
                message: 'Internal endpoint only'
            });
        }

        const { loadSmtpConfig } = await import('../utils/emailService.js');
        const db = getDb();
        const cfg = loadSmtpConfig(db);

        if (!cfg) {
            return res.json({ configured: false });
        }

        res.json({
            configured: true,
            host: cfg.host,
            port: cfg.port,
            secure: cfg.secure,
            user: cfg.auth?.user || '',
            pass: cfg.auth?.pass || '',
            from: cfg.from,
        });
    } catch (err) {
        console.error('[SMTP Config] Error:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to retrieve SMTP config'
        });
    }
});

/**
 * GET /api/setup/internal/credential-decrypt/:id
 * Internal endpoint for screencap to resolve vault credentials (BQ service-to-service)
 */
router.get('/internal/credential-decrypt/:id', async (req, res) => {
    try {
        const auth = authorizeInternalServiceRequest(req);
        if (!auth.authorized) {
            return res.status(403).json({ error: 'forbidden', message: 'Internal endpoint only' });
        }

        const { id } = req.params;
        const orgId = req.query.org_id;

        if (!orgId) {
            return res.status(400).json({
                error: 'invalid_request',
                message: 'org_id is required',
            });
        }

        // getDecryptedCredential() decrypts the v2 envelope (the canonical
        // format createCredential() writes) via the decrypt() router, which
        // also transparently handles legacy 3-part hex/base64 ciphertext.
        const decrypted = getDecryptedCredential(id);
        if (!decrypted) {
            return res.status(404).json({ error: 'not_found', message: 'Credential not found' });
        }

        // VAULT-AUDIT P5.A1 (F12): org check enforced — a service-key caller
        // can no longer fetch another org's secret by id. A cross-org caller
        // gets the same 404 as a missing credential so the response can't be
        // used as an existence oracle (mirrors routes/totp.js:100-101).
        if (decrypted.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Credential not found' });
        }

        // VAULT-P5.G (F4): lease enforcement gate — same contract as
        // routes/integrations.js POST /internal/integrations/:id/decrypt.
        const leaseAgentId = req.query.agent_id || null;
        const leaseGate = evaluateLeaseGate({ orgId, agentId: leaseAgentId, credentialId: decrypted.id });
        if (!leaseGate.allow) {
            writeLeaseAccessAudit({
                orgId, credentialId: decrypted.id, integrationType: decrypted.integration_type,
                label: decrypted.label, agentId: leaseAgentId, outcome: 'lease_denied', reason: leaseGate.reason,
                callerService: auth?.service || 'internal', via: 'credential-decrypt',
            });
            return res.status(403).json({ error: 'lease_required', message: 'An active lease is required to access this credential', reason: leaseGate.reason });
        }
        if (leaseGate.advisory) {
            writeLeaseAccessAudit({
                orgId, credentialId: decrypted.id, integrationType: decrypted.integration_type,
                label: decrypted.label, agentId: leaseAgentId, outcome: 'lease_missing', reason: leaseGate.reason,
                callerService: auth?.service || 'internal', via: 'credential-decrypt',
            });
        }

        // getDecryptedCredential() sets credentials: null when decrypt() throws
        // (and leaves the raw ciphertext on the row). The only ciphertext shape
        // decrypt() can't handle is a pre-VAULT-AUDIT-P1 legacy row that was
        // never encrypted at all — plain JSON. Fall back to parsing that raw
        // value for those rows only; anything else stays null (never guess).
        let credentials = decrypted.credentials;
        if (credentials === null && decrypted.ciphertext) {
            try {
                credentials = JSON.parse(decrypted.ciphertext);
            } catch {
                credentials = null;
            }
        }

        // AEE-CORE-3: every vault credential read is audited. The caller must
        // be an internal service (authorizeInternalServiceRequest passed above).
        // Credential VALUES are never included in the payload — only metadata.
        try {
            const { emitEnvelope } = await import('../lib/aeeClient.js');
            emitEnvelope({
                from: `service.${auth?.service || 'internal'}`,
                to: 'audit.system',
                intent: 'quox.vault.credential.read',
                corr: `VAULT_${decrypted.id}`,
                payload: {
                    credential_id: decrypted.id,
                    integration_type: decrypted.integration_type,
                    label: decrypted.label,
                    auth_type: decrypted.auth_type,
                    org_id: decrypted.org_id || orgId || null,
                    caller_service: auth?.service || 'internal',
                    via: 'credential-decrypt',
                },
            });
        } catch (e) { /* audit is fire-and-forget */ }

        // VAULT-AUDIT P5.A1 / P5.E: every credential RELEASE is a
        // tamper-evident, WARD-witnessed audit_events row — WHO
        // (caller_service), WHAT (credential_id, integration_type, org_id),
        // WHEN. NEVER the secret values. writeCredentialReleaseAudit() is the
        // single shared implementation (see lib/credentialReleaseAudit.js),
        // reused by every other internal credential-release endpoint. Only
        // reached on the success path (org check passed, credential found).
        writeCredentialReleaseAudit({
            orgId,
            credentialId: decrypted.id,
            integrationType: decrypted.integration_type,
            label: decrypted.label,
            authType: decrypted.auth_type,
            callerService: auth?.service || 'internal',
            via: 'credential-decrypt',
        });

        res.json({
            id: decrypted.id,
            label: decrypted.label,
            integration_type: decrypted.integration_type,
            credentials,
        });
    } catch (err) {
        console.error('[Credential Decrypt] Error:', err);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

// AQ-9B DEBT 2: the credential fields a trusted internal caller may patch
// into an existing vault credential's encrypted payload. refresh_token only
// for now — the sole caller is Calendar-Q's OAuth callback write-back
// (lib/calendarq/api.js's attemptCredentialWriteBack), persisting the
// refresh token Google handed back during the authorization-code exchange.
// An explicit allowlist, not a denylist: anything not named here is 400,
// never silently merged.
const PATCHABLE_CREDENTIAL_FIELDS = ['refresh_token'];

/**
 * PATCH /api/setup/internal/credential-fields/:id
 * Internal write-back: merges named, allowlisted fields into an existing
 * vault credential's encrypted payload and re-encrypts via the SAME
 * envelope path (db/integrations.js's updateCredential -> encrypt()) every
 * other credential write already uses — no second crypto implementation.
 *
 * Guard mirrors GET /internal/credential-decrypt/:id exactly:
 * authorizeInternalServiceRequest (same INTERNAL_SERVICE_KEY header check),
 * org_id required and matched against the credential row (cross-org id gets
 * the identical 404 a missing id gets — no existence oracle).
 */
router.patch('/internal/credential-fields/:id', async (req, res) => {
    try {
        const auth = authorizeInternalServiceRequest(req);
        if (!auth.authorized) {
            return res.status(403).json({ error: 'forbidden', message: 'Internal endpoint only' });
        }

        const { id } = req.params;
        const orgId = req.query.org_id;
        if (!orgId) {
            return res.status(400).json({ error: 'invalid_request', message: 'org_id is required' });
        }

        const fields = req.body?.fields;
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
            return res.status(400).json({ error: 'invalid_request', message: 'fields object is required' });
        }

        const requestedFieldNames = Object.keys(fields);
        if (requestedFieldNames.length === 0) {
            return res.status(400).json({ error: 'invalid_request', message: 'fields object is required' });
        }
        const disallowed = requestedFieldNames.filter((name) => !PATCHABLE_CREDENTIAL_FIELDS.includes(name));
        if (disallowed.length > 0) {
            return res.status(400).json({ error: 'invalid_request', message: `field(s) not patchable: ${disallowed.join(', ')}` });
        }

        // Same org check, same no-existence-oracle shape as credential-decrypt.
        const existing = getDecryptedCredential(id);
        if (!existing || existing.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Credential not found' });
        }
        if (existing.credentials === null) {
            return res.status(500).json({ error: 'internal_error', message: 'Credential could not be decrypted' });
        }

        const mergedCredentials = { ...existing.credentials, ...fields };
        const updated = updateCredential(id, { credentials: mergedCredentials });

        // Tamper-evident audit row — field NAMES only, never values. Mirrors
        // writeCredentialReleaseAudit's non-fatal-on-failure contract.
        writeCredentialUpdateAudit({
            orgId,
            credentialId: id,
            integrationType: existing.integration_type,
            label: existing.label,
            fieldNames: requestedFieldNames,
            callerService: auth?.service || 'internal',
            via: 'credential-fields-patch',
        });

        res.json({ id: updated.id, label: updated.label, integration_type: updated.integration_type, updated: true });
    } catch (err) {
        console.error('[Credential Fields Patch] Error:', err);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

/**
 * GET /api/setup/internal/provider-keys
 * Internal endpoint for collector to get all AI provider keys
 * Only accessible from localhost/docker network
 */
router.get('/internal/provider-keys', (req, res) => {
    try {
        const auth = authorizeInternalServiceRequest(req);
        if (!auth.authorized) {
            console.warn(`[Security] Rejected provider-keys request from: ${auth.clientIp} (${auth.reason})`);
            return res.status(403).json({
                error: 'forbidden',
                message: 'Internal endpoint only'
            });
        }

        const db = getDb();
        const keyNames = ['anthropic_api_key', 'openai_api_key', 'perplexity_api_key', 'gemini_api_key'];
        const result = {};

        for (const keyName of keyNames) {
            const row = db.prepare(
                `SELECT value, encrypted FROM instance_config WHERE key = ?`
            ).get(keyName);

            if (row?.value) {
                try {
                    result[keyName] = row.encrypted ? decrypt(row.value) : row.value;
                } catch (e) {
                    console.error(`[Provider Keys] Failed to decrypt ${keyName}:`, e.message);
                }
            }
        }

        res.json(result);
    } catch (err) {
        console.error('[Provider Keys] Error:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to retrieve provider keys'
        });
    }
});

/**
 * POST /api/setup/internal/resolve
 * QuoxVault unified credential resolution — waterfall: vault → instance_config → env
 * Used by the collector service to resolve all provider keys in a single call.
 *
 * Body: { org_id, providers: ['anthropic','openai',...], channels: ['slack',...] }
 * Returns: { providers: { anthropic: { key, source }, ... }, channels: { ... } }
 */
router.post('/internal/resolve', async (req, res) => {
    try {
        const auth = authorizeInternalServiceRequest(req);
        if (!auth.authorized) {
            console.warn(`[Security] Rejected resolve request from: ${auth.clientIp} (${auth.reason})`);
            return res.status(403).json({
                error: 'forbidden',
                message: 'Internal endpoint only'
            });
        }

        // #481: repo is an optional SELECTION HINT ("owner/name"). It picks the
        // org credential scoped to that repo instead of the org default. It
        // never widens what the caller can reach: selection stays inside
        // org_id, so this cannot resolve another tenant's credential.
        const { org_id = 'default', providers = [], channels = [], fallback_to_instance = true, fallback_to_env = true, repo = null } = req.body || {};

        const { resolveProviderKey, resolveClaudeKeys, resolveNotificationCredentials } = await import('../services/credentialResolver.js');

        const result = { providers: {}, channels: {} };

        // Resolve AI provider keys
        for (const provider of providers) {
            if (provider === 'claude') {
                result.providers.claude = resolveClaudeKeys(org_id);
            } else {
                result.providers[provider] = resolveProviderKey(org_id, provider, {
                    fallbackToInstance: fallback_to_instance,
                    fallbackToEnv: fallback_to_env,
                    repo: typeof repo === 'string' && repo.trim() ? repo.trim() : null
                });
            }
        }

        // Resolve notification channel credentials
        for (const channel of channels) {
            result.channels[channel] = resolveNotificationCredentials(org_id, channel);
        }

        res.json(result);
    } catch (err) {
        console.error('[Resolve] Error:', err.message);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to resolve credentials'
        });
    }
});

/**
 * POST /api/setup/internal/resolve-for-agent
 * VAULT-P5.H (F4) — the missing caller for resolveForAgent's 4-level scope
 * chain (agent assignment -> org default -> instance -> env), with the
 * lease-enforcement gate (VAULT-P5.F/G) live on the first two levels. This
 * is the toolType/agentId-aware sibling of /internal/resolve (which is
 * provider-key-only and stays lease-EXEMPT platform plumbing) and
 * /internal/resolve-by-id (which resolves a specific, caller-chosen
 * credential_id and has no agent identity at all).
 *
 * Body: { org_id, agent_id, tool_type, fallback_to_instance?, fallback_to_env? }
 * Returns: resolveForAgent()'s result shape, or 403 lease_required when the
 * org is in `enforced` mode and the resolved credential requires a lease
 * the agent doesn't hold.
 */
router.post('/internal/resolve-for-agent', async (req, res) => {
    try {
        const auth = authorizeInternalServiceRequest(req);
        if (!auth.authorized) {
            return res.status(403).json({ error: 'forbidden', message: 'Internal endpoint only' });
        }

        const { org_id, agent_id, tool_type, fallback_to_instance = true, fallback_to_env = true } = req.body || {};
        if (!org_id || !agent_id || !tool_type) {
            return res.status(400).json({
                error: 'invalid_request',
                message: 'org_id, agent_id, and tool_type are required',
            });
        }

        const { resolveForAgent } = await import('../services/credentialResolver.js');
        const result = resolveForAgent(org_id, agent_id, tool_type, {
            fallbackToInstance: fallback_to_instance,
            fallbackToEnv: fallback_to_env,
        });

        if (result.leaseBlocked) {
            return res.status(403).json({
                error: 'lease_required',
                message: 'An active lease is required to resolve this credential for this agent',
                reason: result.leaseReason || 'lease_required',
            });
        }

        res.json(result);
    } catch (err) {
        console.error('[Resolve-For-Agent] Error:', err.message);
        res.status(500).json({ error: 'internal_error', message: 'Failed to resolve credential for agent' });
    }
});

/**
 * POST /api/setup/internal/resolve-by-id
 * Resolve a specific credential by ID — returns decrypted key + provider type.
 * Used when the user selects a specific credential from the CredentialPicker.
 *
 * Body: { credential_id, org_id? }
 *
 * VAULT-P6.D (F12-class fix for finding P6-F1): org_id is now verified
 * whenever supplied — decrypted.org_id !== org_id returns 404 (not-found
 * shape, no existence oracle, mirrors the credential-decrypt F12 fix and
 * routes/totp.js:100-101). Whether org_id is REQUIRED (400 if absent) is
 * gated by RESOLVE_BY_ID_REQUIRE_ORG:
 *   - 'false' → never required (mismatch check still runs if supplied) —
 *               explicit opt-out only, not a supported deployment default.
 *   - anything else (including unset) → always required (400 if absent).
 * VAULT-P6.H: every known caller now threads org_id on every call —
 * server.js's two chat-request call sites, connectors/bridge.js (VAULT-P6.D),
 * and quoxchatToolExecutors.js's vault resolver (VAULT-P6.G, the last
 * residual indirect caller). With no legitimate caller left that omits
 * org_id, enforcement is now unconditional (no more NODE_ENV-gated
 * advisory window) — grepped `resolve-by-id` across all services to
 * confirm no other caller relies on the old omitted-org advisory path.
 *
 * Returns: { provider, key, label, source: 'vault' } or { error }
 */
router.post('/internal/resolve-by-id', async (req, res) => {
    try {
        const auth = authorizeInternalServiceRequest(req);
        if (!auth.authorized) {
            return res.status(403).json({ error: 'forbidden', message: 'Internal endpoint only' });
        }

        const { credential_id, org_id: orgId } = req.body || {};
        if (!credential_id) {
            return res.status(400).json({ error: 'missing_credential_id' });
        }

        // VAULT-P6.H: enforced by default. Only an explicit 'false' opts out.
        const requireOrg = process.env.RESOLVE_BY_ID_REQUIRE_ORG !== 'false';

        if (!orgId && requireOrg) {
            return res.status(400).json({
                error: 'invalid_request',
                message: 'org_id is required',
            });
        }

        const { getDecryptedCredential, updateLastUsed } = await import('../db/integrations.js');
        const cred = getDecryptedCredential(credential_id);
        if (!cred || !cred.credentials) {
            // VAULT-ADVERSARIAL-VERIFICATION: a denied resolution must leave the
            // same kind of trace a granted one does — otherwise a refused attempt
            // is indistinguishable from one that never happened. No credential
            // row exists, so this audits the caller-supplied identifiers only.
            writeCredentialReleaseAudit({
                orgId: orgId || null,
                credentialId: credential_id,
                callerService: auth?.service || 'internal',
                via: 'resolve-by-id',
                outcome: 'denied',
                reason: 'not_found',
            });
            return res.status(404).json({ error: 'credential_not_found' });
        }

        // VAULT-P6.D (F12-class, closes P6-F1): a cross-org caller gets the
        // same 404 as a missing credential — no existence oracle.
        if (orgId && cred.org_id !== orgId) {
            // VAULT-ADVERSARIAL-VERIFICATION: audit the denial under the
            // credential's OWN org_id (never the attacker-supplied one) — same
            // org-sourcing rule the success path already follows below.
            writeCredentialReleaseAudit({
                orgId: cred.org_id,
                credentialId: cred.id,
                integrationType: cred.integration_type,
                label: cred.label,
                authType: cred.auth_type,
                callerService: auth?.service || 'internal',
                via: 'resolve-by-id',
                outcome: 'denied',
                reason: 'org_mismatch',
            });
            return res.status(404).json({ error: 'credential_not_found' });
        }

        // Track usage for VaultUsageWidget analytics
        updateLastUsed(credential_id);

        // VAULT-AUDIT P5.E / P6.D: audit under the credential's OWN org_id —
        // the row always has it, and it's what a caller-supplied org_id was
        // just verified against (when present).
        writeCredentialReleaseAudit({
            orgId: cred.org_id,
            credentialId: cred.id,
            integrationType: cred.integration_type,
            label: cred.label,
            authType: cred.auth_type,
            callerService: auth?.service || 'internal',
            via: 'resolve-by-id',
        });

        // Extract the API key from the decrypted credentials
        const key = cred.credentials.api_key || cred.credentials.key || null;
        res.json({
            provider: cred.integration_type,
            key,
            label: cred.label,
            source: 'vault',
            // Include all credential fields for multi-field connectors (e.g. tailscale needs api_key + tailnet)
            fields: cred.credentials || {}
        });
    } catch (err) {
        console.error('[Resolve-by-ID] Error:', err.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

/**
 * POST /api/setup/internal/repobrain-resolve
 * QN Phase 1: resolve the RepoBrain (QuoxNucleus) backend an org's proxy
 * call should be forwarded to. Mirrors resolve-by-id directly above:
 * same internal-service guard, same org-verified no-existence-oracle 404,
 * same credential-release audit on every decrypt.
 *
 * Body: { org_id, connection_id? }
 *   - No connection_id: loads the org's is_default=1 row. None found means
 *     the org has no connections at all — the zero-config signal, returned
 *     as { connections: 0 } (not an error) so the collector falls back to
 *     the bundled REPOBRAIN_URL.
 *   - connection_id supplied: loads that row; 404 unless it belongs to
 *     org_id (no existence oracle across orgs).
 *
 * Returns: { connection_id, label, base_url, shared_secret } or
 *          { connections: 0 } (zero-config) or { error }.
 */
router.post('/internal/repobrain-resolve', (req, res) => {
    try {
        const auth = authorizeInternalServiceRequest(req);
        if (!auth.authorized) {
            return res.status(403).json({ error: 'forbidden', message: 'Internal endpoint only' });
        }

        const { org_id: orgId, connection_id: connectionId } = req.body || {};
        if (!orgId) {
            return res.status(400).json({ error: 'invalid_request', message: 'org_id is required' });
        }

        const row = connectionId
            ? getDb().prepare('SELECT * FROM repobrain_connections WHERE id = ?').get(connectionId)
            : getDb().prepare('SELECT * FROM repobrain_connections WHERE org_id = ? AND is_default = 1').get(orgId);

        // Explicit connection_id naming another org's row: same 404 shape as
        // a missing row, no existence oracle (mirrors resolve-by-id above).
        if (connectionId && (!row || row.org_id !== orgId)) {
            return res.status(404).json({ error: 'connection_not_found' });
        }

        if (!row) {
            // No connection_id was supplied and the org has no default row:
            // zero-config signal, not an error.
            return res.json({ connections: 0 });
        }

        let sharedSecret = null;
        if (row.credential_id) {
            const cred = getDecryptedCredential(row.credential_id);
            if (cred && cred.credentials) {
                sharedSecret = cred.credentials.shared_secret || null;
                writeCredentialReleaseAudit({
                    orgId,
                    credentialId: cred.id,
                    integrationType: cred.integration_type,
                    label: cred.label,
                    authType: cred.auth_type,
                    callerService: auth?.reason || 'internal',
                    via: 'repobrain-resolve',
                });
            }
        }

        getDb().prepare(`
            UPDATE repobrain_connections SET last_used_at = datetime('now') WHERE id = ?
        `).run(row.id);

        res.json({
            connection_id: row.id,
            label: row.label,
            base_url: row.base_url,
            shared_secret: sharedSecret,
        });
    } catch (err) {
        console.error('[RepoBrain-Resolve] Error:', err.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

/**
 * Claude Subscription OAuth PKCE Flow
 *
 * Allows users to authenticate with their Claude Pro/Max/Team subscription
 * directly from the dashboard, instead of running CLI commands manually.
 *
 * Flow:
 * 1. GET /claude-oauth/start  → generates PKCE challenge, returns OAuth URL
 * 2. User authenticates at claude.ai in a new window
 * 3. platform.claude.com shows the authorization code
 * 4. POST /claude-oauth/callback → exchanges code for token, stores encrypted
 */

// In-memory PKCE state (short-lived, single-instance is fine)
const _pendingOAuth = new Map();

// Claude's public OAuth client (same as claude setup-token uses)
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_OAUTH_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const CLAUDE_OAUTH_AUTH_URL = 'https://claude.ai/oauth/authorize';
const CLAUDE_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

router.get('/claude-oauth/start', requireSetupIncomplete, (req, res) => {
    try {
        // Generate PKCE code_verifier (43-128 chars, URL-safe)
        const codeVerifier = randomBytes(32).toString('base64url');
        // S256 challenge
        const codeChallenge = createHash('sha256')
            .update(codeVerifier)
            .digest('base64url');
        // State parameter to prevent CSRF
        const state = randomBytes(32).toString('base64url');

        // Store verifier for exchange (expires in 10 minutes)
        _pendingOAuth.set(state, {
            codeVerifier,
            createdAt: Date.now()
        });

        // Clean up old entries
        for (const [key, val] of _pendingOAuth.entries()) {
            if (Date.now() - val.createdAt > 10 * 60 * 1000) {
                _pendingOAuth.delete(key);
            }
        }

        const authUrl = `${CLAUDE_OAUTH_AUTH_URL}?` + new URLSearchParams({
            code: 'true',
            client_id: CLAUDE_OAUTH_CLIENT_ID,
            response_type: 'code',
            redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
            scope: 'user:inference',
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            state
        }).toString();

        res.json({ authUrl, state });
    } catch (err) {
        console.error('[Claude OAuth] Start error:', err);
        res.status(500).json({ error: 'Failed to start OAuth flow' });
    }
});

router.post('/claude-oauth/callback', requireSetupIncomplete, async (req, res) => {
    try {
        const { code, code_verifier } = req.body;

        if (!code || !code_verifier) {
            return res.status(400).json({ error: 'Missing code or code_verifier' });
        }

        // Claude's auth code format is "code#state" — split on # to extract both parts
        const hashIdx = code.indexOf('#');
        let authCode, authState;
        if (hashIdx !== -1) {
            authCode = code.substring(0, hashIdx);
            authState = code.substring(hashIdx + 1);
        } else {
            authCode = code;
            authState = undefined;
        }

        // Exchange authorization code using Python urllib (bypasses Cloudflare TLS fingerprinting)
        // Node fetch/curl get blocked, but Python's urllib has a different TLS fingerprint that passes
        const exchangePayload = JSON.stringify({
            grant_type: 'authorization_code',
            code: authCode,
            ...(authState ? { state: authState } : {}),
            client_id: CLAUDE_OAUTH_CLIENT_ID,
            redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
            code_verifier
        });

        console.log('[Claude OAuth] Exchanging code (length=%d, has state=%s, verifier length=%d)',
            authCode.length, !!authState, code_verifier.length);

        const scriptPath = join(dirname(new URL(import.meta.url).pathname), '..', 'utils', 'claude-token-exchange.py');
        const { stdout } = await execAsync(
            `echo ${JSON.stringify(exchangePayload)} | python3 ${scriptPath}`,
            { timeout: 20000 }
        );

        const result = JSON.parse(stdout.trim());
        console.log('[Claude OAuth] Exchange response code:', result.status);

        if (result.status !== 200) {
            console.error('[Claude OAuth] Exchange failed:', result.status, result.body?.substring(0, 200));
            return res.status(400).json({
                error: `Token exchange failed (HTTP ${result.status}). The code may have expired — please try again.`
            });
        }

        let tokenData;
        try {
            tokenData = JSON.parse(result.body);
        } catch (e) {
            console.error('[Claude OAuth] Invalid JSON response:', result.body?.substring(0, 200));
            return res.status(400).json({ error: 'Invalid response from Claude — please try again' });
        }

        const accessToken = tokenData.access_token;
        if (!accessToken) {
            return res.status(400).json({ error: 'No access token in response' });
        }

        // Store encrypted in instance_config
        const db = getDb();
        const setConfigVal = (key, value, isEncrypted = false) => {
            const storeValue = isEncrypted ? encrypt(value) : value;
            db.prepare(`
                INSERT INTO instance_config (key, value, encrypted, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value = ?, encrypted = ?, updated_at = datetime('now')
            `).run(key, storeValue, isEncrypted ? 1 : 0, storeValue, isEncrypted ? 1 : 0);
        };

        setConfigVal('claude_oauth_token', accessToken, true);
        console.log('[Claude OAuth] Token stored successfully');

        logAudit({
            action: AuditActions.CONFIG_API_KEY_SET,
            actor: { type: 'system', id: 'setup' },
            target: { type: 'config', id: 'claude_oauth' },
            status: 'success',
            request: req,
            details: 'Claude subscription token configured via OAuth'
        });

        res.json({ success: true, message: 'Claude subscription connected' });
    } catch (err) {
        console.error('[Claude OAuth] Callback error:', err);
        res.status(500).json({ error: 'Failed to complete OAuth flow: ' + err.message });
    }
});


/**
 * GET /api/setup/ssl-status
 * Check current SSL certificate status
 */
router.get('/ssl-status', (req, res) => {
    try {
        // Default cert paths (relative to project root)
        const certDir = process.env.CERT_DIR || '/var/lib/quox/certs';
        const certPath = join(certDir, 'cert.pem');
        const keyPath = join(certDir, 'key.pem');

        const hasCert = existsSync(certPath);
        const hasKey = existsSync(keyPath);

        let certInfo = null;
        if (hasCert) {
            try {
                // Get certificate expiry using openssl
                const { stdout } = require('child_process').execSync(
                    `openssl x509 -enddate -noout -in "${certPath}"`,
                    { encoding: 'utf8' }
                );
                const match = stdout.match(/notAfter=(.+)/);
                if (match) {
                    certInfo = {
                        expiresAt: new Date(match[1]).toISOString(),
                        path: certPath
                    };
                }
            } catch (e) {
                console.log('[SSL] Could not parse cert expiry:', e.message);
            }
        }

        // Get local IP for reference
        let localIp = '127.0.0.1';
        try {
            const nets = networkInterfaces();
            for (const name of Object.keys(nets)) {
                for (const net of nets[name]) {
                    if (net.family === 'IPv4' && !net.internal) {
                        localIp = net.address;
                        break;
                    }
                }
            }
        } catch (e) {
            // Ignore
        }

        res.json({
            hasCertificate: hasCert && hasKey,
            certInfo,
            localIp,
            httpsUrl: hasCert && hasKey ? `https://${localIp}:3000` : null
        });
    } catch (err) {
        console.error('[SSL Status] Error:', err);
        res.status(500).json({
            error: 'ssl_status_failed',
            message: err.message
        });
    }
});

/**
 * POST /api/setup/generate-ssl
 * Generate self-signed SSL certificate
 */
router.post('/generate-ssl', requireSetupIncomplete, async (req, res) => {
    try {
        // Get local IP address
        let localIp = '127.0.0.1';
        try {
            const nets = networkInterfaces();
            for (const name of Object.keys(nets)) {
                for (const net of nets[name]) {
                    if (net.family === 'IPv4' && !net.internal) {
                        localIp = net.address;
                        break;
                    }
                }
            }
        } catch (e) {
            console.log('[SSL] Could not detect local IP, using 127.0.0.1');
        }

        // Allow override from request — validate to prevent config injection
        const targetIp = req.body.ip || localIp;
        if (!isValidIpv4(targetIp)) {
            return res.status(400).json({ error: 'Invalid IP address format' });
        }

        // Cert directory (relative to project root)
        const certDir = process.env.CERT_DIR || '/var/lib/quox/certs';
        const certPath = join(certDir, 'cert.pem');
        const keyPath = join(certDir, 'key.pem');

        // Create certs directory if it doesn't exist
        mkdirSync(certDir, { recursive: true });

        // Create OpenSSL config for SAN
        const opensslConf = `[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = QuoxCORE

[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = ${targetIp}
`;

        // Write temp config file
        const confPath = join(certDir, 'openssl.cnf');
        writeFileSync(confPath, opensslConf);

        // Generate certificate using openssl
        const command = `openssl req -x509 -newkey rsa:2048 \
            -keyout "${keyPath}" \
            -out "${certPath}" \
            -days 365 -nodes \
            -config "${confPath}"`;

        console.log('[SSL] Generating certificate for localhost and', targetIp);

        const { stdout, stderr } = await execAsync(command);

        // Clean up temp config
        try {
            require('fs').unlinkSync(confPath);
        } catch (e) {
            // Ignore
        }

        console.log('[SSL] Certificate generated successfully');

        // Log for audit
        logAudit({
            action: 'ssl.certificate.generated',
            actor: { type: 'system', id: 'setup' },
            target: { type: 'config', id: 'ssl' },
            status: 'success',
            request: req,
            metadata: { ip: targetIp, certPath }
        });

        res.json({
            success: true,
            message: 'SSL certificate generated successfully',
            certPath,
            keyPath,
            localIp: targetIp,
            httpsUrl: `https://${targetIp}:3000`,
            expiresIn: '365 days',
            note: 'Your browser will show a security warning for self-signed certificates. This is expected - click "Advanced" > "Proceed" to continue.'
        });
    } catch (err) {
        console.error('[SSL] Certificate generation failed:', err);
        res.status(500).json({
            error: 'ssl_generation_failed',
            message: err.message
        });
    }
});

// ============================================================================
// BOOTSTRAP RESTORE — Restore from backup on fresh instances
// ============================================================================

const BACKUP_ROOT = process.env.BACKUP_ROOT || hostPath('backups');
// Writable temp dir inside the container's data volume (always writable by the app user)
const AUTH_DATA_DIR = process.env.AUTH_DB_PATH
    ? dirname(process.env.AUTH_DB_PATH)
    : '/var/lib/quox';

// Multer config for backup archive upload (500MB max)
const bootstrapUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dest = join(AUTH_DATA_DIR, '.bootstrap-upload');
            mkdirSync(dest, { recursive: true });
            cb(null, dest);
        },
        filename: (req, file, cb) => {
            cb(null, `bootstrap-${Date.now()}.tar.gz`);
        }
    }),
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['application/gzip', 'application/x-gzip', 'application/x-tar',
                         'application/x-compressed-tar', 'application/octet-stream'];
        if (allowed.includes(file.mimetype) || file.originalname.endsWith('.tar.gz') || file.originalname.endsWith('.tgz')) {
            cb(null, true);
        } else {
            cb(new Error('Only .tar.gz backup archives are accepted'));
        }
    }
});

/**
 * Run a shell command and return { stdout, stderr, code }
 */
function runBootstrapCommand(cmd, args, options = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { timeout: 300000, ...options });
        const MAX_OUT = 100 * 1024;
        let stdout = '', stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > MAX_OUT) stdout = stdout.slice(-MAX_OUT); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > MAX_OUT) stderr = stderr.slice(-MAX_OUT); });
        proc.on('close', (code) => resolve({ stdout, stderr, code }));
        proc.on('error', reject);
    });
}

/**
 * POST /api/setup/bootstrap-restore
 *
 * Upload a backup archive to bootstrap a fresh instance.
 * Only available when setup is not yet complete (no admin exists).
 *
 * Restores the auth database from the archive so existing users can log in.
 * Other components (memory, collector DBs, etc.) are restored if their
 * containers are running.
 *
 * Security: gated by requireSetupIncomplete — once an admin exists and
 * setup is marked complete, this endpoint returns 403.
 */
router.post('/bootstrap-restore',
    requireSetupIncomplete,
    apiLimiter,
    bootstrapUpload.single('archive'),
    async (req, res) => {
        const startTime = Date.now();
        let tempDir = null;

        try {
            if (!req.file) {
                return res.status(400).json({ error: 'No archive file uploaded' });
            }

            const archivePath = req.file.path;
            console.log(`[Bootstrap] Received archive: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);

            // Step 1: Extract archive to temp directory
            tempDir = join(AUTH_DATA_DIR, `.bootstrap-restore-${Date.now()}`);
            mkdirSync(tempDir, { recursive: true });

            const extractResult = await runBootstrapCommand('tar', ['-xzf', archivePath, '-C', tempDir]);
            if (extractResult.code !== 0) {
                throw new Error(`Failed to extract archive: ${extractResult.stderr}`);
            }

            // Find archive root (typically a timestamped directory inside)
            const entries = await fsPromises.readdir(tempDir);
            let archiveRoot = tempDir;
            if (entries.length === 1) {
                const innerPath = join(tempDir, entries[0]);
                const stat = await fsPromises.stat(innerPath);
                if (stat.isDirectory()) archiveRoot = innerPath;
            }

            // Step 2: Find auth.db in the archive
            const authDbCandidates = [
                join(archiveRoot, 'databases', 'auth.db'),
                join(archiveRoot, 'auth.db'),
            ];
            let authDbSource = null;
            for (const candidate of authDbCandidates) {
                if (existsSync(candidate)) {
                    authDbSource = candidate;
                    break;
                }
            }

            if (!authDbSource) {
                throw new Error('No auth.db found in backup archive. This may not be a valid QuoxCORE backup.');
            }

            // Step 3: Validate the auth.db has users
            const validateResult = await runBootstrapCommand('sqlite3', [authDbSource,
                "SELECT COUNT(*) FROM users;"
            ]);
            const userCount = parseInt(validateResult.stdout.trim(), 10);
            if (isNaN(userCount) || userCount === 0) {
                throw new Error('The backup auth database contains no user accounts.');
            }

            // Step 4: Back up the current (empty) auth.db
            const db = getDb();
            const currentDbPath = db.name; // SQLite database file path
            if (currentDbPath && currentDbPath !== ':memory:') {
                const backupPath = `${currentDbPath}.pre-bootstrap.${Date.now()}`;
                try {
                    await fsPromises.copyFile(currentDbPath, backupPath);
                    console.log(`[Bootstrap] Backed up current DB to ${backupPath}`);
                } catch (err) {
                    console.warn(`[Bootstrap] Could not back up current DB: ${err.message}`);
                }
            }

            // Step 5: Replace auth.db
            // Close the current database connection first
            db.close();

            await fsPromises.copyFile(authDbSource, currentDbPath);
            console.log(`[Bootstrap] Auth database restored (${userCount} users)`);

            // Step 6: Restore other databases if found and containers are running
            const restored = ['auth_db'];
            const skipped = [];

            // Map of component → { archivePath, container, containerDbPath }
            const otherDbs = [
                { key: 'memory_db', file: 'memory.db', container: 'quox-memory', containerPath: '/var/lib/quox/memory.db' },
                { key: 'collector_aee_db', file: 'aee.db', container: 'quox-collector', containerPath: '/var/lib/quox/aee.db' },
                { key: 'tasks_db', file: 'tasks.db', container: 'quox-tasks', containerPath: '/var/lib/quox/tasks.db' },
                { key: 'volt_db', file: 'volt.db', container: 'quox-collector', containerPath: '/var/lib/quox/volt.db' },
                { key: 'ward_db', file: 'ward.db', container: 'quox-collector', containerPath: '/var/lib/quox/ward.db' },
                { key: 'feedback_db', file: 'feedback.db', container: 'quox-collector', containerPath: '/var/lib/quox/feedback.db' },
            ];

            for (const comp of otherDbs) {
                const dbPath = join(archiveRoot, 'databases', comp.file);
                if (!existsSync(dbPath)) {
                    skipped.push({ key: comp.key, reason: 'not in archive' });
                    continue;
                }

                // Check if container is running
                const check = await runBootstrapCommand('docker', [
                    'inspect', '--format', '{{.State.Running}}', comp.container
                ]);
                if (check.stdout.trim() !== 'true') {
                    skipped.push({ key: comp.key, reason: `container ${comp.container} not running` });
                    continue;
                }

                // docker cp into container
                const cpResult = await runBootstrapCommand('docker', [
                    'cp', dbPath, `${comp.container}:${comp.containerPath}`
                ]);
                if (cpResult.code === 0) {
                    restored.push(comp.key);
                    console.log(`[Bootstrap] Restored ${comp.key} into ${comp.container}`);
                } else {
                    skipped.push({ key: comp.key, reason: `docker cp failed: ${cpResult.stderr}` });
                }
            }

            // Step 7: Restart containers that received new databases
            const containersToRestart = otherDbs
                .filter(comp => restored.includes(comp.key))
                .map(comp => comp.container);
            for (const ctr of containersToRestart) {
                console.log(`[Bootstrap] Restarting ${ctr} to load restored database...`);
                await runBootstrapCommand('docker', ['restart', ctr]);
            }

            // Step 8: Clean up
            await fsPromises.rm(tempDir, { recursive: true, force: true });
            await fsPromises.rm(archivePath, { force: true });
            tempDir = null;

            const duration = Date.now() - startTime;
            console.log(`[Bootstrap] Restore complete in ${duration}ms. Restored: ${restored.join(', ')}. Skipped: ${skipped.map(s => s.key).join(', ') || 'none'}`);

            res.json({
                success: true,
                message: `Bootstrap restore complete. ${userCount} user account(s) restored.`,
                restored,
                skipped,
                userCount,
                duration_ms: duration,
                next: 'The auth service will restart. You can then log in with your existing credentials.',
                requiresRestart: true
            });

            // Step 9: Restart the auth service after a short delay
            // This re-opens the database with the restored data
            setTimeout(() => {
                console.log('[Bootstrap] Restarting auth service to load restored database...');
                process.exit(0); // Docker will restart the container
            }, 2000);

        } catch (error) {
            console.error('[Bootstrap] Restore failed:', error.message);

            // Clean up temp dir on failure
            if (tempDir) {
                try { await fsPromises.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
            }
            if (req.file?.path) {
                try { await fsPromises.rm(req.file.path, { force: true }); } catch { /* ignore */ }
            }

            res.status(500).json({
                error: 'bootstrap_restore_failed',
                message: error.message
            });
        }
    }
);

/**
 * GET /api/setup/bootstrap-status
 *
 * Check if bootstrap restore is available (setup incomplete + no admin).
 * Returns archive info if a backup is found on the local filesystem.
 */
router.get('/bootstrap-status', requireSetupIncomplete, async (req, res) => {
    try {
        // Check for local backup archives
        const localArchives = [];
        if (existsSync(BACKUP_ROOT)) {
            const files = await fsPromises.readdir(BACKUP_ROOT);
            for (const file of files) {
                if (file.endsWith('.tar.gz')) {
                    const filePath = join(BACKUP_ROOT, file);
                    const stat = await fsPromises.stat(filePath);
                    localArchives.push({
                        name: file,
                        path: filePath,
                        size: stat.size,
                        created: stat.mtime.toISOString()
                    });
                }
            }
            // Sort newest first
            localArchives.sort((a, b) => new Date(b.created) - new Date(a.created));
        }

        res.json({
            available: true,
            localArchives: localArchives.slice(0, 10),
            maxUploadSize: 500 * 1024 * 1024,
            acceptedFormats: ['.tar.gz', '.tgz']
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/setup/bootstrap-restore-local
 *
 * Restore from a backup archive already on the local filesystem.
 * Avoids the need to upload large files over the network.
 */
router.post('/bootstrap-restore-local', requireSetupIncomplete, apiLimiter, async (req, res) => {
    const startTime = Date.now();
    let tempDir = null;

    try {
        const { archivePath } = req.body;
        if (!archivePath) {
            return res.status(400).json({ error: 'archivePath is required' });
        }

        // Security: only allow archives from BACKUP_ROOT
        const resolved = join(BACKUP_ROOT, basename(archivePath));
        if (!existsSync(resolved)) {
            return res.status(404).json({ error: 'Archive not found in backup directory' });
        }

        console.log(`[Bootstrap] Restoring from local archive: ${resolved}`);

        // Reuse the same restore logic — extract, find auth.db, replace, restart
        tempDir = join(AUTH_DATA_DIR, `.bootstrap-restore-${Date.now()}`);
        mkdirSync(tempDir, { recursive: true });

        const extractResult = await runBootstrapCommand('tar', ['-xzf', resolved, '-C', tempDir]);
        if (extractResult.code !== 0) {
            throw new Error(`Failed to extract archive: ${extractResult.stderr}`);
        }

        const entries = await fsPromises.readdir(tempDir);
        let archiveRoot = tempDir;
        if (entries.length === 1) {
            const innerPath = join(tempDir, entries[0]);
            const stat = await fsPromises.stat(innerPath);
            if (stat.isDirectory()) archiveRoot = innerPath;
        }

        // Find auth.db
        const authDbCandidates = [
            join(archiveRoot, 'databases', 'auth.db'),
            join(archiveRoot, 'auth.db'),
        ];
        let authDbSource = null;
        for (const candidate of authDbCandidates) {
            if (existsSync(candidate)) {
                authDbSource = candidate;
                break;
            }
        }
        if (!authDbSource) {
            throw new Error('No auth.db found in backup archive.');
        }

        // Validate
        const validateResult = await runBootstrapCommand('sqlite3', [authDbSource,
            "SELECT COUNT(*) FROM users;"
        ]);
        const userCount = parseInt(validateResult.stdout.trim(), 10);
        if (isNaN(userCount) || userCount === 0) {
            throw new Error('The backup auth database contains no user accounts.');
        }

        // Back up current DB
        const db = getDb();
        const currentDbPath = db.name;
        if (currentDbPath && currentDbPath !== ':memory:') {
            try {
                await fsPromises.copyFile(currentDbPath, `${currentDbPath}.pre-bootstrap.${Date.now()}`);
            } catch { /* ignore */ }
        }

        // Replace auth.db
        db.close();
        await fsPromises.copyFile(authDbSource, currentDbPath);

        // Restore other DBs into containers
        // CRITICAL: Must stop containers first, remove WAL/SHM files, copy DB, then start.
        // If we docker cp while the container is running, old WAL/SHM files corrupt the restored DB.
        const restored = ['auth_db'];
        const skipped = [];
        const restoreLog = [{ component: 'auth_db', status: 'restored', detail: `${userCount} users` }];
        const otherDbs = [
            { key: 'memory_db', file: 'memory.db', container: 'quox-memory', containerPath: '/var/lib/quox/memory.db' },
            { key: 'collector_aee_db', file: 'aee.db', container: 'quox-collector', containerPath: '/var/lib/quox/aee.db' },
            { key: 'tasks_db', file: 'tasks.db', container: 'quox-tasks', containerPath: '/var/lib/quox/tasks.db' },
            { key: 'volt_db', file: 'volt.db', container: 'quox-collector', containerPath: '/var/lib/quox/volt.db' },
            { key: 'ward_db', file: 'ward.db', container: 'quox-collector', containerPath: '/var/lib/quox/ward.db' },
            { key: 'feedback_db', file: 'feedback.db', container: 'quox-collector', containerPath: '/var/lib/quox/feedback.db' },
        ];

        // Group components by container so we stop/start each container only once
        const byContainer = {};
        for (const comp of otherDbs) {
            const dbPath = join(archiveRoot, 'databases', comp.file);
            if (!existsSync(dbPath)) {
                skipped.push({ key: comp.key, reason: 'not in archive' });
                restoreLog.push({ component: comp.key, status: 'skipped', detail: 'not in archive' });
                continue;
            }
            if (!byContainer[comp.container]) byContainer[comp.container] = [];
            byContainer[comp.container].push({ ...comp, dbPath });
        }

        // For each container: stop → remove WAL/SHM → copy all DBs → start
        for (const [container, comps] of Object.entries(byContainer)) {
            const check = await runBootstrapCommand('docker', ['inspect', '--format', '{{.State.Running}}', container]);
            if (check.stdout.trim() !== 'true') {
                for (const comp of comps) {
                    skipped.push({ key: comp.key, reason: 'container not running' });
                    restoreLog.push({ component: comp.key, status: 'skipped', detail: 'container not running' });
                }
                continue;
            }

            // Stop the container to release SQLite locks
            console.log(`[Bootstrap] Stopping ${container} for database restore...`);
            await runBootstrapCommand('docker', ['stop', container]);

            for (const comp of comps) {
                // Start container briefly to remove WAL/SHM, then stop again
                // Actually: with container stopped, docker cp still works (container filesystem is accessible)
                // Remove stale WAL/SHM files that would corrupt the restored DB
                await runBootstrapCommand('docker', ['cp', comp.dbPath, `${container}:${comp.containerPath}`]);
                // Remove WAL and SHM files — they belong to the old database, not the restored one
                const walPath = comp.containerPath + '-wal';
                const shmPath = comp.containerPath + '-shm';
                // Use docker start + exec + stop to clean WAL files, or create a tar with the clean db
                // Simpler: we can use a temp container to access the volume
                // Actually simplest: docker cp overwrites the .db file. We need to also send empty WAL/SHM.
                // Create empty placeholder files and copy them in
                const emptyWal = join(archiveRoot, 'databases', '_empty_wal');
                const emptySHM = join(archiveRoot, 'databases', '_empty_shm');
                await fsPromises.writeFile(emptyWal, '');
                await fsPromises.writeFile(emptySHM, '');
                await runBootstrapCommand('docker', ['cp', emptyWal, `${container}:${walPath}`]);
                await runBootstrapCommand('docker', ['cp', emptySHM, `${container}:${shmPath}`]);

                restored.push(comp.key);
                restoreLog.push({ component: comp.key, status: 'restored', detail: `copied to ${container}` });
                console.log(`[Bootstrap] Restored ${comp.key} into ${container}`);
            }

            // Start the container with clean database files
            console.log(`[Bootstrap] Starting ${container} with restored databases...`);
            await runBootstrapCommand('docker', ['start', container]);
        }

        // Restore PostgreSQL (QuoxFlow) if pgdump is in archive
        const pgDumpPath = join(archiveRoot, 'databases', 'quoxflow.pgdump');
        if (existsSync(pgDumpPath)) {
            try {
                const pgContainer = 'quox-postgres';
                const pgCheck = await runBootstrapCommand('docker', ['inspect', '--format', '{{.State.Running}}', pgContainer]);
                if (pgCheck.stdout.trim() === 'true') {
                    // Copy pgdump into container and restore
                    await runBootstrapCommand('docker', ['cp', pgDumpPath, `${pgContainer}:/tmp/quoxflow.pgdump`]);
                    // Get the postgres user from env or use default
                    const pgRestore = await runBootstrapCommand('docker', ['exec', pgContainer, 'pg_restore',
                        '--clean', '--if-exists', '--no-owner', '-U', 'quoxflow', '-d', 'quoxflow', '/tmp/quoxflow.pgdump']);
                    if (pgRestore.code === 0 || pgRestore.stderr.includes('WARNING')) {
                        restored.push('postgres_db');
                        restoreLog.push({ component: 'postgres_db', status: 'restored', detail: 'QuoxFlow database restored via pg_restore' });
                        console.log('[Bootstrap] Restored PostgreSQL (QuoxFlow)');
                    } else {
                        skipped.push({ key: 'postgres_db', reason: `pg_restore failed: ${pgRestore.stderr.slice(0, 200)}` });
                        restoreLog.push({ component: 'postgres_db', status: 'error', detail: pgRestore.stderr.slice(0, 200) });
                    }
                    await runBootstrapCommand('docker', ['exec', pgContainer, 'rm', '-f', '/tmp/quoxflow.pgdump']);
                } else {
                    skipped.push({ key: 'postgres_db', reason: 'container not running' });
                    restoreLog.push({ component: 'postgres_db', status: 'skipped', detail: 'container not running' });
                }
            } catch (pgErr) {
                console.error('[Bootstrap] PostgreSQL restore error:', pgErr.message);
                skipped.push({ key: 'postgres_db', reason: pgErr.message });
                restoreLog.push({ component: 'postgres_db', status: 'error', detail: pgErr.message });
            }
        }

        // Restore org logos if present in archive
        // Backup structure: org-logos/uploads/*.png — need to find the actual files
        const logosDir = join(archiveRoot, 'org-logos');
        if (existsSync(logosDir)) {
            try {
                const authContainer = 'quox-auth';
                // Ensure uploads dir exists in container
                await runBootstrapCommand('docker', ['exec', authContainer, 'mkdir', '-p', '/var/lib/quox/uploads']);
                // Find logo files — they may be in logosDir directly or in logosDir/uploads/
                const uploadsSubdir = join(logosDir, 'uploads');
                const actualLogosDir = existsSync(uploadsSubdir) ? uploadsSubdir : logosDir;
                const logoFiles = await fsPromises.readdir(actualLogosDir);
                let logoCount = 0;
                for (const file of logoFiles) {
                    const src = join(actualLogosDir, file);
                    const stat = await fsPromises.stat(src);
                    if (stat.isFile()) {
                        await runBootstrapCommand('docker', ['cp', src, `${authContainer}:/var/lib/quox/uploads/${file}`]);
                        logoCount++;
                    }
                }
                if (logoCount > 0) {
                    restored.push('org_logos');
                    restoreLog.push({ component: 'org_logos', status: 'restored', detail: `${logoCount} logo files` });
                    console.log(`[Bootstrap] Restored ${logoCount} organization logos`);
                }
            } catch (logoErr) {
                console.error('[Bootstrap] Logo restore error:', logoErr.message);
                restoreLog.push({ component: 'org_logos', status: 'error', detail: logoErr.message });
            }
        }

        // Restore AI-generated images if present
        // Backup structure: collector-images/images/*.png — need to find the actual files dir
        const imagesDir = join(archiveRoot, 'collector-images');
        if (existsSync(imagesDir)) {
            try {
                const collectorContainer = 'quox-collector';
                await runBootstrapCommand('docker', ['exec', collectorContainer, 'mkdir', '-p', '/var/lib/quox/images']);
                // Find images — they may be in imagesDir directly or in imagesDir/images/
                const imagesSubdir = join(imagesDir, 'images');
                const actualImagesDir = existsSync(imagesSubdir) ? imagesSubdir : imagesDir;
                const cpResult = await runBootstrapCommand('docker', ['cp', actualImagesDir + '/.', `${collectorContainer}:/var/lib/quox/images/`]);
                if (cpResult.code === 0) {
                    const imageFiles = (await fsPromises.readdir(actualImagesDir)).filter(f => !f.startsWith('.'));
                    restored.push('collector_images');
                    restoreLog.push({ component: 'collector_images', status: 'restored', detail: `${imageFiles.length} images` });
                    console.log(`[Bootstrap] Restored ${imageFiles.length} AI-generated images`);
                }
            } catch (imgErr) {
                console.error('[Bootstrap] Image restore error:', imgErr.message);
                restoreLog.push({ component: 'collector_images', status: 'error', detail: imgErr.message });
            }
        }

        // Clean up temp dir (keep the archive itself)
        await fsPromises.rm(tempDir, { recursive: true, force: true });
        tempDir = null;

        const duration = Date.now() - startTime;

        // Write audit log file — persists across auth restart since we write to the data dir
        // After auth restarts with the restored DB, it can read and ingest this log
        const auditLogEntry = {
            event: 'BOOTSTRAP_RESTORE',
            timestamp: new Date().toISOString(),
            archive: basename(resolved),
            duration_ms: duration,
            restored,
            skipped,
            restoreLog,
            userCount,
            source: 'setup-wizard'
        };
        console.log('[Bootstrap] Restore audit log:', JSON.stringify(auditLogEntry, null, 2));
        try {
            const auditPath = join(AUTH_DATA_DIR, 'bootstrap-restore-audit.json');
            // Append to array of audit entries
            let existing = [];
            try {
                const raw = await fsPromises.readFile(auditPath, 'utf-8');
                existing = JSON.parse(raw);
                if (!Array.isArray(existing)) existing = [existing];
            } catch { /* file doesn't exist yet */ }
            existing.push(auditLogEntry);
            await fsPromises.writeFile(auditPath, JSON.stringify(existing, null, 2));
        } catch (auditErr) {
            console.error('[Bootstrap] Failed to write audit log file:', auditErr.message);
        }

        res.json({
            success: true,
            message: `Bootstrap restore complete. ${userCount} user account(s) restored.`,
            restored, skipped, restoreLog, userCount, duration_ms: duration,
            next: 'The auth service will restart. You can then log in with your existing credentials.',
            requiresRestart: true
        });

        setTimeout(() => {
            console.log('[Bootstrap] Restarting auth service to load restored database...');
            process.exit(0);
        }, 2000);

    } catch (error) {
        console.error('[Bootstrap] Local restore failed:', error.message);
        // Log failures too
        try {
            const auditPath = join(AUTH_DATA_DIR, 'bootstrap-restore-audit.json');
            let existing = [];
            try { existing = JSON.parse(await fsPromises.readFile(auditPath, 'utf-8')); if (!Array.isArray(existing)) existing = [existing]; } catch {}
            existing.push({ event: 'BOOTSTRAP_RESTORE_FAILED', timestamp: new Date().toISOString(), error: error.message, duration_ms: Date.now() - startTime });
            await fsPromises.writeFile(auditPath, JSON.stringify(existing, null, 2));
        } catch {}
        if (tempDir) { try { await fsPromises.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ } }
        res.status(500).json({ error: 'bootstrap_restore_failed', message: error.message });
    }
});

// ============================================================================
// Instance Licensing (stored in instance_config, instance-wide)
// ============================================================================

import { requireInstanceAdmin } from '../middleware/instanceAdmin.js';
import { requireAdmin } from '../middleware/authorize.js';
import { getInstanceId } from '../lib/instanceIdentity.js';
import { activate as activateLicenseV2, deactivate as deactivateLicenseV2, renewAll as renewAllLeases, listStoredLeases, getRenewalHealth } from '../lib/licenseClient.js';
import { checkInstanceAdmin } from '../middleware/instanceAdmin.js';
import { hasRoleLevel, OrgRoles } from '../utils/policy.js';
// LICENSE-LAUNCH LL-8-dash: the box half of the device-code flow, so an
// instance can be activated with nothing pasted into it.
import { startDeviceActivation, pollDeviceActivation, pollFreeDeviceActivation } from '../lib/deviceActivationClient.js';
import { getEntitlements, getLicenseSummaries, getEntitlementErrors, hasPlugin, resolvePluginAccess, tierForPlugin, clearEntitlementsCache, releaseOrgSlot, listBandHolders, getOrgSlotsSummary, getOrgBands, LICENSE_GOVERNED_PLUGINS, CATALOG_DISPLAY, FALLBACK_GOVERNED_PLUGIN_IDS, FALLBACK_FREE_ENTITLEMENT_IDS } from '../lib/entitlements.js';
// LICENSE-LAUNCH LL-8: the self-serve free-claim device flow (org owner/admin,
// NOT instance admin) reuses the same catalogue + guard the client uses.
import { loadSignedCatalog } from '../lib/signedCatalog.js';
import { freeOnlyIdSet } from '../lib/freeClaimGuard.js';

/**
 * GET /setup/licensing
 * Returns the instance license. Any authenticated user can read.
 */
router.get('/licensing', authenticate(), (req, res) => {
    try {
        const db = getDb();
        const row = db.prepare(
            "SELECT value FROM instance_config WHERE key = 'licensing.license'"
        ).get();

        if (!row) {
            return res.json({ licensing: null });
        }

        try {
            const data = JSON.parse(row.value);
            res.json({ licensing: data });
        } catch {
            res.json({ licensing: null });
        }
    } catch (err) {
        console.error('Get licensing error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch licensing' });
    }
});

/**
 * PUT /setup/licensing
 * RETIRED — LICENSE-ENFORCE LE-3d. This paste-a-JSON-blob activation path had
 * no server-side signature verification (docs/STREAM_LICENSE_ENFORCE.md §2.1)
 * — the checked-fields-exist validation below was the entire "check". Licence
 * activation now goes through the seat-bound Ed25519 flow at
 * POST /setup/licensing/activate (see §11.1). GET and DELETE stay (read the
 * legacy row / let an admin clear it) but writes here are permanently closed.
 */
router.put('/licensing', authenticate(), requireInstanceAdmin('admin'), (req, res) => {
    res.status(410).json({
        error: 'gone',
        message: 'Licence activation now goes through POST /api/setup/licensing/activate (seat-bound). Paste-to-store is retired.',
    });
});

/**
 * DELETE /setup/licensing
 * Deactivate the instance license. Instance admin only.
 */
router.delete('/licensing', authenticate(), requireInstanceAdmin('admin'), (req, res) => {
    try {
        const db = getDb();
        db.prepare("DELETE FROM instance_config WHERE key = 'licensing.license'").run();

        // KEY-AUDIT #2: same 4-positional-args bug as the PUT above → 500 on
        // instance-license DELETE. Fixed to the single-object shape.
        logAudit({
            action: AuditActions.CONFIG_UPDATE,
            actor: { type: 'user', id: req.user.id },
            target: { type: 'instance_license', id: 'licensing.license' },
            status: 'success',
            request: req,
            metadata: { action: 'license_deactivated' }
        });

        res.json({ success: true });
    } catch (err) {
        console.error('Delete licensing error:', err);
        res.status(500).json({ error: 'delete_failed', message: 'Failed to remove licensing' });
    }
});

// ============================================================================
// Per-Plugin Licensing (third-party plugins, stored in instance_config,
// instance-wide — mirrors instance licensing above exactly, per bug audit:
// per-plugin licenses were previously localStorage-ONLY with no server table
// and no read endpoint, so they didn't survive a browser clear/new device).
// Storage key format: 'plugin-license.<pluginId>' (one row per plugin, same
// instance_config table as 'licensing.license' above).
// ============================================================================

// Mirrors src/services/licenseValidator.js embedded Ed25519 public key
// (PLUGIN_LICENSE_PUBLIC_KEY, currently == PUBLIC_KEY_BASE64).
// Duplicated here rather than imported — auth is a separate Node service
// from the Vite frontend bundle. Keep in sync manually if the client key
// ever rotates.
// LE-AUDIT HIGH: rotated off the retired '2J4YMI3c…' key (its private half
// leaked on the dev box) onto the current licensing public key, matching the
// frontend (src/services/licenseValidator.js PLUGIN_LICENSE_PUBLIC_KEY). The
// old key must never verify again.
const PLUGIN_LICENSE_PUBLIC_KEY_BASE64 = '/BHDWJ2RPT6UmwnCB2z9CJZ+oJhhYgRkMEc/ZrtYFWw=';

// Ed25519 SubjectPublicKeyInfo DER prefix for a raw 32-byte public key
// (same constant used elsewhere in this service — utils/plugins.js
// verifyPluginSignature() and lib/crystalSigningKey.js).
const PLUGIN_LICENSE_ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const PLUGIN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Verify a plugin license's Ed25519 signature server-side.
 * Mirrors src/services/licenseValidator.js validatePluginLicense() signed-data
 * construction EXACTLY (confirmed at ~L615):
 *   license.id + license.customer_id + license.scope + license.expires_at
 * — raw string concatenation, NOT ISO-normalized (unlike the instance
 * license's buildSignedData(), which does new Date(expires_at).toISOString()).
 *
 * LICENSE-ENFORCE LE-3d: the trial-marker and `HMAC:`-prefix accept branches
 * that used to skip cryptographic verification entirely (docs/
 * STREAM_LICENSE_ENFORCE.md §2.1 — "this string activates a full enterprise
 * licence") are REMOVED. Ed25519 only — every license must present a real
 * signature that verifies against the embedded public key or it is rejected.
 */
function verifyPluginLicenseSignature(license) {
    if (!license || !license.signature) return { valid: false, reason: 'missing_signature' };

    try {
        const signedData = String(license.id) + String(license.customer_id) + String(license.scope) + String(license.expires_at);
        const dataBytes = Buffer.from(signedData, 'utf-8');
        const publicKeyBytes = Buffer.from(PLUGIN_LICENSE_PUBLIC_KEY_BASE64, 'base64');
        const pubKey = createPublicKey({
            key: Buffer.concat([PLUGIN_LICENSE_ED25519_SPKI_PREFIX, publicKeyBytes]),
            format: 'der',
            type: 'spki',
        });
        const signatureBytes = Buffer.from(license.signature, 'base64');
        const ok = cryptoVerify(null, dataBytes, pubKey, signatureBytes); // Ed25519 takes no digest algorithm
        return ok ? { valid: true } : { valid: false, reason: 'bad_signature' };
    } catch (err) {
        return { valid: false, reason: 'verify_error', error: err.message };
    }
}

/**
 * GET /setup/plugin-licenses
 * Returns all instance-wide plugin licenses, keyed by pluginId.
 * Any authenticated user can read (mirrors GET /licensing).
 */
router.get('/plugin-licenses', authenticate(), (req, res) => {
    try {
        const db = getDb();
        const rows = db.prepare(
            "SELECT key, value FROM instance_config WHERE key LIKE 'plugin-license.%'"
        ).all();

        const licenses = {};
        for (const row of rows) {
            const pluginId = row.key.slice('plugin-license.'.length);
            try {
                licenses[pluginId] = JSON.parse(row.value);
            } catch {
                // skip corrupted row rather than fail the whole response
            }
        }

        res.json({ licenses });
    } catch (err) {
        console.error('Get plugin licenses error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch plugin licenses' });
    }
});

/**
 * PUT /setup/plugin-licenses/:pluginId
 * Activate/update a third-party plugin license.
 *
 * NOT instance-admin gated (unlike PUT /licensing above) — this mirrors the
 * CURRENT client flow, where any authenticated user can install a plugin and
 * activate its license via ThirdPartyPluginInstaller (no admin check exists
 * there today). Gating this behind requireInstanceAdmin would be more
 * consistent with the instance license but would break that existing flow.
 * PRODUCT DECISION LOGGED, NOT MADE: should plugin-license activation be
 * instance-admin (or org-admin) gated? Left to owner/orchestrator review.
 *
 * Body: { license: { id, customer_id, scope, expires_at, signature, ... } }
 */
router.put('/plugin-licenses/:pluginId', authenticate(), (req, res) => {
    try {
        const { pluginId } = req.params;
        if (!PLUGIN_ID_PATTERN.test(pluginId || '')) {
            return res.status(400).json({ error: 'validation_error', message: 'Invalid pluginId' });
        }

        const { license } = req.body;
        if (!license || !license.id || !license.customer_id || !license.scope || !license.expires_at || !license.signature) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Missing required license fields (id, customer_id, scope, expires_at, signature)'
            });
        }

        const expectedScope = `plugin:${pluginId}`;
        if (license.scope !== expectedScope) {
            return res.status(400).json({
                error: 'validation_error',
                message: `License scope mismatch: expected ${expectedScope}, got ${license.scope}`
            });
        }

        const verification = verifyPluginLicenseSignature(license);
        if (!verification.valid) {
            return res.status(400).json({
                error: 'invalid_signature',
                message: 'Plugin license signature verification failed',
                reason: verification.reason
            });
        }

        const db = getDb();
        const key = `plugin-license.${pluginId}`;
        const data = JSON.stringify({
            license,
            activated_at: new Date().toISOString(),
            activated_by: req.user.id
        });

        db.prepare(`
            INSERT INTO instance_config (key, value, value_type, description, updated_at, updated_by)
            VALUES (?, ?, 'json', 'Third-party plugin license', datetime('now'), ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                value_type = 'json',
                updated_at = datetime('now'),
                updated_by = excluded.updated_by
        `).run(key, data, req.user.id);

        logAudit({
            action: AuditActions.CONFIG_UPDATE,
            actor: { type: 'user', id: req.user.id },
            target: { type: 'plugin_license', id: pluginId },
            status: 'success',
            request: req,
            metadata: { action: 'plugin_license_activated', plugin_id: pluginId, license_id: license.id }
        });

        res.json({ success: true, licensing: JSON.parse(data) });
    } catch (err) {
        console.error('Put plugin license error:', err);
        res.status(500).json({ error: 'save_failed', message: 'Failed to save plugin license' });
    }
});

/**
 * DELETE /setup/plugin-licenses/:pluginId
 * Deactivate a third-party plugin license (same gating decision as PUT above).
 */
router.delete('/plugin-licenses/:pluginId', authenticate(), (req, res) => {
    try {
        const { pluginId } = req.params;
        if (!PLUGIN_ID_PATTERN.test(pluginId || '')) {
            return res.status(400).json({ error: 'validation_error', message: 'Invalid pluginId' });
        }

        const db = getDb();
        db.prepare("DELETE FROM instance_config WHERE key = ?").run(`plugin-license.${pluginId}`);

        logAudit({
            action: AuditActions.CONFIG_UPDATE,
            actor: { type: 'user', id: req.user.id },
            target: { type: 'plugin_license', id: pluginId },
            status: 'success',
            request: req,
            metadata: { action: 'plugin_license_deactivated', plugin_id: pluginId }
        });

        res.json({ success: true });
    } catch (err) {
        console.error('Delete plugin license error:', err);
        res.status(500).json({ error: 'delete_failed', message: 'Failed to remove plugin license' });
    }
});

// ============================================================================
// LICENSE-ENFORCE LE-2 — Ed25519 license-v2 activation, leases, entitlements
// (docs/STREAM_LICENSE_ENFORCE.md §11.1). Distinct from the HMAC-era routes
// above (kept as-is for LE-3 to burn the bridges on). This is the real
// server-enforced gate: per-plugin entitlements come from a signed lease
// bound to THIS instance, verified against an embedded Ed25519 public key.
// ============================================================================

/**
 * GET /setup/internal/has-plugin
 * Internal-only. This is the endpoint services/tasks/lib/licenseGate.js and
 * services/collector/lib/licenseGate.js call — contract:
 * `{ licensed: boolean, tier: string|null }`.
 * `org` is passed through to hasPlugin() — meaningful only for org-scoped
 * entitlements (`<pluginId>@orgs=N`, LICENSE-ENFORCE LE-3c); whole-install
 * entitlements ignore it, same as before.
 */
router.get('/internal/has-plugin', (req, res) => {
    try {
        const auth = authorizeInternalServiceRequest(req);
        if (!auth.authorized) {
            console.warn(`[Security] Rejected has-plugin request from: ${auth.clientIp} (${auth.reason})`);
            return res.status(403).json({ error: 'forbidden', message: 'Internal endpoint only' });
        }

        const pluginId = String(req.query.plugin || '').trim();
        if (!pluginId) {
            return res.status(400).json({ error: 'validation_error', message: 'plugin query param required' });
        }
        const orgId = req.query.org ? String(req.query.org).trim() : undefined;

        const db = getDb();
        const access = resolvePluginAccess(db, pluginId, orgId);
        res.json({
            licensed: access.licensed,
            tier: tierForPlugin(db, pluginId),
            ...(access.reason ? { reason: access.reason } : {}),
            // PLUGIN-IMG #1012: lapsed-lease read-only grace (never a licence).
            ...(access.lapsed ? { lapsed: true, lease_expired_at: access.lapsed.lease_expired_at, read_only_until: access.lapsed.read_only_until } : {}),
        });
    } catch (err) {
        console.error('[has-plugin] error:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to resolve plugin entitlement' });
    }
});

/**
 * POST /setup/licensing/activate
 * Activate an Ed25519 license-v2 key against this instance. Instance admin
 * only (same gating as PUT /licensing above).
 * Body: { license_key: string }
 */
router.post('/licensing/activate', authenticate(), requireInstanceAdmin('admin'), async (req, res) => {
    try {
        const { license_key } = req.body || {};
        if (!license_key || typeof license_key !== 'string') {
            return res.status(400).json({ error: 'validation_error', message: 'license_key is required' });
        }

        const result = await activateLicenseV2(license_key);

        if (!result.ok) {
            if (result.status === 409) {
                // LL-3b: forward the control plane's seat context verbatim
                // (`seat_limit_reached` + `bound[]` + `max_servers` from
                // LL-2a) so `quox setup license activate` can render "3 of 3
                // servers in use" with the list. Same defensive rule as
                // licenseClient.activate(): present fields only, nothing
                // invented — cli/lib/commands/setup.js already renders each of
                // these when they arrive and degrades cleanly when they don't.
                const body = { error: result.error || 'seat_taken' };
                if (result.bound_instance_name != null) body.bound_instance_name = result.bound_instance_name;
                if (Array.isArray(result.bound)) body.bound = result.bound;
                if (result.max_servers != null) body.max_servers = result.max_servers;
                if (result.message) body.message = result.message;
                return res.status(409).json(body);
            }
            const status = (result.status >= 400 && result.status < 600) ? result.status : 502;
            return res.status(status).json({ error: result.error || 'activation_failed', message: result.message });
        }

        clearEntitlementsCache();

        logAudit({
            action: AuditActions.CONFIG_UPDATE,
            actor: { type: 'user', id: req.user.id },
            target: { type: 'instance_license_v2', id: result.lease.license_id },
            status: 'success',
            request: req,
            metadata: { action: 'license_v2_activated', license_id: result.lease.license_id, entitlements: result.lease.entitlements }
        });

        res.json({
            success: true,
            lease: {
                license_id: result.lease.license_id,
                entitlements: result.lease.entitlements,
                expires_at: result.lease.expires_at,
            },
        });
    } catch (err) {
        console.error('POST /licensing/activate error:', err);
        res.status(500).json({ error: 'activation_failed', message: 'Failed to activate license' });
    }
});

/**
 * RETIRED (LICENSE-LAUNCH LL-1a, owner ruling R7): POST /setup/licensing/import.
 * The offline import accepted a signed license-key-v2 object with no
 * control-plane activation and no instance binding, so one paid key could run
 * unlimited installs. Online activation (POST /licensing/activate above) is
 * mandatory — there is no offline path. Guard:
 * tests/license-offline-import-removed.test.js.
 */

/**
 * POST /setup/licensing/deactivate
 * Release this instance's seat for a license (frees it for reactivation
 * elsewhere). Instance admin only.
 * Body: { license_id: string }
 */
router.post('/licensing/deactivate', authenticate(), requireInstanceAdmin('admin'), async (req, res) => {
    try {
        const { license_id } = req.body || {};
        if (!license_id || typeof license_id !== 'string') {
            return res.status(400).json({ error: 'validation_error', message: 'license_id is required' });
        }

        const result = await deactivateLicenseV2(license_id);
        clearEntitlementsCache();

        logAudit({
            action: AuditActions.CONFIG_UPDATE,
            actor: { type: 'user', id: req.user.id },
            target: { type: 'instance_license_v2', id: license_id },
            status: 'success',
            request: req,
            metadata: { action: 'license_v2_deactivated', license_id, remote: !!result.remote }
        });

        res.json({ success: true, remote: !!result.remote });
    } catch (err) {
        console.error('POST /licensing/deactivate error:', err);
        res.status(500).json({ error: 'deactivation_failed', message: 'Failed to deactivate license' });
    }
});

// ── LICENSE-LAUNCH LL-8-dash: device-code activation ─────────────────────
//
// Activation with no key paste. The instance asks quox.ai for a code pair,
// shows the short one to a human, and polls until a logged-in customer
// approves it on quox.ai/link. Both routes are instance-admin gated exactly
// like /licensing/activate: a licence binds THIS instance, so the person
// doing it has to be the person who runs the instance.
//
// The dashboard and the CLI come through here rather than calling
// api.quox.ai directly, so the whole activation stays on one authenticated
// surface and the box's identity is never supplied by a client.

/**
 * POST /setup/licensing/device/start
 * Body: {} — the instance identity comes from instance_config, never from
 * the caller.
 */
router.post('/licensing/device/start', authenticate(), requireInstanceAdmin('admin'), async (req, res) => {
    try {
        const result = await startDeviceActivation();

        if (result.state === 'unreachable') {
            return res.status(503).json({ error: 'license_server_unreachable', message: result.message });
        }
        if (result.state !== 'started') {
            const status = (result.status >= 400 && result.status < 600) ? result.status : 502;
            return res.status(status).json({ error: result.error || 'device_start_failed', message: result.message });
        }

        logAudit({
            action: AuditActions.CONFIG_UPDATE,
            actor: { type: 'user', id: req.user.id },
            target: { type: 'instance_license_device', id: result.user_code },
            status: 'success',
            request: req,
            // The user_code is the half a human reads aloud; the device_code
            // is this box's bearer secret and is deliberately not recorded.
            metadata: { action: 'license_device_activation_started', user_code: result.user_code, instance_id: result.instance_id }
        });

        res.json({
            device_code: result.device_code,
            user_code: result.user_code,
            verification_url: result.verification_url,
            expires_in: result.expires_in,
            interval: result.interval,
            instance_name: result.instance_name,
        });
    } catch (err) {
        console.error('POST /licensing/device/start error:', err);
        res.status(500).json({ error: 'device_start_failed', message: 'Failed to start device activation' });
    }
});

/**
 * POST /setup/licensing/device/poll
 * Body: { device_code: string, interval?: number }
 *
 * Flow states (pending / slow_down / approved / denied / expired / consumed)
 * come back as 200 with a `state` field: they are legitimate steps of the
 * flow, not HTTP faults. The two genuine faults keep their status codes —
 * 409 for a full licence (same shape /licensing/activate answers with, so the
 * CLI's existing seat renderer covers both) and 503 for an unreachable
 * control plane.
 */
router.post('/licensing/device/poll', authenticate(), requireInstanceAdmin('admin'), async (req, res) => {
    try {
        const { device_code, interval } = req.body || {};
        if (!device_code || typeof device_code !== 'string') {
            return res.status(400).json({ error: 'validation_error', message: 'device_code is required' });
        }

        const result = await pollDeviceActivation(device_code, { interval });

        if (result.state === 'unreachable') {
            // NOT terminal: the activation is still alive upstream, the
            // customer may still be approving it. The client keeps polling.
            return res.status(503).json({ error: 'license_server_unreachable', message: result.message, state: 'unreachable' });
        }

        if (result.state === 'seat_limit_reached') {
            const body = { error: 'seat_limit_reached', state: result.state, terminal: true };
            if (result.max_servers != null) body.max_servers = result.max_servers;
            if (Array.isArray(result.bound)) body.bound = result.bound;
            if (result.bound_instance_name != null) body.bound_instance_name = result.bound_instance_name;
            return res.status(409).json(body);
        }

        if (result.state === 'error') {
            const status = (result.status >= 400 && result.status < 600) ? result.status : 502;
            return res.status(status).json({ error: result.error || 'device_poll_failed', message: result.message, state: 'error' });
        }

        if (result.state === 'approved') {
            clearEntitlementsCache();
            logAudit({
                action: AuditActions.CONFIG_UPDATE,
                actor: { type: 'user', id: req.user.id },
                target: { type: 'instance_license_v2', id: result.lease.license_id },
                status: 'success',
                request: req,
                metadata: { action: 'license_v2_activated_by_device', license_id: result.lease.license_id, entitlements: result.lease.entitlements }
            });

            return res.json({
                state: 'approved',
                terminal: true,
                lease: {
                    license_id: result.lease.license_id,
                    entitlements: result.lease.entitlements,
                    expires_at: result.lease.expires_at,
                },
            });
        }

        // pending | slow_down | denied | expired | consumed | activation_failed
        const body = { state: result.state };
        if (result.terminal) body.terminal = true;
        if (result.interval != null) body.interval = result.interval;
        if (result.error) body.error = result.error;
        if (result.message) body.message = result.message;
        res.json(body);
    } catch (err) {
        console.error('POST /licensing/device/poll error:', err);
        res.status(500).json({ error: 'device_poll_failed', message: 'Failed to poll device activation' });
    }
});

// ── LICENSE-LAUNCH LL-8: self-serve FREE-CLAIM device flow ─────────────────
//
// Owner ruling: free (conversion-ladder) plugins get a self-serve claim path
// WITHOUT instance admin. Deliberately gated on ORG role (owner or admin via
// requireAdmin() from middleware/authorize.js, the same gate integrations.js
// and orgs.js use) rather than requireInstanceAdmin('admin') above — this is
// the entire point of LL-8, so it is asserted explicitly in
// tests/free-claim-device-routes.test.js.
//
// The two device routes above (paid, instance-admin) are UNTOUCHED by this
// addition. This path can only ever activate a key that clears
// lib/freeClaimGuard.js assertFreeOnlyLicenseKey() — see pollFreeDeviceActivation
// in lib/deviceActivationClient.js for the fail-closed guard call.

const FREE_CLAIM_PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * POST /setup/licensing/free/device/start
 * Body: { plugin_ids: string[] }, 1 to 12 ids. Each id is split into
 * ACCEPTED (exists in the signed catalogue AND is free, price === 0) or
 * REFUSED ({ plugin_id, reason }), reason is 'not_free' for an id the
 * catalogue prices as paid or leaves price-unknown, 'unknown_plugin' for an
 * id the catalogue has never heard of. The request 403s only when accepted is
 * empty; a mixed request proceeds with the accepted subset so catalogue or
 * manifest drift on one id does not brick a claim that is otherwise valid
 * (the all-or-nothing refusal this replaces bricked the live acceptance run:
 * one drifted id zeroed a claim that included several genuinely free
 * plugins).
 */
router.post('/licensing/free/device/start', authenticate(), requireAdmin(), async (req, res) => {
    try {
        const { plugin_ids } = req.body || {};
        if (!Array.isArray(plugin_ids) || plugin_ids.length < 1 || plugin_ids.length > 12) {
            return res.status(400).json({ error: 'validation_error', message: 'plugin_ids must be an array of 1 to 12 ids' });
        }
        for (const id of plugin_ids) {
            if (typeof id !== 'string' || !FREE_CLAIM_PLUGIN_ID_RE.test(id)) {
                return res.status(400).json({ error: 'validation_error', message: `invalid plugin id: ${String(id)}` });
            }
        }

        // Never a hardcoded id list: the signed catalogue (or its documented
        // pre-cutover fallback) is the sole authority on what is free.
        const catalog = loadSignedCatalog();
        const freeIds = freeOnlyIdSet(catalog);
        // The full known-id universe, so a refusal can name WHY: present in
        // the catalogue but not free ('not_free'), or absent altogether
        // ('unknown_plugin'). Falls back to the same pre-cutover id lists the
        // paid/free predicates already use when no signed snapshot is
        // installed, so the reason stays meaningful pre-cutover too.
        const knownIds = catalog
            ? new Set(catalog.products.filter((p) => p && typeof p.id === 'string').map((p) => p.id))
            : new Set([...FALLBACK_GOVERNED_PLUGIN_IDS, ...FALLBACK_FREE_ENTITLEMENT_IDS]);

        const accepted = [];
        const refused = [];
        for (const id of plugin_ids) {
            if (freeIds.has(id)) {
                accepted.push(id);
            } else {
                refused.push({ plugin_id: id, reason: knownIds.has(id) ? 'not_free' : 'unknown_plugin' });
            }
        }

        if (accepted.length === 0) {
            return res.status(403).json({ error: 'free_only', refused });
        }

        const result = await startDeviceActivation({ requested: { kind: 'free_claim', plugin_ids: accepted } });

        if (result.state === 'unreachable') {
            return res.status(503).json({ error: 'license_server_unreachable', message: result.message });
        }
        if (result.state !== 'started') {
            const status = (result.status >= 400 && result.status < 600) ? result.status : 502;
            return res.status(status).json({ error: result.error || 'device_start_failed', message: result.message });
        }

        logAudit({
            action: AuditActions.CONFIG_UPDATE,
            actor: { type: 'user', id: req.user.id },
            target: { type: 'free_claim_device', id: result.user_code },
            status: 'success',
            request: req,
            // device_code is this box's bearer secret and is deliberately not
            // recorded, same posture as the paid device/start route above.
            metadata: { action: 'free_claim_device_activation_started', user_code: result.user_code, plugin_ids: accepted, refused: refused.map((r) => r.plugin_id) },
        });

        res.json({
            device_code: result.device_code,
            user_code: result.user_code,
            verification_url: result.verification_url,
            expires_in: result.expires_in,
            interval: result.interval,
            instance_name: result.instance_name,
            accepted,
            refused,
        });
    } catch (err) {
        console.error('POST /licensing/free/device/start error:', err);
        res.status(500).json({ error: 'device_start_failed', message: 'Failed to start free claim device activation' });
    }
});

/**
 * POST /setup/licensing/free/device/poll
 * Body: { device_code: string, interval?: number }
 *
 * Delegates to pollFreeDeviceActivation(), which runs the FREE-ONLY GUARD over
 * every entry an `approved` poll carries before activating anything. A
 * `contract_violation` means the control plane approved a key this box
 * refuses to trust as free-claim — nothing was stored.
 */
router.post('/licensing/free/device/poll', authenticate(), requireAdmin(), async (req, res) => {
    try {
        const { device_code, interval } = req.body || {};
        if (!device_code || typeof device_code !== 'string') {
            return res.status(400).json({ error: 'validation_error', message: 'device_code is required' });
        }

        const result = await pollFreeDeviceActivation(device_code, { interval });

        if (result.state === 'unreachable') {
            return res.status(503).json({ error: 'license_server_unreachable', message: result.message, state: 'unreachable' });
        }

        if (result.state === 'seat_limit_reached') {
            const body = { error: 'seat_limit_reached', state: result.state, terminal: true };
            if (result.max_servers != null) body.max_servers = result.max_servers;
            if (Array.isArray(result.bound)) body.bound = result.bound;
            if (result.bound_instance_name != null) body.bound_instance_name = result.bound_instance_name;
            return res.status(409).json(body);
        }

        if (result.state === 'contract_violation') {
            // Fail-closed refusal from the guard, not a client mistake and not
            // a normal upstream refusal — the control plane approved a key
            // this box will not trust as a free claim. Nothing was activated.
            return res.status(502).json({ error: result.error, state: result.state, terminal: true });
        }

        if (result.state === 'error') {
            const status = (result.status >= 400 && result.status < 600) ? result.status : 502;
            return res.status(status).json({ error: result.error || 'device_poll_failed', message: result.message, state: 'error' });
        }

        if (result.state === 'approved') {
            clearEntitlementsCache();
            logAudit({
                action: AuditActions.CONFIG_UPDATE,
                actor: { type: 'user', id: req.user.id },
                target: { type: 'free_claim_device', id: device_code },
                status: 'success',
                request: req,
                metadata: {
                    action: 'free_claim_device_activated',
                    results: result.results.map((r) => ({ license_id: r.license_id, ok: r.ok })),
                },
            });

            return res.json({ state: 'approved', terminal: true, results: result.results });
        }

        // pending | slow_down | denied | expired | consumed | activation_failed
        const body = { state: result.state };
        if (result.terminal) body.terminal = true;
        if (result.interval != null) body.interval = result.interval;
        if (result.error) body.error = result.error;
        if (result.message) body.message = result.message;
        res.json(body);
    } catch (err) {
        console.error('POST /licensing/free/device/poll error:', err);
        res.status(500).json({ error: 'device_poll_failed', message: 'Failed to poll free claim device activation' });
    }
});

/**
 * GET /setup/licensing/entitlements
 * Any authenticated user can read. Frontend-facing summary of this
 * instance's licensing state (LE-3 wires the UI to this).
 */
router.get('/licensing/entitlements', authenticate(), (req, res) => {
    try {
        const db = getDb();
        // LICENSE-LAUNCH LL-3b: the caller's org, resolved exactly the way
        // authenticate() derives it (req.org is set only when the access token
        // carries an org_id AND the membership is live). Null for an
        // instance-scoped caller — org_licensed then reads null, not true.
        const orgId = req.org?.id || null;
        res.json({
            entitlements: Array.from(getEntitlements(db)),
            licenses: getLicenseSummaries(db),
            instance_id: getInstanceId(db),
            // LL-3b: per-plugin org-band state for every org-scoped grant
            // (`<pluginId>@orgs=N`). ADDITIVE — every field above is
            // unchanged, so an older frontend keeps working (flat, and
            // over-permissive for excess orgs; that is the defect this
            // closes, and the fix lands with the frontend that reads this).
            //
            // assigned_orgs carries raw org ids. That matches the exposure
            // GET /setup/licensing/org-slots already gives EVERY authenticated
            // caller on this same instance (see below), so this adds no new
            // disclosure; keeping the two shapes identical also means the
            // Settings slot table and the plugin cards cannot disagree.
            org_bands: getOrgBands(db, orgId),
            org_id: orgId,
            // LICENSE-LAUNCH LL-2e (cutover): entries a verified lease carried
            // that this install REFUSED, each naming the id. Today that is the
            // bare-paid-entitlement case: an unbanded paid id would have meant
            // whole install, so it grants nothing and says so here. Without
            // this the plugin simply goes dark and the admin has nothing to
            // read; with it, the licensing screen can say which id to get
            // reissued with a band.
            entitlement_errors: getEntitlementErrors(db),
            // QTG-PRO: the licence-governed plugin universe, so the frontend
            // gate can mirror hasPlugin() semantics exactly: a plugin outside
            // this set is not licence-governed and always passes. Without it
            // the frontend fail-closed entitlement set hides non-governed
            // plugins the backend would happily serve.
            governed: Array.from(LICENSE_GOVERNED_PLUGINS),
            // LICENSE-LAUNCH LL-4c: the signed catalogue as DISPLAY metadata
            // ({ id, tier, category, sellable } per product), so clients stop
            // trusting their own hand-typed tier lists (the dashboard's
            // PLUGIN_TIERS knew 33 of 60 ids and guessed the rest).
            //
            // OMITTED, not null/[], when no verified snapshot is installed:
            // absence is the signal a client falls back on, and an empty array
            // would read as "the authority says there are no products". The
            // switchover therefore happens by itself the moment the owner
            // installs the artifact generated on quox.ai.
            ...(CATALOG_DISPLAY ? { catalog: CATALOG_DISPLAY } : {}),
        });
    } catch (err) {
        console.error('GET /licensing/entitlements error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch entitlements' });
    }
});

/**
 * GET /setup/licensing/org-slots
 * LICENSE-ENFORCE LE-3c. Any authenticated user can read. Returns the
 * current org-slot assignment + allowance for every org-scoped entitlement
 * (`<pluginId>@orgs=N`) currently held by this instance's licenses.
 */
router.get('/licensing/org-slots', authenticate(), (req, res) => {
    try {
        const db = getDb();
        res.json({ org_slots: getOrgSlotsSummary(db) });
    } catch (err) {
        console.error('GET /licensing/org-slots error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch org slots' });
    }
});

/**
 * POST /setup/licensing/org-slots/release
 * LICENSE-ENFORCE LE-3c. Instance admin only. Frees an org's claimed slot on
 * an org-scoped entitlement so another org can claim it (or the same org can
 * be manually reassigned). Body: { plugin_id, org_id }
 */
router.post('/licensing/org-slots/release', authenticate(), requireInstanceAdmin('admin'), (req, res) => {
    try {
        const { plugin_id, org_id } = req.body || {};
        if (!plugin_id || !org_id) {
            return res.status(400).json({ error: 'validation_error', message: 'plugin_id and org_id are required' });
        }

        const db = getDb();
        const result = releaseOrgSlot(db, plugin_id, org_id);

        logAudit({
            action: AuditActions.CONFIG_UPDATE,
            actor: { type: 'user', id: req.user.id },
            target: { type: 'org_license_slot', id: `${plugin_id}:${org_id}` },
            status: 'success',
            request: req,
            metadata: { action: 'org_slot_released', plugin_id, org_id, released: result.released },
        });

        res.json({ success: true, released: result.released });
    } catch (err) {
        console.error('POST /licensing/org-slots/release error:', err);
        res.status(500).json({ error: 'release_failed', message: 'Failed to release org slot' });
    }
});

// ============================================================================
// GRIPE-715: `quox licence` phase 1 (instance-local, governed, audited).
// status reads the LEASE (never the key row); refresh runs the renewal; seats
// lists band holders and can release the non-live ones (dry run by default).
// ============================================================================

/** Org admin (active org) OR any instance admin. Read-only surface. */
function requireOrgOrInstanceAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'authentication_required', message: 'Must be authenticated' });
    if (req.user.orgRole && hasRoleLevel(req.user.orgRole, OrgRoles.ADMIN)) return next();
    if (checkInstanceAdmin(req.user.id).isAdmin) return next();
    return res.status(403).json({ error: 'insufficient_role', message: 'Requires org admin or instance admin' });
}

function leaseSnapshot(db) {
    const issued = new Map(listStoredLeases(db).map((l) => [l.license_id, l.issued_at]));
    return getLicenseSummaries(db).map((l) => ({
        license_id: l.license_id,
        plans: l.plans,
        entitlements: l.entitlements,
        issued_at: issued.get(l.license_id) || null,
        lease_expires_at: l.lease_expires_at,
        expires_at: l.expires_at,
    }));
}

/**
 * GET /setup/licensing/status
 * Org admin or instance admin. Lease-derived view; never touches key rows.
 */
router.get('/licensing/status', authenticate(), requireOrgOrInstanceAdmin, (req, res) => {
    try {
        const db = getDb();
        const orgId = req.org?.id || null;
        res.json({
            licenses: leaseSnapshot(db),
            governed: Array.from(LICENSE_GOVERNED_PLUGINS),
            entitlements: Array.from(getEntitlements(db)),
            org_id: orgId,
            org_bands: getOrgBands(db, orgId),
            entitlement_errors: getEntitlementErrors(db),
            renewal_health: getRenewalHealth(db),
        });
    } catch (err) {
        console.error('GET /licensing/status error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to read licence status' });
    }
});

/**
 * POST /setup/licensing/refresh
 * Instance admin only. Runs the lease renewal now and returns before/after.
 */
router.post('/licensing/refresh', authenticate(), requireInstanceAdmin('admin'), async (req, res) => {
    try {
        const db = getDb();
        const before = leaseSnapshot(db);
        const results = await renewAllLeases();
        clearEntitlementsCache();
        const after = leaseSnapshot(db);
        const entSet = (snap) => new Set(snap.flatMap((l) => l.entitlements));
        const b = entSet(before);
        const a = entSet(after);
        const diff = {
            added: [...a].filter((e) => !b.has(e)),
            removed: [...b].filter((e) => !a.has(e)),
        };

        logAudit({
            action: AuditActions.CONFIG_UPDATE,
            actor: { type: 'user', id: req.user.id },
            target: { type: 'instance_license_v2', id: 'refresh' },
            status: 'success',
            request: req,
            metadata: { action: 'licensing.refresh', results, entitlement_diff: diff },
        });

        res.json({ success: true, results, before, after, entitlement_diff: diff });
    } catch (err) {
        console.error('POST /licensing/refresh error:', err);
        res.status(500).json({ error: 'refresh_failed', message: 'Failed to refresh licence lease' });
    }
});

const PLUGIN_ID_FORMAT = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * GET /setup/licensing/seats/:pluginId
 * Instance admin only. Band holders with org name and live/deleted status.
 */
router.get('/licensing/seats/:pluginId', authenticate(), requireInstanceAdmin('admin'), (req, res) => {
    try {
        const { pluginId } = req.params;
        if (!PLUGIN_ID_FORMAT.test(pluginId)) {
            return res.status(400).json({ error: 'validation_error', message: 'invalid plugin id' });
        }
        const db = getDb();
        const holders = listBandHolders(db, pluginId).map((h) => {
            let name = null;
            try { name = db.prepare('SELECT name FROM orgs WHERE id = ?').get(h.entry)?.name ?? null; } catch { /* not an org id */ }
            return { id: h.entry, name, status: h.live ? 'live' : (h.reason === 'not_an_org_id' ? 'not_an_org' : 'deleted'), reason: h.reason || null };
        });
        const allowance = getOrgSlotsSummary(db)[pluginId]?.allowance ?? null;
        res.json({ plugin_id: pluginId, allowance, holders });
    } catch (err) {
        console.error('GET /licensing/seats error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to list seat holders' });
    }
});

/**
 * POST /setup/licensing/seats/:pluginId/release-dead
 * Instance admin only. Body: { dry_run?: boolean } (default TRUE: changes
 * nothing). Releases ONLY non-live holders; a live org is never touched.
 */
router.post('/licensing/seats/:pluginId/release-dead', authenticate(), requireInstanceAdmin('admin'), (req, res) => {
    try {
        const { pluginId } = req.params;
        if (!PLUGIN_ID_FORMAT.test(pluginId)) {
            return res.status(400).json({ error: 'validation_error', message: 'invalid plugin id' });
        }
        const dryRun = (req.body || {}).dry_run !== false;
        const db = getDb();
        const dead = listBandHolders(db, pluginId).filter((h) => !h.live);
        const released = [];
        if (!dryRun) {
            for (const h of dead) {
                const r = releaseOrgSlot(db, pluginId, h.entry);
                if (!r.released) continue;
                released.push(h.entry);
                logAudit({
                    action: 'licensing.seat.released',
                    actor: { type: 'user', id: req.user.id },
                    target: { type: 'org_license_slot', id: `${pluginId}:${h.entry}` },
                    status: 'success',
                    request: req,
                    metadata: { plugin_id: pluginId, holder: h.entry, reason: h.reason },
                });
            }
            clearEntitlementsCache();
        }
        res.json({
            plugin_id: pluginId,
            dry_run: dryRun,
            dead: dead.map((h) => ({ id: h.entry, reason: h.reason })),
            released,
        });
    } catch (err) {
        console.error('POST /licensing/seats/release-dead error:', err);
        res.status(500).json({ error: 'release_failed', message: 'Failed to release dead seats' });
    }
});

// ============================================================================
// LICENSE-LAUNCH LL-6b — enforcement posture + break-glass
//
// Enforcement postures used to be switchable by an env var alone, with no
// dashboard visibility and no expiry. These routes are the server-side surface
// the no-env-only-config house rule requires: read the posture of every flag,
// open a bounded attributed break-glass window, close it early.
//
// See lib/breakGlass.js for the semantics. In production a flag switched off
// WITHOUT an unexpired record is treated as ON by the consuming service.
// ============================================================================

/**
 * GET /setup/enforcement
 * Any authenticated user may READ the posture (same as GET /licensing) —
 * seeing that a gate is off is not itself a privilege, and hiding it is how
 * these drift unnoticed. Writing needs an instance admin.
 */
router.get('/enforcement', authenticate(), (req, res) => {
    try {
        res.json({
            flags: enforcementStatus(getDb()),
            max_break_glass_hours: MAX_BREAK_GLASS_MS / 3600_000,
            node_env: process.env.NODE_ENV || 'development',
        });
    } catch (err) {
        console.error('GET /enforcement error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to read enforcement posture' });
    }
});

/**
 * POST /setup/enforcement/break-glass
 * Instance admin only. Body: { flag, reason, expires_at }.
 */
router.post('/enforcement/break-glass', authenticate(), requireInstanceAdmin('admin'), (req, res) => {
    const { flag, reason, expires_at: expiresAt } = req.body || {};
    try {
        const record = createBreakGlass(getDb(), flag, {
            reason,
            expiresAt,
            createdBy: req.user.id,
        });
        logAudit({
            action: 'security.enforcement.break_glass_opened',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'enforcement_flag', id: flag },
            status: 'success',
            request: req,
            metadata: { reason: record.reason, expires_at: record.expires_at },
        });
        console.warn(`[BREAK-GLASS] enforcement OFF for ${flag} until ${record.expires_at} by ${req.user.id}: ${record.reason}`);
        res.status(201).json({ break_glass: record });
    } catch (err) {
        res.status(400).json({ error: 'validation_error', message: String(err?.message || err) });
    }
});

/**
 * DELETE /setup/enforcement/break-glass/:flag
 * Instance admin only. Closing early is always allowed.
 */
router.delete('/enforcement/break-glass/:flag', authenticate(), requireInstanceAdmin('admin'), (req, res) => {
    try {
        const cleared = clearBreakGlass(getDb(), req.params.flag);
        logAudit({
            action: 'security.enforcement.break_glass_cleared',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'enforcement_flag', id: req.params.flag },
            status: 'success',
            request: req,
            metadata: { was_active: !!cleared },
        });
        res.json({ cleared: !!cleared, flag: req.params.flag });
    } catch (err) {
        console.error('DELETE /enforcement/break-glass error:', err);
        res.status(500).json({ error: 'clear_failed', message: 'Failed to clear break-glass' });
    }
});

/**
 * GET /setup/internal/break-glass
 * Internal-only, same posture as /internal/has-plugin. This is what
 * services/collector/lib/enforcementPosture.js polls: the collector cannot
 * read auth.db, and it must not be allowed to assume a break-glass exists.
 * Contract: `{ break_glass: { <FLAG>: record } }`, active records only.
 */
router.get('/internal/break-glass', (req, res) => {
    try {
        const auth = authorizeInternalServiceRequest(req);
        if (!auth.authorized) {
            console.warn(`[Security] Rejected break-glass request from: ${auth.clientIp} (${auth.reason})`);
            return res.status(403).json({ error: 'forbidden', message: 'Internal endpoint only' });
        }
        res.json({ break_glass: listBreakGlass(getDb()) });
    } catch (err) {
        console.error('[break-glass] internal read error:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to read break-glass records' });
    }
});

export default router;
