'use strict';

/**
 * QUOX-SECURITY Phase 1: agent-facing TOOL_DEFS wrapping securityEngagement.js.
 *
 * Unlike quoxplanTools.js (which proxies over HTTP to a separate QuoxPlan
 * server), securityEngagement.js runs in this same process against
 * security.db, so these wrappers call it directly rather than round-
 * tripping through HTTP. That means this module needs its own db handle,
 * wired via configure({db}) at server boot, mirroring approvalGate.js's
 * setSecurityDb naming convention (server.js calls both from the same
 * SECURITY_DB_PATH init block).
 *
 * org_id is ALWAYS taken from ctx.orgId (the authenticated caller's org),
 * never from agent-supplied input, the same discipline the REST routes in
 * server.js already use, so an agent cannot forge writes into another org's
 * engagements by passing a different org_id in its tool call.
 *
 * Every execute() catches its own errors and returns { success:false,
 * error }, matching quoxplanTools.js's contract, so a malformed call never
 * throws out of the tool-dispatch loop.
 */

const securityEngagement = require('./securityEngagement.js');

let _deps = { db: null, lookupDnsTxt: undefined, fetchWellKnown: undefined, checkFleetMembership: undefined };

/** @param {{db, lookupDnsTxt?: Function, fetchWellKnown?: Function, checkFleetMembership?: Function}} deps */
function configure(deps) {
  _deps = { ..._deps, ...deps };
}

function requireDb() {
  if (!_deps.db) throw new Error('security.db not configured (call configure({db}) at server boot)');
  return _deps;
}

function actorFromCtx(ctx) {
  return ctx && ctx.agentId ? `agent:${ctx.agentId}` : null;
}

const SECURITY_ENGAGEMENT_TOOLS = {

  security_create_engagement: {
    name: 'security_create_engagement',
    description: 'Create a new security testing engagement (the authorization/scope object every future scan or probe must be attached to). Scoped to the calling org automatically. environment_tier "production" is hard-capped at risk_ceiling "discovery" in Phase 0, no elevation path exists yet.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable engagement name' },
        environment_tier: { type: 'string', enum: securityEngagement.ENVIRONMENT_TIERS },
        risk_ceiling: { type: 'string', enum: securityEngagement.RISK_TIERS, description: 'Highest capability risk tier this engagement permits' },
        exclusions: { type: 'array', items: { type: 'string' }, description: 'Optional list of explicitly out-of-scope values' },
        time_window: {
          type: 'object',
          properties: { start: { type: 'string' }, end: { type: 'string' } },
          description: 'Optional ISO timestamps bounding when capabilities may run against this engagement',
        },
      },
      required: ['name', 'environment_tier', 'risk_ceiling'],
    },
    execute: async (input, ctx) => {
      try {
        if (!ctx || !ctx.orgId) return { success: false, error: 'org_id could not be derived from the calling context (ctx.orgId missing)' };
        const engagement = securityEngagement.createEngagement(
          { ...input, org_id: ctx.orgId, created_by: actorFromCtx(ctx) },
          requireDb()
        );
        return { success: true, engagement };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  security_get_engagement: {
    name: 'security_get_engagement',
    description: 'Get one security engagement by id, scoped to the calling org. Returns engagement:null (not an error) if it does not exist or belongs to a different org.',
    input_schema: {
      type: 'object',
      properties: { engagement_id: { type: 'string' } },
      required: ['engagement_id'],
    },
    execute: async ({ engagement_id }, ctx) => {
      try {
        if (!ctx || !ctx.orgId) return { success: false, error: 'org_id could not be derived from the calling context (ctx.orgId missing)' };
        const engagement = securityEngagement.getEngagement(engagement_id, ctx.orgId, requireDb());
        return { success: true, engagement };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  security_list_engagements: {
    name: 'security_list_engagements',
    description: 'List all security engagements for the calling org, most recent first.',
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (_input, ctx) => {
      try {
        if (!ctx || !ctx.orgId) return { success: false, error: 'org_id could not be derived from the calling context (ctx.orgId missing)' };
        const engagements = securityEngagement.listEngagements(ctx.orgId, requireDb());
        return { success: true, count: engagements.length, engagements };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  security_add_target: {
    name: 'security_add_target',
    description: 'Add an in-scope target (domain, cidr, repo, or cloud_account) to an existing engagement. If verification_method is set, the target starts unverified and must be verified with security_verify_target before any capability may run against it.',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        type: { type: 'string', enum: securityEngagement.TARGET_TYPES },
        value: { type: 'string', description: 'The target value, e.g. a domain name' },
        verification_method: { type: 'string', enum: securityEngagement.VERIFICATION_METHODS },
      },
      required: ['engagement_id', 'type', 'value'],
    },
    execute: async ({ engagement_id, type, value, verification_method }, ctx) => {
      try {
        if (!ctx || !ctx.orgId) return { success: false, error: 'org_id could not be derived from the calling context (ctx.orgId missing)' };
        const target = securityEngagement.addTarget(engagement_id, ctx.orgId, { type, value, verification_method }, requireDb());
        return { success: true, target };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  security_verify_target: {
    name: 'security_verify_target',
    description: 'Run a target\'s declared verification challenge (dns_txt, well_known_file, or quoxagent_install for private-network targets already under fleet control; signed_attestation is not implemented and will return an honest error, never a fake pass). Records verified/failed on the target.',
    input_schema: {
      type: 'object',
      properties: { target_id: { type: 'string' } },
      required: ['target_id'],
    },
    execute: async ({ target_id }, ctx) => {
      try {
        if (!ctx || !ctx.orgId) return { success: false, error: 'org_id could not be derived from the calling context (ctx.orgId missing)' };
        const target = await securityEngagement.verifyTarget(target_id, ctx.orgId, requireDb());
        return { success: true, target };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  security_check_policy: {
    name: 'security_check_policy',
    description: 'Check whether a capability of the given risk tier is currently allowed to run against a target within an engagement (in-scope, verified, under the risk ceiling, inside the time window). Never throws; returns allowed:false with a human-readable reason on any denial. Callers must pass this before invoking any capability-provider execution.',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        target_value: { type: 'string' },
        capability_risk: { type: 'string', enum: securityEngagement.RISK_TIERS },
      },
      required: ['engagement_id', 'target_value', 'capability_risk'],
    },
    execute: async ({ engagement_id, target_value, capability_risk }, ctx) => {
      try {
        if (!ctx || !ctx.orgId) return { success: false, error: 'org_id could not be derived from the calling context (ctx.orgId missing)' };
        const decision = securityEngagement.checkEngagementPolicy(
          { engagementId: engagement_id, orgId: ctx.orgId, targetValue: target_value, capabilityRisk: capability_risk },
          requireDb()
        );
        return { success: true, ...decision };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },
};

function getSecurityEngagementToolDefinitions() {
  return Object.values(SECURITY_ENGAGEMENT_TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

async function executeSecurityEngagementTool(name, input, ctx) {
  const tool = SECURITY_ENGAGEMENT_TOOLS[name];
  if (!tool) throw new Error(`Unknown security engagement tool: ${name}`);
  return tool.execute(input || {}, ctx || {});
}

module.exports = {
  SECURITY_ENGAGEMENT_TOOLS,
  configure,
  getSecurityEngagementToolDefinitions,
  executeSecurityEngagementTool,
};
