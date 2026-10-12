/**
 * Approval Gate
 *
 * Server-side module that checks QuoxFlow policy engine before executing
 * destructive operations. When a policy requires approval, creates an
 * approval request and returns a pending status to the caller.
 *
 * Used by native tool executors (e.g., proxmox_vm_action) when
 * QUOXFLOW_APPROVAL_ENABLED=true.
 */

const crypto = require('crypto');

const QUOXFLOW_URL = process.env.QUOXFLOW_URL || 'http://localhost:3200';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101';

// GOV-4: Policy store integration
const { listPolicies } = require('./policyStore.js');
const { mintInboxItem } = require('./inboxMint.js');
const { buildApprovalContext, buildContextTitle, renderContextMarkdown } = require('./approvalContext.js');
const { resolveUserDisplayName } = require('./userDisplayName.js');
const approvalTurnContext = require('./approvalTurnContext.js');
const { evaluateCondition, buildToolContext } = require('./conditionEvaluator.js');

// BLAST-RADIUS-P3: lazy reach resolution for policy gating — only pulled in
// when a policy's condition tree actually references reach.* (see
// policiesReferenceReach below), via the same cached/witnessed runtime path
// the reach_agent tool and the GET route use.
const { getCachedStaticReach } = require('./reach/runtime.js');

// Phase 25: QUOXFLOW_APPROVAL_ENABLED now reads through the org-scoped
// settings resolver instead of a module-load-time env const, so an org
// admin's override (Settings > Execution Policy) takes effect on the very
// next tool call — no restart needed. _voltDb (set via setDatabase below)
// doubles as the platform settings store.
const platformSettingsStore = require('./platformSettingsStore.js');
function isApprovalEnabled(orgId) {
  return platformSettingsStore.getEffectiveFlag(_voltDb, orgId || null, 'QUOXFLOW_APPROVAL_ENABLED').on;
}

// HITL approve→execute bridge — durable resumable-approval store (see
// toolApprovalStore.js header for the full flow + resume_token security model).
const directRequestRegistry = require('./directRequestRegistry.js');
const toolApprovalStore = require('./toolApprovalStore.js');

// P0b (QUOXPERTICUS DEC-1 + DEC-4): whole-instance sandbox grant (disposable
// flag AND an unexpired test-approver lease), read server-side from the auth
// service, plus the synthetic principal the collector performs sandbox
// resolutions as. See the checkApproval agent gate below for their only use.
const { hasActiveSandboxApprovalGrant } = require('./disposableTestInstance.js');
const { TEST_APPROVER_PRINCIPAL, annotateTestApproval } = require('./testApprover.js');

// Reference to voltDb — set by server.js during init
let _voltDb = null;
function setDatabase(db) { _voltDb = db; }

// QUOX-SECURITY Phase 0: reference to the security.db connection, set by
// server.js during init (mirrors _voltDb/setDatabase above). Kept as a
// separate setter rather than overloading setDatabase so a caller can wire
// one without the other (e.g. tests exercising only the engagement gate).
let _securityDb = null;
function setSecurityDb(db) { _securityDb = db; }

// BLAST-RADIUS-P1: injectable blast-radius evaluator, same DI shape as
// actionToolHandlers.js's setAuditFn — a module-level slot, wired once by
// server.js at boot, defaulting to null (feature is dark until wired).
// Signature: ({ toolName, input, agentId, orgId }) => Promise<ActionRadius>
// (see lib/reach/actionRadius.js computeActionRadius, which never throws —
// this DI slot is caught around anyway, belt-and-braces).
let reachEvaluator = null;
function setReachEvaluator(fn) { reachEvaluator = (typeof fn === 'function') ? fn : null; }

/** REACH_BANDS_ON_APPROVALS resolved the same way isApprovalEnabled resolves
 * QUOXFLOW_APPROVAL_ENABLED above: stored org override > env > registry
 * default (platformCapabilities.js). It's an 'on'/'off' enum, not a
 * boolean, so the gate reads .value rather than .on — resolveEffectiveCapability's
 * .on means "differs from default" for enum types, not "is enabled". */
function isReachBandsEnabled(orgId) {
  return platformSettingsStore.getEffectiveFlag(_voltDb, orgId || null, 'REACH_BANDS_ON_APPROVALS').value === 'on';
}

/**
 * Render a computed ActionRadius (lib/reach/actionRadius.js) into the short
 * markdown block appended to an approval's body_md. Kept under ~6 lines;
 * empty sections are omitted rather than shown blank.
 */
function buildReachMarkdown(reach) {
  if (!reach) return '';
  if (reach.status === 'unavailable') {
    return `\n\n💥 Reach: unavailable (${reach.error || 'reason unknown'})`;
  }
  const lines = [`💥 Reach: ${(reach.badge && reach.badge.level) || 'unknown'}`];
  if (Array.isArray(reach.requests) && reach.requests.length > 0) {
    lines.push(`Requests: ${reach.requests.map((r) => `${r.kind}:${r.id}`).join(', ')}`);
  }
  if (reach.may) {
    lines.push(`May touch: ${reach.may.credentials || 0} creds, ${reach.may.hosts || 0} hosts, ${reach.may.egress || 0} origins, ${reach.may.delegates || 0} delegates`);
  }
  if (Array.isArray(reach.unknown) && reach.unknown.length > 0) {
    const zones = reach.unknown.map((u) => u && u.zone).filter(Boolean);
    if (zones.length > 0) lines.push(`Unknown: ${zones.join(', ')}`);
  }
  return `\n\n${lines.join('\n')}\n`;
}

/**
 * Make authenticated request to QuoxFlow API.
 * Uses INTERNAL_SERVICE_KEY for service-to-service auth. When orgId is
 * available (the org context the approval gate is operating under), it is
 * forwarded as X-Org-Id so quoxflow scopes the read/write to that tenant
 * instead of falling back to system scope.
 */
async function quoxflowFetch(endpoint, options = {}, orgId = null) {
  const url = `${QUOXFLOW_URL}/api${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {}),
    ...(orgId ? { 'X-Org-Id': orgId } : {}),
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.warn(`[ApprovalGate] QuoxFlow API ${response.status} on ${endpoint}: ${body.substring(0, 200)}`);
    throw new Error(`QuoxFlow API ${response.status}: ${body.substring(0, 200)}`);
  }

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  // QuoxFlow wraps successful responses as { success, data, meta }. Unwrap to the
  // payload so callers read fields directly (approval.id, approval.status, ...).
  // Without this, createApprovalRequest saw approval.id === undefined and silently
  // skipped putPending + the reactions-as-HITL proposal post (the whole point).
  if (parsed && typeof parsed === 'object' && parsed.data !== undefined && ('success' in parsed || 'meta' in parsed)) {
    return parsed.data;
  }
  return parsed;
}

/**
 * Destructive actions that require approval checks.
 * Safe actions (start, resume, status) skip the gate entirely.
 */
const DESTRUCTIVE_ACTIONS = new Set(['stop', 'reboot', 'shutdown', 'remove', 'delete', 'kill']);

// SEC (2026-08-11): approval-input binding. withApprovalGate previously
// bound an approval to nothing but its id — neither execution path
// (resume-token verified, or legacy `_approvalId`-only) ever compared the
// input a human approved against the input actually being executed. A
// caller could get one input approved, then replay the same approvalId with
// a DIFFERENT input and have it execute unchecked (classic approval
// TOCTOU/replay). The fix: fingerprint the tool input at proposal time
// (persisted implicitly via toolApprovalStore's input_json, no schema
// change needed) and require the fingerprint of the input at execution time
// to match, on BOTH paths in withApprovalGate below.
//
// Control fields are stripped before fingerprinting — they carry the
// approval grant itself (or, for `_resolvedApiKey`, an unrelated
// runtime-injected value — see geminiImageExecutor.js), never part of the
// action a human evaluated, and are added/removed by callers between the
// proposal and the resume (toolResume.js strips them at persist time and
// re-adds them at replay time). Stripped generically by leading underscore
// so any future control field added by a caller is covered without another
// audit of this file.
function stripControlFields(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of Object.keys(input)) {
    if (key.startsWith('_')) continue;
    out[key] = input[key];
  }
  return out;
}

/**
 * Recursively produce a plain-data clone whose object keys are sorted, so
 * that two objects that are deep-equal but were built with different key
 * insertion order serialise identically. Arrays keep their order (order is
 * meaningful there — e.g. a PR's `files` list). A naive JSON.stringify is
 * key-order-dependent for objects and would let a semantically-identical
 * input dodge the fingerprint check just by reordering keys.
 */
function canonicalizeForFingerprint(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForFingerprint);
  }
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalizeForFingerprint(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Stable sha256 fingerprint of a tool input, excluding control fields.
 * Exported for tests.
 */
function computeInputFingerprint(input) {
  const stripped = stripControlFields(input);
  const canonical = canonicalizeForFingerprint(stripped);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Look up the stored (proposal-time) input for an approval and compute its
 * fingerprint, deriving from toolApprovalStore's already-persisted
 * input_json rather than a new column (see the SEC comment above
 * DESTRUCTIVE_ACTIONS). Fails closed: any missing row, missing input_json,
 * or unparseable JSON returns ok:false rather than a fingerprint, so callers
 * must refuse execution instead of treating "we couldn't tell" as a match.
 */
function getStoredInputFingerprint(approvalId) {
  const row = toolApprovalStore.getByApprovalId(approvalId);
  if (!row || !row.input_json) {
    return { ok: false, reason: 'no_stored_input' };
  }
  let parsed;
  try {
    parsed = JSON.parse(row.input_json);
  } catch {
    return { ok: false, reason: 'unparseable_stored_input' };
  }
  return { ok: true, fingerprint: computeInputFingerprint(parsed), row };
}

/**
 * Shared refusal shape for both withApprovalGate execution paths when the
 * current input does not match (or cannot be verified against) what was
 * approved. Logged via console.warn so a replay attempt is visible in
 * collector logs, not just swallowed into a generic error response.
 */
function inputMismatchResult(toolName, approvalId, reason) {
  console.warn(
    `[ApprovalGate] Refusing execution for approval ${approvalId} (tool ${toolName}): ${reason}. ` +
    `The input being executed does not verifiably match the input that was approved.`
  );
  return {
    success: false,
    error: 'Approved input does not match the input being executed; approval cannot be reused for a different action.',
    _approval: { id: approvalId, status: 'input_mismatch' },
  };
}

/**
 * A grant is bound to the exact tool and org it was issued for. The input
 * fingerprint alone is not enough: two different tools can accept an
 * identically shaped input, and a grant minted for one org must never
 * authorise a call made in another. Given the stored row (from
 * getStoredInputFingerprint) and the current call, return a refusal result if
 * the tool or org does not match, or null when the binding holds. Fails closed
 * only on a real mismatch; a row that simply does not record a tool_name/org_id
 * (older rows) is not rejected on that field alone.
 */
function grantBindingMismatch(row, toolName, ctx, approvalId) {
  if (row && row.tool_name && row.tool_name !== toolName) {
    return inputMismatchResult(
      toolName,
      approvalId,
      `approval was issued for tool '${row.tool_name}', not '${toolName}'`
    );
  }
  // quox#670: fail CLOSED. A row with no org used to skip this check
  // entirely; with a caller org in play, anything not bound to THAT org is a
  // mismatch. (Live data 2026-10-03: zero approval rows have a null org, so
  // no legitimate resume depends on the old fail-open.)
  if (row && ctx && ctx.orgId && row.org_id !== ctx.orgId) {
    return inputMismatchResult(
      toolName,
      approvalId,
      'approval was issued for a different organisation'
    );
  }
  return null;
}

/**
 * Per-agent tool gate (owner decision 2026-08-04, QuoxPlan notes #2202/#2203).
 * TRIAGE-Q is granted approve_request/deny_request so it can propose inbox
 * resolutions, but it must never resolve an item directly: its calls to
 * these tools always file an approval proposal that a human confirms from
 * the same inbox. This is independent of GOV-4 store policy and the legacy
 * APPROVAL_ENABLED flag, both of which gate by tool/action, not by agent
 * identity. Add further agent/tool pairs here as more HITL-only agents ship.
 */
const AGENT_GATED_TOOLS = {
  'triage-q': new Set(['approve_request', 'deny_request']),
  // DEVSUITE-HUB Phase 4: BOB's build-outcome write always proposes, never
  // resolves directly — same discipline as triage-q's approve/deny, applied
  // to a different tool (lib/bobTools.js's bob_mark_build_outcome). Gripe
  // filing (github_create_issue) is deliberately NOT gated here — it reuses
  // GRIPE's own confirm-before-file discipline instead of a second gate.
  bob: new Set(['bob_mark_build_outcome']),
  // QDIS-NEXT Phase 3: VULCAN's github_create_pull_request commits real code
  // to a real repository. Unlike GOV-4 store policies and the legacy
  // destructive-action check (both optional, org-configured, and would
  // silently NOT gate this tool if no admin ever set one up), this agent
  // identity gate fires unconditionally for every call VULCAN makes to this
  // tool, regardless of policy configuration — the "always requires human
  // approval" bar the owner asked for must not depend on an org having
  // remembered to configure a policy. See buildAgentGateProposal below for
  // the PR-specific proposal text.
  forge: new Set(['github_create_pull_request']),
  // QDIS-CONCIERGE: a Discord binding change can repoint a channel at an
  // arbitrary remote host via bridge_remote_host/bridge_remote_inbox (a
  // real finding in the 2026-08-11 audit), so both mutating discord_pro
  // tools always propose, never execute directly — same unconditional
  // discipline as forge's github_create_pull_request above. See
  // buildAgentGateProposal below for the binding-specific proposal text.
  concierge: new Set(['discord_bind_channel', 'discord_unbind_channel']),
};

// LOOP-CONVERGENCE (2026-09-23): destructive/admin ACTION tools that ANY agent
// may only ever PROPOSE, never execute directly — the same unconditional
// discipline as forge's github_create_pull_request, but keyed by TOOL (any
// agent) rather than by a specific agent id. Each of these tools declares in
// its own description that it "ALWAYS goes through the approval gate: you
// propose, a human resolves", and each was WRAPPED in withApprovalGate but
// registered in NONE of the gating mechanisms (not here, not
// _entityRequiresApproval, no `action` field for the legacy destructive path).
// In the default configuration checkApproval returned allowed:true and the real
// action fired immediately — governance theatre found by driving LOOP-Q:
//   loop_halt          delivered the signed loop kill        (returned killed:true)
//   slot_assign        wrote the slot-pool assignment         (returned assigned)
//   bob_dispatch_build dispatched a real build over Bastion    (returned dispatched:true)
// Distinct from AGENT_PROPOSE_ONLY_TOOLS below, which is approval-RESOLUTION
// tools carrying the DEC-1/DEC-4 sandbox exception; these are destructive
// ACTIONS and get no such bypass (a sandbox still completes end to end: the
// proposal is auto-resolved via the approve_request path, which owns that
// exception). Only ever reached on the first (agent) call — the human resume
// path returns before checkApproval.
// quox#590: email_send joins the set — an external SMTP send from the org
// mailbox, where recipients and content are exactly what a prompt-injected
// agent controls (inbound email is attacker-controlled input). A vault lease
// authorizes USE of the credential, never the send itself. The gate's input
// fingerprint binds to/cc/bcc/subject/body, so what a human approved is what
// gets sent.
// QUOXTRUST (FND_01M3CMZZD5YWVSXAF5Y5YWVSXA): send_notification joins the set for the
// SAME reason as email_send — its external channels (email/slack/telegram) are egress
// with an agent-supplied recipient, the alternate route around email_send's gate. Only
// the external path is wrapped in withApprovalGate (agentTools.js); internal `inbox`
// notifications return before the wrap and are never gated.
// QUOXTRUST T5/T9 (FND_01M3SF9C, 2026-09-30): the arbitrary-shell / arbitrary-SQL tools
// join the set for the SAME reason as loop_halt/email_send above — and this closes a
// governance-theatre gap the external-mutation class sweep found. remote_ssh and db_query
// were WRAPPED in withApprovalGate but registered in NONE of the gating mechanisms, and
// ssh_exec (a second, older doorway to the identical bastion shell) was not even wrapped.
// The live GOV-4 store carries ZERO require_approval policies, so absent this set
// checkApproval falls to its allow tail (input.command/query is not the destructive-`action`
// field) and executes arbitrary shell/SQL with no human approval. Reachable by ~15 agents.
// The read paths never reach this gate: remote_ssh/ssh_exec return direct for commands on
// the injection-proof read allowlist, and db_query gates only allow_write — so this set
// holds ONLY the mutating branch, unconditionally, no org policy required. See the
// buildAgentGateProposal cases below so none of the three renders a blind card (T4).
// QUOXTRUST MF-2 (trust-proof-self-audit, owner-chosen remediation): native
// externalEffect tools are NOT covered by referenceMonitor's plugin-effect
// default gate (that gate only classifies PLUGIN tools — see
// referenceMonitor.js's isPluginEffect block), and the live GOV-4 store
// carries zero require_approval policies, so these four ran with no default
// HITL at all. alerts_manage was the un-mediated standout (no withApprovalGate
// wrap whatsoever — silence/unsilence could suppress alerting unconditionally);
// backup_run/keeper_backup_create/deploy_template were already wrapped in
// tool.externalEffect for ledger purposes but never gated. Same lever as
// email_send/ssh_exec above: unconditional, no org policy required.
// QUOXTRUST v1.8 RB2 (resource/spend bounds): gemini_generate + perplexity_research
// are pay-per-call APIs with NO per-org cost-budget gate (MF-2(b) debt). Until a real
// spend-ceiling exists, force them to propose-first (human default-approval) so a
// looping/compromised agent cannot run up unbounded paid-API spend unseen.
// QUOXHAT #657 P-E: system_admin + proxmox_vm_action added. These are
// unambiguous PRIVILEGED INFRA WRITES that were only ever "gated" by sitting in
// a hat's active-ops/change BUNDLE — but P-B established that bundle loading is
// presentation-only, never an authorization boundary (an agent can self-load a
// bundle). So without a global floor an agent could execute these under a
// permissive hat with no human in the loop. The faithful expression of the
// templates' "active operations are approval-gated" intent is this
// always-propose floor (every agent, every org, every hat — a hat can narrow
// further but can never remove it), NOT bundle membership. (Mixed/read-ish
// tools like quoxagent/proxmox_vms/docker_extended/execute_workflow are left for
// a future per-ACTION require_approval authz outcome rather than gating their
// reads wholesale.)
// AQ-9B L2-C2: calendar_event_create is Calendar-Q's ONLY tool with an
// external effect (a real provider event, real attendee invites if
// notifyPolicy is 'attendees') — unconditionally gated for the same reason
// as email_send/bob_dispatch_build above: a human must confirm every time,
// never contingent on an org having configured a matching GOV-4 policy.
// quox#590-shape bypass is pinned directly in
// test/calendarqApprovalMediation.test.js.
const AGENT_ALWAYS_PROPOSE_TOOLS = new Set(['loop_halt', 'slot_assign', 'bob_dispatch_build', 'email_send', 'send_notification', 'remote_ssh', 'ssh_exec', 'db_query', 'alerts_manage', 'backup_run', 'keeper_backup_create', 'deploy_template', 'gemini_generate', 'perplexity_research', 'system_admin', 'proxmox_vm_action', 'calendar_event_create', 'contacts_dial', 'contacts_send', 'contacts_context', 'contacts_dial_batch', 'contacts_send_batch', 'brain_garden_apply']);

// AQ-9D P3 approval mode: NotesQ write tools are agent-gated ONLY when the org's
// NOTESQ_AGENT_EDIT_POLICY is 'propose'. lib/notesqTools.js resolves that setting
// server-side and passes ctx._notesqPropose (never from tool input); 'direct' and
// 'read_only' orgs are untouched. The card (with the diff) arrives as
// ctx._notesqProposal, built by notesqTools from the note as it stands.
const { NOTESQ_PROPOSE_TOOLS } = require('./notesqProposeTools.js');
const isNotesqPropose = (toolName, ctx) => !!(ctx && ctx._notesqPropose === true && NOTESQ_PROPOSE_TOOLS.has(toolName));

// CONTACTSQ P1: outward contact tools. Unconditionally agent-gated like the rest of
// AGENT_ALWAYS_PROPOSE_TOOLS, and deliberately NOT in DIRECT_REQUEST_OK_TOOLS (a human
// asking in chat does not skip the ask for an outward call/message). The ONE no-ask
// path is a human-created STANDING GRANT, consulted in checkApproval below.
const CONTACTSQ_LEASE_TOOLS = new Set(['contacts_dial', 'contacts_send', 'contacts_context', 'contacts_dial_batch', 'contacts_send_batch']);

// SEC-AUDIT (2026-08-11): AGENT_GATED_TOOLS is keyed by LOWERCASE agent id
// (see the keys above: 'triage-q', 'bob'), but every OTHER RBAC layer in
// agentTools.js (tool-offering, native RBAC, connector-family RBAC) already
// lowercases ctx.agentId before doing its lookup. This lookup did not, so a
// caller passing an uppercase/mixed-case agentId (e.g. {agentId:'BOB'} or
// {agentId:'TRIAGE-Q'}) skipped this gate entirely — bob_mark_build_outcome
// wrote the receipt directly, and triage-q's approve_request/deny_request
// resolved directly, instead of always filing a human-confirmable proposal.
// Lowercase here so this gate is case-insensitive like every sibling check.
function isAgentGated(toolName, ctx = {}) {
  // SEC-AUDIT (2026-08-11) hardening: String() so a non-string agentId (number,
  // object, array — seen from malformed callers) can never throw here, and
  // trim() so a trailing/leading space can't skip the gate the way a bare
  // toLowerCase() allowed ('bob ' would otherwise miss AGENT_GATED_TOOLS['bob']).
  // Destructive loop-control actions (loop_halt) gate for EVERY agent,
  // unconditionally — no org policy required, no per-agent grant required.
  if (AGENT_ALWAYS_PROPOSE_TOOLS.has(toolName)) return true;
  if (isNotesqPropose(toolName, ctx)) return true;
  const agentKey = String(ctx.agentId ?? '').trim().toLowerCase();
  const gated = AGENT_GATED_TOOLS[agentKey];
  return !!(gated && gated.has(toolName));
}

/**
 * APPROVAL-SPAM 4/6 (owner, typed in the terminal 2026-10-05: "if
 * authenticated, a user request should not need additional verification,
 * unless it's relating to some yet to be seen new data"). A verified human
 * driving the conversation, with no new outside content read since their last
 * message, is the authorization for the always-propose tools below, EXCEPT
 * destructive input. Outward tools (email, notifications, posts, PRs, calendar
 * invites), approval resolution, deploys and system admin are deliberately
 * absent: they still ask even when the human asked.
 */
const DIRECT_REQUEST_OK_TOOLS = new Set([
  'ssh_exec', 'remote_ssh', 'db_query', 'proxmox_vm_action',
  'alerts_manage', 'backup_run', 'keeper_backup_create', 'loop_halt', 'slot_assign',
  'bob_dispatch_build', 'gemini_generate', 'perplexity_research',
  // AQ-9D: in NotesQ approval mode the person asking IS the approval for their own
  // request; an agent acting unprompted still files a diff. Delete is not here, so
  // a delete always asks.
  'notesq_create', 'notesq_update', 'notesq_tag', 'notesq_restore',
]);
// Any match means "still ask". Deliberately broad: when in doubt, it asks.
const DESTRUCTIVE_SHELL = /(^|[\s;&|(])(sudo\s+)?(rm|rmdir|mkfs(\.\w+)?|dd|shred|wipefs|fdisk|parted|sgdisk|reboot|shutdown|poweroff|halt|kill|killall|pkill|userdel|groupdel|truncate|zpool)(\s|$)|crontab\s+-r|zfs\s+destroy|iptables\s+-[FX]|nft\s+flush|systemctl\s+(stop|disable|mask|kill|poweroff|reboot|halt|isolate)|docker\s+(rm|rmi|kill|stop|prune|system\s+prune|volume\s+rm|network\s+rm)|\b(qm|pct)\s+(stop|destroy|shutdown|reset|rollback)|\binit\s+[06]\b|>\s*\/(etc|boot|dev|usr|var|bin|sbin|lib)|chmod\s+-R|chown\s+-R|drop\s+(table|database|schema)|\bdelete\s+from\b|\btruncate\s+table\b/i;
const READ_ONLY_SQL = /^\s*(select|show|explain|describe|desc|with)\b/i;
const WRITE_SQL = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|replace|merge|attach|detach|vacuum|pragma)\b/i;

function isDestructiveForDirectRequest(toolName, input = {}) {
  if (toolName === 'ssh_exec' || toolName === 'remote_ssh') {
    const cmd = String(input.command || '');
    return !cmd.trim() || DESTRUCTIVE_SHELL.test(cmd);
  }
  if (toolName === 'db_query') {
    const q = String(input.query || input.sql || '');
    return !(READ_ONLY_SQL.test(q) && !WRITE_SQL.test(q));
  }
  if (toolName === 'proxmox_vm_action') {
    const action = String(input.action || '').toLowerCase();
    return !action || DESTRUCTIVE_ACTIONS.has(action);
  }
  return false;
}

function directRequestAuthorizes(toolName, input, ctx = {}) {
  if (!DIRECT_REQUEST_OK_TOOLS.has(toolName)) return null;
  const human = directRequestRegistry.isDirectRequest(ctx.conversationId || ctx.session_id, ctx.orgId);
  if (!human) return null;
  // Only the human's OWN turn rides their say-so: /api/v1/tools/execute takes a
  // body-supplied session_id, so another member or an agent that learned the
  // conversation id must not inherit it.
  if (!ctx.userId || String(ctx.userId) !== human.userId) return null;
  if (isDestructiveForDirectRequest(toolName, input)) return null;
  return human;
}

/**
 * P0b (QUOXPERTICUS DEC-3 + HARD INVARIANT #1): approval-RESOLUTION tools that
 * NO agent may call to resolve directly — an agent's call always files a
 * human-confirmable proposal. This generalizes the AGENT_GATED_TOOLS discipline
 * from a per-agent allowlist to EVERY agent (previously only triage-q's
 * approve/deny were gated, so CommanderQ resolved approvals itself — the veto
 * approving itself). A human resolves via the UI / resume-token path, which
 * returns before this gate, so this only ever catches an agent caller.
 *
 * One exception (DEC-1/DEC-4): on an instance the AUTH SERVICE reports as
 * disposable_test:true AND holding an unexpired test-approver lease — both
 * whole-instance properties read server-side, never from ctx — the resolution
 * MAY proceed, but the COLLECTOR performs it as the synthetic test-approver
 * principal (never the agent's or an agent-chosen identity), so the sandbox
 * can run the loop end to end without a human in it and without any agent
 * identity ever sitting on an approval. See checkApproval below for where the
 * exception is applied; real instances are unchanged, and an expired lease
 * locks a sandbox again (leased, not latched).
 */
const AGENT_PROPOSE_ONLY_TOOLS = new Set(['approve_request', 'deny_request']);

function isApprovalResolutionByAgent(toolName, ctx = {}) {
  const agentKey = String(ctx.agentId ?? '').trim().toLowerCase();
  return AGENT_PROPOSE_ONLY_TOOLS.has(toolName) && agentKey.length > 0;
}

/**
 * #625 (QUOXTRUST T4 — reviewable authority): a human must never approve blind.
 * When the caller supplies a justification (`reason`) and/or what the action
 * relates to (`related_to` / `context` — an agent intent, task, or stream),
 * render it PROMINENTLY on every approval card, regardless of tool. Applied as
 * a universal augmentation over buildAgentGateProposal's per-tool body so it
 * covers new tools and the generic fallback automatically. bodyMd is what
 * createApprovalRequest persists and the dashboard/inbox render, so this reaches
 * the reviewer with no schema change. Pure + exported for direct testing.
 */
function appendRequestContext(bodyMd, input) {
  if (!input || typeof input !== 'object') return bodyMd;
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const reason = str(input.reason);
  const related = str(input.related_to) || str(input.context);
  if (!reason && !related) return bodyMd;
  let block = '\n\n---\n';
  if (reason) block += `\n**Why the agent asked:** ${reason}`;
  if (related) block += `\n**Related to:** ${related}`;
  return `${bodyMd}${block}`;
}

// AQ-9B audit fix 3: calendar_event_create's proposal.title/attendee emails/
// visibility/connectionId are agent/attacker-controlled text interpolated
// into bodyMd, a markdown string the dashboard/inbox render verbatim. A
// hostile title containing a blank-line break plus "**Effect digest:** ..."
// or "Confirm to create" can forge a fake metadata row or call-to-action
// that reads as if the card builder itself emitted it. Escape markdown
// metacharacters (backslash FIRST, so escaping the others never double-
// escapes the backslash it just inserted) and collapse newlines to a single
// space so a multi-line payload can never masquerade as its own line.
function escapeCalendarQMarkdown(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\~')
    .replace(/#/g, '\\#')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/>/g, '\\>')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, ' ');
}

/**
 * Build the human-facing proposal text for an agent-gated approve/deny call.
 * Carries the target item id and the reason the agent gave, so the human
 * confirming the proposal has the same context the agent used.
 */
function buildAgentGateProposal(toolName, input, ctx) {
  // AQ-9D: NotesQ approval mode supplies its own card (title + diff), built from
  // the note as it stands when the agent proposed the change.
  if (isNotesqPropose(toolName, ctx) && ctx._notesqProposal && typeof ctx._notesqProposal.bodyMd === 'string') {
    const c = ctx._notesqProposal;
    return { targetId: String(c.targetId || toolName), reason: String(c.reason || ''), title: String(c.title || `${toolName} proposed`), bodyMd: c.bodyMd };
  }
  const agentLabel = (ctx.agentId || 'agent').toUpperCase();

  // contacts_dial / contacts_send (CONTACTSQ P1): name the person (display name looked up
  // org-scoped), the channel and the purpose. NEVER a number or address: the agent has
  // none and the card must not be the place one leaks. The agent's reason is appended by
  // appendRequestContext on the way into createApprovalRequest.
  // contacts_context (CONTACTSQ P5): names the person and the purpose; never a fact value.
  if (toolName === 'contacts_context') {
    let who = 'an unknown contact';
    try {
      const row = require('./contactsq/store.js').getContactRow(ctx.orgId, input.contact_id);
      if (row) who = escapeCalendarQMarkdown(row.display_name);
    } catch { /* card still renders */ }
    const purpose = typeof input.purpose === 'string' && input.purpose ? input.purpose : 'service';
    const bodyMd = `**${agentLabel}** asks to read the confirmed context for **${who}**.\n\n` +
      `- Contact: ${who}\n- Purpose: ${escapeCalendarQMarkdown(purpose)}\n\n` +
      `The agent would see only facts a human has confirmed and that are not sensitive, plus recent interaction summaries. ` +
      `Confirm this proposal to release them for this one use, or deny it. A standing grant (Settings, ContactsQ) can pre-approve context reads.`;
    return { targetId: String(input.contact_id || 'unknown contact'), reason: typeof input.reason === 'string' ? input.reason : '', title: `${agentLabel} proposes: read context for ${who}`, bodyMd };
  }
  // contacts_dial_batch / contacts_send_batch (CONTACTSQ P8B): ONE card for the whole batch. Each person by
  // display name, with the policy pre-check as a code (never a number or address). Items the policy already
  // refuses are listed under Excluded and are not part of what the approval releases.
  if (toolName === 'contacts_dial_batch' || toolName === 'contacts_send_batch') {
    const isDial = toolName === 'contacts_dial_batch';
    const store = require('./contactsq/store.js');
    const policy = require('./contactsq/policy.js');
    const purpose = typeof input.purpose === 'string' && input.purpose ? input.purpose : 'service';
    const nameOf = (id) => {
      try { const row = store.getContactRow(ctx.orgId, id); if (row) return escapeCalendarQMarkdown(row.display_name); } catch { /* card still renders */ }
      return 'an unknown contact';
    };
    const clip = (v) => escapeCalendarQMarkdown(String(v || '').replace(/\s+/g, ' ').slice(0, 160));
    const items = Array.isArray(input.items) ? input.items : [];
    const lines = items.map((it, i) => {
      const channel = isDial ? 'voice' : String(it && it.channel || 'unknown');
      let verdict = 'unknown';
      try {
        const row = store.getContactRow(ctx.orgId, it && it.contact_id);
        if (row) {
          const r = policy.evaluate(ctx.orgId, row, { purpose, channel, subject: { type: 'agent' } });
          verdict = r.decision === 'allow' ? 'allowed' : r.decision === 'approval_required' ? `approval required (${r.reasons.join(', ')})` : `would refuse (${r.reasons.join(', ')})`;
        }
      } catch { /* verdict stays unknown */ }
      const why = isDial ? ` Reason: ${clip(it && it.reason)}` : ` Message: ${clip(it && it.message)}`;
      return `${i + 1}. **${nameOf(it && it.contact_id)}** (${escapeCalendarQMarkdown(channel)}), policy: ${verdict}.${why}`;
    });
    const excluded = Array.isArray(ctx._contactsqBatchExcluded) ? ctx._contactsqBatchExcluded : [];
    const exLines = excluded.map((d) => `- ${nameOf(d.contact_id)}: refused by policy (${(d.reasons || []).map((x) => escapeCalendarQMarkdown(x)).join(', ')}). Not included.`);
    const n = items.length;
    const bodyMd = `**${agentLabel}** proposes to ${isDial ? 'place phone calls to' : 'send messages to'} **${n} ${n === 1 ? 'person' : 'people'}** in one batch.\n\n` +
      `- Purpose: ${escapeCalendarQMarkdown(purpose)}\n\n${lines.join('\n')}\n\n` +
      (exLines.length ? `Excluded (will not be contacted):\n${exLines.join('\n')}\n\n` : '') +
      `The agent never sees a number or address; the contact book releases each one for a single use, and policy is checked again for every person at the moment of approval. ` +
      `Approving releases only the ${n} listed above. A standing grant (Settings, ContactsQ) can pre-approve a batch only when every person is allowed and it fits the daily cap.`;
    return { targetId: `batch of ${n}`, reason: typeof input.reason === 'string' ? input.reason : '', title: `${agentLabel} proposes: ${isDial ? 'call' : 'message'} ${n} ${n === 1 ? 'person' : 'people'}`, bodyMd };
  }
  if (toolName === 'contacts_dial' || toolName === 'contacts_send') {
    let who = 'an unknown contact';
    try {
      const row = require('./contactsq/store.js').getContactRow(ctx.orgId, input.contact_id);
      if (row) who = escapeCalendarQMarkdown(row.display_name);
    } catch { /* card still renders */ }
    const channel = toolName === 'contacts_dial' ? 'voice' : String(input.channel || 'unknown');
    const purpose = typeof input.purpose === 'string' && input.purpose ? input.purpose : 'service';
    const verb = toolName === 'contacts_dial' ? 'place a phone call to' : `send a ${escapeCalendarQMarkdown(channel)} message to`;
    const targetId = String(input.contact_id || 'unknown contact');
    const title = `${agentLabel} proposes: ${toolName === 'contacts_dial' ? 'call' : `${channel} message to`} ${who}`;
    // CONTACTSQ P2: when policy says approval_required (or would refuse), list the reason CODES
    // so the human sees why this needs them. Codes only, never a value.
    let policyMd = '';
    try {
      const store = require('./contactsq/store.js');
      const policy = require('./contactsq/policy.js');
      const row = store.getContactRow(ctx.orgId, input.contact_id);
      if (row) {
        const res = policy.evaluate(ctx.orgId, row, { purpose, channel, subject: { type: 'agent' } });
        if (res.decision === 'approval_required') policyMd = `- Policy: approval required (${res.reasons.join(', ')})\n`;
        else if (res.decision === 'deny') policyMd = `- Policy: would refuse this (${res.reasons.join(', ')})\n`;
      }
    } catch { /* card still renders */ }
    const bodyMd = `**${agentLabel}** proposes to ${verb} **${who}**.\n\n` +
      `- Contact: ${who}\n- Channel: ${escapeCalendarQMarkdown(channel)}\n- Purpose: ${escapeCalendarQMarkdown(purpose)}\n${policyMd}\n` +
      `The agent never sees the number or address; the contact book releases it for this one use only. ` +
      `Confirm this proposal to proceed, or deny it. A standing grant (Settings, ContactsQ) can pre-approve calls like this.`;
    return { targetId, reason: typeof input.reason === 'string' ? input.reason : '', title, bodyMd };
  }

  // bob_mark_build_outcome (DEVSUITE-HUB Phase 4) has its own input shape
  // (target/result/message, not approval_id/item_id) — build a matching
  // proposal instead of falling through to 'unknown'.
  if (toolName === 'bob_mark_build_outcome') {
    const targetId = input.target || 'unknown target';
    const verb = `record build outcome`;
    const title = `${agentLabel} proposes: ${verb} for ${targetId} = ${input.result || 'unknown'}`;
    const bodyMd = `**${agentLabel}** proposes to record **${input.result || 'unknown'}** for \`${targetId}\`` +
      (input.message ? ` (${input.message})` : '') +
      `\n\nConfirm this proposal to write the build receipt, or deny it to reject the proposal.`;
    return { targetId, reason: input.message || '', title, bodyMd };
  }

  // github_create_pull_request (QDIS-NEXT Phase 3) also has its own input
  // shape (repo/branch/base/title/body/files, not approval_id/item_id) —
  // build a proposal a human can actually evaluate: which repo, which
  // branch off which base, how many files, and the PR title/body VULCAN
  // wrote (which should reference the issue it investigated).
  if (toolName === 'github_create_pull_request') {
    const targetId = `${input.repo || 'unknown repo'}:${input.branch || 'unknown branch'}`;
    const fileCount = Array.isArray(input.files) ? input.files.length : 0;
    const title = `${agentLabel} proposes: open a pull request on ${input.repo || 'unknown repo'}`;
    const bodyMd = `**${agentLabel}** proposes to open a pull request:\n\n` +
      `- Repo: \`${input.repo || 'unknown'}\`\n` +
      `- Branch: \`${input.branch || 'unknown'}\` -> \`${input.base || 'repo default branch'}\`\n` +
      `- Files changed: ${fileCount}\n` +
      `- PR title: ${input.title || '(none given)'}\n\n` +
      (input.body ? `**PR body:**\n${input.body}\n\n` : '') +
      `Confirm this proposal to create the branch, commit the files, and open the PR. This never merges — the PR still needs a human review/merge afterwards. Deny to reject the proposal.`;
    return { targetId, reason: input.title || '', title, bodyMd };
  }

  // discord_bind_channel/discord_unbind_channel (QDIS-CONCIERGE) — input
  // shape is channel_id plus binding fields (mode, agent_id, bridge_* etc),
  // not approval_id/item_id. Name the channel, the mode, and (for a bridge
  // binding) the remote host, so the human approving can actually evaluate
  // where a rebind would send traffic.
  if (toolName === 'discord_bind_channel' || toolName === 'discord_unbind_channel') {
    const verb = toolName === 'discord_bind_channel' ? 'bind' : 'unbind';
    const targetId = input.channel_id || 'unknown channel';
    const modeText = input.mode ? ` as mode \`${input.mode}\`` : '';
    const agentText = input.agent_id ? ` -> agent \`${input.agent_id}\`` : '';
    const remoteText = input.bridge_remote_host ? ` -> bridge remote host \`${input.bridge_remote_host}\`` : '';
    const title = `${agentLabel} proposes: ${verb} Discord channel ${targetId}`;
    const bodyMd = `**${agentLabel}** proposes to **${verb}** Discord channel \`${targetId}\`${modeText}${agentText}${remoteText}.\n\n` +
      `A binding change can repoint a channel at an arbitrary remote host, so this always requires human confirmation.\n\n` +
      `Confirm this proposal to apply the change, or deny it to reject the proposal.`;
    return { targetId, reason: input.mode || '', title, bodyMd };
  }

  // loop_halt (LOOP-CONVERGENCE) — input is {session_id, reason}, a governed
  // signed kill of a running loop. Name the session and carry the reason the
  // agent cited from the turn record, so the human confirming can evaluate
  // whether the loop actually warrants stopping.
  if (toolName === 'loop_halt') {
    const targetId = input.session_id || 'unknown session';
    const reason = input.reason || '';
    const title = `${agentLabel} proposes: halt loop ${targetId}`;
    const bodyMd = `**${agentLabel}** proposes to **halt** the running loop \`${targetId}\`.\n\n` +
      (reason ? `Reason given: ${reason}\n\n` : '') +
      `This delivers a governed, witnessed signed kill to the host; the loop stops and does not resume. ` +
      `Confirm this proposal to halt the loop, or deny it to let the loop continue.`;
    return { targetId, reason, title, bodyMd };
  }

  // slot_assign (DEVSUITE-SLOTS) — input is {name, session}. Curating the slot
  // pool is an org-admin action; name the slot and the session it would be
  // assigned to (or cleared) so the human can evaluate the change.
  if (toolName === 'slot_assign') {
    const targetId = input.name || 'unknown slot';
    const session = input.session;
    const change = (session === undefined || session === null || session === '')
      ? 'CLEAR its assignment'
      : `assign it to session \`${session}\``;
    const title = `${agentLabel} proposes: ${session ? 'assign' : 'clear'} slot ${targetId}`;
    const bodyMd = `**${agentLabel}** proposes to ${change} for slot \`${targetId}\`.\n\n` +
      `Curating the slot pool is an org-admin action. Confirm this proposal to apply it, or deny it to leave the pool unchanged.`;
    return { targetId, reason: session ? String(session) : 'clear', title, bodyMd };
  }

  // bob_dispatch_build (DEVSUITE-BUILD) — input is {host_id, target, message?}.
  // A dispatch signs and delivers a real build over Bastion; name the host and
  // the pre-registered target so the human confirming knows what would build.
  if (toolName === 'bob_dispatch_build') {
    const targetId = input.target || 'unknown target';
    const host = input.host_id || 'unknown host';
    const title = `${agentLabel} proposes: build ${targetId} on ${host}`;
    const bodyMd = `**${agentLabel}** proposes to dispatch a build of \`${targetId}\` on \`${host}\`` +
      (input.message ? ` (${input.message})` : '') +
      `.\n\nThe dispatch is oracle-signed and delivered over Bastion; the host only accepts a pre-registered target. ` +
      `Confirm this proposal to queue the build, or deny it to reject the proposal.`;
    return { targetId, reason: input.message || '', title, bodyMd };
  }

  // QUOXTRUST T4 (FND_01M3CJJ...): email_send was gated (quox#590) but had NO case here,
  // so the approver confirmed a send blind — no recipients, no body. The reviewer MUST see
  // the exact recipients (including BCC, the classic exfil vector) and the body.
  if (toolName === 'email_send') {
    const fmt = (v) => (Array.isArray(v) ? v.join(', ') : (v ? String(v) : ''));
    const to = fmt(input.to);
    const cc = fmt(input.cc);
    const bcc = fmt(input.bcc);
    const subject = input.subject || '(no subject)';
    const bodyText = String(input.text || input.html || '');
    const preview = bodyText.length > 800 ? bodyText.slice(0, 800) + '…' : bodyText;
    const title = `${agentLabel} proposes: email "${subject}" to ${to || '(no recipient)'}`;
    const bodyMd = `**${agentLabel}** proposes to send an email over the org mailbox.\n\n` +
      `**To:** ${to || '(none)'}\n` +
      (cc ? `**CC:** ${cc}\n` : '') +
      (bcc ? `**BCC:** ${bcc}\n` : '') +
      `**Subject:** ${subject}\n\n` +
      `**Body:**\n\n${preview || '(empty)'}\n\n` +
      `Confirm to send exactly this, or deny to stop it. Every recipient (including any BCC) is listed above — anyone not listed will not receive it.`;
    return { targetId: to || 'email', reason: subject, title, bodyMd };
  }

  // QUOXTRUST (FND_01M3CMZZD5YWVSXAF5Y5YWVSXA): external-channel notification — an
  // agent-chosen recipient on an egress channel. Show channel + recipient + message so the
  // human is not authorizing an arbitrary external send blind. (Only external channels
  // reach here; internal `inbox` returns before the gate.)
  if (toolName === 'send_notification') {
    const channel = input.channel || 'unknown';
    const recipient = input.recipient || '(no recipient)';
    const msgTitle = input.title || '';
    const message = String(input.message || '');
    const preview = message.length > 800 ? message.slice(0, 800) + '…' : message;
    const title = `${agentLabel} proposes: ${channel} notification to ${recipient}`;
    const bodyMd = `**${agentLabel}** proposes to send a **${channel}** notification, which leaves the org over an external channel.\n\n` +
      `**Channel:** ${channel}\n` +
      `**Recipient:** ${recipient}\n` +
      (msgTitle ? `**Title:** ${msgTitle}\n` : '') +
      `\n**Message:**\n\n${preview || '(empty)'}\n\n` +
      `Confirm to send it to exactly this recipient, or deny to stop it.`;
    return { targetId: recipient, reason: msgTitle || channel, title, bodyMd };
  }

  // QUOXTRUST T4/T5/T9 (FND_01M3SF9C): remote_ssh / ssh_exec run an arbitrary shell command
  // on a remote/fleet host. The read-only allowlist path never reaches this gate (agentTools
  // returns direct); only a NON-read command is held here, so the approver MUST see the exact
  // host and command — never a blind shell approval.
  if (toolName === 'remote_ssh' || toolName === 'ssh_exec') {
    const host = input.host || (input.credential_id ? `(credential ${input.credential_id})` : 'unknown host');
    const command = String(input.command || '');
    const preview = command.length > 1200 ? command.slice(0, 1200) + '…' : command;
    const via = toolName === 'remote_ssh' ? 'direct SSH via a vault key' : 'bastion SSH';
    const title = `${agentLabel} proposes: run a shell command on ${host}`;
    const bodyMd = `**${agentLabel}** proposes to run a shell command on \`${host}\` (${via}).\n\n` +
      `**Command:**\n\n\`\`\`\n${preview || '(empty)'}\n\`\`\`\n\n` +
      `This command is NOT on the read-only allowlist, so it is held for approval. ` +
      `Confirm to run exactly this on \`${host}\`, or deny to stop it.`;
    return { targetId: host, reason: preview.slice(0, 200), title, bodyMd };
  }

  // QUOXTRUST T4/T5/T9 (FND_01M3SF9C): db_query with allow_write runs a mutating SQL statement
  // against a vault database credential. The read path (readonly txn) runs direct; only a write
  // reaches this gate. Show the exact SQL and the target so the write is not approved blind.
  if (toolName === 'db_query') {
    const q = String(input.query || '');
    const preview = q.length > 1200 ? q.slice(0, 1200) + '…' : q;
    const cred = input.credential_id ? `credential \`${input.credential_id}\`` : 'a database credential';
    const title = `${agentLabel} proposes: run a WRITE SQL statement against ${cred}`;
    const bodyMd = `**${agentLabel}** proposes to run a mutating SQL statement (allow_write) against ${cred}.\n\n` +
      `**SQL:**\n\n\`\`\`sql\n${preview || '(empty)'}\n\`\`\`\n\n` +
      `A read query would not require approval; this is a WRITE. Confirm to execute exactly this, or deny to stop it.`;
    return { targetId: input.credential_id || 'db', reason: preview.slice(0, 200), title, bodyMd };
  }

  // QUOXTRUST MF-2 (T4-style non-blind card): alerts_manage's 'silence'
  // operation suppresses alerting for a given alertname. Named here so the
  // approver sees exactly what would stop alerting, not a blind generic card.
  if (toolName === 'alerts_manage') {
    const alertName = input.alert_name || '(all matching alerts)';
    const title = `${agentLabel} proposes: silence alert ${alertName}`;
    const bodyMd = `**${agentLabel}** proposes to **silence** alerting for \`${alertName}\`.\n\n` +
      `Silencing suppresses alert notifications until the silence expires or is removed manually. ` +
      `Confirm this proposal to apply the silence, or deny it to reject the proposal.`;
    return { targetId: alertName, reason: alertName, title, bodyMd };
  }

  // ONE-BRAIN CX6 gardener: name the kind, the reason and each note, so the
  // approver sees exactly what would be archived (never note bodies).
  if (toolName === 'brain_garden_apply') {
    const ids = Array.isArray(input.noteIds) ? input.noteIds : [];
    const titles = input.titles && typeof input.titles === 'object' ? input.titles : {};
    const kind = String(input.proposalKind || 'tidy-up');
    const lines = ids.slice(0, 20).map((id) => `- ${escapeCalendarQMarkdown(String(titles[id] || '(untitled)').slice(0, 120))} (${String(id).slice(0, 12)})`);
    const title = `${agentLabel} proposes: archive ${ids.length} ${kind} note${ids.length === 1 ? '' : 's'}`;
    const bodyMd = `**${agentLabel}** proposes to **archive** ${ids.length} of your notes (${kind}).\n\n` +
      `${escapeCalendarQMarkdown(String(input.reason || '').slice(0, 400))}\n\n${lines.join('\n')}\n\n` +
      `Archiving only sets the archived flag. A revision is recorded, nothing is deleted, and each note can be restored in NotesQ. ` +
      `A note that has changed since this was proposed is skipped. Confirm to archive, or deny to leave them as they are.`;
    return { targetId: ids.join(',').slice(0, 200) || kind, reason: String(input.reason || ''), title, bodyMd };
  }

  // QUOXTRUST MF-2: backup_run / keeper_backup_create trigger a real backup
  // job. Same input shape ({backup_type, name, description, components}) for
  // both tools (org-scoped vs internal variants of the same KEEPER call).
  if (toolName === 'backup_run' || toolName === 'keeper_backup_create') {
    const type = input.backup_type || 'full';
    const label = input.name ? ` "${input.name}"` : '';
    const compText = type === 'selective' && Array.isArray(input.components) && input.components.length
      ? ` (components: ${input.components.join(', ')})`
      : '';
    const title = `${agentLabel} proposes: trigger a ${type} backup${label}`;
    const bodyMd = `**${agentLabel}** proposes to trigger a **${type}** backup${label}${compText}` +
      (input.description ? `\n\n${input.description}` : '') +
      `\n\nConfirm this proposal to run the backup, or deny it to reject the proposal.`;
    return { targetId: input.name || type, reason: input.description || '', title, bodyMd };
  }

  // QUOXTRUST MF-2: deploy_template deploys a QuoxFlow workflow (real nodes,
  // real edges, possibly a schedule trigger) from a known template — name the
  // template and any config overrides so the approver knows what would run.
  if (toolName === 'deploy_template') {
    const tpl = input.template || 'unknown template';
    const label = input.name ? ` named "${input.name}"` : '';
    let configText = '';
    try {
      if (input.config && Object.keys(input.config).length > 0) {
        configText = `\n\n**Config overrides:**\n\n\`\`\`json\n${JSON.stringify(input.config, null, 2).slice(0, 1200)}\n\`\`\`\n`;
      }
    } catch { configText = ''; }
    const title = `${agentLabel} proposes: deploy workflow template "${tpl}"${label}`;
    const bodyMd = `**${agentLabel}** proposes to deploy the **${tpl}** workflow template${label} into QuoxFlow.${configText}\n\n` +
      `Confirm this proposal to deploy the workflow, or deny it to reject the proposal.`;
    return { targetId: input.name || tpl, reason: tpl, title, bodyMd };
  }

  // AQ-9B L2-C2: calendar_event_create's input is ONLY {proposalId} — the
  // approver must see the canonical effect (title, exact local time + tz,
  // attendee emails, notify behaviour, target calendar) and the effectDigest
  // it is bound to, never a blind "approve proposalId X" card. Looked up
  // from the already-persisted proposal rather than carried on the tool
  // input itself, since the input is deliberately minimal.
  if (toolName === 'calendar_event_create') {
    let proposal = null;
    try {
      const { findOperationByProposalId } = require('./calendarq/proposals.js');
      const op = findOperationByProposalId(ctx.orgId, input.proposalId);
      proposal = op ? op.proposal : null;
    } catch { proposal = null; }
    const targetId = input.proposalId || 'unknown proposal';
    if (!proposal) {
      const title = `${agentLabel} proposes: create a calendar event (proposal not found)`;
      const bodyMd = `**${agentLabel}** proposes to create a calendar event from proposal \`${targetId}\`, but the proposal could not be loaded to show its details. Deny this and ask the agent to re-propose.`;
      return { targetId, reason: '', title, bodyMd };
    }
    const when = proposal.allDay
      ? `all day ${new Date(proposal.startTs).toISOString().slice(0, 10)}`
      : `${new Date(proposal.startTs).toISOString()} - ${new Date(proposal.endTs).toISOString()} (${proposal.timezone})`;
    // Escaped-for-markdown fields: every value below is agent/attacker-
    // controlled text (the title, attendee emails, visibility and
    // connectionId all ultimately trace back to proposal input) and gets
    // interpolated into bodyMd, a markdown string rendered verbatim by the
    // dashboard/inbox. See escapeCalendarQMarkdown above.
    const safeTitle = escapeCalendarQMarkdown(proposal.title);
    const safeConnectionId = escapeCalendarQMarkdown(proposal.connectionId);
    const safeVisibility = escapeCalendarQMarkdown(proposal.visibility);
    const attendeesText = proposal.attendees.length > 0
      ? proposal.attendees.map((a) => escapeCalendarQMarkdown(a.email)).join(', ')
      : '(none)';
    const notifyText = proposal.notifyPolicy === 'attendees' ? 'Attendees WILL be emailed an invite.' : 'No one will be notified.';
    const conflictText = (proposal.preconditions.knownOverlapKeys || []).length > 0
      ? `**Disclosed conflicts:** ${proposal.preconditions.knownOverlapKeys.length} overlapping event(s) at propose time.\n`
      : '';
    const title = `${agentLabel} proposes: create "${safeTitle}"`;
    const bodyMd = `**${agentLabel}** proposes to create a calendar event on \`${safeConnectionId}\`.\n\n` +
      `**Title:** ${safeTitle}\n` +
      `**When:** ${when}\n` +
      `**Attendees:** ${attendeesText}\n` +
      `**Notify:** ${notifyText}\n` +
      `**Visibility:** ${safeVisibility}\n` +
      conflictText +
      `**Effect digest:** \`${proposal.effectDigest}\`\n\n` +
      `Confirm to create exactly this event, or deny to reject the proposal. If the effect changes after you approve, execution refuses with effect_drift rather than silently creating something different.`;
    return { targetId, reason: proposal.title, title, bodyMd };
  }

  const verb = toolName === 'deny_request' ? 'deny' : 'approve';
  const targetId = input.approval_id || input.item_id || input.id || 'unknown';
  const reason = input.reason || input.comment || '';
  const title = `${agentLabel} proposes: ${verb} ${targetId}`;
  const bodyMd = `**${agentLabel}** proposes to **${verb}** \`${targetId}\`` +
    (reason ? ` (reason: ${reason})` : '') +
    `\n\nConfirm this proposal to execute the action, or deny it to reject the proposal.`;
  return { targetId, reason, title, bodyMd };
}

// BLAST-RADIUS-P3: how long checkStorePolicies waits for a reach resolution
// before giving up and failing closed. Deliberately short and separate from
// getCachedStaticReach's own ttlMs — this bounds the tool-call hot path, the
// ttl bounds cache freshness; they answer different questions.
const REACH_POLICY_TIMEOUT_MS = 3000;

function withReachTimeout(promise, ms) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`reach resolution timed out after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * True if a leaf condition node's `field` names a reach.* variable. Walks
 * AND/OR group nodes recursively (same shape conditionEvaluator.js's
 * evaluateCondition consumes).
 */
function conditionReferencesReach(condition) {
  if (!condition || typeof condition !== 'object') return false;
  if (Array.isArray(condition.conditions)) {
    return condition.conditions.some(conditionReferencesReach);
  }
  return typeof condition.field === 'string' && condition.field.startsWith('reach.');
}

/**
 * BLAST-RADIUS-P3: true if any enabled governance/safety deny|require_approval
 * policy in the given list has a condition referencing reach.*. Used to
 * decide whether checkStorePolicies needs to pay for a reach resolution at
 * all — orgs that never write a reach-based policy never pay for one.
 *
 * @param {object[]} policies
 * @returns {boolean}
 */
function policiesReferenceReach(policies) {
  if (!Array.isArray(policies)) return false;
  return policies.some((pol) => {
    if (!pol || pol.enabled === false) return false;
    if (pol.category !== 'governance' && pol.category !== 'safety') return false;
    if (pol.effect !== 'deny' && pol.effect !== 'require_approval') return false;
    return conditionReferencesReach(pol.conditions);
  });
}

/**
 * GOV-4: Check governance policies from the policy store.
 * Returns the first matching policy (highest priority), or null if none match.
 *
 * BLAST-RADIUS-P3: async now — when a policy references reach.* this
 * lazily resolves the calling agent's cached/witnessed static reach and
 * attaches it to the evaluation context as ctx._reach. FAIL-CLOSED: if that
 * resolution fails or times out, ctx._reach becomes { available: false },
 * and any deny|require_approval policy whose conditions reference reach.*
 * is treated as MATCHED regardless of what evaluateCondition would compute
 * from the missing fields — absence of knowledge must never assert safety.
 *
 * @param {string} toolName - Tool identifier
 * @param {object} input - The tool input
 * @param {object} ctx - Execution context (agentId, orgId)
 * @returns {Promise<{ policy: object|null, effect: string|null }>}
 */
async function checkStorePolicies(toolName, input, ctx = {}) {
  // No policy store WIRED at all (pre-init, or a deployment that runs without
  // the GOV-4 store). This is the ABSENCE of a configured dependency, not a
  // configured dependency FAILING, so it keeps the legacy allow posture. In the
  // running collector _voltDb is always set at boot (server.js setApprovalGateDb),
  // so this branch is effectively pre-init only. The T2 fail-closed case is a
  // store that IS wired and then errors — handled in the catch below.
  if (!_voltDb) return { policy: null, effect: null };

  try {
    const orgId = ctx.orgId || '__default__';
    const result = listPolicies(_voltDb, { org_id: orgId, enabled: true });
    if (!result.data || result.data.length === 0) return { policy: null, effect: null };

    if (policiesReferenceReach(result.data)) {
      try {
        const reach = await withReachTimeout(
          getCachedStaticReach(ctx.agentId, orgId),
          REACH_POLICY_TIMEOUT_MS
        );
        ctx._reach = { available: true, ...reach };
      } catch (_err) {
        ctx._reach = { available: false };
      }
    }

    const toolCtx = buildToolContext(toolName, input, ctx);

    // Policies are sorted by priority DESC from listPolicies
    for (const pol of result.data) {
      if (!pol.conditions) continue;
      // Only evaluate governance and safety policies for tool-level gating
      if (pol.category !== 'governance' && pol.category !== 'safety') continue;
      // Only care about deny and require_approval for tool gating
      if (pol.effect !== 'deny' && pol.effect !== 'require_approval') continue;

      // FAIL-CLOSED: reach resolution failed/timed out AND this specific
      // policy depends on reach.* — treat as a forced match rather than
      // letting evaluateCondition silently read `undefined` and return
      // false, which would be indistinguishable from "evaluated, no match".
      if (ctx._reach && ctx._reach.available === false && conditionReferencesReach(pol.conditions)) {
        console.warn(`[ApprovalGate] reach unavailable — failing closed on policy ${pol.id}`);
        return { policy: pol, effect: pol.effect };
      }

      if (evaluateCondition(pol.conditions, toolCtx)) {
        return { policy: pol, effect: pol.effect };
      }
    }

    return { policy: null, effect: null };
  } catch (err) {
    // QUOXTRUST T2: the store threw (locked/corrupt/schema error). Same as the
    // !_voltDb case above — we could not evaluate, so signal unavailable rather
    // than swallowing the error into a false "no rule -> allow".
    console.warn('[ApprovalGate] Store policy check failed:', err.message);
    return { policy: null, effect: null, unavailable: true };
  }
}

// QUOXTRUST T2 (D2): when the policy store is unavailable (checkStorePolicies
// returned { unavailable: true }) a caller must fail CLOSED for consequential
// tools. Safety is decided by a POSITIVE ALLOWLIST — a tool is safe to allow
// through an outage ONLY if its name matches toolDoctor's read-only suffix set
// (_status/_list/_get/_read/_search/...) AND contains no destructive verb
// (mirroring toolDoctor.classify's precedence: a destructive verb disqualifies
// even when a read-only suffix also matches). We reuse toolDoctor's own exported
// regexes rather than classify(), because classify() also requires a live
// executor def we don't have on this path. Everything else — destructive, or
// unrecognised/new — is NOT safe. Using an allowlist (never a denylist) means a
// newly-added tool with an unfamiliar name defaults to fail-closed under outage,
// so this gap cannot silently reappear as the tool surface grows. If the
// classifier itself cannot be loaded, fail closed.
function isSafeUnderPolicyOutage(toolName) {
  try {
    const { READ_ONLY, DESTRUCTIVE } = require('./toolDoctor');
    const name = String(toolName || '');
    if (DESTRUCTIVE.test(name)) return false;
    return READ_ONLY.test(name);
  } catch {
    return false;
  }
}

/**
 * Check if an action requires approval by testing against:
 * 1. GOV-4 store policies (governance + safety categories)
 * 2. Legacy QuoxFlow inline policy (fallback)
 *
 * @param {string} toolName - Tool identifier (e.g., 'proxmox_vm_action')
 * @param {object} input - The tool input to evaluate
 * @param {object} ctx - Execution context (agentId, orgId)
 * @returns {{ allowed: boolean, requiresApproval: boolean, approvalId?: string, reason?: string, error?: string }}
 */
async function checkApproval(toolName, input, ctx = {}) {
  // Per-agent identity gate, checked before GOV-4 store policies and the
  // legacy destructive-action check, since it does not depend on either
  // being configured. See AGENT_GATED_TOOLS above.
  //
  // P0b DEC-1 sandbox exception: the per-agent allowlist gate stays
  // UNCONDITIONAL (triage-q/bob/forge/concierge never resolve directly, sandbox
  // or not). Only the broader every-agent approval-RESOLUTION gate is bypassed,
  // and only under an ACTIVE SANDBOX GRANT: the auth service reports the
  // instance as disposable_test:true AND holding an unexpired test-approver
  // lease (DEC-4 + unhackability property 5, leased not latched) — both
  // whole-instance properties read server-side, NEVER from ctx or tool input,
  // since an agent able to set its own sandbox flag or lease could unlock its
  // own veto. Real instances are unchanged: the lookup fails safe to "locked".
  // Evaluated lazily so the hot path (ordinary tools, no resolution gate) never
  // makes the auth call.
  let agentGateApplies = isAgentGated(toolName, ctx);
  if (!agentGateApplies && isApprovalResolutionByAgent(toolName, ctx)) {
    const grantActive = await hasActiveSandboxApprovalGrant();
    agentGateApplies = !grantActive;
    if (grantActive) {
      // DEC-4 request/perform split: the agent only REQUESTED this
      // resolution; the collector PERFORMS it as the synthetic test-approver.
      // Rewriting the shared input object here, at the decision point, is
      // deliberate — the executor closure holds the same reference, so
      // whatever executes after this gate carries the synthetic principal and
      // the AGENT-DRIVEN-TEST-APPROVAL stamp, never an agent-chosen identity
      // (input.approver is agent-supplied and could name any human).
      const agentKey = String(ctx.agentId ?? '').trim().toLowerCase();
      input.approver = TEST_APPROVER_PRINCIPAL;
      if (toolName === 'deny_request') {
        input.reason = annotateTestApproval(input.reason, agentKey);
      } else {
        input.comment = annotateTestApproval(input.comment, agentKey);
      }
      console.log(`[ApprovalGate] sandbox grant active: performing ${toolName} as ${TEST_APPROVER_PRINCIPAL} (driven by agent ${agentKey})`);
    }
  }

  // CONTACTSQ P1: the standing-grant boundary. Evaluated server-side from the trusted
  // ctx (orgId, agentId) and the tool's own shape; the grant is recorded in a private
  // WeakMap keyed by this input OBJECT (contactsq/grants.js), so no input field can
  // name or claim one. No grant, over cap, or any error -> the proposal path below.
  if (agentGateApplies && CONTACTSQ_LEASE_TOOLS.has(toolName)) {
    try {
      const contactsGrants = require('./contactsq/grants.js');
      const grant = contactsGrants.coversToolCall(toolName, ctx.orgId, ctx.agentId, input);
      if (grant) {
        contactsGrants.reserve(input, grant, ctx.orgId, ctx.agentId);
        console.log(`[ApprovalGate] contactsq standing grant ${grant.id} covers ${toolName} by ${ctx.agentId} (org ${ctx.orgId})`);
        agentGateApplies = false;
      }
    } catch (e) {
      console.warn('[ApprovalGate] contactsq grant lookup failed (falling back to a proposal):', e && e.message);
    }
  }

  // APPROVAL-SPAM 4/6: the human driving this conversation asked for it, no
  // new outside content has been read since, and it is neither destructive nor
  // outward: their request is the approval. Only the per-agent propose gate is
  // skipped; org store policies below still apply.
  if (agentGateApplies && (AGENT_ALWAYS_PROPOSE_TOOLS.has(toolName) || isNotesqPropose(toolName, ctx))) {
    const human = directRequestAuthorizes(toolName, input, ctx);
    if (human) {
      console.log(`[ApprovalGate] direct request: ${toolName} by ${ctx.agentId || '?'} authorized by human ${human.userId} driving conversation ${String(ctx.conversationId || ctx.session_id).slice(0, 40)} (org ${human.orgId})`);
      if (typeof ctx.emitEnvelope === 'function') {
        try { ctx.emitEnvelope({ intent: 'quox.approval.direct_request', payload: { tool: toolName, agent: ctx.agentId || null, human: human.userId, conversation: ctx.conversationId || ctx.session_id || null } }); } catch { /* evidence never blocks */ }
      }
      agentGateApplies = false;
    }
  }

  if (agentGateApplies) {
    const proposal = buildAgentGateProposal(toolName, input, ctx);
    // #625: fold the caller's reason/related-to into the card body so no human
    // approves blind, uniformly across every gated tool.
    proposal.bodyMd = appendRequestContext(proposal.bodyMd, input);
    try {
      const approval = await createApprovalRequest(toolName, input, {
        // F3 (first .131 drive, 2026-08-15): QuoxFlow's create schema
        // REQUIRES trigger.policyId/ruleId/condition as strings
        // (quoxflow approvals.ts:45-50). The previous
        // `{ agentGate: ctx.agentId }` 400'd on every call, so the
        // propose-not-resolve fallback never surfaced a proposal to a
        // human: fail-closed but un-approvable, the same class of bug the
        // entity-metadata branch hit in AGENT-OVERHAUL phase 7. The agent
        // identity now rides in trigger.context.
        trigger: {
          policyId: 'agent-propose-only-gate',
          ruleId: 'agent-gate',
          condition: `agent '${ctx.agentId}' proposed ${toolName}; a human must confirm`,
          context: { agentGate: String(ctx.agentId ?? '') },
        },
        approvers: ['admin'],
        timeout_ms: 3600000,
        title: proposal.title,
        bodyMd: proposal.bodyMd,
        targetId: proposal.targetId,
        reason: proposal.reason,
      }, ctx.orgId, ctx);
      return {
        allowed: false,
        requiresApproval: true,
        approvalId: approval.id,
        reason: `${ctx.agentId} proposed this action; a human must confirm before it executes.`,
      };
    } catch (err) {
      console.warn('[ApprovalGate] Agent-gate approval creation failed:', err.message);
      // F3 caveat (first .131 drive): a surfacing failure is NOT a creation
      // failure. When the inbox mint fails (e.g. a memberless org has no
      // assignable admin) the approval WAS filed in QuoxFlow and will
      // self-expire; reporting "could not be created" sent the tester
      // chasing the wrong bug. Fail closed either way, but say what
      // actually happened.
      const surfacing = String(err.message || '').startsWith('approval_surfacing_failed');
      return {
        allowed: false,
        requiresApproval: false,
        error: surfacing
          ? `Proposal filed in QuoxFlow but could not be surfaced to a human inbox: ${err.message}`
          : `Failed to create approval proposal: ${err.message}`,
        reason: surfacing
          ? 'Agent-gated action blocked; the proposal exists in QuoxFlow but no human-visible inbox item could be minted (check the org has an assignable admin). It will self-expire.'
          : 'Agent-gated action blocked; approval proposal could not be created.',
      };
    }
  }

  // AGENT-OVERHAUL-2 FIX 2 — entity tool static requiresApproval metadata.
  // Entity tools (loaded via entityToolLoader.js from src/config/entities/
  // tools/*.json) can declare requiresApproval:true on the tool itself.
  // Unlike GOV-4 store policies and the legacy destructive-action check
  // below (both optional/config-driven), a tool statically marked
  // requiresApproval in its own definition must always gate — it must not
  // silently execute just because no org happens to have configured a
  // matching policy. Checked unconditionally, same as the agent-identity
  // gate above (ctx._entityRequiresApproval is set only by
  // entityToolLoader.js's executor wrapper, never by caller input).
  if (ctx._entityRequiresApproval) {
    try {
      const approval = await createApprovalRequest(toolName, input, {
        // QuoxFlow /approvals requires trigger.policyId/ruleId/condition
        // (strings). The entity-metadata path previously sent only
        // {entityMetadata, defconLevel}, so QuoxFlow 400'd and the proposal
        // never reached a human — fail-closed but un-approvable. Supply the
        // required synthetic fields so entity requiresApproval tools file a
        // real, approvable proposal (AGENT-OVERHAUL phase 7).
        trigger: {
          policyId: 'entity-metadata-requires-approval',
          ruleId: 'entity-requires-approval',
          condition: `${toolName}.requiresApproval === true`,
          entityMetadata: 'requiresApproval',
          defconLevel: ctx._entityDefconLevel || null,
        },
        approvers: ['admin', 'group:infrastructure'],
        timeout_ms: 3600000,
      }, ctx.orgId, ctx);
      return {
        allowed: false,
        requiresApproval: true,
        approvalId: approval.id,
        reason: `${toolName} is marked requiresApproval in its entity definition; a human must approve before it executes.`,
      };
    } catch (err) {
      console.warn('[ApprovalGate] Entity-metadata approval creation failed:', err.message);
      // Fail closed: an entity tool marked requiresApproval must never fall
      // through to direct execution just because the approval mint failed.
      return {
        allowed: false,
        requiresApproval: false,
        error: `Failed to create approval proposal: ${err.message}`,
        reason: 'Entity tool requires approval; approval proposal could not be created.',
      };
    }
  }

  // LI-OVERHAUL P4 — connector tool static requiresApproval metadata. Same
  // contract as the entity branch above: a connector tool that declares
  // requiresApproval:true in its own definition (linkedin publish_post /
  // create_comment first) must ALWAYS gate, never silently execute because no
  // org happens to have a matching policy. ctx._connectorRequiresApproval is
  // set only by the bridge choke (connectors/bridge.js executeConnectorTool),
  // never by caller input. Fail closed on a failed mint.
  if (ctx._connectorRequiresApproval) {
    try {
      // P9: the connector tool's own approvalCard (title/bodyMd/payloadExtra,
      // built at the bridge choke) shapes the human-facing inbox item; the
      // synthetic trigger fields below stay the QuoxFlow contract either way.
      const card = ctx._connectorApprovalCard || null;
      const approval = await createApprovalRequest(toolName, input, {
        ...(card?.title ? { title: card.title } : {}),
        ...(card?.bodyMd ? { bodyMd: card.bodyMd } : {}),
        ...(card?.payloadExtra ? { payloadExtra: card.payloadExtra } : {}),
        trigger: {
          policyId: 'connector-tool-requires-approval',
          ruleId: 'connector-requires-approval',
          condition: `${toolName}.requiresApproval === true`,
          entityMetadata: 'requiresApproval',
          defconLevel: null,
        },
        approvers: ['admin', 'group:infrastructure'],
        timeout_ms: 3600000,
      }, ctx.orgId, ctx);
      return {
        allowed: false,
        requiresApproval: true,
        approvalId: approval.id,
        inboxItemId: approval.inbox_item_id || null,
        reason: `${toolName} is marked requiresApproval in its connector definition; a human must approve before it executes.`,
      };
    } catch (err) {
      console.warn('[ApprovalGate] Connector-metadata approval creation failed:', err.message);
      return {
        allowed: false,
        requiresApproval: false,
        error: `Failed to create approval proposal: ${err.message}`,
        reason: 'Connector tool requires approval; approval proposal could not be created.',
      };
    }
  }

  // quox#556 — agent_tool_assignments.access_mode. Per-agent, per-tool
  // control, CRUD-editable in auth (services/auth/routes/agents.js), was
  // stored but never read here: setting a tool to 'with_approval' on one
  // agent's assignment gated nothing. Checked unconditionally, same
  // discipline as the entity/connector static-metadata gates above — an org
  // admin's per-agent override must not depend on the tool's own JSON
  // definition or on an org happening to have a matching GOV-4 policy.
  // ADDITIVE ONLY: this block is unreachable once an earlier gate above has
  // already returned requiresApproval:true, so it can only ever ADD a gate,
  // never clear or downgrade one. access_mode 'full' (or no DB assignment at
  // all — hardcoded-only tools) falls straight through, unchanged.
  // TODO(#556 follow-up): 'read_only' write-blocking is a separate,
  // non-HITL enforcement and is intentionally NOT handled here.
  //
  // quox#556 SECOND fail-open, closed 2026-09-25: getAccessModeForAgentTool
  // used to return null (== "no assignment", falls through unchanged) both
  // when a tool genuinely had no override AND when the underlying auth DB
  // lookup itself failed — indistinguishable, and the failure result was
  // cached for DB_TOOL_CACHE_TTL (60s), so an auth-service blip silently
  // stopped enforcing a real 'with_approval' override for up to 60s per
  // agent, re-armed by every subsequent blip. getAccessModeForAgentTool now
  // returns the sentinel 'unknown' on a DB-lookup failure (never cached);
  // 'unknown' is treated the SAME as 'with_approval' below — fail closed —
  // while a genuine no-assignment ('full'/null from a SUCCESSFUL lookup)
  // still falls through unchanged, so this is additive only, same as the
  // rest of this block.
  try {
    const { getAccessModeForAgentTool } = require('./agentTools.js');
    // Same normalization as isAgentGated/isApprovalResolutionByAgent above —
    // String()+trim()+toLowerCase() so a non-string, padded, or mixed-case
    // ctx.agentId can never dodge this gate the way a bare lookup would.
    const agentKey = String(ctx.agentId ?? '').trim().toLowerCase();
    const accessMode = await getAccessModeForAgentTool(agentKey, toolName);
    if (accessMode === 'with_approval' || accessMode === 'unknown') {
      const isUnknown = accessMode === 'unknown';
      const approval = await createApprovalRequest(toolName, input, {
        trigger: {
          policyId: 'agent-tool-assignment-access-mode',
          ruleId: isUnknown ? 'access-mode-unknown-dblookup-failed' : 'access-mode-with-approval',
          condition: isUnknown
            ? `agent_tool_assignments lookup failed for agent '${ctx.agentId}' on ${toolName}; access_mode unknown, blocked closed`
            : `agent_tool_assignments.access_mode === 'with_approval' for agent '${ctx.agentId}' on ${toolName}`,
        },
        approvers: ['admin', 'group:infrastructure'],
        timeout_ms: 3600000,
      }, ctx.orgId, ctx);
      return {
        allowed: false,
        requiresApproval: true,
        approvalId: approval.id,
        inboxItemId: approval.inbox_item_id || null,
        reason: isUnknown
          ? `${toolName}'s access_mode could not be resolved for ${ctx.agentId} (auth-service lookup failed); blocked closed and a human must approve.`
          : `${toolName} is set to 'with_approval' for ${ctx.agentId}; a human must approve before it executes.`,
      };
    }
  } catch (err) {
    console.warn('[ApprovalGate] access_mode lookup/approval creation failed:', err.message);
    return {
      allowed: false,
      requiresApproval: false,
      error: `Failed to check/create access_mode approval: ${err.message}`,
      reason: 'access_mode lookup or approval proposal creation failed; blocked closed.',
    };
  }

  // QUOX-SECURITY Phase 0: engagement-scope pre-check. Set only when a
  // caller is executing a capability under an active security engagement
  // (ctx._securityEngagement = {engagementId, orgId, targetValue,
  // capabilityRisk}, wired by a future Phase 1 capability-executor, never
  // by caller input directly — same discipline as ctx._entityRequiresApproval
  // above). Checked unconditionally, before the optional/config-driven GOV-4
  // and legacy gates below, since an out-of-scope or unverified target must
  // never even reach those. This gate only narrows access relative to the
  // gates below, it never grants access those gates would otherwise deny.
  if (ctx._securityEngagement) {
    const { checkEngagementPolicy } = require('./securityEngagement.js');
    const { engagementId, orgId: engOrgId, targetValue, capabilityRisk } = ctx._securityEngagement;
    let decision;
    try {
      decision = checkEngagementPolicy(
        { engagementId, orgId: engOrgId, targetValue, capabilityRisk },
        { db: _securityDb }
      );
    } catch (err) {
      // Fail closed: a policy-check error (malformed capabilityRisk, a
      // caller bug, no security.db wired) must never fall through to
      // direct execution.
      return {
        allowed: false,
        requiresApproval: false,
        error: `Engagement policy check failed: ${err.message}`,
        reason: 'Security engagement policy check errored; blocked closed.',
      };
    }

    if (!decision.allowed) {
      // Blocked regardless of whether it would also need approval once
      // unblocked — report the actual blocking reason, never a false
      // approval prompt for something that cannot run yet.
      return { allowed: false, requiresApproval: false, reason: decision.reason };
    }
    if (decision.requiresApproval) {
      try {
        const approval = await createApprovalRequest(toolName, input, {
          trigger: {
            policyId: 'security-engagement-risk-tier',
            ruleId: 'engagement-requires-approval',
            condition: 'capabilityRisk >= intrusive',
            engagementId,
            targetValue,
            capabilityRisk,
          },
          approvers: ['admin', 'group:security'],
          timeout_ms: 3600000,
        }, engOrgId, ctx);
        return {
          allowed: false,
          requiresApproval: true,
          approvalId: approval.id,
          reason: `Capability risk "${capabilityRisk}" against engagement ${engagementId} requires approval before it executes.`,
        };
      } catch (err) {
        console.warn('[ApprovalGate] Security-engagement approval creation failed:', err.message);
        return {
          allowed: false,
          requiresApproval: false,
          error: `Failed to create approval proposal: ${err.message}`,
          reason: 'Security engagement requires approval; approval proposal could not be created.',
        };
      }
    }
    // decision.allowed && !decision.requiresApproval: fall through to the
    // gates below, which still apply on top of this one.
  }

  // GOV-4: Check store policies first (always, regardless of APPROVAL_ENABLED)
  const storeResult = await checkStorePolicies(toolName, input, ctx);
  if (storeResult.policy) {
    if (storeResult.effect === 'deny') {
      return {
        allowed: false,
        requiresApproval: false,
        reason: storeResult.policy.reason || `Denied by policy: ${storeResult.policy.name}`,
        policyId: storeResult.policy.id,
      };
    }
    if (storeResult.effect === 'require_approval') {
      // Use the bastion approval system for creating approval requests
      try {
        const approval = await createApprovalRequest(toolName, input, {
          // F3 sibling: this branch carried policyId but not the ruleId and
          // condition strings QuoxFlow's schema also requires, so a
          // configured require_approval store policy 400'd at proposal time
          // and fell through the catch below toward the legacy path.
          trigger: {
            policyId: storeResult.policy.id,
            ruleId: 'store-policy-require-approval',
            condition: `policy '${storeResult.policy.name}' (${storeResult.policy.id}) matched ${toolName}`,
            context: { policyName: storeResult.policy.name },
          },
          approvers: ['admin', 'group:infrastructure'],
          timeout_ms: 3600000,
        }, ctx.orgId, ctx);
        return {
          allowed: false,
          requiresApproval: true,
          approvalId: approval.id,
          reason: storeResult.policy.reason || `Requires approval per policy: ${storeResult.policy.name}`,
          policyId: storeResult.policy.id,
        };
      } catch (err) {
        // QUOXTRUST T2 (D2) — FAIL CLOSED. This branch means a GOV-4 policy
        // MATCHED require_approval; the mint failing (e.g. approvals service down)
        // must NOT downgrade a matched approval requirement to "allowed". The old
        // "fall through to legacy check" here was a live fail-OPEN: for a
        // NON-destructive tool the legacy path early-returned allowed:true, so a
        // matched require_approval policy + approvals outage let the effect run
        // unapproved (hit every withApprovalGate consumer via checkApproval).
        // Mirror the store-unavailable block below: hold closed, never fall through.
        console.warn(`[ApprovalGate] require_approval policy '${storeResult.policy.name}' matched but approval mint failed for ${toolName} (blocking closed): ${err.message}`);
        return {
          allowed: false,
          requiresApproval: false,
          error: `Approval required by policy '${storeResult.policy.name}' but could not be surfaced: ${err.message}`,
          reason: storeResult.policy.reason
            || `Requires approval per policy '${storeResult.policy.name}'; blocked (fail-closed) because the approval could not be created.`,
          policyId: storeResult.policy.id,
        };
      }
    }
  }

  // QUOXTRUST T2 (D2): the store could NOT be consulted (unavailable), which is
  // not the same as "no matching rule". Fail closed for consequential tools —
  // hold for human approval, exactly like a require_approval policy — rather
  // than sailing through the legacy early-returns below. AVAILABILITY TRADEOFF:
  // while the policy store is down, every non-read tool is gated for approval,
  // the same accepted tradeoff as the access_mode (~:848) and legacy-catch
  // (~:1095) fail-closed paths. Read-only tools stay available (allowlist).
  if (storeResult.unavailable && !isSafeUnderPolicyOutage(toolName)) {
    try {
      const approval = await createApprovalRequest(toolName, input, {
        trigger: {
          policyId: 'store-unavailable',
          ruleId: 'quoxtrust-t2-store-unavailable-fail-closed',
          condition: `governance policy store unavailable while gating ${toolName}`,
        },
        approvers: ['admin', 'group:infrastructure'],
        timeout_ms: 3600000,
      }, ctx.orgId, ctx);
      return {
        allowed: false,
        requiresApproval: true,
        approvalId: approval.id,
        reason: `Governance policy store unavailable; ${toolName} requires human approval (fail-closed).`,
      };
    } catch (err) {
      console.warn(`[ApprovalGate] store unavailable and approval mint failed for ${toolName} (blocking closed): ${err.message}`);
      return {
        allowed: false,
        requiresApproval: false,
        error: `Policy store unavailable and approval could not be surfaced: ${err.message}`,
        reason: `Governance policy store unavailable; ${toolName} blocked (fail-closed).`,
      };
    }
  }

  // Legacy: QuoxFlow-based approval (only if the flag resolves on for this org)
  if (!isApprovalEnabled(ctx.orgId)) {
    return { allowed: true, requiresApproval: false };
  }

  // Only gate destructive actions via legacy path
  if (!DESTRUCTIVE_ACTIONS.has(input.action)) {
    return { allowed: true, requiresApproval: false };
  }

  try {
    // Test against the inline Proxmox policy
    const policy = buildProxmoxPolicy(input);
    const result = await quoxflowFetch('/policies/test', {
      method: 'POST',
      body: JSON.stringify({
        policy,
        input,
        variables: { toolName },
      }),
    }, ctx.orgId);

    if (!result) {
      return { allowed: true, requiresApproval: false };
    }

    if (result.decision === 'deny') {
      return {
        allowed: false,
        requiresApproval: false,
        reason: result.reason || 'Action denied by policy',
      };
    }

    if (result.decision === 'pending_approval') {
      // Fail CLOSED on approval-creation/surfacing errors, same discipline
      // as the outer catch below (quox#556 residual fix) — once policy has
      // said pending_approval, an error minting or surfacing that approval
      // must never fall through to open.
      let approval;
      try {
        approval = await createApprovalRequest(toolName, input, result.pendingApproval, ctx.orgId, ctx);
      } catch (err) {
        console.warn('[ApprovalGate] approval creation/surfacing failed on destructive path (blocking closed):', err.message);
        return {
          allowed: false,
          requiresApproval: false,
          error: `Failed to create approval request: ${err.message}`,
          reason: 'Action requires approval; the approval request could not be surfaced to a human. Blocked.',
        };
      }
      return {
        allowed: false,
        requiresApproval: true,
        approvalId: approval.id,
        reason: `Action requires approval. Approval ID: ${approval.id}`,
      };
    }

    return { allowed: true, requiresApproval: false };
  } catch (err) {
    // quox#556 residual fix (2026-09-25): this branch used to ALLOW the
    // destructive action through on ANY error reaching this point —
    // QuoxFlow unreachable, timed out, or erroring — logged as "allowing
    // action". That is the exact fail-open the access_mode gate above
    // (~line 848) and the pending_approval branch above already refuse to
    // repeat. We only reach this catch for DESTRUCTIVE actions (see the
    // DESTRUCTIVE_ACTIONS.has(input.action) guard above this try), so
    // failing closed here can never block a safe/non-destructive action —
    // only the error/unreachable-dependency case flips from allow to block.
    //
    // AVAILABILITY TRADEOFF: while the legacy QuoxFlow policy-check
    // dependency is down or erroring, destructive Proxmox actions (stop,
    // reboot, shutdown, remove, delete, kill) are now BLOCKED rather than
    // allowed through. That is the correct security direction (a policy
    // outage must not silently unlock destructive ops) but it does mean a
    // QuoxFlow outage now blocks destructive actions that would previously
    // have proceeded unchecked.
    console.error('[ApprovalGate] QuoxFlow check failed, blocking closed (quox#556):', err.message);
    return {
      allowed: false,
      requiresApproval: false,
      error: `Approval check failed: ${err.message}`,
      reason: 'QuoxFlow policy check unreachable or errored for a destructive action; blocked closed (quox#556).',
    };
  }
}

/**
 * Build an inline Proxmox policy for testing.
 * This is the policy definition sent to QuoxFlow's /policies/test endpoint.
 */
function buildProxmoxPolicy(input) {
  return {
    id: 'proxmox-destructive-actions',
    name: 'Proxmox Destructive Action Approval',
    version: '1.0',
    scope: { nodeTypes: ['*'] },
    rules: [
      {
        id: 'require-approval-destructive',
        name: `Require approval for ${input.action}`,
        condition: `\${input.action === 'stop' || input.action === 'reboot' || input.action === 'shutdown'}`,
        action: {
          type: 'require_approval',
          approvers: ['admin', 'group:infrastructure'],
          timeout_ms: 3600000,
        },
        message: `${input.action} action on ${input.type || 'qemu'}/${input.vmid} at ${input.node} requires approval`,
      },
      {
        id: 'allow-safe',
        name: 'Allow non-destructive actions',
        condition: 'true',
        action: { type: 'allow' },
      },
    ],
    enabled: true,
    priority: 100,
  };
}

/**
 * Create an approval request in QuoxFlow.
 *
 * HITL approve→execute bridge: once QuoxFlow confirms the approval request,
 * this also mints a crypto-random resume_token + a resumable `pending` row
 * in toolApprovalStore (so a human approval can actually re-execute the
 * gated tool call), and best-effort mints an inbox item on the auth service
 * carrying the approval id as aee_correlation_id. Both are non-fatal: a
 * failure here never blocks the approval request itself — it just means the
 * legacy `_approvalId` poll path in withApprovalGate is the only way to
 * resume, and/or no inbox item exists for a human to act on.
 *
 * @param {string} toolName
 * @param {object} input
 * @param {object} pendingApproval - From policy evaluation result
 * @param {string} [orgId] - Org context the approval gate is operating under
 * @param {object} [ctx] - Execution context (agentId, userId) — needed to persist the resumable row
 * @returns {Promise<object>} The created approval request
 */
async function createApprovalRequest(toolName, input, pendingApproval, orgId = null, ctx = {}) {
  // APPROVAL-SPAM 2/6 (owner yes 2026-10-03): the same command proposed again
  // in the same conversation (often by a delegated agent re-trying what its
  // parent already asked for) reuses the pending approval instead of minting a
  // second card. One card, one decision; approving it resumes the original.
  try {
    const _stripped = { ...input }; delete _stripped._approvalId; delete _stripped._resumeToken;
    const dup = toolApprovalStore.findPendingDuplicate({
      org_id: orgId, tool_name: toolName, input_json: JSON.stringify(_stripped),
      conversation_id: ctx?.conversationId || ctx?.session_id || null,
    });
    if (dup) {
      console.log(`[ApprovalGate] dedupe: ${toolName} by ${ctx?.agentId || '?'} reuses pending approval ${dup.approval_id}`);
      return { id: dup.approval_id, deduplicated: true };
    }
  } catch (e) {
    // A failed lookup must never block an approval from being created.
    console.warn('[ApprovalGate] dedupe lookup failed (creating a fresh approval):', e && e.message);
  }
  const request = {
    correlationId: `approval-${toolName}-${Date.now()}`,
    workflowId: 'native-tool-execution',
    workflowName: `Native Tool: ${toolName}`,
    executionId: `exec-${Date.now()}`,
    nodeId: toolName,
    trigger: pendingApproval?.trigger || {
      policyId: 'proxmox-destructive-actions',
      ruleId: 'require-approval-destructive',
      condition: `action === '${input.action}'`,
    },
    approvers: pendingApproval?.approvers || ['admin', 'group:infrastructure'],
    timeoutMs: pendingApproval?.timeout_ms || 3600000,
    metadata: {
      toolName,
      action: input.action,
      vmid: input.vmid,
      node: input.node,
      type: input.type || 'qemu',
      // Agent-gated proposals (e.g. TRIAGE-Q approve/deny) carry the target
      // item id + the reason the agent gave, so the human confirming it has
      // the same context. Absent for non-gated tool calls.
      target_id: pendingApproval?.targetId ?? input.approval_id ?? undefined,
      reason: pendingApproval?.reason ?? input.reason ?? input.comment ?? undefined,
      proposedBy: ctx?.agentId ?? undefined,
      requestedAt: new Date().toISOString(),
      // TRUST-PROOF twin-item fix (FND_01M2XM4SJH...): this gate mints the
      // human-facing inbox item itself (the resumable native_tool_approval
      // shape below), so QuoxFlow's onApprovalCreated hook must NOT mint a
      // second, dead twin for the same approval.
      suppress_inbox: true,
    },
  };

  // BLAST-RADIUS-P1: computed blast-radius summary, attached BEFORE the
  // QuoxFlow POST so it's carried in request.metadata.reach as well as the
  // inbox mint below. Dark until server.js wires setReachEvaluator(); org
  // opt-out via REACH_BANDS_ON_APPROVALS. try/caught on top of
  // computeActionRadius's own never-throws contract — this gate's whole
  // point is that an approval is ALWAYS created, reach summary or not.
  let reach = null;
  if (reachEvaluator && isReachBandsEnabled(orgId)) {
    try {
      // BLAST-RADIUS-P2: pass the approval's own correlationId through so the
      // witnessed quox.reach.evaluate envelope for this evaluation shares the
      // same corr as the approval request itself (request.correlationId,
      // minted above), rather than a synthetic one.
      reach = await reachEvaluator({ toolName, input, agentId: ctx?.agentId, orgId, correlationId: request.correlationId });
    } catch (e) {
      reach = { status: 'unavailable', error: (e && e.message) || String(e) };
    }
  }
  if (reach) {
    request.metadata.reach = reach;
  }

  // HITL-CONTEXT (owner 2026-10-07): who is asking, on whose behalf, why, how,
  // and what stopped it, captured NOW and persisted with the item so the card
  // still reads hours later. Best-effort: a context failure never blocks the
  // approval (the gate's whole point is that an approval is ALWAYS created).
  let approvalContext = null;
  try {
    const conv = ctx?.conversationId || ctx?.session_id || ctx?.sessionId || null;
    const turn = conv ? approvalTurnContext.getTurn(conv, orgId) : null;
    // A bare user id on the card is useless to the approver: resolve the
    // display name (auth lookup, cached, best-effort). The id stays in the
    // stored context (requested_by.caller.user_id).
    let ctxForCard = ctx;
    const uid = ctx?.holderUserId || ctx?.userId;
    if (uid && !ctx?.userName) {
      const dn = await resolveUserDisplayName(orgId, uid);
      if (dn) ctxForCard = { ...ctx, userName: dn };
    }
    approvalContext = buildApprovalContext({
      toolName, input, pendingApproval, ctx: ctxForCard, turn, reach,
      delegationChainFor: approvalTurnContext.delegationChainFor,
    });
    request.metadata.approval_context = approvalContext;
  } catch (e) {
    console.warn('[ApprovalGate] approval context build failed (continuing without it):', e && e.message);
  }

  const approval = await quoxflowFetch('/approvals', {
    method: 'POST',
    body: JSON.stringify(request),
  }, orgId);

  // Persist the resumable row — resume_token is a crypto-random secret,
  // stored ONLY here, NEVER returned to any client/LLM/response.
  //
  // QUOXTRUST T2 (C1 rule 7) — persist failure is FAIL-CLOSED and refuses BEFORE
  // the inbox mint below. The old catch logged "non-fatal" and continued, minting
  // a human-visible card whose approval could never resume (the resume path dies
  // at the stored-row lookup) — an un-executable zombie the approver believes in.
  // Codex plan-challenge B-list item 3, 2026-09-28.
  try {
    if (approval && approval.id) {
      const resumeToken = crypto.randomBytes(24).toString('hex');
      const strippedInput = { ...input };
      delete strippedInput._approvalId;
      delete strippedInput._resumeToken;
      toolApprovalStore.putPending({
        approval_id: approval.id,
        org_id: orgId,
        agent_id: ctx?.agentId || null,
        user_id: ctx?.userId || null,
        tool_name: toolName,
        input_json: JSON.stringify(strippedInput),
        resume_token: resumeToken,
        // QUOXHAT #657 (H1): persist the gating conversation so the resume
        // recheck re-resolves THIS conversation's bound hat, not the org default.
        conversation_id: ctx?.conversationId || ctx?.session_id || null,
      });
    }
  } catch (e) {
    throw new Error(`resumable approval persist failed (refusing before any human-visible card is minted): ${e && e.message}`);
  }

  // Inbox mint — the human-visible surface of this approval. HARD dependency
  // (BASTION-CRED Phase 3): if no inbox item exists, the approval is pending
  // in QuoxFlow but no human can ever see or act on it (the resume_token is
  // never returned to clients), so a mint failure must fail the approval
  // request loudly rather than mint a zombie. The orphaned QuoxFlow approval
  // self-expires via timeoutMs. Skipped entirely when there is no orgId
  // (legacy `_approvalId` poll path, unchanged).
  //
  // The title carries a per-approval suffix because the auth inbox dedupes
  // identical (title, kind) within 30 minutes (services/auth/routes/inbox.js)
  // and returns 200 {deduplicated:true} — which used to silently swallow
  // every repeat approval for the same tool. Same convention as
  // qlusterDelegate.js's correlation-suffixed titles.
  if (approval && approval.id && orgId) {
    let mintFailure = null;
    {
      const legacyTitle = pendingApproval?.title || `Approval required — ${toolName} (${input.action || 'action'})`;
      const baseTitle = approvalContext ? buildContextTitle(approvalContext, legacyTitle, toolName) : legacyTitle;
      // quox#562: mechanics live in lib/inboxMint.js (never throws). This
      // site keeps its OWN dedup semantics: a dedup 200 is a FAILURE here,
      // because the existing item carries a DIFFERENT approval's id and
      // approving it cannot resume this call.
      const r = await mintInboxItem({
        orgId,
        title: `${baseTitle} · ${String(approval.id).slice(-6)}`,
        bodyMd: (approvalContext ? renderContextMarkdown(approvalContext) : '') + (pendingApproval?.bodyMd || (
          `**${toolName}** requires approval before it can run.\n\n` +
          `Action: \`${input.action || 'n/a'}\`` +
          (input.vmid ? `\nVM: ${input.vmid}` : '') +
          (input.node ? `\nNode: ${input.node}` : '') +
          (input.container_id ? `\nContainer: ${input.container_id}` : '') +
          (input.host ? `\nHost: ${input.host}` : '')
        )) + buildReachMarkdown(reach),
        kind: 'approval',
        priority: 'high',
        aeeCorrelationId: approval.id,
        payload: {
          // P9: payloadExtra lets the caller add typed card data (e.g. the
          // linkedin post preview) — spread FIRST so it can never overwrite
          // type/toolName, which the approve→resume dispatch keys on.
          ...(pendingApproval?.payloadExtra && typeof pendingApproval.payloadExtra === 'object' ? pendingApproval.payloadExtra : {}),
          type: 'native_tool_approval',
          toolName,
          action: input.action,
          ...(pendingApproval?.targetId ? { targetId: pendingApproval.targetId } : {}),
          // BLAST-RADIUS-P1: the same computed summary attached to
          // request.metadata.reach above, mirrored here so the inbox card
          // (and anything reading payload directly) sees it without a
          // round trip back to QuoxFlow.
          ...(reach ? { reach } : {}),
          // HITL-CONTEXT: the structured block the Approvals card, `quox inbox
          // show` and notification fan-out all render from.
          ...(approvalContext ? { approval_context: approvalContext } : {}),
        },
      }, { authBaseUrl: AUTH_SERVICE_URL, serviceKey: INTERNAL_SERVICE_KEY });
      if (!r.ok) {
        mintFailure = r.error;
      } else if (r.deduplicated) {
        mintFailure = `inbox dedup suppressed the item (existing_item_id=${r.itemId}); this approval would be invisible`;
      } else if (r.itemId) {
        // P9: hand the minted item id back so pending responses can point a
        // human straight at the card ("inbox item X") the way xTools does.
        approval.inbox_item_id = r.itemId;
      }
    }
    if (mintFailure) {
      console.error(`[ApprovalGate] approval_surfacing_failed for ${toolName} (approval ${approval.id}): ${mintFailure}`);
      throw new Error(`approval_surfacing_failed: ${mintFailure}. The approval was filed in QuoxFlow (${approval.id}) but no human-visible inbox item exists; it will expire on its own. Retry the tool call to re-request approval.`);
    }
  }

  // REACTIONS-AS-HITL: best-effort proposal post into the originating Matrix
  // room. ctx.session_id is stamped "matrix_<roomId>" by the appservice's
  // collectorBrain.js for every Matrix-sourced chat turn (same convention
  // other ctx.session_id / ctx.sessionId reads in agentTools.js already
  // rely on). When this approval was minted from such a turn, push a
  // proposal into that room so hitlReaction.js's 👍/👎 lookup can actually
  // resolve a human's reaction, instead of always missing. Never blocks or
  // fails the approval mint, this is a notification, not part of the
  // approval's own durability.
  try {
    const sessionId = ctx?.session_id || ctx?.sessionId || null;
    if (approval && approval.id && typeof sessionId === 'string' && sessionId.startsWith('matrix_')) {
      const appserviceUrl = process.env.APPSERVICE_HITL_URL;
      const appserviceKey = process.env.APPSERVICE_HITL_KEY;
      if (!appserviceUrl || !appserviceKey) {
        console.log('[ApprovalGate] Matrix-sourced approval but APPSERVICE_HITL_URL/APPSERVICE_HITL_KEY unset, skipping room proposal post.');
      } else {
        const roomId = sessionId.slice('matrix_'.length);
        const r = await fetch(`${appserviceUrl}/internal/hitl/proposal`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Key': appserviceKey,
          },
          body: JSON.stringify({
            room_id: roomId,
            approval_id: approval.id,
            org_id: orgId,
            tool_name: toolName,
            agent_user_id: ctx.agentUserId || ctx.agentId || null,
            summary: (pendingApproval?.title || `Approval needed: ${toolName}`) + (approvalContext ? `\n${approvalContext.summary_line}` : ''),
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!r || !r.ok) {
          console.warn('[ApprovalGate] hitl proposal post returned', r && r.status);
        }
      }
    }
  } catch (e) {
    console.warn('[ApprovalGate] hitl proposal post failed (non-fatal):', e && e.message);
  }

  return approval;
}

/**
 * Check the status of an existing approval request.
 *
 * @param {string} approvalId
 * @param {string} [orgId] - Org context the approval gate is operating under
 * @returns {Promise<{ status: string, approved: boolean, denied: boolean, pending: boolean, approval: object }>}
 */
async function getApprovalStatus(approvalId, orgId = null) {
  const approval = await quoxflowFetch(`/approvals/${approvalId}`, {}, orgId);

  return {
    status: approval.status,
    approved: approval.status === 'approved',
    denied: approval.status === 'denied',
    pending: approval.status === 'pending',
    expired: approval.status === 'expired',
    approval,
  };
}

/**
 * Execute a tool action with approval gate.
 * Wraps a native executor with policy-based approval checking.
 *
 * @param {string} toolName - Tool identifier
 * @param {object} input - Tool input
 * @param {Function} executeAction - The actual executor function
 * @param {object} [ctx] - Execution context (agentId, orgId) — forwarded to quoxflow as X-Org-Id
 * @returns {Promise<object>} Execution result or approval-pending response
 */
async function withApprovalGate(toolName, input, executeAction, ctx = {}) {
  // HITL approve→execute bridge: the resume handler (toolResume.js)
  // re-invokes the gated tool carrying BOTH _approvalId and the
  // crypto-random _resumeToken minted at createApprovalRequest and stored
  // ONLY in the collector DB. Presence of the fields is NOT enough —
  // verifyToken() checks the token against the stored row (and that its
  // status is still executable) before allowing execution.
  if (input._approvalId && input._resumeToken) {
    const row = toolApprovalStore.verifyToken(input._approvalId, input._resumeToken);
    if (row) {
      // SEC: a verified token proves this caller holds the resume secret for
      // THIS approvalId, but says nothing about whether the input it is now
      // presenting is the input that was actually approved. Bind the two.
      const stored = getStoredInputFingerprint(input._approvalId);
      if (!stored.ok) {
        return inputMismatchResult(toolName, input._approvalId, `stored input unavailable (${stored.reason})`);
      }
      if (computeInputFingerprint(input) !== stored.fingerprint) {
        return inputMismatchResult(toolName, input._approvalId, 'input fingerprint mismatch');
      }
      // Bind the grant to the tool and org it was issued for (the token path is
      // already single-use: toolResume.js consumes the grant before re-invoking).
      const bindErr = grantBindingMismatch(stored.row, toolName, ctx, input._approvalId);
      if (bindErr) return bindErr;
      // QUOXTRUST C2: this IS the effect boundary for gated tools — stamp the
      // durable intent 'dispatched' immediately before the adapter fires.
      if (typeof ctx?._markDispatched === 'function') ctx._markDispatched();
      return executeAction();
    }
    // Invalid/mismatched token — fall through to the normal (legacy) handling below.
  }

  // Check if there's a pending approval ID in the input (re-invocation after approval)
  if (input._approvalId) {
    try {
      const status = await getApprovalStatus(input._approvalId, ctx.orgId);

      if (status.approved) {
        // SEC: QuoxFlow only confirms the approval id's STATUS ('approved'),
        // never what was approved. Bind to the stored proposal-time input
        // the same way the resume-token branch above does, so this legacy
        // poll path cannot be replayed with a different input either.
        const stored = getStoredInputFingerprint(input._approvalId);
        if (!stored.ok) {
          return inputMismatchResult(toolName, input._approvalId, `stored input unavailable (${stored.reason})`);
        }
        if (computeInputFingerprint(input) !== stored.fingerprint) {
          return inputMismatchResult(toolName, input._approvalId, 'input fingerprint mismatch');
        }
        // Bind the grant to the tool and org it was issued for.
        const bindErr = grantBindingMismatch(stored.row, toolName, ctx, input._approvalId);
        if (bindErr) return bindErr;

        // Single-use: consume the grant atomically so one human approval
        // authorises exactly one execution. approvalId is not a secret and the
        // QuoxFlow status stays 'approved', so without this the same id plus a
        // matching input could be replayed to execute again and again.
        // claimForResume flips pending -> resuming and returns null if the grant
        // was already claimed or finalised, in which case we must not execute.
        const claimed = toolApprovalStore.claimForResume(input._approvalId);
        if (!claimed) {
          return {
            success: false,
            error: 'This approval has already been used and cannot authorise another execution.',
            _approval: { id: input._approvalId, status: 'already_processed' },
          };
        }

        // Approved — execute the action, then record the terminal outcome so
        // the consumed grant reflects what happened.
        let result;
        try {
          // QUOXTRUST C2: effect boundary — stamp dispatched before the adapter.
          if (typeof ctx?._markDispatched === 'function') ctx._markDispatched();
          result = await executeAction();
        } catch (err) {
          toolApprovalStore.finalize(input._approvalId, 'error', JSON.stringify({ error: err && err.message }));
          throw err;
        }
        toolApprovalStore.finalize(
          input._approvalId,
          result && result.success === false ? 'error' : 'approved'
        );
        return {
          ...result,
          _approval: {
            id: input._approvalId,
            status: 'approved',
            approvedBy: status.approval.response?.approver,
          },
        };
      }

      if (status.denied) {
        return {
          success: false,
          error: `Action denied by ${status.approval.response?.approver || 'approver'}`,
          reason: status.approval.response?.comment || 'No reason provided',
          _approval: { id: input._approvalId, status: 'denied' },
        };
      }

      if (status.expired) {
        return {
          success: false,
          error: 'Approval request has expired',
          _approval: { id: input._approvalId, status: 'expired' },
        };
      }

      // Still pending
      return {
        success: false,
        pending: true,
        message: `Approval still pending. ID: ${input._approvalId}. Waiting for admin/infrastructure team approval.`,
        _approval: { id: input._approvalId, status: 'pending' },
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to check approval status: ${err.message}`,
        _approval: { id: input._approvalId, status: 'error' },
      };
    }
  }

  // No approval ID — check if approval is needed
  const check = await checkApproval(toolName, input, ctx);

  if (check.allowed) {
    // No approval needed — execute directly. QUOXTRUST C2: still the effect
    // boundary for an externalEffect tool whose gate waved it through.
    if (typeof ctx?._markDispatched === 'function') ctx._markDispatched();
    return executeAction();
  }

  if (check.requiresApproval) {
    // QUOXHAT MISSION D2 — record the pending approval in the turn-scoped registry
    // the moment it is created, keyed by the turn's session. This is the only
    // place the pending approval is reliably visible on the OAuth/CLI path: the
    // dispatcher records toolExecutions with result:null there, and on the phone
    // CommanderQ delegates so the gate fires in a specialist sub-turn (which
    // carries the orchestrator's session_id). The response builders read this back
    // path- and delegation-independently. Best-effort; never blocks the gate.
    try {
      const { recordPendingApproval } = require('./pendingApprovalRegistry');
      recordPendingApproval(ctx?.conversationId || ctx?.session_id || null, {
        approval_id: check.approvalId,
        inbox_item_id: check.inboxItemId || null,
        tool: toolName,
        summary: check.reason || `Approval required to run ${toolName}`,
        risk: null,
      });
    } catch (regErr) {
      console.warn('[ApprovalGate] pending-approval registry record failed (non-fatal):', regErr.message);
    }
    // Approval needed — return pending response
    return {
      success: false,
      pending: true,
      message: check.reason,
      approvalId: check.approvalId,
      // P9: point the caller at the actual human-visible card when the mint
      // returned its id (connector-gated tools do), matching the
      // status:'awaiting_approval' + inbox_item_id contract xTools set.
      ...(check.inboxItemId ? { status: 'awaiting_approval', inbox_item_id: check.inboxItemId } : {}),
      instructions: `This action requires approval. Approval request created with ID: ${check.approvalId}. ` +
        `An admin or infrastructure team member must approve this action. ` +
        `To check status or retry after approval, re-invoke with _approvalId: "${check.approvalId}".`,
      _approval: { id: check.approvalId, status: 'pending' },
    };
  }

  // Denied by policy
  return {
    success: false,
    error: check.reason || 'Action denied by policy',
  };
}

module.exports = {
  checkApproval,
  checkStorePolicies,
  isSafeUnderPolicyOutage,
  policiesReferenceReach,
  conditionReferencesReach,
  createApprovalRequest,
  getApprovalStatus,
  withApprovalGate,
  buildProxmoxPolicy,
  setDatabase,
  setSecurityDb,
  isApprovalEnabled,
  DESTRUCTIVE_ACTIONS,
  isAgentGated,
  NOTESQ_PROPOSE_TOOLS,
  isApprovalResolutionByAgent,
  AGENT_GATED_TOOLS,
  AGENT_ALWAYS_PROPOSE_TOOLS,
  CONTACTSQ_LEASE_TOOLS,
  buildAgentGateProposal,
  appendRequestContext,
  computeInputFingerprint,
  getStoredInputFingerprint,
  // BLAST-RADIUS-P1
  setReachEvaluator,
  isReachBandsEnabled,
  buildReachMarkdown,
  // quox#670 pin test
  grantBindingMismatch,
};
