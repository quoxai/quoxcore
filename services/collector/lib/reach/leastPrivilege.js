'use strict';

/**
 * leastPrivilege.js — BLAST-RADIUS-P4
 *
 * Predicted-vs-actual least-privilege reporting: takes the P0 static reach
 * closure (what an agent MAY touch, per grants) and compares it against what
 * the AEE envelope trail actually shows it touching in a trailing window, so
 * an operator can see which grants have never fired and are candidates for
 * revocation.
 *
 * HONESTY CONTRACT (hard, this is the whole point of P4): "not observed" is
 * NEVER rendered as "unused". Every layer carries its own `coverage` field.
 * Only `tools` and `credentials` have a real, if imperfect, usage source
 * today; `hosts`, `egress` and `delegates` have NONE (an envelope trail that
 * would let us say "this host/origin/delegate was actually touched" simply
 * does not exist yet), so those three ALWAYS report coverage:'not-observed'
 * with a one-line reason and produce ZERO recommendations. Recommending a
 * revocation from a layer we cannot observe would assert a falsehood
 * ("unused") from an absence of evidence, which is exactly the failure mode
 * this file exists to prevent.
 *
 * Factory-free, DI-by-parameter style like actionRadius.js's
 * computeActionRadius(call, deps) — deps are all injectable so tests never
 * touch a real DB, network, or clock:
 *   - getCachedStaticReach(agentId, orgId) => Promise<P0 reach result>
 *     (lib/reach/runtime.js — same cache every policy check uses)
 *   - queryEnvelopes(filter) => Array<envelope row> | Promise<Array<row>>
 *     Same statement layer as server.js's aeeStatements.queryOrgScoped — the
 *     server wires this to a real prepared-statement call. This file never
 *     hand-rolls SQL.
 *   - fetchCredentialUsage(agentId, orgId, windowDays) => Promise<{ credentials: [...] }>
 *     Deliverable 2's internal auth route (credential audit rows).
 *   - nowIso() => string — injectable clock.
 *
 * Witness: this file does NOT self-audit. The caller (the collector route in
 * Deliverable 3) is responsible for calling
 * lib/reach/runtime.js's auditReachEvaluation({ trigger: 'least_privilege', ... })
 * with the result, mirroring how every other reach entry point witnesses
 * through the one shared runtime rather than each computing its own envelope.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;

function defaultNowIso() {
  return new Date().toISOString();
}

/**
 * Tool-execution intent shapes actually emitted today (lib/toolEvidence.js's
 * emitToolEvidence, consumed by the 3 dispatcher paths named in the tools
 * layer's gaps, plus the /api/v1/tools/execute gold path which emits the
 * same two intents inline in server.js):
 *   - 'aocl.tool.execute'      — the AOCL trace envelope, fired for every
 *                                execution regardless of tool-specific intent.
 *   - '<something>.executed'  — the AEE envelope; 'ops.tool.executed' is the
 *                                default, but a tool def's own _aeeIntent can
 *                                override the prefix, so this matches by
 *                                suffix rather than the literal default only.
 * Failure variants ('*.failed') are deliberately NOT matched — this is an
 * observed-USE signal, and a call that failed before dispatch is a weaker
 * claim than one that ran.
 */
function isToolExecutionIntent(intent) {
  if (!intent || typeof intent !== 'string') return false;
  return intent === 'aocl.tool.execute' || intent.endsWith('.executed');
}

function safeParsePayload(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function countBy(list, keyFn) {
  const counts = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * @param {{ agentId: string, orgId: string, windowDays?: number }} params
 * @param {{
 *   getCachedStaticReach: (agentId: string, orgId: string) => Promise<object>,
 *   queryEnvelopes: (filter: object) => (Array<object>|Promise<Array<object>>),
 *   fetchCredentialUsage: (agentId: string, orgId: string, windowDays: number) => Promise<{credentials: Array<object>}>,
 *   nowIso?: () => string,
 * }} deps
 */
async function computeLeastPrivilege({ agentId, orgId, windowDays = DEFAULT_WINDOW_DAYS } = {}, deps = {}) {
  if (!agentId) throw new Error('computeLeastPrivilege: agentId is required');
  if (!orgId) throw new Error('computeLeastPrivilege: orgId is required');
  const { getCachedStaticReach, queryEnvelopes, fetchCredentialUsage, nowIso = defaultNowIso } = deps;
  if (typeof getCachedStaticReach !== 'function') {
    throw new Error('computeLeastPrivilege: deps.getCachedStaticReach is required');
  }
  if (typeof queryEnvelopes !== 'function') {
    throw new Error('computeLeastPrivilege: deps.queryEnvelopes is required');
  }
  if (typeof fetchCredentialUsage !== 'function') {
    throw new Error('computeLeastPrivilege: deps.fetchCredentialUsage is required');
  }

  const computedAt = nowIso();
  const windowStart = new Date(Date.parse(computedAt) - windowDays * MS_PER_DAY).toISOString();

  // ---- Predicted (static reach, P0) ----
  const staticReach = await getCachedStaticReach(agentId, orgId);
  const may = (staticReach && staticReach.may) || {};
  const predictedTools = Array.isArray(may.tools) ? may.tools : [];
  const predictedCredentials = Array.isArray(may.credentials) ? may.credentials : [];
  const predictedHostsCount = Array.isArray(may.hosts) ? may.hosts.length : 0;
  const predictedEgressCount = Array.isArray(may.egress) ? may.egress.length : 0;
  const predictedDelegatesCount = (may.delegates && Array.isArray(may.delegates.direct)) ? may.delegates.direct.length : 0;

  // ============================================================
  // Tools layer — actual usage from AEE envelopes.
  // ============================================================
  let envelopeRows = [];
  let envelopesOk = true;
  let envelopesError = null;
  try {
    const result = await queryEnvelopes({
      orgId,
      from: `agent.${agentId}`,
      after: windowStart,
      limit: 5000,
    });
    envelopeRows = Array.isArray(result) ? result : [];
  } catch (err) {
    envelopesOk = false;
    envelopesError = (err && err.message) || String(err);
    envelopeRows = [];
  }

  const toolExecutionRows = envelopeRows.filter((row) => isToolExecutionIntent(row && row.intent));
  const toolCounts = countBy(toolExecutionRows, (row) => {
    const payload = safeParsePayload(row.payload);
    return payload && payload.tool_name;
  });

  // Execution envelopes whose payload yields no tool_name (unreadable payload,
  // unexpected shape). These are PROOF activity happened that we cannot
  // attribute — counting them into "unused" would be a false claim, so they
  // are surfaced loudly and, below, suppress tool recommendations entirely.
  const unattributedToolRows = toolExecutionRows.filter((row) => {
    const payload = safeParsePayload(row.payload);
    return !(payload && payload.tool_name);
  }).length;

  const predictedToolIds = predictedTools.map((t) => t && t.id).filter(Boolean);
  const usedToolIds = Array.from(toolCounts.keys());
  const unusedToolIds = predictedToolIds.filter((id) => !toolCounts.has(id));

  const toolsLayer = {
    coverage: 'partial',
    unattributed: unattributedToolRows,
    gaps: [
      ...(unattributedToolRows > 0 ? [
        `${unattributedToolRows} tool-execution envelope(s) in the window carried no attributable tool_name (unreadable or unexpected payload) — activity happened that this report cannot assign, so the unused list is unreliable and tool recommendations are withheld`,
      ] : []),
      'only /api/v1/tools/execute and the 3 emitToolEvidence dispatcher paths (claudeMessagesDispatcher, openaiInvokeDispatcher, toolResume) emit a tool-execution envelope; a tool call dispatched through any other path leaves no usage trail here',
      'tool ARGUMENTS are not carried in AEE envelopes, so target-level actuals (e.g. which host an ssh_exec call touched) are impossible today — only tool-name-level usage is observable',
    ],
    predicted: predictedToolIds.length,
    predicted_list: predictedToolIds,
    used: usedToolIds.length,
    used_list: usedToolIds,
    unused_list: unusedToolIds,
    counts: Object.fromEntries(toolCounts),
    ...(envelopesOk ? {} : { source_error: envelopesError }),
  };

  // ============================================================
  // Credentials layer — actual usage from the auth service's credential
  // release audit rows (Deliverable 2).
  // ============================================================
  let credentialUsage = null;
  let credentialSourceOk = true;
  let credentialSourceError = null;
  try {
    credentialUsage = await fetchCredentialUsage(agentId, orgId, windowDays);
  } catch (err) {
    credentialSourceOk = false;
    credentialSourceError = (err && err.message) || String(err);
  }

  const credentialRows = (credentialUsage && Array.isArray(credentialUsage.credentials)) ? credentialUsage.credentials : [];
  const credentialCounts = new Map(credentialRows.map((r) => [r.credential_id, r.count]));
  const predictedCredentialIds = predictedCredentials.map((c) => c && c.id).filter(Boolean);
  const usedCredentialIds = credentialRows.map((r) => r.credential_id).filter(Boolean);
  const unusedCredentialIds = credentialSourceOk
    ? predictedCredentialIds.filter((id) => !credentialCounts.has(id))
    : [];

  const credentialsLayer = {
    // A real usage source exists (Deliverable 2's audit_events query), but
    // credentialResolver.js's resolveForAgent() caches a resolved credential
    // for 30s per (org, agent, toolType) key, so N logical uses inside that
    // window collapse into 1 audit row. 'observed' would overstate the
    // precision; this string names the exact undercount mechanism.
    coverage: credentialSourceOk ? 'partial (30s resolver cache undercounts repeats)' : 'not-observed',
    ...(credentialSourceOk ? {} : { reason: `credential usage source unreachable: ${credentialSourceError}` }),
    predicted: predictedCredentialIds.length,
    predicted_list: predictedCredentialIds,
    used: usedCredentialIds.length,
    used_list: usedCredentialIds,
    unused_list: unusedCredentialIds,
    counts: Object.fromEntries(credentialCounts),
  };

  // ============================================================
  // Hosts / egress / delegates — NO witnessed usage source exists today.
  // Permanently not-observed; never render as "unused", never recommend.
  // ============================================================
  const hostsLayer = {
    coverage: 'not-observed',
    reason: 'bastion exec stores the target host only in the VOLT tool-call input, never in an AEE envelope — there is no witnessed record of which granted host was actually reached',
    predicted: predictedHostsCount,
  };
  const egressLayer = {
    coverage: 'not-observed',
    reason: 'the QLarity/env origin allowlist is a permission, not a usage log — no envelope records which allowlisted origin a browser/HTTP tool call actually hit',
    predicted: predictedEgressCount,
  };
  const delegatesLayer = {
    coverage: 'not-observed',
    reason: 'a delegation call is not emitted as its own distinct AEE envelope today, so which agent actually delegated to which cannot be reconstructed from the envelope trail',
    predicted: predictedDelegatesCount,
  };

  // ============================================================
  // Recommendations — ONLY from layers with a real usage source
  // (tools, credentials). Never from hosts/egress/delegates.
  // ============================================================
  const recommendations = [];
  // Withhold tool recommendations when any execution could not be attributed:
  // one of those unattributed rows may BE the "unused" tool, and a revocation
  // recommendation built on that hole would be a false claim.
  if (unattributedToolRows === 0) {
    for (const toolId of unusedToolIds) {
      recommendations.push({
        layer: 'tools',
        statement: `tool "${toolId}" is granted to ${agentId} but had zero observed executions in the last ${windowDays} days`,
        edit: `remove "${toolId}" from the AGENT_TOOLS map entry for '${agentId}' in services/collector/lib/agentTools.js (core agents), or revoke its agent_tool_assignments row for this agent (db-backed custom agents)`,
      });
    }
  }
  for (const credentialId of unusedCredentialIds) {
    recommendations.push({
      layer: 'credentials',
      statement: `credential "${credentialId}" is assigned to ${agentId} but had zero observed uses in the last ${windowDays} days`,
      edit: `quox vault assignments --agent ${agentId} to find the assignment id for credential ${credentialId}, then quox vault unassign <assignmentId>`,
    });
  }

  const result = {
    v: 1,
    window_days: windowDays,
    computed_at: computedAt,
    layers: {
      tools: toolsLayer,
      credentials: credentialsLayer,
      hosts: hostsLayer,
      egress: egressLayer,
      delegates: delegatesLayer,
    },
    recommendations,
  };

  const zeroActivity = usedToolIds.length === 0 && usedCredentialIds.length === 0;
  if (zeroActivity) {
    result.note = 'zero observed activity in window — treat unused lists as low-confidence';
  }

  return result;
}

module.exports = {
  computeLeastPrivilege,
  isToolExecutionIntent,
  DEFAULT_WINDOW_DAYS,
};
