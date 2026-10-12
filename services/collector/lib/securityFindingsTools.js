'use strict';

/**
 * QUOX-SECURITY Phase 1 (continued): agent-facing TOOL_DEFS wrapping
 * lib/securityFindings.js, mirroring securityEngagementTools.js's shape
 * exactly (same configure({db}) DI pattern, same org_id-from-ctx-only
 * discipline, same never-throws-out-of-the-wrapper contract).
 *
 * reported_by/verified_by are always derived from ctx.agentId, never
 * agent-supplied input, so a finding's authorship record cannot be forged.
 */

const securityFindings = require('./securityFindings.js');

let _deps = { db: null };

function configure(deps) {
  _deps = { ..._deps, ...deps };
}

function requireDb() {
  if (!_deps.db) throw new Error('security.db not configured (call configure({db}) at server boot)');
  return _deps.db;
}

function actorFromCtx(ctx) {
  return ctx && ctx.agentId ? `agent:${ctx.agentId}` : null;
}

const SECURITY_FINDINGS_TOOLS = {

  security_report_finding: {
    name: 'security_report_finding',
    description: 'Report a candidate security finding against a target within an engagement. Always starts as status "candidate", never confirmed, findings_verifier must independently confirm or refute it with a reason before it counts as anything more than a claim.',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        target_value: { type: 'string', description: 'The target this finding was observed against' },
        title: { type: 'string' },
        description: { type: 'string' },
        severity: { type: 'string', enum: securityFindings.SEVERITIES },
      },
      required: ['engagement_id', 'target_value', 'title', 'description'],
    },
    execute: async (input, ctx) => {
      try {
        if (!ctx || !ctx.orgId) return { success: false, error: 'org_id could not be derived from the calling context (ctx.orgId missing)' };
        const finding = securityFindings.createFinding(
          { ...input, org_id: ctx.orgId, reported_by: actorFromCtx(ctx) },
          { db: requireDb() }
        );
        return { success: true, finding };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  security_verify_finding: {
    name: 'security_verify_finding',
    description: 'Confirm or refute a candidate finding, always with a reason, a bare verdict is refused. This is the adversarial step: only findings_verifier should call this, and only after asking whether the finding reproduces.',
    input_schema: {
      type: 'object',
      properties: {
        finding_id: { type: 'string' },
        verdict: { type: 'string', enum: securityFindings.VERDICTS },
        reason: { type: 'string', description: 'Why this verdict was reached, required, never a bare confirm/refute' },
      },
      required: ['finding_id', 'verdict', 'reason'],
    },
    execute: async ({ finding_id, verdict, reason }, ctx) => {
      try {
        if (!ctx || !ctx.orgId) return { success: false, error: 'org_id could not be derived from the calling context (ctx.orgId missing)' };
        const finding = securityFindings.verifyFinding(
          finding_id, ctx.orgId,
          { verdict, reason, verified_by: actorFromCtx(ctx) },
          { db: requireDb() }
        );
        return { success: true, finding };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  security_list_findings: {
    name: 'security_list_findings',
    description: 'List findings for an engagement, most recent first, scoped to the calling org.',
    input_schema: {
      type: 'object',
      properties: { engagement_id: { type: 'string' } },
      required: ['engagement_id'],
    },
    execute: async ({ engagement_id }, ctx) => {
      try {
        if (!ctx || !ctx.orgId) return { success: false, error: 'org_id could not be derived from the calling context (ctx.orgId missing)' };
        const findings = securityFindings.listFindings(engagement_id, ctx.orgId, { db: requireDb() });
        return { success: true, count: findings.length, findings };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },
};

function getSecurityFindingsToolDefinitions() {
  return Object.values(SECURITY_FINDINGS_TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

async function executeSecurityFindingsTool(name, input, ctx) {
  const tool = SECURITY_FINDINGS_TOOLS[name];
  if (!tool) throw new Error(`Unknown security findings tool: ${name}`);
  return tool.execute(input || {}, ctx || {});
}

module.exports = {
  SECURITY_FINDINGS_TOOLS,
  configure,
  getSecurityFindingsToolDefinitions,
  executeSecurityFindingsTool,
};
