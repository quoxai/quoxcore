'use strict';

/**
 * The auth URL for a DB-defined custom agent's prompt. A custom agent's slug is unique per
 * org only, so the caller's org is always named when known; auth resolves a custom agent only
 * inside that org, and with no org only a built-in (ASSAY audit 2026-10-16).
 */
function customAgentPromptUrl(authBase, agentId, orgId) {
  const base = `${authBase}/internal/agents/${String(agentId).toLowerCase()}/prompt`;
  return orgId ? `${base}?org_id=${encodeURIComponent(orgId)}` : base;
}

module.exports = { customAgentPromptUrl };
