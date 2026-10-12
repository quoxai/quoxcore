'use strict';

/**
 * TESTER's tool-doctor — a live health probe over the agent tool surface.
 *
 * AGENT-OVERHAUL phase 7: every real defect this session (KEEPER 401s,
 * quoxagent 401s, browser crash-on-empty-input) was found by manually driving
 * tools and eyeballing the result. There was no way to ask "which of my ~300
 * tools actually work right now?" — so broken tools sat invisible. This turns
 * that manual sweep into a re-runnable capability owned by the QA agent.
 *
 * SAFETY IS THE FIRST PRINCIPLE. The doctor NEVER calls a destructive or
 * approval-gated tool. It drives ONLY tools whose name is unambiguously
 * read-only, whose executor exists, and which carry no requiresApproval flag.
 * Everything else is reported as skipped, never invoked.
 */

// Unambiguously read-only verbs — a tool must match one of these to be probed.
const READ_ONLY = /(_status$|_list$|_get$|_check$|_read$|_summary$|_info$|_health$|_active$|_search$|_stats$|_explain$|_targets$|_dependencies$|_incidents$)/i;

// Any mutation verb — a match here means NEVER probe, even if READ_ONLY also
// matches (e.g. keeper_update_check contains "update"; skip it to be safe).
const DESTRUCTIVE = /(create|delete|destroy|remove|restart|reboot|shutdown|revoke|deploy|clone|snapshot|cleanup|restore|reset|install|block|unblock|write|_set$|kill|purge|drop|execute|\brun\b|certify|suspend|migrate|\bstart\b|\bstop\b|trigger|send|manage|update|patch|move|_add$|edit|rollback|approve|deny|import|export)/i;

// These never get probed regardless (recursion / side-effecting orchestration).
const NEVER = new Set(['tools_doctor', 'delegate_to_agent', 'orchestrate_objective']);

function classify(name, def) {
  if (NEVER.has(name)) return { probe: false, reason: 'skipped-meta' };
  if (!def || typeof def.execute !== 'function') return { probe: false, reason: 'no-executor' };
  if (def._requiresApproval === true) return { probe: false, reason: 'skipped-gated' };
  if (DESTRUCTIVE.test(name)) return { probe: false, reason: 'skipped-destructive' };
  if (!READ_ONLY.test(name)) return { probe: false, reason: 'skipped-unclassified' };
  return { probe: true };
}

// A raw Node/type error surfacing to the caller = unvalidated-input crash,
// whether it was thrown or swallowed into a success:false body.
const CRASH_RE = /must be of type|Received undefined|is not a function|Cannot read|of undefined|of null|reading '/i;
// The doctor drives service-side with no user JWT, so a tool that legitimately
// needs a user/org session cannot be probed — inconclusive, NOT a bug.
const NEEDS_CTX_RE = /org_context_required|authenticated user session|organi[sz]ation context|authentication_required|no authentication token|Missing CSRF|csrf_validation/i;
// Honest "I can't do it because the target/credential/backend/input is absent".
const HONEST_RE = /not configured|no configured executor|not[_ ]implemented|Missing required|\bis required\b|parameter is required|not connected|not yet connected|router_not_configured|no such|unavailable|credential_resolve_failed|host not found|Bastion returned 404|not found|retired|requires a .*(backend|map|monitoring|service)|no .* configured/i;

function verdictOf(result, threw, errMsg) {
  if (threw) {
    if (/timeout/i.test(errMsg || '')) return 'TIMEOUT';
    if (CRASH_RE.test(errMsg || '')) return 'CRASH';
    return 'threw';
  }
  const s = JSON.stringify(result == null ? {} : result);
  if (/"success"\s*:\s*true/.test(s)) return 'ok';
  if (CRASH_RE.test(s)) return 'CRASH';           // node error swallowed into success:false
  if (NEEDS_CTX_RE.test(s)) return 'needs-context'; // inconclusive without a session
  if (HONEST_RE.test(s)) return 'honest-absent';    // honest, expected limitation
  if (/"success"\s*:\s*false/.test(s)) return 'error'; // genuine unexplained failure — worth a look
  return 'unknown';
}

/**
 * @param {object} TOOL_DEFS  the collector tool registry
 * @param {object} ctx        execution context (orgId etc.)
 * @param {number} timeoutMs  per-tool probe timeout
 * @returns {Promise<object>} health report
 */
async function runDoctor({ TOOL_DEFS, ctx = {}, timeoutMs = 12000 } = {}) {
  const report = {
    generatedAt: null, // stamped by the caller (Date.now() is unavailable in some sandboxes)
    total: 0, probed: 0, skipped: 0,
    byVerdict: {}, skippedReasons: {},
    broken: [],       // CRASH / threw / error / NO-EXECUTOR — the actionable list
    needsContext: [], // returned "needs a user/org session" — inconclusive service-side
    healthy: [],      // ok
  };
  for (const [name, def] of Object.entries(TOOL_DEFS || {})) {
    report.total++;
    const c = classify(name, def);
    if (!c.probe) {
      report.skipped++;
      report.skippedReasons[c.reason] = (report.skippedReasons[c.reason] || 0) + 1;
      if (c.reason === 'no-executor') report.broken.push({ name, verdict: 'NO-EXECUTOR' });
      continue;
    }
    let result, threw = false, errMsg = '';
    try {
      result = await Promise.race([
        def.execute({}, { orgId: ctx.orgId || 'default', agentId: 'tester', ...ctx }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
    } catch (e) { threw = true; errMsg = e && e.message ? e.message : String(e); }
    const v = verdictOf(result, threw, errMsg);
    report.probed++;
    report.byVerdict[v] = (report.byVerdict[v] || 0) + 1;
    if (v === 'ok') report.healthy.push(name);
    else if (v === 'needs-context') report.needsContext.push(name);
    else if (v === 'CRASH' || v === 'threw' || v === 'error' || v === 'TIMEOUT') {
      report.broken.push({ name, verdict: v, detail: (threw ? errMsg : JSON.stringify(result || {})).slice(0, 140) });
    }
    // honest-absent / unknown: healthy enough (honest), counted in byVerdict only
  }
  return report;
}

module.exports = { runDoctor, classify, verdictOf, READ_ONLY, DESTRUCTIVE };
