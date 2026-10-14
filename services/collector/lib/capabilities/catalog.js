/**
 * QUOXON E1: the capabilities the terminal (and later the dashboard) can talk
 * about. This file DECLARES what each capability needs; it never declares
 * whether it is available. Availability is computed in ./index.js from real
 * signals only: service health, licence, plugin install state, provider
 * status and org data. The one static state is `planned: true`, which is a
 * statement about the product (not built yet), never about this install.
 *
 * Requirement kinds (evaluated in order; the first `unavailable` wins, else
 * the first `requires_setup`, else the capability is installed):
 *   { licence: '<pluginId>', name }  entitlement via the auth has-plugin check
 *   { service: '<key>' }             health of a backing service (SERVICES below)
 *   { install: '<pluginId>', name }  org plugin install row (absent or disabled)
 *   { provider: 'openai'|'anthropic'|'claude_subscription'|<B5 preset id>|'any' }
 *   { count: '<probe>', none, setup, setupNeeds? }  org data (0 = needs setup)
 *   { check: '<probe>', fail }       a boolean probe on this collector
 *
 * Drift fields (QUOXON-REACH, pinned by test/capabilitiesDrift.test.js):
 *   cli: ['<top-level quox command>']  the `quox` command groups this capability owns
 *   plugins: ['<pluginId>']            shipped plugin ids (src/config/plugins/index.js)
 *                                      it covers, beyond those named in `requires`
 * Anything shipped that no capability claims must be listed in
 * CAPABILITY_EXEMPT_CLI / CAPABILITY_EXEMPT_PLUGINS below, with a reason.
 *
 * Interfaces: where a person can use it today. conversation = the quox
 * terminal / CommanderQ chat, cli = a `quox` verb, dashboard = a web view.
 */

/** Backing services: the health key the evaluator asks for, and the name a person reads. */
const SERVICES = {
  auth: { label: 'Auth service', health: '/health' },
  memory: { label: 'Memory service', health: '/health' },
  tasks: { label: 'Tasks service (objectives)', health: '/health' },
  quoxflow: { label: 'Workflow Engine (quoxflow)', health: '/health' },
  quoxbrain: { label: 'Qortex (quoxbrain)', health: '/health' },
  quoxplan: { label: 'QuoxPlan service', health: '/health' },
  quoxseo: { label: 'QuoxSEO service', health: '/health' },
  qlarity: { label: 'QLarity browser service', health: '/health' },
  quoxsignal: { label: 'QuoxSignal service', health: '/health' },
  voice: { label: 'Voice service (quox-voice)', health: '/healthz' },
};

const ALL = ['conversation', 'cli', 'dashboard'];

const BASE_CATALOG = [
  // ---- talking to a model ---------------------------------------------------------------
  {
    id: 'chat', name: 'Chat', interfaces: ALL,
    intent: 'Ask Quox anything in plain language; CommanderQ routes it to the right agent.',
    evidence: 'An AEE envelope per turn (model request, tools, reply), WARD-witnessed.',
    requires: [{ provider: 'any' }],
    setup: '/connect openai (or /connect anthropic)', setupNeeds: 'admin',
  },
  {
    id: 'provider.openai', name: 'OpenAI', interfaces: ['conversation', 'cli', 'dashboard'],
    intent: 'Use OpenAI GPT models for your org.',
    evidence: 'Key stored in your org vault; only a fingerprint (label …last4) is audited.',
    requires: [{ provider: 'openai' }],
    setup: '/connect openai', setupNeeds: 'admin',
  },
  {
    id: 'provider.anthropic', name: 'Claude API', interfaces: ['conversation', 'cli', 'dashboard'],
    intent: 'Use Anthropic Claude models with an API key.',
    evidence: 'Key stored in your org vault; only a fingerprint (label …last4) is audited.',
    requires: [{ provider: 'anthropic' }],
    setup: '/connect anthropic', setupNeeds: 'admin',
  },
  {
    id: 'provider.claude_subscription', name: 'Claude subscription', interfaces: ['dashboard'],
    intent: 'Use a signed-in Claude subscription on this server.',
    evidence: 'Sign-in happens in the dashboard terminal; no key passes through chat.',
    requires: [{ provider: 'claude_subscription' }],
    setup: 'Dashboard: Settings, Core Integrations, open the Terminal and run /login', setupNeeds: 'admin',
  },
  // CLI-QUOX B5: OpenAI-compatible presets (served by /chat/stream as openai_compatible).
  ...[
    ['openrouter', 'OpenRouter', 'one key, many models, real per-call cost'],
    ['huggingface', 'Hugging Face', 'open models through the Inference Providers router'],
    ['groq', 'Groq', 'fast open-model inference'],
    ['together', 'Together AI', 'open-model inference'],
  ].map(([id, name, what]) => ({
    id: `provider.${id}`, name, interfaces: ['conversation', 'cli'],
    intent: `Use ${name} for your org (${what}). Hosted: a third party in the data path, gated by your org's AI data sharing consent.`,
    evidence: 'Key stored in your org vault; only a fingerprint (label …last4) is audited. Every turn is an AEE envelope.',
    requires: [{ provider: id }],
    setup: `/connect ${id}`, setupNeeds: 'admin',
  })),
  ...[
    ['lmstudio', 'LM Studio'],
    ['vllm', 'vLLM'],
  ].map(([id, name]) => ({
    id: `provider.${id}`, name, interfaces: ['conversation', 'cli'],
    intent: `Use models served by your own ${name} server on your network (no third party added).`,
    evidence: 'The server URL is stored in your org vault; a LAN address needs the operator LAN gate and an exact-origin allowance.',
    requires: [{ provider: id }],
    setup: `/connect ${id} http://<host>`, setupNeeds: 'admin',
  })),
  // QUOXON-PROOF (quox#822): Ollama serves turns (provider 'ollama' on /chat/stream) and
  // had no row. Self-hosted: no third party is added to the data path.
  {
    id: 'provider.ollama', name: 'Ollama', interfaces: ['conversation', 'cli'],
    intent: 'Use models served by your own Ollama server (no third party added).',
    evidence: 'The server URL is stored in your org vault (no secret); every turn is an AEE envelope naming the model and host that ran.',
    requires: [{ provider: 'ollama' }],
    setup: '/connect ollama http://<host>:11434', setupNeeds: 'admin',
  },
  {
    id: 'provider.custom', name: 'Custom OpenAI-compatible endpoint', interfaces: ['conversation', 'cli'],
    intent: 'Use any public https OpenAI-compatible endpoint. Hosted: a third party in the data path, gated by your org\'s AI data sharing consent.',
    evidence: 'URL and optional key stored in your org vault; only a fingerprint is audited.',
    requires: [{ provider: 'custom' }],
    setup: '/connect custom https://<host>/v1', setupNeeds: 'admin',
  },
  // ---- core governance ------------------------------------------------------------------
  {
    id: 'memory', name: 'Memory', interfaces: ALL,
    intent: 'Remember and recall facts for your org, with where each one came from.',
    evidence: 'Each memory keeps its provenance (who, when, source); writes are audited.',
    requires: [{ service: 'memory' }],
  },
  {
    id: 'qortex', name: 'Qortex', interfaces: ['cli', 'dashboard'],
    intent: 'Search your org knowledge brain for past decisions and history.',
    evidence: 'Search results cite the stored entries they came from.',
    requires: [{ service: 'quoxbrain' }],
  },
  {
    id: 'approvals', name: 'Approvals', interfaces: ALL,
    intent: 'See what is waiting for your decision and approve or deny it.',
    evidence: 'Every decision is recorded with who decided, when, and what was approved.',
    requires: [{ service: 'auth' }],
  },
  {
    id: 'receipts', name: 'Receipts and verify', interfaces: ALL,
    intent: 'Show the proof of what happened and check it has not been altered.',
    evidence: 'AEE envelopes chained and witnessed by WARD; verify recomputes the chain.',
    requires: [{ check: 'collectorEvidence', fail: 'The evidence store is not open on this QuoxCORE' }],
  },
  {
    id: 'vault', name: 'Vault', interfaces: ['conversation', 'cli', 'dashboard'],
    intent: 'Store credentials for integrations and lend them to agents just in time.',
    evidence: 'Every lease and write is audited by label and type, never by value.',
    requires: [{ service: 'auth' }],
  },
  {
    id: 'agents', name: 'Agents', interfaces: ALL,
    intent: 'Talk to a specialist agent directly (/attach) or let CommanderQ pick one.',
    evidence: 'Replies carry the agent identity in their envelope.',
    requires: [{ service: 'auth' }],
  },
  // ---- automation -----------------------------------------------------------------------
  {
    id: 'workflows', name: 'Workflows', interfaces: ALL,
    intent: 'Run multi-step workflows with approval gates and an evidence chain.',
    evidence: 'Each run and step is an envelope; approval gates record the decision.',
    requires: [{ service: 'quoxflow' }],
  },
  {
    id: 'skills', name: 'Skills', interfaces: ALL,
    intent: 'Reusable procedures an agent follows, governed and versioned.',
    evidence: 'Each run is recorded against the skill edition that ran.',
    requires: [{ service: 'quoxflow' }],
  },
  {
    id: 'crystals', name: 'Crystals', interfaces: ['cli', 'dashboard'],
    intent: 'Turn a proven workflow into a deterministic replay once it has earned it.',
    evidence: 'Promotion needs a run history that passes the crystalliser gate, and an approval.',
    requires: [{ service: 'quoxflow' }],
  },
  {
    id: 'objectives', name: 'Objectives', interfaces: ALL,
    intent: 'Give Quox a goal; it plans, checks in at checkpoints, and reports.',
    evidence: 'The plan approval and every checkpoint decision are recorded.',
    requires: [{ service: 'tasks' }],
  },
  {
    id: 'loops', name: 'Loops (QLoop)', interfaces: ['cli', 'dashboard'],
    intent: 'Let a model work toward a goal turn by turn on a governed dev server.',
    evidence: 'Every turn is WARD-witnessed; budget and risk gates stop it.',
    requires: [
      { licence: 'dev-servers', name: 'Dev Servers' },
      { service: 'tasks' },
      { count: 'devServers', none: 'No dev server enrolled for your org', setup: 'quox dev enable <hostId>', setupNeeds: 'admin' },
    ],
  },
  // ---- awareness ------------------------------------------------------------------------
  {
    id: 'lucid', name: 'LUCID', interfaces: ALL,
    intent: 'What is going on, what needs you, and what Quox cannot see.',
    evidence: 'Read from the persisted LUCID journal; nothing is summarised by a model.',
    requires: [{ check: 'lucidReady', fail: 'The LUCID journal is not open on this QuoxCORE' }],
  },
  // ---- connected work -------------------------------------------------------------------
  {
    id: 'mail', name: 'Mail (InboxQ)', interfaces: ALL,
    intent: 'Triage your inbox and propose filing, blocking or drafting, with your approval.',
    evidence: 'Every proposal and its approval are recorded; moves are witnessed.',
    requires: [
      { licence: 'inboxq', name: 'InboxQ' },
      { count: 'mailAccounts', none: 'No mailbox connected yet', setup: 'quox mail connect' },
    ],
  },
  {
    id: 'calendar', name: 'Calendar (Calendar-Q)', interfaces: ALL,
    intent: 'Read your agenda and propose events, with your approval.',
    evidence: 'Write proposals and their approvals leave receipts.',
    requires: [
      { licence: 'calendar-q', name: 'Calendar-Q' },
      { count: 'calendarConnections', none: 'No calendar connected yet', setup: 'Dashboard: Calendar-Q, connect a calendar' },
    ],
  },
  {
    id: 'seo', name: 'SEO (QuoxSEO)', interfaces: ['cli', 'dashboard', 'conversation'],
    intent: 'Crawl your sites, track search performance, and show what changed.',
    evidence: 'Crawls and changes are signed and chained; quox seo verify rechecks them.',
    requires: [
      { licence: 'quoxseo', name: 'QuoxSEO' },
      { install: 'quoxseo', name: 'QuoxSEO' },
      { service: 'quoxseo' },
    ],
  },
  {
    id: 'plan', name: 'Plan (QuoxPlan)', interfaces: ALL,
    intent: 'Read and update your roadmap: streams, phases and notes.',
    evidence: 'Edits through Quox are recorded as quoxplan.* envelopes.',
    requires: [
      { licence: 'quoxplan', name: 'QuoxPlan' },
      { install: 'quoxplan', name: 'QuoxPlan' },
      { service: 'quoxplan' },
    ],
  },
  {
    id: 'qlarity', name: 'QLarity', interfaces: ['cli', 'dashboard', 'conversation'],
    intent: 'Inspect a live web page: styles, console, network, screenshots.',
    evidence: 'Each inspection is receipted; running arbitrary script always needs an approval.',
    requires: [
      { licence: 'qlarity', name: 'QLarity' },
      { install: 'qlarity', name: 'QLarity' },
      { service: 'qlarity' },
    ],
  },
  {
    id: 'voice', name: 'Voice', interfaces: ['cli', 'dashboard'],
    intent: 'Talk to Quox by phone or in the browser.',
    evidence: 'Calls keep a summary and turns; actions on a call are recorded.',
    requires: [
      { install: 'quox-voice', name: 'Quox Voice' },
      { service: 'voice' },
    ],
  },
  {
    id: 'slots', name: 'Slots', interfaces: ['conversation', 'cli', 'dashboard'],
    intent: 'Give a session a durable address people can message (/slot).',
    evidence: 'Checkouts and messages are recorded against the slot.',
    requires: [
      { licence: 'quoxslots', name: 'QuoxSlots' },
      { install: 'quoxslots', name: 'QuoxSlots' },
    ],
  },
  {
    id: 'fleet', name: 'Fleet', interfaces: ['cli', 'dashboard', 'conversation'],
    intent: 'Run governed commands on your hosts; risky ones wait for approval.',
    evidence: 'Every command, its approval and its output are recorded.',
    requires: [
      { licence: 'bastion-fleet', name: 'Bastion Fleet' },
      { install: 'bastion-fleet', name: 'Bastion Fleet' },
    ],
  },
  {
    id: 'signal', name: 'Signal (QuoxSignal)', interfaces: ['cli', 'dashboard'],
    intent: 'Turn sources you follow into proposals worth acting on.',
    evidence: 'Each proposal cites the sources it came from.',
    requires: [
      { licence: 'quoxsignal', name: 'QuoxSignal' },
      { service: 'quoxsignal' },
    ],
  },
  // ---- QUOXON-REACH: shipped domains the catalogue used to omit -------------------------
  // Core domains served by this collector use the `collectorCore` check (this
  // very process serves the route), or the backing service they really call.
  {
    id: 'safety', name: 'Safety (kill switch and DEFCON)', interfaces: ['cli', 'dashboard'],
    intent: 'Stop one agent at once (E-STOP), or raise the whole instance DEFCON level.',
    evidence: 'Every flip is appended to an audit trail with who did it; only a signed-in human admin can change it.',
    requires: [{ check: 'collectorCore', fail: 'The safety gate is not served by this QuoxCORE' }],
  },
  {
    id: 'hats', name: 'Hats (QuoxHat)', interfaces: ['conversation', 'cli', 'dashboard'],
    intent: 'See which hat (tools, mode, enforcement) each agent wears, and switch with approval.',
    evidence: 'A hat has a revision; a switch is a proposal that leaves a receipt.',
    requires: [{ check: 'collectorCore', fail: 'Hats are not served by this QuoxCORE' }],
  },
  {
    id: 'contacts', name: 'Contacts (ContactsQ)', interfaces: ['conversation', 'cli', 'dashboard'],
    intent: 'Governed contacts: find a person, resolve a caller, log a touchpoint, suppress.',
    evidence: 'Writes are quox.contacts.* envelopes; contact data is encrypted at rest.',
    requires: [{ licence: 'contactsq', name: 'ContactsQ' }],
    setup: 'quox licence status', setupNeeds: 'admin',
  },
  {
    id: 'notes', name: 'Notes (NotesQ)', interfaces: ['conversation', 'cli', 'dashboard'],
    intent: 'Governed markdown notes: list, read, write, see history and restore.',
    evidence: 'Each change is a quox.notes.* envelope (never the note text) and keeps a restorable history.',
    requires: [
      { licence: 'notesq', name: 'NotesQ' },
      { service: 'quoxbrain' },
    ],
  },
  {
    id: 'actions', name: 'Action tracker', interfaces: ['dashboard'],
    intent: 'Track actions and follow-ups that came out of your work.',
    evidence: 'Each action keeps its source and status changes.',
    requires: [
      { licence: 'action-tracker', name: 'Action Tracker' },
      { install: 'action-tracker', name: 'Action Tracker' },
    ],
  },
  {
    id: 'quoxchat', name: 'QuoxChat', interfaces: ALL, cli: ['quoxchat'],
    intent: 'A chat widget for your website that answers from your own knowledge.',
    evidence: 'Answers cite the knowledge entries they used; widget traffic is metered per org.',
    requires: [
      { licence: 'quoxchat', name: 'QuoxChat' },
      { install: 'quoxchat', name: 'QuoxChat' },
    ],
  },
  {
    id: 'lens', name: 'Lens (QuoxLens)', interfaces: ['conversation', 'dashboard'],
    intent: 'Read what your estate exposes and apply or accept the risk on a finding.',
    evidence: 'Applying a fix or accepting a risk is a recorded decision with who and why.',
    requires: [
      { licence: 'quoxlens', name: 'QuoxLens' },
      { install: 'quoxlens', name: 'QuoxLens' },
    ],
  },
  ...[
    ['x', 'X (Twitter)', ['conversation', 'cli', 'dashboard'], 'x'],
    ['linkedin', 'LinkedIn', ['cli', 'dashboard'], 'linkedin'],
    ['facebook', 'Facebook Pages', ['cli', 'dashboard'], 'facebook'],
    ['instagram', 'Instagram', ['cli', 'dashboard'], 'instagram'],
    ['tiktok', 'TikTok', ['cli', 'dashboard'], 'tiktok'],
    ['youtube', 'YouTube', ['dashboard'], null],
  ].map(([id, name, interfaces, cli]) => ({
    id: `social.${id}`, name, interfaces, ...(cli ? { cli: [cli] } : {}),
    intent: `Publish to ${name} through a governed queue: nothing goes out without a human approval.`,
    evidence: 'Each post is a proposal in the Approvals inbox; the approval and the publish are recorded.',
    requires: [
      { licence: id, name },
      { install: id, name },
    ],
  })),
  {
    id: 'comms', name: 'Comms (rooms and alerts)', interfaces: ['dashboard'], plugins: ['core-comms', 'comms'],
    intent: 'Real-time chat rooms, and notifications when an approval needs you.',
    evidence: 'Notifications point at the approval; the decision itself is recorded in Approvals.',
    requires: [{ install: 'comms', name: 'Comms' }],
  },
  {
    id: 'comms.telegram', name: 'Telegram Pro', interfaces: ['cli', 'dashboard'], cli: ['tg'],
    intent: 'Reach Quox from Telegram, bound to the owner, with session leases.',
    evidence: 'Owner binding and each lease are recorded.',
    requires: [
      { licence: 'telegram-pro', name: 'Telegram Pro' },
      { install: 'telegram-pro', name: 'Telegram Pro' },
    ],
  },
  {
    id: 'comms.discord', name: 'Discord Pro', interfaces: ['cli', 'dashboard'], cli: ['discord'],
    intent: 'Bind Discord channels to Quox agents and slots.',
    evidence: 'Each binding and relayed message is recorded.',
    requires: [
      { licence: 'discord-pro', name: 'Discord Pro' },
      { install: 'discord-pro', name: 'Discord Pro' },
    ],
  },
  {
    id: 'code.build', name: 'Builds (QuoxBuild)', interfaces: ['cli', 'dashboard'], cli: ['build'],
    intent: 'Dispatch and inspect governed builds on your dev servers.',
    evidence: 'Each build, its outcome and the deploy check are recorded.',
    requires: [
      { licence: 'quoxbuild', name: 'QuoxBuild' },
      { install: 'quoxbuild', name: 'QuoxBuild' },
    ],
  },
  {
    id: 'code.github', name: 'GitHub (GitQ)', interfaces: ['cli', 'dashboard'], cli: ['gripe'], plugins: ['gripe', 'developer-tools'],
    intent: 'Let agents read repos and file issues or pull requests, and file a quick gripe.',
    evidence: 'Each write goes through the connector and leaves a receipt.',
    requires: [
      { licence: 'github', name: 'GitHub' },
      { install: 'github', name: 'GitHub' },
    ],
  },
  {
    id: 'code.nucleus', name: 'Codebase questions (Nucleus)', interfaces: ['cli', 'dashboard'], cli: ['nucleus'], plugins: ['codebase-mirror'],
    intent: 'Ask your codebase a question and get cited snippets, not whole files.',
    evidence: 'Each query is audited and answers cite file and line.',
    requires: [
      { licence: 'quox-nucleus', name: 'Quox Nucleus' },
      { install: 'quox-nucleus', name: 'Quox Nucleus' },
    ],
  },
  {
    id: 'security', name: 'Security engagements', interfaces: ['conversation', 'cli', 'dashboard'], cli: ['engagement'],
    intent: 'Run a scoped security engagement: targets, scanners, findings and verification.',
    evidence: 'Scope checks, findings and verifications are recorded and closed on the WARD chain.',
    requires: [
      { licence: 'quox-security', name: 'QuoxSecurity' },
      { install: 'quox-security', name: 'QuoxSecurity' },
    ],
  },
  {
    id: 'spend', name: 'Spend and budgets', interfaces: ['conversation', 'cli', 'dashboard'], cli: ['budget'],
    intent: 'Set spend and usage budgets (org, objective, execution) and see what was used.',
    evidence: 'Budget limits and breaches are recorded against the scope they apply to.',
    requires: [{ service: 'quoxflow' }],
  },
  {
    id: 'files', name: 'Files', interfaces: ['conversation', 'cli', 'dashboard'], cli: ['file'],
    intent: 'Keep and share org files with access control.',
    evidence: 'Uploads, reads and shares are audited by file id.',
    requires: [
      { licence: 'files', name: 'Files' },
      { install: 'files', name: 'Files' },
    ],
  },
  {
    id: 'plugins', name: 'Plugins', interfaces: ['conversation', 'cli', 'dashboard'], cli: ['plugin'],
    intent: 'See which plugins your org has installed, install them, and turn them on or off.',
    evidence: 'Installs and toggles are recorded against the org and the admin who made them.',
    requires: [{ service: 'auth' }],
    setup: 'quox plugin list', setupNeeds: 'admin',
  },
  {
    id: 'identity', name: 'Identity and access', interfaces: ['conversation', 'cli', 'dashboard'],
    cli: ['org', 'invites', 'team', 'department', 'scope', 'sso', 'role', 'domain', 'security', 'scim', 'mfa', 'account', 'admin', 'settings', 'consent', 'notification', 'tag', 'webhook'],
    intent: 'Orgs, teams, roles, single sign-on, directory sync, MFA and org settings.',
    evidence: 'Membership, role and policy changes are audited with who changed them.',
    requires: [{ service: 'auth' }],
  },
  {
    id: 'install', name: 'Your install', interfaces: ['conversation', 'cli'],
    cli: ['server', 'setup', 'doctor', 'onboard', 'status', 'service', 'health', 'licence', 'license'],
    intent: 'Check, update and roll back this self-hosted Quox, and see its licence and health.',
    evidence: 'Health and licence answers come from the running services, not a cached claim.',
    requires: [{ check: 'collectorCore', fail: 'This QuoxCORE is not answering' }],
  },
  // ---- planned (product statement, not install state) -----------------------------------
  {
    id: 'residents', name: 'Resident agents', interfaces: ['conversation'], planned: true,
    intent: 'Hand a job to an agent that keeps running on the server after you leave.',
    evidence: 'Will be relayed through the collector with the org id and witnessed.',
    requires: [],
  },
];

/**
 * Claims for the capabilities declared above (cli groups and plugin ids). Kept
 * beside the entries, merged in below, so the drift test reads one catalogue.
 */
const CLAIMS = {
  chat: { cli: ['chat', 'chat-status', 'conversation', 'llm', 'llm-policy'] },
  memory: { cli: ['memory', 'entity'], plugins: ['advanced-memory'] },
  qortex: { cli: ['brain'], plugins: ['quox-brain2'] },
  approvals: { cli: ['approvals', 'inbox'] },
  receipts: { cli: ['aee', 'volt', 'trace', 'done'], plugins: ['decision-evidence'] },
  vault: { cli: ['vault', 'integration'] },
  agents: { cli: ['agent', 'assistant', 'tool', 'powers', 'prompt'], plugins: ['prompts-library'] },
  workflows: { cli: ['workflow', 'run', 'trigger'], plugins: ['workflow-library'] },
  skills: { cli: ['skills'] },
  objectives: { cli: ['objective'] },
  loops: { cli: ['dev'], plugins: ['qloop'] },
  lucid: { cli: ['lucid', 'aware', 'sitrep', 'awareness'] },
  mail: { cli: ['mail'] },
  calendar: { cli: ['calendar'] },
  seo: { cli: ['seo'] },
  plan: { cli: ['plan'] },
  qlarity: { cli: ['qlarity'], plugins: ['browser-q'] },
  voice: { cli: ['voice'], plugins: ['advanced-voice'] },
  slots: { cli: ['slot', 'claude', 'codex', 'gemini', 'wrap', 'sessions'] },
  fleet: {
    cli: ['fleet', 'quoxbox', 'backup', 'monitoring', 'mon', 'watch'],
    plugins: ['quoxagent-fleet', 'docker-fleet', 'proxmox', 'mikrotik-routeros', 'tailscale', 'wazuh', 'grafana', 'prometheus', 'uptime-kuma', 'backup-restore', 'system-maintenance'],
  },
  safety: { cli: ['safety', 'governance', 'policy', 'reach', 'inventory'] },
  hats: { cli: ['hat'] },
  contacts: { cli: ['contacts'] },
  notes: { cli: ['notes'] },
};

const CAPABILITY_CATALOG = BASE_CATALOG.map((c) => (CLAIMS[c.id] ? { ...c, ...CLAIMS[c.id] } : c));

/**
 * Top-level `quox` commands that are deliberately not a capability, with why.
 * The drift test fails for any shipped command in neither a capability's `cli`
 * nor this map.
 */
const CAPABILITY_EXEMPT_CLI = {
  login: 'session plumbing, not a capability',
  logout: 'session plumbing, not a capability',
  whoami: 'session plumbing, not a capability',
  signup: 'account creation before any capability exists',
  open: 'opens a quox:// link; a convenience, not a domain',
  motion: 'the brand motion gallery; cosmetic',
  tips: 'terminal tips registry; cosmetic',
  capabilities: 'this very report',
  dashboard: 'opens the web dashboard signed in; a launcher, not a domain',
  config: 'local CLI profile and config, not an org capability',
};

/** Shipped plugin ids no capability covers yet, with why. */
const CAPABILITY_EXEMPT_PLUGINS = {
  quoxtrade: 'trading dashboard plugin; no governed Quox verb or agent surface yet',
  'cognitive-topology': 'visualisation plugin; dashboard-only view of existing data',
  'aocl-compliance-suite': 'AOCL protocol bundle; surfaced under governance docs, not a runtime capability',
  'aocl-developer-kit': 'AOCL protocol bundle; developer kit, not a runtime capability',
  'web-terminal': 'dashboard terminal plugin; the terminal itself is not a capability',
  opsdeck: '3D ops view of existing fleet data; dashboard-only',
  'local-inference': 'local model host; reported through the provider capabilities when connected',
  visualizations: 'dashboard visual pack; cosmetic',
  cogcore3d: '3D view of existing data; dashboard-only',
  'quoxmind-pro': 'QuoxMind tier bundle; entitlement package, not a distinct capability',
  'quoxmind-complete': 'QuoxMind tier bundle; entitlement package, not a distinct capability',
  'quoxbox-macmini': 'QuoxBox Mac-mini agent; hardware-specific, reported by `quox quoxbox`',
  'chief-team-small': 'Chief team size bundle; entitlement package',
  'chief-team-medium': 'Chief team size bundle; entitlement package',
  'chief-team-enterprise': 'Chief team size bundle; entitlement package',
};

module.exports = { CAPABILITY_CATALOG, CAPABILITY_EXEMPT_CLI, CAPABILITY_EXEMPT_PLUGINS, SERVICES };
