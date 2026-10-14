/**
 * QCX-7a — Widget entitlements (plan → feature map).
 *
 * Single source of truth for what each subscription tier unlocks. Used by:
 *   - /api/orgs/:o/widgets POST   (widget count cap enforcement)
 *   - /api/orgs/:o/widgets/:w PATCH  (custom_css gate when style_overrides
 *                                    is set, BYOK gate when llm_key_vault_ref
 *                                    is set, etc.)
 *   - /quoxchat/message            (conversation cap, tool-calls/day cap)
 *
 * Caps:
 *   -1  = unlimited (enterprise)
 *   N>0 = hard cap (pre-flight 402 with upgrade prompt)
 */

// ESM module — auth uses "type": "module".

export const PLANS = ['free', 'standard', 'pro', 'enterprise'];

const ENTITLEMENTS = {
  free: {
    widget_count_cap: 1,
    conversations_per_month_cap: 100,
    knowledge_mb_cap: 5,
    tool_calls_per_day_cap: 0,
    simulation_runs_cap: 5,
    tools_enabled: false,
    connector_gallery_enabled: false,
    custom_css_enabled: false,
    custom_domain_enabled: false,
    byok_enabled: false,
    priority_routing_enabled: false,
    evidence_export_enabled: false,
    // Published as Professional-only (PricingPage + QuoxChatPromoPage tier lists).
    simulation_arena_enabled: false,
    smart_routing_enabled: false,
    connector_framework_enabled: false,
  },
  standard: {
    widget_count_cap: -1,
    conversations_per_month_cap: -1,
    knowledge_mb_cap: 1000, // 1 GB decimal; collector KNOWLEDGE_STORAGE_LIMITS_BYTES enforces (pinned by test)
    tool_calls_per_day_cap: 500,
    simulation_runs_cap: 100,
    tools_enabled: true,
    connector_gallery_enabled: false,
    custom_css_enabled: true,
    custom_domain_enabled: false,
    byok_enabled: true,
    priority_routing_enabled: false,
    evidence_export_enabled: true,
    // Published as Professional-only (PricingPage + QuoxChatPromoPage tier lists).
    simulation_arena_enabled: false,
    smart_routing_enabled: false,
    connector_framework_enabled: false,
  },
  pro: {
    widget_count_cap: -1,
    conversations_per_month_cap: -1,
    knowledge_mb_cap: 5000, // 5 GB decimal; collector KNOWLEDGE_STORAGE_LIMITS_BYTES enforces (pinned by test)
    tool_calls_per_day_cap: 5000,
    simulation_runs_cap: 1000,
    tools_enabled: true,
    connector_gallery_enabled: true,
    custom_css_enabled: true,
    custom_domain_enabled: true,
    byok_enabled: true,
    priority_routing_enabled: true,
    evidence_export_enabled: true,
    // Published as Professional-only (PricingPage + QuoxChatPromoPage tier lists).
    simulation_arena_enabled: true,
    smart_routing_enabled: true,
    connector_framework_enabled: true,
  },
  enterprise: {
    widget_count_cap: -1,
    conversations_per_month_cap: -1,
    knowledge_mb_cap: -1,
    tool_calls_per_day_cap: -1,
    simulation_runs_cap: -1,
    tools_enabled: true,
    connector_gallery_enabled: true,
    custom_css_enabled: true,
    custom_domain_enabled: true,
    byok_enabled: true,
    priority_routing_enabled: true,
    evidence_export_enabled: true,
    // Published as Professional-only (PricingPage + QuoxChatPromoPage tier lists).
    simulation_arena_enabled: true,
    smart_routing_enabled: true,
    connector_framework_enabled: true,
  },
};

export function getEntitlements(plan) {
  const safePlan = PLANS.includes(plan) ? plan : 'free';
  return { ...ENTITLEMENTS[safePlan] };
}

export function isFeatureEnabled(plan, feature) {
  const ent = getEntitlements(plan);
  return ent[feature] === true;
}
