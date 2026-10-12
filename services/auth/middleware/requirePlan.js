/**
 * ET-1 — requirePlan middleware.
 *
 * Gate an Express route behind a minimum plan tier. Depends on
 * requireOrg() having already attached req.org. Returns HTTP 402
 * Payment Required when the org's effective plan is below the tier.
 *
 * Usage:
 *   router.post('/orgs/:orgId/feature',
 *     authenticate(),
 *     requireOrg(),
 *     requirePlan('team'),    // ← here
 *     handler);
 */

import { meetsPlan, resolveEffectivePlan } from '../utils/planTiers.js';
import { getDb } from '../db/index.js';

const UPGRADE_URL = '/settings#billing';

export function requirePlan(minTier) {
    return function requirePlanMiddleware(req, res, next) {
        if (!req.org) {
            // requireOrg() should have run first; this is a wiring bug.
            console.error('[requirePlan] req.org missing — is requireOrg() mounted upstream?');
            return res.status(500).json({
                error:   'server_error',
                message: 'Plan gate misconfigured',
            });
        }

        // Tests can inject req.db; prod uses the real auth DB.
        const effective = resolveEffectivePlan(req.org, { db: req.db || getDb() });

        if (!meetsPlan(effective.plan, minTier)) {
            return res.status(402).json({
                error:       'plan_required',
                required:    minTier,
                current:     effective.plan,
                is_trial:    effective.is_trial,
                expired:     effective.expired,
                upgrade_url: UPGRADE_URL,
                message:     `This feature requires the ${minTier} plan or higher.`,
            });
        }

        // Attach effective plan for downstream handlers.
        req.effectivePlan = effective;
        return next();
    };
}
