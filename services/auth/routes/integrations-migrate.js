/**
 * Integration Credential Migration Routes
 *
 * POST /api/orgs/:orgId/integrations/migrate-local
 *
 * Accepts channel configs from localStorage and creates vault entries.
 * Idempotent — won't create duplicates if credentials already exist.
 * Requires admin role.
 */

import { Router } from 'express';
import { authenticate, requireOrg } from '../middleware/authenticate.js';
import { requireCapability, requireOrgScope } from '../middleware/authorize.js';
import { Capabilities } from '../utils/policy.js';
import { createCredential, listCredentials, labelExists } from '../db/integrations.js';
import { logIntegrationEvent } from '../utils/audit.js';

const router = Router();

// Known channel types that map to vault integration types
const CHANNEL_TYPE_MAP = {
    email: { type: 'smtp', credFields: ['host', 'port', 'user', 'pass', 'secure'] },
    telegram: { type: 'telegram', credFields: ['botToken', 'chatId'] },
    slack: { type: 'slack', credFields: ['webhookUrl'] },
    discord: { type: 'discord', credFields: ['webhookUrl'] },
    msteams: { type: 'msteams', credFields: ['webhookUrl'] },
    twilio: { type: 'twilio', credFields: ['accountSid', 'authToken', 'fromNumber', 'toNumber'] },
    pagerduty: { type: 'pagerduty', credFields: ['routingKey'] },
    opsgenie: { type: 'opsgenie', credFields: ['apiKey', 'region'] },
    pushover: { type: 'pushover', credFields: ['userKey', 'apiToken'] },
    gotify: { type: 'gotify', credFields: ['serverUrl', 'appToken'] },
    ntfy: { type: 'ntfy', credFields: ['serverUrl', 'topic'] },
    generic_webhook: { type: 'generic_webhook', credFields: ['url', 'method'] },
};

/**
 * POST /api/orgs/:orgId/integrations/migrate-local
 *
 * Body: {
 *   channels: {
 *     email: { smtp: { host, port, user, pass, secure }, to, from },
 *     telegram: { botToken, chatId },
 *     slack: { webhookUrl },
 *     ...
 *   },
 *   bastion: { apiToken, backendUrl }
 * }
 *
 * Returns: { migrated: [...ids], skipped: [...reasons], errors: [...] }
 */
router.post(
    '/orgs/:orgId/integrations/migrate-local',
    authenticate(),
    requireOrg(),
    requireOrgScope(),
    requireCapability(Capabilities.SECRETS_WRITE),
    async (req, res) => {
        try {
            const { orgId } = req.params;
            const userId = req.user?.id;
            const { channels = {}, bastion } = req.body;

            // Only admin can migrate
            const role = req.orgMembership?.role;
            if (role !== 'admin' && role !== 'owner') {
                return res.status(403).json({ error: 'Only admins can migrate credentials' });
            }

            const migrated = [];
            const skipped = [];
            const errors = [];

            // Migrate channel credentials
            for (const [channelType, channelConfig] of Object.entries(channels)) {
                const mapping = CHANNEL_TYPE_MAP[channelType];
                if (!mapping) {
                    skipped.push({ channel: channelType, reason: 'Unknown channel type' });
                    continue;
                }

                // Extract credential fields
                let credentials = {};
                if (channelType === 'email' && channelConfig.smtp) {
                    credentials = { ...channelConfig.smtp };
                } else {
                    for (const field of mapping.credFields) {
                        if (channelConfig[field] !== undefined) {
                            credentials[field] = channelConfig[field];
                        }
                    }
                }

                // Skip if no actual credentials
                const hasValues = Object.values(credentials).some(v => v && v !== '');
                if (!hasValues) {
                    skipped.push({ channel: channelType, reason: 'No credential values' });
                    continue;
                }

                // Check if already exists (idempotent)
                const label = `${channelType} (migrated)`;
                const exists = labelExists(orgId, mapping.type, label);
                if (exists) {
                    skipped.push({ channel: channelType, reason: 'Already migrated' });
                    continue;
                }

                try {
                    const result = createCredential({
                        org_id: orgId,
                        integration_type: mapping.type,
                        label,
                        credentials,
                        description: `Auto-migrated from localStorage on ${new Date().toISOString().split('T')[0]}`,
                        is_default: true,
                        created_by: userId
                    });

                    migrated.push({
                        channel: channelType,
                        credential_id: result.id,
                        type: mapping.type
                    });

                    logIntegrationEvent({
                        org_id: orgId,
                        credential_id: result.id,
                        event_type: 'MIGRATION',
                        actor_id: userId,
                        details: { source: 'localStorage', channel: channelType }
                    });
                } catch (err) {
                    errors.push({ channel: channelType, error: err.message });
                }
            }

            // Migrate bastion credentials
            if (bastion?.apiToken) {
                const bastionLabel = 'bastion (migrated)';
                const bastionExists = labelExists(orgId, 'bastion', bastionLabel);

                if (bastionExists) {
                    skipped.push({ channel: 'bastion', reason: 'Already migrated' });
                } else {
                    try {
                        const result = createCredential({
                            org_id: orgId,
                            integration_type: 'bastion',
                            label: bastionLabel,
                            credentials: {
                                api_token: bastion.apiToken,
                                backend_url: bastion.backendUrl || '/bastion'
                            },
                            description: `Auto-migrated from localStorage on ${new Date().toISOString().split('T')[0]}`,
                            is_default: true,
                            created_by: userId
                        });

                        migrated.push({
                            channel: 'bastion',
                            credential_id: result.id,
                            type: 'bastion'
                        });

                        logIntegrationEvent({
                            org_id: orgId,
                            credential_id: result.id,
                            event_type: 'MIGRATION',
                            actor_id: userId,
                            details: { source: 'localStorage', channel: 'bastion' }
                        });
                    } catch (err) {
                        errors.push({ channel: 'bastion', error: err.message });
                    }
                }
            }

            res.json({
                migrated,
                skipped,
                errors,
                total: migrated.length + skipped.length + errors.length
            });
        } catch (err) {
            console.error('[Migration] Error:', err);
            res.status(500).json({ error: 'Migration failed' });
        }
    }
);

export default router;
