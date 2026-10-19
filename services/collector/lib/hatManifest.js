'use strict';

/**
 * QUOXHAT P2 — turn manifest resolution (collector side).
 *
 * One hat resolve + one manifest build per turn, BEFORE provider dispatch
 * (QUOXHAT_STUDY.md §9, §10). The manifest is the hat's membership
 * INTERSECTED with the agent's resolved grant — a hat can never add tools
 * the agent does not hold — bounded by the hat's budgets and digested so
 * WARD can eventually witness exactly what a turn could execute.
 *
 * Failure posture (P2, documented in STATUS_AND_LIMITS): resolve failures
 * fail OPEN to null (legacy full-grant behaviour) with a loud log line.
 * Availability must not expand authority — but neither may an auth-service
 * hiccup take down every chat turn while enforcement is still rolling out.
 * P6 revisits this posture before truncation is retired.
 */

const { createHash } = require('crypto');

const RESOLVE_TTL_MS = 15_000; // mutable-settings cache ceiling is 30s (study §3)
const ENFORCE_RESOLVE_TTL_MS = 3_000; // L1: enforced orgs cache resolves briefly so a tightening/revocation lands fast
const ENFORCE_CACHE_TTL_MS = 60_000; // in-memory fast-path freshness for an enforcement verdict (NOT a fail-open deadline — see the durable store below)
const _resolveCache = new Map(); // key -> { value, expiry }
const _enforcementCache = new Map(); // orgId -> { value: 'enforce'|'preview', expiry } (independent of resolve success)

// QUOXHAT #657 P-C.3 — DURABLE enforcement memory. The in-memory cache above is
// lost on every collector restart (which happens on every deploy), and its 60s
// TTL used to let a known-enforcing org silently fail OPEN once it expired. Both
// are fail-open holes: after a restart, or 60s of quiet, a hat-resolve FAILURE
// fell back to the full legacy grant for an org that actually enforces. Codex
// (2026-10-02): cold-start AND unknown-state must fail CLOSED; recovery happens
// when authoritative state returns (the next successful resolve), not by a
// timer. So we persist each org's last OBSERVED enforcement verdict to disk and
// consult it when the in-memory fast path misses — no self-expiry. Staleness is
// conservative by construction: a stale 'enforce' only bites during a resolve
// FAILURE (auth down) and is corrected by the first successful resolve; it can
// never expand authority. Best-effort: if the path is unwritable (e.g. tests),
// the store degrades to in-memory only.
const Database = require('better-sqlite3');
const ENFORCEMENT_DB_PATH = process.env.QUOXHAT_ENFORCEMENT_DB_PATH || '/var/lib/quox/quoxhat-enforcement.db';
let _enforcementDb; // undefined = not tried; null = tried + failed (degrade to in-memory)
function _getEnforcementDb() {
  if (_enforcementDb !== undefined) return _enforcementDb;
  try {
    const db = new Database(ENFORCEMENT_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS org_enforcement (org_id TEXT PRIMARY KEY, enforcement TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    _enforcementDb = db;
  } catch (err) {
    console.warn(`[QUOXHAT] durable enforcement store unavailable (${err?.message}) — failing back to in-memory enforcement memory (cold-start fail-closed will not survive a restart)`);
    _enforcementDb = null;
  }
  return _enforcementDb;
}
function _persistEnforcement(orgId, enforcement) {
  const db = _getEnforcementDb();
  if (!db) return;
  try {
    db.prepare('INSERT INTO org_enforcement (org_id, enforcement, updated_at) VALUES (?, ?, ?) ON CONFLICT(org_id) DO UPDATE SET enforcement = excluded.enforcement, updated_at = excluded.updated_at')
      .run(orgId, enforcement, Date.now());
  } catch (err) {
    console.warn(`[QUOXHAT] failed to persist enforcement verdict for org=${orgId}: ${err?.message}`);
  }
}
function _readPersistedEnforcement(orgId) {
  const db = _getEnforcementDb();
  if (!db) return null;
  try {
    const row = db.prepare('SELECT enforcement FROM org_enforcement WHERE org_id = ?').get(orgId);
    return row?.enforcement || null;
  } catch { return null; }
}

// Hat-governance tools: an agent that holds these always keeps them, whatever
// the active hat says, so a hat can never trap it with no inspect/load/propose
// escape path (the quox#657 bootstrap trap). They never escalate authority:
// hat_load_bundle only loads bundles defined on the active hat, hat_propose_switch
// only files an HITL item, hat_catalogue is read-only.
const GOVERNANCE_TOOLS = ['hat_catalogue', 'hat_load_bundle', 'hat_propose_switch'];

// QUOXHAT MISSION D1 — the Tier-0 self-read floor. A universal floor beneath
// EVERY hat: self-scoped, read-only, zero-effect reads of the caller's OWN
// context that a hat may never strip (reading your own HITL inbox is not a
// privileged escalation — the owner sandwich-test defect, 2026-10-02). Woven in
// at the same points as GOVERNANCE_TOOLS: grant add (agentTools.getToolsForAgent),
// authz immunity + presentation pick + budget exemption below. The ceiling still
// applies — authz never fabricates a Tier-0 tool the agent does not hold.
// Deliberately NOT added to buildFailClosedManifest: a resolve FAILURE denies
// everything, Tier-0 included — fail-closed stays absolute (context is unknown).
// QUOXON-ENGINE class 5: quox_command_lookup joins the floor. A static read of the generated
// TUI / CLI command registries (no org data, no effect), so any agent that cannot do a thing
// itself can still name the real command instead of answering "I can't".
const TIER0_READ_TOOLS = ['inbox_pending', 'memory_search', 'quoxbrain_search', 'time_now', 'quox_command_lookup', 'terminal_suggest_command']; // terminal_suggest_command (DECISION-LABELS): only proposes a slash command to the TUI, which vets it and asks y/N

function _cacheKey(orgId, userId, conversationId, agent) {
  return `${orgId}::${userId || ''}::${conversationId || ''}::${agent || ''}`;
}

/**
 * QUOXHAT P-B — the AUTHORIZATION set (J2), computed from the agent's GRANT
 * (the ceiling) narrowed by the hat's explicit mode rule. This is DISTINCT from
 * the presentation set (J1, `toolNames`): presentation shapes what the model
 * sees this turn (the 128-cap / focus) and carries NO authority; authorization
 * is what the executeTool gate actually enforces.
 *
 * The grant is a CEILING, never a floor: a hat can only ever narrow it, never
 * add a tool the agent does not hold. Reconciled Codex critique (2026-10-02):
 * "an agent may ALWAYS execute its grant" was rejected because it would make
 * every hat toothless. Instead:
 *
 *   authz(mode) =
 *     permissive  → the entire grant is eligible (a deliberately open mode;
 *                   the DECLARED, logged migration posture for any hat that has
 *                   not yet authored an `authz` block — NOT a silent default,
 *                   it is stated here and logged at the gate on first use).
 *     restrictive → (allow ∩ grant, or grant if no allow list) minus deny.
 *
 * Governance tools (hat_catalogue/load_bundle/propose_switch) are ALWAYS
 * eligible when granted — a restrictive hat cannot strip an agent's escape
 * path (the #657 bootstrap trap), matching the M1 presentation carve-out.
 *
 * NOT YET in P-B (explicitly deferred, do not over-claim): action-level
 * authorization (operation/argument/resource/credential) for mixed-purpose
 * tools like ssh_exec and quoxagent — P-B authorizes at the tool-NAME level.
 * Effect classification (read_only as a computed property), the HITL
 * approval-ADD path, delegation child-scope and the unforgeable per-effect
 * scope are P-C/P-D/P-E. A `read_only` mode is therefore expressed as an
 * authored allow-list of read tools in P-E, not a magic classifier here.
 */
function computeAuthzSet(grantNames, def) {
  const grantSet = new Set(grantNames);
  const authz = def?.authz && typeof def.authz === 'object' ? def.authz : null;
  const mode = authz?.mode === 'restrictive' ? 'restrictive' : 'permissive';

  let eligible;
  if (mode === 'permissive') {
    // Entire grant is eligible. The ceiling and the eligible set coincide.
    eligible = new Set(grantSet);
  } else {
    const allow = Array.isArray(authz?.allow) ? authz.allow : null;
    // allow ∩ grant (names outside the grant can never be authorized), or the
    // full grant when no allow list is given.
    eligible = new Set(allow ? allow.filter(n => grantSet.has(n)) : grantSet);
  }

  // deny list always wins — except it can never remove a governance tool (the
  // agent must keep its inspect/load/propose escape path).
  const deny = new Set(Array.isArray(authz?.deny) ? authz.deny : []);
  for (const n of [...eligible]) {
    if (deny.has(n) && !GOVERNANCE_TOOLS.includes(n) && !TIER0_READ_TOOLS.includes(n)) eligible.delete(n);
  }

  // QUOXHAT MISSION FND-2 (RPP brutaloop, 2026-10-02): the governance escape
  // path and the Tier-0 self-read floor are a UNION-floor, not a grant-gated
  // ceiling. Previously these were added only `if (grantSet.has(t))`, so a
  // restrictive hat whose resolved grant happened to omit a floor tool (e.g. a
  // DB-resolved agent on the governed route, pre the _resolveToolsForAgent fix)
  // could strip it — violating the "universal, un-strippable" invariant. They
  // are self-scoped, zero-effect tools that every agent holds by construction
  // (getToolsForAgent + _resolveToolsForAgent union them into every grant) and
  // that native RBAC honours unconditionally (isUniversalFloor). Adding them to
  // the authz set unconditionally makes all three layers agree and closes the
  // route-inconsistency. The CEILING still applies to every NON-floor tool: a
  // hat can never authorize an arbitrary tool the agent was not granted (see the
  // ssh_exec assertion in quoxhat-657-pb-authz-split).
  for (const g of GOVERNANCE_TOOLS) eligible.add(g);
  for (const t of TIER0_READ_TOOLS) eligible.add(t);

  return { eligible, mode, authored: !!authz };
}

// QUOXON-ASK J2: last-known-good resolved hats, per org+agent+user, for a transient resolve
// failure. Bounded in time (a revocation reaches every turn within LKG_TTL_MS even while auth
// is slow) and never broader than the durable enforcement row: a cached 'preview' (fail-open)
// result is not used for an org the durable store says enforces.
const LKG_TTL_MS = 10 * 60 * 1000;
const _lkgCache = new Map();
const _lkgKey = (orgId, agent, userId) => `${orgId}|${agent || ''}|${userId || ''}`;
function lastKnownGood(orgId, k) {
  const e = _lkgCache.get(k);
  if (!e) return null;
  if (e.expiry <= Date.now()) { _lkgCache.delete(k); return null; }
  if (lastKnownEnforcement(orgId) === 'enforce' && e.value.enforcement !== 'enforce') return null;
  return { ...e.value, stale: true };
}

/**
 * Resolve the effective hat for a turn from the auth service's internal
 * endpoint. Returns { source, hat, enforcement } or null on any failure
 * (fail-open; failures are never cached).
 */
async function resolveHatForTurn({ orgId, userId = null, conversationId = null, agent = null, deps = {} }) {
  if (!orgId) return null;
  const {
    fetchImpl = fetch,
    authBase = process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101',
    serviceKey = process.env.INTERNAL_SERVICE_KEY || '',
    timeoutMs = 5000,
    retryTimeoutMs = 12000,
  } = deps;

  const key = _cacheKey(orgId, userId, conversationId, agent);
  const cached = _resolveCache.get(key);
  if (cached && cached.expiry > Date.now()) return cached.value;

  const qs = new URLSearchParams();
  if (userId) qs.set('user_id', userId);
  if (conversationId) qs.set('conversation_id', conversationId);
  // P5 automatic/hybrid selection: the turn's agent is the match key. Only
  // consulted by auth when the org's selection_mode asks for it; manual
  // orgs ignore it entirely, so passing it is always safe.
  if (agent) qs.set('agent', agent);
  const url = `${authBase}/api/internal/orgs/${encodeURIComponent(orgId)}/quoxhat/resolve${qs.size ? `?${qs}` : ''}`;
  const lkgKey = _lkgKey(orgId, agent, userId);

  // QUOXON-ASK J2 (quox#852): a slow auth service (box load) is not an answer. A timeout,
  // transport error or 5xx is retried ONCE with a longer timeout; if that also fails, the
  // last-known-good hat for this org+agent+user stands in (lastKnownGood). A definite
  // answer (4xx, no hat) is never retried or papered over.
  const attempt = async (ms) => {
    try {
      const resp = await fetchImpl(url, { headers: { 'X-Service-Key': serviceKey }, signal: AbortSignal.timeout(ms) });
      return { resp, transient: !resp.ok && resp.status >= 500 };
    } catch (err) {
      return { err, transient: true };
    }
  };
  let a = await attempt(timeoutMs);
  if (a.transient) {
    console.warn(`[QUOXHAT] hat resolve for org=${orgId} agent=${agent || '-'} failed transiently (${a.err ? a.err.message : `HTTP ${a.resp.status}`}); retrying once with ${retryTimeoutMs}ms`);
    a = await attempt(retryTimeoutMs);
  }
  if (a.transient) {
    const lkg = lastKnownGood(orgId, lkgKey);
    if (lkg) {
      console.warn(`[QUOXHAT] hat resolve for org=${orgId} agent=${agent || '-'} still failing (${a.err ? a.err.message : `HTTP ${a.resp.status}`}); using the last-known-good hat '${lkg.hat?.key || '?'}' (${lkg.enforcement})`);
      return lkg;
    }
    console.warn(`[QUOXHAT] hat resolve error for org=${orgId}: ${a.err ? a.err.message : `HTTP ${a.resp.status}`} — no last-known-good hat; turn continues on legacy full grant (fails closed if the org enforces)`);
    return null;
  }

  try {
    const resp = a.resp;
    if (!resp.ok) {
      console.warn(`[QUOXHAT] hat resolve failed for org=${orgId}: HTTP ${resp.status} — turn continues on legacy full grant`);
      return null;
    }
    const body = await resp.json();
    if (!body?.hat) {
      console.warn(`[QUOXHAT] hat resolve returned no hat for org=${orgId} — turn continues on legacy full grant`);
      return null;
    }
    const value = {
      source: body.source,
      hat: body.hat,
      enforcement: body.enforcement || 'preview',
      // P4: conversation bindings carry progressive-disclosure state.
      binding: body.binding || null,
    };
    // H2: remember the org's enforcement INDEPENDENTLY of the resolve, so a
    // later resolve FAILURE can fail closed for an org we know enforces.
    _enforcementCache.set(orgId, { value: value.enforcement, expiry: Date.now() + ENFORCE_CACHE_TTL_MS });
    _persistEnforcement(orgId, value.enforcement); // P-C.3: durable, survives restart
    // L1: enforced orgs get a short success-cache TTL so a tightening or
    // revocation takes effect in seconds, not up to 15s.
    const ttl = value.enforcement === 'enforce' ? ENFORCE_RESOLVE_TTL_MS : RESOLVE_TTL_MS;
    _resolveCache.set(key, { value, expiry: Date.now() + ttl });
    _lkgCache.set(lkgKey, { value, expiry: Date.now() + LKG_TTL_MS });
    return value;
  } catch (err) {
    console.warn(`[QUOXHAT] hat resolve error for org=${orgId}: ${err?.message} — turn continues on legacy full grant`);
    return null;
  }
}

/**
 * Build the frozen turn manifest: hat membership ∩ resolved grant, bounded
 * by budgets.max_manifest, explicit tools first (they are the hat author's
 * priority order), then LOADED bundle tools, then allowed connector-family
 * tools.
 *
 * P4 progressive disclosure: bundle tools join the manifest only for
 * bundles the conversation has loaded (hat_load_bundle → quoxhat_bindings
 * loaded_bundles). The initial manifest is the explicit set + connectors;
 * depth is a governed, audited step away, never pre-loaded wholesale.
 *
 * @returns {{
 *   tools: Array, toolNames: Set<string>, digest: string,
 *   hatId: string, hatKey: string, revision: number,
 *   truncatedByBudget: boolean, loadedBundles: string[]
 * } | null} null when no usable hat definition (legacy path continues)
 */
function buildTurnManifest({ agentTools, hat, loadedBundles = [], agent = null }) {
  const def = hat?.definition;
  if (!def || typeof def !== 'object') return null;
  const grant = Array.isArray(agentTools) ? agentTools : [];
  const byName = new Map(grant.map(t => [t.name, t]));

  const loadedSet = new Set(Array.isArray(loadedBundles) ? loadedBundles : []);
  const explicit = Array.isArray(def.tools?.explicit) ? def.tools.explicit : [];
  const bundleTools = Array.isArray(def.tools?.bundles)
    ? def.tools.bundles
        .filter(b => b && loadedSet.has(b.key))
        .flatMap(b => Array.isArray(b?.tools) ? b.tools : [])
    : [];
  const families = new Set(Array.isArray(def.tools?.connector_families) ? def.tools.connector_families : []);

  const picked = [];
  const pickedNames = new Set();
  const pick = (name) => {
    const t = byName.get(name);
    if (t && !pickedNames.has(name)) {
      picked.push(t);
      pickedNames.add(name);
    }
  };
  // M1 (quox#657): governance tools first and unconditionally (when held in
  // grant) — never gated by hat membership, never dropped by budget — so no
  // hat or budget cap can trap the agent with no inspect/load/propose path.
  GOVERNANCE_TOOLS.forEach(pick);
  // QUOXHAT MISSION D1 — Tier-0 self-reads join the PRESENTATION manifest too
  // (when held in grant), so the model can SEE it may read its own inbox and
  // does not mis-route to a hat switch (the sandwich-test self-model symptom).
  TIER0_READ_TOOLS.forEach(pick);
  explicit.forEach(pick);
  bundleTools.forEach(pick);
  for (const t of grant) {
    if (pickedNames.has(t.name)) continue;
    const fam = typeof t.provider === 'string' && t.provider.startsWith('connector:')
      ? t.provider.slice('connector:'.length)
      : null;
    if (fam && families.has(fam)) pick(t.name);
  }

  // QUOXHAT MISSION D1 (strip-not-bound, NOTESQ 2026-10-06): the hat's explicit
  // list is curated for its ORCHESTRATOR. On a SPECIALIST turn (inboxq, notesq,
  // ...) applying it stripped the specialist below its own grant (Default hat:
  // 7 tools, none of inbox_* / notesq_*). A hat bounds, it never strips: present
  // every grant tool the hat AUTHORIZES (permissive = whole grant; restrictive
  // allow/deny still narrows). Orchestrator turns and agent-less callers keep
  // the legacy presentation.
  const orchestrator = String(def.agents?.orchestrator || 'quox').toLowerCase();
  const isSpecialistTurn = typeof agent === 'string' && agent.trim() !== ''
    && agent.trim().toLowerCase() !== orchestrator;
  if (isSpecialistTurn) {
    const { eligible } = computeAuthzSet(grant.map(t => t.name), def);
    for (const t of grant) if (eligible.has(t.name)) pick(t.name);
  }

  // quox#908 follow-up: tools reachable ONLY through on_demand_reads (not explicit, not a loaded
  // bundle). The executeTool gate refuses their write actions. A specialist turn holds its grant
  // as members, so nothing is on-demand-only there.
  const onDemandOnly = new Set();
  if (!isSpecialistTurn && Array.isArray(def.tools?.on_demand_reads)) {
    const members = new Set([...explicit, ...bundleTools]);
    for (const n of def.tools.on_demand_reads) if (!members.has(n)) onDemandOnly.add(n);
  }

  const maxManifest = Number.isInteger(def.budgets?.max_manifest) ? def.budgets.max_manifest : 128;
  // Budget truncation caps the non-governance tail only; governance tools are
  // always retained (they were picked first, so this also preserves order).
  // NB: truncation shapes PRESENTATION only — it never narrows authorization
  // (authzToolNames below), so the 128-cap can drop a tool from the model's
  // view without forbidding the agent from invoking it if it asks.
  const govNames = new Set([...GOVERNANCE_TOOLS, ...TIER0_READ_TOOLS]); // D1: Tier-0 reads retained like governance tools — never budget-dropped
  const gov = picked.filter(t => govNames.has(t.name));
  const rest = picked.filter(t => !govNames.has(t.name));
  // quox#1087: the budget is the ORCHESTRATOR's presentation cap. On a specialist turn D1 presents
  // the whole authorised grant, and cutting it here kept the first max_manifest tools in grant
  // order, so a large specialist (browser-q, 65) silently lost its own tail (browser_video_list)
  // and reached for hat_catalogue. The per-turn selection (turnToolSelection) still caps what the
  // model is offered, by relevance to the ask.
  const restCap = isSpecialistTurn ? rest.length : Math.max(0, maxManifest - gov.length);
  const truncatedByBudget = rest.length > restCap;
  const tools = truncatedByBudget ? [...gov, ...rest.slice(0, restCap)] : picked;

  // QUOXHAT P-B — the authorization set (J2), computed from the full grant (the
  // ceiling) and the hat's mode rule, INDEPENDENT of presentation/budget. This
  // is what the executeTool gate enforces; `toolNames` above is only what the
  // model is shown.
  const grantNames = grant.map(t => t.name);
  const { eligible: authzToolNames, mode: authzMode, authored: authzAuthored } = computeAuthzSet(grantNames, def);

  // QUOXHAT P-D — which AGENTS this hat authorises the orchestrator to delegate
  // to. A hat scopes the session/mode and names the agents in-scope (study §3:
  // "marketing mode → publishing agents in-scope"). delegationScoped is false
  // when the hat lists NO specialists (e.g. the Default hat, specialists:[]),
  // meaning delegation is unrestricted — so this gate is backward-compatible and
  // only bites hats that deliberately scope their agent roster.
  const specialists = Array.isArray(def.agents?.specialists) ? def.agents.specialists : [];
  const authorizedAgents = new Set(
    [def.agents?.orchestrator, ...specialists].filter(Boolean).map(a => String(a).toLowerCase())
  );
  const delegationScoped = specialists.length > 0;

  const digest = createHash('sha256')
    .update(JSON.stringify({
      hat: hat.digest || null,
      revision: hat.current_revision || 0,
      tools: tools.map(t => t.name),
      // Witness the authorization decision too, not just presentation.
      authz: [...authzToolNames].sort(),
      authzMode,
    }))
    .digest('hex');

  return {
    tools,
    toolNames: new Set(tools.map(t => t.name)),
    onDemandOnly,
    // P-B: authorization set + the raw grant ceiling, for the gate to decide
    // DENY (not-granted vs mode-forbidden) with a precise, auditable reason.
    authzToolNames,
    grantToolNames: new Set(grantNames),
    authzMode,
    authzAuthored,
    // P-D: delegation scope — which agents the orchestrator may delegate to.
    authorizedAgents,
    delegationScoped,
    // CUSTOM-HATS: the hat's own specialists (the roster a turn under this hat carries) and its
    // orchestrator; offerMembersOnly = tools.offer 'members' (orchestrator turns are offered only
    // hat members). Presentation only: authzToolNames above is unchanged by either.
    scopedAgents: specialists.map(a => String(a).toLowerCase()),
    orchestrator,
    offerMembersOnly: def.tools?.offer === 'members' && !isSpecialistTurn,
    digest,
    hatId: hat.id,
    hatKey: hat.key,
    revision: hat.current_revision,
    truncatedByBudget,
    loadedBundles: [...loadedSet],
  };
}

/**
 * QUOXHAT P2 (approval resumes): does a hat's own membership name a tool?
 * Used where no resolved grant is available to build a full manifest (the
 * HITL resume executor re-checks the CURRENT hat before running an approved
 * native tool — a stale approval must not outlive a hat switch/revocation,
 * study §9). Checks explicit + bundle tool names; connector-family grants
 * cannot be name-checked without tool definitions, but the resume path only
 * carries gated NATIVE tools, which are always named explicitly.
 */
function hatAllowsToolName(hat, toolName) {
  const def = hat?.definition;
  if (!def || typeof def !== 'object') return true; // no usable hat = no hat opinion
  const explicit = Array.isArray(def.tools?.explicit) ? def.tools.explicit : [];
  if (explicit.includes(toolName)) return true;
  if (Array.isArray(def.tools?.on_demand_reads) && def.tools.on_demand_reads.includes(toolName)) return true; // quox#908
  const bundles = Array.isArray(def.tools?.bundles) ? def.tools.bundles : [];
  return bundles.some(b => Array.isArray(b?.tools) && b.tools.includes(toolName));
}

/**
 * H2/P-C.3: the org's last-known enforcement ('enforce' | 'preview' | null).
 * In-memory fast path first; on a miss (expired OR cold start after a restart)
 * fall through to the DURABLE store rather than returning null — so an org once
 * observed enforcing keeps failing CLOSED across restarts and quiet periods, no
 * self-expiry. null only when the org has NEVER been observed on this deployment
 * (durable store has no row): a genuinely unknown org still fails open, which is
 * the one residual that needs a successful resolve to close.
 */
function lastKnownEnforcement(orgId) {
  const e = _enforcementCache.get(orgId);
  if (e && e.expiry > Date.now()) return e.value;
  const persisted = _readPersistedEnforcement(orgId);
  if (persisted) {
    // Re-warm the fast path so repeated gate checks this turn don't re-hit disk.
    _enforcementCache.set(orgId, { value: persisted, expiry: Date.now() + ENFORCE_CACHE_TTL_MS });
    return persisted;
  }
  return null;
}

/**
 * H2 fail-CLOSED: when a hat resolve fails (auth down, bad service key → org-wide
 * 401, timeout) for an org we last saw ENFORCING, deny tools instead of falling
 * back to the full legacy grant — availability must not expand authority. An
 * empty manifest makes the executeTool gate refuse every tool for the turn;
 * conversation continues, tools return on auth recovery. P-C.3: the enforcement
 * verdict is now durable (survives restart), so the residual is narrower — only
 * an org NEVER observed on this deployment (no durable row) fails open, and the
 * first successful resolve closes even that. A cold collector that has processed
 * an enforce org once before (any prior run wrote the row) now fails CLOSED.
 *
 * @returns {object|null} a fail-closed ctx.hatManifest, or null to keep legacy fail-open.
 */
function buildFailClosedManifest(orgId) {
  if (lastKnownEnforcement(orgId) !== 'enforce') return null;
  return {
    enforced: true,
    resolveFailed: true,
    toolNames: new Set(),
    // P-B: authorization also denies every tool under fail-closed.
    authzToolNames: new Set(),
    grantToolNames: new Set(),
    hatKey: '(resolve-failed:fail-closed)',
    hatId: null,
    revision: 0,
    digest: null,
  };
}

/** Test-only cache reset (also clears the durable enforcement store). */
function _clearHatResolveCache() {
  _resolveCache.clear();
  _lkgCache.clear();
  _enforcementCache.clear();
  const db = _getEnforcementDb();
  if (db) { try { db.exec('DELETE FROM org_enforcement'); } catch { /* best-effort */ } }
}

/**
 * Test-only: evict the IN-MEMORY caches but leave the durable store intact —
 * simulates a collector restart (or the old 60s expiry) so a test can prove the
 * durable enforcement memory still fails closed afterward (P-C.3).
 */
function _evictInMemoryEnforcement() { _resolveCache.clear(); _enforcementCache.clear(); }

// QUOXHAT FND-3 (RPP brutaloop 2026-10-02) — enforcement pre-warm poller.
//
// buildFailClosedManifest fails CLOSED only for an org we have a durable
// 'enforce' row for, and that row is written only when a resolve SUCCEEDS
// (resolveHatForTurn). So a freshly-created / just-toggled enforce org, before
// its first successful resolve, had NO row -> lastKnownEnforcement === null ->
// buildFailClosedManifest returned null -> the gate fell through to native RBAC
// = FAIL-OPEN on a resolve failure. This poller closes that window: it pulls the
// set of CONFIGURED enforce orgs from auth and persists each verdict BEFORE any
// tool call, so the durable row exists ahead of the first resolve.
//
// Pattern mirrors lib/enforcementPosture.js (a background poller filling a cache,
// failing closed on uncertainty) and honours the Loop Hygiene triad:
//   - failure accounting: a DEPENDENCY failure (auth down) is counted and logged
//     DISTINCTLY from an empty result ("0 enforce orgs" is not an error);
//   - idempotent: re-persisting the same orgs is a no-op upsert, nothing
//     accumulates, so there is nothing to "retire" and zero-progress is the
//     correct steady state (hence no backoff — this is a refresh, not a drain);
//   - fail-safe direction: a poll error NEVER clears existing durable rows, so an
//     auth outage can only keep the box as strict or stricter, never looser.
//
// Only enforce orgs are pre-warmed; preview/non-QuoxHat orgs keep NO row and so
// still fail OPEN on a resolve failure, which equals preview (no gating) and
// preserves availability for tenants not using QuoxHat. An org downgraded
// enforce->preview keeps a stale 'enforce' row until its next SUCCESSFUL resolve
// overwrites it to 'preview' — failing closed in the meantime is the safe
// direction (deny), not a hole.
let _prewarmTimer = null;
let _prewarmFailures = 0;

async function _runEnforcementPrewarmOnce({ fetchImpl = fetch, authBase, serviceKey, timeoutMs = 5000 } = {}) {
  const base = authBase || process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101';
  const key = serviceKey !== undefined ? serviceKey : (process.env.INTERNAL_SERVICE_KEY || '');
  const resp = await fetchImpl(`${base}/api/internal/quoxhat/enforce-orgs`, {
    headers: { 'X-Service-Key': key },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const body = await resp.json();
  const orgIds = Array.isArray(body?.orgIds) ? body.orgIds : [];
  for (const orgId of orgIds) {
    _persistEnforcement(orgId, 'enforce');
    _enforcementCache.set(orgId, { value: 'enforce', expiry: Date.now() + ENFORCE_CACHE_TTL_MS });
  }
  return orgIds.length;
}

function startEnforcementPrewarm(deps = {}) {
  if (_prewarmTimer) return _prewarmTimer; // idempotent: never double-start
  const { intervalMs = 60_000, ...rest } = deps;
  const tick = async () => {
    try {
      const n = await _runEnforcementPrewarmOnce(rest);
      if (_prewarmFailures > 0) console.log(`[QUOXHAT] enforcement pre-warm recovered after ${_prewarmFailures} failure(s): ${n} enforce org(s) persisted`);
      _prewarmFailures = 0;
    } catch (err) {
      _prewarmFailures++;
      console.warn(`[QUOXHAT] enforcement pre-warm FAILED (${_prewarmFailures} consecutive): ${err?.message} — existing durable rows kept; box stays as strict or stricter`);
    }
  };
  tick(); // run once immediately at boot
  _prewarmTimer = setInterval(tick, intervalMs);
  if (_prewarmTimer.unref) _prewarmTimer.unref();
  return _prewarmTimer;
}

/** Test-only: stop the poller and reset its failure counter. */
function _stopEnforcementPrewarm() { if (_prewarmTimer) { clearInterval(_prewarmTimer); _prewarmTimer = null; } _prewarmFailures = 0; }

module.exports = {
  resolveHatForTurn, buildTurnManifest, hatAllowsToolName,
  lastKnownEnforcement, buildFailClosedManifest,
  startEnforcementPrewarm, _runEnforcementPrewarmOnce, _stopEnforcementPrewarm,
  _clearHatResolveCache, _evictInMemoryEnforcement, RESOLVE_TTL_MS, LKG_TTL_MS, GOVERNANCE_TOOLS, TIER0_READ_TOOLS,
};
