'use strict';

/**
 * PLAN MODE (owner 2026-10-16): a turn the TUI sends with mode 'plan' investigates and proposes, and
 * changes nothing. Enforced here, not only in the prompt:
 *   - eligibility: turnEligibility({ plan: true }) treats the turn as a read whatever the words, and no
 *     role need or governed route reopens a state-changing tool;
 *   - call time: planRefusal() refuses any call that changes state (a write tool, a write action of a
 *     multi-action tool, an approval-gated tool, a hat switch, a delegation, a terminal suggestion of a
 *     state-changing slash command). The offer gate (API loops) and /api/v1/tools/execute (the CLI path,
 *     via the signed turn_mode claim) both consult it;
 *   - context: PLAN_MODE_NOTE tells the model what is expected.
 * Read tools still run, so the agent can investigate before it proposes.
 */

const PLAN_MODE_NOTE = 'PLAN MODE: propose the steps and the exact commands or tools; run nothing that changes state. '
  + 'You may use read tools to investigate. State-changing tools are not available on this turn and are refused if called. '
  + 'End with one short line: "To do this: switch to /mode ask and say go."';

// Terminal views the model may hand the TUI in plan mode: they show something and change nothing.
const READ_VIEWS = new Set(['approvals', 'mind', 'context', 'which', 'rooms', 'status', 'help', 'fleet', 'sitrep',
  'away', 'mirror', 'cost', 'usage', 'aocl', 'rules', 'skills', 'slots', 'overview', 'whats-new', 'tip', 'tips']);
// Views that are a read only when given no argument (with one they switch or change something).
const BARE_ONLY = new Set(['mode', 'agents', 'model', 'profile', 'org', 'resume', 'config']);

function isPlanMode(mode) {
  return typeof mode === 'string' && mode.trim().toLowerCase() === 'plan';
}

function suggestionIsRead(command) {
  const line = typeof command === 'string' ? command.trim() : '';
  if (!line.startsWith('/')) return false;
  const [word, ...rest] = line.slice(1).split(/\s+/);
  const w = String(word || '').toLowerCase();
  if (READ_VIEWS.has(w)) return true;
  return BARE_ONLY.has(w) && rest.filter(Boolean).length === 0;
}

// PLAN MODE is a FROZEN ALLOWLIST (WORKER2 review of c9143dfb2: the name heuristic admitted writes and probes,
// e.g. browser_monitor_check creates alerts, network_check port-scans, sectest_inspect_tls records a tool run).
// A tool is plan-eligible and permitted ONLY if it is named here. A new tool is plan-ineligible until someone adds
// it with a reason comment. test/planMode.test.js fails the build if a name here is not a real tool.
// Deliberately NOT here: browser_monitor_check (creates alerts), network_check (ping/traceroute/port scan),
// sectest_inspect_tls (records a tool run), uptime_check and security_certificate_check (outbound probes of
// caller-chosen targets; executor side effects unproven), and every write.
const PLAN_READS = new Set([
  // Evidence and audit trail reads (AEE, AOCL, VOLT, WARD): query and verify stored records, write nothing.
  'aee_get_stats', 'aee_query_envelopes', 'aocl_get_decisions', 'get_envelope_chain', 'list_evidence',
  'query_envelopes', 'volt_list_runs', 'ward_query_entries', 'ward_status', 'ward_verify',
  // Fleet, host and container status, logs and stats: read-only views, no exec.
  'alerts_history', 'box_health', 'core_health', 'docker_fleet_logs', 'docker_fleet_stats', 'docker_inspect',
  'docker_logs', 'docker_stats', 'docker_status', 'fleet_health_matrix', 'fleet_status', 'health_scan',
  'install_status', 'metrics_query', 'quoxagent_logs', 'quoxagent_status',
  'system_logs',
  // alerts_manage: READ_NAMES; its 'silence' action is refused per call (TOOL_WRITE_ACTIONS).
  'alerts_manage',
  // Proxmox read views (status, lists, read): no VM action, lease, clone or snapshot.
  'proxmox_backup_status', 'proxmox_cluster_status', 'proxmox_ha_status', 'proxmox_pool_status', 'proxmox_read',
  'proxmox_rehearsal_status', 'proxmox_snapshots_list', 'proxmox_templates_list',
  // Backup, keeper and build status/history/log reads: no backup run, no build dispatch.
  'backup_overview', 'backup_status', 'bob_build_history', 'bob_build_status', 'bob_log_tail', 'keeper_backup_list',
  'keeper_schedule_list',
  // Memory, brain and knowledge search/read: retrieval only.
  'brain_check', 'brain_context', 'brain_history', 'codebase_query', 'files_plugin_list', 'list_files',
  'memory_history', 'memory_search', 'quoxbrain_read', 'quoxbrain_search', 'read_file', 'recall', 'search_catalog',
  'search_files', 'session_search', 'spatial_search',
  // Workflows, executions, schedules, approvals and objectives: list/get reads.
  'commitment_list', 'get_execution', 'get_objective_results', 'get_workflow', 'hitl_queue', 'list_approvals',
  'list_executions', 'list_schedules', 'list_workflows', 'objective_checkpoints_pending', 'objective_counts',
  'objective_get', 'plan_artifact_diff', 'plan_artifact_get', 'roadmap_list', 'roadmap_show', 'roadmap_stats',
  // Inbox, mail, notes, contacts, calendar, chat: search/get/list reads. email_read fetches with BODY.PEEK (never sets \Seen).
  'calendar_coverage_status', 'calendar_event_get', 'calendar_layers_list', 'calendar_schedules_overview',
  'contacts_count', 'contacts_find', 'contacts_search', 'email_read', 'inbox_get', 'inbox_pending', 'inbox_search',
  'inbox_stats', 'notesq_health', 'notesq_history', 'notesq_list', 'notesq_read', 'notesq_search', 'prompt_list',
  'prompt_read', 'quoxchat_get_availability', 'quoxchat_get_transcript', 'quoxchat_list_conversations',
  'quoxchat_list_widgets', 'quoxchat_read', 'quoxchat_search_knowledge', 'voice_calls', 'voice_numbers',
  // Settings, licence, identity, policy, governance, vault metadata (tls_cert_info parses a stored cert), security engagement reads: no change.
  'appearance_get', 'compliance_get_reports', 'compliance_list_jobs', 'compliance_read', 'governance_get_templates',
  'governance_list_policies', 'governance_read', 'identity_status', 'license_status', 'llm_policy', 'llm_status',
  'safety_status', 'security_check_policy', 'security_get_engagement', 'security_list_engagements',
  'security_list_findings', 'settings_explain', 'settings_get', 'settings_list', 'settings_search', 'spend_status',
  'standing_grants_list', 'tls_cert_info', 'vault_list', 'x_budget_status',
  // Agents, hats, skills, tools, plugins, orgs and slots: directories and catalogues. slot_read GETs messages without holder_session, so the read watermark never moves.
  'agent_directory', 'call_provider_readiness', 'discord_list_bindings', 'doneengine_readiness', 'hat_catalogue',
  'live_sessions', 'lucid_situation', 'org_directory', 'plugin_list', 'proof_status', 'quox_command_lookup',
  'quoxlens_read', 'quoxseo_summary', 'reach_agent', 'skill_view', 'skills_list', 'slot_list', 'slot_read',
  'tool_inspect', 'wb_get_agent', 'wb_get_node_schema', 'wb_list_agents', 'wb_list_node_types', 'wb_list_plugins',
  'wb_search_templates',
  // Browser and page reads in an already-open session: no navigation, click or monitor run.
  'browser_find_element', 'browser_list_tabs', 'browser_monitor_list', 'browser_objective_get',
  'browser_objective_list', 'browser_sequence_list', 'browser_video_list', 'qlarity_inspect', 'screencap_list_pages',
  'screencap_status',
  // Wazuh reads (ARGUS): manager API and indexer GETs, no agent deploy or removal.
  'wazuh_agents', 'wazuh_alerts', 'wazuh_manager_status', 'wazuh_vulnerabilities',
  // Web and model lookups that return text and change nothing: search, page read, image description, time.
  'gemini_image_describe', 'service_check', 'time_now', 'web_read', 'web_search',
]);

/** PLAN MODE allowlist: true only for a tool named in PLAN_READS. */
function isPlanRead(toolName) {
  return PLAN_READS.has(String(toolName || ''));
}

function isPlanBlocked(toolName, input) {
  const name = String(toolName || '');
  const ts = require('./turnToolSelection.js');
  if (name === ts.TERMINAL_SUGGEST_TOOL) return !suggestionIsRead(input && input.command);
  if (!isPlanRead(name)) return true;
  return ts.isWriteAction(name, input); // a read-classified multi-action tool called with a write action
}

/** -> a refusal string when this call would change state on a plan-mode turn, else null. */
function planRefusal(toolName, input) {
  if (!isPlanBlocked(toolName, input)) return null;
  const ts = require('./turnToolSelection.js');
  if (String(toolName) === ts.TERMINAL_SUGGEST_TOOL) {
    const cmd = input && typeof input.command === 'string' ? input.command.trim().slice(0, 120) : 'that command';
    return `PLAN MODE: ${cmd} was not offered to the terminal because it changes state. Put it in the plan as a step instead.`;
  }
  // Only a listed read called with a write action is known to change state; anything unlisted is simply not on
  // the allowlist (it may be a write, or a read nobody has listed yet), so say exactly that.
  const why = isPlanRead(toolName) ? 'that action changes state' : 'it is not on the plan-mode read list (plan mode runs only listed reads)';
  return `PLAN MODE: ${toolName} was not run because ${why}, and this turn is plan only. Put it in the plan as a step (the exact tool and arguments, or the command), and tell the user: to do this, switch to /mode ask and say go.`;
}

/** The plan note added to the turn's context (quox_context), after anything already there. */
function withPlanNote(parsedContext) {
  const ctx = { ...(parsedContext || {}) };
  const prev = ctx.quox_context;
  const prevStr = prev == null || prev === '' ? '' : (typeof prev === 'string' ? prev : JSON.stringify(prev));
  ctx.quox_context = prevStr ? `${prevStr}\n\n${PLAN_MODE_NOTE}` : PLAN_MODE_NOTE;
  return ctx;
}

module.exports = { PLAN_MODE_NOTE, PLAN_READS, isPlanMode, isPlanRead, isPlanBlocked, planRefusal, withPlanNote, suggestionIsRead };
