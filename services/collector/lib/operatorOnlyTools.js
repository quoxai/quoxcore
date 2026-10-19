'use strict';

/**
 * operatorOnlyTools.js — tools that read the INSTANCE OPERATOR's data (HYPERION follow-up,
 * 2026-10-17). proof_status reads the operator's proof board through one operator-set URL, and
 * built-in quox holds it in every org, so on a shared instance any tenant's chat could read it.
 * executeTool asks this before running such a tool: allowed only for the operator's org
 * (instance_config fleet.operator_org_id) or an instance admin. Anything that cannot be confirmed
 * (operator org unreadable, admin check failing, no org) is refused: fail closed.
 * The same rule gates ASSIGNING the tool in auth (routes/agents.js operatorOnlyRefusal).
 */

const OPERATOR_ONLY_TOOLS = new Set(['proof_status']);
const AUTH_SERVICE_URL = () => process.env.AUTH_SERVICE_URL || 'http://auth:3101';

async function isInstanceAdminUser(userId) {
  if (!userId) return false;
  const res = await fetch(`${AUTH_SERVICE_URL()}/api/internal/instance-admin/${encodeURIComponent(userId)}`, {
    headers: { 'x-service-key': process.env.INTERNAL_SERVICE_KEY || '' },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`auth answered ${res.status}`);
  const body = await res.json();
  return body && body.isAdmin === true;
}

/** null = allowed; otherwise a plain refusal for the model. */
async function operatorOnlyRefusal(toolName, ctx = {}, deps = {}) {
  if (!OPERATOR_ONLY_TOOLS.has(toolName)) return null;
  const refuse = `${toolName} reads the instance operator's data, so it runs only for the operator's org or an instance admin. Say plainly that this is not available here; do not answer from memory.`;
  const orgId = ctx.orgId;
  if (!orgId) return refuse;
  const resolveOperatorOrg = deps.resolveOperatorOrg || require('./fleetOperatorOrg.js').resolveFleetOperatorOrgId;
  const op = await resolveOperatorOrg();
  if (op === undefined) return `${toolName} could not confirm the instance operator's org (auth did not answer), so it was not run.`;
  if (op && op === orgId) return null;
  try {
    if (await (deps.isInstanceAdmin || isInstanceAdminUser)(ctx.userId)) return null;
  } catch {
    return `${toolName} could not confirm instance admin (auth did not answer), so it was not run.`;
  }
  return refuse;
}

module.exports = { OPERATOR_ONLY_TOOLS, operatorOnlyRefusal };
