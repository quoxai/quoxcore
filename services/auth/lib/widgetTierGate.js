/**
 * Express helper: 402 plan_upgrade_required when the widget's org plan (licence
 * aware, see widgetPlan.js) lacks a Professional-only feature.
 */
import { prepare, getDb } from '../db/index.js';
import { resolveWidgetPlan } from './widgetPlan.js';
import { checkProFeature } from './widgetEntitlementGate.js';

export function effectivePlanForOrg(orgId) {
  const org = prepare('SELECT plan FROM orgs WHERE id = ?').get(orgId);
  return resolveWidgetPlan(getDb(), orgId, org?.plan);
}

/** Returns true (and sends the 402) when blocked. */
export function denyIfNotPro(req, res, feature) {
  const plan = effectivePlanForOrg(req.params.orgId);
  const gate = checkProFeature(plan, feature);
  if (gate.allow) return false;
  res.status(402).json({ error: 'plan_upgrade_required', feature: gate.feature, message: gate.reason, plan });
  return true;
}
