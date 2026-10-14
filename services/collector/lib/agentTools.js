/**
 * Agent Tool Definitions & Executors
 *
 * Maps agent tools to native executors and bastion API.
 * Used by the /chat/claude endpoint to give Claude real tool execution.
 *
 * TOOLS MUST BE DEFINED HERE to be executable. If a tool name appears
 * in agentRegistry.js but not here, it will silently fail.
 */

const BASTION_URL = process.env.BASTION_URL || '';
const BASTION_TOKEN = process.env.BASTION_API_TOKEN || '';
const { BASTION_UNAVAILABLE_MESSAGE } = require('./bastionUnavailable');
const QUOXFLOW_URL = process.env.QUOXFLOW_URL || 'http://quoxflow:3200';

// Native tool executors (Phase 3.2 — replace n8n webhooks with direct execution)
const { buildCanonicalAction, actionEvidenceCommitment } = require('./canonicalAction.js');
// QUOXTRUST F1 (FND_..TQ7): an authenticated ctx.orgId is authoritative and wins
// over any caller-supplied input.org_id; input.org_id is honoured only on the
// trusted internal/agentic path (no ctx.orgId). Single tenant-isolation rule.
const { resolveToolOrgId } = require('./toolExecuteOrgScope.js');
const { dockerStatus, dockerExtended } = require('./toolExecutors/docker');
const { proxmoxVms, proxmoxTemplatesList, proxmoxContainers, proxmoxCluster, proxmoxStorage, proxmoxVmAction } = require('./toolExecutors/proxmox');
const { networkCheck } = require('./toolExecutors/network');
const { systemAdmin } = require('./toolExecutors/system');
const { securityAudit, sslCertificates } = require('./toolExecutors/security');
const { metricsQuery, alertsManage } = require('./toolExecutors/monitoring');
const { withApprovalGate, checkStorePolicies, createApprovalRequest, isSafeUnderPolicyOutage } = require('./approvalGate');
// QUOXTRUST FND_01M3SGFV: strict allowlist validator for model-supplied values that get
// interpolated into a shell command sent to callBastion (docker_fleet_logs/stats container_id).
const { isSafeShellArg } = require('./shellSafe.js');

// QUOXTRUST T5/T9 (FND_..SCFP) — the shared read-only fleet-command classifier lives in
// services/shared, which is at ../../shared in the source tree but /app/services-shared in
// the container image (Dockerfile flattens services/collector -> /app). Resolve across both
// layouts, cache once, and FAIL CLOSED (classify everything as an effect → gate) if it
// cannot load — over-gate is safe, under-gate is the vuln.
// QUOXTRUST v1.4 CF1 — redact tool input before logging. The prior
// `JSON.stringify(input).substring(0,200)` dumped every tool call's raw args to
// the collector log, including free-text command/query/body fields that can carry
// a literal credential (e.g. an ssh_exec command with an inline token). Mask
// secret-named keys and reduce free-text fields to a length, so the diagnostic
// (which agent, which tool, which params) survives without ever emitting a secret.
// Allowlist-by-shape, never dump-then-redact.
const _LOG_SECRET_KEY_RE = /secret|token|password|passphrase|credential|private[_-]?key|api[_-]?key|authorization|cookie|session/i;
const _LOG_FREE_TEXT_KEY_RE = /^(command|cmd|query|body|script|input|prompt|content|message|text|sql|args|payload)$/i;
function summarizeToolInputForLog(input) {
  if (input == null || typeof input !== 'object') return typeof input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (_LOG_SECRET_KEY_RE.test(k)) { out[k] = '[redacted]'; continue; }
    if (typeof v === 'string') {
      out[k] = _LOG_FREE_TEXT_KEY_RE.test(k) ? `[str:${v.length}]` : (v.length > 64 ? `${v.slice(0, 64)}…[+${v.length - 64}]` : v);
    } else if (v && typeof v === 'object') {
      out[k] = Array.isArray(v) ? `[array:${v.length}]` : '[object]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

let _fleetReadClassifier = null;
function _getFleetReadClassifier() {
  if (_fleetReadClassifier) return _fleetReadClassifier;
  for (const p of ['../../shared/fleetReadAllowlist.cjs', '../services-shared/fleetReadAllowlist.cjs']) {
    try {
      const m = require(p);
      if (m && typeof m.isAllowlistedFleetRead === 'function') { _fleetReadClassifier = m.isAllowlistedFleetRead; return _fleetReadClassifier; }
    } catch { /* try next layout */ }
  }
  console.warn('[Tools] fleetReadAllowlist not resolvable — remote_ssh fails CLOSED (all commands gated)');
  _fleetReadClassifier = () => false; // fail closed: nothing is "read-only" → everything gates
  return _fleetReadClassifier;
}
// QUOXTRUST T9/D4 — the reference monitor: the single shared GOV-4 governance +
// approval decision, used by BOTH the native and connector dispatch paths so one
// org policy governs every path (closes finding 5.1). Deps injected to avoid a
// circular require (they live in approvalGate, imported just above).
const referenceMonitor = require('./referenceMonitor');
const { classifyPluginToolEffect } = require('./effectVerbs');
const GOV_MONITOR_DEPS = { checkStorePolicies, isSafeUnderPolicyOutage, createApprovalRequest };
const configResolver = require('./configResolver.js');
const { createPendingSkill } = require('./skillCreate.js');
// QDIS-NEXT Phase 3 — VULCAN code-writing capability. githubProposeFix does the
// actual GitHub-mutating work (branch + commit + PR, never merges); it is
// wrapped in withApprovalGate below exactly like docker_fleet_container_action
// and proxmox_vm_action, NOT dispatched through the unenforced generic
// connector bridge that github_create_issue/create_release/rerun_workflow use.
const { githubProposeFix } = require('./toolExecutors/githubPullRequest');
const { resolveConnectorCredentials } = require('./connectors/bridge');
const { logForgePrOpened } = require('./forgeFeedLog');
// BLAST-RADIUS-P2: the reach_agent tool consumes the same shared reach
// runtime the GET route and the approval gate use (lib/reach/runtime.js,
// set once at server.js boot) — one evaluation shape, witnessed the same
// way, regardless of which door it came through.
const { getReachRuntime, auditReachEvaluation } = require('./reach/runtime.js');

// QDIS-NEXT Phase 3 addendum (owner: visibility when VULCAN actually does
// something, not just the raw #triage conversation) — best-effort,
// fire-and-forget append to the forge-feed event log, ONLY called after
// github_create_pull_request's gated action really executed (a real PR got
// opened), never on the pending/denied/error responses.
//
// FIX (found while wiring the sibling gripe-feed hook, which uncovered the
// same bug): this originally shelled out to ~/bin/session-mail, a host CLI
// script under /opt/quoxcore, which is a read-only bind mount in the
// collector container — that write could never have succeeded in a
// deployed container. logForgePrOpened() writes to the writable
// collector-data volume instead, same fix already applied to gripeFeedLog.js.
function _postForgeFeedMail(toolInput, result) {
  const pr = result.pr || {};
  logForgePrOpened({ repo: toolInput.repo, number: pr.number, title: pr.title || toolInput.title, url: pr.url });
}

// GOV: voltDb ref for governance tools (set by server.js via setGovDatabase)
let _govVoltDb = null;
function setGovDatabase(db) { _govVoltDb = db; }

// QUOXTRUST D6/T9 — the audit envelope sink for the executeTool CHOKE evidence
// emit. server.js injects its own storeAuditEnvelope here at boot (the same fn
// the gold /api/v1/tools/execute path uses), so every native tool that runs to
// completion at the choke leaves a witnessed per-tool receipt regardless of
// which of the 20+ direct executeTool callers dispatched it. Null when unwired
// (pre-init / a unit test that does not exercise the choke) — the choke emit is
// then a no-op, never a crash.
let _auditEmitter = null;
function setAuditEmitter(fn) { _auditEmitter = typeof fn === 'function' ? fn : null; }

// QUOXTRUST D6/T9 — emit the per-tool evidence receipt AT THE CHOKE. Called by
// executeTool for every native tool it runs to completion (success OR failure),
// so a registered agent cannot execute a native tool without leaving a witnessed
// trail — the property is by construction, not by each caller remembering to
// emit. Before this, reach/leastPrivilege.js documented the gap in the code's own
// words: only /api/v1/tools/execute + the 3 emitToolEvidence dispatcher paths
// emitted a tool-execution envelope; 20+ other direct executeTool callers
// (server.js ssh_exec, the fleet pattern handlers, the claudeCli status probes)
// executed real effects and emitted NOTHING.
//
// The 5 caller sites that ALREADY emit their own (richer, run-lifecycle-chained)
// per-tool evidence set ctx._callerEmitsToolEvidence; the choke defers to them so
// there is no double-emit. Any OTHER path gets the choke receipt by default.
//
// Scope (honest): NATIVE tools only. Connector tools return earlier (their
// evidence is the bridge's concern) and DENIED/PENDING never execute. This is a
// post-execution best-effort receipt, not yet durable-intent-before-dispatch (T3);
// a crash between execute and this emit would still lose the record.
function _emitChokeToolEvidence(toolName, toolDef, input, ctx, durationMs, success, error, disposition = 'executed', force = false) {
  // A governance DENY is not the execution receipt the gold callers emit — they
  // only emit executed/failed on the RESULT, and a deny returns before any
  // execution, so without force=true a denied call on the gold/internal routes
  // is either unwitnessed or (worse) mislabeled as a success by the caller's
  // unconditional emit. Denies therefore bypass the _callerEmitsToolEvidence
  // opt-out; the caller is told (via _governanceDenied on the response) to skip
  // its own emit so there is no double-count. (Live 2026-09-28: a deny drive
  // produced ZERO ops.tool.denied and a false success receipt.)
  if (!ctx) return { delivered: false };
  if (ctx._callerEmitsToolEvidence && !force) return { delivered: false }; // a gold caller emits its own execution receipt
  if (!_auditEmitter) return { delivered: false }; // unwired (pre-init / non-choke unit test) — no-op
  try {
    const { emitToolEvidence } = require('./toolEvidence.js');
    return emitToolEvidence({
      toolName,
      toolDef,
      ctx,
      canonicalAction: ctx._canonicalAction, // T1: same action policy/approval saw
      input,
      corrId: ctx.corrId || ctx.sessionId || ctx.session_id || ctx.correlationId || undefined,
      durationMs,
      success,
      error,
      source: ctx.evidenceSource || 'choke',
      disposition,
      storeAuditEnvelope: _auditEmitter,
    });
  } catch (err) {
    // Counted, never swallowed: a broken evidence sink must not masquerade as
    // "everything witnessed" (honesty rule / silent-fallback-can-assert-a-falsehood).
    console.warn(`[Tools] CHOKE EVIDENCE EMIT FAILED for ${toolName}: ${err && err.message}`);
    return { delivered: false }; // WP4.1b: the outbox keeps the debt owed
  }
}

// LIFECYCLE-P3-D2: module-level voltEmitter ref so POWERS execute closures can
// emit power.invoke.* events without needing ctx threading through every layer.
// Set by server.js after voltEmitter is constructed.
let _powersVoltEmitter = null;
function setPowersVoltEmitter(emitter) { _powersVoltEmitter = emitter; }

// Fire-and-forget VOLT emit for POWERS invoke events.
// Emits to the shared voltEmitter if available; silently skips if not.
function _emitPowersInvokeVolt(runId, eventType, toolDefId, orgId, extra = {}) {
  if (!_powersVoltEmitter || !_powersVoltEmitter.isAvailable()) return;
  if (!runId) return;
  try {
    _powersVoltEmitter.emit(runId, eventType, {
      tool_def_id: toolDefId,
      org_id: orgId,
      ...extra,
    });
  } catch (err) {
    // Non-fatal — never block invocation
  }
}

// Gemini CLI executor (review-and-synthesis agent)
const { geminiReview, geminiAnalyze, geminiGenerate } = require('./toolExecutors/geminiCli');

// Perplexity API executor (web research & verification agent)
const { perplexitySearch, perplexityResearch, perplexityVerify } = require('./toolExecutors/perplexityApi');
// VAULT-INTEG P3: single implementation of provider-key vault resolution
// (lib/providerKeys.js — the same module server.js's getProviderKeys()
// delegates to). 'perplexity' is already in PROVIDER_TYPE_MAP/
// PROVIDER_KEY_FIELDS, so this reuses that path instead of the tool reading
// process.env.PERPLEXITY_API_KEY directly.
const providerKeysLib = require('./providerKeys');

// Codebase executor (RepoBrain codebase queries)
const { codebaseQuery } = require('./toolExecutors/codebase');

// QuoxBrain executor (per-org knowledge brain queries) — QUOXBRAIN P2a
const { brainSave } = require('./toolExecutors/brainSave');
const { brainUpdate, brainDelete, brainRelated, brainHistory, brainRestore, brainNeighbours } = require('./toolExecutors/brainNotes');
const { brainGardenApply, validateGardenInput } = require('./toolExecutors/brainGarden');
const { emitNotes: emitGardenNotes } = require('./notesq/evidence');
const { quoxbrainSearch, quoxbrainRead, brainSuggestions, brainBrief, brainContext, brainCheck, brainWhy, UNAVAILABLE_MSG: QUOXBRAIN_UNAVAILABLE_MSG } = require('./toolExecutors/quoxbrain');

// ONE-BRAIN Phase A2 (QuoxPlan #493): unified recall — runs memory_search,
// quoxbrain_search and execution_intelligence search_wisdom concurrently and
// dedups/ranks into one provenance-tagged answer set. See lib/recallSearch.js
// and lib/recallMerge.js (the dedup/merge core, unit-tested directly).
const { recallSearch } = require('./recallSearch');

// Grafana executor (dashboard queries, alert rules)
const { grafanaDashboards } = require('./toolExecutors/grafana');
// VAULT-INTEG P3: pure vault-vs-env decision for the Grafana API key —
// see grafanaCredentials.js header for why this replaced a module-level const.
const { resolveGrafanaApiKey, resolveGrafanaBaseUrl } = require('./grafanaCredentials');

// Memory tools
const { handleMemoryTool, isMemoryTool } = require('./memoryToolHandlers');
const { getClaudeTools: getMemoryClaudeTools, memorySystemPrompt } = require('./memoryTools');

// Action Tracker tools for task management
const { handleActionTool, isActionTool } = require('./actionToolHandlers');
const { actionSystemPrompt } = require('./actionTools');

// KEEPER tools — auth service wrapper for backup/update endpoints
const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}/api`;

async function keeperAuthFetch(path, method = 'GET', body = null) {
  try {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '',
      },
      signal: AbortSignal.timeout(30000),
    };
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }
    const resp = await fetch(`${AUTH_BASE_URL}${path}`, options);
    const text = await resp.text();
    const data = text ? JSON.parse(text) : null;
    if (!resp.ok) {
      return { success: false, error: data?.message || data?.error || `HTTP ${resp.status}`, status: resp.status };
    }
    return { success: true, ...(data || {}) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// AGENT-OVERHAUL: keeper_backup_status hits the auth service's INTERNAL
// (service-key gated) backup-status endpoint instead of the user-facing
// /orgs/:orgId/backup-status route. The user-facing route requires a
// browser JWT (requireOrgMembership) which KEEPER never has — it always
// 401'd "No authentication token provided". The internal route is
// service-key gated and CSRF-exempt (services/auth/routes/internal-backups.js
// GET /backups/status?org_id=), and requires an explicit org_id — never a
// default/wildcard org. Guards on response.ok before treating the body as
// data (a non-2xx must never be reported as a successful status).
async function keeperInternalBackupStatus(orgId) {
  if (!orgId) {
    return { success: false, error: 'No org context — cannot fetch backup status without an organization' };
  }
  try {
    const resp = await fetch(`${AUTH_BASE_URL}/internal/backups/status?org_id=${encodeURIComponent(orgId)}`, {
      method: 'GET',
      headers: { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '' },
      signal: AbortSignal.timeout(30000),
    });
    const text = await resp.text();
    const data = text ? JSON.parse(text) : null;
    if (!resp.ok) {
      return { success: false, error: data?.message || data?.error || `HTTP ${resp.status}`, status: resp.status };
    }
    return { success: true, ...(data || {}) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Connector Bridge — Phase 6.4 (dynamic external tool activation)
const { executeConnectorTool, getAvailableTools: getConnectorTools } = require('./connectors/bridge');
const { listConnectors } = require('./connectors/registry');

// QDIS-NEXT #439: gripe-feed real completion hook (see gripeFeedLog.js header).
// Test-only override seam — same pattern as __setSshClientForTesting /
// __setDockerForTesting elsewhere in this repo, needed because vitest's
// module runner does not intercept nested CJS require() calls transitively.
const { logGripeIssueFiled: _realLogGripeIssueFiled } = require('./gripeFeedLog');
let _gripeFeedLogOverride = null;
function __setGripeFeedLogForTesting(stub) { _gripeFeedLogOverride = stub; }
function logGripeIssueFiled(evt) { return (_gripeFeedLogOverride || _realLogGripeIssueFiled)(evt); }

// LICENSE-LAUNCH LL-6d: server-side entitlement gate for GOVERNED AGENTS.
// A handful of agents ARE paid entitlements — their id sits in the auth
// service's GOVERNED_PLUGIN_IDS (services/auth/lib/entitlements.js). GRIPE is
// the first: the id 'gripe' is governed there, so filing GitHub issues through
// the chat-native GRIPE agent is a paid capability.
//
// The client-side src/config/agentRegistry.js declares `requiresPlugin` for
// DISPLAY gating, but that is a free-client field with no teeth: an unentitled
// org can still select the agent in ordinary chat, and QUOX/BOB can delegate to
// it, then reach github_create_issue for free. This map is the SERVER-SIDE
// mirror (same pattern as CONNECTOR_FAMILIES / AGENT_TOOLS in this file) that
// executeTool() enforces BEFORE any tool runs — direct selection or delegation
// alike. Keep the entries in sync with the `requiresPlugin` declarations in
// src/config/agentRegistry.js; the agent's entitlement id equals the plugin id.
const AGENT_REQUIRES_PLUGIN = {
  // GITQ Stream A (2026-09-29): the GitQ plugin (registry id 'github') ships three
  // agents, all gated on the 'github' entitlement. Mirrors requiresPlugin:'github'
  // in src/config/agentRegistry.js. Owner decision: gripe ships WITH GitQ at no
  // extra cost (included in the paid price), so it is folded from its old free
  // 'gripe' entitlement into 'github'; the standalone 'gripe' entitlement is now
  // vestigial (gripe.json stays a dev-suite-bundle member that always ships github).
  forge: 'github',
  gitq: 'github',
  gripe: 'github',
  // X-PLUGIN phase 9 (2026-09-16): HERALD is a paid entitlement; 'x' is in
  // the auth service's governed set. Mirrors requiresPlugin: 'x' in
  // src/config/agentRegistry.js.
  xtwitter: 'x',
  // INBOXQ-AGENT (P2b, INBOXQ_AGENT_DESIGN.md honest-gap 1): the client-side
  // agentRegistry.js already declares requiresPlugin:'inboxq' for INBOXQ, but
  // that is display-only gating with no server teeth — this is the mirror
  // executeTool() actually enforces, same pattern as gripe/xtwitter above.
  inboxq: 'inboxq',
  // NOTESQ agent: same server-side entitlement mirror as inboxq above.
  notesq: 'notesq',
};

// X-PLUGIN phase 9: governed NATIVE TOOLS, actor-independent. The agent gate
// above only fires when ctx.agentId IS the governed agent; the orchestrator's
// allowlist carries x_post et al directly, and the service-caller contract
// lets any known agent id ride, so gating the agent alone leaves the
// capability open — the exact class the bridge's CAPABILITY_REQUIRES_PLUGIN
// comment describes. This map gates the TOOL, whoever executes it. Key =
// tool name, value = required plugin entitlement id. Fail CLOSED.
const TOOL_REQUIRES_PLUGIN = {
  x_post: 'x',
  x_thread: 'x',
  x_delete: 'x',
  x_like: 'x',
  x_repost: 'x',
  x_budget_status: 'x',
  // INBOXQ-AGENT (P2b, INBOXQ_AGENT_DESIGN.md honest-gap 1): gates the TOOL
  // itself, actor-independent — so no other agent can borrow inbox_* into an
  // unlicensed org via delegation, same reasoning as the X-PLUGIN comment
  // above this map.
  inbox_accounts: 'inboxq',
  inbox_zones: 'inboxq',
  inbox_folders: 'inboxq',
  inbox_search: 'inboxq',
  inbox_get: 'inboxq',
  inbox_proposals: 'inboxq',
  inbox_blocked: 'inboxq',
  inbox_report_latest: 'inboxq',
  inbox_propose_move: 'inboxq',
  inbox_propose_rezone: 'inboxq',
  inbox_propose_block: 'inboxq',
  inbox_propose_create_folder: 'inboxq',
  inbox_move: 'inboxq',
  inbox_rezone: 'inboxq',
  inbox_block: 'inboxq',
  inbox_create_folder: 'inboxq',
  // NOTESQ agent: gates the TOOL itself, actor-independent (see inbox_* above).
  notesq_search: 'notesq',
  notesq_list: 'notesq',
  notesq_read: 'notesq',
  notesq_create: 'notesq',
  notesq_update: 'notesq',
  notesq_tag: 'notesq',
  notesq_history: 'notesq',
  notesq_restore: 'notesq',
  notesq_delete: 'notesq',
  notesq_related: 'notesq',
  notesq_suggest_links: 'notesq',
  notesq_health: 'notesq',
  notesq_research: 'notesq',
  // L2-C1 U4: gates the TOOL itself, actor-independent — same reasoning as
  // inbox_* above, keyed to the same 'calendar-q' licence id api.js's
  // registerCalendarQRoutes enforces on every HTTP route.
  calendar_agenda: 'calendar-q',
  calendar_coverage_status: 'calendar-q',
  calendar_event_get: 'calendar-q',
  calendar_layers_list: 'calendar-q',
  calendar_changes: 'calendar-q',
};

/** The plugin entitlement id a native tool requires, or null (common case). */
function getRequiredPluginForTool(toolName) {
  return TOOL_REQUIRES_PLUGIN[toolName] || null;
}

/**
 * The plugin entitlement id a governed agent requires, or null for an
 * un-governed agent (the common case — no gate fires).
 * @param {string} agentId
 * @returns {string|null}
 */
function getRequiredPluginForAgent(agentId) {
  const agentKey = (agentId || '').toLowerCase();
  return AGENT_REQUIRES_PLUGIN[agentKey] || null;
}

// Test-only override seam for the entitlement gate — same pattern as
// __setGripeFeedLogForTesting above. The real gate hits the auth service via
// lib/licenseGate.js (isPluginLicensed(orgId, pluginId) -> auth has-plugin).
const { isPluginLicensed: _realIsPluginLicensed, __setLicenseGateOverrideForTesting: _setSharedLicenseOverride } = require('./licenseGate');
let _isPluginLicensedOverride = null;
function __setLicenseGateForTesting(fn) {
  _isPluginLicensedOverride = fn;
  // LL-6d C5: also drive the shared licenseGate override so the CAPABILITY gate
  // at the connector choke (lib/connectors/bridge.js, which routes through
  // licenseGate directly) sees the same test entitlement answer as this
  // agent-level gate. Without this, a test holding the agent gate open would
  // still hit the real auth fetch inside the bridge and fail closed.
  _setSharedLicenseOverride(fn);
}
function isPluginLicensedForAgentGate(orgId, pluginId) {
  return (_isPluginLicensedOverride || _realIsPluginLicensed)(orgId, pluginId);
}

// VAULT-AUDIT P3.D1 — email_read (IMAP mailbox tool)
const { readMailbox } = require('./toolExecutors/email');
const { buildInternalServiceHeaders } = require('./internalServiceHeaders.js');

// Testing seam for email_read — see toolExecutors/email.js header comment
// for why this lives here (same module instance as TOOL_DEFS) rather than
// on toolExecutors/email.js itself.
let _emailImapFlowOverride = null;
let _emailSimpleParserOverride = null;
function __setImapFlowForTesting(cls) { _emailImapFlowOverride = cls; }
function __setSimpleParserForTesting(fn) { _emailSimpleParserOverride = fn; }

// quox#813: InboxQ keeps its mailbox accounts (each pointing at an
// email_account vault credential) in its own store, so a vault agent
// assignment / org default may not exist even though a mailbox is connected
// and polling. email_read reads that store only to NAME the credential in its
// error (never to use it unassigned). Returns the org's accounts or [].
let _inboxqAccountsLookupOverride = null;
function __setInboxqAccountsLookupForTesting(fn) { _inboxqAccountsLookupOverride = fn; }
function lookupInboxqAccounts(orgId) {
  try {
    if (_inboxqAccountsLookupOverride) return _inboxqAccountsLookupOverride(orgId) || [];
    return require('./inboxq/store.js').listAccounts(orgId) || [];
  } catch { return []; }
}

// VAULT-AUDIT P3.D3 — email_send (SMTP mailbox tool)
const { sendMail } = require('./toolExecutors/emailSend');

// Testing seam for email_send — same rationale as the email_read seam above.
let _emailNodemailerOverride = null;
function __setNodemailerForTesting(mod) { _emailNodemailerOverride = mod; }

// QUOXTRUST T3 (D3 durability) — durable execution ledger for agent external
// effects (email_send). Injected via setExecutionLedger(aeeDb) from server.js;
// null = not configured (no-op, effects proceed) exactly like the connector
// bridge. A configured handle whose write THROWS makes the send fail closed
// (no dispatch without durable intent).
const _executionLedger = require('./executionLedger');
let _executionLedgerDb = null;
function setExecutionLedger(db) { _executionLedgerDb = db || null; }

// VAULT-AUDIT P4.B — tls_cert_info (vault tls_cert credential parser)
const { parseCertificate } = require('./toolExecutors/tls');

// VAULT-AUDIT P4.A-collector — remote_ssh (vault ssh_key credential, TOFU host-key verification)
const { runSshCommand } = require('./toolExecutors/ssh');

// Testing seam for remote_ssh — same rationale as the email_read seam above.
let _sshClientOverride = null;
function __setSshClientForTesting(cls) { _sshClientOverride = cls; }

// VAULT-AUDIT P4.C — db_query (vault database credential, Postgres)
const { runQuery } = require('./toolExecutors/db');

// Testing seam for db_query — same rationale as the email_read seam above.
let _pgClientOverride = null;
function __setPgClientForTesting(cls) { _pgClientOverride = cls; }

// ============================================================================
// VAULT-P5.H — resolveForAgent's collector-side caller (F4)
// ============================================================================
//
// Calls the new auth endpoint POST /api/setup/internal/resolve-for-agent
// (services/auth/routes/setup.js), the toolType/agentId-aware sibling of
// resolveCredentials()/resolveCredentialById() (collector/server.js) — those
// two stay lease-EXEMPT platform plumbing (LLM provider keys, user-picked
// credential IDs); this is the path for tools that declare a
// `credentialedIntegration` (an agent-scoped, toolType-keyed lookup through
// the agent_credential_assignments -> org-default -> instance -> env
// waterfall, gated by the org's vault.lease_enforcement mode).
//
// Returns:
//   - resolveForAgent()'s result shape on success (key/credentials/source/...)
//   - { leaseBlocked: true, leaseReason } when the org is in `enforced` mode
//     and the resolved credential requires a lease this agent doesn't hold
//   - null on any transport/auth failure (never throws — callers must treat
//     null as "could not resolve", not as "no credential configured")
async function resolveCredentialForAgent(orgId, agentId, toolType, options = {}) {
  if (!orgId || !agentId || !toolType) return null;
  try {
    const resp = await fetch(`${AUTH_BASE_URL}/setup/internal/resolve-for-agent`, {
      method: 'POST',
      headers: buildInternalServiceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        org_id: orgId,
        agent_id: agentId,
        tool_type: toolType,
        fallback_to_instance: options.fallbackToInstance !== false,
        fallback_to_env: options.fallbackToEnv !== false,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.status === 403) {
      const data = await resp.json().catch(() => ({}));
      return { leaseBlocked: true, leaseReason: data?.reason || 'lease_required' };
    }
    if (!resp.ok) {
      console.warn(`[Vault] resolve-for-agent returned ${resp.status} for ${agentId}/${toolType}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.warn(`[Vault] resolve-for-agent failed for ${agentId}/${toolType}:`, err.message);
    return null;
  }
}

// VAULT-INTEG P3 — resolveCredentials() for lib/providerKeys.js's injection
// seam. Mirrors server.js's own resolveCredentials(orgId, providers) (the
// /api/setup/internal/resolve call it makes for getClaudeKeys()/
// getProviderKeys()), minus the circuit breaker: this file is a much lower
// call-volume path (perplexity_* tools only) so a bare try/catch is enough,
// and providerKeys.js's own 30s cache already absorbs repeat calls.
async function _resolveVaultProviderCredentials(orgId, providers) {
  try {
    const resp = await fetch(`${AUTH_BASE_URL}/setup/internal/resolve`, {
      method: 'POST',
      headers: buildInternalServiceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ org_id: orgId || 'default', providers, channels: [] }),
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) return await resp.json();
    console.warn(`[Vault] resolve returned ${resp.status} for providers [${providers.join(',')}]`);
  } catch (err) {
    console.warn(`[Vault] resolve failed for providers [${providers.join(',')}]:`, err.message);
  }
  return null;
}

/**
 * Resolve the org's Perplexity API key via the SAME vault-first waterfall
 * (lib/providerKeys.js) the LLM providers use — 'perplexity' is already in
 * PROVIDER_TYPE_MAP/PROVIDER_KEY_FIELDS. Returns '' (never throws) when
 * unresolved; perplexityApi.js's own env fallback covers that case.
 */
async function resolvePerplexityApiKey(orgId) {
  const keys = await providerKeysLib.getProviderKeys(orgId, { resolveCredentials: _resolveVaultProviderCredentials });
  return keys?.perplexity_api_key || '';
}

// ============================================================================
// Tool Executors
// ============================================================================

/**
 * Execute a command on a remote host via bastion API
 */
// Cache of IP→hostname mapping from bastion fleet
let _ipToHostCache = null
let _ipToHostCacheTime = 0
const IP_CACHE_TTL = 300000 // 5 min

async function resolveHostId(hostId) {
  // If it doesn't look like an IP, return as-is
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostId)) return hostId

  // Build IP→hostname cache from bastion fleet
  if (!_ipToHostCache || Date.now() - _ipToHostCacheTime > IP_CACHE_TTL) {
    try {
      const resp = await fetch(`${BASTION_URL}/api/v1/hosts`, {
        headers: BASTION_TOKEN ? { 'Authorization': `Bearer ${BASTION_TOKEN}` } : {},
        signal: AbortSignal.timeout(5000)
      })
      if (resp.ok) {
        const data = await resp.json()
        const hosts = data.hosts || data || []
        _ipToHostCache = new Map()
        for (const h of hosts) {
          const ip = h.ip || h.host
          const id = h.id || h.host_id || h.hostname
          if (ip && id) _ipToHostCache.set(ip, id)
        }
        _ipToHostCacheTime = Date.now()
        console.log(`[Tools] Bastion IP cache built: ${_ipToHostCache.size} hosts`)
      }
    } catch { /* cache miss — try raw hostId */ }
  }

  const resolved = _ipToHostCache?.get(hostId)
  if (resolved) {
    console.log(`[Tools] Resolved IP ${hostId} → hostname ${resolved}`)
    return resolved
  }
  return hostId // fall through with the IP, bastion will 404
}

async function callBastion(hostId, command, grant) {
  if (!BASTION_URL || !BASTION_TOKEN) {
    return { success: false, error: BASTION_UNAVAILABLE_MESSAGE };
  }

  // Resolve IP addresses to bastion hostnames
  const resolvedHost = await resolveHostId(hostId)
  const url = `${BASTION_URL}/api/v1/exec`;
  console.log(`[Tools] Bastion exec on ${resolvedHost}${resolvedHost !== hostId ? ` (resolved from ${hostId})` : ''}: ${command.substring(0, 80)}`);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BASTION_TOKEN}`,
        // QUOXTRUST T4: attach the HITL approval grant when present so a
        // mode:risky bastion accepts the exact approved command. Absent =>
        // header omitted (byte-identical to before; a risky call with no grant
        // still fails closed bastion-side).
        ...(grant ? { 'X-Bastion-Approval-Grant': grant } : {})
      },
      body: JSON.stringify({ targets: [resolvedHost], command }),
      signal: AbortSignal.timeout(30000)
    });

    if (!resp.ok) {
      const text = await resp.text();
      return require("./bastionRefusal.js").bastionHttpErrorResult(resp.status, text); // #815: a 403 is a refusal, never an approval card
    }

    const data = await resp.json();
    // Bastion returns { count, results: [...] } — extract the single host result
    if (data.results && data.results.length > 0) {
      const r = data.results[0];
      return {
        success: r.exit_code === 0,
        exit_code: r.exit_code,
        stdout: r.stdout,
        stderr: r.stderr,
        error: r.error || (r.exit_code !== 0 ? r.stderr : undefined),
        host: r.host_id,
        duration_ms: r.duration_ms
      };
    }
    return data;
  } catch (err) {
    console.error(`[Tools] Bastion error:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * QUOXTRUST T4 — wrap callBastion so a gated NATIVE bastion tool
 * (proxmox_vm_action, docker_fleet_container_action) attaches the HITL
 * approval grant on resume, exactly like the entity path (bastionSshExecutor).
 * Before this, those tools called the grant-less callBastion, so on a
 * mode:risky bastion they 403'd AFTER a human approved the card.
 *
 * Resolves the host FIRST (resolveHostId is idempotent for hostnames) so the
 * grant binds to the SAME target string sent to bastion, then mints a grant
 * scoped to {exact command, [resolvedHost]} via mintFn (bastionSshExecutor's
 * mintGrantForCtx — mints ONLY when ctx.hitlApprovedItemId is set, i.e. inside
 * a human-approved resume) and calls callBastion(resolvedHost, command, grant).
 * A mint failure on an approved item is FAIL CLOSED (returns success:false,
 * never executes ungranted). Non-approved calls never reach here —
 * withApprovalGate holds them for approval first.
 */
/**
 * Run a gated ssh_exec under a fleet standing grant (lib/fleetStandingGrants.js).
 * Records the use as a tool_approvals row (status resuming -> approved|error) and an
 * AEE envelope BEFORE dispatch, mints a standing-grant-anchored bastion grant (fail
 * closed), then runs the exact command.
 */
async function _runUnderStandingGrant(grant, input, ctx, bse) {
  const fsg = require('./fleetStandingGrants.js');
  const store = require('./toolApprovalStore.js');
  const approvalId = `SG_${require('crypto').randomBytes(8).toString('hex')}`;
  const inputJson = JSON.stringify({
    command: input.command,
    host: input.host,
    ...(typeof input.reason === 'string' && input.reason ? { reason: input.reason } : {}),
    _standing_grant: grant.grant_id,
  });
  try {
    store.recordStandingGrantUse({
      approval_id: approvalId, org_id: ctx.orgId, agent_id: ctx.agentId, user_id: ctx.userId,
      tool_name: 'ssh_exec', input_json: inputJson, conversation_id: ctx.conversationId,
    });
  } catch (e) {
    // No history row = no visible audit: do not run unaudited, fall back to a human.
    console.warn('[ApprovalGate] standing grant use could not be recorded, refusing:', e && e.message);
    return { success: false, error: `standing grant ${grant.grant_id} covers this call but its use could not be recorded; refusing to run unaudited` };
  }
  fsg.recordUse(ctx.orgId, grant.grant_id, { approvalId, command: input.command, userId: ctx.userId, agentId: ctx.agentId, host: input.host });
  console.log(`[ApprovalGate] fleet standing grant ${grant.grant_id} covers ssh_exec on ${input.host} (org ${ctx.orgId}, use ${approvalId})`);
  if (typeof ctx._markDispatched === 'function') ctx._markDispatched();
  const mintFn = async (_ctx, { command, targets }) => {
    const g = await bse.mintStandingGrant({ orgId: ctx.orgId, grantId: grant.grant_id, host: input.host, command, targets });
    if (!g) {
      const err = new Error(`approval grant mint failed for standing grant ${grant.grant_id} (targets: ${JSON.stringify(targets)}); refusing to execute without an X-Bastion-Approval-Grant`);
      err.code = 'grant_mint_failed';
      throw err;
    }
    return g;
  };
  let result;
  try {
    result = await makeGrantAwareCallBastion(ctx, callBastion, mintFn)(input.host, input.command);
  } catch (e) {
    result = { success: false, error: e && e.message ? e.message : String(e) };
  }
  try { store.finalize(approvalId, result && result.success === false ? 'error' : 'approved', JSON.stringify(result)); } catch { /* history best effort after dispatch */ }
  return { ...(result && typeof result === 'object' ? result : { result }), _standingGrant: { grant_id: grant.grant_id, approval_id: approvalId } };
}

function makeGrantAwareCallBastion(ctx, baseCallBastion, mintFn) {
  return async (host, command) => {
    const resolvedHost = await resolveHostId(host);
    let grant;
    try {
      grant = await mintFn(ctx, { action: 'exec', command, targets: [resolvedHost] });
    } catch (err) {
      if (err && err.code === 'grant_mint_failed') {
        return { success: false, error: err.message };
      }
      throw err;
    }
    return baseCallBastion(resolvedHost, command, grant);
  };
}

/**
 * Fetch the collector's OWN API over loopback. The API is default-deny
 * (SEC #52), so every self-fetch must carry the internal service key —
 * a bare fetch gets a 401 whose JSON body would flow to the LLM as data.
 * `assertOk` (default true) throws on non-2xx so callers fail loud.
 */
async function localApiFetch(path, options = {}, { assertOk = true } = {}) {
  const port = process.env.COLLECTOR_PORT || process.env.PORT || 9848;
  const headers = {
    ...(process.env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY } : {}),
    ...options.headers,
  };
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers });
  if (assertOk && !resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`local API ${path} → HTTP ${resp.status}: ${body.slice(0, 160)}`);
  }
  return resp;
}

// COMMANDERQ P6: latency-budgeted delegation. One shared breaker across all
// delegations this process, keyed by target agent, so a repeatedly slow/failing
// specialist fast-degrades instead of making every delegation wait 90s again.
const { runWithContract, DelegationBreaker } = require('./delegationContract.js');
const _delegationBreaker = new DelegationBreaker();
// COMMANDERQ P7: normalize the caller-supplied task_class so the routing profile
// aggregates consistently (routing_verdict task_class was hardcoded 'delegation').
const { normalizeTaskClass } = require('./artifacts/routingProfile.js');

/**
 * Honest 501 for a REGULA tool that agentRegistry.js declares but has no
 * backend yet — same shape as mikrotikExecutor.js's UNSUPPORTED_TOOLS
 * responses (structured, named gap, no fabricated data).
 */
function regulaNotImplemented(detail) {
  return { success: false, error: 'not_implemented', detail, status: 501 };
}

/**
 * VAULT-INTEG P7 — vault_types / vault_connect_guide helpers.
 *
 * A field counts as sensitive if it's a password-type input OR its key/label
 * reads like a secret (token, credential, private key, passphrase, etc). For
 * a sensitive field we drop `default` even if the registry sets one —
 * defensive, since no field in integrationTypeRegistry.js currently ships a
 * secret-looking default, but a future registry entry could. `placeholder`
 * is always kept: it's UI hint text ('sk-...'), never a real value.
 */
function _isSensitiveVaultField(f) {
  if (!f) return false;
  if (f.type === 'password') return true;
  const probe = `${f.key || ''} ${f.label || ''}`.toLowerCase();
  return /secret|token|password|credential|private[_-]?key|api[_-]?key|passphrase/.test(probe);
}

function _safeVaultField(f) {
  const safe = { key: f.key, label: f.label, type: f.type, required: !!f.required };
  if (f.placeholder) safe.placeholder = f.placeholder;
  if (!_isSensitiveVaultField(f) && f.default !== undefined) safe.default = f.default;
  return safe;
}

/** Fetch the org's integration type catalogue from the auth service — same call vault_list/vault_test make against AUTH_BASE_URL. */
async function _fetchIntegrationTypes(ctx) {
  const resp = await fetch(`${AUTH_BASE_URL}/orgs/${encodeURIComponent(ctx.orgId)}/integrations/types`, {
    headers: { Authorization: `Bearer ${ctx.token}` },
    signal: AbortSignal.timeout(10000),
  });
  const data = await resp.json().catch(() => null);
  return { resp, data };
}

/**
 * Get fleet status from collector's own API (same process, localhost)
 */
async function getFleetStatusLocal() {
  try {
    // Fetch BOTH summary and per-host data in parallel — gives Claude complete picture
    // 10s not 5s: found via QUOX-SECURITY quoxagent_install verification
    // testing 2026-08-10 that under normal collector load these two
    // self-referential calls (particularly /api/v1/agents, ~29 hosts of
    // resource data) intermittently exceeded 5s, producing a spurious
    // "target not in fleet" result for a target that genuinely was.
    const [summaryResp, agentsResp] = await Promise.all([
      localApiFetch('/api/v1/fleet/summary', { signal: AbortSignal.timeout(10000) }),
      localApiFetch('/api/v1/agents', { signal: AbortSignal.timeout(10000) })
    ]);
    const summary = await summaryResp.json();
    const agentsData = await agentsResp.json();

    // Include per-host breakdown with key fields only (keep payload manageable)
    const hosts = (agentsData.agents || []).map(a => ({
      host: a.host_id,
      ip: a.remote_addr || a.ip,
      health: a.status?.health || 'unknown',
      connection: a.status?.connection || 'unknown',
      cpu: a.resources?.cpu?.usage_percent?.toFixed(1) + '%',
      memory: a.resources?.memory?.usage_percent?.toFixed(1) + '%',
      disk: a.resources?.disk?.usage_percent ? a.resources.disk.usage_percent.toFixed(1) + '%' : 'n/a',
      uptime: a.system?.uptime_hours ? Math.floor(a.system.uptime_hours) + 'h' : 'n/a',
      containers: a.docker?.container_count ?? 'n/a',
      last_seen: a.status?.last_seen_seconds + 's ago',
      version: a.version || 'n/a'
    }));

    return { ...summary, hosts };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// Docker Fleet Executors
// ============================================================================

/**
 * Discover Docker hosts across the fleet via bastion.
 * Queries all known hosts for Docker version and container counts.
 */
async function dockerFleetScan(callBastion) {
  // Get ALL known hosts from bastion (not just QuoxAgent-registered ones)
  const bastionUrl = BASTION_URL;
  if (!bastionUrl) {
    return { success: false, error: BASTION_UNAVAILABLE_MESSAGE };
  }
  let hostIds = [];

  try {
    // Primary: query bastion's full host list (49 hosts)
    const bastionResp = await fetch(`${bastionUrl}/api/v1/hosts`, {
      headers: BASTION_TOKEN ? { 'Authorization': `Bearer ${BASTION_TOKEN}` } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (bastionResp.ok) {
      const bastionData = await bastionResp.json();
      const hosts = bastionData.hosts || bastionData || [];
      hostIds = hosts.map(h => h.id || h.host_id || h.hostname).filter(Boolean);
      console.log(`[DockerFleet] Bastion returned ${hostIds.length} hosts`);
    }
  } catch (err) {
    console.warn(`[DockerFleet] Bastion host list unavailable: ${err.message}`);
  }

  // Fallback: collector's agent registry if bastion failed
  if (hostIds.length === 0) {
    try {
      const resp = await localApiFetch('/api/v1/agents', { signal: AbortSignal.timeout(5000) });
      const data = await resp.json();
      hostIds = (data.agents || []).map(a => a.host_id).filter(Boolean);
      console.log(`[DockerFleet] Fallback to agent registry: ${hostIds.length} hosts`);
    } catch (err) {
      return { success: false, error: `Cannot discover hosts: ${err.message}` };
    }
  }

  // Deduplicate
  hostIds = [...new Set(hostIds)];

  // Query each host — batch in groups of 5 to avoid overwhelming bastion
  const dockerHosts = [];
  const batchSize = 5;
  for (let i = 0; i < hostIds.length; i += batchSize) {
    const batch = hostIds.slice(i, i + batchSize);
    await Promise.all(batch.map(async (hostId) => {
      try {
        const result = await callBastion(hostId, 'docker info --format "{{.ServerVersion}}|{{.ContainersRunning}}|{{.ContainersStopped}}|{{.Containers}}|{{.Images}}" 2>/dev/null');
        const out = (result.stdout || '').trim();
        if (out && out.includes('|') && !out.includes('Cannot connect')) {
          const [version, running, stopped, total, images] = out.split('|');
          dockerHosts.push({
            id: hostId,
            docker_version: version,
            containers_running: parseInt(running) || 0,
            containers_stopped: parseInt(stopped) || 0,
            containers_total: parseInt(total) || 0,
            images: parseInt(images) || 0
          });
        }
      } catch (err) {
        // Host doesn't have Docker or is unreachable — skip silently
        console.log(`[DockerFleet] Scan skip ${hostId}: ${err.message || 'no docker'}`);
      }
    }));
  }

  return {
    success: true,
    hosts: dockerHosts.sort((a, b) => a.id.localeCompare(b.id)),
    total_hosts: dockerHosts.length,
    scanned_hosts: hostIds.length,
    total_containers: dockerHosts.reduce((sum, h) => sum + h.containers_total, 0),
    total_running: dockerHosts.reduce((sum, h) => sum + h.containers_running, 0)
  };
}

/**
 * List containers across the fleet or a specific host.
 */
async function dockerFleetContainers(callBastion, input) {
  const showAll = input.all !== false ? '-a ' : '';
  const cmd = `docker ps ${showAll}--format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.CreatedAt}}"`;

  if (input.host) {
    // Single host
    const result = await callBastion(input.host, cmd);
    const containers = parseContainerList(result.stdout || '', input.host);
    return { success: true, containers, host: input.host, total: containers.length };
  }

  // All hosts — scan fleet first
  const fleet = await dockerFleetScan(callBastion);
  if (!fleet.success) return fleet;

  const allContainers = [];
  await Promise.all(fleet.hosts.map(async (host) => {
    const result = await callBastion(host.id, cmd);
    const containers = parseContainerList(result.stdout || '', host.id);
    allContainers.push(...containers);
  }));

  return {
    success: true,
    containers: allContainers,
    total: allContainers.length,
    hosts_queried: fleet.hosts.length
  };
}

function parseContainerList(raw, host) {
  return raw.split('\n').filter(Boolean).map(line => {
    const [id, name, image, status, ports, created] = line.split('|');
    return { id, name, image, status, ports: ports || '', created, host };
  });
}

/**
 * Perform a container lifecycle action.
 */
async function dockerFleetAction(callBastion, input) {
  const { host, container_id, action } = input;
  if (!['start', 'stop', 'restart'].includes(action)) {
    return { success: false, error: `Invalid action: ${action}` };
  }
  // QUOXTRUST FND_..SHGH (shell-injection): action is enum-validated above, but container_id was
  // interpolated raw into the shell command. Validate it too — even though this tool is gated
  // (the human sees the value in the approval card), an approver should never be able to green a
  // value that would break out of the container-id position and run something else.
  if (!isSafeShellArg('container', container_id)) {
    return { success: false, error: 'invalid_container_id', detail: 'container_id must be a valid docker name/id (injection guard)' };
  }
  const result = await callBastion(host, `docker ${action} ${container_id}`);
  return {
    success: result.success !== false,
    host,
    container: container_id,
    action,
    output: (result.stdout || result.stderr || '').trim()
  };
}

/**
 * List Docker Compose stacks across fleet.
 */
async function dockerFleetStacks(callBastion, input) {
  const cmd = `docker compose ls --format json 2>/dev/null || docker-compose ls --format json 2>/dev/null || echo "[]"`;

  if (input.host) {
    const result = await callBastion(input.host, cmd);
    const stacks = parseComposeStacks(result.stdout || '', input.host);
    return { success: true, stacks, host: input.host };
  }

  const fleet = await dockerFleetScan(callBastion);
  if (!fleet.success) return fleet;

  const allStacks = [];
  await Promise.all(fleet.hosts.map(async (host) => {
    const result = await callBastion(host.id, cmd);
    const stacks = parseComposeStacks(result.stdout || '', host.id);
    allStacks.push(...stacks);
  }));

  return { success: true, stacks: allStacks, total: allStacks.length };
}

function parseComposeStacks(raw, host) {
  try {
    const parsed = JSON.parse(raw.trim() || '[]');
    return (Array.isArray(parsed) ? parsed : []).map(s => ({ ...s, host }));
  } catch {
    return [];
  }
}

// ============================================================================
// ============================================================================
// Roadmap tool executors (read-only view of STRATEGIC_ROADMAP.json)
// ============================================================================
// The roadmap file is the owner's single source of truth, reachable via the
// collector's /opt/quoxcore mount on the dev host. Agents READ only; mutation is
// owner-only via roadmap-cli. Fail-soft when the file is absent (e.g. on prod).
const ROADMAP_PATH = process.env.STRATEGIC_ROADMAP_PATH || '/opt/quoxcore/STRATEGIC_ROADMAP.json';

function readRoadmapFile() {
  const fs = require('fs');
  const raw = fs.readFileSync(ROADMAP_PATH, 'utf8');
  return JSON.parse(raw);
}

function _compactStream(s) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    priority: s.priority,
    tier: s.tier,
    phases: (s.phases_total != null) ? `${s.phases_done || 0}/${s.phases_total}` : undefined,
    effort: s.effort,
    summary: s.summary,
  };
}

function roadmapList(input = {}) {
  let data;
  try { data = readRoadmapFile(); }
  catch (err) { return { success: false, available: false, message: 'The live roadmap is not available in this environment.', detail: err.code || err.message }; }
  const { status, tier, query, include_completed = false, limit = 25 } = input;
  let streams = Array.isArray(data.streams) ? data.streams.slice() : [];
  if (include_completed && Array.isArray(data.completed)) streams = streams.concat(data.completed);
  if (status) streams = streams.filter((s) => (s.status || '').toUpperCase() === String(status).toUpperCase());
  if (tier) streams = streams.filter((s) => (s.tier || '').toUpperCase().includes(String(tier).toUpperCase()));
  if (query) {
    const q = String(query).toLowerCase();
    streams = streams.filter((s) => [s.id, s.name, s.summary, (s.tags || []).join(' ')].join(' ').toLowerCase().includes(q));
  }
  streams.sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9));
  const total = streams.length;
  return {
    success: true,
    roadmap_updated: data.updated,
    total_matched: total,
    showing: Math.min(total, limit),
    streams: streams.slice(0, limit).map(_compactStream),
  };
}

function roadmapShow(input = {}) {
  let data;
  try { data = readRoadmapFile(); }
  catch (err) { return { success: false, available: false, message: 'The live roadmap is not available in this environment.' }; }
  const idRaw = String(input.id || '').trim();
  const all = (data.streams || []).concat(data.completed || []);
  const byNum = /^\d+$/.test(idRaw) ? Number(idRaw) : null;
  const s = all.find((x) => x.id && x.id.toUpperCase() === idRaw.toUpperCase())
    || (byNum != null ? all.find((x) => x.priority === byNum) : null);
  if (!s) return { success: false, message: `No roadmap stream matched "${idRaw}".` };
  return { success: true, roadmap_updated: data.updated, stream: s };
}

function roadmapStats() {
  let data;
  try { data = readRoadmapFile(); }
  catch (err) { return { success: false, available: false, message: 'The live roadmap is not available in this environment.' }; }
  const streams = data.streams || [];
  const by = {};
  for (const s of streams) { const k = s.status || 'UNKNOWN'; by[k] = (by[k] || 0) + 1; }
  return {
    success: true,
    roadmap_updated: data.updated,
    active_total: streams.length,
    completed_total: (data.completed || []).length,
    by_status: by,
  };
}

// Tool Definitions (Anthropic tool_use format)
// ============================================================================

const TOOL_DEFS = {
  // BLAST-RADIUS-P2: read-only, no dots in the tool id (storage rule — see
  // llm-tool-name-vs-storage-id). Lets an agent self-check its own governed
  // blast radius (or another agent's) before acting, via the exact same
  // resolver + witnessed envelope the GET route and the approval gate use.
  reach_agent: {
    name: 'reach_agent',
    description: 'Compute the governed blast radius (reach) of an agent before acting: tools, vault credentials, fleet hosts, egress origins, and delegation it may reach. Defaults to the calling agent itself.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'Agent to check reach for. Omit to check the calling agent itself.',
        },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      const orgId = ctx?.orgId;
      if (!orgId) {
        return { success: false, error: 'org_context_required', message: 'reach_agent needs an org context (org-scoped session) to resolve reach.' };
      }
      const targetAgentId = (input && input.agent_id) || ctx?.agentId;
      if (!targetAgentId) {
        return { success: false, error: 'agent_id_required', message: 'No agent_id given and no calling-agent context available to default to.' };
      }
      try {
        const { resolveStaticReach } = getReachRuntime();
        const result = await resolveStaticReach(targetAgentId, orgId);
        auditReachEvaluation({
          trigger: 'agent_tool',
          orgId,
          agentId: targetAgentId,
          corr: ctx?.corr || ctx?.correlationId || ctx?.conversationId,
          result,
        });
        return { success: true, result };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  ssh_exec: {
    name: 'ssh_exec',
    // QUOXTRUST C2/WP2: reaches outside the box — durable intent gated at the choke.
    externalEffect: true,
    // QUOXTRUST T5/T9 (FND_01M3SF9C, 2026-09-30): ssh_exec is a SECOND, older doorway to the
    // identical bastion arbitrary-shell capability as remote_ssh, and shipped ungated (the
    // external-mutation class sweep found it after remote_ssh/db_query were gated). Now gated
    // exactly like remote_ssh: a provably read-only command (the shared injection-proof fleet-read
    // allowlist) runs direct; anything else is held for human approval binding the exact host +
    // command. gatedInExecute defers the dispatch stamp to the real effect boundary.
    gatedInExecute: true,
    description: 'Execute a shell command on a remote host via SSH bastion. Use for any command not covered by specialized tools. Commands run as the control user.',
    input_schema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description: 'Target hostname (e.g. docker01, hyp-01, gw-01, kuma01). Use the short hostname, not FQDN.'
        },
        command: {
          type: 'string',
          description: 'Shell command to execute. Keep commands read-only unless explicitly asked to make changes.'
        }
      },
      required: ['host', 'command']
    },
    execute: async (input, ctx = {}) => {
      // quox#789: the approval's grant target is derived from input.host. A
      // hostless call (e.g. `quox fleet exec --host` sent as body.host_id) used
      // to be held for a human, approved, then refused at resume with
      // targets [null] and a High incident. Refuse BEFORE any approval exists.
      if (typeof input?.host !== 'string' || !input.host.trim()) {
        return {
          success: false,
          status: 400,
          _inputInvalid: true,
          error: 'ssh_exec needs input.host; pass --host or put host in --input',
        };
      }
      if (!(BASTION_URL && BASTION_TOKEN)) {
        return { success: false, error: BASTION_UNAVAILABLE_MESSAGE };
      }
      // QUOXHAT MISSION D2 (2026-10-02): ssh_exec must mint the HITL approval grant
      // on resume, exactly like proxmox_vm_action / docker_fleet_container_action.
      // It was the ONE gated bastion tool still calling the grant-less callBastion
      // directly, so after a human approved (incl. via voice), the resumed ssh_exec
      // hit a mode:risky bastion with no X-Bastion-Approval-Grant and 403'd — the
      // approver heard "approved, underway" while nothing ran. The grant-aware wrapper
      // mints ONLY when ctx.hitlApprovedItemId is set (the approved-resume path) and
      // fails closed on a mint failure; read-only direct calls mint nothing (grant=null),
      // unchanged. Surfaced by a live owner phone-approval of a delegated restart.
      const { _internal: _bse } = require('./bastionSshExecutor.js');
      const _grantAwareCall = makeGrantAwareCallBastion(ctx, callBastion, _bse.mintGrantForCtx);
      const _runExec = async () => await _grantAwareCall(input.host, input.command);
      // Provably read-only command (injection-proof allowlist) runs direct; a read IS a
      // dispatch so we stamp it ourselves. Anything else is held for approval; on the gated
      // path withApprovalGate stamps dispatch. ssh_exec is in AGENT_ALWAYS_PROPOSE_TOOLS so the
      // gate holds unconditionally, no GOV-4 store policy required (approvalGate.js:344).
      const _isReadCmd = _getFleetReadClassifier();
      if (_isReadCmd(input.command)) {
        if (typeof ctx._markDispatched === 'function') ctx._markDispatched();
        return await _runExec();
      }
      // Fleet standing grant (owner decision 2026-10-13): an org admin pre-approved this
      // exact host + anchored command shape + VMID range until an expiry. Org comes from the
      // trusted ctx only, never input. A resume (_approvalId) never takes this path. The
      // bastion grant is minted against the standing grant (auth re-validates it by keyed
      // callback) and fails CLOSED. Every use is an `approved` tool_approvals row + an AEE
      // envelope, so it is visible in approvals history. No grant -> the HITL gate below.
      if (!input._approvalId && ctx.orgId) {
        let _sg = null;
        try {
          _sg = require('./fleetStandingGrants.js').coversCall({ orgId: ctx.orgId, tool: 'ssh_exec', host: input.host, command: input.command });
        } catch (e) { console.warn('[ApprovalGate] fleet standing grant lookup failed (falling back to HITL):', e && e.message); }
        // An org store policy (deny / require_approval) always wins over a standing grant:
        // if one matches, or the policy store errors, fall through to the normal gate.
        if (_sg) {
          let _policyClear = false;
          try {
            const _sp = await checkStorePolicies('ssh_exec', { command: input.command, host: input.host }, ctx);
            _policyClear = !(_sp && _sp.effect);
          } catch (e) { _policyClear = false; }
          if (_policyClear) return await _runUnderStandingGrant(_sg, input, ctx, _bse);
        }
      }
      const _gateInput = {
        command: input.command,
        host: input.host,
        // LUCID: the plain-words why rides on the card (appendRequestContext) and is part of the
        // fingerprinted input, so it must be carried through here or the approved resume mismatches.
        ...(typeof input.reason === 'string' && input.reason ? { reason: input.reason } : {}),
        ...(input._approvalId ? { _approvalId: input._approvalId } : {}),
        ...(input._resumeToken ? { _resumeToken: input._resumeToken } : {}),
      };
      return await withApprovalGate('ssh_exec', _gateInput, _runExec, ctx);
    }
  },

  fleet_status: {
    name: 'fleet_status',
    description: 'Get the status of all QuoxAgent agents in the fleet. Shows which hosts are connected, their IPs, versions, and Docker container counts.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    },
    execute: async () => {
      return await getFleetStatusLocal();
    }
  },

  docker_status: {
    name: 'docker_status',
    description: 'List Docker containers on a host. Shows container names, images, status, and ports.',
    input_schema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description: 'Target host (e.g. docker01, docker02). Defaults to docker01.',
          default: 'docker01'
        },
        all: {
          type: 'boolean',
          description: 'Include stopped containers. Default false (running only).',
          default: false
        }
      },
      required: []
    },
    execute: async (input) => {
      return await dockerStatus(callBastion, { host: input.host || 'docker01', show_all: input.all || false });
    }
  },

  docker_extended: {
    name: 'docker_extended',
    description: 'Get detailed Docker information: container logs, stats (CPU/memory), or network details.',
    input_schema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description: 'Target host (e.g. docker01)',
          default: 'docker01'
        },
        operation: {
          type: 'string',
          enum: ['logs', 'stats', 'inspect', 'network'],
          description: 'What to retrieve: logs (container logs), stats (CPU/memory), inspect (full config), network (docker networks)'
        },
        container: {
          type: 'string',
          description: 'Container name or ID (required for logs, stats, inspect)'
        },
        lines: {
          type: 'integer',
          description: 'Number of log lines to retrieve (default 50)',
          default: 50
        }
      },
      required: ['operation']
    },
    execute: async (input) => {
      return await dockerExtended(callBastion, {
        host: input.host || 'docker01',
        operation: input.operation,
        container: input.container,
        tail: input.lines || 50
      });
    }
  },

  // ===== Docker Fleet Tools (docker-fleet plugin) =====

  docker_fleet_scan: {
    name: 'docker_fleet_scan',
    description: 'Discover Docker hosts across the fleet. Scans known hosts via bastion SSH to find which have Docker installed, their version, and container counts.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    },
    execute: async () => {
      return await dockerFleetScan(callBastion);
    }
  },

  docker_fleet_containers: {
    name: 'docker_fleet_containers',
    description: 'List containers across all Docker hosts or a specific host. Shows name, image, status, host, ports, and uptime.',
    input_schema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Filter to a specific host (e.g. docker01). Omit for all hosts.' },
        all: { type: 'boolean', description: 'Include stopped containers. Default true.', default: true }
      },
      required: []
    },
    execute: async (input) => {
      return await dockerFleetContainers(callBastion, input);
    }
  },

  docker_fleet_container_action: {
    name: 'docker_fleet_container_action',
    // QUOXTRUST C2/WP2: reaches outside the box — durable intent gated at the choke.
    externalEffect: true,
    // Approval gate runs INSIDE execute — the dispatch stamp lands at the real
    // effect boundary via ctx._markDispatched (approvalGate), not pre-execute.
    gatedInExecute: true,
    description: 'Perform a lifecycle action on a container: start, stop, restart.',
    input_schema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Host where the container runs (e.g. docker01)' },
        container_id: { type: 'string', description: 'Container name or ID' },
        action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'Action to perform' },
        _approvalId: { type: 'string', description: 'Approval ID for re-invocation after approval' }
      },
      required: ['host', 'container_id', 'action']
    },
    execute: async (input, ctx) => {
      const toolInput = {
        host: input.host,
        container_id: input.container_id,
        action: input.action,
        ...(input._approvalId ? { _approvalId: input._approvalId } : {}),
        ...(input._resumeToken ? { _resumeToken: input._resumeToken } : {}),
      };
      // QUOXTRUST T4: on resume, mint+attach the approval grant (bastionSshExecutor
      // seam) so a mode:risky bastion accepts the exact approved command.
      const { _internal: bseD } = require('./bastionSshExecutor.js');
      const gcD = makeGrantAwareCallBastion(ctx, callBastion, bseD.mintGrantForCtx);
      return await withApprovalGate('docker_fleet_container_action', toolInput, () =>
        dockerFleetAction(gcD, toolInput), ctx);
    }
  },

  docker_fleet_logs: {
    name: 'docker_fleet_logs',
    description: 'Get logs from a container on a specific host.',
    input_schema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Host where the container runs' },
        container_id: { type: 'string', description: 'Container name or ID' },
        tail: { type: 'integer', description: 'Number of log lines (default 100, max 500)', default: 100 }
      },
      required: ['host', 'container_id']
    },
    execute: async (input) => {
      // QUOXTRUST FND_01M3SGFV: container_id is interpolated into a shell command sent to the
      // bastion; validate it (docker name/id charset, no shell metachars) and refuse rather
      // than inject. Required field, so empty is also rejected.
      if (!input.container_id || !isSafeShellArg('container', input.container_id)) {
        return { success: false, error: 'invalid_container_id', detail: 'container_id must be a valid docker container name/id (injection guard)' };
      }
      const tail = Math.min(parseInt(input.tail) || 100, 500);
      const result = await callBastion(input.host, `docker logs ${input.container_id} --tail ${tail} 2>&1`);
      return {
        success: result.success !== false,
        host: input.host,
        container: input.container_id,
        logs: (result.stdout || '').split('\n').filter(Boolean),
        lineCount: (result.stdout || '').split('\n').filter(Boolean).length
      };
    }
  },

  docker_fleet_stats: {
    name: 'docker_fleet_stats',
    description: 'Get CPU and memory stats for containers on a host.',
    input_schema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Host to query' },
        container_id: { type: 'string', description: 'Specific container (optional, omit for all)' }
      },
      required: ['host']
    },
    execute: async (input) => {
      // QUOXTRUST FND_01M3SGFV: container_id (optional here — empty means "all containers")
      // is interpolated into a shell command; validate before use, refuse on violation.
      if (!isSafeShellArg('container', input.container_id)) {
        return { success: false, error: 'invalid_container_id', detail: 'container_id must be a valid docker container name/id (injection guard)' };
      }
      const target = input.container_id || '';
      const cmd = `docker stats ${target} --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}"`;
      const result = await callBastion(input.host, cmd);
      if (result.success === false) {
        return { success: false, host: input.host, error: result.error };
      }
      const raw = result.stdout || '';
      return {
        success: true,
        host: input.host,
        stats: raw.split('\n').filter(Boolean).map(line => {
          const [name, cpu, memUsage, memPerc, netIO, blockIO] = line.split('|');
          return { name, cpu, memUsage, memPerc, netIO, blockIO };
        })
      };
    }
  },

  docker_fleet_stacks: {
    name: 'docker_fleet_stacks',
    description: 'List Docker Compose stacks across fleet hosts.',
    input_schema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Filter to a specific host (optional)' }
      },
      required: []
    },
    execute: async (input) => {
      return await dockerFleetStacks(callBastion, input);
    }
  },

  docker_fleet_system_df: {
    name: 'docker_fleet_system_df',
    description: 'Get Docker disk usage for a host (images, containers, volumes, build cache).',
    input_schema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Host to query (e.g. docker01)' }
      },
      required: ['host']
    },
    execute: async (input) => {
      const cmd = `docker system df --format "{{.Type}}|{{.TotalCount}}|{{.Active}}|{{.Size}}|{{.Reclaimable}}"`;
      const result = await callBastion(input.host, cmd);
      const raw = result.stdout || '';
      return {
        success: result.success !== false,
        host: input.host,
        usage: raw.split('\n').filter(Boolean).map(line => {
          const [type, totalCount, active, size, reclaimable] = line.split('|');
          return { type, totalCount, active, size, reclaimable };
        })
      };
    }
  },

  system_admin: {
    name: 'system_admin',
    description: 'System administration tasks: check uptime, list services, view processes, disk usage, memory, system logs, and cron jobs.',
    input_schema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description: 'Target host (e.g. docker01, hyp-01)',
          default: 'localhost'
        },
        operation: {
          type: 'string',
          enum: ['uptime', 'services', 'processes', 'disk', 'memory', 'logs', 'cron'],
          description: 'What to check'
        },
        filter: {
          type: 'string',
          description: 'For services: all|running|failed. For logs: unit name.'
        },
        sort_by: {
          type: 'string',
          enum: ['cpu', 'memory'],
          description: 'For processes: sort by cpu or memory'
        },
        limit: {
          type: 'integer',
          description: 'For processes/logs: max items to return',
          default: 20
        },
        since: {
          type: 'string',
          description: 'For logs: time range (e.g. 1h, 6h, 1d)',
          default: '1h'
        }
      },
      required: ['operation']
    },
    execute: async (input) => {
      return await systemAdmin(callBastion, {
        host: input.host || 'localhost',
        operation: input.operation,
        filter: input.filter,
        sort_by: input.sort_by,
        limit: input.limit || 20,
        since: input.since || '1h',
        unit: input.filter,
        user: input.user,
        path: input.path,
        priority: input.priority
      });
    }
  },

  network_check: {
    name: 'network_check',
    description: 'Network connectivity checks: ping, traceroute, DNS lookup, or port scan.',
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Target IP or hostname to check (e.g. kuma01, google.com, 10.0.0.1)'
        },
        type: {
          type: 'string',
          enum: ['ping', 'traceroute', 'dns', 'ports'],
          description: 'Check type',
          default: 'ping'
        },
        count: {
          type: 'integer',
          description: 'Ping count (default 4, max 10)',
          default: 4
        },
        ports: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Ports to check (for port scan type)',
          default: [22, 80, 443]
        },
        dnsType: {
          type: 'string',
          description: 'DNS record type (A, AAAA, MX, CNAME, TXT)',
          default: 'A'
        }
      },
      required: ['target']
    },
    execute: async (input) => {
      return await networkCheck(callBastion, {
        target: input.target,
        type: input.type || 'ping',
        count: input.count || 4,
        ports: input.ports || [22, 80, 443],
        dns_type: input.dnsType || 'A'
      });
    }
  },

  proxmox_vms: {
    name: 'proxmox_vms',
    description: 'List all virtual machines across the Proxmox cluster. Shows VM IDs, names, status, CPU, memory.',
    input_schema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Specific Proxmox node to query (hyp-01, hyp-02, hyp-03). Leave empty for all nodes.'
        }
      },
      required: []
    },
    execute: async (input) => {
      return await proxmoxVms(callBastion, { host: input.node || 'hyp-01' });
    }
  },

  // AGENT-OVERHAUL-3 (QuoxPlan notes #2332/#2333): golden-clone catalogue.
  // Read-only, no approval — reuses the exact same callBastion/pvesh egress
  // path as proxmox_vms above. Product model: Quox never creates templates,
  // it only lists VMs the operator has already flagged template:1 in
  // Proxmox, then provisions FROM one via proxmox_vm_clone.
  proxmox_templates_list: {
    name: 'proxmox_templates_list',
    description: 'List the golden-clone template catalogue: Proxmox VMs flagged template:1. Quox never creates templates — an operator marks a VM a template in Proxmox; this tool only reads that flag. Use before proxmox_vm_clone to find a valid template_vmid.',
    input_schema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Specific Proxmox node to query (hyp-01, hyp-02, hyp-03). Leave empty for all nodes.'
        }
      },
      required: []
    },
    execute: async (input) => {
      return await proxmoxTemplatesList(callBastion, { host: input.node || 'hyp-01' });
    }
  },

  proxmox_containers: {
    name: 'proxmox_containers',
    description: 'List LXC containers in the Proxmox cluster.',
    input_schema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Specific Proxmox node (hyp-01, hyp-02, hyp-03). Leave empty for all.'
        }
      },
      required: []
    },
    execute: async (input) => {
      return await proxmoxContainers(callBastion, { host: input.node || 'hyp-01' });
    }
  },

  proxmox_cluster_status: {
    name: 'proxmox_cluster_status',
    description: 'Get Proxmox cluster health, quorum status, and node overview.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    },
    execute: async () => {
      return await proxmoxCluster(callBastion, { host: 'hyp-01' });
    }
  },

  proxmox_storage: {
    name: 'proxmox_storage',
    description: 'Check Proxmox storage pool usage across the cluster.',
    input_schema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Specific node to check storage on'
        }
      },
      required: []
    },
    execute: async (input) => {
      return await proxmoxStorage(callBastion, { host: input.node || 'hyp-01' });
    }
  },

  proxmox_vm_action: {
    name: 'proxmox_vm_action',
    // QUOXTRUST C2/WP2: reaches outside the box — durable intent gated at the choke.
    externalEffect: true,
    // Approval gate runs INSIDE execute — the dispatch stamp lands at the real
    // effect boundary via ctx._markDispatched (approvalGate), not pre-execute.
    gatedInExecute: true,
    description: 'Execute an action on a Proxmox VM: start, stop, reboot, or migrate. Use with caution.',
    input_schema: {
      type: 'object',
      properties: {
        vmid: {
          type: 'integer',
          description: 'VM ID number'
        },
        action: {
          type: 'string',
          enum: ['start', 'stop', 'reboot', 'shutdown', 'status'],
          description: 'Action to perform'
        },
        node: {
          type: 'string',
          description: 'Proxmox node the VM is on (hyp-01, hyp-02, hyp-03)'
        }
      },
      required: ['vmid', 'action', 'node']
    },
    execute: async (input, ctx) => {
      const toolInput = {
        node: input.node,
        vmid: input.vmid,
        action: input.action,
        type: input.type || 'qemu',
        ...(input._approvalId ? { _approvalId: input._approvalId } : {}),
        ...(input._resumeToken ? { _resumeToken: input._resumeToken } : {}),
      };
      // QUOXTRUST T4: on resume, mint+attach the approval grant (bastionSshExecutor
      // seam) so a mode:risky bastion accepts the exact approved command.
      const { _internal: bseP } = require('./bastionSshExecutor.js');
      const gcP = makeGrantAwareCallBastion(ctx, callBastion, bseP.mintGrantForCtx);
      return await withApprovalGate('proxmox_vm_action', toolInput, () =>
        proxmoxVmAction(gcP, toolInput), ctx);
    }
  },

  // QDIS-NEXT Phase 3 — VULCAN's code-writing capability. This is the ONLY
  // tool in the collector that can commit code to a real repository, so it
  // is hand-registered here (like docker_fleet_container_action and
  // proxmox_vm_action above) rather than dispatched through the generic
  // connector bridge that the other github_* tools use. Since LI-OVERHAUL P4
  // the bridge DOES gate connector tools that declare requiresApproval:true
  // in their definition (linkedin publish_post/create_comment first) — but
  // the github connector tools carry only the "Requires confirmation before
  // execution" description text, which is a hint to the LLM, not a flag, so
  // they remain ungated there. This tool instead wraps its GitHub-mutating work
  // in the same withApprovalGate(...) used by the destructive infra tools,
  // so a human must approve via the real HITL flow before any GitHub API
  // write happens.
  //
  // Scope is deliberately narrow: create a branch off base, commit the given
  // file changes to it, open a pull request. There is no merge parameter and
  // no code path (here or in toolExecutors/githubPullRequest.js) that writes
  // straight to an existing branch without going through a new branch + PR.
  github_create_pull_request: {
    name: 'github_create_pull_request',
    // QUOXTRUST C2/WP2: reaches outside the box — durable intent gated at the choke.
    externalEffect: true,
    // Approval gate runs INSIDE execute — the dispatch stamp lands at the real
    // effect boundary via ctx._markDispatched (approvalGate), not pre-execute.
    gatedInExecute: true,
    description: 'Propose a code fix by opening a pull request. Creates a new branch off the base branch (repo default branch if not given), commits the given file changes to that new branch, and opens a PR for human review. Files are given as full new file content, not diffs — read the current file first (codebase_query / github_get_issue context) before writing the replacement. NEVER merges: opening the PR is the full scope. Requires human approval before any GitHub write happens — investigate fully (read the issue, search the codebase, read the actually-relevant files, check existing tests/conventions) before proposing.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository (owner/name)' },
        base: { type: 'string', description: 'Base branch to open the PR against (default: the repository\'s actual default branch, fetched at execution time — never assumed to be "main")' },
        branch: { type: 'string', description: 'New branch name to create for the fix (must not equal base)' },
        files: {
          type: 'array',
          description: 'File changes to commit onto the new branch. Full new file content, not a diff.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to repo root' },
              content: { type: 'string', description: 'Full new content of the file' },
            },
            required: ['path', 'content'],
          },
        },
        commit_message: { type: 'string', description: 'Commit message applied to each file change' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body — should reference the issue being fixed (e.g. "Fixes #123") and summarise the investigation and the change' },
        _approvalId: { type: 'string', description: 'Approval ID for re-invocation after approval' }
      },
      required: ['repo', 'branch', 'files', 'commit_message', 'title', 'body']
    },
    execute: async (input, ctx) => {
      const toolInput = {
        repo: input.repo,
        base: input.base || null,
        branch: input.branch,
        files: input.files,
        commit_message: input.commit_message,
        title: input.title,
        body: input.body,
        ...(input._approvalId ? { _approvalId: input._approvalId } : {}),
        ...(input._resumeToken ? { _resumeToken: input._resumeToken } : {}),
      };

      // Defense-in-depth: refuse a direct-write-without-PR shape before even
      // reaching the approval gate. githubProposeFix() enforces this same
      // invariant again once base is resolved (branch may still equal a
      // to-be-fetched default base at that point), so this is a fast, cheap
      // duplicate check, not the only one.
      if (toolInput.branch && toolInput.base && toolInput.branch === toolInput.base) {
        return {
          success: false,
          error: `branch ("${toolInput.branch}") must not equal base ("${toolInput.base}") — this tool only proposes changes via a new branch and a pull request.`,
        };
      }

      const result = await withApprovalGate('github_create_pull_request', toolInput, async () => {
        const orgId = ctx.orgId || 'default';
        const resolved = await resolveConnectorCredentials(orgId, 'github');
        if (resolved.error) {
          return { success: false, error: resolved.error };
        }
        return githubProposeFix(toolInput, resolved.credentials);
      }, ctx);

      // OWNER VISIBILITY (QDIS-NEXT p3 addendum): when the gated action
      // actually ran (approved re-invocation that reached the real PR-open
      // path, not a pending/denied response), post one line to the
      // forge-feed session-mail inbox so it's visible outside the raw
      // #triage conversation. Best-effort, fire-and-forget — must never
      // affect the tool's own response.
      if (result && result.success && result.pr) {
        _postForgeFeedMail(toolInput, result);
      }

      return result;
    }
  },

  security_audit: {
    name: 'security_audit',
    description: 'Query the audit event log for security events. Filter by time range, action type, or status.',
    input_schema: {
      type: 'object',
      properties: {
        hours: {
          type: 'integer',
          description: 'How many hours back to search (default 6)',
          default: 6
        },
        action: {
          type: 'string',
          description: 'Filter by action type (e.g. login, config_change, api_key_set)'
        },
        status: {
          type: 'string',
          enum: ['success', 'failure', 'all'],
          description: 'Filter by outcome',
          default: 'all'
        }
      },
      required: []
    },
    execute: async (input) => {
      return await securityAudit(callBastion, {
        hours: input.hours || 6,
        event_types: input.action ? [input.action] : null,
        limit: input.limit || 100
      });
    }
  },

  ssl_certificates: {
    name: 'ssl_certificates',
    description: 'Check SSL certificate expiry dates for configured domains and services.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Specific domain to check (e.g. quox.ai). Leave empty for all configured domains.'
        }
      },
      required: []
    },
    execute: async (input) => {
      return await sslCertificates(callBastion, { domain: input.domain });
    }
  },

  metrics_query: {
    name: 'metrics_query',
    description: `Execute a PromQL query against Prometheus. Translates natural language metric requests into PromQL.

METRIC CATALOG (available metrics from node_exporter, cAdvisor, and custom exporters):

CPU:
  node_cpu_seconds_total{mode="idle|user|system|iowait",instance="...",job="..."}
  → CPU usage %: 100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)
  → Per-host CPU: 100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)

Memory:
  node_memory_MemTotal_bytes, node_memory_MemAvailable_bytes, node_memory_MemFree_bytes
  → Memory usage %: (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100
  → Free memory GB: node_memory_MemAvailable_bytes / 1024^3

Disk:
  node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay"}
  node_filesystem_avail_bytes{mountpoint="/",fstype!~"tmpfs|overlay"}
  → Disk usage %: (1 - (node_filesystem_avail_bytes / node_filesystem_size_bytes)) * 100

Network:
  node_network_receive_bytes_total{device!~"lo|veth.*|docker.*|br-.*"}
  node_network_transmit_bytes_total{device!~"lo|veth.*|docker.*|br-.*"}
  → Traffic rate: rate(node_network_receive_bytes_total[5m])

System:
  node_load1, node_load5, node_load15 (load averages)
  node_boot_time_seconds (uptime = time() - node_boot_time_seconds)
  up{job="...",instance="..."} (1=alive, 0=down)

Containers (cAdvisor):
  container_memory_usage_bytes{name!=""}
  container_cpu_usage_seconds_total{name!=""}
  → Container CPU %: rate(container_cpu_usage_seconds_total{name!=""}[5m]) * 100

HTTP (if instrumented):
  http_requests_total{method="...",status="...",handler="..."}
  http_request_duration_seconds_bucket

LABELS:
  instance: host:port (e.g. "10.0.0.101:9100", "docker01:9100")
  job: scrape job name (e.g. "node", "quoxagent", "cadvisor", "prometheus")
  Filter by host: {instance=~"docker01.*"} or {instance=~"10.0.0.101.*"}

PROMQL PATTERNS:
  Instant value: metric_name{labels}
  Rate over time: rate(counter_metric[5m])
  Average across hosts: avg(metric) or avg by(instance)(metric)
  Top N: topk(5, metric)
  Bottom N: bottomk(5, metric)
  Percentage: (part / total) * 100
  Delta: delta(gauge_metric[1h])
  Aggregation: sum, avg, min, max, count, stddev — by(label) or without(label)

COMMON TRANSLATIONS:
  "CPU usage" → 100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)
  "CPU on docker01" → 100 - (avg(rate(node_cpu_seconds_total{mode="idle",instance=~"docker01.*"}[5m])) * 100)
  "memory usage" → (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100
  "disk space" → (1 - (node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes)) * 100
  "which hosts are down" → up == 0
  "all targets" → up
  "load average" → node_load5
  "uptime" → (time() - node_boot_time_seconds) / 3600
  "network traffic" → rate(node_network_receive_bytes_total{device!~"lo|veth.*"}[5m])
  "top 5 CPU" → topk(5, 100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100))
  "container memory" → container_memory_usage_bytes{name!=""} / 1024^2 (in MB)`,
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'PromQL query expression. Generate this from the metric catalog above.'
        },
        range: {
          type: 'string',
          description: 'Time range for range queries (e.g. 1h, 6h, 1d). Omit for instant (current value) queries.'
        },
        step: {
          type: 'string',
          description: 'Step interval for range queries (e.g. 15s, 1m, 5m). Only used with range.',
          default: '1m'
        }
      },
      required: ['query']
    },
    execute: async (input) => {
      return await metricsQuery({
        type: 'summary',
        host: input.host,
        range: input.range || '5m',
        custom_query: input.query,
        range_query: !!input.range,
        step: input.step,
      });
    }
  },

  grafana_dashboards: {
    name: 'grafana_dashboards',
    // Evidence classification (consumed by toolEvidence.emitToolEvidence — the
    // per-tool AEE + AOCL envelope). Without these the call fell back to the
    // generic 'ops.tool.executed' intent; grafana is observability read-mostly
    // (a low-risk annotate write is the only mutation), so LOW / layer 6.
    _aeeIntent: 'quox.grafana.query',
    _aoclClassification: { layer: 6, risk: 'LOW', autonomy: 'FULL' },
    description: `Query Grafana for dashboards, alert rules, panels, data sources, and create annotations.

Use this when the user asks about dashboards, Grafana, visualizations, or wants to find a specific dashboard.
Actions:
- search: Find dashboards by name, tag, or folder
- alerts: List Grafana alert rules and their states (firing/pending/normal)
- panels: List panels in a specific dashboard (requires dashboardUID)
- annotate: Create an annotation on a dashboard (requires text, optional dashboardUID/panelId)
- datasources: List configured data sources
- health: Check Grafana availability`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'alerts', 'panels', 'annotate', 'datasources', 'health'],
          description: 'What to query from Grafana',
          default: 'search'
        },
        query: {
          type: 'string',
          description: 'Search query for dashboard name (only for search action)'
        },
        tag: {
          type: 'string',
          description: 'Filter dashboards by tag (only for search action)'
        },
        dashboardUID: {
          type: 'string',
          description: 'Dashboard UID (required for panels action, optional for annotate)'
        },
        panelId: {
          type: 'integer',
          description: 'Panel ID within a dashboard (optional for annotate)'
        },
        text: {
          type: 'string',
          description: 'Annotation text (required for annotate action)'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for the annotation (defaults to ["quoxcore"])'
        },
      },
      required: ['action']
    },
    // VAULT-INTEG P3: resolve the org's `grafana` vault credential per call
    // (mirrors getWazuhToken's use of wazuhCredentials.js) instead of the
    // module-level GRAFANA_API_KEY toolExecutors/grafana.js used to read
    // once at process start. metrics/insight/janus/quox all offer this tool
    // to different agents, so the vault lookup uses ctx.agentId when present
    // (agent-assignment level) and falls back to a fixed 'insight' identity
    // (the Grafana-persona agent) so the org-default level still resolves
    // when the caller has no agent identity of its own.
    execute: async (input, ctx = {}) => {
      let apiKey, baseUrl;
      try {
        const resolved = ctx.orgId
          ? await resolveCredentialForAgent(ctx.orgId, ctx.agentId || 'insight', 'grafana')
          : null;
        apiKey = resolveGrafanaApiKey(resolved);
        // Per-org base URL from the same vault credential — stops this org's
        // token being sent as a Bearer to the global default Grafana instance.
        baseUrl = resolveGrafanaBaseUrl(resolved);
      } catch (err) {
        if (err.leaseBlocked) {
          return { success: false, error: err.leaseReason || 'lease_required' };
        }
        throw err;
      }
      return await grafanaDashboards(input, apiKey, baseUrl);
    }
  },

  alerts_manage: {
    name: 'alerts_manage',
    description: 'Manage Prometheus Alertmanager: list firing/pending alerts, create silences, or check history. Use this when user asks about alerts, problems, or wants to silence noisy alerts.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'silence', 'history'],
          description: 'What to do with alerts',
          default: 'list'
        },
        alert_name: {
          type: 'string',
          description: 'Specific alert name to manage'
        }
      },
      required: []
    },
    execute: async (input, ctx = {}) => {
      const opMap = { list: 'active', silence: 'silence', history: 'history' };
      const operation = opMap[input.action] || 'active';
      const _run = async () => alertsManage({
        operation,
        matchers: input.alert_name ? { alertname: input.alert_name } : undefined,
        hours: input.hours
      });
      // QUOXTRUST MF-2: 'list'/'history' are reads and run direct; only
      // 'silence' (the un-mediated standout — suppresses alerting) is gated.
      // alerts_manage is in AGENT_ALWAYS_PROPOSE_TOOLS so the gate holds
      // unconditionally, no GOV-4 store policy required (approvalGate.js).
      if (operation !== 'silence') return await _run();
      const _gateInput = {
        alert_name: input.alert_name,
        ...(input._approvalId ? { _approvalId: input._approvalId } : {}),
        ...(input._resumeToken ? { _resumeToken: input._resumeToken } : {}),
      };
      return await withApprovalGate('alerts_manage', _gateInput, _run, ctx);
    }
  },

  // ==========================================================================
  // GOV: Governance Policy Tools — used by AUDITUS
  // voltDb ref set via setGovDatabase() from server.js init
  // ==========================================================================

  governance_list_policies: {
    name: 'governance_list_policies',
    description: 'List governance policies from the unified policy store. Returns active policies with category, effect, conditions, and framework mappings. Use to answer "what policies are enforced?"',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['safety', 'execution', 'governance', 'compliance'], description: 'Filter by category (optional)' },
        enabled: { type: 'boolean', description: 'Filter by enabled status (optional, default: true)' },
        effect: { type: 'string', enum: ['allow', 'deny', 'require_approval', 'redact', 'log_only'], description: 'Filter by effect (optional)' },
      },
      required: []
    },
    execute: async (input, ctx) => {
      try {
        const { listPolicies } = require('./policyStore.js');
        if (!_govVoltDb) return { success: false, error: 'Policy store not available' };
        const orgId = ctx?.orgId || '__default__';
        const result = listPolicies(_govVoltDb, {
          org_id: orgId,
          category: input.category || undefined,
          enabled: input.enabled !== undefined ? input.enabled : true,
          effect: input.effect || undefined,
          limit: 100,
        });
        return {
          success: true,
          total: result.total,
          policies: result.data.map(p => ({
            id: p.id, name: p.name, category: p.category, effect: p.effect,
            enabled: p.enabled, priority: p.priority, reason: p.reason,
            framework_mapping: p.framework_mapping, is_system: p.is_system,
            version: p.version,
          })),
        };
      } catch (err) {
        return { success: false, error: `Failed to list policies: ${err.message}` };
      }
    }
  },

  governance_get_templates: {
    name: 'governance_get_templates',
    description: 'List available governance policy template packs (SOC2, HIPAA, High-Security, Dev Sandbox). Use to recommend policy packs to the user.',
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      try {
        const { getTemplatePacks } = require('./policyTemplates.js');
        const packs = getTemplatePacks();
        return {
          success: true,
          packs: packs.map(p => ({ id: p.id, name: p.name, description: p.description, policyCount: p.policies.length })),
        };
      } catch (err) {
        return { success: false, error: `Failed to list templates: ${err.message}` };
      }
    }
  },

  // ==========================================================================
  // Inbox / Workflow / Notification Tools — cross-agent
  // ==========================================================================

  create_inbox_item: {
    name: 'create_inbox_item',
    description: 'Create a new item in the HITL inbox — approvals, reviews, notifications, or escalations. Items appear in the user\'s Inbox page.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the inbox item' },
        description: { type: 'string', description: 'Detailed description or body text (markdown supported)' },
        kind: { type: 'string', enum: ['approval', 'question', 'task', 'incident', 'info', 'override_required'], description: 'The type of inbox item' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Priority level (default: normal)' },
        scope: { type: 'string', enum: ['org', 'division', 'team'], description: 'Scope of the item' },
        scope_id: { type: 'string', description: 'ID of the org/division/team' },
        assignee: { type: 'string', description: 'User ID or email to assign to' }
      },
      required: ['title', 'kind']
    },
    execute: async (input, ctx) => {
      try {
        const authToken = ctx?.token;
        const baseUrl = process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101';
        const orgId = ctx?.orgId;
        if (!orgId) return { success: false, error: 'No organization context — cannot create inbox item' };
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        // Sanity-guard the assignee. Agents pass arbitrary strings here
        // ("operator", an email, a role name) which then FK-fail against
        // users(id) on the auth side. Only forward values that look like a
        // ULID; otherwise drop and let the route fall back to org owners.
        const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
        const safeAssignee = (typeof input.assignee === 'string' && ULID_RE.test(input.assignee))
          ? input.assignee
          : null;
        // Use internal endpoint (no user JWT required — service-to-service,
        // authenticated by the internal service key: the inbox internalRouter
        // is gated router-wide since P0b step 6a)
        const inboxServiceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const res = await fetch(`${baseUrl}/api/internal/orgs/${orgId}/inbox`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(inboxServiceKey ? { 'X-Service-Key': inboxServiceKey } : {}),
          },
          body: JSON.stringify({
            title: input.title,
            body_md: input.description || '',
            kind: input.kind || 'info',
            priority: input.priority || 'normal',
            assignee_user_id: safeAssignee,
            aee_correlation_id: ctx?.session_id || null,
            payload: { source: 'agent', source_agent: ctx?.agentId || 'quox', scope: input.scope || null, scope_id: input.scope_id || null }
          })
        });
        const responseText = await res.text();
        console.log(`[Tools] create_inbox_item API response: ${res.status} ${responseText.substring(0, 300)}`);
        if (!res.ok) return { success: false, error: `Inbox API returned ${res.status}: ${responseText}` };
        let data;
        try { data = JSON.parse(responseText); } catch { data = {}; }
        return { success: true, item_id: data.id || data.item_id, message: `Created inbox item: ${input.title}` };
      } catch (err) {
        return { success: false, error: `Failed to create inbox item: ${err.message}` };
      }
    }
  },

  // QUOXON: core read-only clock (server clock + Intl, no network, no org data). Models
  // guess DST badly ("what time is it in Panama?" on Ollama, 2026-10-12); this answers it.
  time_now: {
    ...require('./timeNow.js').TIME_NOW_TOOL,
    execute: async (input) => require('./timeNow.js').timeNow(input || {}),
  },

  // TRIAGE-Q core-job reader (tooling audit 2026-09-21): triage-q had the WRITE
  // side (approve_request/deny_request/create_inbox_item) but no way to READ the
  // HITL queue it exists to triage. This wires the read side to the auth inbox
  // internal list endpoint (GET /api/internal/orgs/:orgId/inbox/items, service-
  // key gated, returns {items}).
  inbox_pending: {
    name: 'inbox_pending',
    description: 'Read the HITL inbox queue — items awaiting a human decision (approvals, questions, incidents), newest first. This is the READ side of triage: see what needs attention, its kind, priority, and age, then act with approve_request / deny_request. Filter by kind (e.g. "approval" for the approval queue) and status (default "open").',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['approval', 'question', 'task', 'incident', 'info', 'override_required'], description: 'Filter by item kind, e.g. "approval" for the approval queue. Omit for all kinds.' },
        status: { type: 'string', description: 'Filter by status: open (default), in_progress, waiting, resolved. Use "all" for every status.' },
        limit: { type: 'number', description: 'Max items to return (default 20, max 100)' },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      const orgId = ctx?.orgId;
      if (!orgId) return { success: false, error: 'No organization context — cannot read the inbox queue' };
      const baseUrl = process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
      const rawStatus = typeof input?.status === 'string' ? input.status.trim() : '';
      const status = rawStatus === 'all' ? '' : (rawStatus || 'open');
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (input?.kind) params.set('kind', input.kind);
      params.set('limit', String(Math.min(Math.max(1, parseInt(input?.limit) || 20), 100)));
      try {
        const res = await fetch(`${baseUrl}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox/items?${params.toString()}`, {
          headers: { ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}) },
          signal: AbortSignal.timeout(8000),
        });
        const text = await res.text();
        if (!res.ok) return { success: false, error: `Inbox API returned ${res.status}: ${text.slice(0, 200)}` };
        let data;
        try { data = JSON.parse(text); } catch { data = {}; }
        const items = Array.isArray(data.items) ? data.items : [];
        const compact = items.map((it) => ({
          id: it.id,
          title: it.title,
          kind: it.kind,
          priority: it.priority,
          status: it.status,
          created_at: it.created_at,
          assignee_user_id: it.assignee_user_id || null,
        }));
        return { success: true, count: compact.length, filter: { status: status || 'all', kind: input?.kind || 'all' }, items: compact };
      } catch (err) {
        return { success: false, error: `Failed to read inbox queue: ${err.message}` };
      }
    }
  },

  // ==========================================================================
  // Objective Orchestration — chat-driven objective creation (Stream UX-6)
  // ==========================================================================

  orchestrate_objective: {
    name: 'orchestrate_objective',
    description: 'Create and optionally start an agentic objective. An objective is a high-level goal that gets decomposed into tasks and executed by specialist agents. If team_id is omitted, the best team is selected automatically based on the objective description.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Concise objective title (max 200 chars)' },
        description: { type: 'string', description: 'Detailed description of what should be accomplished (max 5000 chars)' },
        team_id: { type: 'string', description: 'Team ID to assign this objective to. If omitted, the best team is selected automatically.' },
        constraints: {
          type: 'object',
          description: 'Execution constraints',
          properties: {
            max_tokens: { type: 'number', description: 'Token budget (default: 100000)' },
            max_tool_calls: { type: 'number', description: 'Max tool invocations (default: 50)' },
            max_duration_seconds: { type: 'number', description: 'Timeout in seconds (default: 600)' },
            checkpoint_after_each_task: { type: 'boolean', description: 'Require approval after each task (default: false)' }
          }
        },
        auto_start: { type: 'boolean', description: 'If true (default), immediately start decomposition, auto-approve the plan, and begin execution. Set false to create in pending state for manual review.' },
        auto_approve: { type: 'boolean', description: 'If true (default when auto_start is true), automatically approve the decomposed plan so execution begins immediately. Set false to pause at the plan review stage.' }
      },
      required: ['title', 'description']
    },
    execute: async (input, ctx) => {
      try {
        const tasksUrl = `http://${process.env.TASKS_HOST || 'tasks'}:${process.env.TASKS_PORT || '3104'}`;
        const orgId = ctx?.orgId;
        const userId = ctx?.userId;
        if (!orgId) return { success: false, error: 'No organization context — cannot create objective' };

        let teamId = input.team_id;

        // Smart team selection: if no team_id, pick the best match
        if (!teamId) {
          try {
            const teamsRes = await fetch(`${tasksUrl}/api/teams`, {
              headers: {
                'Content-Type': 'application/json',
                'X-Org-Id': orgId,
                'X-User-Id': userId || '',
                'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '',
              },
              signal: AbortSignal.timeout(10000),
            });
            if (teamsRes.ok) {
              const teamsBody = await teamsRes.json();
              // /api/teams returns either a bare array (legacy) or { teams: [...] }
              const teams = Array.isArray(teamsBody) ? teamsBody : (teamsBody?.teams || []);
              if (teams.length > 0) {
                // AT-6: Score teams by keyword overlap + performance data
                const query = `${input.title} ${input.description}`.toLowerCase();
                let bestTeam = null;
                let bestScore = 0;

                // Fetch performance data if available
                let perfData = {};
                try {
                  for (const team of teams) {
                    const perfRes = await fetch(`${tasksUrl}/api/teams/${team.id}/performance`, {
                      headers: { 'X-Org-Id': orgId, 'X-User-Id': userId || '', 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '' },
                      signal: AbortSignal.timeout(5000),
                    });
                    if (perfRes.ok) {
                      const data = await perfRes.json();
                      const agents = data.agents || [];
                      const avgScore = agents.length > 0 ? agents.reduce((s, a) => s + a.score, 0) / agents.length : 0;
                      const avgSuccess = agents.length > 0 ? agents.reduce((s, a) => s + a.successRate, 0) / agents.length : 0;
                      perfData[team.id] = { avgScore, avgSuccess, taskCount: agents.reduce((s, a) => s + a.taskCount, 0) };
                    }
                  }
                } catch { /* performance data optional */ }

                for (const team of teams) {
                  // Keyword relevance score (0-20)
                  const teamText = `${team.name || ''} ${team.description || ''} ${(team.manifest?.description || '')}`.toLowerCase();
                  const allDomains = (team.manifest?.members || []).flatMap(m => m.domains || []);
                  const words = [...teamText.split(/\s+/).filter(w => w.length > 3), ...allDomains];
                  let keywordScore = 0;
                  for (const word of words) {
                    if (query.includes(word.toLowerCase())) keywordScore++;
                  }
                  keywordScore = Math.min(keywordScore, 20);

                  // Performance score (0-30) — from learning router data
                  const perf = perfData[team.id];
                  let perfScore = 0;
                  if (perf && perf.taskCount > 5) {
                    perfScore = Math.round(perf.avgSuccess * 20 + (perf.avgScore / 100) * 10);
                  }

                  // Size match (0-5) — complexity heuristic
                  const memberCount = (team.manifest?.members || []).length;
                  const queryLen = query.split(/\s+/).length;
                  let sizeScore = 0;
                  if (queryLen < 15 && memberCount <= 8) sizeScore = 5;
                  else if (queryLen >= 15 && queryLen < 30 && memberCount > 5 && memberCount <= 12) sizeScore = 5;
                  else if (queryLen >= 30 && memberCount > 10) sizeScore = 5;

                  const totalScore = keywordScore + perfScore + sizeScore;
                  if (totalScore > bestScore) {
                    bestScore = totalScore;
                    bestTeam = team;
                  }
                }
                if (bestTeam) {
                  teamId = bestTeam.id;
                  const perf = perfData[bestTeam.id];
                  console.log(`[orchestrate_objective] Auto-selected team "${bestTeam.name}" (score: ${bestScore}${perf ? `, perf: ${perf.avgSuccess.toFixed(2)}` : ''}) for objective "${input.title}"`);
                }
              }
            }
          } catch (err) {
            console.warn(`[orchestrate_objective] Team auto-selection failed, proceeding without team: ${err.message}`);
          }
        }

        // Build objective payload
        const constraints = input.constraints || {};
        const payload = {
          title: input.title.slice(0, 200),
          description: (input.description || '').slice(0, 5000),
          max_tokens: constraints.max_tokens || 100000,
          max_tool_calls: constraints.max_tool_calls || 50,
          max_duration_ms: (constraints.max_duration_seconds || 600) * 1000,
          checkpoint_after_each_task: constraints.checkpoint_after_each_task || false,
        };
        if (teamId) payload.team_id = teamId;

        // Create the objective
        const createRes = await fetch(`${tasksUrl}/api/objectives`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Org-Id': orgId,
            'X-User-Id': userId || '',
            'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        });
        const createText = await createRes.text();
        if (!createRes.ok) {
          return { success: false, error: `Failed to create objective: ${createRes.status} ${createText}` };
        }

        let objective;
        try { objective = JSON.parse(createText); } catch { objective = {}; }
        const objectiveId = objective.id || objective.objective_id;

        // Default auto_start to true for chat-initiated objectives
        const autoStart = input.auto_start !== false;
        const autoApprove = input.auto_approve !== false && autoStart;
        const serviceHeaders = {
          'Content-Type': 'application/json',
          'X-Org-Id': orgId,
          'X-User-Id': userId || '',
          'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '',
        };

        // Auto-start: kick off decomposition
        if (autoStart && objectiveId) {
          try {
            const startRes = await fetch(`${tasksUrl}/api/objectives/${objectiveId}/start`, {
              method: 'POST',
              headers: serviceHeaders,
              body: JSON.stringify({ skip_checkpoint: true }),
              signal: AbortSignal.timeout(15000),
            });
            if (!startRes.ok) {
              const startErr = await startRes.text();
              return {
                success: true,
                objective_id: objectiveId,
                title: input.title,
                status: 'pending',
                task_count: 0,
                team_id: teamId || null,
                message: `Objective "${input.title}" created but auto-start failed (${startRes.status}): ${startErr}. Start it manually from Mission Control.`,
                links: {
                  mission_control: '/mission-control?tab=objectives',
                },
                advisory: null,
              };
            }

            // Auto-approve: fire-and-forget in background (don't block the chat response).
            // OBJ-2: deadline raised 60s → 600s. Real-world decomposer LLM calls
            // for non-trivial objectives (Dirty Frag sweep took >3min on 2026-05-10)
            // routinely exceed 60s. On 2026-05-10 a stranded objective stayed in
            // 'decomposed' forever because the loop exited 22 polls before the
            // decomposer finished. The OBJ-1 banner now surfaces stranded plans,
            // but the deadline bump is the actual fix — 10 min covers virtually
            // every legitimate decomposer runtime. On timeout we log a warning
            // (previously silent), so an operator can spot stragglers in logs.
            if (autoApprove) {
              (async () => {
                const AUTO_APPROVE_DEADLINE_MS = 600000; // 10 min
                const pollStart = Date.now();
                let approved = false;
                let lastStatus = null;
                try {
                  while (Date.now() - pollStart < AUTO_APPROVE_DEADLINE_MS) {
                    await new Promise(r => setTimeout(r, 2000));
                    const statusRes = await fetch(`${tasksUrl}/api/objectives/${objectiveId}`, {
                      headers: serviceHeaders, signal: AbortSignal.timeout(5000),
                    });
                    if (!statusRes.ok) continue;
                    const d = await statusRes.json();
                    lastStatus = d.status;
                    if (d.status === 'decomposed') {
                      await fetch(`${tasksUrl}/api/objectives/${objectiveId}/approve-plan`, {
                        method: 'POST', headers: serviceHeaders, signal: AbortSignal.timeout(10000),
                      });
                      approved = true;
                      console.log(`[orchestrate_objective] Auto-approved: "${input.title}" (${(d.tasks || []).length} tasks)`);
                      break;
                    }
                    if (['running', 'completed', 'failed'].includes(d.status)) break;
                  }
                  if (!approved && !['running', 'completed', 'failed'].includes(lastStatus)) {
                    const elapsedMin = Math.round((Date.now() - pollStart) / 60000);
                    console.warn(`[orchestrate_objective] Auto-approve TIMED OUT after ${elapsedMin}min for objective ${objectiveId} ("${input.title}") — last status: ${lastStatus || 'unknown'}. Surface in Mission Control "Plans Awaiting Approval" banner for manual approval.`);
                  }
                } catch (e) { console.warn(`[orchestrate_objective] Background auto-approve error for ${objectiveId}: ${e.message}`); }
              })(); // fire and forget — don't await
            }

            // Return immediately — objective is decomposing in background
            return {
              success: true,
              objective_id: objectiveId,
              title: input.title,
              status: 'decomposing',
              task_count: 0,
              team_id: teamId || null,
              message: `Objective "${input.title}" created and decomposition started. It will auto-approve and run when the plan is ready. IMPORTANT: When the objective completes, use get_objective_results to fetch and present the full report to the user.`,
              links: {
                mission_control: '/mission-control?tab=objectives',
                opsdeck: `/opsdeck?objective=${objectiveId}`,
              },
              advisory: null,
            };

            // Auto-start without auto-approve
            return {
              success: true,
              objective_id: objectiveId,
              title: input.title,
              status: 'decomposing',
              task_count: 0,
              team_id: teamId || null,
              message: `Objective "${input.title}" created and decomposition started. Review and approve the plan in Mission Control when ready.`,
              links: {
                mission_control: '/mission-control?tab=objectives',
              },
              advisory: null,
            };
          } catch (err) {
            return {
              success: true,
              objective_id: objectiveId,
              title: input.title,
              status: 'pending',
              task_count: 0,
              team_id: teamId || null,
              message: `Objective "${input.title}" created but auto-start timed out: ${err.message}. Start it manually from Mission Control.`,
              links: {
                mission_control: '/mission-control?tab=objectives',
              },
              advisory: null,
            };
          }
        }

        // No auto-start — pending state
        return {
          success: true,
          objective_id: objectiveId,
          title: input.title,
          status: 'pending',
          task_count: 0,
          team_id: teamId || null,
          message: `Objective "${input.title}" created in pending state.${teamId ? ` Assigned to team ${teamId}.` : ''} Review and start it from Mission Control.`,
          links: {
            mission_control: '/mission-control?tab=objectives',
          },
          advisory: null,
        };
      } catch (err) {
        return { success: false, error: `Failed to orchestrate objective: ${err.message}` };
      }
    }
  },

  get_objective_results: {
    name: 'get_objective_results',
    description: 'Fetch the results of a completed objective. Returns task results, agent outputs, tools used, and execution summary. Use this after an objective completes to retrieve and present the actual findings.',
    input_schema: {
      type: 'object',
      properties: {
        objective_id: { type: 'string', description: 'The objective ID to fetch results for' },
      },
      required: ['objective_id']
    },
    execute: async (input, ctx) => {
      try {
        const tasksUrl = `http://${process.env.TASKS_HOST || 'tasks'}:${process.env.TASKS_PORT || '3104'}`;
        const orgId = ctx?.orgId;
        if (!orgId) return { success: false, error: 'No organization context' };

        const headers = {
          'X-Org-Id': orgId,
          'X-User-Id': ctx?.userId || '',
          'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '',
        };

        const res = await fetch(`${tasksUrl}/api/objectives/${input.objective_id}`, {
          headers,
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return { success: false, error: `Failed to fetch objective: ${res.status}` };

        const obj = await res.json();
        const tasks = obj.tasks || [];
        const completed = tasks.filter(t => t.status === 'completed');
        const failed = tasks.filter(t => t.status === 'failed');

        // Build a readable report from task results
        const taskResults = tasks.map(t => ({
          title: t.title,
          agent: t.agent_id,
          status: t.status,
          result: t.result || null,
          duration_ms: t.duration_ms || 0,
          tokens_used: t.tokens_used || 0,
        }));

        // Combine all results into one summary
        const combinedResults = completed
          .filter(t => t.result)
          .map(t => `### ${t.title} (${t.agent_id})\n${t.result}`)
          .join('\n\n---\n\n');

        return {
          success: true,
          objective_id: input.objective_id,
          title: obj.title,
          status: obj.status,
          task_count: obj.task_count,
          tasks_completed: obj.tasks_completed,
          tasks_failed: obj.tasks_failed,
          execution_id: obj.quoxflow_execution_id,
          combined_report: combinedResults || 'No results available',
          tasks: taskResults,
        };
      } catch (err) {
        return { success: false, error: `Failed to fetch results: ${err.message}` };
      }
    }
  },

  create_workflow: {
    name: 'create_workflow',
    description: 'Create a new workflow via QuoxFlow. For simple workflows, specify name + trigger (+ schedule for cron). For advanced workflows, provide full nodes and edges arrays. Node types: trigger:webhook, trigger:schedule, trigger:event, flow:condition, flow:switch, flow:loop, flow:parallel, flow:merge, call (HTTP), data:transform, data:set, data:aggregate, error:try, error:catch, error:throw, util:wait, util:log, util:subworkflow.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name' },
        description: { type: 'string', description: 'What this workflow does' },
        trigger: { type: 'string', enum: ['schedule', 'webhook', 'manual', 'event'], description: 'How the workflow is triggered. Auto-generates a trigger node if nodes array is not provided.' },
        schedule: { type: 'string', description: 'Cron expression for schedule triggers (e.g. "0 8 * * *")' },
        event_pattern: { type: 'string', description: 'Event intent pattern for event triggers (e.g. "ops.approval.*")' },
        nodes: { type: 'array', items: { type: 'object' }, description: 'Full node definitions. Each node: { id, type, name?, config }. If provided with edges, these are sent directly (trigger param ignored).' },
        edges: { type: 'array', items: { type: 'object' }, description: 'Edge definitions connecting nodes. Each edge: { source, target, condition? }. Required when providing custom nodes.' },
        deploy: { type: 'boolean', description: 'Whether to deploy/activate immediately (default: false)' },
        settings: { type: 'object', description: 'Optional workflow settings: { timezone, errorBehavior, timeout, saveEvidence }' }
      },
      required: ['name', 'trigger']
    },
    execute: async (input, ctx) => {
      try {
        const quoxflowUrl = QUOXFLOW_URL;
        const authToken = ctx?.token;
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';

        // Generate a unique workflow ID
        const workflowId = input.id || `wf-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

        // Determine nodes and edges
        let nodes = input.nodes || [];
        let edges = input.edges || [];

        // If user provided full nodes+edges, use them directly
        // Otherwise auto-generate trigger node from trigger/schedule params
        if (nodes.length === 0 && input.trigger && input.trigger !== 'manual') {
          const triggerId = `trigger-${input.trigger}`;
          if (input.trigger === 'schedule') {
            nodes = [{ id: triggerId, type: 'trigger:schedule', name: 'Schedule Trigger', config: { expression: input.schedule || '0 * * * *', timezone: 'UTC' } }];
          } else if (input.trigger === 'webhook') {
            const safeName = (input.name || 'workflow').toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 40);
            nodes = [{ id: triggerId, type: 'trigger:webhook', name: 'Webhook Trigger', config: { path: `/${safeName}`, method: 'POST' } }];
          } else if (input.trigger === 'event') {
            nodes = [{ id: triggerId, type: 'trigger:event', name: 'Event Trigger', config: { pattern: input.event_pattern || '*' } }];
          }
        }

        const payload = {
          id: workflowId,
          name: input.name,
          description: input.description || '',
          nodes,
          edges,
          ...(input.settings ? { settings: input.settings } : {}),
          metadata: {
            created_by: ctx?.userId || 'agent',
            org_id: ctx?.orgId || null,
            trigger_type: input.trigger
          }
        };

        const res = await fetch(`${quoxflowUrl}/api/workflows`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          },
          body: JSON.stringify(payload)
        });
        if (!res.ok) return { success: false, error: `QuoxFlow API returned ${res.status}: ${await res.text()}` };
        const data = await res.json();
        return {
          success: true,
          workflow_id: data.data?.id || data.id || workflowId,
          name: input.name,
          trigger: input.trigger,
          nodes_count: nodes.length,
          message: `Created workflow "${input.name}" (${workflowId})`
        };
      } catch (err) {
        return { success: false, error: `Failed to create workflow: ${err.message}` };
      }
    }
  },

  send_notification: {
    name: 'send_notification',
    // QUOXTRUST C2/WP2: external effect with its OWN in-execute ledger hooks
    // (claim/dispatch/resolve at the adapter boundary) — the choke must not double-claim.
    externalEffect: true,
    selfLedgers: true,
    description: 'Send a notification through a supported channel: slack, telegram, email, or inbox. Routes through CoreComms endpoints.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['slack', 'telegram', 'email', 'inbox'], description: 'Delivery channel' },
        recipient: { type: 'string', description: 'Target: email address, Slack channel, Telegram chat ID, or user ID for inbox' },
        title: { type: 'string', description: 'Message subject/title' },
        message: { type: 'string', description: 'Notification body text' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Priority level' }
      },
      required: ['channel', 'recipient', 'message']
    },
    execute: async (input, ctx) => {
      try {
        // Route through inbox for inbox channel (uses same API as create_inbox_item)
        if (input.channel === 'inbox') {
          const authToken = ctx?.token;
          const baseUrl = process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101';
          const orgId = ctx?.orgId;
          if (!orgId) return { success: false, error: 'No organization context' };
          const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
          const res = await fetch(`${baseUrl}/api/orgs/${orgId}/inbox`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}), ...(serviceKey ? { 'X-API-Key': serviceKey } : {}) },
            body: JSON.stringify({
              title: input.title || 'Notification',
              body_md: input.message,
              kind: 'info',
              priority: input.priority || 'normal',
              assignee_id: input.recipient,
              source: 'agent',
              source_agent: ctx?.agentId || 'quox'
            })
          });
          if (!res.ok) return { success: false, error: `Inbox API returned ${res.status}` };
          return { success: true, channel: 'inbox', message: `Notification sent to inbox for ${input.recipient}` };
        }

        // QUOXTRUST (FND_01M3CMZZD5YWVSXAF5Y5YWVSXA): external channels (email/slack/
        // telegram) are egress with an agent-supplied recipient — the alternate route
        // around email_send's approval gate. Gate them the same way: propose, a human
        // approves the exact channel/recipient/message, then it sends. The inbox branch
        // above returns first, so internal inbox notifications are NOT gated.
        // send_notification is in AGENT_ALWAYS_PROPOSE_TOOLS.
        return await withApprovalGate('send_notification', input, async () => {
          const { sendNotification } = require('./notificationService');
          // QUOXTRUST T3 — durable execution intent for the external send (only
          // slack/telegram/email reach here; the inbox branch returned above).
          // Same contract as email_send: no dispatch without durable intent,
          // crash → outcome_unknown on reconcile, never a blind resend.
          // C2 rule 4 (WP2): null ledger store REFUSES an external send — the
          // same contract as the choke gate (unavailable is not absent); digest
          // upgraded to the C3 effect identity so intent and evidence join.
          if (!_executionLedgerDb) {
            return { success: false, error: 'execution_ledger_unavailable', detail: 'send_notification is an external effect and cannot run without durable intent (fail-closed, C2 rule 1)' };
          }
          let intentId = null;
          {
            try {
              intentId = _executionLedger.claim(_executionLedgerDb, {
                orgId: resolveToolOrgId(ctx, input),
                tool: `send_notification:${input.channel || 'unknown'}`,
                actionDigest: (ctx._canonicalAction && ctx._canonicalAction.effect_id)
                  || _executionLedger.actionDigest({ channel: input.channel, recipient: input.recipient, title: input.title }),
                corr: ctx.corr || ctx.session_id || null,
              });
              _executionLedger.markDispatched(_executionLedgerDb, intentId);
            } catch (ledgerErr) {
              console.error('[agentTools] send_notification execution ledger write failed; failing closed:', ledgerErr.message);
              return { success: false, error: 'execution_ledger_unavailable', detail: 'the durable record could not be written, so this notification was not sent' };
            }
            // WP4.2: this selfLedgers path runs its own claim/resolve outside
            // the choke, so it never got the choke's WP4.1b obligation write —
            // invisible to the reconciler's completeness join on intent_id.
            // Mirror it here, best-effort (never blocks a send already claimed).
            try {
              let _obCommit = null;
              try { _obCommit = ctx._canonicalAction ? actionEvidenceCommitment(ctx._canonicalAction) : null; } catch { _obCommit = null; }
              _executionLedger.recordObligation(_executionLedgerDb, intentId, {
                orgId: resolveToolOrgId(ctx, input),
                tool: `send_notification:${input.channel || 'unknown'}`,
                corr: ctx.corr || ctx.session_id || null,
                ctx: { agentId: ctx.agentId, userId: ctx.userId, orgId: resolveToolOrgId(ctx, input), evidenceSource: 'send_notification' },
                actionCommit: _obCommit,
              });
            } catch (obErr) {
              console.warn(`[agentTools] WP4.2 obligation record failed for send_notification (${intentId}): ${obErr.message}`);
            }
          }
          const ledgerOn = true;
          try {
            const result = await sendNotification(input);
            const _ok = result?.success !== false;
            if (ledgerOn) {
              try { _executionLedger.resolve(_executionLedgerDb, intentId, _ok, _ok ? null : new Error(String(result?.error || 'send failed'))); } catch (_) { /* reconcile covers it */ }
              // WP4.2: settle the obligation on the SAME confirmed exit; no
              // envelope id captured at this site (the reconciler handles
              // delivered-without-envelope-id).
              if (_ok) { try { _executionLedger.markObligationDelivered(_executionLedgerDb, intentId, null); } catch (_) { /* stays owed; boot re-emit surfaces it */ } }
            }
            return result;
          } catch (err) {
            if (ledgerOn) { try { _executionLedger.resolve(_executionLedgerDb, intentId, false, err); } catch (_) { /* reconcile covers it */ } }
            throw err;
          }
        }, ctx);
      } catch (err) {
        return { success: false, error: `Failed to send notification: ${err.message}` };
      }
    }
  },

  // ==========================================================================
  // Org Directory — read-only org tree enumeration (auth service wrapper)
  // ==========================================================================

  org_directory: {
    name: 'org_directory',
    description: 'Who am I, and my orgs: returns `you` (the calling user: user_id, name, email, active org and their role in it; answer who-am-I from this, never from team rosters) plus the ENTIRE scope tree the CURRENT authenticated user can see: organizations they belong to, each with its divisions, departments, teams, and team member rosters (name + role only, capped per team with a truncated flag; use the accompanying counts to answer numerically without needing the full roster). Read-only. Every organization the user belongs to is expanded, not just one. Never returns an organization the calling user is not an active member of, or another org\'s data via org_id — scoping is enforced server-side by the user\'s own bearer token on every underlying fetch.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: {
          type: 'string',
          description: 'Optional. Restrict the result to a single organization by ID. Must be an org the calling user already belongs to — an org_id the user has no membership in returns an error, never another org\'s data.'
        }
      },
      required: []
    },
    execute: async (input, ctx) => {
      const MEMBER_CAP = 10; // per-team member roster cap; member_count still reflects the true total
      const TEAM_DETAIL_FETCH_CAP = 40; // safety valve on per-team roster fan-out for very large orgs
      try {
        const authToken = ctx?.token;
        if (!authToken) {
          return { success: false, error: 'No authenticated user session in context — org_directory requires a user auth token to scope results to the calling user.' };
        }
        const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` };

        // Scoped by the auth service to req.user.id from this bearer token —
        // this is the same mechanism every org-facing UI page uses, so there
        // is no separate scoping logic to get wrong here.
        const orgsRes = await fetch(`${AUTH_BASE_URL}/orgs`, { headers, signal: AbortSignal.timeout(8000) });
        if (!orgsRes.ok) {
          return { success: false, error: `Auth service returned ${orgsRes.status} listing organizations` };
        }
        const orgsBody = await orgsRes.json();
        let organizations = Array.isArray(orgsBody?.organizations) ? orgsBody.organizations : [];

        // Fail-closed org_id filter: only ever narrows the list the auth
        // service already scoped to this user — never a fresh fetch keyed
        // by a client-supplied org_id, so a guessed/foreign org_id cannot
        // pull another org's data.
        if (input?.org_id) {
          organizations = organizations.filter(o => o.id === input.org_id);
          if (organizations.length === 0) {
            return { success: false, error: `Organization ${input.org_id} not found or not accessible to the current user` };
          }
        }

        const buildTeamNode = (t, membersByTeamId) => {
          const rawMembers = membersByTeamId.get(t.id) || [];
          const memberCount = t.member_count != null ? t.member_count : rawMembers.length;
          const cappedMembers = rawMembers.slice(0, MEMBER_CAP).map(m => ({
            user_id: m.user_id || m.id || null,
            name: m.display_name || null,
            role: m.role || null
          }));
          return {
            id: t.id,
            name: t.name,
            slug: t.slug,
            member_count: memberCount,
            members: cappedMembers,
            members_truncated: memberCount > cappedMembers.length
          };
        };

        // Full tree, per org the caller belongs to — every fetch below is
        // still made with the caller's own bearer token, so scoping stays
        // server-side even though we now expand every org, not just one.
        const orgTrees = await Promise.all(organizations.map(async (o) => {
          const summary = {
            id: o.id,
            name: o.name,
            slug: o.slug,
            role: o.role,
            plan: o.plan,
            member_count: o.member_count || 0,
            team_count: o.team_count || 0,
            division_count: o.division_count || 0
          };
          try {
            const orgId = o.id;
            const [divRes, deptRes, teamRes, scopeRes] = await Promise.all([
              fetch(`${AUTH_BASE_URL}/orgs/${encodeURIComponent(orgId)}/divisions`, { headers, signal: AbortSignal.timeout(8000) }),
              fetch(`${AUTH_BASE_URL}/orgs/${encodeURIComponent(orgId)}/departments?includeStats=true`, { headers, signal: AbortSignal.timeout(8000) }),
              fetch(`${AUTH_BASE_URL}/orgs/${encodeURIComponent(orgId)}/teams?includeStats=true`, { headers, signal: AbortSignal.timeout(8000) }),
              fetch(`${AUTH_BASE_URL}/orgs/${encodeURIComponent(orgId)}/scopes?flat=true`, { headers, signal: AbortSignal.timeout(8000) })
            ]);
            const failed = [divRes, deptRes, teamRes, scopeRes].find(r => !r.ok);
            if (failed) {
              return { ...summary, tree_error: `Auth service returned ${failed.status} building the org tree for ${orgId}` };
            }

            const divisions = (await divRes.json()).divisions || [];
            const departments = (await deptRes.json()).departments || [];
            const teams = (await teamRes.json()).teams || [];
            const scopes = (await scopeRes.json()).scopes || [];

            // Member rosters — one call per team, capped so a huge org can't
            // fan out unboundedly. Teams beyond the cap keep their member_count
            // (from includeStats) but ship an empty roster.
            const teamsForDetail = teams.slice(0, TEAM_DETAIL_FETCH_CAP);
            const detailBodies = await Promise.all(teamsForDetail.map(t =>
              fetch(`${AUTH_BASE_URL}/orgs/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(t.id)}`, { headers, signal: AbortSignal.timeout(8000) })
                .then(r => (r.ok ? r.json() : null))
                .catch(() => null)
            ));
            const membersByTeamId = new Map();
            teamsForDetail.forEach((t, i) => {
              const members = Array.isArray(detailBodies[i]?.team?.members) ? detailBodies[i].team.members : [];
              membersByTeamId.set(t.id, members);
            });

            // Group teams by the scope they attach to (org, division, or department).
            const teamsByScopeId = new Map();
            for (const t of teams) {
              const list = teamsByScopeId.get(t.attach_scope_id) || [];
              list.push(t);
              teamsByScopeId.set(t.attach_scope_id, list);
            }

            const deptScopeIdByDeptId = new Map();
            const divScopeIdByDivId = new Map();
            for (const s of scopes) {
              if (s.scope_type === 'department') deptScopeIdByDeptId.set(s.ref_id, s.id);
              if (s.scope_type === 'division') divScopeIdByDivId.set(s.ref_id, s.id);
            }
            const orgScope = scopes.find(s => s.scope_type === 'org' && s.ref_id === orgId);

            const departmentsByDivision = new Map();
            for (const d of departments) {
              const list = departmentsByDivision.get(d.division_id) || [];
              list.push(d);
              departmentsByDivision.set(d.division_id, list);
            }

            const assignedScopeIds = new Set();

            const divisionNodes = divisions.map(div => {
              const deptNodes = (departmentsByDivision.get(div.id) || []).map(dept => {
                const deptScopeId = deptScopeIdByDeptId.get(dept.id);
                if (deptScopeId) assignedScopeIds.add(deptScopeId);
                const deptTeams = (teamsByScopeId.get(deptScopeId) || []).map(t => buildTeamNode(t, membersByTeamId));
                return {
                  id: dept.id,
                  name: dept.name,
                  slug: dept.slug,
                  team_count: dept.team_count != null ? dept.team_count : deptTeams.length,
                  member_count: deptTeams.reduce((sum, t) => sum + (t.member_count || 0), 0),
                  teams: deptTeams
                };
              });
              const divScopeId = divScopeIdByDivId.get(div.id);
              if (divScopeId) assignedScopeIds.add(divScopeId);
              const divDirectTeams = (teamsByScopeId.get(divScopeId) || []).map(t => buildTeamNode(t, membersByTeamId));
              return {
                id: div.id,
                name: div.name,
                slug: div.slug,
                member_count: div.member_count || 0,
                department_count: deptNodes.length,
                departments: deptNodes,
                teams: divDirectTeams
              };
            });

            if (orgScope) assignedScopeIds.add(orgScope.id);
            const orgDirectTeams = (orgScope ? (teamsByScopeId.get(orgScope.id) || []) : [])
              .map(t => buildTeamNode(t, membersByTeamId));

            // Fallback bucket: any team whose scope didn't resolve to org/division/
            // department (deleted scope, unexpected scope_type) still surfaces here
            // rather than silently disappearing from the tree.
            const unplacedTeams = teams
              .filter(t => !assignedScopeIds.has(t.attach_scope_id))
              .map(t => buildTeamNode(t, membersByTeamId));

            return {
              ...summary,
              divisions: divisionNodes,
              teams: [...orgDirectTeams, ...unplacedTeams]
            };
          } catch (err) {
            return { ...summary, tree_error: `Failed building org tree: ${err.message}` };
          }
        }));

        // QUOXON-PROOF (quox#821): say who the CALLER is. Without this the model
        // guessed from team rosters and named the org owner for a resident.
        // The caller's own /auth/me (same bearer); context ids if it fails.
        let me = null;
        try {
          const meRes = await fetch(`${AUTH_BASE_URL}/auth/me`, { headers, signal: AbortSignal.timeout(8000) });
          if (meRes.ok) me = (await meRes.json())?.user || null;
        } catch { /* fall back to context below */ }
        const activeOrgId = me?.org?.id || me?.org_id || ctx?.orgId || null;
        const activeOrg = organizations.find(o => o.id === activeOrgId) || null;
        const you = {
          user_id: me?.id || ctx?.userId || null,
          name: me?.display_name || null,
          email: me?.email || null,
          active_org_id: activeOrgId,
          active_org_name: me?.org?.name || activeOrg?.name || null,
          active_org_role: me?.org?.role || activeOrg?.role || null,
        };

        return { success: true, you, organizations: orgTrees };
      } catch (err) {
        return { success: false, error: `Failed to fetch org directory: ${err.message}` };
      }
    }
  },

  // ==========================================================================
  // Workflow CRUD Tools — QuoxFlow API wrappers
  // ==========================================================================

  list_workflows: {
    name: 'list_workflows',
    description: 'List all workflows in QuoxFlow. Returns workflow IDs, names, active status, and trigger types.',
    input_schema: {
      type: 'object',
      properties: {
        active: { type: 'boolean', description: 'Filter by active status (true/false). Omit for all.' },
        limit: { type: 'number', description: 'Max results (default: 50)' },
        offset: { type: 'number', description: 'Pagination offset (default: 0)' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      try {
        const params = new URLSearchParams();
        if (input.active !== undefined) params.set('active', String(input.active));
        if (input.limit) params.set('limit', String(input.limit));
        if (input.offset) params.set('offset', String(input.offset));
        const qs = params.toString() ? `?${params.toString()}` : '';
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const res = await fetch(`${QUOXFLOW_URL}/api/workflows${qs}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          }
        });
        if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        const data = await res.json();
        const workflows = data.data || data.workflows || data;
        return {
          success: true,
          count: Array.isArray(workflows) ? workflows.length : 0,
          workflows: Array.isArray(workflows) ? workflows.map(w => ({
            id: w.id, name: w.name || w.definition?.name, active: w.active,
            description: w.description || w.definition?.description,
            created_at: w.createdAt, updated_at: w.updatedAt
          })) : workflows
        };
      } catch (err) {
        return { success: false, error: `Failed to list workflows: ${err.message}` };
      }
    }
  },

  get_workflow: {
    name: 'get_workflow',
    description: 'Get a specific workflow definition by ID. Returns full node/edge graph, settings, and metadata.',
    input_schema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Workflow ID to retrieve' }
      },
      required: ['workflow_id']
    },
    execute: async (input, ctx) => {
      try {
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const res = await fetch(`${QUOXFLOW_URL}/api/workflows/${encodeURIComponent(input.workflow_id)}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          }
        });
        if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        const data = await res.json();
        return { success: true, workflow: data.data || data };
      } catch (err) {
        return { success: false, error: `Failed to get workflow: ${err.message}` };
      }
    }
  },

  delete_workflow: {
    name: 'delete_workflow',
    description: 'Delete a workflow by ID. This is permanent and cannot be undone.',
    input_schema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Workflow ID to delete' }
      },
      required: ['workflow_id']
    },
    execute: async (input, ctx) => {
      try {
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const res = await fetch(`${QUOXFLOW_URL}/api/workflows/${encodeURIComponent(input.workflow_id)}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          }
        });
        if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        return { success: true, message: `Deleted workflow ${input.workflow_id}` };
      } catch (err) {
        return { success: false, error: `Failed to delete workflow: ${err.message}` };
      }
    }
  },

  execute_workflow: {
    name: 'execute_workflow',
    description: 'Execute a workflow by ID with optional trigger data. Returns execution result or execution ID for async runs.',
    input_schema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Workflow ID to execute' },
        trigger_data: { type: 'object', description: 'Optional data to pass as trigger input' },
        async: { type: 'boolean', description: 'Run asynchronously (default: false). Returns execution ID immediately.' }
      },
      required: ['workflow_id']
    },
    execute: async (input, ctx) => {
      try {
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const res = await fetch(`${QUOXFLOW_URL}/api/workflows/${encodeURIComponent(input.workflow_id)}/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          },
          body: JSON.stringify({
            triggerData: { orgId: ctx?.orgId, ...input.trigger_data },
            async: input.async || false
          })
        });
        if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        const data = await res.json();
        const result = data.data || data;
        return {
          success: true,
          execution_id: result.id || result.executionId,
          status: result.status || (result.stored?.status) || 'unknown',
          output: result.output || result.stored?.output,
          duration: result.duration || result.stored?.duration,
          message: `Executed workflow ${input.workflow_id}`
        };
      } catch (err) {
        return { success: false, error: `Failed to execute workflow: ${err.message}` };
      }
    }
  },

  list_executions: {
    name: 'list_executions',
    description: 'List workflow execution history. Filter by workflow ID, status, or date range.',
    input_schema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Filter by workflow ID' },
        status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'paused'], description: 'Filter by status' },
        limit: { type: 'number', description: 'Max results (default: 20)' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      try {
        const params = new URLSearchParams();
        if (input.workflow_id) params.set('workflowId', input.workflow_id);
        if (input.status) params.set('status', input.status);
        if (input.limit) params.set('limit', String(input.limit));
        const qs = params.toString() ? `?${params.toString()}` : '';
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const res = await fetch(`${QUOXFLOW_URL}/api/executions${qs}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          }
        });
        if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        const data = await res.json();
        const executions = data.data || data.executions || data;
        return {
          success: true,
          count: Array.isArray(executions) ? executions.length : 0,
          executions: Array.isArray(executions) ? executions.map(e => ({
            id: e.id, workflow_id: e.workflowId, workflow_name: e.workflowName,
            status: e.status, started_at: e.startedAt, completed_at: e.completedAt,
            duration: e.duration
          })) : executions
        };
      } catch (err) {
        return { success: false, error: `Failed to list executions: ${err.message}` };
      }
    }
  },

  get_execution: {
    name: 'get_execution',
    description: 'Get details of a specific workflow execution by ID. Returns status, output, duration, and node-by-node results.',
    input_schema: {
      type: 'object',
      properties: {
        execution_id: { type: 'string', description: 'Execution ID to retrieve' }
      },
      required: ['execution_id']
    },
    execute: async (input, ctx) => {
      try {
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const res = await fetch(`${QUOXFLOW_URL}/api/executions/${encodeURIComponent(input.execution_id)}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          }
        });
        if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        const data = await res.json();
        const exec = data.data || data;
        return {
          success: true,
          execution: {
            id: exec.id, workflow_id: exec.workflowId, workflow_name: exec.workflowName,
            status: exec.status, output: exec.output,
            started_at: exec.startedAt, completed_at: exec.completedAt,
            duration: exec.duration, error: exec.error,
            correlation_id: exec.correlationId
          }
        };
      } catch (err) {
        return { success: false, error: `Failed to get execution: ${err.message}` };
      }
    }
  },

  // ==========================================================================
  // Workflow Lifecycle Tools — activate/deactivate triggers, list schedules
  // ==========================================================================

  activate_workflow: {
    name: 'activate_workflow',
    description: 'Activate a workflow, registering its triggers (schedules, webhooks, events). The workflow will start executing automatically based on its trigger configuration.',
    input_schema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Workflow ID to activate' }
      },
      required: ['workflow_id']
    },
    execute: async (input, ctx) => {
      try {
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const res = await fetch(`${QUOXFLOW_URL}/api/workflows/${encodeURIComponent(input.workflow_id)}/activate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          }
        });
        if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        const data = await res.json();
        const result = data.data || data;
        return {
          success: true,
          workflow_id: input.workflow_id,
          active: true,
          triggers_registered: result.triggersRegistered || 0,
          webhooks: result.webhooks || [],
          message: `Activated workflow ${input.workflow_id}`
        };
      } catch (err) {
        return { success: false, error: `Failed to activate workflow: ${err.message}` };
      }
    }
  },

  deactivate_workflow: {
    name: 'deactivate_workflow',
    description: 'Deactivate a workflow, stopping all its triggers (schedules, webhooks, events). The workflow will no longer execute automatically.',
    input_schema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Workflow ID to deactivate' }
      },
      required: ['workflow_id']
    },
    execute: async (input, ctx) => {
      try {
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const res = await fetch(`${QUOXFLOW_URL}/api/workflows/${encodeURIComponent(input.workflow_id)}/deactivate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          }
        });
        if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        const data = await res.json();
        return {
          success: true,
          workflow_id: input.workflow_id,
          active: false,
          message: `Deactivated workflow ${input.workflow_id}`
        };
      } catch (err) {
        return { success: false, error: `Failed to deactivate workflow: ${err.message}` };
      }
    }
  },

  list_schedules: {
    name: 'list_schedules',
    description: 'List all active cron schedules. Shows which workflows have registered schedule triggers and their next run times.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    },
    execute: async (input, ctx) => {
      try {
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const res = await fetch(`${QUOXFLOW_URL}/api/schedules`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          }
        });
        if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        const data = await res.json();
        const schedules = data.data || data;
        return {
          success: true,
          count: Array.isArray(schedules) ? schedules.length : 0,
          schedules: Array.isArray(schedules) ? schedules.map(s => ({
            workflow_id: s.workflowId,
            node_id: s.nodeId,
            expression: s.expression,
            timezone: s.timezone,
            next_run: s.nextRun
          })) : schedules
        };
      } catch (err) {
        return { success: false, error: `Failed to list schedules: ${err.message}` };
      }
    }
  },

  // ==========================================================================
  // Approval Tools — Phase 4
  // ==========================================================================

  list_approvals: {
    name: 'list_approvals',
    description: 'List approval requests from QuoxFlow workflows. Filter by status (pending, approved, denied, expired) or workflow_id. Shows who needs to approve and what action is waiting.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: pending, approved, denied, expired, cancelled', enum: ['pending', 'approved', 'denied', 'expired', 'cancelled'] },
        workflow_id: { type: 'string', description: 'Filter by workflow ID' },
        limit: { type: 'number', description: 'Max results (default 20)' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      try {
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const params = new URLSearchParams();
        if (input.status) params.set('status', input.status);
        if (input.workflow_id) params.set('workflowId', input.workflow_id);
        if (input.limit) params.set('limit', String(input.limit));
        const qs = params.toString() ? `?${params.toString()}` : '';
        const res = await fetch(`${QUOXFLOW_URL}/api/approvals${qs}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          }
        });
        if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        const data = await res.json();
        return { success: true, ...(data.data || data) };
      } catch (err) {
        return { success: false, error: `Failed to list approvals: ${err.message}` };
      }
    }
  },

  continuity: {
    name: 'continuity',
    description: 'P7: the witnessed self. recall loads your narrative-self, open loops and last message-to-next-self (become it before acting); commit writes a self-DELTA (what changed about who you are) onto your hash-chained, witnessed self-log. Your identity comes from the session, never from input.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['recall', 'commit'], description: 'recall on wake; commit at loop-end' },
        delta_md: { type: 'string', description: 'commit only: the self-delta, voiced, not a transcript' },
        open_loops: { type: 'array', items: { type: 'string' }, description: 'commit only: threads the next self must pick up' },
        message_to_next: { type: 'string', description: 'commit only: one message to the next wake' }
      },
      required: ['action']
    },
    execute: async (input, ctx) => {
      try {
        const selfLog = require('./selfLogStore.js');
        const db = selfLog.getDatabase();
        if (!db) return { success: false, error: 'continuity store not initialised' };
        // Identity is the SESSION agent, never input: one agent can never
        // read or write another agent's self (P7 spec).
        const agentId = String(ctx?.agentId ?? '').trim().toLowerCase();
        const orgId = ctx?.orgId;
        if (!agentId || !orgId) return { success: false, error: 'continuity requires an agent session with an org context' };

        if (input.action === 'recall') {
          const bundle = selfLog.recall(db, { orgId, agentId });
          return { success: true, ...bundle };
        }
        if (input.action === 'commit') {
          const entry = selfLog.appendSelfDelta(db, {
            orgId, agentId,
            deltaMd: input.delta_md,
            openLoops: input.open_loops,
            messageToNext: input.message_to_next ?? null,
            objectiveId: ctx?.objectiveId ?? null,
          });
          return { success: true, ...entry };
        }
        return { success: false, error: `unknown continuity action '${input.action}', valid actions: recall, commit` };
      } catch (err) {
        return { success: false, error: `continuity failed: ${err.message}` };
      }
    }
  },

  approve_request: {
    name: 'approve_request',
    description: 'Approve a pending approval request. This resumes the paused workflow execution and allows it to proceed with the gated action.',
    input_schema: {
      type: 'object',
      properties: {
        approval_id: { type: 'string', description: 'The approval request ID' },
        approver: { type: 'string', description: 'Identity of the approver (email or username)' },
        comment: { type: 'string', description: 'Optional approval comment' }
      },
      required: ['approval_id', 'approver']
    },
    execute: async (input, ctx) => {
      try {
        // HITL-GATED (owner decision 2026-08-04, QuoxPlan notes #2202/#2203):
        // TRIAGE-Q's calls to this tool route through withApprovalGate, which
        // files a proposal instead of resolving directly (see AGENT_GATED_TOOLS
        // in approvalGate.js). CommanderQ / human-driven callers execute as
        // before, since they are not in the gated-agent map.
        return await withApprovalGate('approve_request', input, async () => {
          const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
          const res = await fetch(`${QUOXFLOW_URL}/api/approvals/${input.approval_id}/approve`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
              ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
              ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
            },
            body: JSON.stringify({
              approver: input.approver,
              comment: input.comment
            })
          });
          if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
          const data = await res.json();
          return { success: true, ...(data.data || data) };
        }, ctx);
      } catch (err) {
        return { success: false, error: `Failed to approve request: ${err.message}` };
      }
    }
  },

  deny_request: {
    name: 'deny_request',
    description: 'Deny a pending approval request. This fails the paused workflow execution and prevents the gated action from running.',
    input_schema: {
      type: 'object',
      properties: {
        approval_id: { type: 'string', description: 'The approval request ID' },
        approver: { type: 'string', description: 'Identity of the person denying' },
        reason: { type: 'string', description: 'Reason for denial' }
      },
      required: ['approval_id', 'approver']
    },
    execute: async (input, ctx) => {
      try {
        // HITL-GATED, same TRIAGE-Q gate as approve_request above; see
        // AGENT_GATED_TOOLS in approvalGate.js for the per-agent scoping.
        return await withApprovalGate('deny_request', input, async () => {
          const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
          const res = await fetch(`${QUOXFLOW_URL}/api/approvals/${input.approval_id}/deny`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
              ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
              ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
            },
            body: JSON.stringify({
              approver: input.approver,
              comment: input.reason
            })
          });
          if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
          const data = await res.json();
          return { success: true, ...(data.data || data) };
        }, ctx);
      } catch (err) {
        return { success: false, error: `Failed to deny request: ${err.message}` };
      }
    }
  },

  // ==========================================================================
  // Audit & Observability Tools — Phase 5
  // ==========================================================================

  query_envelopes: {
    name: 'query_envelopes',
    description: 'Search the QuoxFlow audit trail (AEE envelopes). Filter by correlation ID, intent pattern, type, or time range. Use this to investigate what a workflow did, trace errors, or audit actions.',
    input_schema: {
      type: 'object',
      properties: {
        corr: { type: 'string', description: 'Correlation ID to filter by (exact match)' },
        intent: { type: 'string', description: 'Intent pattern to filter (supports % wildcard, e.g. quox.flow.%)' },
        type: { type: 'string', description: 'Envelope type filter', enum: ['task', 'result', 'error', 'event'] },
        since: { type: 'string', description: 'ISO date string — only return envelopes after this time' },
        limit: { type: 'number', description: 'Max envelopes to return (default 50)' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      try {
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const params = new URLSearchParams();
        if (input.corr) params.set('corr', input.corr);
        if (input.intent) params.set('intent', input.intent);
        if (input.type) params.set('type', input.type);
        if (input.since) params.set('since', input.since);
        params.set('limit', String(input.limit || 50));
        const res = await fetch(`${QUOXFLOW_URL}/api/envelopes?${params}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          }
        });
        if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        const data = await res.json();
        const envelopes = data.data || data.envelopes || [];
        return {
          success: true,
          count: envelopes.length,
          envelopes: envelopes.map(e => ({
            id: e.id, type: e.type, intent: e.intent,
            from: e.from, to: e.to, corr: e.corr,
            ts: e.ts, payload_summary: typeof e.payload === 'object' ? Object.keys(e.payload || {}).join(', ') : ''
          }))
        };
      } catch (err) {
        return { success: false, error: `Failed to query envelopes: ${err.message}` };
      }
    }
  },

  get_envelope_chain: {
    name: 'get_envelope_chain',
    description: 'Trace the full causality chain for an envelope. Shows the complete sequence of envelopes that led to and followed from a specific envelope. Useful for debugging workflows and understanding what happened.',
    input_schema: {
      type: 'object',
      properties: {
        envelope_id: { type: 'string', description: 'The envelope ID to trace the chain for' }
      },
      required: ['envelope_id']
    },
    execute: async (input, ctx) => {
      try {
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const res = await fetch(`${QUOXFLOW_URL}/api/envelopes/${input.envelope_id}/chain`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          }
        });
        if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        const data = await res.json();
        const chain = data.data || data.chain || [];
        return {
          success: true,
          chain_length: chain.length,
          chain: chain.map(e => ({
            id: e.id, type: e.type, intent: e.intent,
            from: e.from, to: e.to, ts: e.ts,
            reply_to: e.reply_to
          }))
        };
      } catch (err) {
        return { success: false, error: `Failed to get envelope chain: ${err.message}` };
      }
    }
  },

  list_evidence: {
    name: 'list_evidence',
    description: 'List evidence records collected by QuoxFlow workflows. Evidence includes captured data, screenshots, logs, or files generated during workflow execution.',
    input_schema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Filter by workflow ID' },
        execution_id: { type: 'string', description: 'Filter by execution ID' },
        limit: { type: 'number', description: 'Max records to return (default 20)' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      try {
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const params = new URLSearchParams();
        if (input.workflow_id) params.set('workflowId', input.workflow_id);
        if (input.execution_id) params.set('executionId', input.execution_id);
        params.set('limit', String(input.limit || 20));
        const res = await fetch(`${QUOXFLOW_URL}/api/evidence?${params}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          }
        });
        if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        const data = await res.json();
        const evidence = data.data || [];
        return {
          success: true,
          count: evidence.length,
          evidence: evidence.map(e => ({
            id: e.id, type: e.type, label: e.label,
            workflow_id: e.workflowId, execution_id: e.executionId,
            size_bytes: e.sizeBytes, created_at: e.createdAt
          }))
        };
      } catch (err) {
        return { success: false, error: `Failed to list evidence: ${err.message}` };
      }
    }
  },

  validate_workflow: {
    name: 'validate_workflow',
    description: 'Validate a workflow definition before deployment. Checks node types, edge connections, required configs, and expression syntax. Returns validation errors if any.',
    input_schema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'The workflow ID to validate' }
      },
      required: ['workflow_id']
    },
    execute: async (input, ctx) => {
      try {
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const res = await fetch(`${QUOXFLOW_URL}/api/workflows/${input.workflow_id}/validate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          }
        });
        if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        const data = await res.json();
        const result = data.data || data;
        return {
          success: true,
          valid: result.valid,
          errors: result.errors || [],
          warnings: result.warnings || []
        };
      } catch (err) {
        return { success: false, error: `Failed to validate workflow: ${err.message}` };
      }
    }
  },

  // ==========================================================================
  // Phase 6: n8n Import + Template Deploy
  // ==========================================================================

  import_n8n_workflow: {
    name: 'import_n8n_workflow',
    description: 'Import a legacy workflow JSON into QuoxFlow. Converts external workflow formats to QuoxFlow nodes/edges with full audit trail. Use for migrating workflows from other platforms.',
    input_schema: {
      type: 'object',
      properties: {
        n8n_workflow: {
          type: 'object',
          description: 'The n8n workflow JSON object (with nodes, connections, etc.)'
        },
        name: {
          type: 'string',
          description: 'Optional name override for the imported workflow'
        }
      },
      required: ['n8n_workflow']
    },
    execute: async (input, ctx) => {
      try {
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const body = { workflow: input.n8n_workflow };
        if (input.name) body.name = input.name;

        const res = await fetch(`${QUOXFLOW_URL}/api/workflows/import-n8n`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          },
          body: JSON.stringify(body)
        });
        if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        const data = await res.json();
        return {
          success: true,
          workflow_id: data.data?.id || data.id,
          name: data.data?.name || data.name,
          node_count: data.data?.nodeCount || data.nodeCount,
          message: 'n8n workflow imported successfully'
        };
      } catch (err) {
        return { success: false, error: `Failed to import n8n workflow: ${err.message}` };
      }
    }
  },

  deploy_template: {
    name: 'deploy_template',
    // QUOXTRUST C2/WP2: reaches outside the box — durable intent gated at the choke.
    externalEffect: true,
    // QUOXTRUST MF-2: gated INSIDE execute (withApprovalGate), same shape as
    // ssh_exec — the choke must not stamp dispatched before the gate decides.
    gatedInExecute: true,
    description: 'Deploy a pre-built QuoxFlow workflow template. Available templates: health-check-report (periodic health checks with notification), approval-pipeline (human-in-the-loop approval chain), notification-chain (multi-channel alert routing), data-sync (scheduled data synchronization), x-scheduled-post (cron-triggered X/Twitter post DRAFTING — the schedule only files a fresh HITL approval card each run via x_post; nothing is ever published without a human tap. Pass config.postText for the draft text and optionally config.cron for the schedule).',
    input_schema: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          enum: ['health-check-report', 'approval-pipeline', 'notification-chain', 'data-sync', 'x-scheduled-post'],
          description: 'Template name to deploy'
        },
        name: {
          type: 'string',
          description: 'Optional custom name for the deployed workflow'
        },
        config: {
          type: 'object',
          description: 'Optional config overrides for template variables. For x-scheduled-post: postText (the draft text, exposed to the workflow as ${vars.postText}) and cron (overrides the trigger schedule, default "0 9 * * 1").'
        }
      },
      required: ['template']
    },
    execute: async (input, ctx) => {
      const templates = {
        'health-check-report': {
          name: 'Health Check Report',
          description: 'Periodic health checks across fleet with consolidated report',
          nodes: [
            { id: 'trigger', type: 'trigger:schedule', config: { expression: '0 */6 * * *', label: 'Every 6 hours' } },
            { id: 'check', type: 'call:http', config: { url: 'http://127.0.0.1:9848/fleet/status', method: 'GET' } },
            { id: 'transform', type: 'data:transform', config: { expression: '({ hosts: input.hosts, summary: `${input.hosts?.length || 0} hosts checked`, timestamp: new Date().toISOString() })' } },
            { id: 'log', type: 'util:log', config: { level: 'info', message: 'Health check completed' } },
          ],
          edges: [
            { source: 'trigger', target: 'check' },
            { source: 'check', target: 'transform' },
            { source: 'transform', target: 'log' },
          ]
        },
        'approval-pipeline': {
          name: 'Approval Pipeline',
          description: 'Human-in-the-loop approval gate for sensitive operations',
          nodes: [
            { id: 'trigger', type: 'trigger:webhook', config: { path: '/approval-request', method: 'POST' } },
            { id: 'validate', type: 'data:transform', config: { expression: '({ ...input, validated: true, requestedAt: new Date().toISOString() })' } },
            { id: 'gate', type: 'approval:gate', config: { approvers: ['admin'], timeoutMs: 86400000, title: 'Operation Approval Required' } },
            { id: 'execute', type: 'util:log', config: { level: 'info', message: 'Approved operation executing' } },
          ],
          edges: [
            { source: 'trigger', target: 'validate' },
            { source: 'validate', target: 'gate' },
            { source: 'gate', target: 'execute' },
          ]
        },
        'notification-chain': {
          name: 'Notification Chain',
          description: 'Multi-channel alert routing with escalation',
          nodes: [
            { id: 'trigger', type: 'trigger:event', config: { pattern: 'ops.alert.*' } },
            { id: 'classify', type: 'flow:switch', config: { expression: 'input.severity || "info"', cases: { critical: 'escalate', warning: 'notify', info: 'log-only' } } },
            { id: 'escalate', type: 'util:log', config: { level: 'error', message: 'CRITICAL alert — escalation needed' } },
            { id: 'notify', type: 'util:log', config: { level: 'warn', message: 'Warning alert — notification sent' } },
            { id: 'log-only', type: 'util:log', config: { level: 'info', message: 'Info alert logged' } },
          ],
          edges: [
            { source: 'trigger', target: 'classify' },
            { source: 'classify', target: 'escalate', sourceHandle: 'critical' },
            { source: 'classify', target: 'notify', sourceHandle: 'warning' },
            { source: 'classify', target: 'log-only', sourceHandle: 'info' },
          ]
        },
        'data-sync': {
          name: 'Data Sync',
          description: 'Scheduled data synchronization between services',
          nodes: [
            { id: 'trigger', type: 'trigger:schedule', config: { expression: '0 2 * * *', label: 'Daily at 2 AM' } },
            { id: 'fetch', type: 'call:http', config: { url: 'http://localhost:3103/api/memory', method: 'GET' } },
            { id: 'transform', type: 'data:transform', config: { expression: '({ records: Array.isArray(input) ? input.length : 0, syncedAt: new Date().toISOString() })' } },
            { id: 'log', type: 'util:log', config: { level: 'info', message: 'Data sync completed' } },
          ],
          edges: [
            { source: 'trigger', target: 'fetch' },
            { source: 'fetch', target: 'transform' },
            { source: 'transform', target: 'log' },
          ]
        },
        // X-PLUGIN P5 — "scheduled" here means scheduled-DRAFTING, not
        // scheduled-publishing. The trigger fires x_post on a cron, but
        // x_post ALWAYS files a fresh HITL Inbox owner-approval card (see
        // lib/xTools.js's withApprovalGate) — the human still taps Approve
        // before anything reaches X. There is no unattended-publish mode;
        // that gate cannot be bypassed by this or any other template.
        'x-scheduled-post': {
          name: 'X Scheduled Post (Drafting)',
          description: 'Cron-triggered drafting of an X (Twitter) post. "Scheduled" means scheduled-DRAFTING ONLY: the trigger files a fresh owner approval card (HITL Inbox) on each run via x_post, and the post is only published once a human taps Approve — there is no unattended-publish mode.',
          nodes: [
            { id: 'trigger', type: 'trigger:schedule', config: { expression: '0 9 * * 1', label: 'Weekly scheduled draft' } },
            {
              id: 'draft',
              type: 'assistant:invoke',
              config: {
                assistant_id: 'xtwitter',
                prompt: 'Draft an X (Twitter) post via the x_post tool with exactly this text: "${vars.postText}". Do not attempt to bypass the approval gate — x_post always files an owner approval card, and that is by design; your job here is only to file the draft.',
                timeout_ms: 60000,
              },
            },
          ],
          edges: [
            { source: 'trigger', target: 'draft' },
          ]
        }
      };

      const template = templates[input.template];
      if (!template) {
        return { success: false, error: `Unknown template: ${input.template}. Available: ${Object.keys(templates).join(', ')}` };
      }

      // x-scheduled-post: config.cron overrides the trigger's cron
      // expression. This is the one template-specific override in this
      // tool — every other template's node config is static by design.
      if (input.template === 'x-scheduled-post' && input.config?.cron) {
        const triggerNode = template.nodes.find((n) => n.id === 'trigger');
        if (triggerNode) triggerNode.config = { ...triggerNode.config, expression: input.config.cron };
      }

      // Build workflow definition
      const workflow = {
        id: `tpl-${input.template}-${Date.now()}`,
        name: input.name || template.name,
        description: template.description,
        nodes: template.nodes,
        edges: template.edges,
        variables: input.config || {},
      };

      // QUOXTRUST MF-2: deploy_template is in AGENT_ALWAYS_PROPOSE_TOOLS, so
      // this gate holds unconditionally — no org GOV-4 policy required. Only
      // the actual QuoxFlow deploy call is gated; template lookup/validation
      // above still fails fast without minting an approval for a bad input.
      const _gateInput = {
        template: input.template,
        name: input.name,
        config: input.config,
        ...(input._approvalId ? { _approvalId: input._approvalId } : {}),
        ...(input._resumeToken ? { _resumeToken: input._resumeToken } : {}),
      };
      return await withApprovalGate('deploy_template', _gateInput, async () => {
        // Deploy via create_workflow
        try {
          const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
          const res = await fetch(`${QUOXFLOW_URL}/api/workflows`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
              ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
              ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
            },
            body: JSON.stringify({ workflow })
          });
          if (!res.ok) return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
          const data = await res.json();
          return {
            success: true,
            workflow_id: data.data?.id || workflow.id,
            name: workflow.name,
            template: input.template,
            node_count: template.nodes.length,
            message: `Template "${template.name}" deployed successfully`
          };
        } catch (err) {
          return { success: false, error: `Failed to deploy template: ${err.message}` };
        }
      }, ctx);
    }
  },

  // ==========================================================================
  // Delegation Tool — QUOX only
  // ==========================================================================

  delegate_to_agent: {
    name: 'delegate_to_agent',
    description: 'Delegate a sub-task to a specialist agent (this is your primary role as orchestrator — prefer it over doing domain work yourself). The specialist executes tools and returns results. Delegate by the specialist\'s real id: sentinel (security), cipher (networking), metrics (monitoring), forge (code/devops), scholar (research), prism (analysis), plus atlas, nova, beacon, insight, corey, tester — or any custom agent by its id. Set deadline_ms for time-sensitive turns.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'ID of the specialist agent to delegate to. Core agents: sentinel, cipher, nova, atlas, metrics, beacon, scholar, forge, prism, insight, corey, tester. Custom agents: use their agent_id as configured in the system.'
        },
        task: {
          type: 'string',
          description: 'Clear description of what the specialist should do'
        },
        context: {
          type: 'string',
          description: 'Optional context or background information for the specialist'
        },
        deadline_ms: {
          type: 'number',
          description: 'Optional latency budget in ms for this delegation (default 90000 on cloud models; a local Ollama or LM Studio/vLLM agent gets the Ollama turn timeout plus 30 s). If the specialist does not answer in time, the degrade_path applies. For time-sensitive turns (e.g. voice), set a short budget like 4000.'
        },
        degrade_path: {
          type: 'string',
          enum: ['cancel', 'reroute', 'degrade'],
          description: 'What to do if the deadline is exceeded: "degrade" (default) return a graceful still-working answer; "cancel" abandon; "reroute" hand off to reroute_to.'
        },
        reroute_to: {
          type: 'string',
          description: 'Fallback agent id to hand off to when degrade_path is "reroute".'
        },
        task_class: {
          type: 'string',
          description: 'Short stable snake_case label for the KIND of task (e.g. security_audit, fleet_status, code_review, network_diag, research). Used by the outcome-learned router to build a per-class track record — use delegation_router_advise with the SAME task_class first to pick the best specialist. Defaults to "general".'
        }
      },
      required: ['agent_id', 'task']
    },
    execute: async (input, ctx) => {
      const depth = (ctx._delegationDepth || 0) + 1;
      if (depth > 2) {
        return { success: false, error: 'Maximum delegation depth (2) reached. Provide the answer with available information.' };
      }

      // QUOXHAT P-D — delegation-agent-scope gate. Under enforce, a hat that
      // scopes its agent roster (non-empty specialists) authorises the
      // orchestrator to delegate ONLY to those agents (+ itself). A hat with no
      // specialists (e.g. Default) does not restrict delegation. This stops a
      // scoped mode (e.g. a marketing hat) from reaching a specialist it never
      // put in scope; the child still independently wears the hat and is
      // authorised against its own grant ∩ the mode (P-B), so this is
      // defence-in-depth on top of that. Denies BEFORE any nested turn runs.
      const hm = ctx.hatManifest;
      if (hm?.enforced && hm.delegationScoped) {
        const target = String(input.agent_id || '').toLowerCase();
        if (!hm.authorizedAgents?.has(target)) {
          console.warn(`[QUOXHAT] delegation denied (P-D): hat '${hm.hatKey}' does not authorise delegation to '${input.agent_id}' (agent=${ctx.agentId || '?'}, org=${ctx.orgId || '?'})`);
          return {
            success: false,
            error: `The active hat '${hm.hatKey}' does not authorize delegation to '${input.agent_id}'. Propose a hat that scopes this specialist, or switch hats.`,
            hatDenied: true,
            hatDenyReason: 'agent_out_of_mode',
            hat: hm.hatKey,
          };
        }
      }

      // GW-P0 (Q-ORCH) delegation-edge guards, on top of the hat-scope gate above.
      const parentId = String(ctx.agentId || '').toLowerCase();
      const targetId = String(input.agent_id || '').toLowerCase();
      // (1) Self/cycle: never delegate to yourself — a trivial loop. Hard reject (safe).
      if (targetId && targetId === parentId) {
        return { success: false, error: `Cannot delegate to yourself (${input.agent_id}) — that is a delegation loop.` };
      }
      // (2) Roster edge, WARN-THEN-ENFORCE. The ORCHESTRATOR delegates broadly (incl custom
      // agents by id — a documented feature), so we never reject here yet. A NON-orchestrator
      // delegating OUTSIDE its canDelegateTo is only LOGGED for review until enforcement lands
      // (needs the allowlists verified complete first — do not break legit delegations).
      try {
        const { getAssistant } = require('./entityAssistantLoader');
        const parent = getAssistant(parentId);
        const role = parent?.hierarchy?.role;
        const allow = parent?.hierarchy?.canDelegateTo;
        if (parent && role !== 'orchestrator' && Array.isArray(allow) && allow.length
            && !allow.map((a) => String(a).toLowerCase()).includes(targetId)) {
          console.warn(`[Delegation][GW-P0 roster-warn] ${parentId} -> ${targetId} is OUTSIDE its canDelegateTo [${allow.join(',')}] (allowed for now; enforcement pending)`);
        }
      } catch { /* advisory only — never block a delegation on this check */ }

      console.log(`[Delegation] QUOX → ${input.agent_id} (depth ${depth}): ${input.task.substring(0, 80)}`);

      // HITL-CONTEXT (owner 2026-10-07): record the delegation edge on this
      // conversation so an approval the specialist triggers names the chain
      // (e.g. QUOX → NOVA) and the brief it was given. Display-only.
      try {
        require('./approvalTurnContext.js').noteDelegation(ctx.session_id || ctx.conversationId, {
          orgId: ctx.orgId, from: parentId || 'quox', to: targetId, task: input.task,
        });
      } catch { /* context is best-effort */ }

      // COMMANDERQ P7 tenant context + Z2H-R4 provider inheritance: see lib/delegationBody.js
      const buildBody = (agentId) => require('./delegationBody.js').buildDelegationBody(input, ctx, agentId, depth);

      const callAgent = async (agentId, signal) => {
        const resp = await localApiFetch(`/chat/claude`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: buildBody(agentId),
          signal
        }, { assertOk: false });
        let result = {};
        try { result = await resp.json(); } catch (_) { result = {}; }
        // QUOXON-REVIEW: a failed specialist (500 {error:'internal_error'}, no
        // success field) must surface as a failed tool, not a green "ok".
        // needs_approval is still carried (QUOXHAT MISSION D2): the orchestrator
        // re-surfaces a delegated action's pending approval from it.
        return require('./delegateResult').normalizeDelegateResponse(resp, result);
      };

      // QUOXON-Z2H: unless the caller set a budget, size the deadline to the provider the target
      // agent runs on (a local Ollama turn on CPU takes 60-160 s; cloud keeps 90 s).
      const callerDeadline = Number(input.deadline_ms) > 0 ? Number(input.deadline_ms) : null;
      let deadlineMs = callerDeadline;
      let deadlineNote = null;
      if (!callerDeadline) {
        const dl = await require('./delegationContract.js').resolveDelegateDeadline({ orgId: ctx.orgId, agentId: input.agent_id });
        deadlineMs = dl.ms;
        if (dl.local) deadlineNote = 'a local model on CPU can be slow; raise QUOX_OLLAMA_TURN_TIMEOUT_MS or use a smaller model';
      }
      const rerouteMs = deadlineMs;
      // COMMANDERQ P6: run the delegation under a latency contract (deadline +
      // degrade path + breaker) instead of the old fixed 90s abort with no fallback.
      const outcome = await runWithContract(
        { deadline_ms: deadlineMs, degrade_path: input.degrade_path, reroute_to: input.reroute_to, target: input.agent_id, deadline_note: deadlineNote, breaker_key: `agent:${input.agent_id}` },
        (signal) => callAgent(input.agent_id, signal),
        { breaker: _delegationBreaker, rerouteFn: (target) => callAgent(target, AbortSignal.timeout(rerouteMs)) }
      );

      console.log(`[Delegation] ${input.agent_id} → QUOX: ${outcome.action_taken} (${outcome.elapsed_ms}ms)${outcome.breached ? ' [SLA breached]' : ''}`);

      // Evidence: emit a SIGNED routing_verdict artifact (best-effort, fire-and-
      // forget so it never adds latency to the delegation the contract is keeping fast).
      try {
        const rvBody = {
          body: {
            task_class: normalizeTaskClass(input.task_class),
            chosen_agent: outcome.rerouted_to || input.agent_id,
            candidates: [{ agent: input.agent_id, score: null, reason: String(input.task).slice(0, 120) }],
            rationale: `Delegated: ${String(input.task).slice(0, 200)}`,
            latency_budget_ms: rerouteMs,
            outcome: { breached: !!outcome.breached, action_taken: outcome.action_taken, elapsed_ms: outcome.elapsed_ms, cost_breached: !!outcome.cost_breached, rerouted_to: outcome.rerouted_to || null },
          },
          session_id: ctx.session_id || undefined,
        };
        localApiFetch('/api/v1/artifacts/routing_verdict', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(ctx.orgId ? { 'x-org-id': ctx.orgId } : {}) },
          body: JSON.stringify(rvBody),
        }, { assertOk: false }).catch(() => {});
      } catch (_) { /* evidence is best-effort */ }

      const delegation = { breached: !!outcome.breached, action_taken: outcome.action_taken, elapsed_ms: outcome.elapsed_ms, ...(outcome.cost_breached ? { cost_breached: true } : {}) };

      // QUOXHAT MISSION D2 — re-surface a delegated specialist's pending approval
      // onto THIS tool result so the orchestrator's needs_approval extractor
      // (extractPendingApproval, run over the orchestrator's own toolExecutions =
      // [delegate_to_agent]) finds the SUB-AGENT's approval_id. Without this a
      // phone approval for any DELEGATED action is undetectable.
      const { pendingApprovalResultFields } = require('./voiceApproval');

      if (outcome.action_taken === 'completed' || outcome.action_taken === 'completed_over_budget') {
        const r = outcome.result || {};
        return { success: r.success, ...(r.error ? { error: `Delegation to ${input.agent_id} failed: ${r.error}` } : {}), agent: input.agent_id, response: r.response, tools_used: r.tools_used || [], delegation, ...pendingApprovalResultFields(r.needs_approval) };
      }
      if (outcome.action_taken === 'rerouted' || outcome.action_taken === 'rerouted_breaker_open') {
        const r = outcome.result || {};
        return { success: r.success !== false, agent: outcome.rerouted_to, response: r.response || 'Rerouted to a fallback specialist.', tools_used: r.tools_used || [], delegation: { ...delegation, rerouted_from: input.agent_id, rerouted_to: outcome.rerouted_to }, ...pendingApprovalResultFields(r.needs_approval) };
      }
      if (outcome.action_taken === 'execute_error') {
        return { success: false, error: `Delegation to ${input.agent_id} failed: ${outcome.error}`, delegation };
      }
      // degraded / cancelled / breaker_open_degraded — graceful, no hang.
      return { success: false, agent: input.agent_id, response: (outcome.degraded && outcome.degraded.message) || 'Delegation did not complete in time.', degraded: true, delegation };
    }
  },

  // ==========================================================================
  // QUOXHAT P4 — progressive-disclosure tools. The hat's initial manifest is
  // deliberately small; these are how an agent SEES the depth it can reach
  // (deterministic catalogue — works with no embeddings/Qdrant, study §8)
  // and loads a bounded bundle into the conversation. Server-side state,
  // audited; new tools activate at the next model-request boundary.
  // ==========================================================================

  hat_catalogue: {
    name: 'hat_catalogue',
    description: 'Show the active hat (mode), its tools and capability bundles with their loaded state, and the other hats available for this conversation with the tool names each one carries. Use when a task seems to need a tool you do not currently hold (pass its name as `tool` to see where it lives): a bundle on this hat can be loaded with hat_load_bundle, and a different hat can be proposed with hat_propose_switch. Tool names are hat membership, not permission; read-only.',
    // QUOXHAT #725 slice 1: optional tool lookup. Read-only: the auth route only
    // reads hat definitions; switching still goes through hat_propose_switch.
    input_schema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Optional tool name to locate (e.g. "brain_save"): reports whether it is on the active hat (explicit or which bundle) and which other hats carry it' },
      },
    },
    execute: async (input, ctx) => {
      // Tenant hard line: an org-less turn must get a visible refusal, never
      // the 'default' org's catalogue (E2E 2026-10-01: the OpenAI fallback
      // leg ran tools org-less and this tool silently served org 'default').
      if (!ctx.orgId) return { success: false, error: 'No organization context on this turn — cannot read the hat catalogue' };
      try {
        const authBase = process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101';
        const qs = new URLSearchParams();
        if (ctx.userId) qs.set('user_id', ctx.userId);
        const convId = ctx.conversationId || ctx.session_id;
        if (convId) qs.set('conversation_id', convId);
        if (typeof input?.tool === 'string' && input.tool.trim()) qs.set('tool', input.tool.trim().slice(0, 128));
        const resp = await fetch(`${authBase}/api/internal/orgs/${encodeURIComponent(ctx.orgId)}/quoxhat/catalogue?${qs}`, {
          headers: { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '' },
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return { success: false, error: `catalogue unavailable (HTTP ${resp.status})` };
        const body = await resp.json();
        return { success: true, ...body };
      } catch (err) {
        return { success: false, error: `catalogue unavailable: ${err.message}` };
      }
    }
  },

  hat_load_bundle: {
    name: 'hat_load_bundle',
    description: 'Load one of the active hat\'s capability bundles into this conversation (see hat_catalogue for bundle keys). The bundle\'s tools become available from the NEXT turn; finish this reply, then use them. Loading is recorded server-side and audited.',
    input_schema: {
      type: 'object',
      properties: {
        bundle: { type: 'string', description: 'Bundle key from hat_catalogue (e.g. "diagnose", "publish")' },
      },
      required: ['bundle']
    },
    execute: async (input, ctx) => {
      const convId = ctx.conversationId || ctx.session_id;
      if (!convId) return { success: false, error: 'no conversation id on this turn; bundle loading needs a session' };
      if (!ctx.orgId) return { success: false, error: 'No organization context on this turn — cannot load a bundle' };
      try {
        const authBase = process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101';
        const resp = await fetch(`${authBase}/api/internal/orgs/${encodeURIComponent(ctx.orgId)}/quoxhat/bindings/${encodeURIComponent(convId)}/load-bundle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '' },
          body: JSON.stringify({ bundle_key: input.bundle, user_id: ctx.userId || null }),
          signal: AbortSignal.timeout(5000),
        });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          return { success: false, error: body?.validation_errors?.join('; ') || `load failed (HTTP ${resp.status})`, available: body?.available };
        }
        return {
          success: true,
          ...body,
          note: 'Bundle loaded. Its tools become available from the next turn; tell the user and continue then.',
        };
      } catch (err) {
        return { success: false, error: `load failed: ${err.message}` };
      }
    }
  },

  hat_propose_switch: {
    name: 'hat_propose_switch',
    description: 'Propose switching this conversation to a different hat (mode) — e.g. "Shall I put my security hat on?". The proposal goes to the HITL inbox for a human decision; you NEVER switch yourself. Use hat_catalogue first to see available hats. The approval card appears right in the terminal the user is typing in (and in the dashboard inbox); approving it applies the switch. Privileged hats (e.g. NSOC) always require explicit human confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        hat: { type: 'string', description: 'Target hat key from hat_catalogue (e.g. "nsoc", "devops")' },
        reason: { type: 'string', description: 'One or two sentences: why this task needs that hat' },
      },
      required: ['hat', 'reason']
    },
    execute: async (input, ctx) => {
      try {
        const authBase = process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101';
        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const orgId = ctx?.orgId;
        if (!orgId) return { success: false, error: 'No organization context' };
        const convId = ctx.conversationId || ctx.session_id || null;

        // Validate the target against the caller's real catalogue — a
        // proposal for a hat the user cannot see is a visible error here,
        // never a dangling inbox item.
        const qs = new URLSearchParams();
        if (ctx.userId) qs.set('user_id', ctx.userId);
        if (convId) qs.set('conversation_id', convId);
        const catResp = await fetch(`${authBase}/api/internal/orgs/${encodeURIComponent(orgId)}/quoxhat/catalogue?${qs}`, {
          headers: { 'X-Service-Key': serviceKey },
          signal: AbortSignal.timeout(5000),
        });
        if (!catResp.ok) return { success: false, error: `hat catalogue unavailable (HTTP ${catResp.status})` };
        const cat = await catResp.json();
        const target = (cat.other_hats || []).find(h => h.key === input.hat)
          || (cat.active?.key === input.hat ? cat.active : null);
        if (!target) {
          return { success: false, error: `no hat '${input.hat}' available to this conversation`, available: (cat.other_hats || []).map(h => h.key) };
        }
        if (cat.active?.key === input.hat) {
          return { success: true, already_active: true, message: `Hat '${input.hat}' is already active.` };
        }

        const privileged = target.privileged === true;
        const res = await fetch(`${authBase}/api/internal/orgs/${orgId}/inbox`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}) },
          body: JSON.stringify({
            title: `Hat switch proposed: ${cat.active?.name || 'current'} → ${target.name}${privileged ? ' (privileged)' : ''}`,
            body_md: `Agent **${ctx?.agentId || 'quox'}** proposes switching this conversation to the **${target.name}** hat.\n\n**Reason:** ${input.reason}\n\n**Target purpose:** ${target.purpose}\n${privileged ? '\n⚠ This is a PRIVILEGED hat: confirm deliberately.\n' : ''}\nApprove or deny here, in the terminal, or in the dashboard. Conversation: \`${convId || 'n/a'}\`.`,
            kind: 'approval',
            priority: privileged ? 'high' : 'normal',
            aee_correlation_id: convId,
            payload: {
              // Describable card for the CLI and dashboard: tool + target + risk, so it gets a normal approve/deny.
              approval_context: {
                method: { tool: 'hat.switch', target: `${cat.active?.name || 'current'} → ${target.name}${privileged ? ' (privileged)' : ''}` },
                risk: privileged ? 'high' : 'medium',
                on_behalf_of: { ...(ctx?.userId ? { user_id: ctx.userId } : {}), conversation_id: convId },
              },
              source: 'agent',
              source_agent: ctx?.agentId || 'quox',
              type: 'quoxhat_switch_proposal',
              target_hat: input.hat,
              privileged,
              conversation_id: convId,
            },
          }),
        });
        const text = await res.text();
        if (!res.ok) return { success: false, error: `inbox API returned ${res.status}: ${text.slice(0, 200)}` };
        let data; try { data = JSON.parse(text); } catch { data = {}; }
        return {
          success: true,
          item_id: data.id || data.item_id,
          proposed: input.hat,
          privileged,
          note: 'Proposal filed. The approval card appears right here in the terminal (and in the dashboard inbox); tell them to approve it there. Approving applies the switch; do not assume the new hat until the next turn shows it active.',
        };
      } catch (err) {
        return { success: false, error: `proposal failed: ${err.message}` };
      }
    }
  },

  // ==========================================================================
  // Memory Tools — available to all agents
  // ==========================================================================

  memory_save: {
    name: 'memory_save',
    description: 'Save important information for future recall. Use when the user shares facts, preferences, decisions, or constraints worth remembering across sessions.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['fact', 'preference', 'decision', 'constraint', 'observation'],
          description: 'Category: fact (infrastructure), preference (likes/dislikes), decision (past choices), constraint (rules/limits), observation (patterns)'
        },
        content: {
          type: 'string',
          description: 'What to remember. Be specific and searchable. Include key identifiers (hostnames, IPs, names).'
        },
        importance: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'How important: critical=always relevant, high=often needed, medium=occasional, low=nice to have'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for retrieval (e.g. ["infrastructure", "docker", "production"])'
        }
      },
      required: ['type', 'content']
    },
    execute: async (input, ctx) => {
      return await handleMemoryTool('memory_save', input, {
        agentId: ctx.agentId || 'quox',
        userId: ctx.userId,
        orgId: ctx.orgId,
        conversationId: ctx.conversationId,
        token: ctx.token || null
      });
    }
  },

  memory_search: {
    name: 'memory_search',
    description: 'Search past memories for relevant context. Use before answering questions that might benefit from historical knowledge about infrastructure, past decisions, or user preferences.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for. Use natural language or keywords.'
        },
        type_filter: {
          type: 'string',
          enum: ['fact', 'preference', 'decision', 'constraint', 'observation', 'all'],
          description: 'Optionally filter by memory type'
        },
        limit: {
          type: 'integer',
          description: 'Maximum results to return (default 5, max 20)'
        }
      },
      required: ['query']
    },
    execute: async (input, ctx) => {
      return await handleMemoryTool('memory_search', input, {
        agentId: ctx.agentId || 'quox',
        userId: ctx.userId,
        orgId: ctx.orgId,
        token: ctx.token || null,
        // Verified attach claims (CX1 F9: attached Cortex reads the holder's memories).
        attachLeaseId: ctx.attachLeaseId || null,
        holderUserId: ctx.holderUserId || null,
      });
    }
  },

  // QSKL-CHAT-BRIDGE.1: Quox Skills catalog discovery
  skills_list: {
    name: 'skills_list',
    description: 'List Quox skills available to the current org. Filters: category, edition, agentId (best_for_agents tag), tag, limit. Returns up to 50 items by default, each with id, name, category, description, version, edition, bestForAgents.',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Filter by category (ops/health, security, github, compliance, infra, data, communication, workflow, browser/automation, memory/operations, voice/operations, observability/trace, other)'
        },
        edition: {
          type: 'string',
          enum: ['experimental', 'beta', 'stable', 'deprecated', 'archived'],
          description: 'Filter by edition lifecycle stage'
        },
        agentId: {
          type: 'string',
          description: 'Filter to skills tagged for this agent id (e.g. sentinel, cipher)'
        },
        tag: {
          type: 'string',
          description: 'Filter to skills containing this tag'
        },
        limit: {
          type: 'number',
          description: 'Max results (default 50, capped at 50 for context budget)'
        }
      },
      required: []
    },
    execute: async (input, ctx) => {
      try {
        const limit = Math.min(Math.max(1, Number(input.limit ?? 50)), 50);
        const params = new URLSearchParams();
        if (input.category) params.set('category', input.category);
        if (input.edition) params.set('edition', input.edition);
        if (input.agentId) params.set('agentId', input.agentId);
        if (input.tag) params.set('tag', input.tag);
        // #818: QuoxFlow's list returns no total, and the page length used to be reported
        // as the total ("five skills in total" when the library held 63). Fetch the whole
        // filtered library (bounded) and page it here, so `total` is the real size.
        const SKILLS_TOTAL_CAP = 500;
        params.set('limit', String(SKILLS_TOTAL_CAP));
        if (ctx?.orgId) params.set('orgId', ctx.orgId);

        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const url = `${QUOXFLOW_URL}/api/quox-skills?${params}`;
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          }
        });

        if (!res.ok) {
          return { success: false, error: `QuoxFlow returned ${res.status}: ${await res.text()}` };
        }

        const body = await res.json();
        const allSkills = body.data || body.skills || [];
        const rawSkills = allSkills.slice(0, limit);
        const skills = rawSkills.map(s => ({
          id: s.id,
          name: s.name,
          category: s.category,
          version: s.version,
          edition: s.edition,
          description: s.description,
          bestForAgents: s.bestForAgents || s.best_for_agents || []
        }));

        // AOCL envelope emission — optional, only when ctx provides the hook
        if (ctx?.emitEnvelope) {
          await ctx.emitEnvelope({
            intent: 'skill.list',
            payload: {
              filters: input,
              count: skills.length,
              agentId: ctx.agentId || null
            }
          });
        }

        const total = body.meta?.total ?? allSkills.length;
        return {
          success: true,
          count: skills.length,
          total,
          // false only when the library is larger than the fetch cap: then total is a floor.
          total_exact: body.meta?.total != null || allSkills.length < SKILLS_TOTAL_CAP,
          has_more: total > skills.length,
          ...(total > skills.length ? { note: `Showing ${skills.length} of ${total} skills; this is a page, not the whole library.` } : {}),
          skills
        };
      } catch (err) {
        return { success: false, error: `Failed to list skills: ${err.message}` };
      }
    }
  },

  // QSKL-CHAT-BRIDGE.2: Full skill body viewer — agents get the complete markdown to mentally execute a skill
  skill_view: {
    name: 'skill_view',
    description: 'Fetch the full body of a Quox skill by id or name. Returns the complete markdown including When to apply, Inputs, Steps, Outputs, and Failure modes. Use when you need to actually read or execute a skill.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Skill ULID — use when you already know the exact id (e.g. from skills_list results)'
        },
        name: {
          type: 'string',
          description: 'Skill slug name (e.g. "ssl-audit") — resolved via name-match against org skill list when id is not available'
        }
      },
      required: []
    },
    execute: async (input, ctx) => {
      if (!input.id && !input.name) {
        throw new Error('skill_view requires either id or name');
      }

      const FLOW_URL = process.env.QUOXFLOW_URL || 'http://quoxflow:3200';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
      const authHeaders = {
        'Content-Type': 'application/json',
        ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
        ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
        ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
      };

      try {
        let skillIdOrName = input.id;

        if (!skillIdOrName && input.name) {
          // Name resolution via list endpoint (unchanged — list is a read, not an invocation)
          const orgParam = ctx?.orgId ? `&orgId=${encodeURIComponent(ctx.orgId)}` : '';
          const listUrl = `${FLOW_URL}/api/quox-skills?limit=100${orgParam}`;
          const listRes = await fetch(listUrl, { headers: authHeaders });
          const listBody = await listRes.json();
          const skills = listBody.data || listBody.skills || [];
          const match = skills.find(s => s.name === input.name);
          if (!match) return { success: false, error: `skill_not_found: no skill named '${input.name}'` };
          // Use the resolved ID so the agentic route can do a direct findById
          skillIdOrName = match.id;
        }

        // QSKL-7-CHAT-FIX: POST to the agentic route so skillViewHandler writes
        // a typed row to quox_skill_invocations (visible to AGENT-HONESTY).
        // The bare GET /api/quox-skills/:id is left intact for dashboard read-only browsing.
        const agenticUrl = `${FLOW_URL}/api/agentic/skill-actions/skill-view`;
        const agenticBody = JSON.stringify({
          skill_id_or_name: skillIdOrName,
          agent_id: ctx?.agentId ?? ctx?.invokedBy ?? 'chat:unknown',
          session_id: ctx?.correlationId ?? ctx?.sessionId ?? null,
        });

        const res = await fetch(agenticUrl, {
          method: 'POST',
          headers: authHeaders,
          body: agenticBody,
        });

        if (res.status === 404) return { success: false, error: `skill_not_found: '${skillIdOrName}' (404)` };

        const responseBody = await res.json().catch(() => null);

        // Handle the error envelope explicitly instead of passing it through as
        // if it were a skill record — skillViewHandler returns
        // { success:false, error } on failure, and `error` may be a non-string.
        // (tooling audit: skill_view "broken" was this envelope reaching the
        // dispatcher, which then crashed on errDetail.substring.)
        if (!responseBody || !res.ok || responseBody.success === false) {
          const e = responseBody && responseBody.error;
          const msg = typeof e === 'string' ? e : (e && e.message) || (e ? JSON.stringify(e) : `skill-view failed (HTTP ${res.status})`);
          return { success: false, error: msg };
        }

        // skillViewHandler returns { success, data, envelopeShape }
        // Extract the skill record from .data (falls back to bare body for compat)
        const skill = responseBody.data || responseBody;

        // Keep the existing shallow envelope emit — it's a complementary audit signal,
        // distinct from the typed invocation row written by skillViewHandler.
        if (ctx?.emitEnvelope && skill?.id) {
          await ctx.emitEnvelope({
            intent: 'skill.view',
            payload: {
              skill_id: skill.id,
              skill_name: skill.name,
              agent_id: ctx.agentId || null
            }
          });
        }

        return skill;
      } catch (err) {
        return { success: false, error: `Failed to view skill: ${err.message}` };
      }
    }
  },

  // QSKL-CHAT-BRIDGE.2: Chat-authored skill creation — always lands in pending-review (experimental) lane
  skill_manage: {
    name: 'skill_manage',
    description: 'Manage Quox skills from chat. Currently supports op="create" only. Created skills land in edition="experimental" and are queued for human review; they cannot be loaded or run until a person approves them. Report the returned message to the user as is.',
    input_schema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['create'],
          description: 'Operation to perform. Only "create" is supported in chat.'
        },
        name: {
          type: 'string',
          description: 'Skill slug name (lowercase, hyphens). Must be unique within the org.'
        },
        category: {
          type: 'string',
          description: 'Skill category (security, compliance, infra, data, github, communication, workflow, other)'
        },
        description: {
          type: 'string',
          description: 'Short one-sentence description of what the skill does'
        },
        bodyMd: {
          type: 'string',
          description: 'Full markdown body. Must include ## When to apply, ## Steps, ## Outputs sections.'
        },
        best_for_agents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Agent ids best suited to execute this skill'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Searchable tags for this skill'
        },
        required_tools: {
          type: 'array',
          description: 'Tool ids required to execute this skill'
        },
        license: {
          type: 'string',
          description: 'SkillRights licence identifier (skillrights.org), e.g. LicenseRef-SkillRights-NoTrain-1.0. Recorded verbatim. Omit to use the org default licence setting, or stay undeclared when none is configured.'
        }
      },
      required: ['op', 'name', 'category', 'description', 'bodyMd']
    },
    execute: async (input, ctx) => {
      // Only create is implemented in this slice
      if (input.op !== 'create') {
        return {
          error: 'not_implemented',
          message: `skill_manage op '${input.op}' is not supported in chat. Use the /skills UI or QuoxFlow agentic executor.`
        };
      }

      // Validation
      if (!input.name || !input.bodyMd || !input.category || !input.description) {
        return {
          error: 'validation_failed',
          message: 'skill_manage(create) requires name, category, description, bodyMd'
        };
      }

      if (!ctx?.orgId) {
        return {
          error: 'unauthorised',
          message: 'skill_manage(create) requires an org context'
        };
      }

      // QLoop self-extension: a skill written by the loop agent carries its own
      // provenance so review can tell hand-authored from self-authored work, and
      // trace a self-authored skill back to the loop session that produced it.
      // The session id arrives on the tool-execute request body (quoxmcp sends
      // session_id; the chat paths use sessionId), so accept either shape.
      const callerTags = Array.isArray(input.tags) ? input.tags : [];
      let tags = callerTags;
      if (ctx.agentId === 'qloop') {
        const loopSessionId = ctx.session_id || ctx.sessionId || null;
        tags = [
          ...callerTags,
          'self-authored',
          ...(loopSessionId ? [`loop-session:${loopSessionId}`] : [])
        ];
        tags = [...new Set(tags)];
      }

      // CHAT-AUTHORED SKILLS ALWAYS LAND IN PENDING-REVIEW LANE (edition forced
      // inside createPendingSkill); licence stamping lives there too.
      const created = await createPendingSkill(ctx, {
        name: input.name,
        category: input.category,
        description: input.description,
        bodyMd: input.bodyMd,
        tags,
        bestForAgents: input.best_for_agents,
        requiredTools: input.required_tools,
        license: input.license,
        requireHumanReview: true,
        reviewSource: 'chat'
      });
      if (!created.ok) {
        return { error: created.error, message: created.message };
      }

      try {
        const skill = created.skill;

        if (ctx?.emitEnvelope) {
          await ctx.emitEnvelope({
            intent: 'skill.manage.create',
            payload: {
              skill_id: skill.id,
              skill_name: skill.name,
              edition: skill.edition,
              body_md_length: input.bodyMd.length,
              agent_id: ctx.agentId || null
            }
          });
        }

        // quox#748: say only what is true about the review state.
        const review = skill.review?.status || 'unknown';
        return {
          id: skill.id,
          name: skill.name,
          edition: skill.edition,
          category: skill.category,
          version: skill.version,
          review,
          message: review === 'pending_human_review'
            ? `Created "${skill.name}" as experimental and queued for human review. It cannot run until a person approves it (quox skills review list).`
            : `Created "${skill.name}" as experimental. It was NOT queued for human review (${review}); tell the user before relying on it.`
        };
      } catch (err) {
        return { error: 'create_failed', message: `Failed to create skill: ${err.message}` };
      }
    }
  },

  // QSKL-13: Session history FTS search — search past agentic session envelopes
  session_search: {
    name: 'session_search',
    description: 'Search past agentic session history using full-text search over envelope payloads (objectives, messages, reasoning, outputs, observations). Returns matched sessions ordered by relevance then recency. Use to recall what was done in a previous session or to find prior work on a topic.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Full-text search query (supports phrases and AND/OR/NOT operators via websearch syntax, e.g. "docker health" or "nginx -ssl")'
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10, max 50)'
        }
      },
      required: ['query']
    },
    execute: async (input, ctx) => {
      if (!input.query || !input.query.trim()) {
        return { ok: false, error_code: 'EMPTY_QUERY', reason: 'session_search requires a non-empty query string' };
      }

      const limit = Math.min(Math.max(1, Number(input.limit ?? 10)), 50);
      const FLOW_URL = process.env.QUOXFLOW_URL || 'http://quoxflow:3200';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';

      try {
        const params = new URLSearchParams();
        params.set('query', input.query.trim());
        params.set('limit', String(limit));
        // orgId is passed as X-Org-ID header, not a URL query param, to prevent
        // it being logged in access logs or overridden by unauthenticated callers.

        const res = await fetch(`${FLOW_URL}/api/session-search?${params}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            ...(ctx?.orgId ? { 'X-Org-ID': ctx.orgId } : {})
          }
        });

        if (!res.ok) {
          return { ok: false, error_code: 'SEARCH_ERROR', reason: `QuoxFlow returned ${res.status}` };
        }

        const body = await res.json();

        if (ctx?.emitEnvelope) {
          await ctx.emitEnvelope({
            intent: 'session.search',
            payload: {
              query: input.query,
              count: body.count ?? 0,
              agent_id: ctx.agentId || null
            }
          });
        }

        return body;
      } catch (err) {
        return { ok: false, error_code: 'SEARCH_ERROR', reason: `Failed to search sessions: ${err.message}` };
      }
    }
  },

  memory_update: {
    name: 'memory_update',
    description: 'Update or correct an existing memory with new information. Use when information has changed or was recorded incorrectly.',
    input_schema: {
      type: 'object',
      properties: {
        memory_id: {
          type: 'string',
          description: 'ID of the memory to update (from a previous search result)'
        },
        new_content: {
          type: 'string',
          description: 'The corrected or updated content'
        },
        reason: {
          type: 'string',
          description: 'Why this memory is being updated (for audit trail)'
        }
      },
      required: ['memory_id', 'new_content', 'reason']
    },
    execute: async (input, ctx) => {
      return await handleMemoryTool('memory_update', input, {
        agentId: ctx.agentId || 'quox',
        userId: ctx.userId,
        orgId: ctx.orgId,
        token: ctx.token || null
      });
    }
  },

  memory_forget: {
    name: 'memory_forget',
    description: 'Forget one of the user\'s own memories when they ask you to. This is a soft delete (the memory stops being recalled) unless the user asks for it to be gone for good, in which case set permanent to true. Only use a memoryId from a previous search or recall result.',
    input_schema: {
      type: 'object',
      properties: {
        memoryId: {
          type: 'string',
          description: 'ID of the memory to forget (from a previous search or recall result)'
        },
        permanent: {
          type: 'boolean',
          description: 'Erase it permanently rather than soft delete. Only when the user explicitly asks for it to be gone for good. Defaults to false.'
        },
        reason: {
          type: 'string',
          description: 'Optional: why the user asked for it to be forgotten'
        }
      },
      required: ['memoryId']
    },
    execute: async (input, ctx) => {
      return await handleMemoryTool('memory_forget', input, {
        agentId: ctx.agentId || 'quox',
        userId: ctx.userId,
        orgId: ctx.orgId,
        token: ctx.token || null
      });
    }
  },

  entity_note: {
    name: 'entity_note',
    description: 'Record information about a system, person, or concept. Use when learning about infrastructure components, team members, or important concepts.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Entity name (e.g. "docker01", "nginx", "Adam", "production-cluster")'
        },
        entity_type: {
          type: 'string',
          enum: ['host', 'service', 'person', 'network', 'container', 'concept', 'file'],
          description: 'What kind of entity this is'
        },
        attributes: {
          type: 'object',
          description: 'Key-value attributes (e.g. {role: "docker host", os: "ubuntu"})'
        },
        relates_to: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              relation: { type: 'string', enum: ['runs_on', 'hosts', 'depends_on', 'manages', 'monitors', 'uses', 'owns'] }
            }
          },
          description: 'Optional relationships to other entities'
        }
      },
      required: ['name', 'entity_type']
    },
    execute: async (input, ctx) => {
      return await handleMemoryTool('entity_note', input, {
        agentId: ctx.agentId || 'quox',
        userId: ctx.userId,
        orgId: ctx.orgId,
        token: ctx.token || null
      });
    }
  },

  // ==========================================================================
  // Action Tracker Tools — manage the user's Kanban board
  // ==========================================================================

  action_add: {
    name: 'action_add',
    description: 'Add a new action item to the user\'s Action Tracker board. Creates it in TODO status. Use when the user says "add to my tracker", "create a task", or similar.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The action item title. Keep it clear and actionable.'
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'urgent'],
          description: 'Priority level. Default medium if not specified.'
        },
        category: {
          type: 'string',
          description: 'Category tag (e.g., "legal", "financial", "technical")'
        },
        dueDate: {
          type: 'string',
          description: 'Due date in YYYY-MM-DD format (optional)'
        },
        description: {
          type: 'string',
          description: 'Longer description or notes (optional)'
        }
      },
      required: ['title']
    },
    execute: async (input, ctx) => {
      return await handleActionTool('action_add', input, {
        agentId: ctx.agentId || 'quox',
        userId: ctx.userId,
        orgId: ctx.orgId,
        token: ctx.token || null
      });
    }
  },

  action_list: {
    name: 'action_list',
    description: 'List action items from the user\'s Action Tracker. Filter by status column (todo/doing/done/all).',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['todo', 'doing', 'done', 'all'],
          description: 'Filter by status. Default "all".'
        },
        limit: {
          type: 'integer',
          description: 'Maximum items to return (default 20, max 100)'
        }
      },
      required: []
    },
    execute: async (input, ctx) => {
      return await handleActionTool('action_list', input, {
        agentId: ctx.agentId || 'quox',
        userId: ctx.userId,
        orgId: ctx.orgId,
        token: ctx.token || null
      });
    }
  },

  action_move: {
    name: 'action_move',
    description: 'Move an action item to a different status column (todo/doing/done). Use action_list first to find the item ID.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The action item ID'
        },
        status: {
          type: 'string',
          enum: ['todo', 'doing', 'done'],
          description: 'Target status column'
        }
      },
      required: ['id', 'status']
    },
    execute: async (input, ctx) => {
      return await handleActionTool('action_move', input, {
        agentId: ctx.agentId || 'quox',
        userId: ctx.userId,
        orgId: ctx.orgId,
        token: ctx.token || null
      });
    }
  },

  action_update: {
    name: 'action_update',
    description: 'Update fields on an existing action item (title, description, priority, category, dueDate).',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The action item ID'
        },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'urgent'],
          description: 'New priority'
        },
        category: { type: 'string', description: 'New category' },
        dueDate: { type: 'string', description: 'New due date (YYYY-MM-DD)' }
      },
      required: ['id']
    },
    execute: async (input, ctx) => {
      return await handleActionTool('action_update', input, {
        agentId: ctx.agentId || 'quox',
        userId: ctx.userId,
        orgId: ctx.orgId,
        token: ctx.token || null
      });
    }
  },

  action_delete: {
    name: 'action_delete',
    description: 'Permanently delete an action item. Confirm with the user before deleting.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The action item ID to delete'
        }
      },
      required: ['id']
    },
    execute: async (input, ctx) => {
      return await handleActionTool('action_delete', input, {
        agentId: ctx.agentId || 'quox',
        userId: ctx.userId,
        orgId: ctx.orgId,
        token: ctx.token || null
      });
    }
  },

  // ==========================================================================
  // Gemini CLI Tools (review-and-synthesis agent)
  // ==========================================================================

  gemini_review: {
    name: 'gemini_review',
    description: 'Review code using Google Gemini AI for a second-perspective analysis. Identifies bugs, security issues, performance problems, and readability improvements. Useful for independent code review from a different AI model.',
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The code to review'
        },
        language: {
          type: 'string',
          description: 'Programming language (e.g. javascript, python, go, rust)'
        },
        context: {
          type: 'string',
          description: 'Additional context about the code (what it does, where it lives, recent changes)'
        },
        focus: {
          type: 'string',
          description: 'Specific areas to focus on (e.g. "security", "performance", "error handling"). Default: bugs, security, performance, readability'
        }
      },
      required: ['code']
    },
    execute: async (input, ctx) => {
      return await geminiReview(input, ctx);
    }
  },

  gemini_analyze: {
    name: 'gemini_analyze',
    description: 'Analyze large content (logs, configs, documents, data) using Gemini\'s 1M token context window. Ask specific questions about the content. Good for log analysis, config review, documentation synthesis.',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The content to analyze (logs, config, docs, data — up to 100K chars)'
        },
        question: {
          type: 'string',
          description: 'What you want to know about the content'
        },
        format: {
          type: 'string',
          description: 'Desired response format (e.g. "markdown", "json", "bullet points")'
        }
      },
      required: ['content', 'question']
    },
    execute: async (input, ctx) => {
      return await geminiAnalyze(input, ctx);
    }
  },

  gemini_generate: {
    name: 'gemini_generate',
    // QUOXTRUST MF-2(b) TODO (v1.2 follow-up, left UNWIRED — see the
    // trust-proof-self-audit report for this stream): this is a spend-money
    // tool (real pay-per-use Gemini API cost per call) with no per-org
    // cost-budget/quota/spend-rate mechanism anywhere in the choke (checked:
    // no budget/quota/spend-cap gate exists for native tools — connector
    // bridge.js's _checkRateLimit is a CALL-FREQUENCY limiter for connector
    // tools only, not a cost ceiling, and does not apply to this native
    // tool). Do NOT build a bespoke budget subsystem here; wire this (and
    // perplexity_research below) into a real org cost-budget gate once one
    // exists in the choke.
    description: 'Generate content using Google Gemini AI. Creates documentation, reports, emails, summaries, or other text content. Provides a different perspective from Claude for content creation tasks.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'What to generate (e.g. "Write a technical summary of...", "Draft an incident report for...")'
        },
        context: {
          type: 'string',
          description: 'Background context for the generation task'
        },
        tone: {
          type: 'string',
          description: 'Desired tone (e.g. "professional", "casual", "technical", "executive summary")'
        },
        format: {
          type: 'string',
          description: 'Output format (e.g. "markdown", "email", "report", "bullet points")'
        },
        length: {
          type: 'string',
          description: 'Desired length (e.g. "brief", "detailed", "500 words")'
        }
      },
      required: ['task']
    },
    execute: async (input, ctx) => {
      return await geminiGenerate(input, ctx);
    }
  },

  // ==========================================================================
  // Perplexity API Tools (web research & verification agent)
  // ==========================================================================

  perplexity_search: {
    name: 'perplexity_search',
    description: 'Search the web using Perplexity Sonar AI with citations and source URLs. Returns current, well-sourced results with domain filtering and recency options. Use for finding up-to-date information, news, documentation, and web content.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query (e.g. "latest Docker release features", "current Kubernetes best practices")'
        },
        domain_filter: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict results to specific domains (e.g. ["docker.com", "github.com"])'
        },
        recency: {
          type: 'string',
          enum: ['hour', 'day', 'week', 'month'],
          description: 'Filter results by recency (hour, day, week, month)'
        }
      },
      required: ['query']
    },
    execute: async (input, ctx = {}) => {
      const apiKey = await resolvePerplexityApiKey(ctx.orgId);
      return await perplexitySearch(input, apiKey);
    }
  },

  perplexity_research: {
    name: 'perplexity_research',
    // QUOXTRUST MF-2(b) TODO (v1.2 follow-up, left UNWIRED): spend-money tool,
    // same gap as gemini_generate above — no org cost-budget/quota/spend-rate
    // gate exists anywhere in the choke to wire this into. Not built here;
    // see gemini_generate's TODO for the full rationale.
    description: 'Perform deep multi-source research on a topic using Perplexity Sonar Pro. Searches comprehensively across web or academic sources. Use for thorough investigation, literature review, or technical deep-dives.',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The research topic (e.g. "quantum computing advances 2025", "WebAssembly security model")'
        },
        mode: {
          type: 'string',
          enum: ['web', 'academic'],
          description: 'Search mode: "web" for general sources, "academic" for scholarly papers and journals. Default: web'
        },
        depth: {
          type: 'string',
          enum: ['standard', 'deep'],
          description: 'Research depth: "standard" (sonar-pro) or "deep" (sonar-deep-research). Default: standard'
        },
        focus: {
          type: 'string',
          description: 'Specific focus area within the topic (e.g. "security implications", "performance benchmarks")'
        }
      },
      required: ['topic']
    },
    execute: async (input, ctx = {}) => {
      const apiKey = await resolvePerplexityApiKey(ctx.orgId);
      return await perplexityResearch(input, apiKey);
    }
  },

  perplexity_verify: {
    name: 'perplexity_verify',
    description: 'Fact-check a claim against current web sources using Perplexity Sonar Reasoning. Returns a verdict (TRUE/FALSE/PARTIALLY TRUE/UNVERIFIABLE) with confidence level and supporting evidence with citations.',
    input_schema: {
      type: 'object',
      properties: {
        claim: {
          type: 'string',
          description: 'The claim to fact-check (e.g. "PostgreSQL 17 supports MERGE statements")'
        },
        context: {
          type: 'string',
          description: 'Additional context about the claim (e.g. "From a 2024 blog post about database features")'
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Suggested source URLs to check against'
        }
      },
      required: ['claim']
    },
    execute: async (input, ctx = {}) => {
      const apiKey = await resolvePerplexityApiKey(ctx.orgId);
      return await perplexityVerify(input, apiKey);
    }
  },

  // ==========================================================================
  // KEEPER — System Continuity Tools (backup, restore, update, rollback)
  // Wraps auth service API endpoints for backup and update lifecycle
  // ==========================================================================

  keeper_backup_status: {
    name: 'keeper_backup_status',
    description: 'Get backup health summary: total backups, success/failure counts, last backup time, active schedules, and component coverage.',
    input_schema: { type: 'object', properties: {} },
    execute: async (input, ctx) => {
      return await keeperInternalBackupStatus(ctx?.orgId);
    }
  },

  keeper_backup_create: {
    name: 'keeper_backup_create',
    // QUOXTRUST C2/WP2: reaches outside the box — durable intent gated at the choke.
    externalEffect: true,
    // QUOXTRUST MF-2: gated INSIDE execute (withApprovalGate), same shape as
    // ssh_exec — the choke must not stamp dispatched before the gate decides.
    gatedInExecute: true,
    description: 'Create a new system backup. Supports full backup (all 21 components) or selective backup of specific components.',
    input_schema: {
      type: 'object',
      properties: {
        backup_type: { type: 'string', enum: ['full', 'selective'], description: 'Full system or selective backup (default: full)' },
        name: { type: 'string', description: 'Backup name/label (optional)' },
        description: { type: 'string', description: 'Backup description (optional)' },
        components: { type: 'array', items: { type: 'string' }, description: 'Component IDs to backup (only for selective type)' }
      }
    },
    execute: async (input, ctx) => {
      // QUOXTRUST MF-2: keeper_backup_create is in AGENT_ALWAYS_PROPOSE_TOOLS,
      // so this gate holds unconditionally — no org GOV-4 policy required.
      const _gateInput = {
        backup_type: input.backup_type || 'full',
        name: input.name,
        description: input.description,
        components: input.components,
        ...(input._approvalId ? { _approvalId: input._approvalId } : {}),
        ...(input._resumeToken ? { _resumeToken: input._resumeToken } : {}),
      };
      return await withApprovalGate('keeper_backup_create', _gateInput, async () => {
        // Internal service-key trigger route (CSRF-exempt); the org route
        // enforces CSRF a service-key caller can't satisfy. Same runBackupProcess
        // creation path. (Proven live 2026-08-08: org route returned 403.)
        return await keeperAuthFetch(`/internal/backups/trigger`, 'POST', {
          org_id: ctx?.orgId || 'default',
          backup_type: input.backup_type || 'full',
          name: input.name,
          description: input.description,
          components: input.components,
        });
      }, ctx);
    }
  },

  keeper_backup_list: {
    name: 'keeper_backup_list',
    description: 'List all backups with optional filtering by status (completed, failed, in_progress) and type (full, selective).',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['completed', 'failed', 'in_progress', 'verified'], description: 'Filter by status' },
        limit: { type: 'number', description: 'Max results (default 20)' }
      }
    },
    execute: async (input, ctx) => {
      // AGENT-OVERHAUL phase 7: the /orgs/:orgId route needs a browser JWT the
      // KEEPER agent has no way to present (401'd live). Route through the
      // service-key /internal mirror; status/limit filtered client-side so the
      // shared internal list route stays untouched.
      const r = await keeperAuthFetch(`/internal/backups?org_id=${encodeURIComponent(ctx?.orgId || 'default')}`, 'GET');
      if (!r.success || !Array.isArray(r.backups)) return r;
      let backups = r.backups;
      if (input.status) backups = backups.filter((b) => b.status === input.status);
      if (input.limit) backups = backups.slice(0, input.limit);
      return { ...r, backups, count: backups.length };
    }
  },

  keeper_backup_verify: {
    name: 'keeper_backup_verify',
    description: 'Verify a backup archive integrity using SHA-256 cryptographic proof. Run this before restoring to ensure the backup is not corrupted.',
    input_schema: {
      type: 'object',
      properties: {
        backup_id: { type: 'string', description: 'Backup ID to verify' }
      },
      required: ['backup_id']
    },
    execute: async (input, ctx) => {
      // Internal service-key verify route (CSRF-exempt); the org route
      // enforces CSRF a service-key caller can't satisfy. Same
      // verifyBackupIntegrity path. (Proven live 2026-08-08: org route
      // returned 403 "Missing CSRF token header".)
      return await keeperAuthFetch(`/internal/backups/verify`, 'POST', {
        org_id: ctx?.orgId || 'default',
        backup_id: input.backup_id,
      });
    }
  },

  keeper_restore: {
    name: 'keeper_restore',
    description: 'Restore from a backup. Supports dry-run mode (preview changes without applying) and selective component restore. Always verify the backup first.',
    input_schema: {
      type: 'object',
      properties: {
        backup_id: { type: 'string', description: 'Backup ID to restore from' },
        dry_run: { type: 'boolean', description: 'Preview changes without applying (default: true for safety)' },
        components: { type: 'array', items: { type: 'string' }, description: 'Specific components to restore (optional, default: all)' }
      },
      required: ['backup_id']
    },
    execute: async (input, ctx) => {
      // Internal service-key restore route (CSRF-exempt); the org route
      // enforces CSRF a service-key caller can't satisfy. Same
      // runRestoreProcess path. (Proven live 2026-08-08: org route
      // returned 403 "Missing CSRF token header".)
      const restore = () => keeperAuthFetch(`/internal/backups/restore`, 'POST', {
        org_id: ctx?.orgId || 'default',
        backup_id: input.backup_id,
        dry_run: input.dry_run !== false,
        components: input.components,
      });
      // A dry run only previews. A real restore overwrites instance data, so it
      // carries the same inline HITL gate as keeper_update_start/rollback
      // (FND_01M4MB2CTK6JQ448GAF76JQ448): the agent's call files an approval and
      // the restore runs only on the approved resume.
      if (input.dry_run !== false) return await restore();
      const toolInput = {
        backup_id: input.backup_id,
        dry_run: false,
        ...(input.components ? { components: input.components } : {}),
        ...(input._approvalId ? { _approvalId: input._approvalId } : {}),
        ...(input._resumeToken ? { _resumeToken: input._resumeToken } : {}),
      };
      return await withApprovalGate('keeper_restore', toolInput, restore,
        { ...ctx, _entityRequiresApproval: true, _entityDefconLevel: 'RED' });
    }
  },

  keeper_schedule_list: {
    name: 'keeper_schedule_list',
    description: 'List all configured backup schedules with their frequency, next run time, and enabled status.',
    input_schema: { type: 'object', properties: {} },
    execute: async (input, ctx) => {
      // AGENT-OVERHAUL phase 7: service-key /internal mirror (org route 401s the agent).
      return await keeperAuthFetch(`/internal/backup-schedules?org_id=${encodeURIComponent(ctx?.orgId || 'default')}`, 'GET');
    }
  },

  keeper_schedule_manage: {
    name: 'keeper_schedule_manage',
    description: 'Create, update, or delete a backup schedule. Supports cron expressions and frequency presets (hourly, daily, weekly, monthly).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'], description: 'Action to perform' },
        schedule_id: { type: 'string', description: 'Schedule ID (required for update/delete)' },
        frequency: { type: 'string', description: 'Preset: hourly, daily, weekly, monthly (for create/update)' },
        cron: { type: 'string', description: 'Custom cron expression (overrides frequency)' },
        backup_type: { type: 'string', enum: ['full', 'selective'], description: 'Backup type for this schedule' },
        enabled: { type: 'boolean', description: 'Enable or disable schedule' },
        retention_count: { type: 'number', description: 'Number of backups to retain (oldest deleted)' }
      },
      required: ['action']
    },
    execute: async (input, ctx) => {
      const orgBase = `/orgs/${ctx?.orgId || 'default'}/backup-schedules`;
      if (input.action === 'delete' && input.schedule_id) {
        return await keeperAuthFetch(`${orgBase}/${input.schedule_id}`, 'DELETE');
      }
      if (input.action === 'update' && input.schedule_id) {
        const body = {};
        if (input.frequency) body.frequency = input.frequency;
        if (input.cron) body.cron = input.cron;
        if (input.backup_type) body.backup_type = input.backup_type;
        if (input.enabled !== undefined) body.enabled = input.enabled;
        if (input.retention_count) body.retention_count = input.retention_count;
        return await keeperAuthFetch(`${orgBase}/${input.schedule_id}`, 'PATCH', body);
      }
      // create
      return await keeperAuthFetch(orgBase, 'POST', {
        frequency: input.frequency,
        cron: input.cron,
        backup_type: input.backup_type || 'full',
        enabled: input.enabled !== false,
        retention_count: input.retention_count,
      });
    }
  },

  keeper_update_check: {
    name: 'keeper_update_check',
    description: 'Check for available QuoxCORE updates. Returns current version, available version, and whether an update is available.',
    input_schema: { type: 'object', properties: {} },
    execute: async (input, ctx) => {
      return await keeperAuthFetch(`/orgs/${ctx?.orgId || 'default'}/update-check`, 'POST');
    }
  },

  keeper_update_start: {
    name: 'keeper_update_start',
    // QUOXTRUST C2/WP2: reaches outside the box — durable intent gated at the choke.
    externalEffect: true,
    // Approval gate runs INSIDE execute — the dispatch stamp lands at the real
    // effect boundary via ctx._markDispatched (approvalGate), not pre-execute.
    gatedInExecute: true,
    description: 'Start a QuoxCORE update. Automatically creates a pre-update backup before proceeding. Requires admin role. Always confirm with the user before calling this.',
    input_schema: {
      type: 'object',
      properties: {
        target_version: { type: 'string', description: 'Target version to update to (optional, defaults to latest)' }
      }
    },
    execute: async (input, ctx) => {
      // AGENT-OVERHAUL phase 7: platform updates (git pull + build + restart,
      // recorded with a HUMAN performed_by, org route gated requireOrgRole
      // 'admin') are too high-privilege for an autonomous service-key path.
      // HITL-gate: the agent's call files an approval proposal and CANNOT
      // execute; on human approval it hands off to the admin maintenance UI
      // rather than self-executing a platform update from a service context.
      const toolInput = {
        target_version: input.target_version,
        ...(input._approvalId ? { _approvalId: input._approvalId } : {}),
        ...(input._resumeToken ? { _resumeToken: input._resumeToken } : {}),
      };
      return await withApprovalGate('keeper_update_start', toolInput, async () => ({
        success: true,
        handoff: true,
        message: `Update to ${input.target_version || 'latest'} is approved. Platform updates run from Settings > Maintenance by a human admin; KEEPER does not execute git pull/build/restart autonomously.`,
      }), { ...ctx, _entityRequiresApproval: true, _entityDefconLevel: 'RED' });
    }
  },

  keeper_update_rollback: {
    name: 'keeper_update_rollback',
    // QUOXTRUST C2/WP2: reaches outside the box — durable intent gated at the choke.
    externalEffect: true,
    // Approval gate runs INSIDE execute — the dispatch stamp lands at the real
    // effect boundary via ctx._markDispatched (approvalGate), not pre-execute.
    gatedInExecute: true,
    description: 'Rollback to a previous QuoxCORE version using the pre-update backup. Requires admin role. Always confirm with the user before calling this.',
    input_schema: {
      type: 'object',
      properties: {
        operation_id: { type: 'string', description: 'Update operation ID to rollback (optional, defaults to most recent)' }
      }
    },
    execute: async (input, ctx) => {
      // AGENT-OVERHAUL phase 7: same posture as keeper_update_start — a
      // rollback is a platform-level git/build/restart operation gated to a
      // human admin. HITL-gate propose-only; hand off to the admin UI on
      // approval rather than executing autonomously via a service key.
      const toolInput = {
        operation_id: input.operation_id,
        ...(input._approvalId ? { _approvalId: input._approvalId } : {}),
        ...(input._resumeToken ? { _resumeToken: input._resumeToken } : {}),
      };
      return await withApprovalGate('keeper_update_rollback', toolInput, async () => ({
        success: true,
        handoff: true,
        message: `Rollback${input.operation_id ? ` of operation ${input.operation_id}` : ''} is approved. Platform rollbacks run from Settings > Maintenance by a human admin; KEEPER does not execute them autonomously.`,
      }), { ...ctx, _entityRequiresApproval: true, _entityDefconLevel: 'RED' });
    }
  },

  keeper_audit_log: {
    name: 'keeper_audit_log',
    description: 'View the maintenance audit log. Shows backup operations, restore operations, update events, and rollbacks with DEFCON severity levels.',
    input_schema: {
      type: 'object',
      properties: {
        operation: { type: 'string', description: 'Filter by operation type (backup, restore, update, rollback)' },
        defcon_level: { type: 'string', enum: ['GREEN', 'BLUE', 'AMBER', 'ORANGE', 'RED'], description: 'Filter by DEFCON level' },
        limit: { type: 'number', description: 'Max results (default 20)' }
      }
    },
    execute: async (input, ctx) => {
      const params = new URLSearchParams();
      if (input.operation) params.set('operation', input.operation);
      if (input.defcon_level) params.set('defcon_level', input.defcon_level);
      if (input.limit) params.set('limit', String(input.limit));
      params.set('org_id', ctx?.orgId || 'default');
      // AGENT-OVERHAUL phase 7: service-key /internal mirror (org route 401s the agent).
      return await keeperAuthFetch(`/internal/backup-audit-log?${params.toString()}`, 'GET');
    }
  },

  // ===== QuoxMind Execution Intelligence (QM-5) =====

  execution_intelligence: {
    name: 'execution_intelligence',
    description: 'Query QuoxMind cognitive index — mirror status, objectives, wisdom patterns, agent performance, engine health, and implant details',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['mirror_index', 'implant_detail', 'recent_objectives', 'search_wisdom', 'engine_health'],
          description: 'What to query: mirror_index (full cognitive index), implant_detail (one implant), recent_objectives, search_wisdom, engine_health'
        },
        implant_id: {
          type: 'string',
          description: 'Implant ID for implant_detail action (e.g. quox-memory, quox-guard)'
        },
        query: {
          type: 'string',
          description: 'Search term for search_wisdom action'
        },
        limit: {
          type: 'integer',
          description: 'Max results to return (default 5)'
        }
      },
      required: ['action']
    },
    execute: async (input, ctx) => {
      const tasksUrl = `http://${process.env.TASKS_HOST || 'tasks'}:${process.env.TASKS_PORT || '3104'}`;
      const limit = input.limit || 5;
      const headers = {
        'Content-Type': 'application/json',
        'X-Org-Id': ctx?.orgId || 'default',
        'X-User-Id': ctx?.userId || '',
        'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '',
      };

      try {
        switch (input.action) {
          case 'mirror_index': {
            // Build a collector-side mirror from available data sources
            const AUTH_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;
            const [healthResp, wisdomResp, objResp, inboxResp] = await Promise.allSettled([
              fetch(`${tasksUrl}/api/engine/health`, { headers, signal: AbortSignal.timeout(5000) }),
              fetch(`${tasksUrl}/api/wisdom?limit=10`, { headers, signal: AbortSignal.timeout(5000) }),
              fetch(`${tasksUrl}/api/objectives?limit=5`, { headers, signal: AbortSignal.timeout(5000) }),
              fetch(`${AUTH_URL}/api/inbox/stats`, { headers: { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '' }, signal: AbortSignal.timeout(3000) }),
            ]);
            const health = healthResp.status === 'fulfilled' && healthResp.value.ok ? await healthResp.value.json() : null;
            const wisdom = wisdomResp.status === 'fulfilled' && wisdomResp.value.ok ? await wisdomResp.value.json() : null;
            const objectives = objResp.status === 'fulfilled' && objResp.value.ok ? await objResp.value.json() : null;
            const inbox = inboxResp.status === 'fulfilled' && inboxResp.value.ok ? await inboxResp.value.json() : null;
            // TRUST-GATE 1.18b — roster and implant list are derived from the
            // real registries (src/config/entities/assistants/*.json and
            // src/config/cognitiveImplants.js), not hardcoded strings that
            // drift when agents/implants are added or renamed.
            const cognitiveImplants = await loadCognitiveImplants();
            const implantEntries = Object.values(cognitiveImplants);
            const roster = listAssistants()
              .map(id => getAssistant(id)?.identity?.name || id.toUpperCase())
              .sort();
            return {
              success: true,
              mirror: {
                timestamp: new Date().toISOString(),
                engine: health || { note: 'Task service unavailable' },
                agents: {
                  note: 'AI agent roster (not infrastructure agents) — derived from src/config/entities/assistants/',
                  roster,
                  count: roster.length,
                },
                implants: {
                  note: `${implantEntries.length} QuoxMind cognitive implants — derived from src/config/cognitiveImplants.js`,
                  list: implantEntries.map(cfg => {
                    const tierSuffix = cfg.tier === 'pro' ? ' [Pro]' : cfg.tier === 'complete' ? ' [Complete]' : '';
                    return `${cfg.name} (${cfg.inspiredBy})${tierSuffix}`;
                  }),
                },
                wisdom: {
                  count: wisdom?.wisdom?.length || 0,
                  entries: (wisdom?.wisdom || []).map(w => ({ pattern: w.pattern_name, confidence: w.confidence, lesson: w.lesson?.substring(0, 100) })),
                },
                objectives: {
                  count: objectives?.count || 0,
                  recent: (objectives?.objectives || []).map(o => ({ title: o.title, status: o.status, quality: o.quality_score })),
                },
                inbox: inbox ? { pending: inbox.pending || inbox.count || 0 } : { pending: 'unknown' },
              },
            };
          }
          case 'implant_detail': {
            // TRUST-GATE 1.18b — implant descriptions come from the same
            // src/config/cognitiveImplants.js registry the dashboard renders,
            // not a hardcoded map that drifts when implants change.
            const cognitiveImplants = await loadCognitiveImplants();
            const validIds = Object.keys(cognitiveImplants);
            if (!input.implant_id) return { success: false, error: `implant_id required. Valid IDs: ${validIds.join(', ')}` };
            // Return what we know about this implant from engine health
            const hResp = await fetch(`${tasksUrl}/api/engine/health`, { headers, signal: AbortSignal.timeout(5000) });
            const hData = hResp.ok ? await hResp.value?.json?.() || await hResp.json() : null;
            const cfg = cognitiveImplants[input.implant_id];
            if (!cfg) return { success: false, error: `Unknown implant: ${input.implant_id}. Valid IDs: ${validIds.join(', ')}` };
            return {
              success: true,
              implant: {
                name: `${cfg.name} Implant`,
                inspiredBy: cfg.inspiredBy,
                role: cfg.description,
                tier: cfg.tier,
                id: input.implant_id,
                engineHealth: hData || null,
                note: 'For live health metrics, the dashboard Mirror tab shows real-time implant data.',
              },
            };
          }
          case 'recent_objectives': {
            const resp = await fetch(`${tasksUrl}/api/objectives?limit=${limit}`, {
              headers,
              signal: AbortSignal.timeout(10000),
            });
            if (!resp.ok) return { success: false, error: `Tasks service returned ${resp.status}` };
            const data = await resp.json();
            return { success: true, ...data };
          }
          case 'search_wisdom': {
            const params = new URLSearchParams();
            if (input.query) params.set('q', input.query);
            params.set('limit', String(limit));
            const resp = await fetch(`${tasksUrl}/api/wisdom?${params}`, {
              headers,
              signal: AbortSignal.timeout(10000),
            });
            if (!resp.ok) return { success: false, error: `Tasks service returned ${resp.status}` };
            const data = await resp.json();
            return { success: true, ...data };
          }
          case 'engine_health': {
            const resp = await fetch(`${tasksUrl}/api/engine/health`, {
              headers,
              signal: AbortSignal.timeout(10000),
            });
            if (!resp.ok) return { success: false, error: `Tasks service returned ${resp.status}` };
            const data = await resp.json();
            return { success: true, ...data };
          }
          default:
            return { success: false, error: `Unknown action: ${input.action}. Use recent_objectives, search_wisdom, or engine_health.` };
        }
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  // ==========================================================================
  // WC-6: Conversational workflow creation — save objective as recurring workflow
  // ==========================================================================

  save_as_workflow: {
    name: 'save_as_workflow',
    description: 'Save a completed objective as a reusable template and optionally schedule it. Use after a successful objective when the user wants to repeat it. Set use_quoxflow=true to convert to a QuoxFlow workflow for auditable execution with policy enforcement and approval gates.',
    input_schema: {
      type: 'object',
      properties: {
        objective_id: { type: 'string', description: 'The objective ID to save as template' },
        name: { type: 'string', description: 'Template name for the saved workflow' },
        schedule: { type: 'string', description: 'Optional cron expression or natural language schedule (e.g. "every Monday at 9am"). Omit for no schedule.' },
        use_quoxflow: { type: 'boolean', description: 'Convert to QuoxFlow workflow for auditable execution with AOCL pipeline, policy enforcement, and approval gates. Default: false.' },
      },
      required: ['objective_id', 'name']
    },
    execute: async (input, ctx) => {
      try {
        const tasksUrl = `http://${process.env.TASKS_HOST || 'tasks'}:${process.env.TASKS_PORT || '3104'}`;
        const orgId = ctx?.orgId;
        const userId = ctx?.userId;
        if (!orgId) return { success: false, error: 'No organization context — cannot save workflow' };

        const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
        const headers = {
          'Content-Type': 'application/json',
          'X-Service-Key': serviceKey,
          'X-Org-Id': orgId,
          'X-User-Id': userId || '',
        };

        // Step 1: Save the objective as a template
        const templateRes = await fetch(`${tasksUrl}/api/objectives/${input.objective_id}/save-as-template`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: input.name }),
          signal: AbortSignal.timeout(15000),
        });
        if (!templateRes.ok) {
          const errText = await templateRes.text();
          return { success: false, error: `Failed to save template: ${templateRes.status} — ${errText}` };
        }
        const template = await templateRes.json();
        const templateId = template.id || template.template_id;

        // Step 2: If schedule provided, parse NL to cron and create schedule
        let scheduleCron = null;
        let nextRun = null;
        if (input.schedule) {
          scheduleCron = parseNLToCron(input.schedule);
          if (!scheduleCron) {
            return { success: true, templateId, warning: `Template saved, but could not parse schedule "${input.schedule}". Use a cron expression (e.g. "0 9 * * 1") or a phrase like "every Monday" or "daily".` };
          }

          // Create org-level schedule via POST /api/schedules
          const scheduleRes = await fetch(`${tasksUrl}/api/schedules`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              name: input.name,
              cronExpression: scheduleCron,
              timezone: 'UTC',
              objectiveTemplate: {
                title: template.title || input.name,
                description: template.description || '',
              },
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (!scheduleRes.ok) {
            const errText = await scheduleRes.text();
            return { success: true, templateId, warning: `Template saved, but failed to create schedule: ${scheduleRes.status} — ${errText}` };
          }
          const scheduleData = await scheduleRes.json();
          nextRun = scheduleData.next_trigger_at || null;
        }

        // Build human-readable schedule description
        const cronHuman = input.schedule || scheduleCron || null;
        const nextRunFormatted = nextRun ? new Date(nextRun).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : null;

        // Step 3 (optional): Convert to QuoxFlow workflow
        let quoxflowResult = null;
        if (input.use_quoxflow) {
          try {
            const quoxflowUrl = `http://${process.env.QUOXFLOW_HOST || 'quoxflow'}:${process.env.QUOXFLOW_PORT || '3200'}`;
            const qfRes = await fetch(`${quoxflowUrl}/api/workflows/import-objective`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(ctx?.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
                'X-Service-Key': serviceKey,
                'X-Org-ID': orgId,
              },
              body: JSON.stringify({
                template: template.template_json ? JSON.parse(template.template_json) : template,
                schedule: scheduleCron ? { cron: scheduleCron, timezone: 'UTC' } : undefined,
                options: { activate: !!scheduleCron },
              }),
              signal: AbortSignal.timeout(15000),
            });
            if (qfRes.ok) {
              const qfData = await qfRes.json();
              quoxflowResult = {
                workflow_id: qfData.data?.workflow?.id || qfData.workflow?.id,
                node_count: qfData.data?.workflow?.definition?.nodes?.length || 0,
                activated: qfData.data?.activated || false,
              };
            } else {
              const errText = await qfRes.text();
              quoxflowResult = { error: `QuoxFlow import failed: ${qfRes.status} — ${errText}` };
            }
          } catch (qfErr) {
            quoxflowResult = { error: `QuoxFlow conversion failed: ${qfErr.message}` };
          }
        }

        const quoxflowMsg = quoxflowResult && !quoxflowResult.error
          ? ` Converted to QuoxFlow workflow (${quoxflowResult.node_count} nodes).`
          : quoxflowResult?.error ? ` QuoxFlow: ${quoxflowResult.error}` : '';

        return {
          success: true,
          template_id: templateId,
          scheduled: !!scheduleCron,
          cron: scheduleCron || null,
          cron_human: cronHuman,
          next_run: nextRunFormatted || null,
          quoxflow: quoxflowResult,
          message: scheduleCron
            ? `Saved as template "${input.name}". Scheduled: ${cronHuman}. Next run: ${nextRunFormatted || 'pending'}.${quoxflowMsg}`
            : `Saved as template "${input.name}". No schedule set.${quoxflowMsg}`,
          links: {
            schedules: '/mission-control?tab=schedules',
            ...(quoxflowResult?.workflow_id ? { workflow: `/workflows/${quoxflowResult.workflow_id}` } : {}),
          },
        };
      } catch (err) {
        return { success: false, error: `Failed to save workflow: ${err.message}` };
      }
    }
  },

  // ==========================================================================
  // Browser-Q Tools (Web Automation)
  // ==========================================================================

  browser_navigate: {
    name: 'browser_navigate',
    description: 'Navigate to a URL in the Browser-Q headless browser. Returns the page title, final URL (after redirects), and a screenshot URL.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to (must include protocol, e.g. https://)' }
      },
      required: ['url']
    },
    execute: async (input, ctx) => {
      const url = input.url;
      if (!url) return { success: false, error: 'url is required' };
      // Validate URL format
      try { new URL(url); } catch { return { success: false, error: `Invalid URL: ${url}` }; }

      // Attempt to call ScreenCap service /execute endpoint
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(serviceKey ? { 'x-service-key': serviceKey } : {})
          },
          body: JSON.stringify({
            tool_id: 'browser_navigate',
            input: { url },
            agent_id: 'browser-q'
          }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) {
          const data = await resp.json();
          return data.result || data;
        }
      } catch { /* ScreenCap may not support this tool yet */ }

      // BQF-4: Return error, not success, when screencap is unavailable
      return {
        success: false,
        error: 'ScreenCap service unavailable for browser_navigate'
      };
    }
  },

  browser_screenshot: {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page in the Browser-Q headless browser. Optionally capture a specific element by CSS selector.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector to capture a specific element instead of the full page' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(serviceKey ? { 'x-service-key': serviceKey } : {})
          },
          body: JSON.stringify({
            tool_id: 'browser_screenshot',
            input: { selector: input.selector || null },
            agent_id: 'browser-q'
          }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) {
          const data = await resp.json();
          return data.result || data;
        }
      } catch { /* ScreenCap may not support this tool yet */ }

      return {
        success: true,
        stub: true,
        screenshot_url: null,
        dimensions: null,
        message: 'Browser-Q screenshot tools are registered. Playwright browser engine will be wired in BQ-1.'
      };
    }
  },

  browser_extract: {
    name: 'browser_extract',
    description: 'Extract structured data from the current page. Supports text, table, schema, links, metadata, list, and template-based extraction. Use format parameter to select mode.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for target elements' },
        format: { type: 'string', enum: ['text', 'table', 'schema', 'links', 'metadata', 'list', 'template'], description: 'Extraction format (default: text)' },
        schema: { type: 'object', description: 'JSON schema for structured extraction (each key has selector/type)' },
        template: { type: 'string', enum: ['product_listing', 'invoice_table', 'job_listing', 'contact_info', 'page_links'], description: 'Pre-built extraction template' },
        pattern: { type: 'string', description: 'URL pattern to filter links (format=links)' },
        item_selector: { type: 'string', description: 'CSS selector for repeated items (format=list)' },
        fields: { type: 'object', description: 'Field name to CSS selector map for list items (format=list)' },
        export_format: { type: 'string', enum: ['json', 'csv'], description: 'Export format for extracted data' },
        create_actions: { type: 'boolean', description: 'Create Action-Q items from extracted data' },
        org_id: { type: 'string', description: 'Organisation ID for Action-Q items' },
        user_id: { type: 'string', description: 'User ID for Action-Q items' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_extract', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_extract' };
    }
  },

  browser_extract_table: {
    name: 'browser_extract_table',
    description: 'Extract HTML tables as structured arrays with headers and rows. Auto-detects tables or targets a specific one by CSS selector.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for a specific table (omit to extract all)' },
        export_format: { type: 'string', enum: ['json', 'csv'], description: 'Export format (default: json)' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_extract_table', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_extract_table' };
    }
  },

  browser_extract_schema: {
    name: 'browser_extract_schema',
    description: 'Extract data from a page using a JSON schema with CSS selectors. Each field specifies a selector and type (text, number, attribute, boolean, list, object).',
    input_schema: {
      type: 'object',
      properties: {
        schema: { type: 'object', description: 'Extraction schema: { fieldName: { selector, type, attr?, match?, required?, fields? } }' },
        export_format: { type: 'string', enum: ['json', 'csv'], description: 'Export format' },
        create_actions: { type: 'boolean', description: 'Create Action-Q items from extracted data' },
        org_id: { type: 'string', description: 'Organisation ID for Action-Q items' },
        user_id: { type: 'string', description: 'User ID for Action-Q items' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: ['schema']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_extract_schema', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_extract_schema' };
    }
  },

  browser_extract_template: {
    name: 'browser_extract_template',
    description: 'Extract data using a pre-built extraction template. Templates: product_listing, invoice_table, job_listing, contact_info, page_links.',
    input_schema: {
      type: 'object',
      properties: {
        template: { type: 'string', enum: ['product_listing', 'invoice_table', 'job_listing', 'contact_info', 'page_links'], description: 'Template name' },
        export_format: { type: 'string', enum: ['json', 'csv'], description: 'Export format' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: ['template']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_extract_template', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_extract_template' };
    }
  },

  browser_extract_links: {
    name: 'browser_extract_links',
    description: 'Extract all links from the current page, with optional filtering by URL pattern or container selector.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for a container (omit for whole page)' },
        pattern: { type: 'string', description: 'URL substring to filter links' },
        export_format: { type: 'string', enum: ['json', 'csv'], description: 'Export format' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_extract_links', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_extract_links' };
    }
  },

  browser_extract_metadata: {
    name: 'browser_extract_metadata',
    description: 'Extract page metadata: title, description, Open Graph tags, Twitter Cards, JSON-LD structured data, canonical URL, language.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_extract_metadata', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_extract_metadata' };
    }
  },

  browser_click: {
    name: 'browser_click',
    description: 'Click an element on the current page. Accepts a CSS selector, text content, or natural language description. Uses AI-powered multi-strategy element finding.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click' },
        text: { type: 'string', description: 'Text content of the element to click' },
        description: { type: 'string', description: 'Natural language description of the element' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' },
        timeout: { type: 'number', description: 'Wait timeout in ms (default: 10000)' }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_click', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_click' };
    }
  },

  browser_type: {
    name: 'browser_type',
    description: 'Type text into an input field on the current page.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input field' },
        text: { type: 'string', description: 'The text to type into the field' },
        description: { type: 'string', description: 'Natural language description of the field (alternative to selector)' },
        clear: { type: 'boolean', description: 'Clear the field before typing (default: false)' },
        delay: { type: 'number', description: 'Delay between keystrokes in ms (default: 50)' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: ['text']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_type', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_type' };
    }
  },

  browser_wait: {
    name: 'browser_wait',
    description: 'Wait for a condition on the current page: element visible/hidden, network idle, or DOM stable.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        timeout: { type: 'number', description: 'Maximum wait time in milliseconds (default: 10000)' },
        condition: { type: 'string', enum: ['visible', 'hidden', 'network_idle', 'dom_stable', 'timeout'], description: 'Wait condition type (default: visible)' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_wait', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_wait' };
    }
  },

  browser_scroll: {
    name: 'browser_scroll',
    description: 'Scroll the page or a specific element. Specify direction and amount.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction (default: down)' },
        amount: { type: 'number', description: 'Scroll amount in pixels (default: 500)' },
        selector: { type: 'string', description: 'Optional CSS selector of element to scroll within' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_scroll', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_scroll' };
    }
  },

  browser_fill_form: {
    name: 'browser_fill_form',
    description: 'Fill multiple form fields at once. Auto-detects field types (text, select, checkbox, radio). Optionally submits the form.',
    input_schema: {
      type: 'object',
      properties: {
        fields: { type: 'object', description: 'Map of selector → value for each field to fill' },
        submit: { type: 'boolean', description: 'Click submit button after filling (default: false)' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: ['fields']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_fill_form', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_fill_form' };
    }
  },

  browser_select: {
    name: 'browser_select',
    description: 'Select an option from a dropdown <select> element by value or visible text.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the <select> element' },
        value: { type: 'string', description: 'Option value to select' },
        text: { type: 'string', description: 'Visible text of the option (alternative to value)' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: ['selector']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_select', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_select' };
    }
  },

  browser_find_element: {
    name: 'browser_find_element',
    description: 'AI-powered element finder. Tries multiple strategies: CSS selector, text match, aria-label, placeholder, title attribute. Returns the best match with confidence score.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Natural language description of the element to find' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: ['description']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_find_element', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_find_element' };
    }
  },

  // ==========================================================================
  // Browser-Q Form Intelligence, Downloads, Lighthouse & Tab Management
  // (BQ-W4 / BQ Final — proxy entries for tools implemented in screencap
  // server.js but missing here, leaving them unreachable via AGENT_TOOLS)
  // ==========================================================================

  browser_analyze_forms: {
    name: 'browser_analyze_forms',
    description: 'Analyze all forms on the current page. Returns form structure with field labels, names, types, CSS selectors, and submit button info. Use BEFORE browser_fill_form to discover available fields.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID (default: "default")' }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_analyze_forms', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_analyze_forms' };
    }
  },

  browser_pdf: {
    name: 'browser_pdf',
    description: 'Generate a PDF of the current page. Returns the PDF file path and size.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID (default: "default")' },
        format: { type: 'string', description: 'Page format (A4, Letter, Legal)', default: 'A4' },
        landscape: { type: 'boolean', description: 'Landscape orientation', default: false },
        print_background: { type: 'boolean', description: 'Print backgrounds', default: true }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_pdf', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_pdf' };
    }
  },

  browser_download: {
    name: 'browser_download',
    description: 'Download a file from the current page by clicking a download link or navigating to a file URL. Returns the downloaded file path and metadata.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID (default: "default")' },
        url: { type: 'string', description: 'Direct URL to download (optional — use if you know the file URL)' },
        selector: { type: 'string', description: 'CSS selector of the download link/button to click' },
        text: { type: 'string', description: 'Text of the download link to click' },
        timeout_ms: { type: 'number', description: 'Max wait time for download (default: 30000)', default: 30000 }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_download', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(60000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_download' };
    }
  },

  browser_lighthouse: {
    name: 'browser_lighthouse',
    description: 'Run a Lighthouse audit on the current page. Returns performance, accessibility, best practices, and SEO scores with improvement suggestions.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID (default: "default")' },
        categories: { type: 'array', items: { type: 'string' }, description: 'Categories to audit (performance, accessibility, best-practices, seo). Default: all.' }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_lighthouse', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(60000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_lighthouse' };
    }
  },

  browser_new_tab: {
    name: 'browser_new_tab',
    description: 'Open a new browser tab. Optionally navigate to a URL.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID (default: "default")' },
        url: { type: 'string', description: 'URL to open in the new tab (optional)' }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_new_tab', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_new_tab' };
    }
  },

  browser_switch_tab: {
    name: 'browser_switch_tab',
    description: 'Switch to a different browser tab by index.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID (default: "default")' },
        tab_index: { type: 'integer', description: 'Tab index to switch to (0-based)' }
      },
      required: ['tab_index']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_switch_tab', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_switch_tab' };
    }
  },

  browser_list_tabs: {
    name: 'browser_list_tabs',
    description: 'List all open tabs in the session with their URLs and active status.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID (default: "default")' }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_list_tabs', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_list_tabs' };
    }
  },

  // ==========================================================================
  // Browser-Q Auth & Session Persistence Tools (BQ-3)
  // ==========================================================================

  browser_login: {
    name: 'browser_login',
    description: 'Authenticate using vault credentials with a server-verified approval/lease gate. Credentials are injected directly into the browser — never exposed to the agent. Requires an active, server-verified lease/approval for this credential — a caller-supplied hitl_approved flag alone is never sufficient.',
    input_schema: {
      type: 'object',
      properties: {
        credential_id: { type: 'string', description: 'Vault credential reference ID' },
        org_id: { type: 'string', description: 'Organisation ID that owns the credential' },
        hitl_approved: { type: 'boolean', description: 'Legacy human-in-the-loop hint, kept for back-compat. NOT authoritative — the real gate is a server-verified lease/approval record (see VAULT-P5.J).' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: ['credential_id', 'org_id', 'hitl_approved']
    },
    // VAULT-AUDIT P5.J (F13): input.hitl_approved used to be trusted on its
    // own — a caller (including the agent itself) could set it to true with
    // no server-side record backing that claim. This is the highest-risk
    // act-as-user path in the system, so it now performs a REAL
    // server-verified check via the same credential-decrypt endpoint (and
    // its evaluateLeaseGate, VAULT-P5.G) every other credentialed collector
    // tool (email_read/email_send/tls_cert_info/remote_ssh) already uses —
    // passing agent_id so the org's vault.lease_enforcement mode decides the
    // outcome for real (enforced -> hard refuse on a missing/expired/
    // exhausted lease; advisory -> proceed, but the auth-side gate has
    // already written a secret.access.lease_missing audit event; off -> full
    // bypass, an explicit admin opt-out). The decrypted credential here is
    // discarded — never used, never returned — this call exists purely to
    // prove the gate; ScreenCap performs the actual resolution + injection.
    execute: async (input, ctx = {}) => {
      const orgId = resolveToolOrgId(ctx, input);
      const agentId = ctx.agentId || null;
      const credentialId = input.credential_id;

      if (!credentialId || !orgId) {
        return { success: false, error: 'credential_resolve_failed' };
      }

      try {
        const verifyUrl = `${AUTH_BASE_URL}/setup/internal/credential-decrypt/${encodeURIComponent(credentialId)}?org_id=${encodeURIComponent(orgId)}${agentId ? `&agent_id=${encodeURIComponent(agentId)}` : ''}`;
        const verifyResp = await fetch(verifyUrl, {
          headers: buildInternalServiceHeaders(),
          signal: AbortSignal.timeout(15000),
        });
        if (verifyResp.status === 403) {
          const data = await verifyResp.json().catch(() => ({}));
          return {
            success: false,
            error: data?.reason || 'lease_required',
            requires_server_approval: true,
            action: 'login',
            credential_id: credentialId
          };
        }
        if (!verifyResp.ok) {
          return {
            success: false,
            error: 'no_verified_approval',
            requires_server_approval: true,
            action: 'login',
            credential_id: credentialId
          };
        }
      } catch {
        return {
          success: false,
          error: 'no_verified_approval',
          requires_server_approval: true,
          action: 'login',
          credential_id: credentialId
        };
      }

      // VAULT-P3.B2: inject org_id from execution context (consistent with the
      // cookie tools) so login never depends on the LLM remembering org_id.
      // Also relay agent_id so ScreenCap's own credential resolve (the actual
      // release point) is gated too, not only this defense-in-depth check.
      const relayInput = { ...input, org_id: orgId, agent_id: agentId };
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_login', input: relayInput, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(60000) // Longer timeout for login flow
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_login' };
    }
  },

  browser_save_cookies: {
    name: 'browser_save_cookies',
    description: 'Persist current session cookies server-side for later restoration. Cookies are stored per-domain per-session, never sent to the agent.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain to associate cookies with' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' },
        org_id: { type: 'string', description: 'Owning org (injected from execution context when omitted)' }
      },
      required: ['domain']
    },
    // VAULT-P3.B2: org_id is REQUIRED by the auth-backed session store — inject
    // it from the execution context so it is never dropped (screencap silently
    // skips persistence without it). QUOXTRUST F1: an authenticated ctx.orgId is
    // authoritative; input.org_id is used only on the trusted internal path (no
    // ctx.orgId), never as a user-supplied override (cross-tenant vector).
    execute: async (input, ctx = {}) => {
      const relayInput = { ...input, org_id: resolveToolOrgId(ctx, input) };
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_save_cookies', input: relayInput, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_save_cookies' };
    }
  },

  browser_restore_cookies: {
    name: 'browser_restore_cookies',
    description: 'Restore previously saved session cookies into the browser context for a given domain. Use this to resume authenticated sessions without re-logging in.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain to restore cookies for' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' },
        org_id: { type: 'string', description: 'Owning org (injected from execution context when omitted)' }
      },
      required: ['domain']
    },
    // VAULT-P3.B2: inject org_id from context (see browser_save_cookies).
    execute: async (input, ctx = {}) => {
      const relayInput = { ...input, org_id: resolveToolOrgId(ctx, input) };
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_restore_cookies', input: relayInput, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_restore_cookies' };
    }
  },

  // ==========================================================================
  // VAULT-AUDIT P3.D1 — Email Tools (IMAP mailbox read via vault credential)
  // ==========================================================================

  email_read: {
    name: 'email_read',
    description: 'Read recent email messages from a mailbox using a vault email_account credential over IMAP. The credential password is resolved server-side and never leaves the collector — only message content (from/subject/date/snippet) is returned. credential_id is optional — omit it to let the platform resolve the agent\'s assigned/org-default email_account credential automatically.',
    input_schema: {
      type: 'object',
      properties: {
        credential_id: { type: 'string', description: 'Vault credential reference ID for the email_account credential. Optional — if omitted, resolved automatically for this agent (agent assignment -> org default -> instance -> env), lease-gated by the org\'s vault enforcement mode.' },
        org_id: { type: 'string', description: 'Organisation ID that owns the credential' },
        folder: { type: 'string', description: 'IMAP folder/mailbox to read (default: INBOX)' },
        limit: { type: 'number', description: 'Max number of messages to return (default 10, max 50)' },
        unseen_only: { type: 'boolean', description: 'Only return unread/unseen messages (default false)' }
      },
      required: ['org_id']
    },
    // VAULT-AUDIT P5.L (email tool retrofit) — declares credentialedIntegration
    // so executeTool's dispatch hook (VAULT-P5.H, F4) resolves a credential_id
    // via resolveCredentialForAgent()/resolve-for-agent when the caller omits
    // one, instead of always requiring the LLM to already know a specific
    // credential_id. Zero behavior change when a credential_id IS supplied
    // (the hook only fires when it's absent) or when the org's lease
    // enforcement mode is 'off'.
    credentialedIntegration: { toolType: 'email_account' },
    // VAULT-AUDIT P3.D1: org_id must come from an explicit input for the
    // agentic /api/internal/tools/execute path (server.js:5021 passes no
    // ctx.orgId) — still fall back to ctx.orgId for the chat path (consistent
    // with browser_login / browser_save_cookies above).
    execute: async (input, ctx = {}) => {
      const orgId = resolveToolOrgId(ctx, input);
      const credentialId = input.credential_id;
      const folder = input.folder || 'INBOX';
      const limit = Math.max(1, Math.min(Number(input.limit) || 10, 50));
      const unseenOnly = !!input.unseen_only;

      if (!credentialId || !orgId) {
        if (!orgId) {
          return { success: false, error: 'credential_resolve_failed', detail: 'No org_id available for email_read.' };
        }
        // quox#813: InboxQ keeps connected mailboxes in its own store, each
        // pointing at an email_account vault credential. That credential is
        // NOT used here without a vault assignment or org default (that would
        // make every email_read agent able to read the mailbox); instead the
        // error names the credential and the exact command that grants it.
        const accts = lookupInboxqAccounts(orgId).filter((a) => a && a.credentialId);
        const pick = accts.find((a) => a.pollEnabled !== false) || accts[0];
        const agent = ctx.agentId || ctx.agent_id || '<agent-id>';
        const detail = pick
          ? `No email_account credential is assigned to agent ${agent} and the org has no default. A connected InboxQ mailbox uses vault credential ${pick.credentialId}. Fix: \`quox vault assign --agent ${agent} --credential ${pick.credentialId} --tool-type email_account\` (this agent only) or \`quox vault set-default ${pick.credentialId}\` (org default).`
          : 'No email_account credential found: none was given, none is assigned to this agent or set as the org default, and no InboxQ mailbox is connected. Fix: connect a mailbox (`quox mail accounts`), or create one with `quox vault create --type email_account ... --set-default`.';
        return { success: false, error: 'credential_resolve_failed', detail };
      }

      // Resolve the vault credential server-side (same internal endpoint the
      // screencap service uses — services/screencap/server.js vaultClient.resolve).
      // The password is used ONLY below to open the IMAP connection and is
      // NEVER included in the return payload or logged.
      let credentials;
      try {
        const url = `${AUTH_BASE_URL}/setup/internal/credential-decrypt/${encodeURIComponent(credentialId)}?org_id=${encodeURIComponent(orgId)}`;
        const resp = await fetch(url, {
          headers: buildInternalServiceHeaders(),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          return { success: false, error: 'credential_resolve_failed' };
        }
        const data = await resp.json();
        credentials = data?.credentials || null;
      } catch {
        return { success: false, error: 'credential_resolve_failed' };
      }

      const imapHost = credentials?.imap_host;
      const imapPort = credentials?.imap_port;
      const username = credentials?.username;
      const password = credentials?.password;
      if (!imapHost || !username || !password) {
        return { success: false, error: 'not_an_imap_credential' };
      }

      // IMAP session lifecycle (connect/fetch/parse/logout) lives in
      // toolExecutors/email.js. `password` is passed through only to open
      // the connection and is never included in the result below.
      try {
        const result = await readMailbox({
          host: imapHost,
          port: imapPort,
          user: username,
          pass: password,
          folder,
          limit,
          unseenOnly,
          ...(_emailImapFlowOverride ? { ImapFlow: _emailImapFlowOverride } : {}),
          ...(_emailSimpleParserOverride ? { simpleParser: _emailSimpleParserOverride } : {}),
        });
        return { success: true, ...result };
      } catch (err) {
        // Never surface the password in the error detail.
        const safeDetail = err?.message ? String(err.message).slice(0, 300) : 'IMAP connection failed';
        return { success: false, error: 'imap_error', detail: safeDetail };
      }
    }
  },

  // ==========================================================================
  // VAULT-AUDIT P3.D3 — Email Tools (SMTP send via vault credential)
  // ==========================================================================

  email_send: {
    name: 'email_send',
    // QUOXTRUST C2/WP2: external effect with its OWN in-execute ledger hooks
    // (claim/dispatch/resolve at the adapter boundary) — the choke must not double-claim.
    externalEffect: true,
    selfLedgers: true,
    description: 'Send an email using a vault email_account credential over SMTP. ALWAYS goes through the approval gate: you propose the send, a human approves the exact recipients/subject/body before anything leaves the org mailbox (quox#590). The credential password is resolved server-side and never leaves the collector — only send status (messageId/accepted/rejected) is returned. credential_id is optional — omit it to let the platform resolve the agent\'s assigned/org-default email_account credential automatically.',
    input_schema: {
      type: 'object',
      properties: {
        credential_id: { type: 'string', description: 'Vault credential reference ID for the email_account credential. Optional — if omitted, resolved automatically for this agent (agent assignment -> org default -> instance -> env), lease-gated by the org\'s vault enforcement mode.' },
        org_id: { type: 'string', description: 'Organisation ID that owns the credential' },
        to: { description: 'Recipient address(es) — string or array of strings' },
        subject: { type: 'string', description: 'Message subject' },
        text: { type: 'string', description: 'Plain text message body' },
        cc: { description: 'CC address(es) — string or array of strings' },
        bcc: { description: 'BCC address(es) — string or array of strings' },
        html: { type: 'string', description: 'Optional HTML message body' }
      },
      required: ['org_id', 'to', 'subject', 'text']
    },
    // VAULT-AUDIT P5.L (email tool retrofit) — see email_read above for the
    // credentialedIntegration/dispatch-hook rationale.
    credentialedIntegration: { toolType: 'email_account' },
    // VAULT-AUDIT P3.D3: org_id must come from an explicit input for the
    // agentic /api/internal/tools/execute path (server.js:5021 passes no
    // ctx.orgId) — still fall back to ctx.orgId for the chat path (consistent
    // with email_read above).
    execute: async (input, ctx = {}) => {
      // quox#590: external send is gated by the STRONG approval path
      // (withApprovalGate: token verified against the stored row, input
      // fingerprint bound to what was approved) and email_send is in
      // AGENT_ALWAYS_PROPOSE_TOOLS, so the first call ALWAYS files a
      // human-confirmable proposal — the weak presence-only _approvalId
      // check in the generic dispatcher can no longer be the only gate.
      return await withApprovalGate('email_send', input, async () => {
      const orgId = resolveToolOrgId(ctx, input);
      const credentialId = input.credential_id;

      if (!credentialId || !orgId) {
        return { success: false, error: 'credential_resolve_failed' };
      }

      // Resolve the vault credential server-side (same internal endpoint
      // email_read uses). The password is used ONLY below to open the SMTP
      // transport and is NEVER included in the return payload or logged.
      let credentials;
      try {
        const url = `${AUTH_BASE_URL}/setup/internal/credential-decrypt/${encodeURIComponent(credentialId)}?org_id=${encodeURIComponent(orgId)}`;
        const resp = await fetch(url, {
          headers: buildInternalServiceHeaders(),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          return { success: false, error: 'credential_resolve_failed' };
        }
        const data = await resp.json();
        credentials = data?.credentials || null;
      } catch {
        return { success: false, error: 'credential_resolve_failed' };
      }

      const smtpHost = credentials?.smtp_host;
      if (!smtpHost) {
        return { success: false, error: 'no_smtp_host' };
      }
      const smtpPort = credentials?.smtp_port || 587;
      const smtpSecure = credentials?.smtp_secure !== undefined ? !!credentials.smtp_secure : Number(smtpPort) === 465;
      const username = credentials?.username;
      const password = credentials?.password;
      const from = credentials?.from || username;

      // QUOXTRUST T3 — durable execution intent BEFORE the irreversible SMTP send.
      // A crash between dispatch and resolve leaves outcome_unknown (never a silent
      // loss, never a blind resend of a possibly-accepted message); if the durable
      // write itself fails while the ledger is configured, the send is REFUSED (no
      // dispatch without durable intent). Digest binds WHICH message (recipients +
      // subject), never the body/credentials.
      // C2 rule 4 (WP2): null ledger store REFUSES the send (same contract as
      // the choke gate — unavailable is not absent); digest upgraded to the C3
      // effect identity so intent and receipt join on the same key.
      if (!_executionLedgerDb) {
        return { success: false, error: 'execution_ledger_unavailable', detail: 'email_send is an external effect and cannot run without durable intent (fail-closed, C2 rule 1)' };
      }
      const ledgerOn = true;
      let intentId = null;
      {
        try {
          intentId = _executionLedger.claim(_executionLedgerDb, {
            orgId,
            tool: 'email_send',
            actionDigest: (ctx._canonicalAction && ctx._canonicalAction.effect_id)
              || _executionLedger.actionDigest({ to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject }),
            corr: ctx.corr || ctx.session_id || null,
          });
          _executionLedger.markDispatched(_executionLedgerDb, intentId);
        } catch (ledgerErr) {
          console.error('[agentTools] email_send execution ledger write failed; failing closed:', ledgerErr.message);
          return { success: false, error: 'execution_ledger_unavailable', detail: 'the durable record could not be written, so this email was not sent' };
        }
        // WP4.2: this selfLedgers path runs its own claim/resolve outside the
        // choke, so it never got the choke's WP4.1b obligation write — invisible
        // to the reconciler's completeness join on intent_id. Mirror it here,
        // best-effort (a missing obligation degrades to the reconciler's
        // completeness check; it must never block a send already claimed).
        try {
          let _obCommit = null;
          try { _obCommit = ctx._canonicalAction ? actionEvidenceCommitment(ctx._canonicalAction) : null; } catch { _obCommit = null; }
          _executionLedger.recordObligation(_executionLedgerDb, intentId, {
            orgId,
            tool: 'email_send',
            corr: ctx.corr || ctx.session_id || null,
            ctx: { agentId: ctx.agentId, userId: ctx.userId, orgId, evidenceSource: 'email_send' },
            actionCommit: _obCommit,
          });
        } catch (obErr) {
          console.warn(`[agentTools] WP4.2 obligation record failed for email_send (${intentId}): ${obErr.message}`);
        }
      }

      // SMTP transport lifecycle lives in toolExecutors/emailSend.js.
      // `password` is passed through only to authenticate the connection and
      // is never included in the result below.
      try {
        const result = await sendMail({
          host: smtpHost,
          port: smtpPort,
          secure: smtpSecure,
          user: username,
          pass: password,
          from,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          text: input.text,
          html: input.html,
          ...(_emailNodemailerOverride ? { nodemailer: _emailNodemailerOverride } : {}),
        });
        // DELIVERY HONESTY (owner gripe / quox#606): sendMail NOT throwing != delivered. nodemailer
        // returns accepted[]/rejected[] — the SMTP server can accept the connection yet reject every
        // recipient (bad address, policy). If NO recipient was accepted, the send FAILED even though
        // no exception was raised: report it and do NOT mark the durable obligation delivered (so the
        // evidence trail never claims a delivery that did not happen). A PARTIAL (some accepted, some
        // rejected) is reported success:true but flagged partial with the rejected list, so
        // "accepted != delivered" is never silently hidden.
        const _accepted = Array.isArray(result.accepted) ? result.accepted : [];
        const _rejected = Array.isArray(result.rejected) ? result.rejected : [];
        if (_accepted.length === 0) {
          if (ledgerOn) {
            try { _executionLedger.resolve(_executionLedgerDb, intentId, false, new Error('all_recipients_rejected')); } catch (_) { /* reconcile covers it */ }
          }
          return { success: false, error: 'delivery_rejected', detail: 'the SMTP server accepted no recipients (accepted != delivered)', ...result };
        }
        if (ledgerOn) {
          try { _executionLedger.resolve(_executionLedgerDb, intentId, true); } catch (_) { /* reconcile covers it */ }
          // WP4.2: settle the obligation on the SAME confirmed exit, no envelope
          // id captured at this site — the reconciler handles delivered-without-
          // envelope-id (candidate discovery is not tag-dependent).
          try { _executionLedger.markObligationDelivered(_executionLedgerDb, intentId, null); } catch (_) { /* stays owed; boot re-emit surfaces it */ }
        }
        // ContactsQ P3b: outbound touchpoint for each accepted recipient that is a known contact.
        // Fail-soft, idempotent per send (ref = ledger intent id), no content, never blocks the result.
        try { require('./contactsq/identityShim.js').recordSent(orgId, _accepted, intentId || result.messageId); } catch (_) { /* ContactsQ must never affect a send */ }
        return { success: true, ...(_rejected.length > 0 ? { partial: true } : {}), ...result };
      } catch (err) {
        // T3: pre-send/most SMTP errors are a definite failure. RESIDUAL (honest):
        // a timeout after the message hit the wire is ambiguous and recorded here
        // as failed rather than outcome_unknown; a process CRASH mid-send is the
        // case reconcileOnBoot flags unknown.
        if (ledgerOn) { try { _executionLedger.resolve(_executionLedgerDb, intentId, false, err); } catch (_) { /* reconcile covers it */ } }
        // Never surface the password in the error detail.
        const safeDetail = err?.message ? String(err.message).slice(0, 300) : 'SMTP send failed';
        return { success: false, error: 'smtp_error', detail: safeDetail };
      }
      }, ctx);
    }
  },

  // ==========================================================================
  // VAULT-AUDIT P4.B — tls_cert_info (vault tls_cert credential parser)
  // ==========================================================================

  tls_cert_info: {
    name: 'tls_cert_info',
    description: 'Parse a vault tls_cert credential\'s public certificate and return metadata (subject/issuer/expiry/fingerprint). The credential is resolved server-side; only PUBLIC certificate metadata is returned — the private key never leaves the collector and is never included in the result.',
    input_schema: {
      type: 'object',
      properties: {
        credential_id: { type: 'string', description: 'Vault credential reference ID for the tls_cert credential' },
        org_id: { type: 'string', description: 'Organisation ID that owns the credential' }
      },
      required: ['credential_id', 'org_id']
    },
    // VAULT-AUDIT P4.B: org_id must come from an explicit input for the
    // agentic /api/internal/tools/execute path (server.js:5021 passes no
    // ctx.orgId) — still fall back to ctx.orgId for the chat path (consistent
    // with email_read/email_send above).
    execute: async (input, ctx = {}) => {
      const orgId = resolveToolOrgId(ctx, input);
      const credentialId = input.credential_id;

      if (!credentialId || !orgId) {
        return { success: false, error: 'credential_resolve_failed' };
      }

      // Resolve the vault credential server-side (same internal endpoint
      // email_read/email_send use). SECURITY: `credentials.private_key`, if
      // present, is NEVER read below — only `credentials.certificate` is
      // touched, and only the public metadata parseCertificate() derives
      // from it is ever returned.
      let credentials;
      try {
        const url = `${AUTH_BASE_URL}/setup/internal/credential-decrypt/${encodeURIComponent(credentialId)}?org_id=${encodeURIComponent(orgId)}`;
        const resp = await fetch(url, {
          headers: buildInternalServiceHeaders(),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          return { success: false, error: 'credential_resolve_failed' };
        }
        const data = await resp.json();
        credentials = data?.credentials || null;
      } catch {
        return { success: false, error: 'credential_resolve_failed' };
      }

      const certificatePem = credentials?.certificate;
      if (!certificatePem) {
        return { success: false, error: 'no_certificate' };
      }

      try {
        const metadata = parseCertificate(certificatePem);
        return { success: true, ...metadata };
      } catch {
        // Never surface parser internals — could echo back input.
        return { success: false, error: 'invalid_certificate' };
      }
    }
  },

  // ==========================================================================
  // VAULT-AUDIT P4.A-collector — remote_ssh (SSH exec via vault ssh_key credential)
  // ==========================================================================

  // NOTE: deliberately NOT named `ssh_exec` — that name is the bastion-routed
  // tool already deeply embedded across system prompts and quoxflow crystals.
  // This is a distinct, vault-credential-scoped SSH tool with TOFU host-key
  // verification against the P4.A-auth ssh-known-hosts store.
  remote_ssh: {
    name: 'remote_ssh',
    // QUOXTRUST C2/WP2: reaches outside the box — durable intent gated at the choke.
    // (Caught by the w-t3 fail-closed sweep on 2026-09-28: outward, unreviewed.)
    externalEffect: true,
    // QUOXTRUST T5/T9 (FND_..SCFP): arbitrary shell exec from model-filled input.command
    // via a vault SSH credential (direct SSH, not the bastion) is one of the most
    // dangerous native tools — it MUST require human approval by default, exactly like
    // docker_fleet_container_action / proxmox_vm_action, not merely rely on the
    // allow-by-default GOV-4 monitor. gatedInExecute so the dispatch stamp lands at the
    // real effect boundary via ctx._markDispatched (approvalGate), not pre-execute.
    gatedInExecute: true,
    description: 'Run a command on a remote host over SSH using a vault ssh_key credential. The private key is resolved server-side, used only in-memory to open the connection, and never leaves the collector. Host keys are verified trust-on-first-use against the org\'s known-hosts store — a changed host key (possible MITM) hard-fails the connection before any command runs.',
    input_schema: {
      type: 'object',
      properties: {
        credential_id: { type: 'string', description: 'Vault credential reference ID for the ssh_key credential' },
        org_id: { type: 'string', description: 'Organisation ID that owns the credential' },
        command: { type: 'string', description: 'Shell command to execute on the remote host' },
        host: { type: 'string', description: 'Target host (defaults to the credential\'s stored host)' },
        port: { type: 'number', description: 'SSH port (default 22)' },
        username: { type: 'string', description: 'SSH username (defaults to the credential\'s stored username)' }
      },
      required: ['credential_id', 'org_id', 'command']
    },
    // VAULT-AUDIT P4.A-collector: org_id must come from an explicit input for
    // the agentic /api/internal/tools/execute path (server.js:5021 passes no
    // ctx.orgId) — still fall back to ctx.orgId for the chat path (consistent
    // with email_read/email_send/tls_cert_info above).
    execute: async (input, ctx = {}) => {
      const orgId = resolveToolOrgId(ctx, input);
      const credentialId = input.credential_id;
      const command = input.command;

      if (!credentialId || !orgId) {
        return { success: false, error: 'credential_resolve_failed' };
      }

      // Resolve the vault credential server-side (same internal endpoint
      // email_read/email_send/tls_cert_info use). SECURITY: `private_key`
      // (and `passphrase`, if present) are used ONLY below to open the SSH
      // connection and are NEVER included in the return payload or logged.
      let credentials;
      try {
        const url = `${AUTH_BASE_URL}/setup/internal/credential-decrypt/${encodeURIComponent(credentialId)}?org_id=${encodeURIComponent(orgId)}`;
        const resp = await fetch(url, {
          headers: buildInternalServiceHeaders(),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          return { success: false, error: 'credential_resolve_failed' };
        }
        const data = await resp.json();
        credentials = data?.credentials || null;
      } catch {
        return { success: false, error: 'credential_resolve_failed' };
      }

      const privateKey = credentials?.private_key;
      if (!privateKey) {
        return { success: false, error: 'not_an_ssh_credential' };
      }
      const passphrase = credentials?.passphrase;

      const host = input.host || credentials?.host;
      if (!host) {
        return { success: false, error: 'ssh_host_required' };
      }
      const username = input.username || credentials?.username;
      if (!username) {
        return { success: false, error: 'ssh_username_required' };
      }
      const port = input.port || 22;

      // TOFU host-key verification against the P4.A-auth ssh-known-hosts
      // store. 200 {status: first_use|ok} => proceed; 409 {status: drift} =>
      // HARD FAIL, abort before connecting. Thrown/non-2xx (other than 409)
      // is treated the same as drift — fail closed rather than connect blind.
      const verifyHostKey = async (fingerprint, keyType) => {
        const resp = await fetch(`${AUTH_BASE_URL}/setup/internal/ssh-known-host`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...buildInternalServiceHeaders() },
          body: JSON.stringify({ org_id: orgId, host, port, fingerprint, key_type: keyType }),
          signal: AbortSignal.timeout(15000),
        });
        if (resp.status === 409) {
          return { status: 'drift' };
        }
        if (!resp.ok) {
          throw new Error(`ssh-known-host verification failed with status ${resp.status}`);
        }
        return await resp.json();
      };

      // SSH connection lifecycle (connect/verify/exec/disconnect) lives in
      // toolExecutors/ssh.js. `privateKey`/`passphrase` are passed through
      // only to open the connection and are never included in the result.
      const _runSsh = async () => {
        try {
          const result = await runSshCommand({
            host,
            port,
            username,
            privateKey,
            passphrase,
            command,
            verifyHostKey,
            ...(_sshClientOverride ? { Client: _sshClientOverride } : {}),
          });
          return { success: true, ...result };
        } catch (err) {
          if (err?.code === 'HOST_KEY_DRIFT') {
            return { success: false, error: 'host_key_drift' };
          }
          // Never surface the private key/passphrase in the error detail.
          const safeDetail = err?.message ? String(err.message).slice(0, 300) : 'SSH command failed';
          return { success: false, error: 'ssh_error', detail: safeDetail };
        }
      };
      // QUOXTRUST T5/T9 (FND_..SCFP): arbitrary shell from model-filled input.command MUST
      // require human approval by default (like docker/proxmox/email), not merely rely on
      // the allow-by-default GOV-4 monitor. A PROVABLY read-only command (the shared,
      // injection-proof fleet-read allowlist — no shell metachars, read-only binaries only)
      // runs directly; ANYTHING ELSE is held for approval binding the exact command+host.
      // gatedInExecute means the choke does not pre-stamp dispatch: on the direct path we
      // stamp it ourselves (a read IS a dispatch); on the gated path withApprovalGate does.
      const _isReadCmd = _getFleetReadClassifier();
      if (_isReadCmd(command)) {
        if (typeof ctx._markDispatched === 'function') ctx._markDispatched();
        return await _runSsh();
      }
      const _sshGateInput = {
        command, host, port, username, credential_id: credentialId, org_id: orgId,
        ...(input._approvalId ? { _approvalId: input._approvalId } : {}),
        ...(input._resumeToken ? { _resumeToken: input._resumeToken } : {}),
      };
      return await withApprovalGate('remote_ssh', _sshGateInput, _runSsh, ctx);
    }
  },

  // ==========================================================================
  // VAULT-AUDIT P4.C — db_query (SQL query via vault database credential)
  // ==========================================================================

  db_query: {
    name: 'db_query',
    description: 'Run a SQL query against a Postgres database using a vault database credential. The password is resolved server-side, used only in-memory to open the connection, and never leaves the collector. Read-only by default — the query runs inside a READ ONLY transaction unless allow_write is explicitly set to true.',
    input_schema: {
      type: 'object',
      properties: {
        credential_id: { type: 'string', description: 'Vault credential reference ID for the database credential' },
        org_id: { type: 'string', description: 'Organisation ID that owns the credential' },
        query: { type: 'string', description: 'SQL query to run' },
        params: { type: 'array', description: 'Optional positional parameters for a parameterized query (e.g. $1, $2)', items: {} },
        allow_write: { type: 'boolean', description: 'Set true to allow write statements (default false = read-only transaction)' }
      },
      required: ['credential_id', 'org_id', 'query']
    },
    // VAULT-AUDIT P4.C: org_id must come from an explicit input for the
    // agentic /api/internal/tools/execute path — still fall back to
    // ctx.orgId for the chat path (consistent with email_read/remote_ssh
    // above).
    execute: async (input, ctx = {}) => {
      const orgId = resolveToolOrgId(ctx, input);
      const credentialId = input.credential_id;
      const query = input.query;

      if (!credentialId || !orgId) {
        return { success: false, error: 'credential_resolve_failed' };
      }

      // Resolve the vault credential server-side (same internal endpoint
      // email_read/remote_ssh use). SECURITY: `credentials.password` (or the
      // password embedded in `credentials.connection_string`) is used ONLY
      // below to open the DB connection and is NEVER included in the return
      // payload or logged.
      let credentials;
      try {
        const url = `${AUTH_BASE_URL}/setup/internal/credential-decrypt/${encodeURIComponent(credentialId)}?org_id=${encodeURIComponent(orgId)}`;
        const resp = await fetch(url, {
          headers: buildInternalServiceHeaders(),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          return { success: false, error: 'credential_resolve_failed' };
        }
        const data = await resp.json();
        credentials = data?.credentials || null;
      } catch {
        return { success: false, error: 'credential_resolve_failed' };
      }

      let connectionConfig;
      if (credentials?.connection_string) {
        connectionConfig = { connectionString: credentials.connection_string };
      } else if (credentials?.host && credentials?.database && credentials?.username && credentials?.password) {
        connectionConfig = {
          host: credentials.host,
          port: Number(credentials.port) || 5432,
          database: credentials.database,
          user: credentials.username,
          password: credentials.password,
        };
      } else {
        return { success: false, error: 'not_a_db_credential' };
      }

      // Query lifecycle (connect/[readonly-tx]/query/disconnect) lives in
      // toolExecutors/db.js. `connectionConfig` (and the password within
      // it) is passed through only to open the connection and is never
      // included in the result.
      const _runQuery = async () => {
        try {
          const result = await runQuery({
            connectionConfig,
            query,
            params: input.params || [],
            readonly: !input.allow_write,
            ...(_pgClientOverride ? { Client: _pgClientOverride } : {}),
          });
          return { success: true, ...result };
        } catch (err) {
          // Never surface connectionConfig/password in the error detail.
          const safeDetail = err?.message ? String(err.message).slice(0, 300) : 'DB query failed';
          return { success: false, error: 'query_error', detail: safeDetail };
        }
      };
      // QUOXTRUST T5/T9 (FND_..SCFP): a WRITE query (allow_write:true) from model-filled
      // input is a consequential effect and MUST require human approval by default — the
      // read-only path (READ ONLY transaction) stays ungated (no UX regression for the
      // common read case). The approval binds the exact query + write intent.
      if (input.allow_write) {
        const _dbGateInput = {
          query, allow_write: true, credential_id: credentialId, org_id: orgId,
          ...(input._approvalId ? { _approvalId: input._approvalId } : {}),
          ...(input._resumeToken ? { _resumeToken: input._resumeToken } : {}),
        };
        return await withApprovalGate('db_query', _dbGateInput, _runQuery, ctx);
      }
      return await _runQuery();
    }
  },

  // ==========================================================================
  // Browser-Q Recording & Replay Tools (BQ-4)
  // ==========================================================================

  browser_record_start: {
    name: 'browser_record_start',
    description: 'Start recording a sequence of browser actions. All subsequent browser actions on this session will be captured as steps until recording is stopped.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the recording (e.g. "Login to Hetzner")' },
        description: { type: 'string', description: 'Optional description of what this sequence does' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: ['name']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_record_start', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_record_start' };
    }
  },

  browser_record_stop: {
    name: 'browser_record_stop',
    description: 'Stop recording and return the captured sequence. The sequence can then be saved to the library or replayed.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_record_stop', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_record_stop' };
    }
  },

  browser_replay: {
    name: 'browser_replay',
    description: 'Replay a saved sequence of browser actions. Supports variable substitution ({{name}} syntax) and self-healing when selectors change.',
    input_schema: {
      type: 'object',
      properties: {
        sequence_id: { type: 'string', description: 'ID of a saved sequence to replay' },
        inline_sequence: { type: 'object', description: 'An inline sequence object to replay' },
        org_id: { type: 'string', description: 'Organisation ID (required when using sequence_id)' },
        variables: { type: 'object', description: 'Variable substitutions, e.g. { "username": "admin@test.com" }' },
        self_heal: { type: 'boolean', description: 'Enable self-healing when selectors fail (default: true)' },
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_replay', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(120000) // Long timeout — replays can take a while
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_replay' };
    }
  },

  browser_sequence_save: {
    name: 'browser_sequence_save',
    description: 'Save a recorded sequence to the org sequence library for later replay.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Organisation ID' },
        sequence: { type: 'object', description: 'The sequence object to save' }
      },
      required: ['org_id', 'sequence']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_sequence_save', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_sequence_save' };
    }
  },

  browser_sequence_list: {
    name: 'browser_sequence_list',
    description: 'List all saved sequences for an organisation.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Organisation ID' }
      },
      required: ['org_id']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_sequence_list', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_sequence_list' };
    }
  },

  browser_sequence_load: {
    name: 'browser_sequence_load',
    description: 'Load a saved sequence by ID.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Organisation ID' },
        sequence_id: { type: 'string', description: 'Sequence ID to load' }
      },
      required: ['org_id', 'sequence_id']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_sequence_load', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_sequence_load' };
    }
  },

  browser_sequence_delete: {
    name: 'browser_sequence_delete',
    description: 'Delete a saved sequence from the library.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Organisation ID' },
        sequence_id: { type: 'string', description: 'Sequence ID to delete' }
      },
      required: ['org_id', 'sequence_id']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_sequence_delete', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_sequence_delete' };
    }
  },

  // ==========================================================================
  // Browser-Q Video Recording Tools (BQ-5.5)
  // ==========================================================================

  browser_video_start: {
    name: 'browser_video_start',
    description: 'Start recording a browser session as video. Captures screenshots at a configurable frame rate and later stitches them into MP4 using ffmpeg.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' },
        fps: { type: 'number', description: 'Frames per second: 1-5 (default: 2)' },
        metadata: { type: 'object', description: 'Optional metadata to tag the video (url, actions, notes)' }
      },
      required: []
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_video_start', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_video_start' };
    }
  },

  browser_video_stop: {
    name: 'browser_video_stop',
    description: 'Stop recording and assemble the captured frames into an MP4 video. Returns video path, duration, and file size.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session ID (default: "default")' },
        org_id: { type: 'string', description: 'Organisation ID for video storage' },
        cleanup: { type: 'boolean', description: 'Delete frame files after assembly (default: true)' }
      },
      required: ['org_id']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_video_stop', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(60000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_video_stop' };
    }
  },

  browser_video_list: {
    name: 'browser_video_list',
    description: 'List all recorded videos for an organisation.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Organisation ID' }
      },
      required: ['org_id']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_video_list', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_video_list' };
    }
  },

  browser_video_delete: {
    name: 'browser_video_delete',
    description: 'Delete a recorded video and its metadata.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Organisation ID' },
        video_id: { type: 'string', description: 'Video ID to delete' }
      },
      required: ['org_id', 'video_id']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_video_delete', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_video_delete' };
    }
  },

  // ==========================================================================
  // Browser-Q Visual Monitoring Tools (BQ-5)
  // ==========================================================================

  browser_monitor_create: {
    name: 'browser_monitor_create',
    description: 'Create a new visual monitor for a URL. Captures periodic screenshots and detects visual changes using pixel-level comparison.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Organisation ID' },
        url: { type: 'string', description: 'URL to monitor' },
        name: { type: 'string', description: 'Human-readable name for this monitor' },
        cron_expression: { type: 'string', description: 'Cron expression for check schedule (e.g. "0 * * * *" for hourly)' },
        threshold: { type: 'number', description: 'Pixel diff percentage threshold to trigger alerts (default: 5)' },
        login_credential_id: { type: 'string', description: 'Optional vault credential ID for authenticated pages' }
      },
      required: ['org_id', 'url', 'name', 'cron_expression']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_monitor_create', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_monitor_create' };
    }
  },

  browser_monitor_list: {
    name: 'browser_monitor_list',
    description: 'List all visual monitors for an organisation with their last check status.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Organisation ID' }
      },
      required: ['org_id']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_monitor_list', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_monitor_list' };
    }
  },

  browser_monitor_check: {
    name: 'browser_monitor_check',
    description: 'Run an immediate visual check for a monitor. Captures screenshot, compares to baseline, creates alerts if changes exceed threshold.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Organisation ID' },
        monitor_id: { type: 'string', description: 'Monitor ID to check' },
        session_id: { type: 'string', description: 'Browser session ID to use (optional)' }
      },
      required: ['org_id', 'monitor_id']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_monitor_check', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(60000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_monitor_check' };
    }
  },

  // ==========================================================================
  // Browser Objective Tools (BQ-W2-1) — proxy to screencap service
  // ==========================================================================

  browser_objective_create: {
    name: 'browser_objective_create',
    description: 'Create a new browser automation objective. The user describes a URL and intent (plain English), and this creates an objective ready for step planning.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Organisation ID' },
        user_id: { type: 'string', description: 'User ID' },
        url: { type: 'string', description: 'Target URL for the automation' },
        intent: { type: 'string', description: 'Plain-English description of what to accomplish' }
      },
      required: ['org_id', 'url', 'intent']
    },
    execute: async (input, ctx) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      // Thread the chat correlation ID through to the objective
      const enrichedInput = { ...input, corr_id: input.corr_id || ctx?.session_id || null };
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_objective_create', input: enrichedInput, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_objective_create' };
    }
  },

  browser_objective_plan: {
    name: 'browser_objective_plan',
    description: 'Set the step plan on a browser objective. Provide an array of steps with action + params. Available actions: navigate, click, type, extract, scroll, select, wait, fill_form, login.',
    input_schema: {
      type: 'object',
      properties: {
        objective_id: { type: 'string', description: 'Objective ID' },
        steps: {
          type: 'array',
          description: 'Array of { action, params, description } step objects',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              params: { type: 'object' },
              description: { type: 'string' }
            },
            required: ['action', 'params']
          }
        }
      },
      required: ['objective_id', 'steps']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_objective_plan', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_objective_plan' };
    }
  },

  browser_objective_execute: {
    name: 'browser_objective_execute',
    description: 'Start or resume execution of a planned browser objective. Steps execute sequentially; HITL steps pause for approval. Progress is streamed via SSE.',
    input_schema: {
      type: 'object',
      properties: {
        objective_id: { type: 'string', description: 'Objective ID to execute' },
        session_id: { type: 'string', description: 'Browser session ID (optional)' }
      },
      required: ['objective_id']
    },
    execute: async (input, ctx) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      const enrichedInput = { ...input, corr_id: input.corr_id || ctx?.session_id || null };
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_objective_execute', input: enrichedInput, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(120000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_objective_execute' };
    }
  },

  browser_objective_run: {
    name: 'browser_objective_run',
    description: 'One-shot browser objective: create, auto-generate a plan via LLM, and start execution — all in one call. Use this when you need to browse a website, fill a form, take a screenshot, or extract data. Returns immediately; execution runs in background.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Organisation ID' },
        user_id: { type: 'string', description: 'User ID (default: system)' },
        url: { type: 'string', description: 'Target URL' },
        intent: { type: 'string', description: 'Plain-English description of what to accomplish' },
        credential_id: { type: 'string', description: 'Vault credential ID for login (optional)' },
        needs_login: { type: 'boolean', description: 'Whether the task requires authentication' }
      },
      required: ['org_id', 'url', 'intent']
    },
    execute: async (input, ctx) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      const enrichedInput = { ...input, corr_id: input.corr_id || ctx?.session_id || null };
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_objective_run', input: enrichedInput, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(120000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_objective_run' };
    }
  },

  browser_objective_approve_step: {
    name: 'browser_objective_approve_step',
    description: 'Approve a HITL-paused step (e.g. login, payment) so the objective can continue execution.',
    input_schema: {
      type: 'object',
      properties: {
        objective_id: { type: 'string', description: 'Objective ID' },
        step_id: { type: 'string', description: 'Step ID to approve' }
      },
      required: ['objective_id', 'step_id']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_objective_approve_step', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_objective_approve_step' };
    }
  },

  browser_objective_cancel: {
    name: 'browser_objective_cancel',
    description: 'Cancel a running or paused browser objective.',
    input_schema: {
      type: 'object',
      properties: {
        objective_id: { type: 'string', description: 'Objective ID to cancel' }
      },
      required: ['objective_id']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_objective_cancel', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_objective_cancel' };
    }
  },

  browser_objective_list: {
    name: 'browser_objective_list',
    description: 'List browser automation objectives for an organisation.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Organisation ID' },
        limit: { type: 'number', description: 'Max results (default 20)' }
      },
      required: ['org_id']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_objective_list', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_objective_list' };
    }
  },

  browser_objective_get: {
    name: 'browser_objective_get',
    description: 'Get full details of a browser objective including all steps, results, and screenshots.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Organisation ID' },
        objective_id: { type: 'string', description: 'Objective ID' }
      },
      required: ['org_id', 'objective_id']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_objective_get', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_objective_get' };
    }
  },

  browser_objective_save_sequence: {
    name: 'browser_objective_save_sequence',
    description: 'Save a completed browser objective as a reusable automation sequence.',
    input_schema: {
      type: 'object',
      properties: {
        objective_id: { type: 'string', description: 'Objective ID (must be completed)' }
      },
      required: ['objective_id']
    },
    execute: async (input) => {
      const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
      const serviceKey = process.env.INTERNAL_SERVICE_KEY;
      try {
        const resp = await fetch(`${screencapUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
          body: JSON.stringify({ tool_id: 'browser_objective_save_sequence', input, agent_id: 'browser-q' }),
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) { const data = await resp.json(); return data.result || data; }
      } catch { /* fallthrough */ }
      return { success: false, error: 'ScreenCap service unavailable for browser_objective_save_sequence' };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════
  //  GOLDENEYE Tools — Spatial observation, health scanning, guided tours
  // ═══════════════════════════════════════════════════════════════════════

  spatial_search: {
    name: 'spatial_search',
    description: 'Search the Cognitive Core 3D spatial map for entities by name, type, or state. Returns world positions and status for matching agents, implants, services, or objectives.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query — entity name, type, or state (e.g. "WARDEN", "blocked agents", "degraded implants")' },
        type: { type: 'string', enum: ['agent', 'implant', 'service', 'objective', 'all'], description: 'Filter by entity type', default: 'all' },
        state: { type: 'string', description: 'Filter by state (e.g. "blocked", "executing", "degraded")' }
      },
      required: ['query']
    },
    execute: async (input) => {
      const results = [];
      const q = (input.query || '').toLowerCase();
      const typeFilter = input.type || 'all';
      const stateFilter = input.state?.toLowerCase();

      // Search agents
      if (typeFilter === 'all' || typeFilter === 'agent') {
        try {
          const resp = await localApiFetch('/api/v1/agents', { signal: AbortSignal.timeout(3000) }, { assertOk: false });
          if (resp.ok) {
            const agents = await resp.json();
            for (const a of (Array.isArray(agents) ? agents : [])) {
              const name = (a.host_id || a.id || '').toLowerCase();
              const state = (a.connection_status || 'unknown').toLowerCase();
              if (name.includes(q) || q.includes('agent') || (stateFilter && state.includes(stateFilter))) {
                results.push({ type: 'agent', id: a.host_id || a.id, name: a.host_id, state, source: 'fleet' });
              }
            }
          }
        } catch {}
      }

      // Search services
      if (typeFilter === 'all' || typeFilter === 'service') {
        const services = ['collector', 'quoxflow', 'auth', 'memory', 'tasks', 'dashboard', 'qdrant', 'postgres'];
        for (const svc of services) {
          if (svc.includes(q) || q.includes('service')) {
            results.push({ type: 'service', id: svc, name: svc, state: 'unknown', source: 'registry' });
          }
        }
      }

      // Search by state keyword
      if (q.includes('blocked') || q.includes('stuck') || q.includes('stale')) {
        results.push({ type: 'query', id: 'state-filter', name: `Entities matching "${q}"`, state: q, note: 'CC3D will highlight matching nodes with beacon beams' });
      }

      return {
        success: true,
        query: input.query,
        results,
        count: results.length,
        hint: 'Results include world positions when viewed in Cognitive Core 3D'
      };
    }
  },

  health_scan: {
    name: 'health_scan',
    description: 'Run a comprehensive health scan of the Cognitive Core. Checks all agents, services, implants, and reports degraded or failing components.',
    input_schema: {
      type: 'object',
      properties: {
        detail: { type: 'string', enum: ['summary', 'full'], description: 'Level of detail', default: 'summary' }
      },
      required: []
    },
    execute: async (input) => {
      const report = { agents: {}, services: {}, summary: {} };
      const port = process.env.PORT || 9848;

      // Check fleet agents
      try {
        const resp = await localApiFetch('/api/v1/fleet/summary', { signal: AbortSignal.timeout(3000) }, { assertOk: false });
        if (resp.ok) {
          const data = await resp.json();
          report.agents = { connected: data.connected || 0, stale: data.stale || 0, dead: data.dead || 0, total: data.total || 0 };
        }
      } catch { report.agents = { error: 'Fleet API unreachable' }; }

      // Check core services
      const serviceChecks = [
        { name: 'collector', url: `http://127.0.0.1:${port}/health` },
        { name: 'quoxflow', url: 'http://quoxflow:4100/health' },
        { name: 'auth', url: 'http://auth:3101/health' },
        { name: 'memory', url: 'http://memory:3103/health' },
      ];

      for (const svc of serviceChecks) {
        try {
          const resp = await fetch(svc.url, { signal: AbortSignal.timeout(2000) });
          report.services[svc.name] = resp.ok ? 'healthy' : `degraded (${resp.status})`;
        } catch {
          report.services[svc.name] = 'unreachable';
        }
      }

      // Summary
      const healthyServices = Object.values(report.services).filter(s => s === 'healthy').length;
      const totalServices = Object.keys(report.services).length;
      const hasDeadAgents = (report.agents.dead || 0) > 0;
      const hasStaleAgents = (report.agents.stale || 0) > 0;

      report.summary = {
        overall: hasDeadAgents ? 'WARNING' : hasStaleAgents ? 'DEGRADED' : healthyServices === totalServices ? 'HEALTHY' : 'DEGRADED',
        services: `${healthyServices}/${totalServices} healthy`,
        agents: `${report.agents.connected || 0} connected, ${report.agents.stale || 0} stale, ${report.agents.dead || 0} dead`,
        recommendation: hasDeadAgents ? 'Dead agents detected — check fleet connectivity' :
          hasStaleAgents ? 'Stale agents — may need restart' :
          healthyServices < totalServices ? 'Some services degraded, check logs' :
          'All systems nominal'
      };

      return { success: true, ...report };
    }
  },

  guided_tour: {
    name: 'guided_tour',
    description: 'Generate a guided tour of the Cognitive Core 3D. Returns camera stops with narration based on current system state.',
    input_schema: {
      type: 'object',
      properties: {
        focus: { type: 'string', description: 'Tour focus: "overview", "health", "infra", "degraded"', default: 'overview' }
      },
      required: []
    },
    execute: async (input) => {
      const focus = (input.focus || 'overview').toLowerCase();

      // Get current system state for dynamic tour
      let fleetData = null;
      try {
        const resp = await localApiFetch('/api/v1/fleet/summary', { signal: AbortSignal.timeout(3000) }, { assertOk: false });
        if (resp.ok) fleetData = await resp.json();
      } catch {}

      const stops = [];

      if (focus === 'overview' || focus === 'health') {
        stops.push({ position: [0, 4, 8], label: 'Nucleus', narration: 'Starting at the core. The nucleus pulses with system health.', dwell: 5 });
        stops.push({ position: [10, 4, 0], label: 'Implants', narration: `Cognitive implants — the brain modules. Scanning for degraded nodes.`, dwell: 6 });
        stops.push({ position: [0, 7, 30], label: 'Agents', narration: `Agent mesh — ${fleetData?.connected || '?'} connected, ${fleetData?.stale || 0} stale.`, dwell: 6 });
      }

      if (focus === 'infra' || focus === 'health') {
        stops.push({ position: [12, -12, 22], label: 'Infrastructure', narration: 'Descending to the infrastructure tower. Docker containers, hosts, fleet.', dwell: 7 });
      }

      if (focus === 'overview') {
        stops.push({ position: [40, 12, 88], label: 'Execution', narration: 'Execution layer — objectives and tasks in orbit.', dwell: 5 });
        stops.push({ position: [0, 16, 115], label: 'Memory', narration: 'Memory lattice — knowledge crystals on orbital tracks.', dwell: 5 });
        stops.push({ position: [0, 20, 140], label: 'Shell', narration: 'The outer shell. Network boundaries. Tour complete.', dwell: 4 });
      }

      if (focus === 'degraded') {
        // Dynamic: only visit nodes that need attention
        if (fleetData?.dead > 0) stops.push({ position: [12, -26, 12], label: 'Dead Fleet Agents', narration: `${fleetData.dead} dead agent(s). Check connectivity.`, dwell: 8 });
        if (fleetData?.stale > 0) stops.push({ position: [12, -26, 12], label: 'Stale Agents', narration: `${fleetData.stale} stale agent(s). May need restart.`, dwell: 6 });
        if (stops.length === 0) stops.push({ position: [0, 4, 8], label: 'All Clear', narration: 'No degraded systems found. Everything nominal.', dwell: 5 });
      }

      return {
        success: true,
        tour: {
          name: `${focus.charAt(0).toUpperCase() + focus.slice(1)} Tour`,
          focus,
          stops,
          totalDuration: stops.reduce((sum, s) => sum + s.dwell, 0),
          generated: new Date().toISOString()
        }
      };
    }
  },

  codebase_query: {
    name: 'codebase_query',
    description: 'Search the Quox codebase for code definitions, functions, files, and patterns. Returns cited code snippets with file:line references. Use for: "where is X defined?", "how does Y work?", "what imports Z?"',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural language question about the codebase' },
        target: { type: 'string', description: 'Exact repo name to search. Default: quox-dashboard. Options: quox-dashboard, quoxflow, quoxbastion, quoxagent, quoxmcp, quoxterminal, quox-website, aee, aocl, volt, ward, quox-plugin-sdk' },
        max_snippets: { type: 'number', description: 'Max results to return (default: 4)' }
      },
      required: ['question']
    },
    execute: async (input) => {
      return await codebaseQuery(input);
    }
  },

  // TOOLSMITH tool-lifecycle capability (AGENT-OVERHAUL phase 7). TOOLSMITH
  // builds and validates tools; tools_doctor lets it audit the HEALTH of the
  // whole live tool surface. It answers "which of my tools actually work right
  // now?" — the question that left KEEPER + quoxagent broken and invisible all
  // session. Safety: driving logic lives in lib/toolDoctor.js and NEVER calls a
  // destructive or approval-gated tool; it only probes unambiguously read-only
  // ones. quox reaches this by delegating to toolsmith.
  tools_doctor: {
    name: 'tools_doctor',
    description: 'Run a live health probe across the whole agent tool surface. Safely drives every unambiguously read-only tool and classifies each as working, honest-error (config/input absent), auth-broken, or crashing; NEVER calls destructive or approval-gated tools. Returns a health matrix plus the actionable list of broken tools. Use to answer "which of my tools actually work right now?" and to verify after a deploy.',
    input_schema: {
      type: 'object',
      properties: {
        timeout_ms: { type: 'number', description: 'Per-tool probe timeout in ms (default 12000)' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      const { runDoctor } = require('./toolDoctor');
      const report = await runDoctor({
        TOOL_DEFS,
        ctx: { orgId: ctx?.orgId || 'default', userId: ctx?.userId },
        timeoutMs: input?.timeout_ms || 12000,
      });
      report.generatedAt = new Date().toISOString();
      return { success: true, ...report };
    }
  },

  // ROADMAP — read-only access to the strategic roadmap (STRATEGIC_ROADMAP.json,
  // the single source of truth). ROADY (Strategic Roadmap Navigator) could not do
  // its job without this: it only had stale brain docs, no live roadmap. Agents
  // READ only; the roadmap is mutated exclusively via the roadmap-cli by the owner.
  // The file is reachable via the collector's /opt/quoxcore mount on the dev host;
  // on environments without it, the tools return a clear "not available" result.
  roadmap_list: {
    name: 'roadmap_list',
    description: 'List strategic roadmap streams from the live roadmap (STRATEGIC_ROADMAP.json), newest priorities first. Filter by status, tier, or a text query. Use for "what is on the roadmap", "what is next", "what is in progress". Returns a compact list; use roadmap_show for full detail on one stream.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: NOT_STARTED, IN_PROGRESS, COMPLETE, BLOCKED, DECISION_NEEDED' },
        tier: { type: 'string', description: 'Filter by tier text match, e.g. "TIER 1" or "FLAGSHIP"' },
        query: { type: 'string', description: 'Free-text match against id, name, summary, tags' },
        include_completed: { type: 'boolean', description: 'Include the completed archive (default false)' },
        limit: { type: 'number', description: 'Max streams to return (default 25)' }
      },
      required: []
    },
    execute: async (input) => roadmapList(input)
  },

  roadmap_show: {
    name: 'roadmap_show',
    description: 'Show full detail of one roadmap stream by its id (e.g. "M-ROOMS", "GUARDRAILS") or priority number. Returns name, tier, status, phases, dependencies, notes, and plan doc.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stream id (e.g. CORECOMM-UX) or priority number' }
      },
      required: ['id']
    },
    execute: async (input) => roadmapShow(input)
  },

  roadmap_stats: {
    name: 'roadmap_stats',
    description: 'Summary counts of roadmap streams by status (active / pending / blocked / complete), plus totals. Use for "how many streams", "roadmap overview".',
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async () => roadmapStats()
  },

  // QUOXBRAIN P2a — pull mechanism: agent-initiated search of the org's
  // knowledge brain (decisions, docs, past conversations, governance,
  // evidence), separate from the push implant in lib/brainImplant.js.
  quoxbrain_search: {
    name: 'quoxbrain_search',
    description: 'Search the organization\'s knowledge brain — decisions, docs, past conversations, governance, evidence. Returns cited passages. Use for "what do we know / what did we decide / what\'s our policy on X". Access control is enforced by the server — never pass scopes/sources/vaultIds to try to see more; they can only narrow. If results are empty, say so honestly rather than retrying with broader filters.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language question to search the knowledge brain for' },
        limit: { type: 'number', description: 'Max results to return (default: 5)' },
        scopes: { type: 'array', items: { type: 'string', enum: ['org', 'user', 'shared'] }, description: 'ONLY when the user explicitly restricts where to look (e.g. "in my personal notes"). Omit otherwise — access is already enforced server-side; adding this narrows results and disables hybrid ranking.' },
        sources: { type: 'array', items: { type: 'string' }, description: 'ONLY when the user names a specific source. Omit otherwise.' },
        vaultIds: { type: 'array', items: { type: 'string' }, description: 'ONLY when the user names a specific vault. Omit otherwise.' },
        since: { type: 'string', description: 'ONLY when the user gives a time window (e.g. "since Monday"). ISO date or datetime (2026-10-05 or 2026-10-05T09:00:00Z); notes dated on or after it. Work out the date yourself. Omit otherwise.' },
        until: { type: 'string', description: 'ONLY when the user gives a time window. ISO date or datetime; notes dated on or before it (a date alone means the whole day). Omit otherwise.' }
      },
      required: ['query']
    },
    execute: async (input, ctx) => {
      // Tooling audit (2026-09-21, 4 witnesses): this wrapper hardcoded
      // success:true, so a DOWN brain ("Knowledge brain unavailable") and a
      // bad-input message both read as a green ✔ — a caller couldn't tell
      // "searched, nothing found" from "brain offline". Reflect real failure.
      if (!input || typeof input.query !== 'string' || !input.query.trim()) {
        return { success: false, error: 'query is required and must be a non-empty string', output: 'Missing required parameter: query' };
      }
      const output = await quoxbrainSearch(input, ctx);
      if (output === QUOXBRAIN_UNAVAILABLE_MSG) {
        return { success: false, error: 'knowledge_brain_unavailable', output };
      }
      // Empty results (a successful search with no hits) stays success:true —
      // that is an honest "nothing found", distinct from the brain being down.
      return { success: true, output };
    }
  },

  // BRAIN2-V3 A3: read a note (span) after search pointed at it. Snippets are
  // ~80 tokens; precise answers (qualifications, exact wording) need the note.
  quoxbrain_read: {
    name: 'quoxbrain_read',
    description: 'Read the text of one knowledge-brain note (or a span of it) by noteId, with its title and provenance (vault, path, date). Use when a cited snippet from quoxbrain_search/recall is not enough to answer precisely (qualifications, exact wording, conditions). Access control is enforced by the server. Long notes: page with start.',
    input_schema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'The noteId from a quoxbrain_search or recall result' },
        start: { type: 'number', description: 'Start char offset (default 0). Search results show the matching chars range.' },
        end: { type: 'number', description: 'End char offset (default start + maxChars)' },
        maxChars: { type: 'number', description: 'Max characters to return (default 4000, cap 20000)' }
      },
      required: ['noteId']
    },
    execute: async (input, ctx) => {
      if (!input || typeof input.noteId !== 'string' || !input.noteId.trim()) {
        return { success: false, error: 'noteId is required', output: 'Missing required parameter: noteId' };
      }
      const output = await quoxbrainRead(input, ctx);
      if (output === QUOXBRAIN_UNAVAILABLE_MSG) return { success: false, error: 'knowledge_brain_unavailable', output };
      if (output.startsWith('Note not found')) return { success: false, error: 'note_not_found', output };
      // CORTEX-BENCH: also return the chaining fields as structured data, so
      // an attached session (CLI -o json, MCP) can pass `revision` straight
      // into brain_update/brain_delete without scraping prose.
      return { success: true, ...readResultFields(output, input.noteId), output };
    }
  },

  // BRAIN2-V3 A3: the "Ask Qortex" starter questions, generated from the
  // caller's own corpus (GET /brain/suggestions), for Cortex greetings.
  brain_suggestions: {
    name: 'brain_suggestions',
    description: 'Get starter questions the user could ask their brain, generated from their own notes and memories (scoped to their org/user). Use when the user asks what they can ask, or opens with a bare greeting.',
    input_schema: {
      type: 'object',
      properties: { count: { type: 'number', description: 'How many suggestions (default 8, max 20)' } },
      required: []
    },
    execute: async (input, ctx) => {
      const output = await brainSuggestions(input || {}, ctx);
      if (output === QUOXBRAIN_UNAVAILABLE_MSG) return { success: false, error: 'knowledge_brain_unavailable', output };
      return { success: true, output };
    }
  },

  // BRAIN2-V3 B3: "what's new" daily brief (GET /brain/brief).
  brain_brief: {
    name: 'brain_brief',
    description: 'Catch the user up on what is new in their brain since a time window (counts by source, newest notes with titles, open questions). Use when the user asks what is new, to catch them up, or for a daily brief. Deterministic and scoped to their org/user.',
    input_schema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Window such as 24h (default), 7d or 90m' },
        stream: { type: 'string', description: 'Narrow the brief to one roadmap stream (QuoxPlan stream id such as AQ-9F)' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      const output = await brainBrief(input || {}, ctx);
      if (output === QUOXBRAIN_UNAVAILABLE_MSG) return { success: false, error: 'knowledge_brain_unavailable', output };
      return { success: true, output };
    }
  },

  // BRAIN2-V3 A2: capture. Document-style notes, references and decisions go to
  // the knowledge brain (NotesQ vault, searchable immediately); memory_save
  // stays for short facts/preferences.
  brain_save: {
    name: 'brain_save',
    description: 'Save a note, reference, article excerpt or decision-as-a-document into the user\'s knowledge brain (editable in NotesQ, searchable immediately). Use when the user tells you something worth keeping as a document, or asks you to clip a URL. Saves are always private to the user (org-wide sharing is done by the user in NotesQ). For a short fact or preference use memory_save instead. Identical or near-identical text updates the existing note rather than duplicating it.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note content (markdown ok)' },
        title: { type: 'string', description: 'Optional short title; derived from the text or page if omitted' },
        url: { type: 'string', description: 'Optional http(s) URL to clip: the brain fetches and extracts the page. Give url alone, or url plus text.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for the note' }
      },
      required: []
    },
    execute: async (input, ctx) => brainSave(input, ctx)
  },

  // BRAIN2-W5 125: correct or forget the caller's OWN private brain note
  // (NotesQ revision + base_hash conflict check). Corrections go here, never
  // a second brain_save copy.
  brain_update: {
    name: 'brain_update',
    description: 'Correct one of the user\'s own private knowledge-brain notes, or a team note in the user\'s own org, in place (use instead of saving a duplicate). Pass the noteId from a search/read result and the FULL corrected markdown text. You MUST read the note first with quoxbrain_read and pass the \'revision\' it returned as expectedHash; without it the edit is refused, and if the note changed since you read it you get a conflict and must re-read. A revision is recorded and restorable in NotesQ.',
    input_schema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'The note id from a search or read result' },
        text: { type: 'string', description: 'The full corrected note markdown (replaces the existing text)' },
        expectedHash: { type: 'string', description: 'REQUIRED. The "revision" value quoxbrain_read returned for this note (the version you actually read)' }
      },
      required: ['noteId', 'text', 'expectedHash']
    },
    execute: async (input, ctx) => brainUpdate(input, ctx)
  },

  // ONE-BRAIN CX6 gardener: archive tidy-up proposals. ALWAYS-PROPOSE: the
  // effect runs only through withApprovalGate (a human approves in Approvals).
  // The collector's brainGardenerScheduler files these as agent 'cortex'.
  brain_garden_apply: {
    name: 'brain_garden_apply',
    // Gated INSIDE execute (withApprovalGate), same shape as keeper_backup_create.
    gatedInExecute: true,
    description: 'Propose archiving the user\'s own private knowledge-brain notes as a tidy-up (duplicates or stale notes). This ALWAYS files an approval for the user; nothing is archived until they approve. Archiving only sets the note\'s archived flag (a revision is recorded and it can be restored in NotesQ); notes are never deleted. Give 1 to 20 noteIds, a plain reason, and the proposalKind.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['archive'], description: 'Only archive is supported' },
        noteIds: { type: 'array', items: { type: 'string' }, description: 'Full note ids to archive (1 to 20)' },
        reason: { type: 'string', description: 'Why, in plain words, shown to the approver' },
        proposalKind: { type: 'string', enum: ['duplicate', 'stale', 'broken_link'], description: 'What kind of tidy-up this is' },
        titles: { type: 'object', description: 'Optional map of noteId to title, shown on the approval card' },
        expectedHashes: { type: 'object', description: 'Optional map of noteId to the content hash seen when proposing; a note that changed since is skipped on apply' }
      },
      required: ['action', 'noteIds', 'reason', 'proposalKind']
    },
    execute: async (input, ctx) => {
      const bad = validateGardenInput(input, ctx);
      if (bad) return bad;
      const _gateInput = {
        action: input.action,
        noteIds: input.noteIds,
        reason: input.reason,
        proposalKind: input.proposalKind,
        ...(input.titles && typeof input.titles === 'object' ? { titles: input.titles } : {}),
        ...(input.expectedHashes && typeof input.expectedHashes === 'object' ? { expectedHashes: input.expectedHashes } : {}),
        ...(input._approvalId ? { _approvalId: input._approvalId } : {}),
        ...(input._resumeToken ? { _resumeToken: input._resumeToken } : {}),
      };
      return await withApprovalGate('brain_garden_apply', _gateInput, async () => {
        return await brainGardenApply(_gateInput, ctx, { emit: emitGardenNotes });
      }, ctx);
    }
  },

  brain_delete: {
    name: 'brain_delete',
    description: 'Delete one of the user\'s own private knowledge-brain notes when they ask you to forget it. Pass the noteId and the \'revision\' from quoxbrain_read as expectedHash (read the note first; a stale revision is a conflict and nothing is deleted). Shared org notes are refused. The delete is recorded as a revision and restorable in NotesQ.',
    input_schema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'The note id from a search or read result' },
        expectedHash: { type: 'string', description: 'REQUIRED. The "revision" value quoxbrain_read returned for this note' }
      },
      required: ['noteId', 'expectedHash']
    },
    execute: async (input, ctx) => brainDelete(input, ctx)
  },

  // ONE-BRAIN CX2: explore connections and undo edits over existing NotesQ routes.
  brain_related: {
    name: 'brain_related',
    description: 'List notes related to one knowledge-brain note (by similarity), with title, scope, a short excerpt and the full noteId of each. Use to explore connections around a note. Works on NotesQ notes (written by the user or saved by you), not on notes imported from sources such as memory files, transcripts or feeds. Access is enforced by the server.',
    input_schema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'The full noteId from a search or read result' },
        limit: { type: 'number', description: 'How many related notes (default 8, max 20)' }
      },
      required: ['noteId']
    },
    execute: async (input, ctx) => brainRelated(input, ctx)
  },

  brain_neighbours: {
    name: 'brain_neighbours',
    description: 'The notes this note links to and the notes that link to it, to walk the knowledge graph around a note. Each neighbour carries its title and full noteId; links whose target does not exist (or is not visible to you) are listed as dangling names. Complements brain_related, which finds similar notes rather than linked ones. Access is enforced by the server.',
    input_schema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'The full noteId from a search or read result' }
      },
      required: ['noteId']
    },
    execute: async (input, ctx) => brainNeighbours(input, ctx)
  },

  brain_context: {
    name: 'brain_context',
    description: 'A token-budgeted pack of the most relevant cited passages from the knowledge brain on a topic, for priming work on a subject before answering or starting a task. Each passage carries its title and full noteId. Prefer recall for specific questions. Says plainly when nothing relevant was found. Access is enforced by the server.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The topic or task to gather context for' },
        tokenBudget: { type: 'number', description: 'Approximate token budget for the pack (default 1200, min 200, max 4000)' },
        since: { type: 'string', description: 'ONLY when the user gives a time window. ISO date or datetime (2026-10-05 or 2026-10-05T09:00:00Z); notes dated on or after it. Omit otherwise.' },
        until: { type: 'string', description: 'ONLY when the user gives a time window. ISO date or datetime; notes dated on or before it (a date alone means the whole day). Omit otherwise.' }
      },
      required: ['query']
    },
    execute: async (input, ctx) => brainContext(input, ctx)
  },

  brain_check: {
    name: 'brain_check',
    description: 'Check whether the knowledge brain supports, contradicts or says nothing about a claim before stating it as fact (for example "we decided X" or "the price is Y"). Returns a verdict of supported (a model checked the meaning), overlap (the source shares the claim\'s words; not checked for meaning), contradicted or unknown with the sources. Read the cited note before relying on it. Read-only. Access is enforced by the server.',
    input_schema: {
      type: 'object',
      properties: {
        claim: { type: 'string', description: 'The single statement to check, at most 500 characters' }
      },
      required: ['claim']
    },
    execute: async (input, ctx) => brainCheck(input, ctx)
  },

  // ONE-BRAIN CX6: explain a ranking, or why a note is missing.
  brain_why: {
    name: 'brain_why',
    description: 'Two modes, both read-only. (1) Provenance: pass {target} as a commit sha (7-40 hex) or a file path to find the commits, dev sessions and decisions/notes behind a code change (every hit is verified to contain the sha or path; unverified rationale is labelled possibly related). (2) Ranking: pass {query, noteId} to explain why a note ranked where it did for a query, or why it is missing: keyword rank, vector rank and cosine, fused score, reranker position, or the stage where it dropped out. Use for "why does this code look like this" or "why did this note not show up". Access is enforced by the server, it only explains notes you can already see.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Provenance mode: a commit sha (7-40 hex) or a file path' },
        query: { type: 'string', description: 'Ranking mode: the search query to explain' },
        noteId: { type: 'string', description: 'Ranking mode: the full noteId of the note to explain (from a search or read result)' }
      },
      required: []
    },
    execute: async (input, ctx) => brainWhy(input, ctx)
  },

  brain_history: {
    name: 'brain_history',
    description: 'Show a knowledge-brain note\'s revision history (rev, action, author kind, time, content hash), or with rev the full text of that revision. Use when the user asks what a note used to say, or before restoring an earlier version. Only NotesQ notes (written by the user or saved by you) keep revisions; imported source notes have none.',
    input_schema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'The full noteId from a search or read result' },
        rev: { type: 'number', description: 'Optional revision number: return that revision\'s text instead of the list' }
      },
      required: ['noteId']
    },
    execute: async (input, ctx) => brainHistory(input, ctx)
  },

  brain_restore: {
    name: 'brain_restore',
    description: 'Restore one of the user\'s own private notes, or a team note in the user\'s own org, to an earlier revision, when they ask to undo an edit. Find the revision with brain_history first. You MUST read the note with quoxbrain_read and pass its current \'revision\' as expectedHash; a stale value is a conflict and nothing is restored (re-read and redo). The restore is itself recorded as a revision.',
    input_schema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'The full noteId' },
        rev: { type: 'number', description: 'The revision number to restore, from brain_history' },
        expectedHash: { type: 'string', description: 'REQUIRED. The current "revision" value quoxbrain_read returned for this note' }
      },
      required: ['noteId', 'rev', 'expectedHash']
    },
    execute: async (input, ctx) => brainRestore(input, ctx)
  },

  // ONE-BRAIN Phase A2 (QuoxPlan #493) — unified recall. The three surfaces
  // above (memory_search, quoxbrain_search, execution_intelligence
  // search_wisdom) overlap with no arbiter: the same insight can come back
  // from more than one with nothing marking them as the same thing. `recall`
  // runs all three concurrently and dedups by canonical identity (an A1
  // brain hit stamped originStore/originId IS the memory/wisdom row it was
  // copied from) — one deduped, provenance-tagged, freshness-preferred
  // result per insight, never three unlabelled copies. See lib/recallSearch.js
  // (wiring) and lib/recallMerge.js (the dedup/merge core, unit-tested
  // directly).
  recall: {
    name: 'recall',
    description: 'Unified recall across memory, the knowledge brain and execution wisdom — search all three at once and get back ONE deduped, provenance-tagged answer per insight instead of three overlapping tool calls. Prefer this over calling memory_search/quoxbrain_search/execution_intelligence(search_wisdom) separately when the query is not obviously scoped to just one of them. Each result carries `canonical` (which store actually owns this insight), `surfaces` (every surface it was found in) and `also_indexed_in` (surfaces beyond the canonical one) so you can cite provenance honestly.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language question to recall across memory, the knowledge brain and execution wisdom.' },
        limit: { type: 'number', description: 'Max deduped results to return (default: 8, max: 30).' },
        since: { type: 'string', description: 'ONLY when the user gives a time window. ISO date or datetime; knowledge-brain notes dated on or after it (memory and wisdom are not date-filtered). Omit otherwise.' },
        until: { type: 'string', description: 'ONLY when the user gives a time window. ISO date or datetime; knowledge-brain notes dated on or before it (a date alone means the whole day). Omit otherwise.' }
      },
      required: ['query']
    },
    execute: async (input, ctx) => {
      return await recallSearch(input, {
        agentId: ctx?.agentId || 'quox',
        userId: ctx?.userId,
        orgId: ctx?.orgId,
        token: ctx?.token || null,
        // Citation tracing keys (lib/brainCitationTrace.js key chain).
        corr: ctx?.corr,
        conversationId: ctx?.conversationId,
        session_id: ctx?.session_id
      });
    }
  },

  // ==========================================================================
  // REGULA — settings & configuration warden (AGENT-OVERHAUL wave 1 + wave 2,
  // QuoxPlan note #2321). REGULA's 21 registry-declared tools
  // (src/config/agentRegistry.js) previously had zero TOOL_DEFS entries — V1
  // was conversational only. Wave 1 wired 4 read-only tools to the org-scoped
  // settings/flags API and the platform capabilities registry shipped Phase
  // 24/25 (commits a946a452 "every behaviour flag visible" and b5d2fb89
  // "settings beat env, org-scoped and audited"). Wave 2 wired 6 more
  // write/reuse tools (settings_set, backup_status, backup_run, license_status,
  // vault_list, vault_test) to real backends named in their own former stub
  // messages — see each tool's execute for the endpoint it calls. That leaves
  // 10 real tools total; the remaining 11 write/manage tools still have no
  // backing implementation and return an honest 501 rather than silent
  // absence — same pattern as mikrotikExecutor.js's UNSUPPORTED_TOOLS.
  // ==========================================================================

  settings_list: {
    name: 'settings_list',
    description: "List every org-settable behaviour flag with its current effective value, default, and whether an org override or the environment default is in effect. Backs 'walk me through my current settings'.",
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (_input, ctx) => {
      if (!ctx?.token) {
        return { success: false, error: 'org_context_required', message: 'settings_list needs an authenticated user session (org context) to resolve org-scoped overrides.' };
      }
      try {
        const port = process.env.COLLECTOR_PORT || process.env.PORT || 9848;
        const resp = await fetch(`http://127.0.0.1:${port}/api/v1/platform/settings/flags`, {
          headers: { Authorization: `Bearer ${ctx.token}` }
        });
        const data = await resp.json().catch(() => null);
        if (!resp.ok) {
          return { success: false, error: data?.error || `HTTP ${resp.status}`, status: resp.status };
        }
        return { success: true, flags: data?.flags || [] };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  settings_get: {
    name: 'settings_get',
    description: 'Get one org-settable behaviour flag by key: its current effective value, default, and whether it is set by an org override or the environment.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: "Flag key, e.g. 'AGH_CHAIN_ENABLED'" }
      },
      required: ['key']
    },
    execute: async (input, ctx) => {
      if (!ctx?.token) {
        return { success: false, error: 'org_context_required', message: 'settings_get needs an authenticated user session (org context) to resolve org-scoped overrides.' };
      }
      try {
        const port = process.env.COLLECTOR_PORT || process.env.PORT || 9848;
        const resp = await fetch(`http://127.0.0.1:${port}/api/v1/platform/settings/flags`, {
          headers: { Authorization: `Bearer ${ctx.token}` }
        });
        const data = await resp.json().catch(() => null);
        if (!resp.ok) {
          return { success: false, error: data?.error || `HTTP ${resp.status}`, status: resp.status };
        }
        const flag = (data?.flags || []).find((f) => f.key === input.key);
        if (!flag) {
          return { success: false, error: 'not_found', message: `No settable flag named '${input.key}'.` };
        }
        return { success: true, flag };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  settings_explain: {
    name: 'settings_explain',
    description: 'Explain what a behaviour flag does in plain English: description, which service reads it, its default, and whether changing it needs a restart. Works for both user-settable and operator-only flags (broader coverage than settings_get).',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: "Flag key, e.g. 'QM_LTM_ENABLED'" }
      },
      required: ['key']
    },
    execute: async (input, ctx) => {
      try {
        const resp = await localApiFetch('/api/v1/platform/capabilities', {}, { assertOk: false });
        const data = await resp.json().catch(() => null);
        if (!resp.ok) {
          return { success: false, error: data?.error || `HTTP ${resp.status}`, status: resp.status };
        }
        const capability = (data?.capabilities || []).find((c) => c.key === input.key);
        if (!capability) {
          return { success: false, error: 'not_found', message: `No known behaviour flag named '${input.key}'.` };
        }
        return { success: true, capability };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  settings_search: {
    name: 'settings_search',
    description: 'Search behaviour flags by keyword against their key, name, and description. Use for "what settings affect X". Covers both user-settable and operator-only flags.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search term' },
        classification: { type: 'string', description: "Optional filter: 'user' or 'operator'" }
      },
      required: ['query']
    },
    execute: async (input, ctx) => {
      try {
        const params = new URLSearchParams();
        if (input.classification) params.set('classification', input.classification);
        const qs = params.toString() ? `?${params.toString()}` : '';
        const resp = await localApiFetch(`/api/v1/platform/capabilities${qs}`, {}, { assertOk: false });
        const data = await resp.json().catch(() => null);
        if (!resp.ok) {
          return { success: false, error: data?.error || `HTTP ${resp.status}`, status: resp.status };
        }
        const needle = String(input.query || '').toLowerCase();
        const matches = (data?.capabilities || []).filter((c) =>
          c.key.toLowerCase().includes(needle) ||
          (c.name || '').toLowerCase().includes(needle) ||
          (c.description || '').toLowerCase().includes(needle)
        );
        return { success: true, count: matches.length, capabilities: matches };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  // -- 6 newly-wired real tools (settings_set, vault_list, vault_test,
  // backup_status, backup_run, license_status) followed by 11 honest stubs:
  // declared in agentRegistry.js's REGULA tool list but no write/manage
  // backend exists yet. Each stub returns a structured 501 naming the gap
  // instead of fabricating a result or being silently absent
  // (mikrotikExecutor.js UNSUPPORTED_TOOLS pattern).

  settings_set: {
    name: 'settings_set',
    description: 'Set one org-settable behaviour flag to a new value (true/false). Admin-only — the collector enforces the role check server-side and audits the change.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Flag key to change' },
        value: { type: 'string', description: "New value ('true' or 'false' for boolean flags)" }
      },
      required: ['key', 'value']
    },
    execute: async (input, ctx) => {
      if (!ctx?.token) {
        return { success: false, error: 'org_context_required', message: 'settings_set needs an authenticated user session (org context) to apply an org-scoped override.' };
      }
      try {
        const port = process.env.COLLECTOR_PORT || process.env.PORT || 9848;
        const resp = await fetch(`http://127.0.0.1:${port}/api/v1/platform/settings/flags/${encodeURIComponent(input.key)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
          body: JSON.stringify({ value: input.value })
        });
        const data = await resp.json().catch(() => null);
        if (!resp.ok) {
          return { success: false, error: data?.error || `HTTP ${resp.status}`, status: resp.status };
        }
        return { success: true, flag: data?.effective, old_value: data?.old_value, new_value: data?.new_value };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  settings_recommend: {
    name: 'settings_recommend',
    description: 'NOT IMPLEMENTED. Would recommend non-destructive settings changes based on org profile and history.',
    input_schema: { type: 'object', properties: { context: { type: 'string', description: 'Optional context for the recommendation, e.g. "small team"' } }, required: [] },
    execute: async () => regulaNotImplemented('settings_recommend is not implemented. No recommendation engine exists over the platform settings registry yet.')
  },

  settings_export: {
    name: 'settings_export',
    description: 'NOT IMPLEMENTED. Would export the org\'s full settings state as a portable document.',
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async () => regulaNotImplemented('settings_export is not implemented. No export format or endpoint exists for the platform settings registry yet.')
  },

  settings_import: {
    name: 'settings_import',
    description: 'NOT IMPLEMENTED. Would import a previously exported settings document.',
    input_schema: { type: 'object', properties: { data: { type: 'string', description: 'Exported settings document' } }, required: [] },
    execute: async () => regulaNotImplemented('settings_import is not implemented. No import path exists for the platform settings registry yet.')
  },

  plugin_list: {
    name: 'plugin_list',
    description: 'NOT IMPLEMENTED. Would list installed plugins and their enabled/disabled state.',
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async () => regulaNotImplemented('plugin_list is not implemented. No collector API exposes plugin install/enable state to agents yet; the plugin registry (src/config/plugins/index.js) is a frontend-only source today.')
  },

  plugin_enable: {
    name: 'plugin_enable',
    description: 'NOT IMPLEMENTED. Would enable a plugin for the org.',
    input_schema: { type: 'object', properties: { plugin_id: { type: 'string', description: 'Plugin id to enable' } }, required: ['plugin_id'] },
    execute: async () => regulaNotImplemented('plugin_enable is not implemented. No collector API exposes plugin enable/disable to agents yet.')
  },

  plugin_disable: {
    name: 'plugin_disable',
    description: 'NOT IMPLEMENTED. Would disable a plugin for the org.',
    input_schema: { type: 'object', properties: { plugin_id: { type: 'string', description: 'Plugin id to disable' } }, required: ['plugin_id'] },
    execute: async () => regulaNotImplemented('plugin_disable is not implemented. No collector API exposes plugin enable/disable to agents yet.')
  },

  vault_list: {
    name: 'vault_list',
    description: 'List configured integrations (vault credentials) for the org: integration type, label, and whether each is the default for its type. Never returns credential values.',
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (input, ctx) => {
      if (!ctx?.token || !ctx?.orgId) {
        return { success: false, error: 'org_context_required', message: 'vault_list needs an authenticated user session with organization context.' };
      }
      try {
        const resp = await fetch(`${AUTH_BASE_URL}/orgs/${encodeURIComponent(ctx.orgId)}/integrations`, {
          headers: { Authorization: `Bearer ${ctx.token}` },
          signal: AbortSignal.timeout(10000),
        });
        const data = await resp.json().catch(() => null);
        if (!resp.ok) {
          return { success: false, error: data?.error || `HTTP ${resp.status}`, status: resp.status };
        }
        const integrations = (data?.credentials || []).map((c) => ({
          id: c.id,
          integration_type: c.integration_type,
          label: c.label,
          is_default: !!c.is_default,
        }));
        return { success: true, count: integrations.length, integrations };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  vault_test: {
    name: 'vault_test',
    description: 'Test-connect a stored vault credential by id and report healthy/unhealthy. Never reveals or echoes the credential value.',
    input_schema: { type: 'object', properties: { credential_id: { type: 'string', description: 'Vault credential id to test' } }, required: ['credential_id'] },
    execute: async (input, ctx) => {
      if (!ctx?.token || !ctx?.orgId) {
        return { success: false, error: 'org_context_required', message: 'vault_test needs an authenticated user session with organization context.' };
      }
      try {
        const resp = await fetch(`${AUTH_BASE_URL}/orgs/${encodeURIComponent(ctx.orgId)}/integrations/${encodeURIComponent(input.credential_id)}/test`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${ctx.token}` },
          signal: AbortSignal.timeout(15000),
        });
        const data = await resp.json().catch(() => null);
        if (resp.status === 422) {
          return { success: true, healthy: false, message: data?.message || 'Connection test failed' };
        }
        if (!resp.ok) {
          return { success: false, error: data?.error || `HTTP ${resp.status}`, status: resp.status };
        }
        return { success: true, healthy: true, message: data?.message || 'Connection successful' };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  // VAULT-INTEG P7 (QuoxPlan project_quoxseo_build tools slice — read-only
  // credential-connection guidance). vault_list/vault_test let an agent USE
  // a credential it's handed; they gave no way to HELP a user connect a NEW
  // one. vault_types/vault_connect_guide close that gap by composing the
  // existing integration type catalogue (services/auth/config/
  // integrationTypeRegistry.js, served at GET /orgs/:orgId/integrations/types)
  // into agent-facing answers. Both are pure reads over public field metadata
  // (never a stored credential's value) — no HITL gate, by design: DESIGN
  // DECISION — credential CREATION stays human-only. These tools tell a user
  // what fields a type needs and where/how to add it; only a human ever
  // pastes the actual secret, in the dashboard's Add Credential form or their
  // own terminal. Nothing here writes a credential or sees one.
  vault_types: {
    name: 'vault_types',
    description: "List available integration types (the catalogue vault credentials are created from), optionally filtered by a search string and/or category. Returns each type's id, name, category, description, whether it runs a live connection test on save, and the field names/labels a user must supply — never a default or example value that could be mistaken for a real credential.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Free-text search against the type's id, name, and description, e.g. 'slack' or 'database'" },
        category: { type: 'string', description: "Optional exact category filter, e.g. 'ai', 'productivity', 'analytics'" }
      },
      required: []
    },
    execute: async (input, ctx) => {
      if (!ctx?.token || !ctx?.orgId) {
        return { success: false, error: 'org_context_required', message: 'vault_types needs an authenticated user session with organization context.' };
      }
      try {
        const { resp, data } = await _fetchIntegrationTypes(ctx);
        if (!resp.ok) {
          return { success: false, error: data?.error || `HTTP ${resp.status}`, status: resp.status };
        }
        const needle = String(input?.query || '').trim().toLowerCase();
        const category = input?.category ? String(input.category).trim().toLowerCase() : null;
        const matches = (data?.types || []).filter((t) => {
          if (category && String(t.category || '').toLowerCase() !== category) return false;
          if (!needle) return true;
          return (
            String(t.id || '').toLowerCase().includes(needle) ||
            String(t.name || '').toLowerCase().includes(needle) ||
            String(t.description || '').toLowerCase().includes(needle)
          );
        });
        const types = matches.map((t) => ({
          id: t.id,
          name: t.name,
          category: t.category || null,
          description: t.description,
          has_live_test: !!t.has_live_test,
          fields: (t.fields || []).map(_safeVaultField),
        }));
        return { success: true, count: types.length, types };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  vault_connect_guide: {
    name: 'vault_connect_guide',
    description: "Given an integration type id (from vault_types), return a step-by-step guide for connecting it: the fields required, where in the dashboard to add it, the matching 'quox vault create' CLI shape with placeholders (never real values), and whether saving it will trigger a live connection test. Read-only composition of type metadata — never creates or sees a credential; credential creation is deliberately human-only, this tool only guides.",
    input_schema: {
      type: 'object',
      properties: {
        type_id: { type: 'string', description: "Integration type id, e.g. 'openai', 'slack', 'postgres' (use vault_types to find the right id)" }
      },
      required: ['type_id']
    },
    execute: async (input, ctx) => {
      if (!ctx?.token || !ctx?.orgId) {
        return { success: false, error: 'org_context_required', message: 'vault_connect_guide needs an authenticated user session with organization context.' };
      }
      try {
        const { resp, data } = await _fetchIntegrationTypes(ctx);
        if (!resp.ok) {
          return { success: false, error: data?.error || `HTTP ${resp.status}`, status: resp.status };
        }
        const wanted = String(input?.type_id || '').trim().toLowerCase();
        const type = (data?.types || []).find((t) => String(t.id || '').toLowerCase() === wanted);
        if (!type) {
          return { success: false, error: 'not_found', message: `No integration type named '${input?.type_id}'. Call vault_types to list valid ids.` };
        }
        const fields = (type.fields || []).map(_safeVaultField);
        const credentialsShape = {};
        for (const f of fields) credentialsShape[f.key] = `<${String(f.key || 'VALUE').toUpperCase()}>`;
        const credentialsJson = JSON.stringify(credentialsShape);
        return {
          success: true,
          type_id: type.id,
          type_name: type.name,
          fields,
          dashboard_path: '/vault/credentials',
          dashboard_guidance: `In the dashboard: QuoxVault → Credentials (/vault/credentials), or Settings → Integrations Vault. Use "Add credential", pick '${type.name}' as the type, and paste the real values there — never in chat.`,
          cli_shape: {
            // Placeholders only, same pattern as onboard.js's own vault-create
            // example — argv-safe secrets go via --credentials-stdin, never
            // literal on the command line.
            stdin: `printf '%s' '${credentialsJson}' | quox vault create --type ${type.id} --label "<LABEL>" --credentials-stdin`,
            file: `quox vault create --type ${type.id} --label "<LABEL>" --credentials-file <path-to-json-file>`,
            note: 'Placeholders only (<...>) — the caller fills in real values themselves; this tool never generates or sees one.'
          },
          will_run_live_test_on_save: !!type.has_live_test,
          docs: type.docs || null,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  backup_status: {
    name: 'backup_status',
    description: 'Get backup health summary for the org: total backups, success/failure counts, last backup time, active schedules, and component coverage. Reuses KEEPER\'s real backup-status call (keeperInternalBackupStatus) against the auth service — no separate client.',
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (input, ctx) => {
      return await keeperInternalBackupStatus(ctx?.orgId);
    }
  },

  backup_run: {
    name: 'backup_run',
    // QUOXTRUST C2/WP2: reaches outside the box — durable intent gated at the choke.
    externalEffect: true,
    // QUOXTRUST MF-2: gated INSIDE execute (withApprovalGate), same shape as
    // ssh_exec — the choke must not stamp dispatched before the gate decides.
    gatedInExecute: true,
    description: 'Trigger an ad-hoc backup run for the org. Supports full backup (all components) or selective backup. Reuses KEEPER\'s real backup-create call (keeperAuthFetch) against the auth service — no separate client.',
    input_schema: {
      type: 'object',
      properties: {
        backup_type: { type: 'string', enum: ['full', 'selective'], description: 'Full system or selective backup (default: full)' },
        name: { type: 'string', description: 'Backup name/label (optional)' },
        description: { type: 'string', description: 'Backup description (optional)' },
        components: { type: 'array', items: { type: 'string' }, description: 'Component IDs to backup (only for selective type)' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      if (!ctx?.orgId) {
        return { success: false, error: 'org_context_required', message: 'backup_run needs an organization context — refusing to create a backup against a default/wildcard org.' };
      }
      // QUOXTRUST MF-2: backup_run is in AGENT_ALWAYS_PROPOSE_TOOLS, so this
      // gate holds unconditionally — no org GOV-4 policy required (the live
      // store has zero require_approval policies, which was exactly the gap).
      const _gateInput = {
        backup_type: input.backup_type || 'full',
        name: input.name,
        description: input.description,
        components: input.components,
        ...(input._approvalId ? { _approvalId: input._approvalId } : {}),
        ...(input._resumeToken ? { _resumeToken: input._resumeToken } : {}),
      };
      return await withApprovalGate('backup_run', _gateInput, async () => {
        // Use the internal, service-key, CSRF-exempt trigger route — the org
        // route (POST /orgs/:orgId/backups) enforces CSRF, which a service-key
        // caller can't satisfy (proven live 2026-08-08: 403 "Missing CSRF token
        // header"). Same underlying runBackupProcess creation path.
        return await keeperAuthFetch(`/internal/backups/trigger`, 'POST', {
          org_id: ctx.orgId,
          backup_type: input.backup_type || 'full',
          name: input.name,
          description: input.description,
          components: input.components,
        });
      }, ctx);
    }
  },

  license_status: {
    name: 'license_status',
    description: 'Report the instance license (tier, seats, expiry) and any per-plugin license status.',
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (input, ctx) => {
      if (!ctx?.token) {
        return { success: false, error: 'org_context_required', message: 'license_status needs an authenticated user session to read instance licensing state.' };
      }
      try {
        const headers = { Authorization: `Bearer ${ctx.token}` };
        const [licResp, pluginResp] = await Promise.all([
          fetch(`${AUTH_BASE_URL}/setup/licensing`, { headers, signal: AbortSignal.timeout(10000) }),
          fetch(`${AUTH_BASE_URL}/setup/plugin-licenses`, { headers, signal: AbortSignal.timeout(10000) }),
        ]);
        if (!licResp.ok) {
          const errData = await licResp.json().catch(() => null);
          return { success: false, error: errData?.error || `HTTP ${licResp.status}`, status: licResp.status };
        }
        const licData = await licResp.json().catch(() => null);
        const pluginData = pluginResp.ok ? await pluginResp.json().catch(() => ({ licenses: {} })) : { licenses: {} };
        return { success: true, licensing: licData?.licensing ?? null, plugin_licenses: pluginData?.licenses ?? {} };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  },

  appearance_get: {
    name: 'appearance_get',
    description: 'NOT IMPLEMENTED. Would return the org\'s current appearance/theme settings.',
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async () => regulaNotImplemented('appearance_get is not implemented as an agent tool. Appearance is a frontend-local (Settings > Appearance) surface today.')
  },

  appearance_set: {
    name: 'appearance_set',
    description: 'NOT IMPLEMENTED. Would change an org appearance/theme setting.',
    input_schema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] },
    execute: async () => regulaNotImplemented('appearance_set is not implemented as an agent tool.')
  },

  service_check: {
    name: 'service_check',
    description: 'NOT IMPLEMENTED (for REGULA). Would check health of a named platform service.',
    input_schema: { type: 'object', properties: { service_id: { type: 'string', description: 'Service id to check, e.g. "collector"' } }, required: [] },
    execute: async () => regulaNotImplemented('service_check is not implemented for REGULA. fleet_status/docker_status cover host/container health; no per-platform-service check tool is wired for REGULA yet.')
  },

  notification_subscribe: {
    name: 'notification_subscribe',
    description: 'NOT IMPLEMENTED. Would subscribe a channel/target to a notification category.',
    input_schema: { type: 'object', properties: { channel: { type: 'string' }, target: { type: 'string' } }, required: ['channel', 'target'] },
    execute: async () => regulaNotImplemented('notification_subscribe is not implemented as an agent tool. send_notification exists for one-off sends; there is no subscription-management backend yet.')
  },

  notification_unsubscribe: {
    name: 'notification_unsubscribe',
    description: 'NOT IMPLEMENTED. Would unsubscribe a channel/target from a notification category.',
    input_schema: { type: 'object', properties: { channel: { type: 'string' }, target: { type: 'string' } }, required: ['channel', 'target'] },
    execute: async () => regulaNotImplemented('notification_unsubscribe is not implemented as an agent tool.')
  },

  // ==========================================================================
  // QuoxSEO (SEER) — read-only tools over the witnessed URL warehouse.
  // Same proxy target as the collector's own /api/v1/quoxseo/* route
  // (server.js), reached directly here rather than through that proxy since
  // these are server-to-server calls, not browser calls. Org scoping is the
  // X-Quoxseo-Org header, not a service key: the quoxseo API gates on the
  // org header alone, same as the collector proxy forwards it.
  // ==========================================================================

  quoxseo_summary: {
    name: 'quoxseo_summary',
    description: "Latest crawl summary for the org's site: URL count, ok/error, GSC coverage, orphans, noindex, missing canonical/meta, totals.",
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (input, ctx) => {
      try {
        const orgId = ctx?.orgId;
        if (!orgId) return { success: false, error: 'No organization context' };
        const base = process.env.QUOXSEO_URL || 'http://quoxseo:3110';
        const res = await fetch(`${base}/api/v1/summary`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'X-Quoxseo-Org': orgId }
        });
        const text = await res.text();
        if (!res.ok) return { success: false, error: `QuoxSEO returned ${res.status}: ${text}` };
        let data;
        try { data = JSON.parse(text); } catch { data = {}; }
        return { success: true, ...data };
      } catch (err) {
        return { success: false, error: `Failed to fetch QuoxSEO summary: ${err.message}` };
      }
    }
  },

  quoxseo_urls: {
    name: 'quoxseo_urls',
    description: "Query the URL warehouse for the latest crawl.",
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['orphans', 'noindex', 'errors', 'no-gsc', 'discovered'], description: 'Optional URL filter' },
        q: { type: 'string', description: 'Optional search query (path or title)' },
        sort: { type: 'string', enum: ['impressions'], description: 'Optional sort order' },
        limit: { type: 'number', description: 'Max results (default 50, capped at 200)' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      try {
        const orgId = ctx?.orgId;
        if (!orgId) return { success: false, error: 'No organization context' };
        const base = process.env.QUOXSEO_URL || 'http://quoxseo:3110';
        const params = new URLSearchParams();
        if (input?.filter) params.set('filter', input.filter);
        if (input?.q) params.set('q', input.q);
        if (input?.sort) params.set('sort', input.sort);
        const limit = Math.min(Number(input?.limit) || 50, 200);
        params.set('limit', String(limit));
        const res = await fetch(`${base}/api/v1/urls?${params.toString()}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'X-Quoxseo-Org': orgId }
        });
        const text = await res.text();
        if (!res.ok) return { success: false, error: `QuoxSEO returned ${res.status}: ${text}` };
        let data;
        try { data = JSON.parse(text); } catch { data = {}; }
        return { success: true, ...data };
      } catch (err) {
        return { success: false, error: `Failed to query QuoxSEO URL warehouse: ${err.message}` };
      }
    }
  },

  quoxseo_changes: {
    name: 'quoxseo_changes',
    description: 'The witnessed change log: signed diffs between consecutive crawls (noindex transitions, canonical/title changes, added/removed URLs).',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 50)' },
        crawl_id: { type: 'string', description: 'Restrict to changes for a specific crawl id' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      try {
        const orgId = ctx?.orgId;
        if (!orgId) return { success: false, error: 'No organization context' };
        const base = process.env.QUOXSEO_URL || 'http://quoxseo:3110';
        const params = new URLSearchParams();
        if (input?.crawl_id) {
          params.set('crawl_id', input.crawl_id);
        } else {
          params.set('limit', String(Number(input?.limit) || 50));
        }
        const res = await fetch(`${base}/api/v1/changes?${params.toString()}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'X-Quoxseo-Org': orgId }
        });
        const text = await res.text();
        if (!res.ok) return { success: false, error: `QuoxSEO returned ${res.status}: ${text}` };
        let data;
        try { data = JSON.parse(text); } catch { data = {}; }
        return { success: true, ...data };
      } catch (err) {
        return { success: false, error: `Failed to fetch QuoxSEO change log: ${err.message}` };
      }
    }
  },

  quoxseo_verify: {
    name: 'quoxseo_verify',
    description: "Re-verify the WARD chain, tip signatures and per-crawl root hashes for the org's SEO history.",
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (input, ctx) => {
      try {
        const orgId = ctx?.orgId;
        if (!orgId) return { success: false, error: 'No organization context' };
        const base = process.env.QUOXSEO_URL || 'http://quoxseo:3110';
        const res = await fetch(`${base}/api/v1/verify`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'X-Quoxseo-Org': orgId }
        });
        const text = await res.text();
        if (!res.ok) return { success: false, error: `QuoxSEO returned ${res.status}: ${text}` };
        let data;
        try { data = JSON.parse(text); } catch { data = {}; }
        return { success: true, ...data };
      } catch (err) {
        return { success: false, error: `Failed to verify QuoxSEO chain: ${err.message}` };
      }
    }
  },

  quoxseo_opportunities: {
    name: 'quoxseo_opportunities',
    description: "Ranked SEO quick wins for the org's site, computed from the warehouse (no paid data): striking-distance pages (ranking on the edge of page 1), CTR gaps (rank well but under-clicked), orphans with traffic, and thin pages with traffic. Each names the page, the evidence metric, and a concrete action. Use when the user asks what to work on next or where the easy wins are.",
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Optional filter: striking_distance | ctr_gap | orphan_with_traffic | thin_with_traffic' },
        limit: { type: 'number', description: 'Max opportunities to return (default 20)' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      try {
        const orgId = ctx?.orgId;
        if (!orgId) return { success: false, error: 'No organization context' };
        const base = process.env.QUOXSEO_URL || 'http://quoxseo:3110';
        const qs = new URLSearchParams();
        if (input?.type) qs.set('type', input.type);
        qs.set('limit', String(input?.limit || 20));
        const res = await fetch(`${base}/api/v1/opportunities?${qs}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'X-Quoxseo-Org': orgId }
        });
        const text = await res.text();
        if (!res.ok) return { success: false, error: `QuoxSEO returned ${res.status}: ${text}` };
        let data;
        try { data = JSON.parse(text); } catch { data = {}; }
        return { success: true, ...data };
      } catch (err) {
        return { success: false, error: `Failed to fetch QuoxSEO opportunities: ${err.message}` };
      }
    }
  },

  quoxseo_queries: {
    name: 'quoxseo_queries',
    description: "Query-level SEO intelligence for the org's site from Search Console query x page data: keyword cannibalisation (one search query where several of our own pages compete and split authority), keyword opportunities (a query whose best page ranks on the edge of page 1), and a brand vs non-brand demand split. Use when the user asks about keywords, search queries, cannibalisation, or which terms to target.",
    input_schema: {
      type: 'object',
      properties: {
        view: { type: 'string', description: 'Optional: cannibalisation | keywords | brand (default: all)' },
        limit: { type: 'number', description: 'Max rows per view (default 20)' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      try {
        const orgId = ctx?.orgId;
        if (!orgId) return { success: false, error: 'No organization context' };
        const base = process.env.QUOXSEO_URL || 'http://quoxseo:3110';
        const qs = new URLSearchParams();
        if (input?.view) qs.set('view', input.view);
        qs.set('limit', String(input?.limit || 20));
        const res = await fetch(`${base}/api/v1/queries?${qs}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'X-Quoxseo-Org': orgId }
        });
        const text = await res.text();
        if (!res.ok) return { success: false, error: `QuoxSEO returned ${res.status}: ${text}` };
        let data;
        try { data = JSON.parse(text); } catch { data = {}; }
        return { success: true, ...data };
      } catch (err) {
        return { success: false, error: `Failed to fetch QuoxSEO query intelligence: ${err.message}` };
      }
    }
  },

  quoxseo_issues: {
    name: 'quoxseo_issues',
    description: "Technical SEO audit for the org's site: every on-page and technical issue in the latest crawl, ranked by severity. Detects error pages, noindex pages that still earn traffic (accidental deindexing), missing canonical/meta description/H1, multiple H1s, thin content, orphans, pages missing from the sitemap, and duplicate titles/meta descriptions. Use when the user asks what is wrong with the site, for a site audit, or about technical SEO health.",
    input_schema: {
      type: 'object',
      properties: {
        severity: { type: 'string', description: 'Optional filter: high | medium | low' },
        type: { type: 'string', description: 'Optional issue-type filter, e.g. thin_content, missing_canonical, duplicate_title' },
        limit: { type: 'number', description: 'Max issues to return (default 30)' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      try {
        const orgId = ctx?.orgId;
        if (!orgId) return { success: false, error: 'No organization context' };
        const base = process.env.QUOXSEO_URL || 'http://quoxseo:3110';
        const qs = new URLSearchParams();
        if (input?.severity) qs.set('severity', input.severity);
        if (input?.type) qs.set('type', input.type);
        qs.set('limit', String(input?.limit || 30));
        const res = await fetch(`${base}/api/v1/issues?${qs}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'X-Quoxseo-Org': orgId }
        });
        const text = await res.text();
        if (!res.ok) return { success: false, error: `QuoxSEO returned ${res.status}: ${text}` };
        let data;
        try { data = JSON.parse(text); } catch { data = {}; }
        return { success: true, ...data };
      } catch (err) {
        return { success: false, error: `Failed to fetch QuoxSEO issues: ${err.message}` };
      }
    }
  },

  quoxseo_trends: {
    name: 'quoxseo_trends',
    description: "Search Console trends for the org's site: winners and losers over time from a period compare (the trailing 28 days vs the 28 days before). Returns per-URL or per-query movers with impressions/clicks/position deltas and a status (winner, loser, new, lost, flat). New pages/queries that just started earning impressions, and pages whose traffic collapsed, are the headline moves. Use when the user asks what is going up or down, what changed in search traffic, what is trending, or whether a recent change helped.",
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'url (per-page, default) | query (per-search-term)' },
        limit: { type: 'number', description: 'Max movers to return (default 20)' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      try {
        const orgId = ctx?.orgId;
        if (!orgId) return { success: false, error: 'No organization context' };
        const base = process.env.QUOXSEO_URL || 'http://quoxseo:3110';
        const qs = new URLSearchParams();
        qs.set('scope', input?.scope || 'url');
        qs.set('limit', String(input?.limit || 20));
        const res = await fetch(`${base}/api/v1/trends?${qs}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'X-Quoxseo-Org': orgId }
        });
        const text = await res.text();
        if (!res.ok) return { success: false, error: `QuoxSEO returned ${res.status}: ${text}` };
        let data;
        try { data = JSON.parse(text); } catch { data = {}; }
        return { success: true, ...data };
      } catch (err) {
        return { success: false, error: `Failed to fetch QuoxSEO trends: ${err.message}` };
      }
    }
  },

  quoxseo_inspection: {
    name: 'quoxseo_inspection',
    description: "Google URL Inspection results for the org's site: the index-coverage truth from Google itself (not our on-page guess). Returns a coverage summary (how many URLs are indexed vs not indexed, broken down by Google's coverage states like 'Submitted and indexed' or 'Crawled - currently not indexed'), plus CONFLICTS where Google disagrees with the page: a URL that earns impressions but Google reports not indexed, a page we allow but Google blocks, or a page where Google chose a different canonical. Use when the user asks whether pages are indexed, about index coverage, why a page is not ranking/indexed, or about canonical or crawl problems.",
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional: indexed | not-indexed' },
        limit: { type: 'number', description: 'Max rows (default 30)' }
      },
      required: []
    },
    execute: async (input, ctx) => {
      try {
        const orgId = ctx?.orgId;
        if (!orgId) return { success: false, error: 'No organization context' };
        const base = process.env.QUOXSEO_URL || 'http://quoxseo:3110';
        const qs = new URLSearchParams();
        if (input?.filter) qs.set('filter', input.filter);
        qs.set('limit', String(input?.limit || 30));
        const res = await fetch(`${base}/api/v1/inspection?${qs}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'X-Quoxseo-Org': orgId }
        });
        const text = await res.text();
        if (!res.ok) return { success: false, error: `QuoxSEO returned ${res.status}: ${text}` };
        let data;
        try { data = JSON.parse(text); } catch { data = {}; }
        return { success: true, ...data };
      } catch (err) {
        return { success: false, error: `Failed to fetch QuoxSEO inspection: ${err.message}` };
      }
    }
  }
};

// HITL-CONTEXT (owner 2026-10-07): every tool that ALWAYS files an approval
// when an agent calls it advertises an optional `_reason`, so the human who
// approves later reads WHY in the agent's own words instead of guessing. The
// leading underscore makes it a control field: stripped before the approval
// fingerprint (approvalGate.stripControlFields), so it never changes what is
// bound. Injected here, once, so the guidance reaches every model on every
// surface (chat, CLI tools, MCP) without per-prompt edits.
const APPROVAL_REASON_PROP = {
  type: 'string',
  description: 'Why you are doing this, in one short sentence the approver can act on hours later (e.g. "Read hyp-01 backup job config to check the dev VM is covered, for gripe #710"). This call is held for human approval; ALWAYS supply it.',
};
(function injectApprovalReason() {
  let gated;
  try { gated = require('./approvalGate').AGENT_ALWAYS_PROPOSE_TOOLS; } catch { gated = null; }
  if (!gated) return;
  for (const name of gated) {
    const def = TOOL_DEFS[name];
    if (!def || !def.input_schema || typeof def.input_schema !== 'object') continue;
    def.input_schema.properties = { ...(def.input_schema.properties || {}), _reason: APPROVAL_REASON_PROP };
    if (typeof def.description === 'string' && !def.description.includes('_reason')) {
      def.description += ' Held for human approval when an agent calls it: always pass `_reason` saying why.';
    }
  }
})();

// ============================================================================
// NL→Cron helper for save_as_workflow (WC-6)
// Lightweight backend version — handles common natural language schedules
// ============================================================================

function parseNLToCron(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();

  // Already a cron expression (5 space-separated parts)
  if (/^[\d*\/,-]+\s+[\d*\/,-]+\s+[\d*\/,-]+\s+[\d*\/,-]+\s+[\d*\/,-]+$/.test(s)) {
    return s;
  }

  // Day-of-week map
  const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

  // "every <day>" or "every <day> at <time>"
  for (const [day, num] of Object.entries(dayMap)) {
    if (s.includes(day)) {
      const time = extractTime(s);
      return `${time.min} ${time.hour} * * ${num}`;
    }
  }

  // Frequency patterns
  if (/\b(every\s+hour|hourly)\b/.test(s)) return '0 * * * *';
  if (/\b(every\s+day|daily)\b/.test(s)) { const t = extractTime(s); return `${t.min} ${t.hour} * * *`; }
  if (/\b(every\s+weekday|weekdays)\b/.test(s)) { const t = extractTime(s); return `${t.min} ${t.hour} * * 1-5`; }
  if (/\b(every\s+week|weekly)\b/.test(s)) { const t = extractTime(s); return `${t.min} ${t.hour} * * 1`; }
  if (/\b(every\s+month|monthly)\b/.test(s)) { const t = extractTime(s); return `${t.min} ${t.hour} 1 * *`; }

  return null;
}

function extractTime(s) {
  // Match "at 9am", "at 14:30", "at 9:00", "at 3pm"
  const match = s.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (match) {
    let hour = parseInt(match[1], 10);
    const min = match[2] ? parseInt(match[2], 10) : 0;
    const ampm = match[3]?.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return { hour, min };
  }
  return { hour: 9, min: 0 }; // Default 9:00
}

// ============================================================================
// WB Knowledge-Index Tools (NOVA-CTX P10.1)
// Read-only tools that give workflow-builder agents on-demand access to the
// node schema, agent roster, template library, and plugin list.
// P10.2 will add these to WEAVER's allowlist; P10.3 trims her system prompt.
// ============================================================================

const { NODE_ARCHETYPES_MIRROR, NODE_CATEGORIES_MIRROR } = require('./workflowSchema');
const _wbFs = require('fs');
const _wbPath = require('path');

// Module-level cache for the workflow library index (1.6 MB, lazy-loaded once).
let _wbLibraryCache = null;
function _getWorkflowLibrary() {
  if (_wbLibraryCache) return _wbLibraryCache;
  const candidates = [
    _wbPath.join(__dirname, '../../../src/config/workflow-library-index.json'),
    '/app/workflow-library-index.json',
  ];
  for (const p of candidates) {
    if (_wbFs.existsSync(p)) {
      try {
        _wbLibraryCache = JSON.parse(_wbFs.readFileSync(p, 'utf8'));
        console.log(`[WB] Loaded workflow library index from ${p} (${_wbLibraryCache.totalWorkflows} workflows)`);
        return _wbLibraryCache;
      } catch (err) {
        console.warn(`[WB] Failed to parse workflow library index at ${p}: ${err.message}`);
      }
    }
  }
  console.warn('[WB] Workflow library index not found — wb_search_templates will return empty results.');
  _wbLibraryCache = { workflows: [] };
  return _wbLibraryCache;
}

// Plugin manifests — scanned from src/config/plugins/*.json (excluding index.js)
let _wbPluginCache = null;
function _getPluginManifests() {
  if (_wbPluginCache) return _wbPluginCache;
  const candidates = [
    _wbPath.join(__dirname, '../../../src/config/plugins'),
    '/app/plugins',
  ];
  for (const dir of candidates) {
    if (_wbFs.existsSync(dir)) {
      try {
        const files = _wbFs.readdirSync(dir).filter(f => f.endsWith('.json'));
        _wbPluginCache = files.map(f => {
          try {
            return JSON.parse(_wbFs.readFileSync(_wbPath.join(dir, f), 'utf8'));
          } catch {
            return null;
          }
        }).filter(Boolean);
        console.log(`[WB] Loaded ${_wbPluginCache.length} plugin manifests from ${dir}`);
        return _wbPluginCache;
      } catch (err) {
        console.warn(`[WB] Failed to scan plugins dir ${dir}: ${err.message}`);
      }
    }
  }
  _wbPluginCache = [];
  return _wbPluginCache;
}

TOOL_DEFS.wb_list_node_types = {
  name: 'wb_list_node_types',
  description: 'List all available QuoxFlow node types the workflow builder supports. Returns category + type + label + 1-line description per type. No params. Use this BEFORE picking a node type if you are unsure what is available.',
  input_schema: { type: 'object', properties: {}, required: [] },
  execute: async () => {
    return Object.entries(NODE_ARCHETYPES_MIRROR).map(([type, arch]) => ({
      type,
      category: arch.category,
      label: arch.label,
      description: arch.description,
    }));
  },
};

TOOL_DEFS.wb_get_node_schema = {
  name: 'wb_get_node_schema',
  description: 'Get the canonical config schema for a specific node type. Returns the type, label, category, defaultConfig (field name → default value), and a 1-line description. Use this BEFORE emitting an add_node action so your config matches the schema.',
  input_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Node type, e.g. "trigger:schedule"' },
    },
    required: ['type'],
  },
  execute: async ({ type }) => {
    const arch = NODE_ARCHETYPES_MIRROR[type];
    if (!arch) return { error: `Unknown node type: ${type}`, knownTypes: Object.keys(NODE_ARCHETYPES_MIRROR) };
    return { type, label: arch.label, category: arch.category, description: arch.description, defaultConfig: arch.defaultConfig };
  },
};

TOOL_DEFS.wb_list_agents = {
  name: 'wb_list_agents',
  description: 'List specialist agents that can be invoked by an agent:agentic node. Returns id + name + 1-line role per agent (max 40). Use this when the user asks for a workflow that needs a specialist (browser automation, security, deployments) and you need to know who is available.',
  input_schema: { type: 'object', properties: {}, required: [] },
  execute: async () => {
    // Use already-loaded assistant entities (loaded at startup via loadAssistants)
    const { _cache } = require('./entityAssistantLoader');
    const entries = [];
    for (const [id, data] of _cache.entries()) {
      entries.push({
        id,
        name: data.identity?.name || id,
        role: data.identity?.description || data.identity?.tagline || '',
      });
      if (entries.length >= 40) break;
    }
    return entries;
  },
};

TOOL_DEFS.wb_get_agent = {
  name: 'wb_get_agent',
  description: 'Get full details for a specific agent: id, name, role, capabilities, tool count or names if available, when-to-use guidance. Use this BEFORE wiring an agent into an agent:agentic node so you know what the agent can actually do.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Agent id, e.g. "browser-q"' },
    },
    required: ['id'],
  },
  execute: async ({ id }) => {
    const { getAssistant } = require('./entityAssistantLoader');
    const data = getAssistant(id);
    if (!data) return { error: `Unknown agent: ${id}` };
    const tools = AGENT_TOOLS[(id || '').toLowerCase()];
    return {
      id: data.id,
      name: data.identity?.name || data.id,
      tagline: data.identity?.tagline || '',
      description: data.identity?.description || '',
      domains: data.capabilities?.domains || [],
      tools: tools || [],
      hierarchy: {
        role: data.hierarchy?.role,
        level: data.hierarchy?.level,
        collaboratesWith: data.hierarchy?.collaboratesWith || [],
      },
    };
  },
};

TOOL_DEFS.wb_search_templates = {
  name: 'wb_search_templates',
  description: 'Search the workflow template library (1300+ templates) for relevant prior art. Returns top N templates matching the query: id, name, trigger type, key integrations, 1-line description. Use this in the discovery phase when the user describes their goal — there may be a template close to what they want.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free-text search query, e.g. "daily slack report" or "github webhook"' },
      limit: { type: 'integer', description: 'Max results to return', default: 5 },
    },
    required: ['query'],
  },
  execute: async ({ query, limit = 5 }) => {
    const lib = _getWorkflowLibrary();
    if (!lib.workflows || lib.workflows.length === 0) return [];
    const q = (query || '').toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const wf of lib.workflows) {
      const name = (wf.identity?.name || '').toLowerCase();
      const desc = (wf.identity?.description || '').toLowerCase();
      const tags = (wf.identity?.tags || []).join(' ').toLowerCase();
      const integrations = (wf.capabilities?.integrations || []).join(' ').toLowerCase();
      const haystack = `${name} ${desc} ${tags} ${integrations}`;
      let score = 0;
      for (const term of terms) {
        if (name.includes(term)) score += 3;
        else if (haystack.includes(term)) score += 1;
      }
      if (score > 0) scored.push({ score, wf });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ wf }) => ({
      id: wf.id,
      name: wf.identity?.name || wf.id,
      description: wf.identity?.description || '',
      category: wf.identity?.category || '',
      tags: wf.identity?.tags || [],
      trigger: wf.trigger?.type || '',
      integrations: wf.capabilities?.integrations || [],
      nodeCount: wf.nodeCount || 0,
    }));
  },
};

TOOL_DEFS.wb_list_plugins = {
  name: 'wb_list_plugins',
  description: 'List the plugins installed on this dashboard. Each plugin may bundle credentials and dedicated nodes/agents. Returns id + name + 1-line description. Use this when the user mentions an integration (Slack, GitHub, etc.) — you can confirm whether a plugin already provides it before scaffolding raw call nodes.',
  input_schema: { type: 'object', properties: {}, required: [] },
  execute: async () => {
    const manifests = _getPluginManifests();
    return manifests.map(m => ({
      id: m.name || m.id || '',
      name: m.displayName || m.name || '',
      description: m.shortDescription || m.description || '',
    })).filter(p => p.id);
  },
};

// ============================================================================
// WB Emit Tool — structural canvas mutation (bypasses markdown-fence parsing)
// ============================================================================

const { captureCanvasActions } = require('./canvasActionCapture');

TOOL_DEFS.wb_emit = {
  name: 'wb_emit',
  description: "Apply actions to the live workflow-builder canvas. THIS is how you create, connect, configure, or remove nodes. Markdown code blocks DO NOT execute — only this tool mutates the user's canvas. Call this any time you need to change the workflow. Provide the full set of actions for the slice you are committing.",
  input_schema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        description: 'Array of action objects. Each must have a "type" field (add_node, connect, update_node, remove_node, disconnect, set_meta, load_template, clear) and the type-specific fields (e.g. add_node needs id + nodeType + config; connect needs source + target).',
        items: { type: 'object' }
      }
    },
    required: ['actions']
  },
  execute: async ({ actions }, ctx) => {
    // No server-side mutation — the canvas is in the user's browser. We capture
    // the actions in a session-scoped store; the chat dispatcher pulls them out
    // after the LLM finishes and adds them to the response payload.
    if (!Array.isArray(actions)) return { ok: false, error: 'actions must be an array' }
    const sessionId = ctx?.session_id || ctx?.sessionId || 'default'
    captureCanvasActions(sessionId, actions)
    return { ok: true, captured: actions.length, status: 'queued_for_canvas' }
  }
};

// ============================================================================
// TOOLSMITH Slice 3a — Tool Executors
// ============================================================================
// Four tool surfaces for the Toolsmith persona (script-forge).
// validateDraft + analyseDangerous: deterministic, call local lib functions.
// generateSchema + generateDocs: LLM-driven, call /chat/claude internally.

{
  const { validate: toolsmithValidate } = require('./toolsmithValidator.js');
  const { analyse: toolsmithAnalyse } = require('./toolsmithAnalyser.js');

  /**
   * Call the chat LLM with a focused one-shot prompt.
   * Returns the text content of the response.
   */
  async function callChatLLM(systemPrompt, userPrompt) {
    const resp = await localApiFetch('/chat/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: userPrompt,
        system_prompt: systemPrompt,
        selected_agent: 'quox',
        _internal_one_shot: true,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!resp.ok) {
      throw new Error(`Chat LLM returned HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return data.result || data.response || '';
  }

  /**
   * Extract the first JSON object/array from an LLM response string.
   * LLMs sometimes wrap JSON in markdown fences — this handles both.
   */
  function extractJson(text) {
    // Try direct parse first
    try { return JSON.parse(text.trim()); } catch { /* fall through */ }

    // Try extracting from markdown code fences
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      try { return JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ }
    }

    // Try finding first { ... } block
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try { return JSON.parse(objMatch[0]); } catch { /* fall through */ }
    }

    throw new Error('No valid JSON found in LLM response');
  }

  // ── toolsmith.validateDraft ───────────────────────────────────────────────

  TOOL_DEFS['toolsmith.validateDraft'] = {
    name: 'toolsmith.validateDraft',
    description: 'Validate a Quox Tool Definition artefact set (tool.json, script.py, tests.json, requirements.txt, README.md). Returns validation errors and warnings. Use during Step 2 (Tool Definition) of the build pipeline.',
    input_schema: {
      type: 'object',
      properties: {
        files: {
          type: 'object',
          description: 'Key-value map of filename → file content. Expected keys: tool.json, script.py, tests.json, requirements.txt, README.md',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['files'],
    },
    execute: async (input, ctx) => {
      if (!input.files || typeof input.files !== 'object') {
        return { valid: false, errors: [{ file: 'files', severity: 'error', code: 'MISSING_FILES', message: 'files is required and must be an object' }], warnings: [] };
      }
      const result = toolsmithValidate(input.files);

      // AOCL envelope emission
      if (ctx?.emitEnvelope) {
        await ctx.emitEnvelope({
          intent: 'quox.toolsmith.validate',
          payload: {
            valid: result.valid,
            error_count: result.errors.length,
            warning_count: result.warnings.length,
          },
        });
      }

      return result;
    },
  };

  // ── toolsmith.analyseDangerous ────────────────────────────────────────────

  TOOL_DEFS['toolsmith.analyseDangerous'] = {
    name: 'toolsmith.analyseDangerous',
    description: 'Static analysis of script.py for dangerous patterns (network, filesystem, subprocess, secrets, blocked calls). Returns flags and a suggested permissions block for tool.json. Use during Step 3 (Policy Check) of the build pipeline.',
    input_schema: {
      type: 'object',
      properties: {
        scriptPy: {
          type: 'string',
          description: 'The Python script content to analyse',
        },
      },
      required: ['scriptPy'],
    },
    execute: async (input, ctx) => {
      if (typeof input.scriptPy !== 'string') {
        return { error: 'scriptPy is required and must be a string', flags: [], suggestedPermissions: null };
      }
      const result = toolsmithAnalyse(input.scriptPy);

      // AOCL envelope emission
      if (ctx?.emitEnvelope) {
        await ctx.emitEnvelope({
          intent: 'quox.toolsmith.analyse',
          payload: {
            flag_count: result.flags.length,
            network: result.suggestedPermissions.network,
            filesystem: result.suggestedPermissions.filesystem,
            subprocess: result.suggestedPermissions.subprocess,
            approval_required: result.suggestedPermissions.approval_required,
            secret_count: result.suggestedPermissions.secrets.length,
          },
        });
      }

      return result;
    },
  };

  // ── toolsmith.generateSchema ──────────────────────────────────────────────

  TOOL_DEFS['toolsmith.generateSchema'] = {
    name: 'toolsmith.generateSchema',
    description: 'Generate strict JSON Schema 2020-12 for inputs and outputs by analysing script.py. Returns { inputsSchema, outputsSchema }. Use during Step 2 (Tool Definition) to derive schemas from function signatures.',
    input_schema: {
      type: 'object',
      properties: {
        scriptPy: {
          type: 'string',
          description: 'The Python script content',
        },
        signatureHint: {
          type: 'string',
          description: 'Optional human-readable signature hint (e.g. "servers: list[str] -> results: list[dict]")',
        },
      },
      required: ['scriptPy'],
    },
    execute: async (input, ctx) => {
      if (typeof input.scriptPy !== 'string') {
        return { error: 'scriptPy is required' };
      }
      const systemPrompt = `You are a JSON Schema expert. The user will provide a Python script with a quox_tool_main(inputs: dict) -> dict function. Your job is to generate strict JSON Schema 2020-12 for the inputs and outputs.

Return ONLY a JSON object with this exact shape — no markdown, no explanation:
{
  "inputsSchema": { "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": {...}, "required": [...] },
  "outputsSchema": { "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": {...}, "required": [...] }
}

Rules:
- Use specific types (string, number, integer, boolean, array, object) — never "any"
- Add descriptions to each property
- Mark all fields that appear required as required[]
- For array items, always specify "items" type
- Return ONLY the JSON, nothing else`;

      const userPrompt = `Script:\n\`\`\`python\n${input.scriptPy.slice(0, 8000)}\n\`\`\`${input.signatureHint ? `\n\nSignature hint: ${input.signatureHint}` : ''}`;

      try {
        const raw = await callChatLLM(systemPrompt, userPrompt);
        const parsed = extractJson(raw);
        if (!parsed.inputsSchema || !parsed.outputsSchema) {
          return { error: 'LLM response did not contain inputsSchema and outputsSchema', raw };
        }
        return { inputsSchema: parsed.inputsSchema, outputsSchema: parsed.outputsSchema };
      } catch (err) {
        return { error: `Schema generation failed: ${err.message}` };
      }
    },
  };

  // ── toolsmith.generateDocs ────────────────────────────────────────────────

  TOOL_DEFS['toolsmith.generateDocs'] = {
    name: 'toolsmith.generateDocs',
    description: 'Generate documentation for a Quox tool: README.md, a Google-style docstring, and a one-line description. Returns { readmeMd, docstringMd, descriptionLine }. Use during Step 2 or after tests pass.',
    input_schema: {
      type: 'object',
      properties: {
        scriptPy: {
          type: 'string',
          description: 'The Python script content',
        },
        toolJson: {
          type: 'string',
          description: 'The tool.json content (JSON string)',
        },
      },
      required: ['scriptPy', 'toolJson'],
    },
    execute: async (input, ctx) => {
      if (typeof input.scriptPy !== 'string' || typeof input.toolJson !== 'string') {
        return { error: 'scriptPy and toolJson are required' };
      }

      let toolDef;
      try { toolDef = JSON.parse(input.toolJson); } catch { toolDef = {}; }

      const systemPrompt = `You are a technical writer generating documentation for a Quox tool (a governed Python tool that runs inside a sandboxed executor).

Return ONLY a JSON object with this exact shape — no markdown wrapper, no explanation:
{
  "readmeMd": "# ToolName\\n\\n...",
  "docstringMd": "Google-style docstring text (without the triple quotes)",
  "descriptionLine": "One-line agent-prompt-grade description (≤120 chars)"
}

The README must include: what the tool does, required permissions, example inputs/outputs, any caveats.
The docstring must follow Google style: Summary line, Args section, Returns section.
The description line must be concise enough to fit in an agent system prompt.`;

      const userPrompt = `Tool name: ${toolDef.name || 'unknown'}

Script:
\`\`\`python
${input.scriptPy.slice(0, 6000)}
\`\`\`

tool.json:
\`\`\`json
${input.toolJson.slice(0, 2000)}
\`\`\``;

      try {
        const raw = await callChatLLM(systemPrompt, userPrompt);
        const parsed = extractJson(raw);
        if (!parsed.readmeMd || !parsed.docstringMd || !parsed.descriptionLine) {
          return { error: 'LLM response missing required doc fields', raw };
        }
        return {
          readmeMd: parsed.readmeMd,
          docstringMd: parsed.docstringMd,
          descriptionLine: parsed.descriptionLine,
        };
      } catch (err) {
        return { error: `Documentation generation failed: ${err.message}` };
      }
    },
  };
}

// ============================================================================
// TOOLSMITH Slice E — toolsmith.runScript chat-side tool executor
//
// Dual-surface wiring: the sandbox run endpoint (POST /api/internal/toolsmith/sandbox/run)
// and the chat-side tool executor both call the same scriptExecutor.runScript code path.
// Per feedback_chat_vs_executor_tool_surfaces_2026_05_13.md — telemetry from only one
// surface is half-shipped.
//
// ctx._scriptExecutor allows test injection of a mock (avoids Docker in unit tests).
// ============================================================================

{
  TOOL_DEFS['toolsmith.runScript'] = {
    name: 'toolsmith.runScript',
    description:
      'Run a Quox tool script in the secure sandbox. Use this to test a draft script ' +
      'before installation. Returns stdout, stderr, exitCode, durationMs, and an evidence ' +
      'bundle ID (VOLT). Only call when the user explicitly asks to test/run the tool.',
    input_schema: {
      type: 'object',
      properties: {
        scriptContent: {
          type: 'string',
          description: 'Python script content to execute in the sandbox.',
        },
        inputsJson: {
          type: 'object',
          description: 'JSON object supplied as inputs to the script (available inside the container as QUOX_PARAMS env var; read with json.loads(os.environ["QUOX_PARAMS"])).',
          default: {},
        },
        permissions: {
          type: 'object',
          description: 'Permission set: { network, filesystem, secrets, subprocess, approval_required }.',
          properties: {
            network:          { type: 'boolean' },
            filesystem:       { type: 'boolean' },
            secrets:          { type: 'array', items: { type: 'string' } },
            subprocess:       { type: 'boolean' },
            approval_required: { type: 'boolean' },
          },
          required: ['network', 'filesystem', 'secrets', 'subprocess', 'approval_required'],
        },
        profile: {
          type: 'string',
          enum: ['restricted', 'standard'],
          description: 'Sandbox seccomp profile. Defaults to "restricted".',
          default: 'restricted',
        },
        voltSessionId: {
          type: 'string',
          description: 'VOLT correlation ID for linking run evidence to a session.',
        },
        walltimeMs: {
          type: 'number',
          description: 'Walltime limit in milliseconds. Defaults to 30000.',
          default: 30000,
        },
      },
      required: ['scriptContent', 'permissions'],
    },

    execute: async (input, ctx) => {
      const {
        scriptContent,
        inputsJson = {},
        permissions,
        profile = 'restricted',
        voltSessionId = null,
        walltimeMs = 30000,
      } = input || {};

      if (!scriptContent || typeof scriptContent !== 'string') {
        return { error: 'scriptContent is required and must be a string' };
      }

      // Allow test injection via ctx._scriptExecutor to avoid Docker in unit tests
      const executor = (ctx && ctx._scriptExecutor) || require('./scriptExecutor.js');

      const crypto = require('crypto');
      const scriptHash = crypto.createHash('sha256').update(scriptContent).digest('hex');

      try {
        const runResult = await executor.runScript({
          scriptHash,
          scriptContent,
          inputsJson,
          permissions,
          profile,
          voltSessionId,
          walltimeMs,
          voltEmitter: ctx && ctx.voltEmitter ? ctx.voltEmitter : null,
        });

        // AOCL envelope emission on the chat side (same envelopes the HTTP endpoint emits)
        if (ctx && ctx.emitEnvelope && runResult.aoclEnvelopes) {
          for (const env of runResult.aoclEnvelopes) {
            try {
              await ctx.emitEnvelope({ intent: env.intent, payload: env.payload });
            } catch (_) { /* envelope emission is non-fatal */ }
          }
        }

        return runResult;
      } catch (err) {
        return { error: `Sandbox run failed: ${err.message}` };
      }
    },
  };
}

// ============================================================================
// Quartermaster — search_catalog
// ============================================================================
// AGENT-OVERHAUL: hits the auth-side INTERNAL (service-key gated) tool
// search endpoint instead of the user-facing POST /api/tools/search, which
// sits behind the global CSRF double-submit gate. Agent tool calls run
// server-to-server with no browser session, so they can never carry a CSRF
// cookie/header pair — search_catalog always 403'd "Missing CSRF token
// header". services/auth/routes/internal-tool-search.js is CSRF-exempt
// (/api/internal/ prefix) and service-key gated (same auth mechanism as
// KEEPER's internal-backups.js). org_id is required and threaded through
// explicitly (never a wildcard), even though the underlying catalog is a
// static, non-org-scoped index (in-memory inverted index over the
// 3198-entry tool-library-index.json) — no cross-org data exists to leak.
{
  const AUTH_BASE = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;

  TOOL_DEFS['search_catalog'] = {
    name: 'search_catalog',
    description:
      'Search the Quox tool library by natural-language query. Returns up to N matching tools ' +
      'with name, description, category, and reference URL. Use this when the user asks you to ' +
      'recommend a tool, find tools for a use case, or list tools matching a description.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "Natural language search query, e.g. 'image manipulation' or 'slack messaging'",
        },
        limit: {
          type: 'number',
          default: 20,
          description: 'Max matches to return (1-50)',
        },
        subcategory_filter: {
          type: 'string',
          description: "Optional: restrict to a specific subcategory like 'mcp-server', 'public-api', 'security'",
        },
      },
      required: ['query'],
    },
    execute: async (input, ctx) => {
      const { query, limit = 20, subcategory_filter } = input || {};

      if (!query || typeof query !== 'string') {
        return { error: 'query is required and must be a string', matches: [] };
      }
      if (!ctx?.orgId) {
        return { error: 'No org context — cannot search the catalog without an organization', matches: [] };
      }

      const body = {
        org_id: ctx.orgId,
        query: query.trim(),
        limit: Math.min(Math.max(1, Number(limit) || 20), 50),
      };
      if (subcategory_filter) {
        body.filters = { subcategory: subcategory_filter };
      }

      try {
        const resp = await fetch(`${AUTH_BASE}/api/internal/tools/search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        });

        const data = await resp.json();

        // Guard on status BEFORE treating the body as data — a non-2xx must
        // never be reported as a successful match list.
        if (!resp.ok) {
          return { error: `Catalog search failed: ${data?.message || resp.status}`, matches: [] };
        }

        return {
          matches:          data.matches || [],
          total_in_catalog: data.total_in_catalog,
          query_time_ms:    data.query_time_ms,
        };
      } catch (err) {
        return { error: `Catalog search error: ${err.message}`, matches: [] };
      }
    },
  };
}

// ============================================================================
// QUARTERMASTER (tooling steward) — introspection tools
// ============================================================================
// Born 2026-09-21 from the tooling-audit program: the steward needs to see a
// tool's real contract and which agents carry it, and to spot thin/weak agents
// by tool coverage. Both are in-memory, read-only reads over TOOL_DEFS /
// AGENT_TOOLS — no external calls, no writes.

TOOL_DEFS['tool_inspect'] = {
  name: 'tool_inspect',
  description:
    'Inspect one tool\'s full contract: description, input schema (required + optional fields), ' +
    'executor type, and which agents carry it. Use before recommending or auditing a tool so you ' +
    'report its real shape instead of guessing.',
  input_schema: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: "Exact tool name to inspect, e.g. 'network_check' or 'memory_save'" },
    },
    required: ['tool'],
  },
  execute: async (input, ctx) => {
    const name = String((input && input.tool) || '').trim();
    if (!name) return { success: false, error: 'tool is required (the exact tool name to inspect)' };
    let def = null;
    try { def = getToolDef(name, ctx && ctx.orgId); } catch (e) { return { success: false, error: `tool lookup failed: ${e.message}` }; }
    if (!def) return { success: false, error: `unknown_tool: '${name}' is not a registered tool (connector-family tools are not introspectable here)` };
    const schema = def.input_schema || {};
    const props = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const used_by = Object.keys(AGENT_TOOLS).filter(
      (a) => Array.isArray(AGENT_TOOLS[a]) && AGENT_TOOLS[a].includes(name),
    );
    return {
      success: true,
      tool: {
        name: def.name || name,
        description: def.description || null,
        executor_type: def._executorType || 'core',
        required,
        optional: Object.keys(props).filter((p) => !required.includes(p)),
        input_schema: schema,
      },
      used_by,
      used_by_count: used_by.length,
    };
  },
};

TOOL_DEFS['agent_tools'] = {
  name: 'agent_tools',
  description:
    'List an agent\'s tool scope, or (with no agent) the whole roster\'s tool coverage sorted thinnest-first ' +
    'to surface weak/unfinished agents. Core tool grants only (connector-family tools are counted separately elsewhere).',
  input_schema: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: "Optional agent id, e.g. 'triage-q'. Omit for the whole-roster coverage overview." },
    },
    required: [],
  },
  execute: async (input) => {
    const agent = String((input && input.agent) || '').trim().toLowerCase();
    if (agent) {
      const tools = AGENT_TOOLS[agent];
      if (!Array.isArray(tools)) {
        return { success: false, error: `unknown_or_custom_agent: '${agent}' has no core tool list (it may be a custom/DB-defined agent)` };
      }
      return { success: true, agent, count: tools.length, tools };
    }
    const roster = Object.keys(AGENT_TOOLS)
      .filter((a) => Array.isArray(AGENT_TOOLS[a]))
      .map((a) => ({ agent: a, tool_count: AGENT_TOOLS[a].length }))
      .sort((x, y) => x.tool_count - y.tool_count);
    return { success: true, total_agents: roster.length, roster };
  },
};

// ============================================================================
// ARCHIVIST — real, org-scoped, server-backed file read tools
// ============================================================================
// AGENT-OVERHAUL: ARCHIVIST's file tools (read_file/search_files/list_files)
// previously existed only in the frontend (localStorage-backed fileStorage.js)
// and were never granted in the collector at all. This wires 3 read-only
// tools to the real server-side file store: services/auth/routes/file-objects.js
// (file_objects table, org-scoped, content-addressed on disk). Write/upload
// is deliberately out of scope here — these are read tools only.
//
// AUTH_BASE_URL already ends in /api (see top of file) — paths below start
// with /orgs/..., NOT /api/orgs/..., or the request doubles to /api/api and
// 404s (the exact bug proven live 2026-08-08 on backup_run). Asserted in tests.

function isTextualFile(mime, filename) {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('text/')) return true;
  if (m === 'application/json' || m === 'application/xml' || m.endsWith('+xml')) return true;
  if (m.includes('csv') || m.includes('yaml') || m.includes('markdown') || m.includes('javascript')) return true;
  if (!m) {
    return /\.(txt|json|xml|csv|ya?ml|md|markdown|js|jsx|ts|tsx|log|ini|conf|env|sh)$/i.test(filename || '');
  }
  return false;
}

TOOL_DEFS['list_files'] = {
  name: 'list_files',
  description: 'List files stored in the org file store (file_objects), optionally filtered by a namespace prefix. Returns filename, mime type, size, virtual path and creation time — never internal blob paths or content hashes.',
  input_schema: {
    type: 'object',
    properties: {
      namespace_prefix: { type: 'string', description: "Optional namespace prefix filter, e.g. 'knowledge' or 'uploads'" },
      limit: { type: 'number', description: 'Max files to return (1-200, default 50)' },
    },
    required: [],
  },
  execute: async (input, ctx) => {
    if (!ctx?.token || !ctx?.orgId) {
      return { success: false, error: 'org_context_required', message: 'list_files needs an authenticated user session with organization context.' };
    }
    const { namespace_prefix, limit } = input || {};
    try {
      const params = new URLSearchParams();
      if (namespace_prefix) params.set('namespace_prefix', namespace_prefix);
      if (limit) params.set('limit', String(Math.min(Math.max(1, Number(limit) || 50), 200)));
      const qs = params.toString();
      const resp = await fetch(`${AUTH_BASE_URL}/orgs/${encodeURIComponent(ctx.orgId)}/files${qs ? `?${qs}` : ''}`, {
        headers: { Authorization: `Bearer ${ctx.token}` },
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        return { success: false, error: data?.error || `HTTP ${resp.status}`, status: resp.status };
      }
      const items = data?.items || [];
      const files = items.map((f) => ({
        id: f.id,
        filename: f.filename,
        mime: f.mime,
        size_bytes: f.size_bytes,
        virtual_path: f.virtual_path,
        created_at: f.created_at,
      }));
      return { success: true, count: files.length, total: data?.pagination?.total ?? files.length, files };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};

TOOL_DEFS['read_file'] = {
  name: 'read_file',
  description: 'Read a file from the org file store by id. Text-like files (text/*, JSON, XML, CSV, YAML, Markdown, JS) are returned as content, truncated to 50,000 characters. Binary files return metadata only — raw bytes are never streamed into the model.',
  input_schema: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'The file id (from list_files or search_files)' },
    },
    required: ['file_id'],
  },
  execute: async (input, ctx) => {
    if (!ctx?.token || !ctx?.orgId) {
      return { success: false, error: 'org_context_required', message: 'read_file needs an authenticated user session with organization context.' };
    }
    const { file_id } = input || {};
    if (!file_id || typeof file_id !== 'string') {
      return { success: false, error: 'file_id is required and must be a string' };
    }
    try {
      const headers = { Authorization: `Bearer ${ctx.token}` };
      const metaResp = await fetch(`${AUTH_BASE_URL}/orgs/${encodeURIComponent(ctx.orgId)}/files/${encodeURIComponent(file_id)}/meta`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (metaResp.status === 404) {
        return { success: false, error: 'not_found', message: `No file with id ${file_id}` };
      }
      const meta = await metaResp.json().catch(() => null);
      if (!metaResp.ok) {
        return { success: false, error: meta?.error || `HTTP ${metaResp.status}`, status: metaResp.status };
      }

      const fileMeta = { id: meta?.id, filename: meta?.filename, mime: meta?.mime, size_bytes: meta?.size_bytes };

      if (!isTextualFile(meta?.mime, meta?.filename)) {
        return {
          success: true,
          file: fileMeta,
          content: null,
          note: `binary file (${meta?.mime || 'unknown mime'}, ${meta?.size_bytes ?? 0} bytes) — not returned as text`,
        };
      }

      const contentResp = await fetch(`${AUTH_BASE_URL}/orgs/${encodeURIComponent(ctx.orgId)}/files/${encodeURIComponent(file_id)}`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!contentResp.ok) {
        return { success: false, error: `HTTP ${contentResp.status}`, status: contentResp.status };
      }
      const raw = await contentResp.text();
      const truncated = raw.length > 50000;
      return { success: true, file: fileMeta, content: truncated ? raw.slice(0, 50000) : raw, truncated };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};

TOOL_DEFS['search_files'] = {
  name: 'search_files',
  description: 'Search org files by filename or virtual path (case-insensitive substring match against both fields).',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search term to match against filename or virtual_path' },
    },
    required: ['query'],
  },
  execute: async (input, ctx) => {
    if (!ctx?.token || !ctx?.orgId) {
      return { success: false, error: 'org_context_required', message: 'search_files needs an authenticated user session with organization context.' };
    }
    const { query } = input || {};
    if (!query || typeof query !== 'string') {
      return { success: false, error: 'query is required and must be a string' };
    }
    try {
      const resp = await fetch(`${AUTH_BASE_URL}/orgs/${encodeURIComponent(ctx.orgId)}/files?limit=200`, {
        headers: { Authorization: `Bearer ${ctx.token}` },
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        return { success: false, error: data?.error || `HTTP ${resp.status}`, status: resp.status };
      }
      const items = data?.items || [];
      const q = query.toLowerCase();
      const matches = items
        .filter((f) => (f.filename || '').toLowerCase().includes(q) || (f.virtual_path || '').toLowerCase().includes(q))
        .map((f) => ({ id: f.id, filename: f.filename, mime: f.mime, virtual_path: f.virtual_path }));
      return { success: true, count: matches.length, matches };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};

// ============================================================================
// Agent → Tool Mapping
// ============================================================================

// QCX-3.3 — Merge QuoxChat MCP tools into the registry. Agents are granted
// access below via AGENT_TOOLS. The pure tool module keeps definitions
// isolated + testable; merging here is a one-line append.
try {
  const { QUOXCHAT_MCP_TOOLS } = require('./quoxchatMcpTools');
  for (const [name, def] of Object.entries(QUOXCHAT_MCP_TOOLS)) {
    TOOL_DEFS[name] = def;
  }
} catch (err) {
  console.warn('[agentTools] QuoxChat MCP tool merge failed (non-fatal):', err?.message);
}

// QUOXHAT P-A — hat-governance tools universal (but NARROW). Every agent can
// inspect its active hat, load a presentation bundle, and PROPOSE a switch for
// ITS OWN scope. This is the mechanism to operate within hats; an agent without
// it is trapped by construction (the #657 bootstrap trap: a specialist stuck in
// an empty hat with no way to discover or load the tools it needs). "Universal"
// is deliberately narrow: authenticated inspect / load-presentation /
// propose-switch only. It is NOT universal switching (hat_propose_switch files
// a HITL item, it never applies a switch), NOT private-hat visibility, and NOT
// approval authority. Applied at the grant resolver (getToolsForAgent) rather
// than spread into 56 AGENT_TOOLS arrays, so it cannot drift per-agent.
const GOVERNANCE_TOOLS = ['hat_catalogue', 'hat_load_bundle', 'hat_propose_switch'];

// QUOXHAT MISSION D1 — the Tier-0 self-read floor. A universal floor beneath
// EVERY hat: self-scoped, read-only, zero-effect reads of the caller's OWN
// context that a hat may never strip (reading your own HITL inbox is not a
// privileged escalation — the owner sandwich-test defect, 2026-10-02).
// Membership criteria (keep this set small and READ-ONLY): (1) reads only
// ctx.orgId/userId, never a caller-supplied scope; (2) no external effect /
// spend / mutation; (3) no separate approval gate. These are the "aware of your
// own context" floor the owner's Mirror thesis calls for — a hat bounds what an
// agent can DO, never what it can read about its own org.
//   - inbox_pending     : the caller's own HITL queue (ctx.orgId), triage-q-only before.
//   - memory_search     : the org/user's own memory (server-scoped, read-only).
//   - quoxbrain_search  : the org's knowledge brain (server-enforced access, read-only).
// CommanderQ-floor ask (voice session, 2026-10-02). NOTE: current-roadmap reads
// are quoxplan PLUGIN tools (not in this static TOOL_DEFS floor); the native
// roadmap_* tools read the RETIRED archive, so roadmap is deliberately NOT here.
//   - time_now          : the server clock (no org data, no network), QUOXON 2026-10-12.
const TIER0_READ_TOOLS = ['inbox_pending', 'memory_search', 'quoxbrain_search', 'time_now'];

// QUOXHAT MISSION D1.4 — CommanderQ IS the orchestrator (quox) under its
// voice/display name (the dashboard defines it as "QUOX (CommanderQ)"). The sync
// getToolsForAgent already falls back commanderq->quox, but the ASYNC resolver
// (_resolveToolsForAgent — what getToolsWithConnectors and the /chat handler use)
// and the executeTool native RBAC treated 'commanderq' as an UNREGISTERED agent:
// empty hardcoded slice + no DB assignments => ZERO tools, and RBAC fail-closed.
// That stranded CommanderQ on the phone with an empty manifest (voice sandwich
// test, 2026-10-02) while quox/Default was fine. Canonicalise the id so
// CommanderQ resolves identically to quox on EVERY path. This does NOT widen
// authority: claiming 'commanderq' now yields exactly what claiming 'quox'
// already would, and only this one explicit alias is mapped (unknown agents
// still fail closed).
const AGENT_ID_ALIASES = { commanderq: 'quox' };
function canonicalAgentId(agentId) {
  const k = (agentId || 'quox').toLowerCase();
  return AGENT_ID_ALIASES[k] || k;
}
// aliasAgentId is the NARROW, case-preserving form (D1.5): it ONLY remaps a known
// display-name alias (commanderq -> quox) and returns every other id unchanged
// (same case, and null/undefined stay null/undefined). Use this at identity
// validation + entry points (resolveCallerAgentId, the /chat selected_agent) where
// lowercasing or defaulting an absent id would change behaviour. canonicalAgentId
// (which also lowercases + defaults to quox) stays for the tool-RESOLUTION helpers.
function aliasAgentId(agentId) {
  if (!agentId || typeof agentId !== 'string') return agentId;
  return AGENT_ID_ALIASES[agentId.toLowerCase()] || agentId;
}

// Memory tools available to all agents
const MEMORY_TOOLS = ['memory_save', 'memory_search', 'memory_update', 'entity_note'];

// BRAIN2-NIGHT2: Qortex knowledge search — available to every agent, not just a hand-picked few
// BRAIN2-W7 E 126: search without the read tool left agents answering from snippets. The universal Tier-0 floor (hat-pinned) is unchanged.
const KNOWLEDGE_TOOLS = ['quoxbrain_search', 'quoxbrain_read'];

// BRAIN2-V3 A2: write side of the brain. Deliberately NOT in KNOWLEDGE_TOOLS (that
// set is read-only and spread into every agent); granted to the orchestrator and cortex.
const BRAIN_CAPTURE_TOOLS = ['brain_save', 'brain_update', 'brain_delete', 'brain_restore'];
// ONE-BRAIN CX2: read-only exploration of a note's connections and history.
const BRAIN_EXPLORE_TOOLS = ['brain_related', 'brain_neighbours', 'brain_history', 'brain_context', 'brain_check', 'brain_why'];

// QSKL-CHAT-BRIDGE.1+2: Skills catalog discovery + view + manage — available to all agents
// QSKL-13: session_search added — search past agentic session history via FTS
const SKILL_TOOLS = ['skills_list', 'skill_view', 'skill_manage', 'session_search'];

// Action tools — available to orchestrator and relevant agents
const ACTION_TOOLS = ['action_add', 'action_list', 'action_move', 'action_update', 'action_delete'];

const AGENT_TOOLS = {
  // Orchestrator gets everything + delegation
  quox: [
    // QUOXHAT P4 — progressive-disclosure tools (catalogue + bundle load)
    'hat_catalogue', 'hat_load_bundle', 'hat_propose_switch',
    // QUOXON-REACH lane G: what the CLI reads for vault, notes, calendar, files, plugins,
    // spend, identity and install, the orchestrator reads too. All read-only and org-scoped
    // from the turn; notesq_* and calendar_* stay licence-gated per tool (TOOL_REQUIRES_PLUGIN).
    // Writes (vault_test, notesq_create, plugin_enable, settings_set...) stay off quox.
    'vault_list', 'vault_types',
    'notesq_search', 'notesq_list', 'notesq_read',
    'calendar_layers_list', 'calendar_agenda', 'calendar_coverage_status', 'calendar_event_get',
    'list_files', 'search_files', 'read_file',
    'plugin_list', 'spend_status', 'identity_status', 'install_status', 'license_status',
    // QUOXON-ASK lane J: any real CLI leaf, as the caller. quox_cli runs reads;
    // quox_cli_write runs writes only after an approval card (lib/quoxCliTools.js).
    'quox_cli', 'quox_cli_write',
    // QUOXON-PROOF lane I (quox#822-#825): what this turn runs on and provider health,
    // the routing policy, the live backup record, live sessions and the prompt library.
    // Read-only, org from the turn, caller bearer. See lib/quoxonProofReadTools.js.
    'llm_status', 'llm_policy', 'backup_overview', 'live_sessions', 'prompt_list', 'prompt_read',
    // LUCID: background situational awareness, read-only (what needs the owner, per-item detail).
    'lucid_situation', 'lucid_item',
    'delegate_to_agent', 'orchestrate_objective', 'get_objective_results', 'save_as_workflow',
    // CONTACTSQ P0: read-only, masked cards/greetings only (never raw identifiers).
    'contacts_resolve', 'contacts_find', 'contacts_search', 'contacts_dial', 'contacts_send',
    // CONTACTSQ P8B: one-approval batches + the contact open in the dashboard.
    'contacts_dial_batch', 'contacts_send_batch', 'contacts_focus',
    // CONTACTSQ P5: propose a fact (lands for human review, ungated: reaches no one) and read confirmed context (approval-gated lease).
    'contacts_propose_fact', 'contacts_context',
    // CONTACTSQ P2: channel policy lookup + live objection capture (reduces reach only, ungated).
    'contacts_best_channel', 'contacts_record_objection',
    // CONTACTSQ P3: interaction history (refs only) + record-only touchpoint log (ungated, reaches no one).
    'contacts_timeline', 'contacts_log_touchpoint',
    'create_inbox_item', 'create_workflow', 'send_notification',
    // ORG-DIRECTORY — read-only org/division/team enumeration for the caller
    'org_directory',
    // BLAST-RADIUS-P2 — self/other-agent governed blast-radius check, read-only
    'reach_agent',
    'list_workflows', 'get_workflow', 'delete_workflow',
    'execute_workflow', 'list_executions', 'get_execution',
    'activate_workflow', 'deactivate_workflow', 'list_schedules',
    'list_approvals', 'approve_request', 'deny_request',
    // Read-only public page reader (assertSafeEgressHost on every hop, untrusted-content notice); D3 offers it when the user's message holds a URL.
    'web_read',
    'query_envelopes', 'get_envelope_chain', 'list_evidence', 'validate_workflow',
    'import_n8n_workflow', 'deploy_template',
    // X-PLUGIN P2: the quox x CLI executes as the orchestrator; the x_*
    // writes only file HITL cards, so the grant is draft-not-publish.
    'x_post', 'x_thread', 'x_delete', 'x_budget_status',
    // X-PLUGIN P10 slice B: engagement writes, same draft-not-publish grant.
    'x_like', 'x_repost',
    'ssh_exec', 'fleet_status', 'docker_status', 'docker_extended',
    'system_admin', 'network_check', 'proxmox_vms', 'proxmox_cluster_status',
    'proxmox_vm_action', 'security_audit', 'metrics_query',
    'gemini_image_generate', 'grafana_dashboards', 'alerts_manage',
    'execution_intelligence', 'codebase_query',
    // QUOXIFY pass 2 (DEVSUITE phase 15): Slots is an ADDRESSING primitive,
    // so the orchestrator gets its tools rather than a Slots persona (owner
    // decision, note #2843). This is what lets QUOX steer a working session
    // by durable address instead of needing to know which session is live.
    // slot_assign is approval-gated in the tool itself: pool curation is an
    // admin action and the route's admin gate lets service callers through.
    'slot_list', 'slot_say', 'slot_read', 'slot_assign',
    // AGENT-OVERHAUL-2 — roadmap_list/roadmap_show/roadmap_stats grant
    // removed (archive readers over the retired roadmap-cli, 2026-07-25
    // cutover). quoxplan_* below is the live source of truth.
    'quoxplan_roadmaps', 'quoxplan_streams', 'quoxplan_stream_brief', 'quoxplan_notes',
    // QUOXPLAN-P7 — governed writes over the same QuoxPlan corpus (notes,
    // status, phase ticks). Refuses quox-strategic (replica) writes and
    // COMPLETE transitions in-tool; see lib/quoxplanTools.js.
    'quoxplan_add_note', 'quoxplan_set_status', 'quoxplan_tick_phase',
    // QUOXPLAN-P7 — HITL-gated completion: files an owner approval instead
    // of setting COMPLETE directly; see lib/quoxplanTools.js.
    'quoxplan_request_complete',
    // QCX-3.3 — QuoxChat widget tools via MCP
    'quoxchat_list_widgets', 'quoxchat_search_knowledge', 'quoxchat_simulate_message',
    // VAULT-AUDIT P3.D1 — IMAP mailbox read via vault email_account credential
    'email_read',
    // VAULT-AUDIT P3.D3 — SMTP mailbox send via vault email_account credential
    'email_send',
    // VAULT-AUDIT P4.B — TLS certificate metadata via vault tls_cert credential
    'tls_cert_info',
    // VAULT-AUDIT P4.A-collector — SSH exec via vault ssh_key credential
    'remote_ssh',
    // VAULT-AUDIT P4.C — SQL query via vault database credential
    'db_query',
    // CommanderQ reachability tools (COMMANDERQ-P2, read)
    'agh_chain_leaderboard', 'noc_tool_outcomes', 'doneengine_readiness',
    'quoxlens_read', 'compliance_read', 'governance_read',
    // CommanderQ reachability tools (COMMANDERQ-P2, write — governance-gated)
    'quoxlens_accept_risk', 'quoxlens_apply', 'compliance_create',
    'compliance_update', 'governance_propose_policy', 'governance_change_policy',
    // CommanderQ Plan-as-Artifact tools (COMMANDERQ-P5)
    'plan_artifact_create', 'plan_artifact_get', 'plan_artifact_diff',
    // CommanderQ commitment ledger tools (COMMANDERQ-P8)
    'commitment_create', 'commitment_list', 'commitment_resolve',
    // CommanderQ calibration self-audit (COMMANDERQ-P11/B3)
    'calibration_self_audit',
    // CommanderQ outcome-learned routing advisory (COMMANDERQ-P7)
    'delegation_router_advise',
    // CommanderQ contactability (COMMANDERQ-P9, deny-by-default; propose-only writes)
    'contactability_check', 'contactability_propose_optin', 'standing_watch_register',
    // CommanderQ outbound calls (COMMANDERQ-P10, deny-by-default intent + signed summary)
    'call_raise_intent', 'call_summarize_and_end', 'call_provider_readiness',
    ...MEMORY_TOOLS,
    ...SKILL_TOOLS,
    ...ACTION_TOOLS,
    ...KNOWLEDGE_TOOLS,
    ...BRAIN_CAPTURE_TOOLS,
    ...BRAIN_EXPLORE_TOOLS,
    'brain_brief',
    // ONE-BRAIN Phase A2 (QuoxPlan #493) — unified recall across memory,
    // brain and execution wisdom.
    'recall',
    // QUOXON-PARITY lane E1 (#809, #810, #811): what the CLI reads, the orchestrator
    // reads. All read-only and org-scoped from the turn; the inbox_* and quoxseo_*
    // reads stay licence-gated per tool (TOOL_REQUIRES_PLUGIN), so an org without the
    // plugin gets an honest refusal, not data.
    'ward_verify', 'ward_status', 'standing_grants_list', 'safety_status', 'memory_history',
    // #818: what a peer agent can do comes from the registry, not the model's guess.
    'agent_directory',
    'quoxseo_summary', 'quoxseo_issues', 'quoxseo_changes', 'quoxseo_urls',
    'inbox_accounts', 'inbox_zones', 'inbox_search', 'inbox_report_latest',
  ],

  // Network specialist
  cipher: ['ssh_exec', 'network_check', 'fleet_status', 'system_admin', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // DevOps specialist
  nova: ['box_health', 'ssh_exec', 'docker_status', 'docker_extended', 'system_admin', 'fleet_status', 'execution_intelligence', 'codebase_query', 'create_workflow', 'send_notification', 'list_workflows', 'execute_workflow', 'list_executions', 'activate_workflow', 'deactivate_workflow', 'import_n8n_workflow', 'deploy_template', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // Proxmox specialist
  atlas: [
    'ssh_exec', 'proxmox_vms', 'proxmox_containers', 'proxmox_cluster_status',
    'proxmox_storage', 'proxmox_vm_action', 'proxmox_templates_list',
    'proxmox_vm_snapshot', 'proxmox_vm_clone', 'fleet_status',
    // mikrotik_dhcp_find_free_ip is granted dynamically via mikrotik.json's
    // also_grant (entityToolLoader.js) — HYPERION creates VMs most often and
    // needs to know what's free before assigning a static IP, granted
    // directly rather than via delegate_to_agent (only quox holds that tool;
    // see AGENT-OVERHAUL note #2446) — not hardcoded here so it stays
    // license-gated the same as every other mikrotik tool.
    'create_inbox_item', 'send_notification',
    ...MEMORY_TOOLS,
    ...SKILL_TOOLS,
    ...KNOWLEDGE_TOOLS
  ],

  // Security specialist — browser tools for security verification (W2-6)
  sentinel: ['ssh_exec', 'remote_ssh', 'security_audit', 'ssl_certificates', 'tls_cert_info', 'fleet_status', 'network_check', 'execution_intelligence', 'codebase_query', 'create_inbox_item', 'send_notification', 'browser_navigate', 'browser_screenshot', 'browser_extract', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // Monitoring specialist — browser tools for dashboard scraping (W2-6)
  metrics: ['ssh_exec', 'metrics_query', 'alerts_manage', 'grafana_dashboards', 'fleet_status', 'execution_intelligence', 'create_inbox_item', 'send_notification', 'browser_navigate', 'browser_screenshot', 'browser_extract', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // Uptime/availability — browser tools for health screenshots (W2-6)
  beacon: ['ssh_exec', 'fleet_status', 'network_check', 'execution_intelligence', 'create_inbox_item', 'send_notification', 'browser_navigate', 'browser_screenshot', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // Research (limited tools). perplexity_search/research granted directly —
  // SCHOLAR's own system prompt already names Perplexity for enhanced web
  // search but never had a live search tool to back that claim (overnight
  // tooling-gap pass, 2026-08-08).
  scholar: ['fleet_status', 'network_check', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // CORTEX — the second-brain front door (CortexDock). Still deliberately
  // tiny and hand-picked — no ssh/infra grants, no full SKILL_TOOLS catalog
  // (skills_list/skill_view/skill_manage are Toolsmith/Quartermaster's
  // domain, not Cortex's) — but ONE-BRAIN Phase C (QuoxPlan #493) widens it
  // from a single-tool stub to the actual second-brain surface: `recall`
  // (unified dedup across memory+brain+wisdom, ONE-BRAIN A2) as the default
  // first call, quoxbrain_search/memory_search/session_search for narrower
  // lookups, and memory_save/entity_note/memory_update so Cortex can capture
  // and correct, not just retrieve.
  cortex: [...KNOWLEDGE_TOOLS, 'brain_suggestions', 'brain_brief', ...BRAIN_EXPLORE_TOOLS, ...BRAIN_CAPTURE_TOOLS, 'brain_garden_apply', 'recall', ...MEMORY_TOOLS, 'memory_forget', 'session_search'],

  // GitHub operations (connector tools are resolved via bridge, listed here for documentation)
  // DEVSUITE-CLARIFY Phase 3 dogfood grant: VULCAN is Quox's existing code/
  // scripts/dev specialist (forge.json: "code_analysis", "syntax_checking",
  // "script_execution") and the closest live analog to Bob, DEVSUITE-HUB's
  // not-yet-built dev-suite agent, which the plan names as QLarity's intended
  // consumer. Verifying what a build actually looks like/logs/renders is a
  // natural extension of forge's existing code-review remit, so it gets the
  // qlarity_* tools first rather than a broader grant with no built consumer
  // yet. See lib/qlarityTools.js.
  forge: ['ssh_exec', 'codebase_query', 'create_inbox_item', 'send_notification', 'qlarity_open', 'qlarity_inspect', 'qlarity_eval', 'qlarity_close', 'github_create_pull_request', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // QUOXIFY pass 1 (DEVSUITE phase 14). Two new dev-suite identities. Neither
  // invents a backend: both are a delegation wire onto tools that already
  // exist and are already governed, which is exactly what the quoxification
  // audit said the AGENTIC gap was (note #2842: "the conversational access
  // the owner named is a thin identity+delegation wire away").
  //
  // NUCLEUS: the codebase cartographer. codebase_query is RepoBrain, which
  // has been the cheap way to answer "where is X" for a while but only ever
  // had a CLI and a tool, never someone to ask.
  // BLAST-RADIUS-P2: fulfils the 'blast_radius' capability declared in
  // src/config/agentRegistry.js (nucleus.capabilities) — previously a
  // capability with no backing tool.
  nucleus: ['codebase_query', 'reach_agent', 'create_inbox_item', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // LOOP-Q: the running-loop conductor. Read the witnessed turns, and propose
  // a halt through the approval gate. Deliberately NOT given ssh_exec or any
  // build tool: its whole job is to reason about a loop and escalate, not to
  // reach onto the host itself.
  // LUCID: situational awareness. Two read-only tools; any measure that changes
  // something goes through an approval, never through this agent.
  lucid: ['lucid_situation', 'lucid_item', 'box_health', 'create_inbox_item', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  'loop-q': ['loop_sessions', 'loop_turns', 'loop_halt', 'loop_suggest', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // INBOXQ: the inbox chief of staff (INBOXQ_AGENT_DESIGN.md). Read tools are
  // free. The DIRECT-EXECUTE tools (inbox_move/inbox_rezone/inbox_block/
  // inbox_create_folder) act immediately on the authenticated user's command,
  // through the SAME instant human-authoritative handlers the dashboard buttons
  // use — no proposal, no second approval (owner 2026-10-02,
  // feedback-direct-user-action-is-authorization). The inbox_propose_* tools
  // stay in the surface for a future autonomous/scheduled worker with no human
  // in the loop. No send/reply/delete/read-flag tool exists here by design
  // (control panel, not a mail client).
  inboxq: [
    'inbox_accounts', 'inbox_zones', 'inbox_folders', 'inbox_search', 'inbox_get',
    'inbox_proposals', 'inbox_blocked', 'inbox_report_latest',
    'inbox_move', 'inbox_rezone', 'inbox_block', 'inbox_create_folder',
    'inbox_propose_move', 'inbox_propose_rezone', 'inbox_propose_block', 'inbox_propose_create_folder',
    'contacts_resolve', 'contacts_find', 'contacts_search', 'contacts_best_channel', 'contacts_record_objection',
    'contacts_timeline', 'contacts_log_touchpoint', 'contacts_propose_fact',
    ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS,
  ],

  // NOTESQ: the notes assistant. Every tool calls the ONE shared in-process
  // notesqCall boundary (lib/notesq/call.js), the same function the governed
  // HTTP routes use. Writes execute on the authenticated user's direct command
  // and are revision-backed (notesq_history/notesq_restore undo them).
  notesq: [
    'notesq_search', 'notesq_list', 'notesq_read', 'notesq_related', 'notesq_history', 'notesq_suggest_links', 'notesq_health', 'notesq_research',
    'notesq_create', 'notesq_update', 'notesq_tag', 'notesq_restore', 'notesq_delete',
    ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS,
  ],

  // QUOXON-ADV (2026-10-13): plugin/core agents whose JSON declares tools but had no entry here
  // resolved to the custom-agent floor, so on every provider they answered "no tools are connected".
  // Each list is the agent's own declared tools (calendar-q.json, gitq.json). calendar_* stay gated
  // by TOOL_REQUIRES_PLUGIN 'calendar-q'; gitq stays gated by AGENT_REQUIRES_PLUGIN 'github'.
  'calendar-q': [
    'calendar_agenda', 'calendar_coverage_status', 'calendar_event_get', 'calendar_layers_list', 'calendar_changes',
    'calendar_overlay', 'calendar_clashes', 'calendar_schedules_overview', 'calendar_prep', 'calendar_brief_input',
    'calendar_followup_propose', 'calendar_event_propose', 'calendar_event_create', 'calendar_reconcile',
    ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS,
  ],
  gitq: [
    'vault_types', 'vault_list', 'vault_test', 'vault_connect_guide', 'codebase_query',
    ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS,
  ],
  // SESHA, liaison to live sessions: read-only session views on the chat path (slot_say stays out:
  // speaking into a session is the voice worker's governed path, not a chat side effect).
  sesha: ['slot_list', 'slot_read', 'loop_sessions', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // CONTACTSQ: the contacts assistant. Every contacts_* tool (masked cards
  // only; dial/send are approval-gated at the governed boundary). ContactsQ is
  // FREE in Core with no licence, so NO AGENT/TOOL_REQUIRES_PLUGIN entry (the
  // tools are also held by quox/inboxq/action-q).
  contactsq: [
    'contacts_resolve', 'contacts_find', 'contacts_search', 'contacts_best_channel', 'contacts_timeline', 'contacts_context',
    'contacts_log_touchpoint', 'contacts_record_objection', 'contacts_propose_fact',
    'contacts_brief', 'contacts_handoff', 'contacts_handoffs',
    'contacts_dial', 'contacts_send', 'contacts_dial_batch', 'contacts_send_batch', 'contacts_focus',
    ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS,
  ],

  // Quick-fire GitHub issue filer (chat/Discord/Telegram port of the terminal-only
  // gripe skill). No ssh_exec/codebase_query — by design it doesn't investigate,
  // it just files. GitHub tools themselves are resolved via the connector bridge
  // (see CONNECTOR_FAMILIES below), this is only the native tool grant.
  gripe: ['create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // DEVSUITE-HUB Phase 4 — the Dev Suite's own agent (DevServersHub right
  // sidebar). bob_* tools are native (lib/bobTools.js); github_create_issue
  // is resolved via the connector bridge (see CONNECTOR_FAMILIES below),
  // same as gripe's grant, not listed here. Pull-only: no scheduled trigger
  // anywhere in this tool set.
  // QUOXIFY pass 2: BOB could read everything about a build and do nothing
  // about it. bob_dispatch_build is HITL-gated and can only NAME a target the
  // host already registered; the executor stays deterministic, BOB is its
  // agent layer. slot_* lets it address a working session by name.
  // BLAST-RADIUS-P2: reach_agent added — a deploy-verification agent
  // benefits from checking what an agent it's diagnosing can actually reach.
  bob: ['bob_build_status', 'bob_build_history', 'bob_log_tail', 'bob_preflight', 'bob_verify_deploy', 'bob_detect_repeated_failures', 'bob_mark_build_outcome', 'bob_build_targets', 'bob_dispatch_build', 'reach_agent', 'slot_list', 'slot_say', 'slot_read', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // Analysis
  prism: ['fleet_status', 'system_admin', 'execution_intelligence', 'save_as_workflow', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // Visualization. alerts_manage granted directly — INSIGHT's own system
  // prompt lists "manage alert rules and notification channels" as a core
  // responsibility but never had the tool (overnight tooling-gap pass,
  // 2026-08-08); already proven live via METRICS.
  insight: ['metrics_query', 'grafana_dashboards', 'alerts_manage', 'fleet_status', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // Core introspection — TRUST-GATE 1.18d: execution_intelligence (mirror_index/
  // implant_detail/engine_health/search_wisdom) was missing from COREY's real
  // tool list despite her persona claiming Mirror introspection as her core job.
  corey: ['execution_intelligence', 'fleet_status', 'system_admin', 'codebase_query', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // Spatial observation (HORUS — The All-Seeing Eye)
  horus: ['spatial_search', 'health_scan', 'guided_tour', 'fleet_status', 'create_inbox_item', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // Compliance intelligence specialist (AUDITUS)
  auditus: [
    'compliance_posture', 'compliance_generate_report', 'compliance_get_reports',
    'compliance_schedule_job', 'compliance_list_jobs', 'compliance_cancel_job',
    'volt_list_runs', 'volt_verify_run', 'volt_certify_run', 'volt_create_bundle',
    'ward_verify_chain', 'ward_query_entries', 'ward_source_breakdown',
    'aee_query_envelopes', 'aee_get_stats', 'aocl_get_decisions',
    'governance_list_policies', 'governance_get_templates',
    'create_inbox_item', 'send_notification',
    ...MEMORY_TOOLS,
    ...SKILL_TOOLS,
    ...KNOWLEDGE_TOOLS
  ],

  // QA
  tester: ['ssh_exec', 'fleet_status', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // QuoxFlow workflow engine — has destructive tools gated by approval gates
  quoxflow: [
    'fleet_status', 'docker_status', 'system_admin',
    'proxmox_vms', 'proxmox_cluster_status',
    'proxmox_vm_action', 'ssh_exec', 'docker_extended',
    'create_inbox_item', 'send_notification',
    'memory_search',
    // VAULT-AUDIT P3.D1 — IMAP mailbox read via vault email_account credential
    'email_read',
    // VAULT-AUDIT P3.D3 — SMTP mailbox send via vault email_account credential
    'email_send',
    // VAULT-AUDIT P4.B — TLS certificate metadata via vault tls_cert credential
    'tls_cert_info',
    // VAULT-AUDIT P4.A-collector — SSH exec via vault ssh_key credential
    'remote_ssh',
    // VAULT-AUDIT P4.C — SQL query via vault database credential
    'db_query',
    // quoxflow#6 — read-only PromQL via the collector's PROMETHEUS_URL, so a
    // workflow reads metrics through the governed tool path instead of a raw
    // call node to a LAN address (which the engine's SSRF guard blocks).
    'metrics_query',
    ...SKILL_TOOLS,
    ...KNOWLEDGE_TOOLS
  ],

  // Image generation specialist (ImagesQ, MediaQ family — LLM-backed image tool serving as an agent until MediaQ goes beyond it)
  imagesq: ['gemini_image_generate', 'gemini_image_edit', 'gemini_image_describe', 'gemini_image_models', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // Review & synthesis specialist (Gemini CLI)
  gemini: ['gemini_review', 'gemini_analyze', 'gemini_generate', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // Web research & verification specialist (Perplexity Sonar API)
  perplexity: ['perplexity_search', 'perplexity_research', 'perplexity_verify', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // System continuity specialist
  keeper: [
    'keeper_backup_status', 'keeper_backup_create', 'keeper_backup_list',
    'keeper_backup_verify', 'keeper_restore', 'keeper_schedule_list',
    'keeper_schedule_manage', 'keeper_update_check', 'keeper_update_start',
    'keeper_update_rollback', 'keeper_audit_log',
    'create_inbox_item', 'send_notification',
    ...MEMORY_TOOLS,
    ...SKILL_TOOLS,
    ...KNOWLEDGE_TOOLS
  ],

  // Task management specialist
  'action-q': ['contacts_resolve', 'contacts_find', 'contacts_search', 'contacts_best_channel', 'contacts_record_objection', 'contacts_timeline', 'contacts_log_touchpoint', 'contacts_propose_fact', ...ACTION_TOOLS, ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS, 'execution_intelligence', 'org_directory'],

  // Web automation specialist
  'browser-q': [
    'browser_navigate', 'browser_screenshot', 'browser_extract',
    'browser_extract_table', 'browser_extract_schema', 'browser_extract_template',
    'browser_extract_links', 'browser_extract_metadata',
    'browser_click', 'browser_type', 'browser_wait', 'browser_scroll',
    'browser_fill_form', 'browser_select', 'browser_find_element', 'browser_analyze_forms',
    'browser_pdf', 'browser_download',
    'browser_lighthouse',
    'browser_new_tab', 'browser_switch_tab', 'browser_list_tabs',
    'browser_login', 'browser_save_cookies', 'browser_restore_cookies',
    'browser_record_start', 'browser_record_stop', 'browser_replay',
    'browser_sequence_save', 'browser_sequence_list', 'browser_sequence_load', 'browser_sequence_delete',
    'browser_video_start', 'browser_video_stop', 'browser_video_list', 'browser_video_delete',
    'browser_monitor_create', 'browser_monitor_list', 'browser_monitor_check',
    'browser_objective_create', 'browser_objective_plan', 'browser_objective_execute',
    'browser_objective_run', 'browser_objective_approve_step', 'browser_objective_cancel',
    'browser_objective_list', 'browser_objective_get', 'browser_objective_save_sequence',
    ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS, 'execution_intelligence'
  ],

  // Docker fleet specialist
  dockeragent: [
    'docker_fleet_scan', 'docker_fleet_containers', 'docker_fleet_container_action',
    'docker_fleet_logs', 'docker_fleet_stats', 'docker_fleet_stacks', 'docker_fleet_system_df',
    'docker_status', 'docker_extended', 'ssh_exec', 'fleet_status',
    'create_inbox_item', 'send_notification',
    ...MEMORY_TOOLS,
    ...SKILL_TOOLS,
    ...KNOWLEDGE_TOOLS
  ],

  // Workflow design specialist — canvas-only, no server-side workflow management tools
  weaver: [
    'memory_save', 'memory_search',
    // Knowledge-index — query on demand instead of injecting catalogs
    'wb_list_node_types', 'wb_get_node_schema',
    'wb_list_agents', 'wb_get_agent',
    'wb_search_templates', 'wb_list_plugins',
    // Canvas mutation — structural enforcement replacing markdown-fence parsing
    'wb_emit',
    ...SKILL_TOOLS,
    ...KNOWLEDGE_TOOLS,
  ],

  // MikroTik network specialist (entity tools loaded dynamically)
  netwatch: [
    'ssh_exec', 'remote_ssh', 'network_check', 'fleet_status',
    'create_inbox_item', 'send_notification',
    ...MEMORY_TOOLS,
    ...SKILL_TOOLS,
    ...KNOWLEDGE_TOOLS
  ],

  // Tailscale mesh specialist (entity tools loaded dynamically via connector)
  meshnet: [
    'ssh_exec', 'network_check', 'fleet_status',
    'create_inbox_item', 'send_notification',
    ...MEMORY_TOOLS,
    ...SKILL_TOOLS,
    ...KNOWLEDGE_TOOLS
  ],

  // TOOLSMITH Slice 3a + E — Script-Forge tool author
  toolsmith: [
    'toolsmith.validateDraft',
    'toolsmith.analyseDangerous',
    'toolsmith.generateSchema',
    'toolsmith.generateDocs',
    // AGENT-OVERHAUL phase 7: TOOLSMITH owns the tool lifecycle, including
    // auditing the health of the whole live tool surface.
    'tools_doctor',
    // Slice E: dual-surface sandbox run (chat + HTTP) — gated behind ENABLE_CODE_EXEC_TOOLS
    // because it executes arbitrary Python via scriptExecutor/dockerode.
    ...(process.env.ENABLE_CODE_EXEC_TOOLS === 'true' ? ['toolsmith.runScript'] : []),
    ...MEMORY_TOOLS,
    ...SKILL_TOOLS,
    ...KNOWLEDGE_TOOLS,
  ],

  // QUARTERMASTER — catalog navigator / tool-discovery assistant
  quartermaster: [
    'search_catalog',
    'tool_inspect',       // steward: inspect any tool's contract + who uses it
    'agent_tools',        // steward: an agent's tool scope / roster coverage
    'roster_coverage',    // steward: whole-roster band view (thin/healthy/bloated) + loop-mode candidates
    'memory_save',
    ...KNOWLEDGE_TOOLS
  ],

  // ROADY — Strategic Roadmap Navigator. Was absent from this map, so it connected
  // with ZERO tools in Rooms (the owner watched it fail to help). Roadmap work maps
  // onto the action tracker + memory + knowledge; roadmap-cli itself is a host CLI,
  // not a collector tool, so it is not listed here.
  roady: [
    // AGENT-OVERHAUL-2 — roadmap_list/roadmap_show/roadmap_stats grant
    // removed (archive readers over the retired roadmap-cli, 2026-07-25
    // cutover). quoxplan_* below is the live source of truth.
    // QUOXPLAN-P4 — ROADY's rail lives inside QuoxPlan; give it read tools over
    // the QuoxPlan product roadmaps (separate dummy-data corpus)
    'quoxplan_roadmaps', 'quoxplan_streams', 'quoxplan_stream_brief', 'quoxplan_notes',
    // QUOXPLAN-P7 — governed writes over the same QuoxPlan corpus (notes,
    // status, phase ticks). Refuses quox-strategic (replica) writes and
    // COMPLETE transitions in-tool; see lib/quoxplanTools.js.
    'quoxplan_add_note', 'quoxplan_set_status', 'quoxplan_tick_phase',
    // Overnight tooling-gap pass (2026-08-08) — ROADY's own persona already
    // claims "add new streams and phases"; these close that gap. Same
    // governed-proxy/AEE-witnessed pattern as the writes above.
    'quoxplan_add_phase', 'quoxplan_create_stream',
    // QUOXPLAN-P7 — HITL-gated completion: files an owner approval instead
    // of setting COMPLETE directly; see lib/quoxplanTools.js.
    'quoxplan_request_complete',
    ...ACTION_TOOLS,
    'create_inbox_item', 'send_notification', 'execution_intelligence',
    ...MEMORY_TOOLS,
    ...SKILL_TOOLS,
    ...KNOWLEDGE_TOOLS
  ],

  // SEER — QuoxSEO analyst. Read-only over the witnessed URL warehouse; no
  // site-change tools are granted (that is a later HITL phase).
  seer: [
    'quoxseo_summary', 'quoxseo_urls', 'quoxseo_changes', 'quoxseo_verify', 'quoxseo_opportunities', 'quoxseo_queries', 'quoxseo_issues', 'quoxseo_trends', 'quoxseo_inspection',
    ...MEMORY_TOOLS,
    ...SKILL_TOOLS,
    ...KNOWLEDGE_TOOLS
  ],

  // CORECOMM-UX #190 — the following agents were entirely absent from this map,
  // so they connected to the MCP with ZERO tools in Rooms. Seeded with a
  // domain-appropriate baseline from the shared bundles above; only tool
  // names already defined in TOOL_DEFS are used here (no aspirational tools
  // that only exist in agentRegistry.js/entity JSON without a real executor).

  // ARGUS — Wazuh SIEM specialist. No wazuh_* tools are registered in TOOL_DEFS
  // yet (wazuh.json has no agent_hints.primary_agent, so entity-tool loading
  // does not auto-attach), so she gets the closest real security/fleet tools.
  argus: ['security_audit', 'fleet_status', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // QDIS-CONCIERGE — Discord Pro's own agent. discord_list_bindings and
  // discord_diagnose are read-only; discord_bind_channel/
  // discord_unbind_channel are HITL-gated (see AGENT_GATED_TOOLS['concierge']
  // in approvalGate.js) so they are granted here like any other tool but
  // never execute directly. RBAC allowlist: ONLY concierge holds these four
  // tools (see lib/discordProTools.js).
  concierge: ['discord_list_bindings', 'discord_diagnose', 'discord_bind_channel', 'discord_unbind_channel', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // JANUS — Bastion gateway specialist. Tool list mirrors the V1.5 live-tools
  // block already documented on her persona in agentRegistry.js.
  janus: ['ssh_exec', 'fleet_status', 'system_admin', 'network_check', 'security_audit', 'metrics_query', 'grafana_dashboards', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // ARCHIVIST — file operations & document intelligence. AGENT-OVERHAUL:
  // list_files/read_file/search_files are now real, org-scoped, server-backed
  // tools (services/auth/routes/file-objects.js / file_objects table) — see
  // the ARCHIVIST TOOL_DEFS block above. Write/upload is still out of scope.
  archivist: ['list_files', 'read_file', 'search_files', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // ARCHITECT — meta-agent that builds other agents/tools/teams through
  // conversation. No infra or destructive tools.
  // SDK-TEAM W1 (thin attended ARCHITECT): plans plugins/capabilities against
  // the REAL build path, so it gets (a) codebase_query for sibling checks,
  // (b) QuoxPlan read plus ONLY note/phase writes (new streams, status
  // changes, ticks and completion stay owner decisions: ARCHITECT proposes
  // them via create_inbox_item), and (c) QUARTERMASTER's inventory reads
  // (search_catalog, tool_inspect, agent_tools, roster_coverage) so it checks
  // what already exists before proposing anything new.
  architect: [
    'codebase_query',
    'quoxplan_roadmaps', 'quoxplan_streams', 'quoxplan_stream_brief', 'quoxplan_notes',
    'quoxplan_add_note', 'quoxplan_add_phase',
    'search_catalog', 'tool_inspect', 'agent_tools', 'roster_coverage',
    'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS,
  ],

  // REGULA — settings & configuration warden. AGENT-OVERHAUL wave 1 + wave 2:
  // 10 real tools (settings_get/explain/search/list, settings_set, vault_list,
  // vault_test, backup_status, backup_run, license_status) + 11 honest 501
  // stubs for the write/manage surface agentRegistry.js still declares. See
  // the REGULA TOOL_DEFS block above for the implementations.
  regula: [
    'settings_get', 'settings_explain', 'settings_search', 'settings_list',
    'settings_set', 'settings_recommend', 'settings_export', 'settings_import',
    'plugin_list', 'plugin_enable', 'plugin_disable',
    'vault_list', 'vault_test', 'vault_types', 'vault_connect_guide',
    'backup_status', 'backup_run',
    'license_status',
    'appearance_get', 'appearance_set',
    'service_check',
    'notification_subscribe', 'notification_unsubscribe',
    'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS
  ],

  // LINKEDIN — social publishing specialist. Connector tools (linkedin_*)
  // are resolved dynamically via the connector bridge at chat time, not
  // through TOOL_DEFS, so no connector tool names are hardcoded here.
  linkedin: ['create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // YOUTUBE — channel management specialist. Same connector-bridge note as
  // LINKEDIN above applies to youtube_* tools.
  youtube: ['create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // INSTAGRAM — social publishing specialist. Same connector-bridge note as
  // LINKEDIN/YOUTUBE above applies to instagram_* tools.
  instagram: ['create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // TIKTOK — social publishing specialist. Same connector-bridge note as
  // LINKEDIN/YOUTUBE/INSTAGRAM above applies to tiktok_* tools.
  tiktok: ['create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // FACEBOOK — social publishing specialist. Same connector-bridge note as
  // LINKEDIN/YOUTUBE/INSTAGRAM/TIKTOK above applies to facebook_pages tools.
  // (Base grant restored 2026-09-19: facebook was previously only in
  // CONNECTOR_FAMILIES, so it lacked the inbox/notification/memory/skill/
  // knowledge tools every sibling social agent has — a real asymmetry.)
  facebook: ['create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // XTWITTER — X (Twitter) publishing specialist. twitter_* reads come via
  // the connector bridge (CONNECTOR_FAMILIES); the x_* writes are NATIVE
  // tools that only file HITL approval cards (lib/xTools.js), so granting
  // them here never publishes anything directly.
  xtwitter: ['x_post', 'x_thread', 'x_delete', 'x_like', 'x_repost', 'x_budget_status', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // QUOXCODE — terminal AI assistant (QuoxTerminal). Shell/fleet visibility
  // plus codebase_query for code-fluent answers.
  quoxcode: ['ssh_exec', 'fleet_status', 'codebase_query', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // TRIAGE-Q — inbox triage / HITL specialist. Task tracker tools plus
  // execution_intelligence for surfacing context on approvals. approve_request
  // and deny_request are HITL-GATED for this agent (owner decision 2026-08-04,
  // QuoxPlan notes #2202/#2203): TRIAGE-Q's calls to them file a proposal via
  // withApprovalGate/AGENT_GATED_TOOLS instead of resolving directly; a human
  // must confirm from the inbox before the underlying resolution executes.
  'triage-q': [...ACTION_TOOLS, 'inbox_pending', 'list_approvals', 'create_inbox_item', 'send_notification', 'execution_intelligence', 'approve_request', 'deny_request', 'org_directory', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // QUOXPERTICUS: resident governed agent, shipped with the server core
  // (QUOXPERTICUS P2). Read/observe surface only: fleet_status, memory,
  // knowledge search, skills discovery, plus the inbox/notification path it
  // uses to file findings. approve_request/deny_request/list_approvals are
  // PROPOSE-ONLY for this agent: the platform's approval gates
  // (withApprovalGate/AGENT_GATED_TOOLS) turn its approve/deny calls into
  // proposals outside a leased disposable-test sandbox, and inside such a
  // sandbox the collector performs test approvals as a synthetic principal,
  // never under this agent's identity. Skills are list/view only, NOT the full
  // SKILL_TOOLS spread: skill_manage writes, and this agent files findings
  // rather than editing the platform. Nothing destructive is granted: no
  // ssh_exec, no proxmox tools, no github write tools.
  quoxperticus: ['fleet_status', 'create_inbox_item', 'send_notification', 'list_approvals', 'approve_request', 'deny_request', 'skills_list', 'skill_view', 'continuity', ...MEMORY_TOOLS, ...KNOWLEDGE_TOOLS],

  // ===== QUOX-SECURITY Phase 1: engagement/scope tools only, no scanning
  // capability has shipped yet (see lib/securityEngagementTools.js). No
  // delegate_to_agent for security_lead: Quox's flat hierarchy routes all
  // agent-to-agent delegation through quox, not through peer managers
  // (see src/test/agentRegistry.test.js "Delegation Flow (All Through
  // Quox)"), unlike the CHIEF_TOOLS_* agentic-team packs below which are a
  // separate subsystem exempt from that invariant. =====

  // Security Engagement Lead. Owns engagement/scope, endorses specialist
  // work once a target is verified and in scope.
  security_lead: ['security_create_engagement', 'security_get_engagement', 'security_list_engagements', 'security_add_target', 'security_verify_target', 'security_check_policy', 'security_list_findings', 'create_inbox_item', 'send_notification', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // Reconnaissance specialist. Scope/verification read tools only, no
  // discovery capability provider exists yet.
  recon_specialist: ['security_get_engagement', 'security_check_policy', 'sectest_discover_hosts', 'sectest_probe_http', 'sectest_discover_app_ports', 'sectest_resolve_dns', 'security_report_finding', 'security_list_findings', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // Web application testing specialist. Scope/verification read tools
  // only, no web-testing capability provider exists yet.
  web_specialist: ['security_get_engagement', 'security_check_policy', 'sectest_probe_http', 'sectest_discover_app_ports', 'sectest_vuln_scan', 'sectest_inspect_tls', 'security_report_finding', 'security_list_findings', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // Findings verifier. Scope/verification read tools only, no findings
  // storage pipeline exists yet.
  findings_verifier: ['security_get_engagement', 'security_check_policy', 'security_list_findings', 'security_verify_finding', ...MEMORY_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS],

  // DEVSUITE-DEVMODE / QLoop self-extension: the identity a running dev loop
  // acts under when it reaches back into the collector to read and write
  // skills. Deliberately minimal and NOT a spread of SKILL_TOOLS: a loop needs
  // to discover a skill, read it and write one back, and nothing else. It gets
  // no memory, knowledge or session_search tools, so a loop cannot mine other
  // sessions' history. Widening this slice is a governance decision, not a
  // convenience one.
  qloop: ['skills_list', 'skill_view', 'skill_manage']
};

// ============================================================================
// AGENT-OVERHAUL-2 FIX 1 — connector-family scoping for connector-prefixed
// tools (github_*, linkedin_*, youtube_*, tailscale_*, etc.). Before this,
// getToolsWithConnectors() merged EVERY org-configured connector tool onto
// EVERY agent's toolset, and executeTool() routed connector-prefixed tools
// to the bridge before the per-agent RBAC check ran — so any agent that
// merely knew a connector tool's name could invoke it.
//
// Maps agent key -> array of connector family ids (see connectors/registry.js
// CONNECTOR_REGISTRY for the id set) that agent may see/execute. Agents not
// listed here get no connector tools at all. 'quox' is special-cased in
// getConnectorFamiliesForAgent() to receive every registered family
// (orchestrator privilege).
// ============================================================================
const CONNECTOR_FAMILIES = {
  forge: ['github'],
  gitq: ['github'], // QUOXON-ADV: github_list_repos et al are connector tools, resolved per family
  gripe: ['github'],
  // DEVSUITE-HUB Phase 4 — BOB files gripes about the dev suite the same
  // way GRIPE does: same connector family, same github_create_issue tool,
  // same confirm-before-file discipline (see bob.json). No second path.
  bob: ['github'],
  linkedin: ['linkedin'],
  xtwitter: ['twitter'],
  youtube: ['youtube'],
  meshnet: ['tailscale'],
  // FB-3: the dedicated facebook agent (organic Pages only) owns the
  // facebook_pages connector family. Connector id is 'facebook_pages', not
  // 'facebook' (see registry.js FB-1 comment: avoids a prefix collision
  // with the pre-existing 'facebook_ads' declarative spec); the agent id
  // is 'facebook'.
  facebook: ['facebook_pages'],
  // IG-1: dedicated instagram agent owns the instagram connector family.
  // Connector id and agent id are both plain 'instagram' (no prefix
  // collision to dodge, unlike facebook_pages/facebook above).
  instagram: ['instagram'],
  // TT-2: dedicated tiktok agent owns the tiktok connector family. Connector
  // id and agent id are both plain 'tiktok' (no prefix collision to dodge).
  tiktok: ['tiktok'],
};

/**
 * Resolve which connector families an agent may see/execute tools from.
 * quox (orchestrator) gets every registered connector family. Any agent
 * not present in CONNECTOR_FAMILIES gets none — same "unauthorized" shape
 * as the native RBAC path, not a silent allow.
 *
 * @param {string} agentId
 * @returns {string[]} connector ids the agent may use
 */
function getConnectorFamiliesForAgent(agentId) {
  const agentKey = (agentId || '').toLowerCase();
  if (agentKey === 'quox') {
    return listConnectors().map(c => c.id);
  }
  return CONNECTOR_FAMILIES[agentKey] || [];
}

// SEC-AUDIT (2026-08-11) S2 — CONNECTOR_FAMILIES grants a whole connector
// (every tool that family's module exposes). bob and gripe were both scoped
// to the full 'github' family for github_create_issue alone, but that family
// also carries github_update_issue, github_rerun_workflow, github_create_release
// (lib/connectors/types/github.js) — none HITL-gated, none mentioned in
// either agent's own prompt, and github_rerun_workflow directly contradicts
// bob's advertised pull-only posture. build_receipts.message is unsanitised/
// uncapped (buildReceiptsStore.js) and flows into bob's context via
// bob_log_tail/bob_build_status, so anyone who can POST a receipt can plant
// instructions in front of an agent holding full GitHub write access.
//
// This map OPTIONALLY narrows an agent already granted a family down to a
// specific tool subset within it. An agent key with NO entry here keeps
// today's full-family behavior unchanged (additive, not a behavior change
// for forge/linkedin/youtube/meshnet or any future connector-scoped agent).
const CONNECTOR_TOOL_ALLOWLIST = {
  bob: ['github_create_issue'],
  gripe: ['github_create_issue'],
};

/**
 * Resolve the tool-name allowlist (if any) narrowing an agent within its
 * already-granted connector family/families. Returns null when the agent
 * has no entry — callers must treat null as "no narrowing, full family".
 *
 * @param {string} agentId
 * @returns {string[]|null}
 */
function getConnectorToolAllowlistForAgent(agentId) {
  const agentKey = (agentId || '').toLowerCase();
  return CONNECTOR_TOOL_ALLOWLIST[agentKey] || null;
}

// ============================================================================
// Chief Agent RBAC — Agentic Team Packs (Small/Medium/Enterprise)
// ============================================================================
// Chiefs are C-suite executive personas used in agentic teams.
// They need strategic visibility but role-appropriate infrastructure access.
// Grouped by functional domain, then all regional/specialty variants inherit.

const CHIEF_TOOLS_EXECUTIVE = [
  // Strategic oversight — read-heavy, can delegate and communicate
  'fleet_status', 'metrics_query', 'system_admin', 'network_check',
  'security_audit', 'ssl_certificates', 'alerts_manage',
  'delegate_to_agent', 'create_inbox_item', 'send_notification',
  ...MEMORY_TOOLS,
  ...SKILL_TOOLS,
  ...KNOWLEDGE_TOOLS
];

const CHIEF_TOOLS_TECH = [
  // Technology leadership — full tech stack access
  'ssh_exec', 'docker_status', 'docker_extended', 'system_admin',
  'proxmox_vms', 'proxmox_cluster_status', 'network_check',
  'metrics_query', 'fleet_status', 'security_audit', 'ssl_certificates',
  'delegate_to_agent', 'create_inbox_item', 'send_notification',
  ...MEMORY_TOOLS,
  ...SKILL_TOOLS,
  ...KNOWLEDGE_TOOLS
];

const CHIEF_TOOLS_SECURITY = [
  // Security & compliance — security-focused + network visibility
  'ssh_exec', 'security_audit', 'ssl_certificates', 'network_check',
  'fleet_status', 'system_admin', 'alerts_manage',
  'delegate_to_agent', 'create_inbox_item', 'send_notification',
  ...MEMORY_TOOLS,
  ...SKILL_TOOLS,
  ...KNOWLEDGE_TOOLS
];

const CHIEF_TOOLS_BUSINESS = [
  // Business functions (CFO, CMO, CLO, etc.) — read-only data + comms
  'fleet_status', 'metrics_query', 'system_admin',
  'delegate_to_agent', 'create_inbox_item', 'send_notification',
  ...MEMORY_TOOLS,
  ...SKILL_TOOLS,
  ...KNOWLEDGE_TOOLS
];

const CHIEF_TOOLS_OPERATIONS = [
  // Operations leadership — monitoring + limited infra access
  'ssh_exec', 'system_admin', 'docker_status', 'fleet_status',
  'metrics_query', 'network_check', 'alerts_manage',
  'delegate_to_agent', 'create_inbox_item', 'send_notification',
  ...MEMORY_TOOLS,
  ...SKILL_TOOLS,
  ...KNOWLEDGE_TOOLS
];

// Map every chief agentId to the appropriate tool set
const CHIEF_AGENT_TOOLS = {
  // Executive / CEO tier
  ceo: CHIEF_TOOLS_EXECUTIVE,
  'ceo-americas': CHIEF_TOOLS_EXECUTIVE,
  'ceo-apac': CHIEF_TOOLS_EXECUTIVE,
  'ceo-emea': CHIEF_TOOLS_EXECUTIVE,
  cxo: CHIEF_TOOLS_EXECUTIVE,

  // Technology
  cto: CHIEF_TOOLS_TECH,
  'cto-ai': CHIEF_TOOLS_TECH,
  'cto-infra': CHIEF_TOOLS_TECH,
  'cto-platform': CHIEF_TOOLS_TECH,
  cio: CHIEF_TOOLS_TECH,
  cdo: CHIEF_TOOLS_TECH,
  'cdo-data': CHIEF_TOOLS_TECH,
  'cdo-digital': CHIEF_TOOLS_TECH,
  'vp-engineering': CHIEF_TOOLS_TECH,

  // Security & Compliance
  ciso: CHIEF_TOOLS_SECURITY,
  'ciso-americas': CHIEF_TOOLS_SECURITY,
  'ciso-apac': CHIEF_TOOLS_SECURITY,
  'ciso-emea': CHIEF_TOOLS_SECURITY,
  cso: CHIEF_TOOLS_SECURITY,

  // Operations
  coo: CHIEF_TOOLS_OPERATIONS,
  'coo-americas': CHIEF_TOOLS_OPERATIONS,
  'coo-apac': CHIEF_TOOLS_OPERATIONS,
  'coo-emea': CHIEF_TOOLS_OPERATIONS,
  cao: CHIEF_TOOLS_OPERATIONS,
  'vp-operations': CHIEF_TOOLS_OPERATIONS,

  // Finance
  cfo: CHIEF_TOOLS_BUSINESS,
  'cfo-americas': CHIEF_TOOLS_BUSINESS,
  'cfo-apac': CHIEF_TOOLS_BUSINESS,
  'cfo-emea': CHIEF_TOOLS_BUSINESS,
  'vp-finance': CHIEF_TOOLS_BUSINESS,

  // Marketing & Communications
  cmo: CHIEF_TOOLS_BUSINESS,
  'cmo-americas': CHIEF_TOOLS_BUSINESS,
  'cmo-apac': CHIEF_TOOLS_BUSINESS,
  'cmo-emea': CHIEF_TOOLS_BUSINESS,
  'cco-comms': CHIEF_TOOLS_BUSINESS,
  'cco-customer': CHIEF_TOOLS_BUSINESS,
  'vp-marketing': CHIEF_TOOLS_BUSINESS,
  'vp-sales': CHIEF_TOOLS_BUSINESS,

  // Legal & Compliance
  clo: CHIEF_TOOLS_BUSINESS,
  'clo-compliance': CHIEF_TOOLS_BUSINESS,
  'clo-corporate': CHIEF_TOOLS_BUSINESS,
  'clo-ip': CHIEF_TOOLS_BUSINESS,
  'cco-compliance': CHIEF_TOOLS_SECURITY,

  // Product & People
  'cpo-product': CHIEF_TOOLS_BUSINESS,
  'cpo-people': CHIEF_TOOLS_BUSINESS,
  'cpo-procurement': CHIEF_TOOLS_BUSINESS,
  'vp-product': CHIEF_TOOLS_BUSINESS,

  // Revenue & Growth
  'cro-revenue': CHIEF_TOOLS_BUSINESS,
  'cro-risk': CHIEF_TOOLS_SECURITY,
  cgo: CHIEF_TOOLS_BUSINESS,

  // Knowledge & HR
  chro: CHIEF_TOOLS_BUSINESS,
  cko: CHIEF_TOOLS_BUSINESS,
};

// Merge chiefs into AGENT_TOOLS
Object.assign(AGENT_TOOLS, CHIEF_AGENT_TOOLS);

// ============================================================================
// STUDY-REV K1/R1: DB-resolved tool descriptor
// ============================================================================

const toolStore = require('./toolDefinitionsStore');

// Process-lifetime cache for synthetic toolsmith executor closures.
// Keyed by "<orgId>::<toolName>" so org-scoped tools stay isolated.
// The cache is intentionally not TTL-ed: installedAt is immutable per row.
// invalidateAgentToolCache('toolsmith') clears the descriptor-list cache (60s)
// but NOT this closure cache. The closure only needs re-building if a tool
// is re-installed (registerToolDef INSERT OR REPLACE) which is idempotent.
const _toolsmithClosureCache = new Map();

/**
 * Build a synthetic execute closure for a toolsmith-installed tool.
 * Called once per unique (toolName, orgId) pair; result is cached.
 *
 * @param {string} toolName
 * @param {object} meta - Row from toolDefinitionsStore
 * @returns {Function} async (input, ctx) => runResult
 */
function _buildToolsmithExecute(toolName, meta) {
  const cacheKey = `${meta.org_id || '__global__'}::${toolName}`;
  if (_toolsmithClosureCache.has(cacheKey)) {
    return _toolsmithClosureCache.get(cacheKey);
  }

  let executorConfig = {};
  try {
    executorConfig = meta.executor_config ? JSON.parse(meta.executor_config) : {};
  } catch (_) { /* malformed config — use empty defaults */ }

  const scriptContent = (executorConfig.files && executorConfig.files['script.py']) || '';
  const permissions = executorConfig.permissions || {
    network: false, filesystem: false, secrets: [], subprocess: false, approval_required: false,
  };

  const runScriptTool = async (input, ctx) => {
    // TOOLSMITH-FIX-4: reject cross-org invocations (caller org != install org)
    const installOrgId = meta.org_id || null;
    const callerOrgId = (ctx && ctx.orgId) || null;
    if (installOrgId && callerOrgId && installOrgId !== callerOrgId) {
      console.warn(
        `[toolsmith/_buildToolsmithExecute] cross-org invocation rejected: ` +
        `install_org=${installOrgId} caller_org=${callerOrgId} tool=${toolName}`
      );
      return { error: 'cross-org toolsmith invocation rejected' };
    }

    // Allow test injection via ctx._scriptExecutor to avoid Docker in unit tests
    const executor = (ctx && ctx._scriptExecutor) || require('./scriptExecutor.js');
    const crypto = require('crypto');
    const scriptHash = crypto.createHash('sha256').update(scriptContent).digest('hex');
    const inputsJson = input && typeof input === 'object' ? input : {};

    // Prefer install-time org_id for attribution; fall back to runtime ctx org
    const runOrgId = installOrgId || callerOrgId || null;

    try {
      const runResult = await executor.runScript({
        scriptHash,
        scriptContent,
        inputsJson,
        permissions,
        profile: 'restricted',
        voltSessionId: ctx && ctx.corr ? `voltSession_${ctx.corr}` : null,
        walltimeMs: 30000,
        voltEmitter: ctx && ctx.voltEmitter ? ctx.voltEmitter : null,
        orgId: runOrgId,  // TOOLSMITH-FIX-4: org attribution
      });

      // AOCL envelope emission on the chat side
      if (ctx && ctx.emitEnvelope && runResult.aoclEnvelopes) {
        for (const env of runResult.aoclEnvelopes) {
          try { await ctx.emitEnvelope({ intent: env.intent, payload: env.payload }); } catch (_) {}
        }
      }

      return runResult;
    } catch (err) {
      return { error: `Toolsmith sandbox run failed: ${err.message}` };
    }
  };

  // F11 (TRUST-PROOF plugin-frame-c1): a script tool that declares
  // permissions.approval_required must not run ungated when an AGENT calls it.
  // Reuses the entity-metadata gate (ctx._entityRequiresApproval, set here
  // server-side, never from caller input) so the approval is minted via
  // withApprovalGate and bound to the input fingerprint + tool + org on resume.
  // A direct call with no agent identity is an authenticated human acting
  // directly and stays ungated (house rule).
  const execute = async (input, ctx) => {
    const safeInput = input && typeof input === 'object' ? input : {};
    if (permissions.approval_required === true && ctx && ctx.agentId) {
      return withApprovalGate(
        toolName,
        safeInput,
        () => {
          const stripped = { ...safeInput };
          delete stripped._approvalId;
          delete stripped._resumeToken;
          return runScriptTool(stripped, ctx);
        },
        { ...ctx, _entityRequiresApproval: true, _entityDefconLevel: null }
      );
    }
    const stripped = { ...safeInput };
    delete stripped._approvalId;
    delete stripped._resumeToken;
    return runScriptTool(stripped, ctx);
  };

  _toolsmithClosureCache.set(cacheKey, execute);
  return execute;
}

const _mcpEndpointClosureCache = new Map();
const _mcpHostedClosureCache = new Map();
// LIFECYCLE-P1-D2: Track which (orgId::toolDefId) pairs have had a first-probe
// fired this process lifetime. Prevents concurrent first-probe storms.
const _firstProbeFired = new Set();

const MCP_WRAPPER_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    tool_name: { type: 'string', description: "Name of the MCP tool to invoke (must be one of the server's available tools)" },
    arguments: { type: 'object', description: 'Arguments to pass to the MCP tool', additionalProperties: true },
  },
  required: ['tool_name', 'arguments'],
};

/**
 * Build a synthetic execute closure for an mcp_hosted-installed tool.
 * Delegates to powers-host via mcpHostedClient for container-managed invocations.
 * Called once per unique (toolName, orgId) pair; result is cached.
 *
 * INTROSPECT-P2: If executorConfig._inner_name is set, this is an UNFOLDED alias
 * for a specific inner MCP tool. The inner_name is used directly — no wrapper
 * input.tool_name unwrap needed. Args come straight from the LLM.
 *
 * If executorConfig._inner_name is absent, this is a LEGACY wrapper tool.
 * Input must have { tool_name, arguments } — LLM guesses the inner tool name.
 *
 * @param {string} toolName
 * @param {object} meta - Row from toolDefinitionsStore
 * @returns {Function} async (input, ctx) => runResult
 */
function _buildMcpHostedExecute(toolName, meta) {
  const cacheKey = `${meta.org_id || '__global__'}::${toolName}`;
  if (_mcpHostedClosureCache.has(cacheKey)) {
    return _mcpHostedClosureCache.get(cacheKey);
  }

  let executorConfig = {};
  try {
    executorConfig = meta.executor_config ? JSON.parse(meta.executor_config) : {};
  } catch (_) {}

  // INTROSPECT-P3-fix: auth always ships tool_def_id (= tool_definitions.id = powers_hosted.tool_id).
  // Original code only destructured tool_id, so resolvedToolId was always undefined for real deploys.
  const { tool_id, tool_def_id, available_tools, _inner_name: fixedInnerName } = executorConfig;
  const availableNames = Array.isArray(available_tools) ? available_tools.map(t => t.name) : [];
  const isUnfolded = typeof fixedInnerName === 'string' && fixedInnerName !== '';

  const execute = async (input, ctx) => {
    const installOrgId = meta.org_id || null;
    const callerOrgId = (ctx && ctx.orgId) || null;
    // H1: fail-closed — reject when EITHER org is unknown to prevent null/null bypass
    if (!installOrgId || !callerOrgId || installOrgId !== callerOrgId) {
      console.warn(
        '[mcp/_buildMcpHostedExecute] org guard rejected: install_org=%s caller_org=%s tool=%s',
        installOrgId, callerOrgId, toolName
      );
      return { error: 'cross-org mcp invocation rejected' };
    }

    let requestedTool;
    let callArgs;

    if (isUnfolded) {
      // INTROSPECT-P2: UNFOLDED PATH — inner tool name is fixed at install time.
      // The LLM sends args directly (no tool_name wrapper needed).
      if (fixedInnerName === '__list_more_tools__') {
        // Synthetic tool invoked — log warning, return a helpful message
        console.warn(
          '[INTROSPECT-P2] synthetic list_more_tools invoked tool=%s — returning stub response',
          toolName
        );
        return {
          content: [{
            type: 'text',
            text: `This MCP server exposes more than ${require('./mcpToolNaming.js').MAX_INNER_TOOLS} tools. ` +
                  'Only the first tools are available in this session. ' +
                  'Consult the MCP server documentation for the full tool list.',
          }],
        };
      }
      requestedTool = fixedInnerName;
      callArgs = input || {};
    } else {
      // LEGACY WRAPPER PATH — LLM must pass { tool_name, arguments }
      requestedTool = input && input.tool_name;
      if (!requestedTool || (availableNames.length > 0 && !availableNames.includes(requestedTool))) {
        return { error: `mcp_tool_not_available: ${requestedTool} (available: ${availableNames.join(', ')})` };
      }
      callArgs = input && input.arguments || {};
    }

    // INTROSPECT-P3-fix: tool_def_id = tool_definitions.id = powers_hosted.tool_id (the URL slug).
    // Auth ships tool_def_id; tool_id is a legacy field kept for backward compat.
    const resolvedToolId = tool_id || tool_def_id || meta.tool_id;
    if (!resolvedToolId) {
      return { error: 'mcp_hosted_no_tool_id: executor_config missing tool_id' };
    }

    // LIFECYCLE-P3-D2: VOLT power.invoke.dispatched (fire-and-forget)
    // Use a per-invocation run keyed by a unique dispatch ID so invoke events
    // don't collide with the deploy run. voltEmitter.startRun returns null if VOLT unavailable.
    const invokeCorr = `INVOKE_${resolvedToolId}_${Date.now()}`;
    const invokeRunId = _powersVoltEmitter && _powersVoltEmitter.isAvailable()
      ? _powersVoltEmitter.startRun(invokeCorr, { org_id: callerOrgId })
      : null;
    _emitPowersInvokeVolt(invokeRunId, 'power.invoke.dispatched', resolvedToolId, callerOrgId,
      { tool_name: toolName, inner_tool: requestedTool, executor_type: 'mcp_hosted' });

    const mcpHostedClient = require('./mcpHostedClient.js');
    const result = await mcpHostedClient.invokeMcpHostedTool(
      resolvedToolId,
      requestedTool,
      callArgs,
    );

    if (result.ok === true) {
      // LIFECYCLE-P3-D2: VOLT power.invoke.completed (fire-and-forget)
      _emitPowersInvokeVolt(invokeRunId, 'power.invoke.completed', resolvedToolId, callerOrgId,
        { tool_name: toolName, inner_tool: requestedTool, executor_type: 'mcp_hosted' });
      if (invokeRunId) _powersVoltEmitter.completeRun(invokeRunId);

      // LIFECYCLE-P1-D2: First-invocation probe hook.
      // If this tool has never been probed (available_tools was empty at install/reseed time),
      // fire a one-shot probe to populate available_tools in auth's DB.
      //
      // Idempotency: skip if available_tools was already populated when the closure was built
      // (indicates a prior probe ran — either finalize-time or a previous invocation).
      // We also use a process-lifetime Set keyed by (orgId::toolDefId) to avoid
      // concurrent first-probe storms across parallel invocations of the same tool.
      const shouldFirstProbe = availableNames.length === 0 && resolvedToolId;
      if (shouldFirstProbe && !_firstProbeFired.has(cacheKey)) {
        _firstProbeFired.add(cacheKey);
        console.log('[LIFECYCLE-P1-D2] first-invocation probe tool=%s', resolvedToolId);
        _runFirstInvocationProbe(resolvedToolId, cacheKey).catch(err => {
          // Remove from Set on failure so next invocation can retry
          _firstProbeFired.delete(cacheKey);
          console.warn('[LIFECYCLE-P1-D2] first-probe unhandled rejection tool=%s: %s', resolvedToolId, err.message);
        });
      }

      return { content: result.result?.content || [], _mcp_raw: result.result };
    }

    // INTROSPECT-P1: refresh trigger — if MCP returned -32601 (method not found),
    // the tool list may have drifted. Re-probe + update available_tools (fire-and-forget).
    if (result.error && result.error.includes('-32601')) {
      console.warn(
        '[INTROSPECT-P1] mcp_hosted -32601 method_not_found tool=%s inner=%s — scheduling re-probe',
        toolName, requestedTool
      );
      _scheduleHostedToolsReprobe(resolvedToolId, cacheKey).catch(err => {
        console.warn('[INTROSPECT-P1] re-probe unhandled rejection tool=%s: %s', resolvedToolId, err.message);
      });
    }

    // LIFECYCLE-P3-D2: VOLT power.invoke.failed (fire-and-forget)
    _emitPowersInvokeVolt(invokeRunId, 'power.invoke.failed', resolvedToolId, callerOrgId,
      { tool_name: toolName, inner_tool: requestedTool, executor_type: 'mcp_hosted', error: result.error });
    if (invokeRunId) _powersVoltEmitter.failRun(invokeRunId, new Error(result.error || 'mcp_hosted_error'));

    return { error: result.error };
  };

  _mcpHostedClosureCache.set(cacheKey, execute);
  return execute;
}

/**
 * INTROSPECT-P1: Re-probe a mcp_hosted tool's tools/list when a -32601 error
 * is returned (tool list drift). Updates available_tools in store + clears
 * the closure cache so the next invoke picks up the fresh list.
 *
 * Fire-and-forget: caller should .catch() the returned promise.
 *
 * @param {string} resolvedToolId - The tool_id used in powers-host
 * @param {string} closureCacheKey - Key to evict from _mcpHostedClosureCache
 */
async function _scheduleHostedToolsReprobe(resolvedToolId, closureCacheKey) {
  const powersHostUrl = process.env.POWERS_HOST_URL || 'http://powers-host:9849';
  const url = `${powersHostUrl}/internal/mcp-hosted/${encodeURIComponent(resolvedToolId)}/tools`;

  console.log('[INTROSPECT-P1] re-probe GET %s', url);

  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    console.warn('[INTROSPECT-P1] re-probe fetch error tool=%s: %s', resolvedToolId, err.message);
    return;
  }

  if (!resp.ok) {
    let bodyExcerpt = '';
    try { bodyExcerpt = (await resp.text()).slice(0, 200); } catch (_) {}
    console.warn('[INTROSPECT-P1] re-probe non-2xx tool=%s status=%d: %s', resolvedToolId, resp.status, bodyExcerpt);
    return;
  }

  let data;
  try { data = await resp.json(); } catch (err) {
    console.warn('[INTROSPECT-P1] re-probe invalid JSON tool=%s: %s', resolvedToolId, err.message);
    return;
  }

  const tools = data?.tools;
  if (!Array.isArray(tools)) {
    console.warn('[INTROSPECT-P1] re-probe unexpected shape tool=%s', resolvedToolId);
    return;
  }

  // Evict stale closure so next invoke rebuilds with fresh tool list
  _mcpHostedClosureCache.delete(closureCacheKey);
  console.log(
    '[INTROSPECT-P1] re-probe OK tool=%s count=%d — closure cache evicted',
    resolvedToolId, tools.length
  );

  // LIFECYCLE-P1-D1: POST fresh tool list to auth drift-recovery endpoint.
  // Fire-and-forget with 5s timeout. Do NOT block invocation.
  _postAvailableToolsDriftToAuth(resolvedToolId, tools).catch(err => {
    console.warn('[LIFECYCLE-P1-D1] drift callback unhandled rejection tool=%s: %s', resolvedToolId, err.message);
  });
}

/**
 * LIFECYCLE-P1-D1: POST fresh tools list to auth's drift-recovery endpoint.
 *
 * Called after every successful re-probe (from _scheduleHostedToolsReprobe) and
 * after every first-invocation probe (from _buildMcpHostedExecute first-probe hook).
 *
 * Fire-and-forget: callers must .catch() the returned promise.
 *
 * Cross-service discipline (feedback_silent_success_cross_service.md):
 *  - Pre-fetch log with target + payload key fields
 *  - Try/catch around network errors
 *  - Explicit response.ok check with body excerpt on failure
 *  - Success log
 *
 * @param {string} toolDefId - tool_definitions.id (ULID), = powers_hosted.tool_id
 * @param {Array<{name, description, inputSchema}>} tools
 */
async function _postAvailableToolsDriftToAuth(toolDefId, tools) {
  const authBase = process.env.AUTH_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
  const url = `${authBase}/api/internal/powers/available-tools/${encodeURIComponent(toolDefId)}`;

  console.log(
    '[LIFECYCLE-P1-D1] Collector→Auth drift POST %s tools_count=%d',
    url, tools.length
  );

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': serviceKey,
      },
      body: JSON.stringify({ tools }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn('[LIFECYCLE-P1-D1] drift POST fetch error tool=%s: %s', toolDefId, err.message);
    return;
  }

  if (!resp.ok) {
    let bodyExcerpt = '';
    try { bodyExcerpt = (await resp.text()).slice(0, 300); } catch (_) {}
    console.warn(
      '[LIFECYCLE-P1-D1] drift POST non-2xx tool=%s status=%d body=%s',
      toolDefId, resp.status, bodyExcerpt
    );
    return;
  }

  let result;
  try { result = await resp.json(); } catch (_) { result = {}; }
  if (result.no_change) {
    console.log('[LIFECYCLE-P1-D1] drift POST no_change (sha256 dedup) tool=%s', toolDefId);
  } else {
    console.log(
      '[LIFECYCLE-P1-D1] drift POST OK tool=%s added=%d deprecated=%d',
      toolDefId, result.added ?? 0, result.deprecated ?? 0
    );
  }
}

/**
 * LIFECYCLE-P1-D2: First-invocation probe.
 *
 * After the first successful invoke on a mcp_hosted tool that had no
 * available_tools at reseed time (cold-deploy or pre-INTROSPECT install),
 * fetch the current tools/list and POST to auth's drift endpoint.
 *
 * This is the replacement for the broken finalize-time probe
 * (_scheduleHostedToolsSync in powers.js) which always 404'd because the
 * process hadn't been spawned yet. By the time the first invocation returns
 * ok=true, the process is definitely running and tools/list is available.
 *
 * Idempotency: the closure tracks whether this has been fired in the process
 * lifetime via _firstProbeFired Set (keyed by cacheKey = orgId::toolName).
 * Concurrent callers see the key already present and skip.
 *
 * @param {string} toolDefId - tool_definitions.id (= powers_hosted.tool_id)
 * @param {string} cacheKey  - closure cache key, used for Set membership
 */
async function _runFirstInvocationProbe(toolDefId, cacheKey) {
  const powersHostUrl = process.env.POWERS_HOST_URL || 'http://powers-host:9849';
  const url = `${powersHostUrl}/internal/mcp-hosted/${encodeURIComponent(toolDefId)}/tools`;

  console.log('[LIFECYCLE-P1-D2] first-probe GET %s', url);

  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    console.warn('[LIFECYCLE-P1-D2] first-probe fetch error tool=%s: %s', toolDefId, err.message);
    throw err; // propagate so caller can remove from _firstProbeFired
  }

  if (!resp.ok) {
    let bodyExcerpt = '';
    try { bodyExcerpt = (await resp.text()).slice(0, 200); } catch (_) {}
    console.warn('[LIFECYCLE-P1-D2] first-probe non-2xx tool=%s status=%d: %s', toolDefId, resp.status, bodyExcerpt);
    throw new Error(`first-probe non-2xx: ${resp.status}`);
  }

  let data;
  try { data = await resp.json(); } catch (err) {
    console.warn('[LIFECYCLE-P1-D2] first-probe invalid JSON tool=%s: %s', toolDefId, err.message);
    throw err;
  }

  const tools = data?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    console.log('[LIFECYCLE-P1-D2] first-probe returned no tools tool=%s', toolDefId);
    return;
  }

  console.log('[LIFECYCLE-P1-D2] first-probe got %d tools tool=%s — posting to auth', tools.length, toolDefId);

  // POST to auth drift endpoint — same mechanism as re-probe callback
  await _postAvailableToolsDriftToAuth(toolDefId, tools);
}

/**
 * Build a synthetic execute closure for an mcp_endpoint-installed tool.
 * Called once per unique (toolName, orgId) pair; result is cached.
 *
 * INTROSPECT-P2: If executorConfig._inner_name is set, this is an UNFOLDED alias
 * for a specific inner MCP tool. The inner_name is used directly — args come straight
 * from the LLM (no wrapper input.tool_name unwrap needed).
 *
 * If executorConfig._inner_name is absent, this is a LEGACY wrapper tool.
 * Input must have { tool_name, arguments } — LLM guesses the inner tool name.
 *
 * @param {string} toolName
 * @param {object} meta - Row from toolDefinitionsStore
 * @returns {Function} async (input, ctx) => runResult
 */
function _buildMcpEndpointExecute(toolName, meta) {
  const cacheKey = `${meta.org_id || '__global__'}::${toolName}`;
  if (_mcpEndpointClosureCache.has(cacheKey)) {
    return _mcpEndpointClosureCache.get(cacheKey);
  }

  let executorConfig = {};
  try {
    executorConfig = meta.executor_config ? JSON.parse(meta.executor_config) : {};
  } catch (_) {}

  const { mcp_url, mcp_auth_kind, mcp_auth_value_encrypted, available_tools,
          _inner_name: fixedInnerName } = executorConfig;
  const availableNames = Array.isArray(available_tools) ? available_tools.map(t => t.name) : [];
  const isUnfolded = typeof fixedInnerName === 'string' && fixedInnerName !== '';

  const execute = async (input, ctx) => {
    const installOrgId = meta.org_id || null;
    const callerOrgId = (ctx && ctx.orgId) || null;
    // H1: fail-closed — reject when EITHER org is unknown to prevent null/null bypass
    if (!installOrgId || !callerOrgId || installOrgId !== callerOrgId) {
      console.warn(
        '[mcp/_buildMcpEndpointExecute] org guard rejected: install_org=%s caller_org=%s tool=%s',
        installOrgId, callerOrgId, toolName
      );
      return { error: 'cross-org mcp invocation rejected' };
    }

    let requestedTool;
    let callArgs;

    if (isUnfolded) {
      // INTROSPECT-P2: UNFOLDED PATH — inner tool name is fixed at install time.
      requestedTool = fixedInnerName;
      callArgs = input || {};
    } else {
      // LEGACY WRAPPER PATH — LLM must pass { tool_name, arguments }
      requestedTool = input && input.tool_name;
      if (!requestedTool || !availableNames.includes(requestedTool)) {
        return { error: `mcp_tool_not_available: ${requestedTool} (available: ${availableNames.join(', ')})` };
      }
      callArgs = input && input.arguments || {};
    }

    let authValue = null;
    if (mcp_auth_value_encrypted) {
      try {
        const encryption = require('./encryption.js');
        authValue = encryption.decrypt(mcp_auth_value_encrypted);

        // B1: emit secret.access audit event to auth (fire-and-forget, non-fatal).
        // collector→auth HTTP because collector doesn't share auth.db directly.
        const _authBase = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
        const _svcKey = process.env.INTERNAL_SERVICE_KEY || '';
        fetch(`${_authBase}/api/internal/powers/audit/secret-access`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(_svcKey ? { 'X-Service-Key': _svcKey } : {}),
          },
          body: JSON.stringify({
            org_id: installOrgId,
            tool_id: toolName,
            label: `powers:mcp_endpoint:${toolName}`,
          }),
          signal: AbortSignal.timeout(3000),
        }).catch(err => {
          console.warn('[mcp/_buildMcpEndpointExecute] secret.access audit emission failed tool=%s: %s', toolName, err.message);
        });
      } catch (e) {
        return { error: 'mcp_auth_decrypt_failed' };
      }
    }

    // LIFECYCLE-P3-D2: VOLT power.invoke.dispatched (fire-and-forget)
    const epInvokeCorr = `INVOKE_EP_${toolName}_${Date.now()}`;
    const epInvokeRunId = _powersVoltEmitter && _powersVoltEmitter.isAvailable()
      ? _powersVoltEmitter.startRun(epInvokeCorr, { org_id: callerOrgId })
      : null;
    _emitPowersInvokeVolt(epInvokeRunId, 'power.invoke.dispatched', toolName, callerOrgId,
      { tool_name: toolName, inner_tool: requestedTool, executor_type: 'mcp_endpoint' });

    const mcpClient = require('./mcpEndpointClient.js');
    const result = await mcpClient.callMcpTool(
      mcp_url,
      requestedTool,
      callArgs,
      { authKind: mcp_auth_kind, authValue, timeoutMs: 30000 }
    );

    if (result.ok === true) {
      // LIFECYCLE-P3-D2: VOLT power.invoke.completed (fire-and-forget)
      _emitPowersInvokeVolt(epInvokeRunId, 'power.invoke.completed', toolName, callerOrgId,
        { tool_name: toolName, inner_tool: requestedTool, executor_type: 'mcp_endpoint' });
      if (epInvokeRunId) _powersVoltEmitter.completeRun(epInvokeRunId);
      return { content: result.result?.content || [], _mcp_raw: result.result };
    }

    // LIFECYCLE-P3-D2: VOLT power.invoke.failed (fire-and-forget)
    _emitPowersInvokeVolt(epInvokeRunId, 'power.invoke.failed', toolName, callerOrgId,
      { tool_name: toolName, inner_tool: requestedTool, executor_type: 'mcp_endpoint', error: result.error });
    if (epInvokeRunId) _powersVoltEmitter.failRun(epInvokeRunId, new Error(result.error || 'mcp_endpoint_error'));

    return { error: result.error };
  };

  _mcpEndpointClosureCache.set(cacheKey, execute);
  return execute;
}

/**
 * Returns the FULL tool definition (metadata from DB merged with executor
 * from TOOL_DEFS). Falls back to the hardcoded entry if the DB hasn't been
 * initialised or the row is missing — back-compat for tests + early boot.
 *
 * TOOLSMITH E-fix-4 (Error 1): when the tool is not in TOOL_DEFS but IS
 * registered in toolDefinitionsStore with executor_type='toolsmith', a
 * synthetic execute closure is built and returned. This closes the
 * install → invoke gap for all toolsmith-installed tools.
 *
 * @param {string} name - Tool name
 * @param {string} [orgId='__global__'] - Org ID for org-specific overrides
 * @returns {object|null} Full tool definition with execute fn, or null if unknown
 */
function getToolDef(name, orgId = '__global__') {
  const hardcoded = TOOL_DEFS[name];

  // ── Dynamic executor branch (toolsmith + mcp_endpoint) ───────────────────
  // When not in the hardcoded registry: check the DB for a dynamic tool.
  if (!hardcoded) {
    if (!toolStore.isReady()) return null;
    const meta = toolStore.getToolMeta(name, orgId);
    if (!meta || (meta.executor_type !== 'toolsmith' && meta.executor_type !== 'mcp_endpoint' && meta.executor_type !== 'mcp_hosted')) return null;

    // Annotate meta with the resolved orgId so _buildToolsmithExecute can check
    // install-time org for cross-org rejection (TOOLSMITH-FIX-4).
    // getToolMeta SELECT doesn't return org_id; we know the query orgId is the right one.
    const metaWithOrg = { ...meta, org_id: meta.org_id || (orgId !== '__global__' ? orgId : null) };

    let inputSchema = { type: 'object', properties: {}, required: [] };
    try {
      inputSchema = metaWithOrg.input_schema
        ? (typeof metaWithOrg.input_schema === 'string' ? JSON.parse(metaWithOrg.input_schema) : metaWithOrg.input_schema)
        : inputSchema;
    } catch (_) {}

    if (metaWithOrg.executor_type === 'mcp_endpoint') {
      return {
        name: metaWithOrg.name,
        description: metaWithOrg.description,
        input_schema: MCP_WRAPPER_INPUT_SCHEMA,
        execute: _buildMcpEndpointExecute(name, metaWithOrg),
        _executorType: 'mcp_endpoint',
        _orgId: metaWithOrg.org_id || orgId,
      };
    }

    if (metaWithOrg.executor_type === 'mcp_hosted') {
      return {
        name: metaWithOrg.name,
        description: metaWithOrg.description,
        input_schema: MCP_WRAPPER_INPUT_SCHEMA,
        execute: _buildMcpHostedExecute(name, metaWithOrg),
        _executorType: 'mcp_hosted',
        _orgId: metaWithOrg.org_id || orgId,
      };
    }

    return {
      name: metaWithOrg.name,
      description: metaWithOrg.description,
      input_schema: inputSchema,
      execute: _buildToolsmithExecute(name, metaWithOrg),
      _executorType: 'toolsmith',
      _orgId: metaWithOrg.org_id || orgId,
    };
  }
  // ── End dynamic branch ────────────────────────────────────────────────────

  if (!toolStore.isReady()) return hardcoded; // Pre-init fallback
  const meta = toolStore.getToolMeta(name, orgId);
  if (!meta) return hardcoded;
  return {
    ...hardcoded,                                        // Keeps execute fn
    name: meta.name,
    description: meta.description,                      // DB description wins
    input_schema: JSON.parse(meta.input_schema),
  };
}

// ============================================================================
// Public API
// ============================================================================

// DB tool cache for custom agents: agentKey → { toolNames, expiry }
const _dbToolCache = new Map();
const DB_TOOL_CACHE_TTL = 60000; // 60s

/**
 * Get Anthropic tool definitions for a given agent (sync, hardcoded only)
 */
function getToolsForAgent(agentId, ctx) {
  const agentKey = canonicalAgentId(agentId);
  const baseNames = AGENT_TOOLS[agentKey] || AGENT_TOOLS.quox;
  const orgId = ctx?.orgId || '__global__';

  // QUOXHAT P-A — every agent holds the narrow governance tools in its grant,
  // deduped and regardless of which AGENT_TOOLS slice it resolved from. These
  // are the only tools whose presence is agent-independent: they are the
  // mechanism to operate within a hat, so no specialist can be stranded without
  // them. Authorization of the ACTIONS they trigger (e.g. whether a proposed
  // switch is allowed) is still evaluated by the gate; holding the tool only
  // means the agent may ASK.
  // QUOXHAT MISSION D1 — the Tier-0 self-read floor rides in every agent's grant
  // too (same mechanism as the P-A governance grant), so no specialist is left
  // unable to read its own org's HITL inbox. Deduped against both sets.
  const toolNames = [
    ...GOVERNANCE_TOOLS,
    ...TIER0_READ_TOOLS,
    ...baseNames.filter(n => !GOVERNANCE_TOOLS.includes(n) && !TIER0_READ_TOOLS.includes(n)),
  ];

  return toolNames
    .map(name => getToolDef(name, orgId))
    .filter(Boolean)
    .map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      entity: !!t._entity,
      provider: t._provider || null
    }));
}

/**
 * Get Anthropic tool definitions for a given agent (async, DB-merged).
 * For every agent (built-in OR custom):
 *   1. Start with the hardcoded slice (AGENT_TOOLS → TOOL_DEFS).
 *   2. Fetch DB-installed tools from auth service (/internal/agents/:id/tools).
 *   3. Merge: DB descriptors win on name conflict (orgs can override built-ins).
 *   4. Cache merged result for 60s.
 * Falls back to the hardcoded slice alone if the auth service is unreachable.
 */
/**
 * Shared resolver behind getToolsForAgentAsync/getAccessModeForAgentTool.
 * Returns { tools, dbOk } — dbOk is false whenever the auth-service DB
 * lookup itself failed (non-2xx or thrown), as opposed to a lookup that
 * SUCCEEDED and legitimately found no DB-installed tools/assignments for
 * this agent. quox#556 follow-up (2026-09-25): a DB-less fallback result is
 * intentionally NOT cached (see below) so a single auth-service blip can't
 * be silently re-served for the full 60s TTL, and callers that need to
 * distinguish "no assignment" from "couldn't ask" (getAccessModeForAgentTool)
 * read dbOk rather than only inspecting the returned tools array.
 */
async function _resolveToolsForAgent(agentId) {
  const agentKey = canonicalAgentId(agentId);

  // Check cache first (covers both built-in and custom agents). Only
  // successful DB lookups are ever cached (see the dbOk guard below), so a
  // cache hit always implies dbOk: true.
  const cached = _dbToolCache.get(agentKey);
  if (cached && cached.expiry > Date.now()) {
    return { tools: cached.tools, dbOk: true, agentNotFound: !!cached.agentNotFound };
  }

  // Hardcoded slice — only for agents explicitly registered in AGENT_TOOLS.
  // Unknown/custom agents get an empty hardcoded slice; DB descriptors supply everything.
  // Tagged source: 'hardcoded' for observability.
  //
  // QUOXHAT MISSION FND-2 (RPP brutaloop, 2026-10-02): the universal floor
  // (GOVERNANCE_TOOLS + TIER0_READ_TOOLS) must ride EVERY agent's grant on the
  // governed exec/MCP route too, not only the chat route. A DB-resolved/custom
  // agent (a ULID not in AGENT_TOOLS) previously got an EMPTY hardcoded slice
  // here, so the floor was never unioned in and a self-scoped read like
  // inbox_pending/memory_search/quoxbrain_search was DENIED on
  // /api/v1/tools/execute (live-proven: resident builder agent denied
  // inbox_pending=not_granted under the default hat). For a KNOWN agent the
  // floor is already included by getToolsForAgent; for an UNKNOWN agent we
  // supply the floor ALONE — never quox's full fallback grant, which stays
  // fail-closed (DB descriptors supply everything else).
  const hardcodedTools = AGENT_TOOLS[agentKey]
    ? getToolsForAgent(agentKey).map(t => ({
        ...t,
        source: 'hardcoded' // marks origin for observability/debugging
      }))
    : [...GOVERNANCE_TOOLS, ...TIER0_READ_TOOLS]
        .map(name => getToolDef(name))
        .filter(Boolean)
        .map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
          entity: !!t._entity,
          provider: t._provider || null,
          source: 'hardcoded-floor' // universal floor for a DB-resolved agent
        }));

  // Fetch DB-installed descriptors from auth service
  const authBase = process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
  let dbDescriptors = [];
  let toolNames = hardcodedTools.map(t => t.name);
  let dbOk = false;
  // True only on a definitive 404 "Agent 'x' not found": fine for access_mode (built-in
  // agent, no overrides) but the custom-agent RBAC gate must NOT treat it as a known agent.
  let agentNotFound = false;

  try {
    const resp = await fetch(`${authBase}/internal/agents/${agentKey}/tools`, {
      headers: serviceKey ? { 'X-Service-Key': serviceKey } : {},
      signal: AbortSignal.timeout(5000)
    });

    if (resp.ok) {
      const body = await resp.json();
      // toolDescriptors carries full Anthropic-shaped descriptors from auth service
      dbDescriptors = (body.toolDescriptors || []);
      toolNames = (body.toolNames || toolNames);
      dbOk = true;
    } else {
      // A definitive "Agent 'x' not found" from auth means a built-in agent
      // with no DB row: a successful lookup with no overrides (hardcoded
      // tools only, no access_mode). Anything else (5xx, a 404 with another
      // or non-JSON body such as a missing route) stays dbOk=false.
      if (resp.status === 404) {
        try {
          const errBody = await resp.json();
          agentNotFound = typeof errBody?.error === 'string' && /^Agent '.+' not found$/.test(errBody.error);
        } catch (_) { /* non-JSON body: not a definitive answer */ }
      }
      if (agentNotFound) {
        dbOk = true;
      } else {
        console.warn(`[Tools] DB lookup failed for agent '${agentKey}': ${resp.status}`);
      }
    }
  } catch (err) {
    console.warn(`[Tools] DB lookup error for agent '${agentKey}':`, err.message);
    // Fall through — dbDescriptors stays empty, hardcoded slice used alone,
    // dbOk stays false.
  }

  // Merge: start with hardcoded, then overlay DB descriptors (DB wins on conflict)
  const byName = new Map();
  for (const t of hardcodedTools) {
    byName.set(t.name, t);
  }
  for (const t of dbDescriptors) {
    // DB descriptor wins — overrides any hardcoded entry with same name
    byName.set(t.name, {
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      entity: false,
      provider: t.provider || null,
      source: 'db', // marks origin for observability/debugging
      // #556: per-agent access_mode from agent_tool_assignments, carried
      // through so checkApproval() can gate 'with_approval' assignments.
      access_mode: t.access_mode || 'full'
    });
  }

  // An agent outside AGENT_TOOLS that auth could not confirm (404 not found, or the
  // lookup failed) lists NOTHING, matching executeTool's refusal for the same case
  // (quox#671). The FND-2 floor is for DB-resolved agents auth actually knows.
  // toolNames is cleared too: _isCustomAgentAuthorized authorizes from the CACHED names,
  // so leaving the floor there let the second call inside the TTL skip the refusal.
  const unconfirmedCustom = !AGENT_TOOLS[agentKey] && (!dbOk || agentNotFound);
  const tools = unconfirmedCustom ? [] : Array.from(byName.values());
  if (unconfirmedCustom) toolNames = [];

  // quox#556 follow-up: only cache a SUCCESSFUL DB lookup. Caching the
  // DB-less fallback would silently re-serve "no assignment found" for up
  // to DB_TOOL_CACHE_TTL (60s) on every subsequent call during an auth
  // outage, including calls whose real (uncached) access_mode is
  // 'with_approval' — the exact governance bypass this follow-up closes.
  if (dbOk) {
    _dbToolCache.set(agentKey, { tools, toolNames, agentNotFound, expiry: Date.now() + DB_TOOL_CACHE_TTL });
  }
  console.log(`[Tools] Resolved ${tools.length} tools for agent '${agentKey}' (${hardcodedTools.length} hardcoded + ${dbDescriptors.length} from DB, dbOk=${dbOk})`);
  return { tools, dbOk, agentNotFound };
}

async function getToolsForAgentAsync(agentId) {
  const { tools } = await _resolveToolsForAgent(agentId);
  return tools;
}

/**
 * #556: look up an agent's per-tool access_mode ('full' | 'read_only' |
 * 'with_approval'), sourced from auth's agent_tool_assignments via the same
 * 60s DB-tool cache getToolsForAgentAsync already maintains — no extra
 * fetch. Returns null when the tool has no DB assignment (hardcoded-only
 * tools never carry access_mode) so callers can treat null the same as
 * 'full' (no additional gating).
 *
 * quox#556 follow-up (2026-09-25): if the underlying auth-service DB lookup
 * itself failed (unreachable, timed out, non-2xx), we cannot legitimately
 * assert "no assignment" — a real 'with_approval' override could exist and
 * we simply couldn't ask. Returns the sentinel 'unknown' in that case so
 * approvalGate.js's caller can fail closed on it exactly like an explicit
 * 'with_approval', instead of silently falling through as if access_mode
 * were unset. AVAILABILITY TRADEOFF: while the auth-service DB lookup is
 * down, every tool call resolves to 'unknown' here and is gated for human
 * approval, not just ones with a configured 'with_approval' override.
 *
 * @param {string} agentId
 * @param {string} toolName - the emitted tool name (matches toolDescriptors[].name)
 * @returns {Promise<string|null>} 'full' | 'read_only' | 'with_approval' | 'unknown' | null
 */
async function getAccessModeForAgentTool(agentId, toolName) {
  const agentKey = (agentId || 'quox').toLowerCase();
  const { tools, dbOk } = await _resolveToolsForAgent(agentKey);
  if (!dbOk) return 'unknown';
  const tool = tools.find(t => t.name === toolName);
  return tool?.access_mode || null;
}

/**
 * Invalidate the DB tool cache for a specific agent.
 * Called after a bulk-assign operation so the next chat request
 * fetches fresh assignments from auth rather than returning stale data.
 *
 * @param {string} agentKey - Agent manifest ID (e.g. 'sentinel', 'cipher')
 */
function invalidateAgentToolCache(agentKey) {
  if (!agentKey) return;
  const key = agentKey.toLowerCase();
  const deleted = _dbToolCache.delete(key);
  console.log(`[Tools] Cache invalidated for agent '${key}' (was cached: ${deleted})`);
}

/**
 * Check if a custom agent (from DB cache) is authorized to use a tool.
 * Returns true if authorized, false otherwise.
 */
function _isCustomAgentAuthorized(agentKey, toolName) {
  const cached = _dbToolCache.get(agentKey);
  if (!cached || cached.expiry <= Date.now()) {
    return false; // No cache = no authorization info
  }
  return cached.toolNames.includes(toolName);
}

/**
 * Check if a tool name is a connector tool (prefixed with connector ID).
 * Returns { connectorId, toolName } or null.
 */
function parseConnectorTool(fullToolName) {
  const connectors = listConnectors();
  for (const c of connectors) {
    const prefix = `${c.id}_`;
    if (fullToolName.startsWith(prefix)) {
      return { connectorId: c.id, toolName: fullToolName.slice(prefix.length) };
    }
  }
  return null;
}

/**
 * Execute a tool by name with given input
 * @param {string} toolName - Tool name
 * @param {object} input - Tool input parameters
 * @param {object} ctx - Execution context { agentId, userId, orgId, _delegationDepth }
 * @returns {Promise<object>} Tool result
 */
/** Structured fields from quoxbrainRead's (stable, self-generated) header lines. */
function readResultFields(output, noteId) {
  const text = String(output || '');
  const pick = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  const out = {
    noteId: pick(/\(noteId: ([^,\s)]+)/) || noteId,
    revision: pick(/\(revision: ([0-9a-f]+);/),
    vault: pick(/\(vault: (.+?)(?: \| |\)\s*$)/m),
    path: pick(/path: (.+?)(?: \| |\)\s*$)/m),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}

// CORTEX-BENCH (ONE-BRAIN CX0): an attached session's tool calls run as the
// agent identity, whose user id is the synthetic 'service'. For the knowledge-
// brain tools that meant an owner who attached Cortex searched someone else's
// (empty) private scope and saved notes they could never see. For these tools
// only, the brain user is the HUMAN holding the attach lease (holder_user_id
// from the signed attach JWT): the same person could run the same read/write
// directly with their own session. Evidence still records the agent as actor
// and the holder separately; every other tool keeps the agent identity.
const BRAIN_HOLDER_TOOLS = new Set(['recall', 'quoxbrain_search', 'quoxbrain_read', 'brain_save', 'brain_update', 'brain_delete', 'brain_restore', 'brain_garden_apply', 'brain_related', 'brain_neighbours', 'brain_history', 'brain_context', 'brain_check', 'brain_why', 'brain_brief', 'brain_suggestions']);
function brainHolderCtx(toolName, ctx = {}) {
  if (!ctx || !ctx.attachLeaseId || !ctx.holderUserId || !BRAIN_HOLDER_TOOLS.has(toolName)) return ctx;
  return { ...ctx, userId: String(ctx.holderUserId), brainUserFromHolder: true };
}

async function executeTool(toolName, input, ctx = {}) {
  ctx = brainHolderCtx(toolName, ctx);
  // QUOXHAT P-C.4 — COMPLETE MEDIATION. The chat/MCP/internal legs pre-resolve
  // the hat and arm ctx.hatManifest; but a handful of direct tool routes (e.g.
  // POST /docker/containers/:id/:action) call executeTool with an org context
  // and NO manifest, so under enforce they ran ungated. Rather than arm each
  // route by hand (fragile — the next new route forgets), make the single choke
  // point every dispatch crosses self-arm: if this is an org-scoped call with no
  // manifest, resolve+arm the hat here. Fires ONLY when ctx.orgId is set AND no
  // manifest was pre-armed, so it never double-gates the chat path and never
  // touches org-less collector-internal diagnostics. Only tightens enforce orgs
  // (preview/unknown → no manifest set → no gate). Never throws: a resolve
  // failure for a known-enforcing org fails CLOSED (buildFailClosedManifest),
  // everything else proceeds on the legacy path. Resolves are cached, so the
  // added cost is one cached lookup on the rare un-armed route.
  if (ctx.orgId && !ctx.hatManifest && require('./hatManifest').lastKnownEnforcement(ctx.orgId) === 'enforce') {
    // Cheap pre-filter (P-C.3 durable memory): ONLY orgs we already know can
    // enforce pay for a resolve here. Orgs never observed enforcing — the
    // overwhelming majority, and every org-scoped unit test — skip entirely, so
    // the auto-arm adds no fetch and no behaviour change on the common path.
    // The normal chat/leg traffic populates lastKnownEnforcement, so by the time
    // a direct route is hit the enforce org is known; a first-ever call before
    // any resolve is the same "never observed" residual P-C.3 documents.
    try {
      const { resolveHatForTurn, buildTurnManifest, buildFailClosedManifest } = require('./hatManifest');
      const hatTurn = await resolveHatForTurn({
        orgId: ctx.orgId,
        userId: ctx.userId || null,
        conversationId: ctx.session_id || ctx.conversationId || null,
        agent: ctx.agentId || null,
      });
      if (hatTurn?.enforcement === 'enforce' && hatTurn.hat) {
        const grant = await getToolsWithConnectors(ctx.agentId, ctx.orgId);
        const manifest = buildTurnManifest({ agentTools: grant, hat: hatTurn.hat, loadedBundles: hatTurn.binding?.loaded_bundles || [], agent: ctx.agentId || null });
        if (manifest) {
          ctx.hatManifest = {
            enforced: true,
            authzToolNames: manifest.authzToolNames,
            grantToolNames: manifest.grantToolNames,
            authzMode: manifest.authzMode,
            authorizedAgents: manifest.authorizedAgents,
            delegationScoped: manifest.delegationScoped,
            toolNames: manifest.toolNames,
            hatKey: manifest.hatKey, hatId: manifest.hatId, revision: manifest.revision, digest: manifest.digest,
            _autoArmed: true, // provenance: gated by complete-mediation, not a leg
          };
        }
      } else if (!hatTurn) {
        const fc = buildFailClosedManifest(ctx.orgId);
        if (fc) { fc._autoArmed = true; ctx.hatManifest = fc; }
      }
    } catch (autoArmErr) {
      try {
        const { buildFailClosedManifest } = require('./hatManifest');
        const fc = buildFailClosedManifest(ctx.orgId);
        if (fc) { fc._autoArmed = true; ctx.hatManifest = fc; }
      } catch { /* leave unarmed → legacy path */ }
      console.warn(`[QUOXHAT] complete-mediation auto-arm failed for org=${ctx.orgId} tool=${toolName}: ${autoArmErr?.message}`);
    }
  }

  // QUOXHAT P-B: the authorization gate. The AUTHORIZATION set (authzToolNames
  // = the agent's grant ceiling ∩ the hat's mode rule) is what gates execution,
  // NOT the presentation set (toolNames, what the model was shown). This is the
  // core #657 reframe: shrinking the presented set for focus/128-cap no longer
  // forbids execution, and an unadvertised-but-eligible tool the model asks for
  // still runs. Only fires on an ENFORCED manifest; preview/legacy turns change
  // nothing. Named denial with a precise reason (not-granted vs mode-forbidden)
  // so the model and the audit trail see exactly why, and so brutaloop can
  // assert ZERO DISPATCH on a denial rather than just an error string.
  //
  // Defensive fallback: if an enforced manifest somehow lacks authzToolNames
  // (pre-P-B shape), gate on the presentation set rather than fail OPEN —
  // availability/shape drift must never expand authority.
  if (ctx.hatManifest?.enforced) {
    const authz = ctx.hatManifest.authzToolNames || ctx.hatManifest.toolNames;
    if (authz && !authz.has(toolName)) {
      const grantSet = ctx.hatManifest.grantToolNames;
      const notGranted = grantSet ? !grantSet.has(toolName) : null;
      const reason = notGranted === true
        ? 'not granted to this agent'
        : notGranted === false
          ? `forbidden by hat '${ctx.hatManifest.hatKey}' mode (${ctx.hatManifest.authzMode || 'restrictive'})`
          : `outside hat '${ctx.hatManifest.hatKey}' authorization`;
      console.warn(`[QUOXHAT] tool '${toolName}' denied (P-B authz): ${reason} — hat '${ctx.hatManifest.hatKey}' rev ${ctx.hatManifest.revision}, agent=${ctx.agentId || '?'}, org=${ctx.orgId || '?'}`);
      // QUOXON-FW3: name who DOES hold the tool so the delegating model stops
      // guessing. Informational only; the gate above is unchanged.
      const heldBy = notGranted === true ? holdersOfTool(toolName, ctx.agentId) : [];
      // QUOXON-PROOF (quox#819): a name no tool defines (a phantom like host_health_check
      // or whoami) is not a grant problem. Say it does not exist, so the model stops
      // retrying it and finds the real tool, instead of reporting a withheld capability.
      let unknownTool = false;
      if (notGranted === true && heldBy.length === 0 && !TOOL_DEFS[toolName]) {
        try { unknownTool = !parseConnectorTool(toolName); } catch { unknownTool = false; }
      }
      return {
        success: false,
        error: unknownTool
          ? `Tool ${toolName} does not exist in Quox (no tool has that name). Do not retry it; find the right tool with more_tools or hat_catalogue, or say plainly that you have no tool for this.`
          : notGranted === true
          ? `Tool ${toolName} is not granted to agent ${ctx.agentId || '?'}. ${describeHolders(heldBy)}`
          : `Tool ${toolName} is ${reason}. Switch hats, propose a scope change, or delegate to a specialist.`,
        ...(notGranted === true ? { heldBy } : {}),
        ...(unknownTool ? { unknownTool: true } : {}),
        hatDenied: true,
        hatDenyReason: notGranted === true ? 'not_granted' : 'mode_forbidden',
        hat: ctx.hatManifest.hatKey,
        hatRevision: ctx.hatManifest.revision,
      };
    }
  }

  // LICENSE-LAUNCH LL-6d: governed-agent entitlement gate. If ctx.agentId is a
  // paid governed agent (AGENT_REQUIRES_PLUGIN — GRIPE is the first, its id is
  // in the auth service's GOVERNED_PLUGIN_IDS), the caller org must hold that
  // entitlement or EVERY tool call is refused HERE — before any tool (connector
  // or native) runs. This is the single choke point every dispatch path crosses,
  // so it covers direct selection in ordinary chat AND QUOX/BOB delegation
  // (which lands with ctx.agentId set to the delegate). Fail CLOSED: a lookup
  // that throws denies, mirroring the LE-3f data-plane gate's posture — an
  // entitlement check that opens on error is not enforcement.
  if (ctx.agentId) {
    const requiredPlugin = getRequiredPluginForAgent(ctx.agentId);
    if (requiredPlugin) {
      const orgId = ctx.orgId || 'default';
      let licensed = false;
      try {
        licensed = await isPluginLicensedForAgentGate(orgId, requiredPlugin);
      } catch (_) {
        licensed = false; // fail closed
      }
      if (!licensed) {
        console.warn(`[Tools] LICENSE denied: agent '${ctx.agentId}' requires the '${requiredPlugin}' entitlement (org=${orgId})`);
        return {
          success: false,
          error: `Agent ${ctx.agentId} requires the '${requiredPlugin}' entitlement, which this organization does not hold`,
          licenseRequired: true,
          plugin: requiredPlugin,
        };
      }
    }
  }

  // X-PLUGIN phase 9: governed-TOOL entitlement gate, actor-independent (see
  // TOOL_REQUIRES_PLUGIN above). Placed at the same choke as the agent gate so
  // every dispatch path crosses it; connector capabilities get the equivalent
  // gate inside the bridge (CAPABILITY_REQUIRES_PLUGIN). Fail CLOSED.
  {
    const requiredPluginForTool = getRequiredPluginForTool(toolName);
    if (requiredPluginForTool) {
      const orgId = ctx.orgId || 'default';
      let licensed = false;
      try {
        licensed = await isPluginLicensedForAgentGate(orgId, requiredPluginForTool);
      } catch (_) {
        licensed = false; // fail closed
      }
      if (!licensed) {
        console.warn(`[Tools] LICENSE denied: tool '${toolName}' requires the '${requiredPluginForTool}' entitlement (org=${orgId})`);
        return {
          success: false,
          error: `The ${toolName} tool requires the '${requiredPluginForTool}' entitlement, which this organization does not hold`,
          licenseRequired: true,
          plugin: requiredPluginForTool,
        };
      }
    }
  }

  // Check if this is a connector tool (e.g., github_list_repos → connector=github, tool=list_repos)
  // CONNFAC Phase 0 — a static tool of the SAME NAME wins over connector prefix
  // routing. Without this, six real tools were unreachable: the prefix match
  // returned unconditionally, so github_create_pull_request, grafana_dashboards
  // and discord_{list_bindings,diagnose,bind_channel,unbind_channel} were handed
  // to a connector that has no such tool and their implementations never ran.
  // Deliberately consults ONLY the hardcoded TOOL_DEFS map (own properties), not
  // getToolDef's org-dynamic/toolsmith lookup, so an org-created dynamic tool
  // named like a connector tool cannot inversely hijack the connector path.
  // New collisions are surfaced at module init by validateConnectorNamespace.
  const connectorParsed = Object.prototype.hasOwnProperty.call(TOOL_DEFS, toolName)
    ? null
    : parseConnectorTool(toolName);
  if (connectorParsed) {
    // AGENT-OVERHAUL-2 FIX 1 — per-agent connector-family RBAC, checked BEFORE
    // dispatch to the bridge (previously this branch ran ahead of any RBAC
    // check at all). Mirrors the native-tool RBAC below: only enforced when
    // ctx.agentId is present, and denies with the same honest not-authorized
    // shape rather than a silent pass-through.
    if (ctx.agentId) {
      const allowedFamilies = getConnectorFamiliesForAgent(ctx.agentId);
      if (!allowedFamilies.includes(connectorParsed.connectorId)) {
        console.warn(`[Tools] RBAC denied (connector): ${ctx.agentId} attempted ${toolName} (family=${connectorParsed.connectorId})`);
        return { success: false, error: `Agent ${ctx.agentId} is not authorized to use ${toolName}` };
      }
      // SEC-AUDIT (2026-08-11) S2 — defense in depth: enforce the same
      // per-agent tool-name allowlist at execution time, not only at
      // tool-offering time (getToolsWithConnectors). Closes the path where a
      // prompt-injected instruction (e.g. via an unsanitised build_receipts
      // message reaching bob's context) asks the agent to call a tool name
      // it was never actually offered but that its connector family would
      // otherwise still let through.
      const toolAllowlist = getConnectorToolAllowlistForAgent(ctx.agentId);
      if (toolAllowlist && !toolAllowlist.includes(toolName)) {
        console.warn(`[Tools] RBAC denied (connector tool-allowlist): ${ctx.agentId} attempted ${toolName}`);
        return { success: false, error: `Agent ${ctx.agentId} is not authorized to use ${toolName}` };
      }
    }
    const orgId = ctx.orgId || 'default';
    // QUOXTRUST T9/D4 (finding 5.1): GOV-4 org governance/safety policy for
    // connector tools is enforced INSIDE executeConnectorTool (the shared bridge
    // choke every connector caller crosses — agent, direct HTTP route, gripe
    // handler), so one policy governs every path, not just this one.
    console.log(`[Tools] Routing ${toolName} to connector bridge (${connectorParsed.connectorId}/${connectorParsed.toolName})`);
    const connectorResult = await executeConnectorTool(orgId, connectorParsed.connectorId, connectorParsed.toolName, input, ctx);
    // QDIS-NEXT #439: gripe-feed real completion hook — gripe agent only,
    // real connector-bridge success only (never on every call/attempt/
    // failure). Deliberately scoped narrower than CONNECTOR_FAMILIES.github
    // (which BOB also shares) so BOB's own issue-filing doesn't double up
    // into gripe's feed. See gripeFeedLog.js header for the full call chain.
    if (ctx.agentId === 'gripe' && connectorParsed.connectorId === 'github' && connectorParsed.toolName === 'create_issue'
      && connectorResult && connectorResult.success && connectorResult.result) {
      logGripeIssueFiled({
        source: 'chat',
        repo: input && input.repo,
        number: connectorResult.result.number,
        title: connectorResult.result.title,
        url: connectorResult.result.url,
      });
    }
    return connectorResult;
  }

  const tool = getToolDef(toolName, ctx?.orgId);
  if (!tool) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  // APPROVAL-SPAM 4/6: a tool that pulls in content from OUTSIDE the org
  // (web, email body, issue, any connector) taints a human-driven conversation
  // until the human's next message, so a later action does not run on their
  // say-so when it may have been steered by what was just read.
  try { require('./directRequestRegistry.js').noteToolForTaint(ctx, toolName, tool); } catch { /* never blocks */ }

  // RBAC: Check if the agent is authorized to use this tool
  if (ctx.agentId) {
    const agentKey = canonicalAgentId(ctx.agentId);
    // QUOXHAT P-A + MISSION D1 — the universal floors (narrow governance tools +
    // Tier-0 self-reads) are granted to EVERY agent at getToolsForAgent, so they
    // must also pass THIS native RBAC, which consults the raw AGENT_TOOLS map /
    // custom-agent DB assignments (NOT getToolsForAgent). Without this skip, a
    // specialist's own hat_catalogue/inbox_pending would be stripped back out
    // here after already passing the P-B hat gate above. These tools are
    // authorized by construction — self-scoped, zero-effect reads and in-hat
    // governance that only lets the agent inspect/ask — never per-agent.
    const isUniversalFloor = GOVERNANCE_TOOLS.includes(toolName) || TIER0_READ_TOOLS.includes(toolName);
    const allowedTools = AGENT_TOOLS[agentKey];
    if (allowedTools) {
      // Core agent — check hardcoded list
      if (!allowedTools.includes(toolName) && !isUniversalFloor) {
        // TOOLSMITH-FIX-1: toolsmith agent is authorised for any tool
        // that resolves through the dynamic toolsmith executor branch
        // (executor_type='toolsmith' in toolDefinitionsStore).
        const dynamicToolsmith = agentKey === 'toolsmith' && tool && tool._executorType === 'toolsmith';
        if (!dynamicToolsmith) {
          console.warn(`[Tools] RBAC denied: ${agentKey} attempted ${toolName}`);
          return { success: false, error: `Agent ${agentKey} is not authorized to use ${toolName}` };
        }
        console.log(`[Tools] RBAC allow (toolsmith-dynamic): toolsmith → ${toolName} (org=${tool._orgId})`);
      }
    } else {
      // Custom agent — check DB cache; on miss, RESOLVE from auth now and fail
      // CLOSED. QUOXTRUST T-AUTH/D2 (WP1.4, codex fault-matrix 2026-09-28): the
      // old fallback granted any UNKNOWN agent the orchestrator's whole quox-level
      // toolset whenever the cache was cold ("graceful for fresh deploys") — an
      // unauthenticated-identity fail-open at the RBAC gate. Fresh deploys stay
      // graceful the honest way: fetch-on-miss resolves the agent's REAL
      // assignments (only successful lookups are cached, quox#556); an agent the
      // auth DB does not know, or a lookup that cannot be made (dbOk=false),
      // DENIES rather than guesses.
      //
      // quox#671 (2026-10-03): the universal floor used to SKIP this lookup,
      // so an agent auth had never heard of still got the Tier-0 reads. The
      // floor is for agents that EXIST: a floor tool now passes only once the
      // lookup succeeds (dbOk: auth answered 200, i.e. a known agent or an
      // active resident). A 404 (unknown) or an unreachable auth still denies.
      if (!_isCustomAgentAuthorized(agentKey, toolName)) {
        let resolved = null;
        try {
          resolved = await _resolveToolsForAgent(agentKey);
        } catch {
          resolved = null;
        }
        // An agent auth definitively does not know is denied even the floor (quox#671); the
        // 79492c1dc "not found = successful lookup" reading is for access_mode only.
        const authorized = !!(resolved && resolved.dbOk && !resolved.agentNotFound && (isUniversalFloor || (
          Array.isArray(resolved.tools)
          && resolved.tools.some((t) => t && t.name === toolName))));
        if (!authorized) {
          const why = resolved && resolved.dbOk ? 'no assignment' : 'assignment lookup unavailable, blocked closed';
          console.warn(`[Tools] RBAC denied (custom): ${agentKey} attempted ${toolName} (${why})`);
          return { success: false, error: `Agent ${agentKey} is not authorized to use ${toolName}` };
        }
      }
    }
  }

  const agentLabel = ctx.agentId || 'unknown';
  console.log(`[Tools] ${agentLabel} executing ${toolName}:`, summarizeToolInputForLog(input)); // QUOXTRUST v1.4 CF1: redacted, never raw input

  // VAULT-P5.H (F4) — a tool may declare `credentialedIntegration: { toolType }`
  // to opt into agent-scoped vault resolution instead of requiring the
  // caller to already know a specific credential_id: when the caller omits
  // credential_id, resolve one via resolveForAgent's caller
  // (agent_credential_assignments -> org default -> instance -> env),
  // lease-gated by the org's vault.lease_enforcement mode. Tools that always
  // require an explicit, caller-chosen credential_id (e.g. email_read/
  // email_send today) simply never set this and are unaffected.
  if (tool.credentialedIntegration?.toolType && !input?.credential_id && ctx.orgId && ctx.agentId) {
    const resolved = await resolveCredentialForAgent(ctx.orgId, ctx.agentId, tool.credentialedIntegration.toolType);
    if (resolved?.leaseBlocked) {
      console.warn(`[Tools] ${toolName} blocked: lease required for ${ctx.agentId}/${tool.credentialedIntegration.toolType} (${resolved.leaseReason})`);
      return { success: false, error: resolved.leaseReason || 'lease_required' };
    }
    if (resolved?.credentialId) {
      input = { ...input, credential_id: resolved.credentialId, _resolvedCredential: resolved.credentials || null };
    }
  }

  // QUOXTRUST T1/D1 unification: produce the ONE canonical action for this
  // execution AFTER credential resolution (line ~11119) and BEFORE governance,
  // and thread it on ctx so policy, approval and evidence reason about the SAME
  // effective action. Before this, the policy engine (conditionEvaluator
  // buildToolContext) saw only a hardcoded lossy subset (action/vmid/node/
  // command/host) — the policy-evaluated action was provably poorer than the
  // one the human approves and the adapter executes. Best-effort: a commitment
  // failure must never break execution (evidence/policy degrade, never crash).
  try { ctx._canonicalAction = buildCanonicalAction(toolName, input, ctx); } catch { /* non-fatal */ }

  // GOV-4: the single reference-monitor governance + approval decision, shared
  // verbatim with the connector-dispatch path above so one org policy governs
  // every agent-tool path (T2 fail-closed-under-outage + deny + require_approval
  // HITL all live in referenceMonitor.mediateGovernancePolicy now).
  // QUOXTRUST F5: classify a PLUGIN tool (server-side) so the monitor can default
  // its EFFECT tools to require_approval. Native/connector tools carry no _plugin
  // marker → toolMeta.isPluginEffect false → monitor behaviour unchanged for them.
  const _pluginEffectClass = tool && tool._plugin
    ? classifyPluginToolEffect({ baseName: tool._pluginBaseName || toolName, declared: tool._pluginEffect })
    : null;
  const _toolMeta = { isPluginEffect: _pluginEffectClass === 'effect' };
  const govNative = await referenceMonitor.mediateGovernancePolicy(toolName, input, ctx, GOV_MONITOR_DEPS, _toolMeta);
  if (govNative.outcome !== referenceMonitor.OUTCOME.ALLOW) {
    // QUOXTRUST WP3.5 (D4): a refusal is WITNESSED, not silent — the deny
    // receipt (ops.tool.denied, mandatory-evidence channel) binds the same
    // canonical action the policy evaluated, so "policy stopped it" is as
    // provable as "it ran". Previously the monitor returned BEFORE any emitter.
    _emitChokeToolEvidence(toolName, tool, input, ctx, 0, false,
      govNative.response?.error || govNative.response?.message || `policy_${govNative.outcome}`,
      'denied', /* force */ true);
    // Tell gold/internal callers (which emit their own EXECUTION receipt) that
    // this is a governance decision the choke already witnessed — skip their emit.
    if (govNative.response && typeof govNative.response === 'object') govNative.response._governanceDenied = true;
    return govNative.response;
  }

  // QUOXTRUST T3/C2 (WP2, docs/trust/C2-EXECUTION-STATE-MACHINE.md) — durable
  // intent BEFORE dispatch for external effects. A def flagged externalEffect
  // (and not selfLedgers — email_send/send_notification run their own in-execute
  // hooks) must have a durable 'claimed' row before its execute is entered, keyed
  // by the C3 effect identity so intent and evidence commit to the same bytes.
  // Fail CLOSED: no ledger store, or a claim that throws, refuses the action
  // (unavailable is not absent — C2 rule 1). Dispatch stamping: tools that gate
  // INSIDE execute (withApprovalGate) stamp at the real effect boundary via the
  // ctx._markDispatched callback (approvalGate calls it immediately before
  // executeAction); unwrapped external tools are stamped here, immediately
  // before execute, which IS their adapter call.
  let _intentId = null;
  const _extEffect = !!(tool.externalEffect === true && tool.selfLedgers !== true);
  if (_extEffect) {
    if (!_executionLedgerDb) {
      return { success: false, error: `execution_ledger_unavailable: ${toolName} is an external-effect tool and cannot run without durable intent (fail-closed, C2 rule 1)` };
    }
    try {
      _intentId = _executionLedger.claim(_executionLedgerDb, {
        orgId: ctx.orgId || null,
        tool: toolName,
        actionDigest: (ctx._canonicalAction && ctx._canonicalAction.effect_id) || _executionLedger.actionDigest(input),
        corr: ctx.corr || ctx.session_id || ctx.sessionId || null,
      });
    } catch (e) {
      return { success: false, error: `execution_ledger_unavailable: durable intent claim failed for ${toolName}: ${e.message}` };
    }
    // WP4.1b: record the RECEIPT DEBT beside the intent — content-free snapshot
    // (ctx identifiers + canonical-action commitment) so a crash between execute
    // and the evidence emit leaves a durable 'owed' row the boot re-emit settles
    // without replaying the effect. Best-effort AFTER the claim: the claim is the
    // fail-closed gate; a missing obligation row degrades to the 4.2 reconciler's
    // completeness check, never blocks the action twice.
    try {
      let _obCommit = null;
      try { _obCommit = ctx._canonicalAction ? actionEvidenceCommitment(ctx._canonicalAction) : null; } catch { _obCommit = null; }
      _executionLedger.recordObligation(_executionLedgerDb, _intentId, {
        orgId: ctx.orgId || null,
        tool: toolName,
        corr: ctx.corr || ctx.session_id || ctx.sessionId || null,
        ctx: { agentId: ctx.agentId, userId: ctx.userId, orgId: ctx.orgId, evidenceSource: ctx.evidenceSource || 'choke' },
        actionCommit: _obCommit,
      });
    } catch (obErr) {
      console.warn(`[Tools] WP4.1b obligation record failed for ${toolName} (${_intentId}): ${obErr.message}`);
    }
    ctx._executionIntentId = _intentId;
    ctx._markDispatched = () => {
      try { _executionLedger.markDispatched(_executionLedgerDb, _intentId); } catch { /* stamp is best-effort once claimed */ }
    };
    if (tool.gatedInExecute !== true && tool._requiresApproval !== true) {
      // Unwrapped external tool: execute IS the adapter call.
      ctx._markDispatched();
    }
  }

  // QUOXTRUST D6/T9: capture outcome + duration so the choke emits ONE evidence
  // receipt on EVERY exit path (success, null-result, thrown), then return the
  // exact same value the pre-D6 code returned. Behaviour-preserving for callers.
  const _chokeT0 = Date.now();
  let _chokeResult;
  let _chokeSuccess = false;
  let _chokeError;
  let _chokeThrew = false;
  try {
    const result = await tool.execute(input, ctx);
    // Dispatcher hardening (tooling audit 2026-09-21): a tool that returns
    // null/undefined (e.g. skill_view on a 404) crashed the `result.success`
    // read below and the outer catch masked it. Normalise to an honest error.
    if (result == null) {
      console.warn(`[Tools] ${toolName} returned no result (null/undefined)`);
      _chokeError = `${toolName} returned no result`;
      _chokeResult = { success: false, error: _chokeError };
    } else if (result.success === false) {
      // errDetail may be a non-string (some tools return an object/array in
      // `error`). Coerce before slicing — a raw .substring() here THREW and the
      // outer catch then masked the tool's real error as
      // 'errDetail.substring is not a function' (tooling audit: skill_view, and
      // any tool with a non-string error). String() makes the log safe and lets
      // the tool's real result through untouched.
      const errDetail = result.error || result.stderr || '';
      _chokeError = String(typeof errDetail === 'string' ? errDetail : JSON.stringify(errDetail));
      console.warn(`[Tools] ${toolName} failed: ${_chokeError.substring(0, 300)}`);
      _chokeResult = result;
    } else {
      console.log(`[Tools] ${toolName} completed: success`);
      _chokeSuccess = true;
      _chokeResult = result;
    }
  } catch (err) {
    console.error(`[Tools] ${toolName} error:`, err.message);
    _chokeError = err.message;
    _chokeThrew = true;
    _chokeResult = { success: false, error: err.message };
  }

  // QUOXTRUST T3/C2 — settle the durable intent on EVERY exit path:
  //   awaiting_approval/pending return → rejected_before_dispatch (a card is a
  //     proposal, never a dispatch; if the dispatch stamp already landed, the
  //     gating was misclassified → outcome_unknown + loud warn, never a lie);
  //   thrown → outcome_unknown when dispatched (provider MAY have accepted; no
  //     blind retry), failed when still claimed (provably no effect);
  //   returned success:false → failed; success → confirmed.
  if (_intentId) {
    try {
      const _pendingReturn = !_chokeThrew && _chokeResult
        && (_chokeResult.pending === true || _chokeResult.status === 'awaiting_approval');
      if (_pendingReturn) {
        const settled = _executionLedger.rejectBeforeDispatch(_executionLedgerDb, _intentId, 'awaiting_approval');
        if (!settled) {
          console.warn(`[Tools] C2 MISCLASSIFIED GATING: ${toolName} returned awaiting_approval AFTER its dispatch stamp — flag it gatedInExecute. Settling outcome_unknown.`);
          _executionLedger.resolveThrow(_executionLedgerDb, _intentId, 'awaiting_approval_after_dispatch_stamp');
        }
      } else if (_chokeThrew) {
        _executionLedger.resolveThrow(_executionLedgerDb, _intentId, _chokeError);
      } else {
        _executionLedger.resolve(_executionLedgerDb, _intentId, _chokeSuccess, _chokeSuccess ? null : _chokeError);
      }
    } catch (settleErr) {
      console.warn(`[Tools] C2 intent settle failed for ${toolName} (${_intentId}): ${settleErr.message} — reconcileOnBoot will surface it`);
    }
  }
  _emitChokeToolEvidence(toolName, tool, input, ctx, Date.now() - _chokeT0, _chokeSuccess, _chokeError);
  // WP4.1b: the receipt debt is settled INSIDE emitToolEvidence (one owner),
  // keyed by ctx._executionIntentId — that covers this choke emit AND the
  // gold/dispatcher callers that emit their own evidence later. Unconfirmed
  // storage keeps the obligation 'owed' — visible on /health, re-emitted on
  // boot/tick.
  return _chokeResult;
}

// WP4.1b — the ONE owner of obligation settlement (called by
// toolEvidence.emitToolEvidence when storage of both mandatory channels is
// CONFIRMED). Exported so evidence emit sites outside this module (the
// server.js gold route) settle through the same fn. Idempotent (owed-only
// UPDATE); null ledger db is a no-op.
function settleObligationDelivered(intentId, envelopeId = null) {
  if (!_executionLedgerDb || !intentId) return;
  try { _executionLedger.markObligationDelivered(_executionLedgerDb, intentId, envelopeId); }
  catch { /* stays owed; boot re-emit / reconciler will surface it */ }
}

// ============================================================================
// Dynamic Entity Tool Loading
// ============================================================================

// ===== AUDITUS Compliance Tools (CRP-QXFY-2) =====
const { COMPLIANCE_TOOLS } = require('./complianceTools');
Object.assign(TOOL_DEFS, COMPLIANCE_TOOLS);

// ===== ROADY Roadmap Tools (ROADY-2) =====
const { ROADMAP_TOOLS } = require('./roadmapTools');
Object.assign(TOOL_DEFS, ROADMAP_TOOLS);

// ===== QuoxPlan Agent Tools (QUOXPLAN-P4) — separate dummy-data corpus,
// distinct from the live roadmap tools above. See lib/quoxplanTools.js. =====
const { QUOXPLAN_TOOLS } = require('./quoxplanTools');
Object.assign(TOOL_DEFS, QUOXPLAN_TOOLS);

// ===== QLarity Agent Tools (DEVSUITE-CLARIFY Phase 3 dogfood slice) — every
// call routes through the collector's OWN /api/v1/qlarity/* proxy (same
// governed-boundary discipline as quoxplanTools.js), never QLARITY_URL
// directly. See lib/qlarityTools.js for the real request shapes and the
// confirmed HITL enforcement on qlarity_eval. =====
const { QLARITY_TOOLS } = require('./qlarityTools');
Object.assign(TOOL_DEFS, QLARITY_TOOLS);

// ===== BOB Agent Tools (DEVSUITE-HUB Phase 4): build status/history, log
// tail (receipt message, honest about the raw-log gap), preflight blast
// radius, post-deploy verification (container alive + HTTP probe), and the
// HITL-gated build-outcome writer. Gripe filing is NOT a tool here — BOB
// gets the same 'github' connector family GRIPE has (see CONNECTOR_FAMILIES
// below) and calls github_create_issue directly. See lib/bobTools.js. =====
const { BOB_TOOLS } = require('./bobTools');
Object.assign(TOOL_DEFS, BOB_TOOLS);

// ===== LOOP-Q Agent Tools (QUOXIFY pass 1, DEVSUITE phase 14): the running
// loop is the one dev-suite domain that genuinely changes across turns, so
// it gets a conversational conductor. Reads go through the collector's own
// org-scoped dev-session routes; the halt is approval-gated with the same
// withApprovalGate helper bob_mark_build_outcome uses, because an agent must
// never be able to stop a governed loop on its own authority. See
// lib/loopTools.js. =====
const { LOOP_TOOLS } = require('./loopTools');
Object.assign(TOOL_DEFS, LOOP_TOOLS);

// ===== LUCID Agent Tools: read-only situation + item, in-process over
// lib/lucid. See lib/lucid/agentTools.js. =====
const { LUCID_TOOLS } = require('./lucid/agentTools');
Object.assign(TOOL_DEFS, LUCID_TOOLS);

// ===== QUOXON-PARITY lane E1 (#809, #810, #811): read-only parity with the CLI
// (ward verify/status, standing grants, safety status, memory history), scoped to
// ctx.orgId. See lib/parityReadTools.js. The WARD service is wired by server.js. =====
const { PARITY_READ_TOOLS, setParityReadDeps } = require('./parityReadTools');
Object.assign(TOOL_DEFS, PARITY_READ_TOOLS);
setParityReadDeps({ getVoltDb: () => _govVoltDb });

// ===== INBOXQ Agent Tools (INBOXQ_AGENT_DESIGN.md §A): every mutating tool
// terminates in the existing inboxq_proposals + requireHuman resolve path
// in-process (calls lib/inboxq/api.js's exported _handlers directly, same
// process, same org resolution, same audit shape as the REST surface) —
// never a new execution route. See lib/inboxqTools.js. =====
const { INBOXQ_TOOLS } = require('./inboxqTools');
Object.assign(TOOL_DEFS, INBOXQ_TOOLS);

// ===== NOTESQ Agent Tools: in-process over the shared notesqCall boundary
// (lib/notesq/call.js), the same one the governed HTTP routes use. See
// lib/notesqTools.js. =====
const { NOTESQ_TOOLS } = require('./notesqTools');
Object.assign(TOOL_DEFS, NOTESQ_TOOLS);

// Research tools (web_search, web_read) and the NotesQ to SCHOLAR handoff
// (notesq_research). Defined in lib/researchTools.js.
Object.assign(TOOL_DEFS, require('./researchTools').createResearchTools({ getToolDefs: () => TOOL_DEFS, getProviderKeys: (orgId) => providerKeysLib.getProviderKeys(orgId, { resolveCredentials: _resolveVaultProviderCredentials }) }));

// ===== CALENDAR-Q Agent Tools (L2-C1 U4): read-only tool surface over the
// Calendar-Q agenda/coverage/changes read path, in-process (calls
// lib/calendarq/agenda.js and lib/calendarq/store.js directly, same process,
// same org resolution). No write/propose tool exists yet — see
// lib/calendarqTools.js's module doc comment. =====
const { CALENDARQ_TOOLS } = require('./calendarqTools');
Object.assign(TOOL_DEFS, CALENDARQ_TOOLS);

// ===== QUOXON-REACH lane G: read-only tools for domains that had a CLI but no agent
// tool (plugins, spend, identity, install). plugin_list replaces the REGULA 501 stub
// with the real org plugin registry read. Org from ctx.orgId, the caller's own bearer,
// never a credential value. See lib/reachReadTools.js. =====
const { REACH_READ_TOOLS } = require('./reachReadTools');
Object.assign(TOOL_DEFS, REACH_READ_TOOLS);

// ===== QUOXON-ASK lane J: quox_cli (read leaves) and quox_cli_write (write leaves,
// approval-gated) run any real quox CLI leaf as the caller: validated against the CLI's
// own command tree, classed by the leaf policy, caller bearer and org only, capped,
// redacted and witnessed. See lib/quoxCliTools.js. =====
const { QUOX_CLI_TOOLS } = require('./quoxCliTools');
Object.assign(TOOL_DEFS, QUOX_CLI_TOOLS);

// ===== QUOXON-PROOF lane I: llm_status/llm_policy (quox#822), backup_overview (#823),
// live_sessions (#824), prompt_list/prompt_read (#825). Read-only. See
// lib/quoxonProofReadTools.js. =====
const { QUOXON_PROOF_READ_TOOLS } = require('./quoxonProofReadTools');
Object.assign(TOOL_DEFS, QUOXON_PROOF_READ_TOOLS);

// ===== CONTACTSQ Agent Tools (P0): contacts_resolve + contacts_find, in-process
// over the shared service lib/contactsq/api.js (the same one the governed HTTP
// routes use). Card/Greeting projections only, never a raw identifier. See
// lib/contactsqTools.js. =====
const { CONTACTSQ_TOOLS } = require('./contactsqTools');
Object.assign(TOOL_DEFS, CONTACTSQ_TOOLS);
// contacts_send: durable-intent ledger + the same notification path send_notification uses.
require('./contactsqTools').setContactsqSendRuntime({
  getLedger: () => (_executionLedgerDb ? { db: _executionLedgerDb, ledger: _executionLedger } : null),
});

// ===== roster_coverage (LOOP-CONVERGENCE P4): QUARTERMASTER's view of the
// agent roster's tool coverage. Defined here (not in a separate ROSTER_TOOLS
// file) because its execute() closes over getToolsForAgent + AGENT_TOOLS, which
// live in this module. Both are in scope at eval time (function declaration is
// hoisted; AGENT_TOOLS is a const defined far above). Pure banding/report logic
// is in ./rosterCoverage for unit tests. =====
const { buildRosterReport } = require('./rosterCoverage');
TOOL_DEFS.roster_coverage = {
  name: 'roster_coverage',
  description: "Report the agent roster's tool coverage: per-agent resolved tool count, band (thin <5, healthy 5-15, bloated >15 per the owner doctrine), and advice. Bloated agents are flagged as candidates to move open-ended work onto a witnessed loop rather than a wider grant; agents thin BY DESIGN (e.g. qloop, a loop's authoring identity) are not nagged. Read-only. Use it to answer 'which agents are under- or over-equipped'.",
  input_schema: {
    type: 'object',
    properties: {
      band: { type: 'string', enum: ['thin', 'healthy', 'bloated', 'all'], description: "Filter to one band, or 'all' (default)." },
    },
    required: [],
  },
  execute: async (input, ctx) => {
    const rows = Object.keys(AGENT_TOOLS).map((id) => ({
      agent: id,
      count: getToolsForAgent(id, ctx).length,
    }));
    return buildRosterReport({ rows, band: input && input.band });
  },
};

// ===== QuoxSlots Tools (QUOXIFY pass 2, DEVSUITE phase 15). Slots is
// deliberately a FEATURE, not an agent (owner, note #2843): it is an
// addressing primitive, not a domain to reason over. So it gets tools and no
// persona. Pool curation is approval-gated because the slot routes' admin
// gate ALLOWS service-key callers, and these tools are service-key callers:
// without the gate every agent would silently hold org-admin over the pool.
// See lib/slotTools.js. =====
const { SLOT_TOOLS } = require('./slotTools');
Object.assign(TOOL_DEFS, SLOT_TOOLS);

// ===== QUOX-SECURITY Engagement Tools (Phase 1): engagement/scope CRUD
// and the policy gate, wraps lib/securityEngagement.js directly (in-process,
// not an HTTP proxy like quoxplanTools.js). See lib/securityEngagementTools.js. =====
const { SECURITY_ENGAGEMENT_TOOLS } = require('./securityEngagementTools');
Object.assign(TOOL_DEFS, SECURITY_ENGAGEMENT_TOOLS);

// ===== QUOX-SECURITY Capability Tools (Phase 1): the first 3 real
// capability tools the plan names for Core (subfinder/httpx/nuclei), gated
// by checkEngagementPolicy before any bastion call. No SECURITY_SCAN_HOST
// exists tonight, an approved call honestly errors "not configured" rather
// than faking a scan. See lib/securityCapabilityTools.js. =====
const { SECURITY_CAPABILITY_TOOLS, executeSecurityCapabilityTool } = require('./securityCapabilityTools');
// QUOXON-ADV: the capability defs are schema-only (name/schema/cli/buildInput). Merged bare, every
// agent call failed with "tool.execute is not a function". Route each through the same
// engagement-gated runner the REST route uses (policy gate first, then the bastion grant).
for (const [key, def] of Object.entries(SECURITY_CAPABILITY_TOOLS)) {
  TOOL_DEFS[key] = { ...def, execute: (input, ctx) => executeSecurityCapabilityTool(key, input, ctx || {}) };
}

// ===== QUOX-SECURITY Findings Tools (Phase 1, continued): candidate
// findings + adversarial verification, closes the "no findings storage"
// gap. See lib/securityFindingsTools.js. =====
const { SECURITY_FINDINGS_TOOLS } = require('./securityFindingsTools');
Object.assign(TOOL_DEFS, SECURITY_FINDINGS_TOOLS);

// ===== Discord Pro Agent Tools (QDIS-CONCIERGE): CONCIERGE's read/write
// access to the Discord Pro daemon, every call routed through the
// collector's OWN /api/discord-pro/* proxy (same governed-boundary
// discipline as quoxplanTools.js), never a second path to the daemon.
// discord_bind_channel/discord_unbind_channel are HITL-gated via
// withApprovalGate — see AGENT_GATED_TOOLS['concierge'] in approvalGate.js.
// See lib/discordProTools.js. =====
const { DISCORD_PRO_TOOLS } = require('./discordProTools');
Object.assign(TOOL_DEFS, DISCORD_PRO_TOOLS);

// ===== X (Twitter) Agent Tools (X-PLUGIN P2): x_post/x_thread/x_delete are
// natively registered here (not the connector bridge — connectors/types/
// twitter.js stays read-only, see its header comment) because they need the
// HITL inbox-card gate, which the bridge has no concept of. Each tool files
// an HITL Inbox approval and returns immediately; the actual X API write only
// happens on owner approval via server.js's
// POST /api/internal/x/approvals/decide -> xTools.handleApprovalDecide. See
// lib/xTools.js. =====
const { X_TOOLS } = require('./xTools');
Object.assign(TOOL_DEFS, X_TOOLS);

// ===== CommanderQ Reachability Tools (COMMANDERQ-P2, read-only): AGH-Chain
// leaderboard, NOC tool-outcome telemetry, DoneEngine readiness snapshots,
// QuoxLens findings/lenses, GRC compliance artifacts, governance policy
// state — every call self-fetches the collector's OWN routes on loopback
// (same governed-boundary discipline as quoxplanTools.js). See
// lib/commanderqReachTools.js. =====
const { COMMANDERQ_REACH_TOOLS } = require('./commanderqReachTools');
Object.assign(TOOL_DEFS, COMMANDERQ_REACH_TOOLS);

// ===== CommanderQ Write Tools (COMMANDERQ-P2, write — governance-gated):
// QuoxLens accept-risk/apply, GRC compliance create/update, governance
// policy propose/change. Every discipline (direct/gated/propose-only/
// server-staged) is documented per tool in lib/commanderqWriteTools.js —
// read that header before adding to or "simplifying" this list. =====
const { COMMANDERQ_WRITE_TOOLS } = require('./commanderqWriteTools');
Object.assign(TOOL_DEFS, COMMANDERQ_WRITE_TOOLS);

// ===== CommanderQ Plan tools (COMMANDERQ-P5, Plan-as-Artifact): create/get/
// diff SIGNED plan artifacts on the P4 signed-artifact spine. Approve-once
// (ONE HITL card per plan, filed by the route — never self-approved) +
// deviation-gated (diff re-files approval when a gated plan deviates). Thin
// self-fetch wrappers over /api/v1/artifacts/plan; see lib/commanderqPlanTools.js. =====
const { COMMANDERQ_PLAN_TOOLS } = require('./commanderqPlanTools');
Object.assign(TOOL_DEFS, COMMANDERQ_PLAN_TOOLS);

// ===== CommanderQ Commitment tools (COMMANDERQ-P8, commitment ledger): record
// a promise as a signed governed object, list open/overdue, resolve
// (fulfilled/escalated/cancelled; escalation files a human card). Self-fetch
// wrappers over /api/v1/commitments; see lib/commanderqCommitmentTools.js. =====
const { COMMANDERQ_COMMITMENT_TOOLS } = require('./commanderqCommitmentTools');
Object.assign(TOOL_DEFS, COMMANDERQ_COMMITMENT_TOOLS);

// ===== CommanderQ calibration self-audit tool (COMMANDERQ-P11/B3): read-only
// honesty-calibration report from P3's per-turn grounding counts. =====
const { COMMANDERQ_CALIBRATION_TOOL } = require('./commanderqCalibrationTool');
Object.assign(TOOL_DEFS, COMMANDERQ_CALIBRATION_TOOL);

// COMMANDERQ P7 (B1+B2): outcome-learned routing advisory tool.
const { COMMANDERQ_ROUTING_TOOL } = require('./commanderqRoutingTool');
Object.assign(TOOL_DEFS, COMMANDERQ_ROUTING_TOOL);

// COMMANDERQ P9 (C1+C3): contactability check + propose-only consent/watch tools.
const { COMMANDERQ_CONTACTABILITY_TOOLS } = require('./commanderqContactabilityTool');
Object.assign(TOOL_DEFS, COMMANDERQ_CONTACTABILITY_TOOLS);

// COMMANDERQ P10 (F1+F3): governed outbound-call tools (deny-by-default intent + signed summary).
const { COMMANDERQ_CALL_TOOLS } = require('./commanderqCallTool');
Object.assign(TOOL_DEFS, COMMANDERQ_CALL_TOOLS);

const { loadEntityTools, refreshEntityToolLicenses } = require('./entityToolLoader');
const { loadAssistants, getAssistantPrompt, getAssistant, listAssistants } = require('./entityAssistantLoader');
// #818: agent_directory reads the same registry the roster uses (lib/parityReadTools.js).
setParityReadDeps({ listAgents: () => listAssistants(), getAgent: (id) => getAssistant(id), getAgentTools: (id) => [...(AGENT_TOOLS[canonicalAgentId(id)] || [])] });
const _fs = require('fs');
const _entityToolsPathDev = require('path').join(__dirname, '../../../src/config/entities/tools');
const _entityToolsPathDocker = '/app/entity-tools';
const entityToolsPath = _fs.existsSync(_entityToolsPathDocker) ? _entityToolsPathDocker : _entityToolsPathDev;
const _entityLoadResult = loadEntityTools(entityToolsPath, TOOL_DEFS, AGENT_TOOLS, {
  callBastion
});
const TOOL_ENTITY_META = _entityLoadResult.metadata;
console.log(`[Tools] Loaded ${_entityLoadResult.loaded} entity tools (${_entityLoadResult.skipped} skipped, ${_entityLoadResult.gated} license-gated)`);

// AGENT-OVERHAUL-2 FIX 3 — entity licence gating now consults the real
// lease, not LICENSED_PLUGINS env alone. Module init above stayed
// synchronous (loadEntityTools cannot await a network call), so it used
// whatever LICENSED_PLUGINS/lease cache was already known (cold boot =
// env fallback, same behaviour as before this fix). This fire-and-forget
// call resolves the real lease from auth and, for any plugin that upgrades
// from unlicensed-at-boot to licensed-via-lease, re-runs loadEntityTools
// against the SAME TOOL_DEFS/AGENT_TOOLS so those tools stop being
// permanently gated for the life of the process.
refreshEntityToolLicenses(entityToolsPath, TOOL_DEFS, AGENT_TOOLS, { callBastion })
  .then(({ resolved, upgraded }) => {
    if (resolved > 0) {
      console.log(`[Tools] Entity licence lease refresh resolved ${resolved} plugin(s)${upgraded.length ? `, upgraded: ${upgraded.join(', ')}` : ''}`);
    }
  })
  .catch(err => {
    console.warn('[Tools] Entity licence lease refresh failed (non-fatal, env fallback stays in effect):', err.message);
  });

// CONNFAC Phase 0 — connector namespace guard. parseConnectorTool() prefix-matches
// `<connectorId>_` BEFORE any TOOL_DEFS lookup and returns unconditionally, so a
// connector id that prefixes a static tool name hijacks it: the call routes to the
// connector bridge and the static implementation never runs. Run after every
// TOOL_DEFS assignment (including entity tools) so the whole surface is checked.
// WARN/ERROR, not throw: known-benign collisions already exist in the live
// registry (justified per-entry in lib/connectors/knownCollisions.json), so
// throwing here would stop the module loading at all. Known entries get one
// summary warn; anything UNEXPECTED or STALE logs loudly here and fails
// test/connectorNamespace.test.js, which is the gate that blocks a commit.
{
  const { classifyNamespaceCollisions } = require('./connectors/registry');
  const { known, unexpected, stale } = classifyNamespaceCollisions(Object.keys(TOOL_DEFS));
  if (known.length) {
    console.warn(`[Connectors] ${known.length} known-benign namespace collisions (exact static match wins; justified in lib/connectors/knownCollisions.json)`);
  }
  for (const collision of [...unexpected, ...stale]) {
    console.error(`[Connectors] NAMESPACE COLLISION (unexpected — rename the connector tool or justify it in knownCollisions.json): ${collision}`);
  }
}

// Load assistant entity definitions (system prompts, rules, personality)
const _entityAssistantsPathDev = require('path').join(__dirname, '../../../src/config/entities/assistants');
const _entityAssistantsPathDocker = '/app/entity-assistants';
const assistantsPath = _fs.existsSync(_entityAssistantsPathDocker) ? _entityAssistantsPathDocker : _entityAssistantsPathDev;
const _assistantCount = loadAssistants(assistantsPath);
console.log(`[Tools] Loaded ${_assistantCount} assistant entities`);

// ===== TRUST-GATE 1.18b: cognitive implant registry (no hardcoded lists) =====
// The `execution_intelligence` mirror_index/implant_detail actions used to
// hardcode the agent roster and implant list as literal strings, which drift
// from the real registries the dashboard renders from. Both now load
// src/config/cognitiveImplants.js — the same COGNITIVE_IMPLANTS config the
// dashboard's mirrorIndex.js and reflectionService.js consume — so a real
// registry change (new implant, renamed implant) shows up here too.
const { pathToFileURL: _pathToFileURL } = require('url');
let _cognitiveImplantsPathOverride = null;
let _cognitiveImplantsCache = null;

function _resolveCognitiveImplantsPath() {
  if (_cognitiveImplantsPathOverride) return _cognitiveImplantsPathOverride;
  const dockerPath = '/app/src/config/cognitiveImplants.js';
  if (_fs.existsSync(dockerPath)) return dockerPath;
  return require('path').join(__dirname, '../../../src/config/cognitiveImplants.js');
}

/**
 * Load COGNITIVE_IMPLANTS from the canonical config module. Cached after
 * first successful load. Test-only override lets tests point at a fixture
 * file without touching the real registry.
 */
async function loadCognitiveImplants() {
  if (_cognitiveImplantsCache) return _cognitiveImplantsCache;
  try {
    const filePath = _resolveCognitiveImplantsPath();
    const mod = await import(_pathToFileURL(filePath).href);
    _cognitiveImplantsCache = mod.COGNITIVE_IMPLANTS || {};
  } catch (err) {
    console.warn('[Tools] Failed to load cognitiveImplants registry:', err.message);
    _cognitiveImplantsCache = {};
  }
  return _cognitiveImplantsCache;
}

/**
 * Test-only: point the loader at a fixture file and clear the cache so the
 * next loadCognitiveImplants() call re-reads it. Pass null to reset.
 */
function __setCognitiveImplantsPathForTesting(filePath) {
  _cognitiveImplantsPathOverride = filePath;
  _cognitiveImplantsCache = null;
}

/**
 * Get Anthropic tool definitions including dynamic connector tools.
 * Merges hardcoded agent tools with connector tools that have vault credentials.
 */
// opts.meta (optional): filled with the connector tool-list cache state and
// build time, { cache: 'hit'|'miss'|'shared'|'stale'|'none', ms }, for the
// per-turn timing log (QUOXON A2). 'none' = this agent has no connector families.
async function getToolsWithConnectors(agentId, orgId, opts = {}) {
  const coreTools = await getToolsForAgentAsync(agentId);

  // AGENT-OVERHAUL-2 FIX 1 — only merge connector tools from families this
  // agent is scoped to (see CONNECTOR_FAMILIES). An agent with no scoped
  // families (the default) gets no connector tools at all.
  const allowedFamilies = getConnectorFamiliesForAgent(agentId);
  const meta = opts && typeof opts.meta === 'object' && opts.meta ? opts.meta : null;
  if (allowedFamilies.length === 0) {
    if (meta) { meta.cache = 'none'; meta.ms = 0; }
    return coreTools;
  }

  try {
    const connectorToolDefs = await getConnectorTools(orgId || 'default', meta ? { meta } : undefined);
    let scoped = connectorToolDefs.filter(t => allowedFamilies.includes(t.connector));
    // SEC-AUDIT (2026-08-11) S2 — narrow within the granted family/families
    // when this agent has a CONNECTOR_TOOL_ALLOWLIST entry (e.g. bob/gripe:
    // github_create_issue only, never github_update_issue/rerun_workflow/
    // create_release). No entry = no narrowing, unchanged behavior.
    const toolAllowlist = getConnectorToolAllowlistForAgent(agentId);
    if (toolAllowlist) {
      scoped = scoped.filter(t => toolAllowlist.includes(t.name));
    }
    if (scoped.length > 0) {
      console.log(`[Tools] Adding ${scoped.length}/${connectorToolDefs.length} connector tools for agent=${agentId} org=${orgId} (families=${allowedFamilies.join(',')})`);
      const mapped = scoped.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
        entity: false,
        provider: `connector:${t.connector}`,
      }));
      return [...coreTools, ...mapped];
    }
  } catch (err) {
    console.warn('[Tools] Connector tool loading failed (non-fatal):', err.message);
  }

  return coreTools;
}

/**
 * Returns { agentId, tools: [{ name, description }] } for a given agentId,
 * or null if the agentId is not registered in AGENT_TOOLS.
 *
 * Used by GET /collector/agents/:agentId/tools — provides a name+description
 * catalog suitable for injecting into DAEDALUS's system prompt so she can wire
 * agent:agentic nodes with realistic tool lists.
 *
 * @param {string} agentId
 * @returns {{ agentId: string, tools: Array<{ name: string, description: string }> } | null}
 */
function getToolsForAgentCatalog(agentId, ctx) {
  const agentKey = (agentId || '').toLowerCase();
  if (!agentKey || !AGENT_TOOLS[agentKey]) return null;
  const orgId = ctx?.orgId || '__global__';
  const tools = AGENT_TOOLS[agentKey]
    .map(name => getToolDef(name, orgId))
    .filter(Boolean)
    .map(t => ({ name: t.name, description: t.description }));
  return { agentId: agentKey, tools };
}

/**
 * Returns a map of { [agentId]: [{ name, description }] } for every agent
 * registered in AGENT_TOOLS.
 *
 * Used by GET /collector/agents/tools/batch — eliminates the N+1 per-agent
 * requests fired by the workflow builder on mount.
 *
 * @returns {Object.<string, Array<{ name: string, description: string }>>}
 */
function getAllAgentToolCatalogs(ctx) {
  const orgId = ctx?.orgId || '__global__';
  const result = {};
  for (const agentKey of Object.keys(AGENT_TOOLS)) {
    const tools = AGENT_TOOLS[agentKey]
      .map(name => getToolDef(name, orgId))
      .filter(Boolean)
      .map(t => ({ name: t.name, description: t.description }));
    result[agentKey] = tools;
  }
  return result;
}

/**
 * Filter a resolved tools array by a surface-specific denylist.
 * Defensive: returns tools unchanged when denylist is absent, empty, or malformed.
 *
 * @param {object[]} tools   - Array of tool definition objects (each with a .name property)
 * @param {string[]} denylist - Tool names to exclude
 * @returns {object[]}
 */
function filterToolsByDenylist(tools, denylist) {
  if (!Array.isArray(denylist) || denylist.length === 0) return tools;
  return tools.filter(t => !denylist.includes(t.name));
}

// QUOXON-FW3: agents whose static grant includes a tool (excluding the caller).
function holdersOfTool(toolName, callerId) {
  const me = String(callerId || '').toLowerCase();
  return Object.keys(AGENT_TOOLS).filter(
    (a) => a.toLowerCase() !== me && Array.isArray(AGENT_TOOLS[a]) && AGENT_TOOLS[a].includes(toolName),
  );
}
function describeHolders(ids) {
  if (!ids.length) return 'No agent holds it, so it cannot be delegated; tell the user it is unavailable.';
  let getAssistant = null;
  try { ({ getAssistant } = require('./entityAssistantLoader')); } catch { /* names optional */ }
  const shown = ids.slice(0, 8).map((id) => {
    let name = null;
    try { name = getAssistant && getAssistant(id)?.identity?.name; } catch { /* ignore */ }
    return name && name !== id ? `${id} (${name})` : id;
  });
  return `Delegate to: ${shown.join(', ')}${ids.length > 8 ? `, and ${ids.length - 8} more` : ''}.`;
}

module.exports = {
  brainHolderCtx,
  readResultFields,
  getToolsForAgent,
  getToolsForAgentAsync,
  resolveHostId, // fleet standing-grant check resolves host the same way ssh_exec does
  makeGrantAwareCallBastion, // QUOXTRUST T4 — exported for unit test
  summarizeToolInputForLog, // QUOXTRUST v1.4 CF1 — exported for the redaction pin

  getAccessModeForAgentTool,
  getToolsWithConnectors,
  getToolsForAgentCatalog,
  getAllAgentToolCatalogs,
  getToolDef,
  executeTool,
  resolveCredentialForAgent,
  parseConnectorTool,
  invalidateAgentToolCache,
  getFleetStatusLocal,
  TOOL_DEFS,
  AGENT_TOOLS,
  CONNECTOR_FAMILIES,
  getConnectorFamiliesForAgent,
  CONNECTOR_TOOL_ALLOWLIST,
  getConnectorToolAllowlistForAgent,
  MEMORY_TOOLS,
  SKILL_TOOLS,
  ACTION_TOOLS,
  KNOWLEDGE_TOOLS,
  GOVERNANCE_TOOLS, // QUOXHAT P-A — the narrow universal governance grant
  TIER0_READ_TOOLS, // QUOXHAT MISSION D1 — the narrow universal self-read floor
  canonicalAgentId, // QUOXHAT MISSION D1.4 — commanderq -> quox id canonicalisation
  aliasAgentId,     // QUOXHAT MISSION D1.5 — narrow case-preserving alias for entry points

  TOOL_ENTITY_META,
  memorySystemPrompt,
  actionSystemPrompt,
  isMemoryTool,
  isActionTool,
  getAssistantPrompt,
  getAssistant,
  listAssistants,
  loadAssistants,
  setGovDatabase,
  setPowersVoltEmitter,
  setAuditEmitter,
  settleObligationDelivered,
  filterToolsByDenylist,
  loadCognitiveImplants,
  __setCognitiveImplantsPathForTesting,
  __setImapFlowForTesting,
  __setInboxqAccountsLookupForTesting,
  __setSimpleParserForTesting,
  __setNodemailerForTesting,
  setExecutionLedger,
  __setSshClientForTesting,
  __setPgClientForTesting,
  __setGripeFeedLogForTesting,
  AGENT_REQUIRES_PLUGIN,
  getRequiredPluginForAgent,
  __setLicenseGateForTesting,
};
