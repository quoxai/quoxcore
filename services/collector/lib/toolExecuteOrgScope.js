'use strict';
/**
 * QUOXTRUST F1 (engagement c4, FND_01M3R1TQ7ND2HW6B9QWTD2HW6B) — tenant
 * isolation for the native tool-execute path (T7 isolation / D4 mediation).
 *
 * The native tool routes and the credentialed agentTools executors honoured a
 * CALLER-SUPPLIED org id over the authenticated identity:
 *   route:    ctx.orgId = org_id (body) || req.user.orgId
 *   executor: orgId     = input.org_id || ctx.orgId
 * so an Org A user JWT could pass org_id / input.org_id = Org B and read Org B's
 * vault credentials (mailbox, saved authenticated browser session). The exact
 * class was already fixed on the sibling connector/VOLT routes (server.js
 * /volt/runs, /volt/stats): a caller-supplied org is honoured ONLY for a trusted
 * service-key caller, NEVER for a user JWT. These two pure helpers carry that one
 * rule to the native path so both entry points and every executor share it.
 */

/**
 * Route-level org resolution for /api/v1/tools/execute and
 * /api/internal/tools/execute.
 *
 * A trusted service-key caller (no req.user) may name the org in the request
 * body — that org is the request's tenant boundary and the route validates it
 * (mandatory, membership-checked when a user_id is also supplied). A user JWT is
 * LOCKED to its authenticated identity: a body-supplied org is a cross-org
 * credential vector and is ignored.
 *
 * @param {{ isServiceKeyAuth: boolean, bodyOrgId?: string, user?: object|null }} a
 * @returns {string|undefined}
 */
function resolveCallerOrgId({ isServiceKeyAuth, bodyOrgId, user } = {}) {
  if (isServiceKeyAuth) {
    return bodyOrgId || undefined;
  }
  return (user && (user.orgId || user.org_id)) || undefined;
}

/**
 * Executor-level org resolution for every credentialed agentTools executor.
 *
 * An authenticated caller's org (ctx.orgId, set on the route from the verified
 * identity) is authoritative and ALWAYS wins over any caller-supplied
 * input.org_id. input.org_id is honoured ONLY when no ctx.orgId was set — the
 * trusted internal/agentic path (server.js /api/internal agentic invoke) which
 * deliberately carries the org in the tool input and sets no ctx.orgId.
 *
 * @param {object|null|undefined} ctx  execution context (ctx.orgId = authoritative org)
 * @param {object|null|undefined} input tool input (input.org_id = caller-supplied)
 * @returns {string|undefined}
 */
function resolveToolOrgId(ctx, input) {
  const c = ctx || {};
  const i = input || {};
  return c.orgId || i.org_id || undefined;
}

module.exports = { resolveCallerOrgId, resolveToolOrgId };
