/**
 * Org-admin gate for the private-endpoint allow entry of a widget's
 * OpenAI-compatible LLM (embed_config.llm.allow_private_origin).
 *
 * Allow-listing a private/loopback address lets the collector call it on
 * behalf of the widget, which is a standing egress grant, so setting or
 * changing it needs the admin role. Any org member may still edit the rest of
 * the widget, and clearing the entry is always allowed. Pure function.
 */

import { hasRoleLevel } from '../utils/policy.js';

function allowEntry(embedConfigJson) {
  if (typeof embedConfigJson !== 'string' || !embedConfigJson) return '';
  try {
    const cfg = JSON.parse(embedConfigJson);
    const v = cfg && cfg.llm && typeof cfg.llm === 'object' ? cfg.llm.allow_private_origin : '';
    return typeof v === 'string' ? v.trim() : '';
  } catch { return ''; }
}

/**
 * @returns {{allow: boolean, reason?: string}}
 */
export function checkPrivateEndpointChange({ existingConfigJson, newConfigJson, role }) {
  if (newConfigJson === undefined || newConfigJson === null) return { allow: true };
  const next = allowEntry(newConfigJson);
  if (!next) return { allow: true }; // clearing / not setting
  if (next === allowEntry(existingConfigJson)) return { allow: true }; // unchanged
  if (hasRoleLevel(role, 'admin')) return { allow: true };
  return {
    allow: false,
    reason: 'Allow-listing a private model endpoint for a widget requires the organisation admin role.',
  };
}
