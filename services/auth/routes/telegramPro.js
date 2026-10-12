/**
 * Telegram Pro routes for Quox Auth Service — QTG-PRO #P1
 *
 * Org-scoped CRUD for the durable Telegram Pro schema (088-telegram-pro.sql):
 *   POST/GET/PATCH/DELETE /orgs/:orgId/telegram/bots
 *   GET                   /orgs/:orgId/telegram/chats
 *   POST/GET/DELETE       /orgs/:orgId/telegram/bindings
 *   GET                   /orgs/:orgId/telegram/user-links
 *
 * Internal (service-to-service):
 *   GET /internal/telegram-pro/bots?org_id=  — collector P2 bot lookup
 *
 * Auth pattern mirrors routes/integrations.js exactly: every route applies
 * its own auth per-route (authenticate() + requireOrgMembership, or the
 * x-service-key check for the internal route) rather than a router-level
 * `router.use(requireAuth)`. This sidesteps the mount-order trap documented
 * in feedback_router_level_requireauth_trap / feedback_auth_mount_order —
 * because there is no blanket middleware on this router, the internal route
 * works regardless of where this router is mounted relative to other /api
 * routers, so it can be mounted once at `app.use('/api', telegramProRoutes)`
 * alongside integrationsRoutes.
 *
 * No collector wiring here — that is QTG-PRO P2. This ships schema + routes
 * only, per the P1 scope in the stream plan.
 */

import { Router } from 'express';
import { prepare } from '../db/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireOrgMembership } from '../middleware/org.js';
import { requireCapability } from '../middleware/authorize.js';
import { Capabilities } from '../utils/policy.js';
import { ulid, createAuditEvent } from '../utils/helpers.js';
import { safeCompare } from '../utils/crypto.js';

const router = Router();

const BOT_KINDS = ['gateway', 'agent', 'notify'];
const BOT_STATUSES = ['active', 'disabled'];
const BINDING_PROVIDERS = ['telegram', 'slack'];
const TARGET_KINDS = ['session', 'agent', 'team', 'hitl_inbox', 'owner'];
const BINDING_MODES = ['primary', 'mirror'];

// ============================================================================
// Bots
// ============================================================================

/**
 * POST /orgs/:orgId/telegram/bots
 * Register a bot from an existing vault credential + metadata. The bot
 * token itself is never accepted or stored here — it lives encrypted in
 * integration_credentials, referenced by credential_id.
 */
router.post('/orgs/:orgId/telegram/bots', authenticate(), requireOrgMembership, requireCapability(Capabilities.INTEGRATIONS_MANAGE), (req, res) => {
    try {
        const { orgId } = req.params;
        const { credential_id, bot_username, bot_user_id, kind, agent_id } = req.body || {};

        if (!credential_id) {
            return res.status(400).json({ error: 'credential_id_required', message: 'credential_id is required' });
        }
        if (!bot_user_id) {
            return res.status(400).json({ error: 'bot_user_id_required', message: 'bot_user_id is required' });
        }
        const botKind = kind || 'gateway';
        if (!BOT_KINDS.includes(botKind)) {
            return res.status(400).json({ error: 'invalid_kind', message: `kind must be one of: ${BOT_KINDS.join(', ')}` });
        }

        const credential = prepare(`
            SELECT id, org_id, integration_type FROM integration_credentials WHERE id = ?
        `).get(credential_id);
        if (!credential || credential.org_id !== orgId) {
            return res.status(404).json({ error: 'credential_not_found', message: 'credential_id does not exist in this org' });
        }
        if (credential.integration_type !== 'telegram') {
            return res.status(400).json({ error: 'invalid_credential_type', message: `credential ${credential_id} is not a telegram credential` });
        }

        const id = ulid();
        try {
            prepare(`
                INSERT INTO telegram_bots (id, org_id, credential_id, bot_username, bot_user_id, kind, agent_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(id, orgId, credential_id, bot_username || null, String(bot_user_id), botKind, agent_id || null);
        } catch (err) {
            if (String(err.message || '').includes('UNIQUE constraint failed')) {
                return res.status(409).json({ error: 'bot_already_registered', message: 'A bot with this bot_user_id is already registered in this org' });
            }
            throw err;
        }

        const bot = prepare('SELECT * FROM telegram_bots WHERE id = ?').get(id);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: req.user.id,
            action: 'telegram_pro.bot_created',
            targetType: 'telegram_bot',
            targetId: id,
            metadata: { kind: botKind, bot_username: bot_username || null }
        });

        res.status(201).json({ bot });
    } catch (error) {
        console.error('[TelegramPro] Error creating bot:', error);
        res.status(500).json({ error: 'internal_error', message: 'Failed to create bot' });
    }
});

/**
 * GET /orgs/:orgId/telegram/bots
 */
router.get('/orgs/:orgId/telegram/bots', authenticate(), requireOrgMembership, (req, res) => {
    try {
        const { orgId } = req.params;
        const bots = prepare(`
            SELECT * FROM telegram_bots WHERE org_id = ? ORDER BY created_at DESC
        `).all(orgId);
        res.json({ bots });
    } catch (error) {
        console.error('[TelegramPro] Error listing bots:', error);
        res.status(500).json({ error: 'internal_error', message: 'Failed to list bots' });
    }
});

/**
 * PATCH /orgs/:orgId/telegram/bots/:id
 * Update status/kind/agent_id. credential_id and bot_user_id are immutable
 * here — re-registering a different credential means creating a new bot.
 */
router.patch('/orgs/:orgId/telegram/bots/:id', authenticate(), requireOrgMembership, requireCapability(Capabilities.INTEGRATIONS_MANAGE), (req, res) => {
    try {
        const { orgId, id } = req.params;
        const { status, kind, agent_id } = req.body || {};

        const existing = prepare('SELECT * FROM telegram_bots WHERE id = ? AND org_id = ?').get(id, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'bot_not_found' });
        }

        if (status !== undefined && !BOT_STATUSES.includes(status)) {
            return res.status(400).json({ error: 'invalid_status', message: `status must be one of: ${BOT_STATUSES.join(', ')}` });
        }
        if (kind !== undefined && !BOT_KINDS.includes(kind)) {
            return res.status(400).json({ error: 'invalid_kind', message: `kind must be one of: ${BOT_KINDS.join(', ')}` });
        }

        prepare(`
            UPDATE telegram_bots
            SET status = COALESCE(?, status),
                kind = COALESCE(?, kind),
                agent_id = CASE WHEN ? THEN ? ELSE agent_id END,
                updated_at = datetime('now')
            WHERE id = ? AND org_id = ?
        `).run(status || null, kind || null, agent_id !== undefined ? 1 : 0, agent_id !== undefined ? agent_id : null, id, orgId);

        const bot = prepare('SELECT * FROM telegram_bots WHERE id = ?').get(id);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: req.user.id,
            action: 'telegram_pro.bot_updated',
            targetType: 'telegram_bot',
            targetId: id,
            metadata: { status, kind, agent_id }
        });

        res.json({ bot });
    } catch (error) {
        console.error('[TelegramPro] Error updating bot:', error);
        res.status(500).json({ error: 'internal_error', message: 'Failed to update bot' });
    }
});

/**
 * DELETE /orgs/:orgId/telegram/bots/:id
 * Soft delete: flips status to 'disabled'. telegram_bots has no
 * deleted_at column (see 088-telegram-pro.sql) — status is the lifecycle
 * field, mirroring the pending/active/archived/failed status idiom used by
 * matrix_rooms (082-matrix-rooms.sql) rather than a hard row delete, since
 * telegram_chats/channel_bindings history should remain queryable.
 */
router.delete('/orgs/:orgId/telegram/bots/:id', authenticate(), requireOrgMembership, requireCapability(Capabilities.INTEGRATIONS_MANAGE), (req, res) => {
    try {
        const { orgId, id } = req.params;
        const existing = prepare('SELECT id FROM telegram_bots WHERE id = ? AND org_id = ?').get(id, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'bot_not_found' });
        }

        prepare(`
            UPDATE telegram_bots SET status = 'disabled', updated_at = datetime('now')
            WHERE id = ? AND org_id = ?
        `).run(id, orgId);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: req.user.id,
            action: 'telegram_pro.bot_disabled',
            targetType: 'telegram_bot',
            targetId: id
        });

        res.json({ success: true, id, status: 'disabled' });
    } catch (error) {
        console.error('[TelegramPro] Error deleting bot:', error);
        res.status(500).json({ error: 'internal_error', message: 'Failed to delete bot' });
    }
});

// ============================================================================
// Chats
// ============================================================================

/**
 * GET /orgs/:orgId/telegram/chats
 * Optional ?bot_id= filter.
 */
router.get('/orgs/:orgId/telegram/chats', authenticate(), requireOrgMembership, (req, res) => {
    try {
        const { orgId } = req.params;
        const { bot_id } = req.query;

        let sql = 'SELECT * FROM telegram_chats WHERE org_id = ?';
        const params = [orgId];
        if (bot_id) {
            sql += ' AND bot_id = ?';
            params.push(bot_id);
        }
        sql += ' ORDER BY created_at DESC';

        const chats = prepare(sql).all(...params);
        res.json({ chats });
    } catch (error) {
        console.error('[TelegramPro] Error listing chats:', error);
        res.status(500).json({ error: 'internal_error', message: 'Failed to list chats' });
    }
});

// ============================================================================
// Channel bindings
// ============================================================================

/**
 * POST /orgs/:orgId/telegram/bindings
 * Bind a chat (or forum topic) to a Quox target. Only one 'primary'
 * binding is allowed per chat (enforced by the partial unique index in
 * 088-telegram-pro.sql) — a second primary POST for the same chat_id 409s.
 */
router.post('/orgs/:orgId/telegram/bindings', authenticate(), requireOrgMembership, requireCapability(Capabilities.INTEGRATIONS_MANAGE), (req, res) => {
    try {
        const { orgId } = req.params;
        const { chat_id, provider, target_kind, target_id, mode, reply_routing_json } = req.body || {};

        if (!chat_id) {
            return res.status(400).json({ error: 'chat_id_required' });
        }
        const chat = prepare('SELECT id FROM telegram_chats WHERE id = ? AND org_id = ?').get(chat_id, orgId);
        if (!chat) {
            return res.status(404).json({ error: 'chat_not_found', message: 'chat_id does not exist in this org' });
        }

        const bindingProvider = provider || 'telegram';
        if (!BINDING_PROVIDERS.includes(bindingProvider)) {
            return res.status(400).json({ error: 'invalid_provider', message: `provider must be one of: ${BINDING_PROVIDERS.join(', ')}` });
        }
        if (!TARGET_KINDS.includes(target_kind)) {
            return res.status(400).json({ error: 'invalid_target_kind', message: `target_kind must be one of: ${TARGET_KINDS.join(', ')}` });
        }
        const bindingMode = mode || 'primary';
        if (!BINDING_MODES.includes(bindingMode)) {
            return res.status(400).json({ error: 'invalid_mode', message: `mode must be one of: ${BINDING_MODES.join(', ')}` });
        }

        const id = ulid();
        try {
            prepare(`
                INSERT INTO channel_bindings (id, org_id, provider, chat_id, target_kind, target_id, mode, reply_routing_json, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(id, orgId, bindingProvider, chat_id, target_kind, target_id || null, bindingMode,
                reply_routing_json ? JSON.stringify(reply_routing_json) : '{}', req.user.id);
        } catch (err) {
            if (String(err.message || '').includes('UNIQUE constraint failed')) {
                return res.status(409).json({ error: 'primary_binding_exists', message: 'A primary binding already exists for this chat' });
            }
            throw err;
        }

        const binding = prepare('SELECT * FROM channel_bindings WHERE id = ?').get(id);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: req.user.id,
            action: 'telegram_pro.binding_created',
            targetType: 'channel_binding',
            targetId: id,
            metadata: { chat_id, target_kind, mode: bindingMode }
        });

        res.status(201).json({ binding });
    } catch (error) {
        console.error('[TelegramPro] Error creating binding:', error);
        res.status(500).json({ error: 'internal_error', message: 'Failed to create binding' });
    }
});

/**
 * GET /orgs/:orgId/telegram/bindings
 * Optional ?chat_id= filter.
 */
router.get('/orgs/:orgId/telegram/bindings', authenticate(), requireOrgMembership, (req, res) => {
    try {
        const { orgId } = req.params;
        const { chat_id } = req.query;

        let sql = 'SELECT * FROM channel_bindings WHERE org_id = ?';
        const params = [orgId];
        if (chat_id) {
            sql += ' AND chat_id = ?';
            params.push(chat_id);
        }
        sql += ' ORDER BY created_at DESC';

        const bindings = prepare(sql).all(...params);
        res.json({ bindings });
    } catch (error) {
        console.error('[TelegramPro] Error listing bindings:', error);
        res.status(500).json({ error: 'internal_error', message: 'Failed to list bindings' });
    }
});

/**
 * DELETE /orgs/:orgId/telegram/bindings/:id
 * Hard delete — channel_bindings has no status/soft-delete column (see
 * 088-telegram-pro.sql); unbinding immediately frees the chat up for a new
 * primary binding.
 */
router.delete('/orgs/:orgId/telegram/bindings/:id', authenticate(), requireOrgMembership, requireCapability(Capabilities.INTEGRATIONS_MANAGE), (req, res) => {
    try {
        const { orgId, id } = req.params;
        const existing = prepare('SELECT id FROM channel_bindings WHERE id = ? AND org_id = ?').get(id, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'binding_not_found' });
        }

        prepare('DELETE FROM channel_bindings WHERE id = ? AND org_id = ?').run(id, orgId);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: req.user.id,
            action: 'telegram_pro.binding_deleted',
            targetType: 'channel_binding',
            targetId: id
        });

        res.json({ success: true, id });
    } catch (error) {
        console.error('[TelegramPro] Error deleting binding:', error);
        res.status(500).json({ error: 'internal_error', message: 'Failed to delete binding' });
    }
});

// ============================================================================
// User links
// ============================================================================

/**
 * GET /orgs/:orgId/telegram/user-links
 * Read-only in P1. Creation of telegram_user_links rows comes with the P2
 * /link flow (verified numeric tg_user_id linking, one-time code +
 * link_code_hash) — no POST route here yet.
 */
router.get('/orgs/:orgId/telegram/user-links', authenticate(), requireOrgMembership, (req, res) => {
    try {
        const { orgId } = req.params;
        const links = prepare(`
            SELECT * FROM telegram_user_links WHERE org_id = ? ORDER BY created_at DESC
        `).all(orgId);
        res.json({ user_links: links });
    } catch (error) {
        console.error('[TelegramPro] Error listing user links:', error);
        res.status(500).json({ error: 'internal_error', message: 'Failed to list user links' });
    }
});

// ============================================================================
// Internal (service-to-service)
// ============================================================================

/**
 * GET /internal/telegram-pro/bots?org_id=
 * For the collector's future P2 lookup (webhook routing to the right bot
 * config). Auth: x-service-key header matching INTERNAL_SERVICE_KEY,
 * same timing-safe pattern as routes/internal-backups.js /
 * routes/identity.js. The bot TOKEN is never returned — that stays in the
 * vault and is resolved separately via the existing vault decrypt routes.
 * webhook_secret_hash IS included (it is a hash, not the secret itself) so
 * the collector can verify an inbound Telegram webhook call without a
 * second round-trip.
 */
router.get('/internal/telegram-pro/bots', (req, res) => {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying /internal/telegram-pro/bots request');
        return res.status(401).json({ error: 'service_key_not_configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (!serviceKey || !safeCompare(String(serviceKey), expectedKey)) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    try {
        const { org_id } = req.query;
        if (!org_id) {
            return res.status(400).json({ error: 'org_id_required' });
        }

        const bots = prepare(`
            SELECT id, org_id, credential_id, bot_username, bot_user_id, kind, agent_id, webhook_secret_hash, status, created_at, updated_at
            FROM telegram_bots WHERE org_id = ? AND status = 'active'
        `).all(org_id);

        res.json({ bots });
    } catch (error) {
        console.error('[TelegramPro/Internal] Error listing bots:', error);
        res.status(500).json({ error: 'internal_error', message: 'Failed to list bots' });
    }
});

export default router;
