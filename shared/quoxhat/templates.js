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

export const TEMPLATE_VERSION = 10

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
        ],
        // quox#657 (M4): send_notification was explicit (base, un-gated) —
        // the only notable write tool reachable with zero governed step.
        // Moved into a bundle so it requires hat_load_bundle first.
        bundles: [
          { key: 'notify', name: 'Notifications', tools: ['send_notification'] },
          // v6 CONTACTSQ: reaching a person is an outward effect, so it sits behind
          // hat_load_bundle; each call is still gated (approval or standing grant).
          { key: 'contacts', name: 'Contacts & calling', tools: ['contacts_dial', 'contacts_send', 'contacts_dial_batch', 'contacts_send_batch', 'contacts_focus'] },
        ],
        connector_families: [],
      },
      budgets: { initial_tool_target: 12, max_manifest: 32 },
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
          { key: 'email', name: 'InboxQ email', tools: ['email_read', 'email_send'] },
          { key: 'organisation', name: 'Commitments & recall', tools: ['commitment_create', 'commitment_list', 'commitment_resolve', 'recall', 'entity_note'] },
          // v6 CONTACTSQ: find a person, then call/message them without ever holding the number.
          // v10 CONTACTSQ P5: propose a fact for human review (ungated) and read confirmed context (approval-gated lease).
          { key: 'contacts', name: 'Contacts & calling', tools: ['contacts_search', 'contacts_resolve', 'contacts_best_channel', 'contacts_record_objection', 'contacts_timeline', 'contacts_log_touchpoint', 'contacts_propose_fact', 'contacts_context', 'contacts_dial', 'contacts_send'] },
        ],
        connector_families: [],
      },
      budgets: { initial_tool_target: 12, max_manifest: 32 },
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
          { key: 'active-ops', name: 'Active operations (approval-gated)', tools: ['ssh_exec', 'remote_ssh', 'alerts_manage', 'system_admin'] },
        ],
        connector_families: [],
      },
      budgets: { initial_tool_target: 12, max_manifest: 32 },
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
          { key: 'diagnose', name: 'Diagnosis', tools: ['proxmox_cluster_status', 'grafana_dashboards', 'core_health', 'doneengine_readiness'] },
          // quox#657 audit: quoxagent_status/logs/execute/install and
          // proxmox_vm_start/stop are dead names (no registered tool
          // resolves to them). The real surfaces are the single internal
          // executor tool 'quoxagent' (dotted actions quoxagent.status/
          // .execute/.logs/.install dispatch under this one name) and the
          // single 'proxmox_vm_action' (no per-action start/stop tools
          // exist). quoxagent appears once here, not duplicated into
          // diagnose, since it is the only path for both read and write.
          { key: 'change', name: 'Controlled change (approval-gated)', tools: ['ssh_exec', 'remote_ssh', 'docker_extended', 'proxmox_vms', 'proxmox_vm_action', 'quoxagent', 'execute_workflow'] },
        ],
        connector_families: [],
      },
      budgets: { initial_tool_target: 12, max_manifest: 32 },
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
          { key: 'publish', name: 'Governed publishing (approval-gated)', tools: ['x_post', 'x_thread', 'x_budget_status', 'send_notification'] },
        ],
        connector_families: ['linkedin', 'youtube', 'facebook_pages', 'instagram', 'tiktok'],
      },
      budgets: { initial_tool_target: 12, max_manifest: 32 },
      selection: { mode: 'manual' },
      transitions: { allowed: 'any', confirm: 'none', privileged: false },
    }),
  },
}
