/**
 * Consent Management Routes (Security Issue #72)
 *
 * Handles user consent for third-party AI data sharing.
 * Data is NOT sent to AI providers unless explicit consent is given.
 *
 * Routes:
 * GET    /api/consent          Get current consent status
 * POST   /api/consent          Update consent preferences
 * GET    /api/consent/history  Get consent change history
 * POST   /api/consent/verify   Verify consent before AI call (internal)
 */

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { getDb, prepare } from '../db/index.js';
import { generateId } from '../utils/crypto.js';
import { logAudit, AuditActions } from '../utils/audit.js';
import { safeCompare } from '../utils/crypto.js';

const router = Router();
const internalRouter = Router();

// All routes require authentication
router.use(authenticate());

// Consent version - increment when policy changes require re-consent
const CURRENT_CONSENT_VERSION = '1.0';

// Third-party AI providers that require consent
const THIRD_PARTY_PROVIDERS = ['openai', 'anthropic', 'perplexity', 'gemini', 'google'];

function safeParseConsentProviderJson(value) {
    try {
        return JSON.parse(value || '{}');
    } catch {
        return {};
    }
}

function requireInternalAuth(req, res, next) {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying consent verification request');
        return res.status(401).json({ error: 'Service key not configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey && safeCompare(serviceKey, expectedKey)) {
        return next();
    }
    return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

export function evaluateConsentVerification({ provider, consent, currentVersion = CURRENT_CONSENT_VERSION }) {
    const normalizedProvider = String(provider || '').toLowerCase();
    const requiresConsent = THIRD_PARTY_PROVIDERS.includes(normalizedProvider);

    if (!requiresConsent) {
        return {
            consented: true,
            provider: normalizedProvider || provider,
            requires_consent: false,
            blocked_reason: null,
            message: 'Provider does not require AI data sharing consent',
        };
    }

    const hasConsent = !!consent && consent.ai_data_sharing_consent === 1;
    const validVersion = !!consent && consent.consent_version === currentVersion;

    let providerConsent = {};
    try {
        providerConsent = JSON.parse(consent?.provider_consent_json || '{}');
    } catch {
        providerConsent = {};
    }

    const providerSpecificConsent = providerConsent[normalizedProvider];
    const isBlocked = providerSpecificConsent === false;
    const consented = hasConsent && validVersion && !isBlocked;
    const blockedReason = !hasConsent ? 'no_consent' :
        !validVersion ? 'consent_expired' :
        isBlocked ? 'provider_blocked' : null;

    return {
        consented,
        provider: normalizedProvider,
        requires_consent: true,
        blocked_reason: blockedReason,
        message: consented
            ? 'User has consented to AI data sharing'
            : `User has not consented to AI data sharing (${blockedReason})`,
    };
}

function verifyConsentForUser({ db, actorUserId = null, orgId = null, targetUserId, provider, endpoint = 'unknown' }) {
    const consent = db.prepare(`
        SELECT ai_data_sharing_consent, provider_consent_json, consent_version
        FROM user_consent
        WHERE user_id = ?
    `).get(targetUserId);

    const decision = evaluateConsentVerification({ provider, consent });

    db.prepare(`
        INSERT INTO ai_provider_calls (
            id, user_id, org_id, provider, endpoint, consent_verified, consent_user_id, blocked_reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        generateId(),
        actorUserId,
        orgId,
        provider,
        endpoint,
        decision.consented ? 1 : 0,
        targetUserId,
        decision.blocked_reason
    );

    return decision;
}

/**
 * GET /api/consent
 * Get user's current consent status
 */
router.get('/', async (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;

        // Get consent record
        const consent = db.prepare(`
            SELECT
                ai_data_sharing_consent,
                ai_data_sharing_consent_at,
                provider_consent_json,
                consent_version,
                updated_at
            FROM user_consent
            WHERE user_id = ?
        `).get(userId);

        if (!consent) {
            // No consent record - user has not consented
            return res.json({
                ai_data_sharing_consent: false,
                provider_consent: {},
                consent_version: CURRENT_CONSENT_VERSION,
                needs_re_consent: false,
                third_party_providers: THIRD_PARTY_PROVIDERS
            });
        }

        // Check if re-consent is needed (version changed)
        const needsReConsent = consent.consent_version !== CURRENT_CONSENT_VERSION;

        // Parse provider consent
        const providerConsent = safeParseConsentProviderJson(consent.provider_consent_json);

        res.json({
            ai_data_sharing_consent: !!consent.ai_data_sharing_consent,
            ai_data_sharing_consent_at: consent.ai_data_sharing_consent_at,
            provider_consent: providerConsent,
            consent_version: consent.consent_version,
            current_version: CURRENT_CONSENT_VERSION,
            needs_re_consent: needsReConsent,
            third_party_providers: THIRD_PARTY_PROVIDERS,
            updated_at: consent.updated_at
        });
    } catch (err) {
        console.error('Get consent error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch consent status' });
    }
});

/**
 * POST /api/consent
 * Update consent preferences
 */
router.post('/', async (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const { ai_data_sharing_consent, provider_consent } = req.body;

        // Validate input
        if (typeof ai_data_sharing_consent !== 'boolean') {
            return res.status(400).json({
                error: 'invalid_input',
                message: 'ai_data_sharing_consent must be a boolean'
            });
        }

        // Get current consent for change logging
        const currentConsent = db.prepare(`
            SELECT ai_data_sharing_consent, provider_consent_json, consent_version
            FROM user_consent
            WHERE user_id = ?
        `).get(userId);

        const oldValue = currentConsent ? {
            ai_data_sharing_consent: !!currentConsent.ai_data_sharing_consent,
            provider_consent: safeParseConsentProviderJson(currentConsent.provider_consent_json)
        } : { ai_data_sharing_consent: false, provider_consent: {} };

        // Prepare provider consent JSON
        const providerConsentJson = JSON.stringify(provider_consent || {});

        // Get client info for audit
        const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
        const userAgent = req.get('user-agent') || 'unknown';

        if (currentConsent) {
            // Update existing record
            db.prepare(`
                UPDATE user_consent
                SET ai_data_sharing_consent = ?,
                    ai_data_sharing_consent_at = CASE WHEN ? = 1 THEN datetime('now') ELSE ai_data_sharing_consent_at END,
                    provider_consent_json = ?,
                    consent_version = ?,
                    updated_at = datetime('now'),
                    ip_address = ?,
                    user_agent = ?
                WHERE user_id = ?
            `).run(
                ai_data_sharing_consent ? 1 : 0,
                ai_data_sharing_consent ? 1 : 0,
                providerConsentJson,
                CURRENT_CONSENT_VERSION,
                ipAddress,
                userAgent,
                userId
            );
        } else {
            // Create new record
            db.prepare(`
                INSERT INTO user_consent (
                    id, user_id, ai_data_sharing_consent, ai_data_sharing_consent_at,
                    provider_consent_json, consent_version, ip_address, user_agent
                )
                VALUES (?, ?, ?, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, ?, ?, ?, ?)
            `).run(
                generateId(),
                userId,
                ai_data_sharing_consent ? 1 : 0,
                ai_data_sharing_consent ? 1 : 0,
                providerConsentJson,
                CURRENT_CONSENT_VERSION,
                ipAddress,
                userAgent
            );
        }

        // Log consent change
        const newValue = { ai_data_sharing_consent, provider_consent: provider_consent || {} };

        db.prepare(`
            INSERT INTO consent_change_log (
                id, user_id, consent_type, old_value, new_value,
                reason, ip_address, user_agent
            )
            VALUES (?, ?, 'ai_data_sharing', ?, ?, 'user_action', ?, ?)
        `).run(
            generateId(),
            userId,
            JSON.stringify(oldValue),
            JSON.stringify(newValue),
            ipAddress,
            userAgent
        );

        // Audit log
        logAudit({
            action: ai_data_sharing_consent ? 'consent.ai_data_sharing.granted' : 'consent.ai_data_sharing.revoked',
            actor: { type: 'user', id: userId },
            target: { type: 'user', id: userId },
            request: req,
            metadata: {
                old_consent: oldValue.ai_data_sharing_consent,
                new_consent: ai_data_sharing_consent,
                providers_affected: THIRD_PARTY_PROVIDERS
            }
        });

        console.log(`[Consent] User ${userId} ${ai_data_sharing_consent ? 'granted' : 'revoked'} AI data sharing consent`);

        res.json({
            success: true,
            ai_data_sharing_consent,
            provider_consent: provider_consent || {},
            consent_version: CURRENT_CONSENT_VERSION,
            message: ai_data_sharing_consent
                ? 'Consent granted. Data may now be sent to third-party AI providers.'
                : 'Consent revoked. Data will not be sent to third-party AI providers.'
        });
    } catch (err) {
        console.error('Update consent error:', err);
        res.status(500).json({ error: 'update_failed', message: 'Failed to update consent' });
    }
});

/**
 * GET /api/consent/history
 * Get consent change history for the user
 */
router.get('/history', async (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);

        const history = db.prepare(`
            SELECT id, consent_type, old_value, new_value, reason, ip_address, created_at
            FROM consent_change_log
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ?
        `).all(userId, limit);

        // Parse JSON values
        const parsedHistory = history.map(h => ({
            ...h,
            old_value: JSON.parse(h.old_value || '{}'),
            new_value: JSON.parse(h.new_value || '{}')
        }));

        res.json({ history: parsedHistory });
    } catch (err) {
        console.error('Get consent history error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch consent history' });
    }
});

/**
 * POST /api/consent/verify
 * Verify if a user has consent for a specific AI provider call
 * Used internally before making AI API calls
 */
router.post('/verify', async (req, res) => {
    try {
        const db = getDb();
        const { user_id, provider, endpoint } = req.body;

        // Use authenticated user if no user_id provided
        const targetUserId = user_id || req.user.id;

        if (!provider) {
            return res.status(400).json({
                error: 'provider_required',
                message: 'Provider is required'
            });
        }

        const decision = verifyConsentForUser({
            db,
            actorUserId: req.user.id,
            orgId: req.org?.id || null,
            targetUserId,
            provider,
            endpoint,
        });

        if (!decision.consented) {
            console.log(`[Consent] AI call BLOCKED for user ${targetUserId}, provider ${provider}: ${decision.blocked_reason}`);
        }

        res.json(decision);
    } catch (err) {
        console.error('Verify consent error:', err);
        // Fail closed - if verification fails, deny
        res.status(500).json({
            consented: false,
            error: 'verification_failed',
            message: 'Failed to verify consent - defaulting to deny'
        });
    }
});

internalRouter.use(requireInternalAuth);

internalRouter.post('/consent/verify', async (req, res) => {
    try {
        const db = getDb();
        const { user_id, provider, endpoint, org_id } = req.body;

        if (!user_id) {
            return res.status(400).json({
                error: 'user_id_required',
                message: 'user_id is required for internal consent verification'
            });
        }

        if (!provider) {
            return res.status(400).json({
                error: 'provider_required',
                message: 'Provider is required'
            });
        }

        const decision = verifyConsentForUser({
            db,
            actorUserId: user_id,
            orgId: org_id || null,
            targetUserId: user_id,
            provider,
            endpoint,
        });

        if (!decision.consented) {
            console.log(`[Consent] Internal AI call BLOCKED for user ${user_id}, provider ${provider}: ${decision.blocked_reason}`);
        }

        res.json(decision);
    } catch (err) {
        console.error('Internal verify consent error:', err);
        res.status(500).json({
            consented: false,
            error: 'verification_failed',
            message: 'Failed to verify consent - defaulting to deny'
        });
    }
});

export default router;
export { internalRouter };
