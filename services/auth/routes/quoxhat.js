/**
 * QUOXHAT P1 — hat management routes (auth service).
 *
 * Mount pattern mirrors routes/llm-routing-policies.js: per-route requireAuth
 * (NOT router-level — the /internal route authenticates by service key and a
 * router-level gate would 401 it), org membership enforced on every org
 * route, write capability gated on ORG_MANAGE_SETTINGS for org-owned
 * mutations. Selection endpoints (user pref, conversation binding) are
 * self-service for any active org member.
 *
 * P1 honesty: everything returned carries enforcement: 'preview' until P2
 * flips it through its own rollout control. Selection is stored and audited
 * but does not change executed tools yet.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import {
    listHats,
    getHat,
    createHat,
    updateHatDefinition,
    resetHatToTemplate,
    deleteHat,
    getOrgSettings,
    listEnforceOrgs,
    setOrgSettings,
    setUserPref,
    resolveEffectiveHat,
    bindConversationHat,
    loadBundleForConversation,
    getCatalogueForConversation,
} from './quoxhatStore.js';

function serviceKeyOk(req, res) {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) { res.status(401).json({ error: 'Service key not configured' }); return false; }
    const serviceKey = req.headers['x-service-key'];
    if (!serviceKey || serviceKey !== expectedKey) { res.status(401).json({ error: 'Unauthorized' }); return false; }
    return true;
}

const router = Router();

router.get('/orgs/:orgId/quoxhat/hats', requireAuth, requireOrgMembership, (req, res) => {
    try {
        const hats = listHats(req.params.orgId, req.user.id);
        res.json({ hats, settings: getOrgSettings(req.params.orgId) });
    } catch (err) {
        console.error('[quoxhat] list error:', err);
        res.status(500).json({ error: 'failed_to_list_hats' });
    }
});

router.get('/orgs/:orgId/quoxhat/hats/:hatId', requireAuth, requireOrgMembership, (req, res) => {
    try {
        // #721 (b): optional ?revision=n returns that historical revision's
        // definition (read-only). Same membership + visibility rules apply.
        let revision = null;
        if (req.query.revision !== undefined) {
            revision = Number(req.query.revision);
            if (!Number.isInteger(revision) || revision < 1) return res.status(400).json({ error: 'invalid_revision' });
        }
        const hat = getHat(req.params.orgId, req.params.hatId, req.user.id, { revision });
        if (!hat) return res.status(404).json({ error: revision ? 'hat_or_revision_not_found' : 'hat_not_found' });
        res.json({ hat, enforcement: getOrgSettings(req.params.orgId).enforcement });
    } catch (err) {
        console.error('[quoxhat] get error:', err);
        res.status(500).json({ error: 'failed_to_get_hat' });
    }
});

router.post('/orgs/:orgId/quoxhat/hats', requireAuth, requireOrgMembership, (req, res) => {
    try {
        const { key, name, definition, visibility = 'org' } = req.body || {};
        // Org-owned hats need settings capability; a private hat is the
        // user's own working profile and only needs membership.
        if (visibility !== 'private' && !resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
            return res.status(403).json({ error: 'insufficient_permissions' });
        }
        const result = createHat({
            orgId: req.params.orgId,
            userId: req.user.id,
            key, name, definition, visibility,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        if (!result.ok) return res.status(400).json({ error: 'invalid_hat', validation_errors: result.errors });
        res.status(201).json({ hat: result.hat, warnings: result.warnings });
    } catch (err) {
        console.error('[quoxhat] create error:', err);
        res.status(500).json({ error: 'failed_to_create_hat' });
    }
});

router.put('/orgs/:orgId/quoxhat/hats/:hatId', requireAuth, requireOrgMembership, (req, res) => {
    try {
        const { definition, change_reason, name } = req.body || {};
        const existing = getHat(req.params.orgId, req.params.hatId, req.user.id);
        if (!existing) return res.status(404).json({ error: 'hat_not_found' });
        const isOwnPrivate = existing.visibility === 'private' && existing.owner_user_id === req.user.id;
        if (!isOwnPrivate && !resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
            return res.status(403).json({ error: 'insufficient_permissions' });
        }
        const result = updateHatDefinition({
            orgId: req.params.orgId,
            userId: req.user.id,
            hatId: req.params.hatId,
            definition,
            name, // CUSTOM-HATS: optional rename (custom hats only), same audited revisioned write
            changeReason: change_reason || null,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        if (!result.ok) return res.status(result.status || 400).json({ error: 'invalid_hat', validation_errors: result.errors });
        res.json({ hat: result.hat, warnings: result.warnings });
    } catch (err) {
        console.error('[quoxhat] update error:', err);
        res.status(500).json({ error: 'failed_to_update_hat' });
    }
});

// CUSTOM-HATS (owner 2026-10-17) — delete a custom hat. Same permission as an
// edit (own private hat, or ORG_MANAGE_SETTINGS for an org hat); never wider.
// Built-ins are refused (400); the org default is refused (409).
router.delete('/orgs/:orgId/quoxhat/hats/:hatId', requireAuth, requireOrgMembership, (req, res) => {
    try {
        const existing = getHat(req.params.orgId, req.params.hatId, req.user.id);
        if (!existing) return res.status(404).json({ error: 'hat_not_found' });
        const isOwnPrivate = existing.visibility === 'private' && existing.owner_user_id === req.user.id;
        if (!isOwnPrivate && !resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
            return res.status(403).json({ error: 'insufficient_permissions' });
        }
        const result = deleteHat({
            orgId: req.params.orgId,
            userId: req.user.id,
            hatId: req.params.hatId,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
        res.json({ deleted: result.deleted });
    } catch (err) {
        console.error('[quoxhat] delete error:', err);
        res.status(500).json({ error: 'failed_to_delete_hat' });
    }
});

// M5 — reset an edited built-in hat back to its template; re-joins
// ensureBuiltinHats() automatic upgrades. Same auth pattern as PUT above.
router.post('/orgs/:orgId/quoxhat/hats/:hatId/reset-to-template', requireAuth, requireOrgMembership, (req, res) => {
    try {
        const existing = getHat(req.params.orgId, req.params.hatId, req.user.id);
        if (!existing) return res.status(404).json({ error: 'hat_not_found' });
        const isOwnPrivate = existing.visibility === 'private' && existing.owner_user_id === req.user.id;
        if (!isOwnPrivate && !resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
            return res.status(403).json({ error: 'insufficient_permissions' });
        }
        const result = resetHatToTemplate({
            orgId: req.params.orgId,
            userId: req.user.id,
            hatId: req.params.hatId,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        if (!result.ok) return res.status(result.status || 400).json({ error: 'reset_failed', validation_errors: result.errors });
        res.json({ hat: result.hat });
    } catch (err) {
        console.error('[quoxhat] reset-to-template error:', err);
        res.status(500).json({ error: 'failed_to_reset_hat' });
    }
});

router.put('/orgs/:orgId/quoxhat/settings', requireAuth, requireOrgMembership, (req, res) => {
    try {
        if (!resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
            return res.status(403).json({ error: 'insufficient_permissions' });
        }
        const { default_hat_id, selection_mode, enforcement } = req.body || {};
        const result = setOrgSettings({
            orgId: req.params.orgId,
            userId: req.user.id,
            defaultHatId: default_hat_id,
            selectionMode: selection_mode,
            enforcement,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        if (!result.ok) return res.status(400).json({ error: 'invalid_settings', validation_errors: result.errors });
        res.json({ settings: result.settings });
    } catch (err) {
        console.error('[quoxhat] settings error:', err);
        res.status(500).json({ error: 'failed_to_update_settings' });
    }
});

router.put('/orgs/:orgId/quoxhat/user-pref', requireAuth, requireOrgMembership, (req, res) => {
    try {
        const { default_hat_id } = req.body || {};
        const result = setUserPref({
            orgId: req.params.orgId,
            userId: req.user.id,
            defaultHatId: default_hat_id || null,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        if (!result.ok) return res.status(400).json({ error: 'invalid_pref', validation_errors: result.errors });
        res.json({ saved: true });
    } catch (err) {
        console.error('[quoxhat] user-pref error:', err);
        res.status(500).json({ error: 'failed_to_update_pref' });
    }
});

router.get('/orgs/:orgId/quoxhat/resolve', requireAuth, requireOrgMembership, (req, res) => {
    try {
        const result = resolveEffectiveHat({
            orgId: req.params.orgId,
            userId: req.user.id,
            conversationId: req.query.conversation_id || null,
            agent: req.query.agent || null, // P5 automatic/hybrid selection
        });
        res.json({ ...result, enforcement: getOrgSettings(req.params.orgId).enforcement });
    } catch (err) {
        console.error('[quoxhat] resolve error:', err);
        res.status(500).json({ error: 'failed_to_resolve' });
    }
});

router.put('/orgs/:orgId/quoxhat/bindings/:conversationId', requireAuth, requireOrgMembership, (req, res) => {
    try {
        const { hat_id, expected_seq } = req.body || {};
        if (!hat_id) return res.status(400).json({ error: 'hat_id required' });
        const result = bindConversationHat({
            orgId: req.params.orgId,
            userId: req.user.id,
            conversationId: req.params.conversationId,
            hatId: hat_id,
            expectedSeq: Number.isInteger(expected_seq) ? expected_seq : null,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        if (!result.ok) return res.status(result.status || 400).json({ error: 'binding_failed', validation_errors: result.errors });
        res.json({ binding: result.binding });
    } catch (err) {
        console.error('[quoxhat] binding error:', err);
        res.status(500).json({ error: 'failed_to_bind' });
    }
});

// QUOXHAT P4 — internal catalogue + bundle-load for the collector's
// agent-facing discovery tools (hat_catalogue / hat_load_bundle).
router.get('/internal/orgs/:orgId/quoxhat/catalogue', (req, res) => {
    if (!serviceKeyOk(req, res)) return;
    try {
        res.json(getCatalogueForConversation({
            orgId: req.params.orgId,
            userId: req.query.user_id || null,
            conversationId: req.query.conversation_id || null,
            tool: req.query.tool || null, // #725 slice 1: which hat names this tool
        }));
    } catch (err) {
        console.error('[quoxhat] internal catalogue error:', err);
        res.status(500).json({ error: 'failed_to_get_catalogue' });
    }
});

router.post('/internal/orgs/:orgId/quoxhat/bindings/:conversationId/load-bundle', (req, res) => {
    if (!serviceKeyOk(req, res)) return;
    try {
        const result = loadBundleForConversation({
            orgId: req.params.orgId,
            userId: req.body?.user_id || null,
            conversationId: req.params.conversationId,
            bundleKey: req.body?.bundle_key,
        });
        if (!result.ok) return res.status(result.status || 400).json({ error: 'load_bundle_failed', validation_errors: result.errors, available: result.available });
        res.json(result);
    } catch (err) {
        console.error('[quoxhat] internal load-bundle error:', err);
        res.status(500).json({ error: 'failed_to_load_bundle' });
    }
});

// Internal route — service-key auth for the collector's P2 turn resolution.
// Shipped in P1 so the read contract exists before enforcement consumes it.
router.get('/internal/orgs/:orgId/quoxhat/resolve', (req, res) => {
    if (!serviceKeyOk(req, res)) return;
    try {
        const result = resolveEffectiveHat({
            orgId: req.params.orgId,
            userId: req.query.user_id || null,
            conversationId: req.query.conversation_id || null,
            agent: req.query.agent || null, // P5 automatic/hybrid selection
        });
        res.json({ ...result, enforcement: getOrgSettings(req.params.orgId).enforcement });
    } catch (err) {
        console.error('[quoxhat] internal resolve error:', err);
        res.status(500).json({ error: 'failed_to_resolve' });
    }
});

// QUOXHAT FND-3 (RPP brutaloop 2026-10-02): the collector pre-warms each enforce
// org's durable enforcement verdict from this list, so a freshly-created or
// just-toggled enforce org fails CLOSED on its first tool call even before its
// first successful resolve — closing the cold-cache fail-open window. Only
// enforce orgs are returned; preview/non-QuoxHat orgs stay fail-open (= preview,
// which does not gate), preserving availability for tenants not using QuoxHat.
router.get('/internal/quoxhat/enforce-orgs', (req, res) => {
    if (!serviceKeyOk(req, res)) return;
    try {
        res.json({ orgIds: listEnforceOrgs() });
    } catch (err) {
        console.error('[quoxhat] internal enforce-orgs error:', err);
        res.status(500).json({ error: 'failed_to_list_enforce_orgs' });
    }
});

export default router;
