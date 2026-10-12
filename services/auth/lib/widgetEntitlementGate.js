/**
 * QCX-7c — Pure entitlement gate for widget PATCH.
 *
 * Inspects an updates payload and returns the first violation against
 * the org's plan. PATCH handler 402s when allow=false and surfaces
 * `feature` so the UI can show the correct upgrade prompt.
 */

import { getEntitlements, isFeatureEnabled } from './widgetEntitlements.js';

function _parseEmbedConfig(updates) {
  if (!updates || typeof updates !== 'object') return null;
  const raw = updates.embed_config_json;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function checkPatchEntitlements(plan, updates) {
  const ent = getEntitlements(plan);
  const cfg = _parseEmbedConfig(updates);

  // Custom CSS gate — empty string counts as "clearing", which is always
  // allowed regardless of plan.
  if (cfg && typeof cfg.style_overrides === 'string' && cfg.style_overrides.length > 0) {
    if (!ent.custom_css_enabled) {
      return {
        allow: false,
        feature: 'custom_css_enabled',
        reason: `Custom CSS requires Standard plan or higher (current: ${plan || 'free'}).`,
      };
    }
  }

  // BYOK gate — only blocks setting; clearing (null/empty) always allowed.
  if (updates && updates.llm_key_vault_ref) {
    if (!ent.byok_enabled) {
      return {
        allow: false,
        feature: 'byok_enabled',
        reason: `Bring-your-own-key (BYOK) requires Standard plan or higher (current: ${plan || 'free'}).`,
      };
    }
  }

  // Custom domain gate.
  if (cfg && typeof cfg.custom_domain === 'string' && cfg.custom_domain.length > 0) {
    if (!ent.custom_domain_enabled) {
      return {
        allow: false,
        feature: 'custom_domain_enabled',
        reason: `Custom domain requires Pro plan or higher (current: ${plan || 'free'}).`,
      };
    }
  }

  return { allow: true };
}

/**
 * Professional-only features per the published offer. `feature` is the
 * entitlement flag; the reason is operator-facing (admin), never shown to
 * visitors.
 */
const PRO_FEATURES = {
  simulation_arena_enabled: 'Simulation Arena',
  smart_routing_enabled: 'Smart LLM routing',
  connector_framework_enabled: 'The tool and connector framework',
};

export function checkProFeature(plan, feature) {
  const label = PRO_FEATURES[feature] || feature;
  if (isFeatureEnabled(plan, feature)) return { allow: true };
  return {
    allow: false,
    feature,
    reason: `${label} is a Professional feature (current plan: ${plan || 'free'}). Upgrade to QuoxChat Professional to use it.`,
  };
}
