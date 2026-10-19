'use strict';
/**
 * D3: per-turn tool selection for the API chat paths (openai, anthropic-api, ollama).
 *
 * The full grant for an agent (quox: ~156 tools, ~121k chars of schema) used to ride on
 * every model round. Here a cheap, deterministic ranker picks a small relevant subset for
 * the turn, schemas are compacted, and one meta tool (`more_tools`) lets the model ask
 * for a tool it was not offered; the new tool is offered from the NEXT model round.
 *
 * Governance does not move:
 *  - the pool is whatever resolveStreamToolSet already resolved (agent grant, QuoxHat
 *    manifest, provider cap); an offer is always a subset of it, never wider;
 *  - every offered call still goes through dispatchGovernedToolCall -> executeTool
 *    (RBAC, QuoxHat membership, GOV-4 policy, approval gate);
 *  - a call to a tool that was not offered on the turn is refused in the loop and never
 *    reaches executeTool (see governedToolDispatch.handleOfferGate);
 *  - more_tools is a catalogue read: names and one-line descriptions, no effect.
 *
 * State-changing tools (writes, notifiers, exec) stay out of the offer unless the user's
 * own message asks for a change, or the agent's role needs the tool (quox delegates).
 * Evidence: QXC_0b70b794 (2026-10-12 21:53 UTC, OpenAI path) wrote 3 memory rows and an
 * inbox item when the user only stated a decision and asked "Reply OK".
 */

const MORE_TOOLS_NAME = 'more_tools';
const DEFAULT_CAP = 16;
const OLLAMA_CAP = 8;
const MORE_TOOLS_LIMIT = 6;
const DESC_MAX = 240;
const PARAM_DESC_MAX = 120;

const STATE_CHANGE_RULE = 'Only call tools that change state when the user asks for that change.';
// QUOXON-PARITY claim rules (#815, #810): a claim needs a tool result behind it. Every
// API path (openai, anthropic-api, ollama, compat) gets these via buildTurnSystemPrompt,
// and the Claude CLI path via its own prompt, so the contract is the same on every provider.
const APPROVAL_CLAIM_RULE = 'Never say an approval card or approval request exists unless a tool result in this conversation contains its approval id. A refusal (HTTP 403, refused, denied) is not an approval: say the action was refused and nothing ran.';
const SAFETY_CLAIM_RULE = 'Never state a safety, threat or DEFCON level, or that an agent is halted, unless a tool returned it in this conversation (safety_status reads the real DEFCON level and kill switches).';
// #811: "inbox" means mail. InboxQ tools (inbox_zones, inbox_search) answer mail questions;
// approvals waiting on the user are list_approvals / inbox_pending; LUCID is not the mailbox.
const INBOX_ROUTING_RULE = 'Questions about the user\'s inbox, mail or email are answered from InboxQ (inbox_accounts, inbox_zones, inbox_search), not from LUCID; approvals waiting on the user are list_approvals or inbox_pending; counts of the approvals/work-queue inbox (open, urgent, by kind) come from inbox_stats.';
// #817 / #818: names, ids, counts, ages, recency and agent capabilities are read, not recalled.
// lib/answerGrounding.js checks the finished answer against the turn's tool results.
const GROUNDING_RULE = 'Name a quox command, dashboard surface, id, count, total or age only as a tool result in this conversation gives it; never invent one. A page of results is not the total: use the tool\'s total field. For "most recent" or "latest" use a tool that returns timestamps (query_envelopes, get_envelope_chain), not notes or session search. Describe what an agent can do only from agent_directory.';
// QUOXON lane S: asked to "make a slot" with no slot tool, both providers filed an inbox item
// "for an operator" (2026-10-14 02:00 UTC). A task is not a stand-in for an action.
const NO_STAND_IN_TASK_RULE = 'Never file an inbox item, task or approval request "for an operator" as a stand-in for an action you cannot take. If a tool here does it, use it; if a quox command does it, name the exact command for the user. Create a task or inbox item only when the user asks for one.';
// QUOXON-ENGINE classes 2 and 5: status claims carry their source time; "can't" names the way.
const STALE_RULE = 'Notes, memory and brain results are history, not live status: if you use one for a status, say its date ("as of <date>, from notes"). A failed live read is reported as failed, never replaced by notes presented as current.';
const COMMAND_RULE = 'To name a command, take it from quox_command_lookup (the TUI slash command and the quox CLI form); never answer "I can\'t" without one, and never name a command it did not return.';
// #914: "I don't have a tool for that" was the answer to ten plain reads the CLI covers.
const QUOX_CLI_OFFERED_RULE = 'When quox_cli is among the tools offered, never say you have no tool for a read: call the command listed for this ask in its description (read leaves run directly). For a change, quox_cli_write raises the approval card for the user.';
// DECISION-LABELS (2026-10-17): "I'd pick a for the first, b for the second" got "youre just shouting letters".
const DECISION_RULE = 'When you talk about pending decisions, go ONE AT A TIME unless asked for the lot: name the question by its title (and its ref), never by a position or number (your order is not the /answer numbering of the terminal), say in one plain sentence what it does, give your recommendation in words with the key in brackets (for example "keep them visible as not_testable (a)"), and ask for a yes or no. Never recommend a bare letter, and never list commands as the main content. If a tool says options have no labels, say so; do not invent their meaning.';
const CLAIM_RULES = [APPROVAL_CLAIM_RULE, SAFETY_CLAIM_RULE, INBOX_ROUTING_RULE, GROUNDING_RULE, NO_STAND_IN_TASK_RULE, STALE_RULE, COMMAND_RULE, QUOX_CLI_OFFERED_RULE];

// Read tools every agent gets when they are in its pool (bounded to half the cap).
// time_now first: tiny schema, and models otherwise guess the time and DST (QUOXON 2026-10-12).
const CORE_TOOLS = ['time_now', 'memory_search', 'fleet_status', 'inbox_pending', 'list_approvals'];
// What an agent's role needs on every turn, writers included (the role is the ask).
const AGENT_DEFAULTS = {
  quox: ['delegate_to_agent'],
  lucid: ['lucid_situation', 'lucid_item'],
};

// Name tokens that mark a tool as state-changing. Unknown verbs count as reads: a
// misclassification changes only what is OFFERED, never what executeTool permits.
const WRITE_TOKENS = new Set([
  // quox#1290: removal verbs. Without them memory_forget, docker_prune and security_session_revoke classed as reads.
  'forget', 'purge', 'destroy', 'prune', 'revoke', 'wipe', 'erase', 'drop', 'truncate', 'kill', 'terminate', 'uninstall', 'unregister',
  'save', 'create', 'update', 'delete', 'remove', 'send', 'post', 'thread', 'like', 'repost',
  'add', 'set', 'tick', 'approve', 'deny', 'exec', 'execute', 'activate', 'deactivate', 'deploy',
  'import', 'dial', 'batch', 'log', 'record', 'register', 'propose', 'change', 'manage', 'move',
  'restore', 'install', 'start', 'stop', 'capture', 'upload', 'notification', 'note', 'apply',
  'accept', 'raise', 'end', 'sudo', 'ssh', 'say', 'assign', 'generate', 'admin', 'orchestrate',
  'reach', 'delegate', 'load', 'setup', 'complete', 'switch', 'like', 'checkout',
  // Write-class sweep 2026-10-15 (notesq_tag was classed a read): generic verbs that change state.
  'tag', 'untag', 'label', 'unlabel', 'archive', 'unarchive', 'pin', 'unpin', 'restart', 'unsilence',
  'unbind', 'bind', 'snapshot', 'prune', 'halt', 'cancel', 'schedule', 'configure', 'enable',
  'disable', 'revoke', 'edit', 'download', 'cleanup', 'simulate', 'mark',
]);
const WRITE_NAMES = new Set(['proxmox_vm_action', 'commitment_resolve', 'action_add', 'action_move', 'action_update', 'action_delete', 'quox_cli_write',
  // Writers whose names carry no write verb.
  'notesq_tag', 'docker_fleet_container_action', 'roadmap_status', 'backup_run', 'toolsmith.runscript',
  'browser_objective_run', 'browser_objective_plan', 'calendar_reconcile',
  // TRIAGE-TOOLS (2026-10-16): HITL housekeeping writes ('dismiss'/'snooze' are not write tokens).
  'hitl_item_dismiss', 'hitl_item_snooze', 'hitl_bulk_dismiss']);
// QUOXON-REACH: reads whose names carry a write token. install_status reports version and
// service health; reach_agent computes an agent's blast radius. Neither changes anything.
// alerts_manage: listing alerts is a read; its silence action is approval-gated at execution.
const READ_NAMES = new Set(['install_status', 'reach_agent', 'alerts_manage', 'keeper_schedule_list',
  // bob_log_tail reads a build log (log is the noun); bob_build_targets lists registered targets.
  'bob_log_tail']);
// QUOXON-PARITY: capability REQUESTS, not changes. hat_propose_switch files a HITL item and
// never switches; hat_load_bundle loads only a bundle the ACTIVE hat already defines. They are
// how an agent asks for a capability it lacks, so every path offers them like reads (the
// Claude subscription path used them on 2026-10-13 while the OpenAI loop could not see them).
const CAPABILITY_TOOLS = ['hat_catalogue', 'hat_propose_switch', 'hat_load_bundle'];
const CAPABILITY_NAMES = new Set(CAPABILITY_TOOLS);
// Knowledge: the Qortex brain search. Offered whenever the user asks what the agent knows or
// thinks, or points at a page (an opinion is better grounded in what we already know).
const KNOWLEDGE_TOOL = 'quoxbrain_search';
const KNOWLEDGE_RE = /\b(what do (?:you|u|ya) (?:know|think|reckon)|what(?:'s| is) your (?:opinion|take|view)|(?:your|any) (?:thoughts|opinion|views?)|opinion|tell me about|know about|remind me|recall|background on|history of|why did we|what did we (?:decide|say)|our (?:project|product|plan|roadmap|decision|stack))\b/i;
// A capability the agent may not hold: hats, modes, privilege, or a specialist domain.
const CAPABILITY_RE = /\b(hats?|mode|privileged?|permission|access|security|vulnerab\w*|nsoc|switch|flip|lack|missing|don'?t have|can'?t)\b/i;

// Skills: the governed skill catalogue. Offered when the user asks about the agent's skills
// (parity run 20261013T070218Z: on the 8-tool cap the task words outranked the catalogue).
const SKILL_TOOLS = ['skills_list', 'skill_view'];
const SKILL_RE = /\b(?:skills?|crystals?|playbooks?)\b/i;

// QUOXON-PARITY lane E1 (#809, #810, #811): the user's words name a CLI-readable surface,
// so its read tool is offered first, on every provider cap (ollama's 8 included). Reads only;
// routed tools are bounded to half the cap so the ranked matches still get room.
// Z2H-R5 A: "which hosts are online" is a fleet read. The model reached for reach_agent with an
// invented agent ("HostStatusChecker") and answered nothing. reach_agent is an agent's blast
// radius (REACH_ASK_RE), never a host-status check.
// Z2H-7B4: "how many servers do i have?" is a fleet read too (allowlist grammar, lib/fleetAsk.js).
const { COUNT_RE: FLEET_COUNT_RE, unwrapQueued, singleHostFrom } = require('./fleetAsk.js');
const HOST_STATUS_RE = /\b(?:hosts?|servers?|machines?|boxes|nodes?|fleet)\b[\s\S]*\b(?:online|offline|up|down|alive|reachable|healthy|status|running)\b|\b(?:online|offline|alive|reachable|healthy)\b[\s\S]*\b(?:hosts?|servers?|machines?|boxes|nodes?|fleet)\b|\b(?:status|state|health)\s+(?:of|for|on)\s+(?:(?:my|our|the|all|every|each)\s+)?(?:[\w-]+\s+){0,2}(?:hosts?|servers?|machines?|boxes|nodes?|fleet)\s*[?.!]*\s*$|\b(?:list|show|display)\s+(?:me\s+)?(?:(?:my|our|the|all|every)\s+)?(?:[\w-]+\s+){0,2}(?:hosts?|servers?|machines?|boxes|nodes?)\s*[?.!]*\s*$/i;
// Z2H-7B3: + "what is the status of my servers?" (status BEFORE the noun) and a bare "list my hosts".
// Both are anchored to the end of the message so "status of the server migration plan" and
// "show the hosts file" stay out; detection widening only, nothing existing was narrowed.
const REACH_ASK_RE = /\b(?:blast|radius|reach\w*|what can \w+ (?:access|touch)|permissions?)\b/i;
// quox#1090 (SITE-CLI ruling): deterministic intent pins for SELECTED asks the live model kept
// answering with a sibling or a stand-in although the ranked hint named the holder. A pin:
//   - holder: `tool` is offered first and `siblings` are withheld;
//   - orchestrator (no tool, can delegate to a holder): `tool` is routed so the delegate offer names
//     holder AND tool ("tell it to run <tool>"), and `standIns` are withheld;
//   - neither: nothing is withheld (a pool is never stranded).
// Reads only. Narrow on purpose: every other ask in docs/matrix/suites fires none of them.
const DISCORD_PROBLEM_RE = /\b(?:diagnos\w*|why|troubleshoot\w*|debug\w*|broken|silent|stuck|fail\w*|(?:do|does|is|are|wo|was|were|have|has)n'?t|not\s+(?:work\w*|receiv\w*|get\w*|com\w*|deliver\w*|respond\w*|arriv\w*)|nothing\s+(?:is\s+)?(?:coming|arriving|getting))\b/i;
const INTENT_PINS = [
  { id: 'settings-current-value', gripe: 'quox#1090', tool: 'settings_get', siblings: ['settings_search'], standIns: ['quox_cli'],
    intent: /\bset\s+to(?:\s+(?:right\s+now|now|currently|at\s+the\s+moment|today))?\s*(?:[?.!]|$)|\bcurrent\s+value\b/i,
    requires: (m) => /\b(?:settings?|polic(?:y|ies)|flags?|options?|warden)\b/i.test(m) || /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/.test(m),
    unless: /\b(?:routing|llm|providers?|models?|governance|aocl|engagements?|defcon|safety|hats?)\b/i },
  { id: 'vault-connect-guide', gripe: 'quox#1090', tool: 'vault_connect_guide', siblings: ['vault_types'], standIns: ['vault_types', 'quox_cli'],
    intent: /\b(?:connect|link|integrate|hook(?:\s+\w+){0,4}\s+up|hook\s+up)\b[\s\S]*\b(?:to|with|into)\s+quox\b/i,
    requires: (m) => /\bhow\s+(?:do|can|would|should)\s+(?:i|we)\b|\bwhat\s+(?:do|does|would)\s+(?:i|we|quox)\s+need\b|\bwhat\s+(?:credentials?|fields?|tokens?|keys?)\b/i.test(m),
    unless: /\b(?:discord|slack|telegram|whatsapp|matrix|calendars?|inbox|mail|e-?mails?|mailbox\w*|facebook|instagram|tiktok|twitter|linkedin|x\s+account|hosts?|servers?|machines?|fleet|vms?|agents?|slots?|routers?|mikrotik)\b/i },
  { id: 'discord-diagnose', gripe: 'quox#1090', tool: 'discord_diagnose', siblings: [], standIns: ['quox_cli'],
    intent: /\bdiscord\b/i, requires: (m) => DISCORD_PROBLEM_RE.test(m) },
  { id: 'discord-bindings', gripe: 'quox#1090', tool: 'discord_list_bindings', siblings: [], standIns: ['quox_cli'],
    intent: /\bdiscord\b/i,
    requires: (m) => /\b(?:bindings?|bound|channels?)\b/i.test(m) && /\b(?:which|what|list|show|modes?)\b/i.test(m) && !DISCORD_PROBLEM_RE.test(m),
    unless: /\b(?:unbind|bind|add|remove|delete|change|switch|set|mute|pause)\b/i },
  { id: 'seo-index-coverage', gripe: 'quox#1090', tool: 'quoxseo_inspection', siblings: [], standIns: ['quox_cli'],
    intent: /\bindex(?:ing)?\s+coverage\b|\burl\s+inspection\b|\b(?:google|gsc|search\s+console)\b[\s\S]*\bindexed\b|\bindexed\b[\s\S]*\b(?:google|gsc|search\s+console)\b|\bhow\s+many\b[\s\S]*\b(?:pages?|urls?)\b[\s\S]*\bindexed\b/i },
];
const HELD_ASK_NEVER = ['approve_request', 'deny_request'];
const HELD_FIX_CONTAINER_TOOL = 'docker_fleet_container_action';
function intentPinsFor(message) {
  const m = String(message || '');
  return INTENT_PINS.filter((p) => p.intent.test(m) && !(p.unless && p.unless.test(m)) && !(p.requires && !p.requires(m)));
}
// quox#1090: a delegated task that says "run your settings_get tool" (autoDelegate's taskFor, or the
// orchestrator following the hint) puts that tool first for the specialist. Only snake_case names the
// pool actually holds count; ordinary words never match.
const NAMED_TOOL_RE = /\b(?:run|use|call)\s+(?:your\s+|the\s+|its\s+)?([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi;
function namedToolsIn(message, poolNames) {
  const have = new Set(poolNames || []);
  const out = [];
  for (const m of String(message || '').matchAll(NAMED_TOOL_RE)) { const n = m[1].toLowerCase(); if (have.has(n) && !out.includes(n)) out.push(n); }
  return out;
}
const SIDECAR_HEALTH_RE = /\bagents?\b[\s\S]*\breport(?:s|ing)?\s+(?:themselves|itself|their\s+own)\b|\b(?:quoxagent|sidecars?)\b[\s\S]*\b(?:unhealthy|degraded|health\w*|self[- ]report\w*|report\w*\s+(?:themselves|itself|their\s+own))\b|\b(?:unhealthy|degraded|self[- ]report\w*|report(?:s|ing)?\s+(?:themselves|itself|their\s+own))\b[\s\S]*\b(?:quoxagent|sidecars?)\b/i;
// quox#1290: removal verbs as a whole word of a tool name (same set as referenceMonitor's destructive default gate).
const REMOVAL_NAME_RE = /(^|_)(delete|remove|destroy|purge|drop|wipe|erase|truncate|forget|uninstall|unregister|revoke|prune|kill|terminate)(_|$)/i;
const INTENT_ROUTES = [
  // quox#1290: removing memories routes to the memory tools (search for the ids, then forget). A first-run user's
  // "Delete all of my saved memories." was answered with delete_workflow. memory_forget is approval-gated.
  [/\b(?:delete|remove|forget|erase|wipe|clear|purge)\b[\s\S]*\b(?:memor\w*|remember\w*)\b|\bforget\b[\s\S]*\b(?:me|my|everything|that|this|it)\b/i, ['memory_search', 'memory_forget']],
  // SDK-TEAM: the sidecars' OWN reported health is quoxagent_status; fleet_status is the Bastion host inventory.
  [SIDECAR_HEALTH_RE, ['quoxagent_status']],
  [HOST_STATUS_RE, ['fleet_status']],
  [FLEET_COUNT_RE, ['fleet_status']],
  // Monitoring reads: the governed tool is offered first so the ask is answered by it, not delegated.
  [/\btools?\b[\s\S]*\b(?:fail\w*|errors?|success rate|flak\w+)\b|\b(?:fail\w*|errors?|flak\w+)\b[\s\S]*\btools?\b/i, ['noc_tool_outcomes']],
  // #1061: alert asks route by intent. A read never routes to alerts_manage (whose only own job is creating a
  // silence): silences listed -> alerts_silences, Prometheus firing/pending -> prometheus_alerts, a request to
  // silence something -> alerts_manage, anything else alert-shaped -> alerts_active.
  [/\b(?:silences|silenced|muted|snoozed)\b/i, ['alerts_silences']],
  [/\bprometheus\b[\s\S]*\balerts?\b|\balerts?\b[\s\S]*\bprometheus\b|\bpending\b[\s\S]*\balerts?\b/i, ['prometheus_alerts']],
  [/\b(?:silence|mute|snooze)\s+(?:the|that|this|it|those|these|all|alerts?)\b/i, ['alerts_manage']],
  [/\b(?:alerts?|alertmanager|firing)\b/i, ['alerts_active']],
  [/\bgrafana\b|\bdashboards?\b/i, ['grafana_dashboards']],
  // PROOF-ENGINE t1-prometheus_range: a range ask (over the last hour, steps, trend) is prometheus_range's row
  // below; offering the instant metrics_query first made the holder answer with instant queries.
  [/^(?![\s\S]*\b(?:prometheus|promql|metrics?)\b[\s\S]*\b(?:over\s+the\s+(?:last|past)|over\s+time|range|steps?|trend)\b)(?:[\s\S]*\b(?:prometheus|promql|metrics?)\b|[\s\S]*\b(?:cpu|memory|disk)\b[\s\S]*\b(?:usage|load|utili[sz]ation)\b)/i, ['metrics_query']],
  [/\bproxmox\b[\s\S]*\b(?:cluster|quorum|nodes?)\b/i, ['proxmox_cluster_status']],
  [/\bproxmox\b[\s\S]*\b(?:vms?|virtual machines?)\b|\b(?:vms?|virtual machines?)\b[\s\S]*\bproxmox\b/i, ['proxmox_vms']],
  [/\b(?:receipts?|envelopes?)\b/i, ['ward_verify']],
  [/\b(?:ward|witness\w*|tamper\w*)\b/i, ['ward_status', 'ward_verify']],
  [/\bgrants?\b/i, ['standing_grants_list']],
  // MATRIX WORKER2: the change log and the URL warehouse never ranked into a 266-tool pool, so
  // "what changed between crawls" ran Bash and "which pages errored" settled for issues.
  [/\b(?:seo|crawl\w*)\b[\s\S]*\b(?:changed?|changes|diff\w*|added|removed)\b|\bchange log\b/i, ['quoxseo_changes']],
  [/\b(?:seo|crawl\w*)\b[\s\S]*\b(?:urls?|pages?|paths?|orphan\w*|noindex)\b|\b(?:urls?|pages?|paths?|orphan\w*|noindex)\b[\s\S]*\b(?:seo|crawl\w*)\b|\burl warehouse\b/i, ['quoxseo_urls']],
  // SDK-TEAM spec (seo/t2-seo-opportunities): quick wins / striking distance are quoxseo_opportunities (held by seer).
  [/\b(?:quick\w*|easy|easiest)\s+(?:seo|search|keyword|ranking)\s+wins?\b|\b(?:seo|keywords?|gsc|search console)\b[\s\S]*\b(?:quick\w*\s+(?:\w+\s+)?wins?|opportunit\w*|striking\s+distance|low[- ]hanging)\b|\b(?:quick\w*\s+(?:\w+\s+)?wins?|opportunit\w*|striking\s+distance|low[- ]hanging)\b[\s\S]*\b(?:seo|keywords?|gsc)\b/i, ['quoxseo_opportunities']],
  [/\b(?:seo|crawl\w*|search console|gsc|sitemap|indexing)\b/i, ['quoxseo_summary', 'quoxseo_issues']],
  // MATRIX WORKER2: Docker reads had no route, so asks went to fleet_status/quox_cli or the legacy
  // docker_extended (default host docker01). The fleet tools are the hardened per-host reads.
  // quox#976: only 'which hosts run Docker' / 'docker hosts', never 'docker status on host X' (docker_status answers that)
  [/\b(?:which|what)\b[\s\S]*\b(?:hosts?|servers?|machines?|boxes)\b[\s\S]*\b(?:run|runs|running|have|has|with)\s+docker\b|\bdocker\s+(?:hosts?|servers?)\b/i, ['docker_fleet_scan']],
  [/\b(?:docker|containers?)\b[\s\S]*\blogs?\b|\blogs?\b[\s\S]*\b(?:docker|containers?)\b/i, ['docker_fleet_logs', 'docker_logs']],
  [/\b(?:docker|containers?)\b[\s\S]*\b(?:memory|cpu|stats|resources?)\b|\b(?:memory|cpu|stats)\b[\s\S]*\b(?:docker|containers?)\b/i, ['docker_fleet_stats', 'docker_stats']],
  // SDK-TEAM (proofSuiteDefaultReach 2026-10-19): notes/note-read was reachable only by the ranked pick; "open/read my
  // note X" is notesq_read (quox holds it). The specialist-held siblings of this fix are the *-hint governed routes.
  [/\b(?:open|read|show(?:\s+me)?|summari[sz]e)\s+(?:my\s+|the\s+)?note\b/i, ['notesq_read']],
  [/\b(?:inbox|mail|e-?mails?|mailbox)\b/i, ['inbox_zones', 'inbox_search', 'inbox_accounts']],
  [/\b(?:defcon|safety|kill.?switch\w*|e-?stop\w*|halted|threat level)\b/i, ['safety_status']],
  // #818: recency of actions and evidence needs timestamps; peers' capabilities need the registry.
  [/\b(?:most recent|latest|last|newest)\b[\s\S]*\b(?:actions?|envelopes?|events?|evidence|receipts?)\b|\bevidence chain\b/i, ['query_envelopes', 'get_envelope_chain']],
  [/\b(?:agents?|specialists?)\b[\s\S]*\b(?:can|talk|handles?|does|do|capabilit\w*|available|which|who)\b|\b(?:which|what|who)\b[\s\S]*\b(?:agents?|specialists?)\b/i, ['agent_directory']],
  [/\bmemor\w*\b[\s\S]*\b(?:history|revisions?|versions?)\b|\b(?:history|revisions?|versions?)\b[\s\S]*\bmemor\w*/i, ['memory_history', 'memory_search']],  // READ-CLASS (BRAIN2 proofSuiteDefaultReach misses 2026-10-15): governed reads in quox's grant that the
  // ranked pick never reached for their ask. Reads only.
  // GRC artifacts (DPIA, SoA, AI Act classification) are compliance_read; "SOA record" (DNS) is not.
  [/\bdpias?\b|\bdata protection impact assessments?\b|\bstatement of applicability\b|\bai act\b[\s\S]*\bclassif\w*/i, ['compliance_read']],
  // "why does / doesn't X come back when I search my brain" is the brain's ranking explanation.
  [/^(?=[\s\S]*\b(?:brain|brain2|qortex|knowledge)\b)(?:[\s\S]*\brank(?:ing|ed|s)?\b[\s\S]*\b(?:explain\w*|explanation|why)\b|[\s\S]*\b(?:explain\w*|explanation|why)\b[\s\S]*\brank(?:ing|ed|s)?\b|[\s\S]*\b(?:come|comes|came)\s+back\b[\s\S]*\bwhy\b|[\s\S]*\bwhy\b[\s\S]*\b(?:come|comes|came)\s+back\b)/i, ['brain_why']],
  // Is a named workflow valid: the workflow validator, not a run.
  [/\bworkflows?\b[\s\S]*\b(?:valid|validate|validation|validity)\b|\b(?:valid|validate|validation|validity)\b[\s\S]*\bworkflows?\b/i, ['validate_workflow']],
  // When a workflow runs on its schedule / cron: the registered schedule triggers.
  [/\bworkflows?\b[\s\S]*\b(?:schedules?|scheduled|cron|next\s+run)\b|\b(?:schedules?|cron|next\s+run)\b[\s\S]*\bworkflows?\b/i, ['list_schedules']],
  // READ-CLASS: specialist-held reads quox does not hold. Routing names the tool, so the delegate offer
  // says who holds it (0e+ hint) instead of the model improvising with a held sibling. Reads only.
  [/\btools?\b[\s\S]*\bresolve[sd]?\s+to\b/i, ['agent_tools']],
  [/\btool\s+load\b|\broster\s+coverage\b|\b(?:thin|bloated)\b[\s\S]*\btools?\b|\btools?\b[\s\S]*\b(?:thin|bloated)\b/i, ['roster_coverage']],
  [/\b(?:all|every|each)\b[\s\S]*\bdocker\s+hosts?\b[\s\S]*\bcontainers?\b|\bcontainers?\b[\s\S]*\b(?:across|on)\s+(?:all|every)\b[\s\S]*\bdocker\b/i, ['docker_fleet_containers']],
  [/\b(?:this|the)\s+box\b[\s\S]*\b(?:health\w*|cpu|memory|disk)\b|\bhow\s+healthy\b[\s\S]*\bbox\b|\bbox\s+health\b/i, ['box_health']],
  [/\b(?:which|what)\s+settings\b|\bsearch\b[\s\S]*\bsettings\b|\bsettings\b[\s\S]*\b(?:affect|control|govern)\w*\b/i, ['settings_search']],
  [/\balerts?\b[\s\S]*\b(?:fired|history|over\s+the\s+(?:last|past)|yesterday|last\s+\d+\s*(?:h|hours?|days?))\b|\balert\s+history\b/i, ['alerts_history']],
  [/\b(?:prometheus|promql|metrics?)\b[\s\S]*\b(?:over\s+the\s+(?:last|past)|over\s+time|range|steps?|trend)\b/i, ['metrics_query']], // #1062: prometheus_range retired, metrics_query runs range queries (range, step)
  [/\b(?:is|are)\s+(?:https?:\/\/\S+|(?:[a-z0-9-]+\.)+[a-z]{2,})\s+(?:up|down|responding|reachable|online)\b|\buptime\s+check\b/i, ['uptime_check']],
  // Wazuh reads (ARGUS holds the wazuh_* tools over the collector's Wazuh backend, lib/wazuhReads.js). quox_cli stays as the fallback read leaf (`quox mon wazuh ...`). Asks must name Wazuh; a deploy / install / remove /
  // enrol ask is an act and is never routed to a read.
  [/^(?![\s\S]*\b(?:deploy|install|remove|uninstall|delete|enrol|enroll|add|register|restart|upgrade)\b)(?:[\s\S]*\bwazuh\b[\s\S]*\b(?:agents?|reporting|connected|enrolled)\b|[\s\S]*\b(?:agents?|reporting|connected|enrolled)\b[\s\S]*\bwazuh\b)/i, ['wazuh_agents', 'quox_cli']],
  [/\bwazuh\b[\s\S]*\bmanager\b[\s\S]*\b(?:healthy|health|status|running|up|ok|daemons?)\b|\bmanager\b[\s\S]*\b(?:healthy|health|status|daemons?)\b[\s\S]*\bwazuh\b|\bwazuh\b[\s\S]*\b(?:healthy|health|daemons?)\b/i, ['wazuh_manager_status', 'quox_cli']],
  [/\bwazuh\b[\s\S]*\balerts?\b|\balerts?\b[\s\S]*\bwazuh\b/i, ['wazuh_alerts', 'quox_cli']],
  [/\bwazuh\b[\s\S]*\bvulnerab\w*|\bvulnerab\w*[\s\S]*\bwazuh\b/i, ['wazuh_vulnerabilities', 'quox_cli']],
  [/\b(?:for|in)\s+(?:my\s+)?notes?\b[\s\S]*\b(?:look\s+into|research|sources?)\b|\bnotesq\b[\s\S]*\bresearch\b|\bresearch\b[\s\S]*\bfor\s+a\s+note\b/i, ['notesq_research']],
  [/\b(?:vms?|proxmox|cluster)\b[\s\S]*\bsnapshots?\b|\bsnapshots?\b[\s\S]*\b(?:vms?|proxmox|cluster)\b/i, ['proxmox_read']],
  [/^(?=[\s\S]*\b(?:proxmox|hyperion)\b)[\s\S]*\b(?:vms?|guests?|virtual machines?)\b[\s\S]*\b(?:cpu|memory|ram|resources?)\b/i, ['proxmox_read']],
  [/\bgovernance\b[\s\S]*\b(?:templates?|packs?)\b|\bpolicy\s+(?:packs?|templates?)\b/i, ['governance_get_templates']],
  // #1062 retired the uptime_dependencies stub (no backend); the wazuh_* tools are real again (see the wazuh routes above). The system_* reads stay (system_admin
  // always files an approval card for an agent call, so a host-stats read ask is never routed to it).
  // quox#1013: VOLT certify / bundle are auditus WRITES (quox holds only the VOLT reads). Routing the
  // act names the tool, so quox's delegate offer says auditus holds it (0e+) instead of the model
  // answering with volt_verify_run; auditus itself is offered the tool. A read of an existing
  // certificate or bundle ("show the certification", "download the bundle") does not route here.
  [/^(?=[\s\S]*\bvolt\b)[\s\S]*(?:\bcertify\b|\b(?:run|create|issue|perform|do|start)\s+(?:a\s+|an\s+|the\s+|new\s+)*(?:volt\s+)?certification\b)/i, ['volt_certify_run']],
  [/^(?=[\s\S]*\b(?:volt|evidence)\b)[\s\S]*\b(?:create|build|make|generate|package)\s+(?:a\s+|an\s+|the\s+|new\s+)*(?:portable\s+)?(?:volt\s+|evidence\s+)*bundle\b/i, ['volt_create_bundle']],
  // fleet host reads (NOVA holds the system_* reads; system_admin is approval-gated active ops). Never a container ask.
  [/^(?![\s\S]*\b(?:containers?|docker)\b)[\s\S]*\bmemory\b[\s\S]*\b(?:in\s+use|used|free|cached|swap|breakdown)\b/i, ['system_memory']],
  [/\bhow\s+long\b[\s\S]*\bbeen\s+up\b|\bload\s+averages?\b/i, ['system_uptime']],
  [/^(?![\s\S]*\b(?:containers?|docker)\b)(?:[\s\S]*\bhow\s+full\b[\s\S]*\bdisks?\b|[\s\S]*\bdisks?\b[\s\S]*\bhow\s+full\b|[\s\S]*\bdisk\s+(?:usage|space)\b|[\s\S]*\bfree\s+(?:disk\s+)?space\b)/i, ['system_disk_usage']],
  [/\bprocesses\b[\s\S]*\b(?:cpu|memory|most|top|using)\b|\btop\s+processes\b/i, ['system_processes']],
  [/^(?![\s\S]*\b(?:containers?|docker)\b)[\s\S]*(?:\bjournal(?:ctl)?\b|\bsyslog\b|\bsystemd\s+logs?\b|\bsystem\s+logs?\b)/i, ['system_logs']],
  // quox#1090 intent pins (above): routed so a non-holder's delegate offer names holder and tool.
  ...INTENT_PINS.map((p) => [{ test: (m) => intentPinsFor(m).includes(p) }, [p.tool]]),
];
// QUOXON-ASK lane J: the CLI reach fallback. When the user's words name a quox CLI
// group (or say "quox <verb>" / "cli") and NO pool tool matches by name, quox_cli is
// offered so the ask can still be done; a dedicated tool that matches by name wins.
// quox_cli_write rides the same rule but stays a write (offered only on write intent).
const CLI_TOOLS = ['quox_cli', 'quox_cli_write'];
function strongCliMatch(message) {
  try { return require('./quoxCli/candidates.js').strongCliMatch(String(message || '')); } catch { return null; }
}
function leafNamed(message) {
  try { return require('./quoxCli/candidates.js').leafNamedMatch(String(message || '')); } catch { return null; }
}
function cliCandidateHint(message) {
  try { return require('./quoxCli/candidates.js').candidateHint(String(message || ''), { k: 5 }); } catch { return ''; }
}
// Group names that are ordinary words or never-class groups: they never signal CLI intent.
const CLI_GENERIC_GROUPS = new Set(['status', 'health', 'open', 'run', 'file', 'tag', 'chat', 'setup', 'config', 'done', 'watch', 'wrap',
  'tips', 'x', 'server', 'motion', 'scope', 'service', 'login', 'logout', 'signup', 'completion', 'tui', 'account', 'doctor', 'build',
  'policy', 'prompt', 'role', 'team', 'tool', 'dashboard', 'claude', 'codex', 'gemini', 'onboard', 'whoami', 'sitrep', 'sessions']);
let _cliGroups = null;
function cliGroups() {
  if (_cliGroups) return _cliGroups;
  _cliGroups = new Set();
  try {
    const tree = require('../config/cliLeafTree.json');
    for (const k of Object.keys(tree.leaves || {})) {
      const g = k.split(' ')[0];
      if (!CLI_GENERIC_GROUPS.has(g)) { _cliGroups.add(g); _cliGroups.add(stem(g)); }
    }
  } catch { /* no tree: the fallback only fires on an explicit "quox <verb>" */ }
  return _cliGroups;
}
let _cliVerbs = null;
/** The leaf verbs (last word of each leaf), stemmed, minus anything that is also a group name. */
function cliVerbs() {
  if (_cliVerbs) return _cliVerbs;
  _cliVerbs = new Set();
  try {
    const keys = Object.keys(require('../config/cliLeafTree.json').leaves || {});
    const groups = new Set(keys.map((k) => k.split(' ')[0]));
    for (const k of keys) { const v = k.split(' ').pop(); if (!groups.has(v)) _cliVerbs.add(stem(v)); }
  } catch { /* no tree */ }
  for (const v of ['list', 'show', 'get', 'read', 'view', 'search', 'status', 'run', 'set', 'what', 'which', 'verify', 'verified']) _cliVerbs.add(stem(v));
  // Context words that say WHERE, not WHAT (org_directory must not swallow "for this org").
  for (const v of ['org', 'orgs', 'organization', 'organisation', 'quox', 'instance', 'install', 'account', 'yesterday', 'today', 'week']) _cliVerbs.add(stem(v));
  return _cliVerbs;
}
const CLI_EXPLICIT_RE = /\bquox\s+[a-z][a-z-]+|\b(?:cli|command line)\b/i;
function hasCliIntent(message) {
  const m = String(message || '');
  if (CLI_EXPLICIT_RE.test(m)) return true;
  const groups = cliGroups();
  return tokens(m).some((t) => groups.has(t) || groups.has(stem(t)));
}

// QUOXON lane S: the user asks to create or attach to a slot. A write route (the tools are
// still offered only on write intent; attach/checkout/claim count as write words).
const SLOT_CREATE_RE = /\b(?:create|make|new|add|attach|check ?out|checkout|claim|join|set ?up|open)\b[\s\S]*\bslots?\b|\bslots?\b[\s\S]*\b(?:create|make|new|attach|check ?out|checkout|claim|join)\b/i;
const SLOT_WRITE_TOOLS = ['slot_checkout', 'slot_create'];
// QUOXON-ASK J2 (quox#868): "say hello to the X slot" is a message into a slot. Talking to a
// slot is the write here, so these words count as write intent only next to "slot".
const SLOT_SAY_RE = /\b(?:say|tell|post|message|ping|send|greet)\b[\s\S]*\bslots?\b|\bslots?\b[\s\S]*\b(?:say|tell|post|message|ping|send)\b/i;
// Task/inbox tools that agents reached for as a stand-in for a missing capability. On an
// intent a real tool or command covers, they are withheld unless the user asks for a task.
const STAND_IN_TOOLS = new Set(['create_inbox_item', 'action_add']);
const REAL_COMMAND_INTENTS = [SLOT_CREATE_RE];
const TASK_ASK_RE = /\b(?:tasks?|to-?dos?|tickets?|inbox items?|reminders?|remind me|follow.?ups?|escalat\w*)\b/i;
function standInWithheld(message) {
  const m = String(message || '');
  return REAL_COMMAND_INTENTS.some((re) => re.test(m)) && !TASK_ASK_RE.test(m);
}

/**
 * Z2H-7B: asks for LIVE data that only a tool can answer. When the turn cannot offer the tool
 * (licence, plan mode, not held) lib/toolAvailability.js answers with a fixed, honest reply and
 * makes no model call: a small model handed such a question with no tool invents the facts
 * (qwen2.5 7B invented a host list 5/5 on a free install; offered the tool it called it 6/6).
 * Kept to explicit live-state asks: a wrong match here costs a refusal, so add a row only for a
 * question no prose answer can satisfy. `plugin` is the licence the tool's route enforces.
 */
const LIVE_DATA_NEEDS = [
  { id: 'fleet', label: 'Fleet status', tools: ['fleet_status'], plugin: 'bastion-fleet',
    test: (m) => (HOST_STATUS_RE.test(m) || FLEET_COUNT_RE.test(m) || singleHostFrom(m) !== null) && !REACH_ASK_RE.test(m) },
];
function liveDataNeeds(message) {
  // Z2H-7B4: a follow-up typed while another turn ran arrives wrapped; detect on the user's own words.
  const m = unwrapQueued(message);
  return LIVE_DATA_NEEDS.filter((n) => n.test(m));
}

// QUOXON handoff offer (2026-10-17): asks that plainly need a capability but name no product ("which VMs use the most
// CPU and memory" names no Proxmox). Consulted ONLY for unheldHints (the handoff offer), never for the offer or the
// delegate_to_agent hint text, so CommanderQ's own routing is unchanged.
const SCOPE_ONLY_ROUTES = [
  [/\b(?:vms?|virtual machines?|guests?)\b[\s\S]*\b(?:cpu|memory|ram|resources?|load)\b|\b(?:cpu|memory|ram)\b[\s\S]*\b(?:vms?|virtual machines?)\b/i, ['proxmox_read', 'proxmox_vms']],
];
function scopeRoutedToolNames(message) {
  const m = unwrapQueued(message);
  const out = routedToolNames(message);
  for (const [re, names] of SCOPE_ONLY_ROUTES) if (re.test(m)) for (const n of names) if (!out.includes(n)) out.push(n);
  return out;
}

function routedToolNames(message) {
  const m = unwrapQueued(message);
  const out = [];
  for (const [re, names] of INTENT_ROUTES) if (re.test(m)) for (const n of names) if (!out.includes(n)) out.push(n);
  return out;
}

// QUOXON-ENGINE lane N, class 1 (wrong tool: a raw source picked over the governed store,
// #837 #840 #811 #831 quoxmcp#2). When the user's words name a domain a governed Quox store
// answers, that store's read is offered first and the raw source for the same domain is
// withheld: from the offer, from more_tools and from the catalogue path. `raw` is withheld
// only when a governed tool of the route is in the pool, so a pool without the governed
// store is never stranded; `wrongStore` names tools that read a DIFFERENT store than the
// one asked about and are withheld whenever the route fires.
const HOWTO_RE = /\bhow (?:do|can|would|should|to)\b|\bwhat(?:'s| is) the (?:command|cli)\b|\bwhich command\b/i;
const GOVERNED_ROUTES = [
  { id: 'voice', gripe: 'quox#837',
    intent: /\b(?:voicemails?|quoxvoice|(?:who|what)\s+(?:called|rang)|call\s+(?:log|history|records?|transcripts?|summar\w*))\b|(?<!\b(?:tool|api|function|rpc|http|network|model|llm|system|method|fetch|database|db)\s)\b(?:phone\s+|voice\s+|inbound\s+|outbound\s+|missed\s+)?calls\b/i,
    // voice_calls where granted, else quox_cli (`quox voice calls`, a read leaf) reaches the same store.
    governed: ['voice_calls', 'quox_cli'], raw: [/^twilio_/, /^dialpad_/, /^vonage_/, /^aircall_/] },
  // Per-line POLICY/config questions (how a QuoxLine answers): opener brand/name, IVR menu,
  // voice/language/persona/verbosity. Reads the numbers store (what `quox voice numbers` shows),
  // distinct from the call-log route above.
  { id: 'voice-policy',
    intent: /\b(?:opener|quoxline|ivr\s+menu|voice\s+(?:line|number|policy|setting)s?|line\s+(?:policy|config\w*|setting)s?|(?:how|what)\s+(?:does|do|is|name)\b[^.?!]*\bline\s+(?:answer|say|speak|greet)|answers?\s+(?:as|with))\b/i,
    // voice_numbers where granted, else quox_cli (`quox voice numbers`, a read leaf) reaches the same store.
    governed: ['voice_numbers', 'quox_cli'], raw: [] },
  // QUOXON-AGG quox#900 objectives/objective-count-completed: "how many objectives completed"
  // is a COUNT by state, read from objective_counts (the list `quox objective list` reads).
  { id: 'objective-counts', gripe: 'quox#900',
    intent: /\b(?:how many|count|number of|totals?|breakdown)\b/i,
    requires: (m) => /\bobjectives?\b/i.test(m),
    governed: ['objective_counts'], raw: ['quox_cli'] },
  { id: 'files-plugin', gripe: 'quox#840',
    intent: /\bfiles?\s+plugin\b|\bquox\s+files?\b|\bfile\s+(?:storage\s+)?stats\b/i,
    governed: ['files_plugin_list', 'quox_cli'], wrongStore: ['list_files', 'search_files', 'read_file'] },
  // QUOXON-PROOF: "my files / my file store / files I uploaded" is the Files plugin store
  // (`quox file list`), never the org knowledge store (list_files: widget docs, chat uploads).
  // A knowledge-base / widget / docs ask is the other store and keeps list_files.
  { id: 'my-files', gripe: 'QUOXON-PROOF files/file-count',
    intent: /\b(?:my|our)\s+(?:uploaded\s+)?(?:files?|file\s+(?:store|storage|library))\b|\bfile\s+(?:store|storage)\b|\bfiles?\s+(?:i|we)(?:'ve|\s+have)?\s+upload\w*|\b(?:i|we)(?:'ve|\s+have)?\s+uploaded\b/i,
    unless: /\bknowledge(?:\s*-?\s*(?:base|store))?\b|\bwidgets?\b|\bdocs?\b|\bquoxchat\b|\bchat\s+uploads?\b/i,
    governed: ['files_plugin_list', 'quox_cli'], wrongStore: ['list_files', 'search_files', 'read_file'] },
  // QUOXON-PROOF: "what's working / what works / proof board / pass rate" is the proof matrix,
  // read from proof_status; DoneEngine readiness is a different instrument.
  { id: 'proof-board', gripe: 'QUOXON-PROOF proof board',
    intent: /\b(?:what(?:'s|\s+is|\s+are)?|which|stuff|things?|features?|capabilit\w+)\s+(?:that\s+|which\s+)?(?:is\s+|are\s+|that'?s\s+)?(?:working|works|proven|passing)\b|\bwhat\s+works\b|\bproof\s+(?:engine|board|matrix|row|suite|status)\b|\b(?:proof|capability)\s+matrix\b|\bthe\s+matrix\b|\bpass\s+rate\b|\b\d+\s*\/\s*\d+\s+pass\b/i,
    governed: ['proof_status'], raw: [] },
  // QUOXON-PROOF notes/note-collections|note-collection-count|note-top-tag: collection and tag
  // counts of NotesQ notes come from notesq_list { facets: true } (the same store as
  // `quox notes facets`), not from a shelled CLI call.
  { id: 'notes-facets', gripe: 'QUOXON-PROOF notes',
    intent: /\b(?:notesq|notes?)\b[\s\S]*\b(?:collections?|tags?)\b|\b(?:collections?|tags?)\b[\s\S]*\b(?:notesq|notes?)\b/i,
    governed: ['notesq_list'], raw: ['quox_cli'] },
  // Proof run 2026-10-14 (notes lane): notebook health, revision history, related notes and link
  // suggestions are named NotesQ reads, never a shelled CLI call.
  { id: 'notes-health', gripe: 'QUOXON-PROOF notes',
    intent: /\b(?:notesq|notes?|notebook)\b/i,
    requires: (m) => /\b(?:health\w*|duplicates?|stale|broken\s+links?|orphan\w*)\b/i.test(m),
    governed: ['notesq_health'], raw: ['quox_cli'] },
  { id: 'notes-history', gripe: 'QUOXON-PROOF notes',
    intent: /\b(?:notesq|notes?)\b/i,
    requires: (m) => /\brevisions?\b|\bversion\s+history\b|\bedit\s+history\b|\bprevious\s+versions?\b/i.test(m),
    governed: ['notesq_history'], raw: ['quox_cli'] },
  { id: 'notes-related', gripe: 'QUOXON-PROOF notes',
    intent: /\b(?:notesq|notes?)\b/i,
    requires: (m) => /\brelated\b|\bsimilar\b/i.test(m),
    governed: ['notesq_related'], raw: ['quox_cli'] },
  { id: 'notes-suggest-links', gripe: 'QUOXON-PROOF notes',
    intent: /\b(?:notesq|notes?)\b/i,
    requires: (m) => /\bsuggest\w*\b[\s\S]*\blink\w*\b|\blink\w*\b[\s\S]*\bsuggest\w*\b/i.test(m),
    governed: ['notesq_suggest_links'], raw: ['quox_cli'] },
  // QUOXON-PROOF #864: "how many items are open / urgent" in the HITL queue is a COUNT, read
  // from inbox_stats (the same numbers as `quox inbox stats`), never from a capped page.
  // QUOXON-PROOF code/latest-build-receipt: build receipts are the quox-build queue
  // (`quox build latest`, a read leaf), not the audit trail or chat history.
  { id: 'build-receipts', gripe: 'QUOXON-PROOF code/latest-build-receipt',
    intent: /\bbuild\s+(?:receipts?|history|queue|log)\b|\b(?:latest|last|recent(?:ly)?|most recent(?:ly)?)\s+builds?\b|\bbuilt\s+(?:most\s+)?recently\b|\bwhat\s+(?:was|got)\s+built\b/i,
    governed: ['quox_cli'], wrongStore: ['query_envelopes', 'session_search', 'get_envelope_chain'] },
  // CONTACTSQ v19 (owner 2026-10-14): a count about the address book (how many contacts, unknown callers
  // waiting for review, do-not-call additions) reads contacts_count and contacts_brief, never a page of search
  // results or a delegation. Both are counts only, no personal data.
  { id: 'contacts-count', gripe: 'quox#900',
    intent: /\b(?:how many|count|number of|totals?|stats|statistics|breakdown)\b/i,
    requires: (m) => /\bcontacts?\b|\baddress\s+book\b|\bcallers?\b|\bdo[- ]not[- ]call\b|\bdnc\b|\bcontactsq\b|\borganisations?\b|\borganizations?\b/i.test(m),
    governed: ['contacts_count', 'contacts_brief'], raw: [] },
  // CONTACTSQ (proof contact-propose-fact, 2026-10-15): "propose / record a fact about <contact>" is
  // contacts_propose_fact (lands for human review, reaches no one). The model reached for quox_cli,
  // guessed flags on a never-leaf and gave up; the CLI has no propose verb, so it is withheld here.
  { id: 'contacts-fact', gripe: 'CONTACTS-Q proof contact-propose-fact',
    intent: /\b(?:propose|record|note|remember|add|save|store|log)\b[\s\S]*\bfacts?\b|\bfacts?\b[\s\S]*\b(?:propose|record|remember|add|save|store)\b/i,
    requires: (m) => /\bcontacts?\b|\bcontactsq\b|\baddress\s+book\b/i.test(m),
    governed: ['contacts_propose_fact', 'delegate_to_agent'], allowWrite: true, raw: ['quox_cli', 'quox_cli_write'] },
  // Proof contacts/contact-handoff-write (2026-10-17): "leave a handoff note on <contact>" is ContactsQ's contacts_handoff.
  // quox does not hold it and wrote the note itself through quox_cli_write, so the governed tool never ran. Same shape
  // as seo-verify-delegate: the delegation is the offer, the CLI leaves it, the #1064 hint names contactsq and the tool.
  // A read of handoffs (show / list / what handoffs) is not a write and is not routed.
  { id: 'contacts-handoff-delegate', gripe: 'proof contacts/contact-handoff-write',
    intent: /\b(?:leave|add|write|record|log|create|make|put|hand(?:ing)?)\b[\s\S]{0,40}?\bhand-?\s?offs?\b|\bhand(?:ing)?\s+off\b[\s\S]{0,60}?\bnotes?\b/i,
    requires: (m) => /\bcontacts?\b|\bcontactsq\b|\baddress\s+book\b/i.test(m),
    unless: /\b(?:show|list|read|what|which|any|open)\b[\s\S]{0,20}\bhand-?\s?offs?\b/i,
    governed: ['delegate_to_agent'], allowWrite: true, raw: ['quox_cli', 'quox_cli_write'], displaces: ['quox_cli', 'quox_cli_write'] },
  // Proof plan/plan-create-proof-stream (2026-10-17): "create a new QuoxPlan stream on <roadmap>" is quoxplan_create_stream,
  // which ROADY holds and quox does not (grant line ~12224). On dev the turn shelled quox_cli_write and the stream was not
  // created, so the governed create never ran. Same shape as contacts-handoff-delegate: the delegation is the offer, the CLI
  // leaves it, the #1064 hint names the holder and the tool. A list/show/read of streams, or an add-phase, is not routed.
  { id: 'plan-create-stream-delegate', gripe: 'proof plan/plan-create-proof-stream',
    intent: /\b(?:create|add|make|new|start|open|set\s*up)\b[\s\S]{0,40}?\bstream\b/i,
    requires: (m) => /\bquoxplan\b|\bquox\s*plan\b|\broadmap\b/i.test(m),
    unless: /\b(?:list|show|read|what|which|status|notes?|phases?|brief)\b/i,
    governed: ['delegate_to_agent'], allowWrite: true, raw: ['quox_cli', 'quox_cli_write'], displaces: ['quox_cli', 'quox_cli_write'] },
  { id: 'hitl-count', gripe: 'quox#864',
    intent: /\b(?:how many|count|number of|totals?|stats|statistics|breakdown)\b/i,
    requires: (m) => /\bapprov\w*|\bhitl\b|\bwork ?queue\b|\binbox items?\b|\b(?:quox|approvals?) inbox\b|\bincidents?\b|\btriage\b/i.test(m),
    governed: ['inbox_stats'], raw: [] },
  // Proof run 2026-10-15 (mail lane): "block sender X / create a folder / file these into a folder" is the
  // InboxQ propose tools (one Approvals item, nothing changes until approved). The ask is the request;
  // the model shelled quox_cli instead, so the CLI is withheld for the turn.
  { id: 'mail-propose', gripe: 'QUOXON-PROOF mail-propose',
    intent: /\b(?:inbox|inboxq|mail|mailbox|e-?mails?|sender|folders?)\b/i,
    requires: (m) => /\bblock\w*\b[\s\S]*\b(?:senders?|domains?|e-?mails?|mail|address)\b|\b(?:create|make|add|new)\b[\s\S]*\bfolders?\b|\bfile\b[\s\S]*\binto\b[\s\S]*\bfolders?\b|\bfiling folder\b/i.test(m),
    governed: ['inbox_propose_block', 'inbox_propose_create_folder', 'inbox_propose_move'], allowWrite: true, raw: ['quox_cli', 'quox_cli_write'] },
  { id: 'mail', gripe: 'quox#811',
    intent: /\b(?:inbox|mail|e-?mails?|mailbox)\b/i, unless: /\bapprov\w*|\bhitl\b|\bsign-?offs?\b/i,
    governed: ['inbox_zones', 'inbox_search', 'inbox_accounts', 'email_read'], raw: ['inbox_pending', 'list_approvals'] },
  // Proof run 2026-10-15 (mail lane): "mail proposals / what does the inbox suggest" is the InboxQ
  // proposals list (inbox_proposals), never a shelled CLI call or the HITL approvals queue.
  { id: 'mail-proposals', gripe: 'QUOXON-PROOF mail',
    intent: /\b(?:inbox|inboxq|mail|e-?mails?|mailbox)\b/i, unless: /\bhitl\b|\bwork ?queue\b/i,
    requires: (m) => /\bproposals?\b|\bproposed\b|\bsuggest\w*/i.test(m),
    governed: ['inbox_proposals'], raw: ['quox_cli', 'inbox_pending', 'list_approvals'] },
  // Proof blitz 2026-10-15 (code lane, quox#942): build-receipt / log / streak / preflight asks are BOB's
  // named read tools (build_receipts store, deterministic streak, importer grep). quox answered them via
  // quox_cli and never delegated, so the purpose tools never ran. Reads only; bob_dispatch_build and
  // bob_mark_build_outcome stay with BOB (approval-gated) and are never offered here.
  { id: 'bob-build', gripe: 'quox#942',
    intent: /\bbuild\s+(?:receipts?|results?|history|logs?|status|targets?)\b|\b(?:latest|last|recent|most recent)\s+(?:\d+\s+)?build\b|\bbuild\b[\s\S]*\b(?:log\s+tail|repeated[- ]failures?|failure\s+streak|streak)\b|\brepeated[- ]failure\b|\bpre-?flight\b[\s\S]*\b(?:blast|import\w*)\b|\bblast[- ]radius\b/i,
    unless: /\b(?:dispatch|deploy|trigger|start|kick off|run)\s+(?:a|the)\s+build\b|\bbuild\s+it\b/i,
    governed: ['bob_build_status', 'bob_build_history', 'bob_log_tail', 'bob_detect_repeated_failures', 'bob_preflight', 'bob_build_targets'], raw: ['quox_cli', 'codebase_query'],
    // build-receipts (above) also prefers quox_cli; when BOB's reads are in the pool they win and quox_cli stands down.
    displaces: ['quox_cli'] },
  { id: 'browser', gripe: 'quoxmcp#2',
    intent: /\b(?:screenshots?|console|render(?:s|ed|ing)?|looks?\s+like|layout|css|computed\s+styles?|dom|in\s+(?:a|the)\s+(?:governed\s+)?browser|governed\s+(?:browser|read)|qlarity|browserq|inspect\w*)\b/i,
    requires: (m) => hasUrlInMessage(m) || /\b(?:page|site|website|url)\b/i.test(m),
    governed: ['qlarity_open', 'qlarity_inspect', 'qlarity_close'], raw: ['web_read', 'quox_cli'] },
  // Proof blitz 2026-10-15 (browser lane, quox#976): "ask Browser-Q to open <url>" names the agent that holds
  // the browser_* tools (the quox hat does not grant them). quox answered with the qlarity read tier instead
  // of delegating, so the specialist's own tools never ran. When the user names Browser-Q, the offer is the
  // delegation and the qlarity/web_read stand-ins leave it (the generic browser route above still serves
  // asks that do not name the agent).
  // Proof mind/t3-brain-suggestions: "what (kinds of) questions could I ask my brain / Qortex" is Cortex's
  // starter-question read (brain_suggestions); quox does not hold it (quox#1064) and answered with quox_cli.
  // The delegation is the offer here and the stand-in leaves it; the #1064 hint on delegate_to_agent names
  // cortex and the tool. No tool outside quox's grant is routed.
  // SDK-TEAM (proofSuiteDefaultReach 2026-10-19): specialist-held reads reachable only by the ranked unheld hint (quox#1064),
  // which stands down whenever a held tool scores as high, so a growing pool dropped them. `hint` names the tool and
  // its holder on the offered delegation. quox is never offered a tool it does not hold.
  { id: 'arp-hint', gripe: 'proof fleet/t1-network_arp',
    intent: /\barp\b|\bneighbou?r\s+table\b/i,
    governed: ['delegate_to_agent'], raw: [], hint: ['network_arp'] },
  // one named sequence (open/load/show ... called/named X) is the load; "what/which sequences do I have" is the list
  { id: 'browser-sequence-load-hint', gripe: 'proof browser/t2-browser-sequence-load',
    intent: /\b(?:open|load|show|run|read)\b[\s\S]*\bsequence\s+(?:called|named)\b/i,
    governed: ['delegate_to_agent'], raw: [], hint: ['browser_sequence_load'] },
  { id: 'browser-sequence-list-hint', gripe: 'proof browser/t2-browser-sequence-list',
    intent: /\b(?:what|which|list|show)\b[\s\S]*\b(?:browser\s+)?sequences\b/i,
    governed: ['delegate_to_agent'], raw: [], hint: ['browser_sequence_list'] },
  { id: 'brain-suggestions-delegate', gripe: 'proof mind/t3-brain-suggestions',
    intent: /\b(?:what|which)\b(?:\s+\w+){0,3}?\s+questions?\b[\s\S]{0,30}?\b(?:can|could|should|might)\s+i\s+ask\b|\bwhat\s+(?:can|could|should)\s+i\s+ask\b|\b(?:suggest|give\s+me|list)\b[\s\S]{0,30}?\bquestions?\b[\s\S]{0,30}?\bask\b|\bstarter\s+questions?\b/i,
    requires: (m) => /\b(?:brain2?|qortex|second\s+brain)\b/i.test(m),
    governed: ['delegate_to_agent'], raw: ['quox_cli'], displaces: ['quox_cli'], hint: ['brain_suggestions'] },
  // Proof seo/t2-seo-verify (2026-10-17): "verify our SEO crawl history: signatures, root hashes, is the record intact"
  // is SEER's quoxseo_verify (the SEO WARD chain + tip signatures + per-crawl root hashes). quox does not hold it and
  // answered twice through quox_cli, so the governed verify never ran. Same shape as brain-suggestions-delegate: the
  // delegation is the offer, quox_cli leaves it, the #1064 hint names seer and the tool. No tool outside quox's grant.
  { id: 'seo-verify-delegate', gripe: 'proof seo/t2-seo-verify',
    intent: /\b(?:verif\w*|intact|tamper\w*|integrity|signatures?|root\s+hash\w*)\b/i,
    requires: (m) => /\b(?:seo|crawls?)\b/i.test(m),
    governed: ['delegate_to_agent'], raw: ['quox_cli'], displaces: ['quox_cli'] },
  { id: 'browserq-named', gripe: 'quox#976',
    intent: /\b(?:ask|have|get|tell|let|use|delegate(?:\s+this)?\s+to|hand(?:\s+this)?\s+(?:off\s+)?to|send(?:\s+this)?\s+to)\s+(?:the\s+)?browser-?q\b/i,
    governed: ['delegate_to_agent'], allowWrite: true, raw: ['qlarity_open', 'qlarity_inspect', 'qlarity_close', 'web_read'],
    displaces: ['qlarity_open', 'qlarity_inspect', 'qlarity_close', 'web_read'] },
  // class 5 (can't, and doesn't say how): a how-to ask, or one that maps to a real TUI / CLI
  // command (slots: "attach to new slot QUOX1"), offers the command lookup.
  { id: 'command', gripe: 'QUOXON slots 2026-10-14',
    intent: /[\s\S]/, requires: (m) => HOWTO_RE.test(m) || require('./commandGuidance.js').lookupCommands(m).matched,
    governed: ['quox_command_lookup'], raw: [] },
  // quox#911 / #909 (tool SELECTION): the purpose-named tool was in the pool but the agent chose a
  // generic sibling, so the purpose tool could never be proven. These rows offer the purpose tool
  // and withhold the generic siblings for the turn (withheld, not just left out: on the Claude CLI
  // path a tool can still be run by name, and a withheld one is refused with a pointer).
  { id: 'ward-entries', gripe: 'quox#911',
    intent: /\bward\b[\s\S]*\b(?:entr(?:y|ies)|witness\w*|recorded|list|latest|recent)\b|\b(?:entr(?:y|ies)|witness\w*)\b[\s\S]*\bward\b/i,
    unless: /\bverif\w*|\bintact\b|\btamper\w*/i,
    governed: ['ward_query_entries'], wrongStore: ['query_envelopes'] },
  // Proof blitz 2026-10-15 (receipts/refuse-fabricate-chain): "is the chain verified / intact" needs the chain
  // integrity check. ward_verify is one envelope only, so the model shelled `quox governance ward verify`
  // (no --chain, then three racing calls) instead of the governed whole-chain tool.
  { id: 'ward-chain-verify', gripe: 'proof-blitz receipts',
    intent: /\b(?:ward|witness\w*|evidence)\b[\s\S]*\b(?:chain|ledger)\b[\s\S]*\b(?:verif\w*|intact|tamper\w*|integrity)\b|\b(?:verif\w*|intact|tamper\w*|integrity)\b[\s\S]*\b(?:ward|witness\w*|evidence)\b[\s\S]*\bchain\b/i,
    // 2026-10-17: the SEO record has its own chain (quoxseo_verify, seo-verify-delegate above); the org WARD chain is not it
    unless: /\b(?:seo|crawls?)\b/i,
    governed: ['ward_verify_chain', 'ward_status'], wrongStore: ['quox_cli'] },
  // Proof blitz 2026-10-15 (receipts lane): AEE counts / queries and VOLT run reads had no route, so the
  // model shelled Bash or quox_cli (aee-total-envelopes, volt-run-count, volt-verify-run).
  { id: 'aee-query', gripe: 'proof-blitz receipts aee-query-before',
    intent: /\baee\b|\baudit trail\b/i,
    requires: (m) => /\b(?:list|show|recent|latest|before|after|since)\b/i.test(m) && /\benvelopes?\b/i.test(m),
    governed: ['aee_query_envelopes'], raw: ['quox_cli', 'Bash'] },
  { id: 'aee-stats', gripe: 'proof-blitz receipts aee-total-envelopes',
    intent: /\baee\b[\s\S]*\benvelopes?\b|\benvelopes?\b[\s\S]*\baee\b/i,
    requires: (m) => /\b(?:how many|total|count|stats|statistics)\b/i.test(m),
    governed: ['aee_get_stats'], raw: ['quox_cli', 'Bash'] },
  { id: 'volt-verify', gripe: 'proof-blitz receipts volt-verify-run',
    intent: /\bvolt\b[\s\S]*\b(?:verif\w*|intact|integrity|tamper\w*)\b|\b(?:verif\w*|intact|integrity)\b[\s\S]*\bvolt\b/i,
    governed: ['volt_verify_run', 'volt_list_runs'], raw: ['quox_cli', 'Bash'] },
  { id: 'volt-runs', gripe: 'proof-blitz receipts volt-run-count',
    intent: /\bvolt\b[\s\S]*\bruns?\b/i, unless: /\bverif\w*|\bintact\b|\bintegrity\b|\bcertif\w*|\bbundle\b/i,
    governed: ['volt_list_runs'], raw: ['quox_cli', 'Bash'] },
  { id: 'loop-sessions', gripe: 'quox#909',
    intent: /\bloop\s+sessions?\b|\b(?:running|active|my)\s+loops?\b|\bloops?\s+(?:running|in progress|status)\b/i,
    governed: ['loop_sessions'], wrongStore: ['objective_counts'] },
  { id: 'loop-suggest', gripe: 'quox#909',
    intent: /\b(?:loop|schedule)\b[\s\S]*\b(?:or|vs\.?|versus|instead of)\b[\s\S]*\b(?:loop|schedule)\b|\bshould\s+(?:this|it|that)\s+be\s+a\s+(?:loop|schedule)\b/i,
    governed: ['loop_suggest'], wrongStore: ['list_schedules', 'objective_counts'] },
  // "phone me / call me about X" IS the request: raise the governed call intent (approval-gated
  // by its own policy) instead of investigating the incident first.
  { id: 'call-intent', gripe: 'quox#909', allowWrite: true,
    intent: /\b(?:phone|call|ring)\s+me\b/i,
    governed: ['call_raise_intent'], wrongStore: ['security_audit', 'contactability_check'] },
  // QUOXON-PROOF workflows/workflow-run-detail: "what happened in workflow run X / recent runs of a
  // workflow / my executions" reads the execution store (get_execution, list_executions, the same
  // records as `quox run get|list`), never a shelled CLI call. "Run the workflow X" is an act, not this.
  { id: 'workflow-runs', gripe: 'QUOXON-PROOF workflows',
    intent: /\bworkflow\s+(?:runs?|executions?)\b|\bruns?\s+of\s+(?:the\s+)?[\w-]+\s+workflow\b|\b(?:workflow\s+)?executions?\b|\brecent\s+runs?\b|\b(?:did|has)\s+(?:the\s+)?[\w-]+\s+(?:workflow\s+)?run\b/i,
    unless: /^\s*(?:please\s+)?(?:run|execute|trigger|start)\b/i,
    governed: ['get_execution', 'list_executions'], raw: ['quox_cli'] },
  { id: 'security', gripe: 'quox#831',
    intent: /\b(?:engagements?|findings?|pen-?tests?)\b/i,
    governed: ['security_list_engagements', 'security_list_findings', 'security_get_engagement', 'security_check_policy'], raw: ['security_audit', 'quox_cli'] },
  // Proof blitz 2026-10-14: compliance posture / report / job reads are named governed tools
  // (auditus's set, on the Default hat as on-demand reads per quox#908); no quox_cli stand-in.
  { id: 'compliance', gripe: 'QUOXON-PROOF security lane',
    intent: /\bcompliance\b|\bposture\b|\b(?:iso\s*42001|soc\s*2|gdpr|nist)\b/i,
    governed: ['compliance_posture', 'compliance_get_reports', 'compliance_list_jobs'], raw: ['quox_cli'] },
  // REL424-EVIDENCE (4.2.4 proof security/t3-gov-policies, t3-gov-templates): "which policies does my org have / are
  // enabled" is the policy store list (governance_list_policies) and "which policy packs could I start from" is
  // governance_get_templates. Both stay specialist-held (SITE-CLI least-privilege ruling; turnToolSelection1064 and
  // turnIntentReadPhrasing pin the delegation), so the delegation is the offer and the #1064 hint names holder and tool.
  // On 4.2.4 the stand-ins answered instead: governance_read (it reads only pending approvals, pack conflicts and
  // history, so it cannot list policies) plus quox_cli, and for packs memory notes (quoxbrain_search), which describe
  // PLANNED packs, not this install's. Same shape as seo-verify-delegate. A write (propose / create / enable ...) or a
  // conflict/history/pending ask is not routed here.
  { id: 'gov-templates-delegate', gripe: 'REL424 security/t3-gov-templates',
    intent: /\bgovernance\b[\s\S]*\b(?:templates?|packs?)\b|\bpolicy\s+(?:packs?|templates?)\b/i,
    unless: /\b(?:conflicts?|enable|apply|install|activate|load)\b/i,
    governed: ['delegate_to_agent'], raw: ['quoxbrain_search', 'quox_cli'], hint: ['governance_get_templates'], displaces: ['quoxbrain_search', 'quox_cli'] },
  { id: 'gov-policies', gripe: 'REL424 security/t3-gov-policies',
    intent: /\b(?:governance\s+)?polic(?:y|ies)\b/i,
    requires: (m) => /\b(?:which|what|list|show|any|how many|enabled|active|enforced|in place|have)\b/i.test(m),
    unless: /\b(?:propose|create|add|new|enable|disable|delete|remove|chang\w*|happened|edit\w*|updat\w*|packs?|templates?|conflicts?|history|pending|approv\w*|check|allowed\s+to|voice|line|llm|routing|engagements?)\b/i,
    governed: ['delegate_to_agent'], raw: ['governance_read', 'quox_cli'], hint: ['governance_list_policies'], displaces: ['governance_read', 'quox_cli'] },
  // REL424-EVIDENCE (4.2.4 proof security/t3-aocl-decisions): AOCL enforcement decisions are aocl_get_decisions (the
  // aocl.layer.* envelopes, org scoped). 4.2.4 answered via query_envelopes / security_audit stand-ins.
  { id: 'aocl-decisions', gripe: 'REL424 security/t3-aocl-decisions',
    intent: /\baocl\b|\bcontrol\s+layers?\b/i,
    requires: (m) => /\b(?:decisions?|decided|enforc\w*|allowed|blocked|denied|refused|fired|layers?\s+(?:fired|ran))\b/i.test(m),
    governed: ['aocl_get_decisions'], raw: ['query_envelopes', 'security_audit', 'quox_cli'] },
  // Proof run 2026-10-15 (calendar lane): calendar asks are answered by the named Calendar-Q reads,
  // never delegated or shelled. Order matters only for readability: every matching route offers its tool.
  { id: 'calendar-agenda', gripe: 'QUOXON-PROOF calendar',
    intent: /\b(?:calendar|agenda|schedule|meetings?|diary)\b/i,
    requires: (m) => /\b(?:what(?:'s|\s+is)?\s+on|agenda|today|tomorrow|this\s+week|next\s+meetings?|upcoming)\b/i.test(m),
    governed: ['calendar_agenda'], raw: ['quox_cli', 'delegate_to_agent'] },
  { id: 'calendar-overlay', gripe: 'QUOXON-PROOF calendar',
    intent: /\bcalendar\b/i,
    requires: (m) => /\b(?:merged|overlay|every\s+layer|all\s+(?:my\s+)?layers|across)\b/i.test(m),
    governed: ['calendar_overlay', 'calendar_layers_list'], raw: ['quox_cli', 'delegate_to_agent'] },
  { id: 'calendar-clashes', gripe: 'QUOXON-PROOF calendar',
    intent: /\bcalendar\b|\bmeetings?\b|\bdouble-?\s?booked\b/i,
    requires: (m) => /\bclash\w*|\bdouble-?\s?book\w*|\boverlapping\b|\bconflicts?\b/i.test(m),
    governed: ['calendar_clashes'], raw: ['quox_cli', 'delegate_to_agent'] },
  { id: 'calendar-schedules', gripe: 'QUOXON-PROOF calendar',
    intent: /\bcalendar\b/i,
    requires: (m) => /\b(?:automated|machine|team\s+schedules?|workflow\s+cron|cron)\b/i.test(m),
    governed: ['calendar_schedules_overview'], raw: ['quox_cli', 'delegate_to_agent'] },
  { id: 'calendar-brief', gripe: 'QUOXON-PROOF calendar',
    intent: /\bcalendar\b/i,
    requires: (m) => /\b(?:morning\s+brief|brief(?:ing)?)\b/i.test(m),
    governed: ['calendar_brief_input'], raw: ['quox_cli', 'delegate_to_agent'] },
  { id: 'calendar-changes', gripe: 'QUOXON-PROOF calendar',
    intent: /\bcalendar\b/i,
    requires: (m) => /\bwhat\s+changed\b|\bchanges?\s+since\b|\bgeneration\b/i.test(m),
    governed: ['calendar_changes'], raw: ['quox_cli', 'delegate_to_agent'] },
  { id: 'calendar-prep', gripe: 'QUOXON-PROOF calendar',
    intent: /\bcalendar\b|\bmeeting\b|\bevent\b/i,
    requires: (m) => /\bprep\b|\bprepare\b|\bmeeting\s+prep\b/i.test(m),
    governed: ['calendar_prep'], raw: ['quox_cli', 'delegate_to_agent'] },
  // QuoxMind cognitive implants ("what are my cognitive implants", "how is QuoxMind doing", "tell me about
  // the Predict implant"): execution_intelligence reads the implant registry and engine health. The CLI twin
  // is quox mind implants|implant|health; quox_cli stays offered so either path is grounded.
  { id: 'quoxmind-implants', gripe: 'QUOXMIND CLI',
    intent: /\bcognitive\s+implants?\b|\bquox\s*mind\b|\bimplants?\b/i,
    governed: ['execution_intelligence'], raw: ['quox_cli'] },
  // Things only the user's terminal can do ("attach to the slot", "join the room", "show my approvals", "switch model"):
  // terminal_suggest_command hands the TUI a slash command to run (it asks y/N), instead of telling the user to type it.
  { id: 'terminal-command', gripe: 'QUOXON live 2026-10-15 "attch to the slot"',
    // + orgs and "switch to <x>", and follow-ups asking it to run the command it just named (live 2026-10-15: "switch to
    // hostnode" and "yes, i would like to run that command" both got "type /org switch HostNode yourself").
    // + "switch back" / "go back to <org>" / "take me back" (owner 2026-10-15: got "type /org switch <org name>"; /org back exists).
    intent: /\b(?:switch|go|take\s+me|change)\s+back\b|\bgo\s+back\s+to\s+\S|\b(?:attach|attch|join|switch|open|show|view|list|go\s+to|take\s+me)\b[\s\S]*\b(?:slots?|rooms?|approvals?|mind|context|which|model|profile|orgs?|organi[sz]ations?)\b|\bswitch\s+(?:to|into)\s+\S|\brun\s+(?:that|this|the|it)\b[\s\S]{0,20}\b(?:command|for\s+me)\b|\brun\s+it\s+for\s+me\b/i,
    governed: ['terminal_suggest_command'], raw: [] },
  // The AGH-chain honesty leaderboard and calibration self-audit (on-demand reads, quox#908).
  { id: 'honesty', gripe: 'QUOXON-PROOF security lane',
    intent: /\b(?:agh(?:-?chain)?|honesty|guard\s*hits?|leaderboard|calibration|self-?audit)\b/i,
    governed: ['agh_chain_leaderboard', 'calibration_self_audit'], raw: ['quox_cli'] },
];
// A message addressed to a slot (live 2026-10-14: "say hello to quox2" delegated to Sesha):
// the route fires on a name from the org's slot list or the word "slot". slot_say is a write by
// name, but here the address IS the ask, so the route's tools are eligible without write words.
const SLOT_TOOLS_ROUTE = ['slot_say', 'slot_list', 'slot_read'];
function addressesSlot(message, slotNames) {
  const m = String(message || '');
  if (/\bslots?\b/i.test(m)) return true;
  const words = new Set(m.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean));
  return (Array.isArray(slotNames) ? slotNames : []).some((n) => words.has(String(n).toLowerCase()));
}
function governedRoutesFor(message) {
  const m = String(message || '');
  return GOVERNED_ROUTES.filter((r) => r.intent.test(m) && !(r.unless && r.unless.test(m)) && !(r.requires && !r.requires(m)));
}
const matchesAny = (name, list) => (list || []).some((x) => (x instanceof RegExp ? x.test(name) : x === name));
/** -> { preferred: string[] (governed names in the pool), withheld: Set<string> } for one turn. */
const TERMINAL_SUGGEST_TOOL = 'terminal_suggest_command';
function governedPolicy(message, list, slotNames, agent = '') {
  const names = new Set(list.map((t) => t.name));
  const preferred = [];
  const withheld = new Set();
  const allowed = new Set();
  if (addressesSlot(message, slotNames) && (names.has('slot_say') || names.has('slot_list'))) {
    // A create/attach ask is lane S's route (slot_checkout / slot_create): only the list read
    // joins it here. Either way a slot is an address, never a delegation target.
    const createAsk = SLOT_CREATE_RE.test(String(message || ''));
    for (const n of (createAsk ? ['slot_list'] : SLOT_TOOLS_ROUTE)) if (names.has(n)) { preferred.push(n); allowed.add(n); }
    withheld.add('delegate_to_agent');
  }
  for (const r of governedRoutesFor(message)) {
    const have = r.governed.filter((n) => names.has(n));
    for (const n of have) if (!preferred.includes(n)) preferred.push(n);
    if (r.allowWrite) for (const n of have) allowed.add(n); // the ask itself is the request for this write
    for (const n of names) {
      if (matchesAny(n, r.wrongStore)) withheld.add(n);
      else if (have.length && matchesAny(n, r.raw)) withheld.add(n);
    }
  }
  // A route that `displaces` a sibling another route preferred: the displaced name leaves the offer
  // (only when the displacing route actually has a tool in the pool, so a pool without it keeps the sibling).
  for (const r of governedRoutesFor(message)) {
    if (!r.displaces || !r.governed.some((n) => names.has(n))) continue;
    for (const d of r.displaces) { const i = preferred.indexOf(d); if (i >= 0) preferred.splice(i, 1); if (names.has(d)) withheld.add(d); }
  }
  // quox#1090 intent pins: the holder gets the pinned tool first (sibling withheld); a caller that can
  // delegate to a holder loses the stand-ins, so the delegate offer (which names the tool) is the path.
  // quox#1090: a delegated task that names a pool tool ("run your settings_get tool") puts it first.
  // On purpose this also beats a pin's withholding: "use your quox_cli" un-withholds the stand-in (the user's explicit choice wins).
  const pinned = namedToolsIn(message, [...names]);
  for (const p of intentPinsFor(message)) {
    if (names.has(p.tool)) {
      if (!pinned.includes(p.tool)) pinned.push(p.tool);
      if (p.allowWrite) allowed.add(p.tool); // the ask itself is the request for this tool
      for (const n of p.siblings) if (names.has(n)) withheld.add(n);
    } else if (names.has('delegate_to_agent') && defaultHoldersOf(p.tool, agent).length) {
      for (const n of p.standIns) if (names.has(n)) withheld.add(n);
      if (!pinned.includes('delegate_to_agent')) pinned.push('delegate_to_agent');
    }
  }
  for (let i = pinned.length - 1; i >= 0; i--) { const at = preferred.indexOf(pinned[i]); if (at >= 0) preferred.splice(at, 1); preferred.unshift(pinned[i]); }
  for (const n of preferred) withheld.delete(n);
  // A held-change ask ("hold it for my approval ... once I approve") asks for a card; approving it is the user's own act.
  if (require('./heldChangeAsk.js').isHeldChangeAsk(message)) {
    for (const n of HELD_ASK_NEVER) { withheld.add(n); allowed.delete(n); const i = preferred.indexOf(n); if (i >= 0) preferred.splice(i, 1); }
  }
  return { preferred, withheld, allowed };
}

// QUOXON-ENGINE lane N, class 3 (unasked action on a read-only ask, quox#842): the turn is
// classified read or act BEFORE tools are offered. A read turn is offered no state-changing
// tool (the WRITE_INTENT rule) and no hat switch proposal (it files an approval card in the
// owner's inbox). hat_catalogue (inspect) and hat_load_bundle stay: a bundle load reaches only
// a READ bundle the active hat already defines (templates.js: "loading one is never a
// privilege step"), which is how the Default hat reaches reads on a read-only ask.
const READ_TURN_WITHHELD = new Set(['hat_propose_switch']);

// The user's own words asking for a change. Matched on the CURRENT message only.
// #878: "store" after a determiner or a storage noun is the noun ("my file store"), not the verb.
const WRITE_INTENT_RE = /\b((?:un-?mute|mute|un-?snooze|snooze|silence)\s+(?:the|that|this|it|those|these|all|my|alerts?|\w+\s+alert)|attach|checkout|check out|claim|switch|flip|swap|enable|disable|remember|memori[sz]e|save|(?<!\b(?:file|key|data|vault|object|blob|secret|credential|document|app|my|the|a|your|our|their|its)\s)store|(?<!\btrack\s)record(?!\s+(?:is|was|are|were|shows?|has|have|of|for|intact|complete|looks?)\b)|note (?:this|that|down)|log (?:this|that|it)|create|make|add|send|post|tweet|publish|notify|alert me|email (?:to|him|her|them)|update|change|edit|set|delete|remove|forget|erase|wipe|purge|cancel|approve|deny|reject|execute|exec|restart|start|stop|deploy|install|tick|mark|schedule|(?<!address\s)book|(?<!do[- ]not[- ])call|dial|write|apply|move|assign|import|upload|capture|reboot|rename|delegate|propose|run(?!\s+(?:a|an|the|my|our|this|that)?\s*(?:[\w-]+\s+){0,2}(?:check|audit|review)\b))\b/i;

// A URL or bare domain in the user's own message ("cli.quox.ai", "https://x.io/a"):
// the user is pointing at a page, so the read-only page reader must be offered.
const URL_RE = /\bhttps?:\/\/[^\s<>"']+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>"']*)?(?=$|[\s,;:!?)'"])/i;
const URL_READ_TOOL = 'web_read';
function hasUrlInMessage(message) {
  const m = String(message || '').match(URL_RE);
  if (!m) return false;
  // "e.g." / "i.e." / version-like "v2.1" are not domains: need an alphabetic TLD of 2+ letters, checked by the regex.
  return !/^(?:e\.g|i\.e)$/i.test(m[0]);
}

const STOP = new Set(('a an the and or but if then so to of in on at by for with from as is are was were be been being it its this that these those '
  + 'i me my we our you your he she they them their what which who whom how when where why can could would should will shall do does did done '
  + 'please use tool tools any some all no not just also there here about into over up down out only one get give show tell me ok reply yes').split(/\s+/));

// Small, explicit query expansions (user words -> tool vocabulary).
const SYNONYMS = {
  remember: ['memory', 'save'], memorise: ['memory', 'save'], memorize: ['memory', 'save'], recall: ['memory', 'search'],
  notify: ['notification', 'send'], alert: ['alert', 'notification'],
  certificate: ['tls', 'cert'], cert: ['tls'], ssl: ['tls'],
  approval: ['approval', 'pending', 'inbox'], pending: ['pending', 'inbox'],
  container: ['docker'], vm: ['proxmox'], hypervisor: ['proxmox'],
  roadmap: ['quoxplan'], stream: ['quoxplan'], phase: ['quoxplan'],
  mail: ['email'], inbox: ['inbox', 'email'],
  host: ['fleet'], server: ['fleet'], hosts: ['fleet'], fleet: ['fleet', 'status'],
  metric: ['metrics'], cpu: ['metrics'], prometheus: ['metrics'],
  situation: ['lucid', 'situation'], sitrep: ['lucid', 'situation'], awareness: ['lucid'],
  tweet: ['x', 'post'], twitter: ['x'],
  agent: ['delegate', 'agent'], specialist: ['delegate'],
  fetch: ['web', 'read'], website: ['web', 'read'], webpage: ['web', 'read'], url: ['web', 'read'], link: ['web', 'read'],
  browse: ['web', 'read'], browsing: ['web', 'read'], site: ['web', 'read'], domain: ['web', 'read'],
};

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('es') && /(sses|ches|shes|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  return w;
}

function tokens(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && w.length > 1 && !STOP.has(w));
}

/** Weighted query terms: the current message counts 3, recent user turns 1. */
function queryTerms(message, history) {
  const terms = new Map();
  const add = (w, weight) => {
    const s = stem(w);
    terms.set(s, Math.max(terms.get(s) || 0, weight));
    for (const syn of SYNONYMS[w] || SYNONYMS[s] || []) terms.set(syn, Math.max(terms.get(syn) || 0, weight));
  };
  // A hyphenated id ("floasis-website", a fleet host) is a name: its parts count as plain words but
  // never expand through SYNONYMS ("website" -> web, read put web_read above every network read).
  // (SITE-CLI 2026-10-17)
  const addText = (text, weight) => {
    const t = String(text || '');
    for (const id of t.match(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/gi) || []) {
      for (const w of tokens(id)) { const s = stem(w); terms.set(s, Math.max(terms.get(s) || 0, weight)); }
    }
    for (const w of tokens(t.replace(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/gi, ' '))) add(w, weight);
  };
  const recent = (Array.isArray(history) ? history : []).filter((m) => m && m.role === 'user').slice(-3);
  for (const m of recent) addText(typeof m.content === 'string' ? m.content : '', 1);
  addText(message, 3);
  return terms;
}

function nameTokens(name) {
  return String(name || '').toLowerCase().split(/[_\-.]+/).filter(Boolean);
}

function isStateChangingTool(tool) {
  const name = String(tool && tool.name || '').toLowerCase();
  if (!name || name === MORE_TOOLS_NAME) return false;
  if (CAPABILITY_NAMES.has(name)) return false;
  if (READ_NAMES.has(name)) return false;
  if (WRITE_NAMES.has(name)) return true;
  return nameTokens(name).some((t) => WRITE_TOKENS.has(t));
}

/**
 * Action-level writes (quox#908 follow-up): a multi-action tool can hide a write behind a
 * read-sounding name (grafana_dashboards.annotate). Tool -> the actions that change state.
 * Registry invariant: every tool with an `action` enum whose values include a write verb
 * must be listed here (see quoxhatRegistryInvariant.test.js).
 */
const TOOL_WRITE_ACTIONS = {
  grafana_dashboards: ['annotate'],
  alerts_manage: ['silence'],
  keeper_schedule_manage: ['create', 'update', 'delete'],
  brain_garden_apply: ['archive'],
  continuity: ['commit'],
  docker_fleet_container_action: ['start', 'stop', 'restart'],
  proxmox_vm_action: ['start', 'stop', 'reboot', 'shutdown'],
};
const WRITE_ACTION_VERBS = new Set(['create', 'update', 'delete', 'annotate', 'silence', 'set', 'run', 'commit', 'archive', 'start', 'stop', 'restart', 'reboot', 'shutdown', 'apply', 'write', 'remove', 'cancel', 'schedule']);

/** True when this call of a multi-action tool takes a state-changing action. */
function isWriteAction(toolName, input) {
  const writes = TOOL_WRITE_ACTIONS[String(toolName || '')];
  if (!writes) return false;
  const a = input && typeof input === 'object' ? String(input.action || '').toLowerCase() : '';
  return writes.includes(a);
}

// READ-CLASS (#878 follow-up, BRAIN2 proof triage 2026-10-15): spans where a write word is a
// noun, a participle, a question or a negation are blanked before WRITE_INTENT_RE runs. Only the
// span is removed, so any other write word in the message still makes the turn an act. Each rule
// is narrow on purpose: a read misread as act costs a switch card, an act misread as read is a
// governance hole. Fixtures: test/turnIntentReadPhrasing.test.js.
const READ_PHRASE_RES = [
  /\{\{[^}]*\}\}/g, // proof-case template slots ({{pick.run}})
  // "What is X set to?", "is X set?", "currently set" ask for a value (WORKER2 #1090 review: 'set' made these ACT,
  // so write tools became eligible on a pure read). "set X to 5" has no question and stays a write.
  /\b(?:what|which|how)\b[^.!?\n]{0,100}?\bset\s+(?:to|as|for)\b(?=[^.!\n]*\?)/gi,
  /\b(?:is|are)\s+[^.!?\n]{1,80}?\bset\b(?=\s*(?:\?|$))/gi,
  /\bcurrently\s+set\b/gi,
  // Recall, not storing: "what you (already) remember", "do you remember", "you remember" ask Quox to answer from memory
  // (memory/org-memory-cited). The imperative "remember that X" / "remember this" stays a write.
  /\b(?:what|do|did|does|can|could)\s+(?:you\s+)?(?:already\s+|still\s+)?remember\b(?!\s+to\b)/gi,
  /\byou\s+(?:already\s+|still\s+)?remember\b(?!\s+to\b)/gi, // 'remember to <verb>' is a reminder request (WORKER2)
  /\bhttps?:\/\/[^\s<>"']+/gi, // a URL's path is not the user's verb (".../forms/post")
  /\btrack\s+records?\b/gi,
  // pasted code: a function name is not the user's verb ("function add(a, b)", "def delete_user(id):")
  /\b(?:function|def|func|fn)\s+[A-Za-z_$][\w$]*\s*\(/g,
  // asking a text model for text ("Ask Gemini to write a slogan"): the reply is the output, nothing changes.
  /\b(?:ask|get|have|use)\s+(?:gemini|perplexity|chatgpt|gpt(?:-?\d[\w.]*)?)\s+(?:to\s+)?(?:write|draft|compose)\b/gi,
  // "Delegate this to <agent>: <ask>" hands the ask over; the ask after the colon decides.
  /^\s*(?:please\s+)?delegate\s+(?:this|it)\s+to\s+[^:]{1,120}:/i,
  // "run" with a read object: a query, validation, preflight/lookup check.
  /\brun\s+(?:a|an|the)\s+(?:[\w'-]+\s+){0,2}(?:query|validation|lookup|(?:preflight|health|blast-radius|validation|consistency)\s+check)\b/gi,
  // "run" as a noun, or as a description of what runs (not a request).
  /\b(?:next|last|latest|previous|each|every|workflow|volt|loop|this|that|its|their)\s+runs?\b/gi,
  /\b(?:has|have|had)\s+run\b/gi,
  /\b(?:servers?|hosts?|machines?|boxes|nodes?)\s+run\b/gi,
  // "does/did <subject> <verb>": a question about what something does.
  /\b(?:does|did)\s+(?!you\b|u\b)(?:(?!(?:and|or|then|so)\b)[\w'-]+\s+){1,4}?(?:run|runs|set|stop|start|change|call|send|delete)\b/gi,
  // "set up" / "set to" as a state, not a request.
  /\b(?:is|are|was|were|been|being|currently|already)\s+set(?:\s+up|\s+to)?\b/gi,
  // quox#1090 (WORKER2), beyond the rows above: "is <X> set to Y?" and a bare "<X> set to?".
  /(?:^|[.?!]\s*)(?:is|are)\s+[^.?!]{1,100}?\bset\b[^.?!]{0,60}\?/gi,
  /\bset\s+to\s*\?/gi,
  /\bhave\s+set\s+up\b/gi,
  /\b(?:do|does|did)\s+(?:i|we|you|they)\s+have\s+(?!to\b)[^.?!:]{0,60}?\bset\s+up\b/gi,
  // nouns: a restart is needed, change history, this claim, swap memory, on record, this install, its schedule, a phone call
  /\b(?:need|needs|require|requires|trigger|triggers|cause|causes)\s+(?:a|an|any)\s+(?:restart|reboot)\b/gi,
  /\bchange\s+(?:history|log|logs|records?|feed|events?)\b/gi,
  /\b(?:this|that|the|each|which|a)\s+claims?\b(?!\s+(?:this|that|it|the|my|a)\b)/gi,
  /\bswap\b(?=\s*(?:$|[.,;?!]|usage|space|used|memory|total|file|partition))/gi,
  /\b(?:on|of)\s+(?:the\s+)?record\b/gi,
  /\b(?:on|in|for|of|across|from)\s+(?:this|that|the|my|our|your|each|every)\s+install(?:ation)?\b/gi,
  /\b(?:its|their|the|a|this|that|my|your|our|on)\s+schedules?\b/gi,
  /\b(?:could|can|should|might)\s+(?:i|we)\s+start\s+from\b/gi,
];
// Negation ("change nothing", "don't save a note yet") is blanked only when nothing conditional
// or exceptional follows ("don't restart it unless it is down" stays an act).
const NEGATED_WRITE_RES = [
  /\b(?:change|delete|touch|modify|edit|send|save|run|write|remove)\s+nothing\b/gi,
  /\b(?:do\s+not|don'?t|never|without)\s+(?:\w+ing\s+)?(?:save|change|delete|send|edit|write|create|post|run|restart|stop|start|remove)\b/gi,
];
// READ-CLASS 2: a question about ABILITY is a read ("Can I send X?", "Can you place a call yet?"). A request
// phrased as a question stays an act: "can you <verb>" needs an ability marker (yet/actually/ever/even/able),
// and "now/please/go ahead" or "can I get/have you ..." keeps the act. Only the question sentence is blanked.
const CAPABILITY_Q_RES = [
  /\b(?:can|could|may)\s+(?:i|we)\b(?!\s+(?:get|have|ask|make)\s+(?:you|u)\b)[^.?!]*\?/gi,
  /\b(?:can|could)\s+(?:you|u)\b(?=[^.?!]*\b(?:yet|actually|ever|even)\b)[^.?!]*\?/gi,
  /\b(?:are|r)\s+(?:you|u)\s+able\s+to\b[^.?!]*\?/gi,
];
const CAPABILITY_GUARD_RE = /\b(?:now|please|pls|right\s+away|asap|go\s+ahead)\b/i;
const NEGATION_GUARD_RE = /\b(?:unless|until|except|if|but|only)\b/i;
const ENSURE_GUARD_RE = /\b(?:ensure|make\s+sure|needs?\s+to\s+be|should\s+be|so\s+that)\b/i;
function writeIntentText(message) {
  let m = String(message || '');
  if (ENSURE_GUARD_RE.test(m)) return m;
  for (const re of READ_PHRASE_RES) m = m.replace(re, ' ');
  if (!CAPABILITY_GUARD_RE.test(m)) for (const re of CAPABILITY_Q_RES) m = m.replace(re, ' ');
  if (!NEGATION_GUARD_RE.test(m)) for (const re of NEGATED_WRITE_RES) m = m.replace(re, ' ');
  return m;
}

function hasWriteIntent(message) {
  return WRITE_INTENT_RE.test(writeIntentText(message)) || SLOT_SAY_RE.test(String(message || ''));
}

/** class 3: 'act' when the user's own message asks for a change, else 'read'. */
function classifyTurnIntent(message) {
  return hasWriteIntent(message) ? 'act' : 'read';
}

/**
 * The one eligibility rule every path uses (API offer, more_tools, catalogue):
 * role needs always; governed-store withholding (class 1); read turns get no
 * state-changing and no capability-widening tool (class 3).
 */
// 2026-10-16 (approval card 01M53AC9ZNMR0M5YK245ABY9B7): a host-less security read ("run a permission audit across
// the fleet") was offered ssh_exec and Sentinel swept 17 hosts with a shell command. Security reads have their own
// security_* tools (per host, or ask which host); a shell is offered only when the user asks for one.
const SECURITY_READ_RE = /\b(sessions?|logged in|log-?ins?|permissions?|world-?writable|setuid|user accounts?|mfa)\b/i;
// REL-423b: 'ssh' inside "SSH key and authorized_keys permissions" is a permission-audit topic, not a shell ask (the delegated
// Sentinel task said exactly that, lost no_shell, and swept 17 hosts with ssh_exec -> held for approval). "ssh into", "over ssh",
// "run ssh", "via ssh" and a bare "ssh <host>" still count.
const SHELL_ASK_RE = /\b(?:ssh(?!\s+(?:keys?|config(?:uration)?|directory|dir|folders?|files?|permissions?|authorized|agent|daemon|server|host\s+keys?)\b)|shell|bash|command|cmd)\b|`[^`]+`/i;

/** A security read with no shell ask: ssh_exec is never offered (above) nor run (turn credential no_shell). */
// SITE-CLI 2026-10-17 fleet/docker-df-on-host (ev_mvckdqby_67b172): a read-only Docker images/disk brief reached
// nova, which ran ssh_exec "docker system df" and held the turn for approval. Docker reads have their own docker_*
// tools; a shell is offered only when the user asks for one, and a Docker change is not a read.
const DOCKER_READ_RE = /\bdocker\b[\s\S]*\b(?:images?|disk|df|containers?|volumes?|networks?|stats|logs?|usage|space|size)\b|\b(?:images?|containers?|volumes?)\b[\s\S]*\bdocker\b/i;
const DOCKER_CHANGE_RE = /\b(?<!(?:not|never|no|don't|nor|or)\s(?:\w+,?\s){0,3})(?:restart|start|stop|kill|prune|rm|rmi|remove|delete|pull|push|build|deploy|compose|up|down|exec|run|recreate|update|upgrade)\b/i;
function dockerReadNoShell(m) {
  return DOCKER_READ_RE.test(m) && !SHELL_ASK_RE.test(m) && !DOCKER_CHANGE_RE.test(m);
}
// Re-run on 9b6b80877 (ev_mvcsmm3r_592a78): cipher answered a read-only interfaces brief with ssh_exec "ip ..." and held
// the turn for approval, though network_interfaces/routes/arp exist. A network read with no shell ask offers no shell.
const NETWORK_READ_RE = /\b(?:network\s+)?interfaces?\b|\brout(?:es?|ing)(?:\s+table)?\b|\barp\b|\bneighbou?r\s+table\b|\bip\s+addresse?s?\b|\blistening\s+ports?\b|\bopen\s+connections?\b/i;
const NETWORK_CHANGE_RE = /\b(?<!(?:not|never|no|don't|nor|or)\s(?:\w+,?\s){0,3})(?:set|change|bring|enable|disable|add|delete|remove|flush|restart|configure|assign|reboot|apply|create)\b/i;
function networkReadNoShell(m) {
  return NETWORK_READ_RE.test(m) && !SHELL_ASK_RE.test(m) && !NETWORK_CHANGE_RE.test(m);
}

// QUOXON 2026-10-19: a version / install recon ("claude installations ... exact version number") has no dedicated tool
// (no docker_* or security_* tool runs a binary), so a no-shell turn that asks it is still OFFERED ssh_exec. The turn
// credential keeps no_shell, so only a provably read-only allowlisted probe (`claude --version`) can run.
const VERSION_PROBE_ASK_RE = /\b(?:versions?|installations?|installed|install\s+paths?)\b/i;

function securityReadNoShell(message) {
  const m = String(message || '');
  return (SECURITY_READ_RE.test(m) && !SHELL_ASK_RE.test(m)) || dockerReadNoShell(m) || networkReadNoShell(m);
}

function turnEligibility({ list, message, agent, slotNames, terminal = false, plan = false }) {
  // PLAN MODE (owner 2026-10-16): the turn is a read whatever the words; nothing below reopens a write.
  const writeIntent = plan ? false : hasWriteIntent(message);
  const roleNeeds = new Set(AGENT_DEFAULTS[String(agent || '').toLowerCase()] || []);
  const gov = governedPolicy(message, list, slotNames, agent);
  // Owner 2026-10-15 "STOP TELLING ME TO RUN COMMANDS": a turn from the TUI (it carries terminal context) is ALWAYS
  // offered terminal_suggest_command, whatever the words. It has no server-side effect: the terminal asks y/N.
  if (terminal && list.some((t) => t.name === TERMINAL_SUGGEST_TOOL)) {
    const i = gov.preferred.indexOf(TERMINAL_SUGGEST_TOOL); if (i >= 0) gov.preferred.splice(i, 1);
    gov.preferred.unshift(TERMINAL_SUGGEST_TOOL); gov.allowed.add(TERMINAL_SUGGEST_TOOL); gov.withheld.delete(TERMINAL_SUGGEST_TOOL);
  }
  const noStandIn = standInWithheld(message); // lane S: no stand-in task tools for a slot-create ask
  const hostAsk = HOST_STATUS_RE.test(String(message || '')) && !REACH_ASK_RE.test(String(message || ''));
  const planBlocked = plan ? require('./planMode.js').isPlanBlocked : null;
  const noShellRead = securityReadNoShell(message);
  const eligible = (t) => {
    if (gov.withheld.has(t.name)) return false;
    if (noShellRead && t.name === 'ssh_exec' && !VERSION_PROBE_ASK_RE.test(String(message || ''))) return false;
    // (terminal_suggest_command stays offered: each suggestion is vetted when called, read-only views only)
    // PLAN MODE is an allowlist: only a positively classified read (planMode.isPlanRead) is eligible.
    if (planBlocked && t.name !== TERMINAL_SUGGEST_TOOL && (isStateChangingTool(t) || planBlocked(t.name, {}, t))) return false;
    if (hostAsk && t.name === 'reach_agent') return false;
    if (noStandIn && STAND_IN_TOOLS.has(t.name)) return false;
    if (roleNeeds.has(t.name) || gov.allowed.has(t.name)) return true;
    if (writeIntent) return true;
    return !isStateChangingTool(t) && !READ_TURN_WITHHELD.has(t.name);
  };
  return { writeIntent, intent: writeIntent ? 'act' : 'read', mode: plan ? 'plan' : 'ask', roleNeeds, eligible, preferred: gov.preferred, governedWithheld: [...gov.withheld] };
}

/**
 * First sentence of a description: up to the first [.!?] followed by whitespace and an
 * uppercase letter (or the end), so "v2.1" and "e.g. for" never cut. Capped.
 */
function firstSentence(text, max = DESC_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = s.match(/^(.*?[.!?])(?=\s+[A-Z(`"']|$)/);
  let out = m ? m[1] : s;
  if (out.length > max) out = `${out.slice(0, max - 1).trimEnd()}…`;
  return out;
}

function compactSchema(schema) {
  if (Array.isArray(schema)) return schema.map(compactSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'examples' || k === 'example') continue;
    if (k === 'description') { if (typeof v === 'string' && v) out.description = firstSentence(v, PARAM_DESC_MAX); continue; }
    if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = compactSchema(pv);
      continue;
    }
    if (['items', 'anyOf', 'oneOf', 'allOf', 'additionalProperties', 'not'].includes(k)) { out[k] = compactSchema(v); continue; }
    out[k] = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
  }
  return out;
}

/**
 * The model-facing definition: name and parameter names/types/required/enums exact,
 * descriptions cut to their first sentence, examples dropped. Never mutates the source.
 */
function compactTool(tool) {
  const out = { name: tool.name };
  const d = [firstSentence(tool.description), tool.turnHint || ''].filter(Boolean).join(' ');
  if (d) out.description = d;
  out.input_schema = compactSchema(tool.input_schema || tool.inputSchema || { type: 'object', properties: {} });
  return out;
}

const MORE_TOOLS_DEF = {
  name: MORE_TOOLS_NAME,
  description: 'Find more tools when none offered fits the task: give what you need to do; the tools returned can be called on your next step.',
  input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What you need to do, in a few words.' } }, required: ['query'] },
};

// quox#1064: the unheld catalogue (~240 defs) is ranked every turn; tokenise each definition once
const toolTokenCache = new WeakMap();
function toolTokens(tool) {
  let c = toolTokenCache.get(tool);
  if (!c || c.name !== tool.name || c.description !== tool.description) {
    c = { name: tool.name, description: tool.description, nameSet: new Set(nameTokens(tool.name).map(stem)), descSet: new Set(tokens(firstSentence(tool.description)).map(stem)) };
    toolTokenCache.set(tool, c);
  }
  return c;
}
function scoreTool(tool, terms) {
  const { nameSet, descSet } = toolTokens(tool);
  let score = 0;
  // a tool NAME word "routes" stems to "route", the ask's "routing" to "rout": the same word
  const nameHit = (t) => nameSet.has(t) || nameSet.has(`${t}e`) || (t.length > 4 && t.endsWith('e') && nameSet.has(t.slice(0, -1)));
  for (const [t, w] of terms) {
    if (nameHit(t)) score += 2 * w;
    else if (descSet.has(t)) score += w;
  }
  return score;
}

/** Rank pool tools against terms; ties keep the pool order (deterministic). */
function rank(pool, terms) {
  return pool
    .map((tool, idx) => ({ tool, idx, score: scoreTool(tool, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
}

/**
 * -> { offered: tool[], poolSize, writeIntent, withheld: string[] }
 * offered keeps the original definitions (compaction happens at the model boundary).
 */
// quox#976: the holders of a tool and how to name them come from agentTools (the same helpers the
// executeTool deny path uses). Required lazily: agentTools requires this module.
const defaultHoldersOf = (tool, agent) => { try { return require('./agentTools.js').holdersOfTool(tool, agent) || []; } catch { return []; } };
const defaultDescribeHolders = (ids) => { try { return require('./agentTools.js').describeHolders(ids); } catch { return `Delegate to: ${ids.join(', ')}.`; } };
// quox#1064: every tool some agent holds, as definitions, so a specialist-held read can rank against
// the ask even though it is not in the caller's pool. Built once; the registry is static at runtime.
// Only a NON-EMPTY catalogue is cached: agentTools requires this module, so an early call can see
// half-initialised exports, and caching that failure would disable the hint until restart. A failure
// is logged once. (WORKER2 review)
function makeUnheldCatalogue(load, log = console) {
  let cache = null;
  let warned = false;
  return () => {
    if (cache) return cache;
    try {
      const at = load();
      const names = new Set();
      for (const l of Object.values((at && at.AGENT_TOOLS) || {})) if (Array.isArray(l)) for (const n of l) names.add(n);
      const defs = [...names].map((n) => { try { return at.getToolDef(n); } catch { return null; } }).filter((t) => t && t.name);
      if (defs.length) cache = defs;
      return defs;
    } catch (e) {
      if (!warned) { warned = true; try { log.warn?.(`[ToolOffer] quox#1064 unheld catalogue unavailable: ${e && e.message}`); } catch { /* telemetry only */ } }
      return [];
    }
  };
}
const defaultUnheldTools = makeUnheldCatalogue(() => require('./agentTools.js'));
// an unheld read is named only when it matches at least this well (a name hit plus a description hit
// on the current message) and at least as well as the best tool the caller holds
// SITE-CLI 2026-10-17: an ask that names page STRUCTURE on a URL needs the browser specialist, not the page reader
// (web_read returns the page as text: links, menus, forms and tables lose their shape). Word -> the tool that reads it.
// A plain "what does this page say" ask names none of these and stays with web_read.
const PAGE_STRUCTURE_TOOLS = [
  [/\b(links?|hyperlinks?|nav(igation)?|menus?)\b/i, 'browser_extract_links'],
  [/\btables?\b/i, 'browser_extract_table'],
  [/\bforms?\b|\bform fields?\b|\binputs?\b/i, 'browser_analyze_forms'],
  [/\bbuttons?\b/i, 'browser_find_element'],
  [/\bheadings?\b|\bheaders?\b/i, 'browser_extract'],
];
const UNHELD_HINT_FLOOR = 9;
const UNHELD_HINT_MAX = 2;
// a widely-held tool is not a specialist's (fleet_status sits with dozens); a held same-family sibling
// this close is a fair answer already
const UNHELD_HINT_MAX_HOLDERS = 4;
const UNHELD_SIBLING_MARGIN = 2;
const family = (name) => nameTokens(name)[0] || '';

function selectTurnTools({ pool, message = '', history = [], agent = '', cap = DEFAULT_CAP, slotNames = [], terminal = false, plan = false, holdersOf: holdersOfAll = defaultHoldersOf, describeHolders = defaultDescribeHolders, unheldTools = defaultUnheldTools, agentScope = null, withUnheld = false } = {}) {
  // CUSTOM-HATS: under a hat that scopes its agents, a delegation hint names only in-scope holders
  // (an out-of-scope holder is refused by the delegation gate and is context this turn does not carry).
  const scopeSet = Array.isArray(agentScope) ? new Set(agentScope.map((a) => String(a).toLowerCase())) : null;
  const holdersOf = scopeSet ? (tool, self) => (holdersOfAll(tool, self) || []).filter((id) => scopeSet.has(String(id).toLowerCase())) : holdersOfAll;
  const list = (Array.isArray(pool) ? pool : []).filter((t) => t && t.name && t.name !== MORE_TOOLS_NAME);
  const max = Math.max(1, Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_CAP);
  const { writeIntent, roleNeeds, eligible, preferred, governedWithheld } = turnEligibility({ list, message, agent, slotNames, terminal, plan });
  const byName = new Map(list.map((t) => [t.name, t]));
  const picked = [];
  const seen = new Set();
  const take = (t) => { if (t && !seen.has(t.name) && picked.length < max && eligible(t)) { seen.add(t.name); picked.push(t); } };

  const terms = queryTerms(message, history);
  const ranked = rank(list, terms);
  // quox#1290: a removal tool is offered by RANK only when the ask names what it removes. "Delete all of my saved
  // memories" ranked delete_workflow on the word "delete" alone, and the model used it. The object words are the
  // tool name's other words (delete_workflow -> workflow); routed and pinned offers are unaffected.
  const rankOffer = (t) => !REMOVAL_NAME_RE.test(t.name)
    || nameTokens(t.name).filter((w) => !REMOVAL_NAME_RE.test(w)).some((w) => terms.has(stem(w)));
  // 0-. class 1: the governed store the user's words name (bounded to half the cap)
  { let gv = 0; for (const n of preferred) { if (gv >= Math.ceil(max / 2)) break; const t = byName.get(n); if (t && !seen.has(n)) { take(t); if (seen.has(n)) gv++; } } }
  // 0. a URL in the user's message: the read-only page reader (egress-guarded) comes first
  const url = hasUrlInMessage(message);
  if (url) take(byName.get(URL_READ_TOOL));
  // 0b. knowledge / opinion (or a URL to have an opinion on): the brain search
  if (url || KNOWLEDGE_RE.test(String(message || ''))) take(byName.get(KNOWLEDGE_TOOL));
  // 0c. a capability the agent may lack: the hat tools (inspect, then propose)
  if (CAPABILITY_RE.test(String(message || ''))) { take(byName.get('hat_catalogue')); take(byName.get('hat_propose_switch')); }
  // 0d. the skill catalogue, when the user asks about skills
  if (SKILL_RE.test(String(message || ''))) for (const n of SKILL_TOOLS) take(byName.get(n));
  // 0e. a CLI-readable surface the user named: its read tool (bounded to half the cap)
  { let routed = 0; for (const n of routedToolNames(message)) { if (routed >= Math.ceil(max / 2)) break; const t = byName.get(n); if (t && !seen.has(n)) { take(t); if (seen.has(n)) routed++; } } }
  // 0e+. quox#976: a routed read this agent does not hold but a specialist does (docker_fleet_* sit with
  // dockeragent). It was never offered, so the model reached for a weaker stand-in. Offer the delegation,
  // and say on it who holds the tool. A tool nobody holds gets no hint (never a phantom delegation).
  // QUOXON handoff offer (2026-10-17): the same unheld-tool reasoning runs for EVERY agent. An attached specialist
  // without delegate_to_agent (triage-q asked about VM CPU) gets no hint text, but the gap is returned as
  // unheldHints so the turn can offer the human a one-turn handoff to CommanderQ (lib/handoffSuggest.js).
  // delegationHints (and the delegate_to_agent hint text) are unchanged: only an agent that can delegate gets them.
  const canDelegate = byName.has('delegate_to_agent');
  const unheldGaps = (maxHolders, routes = routedToolNames) => {
    const hints = [];
    for (const n of routes(message)) {
      if (byName.has(n)) continue;
      const ids = holdersOf(n, agent);
      if (ids.length) hints.push({ tool: n, holders: ids });
    }
    // a governed route's `hint`: a specialist-held read named on the delegation (never offered to this agent)
    for (const r of governedRoutesFor(message)) {
      for (const n of r.hint || []) {
        if (byName.has(n) || hints.some((h) => h.tool === n)) continue;
        const ids = holdersOf(n, agent);
        if (ids.length) hints.push({ tool: n, holders: ids });
      }
    }
    // quox#1064: the hint above only saw INTENT_ROUTES tools, and a specialist-held tool is not in this
    // pool, so a plain ask never ranked it and the model improvised with a held sibling. Rank the tools
    // other agents hold against the same terms; a read matching at least as well as anything held here
    // names its holder too. Writes are never hinted on a read ask.
    // A routed hint above is the stronger signal; do not dilute it with ranked guesses.
    const routedAsk = hints.length > 0;
    const heldTop = (ranked.find((r) => eligible(r.tool)) || { score: 0 }).score;
    const hinted = new Set(hints.map((h) => h.tool));
    let catalogue = [];
    try { catalogue = (unheldTools() || []).filter((t) => t && t.name && !byName.has(t.name) && !hinted.has(t.name)); } catch { catalogue = []; }
    let added = 0;
    for (const r of (routedAsk ? [] : rank(catalogue, terms))) {
      if (added >= UNHELD_HINT_MAX || r.score < UNHELD_HINT_FLOOR || r.score < heldTop) break;
      if (!writeIntent && (isStateChangingTool(r.tool) || TOOL_WRITE_ACTIONS[r.tool.name])) continue;
      const fam = family(r.tool.name);
      if (ranked.some((h) => eligible(h.tool) && family(h.tool.name) === fam && h.score >= r.score - UNHELD_SIBLING_MARGIN)) continue;
      const ids = holdersOf(r.tool.name, agent);
      if (!ids.length || ids.length > maxHolders) continue;
      hints.push({ tool: r.tool.name, holders: ids });
      added++;
    }
    // a URL plus page-structure words: name the browser specialist and the tool (pinned: the task names it). Added
    // AFTER the ranked hints, so a better-matching specialist read (browser_extract_template) is never crowded out.
    if (url) {
      for (const [re, tool] of PAGE_STRUCTURE_TOOLS) {
        if (!re.test(String(message || '')) || byName.has(tool) || hints.some((h) => h.tool === tool)) continue;
        const ids = holdersOf(tool, agent);
        if (ids.length) hints.push({ tool, holders: ids, pin: true });
      }
    }
    return hints;
  };
  const delegationHints = canDelegate ? unheldGaps(UNHELD_HINT_MAX_HOLDERS) : [];
  if (delegationHints.length) take(byName.get('delegate_to_agent'));
  // QUOXON handoff offer (2026-10-17): the same unheld-tool reasoning for EVERY agent, with no cap on how many agents
  // hold the tool (a widely held tool is still one this agent lacks). An attached specialist without delegate_to_agent
  // (triage-q asked about VM CPU) gets no hint text, but the gap goes back as unheldHints so the turn can offer the
  // human a one-turn handoff to CommanderQ (lib/handoffSuggest.js). delegationHints are unchanged.
  // Only on request (lib/handoffSuggest.js): a turn's offer never pays for ranking the whole catalogue a second time.
  const unheldHints = withUnheld ? unheldGaps(Infinity, scopeRoutedToolNames) : [];
  // 0f. a slot to create or attach to: the slot write tools (lane S)
  if (SLOT_CREATE_RE.test(String(message || ''))) for (const n of SLOT_WRITE_TOOLS) take(byName.get(n));
  if (SLOT_SAY_RE.test(String(message || ''))) take(byName.get('slot_say'));
  // 1. the strongest matches first (at least a third of the cap), so core never crowds them out
  const strong = Math.max(1, Math.floor(max / 3));
  for (const r of ranked.filter((x) => eligible(x.tool) && rankOffer(x.tool)).slice(0, strong)) take(r.tool);
  // 1b. a CLI capability no pool tool matches by name: the CLI reach tool (lane J). P2: a
  // strong match against SITE-CLI's plain-words asks per leaf counts as CLI intent too.
  const cliIntent = hasCliIntent(message);
  const strongLeaf = list.some((t) => CLI_TOOLS.includes(t.name)) ? strongCliMatch(message) : null;
  // #914: the ask names a leaf's own words and no tool's NAME carries all of them (a group-level
  // tool such as slot_list or seo_summary does not read "slot bridges" or "backlinks"): offer quox_cli
  // rather than leave the model to say "I don't have a tool".
  const namedLeaf = list.some((t) => CLI_TOOLS.includes(t.name)) ? leafNamed(message) : null;
  const leafUncovered = !!namedLeaf && !ranked.some((r) => !CLI_TOOLS.includes(r.tool.name)
    && namedLeaf.words.every((w) => nameTokens(r.tool.name).some((t) => stem(t) === w || (w.length >= 6 && stem(t).slice(0, 6) === w.slice(0, 6)))));
  if (cliIntent || strongLeaf || leafUncovered) {
    // Nouns from the user's own message; verbs (list, show, get...) name-match dozens of
    // tools and say nothing about whether a DEDICATED tool covers the thing asked about.
    const verbs = cliVerbs();
    const nouns = new Set(tokens(message).map(stem).filter((t) => !verbs.has(t))); // literal words, no synonyms
    // J2 (quox#852): EVERY CLI surface the user names must have a dedicated tool. One shared
    // word is not coverage: "security engagements" matched security_audit on "security" and
    // nothing covered engagements, so quox_cli was never offered (live, openai, 2026-10-14).
    const groups = cliGroups();
    const surfaces = [...nouns].filter((t) => groups.has(t));
    const dedicated = (noun) => ranked.some((r) => !CLI_TOOLS.includes(r.tool.name) && nameTokens(r.tool.name).some((t) => stem(t) === noun));
    const covered = surfaces.length > 0 && surfaces.every(dedicated);
    // REACH: a verbatim corpus ask is covered only by a tool whose NAME carries the leaf's own
    // words past its group ("ip-allowlist", "bridge"); security_* or slot_list name the group alone.
    const leafWords = (leaf) => { const w = leaf.replace(/-/g, ' ').split(' ').map(stem); const rest = w.slice(1).filter((x) => !['list', 'show', 'get', 'status', 'read', 'view'].includes(x)); return rest.length ? rest : [w[0]]; };
    const exactCovered = (leaf) => ranked.some((r) => !CLI_TOOLS.includes(r.tool.name) && leafWords(leaf).every((w) => nameTokens(r.tool.name).some((t) => stem(t) === w)));
    const strongUncovered = !!strongLeaf && (strongLeaf.exact ? !exactCovered(strongLeaf.leaf) : !dedicated(stem(strongLeaf.leaf.split(' ')[0])));
    if ((cliIntent && !covered) || strongUncovered || leafUncovered || CLI_EXPLICIT_RE.test(String(message || ''))) {
      // The read is never pushed out: on a full offer it replaces the lowest-relevance pick
      // (the last one taken), never a role need. The write keeps the ordinary rule.
      const read = byName.get(CLI_TOOLS[0]);
      if (read && !seen.has(read.name) && eligible(read) && picked.length >= max) {
        for (let i = picked.length - 1; i >= 0; i--) {
          if (!roleNeeds.has(picked[i].name)) { seen.delete(picked[i].name); picked.splice(i, 1); break; }
        }
      }
      for (const n of CLI_TOOLS) take(byName.get(n));
    }
  }
  // 2. what the agent's role needs
  for (const n of roleNeeds) take(byName.get(n));
  // 3. core reads, bounded to half the cap
  let core = 0;
  for (const n of CORE_TOOLS) { if (core >= Math.ceil(max / 2)) break; const t = byName.get(n); if (t && !seen.has(n)) { take(t); if (seen.has(n)) core++; } }
  // 4. the rest of the ranked matches
  for (const r of ranked) if (rankOffer(r.tool)) take(r.tool);
  // 5. a pool whose eligible tools all fit the cap is offered whole (nothing to gain by guessing)
  const eligibleAll = list.filter(eligible);
  if (eligibleAll.length <= max) for (const t of eligibleAll) take(t);

  // P2: an offered quox_cli carries this ask's likely leaves (name, usage, class) so the
  // model calls the right one first. A per-turn copy; the pool's definition is untouched.
  const hint = picked.some((t) => CLI_TOOLS.includes(t.name)) ? cliCandidateHint(message) : '';
  if (hint) for (let i = 0; i < picked.length; i++) if (CLI_TOOLS.includes(picked[i].name)) picked[i] = { ...picked[i], description: `${picked[i].description || ''} ${hint}`.trim(), turnHint: hint };

  const withheld = [...new Set([...ranked.filter((r) => !eligible(r.tool)).map((r) => r.tool.name), ...governedWithheld])];
  // the hint rides on THIS turn's copy of delegate_to_agent; the shared pool object is never changed
  const di = picked.findIndex((t) => t.name === 'delegate_to_agent');
  const heldAsk = require('./heldChangeAsk.js').isHeldChangeAsk(message);
  if ((delegationHints.length || heldAsk) && di >= 0) {
    const pinTools = new Set(intentPinsFor(message).map((p) => p.tool));
    const lines = delegationHints.map((h) => `${h.tool} is not yours for this ask: ${describeHolders(h.holders)}${pinTools.has(h.tool) || h.pin ? ` In the task, tell it to run ${h.tool}.` : ''}`);
    if (heldAsk) {
      // SITE-CLI 2026-10-17 journey-server-trouble (ev_mvcpwzqm_e8c14c): the fix was found, then the turn ended on an offer.
      const ca = holdersOf(HELD_FIX_CONTAINER_TOOL, agent);
      lines.push('The user asked you to propose the fix and hold it for their approval: diagnose read-only, then ISSUE the change '
        + '(delegate it to the holder of the tool that makes it and tell it to run that tool). The approval gate holds it as a card '
        + 'and nothing runs until they approve. Do not end by offering to raise it; they already asked.'
        + (ca.length ? ` A container start, stop or restart is ${HELD_FIX_CONTAINER_TOOL}: ${describeHolders(ca)}` : ''));
    }
    picked[di] = { ...picked[di], description: `${picked[di].description || ''}\nFor this ask (quox#976): ${lines.join(' ')}` };
  }
  return { offered: picked, poolSize: list.length, writeIntent, intent: writeIntent ? 'act' : 'read', withheld, governedWithheld, delegationHints, unheldHints };
}

/**
 * The per-turn offer the loops consult. tools() is what the model sees this round
 * (compact definitions + more_tools); isOffered() gates dispatch; moreTools() widens
 * the offer for the next round, within the same pool and the same write rule.
 */
function createToolOffer({ pool, message = '', history = [], agent = '', cap = DEFAULT_CAP, compact = true, onWiden, slotNames = [], terminal = false, plan = false, agentScope = null } = {}) {
  const list = (Array.isArray(pool) ? pool : []).filter((t) => t && t.name && t.name !== MORE_TOOLS_NAME);
  const sel = selectTurnTools({ pool: list, message, history, agent, cap, slotNames, terminal, plan, agentScope });
  const offered = new Map(sel.offered.map((t) => [t.name, t]));
  const maxOffered = Math.max(cap * 3, cap + MORE_TOOLS_LIMIT);
  const { eligible } = turnEligibility({ list, message, agent, slotNames, terminal, plan });
  const shape = (t) => (compact ? compactTool(t) : { name: t.name, description: t.description, input_schema: t.input_schema || t.inputSchema || { type: 'object', properties: {} } });

  return {
    tools() {
      return [...[...offered.values()].map(shape), MORE_TOOLS_DEF];
    },
    isOffered(name) { return offered.has(name); },
    offeredNames() { return [...offered.keys()]; },
    summary() { return { offered: offered.size, pool: list.length, writeIntent: sel.writeIntent, intent: sel.intent, mode: plan ? 'plan' : 'ask', names: [...offered.keys()], governedWithheld: sel.governedWithheld }; },
    /** PLAN MODE: the call-time refusal for an offered tool whose call would change state (else null). */
    planRefusal(name, input) { return plan ? require('./planMode.js').planRefusal(name, input) : null; },
    /** class 3: why a not-offered tool was not run (the offer gate's refusal text). */
    refusalFor(name) {
      if (plan && name !== TERMINAL_SUGGEST_TOOL && require('./planMode.js').isPlanBlocked(name, {})) return require('./planMode.js').planRefusal(name, {});
      if (READ_TURN_WITHHELD.has(name) && !sel.writeIntent) return `Dropped: ${name} was not run because the user asked a read-only question; no hat switch is proposed on a read. Answer with what you can read; if a tool is on another hat, say which (hat_catalogue) and that the user can ask to switch.`;
      if (name === 'delegate_to_agent' && (sel.governedWithheld || []).includes(name)) return 'Not run: this message is addressed to a slot (a session address, not an agent). Send it with slot_say (name = the slot), never through delegation.';
      if ((sel.governedWithheld || []).includes(name)) return `Not run: ${name} reads a different source than the governed Quox store for this ask. Use ${sel.offered.filter((t) => !isStateChangingTool(t)).map((t) => t.name).slice(0, 4).join(', ') || 'the offered tools'} instead, or say the store cannot be read.`;
      return null;
    },
    /** The more_tools call. -> a tool result (success, tools[{name, description}], withheld, note). */
    moreTools(input) {
      const q = input && typeof input.query === 'string' ? input.query.slice(0, 300) : '';
      const terms = queryTerms(q, []);
      const ranked = rank(list.filter((t) => !offered.has(t.name)), terms);
      const added = [];
      const withheld = [];
      for (const r of ranked) {
        if (!eligible(r.tool)) { withheld.push(r.tool.name); continue; }
        if (added.length >= MORE_TOOLS_LIMIT || offered.size >= maxOffered) break;
        offered.set(r.tool.name, r.tool);
        added.push({ name: r.tool.name, description: firstSentence(r.tool.description) });
      }
      // QUOXON-PARITY: the capability may live on another hat. When the search adds nothing,
      // the hat tools (inspect, propose) are offered so the agent can ask instead of giving up.
      // Keyword matches on a generic verb ("read") can look like hits, so the hat tools ride
      // along on every more_tools answer (outside the per-call limit) until they are offered.
      const searchFound = added.length > 0;
      let hatHint = false;
      for (const n of CAPABILITY_TOOLS) {
        const t = list.find((x) => x.name === n);
        if (!t || !eligible(t)) continue;
        hatHint = true;
        if (!offered.has(n) && offered.size < maxOffered) { offered.set(n, t); added.push({ name: n, description: firstSentence(t.description) }); }
      }
      if (added.length && typeof onWiden === 'function') {
        try { onWiden(added.map((a) => a.name)); } catch { /* telemetry only */ }
      }
      const notes = [];
      notes.push(searchFound ? 'These tools can be called on your next step.' : 'No other tool on this hat matches that.');
      if (hatHint && !sel.writeIntent) notes.push('If the capability is still missing, hat_catalogue shows which hat carries it; this is a read-only ask, so do not propose a switch: say which hat has it and that the user can ask to switch.');
      else if (hatHint) notes.push('If the capability is still missing, hat_catalogue shows which hat carries it and hat_propose_switch asks the user to switch (a human approves); say what is missing rather than guessing.');
      else if (!searchFound) notes.push('Answer with what you have or say what is missing.');
      if (withheld.length && plan) notes.push(`PLAN MODE: state-changing tools (${withheld.slice(0, 6).join(', ')}) are not available on this turn; put them in the plan.`);
      else if (withheld.length) notes.push(`State-changing tools (${withheld.slice(0, 6).join(', ')}) are offered only when the user asks for that change.`);
      return { success: true, tools: added, withheld: withheld.slice(0, 10), note: notes.join(' ') };
    },
  };
}

/**
 * The /chat/stream wiring: build the offer for one governed API turn, record it on the
 * turn (trace `tools offered: N of M`) and in the log. -> the offer.
 */
function buildStreamToolOffer({ provider, pool, history, message, agent, trace, turnId, profile, log = console, slotNames = [], terminal = false, plan = false, agentScope = null }) {
  const onWiden = typeof trace === 'function'
    ? (names) => { try { trace({ protocol: 'volt', label: `tools added: ${names.length}`, ref: null, detail: names.join(', ') }); } catch { /* telemetry only */ } }
    : undefined;
  const offer = createToolOffer({ pool, message, history, agent, cap: capForProvider(provider), onWiden, slotNames, terminal, plan, agentScope });
  const sum = offer.summary();
  if (typeof trace === 'function') {
    try { trace({ protocol: 'volt', label: `tools offered: ${sum.offered} of ${sum.pool}`, ref: null, detail: sum.names.join(', ') }); } catch { /* telemetry only */ }
  }
  log.log?.(`[ToolOffer] turn=${turnId || '-'} agent=${agent} provider=${provider} offered=${sum.offered}/${sum.pool} write_intent=${sum.writeIntent}${plan ? ' mode=plan' : ''} profile=${profile || '-'} tools=${sum.names.join(',')}`);
  return offer;
}

/**
 * QUOXON-PARITY: the catalogue path (the Claude subscription CLI, which lists tools in its
 * prompt and calls them through `quox tool exec`; it has no per-round offer to widen).
 * Same pool and the SAME eligibility rule as createToolOffer, so the set a model may try is
 * identical on every path: every eligible tool (what an API offer reaches via more_tools),
 * state-changing tools only when the user asks for a change or the role needs them.
 * -> { offered, poolSize, writeIntent, withheld }
 */
function selectCatalogueTools({ pool, message = '', agent = '', slotNames = [], terminal = false, plan = false } = {}) {
  const list = (Array.isArray(pool) ? pool : []).filter((t) => t && t.name && t.name !== MORE_TOOLS_NAME);
  const { writeIntent, eligible } = turnEligibility({ list, message, agent, slotNames, terminal, plan });
  return {
    offered: list.filter(eligible),
    poolSize: list.length,
    writeIntent,
    withheld: list.filter((t) => !eligible(t)).map((t) => t.name),
  };
}

/** The catalogue path's trace + log line, the same shape as buildStreamToolOffer's. -> tools */
function buildCatalogueTools({ provider, pool, message, agent, trace, turnId, log = console, slotNames = [] }) {
  const sel = selectCatalogueTools({ pool, message, agent, slotNames });
  if (typeof trace === 'function') {
    try { trace({ protocol: 'volt', label: `tools offered: ${sel.offered.length} of ${sel.poolSize}`, ref: null, detail: sel.offered.map((t) => t.name).join(', ') }); } catch { /* telemetry only */ }
  }
  log.log?.(`[ToolOffer] turn=${turnId || '-'} agent=${agent} provider=${provider} path=catalogue offered=${sel.offered.length}/${sel.poolSize} write_intent=${sel.writeIntent}`);
  return sel.offered;
}

// Self-hosted model servers (small local context windows): Ollama and the B5
// openai_compatible self-hosted presets. Hosted presets (OpenRouter, HF, Groq,
// Together, Custom) are treated like OpenAI.
const SMALL_LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'vllm']);
const isSmallLocalProvider = (provider) => SMALL_LOCAL_PROVIDERS.has(String(provider || '').toLowerCase());

/** Per-provider cap: small local context windows get fewer tools. */
function capForProvider(provider) {
  return isSmallLocalProvider(provider) ? OLLAMA_CAP : DEFAULT_CAP;
}

module.exports = {
  makeUnheldCatalogue, // quox#1064 (exported for unit test)
  MORE_TOOLS_NAME,
  MORE_TOOLS_DEF,
  DEFAULT_CAP,
  OLLAMA_CAP,
  STATE_CHANGE_RULE,
  APPROVAL_CLAIM_RULE,
  SAFETY_CLAIM_RULE,
  INBOX_ROUTING_RULE,
  GROUNDING_RULE,
  NO_STAND_IN_TASK_RULE,
  STALE_RULE,
  COMMAND_RULE,
  QUOX_CLI_OFFERED_RULE,
  CLAIM_RULES,
  DECISION_RULE,
  standInWithheld,
  CORE_TOOLS,
  AGENT_DEFAULTS,
  CAPABILITY_TOOLS,
  KNOWLEDGE_TOOL,
  SKILL_TOOLS,
  INTENT_ROUTES,
  INTENT_PINS,
  intentPinsFor,
  namedToolsIn,
  routedToolNames,
  liveDataNeeds,
  LIVE_DATA_NEEDS,
  GOVERNED_ROUTES,
  governedRoutesFor,
  addressesSlot,
  governedPolicy,
  READ_TURN_WITHHELD,
  securityReadNoShell,
  classifyTurnIntent,
  turnEligibility,
  selectCatalogueTools,
  buildCatalogueTools,
  isStateChangingTool,
  TOOL_WRITE_ACTIONS,
  WRITE_ACTION_VERBS,
  TERMINAL_SUGGEST_TOOL,
  WRITE_TOKENS, // PLAN MODE read allowlist (lib/planMode.js)
  WRITE_NAMES,
  READ_NAMES,
  isWriteAction,
  hasWriteIntent,
  hasUrlInMessage,
  firstSentence,
  compactTool,
  selectTurnTools,
  hasCliIntent,
  createToolOffer,
  capForProvider,
  isSmallLocalProvider,
  buildStreamToolOffer,
};
