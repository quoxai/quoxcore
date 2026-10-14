/**
 * Platform Capabilities
 *
 * Phase 24 (owner hard rule #setecastronomy, 2026-08-05): NO MORE env-only
 * config. This module is the read-only registry backing GET
 * /api/v1/platform/capabilities and the Platform Capabilities dashboard view
 * (src/pages/views/PlatformCapabilitiesView.jsx). It answers one question for
 * every feature flag that changes product behaviour: what is it, is it on,
 * and where does that value come from.
 *
 * Phase 25 (owner mandate, 2026-08-06, follow-on to #setecastronomy — a
 * read-only capability list is explicitly NOT sufficient): the write path
 * now exists. lib/platformSettingsStore.js persists an org-scoped override
 * per flag and this module's resolveEffectiveCapability() is the ONE shared
 * precedence function every read call site and the settings API funnel
 * through: an org setting beats the env default; an absent or invalid
 * setting falls back to env safely. Every entry below with
 * `classification: 'user'` is settable — that filter (not a separate list)
 * is what lib/platformSettingsStore.js uses to decide what a PATCH may
 * touch.
 *
 * VAULT-INTEG P14 slice 1: settability was boolean-only through Phase 25.
 * `type: 'string' | 'number' | 'enum'` entries are now settable too, when
 * `classification: 'user'` — enum entries additionally declare
 * `allowedValues` (a closed set), number entries may declare `min`/`max`,
 * string entries may declare `maxLength`. validateSettingValue() below is
 * the ONE place that enforces these constraints; both
 * resolveEffectiveCapability() and platformSettingsStore.setOrgSetting()
 * call it rather than re-implementing per-type checks. An entry newly
 * promoted to settable that has not yet had its consuming read site
 * rewired to consult the store carries a `note` field naming that file for
 * P14 slice 2.
 *
 * `requiresRestart: true` on an entry is an honesty marker, not a
 * limitation of the resolver: those three flags (QUOXDREAM_ENABLED,
 * QUOXFEED_ENABLED, QUOXFEED_OAUTH_SOURCES_ENABLED) gate a scheduler's
 * bootstrap or a module-load-time dispatch table, so a live org override is
 * stored, audited and visible immediately, but the process that reads it
 * only checks once at startup. The Settings UI must show this plainly
 * instead of implying the change is instant.
 *
 * `group` sorts the 8 settable entries into the Settings surfaces that
 * already own that territory (privacy, memory, governance, feed) instead of
 * a flat list.
 *
 * The 2026-08-05 env audit found ~356 env vars across docker-compose.yml and
 * services/. The large majority are plumbing (ports, URLs, secrets,
 * timeouts, build/test-only toggles) and are deliberately NOT in CAPABILITIES
 * below — they were excluded at sweep time, not filtered out later. Only
 * vars that gate observable product or operator behaviour are registered
 * here, classified as:
 *   - 'user'     — user-relevant; a future settings surface should let an
 *                  org admin change this without redeploying.
 *   - 'operator' — operator-relevant; visibility only, no near-term settings
 *                  surface planned (security posture, rollout mode, infra
 *                  behaviour switches).
 */

// Defense-in-depth: even though every CAPABILITIES entry below is hand
// picked to exclude credentials, this pattern is checked against every key
// before it is ever serialised, so a credential-shaped var can never reach
// the endpoint even if one is added to the list by mistake later.
const SECRET_NAME_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|_PW$|_PWD$)/i;

function isSecretLike(key) {
  return SECRET_NAME_PATTERN.test(key);
}

// type:
//   'boolean'  — process.env[key] === 'true' means on; anything else is off.
//   'enum'     — a small closed set of string modes; `on` = current value
//                differs from the shipped default (i.e. an operator has
//                moved it off the safe/default posture). Settable when the
//                entry also declares `allowedValues` (VAULT-INTEG P14).
//   'string'   — a free-form settable string value (e.g. an agent id).
//                `on` = current value differs from the shipped default. May
//                declare `maxLength` (VAULT-INTEG P14).
//   'number'   — a settable numeric value. `on` = current value differs
//                from the shipped default. May declare `min`/`max`
//                (VAULT-INTEG P14).
//   'presence' — the var itself may hold sensitive/identifying data (e.g. an
//                org id) that is not a credential but still shouldn't be
//                echoed back verbatim on a visibility surface. Only whether
//                it is set is reported, as a short enum-like word. Never
//                settable — the raw value is deliberately never round-tripped.
const CAPABILITIES = [
  {
    key: 'DEV_SKILLPACK_DISTRIBUTION_POLICY',
    name: 'Skill Pack Distribution Policy',
    description: 'How dev skill-pack sync treats SkillRights declarations (skillrights.org): allow = distribute everything, labels only; require-declaration = refuse packs containing undeclared skills; respect-reserved = refuse cross-org distribution of Reserved-declared skills; require-acceptance = refuse to sync a pack containing any declared skill until an authenticated USER of this org has affirmatively accepted the identified terms for that exact pack content and declared rights (recorded in skill_pack_acceptances, re-required when either changes). A declaration is a stated term, never a technical block; this policy is where the org chooses to honour it. What an acceptance record proves is exactly: this authenticated actor assented to these identified terms before this download was authorized. It does not prove comprehension, ownership or universal enforceability.',
    service: 'collector',
    classification: 'user',
    type: 'enum',
    allowedValues: ['allow', 'require-declaration', 'respect-reserved', 'require-acceptance'],
    default: 'allow',
    group: 'governance',
    note: 'SKILLRIGHTS #478 Phase 9: resolved fresh per sync via configResolver.getSetting(orgId, ...) in the skill-pack-sync route wiring (server.js) and enforced by skillPackInstaller.evaluateDistributionPolicy() before any Bastion call. Phase 11 adds require-acceptance, which evaluateDistributionPolicy cannot decide (it is pure): the sync handler checks skillPackAcceptance.hasCurrentAcceptance() before calling installSkillPack, and refuses with acceptance_required naming the offer endpoint. A service credential can never satisfy it: assent binds a person.',
  },
  {
    // SKILLRIGHTS #478 Phase 14 (sealed execution pilot). The design doc names
    // rate limits as a cloning MITIGATION, never a prevention: a sealed skill
    // is an API with a manifest, so anyone entitled to call it can learn what
    // it does by calling it. This knob decides how fast, not whether.
    key: 'SEALED_INVOKE_RATE_PER_HOUR',
    name: 'Sealed Skill Invocations (per hour)',
    description: 'How many times one sealed skill may be invoked by an org in a rolling hour before further calls are refused with sealed_rate_limited. A sealed invocation is a real LLM run, so this is a cost control as well as a behavioural-cloning mitigation. It slows cloning; it never prevents it.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '30',
    min: 1,
    max: 10000,
    group: 'governance',
    note: 'SKILLRIGHTS #478 Phase 14: resolved fresh per invocation via configResolver.getSetting(orgId, ...) in the POST /api/v1/skills/sealed/:sealedId/invoke route wiring (server.js), counted against sealed_invocations rows from the last hour, INCLUDING calls still in flight (reserved with status pending before the run). Takes effect on the next call, no restart needed.',
  },
  {
    // ASTRA audit round 3 (2026-09-11), finding 9. The per-skill limit above
    // handed every NEW sealed skill a fresh quota, so an org could multiply
    // its budget by creating skills. This is the ceiling across all of them,
    // which is what the design doc's "rate-limited per org" always meant.
    key: 'SEALED_INVOKE_ORG_RATE_PER_HOUR',
    name: 'Sealed Skill Invocations, whole org (per hour)',
    description: 'How many sealed invocations an org may make in a rolling hour across ALL of its sealed skills, before further calls are refused with sealed_rate_limited. Sits above the per-skill limit: whichever bites first refuses the call. A sealed invocation is a real LLM run, so this is the org-wide cost ceiling as well as a behavioural-cloning mitigation. It slows cloning; it never prevents it.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '100',
    min: 1,
    max: 100000,
    group: 'governance',
    note: 'ASTRA audit round 3 finding 9: resolved fresh per invocation via configResolver.getSetting(orgId, ...) in the POST /api/v1/skills/sealed/:sealedId/invoke route wiring (server.js), counted against every sealed_invocations row for the org from the last hour, including in-flight reservations. Takes effect on the next call, no restart needed.',
  },
  {
    // SKILLRIGHTS #478 Phase 8: the org declaring its own default terms for
    // skills it authors. Stamped into the record AT CREATION by the
    // skill_manage(create) tool executor (lib/agentTools.js); NEVER applied
    // retroactively, so changing this setting rewrites nothing. Explicit
    // per-skill licences always win. Empty = new skills stay undeclared,
    // which is the honest default.
    key: 'QSKL_DEFAULT_SKILL_LICENSE',
    name: 'Default Skill Licence',
    description: 'SkillRights licence identifier (skillrights.org) stamped onto newly created org skills that carry no explicit declaration, e.g. LicenseRef-SkillRights-NoTrain-1.0. Recorded verbatim at creation time and never applied retroactively to existing skills. Leave empty to keep new skills undeclared.',
    service: 'collector',
    classification: 'user',
    type: 'string',
    default: '',
    group: 'governance',
    note: 'SKILLRIGHTS #478 Phase 8: resolved fresh per creation via configResolver.getSetting(orgId, ...) in the skill_manage(create) executor. Unknown identifiers pass through verbatim by design; a validated allowlist would block custom licences.',
  },
  {
    // QUOX-CLAUDE-3 (quox#672): which Discord users may run slot control
    // commands (!compact) from a slot's channel. Empty = the Discord path is
    // denied entirely. Human org owners/admins can always use the CLI path.
    key: 'QUOX_SLOT_CONTROL_DISCORD_IDS',
    name: 'Slot Control: Allowed Discord User IDs',
    description: 'Comma-separated Discord user IDs allowed to send session control commands (such as !compact) from a slot channel. Leave empty to deny the Discord control path.',
    service: 'collector',
    classification: 'user',
    type: 'string',
    default: '',
    maxLength: 512,
    group: 'governance',
    note: 'QUOX-CLAUDE-3: resolved fresh per request in POST /api/v1/slots/:name/control via platformSettingsStore.getEffectiveFlag. Authority is server-side only.',
  },
  {
    // QUOX-CLAUDE-3 (quox#672): which Discord users may run slot control
    // commands (!compact) from a slot's channel. Empty = the Discord path is
    // denied entirely. Human org owners/admins can always use the CLI path.
    key: 'QUOX_SLOT_CONTROL_RELAY_IDS',
    name: 'Slot Control: Relay IDs',
    description: 'Comma-separated MCP token IDs (identifiers, not secrets) that may relay an allowlisted Discord user session control command, such as the Discord daemon token. Every other MCP token is refused as an agent. Leave empty to deny relays.',
    service: 'collector',
    classification: 'user',
    type: 'string',
    default: '',
    maxLength: 512,
    group: 'governance',
    note: 'QUOX-CLAUDE-3: resolved fresh per request in POST /api/v1/slots/:name/control via platformSettingsStore.getEffectiveFlag. Authority is server-side only.',
  },
  {
    key: 'AGH_CHAIN_ENABLED',
    name: 'Honesty Ledger (AGH-Chain)',
    description: 'Runs the four AGH-Chain guards on every agent response, rewriting unverifiable promise/claim language before it reaches the user.',
    service: 'collector',
    classification: 'user',
    type: 'boolean',
    default: 'false',
    group: 'governance',
  },
  {
    key: 'QM_LTM_ENABLED',
    name: 'Long-Term Memory Recall',
    description: 'Best-effort recall of past conversations injected into chat context (QM-LTM). Needs Qdrant and an embedding key to be useful.',
    service: 'collector',
    classification: 'user',
    type: 'boolean',
    default: 'false',
    group: 'memory',
  },
  {
    // quox#508: the mining scheduler ran unconditionally from boot with no
    // off-switch, so a collector wedged by mining load could not be
    // restarted without re-arming the identical load. This is the
    // settings-surfaced off-switch (no-env-only-config rule); the env var
    // of the same name remains the operator-layer default override.
    key: 'REFLECTION_MINING_ENABLED',
    name: 'AEE Conversation Mining',
    description: 'Server-side reflection mining of this org’s completed conversations: memory/entity extraction, pattern detection and proactive alerts. Turning it off stops mining for this org at the next cycle.',
    service: 'collector',
    classification: 'user',
    type: 'boolean',
    default: 'true',
    // Kill-flag semantics: default-ON with no env var set; only the literal
    // string 'false' in env turns the instance default off. Without this, a
    // plain boolean is on only when env is literally 'true' — the first live
    // tick after shipping read every org as OFF because nothing sets the
    // env var (caught by the live drive, 2026-09-03).
    offOnlyWhen: 'false',
    group: 'memory',
  },
  {
    // BRAIN2-V3 B4: promoted from 'operator' (visibility only). The enforcing
    // read (lib/brainImplant.js isImplantEnabled, wired in server.js chat
    // dispatch) now consults the stored org setting first; env stays the
    // fallback. QUOXBRAIN_IMPLANT_ORGS (operator allowlist) still narrows it.
    key: 'QUOXBRAIN_IMPLANT_ENABLED',
    name: 'QuoxBrain Knowledge Implant',
    description: 'Injects QuoxBrain [KNOWLEDGE CONTEXT] into agent prompts for this org. Qortex passages are sent to the chat model when on.',
    service: 'collector',
    classification: 'user',
    type: 'boolean',
    default: 'false',
    group: 'brain2',
    note: 'BRAIN2-V3 B4: resolved fresh per chat turn via platformSettingsStore.getEffectiveFlag in server.js, passed to lib/brainImplant.js buildBrainImplant. A stored setting wins over the env default; QUOXBRAIN_IMPLANT_ORGS still narrows the rollout.',
  },
  {
    // NotesQ org settings (AQ-9D). Group 'notesq' renders on Settings > NotesQ
    // via PlatformFlagsPanel. Each key is enforced at a real read site.
    key: 'NOTESQ_AUTOSAVE_MS',
    name: 'NotesQ Autosave Delay (ms)',
    description: 'How long the NotesQ editor waits after you stop typing before it saves. Lower is quicker but writes more revisions; higher batches more typing into each save.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '1500',
    min: 500,
    max: 30000,
    group: 'notesq',
    note: 'Enforced in the browser: src/components/notesq/NotesQEditor.jsx reads the effective value once per NotesQ view mount (platformFlagsClient) and falls back to 1500 on any error. Takes effect the next time the NotesQ view is opened.',
  },
  {
    key: 'NOTESQ_DEFAULT_COLLECTION',
    name: 'NotesQ Default Collection',
    description: 'Collection that new notes are filed into when none is chosen. Leave empty for no default collection.',
    service: 'collector',
    classification: 'user',
    type: 'string',
    default: '',
    maxLength: 120,
    group: 'notesq',
    note: 'Enforced in two places: NotesQView create() (when no collection filter is active) and the collector tool notesq_create in lib/notesqTools.js (when the agent names no collection), via configResolver.getSetting(orgId, ...). An explicit collection always wins.',
  },
  {
    key: 'NOTESQ_AGENT_EDIT_POLICY',
    name: 'NotesQ Agent Edit Policy',
    description: 'Whether the NotesQ agent may change notes. direct: it edits when you ask it to (every edit is a revision you can restore). propose: an agent change it makes on its own arrives in Approvals as a diff and runs only when a human approves (when you ask it directly in your own chat, your request is the approval; a delete always asks). read_only: the agent can search and read notes but every create, edit, tag, restore and delete is refused.',
    service: 'collector',
    classification: 'user',
    type: 'enum',
    allowedValues: ['direct', 'propose', 'read_only'],
    default: 'direct',
    group: 'notesq',
    note: 'Enforced in lib/notesqTools.js: when read_only, notesq_create, notesq_update, notesq_tag, notesq_restore and notesq_delete refuse before any brain call; read tools are unaffected. When propose, the same write tools file an Approvals card through lib/approvalGate.js (ctx._notesqPropose, diff built by lib/notesq/diff.js) and run on approval via the resume path; a direct request from the person asking skips the card (delete excepted).',
  },
  {
    key: 'BRAIN_GARDENER_ENABLED',
    name: 'Brain Gardener',
    description: 'Once a day the brain looks through each person\'s own private notes for exact or near-identical duplicates and long-untouched notes, and proposes archiving them. Every proposal arrives in Approvals and nothing is archived until a person approves it. Archiving only sets the note\'s archived flag (restorable in NotesQ); notes are never deleted. Off by default.',
    service: 'collector',
    classification: 'user',
    type: 'boolean',
    default: 'false',
    group: 'memory',
    note: 'Enforced in lib/brainGardenerScheduler.js: the daily tick only visits orgs holding a STORED override of true (server.js lists them from org_platform_settings), so the env default alone never enables it. At most 5 proposals per person per day, none repeated within 30 days; title-only duplicates and broken links are never proposed.',
  },
  {
    key: 'NOTESQ_REVISION_RETENTION',
    name: 'NotesQ Revision Retention',
    description: 'How many recent revisions to keep per note. 0 keeps every revision. When set, older revisions are pruned as you save; the first revision is always kept.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '0',
    min: 0,
    max: 10000,
    group: 'notesq',
    note: 'Enforced in services/quoxbrain/lib/notesq.js pruneRevisions(), run after each successful create, update and restore revision write. Read per org via the quoxbrain configResolver getSetting (a stored override only; env and default mean keep everything). Rev 1 is never pruned (delete authority reads its author). Any lookup error keeps everything.',
  },
  {
    // VAULT-INTEG P17: promoted from classification 'operator' (visibility
    // only) — the actual enforcing read (services/quoxbrain, a separate
    // process from this collector) now resolves a stored per-org override
    // via configResolver.getSetting(), see the note below.
    key: 'QUOXBRAIN_HYBRID_ENABLED',
    name: 'QuoxBrain Hybrid Retrieval',
    description: 'Blends keyword and vector retrieval for QuoxBrain queries instead of vector-only.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'boolean',
    default: 'false',
    group: 'memory',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via services/quoxbrain/lib/configResolver.js getSetting(orgId, ...) — quoxbrain is a separate process/db from this collector, so it resolves the already-precedence-applied value over the same service-to-service HTTP convention as quox#524\'s dreamScheduler.js (X-Service-Key/X-Org-Id). Rewired call sites: services/quoxbrain/lib/contextAssembler.js isHybridEnabled() (assembleContext(), i.e. POST /brain/context) and services/quoxbrain/server.js POST /brain/search — both resolved fresh per request, no restart needed.',
  },
  {
    // VAULT-INTEG P17: promoted from classification 'operator' — same
    // rationale as QUOXBRAIN_HYBRID_ENABLED above.
    key: 'QUOXBRAIN_EMBED_BACKFILL_ENABLED',
    name: 'QuoxBrain Embedding Backfill',
    description: 'Runs the background job that backfills missing QuoxBrain embeddings.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'boolean',
    default: 'false',
    group: 'memory',
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next QuoxBrain service restart onward.',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via services/quoxbrain/lib/configResolver.js getInstanceSetting() (instance-wide — one scheduler per quoxbrain process, not a per-org policy) in services/quoxbrain/lib/embeddingBackfillScheduler.js startEmbeddingBackfillScheduler(). Read once, at scheduler-start call time, and gates whether the scheduler\'s setInterval is created at all — a stored override is honoured from the next quoxbrain service restart onward.',
  },
  // ─── BRAIN2-V3 B4: Qortex tuning + privacy knobs. All resolved in
  // services/quoxbrain via lib/brainConfig.js (configResolver.getSetting,
  // org-scoped, stored setting > quoxbrain env > default). The collector
  // does not carry the QUOXBRAIN_* env, so the 'env default' this registry
  // reports is the registry default; quoxbrain's own GET /brain/egress
  // reports the true env-vs-default source and the Qortex settings panel
  // prefers it. ───
  {
    key: 'BRAIN_CITATION_ENTAIL_CAP',
    name: 'Qortex Citation Check: Claims Checked per Answer',
    description: 'How many cited claims in one answer get the semantic (entailment) support check. Claims beyond this are shown as unchecked, never as unsupported. 1 to 25.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '12',
    min: 1,
    max: 25,
    group: 'brain2',
    note: 'Resolved per answer via configResolver.getInstanceSetting in lib/brainCitationTrace.js finalizeEntry; no restart needed.',
  },
  {
    key: 'QUOXBRAIN_MIN_COVERAGE',
    name: 'Qortex Abstention: Minimum Term Coverage',
    description: 'Fraction (0 to 1) of a query\'s content words that must appear in the top passages before Qortex answers. Below it, and without a strong semantic match, Qortex abstains instead of returning weak hits.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '0.5',
    min: 0,
    max: 1,
    group: 'brain2',
    note: 'BRAIN2-V3 B4: resolved per request in quoxbrain contextAssembler.resolveOrgRetrievalConfig (brainConfig.resolveRelevanceThresholds), no restart needed.',
  },
  {
    key: 'QUOXBRAIN_MIN_DENSE_COSINE',
    name: 'Qortex Abstention: Minimum Semantic Match',
    description: 'Cosine similarity (0 to 1) of the best semantic hit that rescues a query with low keyword coverage. Uncalibrated default 0.6 on Gemini embeddings.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '0.6',
    min: 0,
    max: 1,
    group: 'brain2',
    note: 'BRAIN2-V3 B4: same read site as QUOXBRAIN_MIN_COVERAGE.',
  },
  {
    key: 'QUOXBRAIN_MIN_DENSE_FLOOR',
    name: 'Qortex Abstention: Semantic Floor',
    description: 'When semantic search ran, a best-hit cosine below this (0 to 1) means nothing in the brain is about the question, however many query words match. Default 0.45.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '0.45',
    min: 0,
    max: 1,
    group: 'brain2',
    note: 'BRAIN2-V3 B4: same read site as QUOXBRAIN_MIN_COVERAGE.',
  },
  {
    key: 'QUOXBRAIN_MIN_DENSE_COSINE_LARGE',
    name: 'Qortex Abstention: Minimum Semantic Match (large embeddings)',
    description: 'Same as the minimum semantic match, applied when search ran on text-embedding-3-large embeddings. Default 0.6.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '0.6',
    min: 0,
    max: 1,
    group: 'brain2',
    note: 'BRAIN2-W11 C: used instead of the unsuffixed key when the dense leg ran in the text-embedding-3-large@768 space; same read site as QUOXBRAIN_MIN_COVERAGE.',
  },
  {
    key: 'QUOXBRAIN_MIN_DENSE_FLOOR_LARGE',
    name: 'Qortex Abstention: Semantic Floor (large embeddings)',
    description: 'Same as the semantic floor, applied when search ran on text-embedding-3-large embeddings. Default 0.472 (calibrated on the held-out set for this model).',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '0.472',
    min: 0,
    max: 1,
    group: 'brain2',
    note: 'BRAIN2-W11 C: used instead of the unsuffixed key when the dense leg ran in the text-embedding-3-large@768 space; same read site as QUOXBRAIN_MIN_COVERAGE.',
  },
  {
    key: 'QUOXBRAIN_QUERY_EMBED_TIMEOUT_MS',
    name: 'Qortex Query Embed Timeout',
    description: 'How long, in ms, an interactive Qortex search waits for the query embedding before falling back to keyword search for that request. Default 1500ms.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '1500',
    min: 200,
    max: 4000,
    group: 'brain2',
    note: 'BRAIN2-V3 B4: resolved per request in quoxbrain (brainConfig.resolveQueryEmbedTimeout); a per-call header from agent/CLI callers still overrides it.',
  },
  {
    key: 'QUOXDREAM_ALLOW_LLM_TEXT',
    name: 'Allow Consolidation to Send Note Text to the LLM',
    description: 'QuoxDream consolidation extracts beliefs by sending note text to the chat model. Turn this off to stop that for this org: consolidation is then skipped for the org, not degraded. Default on (current behaviour).',
    service: 'quoxbrain',
    classification: 'user',
    type: 'boolean',
    default: 'true',
    offOnlyWhen: 'false',
    group: 'brain2',
    note: 'BRAIN2-V3 B4: resolved every scheduler tick in quoxbrain lib/dreamScheduler.js (brainConfig.resolveDreamLlmAllowed), so a change applies without a restart. Only meaningful when QuoxDream is enabled for the org.',
  },
  {
    key: 'BRAIN_RERANK_ENABLED',
    name: 'AI Reranking of Search Results',
    description: 'Off by default. When on, the top search results (up to 20 passages, each cut to about 800 characters) are sent to OpenAI to be re-ordered by relevance. Results are marked AI-reranked. If the model is slow or fails, the normal order is kept.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'boolean',
    default: 'false',
    group: 'brain2',
    note: 'BRAIN2-W11 B: resolved per request in quoxbrain (brainConfig.resolveRerankEnabled); fails closed (no rerank) if the setting cannot be read. Calls the collector POST /internal/rerank, which calls OpenAI chat completions directly with the organisation OpenAI key (BRAIN2-W12 D).',
  },
  {
    key: 'BRAIN_EXPAND_ENABLED',
    name: 'AI Query Expansion',
    description: 'Off by default. When on, your search query text is sent to OpenAI to write a few paraphrases and a short guessed answer, which are searched alongside the original. Measured to help some queries and hurt others, so it is a separate choice from reranking. If the model is slow or fails, the normal search runs.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'boolean',
    default: 'false',
    group: 'brain2',
    note: 'BRAIN2-W13 D: resolved per request in quoxbrain (brainConfig.resolveExpandEnabled); fails closed. Independent of BRAIN_RERANK_ENABLED. Calls the collector POST /internal/expand.',
  },
  {
    key: 'BRAIN_RERANK_MODEL',
    name: 'AI Reranking Model',
    description: 'OpenAI chat model used for AI reranking of search results. Leave empty to use gpt-4o-mini. Needs an OpenAI key for your organisation; without one, or if the model is slow, the normal order is kept.',
    service: 'collector',
    classification: 'user',
    type: 'string',
    default: '',
    maxLength: 64,
    group: 'brain2',
    note: 'BRAIN2-W12 C: read per call in server.js /internal/rerank via configResolver.getSetting(orgId, ...) and used by lib/rerankCompletion.js. Empty (or a non-OpenAI name) means gpt-4o-mini.',
  },
  {
    key: 'QUOXBRAIN_EMBED_EXCLUDE_VAULTS',
    name: 'Exclude Sources from Embedding',
    description: 'Comma-separated vault names or ids whose text is never sent to the embedding provider. The embedding backfill skips them and search uses keyword matching only for them. Enter a single - to exclude nothing.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'string',
    default: '',
    maxLength: 512,
    group: 'brain2',
    note: 'BRAIN2-V3 B4: read by quoxbrain lib/embeddingBackfill.js (per run) and contextAssembler dense leg (per request) via brainConfig.resolveEmbedExclusions. Vectors written before an exclusion was set are hidden from search but not deleted.',
  },
  {
    key: 'QUOXDREAM_ENABLED',
    name: 'QuoxDream',
    description: 'Runs the offline memory-consolidation cycle that reviews and summarises recent memory.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'boolean',
    default: 'false',
    group: 'memory',
    // quox#524: the quoxbrain service is a separate process with its own
    // database — it does not open the org_platform_settings table
    // (platformSettingsStore.js) that this org override is stored in.
    // dreamScheduler.js's startDreamScheduler() resolves the override
    // per-org at process boot via an internal HTTP call to THIS collector's
    // own GET /api/v1/platform/settings/flags (fetchDreamEnabledOverride,
    // over X-Service-Key/X-Org-Id — falls back to the env default if the
    // lookup fails or no override is stored), then only creates its
    // setInterval once. The override is genuinely honoured, but only as of
    // the next quoxbrain restart — it does not flip a running scheduler on
    // or off live. The Settings UI must say this plainly, not imply it is
    // live.
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next QuoxBrain service restart onward.',
  },
  {
    key: 'QUOXDREAM_SEMANTIC_DEDUP',
    name: 'QuoxDream Semantic Dedup',
    description: 'During a QuoxDream cycle, merges semantically duplicate memories instead of keeping every near-identical entry.',
    service: 'quoxbrain',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
  },
  {
    key: 'QUOXFEED_ENABLED',
    name: 'The Feed (autopilot ingestion)',
    description: 'Runs the collector-side autopilot scheduler that feeds QuoxBrain from configured sources.',
    service: 'collector',
    classification: 'user',
    type: 'boolean',
    default: 'false',
    group: 'feed',
    // quox#524: startFeedScheduler() (lib/feedScheduler.js) resolves the
    // stored override per configured org (via isFeedEnabledFn ->
    // platformSettingsStore.getEffectiveFlag(), server.js) before deciding
    // whether to create its setInterval, but only does so once, at process
    // boot. An org's override is genuinely honoured, but only as of the
    // next collector service restart — it does not start or stop an
    // already-running scheduler live.
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next collector service restart onward.',
  },
  {
    key: 'QUOXFEED_QUOXPLAN_ORG',
    name: 'The Feed: QuoxPlan Source Org Gate',
    description: 'Restricts the QuoxPlan feed source to a single designated org. Unset means no org restriction is applied.',
    service: 'collector',
    classification: 'operator',
    type: 'presence',
    default: 'unrestricted',
    onValue: 'restricted',
    offValue: 'unrestricted',
  },
  {
    key: 'QUOXFEED_OAUTH_SOURCES_ENABLED',
    name: 'The Feed: OAuth Sources',
    description: 'Allows OAuth-connected sources (beyond static/manual sources) to feed The Feed ingestion pipeline.',
    service: 'collector',
    classification: 'user',
    type: 'boolean',
    default: 'false',
    group: 'feed',
    // quox#524: the exported SOURCE_INGESTERS catalog constant in
    // lib/feedScheduler.js (feedApiHandlers.js's catalog 'live' status)
    // stays env-only by design — see that constant's own comment. The
    // scheduler's OWN dispatch map (resolveSourceIngesters(), consulted via
    // isOauthSourcesEnabledFn -> getEffectiveFlag() in server.js) DOES honour
    // a stored per-org override, resolved once at process boot alongside
    // QUOXFEED_ENABLED above. Honoured from the next collector restart
    // onward, not live against an already-running scheduler.
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next collector service restart onward.',
  },
  {
    key: 'RESPONSE_CONTRACT_ENABLED',
    name: 'Response Contract Enforcement',
    description: 'Enforces the structured response contract on agent output before it is returned to the caller.',
    service: 'collector',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
  },
  {
    key: 'HITL_SLA_ALLOW_AUTO_APPROVE',
    name: 'HITL SLA Auto-Approve',
    description: 'Allows a pending human-in-the-loop approval to auto-approve itself once its SLA window expires, instead of staying pending indefinitely.',
    service: 'collector',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
  },
  {
    key: 'QUOXFLOW_APPROVAL_ENABLED',
    name: 'QuoxFlow Approval Gate',
    description: 'Routes destructive tool operations through the QuoxFlow policy engine for approval before execution.',
    service: 'collector',
    classification: 'user',
    type: 'boolean',
    default: 'true',
    group: 'governance',
  },
  {
    key: 'QUOXFLOW_AUTH_ENABLED',
    name: 'QuoxFlow Auth Enforcement',
    description: 'Requires an authenticated caller for QuoxFlow API requests.',
    service: 'quoxflow',
    classification: 'operator',
    type: 'boolean',
    default: 'true',
  },
  {
    key: 'MCP_TOOLS_ENABLED',
    name: 'MCP Tool Selection',
    description: 'Lets Claude drive tool selection via the QuoxMCP server instead of the collector picking tools directly.',
    service: 'collector',
    classification: 'operator',
    type: 'boolean',
    default: 'true',
  },
  {
    key: 'ENABLE_CODE_EXEC_TOOLS',
    name: 'Sandbox Code Execution Tool',
    description: 'Exposes the toolsmith.runScript tool, letting agents execute arbitrary sandboxed scripts.',
    service: 'collector',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
  },
  {
    // VAULT-INTEG P14 slice 1: promoted from classification 'operator' to
    // 'user' with a declared closed set (allowedValues), making it the
    // first settable non-boolean entry alongside AOCL_L8_MODE below.
    key: 'AOCL_L1_MODE',
    name: 'AOCL Layer 1 Mode',
    description: 'Identity layer processing mode for the AOCL pipeline: observe (log only) or enforce.',
    service: 'collector',
    classification: 'user',
    type: 'enum',
    allowedValues: ['observe', 'enforce'],
    default: 'observe',
    group: 'governance',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via configResolver.getSetting(orgId, ...) in services/collector/lib/identityLayer.js getMode(aoclCtx.orgId), called fresh on every enforceIdentity() call.',
  },
  {
    key: 'AOCL_L8_MODE',
    name: 'AOCL Layer 8 Mode',
    description: 'Verification layer mode for the AOCL pipeline: enforce (block on failure) or warn (log only).',
    service: 'collector',
    classification: 'user',
    type: 'enum',
    allowedValues: ['enforce', 'warn'],
    default: 'enforce',
    group: 'governance',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via configResolver.getSetting(orgId, ...) in services/collector/lib/l8VerifyCheck.js runL8() and services/collector/lib/aoclPipeline.js runPostLLMPipeline(), both org-scoped via aoclCtx.orgId, called fresh on every call.',
  },
  {
    key: 'AOCL_STACK_MODE',
    name: 'AOCL Stack Dispatch Mode',
    description: 'Selects which chat pipeline is authoritative: legacy, shadow (legacy authoritative + new stack in parallel for parity metrics), or stack.',
    service: 'collector',
    classification: 'operator',
    type: 'enum',
    default: 'stack',
  },
  {
    key: 'AOCL_STACK_REQUIRE_PARITY',
    name: 'AOCL Stack Parity Gate',
    description: 'Requires the new chat stack pipeline to match legacy output before being trusted for dispatch.',
    service: 'collector',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
  },
  {
    key: 'LICENSE_GATE_MODE',
    name: 'License Gate Mode',
    description: 'Controls how premium-license checks behave: disabled (always licensed), enforce (rollout-list based, fail-open outside it), or fail-closed (always checked, unreachable auth treated as unlicensed).',
    service: 'tasks',
    classification: 'operator',
    type: 'enum',
    default: 'enforce',
  },
  {
    key: 'DEV_LOGIN_ENABLED',
    name: 'Dev Login Bypass',
    description: 'Allows the developer-only login shortcut that skips normal credential checks. Should never be on in production.',
    service: 'auth',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
  },
  {
    key: 'WS_ALLOW_UNAUTHENTICATED',
    name: 'Unauthenticated WebSocket Terminal',
    description: 'Allows the /terminal/ws websocket (backed by a real PTY) to accept connections without authentication. Should never be on in production.',
    service: 'collector',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
  },
  {
    key: 'AEE_ENDPOINT_AUTH_ENFORCE',
    name: 'AEE Endpoint Auth Enforcement',
    description: 'Requires authentication on AEE protocol endpoints. Off by default during the AEE rollout window.',
    service: 'collector',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
    // QUOXIDENTITY P4 §2 (finding G1): grouped with its sibling posture flag
    // COLLECTOR_AUTH_ENFORCE so both security-posture enforcement gates sort
    // together on the Platform Capabilities surface. Visibility-only fix —
    // the default stays OFF; flipping it is an owner decision (P4 contract).
    group: 'security-posture',
  },
  {
    key: 'DISABLE_TRANSCRIPT_STORAGE',
    name: 'Transcript Storage Opt-Out',
    description: 'When on, durable storage of chat transcripts and other content-bearing envelopes is disabled (privacy toggle). Content-free execution receipts (which tool ran, by which agent, success/failure, cryptographic action commitment — never message content or tool arguments) are ALWAYS stored and witnessed; this toggle cannot erase the fact of an execution. When off (default), everything is stored.',
    service: 'collector',
    classification: 'user',
    type: 'boolean',
    default: 'false',
    group: 'privacy',
  },
  {
    key: 'WARD_TSA_DISABLED',
    name: 'WARD Timestamp Authority',
    description: 'When on, disables the external Time-Stamping Authority call WARD uses to timestamp evidence.',
    service: 'ward',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
  },
  {
    key: 'MONITOR_LOOP_DISABLED',
    name: 'Screencap Monitor Loop',
    description: 'When on, disables the screencap service background monitor loop.',
    service: 'screencap',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
  },
  {
    key: 'QUOX_CONTENT_CAPTURE_ENABLED',
    name: 'Content Capture (full text)',
    description: 'Captures full redacted plaintext into volt_content. When off (default), only a hash of content is captured.',
    service: 'collector',
    classification: 'user',
    type: 'boolean',
    default: 'false',
    group: 'privacy',
  },
  {
    key: 'QUOX_SERVER_SELFKNOWLEDGE_ENABLED',
    name: 'Server Self-Knowledge Implant',
    description: 'Injects Quox self-knowledge context (what Quox is, its own architecture) into agent prompts. On by default.',
    service: 'collector',
    classification: 'operator',
    type: 'boolean',
    default: 'true',
    // Kill-flag: only the literal string 'false' turns it off, any other
    // value (including unset) is treated as on.
    offOnlyWhen: 'false',
  },
  {
    key: 'BASTION_ENABLED',
    name: 'Bastion Setup Readiness',
    description: 'Marks the Bastion SSH fleet-access tool as configured for onboarding/setup-readiness checks.',
    service: 'auth',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
  },
  {
    key: 'GOVERNANCE_BOOTSTRAP',
    name: 'Governance Bootstrap Bypass',
    description: 'Permits tool-catalog installs to proceed when the governance_policies table is absent, for first-run bootstrap only.',
    service: 'auth',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
  },

  // ─── Phase 24 env audit (2026-08-08), Section 3 — new candidates ────────
  // NOTE on QUOXFLOW_ALLOWED_PRIVATE / SCREENCAP_ALLOWED_PRIVATE: the audit
  // doc proposed these as settable booleans. Verified against the actual
  // read call sites (quoxflow src/executors/call.executor.ts,
  // services/screencap/lib/browserObjective.js) — both are comma-separated
  // CIDR/host allowlists, not `=== 'true'` boolean checks. Registering a
  // non-boolean var as classification 'user' is exactly the governance-
  // theater failure mode this file's own resolver comment warns against
  // (resolveEffectiveCapability only trusts type:'boolean' overrides), so
  // both are registered here as 'operator' (visibility only), type
  // 'presence', not settable. Real settability would need the resolver
  // extended for list-shaped values — out of scope for this pass.
  {
    key: 'VITE_POLICY_GATE_FAIL_OPEN',
    name: 'Policy Gate Fail-Open on Error',
    description: 'Whether the client-side policy gate fails open (allow) or closed (deny) when a policy check errors. Compiled into the frontend build at Vite build time; not currently editable without a redeploy.',
    service: 'dashboard',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
    group: 'governance',
  },
  {
    key: 'QUOXFLOW_ALLOWED_PRIVATE',
    name: 'Workflows: Allow Private Network Targets',
    description: 'Comma-separated CIDR/host allowlist letting QuoxFlow HTTP/browser nodes target private/internal IP ranges (SSRF guard opt-in). Not a boolean flag and not yet wired to the settings store.',
    service: 'quoxflow',
    classification: 'operator',
    type: 'presence',
    default: 'blocked',
    onValue: 'allowlisted',
    offValue: 'blocked',
    group: 'security-posture',
  },
  {
    key: 'SCREENCAP_ALLOWED_PRIVATE',
    name: 'Screen Capture: Allow Private Network Targets',
    description: 'Comma-separated CIDR/host allowlist letting the screenshot-capture service target private/internal IP ranges (same SSRF-guard pattern as QuoxFlow). Not a boolean flag and not yet wired to the settings store.',
    service: 'screencap',
    classification: 'operator',
    type: 'presence',
    default: 'blocked',
    onValue: 'allowlisted',
    offValue: 'blocked',
    group: 'security-posture',
  },
  {
    key: 'VITE_AGENTIC_BROWSER_Q',
    name: 'Browser-Q (Agentic Browsing)',
    description: 'Frontend build-time flag gating the entire Browser-Q agentic-browsing surface. Compiled into the frontend build, not currently editable without a redeploy.',
    service: 'dashboard',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
  },
  {
    key: 'VITE_BASTION_ENABLED',
    name: 'Bastion / Fleet UI Section',
    description: 'Frontend build-time flag gating the whole Bastion/fleet UI section. Different variable from BASTION_ENABLED (backend onboarding-readiness marker, also in this registry) — compiled into the frontend build, not currently editable without a redeploy.',
    service: 'dashboard',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
  },
  {
    key: 'VITE_DEMO_MODE',
    name: 'Demo Mode',
    description: 'Toggles whole-product demo-mode behaviour (seeded data, demo banner, restricted write paths). Compiled into the frontend build, not currently editable without a redeploy.',
    service: 'dashboard',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
    group: 'demo',
  },
  {
    // VAULT-INTEG P14 slice 1: promoted from type 'presence' (visibility
    // only) to 'number' (genuinely settable) — the underlying env var was
    // always a plain hour count, never a value that needed to be hidden.
    key: 'SCREENCAP_SCHEDULE_HOURS',
    name: 'Screen Capture Schedule (hours)',
    description: 'Cadence, in hours, for the automated screenshot capture job. 0 means no schedule is configured.',
    service: 'screencap',
    classification: 'user',
    type: 'number',
    default: '0',
    min: 0,
    max: 168,
    group: 'screencap',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved. Consuming read site (services/screencap/server.js startScheduler(), a separate process) now resolves via services/screencap/lib/scheduleConfig.js resolveScheduleHours(), which calls collector\'s own settings API over services/screencap/lib/configResolver.js (screencap has no local voltDb) — mirrors quoxbrain\'s dreamScheduler.js/configResolver.js HTTP-seam pattern. Resolved once at startScheduler() call time (still process boot); a stored override is honoured from this service\'s next restart onward.',
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next screencap service restart onward (the value only ever feeds the one setTimeout/setInterval pair created at that service\'s boot).',
  },
  {
    key: 'BROWSER_Q_SCREENSHOT_EXPIRY_DAYS',
    name: 'Browser-Q Screenshot Retention (days)',
    description: 'How many days Browser-Q screenshots are retained before expiry. Defaults to 30 days. Not yet wired to the settings store.',
    service: 'screencap',
    classification: 'operator',
    type: 'presence',
    default: '30-days',
    onValue: 'custom',
    offValue: '30-days',
    group: 'privacy',
  },
  {
    // VAULT-INTEG P14 slice 1: promoted to settable and re-typed 'string'
    // (not 'enum') — the actual read site accepts any agent id, not a
    // closed set, so an 'enum' shape would either reject valid agent ids or
    // need an allowedValues list that goes stale as agents are added.
    key: 'TELEGRAM_DEFAULT_AGENT',
    name: 'Telegram: Default Responding Agent',
    description: 'Which agent answers an inbound Telegram DM when no other routing rule matches. Defaults to "quox".',
    service: 'collector',
    classification: 'user',
    type: 'string',
    default: 'quox',
    maxLength: 64,
    group: 'integrations',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via configResolver.getInstanceSetting() in services/collector/lib/telegramWebhook.js getWebhookConfig(), in the last-resort branch only (no org is known yet at that point — the vault-first path above it, resolved per-org via the auth service, remains authoritative whenever it is reachable).',
  },
  {
    // VAULT-INTEG P14 slice 1: promoted from classification 'operator' with
    // a declared closed set (allowedValues) matching the two providers the
    // consuming code actually understands.
    key: 'QUOXCHAT_EMBED_PROVIDER',
    name: 'QuoxChat Widget: LLM Provider',
    description: 'Which LLM provider embedText() tries FIRST for the RAG embedding pipeline (falls through to the other provider when the preferred one has no key). Defaults to "openai".',
    service: 'collector',
    classification: 'user',
    type: 'enum',
    allowedValues: ['openai', 'gemini'],
    default: 'openai',
    group: 'integrations',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via configResolver.getSetting(orgId, ...)/getInstanceSetting() in services/collector/routes/quoxchat.js embedText() and services/collector/lib/internalEmbedHandler.js, org-scoped wherever the caller has resolved a widget/request org. Default corrected from the stale \'gemini\' (P14 slice 1) to \'openai\', matching embedText()\'s actual documented fallback behaviour (BRAIN2-SEMANTIC) — the old default would have silently flipped provider selection the moment this entry\'s default was consulted at read time instead of just displayed read-only.',
  },

  {
    key: 'BRAIN_EMBED_MODEL',
    name: 'Qortex: OpenAI Embedding Model',
    description: 'OpenAI model used for Qortex / QuoxChat embeddings. text-embedding-3-large (default) is requested at 768 dimensions, so schema and vector index are unchanged. Changing it triggers a background re-embed of existing chunks; until it finishes, search queries both spaces.',
    service: 'collector',
    classification: 'user',
    type: 'enum',
    allowedValues: ['text-embedding-3-small', 'text-embedding-3-large'],
    default: 'text-embedding-3-large',
    group: 'memory',
    note: 'BRAIN2-W11: read per embed call via configResolver.getInstanceSetting in lib/brainEmbedModel.js (no restart). Stamps: 3-small keeps the legacy stamp, 3-large stamps text-embedding-3-large@768. Only applies when the OpenAI provider serves the embed (QUOXCHAT_EMBED_PROVIDER).',
  },

  // ─── Phase 24 env audit (2026-08-08), Section 4 — new candidates ────────
  // NOTE: HEARTBEAT_REQUIRE_AGENT_KEY (proposed in the audit doc) is
  // deliberately excluded — its name trips SECRET_NAME_PATTERN (contains
  // "KEY"), so it must never be added to this registry per the file's own
  // defense-in-depth rule, even though it is a boolean posture flag and not
  // an actual credential.
  {
    key: 'COLLECTOR_AUTH_ENFORCE',
    name: 'Collector Auth Enforcement',
    description: 'Whether the collector auth gate enforces (rejects) or only shadow-logs unauthenticated requests. Defaults to shadow (log-only) until explicitly set to "enforce".',
    service: 'collector',
    classification: 'operator',
    type: 'enum',
    default: 'shadow',
    group: 'security-posture',
  },
  {
    key: 'RESOLVE_BY_ID_REQUIRE_ORG',
    name: 'Vault: Resolve-by-ID Requires Org Match',
    description: 'Whether the credential resolve-by-id path requires org_id (400 if absent). Enforced by default; only an explicit "false" opts out.',
    service: 'auth',
    classification: 'operator',
    type: 'boolean',
    default: 'true',
    offOnlyWhen: 'false',
    group: 'security-posture',
  },
  {
    key: 'COOKIE_SECURE',
    name: 'Session Cookies: Secure Flag',
    description: 'Whether the session cookie is marked Secure (HTTPS-only). Should always be true in production; a silent false sends the session cookie over plain HTTP.',
    service: 'auth',
    classification: 'operator',
    type: 'boolean',
    default: 'true',
    offOnlyWhen: 'false',
    group: 'security-posture',
  },
  {
    key: 'CSRF_PROTECTION',
    name: 'CSRF Protection',
    description: 'Double-submit-cookie CSRF protection on state-changing auth requests. Enabled by default; only the literal value "disabled" turns it off (intended for testing).',
    service: 'auth',
    classification: 'operator',
    type: 'boolean',
    default: 'true',
    offOnlyWhen: 'disabled',
    group: 'security-posture',
  },
  {
    key: 'JWT_ACCESS_EXPIRY',
    name: 'Session Token Lifetime',
    description: 'How long an issued access token remains valid before it must be refreshed. Defaults to 1h.',
    service: 'auth',
    classification: 'operator',
    type: 'presence',
    default: '1h',
    onValue: 'custom',
    offValue: '1h',
    group: 'security-posture',
  },
  {
    key: 'JWT_REFRESH_EXPIRY',
    name: 'Refresh Token Lifetime',
    description: 'How long an issued refresh token remains valid. Defaults to 7d.',
    service: 'auth',
    classification: 'operator',
    type: 'presence',
    default: '7d',
    onValue: 'custom',
    offValue: '7d',
    group: 'security-posture',
  },
  {
    key: 'RATE_LIMIT_AUTH_MAX',
    name: 'Auth Rate Limit (max attempts)',
    description: 'Maximum login attempts allowed in the auth rate-limit window before a caller is throttled. Defaults to 15.',
    service: 'auth',
    classification: 'operator',
    type: 'presence',
    default: '15',
    onValue: 'custom',
    offValue: '15',
    group: 'security-posture',
  },
  {
    key: 'SSL_MODE',
    name: 'TLS Mode',
    description: 'Whether the deployment terminates TLS with secure-cookie behaviour treated as HTTPS. Defaults to false (plain HTTP posture).',
    service: 'auth',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
    group: 'security-posture',
  },
  {
    key: 'LICENSED_PLUGINS',
    name: 'Licensed Plugins',
    description: 'Comma-separated env fallback listing which plugins are licensed, used only when the live licence-lease check has not populated. Empty means no fallback licences configured.',
    service: 'tasks',
    classification: 'operator',
    type: 'presence',
    default: 'none',
    onValue: 'configured',
    offValue: 'none',
    group: 'licensing',
  },
  {
    key: 'LICENSE_GATE_ROLLOUT',
    name: 'License Gate Rollout',
    description: 'Comma-separated org allowlist companion to LICENSE_GATE_MODE. Empty/unset means every org is enforced (wildcard); a narrow list restricts enforcement to those orgs only.',
    service: 'tasks',
    classification: 'operator',
    type: 'presence',
    default: 'wildcard',
    onValue: 'restricted',
    offValue: 'wildcard',
    group: 'licensing',
  },
  {
    key: 'QUOXCHAT_LICENSE_ENFORCE',
    name: 'QuoxChat Widget License Enforcement',
    description: 'Licence enforcement posture for the embeddable QuoxChat widget. Enforced by default; only the literal value "off" disables it.',
    service: 'collector',
    classification: 'operator',
    type: 'boolean',
    default: 'true',
    offOnlyWhen: 'off',
    group: 'licensing',
  },
  {
    key: 'POWERS_EGRESS_ALLOWLIST',
    name: 'Plugin Sandbox Egress Allowlist',
    description: 'Comma-separated hostname/IP allowlist letting plugin sandbox containers reach otherwise-blocked internal/private targets. Empty by default (secure default-deny).',
    service: 'auth',
    classification: 'operator',
    type: 'presence',
    default: 'default-deny',
    onValue: 'allowlisted',
    offValue: 'default-deny',
    group: 'security-posture',
  },
  {
    key: 'QLARITY_ALLOWLIST',
    name: 'Qlarity Target Allowlist',
    description: 'Comma-separated allowlist of URLs/hosts the Qlarity/clarify governed browser inspector may target. Empty by default (default-deny — the service inspects nothing until explicitly allowlisted).',
    service: 'qlarity',
    classification: 'operator',
    type: 'presence',
    default: 'default-deny',
    onValue: 'allowlisted',
    offValue: 'default-deny',
    group: 'security-posture',
  },
  {
    key: 'FEED_FOLDER_ALLOWED_ROOTS',
    name: 'Feed: Allowed Folder Roots',
    description: 'Comma-separated allowlist restricting where folder-scoped Feed ingestion may read from. Also the allowlist for org-admin PUT /api/feed/sources host-path configs (folder, docs, automemory, transcript, obsidian, git): unset fails CLOSED for non-service callers (only service-key callers may set any path). Paths are realpath-resolved, so symlinks cannot escape a root. Entries are `<orgId>:/abs/path` (usable only by that org, for both the admin PUT and the scheduler walk) or a bare `/abs/path` instance root (usable only by service-key callers, or when FEED_FOLDER_SINGLE_TENANT=1 is set with at most one QUOXFEED_ORGS id; otherwise tenants cannot use bare roots). Example: org01:/srv/feeds/org01,org02:/srv/feeds/org02',
    service: 'collector',
    classification: 'operator',
    type: 'presence',
    default: 'unrestricted',
    onValue: 'restricted',
    offValue: 'unrestricted',
    group: 'feed',
  },
  {
    key: 'MATRIX_PER_ORG_IDENTITY',
    name: 'Matrix Per-Org Identity Mode',
    description: 'When on, every human Matrix identity is org-suffixed for real per-org room isolation. Off (default) keeps one shared Matrix identity per user across all their orgs.',
    service: 'auth',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
    group: 'security-posture',
  },
  {
    key: 'QUOXFLOW_FORWARD_ENVELOPES',
    name: 'QuoxFlow: AEE Envelope Forwarding',
    description: 'Whether QuoxFlow forwards AEE evidence envelopes into the evidence chain. Enabled by default; only an explicit "false" turns it off.',
    service: 'quoxflow',
    classification: 'operator',
    type: 'boolean',
    default: 'true',
    offOnlyWhen: 'false',
    group: 'governance',
  },
  {
    key: 'AGH_CHAIN_FEDERATE_STATS',
    name: 'Honesty Ledger: Federate Stats',
    description: 'Whether Honesty Ledger (AGH-Chain) stats are exposed for cross-org federation. Off by default (opt-in, intentionally public with no auth when on).',
    service: 'collector',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
    group: 'governance',
  },
  {
    key: 'QUOXBRAIN_IMPLANT_ORGS',
    name: 'QuoxBrain Implant: Enabled Orgs',
    description: 'Comma-separated per-org rollout allowlist for QUOXBRAIN_IMPLANT_ENABLED. Empty (or unset) means every org is enabled once the global switch is on.',
    service: 'collector',
    classification: 'operator',
    type: 'presence',
    default: 'unrestricted',
    onValue: 'restricted',
    offValue: 'unrestricted',
  },
  {
    key: 'QUOXDREAM_ORGS',
    name: 'QuoxDream: Enabled Orgs',
    description: 'Comma-separated org id list QuoxDream runs its consolidation cycle for. Ships dark: an empty list means no orgs are scheduled even when QUOXDREAM_ENABLED is true.',
    service: 'quoxbrain',
    classification: 'operator',
    type: 'presence',
    default: 'unconfigured',
    onValue: 'configured',
    offValue: 'unconfigured',
    group: 'memory',
  },
  {
    key: 'QUOXFEED_ORGS',
    name: 'The Feed: Enabled Orgs',
    description: 'Comma-separated org id list The Feed autopilot ingestion runs for. Ships dark: an empty list means no orgs are scheduled even when QUOXFEED_ENABLED is true.',
    service: 'collector',
    classification: 'operator',
    type: 'presence',
    default: 'unconfigured',
    onValue: 'configured',
    offValue: 'unconfigured',
    group: 'feed',
  },
  {
    key: 'MEMORY_CONSOLIDATION_HOUR_UTC',
    name: 'Memory Consolidation Time (UTC)',
    description: 'The UTC hour (0-23) the daily memory-consolidation job targets for its first run each cycle. Defaults to 03:00 UTC (off-peak).',
    service: 'collector',
    classification: 'operator',
    type: 'presence',
    default: '03:00-UTC',
    onValue: 'custom',
    offValue: '03:00-UTC',
    group: 'memory',
  },
  {
    key: 'BACKUP_DETACHED',
    name: 'Detached Backups',
    description: 'Run each backup in its own one-shot container so an auth rebuild or restart cannot kill a run in progress. Needs the Docker socket mounted into auth; otherwise backups run as a child of auth.',
    service: 'auth',
    classification: 'user',
    type: 'boolean',
    default: 'true',
    group: 'backup',
    note: '#727: resolved fresh per backup start via services/auth/lib/configResolver.js getInstanceSetting() in services/auth/lib/backupDetach.js tryLaunchDetachedBackup(). A stored setting overrides the BACKUP_DETACHED env value.',
  },
  {
    // VAULT-INTEG P17: promoted from classification 'operator'/type
    // 'presence' (visibility only, raw value never echoed) to a real
    // settable 'number' — see the note below for the consuming read site.
    key: 'BACKUP_SCHEDULER_INTERVAL_MS',
    name: 'Backup Cadence',
    description: 'How often (in ms) the backup scheduler checks whether a backup is due. Defaults to 60000ms (1 minute poll).',
    service: 'auth',
    classification: 'user',
    type: 'number',
    default: '60000',
    min: 5000,
    max: 3600000,
    group: 'backup',
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next auth service restart onward.',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via services/auth/lib/configResolver.js getInstanceSetting() (instance-wide — one scheduler checks every org\'s due schedules on a shared tick) in services/auth/services/backupScheduler.js startBackupScheduler(). Read once, at scheduler-start call time, and baked into the single setInterval it creates for the scheduler\'s whole lifetime — a stored override is honoured from the next auth service restart onward. No dedicated backup-settings page yet — surfaced via PlatformCapabilitiesView.jsx\'s UNPLACED_SETTABLE_KEYS.',
  },
  {
    key: 'VITE_DEMO_BANNER',
    name: 'Show Demo Mode Banner',
    description: 'Whether the demo-mode banner and credential pre-fill are shown on the login page. Sibling of VITE_DEMO_MODE. Compiled into the frontend build, not currently editable without a redeploy.',
    service: 'dashboard',
    classification: 'operator',
    type: 'boolean',
    default: 'false',
    group: 'demo',
  },

  // ─── VAULT-INTEG P13 slice 2: worst module-load env reads, rewired ──────
  // These eleven entries back the collector's new lib/configResolver.js
  // (getSetting/getInstanceSetting) — every one below was previously read
  // ONCE from process.env, either at module load or as a call-time function
  // that still only ever consulted process.env directly, with no way for a
  // stored override to reach it. All eleven are now genuinely resolved at
  // call time through configResolver; see each entry's `note` for exactly
  // when a change takes effect at its read site.
  {
    key: 'MEMORY_CONSOLIDATION_INTERVAL_MS',
    name: 'Memory Consolidation Cadence (ms)',
    description: 'How often, in ms, the daily memory-consolidation scheduler tick fires. Defaults to 24h.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '86400000',
    min: 60000,
    max: 604800000,
    group: 'memory',
    note: 'VAULT-INTEG P13 slice 2: read call-time via configResolver.getInstanceSetting() in lib/memoryConsolidationScheduler.js getIntervalMs(), called once when the scheduler starts. A stored override is honoured from the next collector restart onward (the setInterval cadence itself cannot change without recreating the timer), same restart semantics as QUOXFEED_ENABLED above.',
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next collector service restart onward.',
  },
  {
    key: 'MEMORY_CONSOLIDATION_ORG_CONCURRENCY',
    name: 'Memory Consolidation Org Concurrency',
    description: 'How many orgs the memory-consolidation scheduler processes in parallel within one tick.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '3',
    min: 1,
    max: 20,
    group: 'memory',
    note: 'VAULT-INTEG P13 slice 2: read call-time via configResolver.getInstanceSetting() inside lib/memoryConsolidationScheduler.js\'s per-tick runAll() (not captured once at scheduler start) — a stored override applies from the very next tick, no restart needed.',
  },
  {
    key: 'REFLECTION_MINING_INTERVAL_MS',
    name: 'AEE Conversation Mining Cadence (ms)',
    description: 'How often, in ms, the reflection-mining scheduler tick fires. Defaults to 5 minutes.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '300000',
    min: 60000,
    max: 3600000,
    group: 'memory',
    note: 'VAULT-INTEG P13 slice 2: read call-time via configResolver.getInstanceSetting() in lib/reflectionMiningScheduler.js getIntervalMs(), called once when the scheduler starts. A stored override is honoured from the next collector restart onward (the setInterval cadence itself cannot change without recreating the timer), same restart semantics as QUOXFEED_ENABLED above.',
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next collector service restart onward.',
  },
  {
    key: 'REFLECTION_MINING_ORG_CONCURRENCY',
    name: 'AEE Conversation Mining Org Concurrency',
    description: 'How many orgs the reflection-mining scheduler mines in parallel within one tick.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '3',
    min: 1,
    max: 20,
    group: 'memory',
    note: 'VAULT-INTEG P13 slice 2: read call-time via configResolver.getInstanceSetting() inside lib/reflectionMiningScheduler.js\'s per-tick runAll() (not captured once at scheduler start) — a stored override applies from the very next tick, no restart needed.',
  },
  {
    key: 'QUOXFEED_INTERVAL_MS',
    name: 'The Feed Cadence (ms)',
    description: 'How often, in ms, The Feed autopilot ingestion scheduler tick fires. Defaults to 30 minutes.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '1800000',
    min: 60000,
    max: 86400000,
    group: 'feed',
    note: 'VAULT-INTEG P13 slice 2: read call-time via configResolver.getInstanceSetting() in lib/feedScheduler.js startFeedScheduler(), called once when the scheduler starts. A stored override is honoured from the next collector restart onward (the setInterval cadence itself cannot change without recreating the timer), same restart semantics as QUOXFEED_ENABLED above.',
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next collector service restart onward.',
  },
  {
    key: 'QUOXFEED_MAX_ITEMS',
    name: 'The Feed: Max Items per Source',
    description: 'The per-source, per-tick batch cap on items The Feed ingests from any one source.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '50',
    min: 1,
    max: 1000,
    group: 'feed',
    note: 'VAULT-INTEG P13 slice 2: read call-time via configResolver.getInstanceSetting() inside lib/feedScheduler.js\'s per-tick runCoreTick() (not captured once at scheduler start) — a stored override applies from the very next tick, no restart needed.',
  },
  {
    key: 'QUOXFEED_QUOXPLAN_MAX_ITEMS',
    name: 'The Feed: Max Items per Tick (QuoxPlan)',
    description: 'The per-tick batch cap for the QuoxPlan source only. Overrides the shared per-source cap, because a roadmap with hundreds of active streams cannot keep up at the shared cap.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '200',
    min: 1,
    max: 2000,
    group: 'feed',
    note: 'ONE-BRAIN CX1: read call-time via configResolver.getInstanceSetting() inside lib/feedScheduler.js\'s per-tick runCoreTick(), same as QUOXFEED_MAX_ITEMS; a stored override applies from the very next tick, no restart needed.',
  },
  {
    key: 'QUOXFEED_INGEST_TIMEOUT_MS',
    name: 'The Feed: Per-Ingester Timeout (ms)',
    description: 'How long, in ms, The Feed waits for one source ingester call before treating it as failed.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '120000',
    min: 5000,
    max: 600000,
    group: 'feed',
    note: 'VAULT-INTEG P13 slice 2: read call-time via configResolver.getInstanceSetting() inside lib/feedScheduler.js\'s per-tick runCoreTick() (not captured once at scheduler start) — a stored override applies from the very next tick, no restart needed.',
  },
  {
    key: 'IMAGE_STORE_MAX_BYTES',
    name: 'Generated Image Store: Max Bytes',
    description: 'Total on-disk byte quota for generated images before the oldest are pruned.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '2147483648',
    min: 10485760,
    max: 107374182400,
    group: 'storage',
    note: 'VAULT-INTEG P13 slice 2: read call-time via configResolver.getInstanceSetting() in lib/imageStore.js getMaxStorageBytes(), called fresh on every saveImage() call — a stored override applies to the very next save, no restart needed.',
  },
  {
    key: 'IMAGE_STORE_MAX_COUNT',
    name: 'Generated Image Store: Max Count',
    description: 'Total item-count quota for generated images before the oldest are pruned.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '5000',
    min: 10,
    max: 1000000,
    group: 'storage',
    note: 'VAULT-INTEG P13 slice 2: read call-time via configResolver.getInstanceSetting() in lib/imageStore.js getMaxStorageCount(), called fresh on every saveImage() call — a stored override applies to the very next save, no restart needed.',
  },
  {
    key: 'GEMINI_CLI_TIMEOUT',
    name: 'Gemini CLI Tool Timeout (ms)',
    description: 'How long, in ms, the GEMINI tool executor waits for the gemini CLI before timing out.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '120000',
    min: 5000,
    max: 600000,
    group: 'integrations',
    note: 'VAULT-INTEG P13 slice 2: read call-time via configResolver.getInstanceSetting() in lib/toolExecutors/geminiCli.js getGeminiTimeoutMs(), called fresh on every execGemini() call — a stored override applies to the very next tool call, no restart needed.',
  },
  {
    key: 'PERPLEXITY_TIMEOUT',
    name: 'Perplexity API Tool Timeout (ms)',
    description: 'How long, in ms, the PERPLEXITY tool executor waits for the Perplexity API before timing out.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '60000',
    min: 5000,
    max: 300000,
    group: 'integrations',
    note: 'VAULT-INTEG P13 slice 2: read call-time via configResolver.getInstanceSetting() in lib/toolExecutors/perplexityApi.js getPerplexityTimeoutMs(), called fresh on every callPerplexityApi() call — a stored override applies to the very next tool call, no restart needed.',
  },

  // ─── VAULT-INTEG P17: remaining 'user'-classified vars (envRegistry.cjs)
  // consumed by collector/tasks/screencap that had no CAPABILITIES entry at
  // all — added + wired in the same slice (not a promote-then-wire-later
  // split like P14/P13 above, since these had nothing to promote from). ───
  {
    key: 'ANTHROPIC_MODEL',
    name: 'Anthropic Model (chat/complete fallback)',
    description: 'Which Claude model /chat/complete uses when the request omits a model AND the org policy plan could not be resolved. Defaults to "claude-sonnet-5".',
    service: 'collector',
    classification: 'user',
    type: 'string',
    default: 'claude-sonnet-5',
    maxLength: 64,
    group: 'ai-models',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via configResolver.getSetting(orgId, ...) in server.js\'s /chat/complete policy-resolution catch branch (~line 23119), called fresh on every request that falls into that branch.',
  },
  {
    key: 'CLAUDE_CLI_DEFAULT_MODEL',
    name: 'Claude CLI Default Model (labeling)',
    description: 'The model label attached to Claude CLI/MCP dispatch sessions, audit envelopes and decision-evidence bookkeeping when neither the CLI response nor the caller names one. Labeling only — does not change which model the CLI actually invokes.',
    service: 'collector',
    classification: 'user',
    type: 'string',
    default: 'sonnet',
    maxLength: 64,
    group: 'ai-models',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via configResolver.getSetting(orgId, ...) in lib/claudeCliDispatcher.js dispatchClaudeCli(), resolved once per call (opts.orgId) and reused for every label site in that call.',
  },
  {
    key: 'GEMINI_CLI_MODEL',
    name: 'Gemini CLI Default Model',
    description: 'Which Gemini model the GEMINI tool executor uses when a caller does not specify one. Defaults to "gemini-2.5-pro".',
    service: 'collector',
    classification: 'user',
    type: 'string',
    default: 'gemini-2.5-pro',
    maxLength: 64,
    group: 'ai-models',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via configResolver.getSetting(orgId, ...) in lib/toolExecutors/geminiCli.js execGemini(), org-scoped when the caller (geminiReview/geminiAnalyze/geminiGenerate) forwards ctx.orgId; falls back to the instance-wide resolution otherwise.',
  },
  {
    key: 'PERPLEXITY_MODEL',
    name: 'Perplexity Default Model',
    description: 'Which Perplexity Sonar model callPerplexityApi() uses when a caller does not specify one. Defaults to "sonar".',
    service: 'collector',
    classification: 'user',
    type: 'string',
    default: 'sonar',
    maxLength: 64,
    group: 'ai-models',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via configResolver.getInstanceSetting() in lib/toolExecutors/perplexityApi.js callPerplexityApi(). Instance-scoped only, not per-org: every live caller (perplexitySearch/Research/Verify in agentTools.js) already passes an explicit model, so this default is a genuine but rarely-hit fallback — org-scoping it would mean threading orgId through 3 more call sites for a path nothing currently exercises live. Revisit if a caller ever needs the bare default.',
  },
  {
    key: 'RESEARCH_SEARCH_PROVIDER',
    name: 'Research Web Search Provider',
    description: 'Which web search backend the research agent (SCHOLAR) uses for web_search. none: web search is off. searxng: a self-hosted SearXNG (set RESEARCH_SEARXNG_URL). brave or tavily: the key is read from your QuoxVault provider keys.',
    service: 'collector',
    classification: 'user',
    type: 'enum',
    allowedValues: ['none', 'searxng', 'brave', 'tavily'],
    default: 'none',
    group: 'ai-models',
    note: 'Read per-org via configResolver.getSetting() in lib/webResearch.js webSearch(). With none, or a missing key or URL, web_search returns no_search_provider and the agents say so plainly. Perplexity tools are separate and untouched.',
  },
  {
    key: 'RESEARCH_SEARXNG_URL',
    name: 'Research SearXNG Base URL',
    description: 'Base URL of a self-hosted SearXNG instance used when the search provider is searxng, for example http://searxng:8080. It must have the json format enabled.',
    service: 'collector',
    classification: 'user',
    type: 'string',
    default: '',
    maxLength: 300,
    group: 'ai-models',
    note: 'Read per-org in lib/webResearch.js. Admin-set and trusted, so it is not run through the page-read egress guard (it is normally an internal address).',
  },
  {
    key: 'DISCORD_APPLICATION_ID',
    name: 'Discord Application ID (last-resort fallback)',
    description: 'The Discord application id used when the vault/instance_config webhook-config lookup (auth service) is completely unreachable. Not a credential — used to build interaction responses.',
    service: 'collector',
    classification: 'user',
    type: 'string',
    default: '',
    maxLength: 64,
    group: 'integrations',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via configResolver.getInstanceSetting() in lib/discordWebhook.js getDiscordWebhookConfig(), in the last-resort branch only (no org is known yet at that point — the vault-first path above it, resolved per-org via the auth service, remains authoritative whenever it is reachable).',
  },
  {
    key: 'TELEGRAM_BOT_USERNAME',
    name: 'Telegram Bot Username (last-resort fallback)',
    description: 'The Telegram bot username used when the vault/instance_config webhook-config lookup (auth service) is completely unreachable.',
    service: 'collector',
    classification: 'user',
    type: 'string',
    default: '',
    maxLength: 64,
    group: 'integrations',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via configResolver.getInstanceSetting() in lib/telegramWebhook.js getWebhookConfig(), in the last-resort branch only, mirroring TELEGRAM_DEFAULT_AGENT\'s existing entry in this same fallback branch.',
  },
  {
    key: 'QUOXFEED_WARMUP_MS',
    name: 'The Feed: Startup Warmup Delay (ms)',
    description: 'How long, in ms, The Feed autopilot scheduler waits after collector boot before its first tick.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '60000',
    min: 0,
    max: 3600000,
    group: 'feed',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via configResolver.getInstanceSetting() (resolveInstanceNumber()) in lib/feedScheduler.js startFeedScheduler(), called once when the scheduler starts — same restart semantics as QUOXFEED_INTERVAL_MS above (the value only ever feeds the one setTimeout that schedules the first tick).',
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next collector service restart onward.',
  },
  {
    key: 'QUOXFEED_QUOXPLAN_ROADMAP_ID',
    name: 'The Feed: QuoxPlan Roadmap ID',
    description: 'Which QuoxPlan roadmap the QuoxPlan feed source ingests when a connected source config does not specify one.',
    service: 'collector',
    classification: 'user',
    type: 'string',
    default: 'quox-strategic',
    maxLength: 128,
    group: 'feed',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via configResolver.getInstanceSetting() in lib/feedQuoxplanSource.js, called fresh on every ingest tick — a stored override applies to the very next tick, no restart needed.',
  },
  {
    key: 'QUOXFEED_HOST_ORG',
    name: 'The Feed: Transcript Host Org',
    description: 'Restricts the machine-global transcript directory feed source to a single designated org. Unset means the shared transcript directory is treated as global across every configured org (soak convenience, not a production posture).',
    service: 'collector',
    classification: 'operator',
    type: 'presence',
    default: 'unrestricted',
    onValue: 'restricted',
    offValue: 'unrestricted',
    group: 'feed',
    note: 'Mirrors the sibling QUOXFEED_QUOXPLAN_ORG entry above: the raw value IS an org id, so this stays \'presence\'-typed (never settable, never echoed) rather than a plain settable string. That also means it stays genuinely env-only at its consuming read sites (lib/feedTranscriptSource.js, lib/feedFleetSource.js) — a \'presence\' resolution only ever returns onValue/offValue, never the real org id the comparison there actually needs, so configResolver cannot serve this read without reintroducing exactly the raw-value echo this type deliberately avoids.',
  },
  {
    key: 'QUOXCHAT_CONNECTOR_PRIVATE_ALLOWLIST',
    name: 'QuoxChat Connector: Private-Network Allowlist',
    description: 'Comma-separated exact host:port allowlist exempting named private/LAN origins from the QuoxChat connector SSRF guard. Empty by default (default-deny).',
    service: 'collector',
    classification: 'operator',
    type: 'presence',
    default: 'default-deny',
    onValue: 'allowlisted',
    offValue: 'default-deny',
    group: 'security-posture',
    note: 'Mirrors QLARITY_ALLOWLIST above by design, not oversight: lib/quoxchatToolExecutors.js\'s own comment at the check site is explicit that this stays a DEPLOYMENT-level, env-only allowlist so an org admin (or a prompt-injected agent acting through a connector) can never self-authorize LAN egress from the dashboard. Left un-rewired at its read site on purpose — visibility only, same as QLARITY_ALLOWLIST.',
  },

  // ─── VAULT-INTEG P17 (auth + quoxbrain configResolvers slice): the
  // remaining QUOXDREAM_*/QUOXBRAIN_EMBED_BACKFILL_* tuning knobs and the
  // auth-owned HITL_SLA_POLL_INTERVAL_MS/MATRIX_ROOMS/BACKUP_STALE_MINUTES/
  // BACKUP_TIMEOUT_MS companions — envRegistry.cjs already classified these
  // 'user' with surface 'platform settings registry' but flagged "not yet
  // in platformCapabilities.js"; this section is that promotion, wired at
  // the same time (see services/quoxbrain/lib/configResolver.js and
  // services/auth/lib/configResolver.js for the HTTP-resolution seam both
  // services use — neither owns collector's voltDb directly). ───
  {
    key: 'QUOXDREAM_WARMUP_MS',
    name: 'QuoxDream: Warmup Delay',
    description: 'How long, in ms, QuoxDream waits after quoxbrain boots before its first consolidation tick. Defaults to 300000ms (5 minutes).',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '300000',
    min: 0,
    max: 3600000,
    group: 'memory',
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next QuoxBrain service restart onward.',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via services/quoxbrain/lib/configResolver.js getInstanceSetting() in services/quoxbrain/lib/dreamScheduler.js startDreamScheduler(). Read once, at scheduler-start call time, and baked into its warmup setTimeout for the scheduler\'s whole lifetime — a stored override is honoured from the next QuoxBrain service restart onward.',
  },
  {
    key: 'QUOXDREAM_INTERVAL_MS',
    name: 'QuoxDream: Consolidation Interval',
    description: 'How often, in ms, QuoxDream runs its consolidation cycle once started. Defaults to 21600000ms (6 hours).',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '21600000',
    min: 60000,
    max: 86400000,
    group: 'memory',
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next QuoxBrain service restart onward.',
    note: 'VAULT-INTEG P17: same call site and honesty note as QUOXDREAM_WARMUP_MS above — startDreamScheduler() bakes this into its recurring setInterval for the scheduler\'s whole lifetime.',
  },
  {
    key: 'QUOXDREAM_BATCH_SIZE',
    name: 'QuoxDream: Batch Size',
    description: 'How many notes QuoxDream processes per batch within a consolidation tick. Unset falls through to consolidateSlice\'s own default (40).',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '40',
    min: 1,
    max: 500,
    group: 'memory',
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next QuoxBrain service restart onward.',
    note: 'VAULT-INTEG P17: same call site and honesty note as QUOXDREAM_WARMUP_MS above — startDreamScheduler() resolves this once and captures it in every runTick() closure for the scheduler\'s whole lifetime.',
  },
  {
    key: 'QUOXDREAM_MAX_BATCHES',
    name: 'QuoxDream: Max Batches Per Tick',
    description: 'How many batches QuoxDream processes per org per consolidation tick. Unset falls through to consolidateSlice\'s own default (5).',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '5',
    min: 1,
    max: 100,
    group: 'memory',
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next QuoxBrain service restart onward.',
    note: 'VAULT-INTEG P17: same call site and honesty note as QUOXDREAM_WARMUP_MS above.',
  },
  {
    key: 'QUOXDREAM_EXTRACT_TIMEOUT_MS',
    name: 'QuoxDream: Extraction Timeout',
    description: 'Per-note LLM extraction timeout during a QuoxDream consolidation pass. A note that times out is skipped, not retried, and the pass continues. Defaults to 90000ms.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '90000',
    min: 5000,
    max: 300000,
    group: 'memory',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via services/quoxbrain/lib/configResolver.js getInstanceSetting() in services/quoxbrain/lib/quoxDream.js extractBeliefs(), called fresh on every note extraction — a stored override applies to the very next note, no restart needed.',
  },
  {
    key: 'QUOXDREAM_SEMANTIC_DEDUP_THRESHOLD',
    name: 'QuoxDream: Semantic Dedup Threshold',
    description: 'Cosine-similarity threshold (0-1) above which two beliefs are treated as the same during QuoxDream\'s semantic dedup pass. Only consulted when QUOXDREAM_SEMANTIC_DEDUP is on. Defaults to 0.90.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '0.9',
    min: 0,
    max: 1,
    group: 'memory',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via services/quoxbrain/lib/configResolver.js getSetting(orgId, ...) in services/quoxbrain/lib/quoxDream.js semanticDedupThreshold(), called fresh on every writeBelief() call — a stored override applies to the very next claim written, no restart needed.',
  },
  {
    key: 'QUOXBRAIN_EMBED_BACKFILL_WARMUP_MS',
    name: 'QuoxBrain Embed Backfill: Warmup Delay',
    description: 'How long, in ms, the embedding backfill scheduler waits after quoxbrain boots before its first tick. Defaults to 120000ms (2 minutes).',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '120000',
    min: 0,
    max: 3600000,
    group: 'memory',
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next QuoxBrain service restart onward.',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via services/quoxbrain/lib/configResolver.js getInstanceSetting() in services/quoxbrain/lib/embeddingBackfillScheduler.js startEmbeddingBackfillScheduler(). Read once, at scheduler-start call time, and baked into its warmup setTimeout for the scheduler\'s whole lifetime.',
  },
  {
    key: 'QUOXBRAIN_EMBED_BACKFILL_INTERVAL_MS',
    name: 'QuoxBrain Embed Backfill: Tick Interval',
    description: 'How often, in ms, the embedding backfill scheduler runs once started. Defaults to 900000ms (15 minutes).',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '900000',
    min: 30000,
    max: 21600000,
    group: 'memory',
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next QuoxBrain service restart onward.',
    note: 'VAULT-INTEG P17: same call site and honesty note as QUOXBRAIN_EMBED_BACKFILL_WARMUP_MS above — also sizes the whole-tick backoff cap (MAX_BACKOFF_MS / this interval).',
  },
  {
    key: 'QUOXBRAIN_EMBED_BACKFILL_MAX_ORGS',
    name: 'QuoxBrain Embed Backfill: Max Orgs Per Tick',
    description: 'Maximum distinct orgs the embedding backfill scheduler discovers/processes per tick. Defaults to 10.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '10',
    min: 1,
    max: 200,
    group: 'memory',
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next QuoxBrain service restart onward.',
    note: 'VAULT-INTEG P17: same call site and honesty note as QUOXBRAIN_EMBED_BACKFILL_WARMUP_MS above.',
  },
  {
    key: 'QUOXBRAIN_EMBED_BACKFILL_BATCH_CAP',
    name: 'QuoxBrain Embed Backfill: Batch Cap',
    description: 'Per-org embedding batch size cap for the backfill scheduler. Unset falls through to backfillEmbeddings\' own default (200).',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '200',
    min: 1,
    max: 2000,
    group: 'memory',
    requiresRestart: true,
    restartNote: 'Stored and audited immediately, and honoured from the next QuoxBrain service restart onward.',
    note: 'VAULT-INTEG P17: same call site and honesty note as QUOXBRAIN_EMBED_BACKFILL_WARMUP_MS above.',
  },
  {
    key: 'QUOXBRAIN_EMBED_TIMEOUT_MS',
    name: 'QuoxBrain: Embedding Call Timeout',
    description: 'Per-batch timeout, in ms, for calls to the collector\'s embedding seam. Defaults to 45000ms.',
    service: 'quoxbrain',
    classification: 'user',
    type: 'number',
    default: '45000',
    min: 5000,
    max: 180000,
    group: 'memory',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via services/quoxbrain/lib/configResolver.js getInstanceSetting() in services/quoxbrain/lib/embeddingClient.js resolveDeps()/resolveEmbedTimeoutMs(), called fresh on every embedTextsDetailed() call — a stored override applies to the very next embedding call, no restart needed.',
  },
  {
    key: 'HITL_SLA_POLL_INTERVAL_MS',
    name: 'HITL SLA: Poll Interval',
    description: 'How often, in ms, the HITL SLA escalation runner checks for due escalation stages. Defaults to 60000ms (1 minute).',
    service: 'auth',
    classification: 'user',
    type: 'number',
    default: '60000',
    min: 5000,
    max: 3600000,
    group: 'governance',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via services/auth/lib/configResolver.js getInstanceSetting() (instance-wide — one runner examines every org\'s due escalation stages) in services/auth/jobs/sla-escalation.js resolvePollIntervalMs(), consulted by startSlaEscalation()\'s scheduleNext() on EVERY tick (not once at boot — it re-arms its own setTimeout after each run) — a stored override applies to the very next tick, no restart needed.',
  },
  {
    // VAULT-INTEG P17: sibling of HITL_SLA_ALLOW_AUTO_APPROVE above, whose
    // own entry stays classification 'operator' (out of this slice's
    // territory) — this is the numeric poll-cadence companion, promoted on
    // its own per the envRegistry.cjs classification pass.
    key: 'MATRIX_ROOMS',
    name: 'Eager Matrix Room Provisioning',
    description: 'Whether creating/deleting an org, division, department or team eagerly provisions/deprovisions its Matrix room. Enforced by default; only the literal value "off" disables it (backfillRooms remains the backstop either way).',
    service: 'auth',
    classification: 'user',
    type: 'boolean',
    default: 'true',
    offOnlyWhen: 'off',
    group: 'integrations',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via services/auth/lib/configResolver.js getSetting(orgId, ...) in services/auth/lib/matrixProvisioner.js isMatrixRoomsEnabled(), called fresh on every org/division/team/department create-or-delete request (routes/orgs.js, routes/divisions.js, routes/teams.js, routes/departments.js) — a stored override applies to the very next request, no restart needed. No dedicated Matrix-settings page yet — surfaced via PlatformCapabilitiesView.jsx\'s UNPLACED_SETTABLE_KEYS (shares the \'integrations\' group with TELEGRAM_DEFAULT_AGENT, which already has its own home).',
  },
  {
    key: 'BACKUP_STALE_MINUTES',
    name: 'Backup: Stale-Run Threshold',
    description: 'How long, in minutes, a backup can sit in \'running\' with no completion before being marked stale/failed. This only updates the database row — it does not kill the backup process. Defaults to 180 minutes.',
    service: 'auth',
    classification: 'user',
    type: 'number',
    default: '180',
    min: 10,
    max: 1440,
    group: 'backup',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via services/auth/lib/configResolver.js getInstanceSetting() (instance-wide — one sweep checks every org\'s running backups) in services/auth/routes/backups.js resolveStaleBackupMinutes(), consulted by markStaleBackups() on its existing 5-minute recurring check — a stored override applies within one tick, no restart needed. No dedicated backup-settings page yet — surfaced via PlatformCapabilitiesView.jsx\'s UNPLACED_SETTABLE_KEYS.',
  },
  {
    key: 'BACKUP_TIMEOUT_MS',
    name: 'Backup: Process Kill Timeout',
    description: 'Maximum time, in ms, a single backup process may run before being killed (SIGKILL). Defaults to 300000ms (5 minutes).',
    service: 'auth',
    classification: 'user',
    type: 'number',
    default: '300000',
    min: 30000,
    max: 3600000,
    group: 'backup',
    note: 'VAULT-INTEG P17: settable + audited + effective-resolved via services/auth/lib/configResolver.js getSetting(orgId, ...) in services/auth/routes/backups.js resolveBackupTimeoutMs(), resolved once per runBackupProcess() call (the org that requested the backup) — a stored override applies to the very next backup that org runs, no restart needed. No dedicated backup-settings page yet — surfaced via PlatformCapabilitiesView.jsx\'s UNPLACED_SETTABLE_KEYS.',
  },
  {
    key: 'QUOX_MAX_SPLINTERS',
    name: 'QuoxIdentity: Max Splinters per Agent',
    description: 'Maximum number of concurrently attached sessions (splinters) one agent may have. A same-holder attach beyond this is refused with 409 splinter_cap. Defaults to 4.',
    service: 'auth',
    classification: 'user',
    type: 'number',
    default: '4',
    min: 1,
    max: 16,
    group: 'governance',
    note: 'QUOXIDENTITY P9: settable + audited + effective-resolved via services/auth/lib/configResolver.js getSetting(orgId, ...) then getInstanceSetting() in services/auth/lib/splinterCap.js resolveMaxSplinters(), called fresh on every attach lease request; the process env is only a last-resort fallback. No dedicated settings page yet.',
  },

  // ─── X (Twitter) plugin, X-PLUGIN phase 11 ────────────────────────────
  // These five close the debt xPostingStore.js has carried since P2: its
  // budget numbers were process-wide code constants with a comment promising
  // they would become a registered org-scoped setting (NO-ENV-ONLY-CONFIG).
  // They are registered here rather than in a private x_settings table so
  // there is ONE settings substrate, one audit history and one admin surface,
  // not a parallel system beside org_platform_settings.
  //
  // The code constants remain the DEFAULTS (X's free-tier shape: 17/24h,
  // 500/30d), so an org that never touches these behaves exactly as before.
  // min/max here are the HARD CEILINGS: an admin can raise an org past the
  // free-tier numbers when their X plan allows it, but cannot set a limit
  // that is unbounded or zero.
  {
    key: 'X_DAILY_POST_LIMIT',
    name: 'X: posts per 24 hours',
    description: 'How many posts this org may publish to X in a rolling 24-hour window. Counted from the moment each post went out, not from midnight, so the oldest post in the window frees its slot as it ages past 24 hours. Defaults to 17, which is X\'s free-tier per-user cap; raise it only as far as your X plan actually allows, because X refuses the post either way once its own limit is hit.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '17',
    min: 1,
    max: 100,
    group: 'x',
    note: 'X-PLUGIN phase 11: resolved per call by xPostingStore.getOrgLimits(db, orgId) (platformSettingsStore.getEffectiveFlag), which backs getBudgetStatus(), the draft-time check in xTools x_post/x_thread AND the transactional recount inside claimForApproval() at approval time. Takes effect on the next draft or approval, no restart needed.',
  },
  {
    key: 'X_MONTHLY_POST_LIMIT',
    name: 'X: posts per 30 days',
    description: 'How many posts this org may publish to X in a rolling 30-day window. Defaults to 500, X\'s free-tier per-user cap. Sits above the 24-hour limit: whichever is reached first refuses the post.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '500',
    min: 1,
    max: 1500,
    group: 'x',
    note: 'X-PLUGIN phase 11: same resolution path as X_DAILY_POST_LIMIT — xPostingStore.getOrgLimits(), enforced at draft time and again inside the claimForApproval() transaction.',
  },
  {
    key: 'X_DAILY_READ_LIMIT',
    name: 'X: API reads per 24 hours',
    description: 'How many reads of X\'s API this org may spend in a rolling 24-hour window, across the engagement panel, the read tools and the mentions poller. X reads are pay-per-use at roughly $0.005 each, so this is a spend ceiling: 200 reads a day is about $1.00 a day at that rate.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '200',
    min: 1,
    max: 1000,
    group: 'x',
    note: 'X-PLUGIN phase 11: resolved by xPostingStore.getOrgLimits() and enforced inside the checkAndRecordRead() transaction, which every read tool in connectors/types/twitter.js calls before touching api.x.com. Takes effect on the next read, no restart needed.',
  },
  {
    key: 'X_MENTIONS_POLL_ENABLED',
    name: 'X: poll for mentions',
    description: 'Whether the collector regularly checks X for new mentions of this org\'s connected account and files them in the inbox. Off by default because every check spends a paid read. The deployment-wide X_INBOUND_POLL_ENABLED environment flag is a kill switch above this: if it is off, no org polls regardless of this setting.',
    service: 'collector',
    classification: 'user',
    type: 'boolean',
    default: 'false',
    group: 'x',
    note: 'X-PLUGIN phase 11 (owner-ratified 2026-09-12): read per tick, per org, by lib/xInboundPoller.js via xPostingStore.getOrgPollSettings(). Reads draw from X_DAILY_READ_LIMIT above. Follower-difference monitoring is NOT implemented and is shown as a disabled row in the UI rather than a setting that does nothing.',
  },
  {
    key: 'X_MENTIONS_POLL_INTERVAL',
    name: 'X: mention check interval',
    description: 'How often to check X for new mentions when mention polling is on. Each check is one paid read, so the interval is the monthly cost: every 15 minutes is about $14.40 a month, hourly is about $3.60, every 6 hours is about $0.60, daily is about $0.15.',
    service: 'collector',
    classification: 'user',
    type: 'enum',
    allowedValues: ['15m', '30m', '1h', '6h', 'daily'],
    default: '1h',
    group: 'x',
    note: 'X-PLUGIN phase 11: read per tick, per org, by lib/xInboundPoller.js via xPostingStore.getOrgPollSettings(). Ignored entirely when X_MENTIONS_POLL_ENABLED is off.',
  },
  {
    // BLAST-RADIUS-P1: an org's own off-switch for the reach summary
    // approvalGate.js attaches to every gated approval (lib/reach/
    // actionRadius.js). Default 'on' because the summary is the point of
    // the feature; 'off' is the honest escape hatch for an org that finds
    // the extra evaluator call or the body_md addition unwanted, without
    // needing an env restart.
    key: 'REACH_BANDS_ON_APPROVALS',
    name: 'Blast-Radius Summary on Approvals',
    description: 'Whether a computed blast-radius summary (what this call names, and what the agent may more broadly touch: credentials, hosts, egress origins, delegation) is attached to every human-in-the-loop approval request. On by default; turning it off skips the summary computation entirely for this org\'s approvals.',
    service: 'collector',
    classification: 'user',
    type: 'enum',
    allowedValues: ['on', 'off'],
    default: 'on',
    group: 'governance',
    note: 'BLAST-RADIUS-P1: resolved per approval via platformSettingsStore.getEffectiveFlag(voltDb, orgId, \'REACH_BANDS_ON_APPROVALS\') in lib/approvalGate.js\'s createApprovalRequest, gating the injected reachEvaluator call. A resolver failure or timeout still creates the approval — it never blocks HITL — and attaches metadata.reach = { status: \'unavailable\' } instead.',
  },
  {
    // BLAST-RADIUS-P4: an unsolicited weekly inbox item is opt-in, not
    // opt-out — an org that never asked for a reach digest should never
    // find one waiting in their inbox. Default 'off' for exactly that
    // reason (unlike REACH_BANDS_ON_APPROVALS above, which is default-on
    // because it rides an action the org already initiated).
    key: 'REACH_WEEKLY_DIGEST',
    name: 'Weekly Reach Least-Privilege Digest',
    description: 'Whether this org receives one inbox item per ISO week summarising which granted tools/credentials across its active agents showed zero observed use in the trailing 7 days (a predicted-vs-actual least-privilege report, lib/reach/leastPrivilege.js). Off by default — this is an unsolicited recurring inbox item, so it is opt-in per org, never on for every org silently.',
    service: 'collector',
    classification: 'user',
    type: 'enum',
    allowedValues: ['on', 'off'],
    default: 'off',
    group: 'governance',
    note: 'BLAST-RADIUS-P4: resolved per org per hourly tick via platformSettingsStore.getEffectiveFlag(voltDb, orgId, \'REACH_WEEKLY_DIGEST\') in lib/reach/digestScheduler.js. An org with zero tool-execution envelopes in the trailing 7 days is SKIPPED (not evaluated, not failed) regardless of this setting — there is nothing to digest.',
  },
  {
    // SETEC S3 batch 1: promoted from classification 'instance' (env-only).
    key: 'MCP_INVOKE_TIMEOUT_MS',
    name: 'MCP: Tool Call Timeout',
    description: 'Maximum time, in ms, a single MCP tool call may take before it is abandoned. Defaults to 30000ms (30 seconds). Applies to MCP processes started after the change; one already running keeps the value it started with.',
    service: 'powers-host',
    classification: 'user',
    type: 'number',
    default: '30000',
    min: 1000,
    max: 600000,
    group: 'integrations',
    note: 'SETEC S3: settable + audited + effective-resolved at services/powers-host/lib/processSupervisor.js resolveInvokeTimeout(), resolved when an MCP container multiplexer is created (no restart, next started process). Only a stored instance setting overrides; with none stored the previous env/code default applies unchanged.',
  },
  {
    // SETEC S3 batch 1: promoted from classification 'instance' (env-only).
    key: 'POWERS_BUILD_TIMEOUT_MS',
    name: 'POWERS: Image Build Timeout',
    description: 'Maximum time, in ms, a plugin image build may run before it is failed with build_timeout. Defaults to 600000ms (10 minutes). Applies from the next build.',
    service: 'powers-host',
    classification: 'user',
    type: 'number',
    default: '600000',
    min: 60000,
    max: 3600000,
    group: 'integrations',
    note: 'SETEC S3: settable + audited + effective-resolved at services/powers-host/lib/imageBuilder.js buildImage(), resolved once per build (no restart). Only a stored instance setting overrides; with none stored the previous env/code default applies unchanged.',
  },
  {
    // SETEC S3 batch 1: promoted from classification 'instance' (env-only).
    key: 'QUOX_VOLT_MAX_EVENTS_PER_RUN',
    name: 'VOLT: Max Events per Bridged Run',
    description: 'Safety cap on how many AEE events are bridged into a single VOLT run before further events are dropped and the run is marked capped. Defaults to 2000.',
    service: 'collector',
    classification: 'user',
    type: 'number',
    default: '2000',
    min: 100,
    max: 100000,
    group: 'storage',
    note: 'SETEC S3: settable + audited + effective-resolved at services/collector/server.js (aeeVoltBridge maxEventsPerRun resolver) and lib/aeeVoltBridge.js currentCap(), read live via lib/configResolver.js with a 10s cache (no restart). Only a stored instance setting overrides; with none stored the previous env/code default applies unchanged.',
  },
  {
    // SETEC S3 batch 1: promoted from classification 'instance' (env-only).
    key: 'REAPER_INTERVAL_MS',
    name: 'Objective Reaper: Scan Interval',
    description: 'How often, in ms, the objective reaper scans for stuck or stale objectives. Defaults to 300000ms (5 minutes). A change applies after the next scan.',
    service: 'tasks',
    classification: 'user',
    type: 'number',
    default: '300000',
    min: 10000,
    max: 3600000,
    group: 'governance',
    note: 'SETEC S3: settable + audited + effective-resolved at services/tasks/lib/objectiveReconciler.js startReaper() via configResolver.startAdaptiveInterval; the interval is re-read every tick (no restart). Only a stored instance setting overrides; with none stored the previous env/code default applies unchanged.',
  },
  {
    // SETEC S3 batch 1: promoted from classification 'instance' (env-only).
    key: 'REAPER_STALE_DECOMPOSED_MS',
    name: 'Objective Reaper: Stale Decomposed Age',
    description: 'Age, in ms, after which a decomposed objective is flagged as stale by the reaper. Defaults to 1800000ms (30 minutes).',
    service: 'tasks',
    classification: 'user',
    type: 'number',
    default: '1800000',
    min: 60000,
    max: 86400000,
    group: 'governance',
    note: 'SETEC S3: settable + audited + effective-resolved at services/tasks/lib/objectiveReconciler.js runReaperScan(), resolved per scan (no restart). Only a stored instance setting overrides; with none stored the previous env/code default applies unchanged.',
  },
  {
    // SETEC S3 batch 1: promoted from classification 'instance' (env-only).
    key: 'REAPER_STUCK_RUNNING_MS',
    name: 'Objective Reaper: Stuck Running Grace',
    description: 'Grace period, in ms, before a running objective with no active poller is considered stuck and reconciled. Defaults to 120000ms (2 minutes).',
    service: 'tasks',
    classification: 'user',
    type: 'number',
    default: '120000',
    min: 10000,
    max: 3600000,
    group: 'governance',
    note: 'SETEC S3: settable + audited + effective-resolved at services/tasks/lib/objectiveReconciler.js runReaperScan(), resolved per scan (no restart). Only a stored instance setting overrides; with none stored the previous env/code default applies unchanged.',
  },
  {
    // SETEC S3 batch 1: promoted from classification 'instance' (env-only).
    key: 'SCHEDULER_POLL_MS',
    name: 'Schedulers: Poll Interval',
    description: 'How often, in ms, the agent and team schedulers check for due schedules. Defaults to 5000ms. A change applies after the next poll.',
    service: 'tasks',
    classification: 'user',
    type: 'number',
    default: '5000',
    min: 1000,
    max: 60000,
    group: 'governance',
    note: 'SETEC S3: settable + audited + effective-resolved at services/tasks/lib/agentScheduler.js and teamScheduler.js via configResolver.startAdaptiveInterval; the interval is re-read every tick (no restart). Only a stored instance setting overrides; with none stored the previous env/code default applies unchanged.',
  },
  {
    // SETEC S3 batch 1: promoted from classification 'instance' (env-only).
    key: 'SCREENCAP_RUN_DEADLINE_MS',
    name: 'Screencap: Run Deadline',
    description: 'Hard deadline, in ms, for one screencap capture run before it is aborted and the browser closed. Defaults to 900000ms (15 minutes). Applies from the next run.',
    service: 'screencap',
    classification: 'user',
    type: 'number',
    default: '900000',
    min: 60000,
    max: 7200000,
    group: 'screencap',
    note: 'SETEC S3: settable + audited + effective-resolved at services/screencap/lib/capturer.js _refreshRunDeadline(), resolved at the start of each run (no restart). Only a stored instance setting overrides; with none stored the previous env/code default applies unchanged.',
  },
  {
    // SETEC S3 batch 1: promoted from classification 'instance' (env-only).
    key: 'SERVICE_HEALTH_CHECK_INTERVAL_MS',
    name: 'Service Health: Check Interval',
    description: 'How often, in ms, registered services are health-probed. Defaults to 60000ms (1 minute). A change applies after the next check.',
    service: 'auth',
    classification: 'user',
    type: 'number',
    default: '60000',
    min: 10000,
    max: 3600000,
    group: 'governance',
    note: 'SETEC S3: settable + audited + effective-resolved at services/auth/services/serviceHealthScheduler.js via configResolver.startAdaptiveInterval; the interval is re-read every tick (no restart). Only a stored instance setting overrides; with none stored the previous env/code default applies unchanged.',
  },
  {
    // SETEC S3 batch 1: promoted from classification 'instance' (env-only).
    key: 'WARD_S3_RETENTION_DAYS',
    name: 'WARD: S3 Evidence Retention',
    description: 'Retention period, in days, applied to WARD evidence objects written to the S3 Object Lock sink. Defaults to 365. Applies to objects written after the change. Instance-wide (the sink has no org context).',
    service: 'ward',
    classification: 'user',
    type: 'number',
    default: '365',
    min: 1,
    max: 3650,
    group: 'storage',
    note: 'SETEC S3: settable + audited + effective-resolved at services/ward/lib/sinks.js getActiveSinks(), resolved on each publish with a 30s cache (no restart). Only a stored instance setting overrides; with none stored the previous env/code default applies unchanged.',
  },
];

/**
 * Compute the live value/on state for one capability entry from process.env.
 * Pure w.r.t. its `env` argument so it is easy to unit test without mutating
 * process.env in every test case.
 */
function evaluateCapability(entry, env = process.env) {
  const raw = env[entry.key];

  if (entry.type === 'boolean') {
    const on = entry.offOnlyWhen
      ? raw !== entry.offOnlyWhen
      : raw === 'true';
    return { value: on ? 'true' : 'false', on };
  }

  if (entry.type === 'presence') {
    const on = !!raw && raw.trim().length > 0;
    return { value: on ? entry.onValue : entry.offValue, on };
  }

  if (entry.type === 'enum') {
    const value = (raw && raw.trim()) ? raw.trim().toLowerCase() : entry.default;
    return { value, on: value !== entry.default };
  }

  if (entry.type === 'string') {
    const value = (raw && raw.trim()) ? raw.trim() : entry.default;
    return { value, on: value !== entry.default };
  }

  if (entry.type === 'number') {
    const parsed = raw !== undefined && raw !== null && raw.trim() !== '' ? Number(raw) : NaN;
    const value = Number.isFinite(parsed) ? String(parsed) : entry.default;
    return { value, on: value !== entry.default };
  }

  // Unknown type — fail closed rather than guess at a value.
  return { value: 'unknown', on: false };
}

/**
 * THE single place type validation lives for a settable CAPABILITIES entry
 * (VAULT-INTEG P14 slice 1). resolveEffectiveCapability() below and
 * platformSettingsStore.setOrgSetting() both call this rather than
 * re-implementing per-type checks — a registry entry declares its type and
 * constraints (allowedValues for 'enum', min/max for 'number', maxLength
 * for 'string') once, here, and every write and every read-resolution path
 * enforces the same rule.
 *
 * @param {object} entry - one CAPABILITIES row
 * @param {*} rawValue - the candidate value, always expected to be a string
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateSettingValue(entry, rawValue) {
  if (typeof rawValue !== 'string') {
    return { valid: false, reason: `value for ${entry.key} must be a string` };
  }

  switch (entry.type) {
    case 'boolean':
      if (rawValue !== 'true' && rawValue !== 'false') {
        return { valid: false, reason: `invalid value for ${entry.key}: must be 'true' or 'false'` };
      }
      return { valid: true };

    case 'string': {
      const maxLength = typeof entry.maxLength === 'number' ? entry.maxLength : 500;
      if (rawValue.trim().length === 0) {
        return { valid: false, reason: `invalid value for ${entry.key}: must not be empty` };
      }
      if (rawValue.length > maxLength) {
        return { valid: false, reason: `invalid value for ${entry.key}: exceeds max length ${maxLength}` };
      }
      return { valid: true };
    }

    case 'number': {
      const num = Number(rawValue);
      if (!Number.isFinite(num)) {
        return { valid: false, reason: `invalid value for ${entry.key}: must be a number` };
      }
      if (typeof entry.min === 'number' && num < entry.min) {
        return { valid: false, reason: `invalid value for ${entry.key}: must be >= ${entry.min}` };
      }
      if (typeof entry.max === 'number' && num > entry.max) {
        return { valid: false, reason: `invalid value for ${entry.key}: must be <= ${entry.max}` };
      }
      return { valid: true };
    }

    case 'enum': {
      if (!Array.isArray(entry.allowedValues) || entry.allowedValues.length === 0) {
        // No declared closed set on this entry — it is not settable via
        // override (matches pre-P14 behaviour for every other enum entry).
        return { valid: false, reason: `${entry.key} has no declared allowed values` };
      }
      if (!entry.allowedValues.includes(rawValue)) {
        return { valid: false, reason: `invalid value for ${entry.key}: must be one of ${entry.allowedValues.join(', ')}` };
      }
      return { valid: true };
    }

    default:
      // 'presence' and any unknown type are never settable via override.
      return { valid: false, reason: `${entry.key} is not a settable type (${entry.type})` };
  }
}

/**
 * THE shared precedence resolver (Phase 25). Every read call site that used
 * to check process.env directly, and the settings API that serves the
 * Settings UI, funnel through this one function to decide whether an org
 * setting or the env default wins.
 *
 * Precedence: a present and type-valid settingValue always wins ('setting').
 * An absent settingValue (undefined/null/empty string — "no override
 * stored") falls back to the env-derived value ('env'). An invalid
 * settingValue (wrong shape for entry.type — a corrupt or hand-edited row)
 * ALSO falls back to the env-derived value, safely, and is flagged via
 * `invalidSetting: true` so a caller can log/alert without ever throwing or
 * gating on garbage. `type: 'boolean' | 'string' | 'number' | 'enum'`
 * entries are settable (VAULT-INTEG P14 slice 1 extended past boolean-only)
 * when `classification: 'user'`; validateSettingValue() above is the one
 * place the per-type shape/constraint check lives. `presence` entries
 * always resolve from env and report `source: 'env'` — the raw value is
 * deliberately never round-tripped.
 *
 * @param {object} entry - one CAPABILITIES row
 * @param {{ env?: object, settingValue?: string|null|undefined }} [opts]
 * @returns {{ value: string, on: boolean, source: 'setting'|'env', invalidSetting?: boolean }}
 */
function resolveEffectiveCapability(entry, opts = {}) {
  const { env = process.env, settingValue } = opts;
  const envResult = evaluateCapability(entry, env);

  const hasSetting = settingValue !== undefined && settingValue !== null && settingValue !== '';
  if (!hasSetting) {
    return { ...envResult, source: 'env' };
  }

  const { valid } = validateSettingValue(entry, settingValue);
  if (!valid) {
    // Wrong shape for entry.type (or a type that is never settable, e.g.
    // 'presence') — fail safe to env rather than trust an unvalidated value.
    return { ...envResult, source: 'env', invalidSetting: true };
  }

  if (entry.type === 'boolean') {
    const on = settingValue === 'true';
    return { value: on ? 'true' : 'false', on, source: 'setting' };
  }

  if (entry.type === 'number') {
    const num = Number(settingValue);
    const value = String(num);
    return { value, on: value !== entry.default, source: 'setting' };
  }

  // 'string' / 'enum'
  return { value: settingValue, on: settingValue !== entry.default, source: 'setting' };
}

/**
 * Build the serialisable capability list for the API response.
 * Excludes anything credential-shaped as a safety net and, optionally,
 * filters to a single classification.
 *
 * @param {{ classification?: 'user'|'operator', env?: object, settings?: object }} [opts]
 *   settings: optional map of key -> raw stored setting value (org-scoped),
 *   used to compute `source`/`requiresRestart` for settable flags. Omitted
 *   entirely, every entry resolves purely from env (source 'env'), same as
 *   before Phase 25 — existing callers with no settings map keep working.
 */
// VAULT-INTEG P14 slice 1: the settable-type set, past boolean-only.
const SETTABLE_TYPES = ['boolean', 'string', 'number', 'enum'];

function isSettableEntry(entry) {
  if (entry.classification !== 'user' || !SETTABLE_TYPES.includes(entry.type)) return false;
  // An 'enum' entry with no declared closed set is not really settable —
  // there is nothing to validate a PATCH against.
  if (entry.type === 'enum' && !Array.isArray(entry.allowedValues)) return false;
  return true;
}

function getCapabilities(opts = {}) {
  const { classification, env = process.env, settings = null } = opts;
  return CAPABILITIES
    .filter((entry) => !isSecretLike(entry.key))
    .filter((entry) => !classification || entry.classification === classification)
    .map((entry) => {
      const settingValue = settings ? settings[entry.key] : undefined;
      const { value, on, source, invalidSetting } = resolveEffectiveCapability(entry, { env, settingValue });
      const settable = isSettableEntry(entry);
      return {
        key: entry.key,
        name: entry.name,
        description: entry.description,
        value,
        default: entry.default,
        on,
        service: entry.service,
        classification: entry.classification,
        group: entry.group || null,
        type: entry.type,
        settable,
        source: settings ? source : 'env',
        ...(invalidSetting ? { invalidSetting: true } : {}),
        ...(entry.requiresRestart ? { requiresRestart: true, restartNote: entry.restartNote || null } : {}),
        // Typed-value metadata the Settings UI needs to render the right
        // control and client-side hint — only meaningful when settable.
        ...(settable && Array.isArray(entry.allowedValues) ? { allowedValues: entry.allowedValues } : {}),
        ...(settable && typeof entry.min === 'number' ? { min: entry.min } : {}),
        ...(settable && typeof entry.max === 'number' ? { max: entry.max } : {}),
        ...(settable && typeof entry.maxLength === 'number' ? { maxLength: entry.maxLength } : {}),
        ...(entry.note ? { note: entry.note } : {}),
      };
    });
}

module.exports = {
  CAPABILITIES,
  SECRET_NAME_PATTERN,
  SETTABLE_TYPES,
  isSecretLike,
  isSettableEntry,
  evaluateCapability,
  validateSettingValue,
  resolveEffectiveCapability,
  getCapabilities,
};
