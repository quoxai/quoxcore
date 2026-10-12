/**
 * GOV-7: Policy Template Library
 *
 * Pre-built policy packs for common compliance frameworks.
 * Each pack contains ready-to-enable policies with conditions,
 * effects, framework mappings, and priority ordering.
 */

const { createPolicy, listPolicies } = require('./policyStore.js');

// ============================================================
// Template Pack Definitions
// ============================================================

const TEMPLATE_PACKS = [
  {
    id: 'soc2-starter',
    name: 'SOC2 Starter',
    description: 'Baseline policies for SOC2 Type II compliance. Covers access controls, audit logging, and change management.',
    color: '#38bdf8',
    policies: [
      {
        name: 'SOC2: Require approval for infrastructure changes',
        category: 'governance',
        priority: 800,
        conditions: { operator: 'AND', conditions: [
          { field: 'tool.name', operator: 'in', value: ['proxmox_vm_action', 'docker_fleet_container_action', 'ssh_exec'] },
          { field: 'tool.action', operator: 'in', value: ['stop', 'reboot', 'shutdown', 'remove', 'delete', 'kill'] },
        ]},
        effect: 'require_approval',
        reason: 'SOC2 CC6.1: Infrastructure changes require approval',
        framework_mapping: ['soc2.cc6.1', 'soc2.cc8.1'],
        audit_required: true,
      },
      {
        name: 'SOC2: Log all tool executions',
        category: 'compliance',
        priority: 300,
        conditions: { operator: 'AND', conditions: [
          { field: 'tool.name', operator: '!=', value: '' },
        ]},
        effect: 'log_only',
        reason: 'SOC2 CC7.2: All tool executions logged for audit',
        framework_mapping: ['soc2.cc7.2'],
        audit_required: true,
      },
      {
        name: 'SOC2: Block credential exposure',
        category: 'safety',
        priority: 900,
        conditions: { operator: 'OR', conditions: [
          { field: 'query.text', operator: 'matches', value: '\\b(password|secret|api[_-]?key)\\s*[:=]' },
          { field: 'data.hasPII', operator: '==', value: true },
        ]},
        effect: 'deny',
        reason: 'SOC2 CC6.1: Credential and PII exposure blocked',
        framework_mapping: ['soc2.cc6.1', 'soc2.cc6.7'],
        audit_required: true,
      },
      {
        name: 'SOC2: Rate limit per org',
        category: 'execution',
        priority: 600,
        conditions: { operator: 'AND', conditions: [
          { field: 'rate.queries_per_hour', operator: '>', value: 500 },
        ]},
        effect: 'deny',
        reason: 'SOC2 CC6.1: Org rate limit exceeded (500/hr)',
        framework_mapping: ['soc2.cc6.1'],
        audit_required: false,
      },
    ],
  },
  {
    id: 'hipaa-baseline',
    name: 'HIPAA Baseline',
    description: 'Policies for HIPAA PHI protection. Blocks PII transmission, enforces audit trails, requires approval for data access.',
    color: '#30ff90',
    policies: [
      {
        name: 'HIPAA: Block PHI transmission',
        category: 'compliance',
        priority: 950,
        conditions: { operator: 'AND', conditions: [
          { field: 'data.hasPII', operator: '==', value: true },
        ]},
        effect: 'deny',
        reason: 'HIPAA §164.312: PHI may not be transmitted without BAA',
        framework_mapping: ['hipaa.164.312.a.1', 'hipaa.164.312.e.1'],
        audit_required: true,
      },
      {
        name: 'HIPAA: Require approval for data export',
        category: 'governance',
        priority: 800,
        conditions: { operator: 'AND', conditions: [
          { field: 'tool.name', operator: 'in', value: ['file_export', 'data_export', 'report_generate'] },
        ]},
        effect: 'require_approval',
        reason: 'HIPAA §164.312: Data exports require authorization',
        framework_mapping: ['hipaa.164.312.a.1'],
        audit_required: true,
      },
      {
        name: 'HIPAA: Audit all queries',
        category: 'compliance',
        priority: 200,
        conditions: { operator: 'AND', conditions: [
          { field: 'query.text', operator: '!=', value: '' },
        ]},
        effect: 'log_only',
        reason: 'HIPAA §164.312(b): All access attempts logged',
        framework_mapping: ['hipaa.164.312.b'],
        audit_required: true,
      },
      {
        name: 'HIPAA: Restrict to approved providers',
        category: 'compliance',
        priority: 850,
        conditions: { operator: 'AND', conditions: [
          { field: 'provider.name', operator: 'not_in', value: ['anthropic', 'local'] },
          { field: 'data.hasPII', operator: '==', value: true },
        ]},
        effect: 'deny',
        reason: 'HIPAA: Only BAA-covered providers may process PHI',
        framework_mapping: ['hipaa.164.308.b.1', 'hipaa.164.314.a.1'],
        audit_required: true,
      },
    ],
  },
  {
    id: 'high-security',
    name: 'High-Security Production',
    description: 'Strict policies for production environments. Multi-approval for destructive ops, PII blocking, credential protection, tight rate limits.',
    color: '#ef4444',
    policies: [
      {
        name: 'HighSec: Block all PII',
        category: 'compliance',
        priority: 950,
        conditions: { operator: 'AND', conditions: [
          { field: 'data.hasPII', operator: '==', value: true },
        ]},
        effect: 'deny',
        reason: 'High-security: All PII transmission blocked',
        framework_mapping: ['iso27001.a.8.2.3', 'nist.sp800-53.si-12'],
        audit_required: true,
      },
      {
        name: 'HighSec: Approval for all destructive actions',
        category: 'governance',
        priority: 900,
        conditions: { operator: 'AND', conditions: [
          { field: 'tool.action', operator: 'in', value: ['stop', 'reboot', 'shutdown', 'remove', 'delete', 'kill', 'restart'] },
        ]},
        effect: 'require_approval',
        reason: 'High-security: All destructive actions require admin approval',
        framework_mapping: ['nist.sp800-53.cm-3', 'iso27001.a.12.1.2'],
        audit_required: true,
      },
      {
        name: 'HighSec: Block dangerous commands',
        category: 'safety',
        priority: 950,
        conditions: { operator: 'OR', conditions: [
          { field: 'query.text', operator: 'matches', value: '\\b(rm\\s+-rf|sudo\\s+rm|format\\s+c:|DROP\\s+TABLE|TRUNCATE)\\b' },
          { field: 'input.command', operator: 'matches', value: '\\b(rm\\s+-rf|mkfs|dd\\s+if=|shutdown|halt)\\b' },
        ]},
        effect: 'deny',
        reason: 'High-security: Dangerous command patterns blocked',
        framework_mapping: ['cis.5.4', 'nist.sp800-53.cm-7'],
        audit_required: true,
      },
      {
        name: 'HighSec: Tight rate limit',
        category: 'execution',
        priority: 700,
        conditions: { operator: 'AND', conditions: [
          { field: 'rate.queries_per_minute', operator: '>', value: 10 },
        ]},
        effect: 'deny',
        reason: 'High-security: Rate limit 10/min exceeded',
        framework_mapping: ['nist.sp800-53.sc-5'],
        audit_required: false,
      },
      {
        name: 'HighSec: Non-quox agents require approval for SSH',
        category: 'governance',
        priority: 800,
        conditions: { operator: 'AND', conditions: [
          { field: 'tool.name', operator: '==', value: 'ssh_exec' },
          { field: 'agent.id', operator: '!=', value: 'quox' },
        ]},
        effect: 'require_approval',
        reason: 'High-security: Non-orchestrator SSH requires approval',
        framework_mapping: ['nist.sp800-53.ac-6'],
        audit_required: true,
      },
    ],
  },
  {
    id: 'dev-sandbox',
    name: 'Development Sandbox',
    description: 'Relaxed policies for development environments. Warns instead of blocks, higher rate limits, no PII restrictions.',
    color: '#f59e0b',
    policies: [
      {
        name: 'DevSandbox: Warn on dangerous commands',
        category: 'safety',
        priority: 500,
        conditions: { operator: 'OR', conditions: [
          { field: 'query.text', operator: 'matches', value: '\\b(rm\\s+-rf|sudo\\s+rm)\\b' },
        ]},
        effect: 'log_only',
        reason: 'Dev sandbox: Dangerous command detected (warning only)',
        framework_mapping: [],
        audit_required: false,
      },
      {
        name: 'DevSandbox: Warn on PII',
        category: 'compliance',
        priority: 300,
        conditions: { operator: 'AND', conditions: [
          { field: 'data.hasPII', operator: '==', value: true },
        ]},
        effect: 'log_only',
        reason: 'Dev sandbox: PII detected (warning only, not blocked)',
        framework_mapping: [],
        audit_required: false,
      },
      {
        name: 'DevSandbox: High rate limit',
        category: 'execution',
        priority: 400,
        conditions: { operator: 'AND', conditions: [
          { field: 'rate.queries_per_minute', operator: '>', value: 60 },
        ]},
        effect: 'deny',
        reason: 'Dev sandbox: Rate limit 60/min exceeded',
        framework_mapping: [],
        audit_required: false,
      },
    ],
  },
  {
    id: 'blast-radius',
    name: 'Blast Radius',
    description: 'Governance keyed on what an agent can actually reach (BLAST-RADIUS), not just which tool it named. Requires the reach resolver to be wired; see docs/STATUS_AND_LIMITS for coverage.',
    color: '#a78bfa',
    policies: [
      {
        name: 'Blast radius: approval when reach spans hosts AND credentials',
        category: 'governance',
        priority: 750,
        conditions: { operator: 'AND', conditions: [
          { field: 'reach.hosts', operator: '>=', value: 1 },
          { field: 'reach.credentials', operator: '>=', value: 1 },
        ]},
        effect: 'require_approval',
        reason: 'This agent can reach both fleet hosts and vault credentials at once — a call spanning both classes goes to a human before it runs, even though no single tool call names both.',
        framework_mapping: [],
        audit_required: true,
      },
    ],
  },
];

const PACK_IDS = TEMPLATE_PACKS.map(p => p.id);

// ============================================================
// API
// ============================================================

function getTemplatePacks() {
  return TEMPLATE_PACKS;
}

function getTemplatePack(packId) {
  return TEMPLATE_PACKS.find(p => p.id === packId) || null;
}

/**
 * Detect conflicts between a pack's policies and existing org policies.
 * Returns array of { templateName, existingName, existingId } for name collisions.
 */
function detectConflicts(db, orgId, pack) {
  if (!db || !pack) return [];

  const existing = listPolicies(db, { org_id: orgId, limit: 500 });
  const existingNames = new Set(existing.data.filter(p => p.org_id === orgId).map(p => p.name));

  const conflicts = [];
  for (const pol of pack.policies) {
    if (existingNames.has(pol.name)) {
      const existingPol = existing.data.find(p => p.name === pol.name && p.org_id === orgId);
      conflicts.push({
        templateName: pol.name,
        existingName: pol.name,
        existingId: existingPol?.id,
      });
    }
  }

  return conflicts;
}

/**
 * Enable a pack: bulk-create all policies for the org.
 * Skips policies that already exist (by name) in the org.
 */
function enablePack(db, orgId, packId, createdBy = 'system') {
  const pack = getTemplatePack(packId);
  if (!pack) throw new Error(`Template pack '${packId}' not found`);

  const existing = listPolicies(db, { org_id: orgId, limit: 500 });
  const existingNames = new Set(existing.data.filter(p => p.org_id === orgId).map(p => p.name));

  let created = 0;
  let skipped = 0;

  for (const template of pack.policies) {
    if (existingNames.has(template.name)) {
      skipped++;
      continue;
    }

    createPolicy(db, {
      ...template,
      enabled: true,
      scope: template.scope || { agents: ['*'], teams: ['*'] },
      org_id: orgId,
      created_by: createdBy,
    });
    created++;
  }

  return { created, skipped, packId, packName: pack.name };
}

module.exports = {
  getTemplatePacks,
  getTemplatePack,
  detectConflicts,
  enablePack,
  PACK_IDS,
};
