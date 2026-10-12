import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import {
    getEffectiveLlmRoutingPolicy,
    saveLlmRoutingPolicy,
    validateStoredLlmRoutingPolicy,
} from './llmRoutingPolicy.js';

const router = Router();

// LLM-CHOICE P1: requireAuth is applied PER-ROUTE below, not router-level.
// Router-level requireAuth here (a) blocked the service-key /internal route
// (service calls carry no JWT) and (b) with this router mounted early on
// '/api', would intercept every later-mounted /api/* route including
// /api/auth/login. Do not restore router.use(requireAuth).

router.get('/orgs/:orgId/llm-routing-policy', requireAuth, requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const result = getEffectiveLlmRoutingPolicy(orgId);
        res.json(result);
    } catch (error) {
        console.error('Error getting llm routing policy:', error);
        res.status(500).json({ error: 'Failed to get llm routing policy' });
    }
});

router.put('/orgs/:orgId/llm-routing-policy', requireAuth, requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { policy } = req.body;

        if (!resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
            return res.status(403).json({ error: 'Insufficient permissions to manage execution policy' });
        }

        if (!policy || typeof policy !== 'object') {
            return res.status(400).json({ error: 'policy object required' });
        }

        const result = saveLlmRoutingPolicy({
            orgId,
            userId: req.user.id,
            policy,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });

        if (!result.ok) {
            return res.status(400).json({
                error: 'invalid_policy',
                validation_errors: result.errors,
            });
        }

        res.json({
            saved: true,
            policy: result.policy,
        });
    } catch (error) {
        console.error('Error saving llm routing policy:', error);
        res.status(500).json({ error: 'Failed to save llm routing policy' });
    }
});

router.post('/orgs/:orgId/llm-routing-policy/test', requireAuth, requireOrgMembership, async (req, res) => {
    try {
        const { policy } = req.body;
        if (!policy || typeof policy !== 'object') {
            return res.status(400).json({ error: 'policy object required' });
        }

        const validation = validateStoredLlmRoutingPolicy(policy);
        res.json(validation);
    } catch (error) {
        console.error('Error testing llm routing policy:', error);
        res.status(500).json({ error: 'Failed to test llm routing policy' });
    }
});

// Internal route — service-key auth for QuoxFlow agent invocations
// Reads the user's actual execution policy without requiring JWT
router.get('/internal/orgs/:orgId/llm-routing-policy', (req, res) => {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) return res.status(401).json({ error: 'Service key not configured' });
    const serviceKey = req.headers['x-service-key'];
    if (!serviceKey || serviceKey !== expectedKey) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const { orgId } = req.params;
        const result = getEffectiveLlmRoutingPolicy(orgId);
        res.json(result);
    } catch (error) {
        console.error('Error getting internal llm routing policy:', error);
        res.status(500).json({ error: 'Failed to get llm routing policy' });
    }
});

export default router;

