/**
 * The Feed — source catalog (Qortex cockpit, Phase B).
 * (docs/STREAM_QUOXBRAIN2_COCKPIT_DESIGN.md screen 1,
 *  docs/STREAM_QUOXBRAIN2_OVERNIGHT_BUILD.md Phase B)
 *
 * A static, ordered description of every source type Qortex *can* ingest —
 * both the ones already wired into feedScheduler.js's SOURCE_INGESTERS
 * (`status: 'live'`) and the ones planned per the design doc's connector
 * list (`status: 'available'`, not yet ingesting). This is read-only
 * reference data (no DB access) — the "what you can add" list the cockpit
 * merges with an org's actual `feed_sources` rows via feedApiHandlers.js.
 *
 * Adding a new live ingester (F2+/E) is two edits: one line in
 * feedScheduler.js's SOURCE_INGESTERS, and flipping the matching entry's
 * `status` here from 'available' to 'live' (or adding a new entry if it's
 * a brand-new source type) — this file never needs scheduler internals.
 *
 * connector meanings:
 *   'host'     — reads local files/folders on a machine (path/config-driven).
 *   'oauth'    — a hosted third-party account, connected via OAuth (the
 *                CoreIntegrations.jsx pattern) — no path/config to type.
 *   'internal' — sourced from data QuoxCORE already has (AEE conversations,
 *                the fleet registry) — nothing external to connect.
 *
 * Source Universe fields (docs/STREAM_QUOXBRAIN2_SOURCE_UNIVERSE.md, step 1
 * of "Settings / governance UX") — every entry additionally carries:
 *   'tier'          — 'core' (the always-relevant base: conversations,
 *                      transcripts, folders, fleet, memory), 'knowledge'
 *                      (Tier 1 — the platform's own distilled knowledge),
 *                      'evidence' (Tier 2 — governed activity/audit trail),
 *                      or 'world' (Tier 3 — your external, personal sources).
 *   'sensitivity'   — 'none', 'pii', or 'evidence' — drives consent copy and
 *                      whether the source can default on.
 *   'whatItGives'   — one sentence, written from the agent's POV, of what
 *                      connecting this source gives your agents.
 *   'recommendedFor'— array of roles ('developer' | 'compliance' | 'ops' |
 *                      'everyone') the cockpit's guidance engine suggests
 *                      this source to.
 *   'defaultOn'     — sensible defaults, not everything-on: true only for
 *                      the always-relevant core base and low-sensitivity
 *                      Tier-1 knowledge; PII/evidence sources are opt-in
 *                      (false); secrets are never offered as a source at all.
 */

'use strict';

const FEED_SOURCE_CATALOG = [
  {
    sourceType: 'conversation',
    name: 'Conversations',
    description: "Claude/agent conversations already flowing through AEE — everything you and your agents do here.",
    connector: 'internal',
    requiresConfig: false,
    defaultScope: 'org',
    status: 'live',
    tier: 'core',
    sensitivity: 'none',
    whatItGives: 'Every conversation you and your agents have had in this workspace, so agents can recall prior context without you repeating yourself.',
    recommendedFor: ['everyone'],
    defaultOn: true,
  },
  {
    sourceType: 'transcript',
    name: 'Claude Code Transcripts',
    description: 'Terminal session transcripts from this machine (~/.claude sessions).',
    connector: 'host',
    requiresConfig: true,
    defaultScope: 'org',
    status: 'live',
    tier: 'core',
    sensitivity: 'none',
    whatItGives: 'Full Claude Code terminal session history from this machine, so agents can recall what you built and debugged in past sessions.',
    recommendedFor: ['everyone', 'developer'],
    defaultOn: true,
  },
  {
    sourceType: 'folder',
    name: 'A folder',
    description: 'Point Qortex at any folder of notes — .md/.markdown/.txt files, ingested recursively.',
    connector: 'host',
    requiresConfig: true,
    defaultScope: 'org',
    status: 'live',
    tier: 'core',
    sensitivity: 'none',
    whatItGives: 'Any folder of notes you point it at, ingested recursively, so agents can search your existing notes as part of their context.',
    recommendedFor: ['everyone'],
    defaultOn: true,
  },
  {
    sourceType: 'git',
    name: 'Git History',
    description: 'Commit messages and changed files from your repositories.',
    connector: 'host',
    requiresConfig: true,
    defaultScope: 'org',
    status: 'live',
    tier: 'world',
    sensitivity: 'none',
    whatItGives: 'Commit messages and changed files from your repositories, so agents can recall what changed, when, and why.',
    recommendedFor: ['developer'],
    defaultOn: false,
  },
  {
    sourceType: 'email',
    name: 'InboxQ Email',
    description: 'Your InboxQ mail (not spam, trash or drafts), one note per message, private to you. OFF by default. Disclosure: email bodies are sent to the Qortex embedding/rerank model configured for this instance, so if that model is a third-party cloud service your mail text leaves this machine. Only the mailboxes of the admin who connects it are read, never other users. To enable, set config {"consent": true} and scope "user".',
    connector: 'internal',
    requiresConfig: true,
    defaultScope: 'user',
    status: 'live',
    tier: 'world',
    sensitivity: 'pii',
    whatItGives: 'Your own email history, so agents can recall what was said in your mail. Private to you; the text is embedded by the instance\'s Qortex model, which may be a third-party service.',
    recommendedFor: ['everyone'],
    defaultOn: false,
  },
  {
    sourceType: 'docs',
    name: 'Docs & Markdown',
    description: 'Markdown docs trees on this machine. Set config.roots to a list of absolute directories (or config.path for one); each is walked recursively for .md files into the Quox Docs vault.',
    connector: 'host',
    requiresConfig: true,
    defaultScope: 'org',
    status: 'live',
    tier: 'world',
    sensitivity: 'none',
    whatItGives: 'Markdown and docs folders on this machine, so agents can search your written documentation as grounded context.',
    recommendedFor: ['developer'],
    defaultOn: false,
  },
  {
    sourceType: 'obsidian',
    name: 'Obsidian Vault',
    description: 'Notes from a local Obsidian vault, including the wikilinks between them.',
    connector: 'host',
    requiresConfig: true,
    // Org scope, not user: the ingester creates an org-scoped push vault
    // (same as every other host connector), so a 'user' scope here would
    // show a cockpit setting the pipeline does not honour. Per-user vault
    // scoping needs the scheduler to forward user identity and is a named
    // phase 2 item, not silently dropped.
    defaultScope: 'org',
    status: 'live',
    tier: 'world',
    sensitivity: 'none',
    whatItGives: 'Notes from your local Obsidian vault, with wikilinks between notes ingested as note to note links, so agents can draw on your personal knowledge base and how it connects.',
    recommendedFor: ['everyone'],
    defaultOn: false,
  },
  {
    sourceType: 'notion',
    name: 'Notion',
    description: "Pages and databases from a connected Notion workspace — import what you've already written.",
    connector: 'oauth',
    requiresConfig: false,
    defaultScope: 'org',
    status: 'available',
    tier: 'world',
    sensitivity: 'none',
    whatItGives: "Pages and databases from a connected Notion workspace, so agents can reference what your team has already written.",
    recommendedFor: ['everyone'],
    defaultOn: false,
  },
  {
    sourceType: 'gdrive',
    name: 'Google Drive',
    description: "Docs and files from a connected Google Drive account — import what you've already written.",
    connector: 'oauth',
    requiresConfig: false,
    defaultScope: 'org',
    status: 'available',
    tier: 'world',
    sensitivity: 'none',
    whatItGives: "Docs and files from a connected Google Drive account, so agents can reference documents you've already created.",
    recommendedFor: ['everyone'],
    defaultOn: false,
  },
  {
    sourceType: 'fleet',
    name: "Your fleet's activity",
    description: 'Recent activity logs from every QuoxAgent-managed machine in your fleet.',
    connector: 'internal',
    requiresConfig: false,
    defaultScope: 'org',
    status: 'live',
    tier: 'core',
    sensitivity: 'none',
    whatItGives: 'Recent per-host activity logs from your QuoxAgent-managed machines, so agents can recall what happened on other hosts in your fleet.',
    recommendedFor: ['ops'],
    defaultOn: true,
  },
  {
    sourceType: 'noc_tool_outcomes',
    name: 'Tool Outcomes',
    description: 'Every infra tool call (docker/ssh/proxmox/...) your agents ran, with success/latency/error — the ops ledger.',
    connector: 'internal',
    requiresConfig: false,
    defaultScope: 'org',
    status: 'live',
    tier: 'evidence',
    sensitivity: 'evidence',
    whatItGives: 'Every infra tool call your agents ran, with success, latency, and error, so agents can recall what actually happened when they touched infrastructure.',
    recommendedFor: ['developer', 'ops'],
    defaultOn: false,
  },
  {
    sourceType: 'governance_incidents',
    name: 'Governance Decisions',
    description: 'Resolved governance incidents — tamper-evident, WARD-witnessed where applicable.',
    connector: 'internal',
    requiresConfig: false,
    defaultScope: 'org',
    status: 'live',
    tier: 'evidence',
    sensitivity: 'evidence',
    whatItGives: 'Every resolved governance incident, tamper-evident and WARD-witnessed where applicable, so agents can recall what was blocked or escalated and why.',
    recommendedFor: ['compliance'],
    defaultOn: false,
  },
  {
    sourceType: 'aocl_policy',
    name: 'Policy Decisions',
    description: 'Every governed allow/enforce/reject decision AOCL recorded — the evidence layer, remembered.',
    connector: 'internal',
    requiresConfig: false,
    defaultScope: 'org',
    status: 'live',
    tier: 'evidence',
    sensitivity: 'evidence',
    whatItGives: 'Every governed allow, enforce, or reject decision AOCL recorded, so agents can recall why an action was permitted or blocked.',
    recommendedFor: ['compliance'],
    defaultOn: false,
  },
  {
    sourceType: 'memory',
    name: 'QuoxMemory',
    description: "QuoxMemory's own distilled knowledge — your memories (beliefs/facts/observations) and identity blobs (profile, projects, syntheses, narratives, trends) — the system's own knowledge, fed back into Qortex.",
    connector: 'internal',
    requiresConfig: false,
    defaultScope: 'org',
    status: 'live',
    tier: 'core',
    sensitivity: 'pii',
    whatItGives: "QuoxMemory's own distilled knowledge, your memories and identity blobs, fed back in so agents recall what they already know about you and your org.",
    recommendedFor: ['everyone'],
    defaultOn: false,
  },
  {
    sourceType: 'automemory',
    name: 'Agent Memory Files',
    description: "A directory of curated memory notes (MEMORY.md plus topic .md files, top level only) on this machine, pushed into the Agent Memory vault. Set config.memoryDir to the directory (absolute path); if unset it falls back to the instance owner's Claude auto-memory directory, which only exists on the owner's dev box.",
    connector: 'host',
    requiresConfig: true,
    defaultScope: 'org',
    status: 'live',
    tier: 'core',
    sensitivity: 'none',
    whatItGives: 'Your curated cross-session memory notes, so agents can recall standing decisions and lessons without you repeating them.',
    recommendedFor: ['developer'],
    defaultOn: false,
  },
  {
    sourceType: 'memory_identity_blobs',
    name: 'Identity Blobs',
    description: "The system's own distilled docs by namespace (profile, syntheses, narratives, trends) for a user or org, near-zero transform, one note per (user, namespace).",
    connector: 'internal',
    requiresConfig: false,
    defaultScope: 'org',
    status: 'available',
    tier: 'knowledge',
    sensitivity: 'pii',
    whatItGives: "The system's own distilled profile, project, and synthesis notes for you or your org, so agents start from what's already been learned instead of relearning it.",
    recommendedFor: ['everyone'],
    defaultOn: false,
  },
  {
    sourceType: 'repobrain',
    name: 'Codebase (RepoBrain)',
    description: "Your indexed codebase from RepoBrain: definitions, structure and how the code connects across files and repos.",
    connector: 'internal',
    requiresConfig: false,
    defaultScope: 'org',
    status: 'live',
    tier: 'knowledge',
    sensitivity: 'none',
    whatItGives: "Your codebase as searchable knowledge: what each function does and how the parts connect, so agents can answer questions about your code and cite the source, instead of grepping file by file.",
    recommendedFor: ['developer'],
    defaultOn: false,
  },
  {
    sourceType: 'quoxplan',
    name: 'QuoxPlan',
    description: 'Streams, phases, notes and plan documents from QuoxPlan, the canonical roadmap since the 2026-07-25 cutover.',
    connector: 'internal',
    requiresConfig: false,
    defaultScope: 'org',
    status: 'live',
    tier: 'knowledge',
    sensitivity: 'none',
    whatItGives: 'Every stream, phase, note and plan document from QuoxPlan, so agents can answer "what did we decide" from the roadmap itself instead of it being invisible to them.',
    recommendedFor: ['everyone', 'developer'],
    defaultOn: false,
  },
  {
    sourceType: 'tasks_execution_wisdom',
    name: 'Execution Wisdom',
    description: "The org's generalised operational lessons: pattern, lesson, confidence, and occurrence count, the learned playbook, curated and low-noise.",
    connector: 'internal',
    requiresConfig: false,
    defaultScope: 'org',
    status: 'live',
    tier: 'knowledge',
    sensitivity: 'none',
    whatItGives: 'The org\'s generalised operational lessons, patterns, and confidence scores, so agents can recall what has worked before instead of repeating mistakes.',
    recommendedFor: ['developer'],
    defaultOn: true,
  },
  {
    sourceType: 'memory_memories',
    name: 'Memories',
    description: 'Beliefs, pinned memories, the entity graph, and rolling conversation summaries from QuoxMemory.',
    connector: 'internal',
    requiresConfig: false,
    defaultScope: 'org',
    status: 'available',
    tier: 'knowledge',
    sensitivity: 'pii',
    whatItGives: 'Your beliefs, pinned memories, entity graph, and rolling conversation summaries, so agents can recall who and what matters to you without re-asking.',
    recommendedFor: ['everyone'],
    defaultOn: false,
  },
];

module.exports = { FEED_SOURCE_CATALOG };
