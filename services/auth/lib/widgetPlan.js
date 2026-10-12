/**
 * Effective QuoxChat widget tier for an org.
 *
 * orgs.plan is vestigial for buyers (utils/planTiers.js): nothing sets it when
 * a licence is bought, so caps keyed on it left every paying customer on the
 * free tier. The tier now comes from the org's LICENCE, the same resolution the
 * knowledge storage quota uses (routes/widgets.js knowledgeStorageForOrg):
 *   quoxchat-pro -> 'pro', quoxchat -> 'standard', neither -> orgs.plan.
 * An explicit orgs.plan (e.g. 'enterprise') is never downgraded: the higher of
 * the two wins. Honours the QUOXCHAT_LICENSE_ENFORCE=off break-glass.
 */
import { hasPlugin } from './entitlements.js';
import { PLANS } from './widgetEntitlements.js';

export function resolveWidgetPlan(db, orgId, orgPlan) {
  const base = PLANS.includes(orgPlan) ? orgPlan : 'free';
  const enforce = String(process.env.QUOXCHAT_LICENSE_ENFORCE || 'on').toLowerCase() !== 'off';
  if (!enforce || !orgId) return base;
  let licensed = 'free';
  try {
    if (hasPlugin(db, 'quoxchat-pro', orgId)) licensed = 'pro';
    else if (hasPlugin(db, 'quoxchat', orgId)) licensed = 'standard';
  } catch { licensed = 'free'; }
  return PLANS.indexOf(licensed) > PLANS.indexOf(base) ? licensed : base;
}
