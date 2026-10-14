/**
 * QUOXHAT P1 — built-in hat templates (QUOXHAT_STUDY.md §4).
 *
 * Versioned templates installed lazily into org-owned quoxhat_hats records.
 * Bump TEMPLATE_VERSION on any membership change: the store appends a new
 * reviewable revision ONLY for hats whose latest revision is still
 * template-authored; org-customised hats are never overwritten (study §3).
 *
 * HONESTY: memberships below are curated starting sets drawn from the real
 * agent/tool registry at authoring time. They ship in 'preview' status —
 * nothing enforces them until P2, and P2's publication gate must validate
 * every membership against the live server registry before 'published'.
 */

import { QUOXHAT_SCHEMA_VERSION } from './contract.js'

export const TEMPLATE_VERSION = 12

// QUOXON-PROOF v12 (lane I, quox#822-#825): llm_status, llm_policy, backup_overview and
// live_sessions join the awareness bundle; prompt_list and prompt_read join workspace.
// All read-only and org-scoped from the turn.

// QUOXON-REACH v11 (SITE-CLI proof matrix, 2026-10-13): 101 of 158 agent tools sat in
// no hat, so a scoped conversation could never be offered them (lucid_situation among
// them, though sitrep is core). v11 puts every tool the orchestrator holds in a hat:
// every READ is reachable from Default through a loadable bundle (Default reaches
// every capability without carrying every tool), reads also join the scoped hat they
// belong to, and WRITES go to the hat that owns them, host/infra effects only in the
// privileged hats (DevOps, NSOC). Enforced by services/collector/test/
// quoxhatRegistryInvariant.test.js.
//
// QUOXON-ASK v12 (lane J): quox_cli (any read-class CLI leaf, as the caller) is explicit
// in Default, so the conversation reaches every CLI read without a bundle step;
// quox_cli_write (write-class leaves, always an approval card) sits only in the
// privileged hats' approval-gated bundles (DevOps change, NSOC active-ops).
//
// Read bundles shared by Default and the scoped hats. Pure reads: org-scoped from the
// turn, no effect, so loading one is never a privilege step.
const READS = {
  awareness: ['lucid_situation', 'lucid_item', 'org_directory', 'agent_directory', 'identity_status', 'install_status', 'license_status', 'plugin_list', 'spend_status', 'reach_agent', 'safety_status', 'standing_grants_list', 'llm_status', 'llm_policy', 'backup_overview', 'live_sessions'],
  knowledge: ['quoxbrain_read', 'brain_context', 'brain_check', 'brain_why', 'brain_brief', 'brain_related', 'brain_neighbours', 'brain_history', 'memory_history', 'session_search', 'web_read', 'codebase_query', 'recall'],
  workspace: ['prompt_list', 'prompt_read', 'notesq_search', 'notesq_list', 'notesq_read', 'calendar_layers_list', 'calendar_agenda', 'calendar_coverage_status', 'calendar_event_get', 'list_files', 'search_files', 'read_file', 'vault_list', 'vault_types'],
  mail: ['inbox_accounts', 'inbox_zones', 'inbox_search', 'inbox_report_latest', 'list_approvals', 'email_read', 'commitment_list'],
  people: ['contacts_find', 'contactability_check', 'call_provider_readiness', 'contacts_context'],
  work: ['list_workflows', 'get_workflow', 'list_executions', 'get_execution', 'list_schedules', 'validate_workflow', 'execution_intelligence', 'get_objective_results', 'quoxplan_roadmaps', 'quoxplan_streams', 'quoxplan_stream_brief', 'quoxplan_notes', 'action_list', 'slot_list', 'slot_read', 'skills_list', 'skill_view', 'plan_artifact_get', 'plan_artifact_diff'],
  evidence: ['governance_read', 'compliance_read', 'quoxlens_read', 'noc_tool_outcomes', 'ward_verify', 'ward_status', 'calibration_self_audit', 'agh_chain_leaderboard', 'delegation_router_advise', 'query_envelopes', 'get_envelope_chain', 'list_evidence', 'security_audit'],
  // Host and cluster health reads (no exec: ssh_exec, network_check, db_query and the
  // proxmox/docker change tools stay in the privileged hats).
  infra: ['docker_status', 'proxmox_cluster_status', 'grafana_dashboards', 'tls_cert_info', 'doneengine_readiness', 'core_health'],
  ops: ['quoxagent_status', 'quoxagent_logs', 'screencap_status', 'screencap_list_pages', 'screencap_compare', 'screencap_validate', 'quoxchat_list_widgets', 'quoxchat_simulate_message', 'quoxchat_search_knowledge', 'x_budget_status', 'quoxseo_summary', 'quoxseo_issues', 'quoxseo_changes', 'quoxseo_urls'],
}

// Tools deliberately in NO hat, each with the reason. Empty today: every tool the
// orchestrator holds has a hat. An entry here is a decision, never a default.
export const HATLESS_TOOLS = {}

const base = (def) => ({ schema_version: QUOXHAT_SCHEMA_VERSION, ...def })

export const HAT_TEMPLATES = {
  default: {
    name: 'Default',
    template_version: TEMPLATE_VERSION,
    definition: base({
      purpose: 'General conversation with discovery and delegation; reaches every capability without carrying every tool.',
      agents: { orchestrator: 'quox', specialists: [] },
      tools: {
        explicit: [
          'hat_catalogue', 'hat_load_bundle', 'hat_propose_switch',
          'delegate_to_agent', 'memory_search', 'memory_save',
          'create_inbox_item', 'fleet_status', 'metrics_query',
          // v6 CONTACTSQ: read-only, masked cards only (never a raw number/email).
          'contacts_search', 'contacts_resolve',
          // v7 CONTACTSQ P2: which channel may I use (read-only), and live objection
          // capture, explicit because "stop contacting me" must be instant (reduces reach only).
          'contacts_best_channel', 'contacts_record_objection',
          // v8 CONTACTSQ P3: interaction history, refs only (read-only).
          'contacts_timeline',
          // v9 QUOXHAT #721: "jot this down" must reach NotesQ. The Default hat is
          // permissive, so brain_save was already AUTHORIZED by the grant ceiling;
          // it was missing from PRESENTATION, so the model reached for memory_save.
          'brain_save',
          // v12 QUOXON-ASK: every read-class quox CLI leaf, as the caller (lib/quoxCliTools.js).
          'quox_cli',
        ],
        // quox#657 (M4): send_notification was explicit (base, un-gated) —
        // the only notable write tool reachable with zero governed step.
        // Moved into a bundle so it requires hat_load_bundle first.
        bundles: [
          { key: 'notify', name: 'Notifications', tools: ['send_notification'] },
          // v6 CONTACTSQ: reaching a person is an outward effect, so it sits behind
          // hat_load_bundle; each call is still gated (approval or standing grant).
          { key: 'contacts', name: 'Contacts & calling', tools: ['contacts_dial', 'contacts_send', 'contacts_dial_batch', 'contacts_send_batch', 'contacts_focus'] },
          // v11 QUOXON-REACH: every read the orchestrator holds, by domain, one load away.
          { key: 'awareness', name: 'Situation, identity & install (read)', tools: READS.awareness },
          { key: 'knowledge', name: 'Knowledge & history (read)', tools: READS.knowledge },
          { key: 'workspace', name: 'Notes, calendar, files & vault names (read)', tools: READS.workspace },
          { key: 'mail', name: 'Mail & approvals (read)', tools: READS.mail },
          { key: 'people', name: 'People & reachability (read)', tools: READS.people },
          { key: 'work', name: 'Workflows, plans, skills & slots (read)', tools: READS.work },
          { key: 'evidence', name: 'Governance & evidence (read)', tools: READS.evidence },
          { key: 'infra', name: 'Host & cluster health (read)', tools: READS.infra },
          { key: 'ops', name: 'Agents, captures, chat widgets & SEO (read)', tools: READS.ops },
        ],
        connector_families: [],
      },
      // v11: fully loaded the Default hat carries every read (the invariant test sums it);
      // what the model sees first stays initial_tool_target, and D3 bounds each turn.
      budgets: { initial_tool_target: 12, max_manifest: 128 },
      selection: { mode: 'manual' },
      transitions: { allowed: 'any', confirm: 'none', privileged: false },
    }),
  },
  assistant: {
    name: 'Assistant',
    template_version: TEMPLATE_VERSION,
    definition: base({
      purpose: 'Personal organisation: InboxQ email, pending approvals, notifications and memory.',
      agents: { orchestrator: 'quox', specialists: [] },
      tools: {
        explicit: [
          'hat_catalogue', 'hat_load_bundle', 'hat_propose_switch',
          'delegate_to_agent', 'memory_search', 'memory_save',
          'create_inbox_item',
        ],
        bundles: [
          // v4 (2026-10-01): populated from quox's LIVE resolved grant —
          // bundle tools materialize only via grant intersection, so every
          // name here was verified against /api/v1/tools/list?agent_id=quox.
          // Specialist depth (InboxQ internals etc.) stays via delegation.
          // quox#657 (M4): send_notification moved here from explicit — it
          // was the only notable write tool reachable with zero governed
          // step; now it requires hat_load_bundle('inbox') first.
          { key: 'inbox', name: 'Inbox & approvals', tools: ['list_approvals', 'approve_request', 'deny_request', 'send_notification'] },
          // v11: the InboxQ reads join email (they were reachable only by delegation).
          { key: 'email', name: 'InboxQ email', tools: ['email_read', 'email_send', 'inbox_accounts', 'inbox_zones', 'inbox_search', 'inbox_report_latest'] },
          { key: 'organisation', name: 'Commitments & recall', tools: ['commitment_create', 'commitment_list', 'commitment_resolve', 'recall', 'entity_note'] },
          // v11 QUOXON-REACH: notes, calendar, files and vault names (read), and the
          // personal writes: the Action Tracker board, memory/brain corrections on the
          // user's own notes, and standing watches (a proposal, never a trip).
          { key: 'workspace', name: 'Notes, calendar & files (read)', tools: READS.workspace },
          { key: 'tasks', name: 'Actions, memory & watches', tools: ['action_list', 'action_add', 'action_move', 'action_update', 'action_delete', 'memory_update', 'brain_update', 'brain_restore', 'brain_delete', 'standing_watch_register'] },
          // v6 CONTACTSQ: find a person, then call/message them without ever holding the number.
          // v10 CONTACTSQ P5: propose a fact for human review (ungated) and read confirmed context (approval-gated lease).
          { key: 'contacts', name: 'Contacts & calling', tools: ['contacts_search', 'contacts_resolve', 'contacts_best_channel', 'contacts_record_objection', 'contacts_timeline', 'contacts_log_touchpoint', 'contacts_propose_fact', 'contacts_context', 'contacts_dial', 'contacts_send'] },
          // v11: who may be reached and on which line, then raising or closing a call
          // (each call is still gated; opt-in is a proposal for human review).
          { key: 'calls', name: 'Reachability & calls', tools: ['contacts_find', 'contactability_check', 'call_provider_readiness', 'contactability_propose_optin', 'call_raise_intent', 'call_summarize_and_end'] },
        ],
        connector_families: [],
      },
      budgets: { initial_tool_target: 12, max_manifest: 72 },
      selection: { mode: 'manual' },
      transitions: { allowed: 'any', confirm: 'none', privileged: false },
    }),
  },
  nsoc: {
    name: 'NSOC',
    template_version: TEMPLATE_VERSION,
    definition: base({
      purpose: 'Network and security operations: investigation first, active operations gated.',
      agents: { orchestrator: 'quox', specialists: ['sentinel', 'argus', 'beacon', 'cipher'] },
      tools: {
        explicit: ['hat_catalogue', 'hat_load_bundle', 'hat_propose_switch', 'delegate_to_agent', 'memory_search', 'fleet_status', 'network_check'],
        bundles: [
          // v4: from quox's live grant; wazuh/network depth belongs to the
          // specialists (sentinel/argus/beacon/cipher) via delegation.
          { key: 'discovery', name: 'Discovery & telemetry', tools: ['metrics_query', 'grafana_dashboards', 'tls_cert_info', 'core_health'] },
          { key: 'diagnostic', name: 'Diagnostics & evidence', tools: ['security_audit', 'query_envelopes', 'get_envelope_chain', 'list_evidence'] },
          // v11 QUOXON-REACH: the governance/evidence reads, then policy and compliance
          // authoring (propose-only or server-staged) and the QuoxLens judgments.
          { key: 'evidence', name: 'Governance & evidence (read)', tools: READS.evidence },
          { key: 'governance', name: 'Policy, compliance & risk decisions (approval-gated)', tools: ['governance_propose_policy', 'governance_change_policy', 'compliance_create', 'compliance_update', 'quoxlens_apply', 'quoxlens_accept_risk'] },
          { key: 'active-ops', name: 'Active operations (approval-gated)', tools: ['ssh_exec', 'remote_ssh', 'alerts_manage', 'system_admin', 'db_query', 'quox_cli_write'] },
        ],
        connector_families: [],
      },
      budgets: { initial_tool_target: 12, max_manifest: 48 },
      selection: { mode: 'manual' },
      // Switching INTO NSOC is a privilege escalation: user confirm minimum,
      // org policy may raise to approver (study §6).
      transitions: { allowed: 'any', confirm: 'user', privileged: true },
    }),
  },
  devops: {
    name: 'DevOps',
    template_version: TEMPLATE_VERSION,
    definition: base({
      purpose: 'Infrastructure diagnosis and controlled change through the infrastructure specialists.',
      agents: { orchestrator: 'quox', specialists: ['nova', 'atlas', 'forge', 'bob'] },
      tools: {
        explicit: ['hat_catalogue', 'hat_load_bundle', 'hat_propose_switch', 'delegate_to_agent', 'memory_search', 'fleet_status', 'docker_status', 'metrics_query'],
        bundles: [
          // v4: from quox's live grant; deep host/container forensics stay
          // with nova/atlas/forge/bob via delegation.
          // v11: quoxagent_status/logs exist now (the v5 note below predates them).
          { key: 'diagnose', name: 'Diagnosis', tools: ['proxmox_cluster_status', 'grafana_dashboards', 'core_health', 'doneengine_readiness', 'quoxagent_status', 'quoxagent_logs'] },
          // quox#657 audit: quoxagent_status/logs/execute/install and
          // proxmox_vm_start/stop are dead names (no registered tool
          // resolves to them). The real surfaces are the single internal
          // executor tool 'quoxagent' (dotted actions quoxagent.status/
          // .execute/.logs/.install dispatch under this one name) and the
          // single 'proxmox_vm_action' (no per-action start/stop tools
          // exist). quoxagent appears once here, not duplicated into
          // diagnose, since it is the only path for both read and write.
          // v11 QUOXON-REACH: 'quoxagent' was a dead name (no tool defines it); the real
          // tools are quoxagent_execute/install. Per-VM start/stop, passwordless-sudo
          // setup and SQL against a vault database are host effects: this bundle only.
          { key: 'change', name: 'Controlled change (approval-gated)', tools: ['ssh_exec', 'remote_ssh', 'docker_extended', 'proxmox_vms', 'proxmox_vm_action', 'proxmox_vm_start', 'proxmox_vm_stop', 'quoxagent_execute', 'quoxagent_install', 'system_sudo_setup', 'db_query', 'execute_workflow', 'quox_cli_write'] },
          // v11: the delivery pipeline. Reads first, then workflow/objective/plan changes
          // and slot messages (each still passes the approval gate where one applies).
          { key: 'work', name: 'Workflows, plans, skills & slots (read)', tools: READS.work },
          { key: 'delivery', name: 'Workflows, objectives, plans & slots (change)', tools: ['orchestrate_objective', 'save_as_workflow', 'create_workflow', 'delete_workflow', 'activate_workflow', 'deactivate_workflow', 'import_n8n_workflow', 'deploy_template', 'quoxplan_add_note', 'quoxplan_set_status', 'quoxplan_tick_phase', 'quoxplan_request_complete', 'plan_artifact_create', 'skill_manage', 'slot_say', 'slot_assign'] },
        ],
        connector_families: [],
      },
      budgets: { initial_tool_target: 12, max_manifest: 64 },
      selection: { mode: 'manual' },
      // v5 (quox#657 audit): switching INTO DevOps is a privilege escalation —
      // its change bundle carries ssh_exec/remote_ssh/proxmox/quoxagent/
      // execute_workflow, strictly more dangerous than NSOC's active-ops set,
      // which is correctly privileged. Non-privileged made it auto-matchable to
      // the general orchestrator with only the bundle-load step as a gate.
      transitions: { allowed: 'any', confirm: 'user', privileged: true },
    }),
  },
  marketing: {
    name: 'Marketing',
    template_version: TEMPLATE_VERSION,
    definition: base({
      purpose: 'Research, content preparation and governed channel publishing; drafting and publishing stay distinct.',
      // v5 (quox#657): xtwitter (HERALD) owns x_post/x_thread in the publish
      // bundle; without it here, automatic selection never routes HERALD to the
      // only publishing-capable hat and it falls through to the publish-less
      // default. facebook/instagram/tiktok are the same class: their publish
      // tools (facebook_pages_publish_page_post, instagram_publish_media,
      // tiktok_publish_video) are connector-bridge tools gated by
      // CONNECTOR_FAMILIES (agentTools.js), not native tools, so they join via
      // connector_families below (facebook_pages/instagram/tiktok, matching
      // the connector ids in connectors/registry.js), same pattern as
      // linkedin/youtube.
      agents: { orchestrator: 'quox', specialists: ['linkedin', 'youtube', 'xtwitter', 'facebook', 'instagram', 'tiktok'] },
      tools: {
        explicit: ['hat_catalogue', 'hat_load_bundle', 'hat_propose_switch', 'delegate_to_agent', 'memory_search', 'memory_save'],
        bundles: [
          // v4: from quox's live grant; channel depth via linkedin/youtube
          // specialists + connector families below.
          { key: 'draft', name: 'Drafting & research', tools: ['quoxbrain_search', 'gemini_image_generate', 'screencap_capture', 'quoxchat_search_knowledge', 'recall'] },
          // v11 QUOXON-REACH: page captures, chat widgets and SEO (read); a widget test
          // message is a probe of the org's own widget, not a publish.
          { key: 'ops', name: 'Captures, chat widgets & SEO (read)', tools: READS.ops.filter((t) => !t.startsWith('quoxagent_') && !['quoxchat_search_knowledge', 'x_budget_status'].includes(t)) },
          { key: 'publish', name: 'Governed publishing (approval-gated)', tools: ['x_post', 'x_thread', 'x_budget_status', 'send_notification', 'x_delete', 'x_like', 'x_repost', 'screencap_upload'] },
        ],
        connector_families: ['linkedin', 'youtube', 'facebook_pages', 'instagram', 'tiktok'],
      },
      budgets: { initial_tool_target: 12, max_manifest: 32 },
      selection: { mode: 'manual' },
      transitions: { allowed: 'any', confirm: 'none', privileged: false },
    }),
  },
}
